---
name: pi-writer
description: pi-writer 写作 agent 项目(独立仓库, vendor 化 pi 核心包)的关键知识地图与操作指南。当需要在此仓库理解代码结构、定位功能实现、按项目约定写代码、运行/测试/构建/打包时使用——包括任何涉及 book/chapter 管理、world-book 世界书、web UI(GUI)、MCP 配置、会话/撤回/分支、SSE 事件流、vendor 包、Android 移植兼容的提问。即使用户只是顺带提到某个模块(如"改一下侧栏"、"MCP 配置有问题"、"消息撤回"),也先加载本技能获取架构与关键位置,避免从零探索。
---

# pi-writer 项目关键知识

独立 git 仓库(非 monorepo 子目录),**核心包全部 vendor 在 `vendor/`**(pi-coding-agent、pi-ai、pi-tui、pi-agent-core、pi-client、pi-protocol),**零 `@earendil-works` npm 依赖**(npm 依赖只剩第三方,如 @anthropic-ai/sdk、@modelcontextprotocol/sdk)。写作 agent:book/chapter 会话管理、world-book 树、写作工具,web GUI + TUI 双前端,数据都在 `~/.pi/writer`(可被 `PI_WRITER_DIR`/`PI_WRITER_AGENT_DIR` 覆盖)。

