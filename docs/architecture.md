# pi-writer 架构总览

面向开发者的模块职责、数据流与关键机制说明。运行 / 构建细节见 [development.md](development.md),安全模型见 [security.md](security.md),设计决策见 [design.md](design.md)。

## 1. 顶层结构

| 路径 | 职责 |
|------|------|
| `src/cli.ts` | CLI 入口:TUI / print / web / stage 分支、参数解析 |
| `src/session-factory.ts` | **会话装配唯一入口**:cli / web / stage 三处共用样板(路径基准注入、工具守卫、隐藏 skill 命令、模型解析、工具集) |
| `src/config.ts` | 路径解析(getWriterDir / getBooksDir)、slugify(保留 CJK)、`resolveSkillsDir` 三态探测 |
| `src/web.ts` | web 子命令装配:`parseWebArgs` / `startWebServer` |
| `src/web/server.ts` | `WriterServer`:Node 原生 http,**路由表驱动**(method + 路径段模式)+ SSE 事件流 + 静态服务 |
| `src/web/session-host.ts` | `SessionHost`:agent 会话 headless 封装(事件扇出、prompt/abort、撤回/分支/导航/树) |
| `src/web/writer-host.ts` | 常驻编剧会话(每书每章一个;收幕成文与编辑页「编剧」标签同一份记忆) |
| `src/web/stage-host.ts` | 舞台区 web 宿主(每书每章一个编排器,惰性创建) |
| `src/web/file-watcher.ts` | `WorldWatcher`:world.json / draft 外部变更轮询(无缝同步) |
| `src/book-manager.ts` | book / chapter 文件系统层 |
| `src/world-data.ts` | `world.json` 唯一真相源:校验 / 规范化 / 原子写 / md 视图导出;`WORLD_FILES` 文件布局表 |
| `src/world-context.ts` | 上下文注入:背景包组装、激活引擎(关键词 + 关联激活)、记忆裁剪 |
| `src/tools.ts` | 自定义工具:`world_update`(唯一变更通道)/ `world_find` / `word_count` |
| `src/mcp/` | MCP 配置(typebox 校验)/ 连接管理 / 工具适配 |
| `src/stage/` | 舞台多 Agent 共演:orchestrator / assembler / script-store / stage-store / cast / stage-extension |
| `vendor/` | pi 核心包源码(内部 import 已重写为相对路径,零 `@earendil-works` npm 依赖) |
| `web/` | React 前端(vite):舞台 / 编辑 / 世界书 / 设置四页 |
| `electron/` | Electron 壳(进程内起服务 + 窗口,关窗停服退出) |
| `skills/` | 打包的写作技能:outline / critique / revise / stage-scripting |

## 2. 数据模型

```
~/.pi/writer/
├── agent/                     # 认证、模型、设置、MCP 配置(独立于 Pi coding-agent)
├── books/<slug>/
│   ├── book.json              # 书/章节索引
│   ├── world.json             # 世界书(单一真相源)
│   ├── memory.md              # 跨章记忆(~1500 token)
│   ├── draft/<chapter>.md     # 草稿
│   ├── .writer/*.md           # world.json 导出视图(只读,编辑走界面)
│   └── stage/*.jsonl          # 舞台转录(每幕一个文件)
└── sessions/<slug>/<chapter>.jsonl   # 章节会话转录(append-only)
```

- 会话文件:条目有 `id` / `parentId` / `timestamp`;`branch()` / `resetLeaf()` 移动 leaf 指针决定当前分支;分支位置只在内存,不落盘。
- 世界书:类型化条目(character / world / timeline / outline)+ 关系网 + 约束 + 采样 + Notice + 发展线 + 时间线 + 世界观概述(`worldSummary`)。

## 3. 会话与事件链

```
agent 会话事件(pi vendor AgentSessionEvent)
  → session-host 转发(message_end 附加 entryId)
  → server broadcast()
  → SSE(data: <json>)
  → 前端 store reducer(processAgentEvent)
```

