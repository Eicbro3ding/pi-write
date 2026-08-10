import { describe, expect, it } from "vitest";
import { VimDocument } from "../src/editor/document.ts";
import { parseEditArgs } from "../src/editor/index.ts";
import { parseSgrMouse } from "../src/editor/mouse.ts";

describe("parseEditArgs", () => {
	it("defaults to the simple editor with the given path", () => {
		expect(parseEditArgs("draft/ch01.md")).toEqual({ vim: false, path: "draft/ch01.md", force: false });
		expect(parseEditArgs("")).toEqual({ vim: false, path: "", force: false });
	});

	it("enables vim mode", () => {
		expect(parseEditArgs("--vim")).toEqual({ vim: true, path: "", force: false });
		expect(parseEditArgs("vim notes/x.md")).toEqual({ vim: true, path: "notes/x.md", force: false });
		expect(parseEditArgs("--vim draft/ch02.md")).toEqual({ vim: true, path: "draft/ch02.md", force: false });
	});

	it("parses --force in any position", () => {
		expect(parseEditArgs("--force")).toEqual({ vim: false, path: "", force: true });
		expect(parseEditArgs("--force outline.md")).toEqual({ vim: false, path: "outline.md", force: true });
		expect(parseEditArgs("outline.md --force")).toEqual({ vim: false, path: "outline.md", force: true });
		expect(parseEditArgs("--vim --force .writer/characters.md")).toEqual({ vim: true, path: ".writer/characters.md", force: true });
		expect(parseEditArgs("--force --vim .writer/world.md")).toEqual({ vim: true, path: ".writer/world.md", force: true });
	});
});

describe("VimDocument motions", () => {
	it("walks words forward and backward", () => {
		const doc = new VimDocument("hello world\nfoo bar");
		doc.nextWord();
		expect(doc.cursor).toEqual({ line: 0, col: 6 });
		doc.nextWord();
		expect(doc.cursor).toEqual({ line: 1, col: 0 });
		doc.prevWord();
		expect(doc.cursor).toEqual({ line: 0, col: 6 });
		doc.prevWord();
		expect(doc.cursor).toEqual({ line: 0, col: 0 });
	});

	it("moves to line start, first non-blank, and line end", () => {
		const doc = new VimDocument("  hello\nworld");
		doc.cursor = { line: 0, col: 7 };
		doc.lineEnd();
		expect(doc.cursor.col).toBe(7);
		doc.firstNonBlank();
		expect(doc.cursor.col).toBe(2);
		doc.lineStart();
		expect(doc.cursor.col).toBe(0);
	});

	it("supports gg and G", () => {
		const doc = new VimDocument("one\ntwo\nthree");
		doc.gotoLine(3);
		expect(doc.cursor.line).toBe(2);
		doc.gotoLine(1);
		expect(doc.cursor.line).toBe(0);
	});

	it("moves down and clamps columns", () => {
		const doc = new VimDocument("a\nlong line");
		doc.cursor = { line: 0, col: 0 };
		doc.moveDown();
		expect(doc.cursor.line).toBe(1);
		doc.moveRight(99);
		expect(doc.cursor.col).toBe(9);
		doc.moveUp();
		expect(doc.cursor.col).toBe(1);
	});
});

