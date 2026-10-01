/**
 * 技能清单(src/skills-index.ts)测试。
 *
 * 这里测的是**菜单与模型同源**这件事:listSkills 用 vendor 的 loadSkills 加载,
 * 目录清单来自 sessionSkillDirs —— 与 agent 装配用的是同一套。断言不写死技能数量
 * (以后加技能不该红),只锁「自带技能一定在、形状正确、按名字排序」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSkills } from "../src/skills-index.ts";

describe("listSkills(自带技能)", () => {
	it("列出打包自带的技能(名字 + 描述非空 + 按名字排序)", () => {
		const skills = listSkills({});
		const names = skills.map((s) => s.name);
		// 不带数量断言:以后加技能不该红;只要求这几个核心方法论在里面
		expect(names).toEqual(expect.arrayContaining(["outline", "critique", "revise", "craft", "onboarding", "stage-scripting"]));
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		for (const s of skills) {
			expect(s.name.length).toBeGreaterThan(0);
			expect(s.description.length).toBeGreaterThan(0);
			expect(typeof s.explicitOnly).toBe("boolean");
		}
	});

	it("自带技能都不带 disable-model-invocation(模型可见)", () => {
		const skills = listSkills({});
		for (const name of ["outline", "critique", "revise"]) {
			expect(skills.find((s) => s.name === name)?.explicitOnly, name).toBe(false);
		}
	});
});

describe("listSkills(全局技能目录与显式调用专用技能)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "piw-skills-"));
	const skillsDir = join(tmp, "skills");

	beforeAll(() => {
		// 一个目录里两个技能:一个模型可见,一个只允许显式调用(disable-model-invocation)
		mkdirSync(join(skillsDir, "visible-skill"), { recursive: true });
		mkdirSync(join(skillsDir, "explicit-skill"), { recursive: true });
		writeFileSync(
			join(skillsDir, "visible-skill", "SKILL.md"),
			'---\nname: visible-skill\ndescription: "模型可见的技能"\n---\n\n正文\n',
		);
		writeFileSync(
			join(skillsDir, "explicit-skill", "SKILL.md"),
			'---\nname: explicit-skill\ndescription: "只允许 /skill: 显式调用"\ndisable-model-invocation: true\n---\n\n正文\n',
		);
	});
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it("PI_WRITER_SKILLS_DIR 指向的目录会被列出,且标出 explicitOnly", () => {
		const skills = listSkills({ env: { PI_WRITER_SKILLS_DIR: skillsDir, PI_WRITER_DIR: tmp } });
		const visible = skills.find((s) => s.name === "visible-skill");
		const explicit = skills.find((s) => s.name === "explicit-skill");
		expect(visible).toMatchObject({ description: "模型可见的技能", explicitOnly: false });
		// 只允许显式调用的技能必须仍然出现在菜单里 —— /skill:<name> 是它唯一的入口
		expect(explicit).toMatchObject({ description: "只允许 /skill: 显式调用", explicitOnly: true });
	});

	it("指向不存在的目录 → 不抛错,该目录不贡献任何技能(全局/自带来源照常)", () => {
		const skills = listSkills({ env: { PI_WRITER_SKILLS_DIR: join(tmp, "no-such-dir"), PI_WRITER_DIR: tmp } });
		expect(Array.isArray(skills)).toBe(true);
		expect(skills.map((s) => s.name)).not.toContain("visible-skill");
	});
});
