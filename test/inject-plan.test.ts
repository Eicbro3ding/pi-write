/**
 * 分诊层单测 —— 钉住「同一会话内每类内容只出现在一格」这条不变量。
 *
 * 反证法思路(本文件的核心价值):如果哪天有人把同一类内容同时塞进两格
 * (比如「Notice 放稳定块的同时又放回每轮注入」),下面的断言必须变红。
 * 这才是「统一」的护栏 —— 光靠注释约束不住,得让重复**无法通过测试**。
 */
import { describe, expect, it } from "vitest";
import {
	ANCHOR_HEADER,
	contentsInSlot,
	EDITOR_ROUTING,
	packContents,
	planAnchorBlocks,
	planPerTurnBlocks,
	planStableBlocks,
	renderAnchor,
	slotOf,
	truncate,
	type ContentRouting,
	type InjectSlot,
} from "../src/inject-plan.ts";
import type { WorldData } from "../src/world-data.ts";

/** 造一份「每类内容都有」的世界,便于检测某块是否被某格重复产出。 */
function richWorld(): WorldData {
	return {
		version: 1,
		entries: [
			{
				id: "e1",
				type: "character",
				title: "林婉",
				keys: ["林婉"],
				chapters: [],
				status: "alive",
				active: true,
				parent: null,
				tags: [],
				body: "女主",
				avatar: null,
				images: [],
				updatedAt: 0,
			},
			{
				id: "e2",
				type: "world",
				title: "旧城",
				keys: ["旧城"],
				chapters: [],
				status: "active",
				active: true,
				parent: null,
				tags: [],
				body: "舞台",
				avatar: null,
				images: [],
				updatedAt: 0,
			},
		],
		relations: [],
		constraints: [{ id: "c1", name: "人称", text: "第三人称限知", enabled: true, target: "all" }],
		styleSample: null,
		worldSummary: "一座靠海的小城",
		notice: { enabled: true, items: [{ id: "n1", text: "埋伏笔:钥匙", done: false }] },
		storyline: {
			enabled: true,
			nodes: [
				{ id: "s1", title: "开场", status: "in-progress", goal: "交代背景", next: "引出林婉" },
				{ id: "s0", title: "序", status: "done", goal: "", next: null },
			],
		},
		timeline: [],
	};
}

/** 从一组块里抽出所有 `【xxx】` 标题(只看块首,避免正文里的方括号干扰)。 */
function titlesOf(blocks: readonly string[]): string[] {
	return blocks.map((b) => b.split("\n")[0]!.trim());
}

