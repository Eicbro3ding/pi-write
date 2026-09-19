/**
 * AI 编辑实时预览 —— 纯逻辑层(不 import React/vendor,供 vitest 单测)。
 * 分类工具调用 → 判定预览类型;解析工具 args;行级 diff;世界书 diff。
 */
import type { StageScriptDto, WorldDataDto, WorldEntryDto, WorldRelationDto } from "./types.ts";

/** 预览类型:draft = 草稿文档 diff;world = 世界树关系图。 */
export type PreviewKind = "draft" | "world";

/**
 * 判定工具调用是否生成预览及类型。
 * write/edit 的目标以 args.path(相对书目录)判定;world_update 无条件算 world。
 */
export function classifyToolCall(toolName: string, path: string | undefined): PreviewKind | null {
	if (toolName === "world_update") return "world";
	if ((toolName === "write" || toolName === "edit") && typeof path === "string") {
		if (path === "world.json" || path.endsWith("/world.json")) return "world";
		if (path.startsWith("draft/")) return "draft";
	}
	return null;
}

/** 工具 args 可能是字符串(JSON)或对象;统一为对象,非法输入返回 null。 */
export function parseToolArgs(args: unknown): Record<string, unknown> | null {
	if (typeof args === "string") {
		try {
			const v = JSON.parse(args) as unknown;
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}
	if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
	return null;
}

/** 从工具 args 取 path 字段(非字符串视为缺省)。 */
export function pathFromArgs(args: Record<string, unknown> | null): string | undefined {
	return typeof args?.path === "string" ? args.path : undefined;
}

import { diffLines } from "diff";

/** 行级 diff 的一行:add = 新增,remove = 删除,context = 上下文。 */
export interface DiffLine {
	kind: "add" | "remove" | "context";
	text: string;
}

/**
 * 草稿编辑的 before/after 行级对比(jsdiff diffLines)。
 * 每条变更块按行展开;value 以 \n 结尾产生的末尾空串去掉,行内空行保留。
 */
export function buildDraftDiff(before: string, after: string): DiffLine[] {
	const out: DiffLine[] = [];
	for (const change of diffLines(before, after)) {
		const kind: DiffLine["kind"] = change.added ? "add" : change.removed ? "remove" : "context";
		const lines = change.value.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		for (const text of lines) out.push({ kind, text });
	}
	return out;
}

/** 世界树编辑的条目/关系增删改清单(关系图高亮与摘要行数据)。 */
export interface WorldDiff {
	addedEntries: WorldEntryDto[];
	modifiedEntries: WorldEntryDto[];
	removedEntries: WorldEntryDto[];
	addedRelations: WorldRelationDto[];
	removedRelations: WorldRelationDto[];
	modifiedRelations: WorldRelationDto[];
}

/** 参与「条目是否修改」比较的字段;updatedAt/avatar/images/chapters 不参与。 */
const ENTRY_DIFF_FIELDS = ["title", "type", "body", "status", "parent", "tags", "active", "keys"] as const;

/** 条目是否有实质修改(JSON 序列化比较字段值,数组顺序敏感)。 */
export function entryChanged(a: WorldEntryDto, b: WorldEntryDto): boolean {
	return ENTRY_DIFF_FIELDS.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
}

/** 关系是否有实质修改(type/label/emphasized/arrow)。 */
export function relationChanged(a: WorldRelationDto, b: WorldRelationDto): boolean {
	return a.type !== b.type || a.label !== b.label || a.emphasized !== b.emphasized || a.arrow !== b.arrow;
}

/** 世界书 before/after 对比,按 id 归位条目与关系的增删改。 */
export function buildWorldDiff(before: WorldDataDto, after: WorldDataDto): WorldDiff {
	const beforeEntries = new Map(before.entries.map((e) => [e.id, e]));
	const afterEntries = new Map(after.entries.map((e) => [e.id, e]));
	const beforeRels = new Map(before.relations.map((r) => [r.id, r]));
	const afterRels = new Map(after.relations.map((r) => [r.id, r]));
	return {
		addedEntries: after.entries.filter((e) => !beforeEntries.has(e.id)),
		removedEntries: before.entries.filter((e) => !afterEntries.has(e.id)),
		modifiedEntries: after.entries.filter((e) => {
			const b = beforeEntries.get(e.id);
			return !!b && entryChanged(b, e);
		}),
		addedRelations: after.relations.filter((r) => !beforeRels.has(r.id)),
		removedRelations: before.relations.filter((r) => !afterRels.has(r.id)),
		modifiedRelations: after.relations.filter((r) => {
			const b = beforeRels.get(r.id);
			return !!b && relationChanged(b, r);
		}),
	};
}

/**
 * 预览卡数据:每个工具块最多一张,内容 = 该次编辑的结果。
 * draft = 该次编辑的 diff;world 按变更类型分流(graph = 结构变化出图,
 * entry = 仅词条修改出百科卡);fetch 失败走 error。
 *
 * 2026-09-19:预览卡不再是「锚定在 assistant 消息下的独立层」,而是**工具块自己的
 * 渲染结果** —— 挂载键从消息 id(anchorId)换成工具调用 id(toolCallId)。
 * 于是「卡片找宿主消息」这件事整个消失:块在,卡就在;块不在,卡就不渲染。
 */
export type PreviewData =
	| {
			kind: "draft";
			toolName: string;
			sections: Array<{ path: string; diff: DiffLine[] }>;
	  }
	| {
			kind: "world";
			toolName: string;
			slug: string | null;
			mode: "graph";
			afterWorld: WorldDataDto;
			worldDiff: WorldDiff;
	  }
	| {
			kind: "world";
			toolName: string;
			slug: string | null;
			mode: "entry";
			entries: WorldEntryDto[];
			allEntries: WorldEntryDto[];
			relations: WorldRelationDto[];
	  }
	// 剧本确认门(2026-08-11):导演 script_confirm 提交的剧本——预览卡片家族的一种
	// (与草稿 diff/世界书预览同一渲染通道),确认/修改动作由调用方经 PreviewCard
	// 的 actions 插槽提供
	| {
			kind: "script";
			toolName: "script_confirm";
			sceneId: string;
			script: StageScriptDto;
	  }
	| { kind: "draft" | "world"; error: true; toolName: string; path: string | null };

/**
 * 旧形状的确认卡判定:改造前用 anchorId 锚定 assistant 消息,无法反推工具调用 id。
 * 服务端持久化的卡里若还是这种形状,认领不到工具块 → 恢复时丢弃
 * (文件已落盘,只是确认/回退入口不再提供)。
 */
export function isLegacyConfirmCard(c: { toolCallId?: unknown }): boolean {
	return typeof c.toolCallId !== "string" || c.toolCallId.length === 0;
}

/** 草稿预览的折叠头统计:首个文件路径 + 全部 section 的增删行数。 */export function draftDiffStats(data: PreviewData): { path: string; add: number; del: number } | null {
	if ("error" in data || data.kind !== "draft" || data.sections.length === 0) return null;
	let add = 0;
	let del = 0;
	for (const s of data.sections) {
		for (const l of s.diff) {
			if (l.kind === "add") add++;
			else if (l.kind === "remove") del++;
		}
	}
	return { path: data.sections[0]!.path, add, del };
}

/**
 * 世界树变更分类:
 * 结构变化(新增/删除条目、关系增删改)→ 图;仅词条内容修改 → 百科卡;
 * 非词条变更(时间线/Notice/发展线/约束/采样)→ null(不弹卡)。
 */
export function classifyWorldChange(diff: WorldDiff): { mode: "graph" } | { mode: "entry" } | null {
	const structural =
		diff.addedEntries.length > 0 ||
		diff.removedEntries.length > 0 ||
		diff.addedRelations.length > 0 ||
		diff.removedRelations.length > 0 ||
		diff.modifiedRelations.length > 0;
	if (structural) return { mode: "graph" };
	if (diff.modifiedEntries.length > 0) return { mode: "entry" };
	return null;
}
