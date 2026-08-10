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
