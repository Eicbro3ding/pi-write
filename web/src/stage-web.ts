/**
 * 舞台页纯逻辑层(不 import React/vendor,供 vitest 单测):
 * - reduceStage:舞台 UI 状态 reducer(快照 / SSE 事件 / 本地命令事件);
 * - stageEntryText / formatCounts / buildRevisePatch:展示与命令参数构造 helper。
 *
 * 舞台流(feed)混合三类行:舞台条目(快照/SSE)、系统行(stage_system 与命令结果)、
 * 导演对话(用户/导演,本地态——快照不含导演对话历史,重拉后保留本地行)。
 *
 * turnPending(「下一步」置灰)语义:回合进行中再发 /next 是服务端 no-op(§15.2),
 * 前端在发出后等待回合结束信号再放开按钮。每个回合(含 pass/超时/异常)结束时
 * 编排器必然 emit stage_entry(演出条目)或 stage_system(沉默/警告/异常行),
 * 因此两者任一到达即清除 turnPending——无超时兜底需求。
 */
import type { ActorTextDto, ScriptPatchDto, SharedTextDto, StageCountsDto, StageEntryDto, StageSnapshotDto } from "./types.ts";

export type StageFeedItem =
	| { type: "entry"; entry: StageEntryDto }
	| { type: "system"; text: string; err?: boolean }
	| { type: "user"; text: string }
	| { type: "director"; text: string; thinking?: string; streaming?: boolean };

export interface StageUiState {
	/** 服务端快照(null = 尚未拉取成功)。 */
	snapshot: StageSnapshotDto | null;
	/** 舞台流(条目 + 系统行 + 导演对话)。 */
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
	| { type: "user"; text: string }
	| { type: "director"; text: string }
	/** 导演回复流式(完整文本):替换最后一条流式导演气泡;无则新建。 */
	| { type: "director_text"; text: string }
	| { type: "done"; cmd: string; ok: boolean; text?: string; thinking?: string }
	| { type: "busy"; cmd: string }
	| { type: "wake" }
	/** 切书:整体重置舞台流(旧书对话残留 = 「串对话」根因,见 StagePage)。 */
	| { type: "reset" };

export function initialStageState(): StageUiState {
	return { snapshot: null, feed: [], busy: null, turnPending: false };
}

/** 定稿最后一条流式导演气泡(回合结束信号到达时调用):清 streaming 标记。
 *  从尾部扫描——entry/system 行追加在气泡之后,不能只看最后一条 feed。 */
function finalizeDirector(feed: StageFeedItem[]): StageFeedItem[] {
	for (let i = feed.length - 1; i >= 0; i--) {
		const f = feed[i];
		if (f.type === "director" && f.streaming) {
			const next = [...feed];
			next[i] = { ...f, streaming: false };
			return next;
		}
	}
	return feed;
}

export function reduceStage(state: StageUiState, action: StageAction): StageUiState {
	switch (action.type) {
		case "snapshot": {
			// 快照(拉取/重连对齐):舞台条目以快照转录为准整体替换(磁盘是权威);
			// 导演对话历史(directorChat)转气泡排在转录之后——刷新页面后导演气泡不丢
			// (服务端内存态,重启才丢)。幂等:挂载 effect(StrictMode 双跑)+ active effect
			// + SSE onopen 可能重复派发同一快照,按文本匹配剔除 feed 里已恢复的 chat 行,
			// 只保留真正本地新增的对话行(文本不在历史中)在末尾
			const entries: StageFeedItem[] = action.snapshot.transcript.map((entry) => ({ type: "entry", entry }));
			const chat: Array<{ type: "user" | "director"; text: string; thinking?: string }> = (action.snapshot.directorChat ?? []).map((m) =>
				m.role === "user" ? { type: "user", text: m.text } : { type: "director", text: m.text, thinking: m.thinking },
			);
			const chatKeys = new Set(chat.map((c) => `${c.type}:${c.text}`));
			const local = state.feed.filter((f) => {
				if (f.type === "entry") return false;
				if (f.type === "user" || f.type === "director") return !chatKeys.has(`${f.type}:${f.text}`);
				return true;
			});
			return { ...state, snapshot: action.snapshot, feed: [...entries, ...chat, ...local] };
		}
		case "entry":
			// 回合结束信号之一(演出条目);导演流式气泡随之定稿
			return { ...state, feed: finalizeDirector([...state.feed, { type: "entry", entry: action.entry }]), turnPending: false };
		case "system":
			// 回合结束信号之二(沉默/警告/异常/状态行);err 渲染为错误样式
			return { ...state, feed: finalizeDirector([...state.feed, { type: "system", text: action.text, err: action.err }]), turnPending: false };
		case "user":
			return { ...state, feed: [...state.feed, { type: "user", text: action.text }] };
		case "director":
			return { ...state, feed: finalizeDirector([...state.feed, { type: "director", text: action.text }]) };
		case "director_text": {
			// 流式增量:最后一条是流式导演气泡 → 以完整文本替换(增量拼接易丢帧);
			// 否则(流式事件先于其他行)新建气泡并标记流式中
			const feed = [...state.feed];
			const last = feed[feed.length - 1];
			if (last && last.type === "director" && last.streaming) {
				feed[feed.length - 1] = { ...last, text: action.text };
			} else {
				feed.push({ type: "director", text: action.text, streaming: true });
			}
			return { ...state, feed };
		}
		case "done": {
			// 长命令完成:清 busy。结果/错误不重复进舞台流——服务端同步命令与
			// runLong 失败都经 stage_system 广播(再展示会与 SSE 行重复);
			// 唯一例外:导演发言(directorSay 的回复文本只在 done 里携带,思考链同带)
			const feed = [...state.feed];
			if (action.cmd === "director" && action.ok && action.text) {
				// 流式气泡已存在(director_text 到达):以 done 的完整文本定稿(补思考链);
				// 未到达(断流/慢):整段兜底 push
				let idx = -1;
				for (let i = feed.length - 1; i >= 0; i--) {
					const f = feed[i];
					if (f && f.type === "director" && f.streaming) {
						idx = i;
						break;
					}
				}
				if (idx >= 0) {
					const prev = feed[idx] as Extract<StageFeedItem, { type: "director" }>;
					feed[idx] = {
						...prev,
						text: action.text,
						thinking: action.thinking ?? prev.thinking,
						streaming: false,
					};
				} else {
					feed.push({ type: "director", text: action.text, thinking: action.thinking });
				}
			} else if (action.cmd === "director") {
				// 导演回合失败:流式气泡定稿(文本保留已流出的部分)
				return { ...state, busy: null, feed: finalizeDirector(feed) };
			}
			return { ...state, busy: null, feed };
		}
		case "busy":
			return { ...state, busy: action.cmd };
		case "wake":
			return { ...state, turnPending: true };
		case "reset":
			// 切书:整体重置(含 busy/turnPending——旧书回合信号不应影响新书)
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
