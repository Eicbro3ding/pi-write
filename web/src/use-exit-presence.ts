import { useEffect, useState } from "react";
import { DUR } from "./motion.ts";

/**
 * 退场延迟卸载:open 变 false 后元素仍保持挂载 `ms` 毫秒,期间返回 `closing=true`,
 * 由 CSS 类 `.is-closing` 播放反向动画(见 styles/presence.css)。
 *
 * 为什么需要:条件挂载的弹层/浮层(`{open && <X/>}`)在 React 卸载的瞬间就没了,
 * 纯 CSS 无从播放退场——这曾是全仓最大的动效缺口(所有弹窗「进场有、出场硬切」)。
 * 用它在父级把「是否渲染」与「是否正在退场」分开:
 *
 *   const { mounted, closing } = useExitPresence(open);
 *   return mounted ? <AddProviderDialog closing={closing} ... /> : null;
 *
 * 系统开启「减少动态效果」时不做无意义的 200ms 等待,直接卸载(CSS 那边也把
 * 退场动画降为 none,见 presence.css 末尾)。
 */
export function useExitPresence(
	open: boolean,
	ms: number = DUR.base * 1000,
): { mounted: boolean; closing: boolean } {
	const [mounted, setMounted] = useState(open);
	const [closing, setClosing] = useState(false);
	useEffect(() => {
		if (open) {
			setMounted(true);
			setClosing(false);
			return;
		}
		// 从未挂载过(初始就是关的):无需退场,也不起定时器
		if (!mounted) return;
		const reduced =
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduced) {
			setMounted(false);
			return;
		}
		setClosing(true);
		const t = window.setTimeout(() => {
			setMounted(false);
			setClosing(false);
		}, ms);
		return () => window.clearTimeout(t);
	}, [open, ms, mounted]);
	return { mounted, closing };
}

/** 把 closing 折进 className(避免每处都写三元)。 */
export function closingClass(base: string, closing: boolean, extra?: string): string {
	return `${base}${extra ? ` ${extra}` : ""}${closing ? " is-closing" : ""}`;
}
