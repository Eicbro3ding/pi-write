/**
 * WriterHost(常驻编剧)单测:createHost 注入假会话,验证惰性创建/事件转发/
 * 状态/中止/释放,不碰真实 provider(与 session-host.test.ts 同模式,fake 边界
 * 用仓库既有的 as never 约定)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendStageEntry, makeStageEntry } from "../src/stage/stage-store.ts";
import { getBookDir } from "../src/config.ts";
import { ensureWorld, saveWorld } from "../src/world-data.ts";
import { hostPromptScope, latestStageTranscript, stableFingerprint, WriterHost, writerToolset } from "../src/web/writer-host.ts";

interface FakeHostLike {
	subscribe(l: (e: unknown) => void): () => void;
	sendMessage: ReturnType<typeof vi.fn>;
	injectContext: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
	/** 会话当前模型(null = 还没选到,见 usableModelRef)。 */
	currentModel: ReturnType<typeof vi.fn>;
	refreshModels: ReturnType<typeof vi.fn>;
	getState(): { isStreaming: boolean; messages: Array<{ role: string; text: string }> };
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | null;
	compact: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
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
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(() => {}),
		currentModel: vi.fn(() => ({ provider: "openai", id: "gpt-5" })),
		refreshModels: vi.fn(async () => {}),
		getState: () => ({ isStreaming: false, messages: [{ role: "assistant", text: "嗨" }] }),
		getContextUsage: () => ({ tokens: 800, contextWindow: 4000, percent: 20 }),
		compact: vi.fn(async () => ({ summary: "已压缩", tokensBefore: 800, estimatedTokensAfter: 300 })),
		dispose: vi.fn(async () => {}),
	};
}

