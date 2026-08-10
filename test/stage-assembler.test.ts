import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActorContextBlocks, formatStageLines, resolveWorldInjection, resolveWorldRefs } from "../src/stage/assembler.ts";
import { countStage, formatCounterBlock } from "../src/stage/counters.ts";
import { cjkCount } from "../src/cjk.ts";
import { makeStageEntry } from "../src/stage/stage-store.ts";
import { createEmptyWorld, saveWorld } from "../src/world-data.ts";
import { type SceneRules, type SceneScript, type StageEntry } from "../src/stage/types.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stage-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const rules: SceneRules = { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" };

function script(overrides: Partial<SceneScript> = {}): SceneScript {
	return {
		scene: "s1",
		chapter: "第一章",
		version: 1,
		definition: {
			cast: { "actor-1": ["李四"] },
			inject: { "actor-1": { characters: ["李四"], budget: 2000 } },
			rules,
		},
		text: {
			shared: { setting: "暮色中的酒馆。", goal: "重逢", beats: ["拍1"], tone: "克制", forbidden: ["禁现代词"] },
			perActor: { "actor-1": { objective: "证明自己还清了债", examples: ["王五: 三年了。", "李四: ……嗯。"] } },
		},
		...overrides,
	};
}

function entries(n: number, from = 1): StageEntry[] {
	return Array.from({ length: n }, (_, i) => makeStageEntry("s1", from + i, "actor-1", "李四", `话${from + i}`));
}

describe("countStage / cjkCount", () => {
	it("cjkCount 只数 CJK 字符（标点不计）", () => {
		expect(cjkCount("三年了，你还活着。abc 123")).toBe(7);
		expect(cjkCount("")).toBe(0);
	});

	it("统计条数/演员/角色/轮次/字数", () => {
		const list = [
			makeStageEntry("s1", 1, "actor-1", "李四", "三年了，你还活着。"),
			makeStageEntry("s1", 2, "actor-3", "店小二", "还是老位置？"),
			makeStageEntry("s1", 3, "actor-1", "李四", "嗯。"),
		];
		const counts = countStage(list);
		expect(counts.lines).toBe(3);
		expect(counts.turn).toBe(3);
		expect(counts.perActor).toEqual({ "actor-1": 2, "actor-3": 1 });
		expect(counts.perCharacter).toEqual({ 李四: 2, 店小二: 1 });
		expect(counts.cnChars).toBe(13);
	});

	it("空幕统计为全零", () => {
		const counts = countStage([]);
		expect(counts).toEqual({ lines: 0, turn: 0, perActor: {}, perCharacter: {}, cnChars: 0 });
	});
});

describe("formatCounterBlock", () => {
	const counts = countStage(entries(12, 1));

	it("正常状态含进度与下限上限", () => {
		const block = formatCounterBlock(counts, "actor-1", "normal", rules);
		expect(block).toContain("【场务·演员不可在演出中提及此信息】");
		expect(block).toContain("对话 12 条（下限 10，上限 20）");
		expect(block).toContain("本演员 12 条");
		expect(block).toContain("状态：正常轮转");
	});

	it("收尾状态用 wrapRemaining 或默认窗口", () => {
		expect(formatCounterBlock(counts, "actor-1", "wrapping", rules, 2)).toContain("剩余约 2 条");
		expect(formatCounterBlock(counts, "actor-1", "wrapping", rules)).toContain("剩余约 3 条");
	});
});

