/**
 * 简化输出模式下的工具动态状态提示:工具名 → 中文进行时文案。
 * 覆盖 web 工具集(web.ts ALL_WEB_TOOLS,移动端剔除 grep/find);
 * 未知工具回退通用文案,保证任何工具都有对应提示。
 */
export const TOOL_STATUS: Record<string, string> = {
	read: "正在阅读",
	write: "正在编辑",
	edit: "正在编辑",
	grep: "正在搜索",
	find: "正在查找",
	ls: "正在查看",
	word_count: "正在统计字数",
	world_update: "正在更新世界书",
	world_find: "正在查阅世界书",
};
export const DEFAULT_TOOL_STATUS = "正在调用工具";

/** 工具状态提示所需的最小消息形状(与 ChatMessage 的 toolCalls 字段对齐)。 */
interface ToolStatusMessage {
	role: string;
	toolCalls: ReadonlyArray<{ name: string; result: string | null; isError: boolean }>;
}

/**
 * 当前正在执行的工具名:从尾向前找最后一条 assistant 消息里最后一个
 * result 为 null 且未失败的工具调用(tool_execution_start 挂卡片时 result 为 null,
 * tool_execution_end 到达后置为结果文本)。顺序执行时最多一个;并行调用取
 * 最后一个(显示最新发起的那个)。工具轮次后的 assistant 文本合并进同一条消息,
 * 因此「流式正文中 + 无 result 为 null 的工具」→ 返回 null,回退思考提示。
 */
export function activeToolName(messages: ReadonlyArray<ToolStatusMessage>): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (let j = m.toolCalls.length - 1; j >= 0; j--) {
			const t = m.toolCalls[j]!;
			if (t.result === null && !t.isError) return t.name;
		}
	}
	return null;
}
