import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageCommandError, StageHost } from "../src/web/stage-host.ts";
import { saveCast } from "../src/stage/cast.ts";
import { appendStageEntry, makeStageEntry } from "../src/stage/stage-store.ts";
import { saveScript } from "../src/stage/script-store.ts";
import type { SceneScript, ScriptPatch } from "../src/stage/types.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stagehost-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

/** 书的目录（PI_WRITER_DIR/books/<slug>，与 getBookDir 一致）。 */
const bookDirOf = (slug: string): string => join(tmp, "books", slug);

/** 记录调用的假编排器（经 createOrchestrator 注入，避免起真实会话）。 */
class FakeOrchestrator {
	calls: string[] = [];
	disposed = false;
	sceneId: string | null = "s1";
	phase: "running" = "running";
	status: "normal" = "normal";
	script: SceneScript | null = null;
	last = "导演最后回复";

	async start(): Promise<void> {
		this.calls.push("start");
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
	async directorSay(text: string): Promise<void> {
		this.calls.push(`director:${text}`);
	}
	async userNext(): Promise<string> {
		this.calls.push("next");
		return "下一轮";
	}
	async userAuto(): Promise<string> {
		this.calls.push("auto");
		return "已切换自动连续演";
	}
	async userForce(target: string): Promise<string> {
		this.calls.push(`force:${target}`);
		return `已强制 ${target}`;
	}
	async userRetry(note?: string): Promise<string> {
		this.calls.push(`retry:${note ?? ""}`);
		return "已重试";
	}
	async userRevise(patch: ScriptPatch): Promise<string> {
		this.calls.push("revise");
		return "剧本 v2 已生效";
	}
	async userWrap(n?: number): Promise<string> {
		this.calls.push(`wrap:${n}`);
		return "收尾提示已注入";
	}
	async userThoughts(level: number): Promise<string> {
		this.calls.push(`thoughts:${level}`);
		return "编剧思考链可见性已更新";
	}
	async userFix(index: number, feedback: string): Promise<string> {
		this.calls.push(`fix:${index}:${feedback}`);
		return "导演已修订剧本";
	}
	async userCut(): Promise<string> {
		this.calls.push("cut");
		return "已收幕";
	}
	getDirectorMode(): "discussion" {
		return "discussion";
	}
	getDirectorLast(): string {
		return this.last;
	}
	getDirectorLastThinking(): string | undefined {
		return "导演思考链";
	}
	/** 导演讨论历史(测试固定两轮对话)。 */
	getDirectorChat(): Array<{ role: "user" | "assistant"; text: string }> {
		return [
			{ role: "user", text: "想写一个雾港的故事" },
			{ role: "assistant", text: this.last },
		];
	}
}

function makeHost(events: { slug: string; event: unknown }[]): { host: StageHost; orchs: FakeOrchestrator[] } {
	const orchs: FakeOrchestrator[] = [];
	const host = new StageHost({
		createOrchestrator: () => {
			const o = new FakeOrchestrator();
			orchs.push(o);
			return o;
		},
	});
	host.setEventSink((slug, event) => events.push({ slug, event }));
	return { host, orchs };
}

describe("StageHost 命令分发", () => {
	it("同步命令：调用正确方法并返回文本结果", async () => {
		const { host, orchs } = makeHost([]);
		expect(await host.command("b1", "next", {})).toEqual({ text: "下一轮", async: false });
		expect(await host.command("b1", "auto", {})).toEqual({ text: "已切换自动连续演", async: false });
		expect(await host.command("b1", "force", { target: "陈叔" })).toEqual({ text: "已强制 陈叔", async: false });
		expect(await host.command("b1", "retry", { note: "换个说法" })).toEqual({ text: "已重试", async: false });
		expect(await host.command("b1", "retry", {})).toEqual({ text: "已重试", async: false });
		expect(await host.command("b1", "revise", { patch: { rules: { minLines: 4 } } })).toEqual({
			text: "剧本 v2 已生效",
			async: false,
		});
		expect(await host.command("b1", "wrap", { n: 3 })).toEqual({ text: "收尾提示已注入", async: false });
		expect(await host.command("b1", "thoughts", { level: 2 })).toEqual({ text: "编剧思考链可见性已更新", async: false });
		expect(await host.command("b1", "mode", {})).toEqual({ text: "导演当前模式：讨论", async: false });
		expect(orchs[0].calls).toEqual([
			"start",
			"next",
			"auto",
			"force:陈叔",
			"retry:换个说法",
			"retry:",
			"revise",
			"wrap:3",
			"thoughts:2",
		]);
	});

	it("长命令：立即返回 async:true，完成后广播 done 事件", async () => {
		const events: { slug: string; event: unknown }[] = [];
		const { host, orchs } = makeHost(events);
		expect(await host.command("b1", "director", { text: "开一幕" })).toEqual({ text: "", async: true });
		expect(await host.command("b1", "fix", { index: 2, feedback: "这句 OOC" })).toEqual({ text: "", async: true });
		expect(await host.command("b1", "cut", {})).toEqual({ text: "", async: true });
		await vi.waitFor(() => expect(events.filter((e) => e.event.type === "done")).toHaveLength(3));
		expect(events).toEqual([
			{ slug: "b1", event: { type: "done", slug: "b1", cmd: "director", ok: true, text: "导演最后回复", thinking: "导演思考链" } },
			{ slug: "b1", event: { type: "done", slug: "b1", cmd: "fix", ok: true, text: "导演已修订剧本" } },
			{ slug: "b1", event: { type: "done", slug: "b1", cmd: "cut", ok: true, text: "已收幕" } },
		]);
		expect(orchs[0].calls).toContain("director:开一幕");
		expect(orchs[0].calls).toContain("fix:2:这句 OOC");
		expect(orchs[0].calls).toContain("cut");
	});

	it("长命令异常：done 事件带 ok:false，不抛到调用方", async () => {
		const events: { slug: string; event: unknown }[] = [];
		const { host, orchs } = makeHost(events);
		// 先用同步命令创建编排器，再覆盖方法制造异常（长命令在 command 内部启动）
		await host.command("b1", "mode", {});
		orchs[0].directorSay = async () => {
			throw new Error("模型调用失败");
		};
		await host.command("b1", "director", { text: "hi" });
		await vi.waitFor(() => expect(events.filter((e) => e.event.type === "done")).toHaveLength(1));
		expect(events).toContainEqual({ slug: "b1", event: { type: "system", slug: "b1", text: "舞台异常：模型调用失败" } });
		expect(events).toContainEqual({ slug: "b1", event: { type: "done", slug: "b1", cmd: "director", ok: false, text: "模型调用失败" } });
	});

	it("参数校验：缺失/非法抛 StageCommandError", async () => {
		const { host } = makeHost([]);
		await expect(host.command("b1", "force", {})).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "thoughts", { level: 5 })).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "thoughts", { level: "high" })).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "fix", { index: 0, feedback: "x" })).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "fix", { index: 1 })).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "revise", {})).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "wrap", { n: 1.5 })).rejects.toThrow(StageCommandError);
		await expect(host.command("b1", "unknown-cmd", {})).rejects.toThrow(StageCommandError);
	});

	it("惰性创建：同一本书只建一次编排器；不同书各自建", async () => {
		const events: { slug: string; event: unknown }[] = [];
		let created = 0;
		const host = new StageHost({ createOrchestrator: () => (created++, new FakeOrchestrator()) });
		host.setEventSink((slug, event) => events.push({ slug, event }));
		await host.command("b1", "next", {});
		await host.command("b1", "auto", {});
		await host.command("b2", "next", {});
		expect(created).toBe(2);
	});

	it("disposeAll：释放全部编排器", async () => {
		const orchs: FakeOrchestrator[] = [];
		const host = new StageHost({ createOrchestrator: () => (orchs.push(new FakeOrchestrator()), orchs[orchs.length - 1]) });
		await host.command("b1", "next", {});
		await host.command("b2", "next", {});
		await host.disposeAll();
		expect(orchs.every((o) => o.disposed)).toBe(true);
	});
});

