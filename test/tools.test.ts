import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWorldUpdate, setWordCountCwd, setWorldUpdateBookDir, wordCountTool, worldFindTool } from "../src/tools.ts";
import { createEmptyWorld, WorldValidationError } from "../src/world-data.ts";

type ToolParams = Parameters<typeof wordCountTool.execute>[1];
type ToolContext = Parameters<typeof wordCountTool.execute>[4];

function runTool(params: ToolParams): ReturnType<typeof wordCountTool.execute> {
	return wordCountTool.execute("call", params, undefined, undefined, {} as ToolContext);
}

function resultText(result: Awaited<ReturnType<typeof wordCountTool.execute>>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-writer-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("wordCountTool", () => {
	it("counts CJK chars, words, sentences, and paragraphs", async () => {
		const file = join(tmp, "draft.md");
		writeFileSync(file, "第一章。\n\nHello world\n\n第二段。\n", "utf-8");

		const result = await runTool({ path: file });
		const text = resultText(result);
		expect(text).toContain("cn_chars: 6");
		expect(text).toContain("en_words: 2");
		expect(text).toContain("sentences: 2");
		expect(text).toContain("paragraphs: 3");
	});

	it("walks directories for markdown files and reports totals", async () => {
		writeFileSync(join(tmp, "a.md"), "甲。", "utf-8");
		writeFileSync(join(tmp, "b.md"), "乙。", "utf-8");
		writeFileSync(join(tmp, "notes.txt"), "ignored", "utf-8");

		const result = await runTool({ path: tmp });
		const text = resultText(result);
		expect(text).toContain("Files: 2");
		expect(text).toContain("Total:");
		expect(text).toContain("cn_chars: 2");
	});

	it("reports delta against a target", async () => {
		const file = join(tmp, "draft.md");
		writeFileSync(file, "第一章。", "utf-8");

		const result = await runTool({ path: file, target: 100 });
		const text = resultText(result);
		expect(text).toContain("Target 100 cn_chars: -97 (3%)");
	});

	it("throws for missing paths", async () => {
		await expect(runTool({ path: join(tmp, "nope.md") })).rejects.toThrow("Path not found");
	});

	it("resolves relative paths against the injected cwd(会话书目录)", async () => {
		writeFileSync(join(tmp, "draft.md"), "第一章。", "utf-8");
		setWordCountCwd(tmp);
		try {
			const result = await runTool({ path: "draft.md" });
			expect(resultText(result)).toContain("cn_chars: 3");
		} finally {
			setWordCountCwd(null);
		}
	});

	it("未注入 cwd 时回退 process.cwd()(绝对路径仍解析)", async () => {
		// 与既有行为一致:绝对路径不受影响;未注入时相对路径按进程 cwd 解析
		setWordCountCwd(null);
		const file = join(tmp, "draft.md");
		writeFileSync(file, "甲。", "utf-8");
		const result = await runTool({ path: file });
		expect(resultText(result)).toContain("cn_chars: 1");
	});

	it("拒绝书目录外的路径(../ 上溯与绝对路径逃逸)", async () => {
		// 路径守卫:word_count 只能统计书目录内的文件,防越界探测 auth.json 等敏感文件
		const bookDir = join(tmp, "book");
		mkdirSync(bookDir, { recursive: true });
		writeFileSync(join(tmp, "secret.json"), "sk-xxxx", "utf-8");
		setWordCountCwd(bookDir);
		try {
			await expect(runTool({ path: "../secret.json" })).rejects.toThrow("工具路径越界");
			await expect(runTool({ path: join(tmp, "secret.json") })).rejects.toThrow("工具路径越界");
		} finally {
			setWordCountCwd(null);
		}
	});
});

describe("applyWorldUpdate", () => {
	it("upsert_entry 新建条目", () => {
		const w = createEmptyWorld();
		const next = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉", body: "姐姐" });
		expect(next.entries).toHaveLength(1);
		expect(next.entries[0]!.title).toBe("林婉");
		expect(next.entries[0]!.keys).toEqual([]);
	});
	it("upsert_entry 更新既有条目(按 id)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉" });
		const id = a.entries[0]!.id;
		const b = applyWorldUpdate(a, { op: "upsert_entry", id, type: "character", title: "林婉", keys: ["婉姐"], body: "新正文" });
		expect(b.entries).toHaveLength(1);
		expect(b.entries[0]!.body).toBe("新正文");
		expect(b.entries[0]!.keys).toEqual(["婉姐"]);
	});
	it("upsert_entry 带 id 且条目不存在 → 按该 id 创建(真 upsert)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", id: "entry-manual-01", type: "world", title: "雾港", body: "海雾之城" });
		expect(a.entries).toHaveLength(1);
		expect(a.entries[0]!.id).toBe("entry-manual-01");
		expect(a.entries[0]!.title).toBe("雾港");
		expect(a.entries[0]!.body).toBe("海雾之城");
	});
	it("upsert_entry 不带 id → 按 (type, title) 匹配既有条目并更新(保留原 id)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉", body: "初版" });
		const id = a.entries[0]!.id;
		// 同 type 同 title:命中既有条目,不新建
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "林婉", body: "修订版" });
		expect(b.entries).toHaveLength(1);
		expect(b.entries[0]!.id).toBe(id);
		expect(b.entries[0]!.body).toBe("修订版");
		// 同 title 不同 type:不匹配,新建
		const c = applyWorldUpdate(b, { op: "upsert_entry", type: "world", title: "林婉", body: "同名世界" });
		expect(c.entries).toHaveLength(2);
	});
	it("delete_entry 删除条目", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉" });
		const id = a.entries[0]!.id;
		const b = applyWorldUpdate(a, { op: "delete_entry", id });
		expect(b.entries).toHaveLength(0);
	});
	it("delete_entry 拒绝删除被关系引用的条目", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "A" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "B" });
		const [ida, idb] = [a.entries[0]!.id, b.entries[1]!.id];
		const c = applyWorldUpdate(b, { op: "upsert_relation", from: ida, to: idb, label: "姐弟" });
		expect(() => applyWorldUpdate(c, { op: "delete_entry", id: ida })).toThrow(WorldValidationError);
	});
	it("upsert_relation 拒绝悬空引用与自环", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "A" });
		expect(() => applyWorldUpdate(a, { op: "upsert_relation", from: "x", to: "y", label: "??" })).toThrow(WorldValidationError);
		const id = a.entries[0]!.id;
		expect(() => applyWorldUpdate(a, { op: "upsert_relation", from: id, to: id, label: "自" })).toThrow(WorldValidationError);
	});
	it("upsert_relation from/to 接受标题,自动解析为条目 id", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "沈望海" });
		const ida = a.entries[0]!.id;
		const idb = b.entries[1]!.id;
		// 标题与 id 混用:落库统一存解析后的 id
		const c = applyWorldUpdate(b, { op: "upsert_relation", from: "林婉", to: idb, label: "姐弟" });
		expect(c.relations[0]!.from).toBe(ida);
		expect(c.relations[0]!.to).toBe(idb);
	});
	it("upsert_relation 未匹配(id 与标题均不存在)时报错并提示检查拼写/用 world_find", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林婉" });
		try {
			applyWorldUpdate(a, { op: "upsert_relation", from: "林婉", to: "不存在的人", label: "??" });
			throw new Error("应当抛错");
		} catch (e) {
			expect(e).toBeInstanceOf(WorldValidationError);
			const msg = (e as Error).message;
			expect(msg).toContain("to");
			expect(msg).toContain("不存在的人");
			expect(msg).toContain("world_find"); // 错误信息给出正确用法,不把参数错误伪装成条目缺失
			expect(msg).toContain("拼写");
		}
	});
	it("upsert_relation 标题匹配到多个条目时报错列出候选 id,不静默取首个", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "同名" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "world", title: "同名" });
		const c = applyWorldUpdate(b, { op: "upsert_entry", type: "character", title: "乙" });
		const [ida, idb] = [a.entries[0]!.id, b.entries[1]!.id];
		try {
			applyWorldUpdate(c, { op: "upsert_relation", from: "同名", to: c.entries[2]!.id, label: "重名" });
			throw new Error("应当抛错");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("同名");
			expect(msg).toContain(ida);
			expect(msg).toContain(idb);
			expect(msg).toContain("消歧");
		}
	});
	it("upsert_relation 不带 id 且已存在方向相反的关系时报错提示,不静默新建", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "甲" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "乙" });
		const c = applyWorldUpdate(b, { op: "upsert_relation", from: "甲", to: "乙", label: "师徒" });
		const relId = c.relations[0]!.id;
		try {
			// 反向(from=乙,to=甲)不静默新建第二条
			applyWorldUpdate(c, { op: "upsert_relation", from: "乙", to: "甲", label: "师徒" });
			throw new Error("应当抛错");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("方向相反");
			expect(msg).toContain(relId); // 提示已有关系的 id,供带 id 更新
		}
		// 显式带 id 更新不受影响(语义冲突检测只在新建路径)
		const d = applyWorldUpdate(c, { op: "upsert_relation", id: relId, from: "乙", to: "甲", label: "师徒" });
		expect(d.relations[0]!.from).toBe(c.relations[0]!.to);
		expect(d.relations[0]!.to).toBe(c.relations[0]!.from);
	});
	it("upsert_relation 默认 double 箭头,可指定 none/single", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "A" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "B" });
		const [ida, idb] = [a.entries[0]!.id, b.entries[1]!.id];
		const def = applyWorldUpdate(b, { op: "upsert_relation", from: ida, to: idb, label: "姐弟" });
		expect(def.relations[0]?.arrow).toBe("double");
		const none = applyWorldUpdate(b, { op: "upsert_relation", from: ida, to: idb, label: "姐弟", arrow: "none" });
		expect(none.relations[0]?.arrow).toBe("none");
		const single = applyWorldUpdate(b, { op: "upsert_relation", from: ida, to: idb, label: "姐弟", arrow: "single" });
		expect(single.relations[0]?.arrow).toBe("single");
		// 非法 arrow 拒绝
		expect(() =>
			applyWorldUpdate(b, { op: "upsert_relation", from: ida, to: idb, label: "姐弟", arrow: "sideways" as never }),
		).toThrow(WorldValidationError);
	});
	it("advance_storyline 校验至多一个 in-progress", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "advance_storyline", id: "n1", status: "in-progress" });
		expect(() => applyWorldUpdate(a, { op: "advance_storyline", id: "n2", status: "in-progress" })).toThrow(WorldValidationError);
		const b = applyWorldUpdate(a, { op: "advance_storyline", id: "n1", status: "done", next: null });
		const c = applyWorldUpdate(b, { op: "advance_storyline", id: "n2", status: "in-progress", next: "写下一场" });
		expect(c.storyline.nodes.find((n) => n.id === "n2")?.next).toBe("写下一场");
	});
	it("advance_storyline 不带 next 时保留节点原有 next(标记完成不清空下一步)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_storyline_node", id: "n1", title: "进城", status: "in-progress", next: "抵达码头" });
		const b = applyWorldUpdate(a, { op: "advance_storyline", id: "n1", status: "done" });
		expect(b.storyline.nodes.find((n) => n.id === "n1")?.next).toBe("抵达码头");
	});
	it("storyline next 传已有节点 id → 自动转成该节点标题", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_storyline_node", id: "n1", title: "进城", status: "in-progress" });
		const b = applyWorldUpdate(a, { op: "upsert_storyline_node", id: "n2", title: "抵达码头", status: "pending", next: "n1" });
		// n2 的 next 指向 n1:落库应为 n1 的标题「进城」,而不是 id
		expect(b.storyline.nodes.find((n) => n.id === "n2")?.next).toBe("进城");
		// 非 id 文本原样保留
		const c = applyWorldUpdate(b, { op: "upsert_storyline_node", id: "n3", title: "出航", status: "pending", next: "备好干粮" });
		expect(c.storyline.nodes.find((n) => n.id === "n3")?.next).toBe("备好干粮");
	});
	it("update_timeline 只传 id 报错(至少要提供 text 或 chapter)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "append_timeline", text: "凯文抵达酒馆" });
		const id = a.timeline[0]!.id;
		expect(() => applyWorldUpdate(a, { op: "update_timeline", id })).toThrow(WorldValidationError);
		// 传 text 或 chapter 之一即可
		const b = applyWorldUpdate(a, { op: "update_timeline", id, chapter: "ch02" });
		expect(b.timeline[0]!.chapter).toBe("ch02");
		const c = applyWorldUpdate(a, { op: "update_timeline", id, text: "改后的描述" });
		expect(c.timeline[0]!.text).toBe("改后的描述");
	});
	it("update_notice 支持 enabled 开关(不传则保留现状)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "update_notice", text: "基调:克制" });
		expect(a.notice.text).toBe("基调:克制");
		expect(a.notice.enabled).toBe(true);
		const b = applyWorldUpdate(a, { op: "update_notice", text: "基调:克制", enabled: false });
		expect(b.notice.enabled).toBe(false);
		expect(b.notice.text).toBe("基调:克制");
	});
	it("update_notice 超限拒绝", () => {
		const w = createEmptyWorld();
		expect(() => applyWorldUpdate(w, { op: "update_notice", text: "字".repeat(1001) })).toThrow(WorldValidationError);
	});
	it("update_style_sample 写入并记录来源", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "update_style_sample", text: "雨落青瓦。", source: "draft/ch01.md" });
		expect(a.styleSample?.source).toBe("draft/ch01.md");
	});
	it("append_timeline 追加事件", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "append_timeline", chapter: "ch03", text: "林婉发现信件" });
		expect(a.timeline).toHaveLength(1);
		expect(a.timeline[0]!.chapter).toBe("ch03");
	});
});

