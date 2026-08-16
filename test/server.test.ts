/**
 * WriterServer HTTP 路由测试:真实 http 监听 + fake SessionHost + 临时 PI_WRITER_DIR。
 * brief 的 5 个用例逐字保留;其后为路由表补充用例(章节/会话/模型/世界/草稿/错误体/SSE 广播),
 * 以及 Fix round 1 的静态服务用例(webDistDir 可注入;未配置时非 /api 保持 404)。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { resolveBuiltinThemesDir, WriterServer } from "../src/web/server.ts";
import { getBookDir, getWriterDir } from "../src/config.ts";
import { getBookSessionsDir, getChapterSessionsPath, loadBook } from "../src/book-manager.ts";
import { readImportZip } from "../src/web/book-zip.ts";
import { ProviderAuthError } from "../src/web/provider-auth.ts";
import { imageUrl } from "../web/src/api/client.ts";
import type { WorldData } from "../src/world-data.ts";

const tmp = mkdtempSync(join(tmpdir(), "piw-server-"));
process.env.PI_WRITER_DIR = tmp;

/**
 * fake SessionHost:字段集合是 brief 形状的超集,另暴露测试钩子
 * (listeners 事件集、switchCalls 切换记录、可变的 state/session)。
 */
function fakeHost() {
	const listeners = new Set<(e: unknown) => void>();
	const switchCalls: string[] = [];
	/** 测试门控:非 null 时 switchSession 等待该 promise(用于并发串行化测试)。 */
	const switchGate: { current: Promise<void> | null } = { current: null };
	const state = {
		sessionFile: null as string | null,
		bookSlug: null as string | null,
		chapterFile: null as string | null,
		isStreaming: false,
		messages: [] as Array<{ role: string; text: string }>,
		diagnostics: [] as Array<{ type: string; message: string }>,
	};
	const session = {
		modelRuntime: { getAvailable: async () => [{ id: "sonnet", provider: "anthropic" }] },
		state: { model: { id: "sonnet", provider: "anthropic" }, thinkingLevel: "off" },
	};
	let providers = [
		{ id: "openai", name: "OpenAI", configured: false, authKind: "api_key" as const },
		{ id: "anthropic", name: "Anthropic", configured: true, authKind: "both" as const, source: "stored" },
		{ id: "amazon-bedrock", name: "Amazon Bedrock", configured: false, authKind: "ambient" as const },
		{ id: "fail-provider", name: "Fail Provider", configured: false, authKind: "api_key" as const },
	];
	const providerCalls: string[] = [];
	const injectCalls: string[] = [];
	const retractCalls: string[] = [];
	const branchCalls: string[] = [];
	const navigateCalls: string[] = [];
	const host = {
		start: async () => {},
		subscribe: (l: (e: unknown) => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		sendMessage: async () => {},
		retractMessage: async (entryId: string) => {
			if (entryId === "streaming-entry") throw new Error("AI 正在回复中,请先中止");
			retractCalls.push(entryId);
		},
		branchMessage: async (entryId: string) => {
			if (entryId === "no-such") throw new Error("消息不存在或不在当前对话: no-such");
			branchCalls.push(entryId);
		},
		navigateTo: async (entryId: string) => {
			if (entryId === "no-such") throw new Error(`消息不存在: ${entryId}`);
			navigateCalls.push(entryId);
		},
		getSessionTree: async () => ({
			currentLeafId: "leaf-current",
			branches: [
				{ leafId: "leaf-current", isCurrent: true, count: 4, summary: "第一条消息", tail: "回复二" },
				{ leafId: "leaf-other", isCurrent: false, count: 3, summary: "第一条消息", tail: "第二条" },
			],
		}),
		abort: async () => {},
		switchSession: async (absPath: string) => {
			switchCalls.push(absPath);
			if (switchGate.current) await switchGate.current;
		},
		injectContext: async (text: string) => {
			injectCalls.push(text);
		},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		listProviders: async () => providers,		setProviderApiKey: async (id: string, key: string) => {
			if (id === "fail-provider") {
				throw new ProviderAuthError(
					"该 provider 需要额外配置(如 account ID),请用 TUI /login 或手动编辑 ~/.pi/writer/agent/auth.json",
				);
			}
			providerCalls.push(`set:${id}:${key}`);
		},
		removeProvider: async (id: string) => {
			providerCalls.push(`del:${id}`);
		},
		getState: () => state,
		getRuntime: () => ({ session }),
		dispose: async () => {},
	} as never;
	return { host, listeners, switchCalls, switchGate, state, session, providers, providerCalls, injectCalls, retractCalls, branchCalls, navigateCalls };
}
const json = { "content-type": "application/json" } as const;

/**
 * 用 node:http 发 GET(fetch/undici 禁止自定义 Host 头,回环守卫测试需要
 * 伪造 Host/Origin/Sec-Fetch-Site 来验证拒绝路径)。返回状态与响应体。
 */
function rawGet(port: number, headers: Record<string, string>, path = "/api/books"): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
			let body = "";
			res.on("data", (c: Buffer) => (body += c.toString("utf-8")));
			res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

/**
 * 读取 SSE 流直到某帧 JSON 满足 predicate(或超时);返回该帧。
 * 用于「动作发生后断言广播帧」:先开连接再发请求,帧在流中异步到达。
 */
async function waitForSseFrame(
	res: Response,
	predicate: (frame: Record<string, unknown>) => boolean,
	timeoutMs = 3000,
): Promise<Record<string, unknown>> {
	const body = res.body!.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("等待 SSE 帧超时");
		const read = body.read();
		const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("等待 SSE 帧超时")), remaining));
		const { value, done } = await Promise.race([read, timer]);
		if (done) throw new Error("SSE 流提前关闭");
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			if (!frame.startsWith("data:")) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(frame.slice(5).trim()) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (predicate(parsed)) {
				body.cancel();
				return parsed;
			}
		}
	}
}

// ---- zip fixture 生成器(与 book-zip.test.ts 相同,test 内各自定义避免过度抽象) ----

/** 收集 yazl ZipFile 输出为 Buffer。 */
async function collectZip(zip: yazl.ZipFile): Promise<Buffer> {
	zip.end();
	const chunks: Buffer[] = [];
	await pipeline(zip.outputStream, new PassThrough().on("data", (c: Buffer) => chunks.push(c)));
	return Buffer.concat(chunks);
}

