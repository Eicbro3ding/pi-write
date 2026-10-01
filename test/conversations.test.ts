/**
 * 对话模型(conversationScope)单测 —— Stage 1(后端)的后端逻辑面:
 *
 * 1. **chapter 模式(缺省)的回归护栏**:会话身份、会话文件路径、事件负载与本次改动前
 *    逐字节一致(现网会话文件 `writer-ch01.jsonl` 不许改名/迁移);
 * 2. **book 模式**的多段对话:create/list/delete + 会话文件命名 + 标题派生(不落元数据文件);
 * 3. **收幕委托 chatAndWait 不受 book 模式影响**(仍按章节键取宿主);
 * 4. **book 模式不设正文写入白名单**(对话里的 AI 能编辑任意章节)。
 *
 * 手法与 test/writer-host.test.ts 一致:`createHost` 注入假宿主(不真起 agent);
 * 只在需要看真实装配项时走真 createHost + 把 `SessionHost.prototype.start` 打桩。
 * session-factory 被 mock 成「记录装配参数」,这样 roleFactory 的 draftFile /
 * 扩展工厂能在不起 agent 的前提下被断言。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBook, getBookSessionsDir, initChapterFile } from "../src/book-manager.ts";
import { getBookDir } from "../src/config.ts";
import { SessionManager } from "../vendor/pi-coding-agent/src/index.ts";
import { DEFAULT_CONVERSATION_TITLE, WriterHost, isSafeSessionId, writerDraftFile } from "../src/web/writer-host.ts";
import { SessionHost } from "../src/web/session-host.ts";

/** 捕获 session-factory 的装配参数(roleFactory 的 draftFile 等;不真起 agent)。 */
const factory = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown>> }));
vi.mock("../src/session-factory.ts", () => ({
	createSessionRuntimeFactory: (opts: Record<string, unknown>) => {
		factory.opts.push(opts);
		return opts;
	},
}));

interface FakeHostLike {
	subscribe(l: (e: unknown) => void): () => void;
	sendMessage: ReturnType<typeof vi.fn>;
	injectContext: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	getState(): { isStreaming: boolean; messages: Array<{ role: string; text: string }> };
}

function makeFakeHost(): FakeHostLike & { listeners: Set<(e: unknown) => void> } {
	const listeners = new Set<(e: unknown) => void>();
	return {
		listeners,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		sendMessage: vi.fn(async () => {}),
		injectContext: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		getState: () => ({ isStreaming: false, messages: [{ role: "assistant", text: "嗨" }] }),
	};
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-conv-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
	factory.opts.length = 0;
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tmp, { recursive: true, force: true });
});

/** 往会话文件里塞一条真实消息(用 vendor 的 SessionManager,不手写 jsonl)。 */
async function seedUserMessage(slug: string, id: string, text: string): Promise<void> {
	const sessionsDir = getBookSessionsDir(slug);
	await mkdir(sessionsDir, { recursive: true });
	const abs = join(sessionsDir, `writer-${id.replace(/\.jsonl$/, "")}.jsonl`);
	await initChapterFile(abs, getBookDir(slug));
	const sm = SessionManager.open(abs, sessionsDir, getBookDir(slug));
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as never);
}

/** 调私有 createHost(真装配路径;配合 start 打桩,不真起 agent)。 */
function realCreateHost(host: WriterHost, slug: string, key: string, chapter: string | null): Promise<SessionHost> {
	return (host as unknown as { createHost(s: string, k: string, c: string | null): Promise<SessionHost> }).createHost(slug, key, chapter);
}

function draftFileOf(host: SessionHost): string | undefined {
	return (host as unknown as { options: { toolGuard?: { draftFile?: string } } }).options.toolGuard?.draftFile;
}

/** 调私有的身份解析(唯一真相源):断言端点参数被解析成哪段对话、哪个章节语义。 */
function resolveRefOf(
	host: WriterHost,
	slug: string,
	chapterFile: string | null | undefined,
	conversation?: string | null,
	record = false,
): { key: string; chapter: string | null } {
	return (
		host as unknown as {
			resolveRef(s: string, c: string | null | undefined, conv?: string | null, r?: boolean): { key: string; chapter: string | null };
		}
	).resolveRef(slug, chapterFile, conversation, record);
}

