import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChatErrorInfo, ChatMessage, ToolCallInfo } from "../types.ts";
import { DUR, EASE, EDGE_IN, STAGGER } from "../motion.ts";
import { renderMarkdown } from "../markdown.ts";
import { blocksText, formatDuration, turnDurationMs } from "../blocks.ts";
import { askAnswersOf, parseAskQuestions } from "../ask-user.ts";
import { chatErrorIcon } from "../chat-error.ts";
import type { PreviewData } from "../preview.ts";
import { AskUserRecord } from "./AskUserCard.tsx";
import { ConfirmCard, type ConfirmCardItem } from "./ConfirmCard.tsx";
import { FoldablePre } from "./FoldablePre.tsx";
import { Lu } from "./Lu.tsx";
import { PreviewCard } from "./PreviewCard.tsx";
import { ToolIcon } from "./ToolIcon.tsx";
import { toolActionRow, toolIcon, toolRenderForm } from "../tool-status.ts";
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
 * 上下文压缩中提示(手动 /compact 或阈值/溢出自动压缩;设计稿 ★对话 · 上下文压缩动画)。
 *
 * **只做「进行中」这一态,而且只做真实信息**:`compaction_start/end` 事件里只有
 * `reason`(manual / threshold / overflow),**没有条数、字数、步骤数、预计耗时** ——
 * 设计稿画的「第 2 / 3 步」「生成摘要 · 12 条消息 → 1 个摘要块」「约 8 秒」全都无从得来,
 * 所以一律不写(编出来的进度比没有进度更坏)。
 * 进度条走**不确定进度**的流光扫过 —— 这是"还在动"的诚实表达,不是假装知道百分比。
 * (完成态 / 失败态同样缺数据:压缩结束后 compacting 直接落回 false,没有留下条数;
 *  要做设计稿的「已压缩 N 条消息 · 摘要 M 字」得先让服务端把摘要条目数带出来。)
 */
function CompactingIndicator() {
	return (
		<div className="compact-card" role="status">
			<div className="compact-head">
				<span className="compact-spin" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 16 16">
						<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" />
						<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					</svg>
				</span>
				<span className="compact-title">正在压缩上下文…</span>
			</div>
			<div className="compact-bar" aria-hidden="true" />
			<div className="compact-note">压缩在后台进行，对话、输入框和发送都不会被阻塞。</div>
		</div>
	);
}

/**
 * 模型报错卡(设计稿 ★组件规范·回复渲染 v2 右列;需求 1「原文照实显示」)。
 *
 * 结构照设计稿:红图标 + 标题 + 右侧状态码徽标 → **原文框**(等宽、逐字、不折叠)
 * → 动作行(重试 / 复制原文 / 去设置模型 ›)→ 可选的处置提示行。
 *
 * 三条纪律:
 * 1. **原文框是主角** —— `info.raw` 原样铺进 `<pre>`,不截断、不摘要、不改写。
 *    用户要的是能整段贴给供应商的东西,标题与徽标只是旁注(归类失败也只是
 *    标题笼统,原文照旧完整)。
 * 2. **不编数字** —— 状态码来自 `info.code`(chat-error.ts 只认三种明确写法,
 *    取不到就是 null,徽标不出现),提示行来自归类,不拼「约 8 秒」这类假信息。
 * 3. **复制用原文** —— 复制按钮写的是 raw,不是卡片的可见标题,供应商要看的是原文。
 *
 * 动作按需出现:调用方没给 onRetry / onOpenSettings 就不画那颗按钮,而不是画一颗
 * 点了没反应的死按钮(舞台导演对话链路目前不上报 chat_error,自然没有重试语义)。
 */
