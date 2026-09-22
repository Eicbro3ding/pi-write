import { describe, expect, it } from "vitest";
import { contentTextOf, initialSessionState, lastUserTurn, messagesToEvents, processAgentEvent, resolveUserMessageEcho } from "../web/src/store.ts";
import { blocksText, blocksThinking, blocksTools, formatDuration, turnDurationMs } from "../web/src/blocks.ts";
import type { ChatMessage } from "../web/src/types.ts";

function ev(message: string, type: string) {
  // 按 AgentSessionEvent 形状构造最小事件
  return JSON.parse(message);
}

/** 消息 → 「块种类」序列(顺序断言用;text 块带内容便于读)。 */
function shape(m: ChatMessage): string[] {
  return m.blocks.map((b) => (b.kind === "tool" ? `tool:${b.call.name}` : `${b.kind}`));
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
    expect(blocksText(s.messages[0].blocks)).toBe("雨从后半夜开始");
  });
  it("tool_execution_start/end 组装工具卡片", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{\\"path\\":\\"a.md\\"}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t1","result":"ok","isError":false}`));
    expect(blocksTools(s.messages[0].blocks)[0]).toMatchObject({ id: "t1", name: "read", isError: false });
  });
  it("重复的 tool_execution_start 不重复建块(SSE 重放幂等)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{}"}`));
    expect(blocksTools(s.messages[0].blocks)).toHaveLength(1);
  });
  it("message_end 标记完成(事件无 id,按序标记最后一条未完成消息)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.messages[0].done).toBe(true);
  });
  it("message_end 携带 assistant usage 时更新 cacheHit", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"assistant","usage":{"input":1000,"output":50,"cacheRead":9000,"cacheWrite":500,"totalTokens":10550}}}`));
    expect(s.cacheHit).toEqual({ rate: 9000 / 10500, promptTokens: 10500, cachedTokens: 9000 });
  });
  it("message_end 无 usage(历史水合)保留原 cacheHit", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":10,"cacheRead":900,"cacheWrite":0,"totalTokens":1010}}}`));
    expect(s.cacheHit).not.toBeNull();
    // 历史水合的成对 message_end(message 为空对象)不清掉已算出的命中
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.cacheHit).not.toBeNull();
  });
  it("provider 未上报缓存字段(cacheRead/cacheWrite 全 0)不产生 cacheHit", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"assistant","usage":{"input":1000,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":1050}}}`));
    expect(s.cacheHit).toBeNull();
  });
  it("message_start 追加 user 消息(事件无 id)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"请续写"}]}}`));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("user");
    expect(blocksText(s.messages[0].blocks)).toBe("请续写");
    expect(blocksThinking(s.messages[0].blocks)).toBe("");
  });
  it("turn_start / agent_settled 维护 isStreaming,不动消息", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    expect(s.isStreaming).toBe(true);
    s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(blocksText(s.messages[0].blocks)).toBe("你好");
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
    expect(blocksThinking(s.messages[0].blocks)).toBe("");
    expect(blocksThinking(s.messages[1].blocks)).toBe("先查设定");
    expect(blocksText(s.messages[1].blocks)).toBe("基于设定,正文开始");
    expect(blocksTools(s.messages[1].blocks)).toHaveLength(1);
    expect(blocksTools(s.messages[1].blocks)[0]).toMatchObject({ id: "t1", name: "world_tree", result: "[...]", isError: false });
    // 工具块落在正文块**之前** —— 真实顺序是「先思考、再调工具、最后写正文」
    expect(shape(s.messages[1])).toEqual(["thinking", "tool:world_tree", "text"]);
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
    expect(blocksText(s.messages[0].blocks)).toBe("第二段");
    // 流式增量仍拼到这条(最后一条未 done)
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"继续"}}`));
    expect(blocksText(s.messages[0].blocks)).toBe("第二段继续");
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.messages[0].done).toBe(true);
  });
  it("同轮多段保持块顺序:思考 → 工具 → 思考 → 工具 → 正文(不再压成三坨)", () => {
    let s = initialSessionState();
    // 第一段:思考 + 工具调用
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"第一轮思考"},{"type":"text","text":"调用"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":"{}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t1","result":"ok","isError":false}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    // 第二段:又一次思考 + 工具
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"第二轮思考"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"t2","toolName":"grep","args":"{}"}`));
    s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"t2","result":"ok","isError":false}`));
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    // 第三段:交付正文
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"第三轮思考"},{"type":"text","text":"正文"}]}}`));
    expect(s.messages).toHaveLength(1);
    expect(shape(s.messages[0])).toEqual([
      "thinking",
      "text",
      "tool:read",
      "thinking",
      "tool:grep",
      "thinking",
      "text",
    ]);
    // 派生值(兼容消费点)仍按序拼接
    expect(blocksThinking(s.messages[0].blocks)).toBe("第一轮思考\n\n第二轮思考\n\n第三轮思考");
    expect(blocksText(s.messages[0].blocks)).toBe("调用\n\n正文");
    expect(blocksTools(s.messages[0].blocks).map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("同一段内 thinking_start/text_start 不产生双空块", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"想"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_start","contentIndex":1}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":2,"id":"t1","toolName":"read"}}`));
    // toolcall_* 不建块(工具块由 tool_execution_start 开)——否则会先冒出一个参数不全的卡
    expect(shape(s.messages[0])).toEqual(["thinking", "text"]);
    expect(blocksThinking(s.messages[0].blocks)).toBe("想");
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
  it("messagesToEvents 把历史转为 message_start/message_end 事件序列,经 reducer 归约与 SSE 一致", () => {
    const events = messagesToEvents([
      { role: "user", text: "你好" },
      { role: "assistant", text: "你好呀" },
    ]);
    expect(events).toEqual([
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
      { type: "message_end", message: {} },
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "你好呀" }] } },
      { type: "message_end", message: {} },
    ]);
    // 走与 SSE 相同的 reducer 路径:user/assistant 历史气泡逐条还原
    let s = initialSessionState();
    for (const e of events) s = processAgentEvent(s, e);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages.map((m) => blocksText(m.blocks))).toEqual(["你好", "你好呀"]);
    // message_end 忠实模拟 SSE(每条消息成对发射;reducer 只标记 assistant 的
    // done——user 的 message_end 被忽略,与真实事件流一致):assistant 历史消息
    // 渲染为完成态(思考块不显示「思考中」计时),user 消息无 done 语义
    expect(s.messages.map((m) => m.done)).toEqual([false, true]);
  });
  it("messagesToEvents 携带 thinking:历史水合后思考链还原", () => {
    let s = initialSessionState();
    for (const e of messagesToEvents([
      { role: "user", text: "写一段" },
      { role: "assistant", text: "正文", thinking: "先想结构……" },
    ])) {
      s = processAgentEvent(s, e);
    }
    expect(blocksText(s.messages[1]!.blocks)).toBe("正文");
    expect(blocksThinking(s.messages[1]!.blocks)).toBe("先想结构……");
    expect(shape(s.messages[1]!)).toEqual(["thinking", "text"]);
    // 无 thinking 的 assistant 消息不产生 thinking 块
    expect(blocksThinking(s.messages[0]!.blocks)).toBe("");
  });
  it("messagesToEvents 空历史返回空事件序列", () => {
    expect(messagesToEvents([])).toEqual([]);
  });
  it("messagesToEvents 透传有序 content 与回合起止时间(刷新后工具块与耗时都在)", () => {
    const content = [
      { type: "thinking", text: "先查" },
      { type: "text", text: "查一下" },
      { type: "toolCall", id: "t1", name: "read", arguments: '{"path":"a.md"}', result: "文件内容", isError: false },
      { type: "thinking", text: "再看" },
      { type: "toolCall", id: "t2", name: "grep", arguments: "{}", result: "没找到", isError: true },
      { type: "text", text: "结论" },
    ];
    const events = messagesToEvents([
      { role: "user", text: "查设定" },
      { role: "assistant", text: "查一下\n\n结论", content, id: "e2", startedAt: 1000, endedAt: 9000 },
    ]);
    // content 原样进 message_start;不再退回「thinking + text」两条
    const start = events[2] as Extract<(typeof events)[number], { type: "message_start" }>;
    expect(start.message.content).toBe(content);
    expect(start.startedAt).toBe(1000);
    expect(start.endedAt).toBe(9000);
    // 归约后:顺序、工具结果、回合耗时三者都在
    let s = initialSessionState();
    for (const e of events) s = processAgentEvent(s, e);
    expect(shape(s.messages[1]!)).toEqual(["thinking", "text", "tool:read", "thinking", "tool:grep", "text"]);
    const tools = blocksTools(s.messages[1]!.blocks);
    expect(tools[0]).toMatchObject({ id: "t1", result: "文件内容", isError: false });
    expect(tools[1]).toMatchObject({ id: "t2", result: "没找到", isError: true });
    expect(turnDurationMs(s.messages[1]!)).toBe(8000);
  });
  it("messagesToEvents:缺 content 的旧形状退回 text/thinking 投影", () => {
    let s = initialSessionState();
    for (const e of messagesToEvents([{ role: "assistant", text: "正文", thinking: "想" }])) s = processAgentEvent(s, e);
    expect(shape(s.messages[0]!)).toEqual(["thinking", "text"]);
  });
});

describe("回合计时(已工作 X 分 Y 秒)", () => {
  it("turn_start 落起点,agent_settled 落终点", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"写"}]}}`));
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    const started = s.turnStartedAt;
    expect(started).toBeTypeOf("number");
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    // 计时起点继承本轮 turn_start,而不是 assistant 首 token 到达时刻
    expect(s.messages[1]!.startedAt).toBe(started);
    s = processAgentEvent(s, ev(`{"type":"message_end","message":{}}`));
    expect(s.messages[1]!.endedAt).toBeUndefined(); // 未 settled 不落终点
    s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
    expect(s.messages[1]!.endedAt).toBeTypeOf("number");
    expect(turnDurationMs(s.messages[1]!)).toBeGreaterThanOrEqual(0);
    expect(formatDuration(turnDurationMs(s.messages[1]!)!)).toMatch(/秒/);
  });
  it("多轮工具调用:后续 turn_start 不重开表(保留首轮起点)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    const first = s.turnStartedAt;
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    // 工具轮次的后续 turn(仍在流式中)
    s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
    expect(s.turnStartedAt).toBe(first);
  });
  it("历史水合气泡无起点 → 不显示时长", () => {
    let s = initialSessionState();
    for (const e of messagesToEvents([{ role: "assistant", text: "旧正文" }])) s = processAgentEvent(s, e);
    expect(turnDurationMs(s.messages[0]!)).toBeNull();
  });
  it("formatDuration:秒 / 分秒,不足 1 秒按 1 秒", () => {
    expect(formatDuration(18_000)).toBe("18 秒");
    expect(formatDuration(173_000)).toBe("2 分 53 秒");
    expect(formatDuration(0)).toBe("1 秒");
    expect(formatDuration(60_000)).toBe("1 分 0 秒");
  });
});

