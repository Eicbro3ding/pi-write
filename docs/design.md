# 设计文档

## 1. 设计原则

1. **单一真相源**:world.json 是世界的唯一事实,`.writer/*.md` 是导出视图;文件布局表(WORLD_FILES)只在一处定义。
2. **默认兼容**:新能力默认关闭 / 空值跳过,旧行为逐字节不变(激活引擎 depth 默认 0、worldSummary 默认空)。
3. **纯函数先行**:`applyWorldUpdate` / `buildChapterContext` / `expandActivation` 均为纯函数,单测覆盖,副作用收敛在调用端。
4. **作者在场**:世界书修改要么经用户确认(TUI 半自动建议清单),要么经用户卡片确认(舞台剧本确认门)。
5. **成本意识**:上下文前缀稳定 = 缓存命中(实测 0.02 vs 未命中 1 元/1M);一切注入设计都以「前缀稳定」为约束。

## 2. 上下文注入(背景包)

按序注入:

```
【记忆】→【世界观概述】→【世界书·本章相关】→【写作约束】+【文风采样】→【Notice】+【发展线】
```

- 记忆 = 叙事态(agent 维护,最新在上),概述 = 稳定态(用户维护),激活组 = 当前场景相关;
- 预算:`DEFAULT_CONTEXT_BUDGET = 2000`(常驻 + 激活共享);记忆单独 1500 先裁剪;
- 裁剪顺序:先裁采样,仍超再裁概述,约束 / Notice / 发展线不可裁;
- 常驻段在场景内完全稳定——既是质量基线,也是缓存命中的前提。

## 3. 激活引擎

**种子 = 关键词命中**:keys 子串匹配(草稿全文 + 最近 2 条用户消息),过 active / chapters 过滤,按类型优先级排序。`activatedEntryIds` 产线稳定,关联展开在其后。

**关联激活**(`expandActivation`,默认关闭):

- 深度 = **跳距上限**(半径),不是步数计数器——死路 / 分支 / 多树互不消耗,发现集与遍历顺序无关;
- 多源 BFS 沿 relations 双向遍历(无视 arrow,关系即关联),visited 去重 = 回环防护(每条目至多激活一次);
- 可注入过滤(active + chapters)与种子产线同套语义:失效 / 归档条目既不入候选也不作中转。

**排序键**(`rankActivationCandidates`):

```
① 直接命中(种子,权重 1,虚拟自关联)——场景锚点,永不被插队
② 到达边 emphasized(强 0.9 > 普通 0.5)
③ 跳距(近的优先)
④ 类型优先级(人物 > 世界 > 时间线 > 大纲)
```

- 强关联可跨层插队(二跳强关联 > 一跳普通),但任何递归节点不可插队种子;
- 未标注 emphasized 时权重全平局 → 退化为距离优先(有标注用权重,无标注用距离,不会比现状差);
- 同层多条到达边:强边优先(先到先得,强边覆盖弱边记录);跨层:最近距离优先,不升级。

**已知方向**(见 README Roadmap):预算比例制(跟随模型窗口,参考酒馆 Context % 机制)、每棵树至少一盏灯(多主题保底)、深度前端配置化。

## 4. 章节隔离

- 每章独立会话文件 + 独立草稿:上下文 / 历史 / 分支互不串扰,切章即切换工作现场;
- 编剧 / 导演会话按「书 + 章节」键隔离(`writer-<章节>.jsonl` / `stage-director-<章节>.jsonl`);
- 切章竞态:selectChapter 空闲分支的 ensureServerSession 会清掉刚水合的编剧对话 → 补一次 alignWriter;
- 确认卡按「书 + 章节」归属(confirmScopeRef),书 / 章节变化先清本地卡再恢复,恢复前不写回。

## 5. 记忆

- `memory.md` 跨章记忆(~1500 token):agent 章节收尾自主维护,「最新要点在最上,旧的往下挤」;
- 超预算从最旧段落裁,尾部注明让 agent 下轮精简;
- 写作会话与编剧会话共用同一份记忆(收幕成文与「编剧」标签同一会话)。

## 6. 舞台区(实验)

- **一章一幕**:收幕后这一幕即完结,导演不主动要求续演;新一幕 = 新章节 + 新导演会话;
- **模式切换只有硬信号**:`script_confirm` 调用 → 剧本模式,开演 → 导演模式,收幕 → 讨论模式;无文本关键词检测;
- **剧本确认门**:导演用 `script_confirm` 提交结构化剧本 → 用户卡片确认 → 才可 `stage_script` 开演;
- **信息差即悬念**:演员知识面由导演 inject 规则决定(include-only),演员是共演对等角色,不是导演子 agent;
- **收幕闭环**:编剧成文(写 draft/)+ world_update 回写世界书 + advice.md 下章建议(导演下幕前读到)。

## 7. 目前来看的设计

