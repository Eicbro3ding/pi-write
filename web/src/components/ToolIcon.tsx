/**
 * 工具图标:设计稿 03-组件规范/05「动作词表」里给每个工具配的那枚 lucide 图标,
 * 与动作流/工具卡共用一套(不再手绘;名字与设计稿的 icon 节点一致)。
 *
 *   read         → eye            阅读(看一眼)
 *   write / edit → pen-line       落笔编辑
 *   grep         → search         全文搜索
 *   find / ls    → folder-search  目录里找
 *   word_count   → hash           计数
 *   world_update → network        改世界树(节点与关系)
 *   world_find   → book-open      查世界书
 *   其他         → wrench         通用工具
 */
import { Lu } from "./Lu.tsx";
import type { ToolIcon as ToolIconKind } from "../tool-status.ts";

const MAP: Record<ToolIconKind, "eye" | "pen-line" | "search" | "folder-search" | "hash" | "network" | "book-open" | "wrench"> = {
	read: "eye",
	edit: "pen-line",
	search: "search",
	find: "folder-search",
	count: "hash",
	world: "network",
	other: "wrench",
};

export function ToolIcon({ kind, size = 13 }: { kind: ToolIconKind; size?: number }) {
	return <Lu icon={MAP[kind]} size={size} />;
}
