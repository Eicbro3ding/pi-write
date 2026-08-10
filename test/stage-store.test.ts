import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendStageEntry, lastStage, makeStageEntry, readStage, truncateStage } from "../src/stage/stage-store.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-stage-test-"));
	vi.stubEnv("PI_WRITER_DIR", tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("stage-store", () => {
	it("append/read 往返一致且按行追加", async () => {
		const e1 = makeStageEntry("s1", 1, "actor-1", "李四", "三年了，你还活着。");
		const e2 = makeStageEntry("s1", 2, "actor-3", "叙述者", "（烛火晃了一下。）");
		await appendStageEntry(tmp, e1);
		await appendStageEntry(tmp, e2);
		const entries = await readStage(tmp, "s1");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual(e1);
		expect(entries[1]).toEqual(e2);
	});

	it("不同场景隔离", async () => {
		await appendStageEntry(tmp, makeStageEntry("s1", 1, "actor-1", "李四", "你好"));
		expect(await readStage(tmp, "s2")).toEqual([]);
	});

	it("不存在时返回空数组", async () => {
		expect(await readStage(tmp, "ghost")).toEqual([]);
	});

	it("坏行被跳过", async () => {
		await appendStageEntry(tmp, makeStageEntry("s1", 1, "actor-1", "李四", "好"));
		const { appendFile } = await import("node:fs/promises");
		await appendFile(join(tmp, "stage", "s1.jsonl"), "not-json\n", "utf8");
		expect(await readStage(tmp, "s1")).toHaveLength(1);
	});
});

describe("truncateStage（精准重演，§10.5）", () => {
	it("截断到前 keepCount 条，保留的条目原样", async () => {
		const e1 = makeStageEntry("s1", 1, "actor-1", "李四", "第一条");
		const e2 = makeStageEntry("s1", 2, "actor-2", "王五", "第二条");
		const e3 = makeStageEntry("s1", 3, "actor-1", "李四", "第三条");
		await appendStageEntry(tmp, e1);
		await appendStageEntry(tmp, e2);
		await appendStageEntry(tmp, e3);
		await truncateStage(tmp, "s1", 2);
		const entries = await readStage(tmp, "s1");
		expect(entries).toEqual([e1, e2]);
	});

	it("keepCount 为 0 清空转录", async () => {
		await appendStageEntry(tmp, makeStageEntry("s1", 1, "actor-1", "李四", "x"));
		await truncateStage(tmp, "s1", 0);
		expect(await readStage(tmp, "s1")).toEqual([]);
	});
});

describe("makeStageEntry / lastStage", () => {
	it("makeStageEntry 生成唯一 id 与字段", () => {
		const a = makeStageEntry("s1", 7, "actor-1", "李四", "话");
		const b = makeStageEntry("s1", 7, "actor-1", "李四", "话");
		expect(a.id).not.toBe(b.id);
		expect(a.character).toBe("李四");
		expect(a.content).toEqual([{ type: "text", text: "话" }]);
	});

	it("lastStage 取尾部切片", () => {
		const all = [1, 2, 3, 4, 5].map((i) => makeStageEntry("s1", i, "a", "b", String(i)));
		expect(lastStage(all, 2).map((e) => e.turn)).toEqual([4, 5]);
		expect(lastStage(all, 0)).toEqual([]);
		expect(lastStage(all, 99)).toEqual(all);
	});
});
