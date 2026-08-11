import type { WorldData, WorldEntry } from "./world-data.ts";
import { isCjkChar } from "./cjk.ts";

/** 背景包默认 token 预算。 */
export const DEFAULT_CONTEXT_BUDGET = 2000;

/** 跨章节记忆(memory.md)注入的 token 预算。 */
export const DEFAULT_MEMORY_BUDGET = 1500;

/** 关联激活默认深度(0 = 关闭,与旧行为一致;>0 启用多源 BFS 展开)。 */
export const DEFAULT_ACTIVATION_DEPTH = 0;

export interface ChapterContextInput {
	/** 当前章节 id,如 "ch04"。 */
	chapterId: string;
	/** 当前章草稿全文。 */
	draftText: string;
	/** 最近用户消息(新→旧顺序,取前 2 条)。 */
	recentUserMessages: string[];
	/** memory.md 全文(注入端已按预算裁剪;可为空字符串)。 */
	memory?: string;
	/** 关联激活深度(跳距上限;缺省/0 = 仅关键词命中不展开,与旧行为一致)。 */
	activationDepth?: number;
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
		hasSummary: boolean;
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

/** 关联激活候选:递归命中的条目及其元数据。 */
export interface ActivationCandidate {
	id: string;
	/** 距最近种子的最短跳数(BFS 层号)。 */
	dist: number;
	/** 到达边是否强关联(emphasized);同层多条边时强边优先。 */
	emphasized: boolean;
}

/**
 * 多源 BFS 关联展开(2026-08-11 设计 §4.3):从种子集合出发沿 relations
 * 双向遍历(无视 arrow 方向——关系即关联),深度 = 跳距上限(半径,不是
 * 步数计数器——死路/分支/多树互不消耗)。visited 去重 = 回环防护(每条目
 * 至多激活一次);既是种子又被递归命中的节点保持种子身份。可注入过滤
 * (active + chapters)与种子产线同一套语义:失效/归档条目既不入候选、
 * 也不作为中转。
 */
export function expandActivation(data: WorldData, seeds: string[], depth: number, chapterId: string): ActivationCandidate[] {
	if (depth <= 0 || data.relations.length === 0) return [];
	const usable = new Set(
		data.entries.filter((e) => e.active && chapterMatches(e, chapterId)).map((e) => e.id),
	);
	// 双向邻接表(每条边带 emphasized)
	const adj = new Map<string, Array<{ to: string; emphasized: boolean }>>();
	const addEdge = (from: string, to: string, emphasized: boolean) => {
		const list = adj.get(from) ?? [];
		list.push({ to, emphasized });
		adj.set(from, list);
	};
	for (const r of data.relations) {
		addEdge(r.from, r.to, r.emphasized);
		addEdge(r.to, r.from, r.emphasized);
	}
	const seedSet = new Set(seeds);
	const best = new Map<string, ActivationCandidate>();
	let frontier = seeds;
	for (let d = 1; d <= depth; d++) {
		const layer = new Map<string, ActivationCandidate>();
		for (const from of frontier) {
			for (const edge of adj.get(from) ?? []) {
				// best.has = 跨层不升级(最近距离优先);layer 内允许同层升级
				if (!usable.has(edge.to) || seedSet.has(edge.to) || best.has(edge.to)) continue;
				const cand: ActivationCandidate = { id: edge.to, dist: d, emphasized: edge.emphasized };
				// 同层多条到达边:强关联优先(先到先得,强边覆盖弱边记录)
				const existing = layer.get(edge.to);
				if (!existing || (cand.emphasized && !existing.emphasized)) layer.set(edge.to, cand);
			}
		}
		if (layer.size === 0) break;
		for (const cand of layer.values()) best.set(cand.id, cand);
		frontier = [...layer.keys()];
	}
	return [...best.values()];
}

/**
 * 激活排序(2026-08-11 设计 §4.2):种子(直接命中,权重 1,虚拟自关联)
 * 永远最前、内部保持既有类型优先级顺序;递归候选按 强关联 > 普通关联 >
 * 跳距 > 类型优先级。未标注 emphasized 时权重全平局 → 退化为距离优先。
 */
export function rankActivationCandidates(data: WorldData, seeds: string[], expanded: ActivationCandidate[]): string[] {
	const typeOf = new Map(data.entries.map((e) => [e.id, e.type]));
	const typePriority = (id: string) => TYPE_PRIORITY[typeOf.get(id) ?? "world"];
	const expandedSorted = expanded
		.slice()
		.sort((a, b) =>
			(b.emphasized ? 1 : 0) - (a.emphasized ? 1 : 0)
			|| a.dist - b.dist
			|| typePriority(a.id) - typePriority(b.id),
		)
		.map((c) => c.id);
	return [...seeds, ...expandedSorted];
}

/** 组装背景包文本(常驻组 + 激活组,预算裁剪)。 */
export function buildChapterContext(data: WorldData, input: ChapterContextInput): ChapterContextResult {
	const result: ChapterContextResult = { text: "", activatedIds: [], trimmedCount: 0, included: { constraints: [], hasSample: false, hasSummary: false, hasNotice: false, storylineNode: null } };

	// 常驻组:启用的约束 + 采样 + 简要世界观(裁剪顺序:先裁采样,仍超再裁概述,约束保留)
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
	let overview = "";
	if (data.worldSummary.trim().length > 0) {
		overview = `【世界观概述】\n${data.worldSummary.trim()}\n`;
		result.included.hasSummary = true;
	}
	let used = estimateTokens(resident) + estimateTokens(overview);
	if (used > input.budget) {
		const sampleStart = resident.indexOf("【文风采样】");
		if (sampleStart >= 0) {
			resident = resident.slice(0, sampleStart);
			result.included.hasSample = false;
			used = estimateTokens(resident) + estimateTokens(overview);
		}
		if (used > input.budget && overview.length > 0) {
			overview = "";
			result.included.hasSummary = false;
			used = estimateTokens(resident);
		}
	}

	// 激活组(预算内按优先级装填;首条无条件装入保证"至少一条相关设定")
	// 种子 = 关键词命中(activatedEntryIds 产线,零改动);深度 > 0 时经
	// 多源 BFS 展开邻居,统一排序后装填(缺省深度 = 仅种子,与旧行为一致)
	const seeds = activatedEntryIds(data, input);
	const expanded = expandActivation(data, seeds, input.activationDepth ?? DEFAULT_ACTIVATION_DEPTH, input.chapterId);
	const ids = rankActivationCandidates(data, seeds, expanded);
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
	// 简要世界观紧跟记忆:先读叙事态,再读稳定设定,然后才是本章相关
	if (overview.length > 0) parts.push(overview.trimEnd());
	if (activeParts.length > 0) parts.push(`【世界书·本章相关】\n${activeParts.join("\n")}`);
	const residentBody = resident.trim();
	if (residentBody.length > 0) parts.push(residentBody);
	const tailBody = tail.trim();
	if (tailBody.length > 0) parts.push(tailBody);
	let text = parts.join("\n\n");
	if (result.trimmedCount > 0) text += `\n(已裁剪 ${result.trimmedCount} 条,需要可 read world.json)`;
	return { ...result, text: text.trim() };
}
