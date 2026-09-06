# Changelog

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
