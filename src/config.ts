import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
	version?: string;
	/** npm 允许字符串或 { name, email, url }。 */
	author?: string | { name?: string };
	/** npm 允许字符串或 { type, url }。 */
	repository?: string | { url?: string };
	homepage?: string;
	/** SPDX 标识符(本项目为 MIT);「关于」页版权行用。 */
	license?: string;
}

let pkg: PackageJson = {};
try {
	// 打包产物里没有与 bundle 同级的 package.json,按优先级探测三种布局:
	//   1. bun 单文件 exe 旁(exe 名即包名,package.json 随发行物一起放)
	//   2. Electron 打包后:package.json 在 asar 内(electron-builder files 白名单收录)
	//   3. 源码树(开发期 / tsc 产物)
	// 第 2 条不能省:打包后 import.meta.url 被烘焙成**构建机**的源码路径,
	// 在用户机器上必然读不到(与 webDistDir 显式注入是同一类坑)。
	const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	const packagePath = [
		join(dirname(process.execPath), "package.json"),
		join(resourcesPath ?? "", "app.asar", "package.json"),
		fileURLToPath(new URL("../package.json", import.meta.url)),
	].find((p) => existsSync(p));
	if (packagePath) pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson;
} catch {
	// Not present in some bundled contexts; fall back to defaults below.
}

/**
 * Writer agent configuration paths.
 *
 * Everything writer-specific lives under ~/.pi/writer: books, chapter
 * sessions, and the agent config directory (~/.pi/writer/agent). pi-writer
 * does not read pi's ~/.pi/agent settings, extensions, skills, or sessions.
 */

/** Display name shown in the TUI header. */
export const APP_NAME = "pi-writer";
/** Window title prefix used by InteractiveMode. */
export const APP_TITLE = "Pi Writer";

/**
 * Writer-only data root. Books, settings, and sessions live here.
 * Override with the PI_WRITER_DIR environment variable.
 */
export function getWriterDir(): string {
	const override = process.env.PI_WRITER_DIR;
	if (override && override.trim().length > 0) return override;
	return join(homedir(), ".pi", "writer");
}

/**
 * Writer agent config directory (auth, models, settings, extensions, skills,
 * themes, packages, sessions). Fully independent from pi's ~/.pi/agent;
 * authenticate once inside pi-writer via /login.
 */
export function getAgentDir(): string {
	const override = process.env.PI_WRITER_AGENT_DIR;
	if (override && override.trim().length > 0) return override;
	return join(getWriterDir(), "agent");
}

/** Directory holding all books; each book is a subdirectory. */
export function getBooksDir(): string {
	return join(getWriterDir(), "books");
}

/**
 * 用户自定义主题目录:放置 *.css 即成为可选主题(经 /api/themes 伺服)。
 * PI_WRITER_THEMES_DIR 覆盖(Android 壳注入路径用);缺省 ~/.pi/writer/themes。
 */
export function getThemesDir(): string {
	const override = process.env.PI_WRITER_THEMES_DIR;
	if (override && override.trim().length > 0) return override;
	return join(getWriterDir(), "themes");
}

/** Path to a book directory: <booksDir>/<slug>. */
export function getBookDir(slug: string): string {
	return join(getBooksDir(), slug);
}

/**
 * 全局作者画像文件(2026-10-13,Phase 2)。**跨书共用** —— 它是「这位作者本人
 * 长期稳定的偏好」(语气/文体/禁忌),不随书变(书的语气微调归该书 world.json 的
 * 约束)。与每本书的 memory.md 分工:memory.md 记「这本书发生了什么」,user.md 记
 * 「作者是谁、怎么跟他讲话」。缺省 ~/.pi/writer/user.md;不存在时锚里不注入该块。
 */
export function getUserProfilePath(): string {
	const override = process.env.PI_WRITER_USER_PROFILE;
	if (override && override.trim().length > 0) return override;
	return join(getWriterDir(), "user.md");
}

/** Path to a book's index file: <bookDir>/book.json. */
export function getBookIndexPath(slug: string): string {
	return join(getBookDir(slug), "book.json");
}

/** Path to a chapter session file inside a book: <bookDir>/<file>. */
export function getChapterFile(bookSlug: string, fileName: string): string {
	return join(getBookDir(bookSlug), fileName);
}

/**
 * Slugify a free-form book or chapter title into a filesystem-safe id.
 * Keep CJK characters as-is; everything else lowercased and dash-joined.
 */
export function slugify(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) return "untitled";
	const lower = trimmed.toLowerCase();
	const replaced = lower.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-");
	const stripped = replaced.replace(/^-+|-+$/g, "");
	return stripped.length > 0 ? stripped : "untitled";
}

/**
 * 定位 skills 目录:PI_WRITER_SKILLS_DIR 优先(Android 壳注入,烘焙的
 * import.meta.url 路径在 Android 上不可用);其次 Electron resources/app.asar/skills
 * (package.json files 含 skills,打包进 asar,2026-08-15);其次 bun 单文件 exe 旁的 skills;
 * 回退源码树 ../skills(TUI/web/stage 三处共用,原各自实现的收敛点)。
 */
export function resolveSkillsDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.PI_WRITER_SKILLS_DIR;
	if (override) return override;
	const resPath = (process as { resourcesPath?: string }).resourcesPath;
	if (resPath) {
		const asarSkills = join(resPath, "app.asar", "skills");
		if (existsSync(asarSkills)) return asarSkills;
	}
	const exeSkills = join(dirname(process.execPath), "skills");
	if (existsSync(exeSkills)) return exeSkills;
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "skills");
}

