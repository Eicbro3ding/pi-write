/**
 * 世界书条目 keys(触发词)解析 —— 纯函数,无组件/DOM 依赖,便于单测。
 * EntryForm 与 EntryCard 共用(原各自复制 commitKeys,2026-08-10 收敛)。
 */

/**
 * keys 输入 → 数组:中英文逗号分隔,trim + 去空 + 去重(保持首次出现顺序)。
 * 仅负责解析,不校验空结果(空结果由调用方决定回退)。
 */
export function keysFromInput(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of raw.split(/[,，]/)) {
		const t = s.trim();
		if (t === "" || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

/**
 * keys 草稿提交决策(EntryForm 与 EntryCard 共用,避免两处行为漂移):
 * - 真空输入(trim 后为空)→ 提交 [] 清空 keys,草稿置空;
 * - 仅含分隔符等解析结果为空 → 不提交(null),草稿回退显示原值;
 * - 正常 → 提交解析结果,草稿规范化为 join(", ")。
 */
export function resolveKeysCommit(draft: string, currentKeys: string[]): { draft: string; keys: string[] | null } {
	if (draft.trim() === "") return { draft: "", keys: [] };
	const parsed = keysFromInput(draft);
	if (parsed.length === 0) return { draft: currentKeys.join(", "), keys: null };
	return { draft: parsed.join(", "), keys: parsed };
}