| 决策 | 理由 |
|------|------|
| web 缺省无 bash(0.0.6 起可显式开启) | bash = RCE 等价面;无鉴权本地服务下任何本机进程都能驱动 agent。默认关 + 风险确认 + 命令与输出实时可见:护城河从「没有这个工具」换成「你看得见它在做什么」——路径守卫管不到 shell,可见性是唯一真正的约束 |
| world_update 唯一变更通道 | 结构性约束(重复 id、悬空引用、多 in-progress、自环)由程序校验,防世界书被绕过破坏 |
| 关联激活用关系图而非内容递归 | 世界书有显式关系数据(emphasized 强关联);酒馆式内容递归(正文提关键词互相触发)列为候选通道 |
| 深度 = 跳距上限而非步数计数 | 计数模型下死路 / 分支会「浪费」步数,覆盖依赖探索顺序;半径模型发现集与顺序无关 |
| 发现与选中分离 | 先穷尽深度内候选,再全局排序 + 预算装填——避免「边发现边注入」饿死其他树 |
| 删除书先释放内存会话 | 否则 AI 继续写 draft/world.json,目录「复活」残留 |
| 导演回复流式 + 思考链转发 | 只转文本会丢 thinking 阶段,看起来「回复完才 stream」（之后可能会改） |
| agent_settled 时序 | settle 在 _runAgentPrompt 的 finally 里、prompt() 返回前发出——先 await 再订阅必然错过;用 runTurn()(send 完成即回合完成 + 超时兜底) |
| worldSummary 限 600 字常驻 | 常驻成本可控;概述先于激活组注入,agent 先读稳定设定再读场景相关 |

## 8. 参考对照

- 酒馆(SillyTavern)调研结论:WI 预算 = Context % 比例制、预算耗尽即停;Min Activations(激活不足往前多扫)与我们「每棵树至少一盏灯」防同一问题;其「深度」= 扫消息数 + 递归层数两个设置,与我们「跳距上限」同名不同物。
- 成本基线(deepseek-v4-flash 实测):单幕(开戏→演出→收幕→成文)≈ ¥0.10-0.14,41 次调用 163k tokens;缓存命中价 0.02 vs 未命中 1 元/1M,保持前缀稳定是最大成本杠杆。

## 9. 插件系统(2026-09,0.0.5)

- **目录装载**:`~/.pi/writer/plugins/<id>/`,plugin.json(id/version/name/description/enabled/backend/frontend)+ 入口(index.mjs,default export = ExtensionFactory,与 vendor InlineExtension 同语义);清单零信任解析(字段级白名单,非法项逐条丢弃,坏插件 error 隔离不阻塞);入口 resolve 后必须在插件目录内(防逃逸);
- **启用双层**:manifest `enabled:false` 强制禁用 > 用户运行时开关(plugin-state.json,缺省 true);「完全信任」同条目(缺省 false),enabled/trusted 分开读写、merge 语义;
- **能力面(定级)**:
  - 后端:工具注册(与 MCP 工具同通道注入 agent);「完全信任」后入口可导出 `routes`(后端自定义路由,segments 自动加 `plugins/<id>` 前缀,内置路由优先于插件路由);
  - 前端:声明式设置菜单(settingsItems 字段白名单 string/number/boolean/select/textarea,值存 plugins/<id>/settings.json,写路径按清单 key+类型校验);声明式斜杠命令(触发词 + webCommands 具名导出,主进程执行、结果回插输入框,只收清单已声明 trigger);「完全信任」后 frontend.mjs(经 GET /api/plugins/:id/frontend.mjs 加载,仅 trusted 返回 text/javascript);
- **安全模型**:插件与主进程同权(似 Obsidian 社区插件),显式启用、不自动安装/更新;trusted 是单一总闸——未信任插件的 routes/frontend.mjs 在装载期/端点双重拒绝,renderer 永不执行未信任用户 JS;开关带「与主进程/渲染进程同权,仅信任自己安装的插件」确认;
- **热重载**:切换启用/信任时重新扫描 + 原生 import(URL 带随机 query 防 Node 模块缓存——jiti/进程内缓存实测改文件后仍返回旧代码);
- **指南与示例**:docs/plugin-development.md;examples/plugins/dice(掷骰子)、examples/plugins/inspire(灵感笔,测试插件)。

## 10. 外部命令与 shell 方言(2026-09,0.0.6)

- **分层缺位**:vendor 没有 `ctx.shell` 那样的执行器抽象——它的 shell 通道 bash 专用(`getShellConfig()`:Windows 只找 Git Bash,找不到直接抛错;spawn 写死 `["-c"]`)。方言支持因此不加壳层,而是复用它**已有**的 `shellPath` 设置:`pwsh -Command` 可缩写为 `-c`,同一 spawn 形态直接跑 PowerShell(实测 `{shell, args:["-c"]}`);代价是退出码语义不同——`pwsh -Command` 会把原生程序退出码折算成 1,故提示词必须要求 `exit $LASTEXITCODE`;
- **解析唯一实现** `src/shell-kind.ts`:显式路径(按文件名判方言)> `%ProgramFiles%\PowerShell\7\pwsh.exe` > PATH `pwsh` > 回退系统自带 Windows PowerShell 5.1(带 warning)。依赖(platform / env / exists / which)全注入,所以能纯逻辑单测——CI 无 pwsh、开发机有 pwsh,断言不会分叉;
- **改提示词而不是改工具名**:vendor 的工具 schema 固定叫 `bash`,改名要动 vendor;选择在系统提示里点明方言。**解析不到就声明无 shell**:不给工具 + 如实叙述,避免「给了一个必然报错的工具」;
- **安全面**:默认关、风险确认、命令与输出实时可见——三者缺一不可,详见 security.md「外部命令(shell)开关」。