describe("VimDocument editing", () => {
	it("inserts text and splits lines", () => {
		const doc = new VimDocument("abc");
		doc.cursor = { line: 0, col: 1 };
		doc.insertText("X");
		expect(doc.getText()).toBe("aXbc");
		doc.newLine();
		expect(doc.getText()).toBe("aX\nbc");
	});

	it("handles backspace and forward delete", () => {
		const doc = new VimDocument("abc");
		doc.cursor = { line: 0, col: 2 };
		doc.backspace();
		expect(doc.getText()).toBe("ac");
		doc.cursor = { line: 0, col: 0 };
		doc.deleteForward();
		expect(doc.getText()).toBe("c");
	});

	it("deletes and yanks lines, then pastes linewise", () => {
		const doc = new VimDocument("one\ntwo\nthree");
		doc.cursor = { line: 1, col: 0 };
		doc.deleteLine();
		expect(doc.getText()).toBe("one\nthree");
		doc.pasteAfter();
		expect(doc.getText()).toBe("one\nthree\ntwo");
	});

	it("pastes yanked lines linewise", () => {
		const doc = new VimDocument("one\ntwo");
		doc.cursor = { line: 0, col: 0 };
		doc.yankLine();
		doc.pasteAfter();
		expect(doc.getText()).toBe("one\none\ntwo");
	});

	it("undoes and redoes edits", () => {
		const doc = new VimDocument("abc");
		doc.pushUndo();
		doc.insertText("X");
		expect(doc.getText()).toBe("Xabc");
		doc.undo();
		expect(doc.getText()).toBe("abc");
		doc.redo();
		expect(doc.getText()).toBe("Xabc");
	});

	it("tracks dirty against the saved baseline across undo/redo", () => {
		const doc = new VimDocument("abc");
		expect(doc.dirty).toBe(false);
		doc.pushUndo();
		doc.insertText("X");
		expect(doc.dirty).toBe(true);
		// Undo back to the initial content, which is still the saved baseline.
		doc.undo();
		expect(doc.getText()).toBe("abc");
		expect(doc.dirty).toBe(false);
		// Redo away from it: dirty again.
		doc.redo();
		expect(doc.getText()).toBe("Xabc");
		expect(doc.dirty).toBe(true);
	});

	it("markSaved moves the baseline so undo past it is dirty", () => {
		const doc = new VimDocument("abc");
		doc.pushUndo();
		doc.insertText("X");
		doc.markSaved();
		expect(doc.dirty).toBe(false);
		doc.undo();
		expect(doc.getText()).toBe("abc");
		expect(doc.dirty).toBe(true);
		doc.redo();
		expect(doc.getText()).toBe("Xabc");
		expect(doc.dirty).toBe(false);
	});

	it("selects, yanks, and deletes visual ranges", () => {
		const doc = new VimDocument("hello world");
		doc.cursor = { line: 0, col: 6 };
		doc.startVisual();
		doc.lineEnd();
		expect(doc.selectedText()).toBe("world");
		doc.yankSelection();
		doc.cursor = { line: 0, col: 0 };
		doc.pasteAfter();
		expect(doc.getText()).toBe("worldhello world");
	});

	it("deletes multi-line visual selections", () => {
		const doc = new VimDocument("one\ntwo\nthree");
		doc.cursor = { line: 1, col: 0 };
		doc.startVisual();
		doc.moveDown(1);
		doc.lineEnd();
		doc.deleteSelection();
		expect(doc.getText()).toBe("one\n");
		expect(doc.cursor).toEqual({ line: 1, col: 0 });
	});
});

describe("parseSgrMouse", () => {
	it("parses left press", () => {
		expect(parseSgrMouse("\x1b[<0;10;5M")).toEqual({
			kind: "press",
			button: "left",
			x: 10,
			y: 5,
			shift: false,
			ctrl: false,
			alt: false,
			delta: 0,
		});
	});

	it("parses drag with button modifiers", () => {
		const event = parseSgrMouse("\x1b[<34;3;8M");
		expect(event?.kind).toBe("drag");
		expect(event?.button).toBe("right");
		expect(event?.x).toBe(3);
		expect(event?.y).toBe(8);
	});

	it("parses hover motion without buttons", () => {
		const event = parseSgrMouse("\x1b[<35;3;8M");
		expect(event?.kind).toBe("drag");
		expect(event?.button).toBe("none");
	});

	it("parses release", () => {
		const event = parseSgrMouse("\x1b[<0;1;1m");
		expect(event?.kind).toBe("release");
		expect(event?.button).toBe("left");
	});

	it("parses wheel direction", () => {
		expect(parseSgrMouse("\x1b[<64;1;1M")?.delta).toBe(-1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.delta).toBe(1);
	});

	it("parses shift modifier", () => {
		expect(parseSgrMouse("\x1b[<4;2;2M")?.shift).toBe(true);
	});

	it("returns undefined for non-mouse input", () => {
		expect(parseSgrMouse("\x1b[A")).toBeUndefined();
		expect(parseSgrMouse("a")).toBeUndefined();
	});
});
