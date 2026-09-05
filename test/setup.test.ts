/**
 * 首次启动配置向导测试:
 * - src/setup.ts 纯函数(parseSetupState 白名单/容错)与读写往返(临时 PI_WRITER_DIR);
 * - /api/setup 三个路由(真实 http + 最小 fake sessionHost):初始未完成、
 *   完成标记落盘、未知步骤 400、reset 复位、损坏文件回退未完成。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WriterServer, type WriterServerOptions } from "../src/web/server.ts";
import {
	defaultSetupState,
	getSetupPath,
	isSetupCompleted,
	isSetupStepId,
	parseSetupState,
	readSetupState,
	writeSetupState,
	type SetupState,
} from "../src/setup.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-setup-"));
process.env.PI_WRITER_DIR = tmp;

/** 完成态样本(供 parse 断言与写盘往返)。 */
function completedState(): SetupState {
	return {
		version: 1,
		completedAt: "2026-09-05T12:00:00.000Z",
		steps: { intro: true, provider: true, model: false, book: false, prefs: false },
	};
}

describe("parseSetupState(容错与白名单)", () => {
	it("非对象(null/数组/原始值)→ 初始态", () => {
		expect(parseSetupState(null)).toEqual(defaultSetupState());
		expect(parseSetupState([1, 2])).toEqual(defaultSetupState());
		expect(parseSetupState("done")).toEqual(defaultSetupState());
		expect(parseSetupState(42)).toEqual(defaultSetupState());
	});

	it("version 缺失/不符/非数字 → 初始态(过新版本重新走向导)", () => {
		expect(parseSetupState({ completedAt: "x", steps: {} })).toEqual(defaultSetupState());
		expect(parseSetupState({ version: 2, completedAt: "x", steps: {} })).toEqual(defaultSetupState());
		expect(parseSetupState({ version: "1", completedAt: "x", steps: {} })).toEqual(defaultSetupState());
	});

	it("steps 白名单:未知键丢弃,非 true 值视为 false", () => {
		const s = parseSetupState({
			version: 1,
			completedAt: null,
			steps: { intro: true, hacked: true, provider: "yes", model: 1 },
		});
		expect(s.steps).toEqual({ intro: true, provider: false, model: false, book: false, prefs: false });
		expect(s.completedAt).toBeNull();
	});

	it("completedAt:非空字符串保留,空串/非字符串回退 null", () => {
		expect(parseSetupState({ version: 1, completedAt: "2026-09-05T00:00:00Z" }).completedAt).toBe("2026-09-05T00:00:00Z");
		expect(parseSetupState({ version: 1, completedAt: "" }).completedAt).toBeNull();
		expect(parseSetupState({ version: 1, completedAt: 123 }).completedAt).toBeNull();
	});

	it("合法完成态原样解析", () => {
		expect(parseSetupState(completedState())).toEqual(completedState());
	});
});

describe("isSetupStepId / isSetupCompleted", () => {
	it("五个白名单步骤为 true,其余为 false", () => {
		for (const id of ["intro", "provider", "model", "book", "prefs"]) expect(isSetupStepId(id)).toBe(true);
		expect(isSetupStepId("hacked")).toBe(false);
		expect(isSetupStepId(1)).toBe(false);
		expect(isSetupStepId(null)).toBe(false);
	});

	it("completedAt 非空即已完成;跳过向导同样置 completedAt", () => {
		expect(isSetupCompleted(defaultSetupState())).toBe(false);
		expect(isSetupCompleted(completedState())).toBe(true);
		expect(isSetupCompleted({ ...defaultSetupState(), completedAt: "x" })).toBe(true);
	});
});

describe("readSetupState / writeSetupState(临时目录往返)", () => {
	it("文件不存在 → 初始态(不抛错)", async () => {
		expect(await readSetupState()).toEqual(defaultSetupState());
	});

	it("写 → 读往返;文件带换行的人类可读 JSON", async () => {
		await writeSetupState(completedState());
		const text = readFileSync(getSetupPath(), "utf8");
		expect(text.trim().length).toBeGreaterThan(0);
		expect(text.endsWith("\n")).toBe(true);
		expect(await readSetupState()).toEqual(completedState());
	});

	it("损坏 JSON → 初始态(不抛错)", async () => {
		writeFileSync(getSetupPath(), "{not json");
		expect(await readSetupState()).toEqual(defaultSetupState());
	});
});

describe("/api/setup 路由(真实 http + 最小 sessionHost)", () => {
	let base: string;
	let server: WriterServer;

	beforeAll(async () => {
		// 最小 fake:仅 start/subscribe/getState(本组用例只触 setup 路由)
		const fake = {
			start: async () => {},
			subscribe: () => () => {},
			getState: () => ({ sessionFile: null, bookSlug: null, chapterFile: null, isStreaming: false, messages: [], diagnostics: [] }),
		};
		server = new WriterServer({
			host: "127.0.0.1",
			port: 0,
			sessionHost: fake as unknown as WriterServerOptions["sessionHost"],
			webDistDir: join(tmp, "no-such-dist"),
		});
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await server.stop();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("GET 初始未完成:completed=false + 全 false steps", async () => {
		const res = await fetch(`${base}/api/setup`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { completed: boolean; setup: SetupState };
		expect(body.completed).toBe(false);
		expect(body.setup).toEqual(defaultSetupState());
	});

	it("POST 完成:标记落盘(含 completedAt),GET 随后可见", async () => {
		const res = await fetch(`${base}/api/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ steps: { intro: true, provider: true, model: true } }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { completed: boolean; setup: SetupState };
		expect(body.completed).toBe(true);
		expect(body.setup.completedAt).toBeTruthy();
		expect(body.setup.steps).toEqual({ intro: true, provider: true, model: true, book: false, prefs: false });
		// 磁盘与后续 GET 一致(跨窗口语义)
		expect(await readSetupState()).toEqual(body.setup);
		const res2 = await fetch(`${base}/api/setup`);
		expect(((await res2.json()) as { completed: boolean }).completed).toBe(true);
	});

	it("POST 空 steps = 跳过向导:同样置 completedAt,不再弹", async () => {
		const res = await fetch(`${base}/api/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { completed: boolean; setup: SetupState };
		expect(body.completed).toBe(true);
		expect(body.setup.steps).toEqual(defaultSetupState().steps);
	});

	it("POST 未知步骤 → 400 错误体", async () => {
		const res = await fetch(`${base}/api/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ steps: { hacked: true } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("bad_request");
	});

	it("POST /reset:重置为未完成(设置页「重新运行配置向导」)", async () => {
		const res = await fetch(`${base}/api/setup/reset`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { completed: boolean; setup: SetupState };
		expect(body.completed).toBe(false);
		expect(body.setup).toEqual(defaultSetupState());
		expect(await readSetupState()).toEqual(defaultSetupState());
	});
});
