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

/**
 * 回归护栏:中间产物纪律(2026-09-18)。
 *
 * 背景:主提示词原来写着「写在其他任何位置(临时文件、notes/…)用户在界面上都看不见,
 * 等于没写」——那是工作区面板出现之前的事实,却正好卡住工作区「资料与笔记」的唯一
 * 内容来源。改完后必须同时满足两件事,这里把两边都钉住,免得日后被顺手改回去:
 * ① 中间产物(notes/)是允许且被鼓励写的;② 散文落点仍只有当前章节草稿。
 */
describe("中间产物纪律", () => {
	it("写作 agent:允许写 notes/,且保留『散文只进当前章节草稿』硬规则", () => {
		const main = loadPromptText("writer-main.md");
		expect(main).toContain("notes/");
		expect(main).toContain("中间产物");
		// 已废弃的措辞:出现即说明有人把旧规则搬回来了
		expect(main).not.toContain("等于没写");
		// 正文落点硬规则必须还在(2026-08「正文写到 draft/第一章.md、前端读到空」的修复)
		expect(main).toContain("散文只有一个落点");
		expect(main).toContain("draft/<章节id>.md");
		// 不可伪造来源:没有联网检索工具时要向用户要材料
		expect(main).toContain("绝不编造出处");
	});

	it("导演:有资料收集纪律,且明确 notes/ 不进正文、不进世界书", () => {
		const director = loadPromptText("director.md");
		expect(director).toContain("资料收集纪律");
		expect(director).toContain("notes/");
		expect(director).toContain("不进正文、也不写进世界书");
	});

	it("常驻编剧不承担资料收集:提示词里不出现 notes/", () => {
		expect(loadPromptText("writer-editor.md")).not.toContain("notes/");
	});
});
