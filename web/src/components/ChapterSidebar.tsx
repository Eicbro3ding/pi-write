import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE } from "../motion.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useDragResize } from "../use-drag-resize.ts";
import type { BookMeta, ChapterRef } from "../types.ts";

interface ChapterSidebarProps {
	books: BookMeta[];
	/** 当前书 slug。 */
	slug: string | null;
	chapters: ChapterRef[];
	/** 当前章节的会话文件 basename。 */
	currentFile: string | null;
	onSelectChapter: (ch: ChapterRef) => void;
	onNewChapter: () => void;
	onSelectBook: (slug: string) => void;
	/** 新建书(输入标题后回车触发;空标题忽略)。 */
	onNewBook: (title: string) => void;
	/** 导出书(hover 书项的操作按钮触发)。 */
	onExportBook?: (slug: string) => void;
	/** 重命名书(操作按钮 + 内联输入触发;标题 → 新 slug)。 */
	onRenameBook?: (slug: string, title: string) => void;
	/** 删除书(经确认条二次确认后触发)。 */
	onDeleteBook?: (slug: string) => void;
	/** 导入书(选择 zip 文件后触发)。 */
	onImportBook?: (file: File) => void;
	/** 重命名章节(章节行内联输入触发,仅改 title/label)。 */
	onRenameChapter?: (ch: ChapterRef, title: string) => void;
	/** 导入进行中:底部「＋ 导入书」按钮禁用并显示「导入中…」。 */
	importing?: boolean;
	/** 进行中的书 slug:其导出/删除按钮禁用。 */
	busySlug?: string | null;
	/** 侧栏宽度(px);拖拽右边缘手柄可调。 */
	width?: number;
	onResize?: (w: number) => void;
	/** 折叠态(56px 图标条):由调用层持有并持久化。 */
	collapsed?: boolean;
	onToggleCollapse?: () => void;
	/** 窄屏抽屉打开:根元素追加 drawer-open class,并渲染关闭按钮(Task 7 负责抽屉视觉)。 */
	drawerOpen?: boolean;
	onClose?: () => void;
}

/** 侧栏宽度限制(px)。 */
const MIN_WIDTH = 200;
const MAX_WIDTH = 340;

/**
 * 书库栏:书列表 + 当前书的章节列表(章节带序号),底部新建章节/新建书/导入书。
 * 可折叠为 56px 图标条(只留当前书首字),右边缘拖拽手柄可调宽度。
 * 功能与 props 语义保持不变,仅视觉与信息架构升级。
 */
