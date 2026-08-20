import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCast, saveCast, validateCast, validateSceneCast } from "../src/stage/cast.ts";
import { type CastConfig, type SceneScript } from "../src/stage/types.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stage-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function baseScript(overrides: Partial<SceneScript> = {}): SceneScript {
	return {
		scene: "s1",
		chapter: "第一章",
		version: 1,
		definition: {
			cast: { "actor-1": ["李四"], "actor-3": ["店小二"] },
			inject: { "actor-1": { characters: ["李四"], budget: 2000 } },
			rules: { minLines: 10, maxLines: 20, wrapUpWindow: 3, turn: "round-robin" },
		},
		text: {
			shared: { setting: "暮色中的酒馆。", goal: "", beats: [], tone: "", forbidden: [] },
			perActor: { "actor-1": { objective: "证明自己还清了债", examples: [] } },
		},
		...overrides,
	};
}

describe("cast.json 读写", () => {
	it("cast.json 不存在时返回空池", async () => {
		expect(await loadCast(tmp)).toEqual({ version: 1, actors: [] });
	});

	it("save/load 往返一致", async () => {
		const cast: CastConfig = {
			version: 1,
			actors: [
				{ id: "actor-1", type: "named", character: "李四", temperature: 0.9, topP: 0.95 },
				{ id: "actor-3", type: "pool" },
				{ id: "actor-4", type: "narrator" },
			],
		};
		await saveCast(tmp, cast);
		expect(await loadCast(tmp)).toEqual(cast);
	});

	it("坏条目被防御性丢弃", async () => {
		await saveCast(tmp, {
			version: 1,
			actors: [
				{ id: "ok", type: "named", character: "李四" },
				{ id: "bad", type: "weird" } as never,
			],
		});
		const loaded = await loadCast(tmp);
		expect(loaded.actors).toHaveLength(1);
		expect(loaded.actors[0].id).toBe("ok");
	});
});

describe("validateCast", () => {
	it("合法编制无错误", () => {
		const cast: CastConfig = {
			version: 1,
			actors: [
				{ id: "a", type: "named", character: "李四" },
				{ id: "b", type: "pool" },
			],
		};
		expect(validateCast(cast)).toEqual([]);
	});

	it("检出重复 id", () => {
		const cast: CastConfig = {
			version: 1,
			actors: [
				{ id: "a", type: "named", character: "李四" },
				{ id: "a", type: "pool" },
			],
		};
		expect(validateCast(cast)).toContain("演员 id 重复：a");
	});

	it("检出 named 缺 character 与 pool 绑 character", () => {
		const cast: CastConfig = {
			version: 1,
			actors: [
				{ id: "a", type: "named" },
				{ id: "b", type: "pool", character: "店小二" },
			],
		};
		const errors = validateCast(cast);
		expect(errors.some((e) => e.includes("缺少 character"))).toBe(true);
		expect(errors.some((e) => e.includes("不应绑定 character"))).toBe(true);
	});

	it("检出采样参数越界", () => {
		const cast: CastConfig = {
			version: 1,
			actors: [
				{ id: "a", type: "pool", temperature: 2.5 },
				{ id: "b", type: "pool", topP: 1.2 },
			],
		};
		const errors = validateCast(cast);
		expect(errors.some((e) => e.includes("temperature 必须在 0..2"))).toBe(true);
		expect(errors.some((e) => e.includes("topP 必须在 0..1"))).toBe(true);
	});
});

describe("validateSceneCast", () => {
	const cast: CastConfig = {
		version: 1,
		actors: [
			{ id: "actor-1", type: "named", character: "李四" },
			{ id: "actor-3", type: "pool" },
		],
	};

	it("合法选角无错误", () => {
		expect(validateSceneCast(baseScript(), cast)).toEqual([]);
	});

	it("检出编制外演员", () => {
		expect(validateSceneCast(baseScript({ definition: { ...baseScript().definition, cast: { ghost: ["路人"] } } }), cast)).toContain("选角引用了编制外的演员：ghost");
	});

	it("检出演员被分配多个角色", () => {
		const script = baseScript();
		script.definition.cast["actor-1"] = ["李四", "王五"];
		expect(validateSceneCast(script, cast).some((e) => e.includes("多个角色"))).toBe(true);
	});

	it("检出同场角色重复饰演", () => {
		const script = baseScript();
		script.definition.cast["actor-3"] = ["李四"];
		expect(validateSceneCast(script, cast).some((e) => e.includes("重复饰演"))).toBe(true);
	});
});
