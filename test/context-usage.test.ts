/**
 * 上下文占用提示纯逻辑:80% 起提示、90% 升级为错误样式;tokens 未知不提示。
 */
import { describe, expect, it } from "vitest";
import { COMPACT_HINT_PERCENT, contextUsageHint, extractCacheHit, formatCacheHit } from "../web/src/context-usage.ts";

describe("contextUsageHint", () => {
	it("低于阈值 / 未知 tokens 不提示", () => {
		expect(contextUsageHint(null)).toBeNull();
		expect(contextUsageHint(undefined)).toBeNull();
		expect(contextUsageHint({ tokens: null, contextWindow: 1000, percent: null })).toBeNull();
		expect(contextUsageHint({ tokens: 700, contextWindow: 1000, percent: 70 })).toBeNull();
	});
	it("80% 提示 warn,90% 提示 err", () => {
		expect(COMPACT_HINT_PERCENT).toBe(0.8);
		const warn = contextUsageHint({ tokens: 1600, contextWindow: 2000, percent: 80 })!;
		expect(warn.tone).toBe("warn");
		expect(warn.text).toContain("/compact");
		const err = contextUsageHint({ tokens: 1800, contextWindow: 2000, percent: 90 })!;
		expect(err.tone).toBe("err");
	});
});

describe("extractCacheHit / formatCacheHit(缓存命中徽标)", () => {
	it("从 assistant usage 计算命中率", () => {
		const hit = extractCacheHit({ usage: { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 500 } })!;
		expect(hit).toEqual({ rate: 9000 / 10500, promptTokens: 10500, cachedTokens: 9000 });
		expect(formatCacheHit(hit)).toBe(`缓存命中 ${Math.round((9000 / 10500) * 100)}%（本轮 10,500 tokens）`);
	});
	it("usage 缺失/形状不符返回 null", () => {
		expect(extractCacheHit(undefined)).toBeNull();
		expect(extractCacheHit(null)).toBeNull();
		expect(extractCacheHit({})).toBeNull();
		expect(extractCacheHit({ usage: { input: "x" } })).toBeNull();
	});
	it("provider 未上报缓存字段(cacheRead/cacheWrite 全 0)返回 null——不支持缓存的端点不显示误导性 0%", () => {
		expect(extractCacheHit({ usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 } })).toBeNull();
	});
	it("formatCacheHit 对空值返回 null", () => {
		expect(formatCacheHit(null)).toBeNull();
		expect(formatCacheHit(undefined)).toBeNull();
	});
});