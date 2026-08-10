import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PreviewData } from "../preview.ts";
import type { WorldDiff } from "../preview.ts";
import { DUR, EASE, EDGE_IN } from "../motion.ts";
import { PreviewGraph } from "./PreviewGraph.tsx";
import { PreviewEntryCard } from "./PreviewEntryCard.tsx";

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

/** AI 编辑预览内容(卡片主体):草稿 diff / 世界图 / 词条百科。PreviewCard 与
 *  编剧编辑确认卡(ConfirmCard)共用——确认队列复用同一渲染,零副本。 */
export function PreviewBody({ data }: { data: PreviewData }) {
	return "error" in data ? (
		<div className="preview-error">预览加载失败</div>
	) : data.kind === "draft" ? (
		<div className="preview-diff">
			{data.sections.map((s, i) => (
				<div key={i}>
					<div className="preview-file">{s.path}</div>
					{s.diff.map((l, j) => (
						<div key={j} className={`diff-${l.kind}`}>
							{l.text || "\u00A0"}
						</div>
					))}
				</div>
			))}
		</div>
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

/** AI 编辑预览卡片:每回合一张;内容 = 最近一种编辑类型(草稿 diff / 世界图 / 词条百科)。 */
export function PreviewCard({ data }: { data: PreviewData }) {
	const [open, setOpen] = useState(true);
	const title = "error" in data
		? "预览"
		: data.kind === "draft"
			? "预览 · 草稿"
			: data.mode === "graph"
				? "预览 · 世界树"
				: "预览 · 词条";
	return (
		<motion.div
			className="preview-card"
			initial={EDGE_IN.right}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: DUR.base, ease: EASE.out }}
		>
			<button type="button" className="preview-toggle" onClick={() => setOpen((v) => !v)}>
				<span className="preview-arrow">{open ? "▾" : "▸"}</span>
				<span className="preview-title">{title}</span>
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
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