// 稳定块同步(syncStableContext)会经 getBookDir 读世界书:整体隔离到临时
// PI_WRITER_DIR,避免测试读/写真实 ~/.pi/writer 数据
let tmpRoot: string;
beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "piw-writer-host-"));
	vi.stubEnv("PI_WRITER_DIR", tmpRoot);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("WriterHost", () => {
	it("state 纯读不创建会话(未对话过的书返回空态)", async () => {
		const createHost = vi.fn(async () => makeFakeHost() as never);
		const host = new WriterHost({ createHost: createHost as never });
		const st = await host.state("fog-harbor");
		expect(st).toEqual({ bookSlug: "fog-harbor", chapterFile: null, exists: false, isStreaming: false, messages: [] });
		expect(createHost).not.toHaveBeenCalled();
	});
	it("contextUsage 纯读:无会话 null,有会话转发占用", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		expect(await host.contextUsage("fog-harbor")).toBeNull();
		await host.chat("fog-harbor", "hi", "ch01.jsonl");
		expect(await host.contextUsage("fog-harbor", "ch01.jsonl")).toEqual({ tokens: 800, contextWindow: 4000, percent: 20 });
	});
	it("compact 惰性建会话并转发附加要求", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await expect(host.compact("fog-harbor", "ch01.jsonl", "保留冲突")).resolves.toEqual({
			summary: "已压缩",
			tokensBefore: 800,
			estimatedTokensAfter: 300,
		});
		expect(fake.compact).toHaveBeenCalledWith("保留冲突");
	});
	it("chat 惰性创建会话、转发消息、事件经 eventSink 流出", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		const seen: unknown[] = [];
		host.setEventSink((slug, chapterFile, event) => seen.push({ slug, chapterFile, event }));
		await host.chat("fog-harbor", "把结尾改含蓄点", "ch01.jsonl");
		expect(fake.sendMessage).toHaveBeenCalledWith("把结尾改含蓄点");
		// 模拟会话事件扇出:订阅在 chat 建会话时已挂上
		for (const l of fake.listeners) l({ type: "turn_start" });
		expect(seen).toEqual([{ slug: "fog-harbor", chapterFile: "ch01.jsonl", event: { type: "turn_start" } }]);
	});
	it("chat 声明章节后 state 反映 chapterFile 与会话内容", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat("fog-harbor", "hi", "ch02.jsonl");
		const st = await host.state("fog-harbor");
		expect(st.exists).toBe(true);
		expect(st.chapterFile).toBe("ch02.jsonl");
		expect(st.isStreaming).toBe(false);
		expect(st.messages[0]).toMatchObject({ role: "assistant", text: "嗨" });
	});
	it("abort 无会话时静默,有会话时转发", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.abort("fog-harbor");
		expect(fake.abort).not.toHaveBeenCalled();
		await host.chat("fog-harbor", "hi");
		await host.abort("fog-harbor");
		expect(fake.abort).toHaveBeenCalledOnce();
	});
	it("chat 失败向上抛出(server 负责广播 chat_error)", async () => {
		const fake = makeFakeHost();
		fake.sendMessage.mockRejectedValueOnce(new Error("boom"));
		const host = new WriterHost({ createHost: async () => fake as never });
		await expect(host.chat("fog-harbor", "hi")).rejects.toThrow("boom");
	});
	it("disposeAll 释放全部会话并清空宿主", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat("fog-harbor", "hi");
		await host.chat("other-book", "hi");
		await host.disposeAll();
		expect(fake.dispose).toHaveBeenCalledTimes(2);
		const st = await host.state("fog-harbor");
		expect(st.exists).toBe(false);
	});
	/**
	 * 2026-10-01 修「同一个对话窗口里换模型不生效」:模型在会话创建时绑死
	 * (vendor sdk.ts 的 defaultModelId),换模型必须打到**已建**会话上;
	 * 此前 POST /api/model 只打主会话宿主,编剧会话一路用旧模型。
	 */
	it("setModel / setThinkingLevel 即时打到已建的编剧会话", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat("fog-harbor", "hi", "ch01.jsonl"); // 先建出会话
		await host.setModel("openai/gpt-5");
		await host.setThinkingLevel("high");
		expect(fake.setModel).toHaveBeenCalledWith("openai/gpt-5");
		expect(fake.setThinkingLevel).toHaveBeenCalledWith("high");
	});
	it("setModel 无会话时只记账(不建会话,不报错)", async () => {
		const createHost = vi.fn(async () => makeFakeHost() as never);
		const host = new WriterHost({ createHost: createHost as never });
		await host.setModel("openai/gpt-5");
		expect(createHost).not.toHaveBeenCalled();
	});
	it("setModel 逐个会话尝试:一个失败不挡其余,错误最后抛出", async () => {
		const bad = makeFakeHost();
		bad.setModel.mockRejectedValue(new Error("没有对应鉴权"));
		const good = makeFakeHost();
		const made: FakeHostLike[] = [];
		const host = new WriterHost({
			createHost: async () => {
				const fake = made.length === 0 ? bad : good;
				made.push(fake);
				return fake as never;
			},
		});
		await host.chat("fog-harbor", "a", "ch01.jsonl");
		await host.chat("fog-harbor", "b", "ch02.jsonl");
		await expect(host.setModel("openai/gpt-5")).rejects.toThrow("没有对应鉴权");
		expect(good.setModel).toHaveBeenCalledWith("openai/gpt-5");
	});

	/**
	 * 2026-10-04 修「加完第三方供应商与模型、选中后开聊仍报 No API key found for the
	 * selected model」:models.json 是**每个会话装配时**各读一次的,新增模型后只刷主会话
	 * 等于已建编剧会话还在旧目录里 —— 选中新模型在编剧会话上解析不到(not found),
	 * 而对话继续拿 unknown 占位模型发请求。
	 */
	it("refreshModels 让已建会话重读模型目录(有模型的会话不释放)", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat("fog-harbor", "hi", "ch01.jsonl");
		await host.refreshModels();
		expect(fake.refreshModels).toHaveBeenCalledTimes(1);
		expect(fake.dispose).not.toHaveBeenCalled();
	});
	it("refreshModels 释放「一个模型都没选到」的空壳会话:下次对话按最新目录重新装配", async () => {
		const made: FakeHostLike[] = [];
		const host = new WriterHost({
			createHost: async () => {
				const fake = makeFakeHost();
				fake.currentModel.mockReturnValue(null); // 建会话时无可用模型 → vendor 给 unknown 占位
				made.push(fake);
				return fake as never;
			},
		});
		await host.chat("fog-harbor", "hi", "ch01.jsonl");
		await host.refreshModels();
		expect(made[0]!.refreshModels).not.toHaveBeenCalled();
		expect(made[0]!.dispose).toHaveBeenCalledTimes(1);
		// 再说话:重新建宿主(释放掉的空壳不会复活),历史仍从同一份会话文件恢复
		await host.chat("fog-harbor", "又说一句", "ch01.jsonl");
		expect(made).toHaveLength(2);
	});
	it("refreshModels 单个会话刷新失败不影响其余", async () => {
		const bad = makeFakeHost();
		bad.refreshModels.mockRejectedValue(new Error("refresh 炸了"));
		const good = makeFakeHost();
		const made: FakeHostLike[] = [];
		const host = new WriterHost({
			createHost: async () => {
				const fake = made.length === 0 ? bad : good;
				made.push(fake);
				return fake as never;
			},
		});
		await host.chat("fog-harbor", "a", "ch01.jsonl");
		await host.chat("fog-harbor", "b", "ch02.jsonl");
		// 单个会话刷新失败不影响其余:不抛出,结果里记录处理过的会话数
		await expect(host.refreshModels()).resolves.toMatchObject({ sessions: 2 });
		expect(good.refreshModels).toHaveBeenCalledTimes(1);
	});

	/**
	 * 2026-10 审计 BUG-021:同一 (书, 对话) 的并发首次请求会各自 createHost 并各自
	 * SessionManager.open 同一个 writer-<id>.jsonl —— 双写会交错/覆盖。现在同 key
	 * 的创建合并成一个 Promise。
	 */
	it("同 key 并发 10 次只创建一次,所有调用拿到同一实例", async () => {
		const fake = makeFakeHost();
		const createHost = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 5)); // 拉长创建窗口,放大并发
			return fake as never;
		});
		const host = new WriterHost({ createHost: createHost as never });
		await Promise.all(Array.from({ length: 10 }, (_, i) => host.chat("fog-harbor", `m${i}`, "ch01.jsonl")));
		expect(createHost).toHaveBeenCalledTimes(1);
		expect(fake.sendMessage).toHaveBeenCalledTimes(10);
	});
	it("创建失败清掉 in-flight:下一次调用可重新创建,不在 map 里留坏 Promise", async () => {
		let attempt = 0;
		const host = new WriterHost({
			createHost: async () => {
				attempt++;
				if (attempt === 1) throw new Error("装配失败");
				return makeFakeHost() as never;
			},
		});
		await expect(host.chat("fog-harbor", "第一次", "ch01.jsonl")).rejects.toThrow("装配失败");
		await expect(host.chat("fog-harbor", "第二次", "ch01.jsonl")).resolves.toBeUndefined();
		expect(attempt).toBe(2);
	});
	it("创建中 disposeAll:迟到的创建自我释放,不写回 hosts", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const fake = makeFakeHost();
		const createHost = vi.fn(async () => {
			await gate;
			return fake as never;
		});
		const host = new WriterHost({ createHost: createHost as never });
		const pending = host.chat("fog-harbor", "hi", "ch01.jsonl");
		await host.disposeAll();
		release();
		// 迟到的创建被判废:自我释放,请求以明确错误结束(不会「释放后又登记回来」)
		await expect(pending).rejects.toThrow("会话已释放");
		expect(fake.dispose).toHaveBeenCalledTimes(1);
		expect(fake.sendMessage).not.toHaveBeenCalled();
		// 下一次请求是新世代,可正常创建
		createHost.mockImplementation(async () => makeFakeHost() as never);
		await expect(host.chat("fog-harbor", "again", "ch01.jsonl")).resolves.toBeUndefined();
		expect(createHost).toHaveBeenCalledTimes(2);
	});
	it("按书 dispose 同样判废在建创建,不误伤别的书", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const late = makeFakeHost();
		const other = makeFakeHost();
		const createHost = vi.fn(async (hostKey: string) => {
			if (hostKey.startsWith("fog-harbor:")) {
				await gate;
				return late as never;
			}
			return other as never;
		});
		const host = new WriterHost({ createHost: createHost as never });
		const pending = host.chat("fog-harbor", "hi", "ch01.jsonl");
		const safe = host.chat("sunny-bay", "hi", "ch01.jsonl");
		await host.dispose("fog-harbor");
		release();
		await expect(pending).rejects.toThrow("会话已释放");
		await expect(safe).resolves.toBeUndefined();
		expect(other.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("chatAndWait（收幕委托：发送 + 等待回合完成）", () => {
	it("回合完成 → true（sendMessage 完成即回合完成，不再订阅 settle）", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		const ok = await host.chatAndWait("fog-harbor", "【舞台转录】…请成文", "ch01.jsonl", 2000);
		expect(ok).toBe(true);
		expect(fake.sendMessage).toHaveBeenCalledWith("【舞台转录】…请成文");
	});
	it("回合超时 → false（不抛错，调用方优雅降级）", async () => {
		const fake = makeFakeHost();
		fake.sendMessage.mockImplementation(() => new Promise(() => {})); // 永不完成
		const host = new WriterHost({ createHost: async () => fake as never });
		const ok = await host.chatAndWait("fog-harbor", "成文", null, 200);
		expect(ok).toBe(false);
	});
	it("模型错误 → throw 上抛（编排器 catch 后 emit 整理失败）", async () => {
		const fake = makeFakeHost();
		fake.sendMessage.mockRejectedValue(new Error("模型调用失败"));
		const host = new WriterHost({ createHost: async () => fake as never });
		await expect(host.chatAndWait("fog-harbor", "成文", null, 2000)).rejects.toThrow("模型调用失败");
	});
	it("chapterFile 声明后记入 currentChapter（与 chat 同款）", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chatAndWait("fog-harbor", "成文", "ch03.jsonl", 2000);
		const st = await host.state("fog-harbor");
		expect(st.chapterFile).toBe("ch03.jsonl");
	});
});

