/**
 * 提问卡片 —— ask_user 工具的两态渲染。
 *
 * - **未回答**(工具块 result 为 null):`AskUserOverlay` 从**当前可见的输入条**上沿弹出。
 *   它必须是模态的(背后有薄遮罩):工具阻塞在 `execute` 里等着,不存在「先放着不管
 *   去干别的」;要退出只有作答、跳过或关闭(关闭 = 取消)。
 * - **已回答**:`AskUserRecord` 折在工具块里(问题一行、答案一行),跟着对话留在记录里。
 *
 * 为什么从输入条弹出而不是居中弹窗:提问发生在"正在跟这个 AI 说话"的语境里,卡片
 * 贴着说话的地方出现才不打断上下文;而且编辑页的 AI 在右栏、舞台页在主区,居中弹窗
 * 会飘在无关区域上方。定位靠实测可见输入条的包围盒(三页常驻挂载,`.inputbar` 有多个,
 * 只能靠 `offsetParent` 挑出可见那个)。
 *
 * 一题两种形态:单选(编号)与多选(复选框)。多选题的「其他补充」是**追加**项,
 * 不会清掉已勾的候选;单选题两者互斥(选候选清掉补充文本,反之亦然)。
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { DUR, EASE } from "../motion.ts";
import { nextUnsettled, type AskQuestionView } from "../ask-user.ts";
import { Lu } from "./Lu.tsx";

/** 单个提问的作答:勾了哪几项 + 自由补充文本(单选时前者至多一项)。 */
interface Ans {
	indexes: number[];
	other: string;
}

const EMPTY: Ans = { indexes: [], other: "" };

/** 把作答拼成给模型的答案文本(与后端「、」连接的约定一致)。 */
function answerText(q: AskQuestionView, a: Ans | undefined): string {
	if (!a) return "";
	const picked = a.indexes.map((i) => q.options[i]).filter((s): s is string => typeof s === "string");
	const parts = [...picked, a.other.trim()].filter((s) => s.length > 0);
	return parts.join("、");
}

function isFilled(q: AskQuestionView, a: Ans | undefined): boolean {
	return answerText(q, a).length > 0;
}

/** 量出的输入条位置(视口坐标,直接喂给 fixed 定位的卡片)。 */
interface AskAnchor {
	left: number;
	width: number;
	/** 卡片底边距视口底的高度 —— 贴着输入条上沿。 */
	bottom: number;
}

/** 卡片宽度区间:比输入条宽(输入条可能很窄,如右栏 340),但不至于变成居中弹窗。 */
const CARD_MIN = 460;
const CARD_MAX = 640;
const CARD_GAP = 10;
const VIEWPORT_PAD = 12;

function measureAnchor(): AskAnchor | null {
	if (typeof document === "undefined") return null;
	// 三页常驻挂载:隐藏页的元素 offsetParent 为 null,据此挑出真正可见的输入条
	const bar = [...document.querySelectorAll<HTMLElement>(".inputbar")].find((el) => el.offsetParent !== null);
	if (!bar) return null;
	const r = bar.getBoundingClientRect();
	const width = Math.min(Math.max(r.width, CARD_MIN), Math.min(CARD_MAX, window.innerWidth - VIEWPORT_PAD * 2));
	const centered = r.left + r.width / 2 - width / 2;
	const left = Math.min(Math.max(centered, VIEWPORT_PAD), Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD));
	return { left, width, bottom: window.innerHeight - r.top + CARD_GAP };
}

/**
 * 提问浮层。多提问时上方出现 `‹ 2/3 ›` 翻页。
 *
 * 两个前进动作:
 * - **跳过**:本题留空(结算时写成「用户跳过,未作答」),跳到下一道未决题;
 * - **确认**(右下角箭头,**本题答了才出现**):记下答案,跳到下一道未决题。
 * 两者都在「没有未决题了」时提交 —— 所以不会出现「答到一半就提交、其余静默丢空」。
 */
