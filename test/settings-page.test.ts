import { describe, expect, it } from "vitest";
import { modelRef, pickFallbackModel } from "../web/src/pages/SettingsPage.tsx";

describe("SettingsPage 模型工具(纯函数)", () => {
	it("modelRef:对象元素归一为 provider/id", () => {
		expect(modelRef({ id: "claude-3-5-sonnet", provider: "anthropic" })).toBe("anthropic/claude-3-5-sonnet");
	});
	it("modelRef:字符串透传,空/形状不符返回 null", () => {
		expect(modelRef("anthropic/sonnet")).toBe("anthropic/sonnet");
		expect(modelRef("")).toBeNull();
		expect(modelRef(null)).toBeNull();
		expect(modelRef(undefined)).toBeNull();
		expect(modelRef({ id: "x" })).toBeNull();
		expect(modelRef({ provider: "anthropic" })).toBeNull();
		expect(modelRef(42)).toBeNull();
	});
});

describe("SettingsPage.pickFallbackModel", () => {
	const models = [
		{ id: "gpt-4o", provider: "openai" },
		{ id: "deepseek-chat", provider: "deepseek" },
	];
	it("当前模型仍在列表 → 不回退", () => {
		expect(pickFallbackModel("openai/gpt-4o", models)).toBeNull();
	});
	it("当前模型消失 → 回退第一个", () => {
		expect(pickFallbackModel("anthropic/sonnet", models)).toBe("openai/gpt-4o");
	});
	it("无当前模型或列表为空 → 不回退", () => {
		expect(pickFallbackModel(null, models)).toBeNull();
		expect(pickFallbackModel("anthropic/sonnet", [])).toBeNull();
	});
});
