import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStyleUpdate, applyWorldUpdate, normalizeStyleUpdate, normalizeWorldUpdate, readChapterTool, setWordCountCwd, setWorldUpdateBookDir, styleUpdateTool, wordCountTool, worldFindTool, worldUpdateTool } from "../src/tools.ts";
import { createEmptyWorld, ensureWorld, WorldValidationError } from "../src/world-data.ts";

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

describe("read_chapter（整章全文读取）", () => {
	type ReadParams = Parameters<typeof readChapterTool.execute>[1];
	function runRead(params: ReadParams): ReturnType<typeof readChapterTool.execute> {
		return readChapterTool.execute("call", params, undefined, undefined, {} as ToolContext);
	}

	/** 造一章:写到 draft/ch01.md 并让工具以书目录为基准解析。 */
	function seedChapter(content: string): void {
		mkdirSync(join(tmp, "draft"), { recursive: true });
		writeFileSync(join(tmp, "draft", "ch01.md"), content, "utf-8");
		setWorldUpdateBookDir(tmp);
	}

	afterEach(() => {
		setWorldUpdateBookDir(null);
	});

	it("一次返回整章正文,不截断(内置 read 会在 2000 行处静默截断)", async () => {
		// 3000 行、每行一句:远超内置 read 的 DEFAULT_MAX_LINES=2000。
		// 若这个工具也走上了分片逻辑,末行的哨兵文本就不会出现。
		const lines = Array.from({ length: 3000 }, (_, i) => `第 ${i + 1} 行正文。`);
		seedChapter(`${lines.join("\n")}\n`);
		const result = await runRead({ path: "draft/ch01.md" });
		const text = resultText(result);
		expect(text).toContain("第 3000 行正文。");
		expect(text).toContain("第 1 行正文。");
		expect(result.details?.truncated).toBe(false);
	});

	it("头部带路径与字数,模型续写不必再调 word_count", async () => {
		seedChapter("第一章。\n\n第二段。\n");
		const text = resultText(await runRead({ path: "draft/ch01.md" }));
		expect(text).toContain("draft/ch01.md");
		expect(text).toContain("6 字");
		expect(text).toContain("2 段");
	});

	it("path 可省略 draft/ 前缀与 .md 后缀", async () => {
		seedChapter("甲。");
		for (const p of ["ch01", "draft/ch01", "draft/ch01.md"]) {
			const text = resultText(await runRead({ path: p }));
			expect(text).toContain("draft/ch01.md");
			expect(text).toContain("甲。");
		}
	});

	it("文件不存在时抛可读错误(而不是返回空文本让模型以为读到了)", async () => {
		setWorldUpdateBookDir(tmp);
		await expect(runRead({ path: "draft/nope.md" })).rejects.toThrow("找不到文件");
	});

	it("拒绝非文本与工作区外的路径(与清单同源,防越界探测)", async () => {
		setWorldUpdateBookDir(tmp);
		// 隐藏文件 / jsonl / 世界书生成物:isWorkspaceFile 一律拒绝
		await expect(runRead({ path: "draft/.secret.md" })).rejects.toThrow("找不到文件");
		await expect(runRead({ path: "../escape.md" })).rejects.toThrow();
	});

	it("超过 512KB 上限时显式告知已截断(不静默给半截)", async () => {
		// 构造 > MAX_READ_BYTES 的文件:每行 100 字节 × 6000 行 ≈ 600KB
		const line = `${"字".repeat(50)}\n`;
		seedChapter(line.repeat(6000));
		const result = await runRead({ path: "draft/ch01.md" });
		expect(result.details?.truncated).toBe(true);
		expect(resultText(result)).toContain("读取上限");
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
	it("set_world_summary 覆盖写", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "set_world_summary", text: "蒸汽与旧神共存的雾港。" });
		expect(a.worldSummary).toBe("蒸汽与旧神共存的雾港。");
		const b = applyWorldUpdate(a, { op: "set_world_summary", text: "修订版概述" });
		expect(b.worldSummary).toBe("修订版概述");
	});
	it("set_world_summary 超长被 validateWorld 拒绝", () => {
		const w = createEmptyWorld();
		expect(() => applyWorldUpdate(w, { op: "set_world_summary", text: "字".repeat(601) })).toThrow(WorldValidationError);
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
	it("update_notice 只切注入开关(enabled)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "update_notice", enabled: false });
		expect(a.notice.enabled).toBe(false);
		expect(a.notice.items).toEqual([]);
		// 不传 enabled 保持现状
		const b = applyWorldUpdate(a, { op: "update_notice" });
		expect(b.notice.enabled).toBe(false);
	});
	it("notice_append 追加未完成待办;notice_set_done 勾选", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "notice_append", text: "埋伏笔:青冥剑的来历" });
		expect(a.notice.items).toHaveLength(1);
		expect(a.notice.items[0]?.text).toBe("埋伏笔:青冥剑的来历");
		expect(a.notice.items[0]?.done).toBe(false);
		const b = applyWorldUpdate(a, { op: "notice_set_done", id: a.notice.items[0]!.id, done: true });
		expect(b.notice.items[0]?.done).toBe(true);
	});
	it("notice_update 改文本;notice_delete 删除;不存在的 id 抛错", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "notice_append", text: "旧文本" });
		const id = a.notice.items[0]!.id;
		const b = applyWorldUpdate(a, { op: "notice_update", id, text: "新文本" });
		expect(b.notice.items[0]?.text).toBe("新文本");
		const c = applyWorldUpdate(b, { op: "notice_delete", id });
		expect(c.notice.items).toHaveLength(0);
		expect(() => applyWorldUpdate(a, { op: "notice_set_done", id: "nope", done: true })).toThrow(WorldValidationError);
	});
	it("upsert_constraint 支持 target(新建/更新)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_constraint", name: "对话风格", text: "口语化", target: "director" });
		expect(a.constraints[0]?.target).toBe("director");
		const id = a.constraints[0]!.id;
		const b = applyWorldUpdate(a, { op: "upsert_constraint", id, name: "对话风格", text: "口语化", target: "all" });
		expect(b.constraints[0]?.target).toBe("all");
		// 不带 target 的新建:不写字段(缺省 all)
		const c = applyWorldUpdate(w, { op: "upsert_constraint", name: "无 target", text: "x" });
		expect(c.constraints[0]?.target).toBeUndefined();
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
		const w2 = applyWorldUpdate(w1, { op: "upsert_entry", id: w1.entries[0]!.id, type: "character", title: "A", avatar: "images/a.png", images: ["images/a.png"] });
		expect(w2.entries[0]!.avatar).toBe("images/a.png");
		expect(() => applyWorldUpdate(w1, { op: "upsert_entry", id: w1.entries[0]!.id, type: "character", title: "A", avatar: "../x.png", images: [] })).toThrow(WorldValidationError);
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

