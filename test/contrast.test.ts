import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

/** 从 CSS 文本读取某个 token 值(主题 CSS 均为 :root 单行 token)。 */
function varOf(css: string, name: string): string {
	const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
	if (!m) throw new Error(`主题 CSS 缺少 ${name}`);
	return m[1]!.trim();
}

/** 内置主题资产文件清单(零 ts 注册;night 无资产文件,单独测 styles.css 基底)。 */
function builtinThemeFiles(): string[] {
	return readdirSync("web/public/themes").filter((f) => /^[A-Za-z0-9._-]+\.css$/.test(f)).sort();
}

describe("主题对比度(WCAG)", () => {
	const pairs = [
		["--ink", 7],
		["--muted", 4.5],
		["--faint", 4],
	] as const;
	for (const file of builtinThemeFiles()) {
		const css = readFileSync(`web/public/themes/${file}`, "utf-8");
		const bg = varOf(css, "--bg");
		for (const [token, min] of pairs) {
			it(`${file}: ${token} 对比度 ≥ ${min}:1`, () => {
				expect(contrast(varOf(css, token), bg)).toBeGreaterThanOrEqual(min);
			});
		}
		/** 全屏编辑器主按钮实底对 --bg 须 ≥4.5:1。文件内带 .fs-confirm .fs-btn-primary
		 *  覆盖(paper/parchment)取其值,否则取 --amber(基础规则 background: var(--amber))。 */
		it(`${file}: fs-btn-primary 实底对 --bg 对比度 ≥ 4.5:1`, () => {
			const m = css.match(/\.fs-confirm \.fs-btn-primary\s*{[^}]*?background:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s*;/);
			const primary = m ? m[1]! : varOf(css, "--amber");
			expect(contrast(primary, bg)).toBeGreaterThanOrEqual(4.5);
		});
	}

	/** night 基底(styles.css :root)。 */
	const night = readFileSync("web/src/styles.css", "utf-8");
	const nightBg = varOf(night, "--bg");
	for (const [token, min] of pairs) {
		it(`night(styles.css): ${token} 对比度 ≥ ${min}:1`, () => {
			expect(contrast(varOf(night, token), nightBg)).toBeGreaterThanOrEqual(min);
		});
	}
});
