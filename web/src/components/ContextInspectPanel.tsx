import type { InspectReportDto, InspectSectionRowDto } from "../types.ts";

interface ContextInspectPanelProps {
	/** 检视报告;null = 尚未加载(或该章还没注入过)。 */
	report: InspectReportDto | null;
	/** 正在拉取。 */
	loading: boolean;
	/** 手动重拉(世界书刚被改过时用)。 */
	onRefresh: () => void;
}

const KIND_LABEL: Record<string, string> = {
	memory: "记忆",
	summary: "世界观概述",
	entries: "世界书条目",
	constraints: "写作约束",
	notice: "Notice",
	storyline: "发展线",
	// 2026-10-05:这里原先还有一条 `sample: "文风采样"` —— 采样已移出背景包
	// (改由 read_style 按需取),背景包里再没有这一段可展示。
};

/**
 * 上下文检视面板(T5,2026-10-04)。
 *
 * 回答一个问题:**这一轮 agent 到底看到了什么、还差什么**。
 * 只读 —— 它不改任何东西,但把每个数字对应的设置字段名直接写出来,
 * 用户要改就知道去哪儿改。
 *
 * 三段式:总量条 → 分段明细 → 被省略清单 → 可调设置。
 * 顺序不是随便排的:先给「用了多少」,再给「花在哪」,然后才是「少了什么」
 * 和「怎么改」—— 这正是用户产生疑问的顺序。
 */
export function ContextInspectPanel({ report, loading, onRefresh }: ContextInspectPanelProps) {
	if (loading && !report) {
		return <div className="inspect-panel inspect-loading">正在读取上下文快照…</div>;
	}
	if (!report) {
		return <div className="inspect-panel inspect-empty">本章还没有注入过背景包 —— 切换章节后即可看到。</div>;
	}
	const overBudget = report.percent >= 88;
	return (
		<div className="inspect-panel">
			<div className="inspect-head">
				<div className="inspect-total">
					<span className={`inspect-pct ${overBudget ? "hot" : ""}`}>{report.percent}%</span>
					<span className="inspect-total-label">
						背景包 {report.used} / {report.budget} token
					</span>
				</div>
				<button type="button" className="inspect-refresh" onClick={onRefresh} disabled={loading}>
					{loading ? "读取中…" : "刷新"}
				</button>
			</div>
			<div className="inspect-bar" role="img" aria-label={`已用 ${report.percent}%`}>
				<div className={`inspect-bar-fill ${overBudget ? "hot" : ""}`} style={{ width: `${Math.min(100, report.percent)}%` }} />
			</div>

			<div className="inspect-section-title">各段占用</div>
			{report.sections.length === 0 ? (
				<div className="inspect-empty-line">本章没有任何背景注入 —— 检查世界书与约束是否为空。</div>
			) : (
				<ul className="inspect-sections">
					{report.sections.map((s) => (
						<InspectSectionRow key={s.id} row={s} />
					))}
				</ul>
			)}

			<div className="inspect-section-title">被省略的内容</div>
			{report.trimmed.length === 0 ? (
				<div className="inspect-empty-line">没有裁切 —— 世界书全部装下了。</div>
			) : (
				<ul className="inspect-trims">
					{report.trimmed.map((t, i) => (
						<li key={`${t.kind}-${t.label}-${i}`} className="inspect-trim">
							<div className="inspect-trim-head">
								<span className="inspect-trim-label">{t.label}</span>
								<span className="inspect-trim-tokens">约 {t.tokens} tok</span>
							</div>
							<div className="inspect-trim-impact">{t.impact}</div>
						</li>
					))}
				</ul>
			)}

			<div className="inspect-section-title">相关设置</div>
			<ul className="inspect-budgets">
				{report.budgetItems.map((b) => (
					<li key={b.key} className="inspect-budget">
						<span className="inspect-budget-label">{b.label}</span>
						<span className="inspect-budget-value">
							{b.value} <span className="inspect-budget-range">{b.range}</span>
						</span>
						<span className="inspect-budget-effect">{b.effect}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** 单段一行:名称 + 占比条 + 数值 + 条数 + 是否可裁。 */
function InspectSectionRow({ row }: { row: InspectSectionRowDto }) {
	const width = Math.min(100, row.percent);
	return (
		<li className="inspect-section">
			<span className="inspect-name">{KIND_LABEL[row.id] ?? row.label}</span>
			<span className="inspect-mini-bar" aria-hidden="true">
				<span className={`inspect-mini-fill ${row.trimmable ? "trimmable" : "resident"}`} style={{ width: `${width}%` }} />
			</span>
			<span className="inspect-count">{row.count > 0 ? `${row.count} 项` : ""}</span>
			<span className="inspect-tokens">{row.tokens}</span>
			<span className={`inspect-badge ${row.trimmable ? "trimmable" : "resident"}`}>{row.trimmable ? "可裁" : "常驻"}</span>
		</li>
	);
}
