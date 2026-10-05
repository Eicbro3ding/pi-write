/**
 * WriterServer —— GUI 后端的 HTTP 服务:Node 原生 http,REST 端点
 * (books/chapters/session/chat/models/world/draft/export/import/mcp/stage/setup/settings)
 * + SSE 事件流;web/dist 存在时对非 /api 的 GET/HEAD 提供静态文件(生产模式
 * 直接加载页面)。
 *
 * 不引 HTTP 框架,手写 URL 分段解析(multipart 用 busboy);错误体统一
 * { error: { code, message } }。
 * 路由为 (method, 路径段模式) 表驱动(见 ROUTES 建表注释),handler 按域分组;
 * 会话状态与事件由 SessionHost 持有,本类只做路由转接;
 * book.json 的 currentChapterFile 由本类在章节切换路由中维护。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, type Stats } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import busboy from "busboy";
import {
	addChapter,
	createBook,
	getBookSessionsDir,
	getChapterSessionsPath,
	initChapterFile,
	listBooks,
	loadBook,
	renameBook,
	setCurrentChapter,
	updateChapter,
} from "../book-manager.ts";
import { getPluginFrontendPath, listPlugins, loadPlugins, readPluginSettings, removePlugin, writePluginEnabled, writePluginSettings, writePluginTrusted, type PluginRouteDef, type PluginRuntimeInfo, type PluginWebCommandHandler } from "../plugin-loader.ts";
import { getAgentDir, getBookDir, getThemesDir, getWriterDir, VERSION } from "../config.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import {
	customModelIds,
	deleteCustomModel,
	deleteCustomProvider,
	duplicateModelIds,
	hasCustomProvider,
	hasModel,
	isThinkingFormat,
	parseModelsConfig,
	parseModelsConfigStrict,
	serializeModelsConfig,
	setThinkingFormat,
	THINKING_FORMATS,
	updateCustomModel,
	upsertCustomProvider,
	type CustomModelEntry,
	type CustomModelPatch,
	type ThinkingFormat,
	type ModelsConfig,
} from "../custom-models.ts";
import { WriteQueue } from "../write-queue.ts";
import {
	SETUP_VERSION,
	defaultSetupState,
	isSetupStepId,
	readSetupState,
	writeSetupState,
	type SetupState,
} from "../setup.ts";
import { readWriterSettings, updateWriterSettings, type WriterSettings } from "../writer-settings.ts";
import { resolveWriterShell } from "../shell-kind.ts";
import { listSkills } from "../skills-index.ts";
import { BOOK_FILE_GROUPS, classifyBookFileKind, isWorkspaceFile, listBookFiles, readWorkspaceText, statWorkspaceFile } from "../book-files.ts";
import { MAX_ZIP_BYTES, exportBookZip, readImportZip, type BookZipImport } from "./book-zip.ts";
import { ensureWorld, newId, readWorldEditRecord, saveWorld, WorldValidationError, type WorldData } from "../world-data.ts";
import { buildChapterContext, EMPTY_TRIM_SUMMARY, summarizeTrim, trimMemory, WORLD_CONTEXT_TYPE, type ContextSection, type TrimRecord, type TrimSummary } from "../world-context.ts";
import { buildInspectReport } from "../inspect/report.ts";
import type { SessionHost } from "./session-host.ts";
import { extractMessagesFromManager, usableModelRef, type ThinkingSummary } from "./session-host.ts";
import { askUserGate } from "../ask-user.ts";
import { readSessionFile, type SessionEntry } from "../pi-adapter/index.ts";
import { ProviderAuthError, sortProviders, type ProviderListItem } from "./provider-auth.ts";
import type { McpManager, McpServerStatus } from "../mcp/manager.ts";
import { getMcpConfigPath, type McpServerConfig } from "../mcp/config.ts";
import { WorldWatcher } from "./file-watcher.ts";
import { StageCommandError, type StageHost } from "./stage-host.ts";
import { WriterHost, isSafeSessionId } from "./writer-host.ts";

/** SSE 心跳间隔。 */
const PING_INTERVAL_MS = 30_000;
/** 请求体大小上限(1MB)。 */
const MAX_BODY_BYTES = 1_048_576;
/** 单张图片大小上限。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 图片格式白名单:multipart content-type → 存储扩展名。 */
const IMAGE_EXT_BY_TYPE: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

export interface WriterServerOptions {
	host: string; // 监听地址,默认 "127.0.0.1"
	port: number; // 监听端口,0 表示随机
	sessionHost: SessionHost;
	/** 静态资源根目录(web/dist,生产模式页面);缺省自动探测,目录不存在则静态服务关闭。 */
	webDistDir?: string;
	/** 可选 Bearer token 鉴权(Android 壳注入):未配置时行为与桌面版完全一致(全部放行)。 */
	authToken?: string;
	/** MCP 服务器管理器(web.ts 装配);未配置时 /api/mcp 端点保持 404(MCP 未启用)。 */
	mcpManager?: McpManager;
	/** 舞台区宿主(web.ts 装配);未配置时 /api/stage 端点保持 404(舞台区未启用)。 */
	stageHost?: StageHost;
	/** 常驻编剧宿主(web.ts 装配);未配置时 /api/writer 端点保持 404(编辑 agent 未启用)。 */
	writerHost?: WriterHost;
	/**
	 * 插件预留缝(2026-08):附加 HTTP 路由,在构造时追加到内置路由表之后。
	 * 路由匹配规则见 Route 注释(静态段先于参数段);插件 handler 与内置 handler
	 * 同等受鉴权、回环 Host 校验与统一错误体约束。
	 */
	extraRoutes?: Route[];
}

/** 静态文件 MIME 表(按扩展名);未列出的默认 text/plain;charset=utf-8。 */
const STATIC_MIME: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	svg: "image/svg+xml; charset=utf-8",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	ico: "image/x-icon",
	json: "application/json; charset=utf-8",
};

/** 路径是否存在且为目录(不存在/不可访问返回 false)。 */
function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** 取路径 stat;不存在/不可访问返回 null。 */
function safeStat(p: string): Stats | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

/** 按扩展名取静态文件 content-type。 */
function contentTypeFor(file: string): string {
	const ext = extname(file).slice(1).toLowerCase();
	return STATIC_MIME[ext] ?? "text/plain; charset=utf-8";
}

/**
 * 探测 web/dist 静态目录(生产模式 Electron/浏览器直接加载页面),参考
 * resolveSkillsDir 的 env 覆盖 + exeDir/source 双路径:PI_WRITER_WEB_DIR 优先
 * (Android 壳注入,烘焙的 import.meta.url 路径在 Android 上不可用);其次 bun
 * 单文件 exe 旁的 web/dist;回退源码树 src/web/../../web/dist(tsc 产物
 * dist/web/server.js 同样适用)。均不存在返回 null(静态服务关闭,非 /api
 * 保持 404)。
 */
function resolveWebDistDir(env: Record<string, string | undefined> = process.env): string | null {
	const override = env.PI_WRITER_WEB_DIR;
	if (override && isDirectory(override)) return override;
	const exeDist = join(dirname(process.execPath), "web", "dist");
	if (isDirectory(exeDist)) return exeDist;
	const here = dirname(fileURLToPath(import.meta.url));
	const srcDist = join(here, "..", "..", "web", "dist");
	if (isDirectory(srcDist)) return srcDist;
	return null;
}

/** 主题清单条目(内置/用户共用)。 */
interface UserThemeEntry {
	file: string;
	css: string;
}

/**
 * 探测内置主题资产目录。优先级:
 * 1. 已解析的静态目录(WriterServer.staticRoot)/themes——Electron 主进程显式传入
 *    app.asar/web/dist,直接从这里取最可靠;
 * 2. PI_WRITER_WEB_DIR/themes(与 resolveWebDistDir 的环境覆盖同源);
 * 3. Electron resources/app.asar/web/dist/themes(打包产物);
 * 4. bun 单文件 exe 旁 web/dist/themes;
 * 5. 源码树 web/public/themes(dev 真理源)与 web/dist/themes。
 * 均不存在返回 null(此时前端只剩 night 基底主题)。
 */
export function resolveBuiltinThemesDir(
	env: Record<string, string | undefined> = process.env,
	webDistDir?: string | null,
): string | null {
	const candidates: string[] = [];
	if (webDistDir) candidates.push(join(webDistDir, "themes"));
	const envDist = env.PI_WRITER_WEB_DIR;
	if (envDist) candidates.push(join(envDist, "themes"));
	const resPath = (process as { resourcesPath?: string }).resourcesPath;
	if (resPath) candidates.push(join(resPath, "app.asar", "web", "dist", "themes"));
	candidates.push(join(dirname(process.execPath), "web", "dist", "themes"));
	const here = dirname(fileURLToPath(import.meta.url));
	candidates.push(join(here, "..", "..", "web", "public", "themes"));
	candidates.push(join(here, "..", "..", "web", "dist", "themes"));
	for (const c of candidates) if (isDirectory(c)) return c;
	return null;
}

/** 带 HTTP 状态码与错误码的异常;route 兜底按此映射统一错误体。 */
class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/**
 * 校验 relPath 落在 bookDir 内;越界(相对路径上溯)、绝对路径或盘符路径返回 null。
 * 判定依据:resolve 后的绝对路径必须是 bookDir 本身或以 bookDir + sep 开头。
 */
export function resolveDraftPath(bookDir: string, relPath: string): string | null {
	if (relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath)) return null;
	const abs = resolve(bookDir, relPath);
	if (abs !== bookDir && !abs.startsWith(bookDir + sep)) return null;
	return abs;
}

/** 图片相对路径校验:必须 images/ 下单文件名;复用 resolveDraftPath 防越界。 */
function resolveImagePath(bookDir: string, file: string): string | null {
	if (!/^images\/(?!\.{1,2}$)[^\\/]+$/.test(file)) return null;
	return resolveDraftPath(bookDir, file);
}

/**
 * 回环来源守卫(防 DNS rebinding 与跨站请求滥用本地无鉴权 API):
 * Host 头主机名必须 ∈ {127.0.0.1, localhost, ::1};带端口(含 IPv6 方括号
 * [::1]:8811)与不带端口均接受。浏览器无法伪造 Host 头,因此 rebinding
 * 攻击的恶意域名会被拒绝;vite dev 代理转发的 localhost:5173 亦在名单内。
 */
export function isLoopbackHostName(hostHeader: string): boolean {
	let host = hostHeader.trim();
	if (host.startsWith("[")) {
		// IPv6 方括号形式 [::1]:8811
		const end = host.indexOf("]");
		if (end === -1) return false;
		host = host.slice(1, end);
	} else {
		const firstColon = host.indexOf(":");
		const lastColon = host.lastIndexOf(":");
		// 仅一个冒号 → host:port 形式,切掉端口;多个冒号是裸 IPv6,原样保留
		if (firstColon !== -1 && firstColon === lastColon) {
			host = host.slice(0, lastColon);
		}
	}
	host = host.toLowerCase();
	// 防御性去掉 IPv6 zone id(如 fe80::1%lo0);回环地址本身无 zone
	const pct = host.indexOf("%");
	if (pct !== -1) host = host.slice(0, pct);
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Origin 头的主机名是否回环;null origin(沙箱/本地文件)与非法值一律拒绝。 */
function originHostIsLoopback(origin: string): boolean {
	if (origin === "null") return false;
	try {
		const u = new URL(origin);
		return isLoopbackHostName(u.hostname);
	} catch {
		return false;
	}
}

/** 同步睡眠(rmSyncRetry 重试间隔;Atomics.wait 无事件循环依赖)。 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rmSync 带重试:Windows 上文件被瞬时占用(杀软/残留句柄)时 EPERM 中断删除,
 *  已删部分保留、剩余残留——重试等句柄释放;仍失败抛原错(调用方映射 500)。 */
function rmSyncRetry(target: string, tries = 3): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt >= tries) throw err;
			sleepSync(150 * attempt);
		}
	}
}

/** 读取 JSON 请求体;无 body 视为 {};超 1MB 拒绝 413;非法 JSON 拒绝 400。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			// 超限先排空剩余请求体:不消费完就响应,Node 会销毁连接,
			// 客户端(undici)下次复用该连接时读 ECONNRESET。
			for await (const _ of req) {
				// 丢弃,仅排空
			}
			throw new HttpError(413, "payload_too_large", "请求体过大(上限 1MB)");
		}
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
	} catch {
		throw new HttpError(400, "bad_request", "请求体不是合法 JSON");
	}
}

/** 取必填字符串字段;allowEmpty 时允许空串(交给下游默认值)。 */
function requireString(body: unknown, key: string, allowEmpty = false): string {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
		throw new HttpError(400, "bad_request", `缺少字段 ${key}`);
	}
	return value;
}

/** 取可选字符串字段;缺省返回 undefined,存在但非字符串则 400。 */
function optionalString(body: unknown, key: string): string | undefined {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HttpError(400, "bad_request", `字段 ${key} 必须是字符串`);
	return value;
}

/** 取可选布尔字段;缺省返回 undefined,存在但非布尔则 400。 */
function optionalBoolean(body: unknown, key: string): boolean | undefined {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new HttpError(400, "bad_request", `字段 ${key} 必须是布尔值`);
	return value;
}

/** 取可选数字或 null 字段;null 表示恢复模型默认。 */
function optionalNumberOrNull(body: unknown, key: string): number | null | undefined {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (value === undefined || value === null) return value;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "bad_request", `字段 ${key} 必须是数字或 null`);
	return value;
}

/** 自定义模型 id 规则(与 AddModelDialog 前端校验同款;唯一真相源)。 */
const CUSTOM_MODEL_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,127}$/;

/** models.json 路径(自定义 provider/模型配置;与 vendor ModelRuntime 读的是同一个)。 */
function modelsConfigPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 读 models.json(**只读展示路径**:不存在/损坏 → 空配置,不抛)。 */
async function readModelsConfig(): Promise<ModelsConfig> {
	try {
		return parseModelsConfig(await readFile(modelsConfigPath(), "utf8"));
	} catch {
		return {};
	}
}

/**
 * models.json 不可安全改写时抛出。
 *
 * 2026-10 审计 BUG-010:写入路径不能再把「读不懂」当「空配置」,否则原文件会被
 * 空快照覆盖(用户已有 provider/model 与未知字段静默丢失)。
 * - `invalid`:JSON 语法坏 / 顶层不是对象 / providers 形状不对 → 409,让用户先去修文件
 * - `io`:权限、IO 错误 → 500(与「没有配置」区分开)
 */
class ModelsConfigError extends Error {
	readonly reason: "invalid" | "io";
	readonly file: string;
	constructor(reason: "invalid" | "io", file: string, message: string) {
		super(message);
		this.name = "ModelsConfigError";
		this.reason = reason;
		this.file = file;
	}
}

/**
 * 读 models.json 供**写入**使用:区分「文件不存在(可初始化空配置)」与
 * 「存在但损坏/不可读(必须拒绝写入)」。文件不存在是唯一允许的初始化路径。
 */
async function readModelsConfigForWrite(): Promise<ModelsConfig> {
	const file = modelsConfigPath();
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		throw new ModelsConfigError("io", file, `读取 ${file} 失败:${err instanceof Error ? err.message : String(err)}`);
	}
	const parsed = parseModelsConfigStrict(text);
	if (!parsed.ok) {
		throw new ModelsConfigError("invalid", file, `${file} 无法解析(${parsed.message});已保留原文件,请先修复或删除它`);
	}
	return parsed.cfg;
}

/** 写 models.json(原子写)。 */
async function writeModelsConfig(cfg: ModelsConfig): Promise<void> {
	await atomicWriteFile(modelsConfigPath(), serializeModelsConfig(cfg));
}

/** ModelsConfigError → HTTP 响应(invalid 409 / io 500);错误文案不泄露任何 apiKey。 */
function modelsConfigHttpError(err: unknown): never {
	if (err instanceof ModelsConfigError) {
		throw new HttpError(err.reason === "io" ? 500 : 409, "config_error", err.message);
	}
	throw err;
}

/**
 * models.json 的只读诊断(2026-10 审计 BUG-010 / BUG-017):
 * - 文件存在但读不懂 → 一条「请修复」提示(写入路径会拒绝写入,UI 该提前说)
 * - 历史重复的模型条目 → 逐条列出(vendor 只认第一条,不静默删除用户数据)
 * 只读路径容错:任何异常都退化成空数组,不因为诊断失败而让 GET 失败。
 */
async function modelsConfigWarnings(): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(modelsConfigPath(), "utf8");
	} catch {
		return []; // 不存在 / 不可读:不在此处报错(写入路径会给出明确错误)
	}
	const parsed = parseModelsConfigStrict(text);
	if (!parsed.ok) return [`models.json 无法解析(${parsed.message});在修复前无法保存供应商与模型设置`];
	return duplicateModelIds(parsed.cfg).map(
		(d) => `models.json:供应商 ${d.provider} 下模型 ${d.model} 重复 ${d.count} 次,运行时只认第一条`,
	);
}

/**
 * 读取可选的思考参数协议字段(BUG-002)。
 * - 缺省 / `null` / 空串 → 不声明(`undefined`,由 vendor 按 provider 名与 baseUrl 自动探测)
 * - 合法值 → 该协议;非法值 → 400(与 models.json schema 的白名单同源)
 */
function readThinkingFormat(body: unknown): ThinkingFormat | null | undefined {
	const raw = (body as Record<string, unknown> | null)?.["thinkingFormat"];
	if (raw === undefined) return undefined;
	if (raw === null || raw === "") return null;
	if (!isThinkingFormat(raw)) {
		throw new HttpError(400, "bad_request", `thinkingFormat 只支持 ${THINKING_FORMATS.join(" / ")}`);
	}
	return raw;
}

/** 取可选正整数(上下文窗口 / 最大输出 Token);缺省 undefined,非法 400。 */
function optionalPositiveInt(body: unknown, key: string): number | undefined {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (value === undefined || value === null) return undefined;
	// 只接受数字与数字字符串(2026-10 审计 BUG-018:布尔/数组/对象经 Number() 会被
	// 悄悄换算成 1 / NaN,属于「用户填错了」,必须当场拒绝而不是落盘成非法配置)
	if (typeof value !== "number" && typeof value !== "string") {
		throw new HttpError(400, "bad_request", `字段 ${key} 必须是正整数`);
	}
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new HttpError(400, "bad_request", `字段 ${key} 必须是正整数`);
	}
	return n;
}

/** 规整模型输入类型(只接受 text/image);缺省 undefined,非法 400。 */
function normalizeModelInput(body: unknown, key = "input"): Array<"text" | "image"> | undefined {
	const value = (body as Record<string, unknown> | null)?.[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new HttpError(400, "bad_request", `字段 ${key} 必须是数组`);
	const out = [...new Set(value.filter((v): v is "text" | "image" => v === "text" || v === "image"))];
	if (out.length === 0) throw new HttpError(400, "bad_request", `${key} 至少包含 text 或 image`);
	return out;
}

/**
 * 从 Cookie 头解析 pi_writer_token 值:按 ";" 分段、trim 后找
 * "pi_writer_token=" 前缀,取前缀之后的部分;不存在返回 undefined。
 * 前缀匹配避免误吞其他 cookie(如 pi_writer_token2=...)。
 */
function parseCookieToken(cookieHeader: string | undefined): string | undefined {
	if (cookieHeader === undefined) return undefined;
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith("pi_writer_token=")) {
			return trimmed.slice("pi_writer_token=".length);
		}
	}
	return undefined;
}

/**
 * 规范化导入包的 book.json 为合法 BookIndex:slug 改写为最终目录名(冲突副本),
 * 补全缺省字段(version/chapters/currentChapterFile/createdAt/updatedAt)。
 * readImportZip 已保证 JSON 合法且含非空 slug/title,这里只做字段补全。
 */
