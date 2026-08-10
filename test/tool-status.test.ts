import { describe, expect, it } from "vitest";
import { activeToolName, DEFAULT_TOOL_STATUS, TOOL_STATUS } from "../web/src/tool-status.ts";

/** 最小消息形状:只保留 activeToolName 需要的字段。 */
function msg(role: string, toolCalls: Array<{ name: string; result: string | null; isError: boolean }>) {
  return { role, toolCalls };
}

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
});

describe("activeToolName(当前正在执行的工具)", () => {
  it("最后一条 assistant 消息里 result 为 null 的工具即当前工具", () => {
    const m = [
      msg("user", []),
      msg("assistant", [
        { name: "read", result: "已读", isError: false },
        { name: "write", result: null, isError: false },
      ]),
    ];
    expect(activeToolName(m)).toBe("write");
  });
  it("工具完成后(result 已置)返回 null,回退思考提示", () => {
    const m = [msg("assistant", [{ name: "read", result: "已读", isError: false }])];
    expect(activeToolName(m)).toBeNull();
  });
  it("执行出错的工具不算运行中(isError 且 result 为 null 时不再显示)", () => {
    const m = [msg("assistant", [{ name: "read", result: null, isError: true }])];
    expect(activeToolName(m)).toBeNull();
  });
  it("空消息列表返回 null", () => {
    expect(activeToolName([])).toBeNull();
  });
  it("user 消息的工具调用不参与(工具卡只属于 assistant 轮)", () => {
    const m = [msg("user", [{ name: "read", result: null, isError: false }])];
    expect(activeToolName(m)).toBeNull();
  });
  it("跨消息回看:旧 assistant 消息里的运行中工具在最新消息无工具时仍能检出", () => {
    const m = [
      msg("user", []),
      msg("assistant", [{ name: "grep", result: null, isError: false }]),
      msg("user", []),
      msg("assistant", []),
    ];
    expect(activeToolName(m)).toBe("grep");
  });
});
