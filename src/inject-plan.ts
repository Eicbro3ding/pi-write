/**
 * 注入分诊层 —— **「哪类内容放哪一格」的唯一真相**。
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-06 之前,注入是**五条通道各写各的块**:背景包(`buildChapterContext`)、
 * 每轮易变块(`editorContext`)、指纹去重块(`stableContext`)、记忆锚
 * (`buildMemoryAnchor`)、压缩接管。每条通道都是针对某次具体故障打的补丁,
 * 各修各的,没回头看别人 —— 结果是同一份数据被反复注入:
 *
 * | 数据 | 曾经被几条通道注入 |
 * |---|---|
 * | Notice | 4(`editorContext` / `stableContext` / 背景包 / 记忆锚) |
 * | 发展线 | 4(`editorContext` / 背景包 / 记忆锚 / 舞台) |
 * | 世界观概述 | 2(`stableContext` / 背景包) |
 * | 写作约束 | 4 |
 * | memory.md | 2(记忆锚 / 背景包) |
 *
 * 根因不是「写漏了去重」,而是**没有单一归属**:没人能回答「Notice 该放哪」。
 * 这个文件就是那个答案 —— 一张表,按「变化频率 + 是否需持久化」分格;
 * 各通道只负责**执行**自己那一格,不再自己决定装什么。
 *
 * ## 分格判据
 *
 * - **A 常驻装配**:会话建立时定死不变量(系统提示、工具清单)。载体 = `systemPromptOverride`。
 * - **C 每轮易变**:每轮注入,随用户输入一起进入上下文。
 * - **D 每轮锚**:跨轮次恒定,但**必须抗压缩、抗注意力衰减** —— 走 systemPrompt 尾部,
 *   是唯一不依赖模型回忆的常驻通道。
 * - **E 背景包**:不在常规轮次里,由压缩/丢包这类事件触发(主会话/TUI 的唯一来源)。
 *
 * ## ⚠️ 2026-10-11:编辑会话的 B/C 两格已**合并为一格**(`context`)
 *
 * 此前编辑会话分两格:B 指纹去重(世界观概述/世界书/约束/Notice,经
 * `syncStableContext` 持久化进会话,内容不变就只注一次,）与 C 每轮易变
 * (正文/发展线/转录,经 context 钩子每轮追加)。分格的动机是**省 token**
 * (稳定内容只付一次全价输入,之后吃缓存)。
 *
 * 合并的理由(用户 2026-10-11 拍板):那套省法在实践中没换来预期的缓存命中,
 * 却换来两个真实代价 ——
 * ① 稳定块一变就**再注一份**,旧的那份留在历史里没人删,真实会话里堆到 16 份
 *   (760 → 3885 字),每份都自称「长期有效」且内容互相打架,模型不知道该信哪份;
 * ② 「哪块放哪、为什么」成了用户与模型都要维护的心智负担。
 *
 * 现在编辑会话**只有一格** `context`:全部内容每轮一起注入,统一放在**用户输入
 * 之前**,以本轮这一份为准。历史里不再有"第几版"的堆叠 —— 因为注入走 context 钩子,
 * 它只参与本次请求、**不落会话历史**(vendor 的 transformContext 只回给单次请求)。
 *
 * ## ⚠️ 分格**按会话类型**成立(2026-10-06 核实的硬约束)
 *
 * 不同会话能用的通道根本不同,所以格位不能一刀切:
 *
 * | 通道 | 编剧会话(`writer-host`) | 主会话(`web.ts`) | TUI |
 * |---|---|---|---|
 * | A 系统提示 | ✅ | ✅ | ✅ |
 * | C 每轮上下文 | ✅ `context` 钩子 | ❌ | ❌ |
 * | D 每轮锚 | ✅ | ✅(锚) | ✅(锚) |
 * | E 背景包 | ❌ | ✅ **唯一来源** | ✅ |
 *
 * 关键事实(逐条 Read 核实):
 * - `extension.ts` **没有 `context` 钩子** —— 背景包只由 `server.ts` 注入主会话;
 * - 主会话的 `extensionFactories` 只有 `writerExtension`(`web.ts:244`)→ 只有锚,无每轮上下文;
 * - 故**背景包是主会话看到世界书/约束/Notice/memory 的唯一途径**,不能摘。
 *
 * 所以 `planSessionBlocks` 必须按会话类型给不同答案,而**编辑会话**侧的
 * `planContextBlocks` / `planAnchorBlocks` 两格互斥。
 *
 * ## 互斥规则(本模块的核心不变量)
 *
 * **同一个会话内,每类内容只能出现在一格。** `test/inject-plan.test.ts` 用反证法
 * 钉住这一条:把任意内容同时塞进两格,测试必须变红。
 */