describe("StageHost 快照", () => {
	it("无活跃编排器：空态快照（不创建编排器）", async () => {
		const events: { slug: string; event: unknown }[] = [];
		let created = 0;
		const host = new StageHost({ createOrchestrator: () => (created++, new FakeOrchestrator()) });
		host.setEventSink((slug, event) => events.push({ slug, event }));
		mkdirSync(bookDirOf("b1"), { recursive: true });
		const snap = await host.snapshot("b1");
		expect(created).toBe(0);
		expect(snap).toMatchObject({ slug: "b1", sceneId: null, phase: "idle", mode: "discussion", script: null });
		expect(snap.transcript).toEqual([]);
		expect(snap.counts).toEqual({ lines: 0, perActor: {}, perCharacter: {}, cnChars: 0, turn: 0 });
	});

	it("有编排器：含场景/剧本/编制/转录/计数/导演最后回复", async () => {
		const events: { slug: string; event: unknown }[] = [];
		const { host, orchs } = makeHost(events);
		// snapshot 是纯读不创建编排器——先发一条命令触发惰性创建
		await host.command("b1", "mode", {});
		const orch = orchs[0]!;
		// fixture:cast + 剧本 + 两条转录(走真实 store 函数)
		const dir = bookDirOf("b1");
		mkdirSync(join(dir, "stage"), { recursive: true });
		await saveCast(dir, { version: 1, actors: [{ id: "actor-1", type: "named", character: "陈叔" }] });
		await saveScript(dir, "s1", {
			scene: "雨夜便利店",
			chapter: "第一章",
			version: 2,
			definition: { cast: { "actor-1": ["陈叔"] }, inject: {}, rules: { minLines: 2, maxLines: 8, wrapUpWindow: 2, turn: "round-robin" } },
			text: { shared: { setting: "雨夜", goal: "温暖", beats: [], tone: "安静", forbidden: [] }, perActor: {} },
		});
		await appendStageEntry(dir, makeStageEntry("s1", 1, "actor-1", "陈叔", "雨下得还不小。"));
		await appendStageEntry(dir, makeStageEntry("s1", 2, "actor-1", "陈叔", "关东煮还热。"));
		orch.script = {
			scene: "雨夜便利店",
			chapter: "第一章",
			version: 2,
			definition: { cast: { "actor-1": ["陈叔"] }, inject: {}, rules: { minLines: 2, maxLines: 8, wrapUpWindow: 2, turn: "round-robin" } },
			text: { shared: { setting: "雨夜", goal: "温暖", beats: [], tone: "安静", forbidden: [] }, perActor: {} },
		};
		const snap = await host.snapshot("b1");
		expect(snap.sceneId).toBe("s1");
		expect(snap.phase).toBe("running");
		expect(snap.mode).toBe("discussion");
		expect(snap.script?.version).toBe(2);
		expect(snap.cast.actors[0]).toMatchObject({ id: "actor-1", character: "陈叔" });
		expect(snap.transcript).toHaveLength(2);
		expect(snap.counts.lines).toBe(2);
		expect(snap.counts.cnChars).toBeGreaterThan(0);
		expect(snap.directorLast).toBe("导演最后回复");
		expect(snap.directorChat).toHaveLength(2);
		expect(snap.directorChat[0]).toEqual({ role: "user", text: "想写一个雾港的故事" });
		expect(snap.directorChat[1]).toEqual({ role: "assistant", text: "导演最后回复" });
	});
});