- 舞台 / 编剧事件经同一 `/api/events` 管道:`stage_entry` / `stage_director_text` / `writer_event`(内层是主会话同款事件,前端复用同一归约)。
- 撤回 / 重发:服务端 `retractMessage` → `sm.branch()` + 重建 AI 上下文(`state.messages = buildSessionContext().messages`)→ 广播 `messages_retracted` → 前端 alignWithServer。

## 4. 工具系统

- **装配**:`createSessionRuntimeFactory`(src/session-factory.ts,唯一入口)。用 `excludeTools` 黑名单 + `initialActiveToolNames`,**不用** `tools` 白名单——那是白名单语义,会把不在名单的 MCP customTools 滤掉。
- **系统提示**:`buildWriterSystemPrompt(customTools, hasBash)` 动态生成(文末追加 MCP 工具清单);静态 override 会整个替换 pi 的动态工具段。
- **世界书**:`world_update` 是唯一变更通道(提示词禁止 edit/write 直改);`applyWorldUpdate` 纯函数(判别联合 → clone → mutate → validateWorld),`withWorldLock` 串行化读-改-写。
- **守卫**:`installToolPathGuard(bookDir, readOnlyDirs)` 把文件工具限制在书目录内,`skills/` 目录只读放行。
- **bash 只属于 TUI**;web 模式永远无 bash(见 [security.md](security.md))。

## 5. 上下文注入(背景包)

`buildChapterContext`(src/world-context.ts)按序组装:

```
【记忆】→【世界观概述】→【世界书·本章相关】→【写作约束】+【文风采样】→【Notice】+【发展线】
```

- 预算:`DEFAULT_CONTEXT_BUDGET = 2000`(常驻 + 激活共享);记忆单独 `DEFAULT_MEMORY_BUDGET = 1500` 先裁剪。
- 激活引擎:种子 = 关键词命中(keys 子串匹配草稿 + 最近 2 条用户消息);`expandActivation` 深度内多源 BFS 沿关系展开(visited 去重,无视 arrow);排序键 = 直接命中 > 强关联 > 普通关联 > 跳距 > 类型优先级。详见 [design.md](design.md)。
- 裁剪顺序:先裁采样,仍超再裁概述,约束 / Notice / 发展线不可裁。

## 6. 舞台区(实验)

**一章一幕**:导演(讨论 + 维护世界书)→ `script_confirm` 提交剧本 → 用户卡片确认 → `stage_script` 开演 → 演员 / 叙述者即兴共演(受剧本约束)→ 收幕(编剧成文 + `world_update` 回写世界书 + advice.md 下章建议)。

- 编排器键 = 「书:章节」,每书每章独立;导演会话文件 `sessions/<slug>/stage-director-<章节>.jsonl`。
- 模式切换只有硬信号(`script_confirm` → 剧本 / 开演 → 导演 / 收幕 → 讨论),无文本意图识别。
- 演员 = 对等角色(非导演子 agent),共享舞台,知识面由导演 inject 规则决定(include-only,信息差即悬念)。

## 7. Web 前端

「深夜书房」三栏写作台:书库(library,可折叠 56px 图标条)| 纸张(正文常驻 DraftWorkspace,CodeMirror 6)| AI 伙伴(编剧对话单栏,选中正文自动预填输入框)。主题三套(night / paper / parchment,26 色 token)。

已知结构性问题:**舞台对话(StageFeedItem 独立 reducer)与编剧/主会话(processAgentEvent + MessageList)两套对话逻辑并存**——同类 bug 需两边各修,待收敛重构。

## 8. 关键机制索引

| 机制 | 位置 |
|------|------|
| 原子写(唯一 tmp + rename 重试) | `src/atomic-write.ts` |
| CJK 计数(码点范围,无 `\p{` 正则) | `src/cjk.ts` |
| 消息文本提取 | `src/session-text.ts` |
| 世界书编辑记录(预览卡数据源) | `src/world-data.ts`(WORLD_EDIT_RECORD_FILE) |
| 分支 / 撤回 / 导航 | `src/web/session-host.ts` |
| 预览卡纯逻辑 | `web/src/preview.ts` |
| 跨窗口同步 | `web/src/cross-window-sync.ts` |