describe("latestStageTranscript（最近一幕舞台转录注入，§16 编剧统一方案）", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "piw-transcript-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});
	it("无舞台数据 → null", async () => {
		expect(await latestStageTranscript(tmp)).toBeNull();
	});
	it("取 stage/ 下最新场景：统计头 + 格式化台词；旧场景不入选", async () => {
		await appendStageEntry(tmp, makeStageEntry("旧场景", 1, "a1", "李四", "旧台词"));
		await new Promise((r) => setTimeout(r, 20)); // 拉开 mtime,保证「新场景」更新
		await appendStageEntry(tmp, makeStageEntry("新场景", 1, "a2", "王五", "新台词"));
		const text = await latestStageTranscript(tmp);
		expect(text).toContain("【场景 新场景");
		expect(text).toContain("对话 1 条");
		expect(text).toContain("王五: 新台词");
		expect(text).not.toContain("旧台词");
	});
	it("长转录截断保护", async () => {
		await appendStageEntry(tmp, makeStageEntry("长场景", 1, "a1", "李四", "长".repeat(12000)));
		const text = await latestStageTranscript(tmp);
		expect(text!.length).toBeLessThanOrEqual(8500);
		expect(text).toContain("(截断)");
	});
});

describe("stableFingerprint(稳定块指纹)", () => {
	it("同内容同指纹,异内容异指纹", () => {
		expect(stableFingerprint("雾港")).toBe(stableFingerprint("雾港"));
		expect(stableFingerprint("雾港")).not.toBe(stableFingerprint("雾港2"));
	});
});

