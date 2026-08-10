import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { vim } from "@replit/codemirror-vim";
import { useMediaQuery } from "../useMediaQuery.ts";

/** 编辑器当前主选区:起止偏移 + 选中文本(无选区时 from === to,text 为空串)。 */
export interface CodeMirrorSelection {
	from: number;
	to: number;
	text: string;
}

export interface CodeMirrorBoxProps {
	/** 受控文档内容(保存后回填 / 切换章节重新加载)。 */
	value: string;
	onChange: (text: string) => void;
	/** 保存回调(供外层 Ctrl+S / 显式保存按钮调用)。 */
	onSave?: () => void;
	/** 选区变化回调(光标移动 / 选中范围变化 / 文档编辑均触发,供上层同步选区快照)。 */
	onSelectionChange?: (selection: CodeMirrorSelection) => void;
	vimMode?: boolean;
	className?: string;
}

/** 暴露给外层的命令句柄(如 Alt+E 聚焦编辑器、选区替换与重载)。 */
export interface CodeMirrorBoxHandle {
	focus: () => void;
	/** 用 text 替换 [from, to) 区间(供选区替换命令调用)。 */
	replaceRange: (from: number, to: number, text: string) => void;
	/** 整体替换文档内容(与当前内容相同时跳过,避免无谓的事务)。 */
	replaceDocument: (text: string) => void;
	/** 移动光标 / 设置选区,并滚动到可见区域。 */
	selectRange: (from: number, to: number) => void;
}

/**
 * CodeMirror 6 容器:受控 value + 外部注入的编辑器引用。
 *
 * 受控同步:只在外部 value 与编辑器内容不一致时整体替换文档。用户输入时
 * onChange 已把外部 state 同步到与编辑器一致,因此不会误覆盖;真正的外部
 * 变更(切换章节重载草稿)才会触发整体替换。
 */
export const CodeMirrorBox = forwardRef<CodeMirrorBoxHandle, CodeMirrorBoxProps>(function CodeMirrorBox(
	{ value, onChange, onSave, onSelectionChange, vimMode = false, className },
	ref,
) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const onSelectionChangeRef = useRef(onSelectionChange);
	onSelectionChangeRef.current = onSelectionChange;
	const vimRef = useRef(vimMode);
	vimRef.current = vimMode;
	// 窄屏(移动端)强制关闭 vim:触屏没有修饰键与独立 Esc,vim 键位会锁死输入;
	// 跨断点(旋转/分屏)时经下方 [effectiveVim] 依赖重建编辑器实例增删 vim 扩展
	const narrow = useMediaQuery("(max-width: 900px)");
	const effectiveVim = vimMode && !narrow;

	useEffect(() => {
		const view = new EditorView({
			doc: value,
			extensions: [
				basicSetup,
				markdown(),
				effectiveVim ? vim() : [],
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChangeRef.current(update.state.doc.toString());
					// 选区移动或文档变化都会改变选区,统一向外层报告当前主选区
					if (update.selectionSet || update.docChanged) {
						const main = update.state.selection.main;
						onSelectionChangeRef.current?.({
							from: main.from,
							to: main.to,
							text: update.state.sliceDoc(main.from, main.to),
						});
					}
				}),
					// 正文 16px/1.9、透明底、暖金光标与选区,与深夜书房视觉一致
					EditorView.theme({
						"&": {
							backgroundColor: "transparent",
							color: "var(--ink)",
							fontSize: "16px",
							fontFamily: "var(--prose)",
							lineHeight: "1.9",
						},
						// 显式覆盖 baseTheme 的等宽字体与行高:编辑器正文与页面正文同一字体栈
						".cm-content": { caretColor: "var(--amber)", padding: "6px 0", fontFamily: "var(--prose)", lineHeight: "1.9" },
						".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--amber)" },
						"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
							background: "var(--amber-tint-strong) !important",
						},
						// 行号 gutter 整体隐藏:写作界面不显示行号,正文占满宽度
						".cm-gutters": { display: "none" },
						"&.cm-focused": { outline: "none" },
					}),
			],
			parent: hostRef.current!,
		});
		viewRef.current = view;
		return () => view.destroy();
	}, [effectiveVim]);

	// 外部 value 变化(如切换章节重新加载草稿)且与编辑器不一致时,整体替换文档
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() !== value) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		}
	}, [value]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => viewRef.current?.focus(),
			replaceRange: (from, to, text) =>
				viewRef.current?.dispatch({ changes: { from, to, insert: text } }),
			replaceDocument: (text) => {
				const view = viewRef.current;
				if (!view || view.state.doc.toString() === text) return;
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
			},
			selectRange: (from, to) =>
				viewRef.current?.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true }),
		}),
		[],
	);

	return <div className={className} ref={hostRef} style={{ height: "100%", overflow: "auto" }} />;
});
