/**
 * 失忆修复(2026-10-05)的两个锚点测试:
 *
 * 1. buildMemoryAnchor —— before_agent_start 每轮追加进 systemPrompt 的常驻
 *    记忆锚(治「没压缩也忘」:lost in the middle)。
 * 2. sessionLeafHasWorldContext —— 压缩补偿的判据(治「压缩后忘」:背景包
 *    被移出 leaf 链后 ensureChapterContext 据此补注入)。
 *
 * fixture 全部隔离在临时 PI_WRITER_DIR,不碰真实 ~/.pi/writer。
 */
	import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryAnchor } from "../src/extension.ts";
import { sessionLeafHasWorldContext } from "../src/web/server.ts";
import { getBookDir } from "../src/config.ts";
import { getBookSessionsDir } from "../src/book-manager.ts";
import { ensureWorld, saveWorld } from "../src/world-data.ts";

let tmpRoot: string;
beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "piw-memory-anchor-"));
	vi.stubEnv("PI_WRITER_DIR", tmpRoot);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildMemoryAnchor(每轮记忆锚)", () => {
	it("空书目录(无 memory.md / 世界书):返回空串,钩子据此跳过注入", async () => {
		await mkdir(getBookDir("fog-harbor"), { recursive: true });
		expect(await buildMemoryAnchor("fog-harbor", "ch01.jsonl")).toBe("");
	});

	it("memory.md 内容进锚;Notice 只带未完成项;发展线带当前位置与目标", async () => {
		const slug = "fog-harbor";
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		await writeFile(join(bookDir, "memory.md"), "- 主角林婉的剑叫「婉姐的剑」\n- 用户要求:战斗场面不写血腥细节", "utf8");
		const world = await ensureWorld(bookDir);
		await saveWorld(bookDir, {
			...world,
			notice: {
				enabled: true,
				items: [
					{ id: "n1", text: "第三卷结尾要回收「信物」伏笔", done: false },
					{ id: "n2", text: "已处理:主角受设定", done: true },
				],
			},
			storyline: {
				...world.storyline,
				enabled: true,
				nodes: [
					{ id: "s1", title: "抵达雾港", status: "done", goal: "", next: "" },
					{ id: "s2", title: "查明白塔的来历", status: "in-progress", goal: "找到塔内档案", next: "夜探档案室" },
				],
			},
		});

		const anchor = await buildMemoryAnchor(slug, "ch03.jsonl");
		expect(anchor).toContain("常驻记忆锚");
		expect(anchor).toContain("当前章节: ch03.jsonl");
		expect(anchor).toContain("林婉");
		expect(anchor).toContain("战斗场面不写血腥细节");
		expect(anchor).toContain("回收「信物」伏笔");
		expect(anchor).not.toContain("主角受设定"); // done 项不注入
		expect(anchor).toContain("当前位置: 查明白塔的来历");
		expect(anchor).toContain("目标: 找到塔内档案");
		expect(anchor).toContain("抵达雾港"); // 已完成里程碑出现在「勿重复」列表
	});

	it("无当前章节(book 模式未声明)也可注入,只是省略章节行", async () => {
		const slug = "fog-harbor";
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		await writeFile(join(bookDir, "memory.md"), "- 一条记忆", "utf8");
		const anchor = await buildMemoryAnchor(slug, undefined);
		expect(anchor).toContain("一条记忆");
		expect(anchor).not.toContain("当前章节");
	});
});

describe("sessionLeafHasWorldContext(压缩补偿判据)", () => {
	/** 造一份最小可解析的章节会话 jsonl(结构对齐 session-tree.test.ts 的真文件用例)。 */
	function writeSession(slug: string, chapterFile: string, entries: unknown[]): string {
		const dir = getBookSessionsDir(slug);
		mkdirSync(dir, { recursive: true });
		const abs = join(dir, chapterFile);
		const lines = [{ type: "session", version: 3, id: "s1", timestamp: new Date(0).toISOString(), cwd: dir }, ...entries];
		writeFileSync(abs, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
		return abs;
	}

	it("会话文件不存在 → false(视为未注入,触发补注入)", () => {
		expect(sessionLeafHasWorldContext("fog-harbor", "ch01.jsonl")).toBe(false);
	});

	it("leaf 链含 world-context custom_message → true", () => {
		const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
		writeSession("fog-harbor", "ch02.jsonl", [
			{
				type: "custom_message",
				id: "c1",
				parentId: null,
				timestamp: at(0),
				customType: "world-context",
				content: [{ type: "text", text: "【世界观】雾港…" }],
				display: true,
				details: undefined,
			},
			{
				type: "message",
				id: "u1",
				parentId: "c1",
				timestamp: at(1),
				message: { role: "user", content: [{ type: "text", text: "开始写" }], timestamp: 1700000000001 },
			},
		]);
		expect(sessionLeafHasWorldContext("fog-harbor", "ch02.jsonl")).toBe(true);
	});

	it("leaf 链只有普通消息(背景包被压缩移出后的形态)→ false,据此补注入", () => {
		const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
		writeSession("fog-harbor", "ch03.jsonl", [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: at(0),
				message: { role: "user", content: [{ type: "text", text: "压缩后的对话" }], timestamp: 1700000000000 },
			},
		]);
		expect(sessionLeafHasWorldContext("fog-harbor", "ch03.jsonl")).toBe(false);
	});

	it("其他 customType 的 custom 消息不算背景包", () => {
		const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
		writeSession("fog-harbor", "ch04.jsonl", [
			{
				type: "custom_message",
				id: "c1",
				parentId: null,
				timestamp: at(0),
				customType: "some-other-extension",
				content: [{ type: "text", text: "别的扩展的消息" }],
				display: true,
				details: undefined,
			},
		]);
		expect(sessionLeafHasWorldContext("fog-harbor", "ch04.jsonl")).toBe(false);
	});
});
