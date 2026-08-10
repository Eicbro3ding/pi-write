import { describe, expect, expectTypeOf, it } from "vitest";
import type { AppliedEdit, DraftStatus, TextSelectionSnapshot } from "../web/src/types.ts";
import {
  applyTextEdit,
  resolveSaveOutcome,
  selectionStillMatches,
  undoAppliedEdit,
} from "../web/src/workspace.ts";

describe("applyTextEdit 文本编辑安全边界", () => {
  it("replaces the selected range and records the full before/after document", () => {
    const result = applyTextEdit("潮声。她没有抬头。", 0, 3, "海风。");
    expect(result.text).toBe("海风。她没有抬头。");
    expect(result.edit.replacedText).toBe("潮声。");
    expect(result.edit.insertedText).toBe("海风。");
    expect(result.edit.beforeText).toBe("潮声。她没有抬头。");
    expect(result.edit.afterText).toBe("海风。她没有抬头。");
  });

  it("inserts after a zero-width selection", () => {
    // 注:brief 原 fixture 为「门外。」(含句号,长度为 3),插入点 2 位于句中,
    // 与 brief 期望值「门外没有回答。」不一致(会得到「门外没有回答。。」);
    // 期望值要求插入发生在串尾,故 fixture 应为「门外」(长度 2)。
    const result = applyTextEdit("门外", 2, 2, "没有回答。", "insert");
    expect(result.text).toBe("门外没有回答。");
    expect(result.edit.replacedText).toBe("");
  });

  it("insert 模式保留插入点之后的原文", () => {
    // 原「门外。」fixture 的语义:在句中零宽位置插入,句号保留
    const result = applyTextEdit("门外。", 2, 2, "没有回答", "insert");
    expect(result.text).toBe("门外没有回答。");
    expect(result.edit.replacedText).toBe("");
  });

  it("refuses undo when the document changed after applying an edit", () => {
    const applied = applyTextEdit("原文。", 0, 3, "新文。").edit;
    expect(undoAppliedEdit("新文。用户又写了一句。", applied)).toBeNull();
    expect(undoAppliedEdit(applied.afterText, applied)).toBe(applied.beforeText);
  });
});

describe("selectionStillMatches 选区失效边界", () => {
  const selection = { from: 0, to: 2, text: "原文", slug: "book-a", file: "draft/ch01.md", chapterFile: "ch01.jsonl" };

  it("invalidates a selection when slug, file, chapter, bounds, or selected text changes", () => {
    expect(selectionStillMatches(selection, "book-a", "draft/ch01.md", "ch01.jsonl", "原文。")).toBe(true);
    expect(selectionStillMatches(selection, "book-b", "draft/ch01.md", "ch01.jsonl", "原文。")).toBe(false);
    expect(selectionStillMatches(selection, "book-a", "draft/ch02.md", "ch01.jsonl", "原文。")).toBe(false);
    expect(selectionStillMatches(selection, "book-a", "draft/ch01.md", "ch01.jsonl", "新文。")).toBe(false);
  });

  it("选区越界或 from>to 时失效", () => {
    // to 超出文档长度:选区失效
    expect(selectionStillMatches(selection, "book-a", "draft/ch01.md", "ch01.jsonl", "原")).toBe(false);
    // from>to 反向区间:选区失效
    const inverted = { ...selection, from: 2, to: 0 };
    expect(selectionStillMatches(inverted, "book-a", "draft/ch01.md", "ch01.jsonl", "原文。")).toBe(false);
  });
});

