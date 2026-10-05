/**
 * craft-* 技能（网文方法论文库）契约测试。
 *
 * 这批文档是**原样 vendor** 进来的第三方内容（来源与 commit 见各技能的
 * `references/ATTRIBUTION.md`），不是手写代码，所以测试守的是「目录、路由、来源
 * 三者不会悄悄漂移」。四条 craft 专属不变量：
 *
 * 1. **规模与分布**：就这 4 个技能、各自装哪一类、合计 76 份 —— 从「一个 craft 技能」
 *    拆成四个时，最容易把某个文件漏在某个目录里而没人发现。
 * 2. **路由表 ↔ 磁盘双向一致**：SKILL.md 提到的文档都在本技能里、本技能里的文档都被
 *    SKILL.md 提到。「表里指向不存在的文件」与「搬了没人知道它存在」是一类静默故障。
 * 3. **纯净性**：收录文件不含上游的流程/宿主耦合标记（判据见 ATTRIBUTION.md「收的是什么」）。
 * 4. **来源与许可**：四份副本逐字节一致（同一批上游内容，许可声明跟着每份副本走）、
 *    许可证随副本保留、收录 commit 记在案。
 *
 * 文件末尾还有一组「所有技能」通用护栏：显式 `references/xxx.md` 引用不悬空且跨技能
 * 不歧义、每个技能都能被 vendor 真实加载进 `<available_skills>`、frontmatter 合法。
 *
 * 注意：**不做**「与上游逐字节比对」——那需要网络，测试必须离线可跑。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 兄弟技能：它们各自把一部分方法论接了过去（单一真相源，不复制副本）。 */
const SIBLING_SKILLS = ["outline", "critique", "revise", "stage-scripting"];
/** 打包自带的全部技能（有 SKILL.md 的目录名，按名排序）。 */
const SKILL_NAMES = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(path.join(ROOT, "skills", e.name, "SKILL.md")))
	.map((e) => e.name)
	.sort();
/** 4 个 craft-* 技能（按阶段拆；不含 ATTRIBUTION.md 的方法论文档份数）。 */
const CRAFT_SKILLS = ["craft-outline", "craft-prose", "craft-deslop", "craft-review"] as const;
const CRAFT_DOC_COUNT: Record<string, number> = {
	"craft-outline": 50, // 12 结构 + 6 题材 + 32 张题材卡
	"craft-prose": 17, // 13 正文 + 4 人物
	"craft-deslop": 7,
	"craft-review": 2,
};
/**
 * SKILL.md 里合法出现、但**不是**本技能方法论文档的 `.md` 记号：
 * - `X.md`：`设定/角色/X.md` 这类上游路径占位（用来说明「别照着它写文件」）；
 * - `outline.md`：pi-write 自己的派生视图（用来说明「直写会被覆盖」）。
 * 其余任何 `*.md` 记号都必须能在本技能 `references/` 里找到——拼错一个字母就会红。
 */
const NON_DOC_MENTIONS = new Set(["X.md", "outline.md"]);

const read = (p: string): string => readFileSync(p, "utf8");
const toPosix = (p: string): string => p.split(path.sep).join("/");
const skillDir = (skill: string): string => path.join(ROOT, "skills", skill);
const refsDir = (skill: string): string => path.join(skillDir(skill), "references");

/** 某技能 references/ 下的方法论文档（相对 references/ 的 posix 路径；排除 ATTRIBUTION.md）。 */
function vendoredDocsOf(skill: string): string[] {
	const dir = refsDir(skill);
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.name.endsWith(".md") && entry.name !== "ATTRIBUTION.md") out.push(toPosix(path.relative(dir, full)));
		}
	};
	walk(dir);
	return out.sort();
}

/**
 * SKILL.md 里提到的本技能文档（按 basename 匹配，裸名与 `references/` 前缀两种写法都认）。
 *
 * 这里用**宽**模式（允许 CJK）：32 张题材卡的文件名是中文（`cards/悬疑灵异.md`），
 * ASCII 模式一个都匹配不到。方向是「磁盘 → 索引」，宽松一点不会误报。
 */
