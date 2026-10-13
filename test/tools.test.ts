import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyNoticeUpdate, applyStorylineUpdate, applyStyleUpdate, applyWorldUpdate, emptiedEntryBodies, normalizeNoticeUpdate, normalizeStorylineUpdate, normalizeStyleUpdate, normalizeWorldUpdate, noticeUpdateTool, readChapterTool, readStyleTool, setWorldUpdateBookDir, storylineUpdateTool, styleUpdateTool, worldFindTool, worldUpdateTool } from "../src/tools.ts";
import { createEmptyWorld, ensureWorld, saveWorld, WorldValidationError } from "../src/world-data.ts";

type ToolContext = Parameters<typeof readChapterTool.execute>[4];

function resultText(result: Awaited<ReturnType<typeof readChapterTool.execute>>): string {
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

	it("头部带路径与字数,模型续写不必另起一次调用去数", async () => {
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
		// 节点须先存在:2026-10-13 起 advance 不再兜底新建(见下方「查不到一律报错」用例)
		let w = createEmptyWorld();
		w = applyWorldUpdate(w, { op: "upsert_storyline_node", id: "n1", title: "进城" });
		w = applyWorldUpdate(w, { op: "upsert_storyline_node", id: "n2", title: "抵达码头" });
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

describe("删除类 op 不静默无操作（2026-10-05）", () => {
	// 这一组盯的是「传错 id → filter 掉一个不存在的元素 → 回『已更新』」的踢皮球:
	// 模型据此以为删掉了、继续推理,而用户那边东西还在。同文件 narrowOp 的注释写着
	// 「不静默无操作,报错原样进上下文让模型自我纠正」—— delete_entry / notice_update
	// 一直是这么做的,下面三个 op 原先没有,本轮补齐。

	it("delete_constraint 传错 id 报错而不是静默无操作", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_constraint", name: "对话风格", text: "对话不用引号。" });
		const id = a.constraints[0]!.id;
		// 正确 id:正常删除
		expect(applyWorldUpdate(a, { op: "delete_constraint", id }).constraints).toHaveLength(0);
		// 错 id:必须抛错(原先返回「已更新世界书」但什么都没删)
		expect(() => applyWorldUpdate(a, { op: "delete_constraint", id: `${id}-typo` })).toThrow(WorldValidationError);
		expect(() => applyWorldUpdate(a, { op: "delete_constraint", id: "不存在的约束" })).toThrow(/约束不存在/);
	});

	it("notice_delete 传错 id 报错而不是静默无操作", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "notice_append", text: "记得回收伏笔" });
		const id = a.notice.items[0]!.id;
		expect(applyWorldUpdate(a, { op: "notice_delete", id }).notice.items).toHaveLength(0);
		expect(() => applyWorldUpdate(a, { op: "notice_delete", id: `${id}-typo` })).toThrow(/Notice 待办不存在/);
	});

	it("delete_relation 传错 id 报错而不是静默无操作", () => {
		// 这条是本组最后一个漏网(前两个在 bf0d215 修掉,关系侧漏了)。关系是**双向可见**
		// 的数据:模型以为删了、用户关系图上仍连着,比约束/待办更隐蔽。
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林昭", body: "刀客。" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "萧彻", body: "书生。" });
		const [x, y] = [b.entries[0]!.id, b.entries[1]!.id];
		const c = applyWorldUpdate(b, { op: "upsert_relation", from: x, to: y, type: "rival" });
		const rid = c.relations[0]!.id;
		// 正确 id:正常删除
		expect(applyWorldUpdate(c, { op: "delete_relation", id: rid }).relations).toHaveLength(0);
		// 错 id:必须抛错(原先返回「已更新世界书」但关系还在)
		expect(() => applyWorldUpdate(c, { op: "delete_relation", id: `${rid}-typo` })).toThrow(WorldValidationError);
		expect(() => applyWorldUpdate(c, { op: "delete_relation", id: "不存在的关系" })).toThrow(/关系不存在/);
	});

	it("报错文案说明「未删除任何内容」(让模型知道世界没变)", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_constraint", name: "C", text: "t" });
		expect(() => applyWorldUpdate(a, { op: "delete_constraint", id: "x" })).toThrow(/未删除任何内容/);
		const b = applyWorldUpdate(w, { op: "notice_append", text: "n" });
		expect(() => applyWorldUpdate(b, { op: "notice_delete", id: "x" })).toThrow(/未删除任何内容/);
		// 关系侧同样
		expect(() => applyWorldUpdate(a, { op: "delete_relation", id: "x" })).toThrow(/未删除任何内容/);
	});
});