describe("syncStableContext(稳定块指纹注入,2026-08-22 缓存优化)", () => {
	it("稳定块非空:chat 前经 injectContext 持久化;内容不变不重注入;变更后重注入", async () => {
		const slug = "fog-harbor";
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		const world = await ensureWorld(bookDir);
		await saveWorld(bookDir, { ...world, worldSummary: "雾港小城,北方海岸。" });
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat(slug, "hi", "ch01.jsonl");
		expect(fake.injectContext).toHaveBeenCalledTimes(1);
		expect(String(fake.injectContext.mock.calls[0][0])).toContain("【世界观概述】");
		expect(fake.sendMessage).toHaveBeenCalledWith("hi");
		// 指纹未变:第二次对话不重注入
		await host.chat(slug, "hi again", "ch01.jsonl");
		expect(fake.injectContext).toHaveBeenCalledTimes(1);
		// 世界书内容变更:重注入新指纹
		await saveWorld(bookDir, { ...world, worldSummary: "雾港小城,南方海岸。" });
		await host.chat(slug, "third", "ch01.jsonl");
		expect(fake.injectContext).toHaveBeenCalledTimes(2);
	});
	it("稳定块为空(无世界书内容):不注入", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat("empty-book", "hi", "ch01.jsonl");
		expect(fake.injectContext).not.toHaveBeenCalled();
		expect(fake.sendMessage).toHaveBeenCalledWith("hi");
	});
});

