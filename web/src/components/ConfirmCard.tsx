import { motion } from "framer-motion";
import type { PreviewData } from "../preview.ts";
import type { WorldDataDto } from "../types.ts";
import { DUR, EASE, EDGE_IN } from "../motion.ts";
import { PreviewBody } from "./PreviewCard.tsx";

/** 待确认的编剧编辑卡:before = 编辑前基线(「回退」写回用),data = 预览渲染数据,
 *  anchorId = 触发它的 assistant 消息 id(实时随机 id 或水合后 entryId,与预览卡同规则);
 *  auto = 免确认模式(设置页开关):编辑落盘即归档,卡片只读展示「已应用」。 */
export interface ConfirmCardItem {
	id: string;
	kind: "draft" | "world";
	path: string | null;
	before: string | WorldDataDto;
	data: PreviewData;
	anchorId: string | null;
	auto?: boolean;
}

/**
 * 编剧编辑确认卡:diff 预览(复用 PreviewBody,与主会话预览卡同一渲染)+
 * 确认/回退。回退由调用方执行(写回编辑前状态)。
 * 嵌入编剧对话流,锚定在触发编辑的 assistant 消息下(与原对话侧边栏
 * 预览卡同一设计);入场:右缘列容器从右侧水平滑入。
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
				: data.kind === "script"
					? "剧本确认"
					: data.mode === "graph"
						? "更新世界树"
						: "更新词条";
	const firstPath = data.kind === "draft" && !("error" in data) ? data.sections[0]?.path : undefined;
	return (
		<motion.div
			className={auto ? "confirm-card auto" : "confirm-card"}
			initial={EDGE_IN.right}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: DUR.base, ease: EASE.out }}
		>
			{/* 状态改胶囊(设计稿 03-组件规范/03):待确认 / 已应用(免确认模式) */}
			<div className="cc-head">
				<span className="cc-title">编剧 · {title}</span>
				{firstPath && <span className="cc-file">{firstPath}</span>}
				<span className={`cc-state ${auto ? "applied" : "pending"}`}>
					<span className="cc-state-dot" />
					{auto ? "已应用" : "待确认"}
				</span>
			</div>
			<div className="cc-body">
				<PreviewBody data={data} />
			</div>
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
