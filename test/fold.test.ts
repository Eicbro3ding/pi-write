import { describe, expect, it } from "vitest";
import { collapsedText, countLines, FOLD_COLLAPSED_LINES, FOLD_SHORT_MAX, foldLabel, isFoldable } from "../web/src/fold.ts";

/** 造 n 行的文本。 */
function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `第 ${i + 1} 行`).join("\n");
}

describe("长内容折叠分档(03-组件规范/04)", () => {
	it("countLines:空文本 0 行,单行 1 行", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a")).toBe(1);
		expect(countLines("a\nb")).toBe(2);
	});
	it("短档(≤12 行)不折叠", () => {
		expect(isFoldable(FOLD_SHORT_MAX)).toBe(false);
		expect(isFoldable(1)).toBe(false);
		expect(isFoldable(0)).toBe(false);
	});
	it("中档/长档(>12 行)折叠", () => {
		expect(isFoldable(13)).toBe(true);
		expect(isFoldable(120)).toBe(true);
	});
	it("折叠态只保留前 12 行", () => {
		const text = lines(30);
		const shown = collapsedText(text).split("\n");
		expect(shown).toHaveLength(FOLD_COLLAPSED_LINES);
		expect(shown[0]).toBe("第 1 行");
		expect(shown[11]).toBe("第 12 行");
	});
	it("不足 12 行时原样返回", () => {
		expect(collapsedText(lines(5))).toBe(lines(5));
	});
	it("展开入口文案带总行数", () => {
		expect(foldLabel(28)).toBe("展开全部(共 28 行)");
		expect(foldLabel(120)).toBe("展开全部(共 120 行)");
	});
});
