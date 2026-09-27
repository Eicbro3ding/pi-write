/**
 * 手机端页头(设计稿 ★移动版,52px)。
 *
 * 桌面端每页有自己的页头(paper-head / w-bar / stage-head),手机端统一成这一条:
 * 左「主导操作」、中「标题 + 状态行」、右「图标按钮组」。只在 ≤700px 渲染
 * (由页面用 useIsPhone 决定),因此不需要额外的 CSS 隐藏规则。
 *
 * 尺寸照设计稿:Padding [0,10]、gap 6、图标按钮 34×34、图标 18、标题 14/600、
 * 状态行 11 + 6px 圆点;强调态按钮 = amber-tint 底 + amber 图标。
 */
import type { ReactNode } from "react";
import { Lu, type LucideName } from "./Lu.tsx";

export interface MobileHeaderAction {
	key: string;
	icon: LucideName;
	/** 无障碍名(也是长按 title)。 */
	label: string;
	onPress: () => void;
	/** 强调态(设计稿里「伙伴」按钮的琥珀底)。 */
	accent?: boolean;
	/** 角标数字(待确认编辑数)。 */
	badge?: number;
	/** 生成中指示点。 */
	live?: boolean;
}

/** 状态行圆点色:已保存=绿、保存中=琥珀、出错=红,与顶栏 stat 同一套语义。 */
export type MobileHeaderTone = "ok" | "busy" | "err" | "idle";

const TONE_VAR: Record<MobileHeaderTone, string> = {
	ok: "var(--green)",
	busy: "var(--amber)",
	err: "var(--red)",
	idle: "var(--line-strong)",
};

export function MobileHeader({
	leading,
	title,
	subtitle,
	tone = "idle",
	actions = [],
	children,
}: {
	/** 左端主导操作(☰ 打开抽屉 / ← 返回);省略则不留位。 */
	leading?: { icon: LucideName; label: string; onPress: () => void };
	title: ReactNode;
	/** 副行文字;与 tone 圆点同排(设计稿「已保存 · 1,284 字」)。 */
	subtitle?: ReactNode;
	tone?: MobileHeaderTone;
	actions?: MobileHeaderAction[];
	/** 顶部附加内容(如世界书页的搜索框 + 筛选chips),渲染在页头之下。 */
	children?: ReactNode;
}) {
	return (
		<div className="m-head-wrap">
			<div className="m-head">
				{leading && (
					<button type="button" className="m-icon-btn" aria-label={leading.label} onClick={leading.onPress}>
						<Lu icon={leading.icon} size={18} />
					</button>
				)}
				<div className="m-head-title">
					<span className="m-head-name">{title}</span>
					{subtitle != null && (
						<span className="m-head-sub">
							<i className="m-dot" style={{ background: TONE_VAR[tone] }} />
							<span className="m-head-sub-text">{subtitle}</span>
						</span>
					)}
				</div>
				{actions.map((a) => (
					<button
						key={a.key}
						type="button"
						className={a.accent ? "m-icon-btn accent" : "m-icon-btn"}
						aria-label={a.label}
						title={a.label}
						onClick={a.onPress}
					>
						<Lu icon={a.icon} size={18} />
						{a.badge != null && a.badge > 0 && <span className="m-badge">{a.badge}</span>}
						{a.live && <span className="m-live" />}
					</button>
				))}
			</div>
			{children}
		</div>
	);
}
