/** 简要世界观字数上限(与后端 world-data SUMMARY_LIMIT 一致)。 */
export const SUMMARY_LIMIT = 600;

interface WorldSummaryPanelProps {
	summary: string;
	onChange: (next: string) => void;
}

/**
 * 简要世界观编辑体:textarea + 字数计数(超 600 字红色提示,保存时后端会拒绝)。
 * 常驻注入(写作会话在记忆后激活组前;编剧会话为独立 block),agent 每回合都会读到。
 * 折叠开关在世界书页顶栏(w-bar,WorldPage 持有),本组件只负责编辑体;
 * 折叠时整块不渲染(WorldPage 条件渲染),不占任何高度。
 * 修改直接回调 onChange,由页面统一保存。
 */
export function WorldSummaryPanel({ summary, onChange }: WorldSummaryPanelProps) {
	const over = summary.length > SUMMARY_LIMIT;
	return (
		<section className="w-summary">
			<textarea
				rows={4}
				value={summary}
				placeholder="世界的基调、时代、核心规则与势力等——常驻注入,agent 每回合都会读到;建议 1-2 段,≤600 字"
				onChange={(e) => onChange(e.target.value)}
			/>
			<div className={over ? "w-count over" : "w-count"}>
				{summary.length} / {SUMMARY_LIMIT} 字{over ? "(超限,保存将被拒绝)" : ""}
			</div>
		</section>
	);
}
