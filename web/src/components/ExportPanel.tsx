import { useCallback, useEffect, useRef, useState } from "react";
import { Lu } from "./Lu.tsx";

/** 导出格式(设计稿 ★导出 · 选项卡)。 */
export type ExportFormat = "txt" | "md" | "epub" | "docx" | "copy";

/** 导出范围。 */
export type ExportScope = "book" | "chapter";

/** 「把上次使用的格式设为默认」的落点。 */
const LAST_FORMAT_KEY = "pi-writer:export-format";

/**
 * 页签顺序与说明(设计稿右列的「格式」小节)。
 * `ready: false` 的页签**照设计稿显示但禁用**,并给出不可用的真实原因 ——
 * 不做点了没反应的假按钮。
 */
export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; desc: string; ready: boolean; why?: string }> = [
	{ id: "txt", label: "TXT", desc: "纯文本，不带任何格式", ready: true },
	{ id: "md", label: "Markdown", desc: "保留标题与强调，适合继续加工", ready: true },
	{
		id: "epub",
		label: "EPUB",
		desc: "适合放进阅读器通读",
		ready: false,
		why: "EPUB 需要 zip 打包，相关依赖在主进程，渲染进程暂时生成不了",
	},
	{
		id: "docx",
		label: "DOCX",
		desc: "交给编辑或排版",
		ready: false,
		why: "DOCX 需要 OOXML 序列化，相关依赖在主进程，渲染进程暂时生成不了",
	},
	{ id: "copy", label: "复制", desc: "整本纯文本复制到剪贴板", ready: true },
];

/** 参与导出的章节(与 bookDetail.chapters 同形,只取需要的字段)。 */
export interface ExportChapterRef {
	/** 章节 id,如 "ch01"。 */
	id: string;
	/** 会话文件名,如 "ch01.jsonl"(用于定位当前章)。 */
	file: string;
	title: string;
	label?: string | null;
}

export interface ExportPanelProps {
	/** 书名(下载文件名与正文头)。 */
	bookTitle: string;
	chapters: ReadonlyArray<ExportChapterRef>;
	/** 当前章节的会话文件名;为空表示没有当前章。 */
	currentChapterFile: string | null;
	currentChapterTitle: string;
	/** 读取某一章正文(由页面负责路径换算与取数)。 */
	loadChapterText: (chapter: ExportChapterRef) => Promise<string>;
	/** 世界书附录:返回拼好的文本与条目数;无书 / 未加载返回 null。 */
	loadWorldAppendix: () => Promise<{ text: string; count: number } | null>;
	onError: (message: string) => void;
	/** 打开面板时是否自动预取统计(缺省 true)。 */
	prefetch?: boolean;
}

/** 读上次用的格式(设置项「把上次使用的格式设为默认」写进来的)。 */
function readLastFormat(): ExportFormat {
	try {
		const raw = localStorage.getItem(LAST_FORMAT_KEY);
		if (raw && EXPORT_FORMATS.some((f) => f.id === raw && f.ready)) return raw as ExportFormat;
	} catch {
		// 隐私模式 / 无 storage:回退默认格式
	}
	return "md";
}

/** 单章 → 文本片段(标题行按 withTitle 决定要不要)。 */
function chapterBlock(title: string, body: string, md: boolean, withTitle: boolean): string {
	const text = body.trim();
	if (!withTitle) return text;
	return md ? `# ${title}\n\n${text}` : `${title}\n\n${text}`;
}

/** 非空白字符数(与界面上的「字」一致,不把换行缩进算进去)。 */
function countChars(text: string): number {
	return text.replace(/\s+/g, "").length;
}

/**
 * blob 下载(工程里既有模式:createObjectURL + a[download];Android 壳另有分享桥)。
 *
 * `alsoOpen` 对应「导出后自动打开文件」:浏览器里 txt / md 能直接预览,弹窗被拦就
 * 静默放过 —— 文件已经下载了,打开只是加分项。这种情况下 URL 要**延迟回收**,
 * 否则新标签还没读到就被 revoke 掉了。
 */
function downloadBlob(blob: Blob, filename: string, alsoOpen: boolean): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	if (alsoOpen) window.open(url, "_blank");
	setTimeout(() => URL.revokeObjectURL(url), alsoOpen ? 10_000 : 0);
}

