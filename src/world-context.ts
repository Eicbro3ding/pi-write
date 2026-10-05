import type { WorldData, WorldEntry, ConstraintTarget } from "./world-data.ts";
import { isCjkChar } from "./cjk.ts";

/**
 * 背景包默认 token 预算。
 *
 * ⚠️ 2026-10-04 起这些常量**仅作缺省回落**:实际取值来自
 * `WriterSettings.contextBudget`(用户可在设置里调整)。保留导出是为了
 * 向后兼容既有调用方与测试,新代码应优先读设置。
 */
export const DEFAULT_CONTEXT_BUDGET = 2000;

/** 跨章节记忆(memory.md)注入的 token 预算(缺省值;实际取 WriterSettings.memoryBudget)。 */
export const DEFAULT_MEMORY_BUDGET = 1500;

/**
 * 背景包注入用的 custom 消息类型。
 *
 * 三个写入方必须同值:`SessionHost.injectContext`(web)、`worldContextMessage`
 * (TUI)、以及本文件的常量。此前是三处各自硬编码字符串,改一处漏两处就会出现
 * 「注入了但扫描不到」的静默失忆 —— 扫描逻辑(见 server.ts 的
 * sessionLeafHasWorldContext)依赖它认出背景包。
 */
export const WORLD_CONTEXT_TYPE = "world-context";

/** 关联激活默认深度(0 = 关闭,与旧行为一致;>0 启用多源 BFS 展开)。 */
export const DEFAULT_ACTIVATION_DEPTH = 0;

/** Notice 备忘录注入上限(缺省值;实际取 WriterSettings.noticeInjectLimit)。 */
export const NOTICE_INJECT_LIMIT = 10;

/** 约束 target 是否匹配某角色(缺省 undefined = all,旧数据行为不变)。 */
export function constraintTargetMatches(target: ConstraintTarget | undefined, role: "main" | "director" | "writer"): boolean {
	return target === undefined || target === "all" || target === role;
}

/** 已完成里程碑(发展线 done 节点)注入上限——标题列表防上下文膨胀(借鉴
 *  AI-Novel-Writing-Assistant 的 completedMilestones 守卫:已完成目标注入
 *  「勿再追求」列表,而非靠祈使句约束)。 */
export const COMPLETED_MILESTONE_LIMIT = 6;
/** Notice / 里程碑上限的合并入参(缺省时用上面的常量,保证旧调用方行为不变)。 */
export interface ContextLimits {
	noticeInjectLimit?: number;
	completedMilestoneLimit?: number;
}

/** 发展线视图(2026-08-12):当前目标 + 已完成里程碑列表。未启用或无节点返回 null。 */
export interface StorylineView {
	/** 当前进行中目标标题(至多一个,world-data 校验保证)。 */
	currentTitle: string | null;
	/** 已完成节点标题(取节点数组尾部——较新的追加在后,上限 COMPLETED_MILESTONE_LIMIT)。 */
	completed: string[];
}

/** 组装发展线视图:in-progress 节点 = 当前目标;done 节点 = 已完成列表(尾部优先)。 */
export function buildStorylineView(data: WorldData, limit: number = COMPLETED_MILESTONE_LIMIT): StorylineView | null {
	if (!data.storyline.enabled || data.storyline.nodes.length === 0) return null;
	const current = data.storyline.nodes.find((n) => n.status === "in-progress");
	const completed = data.storyline.nodes.filter((n) => n.status === "done").map((n) => n.title);
	if (!current && completed.length === 0) return null;
	return { currentTitle: current?.title ?? null, completed: limit > 0 ? completed.slice(-limit) : [] };
}

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
	/** Notice / 里程碑注入上限(缺省用常量;生产装配应传 WriterSettings 的值)。 */
	limits?: ContextLimits;
}

/** 一处因预算被省略的内容(2026-10-04,T4 裁切可见)。 */
export interface TrimRecord {
	/** 类别:激活条目 / 文风采样 / 世界观概述 / 已完成里程碑。 */
	kind: "entry" | "sample" | "summary" | "milestones";
	/** 人类可读的名称(条目标题 / 段名)。 */
	label: string;
	/** 粗略 token 数(该内容原本会占用的量)。 */
	tokens: number;
}

