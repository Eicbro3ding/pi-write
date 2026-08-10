import { describe, expect, it } from "vitest";
import { buildChapterContext, DEFAULT_CONTEXT_BUDGET, estimateTokens, activatedEntryIds, trimMemory } from "../src/world-context.ts";
import { createEmptyWorld, type WorldData } from "../src/world-data.ts";

function worldWith(...titles: Array<{ title: string; type: "character" | "world" | "timeline" | "outline"; keys?: string[]; chapters?: string[] }>): WorldData {
	const w = createEmptyWorld();
	titles.forEach((t, i) => {
		w.entries.push({
			id: `e${i}`, type: t.type, title: t.title, keys: t.keys ?? [], chapters: t.chapters ?? [],
			status: "active", active: true, parent: null, tags: [], body: `${t.title}的正文`, updatedAt: 0,
		});
	});
	return w;
}

describe("estimateTokens", () => {
	it("CJK 每字 1 token,英文按 4 字符 1 token", () => {
		expect(estimateTokens("你好世界")).toBe(4);
		expect(estimateTokens("hello")).toBeGreaterThanOrEqual(1);
	});
});

describe("activatedEntryIds", () => {
	it("按 keys 命中草稿激活", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉", "婉姐"] }, { title: "无关", type: "world" });
		const ids = activatedEntryIds(w, { chapterId: "ch01", draftText: "林婉推开门。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(ids).toContain("e0");
		expect(ids).not.toContain("e1");
	});
	it("chapters 不匹配当前章则跳过", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"], chapters: ["ch01"] });
		const ids = activatedEntryIds(w, { chapterId: "ch02", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(ids).not.toContain("e0");
	});
	it("无 keys 的条目不激活", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		const ids = activatedEntryIds(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(ids).toEqual([]);
	});
	it("命中最近用户消息也激活", () => {
		const w = worldWith({ title: "林家", type: "world", keys: ["林家"] });
		const ids = activatedEntryIds(w, { chapterId: "ch01", draftText: "", recentUserMessages: ["把林家老宅写进去"], budget: DEFAULT_CONTEXT_BUDGET });
		expect(ids).toContain("e0");
	});
	it("active=false 的条目跳过", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.entries[0]!.active = false;
		const ids = activatedEntryIds(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(ids).toEqual([]);
	});
});

describe("buildChapterContext", () => {
	it("背景包包含激活组/约束/采样/Notice/发展线", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		w.styleSample = { text: "雨落青瓦。", source: "draft/ch01.md", updatedAt: 0 };
		w.notice.text = "保持悬疑。";
		w.storyline.nodes.push({ id: "n1", title: "第四章", status: "in-progress", goal: "真相浮出", next: "写宴前对峙" });
		const r = buildChapterContext(w, { chapterId: "ch04", draftText: "林婉走进来。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text).toContain("林婉");
		expect(r.text).toContain("对话不用引号");
		expect(r.text).toContain("雨落青瓦");
		expect(r.text).toContain("保持悬疑");
		expect(r.text).toContain("真相浮出");
		expect(r.text).toContain("写宴前对峙");
	});
	it("禁用约束与关闭开关不进背景包", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: false });
		w.notice.enabled = false;
		w.storyline.enabled = false;
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text).not.toContain("对话不用引号");
		expect(r.text).not.toContain("保持悬疑");
		expect(r.included.storylineNode).toBeNull();
	});
	it("超预算先裁采样(约束保留)", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 100 });
		expect(r.included.hasSample).toBe(false);
		expect(r.included.constraints).toEqual(["对话风格"]);
		expect(r.text).toContain("对话不用引号");
		expect(r.text).not.toContain("文风采样");
	});
	it("超预算按序裁剪激活组并计数", () => {
		const w = createEmptyWorld();
		for (let i = 0; i < 5; i++) {
			w.entries.push({ id: `e${i}`, type: "character", title: `角色${i}`, keys: [`角色${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", updatedAt: 0 });
		}
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "角色0 角色1 角色2 角色3 角色4", recentUserMessages: [], budget: 15 });
		expect(r.activatedIds.length).toBeLessThan(5);
		expect(r.trimmedCount).toBeGreaterThan(0);
		expect(r.text).toContain("已裁剪");
	});
	it("全关时背景包为空", () => {
		const w = createEmptyWorld();
		w.notice.enabled = false;
		w.storyline.enabled = false;
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "任意", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text.trim()).toBe("");
	});
	it("memory 注入渲染在最前,空 memory 不出现该段", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], memory: "第四章完成:林婉得知身世。\n\n沈望海失踪。", budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text.indexOf("【记忆】")).toBeLessThan(r.text.indexOf("林婉"));
		expect(r.text).toContain("第四章完成:林婉得知身世。");
		const r2 = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], memory: "", budget: DEFAULT_CONTEXT_BUDGET });
		expect(r2.text).not.toContain("【记忆】");
	});
});

describe("trimMemory", () => {
	it("预算内原样返回(去首尾空白)", () => {
		expect(trimMemory("  要点一。\n\n要点二。\n")).toBe("要点一。\n\n要点二。");
	});
	it("空文本返回空串", () => {
		expect(trimMemory("")).toBe("");
		expect(trimMemory("  \n ")).toBe("");
	});
	it("超预算从最旧段落开始裁(保留顶部最新),尾部注明", () => {
		const blocks = Array.from({ length: 30 }, (_, i) => `要点${i}:${"字".repeat(20)}`);
		const r = trimMemory(blocks.join("\n\n"), 100);
		expect(r).toContain("要点0");
		expect(r).not.toContain("要点29");
		expect(r).toContain("已截断");
	});
	it("单段超预算时硬截断并注明", () => {
		const r = trimMemory("字".repeat(5000), 100);
		expect(r).toContain("已截断");
		expect(estimateTokens(r)).toBeLessThan(5000);
	});
});
