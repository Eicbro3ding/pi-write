/**
 * 舞台页纯逻辑层单测(stage-web.ts):reducer(快照/SSE/本地命令)+ 展示与补丁 helper。
 * 只测纯逻辑,不碰真实 provider(与 store.test.ts 同模式)。
 */
import { describe, expect, it } from "vitest";
import {
	buildRevisePatch,
	castNameMap,
	emptyReviseForm,
	formatCounts,
	initialStageState,
	reduceStage,
	stageEntryText,
} from "../web/src/stage-web.ts";
import type { StageEntryDto, StageSnapshotDto } from "../web/src/types.ts";

function entry(over: Partial<StageEntryDto> = {}): StageEntryDto {
	return {
		id: "e1",
		scene: "第一章·酒馆初遇",
		turn: 1,
		actor: "actor-1",
		character: "李四",
		content: [{ type: "text", text: "三年了,你还活着。" }],
		ts: 1000,
		...over,
	};
}

function snapshot(over: Partial<StageSnapshotDto> = {}): StageSnapshotDto {
	return {
		slug: "fog-harbor",
		sceneId: "scene-1",
		phase: "running",
		status: "normal",
		mode: "directing",
		script: null,
		cast: { version: 3, actors: [{ id: "actor-1", type: "named", character: "李四" }] },
		transcript: [],
		counts: { lines: 0, perActor: {}, perCharacter: {}, cnChars: 0, turn: 0 },
		directorLast: undefined,
		directorChat: [],
		avatars: {},
		...over,
	};
}

