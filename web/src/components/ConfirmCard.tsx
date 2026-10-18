import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { previewDiffStats, type PreviewData } from "../preview.ts";
import type { WorldDataDto } from "../types.ts";
import { DUR, EASE, EDGE_IN } from "../motion.ts";
import { previewDefaultOpen, previewFoldSummary } from "../fold.ts";
import { PreviewBody } from "./PreviewCard.tsx";
import { Lu } from "./Lu.tsx";

/** 待确认的编剧编辑卡:before = 编辑前基线(「回退」写回用),data = 预览渲染数据,
 *  toolCallId = 挂载键——**卡片是那次 write/edit 工具块的渲染结果**(2026-09-19);
 *  auto = 免确认模式(设置页开关):编辑落盘即归档,卡片只读展示「已应用」。 */
export interface ConfirmCardItem {
	id: string;
	kind: "draft" | "world" | "memory";
	path: string | null;
	before: string | WorldDataDto;
	data: PreviewData;
	/** 工具调用 id:决定这张卡挂在哪个块上(服务端持久化后跨刷新仍能认领)。 */
	toolCallId: string;
	auto?: boolean;
}

/**
 * 编剧编辑确认卡:diff 预览(复用 PreviewBody,与主会话预览卡同一渲染)+
 * 确认/回退。回退由调用方执行(写回编辑前状态)。
 * **它是工具块的渲染结果**(挂在该 write/edit 块的位置上),不再是锚定在消息下的
 * 独立一层;入场:右缘列容器从右侧水平滑入。
 *
 * 智能折叠(2026-10-17):此前这张卡**直渲染 PreviewBody**,没有任何体量判据——
 * 一回合改几百行 diff 就直接把消息流撑爆(PreviewCard 的 autoFold 只挂在舞台页)。
 * 现在与预览卡同一套判据(fold.ts)。注意 `hasActions` 传 **false**:确认/回退按钮
 * 在折叠体**之外**,收起不会藏掉操作——这正是这张卡与 PreviewCard 的结构差异。
 */
export function ConfirmCard({
	data,
	onConfirm,
	onRevert,
	auto = false,
}: {
	data: PreviewData;
	onConfirm(): void;
	onRevert(): void;
	/** 免确认模式:编辑已归档,只读展示(无确认/回退按钮)。 */
	auto?: boolean;
}) {
	const title =
		"error" in data
			? "预览"
			: data.kind === "draft"
				? "修改正文"
				: data.kind === "memory"
					? data.target === "user"
						? "更新作者画像"
						: "更新跨章记忆"
					: data.kind === "script"
						? "剧本确认"
						: data.mode === "graph"
							? "更新世界树"
							: "更新词条";
	const stats = previewDiffStats(data);
	const autoOpen = previewDefaultOpen(data, { hasActions: false });
	const [manual, setManual] = useState<boolean | null>(null);
	const [openAuto, setOpenAuto] = useState(autoOpen);
	const open = manual ?? openAuto;
	/** 体量跨越阈值时自动收起/展开——只到用户第一次手动开合为止(同 PreviewCard)。 */
	useEffect(() => {
		if (manual === null) setOpenAuto(autoOpen);
	}, [autoOpen, manual]);
	const toggle = () => {
		setManual(!open);
		setOpenAuto(!open);
	};
	const foldedSummary = !open ? previewFoldSummary(data) : "";
	return (
		<motion.div
			className={auto ? "confirm-card auto" : "confirm-card"}
			initial={EDGE_IN.right}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: DUR.base, ease: EASE.out }}
		>
			{/* 状态改胶囊:待确认 / 已应用(免确认模式) */}
			<button type="button" className="cc-head" aria-expanded={open} onClick={toggle}>
				<span className={`preview-arrow${open ? " open" : ""}`}>
					<Lu icon="chevron-right" size={12} strokeWidth={1.8} />
				</span>
				<span className="cc-title">编剧 · {title}</span>
				{stats && <span className="cc-file">{stats.path}</span>}
				{stats && (
					<span className="cc-counts">
						<span className="add">+{stats.add}</span>
						<span className="del">-{stats.del}</span>
					</span>
				)}
				<span className={`cc-state ${auto ? "applied" : "pending"}`}>
					<span className="cc-state-dot" />
					{auto ? "已应用" : "待确认"}
				</span>
			</button>
			{foldedSummary && <div className="preview-folded-note">{foldedSummary}</div>}
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						key="body"
						className="cc-body"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: DUR.base, ease: EASE.inOut }}
					>
						<PreviewBody data={data} />
					</motion.div>
				)}
			</AnimatePresence>
			{auto ? (
				<div className="cc-actions auto">
					<span className="cc-applied">修改已落盘归档,可随时在会话树里回退</span>
				</div>
			) : (
				<div className="cc-actions">
					<button type="button" className="cc-revert" onClick={onRevert}>
						↩ 回退
					</button>
					<button type="button" className="cc-ok" onClick={onConfirm}>
						✓ 确认
					</button>
				</div>
			)}
		</motion.div>
	);
}
