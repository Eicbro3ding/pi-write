/**
 * 用量 / 成本统计的 vendor 接入点(T6,2026-10-04)。
 *
 * **这是全项目唯一 import vendor 深层路径 `core/usage-totals.ts` 的地方。**
 *
 * 收口理由与 `guard.ts` 相同:`getUsageCostBreakdown` 没有从 vendor 的 index
 * 再导出。上游若把它挪进 index,本文件应该**改成从 index import 并删掉深层路径**
 * —— 那时这条注释也该跟着改。
 *
 * 对外 API 是**写作领域形状**(`UsageCostRow`),不是 vendor 形状透传:
 * vendor 的返回项将来多一个字段(比如 `currency`)不该自动漏到自研侧。
 */

// ★ 唯一的深层路径 import —— 上游若移动该文件,只改这一行
import { getUsageCostBreakdown } from "../../vendor/pi-coding-agent/src/core/usage-totals.ts";

/**
 * 成本拆分的一行:一个 provider/model 组合的累计消耗。
 *
 * 字段刻意只保留前端真正要用的三个。`key` 形如 `"anthropic/claude-..."`,
 * 是 vendor 拼的展示串 —— 我们原样透出但**不解析它**(解析会在模型名含斜杠时出错)。
 */
export interface UsageCostRow {
	/** provider/model 展示串。 */
	key: string;
	/** 累计成本(美元)。 */
	cost: number;
	/** 累计 token 数。 */
	tokens: number;
}

/**
 * 把会话条目投影为成本拆分行。
 *
 * 入参是 vendor 的会话条目数组 —— 故意用 `unknown[]` 而不是 vendor 的
 * `SessionEntry[]`:调用方(自研侧)不需要知道条目类型长什么样,只需要
 * 「把从会话里拿到的东西原样交过来」。这也让本函数在 vendor 改条目类型时
 * 依然编译得过(真正的兼容风险集中在 `getUsageCostBreakdown` 这一行的调用上,
 * 而不是在自研侧的类型上)。
 *
 * 条目形状异常(老会话、被手工改过的 jsonl)时返回空数组而不是抛错 ——
 * 「拆分不出来」不该影响总量统计,调用方也不必自己 try/catch。
 */
export function projectUsageCost(entries: readonly unknown[]): UsageCostRow[] {
	try {
		return getUsageCostBreakdown(entries as Parameters<typeof getUsageCostBreakdown>[0]).map((b) => ({
			key: b.key,
			cost: b.cost,
			tokens: b.tokens,
		}));
	} catch {
		return [];
	}
}
