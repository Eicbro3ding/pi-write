/**
 * 会话消息文本提取 —— TUI(extension.ts)与 web(session-host.ts)共用的纯函数。
 *
 * 两处原各持一份 chatTextOfMessage(形状略异,行为漂移),2026-08-10 收敛到此。
 * 输入取宽松形状(role/content 可选),AgentMessage 与部分形状均兼容。
 */

/** 从会话消息提取 user/assistant 文本;无文本返回 undefined。
 *  content 为 string 或 [{ type: "text", text }] 数组;thinking/工具等块跳过。 */
export function chatTextOfMessage(message: { role?: string; content?: unknown }): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		// 分开取 text 再判空:直接链式 ?. 会触发 TS 对 cast 表达式的收窄误报
		const text = (part as { text?: string }).text;
		if ((part as { type?: string }).type === "text" && text !== undefined && text.trim().length > 0) {
			parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** 从 assistant 消息提取思考链文本(thinking 块;无则空串)。历史水合用。
 *  落盘形态为 { type: "thinking", thinking, thinkingSignature },兜底兼容 text 字段。 */
export function chatThinkingOfMessage(message: { role?: string; content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const block = part as { type?: string; thinking?: string; text?: string };
		if (block.type !== "thinking") continue;
		const raw = typeof block.thinking === "string" ? block.thinking : block.text;
		if (raw !== undefined && raw.trim().length > 0) parts.push(raw);
	}
	return parts.join("\n\n");
}

// —— 有序内容块(2026-09-19)——

/**
 * 会话历史里的一个有序内容块。
 *
 * 形状与 vendor 的 `AssistantMessage.content`(`TextContent | ThinkingContent |
 * ToolCall`)**对齐但独立定义**,理由有二:
 * ① 不 require vendor 类型,web 侧与 TUI 侧都能用同一份;
 * ② 工具块**额外内联执行结果**——工具结果在磁盘上是独立的 toolResult entry,
 *    配对回填后内联在调用块上,历史水合就不必再合成一对 tool_execution 事件。
 *
 * 顺序即真实顺序:一个 assistant 段是 thinking → text → toolCall*,
 * 一个用户回合由多个 assistant 段 + 它们的 toolResult 交替构成。
 */
export type ChatContentPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: string; result?: string | null; isError?: boolean };

/** 工具调用参数 → 展示字符串(与前端 args 口径一致:字符串原样,对象序列化)。 */
function argsToText(args: unknown): string {
	return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/**
 * 从单条 assistant 消息提取有序内容块(思考 / 正文 / 工具调用)。
 *
 * 空文本块跳过(不产出空的可折叠行);工具块用 vendor 的 `ToolCall.id` 建,
 * 与 toolResult entry 的 `toolCallId` 同源,调用方据此回填结果。
 */
export function chatContentOfMessage(message: { role?: string; content?: unknown }): ChatContentPart[] {
	if (message.role !== "assistant") return [];
	const content = message.content;
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const out: ChatContentPart[] = [];
	for (const part of content) {
		const block = part as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.trim().length > 0) out.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			const raw = typeof block.thinking === "string" ? block.thinking : block.text;
			if (raw !== undefined && raw.trim().length > 0) out.push({ type: "thinking", text: raw });
		} else if (block.type === "toolCall" && typeof block.id === "string") {
			out.push({ type: "toolCall", id: block.id, name: block.name ?? "", arguments: argsToText(block.arguments) });
		}
	}
	return out;
}

/** toolResult entry 的 toolCallId(非 toolResult 或缺字段为 undefined)。 */
export function toolResultCallId(message: { role?: string; toolCallId?: unknown }): string | undefined {
	if (message.role !== "toolResult") return undefined;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

/**
 * toolResult entry 的文本。**不能用 chatTextOfMessage** —— 它只认 user/assistant,
 * 对 toolResult 一律返回 undefined(那正是改造前工具结果被整段丢掉的原因之一)。
 */
export function toolResultText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const text = (part as { text?: string }).text;
		if ((part as { type?: string }).type === "text" && typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}
