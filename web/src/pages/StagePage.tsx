import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { Library } from "../library.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useDragResize } from "../use-drag-resize.ts";
import { initialSessionState, messagesToEvents, processAgentEvent, RESET, sessionReducer } from "../store.ts";
import type { AgentEventDto, ChapterRef, ScriptPatchDto, StageModeDto, StagePhaseDto, StageScriptDto, StageSnapshotDto } from "../types.ts";
import { formatCounts, initialStageState, reduceStage, stageEntryText } from "../stage-web.ts";
import { ChapterSidebar } from "../components/ChapterSidebar.tsx";
import { InputBar } from "../components/InputBar.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { PreviewCard } from "../components/PreviewCard.tsx";
import { StageAvatar } from "../components/StageAvatar.tsx";
import { StagePanel, type StagePanelTab } from "../components/StagePanel.tsx";
import { buildWorldDiff, classifyWorldChange, type PreviewData } from "../preview.ts";

/**
 * 舞台页(导演/演出):书库栏(常驻,与编辑页共享 useLibrary 状态)+ 舞台主区 +
 * 右侧剧本/选角/修订面板。
 *
 * 演出前(phase=idle)整页为「导演讨论室」:控制条全灰,唯一活跃交互是导演输入条;
 * 导演 stage_script 开演后场景头/控制条/舞台流切换为「演出中」形态(同一页两形态)。
 *
 * 状态:stage reducer(stage-web.ts 纯逻辑)维护快照 + 舞台流 + busy/turnPending;
 * 快照拉取 + SSE(stage_entry/system/done,按 slug 过滤)对齐服务端。
 */