describe("thinking 折叠块数据", () => {
  it("message_start 提取 content 中的 thinking 块", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","text":"先查设定再动笔"},{"type":"text","text":"正文开始"}]}}`));
    expect(blocksText(s.messages[0].blocks)).toBe("正文开始");
    expect(blocksThinking(s.messages[0].blocks)).toBe("先查设定再动笔");
  });
  it("落盘形态的 thinking 块用 thinking 字段(兜底 text)", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","thinking":"盘上形态"}]}}`));
    expect(blocksThinking(s.messages[0].blocks)).toBe("盘上形态");
  });
  it("thinking_delta 拼到最后一条未 done 的 assistant 的 thinking", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"推演"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"中"}}`));
    s = processAgentEvent(s, ev(`{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"正文"}}`));
    expect(blocksThinking(s.messages[0].blocks)).toBe("推演中");
    expect(blocksText(s.messages[0].blocks)).toBe("正文");
  });
  it("user 消息 thinking 恒为空", () => {
    let s = initialSessionState();
    s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"thinking","text":"x"}]}}`));
    expect(blocksThinking(s.messages[0].blocks)).toBe("");
    expect(blocksText(s.messages[0].blocks)).toBe("");
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

describe("外部命令的流式输出(tool_execution_update)", () => {
	function bootWithBashCard() {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"assistant","content":[]}}`));
		s = processAgentEvent(s, ev(`{"type":"tool_execution_start","toolCallId":"b1","toolName":"bash","args":"{\\"command\\":\\"ls -la\\"}"}`));
		return s;
	}

	it("update 把快照写进卡片(快照整段替换,不是增量)", () => {
		let s = bootWithBashCard();
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"总用量 4"}]}}`));
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"总用量 4\\ndrwxr-xr-x draft"}]}}`));
		expect(blocksTools(s.messages[0].blocks)[0].stream).toBe("总用量 4\ndrwxr-xr-x draft");
		// 未结束:结果仍为 null
		expect(blocksTools(s.messages[0].blocks)[0].result).toBeNull();
	});

	it("空内容快照(命令开跑的信号)不清掉已有输出", () => {
		let s = bootWithBashCard();
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"一段输出"}]}}`));
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":{"content":[]}}`));
		expect(blocksTools(s.messages[0].blocks)[0].stream).toBe("一段输出");
	});

	it("结束:以最终结果为准,丢掉流式快照", () => {
		let s = bootWithBashCard();
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"运行中输出"}]}}`));
		s = processAgentEvent(s, ev(`{"type":"tool_execution_end","toolCallId":"b1","result":"最终输出","isError":false}`));
		expect(blocksTools(s.messages[0].blocks)[0]).toMatchObject({ result: "最终输出", stream: null, isError: false });
	});

	it("字符串形式的 partial 也能吃(防御异构实现)", () => {
		let s = bootWithBashCard();
		s = processAgentEvent(s, ev(`{"type":"tool_execution_update","toolCallId":"b1","toolName":"bash","partialResult":"直接给文本"}`));
		expect(blocksTools(s.messages[0].blocks)[0].stream).toBe("直接给文本");
	});
});

describe("chat_error(需求 1:错误原文照实显示)", () => {
	const RAW = "401 Invalid API key: the API key provided is invalid or has been revoked.";

	it("落成对话流里的一条 role=error 消息(原文逐字保留)", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"续写"}]}}`));
		s = processAgentEvent(s, { type: "chat_error", message: RAW });
		expect(s.messages).toHaveLength(2);
		const m = s.messages[1]!;
		expect(m.role).toBe("error");
		expect(m.done).toBe(true);
		expect(m.blocks).toEqual([]);
		expect(m.error?.raw).toBe(RAW);
		expect(m.error?.title).toBe("API key 无效");
		expect(m.error?.code).toBe(401);
	});

	it("位置就在失败那一轮之后,不覆盖前面的会话内容", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"续写"}]}}`));
		const before = s.messages;
		s = processAgentEvent(s, { type: "chat_error", message: RAW });
		expect(s.messages.slice(0, 1)).toEqual(before);
	});

	it("不动流式标记(回合收尾归 agent_settled 管)", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(`{"type":"turn_start"}`));
		expect(s.isStreaming).toBe(true);
		s = processAgentEvent(s, { type: "chat_error", message: RAW });
		expect(s.isStreaming).toBe(true);
	});

	it("连错两次就是两张卡(每次都照实留)", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, { type: "chat_error", message: "429 rate limit exceeded" });
		s = processAgentEvent(s, { type: "chat_error", message: RAW });
		expect(s.messages.map((m) => m.error?.title)).toEqual(["请求过于频繁", "API key 无效"]);
	});
});

describe("provider 侧报错(stopReason=error,不抛异常也不广播 chat_error)", () => {
	/** 实测 deepseek 401 的形状:errorMessage 挂在 assistant 消息上,provider/model 同带。 */
	const ERR_START = `{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"deepseek","model":"deepseek-v4-pro","stopReason":"error","errorMessage":"401: {\\"message\\":\\"Authentication Fails, Your api key: ****test is invalid\\"}"}}`;

	it("第一个事件(空 content + errorMessage)就落成报错卡,不留空气泡", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"续写"}]}}`));
		s = processAgentEvent(s, ev(ERR_START));
		expect(s.messages).toHaveLength(2);
		const m = s.messages[1]!;
		expect(m.role).toBe("error");
		expect(m.blocks).toEqual([]);
		expect(m.error?.title).toBe("API key 无效");
		expect(m.error?.code).toBe(401);
		// 原文框下面那行:provider/model 来自消息本身
		expect(m.error?.meta).toBe("provider: deepseek · model: deepseek-v4-pro");
		expect(m.error?.raw).toContain("Authentication Fails");
	});

	it("随后成对到达的 message_end / agent_settled 不会再补一张卡", () => {
		let s = initialSessionState();
		s = processAgentEvent(s, ev(ERR_START));
		s = processAgentEvent(s, ev(`{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error"}}`));
		s = processAgentEvent(s, ev(`{"type":"agent_settled"}`));
		expect(s.messages.filter((m) => m.role === "error")).toHaveLength(1);
		expect(s.isStreaming).toBe(false);
	});

	it("水合把 errorMessage 还原成同一张卡(刷新后报错不丢)", () => {
		const events = messagesToEvents([
			{ role: "user", text: "续写", id: "u1" },
			{ role: "assistant", text: "", id: "a1", errorMessage: "401 nope", provider: "deepseek", model: "deepseek-v4-pro" },
		]);
		let s = initialSessionState();
		for (const e of events) s = processAgentEvent(s, e);
		expect(s.messages.map((m) => m.role)).toEqual(["user", "error"]);
		expect(s.messages[1]!.error?.meta).toBe("provider: deepseek · model: deepseek-v4-pro");
		// 报错记录没有正文,不该变成一个空的 assistant 气泡
		expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
	});
});