import { type SessionMode, modeAnchorLine } from "./session-mode.ts";
import { DEAD_CHARACTER_HEADER, entryStatusSuffix, shortId, type WorldData } from "./world-data.ts";
import { buildStorylineView, constraintTargetMatches } from "./world-context.ts";

/** 会话类型 —— 决定能用哪些格位(见文件头表格)。 */
export type SessionKind = "editor" | "main" | "tui" | "stage";

/** 格位标识。 */
export type InjectSlot =
	/** C:每轮上下文(编辑会话唯一的那一格,统一注在用户输入之前)。 */
	| "context"
	/** D:每轮锚(systemPrompt 尾部)。 */
	| "anchor"
	/** E:背景包(主会话/TUI 唯一来源)。 */
	| "pack";

/**
 * 某一类内容的**唯一格位**(编辑会话视角)。
 *
 * 这张表就是「谁放哪」的答案。新增一类注入内容时,先在这里登记格位,
 * 再让对应通道去执行 —— 不要再在通道里就地决定。
 */
export interface ContentRouting {
	/** 内容标识(用于测试与文档,不参与拼接)。 */
	readonly id: string;
	/** 人类可读的名字。 */
	readonly label: string;
	/** 编辑会话下的格位。 */
	readonly slot: InjectSlot;
}

/**
 * 编辑会话的完整分诊表 —— **互斥的唯一真相**。
 *
 * 改这张表前先想清楚两件事:① 这类内容多久变一次?② 变了之后需要立刻生效,
 * 还是可以等到下一次重注入?答错了就是「版本堆叠」或「内容过期」。
 */
export const EDITOR_ROUTING: readonly ContentRouting[] = [
	// —— 格 C:每轮上下文(2026-10-11 起 B/C 合并,全部内容都归这里) ——
	// 顺序 = 注入顺序:先给全局基准(世界观 → 世界书 → 约束 → Notice),
	// 再给这一轮要动的东西(正文 → 发展线 → 转录)—— 越靠近用户输入越"当下"。
	{ id: "worldSummary", label: "世界观概述", slot: "context" },
	{ id: "worldEntries", label: "世界书条目", slot: "context" },
	{ id: "constraints", label: "写作约束", slot: "context" },
	{ id: "notice", label: "Notice 备忘录", slot: "context" },
	{ id: "draft", label: "当前正文", slot: "context" },
	{ id: "storyline", label: "发展线", slot: "context" },
	{ id: "transcript", label: "最近一幕舞台转录", slot: "context" },

	// —— 格 D:每轮锚(跨轮恒定,需抗压缩) ——
	{ id: "modeLine", label: "模式行", slot: "anchor" },
	{ id: "chapter", label: "当前章节", slot: "anchor" },
	{ id: "memory", label: "跨章节记忆 memory.md", slot: "anchor" },
];

/** 取某类内容在编辑会话下的格位(null = 未登记,属于编程错误)。 */
export function slotOf(id: string): InjectSlot | null {
	return EDITOR_ROUTING.find((r) => r.id === id)?.slot ?? null;
}

/** 按格位分组(测试与文档用)。 */
export function contentsInSlot(slot: InjectSlot, routing: readonly ContentRouting[] = EDITOR_ROUTING): string[] {
	return routing.filter((r) => r.slot === slot).map((r) => r.id);
}