export function ChapterSidebar({
	books,
	slug,
	chapters,
	currentFile,
	onSelectChapter,
	onNewChapter,
	onSelectBook,
	onNewBook,
	onExportBook,
	onRenameBook,
	onDeleteBook,
	onImportBook,
	onRenameChapter,
	importing = false,
	busySlug = null,
	width,
	onResize,
	collapsed = false,
	onToggleCollapse,
	drawerOpen = false,
	onClose,
}: ChapterSidebarProps) {
	/** 新建书内联输入框是否展开。 */
	const [addingBook, setAddingBook] = useState(false);
	const [bookTitle, setBookTitle] = useState("");
	/** 待确认删除的书 slug:非空时该书按钮下方渲染确认条。 */
	const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null);
	/** 打开操作菜单(⋯)的书 slug:非空时该书项渲染弹出菜单。 */
	const [menuSlug, setMenuSlug] = useState<string | null>(null);
	/** 重命名中的书 slug:非空时该书按钮下方渲染内联输入条。 */
	const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
	const [renameTitle, setRenameTitle] = useState("");
	/** 重命名中的章节 id:非空时该章节行渲染内联输入。 */
	const [renamingChapterId, setRenamingChapterId] = useState<string | null>(null);
	const [chapterRenameTitle, setChapterRenameTitle] = useState("");
	/** 窄屏抽屉:仅窄屏时 aside 被 fixed 定位并受 x 位移控制;宽屏恒为网格子项。 */
	const isNarrow = useMediaQuery("(max-width: 900px)");
	/** 隐藏的文件选择框(底部「＋ 导入书」按钮触发)。 */
	const fileRef = useRef<HTMLInputElement>(null);

	// 操作菜单打开时,点击页面其他位置(含切换书/章节)关闭菜单。
	// 注意:⋯ 按钮的 onClick 必须 stopPropagation——React 对 discrete click 事件
	// 同步 flush passive effects,若不阻止冒泡,「点 ⋯ 打开菜单」的同一事件会
	// 在冒泡到 document 时触发 close,菜单开即关。
	useEffect(() => {
		if (!menuSlug) return;
		const close = () => setMenuSlug(null);
		document.addEventListener("click", close);
		return () => document.removeEventListener("click", close);
	}, [menuSlug]);

	const activeBook = books.find((b) => b.slug === slug) ?? null;

	function submitBook() {
		const title = bookTitle.trim();
		if (title.length === 0) return;
		setAddingBook(false);
		setBookTitle("");
		onNewBook(title);
	}

	/** 书重命名确认:空标题忽略;触发后关闭输入条(由调用方负责刷新列表)。 */
	function submitRenameBook(slug: string) {
		const title = renameTitle.trim();
		setRenamingSlug(null);
		setRenameTitle("");
		if (title.length === 0) return;
		onRenameBook?.(slug, title);
	}

	/** 章节重命名确认:空标题忽略;触发后关闭输入条。 */
	function submitRenameChapter(ch: ChapterRef) {
		const title = chapterRenameTitle.trim();
		setRenamingChapterId(null);
		setChapterRenameTitle("");
		if (title.length === 0) return;
		onRenameChapter?.(ch, title);
	}

	/** 拖拽中:禁用宽度 transition,保持拖拽跟手(折叠/展开动画走 transition)。 */
	const [resizing, setResizing] = useState(false);

	/** 拖拽手柄:按下后在 window 上监听移动,宽度随鼠标横向位移受限于 [MIN, MAX](useDragResize)。 */
	const onResizeStart = useDragResize({
		min: MIN_WIDTH,
		max: MAX_WIDTH,
		getValue: () => width ?? 240,
		onChange: (w) => onResize?.(w),
		onStart: () => setResizing(true),
		onEnd: () => setResizing(false),
	});

	return (
		<>
			{/* 遮罩:全屏 fixed(z-30,抽屉 z-40 之下),随抽屉条件挂载,淡入淡出 */}
			<AnimatePresence>
				{isNarrow && drawerOpen && (
					<motion.div
						key="mask"
						className="drawer-mask"
						aria-hidden="true"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: DUR.base, ease: EASE.out }}
						onClick={onClose}
					/>
				)}
			</AnimatePresence>
			<motion.aside
				className={
					drawerOpen
						? `chapters ${collapsed ? "collapsed" : ""} ${resizing ? "resizing" : ""} drawer-open`
						: `chapters ${collapsed ? "collapsed" : ""} ${resizing ? "resizing" : ""}`
				}
				style={width !== undefined ? { width: collapsed ? 56 : width } : undefined}
				initial={false}
				animate={!isNarrow || drawerOpen ? "open" : "closed"}
				variants={{
					// open 的 visibility 直接进变体值(动画开始即应用);closed 靠 transitionEnd
					// 在滑出结束后再隐藏,关闭态离屏且不吃 Tab 焦点
					open: { x: 0, opacity: 1, visibility: "visible" },
					closed: { x: "-100%", opacity: 0, transitionEnd: { visibility: "hidden" } },
				}}
				transition={T_DRAWER}
			>
				{drawerOpen && onClose && (
					<button type="button" className="panel-close" aria-label="关闭章节栏" onClick={onClose}>
						×
					</button>
				)}
				{collapsed ? (
					/* 折叠态:当前书首字按钮,点击展开书库 */
					activeBook && (
						<button type="button" className="c-collapsed-book" title={activeBook.title} onClick={onToggleCollapse}>
							{activeBook.title.slice(0, 1)}
						</button>
					)
					) : (
						<>
						{books.length >= 1 && (
							<>
								<div className="c-head">书</div>
									<div className="c-books">
										<AnimatePresence initial={false}>
											{books.map((b) => (
												// 无 layout/入场动画:顶层标签页切换时 display 重挂会触发 framer
												// layout 重放(scale+位移),与容器滑入叠加成双重动画;条目移除保留 exit
												<motion.div
													key={b.slug}
													className="c-book-wrap"
													exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, overflow: "hidden" }}
													transition={T_LIST}
												>
												{/* 书项行:切书按钮与 ⋯ 操作菜单按钮平级(嵌套 button 是非法 HTML,
												    点击行为不可靠——⋯ 必须移出外层按钮) */}
												<div className="c-book-row">
													<button
														className={b.slug === slug ? "c-book active" : "c-book"}
														title={`${b.title} · ${b.slug} · ${b.chapters} 章`}
														onClick={() => onSelectBook(b.slug)}
													>
														<span className="c-book-title">{b.title}</span>
														<span className="c-book-slug">{b.slug}</span>
													</button>
													<span className="c-book-more">
														<button
															type="button"
															className="c-book-more-btn"
															aria-label={`操作 ${b.title}`}
															title="重命名 / 导出 / 删除"
															disabled={busySlug === b.slug}
															onClick={(e) => {
															// 必须阻止冒泡:否则同一 click 冒泡到 document 触发 close,菜单开即关
															e.stopPropagation();
															e.nativeEvent.stopPropagation();
															setMenuSlug((cur) => (cur === b.slug ? null : b.slug));
														}}
														>
															⋯
														</button>
														{menuSlug === b.slug && (
															<div className="c-book-menu">
																<button
																	type="button"
																	onClick={() => {
																		setMenuSlug(null);
																		setRenamingSlug(b.slug);
																		setRenameTitle(b.title);
																	}}
																>
																	重命名
																</button>
																<button
																	type="button"
																	disabled={busySlug === b.slug}
																	onClick={() => {
																		setMenuSlug(null);
																		onExportBook?.(b.slug);
																	}}
																>
																	导出
																</button>
																<button
																	type="button"
																	className="danger"
																	disabled={busySlug === b.slug}
																	onClick={() => {
																		setMenuSlug(null);
																		setConfirmingSlug(b.slug);
																	}}
																>
																	删除
																</button>
															</div>
														)}
													</span>
												</div>
												{confirmingSlug === b.slug && (
													<div className="c-book-confirm">
														<div>删除《{b.title}》及其所有草稿与对话?</div>
														<div className="c-book-confirm-actions">
															<button
																type="button"
																className="danger"
																disabled={busySlug === b.slug}
																onClick={() => {
																	onDeleteBook?.(b.slug);
																	setConfirmingSlug(null);
																}}
															>
																确认删除
															</button>
															<button type="button" onClick={() => setConfirmingSlug(null)}>
																取消
															</button>
														</div>
													</div>
												)}
												{renamingSlug === b.slug && (
													<input
														className="c-book-rename-input"
														autoFocus
														placeholder="书名,回车重命名"
														value={renameTitle}
														onChange={(e) => setRenameTitle(e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter") submitRenameBook(b.slug);
															else if (e.key === "Escape") {
																setRenamingSlug(null);
																setRenameTitle("");
															}
														}}
														onBlur={() => {
															setRenamingSlug(null);
															setRenameTitle("");
														}}
													/>
												)}
											</motion.div>
										))}
									</AnimatePresence>
								</div>
							</>
						)}
						<div className="c-head">章节</div>
						<nav className="c-list">
							{chapters.length === 0 && <div className="c-empty">还没有章节</div>}
							<AnimatePresence initial={false}>
								{chapters.map((ch, i) =>
									renamingChapterId === ch.id ? (
										<motion.div
											key={ch.id}
											className="chapter chapter-renaming"
											exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0, overflow: "hidden" }}
											transition={T_LIST}
										>
											<input
												className="chapter-rename-input"
												autoFocus
												placeholder="章节名,回车重命名"
												value={chapterRenameTitle}
												onChange={(e) => setChapterRenameTitle(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") submitRenameChapter(ch);
													else if (e.key === "Escape") {
														setRenamingChapterId(null);
														setChapterRenameTitle("");
													}
												}}
												onBlur={() => {
													setRenamingChapterId(null);
													setChapterRenameTitle("");
												}}
											/>
										</motion.div>
									) : (
										<motion.div
											key={ch.id}
											className="chapter-row"
											exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0, overflow: "hidden" }}
											transition={T_LIST}
										>
											{/* 切章按钮与操作按钮平级(嵌套 button 非法,拆开) */}
											<button
												type="button"
												className={ch.file === currentFile ? "chapter active" : "chapter"}
												title={ch.file}
												onClick={() => onSelectChapter(ch)}
											>
												<span className="c-index">{String(i + 1).padStart(2, "0")}</span>
												<span className="c-title">{ch.title}</span>
												{ch.label && <span className="c-label">{ch.label}</span>}
											</button>
											{/* 章节操作按钮:hover 行时显示 */}
											<span className="c-chapter-actions" onClick={(e) => e.stopPropagation()}>
												<button
													type="button"
													className="c-book-act"
													aria-label={`重命名章节 ${ch.title}`}
													onClick={() => {
														setRenamingChapterId(ch.id);
														setChapterRenameTitle(ch.title);
													}}
												>
													重命名
												</button>
											</span>
										</motion.div>
									),
								)}
							</AnimatePresence>
						</nav>
						<button className="c-new" onClick={onNewChapter}>
							＋ 新建章节
						</button>
						{addingBook ? (
							<input
								className="c-new-input"
								autoFocus
								placeholder="书名,回车创建"
								value={bookTitle}
								onChange={(e) => setBookTitle(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submitBook();
									else if (e.key === "Escape") {
										setAddingBook(false);
										setBookTitle("");
									}
								}}
								onBlur={() => {
									setAddingBook(false);
									setBookTitle("");
								}}
							/>
						) : (
							<button className="c-new" onClick={() => setAddingBook(true)}>
								＋ 新建书
							</button>
						)}
						{/* 导入书:隐藏文件框 + 底部按钮(导入中禁用) */}
						<input
							ref={fileRef}
							type="file"
							accept=".zip"
							style={{ display: "none" }}
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) onImportBook?.(f);
								e.target.value = "";
							}}
						/>
						<button className="c-new" disabled={importing} onClick={() => fileRef.current?.click()}>
							{importing ? "导入中…" : "＋ 导入书"}
						</button>
						</>
					)}
					{onToggleCollapse && (
					<button type="button" className="c-collapse" onClick={onToggleCollapse} title={collapsed ? "展开书库" : "收起书库"}>
						<span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
						<span className="c-collapse-text">{collapsed ? "展开" : "收起"}</span>
					</button>
				)}
				{!collapsed && onResize && <div className="c-resize" onMouseDown={onResizeStart} title="拖拽调整宽度" />}
			</motion.aside>
		</>
	);
}

/** 抽屉滑入滑出(320ms)与列表入场/让位(200ms):本组件内使用,避免散落魔法数。 */
const T_DRAWER = { duration: DUR.slow, ease: EASE.out };
const T_LIST = { duration: DUR.base, ease: EASE.out };
