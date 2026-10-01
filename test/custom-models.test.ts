/**
 * models.json 自定义模型编辑的纯逻辑(src/custom-models.ts)。
 *
 * 纯函数:只吃配置对象,不碰文件系统。
 */
import { describe, expect, it } from "vitest";
import {
	checkModelsConfigShape,
	customModelIds,
	deleteCustomModel,
	deleteCustomProvider,
	duplicateModelIds,
	hasCustomProvider,
	hasModel,
	isThinkingFormat,
	parseModelsConfig,
	parseModelsConfigStrict,
	serializeModelsConfig,
	setThinkingFormat,
	THINKING_FORMATS,
	updateCustomModel,
	upsertCustomProvider,
	type CustomModelEntry,
	type ModelsConfig,
} from "../src/custom-models.ts";

function cfg(): ModelsConfig {
	return {
		imports: ["claude-code"],
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:8787/v1",
				apiKey: "sk-custom",
				models: [
					{ id: "mock-1", name: "Mock 1", contextWindow: 1000, maxTokens: 100, input: ["text"] },
					{ id: "mock-2" },
				],
			},
			other: { baseUrl: "https://x.test", models: [{ id: "o-1" }] },
		},
	};
}

describe("parseModelsConfig / serializeModelsConfig", () => {
	it("合法对象解析;数组/null/损坏/非对象 → 空配置", () => {
		expect(parseModelsConfig('{"providers":{"a":{}}}')).toEqual({ providers: { a: {} } });
		expect(parseModelsConfig("[]")).toEqual({});
		expect(parseModelsConfig("null")).toEqual({});
		expect(parseModelsConfig("{ 坏")).toEqual({});
		expect(parseModelsConfig("")).toEqual({});
	});
	it("序列化保序、保留未知字段,带末尾换行", () => {
		const text = serializeModelsConfig({ imports: ["claude-code"], providers: { a: { apiKey: "x" } } });
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text)).toEqual({ imports: ["claude-code"], providers: { a: { apiKey: "x" } } });
	});
});

/**
 * 2026-10 审计 BUG-010:写入路径必须能把「读不懂」和「空配置」分开,否则损坏的
 * models.json 会被空快照覆盖。这里覆盖严格解析与形状校验(server 用它决定是否拒绝写入)。
 */
describe("parseModelsConfigStrict / checkModelsConfigShape", () => {
	it("合法配置 → ok;并与容错解析同值", () => {
		const text = '{"imports":["claude-code"],"providers":{"a":{"models":[{"id":"a-1"}]}}}';
		const parsed = parseModelsConfigStrict(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.cfg).toEqual(parseModelsConfig(text));
	});
	it("空对象 / 没有 providers 也合法", () => {
		expect(parseModelsConfigStrict("{}").ok).toBe(true);
		expect(parseModelsConfigStrict('{"imports":[]}').ok).toBe(true);
	});
	it("JSON 语法坏 → ok:false 且带原因", () => {
		const parsed = parseModelsConfigStrict("{ 坏");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.message).toContain("JSON 解析失败");
	});
	it("顶层不是对象 → ok:false", () => {
		for (const text of ["[]", "null", '"x"', "42", "true"]) {
			const parsed = parseModelsConfigStrict(text);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.message).toContain("顶层必须是 JSON 对象");
		}
	});
	it("providers 形状不对 / 条目非对象 / models 非数组 / 模型缺 id 都拒绝", () => {
		const cases: Array<[unknown, string]> = [
			[{ providers: [] }, "providers 必须是对象"],
			[{ providers: "x" }, "providers 必须是对象"],
			[{ providers: { a: [] } }, "providers.a 必须是对象"],
			[{ providers: { a: { models: {} } } }, "providers.a.models 必须是数组"],
			[{ providers: { a: { models: ["x"] } } }, "providers.a.models[0] 必须是对象"],
			[{ providers: { a: { models: [{}] } } }, "providers.a.models[0].id 必须是非空字符串"],
			[{ providers: { a: { models: [{ id: "" }] } } }, "providers.a.models[0].id 必须是非空字符串"],
		];
		for (const [value, message] of cases) {
			expect(checkModelsConfigShape(value)).toBe(message);
		}
	});
	it("合法形状返回 null(含空 providers 与多模型)", () => {
		expect(checkModelsConfigShape({ providers: {} })).toBeNull();
		expect(checkModelsConfigShape({ providers: { a: { models: [{ id: "x" }, { id: "y" }] } } })).toBeNull();
	});
});

