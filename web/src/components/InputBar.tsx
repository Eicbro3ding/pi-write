import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Lu } from "./Lu.tsx";
import type { EnterBehavior } from "../settings.ts";
import type { ContextUsageDto } from "../types.ts";
import {
	composeMessageWithAttachments,
	keepSlashIndex,
	parseAtQuery,
	parseSlashQuery,
	slashArrowMove,
	slashCommandMatches,
	type AtQuery,
	type InputChip,
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
	/** 回车行为(设置页开关);缺省 newline = 回车换行、Ctrl/Cmd+Enter 发送。 */
	enterBehavior?: EnterBehavior;
	/** 上下文占用(设计稿 ★输入区·上下文圆环):给值就在发送按钮左侧显示比例圆环。 */
	usage?: ContextUsageDto | null;
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

/**
 * `@` 引用菜单内部状态(设计稿 ★输入区 · @ 菜单)。
 *
 * 与 `/` 菜单的结构性差异:那是「先选命令再搜候选」,**这是一次搜全部** ——
 * 所有 `sigil: "@"` 的命令并发跑一遍,结果按命令分区并列出来,用户一次就能看到
 * 世界书条目和章节,不必先想"我要找的东西属于哪条命令"。
 */
interface AtMenuState {
	seq: number;
	query: AtQuery;
	/** 按命令分组的结果(空组在写入前就滤掉了)。 */
	groups: Array<{ command: SlashCommand; items: SlashSuggestion[] }>;
	/** 扁平下标:键盘导航要跨组连续移动,渲染时再换算回组内位置。 */
	index: number;
	loading: boolean;
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
 * 上下文占用圆环(设计稿 ★输入区 · 上下文圆环):输入框右侧的比例环 + 百分比。
 *
 * 三档配色照设计稿:充足绿($green) / 正常琥珀($amber) / 接近上限红($red)。
 * 阈值与 context-usage.ts 的 COMPACT_HINT_PERCENT(80%)对齐 —— 环变红的那一刻,
 * 正好也是「建议 /compact」提示该出现的那一刻。
 *
 * 已知偏差:设计稿的悬停明细卡分了「系统提示 / 世界书常驻 / 对话历史 / 当前草稿」
 * 四类,而 ContextUsageDto 只有总量(tokens / contextWindow / percent),没有分类
 * 拆分。**不编造数字**,悬停只给总量。
 */
function ContextRing({ usage }: { usage: ContextUsageDto }) {
	if (usage.percent === null) return null;
	const pct = Math.max(0, Math.min(100, usage.percent));
	const tone = pct >= 80 ? "err" : pct >= 60 ? "warn" : "ok";
	const radius = 10;
	const circumference = 2 * Math.PI * radius;
	const tokens = usage.tokens?.toLocaleString("zh-CN") ?? "?";
	const window = usage.contextWindow.toLocaleString("zh-CN");
	return (
		<span className={`ctx-ring ${tone}`} title={`上下文 ${tokens} / ${window} tokens`}>
			<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
				<circle cx="13" cy="13" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="2.5" />
				<circle
					cx="13"
					cy="13"
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - pct / 100)}
					transform="rotate(-90 13 13)"
				/>
			</svg>
			<span className="ctx-ring-pct">{Math.round(pct)}%</span>
		</span>
	);
}

/**
 * 输入框:单行自动增高的 textarea。**回车行为由设置决定**(enterBehavior):
 * 缺省 newline = 回车换行、Ctrl/Cmd+Enter 发送;设为 send 则回车直接发送、Shift+Enter 换行
 * (Ctrl/Cmd+Enter 在任何设置下都发送);
 * 流式中输入保持可用(可插话),按钮切换为「中断」。
 * `/node`、`/chapter` 类内容命令选中后挂「引用芯片」(紧凑 pill,可 × 移除,
 * 同 id 去重),发送时才展开为注入文本——输入框不再被整段原文撑爆。
 * 可选 placeholder / ariaLabel;ref 暴露 submit 句柄,供外部按钮触发同一发送路径。
 */
