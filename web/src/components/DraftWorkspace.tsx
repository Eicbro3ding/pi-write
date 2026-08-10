import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CodeMirrorBox, type CodeMirrorBoxHandle, type CodeMirrorSelection } from "../editor/CodeMirrorBox.tsx";
import { applyTextEdit, resolveSaveOutcome, selectionStillMatches } from "../workspace.ts";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { useCrossWindowReload } from "../cross-window-sync.ts";
import type { AppliedEdit, DraftStatus, TextSelectionSnapshot } from "../types.ts";

/** 正文工作区暴露给外层的命令句柄(供 WritePage / 批注面板调用)。 */
export interface DraftWorkspaceHandle {
	/** 聚焦编辑器(Alt+E)。 */
	focus: () => void;
	/** 立即保存;true 表示本次写入成功,无未保存内容 / 正在保存 / 写入失败返回 false。 */
	saveNow: () => Promise<boolean>;
	/** 当前文档全文。 */
	getText: () => string;
	/** 对当前选区应用替换/插入;选区失效(selectionStillMatches 为 false)时返回 null,不触碰文档。 */
	applySelectionEdit: (mode: "replace" | "insert", text: string) => AppliedEdit | null;
	/** 撤回已应用的编辑;仅当当前文档与 edit.afterText 一致时成功(true),否则由调用层提示「正文已变化,无法自动撤回」。 */
	undoEdit: (edit: AppliedEdit) => boolean;
	/** 移动光标 / 设置选区,并滚动到可见区域。 */
	selectRange: (from: number, to: number) => void;
	/** 重新加载草稿(加载失败后的「重试加载」)。 */
	retryLoad: () => void;
}

interface DraftWorkspaceProps {
	client: ApiClient;
	/** 所属书 slug:加载/保存/选区快照都按此书解析,杜绝与会话书错位写入。 */
	slug: string | null;
	/** 正文文件(书内相对路径,如 draft/ch01.md);变化时取消旧请求与 debounce 并重新加载。 */
	file: string;
	/** 所属章节会话文件 basename,用于选区快照与安全编辑校验。 */
	chapterFile: string;
	/** 标题(通常为当前章节名)。 */
	title: string;
	/** 字数变化上报。 */
	onWordCount?: (count: number) => void;
	/** 保存状态变化上报(顶栏保存状态)。 */
	onStatusChange?: (status: DraftStatus) => void;
	/** 选区变化上报(CodeMirror 选区 → 带 slug/file/chapterFile 的快照;加载开始/成功时上报 null)。 */
	onSelectionChange?: (selection: TextSelectionSnapshot | null) => void;
	/** 可见错误文案上报(加载/保存失败的中文说明;恢复后上报 null)。 */
	onError?: (message: string | null) => void;
	/** 附加根元素 class(如视图切换时加 hidden 隐藏,保留挂载与编辑器状态)。 */
	className?: string;
	/** 无头模式:隐藏内部标题/路径行(章节名大字由外层纸张头部承担)。 */
	headerless?: boolean;
}

/**
 * 保存状态 → 中文提示。Record<DraftStatus, string> 由 tsc 穷举校验:
 * 联合成员增删都会在此编译期报错(多了「多余属性」,少了「缺少属性」)。
 */
const STATUS_HINTS: Record<DraftStatus, string> = {
	loading: "加载中…",
	saved: "✓ 已保存",
	dirty: "● 未保存",
	saving: "● 保存中…",
	"save-error": "✗ 保存失败 · Ctrl+S 重试",
};

/** 保存状态 → d-hint 颜色 class(与顶栏 stat-icon 同色系)。 */
const HINT_CLASS: Record<DraftStatus, string> = {
	loading: "",
	saved: "ok",
	dirty: "dirty",
	saving: "busy",
	"save-error": "err",
};

/**
 * 正文主编辑 workspace:CodeMirror 编辑器 + 800ms debounce 自动保存 + Ctrl+S 立即保存 +
 * Alt+E 聚焦 + 保存状态机(loading/saved/dirty/saving/save-error)+ 选区快照 +
 * 安全的 apply/undo handle(基于 selectionStillMatches / undoAppliedEdit 纯逻辑)。
 * 加载失败必须可见(中文文案 + 重试加载),不能吞掉错误后继续显示「已保存」。
 */
