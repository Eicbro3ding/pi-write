import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// resolveSkillsDir 的规范家在 config.ts;web.ts 经别名导出保持旧 API 兼容
import { resolveSkillsDir } from "../src/config.ts";
// 会话装配的技能目录清单(2026-10-01 收敛;writer-host 漏传 additionalSkillPaths 的回归护栏)
import { sessionSkillDirs } from "../src/session-factory.ts";

describe("resolveSkillsDir", () => {
	it("PI_WRITER_SKILLS_DIR 存在时优先返回", () => {
		expect(resolveSkillsDir({ PI_WRITER_SKILLS_DIR: "/data/app/skills" })).toBe("/data/app/skills");
	});
	it("env 缺失时回退默认(exe 旁/源码树)", () => {
		const dir = resolveSkillsDir({});
		expect(dir.endsWith("skills")).toBe(true);
	});
});

describe("sessionSkillDirs(会话装配的技能目录清单)", () => {
	// 全局技能目录走 resolveExtraSkillsDirs,只收**存在**的目录(不存在不刷诊断噪音),
	// 所以附加目录用真实临时目录
	const root = mkdtempSync(join(tmpdir(), "pw-skills-"));
	const extraOne = join(root, "extra-one");
	const extraGlobal = join(root, "extra-global");
	mkdirSync(extraOne);
	mkdirSync(extraGlobal);
	const env = {
		PI_WRITER_SKILLS_DIR: "/data/app/skills",
		PI_WRITER_EXTRA_SKILLS_DIRS: `${extraOne}:${extraGlobal}`,
	};

	it("默认并入自带 skills/,只读放行与加载路径同源", () => {
		const { skillPaths, readOnlyDirs } = sessionSkillDirs({}, env);
		expect(skillPaths).toContain("/data/app/skills");
		expect(readOnlyDirs).toContain("/data/app/skills");
	});

	it("并不依赖调用方传 additionalSkillPaths(writer-host 漏传就是这条回归)", () => {
		// 调用方什么都不传(编剧 / 经典模式会话的装配形态),自带技能也必须在清单里,
		// 否则 vendor 不会把 <available_skills> 追加进系统提示词
		const { skillPaths } = sessionSkillDirs({ additionalSkillPaths: undefined }, env);
		expect(skillPaths).toContain("/data/app/skills");
	});

	it("packagedSkills: false 只留附加目录与全局技能目录(stage 角色)", () => {
		const { skillPaths, readOnlyDirs } = sessionSkillDirs(
			{ packagedSkills: false, additionalSkillPaths: [extraOne] },
			env,
		);
		expect(skillPaths).not.toContain("/data/app/skills");
		// 附加目录 + 全局技能目录(后者还可能带上 ~/.agents/skills,故只看前两项)
		expect(skillPaths.slice(0, 2)).toEqual([extraOne, extraGlobal]);
		// 只读放行仍保留全局技能目录(舞台角色经 read 查舞台剧本方法)
		expect(readOnlyDirs).toContain(extraGlobal);
	});

	it("同一目录只出现一次(env 与调用方重复给也不重复扫描)", () => {
		const { skillPaths, readOnlyDirs } = sessionSkillDirs(
			{ additionalSkillPaths: ["/data/app/skills"], readOnlyDirs: ["/data/app/skills"] },
			env,
		);
		expect(skillPaths.filter((d) => d === "/data/app/skills")).toHaveLength(1);
		expect(readOnlyDirs.filter((d) => d === "/data/app/skills")).toHaveLength(1);
	});

	it("调用方自己的只读目录不被丢掉(守卫还要放行别的目录)", () => {
		const { readOnlyDirs } = sessionSkillDirs({ readOnlyDirs: ["/some/readonly"] }, env);
		expect(readOnlyDirs).toContain("/some/readonly");
	});
});
