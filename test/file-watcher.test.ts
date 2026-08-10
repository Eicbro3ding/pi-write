import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldWatcher } from "../src/web/file-watcher.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-watch-"));
	vi.stubEnv("PI_WRITER_DIR", tmp); // watcher 经 getBookDir 定位书目录
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

/** 造一个书目录:books/<slug>/{world.json,draft/ch01.md}。 */
function makeBook(slug: string): { slug: string; bookDir: string; world: string; draft: string } {
	const bookDir = join(tmp, "books", slug);
	mkdirSync(join(bookDir, "draft"), { recursive: true });
	const world = join(bookDir, "world.json");
	const draft = join(bookDir, "draft", "ch01.md");
	writeFileSync(world, "{}", "utf-8");
	writeFileSync(draft, "# 第一章\n", "utf-8");
	return { slug, bookDir, world, draft };
}

describe("WorldWatcher", () => {
	it("首次扫描只登记不广播;外部修改触发回调(带 mtime)", async () => {
		const { slug, draft } = makeBook("书一");
		const events: Array<{ kind: string; rel: string }> = [];
		const watcher = new WorldWatcher((kind, rel) => events.push({ kind, rel }), 50);
		await watcher.setBook(slug); // 静默扫描:登记已知状态
		expect(events).toHaveLength(0);

		await watcher.tick(); // 无变化:仍无广播
		expect(events).toHaveLength(0);

		writeFileSync(draft, "# 第一章\n\nAI 新增的一段。", "utf-8"); // 外部(模拟 AI 工具)修改
		await watcher.tick();
		expect(events).toEqual([{ kind: "draft", rel: "draft/ch01.md" }]);
		watcher.dispose();
	});

	it("world.json 与多个草稿文件都监听", async () => {
		const { slug, world, bookDir } = makeBook("书二");
		writeFileSync(join(bookDir, "draft", "ch02.md"), "第二章", "utf-8");
		const events: Array<{ kind: string; rel: string }> = [];
		const watcher = new WorldWatcher((kind, rel) => events.push({ kind, rel }), 50);
		await watcher.setBook(slug);

		writeFileSync(world, '{"entries":[]}', "utf-8");
		writeFileSync(join(bookDir, "draft", "ch02.md"), "第二章(改)", "utf-8");
		await watcher.tick();
		expect(events).toEqual([
			{ kind: "world", rel: "world.json" },
			{ kind: "draft", rel: "draft/ch02.md" },
		]);
		watcher.dispose();
	});

	it("文件被删除也触发回调(前端据此重载)", async () => {
		const { slug, draft } = makeBook("书三");
		const events: Array<{ rel: string }> = [];
		const watcher = new WorldWatcher((_kind, rel) => events.push({ rel }), 50);
		await watcher.setBook(slug);

		rmSync(draft);
		await watcher.tick();
		expect(events).toEqual([{ rel: "draft/ch01.md" }]);
		watcher.dispose();
	});

	it("noteWritten 登记后不重复广播(服务端自己写入)", async () => {
		const { slug, draft } = makeBook("书四");
		const events: Array<{ rel: string }> = [];
		const watcher = new WorldWatcher((_kind, rel) => events.push({ rel }), 50);
		await watcher.setBook(slug);

		writeFileSync(draft, "服务端保存的内容", "utf-8");
		await watcher.noteWritten(draft); // 服务端自己的写入:登记
		await watcher.tick();
		expect(events).toHaveLength(0); // 不重复广播

		writeFileSync(draft, "AI 又改了", "utf-8"); // 之后的外部修改仍会广播
		await watcher.tick();
		expect(events).toEqual([{ rel: "draft/ch01.md" }]);
		watcher.dispose();
	});

	it("setBook 切换书后只监听新书;无 slug 时跳过", async () => {
		const a = makeBook("书甲");
		const b = makeBook("书乙");
		const events: Array<{ rel: string }> = [];
		const watcher = new WorldWatcher((_kind, rel) => events.push({ rel }), 50);
		await watcher.setBook(a.slug);

		writeFileSync(a.draft, "甲改", "utf-8");
		writeFileSync(b.draft, "乙改", "utf-8");
		await watcher.tick();
		expect(events).toEqual([{ rel: "draft/ch01.md" }]); // 只报甲

		events.length = 0;
		await watcher.setBook(b.slug); // 切书:重置登记
		writeFileSync(a.draft, "甲再改", "utf-8");
		writeFileSync(b.draft, "乙再改", "utf-8");
		await watcher.tick();
		expect(events).toEqual([{ rel: "draft/ch01.md" }]); // 现在只报乙

		events.length = 0;
		await watcher.setBook(null); // 无书:全部跳过
		writeFileSync(b.draft, "乙又改", "utf-8");
		await watcher.tick();
		expect(events).toHaveLength(0);
		watcher.dispose();
	});
});