export const DraftWorkspace = forwardRef<DraftWorkspaceHandle, DraftWorkspaceProps>(function DraftWorkspace(
	{ client, slug, file, chapterFile, title, onWordCount, onStatusChange, onSelectionChange, onError, className, headerless = false },
	ref,
) {
	const [text, setText] = useState("");
	const [status, setStatus] = useState<DraftStatus>("loading");
	const [wordCount, setWordCount] = useState(0);
	const [loadError, setLoadError] = useState<string | null>(null);
	/** 其他窗口已保存本文件、本窗口有未保存修改时的冲突提示(不重载,避免覆盖本地编辑)。 */
	const [externalConflict, setExternalConflict] = useState(false);
	// 手动「重试加载」:自增触发加载 effect 重新执行
	const [retryKey, setRetryKey] = useState(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const textRef = useRef(text);
	textRef.current = text;
	const slugRef = useRef(slug);
	slugRef.current = slug;
	const fileRef = useRef(file);
	fileRef.current = file;
	const chapterFileRef = useRef(chapterFile);
	chapterFileRef.current = chapterFile;
	const statusRef = useRef(status);
	statusRef.current = status;
	const loadErrorRef = useRef(loadError);
	loadErrorRef.current = loadError;
	const selectionRef = useRef<TextSelectionSnapshot | null>(null);
	const savingRef = useRef(false);
	const editorRef = useRef<CodeMirrorBoxHandle>(null);
	const statusCbRef = useRef(onStatusChange);
	statusCbRef.current = onStatusChange;
	const wordsCbRef = useRef(onWordCount);
	wordsCbRef.current = onWordCount;
	const selectionCbRef = useRef(onSelectionChange);
	selectionCbRef.current = onSelectionChange;
	const errorCbRef = useRef(onError);
	errorCbRef.current = onError;
	/** 最近一次加载/保存成功时的磁盘文件 mtime(If-Match 条件写依据;0 = 未知/文件不存在)。 */
	const lastMtimeRef = useRef(0);

	/** 统一更新保存状态并上报。 */
	function reportStatus(s: DraftStatus) {
		setStatus(s);
		statusCbRef.current?.(s);
	}

	/** 清除当前选区快照并上报 null(加载开始 / 加载成功时调用)。 */
	function clearSelection() {
		selectionRef.current = null;
		selectionCbRef.current?.(null);
	}

	// 文件变化(或手动重试)时:取消旧 debounce 与旧 request,重新拉取草稿。
	// 加载失败保留可见错误与 status=save-error,提供「重试加载」,不把错误吞掉。
	useEffect(() => {
		let cancelled = false;
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = undefined;
		}
		reportStatus("loading");
		setLoadError(null);
		errorCbRef.current?.(null);
		clearSelection();
	void client
		.getDraft(file, slug ?? undefined)
		.then((r) => {
				if (cancelled) return;
				setText(r.text);
				reportStatus("saved");
				setExternalConflict(false);
				lastMtimeRef.current = r.mtime; // 记录磁盘版本,保存时作 If-Match
				setWordCount(count(r.text));
				wordsCbRef.current?.(count(r.text));
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const visible = `草稿加载失败:${friendlyError(err)}`;
				setLoadError(visible);
				reportStatus("save-error");
				errorCbRef.current?.(visible);
			});
		return () => {
			cancelled = true;
		};
		// retryKey 为手动重试触发器;client/file/slug 变化语义见 effect 开头注释
		// (slug 必在依赖里:跨书同名文件 file 不变,切书必须重载并按新书解析)
	}, [client, file, slug, retryKey]);

	// 卸载时清除未触发的自动保存定时器:否则卸载后回调会经 refs 写入旧文件,
	// 并触发已卸载组件的 onStatusChange/onError 上报(幽灵「保存中」状态)
	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = undefined;
			}
		};
	}, []);

	/**
	 * 多窗口同步:其他窗口保存了本文件时,draft_changed 事件到达。
	 * 干净/save-error → 重载收敛(复用 retryKey 加载路径);脏 → 提示冲突但不重载
	 * (不覆盖未保存修改);保存中/加载中 → 跳过(保存完成后自然收敛);
	 * 自己保存的回显(1s 内)跳过,避免保存后清选区等副作用。
	 * (决策逻辑收敛于 useCrossWindowReload,见 cross-window-sync.ts)
	 */
	const markSaved = useCrossWindowReload({
		client,
		eventType: "draft_changed",
		matches: (e) => e.file === fileRef.current && (!e.slug || !slugRef.current || e.slug === slugRef.current),
		state: () => {
			const st = statusRef.current;
			if (st === "saving" || st === "loading") return "busy";
			if (st === "dirty") return "dirty";
			return "clean";
		},
		onConflict: () => setExternalConflict(true),
		onReload: () => setRetryKey((k) => k + 1),
	});

	// Ctrl+S 立即保存;Alt+E 聚焦编辑器(所有窗口 keydown,编辑器内外均可用)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.key === "s") {
				e.preventDefault();
				void saveNow();
			} else if (e.altKey && e.key === "e") {
				e.preventDefault();
				editorRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// saveNow 只经 refs 访问状态,首帧闭包即可
	}, []);

	/**
	 * 立即保存当前文本。返回 true 表示本次写入成功;
	 * 无未保存内容 / 正在保存 / 加载失败未重试 / 写入失败返回 false。
	 * 完成路径(成功与失败)统一经 resolveSaveOutcome 决策:保存期间若文件已切换,
	 * 本次完成视为过期,静默放弃,不覆盖新文件的保存状态/错误文案。
	 */
	async function saveNow(): Promise<boolean> {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = undefined;
		}
		const t = textRef.current;
		const f = fileRef.current;
		if (savingRef.current) return false;
		if (statusRef.current === "saved" || statusRef.current === "loading") return false;
		// 加载失败时编辑器仍是旧文件内容:禁止写入新文件,必须先「重试加载」成功
		if (loadErrorRef.current) return false;
		savingRef.current = true;
		reportStatus("saving");
		let error: string | null = null;
		let savedMtime = 0;
		try {
			// If-Match 条件写:磁盘 mtime 已变(其他窗口/AI 已改)时 409,拒绝覆盖
			savedMtime = await client.putDraft(f, t, slugRef.current ?? undefined, lastMtimeRef.current || undefined);
		} catch (err) {
			error = friendlyError(err);
		} finally {
			savingRef.current = false;
		}
		const outcome = resolveSaveOutcome({
			startedFile: f,
			currentFile: fileRef.current,
			savedText: t,
			currentText: textRef.current,
			autosavePending: timerRef.current !== undefined,
			error,
		});
		switch (outcome.kind) {
			case "abandon":
				// 保存期间文件已切换:过期完成,静默放弃(不更新状态、不清错误)
				break;
			case "saved":
				reportStatus("saved");
				errorCbRef.current?.(null);
				setExternalConflict(false);
				if (savedMtime > 0) lastMtimeRef.current = savedMtime;
				markSaved(); // 记录保存时间:自己的回显(1s 内)跳过
				break;
			case "dirty":
				reportStatus("dirty");
				if (outcome.reschedule) {
					timerRef.current = setTimeout(() => void saveNow(), 800);
				}
				break;
			case "save-error": {
				const visible = `草稿保存失败:${outcome.message}`;
				reportStatus("save-error");
				errorCbRef.current?.(visible);
				break;
			}
		}
		return error === null;
	}

	/** 用户编辑:置 dirty、更新字数、800ms debounce 自动保存(外部回填内容一致时跳过)。 */
	function handleChange(t: string) {
		if (t === textRef.current) return;
		setText(t);
		reportStatus("dirty");
		setWordCount(count(t));
		wordsCbRef.current?.(count(t));
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => void saveNow(), 800);
	}

	/** CodeMirror 选区变化:只负责转换成带 slug/file/chapterFile 的快照;零宽光标也上报。 */
	function handleSelectionChange(sel: CodeMirrorSelection) {
		const snapshot: TextSelectionSnapshot = {
			from: sel.from,
			to: sel.to,
			text: sel.text,
			slug: slugRef.current ?? "",
			file: fileRef.current,
			chapterFile: chapterFileRef.current,
		};
		selectionRef.current = snapshot;
		selectionCbRef.current?.(snapshot);
	}

	/**
	 * 对当前选区应用替换/插入:先校验选区快照仍与当前书/文件/章节/文档一致,
	 * 失效直接返回 null(调用层禁止把旧建议写入);成功时补齐 edit 并整体替换文档。
	 * 替换文档会触发 CodeMirror updateListener → handleChange → 自动保存流程。
	 */
	function applySelectionEdit(mode: "replace" | "insert", textToInsert: string): AppliedEdit | null {
		const selection = selectionRef.current;
		const source = textRef.current;
		if (!selection || !selectionStillMatches(selection, slugRef.current ?? "", fileRef.current, chapterFileRef.current, source)) {
			return null;
		}
		const result = applyTextEdit(source, selection.from, selection.to, textToInsert, mode);
		const edit: AppliedEdit = {
			...result.edit,
			file: fileRef.current,
			chapterFile: chapterFileRef.current,
		};
		editorRef.current?.replaceDocument(result.text);
		return edit;
	}

	/**
	 * 撤回已应用的编辑:仅当当前文档仍等于 edit.afterText 时成功(true),替换回 edit.beforeText;
	 * 文档已被后续修改则返回 false,由调用层提示「正文已变化,无法自动撤回」。
	 */
	function undoEdit(edit: AppliedEdit): boolean {
		if (textRef.current !== edit.afterText) return false;
		editorRef.current?.replaceDocument(edit.beforeText);
		return true;
	}

	useImperativeHandle(
		ref,
		() => ({
			focus: () => editorRef.current?.focus(),
			saveNow: () => saveNow(),
			getText: () => textRef.current,
			applySelectionEdit,
			undoEdit,
			selectRange: (from: number, to: number) => editorRef.current?.selectRange(from, to),
			retryLoad: () => setRetryKey((k) => k + 1),
		}),
		[],
	);

	return (
		<aside className={className ? `draft ${className}` : "draft"}>
			{!headerless && <div className="d-title">{title}</div>}
			{!headerless && (
				<div className="d-sub" title={`${slug ?? ""}/${file}`}>
					{slug ? `${slug}/${file}` : file}
				</div>
			)}
			{loadError && (
				<div className="d-error err">
					<div>{loadError}</div>
					<button type="button" className="d-retry" onClick={() => setRetryKey((k) => k + 1)}>
						重试加载
					</button>
				</div>
			)}
			{externalConflict && (
				<div className="d-error warn">
					<div>该文件已被其他窗口/AI 修改,继续保存将覆盖对方修改</div>
					<button
						type="button"
						className="d-retry"
						onClick={() => {
							setExternalConflict(false);
							setRetryKey((k) => k + 1); // 重新加载:丢弃本地未保存修改,与磁盘收敛
						}}
					>
						重新加载(丢弃本地修改)
					</button>
				</div>
			)}
			<div className="d-body">
				<CodeMirrorBox
					ref={editorRef}
					value={text}
					onChange={handleChange}
					onSelectionChange={handleSelectionChange}
				/>
			</div>
			<div className={`d-hint ${HINT_CLASS[status]}`}>
				Alt+E 进入编辑 · Ctrl+S 保存 · {statusHint(status, loadError !== null)} · {wordCount} 字
			</div>
		</aside>
	);
});

/** 保存状态的中文提示(加载失败与保存失败共用 save-error 状态,文案区分)。 */
function statusHint(status: DraftStatus, hasLoadError: boolean): string {
	if (status === "save-error") return hasLoadError ? "✗ 加载失败" : STATUS_HINTS["save-error"];
	return STATUS_HINTS[status];
}

/** 字数统计:CJK 逐字计数 + 拉丁按空白分词,与 TUI writer-ui.ts 的 countWriting 一致。 */
function count(text: string): number {
	const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
	const latin = text.replace(/[\u3400-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
	return cjk + latin;
}