export function StagePage({
	client,
	library,
	active,
	onGoEdit,
	simplifiedTools,
}: {
	client: ApiClient;
	/** 书库状态唯一真相源(App 持有,与编辑页共用——书库栏两页常驻且状态同步)。 */
	library: Library;
	/** 页面是否处于激活显示状态(四页常驻挂载,由 App 上报视图切换)。 */
	active?: boolean;
	/** 收幕完成引导卡「去编辑页」跳转(App 顶层视图切换)。 */
	onGoEdit?: () => void;
	/** 简化输出(设置页「界面偏好」):导演对话工具卡片隐藏,只保留模型文本输出。 */
	simplifiedTools?: boolean;
}) {
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
	} = library;
	const slug = bookDetail?.slug ?? null;
	const [stage, dispatch] = useReducer(reduceStage, undefined, initialStageState);
	/** 导演对话长命令进行中(导演回合可能很长,输入条/按钮据此禁用)。 */
	const busy = stage.busy !== null;
	/** 当前长命令名(null = 空闲;收幕/反馈等命令全程置 busy)。 */
	const busyCmd = stage.busy;
	/** 本地镜像:自动演模式(服务端无此字段,乐观切换)。 */
	const [autoMode, setAutoMode] = useState(false);
	/** 编剧思考链可见性档位(1-3,服务端无此字段,乐观切换)。 */
	const [thoughts, setThoughts] = useState(2);
	/** 右侧面板标签。 */
	const [tab, setTab] = useState<StagePanelTab>("script");
	/** 反馈表单:正在反馈的条目序号(1-based,即 /fix index);null = 关闭。 */
	const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
	const [feedbackText, setFeedbackText] = useState("");
	/** 窄屏抽屉:书库栏。 */
	const [drawerOpen, setDrawerOpen] = useState(false);
	/** 窄屏(<900px)判定:书库栏变抽屉(与写作页同断点)。 */
	const isNarrow = useMediaQuery("(max-width: 900px)");
	/** 右侧面板宽度(px,左缘拖拽手柄调整,280–520)。 */
	const [panelWidth, setPanelWidth] = useState(360);

	/** 面板拖拽调宽:按下后在 window 上监听移动,宽度随鼠标横向位移受限于 [280, 520](useDragResize)。 */
	const onPanelResizeStart = useDragResize({
		min: 280,
		max: 520,
		dir: -1,
		getValue: () => panelWidth,
		onChange: setPanelWidth,
	});

	// ---- 快照拉取(书/章节切换、页面激活、SSE 重连时对齐) ----
	// 失败自动重试一次(1.2s 后):网络瞬断/服务刚重启时,首次拉取失败会导致
	// 对话历史(directorChat)恢复不了、气泡看起来「丢了」——重试保证收敛
	/** 当前章节 ref(SSE 闭包取最新值;舞台按章节隔离,事件按 slug+chapter 过滤)。 */
	const currentChapterRef = useRef(currentChapter);
	currentChapterRef.current = currentChapter;
	/** 快照响应代数:并发 refresh(切章/激活/重连/开演)后发先至时,旧快照覆盖新快照。
	 *  每次 refresh 自增,过期响应丢弃(2026-08-13)。 */
	const stageGenRef = useRef(0);
	const refresh = useCallback(async () => {
		if (!slug) return;
		const gen = ++stageGenRef.current;
		const apply = (snap: StageSnapshotDto) => {
			if (stageGenRef.current === gen) applyStageSnapshot(snap);
		};
		try {
			apply(await client.getStage(slug, currentChapterRef.current?.file ?? null));
		} catch (e) {
			try {
				await new Promise((r) => setTimeout(r, 1200));
				apply(await client.getStage(slug, currentChapterRef.current?.file ?? null));
			} catch (e2) {
				if (stageGenRef.current === gen) dispatch({ type: "system", text: `舞台快照拉取失败: ${friendlyError(e2)}`, err: true });
			}
		}
	}, [slug, client]);

	/** 上次对齐的「书+章节」scope(切书/切章时整体重置舞台流——快照的 local 保留
	 *  逻辑只适合同 scope 对齐(重连/刷新),跨书/跨章会残留旧对话行 = 「串对话」
	 *  根因,2026-08-10)。同时清导演预览卡(单张 state,不清会串到新书/新章)。 */
	const lastScopeRef = useRef<string | null>(null);
	useEffect(() => {
		const scope = `${slug ?? ""}:${currentChapter?.file ?? ""}`;
		if (lastScopeRef.current !== scope) {
			lastScopeRef.current = scope;
			dispatch({ type: "reset" });
			setWorldPreview(null);
			worldEditPendingRef.current = false;
			setCutDirectorDone(false);
			setScriptConfirm(null);
			setConfirmDismissed(false);
		}
		void refresh();
	}, [refresh, slug, currentChapter]);

	useEffect(() => {
		if (active) void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// ---- SSE:只消费本 slug+章节 的舞台事件(舞台按章节隔离,2026-08-10) ----
	useEffect(() => {
		if (!slug) return;
		const unsub = client.subscribeEvents(
			(e) => {
				const sameChapter = (cf: string | null | undefined) => cf === (currentChapterRef.current?.file ?? null);
				if (e.type === "stage_entry" && e.slug === slug && sameChapter(e.chapterFile)) dispatch({ type: "entry", entry: e.entry });
				else if (e.type === "stage_system" && e.slug === slug && sameChapter(e.chapterFile)) dispatch({ type: "system", text: e.text });
				else if (e.type === "stage_done" && e.slug === slug && sameChapter(e.chapterFile)) {
					dispatch({ type: "done", cmd: e.cmd, ok: e.ok });
				} else if (e.type === "stage_director_event" && e.slug === slug && sameChapter(e.chapterFile)) {
					// 导演会话事件(与 writer_event 同款):走 processAgentEvent 归约
					// (消息/思考/流式/工具卡与编剧同款);回合结束(agent_settled,含
					// silent 收幕回合)撤收幕提示条 + 读世界书编辑记录渲染预览卡
					const ev = e.event;
					if (ev.type === "agent_settled") {
						setCutDirectorDone(true);
						void maybeShowWorldCard();
					}
					directorDispatch(ev);
				} else if (e.type === "stage_world_edit" && e.slug === slug && sameChapter(e.chapterFile)) {
					// 世界书编辑信号(工具已写记录文件):回合结束时读取渲染预览卡
					worldEditPendingRef.current = true;
				} else if (e.type === "stage_director_done" && e.slug === slug && sameChapter(e.chapterFile)) {
					// 收幕导演整理回合结束(无回合的收幕也会发):撤「正在编辑」提示条
					setCutDirectorDone(true);
				} else if (e.type === "stage_phase" && e.slug === slug && sameChapter(e.chapterFile)) {
					// 阶段变化(开演/收幕):自动刷新快照(演出 UI 形态切换,无需手动刷新)
					void refresh();
				} else if (e.type === "stage_script_confirm" && e.slug === slug && sameChapter(e.chapterFile)) {
					// 导演 script_confirm 提交剧本:弹确认卡(待确认态)
					setConfirmDismissed(false);
					setScriptConfirm({ sceneId: e.sceneId, script: e.script, confirmed: false });
				}
			},
			() => void refresh(),
		);
		return unsub;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slug, client]);

	/**
	 * 舞台命令。同步命令结果不进舞台流(服务端同步命令都 emit stage_system,
	 * 再展示会重复);next/retry 触发回合 → 置 turnPending(「下一步」置灰,
	 * 回合结束信号 stage_entry/stage_system 到达后恢复)。
	 */
		const runCommand = useCallback(
			async (cmd: string, args: Record<string, unknown> = {}) => {
				if (!slug) return;
				try {
					const res = await client.stageCommand(slug, cmd, args, currentChapterRef.current?.file ?? null);
					if (res.async) {
						dispatch({ type: "busy", cmd });
						// 收幕提示条计时起点:导演回合结束(agent_settled)即撤,
						// 编剧成文阶段不再提示(2026-08-11)
						if (cmd === "cut") setCutDirectorDone(false);
					} else if (cmd === "next" || cmd === "retry") {
						dispatch({ type: "wake" });
					}
				} catch (e) {
					dispatch({ type: "system", text: `命令失败: ${friendlyError(e)}`, err: true });
				}
			},
			[slug, client],
		);

	// ---- 导演世界书编辑预览卡(舞台流内):world_update 工具把 before/after 快照
	// 写进记录文件(stage/last-world-edit.json),信号置 pending、回合结束(agent_settled)
	// 读文件渲染——diff 由工具在应用时刻算好,无工具事件竞态捕获(2026-08-11 简化)。
	const [worldPreview, setWorldPreview] = useState<PreviewData | null>(null);
	const worldEditPendingRef = useRef(false);
	/** 收幕导演回合是否已结束(agent_settled 置位;收幕提示条据此撤下,不等编剧成文)。 */
	const [cutDirectorDone, setCutDirectorDone] = useState(false);

	// ---- 导演会话(2026-08-11 统一重构):与编剧/主会话同款 reducer + MessageList。
	// stage_director_event 内层是主会话同款事件(processAgentEvent 归约),
	// 思考折叠/流式/工具卡片零新逻辑;快照 directorChat 水合恢复。
	const [directorSession, directorDispatch] = useReducer(sessionReducer, undefined, initialSessionState);

	/** 导演会话对齐:快照 directorChat → RESET + 逐条水合(与编剧 alignWriter 同模式)。 */
	function alignDirector(snapshot: StageSnapshotDto) {
		directorDispatch(RESET);
		for (const ev of messagesToEvents(snapshot.directorChat ?? [])) directorDispatch(ev);
	}

	// ---- 剧本确认门(2026-08-11):导演 script_confirm 提交 → 卡片确认 → 才可开演。
	// 数据源 = stage_script_confirm SSE(实时)+ 快照 pendingScript(对齐兜底)。
	const [scriptConfirm, setScriptConfirm] = useState<{ sceneId: string; script: StageScriptDto; confirmed: boolean } | null>(null);
	/** 本地「需要修改」折叠(收起卡片,引导在导演对话里提意见;快照对齐不复活)。 */
	const [confirmDismissed, setConfirmDismissed] = useState(false);

	/** 快照落地:舞台流(条目/系统行)+ 导演对话水合 + 剧本确认态同步。
	 *  pendingScript 同步有竞态:SSE stage_script_confirm 事件先于后端写入,
	 *  期间快照可能仍是 null——只在「快照有 pendingScript」或「已开演/收幕
	 *  (phase 非 idle,确认门已清)」时更新,快照滞后的 null 不清本地卡。 */
	function applyStageSnapshot(snapshot: StageSnapshotDto) {
		dispatch({ type: "snapshot", snapshot });
		alignDirector(snapshot);
		if (snapshot.pendingScript) {
			setScriptConfirm(snapshot.pendingScript);
		} else if (snapshot.phase !== "idle") {
			setScriptConfirm(null);
			setConfirmDismissed(false);
		}
	}

	/** 确认开演(confirm_script 同步命令):确认后服务端自动唤起导演回合调
	 *  stage_script 开演(2026-08-11 起,无需用户补发「开演」);成功后刷新快照。 */
	async function confirmScript() {
		if (!slug) return;
		try {
			await client.stageCommand(slug, "confirm_script", {}, currentChapterRef.current?.file ?? null);
			await refresh();
		} catch (e) {
			dispatch({ type: "system", text: `确认失败: ${friendlyError(e)}`, err: true });
		}
	}

	/** 回合结束渲染世界书预览卡(2026-08-11 简化):world_edit 信号置 pending,
	 *  agent_settled 时读工具写的记录文件渲染——diff 由工具在应用时刻算好,
	 *  无 prefetchBaseline/工具事件竞态捕获。 */
	async function maybeShowWorldCard() {
		if (!worldEditPendingRef.current) return;
		worldEditPendingRef.current = false;
		try {
			const record = await client.getStageLastWorldEdit(slug ?? "");
			if (!record) return;
			const diff = buildWorldDiff(record.before, record.after);
			const cls = classifyWorldChange(diff);
			if (!cls) return;
			setWorldPreview(
				cls.mode === "graph"
					? { kind: "world", toolName: "world_update", slug, mode: "graph", afterWorld: record.after, worldDiff: diff }
					: { kind: "world", toolName: "world_update", slug, mode: "entry", entries: diff.modifiedEntries, allEntries: record.after.entries, relations: record.after.relations },
			);
		} catch {
			/* 记录读取失败:不弹卡 */
		}
	}

	/** 向导演说话:长命令(director)进行中禁止;用户消息经 SSE 回显(与编剧同款,不乐观)。 */
	function sendDirector(text: string) {
		if (!slug || busy) return;
		void runCommand("director", { text });
	}

	// ---- 书库栏(数据层,无会话;会话同步只属于编辑页) ----
	const selectBook = useCallback(
		async (s: string) => {
			if (s === bookDetail?.slug) return;
			try {
				await library.openBookData(s);
			} catch (e) {
				dispatch({ type: "system", text: `打开书失败: ${friendlyError(e)}`, err: true });
			}
		},
		[bookDetail, library],
	);

	const selectChapter = useCallback(
		(ch: ChapterRef) => {
			if (ch.file === currentChapter?.file) return;
			library.applyChapter(ch);
			// 舞台按章节隔离:切章后 scope 变化 → reset + 拉新章快照(见 refresh 的 scope 判定)
		},
		[currentChapter, library],
	);

	const newChapter = useCallback(async () => {
		if (!bookDetail) return;
		try {
			const ch = await library.createChapterData(`第${bookDetail.chapters.length + 1}章`);
			const detail = await client.getBook(bookDetail.slug);
			library.applyBookDetail(detail);
			library.applyChapter(ch);
		} catch (e) {
			dispatch({ type: "system", text: `新建章节失败: ${friendlyError(e)}`, err: true });
		}
	}, [bookDetail, library, client]);

	const newBook = useCallback(
		async (title: string) => {
			try {
				const book = await library.createBookData(title);
				await library.openBookData(book.slug);
			} catch (e) {
				dispatch({ type: "system", text: `新建书失败: ${friendlyError(e)}`, err: true });
			}
		},
		[library],
	);

	const renameBook = useCallback(
		async (s: string, title: string) => {
			try {
				const book = await library.renameBookData(s, title);
				if (s === bookDetail?.slug) await library.openBookData(book.slug);
			} catch (e) {
				dispatch({ type: "system", text: `重命名失败: ${friendlyError(e)}`, err: true });
			}
		},
		[bookDetail, library],
	);

	const deleteBook = useCallback(
		async (s: string) => {
			const remaining = books.filter((b) => b.slug !== s);
			try {
				await library.deleteBookData(s);
				if (s === bookDetail?.slug) {
					const next = remaining[0];
					if (next) await library.openBookData(next.slug);
					else library.clearBook();
				}
			} catch (e) {
				dispatch({ type: "system", text: `删除失败: ${friendlyError(e)}`, err: true });
			}
		},
		[books, bookDetail, library],
	);

	const importBook = useCallback(
		async (file: File) => {
			try {
				const book = await library.importBookData(file);
				await library.openBookData(book.slug);
			} catch (e) {
				dispatch({ type: "system", text: `导入失败: ${friendlyError(e)}`, err: true });
			}
		},
		[library],
	);

	// ---- 渲染辅助 ----
	const snap = stage.snapshot;
	const sceneId = snap?.sceneId ?? null;
	const script = snap?.script ?? null;
	const noScene = sceneId === null;
	const nextDisabled = busy || stage.turnPending || autoMode;
	const narratorActor = (actorId: string): boolean =>
		snap?.cast.actors.find((a) => a.id === actorId)?.type === "narrator";
	const phaseLabel: Record<StagePhaseDto, string> = {
		idle: "待命",
		casting: "筹备",
		running: "演出中",
		wrapping: "收尾中",
		closed: "已收幕",
	};
	const phaseCls: Record<StagePhaseDto, string> = {
		idle: "st-badge muted",
		casting: "st-badge amber",
		running: "st-badge amber",
		wrapping: "st-badge amber",
		closed: "st-badge muted",
	};
	const modeLabel: Record<StageModeDto, string> = {
		discussion: "讨论",
		scripting: "剧本",
		directing: "导演",
	};
	const castChars = script ? Object.values(script.definition.cast).map((c) => c[0] ?? "") : [];

	/** 提交反馈(/fix):长命令,经 stage_done 完成;续演回合的结束信号会恢复按钮。 */
	function submitFix() {
		if (feedbackFor === null || busy) return;
		const index = feedbackFor;
		const text = feedbackText.trim();
		setFeedbackFor(null);
		setFeedbackText("");
		if (text.length > 0) void runCommand("fix", { index, feedback: text });
	}

	function submitRevise(patch: ScriptPatchDto) {
		void runCommand("revise", { patch });
	}

	let entryNo = 0;
	return (
		<div className="stage-grid" style={{ "--stage-panel-w": `${panelWidth}px` } as React.CSSProperties}>
			<ChapterSidebar
				books={books}
				slug={bookDetail?.slug ?? null}
				chapters={bookDetail?.chapters ?? []}
				currentFile={currentChapter?.file ?? null}
				onSelectChapter={selectChapter}
				onNewChapter={() => void newChapter()}
				onSelectBook={selectBook}
				onNewBook={newBook}
				onExportBook={(s) => void library.exportBook(s).catch(() => {})}
				onRenameBook={renameBook}
				onDeleteBook={deleteBook}
				onImportBook={importBook}
				onRenameChapter={(ch, title) => void library.renameChapterData(ch, title).catch(() => {})}
				importing={importing}
				busySlug={busySlug}
				width={sidebarWidth}
				onResize={setSidebarWidth}
				collapsed={sidebarCollapsed}
				onToggleCollapse={toggleSidebarCollapsed}
				drawerOpen={drawerOpen}
				onClose={() => setDrawerOpen(false)}
			/>
			<div className="stage-main">
				{/* 场景头:窄屏书库抽屉开关 + 场景名 + 阶段/模式徽章 + 计数 + 导演最近一句 */}
				<div className="stage-head">
					{isNarrow && (
						<button
							type="button"
							className="ws-drawer-toggle"
							aria-label={drawerOpen ? "关闭书库" : "打开书库"}
							onClick={() => setDrawerOpen((d) => !d)}
						>
							书库
						</button>
					)}
					<span className={noScene ? "stage-scene idle" : "stage-scene"}>{snap?.script?.scene ?? "还没有一幕"}</span>
					{snap && <span className={phaseCls[snap.phase]}>{phaseLabel[snap.phase]}</span>}
					{snap && <span className="st-badge green">{modeLabel[snap.mode]}</span>}
					{snap && <span className="st-counts">{formatCounts(snap.counts)}</span>}
					{snap?.directorLast && <span className="st-dir-last">导演: {snap.directorLast.length > 60 ? `${snap.directorLast.slice(0, 60)}…` : snap.directorLast}</span>}
				</div>

				{/* 收幕进行中提示条(2026-08-11):导演整理回合结束(agent_settled)即撤,
				    编剧成文阶段不再提示;固定条不随滚动消失,用户一定能看到 */}
				{busyCmd === "cut" && !cutDirectorDone && (
					<div className="stage-editing">
						<span className="se-spin">✎</span>
						<span>导演正在编辑消息,请稍等…</span>
					</div>
				)}

				{/* 演出控制条:讨论阶段(无场景)整体隐藏,开演后出现 */}
				{!noScene && (
					<div className="stage-controls">
						<button type="button" className="btn st-next" disabled={nextDisabled} onClick={() => void runCommand("next")}>
							{autoMode ? "自动演中" : stage.turnPending ? "回合中…" : "▶ 下一步"}
						</button>
						<button
							type="button"
							className={autoMode ? "btn st-auto on" : "btn st-auto"}
							disabled={busy}
							onClick={() => {
								setAutoMode((v) => !v);
								void runCommand("auto");
							}}
						>
							自动演
						</button>
						<button type="button" className="btn" disabled={busy} onClick={() => void runCommand("wrap")}>
							收尾
						</button>
						<button type="button" className="btn" disabled={busy} onClick={() => void runCommand("retry")}>
							重演
						</button>
						<select
							className="st-select"
							disabled={!script || busy}
							value=""
							onChange={(e) => {
								const t = e.target.value;
								if (t) void runCommand("force", { target: t });
							}}
						>
							<option value="">强制发言 ▾</option>
							{castChars.map((c) => (
								<option key={c} value={c}>
									{c}
								</option>
							))}
						</select>
						<span className="st-seg">
							{([1, 2, 3] as const).map((l) => (
								<button
									type="button"
									key={l}
									className={thoughts === l ? "active" : ""}
									disabled={busy}
									onClick={() => {
										setThoughts(l);
										void runCommand("thoughts", { level: l });
									}}
								>
									档{l}
								</button>
							))}
						</span>
						<span className="st-spacer" />
						<button type="button" className="btn" disabled={busy} onClick={() => setTab("revise")}>
							修订
						</button>
						<button type="button" className="btn danger" disabled={busy} onClick={() => void runCommand("cut")}>
							收幕
						</button>
						{busy && <span className="st-busy">长命令进行中…</span>}
					</div>
				)}

				{/* 舞台流:演出前 = 讨论室(引导卡居上 + 导演对话);演出中 = 条目 + 系统行
				    (导演对话隐藏,主区让给演员);收幕后 = 条目归档、导演对话恢复 */}
				<div className="stage-scroll">
					{/* 引导卡只在「无场景 + 导演对话为空」时显示:发出第一条消息后(导演对话
					    有水合/回显内容)即隐藏,让主区让给对话流 */}
					{noScene && directorSession.messages.length === 0 && (
						<div className="guide-card">
							<div className="g-title">◇ 与导演共谋一幕</div>
							<div className="g-line">
								和导演聊聊你的故事:<b>人物、悬念、基调</b>。导演会边聊边维护世界书;你想好剧本后,示意「
								<b>写剧本</b>」,导演会用工具开演。
							</div>
							<div className="guide-steps">
								<span className="g-step on">① 讨论剧情</span>
								<span className="g-step">② 导演写剧本</span>
								<span className="g-step">③ 开演</span>
								<span className="g-step">④ 收幕成文 → 去编辑页</span>
							</div>
						</div>
					)}
					{/* 收幕后舞台流归档:演员条目/系统行隐藏,主区恢复导演对话 */}
					{snap?.phase !== "closed" &&
						stage.feed.map((item, i) => {
						if (item.type === "entry") {
							entryNo++;
							const e = item.entry;
							const narr = narratorActor(e.actor);
							return (
								<Fragment key={i}>
									<div className="st-entry">
										<span className="st-idx">{String(entryNo).padStart(2, "0")}</span>
										<StageAvatar slug={slug ?? ""} name={e.character} narrator={narr} img={snap?.avatars[e.character] ?? null} />
										<span className={narr ? "st-name narr" : "st-name"}>{e.character}</span>
										<span className={narr ? "st-text narr" : "st-text"}>{stageEntryText(e)}</span>
										<span className="st-actions">
											<button type="button" onClick={() => setFeedbackFor(entryNo)}>
												反馈
											</button>
										</span>
									</div>
									{feedbackFor === entryNo && (
										<div className="st-feedback">
											<textarea
												autoFocus
												placeholder={`反馈第 ${entryNo} 条 — 导演将修订剧本并从此处续演`}
												value={feedbackText}
												onChange={(e) => setFeedbackText(e.target.value)}
											/>
											<div className="st-feedback-actions">
												<button type="button" className="btn primary" disabled={busy || !feedbackText.trim()} onClick={submitFix}>
													提交反馈
												</button>
												<button type="button" className="btn" onClick={() => setFeedbackFor(null)}>
													取消
												</button>
											</div>
										</div>
									)}
								</Fragment>
							);
						}
						if (item.type === "system") {
							return (
								<div key={i} className={item.err ? "notice err" : "notice"}>
									{item.text}
								</div>
							);
						}
						return null;
					})}
						{/* 导演对话(2026-08-11 统一重构):与编剧/主会话同款 MessageList——
					    思考折叠/流式/工具卡片复用同一套渲染,零新逻辑。
					    演出中(running/wrapping)隐藏,主区让给舞台流;收幕后恢复 */}
					{snap?.phase !== "running" && snap?.phase !== "wrapping" && (
						<MessageList
							messages={directorSession.messages}
							streaming={directorSession.isStreaming}
							simplifiedTools={simplifiedTools === true}
							emptyText="向导演发一句话,讨论剧情、人物与悬念——导演会边聊边维护世界书"
						/>
					)}
					{/* 导演世界书编辑预览卡:world_update 变更的 diff/关系图(最新一次) */}
					{worldPreview && <PreviewCard data={worldPreview} />}
					{/* 剧本确认门(2026-08-11):导演 script_confirm 提交后,确认卡紧跟对话末尾。
					    对话区不被压缩靠 chat-scroll 取消 flex:1(自然高度,整列滚动),
					    卡片自身仍在文档流里 */}
					{scriptConfirm && !confirmDismissed && (
						<PreviewCard
							data={{ kind: "script", toolName: "script_confirm", sceneId: scriptConfirm.sceneId, script: scriptConfirm.script }}
							actions={
								scriptConfirm.confirmed ? (
									<span className="preview-note">已确认,等待导演开演…</span>
								) : (
									<>
										<button type="button" className="btn primary" disabled={busy} onClick={() => void confirmScript()}>
											确认开演
										</button>
										<button
											type="button"
											className="btn"
											onClick={() => {
												setConfirmDismissed(true);
												dispatch({ type: "system", text: "在下方对话里告诉导演要修改哪里,导演会用 script_confirm 重新提交。" });
											}}
										>
											需要修改
										</button>
									</>
								)
							}
						/>
					)}
				</div>

					{/* 收幕完成提示条:固定底部、一眼可见(不随滚动流淹没,2026-08-13)——
					   成文已写入草稿,主操作「去编辑页看成文」始终在视野内 */}
					{snap?.phase === "closed" && (
						<div className="stage-done-bar">
							<span className="sd-bar-icon">✓</span>
							<span className="sd-bar-text">一幕完成 · 舞台记录已由编剧成文写入章节草稿</span>
							<span className="sd-bar-spacer" />
							<button type="button" className="btn primary" onClick={() => onGoEdit?.()}>
								去编辑页看成文
							</button>
						</div>
					)}

					{/* 导演输入条(演出前后都是唯一活跃交互;InputBar 自带容器样式) */}
				<InputBar
					streaming={false}
					onSend={sendDirector}
					onAbort={() => {}}
					placeholder="向导演说话…(Ctrl+Enter 发送,Enter 换行;演出前聊剧情,演出中可插话/反馈)"
					ariaLabel="向导演说话"
				/>
			</div>
			<aside className="stage-panel">
				{/* 左缘拖拽调宽手柄(窄屏面板收起时隐藏) */}
				{!isNarrow && <div className="sp-resize" onMouseDown={onPanelResizeStart} title="拖拽调整宽度" />}
				<StagePanel client={client} slug={slug ?? ""} snapshot={snap} tab={tab} onTab={setTab} onRevise={submitRevise} />
			</aside>
		</div>
	);
}
