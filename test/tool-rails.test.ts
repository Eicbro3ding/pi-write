/**
 * 工具护栏(2026-10-05,writer-c-v05ij1 复盘后的兜底)。
 *
 * 这些用例盯的是「提示词拦不住、必须在工具层兜住」的两类事故:
 *   A. write 空内容静默清空正文(L118 计到 2824 字 → L123 write 0 字节)
 *   B. read 带 offset 循环翻整章(117 次,翻到 offset 越界还在翻)
 * 每条拦截都必须给出路 —— 没有出路的拦截只会让模型换个参数继续绕。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	READ_FILE_LIMIT,
	guardRead,
	guardWrite,
	isDraftRel,
	relOf,
	resetReadRails,
	writeDeltaLine,
} from "../src/tool-rails.ts";

const bookDir = mkdtempSync(join(tmpdir(), "pi-writer-rails-"));

describe("guardWrite —— 拦空内容覆盖", () => {
	it("空内容写正文:拦截,且理由里给出 edit 这条出路", () => {
		const reason = guardWrite({ path: "draft/ch02.md", content: "" }, bookDir);
		expect(reason).not.toBeNull();
		expect(reason).toContain("整体替换");
		expect(reason).toContain("draft/ch02.md");
		expect(reason).toContain("edit");
	});

	it("纯空白也算空(换行不构成正文)", () => {
		expect(guardWrite({ path: "draft/ch02.md", content: "  \n\n  " }, bookDir)).not.toBeNull();
	});

	it("有内容:放行(整体重写是合法需求,不能堵死)", () => {
		expect(guardWrite({ path: "draft/ch02.md", content: "正文内容" }, bookDir)).toBeNull();
	});

	it("书目录外的路径:交回路径守卫,不在这里判", () => {
		expect(guardWrite({ path: "/etc/passwd", content: "" }, bookDir)).toBeNull();
	});

	it("path 缺失或非字符串:不干预", () => {
		expect(guardWrite({ content: "" }, bookDir)).toBeNull();
		expect(guardWrite(undefined, bookDir)).toBeNull();
	});
});

describe("guardRead —— 拦读取循环", () => {
	beforeEach(() => {
		resetReadRails();
	});

	it("首次读:放行", () => {
		expect(guardRead({ path: "draft/ch02.md", offset: 1 }, bookDir)).toBeNull();
	});

	it("同一区间读第二次:拦截,且理由里点名 read_chapter", () => {
		const input = { path: "draft/ch02.md", offset: 180, limit: 80 };
		expect(guardRead(input, bookDir)).toBeNull();
		const reason = guardRead(input, bookDir);
		expect(reason).not.toBeNull();
		expect(reason).toContain("read_chapter");
		// 必须说清是哪一段,否则模型不知道自己重复了什么
		expect(reason).toContain("offset=180");
	});

	it("换一个区间:放行(合法翻页不该被误伤)", () => {
		expect(guardRead({ path: "draft/ch02.md", offset: 1 }, bookDir)).toBeNull();
		expect(guardRead({ path: "draft/ch02.md", offset: 90 }, bookDir)).toBeNull();
		expect(guardRead({ path: "draft/ch02.md", offset: 180 }, bookDir)).toBeNull();
	});

	it("同一文件读超上限:拦截,并给出 read_chapter 的调用形态", () => {
		for (let i = 0; i < READ_FILE_LIMIT; i++) {
			expect(guardRead({ path: `draft/ch02.md`, offset: i + 1 }, bookDir)).toBeNull();
		}
		const reason = guardRead({ path: "draft/ch02.md", offset: 999 }, bookDir);
		expect(reason).not.toBeNull();
		expect(reason).toContain("read_chapter");
		expect(reason).toContain("ch02");
	});

	it("不同文件各算各的", () => {
		for (let i = 0; i < READ_FILE_LIMIT + 2; i++) {
			guardRead({ path: "draft/ch02.md", offset: i + 1 }, bookDir);
		}
		// ch02 已经超限,但 ch01 是另一个文件,首次读应当放行
		expect(guardRead({ path: "draft/ch01.md", offset: 1 }, bookDir)).toBeNull();
	});

	it("resetReadRails 后重新计数(护栏按轮重置,不跨轮累积)", () => {
		for (let i = 0; i < READ_FILE_LIMIT + 2; i++) {
			guardRead({ path: "draft/ch02.md", offset: i + 1 }, bookDir);
		}
		resetReadRails();
		expect(guardRead({ path: "draft/ch02.md", offset: 1 }, bookDir)).toBeNull();
	});
});

describe("writeDeltaLine —— 让静默丢内容显性化", () => {
	it("掉了一半以上:告警,并提示用 read_chapter 复核", () => {
		const line = writeDeltaLine("draft/ch02.md", 2824, 200);
		expect(line).not.toBeNull();
		expect(line).toContain("2824");
		expect(line).toContain("200");
		expect(line).toContain("read_chapter");
	});

	it("字数增长:不告(正常写作)", () => {
		expect(writeDeltaLine("draft/ch02.md", 200, 2824)).toBeNull();
	});

	it("小幅减少:不告(正常段落级修订不该被噪音打扰)", () => {
		expect(writeDeltaLine("draft/ch02.md", 1000, 800)).toBeNull();
	});

	it("写入前就是空文件:不告(新建,不是丢内容)", () => {
		expect(writeDeltaLine("draft/ch02.md", 0, 200)).toBeNull();
	});
});

describe("路径归一化辅助", () => {
	it("relOf:相对路径取书内相对路径,书外返回 null", () => {
		expect(relOf("draft/ch01.md", bookDir)).toBe(join("draft", "ch01.md"));
		expect(relOf("/etc/passwd", bookDir)).toBeNull();
	});

	it("isDraftRel:只有 draft/ 下算正文", () => {
		expect(isDraftRel(join("draft", "ch01.md"))).toBe(true);
		expect(isDraftRel(join("notes", "设定", "a.md"))).toBe(false);
	});
});