/**
 * 注入去重(2026-10-06 分诊收口)—— **本轮重构的收益,必须有测试钉住**。
 *
 * 收口前:`world.notice` 在本会话里被注两次 —— `editorContext`(每轮易变块)
 * 与 `stableContext`(指纹稳定块)各一份;发展线同理。分诊表把它们分别归到
 * 格 B / 格 C 后,同一会话内每类内容只应出现一次。
 */
describe("注入去重(分诊收口,2026-10-06)", () => {
	/** 造一个有 Notice + 发展线 + memory 的书,供去重断言使用。 */
	async function seedRichBook(slug: string): Promise<void> {
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		const world = await ensureWorld(bookDir);
		await saveWorld(bookDir, {
			...world,
			worldSummary: "雾港小城,北方海岸。",
			notice: { enabled: true, items: [{ id: "n1", text: "第三卷回收信物伏笔", done: false }] },
			storyline: {
				...world.storyline,
				enabled: true,
				nodes: [{ id: "s1", title: "查明白塔来历", status: "in-progress", goal: "找档案", next: "夜探" }],
			},
		});
		await writeFile(join(bookDir, "memory.md"), "- 主角的剑叫「婉姐的剑」", "utf8");
	}

	it("Notice 只进稳定块(格 B),不再进每轮易变块 —— 同一会话内只出现一次", async () => {
		const slug = "fog-harbor";
		await seedRichBook(slug);
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		// 每轮易变块经 context 钩子产出的消息:捕获它,才能数 Notice 出现在哪
		const seen: string[] = [];
		host.setEventSink(() => {});
		await host.chat(slug, "hi", "ch01.jsonl");

		// 稳定块(格 B)必须带 Notice
		const stable = String(fake.injectContext.mock.calls[0][0]);
		expect(stable).toContain("【Notice·备忘录】");
		expect(stable).toContain("第三卷回收信物伏笔");
		// 稳定块**不带**发展线(那是格 C 的)
		expect(stable).not.toContain("【发展线】");
		seen.push(stable);

		// 断言总量:整条会话装配里 Notice 标题只出现一次
		expect(seen.join("\n").match(/【Notice·备忘录】/g)?.length).toBe(1);
	});

	it("发展线只进每轮易变块(格 C),不进稳定块 —— 否则每轮击穿指纹", async () => {
		const slug = "fog-harbor2";
		await seedRichBook(slug);
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat(slug, "hi", "ch01.jsonl");
		const stable = String(fake.injectContext.mock.calls[0][0]);
		expect(stable).not.toContain("【发展线】");
	});

	it("世界观概述只进稳定块(格 B)", async () => {
		const slug = "fog-harbor3";
		await seedRichBook(slug);
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		await host.chat(slug, "hi", "ch01.jsonl");
		const stable = String(fake.injectContext.mock.calls[0][0]);
		expect(stable).toContain("【世界观概述】");
	});
});

