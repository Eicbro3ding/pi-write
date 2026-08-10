import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeTheme, THEMES, THEME_TOKENS } from "../web/src/themes.ts";

describe("主题定义", () => {
	it("id 唯一且含 label/desc/swatch", () => {
		const ids = THEMES.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const t of THEMES) {
			expect(t.label.length).toBeGreaterThan(0);
			expect(t.desc.length).toBeGreaterThan(0);
			expect(t.swatch).toHaveLength(3);
		}
	});
	it("非 night 主题覆盖全部 THEME_TOKENS,night 不覆盖(颜色收敛进 :root)", () => {
		const sorted = [...THEME_TOKENS].sort();
		for (const t of THEMES) {
			const keys = Object.keys(t.vars).sort();
			if (t.id === "night") {
				expect(keys).toEqual([]);
			} else {
				expect(keys).toEqual(sorted);
			}
		}
	});
	it("sanitizeTheme:合法值透传,非法/缺省回退 night", () => {
		expect(sanitizeTheme("night")).toBe("night");
		expect(sanitizeTheme("paper")).toBe("paper");
		expect(sanitizeTheme("parchment")).toBe("parchment");
		expect(sanitizeTheme("neon")).toBe("night");
		expect(sanitizeTheme(null)).toBe("night");
		expect(sanitizeTheme(undefined)).toBe("night");
	});
	it("styles.css :root 与 [data-theme] 覆盖块键集一致", () => {
		const css = readFileSync("web/src/styles.css", "utf-8");
		const sorted = [...THEME_TOKENS].sort();
		// :root 块内所有 --xxx 键必须包含 THEME_TOKENS(:root 还允许定义非主题 token,
		// 如圆角/动效/字体栈,故用包含而非全等)
		const root = css.match(/:root\s*\{([^}]*)\}/);
		expect(root).not.toBeNull();
		const rootKeys = new Set([...(root![1]!.matchAll(/--[a-z0-9-]+(?=\s*:)/g))].map((x) => x[0]));
		for (const token of THEME_TOKENS) expect(rootKeys.has(token)).toBe(true);
		// 非默认主题的 [data-theme] 覆盖块键集必须与 THEME_TOKENS 全等
		for (const id of THEMES.filter((t) => t.id !== "night").map((t) => t.id)) {
			const m = css.match(new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
			expect(m, `styles.css 缺少 [data-theme="${id}"] 覆盖块`).not.toBeNull();
			const keys = [...(m![1]!.matchAll(/--[a-z0-9-]+(?=\s*:)/g))].map((x) => x[0]).sort();
			expect(keys).toEqual(sorted);
		}
	});
});
