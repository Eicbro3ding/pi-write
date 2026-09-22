/**
 * 会话视图状态 reducer —— 纯函数,便于单测。
 * 事件类型用本地 AgentEventDto(与 vendor 字段对齐的最小形状,不 import vendor)。
 *
 * 匹配策略:vendor 的 message 对象没有 id 字段(id 在 SessionEntry 层,不进 message),
 * 但事件保证按序发射(message_start → message_update* → message_end),因此
 * text_delta 拼接与 done 标记都按「最后一条未 done 的 assistant 消息」顺序匹配,
 * 不依赖 message.id。message_start 只追加 user/assistant 消息,role=toolResult
 * 等非气泡角色直接跳过,不渲染为气泡。
 */
import type { AgentEventDto, ChatMessage, MessageBlock, SessionMessageDto, SessionViewState, ToolCallInfo } from "./types.ts";
import { extractCacheHit } from "./context-usage.ts";
import { describeChatError, providerModelLine } from "./chat-error.ts";

/** 初始会话视图状态。 */
export function initialSessionState(): SessionViewState {
	return { messages: [], isStreaming: false, compacting: false, cacheHit: null };
}

/** 本地随机消息 id(实时消息在 message_end 到达时换成服务端 entryId)。 */
function localId(): string {
	return Math.random().toString(36).slice(2);
}

/** 工具参数 → 展示字符串(对象序列化;与改造前同口径)。 */
function argsToString(args: unknown): string {
	return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/**
 * 从工具的流式局部结果里取文本。
 *
 * 形状来自 vendor 的 `onUpdate(partial)`(bash 的 stdout/stderr 快照):
 * `{ content: [{ type: "text", text }], details }`。bash 在命令开跑时先发一次
 * `{ content: [] }`(纯信号、无文本)——这种取不出文本的情况返回 null,
 * 让调用方保持原值,而不是把已经显示出来的输出清空。
 */
function partialTextOf(partial: unknown): string | null {
	if (typeof partial === "string") return partial;
	if (!partial || typeof partial !== "object") return null;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const parts = content
		.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? (c as { text?: unknown }).text : null))
		.filter((t): t is string => typeof t === "string");
	return parts.length > 0 ? parts.join("") : null;
}

/**
 * 把服务端会话历史(getSession().messages)转为 message_start/message_end 事件序列,
 * 与 SSE 事件走同一条 reducer 路径(整体替换聊天时先 RESET 再逐条 dispatch)。
 * 历史消息带服务端 entry id(entryId),ChatMessage.id 直接用它(稳定,撤回定位依据)。
 * 每条历史消息成对补 message_end:置 done——思考块渲染「思考」且不显示计时
 * (重载思维链无计时起点;2026-08-11)。
 *
 * 2026-09-19:历史消息带 `content`(有序块:思考 / 正文 / 工具调用,工具块内联结果)
 * 时**原样透传**给 reducer —— 于是刷新页面后思考与工具的先后、工具卡本身都还在,
 * 不再只留下「一坨思考 + 一坨正文」。缺 content 的旧形状退回 text/thinking 投影。
 * startedAt/endedAt 一并携带,回合耗时刷新后不丢。
 */