function normalizeImportBookJson(raw: Buffer, slug: string): Buffer {
	const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	parsed.slug = slug;
	if (typeof parsed.title !== "string" || parsed.title.length === 0) parsed.title = slug;
	if (!Array.isArray(parsed.chapters)) parsed.chapters = [];
	if (typeof parsed.version !== "number") parsed.version = 1;
	if (typeof parsed.currentChapterFile !== "string") parsed.currentChapterFile = null;
	if (typeof parsed.createdAt !== "number") parsed.createdAt = Date.now();
	if (typeof parsed.updatedAt !== "number") parsed.updatedAt = Date.now();
	return Buffer.from(JSON.stringify(parsed, null, 2), "utf-8");
}

// ---- 路由表 ----

/** 路由条目:method + 路径段模式(":name" 为参数占位,匹配任意单段)。 */
export interface Route {
	method: string;
	segments: readonly string[];
	handler: (ctx: RouteContext) => Promise<void>;
}

/** handler 上下文:请求/响应/URL 与路径参数段。 */
export interface RouteContext {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	params: Record<string, string>;
}

/**
 * 按 (method, 段模式) 匹配路由(parts 不含 "api" 前缀段)。表顺序即优先级:
 * 同方法同段数的条目中,静态段模式(如 mcp/raw)必须排在参数模式(如 mcp/:name)之前。
 */
