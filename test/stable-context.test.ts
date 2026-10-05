/**
 * 稳定上下文的**多版本治理**(2026-10-05,P1-2)。
 *
 * 真实会话 `writer-c-v05ij1` 里,同一个「写作稳定上下文」被注入了 **16 份**
 * (760 → 3885 字),全部并存在 leaf 链上,每一份都自称「长期有效」,而第 1 份和
 * 第 16 份对同一个人物的描写已经不同了。
 *
 * 成因不是「没做去重」—— `syncStableContext` 有指纹去重。成因是**这本该书改成
 * 那样时它就变了**:世界书每改动一次,稳定块内容就变、指纹就变,于是再注入一份,
 * 而旧的没删。所以「稳定块」并不稳定。
 *
 * 这里不删旧条目(custom 消息已落进会话树并被 ack,parentId 链不能断),而是让
 * 新版本把话说清楚:**我是第几版,旧的是废的**。
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { countStableContextInLeaf, renderStableContext, stableFingerprint } from "../src/web/writer-host.ts";
import { getBookSessionsDir } from "../src/book-manager.ts";

let tmpRoot: string;
beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "piw-stable-ctx-"));
	vi.stubEnv("PI_WRITER_DIR", tmpRoot);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一份会话文件:前 n 条是历史版本,后 2 条是普通对话(拉开 leaf 链的形状)。 */
function writeSession(slug: string, conversationId: string, versions: number): string {
	const dir = getBookSessionsDir(slug);
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, `writer-${conversationId}.jsonl`);
	const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: dir },
	];
	let parentId: string | null = null;
	for (let i = 1; i <= versions; i++) {
		lines.push({
			type: "custom_message",
			id: `c${i}`,
			parentId,
			timestamp: at(i),
			customType: "world-context",
			content: [{ type: "text", text: `【写作稳定上下文 · 指纹 aaaa00${i}】第 ${i} 份设定` }],
			display: true,
			details: undefined,
		});
		parentId = `c${i}`;
	}
	lines.push({ type: "message", id: "u1", parentId, timestamp: at(99), message: { role: "user", content: [{ type: "text", text: "接着聊" }], timestamp: 1700000000099 } });
	writeFileSync(abs, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
	return abs;
}

describe("countStableContextInLeaf(数清楚已经堆了几份)", () => {
	it("会话文件不存在 → 0", () => {
		expect(countStableContextInLeaf("fog-harbor", "ch01")).toBe(0);
	});

	it("一份没有 → 0", () => {
		const abs = writeSession("fog-harbor", "ch01", 0);
		expect(existsSync(abs)).toBe(true);
		expect(countStableContextInLeaf("fog-harbor", "ch01")).toBe(0);
	});

	it("数出 leaf 链上已有的版本数(16 份那个真实场景)", () => {
		writeSession("fog-harbor", "ch02", 16);
		expect(countStableContextInLeaf("fog-harbor", "ch02")).toBe(16);
	});

	it("同 customType 的其他注入(背景包/压缩补偿)不算进稳定上下文", () => {
		const slug = "fog-harbor";
		const dir = getBookSessionsDir(slug);
		mkdirSync(dir, { recursive: true });
		const at = (ms: number) => new Date(1700000000000 + ms).toISOString();
		const lines = [
			{ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: dir },
			{ type: "custom_message", id: "a1", parentId: null, timestamp: at(1), customType: "world-context", content: [{ type: "text", text: "【世界书·本章相关】切章背景包" }], display: true, details: undefined },
			{ type: "custom_message", id: "a2", parentId: "a1", timestamp: at(2), customType: "world-context", content: [{ type: "text", text: "【写作稳定上下文 · 指纹 deadbeef】设定" }], display: true, details: undefined },
		];
		writeFileSync(join(dir, "writer-ch03.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
		expect(countStableContextInLeaf(slug, "ch03")).toBe(1);
	});

	it("会话文件损坏 → 0(宁可多标一版,也不阻塞注入)", () => {
		const dir = getBookSessionsDir("fog-harbor");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "writer-ch04.jsonl"), "{ 这不是 json\n", "utf8");
		expect(countStableContextInLeaf("fog-harbor", "ch04")).toBe(0);
	});
});

describe("renderStableContext(牌子必须挂清楚)", () => {
	const stable = "【世界观概述】1880 年代架空蒸汽工业时代。";

	it("缺一不可:版本可比较 + 取代语义明确 + 稳定正文完整", () => {
		const text = renderStableContext(true, stable, 17);
		// 版本号:多份并存时唯一可比的依据
		expect(text).toContain("第 17 版");
		// 取代语义:只给版本号不够,模型看到多份「长期有效」会自己挑
		expect(text).toContain("取代此前所有同名条目");
		expect(text).toContain("只以**版本号最大**的这一条为准");
		// 稳定块正文必须原样带上
		expect(text).toContain(stable);
	});

	it("稳定正文完整保留,不被版本声明挤掉", () => {
		const text = renderStableContext(false, stable, 2);
		expect(text.endsWith(stable)).toBe(true);
	});

	it("写作态与编剧态的角色名不同(上下文里两个宿主可能并存)", () => {
		expect(renderStableContext(true, stable, 1)).toContain("写作稳定上下文");
		expect(renderStableContext(false, stable, 1)).toContain("编剧稳定上下文");
	});

	it("版本号单调:第 1 版不含「第 0 版」字样", () => {
		expect(renderStableContext(true, stable, 1)).toContain("第 1 版");
		expect(renderStableContext(true, stable, 1)).not.toContain("第 0 版");
	});
});

/**
 * 版本号要能盖现存条目,所以**必须**走得比已有份数多一。
 * 这条把「新版本 = count + 1」的组合行为钉住 —— 分开测两个函数,测不出组合错。
 */
describe("版本递增的组合行为", () => {
	it("已有 16 份时新注入标为第 17 版", () => {
		writeSession("fog-harbor", "ch05", 16);
		const next = countStableContextInLeaf("fog-harbor", "ch05") + 1;
		const text = renderStableContext(true, "设定", next);
		expect(text).toContain("第 17 版");
	});

	it("首次注入标为第 1 版", () => {
		writeSession("fog-harbor", "ch06", 0);
		const next = countStableContextInLeaf("fog-harbor", "ch06") + 1;
		expect(renderStableContext(true, "设定", next)).toContain("第 1 版");
	});
});

describe("stableFingerprint(去重基石不变)", () => {
	it("同样的内容给出同样的指纹;改动一个字就变", () => {
		const a = stableFingerprint("同一份设定");
		expect(a).toBe(stableFingerprint("同一份设定"));
		expect(a).not.toBe(stableFingerprint("同一份设定。"));
	});

	it("8 位十六进制(放进标题里要短)", () => {
		expect(stableFingerprint("任意文本")).toMatch(/^[0-9a-f]{8}$/);
	});
});