describe("setShell(shell 方言,2026-09-18)", () => {
	it("变化时释放已建会话(下次对话按新装配重建);无变化为 no-op", async () => {
		const fake = makeFakeHost();
		const fake2 = makeFakeHost();
		const createHost = vi.fn(async () => (createHost.mock.calls.length === 1 ? fake : fake2) as never);
		const host = new WriterHost({ createHost, shellDialect: "bash", shellPath: null });
		await host.chat("shell-book", "hi", "ch01.jsonl");
		expect(createHost).toHaveBeenCalledTimes(1);
		// 无变化:不该释放(否则每次 PUT 都白扔会话)
		await host.setShell({ enabled: false, dialect: "bash", path: null });
		expect(fake.dispose).not.toHaveBeenCalled();
		expect(createHost).toHaveBeenCalledTimes(1);
		// 换成 pwsh:释放已建会话;下次对话用新装配重建
		await host.setShell({ enabled: true, dialect: "pwsh", path: "C:\\pwsh.exe" });
		expect(fake.dispose).toHaveBeenCalledTimes(1);
		await host.chat("shell-book", "hi again", "ch01.jsonl");
		expect(createHost).toHaveBeenCalledTimes(2);
		// 同一个会话键复用新宿主;仅路径变化也释放(换了可执行文件 = 换了 shell)
		await host.chat("shell-book", "hi third", "ch01.jsonl");
		expect(createHost).toHaveBeenCalledTimes(2);
		await host.setShell({ enabled: true, dialect: "pwsh", path: "D:\\pwsh.exe" });
		expect(fake2.dispose).toHaveBeenCalledTimes(1);
	});

	it("编剧(固定角色提示)在放开 shell 后追加方言行,未放开时不追加", () => {
		const shellOff = new WriterHost({ createHost: async () => makeFakeHost() as never });
		const off = (shellOff as unknown as { editorSystemPrompt(): string }).editorSystemPrompt();
		expect(off).not.toContain("外部命令");

		const shellOn = new WriterHost({ createHost: async () => makeFakeHost() as never, enableShell: true, shellDialect: "pwsh" });
		const on = (shellOn as unknown as { editorSystemPrompt(): string }).editorSystemPrompt();
		expect(on).toContain("# 外部命令");
		expect(on).toContain("PowerShell 7(pwsh)");
	});
});

/** 自定义系统提示词(2026-10-10):非空整段替换内置;空 = 用内置。 */
describe("setCustomPrompt(自定义系统提示词,2026-10-10)", () => {
	it("变化时释放已建会话(下次对话按新提示词装配);无变化为 no-op", async () => {
		const fake = makeFakeHost();
		const fake2 = makeFakeHost();
		const createHost = vi.fn(async () => (createHost.mock.calls.length === 1 ? fake : fake2) as never);
		const host = new WriterHost({ createHost });
		await host.chat("prompt-book", "hi", "ch01.jsonl");
		expect(createHost).toHaveBeenCalledTimes(1);
		// 无变化:两份都没动 → 不释放
		await host.setCustomPrompt({ writer: "", editor: "" });
		expect(fake.dispose).not.toHaveBeenCalled();
		expect(createHost).toHaveBeenCalledTimes(1);
		// 设了主提示词:释放已建会话;下次对话用新装配重建
		await host.setCustomPrompt({ writer: "自定义主提示词", editor: "" });
		expect(fake.dispose).toHaveBeenCalledTimes(1);
		await host.chat("prompt-book", "hi again", "ch01.jsonl");
		expect(createHost).toHaveBeenCalledTimes(2);
		// 只改编剧那份同样释放(两份各自独立,任一变都换装配)
		await host.setCustomPrompt({ writer: "自定义主提示词", editor: "自定义编剧" });
		expect(fake2.dispose).toHaveBeenCalledTimes(1);
	});

	it("主写作 agent 侧:非空整段替换内置提示词(内置文本不再出现)", () => {
		const plain = new WriterHost({ createHost: async () => makeFakeHost() as never, classicMode: true });
		const builtin = (plain as unknown as { customWriterPrompt: string }).customWriterPrompt;
		expect(builtin).toBe("");

		const custom = new WriterHost({
			createHost: async () => makeFakeHost() as never,
			classicMode: true,
			customWriterPrompt: "只写正文的自定义提示词",
		});
		expect((custom as unknown as { customWriterPrompt: string }).customWriterPrompt).toBe("只写正文的自定义提示词");
	});

	it("编剧侧:非空整段替换,且不再追加 shell 方言行", () => {
		const builtinHost = new WriterHost({ createHost: async () => makeFakeHost() as never, enableShell: true, shellDialect: "pwsh" });
		const builtin = (builtinHost as unknown as { editorSystemPrompt(s: string): string }).editorSystemPrompt("chapter");
		expect(builtin).toContain("# 外部命令");
		expect(builtin).toContain("PowerShell 7(pwsh)");

		const customHost = new WriterHost({
			createHost: async () => makeFakeHost() as never,
			enableShell: true,
			shellDialect: "pwsh",
			customEditorPrompt: "你是编剧,只按指令改正文。",
		});
		const custom = (customHost as unknown as { editorSystemPrompt(s: string): string }).editorSystemPrompt("chapter");
		expect(custom).toBe("你是编剧,只按指令改正文。");
		// 自定义稿里不插我们的 shell 文案
		expect(custom).not.toContain("# 外部命令");
	});
});

