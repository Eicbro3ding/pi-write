/**
 * 对话相关的 REST 端点测试(真实 http + 临时 PI_WRITER_DIR + 假宿主,不联网):
 *
 * - `GET/POST/DELETE /api/conversations`(对话清单/新建/删除);
 * - `PUT /api/settings { conversationScope }`(校验、落盘、释放会话、SSE 广播);
 * - writer 现有端点的可选 `conversation` 参数,以及 **chapter 模式的回归护栏**
 *   (响应形状与会话文件路径与改动前一致)。
 *
 * 手法与 test/server.test.ts 一致:WriterServer + 真 SessionHost 的替身;
 * 常驻编剧用真 WriterHost(对话清单要读写真实会话文件),只有它内部起的 agent 宿主
 * 被替换(注入 createHost / 打桩 SessionHost.prototype.start)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBook, getBookSessionsDir } from "../src/book-manager.ts";
import { getWriterSettingsPath } from "../src/writer-settings.ts";
import { WriterServer } from "../src/web/server.ts";
import { SessionHost } from "../src/web/session-host.ts";
import { WriterHost } from "../src/web/writer-host.ts";

const json = { "content-type": "application/json" } as const;

/** 主会话宿主的替身(WriterServer 只用到 subscribe/getState/reloadRuntime)。 */
function fakeMainHost(): never {
	const listeners = new Set<(e: unknown) => void>();
	return {
		subscribe: (l: (e: unknown) => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		getState: () => ({ bookSlug: null, chapterFile: null, isStreaming: false, messages: [] }),
		reloadRuntime: async () => {},
		dispose: async () => {},
	} as never;
}

/** 常驻编剧会话宿主的替身(经 WriterHost 的 createHost 注入)。 */
function fakeWriterSession(): { dispose: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
	return {
		subscribe: () => () => {},
		sendMessage: vi.fn(async () => {}),
		injectContext: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		getState: () => ({ isStreaming: false, messages: [] }),
		getContextUsage: () => null,
	} as never;
}

/** chat 是 202 立即返回 + 后台惰性建会话:等会话文件落盘(或超时)。 */
async function waitForFile(path: string, timeoutMs = 4000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return existsSync(path);
}

/** 读 SSE 流直到出现符合条件的 writer_event 帧(或超时)。 */async function waitForWriterFrame(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const frames = buf.split("\n\n");
		buf = frames.pop() ?? "";
		for (const frame of frames) {
			const line = frame.split("\n").find((l) => l.startsWith("data: "));
			if (!line) continue;
			try {
				const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
				if (predicate(parsed)) return parsed;
			} catch {
				/* ping / 坏帧忽略 */
			}
		}
	}
	return null;
}

// ———————————————————————————————————————————————————————————————
// 对话清单端点 + 设置(真 WriterHost,内部 agent 宿主换成替身)
// ———————————————————————————————————————————————————————————————

