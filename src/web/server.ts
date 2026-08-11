/**
 * WriterServer —— GUI 后端的 HTTP 服务:Node 原生 http,REST 端点
 * (books/chapters/session/chat/models/world/draft/export/import/mcp/stage)
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
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
import { getBookDir, getWriterDir } from "../config.ts";
import { MAX_ZIP_BYTES, exportBookZip, readImportZip, type BookZipImport } from "./book-zip.ts";
import { ensureWorld, newId, readWorldEditRecord, saveWorld, WorldValidationError, type WorldData } from "../world-data.ts";
import { buildChapterContext, DEFAULT_CONTEXT_BUDGET, trimMemory } from "../world-context.ts";
import type { SessionHost } from "./session-host.ts";
import { extractMessagesFromManager } from "./session-host.ts";
import { SessionManager } from "../../vendor/pi-coding-agent/src/index.ts";
import { ProviderAuthError } from "./provider-auth.ts";
import type { McpManager, McpServerStatus } from "../mcp/manager.ts";
import { getMcpConfigPath, saveRawMcpConfig, type McpServerConfig } from "../mcp/config.ts";
import { WorldWatcher } from "./file-watcher.ts";
import { StageCommandError, type StageHost } from "./stage-host.ts";
import { WriterHost } from "./writer-host.ts";

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
interface Route {
	method: string;
	segments: readonly string[];
	handler: (ctx: RouteContext) => Promise<void>;
}

/** handler 上下文:请求/响应/URL 与路径参数段。 */
interface RouteContext {
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

export class WriterServer {
	private readonly httpServer = createServer((req, res) => void this.route(req, res));
	private readonly sseClients = new Set<ServerResponse>();
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly options: WriterServerOptions;
	/** 静态资源根目录(web/dist);null 表示未配置,非 /api 保持 404。 */
	private readonly staticRoot: string | null;
	/**
	 * 章节切换互斥队列:session 路由整体串行执行(切章 → 写 book.json → 注入背景包),
	 * 避免多浏览器并发切章时交错(最终会话章节与 book.json 不一致、背景包注入错章节)。
	 */
	private switchQueue: Promise<void> = Promise.resolve();
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
		// 消息/思考/工具卡片与主会话同款逻辑)
		if (options.writerHost) {
			options.writerHost.setEventSink((slug, event) => {
				this.broadcast({ type: "writer_event", slug, event });
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
			{ method: "POST", segments: ["model"], handler: (ctx) => this.handlePostModel(ctx) },
			{ method: "POST", segments: ["thinking"], handler: (ctx) => this.handlePostThinking(ctx) },
			{ method: "GET", segments: ["providers"], handler: (ctx) => this.handleGetProviders(ctx) },
			{ method: "POST", segments: ["providers", ":id", "apikey"], handler: (ctx) => this.handlePostProviderApiKey(ctx) },
			{ method: "DELETE", segments: ["providers", ":id"], handler: (ctx) => this.handleDeleteProvider(ctx) },
			// world / draft / cards
			{ method: "GET", segments: ["world"], handler: (ctx) => this.handleGetWorld(ctx) },
			{ method: "PUT", segments: ["world"], handler: (ctx) => this.handlePutWorld(ctx) },
			{ method: "GET", segments: ["confirm-cards"], handler: (ctx) => this.handleGetConfirmCards(ctx) },
			{ method: "PUT", segments: ["confirm-cards"], handler: (ctx) => this.handlePutConfirmCards(ctx) },
			{ method: "GET", segments: ["draft"], handler: (ctx) => this.handleGetDraft(ctx) },
			{ method: "PUT", segments: ["draft"], handler: (ctx) => this.handlePutDraft(ctx) },
			// mcp(静态段 raw 必须在参数段 :name 之前)
			{ method: "GET", segments: ["mcp"], handler: (ctx) => this.handleGetMcp(ctx) },
			{ method: "POST", segments: ["mcp"], handler: (ctx) => this.handlePostMcp(ctx) },
			{ method: "GET", segments: ["mcp", "raw"], handler: (ctx) => this.handleGetMcpRaw(ctx) },
			{ method: "PUT", segments: ["mcp", "raw"], handler: (ctx) => this.handlePutMcpRaw(ctx) },
			{ method: "PUT", segments: ["mcp", ":name"], handler: (ctx) => this.handlePutMcpServer(ctx) },
			{ method: "DELETE", segments: ["mcp", ":name"], handler: (ctx) => this.handleDeleteMcpServer(ctx) },
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
		// 跨章节记忆:memory.md(容量有限,注入端按预算裁剪;不存在则为空)
		let memory = "";
		try {
			memory = trimMemory(await readFile(join(getBookDir(slug), "memory.md"), "utf-8"));
		} catch {
			memory = "";
		}
		const world = await ensureWorld(slug);
		const recent = this.options.sessionHost
			.getState()
			.messages.filter((m) => m.role === "user")
			.slice(-2)
			.map((m) => m.text);
		const context = buildChapterContext(world, { chapterId, draftText, recentUserMessages: recent, memory, budget: DEFAULT_CONTEXT_BUDGET });
		if (context.text.length > 0) {
			await this.options.sessionHost.injectContext(context.text);
		}
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
		await this.options.sessionHost.switchSession(absPath);
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

	/** 校验 MCP 服务器配置体(name/type/command/url 等),返回规范化配置。 */
	private readMcpServerBody(body: unknown): McpServerConfig {
		const record = body as Record<string, unknown> | null;
		if (!record || typeof record !== "object") throw new HttpError(400, "bad_request", "缺少服务器配置");
		const name = requireString(body, "name");
		const type = requireString(body, "type");
		if (type !== "stdio" && type !== "sse") throw new HttpError(400, "bad_request", "type 必须是 stdio 或 sse");
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
		if (type === "stdio" && !server.command?.trim()) throw new HttpError(400, "bad_request", "stdio 类型必须提供 command");
		if (type === "sse" && !server.url?.trim()) throw new HttpError(400, "bad_request", "sse 类型必须提供 url");
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
		// 当前会话书被删:中止生成、让 watcher 脱离(会话运行时由下次 switchSession 重建)
		if (this.options.sessionHost.getState().bookSlug === slug) {
			await this.options.sessionHost.abort();
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
			const sm = SessionManager.open(absPath, dirname(absPath), getBookDir(readSlug));
			this.send(ctx.res, 200, { ...base, messages: extractMessagesFromManager(sm) });
			return;
		}
		this.send(ctx.res, 200, this.options.sessionHost.getState());
	}

	/** POST /api/chat {text}:202 立即返回,发送异步进行,结果走 SSE。 */
	private async handlePostChat(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const text = requireString(body, "text");
		void this.options.sessionHost.sendMessage(text).catch((err) => {
			// 发送/生成失败(未配置模型、认证被拒、网络等)必须让前端知道:
			// 广播 chat_error,前端据此显示友好提示与快捷重试,而不是静默无回复
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[server] chat 发送失败: ${message}\n`);
			this.broadcast({ type: "chat_error", message });
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

	/** POST /api/abort:中止当前流式回复。 */
	private async handleAbort(ctx: RouteContext): Promise<void> {
		await this.options.sessionHost.abort();
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- models / providers 路由 ----

	/** GET /api/models:模型列表 + 当前模型/思考等级(session.state 由 vendor 提供)。 */
	private async handleGetModels(ctx: RouteContext): Promise<void> {
		const runtime = this.options.sessionHost.getRuntime();
		const models = await runtime.session.modelRuntime.getAvailable();
		const state = runtime.session.state;
		this.send(ctx.res, 200, { models, current: state.model, thinking: state.thinkingLevel });
	}

	/** POST /api/model {model}:切换模型。 */
	private async handlePostModel(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const model = requireString(body, "model");
		await this.options.sessionHost.setModel(model);
		this.send(ctx.res, 200, { ok: true });
	}

	/** POST /api/thinking {level}:切换思考等级。 */
	private async handlePostThinking(ctx: RouteContext): Promise<void> {
		const body = await readJsonBody(ctx.req);
		const level = requireString(body, "level");
		await this.options.sessionHost.setThinkingLevel(level);
		this.send(ctx.res, 200, { ok: true });
	}

	/** GET /api/providers:全部 provider + 认证状态(已配置置顶,排序在 SessionHost)。 */
	private async handleGetProviders(ctx: RouteContext): Promise<void> {
		const providers = await this.options.sessionHost.listProviders();
		this.send(ctx.res, 200, { providers });
	}

	/** POST /api/providers/:id/apikey {key}:写入 API key(官方 login 路径)。 */
	private async handlePostProviderApiKey(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const providers = await this.options.sessionHost.listProviders();
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

	/** DELETE /api/providers/:id:移除凭据。 */
	private async handleDeleteProvider(ctx: RouteContext): Promise<void> {
		const id = ctx.params.id!;
		const providers = await this.options.sessionHost.listProviders();
		if (!providers.some((p) => p.id === id)) {
			throw new HttpError(404, "not_found", `provider 不存在: ${id}`);
		}
		await this.options.sessionHost.removeProvider(id);
		this.send(ctx.res, 200, { ok: true });
	}

	// ---- world / draft / cards 路由 ----

	/**
	 * GET /api/world:slug 取当前会话 bookSlug,无会话 404;返回 world.json 全文,
	 * 前端自行构建树(视图文件可能落后于 world.json,以 world.json 为准)。
	 * mtime 一并返回:前端保存时作为 If-Match 条件写,防旧文本覆盖新修改。
	 */
	private async handleGetWorld(ctx: RouteContext): Promise<void> {
		const slug = this.options.sessionHost.getState().bookSlug;
		if (!slug) throw new HttpError(404, "not_found", "当前没有打开的书");
		const world = await ensureWorld(slug);
		const st = safeStat(join(getBookDir(slug), "world.json"));
		this.send(ctx.res, 200, { world, mtime: st?.mtimeMs ?? 0 });
	}

	/**
	 * PUT /api/world {world}:保存世界书(saveWorld 内部校验,WorldValidationError → 400)。
	 * If-Match 条件写:磁盘 mtime 已变(其他窗口/AI 已改)时 409,前端提示后重载。
	 */
	private async handlePutWorld(ctx: RouteContext): Promise<void> {
		const slug = this.options.sessionHost.getState().bookSlug;
		if (!slug) throw new HttpError(404, "not_found", "当前没有打开的书");
		const body = await readJsonBody(ctx.req);
		const raw = (body as Record<string, unknown> | null)?.["world"];
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
		const config = await mgr.listConfig();
		if (config.servers.some((s) => s.name === server.name)) {
			throw new HttpError(400, "bad_request", `MCP 服务器重名: ${server.name}`);
		}
		await mgr.upsertServer(server);
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
			await saveRawMcpConfig(mgr.getAgentDir(), text);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		await mgr.reload();
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
		const config = await mgr.listConfig();
		if (!config.servers.some((s) => s.name === name)) {
			throw new HttpError(404, "not_found", `MCP 服务器不存在: ${name}`);
		}
		await mgr.upsertServer(server);
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

	/** GET /api/writer/:slug?chapterFile=:编剧会话状态(纯读不创建会话;未装配 writerHost 时 404)。
	 *  chapterFile 可选:缺省用该书最近对话章节。 */
	private async handleGetWriter(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const chapterFile = ctx.url.searchParams.get("chapterFile");
		this.send(ctx.res, 200, await writer.state(ctx.params.slug!, chapterFile));
	}

	/**
	 * POST /api/writer/:slug/chat {text, chapterFile?}:发消息给编剧(惰性建会话,
	 * chapterFile 声明上下文注入的章节)。202 立即返回,消息/工具事件经 writer_event SSE 到达。
	 */
	private async handlePostWriterChat(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const text = requireString(body, "text");
		const args = body as Record<string, unknown>;
		const chapterFile = args.chapterFile === undefined ? undefined : requireString(body, "chapterFile");
		this.send(ctx.res, 202, { ok: true });
		void writer.chat(ctx.params.slug!, text, chapterFile).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			this.broadcast({ type: "writer_event", slug: ctx.params.slug!, event: { type: "chat_error", message } });
		});
	}

	/** POST /api/writer/:slug/abort:中止编剧当前生成(无会话时静默成功)。 */
	private async handlePostWriterAbort(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		await writer.abort(ctx.params.slug!);
		this.send(ctx.res, 200, { ok: true });
	}

	/**
	 * POST /api/writer/:slug/retract {entryId, replacement?, chapterFile?}:编剧会话
	 * 「编辑重发」——撤回最新一条用户消息及其后所有消息(leaf 回退,AI 上下文同步截断),
	 * replacement 存在时撤回后异步重发。chapterFile 缺省用该书最近对话章节。
	 * 广播 messages_retracted(与主会话同款,前端编剧会话重新对齐)。
	 */
	private async handlePostWriterRetract(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		const replacement = optionalString(body, "replacement");
		const args = body as Record<string, unknown>;
		const chapterFile = args.chapterFile === undefined ? undefined : requireString(body, "chapterFile");
		try {
			await writer.retractMessage(ctx.params.slug!, entryId, replacement, chapterFile);
		} catch (err) {
			// 未知 entry / 非 user 消息 / 非最新消息 / 流式中:业务性错误,映射 400
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
	}

	/** GET /api/writer/:slug/tree?chapterFile=:编剧会话分支树(切换 UI 数据;无会话返回空树,不创建)。 */
	private async handleGetWriterTree(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const chapterFile = ctx.url.searchParams.get("chapterFile");
		this.send(ctx.res, 200, await writer.getSessionTree(ctx.params.slug!, chapterFile));
	}

	/**
	 * POST /api/writer/:slug/navigate {entryId, chapterFile?}:编剧会话分支切换——leaf 移到
	 * 指定消息,以其为当前分支重建上下文;广播 messages_retracted(前端编剧会话重新对齐)。
	 */
	private async handlePostWriterNavigate(ctx: RouteContext): Promise<void> {
		const writer = this.options.writerHost;
		if (!writer) throw new HttpError(404, "not_found", "常驻编剧未启用");
		const body = await readJsonBody(ctx.req);
		const entryId = requireString(body, "entryId");
		const args = body as Record<string, unknown>;
		const chapterFile = args.chapterFile === undefined ? undefined : requireString(body, "chapterFile");
		try {
			await writer.navigate(ctx.params.slug!, entryId, chapterFile);
		} catch (err) {
			throw new HttpError(400, "bad_request", err instanceof Error ? err.message : String(err));
		}
		this.broadcast({ type: "messages_retracted" });
		this.send(ctx.res, 200, { ok: true });
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
		const matched = matchRoute(method, parts.slice(1), this.routes);
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