export function messagesToEvents(messages: readonly SessionMessageDto[]): Array<Extract<AgentEventDto, { type: "message_start" } | { type: "message_end" }>> {
	const events: Array<Extract<AgentEventDto, { type: "message_start" } | { type: "message_end" }>> = [];
	for (const m of messages) {
		// 历史水合的 thinking 一并还原:reducer 的 message_start 经 blocksFromContent
		// 提取 thinking 块,思考链随消息恢复(刷新/重开页面后不丢)
		let content: unknown[] = m.content ? (m.content as unknown[]) : [];
		if (content.length === 0) {
			const fallback: Array<{ type: string; text: string }> = [];
			if (m.role === "assistant" && m.thinking && m.thinking.length > 0) {
				fallback.push({ type: "thinking", text: m.thinking });
			}
			if (m.text.length > 0) fallback.push({ type: "text", text: m.text });
			content = fallback;
		}
		events.push({
			type: "message_start",
			message: {
				role: m.role,
				content,
				// provider 侧报错随消息落盘(errorMessage + provider/model):水合时原样
				// 递给 reducer,报错卡刷新/重开页面后仍在(与实时路径同一套字段)
				...(m.errorMessage !== undefined ? { stopReason: "error", errorMessage: m.errorMessage } : {}),
				...(m.provider !== undefined ? { provider: m.provider } : {}),
				...(m.model !== undefined ? { model: m.model } : {}),
			},
			...(m.id ? { entryId: m.id } : {}),
			...(m.startedAt !== undefined ? { startedAt: m.startedAt } : {}),
			...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {}),
		});
		// 水合消息成对补 message_end:置 done——思考块渲染为「思考」且不显示
		// 计时(重载思维链无计时起点;此前 done 恒 false,显示「思考中 x 秒」)
		events.push({ type: "message_end", message: {} });
	}
	return events;
}

/** 本地重置事件(切章清空聊天);vendor 事件流不会出现该类型,reducer 透传原状态。 */
export const RESET = { type: "session_reset" } as const;

/** 主会话与编剧/导演会话共用的 reducer 包装:RESET 本地事件 → 重置,其余走 processAgentEvent。
 *  2026-08-11 由 WritePage 内部提取为共享导出(舞台导演对话统一走同一套对话逻辑)。 */
export function sessionReducer(s: SessionViewState, e: AgentEventDto | typeof RESET): SessionViewState {
	return e.type === RESET.type ? initialSessionState() : processAgentEvent(s, e);
}

/**
 * 把 message.content(字符串或 block 数组)拆为正文与思考文本。
 * 仅用于兼容消费点(回显配对);渲染路径走 blocksFromContent。 */
function splitContent(content: unknown): { text: string; thinking: string } {
	if (typeof content === "string") return { text: content, thinking: "" };
	if (!Array.isArray(content)) return { text: "", thinking: "" };
	let text = "";
	let thinking = "";
	for (const part of content as Array<{ type?: string; text?: string }>) {
		if (part.type === "text") text += part.text ?? "";
		else if (part.type === "thinking") thinking += part.text ?? "";
	}
	return { text, thinking };
}

/** 提取 message.content 的正文文本(与 splitContent 的 text 部分一致,供回显配对)。 */
export function contentTextOf(content: unknown): string {
	return splitContent(content).text;
}

/**
 * message.content(有序块数组)→ MessageBlock 序列。**顺序原样保留**。
 *
 * 契约来源是 vendor 的 AssistantMessage.content:`(TextContent | ThinkingContent
 * | ToolCall)[]`,按模型输出顺序排列。实时路径下 message_start 的 content 恒为空
 * (provider 的 output.content 初始化为 [],见 pi-ai 各 api 实现),因此这条路径
 * 实际只服务历史水合与测试;实时路径的块由 *_start/delta 与 tool_execution_start
 * 逐个开出来。
 *
 * 空文本块跳过(不产出空的可折叠行);工具块用 vendor 的 ToolCall.id 建,
 * 与 tool_execution_start.toolCallId 同源,后续结果按 id 归位。
 */
