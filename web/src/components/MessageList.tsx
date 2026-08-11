import { Fragment, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { DUR, EASE, EDGE_IN, STAGGER } from "../motion.ts";
import { renderMarkdown } from "../markdown.ts";
import { ConfirmCard, type ConfirmCardItem } from "./ConfirmCard.tsx";
import { activeToolName, DEFAULT_TOOL_STATUS, TOOL_STATUS } from "../tool-status.ts";
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

/**
 * 简化输出下的工具状态提示:spinner + 「正在编辑/正在阅读…」。
 * 工具执行期间取代轮换的思考文案,让用户知道模型此刻在做什么
 * (非简化模式下工具卡片可见,提示不重复出现)。
 */
function ToolStatusIndicator({ label }: { label: string }) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((v) => v + 1), 150);
		return () => clearInterval(t);
	}, []);
	const dots = ".".repeat((Math.floor(tick / 6) % 3) + 1);
	return (
		<div className="thinking tool-status">
			<span className="thinking-spin">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</span>
			<span className="thinking-face">🔧</span>
			<span className="thinking-label">{label}</span>
			<span className="thinking-dots">{dots}</span>
		</div>
	);
}

/**
 * 上下文压缩提示(「正在压缩上下文」):压缩可能发生在流式回合内或回合之间,
 * 独立于 isStreaming 显示——compacting 为真即展示,compaction_end 后消失。
 */
function CompactionIndicator() {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((v) => v + 1), 150);
		return () => clearInterval(t);
	}, []);
	const dots = ".".repeat((Math.floor(tick / 6) % 3) + 1);
	return (
		<div className="thinking compacting">
			<span className="thinking-spin">{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}</span>
			<span className="thinking-face">📦</span>
			<span className="thinking-label">正在压缩上下文</span>
			<span className="thinking-dots">{dots}</span>
		</div>
	);
}

/** 工具调用卡片:名称 + 参数 + 运行中/完成/失败状态。 */
function ToolCard({ t }: { t: ToolCallInfo }) {
	return (
		<div className={t.isError ? "tool err" : "tool"} title={t.result ?? t.args}>
			<span className="tool-name">{t.name}</span>
			<span className="tool-args">{t.args}</span>
			<span className="tool-result">{t.isError ? "失败" : t.result === null ? "运行中" : "完成"}</span>
		</div>
	);
}

/**
 * 思考折叠块:斜体灰,自动展开(设置页「界面偏好」开关,缺省开启)或点击展开/收起。
 * 带「思考 x 秒」计时:thinking 文本从空变非空时起表;流式中每秒刷新
 * (「思考中 x 秒」),消息结束(done)后固定显示最终秒数。历史水合的消息
 * (挂载即已结束,无计时起点)不显示秒数(elapsed 保持 0)。
 * 导出供舞台页导演气泡复用(思考链折叠查看)。
 */
export function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
	// 自动展开思考:缺省开启;挂载时读一次,之后点击由用户接管
	const [open, setOpen] = useState(() => autoExpandThinkingEnabled());
	const startRef = useRef<number | null>(null);
	const [elapsed, setElapsed] = useState(0);

	// 起表:thinking 从空变非空的那一刻(消息开始思考);水合消息(done=true)不起表——
	// 重载思维链无计时起点,不显示秒数(2026-08-11)
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

	return (
		<div className="think">
			<button className="think-toggle" onClick={() => setOpen((v) => !v)}>
				<span className="think-arrow">{open ? "▾" : "▸"}</span>
				<span className="think-label">{done ? "思考" : "思考中"}</span>
				{elapsed > 0 && <span className="think-time">{elapsed} 秒</span>}
				<span className="think-len">{text.length} 字</span>
			</button>
			{/* 展开/收起:高度 auto 动画,180ms ease-inOut */}
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
	// 编辑需要服务端 entry id 定位:历史水合与 message_end 后都有,乐观气泡(发送瞬间)没有
	const canAct = m.role === "user" && !streaming && m.entryId !== undefined;
	return (
		<div className={m.role === "user" ? "record user" : "record assistant"}>
			<div className="record-meta">
				{m.role === "user" ? "你" : "PI"}
				{/* 操作按钮:hover 消息时显示;AI 流式中隐藏(服务端拒绝流式中操作) */}
				{canAct && !editing && (
					<span className="record-actions">
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
					</span>
				)}
			</div>
			{m.thinking.length > 0 && <ThinkingBlock text={m.thinking} done={m.done} />}
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
						<button type="button" className="btn-send" disabled={editText.trim().length === 0} onClick={submitEdit}>
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
					{!simplifiedTools && m.toolCalls.length > 0 && (
						<div className="tools">
							{m.toolCalls.map((t) => (
								<ToolCard key={t.id} t={t} />
							))}
						</div>
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
	simplifiedTools,
	compacting,
	confirmCards,
	onConfirmCard,
	onRevertCard,
	onEdit,
	emptyText = "向 pi 发一句话,开始今晚的写作",
}: {
	messages: ChatMessage[];
	/** AI 输出中:列表末尾显示动态状态提示(转圈 + 文案/颜文字轮换)。 */
	streaming: boolean;
	simplifiedTools: boolean;
	/** 上下文压缩中(compaction_start 置位):显示「正在压缩上下文」提示。 */
	compacting: boolean;
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

	// 当前正在执行的工具(简化输出下显示「正在编辑/正在阅读…」;无工具回退思考轮换)
	const activeTool = activeToolName(messages);
	/**
	 * 工具状态最小展示时长:本地工具(读/写/统计/世界书)执行极快(<1s),
	 * 若只随执行窗口渲染,提示闪烁一瞬、人眼捕捉不到。工具结束后仍停留
	 * 至 until,保证每个工具状态至少可见该时长;新工具开始则重新计时。
	 */
	const MIN_TOOL_STATUS_MS = 1200;
	const [toolStatus, setToolStatus] = useState<{ name: string; until: number } | null>(null);

	// 工具变化(新工具开始)时重置最小展示计时;同一工具持续执行中不重置
	useEffect(() => {
		if (activeTool) setToolStatus({ name: activeTool, until: Date.now() + MIN_TOOL_STATUS_MS });
	}, [activeTool]);

	// 最小展示时长到期:清掉状态,回退思考轮换(deps 变化时 cleanup 先清旧定时器)
	useEffect(() => {
		if (!toolStatus) return;
		const remain = toolStatus.until - Date.now();
		const t = setTimeout(() => setToolStatus(null), Math.max(0, remain));
		return () => clearTimeout(t);
	}, [toolStatus]);

	// 展示优先级:仍在执行的工具 > 刚结束、仍在最小展示窗内的工具 > 思考轮换
	const toolToShow = activeTool ?? (toolStatus && Date.now() < toolStatus.until ? toolStatus.name : null);

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
									<Message
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
						{compacting && <CompactionIndicator />}
						{!compacting && streaming && (simplifiedTools && toolToShow ? (
							<ToolStatusIndicator label={TOOL_STATUS[toolToShow] ?? DEFAULT_TOOL_STATUS} />
						) : (
							<ThinkingIndicator />
						))}
					</div>
				)}
		</div>
	);
}