export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(
	{
		streaming,
		onSend,
		onAbort,
		placeholder = "说点什么…",
		ariaLabel = "消息输入",
		commands,
		context,
		onCommandError,
		enterBehavior = "newline",
		usage,
	},
	ref,
) {
	const [text, setText] = useState("");
	/** 引用芯片(/node、/chapter 选中后挂载):发送时才展开为注入文本,输入框只显示紧凑 pill。 */
	const [chips, setChips] = useState<InputChip[]>([]);
	const [menu, setMenu] = useState<SlashMenuState | null>(null);
	/** `@` 引用菜单(聚合所有 sigil "@" 命令的搜索结果)。与 menu 互斥 —— 见 refreshMenus。 */
	const [atMenu, setAtMenu] = useState<AtMenuState | null>(null);
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
	/** `@` 菜单的请求代数(同上;两个菜单各自独立编号,互不干扰)。 */
	const atSeqRef = useRef(0);
	/**
	 * 被菜单消费掉的按键。**keyup 时不再刷新菜单** —— 刷新会重建菜单(旧代码里
	 * 连带把 index 打回 0),于是方向键刚挪完就被打回第一项。
	 * 只记一个键即可:keydown/keyup 成对到达,中间不会有别的键。
	 */
	const menuKeyRef = useRef<string | null>(null);

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

	/**
	 * 落菜单状态:**查询未变时保留当前选中项**(上下键之后任何一次重建都会把它打回
	 * 第一项 —— 那是「上下移动不生效」的直接原因),查询变了才回到第一项。
	 */
	function commitMenu(next: Omit<SlashMenuState, "index">) {
		setMenu((prev) => ({ ...next, index: keepSlashIndex(prev, next, next.items.length) }));
	}

	/** 按当前文本与光标重建/关闭命令面板。 */
	function refreshMenu(ta: HTMLTextAreaElement) {
		const q = parseSlashQuery(ta.value, ta.selectionStart ?? ta.value.length);
		if (!q) {
			setMenu(null);
			return;
		}
		// `@` 命令不属于斜杠菜单(2026-09-22:引用命令已分家,只在 @ 菜单里出现)
		const matches = (commandsRef.current ?? []).filter((c) => c.sigil !== "@" && slashCommandMatches(c, q.trigger));
		if (matches.length === 0) {
			setMenu(null);
			return;
		}
		const exact = matches.find((c) => c.trigger === q.trigger || (c.aliases ?? []).includes(q.trigger));
		const seq = ++menuSeqRef.current;
		// `/`(无触发名)或前缀命中多条且尚无精确命中:先让用户选命令
		if (q.trigger.length === 0 || (matches.length > 1 && !exact)) {
			const command = exact ?? matches[0]!;
			commitMenu({
				seq,
				query: q,
				command,
				items: commandPickerItems(matches),
				loading: false,
				notice: null,
				picker: true,
			});
			return;
		}
		const command = exact ?? matches[0]!;
		// action 命令(有 run、无 search)不需要远程搜索,直接给一条固定候选
		if (command.run && !command.search) {
			commitMenu({ seq, query: q, command, items: [actionSuggestion(command, q.term)], loading: false, notice: null, picker: false });
			return;
		}
		commitMenu({ seq, query: q, command, items: [], loading: true, notice: null, picker: false });
		const ctx = contextRef.current;
		void (async () => {
			try {
				const items = (await command.search?.(q.term, ctx ?? ({} as SlashContext))) ?? [];
				if (seq !== menuSeqRef.current) return;
				commitMenu({ seq, query: q, command, items, loading: false, notice: null, picker: false });
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

	/** `@` 菜单的扁平候选(键盘要跨组连续移动,渲染时再换算回组内位置)。 */
	function atFlat(m: AtMenuState): SlashSuggestion[] {
		return m.groups.flatMap((g) => g.items);
	}

	/**
	 * 重建 `@` 引用菜单:所有 `sigil: "@"` 的命令**并发**跑一遍,按命令分区。
	 *
	 * 与 `/` 菜单的结构性差异在这里 —— **一次搜全部**,而不是先让用户选命令。
	 * 输入 `灯` 时要同时看到「世界书 · 灯塔」和「章节 · 第一章」,由用户去认,
	 * 而不是先逼他判断"我要找的东西属于哪条命令"。
	 */
	function refreshAtMenu(q: AtQuery) {
		const cmds = (commandsRef.current ?? []).filter((c) => c.sigil === "@" && c.search);
		if (cmds.length === 0) {
			setAtMenu(null);
			return;
		}
		const seq = ++atSeqRef.current;
		setAtMenu({ seq, query: q, groups: [], index: 0, loading: true });
		const ctx = contextRef.current ?? ({} as SlashContext);
		void (async () => {
			try {
				const groups = await Promise.all(
					cmds.map(async (command) => ({ command, items: (await command.search!(q.term, ctx)) ?? [] })),
				);
				if (seq !== atSeqRef.current) return;
				setAtMenu({ seq, query: q, groups: groups.filter((g) => g.items.length > 0), index: 0, loading: false });
			} catch (err) {
				if (seq !== atSeqRef.current) return;
				setAtMenu(null);
				onCommandErrorRef.current?.(err instanceof Error ? err.message : String(err));
			}
		})();
	}

	/**
	 * 按当前文本与光标重建两个菜单。**两者互斥**:`@` 查询一旦成立就只开 `@` 菜单。
	 * 不互斥的话,`/node 灯塔 @灯` 这种文本会让两个面板同时弹出来叠在一起。
	 */
	function refreshMenus(ta: HTMLTextAreaElement) {
		const cursor = ta.selectionStart ?? ta.value.length;
		const at = parseAtQuery(ta.value, cursor);
		if (at) {
			setMenu(null);
			refreshAtMenu(at);
			return;
		}
		setAtMenu(null);
		refreshMenu(ta);
	}

	/**
	 * `@` 菜单选中候选项:语义与 `/` 菜单一致(带 attachment 的挂引用芯片,发送时才展开),
	 * 但不复用 `pick` —— 那条路径绑着 SlashMenuState 的 command 与 picker 语义。
	 */
	async function pickAt(item: SlashSuggestion | undefined, m: AtMenuState) {
		if (!item) return;
		setAtMenu({ ...m, loading: true });
		try {
			if (item.attachment) {
				const resolved = await item.attachment.loadText(contextRef.current ?? ({} as SlashContext));
				const chip: InputChip = { key: item.id, label: item.attachment.label, detail: item.attachment.detail, text: resolved };
				setChips((prev) => (prev.some((c) => c.key === chip.key) ? prev : [...prev, chip]));
				removeRange(m.query.start, m.query.end);
			} else if (item.loadText) {
				const insertion = await item.loadText(contextRef.current ?? ({} as SlashContext));
				insertRange(m.query.start, m.query.end, insertion);
			} else if (item.insertText !== undefined) {
				insertRange(m.query.start, m.query.end, item.insertText);
			}
			setAtMenu(null);
		} catch (err) {
			setAtMenu(null);
			onCommandErrorRef.current?.(err instanceof Error ? err.message : String(err));
		}
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

	/** 移除一枚引用芯片。 */
	function removeChip(key: string) {
		setChips((prev) => prev.filter((c) => c.key !== key));
	}

	/** 选中菜单候选项:挂引用芯片 / 插入文本 / 执行动作。 */
	async function pick(item: SlashSuggestion | undefined, m: SlashMenuState) {
		if (!item) return;
		setMenu({ ...m, loading: true, notice: m.command.run ? "正在执行…" : item.attachment ? "正在读取原文…" : null, items: m.items });
		try {
			if (m.command.run && item.insertText === undefined && item.attachment === undefined) {
				const result = await m.command.run(m.query.term, contextRef.current ?? ({} as SlashContext));
				// run 返回文本 = 结果回插输入框(插件命令:执行后端 handler 后把结果填入,
				// 用户看过再发送);返回 undefined 的纯 action 命令只清命令原文
				if (typeof result === "string" && result.length > 0) {
					insertRange(m.query.start, m.query.end, result);
				} else {
					removeRange(m.query.start, m.query.end);
				}
			} else if (item.attachment) {
				// 引用芯片:选中时预读全文(失败走命令错误条,不挂芯片);同 id 去重;
				// 同时清掉输入框里的命令查询区间(/chapter ch01),不留残留原文
				const resolved = await item.attachment.loadText(contextRef.current ?? ({} as SlashContext));
				const chip: InputChip = { key: item.id, label: item.attachment.label, detail: item.attachment.detail, text: resolved };
				setChips((prev) => (prev.some((c) => c.key === chip.key) ? prev : [...prev, chip]));
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
		setAtMenu(null);
		const t = text.trim();
		// 芯片可以独立发送(只引用不说话);两者皆空才忽略
		if (t.length === 0 && chips.length === 0) return;
		const message = composeMessageWithAttachments(chips, t);
		setText("");
		setChips([]);
		onSend(message);
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
		if (atMenu) {
			const flat = atFlat(atMenu);
			// 与 `/` 菜单同款:候选项 ≤1 时不吃键,否则「挪不动却 preventDefault」会锁住光标
			const move = slashArrowMove(e.key, atMenu.index, flat.length);
			if (move.consume) {
				e.preventDefault();
				menuKeyRef.current = e.key;
				setAtMenu((prev) => (prev ? { ...prev, index: move.index } : prev));
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				menuKeyRef.current = e.key;
				setAtMenu(null);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && flat.length > 0) {
				e.preventDefault();
				menuKeyRef.current = e.key;
				void pickAt(flat[atMenu.index], atMenu);
				return;
			}
		}
		if (menu) {
			// 命令面板打开时:方向键/回车/Tab 作用于面板,不发送;Esc 关闭
			// 方向键走纯函数(见 slash-commands.ts):**候选项 ≤1 时不吃键** ——
			// 挪不动却 preventDefault 会让光标也动不了,表现成「输入框被锁住」
			const move = slashArrowMove(e.key, menu.index, menu.items.length);
			if (move.consume) {
				e.preventDefault();
				menuKeyRef.current = e.key;
				// 函数式更新:连按两次时第二次不会读到上一帧的旧 index(丢了那一步)
				setMenu((prev) => (prev ? { ...prev, index: move.index } : prev));
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				menuKeyRef.current = e.key;
				setMenu(null);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && menu.items.length > 0) {
				e.preventDefault();
				menuKeyRef.current = e.key;
				void pick(menu.items[menu.index], menu);
				return;
			}
		}
		if (e.key !== "Enter" || e.shiftKey) return;
		// Ctrl/Cmd+Enter 在任何设置下都发送;Shift+Enter 恒换行(交给浏览器插入换行)
		if (e.ctrlKey || e.metaKey || enterBehavior === "send") {
			e.preventDefault();
			send();
		}
	}

	return (
		<div className="inputbar" data-enter={enterBehavior}>
			{/* `@` 引用菜单(设计稿 ★输入区 · @ 菜单):浮在输入框上方,按命令分区列出
			    候选;选中后原处替换成引用芯片,发送时才展开成完整内容 */}
			{atMenu && (
				<div className="at-menu" role="listbox" aria-label="引用">
					<div className="at-menu-head">
						<Lu icon="search" size={14} strokeWidth={1.8} />
						<span className="at-menu-query">{atMenu.query.term.length > 0 ? atMenu.query.term : "@"}</span>
						<span className="at-menu-scope">全部</span>
					</div>
					{atMenu.loading && atMenu.groups.length === 0 ? (
						<div className="slash-item muted">正在查找…</div>
					) : atMenu.groups.length === 0 ? (
						<div className="slash-item muted">
							{atMenu.query.term.length > 0 ? "没有匹配项" : "输入关键词搜索世界书、章节…"}
						</div>
					) : (
						<div className="at-menu-body">
							{atMenu.groups.map((g, gi) => (
								<div key={g.command.trigger} className="at-group">
									<div className="at-group-title">{g.command.group ?? g.command.hint}</div>
									{g.items.map((item, ii) => {
										// 扁平下标 = 前面各组的条数之和 + 组内位置;键盘跨组连续移动靠它
										const flatIndex = atMenu.groups.slice(0, gi).reduce((n, x) => n + x.items.length, 0) + ii;
										return (
											<button
												key={item.id}
												type="button"
												role="option"
												aria-selected={flatIndex === atMenu.index}
												className={flatIndex === atMenu.index ? "slash-item active" : "slash-item"}
												// 保持 textarea 焦点,click 才能先于 blur 触发
												onMouseDown={(e) => e.preventDefault()}
												onMouseEnter={() => atMenu.index !== flatIndex && setAtMenu({ ...atMenu, index: flatIndex })}
												onClick={() => void pickAt(item, atMenu)}
											>
												<span className="slash-item-label">{item.label}</span>
												{item.hint && <span className="slash-item-hint">{item.hint}</span>}
												{item.meta && <span className="slash-item-meta">{item.meta}</span>}
											</button>
										);
									})}
								</div>
							))}
						</div>
					)}
				</div>
			)}
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
				{chips.length > 0 && (
					<div className="inputbar-chips" aria-label="引用附件">
						{chips.map((c) => (
							<span key={c.key} className="input-chip" title={c.text}>
								<span className="input-chip-label">{c.label}</span>
								{c.detail && <span className="input-chip-detail">{c.detail}</span>}
								<button type="button" className="input-chip-x" aria-label={`移除引用 ${c.label}`} onClick={() => removeChip(c.key)}>
									×
								</button>
							</span>
						))}
					</div>
				)}
				<textarea
					ref={taRef}
					rows={1}
					value={text}
					placeholder={placeholder}
					aria-label={ariaLabel}
					onChange={(e) => {
						setText(e.target.value);
						refreshMenus(e.target);
					}}
					onKeyDown={handleKey}
					onKeyUp={(e) => {
						// 菜单吃掉的方向键不回灌给刷新逻辑,否则选中项会被打回第一项
						if (e.key === menuKeyRef.current) {
							menuKeyRef.current = null;
							return;
						}
						refreshMenus(e.currentTarget);
					}}
					onClick={(e) => refreshMenus(e.currentTarget)}
				/>
				{usage && <ContextRing usage={usage} />}
				{streaming ? (
					<button className="btn-abort" aria-label="停止生成" onClick={onAbort}>
						中断
					</button>
				) : (
					<button
						className="btn-send"
						aria-label="发送"
						title={enterBehavior === "send" ? "发送(Enter)" : "发送(Ctrl+Enter)"}
						disabled={text.trim().length === 0 && chips.length === 0}
						onClick={send}
					>
						{/* 设计稿 04/06:两处输入条都是「琥珀圆形 ↑」,不再用「发送」文字按钮 */}
						<Lu icon="arrow-up" size={14} strokeWidth={1.8} />
					</button>
				)}
			</div>
		</div>
	);
});