/**
 * 权限边界唯一真相源:`writerToolset`(2026-10-01 从 roleFactory 内联里抽出来)。
 *
 * 抽出来就是为了能被单测钉住——此前这段清单埋在一个几百行的私有工厂里,
 * 「编剧该有哪些工具」这件事没有任何测试看守。舞台形态下编剧**不能**有
 * world_update(人物/关系/时间线归导演),但**必须**有 style_update
 * (否则用户在编辑页说「以后别用破折号」只会得到一句口头答应)。
 */
describe("writerToolset（编剧 / 写作 agent 的权限边界）", () => {
	const names = (t: ReturnType<typeof writerToolset>): string[] => t.map((x) => x.name).sort();

	it("舞台形态的编剧:有只读 world_find 与窄通道 style_update,没有 world_update", () => {
		const n = names(writerToolset({ classicMode: false, mcpTools: [] }));
		expect(n).toContain("world_find");
		expect(n).toContain("style_update");
		expect(n).not.toContain("world_update");
	});

	it("经典模式的写作 agent:升到全量(world_update),不再需要窄通道", () => {
		const n = names(writerToolset({ classicMode: true, mcpTools: [] }));
		expect(n).toContain("world_update");
		expect(n).not.toContain("style_update");
	});

	it("MCP 工具两种形态都带上", () => {
		const mcp = [{ name: "mcp_echo" }] as never;
		expect(names(writerToolset({ classicMode: false, mcpTools: mcp }))).toContain("mcp_echo");
		expect(names(writerToolset({ classicMode: true, mcpTools: mcp }))).toContain("mcp_echo");
	});

	// read_chapter 是只读的,不触碰世界书/人物/关系,因此不破坏上面那条边界;
	// 但编剧写剧本、审校必须能读到整章(内置 read 会在 2000 行/50KB 处静默截断)。
	it("read_chapter 两种形态都给(只读,不越界)", () => {
		expect(names(writerToolset({ classicMode: false, mcpTools: [] }))).toContain("read_chapter");
		expect(names(writerToolset({ classicMode: true, mcpTools: [] }))).toContain("read_chapter");
	});
});

/**
 * 提示词的对话范围判据(2026-10-03):分离模式下同一个 WriterHost 里既有自由对话
 * (不绑章节)也有收幕成文(按章节键建宿主),系统提示不能共用一套措辞。
 */