## 仓库布局速查

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | CLI 入口:TUI/print/web/stage 分支、HELP、Electron 拉起 |
| `src/web.ts` | web 子命令装配:parseWebArgs/startWebServer,web 工具子集(MCP 注入) |
| `src/session-factory.ts` | **会话装配唯一入口**:`createSessionRuntimeFactory` 统一 cli/web/stage 三处的 createRuntime 样板(路径基准注入、工具守卫、隐藏 skill 命令、模型解析、工具集);新增装配点必须用它,禁止再复制样板 |
| `src/web/server.ts` | `WriterServer`:Node 原生 http,**路由表驱动**(method + 路径段模式,40 个 REST 端点按域分组为独立 handler)+ SSE 广播 + watcher 集成;multipart 用 busboy |
| `src/web/session-host.ts` | `SessionHost`:agent 会话 headless 封装(事件扇出、prompt/abort/switchSession、getState、撤回/分支/导航/树) |
| `src/web/file-watcher.ts` | `WorldWatcher`:world.json + draft/*.md 外部变更轮询(无缝同步核心) |
| `src/web/stage-host.ts` | 舞台区 web 宿主(每书一个 StageOrchestrator 惰性创建,命令面 → SSE) |
| `src/web/book-zip.ts` | 书 zip 导出/导入(yazl/yauzl,50MB/2000 条目/路径安全校验) |
| `src/book-manager.ts` | book/chapter 文件系统层(books/<slug>/book.json + sessions/<slug>/<file>.jsonl) |
| `src/config.ts` | 路径(getWriterDir/getAgentDir/getBooksDir/getBookDir)、slugify(保留 CJK)、VERSION、`resolveSkillsDir`(skills 目录三态探测,TUI/web/stage 共用) |
| `src/cjk.ts` | **CJK 计数唯一实现**(码点范围,不用 `\p{` 正则——Android 无 ICU);tools/world-context/counters/writer-ui 共用 |
| `src/atomic-write.ts` | **原子写唯一实现**(唯一 tmp + rename 重试);book-manager/world-data/mcp 配置共用 |
| `src/session-text.ts` | **会话消息文本提取唯一实现**(chatTextOfMessage/chatThinkingOfMessage);TUI extension 与 web session-host 共用 |
| `src/extension.ts` | TUI 内联扩展:`pi.registerTool`(word_count/world_update/world_find)+ 全部 `/` 命令 |
| `src/prompt.ts` | `WRITER_SYSTEM_PROMPT` 写作系统提示词(工具约束/场景节奏/世界维护) |
| `src/tools.ts` | 自定义工具:word_count(手写词扫描,不依赖 `\p{L}`)、world_update、world_find(defineTool + typebox) |
| `src/tool-guard.ts` | `installToolPathGuard` 工具路径守卫(书目录内读写 + skills 只读) |
| `src/mcp/` | MCP 配置(config.ts typebox 校验)/连接管理(manager.ts SDK 封装)/工具适配(tools.ts JSON Schema→typebox) |
| `src/stage/` | 舞台区(导演/演员/编剧多 agent 共演 demo):orchestrator(状态机)/types/cast/script-store/stage-store/assembler/counters/stage-extension/cli |
| `src/world-data.ts` | world.json 唯一真相源:校验/规范化/条目/关系/时间线 + md 视图导出;**`WORLD_FILES`/`WORLD_FILE_TITLES` 为世界书文件布局唯一真相源**(world-tree 复用) |
| `web/src/` | React 前端(vite):「深夜书房」三栏写作台(书库\|纸张\|AI 伙伴);pages(WritePage/WorldPage/SettingsPage)、api/client.ts、store.ts(reducer)、preview.ts(卡片纯逻辑)、components/ |
| `electron/` | Electron 壳:main.ts(进程内起服务 + 窗口)、preload.ts |
| `dist/web/server.cjs` | 服务端 esbuild 单文件产物(全部依赖内联);**必须 .cjs 后缀**(包根 type:module) |
| `test/` | vitest 测试(globals:true,只测纯逻辑,不碰真实 provider) |
| `skills/` | 打包的写作技能 outline/critique/revise(SKILL.md) |

## Web 前端架构(深夜书房,2026-08-07 重设计)

- **信息架构**:「书库 | 纸张 | AI 伙伴」三栏并存——正文(DraftWorkspace)**常驻可见**,对话/批注为右栏 380px 双标签(双内容常驻挂载,切换保留滚动/输入状态);52px 竖导航已删,世界书/设置入口在顶栏右侧;书库栏可折叠 56px 图标条(`localStorage` `pi-writer:library-collapsed`);选中正文自动切批注标签。
- **状态机**:WritePage 的 `view`("draft"/"conversation"/"annotations" 互斥)→ `rightTab: CompanionTab`("chat"/"annotations");WorkspaceTabs 组件为 2 标签。
- **主题**:三套(night 深夜书房暗默认 / paper 纸上书房亮 / parchment 羊皮灯下暖),26 色 token(`THEME_TOKENS`);默认主题颜色收敛进 styles.css `:root`,非默认经 `[data-theme]` 覆盖块(测试强制键集一致);`theme.ts` 的 `sanitizeTheme` 合法值透传。
- **预览卡片**:`preview.ts` 的 `PreviewCardItem { id, anchorId, data }`——稳定 `id`(项目 `newId`)定位更新,不依赖数组下标;anchorId 缺省 `pending:<kind>` 占位,消息 entryId 到手后按 id 稳定化;**持久化在服务端**(`GET/PUT /api/cards`,文件 `sessions/<slug>/<id>.cards.json`),开书时异步预读(恢复完成前禁止持久化写入,防空数组覆盖)。
- **组件要点**:ChapterSidebar(collapsed/onToggleCollapse)、DraftWorkspace(headerless + `.d-error` CSS 类)、AnnotationPanel(embedded 内嵌模式禁自身抽屉)、InputBar(ResizeObserver 重算 textarea 高度)、MessageList(空态条件含卡片存在性,key 用 card.id)、世界书列表/关系图双视图滑动切换(双常驻叠放 + active/leaving 动画)。

## 关键数据流

1. **会话存储**:vendor `SessionManager` 管理 append-only jsonl(entry 有 id/parentId/timestamp;leaf 指针决定当前分支;`branch()`/`resetLeaf()` 移动 leaf,`getBranch()` 沿 leaf 链,`getTree()` 全树)。**分支位置只在内存,不落盘**。
2. **事件链**:vendor `AgentSessionEvent`(message_start/update/end、tool_execution_start/end、turn_start、agent_settled…)→ session-host 转发(对 message_end 附加 `entryId`)→ server `broadcast()` → SSE(`data: <json>\n\n`)→ 前端 store reducer(processAgentEvent)。
3. **工具装配**:`createSessionRuntimeFactory`(src/session-factory.ts,**唯一装配入口**,cli/web/stage 三处共用;2026-08-10 收敛)→ `createAgentSessionFromServices({ excludeTools, initialActiveToolNames, customTools })`;MCP 工具经 `customTools` 注入;自定义工具经 extension `pi.registerTool`。**注意(2026-08-08 根因)**:不能用 `tools` 白名单收窄工具集(该参数同时是白名单,会把不在名单的 MCP customTools 滤掉)——用 `excludeTools` 黑名单 + `initialActiveToolNames`(vendor 新增,分离「初始激活」与「白名单」语义);系统提示必须用 `buildWriterSystemPrompt(mcpManager.getTools(), hasBash)` 动态生成(静态 override 会覆盖 pi 的动态工具段,MCP 工具对 agent 不可见)。
4. **撤回/分支/导航**(web):`POST /api/messages/retract|branch|navigate {entryId}` → session-host 调 `sm.branch(...)` + `agent.state.messages = buildSessionContext().messages` 重建 AI 上下文 → 广播 `messages_retracted` → 前端 alignWithServer 重载。
5. **无缝同步**:`WorldWatcher` 1s 轮询(mtimeMs+size)发现外部改 world.json/draft → 广播 `world_changed`/`draft_changed`(带 mtime);`PUT /api/draft|world` 支持 `If-Match` 条件写(409 conflict);仅在 SSE 客户端存在时运行。

## 关键实现位置(新功能索引)

- **书/章节重命名**:`renameBook`(book-manager.ts)→ `PATCH /api/books/:slug`(server.ts,当前书走 enqueueSwitch 迁移会话)→ 前端 ChapterSidebar 行内输入 → TUI `/rename-book`(extension.ts)
- **MCP**:`src/mcp/`(config/manager/tools)→ `GET|POST|PUT|DELETE /api/mcp` + `GET|PUT /api/mcp/raw`(直接编辑文件,原样读写含 imports/mcpServers 形状;保存后 reloadRuntime + 重新注入背景包)→ 设置页 McpServerList.tsx。传输 stdio/sse/http(streamable);兼容 Claude Code 配置(`imports: ["claude-code"]` 合并 ~/.claude.json);断线自动重连(watchdog 3-30s,重连后 handleMcpReload 重建会话)
- **撤回/编辑/分支**:session-host.ts(`retractMessage` 仅限最新 user 消息/`branchMessage`/`navigateTo`/`getSessionTree`)→ server.ts 端点 → 前端 MessageList.tsx(按钮:最新=编辑/撤回,旧=分支)+ BranchBar.tsx(分支栏切换)
- **cot 合并+计时**:session-host `extractMessages` 按 user 开组合并(服务端分组权威);store.ts 实时同规则合并;MessageList ThinkingBlock 计时
- **无缝同步**:file-watcher.ts + server.ts(watcher 集成/If-Match)+ 前端 DraftWorkspace/WorldPage(lastMtimeRef)
- **会话重建**:`SessionHost.reloadRuntime()`(MCP 配置变更后;**保留 prevLeafId 恢复分支**)
- **预览卡片**:`preview.ts` 纯逻辑(classifyToolCall/buildDraftDiff/buildWorldDiff)+ WritePage `upsertPreviewCard`(稳定 id 定位,`turnDraftCardRef`/`turnWorldCardRef` 存 string id)+ `handledToolEndRef`(toolCallId 去重防 SSE 重放)→ `GET|PUT /api/cards`(server.ts,书/章节校验 + 路径防穿越,空数组删文件)
- **主题**:`themes.ts`(THEMES/THEME_TOKENS/sanitizeTheme)+ `theme.ts`(data-theme 应用)+ styles.css `:root` 与 `[data-theme]` 覆盖块;测试 `test/themes.test.ts`(键集一致)+ `test/contrast.test.ts`(WCAG 对比度,--faint ≥4:1,亮色 fs-btn-primary 加深 ≥4.5:1)

## 约定(改代码前必读)

- **只用 erasable TypeScript**:无 enum/namespace/参数属性(Android strip-types 兼容)。
- 工具定义走 `defineTool` + typebox `Type.Object`,勿手写 schema;MCP 工具适配在 src/mcp/tools.ts。
- 用户可见 UI 文案**中文内联**;prompt.ts 以英文为主(模型指令)。
- agent 工具集 = read/write/edit/ls/grep/find/word_count/world_update/world_find,**无 bash**(web 模式同);TUI 多 bash。
- 保持独立身份:不用 `~/.pi/agent` 配置,不引入 coding-agent 的扩展/技能。
- 测试在 `test/`,`globals: true`,只测纯逻辑(book-manager/config/editor/extension/world-tree/tools/mcp/file-watcher),不碰真实 provider。
- 前端 store.ts 是纯函数 reducer(单测覆盖);WritePage 装配层不经单测,改事件处理时注意 SSE 分支必须 `dispatch(e)`(历史教训:agent_settled 被 return 跳过导致 isStreaming 卡死)。
- **bash 只属于 TUI,web 永远无 bash(2026-08-10 定为安全设计,勿放宽)**:web 服务是无鉴权的本地 HTTP 服务,bash = 任意命令执行(RCE 等价面),`tool-guard` 拦不住 bash;TUI 的 bash 靠用户在场目视兜底,不是沙箱。给 web 加 bash 属安全回归,禁止;web 需要 shell 能力走 MCP 挂带权限的服务器。

## 手写边界与复用规范(2026-08-10 定稿,改代码前必读)

**核心原则:单一真相源,禁止再造副本。** 以下模块是唯一实现,任何新增代码必须 import 复用,发现第二份副本就地删除:

| 唯一实现 | 用途 | 禁止再造的理由 |
|---|---|---|
| `src/session-factory.ts` `createSessionRuntimeFactory` | 会话装配样板 | 历史上有 cli/web/stage 三份拷贝,已出现行为漂移(2026-08-10 收敛) |
| `src/cjk.ts` `cjkCount`/`isCjkChar` | CJK 字符计数 | 曾有 4 份实现、口径不一;且必须用码点范围(Android 无 full ICU,`\p{` 正则禁用) |
| `src/atomic-write.ts` `atomicWriteFile` | 文件原子写(唯一 tmp + rename 重试) | 曾有 3 份 tmp+rename,能力漂移(有的无 EPERM 重试) |
| `src/session-text.ts` `chatTextOfMessage`/`chatThinkingOfMessage` | 会话消息文本提取 | TUI/web 曾各一份,行为漂移 |
| `src/config.ts` `resolveSkillsDir` | skills 目录三态探测 | 曾有 3 份实现 |
| `src/world-data.ts` `WORLD_FILES`/`WORLD_FILE_TITLES` | 世界书文件布局表 | 曾有 5 处散落映射,加文件类型要改五处 |

**手写边界(允许手写,不引框架)**:
- HTTP 路由表(`server.ts` 的 `Route` 表 + `matchRoute`,~30 行;加端点 = 表加一行 + 一个 handler,handler 按域分组)。**路由表顺序敏感**:同方法同段数的条目中,静态段(如 `mcp/raw`)必须排在参数段(`mcp/:name`)之前。
- SSE 帧协议、静态文件服务 + SPA fallback、CLI 参数解析(parseArgs/parseWebArgs)、回环 Host/Origin 守卫、If-Match mtime 条件写。
- 判断标准:新逻辑 ≤ 50 行且无安全边界 → 可手写;涉及安全/协议解析/边界条件多 → 必须用库。

**必须用库,禁止手写**:
- multipart 解析 → **busboy**(2026-08-10 替换手写 boundary 切分;手写版是安全 bug 高发区)。busboy 1.x 是**函数调用** `busboy({ headers, limits })` 不是 `new`(类型 `@types/busboy` 为 `export =` namespace)。
- zip 打包/解包 → yazl/yauzl(book-zip.ts 已用)。
- JSON Schema → typebox(Compile().Check() 做运行时校验,见 mcp/config.ts)。
- 新增需求先查上述清单:能复用/引库就不手写;引库前先评估(见下)。

**新依赖引入流程(必走)**:
1. `npm i <pkg>` + `npm i -D @types/<pkg>`(若需要);
2. `tsc -p tsconfig.tmp.json` 确认类型(注意 `types: ["node"]` 只限制全局自动包含,模块类型走 node_modules/@types 正常解析;`export =` 的 CJS 包用 default import + `allowSyntheticDefaultImports`(bundler 模式隐含));
3. **行为测试覆盖该库的每个 API 调用点**:列出代码里用到的每个方法/事件/分支,一条测试对应一个(方法不存在或语义理解错会直接崩/挂起/断言失败);事件路径(如 error/limit/close)尤其要补,类型检查保证不了运行时行为;
4. `npm run build:web` 确认 esbuild 能内联(自包含检查会拒绝外部 require);
5. 评估依赖体积/纯 JS 可内联性(Android nodejs-mobile 场景)。

## 常用操作

```bash
# 运行
npx tsx src/cli.ts --book <slug>              # TUI
npx tsx src/cli.ts --web [--port N] [--no-browser]   # web 服务(默认 127.0.0.1:8811)
npx tsx src/cli.ts --web --no-browser &       # 只起服务;前端开发另开:cd web && npx vite dev
# 测试(临时配置,勿用 vitest.config.ts——缺 monorepo base)
npx vitest run --config vitest.tmp.config.ts
# 类型检查
npx tsc -p tsconfig.tmp.json                  # src+vendor(注意 vendor 有既有类型错误,过滤 vendor/)
cd web && npx tsc --noEmit -p tsconfig.json   # 前端
# 构建/打包
npm run build:web                              # 服务端 server.cjs + 前端 dist(自包含检查 + 导出契约冒烟)
npm run bundle                                 # TUI 单文件 exe(需 bun)→ release/pi-writer.exe
# 生产产物冒烟(临时目录,避免污染真实数据!env 前缀后**不要加分号**)
env PI_WRITER_DIR="C:/.../tmp" node dist/web/server.cjs --no-browser --port 8899
# 冒烟请求用 node --input-type=module -e "..."(undici fetch),勿用 curl 发中文/文件
#   —— Git Bash 的 curl 对 /tmp 的路径映射与 node 不一致(读文件会 exit 26),图片/zip 上传请用 fetch + FormData
```

## 常见坑(排查优先看)

1. **vendor 类型错误**:tsc 报 vendor/* 的错误是既有问题(undici/fetch 类型),忽略,只看 src/ 与 test/。
2. **冒烟污染真实数据**:`PI_WRITER_DIR=...; node ...` 的分号会让 env 前缀失效,服务写进真实 `~/.pi/writer`!用 `env VAR=... cmd` 或去掉分号。
3. **SDK 顶层 exports 缺陷**:@modelcontextprotocol/sdk 1.30.0 的 `"."` 指向缺失的 index.js,必须从子路径导入(`@modelcontextprotocol/sdk/client/stdio.js` 等)。
4. **CJS 产物**:server 产物必须叫 `.cjs`(包根 type:module);esbuild 打 CJS 时 import.meta 为空,web-build.mjs 用 importMetaUrlPlugin 烘焙。
5. **Windows mtime 精度**:短间隔写入共享 mtime,If-Match 有 1ms 容差;测试里外部修改用 `utimesSync` 推进时间戳。
6. **curl 中文乱码 + /tmp 路径映射**:Git Bash curl 发中文 body/URL 会乱码;curl 与 node 对 `/tmp/x` 的解析不同(MSYS 转换 vs Windows 字面路径),`-F file=@/tmp/x` 可能 exit 26——用 node fetch + FormData 做冒烟。
7. **服务残留进程**:TaskStop 可能杀不干净 node 子进程,端口占用时 `/c/Windows/System32/netstat.exe -ano | grep :PORT` + `/c/Windows/System32/taskkill.exe //F //PID <pid>`(Git Bash 的 netstat/taskkill 不在 PATH)。
8. **分支状态不落盘**:重启/reloadRuntime 后 leaf 回到文件最深路径,代码已用 prevLeafId 恢复;手工改会话文件同理。
9. **flex/grid 高度链**:内容超高整页被拉长 = 链上某处缺 `min-height:0`(`.view`/grid 子项/grid-template-rows 需 `minmax(0,1fr)`);滚动容器超高必须在容器内滚动,不能撑父级。
10. **隐藏容器内 textarea**:display:none 容器中挂载的 textarea scrollHeight 为 0,JS 自动增高会钉成 0 高度——需 ResizeObserver 在容器恢复显示时重算(InputBar 已有,新输入框复用)。
11. **抽屉 visibility 兜底**:窄屏抽屉关闭态 framer transitionEnd 可能不触发 visibility,styles.css 用 `!important` + 延迟 transition 兜底;移动端抽屉开关必须在抽屉外(纸张头部)。
12. **卡片恢复竞态**:previewCards 服务端预读完成前禁止持久化写入(restorePendingRef 控制),否则水合空数组会覆盖已存卡片;upsert 的 id 生成在 setState updater 内(StrictMode 双调用幂等)。
13. **主题 token 测试强约束**:增删颜色 token 必须同步 `themes.ts` 的 THEME_TOKENS + styles.css `:root` + 非默认主题 `[data-theme]` 覆盖块,否则 themes/contrast 测试红。
14. **路由表顺序**:server.ts 的 `Route` 表里,同方法同段数的条目静态段必须先于参数段(如 `mcp/raw` 在 `mcp/:name` 之前);匹配时传入的是**去掉 `api` 前缀后**的 parts(`parts.slice(1)`)。
15. **Android 无 full ICU**:src 内禁 `\p{` 正则(CJK 计数用 cjk.ts 码点范围、英文词计数用手写扫描 tools.ts countEnglishWords);新增文本处理代码不得引入 `\p{`。
16. **busboy API 形态**:`import busboy from "busboy"` 是**函数调用**(返回 Busboy 实例),不是 `new`;事件 `file/error/close` + stream 的 `data/limit/end` 都有行为测试覆盖(test/server.test.ts multipart 分支组),改动后保持覆盖。错误消息/状态码契约:非 multipart → 400 `缺少 multipart boundary`;损坏 body → 400;超限 → 400 `too_large`;缺字段 → 400 `缺少 multipart 字段 file`。

## 需要深入时读 references/

- `references/architecture.md` — vendor 包关系、web 前端结构、会话/事件机制细节(branch/leaf/buildSessionContext)
- `references/commands.md` — 全部命令与脚本参数(web/electron/bundle/electron-builder)
- `references/pitfalls.md` — 上述坑的详细排查路径与修复记录