/** 用 yazl 把 { relPath: content } 打成 zip Buffer。 */
async function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [rel, content] of Object.entries(files)) {
		zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), rel);
	}
	return collectZip(zip);
}

/** CRC-32(标准 zip 算法),用于手工构造 zip。 */
function crc32Of(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 手工构造最小 zip(store 压缩,无加密,UTF-8 条目名)。
 * yazl 会拒绝创建恶意路径(`..`)条目,故路径穿越 fixture 需要直接写字节。
 */
function buildRawZip(files: Record<string, string>): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const nameBuf = Buffer.from(name, "utf8");
		const crc = crc32Of(data);
		// 本地文件头
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 条目名
		local.writeUInt16LE(0, 8); // store(不压缩)
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, nameBuf, data);
		// 中央目录条目
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(0, 10);
		cen.writeUInt16LE(0, 12);
		cen.writeUInt16LE(0, 14);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(data.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt16LE(0, 30);
		cen.writeUInt16LE(0, 32);
		cen.writeUInt16LE(0, 34);
		cen.writeUInt16LE(0, 36);
		cen.writeUInt32LE(0, 38);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBuf);
		offset += 30 + nameBuf.length + data.length;
	}
	// 中央目录结束记录(EOCD)
	const cenSize = central.reduce((s, b) => s + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(Object.keys(files).length, 8);
	eocd.writeUInt16LE(Object.keys(files).length, 10);
	eocd.writeUInt32LE(cenSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([...parts, ...central, eocd]);
}

describe("WriterServer", () => {
	let server: WriterServer;
	let base = "";
	let fake: ReturnType<typeof fakeHost>;

	beforeAll(async () => {
		fake = fakeHost();
		// 显式注入不存在的 webDistDir:本组用例不测自动探测,避免命中磁盘残留的 web/dist
		server = new WriterServer({ host: "127.0.0.1", port: 0, sessionHost: fake.host, webDistDir: join(tmp, "no-such-dist") });
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await server.stop();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("GET /api/books 返回空列表", async () => {
		const res = await fetch(`${base}/api/books`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ books: [] });
	});

	// ---- 回环来源守卫(fix round: DNS rebinding / 跨站请求防护)----

	it("恶意 Host 头返回 403(防 DNS rebinding,浏览器无法伪造 Host)", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: "evil.example.com" });
		expect(res.status).toBe(403);
		expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden" } });
	});
	it("回环 Host + 恶意 Origin 返回 403(防跨站 fetch/EventSource/form)", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: `127.0.0.1:${port}`, origin: "http://evil.example.com" });
		expect(res.status).toBe(403);
	});
	it("回环 Host + null Origin 返回 403(sandbox iframe)", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: `127.0.0.1:${port}`, origin: "null" });
		expect(res.status).toBe(403);
	});
	it("回环 Host + Sec-Fetch-Site: cross-site 返回 403", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" });
		expect(res.status).toBe(403);
	});
	it("恶意 Host 下 SSE 端点同样 403", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: "evil.example.com" }, "/api/events");
		expect(res.status).toBe(403);
	});
	it("vite dev 代理形态 Host localhost:5173 放行", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: "localhost:5173" });
		expect(res.status).toBe(200);
	});
	it("IPv6 方括号 Host [::1]:port 放行", async () => {
		const port = Number(new URL(base).port);
		const res = await rawGet(port, { host: `[::1]:${port}` });
		expect(res.status).toBe(200);
	});
	it("POST /api/books 创建书并出现在列表", async () => {
		const res = await fetch(`${base}/api/books`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ title: "测试之书" }),
		});
		expect(res.status).toBe(200);
		const { books } = await (await fetch(`${base}/api/books`)).json();
		expect(books[0].title).toBe("测试之书");
	});
	it("PUT /api/draft 越界路径返回 400", async () => {
		const res = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "../../../etc/passwd", text: "x" }),
		});
		expect(res.status).toBe(400);
	});
	it("POST /api/chat 返回 202", async () => {
		const res = await fetch(`${base}/api/chat`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ text: "hi" }),
		});
		expect(res.status).toBe(202);
	});
	it("SSE 收到事件帧", async () => {
		const res = await fetch(`${base}/api/events`);
		const body = res.body!.getReader();
		const decoder = new TextDecoder();
		const { value } = await body.read();
		const chunk = decoder.decode(value);
		expect(chunk).toContain(": connected"); // 连接帧(服务端 openSse 首帧)
		body.cancel();
	});

	// ---- 路由表补充用例 ----

	it("POST /api/books 缺 title 返回 400 且错误体为 { error }", async () => {
		const res = await fetch(`${base}/api/books`, { method: "POST", headers: json, body: JSON.stringify({}) });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("GET /api/books/:slug 未知书返回 404", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("不存在的书")}`);
		expect(res.status).toBe(404);
	});
	it("GET /api/books/:slug 返回书索引", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}`);
		expect(res.status).toBe(200);
		const { book } = await res.json();
		expect(book.title).toBe("测试之书");
		expect(book.chapters).toHaveLength(1);
	});
	it("POST /api/books/:slug/chapters 新增章节,PATCH 更新标题", async () => {
		const slug = encodeURIComponent("测试之书");
		const add = await fetch(`${base}/api/books/${slug}/chapters`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ title: "第二章" }),
		});
		expect(add.status).toBe(200);
		const { chapter } = await add.json();
		expect(chapter.id).toBe("ch02");
		const patch = await fetch(`${base}/api/books/${slug}/chapters/ch02`, {
			method: "PATCH",
			headers: json,
			body: JSON.stringify({ title: "第二章·修订", label: "完成" }),
		});
		expect(patch.status).toBe(200);
		const { book } = await patch.json();
		expect(book.chapters.find((c: { id: string }) => c.id === "ch02")?.title).toBe("第二章·修订");
	});
	it("PATCH /api/books/:slug/chapters/:id 未知 id 返回 400", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/chapters/ch99`, {
			method: "PATCH",
			headers: json,
			body: JSON.stringify({ title: "不存在" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("POST /api/books/:slug/session 校验章节、初始化会话文件、切换会话并写 book.json", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/session`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ chapterFile: "ch02.jsonl" }),
		});
		expect(res.status).toBe(202);
		// initChapterFile:会话文件已落盘
		expect(existsSync(getChapterSessionsPath("测试之书", "ch02.jsonl"))).toBe(true);
		// switchSession 收到的是 sessions 目录下的绝对路径
		expect(fake.switchCalls).toContain(getChapterSessionsPath("测试之书", "ch02.jsonl"));
		// setCurrentChapter:book.json 的 currentChapterFile 已更新
		const reloaded = await loadBook("测试之书");
		expect(reloaded?.currentChapterFile).toBe("ch02.jsonl");
	});
	it("POST /api/books/:slug/session 章节不在索引返回 404", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/session`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ chapterFile: "ch99.jsonl" }),
		});
		expect(res.status).toBe(404);
	});
	it("POST /api/books/:slug/session 注入背景包(injectContext 收到文本)", async () => {
		// 世界书为空时背景包正文为空(无激活条目、无常驻组),先经 PUT /api/world 写入
		// 一条 notice,使背景包非空且带【Notice】小节;bookSlug 用完复位,
		// 保持后续 GET /api/world 无会话 404 用例的前置状态。
		fake.state.bookSlug = "测试之书";
		try {
			const current = (await (await fetch(`${base}/api/world`)).json()) as { world: WorldData };
			const seeded = structuredClone(current.world);
			seeded.notice = { text: "海边小镇,潮汐是日期的参照。", enabled: true, updatedAt: Date.now() };
			const put = await fetch(`${base}/api/world`, { method: "PUT", headers: json, body: JSON.stringify({ world: seeded }) });
			expect(put.status).toBe(200);
			const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/session`, {
				method: "POST",
				headers: json,
				body: JSON.stringify({ chapterFile: "ch02.jsonl" }),
			});
			expect(res.status).toBe(202);
			expect(fake.injectCalls.length).toBeGreaterThan(0);
			expect(fake.injectCalls[0]).toContain("【Notice·备忘录】");
		} finally {
			fake.state.bookSlug = null;
		}
	});
	it("GET /api/session 返回状态快照", async () => {
		const res = await fetch(`${base}/api/session`);
		expect(res.status).toBe(200);
		const snap = await res.json();
		expect(snap).toMatchObject({ sessionFile: null, bookSlug: null, isStreaming: false });
	});
	it("GET /api/session 带 slug+chapterFile 只读指定章节(不切换服务端会话)", async () => {
		// 前置:会话文件已由前面用例创建(initChapterFile),写入一条消息
		await fetch(`${base}/api/chat`, { method: "POST", headers: json, body: JSON.stringify({ text: "你好" }) });
		await new Promise((r) => setTimeout(r, 50));
		const switchesBefore = fake.switchCalls.length;
		const res = await fetch(`${base}/api/session?slug=${encodeURIComponent("测试之书")}&chapterFile=${encodeURIComponent("ch01.jsonl")}`);
		expect(res.status).toBe(200);
		const snap = (await res.json()) as { bookSlug: string; chapterFile: string; isStreaming: boolean; messages: unknown[] };
		expect(snap).toMatchObject({ bookSlug: "测试之书", chapterFile: "ch01.jsonl", isStreaming: false });
		expect(Array.isArray(snap.messages)).toBe(true);
		// 只读端点不得触发 switchSession(不中断流式)
		expect(fake.switchCalls.length).toBe(switchesBefore);
	});
	it("GET /api/session 只读:未知章节 404、新章节空消息", async () => {
		const missing = await fetch(`${base}/api/session?slug=${encodeURIComponent("测试之书")}&chapterFile=ch99.jsonl`);
		expect(missing.status).toBe(404);
		const fresh = await fetch(`${base}/api/session?slug=${encodeURIComponent("测试之书")}&chapterFile=${encodeURIComponent("ch02.jsonl")}`);
		expect(fresh.status).toBe(200);
		const body = (await fresh.json()) as { messages: unknown[] };
		expect(body.messages).toEqual([]);
	});
	it("GET /api/models 返回模型列表与当前模型", async () => {
		const res = await fetch(`${base}/api/models`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.models[0]).toMatchObject({ id: "sonnet", provider: "anthropic" });
		expect(body.current).toMatchObject({ id: "sonnet" });
		expect(body.thinking).toBe("off");
	});
	it("POST /api/model 与 POST /api/thinking 返回 200", async () => {
		const m = await fetch(`${base}/api/model`, { method: "POST", headers: json, body: JSON.stringify({ model: "opus" }) });
		expect(m.status).toBe(200);
		const t = await fetch(`${base}/api/thinking`, { method: "POST", headers: json, body: JSON.stringify({ level: "high" }) });
		expect(t.status).toBe(200);
	});
	it("POST /api/abort 返回 200", async () => {
		const res = await fetch(`${base}/api/abort`, { method: "POST" });
		expect(res.status).toBe(200);
	});
	it("GET /api/providers 返回 provider 列表", async () => {
		const res = await fetch(`${base}/api/providers`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { providers: Array<{ id: string }> };
		expect(body.providers.map((p) => p.id)).toEqual(["openai", "anthropic", "amazon-bedrock", "fail-provider"]);
	});
	it("POST /api/providers/anthropic/apikey 成功转发 key", async () => {
		const res = await fetch(`${base}/api/providers/anthropic/apikey`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ key: "sk-1" }),
		});
		expect(res.status).toBe(200);
		expect(fake.providerCalls).toContain("set:anthropic:sk-1");
	});
	it("POST apikey 未知 provider → 404", async () => {
		const res = await fetch(`${base}/api/providers/nope/apikey`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ key: "sk-1" }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});
	it("POST apikey 多提示 provider(fail-provider)→ 400 且不转发 key", async () => {
		const res = await fetch(`${base}/api/providers/fail-provider/apikey`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ key: "k" }),
		});
		expect(res.status).toBe(400);
		expect(fake.providerCalls).not.toContain("set:fail-provider:k");
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("bad_request");
		expect(body.error.message).toContain("需要额外配置");
	});
	it("POST apikey 空 key → 400", async () => {
		const res = await fetch(`${base}/api/providers/anthropic/apikey`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ key: "  " }),
		});
		expect(res.status).toBe(400);
	});
	it("POST apikey ambient 类(amazon-bedrock)→ 400", async () => {
		const res = await fetch(`${base}/api/providers/amazon-bedrock/apikey`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ key: "sk-1" }),
		});
		expect(res.status).toBe(400);
	});
	it("DELETE /api/providers/openai 成功转发", async () => {
		const res = await fetch(`${base}/api/providers/openai`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(fake.providerCalls).toContain("del:openai");
	});
	it("DELETE 未知 provider → 404", async () => {
		const res = await fetch(`${base}/api/providers/nope`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});
	it("GET /api/world 无会话返回 404", async () => {
		const res = await fetch(`${base}/api/world`);
		expect(res.status).toBe(404);
	});
	it("GET /api/world 返回 world.json 内容", async () => {
		fake.state.bookSlug = "测试之书";
		const res = await fetch(`${base}/api/world`);
		expect(res.status).toBe(200);
		const body = await res.json();
		// 世界书以 world.json 为准:entries 数组 + notice/storyline 等小节
		expect(Array.isArray(body.world.entries)).toBe(true);
		expect(Array.isArray(body.world.notice.items)).toBe(true);
	});
	it("PUT /api/world 非法数据返回 400 且不落盘", async () => {
		fake.state.bookSlug = "测试之书";
		const bad = structuredClone((await (await fetch(`${base}/api/world`)).json()).world);
		bad.entries = [{ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: "ghost", tags: [], body: "", updatedAt: 0 }];
		const res = await fetch(`${base}/api/world`, { method: "PUT", headers: json, body: JSON.stringify({ world: bad }) });
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "bad_request" } });
		// world.json 未变
		const after = await (await fetch(`${base}/api/world`)).json();
		expect(after.world.entries).toEqual([]);
	});
	it("PUT /api/draft 写文件并落盘在当前书 draft/ 目录(书根相对路径)", async () => {
		const put = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "draft/ch01.md", text: "你好,世界" }),
		});
		expect(put.status).toBe(200);
		const putBody = (await put.json()) as { ok: boolean; mtime: number };
		expect(putBody).toMatchObject({ ok: true });
		expect(typeof putBody.mtime).toBe("number"); // 响应带 mtime(If-Match 条件写依据)
		const onDisk = readFileSync(join(getBookDir("测试之书"), "draft", "ch01.md"), "utf-8");
		expect(onDisk).toBe("你好,世界");
	});
	it("GET /api/draft 返回文件内容", async () => {
		const res = await fetch(`${base}/api/draft?file=${encodeURIComponent("draft/ch01.md")}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { text: string; mtime: number };
		expect(body.text).toBe("你好,世界");
		expect(typeof body.mtime).toBe("number");
	});
	it("PUT /api/draft 写世界书源文件(书根相对路径,与 TUI 共享同一文件)", async () => {
		const put = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: ".writer/characters.md", text: "# 人物\n\n## 林婉\n\n林婉是主角。\n" }),
		});
		expect(put.status).toBe(200);
		const onDisk = readFileSync(join(getBookDir("测试之书"), ".writer", "characters.md"), "utf-8");
		expect(onDisk).toContain("## 林婉");
		// world.json 不受 draft 通道写入影响(世界书以 world.json 为准,视图文件可被下次保存覆盖)
		const worldRes = await (await fetch(`${base}/api/world`)).json() as { world: { entries: Array<{ title: string }> } };
		expect(worldRes.world.entries.some((n) => n.title === "林婉")).toBe(false);
		// outline.md 同样按书根解析(文件已随建书生成)
		const outline = await fetch(`${base}/api/draft?file=${encodeURIComponent("outline.md")}`);
		expect(outline.status).toBe(200);
		const body = await outline.json() as { text: string };
		expect(typeof body.text).toBe("string");
	});
	it("GET /api/draft 不存在文件返回空草稿(惰性创建,首次保存落盘)", async () => {
		const res = await fetch(`${base}/api/draft?file=${encodeURIComponent("missing.md")}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { text: string; mtime: number };
		expect(body.text).toBe("");
		expect(body.mtime).toBe(0);
	});
	it("PUT /api/draft 带 slug 写入指定书(与会话书不同也能写对目标)", async () => {
		// 会话书是 测试之书(此前用例已写入 ch01.md),显式 slug 指向 目标之书
		fake.state.bookSlug = "测试之书";
		const sessionBookBefore = readFileSync(join(getBookDir("测试之书"), "draft", "ch01.md"), "utf-8");
		const put = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "draft/ch01.md", text: "写入目标书", slug: "目标之书" }),
		});
		expect(put.status).toBe(200);
		const onDisk = readFileSync(join(getBookDir("目标之书"), "draft", "ch01.md"), "utf-8");
		expect(onDisk).toBe("写入目标书");
		// 会话书同名文件不被覆盖
		const sessionBookAfter = readFileSync(join(getBookDir("测试之书"), "draft", "ch01.md"), "utf-8");
		expect(sessionBookAfter).toBe(sessionBookBefore);
	});
	it("GET /api/draft 带 slug 读指定书(不依赖会话书)", async () => {
		const res = await fetch(
			`${base}/api/draft?file=${encodeURIComponent("draft/ch01.md")}&slug=${encodeURIComponent("目标之书")}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { text: string; mtime: number };
		expect(body.text).toBe("写入目标书");
		expect(typeof body.mtime).toBe("number");
	});
	it("PUT /api/draft If-Match 条件写:磁盘 mtime 已变时 409,匹配时放行", async () => {
		// 先落盘拿当前 mtime
		const put = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "draft/ch02.md", text: "v1" }),
		});
		const { mtime } = (await put.json()) as { mtime: number };
		// 磁盘被外部修改(AI 直改文件)→ 旧 mtime 失效。Windows 短间隔写入可能共享
		// mtime(容差 1ms 内放行),用 utimesSync 明确推进 5s 模拟真实的外部修改
		const draftFile = join(getBookDir("测试之书"), "draft", "ch02.md");
		writeFileSync(draftFile, "v2(外部修改)");
		const st = statSync(draftFile);
		utimesSync(draftFile, st.atime, new Date(st.mtimeMs + 5000));
		const stale = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: { ...json, "if-match": String(mtime) },
			body: JSON.stringify({ file: "draft/ch02.md", text: "v3(本地覆盖尝试)" }),
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
		// 磁盘未被覆盖
		expect(readFileSync(draftFile, "utf-8")).toBe("v2(外部修改)");
		// 取最新 mtime 后写入成功
		const fresh = await fetch(`${base}/api/draft?file=${encodeURIComponent("draft/ch02.md")}`);
		const freshMtime = ((await fresh.json()) as { mtime: number }).mtime;
		const ok = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: { ...json, "if-match": String(freshMtime) },
			body: JSON.stringify({ file: "draft/ch02.md", text: "v4(条件匹配)" }),
		});
		expect(ok.status).toBe(200);
		expect(readFileSync(draftFile, "utf-8")).toBe("v4(条件匹配)");
	});
	it("PUT /api/draft 绝对路径返回 400", async () => {
		const res = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "/etc/passwd", text: "x" }),
		});
		expect(res.status).toBe(400);
	});
	it("PUT /api/draft 超过 1MB 请求体返回 413", async () => {
		const res = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "big.md", text: "x".repeat(2 * 1024 * 1024) }),
		});
		expect(res.status).toBe(413);
	});
	it("未知路由返回 404 且错误体为 { error }", async () => {
		const res = await fetch(`${base}/api/nope`);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
	});
	it("SSE 广播会话事件帧", async () => {
		const res = await fetch(`${base}/api/events`);
		const body = res.body!.getReader();
		const decoder = new TextDecoder();
		await body.read(); // 先消费连接帧
		for (const l of fake.listeners) l({ type: "turn_end" });
		const { value } = await body.read();
		expect(decoder.decode(value)).toContain('data: {"type":"turn_end"}');
		body.cancel();
	});

	// ---- 多客户端同步合成事件(双浏览器场景)----

	it("PUT /api/draft 广播 draft_changed(另一窗口据此重载/提示冲突)", async () => {
		const res = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(res, (f) => f.type === "draft_changed");
		const put = await fetch(`${base}/api/draft`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ file: "draft/ch01.md", text: "多窗口草稿", slug: "测试之书" }),
		});
		expect(put.status).toBe(200);
		const frame = await framePromise;
		expect(frame).toMatchObject({ type: "draft_changed", file: "draft/ch01.md", slug: "测试之书" });
	});
	it("PUT /api/world 广播 world_changed(另一窗口据此重载/提示冲突)", async () => {
		fake.state.bookSlug = "测试之书";
		const res = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(res, (f) => f.type === "world_changed");
		const world = structuredClone((await (await fetch(`${base}/api/world`)).json()).world);
		const put = await fetch(`${base}/api/world`, { method: "PUT", headers: json, body: JSON.stringify({ world }) });
		expect(put.status).toBe(200);
		const frame = await framePromise;
		expect(frame).toMatchObject({ type: "world_changed", slug: "测试之书" });
	});
	it("POST /api/books/:slug/session 广播 session_changed(另一窗口据此对齐)", async () => {
		const res = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(res, (f) => f.type === "session_changed");
		const post = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/session`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ chapterFile: "ch02.jsonl" }),
		});
		expect(post.status).toBe(202);
		const frame = await framePromise;
		expect(frame).toMatchObject({ type: "session_changed", bookSlug: "测试之书", chapterFile: "ch02.jsonl" });
	});
	it("并发切换章节串行执行(互斥队列,多浏览器不交错)", async () => {
		const gate = fake.switchGate;
		const before = fake.switchCalls.length; // 此前用例已产生切换记录,按基线偏移断言
		let release!: () => void;
		gate.current = new Promise<void>((r) => (release = r));
		const slug = encodeURIComponent("测试之书");
		const p1 = fetch(`${base}/api/books/${slug}/session`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ chapterFile: "ch01.jsonl" }),
		});
		const p2 = fetch(`${base}/api/books/${slug}/session`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ chapterFile: "ch02.jsonl" }),
		});
		// 等第一个任务进入 switchSession;第二个任务必须仍在互斥队列中等待
		const deadline = Date.now() + 2000;
		while (fake.switchCalls.length < before + 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(fake.switchCalls).toHaveLength(before + 1);
		await new Promise((r) => setTimeout(r, 30));
		expect(fake.switchCalls).toHaveLength(before + 1); // 第二个被队列阻塞,未开始
		release();
		expect((await p1).status).toBe(202);
		expect((await p2).status).toBe(202);
		// FIFO:第二个切换在第一个完成后才开始,switchSession 调用顺序与请求顺序一致
		expect(fake.switchCalls.slice(before)).toEqual([
			getChapterSessionsPath("测试之书", "ch01.jsonl"),
			getChapterSessionsPath("测试之书", "ch02.jsonl"),
		]);
		gate.current = null;
	});
	it("webDistDir 指向不存在目录时非 /api 请求返回 404(现有行为)", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
	});
	it("POST /api/messages/retract 撤回并广播 messages_retracted", async () => {
		const before = fake.retractCalls.length;
		const sse = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(sse, (f) => f.type === "messages_retracted");
		const res = await fetch(`${base}/api/messages/retract`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "entry-1" }),
		});
		expect(res.status).toBe(200);
		expect(fake.retractCalls.slice(before)).toEqual(["entry-1"]);
		// SSE 客户端收到 messages_retracted(多窗口对齐)
		expect((await framePromise).type).toBe("messages_retracted");
	});
	it("POST /api/messages/retract 带 replacement 撤回后异步重发", async () => {
		const before = fake.retractCalls.length;
		const res = await fetch(`${base}/api/messages/retract`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "entry-2", replacement: "修改后的消息" }),
		});
		expect(res.status).toBe(200);
		expect(fake.retractCalls.slice(before)).toEqual(["entry-2"]);
	});
	it("POST /api/messages/retract 服务端拒绝时映射 400", async () => {
		const res = await fetch(`${base}/api/messages/retract`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "streaming-entry" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("POST /api/messages/retract 缺 entryId 返回 400", async () => {
		const res = await fetch(`${base}/api/messages/retract`, { method: "POST", headers: json, body: JSON.stringify({}) });
		expect(res.status).toBe(400);
	});
	it("POST /api/messages/branch 分支并广播 messages_retracted", async () => {
		const before = fake.branchCalls.length;
		const sse = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(sse, (f) => f.type === "messages_retracted");
		const res = await fetch(`${base}/api/messages/branch`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "entry-b1" }),
		});
		expect(res.status).toBe(200);
		expect(fake.branchCalls.slice(before)).toEqual(["entry-b1"]);
		expect((await framePromise).type).toBe("messages_retracted");
	});
	it("POST /api/messages/branch 服务端拒绝映射 400 / 缺 entryId 400", async () => {
		const bad = await fetch(`${base}/api/messages/branch`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "no-such" }),
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: { code: "bad_request" } });
		const missing = await fetch(`${base}/api/messages/branch`, { method: "POST", headers: json, body: JSON.stringify({}) });
		expect(missing.status).toBe(400);
	});
	it("GET /api/session/tree 返回分支概览", async () => {
		const res = await fetch(`${base}/api/session/tree`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { currentLeafId: string; branches: unknown[] };
		expect(body.currentLeafId).toBe("leaf-current");
		expect(body.branches).toHaveLength(2);
	});
	it("POST /api/messages/navigate 切换分支并广播 / 未知消息 400", async () => {
		const before = fake.navigateCalls.length;
		const sse = await fetch(`${base}/api/events`);
		const framePromise = waitForSseFrame(sse, (f) => f.type === "messages_retracted");
		const res = await fetch(`${base}/api/messages/navigate`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "leaf-other" }),
		});
		expect(res.status).toBe(200);
		expect(fake.navigateCalls.slice(before)).toEqual(["leaf-other"]);
		expect((await framePromise).type).toBe("messages_retracted");
		const bad = await fetch(`${base}/api/messages/navigate`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ entryId: "no-such" }),
		});
		expect(bad.status).toBe(400);
	});
});