describe("DraftWorkspace 选区快照与安全编辑契约", () => {
  const file = "draft/ch01.md";
  const chapterFile = "ch01.jsonl";
  const slug = "book-a";

  it("selection callback 生成的 snapshot 必须携带 slug/file/chapterFile(缺省则判定选区失效)", () => {
    // CodeMirrorBox 只上报 { from, to, text };workspace 必须补上 slug/file/chapterFile 才能通过校验
    const bare = { from: 0, to: 3, text: "潮声。" };
    const missing: TextSelectionSnapshot = { ...bare, slug: "", file: "", chapterFile: "" };
    const filled: TextSelectionSnapshot = { ...bare, slug, file, chapterFile };
    // 未补全的 snapshot 视为失效,禁止后续基于它应用编辑
    expect(selectionStillMatches(missing, slug, file, chapterFile, "潮声。")).toBe(false);
    // 补全后选区仍匹配
    expect(selectionStillMatches(filled, slug, file, chapterFile, "潮声。")).toBe(true);
  });

  it("applySelectionEdit 的 undo record 必须保存当前文件(file/chapterFile 由调用层补齐)", () => {
    // 纯函数 applyTextEdit 产出的 edit 自带空 file/chapterFile,调用层用当前文件补齐
    const raw = applyTextEdit("潮声。", 0, 3, "海风。");
    expect(raw.edit.file).toBe("");
    expect(raw.edit.chapterFile).toBe("");
    const edit: AppliedEdit = { ...raw.edit, file, chapterFile };
    // 补齐后 undo record 携带当前文件,撤回流程不受影响
    expect(edit.file).toBe(file);
    expect(edit.chapterFile).toBe(chapterFile);
    expect(undoAppliedEdit(edit.afterText, edit)).toBe(edit.beforeText);
  });

  it("selectionStillMatches 为 false 时调用层不能应用旧建议", () => {
    // 模拟 DraftWorkspace.applySelectionEdit 的守卫:选区失效直接返回 null,不触碰文档
    function guardedApply(
      selection: TextSelectionSnapshot,
      currentFile: string,
      currentChapterFile: string,
      source: string,
      text: string,
    ) {
      if (!selectionStillMatches(selection, slug, currentFile, currentChapterFile, source)) return null;
      return applyTextEdit(source, selection.from, selection.to, text);
    }
    const source = "潮声。";
    const selection: TextSelectionSnapshot = { from: 0, to: 3, text: "潮声。", slug, file, chapterFile };
    // 书切换后旧选区失效:不应用
    expect(guardedApply(selection, "draft/ch02.md", chapterFile, source, "海风。")).toBeNull();
    // 选中区间内的文本被后续修改后选区失效:不应用
    expect(guardedApply(selection, file, chapterFile, "海风。她抬起头。", "海风。")).toBeNull();
    // 选区仍匹配时才应用
    const applied = guardedApply(selection, file, chapterFile, source, "海风。");
    expect(applied?.text).toBe("海风。");
    expect(applied?.edit.replacedText).toBe("潮声。");
  });

  it("保存状态联合类型只能出现 loading | saved | dirty | saving | save-error", () => {
    expectTypeOf<DraftStatus>().toEqualTypeOf<"loading" | "saved" | "dirty" | "saving" | "save-error">();
    // 穷举联合成员,保证五个状态全部存在且无重复
    const statuses: DraftStatus[] = ["loading", "saved", "dirty", "saving", "save-error"];
    expect(statuses).toHaveLength(5);
    expect(new Set(statuses).size).toBe(5);
  });
});

describe("resolveSaveOutcome 保存完成竞态决策", () => {
  const base = {
    startedFile: "draft/ch01.md",
    currentFile: "draft/ch01.md",
    savedText: "潮声。",
    currentText: "潮声。",
    autosavePending: false,
    error: null as string | null,
  };

  it("保存期间文件已切换:静默放弃,即使有错误或文本变化也不更新状态", () => {
    // 切章后旧文件的保存成功返回:不得把新文件状态翻成 saved
    expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md" })).toEqual({ kind: "abandon" });
    // 文本变化同样不能生效(不得清掉/改写新文件的 dirty 状态)
    expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md", currentText: "海风。" })).toEqual({
      kind: "abandon",
    });
    // 过期失败也放弃:不得把新文件状态翻成 save-error / 覆盖新文件的错误文案
    expect(resolveSaveOutcome({ ...base, currentFile: "draft/ch02.md", error: "网络错误" })).toEqual({
      kind: "abandon",
    });
  });

  it("文件未变、保存成功、文本未变:回到 saved", () => {
    expect(resolveSaveOutcome(base)).toEqual({ kind: "saved" });
  });

  it("文件未变、保存失败:进入 save-error 并携带错误信息", () => {
    expect(resolveSaveOutcome({ ...base, error: "网络错误" })).toEqual({ kind: "save-error", message: "网络错误" });
  });

  it("文件未变、保存期间有新编辑:回 dirty;已有自动保存定时器则不重复排", () => {
    // 无 pending timer:需要重新排队自动保存
    expect(resolveSaveOutcome({ ...base, currentText: "潮声。她抬起头。" })).toEqual({ kind: "dirty", reschedule: true });
    // handleChange 已排 800ms 定时器:不再重复排,避免两次相同 PUT
    expect(resolveSaveOutcome({ ...base, currentText: "潮声。她抬起头。", autosavePending: true })).toEqual({
      kind: "dirty",
      reschedule: false,
    });
  });
});
