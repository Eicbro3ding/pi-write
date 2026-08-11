/**
 * 舞台页纯逻辑层(不 import React/vendor,供 vitest 单测):
 * - reduceStage:舞台 UI 状态 reducer(快照 / SSE 事件 / 本地命令事件);
 * - stageEntryText / formatCounts / buildRevisePatch:展示与命令参数构造 helper。
 *
 * 舞台流(feed)两类行:舞台条目(快照/SSE)、系统行(stage_system 与命令结果)。
 * 导演对话(用户/导演气泡)不走 feed——2026-08-11 统一重构后与编剧/主会话同款
 * (processAgentEvent + MessageList),StagePage 从 stage_director_event 归约、
 * 快照 directorChat 水合,feed 不再含对话行。
 *
 * turnPending(「下一步」置灰)语义:回合进行中再发 /next 是服务端 no-op(§15.2),
 * 前端在发出后等待回合结束信号再放开按钮。每个回合(含 pass/超时/异常)结束时
 * 编排器必然 emit stage_entry(演出条目)或 stage_system(沉默/警告/异常行),
 * 因此两者任一到达即清除 turnPending——无超时兜底需求。
 */
import type { ActorTextDto, ScriptPatchDto, SharedTextDto, StageCountsDto, StageEntryDto, StageSnapshotDto } from "./types.ts";

export type StageFeedItem =
	| { type: "entry"; entry: StageEntryDto }
	| { type: "system"; text: string; err?: boolean };

export interface StageUiState {
	/** 服务端快照(null = 尚未拉取成功)。 */
	snapshot: StageSnapshotDto | null;
	/** 舞台流(条目 + 系统行)。 */
	feed: StageFeedItem[];
	/** 进行中的长命令(director/fix/cut);无长命令为 null。 */
	busy: string | null;
	/** 下一步已发出、等待回合结束信号(见文件头注释)。 */
	turnPending: boolean;
}

export type StageAction =
	| { type: "snapshot"; snapshot: StageSnapshotDto }
	| { type: "entry"; entry: StageEntryDto }
	| { type: "system"; text: string; err?: boolean }
	| { type: "done"; cmd: string; ok: boolean }
	| { type: "busy"; cmd: string }
	| { type: "wake" }
	/** 切书/切章:整体重置舞台流(旧对话残留 = 「串对话」根因,见 StagePage)。 */
	| { type: "reset" };

export function initialStageState(): StageUiState {
	return { snapshot: null, feed: [], busy: null, turnPending: false };
}

export function reduceStage(state: StageUiState, action: StageAction): StageUiState {
	switch (action.type) {
		case "snapshot": {
			// 快照(拉取/重连对齐):舞台条目以快照转录为准整体替换(磁盘是权威);
			// 导演对话(directorChat)由 StagePage 水合进 directorSession(MessageList),
			// 不进 feed(2026-08-11 统一重构)。幂等:重复快照按 entry 文本剔除重复行。
			const entries: StageFeedItem[] = action.snapshot.transcript.map((entry) => ({ type: "entry", entry }));
			const entryKeys = new Set(entries.map((f) => (f.type === "entry" ? stageEntryText(f.entry) : "")));
			const local = state.feed.filter((f) => (f.type === "system" ? true : !entryKeys.has(stageEntryText(f.entry))));
			return { ...state, snapshot: action.snapshot, feed: [...entries, ...local] };
		}
		case "entry":
			// 回合结束信号之一(演出条目)
			return { ...state, feed: [...state.feed, { type: "entry", entry: action.entry }], turnPending: false };
		case "system":
			// 回合结束信号之二(沉默/警告/异常/状态行);err 渲染为错误样式
			return { ...state, feed: [...state.feed, { type: "system", text: action.text, err: action.err }], turnPending: false };
		case "done":
			// 长命令完成:清 busy。结果/错误不重复进舞台流——服务端同步命令与
			// runLong 失败都经 stage_system 广播(再展示会与 SSE 行重复);
			// 导演回复经 stage_director_event 到达 MessageList,不在此处理
			return { ...state, busy: null };
		case "busy":
			return { ...state, busy: action.cmd };
		case "wake":
			return { ...state, turnPending: true };
		case "reset":
			// 切书/切章:整体重置(含 busy/turnPending——旧书回合信号不应影响新书)
			return initialStageState();
		default:
			return state;
	}
}

