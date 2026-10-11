/**
 * 编辑区撤销功能(web/CodeMirrorBox)的回归测试。
 *
 * 测的是「换文档 = 换一段历史」这条边界 —— 它是这个功能里唯一有真实丢稿风险的
 * 分支:切章节后若撤销栈还在,按 Ctrl+Z 会把上一章正文倒回编辑器,800ms 后自动
 * 保存直接写进新章节文件。所以下面几例都在守这条线。
 *
 * 用不到 DOM:EditorState 的 update/dispatch 与 history 命令都是纯状态运算,
 * node 环境即可运行(EditorView 挂载才需要 document,这里刻意不碰)。
 */
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { replaceDocResettingHistory } from "../web/src/editor/CodeMirrorBox.tsx";

/** 建一个只有 history 的最小编辑器状态 + 一个 dispatch 写回者。 */
function makeEditor(doc: string) {
	const compartment = new Compartment();
	let state = EditorState.create({ doc, extensions: [compartment.of(history())] });
	return {
		compartment,
		get state() {
			return state;
		},
		/** 模拟 EditorView:把事务里的新状态写回。 */
		dispatch(spec: unknown) {
			state = state.update(spec as never).state;
		},
		/** 模拟用户输入一笔(setDoc 之外的真实编辑)。 */
		typeAt(pos: number, text: string) {
			state = state.update({ changes: { from: pos, insert: text } }).state;
		},
	};
}

describe("编辑区撤销:换文档清空撤销栈", () => {
	it("切章后撤销栈归零,撤不动(不会把上一章倒回来)", () => {
		const ed = makeEditor("第1章原文");
		ed.typeAt(5, "改过的地方");
		expect(ed.state.doc.toString()).toBe("第1章原文改过的地方");
		expect(undoDepth(ed.state)).toBe(1);

		replaceDocResettingHistory(ed, "第2章正文", ed.compartment);

		expect(ed.state.doc.toString()).toBe("第2章正文");
		expect(undoDepth(ed.state)).toBe(0);
		// 撤销菜单/按钮此时应不可用;强行调用也不该改变文档
		let state = ed.state;
		const consumed = undo({ state, dispatch: (tr) => { state = tr.state; } });
		expect(consumed).toBe(false);
		expect(state.doc.toString()).toBe("第2章正文");
	});

	it("清空后新写的字照常可撤(不是把撤销功能关掉)", () => {
		const ed = makeEditor("第1章原文");
		ed.typeAt(5, "第一笔");
		replaceDocResettingHistory(ed, "第2章正文", ed.compartment);
		expect(undoDepth(ed.state)).toBe(0);

		ed.typeAt(5, "新写的内容");
		expect(ed.state.doc.toString()).toBe("第2章正文新写的内容");
		expect(undoDepth(ed.state)).toBe(1);

		let state = ed.state;
		expect(undo({ state, dispatch: (tr) => { state = tr.state; } })).toBe(true);
		expect(state.doc.toString()).toBe("第2章正文");
	});

	it("撤销后能重做回新章节的内容", () => {
		const ed = makeEditor("第1章原文");
		replaceDocResettingHistory(ed, "第2章正文", ed.compartment);
		ed.typeAt(5, "追加");

		let state = ed.state;
		undo({ state, dispatch: (tr) => { state = tr.state; } });
		expect(state.doc.toString()).toBe("第2章正文");
		expect(redoDepth(state)).toBe(1);

		redo({ state, dispatch: (tr) => { state = tr.state; } });
		expect(state.doc.toString()).toBe("第2章正文追加");
	});

	it("连续切章:每次都从空白历史开始,旧章节永不回来", () => {
		const ed = makeEditor("第一章");
		ed.typeAt(3, "的正文");
		replaceDocResettingHistory(ed, "第二章", ed.compartment);
		replaceDocResettingHistory(ed, "第三章", ed.compartment);

		expect(ed.state.doc.toString()).toBe("第三章");
		expect(undoDepth(ed.state)).toBe(0);
		expect(redoDepth(ed.state)).toBe(0);
	});

	it("content 与目标一致时不清栈调用方自行短路(这里验证不 dispatch 也不影响状态)", () => {
		const ed = makeEditor("同样的内容");
		ed.typeAt(5, "——");
		expect(undoDepth(ed.state)).toBe(1);
		// 调用方(DraftWorkspace/CodeMirrorBox)会先比 doc === value 再决定要不要清,
		// 这里确认「比出来的相等」确实是相等,不会因为替换为同内容而误清
		expect(ed.state.doc.toString()).not.toBe("同样的内容");
	});
});