function ChatErrorCard({
	info,
	onRetry,
	onOpenSettings,
}: {
	info: ChatErrorInfo;
	onRetry?: () => void;
	onOpenSettings?: () => void;
}) {
	/**
	 * 复制回执:null = 还没点;true = 成功;false = 失败(剪贴板不可用)。
	 *
	 * 2026-09-23 修:此前 `void navigator.clipboard?.writeText(...); setCopied(true)`
	 * 不看结果 —— 在非安全上下文(如用 `http://<局域网IP>` 打开,`navigator.clipboard`
	 * 是 undefined)或用户拒绝授权时,复制其实没发生,按钮却回执「已复制」,
	 * 用户拿去贴给供应商才发现是空的。
	 */
	const [copied, setCopied] = useState<boolean | null>(null);
	useEffect(() => {
		if (copied === null) return;
		const t = setTimeout(() => setCopied(null), 1600);
		return () => clearTimeout(t);
	}, [copied]);
	/**
	 * 复制的是**原文框里的全部内容**(原文 + provider/model 行),不是只复制 raw:
	 * 用户复制这段就是为了贴给供应商,而供应商第一句问的往往正是「哪个模型、哪个
	 * provider」。两行都是真实字段(不是拼出来的描述),照抄所见即所得。
	 */
	const copyText = info.meta ? `${info.raw}\n${info.meta}` : info.raw;
	/** 复制原文:真的写进去了才算成功(失败也说出来,别假回执)。 */
	async function copyRaw() {
		try {
			if (!navigator.clipboard) throw new Error("此环境不提供剪贴板接口");
			await navigator.clipboard.writeText(copyText);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}
	return (
		// role="alert":报错是需要在对话流里被读屏念出来的东西(不是装饰)
		<div className="err-card" role="alert">
			<div className="err-head">
				<span className="err-icon" aria-hidden="true">
					<Lu icon={chatErrorIcon(info.kind)} size={14} />
				</span>
				<span className="err-title">{info.title}</span>
				{info.code !== null && <span className="err-code">{info.code}</span>}
			</div>
			<pre className="err-raw">
				{info.raw}
				{info.meta && <span className="err-raw-meta">{`\n${info.meta}`}</span>}
			</pre>
			<div className="err-actions">
				{onRetry && (
					<button type="button" className="err-act primary" onClick={onRetry}>
						<Lu icon="refresh-cw" size={12} />
						重试
					</button>
				)}
				<button
					type="button"
					className="err-act"
					title="复制错误原文(含 request id / provider / model 等供应商侧字段)"
					onClick={() => void copyRaw()}
				>
					<Lu icon={copied === false ? "triangle-alert" : "copy"} size={12} />
					{copied === null ? "复制原文" : copied ? "已复制" : "复制失败"}
				</button>
				{onOpenSettings && (
					<button type="button" className="err-link" onClick={onOpenSettings}>
						去设置模型
						<Lu icon="chevron-right" size={12} />
					</button>
				)}
			</div>
			{info.hint && <div className="err-hint">{info.hint}</div>}
		</div>
	);
}

/**
 * 工具状态标签文案(设计稿 ★组件规范·回复渲染 v2):状态不再靠整行变色表达,
 * 收进行尾一颗方括号标签——成功绿、失败红、运行中琥珀。
 */
const STATE_LABEL: Record<"run" | "ok" | "err", string> = {
	run: "【运行中】",
	ok: "【成功】",
	err: "【失败】",
};

/** 工具调用卡片:名称 + 参数 + 运行中/完成/失败状态。 */
/**
 * 工具卡片(调试形态 / bash US):单行(状态点 + 名称 + 参数 + 状态胶囊),
 * 细节在 title 里;**bash(外部命令)把命令与输出都摊开**——它是唯一能越过书目录
 * 边界的工具,运行中的 stdout/stderr 经 tool_execution_update 实时流进来(见 store
 * 的归约),结束后把最终输出留在卡片上供回看。运行中自动滚到底(输出是快照替换)。
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
	return (
		<div className="tool" data-state={state} data-live={running && detail !== null ? "1" : "0"} title={t.args}>
			<div className="tool-head">
				<ToolIcon kind={toolIcon(t.name)} />
				<span className="tool-name">{t.name}</span>
				<span className="tool-args">{t.args}</span>
				<span className={`act-state ${state}`}>{STATE_LABEL[state]}</span>
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

/** 完成/失败/进行中的状态小图标(动作行用;不用 emoji,见设计稿 03-组件规范/05)。 */
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

/** 失败时露出的错误详情:取首行、限长(全文在 title 与调试卡里)。 */
function errorDetailLine(result: string | null): string | null {
	if (!result) return null;
	const first = result.split("\n").find((l) => l.trim().length > 0)?.trim();
	if (!first) return null;
	return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

/**
 * 读取型工具的**一行**(设计稿 03-组件规范/05 + ★组件规范·回复渲染 v2):不是
 * 「什么都不显示」,而是把工具调用压成一行可读的动作——**带宾语**(在改哪个文件)、
 * **不用 emoji**。
 *
 * 与改造前的区别:那时是一整块「动作流」(所有工具挤在一处、只留最近 3 条),
 * 现在每个工具块各占一行、落在它真实发生的位置上,历史行不再被丢弃
 * (行有了位置,要省地方自己折)。
 *
 * **状态表达(2026-09-22)**:不再整行变色(动词/宾语跟着状态红/琥珀,整行看着像
 * 在报错)——图标、动作、文件保持原样,状态收进行尾一颗方括号标签:成功绿、失败红;
 * 失败时下方再缩进一行错误详情,给出真正的失败原因(如 `pandoc: command not found`)。
 */
function ToolActionRow({ t }: { t: ToolCallInfo }) {
	const r = toolActionRow(t);
	const state = r.isError ? "err" : r.running ? "run" : "ok";
	const detail = state === "err" ? errorDetailLine(t.result) : null;
	return (
		<>
			<div className="act-row" data-state={state} title={t.args}>
				<span className="act-icon">
					<ActionStateIcon state={state} />
				</span>
				<span className="act-verb">{r.verb}</span>
				{r.object && <span className="act-object">{r.object}</span>}
				<span className={`act-state ${state}`}>{STATE_LABEL[state]}</span>
			</div>
			{detail && (
				<div className="act-error" title={t.result ?? undefined}>
					{detail}
				</div>
			)}
		</>
	);
}

/**
 * 工具块的渲染分发(块渲染表见 tool-status.ts 的 toolRenderForm)。
 *
 * `preview`(产出型工具)优先渲染**卡片**:编剧编辑确认卡(带确认/回退)或只读预览卡
 * (舞台世界树更新)。卡片按 toolCallId 认领——它就是这个块的渲染结果,不再锚定消息。
 * **认领不到就降级为动作行**,而不是像改造前那样飘到列表末尾兜底:卡片的宿主只能是
 * 工具块,块不在就没有卡。降级不是异常态(取数失败、无实质变化、非编辑类工具都走这里)。
 */
function ToolBlock({
	t,
	debug,
	cards,
	onConfirmCard,
	onRevertCard,
}: {
	t: ToolCallInfo;
	debug: boolean;
	cards?: ToolCardSlots;
	onConfirmCard?: (id: string) => void;
	onRevertCard?: (id: string) => void;
}) {
	const form = toolRenderForm(t.name, debug);
	// 默认不显示的工具失败时强制露出:静默会让「AI 好像什么都没干」,而失败恰恰是要看的东西
	if (form === "hidden") return t.isError ? <ToolActionRow t={t} /> : null;
	if (form === "terminal" || form === "card") return <ToolCard t={t} />;
	if (form === "ask") {
		const questions = parseAskQuestions(t.args);
		// 还没答:作答控件在浮层里(它必须模态,见 AskUserCard),块内只留占位,
		// 让「AI 问过、正等着」在对话流里有个位置
		if (t.result === null) {
			return (
				<div className="act-row ask-pending" data-state="run" title={questions[0]?.question}>
					<span className="act-icon">
						<ActionStateIcon state="run" />
					</span>
					<span className="act-verb">等待回答</span>
					{questions[0] && <span className="act-object">{questions[0].question}</span>}
				</div>
			);
		}
		return <AskUserRecord questions={questions} answers={askAnswersOf(t.result, questions.length)} />;
	}
	if (form === "preview") {
		const confirm = cards?.confirm?.get(t.id);
		if (confirm) {
			return (
				<ConfirmCard
					data={confirm.data}
					auto={confirm.auto}
					onConfirm={() => onConfirmCard?.(confirm.id)}
					onRevert={() => onRevertCard?.(confirm.id)}
				/>
			);
		}
		const preview = cards?.preview?.get(t.id);
		if (preview) return <PreviewCard data={preview.data} actions={preview.actions} />;
	}
	return <ToolActionRow t={t} />;
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
 *
 * 改造后每个思考块各有一颗(不再把整轮思考拼成一颗)——顺序交错得以成立。
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

/**
 * 思考块 = 胶囊 + 展开体(自管开合;消息流按块逐个挂)。
 *
 * **开合时机(2026-09-22,设计稿 ★组件规范·回复渲染 v2)**:思考链**只在 output
 * 期间自动展开,结束立刻折叠**——思考是过程,过程进行中值得看见,过程结束就该让位给
 * 正文结论。交错思考里的短思考同理(output 中展开、结束折叠),所以这里按块各自成立,
 * 不依赖「整轮思考」的汇总状态。
 *
 * 用户一旦手动点过,开合权就交给他,不再自动干预(否则读到一半被折叠)。
 */
export function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
	// 自动展开思考:首帧就定下来(挂载后再由 effect 纠正),避免先折叠再展开的闪烁
	const [open, setOpen] = useState(() => !done && text.length > 0 && autoExpandThinkingEnabled());
	const touched = useRef(false);
	useEffect(() => {
		if (touched.current) return;
		// 输出中 → 按设置展开;结束 → 立刻折叠
		setOpen(!done && text.length > 0 && autoExpandThinkingEnabled());
	}, [done, text.length]);
	return (
		<div className="think">
			<ThinkingToggle
				text={text}
				done={done}
				open={open}
				onToggle={() => {
					touched.current = true;
					setOpen((v) => !v);
				}}
			/>
			<ThinkingBody text={text} open={open} />
		</div>
	);
}

/** 只读预览卡槽:data + 可选底部动作区(剧本确认卡的「确认开演 / 需要修改」由页面注入)。 */
export interface PreviewCardSlot {
	data: PreviewData;
	actions?: ReactNode;
}

/**
 * 工具块的卡片槽(按 toolCallId 索引)。没进这两个 Map 的产出型工具块一律降级为动作行。
 * `confirm` = 编剧编辑确认卡(带确认/回退);`preview` = 只读预览卡(舞台世界树 / 剧本确认)。
 */
export interface ToolCardSlots {
	confirm?: ReadonlyMap<string, ConfirmCardItem>;
	preview?: ReadonlyMap<string, PreviewCardSlot>;
}

/**
 * 一条稿件记录:无气泡,小号元信息标签 + **按到达顺序排列的块** + 回合级过程折叠。
 *
 * 改造要点(2026-09-19):
 * - 思考 / 正文 / 工具不再是三段平铺,而是遍历 message.blocks 原样渲染 —— 工具卡
 *   落在它真正发生的位置(第 N 段思考与第 N+1 段思考之间),不再全堆在正文末尾;
 * - 每个思考块自带折叠胶囊,每个工具块自带渲染形态(见 ToolBlock);
 * - 元信息行多一颗**回合折叠胶囊**「› 已工作 2 分 53 秒」:一键把整轮过程
 *   (思考 + 工具)收起来,只留正文结论。流式中强制展开(过程正在发生,收起来没意义)。
 */
function Message({
	m,
	debug,
	streaming,
	cards,
	onEdit,
	onRetry,
	onOpenSettings,
	onConfirmCard,
	onRevertCard,
	resolveImage,
}: {
	m: ChatMessage;
	debug: boolean;
	streaming: boolean;
	/** 工具块卡片槽(由 MessageList 用 useMemo 构造:引用稳定,可作 memo 比较依据)。 */
	cards?: ToolCardSlots;
	onEdit?: (m: ChatMessage, newText: string) => void;
	/** 报错卡的「重试」(重放失败那一轮;由页面决定怎么重放)。 */
	onRetry?: (m: ChatMessage) => void;
	/** 报错卡的「去设置模型 ›」。 */
	onOpenSettings?: () => void;
	onConfirmCard?: (id: string) => void;
	onRevertCard?: (id: string) => void;
	/** 正文图片的相对路径解析(见 MessageListProps.resolveImage)。 */
	resolveImage?: (src: string) => string;
}) {
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	/** 过程折叠(整轮思考 + 工具)。缺省展开;流式中强制展开。 */
	const [procOpen, setProcOpen] = useState(true);
	const text = blocksText(m.blocks);
	const duration = turnDurationMs(m);
	/** 本轮是否有「过程」(思考或工具);没有就不给折叠胶囊。 */
	const hasProcess = m.blocks.some((b) => b.kind !== "text");
	const procShown = procOpen || !m.done;
	// 编辑需要服务端 entry id 定位:历史水合与 message_end 后都有,乐观气泡(发送瞬间)没有
	const canAct = m.role === "user" && !streaming && m.entryId !== undefined;
	// 报错消息:没有发言人、没有过程、没有编辑/复制正文 —— 它整条就是一张卡
	// (设计稿右列的卡自带标题与动作,再套一层『你/PI』元信息行只是噪音)
	if (m.role === "error") {
		if (!m.error) return null;
		return (
			<div className="record error">
				<ChatErrorCard
					info={m.error}
					onRetry={onRetry ? () => onRetry(m) : undefined}
					onOpenSettings={onOpenSettings}
				/>
			</div>
		);
	}
	// data-who:气泡差分(舞台)用它给头像渲染首字,不必让消息流认识舞台/角色
	return (
		<div className={m.role === "user" ? "record user" : "record assistant"} data-who={m.role === "user" ? "你" : "PI"}>
			{/* 元信息行:发言人 + 回合折叠胶囊 + 操作(设计稿 03-组件规范/04——
			    胶囊就在这一行里,不再自占一行) */}
			<div className="record-meta">
				<span className="record-who">{m.role === "user" ? "你" : "PI"}</span>
				{hasProcess && m.done && duration !== null && (
					<button
						type="button"
						className="think-toggle turn-fold"
						aria-expanded={procShown}
						title={procShown ? "收起这一轮的过程" : "展开这一轮的过程"}
						onClick={() => setProcOpen((v) => !v)}
					>
						<span className="think-arrow" aria-hidden="true">
							<Lu icon={procShown ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
						</span>
						<span className="think-label">已工作 {formatDuration(duration)}</span>
					</button>
				)}
				{/* 操作行:常驻可见(设计稿 03-组件规范/04——原来 hover-only,触屏不可达)。
				    user:编辑(撤回并重发)+ 复制;assistant:复制。AI 流式中隐藏 */}
				{(canAct || (m.role === "assistant" && !streaming && text.length > 0)) && !editing && (
					<span className="record-actions">
						{canAct && (
							<button
								type="button"
								className="record-act"
								title="撤回此消息及其后对话,以新文本重发"
								onClick={() => {
									setEditing(true);
									setEditText(text);
								}}
							>
								编辑
							</button>
						)}
						<button
							type="button"
							className="record-act"
							title="复制这条消息的正文"
							onClick={() => void navigator.clipboard?.writeText(text)}
						>
							复制
						</button>
					</span>
				)}
			</div>
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
					{/* 块按到达顺序渲染:思考 / 正文 / 工具交错。折叠只作用于过程块(思考 + 工具),
					    正文是结论,永远保留 */}
					{m.blocks.map((b, i) => {
						if (b.kind === "thinking") {
							if (!procShown || b.text.length === 0) return null;
							return <ThinkingBlock key={i} text={b.text} done={m.done} />;
						}
						if (b.kind === "tool") {
							if (!procShown) return null;
							return (
								<ToolBlock
									key={b.call.id}
									t={b.call}
									debug={debug}
									cards={cards}
									onConfirmCard={onConfirmCard}
									onRevertCard={onRevertCard}
								/>
							);
						}
						if (b.text.length === 0) return null;
						return m.role === "user" ? (
							<div key={i} className="record-text">
								{b.text}
							</div>
						) : (
							<div
								key={i}
								className="record-text record-md"
								dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text, { resolveImage }) }}
							/>
						);
					})}
				</>
			)}
		</div>
	);

	function submitEdit() {
		const text2 = editText.trim();
		setEditing(false);
		// 空文本不发(与主输入框一致);文本未修改也照样发送——编辑 = 分支 + 重发
		if (text2.length === 0) return;
		onEdit?.(m, text2);
	}
}

