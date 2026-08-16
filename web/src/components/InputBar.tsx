import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
	parseSlashQuery,
	slashCommandMatches,
	type SlashCommand,
	type SlashContext,
	type SlashQuery,
	type SlashSuggestion,
} from "../slash-commands.ts";

interface InputBarProps {
	/** 是否正在流式生成;为 true 时按钮变为「中断」。 */
	streaming: boolean;
	onSend: (text: string) => void;
	onAbort: () => void;
	/** 占位文案;缺省保持现有对话提示。 */
	placeholder?: string;
	/** textarea 的可访问名称;缺省为「消息输入」。 */
	ariaLabel?: string;
	/** 可选 `/` 命令集(内置 /node、/chapter、/compact 由页面按场景注册)。 */
	commands?: ReadonlyArray<SlashCommand>;
	/** 命令搜索/动作的上下文(当前书、章节、ApiClient)。 */
	context?: SlashContext;
	/** 命令异步加载/动作失败时的提示回调(页面映射为自己的错误条)。 */
	onCommandError?: (message: string) => void;
}

/** 命令面板内部状态。 */
interface SlashMenuState {
	seq: number;
	query: SlashQuery;
	command: SlashCommand;
	items: SlashSuggestion[];
	index: number;
	loading: boolean;
	notice: string | null;
	/** true = 正在选择命令(`/` 或前缀命中多条),候选项是命令本身。 */
	picker: boolean;
}

/** 输入框暴露的命令句柄:供外部按钮触发同一发送路径(如编剧「选中文本自动填入」)。 */
export interface InputBarHandle {
	/** 提交当前输入文本(trim 后为空则忽略);成功发送后清空输入框。 */
	submit: () => void;
	/** 外部预填(编剧「选中文本自动填入」):仅当输入框当前为空时填入并聚焦(光标在末尾);
	 *  已有输入不覆盖,返回是否填入。 */
	prefillIfEmpty: (text: string) => boolean;
}

/** textarea 自动增高的最大高度(px),超过后内部滚动。 */
const MAX_HEIGHT = 160;

/**
 * 输入框:单行自动增高的 textarea,Ctrl+Enter 发送、Enter 换行;
 * 流式中输入保持可用(可插话),按钮切换为「中断」。
 * 可选 placeholder / ariaLabel;ref 暴露 submit 句柄,供外部按钮触发同一发送路径。
 */
