import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isUserTheme, NIGHT_THEME, sanitizeTheme, THEME_TOKENS, themeCssUrl, themeLabelFromCss, userThemeFile } from "../web/src/themes.ts";

/** 解析 CSS 里 :root 块的 token 键集。 */
function rootTokenKeys(css: string): Set<string> {
	const m = css.match(/:root\s*\{([^}]*)\}/);
	if (!m) return new Set();
	return new Set([...(m[1]!.matchAll(/--[a-z0-9-]+(?=\s*:)/g))].map((x) => x[0]));
}

/** 内置主题资产文件清单(零 ts 注册,文件名即主题 id;night 无资产文件)。 */
function builtinThemeFiles(): string[] {
	return readdirSync("web/public/themes").filter((f) => /^[A-Za-z0-9._-]+\.css$/.test(f)).sort();
}

describe("主题定义(资产文件驱动,零 ts 注册)", () => {
	it("每个内置主题 CSS 资产的 :root 恰好覆盖 THEME_TOKENS", () => {
		const sorted = [...THEME_TOKENS].sort();
		const files = builtinThemeFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const css = readFileSync(`web/public/themes/${f}`, "utf-8");
			expect([...rootTokenKeys(css)].sort(), `web/public/themes/${f} 键集`).toEqual(sorted);
		}
	});
	it("styles.css :root 仍包含全部 THEME_TOKENS(night 默认基底)", () => {
		const keys = rootTokenKeys(readFileSync("web/src/styles.css", "utf-8"));
		for (const token of THEME_TOKENS) expect(keys.has(token)).toBe(true);
	});
	it("night 是唯一无资产文件的内置主题", () => {
		expect(builtinThemeFiles()).not.toContain("night.css");
	});
	it("themeLabelFromCss:首行注释取名字,失败回退文件名", () => {
		expect(themeLabelFromCss("/* pi-writer 主题 · 黑白深色(mono-dark) */\n:root{}", "mono-dark.css")).toBe("黑白深色");
		expect(themeLabelFromCss("/* moon */\n:root{}", "moon.css")).toBe("moon");
		expect(themeLabelFromCss(":root{}", "moon.css")).toBe("moon");
	});
	it("NIGHT_THEME 元数据完整", () => {
		expect(NIGHT_THEME.id).toBe("night");
		expect(NIGHT_THEME.label.length).toBeGreaterThan(0);
		expect(NIGHT_THEME.swatch).toHaveLength(3);
	});
	it("sanitizeTheme:night/内置名/user: 透传、非法回退 night", () => {
		expect(sanitizeTheme("night")).toBe("night");
		expect(sanitizeTheme("mono-dark")).toBe("mono-dark");
		expect(sanitizeTheme("morandi")).toBe("morandi");
		expect(sanitizeTheme("user:moon")).toBe("user:moon");
		expect(sanitizeTheme("user:my.theme-1")).toBe("user:my.theme-1");
		expect(sanitizeTheme("neon")).toBe("neon"); // 任何安全内置名都可(文件缺失 404 兜底)
		expect(sanitizeTheme("neon dark")).toBe("night");
		expect(sanitizeTheme("../evil")).toBe("night");
		expect(sanitizeTheme("user:../evil")).toBe("night");
		expect(sanitizeTheme(null)).toBe("night");
		expect(sanitizeTheme(undefined)).toBe("night");
	});
	it("themeCssUrl 形状映射:night→null、内置安全名→/themes/<id>.css、user→/api/themes/<file>.css", () => {
		expect(themeCssUrl("night")).toBeNull();
		expect(themeCssUrl("paper")).toBe("/themes/paper.css");
		expect(themeCssUrl("mono-dark")).toBe("/themes/mono-dark.css");
		expect(themeCssUrl("bogus")).toBe("/themes/bogus.css");
		expect(themeCssUrl("user:moon")).toBe("/api/themes/moon.css");
		expect(themeCssUrl("../evil")).toBeNull();
	});
	it("isUserTheme / userThemeFile 映射", () => {
		expect(isUserTheme("user:moon")).toBe(true);
		expect(isUserTheme("paper")).toBe(false);
		expect(userThemeFile("user:moon")).toBe("moon.css");
		expect(userThemeFile("paper")).toBeNull();
	});
});
