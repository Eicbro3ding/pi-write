/**
 * `/` 命令注册表(前端插件系统的第一个预留缝,2026-08):
 *
 * 内置 `/node`(注入世界树节点原文)与 `/chapter`(注入某一章原文)以同一套
 * `SlashCommand` 接口挂载;未来声明式用户插件只需注册新的命令定义,
 * 不触碰 InputBar / 页面装配代码。
 *
 * 安全边界:命令是前端声明 + 页面提供的受信任回调,渲染进程不执行任何
 * 用户提供的任意代码(插件 JS 一律留在后端 / vendor ExtensionAPI 侧)。
 */
import type { ApiClient } from "./api/client.ts";
import type { BookDetail, ChapterRef, WorldDataDto, WorldEntryDto } from "./types.ts";
import { ENTRY_TYPE_LABELS } from "./world-entry.ts";

/** 命令执行上下文:由页面每次渲染时传入 InputBar,搜索/动作读最新书与章节。 */
export interface SlashContext {
	client: ApiClient;
	/** 当前书 slug(书库未就位时 null)。 */
	slug: string | null;
	bookDetail: BookDetail | null;
	/** 当前章节会话文件 basename(如 ch01.jsonl)。 */
	currentChapterFile: string | null;
}

/** 命令面板里的一个候选项。 */
export interface SlashSuggestion {
	id: string;
	/** 主标签(世界条目显示「人物 · 林婉」)。 */
	label: string;
	/** 右侧弱化提示。 */
	hint?: string;
	/** 附加信息(类型 / 字数 / 附加要求)。 */
	meta?: string;
	/** 选中后立即插入输入框的文本(insert 命令)。 */
	insertText?: string;
	/** 选中后异步加载再插入的文本(章节全文按需读取,避免搜索时预读所有草稿)。 */
	loadText?: (ctx: SlashContext) => Promise<string>;
}

/** 一条 `/` 命令。 */
export interface SlashCommand {
	/** 不带斜杠的触发名,如 "node"。 */
	trigger: string;
	aliases?: readonly string[];
	/** 命令面板里的说明。 */
	hint: string;
	/** action 命令:选中直接执行,不插入文本(如 /compact)。 */
	run?: (term: string, ctx: SlashContext) => Promise<void>;
	/** insert 命令:按 term 异步搜索候选项。 */
	search?: (term: string, ctx: SlashContext) => Promise<SlashSuggestion[]>;
}

/** 光标处正在输入的斜杠查询。 */
export interface SlashQuery {
	/** 命令名(不含斜杠),如 "node";只输入 "/" 时为空串 = 展示全部命令。 */
	trigger: string;
	/** 命令名之后的参数(按当前光标位置截取,已 trim)。 */
	term: string;
	/** 查询在输入框中的起止位置(选中候选后替换/移除该区间)。 */
	start: number;
	end: number;
}

/**
 * 从输入框文本 + 光标位置解析斜杠查询。
 * 只认「光标所在 token 以 / 开头」的形态:命令名取到第一个空白字符为止,
 * term 为命令名之后到光标为止的文本——因此 `/node 林婉` 在光标位于句尾时
 * 得到 trigger="node"、term="林婉",选中候选会替换整段 `/node 林婉`。
 * 非命令文本(如正文中的 URL 或 `/fix` 被写在消息中段)不会被误触发。
 */
export function parseSlashQuery(text: string, cursor: number): SlashQuery | null {
	const pos = Math.max(0, Math.min(cursor, text.length));
	// 在「光标之前」找最近一个以 / 开头的空白分隔 token:命令名只取到第一个空白,
	// 其后到光标为止的文本作为 term——因此 `/node 林婉` 光标在句尾时仍保持
	// 面板打开,并得到 trigger="node"、term="林婉"。
	const prefix = text.slice(0, pos);
	const match = /(?:^|[\s])\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(prefix);
	if (!match) return null;
	const slashIndex = match.index + (prefix[match.index] === "/" ? 0 : 1);
	return {
		trigger: match[1] ?? "",
		term: (match[2] ?? "").trim(),
		start: slashIndex,
		end: pos,
	};
}

/** trigger 是否命中命令(前缀匹配;trigger 为空串 = 展示全部)。 */
export function slashCommandMatches(command: SlashCommand, trigger: string): boolean {
	if (trigger.length === 0) return true;
	if (command.trigger.startsWith(trigger)) return true;
	return (command.aliases ?? []).some((a) => a.startsWith(trigger));
}

