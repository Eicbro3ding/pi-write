import { describe, expect, it } from "vitest";
import { ApiError } from "../web/src/api/client.ts";
import { formatProviderRefreshErrors, friendlyError } from "../web/src/errors.ts";

describe("friendlyError 技术错误 → 产品语言", () => {
	it("ApiError 404 → 文件文案", () => {
		expect(friendlyError(new ApiError(404, "文件不存在"))).toBe("暂时无法读取该文件,可能尚未创建或已被移动");
	});
	it("ApiError 401/403 → 模型与认证文案", () => {
		expect(friendlyError(new ApiError(401, "unauthorized"))).toBe("当前模型不可用,请到设置页检查模型与 API key");
		expect(friendlyError(new ApiError(403, "forbidden"))).toBe("当前模型不可用,请到设置页检查模型与 API key");
	});
	it("ENOENT / Path not found 消息 → 文件文案", () => {
		expect(friendlyError(new Error("ENOENT: no such file or directory, open 'draft/ch01.md'"))).toBe(
			"暂时无法读取该文件,可能尚未创建或已被移动",
		);
		expect(friendlyError(new Error("Path not found: x"))).toBe("暂时无法读取该文件,可能尚未创建或已被移动");
	});
	it("模型相关消息 → 模型文案", () => {
		expect(friendlyError(new Error("Model not found for provider anthropic"))).toBe(
			"当前模型不可用,请到设置页检查模型与 API key",
		);
		expect(friendlyError(new Error("No API key found"))).toBe("当前模型不可用,请到设置页检查模型与 API key");
	});
	it("网络失败 → 连接文案", () => {
		expect(friendlyError(new Error("Failed to fetch"))).toBe("网络连接失败,请检查服务是否在运行后重试");
	});
	it("未知错误保留原文", () => {
		expect(friendlyError(new Error("自定义错误 XYZ"))).toBe("自定义错误 XYZ");
		expect(friendlyError("字符串错误")).toBe("字符串错误");
		expect(friendlyError(42)).toBe("42");
		expect(friendlyError(null)).toBe("null");
	});
	it("ApiError 500 走消息通道(非状态码分支)", () => {
		expect(friendlyError(new ApiError(500, "ENOENT: no such file"))).toBe("暂时无法读取该文件,可能尚未创建或已被移动");
	});
	it("not_found 消息变体 → 文件文案", () => {
		expect(friendlyError(new Error("not_found: chapter missing"))).toBe("暂时无法读取该文件,可能尚未创建或已被移动");
	});
	it("insufficient_quota 消息变体 → 模型文案", () => {
		expect(friendlyError(new Error("insufficient_quota: rate limit"))).toBe("当前模型不可用,请到设置页检查模型与 API key");
	});
});

/**
 * 2026-10 审计 BUG-001:/api/models/refresh 返回 `{provider, message}` 对象数组,
 * 此前调用方 `join("; ")` 会把每条渲染成 `[object Object]`。
 */
describe("formatProviderRefreshErrors(目录刷新错误的统一呈现)", () => {
	it("单条 / 多条 → `provider: message`,按顺序拼接", () => {
		expect(formatProviderRefreshErrors([{ provider: "deepseek", message: "401 Authorization Required" }])).toBe(
			"deepseek: 401 Authorization Required",
		);
		expect(
			formatProviderRefreshErrors([
				{ provider: "deepseek", message: "401" },
				{ provider: "openrouter", message: "timeout" },
			]),
		).toBe("deepseek: 401; openrouter: timeout");
	});
	it("空数组 / 非数组 → 空串(调用方据此判定没有错误)", () => {
		expect(formatProviderRefreshErrors([])).toBe("");
		expect(formatProviderRefreshErrors(undefined)).toBe("");
		expect(formatProviderRefreshErrors(null)).toBe("");
		expect(formatProviderRefreshErrors("boom")).toBe("");
	});
	it("结构不完整也稳定降级,绝不吐 [object Object]", () => {
		expect(formatProviderRefreshErrors([{}])).toBe("未知供应商: 目录刷新失败(无错误详情)");
		expect(formatProviderRefreshErrors([{ provider: "x" }])).toBe("x: 目录刷新失败(无错误详情)");
		expect(formatProviderRefreshErrors([{ message: "boom" }])).toBe("未知供应商: boom");
		expect(formatProviderRefreshErrors([null, 42])).toBe("");
		expect(formatProviderRefreshErrors(["已经是字符串"])).toBe("已经是字符串");
	});
});
