import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectStageScriptErrors, prepareStageScriptArgs } from "../src/stage/stage-extension.ts";
import { createEmptyWorld, type WorldData } from "../src/world-data.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stage-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function worldWith(): WorldData {
	const world = createEmptyWorld();
	world.entries.push(
		{ id: "c1", type: "character", title: "李四", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "跑船十年", avatar: null, images: [], updatedAt: 0 },
		{ id: "c2", type: "character", title: "王五", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "酒馆老板", avatar: null, images: [], updatedAt: 0 },
		{ id: "w1", type: "world", title: "酒馆", keys: ["旧账本"], chapters: [], status: "active", active: true, parent: null, tags: [], body: "暮色中的酒馆", avatar: null, images: [], updatedAt: 0 },
	);
	return world;
}

describe("prepareStageScriptArgs（宽容解析）", () => {
	it("beats/forbidden/examples 传字符串 → 按 | 或换行 split", () => {
		const prepared = prepareStageScriptArgs({
			text: { shared: { setting: "酒馆", beats: "拍1|拍2\n拍3", forbidden: "禁1|禁2" }, perActor: { "actor-1": { objective: "x", examples: "示例1|示例2" } } },
		}) as { text: { shared: Record<string, unknown>; perActor: Record<string, Record<string, unknown>> } };
		expect(prepared.text.shared.beats).toEqual(["拍1", "拍2", "拍3"]);
		expect(prepared.text.shared.forbidden).toEqual(["禁1", "禁2"]);
		expect(prepared.text.perActor["actor-1"].examples).toEqual(["示例1", "示例2"]);
	});

	it("shared 缺字段补空值", () => {
		const prepared = prepareStageScriptArgs({ text: { perActor: {} } }) as { text: { shared: Record<string, unknown> } };
		expect(prepared.text.shared).toEqual({ setting: "", goal: "", beats: [], tone: "", forbidden: [] });
	});

	it("perActor 传数组 → throw 中文错误（带格式示例）", () => {
		expect(() => prepareStageScriptArgs({ text: { perActor: ["李四"] } })).toThrow(/perActor 必须是对象/);
	});

	it("非对象参数 → throw 中文错误", () => {
		expect(() => prepareStageScriptArgs("剧本内容")).toThrow(/必须是对象/);
		expect(() => prepareStageScriptArgs(null)).toThrow(/必须是对象/);
	});
});

describe("collectStageScriptErrors（字段级中文校验）", () => {
	const world = worldWith();

	it("合法参数零错误", () => {
		const params = {
			cast: { "actor-1": ["李四"] },
			inject: { "actor-1": { characters: ["李四"], world: ["酒馆"] } },
			text: { perActor: { "actor-1": { objective: "证明自己还清了债", examples: ["示例"] } } },
		};
		expect(collectStageScriptErrors(params as never, world)).toEqual([]);
	});

	it("perActor 引用不在选角表 → 列出当前演员", () => {
		const params = {
			cast: { "actor-1": ["李四"] },
			text: { perActor: { "actor-9": { objective: "x" } } },
		};
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("actor-9") && e.includes("不在选角表") && e.includes("actor-1"))).toBe(true);
	});

	it("缺 objective → 带修正示例", () => {
		const params = { cast: { "actor-1": ["李四"] }, text: { perActor: { "actor-1": {} } } };
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("缺少 objective") && e.includes("证明自己还清了债"))).toBe(true);
	});

	it("examples 超 3 轮 → 提示上限", () => {
		const params = {
			cast: { "actor-1": ["李四"] },
			text: { perActor: { "actor-1": { objective: "x", examples: ["1", "2", "3", "4"] } } },
		};
		expect(collectStageScriptErrors(params as never, world).some((e) => e.includes("最多 3 轮"))).toBe(true);
	});

	it("inject 引用不存在 → 列出世界书可用条目（id+title）", () => {
		const params = { inject: { "actor-1": { characters: ["幽灵"] } } };
		const errors = collectStageScriptErrors(params as never, world);
		const hit = errors.find((e) => e.startsWith("inject[actor-1]"));
		expect(hit).toBeDefined();
		expect(hit).toContain("未匹配到条目：幽灵");
		expect(hit).toContain("李四(id:c1)");
		expect(hit).toContain("王五(id:c2)");
		expect(hit).toContain("world_find");
	});

	it("inject 引用 timeline 类型 → 提示不可注入", () => {
		const worldWithTimeline = worldWith();
		worldWithTimeline.entries.push({
			id: "t1", type: "timeline", title: "三年前的债", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "借钱", avatar: null, images: [], updatedAt: 0,
		});
		const params = { inject: { "actor-1": { characters: ["三年前的债"] } } };
		const errors = collectStageScriptErrors(params as never, worldWithTimeline);
		expect(errors.some((e) => e.includes("类型不可注入"))).toBe(true);
	});
});

describe("collectStageScriptErrors 强制 perActor（2026-08-11）", () => {
	const world = worldWith();

	it("perActor 整体缺失 → 报缺失（含正确格式示例）", () => {
		const params = { cast: { "actor-1": ["李四"] }, text: { shared: { setting: "酒馆" } } };
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("text.perActor 缺失或为空") && e.includes("objective 必填"))).toBe(true);
	});

	it("perActor 为空对象 → 报缺失", () => {
		const params = { cast: { "actor-1": ["李四"] }, text: { perActor: {} } };
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("text.perActor 缺失或为空"))).toBe(true);
	});

	it("cast 演员缺 perActor 条目 → 逐条列出缺的角色", () => {
		const params = {
			cast: { "actor-1": ["李四"], "actor-2": ["王五"] },
			text: { perActor: { "actor-1": { objective: "x" } } },
		};
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("演员 actor-2 缺少演出指令") && e.includes("text.perActor.actor-2"))).toBe(true);
		// actor-1 有条目 → 不报缺失
		expect(errors.some((e) => e.includes("actor-1 缺少演出指令"))).toBe(false);
	});

	it("perActor 传数组 → 报缺失或格式错误（不静默）", () => {
		const params = { cast: { "actor-1": ["李四"] }, text: { perActor: ["李四"] } };
		const errors = collectStageScriptErrors(params as never, world);
		expect(errors.some((e) => e.includes("text.perActor 缺失或为空"))).toBe(true);
	});
});
