/**
 * 全屏编辑器(设计 §5.4,对齐 TUI /edit 的 GUI 版)。
 *
 * 覆盖整个窗口的模态编辑页:可打开书内任意文件(路径输入 + 常用文件快捷下拉),
 * CodeMirror 6 编辑,支持 vim 模式(切换时重建编辑器,文档内容保留),
 * Ctrl+S 保存、Esc 退出(vim 模式下 Esc 交给编辑器,用按钮退出),
 * 脏缓冲退出时显示确认条(保存并退出 / 放弃修改 / 取消)。
 */

import { useEffect, useRef, useState } from "react";
import { CodeMirrorBox } from "../editor/CodeMirrorBox.tsx";
import type { ApiClient } from "../api/client.ts";
import { friendlyError } from "../errors.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { useCrossWindowReload } from "../cross-window-sync.ts";

/** 常用文件快捷下拉(相对书根路径)。 */
const QUICK_FILES = [
	{ label: "本章草稿", file: "" }, // 占位:由 initialFile 填充
	{ label: "大纲", file: "outline.md" },
	{ label: "人物档案", file: ".writer/characters.md" },
	{ label: "世界设定", file: ".writer/world.md" },
	{ label: "时间线", file: ".writer/timeline.md" },
];

export interface FullScreenEditorProps {
	client: ApiClient;
	/** 所属书 slug:读写按此书解析,与会话书错位时也不写错目标。 */
	slug: string | null;
	/** 打开时加载的文件(相对书根)。 */
	initialFile: string;
	/** 标题(如《书》· 章节)。 */
	title: string;
	onClose: (result: { saved: boolean; file: string }) => void;
}

