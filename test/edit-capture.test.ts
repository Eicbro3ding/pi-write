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
	const memories = new Map<string, string>();
	return {
		world,
		setWorld(w: WorldDataDto) {
			world = w;
		},
		drafts,
		memories,
		client: {
			async getWorld() {
				return { world };
			},
			async getDraft(path: string) {
				return { text: drafts.get(path) ?? "" };
			},
			async getMemory(target: "memory" | "user") {
				return { text: memories.get(target) ?? "" };
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

	it("draft 取数携带发起回合的书 slug(切书后不按新书读旧草稿)", async () => {
		const drafts = new Map<string, string>([["draft/ch01.md", "旧文"]]);
		const calls: Array<[string, string | undefined]> = [];
		const client = {
			async getWorld() {
				return { world: makeWorld([]) };
			},
			async getDraft(path: string, slug?: string) {
				calls.push([path, slug]);
				return { text: drafts.get(path) ?? "" };
			},
		} as never;
		const capture = createEditCapture(client, () => "book-1");
		capture.handleStart("t7", "write", { path: "draft/ch01.md" });
		drafts.set("draft/ch01.md", "新文");
		const edit = await capture.handleEnd("t7", false);
		expect(edit).not.toBeNull();
		// start 兜底取数与 end 的 after 取数都带发起回合的 slug
		expect(calls.length).toBe(2);
		expect(calls.every(([, slug]) => slug === "book-1")).toBe(true);
		expect(edit!.before).toBe("旧文");
	});

	it("prefetchBaseline 的草稿取数携带书 slug", async () => {
		const calls: Array<[string, string | undefined]> = [];
		const client = {
			async getWorld() {
				return { world: makeWorld([]) };
			},
			async getDraft(path: string, slug?: string) {
				calls.push([path, slug]);
				return { text: "基线" };
			},
			async getMemory() {
				return { text: "" };
			},
		} as never;
		const capture = createEditCapture(client, () => null);
		capture.prefetchBaseline("draft/ch01.md", "book-9");
		await capture.handleStart("t8", "write", { path: "draft/ch01.md" });
		expect(calls).toEqual([["draft/ch01.md", "book-9"]]);
	});

	it("memory 写本书记忆:条目级 diff 与展示路径", async () => {
		const m = makeClient();
		m.memories.set("memory", "阿澈怕水。\n");
		const capture = createEditCapture(m.client as never, () => "book-1");
		// start:记忆还是旧的一行
		expect(capture.handleStart("m1", "memory", { target: "memory", action: "add", content: "阿澈左手有疤。" })).toBe("memory");
		m.memories.set("memory", "阿澈怕水。\n阿澈左手有疤。\n");
		const edit = await capture.handleEnd("m1", false);
		expect(edit).not.toBeNull();
		expect(edit!.kind).toBe("memory");
		expect(edit!.memoryTarget).toBe("memory");
		expect(edit!.before).toBe("阿澈怕水。\n");
		expect(edit!.data).toMatchObject({ kind: "memory", target: "memory", path: "memory.md" });
		const diff = (edit!.data as { diff: Array<{ kind: string; text: string }> }).diff;
		expect(diff.some((l) => l.kind === "add" && l.text.includes("左手有疤"))).toBe(true);
	});

	it("memory 写作者画像:target=user 走书外路径,缺省目标按 memory 算", async () => {
		const m = makeClient();
		const capture = createEditCapture(m.client as never, () => "book-1");
		expect(capture.handleStart("m2", "memory", { target: "user", action: "add", content: "作者偏好电报体。" })).toBe("memory");
		m.memories.set("user", "作者偏好电报体。\n");
		const edit = await capture.handleEnd("m2", false);
		expect(edit).not.toBeNull();
		expect(edit!.memoryTarget).toBe("user");
		expect(edit!.data).toMatchObject({ kind: "memory", target: "user", path: "~/.pi/writer/user.md" });

		// 缺 target:默认本书记忆(与工具参数的缺省语义一致)
		expect(capture.handleStart("m3", "memory", { action: "add", content: "x" })).toBe("memory");
		m.memories.set("memory", "x\n");
		const edit2 = await capture.handleEnd("m3", false);
		expect(edit2!.memoryTarget).toBe("memory");
	});

	it("memory 没有实质变化(超预算被拒)→ 不出卡", async () => {
		const m = makeClient();
		m.memories.set("memory", "原样。\n");
		const capture = createEditCapture(m.client as never, () => "book-1");
		capture.handleStart("m4", "memory", { action: "add", content: "写不进去" });
		const edit = await capture.handleEnd("m4", false);
		expect(edit).toBeNull();
	});
});
