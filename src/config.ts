import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
	version?: string;
}

let pkg: PackageJson = {};
try {
	// Bun-compiled binaries have no package.json next to the bundle; prefer
	// the copy shipped next to the executable, then the source tree.
	const exePackage = join(dirname(process.execPath), "package.json");
	const sourcePackage = fileURLToPath(new URL("../package.json", import.meta.url));
	const packagePath = existsSync(exePackage) ? exePackage : sourcePackage;
	pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson;
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
