/**
 * 前端 REST + SSE 客户端。默认同源相对路径:生产(server.cjs 同端口提供页面)、
 * Electron(loadURL 同源)与 vite dev(proxy /api → 8811)三种场景都走当前 origin,
 * 不依赖跨源(服务端无 CORS,绝对地址在 vite dev 下会被浏览器拦截)。
 * 注意:本文件不得在 import 时触碰 DOM 专属 API(EventSource 只在 subscribeEvents 内使用),
 * 以兼容 node 环境的 vitest 单测。
 */
import type { AgentEventDto, BookDetail, BookMeta, ChapterRef, McpServerInfo, McpServerStatus, ProviderInfo, SessionState, SessionTreeDto, StageSnapshotDto, StageWorldEditRecordDto, ThemeManifest, WorldDataDto, WriterStateDto } from "../types.ts";
import type { ConfirmCardItem } from "../components/ConfirmCard.tsx";

/** 图片访问 URL(同源相对路径;生产/Electron 同源,vite dev 经代理)。 */
export function imageUrl(slug: string, file: string): string {
	return `/api/books/${encodeURIComponent(slug)}/images/${encodeURIComponent(file)}`;
}

/** 带 HTTP 状态码的请求错误;非 2xx 时由 request()/直连 fetch 统一抛出。 */
export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

/** 非 2xx 响应 → ApiError:解析 `{ error: { message } }` 错误体,非 JSON 用默认消息。 */
async function apiErrorFrom(res: Response): Promise<ApiError> {
	let message = `HTTP ${res.status}`;
	try {
		const body = (await res.json()) as { error?: { message?: unknown } };
		if (typeof body?.error?.message === "string" && body.error.message.length > 0) message = body.error.message;
	} catch {
		/* 错误体不是 JSON:忽略,用默认消息 */
	}
	return new ApiError(res.status, message);
}

