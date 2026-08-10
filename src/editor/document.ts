/**
 * Vim-style text document model for the built-in pi-writer editor.
 *
 * Pure state plus operations with no TUI dependencies, so behavior can be
 * unit-tested without a terminal.
 */

export type EditorMode = "normal" | "insert" | "visual";

export interface Cursor {
	line: number;
	col: number;
}

export interface Selection {
	start: Cursor;
	end: Cursor;
}

interface Snapshot {
	text: string;
	line: number;
	col: number;
}

const MAX_UNDO = 200;

function isBlank(ch: string): boolean {
	return ch.trim() === "";
}

function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

export class VimDocument {
	lines: string[];
	cursor: Cursor = { line: 0, col: 0 };
	mode: EditorMode = "normal";
	visualAnchor: Cursor | null = null;
	register: string | null = null;
	dirty = false;

	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	/** Last content persisted by the caller; dirty reports drift from it. */
	private savedText = "";

	/** 上次保存/加载的文件内容(dirty 基线;供保存方做外部修改冲突比较)。 */
	get savedContent(): string {
		return this.savedText;
	}

	constructor(text = "") {
		this.lines = [""];
		this.setText(text);
	}

	getText(): string {
		return this.lines.join("\n");
	}

	setText(text: string): void {
		this.lines = text.split("\n");
		if (this.lines.length === 0) this.lines = [""];
		this.cursor = { line: 0, col: 0 };
		this.mode = "normal";
		this.visualAnchor = null;
		this.register = null;
		this.dirty = false;
		this.savedText = text;
		this.undoStack = [];
		this.redoStack = [];
	}

	/** Mark the current content as the saved baseline; dirty reports drift from it. */
	markSaved(): void {
		this.savedText = this.getText();
		this.dirty = false;
	}

	private clampCursor(): void {
		this.cursor.line = Math.max(0, Math.min(this.cursor.line, this.lines.length - 1));
		const len = this.lines[this.cursor.line]?.length ?? 0;
		this.cursor.col = Math.max(0, Math.min(this.cursor.col, len));
	}

	// =========================================================================
	// Motions
	// =========================================================================

	moveLeft(count = 1): void {
		this.cursor.col = Math.max(0, this.cursor.col - count);
	}

	moveRight(count = 1): void {
		this.cursor.col = Math.min(this.lines[this.cursor.line]?.length ?? 0, this.cursor.col + count);
	}

	moveDown(count = 1): void {
		this.cursor.line = Math.min(this.lines.length - 1, this.cursor.line + count);
		this.clampCursor();
	}

	moveUp(count = 1): void {
		this.cursor.line = Math.max(0, this.cursor.line - count);
		this.clampCursor();
	}

	lineStart(): void {
		this.cursor.col = 0;
	}

	firstNonBlank(): void {
		const match = this.lines[this.cursor.line]?.search(/\S/) ?? -1;
		this.cursor.col = match < 0 ? 0 : match;
	}

	lineEnd(): void {
		this.cursor.col = this.lines[this.cursor.line]?.length ?? 0;
	}

	gotoLine(line: number): void {
		this.cursor.line = Math.max(0, Math.min(this.lines.length - 1, line - 1));
		this.cursor.col = 0;
	}

	nextWord(): void {
		let line = this.cursor.line;
		let col = this.cursor.col;
		for (;;) {
			const text = this.lines[line] ?? "";
			while (col < text.length && isBlank(text[col]!)) col++;
			if (col < text.length) break;
			if (line >= this.lines.length - 1) break;
			line++;
			col = 0;
		}
		const text = this.lines[line] ?? "";
		if (col >= text.length) return;
		const wordish = isWordChar(text[col]!);
		while (col < text.length) {
			const ch = text[col]!;
			if (wordish ? !isWordChar(ch) : isBlank(ch) || isWordChar(ch)) break;
			col++;
		}
		// Land on the next token start (vim `w` skips inter-word whitespace).
		while (col < text.length && isBlank(text[col]!)) col++;
		if (col >= text.length && line < this.lines.length - 1) {
			line++;
			col = 0;
			const next = this.lines[line] ?? "";
			while (col < next.length && isBlank(next[col]!)) col++;
		}
		this.cursor.line = line;
		this.cursor.col = col;
	}

