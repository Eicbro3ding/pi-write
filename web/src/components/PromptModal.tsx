/**
 * 系统提示词弹层(2026-10-10)。
 *
 * 两种形态共用一套外壳(与 ReviseScriptModal 同款 860px 独立窗口):
 * - `readonly`:展示**内置提示词原文**(服务端渲染后下发,见 GET /api/prompt-defaults),
 *   正文只读,脚部「载入编辑器」把全文灌进编辑态 —— 这是「暴露内部提示词」的关键:
 *   用户先看得见内置长什么样,再决定改不改,而不是对着空白框从零写。
 * - `edit`:可编辑的 textarea 取代只读正文;工具条给「还原内置」「载入内置原文」,
 *   脚部「取消 / 保存」。
 *
 * 状态与提交逻辑**留在 SettingsPage**(草稿同步、保存、还原都是它的事),本组件只渲染 +
 * 回抛交互,零新逻辑 —— 与 ReviseScriptModal 的分工一致。
 */
import { useEffect, useRef } from "react";
import { Lu } from "./Lu.tsx";
import { useExitPresence } from "../use-exit-presence.ts";

/** 弹层形态:只读预览内置原文 / 编辑当前生效的提示词。 */
export type PromptModalMode = "readonly" | "edit";

export function PromptModal({
	open,
	mode,
	title,
	stateLabel,
	/** 只读态展示的内置原文(编辑态不用)。 */
	builtinText,
	draft,
	onDraft,
	busy,
	onClose,
	onLoadBuiltin,
	onReset,
	onSave,
}: {
	open: boolean;
	mode: PromptModalMode;
	/** 弹层标题(如「主写作 agent · 系统提示词」)。 */
	title: string;
	/** 右上角状态徽标文案(「内置 · 只读」/「已自定义」)。 */
	stateLabel: string;
	builtinText: string;
	/** 编辑态草稿(受控)。 */
	draft: string;
	onDraft: (v: string) => void;
	busy: boolean;
	onClose: () => void;
	/** 编辑态:把内置原文灌进草稿。 */
	onLoadBuiltin: () => void;
	/** 编辑态:清空草稿(= 回落内置)。 */
	onReset: () => void;
	onSave: () => void;
}) {
	const { mounted, closing } = useExitPresence(open);
	const areaRef = useRef<HTMLTextAreaElement | null>(null);

	// 编辑态打开时把焦点放进编辑区(直接从只读「载入编辑器」过来时,光标的落点要明确)
	useEffect(() => {
		if (!mounted || mode !== "edit") return;
		const t = window.setTimeout(() => {
			const el = areaRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		}, 40);
		return () => window.clearTimeout(t);
	}, [mounted, mode]);

	if (!mounted) return null;

	const readonly = mode === "readonly";
	const chars = readonly ? builtinText.length : draft.length;

	return (
		<div
			className={`pmk-mask${closing ? " is-closing" : ""}`}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			onMouseDown={(e) => {
				// 点遮罩关闭(点窗口内部不关):mousedown 判 target 是遮罩自身
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="pmk-panel">
				<header className="pmk-head">
					<span className="pmk-title">{readonly ? `内置提示词 · ${title}` : title}</span>
					<span className={`pmk-chip${readonly ? "" : " is-custom"}`}>
						<Lu icon={readonly ? "lock" : "pencil-line"} size={11} />
						{stateLabel}
					</span>
					<span className="pmk-spacer" />
					<button type="button" className="pmk-close" aria-label="关闭" onClick={onClose}>
						<Lu icon="x" size={15} />
					</button>
				</header>

				<div className="pmk-body" onKeyDown={(e) => e.key === "Escape" && onClose()}>
					{readonly ? (
						<div className="pmk-box">
							<pre className="pmk-pre">{builtinText}</pre>
						</div>
					) : (
						<>
							<div className="pmk-toolbar">
								<span className="pmk-hint">
									<Lu icon="info" size={12} />
									整段替换。留空保存 = 恢复内置。
								</span>
								<span className="pmk-spacer" />
								<button type="button" className="pmk-mini" disabled={busy} onClick={onReset}>
									<Lu icon="rotate-ccw" size={12} />
									还原内置
								</button>
								<button type="button" className="pmk-mini" disabled={busy} onClick={onLoadBuiltin}>
									<Lu icon="download" size={12} />
									载入内置原文
								</button>
							</div>
							<textarea
								ref={areaRef}
								className="pmk-area"
								value={draft}
								spellCheck={false}
								disabled={busy}
								placeholder="在这里写你的提示词。留空保存即恢复内置。"
								onChange={(e) => onDraft(e.target.value)}
							/>
							<div className="pmk-count">{chars.toLocaleString()} 字</div>
						</>
					)}
				</div>

				<footer className="pmk-foot">
					<span className="pmk-note">
						{readonly ? "内置提示词可自由照抄改造。" : "保存后下一次对话生效,已写的正文不受影响。"}
					</span>
					<span className="pmk-foot-actions">
						<button type="button" className="pmk-btn" onClick={onClose}>
							{readonly ? "关闭" : "取消"}
						</button>
						{readonly ? (
							<button type="button" className="pmk-btn is-primary" onClick={onLoadBuiltin}>
								<Lu icon="pencil-line" size={13} />
								载入编辑器
							</button>
						) : (
							<button type="button" className="pmk-btn is-primary" disabled={busy} onClick={onSave}>
								<Lu icon="check" size={13} />
								{busy ? "保存中…" : "保存"}
							</button>
						)}
					</span>
				</footer>
			</div>
		</div>
	);
}
