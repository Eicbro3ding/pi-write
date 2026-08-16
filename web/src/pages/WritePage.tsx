import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { initialSessionState, messagesToEvents, RESET, sessionReducer } from "../store.ts";
import type {
	AgentEventDto,
	BookDetail,
	ChapterRef,
	ContextUsageDto,
	DraftStatus,
	SessionTreeDto,
	TextSelectionSnapshot,
	WorldDataDto,
} from "../types.ts";
import { contextUsageHint } from "../context-usage.ts";
import {
	makeChapterCommand,
	makeCompactCommand,
	makeNodeCommand,
	type SlashCommand,
	type SlashContext,
} from "../slash-commands.ts";
import { BranchBar } from "../components/BranchBar.tsx";
import { ChapterSidebar } from "../components/ChapterSidebar.tsx";
import type { ConfirmCardItem } from "../components/ConfirmCard.tsx";
import { DraftWorkspace } from "../components/DraftWorkspace.tsx";
import { FullScreenEditor } from "../components/FullScreenEditor.tsx";
import { InputBar, type InputBarHandle } from "../components/InputBar.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { NoticeBoard } from "../components/NoticeBoard.tsx";
import { newId } from "../components/id.ts";
import { createEditCapture } from "../edit-capture.ts";
import type { Library } from "../library.ts";
import { DUR, EASE } from "../motion.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useDragResize } from "../use-drag-resize.ts";

/** 顶栏信息(由 App 顶栏展示)。 */
export interface HeaderInfo {
	bookTitle: string;
	/** 书 slug(顶栏展示书唯一标识,区分同名书)。 */
	bookSlug: string | null;
	chapterTitle: string | null;
	/** 保存状态文案("已保存" / "未保存" / "保存中" / "保存失败" / "加载中")。 */
	save: string;
	/** 草稿字数。 */
	words: number;
	/** 服务是否可连(仅初始化阶段拉书/开书失败时置 false,顶栏显示连接失败;发送等瞬时错误不影响)。 */
	connected: boolean;
}

/** 保存状态 → 顶栏文案(DraftStatus 联合穷举,tsc 校验缺项)。 */
const SAVE_LABELS: Record<DraftStatus, string> = {
	loading: "加载中",
	saved: "已保存",
	dirty: "未保存",
	saving: "保存中",
	"save-error": "保存失败",
};

/** 空书引导块:还没有任何书时,聊天区显示书名输入 + 创建按钮(替代「重启服务端」提示)。 */
function EmptyBooks({ onCreate }: { onCreate: (title: string) => void }) {
	const [title, setTitle] = useState("");
	const trimmed = title.trim();
	return (
		<div className="empty-books">
			<div className="empty-books-title">还没有书</div>
			<div className="empty-books-desc">创建第一本,开始写作</div>
			<div className="empty-books-form">
				<input
					className="empty-books-input"
					autoFocus
					placeholder="书名,如《雾港记事》"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && trimmed.length > 0) onCreate(trimmed);
					}}
				/>
				<button className="btn-send" disabled={trimmed.length === 0} onClick={() => onCreate(trimmed)}>
					创建
				</button>
			</div>
		</div>
	);
}

/**
 * 写作页装配:章节侧栏 + 正文 + AI 伙伴(编剧对话),宽屏三栏、窄屏抽屉。
 * 2026-08-10:批注功能退役并入编剧——选中正文自动预填编剧输入框(选区上下文),
 * 编辑走确认/免确认卡;主会话仅保留章节会话跟随与查看模式基础设施。
 * 书/章节切换通过现有 switchSession + RESET + 水合。
 */
