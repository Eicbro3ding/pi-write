/**
 * 工具路径守卫测试:pathWithinRoot 边界判定 + installToolPathGuard 与
 * vendor resolveToCwd 的集成(所有文件工具 read/write/edit/grep/find/ls
 * 的路径汇聚点)。模拟"AI 试图读书目录外的 auth.json"场景。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToCwd } from "../vendor/pi-coding-agent/src/core/tools/path-utils.ts";
import {
	assertPathWithinRoot,
	installToolPathGuard,
	pathWithinRoot,
	uninstallToolPathGuard,
} from "../src/tool-guard.ts";

let tmp: string;
let bookDir: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "piw-guard-"));
	bookDir = join(tmp, "books", "my-book");
});

afterEach(() => {
	uninstallToolPathGuard();
	rmSync(tmp, { recursive: true, force: true });
});

describe("pathWithinRoot", () => {
	it("放行书目录本身与书内文件/子目录", () => {
		expect(pathWithinRoot(bookDir, bookDir)).toBe(true);
		expect(pathWithinRoot(join(bookDir, "draft", "ch01.md"), bookDir)).toBe(true);
		expect(pathWithinRoot(join(bookDir, "world.json"), bookDir)).toBe(true);
	});

	it("拒绝 ../ 上溯、兄弟目录与绝对路径逃逸", () => {
		expect(pathWithinRoot(join(tmp, "books", "other-book"), bookDir)).toBe(false);
		expect(pathWithinRoot(join(tmp, "books", "my-book-2"), bookDir)).toBe(false);
		expect(pathWithinRoot(join(tmp, "agent", "auth.json"), bookDir)).toBe(false);
		// 前缀相似但多一个字符的目录不得放行(my-book 与 my-book-2)
		expect(pathWithinRoot(join(bookDir, "..", "my-book-2"), bookDir)).toBe(false);
	});

	it("assertPathWithinRoot 越界抛中文错误", () => {
		expect(() => assertPathWithinRoot(join(tmp, "agent", "auth.json"), bookDir)).toThrow("工具路径越界");
		expect(() => assertPathWithinRoot(join(bookDir, "draft", "ch01.md"), bookDir)).not.toThrow();
	});

	// Windows 文件系统大小写不敏感:字符串比较必须跟随该语义(2026-08-09
	// 模型读 skill 被误拦的根因——路径来自不同源头,大小写可能不一致)。
	it.runIf(process.platform === "win32")("win32 下大小写不一致的路径仍判定在 root 内", () => {
		expect(pathWithinRoot(join(bookDir, "draft", "ch01.md").toLowerCase(), bookDir)).toBe(true);
		expect(pathWithinRoot(bookDir.toUpperCase(), bookDir)).toBe(true);
		expect(pathWithinRoot(join(bookDir, "..", "agent", "auth.json").toLowerCase(), bookDir)).toBe(false);
	});
});

describe("installToolPathGuard(与 vendor resolveToCwd 集成)", () => {
	it("守卫拦截 ~ 展开的 auth.json(API key 泄露场景)", () => {
		installToolPathGuard(bookDir);
		// resolveToCwd 支持 ~ 展开;守卫必须在展开后拦截
		expect(() => resolveToCwd("~/.pi/writer/agent/auth.json", bookDir)).toThrow("工具路径越界");
	});

	it("守卫拦截 ../ 上溯与绝对路径", () => {
		installToolPathGuard(bookDir);
		expect(() => resolveToCwd("../secret.json", bookDir)).toThrow("工具路径越界");
		expect(() => resolveToCwd(resolve(tmp, "agent", "auth.json"), bookDir)).toThrow("工具路径越界");
	});

	it("书目录内的相对路径正常解析", () => {
		installToolPathGuard(bookDir);
		expect(resolveToCwd("draft/ch01.md", bookDir)).toBe(join(bookDir, "draft", "ch01.md"));
		expect(resolveToCwd(".", bookDir)).toBe(bookDir);
	});

	it("未安装守卫时 vendor 行为不变(向后兼容)", () => {
		// 不安装守卫:绝对路径可解析(与修复前行为一致,供其他使用方)
		expect(resolveToCwd(resolve(tmp, "agent", "auth.json"), bookDir)).toBe(resolve(tmp, "agent", "auth.json"));
	});

	it("uninstallToolPathGuard 后守卫移除", () => {
		installToolPathGuard(bookDir);
		expect(() => resolveToCwd("../secret.json", bookDir)).toThrow("工具路径越界");
		uninstallToolPathGuard();
		expect(resolveToCwd("../secret.json", bookDir)).toBe(resolve(bookDir, "..", "secret.json"));
	});
});

describe("installToolPathGuard 只读目录(skills)", () => {
	it("读操作放行书目录外的只读目录,写操作拒绝;书目录内读写均放行", () => {
		const skillsDir = join(tmp, "skills");
		installToolPathGuard(bookDir, [skillsDir]);
		const skillFile = join(skillsDir, "outline", "SKILL.md");
		// 只读目录:read/grep/find/ls(resolveToCwd 默认 read 模式)放行
		expect(() => resolveToCwd(skillFile, bookDir)).not.toThrow();
		// 写工具(write/edit,显式 write 模式)拒绝
		expect(() => resolveToCwd(skillFile, bookDir, "write")).toThrow("工具路径越界");
		// 书目录内:读写均放行
		expect(() => resolveToCwd(join(bookDir, "draft", "ch01.md"), bookDir, "write")).not.toThrow();
		// 其他书外目录:读也拒绝
		expect(() => resolveToCwd(join(tmp, "agent", "auth.json"), bookDir)).toThrow("工具路径越界");
	});

	it.runIf(process.platform === "win32")("win32 下只读目录大小写不一致仍放行读", () => {
		const skillsDir = join(tmp, "skills");
		installToolPathGuard(bookDir, [skillsDir]);
		const mixedCase = join(skillsDir, "outline", "SKILL.md").toLowerCase();
		expect(() => resolveToCwd(mixedCase, bookDir)).not.toThrow();
		expect(() => resolveToCwd(mixedCase, bookDir, "write")).toThrow("工具路径越界");
	});
});
