/**
 * 供应商列表纯逻辑(web/src/provider-list-logic.ts)。
 *
 * 背景:设置页「管理供应商」左栏原来只列 `configured` 的供应商,用户看到
 * 「共 17 个可选,点上方浏览全部」却找不到那 17 个(那颗按钮通向的是自定义表单)。
 * 现在左栏列全部,已配置的排前面 —— 但排序是后端做的,这里只覆盖过滤/计数/文案。
 */
import { describe, expect, it } from "vitest";
import {
	currentModelOf,
	filterProviders,
	providerCanHoldApiKey,
	providerCountLabel,
	providerCounts,
	providerRowSub,
	unconfiguredHint,
} from "../web/src/provider-list-logic.ts";
import type { ProviderInfo } from "../web/src/types.ts";

function p(id: string, name: string, configured = false, authKind: ProviderInfo["authKind"] = "api_key"): ProviderInfo {
	return { id, name, configured, authKind };
}

/** 真实形状:后端按「已配置优先 → id 字母序」返回,这里照抄那一份。 */
const LIST: ProviderInfo[] = [
	p("deepseek", "DeepSeek", true),
	p("ant-ling", "Ant Ling"),
	p("anthropic", "Anthropic", false, "both"),
	p("openai-codex", "OpenAI Codex", false, "oauth"),
	p("qwen-token-plan-cn", "Qwen Token Plan CN"),
];

describe("filterProviders", () => {
	it("空查询原样返回,且保持后端顺序(不重排)", () => {
		expect(filterProviders(LIST, "").map((x) => x.id)).toEqual(LIST.map((x) => x.id));
		expect(filterProviders(LIST, "   ").map((x) => x.id)).toEqual(LIST.map((x) => x.id));
	});
	it("命中 id(大小写不敏感)", () => {
		expect(filterProviders(LIST, "DEEP").map((x) => x.id)).toEqual(["deepseek"]);
		expect(filterProviders(LIST, "codex").map((x) => x.id)).toEqual(["openai-codex"]);
	});
	it("命中显示名(带空格的名字也能搜到)", () => {
		expect(filterProviders(LIST, "token plan").map((x) => x.id)).toEqual(["qwen-token-plan-cn"]);
	});
	it("未配置的供应商也能被搜到(这是本次改动的重点)", () => {
		expect(filterProviders(LIST, "anthropic").map((x) => x.id)).toEqual(["anthropic"]);
	});
	it("无匹配返回空数组(交给组件渲染空态)", () => {
		expect(filterProviders(LIST, "zzzz")).toEqual([]);
	});
	it("原数组不被改动", () => {
		const snapshot = LIST.map((x) => x.id);
		filterProviders(LIST, "deep");
		expect(LIST.map((x) => x.id)).toEqual(snapshot);
	});
});

describe("providerCounts / providerCountLabel", () => {
	it("计数", () => {
		expect(providerCounts(LIST)).toEqual({ total: 5, configured: 1 });
		expect(providerCounts([])).toEqual({ total: 0, configured: 0 });
	});
	it("标题如实说清总数与已配置数(不再只说「已配置 N」)", () => {
		expect(providerCountLabel({ total: 17, configured: 1 })).toBe("供应商 17 · 已配置 1");
		expect(providerCountLabel({ total: 0, configured: 0 })).toBe("供应商");
	});
});

describe("providerCanHoldApiKey", () => {
	it("api_key / both 可以填", () => {
		expect(providerCanHoldApiKey("api_key")).toBe(true);
		expect(providerCanHoldApiKey("both")).toBe(true);
	});
	it("oauth / ambient 不行(后端写 key 会 400,前端不该给输入框)", () => {
		expect(providerCanHoldApiKey("oauth")).toBe(false);
		expect(providerCanHoldApiKey("ambient")).toBe(false);
	});
});

describe("currentModelOf", () => {
	it("取出属于该 provider 的模型 id", () => {
		expect(currentModelOf("deepseek/deepseek-v4-flash", "deepseek")).toBe("deepseek-v4-flash");
	});
	it("provider 不匹配 / 无斜杠 / 空值 → null", () => {
		expect(currentModelOf("openai/gpt-4o", "deepseek")).toBeNull();
		expect(currentModelOf("deepseek-v4-flash", "deepseek")).toBeNull();
		expect(currentModelOf(null, "deepseek")).toBeNull();
		expect(currentModelOf("", "deepseek")).toBeNull();
	});
});

describe("providerRowSub(左栏行内小字)", () => {
	it("已配置且在用 → 显示模型 id", () => {
		expect(providerRowSub(LIST[0], "deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
	});
	it("已配置但没选中模型 → 未选择模型", () => {
		expect(providerRowSub(LIST[0], null)).toBe("未选择模型");
		expect(providerRowSub(LIST[0], "openai/gpt-4o")).toBe("未选择模型");
	});
	it("未配置 → 未配置;oauth → OAuth 登录(而不是让用户以为能填 key)", () => {
		expect(providerRowSub(LIST[2], null)).toBe("未配置");
		expect(providerRowSub(LIST[3], null)).toBe("OAuth 登录");
	});
});

describe("unconfiguredHint(未配置时右栏该说什么)", () => {
	it("能填 key 的返回 null(渲染输入框)", () => {
		expect(unconfiguredHint(p("anthropic", "Anthropic", false, "both"))).toBeNull();
	});
	it("纯 oauth 给说明而不是输入框", () => {
		const hint = unconfiguredHint(p("openai-codex", "OpenAI Codex", false, "oauth"));
		expect(hint).toContain("OAuth");
	});
	it("ambient 也给说明", () => {
		expect(unconfiguredHint(p("x", "X", false, "ambient"))).toContain("本机");
	});
});