/**
 * Message 渲染相等性(memo 比较器,P2,2026-08):
 * 流式对话每 delta 触发列表重渲染,已结束消息重复 marked.parse 是主要成本——
 * memo 后流式 delta 只重渲染「进行中的消息」。
 *
 * 块化后必须**逐块按内容比较**:blocks 数组每次归约都是新身份(appendDelta 造新
 * 数组),引用比较会让每个 delta 都判定为变化(退化成没有 memo);反过来漏比某个
 * 字段会让流式内容静默不更新。两者都难查,所以这里显式列全渲染相关字段。
 * onEdit 是经 ref 调用的稳定包装(editWriterMessage 内部只读 refs),身份变化不影响
 * 渲染结果,忽略。
 * 比较器返回 true = 跳过重渲染。
 */
function messagePropsEqual(
	prev: { m: ChatMessage; debug: boolean; streaming: boolean; cards?: ToolCardSlots; resolveImage?: (src: string) => string },
	next: { m: ChatMessage; debug: boolean; streaming: boolean; cards?: ToolCardSlots; resolveImage?: (src: string) => string },
): boolean {
	if (prev.debug !== next.debug || prev.streaming !== next.streaming) return false;
	// resolveImage 由页面 useCallback 稳定(它依赖当前书 slug);变了必须重渲染,
	// 否则切书后正文图片仍指着旧书的 URL
	if (prev.resolveImage !== next.resolveImage) return false;
	// cards 由 MessageList 的 useMemo 构造(toolCallId 映射),引用稳定;变异则整表重建
	if (prev.cards !== next.cards) return false;
	const a = prev.m;
	const b = next.m;
	if (a === b) return true;
	if (a.id !== b.id || a.entryId !== b.entryId || a.role !== b.role) return false;
	if (a.done !== b.done || a.startedAt !== b.startedAt || a.endedAt !== b.endedAt) return false;
	// 报错卡内容(role="error"):按字段比,漏比会让报错卡静默不更新(同 blocks 的道理)
	if (a.error !== b.error) {
		if (!a.error || !b.error) return false;
		if (
			a.error.raw !== b.error.raw ||
			a.error.title !== b.error.title ||
			a.error.code !== b.error.code ||
			a.error.kind !== b.error.kind ||
			a.error.hint !== b.error.hint ||
			a.error.meta !== b.error.meta
		) {
			return false;
		}
	}
	const ba = a.blocks;
	const bb = b.blocks;
	if (ba.length !== bb.length) return false;
	for (let i = 0; i < ba.length; i++) {
		const x = ba[i]!;
		const y = bb[i]!;
		if (x.kind !== y.kind) return false;
		if (x.kind === "tool" || y.kind === "tool") {
			if (x.kind !== "tool" || y.kind !== "tool") return false;
			const cx = x.call;
			const cy = y.call;
			if (
				cx.id !== cy.id ||
				cx.name !== cy.name ||
				cx.args !== cy.args ||
				cx.result !== cy.result ||
				cx.isError !== cy.isError ||
				cx.stream !== cy.stream
			) {
				return false;
			}
			continue;
		}
		if (x.text !== y.text) return false;
	}
	return true;
}