describe("chapter 模式(缺省):与改动前逐字节一致的回归护栏", () => {
	it("章节即对话:会话键仍是 `${slug}:${chapterFile}`,state 回显章节、事件不带 conversation", async () => {
		const fake = makeFakeHost();
		const keys: string[] = [];
		const host = new WriterHost({
			createHost: async (key) => {
				keys.push(key);
				return fake as never;
			},
		});
		const seen: unknown[] = [];
		host.setEventSink((slug, chapterFile, event, conversation) => seen.push({ slug, chapterFile, event, conversation }));
		await host.chat("fog-harbor", "把结尾改含蓄点", "ch01.jsonl");
		expect(keys).toEqual(["fog-harbor:ch01.jsonl"]);
		for (const l of fake.listeners) l({ type: "turn_start" });
		// conversation 在 chapter 模式下是 undefined(server 据此构造与改动前一致的负载)
		expect(seen).toEqual([
			{ slug: "fog-harbor", chapterFile: "ch01.jsonl", conversation: undefined, event: { type: "turn_start" } },
		]);
		expect(await host.state("fog-harbor", "ch01.jsonl")).toEqual({
			bookSlug: "fog-harbor",
			chapterFile: "ch01.jsonl",
			exists: true,
			isStreaming: false,
			messages: [{ role: "assistant", text: "嗨" }],
		});
		// 缺省用最近声明的章节(与今天同款回落)
		expect((await host.state("fog-harbor")).chapterFile).toBe("ch01.jsonl");
	});

	it("会话文件仍是 writer-<章节>.jsonl(不许改名/迁移),正文白名单仍是当前章节", async () => {
		vi.spyOn(SessionHost.prototype, "start").mockResolvedValue();
		const host = new WriterHost({ classicMode: false });
		const created = await realCreateHost(host, "雾港", "ch01.jsonl", "ch01.jsonl");
		const abs = join(getBookSessionsDir("雾港"), "writer-ch01.jsonl");
		expect(existsSync(abs)).toBe(true);
		// 合法 pi session 头(经 initChapterFile,与章节会话同款)
		const header = JSON.parse(readFileSync(abs, "utf8").split("\n")[0]!) as { type: string; version: number; cwd: string };
		expect(header).toMatchObject({ type: "session", cwd: getBookDir("雾港") });
		expect(draftFileOf(created)).toBe("ch01.md");
	});
});

describe("book 模式:会话身份与章节解绑", () => {
	it("chapterFile 只登记「正在看的章节」,不决定会话身份(缺省仍落 default)", async () => {
		const fake = makeFakeHost();
		const keys: string[] = [];
		const host = new WriterHost({
			conversationScope: "book",
			createHost: async (key) => {
				keys.push(key);
				return fake as never;
			},
		});
		await host.chat("fog-harbor", "先聊聊结构", "ch01.jsonl");
		await host.chat("fog-harbor", "看看第二章", "ch02.jsonl");
		// 同一段对话:换「正在看的章节」不该切会话
		expect(keys).toEqual(["fog-harbor:default"]);
		// 正在看的章节仍回显给前端(易变上下文),只是不绑身份
		expect((await host.state("fog-harbor", "ch02.jsonl")).chapterFile).toBe("ch02.jsonl");
	});

	it("上下文里的「当前正文」在调用时现读正在看的章节(不是建会话时捕获)", async () => {
		const host = new WriterHost({ conversationScope: "book" });
		const slug = "雾港";
		await mkdir(join(getBookDir(slug), "draft"), { recursive: true });
		await writeFile(join(getBookDir(slug), "draft", "ch01.md"), "第一章正文", "utf8");
		// 伪装装配:捕获 roleFactory 交给 session-factory 的参数与 context 钩子
		const captured = (
			host as unknown as {
				roleFactory(s: string, k: string, c: string | null): { extensionFactories: Array<{ factory(pi: unknown): void }> };
			}
		).roleFactory(slug, "c-abc123", null);
		let contextHook: ((event: { messages: unknown[] }) => Promise<{ messages: Array<{ content: string }> } | undefined>) | undefined;
		captured.extensionFactories[0]!.factory({ on: (name: string, fn: never) => {
			if (name === "context") contextHook = fn;
		} } as never);
		// 建会话时 viewChapter 还是空:不注入正文块
		expect(await contextHook!({ messages: [] })).toBeUndefined();
		// 之后用户切到第一章:同一份已建会话的下一轮就能看到正文
		host.setViewChapter(slug, "ch01.jsonl");
		const injected = await contextHook!({ messages: [] });
		expect(injected?.messages.at(-1)?.content).toContain("【当前正文 · draft/ch01.md】");
		expect(injected?.messages.at(-1)?.content).toContain("第一章正文");
		// 离开章节(没有正在看的正文):不再注入
		host.setViewChapter(slug, null);
		expect(await contextHook!({ messages: [] })).toBeUndefined();
	});

	it("chapterFile 三态(book 模式):没传保留上次登记、显式 null 清空、传值换章节", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ conversationScope: "book", createHost: async () => fake as never });
		const slug = "雾港";
		await host.chat(slug, "看第一章", "ch01.jsonl");
		expect((await host.state(slug)).chapterFile).toBe("ch01.jsonl");
		await host.chat(slug, "换第二章", "ch02.jsonl");
		expect((await host.state(slug)).chapterFile).toBe("ch02.jsonl");
		// 显式空值(state 第二参传 null)= 没有正在看的章节 → 正文块不再注入
		expect((await host.state(slug, null)).chapterFile).toBeNull();
		// 之后没传:保留「没有章节」这个状态,而不是翻回旧值
		expect((await host.state(slug)).chapterFile).toBeNull();
	});

	it("收幕委托 chatAndWait 仍按章节键取宿主,跑不进自由对话", async () => {
		const free = makeFakeHost();
		const chapter = makeFakeHost();
		const keys: string[] = [];
		const host = new WriterHost({
			conversationScope: "book",
			createHost: async (key) => {
				keys.push(key);
				return (key.endsWith(":ch03.jsonl") ? chapter : free) as never;
			},
		});
		// 用户正在一段自由对话里
		await host.chat("fog-harbor", "聊聊第三章", "ch03.jsonl", "c-free1");
		// 收幕成文:必须落到 ch03.jsonl 那个 (书, 章节) 会话,而不是 c-free1
		expect(await host.chatAndWait("fog-harbor", "【舞台转录】请成文", "ch03.jsonl", 2000)).toBe(true);
		expect(keys).toEqual(["fog-harbor:c-free1", "fog-harbor:ch03.jsonl"]);
		expect(free.sendMessage).toHaveBeenCalledWith("聊聊第三章");
		expect(chapter.sendMessage).toHaveBeenCalledWith("【舞台转录】请成文");
	});
});

