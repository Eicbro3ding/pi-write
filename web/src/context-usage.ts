import type { ContextUsageDto } from "./types.ts";

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
