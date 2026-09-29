/**
 * models.json 自定义模型编辑的纯逻辑(src/custom-models.ts)。
 *
 * 纯函数:只吃配置对象,不碰文件系统。
 */
import { describe, expect, it } from "vitest";
import {
	customModelIds,
	deleteCustomModel,
	deleteCustomProvider,
	hasCustomProvider,
	hasModel,
	parseModelsConfig,
	serializeModelsConfig,
	updateCustomModel,
	upsertCustomProvider,
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
