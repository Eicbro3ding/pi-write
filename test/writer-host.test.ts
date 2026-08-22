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
import { latestStageTranscript, stableFingerprint, WriterHost } from "../src/web/writer-host.ts";

interface FakeHostLike {
	subscribe(l: (e: unknown) => void): () => void;
	sendMessage: ReturnType<typeof vi.fn>;
	injectContext: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
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
