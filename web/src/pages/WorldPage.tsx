import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { useCrossWindowReload } from "../cross-window-sync.ts";
import type { ChapterRef, WorldDataDto, WorldEntryDto } from "../types.ts";
import { DUR, EASE } from "../motion.ts";
import { newId } from "../components/id.ts";
import { ENTRY_TYPES, ENTRY_TYPE_LABELS, WorldTree } from "../components/WorldTree.tsx";
import { EntryForm } from "../components/EntryForm.tsx";
import { RelationGraph } from "../components/RelationGraph.tsx";
import { EntryCard } from "../components/EntryCard.tsx";
import { NoticePanel } from "../components/NoticePanel.tsx";
import { WorldSummaryPanel } from "../components/WorldSummaryPanel.tsx";
import { StorylinePanel } from "../components/StorylinePanel.tsx";
import { TimelinePanel } from "../components/TimelinePanel.tsx";
import { ConstraintsPanel } from "../components/ConstraintsPanel.tsx";
import { deleteEntryWithRelations } from "../graph-logic.ts";

/**
 * 世界书页(条目化管理后台):「列表」视图 = 左侧分类树(按 type 分组 + parent 层级)
 * + 右侧条目表单(增删改)+ Notice/发展线/时间线/约束/采样面板;
 * 「关系图」视图 = cytoscape 关系图 + 词条面板(百度百科式,跳转联动高亮),
 * 连线/关系编辑同样落到本地工作副本。所有修改置脏,「保存」整体走 putWorld;
 * 保存后服务端自动重渲染 md 视图,无需前端处理。无源文件编辑入口。
 */