const MessageMemo = memo(Message, messagePropsEqual);

/**
 * 消息列表:滚动容器 + 自动滚底。用户在流式阅读时上翻,则暂停跟随;
 * 新消息出现时恢复跟随底部。AI 输出中(isStreaming)在列表末尾显示
 * 思考中/分析中/创作中 状态提示。
 *
 * 卡片层已取消(2026-09-19):预览卡/确认卡不再是锚定在消息下的独立一层
 * (连同 anchorMatches / confirmAnchorLost / 锚点升级 dance 一起删掉),
 * 它们由 `cards` 按 toolCallId 交给对应工具块渲染,块在卡就在。
 */
export function MessageList({
	messages,
	streaming,
	compacting,
	debug,
	confirmCards,
	previewCards,
	onConfirmCard,
	onRevertCard,
	onEdit,
	onRetry,
	onOpenSettings,
	emptyText = "向 pi 发一句话,开始今晚的写作",
	resolveImage,
}: {
	messages: ChatMessage[];
	/** AI 输出中:列表末尾显示动态状态提示(转圈 + 文案/颜文字轮换)。 */
	streaming: boolean;
	/** 上下文压缩中:列表末尾显示「正在压缩上下文」。 */
	compacting?: boolean;
	debug: boolean;
	/** 编剧编辑确认卡(按 toolCallId 认领到对应的 write/edit 工具块上)。 */
	confirmCards?: ReadonlyArray<ConfirmCardItem>;
	/** 只读预览卡(舞台世界树 / 剧本确认),同样按 toolCallId 挂到工具块上。 */
	previewCards?: ReadonlyMap<string, PreviewCardSlot>;
	/** 确认编剧编辑(归档删卡;文件已落盘)。 */
	onConfirmCard?: (id: string) => void;
	/** 回退编剧编辑(写回编辑前状态)。 */
	onRevertCard?: (id: string) => void;
	/** 编辑用户消息(撤回该消息及之后,以新文本重发);缺省隐藏编辑按钮。 */
	onEdit?: (m: ChatMessage, newText: string) => void;
	/** 报错卡的「重试」(重放失败那一轮);缺省不画这颗按钮。 */
	onRetry?: (m: ChatMessage) => void;
	/** 报错卡的「去设置模型 ›」;缺省不画这个入口。 */
	onOpenSettings?: () => void;
	/** 空态文案(编剧等复用场景传入专属文案;缺省为写作 agent 提示)。 */
	emptyText?: string;
	/**
	 * 把正文 markdown 里图片的书内相对路径(images/xxx.png)换成可访问 URL。
	 * 渲染层不知道当前书 slug,所以由页面注入(见 WritePage 的 resolveImage)。
	 */
	resolveImage?: (src: string) => string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const countRef = useRef(messages.length);
	/**
	 * 报错卡的两个动作经 ref 转发成稳定身份。理由与 onEdit 相同:Message 是 memo 的,
	 * 比较器按设计忽略这两个 prop(它们的身份每次渲染都会变),所以卡片**可能不会**
	 * 随父组件重渲染而更新闭包 —— 直接传函数会让「重试」点下去读到旧 state。
	 * 用 ref 读最新值,身份稳定 + 行为永远最新,两个都要。
	 */
	const retryRef = useRef(onRetry);
	retryRef.current = onRetry;
	const settingsRef = useRef(onOpenSettings);
	settingsRef.current = onOpenSettings;
	const retryStable = useCallback((m: ChatMessage) => retryRef.current?.(m), []);
	const openSettingsStable = useCallback(() => settingsRef.current?.(), []);
	/**
	 * 卡片槽(按 toolCallId 索引)。**必须是 memo 化的稳定引用**:Message 的 memo
	 * 比较器按引用比 cards,每渲染重建 Map 会让整列表失去 memo(流式 delta 全量重渲)。
	 */
	const cards = useMemo<ToolCardSlots>(
		() => ({
			confirm: new Map((confirmCards ?? []).map((c) => [c.toolCallId, c])),
			preview: previewCards,
		}),
		[confirmCards, previewCards],
	);
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
			{messages.length === 0 && !streaming ? (
				<div className="chat-empty">{emptyText}</div>
				) : (
					<div className="chat-inner">
						{messages.map((m, i) => {
							const idx = newIds.indexOf(m.id);
						// 仅新增消息带入场动画(右缘列:从右侧水平滑入,40ms 交错,上限 8 条)
						return (
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
									debug={debug}
									streaming={streaming}
									cards={cards}
									onEdit={onEdit}
									onRetry={onRetry ? retryStable : undefined}
									onOpenSettings={onOpenSettings ? openSettingsStable : undefined}
									onConfirmCard={onConfirmCard}
									onRevertCard={onRevertCard}
									resolveImage={resolveImage}
								/>
							</motion.div>
						);
					})}
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
