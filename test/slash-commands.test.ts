/**
 * `/` 命令注册表单测:解析、搜索评分、注入文本、章节按需读取。
 * 纯 node 测试(不挂载 DOM),fake ApiClient 只实现被调用方法。
 */
import { describe, expect, it } from "vitest";
import {
	composeMessageWithAttachments,
	keepSlashIndex,
	makeChapterCommand,
	makeCompactCommand,
	makeNodeCommand,
	makePluginCommand,
	parseAtQuery,
	parseSlashQuery,
	scoreWorldEntry,
	slashArrowMove,
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

describe("parseAtQuery", () => {
	it("行首 `@灯` → term 与替换区间", () => {
		expect(parseAtQuery("@灯", 2)).toEqual({ term: "灯", start: 0, end: 2 });
	});
	it("文本中间也触发(设计稿:在文本任何位置可用)", () => {
		const text = "把@灯";
		expect(parseAtQuery(text, text.length)).toEqual({ term: "灯", start: 1, end: text.length });
	});
	it("中文/标点紧贴 @ 不拦(只有 ASCII 字母数字才算邮箱)", () => {
		const text = "，@灯";
		expect(parseAtQuery(text, text.length)).toEqual({ term: "灯", start: 1, end: text.length });
	});
	it("邮箱不触发", () => {
		expect(parseAtQuery("a@b.com", 7)).toBeNull();
		expect(parseAtQuery("user1@x", 8)).toBeNull();
	});
	it("@ 到光标之间出现空白即认为查询结束", () => {
		expect(parseAtQuery("@灯 塔", 4)).toBeNull();
	});
	it("没有 @ / 光标在 @ 之前 → null", () => {
		expect(parseAtQuery("正文", 2)).toBeNull();
		expect(parseAtQuery("@灯", 0)).toBeNull();
	});
	it("@ 在换行后照样触发", () => {
		const text = "第一段\n@灯";
		expect(parseAtQuery(text, text.length)).toEqual({ term: "灯", start: 4, end: text.length });
	});
});

describe("世界条目搜索与注入", () => {
	it("标题命中排在 body 命中之前;注入块含类型与完整 body", () => {
		expect(scoreWorldEntry(entry({}), "林")).toBeGreaterThan(scoreWorldEntry(entry({ title: "灯塔" }), "林"));
		expect(worldEntryInsertText(entry({}))).toBe("【世界书 · 人物 · 林婉】\n灯塔看守人的女儿。");
	});
	it("makeNodeCommand 按 slug 加载世界书并返回前 N 条(引用芯片,发送时展开)", async () => {
		const world = { entries: [entry({}), entry({ id: "chr-lita", title: "灯塔" })] };
		const cmd = makeNodeCommand({ loadWorld: async () => world as never });
		const items = await cmd.search!("林", { ...ctx, slug: "fog-harbor" });
		expect(items).toHaveLength(1);
		expect(items[0].label).toContain("林婉");
		// 内容命令迁移到 attachment 芯片:不再整段塞进输入框
		expect(items[0].insertText).toBeUndefined();
		expect(items[0].attachment!.label).toBe("林婉");
		expect(await items[0].attachment!.loadText(ctx)).toContain("灯塔看守人的女儿。");
	});
	it("无书 / 读取失败返回空候选项", async () => {
		const cmd = makeNodeCommand({ loadWorld: async () => null });
		expect(await cmd.search!("林", { ...ctx, slug: null })).toEqual([]);
	});
});

describe("章节原文命令", () => {
	it("按 id/标题过滤,选中挂引用芯片(标题+路径),发送时按需读草稿", async () => {
		const client = { getDraft: async (file: string) => ({ text: "夜航。", mtime: 1 }) };
		const c = { ...ctx, client } as unknown as SlashContext;
		const cmd = makeChapterCommand();
		const items = await cmd.search!("ch01", c);
		expect(items).toHaveLength(1);
		expect(items[0].hint).toBe("draft/ch01.md");
		expect(items[0].attachment!.label).toBe("ch01《第一章》");
		expect(items[0].attachment!.detail).toBe("draft/ch01.md");
		const text = await items[0].attachment!.loadText!(c);
		expect(text).toBe("【原文 · ch01《第一章》 · draft/ch01.md】\n夜航。");
	});
	it("空章节给出明确空正文标签", async () => {
		const c = { ...ctx, client: { getDraft: async () => ({ text: "  ", mtime: 0 }) } } as unknown as SlashContext;
		const items = await makeChapterCommand().search!("ch01", c);
		expect(await items[0].attachment!.loadText!(c)).toContain("（该章正文为空）");
	});
});

describe("composeMessageWithAttachments(引用芯片发送组装)", () => {
	it("芯片注入块在前、用户输入在后,空段不参与", () => {
		const chips = [
			{ key: "a", label: "ch01", text: "【原文 · ch01】\n夜航。" },
			{ key: "b", label: "林婉", text: "【世界书 · 人物 · 林婉】\n灯塔看守人的女儿。" },
		];
		expect(composeMessageWithAttachments(chips, "帮我衔接下一场")).toBe(
			"【原文 · ch01】\n夜航。\n\n【世界书 · 人物 · 林婉】\n灯塔看守人的女儿。\n\n帮我衔接下一场",
		);
	});
	it("无芯片 / 空输入的边界:只输入 → 原样;只有芯片 → 注入块;全空 → 空串", () => {
		expect(composeMessageWithAttachments([], "你好")).toBe("你好");
		const chips = [{ key: "a", label: "x", text: "块" }];
		expect(composeMessageWithAttachments(chips, "")).toBe("块");
		expect(composeMessageWithAttachments([], "   ")).toBe("");
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

describe("插件 Web 命令(makePluginCommand)", () => {
	it("构造 SlashCommand:trigger/hint 透传;run 调 client.runPluginCommand 并返回文本", async () => {
		const calls: Array<{ id: string; name: string; term: string | undefined }> = [];
		const fakeClient = {
			runPluginCommand: async (id: string, name: string, term?: string) => {
				calls.push({ id, name, term });
				return "d20 = 7";
			},
		};
		const cmd = makePluginCommand({ pluginId: "dice", trigger: "roll", hint: "掷骰子", client: fakeClient as never });
		expect(cmd.trigger).toBe("roll");
		expect(cmd.hint).toBe("掷骰子");
		const result = await cmd.run!("", {} as SlashContext);
		expect(calls).toEqual([{ id: "dice", name: "roll", term: undefined }]);
		expect(result).toBe("d20 = 7");
	});
	it("term 非空透传(trim 后),空串转 undefined", async () => {
		const calls: string[] = [];
		const cmd = makePluginCommand({
			pluginId: "dice",
			trigger: "roll",
			hint: "掷骰子",
			client: { runPluginCommand: async (_id: string, _name: string, term?: string) => { calls.push(term ?? "(none)"); return "ok"; } } as never,
		});
		await cmd.run!("6", {} as SlashContext);
		await cmd.run!("  ", {} as SlashContext);
		expect(calls).toEqual(["6", "(none)"]);
	});
});

describe("斜杠菜单的上下键处置(2026-09-20 修)", () => {
	it("候选项 ≤1 时**不吃键**:挪不动还 preventDefault 会让光标也动不了(「输入框被锁」)", () => {
		for (const key of ["ArrowUp", "ArrowDown"]) {
			expect(slashArrowMove(key, 0, 0)).toEqual({ consume: false, index: 0 });
			expect(slashArrowMove(key, 0, 1)).toEqual({ consume: false, index: 0 });
		}
	});

	it("候选项 ≥2:上下环回,且吃掉按键", () => {
		expect(slashArrowMove("ArrowDown", 0, 3)).toEqual({ consume: true, index: 1 });
		expect(slashArrowMove("ArrowDown", 2, 3)).toEqual({ consume: true, index: 0 }); // 环回
		expect(slashArrowMove("ArrowUp", 0, 3)).toEqual({ consume: true, index: 2 }); // 环回
		expect(slashArrowMove("ArrowUp", 1, 3)).toEqual({ consume: true, index: 0 });
	});

	it("越界下标被夹住(异步搜索结果回来时 index 可能停在旧长度上)", () => {
		expect(slashArrowMove("ArrowDown", 9, 3)).toEqual({ consume: true, index: 1 });
		expect(slashArrowMove("ArrowUp", 9, 3)).toEqual({ consume: true, index: 2 });
	});

	it("非方向键一律不吃", () => {
		for (const key of ["a", "ArrowLeft", "ArrowRight", "Enter", "Escape"]) {
			expect(slashArrowMove(key, 1, 5)).toEqual({ consume: false, index: 1 });
		}
	});
});

describe("菜单重建时的选中项保留(2026-09-20 修)", () => {
	const base = { query: { trigger: "no", term: "" }, command: { trigger: "node" }, picker: false };
	const next = { picker: false, query: { trigger: "no", term: "" }, command: { trigger: "node" } };

	it("查询未变 → 保留当前项(否则 keyup 重建会把上下键的移动打回第一项)", () => {
		expect(keepSlashIndex({ ...base, index: 3 }, next, 5)).toBe(3);
	});

	it("查询变了(又敲了字)→ 回到第一项", () => {
		expect(keepSlashIndex({ ...base, index: 3 }, { ...next, query: { trigger: "no", term: "林" } }, 5)).toBe(0);
		expect(keepSlashIndex({ ...base, index: 3 }, { ...next, command: { trigger: "node" }, picker: true }, 5)).toBe(0);
	});

	it("结果数变少 → 按新长度夹紧,不越界", () => {
		expect(keepSlashIndex({ ...base, index: 4 }, next, 2)).toBe(1);
	});

	it("没有上一帧(首次打开)或空结果 → 第一项", () => {
		expect(keepSlashIndex(null, next, 5)).toBe(0);
		expect(keepSlashIndex({ ...base, index: 2 }, next, 0)).toBe(0);
	});
});
