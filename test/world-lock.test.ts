import { describe, expect, it } from "vitest";
import { withWorldLock } from "../src/world-lock.ts";

describe("withWorldLock", () => {
	it("同一 key 的任务串行执行(前一个完成后才开始下一个)", async () => {
		const order: string[] = [];
		const task = (id: string, ms: number) =>
			withWorldLock("book", async () => {
				order.push(id);
				await new Promise((r) => setTimeout(r, ms));
			});
		await Promise.all([task("a", 30), task("b", 10), task("c", 20)]);
		expect(order).toEqual(["a", "b", "c"]);
	});
	it("前一任务失败不阻塞后续任务", async () => {
		const order: string[] = [];
		await Promise.all([
			withWorldLock("book", async () => {
				order.push("a");
				throw new Error("boom");
			}).catch(() => {}),
			withWorldLock("book", async () => {
				order.push("b");
			}),
		]);
		expect(order).toEqual(["a", "b"]);
	});
});