export function WritePage({
	client,
	onHeader,
	library,
	simplifiedTools,
	autoConfirmEdits,
}: {
	client: ApiClient;
	onHeader?: (h: HeaderInfo) => void;
	/** 书库状态唯一真相源(App 持有,舞台页/编辑页共用——书库栏两页常驻且状态同步)。 */
	library: Library;
	/** 简化输出:隐藏工具调用卡片(设置页开关,缺省开启)。 */
	simplifiedTools: boolean;
	/** 编辑免确认:编剧编辑落盘即归档(设置页开关,缺省关闭 = 默认走待确认卡)。 */
	autoConfirmEdits: boolean;
}) {
	// 书库状态来自 App 级 useLibrary;以 React setState 同形别名接入,
	// 既有调用点(setBooks/setBookDetail/...)零改动,状态实际存于共享 hook
	const {
		books,
		bookDetail,
		currentChapter,
		busySlug,
		importing,
		sidebarWidth,
		sidebarCollapsed,
		setSidebarWidth,
		toggleSidebarCollapsed,
		memoTab,
		changeMemoTab,
		applyBookDetail,
		applyBooks,
		applyChapter,
		applyBusy,
		applyImporting,
		reportBookChange,
	} = library;
	const setBooks = applyBooks;
	const setBookDetail = applyBookDetail;
	const setCurrentChapter = applyChapter;
	const setBusySlug = applyBusy;
	const setImporting = applyImporting;
	const onBookChange = reportBookChange;
	const [error, setError] = useState<string | null>(null);
	/** AI 伙伴栏宽度(px,默认 380),左缘拖拽手柄调整(300–520)。 */
	const [companionWidth, setCompanionWidth] = useState(380);
	/** 全屏编辑器(设计 §5.4):非空时渲染覆盖层。 */
	const [fsEditor, setFsEditor] = useState<{ file: string; title: string } | null>(null);
	/** 服务端会话诊断(认证缺失等),type=error/warning 渲染为工作区顶部提示(设计 §4.3)。 */
	const [diags, setDiags] = useState<Array<{ type: string; message: string }>>([]);
	const [words, setWords] = useState(0);
	/** 顶栏字数节流(500ms 尾部合并,P1,2026-08):字数不是关键反馈,每键上报会让
	 *  App setHeader(新对象)触发四页全量重渲染;保存状态/书/章节变化不经此节流,
	 *  仍即时上报(下方 onHeader effect 依赖 saveLabel/bookDetail 等)。编辑器内
	 *  字数显示(DraftWorkspace 页脚)走自身 state,不受节流影响。 */
	const wordsTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pendingWordsRef = useRef(0);
	const throttledSetWords = useCallback((n: number) => {
		pendingWordsRef.current = n;
		if (wordsTimerRef.current) return; // 已有待发节流:仅更新末值
		wordsTimerRef.current = setTimeout(() => {
			wordsTimerRef.current = undefined;
			setWords(pendingWordsRef.current);
		}, 500);
	}, []);
	/** 正文保存状态(来自 DraftWorkspace 上报,映射为顶栏保存文案)。 */
	const [draftStatus, setDraftStatus] = useState<DraftStatus>("loading");
	/** 正文保存状态 ref(M18 脏守卫:handleRemoteSessionChange 经「只订阅一次」的
	 *  SSE 闭包调用,读 state 恒为首帧值,必须经 ref 取最新)。 */
	const draftStatusRef = useRef<DraftStatus>("loading");
	draftStatusRef.current = draftStatus;
	/** 顶栏连通性:与 error(瞬时/交互错误)分离,仅初始化阶段失败时置 false。 */
	const [connected, setConnected] = useState(true);
	/** 窄屏抽屉:书库栏 / AI 伙伴栏;只影响侧栏展示。 */
	const [mobileDrawer, setMobileDrawer] = useState<"chapters" | "companion" | null>(null);
	/** 窄屏(<900px)判定:书库/伙伴栏变抽屉。 */
	const isNarrow = useMediaQuery("(max-width: 900px)");
	/**
	 * 对齐串行队列(C 档保留骨架,2026-08):原为「RESET + 逐条追加」主会话水合串行
	 * 队列;主会话消息已无 UI、水合已删,现只承载 alignWithServer 的会话定位对齐,
	 * 且 messages_retracted 的编剧重对齐依赖其链尾时序(等主会话对齐完成后执行)。
	 */
	const hydrateQueueRef = useRef<Promise<void>>(Promise.resolve());
	/** 当前显示书/章节(供 session_changed 事件比对「是否自己发起的切换」)。 */
	const bookDetailRef = useRef<BookDetail | null>(null);
	bookDetailRef.current = bookDetail;
	const currentChapterRef = useRef<ChapterRef | null>(null);
	currentChapterRef.current = currentChapter;
	/**
	 * 会话代数:本地切章(openBook/selectChapter/newChapter/deleteBook)自增,外部
	 * session_changed 对齐也自增——过期的异步对齐(期间又发生了更新的操作)放弃应用。
	 */
	const sessionGenRef = useRef(0);
	/** 编剧(常驻编辑 agent)会话:与主会话同款 reducer(processAgentEvent 复用),
	 *  事件经 writer_event SSE 到达,消息/思考/工具卡片渲染零新逻辑。 */
	const [writerSession, writerDispatch] = useReducer(sessionReducer, undefined, initialSessionState);
	/** 编剧会话上下文占用(「建议 /compact」提示;agent_settled / 压缩结束 / 对齐时刷新)。 */
	const [writerUsage, setWriterUsage] = useState<ContextUsageDto | null>(null);
	const writerCompactingRef = useRef(false);
	writerCompactingRef.current = writerSession.compacting;
	/** `/node` 世界书缓存(按 slug;收到 world_changed 失效)。 */
	const worldCacheRef = useRef<{ slug: string; world: WorldDataDto } | null>(null);
	const worldLoadingRef = useRef<Promise<WorldDataDto | null> | null>(null);
	/** 编剧编辑确认队列(编剧对话流内):按书+章节持久化(刷新/切章不丢——
	 *  before 基线随卡保存,回退能力跨会话保留;免确认模式卡片为只读「已应用」)。 */
	const [confirmCards, setConfirmCards] = useState<ConfirmCardItem[]>([]);
	/** 确认卡恢复/写回按「书+章节」归属(confirmScopeRef),恢复完成前跳过持久化写,
	 *  防空数组覆盖;书/章节变化时先清本地卡再恢复,防止旧书卡片串入新书。 */
	const confirmScopeRef = useRef<string | null>(null);
	/** 确认卡恢复进行中标记:scope 变化触发 GET 恢复,恢复完成前跳过 PUT——
	 *  否则 setConfirmCards([]) 触发的重渲染会让 effect 走 PUT 分支,空数组先于
	 *  GET 完成落盘,覆盖服务端已持久化卡片(慢网络丢卡,2026-08-13)。 */
	const confirmRestoringRef = useRef(false);
	/** 已对齐过编剧会话的书 slug(切书/重连后重拉对齐;null = 未对齐)。 */
	const writerAlignedRef = useRef<string | null>(null);
	/** 编剧会话分支树(编辑重发产生新分支后,分支栏切换旧分支);空 = 无分支历史。 */
	const [writerTree, setWriterTree] = useState<SessionTreeDto | null>(null);
	/** 编剧会话最近一条 assistant 气泡 id(确认卡锚点);随 writerSession.messages 更新。 */
	const writerLastAssistantIdRef = useRef<string | null>(null);
	/** 编辑免确认(设置页开关):经 ref 供 SSE 订阅闭包读取最新值。 */
	const autoConfirmEditsRef = useRef(autoConfirmEdits);
	autoConfirmEditsRef.current = autoConfirmEdits;
	/** 编剧编辑捕获器(与舞台导演预览卡共用同一套 before/after 捕获与 diff 组装)。 */
	const writerCapture = useMemo(() => createEditCapture(client, () => bookDetailRef.current?.slug ?? null), [client]);

	/** 服务端当前会话位置(写操作前校验;与当前显示章节不一致即查看模式)。 */
	const serverSessionRef = useRef<{ slug: string; chapterFile: string } | null>(null);
	/** 查看模式标记:服务端会话 ≠ 当前查看章节(渲染顶部提示;写操作前切换)。 */
	const [viewingOther, setViewingOther] = useState(false);

	/** 编剧锚点维护:确认卡锚定「触发编辑的那条 assistant」——实时回合 id 为内存随机
	 *  id,message_end 后换成 entryId。 */
	useEffect(() => {
		const last = writerSession.messages.filter((m) => m.role === "assistant").at(-1);
		const id = last?.id ?? null;
		const entryId = last?.entryId;
		if (writerLastAssistantIdRef.current === id) return;
		writerLastAssistantIdRef.current = id;
		if (id !== null && entryId !== undefined && entryId !== id) {
			// 最后一条 assistant 已结束(拿到 entryId):把仍指向实时 id 的确认卡升级为 entryId
			setConfirmCards((prev) => {
				let changed = false;
				const next = prev.map((c) => {
					if (c.anchorId === id) {
						changed = true;
						return { ...c, anchorId: entryId };
					}
					return c;
				});
				return changed ? next : prev;
			});
		}
	}, [writerSession.messages]);

	/**
	 * 书/章节切换的统一清理:编剧会话 + 确认队列(编辑上下文已变;会话本体在
	 * 服务端,确认卡由服务端持久化,恢复标记置位后在章节就位时重新拉取)。
	 * 主会话无 UI,无需清理(C 档已删其 reducer 水合,2026-08)。
	 */
	function resetChat() {
		writerDispatch(RESET);
		setConfirmCards([]);
		setWriterTree(null);
		confirmScopeRef.current = null;
		writerCapture.clear();
		writerAlignedRef.current = null;
	}

	/** 确认卡持久化与恢复:按「书+章节」归属——书/章节变化(含未经 resetChat 的
	 *  路径,如舞台页 openBookData 直接 setBookDetail)先清本地卡并重新恢复,
	 *  恢复完成前跳过写回——否则旧书卡片会串入新书(2026-08-10 根因:the-old
	 *  创建瞬间收到 stage-demo2-4 的确认卡,打开后 diff 显示别书内容)。
	 *  恢复 GET 是异步快照,返回时可能与「恢复后新生成的卡」竞争:按 id 合并
	 *  (服务端卡 + 本地新卡),不覆盖本地。 */
	useEffect(() => {
		if (!bookDetail || !currentChapter) return;
		const scope = `${bookDetail.slug}:${currentChapter.file}`;
		if (confirmScopeRef.current !== scope) {
			confirmScopeRef.current = scope;
			confirmRestoringRef.current = true;
			setConfirmCards([]);
			void client
				.getConfirmCards(bookDetail.slug, currentChapter.file)
				.then((cards) => {
					if (confirmScopeRef.current !== scope) return; // 期间又切书:放弃
					setConfirmCards((prev) => {
						const ids = new Set(cards.map((c) => c.id));
						return [...cards, ...prev.filter((c) => !ids.has(c.id))];
					});
				})
				.catch(() => {
					/* 恢复失败静默:确认卡从空开始 */
				})
				.finally(() => {
					if (confirmScopeRef.current === scope) confirmRestoringRef.current = false;
				});
			return;
		}
		// 恢复进行中:跳过写回——setConfirmCards([]) 已触发重渲染,此时 PUT 空数组
		// 会先于 GET 完成覆盖服务端已持久化卡片(慢网络丢卡)
		if (confirmRestoringRef.current) return;
		const t = window.setTimeout(() => {
			void client
				.putConfirmCards(bookDetail.slug, currentChapter.file, confirmCards)
				.catch(() => {
					/* 网络/存储失败不影响使用 */
				});
		}, 300);
		return () => window.clearTimeout(t);
	}, [confirmCards, bookDetail, currentChapter]);

	/** 编剧会话对齐:拉服务端状态 → RESET + 逐条水合(与主会话 alignWithServer 同模式,
	 *  按「书+章节」对齐一次——编剧会话按章节隔离,切章后重新对齐;
	 *  切书/切章后 resetChat 置 writerAlignedRef=null 触发重新对齐)。 */
	function alignWriter() {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		const scope = `${slug}:${ch?.file ?? ""}`;
		if (writerAlignedRef.current === scope) return;
		writerAlignedRef.current = scope;
		client
			.getWriterState(slug, ch?.file ?? null)
			.then((st) => {
				if (writerAlignedRef.current !== scope) return; // 对齐期间又切书/切章:放弃
				writerDispatch(RESET);
				for (const ev of messagesToEvents(st.messages)) writerDispatch(ev);
				refreshWriterUsage();
			})
			.catch(() => {
				/* 对齐失败(服务暂不可用):保持本地状态 */
			});
		refreshWriterTree();
	}

	/** 编剧分支树刷新(对齐/编辑重发/分支切换后调用,更新分支栏;按章节)。 */
	function refreshWriterTree() {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		client
			.writerTree(slug, ch?.file ?? null)
			.then((tree) => {
				if (bookDetailRef.current?.slug !== slug) return; // 期间切书:放弃
				setWriterTree(tree);
			})
			.catch(() => {
				/* 拉取失败静默:分支栏不显示 */
			});
	}

	/** 编剧分支切换(分支栏):服务端 navigate 重建上下文并广播,前端经
	 *  messages_retracted 重新对齐(消息列表与分支树随之更新;按章节)。 */
	async function navigateWriter(leafId: string) {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		try {
			await client.writerNavigate(slug, leafId, ch?.file ?? null);
		} catch (err) {
			setError(`分支切换失败: ${friendlyError(err)}`);
		}
	}

	/** SSE 连接(onopen,含断线重连)后与服务端对齐:重拉会话状态,更新会话位置与诊断。
	 *  C 档(2026-08):主会话消息已无 UI,不再水合消息(dispatch 循环已删);
	 *  保留会话定位——查看模式(服务端流式中在别处)提示,与空闲时切回当前显示章节。 */
	function alignWithServer() {
		const prev = hydrateQueueRef.current;
		hydrateQueueRef.current = prev
			.then(async () => {
				const st = await client.getSession();
				setDiags(st.diagnostics.filter((d) => d.type === "error" || d.type === "warning"));
				serverSessionRef.current = { slug: st.bookSlug ?? "", chapterFile: st.chapterFile ?? "" };
				// 查看模式(服务端会话 != 当前查看章节):仅当服务端正在流式时查看
				// 才有意义(查看 = 不打断流式);服务端空闲时提示会滞留——agent_settled
				// 已发过、无事件触发自动切回(2026-08-10 根因:「没有 stream 却有提示」),
				// 直接切回当前显示章节。
				const cur = currentChapterRef.current;
				const serverOther = cur !== null && (st.bookSlug !== bookDetailRef.current?.slug || st.chapterFile !== cur.file);
				const viewingOther = serverOther && st.isStreaming === true;
				setViewingOther(viewingOther);
				if (viewingOther) return;
				// 服务端空闲但会话在别处:立即切回当前显示章节(会话定位,写操作前同款)
				if (serverOther) {
					await ensureServerSession();
					return;
				}
			})
			.catch(() => {
				/* 对齐失败(服务暂不可用):保持本地状态 */
			});
	}

	/**
	 * 写操作/对齐前确保服务端会话 == 当前显示章节(C 档简化:主会话消息无 UI,
	 * 不再水合历史/清缓存,只做会话定位)。代数防过期:切换期间用户又切了章节
	 * (代数自增)则放弃。
	 */
	async function ensureServerSession(): Promise<boolean> {
		// 全部经 ref 读取:本函数会被「只订阅一次」的 SSE effect(闭包停留在挂载渲染)
		// 调用,读 state 恒为 null;ref 始终指向最新值,任何调用点语义一致
		const book = bookDetailRef.current;
		const chapter = currentChapterRef.current;
		if (!book || !chapter) return false;
		const srv = serverSessionRef.current;
		if (srv && srv.slug === book.slug && srv.chapterFile === chapter.file) return true;
		const gen = sessionGenRef.current;
		try {
			await client.switchSession(book.slug, chapter.file);
			if (gen !== sessionGenRef.current) return false;
			serverSessionRef.current = { slug: book.slug, chapterFile: chapter.file };
			setViewingOther(false);
			// 等水合/对齐队列执行完(C 档:队列仍承载 alignWithServer 的会话定位
			// 对齐,无消息水合;保留骨架——messages_retracted 的编剧重对齐依赖其时序)
			await hydrateQueueRef.current;
			return true;
		} catch (e) {
			if (gen !== sessionGenRef.current) return false;
			setError(`切换章节失败: ${friendlyError(e)}`);
			return false;
		}
	}

	// SSE 订阅(EventSource 自带断线重连;onopen 时与服务端对齐会话位置与编剧会话)
	useEffect(() => {
		const unsub = client.subscribeEvents(
			(e) => {
				const start = e;
				// 其他浏览器切换章节:与当前显示章节不一致时,以服务端为准跟随/提示
				// (空闲跟随仅限同书,见 handleRemoteSessionChange 的 M18 守卫)
				if (start.type === "session_changed") {
					void handleRemoteSessionChange(start.bookSlug, start.chapterFile);
					return;
				}
				// 消息分支/编辑(本窗口或他窗口):编剧会话也可能被编辑(编辑重发),
				// 等主会话对齐完成后重新对齐编剧会话
				if (start.type === "messages_retracted") {
					alignWithServer();
					void hydrateQueueRef.current.then(() => {
						writerAlignedRef.current = null;
						alignWriter();
					});
					return;
				}
				// 世界书被 AI/他窗口修改:/node 命令缓存失效(下次打开命令面板重拉)
				if (start.type === "world_changed" && start.slug === bookDetailRef.current?.slug) {
					worldCacheRef.current = null;
					return;
				}
				// 服务端主会话流式结束:查看模式的唯一意义是「不打断流式」,流式已结束
				// 则自动把服务端会话切回当前显示章节,退出查看模式(顶部提示消失)
				if (start.type === "agent_settled") {
					const srv = serverSessionRef.current;
					const cur = currentChapterRef.current;
					const bookSlug = bookDetailRef.current?.slug;
					if (cur && srv && (srv.slug !== bookSlug || srv.chapterFile !== cur.file)) {
						void ensureServerSession();
					}
					return;
				}
				// 编剧事件(常驻编辑 agent):按当前书+章节过滤;工具 start/end 额外喂确认队列;
				// 会话事件复用主 reducer(writerDispatch),不触碰主会话(无 UI,C 档已删其水合)
				if (start.type === "writer_event") {
					if (start.slug !== bookDetailRef.current?.slug) return;
					// 编剧会话按章节隔离:只消费当前章节事件(切章后其他章节编剧
					// 流式不再串进本页;writer_event 携带 chapterFile 供过滤)
					if ((start.chapterFile ?? null) !== (currentChapterRef.current?.file ?? null)) return;
					const ev = start.event;
					if (ev.type === "message_start" && ev.message?.role === "user") {
						// 编剧回合开始:预取编辑前基线(工具执行快于 SSE+fetch 时,
						// start 的即时抓取会拿到编辑后内容——预取规避该竞态);
						// 按当前书解析,防跨书同名文件取错书
						const curCh = currentChapterRef.current;
						writerCapture.prefetchBaseline(
							curCh ? `draft/${curCh.file.replace(/\.jsonl$/, ".md")}` : null,
							bookDetailRef.current?.slug ?? null,
						);
					} else if (ev.type === "tool_execution_start") {
						handleWriterToolStart(ev);
					} else if (ev.type === "tool_execution_end") {
						void handleWriterToolEnd(ev);
					} else if (ev.type === "chat_error") {
						setError(`编剧出错: ${friendlyError(ev.message)}`);
					}
					writerDispatch(ev);
					// 回合结束 / 压缩结束后刷新上下文占用,「建议 /compact」提示才有依据
					if (ev.type === "agent_settled" || ev.type === "compaction_end") refreshWriterUsage();
					return;
				}
				// 主会话其余事件(message_start/update/end、tool_* 等)不再消费:
				// 编辑页对话渲染编剧会话,主会话消息无 UI(2026-08 C 档删 reducer 水合)
			},
			() => {
				alignWithServer();
				// 断线重连(含服务端重启)强制重新对齐编剧会话:alignWriter 的对齐守卫
				// (writerAlignedRef === scope 即跳过)会拦截重复对齐——必须先同步重置
				// 再对齐,否则重连后编剧状态永远停在旧快照(isStreaming 卡死、消息
				// 不回显,2026-08-10 根因)
				writerAlignedRef.current = null;
				alignWriter();
				refreshWriterUsage();
			},
		);
		return unsub;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client]);

	// 编剧会话对齐:书/章节就位后执行;切书/切章后 resetChat 置 writerAlignedRef=null,
	// bookDetail/currentChapter 变化触发重新对齐(编剧会话按章节隔离,切章必须重拉)
	useEffect(() => {
		if (bookDetail) alignWriter();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bookDetail, currentChapter]);

	// 初始化:拉书列表 → 打开第一本(服务端启动时已自动创建「未命名」与第一章)
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const list = await client.getBooks();
				if (cancelled) return;
				setBooks(list);
				if (list.length === 0) {
					// 空书引导:不设 error,聊天区显示「新建第一本书」引导块(见渲染处)
					onBookChange?.(null);
					return;
				}
				await openBook(list[0].slug);
			} catch (e) {
				if (!cancelled) {
					setError(`连接失败: ${friendlyError(e)}`);
					setConnected(false);
					onBookChange?.(null);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/**
	 * 其他浏览器切换章节(session_changed):服务端会话已变。若本窗口正查看该章节
	 * 则跟随对齐(原行为);若处于查看模式(服务端会话 != 当前查看章节),保持查看
	 * 不打断,只更新服务端会话位置与新会话章节的缓存。会话代数防过期:对齐期间
	 * 用户又做了本地切章(代数自增)则放弃。
	 */
	async function handleRemoteSessionChange(slug: string | null, chapterFile: string | null) {
		if (bookDetailRef.current?.slug === slug && currentChapterRef.current?.file === chapterFile) {
			// 服务端会话已切到当前显示章节(可能是本窗口正在查看的章节):结束查看模式
			serverSessionRef.current = { slug: slug ?? "", chapterFile: chapterFile ?? "" };
			setViewingOther(false);
			return;
		}
		const gen = ++sessionGenRef.current;
		try {
			const st = await client.getSession();
			if (gen !== sessionGenRef.current) return;
			serverSessionRef.current = { slug: st.bookSlug ?? "", chapterFile: st.chapterFile ?? "" };
			// 查看模式:其他窗口把服务端会话切到了别处,本窗口保持当前查看。
			// 仅当服务端正在流式时查看有意义(不打断);空闲时跟随服务端,
			// 不滞留「正在查看」提示(与 alignWithServer/selectChapter 同规则)
			const cur = currentChapterRef.current;
			if (cur !== null && st.isStreaming && (st.bookSlug !== bookDetailRef.current?.slug || st.chapterFile !== cur.file)) {
				setViewingOther(true);
				return;
			}
			setViewingOther(false);
			// M18 最小分支(2026-08 C 档):空闲跟随仅限同书——其他窗口把服务端会话
			// 切到别书时本窗口不跟随(避免劫持当前显示书、正文被切换覆盖);
			// 本窗口正文有未保存修改也不跟随(避免加载覆盖本地编辑)
			if (st.bookSlug !== bookDetailRef.current?.slug) return;
			if (draftStatusRef.current === "dirty") return;
			const detail = slug ? await client.getBook(slug) : null;
			if (gen !== sessionGenRef.current) return;
			setDiags(st.diagnostics.filter((d) => d.type === "error" || d.type === "warning"));
			if (!detail) {
				// 书已被删除:回到空状态(与 deleteBook 的空书分支一致)
				setBookDetail(null);
				setCurrentChapter(null);
				onBookChange?.(null);
				resetChat();
				return;
			}
			setBookDetail(detail);
			setBooks((prev) => prev.map((b) => (b.slug === detail.slug ? { ...b, chapters: detail.chapters.length } : b)));
			onBookChange?.(detail.slug);
			// 以服务端实际会话为准(事件后可能又有切换);章节不存在时退回第一章
			const ch = detail.chapters.find((c) => c.file === (st.chapterFile ?? chapterFile)) ?? detail.chapters[0] ?? null;
			setCurrentChapter(ch);
			resetChat();
		} catch (err) {
			if (gen !== sessionGenRef.current) return; // 过期失败:静默放弃(较新切换已接管)
			setError(`会话同步失败: ${friendlyError(err)}`);
		}
	}

	/** 打开书:以服务端当前会话章节为准;书或章节任一不一致都强制重建会话。
	 *  代数防过期:快速连续切书/切章时,过期链的响应(含 getSession 乱序)不得
	 *  覆盖较新的状态;catch 里过期失败静默放弃(不报错、不清书状态)。 */
	async function openBook(slug: string) {
		const gen = ++sessionGenRef.current;
		// 书/章节切换:先清理 workspace 的选区与批注,防止旧章节的批注进入新正文
		try {
			const st = await client.getSession();
			if (gen !== sessionGenRef.current) return;
			setDiags(st.diagnostics.filter((d) => d.type === "error" || d.type === "warning"));
			const detail = await client.getBook(slug);
			if (gen !== sessionGenRef.current) return;
			setBookDetail(detail);
			setBooks((prev) => prev.map((b) => (b.slug === slug ? { ...b, chapters: detail.chapters.length } : b)));
			onBookChange?.(detail.slug);
			const file = st.chapterFile ?? detail.currentChapterFile ?? detail.chapters[0]?.file ?? null;
			const ch = detail.chapters.find((c) => c.file === file) ?? detail.chapters[0] ?? null;
			if (gen !== sessionGenRef.current) return;
			setCurrentChapter(ch);
			resetChat();
			setError(null);
			setConnected(true);
			// 会话按「书 + 章节」双键判断:默认章节名恒为 ch01.jsonl,只比较 basename
			// 会漏掉跨书场景(会话仍在书 A 时点书 B 判定为「同一章节」),导致消息写入
			// 错误章节 —— 书 slug 不同必须强制 switchSession。
			const needSwitch = ch !== null && (ch.file !== st.chapterFile || st.bookSlug !== slug);
			if (needSwitch) {
				await client.switchSession(slug, ch.file);
				if (gen !== sessionGenRef.current) return;
			}
			// 会话就位后以其位置更新服务端会话标记(发生切换时旧快照已过期,必须重拉)
			const fresh = needSwitch ? await client.getSession() : st;
			if (gen !== sessionGenRef.current) return;
			serverSessionRef.current = { slug, chapterFile: fresh.chapterFile ?? ch?.file ?? "" };
			setViewingOther(false);
		} catch (e) {
			if (gen !== sessionGenRef.current) return; // 过期失败:静默放弃(较新切换已接管)
			setError(`打开书失败: ${friendlyError(e)}`);
			setConnected(false);
			onBookChange?.(null);
		}
	}

	/**
	 * 切换章节(C 档简化,2026-08):主会话消息已无 UI,缓存/水合链已删——只保留
	 * 会话定位:目标 != 服务端会话且服务端空闲 → 直接切服务端会话到本章;
	 * 服务端流式中在别处 → 查看模式提示(不打断流式),流式结束(agent_settled)
	 * 自动切回。代数防过期:快速连续切换时,先发起的只读拉取若慢于后发起的则放弃。
	 */
	async function selectChapter(ch: ChapterRef) {
		if (!bookDetail || ch.file === currentChapter?.file) return;
		const gen = ++sessionGenRef.current;
		const srv = serverSessionRef.current;
		const isServerSession = srv !== null && srv.slug === bookDetail.slug && srv.chapterFile === ch.file;
		setCurrentChapter(ch);
		resetChat();
		// 查看模式标记:目标章节 != 服务端会话则提示(不切服务端);相等即实时模式。
		// 服务端空闲(无 stream)时不进查看模式——查看 = 不打断流式,空闲时直接切
		// 服务端会话(实时),避免「正在查看」提示滞留(agent_settled 已发过、无事件
		// 触发自动切回,2026-08-10 根因:「没有 stream 却有提示」)。
		if (!isServerSession) {
			try {
				const st = await client.getSession();
				if (gen !== sessionGenRef.current) return;
				serverSessionRef.current = { slug: st.bookSlug ?? "", chapterFile: st.chapterFile ?? "" };
				if (st.bookSlug === bookDetail.slug && st.chapterFile === ch.file) {
					// 等待期间服务端已切到本章:实时模式,无需再切
					setViewingOther(false);
					return;
				}
				if (!st.isStreaming) {
					// 空闲:直接切服务端会话到本章(实时模式,不留查看提示)。
					// ensureServerSession 内部 resetChat 会清掉 alignWriter 刚水合的
					// 编剧对话(effect 已触发、拉取可能已完成)——补一次对齐,
					// 否则切章后编剧对话永久空白(2026-08-10 竞态)
					await ensureServerSession();
					alignWriter();
					return;
				}
				// 服务端正在流式:查看模式(不打断;流式结束后 agent_settled 自动切回)
				setViewingOther(true);
			} catch (e) {
				if (gen !== sessionGenRef.current) return;
				setError(`章节加载失败: ${friendlyError(e)}`);
				return;
			}
		} else {
			setViewingOther(false);
		}
	}

	/** 新建章节:创建 → 切换到新章节。代数防过期与 selectChapter 同。 */
	async function newChapter() {
		if (!bookDetail) return;
		const gen = ++sessionGenRef.current;
		try {
			const ch = await client.createChapter(bookDetail.slug, `第${bookDetail.chapters.length + 1}章`);
			if (gen !== sessionGenRef.current) return;
			await client.switchSession(bookDetail.slug, ch.file);
			if (gen !== sessionGenRef.current) return;
			resetChat();
			const detail = await client.getBook(bookDetail.slug);
			if (gen !== sessionGenRef.current) return;
			setBookDetail(detail);
			setCurrentChapter(ch);
			// 主动切换:服务端会话已就位,更新位置标记
			serverSessionRef.current = { slug: bookDetail.slug, chapterFile: ch.file };
			setViewingOther(false);
		} catch (e) {
			if (gen !== sessionGenRef.current) return; // 过期失败:静默放弃
			setError(`新建章节失败: ${friendlyError(e)}`);
		}
	}

	/** 新建书:创建 → 打开新书(openBook 负责会话切换与历史水合)。 */
	async function newBook(title: string) {
		try {
			const book = await client.createBook(title);
			setBooks((prev) => [...prev, { slug: book.slug, title: book.title, chapters: book.chapters.length, updatedAt: Date.now() }]);
			await openBook(book.slug);
		} catch (e) {
			setError(`新建书失败: ${friendlyError(e)}`);
		}
	}

	/** 切换书(多书场景):以该书当前章节打开。 */
	async function selectBook(slug: string) {
		if (slug === bookDetail?.slug) return;
		await openBook(slug);
	}

	/** 导出书:与书库栏共用实现(blob → Android 分享桥 → a[download] 回退),失败显示错误。 */
	async function exportBook(slug: string) {
		try {
			await library.exportBook(slug);
		} catch (e) {
			setError(`导出失败: ${friendlyError(e)}`);
		}
	}

	/** 删除书:成功后若删的是当前书,自动打开另一本(或回空书引导)。 */
	async function deleteBook(slug: string) {
		setBusySlug(slug);
		try {
			await client.deleteBook(slug);
			const remaining = books.filter((b) => b.slug !== slug);
			setBooks(remaining);
				if (slug === bookDetail?.slug) {
					if (remaining.length > 0) await openBook(remaining[0]!.slug);
					else {
						sessionGenRef.current++;
						serverSessionRef.current = null;
						setViewingOther(false);
						setBookDetail(null);
						setCurrentChapter(null);
						resetChat();
						onBookChange?.(null);
						setError(null); // 回空书引导:清掉旧错误提示,避免残留
					}
				} else {
				// 刷新当前书详情(章节数等不变,可跳过);若删除的书在列表中,列表已更新
			}
		} catch (e) {
			setError(`删除失败: ${friendlyError(e)}`);
		} finally {
			setBusySlug(null);
		}
	}

	/** 重命名书:成功后刷新列表;当前书重命名时 slug 已变,重新打开新 slug(服务端已迁移会话)。 */
	async function renameBook(slug: string, title: string) {
		setBusySlug(slug);
		try {
			const book = await client.renameBook(slug, title);
			setBooks(await client.getBooks());
			if (slug === bookDetail?.slug) {
				// 当前书:服务端把会话切到了新路径,openBook 按会话对齐(无需再次 switchSession)
				await openBook(book.slug);
			}
		} catch (e) {
			setError(`重命名失败: ${friendlyError(e)}`);
		} finally {
			setBusySlug(null);
		}
	}

	/** 重命名章节(仅 title/label,会话文件不变):刷新书详情,当前章节同步更新标题。 */
	async function renameChapter(ch: ChapterRef, title: string) {
		if (!bookDetail) return;
		try {
			const detail = await client.patchChapter(bookDetail.slug, ch.id, { title });
			setBookDetail(detail);
			setBooks((prev) => prev.map((b) => (b.slug === detail.slug ? { ...b, chapters: detail.chapters.length } : b)));
			if (currentChapter?.id === ch.id) {
				setCurrentChapter(detail.chapters.find((c) => c.id === ch.id) ?? currentChapter);
			}
		} catch (e) {
			setError(`重命名章节失败: ${friendlyError(e)}`);
		}
	}

	/** 导入书:上传 → 打开新导入的书;slug 冲突时展示副本提示。 */
	async function importBook(file: File) {
		setImporting(true);
		try {
			const book = await client.importBook(file);
			const conflict = book.slug.includes("-import-");
			setBooks(await client.getBooks());
			await openBook(book.slug);
			if (conflict) setError(`slug 已存在,已导入为副本 ${book.slug}`);
		} catch (e) {
			setError(`导入失败: ${friendlyError(e)}`);
		} finally {
			setImporting(false);
		}
	}

	/** 编剧编辑工具 start/end:经共享捕获器(writerCapture)抓 before、组装 diff,出确认卡。
	 *  与舞台导演预览卡同一套捕获逻辑,页面层只保留「确认卡」状态容器与锚点。 */
	function handleWriterToolStart(e: Extract<AgentEventDto, { type: "tool_execution_start" }>) {
		writerCapture.handleStart(e.toolCallId, e.toolName, e.args);
	}

	/**
	 * 编剧编辑工具 end:经共享捕获器(writerCapture)组装 diff 出确认卡。
	 * scope 守卫:handleEnd 是异步的(await 取数),期间切书/切章时丢弃旧 scope 的
	 * 卡片——否则旧书/旧章卡片会 append 进新 scope 的确认队列并被持久化
	 * (2026-08 修复,与恢复路径的 confirmScopeRef 归属同规则)。
	 */
	async function handleWriterToolEnd(e: Extract<AgentEventDto, { type: "tool_execution_end" }>) {
		const scope = `${bookDetailRef.current?.slug ?? ""}:${currentChapterRef.current?.file ?? ""}`;
		const edit = await writerCapture.handleEnd(e.toolCallId, e.isError);
		if (!edit) return; // 失败/非编辑工具/无实质变化:不弹卡
		if (`${bookDetailRef.current?.slug ?? ""}:${currentChapterRef.current?.file ?? ""}` !== scope) return; // 期间切书/切章:丢弃
		// 锚点:触发编辑的那条 assistant(工具必在其回合内执行,消息已 start)
		const anchorId = writerLastAssistantIdRef.current ?? null;
		const card: ConfirmCardItem = {
			id: newId("confirm"),
			kind: edit.kind,
			path: edit.path,
			before: edit.before,
			anchorId,
			// 免确认模式(设置页):编辑落盘即归档,卡片只读展示「已应用」
			auto: autoConfirmEditsRef.current,
			data: edit.data,
		};
		setConfirmCards((prev) => [...prev, card]);
	}

	/** 确认编辑:归档删卡(文件已落盘,无需写回)。 */
	function confirmCard(id: string) {
		setConfirmCards((prev) => prev.filter((c) => c.id !== id));
	}

	/** 回退编辑:把编辑前状态写回(草稿 PUT before 文本;世界书 PUT before world)。 */
	async function revertCard(id: string) {
		const card = confirmCards.find((c) => c.id === id);
		if (!card) return;
		try {
			// 回退按发起书 slug 写入,避免写到当前会话书。
			const slug = bookDetailRef.current?.slug ?? undefined;
			if (card.kind === "draft" && card.path && typeof card.before === "string") {
				await client.putDraft(card.path, card.before, slug);
			} else if (card.kind === "world" && typeof card.before !== "string") {
				await client.putWorld(card.before, undefined, slug);
			}
			setConfirmCards((prev) => prev.filter((c) => c.id !== id));
		} catch (err) {
			setError(`回退失败: ${friendlyError(err)}`);
		}
	}

	/** `/node` 世界书懒加载 + 按书缓存(SSE world_changed 时失效)。 */
	function loadWorldForSlash(): Promise<WorldDataDto | null> {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return Promise.resolve(null);
		const cached = worldCacheRef.current;
		if (cached?.slug === slug) return Promise.resolve(cached.world);
		if (worldLoadingRef.current) return worldLoadingRef.current;
		const p = client
			.getWorld(slug)
			.then(({ world }) => {
				worldCacheRef.current = { slug, world };
				return world;
			})
			.catch(() => null)
			.finally(() => {
				worldLoadingRef.current = null;
			});
		worldLoadingRef.current = p;
		return p;
	}

	/** 拉取编剧会话上下文占用(静默失败:提示是优化,不打断使用)。 */
	function refreshWriterUsage() {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		const ch = currentChapterRef.current;
		void client
			.writerContext(slug, ch?.file ?? null)
			.then((usage) => {
				// 期间切书/切章:丢弃过期快照
				if (bookDetailRef.current?.slug === slug && currentChapterRef.current?.file === ch?.file) {
					setWriterUsage(usage);
				}
			})
			.catch(() => {});
	}

	/** `/compact` 动作:手动压缩编剧当前章节上下文(压缩事件经 writer_event 驱动 UI)。 */
	async function runWriterCompact(instructions: string) {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		if (writerCompactingRef.current) return;
		try {
			await client.writerCompact(slug, currentChapterRef.current?.file ?? null, instructions || undefined);
			refreshWriterUsage();
		} catch (err) {
			setError(`压缩上下文失败: ${friendlyError(err)}`);
		}
	}

	/** 编剧输入框的 `/` 命令集(插件注册缝的初始内置实现)。 */
	const writerSlashContext: SlashContext = {
		client,
		slug: bookDetail?.slug ?? null,
		bookDetail,
		currentChapterFile: currentChapter?.file ?? null,
	};
	const writerSlashCommands: SlashCommand[] = [
		makeNodeCommand({ loadWorld: loadWorldForSlash }),
		makeChapterCommand(),
		makeCompactCommand({ run: runWriterCompact }),
	];

	/** 发送给编剧(常驻编辑 agent):202 即返回,流式/工具事件走 writer_event SSE;
	 *  用户消息回显经 SSE 到达,无需乐观气泡。 */
	function sendWriter(text: string) {
		const slug = bookDetailRef.current?.slug;
		if (!slug || writerSession.isStreaming || writerSession.compacting) return;
		void client
			.writerChat(slug, text, currentChapterRef.current?.file ?? undefined)
			.catch((err) => setError(`发送失败: ${friendlyError(err)}`));
	}

	/** 编剧消息「编辑重发」:撤回该用户消息(及之后)并以新文本重发(服务端 retract +
	 *  sendMessage;messages_retracted 广播后编剧会话重新对齐;按章节定位会话)。 */
	async function editWriterMessage(m: { id: string; entryId?: string }, newText: string) {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug || m.entryId === undefined) return;
		try {
			await client.writerRetract(slug, m.entryId, newText, ch?.file ?? null);
		} catch (err) {
			setError(`编辑重发失败: ${friendlyError(err)}`);
		}
	}

	/** AI 伙伴栏左缘拖拽调宽:鼠标左移变宽(伙伴栏在右侧,手柄贴左缘),受限于 [300, 520](useDragResize)。 */
	const onCompanionResizeStart = useDragResize({
		min: 300,
		max: 520,
		dir: -1,
		getValue: () => companionWidth,
		onChange: setCompanionWidth,
	});

	/** 打开全屏编辑器(默认当前章节草稿)。 */
	function openEditor() {
		if (!currentChapter) return;
		setFsEditor({
			file: `draft/${currentChapter.file.replace(/\.jsonl$/, ".md")}`,
			title: `${bookDetail ? `《${bookDetail.title}》` : ""}${currentChapter.title ? ` · ${currentChapter.title}` : ""} · 全屏编辑`,
		});
	}

	// Alt+E 打开全屏编辑器(与 TUI /edit 的入口语义对齐)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.altKey && e.key.toLowerCase() === "e") {
				e.preventDefault();
				openEditorRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// openEditor 依赖 currentChapter/bookDetail,经 ref 取最新
	const openEditorRef = useRef(openEditor);
	openEditorRef.current = openEditor;

	/** 编剧输入框句柄(选中文本自动填入)。 */
	const writerInputRef = useRef<InputBarHandle>(null);

	/** 选区同步(编剧「选中文本自动填入」):选中实际文本且编剧输入框为空时,
	 *  预填选区上下文(文件 + 选中文本 + 请求前缀),用户接着补充请求即可发送;
	 *  输入框非空不覆盖(不打断正在输入的请求)。 */
	function handleSelectionChange(sel: TextSelectionSnapshot | null) {
		if (!sel || sel.from === sel.to || sel.text.trim().length === 0) return;
		const fileLabel = sel.file.replace(/^draft\//, "");
		writerInputRef.current?.prefillIfEmpty(`(选中 ${fileLabel} 的「${sel.text}」)请帮我处理这段——`);
	}

	const draftFile = currentChapter ? `draft/${currentChapter.file.replace(/\.jsonl$/, ".md")}` : "draft/ch01.md";
	const saveLabel = SAVE_LABELS[draftStatus];
	/** 上下文占用达到阈值时,输入框上方的「建议 /compact」提示。 */
	const writerUsageHint = contextUsageHint(writerUsage);
	// 临时诊断:渲染时反映 previewCards/confirmCards 长度(读 title 即可观察 state)

	// 顶栏信息上报
	useEffect(() => {
		onHeader?.({
			bookTitle: bookDetail?.title ?? "未命名",
			bookSlug: bookDetail?.slug ?? null,
			chapterTitle: currentChapter?.title ?? null,
			save: saveLabel,
			words,
			connected,
		});
	}, [bookDetail, currentChapter, saveLabel, words, connected, onHeader]);

	return (
		// 三栏壳:书库(轨 1 auto,宽度由 ChapterSidebar 决定并随折叠/拖拽动画)
		// | 纸张 | AI 伙伴(轨 3 经 --companion-w 跟随左缘拖拽调宽);窄屏断点见 styles.css
		<div
			className="writing-workspace-shell"
			style={{ "--companion-w": `${companionWidth}px` } as React.CSSProperties}
		>
			<ChapterSidebar
				books={books}
				slug={bookDetail?.slug ?? null}
				chapters={bookDetail?.chapters ?? []}
				currentFile={currentChapter?.file ?? null}
				onSelectChapter={(ch) => void selectChapter(ch)}
				onNewChapter={() => void newChapter()}
				onSelectBook={(s) => void selectBook(s)}
				onNewBook={(t) => void newBook(t)}
				onExportBook={(s) => void exportBook(s)}
				onRenameBook={(s, t) => void renameBook(s, t)}
				onDeleteBook={(s) => void deleteBook(s)}
				onImportBook={(f) => void importBook(f)}
				onRenameChapter={(c, t) => void renameChapter(c, t)}
				importing={importing}
				busySlug={busySlug}
				width={sidebarWidth}
				onResize={setSidebarWidth}
				collapsed={sidebarCollapsed}
				onToggleCollapse={toggleSidebarCollapsed}
				drawerOpen={mobileDrawer === "chapters"}
				onClose={() => setMobileDrawer(null)}
			/>
			<section className="paper-zone">
				{/* 服务端诊断(认证缺失等):error 红色、warning 琥珀,渲染在纸张顶部(设计 §4.3) */}
				{diags.map((d, i) => (
					<div key={i} className={d.type === "error" ? "notice err" : "notice warn"}>
						{d.message}
					</div>
				))}
				{/* 查看模式提示(方案 D):当前查看章节 ≠ 服务端会话;发送消息将切换到该章节 */}
				{viewingOther && currentChapter && (
					<div className="notice warn">
						正在查看{bookDetail ? `《${bookDetail.title}》` : ""}
						{currentChapter.title ? ` · ${currentChapter.title}` : ""} · 发送消息将切换到该章节
					</div>
				)}
				{error && (
					<div className="notice err">
						<span>{error}</span>
					</div>
				)}
				{books.length === 0 && !currentChapter ? (
					<EmptyBooks onCreate={(title) => void newBook(title)} />
				) : (
					<>
						{/* 纸张头部:章节名大字 + 移动端书库/伙伴抽屉开关 + 全屏编辑入口 */}
						<div className="paper-head">
							<button
								type="button"
								className="ws-drawer-toggle"
								aria-label={mobileDrawer === "chapters" ? "关闭书库" : "打开书库"}
								onClick={() => setMobileDrawer((d) => (d === "chapters" ? null : "chapters"))}
							>
								书库
							</button>
							<div className="paper-title-wrap">
								<div className="paper-title">{currentChapter?.title ?? "草稿"}</div>
								<div className="paper-title-sub">{draftFile}</div>
							</div>
							<button
								type="button"
								className="ws-drawer-toggle"
								aria-label={mobileDrawer === "companion" ? "关闭 AI 伙伴" : "打开 AI 伙伴"}
								onClick={() => setMobileDrawer((d) => (d === "companion" ? null : "companion"))}
							>
								伙伴
							</button>
							{currentChapter && (
								<button className="paper-fs" onClick={openEditor} title="Alt+E">
									全屏编辑
								</button>
							)}
						</div>
						{/* 纸张:正文编辑器常驻挂载(不再 hidden),文字/选区/保存状态/自动保存定时器全部保留 */}
						<div className="paper-surface">
							<DraftWorkspace
								client={client}
								slug={bookDetail?.slug ?? null}
								file={draftFile}
								chapterFile={currentChapter?.file ?? ""}
								title={currentChapter?.title ?? "草稿"}
								headerless
								onWordCount={throttledSetWords}
								onStatusChange={setDraftStatus}
								onSelectionChange={handleSelectionChange}
							/>
						</div>
					</>
				)}
			</section>
			{/* AI 伙伴:编剧对话单栏(批注 2026-08-10 退役并入编剧);宽屏常驻右栏,窄屏右侧抽屉 */}
			<>
				<AnimatePresence>
					{isNarrow && mobileDrawer === "companion" && (
						<motion.div
							key="companion-mask"
							className="drawer-mask"
							aria-hidden="true"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: DUR.base, ease: EASE.out }}
							onClick={() => setMobileDrawer(null)}
						/>
					)}
				</AnimatePresence>
				<motion.aside
					className={mobileDrawer === "companion" ? "companion drawer-open" : "companion"}
					aria-label="AI 伙伴"
					initial={false}
					animate={!isNarrow || mobileDrawer === "companion" ? "open" : "closed"}
					variants={{
						open: { x: 0, opacity: 1, visibility: "visible" },
						closed: { x: "100%", opacity: 0, transitionEnd: { visibility: "hidden" } },
					}}
					transition={{ duration: DUR.slow, ease: EASE.out }}
				>
					{/* 左缘拖拽调宽手柄(窄屏抽屉模式隐藏) */}
					{!isNarrow && <div className="comp-resize" onMouseDown={onCompanionResizeStart} title="拖拽调整宽度" />}
					<div className="companion-head">
						<span className="companion-label">AI 伙伴</span>
						{/* 标签:编剧对话 | 备忘录(全局 Notice 待办板,2026-08-12 从书库栏移来);
						    外观与舞台页 st-tabs 分段控件同款(data-active 驱动滑动指示器) */}
						<div className="c-tabs" role="tablist" data-active={memoTab === "memo" ? "1" : "0"}>
							<button type="button" className={memoTab === "chat" ? "c-tab active" : "c-tab"} onClick={() => changeMemoTab("chat")}>
								编剧
							</button>
							<button type="button" className={memoTab === "memo" ? "c-tab active" : "c-tab"} onClick={() => changeMemoTab("memo")}>
								备忘录
							</button>
						</div>
						{/* 待确认编辑数(免确认模式下恒为 0)与生成指示灯只属于编剧对话 */}
						{memoTab === "chat" && confirmCards.filter((c) => !c.auto).length > 0 && (
							<span className="companion-badge">{confirmCards.filter((c) => !c.auto).length}</span>
						)}
						{memoTab === "chat" && writerSession.isStreaming && <span className="companion-live" title="生成中" aria-label="生成中" />}
					</div>
					<div className="companion-body">
							{memoTab === "memo" ? (
								<NoticeBoard client={client} slug={bookDetail?.slug ?? null} />
							) : (
						<div className="chat active">
							{/* 编剧(常驻编辑 agent)对话:会话状态经 processAgentEvent 维护,
							   MessageList/InputBar 原样复用;确认卡锚定在触发编辑的 assistant 消息下;
							   选中正文会自动预填选区上下文(见 handleSelectionChange)。
							   分支栏:编辑重发产生新分支后在此切换旧分支(重发即分支)。 */}
							<BranchBar
								branches={writerTree?.branches ?? []}
								currentLeafId={writerTree?.currentLeafId ?? null}
								streaming={writerSession.isStreaming}
								onNavigate={(leafId) => void navigateWriter(leafId)}
							/>
							<MessageList
								messages={writerSession.messages}
								streaming={writerSession.isStreaming}
								compacting={writerSession.compacting}
								simplifiedTools={simplifiedTools}
								confirmCards={confirmCards}
								onConfirmCard={confirmCard}
								onRevertCard={(id) => void revertCard(id)}
								onEdit={(m, newText) => void editWriterMessage(m, newText)}
								emptyText="向编剧发一句话,讨论行文、取舍与节奏——修改正文会生成待确认卡,可随时回退;选中正文会自动填入选区"
							/>
							{writerUsageHint && (
								<div className={`notice ${writerUsageHint.tone}`} role="status">
									{writerUsageHint.text}
								</div>
							)}
							<InputBar
								ref={writerInputRef}
								streaming={writerSession.isStreaming}
								onSend={sendWriter}
								onAbort={() => {
									const s = bookDetailRef.current?.slug;
									if (s) void client.writerAbort(s);
								}}
								placeholder="向编剧说话…(/ 命令面板;选中正文自动填入,Ctrl+Enter 发送,Enter 换行)"
								ariaLabel="向编剧说话"
								commands={writerSlashCommands}
								context={writerSlashContext}
								onCommandError={(msg) => setError(`命令失败: ${msg}`)}
							/>
						</div>
						)}
					</div>
				</motion.aside>
			</>
			{/* 全屏编辑器覆盖层(设计 §5.4) */}
			{fsEditor && (
				<FullScreenEditor
					client={client}
					slug={bookDetail?.slug ?? null}
					initialFile={fsEditor.file}
					title={fsEditor.title}
					onClose={() => setFsEditor(null)}
				/>
			)}
		</div>
	);
}
