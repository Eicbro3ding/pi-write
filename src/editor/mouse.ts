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