export function blocksFromContent(content: unknown): MessageBlock[] {
	if (typeof content === "string") return content.length > 0 ? [{ kind: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const out: MessageBlock[] = [];
	for (const part of content) {
		const p = part as {
			type?: string;
			text?: string;
			thinking?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
			result?: unknown;
			isError?: unknown;
		};
		if (p.type === "text") {
			if (typeof p.text === "string" && p.text.length > 0) out.push({ kind: "text", text: p.text });
		} else if (p.type === "thinking") {
			// 落盘形态可能是 { thinking } 也可能是 { text }(见 src/session-text.ts 同款兜底)
			const t = typeof p.thinking === "string" ? p.thinking : typeof p.text === "string" ? p.text : "";
			if (t.length > 0) out.push({ kind: "thinking", text: t });
		} else if (p.type === "toolCall" && typeof p.id === "string") {
			// 历史水合的工具块内联着执行结果(服务端按 toolCallId 配对回填);
			// 实时路径的调用块不带 result,由 tool_execution_end 后续填入
			const hasResult = "result" in p;
			out.push({
				kind: "tool",
				call: {
					id: p.id,
					name: p.name ?? "",
					args: argsToString(p.arguments),
					result: hasResult ? (typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "")) : null,
					isError: p.isError === true,
				},
			});
		}
	}
	return out;
}

/**
 * 开一个同类型空块。**已有同类型且仍为空的末块则复用**——provider 的
 * `*_start` 与 message_start 的 content 可能指同一个块(前者兜底后者),
 * 不去重会长出双空块。
 */
function openBlock(blocks: MessageBlock[], kind: "text" | "thinking"): MessageBlock[] {
	const last = blocks[blocks.length - 1];
	if (last && last.kind === kind && last.text.length === 0) return blocks;
	return [...blocks, { kind, text: "" }];
}

/**
 * 把 delta 追加到末块。末块类型相同即就地追加,否则新开一块。
 *
 * 为什么不需要额外的「段」标记:一次 assistant 段内同类块至多一个
 * (thinking → text → toolCall),且相邻两段之间必然隔着工具块(多轮工具调用),
 * 所以「末块同类型 = 本段的块」。唯一的例外是中断后不带工具调用的续写,
 * 那种情况下两段同类文本会并成一块(可接受,不产生错误内容)。
 */
function appendDelta(blocks: MessageBlock[], kind: "text" | "thinking", delta: string): MessageBlock[] {
	if (delta.length === 0) return blocks;
	const last = blocks[blocks.length - 1];
	if (last && last.kind === kind) {
		return [...blocks.slice(0, -1), { kind, text: last.text + delta }];
	}
	return [...blocks, { kind, text: delta }];
}

/** 新段块的接入:追加到气泡末尾,末块若为同类型空块则被本段取代(避免双空块)。 */
function mergeSegment(blocks: MessageBlock[], seg: readonly MessageBlock[]): MessageBlock[] {
	let out = blocks;
	for (const b of seg) {
		const last = out[out.length - 1];
		if (last && last.kind === b.kind && last.kind !== "tool" && last.text.length === 0) {
			out = [...out.slice(0, -1), b];
		} else {
			out = [...out, b];
		}
	}
	return out;
}

/** 按 toolCallId 就地更新工具块(返回值与原数组同身份表示无改动)。 */
function mapToolBlocks(blocks: MessageBlock[], toolCallId: string, fn: (t: ToolCallInfo) => ToolCallInfo): MessageBlock[] {
	let changed = false;
	const next = blocks.map((b) => {
		if (b.kind !== "tool" || b.call.id !== toolCallId) return b;
		const call = fn(b.call);
		if (call === b.call) return b;
		changed = true;
		return { kind: "tool" as const, call };
	});
	return changed ? next : blocks;
}

/**
 * 多浏览器去重决策:SSE 回显的 user message_start 需要与「本窗口乐观气泡」配对。
 * 发送方在 send() 时已本地渲染气泡,回显应跳过(render: false);其他窗口没有
 * 该气泡,回显必须渲染(render: true)。FIFO 配对:气泡按发送顺序入队,服务端
 * 回显按会话顺序到达,队头文本匹配即视为自己的回显。
 */
export function resolveUserMessageEcho(
	pending: readonly string[],
	text: string,
): { render: boolean; pending: string[] } {
	if (pending.length > 0 && pending[0] === text) {
		return { render: false, pending: pending.slice(1) };
	}
	return { render: true, pending: [...pending] };
}

/** 从尾向前找最后一条未 done 的 assistant 消息的下标;找不到返回 -1。 */
function lastPendingAssistantIndex(messages: ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant" && !messages[i].done) return i;
	}
	return -1;
}