describe("upsert_entry 图片字段", () => {
	it("新建条目带 avatar/images", () => {
		const world = applyWorldUpdate(createEmptyWorld(), {
			op: "upsert_entry", type: "character", title: "林婉",
			avatar: "images/a.png", images: ["images/a.png", "images/b.png"],
		});
		expect(world.entries[0]!.avatar).toBe("images/a.png");
		expect(world.entries[0]!.images).toEqual(["images/a.png", "images/b.png"]);
	});
	it("更新条目 avatar/images 并校验非法引用", () => {
		const w1 = applyWorldUpdate(createEmptyWorld(), { op: "upsert_entry", type: "character", title: "A", avatar: null, images: [] });
		const w2 = applyWorldUpdate(w1, { op: "upsert_entry", id: w1.entries[0]!.id, title: "A", avatar: "images/a.png", images: ["images/a.png"] });
		expect(w2.entries[0]!.avatar).toBe("images/a.png");
		expect(() => applyWorldUpdate(w1, { op: "upsert_entry", id: w1.entries[0]!.id, title: "A", avatar: "../x.png", images: [] })).toThrow(WorldValidationError);
	});
});

describe("storyline 节点 op", () => {
	it("upsert_storyline_node 无 id 创建新节点,title/status/goal/next 生效", () => {
		const w = applyWorldUpdate(createEmptyWorld(), {
			op: "upsert_storyline_node", title: "抵达云州", status: "in-progress", goal: "找到名医", next: "城门遇悬赏",
		});
		expect(w.storyline.nodes).toHaveLength(1);
		expect(w.storyline.nodes[0]!.title).toBe("抵达云州");
		expect(w.storyline.nodes[0]!.status).toBe("in-progress");
		expect(w.storyline.nodes[0]!.goal).toBe("找到名医");
		expect(w.storyline.nodes[0]!.next).toBe("城门遇悬赏");
	});
	it("upsert_storyline_node 带 id 更新已有节点,不存在则创建", () => {
		const w1 = applyWorldUpdate(createEmptyWorld(), { op: "upsert_storyline_node", title: "启程" });
		const id = w1.storyline.nodes[0]!.id;
		const w2 = applyWorldUpdate(w1, { op: "upsert_storyline_node", id, title: "启程(改)", status: "done" });
		expect(w2.storyline.nodes).toHaveLength(1);
		expect(w2.storyline.nodes[0]!.title).toBe("启程(改)");
		expect(w2.storyline.nodes[0]!.status).toBe("done");
		const w3 = applyWorldUpdate(w2, { op: "upsert_storyline_node", id: "story-xyz", title: "新节点" });
		expect(w3.storyline.nodes).toHaveLength(2);
		expect(w3.storyline.nodes[1]!.title).toBe("新节点");
	});
	it("两个 in-progress 节点被校验拒绝", () => {
		const w1 = applyWorldUpdate(createEmptyWorld(), { op: "upsert_storyline_node", title: "A", status: "in-progress" });
		expect(() => applyWorldUpdate(w1, { op: "upsert_storyline_node", title: "B", status: "in-progress" })).toThrow(WorldValidationError);
	});
});

