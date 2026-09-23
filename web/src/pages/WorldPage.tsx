import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ApiError, type ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { useCrossWindowReload } from "../cross-window-sync.ts";
import type { ChapterRef, WorldDataDto, WorldEntryDto } from "../types.ts";
import { DUR, EASE } from "../motion.ts";
import { newId } from "../components/id.ts";
import { WorldTree } from "../components/WorldTree.tsx";
import { Lu } from "../components/Lu.tsx";
import { EntryForm, EntryInfoPanel } from "../components/EntryForm.tsx";
import { RelationGraph } from "../components/RelationGraph.tsx";
import { EntryCard } from "../components/EntryCard.tsx";
import { WorldSummaryPanel } from "../components/WorldSummaryPanel.tsx";
import { StorylinePanel } from "../components/StorylinePanel.tsx";
import { TimelinePanel } from "../components/TimelinePanel.tsx";
import { ConstraintsPanel, StyleSamplePanel } from "../components/ConstraintsPanel.tsx";
import { deleteEntryWithRelations } from "../graph-logic.ts";

/** 世界书三个视图(设计稿 08/09/10 右上角分段胶囊)。 */
type WorldView = "entries" | "graph" | "settings";

/**
 * 世界书页:「条目」视图 = 左侧分类树(240)+ 中间条目表单 + 右侧信息栏(300);
 * 「关系图」视图 = cytoscape 关系图 + 选中条目详情卡;「设定」视图 = 独立一屏两栏
 * 卡片(简要世界观/发展线/采样 | 时间线/约束)。
 * 数据侧不变:world.json 读写、条目增删改、关系增删、图位置持久化全部原样,
 * 所有修改置脏后整体走 putWorld(自动保存 + Ctrl+S),保存后服务端重渲染 md 视图。
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
	/** 新建条目(入口在分类树底部):类型 + 标题内联创建行。 */
	const [creating, setCreating] = useState(false);
	const [createType, setCreateType] = useState<WorldEntryDto["type"]>("character");
	const [createTitle, setCreateTitle] = useState("");
	/** 删除二次确认模态(设计稿 04)的目标条目;ref 供 keydown(Escape)读取最新值。 */
	const [confirmDelete, setConfirmDelete] = useState<WorldEntryDto | null>(null);
	const confirmDeleteRef = useRef<WorldEntryDto | null>(confirmDelete);
	confirmDeleteRef.current = confirmDelete;
	/** 视图:条目 / 关系图 / 设定。 */
	const [view, setView] = useState<WorldView>("entries");
	/** 关系图视图懒挂载(P7,2026-08):首次切到关系图才构建 cytoscape——大世界书
	 *  只开条目页时省去建图 + 布局成本。已挂载后保持常驻(切走再切回不丢图内
	 *  选中/连线/右键态;缩放平移另有 localStorage 持久化,见 graph-persistence)。 */
	const [graphMounted, setGraphMounted] = useState(false);
	/** 正在滑出的旧视图(切换动画期间置位,240ms 后清理;内容双常驻保留状态)。 */
	const [leaving, setLeaving] = useState<WorldView | null>(null);
	/** 视图切换:旧视图播放向左滑出,新视图自右滑入。首次切到关系图时挂载图视图。 */
	function switchView(v: WorldView) {
		if (v === view || leaving !== null) return;
		if (v === "graph") setGraphMounted(true);
		setLeaving(view);
		setView(v);
		setTimeout(() => setLeaving(null), DUR.base * 1000 + 40);
	}
	/** 撤销/重做栈深度(渲染信号:工具栏按钮禁用态)。 */
	const [undoCount, setUndoCount] = useState(0);
	const [redoCount, setRedoCount] = useState(0);

	const worldRef = useRef<WorldDataDto | null>(null);
	worldRef.current = world;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	/** 编辑序号:save() 用它判断「保存期间是否又改过」,避免清掉未落盘的脏标记(2026-09-23)。 */
	const editSeqRef = useRef(0);
	/** 最近一次加载/保存成功时的磁盘文件 mtime(If-Match 条件写依据;0 = 未知)。 */
	const lastWorldMtimeRef = useRef(0);
	/** 撤销栈:保存"修改前"的世界快照;编辑会话(干净→脏)开始时入栈。 */
	const undoStack = useRef<WorldDataDto[]>([]);
	/** 重做栈:撤销时把"撤销前"的快照压入;任何新编辑清空。 */
	const redoStack = useRef<WorldDataDto[]>([]);
	/** 自动保存防抖计时器(输入停止后提交)。 */
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const MAX_UNDO = 50;

	// 拉取世界书与当前书章节;slug 变化(换书)或进入页面时重新加载
	useEffect(() => {
		if (!slug) return;
		let cancelled = false;
		setLoadErr(null);
		void client
			.getWorld(slug)
				.then((r) => {
					if (cancelled) return;
					// 重载 GET 返回时用户已开始编辑(脏):保留本地修改,放弃重载
					// (旧版上的编辑保存时由 If-Match 409 兜底,不会静默覆盖)
					if (dirtyRef.current) {
						// 但**必须采纳磁盘的新 mtime**(2026-09-23)。否则 409 之后本地
						// 一直拿旧 mtime 去 If-Match,每次保存都 409,而重载又因为脏而
						// 跳过 —— 用户除 F5 之外没有出路(实测:AI 写过 world.json 后
						// 页面彻底存不进去)。采纳新 mtime 后,下一次保存=覆盖外部改动,
						// 正是冲突条文案「保存将覆盖」承诺的行为。
						lastWorldMtimeRef.current = r.mtime;
						return;
					}
					setWorld(r.world);
					setDirty(false);
					lastWorldMtimeRef.current = r.mtime; // 磁盘版本,保存时作 If-Match
					// 换书/重载后旧撤销快照失效:清空
					undoStack.current = [];
					redoStack.current = [];
					setUndoCount(0);
					setRedoCount(0);
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
		// 保存期间用户又改了没?改了就别把脏标记清掉(2026-09-23):
		// 此前无条件 setDirty(false),而这次编辑触发的防抖 save() 又被 `saving` 挡掉,
		// 于是那笔改动既没写盘、也不再显示「未保存」,静默丢失。
		const seqAtStart = editSeqRef.current;
		setSaving(true);
		setSaveErr(null);
		try {
			const mtime = await client.putWorld(worldRef.current, lastWorldMtimeRef.current || undefined, slug ?? undefined);
			if (mtime > 0) lastWorldMtimeRef.current = mtime;
			markSaved(); // 记录保存时间:自己的回显(1s 内)跳过
			if (editSeqRef.current === seqAtStart) {
				setDirty(false);
			} else {
				// 还有新改动没落盘:排下一轮把它写下去(脏标记保持 true)
				scheduleAutoSave();
			}
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				// 磁盘被外部改过。借一次重载把新 mtime 拿回来(脏状态只采纳 mtime、不动内容),
				// 这样用户再按一次保存就能覆盖,而不是每次都被 409 挡回去(2026-09-23)
				setSaveErr("世界书已被其他窗口或 AI 修改;再保存一次将以本地版本覆盖");
				setReloadKey((k) => k + 1);
			} else {
				setSaveErr(`保存失败: ${friendlyError(e)}`);
			}
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
		// 从干净状态进入编辑:记录撤销点(修改前的快照),输入会话合并为一个撤销步骤;
		// 新编辑使重做栈失效
		if (!dirtyRef.current && worldRef.current) {
			undoStack.current.push(structuredClone(worldRef.current));
			if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
			setUndoCount(undoStack.current.length);
			redoStack.current = [];
			setRedoCount(0);
		}
		setWorld((w) => (w ? fn(w) : w));
		setDirty(true);
		setSaveErr(null);
		editSeqRef.current += 1;
		scheduleAutoSave();
	}

	/** 输入停止 AUTO_SAVE_MS 后自动保存(节点自动保存:编辑无需手动点保存)。 */
	function scheduleAutoSave() {
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		autoSaveTimer.current = setTimeout(() => void saveRef.current(), 800);
	}

	/**
	 * 应用一份世界快照并立即保存(撤销/重做共用)。React 状态异步生效:
	 * save() 的守卫读 ref,必须先同步 refs,否则 worldRef 还是旧副本、
	 * dirtyRef 还是 false,立即保存会被跳过。
	 */
	function applySnapshot(snap: WorldDataDto) {
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		worldRef.current = snap;
		dirtyRef.current = true;
		setWorld(snap);
		setDirty(true);
		setSaveErr(null);
		setUndoCount(undoStack.current.length);
		setRedoCount(redoStack.current.length);
		// 快照里可能没有当前选中条目:清空失效选中
		setSelId((cur) => (cur && snap.entries.some((e) => e.id === cur) ? cur : null));
		editSeqRef.current += 1;
		void saveRef.current();
	}

	/** 撤销最近一次编辑会话(恢复快照并立即保存);当前副本压入重做栈。 */
	function undo() {
		const prev = undoStack.current.pop();
		if (!prev) return;
		if (worldRef.current) {
			redoStack.current.push(structuredClone(worldRef.current));
			if (redoStack.current.length > MAX_UNDO) redoStack.current.shift();
		}
		applySnapshot(prev);
	}

	/** 重做(撤销的反向;工具栏按钮与 Ctrl+Shift+Z)。 */
	function redo() {
		const next = redoStack.current.pop();
		if (!next) return;
		if (worldRef.current) {
			undoStack.current.push(structuredClone(worldRef.current));
			if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
		}
		applySnapshot(next);
	}

	/** Ctrl+Z/Ctrl+Shift+Z 处理器经 ref 传递:keydown 监听只注册一次,始终调用最新实现。 */
	const undoRef = useRef(undo);
	undoRef.current = undo;
	const redoRef = useRef(redo);
	redoRef.current = redo;

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
		setCreating(false);
	}

	/** 删除条目:其子条目的 parent 清空(转根条目),相关关系一并移除(后端校验要求)。 */
	function deleteEntry(id: string) {
		updateWorld((w) => {
			const next = deleteEntryWithRelations(w.entries, w.relations, id);
			return { ...w, entries: next.entries, relations: next.relations };
		});
		setSelId((prev) => (prev === id ? null : prev));
	}

	// Ctrl+S 立即保存;Ctrl+Z 撤销 / Ctrl+Shift+Z 重做(输入框聚焦时交给浏览器原生撤销)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
			if (e.ctrlKey && e.key === "s") {
				e.preventDefault();
				void saveRef.current();
			} else if (e.ctrlKey && (e.key === "z" || e.key === "Z") && !inField) {
				e.preventDefault();
				if (e.shiftKey) redoRef.current();
				else undoRef.current();
			} else if (e.ctrlKey && (e.key === "y" || e.key === "Y") && !inField) {
				e.preventDefault();
				redoRef.current();
			} else if (e.key === "Escape" && confirmDeleteRef.current) {
				setConfirmDelete(null);
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

	/** 视图容器 class(与 styles.css 的 .world-stage 双常驻叠放/滑入滑出规则对齐)。 */
	const viewCls = (v: WorldView, base: string) =>
		view === v ? `${base} active` : leaving === v ? `${base} leaving` : base;

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
					{view === "entries" && (
						/* 树随视图切换:宽度收缩滑出/滑入(flex 布局下纸张区平滑让位) */
						<motion.div
							key="world-tree"
							className="world-tree-wrap"
							initial={{ width: 0, opacity: 0 }}
							animate={{ width: 240, opacity: 1 }}
							exit={{ width: 0, opacity: 0 }}
							transition={{ duration: DUR.base, ease: EASE.out }}
						>
							<WorldTree
								entries={world.entries}
								selId={selId}
								onSelect={setSelId}
								relations={world.relations}
								creating={creating}
								onCreatingChange={setCreating}
								createType={createType}
								onCreateType={setCreateType}
								createTitle={createTitle}
								onCreateTitle={setCreateTitle}
								onCreate={createEntry}
							/>
						</motion.div>
					)}
				</AnimatePresence>
			)}
			<section className="world-body">
				<div className="w-bar">
					<h1 className="w-page-title">世界书</h1>
					<span className="w-count-pill">{world?.entries.length ?? 0} 条目</span>
					<div className="w-bar-right">
						{dirty && <span className="w-dirty on">● 未保存</span>}
						{(dirty || saving) && (
							<button type="button" className="w-save" disabled={saving} onClick={() => void save()}>
								{saving ? "保存中…" : "保存"}
							</button>
						)}
						<div className="w-seg" role="tablist" aria-label="世界书视图">
							{(
								[
									["entries", "条目"],
									["graph", "关系图"],
									["settings", "设定"],
								] as ReadonlyArray<[WorldView, string]>
							).map(([v, label]) => (
								<button
									key={v}
									type="button"
									role="tab"
									aria-selected={view === v}
									className={view === v ? "w-seg-btn active" : "w-seg-btn"}
									onClick={() => switchView(v)}
								>
									{label}
								</button>
							))}
						</div>
					</div>
				</div>
				{saveErr && <div className="notice err">{saveErr}</div>}
				{world === null ? (
					<div className="world-scroll">
						<div className="w-empty">世界书加载中…</div>
					</div>
				) : (
					/* 视图舞台:三视图叠加常驻(切换保留表单输入与滚动位置,关系图
					   cytoscape 容器恒有尺寸),active 自右滑入、leaving 向左滑出 */
					<div className="world-stage">
						<div className={`${viewCls("entries", "world-scroll")} w-view-entries`}>
							<div className="w-entries-main">
								{selEntry ? (
									<EntryForm
										key={selEntry.id}
										entry={selEntry}
										onChange={changeEntry}
										onRequestDelete={() => setConfirmDelete(selEntry)}
									/>
								) : (
									<div className="w-empty-state">
										<span className="w-empty-icon">
											<Lu icon="book" size={24} />
										</span>
										<h3 className="w-empty-title">未选中任何条目</h3>
										<p className="w-empty-desc">
											从左边的分类树里选择一个条目，查看并编辑它的设定；也可以直接新建一个条目。
										</p>
										<button type="button" className="w-btn-amber w-empty-new" onClick={() => setCreating(true)}>
											<Lu icon="plus" size={15} /> 新建条目
										</button>
										<span className="w-empty-hint">或从已有条目复制一份</span>
									</div>
								)}
							</div>
							{selEntry && (
								<EntryInfoPanel
									key={selEntry.id}
									entry={selEntry}
									entries={world.entries}
									chapters={chapters}
									chaptersOk={chaptersOk}
									slug={slug}
									client={client}
									onChange={changeEntry}
								/>
							)}
						</div>
						{graphMounted && (
							<div className={viewCls("graph", "world-graph-view")}>
								<RelationGraph
									entries={world.entries}
									relations={world.relations}
									slug={slug}
									focusId={selId}
									onSelect={setSelId}
									onUpdateRelations={(next) => updateWorld((w) => ({ ...w, relations: next }))}
									onUpdateEntry={changeEntry}
									onDeleteEntry={(id) => {
										const e = world.entries.find((x) => x.id === id);
										if (e) setConfirmDelete(e);
									}}
									canUndo={undoCount > 0}
									onUndo={undo}
									canRedo={redoCount > 0}
									onRedo={redo}
								/>
								{selEntry ? (
									<EntryCard
										key={selEntry.id}
										entry={selEntry}
										entries={world.entries}
										relations={world.relations}
										slug={slug}
										onJump={setSelId}
										onClose={() => setSelId(null)}
										onEdit={() => switchView("entries")}
										onDelete={() => setConfirmDelete(selEntry)}
									/>
								) : (
									<aside className="entry-card entry-card-hint">
										<div>点击图中节点查看词条详情</div>
									</aside>
								)}
							</div>
						)}
						<div className={viewCls("settings", "world-scroll") + " w-view-settings"}>
							<div className="w-settings">
								<div className="w-col">
									<section className="w-card">
										<div className="w-card-head">
											<span className="w-card-title">简要世界观</span>
											<span className="w-card-note">常驻注入</span>
										</div>
										<WorldSummaryPanel
											summary={world.worldSummary}
											onChange={(v) => updateWorld((w) => ({ ...w, worldSummary: v }))}
										/>
									</section>
									<StorylinePanel
										storyline={world.storyline}
										onChange={(s) => updateWorld((w) => ({ ...w, storyline: s }))}
									/>
									<StyleSamplePanel
										sample={world.styleSample}
										onSample={(s) => updateWorld((w) => ({ ...w, styleSample: s }))}
									/>
								</div>
								<div className="w-col">
									<TimelinePanel
										events={world.timeline}
										chapters={chapters}
										chaptersOk={chaptersOk}
										onChange={(t) => updateWorld((w) => ({ ...w, timeline: t }))}
									/>
									<ConstraintsPanel
										constraints={world.constraints}
										onConstraints={(c) => updateWorld((w) => ({ ...w, constraints: c }))}
									/>
								</div>
							</div>
						</div>
					</div>
				)}
			</section>

			{/* 删除确认(设计稿 04):独立定位层的模态,fixed 不受祖先 overflow 裁剪 */}
			{confirmDelete && (
				<div className="w-modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
					<div className="w-modal" role="dialog" aria-modal="true" aria-labelledby="w-del-title">
						<div className="w-modal-head">
							<Lu icon="triangle-alert" size={20} strokeWidth={1.6} />
							<span id="w-del-title">删除这个条目？</span>
						</div>
						<p className="w-modal-desc">
							「{confirmDelete.title || "未命名"}」及其关联章节、关键词等设置都会被移除，此操作不可恢复。
						</p>
						<div className="w-modal-actions">
							<button type="button" className="w-btn-ghost" onClick={() => setConfirmDelete(null)}>
								取消
							</button>
							<button
								type="button"
								className="w-btn-solid"
								onClick={() => {
									deleteEntry(confirmDelete.id);
									setConfirmDelete(null);
								}}
							>
								删除条目
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