describe("hostPromptScope（该按哪一套对话范围叙述提示词）", () => {
	it("绑定章节模式:章节键与兜底键都按绑定章节叙述", () => {
		expect(hostPromptScope("chapter", "ch01.jsonl")).toBe("chapter");
		expect(hostPromptScope("chapter", "default")).toBe("chapter");
	});

	it("分离模式:自由对话(不透明 id / default)按分离叙述", () => {
		expect(hostPromptScope("book", "c-abc123")).toBe("book");
		expect(hostPromptScope("book", "default")).toBe("book");
	});

	it("分离模式:收幕成文按章节键建宿主,仍按绑定章节叙述", () => {
		// chatAndWait 永远按章节键取宿主(收幕成文天然要落某一章正文)——
		// 若这里判成 book,提示词会告诉它「正文不锁在某一章」
		expect(hostPromptScope("book", "ch04.jsonl")).toBe("chapter");
	});

	it("章节模式里遗留的自由对话 id(book→chapter 切回):按分离叙述,不再谎称绑章", () => {
		expect(hostPromptScope("chapter", "c-abc123")).toBe("book");
	});
});

/**
 * resolveRef 的「章节语义」形态校验(2026-10-05)。
 *
 * `resolveRef` 返回的 `chapter` 决定 editorContext 注入哪份正文(拼成
 * `draft/<chapter>.md`)。**只有章节文件名形态(`<id>.jsonl`)才认** —— 否则不透明
 * 对话 id(`c-xxxxxx` / `default`)会被当成章节名,拼出 `draft/c-abc123.md`,
 * editorContext 走 else 分支把这个不存在的路径当「约定落点」教给模型。
 *
 * 两个模式**必须同一条判据** —— 分开写就是「切一次模式就换一种行为」。
 */
describe("resolveRef（章节语义的形态校验，两模式同一条判据）", () => {
	/** private 方法:JS 运行时无访问限制,按仓库既有约定直接原型调用。 */
	function makeResolver(scope: "chapter" | "book") {
		const host = Object.create(WriterHost.prototype) as never as {
			conversationScope: string;
			currentConversation: Map<string, string>;
			viewChapter: Map<string, string | null>;
			currentChapter: Map<string, string>;
			resolveRef(slug: string, chapterFile?: string | null, conversation?: string | null, record?: boolean): {
				key: string;
				chapter: string | null;
			};
		};
		host.conversationScope = scope;
		host.currentConversation = new Map();
		host.viewChapter = new Map();
		host.currentChapter = new Map();
		return host;
	}

	it("chapter 模式:章节文件名认,不透明 id 不认(既有一致性)", () => {
		const h = makeResolver("chapter");
		expect(h.resolveRef("b", "ch01.jsonl", null).chapter).toBe("ch01.jsonl");
		expect(h.resolveRef("b", null, "c-abc123").chapter).toBe(null);
	});

	it("book 模式:chapterFile 是章节文件名才提正文,不透明 id 不提", () => {
		const h = makeResolver("book");
		// 「正在看的章节」是章节名 —— 提这一章正文
		expect(h.resolveRef("b", "ch01.jsonl", null).chapter).toBe("ch01.jsonl");
		// 前端把对话 id 误当 chapterFile 传(或书里存了个不透明 id):不许拼成
		// draft/c-abc123.md —— 那会走「尚未创建,请写入此路径」分支,把模型引到
		// 一个前端永远读不到的落点
		expect(h.resolveRef("b", "c-abc123", null).chapter).toBe(null);
		// 不传 chapterFile(只声明对话身份):同样不提正文
		expect(h.resolveRef("b", undefined, "c-abc123").chapter).toBe(null);
		// 显式 null(用户没在看任何章节):不提正文
		expect(h.resolveRef("b", null, null).chapter).toBe(null);
	});

	it("book 模式:身份仍是不透明对话 id(形态校验只作用于 chapter)", () => {
		const h = makeResolver("book");
		expect(h.resolveRef("b", "c-abc123", null).key).toBe("default");
		expect(h.resolveRef("b", undefined, "c-abc123").key).toBe("c-abc123");
	});
});