// ——————————————————————————————————————————————————————————————
// 截断上限(与各通道原有值一致,集中在此便于审计)
// ——————————————————————————————————————————————————————————————

/** 世界观概述截断上限。 */
export const SUMMARY_LIMIT = 800;
/** 世界书全量条目的截断上限。 */
export const WORLD_LIMIT = 3000;
/** 当前正文截断上限。 */
export const DRAFT_LIMIT = 4000;
/** 舞台转录截断上限。 */
export const STAGE_LIMIT = 8000;
/** Notice 未完成项注入条数上限(缺省;实际取 `WriterSettings.noticeInjectLimit`)。 */
export const NOTICE_LIMIT = 10;
/** 已完成里程碑注入条数上限(缺省;实际取 `WriterSettings.completedMilestoneLimit`)。 */
export const MILESTONE_LIMIT = 6;

/** 截断:超限则截断并加「…(截断)」标记。 */
export function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n…(截断)` : text;
}

// ——————————————————————————————————————————————————————————————
// 格 C:每轮上下文(常驻组 + 本章组,合成一个块列表)
// ——————————————————————————————————————————————————————————————

export interface ContextPlanInput {
	readonly world: WorldData;
	/** true = 经典模式(单一写作 agent),约束取 writer ∪ main;false = 编剧,只取 writer。 */
	readonly classicMode: boolean;
	/** Notice 条数上限(缺省 {@link NOTICE_LIMIT})。 */
	readonly noticeLimit?: number;
	/** 当前章草稿全文(null = 文件不存在,按「尚未创建」提示)。 */
	readonly draft?: string | null;
	/** 正文文件路径(用于块标题与「写入此文件」提示)。 */
	readonly draftFile?: string | null;
	/** 已完成里程碑上限(缺省 {@link MILESTONE_LIMIT})。 */
	readonly milestoneLimit?: number;
	/** 最近一幕舞台转录(null/空 = 不注入)。 */
	readonly transcript?: string | null;
}

/** 常驻组的入参(世界观概述 / 世界书 / 约束 / Notice)。 */
export interface ResidentPlanInput {
	readonly world: WorldData;
	/** true = 经典模式(单一写作 agent),约束取 writer ∪ main;false = 编剧,只取 writer。 */
	readonly classicMode: boolean;
	/** Notice 条数上限(缺省 {@link NOTICE_LIMIT})。 */
	readonly noticeLimit?: number;
}

/** 本章组的入参(正文 / 发展线 / 转录)。 */
export interface ChapterPlanInput {
	readonly world: WorldData;
	/** 当前章草稿全文(null = 文件不存在,按「尚未创建」提示)。 */
	readonly draft?: string | null;
	/** 正文文件路径(用于块标题与「写入此文件」提示)。 */
	readonly draftFile?: string | null;
	/** 已完成里程碑上限(缺省 {@link MILESTONE_LIMIT})。 */
	readonly milestoneLimit?: number;
	/** 最近一幕舞台转录(null/空 = 不注入)。 */
	readonly transcript?: string | null;
}

/**
 * 格 C 的块:**常驻组在前、本章组在后**,合成一份声明顺序固定的列表。
 *
 * 这个函数是编辑会话注入的**唯一出口** —— 宿主不再自己决定装哪几块
 * (2026-10-11 合流前,宿主分两次调用:稳定块走持久化注入、易变块走 context 钩子)。
 */
export function planContextBlocks(input: ContextPlanInput): string[] {
	return [
		...planResidentBlocks(input),
		...planChapterBlocks(input),
	];
}

/**
 * 常驻组的块:世界观概述 + 世界书(character/world 全量) + 写作约束 + Notice。
 *
 * 顺序固定 —— 概述在最前是「先给全局再给细节」的阅读顺序,且与既有测试一致。
 * 内容为空时对应块**跳过**(不产生空块)。
 *
 * **已死亡角色块置顶**(2026-10-12):它是一条红线警报,不是资料 —— 放在概述之前,
 * 让「谁死了」成为模型每轮最先读到的连续性事实之一。正文引用规则写在标题里,
 * 不需要再靠约束簿里的一条「不要复活死人」与 body 的活人描写对抗。
 *
 * **Notice 带短编号**(2026-10-11):`[k3p9wq] 补写第三章的雨夜` ——
 * `notice_update` 靠它指认条目;改名不丢靶(编号是 id 的一部分)。
 */
export function planResidentBlocks(input: ResidentPlanInput): string[] {
	const { world } = input;
	const blocks: string[] = [];

	// 已死亡角色:从世界书里摘出来单独成行。body 是人物设定(写活人状态正常),
	// 留着供参考,但「死亡」这个事实必须有一条不被 body 稀释的通路。
	const deadChars = world.entries.filter((e) => e.type === "character" && e.status === "dead");
	if (deadChars.length > 0) {
		blocks.push(`${DEAD_CHARACTER_HEADER}${deadChars.map((e) => e.title).join("、")}`);
	}

	const summary = world.worldSummary?.trim();
	if (summary && summary.length > 0) {
		blocks.push(`【世界观概述】\n${truncate(summary, SUMMARY_LIMIT)}`);
	}

	const chars = world.entries
		.filter((e) => e.type === "character" || e.type === "world")
		.map((e) => `【${e.title}${entryStatusSuffix(e.status)}】${e.body}`)
		.join("\n");
	if (chars.trim().length > 0) {
		blocks.push(`【世界书】\n${truncate(chars, WORLD_LIMIT)}`);
	}

	const constraints = world.constraints.filter(
		(c) => c.enabled && (constraintTargetMatches(c.target, "writer") || (input.classicMode && constraintTargetMatches(c.target, "main"))),
	);
	if (constraints.length > 0) {
		blocks.push(`【写作约束】\n${constraints.map((c) => `- ${c.name}: ${c.text}`).join("\n")}`);
	}

	const noticeLimit = input.noticeLimit ?? NOTICE_LIMIT;
	const open = world.notice.enabled ? world.notice.items.filter((i) => !i.done).slice(0, noticeLimit) : [];
	if (open.length > 0) {
		blocks.push(`【Notice·备忘录】\n${open.map((i) => `- [ ] [${shortId(i.id)}] ${i.text}`).join("\n")}`);
	}

	return blocks;
}

/**
 * 本章组的块:当前正文 + 发展线 + 舞台转录。
 *
 * **发展线带短编号**(2026-10-11):`[9f2k1x] 初入旧城` —— `storyline_update`
 * 靠它指认节点。已完成那串也带编号,便于回溯修正。
 */
export function planChapterBlocks(input: ChapterPlanInput): string[] {
	const blocks: string[] = [];

	if (input.draftFile) {
		const draft = input.draft;
		if (draft !== null && draft !== undefined && draft.trim().length > 0) {
			blocks.push(`【当前正文 · ${input.draftFile}】\n${truncate(draft, DRAFT_LIMIT)}`);
		} else {
			// 正文文件不存在/为空:仍注入路径约定 —— 信息缺失是 agent 自创文件名
			// (draft/第一章.md)导致前端按约定路径读到空的根因(2026-08-11)
			blocks.push(`【当前正文 · ${input.draftFile}】尚未创建——你的写作/修改请用 write 工具写入此文件(路径如上),不要自创其他文件名`);
		}
	}

	const view = buildStorylineView(input.world, input.milestoneLimit);
	if (view) {
		const lines: string[] = [];
		if (view.currentId && view.currentTitle) lines.push(`当前位置: [${shortId(view.currentId)}] ${view.currentTitle}`);
		if (view.completed.length > 0) {
			const items = view.completed.map((t, i) => `[${shortId(view.completedIds[i] ?? "")}] ${t}`);
			lines.push(`已完成(禁止重复追求/推进): ${items.join("、")}`);
		}
		if (lines.length > 0) blocks.push(`【发展线】\n${lines.join("\n")}`);
	}

	if (input.transcript) blocks.push(`【最近一幕舞台转录】\n${input.transcript}`);

	return blocks;
}

/**
 * 渲染编辑会话每轮注入的整段文本(纯函数,单测直接钉)。
 *
 * **为什么抬头要强调「每轮刷新」**:这段文本注在用户输入之前,而历史里不会再留下
 * 它的副本(走 context 钩子,只参与本次请求)。模型看到的世界观/约束/进度**只此一份**,
 * 所以要明确告诉它「这是当前唯一有效的一版」,免得它去找历史里并不存在的旧版本。
 *
 * @param classicMode true = 写作 agent,false = 编剧(抬头里的角色名不同)
 */
export function renderEditorContext(classicMode: boolean, blocks: readonly string[]): string {
	const role = classicMode ? "写作" : "编剧";
	return [
		`【${role}上下文 · 每轮刷新 · 以下即当前唯一有效的一版】`,
		"以下是本书的世界观、写作基准,以及这一轮要处理的正文与进度。每一轮都会按最新状态重新整理一份,与下面这条用户输入同在一轮 —— 与本段冲突的旧印象一律以此为准。",
		"",
		blocks.join("\n\n"),
	].join("\n");
}

// ——————————————————————————————————————————————————————————————
// 格 D:每轮锚
// ——————————————————————————————————————————————————————————————

export interface AnchorPlanInput {
	/** 模式行(讨论/写作/修订);undefined = 不注入模式行。 */
	readonly mode?: SessionMode;
	/** 当前章节文件名(undefined = 不注入「当前章节」行)。 */
	readonly chapterFile?: string;
	/** 已按预算裁剪的 memory.md 正文(空 = 不注入)。 */
	readonly memory?: string;
	/**
	 * 硬约束速查(2026-10-12;空 = 不注入)。
	 *
	 * **只给没有格 C 的会话用**(主会话/TUI —— 它们的约束只在背景包里,而背景包
	 * 会被对话推远、被压缩吃掉,约束因此是「时灵时不灵」重灾区)。编辑会话的
	 * 约束每轮贴在生成点旁(格 C),位置已经最优,不要再进锚重复一遍。
	 *
	 * 与背景包里那份的关系:速查是**精简名单**(名称 + 截断文本),不是第二份全文;
	 * 锚每轮重渲染、不落历史,不存在「两份旧版打架」的堆叠问题。
	 */
	readonly constraints?: readonly { readonly name: string; readonly text: string }[];
}

/** 锚的块标题(测试与调用方共用,避免字符串各写各的)。 */
export const ANCHOR_HEADER = "【常驻记忆锚 · 每轮刷新】";
export const ANCHOR_MEMORY_TITLE = "【跨章节记忆 memory.md】";
/** 锚里的硬约束速查块标题(与格 C 的【写作约束】刻意不同名,避免被误判成重复注入)。 */
export const ANCHOR_CONSTRAINTS_TITLE = "【写作约束 · 速查】";
/** 速查块总字符上限:超了按序截断并注明还有几条在背景包/世界书里。 */
export const ANCHOR_CONSTRAINTS_LIMIT = 400;

/**
 * 格 D 的锚正文(不含 {@link ANCHOR_HEADER} 那行总说明 —— 由 {@link renderAnchor} 加)。
 *
 * **只装跨轮恒定的事实**:模式行 + 当前章节 + memory.md。
 *
 * 刻意**不装**(2026-10-06 收敛,此前它们都在这里重复过一遍;2026-10-11 起
 * Notice/发展线/世界观/约束全部归格 C,更不该在这里出现):
 * - **Notice / 发展线** → 归格 C。放在锚里等于每轮重付一次,而锚的价值恰恰在于
 *   「内容稳定、可缓存」。
 *
 * 模式行**保持在最前**:它是这一轮最优先的约束(能不能碰文件)。独立于 blocks
 * 之外 —— 即使这本书还没有任何世界状态,讨论态的约束也必须在(2026-10-05)。
 */
export function planAnchorBlocks(input: AnchorPlanInput): { modeLine: string; head: string; blocks: string[] } {
	const blocks: string[] = [];
	const memory = input.memory?.trim();
	if (memory && memory.length > 0) blocks.push(`${ANCHOR_MEMORY_TITLE}\n${memory}`);
	const constraints = (input.constraints ?? []).filter((c) => c.text.trim().length > 0);
	if (constraints.length > 0) {
		const lines = constraints.map((c) => `- ${c.name}: ${c.text}`);
		let body = lines.join("\n");
		let overflow = 0;
		while (body.length > ANCHOR_CONSTRAINTS_LIMIT && lines.length > 1) {
			overflow++;
			body = lines.slice(0, lines.length - overflow).join("\n");
		}
		if (overflow > 0) body += `\n(另有 ${overflow} 条约束见背景包 / world.json)`;
		blocks.push(`${ANCHOR_CONSTRAINTS_TITLE}\n${body}`);
	}
	return {
		modeLine: input.mode ? `${modeAnchorLine(input.mode)}\n` : "",
		head: input.chapterFile ? `当前章节: ${input.chapterFile}\n` : "",
		blocks,
	};
}

/**
 * 渲染完整的记忆锚文本;无内容时返回空串(调用方据此跳过注入)。
 *
 * 结构:`【常驻记忆锚 · 每轮刷新】` 总说明 → 模式行 → 当前章节 → memory.md。
 *
 * **空串判据(与收口前逐字一致,2026-10-06 复刻)**:只有「模式行」与「块」
 * 参与判定 —— **章节行单独不构成锚**。
 *
 * 为什么章节行不算:锚的价值是把「丢了就会写错」的事实钉进 systemPrompt。
 * 只有章节名而无任何记忆/模式时,注入一段开头「以下事实跨轮次、跨压缩恒定」
 * 却只跟一句文件名的锚,是纯噪声 —— 且它每轮都会成为新的 systemPrompt 尾部,
 * 白付一次全价未缓存输入。空书(刚建、还没世界状态也没 memory.md)必须走
 * 空串分支,钩子据此跳过注入。
 */
export function renderAnchor(input: AnchorPlanInput): string {
	const { modeLine, head, blocks } = planAnchorBlocks(input);
	if (modeLine.length === 0 && blocks.length === 0) return "";
	return `${ANCHOR_HEADER}以下事实跨轮次、跨压缩恒定;与你的印象冲突时以这里为准,需要更多细节就 read 对应文件(memory.md / world.json)。\n${modeLine}${head}${blocks.join("\n\n")}`;
}

// ——————————————————————————————————————————————————————————————
// 格 E:背景包(按会话类型)
// ——————————————————————————————————————————————————————————————

export interface PackPlanInput {
	readonly sessionKind: SessionKind;
	readonly world: WorldData;
	/** 已按预算裁剪的 memory.md 正文。 */
	readonly memory?: string;
	readonly milestoneLimit?: number;
	readonly noticeLimit?: number;
}

/**
 * 背景包该含哪些**格的内容** —— 按会话类型决定。
 *
 * 这是「分格按会话类型成立」的落点:主会话/TUI 没有每轮上下文,背景包是它们看到
 * 世界观/约束/Notice/memory 的**唯一途径**,故必须全给;而编辑会话走自己的
 * 每轮上下文,不该再走背景包(否则同一份数据两处注入)。
 *
 * 返回的是**内容 id 集合**(不是文本),调用方据此决定要不要装各自那一段。
 */
export function packContents(kind: SessionKind): readonly string[] {
	switch (kind) {
		case "main":
			// 主会话:无每轮上下文 → 背景包承载全部(除模式行/章节行,那些走锚)
			return ["memory", "worldSummary", "constraints", "notice", "storyline"];
		case "tui":
			// TUI:有锚(也有压缩接管),但历史上背景包就是全量 —— 冻结期不改行为
			return ["memory", "worldSummary", "constraints", "notice", "storyline"];
		case "editor":
			// 编剧会话**不走背景包**(它有自己的格 C/D)。留空以免误用。
			return [];
		case "stage":
			// 舞台角色另有自己的 context 钩子,不经此函数
			return [];
	}
}
