import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { bookFileUrl, imageUrl, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { initialSessionState, messagesToEvents, RESET, sessionReducer } from "../store.ts";
import { blocksText } from "../blocks.ts";
import type {
	AgentEventDto,
	BookDetail,
	BookFileEntryDto,
	ChapterRef,
	ChatMessage,
	ContextUsageDto,
	ConversationDto,
	ConversationScopeDto,
	DraftStatus,
	InspectReportDto,
	SessionTreeDto,
	SessionUsageStatsDto,
	TextSelectionSnapshot,
	TrimSummaryDto,
	WorldDataDto,
} from "../types.ts";
import {
	acceptsWriterEvent,
	currentConversationId,
	nextConversationAfterDelete,
	writerAlignKey,
	writerTarget,
} from "../writer-scope.ts";
import { contextUsageHint, formatCacheHit } from "../context-usage.ts";
import {
	makeChapterCommand,
	makeCompactCommand,
	makeNodeCommand,
	makePluginCommand,
	makeSkillCommand,
	worldEntryInsertText,
	type SlashCommand,
	type SlashContext,
} from "../slash-commands.ts";
import { ChapterSidebar } from "../components/ChapterSidebar.tsx";
import { ConversationSwitcher } from "../components/ConversationSwitcher.tsx";
import { IconEdit } from "../components/Icons.tsx";
import type { ConfirmCardItem } from "../components/ConfirmCard.tsx";
import { DraftWorkspace } from "../components/DraftWorkspace.tsx";
import { ExportPanel, type ExportChapterRef } from "../components/ExportPanel.tsx";
import { FilePreview } from "../components/FilePreview.tsx";
import { FullScreenEditor } from "../components/FullScreenEditor.tsx";
import { InputBar, type InputBarHandle } from "../components/InputBar.tsx";
import { UsagePanel } from "../components/UsagePanel.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { AskUserOverlay } from "../components/AskUserCard.tsx";
import type { EnterBehavior } from "../settings.ts";
import { findPendingAsk } from "../ask-user.ts";
import { NoticeBoard } from "../components/NoticeBoard.tsx";
import { ContextInspectPanel } from "../components/ContextInspectPanel.tsx";
import { WorkspacePanel } from "../components/WorkspacePanel.tsx";
import { newId } from "../components/id.ts";
import { createEditCapture } from "../edit-capture.ts";
import { isLegacyConfirmCard, parseToolArgs, pathFromArgs } from "../preview.ts";
import type { Library } from "../library.ts";
import { DUR, EASE } from "../motion.ts";
import { useExitPresence } from "../use-exit-presence.ts";
import { useMediaQuery, useIsPhone } from "../useMediaQuery.ts";
import { useDragResize } from "../use-drag-resize.ts";
import { Lu } from "../components/Lu.tsx";
import { MobileHeader } from "../components/MobileHeader.tsx";

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

/** 右栏标签顺序(切换方向按它比较;与舞台右栏 StagePanel 的 TAB_INDEX 同一套做法)。 */
const MEMO_TAB_INDEX: Record<"chat" | "memo", number> = { chat: 0, memo: 1 };

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
			<div className="empty-books-desc">创建第一本，开始写作</div>
			<div className="empty-books-form">
				<input
					className="empty-books-input"
					autoFocus
					placeholder="书名，如《雾港记事》"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && trimmed.length > 0) onCreate(trimmed);
					}}
				/>
				<button className="btn-primary" disabled={trimmed.length === 0} onClick={() => onCreate(trimmed)}>
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
 *
 * classicMode(2026-09-18,单 agent):页面结构不变,只是——服务端这个会话已经是
 * 带全量工具的写作 agent(不是受限编剧),界面去掉「编剧」这个身份标签,免得
 * 用户以为旁边还有别人。舞台页在经典模式下不渲染(见 App);世界书页照常。
 *
 * conversationScope(2026-10-03,对话与章节的关系):`"chapter"`(缺省)下**本页行为
 * 与改动前逐字节一致** —— 章节即会话,切章节即切对话,界面多一个入口都不加;
 * `"book"` 下对话与章节解绑,伙伴栏头部多一个对话切换器,**切章节不切对话**。
 * 两处的分叉都收敛在 `web/src/writer-scope.ts` 的纯函数与 ref 上(SSE 订阅闭包
 * 只订阅一次,读 state 恒为首帧值,所以模式与选中对话一律经 ref 取最新)。
 */
