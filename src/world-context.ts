import type { WorldData, WorldEntry } from "./world-data.ts";
import { isCjkChar } from "./cjk.ts";

/** 背景包默认 token 预算。 */
export const DEFAULT_CONTEXT_BUDGET = 2000;

/** 跨章节记忆(memory.md)注入的 token 预算。 */
export const DEFAULT_MEMORY_BUDGET = 1500;

export interface ChapterContextInput {
	/** 当前章节 id,如 "ch04"。 */
	chapterId: string;
	/** 当前章草稿全文。 */
	draftText: string;
	/** 最近用户消息(新→旧顺序,取前 2 条)。 */
	recentUserMessages: string[];
	/** memory.md 全文(注入端已按预算裁剪;可为空字符串)。 */
	memory?: string;
	/** 背景包 token 预算。 */
	budget: number;
}

export interface ChapterContextResult {
	text: string;
	activatedIds: string[];
	trimmedCount: number;
	included: {
		constraints: string[];
		hasSample: boolean;
		hasNotice: boolean;
		storylineNode: string | null;
	};
}

const TYPE_PRIORITY: Record<WorldEntry["type"], number> = { character: 0, world: 1, timeline: 2, outline: 3 };

/** 近似 token 数:CJK 每字 1,其余按 4 字符 1(CJK 判定统一在 cjk.ts)。 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const ch of text) {
		if (isCjkChar(ch.codePointAt(0)!)) cjk++;
	}
	const rest = text.length - cjk;
	return cjk + Math.ceil(rest / 4);
}

/**
 * 按预算裁剪 memory.md:记忆纪律是「最新要点在最上面,旧的往下挤」,
 * 因此超预算时从开头逐段保留,裁掉最旧的段落,尾部注明(agent 会看到
 * 提示,下一轮维护时主动精简)。
 */
export function trimMemory(text: string, budget: number = DEFAULT_MEMORY_BUDGET): string {
	if (text.trim().length === 0) return "";
	if (estimateTokens(text) <= budget) return text.trim();
	const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
	const kept: string[] = [];
	let used = 0;
	for (const block of blocks) {
		const tokens = estimateTokens(block);
		if (used > 0 && used + tokens > budget) break;
		if (tokens > budget) {
			// 单段就超预算:硬截断到预算内(保头部)
			kept.push(block.slice(0, Math.max(1, Math.floor(budget * 1.5))));
			used += budget;
			break;
		}
		kept.push(block);
		used += tokens;
	}
	return kept.join("\n\n") + "\n\n(记忆超出容量,已截断旧条目,请精简后重新整理)";
}

function chapterMatches(entry: WorldEntry, chapterId: string): boolean {
	return entry.chapters.length === 0 || entry.chapters.includes(chapterId);
}

function keysHit(entry: WorldEntry, haystacks: string[]): boolean {
	if (entry.keys.length === 0) return false;
	for (const key of entry.keys) {
		if (key.length === 0) continue;
		for (const hay of haystacks) {
			if (hay.includes(key)) return true;
		}
	}
	return false;
}

/** chapters 过滤 + keys 命中扫描输入;按优先级(人物>世界>时间线>大纲)排序返回。 */
export function activatedEntryIds(data: WorldData, input: ChapterContextInput): string[] {
	const haystacks = [input.draftText, ...input.recentUserMessages].filter((s) => s.length > 0);
	if (haystacks.length === 0) return [];
	const hit = data.entries.filter(
		(e) => e.active && chapterMatches(e, input.chapterId) && keysHit(e, haystacks),
	);
	return hit.sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]).map((e) => e.id);
}

/** 组装背景包文本(常驻组 + 激活组,预算裁剪)。 */
export function buildChapterContext(data: WorldData, input: ChapterContextInput): ChapterContextResult {
	const result: ChapterContextResult = { text: "", activatedIds: [], trimmedCount: 0, included: { constraints: [], hasSample: false, hasNotice: false, storylineNode: null } };

	// 常驻组:启用的约束 + 采样(采样超预算时裁掉,约束保留)
	const enabledConstraints = data.constraints.filter((c) => c.enabled);
	let resident = "";
	if (enabledConstraints.length > 0) {
		resident += "【写作约束】\n";
		for (const c of enabledConstraints) {
			resident += `- ${c.name}: ${c.text}\n`;
			result.included.constraints.push(c.name);
		}
	}
	if (data.styleSample && data.styleSample.text.length > 0) {
		resident += `【文风采样】(来源: ${data.styleSample.source || "未知"})\n${data.styleSample.text}\n`;
		result.included.hasSample = true;
	}
	if (estimateTokens(resident) > input.budget) {
		const sampleStart = resident.indexOf("【文风采样】");
		if (sampleStart >= 0) {
			resident = resident.slice(0, sampleStart);
			result.included.hasSample = false;
		}
	}
	let used = estimateTokens(resident);

	// 激活组(预算内按优先级装填;首条无条件装入保证"至少一条相关设定")
	const ids = activatedEntryIds(data, input);
	const activeParts: string[] = [];
	for (const id of ids) {
		const entry = data.entries.find((e) => e.id === id);
		if (!entry) continue;
		const line = `- ${entry.title}: ${entry.body}`;
		const tokens = estimateTokens(line);
		if (used + tokens > input.budget && activeParts.length > 0) {
			result.trimmedCount++;
			continue;
		}
		activeParts.push(line);
		result.activatedIds.push(id);
		used += tokens;
	}

	// Notice 与发展线(常驻,不可裁)
	let tail = "";
	if (data.notice.enabled && data.notice.text.length > 0) {
		tail += `【Notice】\n${data.notice.text}\n`;
		result.included.hasNotice = true;
	}
	if (data.storyline.enabled) {
		const current = data.storyline.nodes.find((n) => n.status === "in-progress");
		if (current) {
			tail += `【发展线】\n当前位置: ${current.title}\n`;
			if (current.goal) tail += `目标: ${current.goal}\n`;
			if (current.next) tail += `下一步: ${current.next}\n`;
			result.included.storylineNode = current.id;
		}
	}

	const parts: string[] = [];
	// 跨章节记忆放最前:agent 最先看到它,再读本章相关设定
	if (input.memory && input.memory.trim().length > 0) {
		parts.push(`【记忆】\n${input.memory.trim()}`);
	}
	if (activeParts.length > 0) parts.push(`【世界书·本章相关】\n${activeParts.join("\n")}`);
	const residentBody = resident.trim();
	if (residentBody.length > 0) parts.push(residentBody);
	const tailBody = tail.trim();
	if (tailBody.length > 0) parts.push(tailBody);
	let text = parts.join("\n\n");
	if (result.trimmedCount > 0) text += `\n(已裁剪 ${result.trimmedCount} 条,需要可 read world.json)`;
	return { ...result, text: text.trim() };
}
