# Changelog

## [Unreleased]

修 bug：导演改「上限条数」不生效 / 改规则会连演出指令一起清空（2026-09-18，来自实际使用反馈）。

- **stage_revise 会清空剧本文字段**：工具垫片（prepareArguments）对未提供的字段显式产出 `undefined`，而 `reviseScript` 用对象展开合并 → `{...旧值, setting: undefined}` 把旧值抹掉。导演只想改一下上限条数，整块 `text.shared`（场景/目标/节拍/基调/禁区）与 `perActor`（角色任务/**每轮上限 boundary**/风格示例）被一起清空——演出指令凭空消失。两道防线：垫片不再产出 undefined；`reviseScript` 的合并忽略 undefined（`mergeDefined`）。
- **用 script_confirm 改正在演的一幕不生效**：`buildAndSaveScript` 会把剧本重写成 version 1 并整体替换，而编排器内存态只在 `startScene` 时加载 → 正在演的这一幕仍按旧剧本推进（表现出来就是"改了上限却不生效"），旧文本段还被 v1 覆盖丢失。现在 `script_confirm` 对正在演/收尾中的 sceneId 直接拒绝，错误里指向 `stage_revise`（新增 `isSceneActive`）。
- **收尾窗口形同虚设**：`wrapUpWindow` / `wrapRemaining` 只是个从不递减的内存计数，而 `decideTurnAction` 在 wrapping 下只看 `lines >= minLines` → 收尾后下一轮立刻收幕，演员却被反复告知「剩余约 N 条」。改为真截止线：`/wrap` 记 `wrapDeadline = 当前条数 + 窗口`，判定按截止线收束，演员每轮的「剩余 X 条」由截止线实时算出（倒计时如实递减，且不改状态、刷新/重连一致）。
- **测试**：`stage-script`（合并忽略 undefined：只改 maxLines 不碰任何文字段）；`stage-tools`（工具级：只改上限后 shared/perActor 逐字段保留、script_confirm 拒绝覆写正在演的一幕）；`stage-orchestrator`（到上限不发言直接收幕、导演调大/调小上限后按新值推进、收尾窗口按条数收束）。

## [0.0.6] - 2026-09-18

经典模式(单 Agent)、工作区面板、外部命令与 shell 方言。

- **经典模式**:设置页「界面 → 模式」与首启向导偏好步可切换。开启后去掉的只有**舞台**(导演 / 演员 / 旁白那套多 Agent 共演)——顶栏不再有舞台入口、该页不再挂载;编辑页、世界书页、设置页照常,世界书页本就没有 agent,是面向人的设定编辑器。编辑页的 AI 不再是受限编剧,而是**带全量工具的写作 agent**(系统提示 `prompts/writer-main.md`;工具 `read/write/edit/grep/find/ls` + `word_count`/`world_update`/`world_find` + MCP;bash 默认不给,可由设置页「外部命令」显式放开),并解除「只能写当前章节草稿」的路径白名单(要能写 `outline.md` / `memory.md` / `notes/`)。
- **服务端设置**:新增 `GET|PUT /api/settings` 与 `~/.pi/writer/settings.json`。经典模式改变 agent 装配,放服务端而非浏览器——多窗口/换浏览器一致;切换后 `WriterHost.setClassicMode` 释放已建会话,下一次对话按新装配重建,并经 `settings_changed` SSE 广播;前端 localStorage 仅作首帧渲染缓存,挂载后以服务端为准对账。
- **向导与设置页**:首启向导「界面偏好」步新增经典模式开关(介绍步的功能卡片随模式变化);设置页新增「模式」卡与开关;编辑页在经典模式下把「编剧」标签/占位文案换成单 agent 说法。
- **测试**:`test/writer-settings.test.ts`(解析容错 / 读改写 merge);`test/server.test.ts` 补 `/api/settings` 用例(缺省 / 开关落盘 / 应用宿主 / SSE 广播 / 非法字段 400);`test/settings.test.ts` 补本地缓存解析用例。

### 工作区(书目录文件清单与预览,只读)

