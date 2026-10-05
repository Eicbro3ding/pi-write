/**
 * `/inspect` 的数据组装(2026-10-04,T5 上下文可视化)。
 *
 * 这一层只负责「把已经存在的事实整理成可展示的行」,不碰 TUI,也不碰 HTTP——
 * 两侧(TUI 面板 / Web 面板)共用同一份数据形状,免得到时候两边的口径漂移。
 *
 * 设计原则(pi 的「透明、归用户」):
 * - 只报告已经发生的事,不预测、不算「节省了多少」这类无法验证的数字;
 * - 每一项都必须能追溯到用户可干预的设置项(哪一项被谁裁了 → 调哪个字段)。
 */

import type { ChapterContextResult, ContextSection, TrimRecord } from "../world-context.ts";
import type { WriterSettings } from "../writer-settings.ts";

/** 一段在面板里的展示行。 */
export interface InspectSectionRow {
	/** 段 id(与 ContextSection.id 同源,供 UI 着色/排序)。 */
	id: ContextSection["id"];
	/** 展示名。 */
	label: string;
	/** 该段实际进入上下文的 token 数(0 = 该段本次为空)。 */
	tokens: number;
	/** 该段包含的条目数。 */
	count: number;
	/** 占总预算的百分比(0-100,四舍五入)。 */
	percent: number;
	/** 人类可读的占用描述,如 `420 / 2000(21%)`。 */
	usage: string;
	/** 该段是否可被裁 —— 供 UI 用不同颜色提示「这段是有可能丢的」。 */
	trimmable: boolean;
}

/** 一条被省掉的内容。 */
export interface InspectTrimRow {
	/** 类别。 */
	kind: TrimRecord["kind"];
	/** 展示名(条目类为条目标题)。 */
	label: string;
	/** 省掉的 token 数。 */
	tokens: number;
	/** 一句话说明「丢了会怎样」。 */
	impact: string;
}

/** 面板里的一个可调项:当前值 + 取值范围 + 影响说明。 */
export interface InspectBudgetRow {
	/** 设置字段名(与 WriterSettings 一致,用户可据此去设置里改)。 */
	key: keyof WriterSettings;
	/** 展示名。 */
	label: string;
	/** 当前生效值。 */
	value: number;
	/** 取值范围。 */
	range: string;
	/** 一句话说明它管什么。 */
	effect: string;
}

/** 一次上下文装配的完整检视结果。 */
export interface InspectReport {
	/** 书 slug。 */
	slug: string;
	/** 章节文件(相对路径)。 */
	chapterFile: string;
	/** 该章标题(拿不到为空串)。 */
	chapterTitle: string;
	/** 上下文总预算(来自设置)。 */
	budget: number;
	/** 已用 token(各段之和,按分段快照算 —— 与 buildChapterContext 的滚动 used 同量级)。 */
	used: number;
	/** 已用占比(0-100)。 */
	percent: number;
	/** 分段占用(按占用降序)。 */
	sections: InspectSectionRow[];
	/** 被省掉的内容(空数组 = 没有裁切)。 */
	trimmed: InspectTrimRow[];
	/** 相关可调设置。 */
	budgetItems: InspectBudgetRow[];
}

const TRIM_IMPACT: Record<TrimRecord["kind"], string> = {
	entry: "模型看不到这条设定,可能把「没写进世界书」当作事实",
	summary: "世界观基调丢失,细节设定仍在(世界书条目未受影响)",
	milestones: "已完成的目标可能被重复推进 —— 这一段装的是「勿再追求」清单",
};

/** 可被预算挤掉的段 —— 与 buildChapterContext 里的裁剪顺序一致。 */
const TRIMMABLE: ReadonlySet<ContextSection["id"]> = new Set(["summary", "entries", "storyline"]);

/** 展开为面板行(按占用降序;占用为 0 的段仍然保留,让用户看到「这段是空的」)。 */
export function buildInspectReport(args: {
	slug: string;
	chapterFile: string;
	chapterTitle?: string;
	context: Pick<ChapterContextResult, "sections" | "trimmed">;
	settings: WriterSettings;
}): InspectReport {
	const { slug, chapterFile, chapterTitle = "", context, settings } = args;
	const budget = settings.contextBudget;
	const rows: InspectSectionRow[] = context.sections.map((s) => {
		const percent = budget > 0 ? Math.round((s.tokens / budget) * 100) : 0;
		return {
			id: s.id,
			label: s.label,
			tokens: s.tokens,
			count: s.count,
			percent,
			usage: `${s.tokens} / ${budget}(${percent}%)`,
			trimmable: TRIMMABLE.has(s.id),
		};
	});
	// 展示顺序:占用大的在前 —— 用户一眼看到「谁在吃预算」。
	rows.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
	const used = rows.reduce((sum, r) => sum + r.tokens, 0);
	const trimmed: InspectTrimRow[] = context.trimmed.map((t) => ({
		kind: t.kind,
		label: t.label,
		tokens: t.tokens,
		impact: TRIM_IMPACT[t.kind],
	}));
	return {
		slug,
		chapterFile,
		chapterTitle,
		budget,
		used,
		percent: budget > 0 ? Math.round((used / budget) * 100) : 0,
		sections: rows,
		trimmed,
		budgetItems: budgetItems(settings),
	};
}

/** 与上下文装配相关的可调项 —— 只列真的有影响的,不堆设置全表。 */
export function budgetItems(s: WriterSettings): InspectBudgetRow[] {
	return [
		{ key: "contextBudget", label: "上下文预算", value: s.contextBudget, range: "200 - 20000", effect: "背景包总量上限,超出即按下面的顺序裁" },
		{ key: "memoryBudget", label: "记忆预算", value: s.memoryBudget, range: "100 - 20000", effect: "跨章节记忆 memory.md 注入前的裁剪上限" },
		{ key: "activationDepth", label: "激活深度", value: s.activationDepth, range: "0 - 5", effect: "0 = 只注入关键词命中的条目;越大越会带出关联条目" },
		{ key: "noticeInjectLimit", label: "Notice 条数", value: s.noticeInjectLimit, range: "0 - 50", effect: "注入的未完成备忘条数上限" },
		{ key: "completedMilestoneLimit", label: "里程碑条数", value: s.completedMilestoneLimit, range: "0 - 30", effect: "发展线里「已完成」节点的注入条数上限" },
	];
}

/**
 * 面板的一行标题摘要(给 `notify` 用;完整内容走面板)。
 *
 * 例:`背景包 820 / 2000(41%)· 世界书 5 段 · 省略 2 项`
 */
export function inspectHeadline(r: InspectReport): string {
	const parts = [`背景包 ${r.used} / ${r.budget}(${r.percent}%)`];
	const entries = r.sections.find((s) => s.id === "entries");
	if (entries && entries.count > 0) parts.push(`世界书 ${entries.count} 条`);
	if (r.trimmed.length > 0) parts.push(`省略 ${r.trimmed.length} 项`);
	else parts.push("无裁切");
	return parts.join(" · ");
}