/**
 * 导出面板(设计稿 ★导出 · 选项卡)。
 *
 * 导出按钮点开是一排页签 —— TXT / Markdown / EPUB / DOCX / 复制,每个格式各自带
 * 范围、选项与动作,而不是"一个格式走天下"。
 *
 * 实现取舍:
 * - **组件自带按钮 + 浮层**:调用方只摆一个 `<ExportPanel/>`,不必自己架相对定位容器;
 * - TXT / Markdown / 复制在**渲染进程**拼装(拉草稿 → 拼接 → blob 下载 / 写剪贴板),
 *   不需要后端配合;
 * - **EPUB / DOCX 暂不可用**:生成它们要 zip + OOXML 序列化,依赖(`yazl`)在主进程侧,
 *   渲染进程没有。页签照设计稿显示,但禁用并写明原因 —— 不做点了没反应的假按钮;
 * - 「选中」范围同样禁用:它要对编辑器的选区取数,而选区在 CodeMirror 里,这一版没接。
 */
export function ExportPanel({
	bookTitle,
	chapters,
	currentChapterFile,
	currentChapterTitle,
	loadChapterText,
	loadWorldAppendix,
	onError,
	prefetch = true,
}: ExportPanelProps) {
	const [open, setOpen] = useState(false);
	const [format, setFormat] = useState<ExportFormat>(readLastFormat);
	const [scope, setScope] = useState<ExportScope>("chapter");
	const [withTitle, setWithTitle] = useState(true);
	const [withAppendix, setWithAppendix] = useState(true);
	const [withNotes, setWithNotes] = useState(false);
	const [openAfter, setOpenAfter] = useState(true);
	const [remember, setRemember] = useState(true);
	const [busy, setBusy] = useState(false);
	/** 统计(章数 / 字数 / 附录条数);null = 还没算出来。 */
	const [stat, setStat] = useState<{ chapters: number; chars: number; appendix: number } | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);
	/** 统计请求代数:关掉面板后回来的结果不许再写状态。 */
	const statSeqRef = useRef(0);

	/** 目标章节:整本 = 全部;本章 = currentChapterFile 命中的那一章。 */
	const targets = useCallback((): ExportChapterRef[] => {
		if (scope === "book") return [...chapters];
		const cur = chapters.find((c) => c.file === currentChapterFile);
		return cur ? [cur] : [];
	}, [scope, chapters, currentChapterFile]);

	/** 拼装正文(标题按选项、附录按选项)。 */
	const compose = useCallback(async (): Promise<string> => {
		const md = format === "md";
		const parts: string[] = [];
		for (const ch of targets()) {
			const body = await loadChapterText(ch);
			parts.push(chapterBlock(ch.title || ch.id, body, md, withTitle));
		}
		if (withAppendix) {
			const ap = await loadWorldAppendix();
			if (ap && ap.text.trim().length > 0) {
				parts.push(md ? `## 附录 · 世界书\n\n${ap.text}` : `附录 · 世界书\n\n${ap.text}`);
			}
		}
		return parts.filter((p) => p.length > 0).join("\n\n\n");
	}, [format, targets, loadChapterText, withTitle, withAppendix, loadWorldAppendix]);

	/** 预取统计(设计稿的「12 章 · 48,000 字 · 含 8 条附录」)。 */
	const refreshStat = useCallback(async () => {
		const seq = ++statSeqRef.current;
		setStat(null);
		try {
			const list = targets();
			let chars = 0;
			for (const ch of list) {
				chars += countChars(await loadChapterText(ch));
			}
			let appendix = 0;
			if (withAppendix) {
				const ap = await loadWorldAppendix();
				appendix = ap?.count ?? 0;
				chars += ap ? countChars(ap.text) : 0;
			}
			if (seq !== statSeqRef.current) return;
			setStat({ chapters: list.length, chars, appendix });
		} catch {
			// 统计失败不该弹错误条(正文导出本身可能仍然成功):静默留「统计中」
			if (seq === statSeqRef.current) setStat(null);
		}
	}, [targets, loadChapterText, withAppendix, loadWorldAppendix]);

	// 打开时预取一次;范围 / 附录选项变了要重算(它们都影响统计口径)
	useEffect(() => {
		if (!open || !prefetch) return;
		void refreshStat();
	}, [open, prefetch, refreshStat]);

	// 关闭时作废在途统计,避免旧结果写回
	useEffect(() => {
		if (open) return;
		statSeqRef.current++;
		setStat(null);
	}, [open]);

	// Esc 关闭;点面板外部关闭
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		const onClick = (e: MouseEvent) => {
			if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		// 捕获阶段:输入框里的 mousedown 会 preventDefault,冒泡阶段可能收不到
		document.addEventListener("mousedown", onClick, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onClick, true);
		};
	}, [open]);

	/** 当前页签(拿不到就回退第一个可用格式)。 */
	const current = EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0]!;
	const ext = format === "md" ? "md" : "txt";
	const fileBase = bookTitle.trim().length > 0 ? bookTitle.trim() : "未命名";
	const suffix = scope === "book" ? "全本" : currentChapterTitle || "本章";

	async function runExport() {
		if (busy) return;
		setBusy(true);
		try {
			if (remember) {
				try {
					localStorage.setItem(LAST_FORMAT_KEY, format);
				} catch {
					// 存不下就算了,不影响本次导出
				}
			}
			const text = await compose();
			if (text.trim().length === 0) {
				onError("没有可导出的正文");
				return;
			}
			if (format === "copy") {
				await navigator.clipboard.writeText(text);
			} else {
				downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${fileBase}-${suffix}.${ext}`, openAfter);
			}
			setOpen(false);
		} catch (e) {
			onError(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function copyOnly() {
		if (busy) return;
		setBusy(true);
		try {
			const text = await compose();
			if (text.trim().length === 0) {
				onError("没有可复制的正文");
				return;
			}
			await navigator.clipboard.writeText(text);
			setOpen(false);
		} catch (e) {
			onError(`复制失败: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	const targetCount = targets().length;

	return (
		<div className="export-anchor" ref={anchorRef}>
			<button
				type="button"
				className="export-btn"
				aria-haspopup="dialog"
				aria-expanded={open}
				title="导出(选择格式与范围)"
				onClick={() => setOpen((v) => !v)}
			>
				<Lu icon="upload" size={13} strokeWidth={1.8} />
				<span>导出</span>
			</button>

			{open && (
				<div className="export-panel" role="dialog" aria-label="导出">
					<div className="export-tabs" role="tablist">
						{EXPORT_FORMATS.map((f) => (
							<button
								key={f.id}
								type="button"
								role="tab"
								aria-selected={f.id === format}
								disabled={!f.ready}
								title={f.ready ? f.desc : (f.why ?? "暂不可用")}
								className={f.id === format ? "export-tab active" : "export-tab"}
								onClick={() => f.ready && setFormat(f.id)}
							>
								<span className="export-tab-label">{f.label}</span>
								<span className="export-tab-line" />
							</button>
						))}
					</div>

					<div className="export-body">
						<div className="export-row">
							<span className="export-label">范围</span>
							<div className="export-seg">
								<button
									type="button"
									className={scope === "book" ? "export-seg-item active" : "export-seg-item"}
									onClick={() => setScope("book")}
								>
									整本
								</button>
								<button
									type="button"
									className={scope === "chapter" ? "export-seg-item active" : "export-seg-item"}
									onClick={() => setScope("chapter")}
									disabled={currentChapterFile === null}
								>
									本章
								</button>
								{/* 选中范围要对 CodeMirror 的选区取数,这一版没接 —— 照设计稿显示但禁用 */}
								<button type="button" className="export-seg-item" disabled title="需在编辑器中选中文本(暂未接入)">
									选中
								</button>
							</div>
						</div>

						<label className="export-check">
							<input type="checkbox" checked={withTitle} onChange={(e) => setWithTitle(e.target.checked)} />
							<span>包含章节标题</span>
						</label>
						<label className="export-check">
							<input type="checkbox" checked={withAppendix} onChange={(e) => setWithAppendix(e.target.checked)} />
							<span>附带世界书附录</span>
						</label>
						{/* AI 批注目前没有落到正文里的独立数据源,照设计稿显示为未勾选且禁用 */}
						<label className="export-check disabled" title="批注数据暂未接入">
							<input type="checkbox" checked={withNotes} disabled onChange={(e) => setWithNotes(e.target.checked)} />
							<span>保留 AI 批注</span>
						</label>

						<div className="export-divider" />

						<div className="export-info">
							{stat === null ? (
								<span className="export-info-muted">统计中…</span>
							) : (
								<span>
									{stat.chapters} 章 · {stat.chars.toLocaleString("zh-CN")} 字
									{stat.appendix > 0 ? ` · 含 ${stat.appendix} 条附录` : ""}
								</span>
							)}
						</div>

						<div className="export-actions">
							<button type="button" className="export-primary" disabled={busy || targetCount === 0} onClick={() => void runExport()}>
								<Lu icon="upload" size={13} strokeWidth={1.8} />
								<span>{format === "copy" ? "复制到剪贴板" : `导出 ${current.label}`}</span>
							</button>
							<button type="button" className="export-secondary" disabled={busy || targetCount === 0} onClick={() => void copyOnly()}>
								<Lu icon="copy" size={13} strokeWidth={1.8} />
								<span>复制到剪贴板</span>
							</button>
						</div>

						<div className="export-divider" />

						<label className="export-check">
							<input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
							<span>导出后自动打开文件</span>
						</label>
						<label className="export-check">
							<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
							<span>把上次使用的格式设为默认</span>
						</label>
					</div>
				</div>
			)}
		</div>
	);
}
