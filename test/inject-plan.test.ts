/**
 * 分诊层单测 —— 钉住「同一会话内每类内容只出现在一格」这条不变量。
 *
 * 反证法思路(本文件的核心价值):如果哪天有人把同一类内容同时塞进两格
 * (比如「Notice 进了每轮上下文、又放回锚」),下面的断言必须变红。
 * 这才是「统一」的护栏 —— 光靠注释约束不住,得让重复**无法通过测试**。
 *
 * 2026-10-11 起编辑会话的格 B/格 C 已合并为一格(`context`):全部内容每轮一起
 * 注入在用户输入之前。所以这里除「互斥」外还多钉一条**顺序**(常驻组在前、
 * 本章组在后)与一条**编号**(Notice/发展线带短编号,供窄工具指认)。
 */
import { describe, expect, it } from "vitest";
import {
	ANCHOR_CONSTRAINTS_LIMIT,
	ANCHOR_CONSTRAINTS_TITLE,
	ANCHOR_HEADER,
	contentsInSlot,
	EDITOR_ROUTING,
	packContents,
	planAnchorBlocks,
	planChapterBlocks,
	planContextBlocks,
	planResidentBlocks,
	renderAnchor,
	renderEditorContext,
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
		{
			id: "e3",
			type: "character",
			title: "陈锋",
			keys: ["陈锋"],
			chapters: [],
			status: "dead",
			active: true,
			parent: null,
			tags: [],
			body: "已在第三章中坠楼",
			avatar: null,
			images: [],
			updatedAt: 0,
		},
		],
		relations: [],
		constraints: [{ id: "c1", name: "人称", text: "第三人称限知", enabled: true, target: "all" }],
		styleSample: null,
		worldSummary: "一座靠海的小城",
		notice: { enabled: true, items: [{ id: "ntc-n1", text: "埋伏笔:钥匙", done: false }] },
		storyline: {
			enabled: true,
			nodes: [
				{ id: "story-s1", title: "开场", status: "in-progress", goal: "交代背景", next: "引出林婉" },
				{ id: "story-s0", title: "序", status: "done", goal: "", next: null },
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

	it("两个格位都被用到(没有空格 —— 空格说明表写错了)", () => {
		const slots: InjectSlot[] = ["context", "anchor"];
		for (const s of slots) {
			expect(contentsInSlot(s).length, `格 ${s} 没有内容`).toBeGreaterThan(0);
		}
	});

	it("Notice 与发展线同归格 C(2026-10-11 合流:编辑会话不再分稳定块/浮动块)", () => {
		expect(slotOf("notice")).toBe("context");
		expect(slotOf("storyline")).toBe("context");
		expect(slotOf("worldSummary")).toBe("context");
		expect(slotOf("constraints")).toBe("context");
	});

	it("memory.md 归锚(不是每轮上下文)", () => {
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

describe("格 C 常驻组(planResidentBlocks)", () => {
	it("产出死角色/概述/世界书/约束/Notice 五块,且顺序固定", () => {
		const blocks = planResidentBlocks({ world: richWorld(), classicMode: false });
		expect(titlesOf(blocks)).toEqual(["【已死亡角色 · 只可回忆/遗物/他人提及形式出现,不可作为活人出场】陈锋", "【世界观概述】", "【世界书】", "【写作约束】", "【Notice·备忘录】"]);
	});

	it("已死亡角色块置顶:列名字,不列 body(body 是活人设定,留在世界书块里)", () => {
		const blocks = planResidentBlocks({ world: richWorld(), classicMode: false });
		const head = blocks[0]!;
		expect(head).toContain("陈锋");
		expect(head).not.toContain("坠楼"); // body 不在红线条里
		expect(blocks.join("\n")).toContain("【陈锋 · 已死亡】"); // 世界书块里带状态标记
	});

	it("世界书条目行带状态后缀(dead/archived 标记,alive 不加)", () => {
		const world = richWorld();
		const w: WorldData = {
			...world,
			entries: world.entries.map((e) => (e.id === "e1" ? { ...e, status: "dead" as const } : e)),
		};
		const text = planResidentBlocks({ world: w, classicMode: false }).join("\n");
		expect(text).toContain("【林婉 · 已死亡】");
		expect(text).toContain("【旧城】"); // active 无后缀
	});

	it("没有死亡角色时不产出红线条(不产生空块)", () => {
		const world = richWorld();
		const w: WorldData = { ...world, entries: world.entries.filter((e) => e.status !== "dead") };
		const blocks = planResidentBlocks({ world: w, classicMode: false });
		expect(blocks.join("\n")).not.toContain("已死亡角色");
		expect(titlesOf(blocks)).toEqual(["【世界观概述】", "【世界书】", "【写作约束】", "【Notice·备忘录】"]);
	});

	it("**不产出发展线** —— 它归本章组", () => {
		const blocks = planResidentBlocks({ world: richWorld(), classicMode: false });
		expect(blocks.join("\n")).not.toContain("【发展线】");
	});

	it("**不产出正文** —— 它归本章组", () => {
		const blocks = planResidentBlocks({ world: richWorld(), classicMode: false });
		expect(blocks.join("\n")).not.toContain("【当前正文");
	});

	it("约束按 target 过滤:编剧只取 writer,经典模式还收 main", () => {
		const world = richWorld();
		const w = { ...world, constraints: [
			{ id: "c1", name: "给编剧", text: "x", enabled: true, target: "writer" as const },
			{ id: "c2", name: "给导演", text: "y", enabled: true, target: "director" as const },
		] };
		const editor = planResidentBlocks({ world: w, classicMode: false });
		expect(editor.join("\n")).toContain("给编剧");
		expect(editor.join("\n")).not.toContain("给导演");
		// 经典模式是单一写作 agent:writer 与 main 都该生效,但 director 仍不该
		const classic = planResidentBlocks({ world: w, classicMode: true });
		expect(classic.join("\n")).toContain("给编剧");
		expect(classic.join("\n")).not.toContain("给导演");
	});

	it("空世界不产出任何块(不产生空块)", () => {
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
		expect(planResidentBlocks({ world: empty, classicMode: false })).toEqual([]);
	});

	it("Notice 关掉时不产出 Notice 块", () => {
		const world = richWorld();
		world.notice.enabled = false;
		expect(planResidentBlocks({ world, classicMode: false }).join("\n")).not.toContain("Notice");
	});

	it("**Notice 条目带短编号** —— notice_update 靠它指认(2026-10-11)", () => {
		const text = planResidentBlocks({ world: richWorld(), classicMode: false }).join("\n");
		// id = ntc-n1 → 短编号 n1
		expect(text).toContain("[n1] 埋伏笔:钥匙");
		expect(text).not.toContain("ntc-n1");
	});
});

describe("格 C 本章组(planChapterBlocks)", () => {
	it("产出发展线与正文", () => {
		const blocks = planChapterBlocks({ world: richWorld(), draft: "正文内容", draftFile: "draft/ch01.md" });
		const all = blocks.join("\n");
		expect(all).toContain("【当前正文 · draft/ch01.md】");
		expect(all).toContain("【发展线】");
	});

	it("**不产出 Notice / 概述 / 世界书 / 约束** —— 它们归常驻组", () => {
		const blocks = planChapterBlocks({ world: richWorld(), draft: "x", draftFile: "draft/ch01.md" });
		const all = blocks.join("\n");
		expect(all).not.toContain("Notice");
		expect(all).not.toContain("【世界观概述】");
		expect(all).not.toContain("【世界书】");
		expect(all).not.toContain("【写作约束】");
	});

	it("**发展线带短编号** —— storyline_update 靠它指认(2026-10-11)", () => {
		const text = planChapterBlocks({ world: richWorld(), draft: "x", draftFile: "draft/c.md" }).join("\n");
		// id = story-s1 → 短编号 s1;已完成 story-s0 → s0
		expect(text).toContain("当前位置: [s1] 开场");
		expect(text).toContain("[s0] 序");
		expect(text).not.toContain("story-s1");
	});

	it("正文文件不存在时给落点提示(而非静默省略)", () => {
		const blocks = planChapterBlocks({ world: richWorld(), draft: null, draftFile: "draft/ch01.md" });
		expect(blocks[0]).toContain("尚未创建");
		expect(blocks[0]).toContain("draft/ch01.md");
	});

	it("无正文目标时完全不产正文块(不产生空块)", () => {
		const blocks = planChapterBlocks({ world: richWorld() });
		expect(blocks.join("\n")).not.toContain("【当前正文");
	});
});

describe("格 C 合并后的整体(planContextBlocks / renderEditorContext)", () => {
	it("常驻组在前、本章组在后(越靠近用户输入越「当下」)", () => {
		const blocks = planContextBlocks({
			world: richWorld(),
			classicMode: false,
			draft: "x",
			draftFile: "draft/c.md",
			transcript: "一幕",
		});
		expect(titlesOf(blocks)).toEqual([
			"【已死亡角色 · 只可回忆/遗物/他人提及形式出现,不可作为活人出场】陈锋",
			"【世界观概述】",
			"【世界书】",
			"【写作约束】",
			"【Notice·备忘录】",
			"【当前正文 · draft/c.md】",
			"【发展线】",
			"【最近一幕舞台转录】",
		]);
	});

	it("渲染出总说明,并声明「每轮刷新、当前唯一有效」(合流后历史里不留副本)", () => {
		const text = renderEditorContext(true, planContextBlocks({ world: richWorld(), classicMode: true }));
		expect(text).toContain("写作上下文");
		expect(text).toContain("每轮刷新");
		expect(text).toContain("【世界观概述】");
		expect(renderEditorContext(false, ["x"])).toContain("编剧上下文");
	});
});

describe("格 D:每轮锚(planAnchorBlocks / renderAnchor)", () => {
	it("只装模式行 + 当前章节 + memory.md", () => {
		const r = planAnchorBlocks({ mode: "writing", chapterFile: "ch01.jsonl", memory: "记得林婉怕水" });
		expect(r.modeLine).toContain("写作态");
		expect(r.head).toContain("ch01.jsonl");
		expect(titlesOf(r.blocks)).toEqual(["【跨章节记忆 memory.md】"]);
	});

	it("**不装 Notice,也不装发展线 / 概述**(它们全归格 C);不传 constraints 时也不装约束", () => {
		const text = renderAnchor({ mode: "writing", chapterFile: "ch01.jsonl", memory: "x" });
		expect(text).not.toContain("Notice");
		expect(text).not.toContain("【发展线】");
		expect(text).not.toContain("【世界观概述】");
		expect(text).not.toContain("【写作约束】");
	});

	it("传了 constraints 才产速查块(2026-10-12:opt-in,只有主会话/TUI 传)", () => {
		const r = planAnchorBlocks({
			mode: "writing",
			chapterFile: "ch01.jsonl",
			memory: "记得林婉怕水",
			constraints: [{ name: "人称", text: "第三人称限知" }],
		});
		expect(titlesOf(r.blocks)).toEqual(["【跨章节记忆 memory.md】", "【写作约束 · 速查】"]);
		expect(r.blocks[1]).toContain("第三人称限知");
	});

	it("速查块与格 C 的【写作约束】刻意不同名 —— 同名会被误判成「同类内容两处注入」", () => {
		expect(ANCHOR_CONSTRAINTS_TITLE).not.toBe("【写作约束】");
	});

	it("速查超长时按序截断,并注明还有几条在背景包/世界书里", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ name: `规则${i}`, text: "内容".repeat(60) }));
		const r = planAnchorBlocks({ constraints: many });
		const block = r.blocks[0]!;
		expect(block.length).toBeLessThanOrEqual(ANCHOR_CONSTRAINTS_LIMIT + 40);
		expect(block).toContain("另有");
		expect(block).toContain("规则0");
		expect(block).not.toContain("规则11");
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
	it("常驻组与本章组的块标题集合**不相交**", () => {
		const resident = titlesOf(planResidentBlocks({ world: richWorld(), classicMode: false }));
		const chapter = titlesOf(
			planChapterBlocks({ world: richWorld(), draft: "x", draftFile: "draft/c.md", transcript: "一幕" }),
		);
		const overlap = resident.filter((t) => chapter.includes(t));
		expect(overlap, `这些块同时出现在常驻组与本章组:${overlap.join(", ")}`).toEqual([]);
	});

	it("格 C 与锚的块标题集合不相交", () => {
		const context = titlesOf(planContextBlocks({
			world: richWorld(),
			classicMode: false,
			draft: "x",
			draftFile: "draft/c.md",
			transcript: "一幕",
		}));
		const anchor = titlesOf(planAnchorBlocks({ mode: "writing", chapterFile: "c", memory: "x" }).blocks);
		expect(context.filter((t) => anchor.includes(t))).toEqual([]);
	});

	it("全表覆盖:EDITOR_ROUTING 里的每个 id 恰好能被某一格产出一次", () => {
		// 内容的「可观测块标题」→ 登记 id 的映射。若新增内容忘了在此登记,
		// 这条会失败,提醒补表。
		const blockIdOf: Record<string, string> = {
			"【已死亡角色 · 只可回忆/遗物/他人提及形式出现,不可作为活人出场】陈锋": "worldEntries",
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
			...titlesOf(planContextBlocks({ world: richWorld(), classicMode: false, draft: "x", draftFile: "draft/c.md", transcript: "t" })),
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
	it("主会话承载全部(它没有格 C —— 背景包是唯一来源)", () => {
		expect(packContents("main")).toEqual(["memory", "worldSummary", "constraints", "notice", "storyline"]);
	});

	it("TUI 同为全量(冻结期不改行为)", () => {
		expect(packContents("tui").length).toBe(packContents("main").length);
	});

	it("编剧会话**不承载**背景包内容(它有格 C/D,再走背景包就是重复)", () => {
		expect(packContents("editor")).toEqual([]);
	});

	it("舞台角色不经此函数(避免与自己的 context 钩子重复)", () => {
		expect(packContents("stage")).toEqual([]);
	});
});

describe("路由表类型可用", () => {
	it("ContentRouting 可作只读表传入(contentsInSlot 支持自定义表)", () => {
		const custom: readonly ContentRouting[] = [{ id: "a", label: "甲", slot: "context" }];
		expect(contentsInSlot("context", custom)).toEqual(["a"]);
		expect(contentsInSlot("anchor", custom)).toEqual([]);
	});
});