export function WritePage({
	client,
	onHeader,
	library,
	debug,
	enterBehavior,
	autoConfirmEdits,
	classicMode,
	conversationScope,
	onOpenSettings,
	nav,
}: {
	client: ApiClient;
	onHeader?: (h: HeaderInfo) => void;
	/** 书库状态唯一真相源(App 持有,舞台页/编辑页共用——书库栏两页常驻且状态同步)。 */
	library: Library;
	/** 简化输出:隐藏工具调用卡片(设置页开关,缺省开启)。 */
	debug: boolean;
	/** 回车行为(设置页开关):send = 回车即发送,newline = 回车换行(缺省)。 */
	enterBehavior: EnterBehavior;
	/** 编辑免确认:编剧编辑落盘即归档(设置页开关,缺省关闭 = 默认走待确认卡)。 */
	autoConfirmEdits: boolean;
	/** 经典模式(单 agent):AI 是带全量工具的写作 agent,标签与文案不再称「编剧」。 */
	classicMode: boolean;
	/** 对话与章节的关系(chapter 缺省 = 一节一段对话;book = 对话与章节各聊各的)。 */
	conversationScope: ConversationScopeDto;
	/** 打开设置页(报错卡的「去设置模型 ›」;App 提供,缺省不画该入口)。 */
	onOpenSettings?: () => void;
	/** 手机端抽屉主导航:当前页与切页回调(App 提供;手机端顶栏下线后入口收进抽屉)。 */
	nav?: { view: string; onNavigate: (view: string) => void };
}) {
	// 书库状态来自 App 级 useLibrary;以 React setState 同形别名接入,
	// 既有调用点(setBooks/setBookDetail/...)零改动,状态实际存于共享 hook
	const {
		books,
		booksLoaded,
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
	/** AI 伙伴栏宽度(px,默认 340),左缘拖拽手柄调整(300–520)。 */
	const [companionWidth, setCompanionWidth] = useState(340);
	/** 伙伴栏拖拽调宽中:关掉宽度过渡,保持跟手(与书库栏 .resizing 同款)。 */
	const [companionResizing, setCompanionResizing] = useState(false);
	/** AI 伙伴栏收起态(48px 竖条):localStorage 持久化,与左栏折叠同一套语言。 */
	const [companionCollapsed, setCompanionCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem("pi-writer:companion-collapsed") === "1";
		} catch {
			return false;
		}
	});
	const toggleCompanionCollapsed = useCallback(() => {
		setCompanionCollapsed((v) => {
			const next = !v;
			try {
				localStorage.setItem("pi-writer:companion-collapsed", next ? "1" : "0");
			} catch {
				/* 隐私模式下 localStorage 不可用:本次会话内仍然生效 */
			}
			return next;
		});
	}, []);
	/** 全屏编辑器(设计 §5.4):非空时渲染覆盖层。 */
	const [fsEditor, setFsEditor] = useState<{ file: string; title: string } | null>(null);
	/** 左栏内容模式:章节(默认)/ 工作区(书目录文件清单)。 */
	const [railMode, setRailMode] = useState<"chapters" | "workspace">("chapters");
	/** 工作区文件预览(非空时在纸张区渲染只读覆盖层)。 */
	const [filePreview, setFilePreview] = useState<BookFileEntryDto | null>(null);
	/**
	 * 本会话 agent 碰过的文件路径台账(工作区的「AI 过得」标记)。
	 * 前端内存态:来源是 writer_event 的 tool_execution_start 参数里的 path,
	 * 刷新/换窗口即空——要跨刷新保留就得在服务端落写入台账(2026-09-18 未做)。
	 */
	const [aiTouched, setAiTouched] = useState<ReadonlySet<string>>(() => new Set());
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
	/** 手机端(≤700px)判定:换 52px 页头 + 底部常驻输入条。 */
	const isPhone = useIsPhone();
	/** 手机端页头 ⋯ 菜单是否展开。 */
	const [phoneMenu, setPhoneMenu] = useState(false);
	/** 手机端整屏导出页是否打开。 */
	const [phoneExport, setPhoneExport] = useState(false);
	/** 整屏导出页的容器:受控模式下 ExportPanel 靠它判断「点面板外关闭」。 */
	const phoneExportRef = useRef<HTMLDivElement>(null);
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
	/** 最近一次装配的裁切摘要(2026-10-04,T4);null = 未裁切,不显示提示条。 */
	const [writerTrim, setWriterTrim] = useState<TrimSummaryDto | null>(null);
	/** 上下文检视报告(T5,2026-10-04):展开面板时才拉,不在每次 /context 轮询里顺带取 —— 
	 *  它比 usage/trim 重(含分段与设置项),而用户绝大多数时候不看。 */
	const [inspectReport, setInspectReport] = useState<InspectReportDto | null>(null);
	const [inspectOpen, setInspectOpen] = useState(false);
	const [inspectLoading, setInspectLoading] = useState(false);
	/** 会话用量浮层(点输入条的上下文圆环展开):开合 / 数据 / 载入中 / 错误。 */
	const [usageOpen, setUsageOpen] = useState(false);
	const [usageStats, setUsageStats] = useState<SessionUsageStatsDto | null>(null);
	const [usageBusy, setUsageBusy] = useState(false);
	const [usageErr, setUsageErr] = useState<string | null>(null);
	const writerCompactingRef = useRef(false);
	writerCompactingRef.current = writerSession.compacting;
	/** 编剧会话快照 ref:报错卡的「重试」要从 memo 化的卡片里出发(见 MessageList 的
	 *  retryRef 说明),只能读 ref 拿「是否仍在流式」——直接闭包 writerSession 会在卡片
	 *  不重渲染时读到旧值。重试**重放哪一句**不再从这里取:它绑在报错卡自己的
	 *  `retry` 字段上(2026-10 审计 BUG-014,见 retryWriterTurn)。 */
	const writerSessionRef = useRef(writerSession);
	writerSessionRef.current = writerSession;
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
	/**
	 * 对话与章节的关系:SSE 订阅闭包只订阅一次,读 prop 会拿到首帧值 ——
	 * 判定一律经这个 ref(与 draftStatusRef / currentChapterRef 同款)。
	 */
	const conversationScopeRef = useRef(conversationScope);
	conversationScopeRef.current = conversationScope;
	/** book 模式的对话清单(按 mtime 倒序;chapter 模式恒为空,不拉也不用)。 */
	const [conversations, setConversations] = useState<ConversationDto[]>([]);
	/** 当前选中的对话 id;chapter 模式恒为 null。 */
	const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
	/**
	 * 选中对话的 ref —— **必须与 state 同时写**(只写 state 会让 SSE 过滤 / 对齐键
	 * 在读 ref 的地方慢一拍:切完对话立刻到的事件会被判成别的对话而丢掉)。
	 * 唯一写入口是 applySelectedConversation。
	 */
	const selectedConversationRef = useRef<string | null>(null);
	/** 新建 / 删除对话请求进行中(切换器入口禁用,避免连点)。 */
	const [conversationBusy, setConversationBusy] = useState(false);
	/** 同上,但用于「同步」防重入:自动新建(空清单)与手动新建可能同时发起。 */
	const conversationBusyRef = useRef(false);
	/** 编剧会话分支树(编辑重发产生新分支后,分支栏切换旧分支);空 = 无分支历史。 */
	const [writerTree, setWriterTree] = useState<SessionTreeDto | null>(null);
	/** 编辑免确认(设置页开关):经 ref 供 SSE 订阅闭包读取最新值。 */
	const autoConfirmEditsRef = useRef(autoConfirmEdits);
	autoConfirmEditsRef.current = autoConfirmEdits;
	/** 编剧编辑捕获器(与舞台导演预览卡共用同一套 before/after 捕获与 diff 组装)。 */
	const writerCapture = useMemo(() => createEditCapture(client, () => bookDetailRef.current?.slug ?? null), [client]);

	/** 服务端当前会话位置(写操作前校验;与当前显示章节不一致即查看模式)。 */
	const serverSessionRef = useRef<{ slug: string; chapterFile: string } | null>(null);
	/** 查看模式标记:服务端会话 ≠ 当前查看章节(渲染顶部提示;写操作前切换)。 */
	const [viewingOther, setViewingOther] = useState(false);

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
		// 换书/换章后旧文件预览已不属当前上下文:关掉(避免看的是别书的 notes)
		setFilePreview(null);
	}

	/**
	 * 选中对话的**唯一写入口**(state + ref 一起写;只写一半会让 SSE 过滤与对齐键
	 * 读到上一段对话的 id)。chapter 模式恒传 null。
	 */
	function applySelectedConversation(id: string | null) {
		selectedConversationRef.current = id;
		setSelectedConversationId(id);
	}

	/**
	 * 换书时的编剧清理:会话状态 + 对话清单 + 选中对话一起清。
	 * (对话按书隔离:新书的清单还没拉回来之前,绝不能拿旧书的 id 去定位。)
	 */
	function resetWriterForBook() {
		resetChat();
		setConversations([]);
		applySelectedConversation(null);
	}

	/**
	 * 换**章节**时的清理。chapter 模式:章节即会话 → 走完整的 resetChat(与改动前一致);
	 * book 模式:对话不跟着章节走 —— 消息与会话本体留着(要清的只有本章的编辑捕获基线,
	 * 卡片队列由下面那个按「书+章节」归属的 effect 自己重新恢复),否则切一章就把
	 * 整段对话清空、看起来像「对话丢了」。
	 */
	function resetWriterForChapter() {
		if (conversationScopeRef.current === "book") {
			writerCapture.clear();
			setFilePreview(null);
			return;
		}
		resetChat();
	}

	/**
	 * 本次 writer 请求的定位参数(唯一出处)。chapter 模式只有 chapterFile
	 * (= 会话身份,与改动前逐字节一致);book 模式额外带 conversation(身份),
	 * chapterFile 仍照传 —— 它决定注入哪一章的正文。
	 */
	function writerTargetNow(chapterFile: string | null) {
		return writerTarget(conversationScopeRef.current, chapterFile, selectedConversationRef.current);
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
						// 旧形状(改造前用 anchorId 锚定消息)无法反推工具调用 id,认领不到工具块
						// → 丢弃:文件已落盘,只是确认/回退入口不再提供(2026-09-19)
						const usable = cards.filter((c) => !isLegacyConfirmCard(c));
						const ids = new Set(usable.map((c) => c.id));
						return [...usable, ...prev.filter((c) => !ids.has(c.id))];
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
	 *  按「书+对话」对齐一次 —— chapter 模式对话即章节,切章后重新对齐;
	 *  切书/切章后 resetChat 置 writerAlignedRef=null 触发重新对齐)。 */
	function alignWriter() {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		// book 模式的对话清单还没就位:此刻对齐会落到服务端的「当前对话」上(未必是
		// 用户上次选的那段),等清单回来再对齐 —— 否则首屏先闪一段别的对话再跳。
		if (conversationScopeRef.current === "book" && selectedConversationRef.current === null) return;
		const scope = writerAlignKey(conversationScopeRef.current, slug, ch?.file ?? null, selectedConversationRef.current);
		if (writerAlignedRef.current === scope) return;
		writerAlignedRef.current = scope;
		const run = (attempt: number): void => {
			const t = writerTargetNow(ch?.file ?? null);
			client
				.getWriterState(slug, t.chapterFile, t.conversation)
				.then((st) => {
					if (writerAlignedRef.current !== scope) return; // 对齐期间又切书/切章/切对话:放弃
					writerDispatch(RESET);
					for (const ev of messagesToEvents(st.messages)) writerDispatch(ev);
					refreshWriterUsage(true);
				})
				.catch(() => {
					/*
					 * 对齐失败(服务刚重启 / 网络瞬断)。2026-09-23 修:此前 catch 是空的、
					 * 而标记在发请求前就置好了 —— 守卫会拦住之后**所有**同 scope 的对齐,
					 * 于是编剧对话永久空白(既没有历史也没有报错),只有一次断线重连的
					 * onOpen 才能救回来。现在退避重试一次,仍失败则把标记放回去留给下次触发。
					 */
					if (writerAlignedRef.current !== scope) return;
					if (attempt >= 2) {
						writerAlignedRef.current = null;
						return;
					}
					window.setTimeout(() => run(attempt + 1), 1200);
				});
		};
		run(1);
		refreshWriterTree();
	}

	/**
	 * 拉该书的对话清单(book 模式;chapter 模式直接不拉 —— 章节侧栏就是切换器)。
	 * 选中规则:本地已选且仍在列表里就保留;否则用服务端登记的当前对话(isCurrent,
	 * 服务端在没登记时已把最近更新的一条标为 true),列表空则自动新建一段
	 * (首屏总得有个落脚点,否则用户面对一个选不中任何对话的输入条)。
	 */
	async function loadConversations(): Promise<void> {
		const slug = bookDetailRef.current?.slug;
		if (!slug || conversationScopeRef.current !== "book") return;
		try {
			const list = await client.getConversations(slug);
			if (bookDetailRef.current?.slug !== slug || conversationScopeRef.current !== "book") return;
			if (list.length === 0) {
				await createConversation();
				return;
			}
			setConversations(list);
			const keep = selectedConversationRef.current && list.some((c) => c.id === selectedConversationRef.current)
				? selectedConversationRef.current
				: currentConversationId(list);
			if (keep !== selectedConversationRef.current) applySelectedConversation(keep);
		} catch {
			/* 拉取失败:切换器空态;对话本身照常(缺省落服务端当前对话) */
		}
	}

	/**
	 * 切换对话:与「切章节」走**同一套水合路径** —— 清本地会话态 → resetChat 置
	 * writerAlignedRef=null → alignWriter 重拉 state/tree/context(不另写一套)。
	 * 选中态必须**同步**写进 ref:紧随其后到达的 SSE 帧要靠它判定归属。
	 */
	function selectConversation(id: string) {
		if (id === selectedConversationRef.current) return;
		applySelectedConversation(id);
		resetChat();
		alignWriter();
	}

	/** 新建一段对话(服务端 201 返回新对话 + 最新清单,一次请求即可刷新并选中)。 */
	async function createConversation(): Promise<void> {
		const slug = bookDetailRef.current?.slug;
		if (!slug || conversationBusyRef.current) return;
		conversationBusyRef.current = true;
		setConversationBusy(true);
		try {
			const r = await client.createConversation(slug);
			if (bookDetailRef.current?.slug !== slug || conversationScopeRef.current !== "book") return;
			setConversations(r.conversations);
			applySelectedConversation(r.conversation.id);
			resetChat();
			alignWriter();
		} catch (e) {
			setError(`新建对话失败: ${friendlyError(e)}`);
		} finally {
			conversationBusyRef.current = false;
			setConversationBusy(false);
		}
	}

	/**
	 * 删除一段对话。**不允许出现「选中一条已删除对话」的死状态**:删掉的是当前对话
	 * 就落到清单里的第一条,清单空了就自动新建一段。
	 */
	async function deleteConversation(id: string): Promise<void> {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		setError(null);
		try {
			await client.deleteConversation(slug, id);
		} catch (e) {
			setError(`删除对话失败: ${friendlyError(e)}`);
			return;
		}
		if (bookDetailRef.current?.slug !== slug || conversationScopeRef.current !== "book") return;
		try {
			const list = await client.getConversations(slug);
			if (bookDetailRef.current?.slug !== slug || conversationScopeRef.current !== "book") return;
			setConversations(list);
			if (list.some((c) => c.id === selectedConversationRef.current)) return; // 删的不是当前对话
			const next = nextConversationAfterDelete(list, id);
			if (next === null) {
				await createConversation();
				return;
			}
			applySelectedConversation(next);
			resetChat();
			alignWriter();
		} catch (e) {
			setError(`刷新对话清单失败: ${friendlyError(e)}`);
		}
	}

	/** 编剧分支树刷新(对齐/编辑重发/分支切换后调用,更新分支栏;按章节/对话)。 */
	function refreshWriterTree() {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		const t = writerTargetNow(ch?.file ?? null);
		client
			.writerTree(slug, t.chapterFile, t.conversation)
			.then((tree) => {
				if (bookDetailRef.current?.slug !== slug) return; // 期间切书:放弃
				setWriterTree(tree);
			})
			.catch(() => {
				/* 拉取失败静默:分支栏不显示 */
			});
	}

	/** 编剧分支切换(分支栏):服务端 navigate 重建上下文并广播,前端经
	 *  messages_retracted 重新对齐(消息列表与分支树随之更新;按章节/对话)。 */
	async function navigateWriter(leafId: string) {
		const slug = bookDetailRef.current?.slug;
		const ch = currentChapterRef.current;
		if (!slug) return;
		const t = writerTargetNow(ch?.file ?? null);
		try {
			await client.writerNavigate(slug, leafId, t.chapterFile, t.conversation);
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
					// 事件归属:chapter 模式按章节文件过滤(与改动前逐字节同规则);
					// book 模式的帧不带章节(chapterFile 恒为 null)、改带 conversation,
					// 照旧按 chapterFile 判定会把编剧事件**全部丢掉**。判定收敛在
					// writer-scope.ts 的 acceptsWriterEvent(可单测),这里只取最新选中态。
					if (!acceptsWriterEvent(start, selectedConversationRef.current, currentChapterRef.current?.file ?? null)) return;
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
					}
					// chat_error 不再在这里吞成一条横幅 + friendlyError 的一句话:
					// reducer 会把它落成对话流里的报错卡(原文照实,见 chat-error.ts),
					// 位置就在失败那一轮的用户消息之后(需求 1)
					writerDispatch(ev);
					// 回合结束 / 压缩结束后刷新上下文占用,「建议 /compact」提示才有依据
					if (ev.type === "agent_settled" || ev.type === "compaction_end") refreshWriterUsage();
					// 回合结束后会话树也会变(编辑重发落下新分支;运行时追加的配置 entry
					// 还会让 leaf 前移)—— 分支栏与消息版本地图(「‹ n / N ›」)据此刷新,
					// 否则新产生的版本要等到下次对齐才出现
					if (ev.type === "agent_settled") refreshWriterTree();
					// 回合结束后对话标题/时间会变(标题取自第一条用户消息):重拉清单,
					// 切换器里的「新对话」才会变成用户真正说的那句话
					if (ev.type === "agent_settled") void loadConversations();
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
				// 重连后对话清单可能也过期了(他窗口新建/删除):book 模式下先重拉再对齐
				void loadConversations();
				alignWriter();
				refreshWriterUsage(true);
			},
		);
		return unsub;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client]);

	/**
	 * 关系模式切换(设置页 / 首启向导 / 其他窗口的 settings_changed):两种模式的
	 * 会话身份语义不同,旧状态一律作废 —— 清空对话清单与选中态 + resetChat,
	 * 随后由下面两个 effect 重新拉清单并对齐。
	 * 声明在「对齐 / 拉清单」两个 effect **之前**:effect 按声明顺序跑,先清后拉,
	 * 切模式时不会拿着上一模式的选中 id 去对齐一次。
	 */
	useEffect(() => {
		setConversations([]);
		applySelectedConversation(null);
		resetChat();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationScope]);

	// 编剧会话对齐:书/章节/选中对话就位后执行;切书/切章后 resetChat 置
	// writerAlignedRef=null,变化触发重新对齐(chapter 模式切章必须重拉;
	// book 模式的对齐键只认对话,切章节不重拉 —— 见 writerAlignKey)
	useEffect(() => {
		if (bookDetail) alignWriter();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bookDetail, currentChapter, selectedConversationId, conversationScope]);

	// 对话清单(book 模式;chapter 模式不拉也不用):换书、换模式时重拉,
	// 选中对话由 loadConversations 依「本地选中仍在列表中 → 否则 isCurrent」决定
	useEffect(() => {
		if (bookDetail) void loadConversations();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bookDetail, conversationScope]);

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
				resetWriterForBook();
				return;
			}
			setBookDetail(detail);
			setBooks((prev) => prev.map((b) => (b.slug === detail.slug ? { ...b, chapters: detail.chapters.length } : b)));
			onBookChange?.(detail.slug);
			// 以服务端实际会话为准(事件后可能又有切换);章节不存在时退回第一章
			const ch = detail.chapters.find((c) => c.file === (st.chapterFile ?? chapterFile)) ?? detail.chapters[0] ?? null;
			setCurrentChapter(ch);
			// 同书换章节:book 模式下对话不跟着章节走(见 resetWriterForChapter)
			resetWriterForChapter();
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
			// 换书:编剧会话/对话清单/选中对话都按书隔离,整体清掉重来
			resetWriterForBook();
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
		resetWriterForChapter();
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

	/**
	 * 工作区点草稿条目:切回「章节」模式并选中该章。
	 * 草稿不在工作区里开只读预览——编辑页本来就是它的编辑器(见 WorkspacePanel 注释)。
	 * chapterId("ch01")→ 章节 file("ch01.jsonl")由 bookDetail 映射,映射不到就提示。
	 */
	function openChapterFromWorkspace(chapterId: string) {
		const ch = (bookDetailRef.current?.chapters ?? []).find((c) => c.id === chapterId);
		if (!ch) {
			setError(`章节不存在: ${chapterId}`);
			return;
		}
		setRailMode("chapters");
		void selectChapter(ch);
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
			resetWriterForChapter();
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

	/**
	 * 导出面板的取数。
	 *
	 * 章节正文走 client.getDraft —— 与 `@` 菜单的章节引用**同一条路径**,导出看到的
	 * 正文和引用进来的是同一份;世界书附录复用 loadWorldForSlash 的按书缓存。
	 * 路径换算留在这里,ExportPanel 只认「章节对象 → 文本」这一件事。
	 */
	async function loadExportChapterText(ch: ExportChapterRef): Promise<string> {
		const file = `draft/${ch.file.replace(/\.jsonl$/, ".md")}`;
		const { text } = await client.getDraft(file, bookDetailRef.current?.slug ?? undefined);
		return text;
	}

	/** 世界书附录:条目原文逐条拼(与 @ 菜单引用条目时的注入块同款)。 */
	async function loadExportAppendix(): Promise<{ text: string; count: number } | null> {
		const world = await loadWorldForSlash();
		if (!world || world.entries.length === 0) return null;
		return {
			text: world.entries.map((e) => worldEntryInsertText(e)).join("\n\n"),
			count: world.entries.length,
		};
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
						resetWriterForBook();
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
			if (conflict) setError(`slug 已存在，已导入为副本 ${book.slug}`);
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
		// 工作区台账:agent 这次工具动了哪个文件(带 path 参数的工具才有)。
		// 只记路径不记工具名——面板要回答的是「哪些文件被动过」,不是「怎么动的」。
		const path = pathFromArgs(parseToolArgs(e.args));
		if (path) setAiTouched((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
	}

	/**
	 * 编剧编辑工具 end:经共享捕获器(writerCapture)组装 diff 出确认卡。
	 * 卡片挂载键 = **toolCallId**(2026-09-19):卡是那次 write/edit 工具块的渲染结果,
	 * 不再需要「锚定到某条 assistant 消息」—— 改造前为此要维护「内存随机 id 在
	 * message_end 后升级成 entryId 再回头改写卡锚点」的接力,已随锚点机制一并删除。
	 * scope 守卫:handleEnd 是异步的(await 取数),期间切书/切章时丢弃旧 scope 的
	 * 卡片——否则旧书/旧章卡片会 append 进新 scope 的确认队列并被持久化
	 * (2026-08 修复,与恢复路径的 confirmScopeRef 归属同规则)。
	 */
	async function handleWriterToolEnd(e: Extract<AgentEventDto, { type: "tool_execution_end" }>) {
		const scope = `${bookDetailRef.current?.slug ?? ""}:${currentChapterRef.current?.file ?? ""}`;
		const edit = await writerCapture.handleEnd(e.toolCallId, e.isError);
		if (!edit) return; // 失败/非编辑工具/无实质变化:不弹卡
		if (`${bookDetailRef.current?.slug ?? ""}:${currentChapterRef.current?.file ?? ""}` !== scope) return; // 期间切书/切章:丢弃
		const card: ConfirmCardItem = {
			id: newId("confirm"),
			kind: edit.kind,
			path: edit.path,
			before: edit.before,
			toolCallId: e.toolCallId,
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

	/**
	 * 开合「本会话用量」浮层(点输入条的上下文圆环)。
	 * 打开时现拉一次(warm:服务重启后内存里还没宿主也能拿到历史用量),
	 * 数字就是点下去那一刻的,不依赖 SSE 事件恰好刷过。
	 */
	async function toggleUsage() {
		if (usageOpen) {
			setUsageOpen(false);
			return;
		}
		setUsageOpen(true);
		setUsageBusy(true);
		setUsageErr(null);
		try {
			const slug = bookDetailRef.current?.slug;
			if (!slug) {
				setUsageStats(null);
				return;
			}
			const t = writerTargetNow(currentChapterRef.current?.file ?? null);
			setUsageStats(await client.writerStats(slug, t.chapterFile, true, t.conversation));
		} catch (e) {
			setUsageErr(`用量读取失败: ${friendlyError(e)}`);
		} finally {
			setUsageBusy(false);
		}
	}

	/**
	 * 拉取编剧会话上下文占用(静默失败:提示是优化,不打断使用)。
	 *
	 * `warm` = 让服务端在磁盘已有该章会话时顺带把会话带起来。打开页面/切章/SSE 重连时
	 * 传 true —— 否则服务重启后内存里没有会话宿主,`usage` 恒为 null,输入条上的上下文
	 * 圆环要等用户在本章说第一句话才出现(2026-09-23 实测)。
	 */
	function refreshWriterUsage(warm = false) {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		const ch = currentChapterRef.current;
		const conv = selectedConversationRef.current;
		const t = writerTargetNow(ch?.file ?? null);
		void client
			.writerContext(slug, t.chapterFile, warm, t.conversation)
			.then(({ usage, trim }) => {
				// 期间切书/切章/切对话:丢弃过期快照
				if (
					bookDetailRef.current?.slug === slug &&
					currentChapterRef.current?.file === ch?.file &&
					selectedConversationRef.current === conv
				) {
					setWriterUsage(usage);
					// 裁切摘要(2026-10-04,T4):与服务端缓存的「真正注进去的那一次」
					// 同源,不在这里重算。空摘要(null / text 为空)即未裁切。
					setWriterTrim(trim && trim.text.length > 0 ? trim : null);
				}
			})
			.catch(() => {});
	}

	/**
	 * 拉取上下文检视报告(T5,2026-10-04)。
	 *
	 * 纯读端点,不创建会话;服务端返回的是「最近一次真正注入」的快照,
	 * 因此这里拿到的 used/percent 与用户实际看到的上下文一致。
	 * 每章每次展开都重拉:世界书可能刚被 AI 改过,缓存反而会误导。
	 */
	function refreshWriterInspect() {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		const ch = currentChapterRef.current;
		const conv = selectedConversationRef.current;
		const t = writerTargetNow(ch?.file ?? null);
		setInspectLoading(true);
		void client
			.writerInspect(slug, t.chapterFile, t.conversation)
			.then(({ report }) => {
				if (
					bookDetailRef.current?.slug === slug &&
					currentChapterRef.current?.file === ch?.file &&
					selectedConversationRef.current === conv
				) {
					setInspectReport(report);
				}
			})
			.catch(() => {})
			.finally(() => setInspectLoading(false));
	}

	/** 展开/收起检视面板;展开时拉最新数据。 */
	function toggleInspect() {
		const next = !inspectOpen;
		setInspectOpen(next);
		if (next) refreshWriterInspect();
	}

	/** `/compact` 动作:手动压缩编剧当前章节上下文(压缩事件经 writer_event 驱动 UI)。 */
	async function runWriterCompact(instructions: string) {
		const slug = bookDetailRef.current?.slug;
		if (!slug) return;
		if (writerCompactingRef.current) return;
		try {
			const t = writerTargetNow(currentChapterRef.current?.file ?? null);
			await client.writerCompact(slug, t.chapterFile, instructions || undefined, t.conversation);
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
	/** 插件声明的斜杠命令(拉一次,随插件启停重建;运行中新增插件命令需重启页面)。 */
	const [pluginCommands, setPluginCommands] = useState<SlashCommand[] | null>(null);
	useEffect(() => {
		let cancelled = false;
		client
			.getPlugins()
			.then((plugins) => {
				if (cancelled) return;
				const cmds: SlashCommand[] = [];
				for (const p of plugins) {
					for (const c of p.frontend?.slashCommands ?? []) {
						cmds.push(makePluginCommand({ pluginId: p.id, trigger: c.trigger, hint: c.hint, client }));
					}
				}
				setPluginCommands(cmds);
			})
			.catch(() => {
				/* 插件命令拉取失败:仅少命令,不影响主功能 */
				if (!cancelled) setPluginCommands([]);
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	const writerSlashCommands: SlashCommand[] = [
		makeNodeCommand({ loadWorld: loadWorldForSlash }),
		makeChapterCommand(),
		/* /skill:主动点名技能(清单来自服务端,与 agent 装配同源;读失败就是没这一条命令) */
		makeSkillCommand({ loadSkills: () => client.getSkills(bookDetailRef.current?.slug) }),
		makeCompactCommand({ run: runWriterCompact }),
		...(pluginCommands ?? []),
	];

	/** 发送给编剧(常驻编辑 agent):202 即返回,流式/工具事件走 writer_event SSE;
	 *  用户消息回显经 SSE 到达,无需乐观气泡。
	 *  返回 false = **这一条没收** —— 输入条据此不清空输入框(否则流式中打字点发送会丢字)。 */
	function sendWriter(text: string): boolean {
		const slug = bookDetailRef.current?.slug;
		if (!slug || writerSession.isStreaming || writerSession.compacting) return false;
		const t = writerTargetNow(currentChapterRef.current?.file ?? null);
		void client
			.writerChat(slug, text, t.chapterFile, t.conversation)
			.catch((err) => setError(`发送失败: ${friendlyError(err)}`));
		return true;
	}

	/** 编剧消息「编辑重发」:撤回该用户消息(及之后)并以新文本重发(服务端 retract +
	 *  sendMessage;messages_retracted 广播后编剧会话重新对齐;按章节定位会话)。 */
	async function editWriterMessage(m: { id: string; entryId?: string }, newText: string) {
		const slug = bookDetailRef.current?.slug;
		if (!slug || m.entryId === undefined) return;
		const t = writerTargetNow(currentChapterRef.current?.file ?? null);
		try {
			await client.writerRetract(slug, m.entryId, newText, t.chapterFile, t.conversation);
		} catch (err) {
			setError(`编辑重发失败: ${friendlyError(err)}`);
		}
	}

	/**
	 * 报错卡的「重试」:把**这张卡绑定的那一轮**原样重放一次(2026-10 审计 BUG-014)。
	 *
	 * 重放目标在**创建卡片时**就绑好了(store 的 retryTargetForError / chat_error 的 text),
	 * 不再是点击时去 transcript 尾部猜「当前最后一条用户消息」——那会让旧报错卡重发后续
	 * 那句成功的提示词(重复生成、撤回作用在别的回合上),这正是本条要修的缺陷。
	 *
	 * 一条路径两种走法,因为**报错的时机不同**:
	 * - `entryId` 有值(用户消息已落盘,provider 401/限流/超时)→ 走「撤回 + 重发」,
	 *   即 `writerRetract(entryId, 同文本)`:不在会话里留孤儿用户消息,重试多次也只占一个分支。
	 *   retract 支持非最新 entry(leaf 回到该消息之前),所以旧卡重试也不会跨回合。
	 * - 只有 `text`(未配置模型/密钥,服务端前置检查就抛了,用户消息从未落盘)→ 撤回无从
	 *   谈起,直接把这句重发一次。
	 * - 两者都没有 → 卡片不给重试按钮(MessageList 只在 m.retry 存在时画),提示重新发送。
	 *
	 * 只读 ref:本函数从 memo 化的报错卡触发(见 MessageList 的 retryRef),闭包里的
	 * state 可能是旧的 —— `writerSessionRef` 每次渲染同步最新会话状态。
	 */
	function retryWriterTurn(m: ChatMessage) {
		const slug = bookDetailRef.current?.slug;
		const cur = writerSessionRef.current;
		if (!slug || cur.isStreaming || cur.compacting) return;
		const target = m.retry;
		if (!target || target.text.length === 0) return;
		if (target.entryId !== undefined) void editWriterMessage({ id: m.id, entryId: target.entryId }, target.text);
		else sendWriter(target.text);
	}

	/** AI 伙伴栏左缘拖拽调宽:鼠标左移变宽(伙伴栏在右侧,手柄贴左缘),受限于 [300, 520](useDragResize)。 */
	const onCompanionResizeStart = useDragResize({
		min: 300,
		max: 520,
		dir: -1,
		getValue: () => companionWidth,
		onChange: setCompanionWidth,
		onStart: () => setCompanionResizing(true),
		onEnd: () => setCompanionResizing(false),
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
	/**
	 * 正文图片解析(需求 11「AI 的回复内容可以嵌入图片」)。
	 *
	 * markdown 渲染层不知道当前书 slug,所以由页面注入:`images/xxx` 走专用图片端点
	 * (与世界书条目图**同源**),其他相对路径(assets/…、draft/…)走工作区文件端点。
	 * `http(s)://` 与 `data:image/…` 已在 markdown 白名单里直接放行,不会到这儿。
	 * 引用必须稳定 —— Message 的 memo 比较器按引用比它,每次新建会让整列表失去 memo。
	 */
	const resolveImage = useCallback(
		(src: string) => {
			const slug = bookDetail?.slug;
			if (!slug) return src;
			if (src.startsWith("images/")) return imageUrl(slug, src.slice("images/".length));
			return bookFileUrl(slug, src);
		},
		[bookDetail?.slug],
	);

	/** 导出面板的章节清单(bookDetail.chapters 与 ExportChapterRef 同形,显式映射避免耦合)。 */
	const exportChapters: ExportChapterRef[] = (bookDetail?.chapters ?? []).map((c) => ({
		id: c.id,
		file: c.file,
		title: c.title,
		label: c.label,
	}));
	/** 上下文占用达到阈值时,输入框上方的「建议 /compact」提示。 */
	const writerUsageHint = contextUsageHint(writerUsage);
	/** 最近一轮提示词缓存命中徽标(观察缓存优化效果;provider 未上报时不显示)。 */
	const writerCacheHitText = formatCacheHit(writerSession.cacheHit);
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

	/**
	 * 服务端已判定「提问已结束」的 toolCallId(ok:false)。
	 *
	 * 闸门在服务端是纯内存的:进程重启后那张未答的卡已经没人能结算,可消息流里
	 * 仍是 result=null。此时点提交/关闭只会拿到 {ok:false},若不理它,模态浮层
	 * 会永远盖在界面上(卡死)。拿到 ok:false 就把该 id 记下来,不再弹这一张。
	 */
	const [settledAskIds, setSettledAskIds] = useState<ReadonlySet<string>>(() => new Set());

	/** 编剧会话里正在等待回答的提问(ask_user);有就弹模态浮层。 */
	const pendingAsk = useMemo(() => {
		const ask = findPendingAsk(writerSession.messages);
		return ask && !settledAskIds.has(ask.toolCallId) ? ask : null;
	}, [writerSession.messages, settledAskIds]);
	/**
	 * 消息版本地图(消息气泡下缘的「‹ n / N ›」用):服务端会话树按**首段 entry id**
	 * 建键,这里转成 Map 供 MessageList 逐条查。树一刷新(编辑重发/切分支/对齐)就换新
	 * 对象 —— Message 的 memo 比较器按引用比它,所以只在树变化时重渲染。
	 */
	const writerVersions = useMemo(
		() => new Map(Object.entries(writerTree?.versions ?? {})),
		[writerTree],
	);
	/**
	 * 右栏标签切换方向(与舞台右栏同一套约定:切到更靠后的标签 = 内容自右滑入,
	 * 往回切 = 自左滑入)。原先 chat→memo 是硬切、memo→chat 才有一条单向动画 ——
	 * 现在两个方向都走 .companion-body[data-memo-dir] 的滑入。
	 */
	const [memoDir, setMemoDir] = useState<"left" | "right">("right");
	const switchMemoTab = useCallback(
		(t: "chat" | "memo") => {
			if (t === memoTab) return;
			setMemoDir(MEMO_TAB_INDEX[t] > MEMO_TAB_INDEX[memoTab] ? "right" : "left");
			changeMemoTab(t);
		},
		[memoTab, changeMemoTab],
	);
	/**
	 * 浮层退场(本轮动效审计):这五处原先都是 `{x && <Y/>}` 条件挂载——进场有动画、
	 * 关闭瞬间消失。presence 让它们多驻留到反向动画播完(见 web/src/use-exit-presence.ts)。
	 */
	const askPresence = useExitPresence(pendingAsk !== null);
	const usagePresence = useExitPresence(usageOpen);
	const previewPresence = useExitPresence(filePreview !== null);
	const editorPresence = useExitPresence(fsEditor !== null);
	const sheetPresence = useExitPresence(phoneExport);
	/**
	 * 退场期间源 state 已经清空(ask 靠 settledAskIds、fsEditor 置 null),而浮层还要
	 * 多渲染 200ms —— 内容取「最后一次非空」的留底,否则会读到 null 崩掉。
	 * (渲染期写 ref 是本仓库既有模式,见本文件 worldRef / WorldPage 的 worldRef。)
	 */
	const lastAskRef = useRef<typeof pendingAsk>(null);
	if (pendingAsk) lastAskRef.current = pendingAsk;
	const askShown = pendingAsk ?? lastAskRef.current;
	const lastEditorRef = useRef<typeof fsEditor>(null);
	if (fsEditor) lastEditorRef.current = fsEditor;
	const editorShown = fsEditor ?? lastEditorRef.current;
	const lastPreviewRef = useRef<typeof filePreview>(null);
	if (filePreview) lastPreviewRef.current = filePreview;
	const previewShown = filePreview ?? lastPreviewRef.current;

	/** 手机端底部输入条的容器(仅手机端渲染):实测高度写进 `--m-composer-h`。 */
	const composerRef = useRef<HTMLDivElement>(null);

	/**
	 * 手机端底部输入条是 `position: fixed`,而纸张(.paper-zone)、伙伴栏(.companion)
	 * 与对话切换抽屉(.m-cv-menu)都按它的高度留底部空白 —— 输入条会随行数长高
	 * (InputBar 的自动增高),留白要是写死值,长高后就会盖住最后几行。
	 * 所以把实测高度写进根元素的 `--m-composer-h`,三处留白同源(见 mobile.css)。
	 */
	useEffect(() => {
		if (!isPhone) return;
		const el = composerRef.current;
		if (!el) return;
		const root = document.documentElement;
		const apply = () => root.style.setProperty("--m-composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--m-composer-h");
		};
	}, [isPhone]);

	/**
	 * 编剧输入条:桌面端挂在伙伴栏底部,手机端提到壳层底部
	 * (.m-composer)——手机端编辑页与伙伴页共用同一条输入区,所以实例只有这一个,
	 * 按 isPhone 决定挂在哪;两处不同时渲染,不会出现两份草稿文本。
	 */
	const writerInputBar = (
		<InputBar
			ref={writerInputRef}
			streaming={writerSession.isStreaming}
			/* 压缩中不发(要等总结回合结束):置灰 + 提示,而不是打完字被吞 */
			sendDisabled={writerSession.compacting}
			onSend={sendWriter}
			onAbort={() => {
				const s = bookDetailRef.current?.slug;
				// book 模式按对话中止(别把另一段对话的生成也停了)
				if (s) void client.writerAbort(s, conversationScopeRef.current === "book" ? selectedConversationRef.current : null);
			}}
			/* 占位符只留短句;键位与 / 命令的说明不再塞进输入框 */
			placeholder={classicMode ? "向 AI 说话…" : "向编剧说话…"}
			ariaLabel={classicMode ? "向 AI 说话" : "向编剧说话"}
			commands={writerSlashCommands}
			context={writerSlashContext}
			onCommandError={(msg) => setError(`命令失败: ${msg}`)}
			enterBehavior={enterBehavior}
			usage={writerUsage}
			onUsageClick={() => void toggleUsage()}
			usagePanel={
				usagePresence.mounted ? (
					<UsagePanel
						stats={usageStats}
						loading={usageBusy}
						err={usageErr}
						closing={usagePresence.closing}
						onClose={() => setUsageOpen(false)}
					/>
				) : null
			}
		/>
	);

	/**
	 * 对话切换器(book 模式):「与章节各聊各的」时章节侧栏不再是切换器,
	 * AI 伙伴栏头部就得多一个入口。
	 *
	 * 桌面挂在伙伴栏头部(浮层下拉);手机端挂在伙伴抽屉内容顶部(底部抽屉)。
	 * 两处**不同时**渲染(与 writerInputBar 同一手法),只有这一个实例,
	 * 所以不会出现第二份「正在确认删除」的状态。
	 */
	const conversationSwitcher = (
		<ConversationSwitcher
			conversations={conversations}
			selectedId={selectedConversationId}
			onSelect={selectConversation}
			onCreate={() => void createConversation()}
			onDelete={(id) => void deleteConversation(id)}
			busy={conversationBusy}
			phone={isPhone}
		/>
	);

	/** 当前对话标题(手机端页头副标题用;chapter 模式没有对话概念,返回 null)。 */
	const currentConversationTitle =
		conversationScope === "book"
			? ((conversations.find((c) => c.id === selectedConversationId) ?? conversations[0])?.title ?? null)
			: null;

	return (
		// 三栏壳:书库(轨 1 auto,宽度由 ChapterSidebar 决定并随折叠/拖拽动画)
		// | 纸张 | AI 伙伴(轨 3 经 --companion-w 跟随左缘拖拽调宽);窄屏断点见 styles.css
		<div
			className={companionCollapsed && !isNarrow ? "writing-workspace-shell companion-collapsed" : "writing-workspace-shell"}
			style={{ "--companion-w": `${companionWidth}px` } as React.CSSProperties}
		>
			<ChapterSidebar
				books={books}
				loading={!booksLoaded && books.length === 0}
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
				railMode={railMode}
				onRailModeChange={setRailMode}
				nav={nav}
				debugMode={debug}
				classicMode={classicMode}
				words={words}
				workspace={
					<WorkspacePanel
						client={client}
						slug={bookDetail?.slug ?? null}
						active={railMode === "workspace"}
						aiTouched={aiTouched}
						onOpenChapter={openChapterFromWorkspace}
						onPreview={setFilePreview}
					/>
				}
			/>
			<section className="paper-zone">
				{/* 手机端页头:☰ 文件抽屉 | 章节名 + 保存/字数 | 伙伴 · ⋯。
				    桌面页头(.paper-head)在 ≤700px 由 CSS 隐藏,两套不并存 */}
				{isPhone && (
					<MobileHeader
						leading={{ icon: "menu", label: "文件抽屉", onPress: () => setMobileDrawer((d) => (d === "chapters" ? null : "chapters")) }}
						title={currentChapter?.title ?? "草稿"}
						tone={draftStatus === "saved" ? "ok" : draftStatus === "save-error" ? "err" : "busy"}
						subtitle={`${saveLabel} · ${words.toLocaleString("zh-CN")} 字`}
						actions={[
							{
								key: "companion",
								icon: "message-square",
								label: "AI 伙伴",
								accent: mobileDrawer === "companion",
								onPress: () => setMobileDrawer((d) => (d === "companion" ? null : "companion")),
								badge: confirmCards.filter((c) => !c.auto).length,
								live: writerSession.isStreaming,
							},
							{ key: "more", icon: "ellipsis-vertical", label: "更多", onPress: () => setPhoneMenu((v) => !v) },
						]}
					/>
				)}
				{isPhone && phoneMenu && (
					<>
						<div className="m-menu-mask" aria-hidden="true" onClick={() => setPhoneMenu(false)} />
						<div className="m-menu" role="menu" aria-label="更多">
							{currentChapter && (
								<button
									type="button"
									role="menuitem"
									className="m-menu-item"
									onClick={() => {
										setPhoneMenu(false);
										openEditor();
									}}
								>
									<Lu icon="maximize-2" size={16} />
									<span>全屏编辑</span>
								</button>
							)}
							{/* 导出:手机端是整屏页,从页头 ⋯ 进入 */}
							<button
								type="button"
								role="menuitem"
								className="m-menu-item"
								onClick={() => {
									setPhoneMenu(false);
									setPhoneExport(true);
								}}
							>
								<Lu icon="upload" size={16} />
								<span>导出</span>
							</button>
							{nav && (
								<>
									<button
										type="button"
										role="menuitem"
										className="m-menu-item"
										onClick={() => {
											setPhoneMenu(false);
											nav.onNavigate("world");
										}}
									>
										<Lu icon="globe" size={16} />
										<span>世界书</span>
									</button>
									<button
										type="button"
										role="menuitem"
										className="m-menu-item"
										onClick={() => {
											setPhoneMenu(false);
											nav.onNavigate("settings");
										}}
									>
										<Lu icon="settings" size={16} />
										<span>设置</span>
									</button>
								</>
							)}
						</div>
					</>
				)}
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
				{/* 首屏拉书还没回来:先给骨架,别闪一帧「还没有书」再换成正文(审计 2026-09-30) */}
				{!booksLoaded && books.length === 0 ? (
					<div className="d-body">
						<div className="sk-lines" aria-hidden="true">
							<div className="skeleton sk-line title" />
							<div className="skeleton sk-line w90" />
							<div className="skeleton sk-line w80" />
							<div className="skeleton sk-line w90" />
							<div className="skeleton sk-line w70" />
							<div className="skeleton sk-line w50" />
						</div>
					</div>
				) : books.length === 0 && !currentChapter ? (
					<EmptyBooks onCreate={(title) => void newBook(title)} />
				) : (
					<>
						{/* 纸张头部:章节名 + 状态胶囊 | 草稿路径 + 字数 + 全屏编辑 */}
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
								<span className="paper-title">{currentChapter?.title ?? "草稿"}</span>
								<span className="paper-state">草稿</span>
							</div>
							<div className="paper-status">
								<span className="paper-file">{draftFile}</span>
								<span className="paper-words">{words.toLocaleString("zh-CN")} 字</span>
								{/* 导出:按钮点开是一排格式页签,浮在纸张头下方 */}
								<ExportPanel
									bookTitle={bookDetail?.title ?? ""}
									chapters={exportChapters}
									currentChapterFile={currentChapter?.file ?? null}
									currentChapterTitle={currentChapter?.title ?? ""}
									loadChapterText={loadExportChapterText}
									loadWorldAppendix={loadExportAppendix}
									onError={setError}
								/>
								{currentChapter && (
									<button className="paper-fs" onClick={openEditor} title="全屏编辑(Alt+E)" aria-label="全屏编辑">
										<Lu icon="maximize-2" size={14} />
									</button>
								)}
							</div>
							<button
								type="button"
								className="ws-drawer-toggle"
								aria-label={mobileDrawer === "companion" ? "关闭 AI 伙伴" : "打开 AI 伙伴"}
								onClick={() => setMobileDrawer((d) => (d === "companion" ? null : "companion"))}
							>
								伙伴
							</button>
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
				{/* 工作区文件预览:只读覆盖层压住纸张区(正文编辑器不卸载,
				    关掉即回到原样;Esc 也可关)。图片/文本/二进制在 FilePreview 内分派 */}
				{previewPresence.mounted && bookDetail && previewShown && (
					<FilePreview
						client={client}
						slug={bookDetail.slug}
						entry={previewShown}
						closing={previewPresence.closing}
						onClose={() => setFilePreview(null)}
					/>
				)}
			</section>
			{/* AI 伙伴:编剧对话单栏(批注 2026-08-10 退役并入编剧);宽屏常驻右栏,窄屏右侧抽屉 */}
			<>
				<AnimatePresence>
					{/* 手机端(≤700px)伙伴页是整屏,没有「点外面关闭」这回事;
					    此时遮罩必须不渲染:它 z-index 48 压过伙伴栏(z-index 40),会把整页盖住,
					    导致抽屉里的对话既不能滚动也不能点(2026-09 修)。窄屏(701–900)抽屉才需要遮罩。 */}
					{isNarrow && !isPhone && mobileDrawer === "companion" && (
						<motion.div
							key="companion-mask"
							className="drawer-mask"
							aria-hidden="true"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1, pointerEvents: "auto" }}
							/* 退场的一帧就交还点击(不可插值属性立即生效),否则 200ms 淡出期间遮罩会吞掉
							   抽屉关闭后紧接着的那一下点击 */
							exit={{ opacity: 0, pointerEvents: "none" }}
							transition={{ duration: DUR.base, ease: EASE.out }}
							onClick={() => setMobileDrawer(null)}
						/>
					)}
				</AnimatePresence>
				<motion.aside
					className={`companion${mobileDrawer === "companion" ? " drawer-open" : ""}${companionResizing ? " resizing" : ""}`}
					aria-label="AI 伙伴"
					initial={false}
					animate={!isNarrow || mobileDrawer === "companion" ? "open" : "closed"}
					variants={{
						open: { x: 0, opacity: 1, visibility: "visible" },
						closed: { x: "100%", opacity: 0, transitionEnd: { visibility: "hidden" } },
					}}
					transition={{ duration: DUR.slow, ease: EASE.out }}
				>
					{/* 左缘拖拽调宽手柄(窄屏抽屉模式隐藏;收起态无宽度可调) */}
					{!isNarrow && !companionCollapsed && <div className="comp-resize" onMouseDown={onCompanionResizeStart} title="拖拽调整宽度" />}
					{/* 手机端伙伴页头:← 回编辑 | 编剧 + 上下文占用 | 备忘录/⋯ */}
					{isPhone && (
						<MobileHeader
							leading={{ icon: "chevron-left", label: "回到编辑", onPress: () => setMobileDrawer(null) }}
							title={classicMode ? "AI" : "编剧"}
							tone={writerSession.isStreaming ? "busy" : "ok"}
							subtitle={
								// book 模式:标题行先说是哪一段对话(章节不再是身份);
								// 后面仍带「正在看的章节 / 上下文占用」
								[
									currentConversationTitle ? `对话「${currentConversationTitle}」` : null,
									currentChapter?.title ?? "草稿",
									writerUsage?.percent != null ? `上下文 ${Math.round(writerUsage.percent)}%` : null,
								]
									.filter((s): s is string => s !== null)
									.join(" · ")
							}
							actions={[
								{
									key: "memo",
									icon: "sticky-note",
									label: "备忘录",
									accent: memoTab === "memo",
									onPress: () => switchMemoTab(memoTab === "memo" ? "chat" : "memo"),
								},
								{
									key: "usage",
									icon: "activity",
									label: "上下文用量",
									onPress: () => void toggleUsage(),
								},
							]}
						/>
					)}
					{companionCollapsed ? (
						/* 收起态 = 与舞台右栏同一套图标/标签栏:点别的标签只换选中,
						   点当前标签才展开 */
						<div className="companion-rail" role="tablist" aria-label="AI 伙伴(已收起)">
							{([["chat", classicMode ? "AI" : "编剧"], ["memo", "备忘录"]] as const).map(([id, label]) => (
								<button
									key={id}
									type="button"
									role="tab"
									aria-selected={memoTab === id}
									className={memoTab === id ? "companion-rail-item active" : "companion-rail-item"}
									title={memoTab === id ? `展开${label}` : label}
									aria-label={memoTab === id ? `展开${label}` : label}
									onClick={() => {
										if (memoTab === id) toggleCompanionCollapsed();
										else switchMemoTab(id);
									}}
								>
									{label}
								</button>
							))}
						</div>
					) : (
					<>
					<div className="companion-head">
						{/* 标签:编剧对话 | 备忘录(全局 Notice 待办板,2026-08-12 从书库栏移来);
						    :外层改下划线式(与舞台右栏面板同一套语言),
						    外层与内层不再都是胶囊控件。data-active 是旧的滑动指示器协议,
						    下划线式不需要,已去掉 */}
						<div className="c-tabs" role="tablist">
							<button type="button" className={memoTab === "chat" ? "c-tab active" : "c-tab"} onClick={() => switchMemoTab("chat")}>
								{classicMode ? "AI" : "编剧"}
							</button>
							<button type="button" className={memoTab === "memo" ? "c-tab active" : "c-tab"} onClick={() => switchMemoTab("memo")}>
								备忘录
							</button>
						</div>
						{/* 待确认编辑数(免确认模式下恒为 0)与生成指示灯只属于编剧对话 */}
						{memoTab === "chat" && confirmCards.filter((c) => !c.auto).length > 0 && (
							<span className="companion-badge">{confirmCards.filter((c) => !c.auto).length}</span>
						)}
						{memoTab === "chat" && writerSession.isStreaming && <span className="companion-live" title="生成中" aria-label="生成中" />}
						<button
							type="button"
							className="companion-collapse"
							onClick={toggleCompanionCollapsed}
							title="收起 AI 伙伴"
							aria-label="收起 AI 伙伴"
						>
							<Lu icon="chevrons-right" size={14} />
						</button>
					</div>
					{/* 对话切换器(book 模式,「AI」标签头部):当前对话标题 + 切换入口。
					    chapter 模式**不渲染**——章节侧栏就是切换器,界面零变化。
					    手机端不在这里(挂进伙伴抽屉内容顶部,见下) */}
					{conversationScope === "book" && memoTab === "chat" && !isPhone && (
						<div className="cv-bar">{conversationSwitcher}</div>
					)}
					{/* data-memo-dir:标签切换方向 → 内容滑入方向(styles.css 的
					    .companion-body[data-memo-dir] 规则;两个方向都有动画) */}
					<div className="companion-body" data-memo-dir={memoDir}>
							{memoTab === "memo" ? (
								<NoticeBoard client={client} slug={bookDetail?.slug ?? null} />
							) : (
						<div className="chat active">
							{/* 手机端(book 模式):对话切换器挂在抽屉内容顶部 ——
							    手机没有「伙伴栏头部」那条常驻横条,抽屉就是它的家;
							    展开后是底部抽屉(.m-cv-menu)。桌面端在上面 cv-bar 里 */}
							{conversationScope === "book" && isPhone && (
								<div className="cv-bar m-cv-bar">{conversationSwitcher}</div>
							)}
							{/* 编剧(常驻编辑 agent)对话:会话状态经 processAgentEvent 维护,
							   MessageList/InputBar 原样复用;确认卡锚定在触发编辑的 assistant 消息下;
							   选中正文会自动预填选区上下文(见 handleSelectionChange)。
							   分支切换收在消息气泡下缘的「‹ n / N ›」(MessagePager)——编辑重发
							   后想换回旧版就点箭头,不再有顶部的分支下拉栏。 */}
							<MessageList
								messages={writerSession.messages}
								streaming={writerSession.isStreaming}
								compacting={writerSession.compacting}
								debug={debug}
								confirmCards={confirmCards}
								versions={writerVersions}
								onConfirmCard={confirmCard}
								onRevertCard={(id) => void revertCard(id)}
								onEdit={(m, newText) => void editWriterMessage(m, newText)}
								onRetry={(m) => retryWriterTurn(m)}
								onOpenSettings={onOpenSettings}
								onSwitchVersion={(leafId) => void navigateWriter(leafId)}
								resolveImage={resolveImage}
								emptyText={
									classicMode
										? "向 AI 说一句话——它带着全套工具,可以直接改稿、查字数、维护世界书;修改会生成待确认卡,可随时回退;选中正文会自动填入选区"
										: "向编剧发一句话，讨论行文、取舍与节奏——修改正文会生成待确认卡，可随时回退；选中正文会自动填入选区"
								}
							/>
							{writerCacheHitText && (
								<div className="notice info" role="status">
									{writerCacheHitText}
								</div>
							)}
							{writerUsageHint && (
								/* key 带 tone:80%→90% 从 warn 变 err 时重挂载 → 重播 .notice 的入场淡入 */
								<div key={writerUsageHint.tone} className={`notice ${writerUsageHint.tone}`} role="status">
									{writerUsageHint.text}
								</div>
							)}
							{/* 裁切可见(2026-10-04,T4):背景包预算不够时告诉用户省了什么,
							    而不是让他以为设定都进去了 —— 与用量提示条同款式。
							    key 带 text:裁切内容变化时重挂载,重播入场动画(同 writerUsageHint 手法)。
							    T5 起这条同时是「上下文检视」的入口:点它展开完整面板 —— 看到
							    被省略的清单还不够,用户接下来必然要问「那总量是多少、怎么改」,
							    所以入口就放在「已经让他起疑」的那一行上。 */}
							{writerTrim && (
								<div key={writerTrim.text} className="notice warn" role="status">
									⚠ 背景包预算不足,{writerTrim.text}
									<button type="button" className="notice-action" onClick={toggleInspect} aria-expanded={inspectOpen}>
										{inspectOpen ? "收起" : "查看详情"}
									</button>
								</div>
							)}
							{/* 没有裁切时也给一个轻量入口 —— 否则「没超预算」的用户永远
							    发现不了这个面板,而它恰好是「提前调预算」的唯一依据。 */}
							{!writerTrim && (
								<button type="button" className="inspect-entry" onClick={toggleInspect} aria-expanded={inspectOpen}>
									{inspectOpen ? "▾ 收起上下文检视" : "▸ 上下文检视"}
								</button>
							)}
							{inspectOpen && (
								<ContextInspectPanel report={inspectReport} loading={inspectLoading} onRefresh={refreshWriterInspect} />
							)}
							{/* 桌面:输入条留在伙伴栏底部;手机端它被提到壳层底部(.m-composer),
							    所以这里按 isPhone 二者取一 */}
							{!isPhone && writerInputBar}
						</div>
						)}
					</div>
					</>
					)}
				</motion.aside>
			</>
			{/* 手机端底部常驻输入条:编辑页与伙伴页共用,内容与桌面同一个实例。
			    点/聚焦它就等于「要和 AI 说话」→ 自动滑出 AI 对话抽屉并保持(抽屉只在遮罩、
			    返回、关闭按钮时收起,不因输入或发送自动关)。输入条是抽屉的兄弟节点而非子节点,
			    所以抽屉滑出不会把它卸载,焦点与已输入的文字都留着。 */}
			{isPhone && (
				<div
					ref={composerRef}
					className="m-composer"
					onPointerDown={() => setMobileDrawer("companion")}
					onFocusCapture={() => setMobileDrawer("companion")}
				>
					{writerInputBar}
				</div>
			)}
			{/* 手机端整屏导出:受控的 ExportPanel,自带触发按钮不渲染 */}
			{isPhone && sheetPresence.mounted && (
				<div className={`m-sheet${sheetPresence.closing ? " is-closing" : ""}`} role="dialog" aria-label="导出">
					<div className="m-sheet-head">
						<button type="button" className="m-icon-btn" aria-label="返回" title="返回" onClick={() => setPhoneExport(false)}>
							<Lu icon="chevron-left" size={18} />
						</button>
						<span className="m-sheet-title">导出</span>
						<span className="m-head-sub-text">{bookDetail?.title ?? ""}</span>
					</div>
					<div className="m-sheet-body" ref={phoneExportRef}>
						<ExportPanel
							bookTitle={bookDetail?.title ?? ""}
							chapters={exportChapters}
							currentChapterFile={currentChapter?.file ?? null}
							currentChapterTitle={currentChapter?.title ?? ""}
							loadChapterText={loadExportChapterText}
							loadWorldAppendix={loadExportAppendix}
							onError={setError}
							control={{ open: true, onClose: () => setPhoneExport(false) }}
							panelRef={phoneExportRef}
						/>
					</div>
				</div>
			)}
			{/* 提问卡片(ask_user):工具阻塞着等这个回答,所以是模态浮层。
			    挂载条件从消息流推出来(未答的 ask_user 块),不另存一份 pending 状态。
			    退场期间 pendingAsk 已经变 null,所以内容取「最后一次非空」的留底 */}
			{askPresence.mounted && askShown && (
				<AskUserOverlay
					questions={askShown.questions}
					closing={askPresence.closing}
					/* 提交/取消失败要说出来(2026-09-23):此前 `void` 掉 promise,
					   请求失败时浮层原地不动、无提示,用户会反复点提交。
					   ok:false = 这张提问在服务端已经结束(闸门没了),本地关掉别卡住 */
					onSubmit={(answers) => {
						const id = askShown.toolCallId;
						void client
							.answerAskUser(id, answers)
							.then((ok) => {
								if (!ok) setSettledAskIds((s) => new Set(s).add(id));
							})
							.catch((e) => setError(`提交回答失败: ${friendlyError(e)}`));
					}}
					onCancel={() => {
						const id = askShown.toolCallId;
						void client
							.cancelAskUser(id)
							.then((ok) => {
								if (!ok) setSettledAskIds((s) => new Set(s).add(id));
							})
							.catch((e) => setError(`取消提问失败: ${friendlyError(e)}`));
					}}
				/>
			)}
			{/* 全屏编辑器覆盖层(设计 §5.4);退场期间 fsEditor 已 null,内容取留底 */}
			{editorPresence.mounted && editorShown && (
				<FullScreenEditor
					client={client}
					slug={bookDetail?.slug ?? null}
					initialFile={editorShown.file}
					title={editorShown.title}
					closing={editorPresence.closing}
					onClose={() => setFsEditor(null)}
				/>
			)}
		</div>
	);
}
