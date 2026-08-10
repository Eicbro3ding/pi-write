/**
 * Built-in file editor for pi-writer.
 *
 * Rendered as a full-screen overlay inside the pi TUI with a persistent chat
 * sidebar. The default mode is a plain text editor (direct typing, arrow
 * keys, mouse click/drag/wheel, double/triple click selection, right-click
 * context menu with "和 AI 讨论"). An optional vim mode (`/edit --vim`) keeps
 * the normal/insert/visual keybindings.
 */

import { copyToClipboard, getMarkdownTheme, type Theme } from "../../vendor/pi-coding-agent/src/index.ts";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Markdown,
	matchesKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../vendor/pi-tui/src/index.ts";
import type { ChatApi, ChatMessage } from "./chat.ts";
import { type Cursor, VimDocument } from "./document.ts";
import { MOUSE_DISABLE_SEQUENCE, MOUSE_ENABLE_SEQUENCE, parseSgrMouse, type SgrMouseEvent } from "./mouse.ts";

export interface VimFileEditorResult {
	saved: boolean;
	content: string;
}

export interface VimFileEditorOptions {
	/** Path shown in the status bar (usually relative to the book dir). */
	displayPath: string;
	/** Title shown in the top bar (usually 《book》· chapter · path). */
	title?: string;
	/** Initial file content. */
	initialContent: string;
	/** Persist content. Return true on success. */
	onSave: (content: string) => Promise<boolean>;
	/** Enable vim-style editing. Defaults to false (simple editor). */
	vim?: boolean;
	/** Optional chat sidebar wiring. */
	chat?: ChatApi;
}

type DoneCallback = (result: VimFileEditorResult) => void;

const MODE_LABEL: Record<string, string> = {
	normal: "-- 普通 --",
	insert: "-- 插入 --",
	visual: "-- 可视 --",
};

const TAB_WIDTH = 4;
const WHEEL_SCROLL_LINES = 3;
const CHAT_MIN_WIDTH = 26;
const CHAT_MAX_RATIO = 0.6;
const CHAT_RATIO = 0.3;
const MAX_CHAT_MESSAGES = 200;
const DOUBLE_CLICK_MS = 400;
const MENU_ITEMS = ["和 AI 讨论", "复制", "全选"] as const;
const TOOLBAR_BUTTONS = [
	{ key: "save", label: " 保存 " },
	{ key: "quit", label: " 退出 " },
	{ key: "undo", label: " 撤回 " },
	{ key: "redo", label: " 重做 " },
] as const;

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

/** Invert a visual-column range, handling wide characters and ANSI codes. */
function invertRangeByColumn(text: string, from: number, to: number): string {
	const start = Math.max(0, from);
	const end = Math.max(start, to);
	if (start >= end) return text;
	const prefix = sliceByColumn(text, 0, start);
	const middle = sliceByColumn(text, start, end - start);
	const suffix = sliceByColumn(text, end, 10000);
	return `${prefix}\x1b[7m${middle}\x1b[0m${suffix}`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replaceAll(CURSOR_MARKER, "");
}

/** Word (or punctuation run) boundaries around a character offset. */
function wordRangeAt(line: string, col: number): { start: number; end: number } {
	const isWord = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);
	let start = col;
	while (start > 0 && isWord(line[start - 1]!)) start--;
	let end = col;
	while (end < line.length && isWord(line[end]!)) end++;
	if (start === end) {
		while (start > 0 && !isWord(line[start - 1]!) && line[start - 1]!.trim() !== "") start--;
		while (end < line.length && !isWord(line[end]!) && line[end]!.trim() !== "") end++;
	}
	return { start, end };
}

export class VimFileEditor implements Component, Focusable {
	focused = false;
	wantsKeyRelease = true;

	private doc: VimDocument;
	private tui: TUI;
	private theme: Theme;
	private options: VimFileEditorOptions;
	private done: DoneCallback;
	private scrollTop = 0;
	private status = "";
	private commandBuffer = "";
	private pendingCount = 0;
	private pendingG = false;
	private pendingD = false;
	private pendingY = false;
	private pendingR = false;
	private dragging = false;
	private dragStart: Cursor | null = null;
	private mouseEnabled = false;
	private closed = false;
	private readonly vimMode: boolean;
	private typingChunk = false;

	private lastWidth = 80;
	private textWidth = 50;
	private chatWidth = CHAT_MIN_WIDTH;
	/** User-set sidebar width from dragging the divider; null = default ratio. */
	private chatWidthOverride: number | null = null;

	private chatMessages: Array<ChatMessage & { pending?: boolean }> = [];
	private chatInput = "";
	private chatScroll = 0;
	private chatFocus = false;
	private chatUnsubscribe: (() => void) | null = null;
	private lastLocalChatText: { text: string; time: number } | null = null;

	private menuOpen = false;
	private menuIndex = 0;
	private menuRow = 0;
	private menuCol = 0;
	private lastClick: { time: number; x: number; y: number; count: number } | null = null;
	private resizingSidebar = false;
	private resizeStartX = 0;
	private resizeStartChatWidth = 0;
	/** Last known mouse cell, for toolbar hover feedback. */
	private hoverX = -1;
	private hoverY = -1;

