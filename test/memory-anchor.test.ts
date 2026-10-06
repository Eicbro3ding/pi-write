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
import { buildMemoryAnchor, echoUserMessages } from "../src/extension.ts";
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

	it("memory.md 内容进锚;**Notice 与发展线不进锚** —— 它们已归格 B / 格 C", async () => {
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
		// 2026-10-06 分诊收口:锚只装跨轮恒定的事实(模式行/章节/memory.md)。
		// Notice 归格 B(稳定块)、发展线归格 C(每轮易变块)—— 锚是每轮注入,
		// 把它们放这里等于每轮重付一次,且会破坏锚「内容稳定可缓存」的前提。
		expect(anchor).not.toContain("回收「信物」伏笔");
		expect(anchor).not.toContain("当前位置: 查明白塔的来历");
		expect(anchor).not.toContain("抵达雾港");
	});

	it("会话模式行进锚,且独立于世界状态 —— 空书也拿得到「不要写文件」的约束", async () => {
		// 关键判据:模式约束不能挂在「这本书有没有写 memory.md」上。
		// 用户喊停最常发生在刚开章、世界书还空着的时候,那时恰恰最需要这条约束。
		await mkdir(getBookDir("fog-harbor"), { recursive: true });
		const anchor = await buildMemoryAnchor("fog-harbor", "ch01.jsonl", "discussing");
		expect(anchor).toContain("【当前模式】讨论态");
		expect(anchor).toContain("不要创建、写入、清空或覆盖任何文件");
		expect(anchor).toContain("当前章节: ch01.jsonl");
	});

	it("模式行排在记忆锚最前(先看到能不能写,再看世界状态)", async () => {
		const slug = "fog-harbor";
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		await writeFile(join(bookDir, "memory.md"), "- 一条记忆", "utf8");
		const anchor = await buildMemoryAnchor(slug, "ch02.jsonl", "writing");
		expect(anchor).toContain("【当前模式】写作态");
		expect(anchor.indexOf("【当前模式】")).toBeLessThan(anchor.indexOf("跨章节记忆"));
		expect(anchor.indexOf("【当前模式】")).toBeLessThan(anchor.indexOf("当前章节"));
	});

	it("不传模式 + 空世界 → 空串(章节行单独不构成锚,钩子据此跳过注入)", async () => {
		// 判据与 2026-10-06 收口前逐字一致:只有模式行或块才算内容。
		// 只有章节名而无任何记忆/模式时注入锚 = 纯噪声,且每轮白付一次未缓存输入。
		await mkdir(getBookDir("fog-harbor"), { recursive: true });
		expect(await buildMemoryAnchor("fog-harbor", "ch01.jsonl")).toBe("");
	});

	it("有 Notice/发展线但无 memory.md、无模式 → 仍为**空串**(那两块已不归锚)", async () => {
		// 这条钉住分诊收口的一个边界:过去 Notice/发展线能单独撑起一个锚,
		// 现在它们归格 B/C —— 锚这边什么都不剩,必须老实返回空串。
		const slug = "fog-harbor";
		const bookDir = getBookDir(slug);
		await mkdir(bookDir, { recursive: true });
		const world = await ensureWorld(bookDir);
		await saveWorld(bookDir, {
			...world,
			notice: { enabled: true, items: [{ id: "n1", text: "一条待办", done: false }] },
			storyline: {
				...world.storyline,
				enabled: true,
				nodes: [{ id: "s1", title: "目标", status: "in-progress", goal: "", next: "" }],
			},
		});
		expect(await buildMemoryAnchor(slug, "ch01.jsonl")).toBe("");
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

describe("echoUserMessages(压缩时保住用户原话)", () => {
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as never;
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as never;

	it("只取用户消息,按时间顺序原样保留(助手的话不占额度)", () => {
		const echo = echoUserMessages([user("第一句"), assistant("助手的回答"), user("第二句")] as never);
		expect(echo).toContain("- 第一句");
		expect(echo).toContain("- 第二句");
		expect(echo).not.toContain("助手的回答");
		expect(echo.indexOf("- 第一句")).toBeLessThan(echo.indexOf("- 第二句"));
	});

	it("无用户消息 → 空串(钩子据此交回 vendor 默认摘要)", () => {
		expect(echoUserMessages([assistant("只有助手")] as never)).toBe("");
		expect(echoUserMessages([] as never)).toBe("");
	});

	it("空白内容不占额度", () => {
		expect(echoUserMessages([user("   ")] as never)).toBe("");
	});

	it("超出上限时保留**较新**的(最早的通常已沉淀进 memory/世界书)", () => {
		const old = "旧".repeat(6500); // 单条就超过 6000 上限
		const fresh = "新设定:主角左眼是义眼";
		const echo = echoUserMessages([user(old), user(fresh)] as never);
		expect(echo).toContain(fresh); // 最新的必留
		expect(echo).not.toContain(old); // 挤爆额度的旧话被弃
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
