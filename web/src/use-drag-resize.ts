/**
 * 横向拖拽调宽 —— ChapterSidebar / WritePage 伙伴栏 / StagePage 右面板三处共用
 * (原三份「window mousemove/mouseup」实现逐字相同,2026-08 收敛)。
 * 增量方向由 dir 指定:+1 常规(随鼠标右移变宽,左栏);-1 反向(右侧栏:左移变宽)。
 * 相比原实现补了卸载清理:拖拽中组件卸载不再泄漏 window 监听。
 */
import { useCallback, useEffect, useRef } from "react";

export function useDragResize(opts: {
	min: number;
	max: number;
	/** 拖拽起点基准宽度(按下瞬间的当前值)。 */
	getValue: () => number;
	onChange: (w: number) => void;
	/** 增量方向:+1 常规(右移变宽);-1 反向(右侧栏:左移变宽)。缺省 +1。 */
	dir?: 1 | -1;
	/** 拖拽开始/结束回调(如侧栏 resizing 状态)。 */
	onStart?: () => void;
	onEnd?: () => void;
}): (e: React.MouseEvent) => void {
	const optsRef = useRef(opts);
	optsRef.current = opts;
	/** 当前挂载的 window 监听(卸载时清理)。 */
	const listenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);

	const stop = useCallback(() => {
		const l = listenersRef.current;
		if (!l) return;
		window.removeEventListener("mousemove", l.move);
		window.removeEventListener("mouseup", l.up);
		document.body.style.cursor = "";
		listenersRef.current = null;
	}, []);

	// 卸载时清理可能残留的监听(拖拽中组件卸载)
	useEffect(() => stop, [stop]);

	return useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			const { min, max, dir = 1, onChange, onStart, onEnd } = optsRef.current;
			const startX = e.clientX;
			const startW = optsRef.current.getValue();
			stop(); // 防御:重复按下先清旧监听
			const move = (ev: MouseEvent) => {
				onChange(Math.max(min, Math.min(max, startW + (ev.clientX - startX) * dir)));
			};
			const up = () => {
				stop();
				onEnd?.();
			};
			listenersRef.current = { move, up };
			onStart?.();
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
			document.body.style.cursor = "col-resize";
		},
		[stop],
	);
}