/** 背景包里的一个分段及其占用(2026-10-04,T5 上下文可视化)。 */
export interface ContextSection {
	/** 段 id(稳定,供 UI 排序/着色;不用展示名做键,展示名会改)。 */
	id: "memory" | "summary" | "entries" | "constraints" | "sample" | "notice" | "storyline";
	/** 展示名。 */
	label: string;
	/** 该段实际占用的 token(裁掉的不算——裁掉的另在 trimmed 里)。 */
	tokens: number;
	/** 该段包含的条目数(条目类才有意义;其余为 0 或 1)。 */
	count: number;
}

export interface ChapterContextResult {
	text: string;
	activatedIds: string[];
	trimmedCount: number;
	/**
	 * 被省略内容的明细(2026-10-04)。此前只有 trimmedCount 一个数字,
	 * 用户既不知道被裁的是「哪些」,也无从判断该不该调大预算 —— 裁切因此
	 * 完全不可感知。这里是同一份事实的可读版本。
	 *
	 * 顺序 = 被裁的先后(条目按优先级填充时被挤出的顺序)。
	 */
	trimmed: TrimRecord[];
	/**
	 * 分段占用(2026-10-04,T5)。`used` 是滚动累加值,拿不到「哪一段花了多少」,
	 * 而 T5 的预算面板恰好只需要这个 —— 因此单独快照一份。
	 *
	 * 只含**实际进入上下文**的段;被裁的看 trimmed。
	 */
	sections: ContextSection[];
	included: {
		constraints: string[];
		hasSample: boolean;
		hasSummary: boolean;
		hasNotice: boolean;
		hasCompletedMilestones: boolean;
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
	const result: ChapterContextResult = { text: "", activatedIds: [], trimmedCount: 0, trimmed: [], sections: [], included: { constraints: [], hasSample: false, hasSummary: false, hasNotice: false, hasCompletedMilestones: false, storylineNode: null } };
	/** 分段占用的累加器(见 ContextSection;最后统一 push,省得各分支各自维护顺序)。 */
	const sections: ContextSection[] = [];
	const addSection = (s: ContextSection): void => {
		if (s.tokens > 0) sections.push(s);
	};

	// 常驻组:启用的约束 + 采样 + 简要世界观(裁剪顺序:先裁采样,仍超再裁概述,约束保留)
	// 约束按 target 过滤。主会话(这个函数)是**写作 agent**——TUI 里它就是唯一动笔的那个,
	// 所以它收 target ∈ {main, writer, all} 的并集:写作 agent 同时是「主会话」与「编剧」。
	// 口径与 writer-host 的经典模式一致(那里也是 writer || main 的并集,2026-08-12 就有)。
	// 2026-10-01 补:此前这里只认 main/all,而「编剧」正是最贴近"写正文的人"的那个 target ——
	// 约束默认值一旦从 all 收窄到 writer,TUI/单 Agent 就会静默丢约束。
	const enabledConstraints = data.constraints.filter(
		(c) => c.enabled && (constraintTargetMatches(c.target, "main") || constraintTargetMatches(c.target, "writer")),
	);
	let resident = "";
	let residentConstraints = "";
	if (enabledConstraints.length > 0) {
		residentConstraints = "【写作约束】\n";
		for (const c of enabledConstraints) {
			residentConstraints += `- ${c.name}: ${c.text}\n`;
			result.included.constraints.push(c.name);
		}
		resident += residentConstraints;
	}
	let sample = "";
	if (data.styleSample && data.styleSample.text.length > 0) {
		sample = `【文风采样】(来源: ${data.styleSample.source || "未知"}；只模仿语感与句式，不复用原文)\n${data.styleSample.text}\n`;
		resident += sample;
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
			// 记录被裁掉的那一段的实际体量(裁之前先量),供 T4 的可视化用
			const dropped = resident.slice(sampleStart);
			resident = resident.slice(0, sampleStart);
			sample = "";
			result.included.hasSample = false;
			result.trimmed.push({ kind: "sample", label: "文风采样", tokens: estimateTokens(dropped) });
			used = estimateTokens(resident) + estimateTokens(overview);
		}
		if (used > input.budget && overview.length > 0) {
			result.trimmed.push({ kind: "summary", label: "世界观概述", tokens: estimateTokens(overview) });
			overview = "";
			result.included.hasSummary = false;
			used = estimateTokens(resident);
		}
	}
	// 分段快照(2026-10-04,T5):常驻组的约束与采样在 resident 里拼在一起,
	// 因此各自单独量长度 —— 采样若被裁掉,量出来的必须是「切完还剩多少」。
	// 必须在剪裁之后量,否则面板会把已经丢掉的内容算进预算。
	addSection({ id: "constraints", label: "写作约束", tokens: estimateTokens(residentConstraints), count: result.included.constraints.length });
	addSection({ id: "sample", label: "文风采样", tokens: estimateTokens(sample), count: sample.length > 0 ? 1 : 0 });
	addSection({ id: "summary", label: "世界观概述", tokens: estimateTokens(overview), count: overview.length > 0 ? 1 : 0 });

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
			// 记标题而不只是计数:用户看到「已裁剪 3 条」无法判断影响,
			// 看到「已裁剪:林婉、旧城地图、时间线·第三夜」才知道丢了什么,
			// 也才谈得上决定要不要调大 contextBudget(2026-10-04)
			result.trimmed.push({ kind: "entry", label: entry.title, tokens });
			continue;
		}
		activeParts.push(line);
		result.activatedIds.push(id);
		used += tokens;
	}
	// 激活组的分段快照(2026-10-04,T5):按已装入的行实际长度量,
	// 不按 ids 重算 —— 装填时 used 已经累加过,这里只需把总量落到面板上。
	addSection({ id: "entries", label: "世界书·本章相关", tokens: activeParts.reduce((sum, line) => sum + estimateTokens(line), 0), count: activeParts.length });

	// Notice(全局备忘录·待办清单):只注入未完成项,上限 NOTICE_INJECT_LIMIT——完成
	// 的条目留在 UI 板子可见,不进上下文(2026-08-12 回到初衷)。常驻不可裁。
	let tail = "";
	let noticeBlock = "";
	const noticeLimit = input.limits?.noticeInjectLimit ?? NOTICE_INJECT_LIMIT;
	const milestoneLimit = input.limits?.completedMilestoneLimit ?? COMPLETED_MILESTONE_LIMIT;
	const noticeItems = data.notice.items.filter((i) => !i.done).slice(0, noticeLimit);
	if (data.notice.enabled && noticeItems.length > 0) {
		noticeBlock = `【Notice·备忘录】\n${noticeItems.map((i) => `- [ ] ${i.text}`).join("\n")}\n`;
		tail += noticeBlock;
		result.included.hasNotice = true;
	}
	const view = buildStorylineView(data, milestoneLimit);
	let storylineBlock = "";
	if (view) {
		if (view.currentTitle) {
			const current = data.storyline.nodes.find((n) => n.status === "in-progress");
			storylineBlock += `【发展线】\n当前位置: ${view.currentTitle}\n`;
			if (current?.goal) storylineBlock += `目标: ${current.goal}\n`;
			if (current?.next) storylineBlock += `下一步: ${current.next}\n`;
			if (current) result.included.storylineNode = current.id;
		}
		if (view.completed.length > 0) {
			const completedBlock = `【发展线·已完成】以下目标已完成,禁止重复追求/推进:\n${view.completed.map((t) => `- ${t}`).join("\n")}`;
			if (used + estimateTokens(completedBlock) <= input.budget) {
				storylineBlock += `\n${completedBlock}\n`;
				result.included.hasCompletedMilestones = true;
			} else {
				// 这一段整块丢弃目前无声无息 —— 而它恰好装的是「勿再追求」清单,
				// 丢了会让模型重复推进已完成的目标(2026-10-04)
				result.trimmed.push({ kind: "milestones", label: "发展线·已完成", tokens: estimateTokens(completedBlock) });
			}
		}
		tail += storylineBlock;
	}
	// 分段快照(2026-10-04,T5):Notice 与发展线为常驻不可裁的尾段,
	// 但发展线的「已完成」块仍可能被预算挤掉,故同样在裁剪判定之后量。
	addSection({ id: "notice", label: "Notice·备忘录", tokens: estimateTokens(noticeBlock), count: noticeItems.length });
	addSection({ id: "storyline", label: "发展线", tokens: estimateTokens(storylineBlock), count: view ? 1 : 0 });

	const parts: string[] = [];
	// 跨章节记忆放最前:agent 最先看到它,再读本章相关设定
	let memoryBlock = "";
	if (input.memory && input.memory.trim().length > 0) {
		memoryBlock = `【记忆】\n${input.memory.trim()}`;
		parts.push(memoryBlock);
	}
	// 简要世界观紧跟记忆:先读叙事态,再读稳定设定,然后才是本章相关
	if (overview.length > 0) parts.push(overview.trimEnd());
	if (activeParts.length > 0) parts.push(`【世界书·本章相关】\n${activeParts.join("\n")}`);
	const residentBody = resident.trim();
	if (residentBody.length > 0) parts.push(residentBody);
	const tailBody = tail.trim();
	if (tailBody.length > 0) parts.push(tailBody);
	let text = parts.join("\n\n");
	// 裁切提示(2026-10-04):从「已裁剪 N 条」升级为「裁了什么」。
	// 这行是**给模型看的**——它需要知道自己没拿到全部设定,才不会把
	// 「世界书里没有」当作事实。用户侧的可见性另见 summarizeTrim。
	//
	// 措辞避开段标题字面(「文风采样」/「世界观概述」):那几个词是正文里的
	// 段标题,搬进来会与正文撞名(既有断言 `not.toContain("文风采样")` 的
	// 意图是「该段没进上下文」,同名会让它失去区分力)。用「采样段」这类
	// 简称,语义在上下文中依然明确。
	if (result.trimmed.length > 0) {
		const SHORT: Record<TrimRecord["kind"], string> = {
			entry: "",
			sample: "采样段",
			summary: "概述段",
			milestones: "已完成里程碑",
		};
		const labels = result.trimmed.map((t) => (t.kind === "entry" ? `《${t.label}》` : SHORT[t.kind])).join("、");
		text += `\n(因预算未包含: ${labels};需要可 read world.json)`;
	}
	// 记忆段放在最前,故最后回填 —— sections 的展示顺序由 UI 决定(id 稳定),
	// 这里只需保证「每段都在、量的是实际进上下文的那份」(2026-10-04,T5)。
	addSection({ id: "memory", label: "记忆", tokens: estimateTokens(memoryBlock), count: memoryBlock.length > 0 ? 1 : 0 });
	result.sections = sections;
	return { ...result, text: text.trim() };
}

