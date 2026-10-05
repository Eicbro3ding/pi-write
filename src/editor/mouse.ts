/**
 * SGR mouse protocol support for the built-in editor.
 *
 * Terminal mouse reporting is opt-in: the editor enables
 * 1000 (click), 1002 (drag), 1003 (any motion, for reliable drag on
 * Windows Terminal), and 1006 (SGR encoding) while open and
 * disables them again on close. Sequences arrive as normal terminal
 * input of the form ESC [ < button ; x ; y M (press/drag) or m (release).
 */

export const MOUSE_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const MOUSE_DISABLE_SEQUENCE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type SgrMouseButton = "left" | "middle" | "right" | "none";

export interface SgrMouseEvent {
	kind: "press" | "drag" | "release" | "wheel";
	button: SgrMouseButton;
	/** 1-based terminal column. */
	x: number;
	/** 1-based terminal row. */
	y: number;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
	/** Wheel direction: -1 up, 1 down. 0 for non-wheel events. */
	delta: number;
}

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Parse one SGR mouse sequence, or undefined when the input is not a mouse event. */
export function parseSgrMouse(sequence: string): SgrMouseEvent | undefined {
	const match = SGR_MOUSE_RE.exec(sequence);
	if (!match) return undefined;

	const code = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const isRelease = match[4] === "m";
	const isWheel = (code & 64) !== 0;
	const isMotion = (code & 32) !== 0;
	const buttonCode = code & 3;

	let button: SgrMouseButton = "none";
	if (!isWheel) {
		button = buttonCode === 0 ? "left" : buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : "none";
	}

	let kind: SgrMouseEvent["kind"];
	let delta = 0;
	if (isWheel) {
		kind = "wheel";
		delta = buttonCode === 1 ? 1 : -1;
	} else if (isRelease) {
		kind = "release";
	} else if (isMotion) {
		kind = "drag";
	} else {
		kind = "press";
	}

	return {
		kind,
		button,
		x,
		y,
		shift: (code & 4) !== 0,
		ctrl: (code & 16) !== 0,
		alt: (code & 8) !== 0,
		delta,
	};
}

/**
 * 上游鼠标事件的形状（pi-tui 归一化事件的一个最小投影）。
 *
 * 只声明本适配器真正读取的字段，不 import 上游类型 —— 这样上游若增删字段，
 * 编译不会因为我们多声明了一个用不上的字段而失败。
 */
export interface UpstreamMouseEvent {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: SgrMouseButton;
	/** 0-based，组件局部坐标。 */
	x: number;
	y: number;
	/** 滚轮方向（逻辑行，向上为负）。仅 wheel 事件有值。 */
	wheelDelta?: number;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
}

/**
 * 把上游的归一化鼠标事件折算成本编辑器内部使用的 {@link SgrMouseEvent}。
 *
 * 存在这层适配是因为两条鼠标链路的历史差异：
 * - 自研链路：终端 SGR 序列 → {@link parseSgrMouse}，坐标 **1-based**，
 *   滚轮方向放在 `delta`（-1 上 / 1 下），事件种类叫 `kind`。
 * - 上游链路：组件 `handleMouse(event: TuiMouseEvent)`，坐标 **0-based**，
 *   滚轮幅度放在 `wheelDelta`（向上为负），事件种类叫 `type`。
 *
 * 本函数把上游事件**归一化回自研形状**（含把坐标 +1 还原为 1-based），
 * 使 `DraftEditorPanel` / `VimFileEditor` 的内部几何计算一行都不用改。
 *
 * 字段映射：
 * - `type` → `kind`：`click` 归为 `press`（内部只关心按下）；`move` 归为 `drag`
 *   （编辑器只在自己接管输入时才收到，语义等同于拖动）。
 * - `wheelDelta` → `delta`：取其符号（向上为负 → -1，向下为正 → 1）；
 *   为 0 或缺失时按向下滚动处理，与原 `parseSgrMouse` 的缺省一致。
 */
export function sgrMouseFromUpstream(event: UpstreamMouseEvent): SgrMouseEvent {
	let kind: SgrMouseEvent["kind"];
	switch (event.type) {
		case "wheel":
			kind = "wheel";
			break;
		case "release":
			kind = "release";
			break;
		case "drag":
		case "move":
			kind = "drag";
			break;
		default:
			// press / click —— 内部只区分「按下」。
			kind = "press";
			break;
	}

	let delta = 0;
	if (kind === "wheel") {
		delta = (event.wheelDelta ?? 0) > 0 ? 1 : -1;
	}

	return {
		kind,
		button: event.button,
		// 上游是 0-based 组件局部坐标；还原成 1-based，与 parseSgrMouse 对齐。
		x: event.x + 1,
		y: event.y + 1,
		shift: event.shift,
		ctrl: event.ctrl,
		alt: event.alt,
		delta,
	};
}
