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
import { latestStageTranscript, stableFingerprint, WriterHost, writerToolset } from "../src/web/writer-host.ts";

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
		await expect(host.refreshModels()).resolves.toBeUndefined();
		expect(good.refreshModels).toHaveBeenCalledTimes(1);
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
		expect(n).not.toContain("word_count");
	});

	it("经典模式的写作 agent:升到全量(world_update + word_count),不再需要窄通道", () => {
		const n = names(writerToolset({ classicMode: true, mcpTools: [] }));
		expect(n).toContain("world_update");
		expect(n).toContain("word_count");
		expect(n).not.toContain("style_update");
	});

	it("MCP 工具两种形态都带上", () => {
		const mcp = [{ name: "mcp_echo" }] as never;
		expect(names(writerToolset({ classicMode: false, mcpTools: mcp }))).toContain("mcp_echo");
		expect(names(writerToolset({ classicMode: true, mcpTools: mcp }))).toContain("mcp_echo");
	});
});