export class ApiClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string = "") {
		this.baseUrl = baseUrl;
	}

	/** 单请求超时(ms):防「vite proxy 持有已重启服务端的死 keep-alive 连接,请求挂起
	 *  永不返回」(2026-08-10 实测根因:8811 重启后,页面复用的旧连接静默失效,
	 *  fetch 挂起,预览卡等异步链路卡死)。超时后 GET 自动重试一次(新连接),POST 抛错。 */
	private static readonly REQUEST_TIMEOUT_MS = 12_000;

	/** 统一请求:非 ok 时解析 `{ error: { message } }` 错误体并 throw ApiError。 */
	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		try {
			return await this.fetchOnce<T>(path, init);
		} catch (e) {
			// 仅 GET 超时重试一次:未收到响应(挂起/死连接),重试走新连接安全;
			// POST 不重试(可能重复执行副作用,超时即报错)
			const method = init?.method ?? "GET";
			const timedOut = e instanceof DOMException && e.name === "TimeoutError";
			if (timedOut && method === "GET") {
				return await this.fetchOnce<T>(path, init);
			}
			throw e;
		}
	}

	private async fetchOnce<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...init?.headers },
			signal: AbortSignal.timeout(ApiClient.REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) throw await apiErrorFrom(res);
		return (await res.json()) as T;
	}

	/** 书列表。 */
	async getBooks(): Promise<BookMeta[]> {
		const r = await this.request<{ books: BookMeta[] }>("/api/books");
		return r.books;
	}

	/** 新建书。 */
	async createBook(title: string): Promise<BookDetail> {
		const r = await this.request<{ book: BookDetail }>("/api/books", { method: "POST", body: JSON.stringify({ title }) });
		return r.book;
	}

	/**
	 * 书详情。404 不静默吞掉:错误体("未找到"/"书不存在")由 request() 原样抛出,
	 * 由调用方决定如何呈现。
	 */
	async getBook(slug: string): Promise<BookDetail> {
		const r = await this.request<{ book: BookDetail }>(`/api/books/${encodeURIComponent(slug)}`);
		return r.book;
	}

	/**
	 * 导出整书为 zip 二进制。响应是 Blob 而非 JSON,不能走 request()(它强制
	 * json content-type 并 res.json()):直接 fetch,非 2xx 时解析错误体抛 ApiError。
	 */
	async exportBook(slug: string): Promise<Blob> {
		const res = await fetch(`${this.baseUrl}/api/books/${encodeURIComponent(slug)}/export`);
		if (!res.ok) throw await apiErrorFrom(res);
		return await res.blob();
	}

	/**
	 * 导入书 zip(multipart 字段 file)→ 新书详情。FormData 不能带手动 content-type
	 * 头(fetch 自动设 boundary),与 exportBook 一样单独 fetch,不污染通用 request()。
	 */
	async importBook(file: File): Promise<BookDetail> {
		const form = new FormData();
		form.append("file", file, file.name);
		const res = await fetch(`${this.baseUrl}/api/books/import`, { method: "POST", body: form });
		if (!res.ok) throw await apiErrorFrom(res);
		const r = (await res.json()) as { book: BookDetail };
		return r.book;
	}

	/** 上传图片到书目录 images/(multipart 字段 file);返回 { file: "images/xxx.png" }。 */
	async uploadImage(slug: string, file: File): Promise<{ file: string }> {
		const form = new FormData();
		form.append("file", file, file.name);
		const res = await fetch(`${this.baseUrl}/api/books/${encodeURIComponent(slug)}/images`, { method: "POST", body: form });
		if (!res.ok) throw await apiErrorFrom(res);
		return (await res.json()) as { file: string };
	}

	/** 删除书目录 images/ 下的图片文件(引用由调用方先移除)。 */
	async deleteImage(slug: string, file: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/books/${encodeURIComponent(slug)}/images/${encodeURIComponent(file)}`, { method: "DELETE" });
	}

	/** 删除整书(书目录与会话目录)。 */
	async deleteBook(slug: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/books/${encodeURIComponent(slug)}`, { method: "DELETE" });
	}

	/** 重命名整书(标题 → 新 slug,工作区/会话目录/索引整体迁移;当前书时服务端顺带迁移会话)。 */
	async renameBook(slug: string, title: string): Promise<BookDetail> {
		const r = await this.request<{ book: BookDetail }>(`/api/books/${encodeURIComponent(slug)}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		});
		return r.book;
	}

	/** 新增章节。 */
	async createChapter(slug: string, title: string): Promise<ChapterRef> {
		const r = await this.request<{ chapter: ChapterRef }>(`/api/books/${encodeURIComponent(slug)}/chapters`, {
			method: "POST",
			body: JSON.stringify({ title }),
		});
		return r.chapter;
	}

	/** 修改章节 title/label,返回更新后的书详情。 */
	async patchChapter(slug: string, id: string, patch: { title?: string; label?: string | null }): Promise<BookDetail> {
		const r = await this.request<{ book: BookDetail }>(`/api/books/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});
		return r.book;
	}

	/** 切换会话到指定章节文件。 */
	async switchSession(slug: string, chapterFile: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/books/${encodeURIComponent(slug)}/session`, {
			method: "POST",
			body: JSON.stringify({ chapterFile }),
		});
	}

	/**
	 * 当前会话状态快照;带 slug+chapterFile 时为只读拉取指定章节的会话消息
	 * (不切换服务端会话,用于查看模式/缓存预取)。
	 */
	async getSession(slug?: string, chapterFile?: string): Promise<SessionState> {
		const q = slug && chapterFile ? `?slug=${encodeURIComponent(slug)}&chapterFile=${encodeURIComponent(chapterFile)}` : "";
		return this.request<SessionState>(`/api/session${q}`);
	}

	/** 发送聊天消息(202 立即返回,结果走 SSE)。 */
	async sendChat(text: string): Promise<void> {
		await this.request<{ ok: boolean }>("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
	}

	/**
	 * 分支对话:从某条消息处开始新分支(该消息保留为起点,其后消息离开当前对话,
	 * 仍在会话文件中)。之后发送的消息 append 到该消息之下。
	 */
	async branchMessage(entryId: string): Promise<void> {
		await this.request<{ ok: boolean }>("/api/messages/branch", {
			method: "POST",
			body: JSON.stringify({ entryId }),
		});
	}

	/** 切换到任意分支上的消息(不限于当前链);分支栏来回切换的入口。 */
	async navigateMessage(entryId: string): Promise<void> {
		await this.request<{ ok: boolean }>("/api/messages/navigate", {
			method: "POST",
			body: JSON.stringify({ entryId }),
		});
	}

	/** 会话分支树概览(分支栏数据)。 */
	async getSessionTree(): Promise<SessionTreeDto> {
		return this.request<SessionTreeDto>("/api/session/tree");
	}

	/** 中止当前生成。 */
	async abort(): Promise<void> {
		await this.request<{ ok: boolean }>("/api/abort", { method: "POST" });
	}

	/** 模型列表、当前模型与思考等级(vendor 模型元素最小形状见 SettingsPage)。 */
	async getModels(): Promise<{ models: unknown[]; current: unknown; thinking: unknown }> {
		return this.request<{ models: unknown[]; current: unknown; thinking: unknown }>("/api/models");
	}

	/** 切换模型。 */
	async setModel(model: string): Promise<void> {
		await this.request<{ ok: boolean }>("/api/model", { method: "POST", body: JSON.stringify({ model }) });
	}

	/** 添加自定义模型(openai-completions 协议,如本地 mock LLM):写 models.json + 服务端热重载。 */
	async addCustomModel(opts: {
		provider: string;
		model: string;
		baseUrl: string;
		apiKey?: string;
		contextWindow?: number;
		maxTokens?: number;
	}): Promise<{ ok: boolean; provider: string; model: string }> {
		return this.request<{ ok: boolean; provider: string; model: string }>("/api/models/custom", {
			method: "POST",
			body: JSON.stringify(opts),
		});
	}

	/** 设置思考等级。 */
	async setThinking(level: string): Promise<void> {
		await this.request<{ ok: boolean }>("/api/thinking", { method: "POST", body: JSON.stringify({ level }) });
	}

	/** 全部 provider + 认证状态。 */
	async getProviders(): Promise<ProviderInfo[]> {
		const r = await this.request<{ providers: ProviderInfo[] }>("/api/providers");
		return r.providers;
	}

	/** 为 provider 写入 API key(失败抛 ApiError,含多提示/不支持等中文错误体)。 */
	async setProviderApiKey(id: string, key: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}/apikey`, {
			method: "POST",
			body: JSON.stringify({ key }),
		});
	}

	/** 移除 provider 凭据。 */
	async deleteProvider(id: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
	}

	/** MCP 服务器配置 + 连接状态。 */
	async getMcpServers(): Promise<{ servers: McpServerInfo[]; status: McpServerStatus[] }> {
		return this.request<{ servers: McpServerInfo[]; status: McpServerStatus[] }>("/api/mcp");
	}

	/** 新增 MCP 服务器(保存后服务端重连并重建会话,新工具即时生效)。 */
	async addMcpServer(server: McpServerInfo): Promise<{ servers: McpServerInfo[]; status: McpServerStatus[] }> {
		return this.request<{ servers: McpServerInfo[]; status: McpServerStatus[] }>("/api/mcp", {
			method: "POST",
			body: JSON.stringify(server),
		});
	}

	/** 更新 MCP 服务器(名称不可改;保存后同样重建会话)。 */
	async updateMcpServer(name: string, server: McpServerInfo): Promise<{ servers: McpServerInfo[]; status: McpServerStatus[] }> {
		return this.request<{ servers: McpServerInfo[]; status: McpServerStatus[] }>(`/api/mcp/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(server),
		});
	}

	/** 删除 MCP 服务器(保存后重建会话)。 */
	async deleteMcpServer(name: string): Promise<{ servers: McpServerInfo[]; status: McpServerStatus[] }> {
		return this.request<{ servers: McpServerInfo[]; status: McpServerStatus[] }>(`/api/mcp/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
	}

	/** 读取 mcp.json 原始文本(「直接编辑文件」预填;未配置时为空字符串)。 */
	async getMcpConfigRaw(): Promise<string> {
		const r = await this.request<{ text?: string }>("/api/mcp/raw");
		return r.text ?? "";
	}

	/** 原样保存 mcp.json 原始文本(校验后落盘并重连,支持 imports/mcpServers 形状)。 */
	async saveMcpConfigRaw(text: string): Promise<{ servers: McpServerInfo[]; status: McpServerStatus[] }> {
		return this.request<{ servers: McpServerInfo[]; status: McpServerStatus[] }>("/api/mcp/raw", {
			method: "PUT",
			body: JSON.stringify({ text }),
		});
	}

	/** 读取世界书(world.json);mtime 为磁盘文件时间戳(保存时作为 If-Match 条件写依据)。 */
	async getWorld(): Promise<{ world: WorldDataDto; mtime: number }> {
		const data = await this.request<{ world: WorldDataDto; mtime?: number }>("/api/world");
		return { world: data.world, mtime: data.mtime ?? 0 };
	}

	/**
	 * 整体保存世界书(校验由服务端执行);ifMatch 提供时做条件写:
	 * 磁盘 mtime 已变(其他窗口/AI 已改)→ 409 conflict。返回保存后的 mtime。
	 */
	async putWorld(world: WorldDataDto, ifMatch?: number): Promise<number> {
		const r = await this.request<{ ok: boolean; mtime?: number }>("/api/world", {
			method: "PUT",
			...(ifMatch !== undefined ? { headers: { "if-match": String(ifMatch) } } : {}),
			body: JSON.stringify({ world }),
		});
		return r.mtime ?? 0;
	}

	/**
	 * 读取草稿文本与磁盘 mtime;404(文件不存在)返回空串与 mtime 0。
	 * slug 可选:显式指定书(按显示书读写,避免与会话书错位);缺省按会话书。
	 */
	async getDraft(file: string, slug?: string): Promise<{ text: string; mtime: number }> {
		try {
			const q = new URLSearchParams({ file });
			if (slug) q.set("slug", slug);
			const r = await this.request<{ text: string; mtime?: number }>(`/api/draft?${q.toString()}`);
			return { text: r.text, mtime: r.mtime ?? 0 };
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) return { text: "", mtime: 0 };
			throw err;
		}
	}

	/**
	 * 写入草稿文本;slug 可选(同上)。ifMatch 提供时做条件写:
	 * 磁盘 mtime 已变 → 409 conflict(防本地旧文本覆盖 AI 新写)。返回保存后的 mtime。
	 */
	async putDraft(file: string, text: string, slug?: string, ifMatch?: number): Promise<number> {
		const r = await this.request<{ ok: boolean; mtime?: number }>("/api/draft", {
			method: "PUT",
			...(ifMatch !== undefined ? { headers: { "if-match": String(ifMatch) } } : {}),
			body: JSON.stringify({ file, text, ...(slug ? { slug } : {}) }),
		});
		return r.mtime ?? 0;
	}

	/** 编剧确认卡(按书+章节持久化;刷新/切章不丢,回退基线随卡保留)。 */
	async getConfirmCards(slug: string, chapterFile: string): Promise<ConfirmCardItem[]> {
		const q = new URLSearchParams({ slug, chapterFile });
		const r = await this.request<{ cards: ConfirmCardItem[] }>(`/api/confirm-cards?${q.toString()}`);
		return r.cards;
	}

	/** 编剧确认卡整体写(空数组删除文件)。失败静默由调用方决定(持久化失败不影响使用)。 */
	async putConfirmCards(slug: string, chapterFile: string, cards: ConfirmCardItem[]): Promise<void> {
		await this.request<{ ok: boolean }>("/api/confirm-cards", {
			method: "PUT",
			body: JSON.stringify({ slug, chapterFile, cards }),
		});
	}

	/** 主题清单(内置资产 + 用户自定义;文件 + 全文,设置页自动发现与编辑器用)。 */
	async getThemes(): Promise<ThemeManifest> {
		return this.request<ThemeManifest>("/api/themes");
	}

	/** 保存用户主题 CSS(新建或覆盖;file 含 .css)。 */
	async putUserTheme(file: string, css: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/themes/${encodeURIComponent(file)}`, {
			method: "PUT",
			body: JSON.stringify({ css }),
		});
	}

	/** 删除用户主题文件。 */
	async deleteUserTheme(file: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/themes/${encodeURIComponent(file)}`, { method: "DELETE" });
	}

	/** 舞台快照(纯读不创建编排器;未启用舞台区 404)。chapterFile 可选:舞台按章节隔离。 */
	async getStage(slug: string, chapterFile?: string | null): Promise<StageSnapshotDto> {
		const q = new URLSearchParams();
		if (chapterFile) q.set("chapterFile", chapterFile);
		const qs = q.toString();
		return this.request<StageSnapshotDto>(`/api/stage/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`);
	}

	/** 世界书编辑记录(world_update 工具写的 before/after 快照;无记录 → null)。 */
	async getStageLastWorldEdit(slug: string): Promise<StageWorldEditRecordDto | null> {
		try {
			return await this.request<StageWorldEditRecordDto>(`/api/stage/${encodeURIComponent(slug)}/last-world-edit`);
		} catch {
			return null;
		}
	}

	/**
	 * 舞台命令(与 CLI 命令面对齐):同步命令 200 { text }(即时文本结果,前端直接展示);
	 * 长命令(director/fix/cut,内部有模型回合)202,结果经 stage_done SSE 事件到达。
	 * 按 res.status 判别返回,无类型断言。chapterFile 可选:舞台按章节隔离。
	 */
	async stageCommand(
		slug: string,
		cmd: string,
		args: Record<string, unknown>,
		chapterFile?: string | null,
	): Promise<{ async: true } | { async: false; text: string }> {
		// confirm_script 同步阻塞(服务端内部跑一个导演回合,runTurn 兜底 10 分钟),
		// 需长超时;其余同步命令(next/auto/force/retry/revise/wrap/thoughts/mode)
		// 即时返回、长命令(director/fix/cut)202 即时返回,统一短超时防死连接挂起。
		const timeoutMs = cmd === "confirm_script" ? 600_000 : ApiClient.REQUEST_TIMEOUT_MS;
		const res = await fetch(`${this.baseUrl}/api/stage/${encodeURIComponent(slug)}/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cmd, ...args, ...(chapterFile ? { chapterFile } : {}) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw await apiErrorFrom(res);
		if (res.status === 202) return { async: true };
		const body = (await res.json()) as { text?: string };
		return { async: false, text: body.text ?? "" };
	}

	/**
	 * 订阅 SSE 事件流(EventSource 自带断线重连)。坏帧(非 JSON)忽略。
	 * onOpen 可选:连接建立或断线重连成功时回调(用于重拉服务端状态对齐本地)。
	 * 返回关闭函数。
	 */
	subscribeEvents(onEvent: (event: AgentEventDto) => void, onOpen?: () => void): () => void {
		return this.attachEventSource(onEvent, onOpen);
	}

	/** SSE 共享连接:全部订阅者复用同一 EventSource(引用计数,最后一个退订时关闭)。
	 *  舞台/编辑/世界书 4 页常驻各订阅一次,若各自开连接会占满浏览器同源连接池
	 *  (HTTP/1.1 6 条),EventSource 排队连不上 → 反复重连 → 每次 onopen 触发
	 *  全页对齐/重置,预览卡与对话被反复清空(2026-08-10 根因)。 */
	private eventSource: EventSource | null = null;
	private eventSourceHandlers: Array<{ onEvent: (event: AgentEventDto) => void; onOpen?: () => void }> = [];
	private attachEventSource(onEvent: (event: AgentEventDto) => void, onOpen?: () => void): () => void {
		const handler = { onEvent, onOpen };
		this.eventSourceHandlers.push(handler);
		if (!this.eventSource) {
			const es = new EventSource(`${this.baseUrl}/api/events`);
			this.eventSource = es;
			es.onmessage = (msg) => {
				let event: AgentEventDto;
				try {
					event = JSON.parse(msg.data) as AgentEventDto;
				} catch {
					return;
				}
				for (const h of this.eventSourceHandlers) h.onEvent(event);
			};
			es.onopen = () => {
				for (const h of this.eventSourceHandlers) h.onOpen?.();
			};
		}
		return () => {
			const i = this.eventSourceHandlers.indexOf(handler);
			if (i !== -1) this.eventSourceHandlers.splice(i, 1);
			if (this.eventSourceHandlers.length === 0 && this.eventSource) {
				this.eventSource.close();
				this.eventSource = null;
			}
		};
	}

	/** 常驻编剧会话状态(纯读;未对话过的章节返回空态,不创建会话)。
	 *  chapterFile 可选:缺省用该书最近对话章节。 */
	async getWriterState(slug: string, chapterFile?: string | null): Promise<WriterStateDto> {
		const q = new URLSearchParams();
		if (chapterFile) q.set("chapterFile", chapterFile);
		const qs = q.toString();
		return this.request<WriterStateDto>(`/api/writer/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`);
	}

	/** 发消息给编剧(202 立即返回,消息/工具事件经 writer_event SSE 到达)。 */
	async writerChat(slug: string, text: string, chapterFile?: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/writer/${encodeURIComponent(slug)}/chat`, {
			method: "POST",
			body: JSON.stringify({ text, ...(chapterFile ? { chapterFile } : {}) }),
		});
	}

	/** 中止编剧当前生成。 */
	async writerAbort(slug: string): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/writer/${encodeURIComponent(slug)}/abort`, { method: "POST" });
	}

	/** 编剧会话「编辑重发」:撤回最新用户消息(及之后),replacement 非空时撤回后重发。
	 *  chapterFile 声明归属章节(编剧对话按章节隔离)。 */
	async writerRetract(slug: string, entryId: string, replacement?: string, chapterFile?: string | null): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/writer/${encodeURIComponent(slug)}/retract`, {
			method: "POST",
			body: JSON.stringify({
				entryId,
				...(replacement ? { replacement } : {}),
				...(chapterFile ? { chapterFile } : {}),
			}),
		});
	}

	/** 编剧会话分支树(切换 UI 数据;按章节)。 */
	async writerTree(slug: string, chapterFile?: string | null): Promise<SessionTreeDto> {
		const q = new URLSearchParams();
		if (chapterFile) q.set("chapterFile", chapterFile);
		const qs = q.toString();
		return this.request<SessionTreeDto>(`/api/writer/${encodeURIComponent(slug)}/tree${qs ? `?${qs}` : ""}`);
	}

	/** 编剧会话分支切换(leafId);服务端重建上下文并广播,前端经 messages_retracted 对齐。 */
	async writerNavigate(slug: string, entryId: string, chapterFile?: string | null): Promise<void> {
		await this.request<{ ok: boolean }>(`/api/writer/${encodeURIComponent(slug)}/navigate`, {
			method: "POST",
			body: JSON.stringify({ entryId, ...(chapterFile ? { chapterFile } : {}) }),
		});
	}
}