describe("emptiedEntryBodies —— 条目正文清空可见化（2026-10-05）", () => {
	// 与 writeDeltaLine 同思路:不阻止,但让损失可见。「清空条目正文」可能是合法意图,
	// 但「非空 → 空」最常见的成因是模型漏带 body,而工具只回「已更新世界书」。

	it("非空 → 空:回报标题", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "林昭", body: "旧城最好的刀客。" });
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "林昭", body: "" });
		expect(emptiedEntryBodies(a, b)).toEqual(["林昭"]);
	});

	it("本来就空 / 变长 / 纯空白不再变空:都不报", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "character", title: "甲" }); // body 缺省空
		const b = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "甲", body: "" });
		expect(emptiedEntryBodies(a, b)).toEqual([]);

		const c = applyWorldUpdate(a, { op: "upsert_entry", type: "character", title: "乙", body: "有内容" });
		const d = applyWorldUpdate(c, { op: "upsert_entry", type: "character", title: "乙", body: "更长的内容" });
		expect(emptiedEntryBodies(c, d)).toEqual([]);
	});

	it("新建的空条目不算「被清空」", () => {
		const w = createEmptyWorld();
		const a = applyWorldUpdate(w, { op: "upsert_entry", type: "world", title: "此地" });
		expect(emptiedEntryBodies(w, a)).toEqual([]);
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

	/**
	 * 种一本世界书:两个人物(各有触发词与正文)+ 一个够不着的地图条目。
	 * 后面几组用例共用它 —— 造一份就够,免得每个用例各自铺一遍。
	 */
	async function seedWorld(): Promise<void> {
		setWorldUpdateBookDir(tmp);
		let world = createEmptyWorld();
		world = applyWorldUpdate(world, { op: "upsert_entry", type: "character", title: "林婉", keys: ["婉姐"], body: "旧城书店的老板,左眼有一道疤。" });
		world = applyWorldUpdate(world, { op: "upsert_entry", type: "character", title: "阿七", keys: ["小七"], body: "码头搬货的少年,话少。" });
		world = applyWorldUpdate(world, { op: "upsert_entry", type: "world", title: "旧城地图", body: "三纵四横,河从城西过。" });
		await saveWorld(tmp, world);
	}

	it("detail:full 附带条目正文(此前没有任何工具能读到条目 body)", async () => {
		await seedWorld();
		// 默认 brief 只给元信息 —— 正文一个字都不给
		const brief = await runFind({ title: "林婉" });
		expect(resultText(brief)).toContain("[character] 林婉");
		expect(resultText(brief)).not.toContain("左眼");
		// full 才把正文带出来
		const full = await runFind({ title: "林婉", detail: "full" });
		expect(resultText(full)).toContain("左眼有一道疤");
		setWorldUpdateBookDir(null);
	});

	it("query 按子串匹配标题或触发词(记得住片段、记不住全名时也能找)", async () => {
		await seedWorld();
		// 标题片段
		expect(resultText(await runFind({ query: "婉" }))).toContain("林婉");
		// 触发词片段(「婉姐」里含「婉」,上面已覆盖);换一个只出现在触发词里的片段
		expect(resultText(await runFind({ query: "小七" }))).toContain("阿七");
		expect(resultText(await runFind({ query: "城地图" }))).toContain("旧城地图");
		// 命中不了任何东西时不该无中生有
		expect(resultText(await runFind({ query: "不存在片段" }))).toContain("匹配 0 条");
		setWorldUpdateBookDir(null);
	});

	it("query 与 title/type 是「与」关系,不是「或」", async () => {
		await seedWorld();
		// 片段命中林婉,但类型限定人物之外 → 必须为空
		expect(resultText(await runFind({ query: "婉", type: "world" }))).toContain("匹配 0 条");
		expect(resultText(await runFind({ query: "婉", type: "character" }))).toContain("林婉");
		setWorldUpdateBookDir(null);
	});

	it("scan:扫出正文里被提及的条目,回正文并点明命中了哪个词", async () => {
		await seedWorld();
		// 这段话提了「林婉」与「小七」(阿七的触发词),没提地图
		const r = await runFind({ scan: "林婉推开门,小七跟在她身后,两人都没说话。" });
		const t = resultText(r);
		expect(t).toContain("林婉");
		expect(t).toContain("命中:「林婉」");
		expect(t).toContain("阿七");
		expect(t).toContain("命中:「小七」");
		// 正文被带出来 —— 这正是核对要用的东西
		expect(t).toContain("左眼有一道疤");
		expect(t).toContain("码头搬货的少年");
		// 没提到的条目以及它的正文都不该出现
		expect(t).not.toContain("旧城地图");
		expect(t).not.toContain("三纵四横");
		// 结果要以「核对指令」收尾,而不是把正文一倒了事
		expect(t).toContain("逐条核对");
		setWorldUpdateBookDir(null);
	});

	it("scan:零命中必须给出去路,不许让模型把「没扫到」当成「一致」", async () => {
		await seedWorld();
		const t = resultText(await runFind({ scan: "今天风很软,云压得很低。" }));
		expect(t).toContain("没有扫到");
		expect(t).toContain("不等于");
		// 出路:换个方式再查一次
		expect(t).toContain("query");
		setWorldUpdateBookDir(null);
	});

	it("scan:短于 2 字的标题不参与扫描(单字会满篇乱撞)", async () => {
		setWorldUpdateBookDir(tmp);
		const world = applyWorldUpdate(createEmptyWorld(), { op: "upsert_entry", type: "world", title: "刀", body: "一柄旧刀。" });
		await saveWorld(tmp, world);
		// 「刀」是单字标题,不构成可靠提法 —— 命中它会带来大量误报
		expect(resultText(await runFind({ scan: "他从袖里抽出刀,刀身雪亮。" }))).toContain("没有扫到");
		// 但按标题精确找它仍然可以(短词只是不参与「扫描」)
		expect(resultText(await runFind({ title: "刀" }))).toContain("[world] 刀");
		setWorldUpdateBookDir(null);
	});

	it("scan / detail:full 对超长正文截断并明示(不让人以为读到的是全文)", async () => {
		setWorldUpdateBookDir(tmp);
		const long = "长".repeat(3000);
		const world = applyWorldUpdate(createEmptyWorld(), { op: "upsert_entry", type: "character", title: "长文者", body: long });
		await saveWorld(tmp, world);
		const t = resultText(await runFind({ title: "长文者", detail: "full" }));
		expect(t).toContain("已截断");
		expect(t).toContain("全文 3000 字");
		setWorldUpdateBookDir(null);
	});

	it("scan 命中大小写不敏感(英文条目名,与 query 分支同口径,2026-10-13)", async () => {
		setWorldUpdateBookDir(tmp);
		let world = createEmptyWorld();
		world = applyWorldUpdate(world, { op: "upsert_entry", type: "character", title: "Alice", body: "钟表匠的女儿。" });
		await saveWorld(tmp, world);
		// 条目名是 Alice,正文里写的是 ALICE —— 小写化后仍应命中(中文不受影响,是恒等变换)
		const t = resultText(await runFind({ scan: "he saw ALICE at the fair" }));
		expect(t).toContain("Alice");
		expect(t).toContain("命中:「Alice」");
		setWorldUpdateBookDir(null);
	});

	it("details 形状在 scan 与 filter 两种形态下同形(否则返回类型会塌成互斥联合)", async () => {
		await seedWorld();
		const scan = await runFind({ scan: "林婉站在门口。" });
		const filter = await runFind({ type: "character" });
		const keysOf = (d: unknown): string[] => Object.keys(d as Record<string, unknown>).sort();
		expect(keysOf((scan as { details: unknown }).details)).toEqual(keysOf((filter as { details: unknown }).details));
		expect(keysOf(((scan as { details: { found: unknown[] } }).details.found[0]))).toEqual(
			keysOf(((filter as { details: { found: unknown[] } }).details.found[0])),
		);
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
	it("upsert_constraint 新建,且**新建**的约束默认写成编剧范围", () => {
		const next = applyStyleUpdate(createEmptyWorld(), { op: "upsert_constraint", name: "文风", text: "禁用破折号" });
		expect(next.constraints).toHaveLength(1);
		expect(next.constraints[0]!.name).toBe("文风");
		expect(next.constraints[0]!.text).toBe("禁用破折号");
		// 新建时编剧只约束自己——要约束导演得用户直接对导演讲
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

	it("重述已有约束**不吞掉它的作用域**(2026-10-11 修的 bug)", () => {
		// 用户建了一条 target:"all" 的规矩(导演/编剧/主会话都要遵守),随后编剧
		// 在编辑页重述一遍 —— 修复前这里一律写 writer,于是规矩被静默缩窄成只管编剧,
		// 导演与主会话从此看不到(症状是「这规矩怎么时灵时不灵」)。
		const base = applyWorldUpdate(createEmptyWorld(), {
			op: "upsert_constraint", name: "人称", text: "第三人称限知", target: "all",
		});
		const after = applyStyleUpdate(base, { op: "upsert_constraint", name: "人称", text: "第三人称限知,不写内心独白" });
		expect(after.constraints).toHaveLength(1);
		expect(after.constraints[0]!.target).toBe("all");
		expect(after.constraints[0]!.text).toBe("第三人称限知,不写内心独白");
	});

	it("set_constraint_enabled 只切开关,正文与作用域原样不动", () => {
		const base = applyWorldUpdate(createEmptyWorld(), {
			op: "upsert_constraint", name: "人称", text: "第三人称限知", target: "all",
		});
		const off = applyStyleUpdate(base, { op: "set_constraint_enabled", name: "人称", enabled: false });
		expect(off.constraints[0]!.enabled).toBe(false);
		expect(off.constraints[0]!.text).toBe("第三人称限知");
		expect(off.constraints[0]!.target).toBe("all");
		const on = applyStyleUpdate(off, { op: "set_constraint_enabled", name: "人称", enabled: true });
		expect(on.constraints[0]!.enabled).toBe(true);
		expect(on.constraints[0]!.text).toBe("第三人称限知");
	});

	it("set_constraint_enabled 名字不存在时抛错并指路约束块(不静默无操作)", () => {
		expect(() => applyStyleUpdate(createEmptyWorld(), { op: "set_constraint_enabled", name: "没这条", enabled: false }))
			.toThrow(/【写作约束】/);
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

	it("update_style_sample 拒绝空值(2026-10-05)", () => {
		// 采样是作者文风基准,而这是它唯一的写入路径、且不产生编辑记录(前端无预览卡),
		// 空值会静默把它清掉。读侧(read_style)已为「没有采样」写了护栏,这里补齐写侧。
		const w = applyStyleUpdate(createEmptyWorld(), { op: "update_style_sample", text: "暮色如旧。" });
		expect(() => applyStyleUpdate(w, { op: "update_style_sample", text: "" })).toThrow(WorldValidationError);
		expect(() => applyStyleUpdate(w, { op: "update_style_sample", text: "   \n  " })).toThrow(WorldValidationError);
		// 拦截理由要给出去路(否则模型只会把空串换个写法再来一次)
		expect(() => applyStyleUpdate(w, { op: "update_style_sample", text: "" })).toThrow(/300–500 字/);
		// 原采样必须还在(不是「清空后报错」)
		expect(w.styleSample?.text).toBe("暮色如旧。");
	});

	it("碰不到条目/关系/时间线/发展线/Notice(窄通道的参数 schema 只有这几个 op)", () => {
		const flat = (styleUpdateTool.parameters as { properties: { update: { anyOf?: unknown; required?: string[]; properties: { op: { enum?: string[] } } } } })
			.properties.update;
		expect(flat.anyOf).toBeUndefined();
		expect((flat.properties.op.enum ?? []).slice().sort()).toEqual([
			"delete_constraint",
			"set_constraint_enabled",
			"set_world_summary",
			"update_style_sample",
			"upsert_constraint",
		]);
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

/**
 * read_style(2026-10-05):文风采样从「稳定块常驻」改成「工具按需取」。
 *
 * 两个动机各有对应的验收点:
 *  - **够得着**:采样此前只能靠 `read world.json` 拿到(整本世界书倒进上下文)——
 *    `world_find` 只回 id/type/title/status,连条目 body 都不给,采样更是顶层字段而非条目。
 *  - **不再堆叠**:采样一变,稳定块指纹就变、就重注一份(见 stable-context 那轮的 16 份)。
 *
 * 没有采样时的「出路」也要钉住:空结果会让模型以为可以随手起调子,文风静默漂移。
 */
describe("read_style（文风采样按需读取）", () => {
	type StyleResult = Awaited<ReturnType<typeof readStyleTool.execute>>;
	function runStyle(): Promise<StyleResult> {
		return readStyleTool.execute("call", {}, undefined, undefined, {} as ToolContext);
	}

	/** 直接把一份 world.json 落到 tmp 书目录里(绕开工具,只测读)。 */
	async function seedWorld(mutate: (w: ReturnType<typeof createEmptyWorld>) => void): Promise<void> {
		const world = createEmptyWorld();
		mutate(world);
		await saveWorld(tmp, world);
		setWorldUpdateBookDir(tmp);
	}

	afterEach(() => {
		setWorldUpdateBookDir(null);
	});

	it("有采样时回全文 + 出处,而不是「采样已存在」这种占位", async () => {
		const text = "雾从河面涨上来，把煤烟按在屋檐底下。他数着第三声汽笛，知道自己又晚了一班。";
		await seedWorld((w) => {
			w.styleSample = { text, source: "用户提供", updatedAt: Date.UTC(2026, 9, 5) };
		});
		const result = await runStyle();
		const out = resultText(result);
		expect(out).toContain(text);
		expect(out).toContain("来源: 用户提供");
		expect(out).toContain("2026-10-05");
		expect(out).toContain("不抄写");
		expect((result.details as { hasSample: boolean }).hasSample).toBe(true);
	});

	it("没标出处时回「未标注来源」,不把空来源渲染成空白", async () => {
		await seedWorld((w) => {
			w.styleSample = { text: "夜色沉到街心里。", source: "", updatedAt: 0 };
		});
		const out = resultText(await runStyle());
		expect(out).toContain("未标注来源");
		expect(out).not.toContain("更新于");
	});

	it("没有采样时给两条出路,而不是一个空结果", async () => {
		// 空回执的代价是模型自己起调子、且无从察觉。这里要求回执里必须有下一步。
		await seedWorld(() => {
			/* styleSample 保持 null */
		});
		const result = await runStyle();
		const out = resultText(result);
		expect(out).toContain("还没有文风采样");
		expect(out).toContain("style_update");
		expect(out).toContain("不要自己编一段");
		expect((result.details as { hasSample: boolean }).hasSample).toBe(false);
	});

	it("空白正文视同没有采样(写了 '   ' 也算没写)", async () => {
		await seedWorld((w) => {
			w.styleSample = { text: "   \n\t ", source: "用户提供", updatedAt: 0 };
		});
		expect((await runStyle()).details as { hasSample: boolean }).toMatchObject({ hasSample: false });
	});

	it("与 style_update 成对:那边写进 world.json,这边读得回来", async () => {
		setWorldUpdateBookDir(tmp);
		try {
			const text = "姐姐把灯芯剪短一截，屋里便矮了半尺。";
			await styleUpdateTool.execute(
				"call",
				{ update: { op: "update_style_sample", text, source: "ch01 收尾自取" } } as never,
				undefined,
				undefined,
				{} as ToolContext,
			);
			const out = resultText(await runStyle());
			expect(out).toContain(text);
			expect(out).toContain("ch01 收尾自取");
		} finally {
			setWorldUpdateBookDir(null);
		}
	});

	it("没有必填参数(desc 说了切身就可以调,不该被 schema 卡住)", () => {
		const schema = readStyleTool.parameters as { required?: string[]; properties?: Record<string, unknown> };
		expect(schema.required).toBeUndefined();
		expect(Object.keys(schema.properties ?? {})).toEqual([]);
		expect(readStyleTool.name).toBe("read_style");
	});

	it("描述里写明动笔前要取一次(补决提示词没说的那半句)", () => {
		// 工具 schema 随请求发给模型,这是「它会不会想起用」的第一现场
		expect(readStyleTool.description).toContain("动笔写正文前");
	});
});

/**
 * 2026-10-11:编剧的「发展与备忘」窄通道。此前编剧改不了发展线/Notice,
 * 只能把结论写进 advice.md 等导演开会话 —— 与 2026-10-01 约束那条断链同型。
 */
function worldWithStoryAndNotice() {
	const w = createEmptyWorld();
	w.storyline = {
		enabled: true,
		nodes: [
			{ id: "story-aa11bb", title: "初入旧城", status: "in-progress", goal: "交代背景", next: "引出林婉" },
			{ id: "story-cc22dd", title: "离开村庄", status: "done", goal: "", next: null },
		],
	};
	w.notice = {
		enabled: true,
		items: [
			{ id: "ntc-k3p9wq", text: "补写第三章的雨夜", done: false },
			{ id: "ntc-zz88yy", text: "确认林婉的年龄", done: true },
		],
	};
	return w;
}

describe("applyStorylineUpdate（发展线窄通道）", () => {
	it("按短编号指认并改状态(编号是 id 的一部分,改名不丢靶)", () => {
		const w = worldWithStoryAndNotice();
		const next = applyStorylineUpdate(w, { op: "advance", target: "aa11bb", status: "done" });
		expect(next.storyline.nodes.find((n) => n.id === "story-aa11bb")!.status).toBe("done");
	});

	it("完整 id / 标题也能指认(编号优先、名字兜底)", () => {
		const w = worldWithStoryAndNotice();
		const byFullId = applyStorylineUpdate(w, { op: "upsert_node", target: "story-cc22dd", goal: "离开村庄的动机要交代" });
		expect(byFullId.storyline.nodes.find((n) => n.id === "story-cc22dd")!.goal).toBe("离开村庄的动机要交代");
		const byTitle = applyStorylineUpdate(w, { op: "upsert_node", target: "离开村庄", status: "shelved" });
		expect(byTitle.storyline.nodes.find((n) => n.id === "story-cc22dd")!.status).toBe("shelved");
	});

	it("不给 target 就是新建(title 必填)", () => {
		const next = applyStorylineUpdate(worldWithStoryAndNotice(), {
			op: "upsert_node", title: "北上", status: "pending", goal: "找线索",
		});
		expect(next.storyline.nodes).toHaveLength(3);
		expect(next.storyline.nodes[2]!.title).toBe("北上");
		expect(() => applyStorylineUpdate(worldWithStoryAndNotice(), { op: "upsert_node" })).toThrow(/title/);
	});

	it("给了 target 却没有任何可改字段 → 报错,不静默成功", () => {
		expect(() => applyStorylineUpdate(worldWithStoryAndNotice(), { op: "upsert_node", target: "aa11bb" }))
			.toThrow(/至少要给出/);
	});

	it("指认不唯一 / 指认不到 → 抛错并列出候选(不静默取首个)", () => {
		const w = worldWithStoryAndNotice();
		w.storyline.nodes.push({ id: "story-aa11cc", title: "初入旧城", status: "pending", goal: "", next: null });
		expect(() => applyStorylineUpdate(w, { op: "advance", target: "初入旧城", status: "done" }))
			.toThrow(/匹配到 2 条/);
		expect(() => applyStorylineUpdate(w, { op: "advance", target: "不存在的节点", status: "done" }))
			.toThrow(/没有唯一匹配/);
	});

	it("delete_node 删掉建错的节点;编号不存在时抛错(不静默无操作)", () => {
		const next = applyStorylineUpdate(worldWithStoryAndNotice(), { op: "delete_node", target: "cc22dd" });
		expect(next.storyline.nodes.map((n) => n.id)).toEqual(["story-aa11bb"]);
		expect(() => applyStorylineUpdate(worldWithStoryAndNotice(), { op: "delete_node", target: "nope" }))
			.toThrow(WorldValidationError);
	});

	it("world_update 的 advance_storyline 与窄工具同口径:认短编号/标题,查不到报错且不新建(2026-10-13)", () => {
		const w = worldWithStoryAndNotice();
		// 短编号(注入块给的那个,经典模式下模型抄的就是它)—— 此前会被当成新节点 id
		const byShort = applyWorldUpdate(w, { op: "advance_storyline", id: "aa11bb", status: "done" });
		expect(byShort.storyline.nodes.find((n) => n.id === "story-aa11bb")!.status).toBe("done");
		// 标题也能命中(唯一时)
		const byTitle = applyWorldUpdate(w, { op: "advance_storyline", id: "离开村庄", status: "pending" });
		expect(byTitle.storyline.nodes.find((n) => n.id === "story-cc22dd")!.status).toBe("pending");
		// 查不到 → 报错,且**不新建**幽灵节点(此前会 push 一个 id = 传入串的节点)
		expect(() => applyWorldUpdate(w, { op: "advance_storyline", id: "9f2k1x", status: "done" }))
			.toThrow(/没有唯一匹配/);
		expect(w.storyline.nodes).toHaveLength(2);
	});

	it("指认剥方括号:注入块给的是 [aa11bb],模型连方括号抄回来也命中(2026-10-13)", () => {
		const w = worldWithStoryAndNotice();
		const viaNarrow = applyStorylineUpdate(w, { op: "advance", target: "[aa11bb]", status: "done" });
		expect(viaNarrow.storyline.nodes.find((n) => n.id === "story-aa11bb")!.status).toBe("done");
		const viaWorldUpdate = applyWorldUpdate(w, { op: "advance_storyline", id: "[story-aa11bb]", status: "done" });
		expect(viaWorldUpdate.storyline.nodes.find((n) => n.id === "story-aa11bb")!.status).toBe("done");
	});
});

describe("applyNoticeUpdate（Notice 窄通道）", () => {
	it("append 追加一条未完成待办", () => {
		const next = applyNoticeUpdate(worldWithStoryAndNotice(), { op: "append", text: "查证旧城的地图" });
		expect(next.notice.items).toHaveLength(3);
		expect(next.notice.items[2]!.done).toBe(false);
	});

	it("set_done 按短编号勾选;delete 按原文删除", () => {
		const done = applyNoticeUpdate(worldWithStoryAndNotice(), { op: "set_done", target: "k3p9wq", done: true });
		expect(done.notice.items.find((i) => i.id === "ntc-k3p9wq")!.done).toBe(true);
		const del = applyNoticeUpdate(worldWithStoryAndNotice(), { op: "delete", target: "补写第三章的雨夜" });
		expect(del.notice.items.map((i) => i.id)).toEqual(["ntc-zz88yy"]);
	});

	it("edit 改正文;空文本一律拒绝(要清掉就用 delete)", () => {
		const next = applyNoticeUpdate(worldWithStoryAndNotice(), { op: "edit", target: "k3p9wq", text: "补写第三章的雨夜(要写足 800 字)" });
		expect(next.notice.items[0]!.text).toContain("800 字");
		expect(() => applyNoticeUpdate(worldWithStoryAndNotice(), { op: "edit", target: "k3p9wq", text: "  " }))
			.toThrow(/空的/);
		expect(() => applyNoticeUpdate(worldWithStoryAndNotice(), { op: "append", text: "" })).toThrow(/空的/);
	});

	it("set_enabled 切整体注入开关", () => {
		const next = applyNoticeUpdate(worldWithStoryAndNotice(), { op: "set_enabled", enabled: false });
		expect(next.notice.enabled).toBe(false);
	});

	it("指认不唯一时抛错列候选", () => {
		const w = worldWithStoryAndNotice();
		w.notice.items.push({ id: "ntc-qq77ww", text: "补写第三章的雨夜", done: false });
		expect(() => applyNoticeUpdate(w, { op: "set_done", target: "补写第三章的雨夜", done: true }))
			.toThrow(/匹配到 2 条/);
	});
});

describe("storyline_update / notice_update 的工具外壳", () => {
	it("两个工具都暴露压平后的单一对象 schema(无 anyOf)", () => {
		for (const tool of [storylineUpdateTool, noticeUpdateTool]) {
			const flat = (tool.parameters as { properties: { update: { anyOf?: unknown } } }).properties.update;
			expect(flat.anyOf).toBeUndefined();
		}
	});

	it("normalize 按 op 校验必填", () => {
		expect(normalizeStorylineUpdate({ op: "advance", target: "aa11bb", status: "done" }).op).toBe("advance");
		expect(() => normalizeStorylineUpdate({ op: "advance", target: "aa11bb" })).toThrow(/status/);
		expect(normalizeNoticeUpdate({ op: "append", text: "x" }).op).toBe("append");
		expect(() => normalizeNoticeUpdate({ op: "append" })).toThrow(/text/);
		expect(() => normalizeNoticeUpdate({ op: "upsert_entry", title: "x" })).toThrow(/不支持的 op/);
	});

	it("端到端:确实写得进 world.json", async () => {
		setWorldUpdateBookDir(tmp);
		try {
			await saveWorld(tmp, worldWithStoryAndNotice());
			await storylineUpdateTool.execute("call", { update: { op: "advance", target: "aa11bb", status: "done" } } as never, undefined, undefined, {} as ToolContext);
			await noticeUpdateTool.execute("call", { update: { op: "append", text: "新待办" } } as never, undefined, undefined, {} as ToolContext);
			const world = await ensureWorld(tmp);
			expect(world.storyline.nodes.find((n) => n.id === "story-aa11bb")!.status).toBe("done");
			expect(world.notice.items.some((i) => i.text === "新待办")).toBe(true);
		} finally {
			setWorldUpdateBookDir(null);
		}
	});
});