export function AskUserOverlay({
	questions,
	onSubmit,
	onCancel,
}: {
	questions: AskQuestionView[];
	onSubmit(answers: string[]): void;
	onCancel(): void;
}) {
	const [index, setIndex] = useState(0);
	const [answers, setAnswers] = useState<Ans[]>(() => questions.map(() => EMPTY));
	const [skipped, setSkipped] = useState<boolean[]>(() => questions.map(() => false));
	const [otherOpen, setOtherOpen] = useState<boolean[]>(() => questions.map(() => false));
	/**
	 * 作答状态的**同步镜像**。
	 *
	 * 为什么需要:选择/跳过都要「写入新值 → 立刻根据新值决定去哪一题」,而 `setState`
	 * 是异步的 —— 同一 tick 内连点两次(多选连勾、快速跳题)第二次读到的还是上一次
	 * 渲染的闭包值,于是丢步。这和斜杠菜单上下键当初的毛病是同一类(见 slash-commands.ts
	 * 的 slashArrowMove)。镜子在写入时同步更新,读它就拿得到刚写下的值。
	 */
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const skippedRef = useRef(skipped);
	skippedRef.current = skipped;

	/** 写入作答状态(镜像 + state 一起),返回写入后的数组供调用方继续判断。 */
	function commitAnswers(next: Ans[]): Ans[] {
		answersRef.current = next;
		setAnswers(next);
		return next;
	}
	function commitSkipped(next: boolean[]): boolean[] {
		skippedRef.current = next;
		setSkipped(next);
		return next;
	}
	const [anchor, setAnchor] = useState<AskAnchor | null>(() => measureAnchor());
	const otherRef = useRef<HTMLTextAreaElement | null>(null);

	const total = questions.length;
	const q = questions[index]!;
	const ans = answers[index];
	const multi = q.multiple === true;
	const answerable = isFilled(q, ans);
	const allSettled = questions.every((qq, i) => isFilled(qq, answers[i]) || skipped[i]);
	const selectedCount = ans?.indexes.length ?? 0;

	// 视口变化(窗口缩放 / 面板拖拽)后重新贴合输入条
	useEffect(() => {
		const measure = () => setAnchor(measureAnchor());
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	/** 记下第 i 题的作答。 */
	function setAns(i: number, next: Ans) {
		commitAnswers(answersRef.current.map((a, k) => (k === i ? next : a)));
	}

	function choose(optionIndex: number) {
		const cur = answersRef.current[index] ?? EMPTY;
		if (multi) {
			// 多选:切换勾选,「其他补充」保持不变(它是追加项)。不自动跳题 ——
			// 勾几项是连着的动作,替用户决定"勾完一个就走"会打断他
			const indexes = cur.indexes.includes(optionIndex) ? cur.indexes.filter((i) => i !== optionIndex) : [...cur.indexes, optionIndex];
			setAns(index, { indexes, other: cur.other });
			return;
		}
		// 单选:选候选即清掉自由文本(两者互斥),然后自动前进
		setAns(index, { indexes: [optionIndex], other: "" });
		setOtherOpen((prev) => prev.map((v, k) => (k === index ? false : v)));
		advanceOrSubmit(index);
	}

	function openOther() {
		setOtherOpen((prev) => prev.map((v, k) => (k === index ? true : v)));
		requestAnimationFrame(() => otherRef.current?.focus());
	}

	function typeOther(text: string) {
		// 单选:自由文本与候选互斥;多选:并存(补充说明)
		const cur = answersRef.current[index] ?? EMPTY;
		setAns(index, multi ? { indexes: cur.indexes, other: text } : { indexes: [], other: text });
	}

	/** 跳到下一道未决题;没有未决题就提交。读的是镜像,所以刚写入的值也算数。 */
	function advanceOrSubmit(from: number) {
		const settled = questions.map((qq, i) => isFilled(qq, answersRef.current[i]) || skippedRef.current[i]);
		const next = nextUnsettled(from, total, settled);
		if (next === null) submit();
		else setIndex(next);
	}

	function confirm() {
		if (!answerable) return;
		advanceOrSubmit(index);
	}

	function skip() {
		// 跳过时清掉本题的作答,避免"跳过"与"已答"并存产生歧义
		commitAnswers(answersRef.current.map((a, k) => (k === index ? EMPTY : a)));
		commitSkipped(skippedRef.current.map((v, k) => (k === index ? true : v)));
		advanceOrSubmit(index);
	}

	function submit() {
		const final = answersRef.current;
		onSubmit(questions.map((qq, i) => answerText(qq, final[i])));
	}

	// 键盘:Esc 关闭;数字键选(多选则切换);Enter 确认并前进/提交。
	// 正在写「其他补充」时数字键是正文,不抢。
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				if (otherOpen[index]) return; // 补充输入框自己处理(它把 Enter 当确认)
				e.preventDefault();
				confirm();
				return;
			}
			if (otherOpen[index]) return;
			const n = Number(e.key);
			if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
				e.preventDefault();
				choose(n - 1);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const answeredCount = questions.filter((qq, i) => isFilled(qq, answers[i])).length;

	return (
		<div className="ask-layer" aria-hidden={false}>
			{/* 薄遮罩:工具阻塞着等回答,背后不该还能点。点击不关闭(避免误触丢作答) */}
			<div className="ask-scrim" />
			<motion.div
				className="ask-card"
				role="dialog"
				aria-modal="true"
				aria-label="AI 提问"
				// 只给 left/width/bottom(不用 transform:入场动画的 y 会把它覆盖掉)。
				// anchor 量不到(极端情况:输入条还没挂上)时退化成底部居中,别让卡片飞走
				style={anchor ?? { left: Math.max(VIEWPORT_PAD, (window.innerWidth - CARD_MIN) / 2), width: CARD_MIN, bottom: 96 }}
				initial={{ opacity: 0, y: 16 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: DUR.base, ease: EASE.out }}
			>
				<div className="ask-head">
					<span className="ask-question">{q.question}</span>
					{total > 1 && (
						<span className="ask-pager">
							<button type="button" className="ask-pager-btn" aria-label="上一题" onClick={() => setIndex((i) => (i - 1 + total) % total)}>
								<Lu icon="chevron-left" size={13} strokeWidth={1.8} />
							</button>
							<span className="ask-pager-no">
								{index + 1}/{total}
							</span>
							<button type="button" className="ask-pager-btn" aria-label="下一题" onClick={() => setIndex((i) => (i + 1) % total)}>
								<Lu icon="chevron-right" size={13} strokeWidth={1.8} />
							</button>
						</span>
					)}
					<button type="button" className="ask-close" aria-label="关闭(不回答)" title="关闭(不回答)" onClick={onCancel}>
						<Lu icon="x" size={14} strokeWidth={1.8} />
					</button>
				</div>
				<div className="ask-options">
					{q.options.map((option, i) => {
						const on = ans?.indexes.includes(i) ?? false;
						return (
							<button key={i} type="button" className={on ? "ask-option on" : "ask-option"} onClick={() => choose(i)}>
								{/* 单选给编号,多选给复选框 —— 形态本身就在说明"能选几个" */}
								{multi ? (
									<span className={on ? "ask-check on" : "ask-check"} aria-hidden="true">
										{on && <Lu icon="check" size={11} strokeWidth={2.6} />}
									</span>
								) : (
									<span className="ask-no">{i + 1}</span>
								)}
								<span className="ask-label">{option}</span>
								<span className="ask-go" aria-hidden="true">
									<Lu icon="arrow-right" size={13} strokeWidth={1.8} />
								</span>
							</button>
						);
					})}
					<button
						type="button"
						className={multi && ans?.other ? "ask-option ask-other on" : "ask-option ask-other"}
						onClick={openOther}
					>
						{multi ? (
							<span className={ans?.other ? "ask-check on" : "ask-check"} aria-hidden="true">
								{ans?.other ? <Lu icon="check" size={11} strokeWidth={2.6} /> : null}
							</span>
						) : (
							<span className="ask-no ask-no-icon">
								<Lu icon="square-pen" size={12} strokeWidth={1.8} />
							</span>
						)}
						<span className="ask-label">其他补充…</span>
					</button>
					{otherOpen[index] && (
						<textarea
							ref={otherRef}
							className="ask-other-input"
							rows={2}
							placeholder="直接说你想怎么走…"
							value={ans?.other ?? ""}
							onChange={(e) => typeOther(e.target.value)}
							// Enter 确认并前进(Shift+Enter 换行);与输入条的偏好一致
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
									e.preventDefault();
									confirm();
								}
							}}
						/>
					)}
				</div>
				<div className="ask-foot">
					<span className="ask-progress">
						{multi && selectedCount > 0
							? `已选择 ${selectedCount} 个${ans?.other ? " + 补充" : ""}`
							: total > 1
								? `已答 ${answeredCount}/${total}`
								: ""}
					</span>
					<button type="button" className="ask-skip" title="跳过这一题,继续下一题" onClick={skip}>
						跳过
					</button>
					{answerable && (
						<button
							type="button"
							className="ask-submit"
							aria-label={allSettled ? "提交回答" : "确认并继续"}
							title={allSettled ? "提交回答(Enter)" : "确认并继续(Enter)"}
							onClick={confirm}
						>
							<Lu icon="arrow-up" size={14} strokeWidth={2} />
						</button>
					)}
				</div>
			</motion.div>
		</div>
	);
}

/** 已回答的问答记录(折在工具块里;参考图:问题一行 + 答案一行)。 */
export function AskUserRecord({ questions, answers }: { questions: AskQuestionView[]; answers: string[] | null }) {
	if (questions.length === 0) return null;
	return (
		<div className="ask-record">
			{questions.map((q, i) => (
				<div key={i} className="ask-recap">
					<div className="ask-recap-q">{q.question}</div>
					<div className={answers && answers[i] ? "ask-recap-a" : "ask-recap-a empty"}>
						{answers && answers[i] ? answers[i] : "（未回答）"}
					</div>
				</div>
			))}
		</div>
	);
}
