import type { CacheHitInfo, ContextUsageDto } from "./types.ts";

/** 达到该占用百分比时,输入框上方显示「建议 /compact」提示。 */
export const COMPACT_HINT_PERCENT = 0.8;

/** 接近上限的提示(占用 80%-90% 为 warn,≥90% 为 err)。 */
export function contextUsageHint(
	usage: ContextUsageDto | null | undefined,
): { tone: "warn" | "err"; text: string } | null {
	if (!usage || usage.percent === null || usage.tokens === null) return null;
	if (usage.percent < COMPACT_HINT_PERCENT * 100) return null;
	const tokens = usage.tokens.toLocaleString("zh-CN");
	const window = usage.contextWindow.toLocaleString("zh-CN");
	return {
		tone: usage.percent >= 90 ? "err" : "warn",
		text: `上下文已用 ${Math.round(usage.percent)}%（约 ${tokens} / ${window} tokens）——建议输入 /compact 压缩后继续。`,
	};
}

/**
 * 从 message_end 的 assistant message 提取最近一轮提示词缓存命中(纯函数)。
 * provider 未上报缓存字段(cacheRead/cacheWrite 全 0)时返回 null——
 * 不支持缓存的端点显示「0% 命中」是误导;usage 缺失/形状不符同样返回 null。
 */
export function extractCacheHit(message: Record<string, unknown> | undefined | null): CacheHitInfo | null {
	const usage = message?.usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined;
	if (!usage) return null;
	const { input, cacheRead, cacheWrite } = usage;
	if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number") return null;
	if (cacheRead === 0 && cacheWrite === 0) return null;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return null;
	return { rate: cacheRead / promptTokens, promptTokens, cachedTokens: cacheRead };
}

/** 缓存命中徽标文案(纯函数;info 为空返回 null)。 */
export function formatCacheHit(info: CacheHitInfo | null | undefined): string | null {
	if (!info) return null;
	const pct = Math.round(info.rate * 100);
	const tokens = info.promptTokens.toLocaleString("zh-CN");
	return `缓存命中 ${pct}%（本轮 ${tokens} tokens）`;
}
