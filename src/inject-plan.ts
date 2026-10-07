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
 * - **B 指纹去重**:内容稳定、偶有变化 → 用指纹去重,只在新内容出现时重注入。
 *   适合放「改了就该全局生效、且改得不多」的东西。
 * - **C 每轮易变**:每轮都可能变。进指纹层会不断击穿指纹、造成版本堆叠,故必须每轮注入。
 * - **D 每轮锚**:跨轮次恒定,但**必须抗压缩、抗注意力衰减** —— 走 systemPrompt 尾部,
 *   是唯一不依赖模型回忆的常驻通道。
 * - **E 生命周期**:不在常规轮次里,只在压缩/丢包这类事件触发。
 *
 * ## ⚠️ 分格**按会话类型**成立(2026-10-06 核实的硬约束)
 *
 * 不同会话能用的通道根本不同,所以格位不能一刀切:
 *
 * | 通道 | 编剧会话(`writer-host`) | 主会话(`web.ts`) | TUI |
 * |---|---|---|---|
 * | A 系统提示 | ✅ | ✅ | ✅ |
 * | B 指纹去重 | ✅ `stableContext` | ❌ **没有** | ❌ |
 * | C 每轮易变 | ✅ `editorContext` | ❌ | ❌ |
 * | D 每轮锚 | ✅(本轮新增) | ✅(锚) | ✅(锚) |
 * | E 背景包 | ❌ | ✅ **唯一来源** | ✅ |
 *
 * 关键事实(逐条 Read 核实):
 * - `extension.ts` **没有 `context` 钩子** —— 背景包只由 `server.ts` 注入主会话;
 * - 主会话的 `extensionFactories` 只有 `writerExtension`(`web.ts:244`)→ 只有锚,无稳定块;
 * - 故**背景包是主会话看到世界书/约束/Notice/memory 的唯一途径**,不能摘。
 *
 * 所以 `planSessionBlocks` 必须按会话类型给不同答案,而**编辑会话**侧的
 * `planStableBlocks` / `planPerTurnBlocks` / `planAnchorBlocks` 三格互斥。
 *
 * ## 互斥规则(本模块的核心不变量)
 *
 * **同一个会话内,每类内容只能出现在一格。** `test/inject-plan.test.ts` 用反证法
 * 钉住这一条:把任意内容同时塞进两格,测试必须变红。
 */

import { type SessionMode, modeAnchorLine } from "./session-mode.ts";
import type { WorldData } from "./world-data.ts";
import { buildStorylineView, constraintTargetMatches } from "./world-context.ts";

/** 会话类型 —— 决定能用哪些格位(见文件头表格)。 */
export type SessionKind = "editor" | "main" | "tui" | "stage";

/** 格位标识。 */
export type InjectSlot =
	/** B:指纹去重(稳定块)。 */
	| "stable"
	/** C:每轮易变。 */
	| "perTurn"
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
	// —— 格 B:指纹去重(变化少、需全局一致) ——
	{ id: "worldSummary", label: "世界观概述", slot: "stable" },
	{ id: "worldEntries", label: "世界书条目", slot: "stable" },
	{ id: "constraints", label: "写作约束", slot: "stable" },
	// Notice 归格 B 的理由(2026-10-06 拍板):它是「待办清单」,增删频率远低于
	// 发展线(写完一幕就动),内容稳定 → 适合指纹缓存。此前它在四个通道里各注一遍。
	{ id: "notice", label: "Notice 备忘录", slot: "stable" },

	// —— 格 C:每轮易变(每轮都可能变,进指纹层会击穿指纹) ——
	// 发展线归格 C 的理由:写完一幕就推进目标,几乎所有写作轮都会改它。
	// 放进稳定块 = 每轮都产生新指纹 = 每轮重注一份 = 版本堆叠(见 countStableContextInLeaf)。
	{ id: "storyline", label: "发展线", slot: "perTurn" },
	{ id: "draft", label: "当前正文", slot: "perTurn" },
	{ id: "transcript", label: "最近一幕舞台转录", slot: "perTurn" },

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
// 格 B:稳定块(指纹去重)
// ——————————————————————————————————————————————————————————————

export interface StablePlanInput {
	readonly world: WorldData;
	/** true = 经典模式(单一写作 agent),约束取 writer ∪ main;false = 编剧,只取 writer。 */
	readonly classicMode: boolean;
	/** Notice 条数上限(缺省 {@link NOTICE_LIMIT})。 */
	readonly noticeLimit?: number;
}