export function WorldPage({
	client,
	slug,
	active,
}: {
	client: ApiClient;
	slug: string | null;
	/** 页面是否处于激活显示状态(三页常驻挂载,由 App 上报视图切换)。 */
	active?: boolean;
}) {
	/** null = 尚未加载成功(或加载失败)。 */
	const [world, setWorld] = useState<WorldDataDto | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const [selId, setSelId] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saveErr, setSaveErr] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** 当前书章节(条目关联章节多选 / 时间线 chapter 下拉)。 */
	const [chapters, setChapters] = useState<ChapterRef[]>([]);
	const [chaptersOk, setChaptersOk] = useState(false);
	const [createType, setCreateType] = useState<WorldEntryDto["type"]>("character");
	const [createTitle, setCreateTitle] = useState("");
	/** 视图切换:列表(分类树 + 表单)⇄ 关系图(cytoscape + 词条面板)。 */
	const [view, setView] = useState<"list" | "graph">("list");
	/** 简要世界观面板折叠态(localStorage 持久化;折叠时整块隐藏,开关在顶栏)。 */
	const [summaryCollapsed, setSummaryCollapsed] = useState(() => localStorage.getItem("pi-writer:world-summary-collapsed") === "1");
	useEffect(() => {
		localStorage.setItem("pi-writer:world-summary-collapsed", summaryCollapsed ? "1" : "0");
	}, [summaryCollapsed]);
	/** 正在滑出的旧视图(切换动画期间置位,240ms 后清理;内容双常驻保留状态)。 */
	const [leaving, setLeaving] = useState<"list" | "graph" | null>(null);
	/** 视图切换:旧视图播放向左滑出,新视图自右滑入。 */
	function switchView(v: "list" | "graph") {
		if (v === view || leaving !== null) return;
		setLeaving(view);
		setView(v);
		setTimeout(() => setLeaving(null), DUR.base * 1000 + 40);
	}
	/** 撤销栈深度(渲染信号:工具栏撤销按钮禁用态)。 */
	const [undoCount, setUndoCount] = useState(0);

	const worldRef = useRef<WorldDataDto | null>(null);
	worldRef.current = world;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	/** 最近一次加载/保存成功时的磁盘文件 mtime(If-Match 条件写依据;0 = 未知)。 */
	const lastWorldMtimeRef = useRef(0);
	/** 撤销栈:保存"修改前"的世界快照;编辑会话(干净→脏)开始时入栈。 */
	const undoStack = useRef<WorldDataDto[]>([]);
	/** 自动保存防抖计时器(输入停止后提交)。 */
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const MAX_UNDO = 50;

	// 拉取世界书与当前书章节;slug 变化(换书)或进入页面时重新加载
	useEffect(() => {
		if (!slug) return;
		let cancelled = false;
		setLoadErr(null);
		void client
			.getWorld()
				.then((r) => {
					if (cancelled) return;
					// 重载 GET 返回时用户已开始编辑(脏):保留本地修改,放弃重载
					// (旧版上的编辑保存时由 If-Match 409 兜底,不会静默覆盖)
					if (dirtyRef.current) return;
					setWorld(r.world);
					setDirty(false);
					lastWorldMtimeRef.current = r.mtime; // 磁盘版本,保存时作 If-Match
					// 换书/重载后旧撤销快照失效:清空
					undoStack.current = [];
					setUndoCount(0);
				// 保持选中;被删/不存在则清空
				setSelId((prev) => (prev && r.world.entries.some((e) => e.id === prev) ? prev : null));
			})
			.catch((e) => {
				if (cancelled) return;
				setWorld(null);
				setLoadErr(`世界书加载失败: ${friendlyError(e)}`);
			});
		void client
			.getBook(slug)
			.then((b) => {
				if (cancelled) return;
				setChapters(b.chapters);
				setChaptersOk(true);
			})
			.catch(() => {
				if (cancelled) return;
				setChaptersOk(false);
			});
		return () => {
			cancelled = true;
		};
	}, [client, slug, reloadKey]);

	/** 整体保存;失败显示服务端错误(friendlyError 映射)。If-Match 条件写:
	 *  磁盘 mtime 已变(其他窗口/AI 已改)时 409,提示后重载收敛。 */
	async function save() {
		if (!worldRef.current || !dirtyRef.current || saving) return;
		setSaving(true);
		setSaveErr(null);
		try {
			const mtime = await client.putWorld(worldRef.current, lastWorldMtimeRef.current || undefined);
			setDirty(false);
			if (mtime > 0) lastWorldMtimeRef.current = mtime;
			markSaved(); // 记录保存时间:自己的回显(1s 内)跳过
		} catch (e) {
			setSaveErr(`保存失败: ${friendlyError(e)}`);
		} finally {
			setSaving(false);
		}
	}

	const saveRef = useRef(save);
	saveRef.current = save;

	/**
	 * 页面激活(从其他页切到世界书)时刷新:AI/其他窗口可能刚改过 world.json,
	 * watcher 广播有 ≤1s 延迟——不刷新就在旧版本上编辑,迟到的 world_changed
	 * 会把「AI 改完我才编辑」误报成冲突。已有未保存修改(脏)时不刷新(保留本地)。
	 */
	const prevActiveRef = useRef(active);
	useEffect(() => {
		if (active && !prevActiveRef.current && !dirtyRef.current) {
			setReloadKey((k) => k + 1);
		}
		prevActiveRef.current = active;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	/**
	 * 多窗口同步:其他窗口保存了世界书时,world_changed 事件到达。
	 * 干净 → 重载(与其他窗口收敛,撤销栈随重载清空);脏 → 提示冲突不重载
	 * (不覆盖未保存修改);自己保存的回显(1s 内)跳过。
	 * (决策逻辑收敛于 useCrossWindowReload,见 cross-window-sync.ts)
	 */
	const markSaved = useCrossWindowReload({
		client,
		eventType: "world_changed",
		// 无 slug(无会话)时不响应,与旧实现 `if (!slug) return` 等价
		matches: (e) => !!slug && (!e.slug || e.slug === slug),
		state: () => (dirtyRef.current ? "dirty" : "clean"),
		onConflict: () => {
			// 外部变更可能来自其他窗口保存,也可能来自 AI 的 world_update 工具
			// (直接写文件,经 watcher 识别为外部变更)——文案不特指「其他窗口」
			setSaveErr("世界书已被其他窗口或 AI 修改,保存将覆盖");
		},
		onReload: () => {
			setSaveErr(null);
			setReloadKey((k) => k + 1);
		},
	});

	/** 不可变更新工作副本并置脏;任何失败提示随下次编辑清除。 */
	function updateWorld(fn: (w: WorldDataDto) => WorldDataDto) {
		// 从干净状态进入编辑:记录撤销点(修改前的快照),输入会话合并为一个撤销步骤
		if (!dirtyRef.current && worldRef.current) {
			undoStack.current.push(structuredClone(worldRef.current));
			if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
			setUndoCount(undoStack.current.length);
		}
		setWorld((w) => (w ? fn(w) : w));
		setDirty(true);
		setSaveErr(null);
		scheduleAutoSave();
	}

	/** 输入停止 AUTO_SAVE_MS 后自动保存(节点自动保存:编辑无需手动点保存)。 */
	function scheduleAutoSave() {
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		autoSaveTimer.current = setTimeout(() => void saveRef.current(), 800);
	}

	/** 撤销最近一次编辑会话(恢复快照并立即保存)。 */
	function undo() {
		const prev = undoStack.current.pop();
		if (!prev) return;
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		// React 状态异步生效:save() 的守卫读 ref,必须先同步 refs,否则
		// worldRef 还是旧副本、dirtyRef 还是 false,立即保存会被跳过
		worldRef.current = prev;
		dirtyRef.current = true;
		setWorld(prev);
		setDirty(true);
		setSaveErr(null);
		setUndoCount(undoStack.current.length);
		// 恢复的快照里可能没有当前选中条目:清空失效选中
		setSelId((cur) => (cur && prev.entries.some((e) => e.id === cur) ? cur : null));
		void saveRef.current();
	}

	/** Ctrl+Z 处理器经 ref 传递:keydown 监听只注册一次,始终调用最新 undo。 */
	const undoRef = useRef(undo);
	undoRef.current = undo;

	/** 条目字段变更(表单行内编辑)。 */
	function changeEntry(next: WorldEntryDto) {
		updateWorld((w) => ({
			...w,
			entries: w.entries.map((e) => (e.id === next.id ? { ...next, updatedAt: Date.now() } : e)),
		}));
	}

	/** 新增条目(默认值),定位到新条目便于编辑。 */
	function createEntry() {
		const title = createTitle.trim();
		if (!title || !world) return;
		const entry: WorldEntryDto = {
			id: newId("entry"),
			type: createType,
			title,
			keys: [],
			chapters: [],
			status: "active",
			active: true,
			parent: null,
			tags: [],
			body: "",
			avatar: null,
			images: [],
			updatedAt: Date.now(),
		};
		updateWorld((w) => ({ ...w, entries: [...w.entries, entry] }));
		setSelId(entry.id);
		setCreateTitle("");
	}

	/** 删除条目:其子条目的 parent 清空(转根条目),相关关系一并移除(后端校验要求)。 */
	function deleteEntry(id: string) {
		updateWorld((w) => {
			const next = deleteEntryWithRelations(w.entries, w.relations, id);
			return { ...w, entries: next.entries, relations: next.relations };
		});
		setSelId((prev) => (prev === id ? null : prev));
	}

	// Ctrl+S 立即保存;Ctrl+Z 撤销(输入框聚焦时交给浏览器原生撤销,不拦截)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
			if (e.ctrlKey && e.key === "s") {
				e.preventDefault();
				void saveRef.current();
			} else if (e.ctrlKey && e.key === "z" && !inField && undoStack.current.length > 0) {
				e.preventDefault();
				undoRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// 卸载时取消未执行的自动保存
	useEffect(() => {
		return () => {
			if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		};
	}, []);

	// 无会话:仅提示,不渲染界面(所有 hooks 已先于本分支执行)
	if (slug === null) {
		return <div className="world-noslug">请先在写作页打开一本书</div>;
	}

	const selEntry = world ? (world.entries.find((e) => e.id === selId) ?? null) : null;

	return (
		<>
			{world === null ? (
				<div className="world-loading">
					{loadErr ? (
						<div className="notice err">
							{loadErr}
							<button type="button" className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
								重试
							</button>
						</div>
					) : (
						"世界书加载中…"
					)}
				</div>
			) : (
				<AnimatePresence initial={false}>
					{view === "list" && (
						/* 树随视图切换:宽度收缩滑出/滑入(flex 布局下纸张区平滑让位) */
						<motion.div
							key="world-tree"
							className="world-tree-wrap"
							initial={{ width: 0, opacity: 0 }}
							animate={{ width: 240, opacity: 1 }}
							exit={{ width: 0, opacity: 0 }}
							transition={{ duration: DUR.base, ease: EASE.out }}
						>
							<WorldTree entries={world.entries} selId={selId} onSelect={setSelId} />
						</motion.div>
					)}
				</AnimatePresence>
			)}
			<section className="world-body">
				<div className="w-bar">
					<span className="w-file">世界书 · 条目管理</span>
					<button
						type="button"
						className={summaryCollapsed ? "w-summary-toggle" : "w-summary-toggle on"}
						onClick={() => setSummaryCollapsed((c) => !c)}
						title={summaryCollapsed ? "展开简要世界观" : "折叠简要世界观"}
					>
						简要世界观 {summaryCollapsed ? "▸" : "▾"}
					</button>
					<div className="w-view-tabs">
						<button
							type="button"
							className={view === "list" ? "w-view-tab active" : "w-view-tab"}
							onClick={() => switchView("list")}
						>
							列表
						</button>
						<button
							type="button"
							className={view === "graph" ? "w-view-tab active" : "w-view-tab"}
							onClick={() => switchView("graph")}
						>
							关系图
						</button>
					</div>
					<span className={dirty ? "w-dirty on" : "w-dirty"}>{dirty ? "● 未保存" : "✓ 已保存"}</span>
					<button type="button" className="w-save" disabled={!dirty || saving} onClick={() => void save()}>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
				{world !== null && !summaryCollapsed && (
					<WorldSummaryPanel
						summary={world.worldSummary}
						onChange={(v) => updateWorld((w) => ({ ...w, worldSummary: v }))}
					/>
				)}
				{saveErr && <div className="notice err">{saveErr}</div>}
				{world === null ? (
					<div className="world-scroll">
						<div className="w-empty">世界书加载中…</div>
					</div>
				) : (
					/* 视图舞台:列表/关系图双常驻叠放(切换保留表单输入与滚动位置,
					   关系图 cytoscape 容器恒有尺寸),active 自右滑入、leaving 向左滑出 */
					<div className="world-stage">
						<div
							className={
								view === "list" ? "world-scroll active" : leaving === "list" ? "world-scroll leaving" : "world-scroll"
							}
						>
							<>
								<form
									className="w-add"
									onSubmit={(e) => {
										e.preventDefault();
										createEntry();
									}}
								>
									<span className="w-add-head">新增条目</span>
									<select value={createType} onChange={(e) => setCreateType(e.target.value as WorldEntryDto["type"])} title="条目类型">
										{ENTRY_TYPES.map((t) => (
											<option key={t} value={t}>
												{ENTRY_TYPE_LABELS[t]}
											</option>
										))}
									</select>
									<input
										value={createTitle}
										onChange={(e) => setCreateTitle(e.target.value)}
										placeholder="条目标题"
									/>
									<button type="submit" className="w-add-btn" disabled={createTitle.trim() === ""}>
										添加
									</button>
								</form>
								{selEntry ? (
									<EntryForm
										key={selEntry.id}
										entry={selEntry}
										entries={world.entries}
										chapters={chapters}
										chaptersOk={chaptersOk}
										slug={slug}
										onChange={changeEntry}
										onDelete={() => deleteEntry(selEntry.id)}
									/>
								) : (
									<div className="w-empty">选择左侧条目进行编辑</div>
								)}
								<NoticePanel notice={world.notice} onChange={(n) => updateWorld((w) => ({ ...w, notice: n }))} />
								<StorylinePanel
									storyline={world.storyline}
									onChange={(s) => updateWorld((w) => ({ ...w, storyline: s }))}
								/>
								<TimelinePanel
									events={world.timeline}
									chapters={chapters}
									chaptersOk={chaptersOk}
									onChange={(t) => updateWorld((w) => ({ ...w, timeline: t }))}
								/>
								<ConstraintsPanel
									constraints={world.constraints}
									sample={world.styleSample}
									onConstraints={(c) => updateWorld((w) => ({ ...w, constraints: c }))}
									onSample={(s) => updateWorld((w) => ({ ...w, styleSample: s }))}
									/>
								</>
						</div>
						<div
							className={
								view === "graph"
									? "world-graph-view active"
									: leaving === "graph"
										? "world-graph-view leaving"
										: "world-graph-view"
							}
						>
							<RelationGraph
								entries={world.entries}
								relations={world.relations}
								slug={slug}
								focusId={selId}
								onSelect={setSelId}
								onUpdateRelations={(next) => updateWorld((w) => ({ ...w, relations: next }))}
								onUpdateEntry={changeEntry}
								onDeleteEntry={deleteEntry}
								canUndo={undoCount > 0}
								onUndo={undo}
							/>
						{selEntry ? (
							<EntryCard
								key={selEntry.id}
								entry={selEntry}
								entries={world.entries}
								relations={world.relations}
								slug={slug}
								client={client}
							onJump={setSelId}
							onChange={changeEntry}
							onClose={() => setSelId(null)}
							/>
						) : (
							<aside className="entry-card entry-card-hint">
								<div>点击图中节点查看词条详情</div>
							</aside>
						)}
						</div>
					</div>
				)}
			</section>
		</>
	);
}
