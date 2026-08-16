/**
 * `/` 命令注册表单测:解析、搜索评分、注入文本、章节按需读取。
 * 纯 node 测试(不挂载 DOM),fake ApiClient 只实现被调用方法。
 */
import { describe, expect, it } from "vitest";
import {
	makeChapterCommand,
	makeCompactCommand,
	makeNodeCommand,
	parseSlashQuery,
	scoreWorldEntry,
	worldEntryInsertText,
} from "../web/src/slash-commands.ts";
import type { SlashContext } from "../web/src/slash-commands.ts";
import type { WorldEntryDto } from "../web/src/types.ts";

function entry(over: Partial<WorldEntryDto>): WorldEntryDto {
	return {
		id: "chr-linwan",
		type: "character",
		title: "林婉",
		keys: ["雾港", "灯塔"],
		chapters: [],
		status: "alive",
		active: true,
		parent: null,
		tags: [],
		body: "灯塔看守人的女儿。",
		avatar: null,
		images: [],
		updatedAt: 1,
		...over,
	};
}

const ctx = {
	client: { getDraft: async () => ({ text: "", mtime: 0 }) },
	slug: "fog-harbor",
	bookDetail: { slug: "fog-harbor", title: "雾港", currentChapterFile: "ch01.jsonl", chapters: [{ id: "ch01", file: "ch01.jsonl", title: "第一章", label: null, exists: true }] },
	currentChapterFile: "ch01.jsonl",
} as unknown as SlashContext;

describe("parseSlashQuery", () => {
	it("句尾 `/node 林婉` → trigger/term 与整段替换区间", () => {
		expect(parseSlashQuery("/node 林婉", 8)).toEqual({ trigger: "node", term: "林婉", start: 0, end: 8 });
	});
	it("只输入 `/` → trigger 为空(展示全部命令)", () => {
		expect(parseSlashQuery("/", 1)).toEqual({ trigger: "", term: "", start: 0, end: 1 });
	});
	it("光标在命令名中间时只认已输入部分", () => {
		expect(parseSlashQuery("/nod", 4)).toEqual({ trigger: "nod", term: "", start: 0, end: 4 });
	});
	it("非命令文本不触发", () => {
		expect(parseSlashQuery("https://example.com/x", 10)).toBeNull();
		expect(parseSlashQuery("正文 / 后面", 3)).toBeNull();
	});
	it("命令前有其他文本时区间只覆盖命令 token", () => {
		const text = "帮我看下 /chapter ch02";
		expect(parseSlashQuery(text, text.length)).toEqual({ trigger: "chapter", term: "ch02", start: 5, end: text.length });
	});
});

describe("世界条目搜索与注入", () => {
	it("标题命中排在 body 命中之前;注入块含类型与完整 body", () => {
		expect(scoreWorldEntry(entry({}), "林")).toBeGreaterThan(scoreWorldEntry(entry({ title: "灯塔" }), "林"));
		expect(worldEntryInsertText(entry({}))).toBe("【世界书 · 人物 · 林婉】\n灯塔看守人的女儿。");
	});
	it("makeNodeCommand 按 slug 加载世界书并返回前 N 条", async () => {
		const world = { entries: [entry({}), entry({ id: "chr-lita", title: "灯塔" })] };
		const cmd = makeNodeCommand({ loadWorld: async () => world as never });
		const items = await cmd.search!("林", { ...ctx, slug: "fog-harbor" });
		expect(items).toHaveLength(1);
		expect(items[0].label).toContain("林婉");
		expect(items[0].insertText).toContain("灯塔看守人的女儿。");
	});
	it("无书 / 读取失败返回空候选项", async () => {
		const cmd = makeNodeCommand({ loadWorld: async () => null });
		expect(await cmd.search!("林", { ...ctx, slug: null })).toEqual([]);
	});
});

describe("章节原文命令", () => {
	it("按 id/标题过滤,选中时按需读草稿并带路径标签", async () => {
		const client = { getDraft: async (file: string) => ({ text: "夜航。", mtime: 1 }) };
		const c = { ...ctx, client } as unknown as SlashContext;
		const cmd = makeChapterCommand();
		const items = await cmd.search!("ch01", c);
		expect(items).toHaveLength(1);
		expect(items[0].hint).toBe("draft/ch01.md");
		const text = await items[0].loadText!(c);
		expect(text).toBe("【原文 · ch01《第一章》 · draft/ch01.md】\n夜航。");
	});
	it("空章节给出明确空正文标签", async () => {
		const c = { ...ctx, client: { getDraft: async () => ({ text: "  ", mtime: 0 }) } } as unknown as SlashContext;
		const items = await makeChapterCommand().search!("ch01", c);
		expect(await items[0].loadText!(c)).toContain("（该章正文为空）");
	});
});

describe("compact 动作命令", () => {
	it("term 作为附加要求传给动作", async () => {
		const calls: string[] = [];
		const cmd = makeCompactCommand({ run: async (s) => calls.push(s) });
		await cmd.run!("保留最近的冲突", {} as SlashContext);
		expect(calls).toEqual(["保留最近的冲突"]);
	});
});
