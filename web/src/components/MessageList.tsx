import { Fragment, memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { DUR, EASE, EDGE_IN, STAGGER } from "../motion.ts";
import { renderMarkdown } from "../markdown.ts";
import { ConfirmCard, type ConfirmCardItem } from "./ConfirmCard.tsx";
import { FoldablePre } from "./FoldablePre.tsx";
import { Lu } from "./Lu.tsx";
import { ToolIcon } from "./ToolIcon.tsx";
import { actionFlowTools, toolActionRow, toolIcon } from "../tool-status.ts";
import { autoExpandThinkingEnabled } from "../settings.ts";

/**
 * AI 输出中的状态提示:braille 转圈帧 + 文案轮换(思考中/分析中/创作中)+
 * 动态颜文字。tick 每 150ms 推进:转圈 10 帧循环;颜文字与文案每 8 tick
 * (1.2s)换一组;尾部点点按 6 tick(0.9s)递增循环。
 */
const THINKING_STEPS = [
	{ label: "思考中", face: "🤔" },
	{ label: "分析中", face: "📖" },
	{ label: "创作中", face: "✍️" },
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ThinkingIndicator() {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((v) => v + 1), 150);
		return () => clearInterval(t);
	}, []);
	const step = THINKING_STEPS[Math.floor(tick / 8) % THINKING_STEPS.length]!;
	const dots = ".".repeat((Math.floor(tick / 6) % 3) + 1);
	return (
		<div className="thinking">
			<span className="thinking-spin">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</span>
			<motion.span
				key={step.face}
				className="thinking-face"
				initial={{ opacity: 0, y: 2, scale: 0.9 }}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				transition={{ duration: DUR.base, ease: EASE.out }}
			>
				{step.face}
			</motion.span>
		<span className="thinking-label">{step.label}</span>
		<span className="thinking-dots">{dots}</span>
	</div>
);
}

/** 上下文压缩中提示(手动 /compact 或阈值/溢出自动压缩;样式与思考提示区分)。 */
function CompactingIndicator() {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((v) => v + 1), 150);
		return () => clearInterval(t);
	}, []);
	const dots = ".".repeat((Math.floor(tick / 6) % 3) + 1);
	return (
		<div className="thinking compacting">
			<span className="thinking-spin">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</span>
			<span className="thinking-face">🗜️</span>
			<span className="thinking-label">正在压缩上下文</span>
			<span className="thinking-dots">{dots}</span>
		</div>
	);
}

/** 工具调用卡片:名称 + 参数 + 运行中/完成/失败状态。 */
/**
 * 这一轮要显示哪些工具卡片。
 *
 * 「简化输出」把工具卡片整体藏起来(默认开启,绝大多数文件类工具看一眼就够);
 * **bash 是唯一例外**:它是唯一能越过书目录边界的工具,命令与输出必须始终可见——
 * 藏了它,「打开外部命令」就等于开了一个看不见的黑箱。
 */
export function visibleToolCalls(toolCalls: ToolCallInfo[], simplifiedTools: boolean): ToolCallInfo[] {
	if (!simplifiedTools) return toolCalls;
	return toolCalls.filter((t) => t.name === "bash");
}

/**
 * 工具卡片(非简化输出)。两种形态:
 * - 普通工具:单行(状态点 + 名称 + 参数 + 状态胶囊),细节在 title 里;
 * - **bash(外部命令):命令与输出都摊开**——它是唯一能越过书目录边界的工具,
 *   运行中的 stdout/stderr 经 tool_execution_update 实时流进来(见 store 的归约),
 *   结束后把最终输出留在卡片上供回看。运行中自动滚到底(输出是快照替换)。
 *
 * 设计稿 03-组件规范/03:四张卡统一外壳;状态改胶囊;**工具卡正文不再是绿色**
 * (绿色是状态色,不是装饰色)。
 */
