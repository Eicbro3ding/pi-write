## [0.3.1] - 2026-08-09

### 新增

- **关系图一键排列**:世界书关系图新增「⟳ 排列」按钮,使用 cola(webcola)约束力导向布局——求解代价包含**边交叉惩罚**(关系线尽量不交叉)、`avoidOverlaps` 防节点重叠、从随机初始位置收敛(实测挤堆初始态 6 节点 51ms 散开);排列结果持久化,刷新后保持。
- **关系图缩放控制条**:画布右上角「− / 百分比 / + / ⛶ 适应」,±30% 步进、以画布中心为锚、百分比实时同步;「适应」一键整图入视野。
- **关系图智能滚轮**:自定义滚轮缩放接管原生(wheelEnabled 关闭)——步长随滚轮增量与当前倍率自适应(低倍率精细定位、高倍率快速巡航),以鼠标位置为缩放锚点;缩放事件节流(百分比未变不触发 React 重渲染),滚轮不卡顿。

### 修复

- 一键排列此前不可用:cytoscape-fcose 2.2.0 依赖 cytoscape 已移除的 `node.getRect` API,与 3.34 不兼容(布局直接抛错);改用兼容的 cytoscape-cola。
- 缩放控制此前抛错:cytoscape 3.34 无 `cy.zoomBy`/`cy.wheelSensitivity` 运行时方法,改用标准 `cy.zoom({ level, renderedPosition })`。
- 滚轮缩放每帧触发 React 重渲染导致的卡顿:百分比改为函数式更新(值不变不重渲染)。

## [0.3.0] - 2026-08-08

### 新增