describe("lastUserTurn(报错卡「重试」定位要重放的那一轮)", () => {
	function user(text: string): ChatMessage {
		return { id: `u-${text}`, role: "user", blocks: [{ kind: "text", text }], done: true };
	}
	function assistant(text: string): ChatMessage {
		return { id: `a-${text}`, role: "assistant", blocks: [{ kind: "text", text }], done: true };
	}
	function error(raw: string): ChatMessage {
		return {
			id: `e-${raw}`,
			role: "error",
			blocks: [],
			done: true,
			error: { raw, title: "模型返回错误", code: null, kind: "other", hint: null, meta: null },
		};
	}

	it("跳过报错消息(否则永远只看到报错卡,重试按钮是死的)", () => {
		expect(lastUserTurn([user("续写"), error("502")])?.id).toBe("u-续写");
		expect(lastUserTurn([user("续写"), error("502"), error("503")])?.id).toBe("u-续写");
	});
	it("最后一条真实消息是 assistant 时返回 null(那一轮不是用户问的,撤回语义不成立)", () => {
		expect(lastUserTurn([user("续写"), assistant("写好了")])).toBeNull();
		expect(lastUserTurn([user("续写"), assistant("写好了"), error("502")])).toBeNull();
	});
	it("空对话返回 null", () => {
		expect(lastUserTurn([])).toBeNull();
		expect(lastUserTurn([error("502")])).toBeNull();
	});
});
