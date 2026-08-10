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
import type { AgentEventDto, ChatMessage, SessionViewState, ToolCallInfo } from "./types.ts";

/** 初始会话视图状态。 */
export function initialSessionState(): SessionViewState {
	return { messages: [], isStreaming: false, compacting: false };
}

/**
 * 把服务端会话历史(getSession().messages)转为 message_start 事件序列,
 * 与 SSE 事件走同一条 reducer 路径(整体替换聊天时先 RESET 再逐条 dispatch)。
 * 历史消息带服务端 entry id(entryId),ChatMessage.id 直接用它(稳定,撤回定位依据)。
 * 历史消息不追加 message_end:done 仅影响流式增量匹配,不参与渲染,
 * user/assistant 历史气泡 done 恒 false 无副作用。
 */
export function messagesToEvents(
	messages: ReadonlyArray<{ role: "user" | "assistant"; text: string; thinking?: string; id?: string }>,
): Array<Extract<AgentEventDto, { type: "message_start" }>> {
	return messages.map((m) => {
		// 历史水合的 thinking 一并还原:reducer 的 message_start 经 splitContent
		// 提取 thinking 块,思考链随消息恢复(刷新/重开页面后不丢)
		const content: Array<{ type: string; text: string }> = [];
		if (m.role === "assistant" && m.thinking && m.thinking.length > 0) {
			content.push({ type: "thinking", text: m.thinking });
		}
		content.push({ type: "text", text: m.text });
		return {
			type: "message_start",
			message: { role: m.role, content },
			...(m.id ? { entryId: m.id } : {}),
		};
	});
}

/** 把 message.content(字符串或 block 数组)拆为正文与思考文本。 */
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
			const { text, thinking } = splitContent(m.content);
			// 同轮回复合并:一轮 user 消息之后的多条 assistant 消息(多轮工具调用)并入
			// 同一条气泡,与 extractMessages 的分组规则一致(思考/正文拼接、卡片顺序保留)。
			// 新的一轮从 user 消息开始,因此最后一条是 assistant 才合并。
			if (m.role === "assistant") {
				const last = state.messages[state.messages.length - 1];
				if (last && last.role === "assistant") {
					const messages = [...state.messages];
					messages[messages.length - 1] = {
						...last,
						text:
							last.text.length > 0 && text.length > 0
								? `${last.text}\n\n${text}`
								: last.text + text,
						thinking: last.thinking.length > 0 && thinking.length > 0 ? `${last.thinking}\n\n${thinking}` : last.thinking + thinking,
						// 上一条的 message_end 已置 done,合并后继续流式,等本段 message_end 再置 done
						done: false,
					};
					return { ...state, messages };
				}
			}
			const msg: ChatMessage = {
				// 历史水合(带 entryId)直接用服务端稳定 id;实时消息先用本地随机 id,
				// message_end 到达时替换成真 id(entryId)
				id: event.entryId ?? Math.random().toString(36).slice(2),
				...(event.entryId ? { entryId: event.entryId } : {}),
				role: m.role,
				text,
				// 思考块只属于 assistant;user 消息防御式置空,渲染侧不显示思考折叠块
				thinking: m.role === "user" ? "" : thinking,
				done: false,
				toolCalls: [],
			};
			return { ...state, messages: [...state.messages, msg] };
		}
			case "message_update": {
				const deltaEvent = event.assistantMessageEvent;
				if (!deltaEvent || (deltaEvent.type !== "text_delta" && deltaEvent.type !== "thinking_delta")) {
					return state;
				}
				// 按序匹配:delta 拼到最后一条未 done 的 assistant 消息上(没有则忽略)
				const i = lastPendingAssistantIndex(state.messages);
				if (i === -1) return state;
				const delta = deltaEvent.delta ?? "";
				const messages = [...state.messages];
				if (deltaEvent.type === "thinking_delta") {
					messages[i] = { ...messages[i], thinking: messages[i].thinking + delta };
				} else {
					messages[i] = { ...messages[i], text: messages[i].text + delta };
				}
				return { ...state, messages };
			}
		case "tool_execution_start": {
			const { toolCallId, toolName, args } = event;
			if (!toolCallId || !toolName) return state;
			const card: ToolCallInfo = {
				id: toolCallId,
				name: toolName,
				args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
				result: null,
				isError: false,
			};
			// 工具卡片必然属于 assistant 轮:挂到最后一条 assistant 消息
			// (真实事件流中工具执行紧随 assistant 的 message_end,最后一条即该 assistant)
			const i = lastAssistantIndex(state.messages);
			if (i === -1) return state;
			const messages = [...state.messages];
			messages[i] = { ...messages[i], toolCalls: [...messages[i].toolCalls, card] };
			return { ...state, messages };
		}
		case "tool_execution_end": {
			const { toolCallId, result, isError } = event;
			if (!toolCallId) return state;
			return {
				...state,
				messages: state.messages.map((m) => ({
					...m,
					toolCalls: m.toolCalls.map((t) =>
						t.id === toolCallId
							? {
									...t,
									result: typeof result === "string" ? result : JSON.stringify(result ?? ""),
									isError: isError ?? false,
								}
							: t,
					),
				})),
			};
		}
		case "message_end": {
			// 只标记最后一条未 done 的 assistant 消息;message_end 也会为 toolResult/user 消息发射,忽略它们
			const { entryId } = event;
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
			if (i === -1) return { ...state, messages };
			messages = [...messages];
			messages[i] = { ...messages[i]!, done: true };
			return { ...state, messages };
		}
		case "turn_start":
			return { ...state, isStreaming: true };
		case "agent_settled":
			return { ...state, isStreaming: false };
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