/**
 * `style_update`:编剧的写作风格窄通道(2026-10-01)。
 *
 * 这条通道的存在理由见 StyleUpdateOp 的注释——编剧此前只能写 advice.md 等导演落盘,
 * 用户在编辑页说「以后别用破折号」看到的是"说了没生效"。这里钉住四件事:
 * ① 只能碰约束/采样/概述(参数 schema 只有四个 op);② 约束**强制** target=writer;
 * ③ 约束按**名字** upsert(同名更新而不是重复立规矩)、按名字删;④ 越权/未命中要报错。
 */
describe("applyStyleUpdate（编剧窄通道）", () => {
	it("upsert_constraint 新建,且约束强制写成编剧范围", () => {
		const next = applyStyleUpdate(createEmptyWorld(), { op: "upsert_constraint", name: "文风", text: "禁用破折号" });
		expect(next.constraints).toHaveLength(1);
		expect(next.constraints[0]!.name).toBe("文风");
		expect(next.constraints[0]!.text).toBe("禁用破折号");
		// 编剧只约束自己——要约束导演得用户直接对导演讲
		expect(next.constraints[0]!.target).toBe("writer");
		expect(next.constraints[0]!.enabled).toBe(true);
	});

	it("upsert_constraint 同名即更新(不会重复立规矩)", () => {
		const first = applyStyleUpdate(createEmptyWorld(), { op: "upsert_constraint", name: "文风", text: "禁用破折号" });
		const second = applyStyleUpdate(first, { op: "upsert_constraint", name: "文风", text: "禁用破折号与省略号" });
		expect(second.constraints).toHaveLength(1);
		expect(second.constraints[0]!.text).toBe("禁用破折号与省略号");
		// 重述一条规矩 = 它现在生效(界面上手动停用的会被重新启用)
		expect(second.constraints[0]!.enabled).toBe(true);
	});

	it("upsert_constraint 可显式停用", () => {
		const next = applyStyleUpdate(createEmptyWorld(), { op: "upsert_constraint", name: "文风", text: "x", enabled: false });
		expect(next.constraints[0]!.enabled).toBe(false);
	});

	it("delete_constraint 按名字删;名字不存在时抛错并指路约束块", () => {
		const w = applyStyleUpdate(createEmptyWorld(), { op: "upsert_constraint", name: "文风", text: "x" });
		expect(applyStyleUpdate(w, { op: "delete_constraint", name: "文风" }).constraints).toHaveLength(0);
		expect(() => applyStyleUpdate(w, { op: "delete_constraint", name: "没这条" })).toThrow(WorldValidationError);
		expect(() => applyStyleUpdate(w, { op: "delete_constraint", name: "没这条" })).toThrow(/【写作约束】/);
	});

	it("update_style_sample / set_world_summary 与 world_update 同语义", () => {
		const w = applyStyleUpdate(createEmptyWorld(), { op: "update_style_sample", text: "暮色如旧。", source: "用户提供" });
		expect(w.styleSample?.text).toBe("暮色如旧。");
		expect(w.styleSample?.source).toBe("用户提供");
		const w2 = applyStyleUpdate(w, { op: "set_world_summary", text: "都市脑洞轻喜剧。" });
		expect(w2.worldSummary).toBe("都市脑洞轻喜剧。");
	});

	it("碰不到条目/关系/时间线/发展线(窄通道的参数 schema 只有四个 op)", () => {
		const flat = (styleUpdateTool.parameters as { properties: { update: { anyOf?: unknown; required?: string[]; properties: { op: { enum?: string[] } } } } })
			.properties.update;
		expect(flat.anyOf).toBeUndefined();
		expect((flat.properties.op.enum ?? []).slice().sort()).toEqual(["delete_constraint", "set_world_summary", "update_style_sample", "upsert_constraint"]);
		expect(styleUpdateTool.name).toBe("style_update");
	});
});

