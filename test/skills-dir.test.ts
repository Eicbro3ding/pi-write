import { describe, it, expect } from "vitest";

// resolveSkillsDir 的规范家在 config.ts;web.ts 经别名导出保持旧 API 兼容
import { resolveSkillsDir } from "../src/config.ts";

describe("resolveSkillsDir", () => {
	it("PI_WRITER_SKILLS_DIR 存在时优先返回", () => {
		expect(resolveSkillsDir({ PI_WRITER_SKILLS_DIR: "/data/app/skills" })).toBe("/data/app/skills");
	});
	it("env 缺失时回退默认(exe 旁/源码树)", () => {
		const dir = resolveSkillsDir({});
		expect(dir.endsWith("skills")).toBe(true);
	});
});