- **定位收窄(按作者反馈):工作区只放 AI 产出的中间产物** —— 收集的资料、笔记片段、参考图,以及各章草稿。**世界书生成物不再进清单**:`outline.md`(大纲)、`.writer/timeline.md`(时间线)、`characters.md`(人物档案)、`world.md`(世界设定)是 world.json 的导出镜像,权威视图在世界书页,摆进工作区会被当成可以编辑的稿子(改了还会被下一次 `world_update` 覆盖)。排除逻辑收敛到 `isGeneratedView`,清单与读取端点同源(列不出来 = 也读不到)。
- **入口**:编辑页**左栏顶部**(原来章节栏那一列)新增「章节 | 工作区」分段切换——工作区与章节列表是同一层级的两块内容,不占顶栏、不加页面;折叠态整条隐藏。
- **后端**:`GET /api/books/:slug/files`(清单)与 `GET /api/books/:slug/file?path=`(单文件预览,文本回 JSON、图片回字节流)+ `src/book-files.ts` —— 按语义分组(草稿 / 资料与笔记 / 图片 / 其他)而不是镜像磁盘树:`draft/`、`stage/`、`*.jsonl` 是实现细节与机器数据,不该变成用户概念。条目带真实相对路径(想直连磁盘有出口)、展示名(`title`:草稿=章节标题,其余=文件名)、字节数、mtime、`chapterId`/`chapterTitle`;排序 = 分组序 → 草稿按书里的章序(不是 mtime)→ 组内时间倒序。
- **读取校验**:`isWorkspaceFile` 与清单同源;`lstat` 拒末段符号链接、`realpath` 包含性检查拒**中间目录**符号链接(单测抓出来的越界洞);文本超过 512KB 截断并标记;`world.json`/`book.json`/`cast.json` 与世界书生成物一律 400。
- **前端**:`WorkspacePanel`(语义分组列表 + 「AI 写过 · N 个文件」台账,台账来源是 `writer_event` 的 `tool_execution_start` 参数路径,刷新即空)+ `FilePreview`(只读覆盖层压在纸张区上,正文编辑器不卸载;文本走 marked 管线复用 `.record-md`,图片直接吃字节流,二进制给元信息)。点草稿条目 → 切回章节模式并选中该章;点其他条目 → 弹预览。
- **只读、无 CRUD**:重命名/删除/移动会同时打断 `book.json` 章节索引、会话文件名与 `world.json` outline 的引用,UI 层不碰。
- **左栏布局修正**:左栏改为「切换控件固定 + 中间滚动区 + 底部固定」三段——此前整条 `.chapters` 自己滚,于是「收起」钮在工作区模式(内容短)悬在半空(距侧栏底 504px)、在章节多时又被内容顶出视野。现在切到哪种模式、内容多长,收起钮都贴底(实测三种情形均距底 14px)。
- **提示词:让 AI 真的去产出中间产物**(此前提示词在**阻止**它):`prompts/writer-main.md` 原来写着「写在其他任何位置(临时文件、`notes/`、别处新建的 .md)用户在界面上都看不见,等于没写」——那是工作区面板出现之前的事实(界面只镜像当前章节草稿),却正好卡住工作区「资料与笔记」唯一的内容来源。现在改成区分**交付物 / 中间产物**:散文只有一个落点 `draft/<章节id>.md`(这条硬规则保留,它是 2026-08「正文写到 draft/第一章.md、前端读到空」的修复);资料、研究、场景备选、废弃片段落 `notes/**`,并新增「中间产物」小节写明何时该写、一个主题一个文件、**来源必须标(自己的知识要标"未核实")、绝不编造出处、没有联网检索工具就不要假装查过**。`prompts/director.md` 补一条「资料收集纪律」(开演前背景查证与用户给的材料的落点,并明确 `notes/` 不进正文、不进世界书)。常驻编剧(`writer-editor.md`)不承担资料收集,未改。
- **测试**:`test/book-files.test.ts`(分组 / 展示名 / 生成物排除 / 机器数据排除 / 深度上限 / 路径校验 / 符号链接 / 截断)+ `test/workspace-panel.test.ts`(体积与相对时间格式化)+ `test/server.test.ts` 两组端点用例(清单、文本、图片、越界 400、机器数据与生成物 400、缺失 404、符号链接逃逸 404)。

### 外部命令与 shell 方言

