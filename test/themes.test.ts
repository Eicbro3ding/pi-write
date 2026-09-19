import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildThemeFamilies, isUserTheme, NIGHT_THEME, sanitizeTheme, swatchFromCss, THEME_TOKENS, themeCssUrl, themeFamilyPick, themeLabelFromCss, userThemeFile } from "../web/src/themes.ts";

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

/** 造一份最简主题 CSS:三色 swatch 可辨。 */
function fakeTheme(bg: string, amber: string, ink: string): string {
	return `/* pi-writer 主题 · 陪跑(${bg}) */\n:root { --bg: ${bg}; --amber: ${amber}; --ink: ${ink}; }\n`;
}

describe("主题家族:浅深合并(03-组件规范/02)", () => {
	const builtin = [
		{ file: "mono-dark.css", css: fakeTheme("#0c0c0e", "#9ca3af", "#d4d4d8") },
		{ file: "mono.css", css: fakeTheme("#f5f5f4", "#171717", "#1a1a1a") },
		{ file: "paper.css", css: fakeTheme("#f4f0e8", "#9a6524", "#26221c") },
	];
	const user = [
		{ file: "moon-dark.css", css: fakeTheme("#101014", "#c9b8ff", "#e8e6f0") },
		{ file: "moon.css", css: fakeTheme("#f6f6fb", "#5b4b9e", "#1c1a26") },
	];

	it("同族浅深合成一张:night 领头、组内浅色在前、只有深色的族 dark 为 null", () => {
		const fams = buildThemeFamilies(builtin, user);
		expect(fams.map((f) => f.key)).toEqual(["night", "mono", "paper", "moon"]);
		expect(fams[0]!.light.id).toBe("night");
		expect(fams[0]!.dark).toBeNull();
		expect(fams[1]!.light.id).toBe("mono");
		expect(fams[1]!.dark?.id).toBe("mono-dark");
		expect(fams[2]!.light.id).toBe("paper");
		expect(fams[2]!.dark).toBeNull();
		// 用户主题同规则(user: 前缀不参与配对)
		expect(fams[3]!.light.id).toBe("user:moon");
		expect(fams[3]!.dark?.id).toBe("user:moon-dark");
	});

	it("家族名去掉结尾的浅色/深色,不重复标注", () => {
		const fams = buildThemeFamilies(
			[{ file: "solo.css", css: "/* pi-writer 主题 · 纸上书房浅色(solo) */\n:root{}" }],
			[],
		);
		expect(fams.find((f) => f.key === "solo")!.label).toBe("纸上书房");
	});

	it("落点:未选中取浅色;再点已选中浅⇄深;单变体家族不响应", () => {
		const fams = buildThemeFamilies(builtin, user);
		const mono = fams.find((f) => f.key === "mono")!;
		const paper = fams.find((f) => f.key === "paper")!;
		const night = fams[0]!;
		expect(themeFamilyPick(mono, "paper")).toBe("mono"); // 点未选中 → 浅色
		expect(themeFamilyPick(mono, "mono")).toBe("mono-dark"); // 再点 → 深色
		expect(themeFamilyPick(mono, "mono-dark")).toBe("mono"); // 再点 → 浅色
		expect(themeFamilyPick(paper, "paper")).toBe("paper"); // 单变体不响应
		expect(themeFamilyPick(night, "night")).toBe("night");
		expect(themeFamilyPick(night, "paper")).toBe("night");
	});

	it("swatchFromCss 抽三色,缺 token 回退中性色", () => {
		expect(swatchFromCss(fakeTheme("#111111", "#222222", "#333333"))).toEqual(["#111111", "#222222", "#333333"]);
		expect(swatchFromCss(":root{}")).toEqual(["#141414", "#d9a84e", "#e8e6e1"]);
	});
});
