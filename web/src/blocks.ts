/**
 * 消息块派生助手(纯函数,便于单测)。
 *
 * 顺序是数据本身(见 types.ts 的 MessageBlock):渲染原样遍历 blocks。
 * 这里的函数只服务于两类需要「整条消息一个值」的场景 ——
 * 兼容消费点(舞台快照对齐比较)与测试断言,不是渲染路径。
 */
import type { ChatMessage, MessageBlock, ToolCallInfo } from "./types.ts";

/** 某一类块的文本按序拼接(空行分隔);空文本块不参与。 */
function joinBlocks(blocks: readonly MessageBlock[], kind: "text" | "thinking"): string {
	const parts: string[] = [];
	for (const b of blocks) {
		if (b.kind === kind && b.text.length > 0) parts.push(b.text);
	}
	return parts.join("\n\n");
}

/** 全部正文块按序拼接(不含思考与工具)。 */
export function blocksText(blocks: readonly MessageBlock[]): string {
	return joinBlocks(blocks, "text");
}

/** 全部思考块按序拼接(不含正文与工具)。 */
export function blocksThinking(blocks: readonly MessageBlock[]): string {
	return joinBlocks(blocks, "thinking");
}

/** 全部工具调用(按块出现顺序;就是时间顺序)。 */
export function blocksTools(blocks: readonly MessageBlock[]): ToolCallInfo[] {
	const out: ToolCallInfo[] = [];
	for (const b of blocks) {
		if (b.kind === "tool") out.push(b.call);
	}
	return out;
}

/** 消息是否有可渲染内容(正文/思考/工具任一非空)。 */
export function hasRenderableBlock(m: ChatMessage): boolean {
	return m.blocks.some((b) => (b.kind === "tool" ? true : b.text.length > 0));
}

/**
 * 回合耗时(ms):有起止时间戳才算得出;缺一返回 null。
 * 历史水合的消息没有起点(见 messagesToEvents),不显示时长。
 */
export function turnDurationMs(m: ChatMessage): number | null {
	if (m.startedAt === undefined || m.endedAt === undefined) return null;
	return Math.max(0, m.endedAt - m.startedAt);
}

/** 耗时 → 「2 分 53 秒」/「18 秒」/「1 秒」;不足 1 秒按 1 秒(有动作就说有动作)。 */
export function formatDuration(ms: number): string {
	const total = Math.max(1, Math.round(ms / 1000));
	const min = Math.floor(total / 60);
	const sec = total % 60;
	return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}
