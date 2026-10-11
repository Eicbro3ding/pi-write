import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches } from "@codemirror/search";
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
	/** 选区变化回调(光标移动 / 选中范围变化 / 文档编辑均触发,供上层同步选区快照)。 */
	onSelectionChange?: (selection: CodeMirrorSelection) => void;
	/** 撤销栈深度变化回调(文档变化或撤销/重做后触发,供工具栏按钮置灰)。 */
	onHistoryChange?: (depth: { undo: number; redo: number }) => void;
	vimMode?: boolean;
	className?: string;
}

/** 暴露给外层的命令句柄(Alt+E 聚焦编辑器 / 工具栏撤销重做)。 */
export interface CodeMirrorBoxHandle {
	focus: () => void;
	/** 撤销一组编辑历史;无可撤销内容返回 false。 */
	undo: () => boolean;
	/** 重做一组编辑历史;无可重做内容返回 false。 */
	redo: () => boolean;
	/** 当前可撤销 / 可重做的组数(工具栏按钮置灰依据)。 */
	historyDepths: () => { undo: number; redo: number };
}

/**
 * 编辑器扩展清单(手写而非 `basicSetup`)。
 *
 * **为什么不用 basicSetup**:它把 `history()` 焊死在内部、不可配置,而这里需要
 * 「换一份文档 = 换一段历史」——切章节时撤销栈必须清空,否则 Ctrl+Z 会把上一章的
 * 内容倒进新章节,再用自动保存覆盖掉新章节的文件(真实的丢稿路径)。
 * CodeMirror 官方对这种情况给的建议就是「把 basicSetup 的源码抄出来自己改」。
 *
 * 与 basicSetup 的差异(有意的取舍):
 * - 去掉行号 / 折叠 gutter 及其高亮:写作界面不显示行号(样式里整体 `display:none`),
 *   保留它们只是白白多挂两层扩展;
 * - 去掉 `highlightActiveLine` / `highlightActiveLineGutter`:正文靠主题的 hover-tint,
 *   不需要一条跟着光标跑的整行底色;
 * - 去掉 autocompletion / lint / fold 的键位:本编辑器没有对应的功能面;
 * - 保留 search 的选区匹配高亮(`highlightSelectionMatches`),长文里找重复词有用。
 */
function buildExtensions(historyCompartment: Compartment, vimMode: boolean) {
	return [
		highlightSpecialChars(),
		// history 走隔舱:换文档时能整个摘掉再装一份新的,从而清空撤销栈
		historyCompartment.of(history()),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		bracketMatching(),
		closeBrackets(),
		rectangularSelection(),
		crosshairCursor(),
		highlightSelectionMatches(),
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
		markdown(),
		// 中文长段落必须软换行(basicSetup 同样不含),否则横向裁切只能靠滚动条
		EditorView.lineWrapping,
		vimMode ? vim() : [],
	];
}

/**
 * 用一份新文档整体替换编辑器内容,并**清空撤销栈**。
 *
 * 为什么必须清:这是「换了一份东西」而不是「用户改了一笔」。若不清,切到第 2 章后
 * 按 Ctrl+Z 会把第 1 章的正文倒回编辑器,800ms 后自动保存写进 ch02.md —— 一次误触
 * 就能覆盖掉新章节的全部内容。
 *
 * 清法是两步、且第一步必须把 history 隔舱摘空:该事务里的这次替换因此不入栈
 * (隔舱为空 = 没人在记录),第二步再装回一份全新的 history,后续编辑照常可撤。
 * 顺序反了(先装新 history 再替换)会把替换本身记进去,撤销又回到旧章节。
 *
 * 独立成可导出的函数是为了能单测:它只依赖 EditorView,不需要 DOM 或 React
 * (EditorView 的 state/dispatch 在 node 里可用,只有挂载到 document 需要 DOM)。
 */
export function replaceDocResettingHistory(view: { state: EditorState; dispatch: (spec: unknown) => void }, text: string, compartment: Compartment): void {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: text },
		effects: compartment.reconfigure([]),
	});
	view.dispatch({ effects: compartment.reconfigure(history()) });
}

/**
 * CodeMirror 6 容器:受控 value + 外部注入的编辑器引用。
 *
 * 受控同步:只在外部 value 与编辑器内容不一致时整体替换文档。用户输入时
 * onChange 已把外部 state 同步到与编辑器一致,因此不会误覆盖;真正的外部
 * 变更(切换章节重载草稿)才会触发整体替换 —— 那种替换同时清空撤销栈。
 */
export const CodeMirrorBox = forwardRef<CodeMirrorBoxHandle, CodeMirrorBoxProps>(function CodeMirrorBox(
	{ value, onChange, onSelectionChange, onHistoryChange, vimMode = false, className },
	ref,
) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	/** history 扩展的隔舱句柄:换文档时清空撤销栈用(见下方 value 同步 effect)。 */
	const historyCompartmentRef = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSelectionChangeRef = useRef(onSelectionChange);
	onSelectionChangeRef.current = onSelectionChange;
	const onHistoryChangeRef = useRef(onHistoryChange);
	onHistoryChangeRef.current = onHistoryChange;
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
				...buildExtensions(historyCompartmentRef.current, effectiveVim),
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
					// 撤销栈深度只在文档变化时变(撤销/重做本身也是文档变化),据此同步按钮态
					if (update.docChanged) {
						onHistoryChangeRef.current?.({ undo: undoDepth(update.state), redo: redoDepth(update.state) });
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
					// 选区匹配高亮默认是冷灰蓝,会与暖色主题打架(且它只在选中时出现)
					".cm-selectionMatch": { backgroundColor: "var(--amber-tint)" },
					"&.cm-focused": { outline: "none" },
				}),
			],
			parent: hostRef.current!,
		});
		viewRef.current = view;
		return () => view.destroy();
	}, [effectiveVim]);

	/**
	 * 外部 value 变化(如切换章节重新加载草稿)且与编辑器不一致时,整体替换文档并清空撤销栈
	 * (为什么要清、怎么清,见 replaceDocResettingHistory 的注释)。
	 */
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() === value) return;
		replaceDocResettingHistory(view, value, historyCompartmentRef.current);
	}, [value]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => viewRef.current?.focus(),
			undo: () => {
				const view = viewRef.current;
				if (!view) return false;
				// 撤销前把光标焦点交还编辑器:历史事务会带着原选区落回去
				view.focus();
				return undo(view);
			},
			redo: () => {
				const view = viewRef.current;
				if (!view) return false;
				view.focus();
				return redo(view);
			},
			historyDepths: () => {
				const view = viewRef.current;
				if (!view) return { undo: 0, redo: 0 };
				return { undo: undoDepth(view.state), redo: redoDepth(view.state) };
			},
		}),
	);

	return <div className={className} ref={hostRef} style={{ height: "100%", overflow: "auto" }} />;
});