/**
 * 格 B 的块:世界观概述 + 世界书(character/world 全量) + 写作约束 + Notice。
 *
 * 顺序固定 —— 概述在最前是「先给全局再给细节」的阅读顺序,且与既有测试一致。
 * 内容为空时对应块**跳过**(不产生空块,避免污染指纹)。
 */
export function planStableBlocks(input: StablePlanInput): string[] {
	const { world } = input;
	const blocks: string[] = [];

	const summary = world.worldSummary?.trim();
	if (summary && summary.length > 0) {
		blocks.push(`【世界观概述】\n${truncate(summary, SUMMARY_LIMIT)}`);
	}

	const chars = world.entries
		.filter((e) => e.type === "character" || e.type === "world")
		.map((e) => `【${e.title}】${e.body}`)
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
		blocks.push(`【Notice·备忘录】\n${open.map((i) => `- [ ] ${i.text}`).join("\n")}`);
	}

	return blocks;
}

// ——————————————————————————————————————————————————————————————
// 格 C:每轮易变
// ——————————————————————————————————————————————————————————————

export interface PerTurnPlanInput {
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
 * 格 C 的块:发展线 + 当前正文 + 舞台转录。
 *
 * 发展线在此(而非格 B)是 2026-10-06 的拍板:它几乎每个写作轮都会变,
 * 放进指纹去重层会每轮产生新指纹 → 每轮重注一份稳定块 → 版本堆叠。
 */
export function planPerTurnBlocks(input: PerTurnPlanInput): string[] {
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
		if (view.currentTitle) lines.push(`当前位置: ${view.currentTitle}`);
		if (view.completed.length > 0) lines.push(`已完成(禁止重复追求/推进): ${view.completed.join("、")}`);
		if (lines.length > 0) blocks.push(`【发展线】\n${lines.join("\n")}`);
	}

	if (input.transcript) blocks.push(`【最近一幕舞台转录】\n${input.transcript}`);

	return blocks;
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
}

/** 锚的块标题(测试与调用方共用,避免字符串各写各的)。 */
export const ANCHOR_HEADER = "【常驻记忆锚 · 每轮刷新】";
export const ANCHOR_MEMORY_TITLE = "【跨章节记忆 memory.md】";

/**
 * 格 D 的锚正文(不含 {@link ANCHOR_HEADER} 那行总说明 —— 由 {@link renderAnchor} 加)。
 *
 * **只装跨轮恒定的事实**:模式行 + 当前章节 + memory.md。
 *
 * 刻意**不装**(2026-10-06 收敛,此前它们都在这里重复过一遍):
 * - **Notice** → 归格 B(指纹去重)。锚是每轮注入,Notice 放这里等于每轮重付一次;
 *   而 Notice 变化频率低,指纹层足以覆盖。
 * - **发展线** → 归格 C(每轮易变块)。理由同格 B 注释:它每轮都可能变,
 *   放在锚里会让锚的内容每轮都不同 —— 锚的价值恰恰在于「内容稳定、可缓存」。
 *
 * 模式行**保持在最前**:它是这一轮最优先的约束(能不能碰文件)。独立于 blocks
 * 之外 —— 即使这本书还没有任何世界状态,讨论态的约束也必须在(2026-10-05)。
 */
export function planAnchorBlocks(input: AnchorPlanInput): { modeLine: string; head: string; blocks: string[] } {
	const blocks: string[] = [];
	const memory = input.memory?.trim();
	if (memory && memory.length > 0) blocks.push(`${ANCHOR_MEMORY_TITLE}\n${memory}`);
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
 * 这是「分格按会话类型成立」的落点:主会话/TUI 没有稳定块,背景包是它们看到
 * 世界观/约束/Notice/memory 的**唯一途径**,故必须全给;而若将来给某个
 * 同时具备稳定块的会话禁用背景包冗余块,只需改这里的判断。
 *
 * 返回的是**内容 id 集合**(不是文本),调用方据此决定要不要装各自那一段。
 */
export function packContents(kind: SessionKind): readonly string[] {
	switch (kind) {
		case "main":
			// 主会话:无稳定块、无易变块 → 背景包承载全部(除模式行/章节行,那些走锚)
			return ["memory", "worldSummary", "constraints", "notice", "storyline"];
		case "tui":
			// TUI:有锚(也有压缩接管),但历史上背景包就是全量 —— 冻结期不改行为
			return ["memory", "worldSummary", "constraints", "notice", "storyline"];
		case "editor":
			// 编剧会话**不走背景包**(它有自己的格 B/C/D)。留空以免误用。
			return [];
		case "stage":
			// 舞台角色另有自己的 context 钩子,不经此函数
			return [];
	}
}
