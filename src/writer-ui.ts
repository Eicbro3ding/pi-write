/**
 * Shared writer UI state and components.
 *
 * The extension keeps a single mutable snapshot of the current book/chapter
 * and feeds it to the info bar (above the input) and the footer, so the main
 * screen always shows where the user is writing and how much exists.
 */

import type { Theme } from "../vendor/pi-coding-agent/src/index.ts";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "../vendor/pi-tui/src/index.ts";
import { cjkCount } from "./cjk.ts";
import { APP_NAME, VERSION } from "./config.ts";

export interface WriterUiState {
	bookTitle?: string;
	chapterLabel?: string;
	chapterFile?: string;
	wordCount?: number;
	/** Display title for the draft panel: 《书》 · 章节. */
	draftTitle?: string;
	/** Absolute path of the current chapter draft. */
	draftPath?: string;
	/** Current draft file content (for the persistent editor panel). */
	draftText?: string;
}

/** Count CJK characters plus whitespace-separated latin words(CJK 口径统一在 cjk.ts)。 */
export function countWriting(text: string): number {
	const latin = text
		.replace(/[\u3400-\u9fff]/g, " ")
		.split(/\s+/)
		.filter(Boolean).length;
	return cjkCount(text) + latin;
}

/**
 * Slim context bar rendered above the input line:
 *   ✒ 《书名》 · 章节名 · draft/ch01.md · 约 1234 字
 */
export class WriterInfoBar implements Component {
	private readonly theme: Theme;
	private readonly state: WriterUiState;

	constructor(_tui: TUI, theme: Theme, state: WriterUiState) {
		this.theme = theme;
		this.state = state;
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): string[] {
		const t = this.theme;
		const book = this.state.bookTitle ? t.fg("accent", `《${this.state.bookTitle}》`) : t.fg("muted", "（未命名）");
		const parts = [
			t.fg("accent", "✒"),
			book,
			this.state.chapterLabel ? t.fg("text", this.state.chapterLabel) : "",
			this.state.chapterFile ? t.fg("dim", this.state.chapterFile) : "",
			this.state.wordCount !== undefined ? t.fg("muted", `约 ${this.state.wordCount} 字`) : "",
		].filter((part) => part.length > 0);
		const line = parts.join(t.fg("borderMuted", " · "));
		return [truncateToWidth(line, width, "", true)];
	}
}

/**
 * Writer footer bar replacing pi's developer footer:
 *   ✒ pi-writer v0.83.0    esc 中断 · ctrl+o 更多 · / 命令    《书名》 · 章节
 */
export class WriterFooter implements Component {
	private readonly theme: Theme;
	private readonly state: WriterUiState;

	constructor(_tui: TUI, theme: Theme, state: WriterUiState) {
		this.theme = theme;
		this.state = state;
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): string[] {
		const t = this.theme;
		const left = `${t.fg("accent", "✒ ")}${t.bold(t.fg("text", APP_NAME))}${t.fg("dim", ` v${VERSION}`)}`;
		const center = t.fg("dim", "esc 中断 · / 命令 · /edit 编辑器 · /world 世界书");
		const right = this.state.bookTitle
			? t.fg("muted", `《${this.state.bookTitle}》${this.state.chapterLabel ? ` · ${this.state.chapterLabel}` : ""}`)
			: "";

		const leftW = visibleWidth(left);
		const centerW = visibleWidth(center);
		const rightW = visibleWidth(right);
		const gap = Math.max(2, Math.floor((width - leftW - centerW - rightW - 4) / 3));
		const line = `${left}${" ".repeat(gap)}${center}${" ".repeat(gap)}${right}`;
		return [t.bg("toolPendingBg", truncateToWidth(line, width, "", true))];
	}
}
