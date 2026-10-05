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
| `src/session-factory.ts` | **会话装配唯一入口**:`createSessionRuntimeFactory` 统一 cli/web/stage 三处的 createRuntime 样板(路径基准注入、工具守卫、隐藏 skill 命令、模型解析、工具集);`sessionSkillDirs` 是**技能目录清单唯一真相源**(自带 `skills/` 恒加载 + 调用方附加 + 全局 `~/.agents/skills`,`skillPaths` 与只读放行同源;`packagedSkills:false` 才关,舞台角色用);新增装配点必须用它,禁止再复制样板 |
| `src/web/server.ts` | `WriterServer`:Node 原生 http,**路由表驱动**(method + 路径段模式,40+ REST 端点按域分组为独立 handler)+ SSE 广播 + watcher 集成;`extraRoutes` 插件路由缝;multipart 用 busboy |
| `src/web/session-host.ts` | `SessionHost`:agent 会话 headless 封装(事件扇出、prompt/abort/switchSession、getState、撤回/分支/导航/树、getContextUsage/compact) |
| `src/plugins.ts` | 插件预留类型:`PluginManifest`(后端 ExtensionFactory / 前端声明式斜杠命令) |
| `src/web/file-watcher.ts` | `WorldWatcher`:world.json + draft/*.md 外部变更轮询(无缝同步核心) |
| `src/web/stage-host.ts` | 舞台区 web 宿主(每书一个 StageOrchestrator 惰性创建,命令面 → SSE) |
| `src/web/book-zip.ts` | 书 zip 导出/导入(yazl/yauzl,50MB/2000 条目/路径安全校验) |
| `src/book-manager.ts` | book/chapter 文件系统层(books/<slug>/book.json + sessions/<slug>/<file>.jsonl) |
| `src/config.ts` | 路径(getWriterDir/getAgentDir/getBooksDir/getBookDir)、slugify(保留 CJK)、VERSION、`resolveSkillsDir`(skills 目录三态探测,TUI/web/stage 共用) |
| `src/cjk.ts` | **CJK 计数唯一实现**(码点范围,不用 `\p{` 正则——Android 无 ICU);tools/world-context/counters/writer-ui 共用 |
| `src/atomic-write.ts` | **原子写唯一实现**(唯一 tmp + rename 重试);book-manager/world-data/mcp 配置共用 |
| `src/session-text.ts` | **会话消息文本提取唯一实现**(chatTextOfMessage/chatThinkingOfMessage);TUI extension 与 web session-host 共用 |
| `src/extension.ts` | TUI 内联扩展:`pi.registerTool`(word_count/world_update/world_find/read_chapter/**read_style**)+ 全部 `/` 命令 |
| `src/prompt.ts` | `WRITER_SYSTEM_PROMPT` 写作系统提示词(工具约束/场景节奏/世界维护/**开场纪律**:新书没定风格时提一次并把长期偏好落盘) |
| `prompts/` | 角色提示词本体:`writer-main.md`(写作 agent,TUI/经典模式/主会话,**2026-10-02 起 web 默认落地页**)/`writer-editor.md`(常驻编剧,**只有 world_find**)/`director.md`(导演,有 world_update,仅多 Agent 形态可达)。三份都带开场纪律,但落盘能力不同:写作 agent 与导演能写世界书,编剧只能写 `advice.md` 转交。`director.md` 的 `{STYLE_SETUP_PATH}` 由 `stage-extension.ts` 渲染成 onboarding 剧本绝对路径(舞台角色 `packagedSkills:false`,拿不到 `<available_skills>`)。**`writer-main.md` / `writer-editor.md` 还按 `conversationScope` 渲染**(`{SCOPE_SECTION}` 等占位,值在 `src/prompt.ts` 的 `SCOPE_VARS`):chapter 一列是解耦前原话(`SCOPE_SECTION` = 空串 → 默认模式提示词逐字节不变),book 一列换成「对话不隶属于任何章节 + 当前章节 = 用户正在看的那一章 + 正文白名单不设」。该用哪套由 `hostPromptScope(conversationScope, key)`(`writer-host.ts`)判定:key 是 `<id>.jsonl` 才按绑章叙述——**收幕成文(chatAndWait)在分离模式下仍按章节键建宿主,所以它必须拿绑章那套** |
| `src/tools.ts` | 自定义工具:word_count(手写词扫描,不依赖 `\p{L}`)、world_update、world_find、**read_chapter**(整章全文;内置 read 在 2000 行/50KB 静默截断)、**read_style**(读回文风采样 —— 2026-10-05 起采样不再进任何上下文块,只由它取)、**style_update**(编剧窄通道:只写写作约束/文风采样/世界观概述,`applyStyleUpdate` 复用 `applyWorldUpdate` 引擎,约束强制 target=writer 且按**名字** upsert/删除;不写 `stage/last-world-edit.json` 记录——那只归舞台页消费)(defineTool + typebox) |
| `src/tool-guard.ts` | `installToolPathGuard` 工具路径守卫(书目录内读写 + skills 只读) |
| `src/mcp/` | MCP 配置(config.ts typebox 校验)/连接管理(manager.ts SDK 封装)/工具适配(tools.ts JSON Schema→typebox) |
| `src/stage/` | 舞台区(导演/演员/编剧多 agent 共演 demo):orchestrator(状态机)/types/cast/script-store/stage-store/assembler/counters/stage-extension/cli |
| `src/world-data.ts` | world.json 唯一真相源:校验/规范化/条目/关系/时间线 + md 视图导出;**`WORLD_FILES`/`WORLD_FILE_TITLES` 为世界书文件布局唯一真相源**(world-tree 复用) |
| `web/src/` | React 前端(vite):「深夜书房」三栏写作台(书库\|纸张\|AI 伙伴);pages(WritePage/WorldPage/SettingsPage)、api/client.ts、store.ts(reducer)、preview.ts(卡片纯逻辑)、components/ |
| `electron/` | Electron 壳:main.ts(进程内起服务 + 窗口)、preload.ts |
| `dist/web/server.cjs` | 服务端 esbuild 单文件产物(全部依赖内联);**必须 .cjs 后缀**(包根 type:module) |
| `test/` | vitest 测试(globals:true,只测纯逻辑,不碰真实 provider) |
| `skills/` | 打包的写作技能:outline/critique/revise/stage-scripting(SKILL.md)+ **网文方法论按阶段拆四个**:`craft-outline`(选题结构/大纲/32 张题材卡,50 份)/ `craft-prose`(正文技法/人物,17 份)/ `craft-deslop`(去 AI 味/文风,7 份)/ `craft-review`(审稿标准,2 份)—— 共 76 份原样 vendor 的第三方 references,来源与 commit 见 `skills/craft-outline/references/ATTRIBUTION.md`(**四份副本内容相同**,`test/skill-references.test.ts` 断言逐字节一致),SKILL.md 只做路由、不含流程 + `onboarding`(**上手引导**:环境心智模型 / 风格引导剧本 / 功能教程备料三份 references;补首启向导不覆盖的「写作风格与题材风格」) |

## Web 前端架构(深夜书房,2026-08-07 重设计)

- **信息架构**:「书库 | 纸张 | AI 伙伴」三栏并存——正文(DraftWorkspace)**常驻可见**,对话/批注为右栏 380px 双标签(双内容常驻挂载,切换保留滚动/输入状态);52px 竖导航已删,世界书/设置入口在顶栏右侧;书库栏可折叠 56px 图标条(`localStorage` `pi-writer:library-collapsed`);选中正文自动切批注标签。
- **状态机**:WritePage 的 `view`("draft"/"conversation"/"annotations" 互斥)→ `rightTab: CompanionTab`("chat"/"annotations");WorkspaceTabs 组件为 2 标签。
- **主题**:三套(night 深夜书房暗默认 / paper 纸上书房亮 / parchment 羊皮灯下暖),26 色 token(`THEME_TOKENS`);默认主题颜色收敛进 styles.css `:root`,非默认经 `[data-theme]` 覆盖块(测试强制键集一致);`theme.ts` 的 `sanitizeTheme` 合法值透传。
- **预览卡片**:`preview.ts` 的 `PreviewCardItem { id, anchorId, data }`——稳定 `id`(项目 `newId`)定位更新,不依赖数组下标;anchorId 缺省 `pending:<kind>` 占位,消息 entryId 到手后按 id 稳定化;**持久化在服务端**(`GET/PUT /api/cards`,文件 `sessions/<slug>/<id>.cards.json`),开书时异步预读(恢复完成前禁止持久化写入,防空数组覆盖)。
- **组件要点**:ChapterSidebar(collapsed/onToggleCollapse)、DraftWorkspace(headerless + `.d-error` CSS 类)、AnnotationPanel(embedded 内嵌模式禁自身抽屉)、InputBar(ResizeObserver 重算 textarea 高度 + `/` 命令面板,commands/context 由页面注入)、MessageList(空态条件含卡片存在性,key 用 card.id;`compacting` 显示「正在压缩上下文」)、世界书列表/关系图双视图滑动切换(双常驻叠放 + active/leaving 动画)。
- **`/` 命令**:`web/src/slash-commands.ts` 是唯一注册表;内置 `/node`(world.json 节点原文)、`/chapter`(某章草稿原文)、`/compact`(手动压缩上下文)。这是前端插件预留缝,新命令只加定义、不改 InputBar/页面装配。`web/src/context-usage.ts` 在占用 ≥80% 时给出提示。
- **手机端(≤700px,393×852,2026-09-27 落地)**:两档断点分工——`≤900px` 仍只是「两侧栏变抽屉」的桌面语言,`≤700px` 才换壳。手机端顶栏(`.topbar`)下线,四页各自渲染 `MobileHeader`(52px:主导操作 | 标题 + 状态行 | 图标按钮组,`web/src/components/MobileHeader.tsx`)接管标题/保存状态/字数;四个页面入口收进书库抽屉的「主导航」(ChapterSidebar 的 `nav` prop,由 App 传入 `{view, onNavigate}`)。编辑页与伙伴页**共用同一条底部输入条**(`.m-composer`,WritePage 里 `writerInputBar` 按 `isPhone` 二者取一挂载,不是两份实例);世界书手机端是「搜索 + 类型 chips + 条目卡片列表」,点卡片进详情、页头 ← 回列表;舞台右面板在手机端做底部抽屉(`.stage-grid.phone-panel-open`)。**样式单独放 `web/src/styles/mobile.css` 并最后 import**(`main.tsx`,其后只跟一层 `presence.css` 退场层):世界书/舞台/设置样式表都在 styles.css 之后加载,手机端要压过 `.stage-head`、`.w-bar` 必须排最后,否则同名选择器被后者覆盖(2026-09-27 踩过)。判定钩子 `useIsPhone()`/`PHONE_QUERY`(useMediaQuery.ts);手机端新增的类一律 `m-` 前缀,避免与 `.w-card` 等既有类撞名。舞台页手机端恒用气泡形态(桌面偏好不带到手机),演员条目由 `.st-body`(桌面 `display:contents`、手机两行一列)+ 演员条 `.m-castbar` + 场景胶囊 + 「下一步 · 可选」节拍芯片组成;导出在手机端是整屏页(`.m-sheet` + `ExportPanel` 的受控 props `control/panelRef`,受控时自带触发按钮不渲染)。注意 ≤600px 的 `button { min-height:44px }` 会把固定尺寸控件撑变形(开关、发送钮),mobile.css 里逐个还原。**设置页在手机端不是「桌面分类页」**:`PHONE_PAGES`(SettingsPage.tsx 顶部)把索引行映射成「桌面分类 + 这一页只显示的卡片」,各 `<section>` 用 `cardClass("key")` 打标(页面外的加 `.m-card-off` 由 CSS 隐藏),所以手机点一行只看到那一张卡;主题行就地弹选单(`.m-set-menu`;浅深合并复用 `buildThemeFamilies`/`themeFamilyPick`),开关行就地切。桌面「标签 | 控件」的行(`.st-row`/`.s-pref-item`/`.st-path-ctl`/`.sel-row`)在 393px 会把左侧说明挤成一列字,mobile.css 统一改成上下排(2026-09 用户截图)。手机端的两级导航:世界书「卡片列表 → 只读详情(`WorldEntryDetail.tsx`)→ 编辑表单」,供应商「已连接卡片列表 / 选择供应商 → 详情」(ProviderList 的 `isPhone` 三态 `phoneLayer` + `selectedId`;手机端不自动选中,加 `pvc-phone-detail`;设置页的供应商浮层在手机端加 `pvd-overlay` 整屏化——`.dlg-overlay` 带 `backdrop-filter` 会给 fixed 子元素造包含块,不能靠 `position:fixed` 拉满)。「添加模型 / 添加供应商」在手机端是底部表单页(`.amd-overlay` + `.dlg-panel.amd-panel`)。演员按 cast type 着色(named 琥珀 / pool 世界蓝 / narrator 灰),类名 `.a-named|.a-pool|.a-narrator` + `--actor-color`。

## 关键数据流

1. **会话存储**:vendor `SessionManager` 管理 append-only jsonl(entry 有 id/parentId/timestamp;leaf 指针决定当前分支;`branch()`/`resetLeaf()` 移动 leaf,`getBranch()` 沿 leaf 链,`getTree()` 全树)。**分支位置只在内存,不落盘**。
2. **事件链**:vendor `AgentSessionEvent`(message_start/update/end、tool_execution_start/end、turn_start、agent_settled…)→ session-host 转发(对 message_end 附加 `entryId`)→ server `broadcast()` → SSE(`data: <json>\n\n`)→ 前端 store reducer(processAgentEvent)。
3. **工具装配**:`createSessionRuntimeFactory`(src/session-factory.ts,**唯一装配入口**,cli/web/stage 三处共用;2026-08-10 收敛)→ `createAgentSessionFromServices({ excludeTools, initialActiveToolNames, customTools })`;MCP 工具经 `customTools` 注入;自定义工具经 extension `pi.registerTool`。**注意(2026-08-08 根因)**:不能用 `tools` 白名单收窄工具集(该参数同时是白名单,会把不在名单的 MCP customTools 滤掉)——用 `excludeTools` 黑名单 + `initialActiveToolNames`(vendor 新增,分离「初始激活」与「白名单」语义);系统提示必须用 `buildWriterSystemPrompt(mcpManager.getTools(), hasBash)` 动态生成(静态 override 会覆盖 pi 的动态工具段,MCP 工具对 agent 不可见)。
4. **撤回/分支/导航**(web):`POST /api/messages/retract|branch|navigate {entryId}` → session-host 调 `sm.branch(...)` + `agent.state.messages = buildSessionContext().messages` 重建 AI 上下文 → 广播 `messages_retracted` → 前端 alignWithServer 重载。
5. **无缝同步**:`WorldWatcher` 1s 轮询(mtimeMs+size)发现外部改 world.json/draft → 广播 `world_changed`/`draft_changed`(带 mtime);`PUT /api/draft|world` 支持 `If-Match` 条件写(409 conflict);仅在 SSE 客户端存在时运行。

## 关键实现位置(新功能索引)

- **书/章节重命名**:`renameBook`(book-manager.ts)→ `PATCH /api/books/:slug`(server.ts,当前书走 enqueueSwitch 迁移会话)→ 前端 ChapterSidebar 行内输入 → TUI `/rename-book`(extension.ts)
- **创作方式(多 Agent / 单 Agent)**:唯一实现 `web/src/components/CreationModeCards.tsx`(首启向导「创作方式」步 + 设置页「Agent 形态」卡,文案只写一份;手机端设置索引里是「Agent 形态」子页)。值是服务端 `settings.json` 的 `classicMode`,链路 `App.changeClassicMode` → `PUT /api/settings` → `WriterHost.setClassicMode`(切换即释放已建会话,下次对话生效)。**默认值有两份且必须同步翻转**:`src/writer-settings.ts` 的 `defaultWriterSettings()`(权威,2026-10-02 起 `classicMode: true` = 单 Agent)与 `web/src/settings.ts` 的 `parseClassicMode`(浏览器首帧缓存;只改一处会先画出舞台入口再收回,`test/settings.test.ts` 有护栏比对)。**首启向导八步**(2026-10-02:6 → 8,新增「对话范围」「执行命令」两步):步骤表两份必须同序 —— `SETUP_STEPS`(src/setup.ts)与 `WIZARD_STEPS`(SetupWizard.tsx);步骤判断一律用 `stepId` 不用 `step === N`,跳转走 `nextStep()` / `stepIndex(id)` 不写字面下标(插步骤时下标全体顺移,漏一处就是"进度条在第 N 步、界面还是第 N-1 步的控件");加步骤是追加式,不递增 `SETUP_VERSION`。已有 `settings.json` 的安装不受默认值翻转影响(文件里是显式值)
- **三处两选一卡片**:骨架唯一实现 `web/src/components/ChoiceCards.tsx`(`.choice-*` 样式在 styles.css;图标底 + 标题胶囊 + 一句话定位 + 要点列表 + 右上单选圈),数据各一份 —— `CreationModeCards.tsx`(多/单 Agent)、`ConversationScopeCards.tsx`(绑定章节/分离)、`ShellCards.tsx`(保持关闭/开启 shell,并导出两处共用的风险确认正文 `SHELL_CONFIRM_TEXT`)。加第四处 = 只加一份数据,不要复制骨架。三处都**不落盘**:写服务端 + 失败回滚在调用方(`App.changeClassicMode` / `changeConversationScope` / `changeShellEnabled`)
- **MCP**:`src/mcp/`(config/manager/tools)→ `GET|POST|PUT|DELETE /api/mcp` + `GET|PUT /api/mcp/raw`(直接编辑文件,原样读写含 imports/mcpServers 形状;保存后 reloadRuntime + 重新注入背景包)→ 设置页 McpServerList.tsx。传输 stdio/sse/http(streamable);兼容 Claude Code 配置(`imports: ["claude-code"]` 合并 ~/.claude.json);断线自动重连(watchdog 3-30s,重连后 handleMcpReload 重建会话)
- **撤回/编辑/分支**:session-host.ts(`retractMessage` 仅限最新 user 消息/`branchMessage`/`navigateTo`/`getSessionTree`)→ server.ts 端点 → 前端 MessageList.tsx(按钮:最新=编辑/撤回,旧=分支)+ BranchBar.tsx(分支栏切换)
- **cot 合并+计时**:session-host `extractMessages` 按 user 开组合并(服务端分组权威);store.ts 实时同规则合并;MessageList ThinkingBlock 计时
- **无缝同步**:file-watcher.ts + server.ts(watcher 集成/If-Match)+ 前端 DraftWorkspace/WorldPage(lastMtimeRef)
- **会话重建**:`SessionHost.reloadRuntime()`(MCP 配置变更后;**保留 prevLeafId 恢复分支**)
- **预览卡片**:`preview.ts` 纯逻辑(classifyToolCall/buildDraftDiff/buildWorldDiff)+ WritePage `upsertPreviewCard`(稳定 id 定位,`turnDraftCardRef`/`turnWorldCardRef` 存 string id)+ `handledToolEndRef`(toolCallId 去重防 SSE 重放)→ `GET|PUT /api/cards`(server.ts,书/章节校验 + 路径防穿越,空数组删文件)
- **主题**:`themes.ts`(THEMES/THEME_TOKENS/sanitizeTheme)+ `theme.ts`(data-theme 应用)+ styles.css `:root` 与 `[data-theme]` 覆盖块;测试 `test/themes.test.ts`(键集一致)+ `test/contrast.test.ts`(WCAG 对比度,--faint ≥4:1,亮色 fs-btn-primary 加深 ≥4.5:1)
- **自定义供应商 / 模型(models.json)**:`src/custom-models.ts` 是 models.json 增删改的**唯一纯函数实现**(`upsertCustomProvider`/`hasCustomProvider`/`updateCustomModel`/`deleteCustomModel`/`deleteCustomProvider`),落盘与热重载在 server.ts(`writeModelsConfig` + `reloadModels`)。两个入口分开:**加供应商** = `POST /api/providers/custom`(只写 provider 级 api/baseUrl/apiKey/name,`models: []`),**加模型** = `POST /api/models/custom`(在已有供应商下追加,不再覆盖条目的 `api`/`baseUrl`)。`GET /api/providers` 走 `listProvidersWithCustom()`:`SessionHost.listProviders()` 是从**模型目录反推** provider 的(`new Set(mr.getModels().map(m => m.provider))`),零模型的供应商没有痕迹,所以 server 再把 models.json 的条目补进来并 `sortProviders`。前端 ProviderList(桌面双栏 / 手机三态)+ AddProviderDialog + AddModelDialog
- **换模型 / 换思考档位(会话级设置)**:`POST /api/model`、`POST /api/thinking` → `WriterServer.applyToAllSessions`(三处宿主齐发)→ `WriterHost.setModel`/`setThinkingLevel`、`StageHost` 与 `StageOrchestrator` 的同名方法(已建会话即时生效,演员级 `model` 覆盖优先);装配工厂里的 model/thinkingLevel 是 getter。**漏一处就等于「同一个对话窗口换模型不生效」**(2026-10-01,详见坑 23)
- **手机端**:`useIsPhone()`/`PHONE_QUERY`(useMediaQuery.ts)+ `MobileHeader.tsx` + `WorldEntryDetail.tsx`(条目只读详情)+ `styles/mobile.css`,之后还有一层 `styles/presence.css`(**必须最后 import**,退场动画要压过各页入场 animation);四页 `MobileHeader` 由 App 传 `nav={{view, onNavigate}}` 接抽屉导航;编辑页底部输入条 `.m-composer`;设置页的 `PHONE_PAGES` + `cardClass()` 决定手机子页显示哪张卡
- **斜杠命令**:`web/src/slash-commands.ts`(parseSlashQuery/SlashCommand/SlashSuggestion + node/chapter/compact/skill 工厂)→ `InputBar.tsx`(commands/context props,↑/↓+Enter/Tab 选择)→ `WritePage`/`StagePage` 注册;测试 `test/slash-commands.test.ts`。**`/skill`(2026-10-02)**:候选来自 `GET /api/skills`(`src/skills-index.ts` 用 vendor `loadSkills` + `sessionSkillDirs`,与 agent 装配同源 —— 菜单名字必须等于 `/skill:<name>` 能展开的那份),插入文本是 `/skill:<名字> ` 字面形态(vendor `agent-session.ts` 的 `_expandSkillCommand` 只认消息**首位**的 `/skill:`,所以 `composeMessageWithAttachments` 带引用芯片时把技能指令提到最前);技能正文由 vendor 展开,前端不要再拼一遍
- **技能纪律(2026-10-02 放宽)**:三份提示词里 `writer-main.md` / `writer-editor.md` 有《技能(按需使用)》一节 —— 场景命中就**直接按方法做事**,不再要求「只在用户提出时提供」;唯一保留的边界是**多轮流程先问一句**(不朗读方法论、不倒清单、不报技能名与路径),另有用户显式点名通道 `/skill:<name>`。舞台角色是**故意不给**技能浏览的(`packagedSkills:false`,避免诱导演员/导演去改正文),它们只有 `{SKILLS_PATH}` 指到的方法论文件
- **上下文压缩**:`SessionHost.getContextUsage/compact`(vendor getContextUsage/compact)→ writer 端点 `GET /api/writer/:slug/context` + `POST /api/writer/:slug/compact`;导演走 `stage command compact` + 快照 `directorUsage`;前端 compaction_start/end → MessageList 压缩提示 + context-usage 80% 提示
- **UI 房(调试模式的组件陈列室)**:`web/src/pages/UIRoom.tsx`(页面壳:搜索 / 分组 / 带框格子宽度)+ `web/src/uiroom-types.ts`(**展项契约**:分组 / 展项 / 状态档类型 + 覆盖计算)+ 六个展项文件 `web/src/uiroom/{atoms,chat,world,settings,stage,tokens}.tsx` + `web/src/uiroom-runtime.tsx`(展项取 client/slug/library 的上下文,含 `demoLibrary()`)+ `web/src/styles/uiroom.css`。入口由 `web/src/nav.ts` 的 `navItems({debugMode})` 决定(App 顶栏 + ChapterSidebar 手机抽屉 + UI 房自带手机导航)。**加组件的同一条提交里要加展项**(或在 `UIROOM_NOT_EXHIBITED` 登记理由),否则 `test/uiroom.test.ts` 红
- **插件预留**:`src/plugins.ts` 类型 + `WriterServerOptions.extraRoutes` + `broadcastEvent()`;后端执行式插件未来注入 `extensionFactories`,前端只接受声明式清单(不在 renderer 跑用户 JS)

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
| `web/src/nav.ts` `navItems` | 页面导航条目与可见性规则(经典模式去掉舞台、调试模式追加 UI 房) | 手机抽屉 / 顶栏 / UI 房三处各写一份清单,必然漂移成「手机点得到、桌面没有」 |
| `web/src/use-exit-presence.ts` `useExitPresence` + `web/src/styles/presence.css` | **条件挂载弹层/浮层的退场动画唯一实现** | React 一卸载就没有元素可动画,纯 CSS 做不到退场;每处各写一份 `setTimeout` + 反向 keyframes 必然漂移(2026-09-30 审计:全仓 15+ 处弹层「进场有、退场硬切」) |
| `src/prompt.ts` `SCOPE_VARS` | **「对话与章节的关系」在两份提示词里的叙述唯一实现**(`writer-main.md` / `writer-editor.md` 的 `{SCOPE_SECTION}` `{SESSION_SCOPE_LINE}` `{DRAFT_MIRROR_LINE}` `{EDITOR_SCOPE_LINE}` `{EDITOR_DRAFT_RULE}` 占位) | 解耦(2026-10-03)后提示词里曾同时存在「会话对应一章」与「可改任意章节」两套事实;谁敢在 md 里写死绑定口径,分离模式就又把活推回去(2026-10-03 修) |

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
17. **条件挂载弹层的退场**:`{open && <X/>}` 在关掉的那一帧就卸载,纯 CSS 无从播反向动画——**新弹层一律走 `useExitPresence(open)`**(`web/src/use-exit-presence.ts`)+ 根元素拼 `closing ? " is-closing" : ""`,反向 keyframes 统一在 `web/src/styles/presence.css`(**必须最后 import**,否则压不过各页入场 animation)。两个附带坑:(a) 退场期间源 state 已清空(如 `editingModel`/`pendingAsk`/`fsEditor`),要留一份「最后一次非空」的 ref 再渲染,否则读 null 崩掉;(b) presence 让组件在关窗后仍驻留一个时长,若组件自带表单 state,要按「挂载沿递增的 key」重挂,否则关掉后立刻再打开会看到上次的残留值(见 ProviderList 的 `modelSeqRef`)。
18. **侧栏/面板宽度过渡不要落在 `grid-template-columns` 上**:该属性的过渡是**离散**的(Chrome 107+ 才支持可插值的轨列表,且与 `auto` 轨道混用时行为不一致;Safari/Firefox 更保守),跨浏览器等于硬切。本仓库的做法是:轨宽用 `auto`,**宽度落在子项自身**(`width: var(--*-w)` + `transition: width var(--dur-slow) var(--ease-out)`),拖拽期间加 `.resizing` 关掉过渡保持跟手。左栏 `.chapters`、右栏 `.companion`、舞台 `.stage-panel` 三处同一套。
19. **动效 token 有契约测试**:`test/motion.test.ts` 扫全部 CSS —— `transition` 里的时长必须是 `var(--dur-*)`;`animation` 里的裸时长只有 `RAW_DURATION_ALLOWLIST` 里的**无限环境循环 / spinner**(`tab-live-pulse`、`think-float`、`stat-pulse`、`se-blink`、`compact-flow`、`sk-flow`、`act-rotate`)能过。一次性时长(入场/退场/弹出层)**一律必须走 token** —— 别把"看起来更轻"的一次性数值塞进白名单,要么用 `--dur-*`,要么在 `motion.ts` 里给它一个正式档位。测试还会校验:`animation` 名必须有对应 `@keyframes`、`EDGE_SLIDE` 与 `slide-*` 关键帧位移一致、reduced-motion 熔断块同时清 animation 与 transition。新增动效前先看这个测试,否则 `npx vitest --run` 直接红。
20. **退场时长必须等于 presence 的超时**:`useExitPresence` 默认按 `DUR.base`(200ms)卸载;`presence.css` 的退场 keyframes 若写 `--dur-slow`(320ms),元素会在动画播到一半时被卸载(看起来"卡一下再消失",2026-09-30 验收时踩到)。规则:退场一律 `var(--dur-base)`,且**每处退场方向对偶它的入场**(fade 进就 fade 出、自下缘升就滑回下缘);确需更久就给那个调用点单独传 `ms`。

21. **UI 房契约测试会拦「漏掉的新组件」**:`test/uiroom.test.ts` 扫 `web/src/components/` 的真实文件清单,对照 `web/src/uiroom-types.ts` + 六个展项文件 —— ① 没被任何展项覆盖、又没在 `UIROOM_NOT_EXHIBITED` 写理由的组件 → 红;② `ENTRIES.variants` 与 `SECTION[id]` 的标签**逐字同序**;③ `symbols` 必须在 module 源码里真的被 `export`;④ 每个状态档用 `react-dom/server` 在 node 下渲染一遍(无 DOM、effects 不跑)→ 渲染期抛错即红。所以展项里**渲染期不许读 window/document/localStorage、不许发请求**(数据放 effects);`render` 是 `ComponentType`,页面与测试都用 `createElement(v.render)` 挂载(别当普通函数调用,否则 hook 挂到页面组件上、切档时 hook 顺序变化会报错);`position: fixed` 的弹层展项要写 `frame: "viewport"`(格子里的 `transform` 容器当包含块,否则一展开盖住整页);真 DOM 独占(CodeMirror / cytoscape / EventSource)才允许 `ssrSkip: "原因"` 且 `note` 里要写明。另外:直接拿 `client` 干活的组件(供应商 / MCP / 插件 / 导出 / 工作区 / 全屏编辑器 / 向导)必须登记进 `uiroom-types.ts` 的 `UIROOM_LIVE_MODULES`,UI 房才会默认用 `stubClient()`(所有请求 reject)隔离它们 —— **调试页的误点不该改掉真实数据**,隔离态顺带把「请求失败」这一档也陈列了(工具条可切「真实服务」)。还有一条隐式规则:**每个展项的第一档必须能在 node 下渲染**(页面壳那条 SSR 用例会渲染每格的第 1 档),真 DOM 独占的档放到后面并给整格标 `ssrSkip`(如 `ask-user` 把「已回答记录」放第一位)。

22. **`reducedMotion` 只降「位移类」,别指望它兜住一切**:framer 的 `MotionConfig reducedMotion="user"` 降级名单是 `width/height/top/left/right/bottom` 与 transform —— **margin / padding / border-width 不在里面**,用它们做折叠退场时降级下仍会看到挤动(2026-09-30 收尾时修的是 `ChapterSidebar` 的折叠项退场:按 `useMediaQuery("(prefers-reduced-motion: reduce)")` 短路成只动高度+透明度)。同理,cypress/cytoscape 这类自带动画的库**不读** MotionConfig(`RelationGraph` 的联动居中要自己判降级改 `cy.center`)。另外熔断块只清 `*-duration` 不够:关闭态常用 `visibility 0s var(--dur-slow)` 让隐藏等宽度过渡播完,降级下要清 `transition-delay` / `animation-delay`,否则白等 320ms。

23. **会话级设置必须广播到「三个宿主」,模型/思考档位还是会话创建时绑死的**:web 侧有三个会话宿主 —— 主会话(`sessionHost`,book 级)、常驻编剧(`writerHost`,编辑页「AI 伙伴」的对话,键 = slug:chapterFile)、舞台编排器(`stageHost`,导演/演员/收幕编剧)。**聊天只走后两个**,`sessionHost` 不参与对话但 `/api/models` 的「当前模型」读的是它。
    - 漏转发的症状:设置页切完模型显示成功(读的是主会话),可同一个对话窗口继续用旧模型,直到换章/重启 —— 2026-10-01 的「同一个对话窗口不能换模型」。**采样参数(`POST /api/sampling`)早就三处都转发了,模型/思考等级当时漏了**;新增任何会话级设置,端点里一律走 `WriterServer.applyToAllSessions`(逐个宿主尝试、最后汇总报错,一个宿主坏了不挡其余)。
    - 根因:vendor 在**会话创建时**解析一次模型(`vendor/pi-coding-agent/src/core/sdk.ts` 的 `defaultModelId: settingsManager.getDefaultModel()`),之后只有 `session.setModel()` 能改;`reloadRuntime()` 重建 runtime 时又按装配工厂重新解析。所以两处都要管:① `WriterHost`/`StageHost`/`StageOrchestrator` 给已建宿主转发(`setModel`/`setThinkingLevel`);② 装配工厂里把 `model`/`thinkingLevel` 写成 **getter**(`createSessionRuntimeFactory` 是在每次装配时才读 `opts.model` 的,传值会把当时的 `--model` 固定进闭包,重建后弹回旧模型)。
    - 语义边界:舞台**演员**在 `cast.json` 里单独写了 `model` 的保留覆盖(与 temperature/topP 同款:角色级优先);思考档位不动演员(第一人称默认 low 是角色设计,§10.6),要改走 `updateActorSpec`。

24. **「模型看得见技能文件却不知道有技能」= 技能目录清单漏加载**:vendor 只把 `loadSkills` 拿到的技能列进系统提示词的 `<available_skills>`(`buildSystemPrompt` 在「活跃工具含 `read`」时追加),而**能读**是路径守卫那一层(`readOnlyDirs` 放行 `skills/`)—— 两层不同源,所以会出现「模型能 `read skills/<name>/SKILL.md`,提示词里却没有它」。技能目录只认 `src/session-factory.ts` 的 `sessionSkillDirs()`(自带 `skills/` 恒加载 + `additionalSkillPaths` + `~/.agents/skills`,同时喂 `skillPaths` 与 `readOnlyDirs`);新增装配点若自行拼装目录就会漏(2026-10-01 的 `writer-host` 就是这么漏的:编辑页对话只列了全局技能)。舞台角色是唯一的显式例外(`packagedSkills: false`)。

25. **提示词里不许写死「会话 = 一章」**:对话与章节解耦(2026-10-03)之后,`prompts/*.md` 里那句「每个 pi-writer *会话*对应书的一章」和「正文文件固定由当前章节决定」在分离模式下与事实相反(白名单不设、可改任意章),模型会据此自我收窄——用户让它改别的章节,它把活推回去。规则:凡随 `conversationScope` 变的事实一律写成 `{占位}`,值只放在 `src/prompt.ts` 的 `SCOPE_VARS`;渲染入口是 `buildWriterSystemPrompt(tools, shell, scope)` 与 `buildEditorSystemPrompt(scope)`,**哪个宿主用哪套**走 `hostPromptScope(conversationScope, key)`(判据:key `<id>.jsonl` = 绑章;分离模式下收幕成文 `chatAndWait` 也走章节键,所以它拿到的是绑章那套)。chapter 一列的文本是解耦前原话、`SCOPE_SECTION` 是空串 —— 写作 agent(`writer-main.md`)在绑定章节下的系统提示必须**逐字节不变**(`test/prompt.test.ts` 有护栏:chapter 的句子在、`# 对话范围` 整节不在、两种范围都不许残留 `{占位}`)。

## 需要深入时读 references/

- `references/architecture.md` — vendor 包关系、web 前端结构、会话/事件机制细节(branch/leaf/buildSessionContext)
- `references/commands.md` — 全部命令与脚本参数(web/electron/bundle/electron-builder)
- `references/pitfalls.md` — 上述坑的详细排查路径与修复记录
