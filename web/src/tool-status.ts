/**
 * 简化输出模式下的工具动作流:工具名 → 中文动作 + 宾语(在改哪个文件/搜什么)。
 *
 * 依据设计稿 03-组件规范/05:简化模式不是「什么都不显示」,而是把工具调用压成
 * 一行可读的动作——**带上宾语**(在改哪个文件)、**完成的行留在流水里**、
 * **不用 emoji**(各平台渲染不一致;图标在组件侧用线性 SVG)。
 * 覆盖 web 工具集(web.ts ALL_WEB_TOOLS,移动端剔除 grep/find);
 * 未知工具回退通用文案,保证任何工具都有对应提示。
 */
import { parseToolArgs, pathFromArgs } from "./preview.ts";

/** 进行中文案(工具名 → 现在进行时)。 */
export const TOOL_STATUS: Record<string, string> = {
	read: "正在阅读",
	write: "正在编辑",
	edit: "正在编辑",
	grep: "正在搜索",
	find: "正在查找",
	ls: "正在查看",
	word_count: "正在统计字数",
	world_update: "正在更新世界书",
	world_find: "正在查阅世界书",
};
export const DEFAULT_TOOL_STATUS = "正在调用工具";

/**
 * 失败文案(工具名 → 失败时)。设计稿 03-组件规范/05 的 V1 示例是
 * 「✕ 写入失败 notes/city.md」——失败行给的是**失败动词**,而不是「已编辑」+ 红叉。
 */
export const TOOL_FAIL: Record<string, string> = {
	read: "读取失败",
	write: "写入失败",
	edit: "写入失败",
	grep: "搜索失败",
	find: "查找失败",
	ls: "列出失败",
	word_count: "统计失败",
	world_update: "更新失败",
	world_find: "查阅失败",
};
export const DEFAULT_TOOL_FAIL = "调用失败";

/** 完成文案(工具名 → 已完成时);设计稿要求完成的行留在流水里。 */
export const TOOL_DONE: Record<string, string> = {
	read: "已阅读",
	write: "已编辑",
	edit: "已编辑",
	grep: "已搜索",
	find: "已列出",
	ls: "已列出",
	word_count: "已统计",
	world_update: "已更新世界书",
	world_find: "已查阅世界书",
};
export const DEFAULT_TOOL_DONE = "已调用";

/** 图标族:组件侧按它选一枚线性 SVG(不用 emoji)。 */
export type ToolIcon = "read" | "edit" | "search" | "find" | "count" | "world" | "other";

/** 工具名 → 图标族。 */
export function toolIcon(name: string): ToolIcon {
	switch (name) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "grep":
			return "search";
		case "find":
		case "ls":
			return "find";
		case "word_count":
			return "count";
		case "world_update":
		case "world_find":
			return "world";
		default:
			return "other";
	}
}

/** 动作流的一行(渲染所需最小形状)。 */
export interface ToolActionRow {
	name: string;
	/** 动作文案(进行中或已完成)。 */
	verb: string;
	/** 宾语:文件路径 / 搜索词;取不到为空串。 */
	object: string;
	running: boolean;
	isError: boolean;
	icon: ToolIcon;
}

/** 工具 args → 宾语(优先 path,其次查询类字段,最后退回原始 args 首段)。 */
export function toolObject(args: string): string {
	const parsed = parseToolArgs(args);
	const path = pathFromArgs(parsed);
	if (path) return path;
	if (parsed) {
		for (const key of ["pattern", "query", "q", "glob", "title", "id", "name"]) {
			const v = parsed[key];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	const raw = args.trim().replace(/^["']|["']$/g, "");
	if (raw.length === 0) return "";
	// 非 JSON 的裸参(如 search_web "打击 深海鱼骨 捕捞"):取首行、限长;
	// JSON 形态但取不到已知字段时宁可不显示宾语,也不要糊一整串键值给用户
	const first = raw.split("\n")[0]!;
	if (first.startsWith("{") || first.startsWith("[")) return "";
	return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/** 单次工具调用 → 动作流行。失败优先:「✕ 写入失败 …」而不是「✕ 已编辑 …」。 */
export function toolActionRow(t: { name: string; args: string; result: string | null; isError: boolean }): ToolActionRow {
	const running = t.result === null && !t.isError;
	const verb = t.isError
		? (TOOL_FAIL[t.name] ?? DEFAULT_TOOL_FAIL)
		: running
			? (TOOL_STATUS[t.name] ?? DEFAULT_TOOL_STATUS)
			: (TOOL_DONE[t.name] ?? DEFAULT_TOOL_DONE);
	return {
		name: t.name,
		verb,
		object: toolObject(t.args),
		running,
		isError: t.isError,
		icon: toolIcon(t.name),
	};
}

/** 简化输出下保留几条已完成动作(设计稿「保留最近 3 条已完成动作,随消息一起留在会话里」)。 */
export const ACTION_FLOW_KEEP = 3;

/**
 * 流水筛选:进行中的全部保留 + 最近 N 条已完成/失败,其余丢弃;保持原有先后顺序。
 * bash 不在这里显示(它始终渲染完整卡片,见 MessageList)。
 */
export function actionFlowTools<T extends { name: string; result: string | null }>(tools: readonly T[], keep = ACTION_FLOW_KEEP): T[] {
	const shown = new Set<number>();
	for (let i = 0; i < tools.length; i++) if (tools[i]!.result === null) shown.add(i);
	let done = 0;
	for (let i = tools.length - 1; i >= 0; i--) {
		if (tools[i]!.result === null) continue;
		if (done < keep) {
			shown.add(i);
			done++;
		}
	}
	return tools.filter((_, i) => shown.has(i));
}
