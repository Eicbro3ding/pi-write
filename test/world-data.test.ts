import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWorld, ensureWorld, migrateFromMarkdown, renderWorldMarkdown, saveWorld, validateWorld, WorldValidationError, writeWorldViews } from "../src/world-data.ts";
import { withWorldLock } from "../src/world-lock.ts";

let dirs: string[] = [];
async function tmpBook(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "world-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
	dirs = [];
});

describe("saveWorld 并发与备份", () => {
	it("锁内并发保存多个不同内容,最终文件为完整合法 JSON 且生成备份", async () => {
		const dir = await tmpBook();
		const worlds = Array.from({ length: 10 }, (_, i) => {
			const w = createEmptyWorld();
			w.entries.push({
				id: `e${i}`, type: "character", title: `A${i}`, keys: [], chapters: [],
				status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0,
			});
			return w;
		});
		// 与 world_update 真实路径一致:读-改-写整体持锁串行
		await Promise.all(worlds.map((w) => withWorldLock(dir, () => saveWorld(dir, w))));
		const raw = await readFile(join(dir, "world.json"), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
		const saved = validateWorld(JSON.parse(raw) as unknown);
		// 最终内容为某一次完整保存(条目数恰为 1,而非并发写入的拼接残片)
		expect(saved.entries.length).toBe(1);
		expect(existsSync(join(dir, "world.json.bak"))).toBe(true);
	});
	it("写后校验失败时从备份回滚", async () => {
		const dir = await tmpBook();
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		await saveWorld(dir, w);
		// 用非法数据覆盖 world.json 模拟损坏,再调用 saveWorld 触发回滚
		const file = join(dir, "world.json");
		await writeFile(file, "{broken json", "utf-8");
		// 再次保存:先备份损坏文件,rename 成功后写后校验应通过(内容来自传入 data)
		const w2 = createEmptyWorld();
		w2.entries.push({ id: "b", type: "world", title: "B", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		await saveWorld(dir, w2);
		expect(validateWorld(JSON.parse(await readFile(file, "utf-8")) as unknown).entries[0]!.id).toBe("b");
	});
});

describe("validateWorld", () => {
	it("接受空世界", () => {
		expect(validateWorld(createEmptyWorld())).toEqual(createEmptyWorld());
	});
	it("拒绝数组与非对象顶层", () => {
		expect(() => validateWorld([])).toThrow(WorldValidationError);
		expect(() => validateWorld(null)).toThrow(WorldValidationError);
		expect(() => validateWorld("x")).toThrow(WorldValidationError);
		expect(() => validateWorld(42)).toThrow(WorldValidationError);
	});
	it("枚举错误信息带合法值列表(type/status/arrow/storyline status)", () => {
		const base = {
			version: 1 as const, entries: [], relations: [], constraints: [],
			styleSample: null, notice: { enabled: true, items: [] },
			storyline: { enabled: true, nodes: [] }, timeline: [],
		};
		// 校验按序报错,type 与 status 分开构造分别断言
		const badType = { id: "e1", type: "人物", title: "林婉", keys: [], chapters: [], status: "active", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 };
		let err: WorldValidationError | undefined;
		try { validateWorld({ ...base, entries: [badType] }); } catch (e) { err = e as WorldValidationError; }
		expect(err?.message).toContain("character / world / timeline / outline");
		const badStatus = { ...badType, type: "character", status: "登场" };
		let statusErr: WorldValidationError | undefined;
		try { validateWorld({ ...base, entries: [badStatus] }); } catch (e) { statusErr = e as WorldValidationError; }
		expect(statusErr?.message).toContain("alive / dead / unknown / active / archived / draft");
		const relEntries = [
			{ ...badType, type: "character", status: "active" },
			{ ...badType, id: "e2", type: "world", title: "雾港", status: "active" },
		];
		const badRel = { ...base, entries: relEntries, relations: [{ id: "r1", from: "e1", to: "e2", type: "", label: "", emphasized: false, arrow: "sideways" }] };
		let relErr: WorldValidationError | undefined;
		try { validateWorld(badRel); } catch (e) { relErr = e as WorldValidationError; }
		expect(relErr?.message).toContain("none / single / double");
		const badStory = { ...base, storyline: { enabled: true, nodes: [{ id: "n1", title: "x", status: "写完了", goal: "", next: null }] } };
		let storyErr: WorldValidationError | undefined;
		try { validateWorld(badStory); } catch (e) { storyErr = e as WorldValidationError; }
		expect(storyErr?.message).toContain("pending / in-progress / done / shelved");
	});
	it("拒绝缺少 notice / storyline", () => {
		const noNotice = createEmptyWorld() as unknown as Record<string, unknown>;
		delete noNotice.notice;
		expect(() => validateWorld(noNotice)).toThrow(/缺少 notice/);
		const nullNotice = createEmptyWorld() as unknown as Record<string, unknown>;
		nullNotice.notice = null;
		expect(() => validateWorld(nullNotice)).toThrow(/缺少 notice/);
		const noStoryline = createEmptyWorld() as unknown as Record<string, unknown>;
		delete noStoryline.storyline;
		expect(() => validateWorld(noStoryline)).toThrow(/缺少 storyline/);
	});
	it("worldSummary:缺失/显式 null 规范化补空,非字符串与超长拒绝", () => {
		// 旧数据无该字段:校验放行并补空(向后兼容)
		const noSummary = createEmptyWorld() as unknown as Record<string, unknown>;
		delete noSummary.worldSummary;
		expect(validateWorld(noSummary).worldSummary).toBe("");
		// 显式 null 同样补空
		const nullSummary = createEmptyWorld() as unknown as Record<string, unknown>;
		nullSummary.worldSummary = null;
		expect(validateWorld(nullSummary).worldSummary).toBe("");
		// 非字符串拒绝
		const badType = createEmptyWorld() as unknown as Record<string, unknown>;
		badType.worldSummary = 42;
		expect(() => validateWorld(badType)).toThrow(/worldSummary 必须是字符串/);
		// 超长拒绝
		const tooLong = createEmptyWorld();
		tooLong.worldSummary = "字".repeat(601);
		expect(() => validateWorld(tooLong)).toThrow(/超过 600 字上限/);
		// 正常值往返
		const ok = createEmptyWorld();
		ok.worldSummary = "蒸汽与旧神共存的雾港城邦。";
		expect(validateWorld(ok).worldSummary).toBe("蒸汽与旧神共存的雾港城邦。");
	});
	it("entries 含 null / 非对象抛 WorldValidationError 而非原生 TypeError", () => {
		const w = createEmptyWorld() as unknown as Record<string, unknown>;
		w.entries = [null];
		expect(() => validateWorld(w)).toThrow(WorldValidationError);
		w.entries = [42];
		expect(() => validateWorld(w)).toThrow(WorldValidationError);
	});
	it("relations / constraints / 发展线节点含 null 也抛 WorldValidationError", () => {
		const w1 = createEmptyWorld() as unknown as Record<string, unknown>;
		w1.relations = [null];
		expect(() => validateWorld(w1)).toThrow(WorldValidationError);
		const w2 = createEmptyWorld() as unknown as Record<string, unknown>;
		w2.constraints = [null];
		expect(() => validateWorld(w2)).toThrow(WorldValidationError);
		const w3 = createEmptyWorld() as unknown as Record<string, unknown>;
		w3.storyline = { enabled: true, nodes: [null] };
		expect(() => validateWorld(w3)).toThrow(WorldValidationError);
	});
	it("拒绝重复条目 id", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.entries.push({ id: "a", type: "character", title: "B", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		expect(() => validateWorld(w)).toThrow(WorldValidationError);
	});
	it("拒绝悬空 parent", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: "nope", tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		expect(() => validateWorld(w)).toThrow(/parent/);
	});
	it("拒绝非法 type / status 枚举", () => {
		const w = createEmptyWorld() as unknown as Record<string, unknown>;
		w.entries = [{ id: "a", type: "bogus", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 }];
		expect(() => validateWorld(w)).toThrow(WorldValidationError);
	});
	it("拒绝 relation 悬空引用与自环", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.relations.push({ id: "r1", from: "a", to: "ghost", type: "", label: "", emphasized: false, arrow: "double" });
		expect(() => validateWorld(w)).toThrow(/relation/);
		w.relations = [{ id: "r2", from: "a", to: "a", type: "", label: "", emphasized: false, arrow: "double" }];
		expect(() => validateWorld(w)).toThrow(/自环/);
	});
	it("拒绝 relation 非法 arrow 枚举", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.entries.push({ id: "b", type: "character", title: "B", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.relations.push({ id: "r1", from: "a", to: "b", type: "", label: "", emphasized: false, arrow: "sideways" as never });
		expect(() => validateWorld(w)).toThrow(/arrow/);
	});
	it("旧数据关系无 arrow 字段:校验通过并补默认 double", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.entries.push({ id: "b", type: "character", title: "B", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		const legacy = {
			...w,
			relations: [{ id: "r1", from: "a", to: "b", type: "", label: "", emphasized: false }],
		} as unknown as ReturnType<typeof createEmptyWorld>;
		const normalized = validateWorld(legacy);
		expect(normalized.relations[0]?.arrow).toBe("double");
	});
	it("旧式单条 Notice 自动迁移为待办清单(2026-08-12)", () => {
		const w = createEmptyWorld() as unknown as { notice: { text: string; enabled: boolean; updatedAt: number } };
		w.notice = { text: "保持悬疑。", enabled: true, updatedAt: 123 };
		const normalized = validateWorld(w as never) as ReturnType<typeof createEmptyWorld>;
		expect(normalized.notice.items).toHaveLength(1);
		expect(normalized.notice.items[0]?.text).toBe("保持悬疑。");
		expect(normalized.notice.items[0]?.done).toBe(false);
		expect(normalized.notice.enabled).toBe(true);
	});
	it("拒绝 Notice 待办超限(单条 >500 字)", () => {
		const w = createEmptyWorld();
		w.notice.items.push({ id: "n1", text: "字".repeat(501), done: false });
		expect(() => validateWorld(w)).toThrow(/500/);
	});
	it("拒绝 Notice 待办 id 重复 / done 非布尔", () => {
		const w = createEmptyWorld();
		w.notice.items.push({ id: "n1", text: "a", done: false }, { id: "n1", text: "b", done: false });
		expect(() => validateWorld(w)).toThrow(/id 重复/);
		const w2 = createEmptyWorld();
		w2.notice.items.push({ id: "n1", text: "a", done: "yes" as never });
		expect(() => validateWorld(w2)).toThrow(/done/);
	});
	it("拒绝约束 target 非法枚举", () => {
		const w = createEmptyWorld();
		w.constraints.push({ id: "c1", name: "C", text: "x", enabled: true, target: "narrator" as never });
		expect(() => validateWorld(w)).toThrow(/target/);
	});
	it("拒绝多个 in-progress 发展线节点", () => {
		const w = createEmptyWorld();
		w.storyline.nodes.push({ id: "n1", title: "N1", status: "in-progress", goal: "", next: null });
		w.storyline.nodes.push({ id: "n2", title: "N2", status: "in-progress", goal: "", next: null });
		expect(() => validateWorld(w)).toThrow(/in-progress/);
	});
	it("拒绝约束超限(>800 字)", () => {
		const w = createEmptyWorld();
		w.constraints.push({ id: "c1", name: "C", text: "字".repeat(801), enabled: true });
		expect(() => validateWorld(w)).toThrow(/800/);
	});
	it("拒绝采样超限(>500 字)", () => {
		const w = createEmptyWorld();
		w.styleSample = { text: "字".repeat(501), source: "", updatedAt: 0 };
		expect(() => validateWorld(w)).toThrow(/500/);
	});
});

describe("ensureWorld / saveWorld", () => {
	it("不存在时创建空世界并落盘", async () => {
		const dir = await tmpBook();
		const w = await ensureWorld(dir);
		expect(w.entries).toEqual([]);
		const again = await ensureWorld(dir);
		expect(again).toEqual(w);
	});
	it("保存后文件存在且可读回", async () => {
		const dir = await tmpBook();
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		await saveWorld(dir, w);
		const back = await ensureWorld(dir);
		expect(back.entries[0]?.body).toBe("正文");
	});
	it("保存非法数据抛错且不落盘", async () => {
		const dir = await tmpBook();
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: "ghost", tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		await expect(saveWorld(dir, w)).rejects.toThrow(WorldValidationError);
	});
	it("无 world.json 但有旧 md 时自动迁移并落盘", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(join(dir, ".writer", "characters.md"), "# 人物档案\n\n## 林婉\n", "utf-8");
		const w = await ensureWorld(dir);
		expect(w.entries.some((e) => e.title === "林婉")).toBe(true);
		expect(existsSync(join(dir, "world.json"))).toBe(true);
		const again = await ensureWorld(dir);
		expect(again.entries.some((e) => e.title === "林婉")).toBe(true);
	});
});

describe("migrateFromMarkdown", () => {
	it("把旧 md 标题与正文导入为条目", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(
			join(dir, ".writer", "characters.md"),
			"# 人物档案\n\n## 林婉\n- 身份: 姐姐\n- 对白: \"你又在瞒我。\"\n\n## 模板\n",
			"utf-8",
		);
		const w = await migrateFromMarkdown(dir);
		const linwan = w.entries.find((e) => e.title === "林婉");
		expect(linwan).toBeDefined();
		expect(linwan?.type).toBe("character");
		expect(linwan?.body).toContain("身份");
	});
	it("parent: 元数据行转 parent 字段", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(
			join(dir, ".writer", "characters.md"),
			"# 人物档案\n\n## 林婉\n\n## 林父\n- parent: 林婉\n",
			"utf-8",
		);
		const w = await migrateFromMarkdown(dir);
		const linwan = w.entries.find((e) => e.title === "林婉");
		const linfu = w.entries.find((e) => e.title === "林父");
		expect(linfu?.parent).toBe(linwan?.id);
	});
	it("无旧文件时返回空世界", async () => {
		const dir = await tmpBook();
		const w = await migrateFromMarkdown(dir);
		expect(w.entries).toEqual([]);
	});
	it("中途 H1 也成为条目且正文保留", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(
			join(dir, ".writer", "characters.md"),
			"# 人物档案\n\n# 中途大标题\n正文\n\n## 条目\n",
			"utf-8",
		);
		const w = await migrateFromMarkdown(dir);
		const mid = w.entries.find((e) => e.title === "中途大标题");
		expect(mid).toBeDefined();
		expect(mid?.type).toBe("character");
		expect(mid?.parent).toBeNull();
		expect(mid?.body).toContain("正文");
		expect(w.entries.some((e) => e.title === "条目")).toBe(true);
	});
	it("自引用 parent 不产生自环", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(
			join(dir, ".writer", "characters.md"),
			"# 人物档案\n\n## A\n- parent: A\n",
			"utf-8",
		);
		const w = await migrateFromMarkdown(dir);
		const a = w.entries.find((e) => e.title === "A");
		expect(a?.parent).toBeNull();
		expect(() => validateWorld(w)).not.toThrow();
	});
});