function ToolCard({ t }: { t: ToolCallInfo }) {
	const isShell = t.name === "bash";
	const running = t.result === null;
	const detail = running ? (t.stream ?? null) : t.result;
	const streamRef = useRef<HTMLPreElement | null>(null);

	useEffect(() => {
		if (running && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
	}, [t.stream, running]);

	const state = t.isError ? "err" : running ? "run" : "ok";
	const stateLabel = t.isError ? "失败" : running ? "运行中" : "完成";
	return (
		<div className={t.isError ? "tool err" : "tool"} data-live={running && detail !== null ? "1" : "0"} title={t.args}>
			<div className="tool-head">
				<ToolIcon kind={toolIcon(t.name)} />
				<span className="tool-name">{t.name}</span>
				<span className="tool-args">{t.args}</span>
				<span className={`tool-state ${state}`}>
					<span className="tool-state-dot" />
					{stateLabel}
				</span>
			</div>
			{/* bash 始终摊开输出;其他工具只在流式期间显示(结束后单行更省地方)。
			    流式中不折叠(折叠会把最新几行藏起来,而运行中要看的正是尾部),
			    结束后才按行数分档(见 FoldablePre) */}
			{detail !== null && detail !== "" && (isShell || running) &&
				(running ? (
					<pre ref={streamRef} className="tool-stream">
						{detail}
					</pre>
				) : (
					<FoldablePre text={detail} className="tool-stream" />
				))}
		</div>
	);
}

/** 完成/失败/进行中的状态小图标(动作流用;不用 emoji,见设计稿 03-组件规范/05)。 */
function ActionStateIcon({ state }: { state: "run" | "ok" | "err" }) {
	if (state === "run") {
		return (
			<svg className="act-spin" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" />
				<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
			</svg>
		);
	}
	if (state === "err") return <Lu icon="x" size={13} />;
	return <Lu icon="check" size={13} />;
}

/**
 * 简化输出的工具动作流(设计稿 03-组件规范/05):不是「什么都不显示」,而是把工具
 * 调用压成一行可读的动作——**带宾语**(在改哪个文件)、**完成的行留在流水里**
 * (最近 3 条)、不用 emoji。bash 不在这里出现(它始终渲染完整卡片,命令必须可见)。
 */
function ToolActionFlow({ tools }: { tools: ToolCallInfo[] }) {
	const rows = actionFlowTools(tools.filter((t) => t.name !== "bash"));
	if (rows.length === 0) return null;
	return (
		<div className="act-flow">
			{rows.map((t) => {
				const r = toolActionRow(t);
				const state = r.isError ? "err" : r.running ? "run" : "ok";
				return (
					<div key={t.id} className={`act-row ${state}`}>
						<span className="act-icon">
							<ActionStateIcon state={state} />
						</span>
						<span className="act-verb">{r.verb}</span>
						{r.object && <span className="act-object">{r.object}</span>}
					</div>
				);
			})}
		</div>
	);
}

/**
 * 思考计时:thinking 文本从空变非空时起表;流式中每秒刷新,消息结束(done)后
 * 固定最终秒数。历史水合的消息(挂载即已结束,无计时起点)保持 0(不显示秒数)。
 */
function useThinkingTimer(text: string, done: boolean): number {
	const startRef = useRef<number | null>(null);
	const [elapsed, setElapsed] = useState(0);

	// 起表:thinking 从空变非空的那一刻(消息开始思考);水合消息(done=true)不起表(2026-08-11)
	useEffect(() => {
		if (!done && text.length > 0 && startRef.current === null) {
			startRef.current = Date.now();
			setElapsed(0);
		}
	}, [text, done]);

	// 流式中:每秒推进秒数;结束(done)后停止并固定最终值
	useEffect(() => {
		if (done) {
			if (startRef.current !== null) {
				setElapsed(Math.max(1, Math.floor((Date.now() - startRef.current) / 1000)));
			}
			return;
		}
		if (startRef.current === null) return;
		const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current!) / 1000)), 1000);
		return () => clearInterval(t);
	}, [done]);

	return elapsed;
}

/**
 * 思考胶囊(设计稿 03-组件规范/04):**元信息行内**的一颗药丸——`› 思考 · 1,606 字`,
 * 展开时箭头翻转。字数带千分位、与「思考」之间用 `·` 分隔;秒数只在流式中出现
 * (结束后字数才是有效信息,设计稿收起来的也是这一种)。
 */
export function ThinkingToggle({
	text,
	done,
	open,
	onToggle,
}: {
	text: string;
	done: boolean;
	open: boolean;
	onToggle(): void;
}) {
	const elapsed = useThinkingTimer(text, done);
	return (
		<button type="button" className="think-toggle" aria-expanded={open} onClick={onToggle}>
			<span className="think-arrow" aria-hidden="true">
				<Lu icon={open ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
			</span>
			<span className="think-label">{done ? "思考" : "思考中"}</span>
			{!done && elapsed > 0 && <span className="think-time">· {elapsed} 秒</span>}
			<span className="think-len">· {text.length.toLocaleString("zh-CN")} 字</span>
		</button>
	);
}

/** 思考展开体(高度 auto 动画,180ms ease-inOut)。 */
export function ThinkingBody({ text, open }: { text: string; open: boolean }) {
	return (
		<AnimatePresence initial={false}>
			{open && (
				<motion.div
					key="body"
					className="think-body"
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={{ duration: DUR.base, ease: EASE.inOut }}
				>
					{text}
				</motion.div>
			)}
		</AnimatePresence>
	);
}

/** 思考块 = 胶囊 + 展开体(自管开合;消息流直接用上面两个部件把胶囊放进元信息行)。 */
export function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
	// 自动展开思考:挂载时读一次设置,之后点击由用户接管
	const [open, setOpen] = useState(() => autoExpandThinkingEnabled());
	return (
		<div className="think">
			<ThinkingToggle text={text} done={done} open={open} onToggle={() => setOpen((v) => !v)} />
			<ThinkingBody text={text} open={open} />
		</div>
	);
}

