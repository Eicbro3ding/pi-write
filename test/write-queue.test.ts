/**
 * 进程内配置写队列(src/write-queue.ts)。
 *
 * 2026-10 审计 BUG-011 / BUG-020:models.json 与 mcp.json 的读-改-写必须串行,
 * 否则并发请求各自用旧快照写回会静默丢配置。这里只测队列本身的语义
 * (串行、失败不掐断、按 key 隔离),文件层的并发行为在 server.test.ts 验证。
 */
import { describe, expect, it } from "vitest";
import { WriteQueue } from "../src/write-queue.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WriteQueue", () => {
	it("同一 key 严格按调用顺序串行执行(不交错)", async () => {
		const q = new WriteQueue();
		const log: string[] = [];
		const task = (name: string) => async () => {
			log.push(`${name}:start`);
			await tick();
			await tick();
			log.push(`${name}:end`);
			return name;
		};
		const [a, b, c] = await Promise.all([q.run("k", task("a")), q.run("k", task("b")), q.run("k", task("c"))]);
		expect([a, b, c]).toEqual(["a", "b", "c"]);
		expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
	});

	it("前一个任务失败不掐断队列,后续任务照常执行且各自拿到自己的结果/错误", async () => {
		const q = new WriteQueue();
		const first = q.run("k", async () => {
			throw new Error("boom");
		});
		const second = q.run("k", async () => "ok");
		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toBe("ok");
	});

	it("不同 key 互不阻塞(并发执行)", async () => {
		const q = new WriteQueue();
		let releaseA: () => void = () => {};
		const gateA = new Promise<void>((r) => (releaseA = r));
		const a = q.run("a", async () => {
			await gateA;
			return "a";
		});
		// b 不等 a:没有 gateA 也应该能完成
		await expect(q.run("b", async () => "b")).resolves.toBe("b");
		releaseA();
		await expect(a).resolves.toBe("a");
	});

	it("同步抛错的任务同样被隔离在队列里", async () => {
		const q = new WriteQueue();
		const bad = q.run("k", () => {
			throw new Error("sync-boom");
		});
		await expect(bad).rejects.toThrow("sync-boom");
		await expect(q.run("k", () => 42)).resolves.toBe(42);
	});

	it("队列排空后不残留 key(长期运行不累积)", async () => {
		const q = new WriteQueue();
		await q.run("k", () => 1);
		await tick();
		expect(q.pendingKeys()).toBe(0);
	});
});
