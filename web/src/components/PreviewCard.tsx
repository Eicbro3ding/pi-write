import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { draftDiffStats, type DiffLine, type PreviewData } from "../preview.ts";
import type { WorldDiff } from "../preview.ts";
import { DUR, EASE, EDGE_IN } from "../motion.ts";
import {
	FOLD_COLLAPSED_LINES,
	FOLD_EXPANDED_MAX_PX,
	foldLabel,
	isFoldable,
	previewDefaultOpen,
	previewFoldSummary,
} from "../fold.ts";
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

/** diff 行:按行数分档折叠(写死 max-height 时短内容被截、
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
 *  flex:1 弹性分配(stage-scroll > .chat-scroll { flex: none } 已解),动画本身无辜。
 *
 *  **默认开还是默认收由内容体量决定**(2026-09-30,见 fold.ts 的 `previewDefaultOpen`):
 *  一回合改了几百行 diff / 多条词条时,卡片默认收起免得把消息流撑爆;小预览保持展开。
 *  `forceOpen` 给「必须让人看见」的场景(如剧本确认:动作按钮在体内)强制展开。
 *  收起的卡片**不渲染 body**——大 diff 的行不会被建出来(DOM 体量也跟着降)。 */
export function PreviewCard({
	data,
	actions,
	forceOpen = false,
}: {
	data: PreviewData;
	actions?: ReactNode;
	/** 无视体量判据、强制默认展开(体内有必须可见的动作时用)。 */
	forceOpen?: boolean;
}) {
	const autoOpen = previewDefaultOpen(data, { hasActions: actions != null, forceOpen });
	/** 用户是否手动开合过:手动之后不再被「内容变长/变短」抢走控制权。 */
	const [manual, setManual] = useState<boolean | null>(null);
	const [openAuto, setOpenAuto] = useState(autoOpen);
	const open = manual ?? openAuto;
	/**
	 * 内容体量跨越阈值时自动收起/展开——只到用户第一次手动开合为止。
	 * 为什么不是只算一次:预览数据可以**先小后大**(流式/水合回填时先来半张卡,
	 * 行数随后长起来),只算一次会让"先看到小预览"的卡永远保持展开,又回到撑爆消息流。
	 */
	useEffect(() => {
		if (manual === null) setOpenAuto(autoOpen);
	}, [autoOpen, manual]);
	const toggle = () => {
		setManual(!open);
		setOpenAuto(!open);
	};
	const title = "error" in data
		? "预览"
		: data.kind === "draft"
			? "预览 · 草稿"
			: data.kind === "script"
				? "剧本 · 待确认"
				: data.mode === "graph"
					? "预览 · 世界树"
					: "预览 · 词条";
	// 草稿卡折叠头改成「路径 + 增删行数」,其余类型保留标题
	const stats = draftDiffStats(data);
	// 收起时在底部补一行摘要,让「收了多少」可见(否则用户只知道被收了)
	const foldedSummary = !open ? previewFoldSummary(data) : "";
	return (
		<motion.div
			className="preview-card"
			initial={EDGE_IN.right}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: DUR.base, ease: EASE.out }}
		>
			<button
				type="button"
				className="preview-toggle"
				aria-expanded={open}
				onClick={toggle}
			>
				<span className={`preview-arrow${open ? " open" : ""}`}>
					{/* 单枚 chevron + rotate 过渡(与 .think-arrow 等同一套,原为直换图标硬切) */}
					<Lu icon="chevron-right" size={12} strokeWidth={1.8} />
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
			{foldedSummary && <div className="preview-folded-note">{foldedSummary}</div>}
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