/** 一条稿件记录:无气泡,小号元信息标签 + 思考折叠块 + 正文 + 工具卡片。
 *  user 整行浅色背景 + 左侧琥珀边条(一眼区分);assistant 正文渲染 markdown。
 *  simplifiedTools 开启时工具卡片整体隐藏(只保留模型文本输出)。
 *  用户消息 hover 操作:每条显示「编辑」(撤回该消息及之后,以新文本重发——
 *  重发即新分支;AI 流式中隐藏)。 */
function Message({
	m,
	simplifiedTools,
	streaming,
	onEdit,
}: {
	m: ChatMessage;
	simplifiedTools: boolean;
	streaming: boolean;
	onEdit?: (m: ChatMessage, newText: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	/** 思考展开态(缺省读设置里的「自动展开思考」,之后点击由用户接管)。 */
	const [thinkOpen, setThinkOpen] = useState(() => autoExpandThinkingEnabled());
	const hasThink = m.thinking.length > 0;
	// 编辑需要服务端 entry id 定位:历史水合与 message_end 后都有,乐观气泡(发送瞬间)没有
	const canAct = m.role === "user" && !streaming && m.entryId !== undefined;
	// data-who:气泡差分(舞台)用它给头像渲染首字,不必让消息流认识舞台/角色
	return (
		<div className={m.role === "user" ? "record user" : "record assistant"} data-who={m.role === "user" ? "你" : "PI"}>
			{/* 元信息行:发言人 + 思考胶囊 + 操作(设计稿 03-组件规范/04——
			    胶囊就在这一行里,不再自占一行) */}
			<div className="record-meta">
				<span className="record-who">{m.role === "user" ? "你" : "PI"}</span>
				{hasThink && (
					<ThinkingToggle text={m.thinking} done={m.done} open={thinkOpen} onToggle={() => setThinkOpen((v) => !v)} />
				)}
				{/* 操作行:常驻可见(设计稿 03-组件规范/04——原来 hover-only,触屏不可达)。
				    user:编辑(撤回并重发)+ 复制;assistant:复制。AI 流式中隐藏 */}
				{(canAct || (m.role === "assistant" && !streaming && m.text.length > 0)) && !editing && (
					<span className="record-actions">
						{canAct && (
							<button
								type="button"
								className="record-act"
								title="撤回此消息及其后对话,以新文本重发"
								onClick={() => {
									setEditing(true);
									setEditText(m.text);
								}}
							>
								编辑
							</button>
						)}
						<button
							type="button"
							className="record-act"
							title="复制这条消息的正文"
							onClick={() => void navigator.clipboard?.writeText(m.text)}
						>
							复制
						</button>
					</span>
				)}
			</div>
			{hasThink && <ThinkingBody text={m.thinking} open={thinkOpen} />}
			{editing ? (
				<div className="record-edit">
					<textarea
						className="record-edit-input"
						autoFocus
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						onKeyDown={(e) => {
							// Ctrl+Enter 确认(与输入框一致);Escape 取消
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								submitEdit();
							} else if (e.key === "Escape") {
								setEditing(false);
							}
						}}
					/>
					<div className="record-edit-actions">
						<button type="button" className="btn-primary" disabled={editText.trim().length === 0} onClick={submitEdit}>
							更新并重发
						</button>
						<button type="button" className="record-act" onClick={() => setEditing(false)}>
							取消
						</button>
					</div>
				</div>
			) : (
				<>
					{m.text.length > 0 &&
						(m.role === "user" ? (
							<div className="record-text">{m.text}</div>
						) : (
							<div className="record-text record-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
						))}
					{/* 工具区:简化输出走「动作流 + bash 完整卡片」(设计稿 03-组件规范/05),
					    否则每张卡完整渲染。简化输出隐藏的只是「看一眼就够」的卡片;
					    bash 例外——命令必须可见 */}
					{simplifiedTools ? (
						<>
							<ToolActionFlow tools={m.toolCalls} />
							{m.toolCalls.filter((t) => t.name === "bash").length > 0 && (
								<div className="tools">
									{m.toolCalls
										.filter((t) => t.name === "bash")
										.map((t) => (
											<ToolCard key={t.id} t={t} />
										))}
								</div>
							)}
						</>
					) : (
						m.toolCalls.length > 0 && (
							<div className="tools">
								{m.toolCalls.map((t) => (
									<ToolCard key={t.id} t={t} />
								))}
							</div>
						)
					)}
				</>
			)}
		</div>
	);

	function submitEdit() {
		const text = editText.trim();
		setEditing(false);
		// 空文本不发(与主输入框一致);文本未修改也照样发送——编辑 = 分支 + 重发
		if (text.length === 0) return;
		onEdit?.(m, text);
	}
}

/**
 * Message 渲染相等性(memo 比较器,P2,2026-08):流式对话每 delta 触发列表重渲染,
 * 已结束消息重复 marked.parse 是主要成本——memo 后流式 delta 只重渲染「进行中的
 * 消息」。注意 toolCalls 数组每次 reducer 更新都是新身份(tool_execution_end 会
 * map 整列表),不能做引用比较,必须逐字段比内容;onEdit 是经 ref 调用的稳定包装
 * (editWriterMessage 内部只读 refs),身份变化不影响渲染结果,忽略。
 * 比较器返回 true = 跳过重渲染;任何渲染字段(role/text/thinking/done/toolCalls/
 * simplifiedTools/streaming)变化都返回 false 照常重渲染。 */
function messagePropsEqual(
	prev: { m: ChatMessage; simplifiedTools: boolean; streaming: boolean },
	next: { m: ChatMessage; simplifiedTools: boolean; streaming: boolean },
): boolean {
	if (prev.simplifiedTools !== next.simplifiedTools || prev.streaming !== next.streaming) return false;
	const a = prev.m;
	const b = next.m;
	if (a === b) return true;
	if (a.id !== b.id || a.entryId !== b.entryId || a.role !== b.role) return false;
	if (a.text !== b.text || a.thinking !== b.thinking || a.done !== b.done) return false;
	const ca = a.toolCalls;
	const cb = b.toolCalls;
	if (ca.length !== cb.length) return false;
	for (let i = 0; i < ca.length; i++) {
		const x = ca[i]!;
		const y = cb[i]!;
		if (x.id !== y.id || x.name !== y.name || x.args !== y.args || x.result !== y.result || x.isError !== y.isError) return false;
	}
	return true;
}

const MessageMemo = memo(Message, messagePropsEqual);

/**
 * 预览卡片锚点匹配:anchorId 可能是内存随机 id(实时回合)或会话 entryId
 * (message_end 稳定化后/水合恢复);消息的 id 实时为随机 id、水合后为 entryId,
 * entryId 作为附加字段存在——双通道匹配保证卡片不落孤儿区。
 */
function anchorMatches(m: ChatMessage, anchorId: string): boolean {
	return m.id === anchorId || m.entryId === anchorId;
}

/** 确认卡锚点丢失判定:无锚点(null,编辑时还没有 assistant 消息)或消息列表中无匹配。 */
function confirmAnchorLost(messages: ChatMessage[], c: ConfirmCardItem): boolean {
	const anchorId = c.anchorId;
	if (anchorId === null) return true;
	return !messages.some((m) => anchorMatches(m, anchorId));
}

/**
 * 消息列表:滚动容器 + 自动滚底。用户在流式阅读时上翻,则暂停跟随;
 * 新消息出现时恢复跟随底部。AI 输出中(isStreaming)在列表末尾显示
 * 思考中/分析中/创作中 状态提示。
 */
export function MessageList({
	messages,
	streaming,
	compacting,
	simplifiedTools,
	confirmCards,
	onConfirmCard,
	onRevertCard,
	onEdit,
	emptyText = "向 pi 发一句话,开始今晚的写作",
}: {
	messages: ChatMessage[];
	/** AI 输出中:列表末尾显示动态状态提示(转圈 + 文案/颜文字轮换)。 */
	streaming: boolean;
	/** 上下文压缩中:列表末尾显示「正在压缩上下文」。 */
	compacting?: boolean;
	simplifiedTools: boolean;
	/** 编剧编辑确认卡列表:与预览卡同锚定规则(触发编辑的 assistant 消息下)。
	 *  与预览卡并存时各自独立渲染(确认卡不是回合汇总,一编辑一张)。 */
	confirmCards?: ReadonlyArray<ConfirmCardItem>;
	/** 确认编剧编辑(归档删卡;文件已落盘)。 */
	onConfirmCard?: (id: string) => void;
	/** 回退编剧编辑(写回编辑前状态)。 */
	onRevertCard?: (id: string) => void;
	/** 编辑用户消息(撤回该消息及之后,以新文本重发);缺省隐藏编辑按钮。 */
	onEdit?: (m: ChatMessage, newText: string) => void;
	/** 空态文案(编剧等复用场景传入专属文案;缺省为写作 agent 提示)。 */
	emptyText?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const countRef = useRef(messages.length);
	/** 已见过(已入场)的消息 id 集合:渲染期只读,提交期(useEffect)推进。 */
	const seenIdsRef = useRef<Set<string> | null>(null);
	/** 批量静默阈值:单次渲染新增 >2 条视为历史水合(切章/重连对齐),整体静默呈现,
	 *  不整列表重播入场动画;真实新消息一次只来 1 条(user 乐观气泡或 assistant 开始)。 */
	const BATCH_SILENT = 2;

	// 新增消息判定:seen 集合只在提交期(useEffect)维护,渲染期只读——
	// StrictMode dev 双渲染时两次调用读到同一 seen,newIds 一致,入场动画正常播放
	const seen = seenIdsRef.current;
	let newIds: string[] = [];
	if (seen !== null) {
		newIds = messages.filter((m) => !seen.has(m.id)).map((m) => m.id);
	}
	if (newIds.length > BATCH_SILENT) newIds = [];

	// 提交期推进 seen(幂等;StrictMode effect 双跑无副作用)。首次渲染(历史水合)播种,
	// 之后新增消息才会被检出
	useEffect(() => {
		const cur = seenIdsRef.current;
		if (cur === null) {
			seenIdsRef.current = new Set(messages.map((m) => m.id));
			return;
		}
		for (const m of messages) {
			if (!cur.has(m.id)) cur.add(m.id);
		}
	}, [messages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		// 新消息出现时恢复跟随底部
		if (messages.length !== countRef.current) {
			countRef.current = messages.length;
			stickRef.current = true;
		}
		if (stickRef.current) el.scrollTop = el.scrollHeight;
	}, [messages]);

	function handleScroll() {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
	}

	return (
		<div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
			{/* 空态仅当无消息且无恢复卡片(服务端持久化预读的卡片在空会话下也要可见) */}
			{messages.length === 0 && !streaming ? (
				<div className="chat-empty">{emptyText}</div>
				) : (
					<div className="chat-inner">
						{messages.map((m, i) => {
							const idx = newIds.indexOf(m.id);
						// 仅新增消息带入场动画(右缘列:从右侧水平滑入,40ms 交错,上限 8 条)
						return (
							<Fragment key={m.id}>
								<motion.div
									key={m.id}
									initial={idx >= 0 ? EDGE_IN.right : false}
									animate={{ opacity: 1, x: 0 }}
										transition={{
											duration: DUR.base,
											ease: EASE.out,
											delay: idx >= 0 ? Math.min(idx * STAGGER, 0.32) : 0,
										}}
									>
									<MessageMemo
										m={m}
										simplifiedTools={simplifiedTools}
										streaming={streaming}
										onEdit={onEdit}
									/>
								</motion.div>
								{confirmCards?.filter((c) => c.anchorId !== null && anchorMatches(m, c.anchorId)).map((c) => (
									<ConfirmCard
										key={c.id}
										data={c.data}
										auto={c.auto}
										onConfirm={() => onConfirmCard?.(c.id)}
										onRevert={() => onRevertCard?.(c.id)}
									/>
								))}
							</Fragment>
						);
					})}
					{confirmCards?.filter((c) => confirmAnchorLost(messages, c)).map((c) => (
						<ConfirmCard
							key={c.id}
							data={c.data}
							auto={c.auto}
							onConfirm={() => onConfirmCard?.(c.id)}
							onRevert={() => onRevertCard?.(c.id)}
						/>
					))}
						{/* 状态提示:压缩中 > 工具执行中(简化输出)> 思考轮换;自动滚底会把它带进视野 */}
						{compacting ? (
							<CompactingIndicator />
						) : streaming ? (
							/* 简化输出下不再另起一条「🔧 正在编辑…」状态行:进行中的那一行就在
							   动作流里(带宾语、不用 emoji,见设计稿 03-组件规范/05) */
							<ThinkingIndicator />
						) : null}
					</div>
				)}
		</div>
	);
}