- **跨章节记忆(memory.md)**:书目录新增 \`memory.md\` 作为书级记忆文件,每章开写前随背景包注入上下文(约 1500 token 预算,超限从最旧条目裁起并提示精简)。章节收尾时 agent 自主更新记忆,写什么由它判断;它是唯一允许写在草稿目录之外的交付物。web 与 TUI 行为一致。
- **MCP 传输升级**:新增 streamable HTTP 传输(\`type: "http"\`,现行标准),旧 \`sse\` 配置继续兼容;需要 OAuth 授权的服务器报错明确提示(暂不支持授权流)。
- **MCP 兼容 Claude Code 配置**:mcp.json 可直接粘贴 Claude Code / Claude Desktop 的 \`mcpServers\` 对象(自动推断 stdio/http/sse,\`directTools\` 等专属字段忽略,\`disabled\` 条目跳过);\`imports: ["claude-code"]\` 自动合并 \`~/.claude.json\` 的服务器(本地条目覆盖同名,文件缺失静默跳过)。
- **MCP 设置页「直接编辑文件」**:内嵌编辑区原样读写 mcp.json——表单表达不了的 \`imports\`/Claude 形状也能配置;保存时校验 JSON 与结构后落盘并重连,新工具即时生效。
- **MCP 调用结果看得全**:resource 内容(TextResourceContents)正文直接进模型上下文(超长截断),不再只显示资源 uri;服务器上报的 \`_meta.usage\` 透传为 token 统计(兼容 input_tokens/inputTokens/prompt_tokens 等命名)。
- **MCP JSON Schema 转换补强**:\`additionalProperties: false\` 保留、字符串长度/正则约束、数字范围/边界、\`allOf\` 对象分支合并、\`not\` 取反——模型传参更准,不再动辄降级宽松。
- **MCP 诊断与自愈**:stdio 启动失败时 stderr 尾部拼进错误信息(排查 npx 报错不再两眼一抹黑);连接意外断开自动重连(3s 起退避翻倍、30s 封顶),重连成功后重建会话让新工具生效。

### 修复

- **MCP 工具此前对 agent 完全不可见**(双重根因):①web/TUI 装配用 \`tools\` 白名单收窄工具集,而该参数在 vendor 中同时充当工具白名单,把不在名单的 MCP customTools 全部滤掉——新增 \`initialActiveToolNames\` 参数分离「初始激活」与「白名单」语义,装配改用 \`excludeTools\` 黑名单(web 禁 bash,条件禁 grep/find);②\`systemPromptOverride\` 使用静态字符串,整个替换 pi 自动生成的动态工具段,而提示词里的工具清单是硬编码的——新增 \`buildWriterSystemPrompt\` 动态生成:基础提示 + 文末追加 MCP 工具清单(名称+单行描述)+ bash 有无按环境注入(TUI 有、web 无)。修复后 agent 能枚举并实际调用 MCP 工具(验证:tavily 5 个工具全部可见、可调用)。

### 安全

- \`.gitignore\` 增加 \`**/mcp.json\`、\`**/auth.json\`、\`**/models.json\` 防御条目——含 API key 的本地配置绝不入库。

## [0.2.5] - 2026-08-08

### 新增

- **系统提示词回复纪律**:回复文本不暴露真实文件路径/工具名(用自然语言描述动作);工具调用失败静默重试(同一参数至多重试一次),失败过程不进回复,仅开发者要求调试时说明;思考链(thinking)统一用中文。
- **世界书关系容错与校验收紧**:`upsert_relation` 的 from/to 接受条目 id 或标题(标题自动解析为 id);标题匹配多个条目时报错列出候选 id 要求消歧(不静默取首个);不存在时报错区分「id/标题均未命中」并提示拼写与 world_find;已存在方向相反的关系时不静默新建,提示带 id 更新或先删后建;成功回显解析结果(from id(标题) → to id(标题)),引导后续直接沿用 id。

## [0.2.4] - 2026-08-08

### 变更

- 聊天消息操作改版:**撤回按钮移除**;**编辑**作用于任意用户消息(不再只限最新一条),未修改文本也可发送——编辑会**先分支再重发**(`branchMessage` + send),原消息及其回复保留为旧分支(可在分支栏切回),而不是被删除。更早的消息保留「分支」按钮用于回溯不发送。

## [0.2.3] - 2026-08-07

### 新增

- 书操作收进常显的 **⋯ 菜单**(重命名 / 导出 / 删除):此前三个文字按钮只在悬停书项时出现,入口不易发现(仅窄屏/抽屉模式常显)。

### 修复

- 书删除(及整个 ⋯ 菜单)此前实际不可用:⋯ 按钮嵌在书项按钮内(非法 HTML,点击可能落在切书按钮上);拆平级后,「点击外部关闭菜单」的监听器与 ⋯ 点击同属一个 click 事件(React 对 discrete click 同步 flush passive effects),菜单打开瞬间即被关闭。修复:书项/章节行拆为平级结构(切书/切章按钮与操作按钮并列),⋯ 切换显式调用 `e.nativeEvent.stopPropagation()`;章节重命名按钮同样存在嵌套问题,一并修复(`validateDOMNesting` 警告消除)。

## [0.2.2] - 2026-08-07

### 修复

- 简化输出工具状态提示增加最短 1.2 秒展示窗口:本地工具(read/write/word_count/world_update)毫秒级完成,此前提示一闪而过无法察觉;现在每次工具调用后标签停留可读,新工具开始重新计时。
- 移除分支栏溢出提示文案(切换分支后对话与 AI 上下文随之切换),该文案在窄面板中撑破布局。

## [0.2.1] - 2026-08-07

### 新增

- **简化输出动态工具状态**:开启「简化输出」(工具卡片隐藏)后,对话末尾显示模型正在做什么——正在阅读 / 正在编辑 / 正在搜索 / 正在更新世界书…,按工具名映射中文进行时文案(未知工具回退「正在调用工具」);上下文压缩时显示琥珀色「正在压缩上下文」提示(由 `compaction_start/end` 驱动,独立于流式状态)。工具卡片也补上「运行中」状态(此前未结束时即显示「完成」)。
- **AI 伙伴面板拖拽调宽**(左缘手柄,300–520px);预览卡片生成完毕后不再漂移(稳定 id 更新,锚点不被覆盖)。
- **流式结束后自动退出查看模式**:「正在查看其他章节」提示随流式结束自动消失。
- **系统提示词全面中文化**(工具名/文件路径/英文枚举等机器必需项保留)。

### 修复

- 关系图(及预览迷你图)随主题切换即时换肤——此前深夜书房下打开的关系图在浅色主题下保持深色,连线标签黑底灰字(`buildGraphStyles`/`buildPreviewStyles` + 监听 `data-theme` → `cy.style().fromJson(...).update()`)。
- 世界书冲突提示误报:AI 修改后紧接手动编辑不再触发「已被其他窗口修改」(仅页面激活且无未保存修改时刷新);提示文案同时涵盖 AI 编辑这一来源。

## [0.2.0] - 2026-08-07

### 新增

- **「深夜书房」前端全面重设计**——新三栏写作台:**书库**(可折叠 56px 图标条、章节序号、拖拽调宽 200–340px)| **纸张**(正文常驻浮起卡片、章节标题头、Alt+E 全屏编辑)| **AI 伙伴**(380px 面板,对话/批注双标签,双常驻挂载切换不丢滚动与输入状态)。52px 竖导航删除;世界书/设置移入顶栏;选中正文自动切到批注标签。
- **三套主题**:深夜书房 night(暗,默认)/ 纸上书房 paper(亮)/ 羊皮灯下 parchment(暖)——26 色 token,`[data-theme]` 覆盖块,对比度经 WCAG 校验,设置页恢复主题选择器。
- **预览卡片服务端持久化** — `GET/PUT /api/cards`(`sessions/<slug>/<id>.cards.json`),跨窗口/重启共享,打开书时预取;卡片以稳定 id 定位(不依赖数组下标),`pending:<kind>` 锚点占位,tool-call-id 去重防 SSE 重放。
- **滑动切换动画** — 世界书列表 ⇄ 关系图(双常驻挂载,active/leaving 滑动)、书库折叠/展开宽度动画、标签与页面切换淡入、思考折叠块/全屏编辑器/右键菜单入场。
- 无衬线排版:Inter 可变字体(本地打包)+ HarmonyOS Sans SC,正文 16px/1.9。

### 修复

- 内容超高不再拉长整页:flex/grid 链补 `min-height: 0`(`.view`、grid rows `minmax(0, 1fr)`),长对话在聊天容器内滚动。
- 标签切换后批注输入框塌陷为 0 高度(隐藏容器内 textarea 高度为 0)——ResizeObserver 在可见性变化时重算。
- 预览卡片不再抢位置/重复/锚点漂移(稳定 id 更新,严格模式幂等)。
- 窄屏抽屉关闭后仍可聚焦(framer transitionEnd 未触发)——CSS `!important` + 延迟 visibility 兜底。

## [0.1.0] - 2026-08-06

### 新增

- 书与章节重命名:`renameBook` 迁移工作区/会话目录与 book.json;`PATCH /api/books/:slug`;侧栏重命名按钮 + 内联输入;TUI `/rename-book`。
- Web UI 的 MCP 服务管理(设置页):stdio/sse 服务的新增/编辑/删除(`~/.pi/writer/agent/mcp.json`),连接状态实时显示;工具经 `customTools` 注入 agent,配置变更后重建会话即时生效(SDK `@modelcontextprotocol/sdk`)。
- 消息撤回(仅最新用户消息)、编辑(撤回后重发)与**分支对话**:可从任意更早消息开新分支,经分支栏自由切换(会话树 + leaf 导航,数据不丢)。
- 聊天:一轮 AI 完整回复(多轮工具调用)合并为一条消息;思考折叠块显示实时「思考 x 秒」计时。
- 世界书/草稿无缝同步:服务端文件 watcher(1s 轮询 `world.json` + `draft/*.md`,仅在 SSE 客户端连接时),广播外部编辑(含新建/删除文件);`If-Match` 条件写(冲突 409)+「重新加载(丢弃本地修改)」操作。
- `world_find` 只读查找工具(返回 id 供 `world_update` 按 id 操作)与 `/adopt-draft` 命令(把手工草稿提升为正式章节)。
- 更强的写作提示词:明确的场景节奏清单、「检查每个工具结果/不要静默重试循环」、「无工具调用即未写作」。

### 修复

- `agent_settled` 不再短路 reducer:AI 结束后思考指示器停止、输入框恢复「发送」。
- 分支状态不再跨书/章节泄漏(聊天重置时清空分支树,水合后刷新)。
- MCP 配置保存不再把对话切到另一分支(`reloadRuntime` 恢复 leaf 指针)。
- world_update 提示词明确字段语义:`keys`/`body` 为整数组/整段替换,省略字段保持原值。

## [0.0.3] - 2026-08-05

### 新增

- Android 移植(`pi-writer-android` 伴生仓库):内嵌 nodejs-mobile(Node 18)进程内运行 web 服务,WebView 复用 React 前端;本地 HTTP 服务可选 bearer token 鉴权(`PI_WRITER_TOKEN`),支持 `Authorization: Bearer` 或同源 cookie `pi_writer_token`。
- `PI_WRITER_SKILLS_DIR` / `PI_WRITER_WEB_DIR` 环境变量覆盖 skills 与静态资源位置(打包后 `import.meta.url` 路径不可用时必需)。
- `PI_WRITER_NO_SPAWN_TOOLS` 环境变量从 web 工具集剔除 `grep`/`find`(Android 上无 spawn)。
- Web UI:窄视口响应式布局(底部导航、全宽容器、触控热区),世界书词条详情卡关闭按钮,移动端页面级滚动,触屏设备隐藏快捷键提示。

### 变更

- Node 18 兼容:正则 `/v` 旗标改写(`/u` + 显式范围),无 ICU 运行时 `Intl.Segmenter` 回退,engines 放宽到 `>=18.20.4`。
- `undici` 固定 6.28.0(Node 18 支持);桌面行为不变。

## [Unreleased]

### 新增

- 包更名为 `@earendil-works/pi-writer`,提供独立 `pi-writer` 可执行文件,配置完全独立于 `~/.pi/writer/agent`。
- CLI 新增 `-v`/`--version` 与 `-c`/`--continue` 兼容参数。
- config / book manager / world tree / `word_count` 工具的单元测试。
- pi-writer 品牌启动头(logo、提示、写作引导)取代通用 pi 头;终端标题设为 `Pi Writer`。
- 内置编辑器(`/edit`):默认纯打字模式(直接输入、方向键、`Ctrl+S` 保存、`Esc`/`Ctrl+Q` 退出、`Ctrl+Z`/`Ctrl+Y` 撤销重做、鼠标点击/拖拽/滚轮),可选 vim 模式(`/edit --vim`)。
- 编辑器体验:移除行号,常驻 AI 聊天侧栏(`Tab` 或点击聚焦,Enter 发送),双击/三击选择,右键菜单(和 AI 讨论 / 复制 / 全选)。
- 编辑器体验:可点击的 保存 / 退出 / 撤回 工具栏按钮、可靠的按住拖拽选择(任意移动跟踪)、可拖拽的聊天侧栏分隔条、`Shift+F10` 右键菜单回退。