function matchRoute(method: string, parts: string[], routes: Route[]): { route: Route; params: Record<string, string> } | null {
	for (const route of routes) {
		if (route.method !== method || route.segments.length !== parts.length) continue;
		const params: Record<string, string> = {};
		let ok = true;
		for (let i = 0; i < parts.length; i++) {
			const seg = route.segments[i]!;
			if (seg.startsWith(":")) params[seg.slice(1)] = parts[i]!;
			else if (seg !== parts[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return { route, params };
	}
	return null;
}

/**
 * 当前 leaf 分支是否已含本章背景包(只读打开会话文件,不启动运行时)。
 *
 * 沿 leaf 链扫描 customType 为 world-context 的条目:压缩(compaction 把旧历史移出
 * leaf 链)之后背景包就不在上下文里了 → 返回 false → ensureChapterContext 补注入。
 *
 * 与 writer-host.ts 稳定块的指纹扫描同源思路,差别在于这里只判**存在性**而不是
 * 内容指纹:整包含草稿、发展线位置、最近用户消息等易变内容,指纹每轮都变,
 * 拿它当稳定键会导致每轮都重注入(白付全价未缓存输入)。
 *
 * 文件不存在/解析失败返回 false —— 宁可多注一次,也不要让世界书静默缺席。
 */
export function sessionLeafHasWorldContext(slug: string, chapterFile: string): boolean {
	try {
		const absPath = getChapterSessionsPath(slug, chapterFile);
		if (!existsSync(absPath)) return false;
		const sm = readSessionFile(absPath, getBookSessionsDir(slug), getBookDir(slug));
		if (!sm) return false;
		const leafId = sm.getLeafId();
		if (!leafId) return false;
		// 读取器只承诺 unknown[];entry 形状与 writer-host.ts 同源,按 SessionEntry 造型
		for (const e of sm.getBranch(leafId) as SessionEntry[]) {
			if (e.type !== "custom_message") continue;
			if ((e as { customType?: unknown }).customType === WORLD_CONTEXT_TYPE) return true;
		}
		return false;
	} catch {
		return false;
	}
}

export class WriterServer {
	private readonly httpServer = createServer((req, res) => void this.route(req, res));
	private readonly sseClients = new Set<ServerResponse>();
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly options: WriterServerOptions;
	/** 静态资源根目录(web/dist);null 表示未配置,非 /api 保持 404。 */
	private readonly staticRoot: string | null;
	/** 插件装载态(loadPlugins 结果;GET /api/plugins 合并展示装载错误)。 */
	private pluginInfos: PluginRuntimeInfo[] | null = null;
	/** 插件 Web 命令注册表(loadPlugins 的 webCommands;POST /api/plugins/:id/command 查询用)。 */
	private pluginWebCommands: Map<string, Record<string, PluginWebCommandHandler>> = new Map();
	/** 插件后端路由(仅 trusted 插件;segments 已加插件 id 前缀,装配时并入路由表)。 */
	private pluginRoutes: PluginRouteDef[] = [];
	/**
	 * 章节切换互斥队列:session 路由整体串行执行(切章 → 写 book.json → 注入背景包),
	 * 避免多浏览器并发切章时交错(最终会话章节与 book.json 不一致、背景包注入错章节)。
	 */
	private switchQueue: Promise<void> = Promise.resolve();
	/**
	 * 最近一次背景包装配的裁切摘要(2026-10-04,T4),键 = `slug/chapterFile`。
	 *
	 * 为什么缓存在这里而不是现算:装配发生在 injectChapterContext(可能只在
	 * 切章时跑一次),而查询发生在用户打开页面/拉 /context 时。不缓存就要么
	 * 每次查询重算一遍(浪费且可能与实际注入的上下文不一致——两次装配之间
	 * 世界书可能已被改),要么让前端猜。存下来的是**真正注进去的那一次**的结果。
	 */
	private readonly lastTrim = new Map<string, TrimSummary>();
	/**
	 * 最近一次背景包装配的分段占用快照(2026-10-04,T5 上下文可视化),
	 * 键与 lastTrim 相同(`slug/chapterFile`)。
	 *
	 * 与 lastTrim 同源同一次装配 —— 分两个 Map 而不是合成一个对象,是因为
	 * T4 的读写路径已经稳定,合成要动的地方多;两者键完全一致,查起来等价。
	 */
	private readonly lastSections = new Map<string, ContextSection[]>();
	/**
	 * 最近一次装配的**裁切明细**(TrimRecord 原样,2026-10-04 T5)。
	 *
	 * 与 lastTrim(展示用摘要)的区别:摘要把同类合并且丢掉 token 量,
	 * 而检视面板要的是「每一条省了多少、丢了会怎样」—— 那需要原始记录。
	 * 两者都由同一次 injectChapterContext 写入,键一致。
	 */
	private readonly lastTrimmed = new Map<string, TrimRecord[]>();
	/**
	 * models.json 读-改-写串行队列(2026-10 审计 BUG-011):并发新增/编辑/删除
	 * 自定义 provider/model 时,各自「读旧快照 → 改 → 原子写」会互相覆盖。
	 * 同一文件的操作排成一条链,锁内**重新读取**最新文件再变更。
	 * 只覆盖单进程;多进程竞争需文件锁/CAS,见 WriteQueue 注释。
	 */
	private readonly modelsQueue = new WriteQueue();
	/**
	 * 世界书/草稿外部变更监听:AI(工具/TUI)或外部编辑器直接改文件时,
	 * 轮询发现变更并广播(无缝同步;服务端自己的写入经 noteWritten 登记不重复广播)。
	 */
	private readonly watcher: WorldWatcher;
	/** 路由表(见 Route 注释;静态段优先于参数段)。 */
	private readonly routes: Route[];

	constructor(options: WriterServerOptions) {
		this.options = options;
		// 舞台区事件 → SSE 广播(stageHost 在 web.ts 先于本类创建,事件转发在此注入)
		if (options.stageHost) {
			options.stageHost.setEventSink((slug, event) => {
				if (event.type === "entry") {
					this.broadcast({ type: "stage_entry", slug, chapterFile: event.chapterFile, entry: event.entry });
				} else if (event.type === "system") {
					this.broadcast({ type: "stage_system", slug, chapterFile: event.chapterFile, text: event.text });
				} else if (event.type === "director_event") {
					// 导演会话事件全量透传(与 writer_event 同款):前端复用
					// processAgentEvent 归约 + MessageList 渲染(2026-08-11 统一重构)
					this.broadcast({ type: "stage_director_event", slug, chapterFile: event.chapterFile, event: event.event });
				} else if (event.type === "script_confirm") {
					// 剧本待确认:前端以卡片展示剧本并询问用户是否修改
					this.broadcast({ type: "stage_script_confirm", slug, chapterFile: event.chapterFile, sceneId: event.sceneId, script: event.script });
				} else if (event.type === "phase") {
					// 舞台阶段变化(开演/收幕):前端自动刷新快照
					this.broadcast({ type: "stage_phase", slug, chapterFile: event.chapterFile, phase: event.phase });
				} else if (event.type === "world_edit") {
					// 世界书编辑信号(world_update 工具已写记录文件):前端回合结束
					// 读 GET /api/stage/:slug/last-world-edit 渲染预览卡
					this.broadcast({ type: "stage_world_edit", slug, chapterFile: event.chapterFile });
				} else if (event.type === "director_done") {
					// 收幕导演整理回合结束:前端撤「导演正在编辑消息」提示条
					this.broadcast({ type: "stage_director_done", slug, chapterFile: event.chapterFile });
				} else {
					this.broadcast({
						type: "stage_done",
						slug,
						chapterFile: event.chapterFile,
						cmd: event.cmd,
						ok: event.ok,
						...(event.text !== undefined ? { text: event.text } : {}),
						...(event.thinking !== undefined ? { thinking: event.thinking } : {}),
					});
				}
			});
		}
		// 常驻编剧事件 → SSE 广播(writer_event:前端复用 processAgentEvent 归约,
		// 消息/思考/工具卡片与主会话同款逻辑;chapterFile 透传供前端按章节过滤,
		// book 模式(对话与章节分离)的会话另带 conversation,前端据它过滤到具体对话)
		if (options.writerHost) {
			options.writerHost.setEventSink((slug, chapterFile, event, conversation) => {
				this.broadcastWriterEvent(slug, chapterFile, event, conversation);
			});
		}
		// watchdog 重连成功后重建会话:新工具快照注入(与配置变更的 handleMcpReload 一致)
		if (options.mcpManager) {
			options.mcpManager.onReconnect = (name) => {
				void this.handleMcpReload().catch((err) => {
					process.stderr.write(`[server] MCP 重连后重建会话失败: ${err instanceof Error ? err.message : String(err)}\n`);
				});
			};
		}
		// 显式注入优先;缺省自动探测,目录不存在则静态服务关闭
		this.staticRoot = options.webDistDir
			? (isDirectory(options.webDistDir) ? options.webDistDir : null)
			: resolveWebDistDir();
		// 外部变更 → 广播(带 mtime:前端干净时重载、脏时提示冲突)
		this.watcher = new WorldWatcher((kind, rel, mtime) => {
			const slug = this.options.sessionHost.getState().bookSlug;
			if (!slug) return;
			if (kind === "world") {
				this.broadcast({ type: "world_changed", slug, mtime });
			} else {
				this.broadcast({ type: "draft_changed", slug, file: rel, mtime });
			}
		});
		// 路由表:顺序敏感——同方法同段数的条目中,静态段(如 mcp/raw)先于参数段(:name)。
		this.routes = [
			// books
			{ method: "GET", segments: ["books"], handler: (ctx) => this.handleGetBooks(ctx) },
			{ method: "POST", segments: ["books"], handler: (ctx) => this.handleCreateBook(ctx) },
			{ method: "POST", segments: ["books", "import"], handler: (ctx) => this.handlePostBookImport(ctx) },
			{ method: "GET", segments: ["books", ":slug"], handler: (ctx) => this.handleGetBook(ctx) },
			{ method: "PATCH", segments: ["books", ":slug"], handler: (ctx) => this.handlePatchBook(ctx) },
			{ method: "DELETE", segments: ["books", ":slug"], handler: (ctx) => this.handleDeleteBook(ctx) },
			{ method: "POST", segments: ["books", ":slug", "session"], handler: (ctx) => this.handlePostBookSession(ctx) },
			// 工作区文件清单(只读;按语义分组,见 src/book-files.ts)
			{ method: "GET", segments: ["books", ":slug", "files"], handler: (ctx) => this.handleGetBookFiles(ctx) },
			// 工作区单文件预览(只读;文本回 JSON、图片回字节,见 handleGetBookFile)
			{ method: "GET", segments: ["books", ":slug", "file"], handler: (ctx) => this.handleGetBookFile(ctx) },
			{ method: "POST", segments: ["books", ":slug", "images"], handler: (ctx) => this.handlePostBookImage(ctx) },
			{ method: "GET", segments: ["books", ":slug", "images", ":file"], handler: (ctx) => this.handleGetBookImage(ctx) },
			{ method: "DELETE", segments: ["books", ":slug", "images", ":file"], handler: (ctx) => this.handleDeleteBookImage(ctx) },
			{ method: "GET", segments: ["books", ":slug", "export"], handler: (ctx) => this.handleGetBookExport(ctx) },
			{ method: "POST", segments: ["books", ":slug", "chapters"], handler: (ctx) => this.handlePostChapter(ctx) },
			{ method: "PATCH", segments: ["books", ":slug", "chapters", ":id"], handler: (ctx) => this.handlePatchChapter(ctx) },
			// session / chat / messages
			{ method: "GET", segments: ["session", "tree"], handler: (ctx) => this.handleGetSessionTree(ctx) },
			{ method: "GET", segments: ["session"], handler: (ctx) => this.handleGetSession(ctx) },
			{ method: "POST", segments: ["chat"], handler: (ctx) => this.handlePostChat(ctx) },
			{ method: "POST", segments: ["messages", "retract"], handler: (ctx) => this.handleRetractMessage(ctx) },
			{ method: "POST", segments: ["messages", "branch"], handler: (ctx) => this.handleBranchMessage(ctx) },
			{ method: "POST", segments: ["messages", "navigate"], handler: (ctx) => this.handleNavigateMessage(ctx) },
			{ method: "POST", segments: ["abort"], handler: (ctx) => this.handleAbort(ctx) },
			// models / providers
			{ method: "GET", segments: ["models"], handler: (ctx) => this.handleGetModels(ctx) },
			{ method: "POST", segments: ["models", "refresh"], handler: (ctx) => this.handlePostModelsRefresh(ctx) },
			{ method: "POST", segments: ["models", "custom"], handler: (ctx) => this.handlePostModelCustom(ctx) },
			{ method: "PUT", segments: ["models", "custom"], handler: (ctx) => this.handlePutModelCustom(ctx) },
			{ method: "DELETE", segments: ["models", "custom"], handler: (ctx) => this.handleDeleteModelCustom(ctx) },
			{ method: "POST", segments: ["model"], handler: (ctx) => this.handlePostModel(ctx) },
			{ method: "POST", segments: ["thinking"], handler: (ctx) => this.handlePostThinking(ctx) },
			{ method: "POST", segments: ["sampling"], handler: (ctx) => this.handlePostSampling(ctx) },
			{ method: "GET", segments: ["providers"], handler: (ctx) => this.handleGetProviders(ctx) },
			{ method: "POST", segments: ["providers", "custom"], handler: (ctx) => this.handlePostProviderCustom(ctx) },
			{ method: "GET", segments: ["providers", ":id"], handler: (ctx) => this.handleGetProviderDetail(ctx) },
			{ method: "POST", segments: ["providers", ":id", "apikey"], handler: (ctx) => this.handlePostProviderApiKey(ctx) },
			{ method: "DELETE", segments: ["providers", ":id"], handler: (ctx) => this.handleDeleteProvider(ctx) },
			// world / draft / cards
			{ method: "GET", segments: ["world"], handler: (ctx) => this.handleGetWorld(ctx) },
			{ method: "PUT", segments: ["world"], handler: (ctx) => this.handlePutWorld(ctx) },
			{ method: "GET", segments: ["confirm-cards"], handler: (ctx) => this.handleGetConfirmCards(ctx) },
			{ method: "PUT", segments: ["confirm-cards"], handler: (ctx) => this.handlePutConfirmCards(ctx) },
			// 提问卡片(ask_user 工具的回落路径:工具在等这个答案才会返回)
			{ method: "POST", segments: ["ask-user", "answer"], handler: (ctx) => this.handlePostAskAnswer(ctx) },
			{ method: "POST", segments: ["ask-user", "cancel"], handler: (ctx) => this.handlePostAskCancel(ctx) },
			{ method: "GET", segments: ["draft"], handler: (ctx) => this.handleGetDraft(ctx) },
			{ method: "PUT", segments: ["draft"], handler: (ctx) => this.handlePutDraft(ctx) },
			// mcp(静态段 raw 必须在参数段 :name 之前)
			{ method: "GET", segments: ["mcp"], handler: (ctx) => this.handleGetMcp(ctx) },
			{ method: "POST", segments: ["mcp"], handler: (ctx) => this.handlePostMcp(ctx) },
			{ method: "GET", segments: ["mcp", "raw"], handler: (ctx) => this.handleGetMcpRaw(ctx) },
			{ method: "PUT", segments: ["mcp", "raw"], handler: (ctx) => this.handlePutMcpRaw(ctx) },
			{ method: "PUT", segments: ["mcp", ":name"], handler: (ctx) => this.handlePutMcpServer(ctx) },
			{ method: "DELETE", segments: ["mcp", ":name"], handler: (ctx) => this.handleDeleteMcpServer(ctx) },
			// plugins(插件管理:列表/启用开关/删除;装载在启动时,切换后重建会话;
			//   settings/command 为字面段,与 :id 参数段(2 段)段数不同无冲突)
			{ method: "GET", segments: ["plugins"], handler: (ctx) => this.handleGetPlugins(ctx) },
			{ method: "GET", segments: ["plugins", ":id", "frontend.mjs"], handler: (ctx) => this.handleGetPluginFrontend(ctx) },
			{ method: "GET", segments: ["plugins", ":id", "settings"], handler: (ctx) => this.handleGetPluginSettings(ctx) },
			{ method: "PUT", segments: ["plugins", ":id", "settings"], handler: (ctx) => this.handlePutPluginSettings(ctx) },
			{ method: "POST", segments: ["plugins", ":id", "command", ":name"], handler: (ctx) => this.handlePostPluginCommand(ctx) },
			{ method: "PUT", segments: ["plugins", ":id"], handler: (ctx) => this.handlePutPlugin(ctx) },
			{ method: "DELETE", segments: ["plugins", ":id"], handler: (ctx) => this.handleDeletePlugin(ctx) },
			// stage
			{ method: "GET", segments: ["stage", ":slug"], handler: (ctx) => this.handleGetStage(ctx) },
			{ method: "GET", segments: ["stage", ":slug", "last-world-edit"], handler: (ctx) => this.handleGetStageLastWorldEdit(ctx) },
			{ method: "POST", segments: ["stage", ":slug", "command"], handler: (ctx) => this.handlePostStageCommand(ctx) },
			// writer(常驻编剧/编辑 agent)
			{ method: "GET", segments: ["writer", ":slug"], handler: (ctx) => this.handleGetWriter(ctx) },
			{ method: "POST", segments: ["writer", ":slug", "chat"], handler: (ctx) => this.handlePostWriterChat(ctx) },
			{ method: "POST", segments: ["writer", ":slug", "abort"], handler: (ctx) => this.handlePostWriterAbort(ctx) },
			{ method: "POST", segments: ["writer", ":slug", "retract"], handler: (ctx) => this.handlePostWriterRetract(ctx) },
			{ method: "GET", segments: ["writer", ":slug", "tree"], handler: (ctx) => this.handleGetWriterTree(ctx) },
			{ method: "POST", segments: ["writer", ":slug", "navigate"], handler: (ctx) => this.handlePostWriterNavigate(ctx) },
			{ method: "GET", segments: ["writer", ":slug", "context"], handler: (ctx) => this.handleGetWriterContext(ctx) },
			{ method: "GET", segments: ["writer", ":slug", "stats"], handler: (ctx) => this.handleGetWriterStats(ctx) },
			{ method: "POST", segments: ["writer", ":slug", "compact"], handler: (ctx) => this.handlePostWriterCompact(ctx) },
			// inspect(上下文检视面板数据;纯读缓存,不创建会话,2026-10-04 T5)
			{ method: "GET", segments: ["writer", ":slug", "inspect"], handler: (ctx) => this.handleGetWriterInspect(ctx) },
			// conversations(对话清单/新建/删除;book 模式「章节与对话各聊各的」的入口。
			//   静态段 conversations 与参数段无同段数冲突,仍按约定静态在前)
			{ method: "GET", segments: ["conversations"], handler: (ctx) => this.handleGetConversations(ctx) },
			{ method: "POST", segments: ["conversations"], handler: (ctx) => this.handlePostConversation(ctx) },
			{ method: "DELETE", segments: ["conversations", ":id"], handler: (ctx) => this.handleDeleteConversation(ctx) },
			// skills(技能清单:给前端 `/skill` 菜单用;与 agent 装配同源,纯读不建会话)
			{ method: "GET", segments: ["skills"], handler: (ctx) => this.handleGetSkills(ctx) },
			// themes(用户自定义主题资产文件)
			{ method: "GET", segments: ["themes"], handler: (ctx) => this.handleGetThemes(ctx) },
			{ method: "GET", segments: ["themes", ":file"], handler: (ctx) => this.handleGetThemeFile(ctx) },
			{ method: "PUT", segments: ["themes", ":file"], handler: (ctx) => this.handlePutThemeFile(ctx) },
			{ method: "DELETE", segments: ["themes", ":file"], handler: (ctx) => this.handleDeleteThemeFile(ctx) },
			// setup(首次启动配置向导状态;静态段 reset 在表中唯一,无参数段冲突)
			{ method: "GET", segments: ["setup"], handler: (ctx) => this.handleGetSetup(ctx) },
			{ method: "POST", segments: ["setup"], handler: (ctx) => this.handlePostSetup(ctx) },
			{ method: "POST", segments: ["setup", "reset"], handler: (ctx) => this.handlePostSetupReset(ctx) },
			// settings(服务端设置:~/.pi/writer/settings.json;当前唯一项 = 经典模式。
			//  放服务端而非 localStorage:切换会改变 agent 装配,多窗口必须一致)
			{ method: "GET", segments: ["settings"], handler: (ctx) => this.handleGetSettings(ctx) },
			{ method: "PUT", segments: ["settings"], handler: (ctx) => this.handlePutSettings(ctx) },
			// 插件路由预留(构造参数;追加在内置路由之后)
			...(this.options.extraRoutes ?? []),
		];
	}

	/** 让 watcher 跟随当前会话书(启动/切章/改书名后调用)。 */
	private async syncWatcherBook(): Promise<void> {
		await this.watcher.setBook(this.options.sessionHost.getState().bookSlug);
	}

	async start(): Promise<{ port: number }> {
		// 订阅会话事件,广播给所有 SSE 连接(switchSession 后 SessionHost 已自动重绑)
		this.unsubscribe = this.options.sessionHost.subscribe((event) => {
			this.broadcast(event);
		});
		await this.syncWatcherBook();
		await new Promise<void>((resolvePromise, rejectPromise) => {
			// listen 失败(如端口被占 EADDRINUSE)必须 reject,否则调用方(CLI/Electron
			// 主进程)会永久挂起;Electron 侧据此杀残留进程或切换备用端口
			const onError = (err: Error): void => rejectPromise(err);
			this.httpServer.once("error", onError);
			this.httpServer.listen(this.options.port, this.options.host, () => {
				this.httpServer.removeListener("error", onError);
				resolvePromise();
			});
		});
		const addr = this.httpServer.address();
		const port = typeof addr === "object" && addr ? addr.port : this.options.port;
		this.pingTimer = setInterval(() => {
			for (const client of this.sseClients) this.writeSse(client, ": ping\n\n");
		}, PING_INTERVAL_MS);
		return { port };
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = undefined;
		this.watcher.dispose();
		await this.options.stageHost?.disposeAll();
		await this.options.writerHost?.disposeAll();
		for (const client of this.sseClients) client.end();
		this.sseClients.clear();
		await this.options.mcpManager?.close();
		await new Promise<void>((r) => this.httpServer.close(() => r()));
	}

	/** 向 SSE 客户端写帧;连接已断开(写入抛错)时静默移除。 */
	private writeSse(client: ServerResponse, frame: string): void {
		try {
			client.write(frame);
		} catch {
			this.sseClients.delete(client);
		}
	}

	/** 向所有 SSE 客户端广播一帧(会话事件与多客户端同步的合成事件共用)。 */
	private broadcast(event: unknown): void {
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.sseClients) this.writeSse(client, frame);
	}

	/** 插件预留缝:向所有 SSE 客户端广播自定义事件(前端按未知事件忽略,不会破坏既有 reducer)。 */
	broadcastEvent(event: unknown): void {
		this.broadcast(event);
	}

	/**
	 * writer_event 帧的**唯一构造点**(事件转发与 chat_error 兜底同款)。
	 *
	 * 章节模式(conversation 为 undefined)的负载与本次改动前**逐字节一致**:
	 * `{ type, slug, chapterFile, event }`。book 模式(对话与章节分离)的会话多一个
	 * `conversation` 字段,前端据它把事件过滤到具体对话。
	 */
	private broadcastWriterEvent(slug: string, chapterFile: string | null, event: unknown, conversation?: string): void {
		this.broadcast(
			conversation === undefined
				? { type: "writer_event", slug, chapterFile, event }
				: { type: "writer_event", slug, chapterFile, conversation, event },
		);
	}

	/**
	 * 把章节切换任务串行入队;任务内抛错不影响后续任务(错误已由路由层映射为响应)。
	 */
	private enqueueSwitch(task: () => Promise<void>): Promise<void> {
		const run = this.switchQueue.then(task);
		this.switchQueue = run.catch(() => undefined);
		return run;
	}

	/**
	 * 注入世界书背景包:switchSession/reloadRuntime 之后,以当前会话的
	 * 章节上下文(custom 消息随下个 prompt 进入)重建 nextTurn 背景包。
	 */
	private async injectChapterContext(slug: string, chapterFile: string): Promise<void> {
		const chapterId = chapterFile.replace(/\.jsonl$/, "");
		let draftText = "";
		try {
			draftText = await readFile(join(getBookDir(slug), "draft", `${chapterId}.md`), "utf-8");
		} catch {
			draftText = "";
		}
		// 预算全部来自用户设置(2026-10-04:此前是写死的常量,用户无法调整)
		const settings = await readWriterSettings();
		// 跨章节记忆:memory.md(容量有限,注入端按预算裁剪;不存在则为空)
		let memory = "";
		try {
			memory = trimMemory(await readFile(join(getBookDir(slug), "memory.md"), "utf-8"), settings.memoryBudget);
		} catch {
			memory = "";
		}
		const world = await ensureWorld(slug);
		const recent = this.options.sessionHost
			.getState()
			.messages.filter((m) => m.role === "user")
			.slice(-2)
			.map((m) => m.text);
		const context = buildChapterContext(world, {
			chapterId,
			draftText,
			recentUserMessages: recent,
			memory,
			budget: settings.contextBudget,
			activationDepth: settings.activationDepth,
			limits: {
				noticeInjectLimit: settings.noticeInjectLimit,
				completedMilestoneLimit: settings.completedMilestoneLimit,
			},
		});
		const trim = summarizeTrim(context);
		// 裁切可见(2026-10-04):缓存的必须是「这一次真正注进去的」结果,
		// 查询端(/context)只读不重算 —— 两次装配之间世界书可能已被 AI 改过,
		// 重算出的摘要会与用户实际看到的上下文对不上。
		this.lastTrim.set(`${slug}/${chapterFile}`, trim);
		this.lastSections.set(`${slug}/${chapterFile}`, context.sections);
		this.lastTrimmed.set(`${slug}/${chapterFile}`, context.trimmed);
		if (context.text.length > 0) {
			await this.options.sessionHost.injectContext(context.text);
		}
	}

	/**
	 * 保证本章背景包**仍在上下文里**;不在就补注入(2026-10-05 失忆修复 P0)。
	 *
	 * 背景包是会话里的一条普通 custom 消息。只在切章注入一次的话,一次
	 * compaction(旧历史被移出 leaf 链)就能把记忆、世界书条目、Notice、发展线
	 * 全部抹掉 —— 而提示词还告诉 agent「记忆已在上下文里」,于是它也不会去读
	 * memory.md 自救,表现为纯粹的失忆。
	 *
	 * 每轮 chat 前扫一次 leaf 链:还在就零额外成本跳过,丢了就按当前世界状态
	 * 重新装配一份注进去。用「存在性」而非「内容指纹」判据的理由见
	 * sessionLeafHasWorldContext —— 世界书中途被改而背景包还在的情况属 P1
	 * (稳定块/易变块拆分),不在本方法的职责内。
	 */
	private async ensureChapterContext(): Promise<void> {
		const state = this.options.sessionHost.getState();
		if (!state.bookSlug || !state.chapterFile) return;
		if (sessionLeafHasWorldContext(state.bookSlug, state.chapterFile)) return;
		await this.injectChapterContext(state.bookSlug, state.chapterFile);
	}

	/**
	 * 取某会话最近一次的裁切摘要(无裁切/未装配过时空摘要,见 /context 端点)。
	 *
	 * 查询侧与写入侧的键都取「章节文件名」(如 ch01.jsonl),但两边来源不同
	 * (写入来自切章路由,查询来自前端 writerTargetNow),book 模式下查询侧
	 * 可能传 null。先精确匹配,未命中再回落到该书下**最近写入**的那条 ——
	 * 摘要只用于提示,回落到同书的最近一次比显示空白更符合用户直觉。
	 */
	lastTrimSummary(slug: string, chapterFile: string | null, _conversation?: string): TrimSummary {
		const exact = this.lastTrim.get(`${slug}/${chapterFile ?? ""}`);
		if (exact) return exact;
		// Map 迭代顺序 = 插入顺序,倒序找该书最近一次
		let latest: TrimSummary | undefined;
		for (const [key, value] of this.lastTrim) {
			if (key.startsWith(`${slug}/`)) latest = value;
		}
		return latest ?? EMPTY_TRIM_SUMMARY;
	}

	/**
	 * 取某会话最近一次的分段占用快照,用法与 lastTrimSummary 一致(2026-10-04,T5)。
	 *
	 * 未装配过时返回空数组 —— 面板据此显示「本章还没有注入过背景包」,
	 * 而不是编一份看起来像真的数据。
	 */
	lastSectionSnapshot(slug: string, chapterFile: string | null): ContextSection[] {
		const exact = this.lastSections.get(`${slug}/${chapterFile ?? ""}`);
		if (exact) return exact;
		let latest: ContextSection[] | undefined;
		for (const [key, value] of this.lastSections) {
			if (key.startsWith(`${slug}/`)) latest = value;
		}
		return latest ?? [];
	}

	/** 取某会话最近一次的裁切明细(TrimRecord 原样);未装配过时为空数组。 */
	lastTrimmedSnapshot(slug: string, chapterFile: string | null): TrimRecord[] {
		const exact = this.lastTrimmed.get(`${slug}/${chapterFile ?? ""}`);
		if (exact) return exact;
		let latest: TrimRecord[] | undefined;
		for (const [key, value] of this.lastTrimmed) {
			if (key.startsWith(`${slug}/`)) latest = value;
		}
		return latest ?? [];
	}

	/**
	 * If-Match 条件写校验(防本地旧文本覆盖 AI/其他窗口的新修改):
	 * 头缺省或为 * 放行;否则与磁盘文件当前 mtimeMs 比较,不一致 → 409 conflict。
	 * 文件不存在也视为不一致(本地以为存在,磁盘已被删)。
	 */
	private checkIfMatch(req: IncomingMessage, abs: string): void {
		const expected = req.headers["if-match"];
		if (expected === undefined || expected === "*") return;
		const want = Number.parseFloat(Array.isArray(expected) ? expected[0]! : expected);
		let actual: number | null = null;
		try {
			actual = statSync(abs).mtimeMs;
		} catch {
			actual = null;
		}
		// 1ms 容差:文件系统 mtime 精度有限(Windows FAT 等)
		if (Number.isNaN(want) || actual === null || Math.abs(actual - want) > 1) {
			throw new HttpError(409, "conflict", "文件已被其他编辑修改,请重新加载后再保存");
		}
	}

	/**
	 * 章节切换(互斥队列内执行):校验章节 → initChapterFile → switchSession →
	 * setCurrentChapter → 广播 session_changed(多浏览器同步)→ 注入世界书背景包。
	 */
	private async handleSwitchSession(slug: string, chapterFile: string): Promise<void> {
		const book = await loadBook(slug);
		if (!book) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		// 章节必须已登记在书索引中(索引文件名天然不含分隔符,顺带挡住路径穿越)
		if (!book.chapters.some((c) => c.file === chapterFile)) {
			throw new HttpError(404, "not_found", `章节不存在: ${chapterFile}`);
		}
		const sessionsDir = getBookSessionsDir(slug);
		const absPath = getChapterSessionsPath(slug, chapterFile);
		if (absPath !== sessionsDir && !absPath.startsWith(sessionsDir + sep)) {
			throw new HttpError(400, "bad_path", "章节文件路径越界");
		}
		await initChapterFile(absPath, getBookDir(slug));
		await this.options.sessionHost.switchSession(absPath, getBookDir(slug));
		await setCurrentChapter(slug, chapterFile);
		// 广播会话切换:另一浏览器据此对齐(刷新书详情/聊天/草稿);自己的切换由前端比对跳过
		this.broadcast({ type: "session_changed", bookSlug: slug, chapterFile });
		// 注入世界书背景包:switchSession 之后 SessionHost 已重绑新会话,
		// injectContext 的 sendCustomMessage 落在新会话上(custom 消息随下个 prompt 进入)
		await this.injectChapterContext(slug, chapterFile);
		// 外部变更监听跟随新书(切章可能跨书)
		await this.syncWatcherBook();
	}

	/**
	 * MCP 配置变更后的收尾:重连已完成(manager.reload),重建会话 runtime 让
	 * 新工具生效,再重新注入背景包(reload 后 nextTurn 队列为空),最后广播
	 * session_changed 让前端对齐。
	 */
	private async handleMcpReload(): Promise<void> {
		await this.options.sessionHost.reloadRuntime();
		const state = this.options.sessionHost.getState();
		if (state.bookSlug && state.chapterFile) {
			await this.injectChapterContext(state.bookSlug, state.chapterFile);
		}
		this.broadcast({ type: "session_changed", bookSlug: state.bookSlug, chapterFile: state.chapterFile });
	}

	/**
	 * 校验 MCP 服务器配置体(name/type/command/url 等),返回规范化配置。
	 *
	 * 2026-10 审计 BUG-019:`type` 此前只接受 stdio / sse,而共享 schema
	 * (src/mcp/config.ts 的 ServerSchema)、McpManager 连接层与前端选项都支持
	 * `http`(streamable HTTP,现行标准)—— 前端选 http 保存必然 400,功能不可用。
	 * 三种类型统一走这里:stdio 要 command;sse / http 要合法 URL。
	 */
	private readMcpServerBody(body: unknown): McpServerConfig {
		const record = body as Record<string, unknown> | null;
		if (!record || typeof record !== "object") throw new HttpError(400, "bad_request", "缺少服务器配置");
		const name = requireString(body, "name");
		const type = requireString(body, "type");
		if (type !== "stdio" && type !== "sse" && type !== "http") {
			throw new HttpError(400, "bad_request", "type 必须是 stdio、sse 或 http");
		}
		const server: McpServerConfig = { name: name.trim(), type };
		const command = optionalString(body, "command");
		if (command !== undefined) server.command = command;
		const args = record["args"];
		if (args !== undefined) {
			if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
				throw new HttpError(400, "bad_request", "args 必须是字符串数组");
			}
			server.args = args as string[];
		}
		const env = record["env"];
		if (env !== undefined) {
			if (env === null || typeof env !== "object" || Array.isArray(env)) {
				throw new HttpError(400, "bad_request", "env 必须是对象");
			}
			server.env = env as Record<string, string>;
		}
		const url = optionalString(body, "url");
		if (url !== undefined) server.url = url;
		// 必填项按类型校验(与 src/mcp/config.ts 的 validateMcpConfig 同一套语义)
		if (type === "stdio" && !server.command?.trim()) throw new HttpError(400, "bad_request", "stdio 类型必须提供 command");
		if (type !== "stdio" && !server.url?.trim()) throw new HttpError(400, "bad_request", `${type} 类型必须提供 url`);
		if (type !== "stdio" && !/^https?:\/\//.test(server.url!.trim())) {
			throw new HttpError(400, "bad_request", "url 必须是 http(s) 地址");
		}
		return server;
	}

	private send(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}

	/**
	 * 解析 multipart/form-data 中的单文件字段(name 固定):返回 { filename, buffer, contentType }。
	 * 用 busboy 流式解析(2026-08-10 替换旧手写 boundary 切分——边界条件多,
	 * 是安全 bug 高发区);字段任意顺序、多字段均支持。
	 * 超限(默认 > MAX_ZIP_BYTES,图片上传传入 MAX_IMAGE_BYTES)抛 400,
	 * 防止超大 body 拖垮内存。
	 */
	private async readMultipartFile(req: IncomingMessage, fieldName: string, opts?: { limit?: number; tooLargeMessage?: string }): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
		const contentType = String(req.headers["content-type"] ?? "");
		if (!/^multipart\/form-data/i.test(contentType)) {
			throw new HttpError(400, "bad_request", "缺少 multipart boundary");
		}
		const limit = opts?.limit ?? MAX_ZIP_BYTES;
		const tooLargeMessage = opts?.tooLargeMessage ?? `zip 超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB`;
		return new Promise<{ filename: string; buffer: Buffer; contentType: string }>((resolve, reject) => {
			const bb = busboy({ headers: req.headers, limits: { fileSize: limit } });
			let result: { filename: string; buffer: Buffer; contentType: string } | null = null;
			let tooLarge = false;
			bb.on("file", (name, stream, info) => {
				if (name !== fieldName) {
					// 非目标字段(如 title 在 file 之前):排空即可,不消费完 close 不会触发
					stream.resume();
					return;
				}
				const chunks: Buffer[] = [];
				stream.on("data", (chunk: Buffer) => chunks.push(chunk));
				// fileSize 超限:busboy 截断流并继续解析剩余 part,close 时统一报 too_large
				stream.on("limit", () => {
					tooLarge = true;
				});
				stream.on("end", () => {
					result = { filename: info.filename, buffer: Buffer.concat(chunks), contentType: info.mimeType.toLowerCase() };
				});
			});
			bb.on("error", (err) => {
				reject(new HttpError(400, "bad_request", `multipart 解析失败: ${err instanceof Error ? err.message : String(err)}`));
			});
			bb.on("close", () => {
				if (tooLarge) {
					reject(new HttpError(400, "too_large", tooLargeMessage));
				} else if (result) {
					resolve(result);
				} else {
					reject(new HttpError(400, "bad_request", `缺少 multipart 字段 ${fieldName}`));
				}
			});
			req.pipe(bb);
		});
	}

	/**
	 * 解析 draft 相对路径,按书根目录相对(TUI 约定:draft/<章节>.md、.writer/*.md、
	 * outline.md——世界书页按 fileRel 读写同一文件)。显式 slug 优先(前端按当前
	 * 显示书传入,避免多客户端/切换竞态下写错会话书);无 slug 时退回会话书;
	 * 无会话时退化为 writer 根目录(越界校验仍然生效)。
	 */
	private resolveDraftFile(file: string, slug?: string): { abs: string; slug: string | null } {
		const bookSlug = slug ?? this.options.sessionHost.getState().bookSlug;
		const base = bookSlug ? getBookDir(bookSlug) : getWriterDir();
		const abs = resolveDraftPath(base, file);
		if (!abs) throw new HttpError(400, "bad_path", "文件路径越界");
		return { abs, slug: bookSlug };
	}

	/** 章节附属文件(与会话同目录):书/章节校验与路径防穿越;suffix 如 ".cards.json"/".confirm.json"。 */
	private async resolveChapterSideFile(slug: string, chapterFile: string, suffix: string): Promise<string> {
		const book = await loadBook(slug);
		if (!book) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		if (!book.chapters.some((c) => c.file === chapterFile)) {
			throw new HttpError(404, "not_found", `章节不存在: ${chapterFile}`);
		}
		const sessionsDir = getBookSessionsDir(slug);
		const absPath = getChapterSessionsPath(slug, chapterFile);
		if (absPath !== sessionsDir && !absPath.startsWith(sessionsDir + sep)) {
			throw new HttpError(400, "bad_request", "非法章节路径");
		}
		return absPath.replace(/\.jsonl$/, "") + suffix;
	}

	// ---- books 路由 ----

	/** GET /api/books:全部书(按 updatedAt 倒序)。 */
	private async handleGetBooks(ctx: RouteContext): Promise<void> {
		const books = await listBooks();
		this.send(ctx.res, 200, { books });
	}

	/** POST /api/books {title}:新建书。 */
	private async handleCreateBook(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const title = requireString(body, "title");
		const book = await createBook(title);
		this.send(ctx.res, 200, { book });
	}

	/** GET /api/books/:slug:书详情(索引 + 章节)。 */
	private async handleGetBook(ctx: RouteContext): Promise<void> {
		const book = await loadBook(ctx.params.slug!);
		if (!book) throw new HttpError(404, "not_found", `书不存在: ${ctx.params.slug}`);
		this.send(ctx.res, 200, { book });
	}

	/**
	 * PATCH /api/books/:slug {title}:重命名书(slug 随标题重算,工作区/会话目录/索引整体迁移)。
	 * 若该书是当前会话书,走互斥队列把会话切到新路径(handleSwitchSession 复用:校验 →
	 * switchSession 新 absPath → setCurrentChapter → 广播 session_changed → 注入背景包),
	 * 避免 session-host 的 bookSlug(由会话文件路径推导)停留在旧 slug。
	 */
	private async handlePatchBook(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const body = await readJsonBody(ctx.req);
		const title = requireString(body, "title");
		const book = await renameBook(slug, title);
		const state = this.options.sessionHost.getState();
		if (state.bookSlug === slug && book.currentChapterFile) {
			await this.enqueueSwitch(() => this.handleSwitchSession(book.slug, book.currentChapterFile!));
		}
		this.send(ctx.res, 200, { book });
	}

	/** DELETE /api/books/:slug:删除书目录与会话目录。
	 *  删除前释放该书全部内存会话(编剧/舞台编排器),否则删除后 AI 仍在内存、
	 *  继续写 draft/world.json,目录「复活」残留(2026-08-10 根因);
	 *  rmSync 带重试——Windows 上文件被瞬时占用时 EPERM 会中断删除导致部分残留。 */
	private async handleDeleteBook(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		// 释放该书的内存会话(每书惰性创建;删除后不释放会继续写文件)
		await this.options.writerHost?.dispose(slug);
		await this.options.stageHost?.dispose(slug);
		// 当前会话书被删:中止生成并释放运行时(会话文件随后删除;下次切章时
		// SessionHost.switchSession 会按新书目录重新启动,避免悬空 runtime 继续写旧文件)
		if (this.options.sessionHost.getState().bookSlug === slug) {
			await this.options.sessionHost.abort();
			await this.options.sessionHost.dispose();
			await this.watcher.setBook(null);
		}
		rmSyncRetry(getBookDir(slug));
		rmSyncRetry(getBookSessionsDir(slug));
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/books/:slug/session {chapterFile}:校验章节 → initChapterFile →
	 * switchSession(绝对路径) → setCurrentChapter(book.json)→ 202。
	 * 整体经互斥队列串行,避免多浏览器并发切章交错。
	 */
	private async handlePostBookSession(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		const body = await readJsonBody(ctx.req);
		const chapterFile = requireString(body, "chapterFile");
		await this.enqueueSwitch(() => this.handleSwitchSession(slug, chapterFile));
		this.send(ctx.res, 202, { ok: true });
	}

	/**
	 * POST /api/books/:slug/images:multipart 单文件字段 file → 存书目录 images/。
	 * 限制单张 ≤ MAX_IMAGE_BYTES;格式白名单 png/jpeg/webp/gif;文件名服务端生成。
	 */
	private async handlePostBookImage(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const { buffer, contentType } = await this.readMultipartFile(ctx.req, "file", {
			limit: MAX_IMAGE_BYTES,
			tooLargeMessage: `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
		});
		const ext = IMAGE_EXT_BY_TYPE[contentType];
		if (!ext) throw new HttpError(400, "bad_request", "仅支持 png/jpeg/webp/gif 图片");
		const dir = join(getBookDir(slug), "images");
		await mkdir(dir, { recursive: true });
		const file = `images/${newId("img")}.${ext}`;
		await writeFile(join(getBookDir(slug), file), buffer);
		this.send(ctx.res, 200, { file });
	}

	/**
	 * GET /api/books/:slug/images/:file:图片二进制(关系图节点/词条页读取)。
	 * :file 段携带完整引用(world.json 中的 "images/x.png",前端 encodeURIComponent
	 * 编码为单段 images%2Fx.png,route 开头已逐段解码)——直接作为相对路径校验,
	 * 契约:world.json 引用 = API 引用。
	 */
	private async handleGetBookImage(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		const abs = resolveImagePath(getBookDir(slug), ctx.params.file!);
		if (!abs) throw new HttpError(400, "bad_path", "图片路径越界");
		let body: Buffer;
		try {
			body = await readFile(abs);
		} catch {
			throw new HttpError(404, "not_found", "图片不存在");
		}
		ctx.res.writeHead(200, { "content-type": contentTypeFor(abs), "content-length": body.length });
		ctx.res.end(body);
	}

	/** DELETE /api/books/:slug/images/:file:删除图片文件(引用由前端先移除,删失败不阻塞保存)。
	 *  :file 段契约同 GET:完整引用(images/x.png)经编码后到达,解码即相对路径。 */
	private async handleDeleteBookImage(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		const abs = resolveImagePath(getBookDir(slug), ctx.params.file!);
		if (!abs) throw new HttpError(400, "bad_path", "图片路径越界");
		try {
			unlinkSync(abs);
		} catch {
			throw new HttpError(404, "not_found", "图片不存在");
		}
		this.send(ctx.res, 200, { ok: true });
	}

	/** GET /api/books/:slug/export:导出整书为 zip(二进制,application/zip)。 */
	private async handleGetBookExport(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const buf = await exportBookZip(getBookDir(slug));
		ctx.res.writeHead(200, { "content-type": "application/zip", "content-length": buf.length });
		ctx.res.end(buf);
	}

	/**
	 * GET /api/books/:slug/files:书目录文件清单(**只读**)。
	 *
	 * 按语义分组返回(草稿 / 资料与笔记 / 图片 / 设定视图 / 其他)+ 分组标签,
	 * 而不是镜像磁盘树——`draft/`、`.writer/`、`stage/` 是实现细节,不摊给用户。
	 * 每组条目仍带真实相对路径(想直连磁盘有出口)。
	 *
	 * 目前**不带**「谁改的」标记:文件系统只留 mtime,区分人改/AI 改需要一份
	 * 写入台账(前端可先用 SSE 的 draft_changed + writer_event 内存态近似)。
	 */
	private async handleGetBookFiles(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		const book = await loadBook(slug);
		if (!book) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const files = await listBookFiles(
			getBookDir(slug),
			book.chapters.map((c) => ({ id: c.id, title: c.title })),
		);
		this.send(ctx.res, 200, { slug, groups: BOOK_FILE_GROUPS, files });
	}

	/**
	 * GET /api/books/:slug/file?path=<相对路径>:读工作区单个文件(**只读**、**无写入端点**)。
	 *
	 * 校验链与清单同源:isWorkspaceFile(路径语法 + 排除规则)→ statWorkspaceFile
	 * (存在 + 普通文件;符号链接拒绝)→ 越界/隐藏/机器数据一律 400,不存在 404。
	 *
	 * 文本文件回 JSON(text 超过 512KB 截断并带 truncated);图片直接回字节流,
	 * 因为 <img src> 需要 URL,在 JSON 里塞 base64 只是白费内存。
	 */
	private async handleGetBookFile(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const rel = ctx.url.searchParams.get("path") ?? "";
		if (!isWorkspaceFile(rel)) throw new HttpError(400, "bad_path", "路径越界或不在工作区范围内");
		const bookDir = getBookDir(slug);
		const info = await statWorkspaceFile(bookDir, rel);
		if (!info) throw new HttpError(404, "not_found", `文件不存在: ${rel}`);
		if (classifyBookFileKind(rel) === "image") {
			const body = await readFile(info.abs);
			ctx.res.writeHead(200, { "content-type": contentTypeFor(info.abs), "content-length": body.length });
			ctx.res.end(body);
			return;
		}
		const content = await readWorkspaceText(bookDir, rel);
		if (!content) throw new HttpError(400, "bad_request", `该文件不能作为文本预览: ${rel}`);
		this.send(ctx.res, 200, { file: content });
	}

	/**
	 * POST /api/books/import:multipart 单文件字段 file(zip)→ 导入新书。
	 * 校验/解包在 readImportZip(中文错误),slug 冲突自动改名 <slug>-import-N
	 * 并改写 book.json 的 slug;条目路径落盘前再校验一次越界。
	 */
	private async handlePostBookImport(ctx: RouteContext): Promise<void> {
		const { buffer } = await this.readMultipartFile(ctx.req, "file");
		let parsed: BookZipImport;
		try {
			parsed = await readImportZip(buffer);
		} catch (err) {
			// readImportZip 的校验错误(损坏/越界/缺 book.json 等)统一 400
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		let finalSlug = parsed.slug;
		if (existsSync(getBookDir(finalSlug))) {
			let n = 1;
			while (existsSync(getBookDir(`${finalSlug}-import-${n}`))) n++;
			finalSlug = `${finalSlug}-import-${n}`;
		}
		// 改写 book.json 的 slug 并补全 BookIndex 缺省字段,再落盘
		const bookJson = parsed.files.get("book.json");
		if (!bookJson) throw new HttpError(400, "bad_request", "zip 缺少 book.json");
		parsed.files.set("book.json", normalizeImportBookJson(bookJson, finalSlug));
		const bookDir = getBookDir(finalSlug);
		mkdirSync(bookDir, { recursive: true });
		for (const [rel, content] of parsed.files) {
			// readImportZip 已保证 posix 相对路径,落盘前再防御性校验一次
			const abs = join(bookDir, ...rel.split("/"));
			if (abs !== bookDir && !abs.startsWith(bookDir + sep)) {
				throw new HttpError(400, "bad_path", `导入条目路径越界: ${rel}`);
			}
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
		}
		const book = await loadBook(finalSlug);
		this.send(ctx.res, 200, { book });
	}

	/** POST /api/books/:slug/chapters {title}:新增章节。 */
	private async handlePostChapter(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const body = await readJsonBody(ctx.req);
		const title = requireString(body, "title", true);
		const chapter = await addChapter(slug, title);
		this.send(ctx.res, 200, { chapter });
	}

	/** PATCH /api/books/:slug/chapters/:id {title?,label?}:更新章节标题/标签。 */
	private async handlePatchChapter(ctx: RouteContext): Promise<void> {
		const slug = ctx.params.slug!;
		const current = await loadBook(slug);
		if (!current) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		// 预检章节存在:updateChapter 内部对未知 id 抛普通 Error(会落 500),
		// 这里先校验,未知 id 统一 400(bad_request)
		if (!current.chapters.some((c) => c.id === ctx.params.id!)) {
			throw new HttpError(400, "bad_request", `章节不存在: ${ctx.params.id}`);
		}
		const body = await readJsonBody(ctx.req);
		const patch: { title?: string; label?: string | null } = {};
		const title = optionalString(body, "title");
		if (title !== undefined) patch.title = title;
		const label = (body as Record<string, unknown> | null)?.["label"];
		if (label !== undefined) {
			if (typeof label !== "string" && label !== null) {
				throw new HttpError(400, "bad_request", "字段 label 必须是字符串或 null");
			}
			patch.label = label;
		}
		const book = await updateChapter(slug, ctx.params.id!, patch);
		this.send(ctx.res, 200, { book });
	}

	// ---- session / chat / messages 路由 ----

	/** GET /api/session/tree:会话分支树概览(分支栏数据:各分支起点/结尾摘要与当前标记)。 */
	private async handleGetSessionTree(ctx: RouteContext): Promise<void> {
		const tree = await this.options.sessionHost.getSessionTree();
		this.send(ctx.res, 200, tree);
	}

	/**
	 * GET /api/session[?slug=&chapterFile=]:缺省=当前会话状态;带参数=只读
	 * 指定章节会话(不改变服务端会话状态——前端"查看"其他章节不中断当前
	 * 流式回复;仅发送/撤回等写操作才真正 switchSession)。
	 */
	private async handleGetSession(ctx: RouteContext): Promise<void> {
		const readSlug = ctx.url.searchParams.get("slug");
		const readFile = ctx.url.searchParams.get("chapterFile");
		if (readSlug && readFile) {
			const book = await loadBook(readSlug);
			if (!book) throw new HttpError(404, "not_found", `书不存在: ${readSlug}`);
			if (!book.chapters.some((c) => c.file === readFile)) {
				throw new HttpError(404, "not_found", `章节不存在: ${readFile}`);
			}
			const absPath = getChapterSessionsPath(readSlug, readFile);
			const base = { bookSlug: readSlug, chapterFile: readFile, isStreaming: false, diagnostics: [] };
			if (!existsSync(absPath)) {
				// 会话文件尚不存在(新章节):空消息
				this.send(ctx.res, 200, { ...base, messages: [] });
				return;
			}
			const sm = readSessionFile(absPath, dirname(absPath), getBookDir(readSlug));
			if (!sm) {
				// 文件存在但解析不出来(截断 / 手工改坏):当空会话处理,不让 500
				this.send(ctx.res, 200, { ...base, messages: [] });
				return;
			}
			this.send(ctx.res, 200, { ...base, messages: extractMessagesFromManager(sm) });
			return;
		}
		this.send(ctx.res, 200, this.options.sessionHost.getState());
	}

	/** POST /api/chat {text}:202 立即返回,发送异步进行,结果走 SSE。 */
	private async handlePostChat(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const text = requireString(body, "text");
		// 背景包补偿(见 ensureChapterContext 注释)。必须 await:nextTurn 消息要先
		// 进 pending 队列,随后的 sendMessage 才会把它一起带进上下文。
		await this.ensureChapterContext();
		void this.options.sessionHost.sendMessage(text).catch((err) => {
			// 发送/生成失败(未配置模型、认证被拒、网络等)必须让前端知道:
			// 广播 chat_error,前端据此显示友好提示与快捷重试,而不是静默无回复
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[server] chat 发送失败: ${message}\n`);
			// text:这条路径多在**写用户消息之前**失败,transcript 里没有可定位的 entry;
			// 报错卡的「重试」只能靠这份原文原样重放(2026-10 审计 BUG-014)
			this.broadcast({ type: "chat_error", message, text });
		});
		this.send(ctx.res, 202, { ok: true });
	}

	/**
	 * POST /api/messages/retract {entryId, replacement?}:撤回最新一条用户消息及其后所有消息
	 * (leaf 指针回退,AI 上下文同步截断;只允许最新消息,回溯用分支);replacement 存在时
	 * 撤回后异步重发(编辑)。广播 messages_retracted:所有窗口(含本窗口)重新对齐消息列表。
	 */
	private async handleRetractMessage(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		const replacement = optionalString(body, "replacement");
		try {
			await this.options.sessionHost.retractMessage(entryId);
		} catch (err) {
			// 未知 entry / 非 user 消息 / 非最新消息 / 流式中:业务性错误,映射 400
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		if (replacement !== undefined && replacement.trim().length > 0) {
			void this.options.sessionHost.sendMessage(replacement).catch((err) => {
				process.stderr.write(`[server] 编辑重发失败: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/messages/branch {entryId}:从某条消息处分支——该消息保留为新分支起点,
	 * 其后的消息离开当前对话(保留在会话文件,不再进上下文/UI)。回溯历史对话的入口。
	 */
	private async handleBranchMessage(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		try {
			await this.options.sessionHost.branchMessage(entryId);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/messages/navigate {entryId}:切换到任意分支上的消息(不限于当前链),
	 * leaf 移到该消息并重建 AI 上下文。分支栏来回切换的入口。
	 */
	private async handleNavigateMessage(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		try {
			await this.options.sessionHost.navigateTo(entryId);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/ask-user/answer {toolCallId, answers}:用户提交提问卡片的答案。
	 *
	 * 这是 ask_user 工具唯一的结算入口 —— 工具此刻正阻塞在 `execute` 里等它。
	 * 提问已结束(被另一窗口答了 / 用户已关闭 / 会话重启)时**不报错**:用户点提交的
	 * 意图已经达成(卡片该消失),返回 ok:false 让前端照常关掉卡片即可,不必区分。
	 */
	private async handlePostAskAnswer(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const toolCallId = requireString(body, "toolCallId");
		const answers = (body as { answers?: unknown }).answers;
		if (!Array.isArray(answers) || answers.some((a) => typeof a !== "string")) {
			throw new HttpError(400, "bad_request", "answers 必须是字符串数组");
		}
		this.send(ctx.res, 200, { ok: askUserGate.answer(toolCallId, answers as string[]) });
	}

	/** POST /api/ask-user/cancel {toolCallId}:用户关闭了提问卡片(工具结算为「未回答」)。 */
	private async handlePostAskCancel(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const toolCallId = requireString(body, "toolCallId");
		this.send(ctx.res, 200, { ok: askUserGate.cancel(toolCallId) });
	}

	/** POST /api/abort:中止当前流式回复。 */
	private async handleAbort(ctx: RouteContext): Promise<void> {
		// 未决提问先结算为「未回答」:不然中断时工具还阻塞着,这轮永远结束不了
		askUserGate.cancelAll();
		await this.options.sessionHost.abort();
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- models / providers 路由 ----

	/** GET /api/models:模型列表 + 当前模型/思考等级(session.state 由 vendor 提供)。 */
	private async handleGetModels(ctx: RouteContext): Promise<void> {
		const runtime = this.options.sessionHost.getRuntime();
		const models = await runtime.session.modelRuntime.getAvailable();
		const state = runtime.session.state;
		// vendor 未选模型时 state.model 是 {provider:"unknown", id:"unknown"} 占位——
		// usableModelRef 归一为 null,前端据此显示「未设置」而非裸 "unknown"(2026-08 UI 评审)
		const m = usableModelRef(state.model);
		// 仅当当前模型仍出现在可用列表中才返回;key 移除/失效后前端应显示「未设置」,
		// 而不是把已不可用的旧模型继续当作当前模型(2026-08 设置页认证状态反馈)
		const current = m && models.some((model) => model.provider === m.provider && model.id === m.id) ? m : null;
		this.send(ctx.res, 200, {
			models,
			current,
			thinking: state.thinkingLevel,
			temperature: state.temperature,
			topP: state.topP,
			// 2026-10 审计 BUG-017:历史 models.json 里的重复模型条目只**报告**不静默删除
			// (vendor 合成目录按首项替换,第二条是隐藏/歧义配置)。前端可选择提示。
			configWarnings: await modelsConfigWarnings(),
			// 2026-10 审计 BUG-012:当前模型**实际支持**的思考档位(null = 拿不到,前端展示全量)
			thinkingLevels: this.options.sessionHost.thinkingLevels?.() ?? null,
		});
	}

	/**
	 * POST /api/models/refresh:联网刷新模型目录(远程 catalog / 动态 provider),返回最新模型列表。
	 *
	 * 2026-10 审计 BUG-005:不能只刷主会话。每个会话宿主在装配时各建一份 ModelRuntime,
	 * 只刷主会话时设置页/主会话看得见新模型,而已建的编剧、舞台会话仍解析不到它。
	 * 现在三处宿主都刷,并按宿主回报结果(部分失败不再伪装成全成功)。
	 */
	private async handlePostModelsRefresh(ctx: RouteContext): Promise<void> {
		const runtime = this.options.sessionHost.getRuntime();
		const result = await runtime.session.modelRuntime.refresh({ allowNetwork: true, force: true });
		const models = await runtime.session.modelRuntime.getAvailable();
		const state = runtime.session.state;
		const m = usableModelRef(state.model);
		const current = m && models.some((model) => model.provider === m.provider && model.id === m.id) ? m : null;
		// 编剧 / 舞台宿主也联网重拉一次(主会话上面已经拉过,这里只补另外两处)
		const hosts = await this.refreshModelCatalog({ allowNetwork: true, skipMain: true });
		this.send(ctx.res, 200, {
			models,
			current,
			thinking: state.thinkingLevel,
			temperature: state.temperature,
			topP: state.topP,
			// 2026-09-23:改成结构化 —— 前端「测试连接」要按 provider 过滤,
			// 之前只有一句拼好的字符串(`DeepSeek models request failed: 401 …`),
			// 只能靠包含匹配 provider 名,脆且容易错判。map 的 key 是 provider id
			// (pi-ai 的 ModelsRefreshResult.errors: ReadonlyMap<string, Error>)。
			errors: [...(result?.errors ?? new Map<string, Error>()).entries()].map(([provider, e]) => ({ provider, message: e.message })),
			// 宿主级结果:谁的目录刷上了、谁报错(设置页可据此区分「主会话成功」与「全会话成功」)
			hosts,
			// 当前模型实际支持的思考档位(BUG-012:前端只展示/启用这些档位)
			thinkingLevels: this.options.sessionHost.thinkingLevels?.() ?? null,
		});
	}

	/**
	 * 模型目录刷新协调器(2026-10 审计 BUG-005):主会话 + 常驻编剧 + 舞台三处宿主逐个刷新。
	 *
	 * 返回每个宿主的结果与错误,不把部分成功说成全成功。某个宿主失败/未装配不阻塞其余
	 * (它下次新建会话时本来就会读最新目录)。
	 */
	private async refreshModelCatalog(options: { allowNetwork: boolean; skipMain?: boolean }): Promise<
		Array<{ host: string; ok: boolean; sessions?: number; errors?: Array<{ provider: string; message: string }>; error?: string }>
	> {
		const out: Array<{ host: string; ok: boolean; sessions?: number; errors?: Array<{ provider: string; message: string }>; error?: string }> = [];
		const jobs: Array<[string, () => Promise<{ errors: Array<{ provider: string; message: string }>; sessions?: number }>]> = [];
		if (!options.skipMain) {
			jobs.push([
				"主会话",
				async () => {
					const summary = await this.options.sessionHost.refreshModels({ allowNetwork: options.allowNetwork });
					return { errors: summary?.errors ?? [], sessions: 1 };
				},
			]);
		}
		if (this.options.writerHost) jobs.push(["编剧会话", () => this.options.writerHost!.refreshModels({ allowNetwork: options.allowNetwork })]);
		if (this.options.stageHost) jobs.push(["舞台会话", () => this.options.stageHost!.refreshModels({ allowNetwork: options.allowNetwork })]);
		for (const [host, run] of jobs) {
			try {
				const summary = await run();
				const errors = summary?.errors ?? [];
				out.push({ host, ok: true, ...(summary?.sessions !== undefined ? { sessions: summary.sessions } : {}), ...(errors.length > 0 ? { errors } : {}) });
			} catch (err) {
				out.push({ host, ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		}
		return out;
	}

	/**
	 * models.json 的**唯一读-改-写入口**(2026-10 审计 BUG-010 / BUG-011)。
	 *
	 * 锁内重新读取最新文件 → 纯函数变更(mutate)→ 原子写 → 热重载模型目录。
	 * 三件事都在同一队列任务里,因此:
	 * - 并发请求各自看到前一个请求写下的结果,不会用旧快照互相覆盖(BUG-011);
	 * - 损坏/不可读的配置在写入前就抛错,**不会**被空快照覆盖(BUG-010);
	 * - reloadModels 读到的必然是刚写下的那份文件。
	 *
	 * `action` 只用于错误文案;mutate 抛出的 HttpError(如 400/404)原样上抛,不写盘。
	 * mutate 返回 `false` 表示**本次没有实际变更**,跳过写盘与热重载(幂等删除:条目本来
	 * 就不在 models.json 里时不该白白重排一次文件)。
	 */
	private async updateModelsConfig<T>(action: string, mutate: (cfg: ModelsConfig) => T | Promise<T>): Promise<T> {
		try {
			return await this.modelsQueue.run(modelsConfigPath(), async () => {
				const cfg = await readModelsConfigForWrite();
				const value = await mutate(cfg);
				if ((value as unknown) === false) return value;
				await writeModelsConfig(cfg);
				await this.reloadModels();
				return value;
			});
		} catch (err) {
			if (err instanceof HttpError) throw err;
			modelsConfigHttpError(err);
		}
	}

	/**
	 * POST /api/providers/custom {provider, name?, baseUrl, apiKey?}:
	 * 新建 / 修改一个**自定义供应商**(models.json 的 provider 条目)。
	 *
	 * 2026-09 拆开「加供应商」与「加模型」:此前只有「自定义供应商」表单,它要求同时
	 * 定义第一个模型,于是「加一个供应商」实际变成了「加一个模型」,而用户想先建好
	 * 供应商、再在它的详情里逐个加模型时没有路径。这里只写 provider 级字段
	 * (api/baseUrl/apiKey/name),models 留给 POST /api/models/custom。
	 */
	private async handlePostProviderCustom(ctx: RouteContext): Promise<void> {
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown>;
		const providerId = requireString(body, "provider");
		const baseUrl = requireString(body, "baseUrl");
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId)) {
			throw new HttpError(400, "bad_request", "供应商 id 只允许小写字母/数字/连字符(如 mock)");
		}
		if (!/^https?:\/\//.test(baseUrl)) {
			throw new HttpError(400, "bad_request", "baseUrl 必须是 http(s) 地址(如 http://127.0.0.1:8787/v1)");
		}
		await this.updateModelsConfig("添加供应商", async (cfg) => {
			// 内置供应商的 id 归内置清单所有:在它下面写 models.json 整条会改掉它的地址与协议,
			// 而「添加供应商」的本意是加一个新的。已在 models.json 里的 id 则允许改写(就是编辑)。
			if (!hasCustomProvider(cfg, providerId)) {
				const known = await this.options.sessionHost.listProviders();
				if (known.some((p) => p.id === providerId)) {
					throw new HttpError(400, "bad_request", `供应商 id「${providerId}」已被内置供应商占用,请换一个 id,或直接在列表里选它`);
				}
			}
			upsertCustomProvider(cfg, providerId, {
				baseUrl,
				name: optionalString(body, "name"),
				apiKey: optionalString(body, "apiKey"),
			});
		});
		this.send(ctx.res, 200, { ok: true, provider: providerId });
	}

	/**
	 * POST /api/models/custom {provider, model, baseUrl, apiKey?, contextWindow?, maxTokens?}:
	 * 把自定义 provider(openai-completions 协议,如本地 mock LLM)写进 models.json 并热重载。
	 * models.json 是启动时一次性加载——写盘后重建运行时(切书同款机制)新 provider 才可见。
	 */
	private async handlePostModelCustom(ctx: RouteContext): Promise<void> {
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown>;
		const providerId = requireString(body, "provider");
		const modelId = requireString(body, "model");
		const baseUrl = requireString(body, "baseUrl");
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId)) {
			throw new HttpError(400, "bad_request", "provider id 只允许小写字母/数字/连字符(如 mock)");
		}
		if (!CUSTOM_MODEL_ID_RE.test(modelId)) {
			throw new HttpError(400, "bad_request", "模型 id 只允许字母/数字/连字符/点/下划线(如 mock-1)");
		}
		if (!/^https?:\/\//.test(baseUrl)) {
			throw new HttpError(400, "bad_request", "baseUrl 必须是 http(s) 地址(如 http://127.0.0.1:8787/v1)");
		}
		// 正整数校验与 PUT 共用(2026-10 审计 BUG-018):此前后端各写一套,POST 直接
		// `Number(...)` 收下 0/负数/小数/非数字字符串,NaN 经 JSON.stringify 落盘成 null,
		// vendor schema 拒绝后模型从目录里消失。缺省值只在**未提供**时兜底。
		const contextWindow = optionalPositiveInt(body, "contextWindow") ?? 32000;
		const maxTokens = optionalPositiveInt(body, "maxTokens") ?? 4096;
		await this.updateModelsConfig("添加模型", async (cfg) => {
			// 同 provider 同 id 重复必须拒绝(2026-10 审计 BUG-017):此前后直接追加,
			// vendor 合成目录时同 provider 同 id 按首项替换,第二条成为隐藏/歧义配置,
			// 后续编辑删除也只命中首条 —— 界面与磁盘内容对不上。
			if (hasModel(cfg, providerId, modelId)) {
				throw new HttpError(400, "bad_request", `模型 id ${providerId}/${modelId} 已存在,如需修改请用编辑`);
			}
			// input 只接受 text/image(vendor models.json schema 合法值,无视频/PDF 语义)
			const rawInput = Array.isArray(body.input) ? body.input : [];
			const input = rawInput.filter((v): v is "text" | "image" => v === "text" || v === "image");
			const modelEntry: CustomModelEntry = {
				id: modelId,
				name: typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : modelId,
				// 是否支持思考深度:vendor 按 model.reasoning 决定可用的思考档位
				// (getSupportedThinkingLevels:非推理模型只有 off)。缺省 false —— 不声明就等于
				// 不认 reasoning 参数,web 上「思考等级」对这一条会被静默回落(2026-10-04)。
				reasoning: body.reasoning === true,
				contextWindow,
				maxTokens,
				...(input.length > 0 ? { input } : {}),
			};
			// 思考参数协议(BUG-002):只按 provider 名推断格式会误判第三方兼容服务
			// (同样的 reasoning_effort,有的忽略、有的报错、有的要专有字段)。
			const fmt = readThinkingFormat(body);
			if (fmt !== undefined) setThinkingFormat(modelEntry, fmt);
			// 同 provider 已有自定义条目(models.json 里)时合并 models 数组——否则
			// 第二次添加会整体覆盖 provider,丢掉之前添加的模型(保留原 apiKey/baseUrl)
			const existing = cfg.providers?.[providerId];
			const existingModels: CustomModelEntry[] = (existing as { models?: CustomModelEntry[] } | undefined)?.models ?? [];
			const provider = {
				...(typeof existing === "object" && existing !== null ? (existing as Record<string, unknown>) : {}),
				// api 只在**新建** models.json 条目时写死 openai-completions(自定义供应商走这条)。
				// 已有条目(含内置供应商)不能覆盖:内置的 Anthropic / Google 等协议不同,强行写成
				// openai-completions 会让新加的模型用错协议(2026-09)。
				...(existing === undefined ? { api: "openai-completions" } : {}),
				baseUrl,
				// vendor 把无 apiKey 的 provider 视为未配置并跳过列表——本地 mock 等
				// 无需鉴权的服务也须有占位 key(实测 provider-composer 跳过无 key provider);
				// 已有条目时保留原有 apiKey,避免 body 未传时覆盖成占位值
				apiKey:
					typeof body.apiKey === "string" && body.apiKey.length > 0
						? body.apiKey
						: (existing as { apiKey?: string } | undefined)?.apiKey ?? "sk-custom",
				models: [...existingModels, modelEntry],
			};
			cfg.providers = { ...(cfg.providers ?? {}), [providerId]: provider };
		});
		this.send(ctx.res, 200, { ok: true, provider: providerId, model: `${providerId}/${modelId}` });
	}

	/**
	 * PUT /api/models/custom {provider, model, newModel?, name?, contextWindow?, maxTokens?, input?}:
	 * 编辑 models.json 里已有的自定义模型(按原 id 定位;newModel 非空且不同时改 id)。
	 * 只动模型条目,不改 provider 级的 api/baseUrl/apiKey。
	 */
	private async handlePutModelCustom(ctx: RouteContext): Promise<void> {
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown>;
		const providerId = requireString(body, "provider");
		const modelId = requireString(body, "model");
		const newModel = optionalString(body, "newModel");
		if (newModel !== undefined && !CUSTOM_MODEL_ID_RE.test(newModel)) {
			throw new HttpError(400, "bad_request", "模型 id 只允许字母/数字/连字符/点/下划线(如 mock-1)");
		}
		await this.updateModelsConfig("编辑模型", (cfg) => {
			if (!hasModel(cfg, providerId, modelId)) {
				throw new HttpError(404, "not_found", `models.json 里没有模型 ${providerId}/${modelId}`);
			}
			if (newModel !== undefined && newModel !== modelId && hasModel(cfg, providerId, newModel)) {
				throw new HttpError(400, "bad_request", `模型 id ${newModel} 已存在`);
			}
			const patch: CustomModelPatch = {};
			const name = optionalString(body, "name");
			if (name !== undefined) patch.name = name;
			const contextWindow = optionalPositiveInt(body, "contextWindow");
			if (contextWindow !== undefined) patch.contextWindow = contextWindow;
			const maxTokens = optionalPositiveInt(body, "maxTokens");
			if (maxTokens !== undefined) patch.maxTokens = maxTokens;
			const input = normalizeModelInput(body);
			if (input !== undefined) patch.input = input;
			const reasoning = optionalBoolean(body, "reasoning");
			if (reasoning !== undefined) patch.reasoning = reasoning;
			// 思考参数协议:null / 空串 = 清除显式声明(BUG-002)
			const thinkingFormat = readThinkingFormat(body);
			if (thinkingFormat !== undefined) patch.thinkingFormat = thinkingFormat;
			if (newModel !== undefined) patch.newId = newModel;
			updateCustomModel(cfg, providerId, modelId, patch);
		});
		this.send(ctx.res, 200, { ok: true, provider: providerId, model: newModel ?? modelId });
	}

	/** DELETE /api/models/custom?provider=&model=:删除 models.json 里的自定义模型。 */
	private async handleDeleteModelCustom(ctx: RouteContext): Promise<void> {
		const providerId = ctx.url.searchParams.get("provider") ?? "";
		const modelId = ctx.url.searchParams.get("model") ?? "";
		if (providerId.length === 0 || modelId.length === 0) {
			throw new HttpError(400, "bad_request", "缺少 provider 或 model 查询参数");
		}
		await this.updateModelsConfig("删除模型", (cfg) => {
			if (!deleteCustomModel(cfg, providerId, modelId)) {
				throw new HttpError(404, "not_found", `models.json 里没有模型 ${providerId}/${modelId}`);
			}
		});
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * 热重载模型目录:ModelRuntime.refresh 重读 models.json 并重建 provider
	 * (本地配置,不触发网络目录刷新;比 reloadRuntime 轻量,不重建整个会话运行时)。
	 *
	 * 2026-10-04:必须**三个宿主都刷**。每个会话宿主在装配时各建一份 ModelRuntime
	 * (models.json 是那一刻读的),只刷主会话时,设置页刚加完的自定义模型在已建编剧/
	 * 舞台会话上解析不到 —— 症状是「加完供应商与模型、选中、开聊」仍然报
	 * `No API key found for the selected model`(对话继续用 unknown 占位模型发请求),
	 * 而设置页显示的当前模型是主会话的、看着已经切好了。
	 */
	private async reloadModels(): Promise<void> {
		// 统一走宿主级协调器(主会话 + 编剧 + 舞台),本地重读,不发网络请求。
		// 剧宿主结果只记诊断:某个宿主临时不可用不该让用户那次写盘操作失败。
		const results = await this.refreshModelCatalog({ allowNetwork: false });
		for (const r of results) {
			if (!r.ok) process.stderr.write(`[server] 模型目录刷新失败(${r.host}): ${r.error}\n`);
		}
	}

	/**
	 * 会话级设置广播:主会话 + 编剧 + 舞台三处宿主全部转发。
	 *
	 * 2026-10-01 修「同一个对话窗口里换模型不生效」:模型与思考等级此前只打
	 * `sessionHost`(主会话),而**聊天根本不走它** —— 编辑页走编剧会话
	 * (`/api/writer/:slug/chat`)、舞台页走编排器会话,两边的模型都在会话创建时
	 * 就绑死了(vendor sdk.ts 的 `defaultModelId: settingsManager.getDefaultModel()`,
	 * 只有 `session.setModel()` 能改)。于是换模型要等换章或重启才生效,而设置页
	 * 读的「当前模型」来自主会话 —— 看起来还切成功了。
	 *
	 * 逐个宿主尝试后再报错:某个宿主临时不可用(旧 runtime 已释放等)不该让其余的
	 * 也跟着不动。
	 */
	private async applyToAllSessions(
		action: string,
		entries: Array<[label: string, run: () => Promise<void> | void]>,
	): Promise<void> {
		const failed: string[] = [];
		for (const [label, run] of entries) {
			try {
				await run();
			} catch (err) {
				failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (failed.length > 0) {
			throw new HttpError(400, "bad_request", `${action}未在所有会话生效（${failed.join("; ")}）`);
		}
	}

	/** POST /api/model {model}:切换模型(主会话 + 编剧 + 舞台都换,见 applyToAllSessions)。 */
	private async handlePostModel(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const model = requireString(body, "model");
		await this.applyToAllSessions("切换模型", [
			["主会话", () => this.options.sessionHost.setModel(model)],
			["编剧会话", () => this.options.writerHost?.setModel(model)],
			["舞台会话", () => this.options.stageHost?.setModel(model)],
		]);
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/thinking {level}:切换思考等级,并**分宿主**回报实际生效的档位。
	 *
	 * 两件事必须说清楚,否则用户看到的就是「思考等级菜单点了没反应」:
	 * 1. vendor 的 setThinkingLevel 按模型能力 clamp(getSupportedThinkingLevels 对
	 *    `reasoning:false` 的模型只给 off)—— 只回 {ok:true} 会把「被回落到 off」显示成
	 *    「已切换成 high」(2026-10-04);
	 * 2. 2026-10 审计 BUG-013:此前响应只回**主会话**的档位,而编剧/舞台会话的模型能力
	 *    可能不同,各自 clamp 到别的档位 —— 前端据此提示「已切换」等于骗人。现在逐个宿主
	 *    回报实际档位、是否被回落、谁失败了;舞台演员的档位**故意**不跟随(角色设计),
	 *    以 `actorsOmitted` 明示。
	 */
	private async handlePostThinking(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const level = requireString(body, "level");
		const hosts: Array<Record<string, unknown>> = [];
		const failures: string[] = [];
		// 主会话的实际档位:前端的 `thinking` 字段沿用这一条(向后兼容)
		let mainLevel: string | null = null;
		let mainClamped = false;
		const record = async (
			host: string,
			run: () => ThinkingSummary | Promise<ThinkingSummary> | void | Promise<void>,
		) => {
			try {
				// 防御式:最小 fake 宿主可能什么都不返回(真宿主恒返回摘要)
				const s = ((await run()) ?? { levels: [], clamped: false, failed: [] }) as ThinkingSummary;
				const failed = s.failed ?? [];
				hosts.push({
					host,
					ok: failed.length === 0,
					...(s.sessions !== undefined ? { sessions: s.sessions } : {}),
					levels: s.levels ?? [],
					clamped: s.clamped === true,
					...(s.actorsOmitted !== undefined ? { actorsOmitted: s.actorsOmitted } : {}),
					...(failed.length > 0 ? { failed } : {}),
				});
				for (const f of failed) failures.push(`${host}: ${f}`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				hosts.push({ host, ok: false, levels: [], clamped: false, error: message });
				failures.push(`${host}: ${message}`);
			}
		};
		await record("主会话", async () => {
			// 防御式读取:最小 fake 宿主可能返回 void(真 SessionHost 恒返回结果对象)
			const r = (await this.options.sessionHost.setThinkingLevel(level)) as { level?: string | null; clamped?: boolean } | undefined;
			const actual = typeof r?.level === "string" ? r.level : null;
			mainLevel = actual;
			mainClamped = r?.clamped === true;
			return { sessions: 1, levels: actual ? [actual] : [], clamped: mainClamped, failed: [] };
		});		if (this.options.writerHost) await record("编剧会话", () => this.options.writerHost!.setThinkingLevel(level));
		if (this.options.stageHost) await record("舞台会话", () => this.options.stageHost!.setThinkingLevel(level));
		this.send(ctx.res, 200, {
			ok: failures.length === 0,
			thinking: mainLevel,
			clamped: mainClamped,
			hosts,
			...(failures.length > 0 ? { failures } : {}),
		});
	}

	/**
	 * POST /api/sampling {temperature?, topP?}:切换采样参数;null 表示恢复模型默认。
	 *
	 * 2026-10 审计 BUG-007:此前按主会话 → 编剧 → 舞台顺序直接调用,任一前置宿主抛错会
	 * 中断后面所有宿主(已经改了的保持新值、没轮到的保持旧值,响应还只说"失败")。
	 * 现在走 applyToAllSessions 的逐宿主容错:全部尝试,失败项统一报出。
	 */
	private async handlePostSampling(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const temperature = optionalNumberOrNull(body, "temperature");
		const topP = optionalNumberOrNull(body, "topP");
		if (temperature === undefined && topP === undefined) {
			throw new HttpError(400, "bad_request", "至少提供 temperature、topP 或 null 之一");
		}
		if (temperature !== null && temperature !== undefined && (temperature < 0 || temperature > 2)) {
			throw new HttpError(400, "bad_request", "temperature 必须在 0..2 之间");
		}
		if (topP !== null && topP !== undefined && (topP < 0 || topP > 1)) {
			throw new HttpError(400, "bad_request", "topP 必须在 0..1 之间");
		}
		await this.applyToAllSessions("切换采样参数", [
			["主会话", () => this.options.sessionHost.setSamplingParameters(temperature, topP)],
			["编剧会话", () => this.options.writerHost?.setSamplingParameters(temperature, topP)],
			["舞台会话", () => this.options.stageHost?.setSamplingParameters(temperature, topP)],
		]);
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * GET /api/providers:全部 provider + 认证状态(已配置置顶,排序在 SessionHost)。
	 *
	 * 2026-09:models.json 里刚建好、**还没有加模型**的自定义供应商不会出现在
	 * `listProviders()` 里 —— 那个清单是从模型目录反推 provider 的
	 * (`new Set(mr.getModels().map(m => m.provider))`),零模型的供应商没有痕迹。
	 * 「先建供应商、再在它下面加模型」这条路会断在第一步(建完就找不到它),
	 * 所以这里把 models.json 的条目补进来。
	 */
	private async handleGetProviders(ctx: RouteContext): Promise<void> {
		const providers = await this.listProvidersWithCustom();
		this.send(ctx.res, 200, { providers });
	}

	/** 供应商清单:运行时目录 + models.json 里零模型的自定义供应商(合并后按已配置优先排序)。 */
	private async listProvidersWithCustom(): Promise<ProviderListItem[]> {
		const providers = await this.options.sessionHost.listProviders();
		const known = new Set(providers.map((p) => p.id));
		const cfg = await readModelsConfig();
		for (const [id, entry] of Object.entries(cfg.providers ?? {})) {
			if (known.has(id)) continue;
			providers.push({
				id,
				name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
				configured: true,
				authKind: "api_key",
				source: "models_json_key",
			});
		}
		return sortProviders(providers);
	}

	/** GET /api/providers/:id:供应商详情(含全量模型列表,不按认证过滤)。 */
	private async handleGetProviderDetail(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const detail = await this.options.sessionHost.getProviderDetail(id);
		if (!detail) throw new HttpError(404, "not_found", `provider 不存在: ${id}`);
		// 标出 models.json 里自定义的模型:前端只对这些给编辑/删除入口
		const customIds = customModelIds(await readModelsConfig(), id);
		if (customIds.size > 0) {
			detail.models = detail.models.map((m) => (customIds.has(m.id) ? { ...m, custom: true } : m));
		}
		this.send(ctx.res, 200, detail);
	}

	/** POST /api/providers/:id/apikey {key}:写入 API key(官方 login 路径)。 */
	private async handlePostProviderApiKey(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const providers = await this.listProvidersWithCustom();
		const provider = providers.find((p) => p.id === id);
		if (!provider) throw new HttpError(404, "not_found", `provider 不存在: ${id}`);
		if (provider.authKind !== "api_key" && provider.authKind !== "both") {
			throw new HttpError(400, "bad_request", `provider ${id} 不支持 API key 登录`);
		}
		const body = await readJsonBody(ctx.req);
		const key = requireString(body, "key");
		try {
			await this.options.sessionHost.setProviderApiKey(id, key);
		} catch (err) {
			// 多提示/非 secret 提示:web 交互无法完成,映射为 400
			if (err instanceof ProviderAuthError) throw new HttpError(400, "bad_request", err.message);
			throw err;
		}
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * DELETE /api/providers/:id:移除凭据。
	 *
	 * 凭据可能在两处:凭据库(auth.json,走 vendor logout)或 models.json 的
	 * apiKey(自定义供应商)。只 logout 后者不动,前端重载后仍是「已配置」——
	 * 点了移除凭据等于没反应(2026-09 修)。所以 models_json_* 来源的整条删掉。
	 */
	private async handleDeleteProvider(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const providers = await this.listProvidersWithCustom();
		const provider = providers.find((p) => p.id === id);
		if (!provider) {
			throw new HttpError(404, "not_found", `provider 不存在: ${id}`);
		}
		await this.options.sessionHost.removeProvider(id);
		if (provider.source === "models_json_key" || provider.source === "models_json_command") {
			// 走统一读-改-写队列(BUG-011):删除凭据与并发的模型新增不能互相覆盖。
			// 条目本来就不在 models.json 里时返 false,不白写一次文件。
			await this.updateModelsConfig("移除凭据", (cfg) => deleteCustomProvider(cfg, id));
		}
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- world / draft / cards 路由 ----

	/**
	 * GET /api/world:slug 取当前会话 bookSlug,无会话 404;返回 world.json 全文,
	 * 前端自行构建树(视图文件可能落后于 world.json,以 world.json 为准)。
	 * mtime 一并返回:前端保存时作为 If-Match 条件写,防旧文本覆盖新修改。
	 */
	private async handleGetWorld(ctx: RouteContext): Promise<void> {
		// 显式 slug 优先:前端世界书页/设置页/备忘录显示的书可能与会话书不同
		// (如舞台页只做数据层开书,不切换主会话)。缺省才回退当前会话书。
		const slug = ctx.url.searchParams.get("slug") ?? this.options.sessionHost.getState().bookSlug;
		if (!slug) throw new HttpError(404, "not_found", "当前没有打开的书");
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const world = await ensureWorld(slug);
		const st = safeStat(join(getBookDir(slug), "world.json"));
		this.send(ctx.res, 200, { world, mtime: st?.mtimeMs ?? 0 });
	}

	/**
	 * PUT /api/world {world}:保存世界书(saveWorld 内部校验,WorldValidationError → 400)。
	 * If-Match 条件写:磁盘 mtime 已变(其他窗口/AI 已改)时 409,前端提示后重载。
	 */
	private async handlePutWorld(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const bodyObj = body as Record<string, unknown> | null;
		// 显式 slug 优先(与 GET 同语义);缺省回退当前会话书。
		const slug =
			(typeof bodyObj?.slug === "string" && bodyObj.slug.trim().length > 0 ? bodyObj.slug.trim() : undefined) ??
			this.options.sessionHost.getState().bookSlug;
		if (!slug) throw new HttpError(404, "not_found", "当前没有打开的书");
		if (!(await loadBook(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
		const raw = bodyObj?.["world"];
		if (!raw) throw new HttpError(400, "bad_request", "缺少 world 字段");
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new HttpError(400, "bad_request", "world 字段必须是对象");
		}
		this.checkIfMatch(ctx.req, join(getBookDir(slug), "world.json"));
		// saveWorld 内部会完整校验并抛 WorldValidationError(路由兜底映射 400)
		await saveWorld(slug, raw as WorldData);
		const worldFile = join(getBookDir(slug), "world.json");
		const mtime = safeStat(worldFile)?.mtimeMs ?? Date.now();
		await this.watcher.noteWritten(worldFile);
		// 广播世界书变更:另一浏览器按此重载(干净时)或提示冲突(脏时)
		this.broadcast({ type: "world_changed", slug, mtime });
		this.send(ctx.res, 200, { ok: true, mtime });
	}

	/**
	 * GET /api/confirm-cards?slug=&chapterFile=:编剧确认卡持久化(按书+章节隔离,
	 * 刷新/切章不丢——待确认编辑的 before 基线随卡保存,回退能力跨会话保留);
	 * 文件缺失/损坏 → 空列表。
	 */
	private async handleGetConfirmCards(ctx: RouteContext): Promise<void> {
		const slug = ctx.url.searchParams.get("slug") ?? "";
		const chapterFile = ctx.url.searchParams.get("chapterFile") ?? "";
		if (!slug || !chapterFile) throw new HttpError(400, "bad_request", "缺少 slug/chapterFile 查询参数");
		const abs = await this.resolveChapterSideFile(slug, chapterFile, ".confirm.json");
		let cards: unknown = [];
		try {
			cards = JSON.parse((await readFile(abs, "utf-8")) as string) as unknown;
		} catch (err) {
			// 文件不存在 → 空列表;其他错误(权限/损坏 JSON)保持报错
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (!Array.isArray(cards)) cards = [];
		this.send(ctx.res, 200, { cards });
	}

	/** PUT /api/confirm-cards {slug, chapterFile, cards}:整体写(空数组 = 删除文件)。 */
	private async handlePutConfirmCards(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const slug = requireString(body, "slug");
		const chapterFile = requireString(body, "chapterFile");
		const cards = (body as { cards?: unknown }).cards;
		if (!Array.isArray(cards)) throw new HttpError(400, "bad_request", "cards 必须是数组");
		const abs = await this.resolveChapterSideFile(slug, chapterFile, ".confirm.json");
		if (cards.length === 0) {
			try {
				unlinkSync(abs); // 空列表:删除文件(不存在静默)
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		} else {
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, JSON.stringify(cards), "utf-8");
		}
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * GET /api/draft?file=...&slug=...(slug 可选:缺省按会话书);响应带 mtime(条件写依据)。
	 * 文件不存在 → 空草稿(草稿惰性创建:首次保存落盘,新建章节不预建文件)。
	 */
	private async handleGetDraft(ctx: RouteContext): Promise<void> {
		const file = ctx.url.searchParams.get("file");
		if (!file || file.trim().length === 0) throw new HttpError(400, "bad_request", "缺少 file 查询参数");
		const { abs } = this.resolveDraftFile(file, ctx.url.searchParams.get("slug") ?? undefined);
		let text = "";
		let mtime = 0;
		try {
			text = await readFile(abs, "utf-8");
			mtime = safeStat(abs)?.mtimeMs ?? 0;
		} catch (err) {
			// 文件不存在 → 空草稿;其他错误(权限等)保持报错
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		this.send(ctx.res, 200, { text, mtime });
	}

	/** PUT /api/draft {file,text,slug?};If-Match 条件写(409 防覆盖),响应带 mtime。 */
	private async handlePutDraft(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const file = requireString(body, "file");
		const text = requireString(body, "text");
		const bodyObj = body as { slug?: unknown };
		const slug = typeof bodyObj.slug === "string" && bodyObj.slug.length > 0 ? bodyObj.slug : undefined;
		const { abs, slug: bookSlug } = this.resolveDraftFile(file, slug);
		this.checkIfMatch(ctx.req, abs);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, text, "utf-8");
		const mtime = safeStat(abs)?.mtimeMs ?? Date.now();
		// 登记 watcher:自己的写入不触发外部变更广播(PUT 广播已有)
		await this.watcher.noteWritten(abs);
		// 广播草稿变更:另一浏览器按此重载(干净时)或提示冲突(脏时),避免互相覆盖不自知
		this.broadcast({ type: "draft_changed", slug: bookSlug, file, mtime });
		this.send(ctx.res, 200, { ok: true, mtime });
	}

	// ---- mcp 路由 ----

	/** GET /api/mcp:服务器配置 + 连接状态(设置页渲染列表;未装配时 404)。 */
	private async handleGetMcp(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		const servers = await mgr.listConfig();
		this.send(ctx.res, 200, { servers: servers.servers, status: mgr.getStatus() });
	}

	/** POST /api/mcp {server}:新增服务器 → 重连 + 重建会话(新工具生效)。 */
	private async handlePostMcp(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		const body = await readJsonBody(ctx.req);
		const server = this.readMcpServerBody(body);
		// 重名判定在 manager 的写队列内做(BUG-020):此前先 listConfig 再 upsert,
		// 两个并发同名新增都能通过检查
		try {
			await mgr.upsertServer(server, "create");
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		await this.handleMcpReload();
		this.send(ctx.res, 200, { servers: (await mgr.listConfig()).servers, status: mgr.getStatus() });
	}

	/** GET /api/mcp/raw:mcp.json 原始文本(「直接编辑文件」预填;不存在返回空配置)。 */
	private async handleGetMcpRaw(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		let text = "";
		try {
			text = await readFile(getMcpConfigPath(mgr.getAgentDir()), "utf-8");
		} catch {
			text = "";
		}
		this.send(ctx.res, 200, { text });
	}

	/** PUT /api/mcp/raw {text}:原样保存 mcp.json(校验后落盘 + 重连 + 重建会话)。 */
	private async handlePutMcpRaw(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		const body = await readJsonBody(ctx.req);
		const text = requireString(body, "text");
		try {
			// 与结构化编辑共用 manager 的写队列(BUG-020):并发 raw 保存不会互相覆盖
			await mgr.saveRawConfig(text);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		await this.handleMcpReload();
		this.send(ctx.res, 200, { servers: (await mgr.listConfig()).servers, status: mgr.getStatus() });
	}

	/** PUT /api/mcp/:name {server}:更新服务器(重连 + 重建会话)。 */
	private async handlePutMcpServer(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		const name = ctx.params.name!;
		const body = await readJsonBody(ctx.req);
		const server = this.readMcpServerBody(body);
		if (server.name !== name) throw new HttpError(400, "bad_request", "名称不可在编辑时修改(请先删除再新增)");
		try {
			await mgr.upsertServer(server, "update");
		} catch (err) {
			throw new HttpError(404, "not_found", err instanceof Error ? err.message : String(err));
		}
		await this.handleMcpReload();
		this.send(ctx.res, 200, { servers: (await mgr.listConfig()).servers, status: mgr.getStatus() });
	}

	/** DELETE /api/mcp/:name:删除服务器(重连 + 重建会话)。 */
	private async handleDeleteMcpServer(ctx: RouteContext): Promise<void> {
		const mgr = this.options.mcpManager;
		if (!mgr) throw new HttpError(404, "not_found", "MCP 未启用");
		try {
			await mgr.removeServer(ctx.params.name!);
		} catch (err) {
			throw new HttpError(404, "not_found", err instanceof Error ? err.message : "服务器不存在");
		}
		await this.handleMcpReload();
		this.send(ctx.res, 200, { servers: (await mgr.listConfig()).servers, status: mgr.getStatus() });
	}

	// ---- plugins 路由 ----

	/** 注入插件装载态(web.ts 启动时 loadPlugins 后调用;GET /api/plugins 合并展示)。 */
	setPluginInfos(
		infos: PluginRuntimeInfo[],
		webCommands?: Map<string, Record<string, PluginWebCommandHandler>>,
		routes?: PluginRouteDef[],
	): void {
		this.pluginInfos = infos;
		if (webCommands) this.pluginWebCommands = webCommands;
		if (routes) this.pluginRoutes = routes;
	}

	/** GET /api/plugins:插件列表(id 排序;含启用状态、装载错误与 frontend 声明)。 */
	private async handleGetPlugins(ctx: RouteContext): Promise<void> {
		const infos = await listPlugins();
		// 装载错误只在 loadPlugins 时产生(动态 import 侧);列表端点重新扫描
		// 会覆盖为 null——把装载态合并回来,展现「插件装载后状态」而非仅磁盘状态
		const loaded = this.pluginInfos ?? [];
		const merged = infos.map((info) => {
			const runInfo = loaded.find((l) => l.id === info.id);
			return {
				...info,
				// 装载结果(验证过的 frontend 声明/错误)优先于裸扫描值
				...(runInfo?.frontend ? { frontend: runInfo.frontend } : {}),
				...(runInfo && runInfo.error ? { error: runInfo.error } : {}),
			};
		});
		this.send(ctx.res, 200, { plugins: merged });
	}

	/**
	 * GET /api/plugins/:id/frontend.mjs:插件前端 JS(仅 trusted 插件返回)。
	 * 安全:未信任插件的 JS 不加载——渲染进程只执行用户显式「完全信任」的插件代码;
	 * 路径经 getPluginFrontendPath 防逃逸;manifest 声明入口缺省 frontend.mjs。
	 */
	private async handleGetPluginFrontend(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const infos = await listPlugins();
		const info = infos.find((p) => p.id === id);
		if (!info) throw new HttpError(404, "not_found", `插件不存在: ${id}`);
		if (!info.trusted) {
			throw new HttpError(404, "not_found", "插件未信任,不提供前端 JS(设置页开启「完全信任」后可用)");
		}
		const rel = info.frontend?.frontend;
		const path = getPluginFrontendPath(id, rel);
		if (!path) throw new HttpError(404, "not_found", "插件前端入口不存在");
		const source = await readFile(path, "utf8");
		ctx.res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
		ctx.res.end(source);
	}

	/**
	 * PUT /api/plugins/:id {enabled?, trusted?}:切换用户级启用/信任状态 →
	 * 重新装载插件 → 重建会话。
	 * - manifest 声明 enabled:false 的插件不可被用户启用;
	 * - trusted(完全信任)开启后解锁后端自定义路由 + 前端 JS(单次信任,无分层);
	 * - 至少传一个布尔字段;缺省不动。
	 */
	private async handlePutPlugin(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown> | null;
		const enabled = body?.enabled;
		const trusted = body?.trusted;
		if (enabled !== undefined && typeof enabled !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 enabled 必须为 boolean");
		}
		if (trusted !== undefined && typeof trusted !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 trusted 必须为 boolean");
		}
		if (enabled === undefined && trusted === undefined) {
			throw new HttpError(400, "bad_request", "至少提供一个字段(enabled/trusted)");
		}
		const infos = await listPlugins();
		const info = infos.find((p) => p.id === id);
		if (!info) throw new HttpError(404, "not_found", `插件不存在: ${id}`);
		if (enabled === true && info.manifestDisabled) {
			throw new HttpError(400, "bad_request", "插件在 plugin.json 中声明禁用,无法从用户侧启用");
		}
		if (trusted !== undefined) await writePluginTrusted(id, trusted);
		if (enabled !== undefined) await writePluginEnabled(id, enabled);
		// 装载结果变化 → 重建会话使插件工具生效(与 handleMcpReload 同款)
		await this.reloadPluginRuntime();
		this.send(ctx.res, 200, { ok: true, plugins: await listPlugins() });
	}

	/** DELETE /api/plugins/:id:删除插件目录(移除后重建会话;state 一并清理)。 */
	private async handleDeletePlugin(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		try {
			await removePlugin(id);
		} catch (err) {
			throw new HttpError(404, "not_found", err instanceof Error ? err.message : "插件不存在");
		}
		await this.reloadPluginRuntime();
		this.send(ctx.res, 200, { ok: true, plugins: await listPlugins() });
	}

	/** 重载插件并重建会话(工具变更生效;失败不丢服务,插件错误经 GET 展示)。 */
	private async reloadPluginRuntime(): Promise<void> {
		// 同步装载态:重新执行 loadPlugins(启用/禁用/信任变化),把错误挂到列表合并源
		try {
			const { infos, webCommands, routes } = await loadPlugins();
			this.pluginInfos = infos;
			this.pluginWebCommands = webCommands;
			this.pluginRoutes = routes;
		} catch {
			this.pluginInfos = null;
			this.pluginWebCommands = new Map();
			this.pluginRoutes = [];
		}
		try {
			await this.options.sessionHost.reloadRuntime();
		} catch {
			/* 会话重建失败:保留旧 runtime,插件错误仍可经 /api/plugins 查看 */
		}
	}

	// ---- plugins 设置/命令子路由 ----

	/**
	 * GET /api/plugins/:id/settings:插件设置菜单 schema + 当前值。
	 * schema 来自 plugin.json 的 frontend.ui.settingsItems(字段级白名单校验后的);
	 * values 来自 plugins/<id>/settings.json(不存在 = 空对象)。
	 * 插件不存在 404;未声明设置菜单的插件返回 schema=[]。
	 */
	private async handleGetPluginSettings(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const infos = await listPlugins();
		const info = infos.find((p) => p.id === id);
		if (!info) throw new HttpError(404, "not_found", `插件不存在: ${id}`);
		const schema = info.frontend?.ui?.settingsItems ?? [];
		const values = await readPluginSettings(id);
		this.send(ctx.res, 200, { schema, values });
	}

	/**
	 * PUT /api/plugins/:id/settings {values}:写插件设置(白名单字段类型校验;
	 * 未知键/类型不匹配 400) → 落盘 → 重建会话,新值对插件工具生效。
	 */
	private async handlePutPluginSettings(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const infos = await listPlugins();
		const info = infos.find((p) => p.id === id);
		if (!info) throw new HttpError(404, "not_found", `插件不存在: ${id}`);
		const schema = info.frontend?.ui?.settingsItems ?? [];
		const fields = schema.flatMap((item) => item.fields);
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown> | null;
		const values = body?.values;
		if (typeof values !== "object" || values === null || Array.isArray(values)) {
			throw new HttpError(400, "bad_request", "字段 values 必须为对象");
		}
		// 白名单 + 类型校验:未知字段 400(前端只会发声明字段;手改请求体不该静默丢)
		const allowed = new Map(fields.map((f) => [f.key, f.type]));
		for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
			const type = allowed.get(key);
			if (!type) throw new HttpError(400, "bad_request", `未知设置字段: ${key}`);
			const typeOk =
				(type === "boolean" && typeof value === "boolean") ||
				(type === "number" && typeof value === "number") ||
				(type === "string" && typeof value === "string") ||
				(type === "textarea" && typeof value === "string") ||
				(type === "select" && typeof value === "string");
			if (!typeOk) throw new HttpError(400, "bad_request", `字段 ${key} 类型不匹配(应为 ${type})`);
		}
		await writePluginSettings(id, values as Record<string, unknown>, fields);
		await this.reloadPluginRuntime();
		this.send(ctx.res, 200, { ok: true, values: await readPluginSettings(id) });
	}

	/**
	 * POST /api/plugins/:id/command/:name {term?, bookSlug?}:执行插件 Web 命令
	 * (入口 webCommands 的 handler;主进程执行,renderer 零 JS)。
	 * 命令未注册 404;handler 抛错 500;结果文本长度上限截断(防工具滥用超长响应)。
	 */
	private async handlePostPluginCommand(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const name = ctx.params.name!;
		const commands = this.pluginWebCommands.get(id);
		const handler = commands?.[name];
		if (!handler) throw new HttpError(404, "not_found", `插件命令不存在: ${id}/${name}`);
		const body = (await readJsonBody(ctx.req).catch(() => null)) as Record<string, unknown> | null;
		try {
			const text = await handler({
				...(typeof body?.term === "string" ? { term: body.term } : {}),
				...(typeof body?.bookSlug === "string" ? { bookSlug: body.bookSlug } : {}),
			});
			const out = typeof text === "string" ? text : String(text);
			this.send(ctx.res, 200, { text: out.slice(0, 4000) });
		} catch (e) {
			throw new HttpError(500, "plugin_error", `插件命令执行失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ---- stage 路由 ----

	/** GET /api/stage/:slug:舞台区快照(纯读不创建编排器;未装配 stageHost 时 404)。 */
	private async handleGetStage(ctx: RouteContext): Promise<void> {
		const stage = this.options.stageHost;
		if (!stage) throw new HttpError(404, "not_found", "舞台区未启用");
		const chapterFile = ctx.url.searchParams.get("chapterFile");
		this.send(ctx.res, 200, await stage.snapshot(ctx.params.slug!, chapterFile));
	}

	/** GET /api/stage/:slug/last-world-edit:世界书编辑记录(world_update 工具写的
	 *  before/after 快照,前端回合结束渲染预览卡);无记录 → 404。 */
	private async handleGetStageLastWorldEdit(ctx: RouteContext): Promise<void> {
		const record = await readWorldEditRecord(getBookDir(ctx.params.slug!));
		if (!record) throw new HttpError(404, "not_found", "尚无世界书编辑记录");
		this.send(ctx.res, 200, record);
	}

	/**
	 * POST /api/stage/:slug/command:舞台命令。同步命令 200 { text }(即时文本结果,
	 * 与 CLI 打印一致);长命令(director/fix/cut,内部有模型回合)202 + stage_done 事件。
	 * chapterFile 可选:舞台按章节隔离(编排器键书+章节)。
	 */
	private async handlePostStageCommand(ctx: RouteContext): Promise<void> {
		const stage = this.options.stageHost;
		if (!stage) throw new HttpError(404, "not_found", "舞台区未启用");
		const body = await readJsonBody(ctx.req);
		const cmd = requireString(body, "cmd");
		const args = body as Record<string, unknown>;
		const chapterFile = args.chapterFile === undefined ? undefined : requireString(body, "chapterFile");
		const result = await stage.command(ctx.params.slug!, cmd, body as Record<string, unknown>, chapterFile);
		if (result.async) {
			this.send(ctx.res, 202, { ok: true });
		} else {
			this.send(ctx.res, 200, { text: result.text });
		}
	}

	// ---- writer 路由(常驻编剧/编辑 agent) ----

	/**
	 * 读 writer 端点的可选定位参数(chapterFile / conversation)。
	 *
	 * - `chapterFile`:章节文件名。chapter 模式下**就是**会话身份(现状);
	 *   book 模式下不再决定会话身份,只登记「用户正在看的章节」(易变上下文注入)。
	 * - `conversation`:对话 id(book 模式:createConversation 产出的不透明 id;
	 *   chapter 模式:章节文件名)。传了它按它定位,与 chapterFile 并存。
	 * - 都不传 → 沿用今天的回落规则(最近声明的章节 → 该书当前对话 → default)。
	 *
	 * 取值语义:`undefined` = 没传(保留上次登记);`null` = **显式空值**
	 * (`?chapterFile=`)= 用户没有正在看的章节 → book 模式据此清掉正文块的注入
	 * (否则关掉章节后 AI 还看得到上一章的正文);字符串 = 定位到它。
	 * `conversation` 的空值当没传(不存在"清空当前对话"这种操作)。
	 *
	 * GET 走 query、POST 走 body;两边都给时 body 优先(body 放得下的地方就别塞 query)。
	 */
	private writerRef(ctx: RouteContext, body: unknown): { chapterFile?: string | null; conversation?: string } {
		const args = (body ?? null) as Record<string, unknown> | null;
		const read = (key: "chapterFile" | "conversation"): string | null | undefined => {
			const raw = args?.[key] ?? ctx.url.searchParams.get(key);
			if (raw === undefined || raw === null) return undefined;
			if (typeof raw !== "string") throw new HttpError(400, "bad_request", `字段 ${key} 必须是字符串`);
			const trimmed = raw.trim();
			if (trimmed.length === 0) return key === "chapterFile" ? null : undefined;
			if (!isSafeSessionId(trimmed)) throw new HttpError(400, "bad_request", `非法${key === "conversation" ? "对话 id" : "章节文件名"}: ${trimmed}`);
			return trimmed;
		};
		const conversation = read("conversation");
		return { chapterFile: read("chapterFile"), conversation: conversation ?? undefined };
	}

	/**
	 * GET /api/writer/:slug?chapterFile=&conversation=:编剧会话状态(纯读不创建会话;
	 * 未装配 writerHost 时 404)。两个参数都可选:chapterFile = 章节(chapter 模式的身份 /
	 * book 模式正在看的章节),conversation = 对话 id;缺省用该书当前对话/最近对话章节。
	 */
	private async handleGetWriter(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const ref = this.writerRef(ctx, null);
		this.send(ctx.res, 200, await writer.state(ctx.params.slug!, ref.chapterFile, ref.conversation));
	}

	/**
	 * POST /api/writer/:slug/chat {text, chapterFile?, conversation?}:发消息给编剧
	 * (惰性建会话,chapterFile 声明上下文注入的章节、conversation 指定对话)。
	 * 202 立即返回,消息/工具事件经 writer_event SSE 到达。
	 */
	private async handlePostWriterChat(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const text = requireString(body, "text");
		const ref = this.writerRef(ctx, body);
		this.send(ctx.res, 202, { ok: true });
		void writer.chat(ctx.params.slug!, text, ref.chapterFile, ref.conversation).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			// 与事件转发同款帧构造:book 模式的会话要带 conversation,前端才知道是哪段对话出错。
			// text 一并带上(2026-10 审计 BUG-014):这条路径在写用户消息之前就抛了,
			// 报错卡要能原样重放这句,而不是让前端拿「当前最后一条消息」去猜。
			this.broadcastWriterEvent(ctx.params.slug!, ref.chapterFile ?? null, { type: "chat_error", message, text }, ref.conversation);
		});
	}

	/** POST /api/writer/:slug/abort {conversation?}:中止编剧当前生成(无会话时静默成功;
	 *  不带 conversation 时中止该书全部对话的生成)。 */
	private async handlePostWriterAbort(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown> | null;
		const ref = this.writerRef(ctx, body);
		askUserGate.cancelAll();
		await writer.abort(ctx.params.slug!, ref.conversation);
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/writer/:slug/retract {entryId, replacement?, chapterFile?, conversation?}:编剧会话
	 * 「编辑重发」——撤回最新一条用户消息及其后所有消息(leaf 回退,AI 上下文同步截断),
	 * replacement 存在时撤回后异步重发。两个定位参数缺省用该书当前对话。
	 * 广播 messages_retracted(与主会话同款,前端编剧会话重新对齐)。
	 */
	private async handlePostWriterRetract(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		const replacement = optionalString(body, "replacement");
		const ref = this.writerRef(ctx, body);
		try {
			await writer.retractMessage(ctx.params.slug!, entryId, replacement, ref.chapterFile, ref.conversation);
		} catch (err) {
			// 未知 entry / 非 user 消息 / 非最新消息 / 流式中:业务性错误,映射 400
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/** GET /api/writer/:slug/tree?chapterFile=&conversation=:编剧会话分支树(切换 UI 数据;无会话返回空树,不创建)。 */
	private async handleGetWriterTree(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const ref = this.writerRef(ctx, null);
		this.send(ctx.res, 200, await writer.getSessionTree(ctx.params.slug!, ref.chapterFile, ref.conversation));
	}

	/**
	 * POST /api/writer/:slug/navigate {entryId, chapterFile?, conversation?}:编剧会话分支切换——
	 * leaf 移到指定消息,以其为当前分支重建上下文;广播 messages_retracted(前端编剧会话重新对齐)。
	 */
	private async handlePostWriterNavigate(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		const ref = this.writerRef(ctx, body);
		try {
			await writer.navigate(ctx.params.slug!, entryId, ref.chapterFile, ref.conversation);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * GET /api/writer/:slug/stats?chapterFile=&conversation=&warm=1:编剧会话**用量统计**
	 * (2026-09-23 接上 vendor 原生的 getSessionStats:累计 token / 成本 / 按模型拆分)。
	 * 口径是整个会话文件(含被压缩掉的历史)—— 与 /context 的"现在多大"不同;
	 * 响应里顺带带上 contextUsage,前端一次请求就能把用量卡和圆环都填上。
	 */
	private async handleGetWriterStats(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const ref = this.writerRef(ctx, null);
		const warm = ctx.url.searchParams.get("warm") === "1";
		const stats = await writer.sessionStats(ctx.params.slug!, ref.chapterFile, { warm, conversation: ref.conversation });
		this.send(ctx.res, 200, { stats });
	}

	/**
	 * GET /api/writer/:slug/context?chapterFile=&conversation=:编剧会话上下文占用(纯读;
	 * 无活跃会话/压缩后尚无新的模型响应时 usage 为 null)。
	 * `warm=1`:磁盘上已有该对话会话文件时把会话带起来再读(打开页面就有圆环数据;见
	 * writer-host.contextUsage 的注释)。
	 *
	 * 2026-10-04(T4):顺带返回**最近一次装配的裁切摘要**——用户看到用量圆环的同时
	 * 就知道「省了什么」。两份数据同源同请求,前端不必再发一次。
	 */
	private async handleGetWriterContext(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const ref = this.writerRef(ctx, null);
		const warm = ctx.url.searchParams.get("warm") === "1";
		const usage = await writer.contextUsage(ctx.params.slug!, ref.chapterFile, { warm, conversation: ref.conversation });
		// 裁切摘要是**本类**的状态(由 injectChapterContext 写入),不走 writerHost
		this.send(ctx.res, 200, { usage, trim: this.lastTrimSummary(ctx.params.slug!, ref.chapterFile ?? null, ref.conversation) });
	}

	/**
	 * GET /api/writer/:slug/inspect?chapterFile=&conversation=:上下文检视面板数据
	 * (2026-10-04,T5;纯读,不创建会话)。
	 *
	 * 数据来源是 lastSections —— 即**最近一次真正注入**的分段占用,而不是现算。
	 * 理由与 T4 的 lastTrim 完全相同:两次装配之间世界书可能已被 AI 改过,
	 * 现算出的数字会与用户实际看到的上下文对不上,那比没有面板更糟。
	 *
	 * 未装配过(sections 为空)时返回 available:false,前端据此显示
	 * 「本章还没有注入过背景包」而不是渲染一堆 0。
	 */
	private async handleGetWriterInspect(ctx: RouteContext): Promise<void> {
		const ref = this.writerRef(ctx, null);
		const slug = ctx.params.slug!;
		const sections = this.lastSectionSnapshot(slug, ref.chapterFile ?? null);
		const settings = await readWriterSettings();
		const book = await loadBook(slug);
		const chapterFile = ref.chapterFile ?? book?.currentChapterFile ?? book?.chapters[0]?.file ?? "";
		const chapter = book?.chapters.find((c) => c.file === chapterFile);
		const report = buildInspectReport({
			slug,
			chapterFile,
			chapterTitle: chapter?.title ?? "",
			context: { sections, trimmed: this.lastTrimmedSnapshot(slug, ref.chapterFile ?? null) },
			settings,
		});
		this.send(ctx.res, 200, { available: sections.length > 0, report });
	}

	/**
	 * POST /api/writer/:slug/compact {chapterFile?, conversation?, instructions?}:手动压缩编剧会话
	 * 上下文。压缩是模型总结回合(可能耗时 1-10 分钟),compaction_start/end 经
	 * writer_event SSE 驱动前端「正在压缩上下文」提示;本端点等压缩完成才响应。
	 */
	private async handlePostWriterCompact(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const ref = this.writerRef(ctx, body);
		const instructions = optionalString(body, "instructions");
		try {
			const result = await writer.compact(ctx.params.slug!, ref.chapterFile, instructions, ref.conversation);
			this.send(ctx.res, 200, { ok: true, ...result });
		} catch (err) {
			// "Nothing to compact"/模型未配置等业务性失败映射 400,避免 500
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
	}

	// ---- conversations 路由(对话清单/新建/删除;book 模式「章节与对话各聊各的」) ----

	/** writer 端点与对话端点共用:书必须存在(不存在的书 404,而不是凭空造 sessions 目录)。 */
	private requireBookExists(slug: string): void {
		if (!isSafeSessionId(slug)) throw new HttpError(400, "bad_request", `非法书 slug: ${slug}`);
		if (!existsSync(getBookDir(slug))) throw new HttpError(404, "not_found", `书不存在: ${slug}`);
	}

	/**
	 * GET /api/conversations?slug=:该书的对话清单(标题从会话内容派生、时间取文件 mtime、
	 * 倒序;isCurrent 标记 writer 端点缺省会定位到的那条)。
	 *
	 * **不读元数据文件**:会话文件 (`sessions/<slug>/writer-*.jsonl`) 是唯一真相源,
	 * 没有 conversations.json 之类需要同步的第二份清单。
	 */
	private async handleGetConversations(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const slug = ctx.url.searchParams.get("slug") ?? "";
		this.requireBookExists(slug);
		this.send(ctx.res, 200, { conversations: await writer.listConversations(slug) });
	}

	/**
	 * POST /api/conversations {slug}:新建一段与章节无关的对话(book 模式的用法),
	 * 并把它设为当前对话;返回新对话 + 最新清单(前端一次请求即可刷新列表并选中)。
	 */
	private async handlePostConversation(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const slug = requireString(body, "slug").trim();
		this.requireBookExists(slug);
		const conversation = await writer.createConversation(slug);
		this.send(ctx.res, 201, { conversation, conversations: await writer.listConversations(slug) });
	}

	/** DELETE /api/conversations/:id?slug=:删除一段对话(释放宿主 + 删会话文件;不存在 404)。 */
	private async handleDeleteConversation(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const slug = ctx.url.searchParams.get("slug") ?? "";
		this.requireBookExists(slug);
		const id = ctx.params.id ?? "";
		if (!isSafeSessionId(id)) throw new HttpError(400, "bad_request", `非法对话 id: ${id}`);
		const deleted = await writer.deleteConversation(slug, id);
		if (!deleted) throw new HttpError(404, "not_found", `对话不存在: ${id}`);
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- themes 路由(用户自定义主题资产文件) ----

	/** 解析用户主题文件绝对路径:限 themes 目录 + 单文件 .css 名,防越界/写任意文件。 */
	private resolveThemeFile(file: string): string {
		const name = basename(file);
		if (!/^[A-Za-z0-9._-]+\.css$/.test(name)) {
			throw new HttpError(400, "bad_request", "非法主题文件名(仅允许 *.css)");
		}
		return join(getThemesDir(), name);
	}

	/**
	 * GET /api/skills?slug=:当前装配会加载到的技能清单(name + description + explicitOnly)。
	 *
	 * 给前端 `/` 菜单的「技能」命令用:菜单列出的名字必须与 `/skill:<name>` 能展开的
	 * 那份一致(vendor 对认不出的名字**原样透传**,对不上就是「点了技能但没生效」)。
	 * 所以这里不自己扫目录,走 `listSkills`(vendor loadSkills + sessionSkillDirs,与
	 * agent 装配同源)。目录基准取书的目录,拿不到书就退回进程 cwd —— 自带技能与全局
	 * 技能与 cwd 无关,项目级技能(`<cwd>/.pi/skills`)才用得上。纯读,不创建会话。
	 */
	private async handleGetSkills(ctx: RouteContext): Promise<void> {
		const slug = ctx.url.searchParams.get("slug");
		let cwd: string | null = null;
		if (slug) {
			// 书目录不合法(路径穿越 / 不存在)不报错:退回进程 cwd,菜单照常出内置技能
			try {
				cwd = getBookDir(slug);
			} catch {
				cwd = null;
			}
		}
		this.send(ctx.res, 200, { skills: listSkills({ cwd }) });
	}

	/** GET /api/themes:主题清单——内置(web/public|dist/themes 资产,零 ts 注册)
	 *  与用户自定义(~/.pi/writer/themes)各自的文件 + 全文,供设置页 swatch 预览、
	 *  编辑器预填与内置主题自动发现。 */
	private async handleGetThemes(ctx: RouteContext): Promise<void> {
		const readThemes = async (dir: string | null): Promise<UserThemeEntry[]> => {
			if (!dir) return [];
			let files: string[] = [];
			try {
				files = (await readdir(dir)).filter((f) => /^[A-Za-z0-9._-]+\.css$/.test(f)).sort();
			} catch {
				return []; // 目录不存在:该源无主题
			}
			return Promise.all(
				files.map(async (file) => {
					try {
						return { file, css: await readFile(join(dir, file), "utf-8") };
					} catch {
						return { file, css: "" };
					}
				}),
			);
		};
		const user = await readThemes(getThemesDir());
		const builtin = await readThemes(resolveBuiltinThemesDir(process.env, this.staticRoot));
		this.send(ctx.res, 200, { user, builtin });
	}

	/** GET /api/themes/:file:用户主题 CSS 原文(text/css),供 <link id="pi-theme"> 加载。 */
	private async handleGetThemeFile(ctx: RouteContext): Promise<void> {
		const abs = this.resolveThemeFile(ctx.params.file!);
		let css = "";
		try {
			css = await readFile(abs, "utf-8");
		} catch {
			css = ""; // 文件不存在:空 CSS,浏览器忽略
		}
		ctx.res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
		ctx.res.end(css);
	}

	/** PUT /api/themes/:file {css}:保存用户主题(原子写)。 */
	private async handlePutThemeFile(ctx: RouteContext): Promise<void> {
		const abs = this.resolveThemeFile(ctx.params.file!);
		const body = await readJsonBody(ctx.req);
		const css = requireString(body, "css", true);
		await mkdir(dirname(abs), { recursive: true });
		await atomicWriteFile(abs, css);
		this.send(ctx.res, 200, { ok: true });
	}

	/** DELETE /api/themes/:file:删除用户主题。 */
	private async handleDeleteThemeFile(ctx: RouteContext): Promise<void> {
		const abs = this.resolveThemeFile(ctx.params.file!);
		try {
			await unlink(abs);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- settings 路由(服务端全局设置:经典模式等)----

	/**
	 * GET /api/settings:全局设置(~/.pi/writer/settings.json)。前端启动时对账
	 * 本地缓存(经典模式决定顶栏导航显示哪几页),多窗口/换浏览器都读同一份。
	 *
	 * 附带 `shell` = 当前设置解析出的**实际**方言与路径(见 src/shell-kind.ts):
	 * 选了 pwsh 但本机没装时 dialect 为 "none" 并带 warning,设置页据此提示,
	 * 而不是等模型调 shell 报错才发现。
	 */
	private async handleGetSettings(ctx: RouteContext): Promise<void> {
		const settings = await readWriterSettings();
		// appVersion:包版本(package.json),设置页页脚展示用 —— 前端没有别的来源,
		// 而排障时「用户报的是哪个版本」是第一个要问的问题
		this.send(ctx.res, 200, { settings, shell: resolveWriterShell(settings), appVersion: VERSION });
	}

	/**
	 * PUT /api/settings {classicMode?, conversationScope?, enableShell?, shellKind?, shellPath?}:
	 * 更新设置(只收白名单字段,未知字段忽略)。
	 *
	 * 这些开关都改变**服务端 agent 装配**(经典模式换提示词与工具集;对话与章节的关系换
	 * 会话身份规则;外部命令放开 shell;shellKind/shellPath 换方言与可执行文件),
	 * 所以落盘后立即应用:
	 * - WriterHost(编辑页会话)按开关释放已建会话,下次对话按新装配重建;
	 * - 主 SessionHost 走 reloadRuntime()(与 MCP 配置变更同一路径:复用当前会话文件重建
	 *   运行时,新工具随之生效,leaf 指针保留)。重建失败不回滚设置——设置已落盘,
	 *   下次启动仍生效,这里只保证「能重建就重建」。
	 *
	 * 变更经 SSE 广播 settings_changed:其他窗口(另一浏览器/Electron)据此同步开关状态。
	 * 响应带 `shell`(解析结果),前端据此回显「实际用哪个 shell / 是否找不到」。
	 */
	private async handlePutSettings(ctx: RouteContext): Promise<void> {
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown> | null;
		const rawClassic = body?.classicMode;
		const rawScope = body?.conversationScope;
		const rawShell = body?.enableShell;
		const rawKind = body?.shellKind;
		const rawPath = body?.shellPath;
		// 图片生成(实验,0.1.0)
		const rawImageGen = body?.enableImageGen;
		const rawImageProvider = body?.imageProvider;
		const rawImageModel = body?.imageModel;
		const rawImageSize = body?.imageSize;
		const rawImageBaseUrl = body?.imageBaseUrl;
		const rawImageKey = body?.imageApiKey;
		const rawImageInReply = body?.imageInReply;
		const rawImageWorldbook = body?.imageWorldbook;
		const rawImageConfirm = body?.imageConfirmBeforeGen;
		if (rawClassic !== undefined && typeof rawClassic !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 classicMode 必须是布尔值");
		}
		if (rawScope !== undefined && rawScope !== "chapter" && rawScope !== "book") {
			throw new HttpError(400, "bad_request", "字段 conversationScope 只能是 chapter 或 book");
		}
		if (rawShell !== undefined && typeof rawShell !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 enableShell 必须是布尔值");
		}
		if (rawKind !== undefined && rawKind !== "auto" && rawKind !== "bash" && rawKind !== "pwsh") {
			throw new HttpError(400, "bad_request", "字段 shellKind 只能是 auto、bash 或 pwsh");
		}
		if (rawPath !== undefined && typeof rawPath !== "string") {
			throw new HttpError(400, "bad_request", "字段 shellPath 必须是字符串");
		}
		if (rawImageGen !== undefined && typeof rawImageGen !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 enableImageGen 必须是布尔值");
		}
		if (rawImageProvider !== undefined && rawImageProvider !== "openai-images") {
			throw new HttpError(400, "bad_request", "字段 imageProvider 只能是 openai-images");
		}
		if (rawImageSize !== undefined && rawImageSize !== "1:1" && rawImageSize !== "3:2" && rawImageSize !== "16:9") {
			throw new HttpError(400, "bad_request", "字段 imageSize 只能是 1:1、3:2 或 16:9");
		}
		if (rawImageModel !== undefined && typeof rawImageModel !== "string") {
			throw new HttpError(400, "bad_request", "字段 imageModel 必须是字符串");
		}
		if (rawImageBaseUrl !== undefined && typeof rawImageBaseUrl !== "string") {
			throw new HttpError(400, "bad_request", "字段 imageBaseUrl 必须是字符串");
		}
		if (rawImageKey !== undefined && typeof rawImageKey !== "string") {
			throw new HttpError(400, "bad_request", "字段 imageApiKey 必须是字符串");
		}
		if (rawImageInReply !== undefined && typeof rawImageInReply !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 imageInReply 必须是布尔值");
		}
		if (rawImageWorldbook !== undefined && typeof rawImageWorldbook !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 imageWorldbook 必须是布尔值");
		}
		if (rawImageConfirm !== undefined && typeof rawImageConfirm !== "boolean") {
			throw new HttpError(400, "bad_request", "字段 imageConfirmBeforeGen 必须是布尔值");
		}
		const settings: WriterSettings = await updateWriterSettings({
			...(rawClassic === undefined ? {} : { classicMode: rawClassic }),
			...(rawScope === undefined ? {} : { conversationScope: rawScope }),
			...(rawShell === undefined ? {} : { enableShell: rawShell }),
			...(rawKind === undefined ? {} : { shellKind: rawKind }),
			...(rawPath === undefined ? {} : { shellPath: rawPath.trim().slice(0, 500) }),
			...(rawImageGen === undefined ? {} : { enableImageGen: rawImageGen }),
			...(rawImageProvider === undefined ? {} : { imageProvider: rawImageProvider }),
			...(rawImageModel === undefined ? {} : { imageModel: rawImageModel.trim().slice(0, 200) }),
			...(rawImageSize === undefined ? {} : { imageSize: rawImageSize }),
			...(rawImageBaseUrl === undefined ? {} : { imageBaseUrl: rawImageBaseUrl.trim().slice(0, 500) }),
			...(rawImageKey === undefined ? {} : { imageApiKey: rawImageKey.trim().slice(0, 500) }),
			...(rawImageInReply === undefined ? {} : { imageInReply: rawImageInReply }),
			...(rawImageWorldbook === undefined ? {} : { imageWorldbook: rawImageWorldbook }),
			...(rawImageConfirm === undefined ? {} : { imageConfirmBeforeGen: rawImageConfirm }),
		});
		// 解析实际方言:选 pwsh 而本机没有 → none(会话按无 shell 装配,提示词如实叙述)
		const shell = resolveWriterShell(settings);
		await this.options.writerHost?.setClassicMode(settings.classicMode);
		// 对话与章节的关系(缺省 chapter):换形态即释放已建会话——两种形态的会话身份
		// 规则与上下文注入方式都不同,复用旧会话会把旧规则带过去
		await this.options.writerHost?.setConversationScope(settings.conversationScope);
		await this.options.writerHost?.setShell({
			enabled: settings.enableShell,
			dialect: shell.dialect,
			path: shell.path ?? null,
		});
		// 图片生成开关同理:它决定 image_generate 工具存不存在,变了就得释放会话
		await this.options.writerHost?.setImageGen(settings.enableImageGen);
		try {
			await this.options.sessionHost.reloadRuntime();
		} catch {
			/* 主会话重建失败:设置已落盘,旧 runtime 继续可用,下次启动生效 */
		}
		this.broadcast({ type: "settings_changed", settings });
		this.send(ctx.res, 200, { settings, shell });
	}

	// ---- setup 路由(首次启动配置向导)----

	/**
	 * GET /api/setup:向导状态——是否已完成 + 各步骤标记。前端据此决定首次
	 * 启动是否弹出向导;读取失败(文件损坏)返回未完成态,不阻塞主界面。
	 */
	private async handleGetSetup(ctx: RouteContext): Promise<void> {
		const setup = await readSetupState();
		this.send(ctx.res, 200, { completed: setup.completedAt !== null, setup });
	}

	/**
	 * POST /api/setup {steps?}:标记向导完成。steps 可选,只收白名单步骤且值
	 * 为 true 的项(未知键 400,防前端写错步骤名静默丢失);缺省/空对象表示
	 * 「跳过向导」——同样写完成时间,避免每次启动重复弹。
	 */
	private async handlePostSetup(ctx: RouteContext): Promise<void> {
		const body = (await readJsonBody(ctx.req)) as Record<string, unknown> | null;
		const steps = defaultSetupState().steps;
		const rawSteps = body?.steps;
		if (rawSteps !== undefined) {
			if (typeof rawSteps !== "object" || rawSteps === null || Array.isArray(rawSteps)) {
				throw new HttpError(400, "bad_request", "字段 steps 必须是对象");
			}
			for (const [key, value] of Object.entries(rawSteps as Record<string, unknown>)) {
				if (!isSetupStepId(key)) throw new HttpError(400, "bad_request", `未知向导步骤: ${key}`);
				if (value === true) steps[key] = true;
			}
		}
		const state: SetupState = { version: SETUP_VERSION, completedAt: new Date().toISOString(), steps };
		await writeSetupState(state);
		this.send(ctx.res, 200, { completed: true, setup: state });
	}

	/** POST /api/setup/reset:重置为未完成(设置页「重新运行配置向导」入口)。 */
	private async handlePostSetupReset(ctx: RouteContext): Promise<void> {
		const state = defaultSetupState();
		await writeSetupState(state);
		this.send(ctx.res, 200, { completed: false, setup: state });
	}

	// ---- 请求分发 ----

	/**
	 * 请求分发:非 /api 走静态服务;API 先过回环/跨站/token 守卫,SSE 端点先行,
	 * 其余按 (method, 路径段模式) 匹配路由表(handler 内抛错统一映射为错误体)。
	 */
	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		// 逐段解码:路径段可能携带 CJK(书名/章节 id),fetch 会对 URL 做百分号编码
		const parts = url.pathname
			.split("/")
			.filter(Boolean)
			.map((p) => {
				try {
					return decodeURIComponent(p);
				} catch {
					return p;
				}
			});
		const method = req.method ?? "GET";
		if (parts[0] !== "api") {
			// 非 API:静态服务(web/dist);未配置时保持原 404 行为
			this.serveStatic(req, res, url);
			return;
		}
		// 回环来源守卫:仅接受回环 Host(防 DNS rebinding,浏览器无法伪造 Host);
		// 携带 Origin/Sec-Fetch-Site 的请求(浏览器跨站 fetch/EventSource/form)必须
		// 同样来自回环,否则 403。无这些头的本机请求(curl、脚本)放行,保持本地可用性。
		const hostHeader = req.headers.host;
		if (hostHeader === undefined || !isLoopbackHostName(hostHeader)) {
			this.send(res, 403, { error: { code: "forbidden", message: "仅允许本机访问" } });
			return;
		}
		const originHeader = req.headers.origin;
		if (originHeader !== undefined && originHeader !== "" && !originHostIsLoopback(originHeader)) {
			this.send(res, 403, { error: { code: "forbidden", message: "仅允许本机访问" } });
			return;
		}
		const secFetchSite = req.headers["sec-fetch-site"];
		if (
			secFetchSite !== undefined &&
			secFetchSite !== "" &&
			secFetchSite !== "same-origin" &&
			secFetchSite !== "same-site" &&
			secFetchSite !== "none"
		) {
			this.send(res, 403, { error: { code: "forbidden", message: "仅允许本机访问" } });
			return;
		}
		// 可选 Bearer token(Android 壳注入):未配置时行为与桌面版完全一致。
		// 接受 Authorization: Bearer <token> 或同源 cookie pi_writer_token=<token>。
		const authToken = this.options.authToken;
		if (authToken !== undefined) {
			const header = req.headers.authorization;
			const cookieToken = parseCookieToken(req.headers.cookie); // 读 "pi_writer_token=" 值
			const ok = header === `Bearer ${authToken}` || cookieToken === authToken;
			if (!ok) {
				this.send(res, 401, { error: { code: "unauthorized", message: "未授权" } });
				return;
			}
		}
		// /api/events:SSE 事件流(先于路由表,连接生命周期与广播 Set 关联;
		// 鉴权守卫在上方,未通过时 401 后连接即关闭)
		if (parts.length === 2 && parts[1] === "events" && method === "GET") {
			this.openSse(res);
			return;
		}
		// 匹配顺序:内置路由优先,其后是 trusted 插件动态路由(segments 已带插件 id 前缀,
		// 只追加不改,防插件覆盖内置端点)
		const matched = matchRoute(method, parts.slice(1), this.routes) ?? matchRoute(method, parts.slice(1), this.pluginRoutes);
		if (!matched) {
			this.send(res, 404, { error: { code: "not_found", message: "未找到" } });
			return;
		}
		try {
			await matched.route.handler({ req, res, url, params: matched.params });
		} catch (err) {
			if (err instanceof HttpError) {
				this.send(res, err.status, { error: { code: err.code, message: err.message } });
				return;
			}
			if (err instanceof StageCommandError) {
				this.send(res, 400, { error: { code: "bad_request", message: err.message } });
				return;
			}
			if (err instanceof WorldValidationError) {
				this.send(res, 400, { error: { code: "bad_request", message: err.message } });
				return;
			}
			this.send(res, 500, { error: { code: "error", message: err instanceof Error ? err.message : String(err) } });
		}
	}

	/**
	 * 非 /api 的 GET/HEAD 静态服务:pathname 解码后解析为 staticRoot 内相对路径
	 * (复用 resolveDraftPath 的越界校验,拒绝上溯/绝对路径/盘符);存在则按扩展名
	 * 给 content-type;目录请求 → 该目录 index.html;无扩展名且不存在 → 根
	 * index.html(SPA 路由);`/` → index.html。staticRoot 未配置 → 404(原行为)。
	 */
	private serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const root = this.staticRoot;
		const notFound = (): void => {
			this.send(res, 404, { error: { code: "not_found", message: "未找到" } });
		};
		if (!root) {
			notFound();
			return;
		}
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			notFound();
			return;
		}
		let rel: string;
		try {
			rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		} catch {
			this.send(res, 400, { error: { code: "bad_request", message: "路径编码无效" } });
			return;
		}
		const abs = resolveDraftPath(root, rel);
		if (!abs) {
			this.send(res, 400, { error: { code: "bad_path", message: "文件路径越界" } });
			return;
		}
		let file = abs;
		let stat = safeStat(file);
		if (stat?.isDirectory()) {
			// 目录请求 → 该目录的 index.html
			file = join(file, "index.html");
			stat = safeStat(file);
		}
		if (!stat?.isFile()) {
			// SPA fallback:无扩展名且不存在 → 根 index.html
			if (extname(file) === "") {
				file = join(root, "index.html");
				stat = safeStat(file);
			}
			if (!stat?.isFile()) {
				notFound();
				return;
			}
		}
		let body: Buffer;
		try {
			body = readFileSync(file);
		} catch {
			notFound();
			return;
		}
		res.writeHead(200, { "content-type": contentTypeFor(file), "content-length": body.length });
		res.end(method === "HEAD" ? undefined : body);
	}

	/** 打开 SSE 连接:写连接帧,登记到广播 Set,连接关闭/出错时退订。
	 *  有客户端连接时启动文件 watcher(无前端时零开销)。 */
	private openSse(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		this.sseClients.add(res);
		this.watcher.setActive(true);
		const disconnect = () => {
			this.sseClients.delete(res);
			if (this.sseClients.size === 0) this.watcher.setActive(false);
		};
		res.on("close", disconnect);
		res.on("error", disconnect);
	}
}
