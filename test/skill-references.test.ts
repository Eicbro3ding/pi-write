/**
 * craft 技能（网文方法论文库）契约测试。
 *
 * 这批文档是**原样 vendor** 进来的第三方内容（来源与 commit 见
 * `skills/craft/references/ATTRIBUTION.md`），不是手写代码，所以测试守的是
 * 「目录、路由、来源三者不会悄悄漂移」，共四件事：
 *
 * 1. **索引 → 磁盘**：`craft/SKILL.md` 与三个兄弟技能里写到的每个方法论文档都真的存在
 *    （模型照着路由表去 read 却读到不存在的文件，是最难查的一类故障——它只会表现为
 *    「agent 说找不到方法」）。
 * 2. **磁盘 → 索引**：`references/` 下每份文档都被 `craft/SKILL.md` 索引到
 *    （同步上游时挑进来一份新文件却忘了登记 → 红；这是「搬了没人知道它存在」）。
 * 3. **纯净性**：收录文件里不含上游的流程/宿主耦合标记 —— 判据见 ATTRIBUTION.md
 *    「收的是什么」。同步上游时把 workflow/脚本类夹带进来 → 红。
 * 4. **断链登记**：收录文件之间残留的交叉引用（指向未收录文件）必须逐个在
 *    ATTRIBUTION.md 里登记。上游改了引用、或同步时漏掉一份被引用的文件 → 红。
 *
 * 注意：**不做**「与上游逐字节比对」——那需要网络，测试必须是离线可跑的。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRAFT = path.join(ROOT, "skills", "craft");
const SKILL_MD = path.join(CRAFT, "SKILL.md");
const REFS = path.join(CRAFT, "references");
const ATTRIBUTION = path.join(REFS, "ATTRIBUTION.md");
/** 兄弟技能：它们各自把一部分方法论接了过去（单一真相源，不复制副本）。 */
const SIBLING_SKILLS = ["outline", "critique", "revise", "stage-scripting"];
/** 打包自带的全部技能（有 SKILL.md 的目录名，按名排序）。 */
const SKILL_NAMES = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(path.join(ROOT, "skills", e.name, "SKILL.md")))
	.map((e) => e.name)
	.sort();

const read = (p: string): string => readFileSync(p, "utf8");
const toPosix = (p: string): string => p.split(path.sep).join("/");

/** references/ 下真实存在的方法论文档（相对 references/ 的 posix 路径，排除 ATTRIBUTION）。 */
function vendoredDocs(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.name.endsWith(".md") && full !== ATTRIBUTION) out.push(toPosix(path.relative(REFS, full)));
		}
	};
	walk(REFS);
	return out.sort();
}

/**
 * 从一段技能文本里取出它引用的方法论文档路径（相对 references/）。
 *
 * 两种写法都要认：`craft/SKILL.md` 里直接写 `structure/xxx.md`，
 * 兄弟技能里写 `references/structure/xxx.md`。
 */
