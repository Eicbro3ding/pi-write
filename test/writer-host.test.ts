/**
 * WriterHost(常驻编剧)单测:createHost 注入假会话,验证惰性创建/事件转发/
 * 状态/中止/释放,不碰真实 provider(与 session-host.test.ts 同模式,fake 边界
 * 用仓库既有的 as never 约定)。
 */
import { describe, expect, it, vi } from "vitest";
import { WriterHost } from "../src/web/writer-host.ts";

interface FakeHostLike {
	subscribe(l: (e: unknown) => void): () => void;
	sendMessage: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	getState(): { isStreaming: boolean; messages: Array<{ role: string; text: string }> };
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
		abort: vi.fn(async () => {}),
		getState: () => ({ isStreaming: false, messages: [{ role: "assistant", text: "嗨" }] }),
		dispose: vi.fn(async () => {}),
	};
}

describe("WriterHost", () => {
	it("state 纯读不创建会话(未对话过的书返回空态)", async () => {
		const createHost = vi.fn(async () => makeFakeHost() as never);
		const host = new WriterHost({ createHost: createHost as never });
		const st = await host.state("fog-harbor");
		expect(st).toEqual({ bookSlug: "fog-harbor", chapterFile: null, exists: false, isStreaming: false, messages: [] });
		expect(createHost).not.toHaveBeenCalled();
	});
	it("chat 惰性创建会话、转发消息、事件经 eventSink 流出", async () => {
		const fake = makeFakeHost();
		const host = new WriterHost({ createHost: async () => fake as never });
		const seen: unknown[] = [];
		host.setEventSink((slug, event) => seen.push({ slug, event }));
		await host.chat("fog-harbor", "把结尾改含蓄点", "ch01.jsonl");
		expect(fake.sendMessage).toHaveBeenCalledWith("把结尾改含蓄点");
		// 模拟会话事件扇出:订阅在 chat 建会话时已挂上
		for (const l of fake.listeners) l({ type: "turn_start" });
		expect(seen).toEqual([{ slug: "fog-harbor", event: { type: "turn_start" } }]);
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