describe("stageEntryText", () => {
	it("拼接 content 数组为文本", () => {
		const e = entry({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
		expect(stageEntryText(e)).toBe("AB");
	});
});

describe("formatCounts", () => {
	it("渲染轮次/条数/字数", () => {
		expect(formatCounts({ lines: 12, perActor: {}, perCharacter: {}, cnChars: 486, turn: 5 })).toBe("轮次 5 · 对话 12 条 · 486 字");
	});
});

describe("castNameMap", () => {
	it("演员 id → 角色名(取 cast 首名;空数组回退 id)", () => {
		expect(castNameMap({ "actor-1": ["沈昭"], "actor-2": [] })).toEqual({ "actor-1": "沈昭", "actor-2": "actor-2" });
	});
});

describe("buildRevisePatch", () => {
	it("空表单 → 空补丁", () => {
		expect(buildRevisePatch(emptyReviseForm())).toEqual({});
	});
	it("shared 字段非空才发出,数组按行拆分", () => {
		const patch = buildRevisePatch({
			...emptyReviseForm(),
			tone: " 克制,压抑 ",
			beats: "寒暄试探\n\n账本推过来\n 半句真话 ",
		});
		expect(patch.text?.shared?.tone).toBe("克制,压抑");
		expect(patch.text?.shared?.beats).toEqual(["寒暄试探", "账本推过来", "半句真话"]);
		expect(patch.text?.shared?.setting).toBeUndefined();
	});
	it("rules 数字解析(非法输入不参与)", () => {
		const patch = buildRevisePatch({ ...emptyReviseForm(), minLines: "8", maxLines: "abc" });
		expect(patch.rules).toEqual({ minLines: 8 });
	});
	it("perActor 仅当选中演员且有字段", () => {
		const patch = buildRevisePatch({ ...emptyReviseForm(), actorId: "actor-2", objective: " 确认她过得好 " });
		expect(patch.text?.perActor).toEqual({ "actor-2": { objective: "确认她过得好" } });
	});
	it("未选演员时 perActor 不出现", () => {
		const patch = buildRevisePatch({ ...emptyReviseForm(), objective: "不该出现" });
		expect(patch.text?.perActor).toBeUndefined();
	});
});

describe("reduceStage", () => {
	it("初始状态", () => {
		const s = initialStageState();
		expect(s).toEqual({ snapshot: null, feed: [], busy: null, turnPending: false });
	});
	it("snapshot:转录整体替换条目;导演对话(directorChat)不进 feed(2026-08-11 统一重构,StagePage 水合进 directorSession)", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry()] }) });
		expect(s.feed).toHaveLength(1);
		expect(s.feed[0]).toMatchObject({ type: "entry" });
		expect(s.snapshot?.sceneId).toBe("scene-1");
	});
	it("snapshot:旧条目被替换(磁盘为权威),不重复", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry({ id: "e1" })] }) });
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry({ id: "e2" })] }) });
		expect(s.feed.filter((f) => f.type === "entry")).toHaveLength(1);
	});
	it("snapshot:无 directorChat(旧服务端)不崩", () => {
		const s = reduceStage(initialStageState(), { type: "snapshot", snapshot: { ...snapshot(), directorChat: undefined } as unknown as StageSnapshotDto });
		expect(s.feed).toHaveLength(0);
	});
	it("snapshot:重复派发(StrictMode 双跑/SSE 重连)幂等,条目不重复追加", () => {
		let s = initialStageState();
		const snap = snapshot({ transcript: [entry()] });
		s = reduceStage(s, { type: "snapshot", snapshot: snap });
		s = reduceStage(s, { type: "snapshot", snapshot: snap });
		expect(s.feed).toHaveLength(1);
		expect(s.feed[0]).toMatchObject({ type: "entry" });
	});
	it("entry 追加并清 turnPending", () => {
		let s = reduceStage(initialStageState(), { type: "wake" });
		expect(s.turnPending).toBe(true);
		s = reduceStage(s, { type: "entry", entry: entry() });
		expect(s.turnPending).toBe(false);
		expect(s.feed[0]).toMatchObject({ type: "entry" });
	});
	it("system 追加并清 turnPending(沉默/警告回合结束信号)", () => {
		let s = reduceStage(initialStageState(), { type: "wake" });
		s = reduceStage(s, { type: "system", text: "(王五 选择了沉默,跳过)" });
		expect(s.turnPending).toBe(false);
		expect(s.feed[0]).toMatchObject({ type: "system", text: "(王五 选择了沉默,跳过)", err: undefined });
	});
	it("done:清 busy(导演回复经 stage_director_event 到 MessageList,不进 feed)", () => {
		let s = reduceStage(initialStageState(), { type: "busy", cmd: "director" });
		expect(s.busy).toBe("director");
		s = reduceStage(s, { type: "done", cmd: "director", ok: true });
		expect(s.busy).toBeNull();
		expect(s.feed).toHaveLength(0);
	});
	it("done:非导演命令结果不进舞台流(SSE 系统行已覆盖,防重复)", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "done", cmd: "fix", ok: true });
		expect(s.feed).toHaveLength(0);
		expect(s.busy).toBeNull();
	});
	it("done:失败只清 busy(错误行由 stage-host 的 stage_system 广播)", () => {
		let s = reduceStage(initialStageState(), { type: "busy", cmd: "cut" });
		s = reduceStage(s, { type: "done", cmd: "cut", ok: false });
		expect(s.busy).toBeNull();
		expect(s.feed).toHaveLength(0);
	});
	it("reset:切书/切章整体重置舞台流(旧对话残留 = 串对话根因)", () => {
		let s = reduceStage(initialStageState(), { type: "system", text: "旧舞台行" });
		s = reduceStage(s, { type: "busy", cmd: "director" });
		s = reduceStage(s, { type: "reset" });
		expect(s).toEqual(initialStageState());
		expect(s.feed).toHaveLength(0);
		expect(s.busy).toBeNull();
	});
	it("未知动作返回原状态", () => {
		const s = initialStageState();
		// @ts-expect-error 非法动作类型(编译期不应出现)
		expect(reduceStage(s, { type: "nope" })).toBe(s);
	});
});