describe("book 模式:对话 CRUD(会话文件是唯一真相源)", () => {
	it("createConversation 写合法 session 头、成为当前对话;listConversations 标题派生 + 排序", async () => {
		const book = await createBook("雾港");
		const slug = book.slug;
		const host = new WriterHost({ conversationScope: "book", createHost: async () => makeFakeHost() as never });

		const first = await host.createConversation(slug);
		// 文件名安全的不透明 id(不透明 ≠ 章节名),落到同一个命名函数 writer-<id>.jsonl
		expect(first.id).toMatch(/^c-[a-z0-9]{6}$/);
		expect(isSafeSessionId(first.id)).toBe(true);
		const abs = join(getBookSessionsDir(slug), `writer-${first.id}.jsonl`);
		expect(existsSync(abs)).toBe(true);
		const header = JSON.parse(readFileSync(abs, "utf8").split("\n")[0]!) as { type: string; version: number };
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);

		let list = await host.listConversations(slug);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: first.id, title: DEFAULT_CONVERSATION_TITLE, isCurrent: true });

		// 第二段:新的在前(按 mtime 倒序),两段都在
		const second = await host.createConversation(slug);
		expect(second.id).not.toBe(first.id);
		list = await host.listConversations(slug);
		expect(list.map((c) => c.id)).toEqual([second.id, first.id]);
		expect(list.filter((c) => c.isCurrent).map((c) => c.id)).toEqual([second.id]);

		// 标题从会话内容派生(第一条用户消息前若干字)——不落元数据文件
		await seedUserMessage(slug, first.id, "帮我把开头的节奏放慢一点");
		list = await host.listConversations(slug);
		expect(list.find((c) => c.id === first.id)?.title).toBe("帮我把开头的节奏放慢一点");
		expect(list.find((c) => c.id === second.id)?.title).toBe(DEFAULT_CONVERSATION_TITLE);
		// 会话目录里只有会话文件本身(没有 conversations.json 之类的第二份清单)
		expect(existsSync(join(getBookSessionsDir(slug), "conversations.json"))).toBe(false);
	});

	it("chapter 模式下 listConversations 把已有章节会话列成章节文件名(ch01.jsonl)", async () => {
		const book = await createBook("雾港");
		const slug = book.slug;
		await seedUserMessage(slug, "ch01.jsonl", "第一章的对话");
		await seedUserMessage(slug, "default", "无章节的默认对话");
		const host = new WriterHost({ createHost: async () => makeFakeHost() as never });
		const list = await host.listConversations(slug);
		expect(list.map((c) => c.id).sort()).toEqual(["ch01.jsonl", "default"]);
		expect(list.find((c) => c.id === "ch01.jsonl")?.title).toBe("第一章的对话");
	});

	it("deleteConversation 释放宿主 + 删会话文件 + 清当前对话登记;不存在返回 false", async () => {
		const book = await createBook("雾港");
		const slug = book.slug;
		const fake = makeFakeHost();
		const host = new WriterHost({ conversationScope: "book", createHost: async () => fake as never });
		const conv = await host.createConversation(slug);
		await host.chat(slug, "hi", undefined, conv.id);
		expect(fake.sendMessage).toHaveBeenCalledWith("hi");
		expect(await host.deleteConversation(slug, conv.id)).toBe(true);
		expect(fake.dispose).toHaveBeenCalledOnce();
		expect(existsSync(join(getBookSessionsDir(slug), `writer-${conv.id}.jsonl`))).toBe(false);
		expect(await host.listConversations(slug)).toEqual([]);
		// 再删同一条:没删到任何东西
		expect(await host.deleteConversation(slug, conv.id)).toBe(false);
	});

	it("conversation 参数按对话定位(两段互不串台);abort 可只打一段", async () => {
		const a = makeFakeHost();
		const b = makeFakeHost();
		const keys: string[] = [];
		const host = new WriterHost({
			conversationScope: "book",
			createHost: async (key) => {
				keys.push(key);
				return (key.endsWith(":c-aaaaaa") ? a : b) as never;
			},
		});
		await host.chat("fog-harbor", "给 A 的话", undefined, "c-aaaaaa");
		await host.chat("fog-harbor", "给 B 的话", "ch02.jsonl", "c-bbbbbb");
		expect(keys).toEqual(["fog-harbor:c-aaaaaa", "fog-harbor:c-bbbbbb"]);
		expect(a.sendMessage).toHaveBeenCalledWith("给 A 的话");
		expect(b.sendMessage).toHaveBeenCalledWith("给 B 的话");
		await host.abort("fog-harbor", "c-aaaaaa");
		expect(a.abort).toHaveBeenCalledOnce();
		expect(b.abort).not.toHaveBeenCalled();
		await host.abort("fog-harbor");
		expect(b.abort).toHaveBeenCalledOnce();
	});

	it("book 模式的事件带 conversation,chapterFile 为 null(前端据此过滤到对话)", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ conversationScope: "book", createHost: async () => fake as never });
		const seen: unknown[] = [];
		host.setEventSink((slug, chapterFile, event, conversation) => seen.push({ slug, chapterFile, conversation, event }));
		await host.chat("fog-harbor", "hi", "ch01.jsonl", "c-abc123");
		for (const l of fake.listeners) l({ type: "turn_start" });
		expect(seen).toEqual([{ slug: "fog-harbor", chapterFile: null, conversation: "c-abc123", event: { type: "turn_start" } }]);
	});

	it("非法对话 id 被拒(挡住路径穿越)", async () => {
		const host = new WriterHost({ conversationScope: "book", createHost: async () => makeFakeHost() as never });
		await expect(host.deleteConversation("fog-harbor", "../../etc/passwd")).rejects.toThrow("非法对话 id");
		await expect(host.chat("fog-harbor", "hi", undefined, "../evil")).rejects.toThrow("非法对话 id");
		expect(isSafeSessionId("../../etc/passwd")).toBe(false);
		expect(isSafeSessionId("ch01.jsonl")).toBe(true);
		expect(isSafeSessionId("c-abc123")).toBe(true);
		expect(isSafeSessionId("第一章.jsonl")).toBe(true);
	});
});

