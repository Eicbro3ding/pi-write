import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOOL_DONE,
	DEFAULT_TOOL_STATUS,
	TOOL_DONE,
	TOOL_FAIL,
	TOOL_STATUS,
	toolActionRow,
	toolIcon,
	toolObject,
} from "../web/src/tool-status.ts";

describe("TOOL_STATUS(工具名 → 中文进行时文案)", () => {
  it("覆盖 web 工具集全部工具", () => {
    for (const tool of ["read", "write", "edit", "grep", "find", "ls", "word_count", "world_update", "world_find"]) {
      expect(TOOL_STATUS[tool]).toBeTruthy();
    }
  });
  it("未知工具回退通用文案", () => {
    expect(TOOL_STATUS["bash"]).toBeUndefined();
    expect(DEFAULT_TOOL_STATUS).toBe("正在调用工具");
  });
  it("完成文案齐全,未知工具回退通用完成文案", () => {
    expect(TOOL_DONE.read).toBe("已阅读");
    expect(TOOL_DONE.edit).toBe("已编辑");
    expect(TOOL_DONE.world_update).toBe("已更新世界书");
    expect(DEFAULT_TOOL_DONE).toBe("已调用");
  });
});

describe("工具动作流(03-组件规范/05:带宾语、完成的行留在流水里、不用 emoji)", () => {
  it("单个工具 → 动作行(进行中/已完成两态)", () => {
    const running = toolActionRow({ name: "edit", args: '{"path":"draft/ch01.md"}', result: null, isError: false });
    expect(running).toMatchObject({ verb: "正在编辑", object: "draft/ch01.md", running: true, icon: "edit" });
    const done = toolActionRow({ name: "edit", args: '{"path":"draft/ch01.md"}', result: "ok", isError: false });
    expect(done).toMatchObject({ verb: "已编辑", object: "draft/ch01.md", running: false });
  });

  it("宾语优先 path,其次查询类字段,JSON 取不到字段时宁可不显示", () => {
    expect(toolObject('{"path":"draft/ch01.md","content":"x"}')).toBe("draft/ch01.md");
    expect(toolObject('{"pattern":"打油","path":"draft/"}')).toBe("draft/");
    expect(toolObject('{"pattern":"打油"}')).toBe("打油");
    expect(toolObject('{"query":"深海鱼骨"}')).toBe("深海鱼骨");
    expect(toolObject('{"unknownKey":1}')).toBe("");
    expect(toolObject("")).toBe("");
    // 裸参(非 JSON):取首行
    expect(toolObject("git log --oneline -5")).toBe("git log --oneline -5");
  });

  it("失败行给失败动词(设计稿 V1 示例:✕ 写入失败 notes/city.md)", () => {
    expect(TOOL_FAIL.write).toBe("写入失败");
    expect(TOOL_FAIL.read).toBe("读取失败");
    const failed = toolActionRow({ name: "write", args: '{"path":"notes/city.md"}', result: "", isError: true });
    expect(failed).toMatchObject({ verb: "写入失败", object: "notes/city.md", running: false, isError: true });
    // 失败优先于「进行中」:isError 且尚无结果时也不显示「正在编辑」
    const failedNoResult = toolActionRow({ name: "edit", args: '{"path":"a.md"}', result: null, isError: true });
    expect(failedNoResult.verb).toBe("写入失败");
    expect(failedNoResult.running).toBe(false);
    expect(toolActionRow({ name: "mystery", args: "", result: "", isError: true }).verb).toBe("调用失败");
  });

  it("图标族按工具名分派", () => {
    expect(toolIcon("read")).toBe("read");
    expect(toolIcon("write")).toBe("edit");
    expect(toolIcon("grep")).toBe("search");
    expect(toolIcon("ls")).toBe("find");
    expect(toolIcon("word_count")).toBe("count");
    expect(toolIcon("world_update")).toBe("world");
    expect(toolIcon("bash")).toBe("other");
  });
});