function referencedDocs(text: string): string[] {
	const found = new Set<string>();
	const re = /(?:references\/)?((?:structure|character|prose|deslop|genre|review)\/[^\s`）)、，。；:：]+?\.md)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) found.add(m[1]);
	return [...found].sort();
}

const SKILL_TEXT = read(SKILL_MD);
const VENDORED = vendoredDocs();

describe("craft 技能：技能定义本身", () => {
	it("SKILL.md 存在，frontmatter 的 name 与目录名一致", () => {
		expect(existsSync(SKILL_MD)).toBe(true);
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL_TEXT);
		expect(fm, "SKILL.md 缺少 frontmatter").not.toBeNull();
		expect(/^name:\s*craft\s*$/m.test(fm![1])).toBe(true);
	});

	it("description 非空且不超过 vendor 的 1024 字符上限", () => {
		// vendor 侧 MAX_DESCRIPTION_LENGTH = 1024（超了技能会被记诊断并可能不加载）
		const desc = /^description:\s*(.+)$/m.exec(SKILL_TEXT)?.[1] ?? "";
		expect(desc.length).toBeGreaterThan(20);
		expect(desc.length).toBeLessThanOrEqual(1024);
	});

	it("收录规模符合预期（防止递归扫描误把别的目录卷进来）", () => {
		expect(VENDORED.length).toBeGreaterThan(60);
		// 只可能有分类目录 + genre/cards 两层
		for (const rel of VENDORED) expect(rel.split("/").length).toBeLessThanOrEqual(3);
	});
});

describe("craft 技能：路由表与磁盘一致", () => {
	it("craft/SKILL.md 索引的每份文档都在磁盘上（无断链）", () => {
		const missing = referencedDocs(SKILL_TEXT).filter((rel) => !existsSync(path.join(REFS, rel)));
		expect(missing, `路由表指向了不存在的文件：${missing.join(", ")}`).toEqual([]);
	});

	it("兄弟技能里的转发引用也都在磁盘上", () => {
		const missing: string[] = [];
		for (const skill of SIBLING_SKILLS) {
			const file = path.join(ROOT, "skills", skill, "SKILL.md");
			if (!existsSync(file)) continue;
			for (const rel of referencedDocs(read(file))) {
				if (!existsSync(path.join(REFS, rel))) missing.push(`${skill} -> ${rel}`);
			}
		}
		expect(missing, `兄弟技能的转发引用断链：${missing.join(", ")}`).toEqual([]);
	});

	it("references/ 下每份文档都被 craft/SKILL.md 索引到（没有「搬了没人知道」的）", () => {
		const indexed = new Set(referencedDocs(SKILL_TEXT));
		const unindexed = VENDORED.filter((rel) => !indexed.has(rel));
		expect(unindexed, `未被路由表索引：${unindexed.join(", ")}`).toEqual([]);
	});

	it("路由表没有索引到不存在的分类目录", () => {
		const dirs = new Set(VENDORED.map((rel) => rel.split("/")[0]));
		const indexed = new Set(referencedDocs(SKILL_TEXT).map((rel) => rel.split("/")[0]));
		expect([...indexed].filter((d) => !dirs.has(d))).toEqual([]);
	});
});

describe("craft 技能：收录内容的纯净性", () => {
	// 上游的流程/宿主耦合标记：出现即说明收进来的是流程而非方法（判据见 ATTRIBUTION.md）
	const FORBIDDEN = [
		"拆文库",
		"tracking_commit",
		"storyctl",
		"{PYTHON}",
		".story-deployed",
		"target_cli",
		".claude/",
		".codex/",
		".active-book",
	];

	it("不含上游流程/宿主耦合标记", () => {
		const dirty: string[] = [];
		for (const rel of VENDORED) {
			const text = read(path.join(REFS, rel));
			for (const marker of FORBIDDEN) {
				if (text.includes(marker)) dirty.push(`${rel} 命中 ${marker}`);
			}
		}
		expect(dirty, `收录了流程类文档：${dirty.join("; ")}`).toEqual([]);
	});

	it("每份文档非空且带一级标题", () => {
		const bad = VENDORED.filter((rel) => {
			const text = read(path.join(REFS, rel));
			return text.trim().length < 200 || !/^#\s+\S/m.test(text);
		});
		expect(bad, `疑似空文件或缺标题：${bad.join(", ")}`).toEqual([]);
	});

	it("残留的跨文件引用都已在 ATTRIBUTION.md 登记（同步上游的护栏）", () => {
		const names = new Set(VENDORED.map((rel) => path.basename(rel, ".md")));
		names.add("ATTRIBUTION");
		const dangling = new Set<string>();
		for (const rel of VENDORED) {
			const text = read(path.join(REFS, rel));
			// 只看形如 foo.md 的引用；CJK 文件名与锚点不在此列
			for (const m of text.matchAll(/([A-Za-z0-9][A-Za-z0-9_-]*\.md)/g)) {
				const name = m[1].replace(/\.md$/, "");
				if (!names.has(name)) dangling.add(m[1]);
			}
		}
		const attributionText = read(ATTRIBUTION);
		const unregistered = [...dangling].filter((f) => !attributionText.includes(f));
		expect(
			unregistered,
			`这些交叉引用指向未收录文件、且没在 ATTRIBUTION.md 登记：${unregistered.join(", ")}`,
		).toEqual([]);
	});

	it("MIT 许可证随副本保留（上游要求）", () => {
		const license = path.join(REFS, "LICENSE-oh-story-claudecode.txt");
		expect(existsSync(license)).toBe(true);
		expect(read(license)).toMatch(/MIT License/);
		expect(read(ATTRIBUTION)).toMatch(/dab9e18d8f59ae6c8761a3b63aa71fd4b34d92e6/);
	});
});

describe("所有技能：references 目录与引用一致", () => {
	/** SKILL.md 里显式写出的 references/xxx.md 路径（最容易被写错、也最该被守住的一类）。 */
	function explicitRefs(skill: string): string[] {
		const text = read(path.join(ROOT, "skills", skill, "SKILL.md"));
		const out = new Set<string>();
		for (const m of text.matchAll(/references\/([^\s`）)、，。；:：]+?\.md)/g)) out.add(m[1]);
		return [...out];
	}

	/** 某技能 references/ 下的全部 .md（相对 references/ 的 posix 路径）。 */
	function refFiles(skill: string): string[] {
		const dir = path.join(ROOT, "skills", skill, "references");
		if (!existsSync(dir)) return [];
		const out: string[] = [];
		const walk = (d: string): void => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const full = path.join(d, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.name.endsWith(".md")) out.push(toPosix(path.relative(dir, full)));
			}
		};
		walk(dir);
		return out.sort();
	}

	it("每个技能的 SKILL.md 都能被 vendor 加载，且出现在 <available_skills> 里", async () => {
		const { formatSkillsForPrompt, loadSkills } = await import(
			"../vendor/pi-coding-agent/src/core/skills.ts"
		);
		const result = loadSkills({
			cwd: ROOT,
			agentDir: path.join(ROOT, ".tmp-test-agent"),
			skillPaths: SKILL_NAMES.map((n) => path.join(ROOT, "skills", n)),
			includeDefaults: false,
		});
		const loaded = new Set(result.skills.map((s) => s.name));
		expect(
			SKILL_NAMES.filter((n) => !loaded.has(n)),
			`未加载：加载诊断 = ${JSON.stringify(result.diagnostics)}`,
		).toEqual([]);
		const block = formatSkillsForPrompt(result.skills);
		for (const name of SKILL_NAMES) {
			expect(block).toContain(`<name>${name}</name>`);
			// <location> 是 SKILL.md 的绝对路径 —— SKILL.md 里的相对路径靠它解析
			expect(block).toContain(path.join(ROOT, "skills", name, "SKILL.md"));
		}
	});

	it("SKILL.md 写出的 references/ 路径都解析得到，且不歧义", () => {
		/**
		 * 两种引用形态都要认：
		 * - 指向自己目录（`references/style-setup.md`）；
		 * - 跨技能转发（`outline`/`critique`/`revise` 把方法论指向 `craft` 的
		 *   `references/structure/xxx.md`，这是刻意设计的单一真相源，不复制副本）。
		 * 跨技能的先在自己技能里找，找不到就要求在其他技能里**唯一**命中——
		 * 命中多个说明这个路径谁都可能是，模型无从判断。
		 */
		const filesBySkill = new Map(SKILL_NAMES.map((s) => [s, new Set(refFiles(s))]));
		const bad: string[] = [];
		const ambiguous: string[] = [];
		for (const skill of SKILL_NAMES) {
			for (const rel of explicitRefs(skill)) {
				if (filesBySkill.get(skill)?.has(rel)) continue;
				const owners = SKILL_NAMES.filter((s) => filesBySkill.get(s)?.has(rel));
				if (owners.length === 0) bad.push(`${skill} -> references/${rel}`);
				else if (owners.length > 1) ambiguous.push(`${skill} -> references/${rel}（${owners.join(" / ")}）`);
			}
		}
		expect(bad, `悬空引用：${bad.join(", ")}`).toEqual([]);
		expect(ambiguous, `跨技能引用有歧义：${ambiguous.join(", ")}`).toEqual([]);
	});

	it("每个技能 references/ 下的文件都在它的 SKILL.md 里被提到过", () => {
		const bad: string[] = [];
		for (const skill of SKILL_NAMES) {
			const text = read(path.join(ROOT, "skills", skill, "SKILL.md"));
			for (const rel of refFiles(skill)) {
				if (!text.includes(path.basename(rel))) bad.push(`${skill}: ${rel}`);
			}
		}
		expect(bad, `搬了却没登记（模型无从知道它存在）：${bad.join(", ")}`).toEqual([]);
	});

	it("每个技能的 frontmatter：name 与目录名一致、description 合法", () => {
		for (const skill of SKILL_NAMES) {
			const text = read(path.join(ROOT, "skills", skill, "SKILL.md"));
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
			expect(fm, `${skill}/SKILL.md 缺 frontmatter`).not.toBeNull();
			expect(new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(fm![1]), `${skill} 的 name 与目录名不一致`).toBe(true);
			// vendor 侧 MAX_DESCRIPTION_LENGTH = 1024；超了会被记诊断并可能不加载
			const desc = /^description:\s*(.+)$/m.exec(fm![1])?.[1] ?? "";
			expect(desc.length, `${skill} 的 description 为空`).toBeGreaterThan(20);
			expect(desc.length, `${skill} 的 description 超长（${desc.length}）`).toBeLessThanOrEqual(1024);
		}
	});
});