describe("时间线 op", () => {
	it("update_timeline 改 chapter/text,delete_timeline 按 id 删除", () => {
		const w1 = applyWorldUpdate(createEmptyWorld(), { op: "append_timeline", chapter: "ch01", text: "事件A" });
		const id = w1.timeline[0]!.id;
		const w2 = applyWorldUpdate(w1, { op: "update_timeline", id, text: "事件A(改)", chapter: "ch02" });
		expect(w2.timeline[0]!.text).toBe("事件A(改)");
		expect(w2.timeline[0]!.chapter).toBe("ch02");
		const w3 = applyWorldUpdate(w2, { op: "delete_timeline", id });
		expect(w3.timeline).toHaveLength(0);
	});
	it("update_timeline/delete_timeline 对不存在的事件报错", () => {
		expect(() => applyWorldUpdate(createEmptyWorld(), { op: "update_timeline", id: "nope", text: "x" })).toThrow(WorldValidationError);
		expect(() => applyWorldUpdate(createEmptyWorld(), { op: "delete_timeline", id: "nope" })).toThrow(WorldValidationError);
	});
});

describe("worldFindTool", () => {
	type FindParams = Parameters<typeof worldFindTool.execute>[1];
	function runFind(params: FindParams): ReturnType<typeof worldFindTool.execute> {
		return worldFindTool.execute("call", params, undefined, undefined, {} as ToolContext);
	}

	it("按标题/类型/触发词检索,返回 id 供后续 world_update 定位", async () => {
		setWorldUpdateBookDir(tmp);
		const world = createEmptyWorld();
		const withEntries = applyWorldUpdate(world, { op: "upsert_entry", type: "character", title: "林婉", keys: ["婉姐"] });
		const both = applyWorldUpdate(withEntries, { op: "upsert_entry", type: "character", title: "阿七", keys: ["小七"] });
		// 工具只读:种子经 applyWorldUpdate + saveWorld 落盘(world_find 读磁盘)
		const { saveWorld } = await import("../src/world-data.ts");
		await saveWorld(tmp, both);

		const byTitle = await runFind({ title: "林婉" });
		expect(resultText(byTitle)).toContain("[character] 林婉");
		const byType = await runFind({ type: "character" });
		expect(resultText(byType)).toContain("林婉");
		expect(resultText(byType)).toContain("阿七");
		const byKey = await runFind({ keys: ["婉姐"] });
		expect(resultText(byKey)).toContain("林婉");
		expect(resultText(byKey)).not.toContain("阿七");
		const none = await runFind({ title: "不存在的人" });
		expect(resultText(none)).toContain("匹配 0 条");
		setWorldUpdateBookDir(null);
	});

	it("未配置书目录时报错", async () => {
		setWorldUpdateBookDir(null);
		await expect(runFind({ title: "x" })).rejects.toThrow("未配置书目录");
	});
});
