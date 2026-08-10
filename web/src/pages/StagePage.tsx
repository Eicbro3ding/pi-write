import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import type { Library } from "../library.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import type { AgentEventDto, ChapterRef, ScriptPatchDto, StageModeDto, StagePhaseDto, StageSnapshotDto } from "../types.ts";
import { formatCounts, initialStageState, reduceStage, stageEntryText } from "../stage-web.ts";
import { ChapterSidebar } from "../components/ChapterSidebar.tsx";
import { InputBar } from "../components/InputBar.tsx";
import { PreviewCard } from "../components/PreviewCard.tsx";
import { StageAvatar } from "../components/StageAvatar.tsx";
import { StagePanel, type StagePanelTab } from "../components/StagePanel.tsx";
import { ThinkingBlock } from "../components/MessageList.tsx";
import { createEditCapture } from "../edit-capture.ts";
import { renderMarkdown } from "../markdown.ts";
import type { PreviewData } from "../preview.ts";

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
}: {
	client: ApiClient;
	/** 书库状态唯一真相源(App 持有,与编辑页共用——书库栏两页常驻且状态同步)。 */
	library: Library;
	/** 页面是否处于激活显示状态(四页常驻挂载,由 App 上报视图切换)。 */
	active?: boolean;
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

	/** 面板拖拽调宽:按下后在 window 上监听移动,宽度随鼠标横向位移受限于 [280, 520]。 */
	function startPanelResize(e: React.MouseEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = panelWidth;
		const move = (ev: MouseEvent) => {
			const w = Math.max(280, Math.min(520, startW - (ev.clientX - startX)));
			setPanelWidth(w);
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			document.body.style.cursor = "";
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
		document.body.style.cursor = "col-resize";
	}

	// ---- 快照拉取(书切换 / 页面激活 / SSE 重连时对齐) ----
	// 失败自动重试一次(1.2s 后):网络瞬断/服务刚重启时,首次拉取失败会导致
	// 对话历史(directorChat)恢复不了、气泡看起来「丢了」——重试保证收敛
	const refresh = useCallback(async () => {
		if (!slug) return;
		try {
			dispatch({ type: "snapshot", snapshot: await client.getStage(slug) });
		} catch (e) {
			try {
				await new Promise((r) => setTimeout(r, 1200));
				dispatch({ type: "snapshot", snapshot: await client.getStage(slug) });
			} catch (e2) {
				dispatch({ type: "system", text: `舞台快照拉取失败: ${friendlyError(e2)}`, err: true });
			}
		}
	}, [slug, client]);

	/** 上次对齐的书(切书时整体重置舞台流——快照的 local 保留逻辑只适合同书
	 *  对齐(重连/刷新),跨书会残留旧书对话行 = 「串对话」根因,2026-08-10)。 */
	const lastSlugRef = useRef<string | null>(null);
	useEffect(() => {
		if (lastSlugRef.current !== slug) {
			lastSlugRef.current = slug;
			dispatch({ type: "reset" });
		}
		void refresh();
	}, [refresh, slug]);

	useEffect(() => {
		if (active) void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// ---- SSE:只消费本 slug 的舞台事件 ----
	useEffect(() => {
		if (!slug) return;
		const unsub = client.subscribeEvents(
			(e) => {
				if (e.type === "stage_entry" && e.slug === slug) dispatch({ type: "entry", entry: e.entry });
				else if (e.type === "stage_system" && e.slug === slug) dispatch({ type: "system", text: e.text });
				else if (e.type === "stage_done" && e.slug === slug) {
					dispatch({ type: "done", cmd: e.cmd, ok: e.ok, text: e.text, thinking: e.thinking });
				} else if (e.type === "stage_tool_start" && e.slug === slug) {
					handleStageToolStart(e);
				} else if (e.type === "stage_tool_end" && e.slug === slug) {
					void handleStageToolEnd(e);
				} else if (e.type === "stage_director_text" && e.slug === slug) {
					// 导演回复流式(完整文本):reducer 替换流式气泡
					dispatch({ type: "director_text", text: e.text });
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
				const res = await client.stageCommand(slug, cmd, args);
				if (res.async) {
					dispatch({ type: "busy", cmd });
				} else if (cmd === "next" || cmd === "retry") {
					dispatch({ type: "wake" });
				}
			} catch (e) {
				dispatch({ type: "system", text: `命令失败: ${friendlyError(e)}`, err: true });
			}
		},
		[slug, client],
	);

	// ---- 导演世界书编辑预览卡(舞台流内):导演用 world_update/write 维护世界书时,
	// 实时展示变更(关系图高亮 / 词条卡片)。捕获/组装复用共享编辑捕获器
	// (与编剧确认卡同一套 before/after 逻辑),页面层只保留「单张最新预览」容器。
	const [worldPreview, setWorldPreview] = useState<PreviewData | null>(null);
	const stageCapture = useMemo(() => createEditCapture(client, () => slug), [client, slug]);

	function handleStageToolStart(e: Extract<AgentEventDto, { type: "stage_tool_start" }>) {
		stageCapture.handleStart(e.toolCallId, e.toolName, e.args);
	}

	async function handleStageToolEnd(e: Extract<AgentEventDto, { type: "stage_tool_end" }>) {
		const edit = await stageCapture.handleEnd(e.toolCallId, e.isError);
		if (edit?.kind === "world") setWorldPreview(edit.data); // 导演预览只展示世界书变更
	}

	/** 向导演说话:乐观上气泡,长命令(director)进行中禁止。 */
	function sendDirector(text: string) {
		if (!slug || busy) return;
		dispatch({ type: "user", text });
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

				{/* 舞台流:演出前 = 讨论室(引导卡居上 + 导演对话);演出中 = 条目 + 系统行 + 导演对话 */}
				<div className="stage-scroll">
					{noScene && (
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
					{stage.feed.map((item, i) => {
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
						if (item.type === "user") {
							return (
								<div key={i} className="chat-bubble user">
									<span className="who">你</span>
									<div className="body">{item.text}</div>
								</div>
							);
						}
						return (
							<div key={i} className="chat-bubble director">
								<span className="who">
									<StageAvatar slug={slug ?? ""} name="导演" size="xs" />
									导演
								</span>
								{/* 思考折叠 + 正文都在气泡卡内(思考在内部,不悬在气泡外);
								    快照恢复的 thinking 已结束,不显示计时 */}
								<div className="body">
									{item.thinking && <ThinkingBlock text={item.thinking} done />}
									<div className="record-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
								</div>
							</div>
						);
					})}
					{/* 导演世界书编辑预览卡:world_update 变更的 diff/关系图(最新一次) */}
					{worldPreview && <PreviewCard data={worldPreview} />}
				</div>

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
				{!isNarrow && <div className="sp-resize" onMouseDown={startPanelResize} title="拖拽调整宽度" />}
				<StagePanel slug={slug ?? ""} snapshot={snap} tab={tab} onTab={setTab} onRevise={submitRevise} />
			</aside>
		</div>
	);
}