describe("正文写入白名单(book 模式下 AI 可编辑任意章节)", () => {
	it("writerDraftFile:非经典 + chapter 才有白名单;book / 经典 / 无章节都没有", () => {
		expect(writerDraftFile({ classicMode: false, conversationScope: "chapter", chapter: "ch01.jsonl" })).toBe("ch01.md");
		expect(writerDraftFile({ classicMode: false, conversationScope: "book", chapter: "ch01.jsonl" })).toBeUndefined();
		expect(writerDraftFile({ classicMode: true, conversationScope: "chapter", chapter: "ch01.jsonl" })).toBeUndefined();
		expect(writerDraftFile({ classicMode: false, conversationScope: "chapter", chapter: null })).toBeUndefined();
	});

	it("真装配路径:chapter 模式的 toolGuard 与 roleFactory 都带白名单,book 模式都不带", async () => {
		vi.spyOn(SessionHost.prototype, "start").mockResolvedValue();
		const chapterHost = new WriterHost({ classicMode: false });
		const created = await realCreateHost(chapterHost, "雾港", "ch01.jsonl", "ch01.jsonl");
		expect(draftFileOf(created)).toBe("ch01.md");
		expect(factory.opts.at(-1)?.draftFile).toBe("ch01.md");

		factory.opts.length = 0;
		const bookHost = new WriterHost({ classicMode: false, conversationScope: "book" });
		const createdBook = await realCreateHost(bookHost, "雾港", "c-abc123", "ch01.jsonl");
		// 白名单不存在 = 对话里的 AI 能写别的章节文件
		expect(draftFileOf(createdBook)).toBeUndefined();
		expect(factory.opts.at(-1)?.draftFile).toBeUndefined();
		// 会话文件仍走同一个命名函数
		expect(existsSync(join(getBookSessionsDir("雾港"), "writer-c-abc123.jsonl"))).toBe(true);
	});

	/**
	 * 回归:**chapter 模式下会话键不是章节文件名时,不许把不透明 id 当章节**
	 * (用户先在 book 模式建自由对话、再把设置切回 chapter 模式,然后在那段对话里说话)。
	 * 修前 resolveRef 返回 chapter = "c-abc123",白名单算成 c-abc123.md ——
	 * AI 被静默拦住,写不了任何章节的正文。
	 */
	it("chapter 模式 + 不透明对话 id:不设正文白名单(不落 c-xxxxxx.md)", async () => {
		const host = new WriterHost({ classicMode: false });
		// 不传 chapterFile,只传一段自由对话的 id(切回 chapter 模式后最典型的调用)
		const ref = resolveRefOf(host, "雾港", undefined, "c-abc123", true);
		// 会话身份仍是那段自由对话(会话文件 writer-c-abc123.jsonl 不变)
		expect(ref.key).toBe("c-abc123");
		// 但它不是章节 —— 修前这里是 "c-abc123",白名单算成 c-abc123.md
		expect(ref.chapter).toBeNull();
		expect(writerDraftFile({ classicMode: false, conversationScope: "chapter", chapter: ref.chapter })).toBeUndefined();
		// state 也不把这个 id 当章节回显
		expect((await host.state("雾港", undefined, "c-abc123")).chapterFile).toBeNull();
		// 兜底会话(default)本来就没有章节语义(换本书,避开上面的记账)
		expect(resolveRefOf(host, "另一本", undefined, undefined)).toEqual({ key: "default", chapter: null });
	});

	it("book 模式 + 不透明对话 id:同样不设白名单", () => {
		const host = new WriterHost({ classicMode: false, conversationScope: "book" });
		const ref = resolveRefOf(host, "雾港", "ch01.jsonl", "c-abc123", true);
		expect(ref.key).toBe("c-abc123");
		expect(ref.chapter).toBe("ch01.jsonl"); // 只是「正在看的章节」,不是会话身份
		expect(writerDraftFile({ classicMode: false, conversationScope: "book", chapter: "c-abc123" })).toBeUndefined();
		expect(writerDraftFile({ classicMode: false, conversationScope: "book", chapter: ref.chapter })).toBeUndefined();
	});

	it("chapter 模式 + 真实章节文件名:仍按 `<id>.md` 设白名单(回归)", async () => {
		vi.spyOn(SessionHost.prototype, "start").mockResolvedValue();
		const host = new WriterHost({ classicMode: false });
		// conversation 就是章节文件名(既有前端调用形态)
		const ref = resolveRefOf(host, "雾港", undefined, "ch02.jsonl", true);
		expect(ref).toEqual({ key: "ch02.jsonl", chapter: "ch02.jsonl" });
		expect(writerDraftFile({ classicMode: false, conversationScope: "chapter", chapter: ref.chapter })).toBe("ch02.md");
		// 真装配路径同样带白名单(与改动前一致)
		const created = await realCreateHost(host, "雾港", ref.key, ref.chapter);
		expect(draftFileOf(created)).toBe("ch02.md");
		expect((await host.state("雾港", undefined, "ch02.jsonl")).chapterFile).toBe("ch02.jsonl");
		expect(writerDraftFile({ classicMode: false, conversationScope: "chapter", chapter: null })).toBeUndefined();
	});
});