	constructor(tui: TUI, theme: Theme, options: VimFileEditorOptions, done: DoneCallback) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.done = done;
		this.doc = new VimDocument(options.initialContent);
		this.vimMode = options.vim ?? false;
		this.doc.mode = this.vimMode ? "normal" : "insert";
		this.chatUnsubscribe =
			options.chat?.subscribe((message) => {
				if (message.role === "user" && this.lastLocalChatText) {
					const echo = this.lastLocalChatText;
					if (message.text === echo.text && Date.now() - echo.time < 3000) {
						this.lastLocalChatText = null;
						return;
					}
				}
				if (message.role === "assistant") {
					const pendingIndex = this.chatMessages.findIndex((m) => m.pending);
					if (pendingIndex >= 0) this.chatMessages[pendingIndex] = { ...message };
					else this.chatMessages.push({ ...message });
				} else {
					this.chatMessages.push({ ...message });
				}
				if (this.chatMessages.length > MAX_CHAT_MESSAGES) {
					this.chatMessages.splice(0, this.chatMessages.length - MAX_CHAT_MESSAGES);
				}
				this.chatScroll = 0;
			}) ?? null;
		this.enableMouse();
	}

	invalidate(): void {
		// No cached render state.
	}

	dispose(): void {
		this.chatUnsubscribe?.();
		this.chatUnsubscribe = null;
		this.disableMouse();
	}

	private enableMouse(): void {
		if (this.mouseEnabled) return;
		this.mouseEnabled = true;
		this.tui.terminal.write(MOUSE_ENABLE_SEQUENCE);
	}

	private disableMouse(): void {
		if (!this.mouseEnabled) return;
		this.mouseEnabled = false;
		this.tui.terminal.write(MOUSE_DISABLE_SEQUENCE);
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	render(width: number): string[] {
		const rows = Math.max(8, this.tui.terminal.rows);
		const editorHeight = rows - 1;
		const textRows = editorHeight - 2; // Rows 0-1 are the title bar and toolbar.
		this.lastWidth = width;
		// Keep a user-dragged sidebar width across renders; otherwise fall back
		// to the default ratio, clamped to the maximum drag width.
		const defaultChatWidth = Math.max(CHAT_MIN_WIDTH, Math.min(44, Math.floor(width * CHAT_RATIO)));
		this.chatWidth = this.chatWidthOverride ?? defaultChatWidth;
		this.chatWidth = Math.max(CHAT_MIN_WIDTH, Math.min(Math.floor(width * CHAT_MAX_RATIO), this.chatWidth));
		this.textWidth = Math.max(10, width - this.chatWidth - 1);

		// Keep the cursor visible.
		if (this.doc.cursor.line < this.scrollTop) {
			this.scrollTop = this.doc.cursor.line;
		} else if (this.doc.cursor.line >= this.scrollTop + textRows) {
			this.scrollTop = this.doc.cursor.line - textRows + 1;
		}
		const maxScroll = Math.max(0, this.doc.lines.length - textRows);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));

		const selection = this.doc.selection();
		const lines: string[] = [];
		const separator = this.theme.fg("borderMuted", this.resizingSidebar ? "║" : "│");
		const textBodyWidth = Math.max(1, this.textWidth - this.gutterWidth());
		const canScrollDown = this.scrollTop + textRows < this.doc.lines.length;

		lines.push(`${this.renderTitleBar(this.textWidth)}${separator}${this.renderChatRow(0, editorHeight)}`);
		lines.push(`${this.renderToolbar(this.textWidth)}${separator}${this.renderChatRow(1, editorHeight)}`);

		for (let row = 2; row < editorHeight; row++) {
			const lineIndex = this.scrollTop + (row - 2);
			const source = this.doc.lines[lineIndex] ?? "";
			const isCursorLine = lineIndex === this.doc.cursor.line;
			const expanded = expandTabs(source);

			let body = truncateToWidth(expanded, textBodyWidth, "", true);

			const selOnLine = selection !== null && lineIndex >= selection.start.line && lineIndex <= selection.end.line;
			const cursorCol = visualColOf(source, this.doc.cursor.col);
			if (isCursorLine && this.focused) {
				// Compose the cursor line from plain segments so the selection
				// and the cursor block never corrupt each other's ANSI codes.
				const plain = truncateToWidth(expanded, textBodyWidth, "", true);
				const cc = Math.min(cursorCol, Math.max(0, visibleWidth(plain) - 1));
				const invert = (s: string): string => `\x1b[7m${s}\x1b[0m`;
				let out = "";
				if (selOnLine) {
					const from = lineIndex === selection.start.line ? visualColOf(source, selection.start.col) : 0;
					const to =
						lineIndex === selection.end.line
							? visualColOf(source, selection.end.col)
							: Math.min(textBodyWidth, visualColOf(source, source.length));
					const split = Math.max(from, Math.min(to, cc));
					out += sliceByColumn(plain, 0, from);
					if (split - from > 0) out += invert(sliceByColumn(plain, from, split - from));
					const at = sliceByColumn(plain, split, 1) || " ";
					out += `${CURSOR_MARKER}\x1b[7m${at}\x1b[0m`;
					if (split + 1 < to) out += invert(sliceByColumn(plain, split + 1, to - split - 1));
					out += sliceByColumn(plain, Math.max(to, split + 1), 10000);
				} else {
					out += sliceByColumn(plain, 0, cc);
					const at = sliceByColumn(plain, cc, 1) || " ";
					out += `${CURSOR_MARKER}\x1b[7m${at}\x1b[0m`;
					out += sliceByColumn(plain, cc + 1, 10000);
				}
				body = out;
			} else if (selOnLine) {
				const from = lineIndex === selection.start.line ? visualColOf(source, selection.start.col) : 0;
				const to =
					lineIndex === selection.end.line
						? visualColOf(source, selection.end.col)
						: Math.min(textBodyWidth, visualColOf(source, source.length));
				body = invertRangeByColumn(body, from, to);
			}

			// Scroll markers on the first/last visible text rows.
			const marker =
				row === 2 && this.scrollTop > 0
					? this.theme.fg("warning", "↑")
					: row === editorHeight - 1 && canScrollDown
						? this.theme.fg("warning", "↓")
						: "";
			const markerW = marker.length > 0 ? visibleWidth(marker) : 0;
			const pad = Math.max(0, textBodyWidth - markerW - visibleWidth(body));
			const gutter = `${this.theme.fg(isCursorLine && this.focused ? "accent" : "dim", String(lineIndex + 1).padStart(this.gutterWidth() - 2))}${this.theme.fg("borderMuted", "│")} `;

			lines.push(`${gutter}${body}${" ".repeat(pad)}${marker}${separator}${this.renderChatRow(row, editorHeight)}`);
		}

		if (this.menuOpen) {
			this.renderMenuOverlay(lines, width, editorHeight);
		}
		lines.push(this.renderStatus(width));
		return lines;
	}

	/** Width of the line-number gutter (digits + "│ "), minimum 2 digits. */
	private gutterWidth(): number {
		return Math.max(2, String(this.doc.lines.length).length) + 2;
	}

	/** CJK characters plus latin words; a friendly "字数" for prose. */
	private wordCount(): number {
		const text = this.doc.getText();
		const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
		const latin = text
			.replace(/[\u3400-\u9fff]/g, " ")
			.split(/\s+/)
			.filter(Boolean).length;
		return cjk + latin;
	}

	private renderTitleBar(width: number): string {
		const t = this.theme;
		const stats = t.fg("muted", `约 ${this.wordCount()} 字`);
		const statsW = visibleWidth(stats);
		const title = `${t.fg("accent", "✒ ")}${t.fg(
			"text",
			truncateToWidth(this.options.title ?? this.options.displayPath, Math.max(0, width - statsW - 3), "…"),
		)}`;
		const titleW = visibleWidth(title);
		const line = `${title}${" ".repeat(Math.max(0, width - titleW - statsW))}${stats}`;
		return truncateToWidth(line, width, "", true);
	}

	private renderToolbar(width: number): string {
		let line = "";
		for (const button of TOOLBAR_BUTTONS) {
			const hovered = this.hoverY === 2 && this.toolbarButtonAt(this.hoverX) === button.key;
			const label = hovered
				? this.theme.bg("selectedBg", this.theme.fg("accent", button.label))
				: this.theme.bg("selectedBg", this.theme.fg("text", button.label));
			line += `${label} `;
		}
		line += this.theme.fg("dim", "Ctrl+S 保存 · Esc 退出 · Ctrl+Z 撤回 · Shift+F10 菜单");
		return truncateToWidth(line, width, "", true);
	}

	private toolbarButtonAt(x: number): (typeof TOOLBAR_BUTTONS)[number]["key"] | undefined {
		let col = 1;
		for (const button of TOOLBAR_BUTTONS) {
			const start = col;
			const end = col + visibleWidth(button.label) - 1;
			if (x >= start && x <= end) return button.key;
			col = end + 2;
		}
		return undefined;
	}

	private renderChatRow(row: number, editorHeight: number): string {
		const width = this.chatWidth;
		const t = this.theme;
		if (row === 0) {
			const title = `${t.fg("accent", "✦ ")}${t.fg("text", "AI 讨论")}`;
			const hint = this.chatFocus ? t.fg("dim", "输入中…") : t.fg("dim", "Tab 或点击输入");
			const line = `${title} ${hint}`;
			return t.bg("toolPendingBg", truncateToWidth(line, width, "", true));
		}
		if (row === 1) {
			return t.fg("borderMuted", "─".repeat(Math.max(1, width)));
		}
		const inputTop = editorHeight - 3;
		if (row === inputTop) return this.renderChatBox(width, "top");
		if (row === editorHeight - 2) return this.renderChatInput(width);
		if (row === editorHeight - 1) return this.renderChatBox(width, "bottom");
		const display = this.buildChatDisplay(width - 2);
		const available = Math.max(1, inputTop - 2);
		const start = Math.max(0, display.length - available - this.chatScroll);
		const index = start + (row - 2);
		const line = display[index] ?? "";
		return ` ${truncateToWidth(line, width - 1, "", true)}`;
	}

	private renderChatBox(width: number, kind: "top" | "bottom"): string {
		const t = this.theme;
		const c = this.chatFocus ? "borderAccent" : "border";
		const edge = kind === "top" ? "╭" : "╰";
		const end = kind === "top" ? "╮" : "╯";
		return `${t.fg(c, edge)}${t.fg(c, "─".repeat(Math.max(0, width - 2)))}${t.fg(c, end)}`;
	}

	private renderChatInput(width: number): string {
		const t = this.theme;
		const inner = width - 4;
		const border = this.chatFocus ? t.fg("borderAccent", "│") : t.fg("border", "│");
		let body = `${t.fg("accent", "❯ ")}${this.chatInput}`;
		if (this.chatFocus) {
			body = `${truncateToWidth(body, inner - 1, "", true)}${CURSOR_MARKER}\x1b[7m \x1b[0m`;
			body += " ".repeat(Math.max(0, inner - visibleWidth(body)));
		} else {
			body = truncateToWidth(body, inner, "", true);
		}
		return `${border} ${body} ${border}`;
	}

	private buildChatDisplay(width: number): string[] {
		const out: string[] = [];
		const t = this.theme;
		const inner = Math.max(1, width - 4);
		for (const message of this.chatMessages) {
			const label = message.role === "user" ? "你" : "AI";
			const accent = message.role === "user";
			const border = (s: string): string => t.fg(accent ? "accent" : "border", s);
			// Assistant bubbles get a soft background block so they stand apart
			// from user messages in long conversations.
			const bubble = (s: string): string => (message.role === "assistant" ? t.bg("customMessageBg", s) : s);
			const topPrefix = `╭─ ${label} `;
			out.push(
				bubble(
					`${border(topPrefix)}${border("─".repeat(Math.max(1, width - visibleWidth(topPrefix) - 1)))}${border("╮")}`,
				),
			);
			const bodyLines = message.pending ? [t.fg("warning", "思考中…")] : this.renderMarkdown(message.text, inner);
			for (const line of bodyLines) {
				out.push(bubble(`${border("│")} ${truncateToWidth(line, inner, "", true)} ${border("│")}`));
			}
			out.push(bubble(`${border("╰")}${border("─".repeat(Math.max(1, width - 2)))}${border("╯")}`));
			out.push("");
		}
		if (out.length > 0 && out[out.length - 1] === "") out.pop();
		return out;
	}

	/** Render a chat message as styled markdown (headings, lists, code, …). */
	private renderMarkdown(text: string, width: number): string[] {
		if (text.trim().length === 0) return [""];
		return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
	}

	private renderStatus(width: number): string {
		const mode = this.vimMode ? (MODE_LABEL[this.doc.mode] ?? "-- 普通 --") : "-- 编辑 --";
		const pos = `${this.doc.cursor.line + 1},${this.doc.cursor.col + 1}`;
		const state = this.doc.dirty ? this.theme.fg("warning", "● 未保存") : this.theme.fg("success", "✓ 已保存");
		const extra = this.commandBuffer || this.status;
		const hints = this.vimMode
			? ":w 保存 · :q 退出 · v 选择 · Tab 聊天 · 右键菜单"
			: "Ctrl+S 保存 · Esc 退出 · Tab 聊天 · 右键菜单";
		const modePart = this.theme.bold(this.theme.fg("accent", mode));
		const pathPart = this.theme.fg("text", this.options.displayPath);
		const posPart = this.theme.fg("dim", pos);
		const statePart = state;
		const hintsPart = this.theme.fg("dim", hints);
		// Narrow screens drop the least essential parts, keeping mode/state/extra.
		let parts = [modePart, pathPart, posPart, statePart, hintsPart];
		const join = (): string => [...parts, ...(extra ? [this.theme.fg("warning", extra)] : [])].join("  ");
		let line = join();
		if (visibleWidth(line) > width) {
			parts = [modePart, pathPart, posPart, statePart];
			line = join();
		}
		if (visibleWidth(line) > width) {
			parts = [modePart, posPart, statePart];
			line = join();
		}
		if (visibleWidth(line) > width) {
			parts = [modePart, statePart];
			line = join();
		}
		return this.theme.bg("toolPendingBg", truncateToWidth(line, width, "", true));
	}

	/** Clamped on-screen geometry of the open context menu. */
	private menuGeometry(): { row: number; col: number; width: number; height: number; itemWidth: number } {
		const itemWidth = Math.max(...MENU_ITEMS.map((item) => visibleWidth(item)));
		const menuWidth = itemWidth + 4;
		const menuHeight = MENU_ITEMS.length + 2;
		const rows = Math.max(8, this.tui.terminal.rows);
		const editorHeight = rows - 1;
		const row = Math.max(1, Math.min(this.menuRow, editorHeight - menuHeight - 1));
		const col = Math.max(1, Math.min(this.menuCol, this.lastWidth - menuWidth - 1));
		return { row, col, width: menuWidth, height: menuHeight, itemWidth };
	}

	private renderMenuOverlay(lines: string[], _width: number, _editorHeight: number): void {
		const { row, col, width: menuWidth, itemWidth } = this.menuGeometry();
		const box: string[] = [];
		const border = (s: string): string => this.theme.fg("border", s);
		box.push(`${border("┌")}${border("─".repeat(menuWidth - 2))}${border("┐")}`);
		for (let i = 0; i < MENU_ITEMS.length; i++) {
			const item = MENU_ITEMS[i]!;
			const padded = ` ${item.padEnd(itemWidth)} `;
			box.push(
				i === this.menuIndex
					? `${border("│")}${this.theme.bg("selectedBg", this.theme.fg("accent", padded))}${border("│")}`
					: `${border("│")}${this.theme.fg("text", padded)}${border("│")}`,
			);
		}
		box.push(`${border("└")}${border("─".repeat(menuWidth - 2))}${border("┘")}`);
		for (let i = 0; i < box.length; i++) {
			const target = lines[row + i];
			if (target === undefined) break;
			const stripped = stripAnsi(target);
			lines[row + i] = `${stripped.slice(0, col)}${box[i]!.padEnd(menuWidth)}${stripped.slice(col + menuWidth)}`;
		}
	}

	// =========================================================================
	// Input
	// =========================================================================

	handleInput(data: string): void {
		if (this.closed) return;

		const mouse = parseSgrMouse(data);
		if (mouse) {
			this.handleMouse(mouse);
			return;
		}

		if (matchesKey(data, "ctrl+s")) {
			void this.save();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.chatFocus = true;
			this.status = "";
			return;
		}
		if (this.menuOpen) {
			this.handleMenuInput(data);
			return;
		}
		if (this.chatFocus) {
			this.handleChatInput(data);
			return;
		}
		if (matchesKey(data, "shift+f10")) {
			this.openMenuAtCursor();
			return;
		}

		if (!this.vimMode) {
			this.handleSimpleInput(data);
			return;
		}

		if (this.commandBuffer.length > 0) {
			this.handleCommandInput(data);
			return;
		}

		if (this.doc.mode === "insert") {
			this.handleInsertInput(data);
			return;
		}

		if (this.doc.mode === "visual") {
			this.handleVisualInput(data);
			return;
		}

		this.handleNormalInput(data);
	}

	private handleSimpleInput(data: string): void {
		if (matchesKey(data, "ctrl+z")) {
			this.doc.undo();
			this.cancelSelection();
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "ctrl+y")) {
			this.doc.redo();
			this.cancelSelection();
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			this.selectAll();
			return;
		}
		if (matchesKey(data, "ctrl+q")) {
			this.finish(false);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.doc.visualAnchor !== null) {
				this.doc.cancelVisual();
				this.doc.mode = "insert";
				this.typingChunk = false;
				return;
			}
			this.tryQuit();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.mutate(() => this.doc.newLine());
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.mutate(() => {
				if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
				else this.doc.backspace();
				this.doc.mode = "insert";
			});
			return;
		}
		if (matchesKey(data, "delete")) {
			this.mutate(() => {
				if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
				else this.doc.deleteForward();
				this.doc.mode = "insert";
			});
			return;
		}
		if (matchesKey(data, "left")) {
			this.cancelSelection();
			this.doc.moveLeft(1);
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "right")) {
			this.cancelSelection();
			this.doc.moveRight(1);
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "up")) {
			this.cancelSelection();
			this.doc.moveUp(1);
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "down")) {
			this.cancelSelection();
			this.doc.moveDown(1);
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "home")) {
			this.cancelSelection();
			this.doc.lineStart();
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "end")) {
			this.cancelSelection();
			this.doc.lineEnd();
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.cancelSelection();
			this.doc.moveUp(10);
			this.typingChunk = false;
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.cancelSelection();
			this.doc.moveDown(10);
			this.typingChunk = false;
			return;
		}

		const paste = extractBracketedPaste(data);
		if (paste !== undefined) {
			this.mutate(() => {
				if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
				this.doc.insertText(paste);
				this.doc.mode = "insert";
			});
			return;
		}

		if (data.length === 1 && !isControlChar(data)) {
			this.mutate(() => {
				if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
				this.doc.insertText(data);
				this.doc.mode = "insert";
			});
		}
	}

	/** Run an edit, snapshotting once per typing chunk so Ctrl+Z undoes naturally. */
	private mutate(fn: () => void): void {
		if (!this.typingChunk) {
			this.doc.pushUndo();
			this.typingChunk = true;
		}
		fn();
	}

	/** Drop any visual selection without changing the editor mode (simple mode). */
	private cancelSelection(): void {
		if (this.doc.visualAnchor !== null) this.doc.visualAnchor = null;
	}

	private selectAll(): void {
		this.doc.visualAnchor = { line: 0, col: 0 };
		const last = this.doc.lines.length - 1;
		this.doc.cursor = { line: last, col: this.doc.lines[last]?.length ?? 0 };
		this.doc.mode = "insert";
		this.typingChunk = false;
	}

	private selectWordAt(line: number, col: number): void {
		const source = this.doc.lines[line] ?? "";
		const { start, end } = wordRangeAt(source, col);
		if (start === end) return;
		this.doc.visualAnchor = { line, col: start };
		this.doc.cursor = { line, col: end };
		this.doc.mode = "insert";
		this.typingChunk = false;
	}

	private selectLineAt(line: number): void {
		this.doc.visualAnchor = { line, col: 0 };
		this.doc.cursor = { line, col: this.doc.lines[line]?.length ?? 0 };
		this.doc.mode = "insert";
		this.typingChunk = false;
	}

	private handleMenuInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.closeMenu();
			return;
		}
		if (matchesKey(data, "up")) {
			this.menuIndex = (this.menuIndex - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.menuIndex = (this.menuIndex + 1) % MENU_ITEMS.length;
			return;
		}
		if (matchesKey(data, "enter")) {
			this.executeMenu(this.menuIndex);
		}
	}

	private closeMenu(): void {
		this.menuOpen = false;
	}

	private openMenuAt(x: number, y: number): void {
		this.menuRow = y - 1;
		this.menuCol = x - 1;
		this.menuIndex = 0;
		this.menuOpen = true;
	}

	private isInMenu(x: number, y: number): boolean {
		const { row, col, width: menuWidth, height: menuHeight } = this.menuGeometry();
		return x - 1 >= col && x - 1 < col + menuWidth && y - 1 >= row && y - 1 < row + menuHeight;
	}

	private executeMenu(index: number): void {
		const item = MENU_ITEMS[index];
		this.closeMenu();
		if (item === "和 AI 讨论") {
			const text = this.doc.selectedText();
			if (!text) {
				this.status = "请先选中文字";
				return;
			}
			this.sendChat(text);
			return;
		}
		if (item === "复制") {
			const text = this.doc.selectedText();
			if (!text) {
				this.status = "请先选中文字";
				return;
			}
			void copyToClipboard(text)
				.then(() => {
					this.status = "已复制";
				})
				.catch(() => {
					this.status = "复制失败";
				});
			return;
		}
		if (item === "全选") {
			this.selectAll();
		}
	}

	private handleChatInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.chatFocus = false;
			return;
		}
		if (matchesKey(data, "enter")) {
			this.sendChat();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.chatInput = this.chatInput.slice(0, -1);
			return;
		}
		const paste = extractBracketedPaste(data);
		if (paste !== undefined) {
			// The chat box is single-line; fold pasted newlines into spaces.
			this.chatInput += paste.replace(/\r?\n/g, " ");
			return;
		}
		if (data.length === 1 && !isControlChar(data)) {
			this.chatInput += data;
		}
	}

	private sendChat(textOverride?: string): void {
		const text = (textOverride ?? this.chatInput).trim();
		if (!text) return;
		this.chatInput = "";
		this.appendChat({ role: "user", text });
		this.lastLocalChatText = { text, time: Date.now() };
		if (this.options.chat) {
			this.options.chat.send(text);
			this.appendChat({ role: "assistant", text: "", pending: true });
		} else {
			this.status = "聊天未连接";
		}
	}

	private appendChat(message: ChatMessage & { pending?: boolean }): void {
		this.chatMessages.push(message);
		if (this.chatMessages.length > MAX_CHAT_MESSAGES) {
			this.chatMessages.splice(0, this.chatMessages.length - MAX_CHAT_MESSAGES);
		}
		this.chatScroll = 0;
	}

	private handleMouse(event: SgrMouseEvent): void {
		const rows = Math.max(8, this.tui.terminal.rows);
		const editorHeight = rows - 1;

		if (event.kind === "press" || event.kind === "drag") {
			this.hoverX = event.x;
			this.hoverY = event.y;
		}

		if (event.kind === "wheel") {
			if (this.isInChatArea(event.x)) {
				this.chatScroll = Math.max(0, this.chatScroll + event.delta * WHEEL_SCROLL_LINES);
			} else {
				this.scrollTop = Math.max(0, this.scrollTop + event.delta * WHEEL_SCROLL_LINES);
			}
			this.status = "";
			return;
		}

		if (event.kind === "press" && event.button === "right") {
			if (event.y === 2) {
				this.openMenuAtCursor();
				return;
			}
			if (this.isInChatArea(event.x)) {
				this.closeMenu();
				return;
			}
			const pos = this.cursorFromCell(event.x, event.y);
			const selection = this.doc.selection();
			const insideSelection =
				selection !== null &&
				(pos.line > selection.start.line ||
					(pos.line === selection.start.line && pos.col >= selection.start.col)) &&
				(pos.line < selection.end.line || (pos.line === selection.end.line && pos.col <= selection.end.col));
			if (!insideSelection) {
				this.doc.cursor = pos;
				this.doc.visualAnchor = null;
				this.doc.mode = this.vimMode ? "normal" : "insert";
			}
			this.chatFocus = false;
			this.openMenuAt(event.x, event.y);
			return;
		}

		if (event.kind === "press" && event.button === "left") {
			if (this.menuOpen && this.isInMenu(event.x, event.y)) {
				const itemRow = event.y - 1 - this.menuGeometry().row;
				if (itemRow >= 1 && itemRow <= MENU_ITEMS.length) {
					this.executeMenu(itemRow - 1);
				}
				return;
			}
			this.closeMenu();

			if (event.y === 1) {
				// Title bar: nothing to click yet.
				this.chatFocus = false;
				return;
			}

			if (event.y === 2) {
				this.chatFocus = false;
				const button = this.toolbarButtonAt(event.x);
				if (button === "save") {
					void this.save();
					return;
				}
				if (button === "quit") {
					this.tryQuit();
					return;
				}
				if (button === "undo") {
					this.doc.undo();
					this.typingChunk = false;
					return;
				}
				if (button === "redo") {
					this.doc.redo();
					this.typingChunk = false;
					return;
				}
			}

			if (event.x === this.textWidth + 1) {
				this.chatFocus = false;
				this.resizingSidebar = true;
				this.resizeStartX = event.x;
				this.resizeStartChatWidth = this.chatWidth;
				this.status = "";
				return;
			}

			if (this.isInChatArea(event.x)) {
				this.chatFocus = event.y >= editorHeight - 2;
				this.status = "";
				return;
			}

			const pos = this.cursorFromCell(event.x, event.y);
			this.chatFocus = false;
			this.doc.cursor = pos;
			this.doc.visualAnchor = null;
			this.doc.mode = this.vimMode ? "normal" : "insert";
			this.dragStart = pos;
			this.dragging = true;
			this.typingChunk = false;
			this.status = "";

			const now = Date.now();
			const same =
				this.lastClick !== null &&
				this.lastClick.x === event.x &&
				this.lastClick.y === event.y &&
				now - this.lastClick.time < DOUBLE_CLICK_MS;
			const count = same ? this.lastClick!.count + 1 : 1;
			this.lastClick = { time: now, x: event.x, y: event.y, count };
			if (count === 2) {
				this.selectWordAt(pos.line, pos.col);
			} else if (count >= 3) {
				this.selectLineAt(pos.line);
				this.lastClick = { time: now, x: event.x, y: event.y, count: 0 };
			}
			return;
		}

		if (event.kind === "drag") {
			if (this.resizingSidebar) {
				const delta = event.x - this.resizeStartX;
				const maxChatWidth = Math.floor(this.lastWidth * CHAT_MAX_RATIO);
				this.chatWidth = Math.max(CHAT_MIN_WIDTH, Math.min(maxChatWidth, this.resizeStartChatWidth + delta));
				this.chatWidthOverride = this.chatWidth;
				this.status = "";
				return;
			}
			// Only extend the selection while the left button is actually held;
			// hover motion (button "none") must never keep selecting, even if a
			// release event was lost when the mouse left the terminal.
			if (this.dragging && event.button === "left") {
				if (this.dragStart === null) {
					this.dragStart = this.cursorFromCell(event.x, event.y);
				}
				if (this.doc.visualAnchor === null) {
					this.doc.visualAnchor = { ...this.dragStart };
					this.doc.mode = this.vimMode ? "visual" : "insert";
				}
				this.doc.cursor = this.cursorFromCell(event.x, event.y);
				this.typingChunk = false;
				return;
			}
			// Motion without a recorded press (some terminals): start a selection.
			if (event.button === "left") {
				this.dragging = true;
				const pos = this.cursorFromCell(event.x, event.y);
				this.dragStart = pos;
				this.doc.visualAnchor = { ...pos };
				this.doc.cursor = pos;
				this.doc.mode = this.vimMode ? "visual" : "insert";
				this.typingChunk = false;
			}
			return;
		}

		if (event.kind === "release") {
			this.resizingSidebar = false;
			this.dragging = false;
		}
	}

	private openMenuAtCursor(): void {
		const source = this.doc.lines[this.doc.cursor.line] ?? "";
		const y = this.doc.cursor.line - this.scrollTop + 3;
		const gutter = this.gutterWidth();
		const col = Math.max(
			gutter + 2,
			Math.min(this.textWidth - 6, gutter + visualColOf(source, this.doc.cursor.col) + 2),
		);
		this.menuRow = y;
		this.menuCol = col;
		this.menuIndex = 0;
		this.menuOpen = true;
	}

	private isInChatArea(x: number): boolean {
		return x - 1 > this.textWidth;
	}

	private cursorFromCell(x: number, y: number): Cursor {
		const rowIndex = Math.max(0, y - 3); // Rows 1-2 are the title bar and toolbar, text starts at row 3.
		const line = Math.max(0, Math.min(this.doc.lines.length - 1, this.scrollTop + rowIndex));
		const textCol = Math.max(0, x - 1 - this.gutterWidth());
		const source = this.doc.lines[line] ?? "";
		return { line, col: charColAt(source, textCol) };
	}

	private handleNormalInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.tryQuit();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.doc.moveDown(this.takeCount() || 1);
			return;
		}

		if (data >= "1" && data <= "9") {
			this.pendingCount = this.pendingCount * 10 + Number(data);
			return;
		}
		// A leading "0" is the line-start motion, not a count digit (vim semantics).
		if (data === "0" && this.pendingCount > 0) {
			this.pendingCount *= 10;
			return;
		}

		const count = this.takeCount();
		if (matchesKey(data, "ctrl+r")) {
			this.doc.redo();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.doc.moveLeft(count || 1);
			return;
		}

		if (this.pendingG) {
			this.pendingG = false;
			if (data === "g") this.doc.gotoLine(1);
			return;
		}
		if (this.pendingD) {
			this.pendingD = false;
			if (data === "d") this.doc.deleteLine(count || 1);
			return;
		}
		if (this.pendingY) {
			this.pendingY = false;
			if (data === "y") this.doc.yankLine(count || 1);
			return;
		}
		if (this.pendingR) {
			this.pendingR = false;
			if (data.length === 1 && !isControlChar(data)) {
				this.doc.pushUndo();
				this.doc.deleteForward();
				this.doc.insertText(data);
			}
			return;
		}

		switch (data) {
			case "h":
				this.doc.moveLeft(count || 1);
				break;
			case "l":
			case " ":
				this.doc.moveRight(count || 1);
				break;
			case "j":
				this.doc.moveDown(count || 1);
				break;
			case "k":
				this.doc.moveUp(count || 1);
				break;
			case "w":
				for (let i = 0; i < (count || 1); i++) this.doc.nextWord();
				break;
			case "b":
				for (let i = 0; i < (count || 1); i++) this.doc.prevWord();
				break;
			case "e":
				for (let i = 0; i < (count || 1); i++) this.doc.endOfWord();
				break;
			case "0":
				this.doc.lineStart();
				break;
			case "^":
				this.doc.firstNonBlank();
				break;
			case "$":
				this.doc.lineEnd();
				break;
			case "g":
				this.pendingG = true;
				break;
			case "G":
				this.doc.gotoLine(this.doc.lines.length);
				break;
			case "x":
				this.doc.deleteChar(count || 1);
				break;
			case "d":
				this.pendingD = true;
				break;
			case "y":
				this.pendingY = true;
				break;
			case "p":
				this.doc.pasteAfter();
				break;
			case "P":
				this.doc.pasteBefore();
				break;
			case "u":
				this.doc.undo();
				break;
			case "r":
				this.pendingR = true;
				break;
			case "i":
				this.enterInsertMode();
				break;
			case "a":
				this.doc.moveRight(1);
				this.enterInsertMode();
				break;
			case "A":
				this.doc.lineEnd();
				this.enterInsertMode();
				break;
			case "I":
				this.doc.firstNonBlank();
				this.enterInsertMode();
				break;
			case "o":
				this.openLineBelow();
				break;
			case "O":
				this.openLineAbove();
				break;
			case "v":
				this.doc.startVisual();
				break;
			case ":":
				this.commandBuffer = ":";
				break;
			default:
				this.status = `未知按键: ${data}`;
				break;
		}
	}

	private handleInsertInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.doc.mode = "normal";
			this.status = "";
			return;
		}
		if (matchesKey(data, "enter")) {
			this.doc.newLine();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.doc.backspace();
			return;
		}
		if (matchesKey(data, "delete")) {
			this.doc.deleteForward();
			return;
		}
		if (matchesKey(data, "left")) {
			this.doc.moveLeft(1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.doc.moveRight(1);
			return;
		}
		if (matchesKey(data, "up")) {
			this.doc.moveUp(1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.doc.moveDown(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.doc.lineStart();
			return;
		}
		if (matchesKey(data, "end")) {
			this.doc.lineEnd();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.doc.moveUp(10);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.doc.moveDown(10);
			return;
		}

		const paste = extractBracketedPaste(data);
		if (paste !== undefined) {
			if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
			this.doc.insertText(paste);
			this.doc.mode = "insert";
			return;
		}

		if (data.length === 1 && !isControlChar(data)) {
			if (this.doc.visualAnchor !== null) this.doc.deleteSelection();
			this.doc.insertText(data);
			this.doc.mode = "insert";
		}
	}

	private handleVisualInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.doc.cancelVisual();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.doc.moveDown(1);
			return;
		}

		const count = this.takeCount();
		switch (data) {
			case "h":
				this.doc.moveLeft(count || 1);
				break;
			case "l":
			case " ":
				this.doc.moveRight(count || 1);
				break;
			case "j":
				this.doc.moveDown(count || 1);
				break;
			case "k":
				this.doc.moveUp(count || 1);
				break;
			case "w":
				for (let i = 0; i < (count || 1); i++) this.doc.nextWord();
				break;
			case "b":
				for (let i = 0; i < (count || 1); i++) this.doc.prevWord();
				break;
			case "e":
				for (let i = 0; i < (count || 1); i++) this.doc.endOfWord();
				break;
			case "0":
				this.doc.lineStart();
				break;
			case "^":
				this.doc.firstNonBlank();
				break;
			case "$":
				this.doc.lineEnd();
				break;
			case "G":
				this.doc.gotoLine(this.doc.lines.length);
				break;
			case "g":
				this.pendingG = true;
				break;
			case "y":
				this.doc.yankSelection();
				break;
			case "d":
			case "x":
				this.doc.deleteSelection();
				break;
			case "v":
				this.doc.cancelVisual();
				break;
			default:
				break;
		}
	}

	private handleCommandInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.commandBuffer = "";
			this.status = "";
			return;
		}
		if (matchesKey(data, "enter")) {
			const command = this.commandBuffer;
			this.commandBuffer = "";
			void this.executeCommand(command);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.commandBuffer = this.commandBuffer.slice(0, -1);
			return;
		}
		if (data.length === 1 && !isControlChar(data)) {
			this.commandBuffer += data;
		}
	}

	private async executeCommand(command: string): Promise<void> {
		const cmd = command.slice(1).trim();
		switch (cmd) {
			case "w":
				await this.save();
				break;
			case "q":
				if (!this.doc.dirty) this.finish(false);
				else this.status = "未保存，:q! 强制退出";
				break;
			case "q!":
				this.finish(false);
				break;
			case "wq":
			case "x":
				if (await this.save()) this.finish(true);
				break;
			case "wq!":
				await this.save();
				this.finish(true);
				break;
			default:
				this.status = `未知命令: :${cmd}`;
				break;
		}
	}

	private async save(): Promise<boolean> {
		const ok = await this.options.onSave(this.doc.getText());
		if (ok) {
			this.doc.markSaved();
			this.status = "已保存";
		} else {
			this.status = "保存失败";
		}
		return ok;
	}

	private enterInsertMode(): void {
		this.doc.pushUndo();
		this.doc.mode = "insert";
		this.status = "";
	}

	private openLineBelow(): void {
		this.doc.lineEnd();
		this.doc.pushUndo();
		this.doc.newLine();
		this.doc.mode = "insert";
	}

	private openLineAbove(): void {
		this.doc.lineStart();
		this.doc.pushUndo();
		this.doc.newLine();
		this.doc.moveUp(1);
		this.doc.mode = "insert";
	}

	private tryQuit(): void {
		if (!this.doc.dirty) {
			this.finish(false);
		} else if (this.vimMode) {
			this.status = "未保存，:w 保存 / :q! 放弃";
		} else {
			this.status = "未保存！Ctrl+S 保存 / Ctrl+Q 放弃";
		}
	}

	private takeCount(): number {
		const count = this.pendingCount;
		this.pendingCount = 0;
		return count;
	}

	private finish(saved: boolean): void {
		if (this.closed) return;
		this.closed = true;
		this.chatUnsubscribe?.();
		this.chatUnsubscribe = null;
		this.disableMouse();
		this.done({ saved, content: this.doc.getText() });
	}
}

function isControlChar(data: string): boolean {
	const code = data.charCodeAt(0);
	return code < 32 || code === 127;
}

function extractBracketedPaste(data: string): string | undefined {
	if (!data.startsWith("\x1b[200~")) return undefined;
	const inner = data.slice("\x1b[200~".length);
	return inner.endsWith("\x1b[201~") ? inner.slice(0, -"\x1b[201~".length) : inner;
}
