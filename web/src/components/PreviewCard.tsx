import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { draftDiffStats, type DiffLine, type PreviewData } from "../preview.ts";
import type { WorldDiff } from "../preview.ts";
import { DUR, EASE, EDGE_IN } from "../motion.ts";
import { FOLD_COLLAPSED_LINES, FOLD_EXPANDED_MAX_PX, foldLabel, isFoldable } from "../fold.ts";
import { PreviewGraph } from "./PreviewGraph.tsx";
import { PreviewEntryCard } from "./PreviewEntryCard.tsx";
import { ScriptView } from "./ScriptView.tsx";
import { Lu } from "./Lu.tsx";

/** 世界树变更摘要行(图模式):新增/修改/删除的条目与关系;无变更返回 null。 */
export function worldSummary(diff: WorldDiff): string | null {
	const parts: string[] = [];
	if (diff.addedEntries.length > 0) parts.push(`✚ ${diff.addedEntries.map((e) => e.title).join("、")}`);
	if (diff.modifiedEntries.length > 0) parts.push(`✎ ${diff.modifiedEntries.map((e) => e.title).join("、")}`);
	if (diff.removedEntries.length > 0) parts.push(`✂ ${diff.removedEntries.map((e) => e.title).join("、")}`);
	if (diff.addedRelations.length > 0) parts.push(`关系 ✚${diff.addedRelations.length}`);
	if (diff.removedRelations.length > 0) parts.push(`关系 ✂${diff.removedRelations.length}`);
	if (diff.modifiedRelations.length > 0) parts.push(`关系 ✎${diff.modifiedRelations.length}`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** diff 行:按行数分档折叠(设计稿 03-组件规范/04——写死 max-height 时短内容被截、
 *  长内容看不到全貌,展开入口也没意义)。>12 行折到 12 行 + 底部渐隐 + 展开入口。 */
function DiffLines({ lines }: { lines: DiffLine[] }) {
	const [open, setOpen] = useState(false);
	const foldable = isFoldable(lines.length);
	const shown = foldable && !open ? lines.slice(0, FOLD_COLLAPSED_LINES) : lines;
	return (
		<div className={`diff-fold${open ? " open" : ""}`} style={open ? { maxHeight: FOLD_EXPANDED_MAX_PX } : undefined}>
			{shown.map((l, j) => (
				<div key={j} className={`diff-${l.kind}`}>
					{l.text || "\u00A0"}
				</div>
			))}
			{foldable && !open && <div className="fold-mask" aria-hidden="true" />}
			{foldable && (
				<button type="button" className="fold-more" onClick={() => setOpen((v) => !v)}>
					{open ? "收起" : foldLabel(lines.length)}
				</button>
			)}
		</div>
	);
}

/** AI 编辑预览内容(卡片主体):草稿 diff / 世界图 / 词条百科 / 剧本确认。
 *  PreviewCard 与编剧编辑确认卡(ConfirmCard)共用——确认队列复用同一渲染,零副本。 */
export function PreviewBody({ data }: { data: PreviewData }) {
	return "error" in data ? (
		<div className="preview-error">预览加载失败</div>
	) : data.kind === "draft" ? (
		<div className="preview-diff">
			{data.sections.map((s, i) => (
				<div key={i}>
					<div className="preview-file">{s.path}</div>
					<DiffLines lines={s.diff} />
				</div>
			))}
		</div>
	) : data.kind === "script" ? (
		// 剧本确认门(2026-08-11):导演 script_confirm 提交的剧本——预览卡片家族
		// 的一种,确认/修改动作由调用方经 actions 插槽提供
		<ScriptView script={data.script} />
	) : data.mode === "graph" ? (
		<>
			<PreviewGraph world={data.afterWorld} diff={data.worldDiff} slug={data.slug} />
			{worldSummary(data.worldDiff) && <div className="preview-summary">{worldSummary(data.worldDiff)}</div>}
		</>
	) : (
		<div className="preview-entries">
			{data.entries.map((en) => (
				<PreviewEntryCard
					key={en.id}
					entry={en}
					allEntries={data.allEntries}
					relations={data.relations}
					slug={data.slug}
				/>
			))}
		</div>
	);
}

/** AI 编辑预览卡片:每回合一张;内容 = 最近一种编辑类型(草稿 diff / 世界图 / 词条百科 / 剧本)。
 *  actions 可选:卡片底部动作区(剧本确认卡的「确认开演/需要修改」等由调用方注入)。
 *  折叠展开用 framer 高度动画(2026-08-11 恢复):「压缩」的真凶是舞台页对话区的
 *  flex:1 弹性分配(stage-scroll > .chat-scroll { flex: none } 已解),动画本身无辜。 */
export function PreviewCard({ data, actions }: { data: PreviewData; actions?: ReactNode }) {
	const [open, setOpen] = useState(true);
	const title = "error" in data
		? "预览"
		: data.kind === "draft"
			? "预览 · 草稿"
			: data.kind === "script"
				? "剧本 · 待确认"
				: data.mode === "graph"
					? "预览 · 世界树"
					: "预览 · 词条";
	// 草稿卡折叠头改成「路径 + 增删行数」(设计稿 03-组件规范/03),其余类型保留标题
	const stats = draftDiffStats(data);
	return (
		<motion.div
			className="preview-card"
			initial={EDGE_IN.right}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: DUR.base, ease: EASE.out }}
		>
			<button type="button" className="preview-toggle" onClick={() => setOpen((v) => !v)}>
				<span className="preview-arrow">
					<Lu icon={open ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
				</span>
				{stats ? (
					<>
						<span className="preview-path">{stats.path}</span>
						<span className="preview-counts">
							<span className="add">+{stats.add}</span>
							<span className="del">-{stats.del}</span>
						</span>
					</>
				) : (
					<span className="preview-title">{title}</span>
				)}
			</button>
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						key="body"
						className="preview-body"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: DUR.base, ease: EASE.inOut }}
					>
						<PreviewBody data={data} />
						{actions && <div className="preview-actions">{actions}</div>}
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
