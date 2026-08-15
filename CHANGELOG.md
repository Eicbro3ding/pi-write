# Changelog

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