/**
 * 额外技能目录(2026-09-22,「放开 skill 限制」)。
 *
 * pi-writer 原本只经 additionalSkillPaths 加载自带的 skills/(critique / outline /
 * revise / stage-scripting)——那是 2026-08-11 为「独立身份」刻意收窄的(避免 ~/.agents
 * 全局技能混进写作会话)。0.1.0 起改为**完全放开**:机器上已有的技能直接用,不必为
 * 每本书复制一份。
 *
 * 扫描顺序(前者优先;同名冲突由 vendor loadSkills 记 collision 诊断):
 * 1. `PI_WRITER_EXTRA_SKILLS_DIRS`(冒号分隔,与 PATH 同款;供测试与特殊布局)
 * 2. `~/.agents/skills`(本机 agent 框架的全局技能约定目录)
 *
 * 不存在的目录直接滤掉——显式路径不存在时 loadSkills 会报诊断,而「用户没装那个
 * 目录」不该在每次启动时刷噪音。
 */
export function resolveExtraSkillsDirs(env: Record<string, string | undefined> = process.env): string[] {
	const dirs: string[] = [];
	const override = env.PI_WRITER_EXTRA_SKILLS_DIRS;
	if (override) {
		for (const part of override.split(":")) {
			const p = part.trim();
			if (p.length > 0) dirs.push(p);
		}
	}
	dirs.push(join(homedir(), ".agents", "skills"));
	// 去重(env 里可能重复给同一目录)+ 滤掉不存在的
	return dirs.filter((d, i) => dirs.indexOf(d) === i && existsSync(d));
}

/**
 * 技能目录的只读放行**基线**:自带 skills/ + 全局技能目录。
 *
 * 只是基线,不是完整清单——vendor 还会从 agentDir/skills、`<cwd>/.pi/skills`、
 * 插件与 package 发现技能(`noSkills:false`),那些目录只有「实际加载结果」知道。
 * 因此真正的放行清单 = 本函数 + `skillDirsOf(已加载技能)`:
 * session-factory 在装配完成后按加载结果重装守卫(兜底值),SessionHost 每轮 sendMessage
 * 把同源清单写进 ALS(**后者优先**)。两处都不能只给基线,否则模型按提示词里的绝对路径
 * 读技能会被「工具路径越界」拦下(2026-08-09 误拦;2026-10-01 在 agentDir/skills 上复现)。
 */
export function resolveSkillReadOnlyDirs(env: Record<string, string | undefined> = process.env): string[] {
	return [resolveSkillsDir(env), ...resolveExtraSkillsDirs(env)];
}

/**
 * 提示词缓存保留档位(vendor pi-ai 的 CacheRetention)。
 * 写作是间歇性交互,场景之间常超过默认 5 分钟 TTL——过期后整段上下文
 * 全价重算。`long` 映射 Anthropic `cache_control.ttl:"1h"`(写入 2x、
 * 读取仍约 0.1x)与 OpenAI `prompt_cache_retention:"24h"`;对 DeepSeek
 * 这类自动前缀缓存的 provider 无影响。
 */
export type CacheRetentionSetting = "short" | "long" | "none";

/**
 * 应用缓存保留档位:vendor pi-ai 在每次请求时读 `PI_CACHE_RETENTION`
 * (anthropic-messages 与 openai-completions 两条路径都有),这里在入口
 * 处把 `--cache-retention` 的值写入该环境变量;非法值抛中文错误。
 */
export function applyCacheRetention(value: string | undefined, env: Record<string, string | undefined> = process.env): void {
	if (!value) return;
	if (value !== "short" && value !== "long" && value !== "none") {
		throw new Error(`Invalid --cache-retention value: ${value}(可选 short | long | none)`);
	}
	env.PI_CACHE_RETENTION = value;
}

/** Version string; read from package.json (lockstep with the monorepo). */
export const VERSION: string = pkg.version || "0.0.0";

/**
 * 作者(package.json 的 author)。规范上是字符串,但 npm 也允许 `{ name, email }`,
 * 两种都收;读不到回空串(「关于」页据此显示占位,而不是编一个名字出来)。
 */
export function packageAuthor(): string {
	const a = pkg.author;
	if (typeof a === "string") return a.trim();
	if (a && typeof a === "object" && typeof a.name === "string") return a.name.trim();
	return "";
}

/**
 * 仓库地址(package.json 的 repository)。同样两种形态(字符串 / `{ url }`),
 * 原样返回,规范化交给调用方(见 src/about.ts 的 repositoryUrl)。
 */
export function packageRepository(): string {
	const r = pkg.repository;
	if (typeof r === "string") return r.trim();
	if (r && typeof r === "object" && typeof r.url === "string") return r.url.trim();
	return "";
}

/**
 * 许可证(package.json 的 license)。只取 SPDX 标识符这一种形态 ——
 * npm 也允许 `{ type, url }` 的老写法,但本项目用的是字符串,读不到就回空串
 * (「关于」页宁可少一行,也不显示一个编出来的许可证)。
 */
export function packageLicense(): string {
	const l = pkg.license;
	return typeof l === "string" ? l.trim() : "";
}

/** 项目主页(package.json 的 homepage);缺省回空串。 */
export function packageHomepage(): string {
	return (pkg.homepage ?? "").trim();
}
