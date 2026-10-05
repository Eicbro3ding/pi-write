/**
 * 工具路径守卫测试:pathWithinRoot 边界判定 + installToolPathGuard 与
 * vendor resolveToCwd 的集成(所有文件工具 read/write/edit/grep/find/ls
 * 的路径汇聚点)。模拟"AI 试图读书目录外的 auth.json"场景。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 必须 import **包名**,不能 import vendor 源码 —— 两者是独立的模块实例。
// 自研侧 installToolPathGuard 经 src/pi-adapter/guard.ts 装到 **npm 包那份**上;
// 若这里读 vendor 那份,守卫会被装到别处,所有「应该抛错」的断言全部静默通过
// (编译正常、运行无报错,但守卫实际一次都没拦)。
import { resolveToCwd } from "@earendil-works/pi-coding-agent/core/tools/path-utils";
import {
	assertPathWithinRoot,
	dedupePaths,
	installToolPathGuard,
	pathWithinRoot,
	skillDirsOf,
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

describe("只读放行清单以「实际加载到的技能」为准（2026-10-01）", () => {
	it("skillDirsOf 取每个技能的 baseDir 并去重/滤空", () => {
		expect(
			skillDirsOf([
				{ baseDir: "/a/skills/outline" },
				{ baseDir: "/a/skills/outline" },
				{ baseDir: "/global/skills/find-skills" },
				{ baseDir: undefined },
				{},
			]),
		).toEqual(["/a/skills/outline", "/global/skills/find-skills"]);
		expect(skillDirsOf(undefined)).toEqual([]);
	});

	it("dedupePaths 保持首次出现顺序并合并多份清单", () => {
		expect(dedupePaths(["/x", "/y"], undefined, ["/y", "/z"])).toEqual(["/x", "/y", "/z"]);
		expect(dedupePaths(undefined)).toEqual([]);
	});

	it("加载到的技能目录可读、不可写;基线清单之外的目录正是原先漏放行的那类", () => {
		// 模拟 vendor 从 agentDir/skills 发现的技能(baseDir 来自加载结果,不在手工基线里)
		const agentSkills = join(tmp, "agent", "skills");
		const loaded = skillDirsOf([{ baseDir: join(agentSkills, "probe-skill") }]);
		installToolPathGuard(bookDir, dedupePaths([join(tmp, "skills")], loaded));
		const skillFile = join(agentSkills, "probe-skill", "SKILL.md");
		// 读放行(修前只给手工基线 → 这里会抛「工具路径越界」= 列得出来读不到)
		expect(() => resolveToCwd(skillFile, bookDir)).not.toThrow();
		// 可读 ≠ 可写:技能文件依旧禁止 write/edit(模型不得改写自己的指令)
		expect(() => resolveToCwd(skillFile, bookDir, "write")).toThrow("工具路径越界");
		// 未加载的目录仍然一律拒绝
		expect(() => resolveToCwd(join(tmp, "agent", "auth.json"), bookDir)).toThrow("工具路径越界");
	});
});

describe("世界书禁直写（2026-08-11，编剧统一方案）", () => {
	it("write 模式拒绝 world.json 与 .writer/ 下文件；read 仍放行", () => {
		installToolPathGuard(bookDir);
		expect(() => resolveToCwd("world.json", bookDir, "write")).toThrow(/world_update/);
		expect(() => resolveToCwd(".writer/world.md", bookDir, "write")).toThrow(/world_update/);
		expect(() => resolveToCwd(".writer/characters.md", bookDir, "write")).toThrow(/world_update/);
		// 读仍放行(编剧/导演 read 世界书上下文不受影响)
		expect(resolveToCwd("world.json", bookDir, "read")).toBe(join(bookDir, "world.json"));
		expect(resolveToCwd(".writer/world.md", bookDir, "read")).toBe(join(bookDir, ".writer", "world.md"));
	});
	it("书内其他路径写不受影响(draft/advice.md 等)", () => {
		installToolPathGuard(bookDir);
		expect(resolveToCwd("draft/ch01.md", bookDir, "write")).toBe(join(bookDir, "draft", "ch01.md"));
		expect(resolveToCwd("advice.md", bookDir, "write")).toBe(join(bookDir, "advice.md"));
		expect(resolveToCwd("outline.md", bookDir, "write")).toBe(join(bookDir, "outline.md"));
	});
});

describe("正文目录白名单（2026-08-11，draftFile）", () => {
	it("draftFile 启用后只允许写当前章节文件(防 agent 自创文件名)", () => {
		installToolPathGuard(bookDir, [], "ch01.md");
		expect(resolveToCwd("draft/ch01.md", bookDir, "write")).toBe(join(bookDir, "draft", "ch01.md"));
		// agent 自由发挥文件名(draft/第一章.md)——正文写到前端读不到的路径,必须拦
		expect(() => resolveToCwd("draft/第一章.md", bookDir, "write")).toThrow(/正文目录只允许写当前章节文件/);
		// draft 子目录同样不设放行(严格匹配,防嵌套路径绕过白名单)
		expect(() => resolveToCwd("draft/sub/ch01.md", bookDir, "write")).toThrow(/正文目录只允许写当前章节文件/);
		// 读不受影响(查看/引用其他文件照常)
		expect(resolveToCwd("draft/第一章.md", bookDir, "read")).toBe(join(bookDir, "draft", "第一章.md"));
	});

	it("未传 draftFile 时 draft/ 写不设限(主会话/TUI 行为不变)", () => {
		installToolPathGuard(bookDir);
		expect(resolveToCwd("draft/第一章.md", bookDir, "write")).toBe(join(bookDir, "draft", "第一章.md"));
	});

	it("draft 白名单与世界书禁直写共存", () => {
		installToolPathGuard(bookDir, [], "ch01.md");
		expect(() => resolveToCwd("world.json", bookDir, "write")).toThrow(/world_update/);
		expect(resolveToCwd("draft/ch01.md", bookDir, "write")).toBe(join(bookDir, "draft", "ch01.md"));
		expect(() => resolveToCwd("draft/第一章.md", bookDir, "write")).toThrow(/正文目录只允许写当前章节文件/);
	});
});