describe("WriterServer · /api/conversations(对话清单/新建/删除)", () => {
	let tmp: string;
	let server: WriterServer;
	let base = "";
	let slug = "";
	let dispatched: string[] = [];
	const sessions: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "piw-conv-api-"));
		process.env.PI_WRITER_DIR = tmp;
		const book = await createBook("雾港对话");
		slug = book.slug;
		const writerHost = new WriterHost({
			createHost: async (key) => {
				dispatched.push(key);
				const session = fakeWriterSession();
				sessions.push(session as never);
				return session as never;
			},
		});
		server = new WriterServer({ host: "127.0.0.1", port: 0, sessionHost: fakeMainHost(), webDistDir: join(tmp, "no-such-dist"), writerHost });
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await server.stop();
		delete process.env.PI_WRITER_DIR;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("GET:空书返回空清单;缺 slug 400;未知书 404", async () => {
		const res = await fetch(`${base}/api/conversations?slug=${encodeURIComponent(slug)}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ conversations: [] });
		const noSlug = await fetch(`${base}/api/conversations`);
		expect(noSlug.status).toBe(400);
		const unknown = await fetch(`${base}/api/conversations?slug=${encodeURIComponent("没有这本书")}`);
		expect(unknown.status).toBe(404);
	});

	it("POST 新建 → 201,返回新对话 + 最新清单,并成为当前对话", async () => {
		const res = await fetch(`${base}/api/conversations`, { method: "POST", headers: json, body: JSON.stringify({ slug }) });
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			conversation: { id: string; title: string; updatedAt: number; isCurrent: boolean };
			conversations: Array<{ id: string; isCurrent: boolean }>;
		};
		expect(body.conversation.id).toMatch(/^c-[a-z0-9]{6}$/);
		expect(body.conversation.title).toBe("新对话");
		expect(body.conversation.isCurrent).toBe(true);
		expect(typeof body.conversation.updatedAt).toBe("number");
		expect(body.conversations).toHaveLength(1);
		expect(body.conversations[0]).toMatchObject({ id: body.conversation.id, isCurrent: true });
		// 会话文件确实落盘(sessions/<slug>/writer-<id>.jsonl)
		expect(existsSync(join(getBookSessionsDir(slug), `writer-${body.conversation.id}.jsonl`))).toBe(true);
		// 再查一次:清单与新建时返回的一致
		const again = await (await fetch(`${base}/api/conversations?slug=${encodeURIComponent(slug)}`)).json();
		expect(again).toEqual({ conversations: body.conversations });
	});

	it("POST 缺 slug 400;未知书 404", async () => {
		const missing = await fetch(`${base}/api/conversations`, { method: "POST", headers: json, body: JSON.stringify({}) });
		expect(missing.status).toBe(400);
		const unknown = await fetch(`${base}/api/conversations`, { method: "POST", headers: json, body: JSON.stringify({ slug: "没有这本书" }) });
		expect(unknown.status).toBe(404);
	});

	it("DELETE 删除对话:文件消失,再删 404;穿越 id 400", async () => {
		const created = (await (
			await fetch(`${base}/api/conversations`, { method: "POST", headers: json, body: JSON.stringify({ slug }) })
		).json()) as { conversation: { id: string } };
		const file = join(getBookSessionsDir(slug), `writer-${created.conversation.id}.jsonl`);
		expect(existsSync(file)).toBe(true);
		const res = await fetch(`${base}/api/conversations/${encodeURIComponent(created.conversation.id)}?slug=${encodeURIComponent(slug)}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(existsSync(file)).toBe(false);
		const again = await fetch(`${base}/api/conversations/${encodeURIComponent(created.conversation.id)}?slug=${encodeURIComponent(slug)}`, {
			method: "DELETE",
		});
		expect(again.status).toBe(404);
		const traversal = await fetch(`${base}/api/conversations/${encodeURIComponent("../evil")}?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
		expect(traversal.status).toBe(400);
		expect(await traversal.json()).toMatchObject({ error: { code: "bad_request" } });
	});

	it("PUT /api/settings {conversationScope}:校验枚举、落盘、释放已建会话、广播 settings_changed", async () => {
		// 先经 chat 端点建出一段会话(证明切形态会释放它)
		const chat = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/chat`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ text: "你好", chapterFile: "ch01.jsonl" }),
		});
		expect(chat.status).toBe(202);
		expect(dispatched).toEqual([`${slug}:ch01.jsonl`]);
		const built = sessions.at(-1)!;

		// SSE:settings_changed 要推给其他窗口
		const es = await fetch(`${base}/api/events`);
		const reader = es.body!.getReader();

		const ok = await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ conversationScope: "book" }) });
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { settings: { conversationScope: string; classicMode: boolean } };
		expect(body.settings.conversationScope).toBe("book");
		// 落盘:跨重启一致
		const persisted = JSON.parse(readFileSync(getWriterSettingsPath(), "utf8")) as { conversationScope: string };
		expect(persisted.conversationScope).toBe("book");
		expect(await (await fetch(`${base}/api/settings`)).json()).toMatchObject({ settings: { conversationScope: "book" } });
		// 形态变了 → 已建会话必须释放(否则旧形态的会话还在跑)
		expect(built.dispose).toHaveBeenCalledOnce();

		const frame = await waitForWriterFrame(reader, (f) => f.type === "settings_changed");
		expect(frame?.settings).toMatchObject({ conversationScope: "book" });
		await reader.cancel();

		// 非法枚举 400;非字符串 400
		for (const bad of ["global", 1, null]) {
			const res = await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ conversationScope: bad }) });
			expect(res.status).toBe(400);
		}
	});
});

// ———————————————————————————————————————————————————————————————
// writer 端点的 conversation 参数 + chapter 模式回归护栏(真 createHost,start 打桩)
// ———————————————————————————————————————————————————————————————