- **外部命令开关**:设置页「模式 → 外部命令」放开 agent 的 shell 工具(缺省**关闭**)。这是唯一一条把边界从「书目录」扩大到「整台机器」的开关——命令以服务进程权限运行,`installToolPathGuard` 管不到它;因此默认关、开关带风险确认(写明「可读写整台磁盘、访问网络,书目录路径限制无效」),状态存服务端 `~/.pi/writer/settings.json`(`enableShell`)。切换后 `WriterHost.setShell` 释放已建会话,下一次对话按新装配重建。
- **命令与输出实时可见**:开着「简化输出」也强制显示——这是外部命令唯一的约束方式。前端按 `toolCallId` 归并同一条命令的流式增量(`tool_execution_update`),而不是收尾才一次性贴出。
- **shell 方言(bash / PowerShell)**:新增 `shellKind`(`bash` 缺省 / `pwsh`)与 `shellPath`(显式可执行文件,空 = 自动探测)。vendor 的 shell 通道是 bash 专用的(Windows 只找 Git Bash,找不到直接抛错),方言支持复用它已有的 `shellPath` 设置——PowerShell 的 `-Command` 可缩写为 `-c`,于是 pwsh 借用同一 spawn 形态跑起来(`args: ["-c"]`,已实测)。解析顺序收敛在 `src/shell-kind.ts`:显式路径(按文件名判方言)> `%ProgramFiles%\PowerShell\7\pwsh.exe` > PATH `pwsh` > 回退系统自带 Windows PowerShell 5.1(带 warning)。
- **提示词按方言叙述**:工具名在 vendor 里始终是 `bash`(schema 与描述都是 bash 口径),不说清方言模型会写 bash 语法必然报错。`buildWriterSystemPrompt(customTools, shell)` 按 `none/bash/pwsh/powershell` 注入对应文案:pwsh 下点明「实际由 PowerShell 7 执行」+ 原生路径与 `$env:NAME` + `exit $LASTEXITCODE`(`pwsh -Command` 会把原生程序退出码折算成 1,不加这行模型判成败会误判);编剧的固定角色提示词没有占位符,由 `WriterHost.editorSystemPrompt()` 追加同一行文案。**选了 pwsh 但本机解析不到 → 方言为 `none`,不放开 shell 工具**,提示词如实说「没有 shell」,而不是给一个必然报错的工具。
- **测试**:`test/shell-kind.test.ts`(方言解析:平台 / 环境 / 存在性 / which 全部注入,覆盖标准目录、PATH、5.1 回退、显式路径、路径不存在);`test/prompt.test.ts` 覆盖四套方言文案;`test/writer-settings.test.ts` 新字段解析与 merge 语义;`test/server.test.ts` 新字段校验与解析回显;`test/writer-host.test.ts` `setShell` 释放语义与编剧提示注入。

## [0.0.5] - 2026-09-06

插件系统:plugins 目录装载 + 设置页管理 + 声明式设置菜单与斜杠命令 + 完全信任(trusted)。

- **插件装载**:`~/.pi/writer/plugins/<id>`/(plugin.json + 入口 index.mjs,default export = 扩展工厂);清单字段级白名单校验,坏插件错误隔离不阻塞其他插件;启用双层(作者 `enabled:false` 强制禁用优先、用户运行时开关缺省启用),切换后重建会话即时生效
- **声明式扩展**:设置项(插件在设置页左侧注册分类;字段类型 string/number/boolean/select/textarea,值存 `plugins/<id>/settings.json`)、斜杠命令(如 `/灵感`,主进程执行、结果回插输入框)
- **完全信任(trusted)**:插件级开关(`plugin-state.json`,缺省关闭);开启后入口可导出 `routes` 注册后端自定义路由(自动加 `/api/plugins/<id>` 前缀,仅 trusted 注册)并加载前端 JS(`frontend.mjs` 经 `GET /api/plugins/:id/frontend.mjs` 加载,仅 trusted 返回);开关带「与主进程/渲染进程同权」风险确认;未信任插件两者一律不可用
- **LLM 工具**:插件经工厂注册工具(如 dice 的 `roll_dice`、inspire 的 `inspire`),与 MCP 工具同通道注入 agent
- **示例插件**:掷骰子 dice(工具 + `/快骰` + 设置菜单 + 信任后掷骰历史)、灵感笔 inspire(工具 + `/灵感` + 灵感库设置 + 信任后灵感面板)
- **文档与测试**:`docs/plugin-development.md` 插件开发指南(声明式清单、web 命令、完全信任、安全模型);loader/server/slash-commands 用例扩充

## [0.0.4] - 2026-09-05

首次启动配置向导 + 模型供应商配置界面重构。

- **首次启动配置向导**：新用户五步引导（功能介绍 → 模型服务 → 默认模型+思考级别 → 建第一本书 → 界面偏好）；完成标记存 ~/.pi/writer/setup.json，跨窗口/跨浏览器一致，换环境不重复弹；设置页可「重新运行配置向导」
- **模型供应商配置双栏卡片**：左侧供应商列表（已配置置顶、搜索、状态点），右侧详情（Base URL、API 格式、API Key 掩码/更换、模型列表带上下文/视觉/思考徽章）
- **添加模型弹窗**：模型 ID、上下文窗口、最大输出 Token、输入类型（文本/图片，视频/PDF 未支持、输出固定文本）；Base URL/API Key 从当前供应商自动带入；自定义供应商入口并入弹窗，设置页原「自定义模型」折叠卡移除
- **后端**：新增 `GET /api/providers/:id`（供应商全量模型列表，不按认证过滤，未配置也能预览）；`POST /api/models/custom` 支持同 provider 合并模型数组（修复第二次添加覆盖丢失）、`input`/`name` 字段