	prevWord(): void {
		let line = this.cursor.line;
		let col = this.cursor.col;
		for (;;) {
			const text = this.lines[line] ?? "";
			while (col > 0 && isBlank(text[col - 1]!)) col--;
			if (col > 0) break;
			if (line === 0) {
				this.cursor.line = 0;
				this.cursor.col = 0;
				return;
			}
			line--;
			col = this.lines[line]?.length ?? 0;
		}
		const wordish = isWordChar(this.lines[line]![col - 1]!);
		for (;;) {
			const text = this.lines[line] ?? "";
			while (col > 0) {
				const ch = text[col - 1]!;
				if (wordish ? !isWordChar(ch) : isBlank(ch) || isWordChar(ch)) break;
				col--;
			}
			if (col > 0 || line === 0) break;
			line--;
			col = this.lines[line]?.length ?? 0;
		}
		this.cursor.line = line;
		this.cursor.col = col;
	}

	endOfWord(): void {
		let line = this.cursor.line;
		let col = this.cursor.col;
		for (;;) {
			const text = this.lines[line] ?? "";
			while (col < text.length && isBlank(text[col]!)) col++;
			if (col < text.length) break;
			if (line >= this.lines.length - 1) return;
			line++;
			col = 0;
		}
		const text = this.lines[line] ?? "";
		const wordish = isWordChar(text[col]!);
		while (col < text.length) {
			const ch = text[col]!;
			if (wordish ? !isWordChar(ch) : isBlank(ch) || isWordChar(ch)) break;
			col++;
		}
		this.cursor.line = line;
		this.cursor.col = Math.max(0, col - 1);
	}

	// =========================================================================
	// Editing
	// =========================================================================

	pushUndo(): void {
		this.undoStack.push({ text: this.getText(), line: this.cursor.line, col: this.cursor.col });
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
		this.dirty = true;
	}

	undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.redoStack.push({ text: this.getText(), line: this.cursor.line, col: this.cursor.col });
		this.lines = snapshot.text.split("\n");
		this.cursor = { line: snapshot.line, col: snapshot.col };
		this.clampCursor();
		this.dirty = this.getText() !== this.savedText;
	}

	redo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.undoStack.push({ text: this.getText(), line: this.cursor.line, col: this.cursor.col });
		this.lines = snapshot.text.split("\n");
		this.cursor = { line: snapshot.line, col: snapshot.col };
		this.clampCursor();
		this.dirty = this.getText() !== this.savedText;
	}

	insertText(text: string): void {
		if (text.length === 0) return;
		if (text.includes("\n")) {
			const parts = text.split("\n");
			const line = this.lines[this.cursor.line]!;
			const before = line.slice(0, this.cursor.col);
			const after = line.slice(this.cursor.col);
			this.lines[this.cursor.line] = before + (parts[0] ?? "");
			const inserted = parts.slice(1);
			this.lines.splice(this.cursor.line + 1, 0, ...inserted);
			this.lines[this.cursor.line + inserted.length] =
				(this.lines[this.cursor.line + inserted.length] ?? "") + after;
			this.cursor.line += inserted.length;
			this.cursor.col = (this.lines[this.cursor.line] ?? "").length - after.length;
		} else {
			const line = this.lines[this.cursor.line]!;
			this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + text + line.slice(this.cursor.col);
			this.cursor.col += text.length;
		}
		this.dirty = true;
	}

	newLine(): void {
		const line = this.lines[this.cursor.line]!;
		const before = line.slice(0, this.cursor.col);
		const after = line.slice(this.cursor.col);
		this.lines[this.cursor.line] = before;
		this.lines.splice(this.cursor.line + 1, 0, after);
		this.cursor.line++;
		this.cursor.col = 0;
		this.dirty = true;
	}

	backspace(): void {
		const line = this.lines[this.cursor.line]!;
		if (this.cursor.col > 0) {
			this.lines[this.cursor.line] = line.slice(0, this.cursor.col - 1) + line.slice(this.cursor.col);
			this.cursor.col--;
		} else if (this.cursor.line > 0) {
			const prev = this.lines[this.cursor.line - 1]!;
			this.lines[this.cursor.line - 1] = prev + line;
			this.lines.splice(this.cursor.line, 1);
			this.cursor.line--;
			this.cursor.col = prev.length;
		}
		this.dirty = true;
	}

	deleteForward(): void {
		const line = this.lines[this.cursor.line]!;
		if (this.cursor.col < line.length) {
			this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + line.slice(this.cursor.col + 1);
		} else if (this.cursor.line < this.lines.length - 1) {
			this.lines[this.cursor.line] = line + this.lines[this.cursor.line + 1]!;
			this.lines.splice(this.cursor.line + 1, 1);
		}
		this.dirty = true;
	}

	deleteChar(count = 1): void {
		this.pushUndo();
		for (let i = 0; i < count; i++) this.deleteForward();
	}

	deleteLine(count = 1): void {
		this.pushUndo();
		const start = this.cursor.line;
		const end = Math.min(this.lines.length, start + count);
		// Trailing newline marks the register as linewise, like vim dd/yy.
		this.register = `${this.lines.slice(start, end).join("\n")}\n`;
		this.lines.splice(start, end - start);
		if (this.lines.length === 0) this.lines = [""];
		this.cursor.line = Math.min(start, this.lines.length - 1);
		this.cursor.col = 0;
	}

	yankLine(count = 1): void {
		const start = this.cursor.line;
		const end = Math.min(this.lines.length, start + count);
		this.register = `${this.lines.slice(start, end).join("\n")}\n`;
	}

	pasteAfter(): void {
		if (this.register === null) return;
		this.pushUndo();
		if (this.register.includes("\n")) {
			const pasted = this.register.split("\n");
			if (pasted.at(-1) === "") pasted.pop();
			const at = this.cursor.line + 1;
			this.lines.splice(at, 0, ...pasted);
			this.cursor.line = at;
			this.cursor.col = 0;
		} else {
			const line = this.lines[this.cursor.line]!;
			this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + this.register + line.slice(this.cursor.col);
			this.cursor.col += this.register.length;
		}
	}

	pasteBefore(): void {
		if (this.register === null) return;
		this.pushUndo();
		if (this.register.includes("\n")) {
			const pasted = this.register.split("\n");
			if (pasted.at(-1) === "") pasted.pop();
			this.lines.splice(this.cursor.line, 0, ...pasted);
			this.cursor.line += pasted.length - 1;
			this.cursor.col = 0;
		} else {
			const line = this.lines[this.cursor.line]!;
			this.lines[this.cursor.line] = line.slice(0, this.cursor.col) + this.register + line.slice(this.cursor.col);
		}
	}

	// =========================================================================
	// Visual mode
	// =========================================================================

	startVisual(): void {
		this.visualAnchor = { ...this.cursor };
		this.mode = "visual";
	}

	cancelVisual(): void {
		this.visualAnchor = null;
		this.mode = "normal";
	}

	selection(): Selection | null {
		if (this.visualAnchor === null) return null;
		const a = this.visualAnchor;
		const b = this.cursor;
		const start = a.line < b.line || (a.line === b.line && a.col <= b.col) ? { ...a } : { ...b };
		const end = start.line === a.line && start.col === a.col ? { ...b } : { ...a };
		return { start, end };
	}

	selectedText(): string {
		const sel = this.selection();
		if (!sel) return "";
		const { start, end } = sel;
		if (start.line === end.line) return this.lines[start.line]!.slice(start.col, end.col);
		const parts = [this.lines[start.line]!.slice(start.col)];
		for (let i = start.line + 1; i < end.line; i++) parts.push(this.lines[i] ?? "");
		parts.push(this.lines[end.line]!.slice(0, end.col));
		return parts.join("\n");
	}

	deleteSelection(): void {
		const sel = this.selection();
		if (!sel) return;
		this.pushUndo();
		const { start, end } = sel;
		if (start.line === end.line) {
			const line = this.lines[start.line]!;
			this.lines[start.line] = line.slice(0, start.col) + line.slice(end.col);
		} else {
			const first = this.lines[start.line]!.slice(0, start.col);
			const last = this.lines[end.line]!.slice(end.col);
			this.lines.splice(start.line, end.line - start.line + 1, first + last);
		}
		this.cursor = { ...start };
		this.mode = "normal";
		this.visualAnchor = null;
	}

	yankSelection(): void {
		this.register = this.selectedText();
		this.mode = "normal";
		this.visualAnchor = null;
	}
}
