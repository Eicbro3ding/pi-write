import { describe, expect, it } from "vitest";
import { buildChapterContext, DEFAULT_CONTEXT_BUDGET, estimateTokens, activatedEntryIds, expandActivation, rankActivationCandidates, trimMemory } from "../src/world-context.ts";
import { createEmptyWorld, type WorldData } from "../src/world-data.ts";

function worldWith(...titles: Array<{ title: string; type: "character" | "world" | "timeline" | "outline"; keys?: string[]; chapters?: string[] }>): WorldData {
	const w = createEmptyWorld();
	titles.forEach((t, i) => {
		w.entries.push({
			id: `e${i}`, type: t.type, title: t.title, keys: t.keys ?? [], chapters: t.chapters ?? [],
			status: "active", active: true, parent: null, tags: [], body: `${t.title}的正文`, avatar: null, images: [], updatedAt: 0,
		});
	});
	return w;
}

/**
 * 关联激活测试基座:
 * e0 林婉(种子)—强→ e1 婉姐的剑 —普通→ e2 剑冢;e1 —普通→ e0(回环)
 * e0 —普通→ e3 林家 —普通→ e4 林父
 */
function relWorld(): WorldData {
	const w = worldWith(
		{ title: "林婉", type: "character", keys: ["林婉"] },
		{ title: "婉姐的剑", type: "world" },
		{ title: "剑冢", type: "world" },
		{ title: "林家", type: "world" },
		{ title: "林父", type: "world" },
	);
	w.relations.push(
		{ id: "r1", from: "e0", to: "e1", type: "", label: "持有", emphasized: true, arrow: "double" },
		{ id: "r2", from: "e1", to: "e2", type: "", label: "位于", emphasized: false, arrow: "double" },
		{ id: "r3", from: "e1", to: "e0", type: "", label: "", emphasized: false, arrow: "double" },
		{ id: "r4", from: "e0", to: "e3", type: "", label: "出身", emphasized: false, arrow: "double" },
		{ id: "r5", from: "e3", to: "e4", type: "", label: "", emphasized: false, arrow: "double" },
	);
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

describe("expandActivation", () => {
	it("depth=1 只取一跳邻居,强关联与普通都在,元数据正确", () => {
		const w = relWorld();
		const out = expandActivation(w, ["e0"], 1, "ch01");
		const byId = new Map(out.map((c) => [c.id, c]));
		expect(byId.get("e1")).toEqual({ id: "e1", dist: 1, emphasized: true });
		expect(byId.get("e3")).toEqual({ id: "e3", dist: 1, emphasized: false });
		expect(out).toHaveLength(2);
	});
	it("depth=2 展开二跳;回环(e1→e0)不重复激活种子", () => {
		const w = relWorld();
		const out = expandActivation(w, ["e0"], 2, "ch01");
		expect(out.map((c) => c.id).sort()).toEqual(["e1", "e2", "e3", "e4"]);
		const e2 = out.find((c) => c.id === "e2")!;
		expect(e2.dist).toBe(2);
		expect(e2.emphasized).toBe(false);
	});
	it("depth<=0、空 relations、无种子均返回空", () => {
		const w = relWorld();
		expect(expandActivation(w, ["e0"], 0, "ch01")).toEqual([]);
		expect(expandActivation(w, ["e0"], -1, "ch01")).toEqual([]);
		expect(expandActivation(w, [], 2, "ch01")).toEqual([]);
		w.relations = [];
		expect(expandActivation(w, ["e0"], 2, "ch01")).toEqual([]);
	});
	it("inactive 条目不作为候选也不作为中转", () => {
		const w = relWorld();
		w.entries[1]!.active = false; // e1 失效:e2 经它不可达,也不入候选
		const out = expandActivation(w, ["e0"], 2, "ch01");
		const ids = out.map((c) => c.id);
		expect(ids).not.toContain("e1");
		expect(ids).not.toContain("e2");
		expect(ids).toContain("e3");
		expect(ids).toContain("e4");
	});
	it("同层多条到达边:强关联优先(与边顺序无关)", () => {
		const w = relWorld();
		// e0 到 e2 两条边:普通在前、强在后(顺序无关,结果恒为强)
		w.relations.push({ id: "r6", from: "e0", to: "e2", type: "", label: "", emphasized: false, arrow: "double" });
		w.relations.push({ id: "r7", from: "e0", to: "e2", type: "", label: "", emphasized: true, arrow: "double" });
		const out = expandActivation(w, ["e0"], 1, "ch01");
		expect(out.find((c) => c.id === "e2")!.emphasized).toBe(true);
	});
	it("双向遍历:方向无关(arrow 不参与)", () => {
		const w = relWorld();
		w.relations = [{ id: "r1", from: "e1", to: "e0", type: "", label: "", emphasized: true, arrow: "single" }];
		const out = expandActivation(w, ["e0"], 1, "ch01");
		expect(out.find((c) => c.id === "e1")).toEqual({ id: "e1", dist: 1, emphasized: true });
	});
});

describe("rankActivationCandidates", () => {
	it("种子永远在递归候选前,种子内部保持既有顺序", () => {
		const w = relWorld();
		const ranked = rankActivationCandidates(w, ["e0", "e3"], [{ id: "e1", dist: 1, emphasized: true }]);
		expect(ranked).toEqual(["e0", "e3", "e1"]);
	});
	it("强关联跨层插队:二跳强关联排在一跳普通前", () => {
		const w = relWorld();
		const ranked = rankActivationCandidates(w, [], [
			{ id: "e_weak1", dist: 1, emphasized: false },
			{ id: "e_strong2", dist: 2, emphasized: true },
		]);
		expect(ranked).toEqual(["e_strong2", "e_weak1"]);
	});
	it("未标注 emphasized 时退化为距离优先", () => {
		const w = relWorld();
		const ranked = rankActivationCandidates(w, [], [
			{ id: "e_far", dist: 2, emphasized: false },
			{ id: "e_near", dist: 1, emphasized: false },
		]);
		expect(ranked).toEqual(["e_near", "e_far"]);
	});
	it("同权重同距离按类型优先级兜底(人物>世界)", () => {
		const w = relWorld();
		w.entries.push(
			{ id: "e_world1", type: "world", title: "地点", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 },
			{ id: "e_char1", type: "character", title: "人物", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 },
		);
		const ranked = rankActivationCandidates(w, [], [
			{ id: "e_world1", dist: 1, emphasized: false },
			{ id: "e_char1", dist: 1, emphasized: false },
		]);
		expect(ranked).toEqual(["e_char1", "e_world1"]);
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
			w.entries.push({ id: `e${i}`, type: "character", title: `角色${i}`, keys: [`角色${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
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

describe("buildChapterContext(关联激活)", () => {
	it("缺省/0 深度不展开:邻居不进背景包(兼容回归)", () => {
		const w = relWorld();
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉推开门。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.activatedIds).toEqual(["e0"]);
		expect(r.text).toContain("林婉的正文");
		expect(r.text).not.toContain("婉姐的剑的正文");
	});
	it("深度 2 展开邻居:种子在前,递归候选按强关联/跳距排序", () => {
		const w = relWorld();
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉推开门。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET, activationDepth: 2 });
		expect(r.activatedIds[0]).toBe("e0");
		expect(r.activatedIds).toEqual(["e0", "e1", "e3", "e2", "e4"]);
		expect(r.text).toContain("婉姐的剑的正文"); // 强关联一跳
		expect(r.text).toContain("剑冢的正文"); // 普通二跳
	});
	it("深度展开与预算共享:小预算先裁递归节点,种子保底", () => {
		const w = relWorld();
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉推开门。", recentUserMessages: [], budget: 10, activationDepth: 2 });
		expect(r.activatedIds).toEqual(["e0"]); // 首条无条件装入
		expect(r.trimmedCount).toBeGreaterThan(0);
		expect(r.text).not.toContain("婉姐的剑的正文");
	});
	it("两棵不相连树各一命中种子:互不挤占,候选都在", () => {
		const w = relWorld();
		// 第二棵树:e5 沈家(种子)—强→ e6 沈父,与主树无任何关系
		w.entries.push(
			{ id: "e5", type: "world", title: "沈家", keys: ["沈家"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "沈家的正文", avatar: null, images: [], updatedAt: 0 },
			{ id: "e6", type: "world", title: "沈父", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "沈父的正文", avatar: null, images: [], updatedAt: 0 },
		);
		w.relations.push({ id: "r8", from: "e5", to: "e6", type: "", label: "", emphasized: true, arrow: "double" });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉与沈家对峙。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET, activationDepth: 2 });
		expect(r.activatedIds).toEqual(["e0", "e5", "e1", "e6", "e3", "e2", "e4"]);
		expect(r.text).toContain("沈父的正文");
	});
});

describe("buildChapterContext(世界观概述)", () => {
	it("概述注入在记忆后、激活组前,hasSummary 置位", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.worldSummary = "蒸汽与旧神共存的雾港。";
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], memory: "第四章完成。", budget: DEFAULT_CONTEXT_BUDGET });
		const iMem = r.text.indexOf("【记忆】");
		const iSum = r.text.indexOf("【世界观概述】");
		const iAct = r.text.indexOf("【世界书·本章相关】");
		expect(iSum).toBeGreaterThan(iMem);
		expect(iSum).toBeLessThan(iAct);
		expect(r.included.hasSummary).toBe(true);
	});
	it("空概述不注入", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text).not.toContain("【世界观概述】");
		expect(r.included.hasSummary).toBe(false);
	});
	it("超预算先裁采样、仍超再裁概述(约束保留)", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		w.worldSummary = "字".repeat(3000);
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 100 });
		expect(r.included.hasSample).toBe(false);
		expect(r.included.hasSummary).toBe(false);
		expect(r.included.constraints).toEqual(["对话风格"]);
		expect(r.text).toContain("对话不用引号");
		expect(r.text).not.toContain("文风采样");
		expect(r.text).not.toContain("世界观概述");
	});
	it("预算中等时先裁采样、概述保留", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.styleSample = { text: "雨".repeat(50), source: "", updatedAt: 0 };
		w.worldSummary = "雾".repeat(50);
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 90 });
		expect(r.included.hasSample).toBe(false);
		expect(r.included.hasSummary).toBe(true);
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
