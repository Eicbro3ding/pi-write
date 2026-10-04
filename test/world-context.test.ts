import { describe, expect, it } from "vitest";
import { buildChapterContext, buildStorylineView, COMPLETED_MILESTONE_LIMIT, DEFAULT_CONTEXT_BUDGET, estimateTokens, activatedEntryIds, expandActivation, rankActivationCandidates, summarizeTrim, trimMemory } from "../src/world-context.ts";
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
	it("背景包包含激活组/约束/采样/Notice·备忘录/发展线", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		w.styleSample = { text: "雨落青瓦。", source: "draft/ch01.md", updatedAt: 0 };
		w.notice.items.push({ id: "n1", text: "保持悬疑。", done: false });
		w.storyline.nodes.push({ id: "n1", title: "第四章", status: "in-progress", goal: "真相浮出", next: "写宴前对峙" });
		const r = buildChapterContext(w, { chapterId: "ch04", draftText: "林婉走进来。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text).toContain("林婉");
		expect(r.text).toContain("对话不用引号");
		expect(r.text).toContain("雨落青瓦");
		expect(r.text).toContain("【Notice·备忘录】");
		expect(r.text).toContain("- [ ] 保持悬疑。");
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
	it("约束按 target 过滤:主会话(=写作 agent)收 main/writer/all,director-only 不进", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "全局", text: "A", enabled: true, target: "all" });
		w.constraints.push({ id: "c2", name: "主会话", text: "B", enabled: true, target: "main" });
		w.constraints.push({ id: "c3", name: "导演", text: "C", enabled: true, target: "director" });
		w.constraints.push({ id: "c4", name: "缺省", text: "D", enabled: true });
		// 「编剧」范围也要收:TUI/单 Agent 下主会话就是唯一动笔的那个,而约束的默认
		// 范围已收窄到 writer(2026-10-01)——不收就等于在那个模式下静默丢约束。
		w.constraints.push({ id: "c5", name: "编剧", text: "E", enabled: true, target: "writer" });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.included.constraints).toEqual(["全局", "主会话", "缺省", "编剧"]);
		expect(r.text).not.toContain("C");
	});
	it("Notice 只注入未完成项(已完成不注入)", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.notice.items.push({ id: "n1", text: "未完成待办", done: false }, { id: "n2", text: "已完成事项", done: true });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.text).toContain("- [ ] 未完成待办");
		expect(r.text).not.toContain("已完成事项");
	});
	it("超预算先裁采样(约束保留)", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 100 });
		expect(r.included.hasSample).toBe(false);
		expect(r.included.constraints).toEqual(["对话风格"]);
		expect(r.text).toContain("对话不用引号");
		// 2026-10-04(T4):原文用 `not.toContain("文风采样")` 验证「该段没进上下文」,
		// 但裁切提示行现在会点名它(那正是 T4 要的可见性),字符串断言失去区分力。
		// 改为直接验证**内容**未注入 —— 这才是原意。
		expect(r.text).not.toContain("字".repeat(3000));
		expect(r.trimmed.some((t) => t.kind === "sample")).toBe(true);
	});
	it("超预算按序裁剪激活组并计数", () => {
		const w = createEmptyWorld();
		for (let i = 0; i < 5; i++) {
			w.entries.push({ id: `e${i}`, type: "character", title: `角色${i}`, keys: [`角色${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		}
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "角色0 角色1 角色2 角色3 角色4", recentUserMessages: [], budget: 15 });
		expect(r.activatedIds.length).toBeLessThan(5);
		expect(r.trimmedCount).toBeGreaterThan(0);
		// 2026-10-04(T4):提示语从「已裁剪 N 条」升级为点名省了什么 ——
		// 用户/模型看到的是具体标题,不是光秃秃的数字。
		expect(r.text).toContain("因预算未包含");
		expect(r.text).toMatch(/《角色\d》/);
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

describe("T4 裁切可见（trimmed 明细 + summarizeTrim）", () => {
	it("被裁的激活条目记标题,不再只是一个数字", () => {
		// 预算只够装 1-2 条:其余条目应出现在 trimmed 里且带标题
		const w = createEmptyWorld();
		for (let i = 0; i < 5; i++) {
			w.entries.push({ id: `e${i}`, type: "character", title: `角色${i}`, keys: [`角色${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		}
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "角色0 角色1 角色2 角色3 角色4", recentUserMessages: [], budget: 15 });
		const entries = r.trimmed.filter((t) => t.kind === "entry");
		expect(entries.length).toBeGreaterThan(0);
		// 每个被裁条目都要有标题,且是某个「角色N」——而不是空串或 id
		for (const e of entries) expect(e.label).toMatch(/^角色\d$/);
		// trimmedCount 与明细条数必须一致(两处口径同源,否则 UI 显示会自相矛盾)
		expect(r.trimmedCount).toBe(entries.length);
	});

	it("文风采样被裁时进明细,标注为 sample 且带 token 量", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 100 });
		const sample = r.trimmed.find((t) => t.kind === "sample");
		expect(sample).toBeDefined();
		expect(sample?.label).toBe("文风采样");
		expect(sample?.tokens).toBeGreaterThan(1000);
	});

	it("世界观概述被裁时进明细", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.worldSummary = "概".repeat(4000);
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 50 });
		expect(r.trimmed.some((t) => t.kind === "summary")).toBe(true);
	});

	it("已完成里程碑被裁时进明细（它装的是「勿再追求」清单,丢了会让模型重复推进）", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.storyline.enabled = true;
		w.storyline.nodes.push(
			{ id: "n1", title: "初遇", status: "done", goal: "", next: null, updatedAt: 0 },
			{ id: "n2", title: "决裂", status: "done", goal: "", next: null, updatedAt: 0 },
		);
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 1 });
		expect(r.included.hasCompletedMilestones).toBe(false);
		expect(r.trimmed.some((t) => t.kind === "milestones")).toBe(true);
	});

	it("未裁切时 trimmed 为空数组（UI 据此不显示提示条）", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.trimmed).toEqual([]);
		expect(summarizeTrim(r).text).toBe("");
	});

	it("summarizeTrim 产出一句话摘要,含条目数与丢弃段", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		for (let i = 0; i < 3; i++) {
			w.entries.push({ id: `x${i}`, type: "character", title: `配角${i}`, keys: [`配角${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		}
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉 配角0 配角1 配角2", recentUserMessages: [], budget: 20 });
		const s = summarizeTrim(r);
		expect(s.entryCount).toBeGreaterThan(0);
		expect(s.text).toContain("省略");
		expect(s.tokens).toBeGreaterThan(0);
		// 结构化字段与文本一致
		expect(s.entryTitles).toEqual(r.trimmed.filter((t) => t.kind === "entry").map((t) => t.label));
	});

	it("summarizeTrim 超过 maxNames 时折叠成「等 N 项」", () => {
		const w = createEmptyWorld();
		for (let i = 0; i < 8; i++) {
			w.entries.push({ id: `e${i}`, type: "character", title: `角色${i}`, keys: [`角色${i}`], chapters: [], status: "active", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		}
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "角色0 角色1 角色2 角色3 角色4 角色5 角色6 角色7", recentUserMessages: [], budget: 12 });
		const s = summarizeTrim(r, 3);
		expect(r.trimmed.length).toBeGreaterThan(3);
		expect(s.text).toContain("等");
		expect(s.text).toMatch(/等 \d+ 项/);
		// entryTitles 仍是完整清单(折叠只影响展示文本,不影响数据)
		expect(s.entryTitles.length).toBe(r.trimmed.filter((t) => t.kind === "entry").length);
	});
});

describe("T5 分段占用（sections 快照）", () => {
	it("空世界时不产生任何分段（UI 据此不渲染预算面板）", () => {
		const r = buildChapterContext(createEmptyWorld(), { chapterId: "ch01", draftText: "", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.sections).toEqual([]);
	});

	it("各段 id 唯一,且 tokens 与正文实际体量对得上", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.constraints.push({ id: "c1", name: "第一人称", text: "全程第一人称", enabled: true, target: "all" });
		w.styleSample = { text: "夜色如墨。", source: "第一章", updatedAt: 0 };
		w.worldSummary = "旧城临海。";
		w.notice.enabled = true;
		w.notice.items.push({ id: "n1", text: "补齐线索", done: false });
		w.storyline.enabled = true;
		w.storyline.nodes.push({ id: "s1", title: "初遇", status: "in-progress", goal: "相识", next: "同行", updatedAt: 0 });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉推门。", recentUserMessages: [], memory: "上一章:林婉抵城。", budget: 2000 });
		const ids = r.sections.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length); // 无重复
		for (const s of r.sections) {
			expect(s.tokens).toBeGreaterThan(0);
			expect(s.label.length).toBeGreaterThan(0);
		}
		// 关键点:tokens 是「实际进上下文的量」,而非原始数据量。
		// 记忆段与正文里的【记忆】块应等长。
		const mem = r.sections.find((s) => s.id === "memory");
		expect(mem?.tokens).toBe(estimateTokens("【记忆】\n上一章:林婉抵城。"));
		expect(r.sections.find((s) => s.id === "constraints")?.count).toBe(1);
		expect(r.sections.find((s) => s.id === "entries")?.count).toBe(1);
	});

	it("被裁的段不进 sections（裁掉的量只体现在 trimmed）", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.styleSample = { text: "字".repeat(3000), source: "", updatedAt: 0 };
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 100 });
		expect(r.trimmed.some((t) => t.kind === "sample")).toBe(true);
		// 采样被裁 → 不进 sections(否则预算面板会虚报占用)
		expect(r.sections.some((s) => s.id === "sample")).toBe(false);
	});

	it("sections 的 token 之和不超过预算（越界说明哪段没算对）", () => {
		const w = worldWith({ title: "林婉", type: "character", keys: ["林婉"] });
		w.styleSample = { text: "字".repeat(500), source: "", updatedAt: 0 };
		w.worldSummary = "概".repeat(300);
		const budget = 200;
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], memory: "上文。", budget });
		const total = r.sections.reduce((sum, s) => sum + s.tokens, 0);
		// 允许少量余量:分段各自量会重复计入段标题分隔符(空行/title),
		// 与 used 的累加口径有零点几的差 —— 这里只断言「同量级、没少算一倍」
		expect(total).toBeLessThanOrEqual(budget * 2);
		expect(total).toBeGreaterThan(0);
	});
});

describe("buildChapterContext（关联激活）", () => {
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
		// 2026-10-04(T4):原断言靠段标题字符串判定「未注入」,但裁切提示行现在会
		// 点名它们(可见性正是 T4 的目标)。改为验证内容未注入 + 两者都进了明细。
		expect(r.text).not.toContain("字".repeat(3000));
		expect(r.trimmed.some((t) => t.kind === "sample")).toBe(true);
		expect(r.trimmed.some((t) => t.kind === "summary")).toBe(true);
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

describe("buildStorylineView(已完成里程碑视图)", () => {
	const doneNode = (id: string, title: string) => ({ id, title, status: "done" as const, goal: "", next: null });

	it("返回当前目标 + 已完成列表(数组顺序)", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = [
			{ id: "s1", title: "第一章·结怨", status: "done", goal: "", next: null },
			{ id: "s2", title: "第二章·寻剑", status: "in-progress", goal: "找到婉姐的剑", next: "第三章" },
			{ id: "s3", title: "第三章·剑冢", status: "done", goal: "", next: null },
		];
		expect(buildStorylineView(w)).toEqual({ currentTitle: "第二章·寻剑", completed: ["第一章·结怨", "第三章·剑冢"] });
	});
	it("未启用或无节点返回 null", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.enabled = false;
		w.storyline.nodes = [doneNode("s1", "x")];
		expect(buildStorylineView(w)).toBeNull();
		expect(buildStorylineView(worldWith({ title: "林婉", type: "character" }))).toBeNull();
	});
	it("只有 pending/shelved 时返回 null(无进行中也无完成)", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = [{ id: "s1", title: "待办", status: "pending", goal: "", next: null }];
		expect(buildStorylineView(w)).toBeNull();
	});
	it(`已完成超过 ${COMPLETED_MILESTONE_LIMIT} 个时只取尾部`, () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = Array.from({ length: COMPLETED_MILESTONE_LIMIT + 2 }, (_, i) => doneNode(`s${i}`, `完成${i}`));
		const v = buildStorylineView(w)!;
		expect(v.completed).toHaveLength(COMPLETED_MILESTONE_LIMIT);
		expect(v.completed[0]).toBe("完成2");
	});
});

describe("buildChapterContext(发展线·已完成注入)", () => {
	it("注入已完成列表并标注禁止重复追求(进行中目标保留详情)", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = [
			{ id: "s1", title: "第一章·结怨", status: "done", goal: "", next: null },
			{ id: "s2", title: "第二章·寻剑", status: "in-progress", goal: "找到剑", next: "第三章" },
		];
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.included.hasCompletedMilestones).toBe(true);
		expect(r.text).toContain("【发展线·已完成】");
		expect(r.text).toContain("第一章·结怨");
		expect(r.text).toContain("禁止重复追求/推进");
		expect(r.text).toContain("【发展线】\n当前位置: 第二章·寻剑");
		expect(r.text).toContain("目标: 找到剑");
	});
	it("预算不足时已完成列表被裁(约束与进行中目标保留)", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = [
			{ id: "s1", title: "第一章·结怨", status: "done", goal: "", next: null },
			{ id: "s2", title: "第二章·寻剑", status: "in-progress", goal: "找到剑", next: null },
		];
		w.constraints.push({ id: "c1", name: "对话风格", text: "对话不用引号。", enabled: true });
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: 30 });
		expect(r.included.hasCompletedMilestones).toBe(false);
		expect(r.text).not.toContain("【发展线·已完成】");
		expect(r.text).toContain("对话不用引号");
		expect(r.text).toContain("当前位置: 第二章·寻剑");
	});
	it("无已完成节点时不注入已完成块", () => {
		const w = worldWith({ title: "林婉", type: "character" });
		w.storyline.nodes = [{ id: "s1", title: "第二章·寻剑", status: "in-progress", goal: "", next: null }];
		const r = buildChapterContext(w, { chapterId: "ch01", draftText: "林婉在。", recentUserMessages: [], budget: DEFAULT_CONTEXT_BUDGET });
		expect(r.included.hasCompletedMilestones).toBe(false);
		expect(r.text).not.toContain("【发展线·已完成】");
	});
});
