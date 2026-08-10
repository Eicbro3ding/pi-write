import { describe, expect, it } from "vitest";
import { contentTextOf, initialSessionState, messagesToEvents, processAgentEvent, resolveUserMessageEcho } from "../web/src/store.ts";

function ev(message: string, type: string) {
  // 按 AgentSessionEvent 形状构造最小事件
  return JSON.parse(message);
}

describe("processAgentEvent", () => {
  it("message_start 追加 assistant 消息(事件无 id)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("assistant");
    expect(s.messages[0].done).toBe(false);
  });
  it("message_update 的 text_delta 追加文本(事件无 id,按序拼到最后一条未完成消息)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":""}]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"雨从"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"后半夜开始"}}`));
    expect(s.messages[0].text).toBe("雨从后半夜开始");
  });
  it("tool_execution_start/end 组装工具卡片", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{\\"path\\":\\"a.md\\"}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t1","result":"ok","isError":false}`));
    expect(s.messages[0].toolCalls[0]).toMatchObject({ id: "t1", name: "read", isError: false });
  });
  it("message_end 标记完成(事件无 id,按序标记最后一条未完成消息)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.messages[0].done).toBe(true);
  });
  it("message_start 追加 user 消息(事件无 id)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"请续写"}]}}`));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("user");
    expect(s.messages[0].text).toBe("请续写");
    expect(s.messages[0].thinking).toBe("");
  });
  it("turn_start / agent_settled 维护 isStreaming,不动消息", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    expect(s.isStreaming).toBe(true);
    s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toBe("你好");
  });
  it("compaction_start/end 维护 compacting 标记(独立于 isStreaming)", () => {
    let s = initialSessionState();
    expect(s.compacting).toBe(false);
    s = processAgentEvent(s, ev(`{"type":"compaction_start","reason":"threshold"}`));
    expect(s.compacting).toBe(true);
    expect(s.isStreaming).toBe(false); // 压缩可发生在回合之间,不影响流式标记
    s = processAgentEvent(s, ev(`{"type":"compaction_end","reason":"threshold"}`));
    expect(s.compacting).toBe(false);
    // 流式回合内的压缩:compacting 与 isStreaming 并存
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    s = processAgentEvent(s, ev(`{"type":"compaction_start","reason":"overflow"}`));
    expect(s.compacting).toBe(true);
    expect(s.isStreaming).toBe(true);
    s = processAgentEvent(s, ev(`{"type":"compaction_end","reason":"overflow"}`));
    s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
    expect(s.compacting).toBe(false);
    expect(s.isStreaming).toBe(false);
  });
  it("完整事件顺序:用户消息 → thinking_delta → text_delta → 工具执行 → message_end → agent_settled", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"查设定"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"先查"},{"type":"text","text":""}]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"设定"}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"world_tree","args":"{}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t1","result":"[...]","isError":false}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"基于设定,"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"正文开始"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[0].thinking).toBe("");
    expect(s.messages[1].thinking).toBe("先查设定");
    expect(s.messages[1].text).toBe("基于设定,正文开始");
    expect(s.messages[1].toolCalls).toHaveLength(1);
    expect(s.messages[1].toolCalls[0]).toMatchObject({ id: "t1", name: "world_tree", result: "[...]", isError: false });
    expect(s.messages[1].done).toBe(true);
    expect(s.isStreaming).toBe(false);
  });
  it("role=toolResult 的 message_start 不追加消息", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"toolResult","toolCallId":"t1","content":[]}}`));
    expect(s.messages).toHaveLength(0);
    // toolResult 的 message_end 同样不产生任何状态变化
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"toolResult","toolCallId":"t1"}}`));
    expect(s.messages).toHaveLength(0);
  });
  it("同轮第二条 assistant 消息合并进上一条(整轮一条气泡),text_delta 继续拼接", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    // 工具轮次后的第二条 assistant 消息:合并,不新建气泡
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"第二段"}]}}`));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].done).toBe(false); // 合并后继续流式,等本段 message_end 再置 done
    expect(s.messages[0].text).toBe("第二段");
    // 流式增量仍拼到这条(最后一条未 done)
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"继续"}}`));
    expect(s.messages[0].text).toBe("第二段继续");
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.messages[0].done).toBe(true);
  });
  it("同轮合并保留 thinking 与工具卡片(空行分隔拼接)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"第一轮思考"},{"type":"text","text":"调用"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t1","result":"ok","isError":false}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"第二轮思考"},{"type":"text","text":"正文"}]}}`));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].thinking).toBe("第一轮思考\n\n第二轮思考");
    expect(s.messages[0].text).toBe("调用\n\n正文");
    expect(s.messages[0].toolCalls).toHaveLength(1);
  });
  it("新轮次(user 消息之后)的 assistant 消息新建气泡", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"再问"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages).toHaveLength(2);
  });
  it("message_end 带 entryId 时附加到该角色消息(撤回定位依据)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}`));
    const tempId = s.messages[0]!.id;
    expect(s.messages[0]!.entryId).toBeUndefined();
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"user"},"entryId":"entry-abc"}`));
    expect(s.messages[0]!.entryId).toBe("entry-abc");
    // id(React key)保持临时值不替换:key 变化会重挂载消息组件(丢失折叠/计时状态)
    expect(s.messages[0]!.id).toBe(tempId);
    // 已带 entryId 的历史消息不被重复替换
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"历史"}]},"entryId":"entry-hist"}`));
    expect(s.messages[1]!.id).toBe("entry-hist");
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"user"},"entryId":"entry-hist"}`));
    expect(s.messages[1]!.entryId).toBe("entry-hist");
    expect(s.messages[0]!.entryId).toBe("entry-abc"); // 旧消息不受影响
  });
  it("messagesToEvents 把历史转为 message_start 事件序列,经 reducer 归约与 SSE 一致", () => {
    const events = messagesToEvents([
      { role: "user", text: "你好" },
      { role: "assistant", text: "你好呀" },
    ]);
    expect(events).toEqual([
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "你好呀" }] } },
    ]);
    // 走与 SSE 相同的 reducer 路径:user/assistant 历史气泡逐条还原
    let s = initialSessionState();
    for (const e of events) s = processAgentEvent(s, e);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages.map((m) => m.text)).toEqual(["你好", "你好呀"]);
    // 历史消息 done 恒 false(不做 message_end),不影响渲染
    expect(s.messages.every((m) => m.done === false)).toBe(true);
  });
  it("messagesToEvents 携带 thinking:历史水合后思考链还原", () => {
    let s = initialSessionState();
    for (const e of messagesToEvents([
      { role: "user", text: "写一段" },
      { role: "assistant", text: "正文", thinking: "先想结构……" },
    ])) {
      s = processAgentEvent(s, e);
    }
    expect(s.messages[1]!.text).toBe("正文");
    expect(s.messages[1]!.thinking).toBe("先想结构……");
    // 无 thinking 的 assistant 消息不产生 thinking 块
    expect(s.messages[0]!.thinking).toBe("");
  });
  it("messagesToEvents 空历史返回空事件序列", () => {
    expect(messagesToEvents([])).toEqual([]);
  });
});
describe("thinking 折叠块数据", () => {
  it("message_start 提取 content 中的 thinking 块", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"先查设定再动笔"},{"type":"text","text":"正文开始"}]}}`));
    expect(s.messages[0].text).toBe("正文开始");
    expect(s.messages[0].thinking).toBe("先查设定再动笔");
  });
  it("thinking_delta 拼到最后一条未 done 的 assistant 的 thinking", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"推演"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"中"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"正文"}}`));
    expect(s.messages[0].thinking).toBe("推演中");
    expect(s.messages[0].text).toBe("正文");
  });
  it("user 消息 thinking 恒为空", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"thinking","text":"x"}]}}`));
    expect(s.messages[0].thinking).toBe("");
    expect(s.messages[0].text).toBe("");
  });
});
describe("resolveUserMessageEcho(多浏览器乐观气泡去重)", () => {
  it("队头匹配:视为自己的回显,跳过渲染并出队", () => {
    const out = resolveUserMessageEcho(["你好"], "你好");
    expect(out.render).toBe(false);
    expect(out.pending).toEqual([]);
  });
  it("不匹配:渲染(其他浏览器发来的消息),队列保持不变", () => {
    const out = resolveUserMessageEcho(["你好"], "请续写");
    expect(out.render).toBe(true);
    expect(out.pending).toEqual(["你好"]);
  });
  it("空队列:渲染,队列仍为空", () => {
    const out = resolveUserMessageEcho([], "你好");
    expect(out.render).toBe(true);
    expect(out.pending).toEqual([]);
  });
  it("FIFO 配对:两条相同文本的气泡按发送顺序各自确认", () => {
    let pending = ["好的", "好的"];
    const first = resolveUserMessageEcho(pending, "好的");
    expect(first.render).toBe(false);
    const second = resolveUserMessageEcho(first.pending, "好的");
    expect(second.render).toBe(false);
    expect(second.pending).toEqual([]);
  });
  it("不影响原数组(纯函数)", () => {
    const pending = ["你好"];
    resolveUserMessageEcho(pending, "你好");
    expect(pending).toEqual(["你好"]);
  });
});
describe("contentTextOf", () => {
  it("字符串 content 原样返回", () => {
    expect(contentTextOf("直接文本")).toBe("直接文本");
  });
  it("block 数组只取 text 块(跳过 thinking)", () => {
    const content = [
      { type: "thinking", text: "推演" },
      { type: "text", text: "正文" },
    ];
    expect(contentTextOf(content)).toBe("正文");
  });
  it("非 string/数组返回空串", () => {
    expect(contentTextOf(undefined)).toBe("");
    expect(contentTextOf(42)).toBe("");
  });
});