function mentionedDocs(text: string, files: string[]): string[] {
	const byBase = new Map(files.map((f) => [path.basename(f), f]));
	const found = new Set<string>();
	for (const m of text.matchAll(/([^\s`）)、，。；:：/]+\.md)/g)) {
		const hit = byBase.get(m[1]!);
		if (hit) found.add(hit);
	}
	return [...found].sort();
}

/**
 * 「索引 → 磁盘」方向用**窄**模式（ASCII 名字）：CJK 记号一个都不查，但任何 ASCII 文件名
 * 写错一个字母都会被抓住。两个方向用不同模式是刻意的——宽模式会把 `workflow-*.md`
 * 这类说明性提及也当成文件名，窄模式正好放过它。
 */
const ASCII_MD_TOKEN = /([A-Za-z0-9][A-Za-z0-9_-]*\.md)/g;

describe("craft-* 技能：定义与规模", () => {
	it("正好这 4 个技能（拆分后不该还有旧的 craft）", () => {
		expect(SKILL_NAMES.filter((n) => n.startsWith("craft"))).toEqual([...CRAFT_SKILLS].sort());
	});

	it("每个技能：frontmatter 的 name 与目录名一致、description 合法", () => {
		for (const skill of CRAFT_SKILLS) {
			const text = read(path.join(skillDir(skill), "SKILL.md"));
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
			expect(fm, `${skill}/SKILL.md 缺少 frontmatter`).not.toBeNull();
			expect(new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(fm![1]), `${skill} 的 name 与目录名不一致`).toBe(true);
			// vendor 侧 MAX_DESCRIPTION_LENGTH = 1024
			const desc = /^description:\s*(.+)$/m.exec(fm![1])?.[1] ?? "";
			expect(desc.length, `${skill} 的 description 为空`).toBeGreaterThan(20);
			expect(desc.length, `${skill} 的 description 超长（${desc.length}）`).toBeLessThanOrEqual(1024);
		}
	});

	it("每类的份数符合预期，合计 76（拆分时漏掉文件会在这里暴露）", () => {
		let total = 0;
		for (const skill of CRAFT_SKILLS) {
			const n = vendoredDocsOf(skill).length;
			expect(n, `${skill} 的方法论文档份数`).toBe(CRAFT_DOC_COUNT[skill]);
			total += n;
		}
		expect(total, "四个技能合计").toBe(76);
	});

	it("目录层级只有一层（题材卡多一层 cards/）", () => {
		for (const skill of CRAFT_SKILLS) {
			for (const rel of vendoredDocsOf(skill)) {
				expect(rel.split("/").length, `${skill}: ${rel}`).toBeLessThanOrEqual(2);
			}
		}
	});
});

describe("craft-* 技能：路由表与磁盘双向一致", () => {
	it("磁盘上每份文档都被本技能的 SKILL.md 提到（没有「搬了没人知道」的）", () => {
		const bad: string[] = [];
		for (const skill of CRAFT_SKILLS) {
			const files = vendoredDocsOf(skill);
			const mentioned = new Set(mentionedDocs(read(path.join(skillDir(skill), "SKILL.md")), files));
			for (const rel of files) if (!mentioned.has(rel)) bad.push(`${skill}: ${rel}`);
		}
		expect(bad, `未被路由表索引：${bad.join(", ")}`).toEqual([]);
	});

	it("SKILL.md 里的每个 *.md 记号都能在本技能 references/ 里找到（拼错即红）", () => {
		const bad: string[] = [];
		for (const skill of CRAFT_SKILLS) {
			const files = vendoredDocsOf(skill);
			const known = new Set(files.map((f) => path.basename(f)));
			known.add("ATTRIBUTION.md");
			const text = read(path.join(skillDir(skill), "SKILL.md"));
			for (const m of text.matchAll(ASCII_MD_TOKEN)) {
				if (known.has(m[1]) || NON_DOC_MENTIONS.has(m[1])) continue;
				bad.push(`${skill}: ${m[1]}`);
			}
		}
		expect(bad, `SKILL.md 提到了本技能没有的文件：${[...new Set(bad)].join(", ")}`).toEqual([]);
	});

	it("兄弟技能转发到 craft-* 的路径都解析得到", () => {
		const bad: string[] = [];
		for (const skill of SIBLING_SKILLS) {
			const file = path.join(skillDir(skill), "SKILL.md");
			if (!existsSync(file)) continue;
			for (const m of read(file).matchAll(/references\/([A-Za-z0-9][A-Za-z0-9_/-]*\.md)/g)) {
				const rel = m[1]!;
				const hit = CRAFT_SKILLS.some((c) => existsSync(path.join(refsDir(c), rel)));
				if (!hit) bad.push(`${skill} -> references/${rel}`);
			}
		}
		expect(bad, `兄弟技能的转发引用断链：${bad.join(", ")}`).toEqual([]);
	});
});

describe("craft-* 技能：收录内容的纯净性", () => {
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
		for (const skill of CRAFT_SKILLS) {
			for (const rel of vendoredDocsOf(skill)) {
				const text = read(path.join(refsDir(skill), rel));
				for (const marker of FORBIDDEN) {
					if (text.includes(marker)) dirty.push(`${skill}/${rel} 命中 ${marker}`);
				}
			}
		}
		expect(dirty, `收录了流程类文档：${dirty.join("; ")}`).toEqual([]);
	});

	it("每份文档非空且带一级标题", () => {
		const bad: string[] = [];
		for (const skill of CRAFT_SKILLS) {
			for (const rel of vendoredDocsOf(skill)) {
				const text = read(path.join(refsDir(skill), rel));
				if (text.trim().length < 200 || !/^#\s+\S/m.test(text)) bad.push(`${skill}/${rel}`);
			}
		}
		expect(bad, `疑似空文件或缺标题：${bad.join(", ")}`).toEqual([]);
	});

	it("残留的跨文件引用都已在 ATTRIBUTION.md 登记（同步上游的护栏）", () => {
		// 四份 ATTRIBUTION 内容相同，用第一份做登记表
		const attributionText = read(path.join(refsDir(CRAFT_SKILLS[0]), "ATTRIBUTION.md"));
		const allNames = new Set<string>();
		for (const skill of CRAFT_SKILLS) {
			for (const rel of vendoredDocsOf(skill)) allNames.add(path.basename(rel, ".md"));
		}
		allNames.add("ATTRIBUTION");
		const dangling = new Set<string>();
		for (const skill of CRAFT_SKILLS) {
			for (const rel of vendoredDocsOf(skill)) {
				const text = read(path.join(refsDir(skill), rel));
				// 只看形如 foo.md 的引用；CJK 文件名（题材卡）与锚点不在此列
				for (const m of text.matchAll(ASCII_MD_TOKEN)) {
					if (!allNames.has(m[1].replace(/\.md$/, ""))) dangling.add(m[1]);
				}
			}
		}
		const unregistered = [...dangling].filter((f) => !attributionText.includes(f));
		expect(
			unregistered,
			`这些交叉引用指向未收录文件、且没在 ATTRIBUTION.md 登记：${unregistered.join(", ")}`,
		).toEqual([]);
	});

	it("MIT 许可证随副本保留，收录 commit 记在案", () => {
		const attributionText = read(path.join(refsDir(CRAFT_SKILLS[0]), "ATTRIBUTION.md"));
		expect(attributionText).toMatch(/dab9e18d8f59ae6c8761a3b63aa71fd4b34d92e6/);
		for (const skill of CRAFT_SKILLS) {
			const license = path.join(refsDir(skill), "LICENSE-oh-story-claudecode.txt");
			expect(existsSync(license), `${skill} 缺许可证副本`).toBe(true);
			expect(read(license), `${skill} 的许可证不是 MIT 全文`).toMatch(/MIT License/);
			expect(read(license), `${skill} 的许可证缺著作权声明`).toMatch(/Copyright \(c\) 2025-2026 oh-story-claudecode/);
		}
	});

	it("四份 ATTRIBUTION 与四份 LICENSE 逐字节一致（同一批内容，改一处要四处同步）", () => {
		const first = CRAFT_SKILLS[0];
		const attribution = read(path.join(refsDir(first), "ATTRIBUTION.md"));
		const license = read(path.join(refsDir(first), "LICENSE-oh-story-claudecode.txt"));
		for (const skill of CRAFT_SKILLS.slice(1)) {
			expect(read(path.join(refsDir(skill), "ATTRIBUTION.md")), `${skill} 的 ATTRIBUTION 与 ${first} 不一致`).toBe(attribution);
			expect(read(path.join(refsDir(skill), "LICENSE-oh-story-claudecode.txt")), `${skill} 的 LICENSE 与 ${first} 不一致`).toBe(license);
		}
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

	it("每个技能的 SKILL.md 都能被 pi 加载，且出现在 <available_skills> 里", async () => {
		const { formatSkillsForPrompt, loadSkills } = await import("@earendil-works/pi-coding-agent");
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
