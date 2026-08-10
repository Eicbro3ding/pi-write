/**
 * edit-capture 共享捕获器单测:工具 start 抓 before、end 组装 diff。
 * 注入 fake client(纯内存 world/draft),不碰真实 provider。
 */
import { describe, expect, it } from "vitest";
import { createEditCapture } from "../web/src/edit-capture.ts";
import type { WorldDataDto } from "../web/src/types.ts";

/** 内存版 world(带版本号变化模拟编辑)。 */
function makeWorld(titles: string[]): WorldDataDto {
	return {
		version: 1,
		entries: titles.map((title, i) => ({
			id: `e${i}`,
			title,
			type: "character",
			body: "",
			status: "normal",
			tags: [],
			keys: [],
			createdAt: 0,
			updatedAt: 0,
			active: true,
		})),
		relations: [],
	};
}

function makeClient() {
	let world = makeWorld([]);
	const drafts = new Map<string, string>();
	return {
		world,
		setWorld(w: WorldDataDto) {
			world = w;
		},
		drafts,
		client: {
			async getWorld() {
				return { world };
			},
			async getDraft(path: string) {
				return { text: drafts.get(path) ?? "" };
			},
		} as never,
	};
}

describe("createEditCapture", () => {
	it("world_update:start 抓 before,end 组装关系图/词条预览", async () => {
		const m = makeClient();
		const capture = createEditCapture(m.client as never, () => "book-1");
		// start:世界书为空(编辑前)
		expect(capture.handleStart("t1", "world_update", {})).toBe("world");
		// 工具执行:加入条目
		m.setWorld(makeWorld(["阿澈"]));
		const edit = await capture.handleEnd("t1", false);
		expect(edit).not.toBeNull();
		expect(edit!.kind).toBe("world");
		expect(edit!.before).toEqual(makeWorld([]));
		expect(edit!.data).toMatchObject({ kind: "world", mode: "graph" });
	});

	it("write 编辑 draft:组装草稿 diff,sections 含路径与 diff", async () => {
		const m = makeClient();
		m.drafts.set("draft/ch01.md", "灯塔亮了三夜。\n");
		const capture = createEditCapture(m.client as never, () => null);
		expect(capture.handleStart("t2", "write", { path: "draft/ch01.md" })).toBe("draft");
		m.drafts.set("draft/ch01.md", "灯塔亮穿雾,三夜。\n");
		const edit = await capture.handleEnd("t2", false);
		expect(edit).not.toBeNull();
		expect(edit!.kind).toBe("draft");
		expect(edit!.path).toBe("draft/ch01.md");
		expect(edit!.before).toBe("灯塔亮了三夜。\n");
		expect(edit!.data).toMatchObject({ kind: "draft", sections: [{ path: "draft/ch01.md" }] });
	});

	it("非编辑工具(start 返回 null,end 返回 null)", async () => {
		const m = makeClient();
		const capture = createEditCapture(m.client as never, () => null);
		expect(capture.handleStart("t3", "read", { path: "draft/ch01.md" })).toBeNull();
		expect(await capture.handleEnd("t3", false)).toBeNull();
	});

	it("无实质变化(内容相同)不弹卡", async () => {
		const m = makeClient();
		m.drafts.set("draft/ch01.md", "不变的内容");
		const capture = createEditCapture(m.client as never, () => null);
		capture.handleStart("t4", "write", { path: "draft/ch01.md" });
		// 内容未变
		const edit = await capture.handleEnd("t4", false);
		expect(edit).toBeNull();
	});

	it("失败(end isError)与重复 end 均不弹卡", async () => {
		const m = makeClient();
		m.drafts.set("draft/ch01.md", "旧");
		const capture = createEditCapture(m.client as never, () => null);
		capture.handleStart("t5", "write", { path: "draft/ch01.md" });
		expect(await capture.handleEnd("t5", true)).toBeNull();
		// 重复 end(SSE 重放):已处理,忽略
		expect(await capture.handleEnd("t5", false)).toBeNull();
	});

	it("clear 后旧配对不再组装", async () => {
		const m = makeClient();
		m.drafts.set("draft/ch01.md", "旧");
		const capture = createEditCapture(m.client as never, () => null);
		capture.handleStart("t6", "write", { path: "draft/ch01.md" });
		capture.clear();
		expect(await capture.handleEnd("t6", false)).toBeNull();
	});
});