## [0.0.3] - 2026-08-21

设置页与 UI 评审修复 + 模型目录联网刷新。

- **模型列表联网刷新**：设置页新增“联网刷新”按钮，调用 `POST /api/models/refresh`；DeepSeek 接入真实 `GET /models`，可拉取在线模型，不再只依赖静态/远程缓存目录
- **DeepSeek 模型补齐**：新增 `deepseek-v4-flash-vision-exp`，刷新后模型列表与官方接口一致
- **模型 Key 状态修复**：添加/移除/更改 API Key 后，ProviderList 等待父级模型刷新完成；当前模型失效且无回退时清空前端当前模型，服务端也只返回仍然可用的当前模型
- **UI 评审修复**：按钮窄容器文字竖排、设置页错误色使用主题 token、顶栏书名去重、移动端隐藏快捷键提示、保存状态去重、舞台空态隐藏内部工具名、中文标点统一、图标按钮 title/aria-label 补齐
- **编辑器**：中文长段落软换行；activeLine 使用主题中性色
- **其他**：世界书旧版空 notice 不再生成空待办项；内联 SVG favicon


## [0.0.2] - 2026-08-13

主题系统资产化:CSS 文件即主题,零注册自动发现。

- 主题 = 纯 CSS 文件:内置 `web/public/themes/*.css`、自定义 `~/.pi/writer/themes/*.css`,放入即出现在设置页(名字取首行注释,色板取 token),无需改源码
- 内置 6 套主题:纸上书房 / 羊皮灯下 / 黑白浅色 / 黑白深色(冷烟灰淡雅)/ 莫兰迪色系 / 莫兰迪深色;四套玻璃主题带亚克力毛玻璃(环境色团 + 面板 blur + 场景头/输入条亮档)
- 主题文件完全自包含(token + 全部结构规则),`styles.css` 只留 night 默认基底与通用规则
- 备忘录待办板、约束面板改版(可折叠 + 规则包导入)、提示词外置与自定义模型
- 前端水合 / 事件 / 数据拉取缺陷修复(编剧按章节过滤、切章串对话、确认卡串书、舞台快照代数守卫等)

### 0.0.2 修订(2026-08-13,审阅整改报告 docs/code-review-fullstack.md)

- **A 档**:编剧确认卡切章守卫(append 前校验 scope)、edit-capture 取数带 slug、死代码清理(5 个 client 死方法、DraftWorkspace 死句柄、workspace.ts 孤儿逻辑)、App 导航 toggle、新建主题 stale closure、exportBook 复用
- **B 档**:导演流式快照守卫(切页/重连不打断流式,幂等比对)、顶栏字数节流(保存状态即时)、MessageList memo(内容级比较器,toolCalls 逐字段)、世界书关系图懒挂载 + 类型过滤改 show()/hide() 增量切换、备忘录板 409 冲突提示、舞台 auto/thoughts 命令失败回滚
- **C 档**:删主会话只写状态死代码 + 查看模式缓存链(主会话消息无 UI 不再进入 reducer;保留 ensureServerSession/hydrateQueueRef 骨架)、跨窗口 session_changed 空闲跟随仅限同书 + 脏编辑不跟随(M18)
- **会话 entryId 修复**:message_end 的 entryId 附加(vendor 先 emit 后 appendMessage,第一条消息无 entryId、后续错位一条——编辑/撤回定位错误的根因;session-host 补发带正确 entryId 的 message_end)

## [0.0.1] - 2026-08-11

首个公开版本(独立版本线,与旧仓库断开)。

- AI 原生的长篇创作环境:TUI / Web GUI / Electron 三种界面,一份数据
- 世界书系统:`world.json` 单一真相源、关系图(强关联标记)、约束 / 采样 / 发展线 / 时间线 / 世界观概述
- 章节即会话:独立上下文、分支、撤回与编辑重发
- 上下文激活引擎:关键词命中 + 关联激活(深度内多源 BFS、强关联优先),预算内注入
- 跨章记忆与常驻世界观:memory.md + worldSummary
- 世界书变更预览卡:Agent 更新世界 → diff 预览 → 作者确认归档
- 舞台多 Agent 共演(实验):导演 / 演员 / 编剧
- 技术文档:docs/architecture · development · security · design