describe("WriterServer 静态服务(webDistDir)", () => {
	let server: WriterServer;
	let base = "";
	let dist: string;

	beforeAll(async () => {
		// 模拟 web/dist:临时目录,含 index.html 与 assets/app.js
		dist = mkdtempSync(join(tmpdir(), "piw-webdist-"));
		mkdirSync(join(dist, "assets"), { recursive: true });
		writeFileSync(join(dist, "index.html"), "<!doctype html><title>pi-writer</title><p>hello</p>");
		writeFileSync(join(dist, "assets", "app.js"), "console.log('app')");
		const f = fakeHost();
		server = new WriterServer({ host: "127.0.0.1", port: 0, sessionHost: f.host, webDistDir: dist });
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await server.stop();
		rmSync(dist, { recursive: true, force: true });
	});

	it("GET / 返回 index.html 且 content-type 为 text/html", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("<title>pi-writer</title>");
	});
	it("GET /assets/app.js 返回文件内容且 content-type 为 text/javascript", async () => {
		const res = await fetch(`${base}/assets/app.js`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/javascript");
		expect(await res.text()).toBe("console.log('app')");
	});
	it("GET /nope 无扩展名 fallback 到 index.html(SPA 路由)", async () => {
		const res = await fetch(`${base}/nope`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("<title>pi-writer</title>");
	});
	it("GET /..%2fsecret 越界路径被拒绝", async () => {
		const res = await fetch(`${base}/..%2fsecret`);
		expect(res.status).toBe(400);
	});
	it("HEAD / 返回 200、content-length 且无 body", async () => {
		const res = await fetch(`${base}/`, { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
		expect(await res.text()).toBe("");
	});
	it("配置 webDistDir 时 /api/books 仍优先走 API 路由", async () => {
		const res = await fetch(`${base}/api/books`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.books)).toBe(true);
	});
	it("resolveBuiltinThemesDir 优先使用显式 webDistDir(打包机 web/dist 在 asar 内)", () => {
		const fakeDist = mkdtempSync(join(tmpdir(), "piw-themes-"));
		try {
			mkdirSync(join(fakeDist, "themes"), { recursive: true });
			writeFileSync(join(fakeDist, "themes", "paper.css"), ":root {}");
			expect(resolveBuiltinThemesDir({}, fakeDist)).toBe(join(fakeDist, "themes"));
		} finally {
			rmSync(fakeDist, { recursive: true, force: true });
		}
	});
	it("resolveBuiltinThemesDir 兼容 Electron resources/app.asar 探测", () => {
		const resDir = mkdtempSync(join(tmpdir(), "piw-res-"));
		const fakeAsar = join(resDir, "app.asar", "web", "dist");
		mkdirSync(join(fakeAsar, "themes"), { recursive: true });
		writeFileSync(join(fakeAsar, "themes", "mono.css"), ":root {}");
		const proc = process as { resourcesPath?: string };
		const prev = proc.resourcesPath;
		try {
			proc.resourcesPath = resDir;
			expect(resolveBuiltinThemesDir({}, null)).toBe(join(fakeAsar, "themes"));
		} finally {
			if (prev === undefined) delete proc.resourcesPath;
			else proc.resourcesPath = prev;
			rmSync(resDir, { recursive: true, force: true });
		}
	});
	it("GET /api/themes 无用户主题,内置主题从资产文件自动发现", async () => {
		const res = await fetch(`${base}/api/themes`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: unknown[]; builtin: Array<{ file: string; css: string }> };
		expect(body.user).toEqual([]);
		// 内置清单来自 web/public|dist/themes 枚举(零 ts 注册),测试树里应发现全部资产
		expect(body.builtin.length).toBeGreaterThanOrEqual(6);
		const files = body.builtin.map((b) => b.file);
		expect(files).toContain("paper.css");
		expect(files).toContain("mono-dark.css");
		for (const b of body.builtin) expect(typeof b.css).toBe("string");
	});
	it("PUT/GET/DELETE 用户主题:落盘、列表、raw text/css、删除", async () => {
		const put = await fetch(`${base}/api/themes/moon.css`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ css: ":root { --bg: #000; }" }),
		});
		expect(put.status).toBe(200);
		// 列表含全文
		const list = (await (await fetch(`${base}/api/themes`)).json()) as { user: Array<{ file: string; css: string }> };
		expect(list.user.map((u) => u.file)).toEqual(["moon.css"]);
		expect(list.user[0]!.css).toBe(":root { --bg: #000; }");
		// raw 端点 content-type 为 text/css
		const raw = await fetch(`${base}/api/themes/moon.css`);
		expect(raw.status).toBe(200);
		expect(raw.headers.get("content-type")).toContain("text/css");
		expect(await raw.text()).toBe(":root { --bg: #000; }");
		// 删除
		const del = await fetch(`${base}/api/themes/moon.css`, { method: "DELETE" });
		expect(del.status).toBe(200);
		const after = (await (await fetch(`${base}/api/themes`)).json()) as { user: unknown[] };
		expect(after.user).toEqual([]);
	});
	it("PUT /api/themes 非 .css 文件名返回 400(仅允许 *.css)", async () => {
		const res = await fetch(`${base}/api/themes/evil.txt`, {
			method: "PUT",
			headers: json,
			body: JSON.stringify({ css: ":root{}" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("书管理", () => {
	let server: WriterServer;
	let base = "";
	// 独立临时目录:与上层 describe 的书互不干扰(上层 afterAll 会删除其 tmp)
	const dir = mkdtempSync(join(tmpdir(), "piw-books-"));
	const savedWriterDir = process.env.PI_WRITER_DIR;

	beforeAll(async () => {
		process.env.PI_WRITER_DIR = dir;
		const fake = fakeHost();
		server = new WriterServer({ host: "127.0.0.1", port: 0, sessionHost: fake.host, webDistDir: join(dir, "no-such-dist") });
		const { port } = await server.start();
		base = `http://127.0.0.1:${port}`;
		// 造书:导出/删除用例的前置
		const first = await fetch(`${base}/api/books`, { method: "POST", headers: json, body: JSON.stringify({ title: "测试之书" }) });
		expect(first.status).toBe(200);
		const second = await fetch(`${base}/api/books`, { method: "POST", headers: json, body: JSON.stringify({ title: "待删除之书" }) });
		expect(second.status).toBe(200);
	});
	afterAll(async () => {
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
		// 恢复环境变量,不影响后续 describe
		if (savedWriterDir === undefined) delete process.env.PI_WRITER_DIR;
		else process.env.PI_WRITER_DIR = savedWriterDir;
	});

	/** 以 zip Buffer 发起 multipart 导入(单文件字段 file)。 */
	const postImport = (zipBuf: Buffer) => {
		const form = new FormData();
		// Uint8Array.from 复制出 ArrayBuffer 视图:TS 的 BlobPart 不接受
		// ArrayBufferLike 泛型(SharedArrayBuffer 不兼容),运行时字节相同
		form.append("file", new Blob([Uint8Array.from(zipBuf)]), "import.zip");
		return fetch(`${base}/api/books/import`, { method: "POST", body: form });
	};

	/** 以图片 Buffer 发起 multipart 上传(单文件字段 file)。 */
	const postImage = (slug: string, data: Buffer, filename = "a.png", contentType = "image/png") => {
		const form = new FormData();
		form.append("file", new Blob([Uint8Array.from(data)], { type: contentType }), filename);
		return fetch(`${base}/api/books/${encodeURIComponent(slug)}/images`, { method: "POST", body: form });
	};

	it("POST images 上传成功,GET 读回一致,DELETE 删除", async () => {
		await fetch(`${base}/api/books`, { method: "POST", headers: json, body: JSON.stringify({ title: "图片之书" }) });
		const slug = "图片之书";
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const up = await postImage(slug, bytes);
		expect(up.status).toBe(200);
		const { file } = (await up.json()) as { file: string };
		expect(file).toMatch(/^images\/img-[a-z0-9]{6}\.png$/);
		expect(existsSync(join(getBookDir(slug), file))).toBe(true);
		// 契约:URL 段携带完整引用(world.json 引用 = API 引用),前端 encodeURIComponent
		// 编码为单段 images%2Fx.png;GET/DELETE 按此形状请求
		const ref = encodeURIComponent(file);
		const get = await fetch(`${base}/api/books/${encodeURIComponent(slug)}/images/${ref}`);
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
		const del = await fetch(`${base}/api/books/${encodeURIComponent(slug)}/images/${ref}`, { method: "DELETE" });
		expect(del.status).toBe(200);
		expect(existsSync(join(getBookDir(slug), file))).toBe(false);
	});
	it("GET images 接受前端 imageUrl 产出的 URL(防断链回归)", async () => {
		const slug = "图片之书";
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const up = await postImage(slug, bytes);
		expect(up.status).toBe(200);
		const { file } = (await up.json()) as { file: string };
		// 直接使用前端 imageUrl(web/src/api/client.ts)拼 URL:形状改变/编码变化
		// 都会在这里断链(URL 为 /api/books/<slug>/images/images%2F<img-xxx>.png)
		const url = imageUrl(slug, file);
		const get = await fetch(`${base}${url}`);
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
	});
	it("POST images 非图片格式 400", async () => {
		const res = await postImage("图片之书", Buffer.from("x"), "a.txt", "text/plain");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});

	// ---- multipart 解析(busboy)分支覆盖 ----
	// 正常 file/data/end 走上传用例(上),resume 走多字段导入(下);此处补齐其余
	// 事件路径:非 multipart(前置守卫)、error(损坏 body)、limit(超限)、close 无 result(缺字段)。
	it("POST images 非 multipart content-type 返回 400(缺 boundary 守卫)", async () => {
		const res = await fetch(`${base}/api/books/图片之书/images`, {
			method: "POST",
			headers: json,
			body: "{}",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request", message: "缺少 multipart boundary" } });
	});
	it("POST images 损坏的 multipart body 返回 400(busboy error 事件)", async () => {
		// 截断的 part(header 后无空行/正文/结束 boundary):busboy 解析失败走 error 事件
		const res = await fetch(`${base}/api/books/图片之书/images`, {
			method: "POST",
			headers: { "content-type": "multipart/form-data; boundary=xyz" },
			body: '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n',
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("POST images 超过大小上限返回 400 too_large(busboy limit 事件)", async () => {
		const big = Buffer.alloc(5 * 1024 * 1024 + 1024);
		const form = new FormData();
		form.append("file", new Blob([Uint8Array.from(big)], { type: "image/png" }), "big.png");
		const res = await fetch(`${base}/api/books/图片之书/images`, { method: "POST", body: form });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "too_large" } });
	});
	it("POST images 缺少 file 字段返回 400(close 无 result 分支)", async () => {
		const form = new FormData();
		form.append("other", "x");
		const res = await fetch(`${base}/api/books/图片之书/images`, { method: "POST", body: form });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request", message: "缺少 multipart 字段 file" } });
	});
	it("POST images 未知书 404", async () => {
		const res = await postImage("不存在之书", Buffer.from("x"));
		expect(res.status).toBe(404);
	});
	it("GET images 越界 400 / 裸文件名 400 / 不存在 404", async () => {
		// %2e%2e%2f 编码避免浏览器 URL 规范化吃掉 ..;解码后 resolveImagePath 拒绝
		const escape = await fetch(`${base}/api/books/图片之书/images/%2e%2e%2fworld.json`);
		expect(escape.status).toBe(400);
		// 契约:URL 段必须是完整引用(images/ 前缀);裸文件名不再合法 → 400
		const bare = await fetch(`${base}/api/books/图片之书/images/nope.png`);
		expect(bare.status).toBe(400);
		const miss = await fetch(`${base}/api/books/图片之书/images/images%2Fnope.png`);
		expect(miss.status).toBe(404);
	});

	it("GET export 返回 zip 且内容与书目录一致", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("测试之书")}/export`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/zip");
		const buf = Buffer.from(await res.arrayBuffer());
		const { files } = await readImportZip(buf);
		expect(files.has("book.json")).toBe(true);
		expect(files.has("outline.md")).toBe(true);
	});
	it("GET export 书不存在返回 404", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("不存在的书")}/export`);
		expect(res.status).toBe(404);
	});
	it("POST import 合法 zip 导入成功并落盘", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "导入之书", title: "导入之书" }),
			"draft/ch01.md": "你好",
		});
		const res = await postImport(zip);
		expect(res.status).toBe(200);
		const { book } = await res.json();
		expect(book.slug).toBe("导入之书");
		expect(book.title).toBe("导入之书");
		// 书目录已存在且文件落盘
		expect(existsSync(getBookDir("导入之书"))).toBe(true);
		expect(JSON.parse(readFileSync(join(getBookDir("导入之书"), "book.json"), "utf-8")).slug).toBe("导入之书");
		expect(readFileSync(join(getBookDir("导入之书"), "draft", "ch01.md"), "utf-8")).toBe("你好");
	});
	it("POST import file 字段前有其他字段也能导入", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "多字段之书", title: "多字段之书" }),
			"draft/ch01.md": "内容",
		});
		const form = new FormData();
		// title 字段先于 file:解析循环越过前一个 part 的 boundary 后才能读到 file
		form.append("title", "先出现的字段");
		form.append("file", new Blob([Uint8Array.from(zip)]), "import.zip");
		const res = await fetch(`${base}/api/books/import`, { method: "POST", body: form });
		expect(res.status).toBe(200);
		const { book } = await res.json();
		expect(book.slug).toBe("多字段之书");
	});
	it("POST import slug 冲突自动副本", async () => {
		const zip = await makeZip({
			"book.json": JSON.stringify({ slug: "冲突之书", title: "冲突之书" }),
			"draft/ch01.md": "内容",
		});
		const first = await postImport(zip);
		expect(first.status).toBe(200);
		const second = await postImport(zip);
		expect(second.status).toBe(200);
		const { book } = await second.json();
		expect(book.slug).toBe("冲突之书-import-1");
		// 落盘的 book.json 的 slug 也被改写
		expect(JSON.parse(readFileSync(join(getBookDir("冲突之书-import-1"), "book.json"), "utf-8")).slug).toBe(
			"冲突之书-import-1",
		);
	});
	it("POST import 缺 book.json 返回 400", async () => {
		const zip = await makeZip({ "draft/ch01.md": "x" });
		const res = await postImport(zip);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("POST import 路径穿越条目返回 400", async () => {
		const zip = buildRawZip({
			"book.json": JSON.stringify({ slug: "穿越之书", title: "穿越之书" }),
			"../evil.md": "x",
		});
		const res = await postImport(zip);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("POST import 非 zip 返回 400", async () => {
		const res = await postImport(Buffer.from("这不是一个 zip"));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
	});
	it("DELETE 删除书目录与会话目录", async () => {
		const slug = "待删除之书";
		// 补一个会话文件,使会话目录在删除前确实存在内容
		writeFileSync(join(getBookSessionsDir(slug), "ch01.jsonl"), "x");
		expect(existsSync(getBookDir(slug))).toBe(true);
		expect(existsSync(getBookSessionsDir(slug))).toBe(true);
		const res = await fetch(`${base}/api/books/${encodeURIComponent(slug)}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(existsSync(getBookDir(slug))).toBe(false);
		expect(existsSync(getBookSessionsDir(slug))).toBe(false);
		const { books } = await (await fetch(`${base}/api/books`)).json();
		expect(books.some((b: { slug: string }) => b.slug === slug)).toBe(false);
	});
	it("DELETE 书不存在返回 404", async () => {
		const res = await fetch(`${base}/api/books/${encodeURIComponent("不存在的书")}`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});
	it("PATCH 重命名书:目录/会话迁移,返回新书索引", async () => {
		const slug = "测试之书";
		writeFileSync(join(getBookSessionsDir(slug), "ch01.jsonl"), "x"); // 会话文件随目录一起迁移
		const res = await fetch(`${base}/api/books/${encodeURIComponent(slug)}`, {
			method: "PATCH",
			headers: json,
			body: JSON.stringify({ title: "改名之书" }),
		});
		expect(res.status).toBe(200);
		const { book } = (await res.json()) as { book: { slug: string; title: string } };
		expect(book.slug).toBe("改名之书");
		expect(book.title).toBe("改名之书");
		expect(existsSync(getBookDir(slug))).toBe(false);
		expect(existsSync(getBookDir("改名之书"))).toBe(true);
		expect(existsSync(join(getBookSessionsDir("改名之书"), "ch01.jsonl"))).toBe(true);
		// 列表以新 slug 索引
		const { books } = (await (await fetch(`${base}/api/books`)).json()) as { books: Array<{ slug: string }> };
		expect(books.map((b) => b.slug)).toContain("改名之书");
		expect(books.map((b) => b.slug)).not.toContain(slug);
	});
	it("PATCH 重命名书 未知书 404 / 空标题 400", async () => {
		const miss = await fetch(`${base}/api/books/${encodeURIComponent("不存在的书")}`, {
			method: "PATCH",
			headers: json,
			body: JSON.stringify({ title: "新标题" }),
		});
		expect(miss.status).toBe(404);
		const empty = await fetch(`${base}/api/books/${encodeURIComponent("改名之书")}`, {
			method: "PATCH",
			headers: json,
			body: JSON.stringify({ title: "   " }),
		});
		expect(empty.status).toBe(400);
		expect(await empty.json()).toMatchObject({ error: { code: "bad_request" } });
	});
});