/**
 * 工具参数 schema 压平(2026-10-02 实机反馈):world_update / style_update 曾把 op 判别联合
 * 直接当工具参数暴露(约 7KB 的 anyOf)。受限解码 / 只读首分支的 provider 拿到的就是
 * upsert_entry 分支的 required(type/title),于是 set_world_summary、upsert_relation 这类
 * 非首分支操作根本发不出来。这里钉住:对模型暴露的是单一对象(无 anyOf,只有 op 必填),
 * 必填性改由 normalize* 按 op 在运行时兜底并给出可读报错。
 */
describe("world_update/style_update 参数 schema 压平", () => {
	type FlatSchema = { anyOf?: unknown; required?: string[]; properties: Record<string, { enum?: string[] }> };
	const flatOf = (tool: { parameters: unknown }): FlatSchema =>
		(tool.parameters as { properties: { update: FlatSchema } }).properties.update;

	it("world_update 暴露单一对象:无 anyOf、只有 op 必填、关系字段可见", () => {
		const flat = flatOf(worldUpdateTool);
		expect(flat.anyOf).toBeUndefined();
		expect(flat.required).toEqual(["op"]);
		expect(flat.properties.op.enum).toContain("upsert_relation");
		expect(flat.properties.op.enum).toContain("set_world_summary");
		// 关系操作需要的 from/to 在 schema 里,不再被 upsert_entry 的 title/type 挡住
		expect(flat.properties.from).toBeDefined();
		expect(flat.properties.to).toBeDefined();
	});

	it("style_update 同样压平", () => {
		const flat = flatOf(styleUpdateTool);
		expect(flat.anyOf).toBeUndefined();
		expect(flat.required).toEqual(["op"]);
	});

	it("word_count 的 modes 用 string+enum,不再有 anyOf", () => {
		const items = (wordCountTool.parameters as { properties: { modes: { items: { anyOf?: unknown; enum?: string[] } } } }).properties.modes.items;
		expect(items.anyOf).toBeUndefined();
		expect(items.enum).toContain("en_words");
		expect(items.enum).toContain("all");
	});

	it("normalizeWorldUpdate 按 op 校验必填字段与未知 op", () => {
		const ok = { op: "set_world_summary", text: "蒸汽与旧神共存的雾港。" };
		expect(normalizeWorldUpdate(ok)).toBe(ok);
		expect(normalizeWorldUpdate({ op: "upsert_relation", from: "菲利克斯", to: "巨头" }).op).toBe("upsert_relation");
		expect(() => normalizeWorldUpdate({ op: "upsert_entry", type: "character" })).toThrow(/title/);
		expect(() => normalizeWorldUpdate({ op: "upsert_relation", from: "菲利克斯" })).toThrow(/to/);
		expect(() => normalizeWorldUpdate({ op: "not_an_op" })).toThrow(/不支持的 op/);
		expect(() => normalizeWorldUpdate({})).toThrow(/缺少 op/);
		expect(() => normalizeWorldUpdate(null)).toThrow(/必须是对象/);
	});

	it("normalizeStyleUpdate 按 op 校验", () => {
		expect(normalizeStyleUpdate({ op: "delete_constraint", name: "文风" }).op).toBe("delete_constraint");
		expect(() => normalizeStyleUpdate({ op: "upsert_constraint", name: "文风" })).toThrow(/text/);
		expect(() => normalizeStyleUpdate({ op: "upsert_entry", title: "x" })).toThrow(/不支持的 op/);
	});

	it("world_update 端到端:upsert_relation / set_world_summary 确实写得进 world.json", async () => {
		setWorldUpdateBookDir(tmp);
		try {
			const run = (update: Record<string, unknown>) =>
				worldUpdateTool.execute("call", { update } as never, undefined, undefined, {} as ToolContext);
			const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
			await run({ op: "upsert_entry", type: "character", title: "菲利克斯" });
			await run({ op: "upsert_entry", type: "world", title: "跨国煤炭能源垄断巨头" });
			const rel = await run({ op: "upsert_relation", from: "菲利克斯", to: "跨国煤炭能源垄断巨头", label: "受雇", arrow: "single" });
			expect(textOf(rel)).toContain("upsert_relation");
			await run({ op: "set_world_summary", text: "雾港:煤与雾的年代。" });
			const world = await ensureWorld(tmp);
			expect(world.relations).toHaveLength(1);
			expect(world.relations[0]!.label).toBe("受雇");
			expect(world.relations[0]!.arrow).toBe("single");
			expect(world.worldSummary).toBe("雾港:煤与雾的年代。");
			// 缺字段给可读报错(模型据此自我纠正),而不是写坏数据
			await expect(run({ op: "upsert_relation", from: "菲利克斯" })).rejects.toThrow(/to/);
		} finally {
			setWorldUpdateBookDir(null);
		}
	});
});