describe("resolveWorldRefs（双通道容错：id/名称/keys）", () => {
	const world = createEmptyWorld();
	world.entries.push(
		{ id: "c1", type: "character", title: "李四", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "跑船十年", avatar: null, images: [], updatedAt: 0 },
		{ id: "c2", type: "character", title: "王五", keys: ["账本"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "酒馆老板", avatar: null, images: [], updatedAt: 0 },
		{ id: "w1", type: "world", title: "酒馆", keys: ["旧账本"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "暮色中的酒馆", avatar: null, images: [], updatedAt: 0 },
	);

	it("传 id 命中", () => {
		expect(resolveWorldRefs(world, ["c1"]).matched.map((e) => e.title)).toEqual(["李四"]);
	});

	it("传名称（title）命中", () => {
		expect(resolveWorldRefs(world, ["王五"]).matched.map((e) => e.title)).toEqual(["王五"]);
	});

	it("传 keys 关键词命中", () => {
		expect(resolveWorldRefs(world, ["账本"]).matched.map((e) => e.title)).toEqual(["王五"]);
	});

	it("混合引用去重且 missing 报告", () => {
		const result = resolveWorldRefs(world, ["c1", "李四", "幽灵", "旧账本"]);
		expect(result.matched.map((e) => e.title).sort()).toEqual(["李四", "酒馆"]);
		expect(result.missing).toEqual(["幽灵"]);
	});
});

describe("resolveWorldInjection（世界书注入，include-only）", () => {
	it("按角色名注入 character 条目，跳过元信息", async () => {
		const world = createEmptyWorld();
		world.entries.push(
			{ id: "c1", type: "character", title: "李四", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "跑船十年，沉默寡言", avatar: null, images: [], updatedAt: 0 },
			{ id: "c2", type: "character", title: "王五", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "酒馆老板", avatar: null, images: [], updatedAt: 0 },
			{ id: "w1", type: "world", title: "酒馆", keys: ["旧账本"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "暮色中的酒馆", avatar: null, images: [], updatedAt: 0 },
		);
		world.notice.text = "秘密：债已还清（导演才知道）";
		await saveWorld(tmp, world);
		const result = await resolveWorldInjection(tmp, { characters: ["李四"], world: ["酒馆"], budget: 2000 });
		expect(result?.text).toContain("【角色·李四】跑船十年，沉默寡言");
		expect(result?.text).toContain("【世界·酒馆】暮色中的酒馆");
		expect(result?.text).not.toContain("秘密");
		expect(result?.text).not.toContain("王五"); // 未指定的不注入
		expect(result?.missing).toEqual([]);
	});

	it("按 keys 匹配 world 条目", async () => {
		const world = createEmptyWorld();
		world.entries.push(
			{ id: "w1", type: "world", title: "旧账本", keys: ["账本"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "三年前的债", avatar: null, images: [], updatedAt: 0 },
		);
		await saveWorld(tmp, world);
		const result = await resolveWorldInjection(tmp, { characters: [], world: ["账本"], budget: 2000 });
		expect(result?.text).toContain("三年前的债");
	});

	it("无规则返回 null", async () => {
		expect(await resolveWorldInjection(tmp, undefined)).toBeNull();
	});

	it("引用不存在/类型不可注入 → 归入 missing 而非静默", async () => {
		const world = createEmptyWorld();
		world.entries.push(
			{ id: "c1", type: "character", title: "李四", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "跑船十年", avatar: null, images: [], updatedAt: 0 },
			{ id: "t1", type: "timeline", title: "三年前的债", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "王五借钱给李四", avatar: null, images: [], updatedAt: 0 },
		);
		await saveWorld(tmp, world);
		const result = await resolveWorldInjection(tmp, { characters: ["幽灵", "三年前的债"], budget: 100 });
		expect(result?.text).toBeNull();
		expect(result?.missing.some((m) => m.includes("幽灵"))).toBe(true);
		expect(result?.missing.some((m) => m.includes("timeline 类型不可注入"))).toBe(true);
	});
});

describe("buildActorContextBlocks", () => {
	it("切片只取最近 N 轮", () => {
		const all = entries(30);
		const blocks = buildActorContextBlocks(script(), all, "actor-1", "normal", { sliceMax: 5 });
		expect(blocks.slice).toHaveLength(5);
		expect(blocks.slice[0].turn).toBe(26);
	});

	it("指令 = 结构化 shared + 定向块", () => {
		const blocks = buildActorContextBlocks(script(), [], "actor-1", "normal");
		expect(blocks.scriptLines.join("\n")).toContain("【角色任务】证明自己还清了债");
		expect(blocks.scriptLines.join("\n")).toContain("【场景】暮色中的酒馆。");
	});

	it("世界书注入块透传", () => {
		const blocks = buildActorContextBlocks(script(), [], "actor-1", "normal", {
			worldInjection: "【角色·李四】跑船十年",
		});
		expect(blocks.worldBlock).toContain("跑船十年");
	});

	it("计数块永远在尾部且实时", () => {
		const blocks = buildActorContextBlocks(script(), entries(7), "actor-1", "wrapping", { wrapRemaining: 2 });
		expect(blocks.counterBlock).toContain("对话 7 条");
		expect(blocks.counterBlock).toContain("剩余约 2 条");
	});
});

describe("formatStageLines", () => {
	it("对白行与叙述者行格式", () => {
		const list = [
			makeStageEntry("s1", 1, "actor-1", "李四", "三年了。"),
			makeStageEntry("s1", 2, "actor-3", "叙述者", "烛火晃了一下。"),
		];
		expect(formatStageLines(list)).toEqual(["李四: 三年了。", "（烛火晃了一下。）"]);
	});
});
