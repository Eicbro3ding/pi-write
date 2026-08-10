import type { SessionBranchInfo } from "../types.ts";

/**
 * 分支栏 —— 会话存在多个分支时显示在对话视图顶部:
 * 当前分支摘要 + 下拉切换(分支之间来回切换,AI 上下文随之切换,数据不丢)。
 * 只有一条分支(无分支历史)时不渲染。
 */
export function BranchBar({
	branches,
	currentLeafId,
	onNavigate,
	streaming,
}: {
	branches: SessionBranchInfo[];
	currentLeafId: string | null;
	/** 切换分支(leafId);服务端重建上下文并广播,前端经 messages_retracted 对齐。 */
	onNavigate: (leafId: string) => void;
	/** AI 流式中禁止切换(服务端拒绝)。 */
	streaming: boolean;
}) {
	if (branches.length <= 1) return null;
	const current = branches.find((b) => b.leafId === currentLeafId) ?? branches[0];
	return (
		<div className="branch-bar">
			<span className="branch-label">⑂ 分支</span>
			<select
				className="branch-select"
				value={current?.leafId ?? ""}
				disabled={streaming}
				onChange={(e) => {
					const leafId = e.target.value;
					if (leafId && leafId !== current?.leafId) onNavigate(leafId);
				}}
			>
				{branches.map((b) => (
					<option key={b.leafId} value={b.leafId}>
						{b.isCurrent ? "● " : "○ "}
						{b.summary}
						{b.tail ? ` → ${b.tail}` : ""}
						({b.count} 条)
					</option>
				))}
			</select>
		</div>
	);
}