function countWriting(text: string): number {
	const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
	const latin = text.replace(/[\u3400-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
	return cjk + latin;
}

export function FullScreenEditor({ client, slug, initialFile, title, onClose }: FullScreenEditorProps) {
	const [file, setFile] = useState(initialFile);
	const [text, setText] = useState("");
	const [dirty, setDirty] = useState(false);
	const [vim, setVim] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [words, setWords] = useState(0);
	/** 窄屏(≤900px):vim 键位不适合触屏,隐藏切换按钮(CodeMirrorBox 内部同样强制关闭)。 */
	const narrow = useMediaQuery("(max-width: 900px)");
	/** 脏缓冲退出确认条是否显示。 */
	const [confirming, setConfirming] = useState(false);
	/** 多窗口同步重载触发器:干净时收到其他窗口保存事件自增,加载 effect 重新执行。 */
	const [retryKey, setRetryKey] = useState(0);
	const textRef = useRef(text);
	textRef.current = text;
	/** 最近一次「干净」文本快照:加载/保存后更新;dirty = 当前文本 !== 快照。 */
	const initialRef = useRef("");
	const fileRef = useRef(file);
	fileRef.current = file;
	const vimRef = useRef(vim);
	vimRef.current = vim;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	/** 最近一次加载/保存成功时的磁盘文件 mtime(If-Match 条件写依据;0 = 未知)。 */
	const lastMtimeRef = useRef(0);
	/** 最新 requestClose 引用:keydown 监听只绑一次,回调经 ref 永远取最新(避免 stale 闭包)。 */
	const requestCloseRef = useRef(requestClose);
	requestCloseRef.current = requestClose;

	// 加载文件(路径变化或跨窗口重载触发时重新加载;加载即视为干净)
	useEffect(() => {
		let cancelled = false;
		setDirty(false);
		setError(null);
		void client
			.getDraft(file, slug ?? undefined)
			.then((r) => {
				if (cancelled) return;
				setText(r.text);
				initialRef.current = r.text; // 加载即视为干净
				lastMtimeRef.current = r.mtime;
				setWords(countWriting(r.text));
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setError(`加载失败: ${friendlyError(e)}`);
			});
		return () => {
			cancelled = true;
		};
		// retryKey 为多窗口同步重载触发器
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [file, retryKey]);

	async function save(): Promise<boolean> {
		try {
			const mtime = await client.putDraft(fileRef.current, textRef.current, slug ?? undefined, lastMtimeRef.current || undefined);
			setDirty(false);
			initialRef.current = textRef.current; // 保存后快照前移
			if (mtime > 0) lastMtimeRef.current = mtime;
			setWords(countWriting(textRef.current));
			setError(null);
			markSaved(); // 记录保存时间:自己的回显(1s 内)跳过
			return true;
		} catch (e) {
			setError(`保存失败: ${friendlyError(e)}`);
			return false;
		}
	}

	/**
	 * 多窗口同步:其他窗口保存了本文件时,干净 → 重载(走 retryKey 加载路径,
	 * 加载 effect 自带 cancelled 与文件归属);脏 → 提示冲突不重载;
	 * 自己保存的回显(1s 内)跳过。(决策逻辑收敛于 useCrossWindowReload)
	 */
	const markSaved = useCrossWindowReload({
		client,
		eventType: "draft_changed",
		matches: (e) => e.file === fileRef.current && (!e.slug || !slug || e.slug === slug),
		state: () => (dirtyRef.current ? "dirty" : "clean"),
		onConflict: () => setError("该文件已在其他窗口被修改,保存将覆盖对方修改"),
		onReload: () => setRetryKey((k) => k + 1),
	});

	/** 请求关闭:脏时先出确认条;干净直接关闭。 */
	function requestClose() {
		if (dirty) {
			setConfirming(true);
			return;
		}
		onClose({ saved: true, file });
	}

	// Ctrl+S 保存;Esc 退出(仅非 vim 模式——vim 模式下 Esc 是编辑器键位,用退出按钮)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.key === "s") {
				e.preventDefault();
				void save();
			} else if (e.key === "Escape" && !vimRef.current) {
				requestCloseRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="fs-editor">
			<div className="fs-bar">
				<span className="fs-title" title={title}>
					{title}
				</span>
				<input
					className="fs-path"
					value={file}
					spellCheck={false}
					placeholder="书内相对路径,如 notes/构思.md"
					onChange={(e) => setFile(e.target.value)}
					onKeyDown={(e) => {
						// 输入路径回车:清空错误并重载(load effect 随 file 变化触发)
						if (e.key === "Enter") {
							e.preventDefault();
							setError(null);
							(e.target as HTMLInputElement).blur();
						}
					}}
				/>
				<select
					className="fs-quick"
					value=""
					onChange={(e) => {
						const v = e.target.value;
						if (v) setFile(v);
					}}
				>
					<option value="">常用文件…</option>
					<option value={initialFile}>本章草稿</option>
					{QUICK_FILES.filter((q) => q.file.length > 0).map((q) => (
						<option key={q.file} value={q.file}>
							{q.label}
						</option>
					))}
				</select>
				<span className="fs-stats">{words} 字{dirty ? " · 未保存" : " · 已保存"}</span>
				{!narrow && (
					<button className={vim ? "fs-btn active" : "fs-btn"} onClick={() => setVim((v) => !v)} title="切换 vim 键位">
							Vim
					</button>
				)}
				<button className="fs-btn" onClick={() => void save()}>
					保存
				</button>
				<button className="fs-btn fs-exit" onClick={requestClose}>
					退出
				</button>
			</div>
			{error && <div className="notice err fs-notice">{error}</div>}
			<div className="fs-body">
				{/* vim 切换经 key 重建编辑器(mount 时决定扩展);文档内容由受控 value 回填 */}
				<CodeMirrorBox
					key={vim ? "vim" : "plain"}
					value={text}
					vimMode={vim}
					onChange={(t) => {
						setText(t);
						// 与最近一次干净快照比较:初始化/vim 重建回填不误报脏
						setDirty(t !== initialRef.current);
					}}
				/>
			</div>
			{confirming && (
				<div className="fs-confirm">
					<span className="fs-confirm-text">有未保存的修改</span>
					<button
						className="fs-btn fs-btn-primary"
						onClick={async () => {
							if (await save()) onClose({ saved: true, file });
						}}
					>
						保存并退出
					</button>
					<button className="fs-btn fs-btn-danger" onClick={() => onClose({ saved: false, file })}>
						放弃修改
					</button>
					<button className="fs-btn" onClick={() => setConfirming(false)}>
						取消
					</button>
				</div>
			)}
		</div>
	);
}