describe("WriterServer · writer 端点的 conversation 参数", () => {
	let tmp: string;
	let server: WriterServer;
	let base = "";
	let slug = "";

	beforeAll(async () => {
		// 真 createHost 会起 agent;这里只关心会话文件与响应形状,把 start 打桩掉
		vi.spyOn(SessionHost.prototype, "start").mockResolvedValue();
		tmp = mkdtempSync(join(tmpdir(), "piw-conv-writer-"));
		process.env.PI_WRITER_DIR = tmp;
		const book = await createBook("回归之书");
		slug = book.slug;
		server = new WriterServer({
			host: "127.0.0.1",
			port: 0,
			sessionHost: fakeMainHost(),
			webDistDir: join(tmp, "no-such-dist"),
			writerHost: new WriterHost({ classicMode: false }),
		});
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await server.stop();
		vi.restoreAllMocks();
		delete process.env.PI_WRITER_DIR;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("chapter 模式回归:只传 chapterFile → 会话文件仍是 writer-<章节>.jsonl,状态形状与改动前一致", async () => {
		const chat = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/chat`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ text: "把结尾改含蓄点", chapterFile: "ch01.jsonl" }),
		});
		expect(chat.status).toBe(202);
		expect(await chat.json()).toEqual({ ok: true });
		// 会话文件路径/命名与改动前逐字节一致(不许改名/迁移)
		const abs = join(getBookSessionsDir(slug), "writer-ch01.jsonl");
		expect(await waitForFile(abs)).toBe(true);
		expect(JSON.parse(readFileSync(abs, "utf8").split("\n")[0]!)).toMatchObject({ type: "session", version: 3 });

		// 带 chapterFile 的只读状态:响应形状与改动前一致(刚对话过 → 内存里有会话,
		// exists true、messages 为空;没碰过的章节则是 exists false)
		const res = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?chapterFile=ch01.jsonl`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bookSlug: slug, chapterFile: "ch01.jsonl", exists: true, isStreaming: false, messages: [] });
		const untouched = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?chapterFile=ch99.jsonl`);
		expect(await untouched.json()).toEqual({ bookSlug: slug, chapterFile: "ch99.jsonl", exists: false, isStreaming: false, messages: [] });
		// 不带参数:沿用「最近声明的章节」回落
		expect(await (await fetch(`${base}/api/writer/${encodeURIComponent(slug)}`)).json()).toMatchObject({ chapterFile: "ch01.jsonl" });
		// chapter 模式下 conversation 与 chapterFile 同义(对话 id 就是章节文件名)
		expect(await (await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?conversation=ch01.jsonl`)).json()).toMatchObject({
			chapterFile: "ch01.jsonl",
		});
		// tree/context/stats 也接受两个参数(空会话返回空树/空占用/空统计)
		const tree = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/tree?chapterFile=ch01.jsonl&conversation=ch01.jsonl`);
		expect(tree.status).toBe(200);
		// versions = 消息版本视图(「‹ 2/2 ›」的数据源);空会话时为空对象
		expect(await tree.json()).toEqual({ currentLeafId: null, branches: [], versions: {} });
		const ctx = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/context?conversation=ch01.jsonl`);
		expect(ctx.status).toBe(200);
		expect(await ctx.json()).toEqual({ usage: null });
		const stats = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/stats?conversation=ch01.jsonl`);
		expect(stats.status).toBe(200);
		expect(await stats.json()).toEqual({ stats: null });
	});

	it("book 模式:conversation 决定会话身份(chapterFile 只是正在看的章节),事件带 conversation", async () => {
		// 切到「章节与对话分离」
		const put = await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ conversationScope: "book" }) });
		expect(put.status).toBe(200);

		const es = await fetch(`${base}/api/events`);
		const reader = es.body!.getReader();

		const chat = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/chat`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ text: "聊聊人物", chapterFile: "ch01.jsonl", conversation: "c-free1" }),
		});
		expect(chat.status).toBe(202);
		// 会话文件按对话 id 落盘(同一个命名函数);章节不再是身份
		expect(await waitForFile(join(getBookSessionsDir(slug), "writer-c-free1.jsonl"))).toBe(true);
		expect(existsSync(join(getBookSessionsDir(slug), "writer-ch01.jsonl"))).toBe(true); // 旧章节会话还在,没被当成身份

		// 状态:对话定位到 c-free1,chapterFile 回显「正在看的章节」
		const state = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?conversation=c-free1&chapterFile=ch01.jsonl`);
		expect(await state.json()).toEqual({ bookSlug: slug, chapterFile: "ch01.jsonl", exists: true, isStreaming: false, messages: [] });

		// chapterFile= (显式空值)= 没有正在看的章节 → 不再注入正文块
		const cleared = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?conversation=c-free1&chapterFile=`);
		expect(await cleared.json()).toMatchObject({ chapterFile: null });

		// 该对话的对话清单里能看到章节会话与自由对话两种 id
		const list = (await (await fetch(`${base}/api/conversations?slug=${encodeURIComponent(slug)}`)).json()) as {
			conversations: Array<{ id: string; isCurrent: boolean }>;
		};
		expect(list.conversations.map((c) => c.id).sort()).toEqual(["c-free1", "ch01.jsonl"]);
		expect(list.conversations.find((c) => c.id === "c-free1")?.isCurrent).toBe(true);

		// book 模式的会话事件带 conversation(前端据此过滤到具体对话)
		const frame = await waitForWriterFrame(reader, (f) => f.type === "writer_event" && f.conversation === "c-free1");
		expect(frame).toMatchObject({ slug, conversation: "c-free1" });
		expect((frame?.event as { type?: string } | undefined)?.type).toBe("chat_error");
		await reader.cancel();
	});

	it("非法 conversation / chapterFile 参数 400(挡住路径穿越落盘)", async () => {
		const res = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}?conversation=${encodeURIComponent("../evil")}`);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
		const nonString = await fetch(`${base}/api/writer/${encodeURIComponent(slug)}/chat`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ text: "hi", conversation: 7 }),
		});
		expect(nonString.status).toBe(400);
	});
});
