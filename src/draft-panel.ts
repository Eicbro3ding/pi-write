/**
 * Persistent draft editor panel for the main chat view.
 *
 * Rendered by the core as the right-hand side of the chat split. It mirrors
 * the current chapter draft, supports direct editing (Alt+E or click to
 * enter, Esc to leave), auto-saves back to the draft file, and stays in sync
 * with the agent session (AI edits reload the panel when it is clean).
 */

import type { Theme } from "../vendor/pi-coding-agent/src/index.ts";
import {
	type Component,
	CURSOR_MARKER,
	matchesKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../vendor/pi-tui/src/index.ts";
import { VimDocument } from "./editor/document.ts";
import { MOUSE_DISABLE_SEQUENCE, MOUSE_ENABLE_SEQUENCE, parseSgrMouse, type SgrMouseEvent } from "./editor/mouse.ts";
import { countWriting, type WriterUiState } from "./writer-ui.ts";

const TAB_WIDTH = 4;
const WHEEL_SCROLL_LINES = 3;
const CONTENT_OFFSET = 3; // top border + title + stats
const CONTENT_TAIL = 2; // hint + bottom border
const AUTO_SAVE_MS = 800;
/** Approximate rows taken by status + widgets + input + footer below the split. */
const BOTTOM_RESERVED = 8;

export interface DraftPanelOptions {
	/**
	 * Persist the draft. `auto` 为 true 表示定时自动保存(可能覆盖外部写入,
	 * 实现方应做冲突检查);`baseline` 是面板上次保存/加载的文件内容,供冲突比较。
	 * 返回 "saved" 成功 / "conflict" 检测到外部修改并拒绝覆盖 / "error" 其他失败。
	 */
	onSave(text: string, opts: { auto: boolean; baseline: string }): Promise<"saved" | "conflict" | "error">;
}

function expandTabs(text: string): string {
	return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

/** Visual column (terminal cells) of a character offset in a line. */
function visualColOf(line: string, charCol: number): number {
	let col = 0;
	let i = 0;
	for (const ch of Array.from(line)) {
		if (i >= charCol) break;
		col += ch === "\t" ? TAB_WIDTH : visibleWidth(ch);
		i++;
	}
	return col;
}

/** Character offset in a line for a visual column. */
function charColAt(line: string, visualCol: number): number {
	let col = 0;
	let i = 0;
	for (const ch of Array.from(line)) {
		const w = ch === "\t" ? TAB_WIDTH : visibleWidth(ch);
		if (col + w > visualCol) break;
		col += w;
		i++;
	}
	return i;
}

/** Original character column for an index into the tab-expanded line. */
function originalColAt(line: string, expandedCol: number): number {
	let col = 0;
	let i = 0;
	for (const ch of Array.from(line)) {
		if (i >= expandedCol) break;
		i += ch === "\t" ? TAB_WIDTH : 1;
		col++;
	}
	return col;
}

/**
 * 光标反显块在段落 body 内的列位置:等于光标在段内的视觉列(无额外偏移,
 * 行首缩进在 push 时另行添加)。clamp 到 body 宽度内,保证至少 1 个字符可反显。
 */
export function cursorBlockColumn(within: number, bodyWidth: number): number {
	return Math.min(within, Math.max(0, bodyWidth - 1));
}

/**
 * 自动保存冲突判定:文件当前内容与面板基线不一致 → 文件被 AI/其他进程修改过,
 * 自动保存应拒绝覆盖。fileContent 为 null(文件不存在)视为无冲突(首次保存)。
 */
export function autoSaveConflicts(fileContent: string | null, baseline: string): boolean {
	return fileContent !== null && fileContent !== baseline;
}

interface VisualRow {
	/** Document line index. */
	line: number;
	/** Visual column where this wrapped segment starts in the expanded line. */
	start: number;
	/** Wrapped segment text (tabs expanded). */
	text: string;
}

function extractBracketedPaste(data: string): string | undefined {
	const start = data.indexOf("\x1b[200~");
	const end = data.indexOf("\x1b[201~");
	if (start === -1) return undefined;
	const from = start + "\x1b[200~".length;
	const to = end === -1 ? data.length : end;
	return data.slice(from, to);
}

export class DraftEditorPanel implements Component {
	/** Preferred column width when mounted as a sidePanel widget. */
	readonly preferredWidth = 34;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly state: WriterUiState;
	private readonly onSave: (text: string, opts: { auto: boolean; baseline: string }) => Promise<"saved" | "conflict" | "error">;
	private doc: VimDocument;
	private active = false;
	private scrollTop = 0;
	private typingChunk = false;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** 自动保存检测到文件被外部修改、拒绝覆盖(等待 Ctrl+S 显式强制)。 */
	private conflicted = false;
	private panelWidth = 34;
	private lastHeight = 10;
	private lastContentHeight = 5;
	private visualRows: VisualRow[] = [];
	/** Exact 0-based buffer row of the panel's top edge, from onLayout. */
	private knownTopRow = -1;
	/** Height hint from the split pane (viewport cap), if any. */
	private viewportHeight: number | undefined;
	private mouseEnabled = false;

	constructor(tui: TUI, theme: Theme, state: WriterUiState, options: DraftPanelOptions) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.onSave = options.onSave;
		this.doc = new VimDocument(state.draftText ?? "");
		this.enableMouse();
	}

	invalidate(): void {
		// No cached render state.
	}

	onLayout(topRow: number): void {
		this.knownTopRow = topRow;
	}

	setViewportHeight(height: number): void {
		this.viewportHeight = height;
	}

	dispose(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.disableMouse();
	}

	/** The main chat screen needs terminal mouse reporting for click/scroll. */
	enableMouse(): void {
		if (this.mouseEnabled) return;
		this.mouseEnabled = true;
		this.tui.terminal.write(MOUSE_ENABLE_SEQUENCE);
	}

	private disableMouse(): void {
		if (!this.mouseEnabled) return;
		this.mouseEnabled = false;
		this.tui.terminal.write(MOUSE_DISABLE_SEQUENCE);
	}

	/** Reload the draft when the file changed externally and nothing is unsaved. */
	reloadIfClean(): void {
		if (this.doc.dirty) return;
		const text = this.state.draftText ?? "";
		if (text !== this.doc.getText()) {
			const cursor = { ...this.doc.cursor };
			this.doc.setText(text);
			// Keep the user's viewing position, clamped to the new content.
			const line = Math.min(cursor.line, this.doc.lines.length - 1);
			this.doc.cursor = { line, col: Math.min(cursor.col, this.doc.lines[line]?.length ?? 0) };
			this.scrollTop = Math.min(this.scrollTop, this.maxVisualScroll());
			this.tui.requestRender();
		}
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	render(width: number): string[] {
		const t = this.theme;
		this.panelWidth = width;
		const rows = Math.max(12, this.tui.terminal.rows);
		const targetHeight = this.viewportHeight ?? Math.max(12, rows - 20);
		this.lastHeight = targetHeight;
		const contentHeight = Math.max(1, targetHeight - CONTENT_OFFSET - CONTENT_TAIL);
		this.lastContentHeight = contentHeight;

		const contentWidth = Math.max(1, width - 2);
		// Soft-wrap every document line into visual rows.
		this.visualRows = [];
		for (let line = 0; line < this.doc.lines.length; line++) {
			const expanded = expandTabs(this.doc.lines[line] ?? "");
			const segments = wrapTextWithAnsi(expanded, contentWidth);
			if (segments.length === 0) {
				this.visualRows.push({ line, start: 0, text: "" });
				continue;
			}
			let start = 0;
			for (const segment of segments) {
				this.visualRows.push({ line, start, text: segment });
				start += visibleWidth(segment);
			}
		}

		// Keep the cursor on screen.
		const cursorVisualRow = this.cursorVisualRow();
		if (this.active && cursorVisualRow >= 0) {
			if (cursorVisualRow < this.scrollTop) {
				this.scrollTop = cursorVisualRow;
			} else if (cursorVisualRow >= this.scrollTop + contentHeight) {
				this.scrollTop = cursorVisualRow - contentHeight + 1;
			}
		}
		const maxScroll = Math.max(0, this.visualRows.length - contentHeight);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		const canScrollDown = this.scrollTop + contentHeight < this.visualRows.length;

		const border = (s: string): string => t.fg(this.active ? "borderAccent" : "border", s);
		const lines: string[] = [];

		// Top border with a scroll-up marker: ╭─ ✒ 草稿 ───────(↑)╮
		const title = `${t.fg("accent", "✒ ")}${t.fg("text", "草稿")}`;
		const topPrefix = "╭─ ";
		const topMarker = this.scrollTop > 0 ? "↑" : "";
		const topDashes = Math.max(
			1,
			width - visibleWidth(topPrefix) - visibleWidth(title) - 1 - visibleWidth(topMarker),
		);
		lines.push(
			truncateToWidth(
				`${border(topPrefix)}${title}${border("─".repeat(topDashes))}${
					this.scrollTop > 0 ? t.fg("warning", "↑") : ""
				}${border("╮")}`,
				width,
				"",
				true,
			),
		);

		lines.push(`  ${truncateToWidth(t.fg("text", this.state.draftTitle ?? "草稿"), width - 2, "", true)}`);
		const saveState = this.conflicted
			? t.fg("warning", "⚠ 外部修改")
			: this.doc.dirty
				? t.fg("warning", "● 未保存")
				: t.fg("success", "✓ 已保存");
		const stats = `${t.fg("dim", this.state.chapterFile ?? "")} · ${t.fg("muted", `约 ${countWriting(this.doc.getText())} 字`)} ${saveState}`;
		lines.push(`  ${truncateToWidth(stats, width - 2, "", true)}`);

		for (let i = 0; i < contentHeight; i++) {
			const visual = this.visualRows[this.scrollTop + i];
			if (!visual) {
				lines.push(`  ${" ".repeat(contentWidth)}`);
				continue;
			}
			const source = this.doc.lines[visual.line] ?? "";
			let body = truncateToWidth(visual.text, contentWidth, "", true);
			if (this.active && visual.line === this.doc.cursor.line && this.scrollTop + i === cursorVisualRow) {
				const within = visualColOf(source, this.doc.cursor.col) - visual.start;
				const cc = cursorBlockColumn(within, visibleWidth(body));
				const before = sliceByColumn(body, 0, cc);
				const at = sliceByColumn(body, cc, 1) || " ";
				const after = sliceByColumn(body, cc + 1, 10000);
				body = `${before}${CURSOR_MARKER}\x1b[7m${at}\x1b[0m${after}`;
			}
			lines.push(`  ${body}`);
		}

		const hint = this.active
			? this.conflicted
				? `${t.fg("warning", "⚠ ")}${t.fg("dim", "文件已外部修改 · Ctrl+S 强制保存")}`
				: `${t.fg("accent", "● ")}${t.fg("dim", "Esc 回聊天 · Ctrl+S 保存")}`
			: t.fg("dim", "Alt+E 或点击进入 · 滚轮滚动");
		lines.push(`  ${truncateToWidth(hint, width - 2, "", true)}`);

		// Bottom border with a scroll-down marker when more content exists.
		const bottomMarker = canScrollDown ? "↓" : "";
		const bottomDashes = Math.max(1, width - 2 - visibleWidth(bottomMarker));
		lines.push(
			truncateToWidth(
				`${border("╰")}${border("─".repeat(bottomDashes))}${
					canScrollDown ? t.fg("warning", "↓") : ""
				}${border("╯")}`,
				width,
				"",
				true,
			),
		);
		return lines;
	}

	// =========================================================================
	// Input (routed through the extension's terminal input listener)
	// =========================================================================

	handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		// Overlays (dialogs, the full-screen /edit editor) own the input.
		if (this.tui.hasOverlay()) {
			if (this.active) {
				this.active = false;
				this.typingChunk = false;
				this.tui.requestRender();
			}
			return undefined;
		}
		const mouse = parseSgrMouse(data);
		if (mouse) return this.handleMouse(mouse);

		if (matchesKey(data, "alt+e")) {
			if (!this.active) {
				this.active = true;
				this.tui.requestRender();
				return { consume: true };
			}
			return { consume: true };
		}
		if (!this.active) return undefined;

		if (matchesKey(data, "escape")) {
			this.active = false;
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+s")) {
			void this.save(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+z")) {
			this.doc.undo();
			this.typingChunk = false;
			this.scheduleSave();
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+y")) {
			this.doc.redo();
			this.typingChunk = false;
			this.scheduleSave();
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			this.mutate(() => this.doc.newLine());
			return { consume: true };
		}
		if (matchesKey(data, "backspace")) {
			this.mutate(() => this.doc.backspace());
			return { consume: true };
		}
		if (matchesKey(data, "delete")) {
			this.mutate(() => this.doc.deleteForward());
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			this.doc.moveLeft(1);
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			this.doc.moveRight(1);
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			this.doc.moveUp(1);
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "down")) {
			this.doc.moveDown(1);
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+e")) {
			this.doc.lineStart();
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "end")) {
			this.doc.lineEnd();
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollTop = Math.max(0, this.scrollTop - this.lastContentHeight);
			this.keepCursorInViewport();
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollTop = Math.min(this.maxVisualScroll(), this.scrollTop + this.lastContentHeight);
			this.keepCursorInViewport();
			this.tui.requestRender();
			return { consume: true };
		}

		const paste = extractBracketedPaste(data);
		if (paste !== undefined) {
			this.mutate(() => this.doc.insertText(paste));
			return { consume: true };
		}

		if (data.length === 1 && !isControlChar(data)) {
			this.mutate(() => this.doc.insertText(data));
			return { consume: true };
		}
		return { consume: true };
	}

	private handleMouse(event: SgrMouseEvent): { consume?: boolean; data?: string } | undefined {
		const cols = this.tui.terminal.columns;
		const panelLeftCol = cols - this.panelWidth; // 0-based
		const inPanel = event.x > panelLeftCol && event.y > this.panelTopRow() && event.y <= this.panelBottomRow();
		if (!inPanel) {
			if (this.active) {
				this.active = false;
				this.typingChunk = false;
				this.tui.requestRender();
			}
			return undefined; // let the main UI handle clicks outside the panel
		}

		if (event.kind === "wheel") {
			this.scrollTop = Math.max(
				0,
				Math.min(this.maxVisualScroll(), this.scrollTop + event.delta * WHEEL_SCROLL_LINES),
			);
			this.keepCursorInViewport();
			this.tui.requestRender();
			return { consume: true };
		}
		if (event.kind === "press" && event.button === "left") {
			this.active = true;
			const panelRow = event.y - this.panelTopRow(); // 0-based row inside the panel
			if (panelRow >= CONTENT_OFFSET && panelRow < CONTENT_OFFSET + this.lastContentHeight) {
				const visual = this.visualRows[this.scrollTop + (panelRow - CONTENT_OFFSET)];
				if (visual) {
					const clickCol = Math.max(0, event.x - panelLeftCol - 3); // 2-space indent
					const lineText = this.doc.lines[visual.line] ?? "";
					const expandedIdx = charColAt(expandTabs(lineText), visual.start + clickCol);
					this.doc.cursor = { line: visual.line, col: originalColAt(lineText, expandedIdx) };
				}
			}
			this.typingChunk = false;
			this.tui.requestRender();
			return { consume: true };
		}
		// Middle/right clicks inside the panel: consume but do nothing yet.
		return { consume: true };
	}

	/** 1-based row of the panel's top edge (exact once onLayout has run). */
	private panelTopRow(): number {
		if (this.knownTopRow >= 0) return this.knownTopRow + 1;
		return this.tui.terminal.rows - BOTTOM_RESERVED - this.lastHeight;
	}

	private panelBottomRow(): number {
		return this.panelTopRow() + this.lastHeight - 1;
	}

	/** Visual row (index into this.visualRows) holding the cursor, or -1. */
	private cursorVisualRow(): number {
		const line = this.doc.cursor.line;
		const source = this.doc.lines[line] ?? "";
		const cursorVisualCol = visualColOf(source, this.doc.cursor.col);
		for (let i = 0; i < this.visualRows.length; i++) {
			const row = this.visualRows[i]!;
			if (row.line !== line) continue;
			const end = row.start + visibleWidth(row.text);
			if (cursorVisualCol >= row.start && cursorVisualCol <= end) return i;
			if (row.start > cursorVisualCol) return i;
		}
		return -1;
	}

	/**
	 * After a viewport-only scroll (wheel/page keys), move the cursor to the
	 * viewport edge when the scroll pushed it out, so the render pass does not
	 * yank the scroll position back to the cursor.
	 */
	private keepCursorInViewport(): void {
		if (!this.active) return;
		const row = this.cursorVisualRow();
		if (row < 0) return;
		if (row < this.scrollTop) {
			this.moveCursorToVisualRow(this.scrollTop);
		} else if (row >= this.scrollTop + this.lastContentHeight) {
			this.moveCursorToVisualRow(this.scrollTop + this.lastContentHeight - 1);
		}
	}

	private moveCursorToVisualRow(vrow: number): void {
		const visual = this.visualRows[Math.max(0, Math.min(this.visualRows.length - 1, vrow))];
		if (!visual) return;
		const source = this.doc.lines[visual.line] ?? "";
		this.doc.cursor = { line: visual.line, col: originalColAt(source, visual.start) };
	}

	private maxVisualScroll(): number {
		return Math.max(0, this.visualRows.length - this.lastContentHeight);
	}

	private mutate(fn: () => void): void {
		if (!this.typingChunk) {
			this.doc.pushUndo();
			this.typingChunk = true;
		}
		fn();
		this.scheduleSave();
		this.tui.requestRender();
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.save();
		}, AUTO_SAVE_MS);
	}

	private async save(manual = false): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.doc.dirty) return;
		const result = await this.onSave(this.doc.getText(), { auto: !manual, baseline: this.doc.savedContent });
		if (result === "saved") {
			this.doc.markSaved();
			this.conflicted = false;
			this.state.wordCount = countWriting(this.doc.getText());
		} else if (result === "conflict") {
			// 自动保存拒绝覆盖外部修改:保持未保存状态,提示用户 Ctrl+S 显式覆盖
			this.conflicted = true;
		}
		this.tui.requestRender();
	}
}

function isControlChar(ch: string): boolean {
	return ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;
}