/** 舞台条目文本(content 数组拼接)。 */
export function stageEntryText(entry: StageEntryDto): string {
	return entry.content.map((c) => c.text).join("");
}

/** 计数 → 中文展示串(轮次/条数/字数)。 */
export function formatCounts(counts: StageCountsDto): string {
	return `轮次 ${counts.turn} · 对话 ${counts.lines} 条 · ${counts.cnChars} 字`;
}

/** 修订表单(未填充字段不出现在补丁中;beats/forbidden 按行拆分)。 */
export interface ReviseFormState {
	setting: string;
	goal: string;
	tone: string;
	beats: string;
	forbidden: string;
	minLines: string;
	maxLines: string;
	wrapUpWindow: string;
	/** 选中的演员 id;空 = 不改 perActor。 */
	actorId: string;
	objective: string;
	boundary: string;
	voice: string;
}

export function emptyReviseForm(): ReviseFormState {
	return {
		setting: "",
		goal: "",
		tone: "",
		beats: "",
		forbidden: "",
		minLines: "",
		maxLines: "",
		wrapUpWindow: "",
		actorId: "",
		objective: "",
		boundary: "",
		voice: "",
	};
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** 数字字段解析:空串/非有限数(非法输入)返回 undefined 不参与补丁(否则 0/NaN 混入)。 */
function intOrUndefined(s: string): number | undefined {
	const t = s.trim();
	if (t.length === 0) return undefined;
	const n = Number(t);
	return Number.isFinite(n) ? n : undefined;
}

/** 修订表单 → ScriptPatch(仅含非空字段;数组字段按行拆分整体替换——与后端 /revise 语义一致)。 */
export function buildRevisePatch(form: ReviseFormState): ScriptPatchDto {
	const patch: ScriptPatchDto = {};
	const shared: Partial<SharedTextDto> = {};
	if (form.setting.trim()) shared.setting = form.setting.trim();
	if (form.goal.trim()) shared.goal = form.goal.trim();
	if (form.tone.trim()) shared.tone = form.tone.trim();
	const beats = lines(form.beats);
	if (beats.length > 0) shared.beats = beats;
	const forbidden = lines(form.forbidden);
	if (forbidden.length > 0) shared.forbidden = forbidden;
	if (Object.keys(shared).length > 0) patch.text = { shared };
	const rules: ScriptPatchDto["rules"] = {};
	const minLines = intOrUndefined(form.minLines);
	if (minLines !== undefined) rules.minLines = minLines;
	const maxLines = intOrUndefined(form.maxLines);
	if (maxLines !== undefined) rules.maxLines = maxLines;
	const wrapUpWindow = intOrUndefined(form.wrapUpWindow);
	if (wrapUpWindow !== undefined) rules.wrapUpWindow = wrapUpWindow;
	if (Object.keys(rules).length > 0) patch.rules = rules;
	if (form.actorId && (form.objective.trim() || form.boundary.trim() || form.voice.trim())) {
		const perActor: Record<string, Partial<ActorTextDto>> = {
			[form.actorId]: {
				...(form.objective.trim() ? { objective: form.objective.trim() } : {}),
				...(form.boundary.trim() ? { boundary: form.boundary.trim() } : {}),
				...(form.voice.trim() ? { voice: form.voice.trim() } : {}),
			},
		};
		patch.text = { ...patch.text, perActor };
	}
	return patch;
}