/** BUG-017:历史重复条目只报告、不静默删除(迁移策略见审计台账)。 */
describe("duplicateModelIds", () => {
	it("报出同 provider 下的重复 id 与次数;不重复的不报", () => {
		const cfg: ModelsConfig = {
			providers: {
				a: { models: [{ id: "x" }, { id: "x" }, { id: "y" }] },
				b: { models: [{ id: "z" }] },
				c: {},
			},
		};
		expect(duplicateModelIds(cfg)).toEqual([{ provider: "a", model: "x", count: 2 }]);
	});
	it("没有重复 / 空配置 → 空数组", () => {
		expect(duplicateModelIds({ providers: {} })).toEqual([]);
		expect(duplicateModelIds({})).toEqual([]);
	});
});

describe("customModelIds / hasModel", () => {
	it("只收该 provider 的模型 id;未知 provider 为空", () => {
		expect([...customModelIds(cfg(), "mock")]).toEqual(["mock-1", "mock-2"]);
		expect([...customModelIds(cfg(), "other")]).toEqual(["o-1"]);
		expect([...customModelIds(cfg(), "nope")]).toEqual([]);
		expect(hasModel(cfg(), "mock", "mock-1")).toBe(true);
		expect(hasModel(cfg(), "mock", "missing")).toBe(false);
	});
});

describe("updateCustomModel", () => {
	it("改字段:name 去空白、contextWindow/maxTokens/input 覆盖", () => {
		const c = cfg();
		expect(updateCustomModel(c, "mock", "mock-1", { name: "  新名字 ", contextWindow: 2000, maxTokens: 200, input: ["text", "image"] })).toBe(true);
		expect(c.providers!.mock!.models![0]).toMatchObject({ id: "mock-1", name: "新名字", contextWindow: 2000, maxTokens: 200, input: ["text", "image"] });
	});
	it("newId 不同时改 id;相同/空则不动", () => {
		const c = cfg();
		updateCustomModel(c, "mock", "mock-2", { newId: "mock-2b" });
		expect(c.providers!.mock!.models![1]!.id).toBe("mock-2b");
		updateCustomModel(c, "mock", "mock-2b", { newId: "mock-2b" });
		expect(c.providers!.mock!.models![1]!.id).toBe("mock-2b");
	});
	it("空 name = 清掉显示名(回退到用模型 id)", () => {
		const c = cfg();
		updateCustomModel(c, "mock", "mock-1", { name: "   " });
		expect(c.providers!.mock!.models![0]!).not.toHaveProperty("name");
	});
	it("未命中返回 false", () => {
		expect(updateCustomModel(cfg(), "mock", "missing", { name: "x" })).toBe(false);
		expect(updateCustomModel(cfg(), "nope", "mock-1", { name: "x" })).toBe(false);
	});
});

describe("deleteCustomModel", () => {
	it("删掉指定模型,其余保留", () => {
		const c = cfg();
		expect(deleteCustomModel(c, "mock", "mock-1")).toBe(true);
		expect(c.providers!.mock!.models!.map((m) => m.id)).toEqual(["mock-2"]);
	});
	it("未命中/未知 provider 返回 false", () => {
		expect(deleteCustomModel(cfg(), "mock", "missing")).toBe(false);
		expect(deleteCustomModel(cfg(), "nope", "x")).toBe(false);
	});
});

describe("deleteCustomProvider", () => {
	it("删掉整个 provider,其他 provider 与顶层字段保留", () => {
		const c = cfg();
		expect(deleteCustomProvider(c, "mock")).toBe(true);
		expect(c.providers!.mock).toBeUndefined();
		expect(c.providers!.other).toBeDefined();
		expect(c.imports).toEqual(["claude-code"]);
	});
	it("不存在返回 false", () => {
		expect(deleteCustomProvider(cfg(), "nope")).toBe(false);
		expect(deleteCustomProvider({}, "nope")).toBe(false);
	});
});