describe("分诊表(EDITOR_ROUTING)", () => {
	it("每类内容只登记一次(没有重复 id)", () => {
		const ids = EDITOR_ROUTING.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("三个格位都被用到(没有空格 —— 空格说明表写错了)", () => {
		const slots: InjectSlot[] = ["stable", "perTurn", "anchor"];
		for (const s of slots) {
			expect(contentsInSlot(s).length, `格 ${s} 没有内容`).toBeGreaterThan(0);
		}
	});

	it("Notice 归稳定块、发展线归每轮 —— 2026-10-06 拍板的归属,不许漂移", () => {
		expect(slotOf("notice")).toBe("stable");
		expect(slotOf("storyline")).toBe("perTurn");
	});

	it("memory.md 归锚(不是稳定块,也不是每轮易变块)", () => {
		expect(slotOf("memory")).toBe("anchor");
	});

	it("未登记的内容返回 null(调用方能区分「没登记」与「登记为某格」)", () => {
		expect(slotOf("不存在的类目")).toBe(null);
	});

	it("反证:任何两类内容不得同 id,且每格内容集合互不相交", () => {
		// 这条是「互斥」的形式化表达 —— 一个 id 只能属于一个格
		const seen = new Map<string, InjectSlot>();
		for (const r of EDITOR_ROUTING) {
			const prev = seen.get(r.id);
			expect(prev, `${r.id} 同时出现在 ${prev} 与 ${r.slot}`).toBeUndefined();
			seen.set(r.id, r.slot);
		}
	});
});

describe("格 B:稳定块(planStableBlocks)", () => {
	it("产出概述/世界书/约束/Notice 四块,且顺序固定", () => {
		const blocks = planStableBlocks({ world: richWorld(), classicMode: false });
		expect(titlesOf(blocks)).toEqual(["【世界观概述】", "【世界书】", "【写作约束】", "【Notice·备忘录】"]);
	});

	it("**不产出发展线** —— 它已归格 C(这是本轮去重的关键)", () => {
		const blocks = planStableBlocks({ world: richWorld(), classicMode: false });
		expect(blocks.join("\n")).not.toContain("【发展线】");
	});

	it("**不产出正文** —— 正文归格 C", () => {
		const blocks = planStableBlocks({ world: richWorld(), classicMode: false });
		expect(blocks.join("\n")).not.toContain("【当前正文");
	});

	it("约束按 target 过滤:编剧只取 writer/main-c 并集外的 excluded", () => {
		const world = richWorld();
		const w = { ...world, constraints: [
			{ id: "c1", name: "给编剧", text: "x", enabled: true, target: "writer" as const },
			{ id: "c2", name: "给导演", text: "y", enabled: true, target: "director" as const },
		] };
		const editor = planStableBlocks({ world: w, classicMode: false });
		expect(editor.join("\n")).toContain("给编剧");
		expect(editor.join("\n")).not.toContain("给导演");
		// 经典模式是单一写作 agent:writer 与 main 都该生效,但 director 仍不该
		const classic = planStableBlocks({ world: w, classicMode: true });
		expect(classic.join("\n")).toContain("给编剧");
		expect(classic.join("\n")).not.toContain("给导演");
	});

	it("空世界不产出任何块(不产生空块污染指纹)", () => {
		const empty: WorldData = {
			version: 1,
			entries: [],
			relations: [],
			constraints: [],
			styleSample: null,
			worldSummary: "",
			notice: { enabled: true, items: [] },
			storyline: { enabled: false, nodes: [] },
			timeline: [],
		};
		expect(planStableBlocks({ world: empty, classicMode: false })).toEqual([]);
	});

	it("Notice 关掉时不产出 Notice 块", () => {
		const world = richWorld();
		world.notice.enabled = false;
		expect(planStableBlocks({ world, classicMode: false }).join("\n")).not.toContain("Notice");
	});
});

describe("格 C:每轮易变块(planPerTurnBlocks)", () => {
	it("产出发展线与正文", () => {
		const blocks = planPerTurnBlocks({ world: richWorld(), draft: "正文内容", draftFile: "draft/ch01.md" });
		const all = blocks.join("\n");
		expect(all).toContain("【当前正文 · draft/ch01.md】");
		expect(all).toContain("【发展线】");
	});

	it("**不产出 Notice** —— 它已归格 B(本轮去重的关键)", () => {
		const blocks = planPerTurnBlocks({ world: richWorld(), draft: "x", draftFile: "draft/ch01.md" });
		expect(blocks.join("\n")).not.toContain("Notice");
	});

	it("**不产出世界观概述 / 世界书 / 约束** —— 它们归格 B", () => {
		const blocks = planPerTurnBlocks({ world: richWorld(), draft: "x", draftFile: "draft/ch01.md" });
		const all = blocks.join("\n");
		expect(all).not.toContain("【世界观概述】");
		expect(all).not.toContain("【世界书】");
		expect(all).not.toContain("【写作约束】");
	});

	it("正文文件不存在时给落点提示(而非静默省略)", () => {
		const blocks = planPerTurnBlocks({ world: richWorld(), draft: null, draftFile: "draft/ch01.md" });
		expect(blocks[0]).toContain("尚未创建");
		expect(blocks[0]).toContain("draft/ch01.md");
	});

	it("无正文目标时完全不产正文块(不产生空块)", () => {
		const blocks = planPerTurnBlocks({ world: richWorld() });
		expect(blocks.join("\n")).not.toContain("【当前正文");
	});
});

describe("格 D:每轮锚(planAnchorBlocks / renderAnchor)", () => {
	it("只装模式行 + 当前章节 + memory.md", () => {
		const r = planAnchorBlocks({ mode: "writing", chapterFile: "ch01.jsonl", memory: "记得林婉怕水" });
		expect(r.modeLine).toContain("写作态");
		expect(r.head).toContain("ch01.jsonl");
		expect(titlesOf(r.blocks)).toEqual(["【跨章节记忆 memory.md】"]);
	});

	it("**不装 Notice,也不装发展线** —— 它们分别在格 B / 格 C(本轮去重的关键)", () => {
		const text = renderAnchor({ mode: "writing", chapterFile: "ch01.jsonl", memory: "x" });
		expect(text).not.toContain("Notice");
		expect(text).not.toContain("【发展线】");
	});

	it("模式行排在记忆之前(顺序钉死 —— 最优先的约束在最前)", () => {
		const text = renderAnchor({ mode: "discussing", chapterFile: "ch01.jsonl", memory: "x" });
		expect(text.indexOf("讨论态")).toBeLessThan(text.indexOf("【跨章节记忆 memory.md】"));
	});

	it("模式行在章节行之前", () => {
		const text = renderAnchor({ mode: "writing", chapterFile: "ch01.jsonl" });
		expect(text.indexOf("写作态")).toBeLessThan(text.indexOf("当前章节:"));
	});

	it("什么都不给时返回空串(调用方据此跳过注入)", () => {
		expect(renderAnchor({})).toBe("");
	});

	it("有总说明头(模型据此知道这是跨轮恒定事实)", () => {
		const text = renderAnchor({ memory: "x" });
		expect(text.startsWith(ANCHOR_HEADER)).toBe(true);
	});

	it("无 memory.md 时锚仍产出模式行(不因缺记忆而整体消失)", () => {
		const text = renderAnchor({ mode: "discussing" });
		expect(text).toContain("讨论态");
	});
});

describe("跨格互斥(反证:同一块不得出现在两格)", () => {
	it("稳定块与每轮块的块标题集合**不相交**", () => {
		const stable = titlesOf(planStableBlocks({ world: richWorld(), classicMode: false }));
		const perTurn = titlesOf(
			planPerTurnBlocks({ world: richWorld(), draft: "x", draftFile: "draft/ch01.md", transcript: "一幕" }),
		);
		const overlap = stable.filter((t) => perTurn.includes(t));
		expect(overlap, `这些块同时出现在格 B 与格 C:${overlap.join(", ")}`).toEqual([]);
	});

	it("稳定块与锚的块标题集合不相交", () => {
		const stable = titlesOf(planStableBlocks({ world: richWorld(), classicMode: false }));
		const anchor = titlesOf(planAnchorBlocks({ mode: "writing", chapterFile: "c", memory: "x" }).blocks);
		expect(stable.filter((t) => anchor.includes(t))).toEqual([]);
	});

	it("每轮块与锚的块标题集合不相交", () => {
		const perTurn = titlesOf(planPerTurnBlocks({ world: richWorld(), draft: "x", draftFile: "draft/c.md" }));
		const anchor = titlesOf(planAnchorBlocks({ mode: "writing", chapterFile: "c", memory: "x" }).blocks);
		expect(perTurn.filter((t) => anchor.includes(t))).toEqual([]);
	});

	it("全表覆盖:EDITOR_ROUTING 里的每个 id 恰好能被某一格产出一次", () => {
		// 内容的「可观测块标题」→ 登记 id 的映射。若新增内容忘了在此登记,
		// 这条会失败,提醒补表。
		const blockIdOf: Record<string, string> = {
			"【世界观概述】": "worldSummary",
			"【世界书】": "worldEntries",
			"【写作约束】": "constraints",
			"【Notice·备忘录】": "notice",
			"【发展线】": "storyline",
			"【当前正文 · draft/c.md】": "draft",
			"【最近一幕舞台转录】": "transcript",
			"【跨章节记忆 memory.md】": "memory",
		};
		const produced = new Set<string>([
			...titlesOf(planStableBlocks({ world: richWorld(), classicMode: false })),
			...titlesOf(planPerTurnBlocks({ world: richWorld(), draft: "x", draftFile: "draft/c.md", transcript: "t" })),
			...titlesOf(planAnchorBlocks({ mode: "writing", chapterFile: "c", memory: "x" }).blocks),
		]);
		const mapped = new Set(Object.keys(blockIdOf).filter((t) => produced.has(t)).map((t) => blockIdOf[t]!));
		// modeLine / chapter 不是【】块(在 head/modeLine 里),从表里单列
		const nonBlock = ["modeLine", "chapter"];
		for (const r of EDITOR_ROUTING) {
			if (nonBlock.includes(r.id)) continue;
			expect(mapped.has(r.id), `登记了 ${r.id} 但没有任何一格产出它`).toBe(true);
		}
	});
});

describe("truncate(截断)", () => {
	it("未超限原样返回", () => {
		expect(truncate("短", 10)).toBe("短");
	});

	it("超限截断并标记", () => {
		const out = truncate("abcdef", 3);
		expect(out).toContain("abc");
		expect(out).toContain("…(截断)");
	});
});

describe("格 E:背景包按会话类型(反证:编剧会话不得复用背景包)", () => {
	it("主会话承载全部(它没有稳定块/易变块 —— 背景包是唯一来源)", () => {
		expect(packContents("main")).toEqual(["memory", "worldSummary", "constraints", "notice", "storyline"]);
	});

	it("TUI 同为全量(冻结期不改行为)", () => {
		expect(packContents("tui").length).toBe(packContents("main").length);
	});

	it("编剧会话**不承载**背景包内容(它有格 B/C/D,再走背景包就是重复)", () => {
		expect(packContents("editor")).toEqual([]);
	});

	it("舞台角色不经此函数(避免与自己的 context 钩子重复)", () => {
		expect(packContents("stage")).toEqual([]);
	});
});

describe("路由表类型可用", () => {
	it("ContentRouting 可作只读表传入(contentsInSlot 支持自定义表)", () => {
		const custom: readonly ContentRouting[] = [{ id: "a", label: "甲", slot: "stable" }];
		expect(contentsInSlot("stable", custom)).toEqual(["a"]);
		expect(contentsInSlot("perTurn", custom)).toEqual([]);
	});
});
