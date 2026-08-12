import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { loadPromptText, renderPrompt, resolvePromptsDir } from "../src/prompts.ts";

describe("prompts 外置加载器", () => {
	it("resolvePromptsDir 解析到仓库根 prompts/", () => {
		const dir = resolvePromptsDir({});
		expect(dir.endsWith("prompts")).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});
	it("loadPromptText 读到主会话提示词本体", () => {
		const text = loadPromptText("writer-main.md");
		expect(text).toContain("你是 pi-writer");
		expect(text).toContain("{SHELL_LINE}");
	});
	it("7 个提示词文件全部存在", () => {
		for (const f of ["writer-main.md", "writer-editor.md", "director.md", "actor.md", "narrator.md", "writer-scene.md", "script-method.md"]) {
			expect(existsSync(`${resolvePromptsDir({})}/${f}`), f).toBe(true);
		}
	});
	it("缺失文件抛错(提示词是必需品,fail fast)", () => {
		expect(() => loadPromptText("not-exist.md")).toThrow(/提示词文件缺失/);
	});
});

describe("renderPrompt 占位渲染", () => {
	it("替换已知键,未提供键原样保留", () => {
		expect(renderPrompt("a {X} b {UNKNOWN} c", { X: "1" })).toBe("a 1 b {UNKNOWN} c");
	});
});
