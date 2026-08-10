import type { Transition } from "framer-motion";

/** 动效时长(s):fast=按压/微小反馈,base=页面切换/消息入场/状态过渡,slow=抽屉滑入滑出。 */
export const DUR = { fast: 0.14, base: 0.2, slow: 0.32 } as const;

const OUT = [0.22, 1, 0.36, 1] as [number, number, number, number];
const INOUT = [0.4, 0, 0.2, 1] as [number, number, number, number];

/** 缓动曲线:out=所有入场(快而稳),inOut=状态双向变化。 */
export const EASE = { out: OUT, inOut: INOUT };

/** 消息/列表交错间隔(s)。 */
export const STAGGER = 0.04;

/** 边缘水平滑入偏移(px),与 styles.css 的 slide-in-left/right keyframes 同值。
 *  贴屏幕边缘的容器统一从「最近边缘」滑入:左缘容器 EDGE_IN.left(自左滑入),
 *  右缘容器 EDGE_IN.right(自右滑入)。 */
export const EDGE_SLIDE = 8;
export const EDGE_IN = {
	left: { opacity: 0, x: -EDGE_SLIDE },
	right: { opacity: 0, x: EDGE_SLIDE },
} as const;

/** 常用 Transition 快捷值(与 CSS 变量同源同值)。 */
export const T: Record<"base" | "slow", Transition> = {
	base: { duration: DUR.base, ease: EASE.out },
	slow: { duration: DUR.slow, ease: EASE.out },
};