/** 世界条目搜索评分:标题/触发词精确 > 前缀 > 包含;body 命中最低。 */
export function scoreWorldEntry(entry: WorldEntryDto, query: string): number {
	const q = query.toLowerCase();
	if (q.length === 0) return 1;
	const title = entry.title.toLowerCase();
	if (title === q) return 100;
	if (title.startsWith(q)) return 80;
	if (title.includes(q)) return 60;
	const keys = entry.keys.map((k) => k.toLowerCase());
	if (keys.some((k) => k === q)) return 50;
	if (keys.some((k) => k.startsWith(q))) return 45;
	if (keys.some((k) => k.includes(q))) return 40;
	if (entry.id.toLowerCase().includes(q)) return 30;
	if (entry.body.toLowerCase().includes(q)) return 20;
	return 0;
}

/** 世界条目 → 注入文本(块标签 + 完整 body;未激活条目显式标注,便于用户知情)。 */
export function worldEntryInsertText(entry: WorldEntryDto): string {
	const typeLabel = ENTRY_TYPE_LABELS[entry.type] ?? entry.type;
	const activeNote = entry.active ? "" : "（未激活）";
	return `【世界书 · ${typeLabel} · ${entry.title}${activeNote}】\n${entry.body}`;
}

/** 世界条目 → 面板候选(搜索排序后映射)。 */
export function worldEntrySuggestion(entry: WorldEntryDto): SlashSuggestion {
	const typeLabel = ENTRY_TYPE_LABELS[entry.type] ?? entry.type;
	const preview = entry.body.replace(/\s+/g, " ").trim().slice(0, 30);
	return {
		id: entry.id,
		label: `${typeLabel} · ${entry.title || "未命名"}`,
		hint: entry.keys.length > 0 ? entry.keys.slice(0, 3).join(" / ") : preview,
		meta: `${entry.active ? "" : "未激活 · "}${entry.body.length} 字`,
		insertText: worldEntryInsertText(entry),
	};
}

/** `/node <搜索>`:世界树节点原文注入(数据源 = world.json,与世界书页树同源)。 */
export function makeNodeCommand(opts: {
	/** 页面提供的懒加载 + 缓存函数;无书 / 读取失败返回 null。 */
	loadWorld: () => Promise<WorldDataDto | null>;
}): SlashCommand {
	return {
		trigger: "node",
		aliases: ["world", "entry"],
		hint: "注入世界树节点原文(标题/触发词搜索)",
		search: async (term, ctx) => {
			if (!ctx.slug) return [];
			const world = await opts.loadWorld();
			if (!world) return [];
			const q = term.trim().toLowerCase();
			const ranked = world.entries
				.map((entry) => ({ entry, score: scoreWorldEntry(entry, q) }))
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score);
			return ranked.slice(0, 10).map((x) => worldEntrySuggestion(x.entry));
		},
	};
}

/** `/chapter <搜索>`:某一章原文注入(章节列表来自 bookDetail,全文选中时按需读取)。 */
export function makeChapterCommand(): SlashCommand {
	return {
		trigger: "chapter",
		aliases: ["draft"],
		hint: "注入某一章原文(选中后读取当前草稿全文)",
		search: async (term, ctx) => {
			const chapters = ctx.bookDetail?.chapters ?? [];
			const q = term.trim().toLowerCase();
			const matched = chapters
				.map((ch) => {
					const hay = `${ch.id} ${ch.title} ${ch.label ?? ""} ${ch.file}`.toLowerCase();
					let score = 1;
					if (q.length > 0) {
						if (!hay.includes(q)) return null;
						score = ch.id.toLowerCase() === q ? 100 : ch.title.toLowerCase() === q ? 90 : hay.startsWith(q) ? 80 : 50;
					}
					return { ch, score };
				})
				.filter((x): x is { ch: ChapterRef; score: number } => x !== null)
				.sort((a, b) => b.score - a.score || a.ch.id.localeCompare(b.ch.id));
			return matched.slice(0, 10).map(({ ch }) => {
				const file = `draft/${ch.file.replace(/\.jsonl$/, ".md")}`;
				return {
					id: `chapter:${ch.file}`,
					label: `${ch.id} · ${ch.title || "未命名"}${ch.label ? ` · ${ch.label}` : ""}`,
					hint: file,
					meta: "原文",
					loadText: async (ctx2) => {
						const { text } = await ctx2.client.getDraft(file, ctx2.slug ?? undefined);
						const heading = `【原文 · ${ch.id}${ch.title ? `《${ch.title}》` : ""} · ${file}】`;
						return text.trim().length > 0 ? `${heading}\n${text}` : `${heading}\n（该章正文为空）`;
					},
				} satisfies SlashSuggestion;
			});
		},
	};
}

/** `/compact`:压缩当前会话上下文;term 作为附加整理要求传给模型。 */
export function makeCompactCommand(opts: {
	run: (instructions: string) => Promise<void>;
	hint?: string;
}): SlashCommand {
	return {
		trigger: "compact",
		aliases: ["compress"],
		hint: opts.hint ?? "压缩当前对话上下文(可附加整理要求,如 /compact 保留最近冲突)",
		run: async (term) => {
			await opts.run(term.trim());
		},
	};
}
