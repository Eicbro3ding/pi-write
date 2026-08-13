/**
 * 正文保存完成后的状态迁移决策 —— 纯函数,不依赖 React / DOM,便于单测。
 * 2026-08-10:批注功能退役(并入编剧「选中文本自动填入」),选区文本编辑/撤回
 * 校验/选区一致性(applyTextEdit/undoAppliedEdit/selectionStillMatches)随之
 * 失去全部调用方,一并移除;本文件仅保留 DraftWorkspace 保存状态机依赖的
 * resolveSaveOutcome。
 */

/** 一次已 await 的 putDraft 完成后,UI 应如何迁移(调用层按 kind 更新状态/回调)。 */
export type SaveOutcome =
	/** 保存期间文件已切换:过期完成,静默放弃(不更新状态、不清错误文案)。 */
	| { kind: "abandon" }
	/** 保存成功且文本未变:回到 saved。 */
	| { kind: "saved" }
	/** 保存成功但期间有新编辑:回 dirty;reschedule 为 true 时需要重新排队自动保存。 */
	| { kind: "dirty"; reschedule: boolean }
	/** 保存失败(且文件未切换):进入 save-error,携带失败信息。 */
	| { kind: "save-error"; message: string };

/**
 * 保存完成后的状态迁移决策(纯函数,便于单测竞态路径)。
 * 关键竞态防护:加载 effect 已用 cancelled 标志防护 getDraft 的过期完成,
 * 但「为旧文件发起的 putDraft」没有同等防护——await 之后必须校验当前文件仍是发起时的文件,
 * 否则过期完成会覆盖新文件的保存状态/错误文案(如在 ch01 保存期间切到 ch02)。
 */
export function resolveSaveOutcome(args: {
	/** await 前捕获的发起保存时的文件。 */
	startedFile: string;
	/** 当前文件(用于判定本次完成是否过期)。 */
	currentFile: string;
	/** 发起保存时的文档全文。 */
	savedText: string;
	/** 当前文档全文。 */
	currentText: string;
	/** 是否已有排队的自动保存定时器(有则不重复排,避免两次相同 PUT)。 */
	autosavePending: boolean;
	/** 保存失败信息;成功为 null。 */
	error: string | null;
}): SaveOutcome {
	if (args.currentFile !== args.startedFile) return { kind: "abandon" };
	if (args.error !== null) return { kind: "save-error", message: args.error };
	if (args.currentText !== args.savedText) return { kind: "dirty", reschedule: !args.autosavePending };
	return { kind: "saved" };
}
