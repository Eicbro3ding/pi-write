# pi-writer 架构细节

## vendor 包关系(内部 import 已重写为相对路径)

```
pi-protocol ──> pi-ai ──> pi-agent-core ──> pi-coding-agent ──> pi-tui
                  │              │                  │
                  └── typebox 1.3.7(直接 import "typebox")
```

- `pi-ai`:provider 适配(anthropic/openai/google/bedrock…)、ThinkingLevel、AssistantMessageEventStream、`Tool` 类型、auth(provider 登录/凭据)。
- `pi-agent-core`:agent-loop(streamAssistantResponse)、harness(agent-harness,把 turn 状态喂给 provider)、AgentMessage 类型(无 id!id 在 SessionEntry 层)、AgentToolResult。
- `pi-coding-agent`:AgentSession(prompt/abort/setModel/setThinkingLevel…)、SessionManager(append-only jsonl)、extension 系统(ExtensionAPI.registerTool/registerCommand、ToolDefinition、defineTool)、createAgentSessionFromServices(customTools 注入点)。
- `pi-tui`:InteractiveMode、组件(assistant-message 等)、主题。

**关键 vendor 事实**:
- `AgentMessage` 无 id 字段;id/timestamp/parentId 在落盘后的 `SessionEntry` 上。
- 会话持久化只在 `message_end` 时 `appendMessage`(user/assistant/toolResult 都落盘;custom 走 appendCustomMessageEntry)。
- `SessionManager` 是 append-only:`getEntries()` 全部、`getBranch()` 沿 leaf 链(根→叶)、`getTree()` 全树、`branch(id)` 移动 leaf、`resetLeaf()`、`getEntry(id)` 全局查。**无删除/修改接口**——"撤回/分支"都是移动 leaf 指针。
- 切换上下文:`sm.buildSessionContext()` 从 leaf 链重建消息;`agent.state.messages = ...` 后 AI 下一轮即用新上下文(vendor session tree 导航同款模式)。
- harness 的 system prompt:`_rebuildSystemPrompt` 里只有带 `promptSnippet` 的工具进 "Available tools" 段;word_count/world_update/world_find 靠 prompt.ts 手动描述。

## 会话文件格式

`sessions/<slug>/<file>.jsonl`,每行一个 JSON:
```json
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"<书目录绝对路径>"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```
header 第一行;`getEntries()` 跳过 header。message entry 的 id 是 8 位 hex,前端撤回/分支靠它定位。

## web 前端结构(web/src)

- `api/client.ts` — ApiClient:REST 方法 + `subscribeEvents`(EventSource,onopen 对齐)。
- `store.ts` — `processAgentEvent` 纯 reducer:消息按"user 开新组、同轮 assistant 合并"规则;`message_end` 附加 entryId 替换临时 id;`turn_start`/`agent_settled` 维护 isStreaming。
- `pages/WritePage.tsx` — 装配核心:openBook/selectChapter(applyMessages 水合)、alignWithServer(SSE 对齐)、send(乐观气泡 + FIFO 去重)、retractMessage/editMessage/branchMessage/navigateBranch、分支树 state。
- `pages/WorldPage.tsx` — 世界书条目管理(列表/关系图)、自动保存 800ms 防抖、lastWorldMtimeRef If-Match。
- `pages/SettingsPage.tsx` — 主题/模型/思考级别/提供商(MCP 服务器分组)。
- `components/` — ChapterSidebar(书/章节,重命名/删除/导出)、MessageList(消息 + 操作按钮)、BranchBar(分支切换)、DraftWorkspace(正文编辑器 + mtime 追踪 + 冲突提示)、McpServerList(MCP 表单)、FullScreenEditor。
- `types.ts` — 全部 DTO(SessionState/ChatMessage/AgentEventDto/SessionTreeDto/McpServerInfo…)。

**SSE 事件类型**(前端 AgentEventDto):message_start(message 带 role/content,可选 entryId)/message_update(assistantMessageEvent: text_delta|thinking_delta)/message_end(带 entryId)/tool_execution_start|end/turn_start/agent_settled + 服务端合成:session_changed/world_changed/draft_changed/messages_retracted。

**WritePage 关键约束**:
- SSE 订阅里每个分支处理完要 `dispatch(e)`(除了明确拦截的事件),否则 reducer 状态错(agent_settled 教训)。
- `resetChat()` 清乐观气泡队列 + **清分支树**(防跨书残留);`applyMessages` 成功后 refreshBranchTree。
- 切书/切章走 openBook/selectChapter(applyMessages),SSE 重连走 alignWithServer——两者都要刷新分支树。

## 服务端路由结构(server.ts)

- **路由表驱动(2026-08-10 重构)**:`Route[]` 表(method + 路径段模式,":name" 为参数段)+ `matchRoute` 匹配;40 个端点按域分组为独立 handler(books/session-messages/models-providers/world-draft-cards/mcp/stage)。**顺序敏感**:同方法同段数的条目中,静态段(如 `mcp/raw`)必须先于参数段(`mcp/:name`);匹配时传入去掉 `api` 前缀的 parts(`parts.slice(1)`)。
- 错误体统一 `{ error: { code, message } }`;HttpError(status, code, message)。
- 章节切换走 `enqueueSwitch` 互斥队列(handleSwitchSession:校验→initChapterFile→switchSession→setCurrentChapter→广播→注入背景包→watcher 切书)。
- 背景包:`injectChapterContext(slug, chapterFile)` 读 draft + ensureWorld + 最近 2 条 user 消息 → buildChapterContext → `sendCustomMessage(nextTurn)`。
- 鉴权:回环 Host/Origin/Sec-Fetch-Site 守卫;可选 `PI_WRITER_TOKEN`(Android)。
- multipart 解析用 **busboy**(2026-08-10 替换手写 boundary 切分;busboy 1.x 是函数调用 `busboy({ headers, limits })`,非 `new`)。
- MCP 端点(POST/PUT 后):`handleMcpReload()` = reloadRuntime + 重新注入背景包 + 广播 session_changed。