describe("upsertCustomProvider / hasCustomProvider", () => {
	it("新建:写 provider 级字段,models 落成空数组(不牵进模型)", () => {
		const c: ModelsConfig = {};
		upsertCustomProvider(c, "selfhost", { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "sk-x", name: "自建" });
		expect(c.providers?.selfhost).toEqual({
			name: "自建",
			baseUrl: "http://127.0.0.1:9000/v1",
			api: "openai-completions",
			apiKey: "sk-x",
			models: [],
		});
	});

	it("不带 key 时写占位值(vendor 会跳过无 key 的 provider)", () => {
		const c: ModelsConfig = {};
		upsertCustomProvider(c, "keyless", { baseUrl: "http://127.0.0.1:9100/v1" });
		expect(c.providers?.keyless.apiKey).toBe("sk-custom");
	});

	it("已有条目:保留 models 与协议,只改传入的字段", () => {
		const c = cfg();
		upsertCustomProvider(c, "mock", { baseUrl: "http://127.0.0.1:9999/v1", name: "改过" });
		expect(c.providers?.mock.models?.map((m) => m.id)).toEqual(["mock-1", "mock-2"]);
		expect(c.providers?.mock.api).toBe("openai-completions");
		expect(c.providers?.mock.apiKey).toBe("sk-custom");
		expect(c.providers?.mock.baseUrl).toBe("http://127.0.0.1:9999/v1");
		expect(c.providers?.mock.name).toBe("改过");
	});

	it("name 传空串 = 清掉显示名(回退到 provider id)", () => {
		const c: ModelsConfig = { providers: { x: { name: "旧名", baseUrl: "https://x.test", models: [] } } };
		upsertCustomProvider(c, "x", { baseUrl: "https://x.test", name: "" });
		expect(c.providers?.x.name).toBeUndefined();
	});

	it("hasCustomProvider 只看 models.json 里有没有这个条目", () => {
		const c = cfg();
		expect(hasCustomProvider(c, "mock")).toBe(true);
		expect(hasCustomProvider(c, "openai")).toBe(false);
	});
});

/**
 * 2026-10 审计 BUG-002:思考参数协议写进模型条目的 `compat.thinkingFormat`
 * (vendor 原生位置),清除时不留空 compat 对象、不动其它 compat 开关。
 */
describe("setThinkingFormat / isThinkingFormat", () => {
	it("写入与覆盖:保留同一 compat 里的其它开关", () => {
		const entry: CustomModelEntry = { id: "m", compat: { supportsStore: false } };
		setThinkingFormat(entry, "deepseek");
		expect(entry.compat).toEqual({ supportsStore: false, thinkingFormat: "deepseek" });
		setThinkingFormat(entry, "openrouter");
		expect(entry.compat).toEqual({ supportsStore: false, thinkingFormat: "openrouter" });
	});
	it("传 null 清除 thinkingFormat;compat 变空则整个删掉", () => {
		const only: CustomModelEntry = { id: "m", compat: { thinkingFormat: "zai" } };
		setThinkingFormat(only, null);
		expect(only.compat).toBeUndefined();
		const mixed: CustomModelEntry = { id: "m", compat: { thinkingFormat: "zai", supportsStore: true } };
		setThinkingFormat(mixed, null);
		expect(mixed.compat).toEqual({ supportsStore: true });
	});
	it("原有 compat 非对象时也能安全写入", () => {
		const entry = { id: "m", compat: "坏值" } as unknown as CustomModelEntry;
		setThinkingFormat(entry, "qwen");
		expect(entry.compat).toEqual({ thinkingFormat: "qwen" });
	});
	it("isThinkingFormat 白名单与 THINKING_FORMATS 一致;未知值拒绝", () => {
		for (const f of THINKING_FORMATS) expect(isThinkingFormat(f)).toBe(true);
		expect(isThinkingFormat("nope")).toBe(false);
		expect(isThinkingFormat(42)).toBe(false);
		expect(isThinkingFormat(null)).toBe(false);
	});
	it("updateCustomModel 走 patch.thinkingFormat(与 server 的 PUT 同路)", () => {
		const cfg: ModelsConfig = { providers: { p: { models: [{ id: "m", reasoning: true }] } } };
		expect(updateCustomModel(cfg, "p", "m", { thinkingFormat: "deepseek" })).toBe(true);
		expect(cfg.providers!.p!.models![0]!.compat).toEqual({ thinkingFormat: "deepseek" });
	});
});
