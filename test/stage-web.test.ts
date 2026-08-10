/**
 * 舞台页纯逻辑层单测(stage-web.ts):reducer(快照/SSE/本地命令)+ 展示与补丁 helper。
 * 只测纯逻辑,不碰真实 provider(与 store.test.ts 同模式)。
 */
import { describe, expect, it } from "vitest";
import {
	buildRevisePatch,
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
	it("snapshot:转录整体替换条目,本地行保留", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "user", text: "你好" });
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry()] }) });
		expect(s.feed).toHaveLength(2);
		expect(s.feed[0]).toMatchObject({ type: "entry" });
		expect(s.feed[1]).toMatchObject({ type: "user", text: "你好" });
		expect(s.snapshot?.sceneId).toBe("scene-1");
	});
	it("snapshot:旧条目被替换(磁盘为权威),不重复", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry({ id: "e1" })] }) });
		s = reduceStage(s, { type: "snapshot", snapshot: snapshot({ transcript: [entry({ id: "e2" })] }) });
		expect(s.feed.filter((f) => f.type === "entry")).toHaveLength(1);
	});
	it("snapshot:导演对话历史转气泡(刷新页面不丢),本地新行保留在后", () => {
		let s = initialStageState();
		// 本地已有一轮新对话(刷新前刚发,快照未包含)
		s = reduceStage(s, { type: "user", text: "新问题" });
		s = reduceStage(s, {
			type: "snapshot",
			snapshot: snapshot({
				directorChat: [
					{ role: "user", text: "想写雾港的故事" },
					{ role: "assistant", text: "好,先聊聊基调" },
					{ role: "user", text: "灰暗一点" },
					{ role: "assistant", text: "雾港确实适合灰暗基调" },
				],
			}),
		});
		expect(s.feed.map((f) => f.type)).toEqual(["user", "director", "user", "director", "user"]);
		expect(s.feed[0]).toMatchObject({ type: "user", text: "想写雾港的故事" });
		expect(s.feed[1]).toMatchObject({ type: "director", text: "好,先聊聊基调" });
		expect(s.feed[4]).toMatchObject({ type: "user", text: "新问题" });
	});
	it("snapshot:无 directorChat(旧服务端)不崩", () => {
		const s = reduceStage(initialStageState(), { type: "snapshot", snapshot: { ...snapshot(), directorChat: undefined } as unknown as StageSnapshotDto });
		expect(s.feed).toHaveLength(0);
	});
	it("snapshot:重复派发(StrictMode 双跑/SSE 重连)幂等,对话历史不重复追加", () => {
		let s = initialStageState();
		const snap = snapshot({
			directorChat: [
				{ role: "user", text: "你好" },
				{ role: "assistant", text: "你好！我是导演。" },
			],
		});
		s = reduceStage(s, { type: "snapshot", snapshot: snap });
		s = reduceStage(s, { type: "snapshot", snapshot: snap });
		expect(s.feed).toHaveLength(2);
		expect(s.feed.map((f) => f.type)).toEqual(["user", "director"]);
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
	it("done:导演发言上气泡并清 busy", () => {
		let s = reduceStage(initialStageState(), { type: "busy", cmd: "director" });
		expect(s.busy).toBe("director");
		s = reduceStage(s, { type: "done", cmd: "director", ok: true, text: "好,我改一下王五的 boundary。" });
		expect(s.busy).toBeNull();
		expect(s.feed[0]).toMatchObject({ type: "director", text: "好,我改一下王五的 boundary。" });
	});
	it("director_text:流式增量替换流式气泡,entry 到达定稿", () => {
		let s = reduceStage(initialStageState(), { type: "user", text: "聊聊基调" });
		s = reduceStage(s, { type: "director_text", text: "好,先" });
		expect(s.feed[1]).toMatchObject({ type: "director", text: "好,先", streaming: true });
		s = reduceStage(s, { type: "director_text", text: "好,先聊聊基调。" });
		expect(s.feed[1]).toMatchObject({ type: "director", text: "好,先聊聊基调。", streaming: true });
		// 回合结束信号(entry)定稿:清 streaming,不重复建气泡
		s = reduceStage(s, { type: "entry", entry: entry() });
		expect(s.feed[1]).toMatchObject({ type: "director", text: "好,先聊聊基调。", streaming: false });
		expect(s.feed.map((f) => f.type)).toEqual(["user", "director", "entry"]);
	});
	it("done:流式气泡已存在时定稿(done 文本为准,补思考链),不重复 push", () => {
		let s = reduceStage(initialStageState(), { type: "user", text: "写剧本" });
		s = reduceStage(s, { type: "director_text", text: "好,我来" });
		s = reduceStage(s, { type: "done", cmd: "director", ok: true, text: "好,我来写剧本。", thinking: "先想结构……" });
		expect(s.feed.map((f) => f.type)).toEqual(["user", "director"]);
		expect(s.feed[1]).toMatchObject({ type: "director", text: "好,我来写剧本。", thinking: "先想结构……", streaming: false });
		expect(s.busy).toBeNull();
	});
	it("done:导演回合失败时流式气泡定稿(保留已流出文本)", () => {
		let s = reduceStage(initialStageState(), { type: "user", text: "继续" });
		s = reduceStage(s, { type: "director_text", text: "嗯," });
		s = reduceStage(s, { type: "done", cmd: "director", ok: false, text: "导演回合超时" });
		expect(s.feed.map((f) => f.type)).toEqual(["user", "director"]);
		expect(s.feed[1]).toMatchObject({ type: "director", text: "嗯,", streaming: false });
	});
	it("done:非导演命令结果不进舞台流(SSE 系统行已覆盖,防重复)", () => {
		let s = initialStageState();
		s = reduceStage(s, { type: "done", cmd: "fix", ok: true, text: "导演已修订剧本(v2)" });
		expect(s.feed).toHaveLength(0);
		expect(s.busy).toBeNull();
	});
	it("done:失败只清 busy(错误行由 stage-host 的 stage_system 广播)", () => {
		let s = reduceStage(initialStageState(), { type: "busy", cmd: "cut" });
		s = reduceStage(s, { type: "done", cmd: "cut", ok: false, text: "舞台异常" });
		expect(s.busy).toBeNull();
		expect(s.feed).toHaveLength(0);
	});
	it("reset:切书时整体重置舞台流(旧书对话残留 = 串对话根因)", () => {
		let s = reduceStage(initialStageState(), { type: "user", text: "旧书对话" });
		s = reduceStage(s, { type: "director", text: "旧书导演回复" });
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