/** 从尾向前找最后一条 assistant 消息的下标(不限 done);找不到返回 -1。 */
function lastAssistantIndex(messages: ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return i;
	}
	return -1;
}

/**
 * 找「最后一轮的用户消息」——报错卡的「重试」用它定位要重放的那一轮(纯函数,便于单测)。
 *
 * 报错消息(`role === "error"`)**直接跳过**:它不是真实 entry,而且总是落在失败
 * 那一轮的用户消息之后,不跳过就永远只看到报错卡,重试按钮等于死的。
 *
 * 返回 null 的两种情况:对话为空;最后一条真实消息不是 user —— 那一轮已经产出过
 * assistant 输出(报错发生在更早的一轮里),「重放这一问」的语义不再成立,
 * 调用方该退化成「直接再发一次」而不是去撤回。
 */
export function lastUserTurn(messages: readonly ChatMessage[]): ChatMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "error") continue;
		return m.role === "user" ? m : null;
	}
	return null;
}

/**
 * 处理单个 AgentEventDto,返回新状态(不可变更新)。
 * 未知事件类型返回原状态。字段按实际 vendor 形状防御式处理:
 * message.content 可能是 string 或 block 数组;tool 的 args/result 可能是字符串或对象。
 */
export function processAgentEvent(state: SessionViewState, event: AgentEventDto): SessionViewState {
	switch (event.type) {
		case "message_start": {
			const m = event.message;
			if (!m) return state;
			// 非 user/assistant 角色(如 toolResult)不渲染为气泡,直接跳过
			if (m.role !== "user" && m.role !== "assistant") return state;
			/**
			 * **provider 侧报错(需求 1 的真正主路径)**:vendor 在模型调用失败时
			 * 不抛异常,而是给这条 assistant 消息落 `stopReason: "error"` +
			 * `errorMessage`(content 恒空),回合照常结束 —— 所以永远不会走
			 * `chat_error`(那条广播只在 chat() 本身 reject 时才发:未配置模型、
			 * 会话创建失败之类)。实测 deepseek 401 的 message_start 就已经带全了
			 * stopReason/errorMessage/provider/model,因此在首个事件就把气泡换成
			 * 报错卡:不留一个空的「PI」(用户看到空气泡只会以为卡住了)。
			 *
			 * 与 chat_error 分支共用同一份渲染数据(describeChatError),区别只在于
			 * 这里的原文来自消息本身、且能带上 provider/model 那行。
			 */
			const rawError = typeof m.errorMessage === "string" ? m.errorMessage : "";
			if (m.role === "assistant" && rawError.length > 0) {
				const msg: ChatMessage = {
					id: event.entryId ?? localId(),
					...(event.entryId ? { entryId: event.entryId } : {}),
					role: "error",
					blocks: [],
					done: true,
					error: describeChatError(rawError, providerModelLine(m)),
				};
				return { ...state, messages: [...state.messages, msg] };
			}
			// 思考块只属于 assistant;user 消息的 content 里即便混进 thinking 块也丢掉
			// (防御式,渲染侧不该给用户消息画思考折叠块)
			const seg = m.role === "user" ? blocksFromContent(m.content).filter((b) => b.kind === "text") : blocksFromContent(m.content);
			// 同轮回复合并:一轮 user 消息之后的多条 assistant 消息(多轮工具调用)并入
			// 同一条气泡。**块按顺序追加,不再用 \n\n 拼成平铺字符串** —— 顺序就是数据。
			// 新的一轮从 user 消息开始,因此最后一条是 assistant 才合并。
			if (m.role === "assistant") {
				const last = state.messages[state.messages.length - 1];
				if (last && last.role === "assistant") {
					const messages = [...state.messages];
					messages[messages.length - 1] = {
						...last,
						blocks: mergeSegment(last.blocks, seg),
						// 上一条的 message_end 已置 done,合并后继续流式,等本段 message_end 再置 done
						done: false,
						// 水合:组的终点随最后一段推进(实时路径该字段由 agent_settled 落)
						...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
					};
					return { ...state, messages };
				}
			}
			const msg: ChatMessage = {
				// 历史水合(带 entryId)直接用服务端稳定 id;实时消息先用本地随机 id,
				// message_end 到达时替换成真 id(entryId)
				id: event.entryId ?? localId(),
				...(event.entryId ? { entryId: event.entryId } : {}),
				role: m.role,
				blocks: seg,
				done: false,
				// 计时起点:历史水合给的是组内首条 entry 时间;实时路径取本轮 turn_start
				// (用户发出那一刻),而不是首个 token 到达时刻
				...(m.role === "assistant"
					? {
							startedAt: event.startedAt ?? state.turnStartedAt ?? Date.now(),
							...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
						}
					: {}),
			};
			return { ...state, messages: [...state.messages, msg] };
		}
			case "message_update": {
				const deltaEvent = event.assistantMessageEvent;
				if (!deltaEvent) return state;
				// 按序匹配:delta 落到最后一条未 done 的 assistant 消息(没有则忽略)
				const i = lastPendingAssistantIndex(state.messages);
				if (i === -1) return state;
				const messages = [...state.messages];
				const cur = messages[i]!;
				const t = deltaEvent.type;
				let blocks: MessageBlock[];
				if (t === "thinking_start") blocks = openBlock(cur.blocks, "thinking");
				else if (t === "text_start") blocks = openBlock(cur.blocks, "text");
				else if (t === "thinking_delta") blocks = appendDelta(cur.blocks, "thinking", deltaEvent.delta ?? "");
				else if (t === "text_delta") blocks = appendDelta(cur.blocks, "text", deltaEvent.delta ?? "");
				// toolcall_start/delta/end 不建块:工具块由 tool_execution_start 开
				// (那时才有 toolCallId/toolName/完整 args),位置天然落在本段正文之后、
				// 下一段思考之前 —— 正是它该在的地方
				else return state;
				if (blocks === cur.blocks) return state;
				messages[i] = { ...cur, blocks };
				return { ...state, messages };
			}
		case "tool_execution_start": {
			const { toolCallId, toolName, args } = event;
			if (!toolCallId || !toolName) return state;
			// 工具块必然属于 assistant 轮:挂到最后一条 assistant 消息
			// (真实事件流中工具执行紧随 assistant 的 message_end,最后一条即该 assistant)
			const i = lastAssistantIndex(state.messages);
			if (i === -1) return state;
			const cur = state.messages[i]!;
			// 幂等:同一 toolCallId 重复 start(SSE 重放 / 水合已建块)不再追加
			if (cur.blocks.some((b) => b.kind === "tool" && b.call.id === toolCallId)) return state;
			const card: ToolCallInfo = {
				id: toolCallId,
				name: toolName,
				args: argsToString(args),
				result: null,
				isError: false,
			};
			const messages = [...state.messages];
			messages[i] = { ...cur, blocks: [...cur.blocks, { kind: "tool", call: card }] };
			return { ...state, messages };
		}
		case "tool_execution_update": {
			// 流式局部结果(bash stdout/stderr):**快照整段替换**,不是增量。
			// 取不出文本(如 bash 的启动信号 {content: []})时保持原值,避免把已出输出清掉。
			const { toolCallId, partialResult } = event;
			if (!toolCallId) return state;
			const text = partialTextOf(partialResult);
			if (text === null) return state;
			return {
				...state,
				messages: state.messages.map((m) => {
					const blocks = mapToolBlocks(m.blocks, toolCallId, (t) => ({ ...t, stream: text }));
					return blocks === m.blocks ? m : { ...m, blocks };
				}),
			};
		}
		case "tool_execution_end": {
			const { toolCallId, result, isError } = event;
			if (!toolCallId) return state;
			return {
				...state,
				messages: state.messages.map((m) => {
					const blocks = mapToolBlocks(m.blocks, toolCallId, (t) => ({
						...t,
						result: typeof result === "string" ? result : JSON.stringify(result ?? ""),
						isError: isError ?? false,
						// 结束了就以最终结果为准,丢掉流式快照(避免两份内容并存)
						stream: null,
					}));
					return blocks === m.blocks ? m : { ...m, blocks };
				}),
			};
		}
		case "message_end": {
			// 只标记最后一条未 done 的 assistant 消息;message_end 也会为 toolResult/user 消息发射,忽略它们
			const { entryId } = event;
			// 最近一轮提示词缓存命中:随 assistant 的 message_end 到达(toolResult/user
			// 及历史水合的空 message 无 usage,extractCacheHit 返回 null,保留原值)
			const hit = extractCacheHit(event.message);
			let messages = state.messages;
			// 服务端附加的 entry id:替换该角色的临时随机 id(乐观气泡/流式消息),
			// 撤回按钮据此定位(找最后一条「同角色且尚无 entryId」的消息)
			if (entryId) {
				const role = event.message.role;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i]!.role === role && !messages[i]!.entryId) {
						messages = [...messages];
						messages[i] = { ...messages[i]!, entryId };
						break;
					}
				}
			}
			const i = lastPendingAssistantIndex(messages);
			if (i === -1) return { ...state, messages, ...(hit ? { cacheHit: hit } : {}) };
			messages = [...messages];
			messages[i] = { ...messages[i]!, done: true };
			return { ...state, messages, ...(hit ? { cacheHit: hit } : {}) };
		}
		case "turn_start":
			// isStreaming 已为 true 说明本轮已在进行中(多轮工具调用的后续 turn):
			// 保留首轮的计时起点,不重开表
			return { ...state, isStreaming: true, turnStartedAt: state.isStreaming ? state.turnStartedAt : Date.now() };
		/**
		 * 模型报错(需求 1「错误原文照实显示」):**在对话流里落一张卡**,位置就在
		 * 它发生的地方 —— 用户消息之后、下一次重试之前。原文逐字存进 `error.raw`,
		 * 这里不做任何加工(标题/状态码的归类在 chat-error.ts,原文永远原样)。
		 *
		 * 为什么不是「顶部横幅 / toast」:报错恰恰是最需要被复制给供应商的东西,
		 * 而横幅会随着下一次操作消失、切章即清、也没法把 request id 完整选出来。
		 * 为什么不是一条 assistant 消息:它不是会话 entry(服务端只广播,不落盘),
		 * 混进 assistant 会被「同轮回复合并」「回合计时」当成模型输出处理。
		 *
		 * 这里**不动 isStreaming**:报错时回合已经结束,agent_settled 会收拾它;
		 * 若 sendMessage 在 turn_start 之前就抛(未配置模型),本来也没置起来。
		 */
		case "chat_error": {
			const msg: ChatMessage = {
				id: localId(),
				role: "error",
				blocks: [],
				done: true,
				error: describeChatError(event.message),
			};
			return { ...state, messages: [...state.messages, msg] };
		}
		case "agent_settled": {
			// 回合真正结束:给本轮 assistant 气泡落结束时间,「已工作 X 分 Y 秒」据此定稿。
			// 无 startedAt 的气泡(历史水合)不补 —— 没有起点的时长是假的
			const messages = [...state.messages];
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]!;
				if (m.role !== "assistant") continue;
				if (m.startedAt !== undefined && m.endedAt === undefined) {
					messages[i] = { ...m, endedAt: Date.now() };
				}
				break;
			}
			return { ...state, isStreaming: false, messages };
		}
		// 上下文压缩(自动阈值/溢出或手动触发):开始/结束事件驱动 compacting 标记,
		// 对话末尾据此显示「正在压缩上下文」(压缩发生在流式回合内或回合之间,与 isStreaming 独立)
		case "compaction_start":
			return { ...state, compacting: true };
		case "compaction_end":
			return { ...state, compacting: false };
		default:
			return state;
	}
}
