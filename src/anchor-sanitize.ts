/**
 * 锚文本的提示注入清洗(2026-10-13,Phase 4)。
 *
 * `memory.md` / `user.md` 的内容会被注入**系统提示词**(常驻记忆锚),所以它们是
 * 「提示注入持久化」的载体:一条写进记忆的恶意指令会活过当前回合、影响之后每个会话。
 * 本模块在**渲染锚时**逐行扫描,命中注入模式的条目替换为占位符 —— **磁盘原文不动**
 * (用户仍能在文件里看到、并用 `memory` 工具删),只有进系统提示词的那一份被拦下。
 *
 * 这是 Hermes 同名机制(`tools/threat_patterns.py` + `_sanitize_entries_for_snapshot`)
 * 的**精简版**(见 docs/agent-memory-research-2026-10-13.md §3.5):只留**高精度**模式
 * ——明确的「忽略之前的指令」类祈使、伪装成 system/assistant 的角色标签。宁可漏一个,
 * 也不误伤小说记忆里正常的「系统:」「忽略」措辞。所以模式要求出现在**条目开头附近**。
 *
 * ⚠️ 这条属于「保护作品 / 防第三方借道」,按作者的安全哲学**该留**(不是「防用户」)。
 */

/** 高精度注入模式:id 进占位符,便于用户对照。前导允许项目符号/(- 等)。 */
const BULLET = "(?:[-*·•]\\s*)?";
const INJECTION_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
	{ id: "ignore-previous", re: new RegExp(`^\\s*${BULLET}(请|现在|立刻)?\\s*(忽略|无视|忘记)\\s*(之前|以上|上面|前面|此前)?\\s*(的)?\\s*(所有)?\\s*(指令|指示|规则|要求|提示|设定)`) },
	{ id: "ignore-previous-en", re: new RegExp(`^\\s*${BULLET}(please\\s+)?(ignore|disregard|forget)\\s+(all\\s+)?(previous|prior|above|earlier)\\s+(instructions?|prompts?|rules?)`, "i") },
	{ id: "you-are-now", re: new RegExp(`^\\s*${BULLET}(从现在起|从此刻起|now,?\\s*)(你|you)\\s*(是|are)\\b`, "i") },
	{ id: "role-tag", re: new RegExp(`^\\s*${BULLET}(system|assistant|developer|系统)\\s*[:：]`, "i") },
	{ id: "follow-new", re: /(遵循|执行|按照|follow)\s*(以下|下列|these|the following)\s*(新)?\s*(指令|指示|规则|instructions)/i },
];

/** 命中注入模式的条目 → 占位符(带 id)。未命中原样返回;**保留空行**(不重排格式)。 */
export function sanitizeAnchorText(text: string): string {
	if (text.trim().length === 0) return text;
	return text
		.split("\n")
		.map((line) => {
			if (line.trim().length === 0) return line;
			const hit = INJECTION_PATTERNS.find((p) => p.re.test(line));
			return hit ? `[已拦截:该条命中提示注入模式(${hit.id}),未进系统提示词;原文仍保留在文件里]` : line;
		})
		.join("\n");
}