export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(
	{
		streaming,
		onSend,
		onAbort,
		placeholder = "向 pi 发一句话(Ctrl+Enter 发送,Enter 换行,流式中可插话)",
		ariaLabel = "消息输入",
		commands,
		context,
		onCommandError,
	},
	ref,
) {
	const [text, setText] = useState("");
	const [menu, setMenu] = useState<SlashMenuState | null>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);
	/** 最新 props(命令/上下文)经 ref 读取,搜索回调无需随每次渲染重挂。 */
	const commandsRef = useRef(commands);
	commandsRef.current = commands;
	const contextRef = useRef(context);
	contextRef.current = context;
	const onCommandErrorRef = useRef(onCommandError);
	onCommandErrorRef.current = onCommandError;
	/** 搜索请求代数:慢响应不得覆盖新查询结果。 */
	const menuSeqRef = useRef(0);

	// textarea 自动增高(受 MAX_HEIGHT 约束)。
	// 注意:双常驻标签(伙伴栏对话/批注)下,隐藏标签内的输入条在 display:none 容器中
	// 挂载,scrollHeight 为 0——仅靠 [text] 依赖会把 textarea 钉成 0 高度,切换标签后
	// 输入条塌陷直到用户输入才恢复。ResizeObserver 在容器恢复显示(尺寸 0 → 实际)
	// 时重算,标签切换后输入条立即回到正常高度。
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		const resize = () => {
			ta.style.height = "auto";
			ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(ta);
		return () => ro.disconnect();
	}, [text]);

	/** action 命令的固定候选项(只有一个,展示附加要求)。 */
	function actionSuggestion(command: SlashCommand, term: string): SlashSuggestion {
		return {
			id: `action:${command.trigger}`,
			label: `/${command.trigger}`,
			hint: command.hint,
			meta: term.length > 0 ? `附加要求:${term}` : undefined,
		};
	}

	/** 选择命令阶段(只输入 `/` 或前缀命中多条)的候选项:选中插入 `/trigger ` 继续输入。 */
	function commandPickerItems(commands: ReadonlyArray<SlashCommand>): SlashSuggestion[] {
		return commands.map((c) => ({
			id: `command:${c.trigger}`,
			label: `/${c.trigger}`,
			hint: c.hint,
			insertText: `/${c.trigger} `,
		}));
	}

	/** 按当前文本与光标重建/关闭命令面板。 */
	function refreshMenu(ta: HTMLTextAreaElement) {
		const q = parseSlashQuery(ta.value, ta.selectionStart ?? ta.value.length);
		if (!q) {
			setMenu(null);
			return;
		}
		const matches = (commandsRef.current ?? []).filter((c) => slashCommandMatches(c, q.trigger));
		if (matches.length === 0) {
			setMenu(null);
			return;
		}
		const exact = matches.find((c) => c.trigger === q.trigger || (c.aliases ?? []).includes(q.trigger));
		const seq = ++menuSeqRef.current;
		// `/`(无触发名)或前缀命中多条且尚无精确命中:先让用户选命令
		if (q.trigger.length === 0 || (matches.length > 1 && !exact)) {
			const command = exact ?? matches[0]!;
			setMenu({
				seq,
				query: q,
				command,
				items: commandPickerItems(matches),
				index: 0,
				loading: false,
				notice: null,
				picker: true,
			});
			return;
		}
		const command = exact ?? matches[0]!;
		// action 命令(有 run、无 search)不需要远程搜索,直接给一条固定候选
		if (command.run && !command.search) {
			setMenu({ seq, query: q, command, items: [actionSuggestion(command, q.term)], index: 0, loading: false, notice: null, picker: false });
			return;
		}
		setMenu({ seq, query: q, command, items: [], index: 0, loading: true, notice: null, picker: false });
		const ctx = contextRef.current;
		void (async () => {
			try {
				const items = (await command.search?.(q.term, ctx ?? ({} as SlashContext))) ?? [];
				if (seq !== menuSeqRef.current) return;
				setMenu((prev) => (prev && prev.seq === seq ? { ...prev, items, loading: false, index: 0 } : prev));
			} catch (err) {
				if (seq !== menuSeqRef.current) return;
				setMenu((prev) =>
					prev && prev.seq === seq
						? { ...prev, loading: false, items: [], notice: err instanceof Error ? err.message : String(err) }
						: prev,
				);
			}
		})();
	}

	/** 把 [start, end) 替换为 insertion,并把光标放到插入文本之后。 */
	function insertRange(start: number, end: number, insertion: string) {
		const ta = taRef.current;
		if (!ta) {
			setText((prev) => prev.slice(0, start) + insertion + prev.slice(end));
			return;
		}
		const next = ta.value.slice(0, start) + insertion + ta.value.slice(end);
		setText(next);
		requestAnimationFrame(() => {
			const t = taRef.current;
			if (!t) return;
			t.focus();
			const pos = start + insertion.length;
			t.setSelectionRange(pos, pos);
		});
	}

	/** 移除查询区间(供 action 命令:执行后不留 `/compact` 原文)。 */
	function removeRange(start: number, end: number) {
		insertRange(start, end, "");
	}

	/** 选中菜单候选项:插入文本 / 异步读取后插入 / 执行动作。 */
	async function pick(item: SlashSuggestion | undefined, m: SlashMenuState) {
		if (!item) return;
		setMenu({ ...m, loading: true, notice: m.command.run ? "正在执行…" : item.loadText ? "正在读取原文…" : null, items: m.items });
		try {
			if (m.command.run && item.insertText === undefined && item.loadText === undefined) {
				await m.command.run(m.query.term, contextRef.current ?? ({} as SlashContext));
				removeRange(m.query.start, m.query.end);
			} else if (item.loadText) {
				const insertion = await item.loadText(contextRef.current ?? ({} as SlashContext));
				insertRange(m.query.start, m.query.end, insertion);
			} else if (item.insertText !== undefined) {
				insertRange(m.query.start, m.query.end, item.insertText);
			}
			setMenu(null);
		} catch (err) {
			setMenu(null);
			onCommandErrorRef.current?.(err instanceof Error ? err.message : String(err));
		}
	}

	function send() {
		setMenu(null);
		const t = text.trim();
		if (t.length === 0) return;
		setText("");
		onSend(t);
	}

	// 无依赖数组:每次渲染重建句柄,保证闭包读到最新 text
	useImperativeHandle(ref, () => ({
		submit: () => send(),
		prefillIfEmpty: (t: string) => {
			if (text.trim().length > 0) return false;
			setText(t);
			requestAnimationFrame(() => {
				const ta = taRef.current;
				if (ta) {
					ta.focus();
					ta.setSelectionRange(t.length, t.length);
				}
			});
			return true;
		},
	}));

	function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (menu) {
			// 命令面板打开时:方向键/回车/Tab 作用于面板,不发送;Esc 关闭
			if (e.key === "ArrowDown" && menu.items.length > 0) {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index + 1) % menu.items.length });
				return;
			}
			if (e.key === "ArrowUp" && menu.items.length > 0) {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index - 1 + menu.items.length) % menu.items.length });
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenu(null);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && menu.items.length > 0) {
				e.preventDefault();
				void pick(menu.items[menu.index], menu);
				return;
			}
		}
		if (e.ctrlKey && e.key === "Enter") {
			e.preventDefault();
			send();
		}
	}

	return (
		<div className="inputbar">
			{menu && (
				<div className="slash-menu" role="listbox" aria-label={menu.picker ? "命令选择" : `/${menu.command.trigger} 命令候选项`}>
					<div className="slash-menu-head">
						<span className="slash-menu-command">{menu.picker ? "/" : `/${menu.command.trigger}`}</span>
						<span className="slash-menu-hint">{menu.picker ? "选择命令" : menu.command.hint}</span>
					</div>
					{menu.loading && menu.items.length === 0 ? (
						<div className="slash-item muted">正在查找…</div>
					) : menu.items.length === 0 ? (
						<div className="slash-item muted">{menu.notice ?? "没有匹配项"}</div>
					) : (
						menu.items.map((item, i) => (
							<button
								key={item.id}
								type="button"
								role="option"
								aria-selected={i === menu.index}
								className={i === menu.index ? "slash-item active" : "slash-item"}
								// 保持 textarea 焦点,click 才能先于 blur 触发
								onMouseDown={(e) => e.preventDefault()}
								onMouseEnter={() => menu.index !== i && setMenu({ ...menu, index: i })}
								onClick={() => void pick(item, menu)}
							>
								<span className="slash-item-label">{item.label}</span>
								{item.hint && <span className="slash-item-hint">{item.hint}</span>}
								{item.meta && <span className="slash-item-meta">{item.meta}</span>}
							</button>
						))
					)}
					{menu.loading && menu.items.length > 0 && menu.notice && <div className="slash-menu-note">{menu.notice}</div>}
				</div>
			)}
			<div className="inputbar-inner">
				<textarea
					ref={taRef}
					rows={1}
					value={text}
					placeholder={placeholder}
					aria-label={ariaLabel}
					onChange={(e) => {
						setText(e.target.value);
						refreshMenu(e.target);
					}}
					onKeyDown={handleKey}
					onKeyUp={(e) => refreshMenu(e.currentTarget)}
					onClick={(e) => refreshMenu(e.currentTarget)}
				/>
				{streaming ? (
					<button className="btn-abort" aria-label="停止生成" onClick={onAbort}>
						中断
					</button>
				) : (
					<button className="btn-send" aria-label="发送" disabled={text.trim().length === 0} onClick={send}>
						发送
					</button>
				)}
			</div>
		</div>
	);
});