/** 裁切摘要(2026-10-04,T4):把 trimmed 明细摊成人类可读的一行,供 UI 展示。 */
export interface TrimSummary {
	/** 被省略的条目数。 */
	entryCount: number;
	/** 被省略的条目名(按被挤出的顺序)。 */
	entryTitles: string[];
	/** 被整段丢弃的其他内容(文风采样 / 世界观概述 / 已完成里程碑)。 */
	droppedSections: string[];
	/** 合计被省略的粗略 token 数。 */
	tokens: number;
	/** 一句话摘要,没有裁切时为空串。 */
	text: string;
}

/** 空摘要(未裁切 / 尚未装配过)。UI 可直接判 `text.length === 0` 决定要不要显示。 */
export const EMPTY_TRIM_SUMMARY: TrimSummary = {
	entryCount: 0,
	entryTitles: [],
	droppedSections: [],
	tokens: 0,
	text: "",
};

/**
 * 把 buildChapterContext 的裁切明细转成 UI 可直接渲染的摘要。
 *
 * 独立成函数的原因:裁切明细是**结构化数据**,而 UI 有三处(TUI 状态栏、
 * web 会话头、/inspect)—— 每处各写一遍格式化必然漂移。摘要口径收在这里,
 * 三处只负责摆放。
 *
 * maxNames 控制点名上限:裁切 20 条时全列会撑爆一行,超过就折叠成「等 N 条」。
 * 入参收成 Pick<...,"trimmed">:调用方(如查询端点)手上可能只有一个空对象,
 * 不该被迫伪造整个 ChapterContextResult。
 */
export function summarizeTrim(result: Pick<ChapterContextResult, "trimmed">, maxNames = 5): TrimSummary {
	const entries = result.trimmed.filter((t) => t.kind === "entry");
	const dropped = result.trimmed.filter((t) => t.kind !== "entry").map((t) => t.label);
	const tokens = result.trimmed.reduce((sum, t) => sum + t.tokens, 0);

	/** 点名若干项,超出则折叠成「A、B 等 N 项」。 */
	const nameList = (names: string[]): string => {
		if (names.length === 0) return "";
		if (names.length <= maxNames) return names.join("、");
		return `${names.slice(0, maxNames).join("、")} 等 ${names.length} 项`;
	};

	const bits: string[] = [];
	if (entries.length > 0) {
		bits.push(`省略 ${entries.length} 条设定(${nameList(entries.map((t) => t.label))})`);
	}
	if (dropped.length > 0) bits.push(`丢弃 ${nameList(dropped)}`);
	return {
		entryCount: entries.length,
		entryTitles: entries.map((t) => t.label),
		droppedSections: dropped,
		tokens,
		text: bits.length > 0 ? `${bits.join("；")} · 约 ${tokens} token` : "",
	};
}
