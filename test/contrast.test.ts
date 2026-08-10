import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "../web/src/themes.ts";

/** 单通道 sRGB → 线性。 */
function linearize(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 相对亮度(0-1)。 */
function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 对比度(1-21)。 */
function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** 从 styles.css :root 读 ink 默认值(替代硬编码回退表)。 */
function rootVar(name: string): string {
	const css = readFileSync("web/src/styles.css", "utf-8");
	const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
	if (!m) throw new Error(`:root 缺少 ${name}`);
	return m[1]!.trim();
}

describe("主题对比度(WCAG)", () => {
	const pairs = [
		["--ink", 7],
		["--muted", 4.5],
		["--faint", 4],
	] as const;
	for (const theme of THEMES) {
		const bg = theme.vars["--bg"] ?? rootVar("--bg"); // ink 的 vars 为空,回退 :root 默认
		for (const [token, min] of pairs) {
			it(`${theme.id}: ${token} 对比度 ≥ ${min}:1`, () => {
				const fg =
					theme.vars[token] ??
					{ "--ink": rootVar("--ink"), "--muted": rootVar("--muted"), "--faint": rootVar("--faint") }[token]!;
				expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
			});
		}
	}

	/** 全屏编辑器「保存并退出」主按钮:琥珀实底 + --bg 文字,浅色主题下也须 ≥4.5:1。
	 *  值与 styles.css 的 [data-theme] .fs-confirm .fs-btn-primary 覆盖一致。 */
	const FS_PRIMARY: Record<string, string> = {
		paper: "#8a5518",
		parchment: "#7d4f16",
	};
	for (const theme of THEMES) {
		const bg = theme.vars["--bg"];
		if (theme.id !== "ink" && bg && FS_PRIMARY[theme.id]) {
			it(`${theme.id}: fs-btn-primary 实底对 --bg 对比度 ≥ 4.5:1`, () => {
				expect(contrast(FS_PRIMARY[theme.id]!, bg)).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});