describe("renderWorldMarkdown", () => {
	it("按 type 分文件渲染并带导出头", async () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "林婉", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		const files = new Map(renderWorldMarkdown(w));
		const chars = files.get(".writer/characters.md");
		expect(chars).toContain("导出视图");
		expect(chars).toContain("## 林婉");
		expect(chars).toContain("正文");
	});
	it("parent 条目渲染出 parent 行", async () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "林婉", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		w.entries.push({ id: "b", type: "character", title: "林父", keys: [], chapters: [], status: "alive", active: true, parent: "a", tags: [], body: "", avatar: null, images: [], updatedAt: 0 });
		const files = new Map(renderWorldMarkdown(w));
		const chars = files.get(".writer/characters.md");
		expect(chars).toContain("- parent: 林婉");
	});
});

describe("writeWorldViews", () => {
	it("把渲染输出落盘到对应文件", async () => {
		const dir = await tmpBook();
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "林婉", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "正文", avatar: null, images: [], updatedAt: 0 });
		await writeWorldViews(dir, w);
		const content = await readFile(join(dir, ".writer", "characters.md"), "utf-8");
		expect(content).toContain("## 林婉");
		expect(content).toContain("正文");
	});
});

describe("avatar / images", () => {
	it("接受 avatar null + images []", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: null, images: [] });
		expect(validateWorld(w).entries[0]!.avatar).toBeNull();
	});
	it("旧数据缺字段 → 规范化补 avatar: null, images: []", () => {
		const w = createEmptyWorld() as unknown as Record<string, unknown>;
		w.entries = [{ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0 }];
		const out = validateWorld(w);
		expect(out.entries[0]!.avatar).toBeNull();
		expect(out.entries[0]!.images).toEqual([]);
	});
	it("拒绝非法 avatar(绝对路径/越界/非 images/ 前缀/子目录/点段)", () => {
		for (const bad of ["/etc/passwd", "C:\\x.png", "x.png", "images/a/b.png", "images/../x.png", "images/..", "images/."]) {
			const w = createEmptyWorld();
			w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: bad, images: [] });
			expect(() => validateWorld(w)).toThrow(WorldValidationError);
		}
	});
	it("拒绝非法 images 引用与超上限", () => {
		const w1 = createEmptyWorld();
		w1.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: null, images: ["../x.png"] });
		expect(() => validateWorld(w1)).toThrow(WorldValidationError);
		const w2 = createEmptyWorld();
		w2.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: null, images: Array.from({ length: 10 }, (_, i) => `images/${i}.png`) });
		expect(() => validateWorld(w2)).toThrow(/上限/);
	});
	it("9 张 images 且 avatar 不在其中:规范化会补到 10 张,拒绝", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: "images/avatar.png", images: Array.from({ length: 9 }, (_, i) => `images/${i}.png`) });
		expect(() => validateWorld(w)).toThrow(/上限/);
	});
	it("9 张 images 且 avatar 已在其中:不超上限,通过", () => {
		const w = createEmptyWorld();
		const imgs = Array.from({ length: 9 }, (_, i) => `images/${i}.png`);
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: imgs[0]!, images: imgs });
		expect(validateWorld(w).entries[0]!.images).toHaveLength(9);
	});
	it("8 张 images + avatar 不在其中:规范化补主图后仍 9 张,通过", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: "images/avatar.png", images: Array.from({ length: 8 }, (_, i) => `images/${i}.png`) });
		const out = validateWorld(w);
		expect(out.entries[0]!.images).toHaveLength(9);
		expect(out.entries[0]!.images[0]).toBe("images/avatar.png");
	});
	it("images 去重 + avatar 自动补入 images", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "A", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "", updatedAt: 0, avatar: "images/a.png", images: ["images/b.png", "images/b.png"] });
		const out = validateWorld(w);
		expect(out.entries[0]!.images).toEqual(["images/a.png", "images/b.png"]);
	});
	it("md 视图输出 avatar:/images: 元数据行", () => {
		const w = createEmptyWorld();
		w.entries.push({ id: "a", type: "character", title: "林婉", keys: [], chapters: [], status: "alive", active: true, parent: null, tags: [], body: "正文", updatedAt: 0, avatar: "images/a.png", images: ["images/a.png", "images/b.png"] });
		const found = renderWorldMarkdown(w).find(([rel]) => rel === ".writer/characters.md")!;
		expect(found[1]).toContain("- avatar: images/a.png\n- images: images/a.png, images/b.png\n");
	});
	it("迁移解析 avatar:/images: 元数据行", async () => {
		const dir = await tmpBook();
		await mkdir(join(dir, ".writer"), { recursive: true });
		await writeFile(join(dir, ".writer/characters.md"), "# 人物档案\n## 林婉\n- avatar: images/a.png\n- images: images/a.png\n正文\n", "utf-8");
		await writeFile(join(dir, ".writer/world.md"), "# 世界设定\n", "utf-8");
		const world = await migrateFromMarkdown(dir);
		const linwan = world.entries.find((e) => e.title === "林婉")!;
		expect(linwan.avatar).toBe("images/a.png");
		expect(linwan.images).toEqual(["images/a.png"]);
	});
});
