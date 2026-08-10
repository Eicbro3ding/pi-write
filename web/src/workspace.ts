/**
 * 正文安全编辑纯函数 —— 选区文本编辑 / 撤回校验 / 选区一致性。
 * 全部为纯函数,不依赖 React / DOM,便于单测。
 * 2026-08-10:批注功能退役(并入编剧「选中文本自动填入」),reducer/选区状态
 * 一并移除;仅保留 DraftWorkspace 依赖的编辑原语。
 */
import type { AppliedEdit, TextSelectionSnapshot } from "./types.ts";

/**
 * 对 source 在 [from, to) 区间做文本编辑:
 * - replace:替换选中区间;insert:在零宽位置插入。
 * 边界统一收敛到 [0, source.length] 且 end >= start,防止越界/反向区间。
 * 返回编辑后的完整文本与 AppliedEdit 记录;file/chapterFile 由调用层
 * (DraftWorkspace)补齐,纯函数不依赖当前会话。
 */
export function applyTextEdit(
	source: string,
	from: number,
	to: number,
	insertedText: string,
	mode: "replace" | "insert" = "replace",
): { text: string; edit: AppliedEdit } {
	const start = Math.max(0, Math.min(from, source.length));
	const end = Math.max(start, Math.min(to, source.length));
	const replacedText = mode === "insert" ? "" : source.slice(start, end);
	const text = `${source.slice(0, start)}${insertedText}${source.slice(mode === "insert" ? start : end)}`;
	return {
		text,
		edit: {
			file: "",
			chapterFile: "",
			beforeText: source,
			afterText: text,
			from: start,
			to: mode === "insert" ? start : end,
			replacedText,
			insertedText,
		},
	};
}

/**
 * 撤回已应用的编辑:仅当当前文档与 edit.afterText 完全一致时允许,
 * 返回编辑前的完整文档;文档已被后续修改则拒绝(null),调用层提示
 * 「正文已变化,无法自动撤回」。
 */
export function undoAppliedEdit(source: string, edit: AppliedEdit): string | null {
	return source === edit.afterText ? edit.beforeText : null;
}

/**
 * 校验选区快照是否仍与当前书/文件/章节/文档一致:
 * 书、文件或章节变化、from/to 越界或反向、选中的文本与文档不一致,都视为失效。
 */
export function selectionStillMatches(
	selection: TextSelectionSnapshot,
	slug: string,
	file: string,
	chapterFile: string,
	currentText: string,
): boolean {
	if (selection.slug !== slug || selection.file !== file || selection.chapterFile !== chapterFile) return false;
	if (selection.from < 0 || selection.to > currentText.length || selection.from > selection.to) return false;
	return currentText.slice(selection.from, selection.to) === selection.text;
}

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
