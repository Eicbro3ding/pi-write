# Changelog

## [0.2.0] - 2026-10-07

`delete_relation` 补上静默无操作:世界书写入里最后一个漏网。

- [fix] **`delete_relation` 传错 id 静默成功**(`src/tools.ts`)。`next.relations.filter((x) => x.id !== update.id)` 把一个不存在的 id filter 掉,照样回「已更新世界书」——模型据此以为关系已删、继续推理,而用户关系图上那条线还在。**关系是双向可见的数据,比约束/待办更隐蔽**:约束在文风块里迟早会被下一轮读到,关系图不会。已改为与 `delete_constraint` / `notice_delete` 同口径:先 `find` 判存在,不存在则抛 `WorldValidationError("关系不存在: <id>(未删除任何内容)")`。属上轮(`bf0d215`)修同批静默时的漏网。
- [test] 「删除类 op 不静默无操作」组新增 1 例(正删通过 + 错 id 抛错 + 文案含「未删除任何内容」)。**已反证**:退回旧实现 → 该例变红。

**验证**:typecheck 0 错误;全量 **91 文件 / 1605 例通过** / 2 skipped(较上轮 +1,即本例)。

文档与 skill 同步:T11(依赖化)与 T9-A(MCP 换上游)之后,知识文档还停在 vendor 时代。

- [docs] **skill 知识地图(`.agents/skills/pi-writer/`)整轮校准** —— 它此前系统性描述的是一个**已不存在的仓库**:
  - **开头段**:「核心包全部 vendor 在 `vendor/`,零 `@earendil-works` npm 依赖」→ 改为「四个 pi 包是 npm 依赖,锁精确 1.0.2,本地改动走 `patches/`,**不再有 `vendor/` 目录**」,并补 Node ≥22.19.0 与 `postinstall` 打补丁这两条上手前提;
  - **布局表**:删 `vendor/` 行、加 `patches/` 与 `src/pi-adapter/` 行;`src/mcp/` 从「config/manager/tools 三件套」改写为「装配上游 `createMcpExtension` 的三个胶水文件」;`src/prompt.ts` 行去掉「手工拼 MCP 清单」;
  - **新增 MCP 专节**:决策背景(为什么推翻「留自研」)、三个文件各自的「为什么必须自研」、**四条硬约束**(只有 stdio+http / `exposure` 默认 `direct` / 提示词段不再手工拼 / 上游懒重连),以及工具名 `mcp__<server>__<tool>` 的由来;
  - **新增防腐层约定**:「pi 框架的 import 一律走 `src/pi-adapter/`」,并写明 `src/mcp/` 是唯一例外及理由;
  - **构建命令整段重写**:删掉已不存在的 `tsconfig.tmp.json` / `vitest.tmp.config.ts`,改用仓库根真实配置;补 `npm run build` 与 `build:web` 的产物区别。
- [docs] **`references/pitfalls.md` 换掉 3 条失效记录**:「tsc 的 vendor 类型错误」(vendor 已删)、「@modelcontextprotocol/sdk 顶层导出缺陷」(SDK 已无引用)删除,替换为两条**当前真实**的坑 ——「`npm run build` ≠ `npm run build:web`」(附 2026-10-05 的误判经过)与「改 pi 包要走 patches,别直接改 node_modules」(附路径守卫静默失效的判据)。`references/commands.md` / `architecture.md` 同步。
- [docs] **项目文档**:`docs/development.md` 补「首次 clone 先 `npm install`」「`skipLibCheck` 是必需品」「`build`/`build:web` 两个产物」三处;`docs/architecture.md` 的 `vendor/` 表格行改为 `patches/`、§9 的层级说明随 vendor 移除简化、防腐层措辞从「零 vendor 直接引用」改为「零 pi 包直接引用」(并登记 `src/mcp/` 例外)。
- [docs] `TODO.md` 记入一条 T9-A 副作用:**`@modelcontextprotocol/sdk` 已成孤儿依赖**(自研 MCP 删除后 `src/` 内无引用),建议后续移除。

**验证**:typecheck 0 错误;全量 **91 文件 / 1604 例通过** / 2 skipped;skill 里新引用的 16 个文件路径逐条核实存在;`skill-references` / `skills-index` / `prompt` 三组护栏测试通过。

T13 端到端收尾:用真实构建产物跑出的两处「迁移静默失败」。

- [fix] **http 条目的 `env` 在迁移时丢失**。`legacyServerToUpstream` 的 stdio 分支带了 `env`,http 分支没带 —— `{"type":"http","url":...,"env":{"TOKEN":"abc"}}` 迁移后 `env` 直接消失,**不报错、不告警**,用户只能在工具连不上时反推。已补齐,并加两例断言(http 保留 env、sse 降级后同样保留)。
- [fix] **web 启动丢弃迁移告警**。`web.ts` 调了 `ensureMigrated()` 却扔掉返回值,「SSE 已降级」与「字段不完整已跳过」两条告警全都不打。这两类恰是**静默失败**的典型:旧条目留在文件里不会报错,只是永远不生效 —— 现在逐条打到 stderr。
- [fix] **`npm run web` 会静默跑在过期产物上**。`npm run build` 产的是 `dist/cli.js` / `dist/index.js`,而 `web` 脚本跑 **`dist/web/server.cjs`**(只由 `npm run build:web` 产出)。于是最自然的路径「改源码 → build → web」跑的是旧代码:旧文件还在、能正常启动、**不报任何错**。这正是本轮排查误判「迁移完全没生效」的原因(白查半小时)。新增 `scripts/check-web-fresh.mjs` 前置到 `web` 脚本:比源码与产物 mtime,过期就打醒目警告并给出正确命令,`exit 0` 不阻断启动(「跑旧产物看别的功能」有时是合理的)。**没让 `build` 顺带产 `server.cjs`** —— 那会把 esbuild 全量打包(含前端 vite)塞进每次 build。
- [test] 新增 `test/build-scripts.test.ts`(**3 例**)钉住上面这条:web 脚本必须含自检且顺序在启动之前 / 自检脚本存在 / `build` 与 `build:web` 是两个产物这个事实本身。已**反证**:把 web 脚本改回旧形态 → 测试红。

**验证(真实产物)**:typecheck 0 错误;全量 **91 文件 / 1604 例通过** / 2 skipped;端到端 —— 全新目录 + 旧形状配置 → 自动迁移 + `.bak` 备份 + 两条告警如期打 stderr + `/api/mcp` 读出上游 `mcpServers` 形状 + **二次启动幂等(不重复迁移、不新增备份)**;`POST` 新增 / `DELETE` / `/raw` / 重名拒绝 / `sse` 拒绝 / `exposure` 校验全通过。产物过期自检已正反两向验证(新鲜时静默、触碰源码后如期告警)。

T9-A:MCP 不再自研,直接装配上游扩展(决策 D1 改判)。

**升级影响(有,请读)**:① 配置**自动迁移**——首次启动把旧形状(`{name,type,command,args,env,url}`)改写为上游的 `mcpServers` + `transport` 判别形状,原文件留 `.bak-<时间戳>` 备份,重复启动幂等;② **SSE 服务器不再支持**——上游只实现 stdio 与 streamable HTTP,旧 `sse` 条目迁移时**自动降级为 http 并告警**,web 设置页再保存 `sse` 会被 400 拒绝;③ 新增「暴露策略」字段,迁移产生的新条目一律写 `direct`(与自研时代「工具直接可见」一致),可自行改为 `codemode`(按需加载)/`deferred`/`hidden`;④ **断线不再自动重连**(自研的 3-30s 退避取消,改为上游的懒重连:下次调用时按需连);⑤ OAuth 授权流改由上游扩展提供。以上四条同时写进 `README.md` 与 `docs/security.md`。

- [refactor] **删掉自研 MCP 共 843 行**:`src/mcp/manager.ts`(399 行,连接管理 + 断线重连 + 工具桥接)、`src/mcp/tools.ts`(237 行,工具适配)、`src/mcp/config.ts`(typebox 校验,前置重构后已成死代码)。删掉的理由不是"自研不好",而是**上游 `dist/extensions/mcp/` 约 157KB 已经把同样的事做完且做得更全**(stdio + streamable HTTP、OAuth、资源列表、四档暴露策略、`mcp_servers` 提示词段)——继续维护一份平行实现,等于每次上游升级都要重放一遍。
- [feat] **新增三个胶水文件**(上游替代不了的那部分,合计不到 200 行):`src/mcp/extension.ts`(`createWriterMcpExtension()` 包装上游扩展 —— 写 `PI_CODING_AGENT_DIR` 让上游读 `~/.pi/writer/agent` 而不是 `~/.pi/agent`;注册 `mcp` 命令查状态;`session_start` 时跑一次迁移)、`src/mcp/migrate.ts`(纯函数迁移层:旧形状 → 上游形状、`sse` 降级、备份、幂等)、`src/mcp/host.ts`(`McpHost`:给 web 设置页的配置读写面,工具清单改用 `pi.getAllTools()`)。
- [fix] **`host.ts` 自实现读-改-写**而不是调用上游的 `addMcpServerConfig`——上游**包入口没导出**它(只在 `dist/extensions/mcp/config.js` 里),而 `test/pi-adapter.test.ts` 的护栏禁止深层 import。这是护栏起作用的实例:它逼我们承认"上游没把这个当公开 API",而不是绕过去偷用。
- [refactor] **`cli.ts` / `web.ts` 改为装配 `extensionFactories`**,不再往 `customTools` 里灌 MCP 工具;`src/web/server.ts` 的 `mcpManager` 换 `mcpHost`,删掉 `onReconnect` 钩子(上游懒重连)与 `mcpManager.close()`(生命周期归上游管)。
- [refactor] **`buildWriterSystemPrompt` 不再手工拼 MCP 清单**:MCP 工具的提示词段改由上游经 `before_agent_start` 注入 `sections["mcp_servers"]`。这与 `systemPromptOverride` 是**两条互不干扰的通道**(后者整体替换,前者结构化增量),所以"override 会不会吃掉 MCP 段"的担心不成立——不会。提示词标题随之从「外部工具(MCP)」改为「外部工具」。
- [feat] **web 设置页适配**:服务器类型去 `sse`、新增「暴露策略」下拉(direct / codemode / deferred / hidden)与 `headers` / `enabled` / `description` 字段;保存 `sse` 时给出中文指引而不是静默失败。
- [test] 新增 `test/mcp-migrate.test.ts`(**29 例**,含新旧形状判别、SSE 降级、备份、幂等、保真不覆盖用户 exposure)与 `test/mcp-host.test.ts`(**20 例**,含"原样保留 imports 形状");`test/mcp-api.test.ts` **重写**为真实 `McpHost` + 真实 http 监听(此前用 fake manager,"未装配 404 / sse 拒绝 / exposure 校验"这些路径根本没被覆盖);`test/pi-adapter.test.ts` 护栏清单更新;删除 4 个随自研实现一起作废的测试文件。净结果 **90 文件 / 1599 例通过**。

**验证**:typecheck 0 错误;`npm run build:web` 成功;端到端冒烟 —— `GET /api/mcp` 正确读出上游 `mcpServers` 形状、`POST` 新增 http 服务器成功、`POST sse` 返回 400 并附中文提示、`GET /api/mcp/raw` 正确定位 `~/.pi/writer/agent/mcp.json`。

T11 后续:`npm run build` 产物修复 —— npm 包的 CLI 现在真的能跑。

- [fix] **tsc 不再 emit JS,只出声明**。261 处 `.ts` 相对 import 与 `allowImportingTsExtensions` 是绑死的,emit 出来的 `dist/src/*.js` 里 import 仍写 `.ts`,`node` 一跑就是 `ERR_MODULE_NOT_FOUND`。现在 tsc 只喂 `types`(`--emitDeclarationOnly`,顺带消掉 TS5096),可执行/可引用的 JS 交给 **esbuild** —— 与 `build:web` / `build:electron` 同一套做法。新增 `scripts/build-cli.mjs` 打两个产物,并**自检产物里不许残留 `.ts` 相对 import**:这是本次修复的核心,也是最容易悄悄退回的形态(哪天有人把 build 改回 tsc emit,编译照样"成功",只有用户启动时才炸)。
- [fix] **bin 的 off-by-one**。`src/prompts.ts` 探测 prompts 的最后一态是 `join(here, "..", "prompts")`,`here` 是**模块所在目录**。产物放 `dist/src/cli.js` 时上跳一级是 `dist/prompts`(不存在),而 `files` 白名单里 prompts 在**包根** —— 装完一启动就「提示词文件缺失」。产物改放 `dist/cli.js`,上跳一级正好命中包根。`exports.import` 同步改指 `./dist/index.js`(放 `dist/src/` 会撞同一个坑,实测一 import 就抛)。
- [fix] **首页 404**。`resolveWebDistDir` 的回退只写了 `here/../../web/dist`,而 `here` 的深度**随运行形态变化**:源码 `src/web`、tsc 产物 `dist/web`、esbuild 单文件 `dist` —— 单文件形态会跳过头,于是 API 全通、只有页面 404。改为**逐个候选**;`resolveBuiltinThemesDir` 同病同修。
- [fix] **探测失败现在会喊**。静态目录找不到时启动即打一行红字(仅**自动探测**失败时 —— 显式传 `webDistDir` 而目录不存在,那是调用方的决定,测试常这么干)。否则「一半像好的一半像坏的」最难排查。已**反证**:移走 `web/dist` 后警告如期打出、首页 404。
- [chore] `files` 加 `web/dist`(28M)。否则 `npx pi-writer --web` 服务起来了却是 404 —— 既然 `bin` 提供 `--web`,前端就得跟着走。
- [env] 环境升到 **Node 22.19.0** 后,才第一次在「满足 `engines`」的前提下跑完验证 —— 此前所有验证都在 22.13.1(低于要求、靠 EBADENGINE 告警而非硬失败)上做的。

**验证(Node 22.19.0)**:typecheck 0 错误;全量测试 **92 文件 / 1596 例通过**;`dist/cli.js --help` 正常(**版本号 0.1.2 正确** = prompts 探测命中,此前冒烟显示 0.0.0);`dist/index.js` 可 import(25 个符号);web 冒烟 `GET /` 200 + `/api/skills` 200;`build:web` 回归正常。

T11 后续:路径守卫 patch 加固 —— 形状不对时**安装即炸**。

- [fix] **`setToolPathGuard` 增加形状检查**。调用点写的是 `__piWritePathGuard?.(resolved, mode)`,而可选调用只防 `undefined`、**不防「传进来的是个对象」**。那种情况下每次解析路径都抛 `__piWritePathGuard is not a function`,而所有 `expect(...).toThrow()` 断言**照样通过** —— 又是一次「看起来拦住了」:实际是 TypeError 在顶替真实拦截(我在临时脚本里传错过一次,看到这句费解的错误才发现)。现在安装时就炸,并报出实到的类型。
- [test] `test/tool-guard.test.ts` 新增一条断言钉住它(传对象 / 传字符串都要抛「路径守卫必须是」,传 `undefined` 不抛 —— 那是卸载语义)。`patches/README.md` 补为**错误形态三**,与前两种(只改 path-utils 不改调用方、只改 .js 不改 .d.ts)并列。
- [验证] 重装依赖(`rm -rf node_modules/@earendil-works/pi-coding-agent && npm install`)确认新 patch 生效;`verify-pathguard-patch.mjs` 全通过(含反证);全量测试 **92 文件 / 1596 例通过**(+1 即本条断言)。

T11 后续:Node 版本要求同步到 ≥22.19.0(原计划里的 T12,因依赖化而提前)。

- [fix] **`engines` 与实际要求不符**。四个 pi 包(`pi-coding-agent` / `pi-ai` / `pi-tui` / `pi-agent-core`)的 `engines.node` 全是 **≥22.19.0**,而本项目 `package.json` 写的是 ≥18.20.4。vendor 时代源码随仓库编译,**根本不吃上游的 engines**;改成 npm 依赖后这条才第一次生效 —— `npm install` 会打 EBADENGINE 告警,**不看告警的人用 Node 18 装完会在运行时崩**。已同步四处:`package.json`、`package-lock.json`、`README.md`、`docs/development.md`。
- [验证] `npm install` 后 `postinstall` 重新打 patch 仍然生效:守卫装得上,越权写被拦(见下一条的形状检查)。

T9-B:TUI 代码保留,但不再对外提及。

- [docs] **清理 11 处对外提及**(模型可见 + 用户可见):
  - `prompts/writer-main.md` —— 最关键的一处。写作 agent 的**角色认知**里不该出现产品形态名(它只需要知道「有个常驻草稿面板」),原话「TUI 在聊天区右侧显示…」改为「界面里有一个常驻草稿面板(聊天区右侧 / 正文区,视界面而定)」。
  - `skills/onboarding/references/feature-tour.md` ——「三个入口」→「两个入口」,删掉「终端界面(TUI)」整行,「三者共用同一份数据」→「两者」。
  - `skills/onboarding/references/style-setup.md` —— 删掉范围表里的「(含 TUI)」。
  - `README.md` ——「全屏 TUI」→「终端交互」、「TUI 全屏编辑器」→「终端全屏编辑器」、命令示例「`# TUI:`」→「`# 终端:`」、`bundle` 说明「TUI 单文件可执行」→「终端单文件可执行」(顺带去掉原先那句自问「真的有人用TUI吗🤔」)。
  - `src/cli.ts` 的 `--help` 文案 —— `Commands inside the TUI` → `Commands inside the interactive session`。
- [决策] **代码一行不动**。TUI 有用(终端交互、内置编辑器、草稿面板都在),要清的是**提及**,不是实现。因此 `docs/`、`.agents/`、代码注释里的 TUI 字样**一律保留** —— 那些说的是架构事实:代码还在,架构文档里写「有 TUI」是准确的;而角色提示词里写「TUI 在右侧显示草稿面板」是在教模型一个它本不该知道的产品形态。两者的分界是**谁在读、读了会拿它做什么**。

**验证**:类型检查 0 错误;全量测试 **92 文件 / 1595 例通过**。

T11 步骤 5:删除 vendor 目录 + 构建链收尾(T11 / D2 依赖化)。

- [remove] **删除 `vendor/`(5.8M,6 个 pi 包源码)**,用 `git rm -r` 保留删除记录(将来要回看某条自研改动还有据可查)。删前先跑「运行时 vendor 引用」扫描:285 个文件、**零命中**才算过 —— 注释里的示例路径、以及 `test/pi-adapter.test.ts` 里那条 `t.includes("vendor/pi-")` **判据本身**不算(删它等于拆护栏)。
- [fix] **两个 tsconfig 的 `include` 去掉 `vendor/**\/*.ts`**。顺带更正 `tsconfig.json` 的「已知噪音」一节:那 3 处错误(undici ×2、highlight.js ×1)随 vendor 一起消失,现在 **`tsc --noEmit` 的输出应当为空**;并写明 `skipLibCheck: true` 是依赖化后的**必需品**(`pi-ai` 在 NodeNext 下有约 30 个 TS1543),关掉它那 30 个噪音会淹掉真信号。
- [fix] 🔴 **`npm run typecheck` 此前一直是假通过**。脚本写的是 `tsgo`,而这个环境里**根本没有 tsgo**(只有 `tsc` 5.9.3):`tsgo: not found` 进管道后 `grep -E '^src/'` 匹配不到,于是 `|| echo 'src/ 类型检查通过(0 错误)'` 打印「通过」—— **命令不存在被当成了检查通过**。这正是本项目反复踩的那一类坑:不是「检查说没问题」,而是「检查压根没跑」。`build` 脚本同样写 `tsgo`,直接失败。已改为 `tsc` 并去掉 `|| echo` 这层吞错;`build` 的 chmod 目标也从 `dist/cli.js` 修正为 `dist/src/cli.js`(与 `package.json` 的 `bin` 对齐)。**真实类型检查:0 错误**。

**验证(删 vendor 之后)**:类型检查 0 错误;全量测试 **92 文件 / 1595 例通过**;`npm run build:web` 成功(`server.cjs` 15MB,629 处静态 require 全是 `node:` 内置或可选依赖 —— pi 包确实被完整内联);**CLI 冒烟**(esbuild 打包后跑 `--help`)正常启动,说明 pi 依赖与 patch 在**真实启动路径**上可用,不只是测试里可用。

**发现一处既有破损,本次未修**:`npm run build` 的产物**不可用** —— tsc emit 出的 `dist/src/*.js` 里 import 仍带 `.ts`(源码里 261 处),`node dist/src/cli.js` 直接 `ERR_MODULE_NOT_FOUND`。根因是 `allowImportingTsExtensions`(tsc 因此报 TS5096)与「源码 import 写 `.ts` 扩展」绑死。真实发行走的是 bun / esbuild 单文件(`bundle`、`build:web`、`build:electron`),tsc 产物这条路径**依赖化前就是坏的**,不是 T11 引入的回归。修法二选一:① 261 处相对 import 改 `.js`(NodeNext 下 ESM 必须带扩展名,TS 会解析回 `.ts` 源文件);② `build` 不再 emit,只做类型检查与声明输出。**待定**。

T11 步骤 4:构建链与打包适配(T11 / D2 依赖化)。

改的是「按 vendor 路径取文件」的那几处 —— 它们**改错了不会报错**:`files` 里写个不存在的路径,npm 安静跳过;`shx cp` 一个不存在的 glob,安静地什么都不拷。发行物少了主题 json 或缺了 MIT 许可全文,要等用户装完跑起来才现形。

- [fix] **`pi-coding-agent` 补锁精确版本**。`package.json` 里另外三个 pi 包都是 `1.0.2`,唯独它是 `^1.0.2` —— caret 会装到 1.0.3,而 patch 的靶心是 1.0.2 的 dist,且 1.0.3 的 pi-tui 有破坏性变更(前置核实时已踩过一次)。
- [fix] **主题 json 改指 node_modules**:`bundle` 脚本 `vendor/pi-coding-agent/src/modes/interactive/theme/*.json` → `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/*.json`。已确认包内含 `dark.json` / `light.json` / `theme-schema.json`。
- [refactor] **pi 许可声明迁出 vendor**:`git mv vendor/LICENSE-pi.txt LICENSE-pi.txt`(保留历史便于追溯来源);`vendor/NOTICE.md` 改写为根目录 **`NOTICE-pi.md`** —— 内容从「vendored 源码声明」改成「**npm 依赖 + patch 声明**」:包与版本表、为什么不再 vendor、三条本地修改及各自为什么不能没有、被判定不重放的能力(`sidePanel` / `uiMode`)、升级时要看的地方。`package.json` 的 `files`、`electron-builder.yml` 的 `files`、`THIRD-PARTY.md` 三处白名单与措辞同步。
- [test] **两处读 vendor 源码的测试改为读 npm 包**:`skill-invocation.test.ts` 展开态正则同源对照读 `node_modules/.../dist/core/agent-session.js`(**已验证**编译不改写正则字面量,与 vendor 逐字相同);`skill-references.test.ts` 的 `loadSkills` / `formatSkillsForPrompt` 改走**包主入口**(1.0.2 的 `dist/index.d.ts` 已导出这两个,无需新增子路径)。
- [test] **`scripts/t11/verify-build-chain.mjs`(新增)**:把三处发行白名单 + 测试里的固定路径展开成**存在性断言**(34 条)。已做**反证测试** —— 往 `files` 里塞回失效的 `vendor/LICENSE-pi.txt`,脚本 exit 1 并点名该路径;还原后 exit 0。

**验证**:`npm run typecheck` 0 错误(此时 vendor 仍在);全量测试 **92 文件 / 1595 例通过**。

T11 步骤 3b / 3c:适配 pi-tui 1.0.x 类型 + 处置 vendor 自研能力(补记,提交 `8cb3cbd` / `2c82e2e`)。

- [fix] **路径守卫在测试里一次都没拦** —— 双实例静默失效:测试 import vendor 的 `path-utils`,而守卫装到 npm 包那份上,两者是独立模块实例,10 条「应该抛错」的断言全部静默通过。**又是「能力在,不等于接对了」**:编译正常、运行无报错。改指包名后 17 例恢复。
- [fix] **鼠标与主题类型适配**:新增 `src/editor/mouse.ts` 的 `sgrMouseFromUpstream`(上游 `TuiMouseEvent` 0-based / `type`+`wheelDelta` ↔ 自研 `SgrMouseEvent` 1-based / `kind`+`delta`),几何逻辑一行未动;`writer-theme.ts` 改用 `ConstructorParameters<typeof Theme>`(`Record<ThemeColor, string>` 与 `Record<keyof …>` **都会丢 `Partial`**);`cli.ts` `uiMode` → `tuiMode`;防腐层判据从「查 vendor 相对路径」升级为「查任何绕过包入口的 pi 深层引用」。
- [refactor] **按「不影响 web 与整体核心功能的自研移除」处置 4 处差异**:`setToolPathGuard` 是安全边界保留(已 patch);`sidePanel` 只影响 TUI 横向分栏 → 改 `aboveEditor`;`uiMode` 跟随上游改名;`deepSeekDynamicModel` 修的是 BUG-003(新推理模型选不到思考档位),**属核心故迁到 `src/providers/deepseek-dynamic.ts`**。类型错误 13 → 2(剩余为 vendor 自身 undici,删 vendor 后消失)。

T11 步骤 3:8 个文件 import 改写为 npm 包名(T11 / D2 依赖化)。

- [refactor] **11 处 vendor import 改为 npm 包名**。`src/pi-adapter/*`(7 文件)+`src/util/uuid.ts`,共 11 处 import 语句:`../../vendor/pi-coding-agent/src/index.ts` → `@earendil-works/pi-coding-agent`,依次类推 pi-agent-core / pi-ai / pi-tui;两个深层路径 `src/core/tools/path-utils.ts` / `src/core/usage-totals.ts` 改为包内子路径。注释里的示例路径**不动**(那是文档)。
- [feat] **依赖落地**:`@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui}` 加为直接依赖,锁定精确版本 **1.0.2**(与探针报告、patch 靶心对齐);`typebox` 1.3.7 → **1.3.27**(与上游对齐,避免双实例)。
- [feat] **`scripts/apply-patches.mjs`**:patch 应用脚本(应用 dist patch + 注入 exports 子路径),已挂 `postinstall`,幂等。`patches/pi-coding-agent-pathguard.patch` 更新为**5 文件**(4 个 `dist` + 1 个 `.d.ts`)。
- [fix] **补 `.d.ts` 是 patch 的必要部分**。首轮只打 `.js`,TypeScript 报 `has no exported member 'setToolPathGuard'` —— 上游类型声明 `resolveToCwd(filePath, cwd)` 未含 `mode` 参数、且未声明 guard 函数。patch 必须同时改 `.d.ts`。此坑探针报告未覆盖,已补入 `patches/README.md` 的「错误形态二」。
- [fix] **`package.json` 不进 patch**。首版把 exports 改动固化进 diff,导致 npm install 重写 package.json 后 hunk 失配。改为脚本注入,与版本解耦。
- [docs] **实测:patch 的 5 个锚点在 1.0.2 与 1.0.3 上均命中** —— 二者 dist 结构一致,补丁版本间无变化。

**遗留(净增 11 个类型错误,已知、非本步引入)**。类型检查基线(vendor import)为 **2** 个错误(均为 vendor 自身的 undici 问题);改用 npm 包后升至 **13** 个。净增 11 个全部是 **vendor 源码与 npm 发布版的 API 差异**,与 import 改写无关:

| 文件 | 数 | 根因 | 归属 |
|---|---|---|---|
| `extension.ts` / `writer-theme.ts` / `draft-panel.ts` / `editor/vim-file-editor.ts` / `editor/index.ts` | 9 | `pi-tui` 发布版 TUI 类型(`TuiMouseEvent` 取代 `SgrMouseEvent`;主题色新增 `scrollbarTrack` / `scrollbarThumb` / `searchMatchText`) | **T9-B 待删代码** |
| `cli.ts` | 1 | `InteractiveModeOptions.uiMode` → `tuiMode`(上游发布版改名;vendor 源码仍是 `uiMode`) | 独立小改 |
| `ask-user.ts` | 1 | 上游 `details` 要求 `JsonObject`,`AskUserDetails` 缺索引签名 | 独立小改 |

处置顺序:先做 **T9-B**(撤除自研全屏 TUI,消掉 9 个),再修 `cli.ts` / `ask-user.ts` 两处。

T11 步骤 2:工具路径守卫的 npm 依赖 patch 落地(T11 / D2 依赖化)。

- [feat] **`patches/pi-coding-agent@1.0.2-pathguard.patch`(5 文件 / 279 行)**。上游 1.0.2 未导出 `setToolPathGuard`,且 `exports` 未开 `./core/tools/*` 子路径,自研侧无法从包外接入,只能 patch 编译产物 `dist/*.js`。patch 内容:`path-utils.js` 注入 `pathGuard` 变量 + `setToolPathGuard` / `clearToolPathGuard` + `resolveToCwd` 加第 3 参数 `mode`;`write.js` / `edit.js` / `edit-diff.js` 三处调用方同步传 `"write"`;`package.json` 补 `./core/tools/path-utils` 与 `./core/usage-totals` 子路径。
- [fix] **防「写入守卫静默失效」**。这是本次最大的坑:只 patch `path-utils.js` 而不改三个调用方,所有调用都会落到默认值 `"read"`(放行模式),越权写入悄悄成功且**编译通过、运行无报错**。`scripts/t11/verify-pathguard-patch.mjs` 里有一条**反证测试**专门锁住这个形态(在只拦写入的守卫下,不传 mode 时 `/etc/passwd` 写会被放行)。
- [test] **真实越权读/写回归(不靠「编译通过」)**:书内读放行 / 书内写放行 / 越权读 `~/.pi/writer/agent/auth.json` 拦住 / 越权写 `/etc/passwd` 拦住 / 默认 read 语义下读 auth.json 拦住。全部在真实 1.0.2 包上执行,非静态断言。
- [docs] **更正 patch 规模:9 文件 → 5 文件**。T11 探针 §3 曾列 9 个文件。实测确认 `read.js` / `grep.js` / `find.js` / `ls.js` **不用改**(走默认 `"read"`,语义本就正确),`usage-totals.js` **不用改**(`getUsageCostBreakdown` 上游本就已导出,只缺 `exports` 子路径)。

移除采样参数调节(temperature / topP,D6)。

- [remove] **删掉温度/top_p 的用户入口**:`--temperature` / `--top-p` 命令行长选项、`POST /api/sampling` 端点、设置页「采样参数」整块(滑块 + 手机页入口 + 分类索引)。`stage_cast` 工具也只再收 `model` / `thinking`。
- [remove] **删掉三级覆盖链**:① 用户入口(CLI / web / 前端);② 舞台演员级覆盖(`cast.json` 的 `ActorSpec`、`orchestrator.updateActorSpec`、`setSamplingParameters`);③ host 与 session-factory 的透传层(`writer-host` / `stage-host` / `session-host` / `session-factory`)。`SessionHost.runtimeDefaults` 与 `captureRuntimeDefaults` / `applyRuntimeDefaults` 里采样那一路一并消失 —— 它只在 runtime 重建时用来恢复会话级设置,采样没了就没有存在意义。
- [fix] **旧 `cast.json` 宽容忽略,不报错也不清理**。移除后旧书可能仍带 `temperature` / `topP`,且历史数据可能越界。`cast.ts` 的 `isActorSpec` 与 `validateCast` **刻意不再校验**这两个字段(删掉原「必须在 0..2 / 0..1」的越界检查),`saveCast` 也原样保留 —— 判据是「旧书必须还能打开」。用测试固化这条承诺(旧字段越界值 2.5 / 1.2 也 `validateCast() === []`)。
- [docs] **更正一处归档错误**:T8 的 B 类审阅曾把 `agent-session.ts` / `sdk.ts` / `settings-manager.ts` 的采样参数列为「上游零命中 → 必须保留」。逐层追溯后确认**结论有误** —— `temperature` 是 `vendor/pi-ai` 里 **11 个 provider 适配器**共用的标准请求参数(`types.ts:117` 的 `Options.temperature` 是上游公开 API),上游全链路本来就有,我方只是在自研侧接了线。假阳性源于只 grep 了 `pi-coding-agent` 一个包、漏了 `pi-ai`。**净效果**:必须重放的 B 类改动从「约 147 行 / 4 文件」降到**约 24 行 / 1 文件**(只剩 `path-utils.ts` 的 `setToolPathGuard` 安全边界)。
- [docs] **不动 vendor**。既然温度本就是上游能力(且 D2 已定 npm 依赖化,vendor 整体将被依赖替换),在其内部手工裁剪属纯浪费。本次 `vendor/` 零改动。
- [test] 测试同步:`test/server.test.ts` 删 `/api/sampling` 两组用例与两个宿主 stub;`test/session-host.test.ts` 删转发用例、`reloadRuntime` 两组断言摘掉采样部分(BUG-009 的模型/档位恢复覆盖仍在);`test/stage-orchestrator.test.ts` 把采样用例改写成「模型/思考级别」+ 新增「旧字段宽容忽略」;`test/stage-cast.test.ts` 越界用例改写成兼容承诺;`test/web-cli.test.ts` 删 `--temperature`/`--top-p` 解析用例。**全量 92 文件 / 1595 例通过**,`src/` 与 `web/` 类型检查均 0 错误。

世界书写入的安全性:补「静默无操作」与「静默清空」两处(`src/tools.ts`,P0-b/P1)。

- [fix] **`delete_constraint` / `notice_delete` 补存在性校验**。这两个 op 原先直接 `filter` 掉一个不存在的 id 就返回 —— 传错 id 时**静默无操作**:工具回「已更新世界书(delete_constraint)」,模型据此以为删掉了、基于「约束已删除」继续推理,而用户那边规矩还在。同文件的 `delete_entry` / `notice_update` / `update_timeline` 一直都有这个校验,这两处是漏网。现在报错并附加「未删除任何内容」,符合本文件 narrowOp 注释写下的原则:「不静默无操作,报错原样进上下文让模型自我纠正」。
- [fix] **`update_style_sample` 拒绝空采样**。采样是**作者文风基准**,而这条 op 是它唯一的写入路径、且刻意不写编辑记录(前端连预览卡都不弹)—— 模型一旦传出空串(常见于它以为自己拿到了内容),采样就**静默归零**,用户要过很久才发现「AI 写得不像我了」。`read_style` 的读侧早已为「没有采样」写了护栏,这条把写侧补上,两侧对称。**这不是禁止清空** —— 清空是合法意图,但该由用户明确要求(直接改 world.json),而不是模型一次参数失误的副作用。
- [feat] **条目正文被清空时附提示行(`emptiedEntryBodies`)**。`upsert_entry` 带 `body: ""` 能把人物小传清空,而这本身可能是合法意图(占位条目、废弃设定),故**不拦**;但与 `writeDeltaLine` 同一个思路 —— **不阻止,但让损失可见**:「非空 → 空」这个跃迁最常见的成因是模型漏带内容,而工具只回「已更新世界书」,看起来完全正常。现在附一行「本次把「林昭」的正文清空了……你多半漏带了 body」。
- [test] `test/tools.test.ts` +7 例:两类删除 op 的「正确 id 正常删 / 错 id 必须抛错 / 报错文案说明世界没变」、空采样被拒且原采样仍在(不是「清空后报错」)、`emptiedEntryBodies` 的三种情形(非空→空报、本来就空/变长不报、新建不算)。已用变异测试验证有效性(还原旧行为后 3 例立即失败)。

**关于「拦删除」的边界(本轮刻意不做)**:条目删除**不加**硬拦 —— 它与空内容 `write` 不是一类:模型删条目时**意图明确**(用户说「删掉那个临时角色」),且结果**当场可见**(前端有 `last-world-edit.json` 的 diff 预览卡)。给这种动作加确认门槛成本高、收益低,还会挡住正常操作。删除侧真正的空白是没有 undo(只能从 `.bak` 手动恢复,而下一次保存会覆盖它),那是另一个量级的工程,需要时单独做。

护栏统一注入:上一轮那次工具护栏修复其实**没生效过**(TUI 冻结后的收口,P0)。

- [fix] **护栏只挂在 TUI,真正出事的会话全都没有。** `write` 拦空内容 / `read` 拦循环的护栏注册在 `writerExtension`(`extension.ts`)上,而 `writerExtension` 只在**两处**装配:`cli.ts`(TUI 主会话)与 `web.ts`(web 主会话)。真正会调 `write` 写正文的会话是另两类 —— `writer-host.ts` 的**编剧/编辑 agent**(`initialActiveToolNames` 含 write/read)与 `stage-extension.ts` 的**导演/演员/收幕编剧**(`activeTools` 含 write),它们的 `extensionFactories` 里都没有 `writerExtension`。而 `writer-c-v05ij1` 那次「空内容把 2824 字第二章清零」的事故**恰恰发生在编剧会话**——护栏上线后原事故可原样复现,连「2824 字掉到 0」的字数告警也一起缺席(那条也在同一个钩子里)。
- [feat] **抽出 `writeRailsExtension`,由 `createSessionRuntimeFactory` 统一并入**(新增 `src/write-rails-extension.ts`)。把与 UI 无关的三个钩子(`tool_call` 拦空内容/读循环、`tool_result` 字数与丢内容告警、`before_agent_start` 读取护栏按轮重置)从 `writerFactory` 里抽出,改由 `session-factory` 在所有装配点统一注入,排在调用方扩展之前(保护性扩展先生效)。与 `sessionSkillDirs` 同款教训 —— 那处注释早就记着「需要每个调用方记得传的东西迟早会漏,漏传就是静默故障」,这次是同一个坑的第二次。
- [refactor] **`bookSlugFromSessionFile` 上移到 `book-files.ts`**(`src/book-files.ts`)。它原先是 `extension.ts` 的私有函数,而新抽出的护栏扩展同样需要它 —— 护栏必须在所有会话里生效,不能依赖某个扩展文件,故放到路径工具模块两边共用。
- [docs] **TUI 冻结**:本次**不删**任何 TUI 代码、不改其行为,只在装配层面换接线方式;TUI 的 UI 钩子(`session_start` / `turn_end` / `model_select`)原样保留在 `extension.ts`。记忆锚与 `session_before_compact` 仍只在 TUI 路径(本轮有意未搬,见下)。
- [test] `test/rails-wiring.test.ts`(5 例)**装配防回归**:断言 session-factory 确实并入了 `writeRailsExtension` 且排在调用方扩展之前、护栏文件自己声明了三个运行时钩子、**四个装配点都不得自行补装**(避免两套机制并存)、护栏已从 `extension.ts` 移出但 TUI 的 UI 钩子仍在。已用变异测试验证过有效性(移除统一注入后 2 例立即失败)。

**已知边界(本轮故意没做)**:记忆锚(`before_agent_start` 注入 memory/Notice/发展线)与 `session_before_compact`(压缩保用户原话)**仍只挂在 TUI 路径** —— web 编剧会话同样没有它们。它们会改变 web 会话的 prompt 内容,影响面比工具护栏大,留作下一轮单独评估。

文风采样从「到处注入」收口成「只有一个入口」:`read_style` 按需读(`src/tools.ts`,P1-3)。

- [feat] **新增 `read_style` 工具**(`style_update` 的**读**对偶)。此前文风采样虽然存在数据里,模型手上却**没有任何把柄够得着它**:`world_find` 只回 id/type/title/status(连条目 body 都不给),采样更是 world.json 的**顶层字段**而不是条目,导出视图 `.writer/` 只有 characters / world / timeline 三份——剩下的唯一办法是 `read world.json`,那会把整本世界书倒进上下文,比常驻还亏。这是第二个 `read_chapter` 式处境:东西在系统里,可用的人拿不到。
- [fix] **同时拆掉稳定块的一路重注入触发**。上一轮查出「写作稳定上下文」被注入 16 份(每份都自称长期有效),成因是**世界书每改一次内容就变、指纹就变、旧的又删不掉**;而采样按提示词纪律「明显变化则换新,从当前章草稿选 300–500 字」——**每写一章就可能换一次**,是这套堆叠的第二大来源。挪出稳定块后,改采样不再连带重写整个 stable 块。
- [fix] **讨论轮不再为它在稳定块里付全价**。稳定块是直接并进会话前缀的(每轮都是全价未缓存输入),此前讨论设定、评戏、只改一个句子的那些轮同样带着那 300–500 字。现在它只在真的要动笔时出现。
- [fix] **没有采样时必须给出去路**(护栏的一贯做法):空回执会让模型以为可以随手起调子,文风就这么静默漂移了。工具明写两条出路(向用户要样本 → `style_update` 落盘 / 用户说先写着 → 在回复里声明「语感是我暂定的」),外加一句禁令:**不要自己编一段、然后声称那是用户写的采样**。
- [docs] **「上下文里没有这个块」不等于它没有**。采样挪走后这条必须讲清楚,否则开场纪律会变成「每章都重问一遍风格」:`prompts/writer-main.md` / `writer-editor.md` 的开场纪律改成**以 `read_style` 的回执为准**,背景包那条也补上「缺的块用工具确认」。场景节奏清单加第 1 步「取回文风采样」,工具序列改成 read_style → read_chapter → write/edit → word_count。`skills/onboarding/references/environment.md` 同步(采样那行原本写着「每章开写前注入」)。
- [test] `test/tools.test.ts` +7 例:有采样回全文与出处、无出处时标「未标注来源」、空白正文视同没有、**没有采样时必须有下一步**、与 `style_update` 成对的读写往返、无必填参数、描述里写明「动笔前取一次」。

- [feat] **采样从此只有 `read_style` 一个来源**(单源)。起初只挪了 web 稳定块,核对后发现它**同时有三条路进上下文**:稳定块、切章背景包(`buildChapterContext` 的常驻组)、舞台收幕委托消息。前两条留的都是**快照** —— 采样按纪律「明显变化则换新,从当前章草稿选 300–500 字」,每写一章就可能换一次,于是「注入那一刻」很快就成了旧版本,却仍顶着一个看起来很权威的块标题;模型不会去重抄一遍,也不知道该去校对。现在背景包与稳定块都不再拼它(唯一例外是舞台收幕的委托消息:那是一次性任务,消息里没有后续工具回合,必须自带材料才自包含)。
- [docs] 注入顺序文档跟着更正:`docs/design.md` / `docs/architecture.md` 原先写着「先裁采样、仍超再裁概述」,现在常驻组只剩「约束 + 概述」,裁剪顺序亦随之变成「先裁概述」。上下文检视面板与 TUI 面板里不再有「文风采样」那一段(`TRIM_IMPACT` / `TRIMMABLE` / `KIND_LABEL` 同步),`TrimRecord.kind` 与 `ContextSection.id` 里的 `"sample"` 一并删除 —— 不是留着当历史,否则下一次又会被当成一个还能装东西的位置。
- [test] **单源护栏**(`test/world-context.test.ts`):扫 `src/**/*.ts`,断言「【文风采样】」这个块标题只出现在 `src/tools.ts`(`read_style` 的输出)与 `src/stage/orchestrator.ts`(一次性委托)里;再加一条「背景包 / 稳定块的装配函数不再引用 `styleSample`」。运行时用例改成「采样是刻意移走的」口径:采样既不注入也**不进** `trimmed`(它不是「被裁掉了」——被裁意味着调大预算就能回来,而采样是刻意移走的,调预算回不来)。

会话模式:每轮先判定「用户这一轮要不要我动笔」(`src/session-mode.ts`,P1-1)。

- [feat] **`detectSessionMode` + 记忆锚【当前模式】行**:每轮 `before_agent_start` 用用户原话判定模式(讨论态 / 写作态 / 修订态),写进记忆锚第一行。治的是会话里**5 次喊停模型照跑**,其中一次直接把 2824 字的第二章写成了 0 字节(L118 统计出 2824 字 → L121 用户说「我还没叫你开始写」→ L123 清空)。此前每一轮模型都得靠通读上下文重新推断「现在能不能写」,上下文越长越推不准;现在是显式状态,抬头看见就是。默认**讨论态** —— 判错的代价不对等:讨论轮最坏一句话没写,写作轮判错最坏悄悄改坏用户的稿子。
- [feat] **优先级:喊停 > 修订 > 写作 > 讨论**,信号词全部取自真实会话里用户说过的原话。「这句重写一下」判修订态而不是写作态 —— 二者信号表里都有「写」,但一个是改已有的、一个是产新的,不能混。「别担心谅解……我们先讨论」这类含糊句一律落到讨论轮。
- [feat] **记忆锚的模式行独立于世界状态**:书里还没有 memory.md / 世界书时也照样注入 —— 用户喊停最常发生在刚开章、什么都还没沉淀的时候,那时恰恰最需要这条约束。
- [docs] `prompts/writer-main.md` 新增《会话模式》段:三个模式的权限表 + 「用户的原话优先于记忆锚」。**刻意不做工具拦截** —— 判错时把用户正常的写作拦下来,远比让它多跑一个工具糟糕;真正不可逆的那一条(空内容覆盖)已由工具层零误判地拦住。

稳定上下文的多版本治理(`src/web/writer-host.ts`,P1-2)。

- [fix] **16 份「长期有效」的设定互相打架 —— 「背景包堆叠」真正的代价。** 复盘 `writer-c-v05ij1`:同一个「写作稳定上下文」被注入 **16 份**(760 → 3885 字)并全部留在 leaf 链上。成因不是没做去重(指纹去重一直在),而是**世界书每改一次,稳定块内容就变、指纹就变,于是再注入一份,旧的没删** —— 第 1 份和第 16 份对同一个人的写法已经不同。用户抱怨「我不是曾经介绍过本我侵蚀吗」「笔记里不都有吗」,正是因为模型对着十几份互相矛盾的设定不知道该信哪一份。
- [fix] **版本牌照**:删不掉就挂清楚。 旧 custom 消息已落进会话树并被 ack,parentId 链不能断,所以不去删;改为在新版本上标清楚:标题写「第 N 版 · 取代此前所有同名条目」,正文声明「更早的同名条目是改动前的旧快照,冲突时只以版本号最大的为准」。`countStableContextInLeaf` 现数已有份数 +1,`renderStableContext` 负责文案(抽出纯函数以便单测)。
- [docs] 主提示词同步这条规矩:背景包「可能不止一份,冲突时只认版本号最大的那一份;拿不准就 read world.json」。

防回归护栏(`test/prompt-tools.test.ts`,P2)。

- [test] **工具集 ⊆ 提示词工具清单**(双向):这里对齐的是 `read_chapter` 那次事故的反面 —— 工具**注册了不等于告诉了模型**(工具 schema 随请求发给模型,可提示词明说「以下是你可用的基础工具」并给了张清单,模型服从提示词,于是它自上线起就是死代码:会话里 `read` 调了 117 次、`read_chapter` 0 次)。工具集一律**从生产代码取**(`writerToolset()` + 扫 `extension.ts` 的 `registerTool`),以后加新工具自动纳入,不用有人记得回来补名单。反向同样钉住:提示词点名了却没装配的工具会被揪出来。
- [fix] 顺带补两处被它揪出来的缺口:`prompts/writer-editor.md` 没提 `world_find` / `read_chapter` / `ask_user`(编剧工具集给了这三种)。
- [test] **负面示例留在提示词里**:把真实会话里自己踩出来的 `offset` 轨迹(`1 → 25 → 80 → 180`,越界后又回头 `170 → 160 → 145 → 155 → 150 → 140…`)写进 read 纪律。光说「不要反复读」没用,要说清楚*长什么样*叫反复读。
- [test] 新增 47 例(`prompt-tools` 11 / `session-mode` 12 / `stable-context` 13 / `memory-anchor` +3 / `tool-rails` 8)。

工具护栏:把「只写在提示词里拦不住」的两条规则下沉到工具层(`src/tool-rails.ts`)。

- [feat] **`write` 拦空内容覆盖**(`tool_call` 钩子):复盘会话 L118 计到 2824 字 → L121 用户说「我还没叫你开始写」→ **L123 `write` 了 0 字节把第二章清空**,而工具回「Successfully wrote 0 bytes」,看起来像成功。提示词写着「write 会整体替换,优先用 edit」,模型照样照做。**提示词约束愿意遵守的模型,工具层才约束不愿意遵守的模型。** 拦截理由带三条出路(edit / 一次性给全内容 / 先回复用户)。
- [feat] **`read` 拦循环**(`tool_call` 钩子):同一区间(offset+limit 相同)读第二次直接拦;同一文件一轮内读超 `READ_FILE_LIMIT`(6)次直接拦 —— 后者说明模型在用 `read` 分页翻整章,而 `read` 在 2000 行/50KB 处截断,这么翻永远翻不完。两条拦截都点名 `read_chapter`。护栏**按轮重置**(`before_agent_start` 调 `resetReadRails`),不跨轮累积,否则长会话后期什么都读不了。
- [feat] **写入前后字数对比**(`tool_result` 追加):整体重写合法,所以不拦「覆盖已有文件」,但**静默丢内容必须显性化** —— 掉了一半以上就报「从 X 字改成 Y 字(减少 Z 字)……用 read_chapter 重读全文确认」。此前工具只回「Successfully wrote N bytes」,2824→0 也一样像成功。
- [test] `test/tool-rails.test.ts`(17 例):空内容/纯空白拦截且有出路、有内容放行、书外交回路径守卫、首次读放行、同区间第二次拦截、换区间不误伤、超上限拦截、不同文件各算各的、按轮重置、字数对比的四种情形。

提示词工程:治「agent 反复读文件」的行为异常(真实会话 `writer-c-v05ij1` 复盘)。

- [fix] **`read_chapter` 进提示词工具清单**(`prompts/writer-main.md`):T3 做了这个整章通读工具(`src/tools.ts`),但 `prompts/` 与 `skills/` 里**零命中** —— 工具 schema 随请求发给模型,可提示词明说「以下是你可用的基础工具」并给了张清单,**模型服从提示词**,该工具自上线起就是死代码。复盘会话里 `read` 调用 **117 次**(91 次打在同一章上、全部带 offset、报过 `Offset 180 is beyond end of file`),`read_chapter` **0 次**。现在清单里明写两者分工:`read` 读片段、`read_chapter` 通读整章,**不要用 read 带 offset 把一整章翻完**。
- [fix] **场景节奏加前置门禁**(`prompts/writer-main.md`):「这是清单,不是建议」原先**没有写什么时候启用这份清单** —— 用户在讨论双魂设定、虚构地名表、哥哥设定时,模型仍每轮执行「read 草稿 → 写场景 → word_count」。现在开宗明义:**先判断这一轮是不是要写**,讨论轮不执行 1–4 步,结论当场用 `world_update` 落盘。
- [fix] **新增停止条件**(`prompts/writer-main.md`):通篇 6 处「如何开始动作」、**0 处「何时停止」**,循环一旦启动不会自己终止(L156「一眼只读一次」在长会话里失效——每轮都是"这一轮")。新增「同一文件一轮内读取不超过 2 次;读到重复/截断/offset 越界**立刻停**,绝不靠 offset 递增把文件翻完」。
- [fix] **两处工具指令互打架**:`read_chapter` 描述说「改写/续写/审校前应当用这个工具而不是 read」,提示词 L151 却说「先 `read` 再写」。现统一为 `read_chapter`(仅改某一段时才用 `read` 定位)。
- [fix] **两个技能跟上**(`skills/revise` 第 2 步、`skills/critique` 第 1 步):这两处正是「整章通读」场景,原先写的是 `read` it in full。
- [docs] `PI_WRITER_PROMPT_DIAGNOSIS.md`:完整复盘(会话画像 / 六条根因 / 同类项目提示词工程原则对照 / P0–P2 修复清单)。

记忆与上下文可靠性:修「agent 失忆」——记忆不再只活在会话历史深处。

- [feat] **每轮记忆锚**(`src/extension.ts`):`before_agent_start` 把 **memory.md(按预算裁剪)+ 活跃 Notice + 发展线当前位置** 追加进 systemPrompt 尾部,每轮刷新。背景包是切章时的一条普通消息,会被压缩移出 leaf 链、长对话里也会被注意力稀释(lost in the middle);systemPrompt 每轮都在上下文最前,是唯一不依赖模型回忆的常驻通道。TUI/Web 同款生效(web runtime 装配同一 extensionFactories);内容只在 world_update / memory.md 更新时变化,prompt 缓存前缀不受扰动;刻意不含草稿全文(每轮都变,会击穿缓存)。
- [fix] **压缩后补偿注入**(`src/web/server.ts`):`handlePostChat` 发消息前经 `ensureChapterContext` 扫当前 leaf 链(`sessionLeafHasWorldContext`),背景包不在上下文里(被 compaction 移出/服务重启/切书)就按**当前世界状态**重新装配注入。判据是存在性而非内容指纹——整包含草稿与发展线位置等易变内容,指纹每轮都变。
- [fix] **提示词与实现对齐**(`prompts/writer-main.md`):「memory.md 会在每一章开写前注入」与实现(仅切章注入一次)矛盾,agent 以为记忆在、不会去读——改为如实描述并给出自救指引(不确定就读 memory.md);补「背景包是注入那一刻的快照,之后对 world.json 的改动不同步」。
- [feat] **用户信息当场落盘纪律**(`prompts/writer-main.md`):用户在对话中给出的设定/纠正/偏好/长期指示,够格进条目的当场列建议清单,其余**当轮**写入 memory.md 顶部——此前只在章节收尾自主整理,压缩或切章一来未落盘的即消失;记忆的维护时机从「章末」放宽为「随时可记,章末整体检视」。
- [feat] **自动压缩接管,保住用户原话**(`src/extension.ts`):注册 `session_before_compact`。vendor 自动压缩调 `compact(..., undefined, ...)` —— customInstructions 硬编码为空,摘要模板是编码场景的 Goal/Progress/Next Steps 且允许「不再相关可删除」,用户给的设定/纠正/长期指示会被"concise"掉(即「用户说过的都要忘记」)。现改为自己拼摘要:**不调模型、不碰 auth** —— `preparation.messagesToSummarize` 里就是即将被丢弃的消息,把**用户原话逐字抽出**(上限 6000 字,超出保较新的,最早的通常已沉淀进 memory.md)与记忆锚一起作为摘要;最近 `keepRecentTokens` 的原文不受影响。失败静默交回 vendor 默认摘要。
- [feat] **手动压缩默认带写作指令**(`src/web/writer-host.ts`):无 instructions 时注入 `WRITER_COMPACT_INSTRUCTIONS`——同上,小说的用户指示/人物状态/伏笔极易被"concise"掉。
- [refactor] **`WORLD_CONTEXT_TYPE` 常量收口**(`src/world-context.ts`):`"world-context"` 此前在三处各写一份(session-host / extension / 新增的扫描逻辑),改一处漏两处会出现「注入了但扫描不到」的静默失忆;现集中为一个导出常量。
- [test] `test/memory-anchor.test.ts`(11 例):锚的内容(memory/Notice 未完成项/发展线当前位置)与空态跳过、压缩判据(会话文件不存在/含背景包/只剩普通消息/其他 customType 不算)、用户原话保留(只取 user / 时间顺序 / 空白不占额度 / 超限保较新的)。

上下文透明度与防腐层：看得见「agent 到底读到了什么」，并为 pi 1.0 升级铺好唯一缓冲带。

- [feat] **`/inspect` 上下文检视**（TUI 面板 + Web 面板，T5）：全屏只读 overlay，回答「这一轮 agent 到底看到了什么、还差什么」。三个分页——**分段占用**（系统提示 / 技能 / 世界书 / 记忆 / 对话各占多少 token）、**被省略**（哪些条目因预算被裁掉、为什么）、**可调设置**（直接列出字段名，告诉你去哪改）。键位：`↑↓`/`j k` 滚动、`g G` 顶底、`Tab` 切页、`q Esc` 退出。**面板是只读的**——它不改任何东西，要改去设置。
- [feat] **裁切可见**（T4）：消费 `trimmedCount`，被裁掉的条目在上文面板与 `notify` 里显式写出条数（超过 5 条折叠成「等 N 条」）。
- [feat] **上下文预算可配置**（T1/T2）：原先写死在代码里的五个预算常量改为可配置；写入后回传字数改用 `tool_result` hook（不再让模型自己报数）。
- [feat] **`read_chapter` 全文读取工具**（T3）：整章读取，与 `read`（读片段）**并存不覆盖**——`read` 用于找片段，`read_chapter` 用于通读全文。
- [refactor] **防腐层 `src/pi-adapter/`**（T6/T7）：自研代码与 pi 框架之间的隔离带，**vendor 直接引用从 51 处 / 30 文件清零到 0 处 / 0 文件**。三条铁律——①对外 API 必须是**写作领域形状**（打开会话叫 `openSession`，不叫 `SessionManager.open`）；②**厚度控制**（只包实际用到的 vendor 面，不做无差别包裹）；③**单向依赖**（自研 → adapter → vendor，不可回流）。
  - 收益：升级 pi 时的编译面从「28+ 个自研文件同时失败」收敛到「只看 `pi-adapter/` 一个目录」。**这是后续升 1.0.2 的唯一缓冲带。**
  - 设计要点：`SessionManager` 用**不透明句柄**（品牌字段让句柄不可伪造），`ToolDefinition` 这类「要读字段、要构造」的用**类型别名**（保持 vendor 结构形状、收归名字归属权）。
  - 新增 `test/pi-adapter.test.ts` 契约护栏：**自研业务代码零 vendor 直接引用的全局断言**（无白名单）+ 26 个交付文件逐一点名 + 单向依赖不回流。
- [fix] **补 `tsconfig.json`**（T6）：项目原先**没有** tsconfig，裸跑 `tsc --noEmit` 会静默退回宽松默认配置 —— **检查手段失效比没有检查更危险**（当时掩盖了 4 个既有类型错误）。现已固定 `npm run typecheck`，文档强调**必须显式 `-p`**。

把 `craft` 一个技能拆成按阶段的四个：路由回到**描述层**，用户也能点名。

- [refactor] `craft`（一个技能、76 份方法论、123 行路由表）拆成 `craft-outline`（选题结构/大纲/32 张题材卡，50 份）、`craft-prose`（正文技法/人物，17 份）、`craft-deslop`（去 AI 味/文风，7 份）、`craft-review`（审稿标准，2 份）。**触发时整份读的 SKILL.md 从 8.6KB 降到 2.7–5.4KB**（只有相关内容的那一份进上下文），且四条互不重叠的 description 让模型在「要不要打开这个技能」这一步就能分流——这正是上游用 13 个技能做的事，但上游那 13 条中文触发词互相重叠（都写着「写大纲」「修改第X章」「去AI味」），全塞进 `<available_skills>` 反而会让模型选错；四个按阶段切的则不会。用户也能 `/skill:craft-deslop` 直接点名。
- [refactor] 文件按类物理拆开（`craft-outline/references/` 下扁平放 12 结构 + 6 题材，题材卡进 `cards/` 子目录；其余三个各自扁平），**没有留跨技能的转发路径**——转发只存在于 `outline` / `critique` / `revise` 三个流程技能指向 `craft-*`，那三处路径已同步改写。
- [fix] **许可声明跟着副本走**：`ATTRIBUTION.md` 与 `LICENSE-oh-story-claudecode.txt` 在四个技能目录下**各一份、内容相同**（MIT 要求版权声明与许可全文随每一份拷贝分发；拆开后每个技能自包含）。四份必须逐字节一致，`test/skill-references.test.ts` 直接断言——改一处忘同步即红。
- [test] `test/skill-references.test.ts` 的 craft 专属断言从「单个 craft」改成「四个 craft-* 通用」（16 例）：就这 4 个技能、每类份数与合计 76、frontmatter 合法、`磁盘↔路由表`双向一致、`SKILL.md` 里每个 ASCII `*.md` 记号都能在本技能找到（拼错即红，CJK 题材卡走反方向）、纯净性标记、许可与 commit、四份副本一致。另修 `test/skills-index.test.ts` 里写死的 `craft` 技能名。
- [docs] `README` 写作技能行、`.agents/skills/pi-writer` 知识地图、`THIRD-PARTY.md`、`onboarding` 技能里的技能清单与路径全部跟上；`web/src/skill-invocation.ts` 注释里「craft 约 8.6KB」的举例更新为拆分后的真实体积。

## [0.1.2] - 2026-10-01

五处收尾(均在 0.1.1 定稿之后):手机端输入条随文本长高并不再溢出、`/skill:<name>` 在对话里收成一枚可展开的芯片、写作 agent 起笔前先确认设定与约束不是空的、世界书工具的参数 schema 压平以配合受限解码的模型、**分支切换从顶部的下拉栏收进消息本身**;另补一处解耦漏网 —— **对话范围的提示词**。

**升级影响**:无。不涉及数据格式、默认值或会话内容——技能消息仍是同一份展开文本落盘,只是界面折起来显示;工具参数 schema 只改变对模型暴露的形态,落盘数据与工具行为不变。提示词这处只换**分离模式**下的措辞:「绑定章节」(默认)下写作 agent 的系统提示与解耦前逐字节一致(编剧那份只多一条「对话范围」说明,正文路径规则语义不变);`test/prompt.test.ts` 钉住。分支切换只改呈现:会话文件、leaf 语义、撤回/编辑行为都没动(`/tree` 多了一个只读的 `versions` 字段,会话状态里的消息多了一个 `firstEntryId`)。

提示词里「会话 = 一章」这处漏网(2026-10-03):对话与章节解耦(0.1.1)只动了会话身份与白名单,`prompts/*.md` 没跟上。

- [fix] **对话范围进提示词**(`prompts/writer-main.md` / `prompts/writer-editor.md` / `src/prompt.ts`):提示词此前无条件写着「每个 pi-writer *会话*对应书的一章」「散文落点是当前章节草稿」「正文文件固定由当前章节决定……写其他路径会被工具拒绝」——分离模式下模型据此自我收窄(用户让它改别的章节时把活推回去),编剧那句更是**与事实相反**:分离模式不设正文白名单(`writerDraftFile` 返回 `undefined`)。现在这些句子全部走 `{SCOPE_SECTION}` / `{SESSION_SCOPE_LINE}` / `{DRAFT_MIRROR_LINE}` / `{EDITOR_SCOPE_LINE}` / `{EDITOR_DRAFT_RULE}` 占位,值只写在 `src/prompt.ts` 的 `SCOPE_VARS`(**唯一实现**,`chapter` 列是解耦前原话、`# 对话范围` 整节在 chapter 下渲染为空串);渲染入口 `buildWriterSystemPrompt(tools, shell, scope)` 与新的 `buildEditorSystemPrompt(scope)`(编剧装配从 `writer-host` 搬进 `prompt.ts`,shell 行仍由调用方追加)。分离模式新增《对话范围》一节:**对话不隶属于任何章节、可编辑任意一章,且下文所有「当前章节 / 本章」一律指用户此刻正在看的那一章**(没在看就问他,别自己挑)。
- [fix] **该用哪套由宿主身份定**(`src/web/writer-host.ts` 新纯函数 `hostPromptScope`):判据与会话身份同源 —— key 是 `<id>.jsonl` 才算「绑在一章上」。分离模式下同一个 `WriterHost` 里既有自由对话(`c-xxxx` / `default`,按分离叙述)也有**收幕成文**(`chatAndWait` 永远按章节键取宿主,它就是要落某一章正文,必须按绑章叙述)。
- [docs] 跟着改的还有单一绑定口径的几处:`skills/onboarding/references/environment.md`(三句话版本 / 「一章一个现场」→「现场不串」/ 落点纪律 / 新增「对话与章节的关系」一节)、`feature-tour.md` 的「章节即会话」小节、`README.md` 的「章节即会话」段。
- [test] `test/prompt.test.ts` 钉五条:缺省与显式 `chapter` 同文且**不出现《对话范围》整节**、chapter 的绑定原话与落点硬规则照旧、book 不出现绑定口径且把「当前章节」定义成用户正在看的那一章、编剧两种范围的正文路径规则(book 不许再说「写其他路径会被工具拒绝」)、两种范围都不残留占位符;`test/writer-host.test.ts` 钉 `hostPromptScope` 的四种组合(含收幕成文)。

手机端输入条:胶囊此前写死高度,多行文本从胶囊上下两侧穿出去(2026-10-01 手机端截图)。

- [fix] **手机端输入条的胶囊跟着文本长**(`web/src/styles/mobile.css` / `InputBar.tsx` / `WritePage.tsx`):`.ib-field` 原先写死 `height: 40px`,而 textarea 随输入自动增高(最多 104px),多行文本从胶囊上下穿出。现在胶囊改 `height: auto` + `min-height: 40px` 跟着长,单行 42px、多行随内容撑开。
- [fix] **到顶内部滚动,光标跟着走**:textarea 保持 104px(≈5 行)上限,显式声明 `overflow-y: auto` + `overscroll-behavior: contain` —— 输入条不无限拉长,长文在框内滚。JS 的增高上限改为读 CSS 的 `max-height`(不再自持一份 160px 常量,与 CSS 的 104px 曾不一致);内容超限时不再做「置 auto 再测高」——那次测量会把 `scrollTop` 清 0、光标掉出可视区(封顶后打到第 6 行还在看第 1 行)。
- [fix] **底部留白跟输入条的实测高度走**:输入条是 `position: fixed`,纸张 / 伙伴栏 / 对话切换抽屉按固定 66px 让位,长高后会盖住最后几行。现在 `WritePage` 用 `ResizeObserver` 把实测高度写进根元素 `--m-composer-h`,三处留白同源。
- [test] `test/mobile-composer.test.ts`:钉住「胶囊不许写死高度」「上限 + 内部滚动」「留白跟变量走」「到顶保留光标跟随」四条。

技能调用:`/skill:<name>` 在发送时被 vendor 展开成整份 SKILL.md 写进用户消息,聊天区此前原样渲染——一整屏方法论灌进自己的气泡(critique 约 3.5KB、craft 约 8.6KB),连带「复制」拷全文、「编辑」把全文预填进输入框。

- [feat] **技能调用收成一枚芯片**(`web/src/skill-invocation.ts` + `MessageList.tsx`):解析回「技能名 + 技能正文 + 你自己说的话」,气泡里显示 `✦ critique` 芯片 + 你的话,正文默认折叠、点芯片展开(限高内滚、灰底 mono)——与 TUI 的 `[skill] name (Ctrl+O 展开)`、HTML 导出的 `[skill] name` 同一套语言。字面态(刚发出、回显未到)只画芯片不画箭头;会话里存的与模型收到的仍是展开后的全文,撤回 / 分支 / 重放不受影响。
- [fix] **技能消息的「编辑 / 复制 / 重试」改用折叠形态**:编辑预填 `/skill:<name> 话`(重发时重新走 vendor 的展开路径,而不是把上次展开的全文当普通文本再发)、复制同样、报错卡的重试目标同样。
- [fix] **对话标题不再以 `<skill name="critique" loc` 开头**:标题取第一条用户消息前 24 字,技能消息改用 vendor 的 `parseSkillBlock` 拆成「技能名 · 你自己说的话」(`src/web/writer-host.ts` 的 `conversationTitleText`)。
- [test] `test/skill-invocation.test.ts`:两种形态解析、展开态正则与 vendor 逐字同源(读源码比对,做法同 motion/themes 的镜像测试)、store 的消息出生地、重试目标与标题口径。

提示词:起笔前先确认手上有东西可依。

- [feat] **起笔纪律**(`prompts/writer-main.md` / `prompts/writer-editor.md`):即将第一次把正文写进草稿、而**世界书条目、大纲与发展线、写作约束三样都没有内容**时,先用一句话问用户要不要补进去——并具体到点(哪几个条目、什么样的大纲、哪几条约束),让他一句话就能拍板。用户说「先别管,直接写」就照写,同一场对话不再提;三样里任意一样有内容就不提。与《开场纪律》**合并成一次问询**,新书不会被连问两轮。编剧那条按它的权限改写:人物 / 关系 / 时间线 / 大纲 / 发展线归导演,建议走 `advice.md`。
- [test] `test/prompts.test.ts` 补四条:写作 agent 的触发三样与「具体到点」、不阻塞且不再提、合并成一次问询,以及编剧那条的归属改写。

工具参数:世界书更新的操作联合对模型不再是一段 `anyOf`。

- [fix] **`world_update` / `style_update` 的参数 schema 压平**(`src/tools.ts`):此前把「以 `op` 区分的判别联合」直接当工具参数暴露,JSON Schema 是一段约 7.4KB 的 `anyOf`(首个分支 required 是 `upsert_entry` 的 `type`/`title`)。受限解码 / 只读首分支的 provider 会把它塌成那一支,`set_world_summary`、`upsert_relation` 这类非首分支操作发不出来(2026-10-02 实机反馈:「op 常量与字段不符」「关系操作被 title/type 卡住」)。现在 `flattenOpUnion` 把联合压成单一对象(`op` 收成 enum、其余字段 optional,约 1.4KB),必填性由 `normalizeWorldUpdate` / `normalizeStyleUpdate` 按 op 在运行时兜底——缺字段 / 未知 op 抛中文可读报错回灌给模型,而不是写坏数据或静默无操作(未知 op 此前会静默跳过)。`word_count` 的 `modes` 同步由 `anyOf` 常量改为 `string + enum`。
- [test] `test/tools.test.ts`:钉住「无 anyOf / 只有 op 必填 / 关系字段可见 / op 枚举齐全」、`normalize*` 的缺字段与未知 op 报错,以及 `upsert_relation` + `set_world_summary` 端到端落盘。

分支切换:此前是对话视图顶部的一条下拉栏,下拉里是各分支的起点/结尾摘要,切的是**整条对话的 leaf** —— 想「换回上一版那句话」得先弄懂「分支」是什么,而且**每条消息属于哪一版在界面上完全看不出来**(编辑重发留下的旧版本,只能靠下拉里的摘要文字猜)。

- [feat] **分支切换收进消息本身**(`web/src/components/MessagePager.tsx` 新增 + `MessageList.tsx` / `WritePage.tsx` / `web/src/types.ts` / `web/src/store.ts`):同一条消息存在多个版本时(编辑重发产生新的 user 兄弟、重新生成产生新的 assistant 兄弟),在气泡下缘右对齐画一排「‹ 2 / 2 ›」,点箭头就地切到上/下一版 —— 与微信多版本消息同一套语言,不必先理解「分支」。流式中不画(服务端此刻拒绝 navigate,画一颗点不动的按钮比不画更坏)。UI 房同步加两处陈列(原子控件「消息版本切换器」+ 消息流「多版本」档)。
- [refactor] **版本视图落到服务端唯一实现**(`src/session-tree.ts` 新增):`buildSessionTree(sm)` 一次算出「分支概览 + 每条消息的版本」(版本 = 同一父 entry 下的同角色消息),`SessionHost.getSessionTree` 与 `writer-host` 服务重启后从磁盘恢复的那份 walk 都改成调它 —— 此前同一段「叶子遍历 + 摘要」有两份拷贝(0.1.2 审计),再加版本视图必然抄出第三份。版本地图的键是**可见消息的首段 entry**:assistant 气泡是多段输出(思考/工具/正文)合并成的,`id` 按历史口径取组内**最后**一段,所以 `SessionMessageDto` 新增 `firstEntryId`,前端一律按 `firstEntryId ?? entryId` 取键(实时路径的 entryId 本来就落在首段上,两条路径因此取到同一个键)。切某一版时去的分支终点取「离当前位置最近」的那一条(先比与当前路径的公共后缀,再比路径长度)——换版本时对话尽量停在原处,而不是跳到别的分支尾巴上。
- [fix] **切换器的可见性不许拿 `done` 当 user 消息的门槛**:store 的 `done` 只由 `message_end` 落在「最后一条未 done 的 assistant」上,user / toolResult 消息被显式忽略、**恒为 false**,而编辑重发产生的版本**恰恰全在 user 消息上** —— 门槛一加就成了「assistant 的能显示、user 的永远不显示」,功能等于没生效。无头 chromium 走查真机时抓到(SSR 自检里我把 user 数据写成 `done: true`,等于把 bug 一起 mock 掉了),现在门槛是 `!streaming && (user || done)`。
- [refactor] **顶部的分支下拉栏删除**(`web/src/components/BranchBar.tsx` 删除 + `WritePage.tsx` 去掉引用 + `styles.css` 去掉 `.branch-bar/.branch-label/.branch-select` 与它的入场动画 + `uiroom/atoms.tsx` 去掉展项):两个入口表达同一件事,只会让人猜哪个更「官方」;版本切换器就长在消息上,不要求用户先理解分支。`/tree` 的 `branches` 字段保留(只读,测试与将来的分支总览还用得上),前端不再消费。
- [test] `test/session-tree.test.ts`(8 例:内存 fake 树 + **真实 jsonl 落盘解析**)钉住:线性会话没有版本、编辑重发产生 user 版本且 `leaves` 指向各自分支终点、重新生成产生 assistant 版本、非消息兄弟(模型切换等)不参与、同版本落在多条分支上时的选择口径、leaf 停在非叶子节点(branch 之后)也算候选终点、空会话;`test/session-host.test.ts` 加两例走真 `SessionManager`(retract 后重发确实产生兄弟;多段 assistant 气泡的 `firstEntryId` 是首段而 `id` 是末段);`test/message-pager.test.ts` 用 SSR 钉可见性五条(user `done:false` 必须画、assistant 未结束不画、流式中不画、单版本/无版本不画、assistant 组按 `firstEntryId` 取键)。另用无头 chromium + CDP(`.e2e/version-pager.mjs`,不入库)拿一份真实的三版本会话走查:10/10 通过 —— 「3 / 3」出现在那条 user 气泡下缘、点 ‹ 变「2 / 3」且正文整段换成那一版、点 › 切回,页面上已无 `.branch-bar`。

## [0.1.1] - 2026-10-03

本版三条主线:① **新装默认就是单 Agent**(经典模式)—— 第一眼是编辑页与一个写作 agent,不必先弄懂导演 / 演员 / 编剧的分工;② **对话与章节解耦** —— 对话可自由新建 / 切换 / 删除,切章节不再切对话,对话里的 AI 能编辑任意章节,想回到「一章一段对话」也只需设置里一行;③ **技能改按需使用**,并补上 `/skill` 点名入口 —— 此前技能是「用户不问就不许用」的死库存。

其余:首启向导 6 → 8 步(「对话范围」「执行命令」各自成页)、编剧拿到「只写写作风格」的窄通道 `style_update`、舞台把写作约束与文风采样送到真正落笔的地方、会话级设置(模型 / 思考级别)真正换得动、第三方许可声明补齐、动效与 UI 房收尾。手机端那一整套重排(原先记在 0.1.1 名下、2026-09-27 落地)也随本版一并发布。

**升级影响**:从没写过 `~/.pi/writer/settings.json` 的安装会跟着新默认切到单 Agent(表现为舞台入口消失、编辑页的 AI 换成带全量工具的写作 agent);已经存过设置的安装不受影响 —— 文件里 `classicMode` 是显式值。

首启向导从 6 步加到 8 步,并把「两选一卡片」收敛成一份实现。

- [feat] **「对话范围」步**(第 3 步)：绑定章节 / 分离 两张大卡，与设置页「对话与章节」卡同一实现、同一份文案；默认仍是「绑定章节」(选中带「默认」的那张)。
- [feat] **「执行命令」步**(第 4 步)：保持关闭 / 开启 shell 两张大卡，选中「开启」先过设置页同款的风险确认条 —— 确认文案 `SHELL_CONFIRM_TEXT` 只有一份，向导与设置页共用。此前它是挤在「创作方式」步底部「工具」小节里的一行开关，而它是整份向导里**唯一**一项权限授予，最容易被顺手划过。
- [refactor] **卡片实现收敛**：`cmode-*`(创作方式) 与 `cscope-*`(对话与章节) 两份几乎相同的卡片实现合并成一份骨架 `ChoiceCards.tsx` + 一组 `.choice-*` 样式，三处(向导三步 + 设置页两张卡)只写各自的数据；新增 `ShellCards.tsx` 只负责执行命令那两组文案。
- [fix] **向导跳转不再写字面下标**：`next()` 一律走 `nextStep()`(+1)，末步回显行的「改」走 `stepIndex(id)`。加这两步时原来的 `setStep(1..5)` 会整体错位 —— 那正是文件里早就写过的坑。
- [test] `test/setup.test.ts` 跟上八步(旧文件兼容用例扩到 `scope`/`shell`)；UI 房新增 `choice-cards` / `shell-cards` 两个展项，向导展项从两档扩到四档(介绍 / 创作方式 / 对话范围 / 执行命令)。

补齐第三方许可声明:MIT 只要求一件事——版权行 + 许可全文随每一份拷贝分发——而发行物里此前一份都没有。

- [fix] **`vendor/` 补上游 MIT 全文**:`vendor/LICENSE-pi.txt`(从 [earendil-works/pi](https://github.com/earendil-works/pi) 根 `LICENSE` 原样拷入,`Copyright (c) 2025 Mario Zechner`)。此前 `vendor/` 下只有 `NOTICE.md` 一句「MIT(见各包 package.json)」,而 package.json 里只有 `"license": "MIT"` 字符串——那不是许可全文,不满足 MIT 的随附义务。
- [fix] **`vendor/NOTICE.md` 重写**:版权行改成上游 LICENSE 原文(此前写的「Mario Zechner / Earendil Works」不是原文),补六个包与上游包名/目录的对应表,并写明**本副本相对上游有修改、未逐条标注 diff、不保证对应某个 commit**。
- [fix] **声明随四种发行形态走**(这是原本真正缺的一环):`package.json` 的 `files`(npm)、`npm run bundle`(单文件 exe 拷进 `release/`)、`electron-builder.yml` 的 `files`(桌面端)、`scripts/make-release-zips.mjs` 的 `EXTRA`(GitHub Release zip)。动机:产物是**内联**的——`dist/web/server.cjs` 是 esbuild 全量打包(含 vendor 的 pi 内核与 500+ npm 模块),`web/dist/assets/*.js` 也内联了前端依赖,属于 MIT 说的 "substantial portions"。
- [docs] 新增根目录 [`THIRD-PARTY.md`](THIRD-PARTY.md):第三方组件清单(pi 核心包 / craft 方法论文库 / npm 依赖)+ 各发行物必须携带哪些文件 + 已知待办。README 的 License 段落补上来源、许可全文位置与指向该文件;`skills/` 的第三方来源核查结论也写进 `vendor/NOTICE.md`(`craft` 的 oh-story 收录本就带 ATTRIBUTION + 完整 LICENSE 全文;`outline`/`critique`/`revise`/`stage-scripting`/`onboarding` 经比对**不是**来自 pi 上游、也不是来自 oh-story,判断为自研)。
- [verify] `npm pack --dry-run` 确认包内含 `LICENSE` / `THIRD-PARTY.md` / `vendor/LICENSE-pi.txt` / `vendor/NOTICE.md`;`electron-builder.yml` 解析出的 files 列表含四份声明;`bundle` 脚本的拷贝等价命令实测产出齐全。依赖侧全量扫过 553 个包,**零 GPL/AGPL/LGPL**,全部宽松许可(仅 `busboy`/`streamsearch`/`rechoir` 的 `package.json` 缺 license 字段、实际为 MIT,已记进待办)。

技能从「用户不问就不许用」改成**按需使用**，并给斜杠菜单补上主动点名技能的入口。

- [feat] **`/skill` 命令**（编辑器输入条的斜杠菜单）：列出当前装配加载到的技能（名字 + 描述），选中插入 `/skill:<名字> `。这是**唯一**能调用 `disable-model-invocation` 技能的入口——那类技能被 vendor 从 `<available_skills>` 里排除，模型看不到它们，只能由用户点名。
- [feat] **清单与 agent 装配同源**：`GET /api/skills` → `src/skills-index.ts` 用 vendor 的 `loadSkills` + `session-factory` 的 `sessionSkillDirs` 加载（自带 `skills/` + 全局技能目录）。不自己扫目录是硬要求：vendor 对认不出的名字**原样透传**，菜单名字与展开名单对不上就是「点了技能但没生效」。
- [feat] **技能纪律放宽**（`prompts/writer-main.md` / `prompts/writer-editor.md` 新增《技能(按需使用)》）：用户的要求落在某个技能的适用场景里（「这章哪里不对」「太 AI 味了」「卡文了」）就**直接按它的方法做事**，不必先问、也不必等用户点名——旧写法「不自动套用 outline/critique/revise 方法论，只在用户提出时提供」把技能变成了死库存（用户不知道有哪些技能，就永远不会用上）。唯一保留的边界是**多轮流程先问一句**：需要连续提问 / 要样本 / 逐节确认的流程，先用一句话说明再开始；另外仍然不许朗读方法论、倒清单、把技能名与文件路径写进回复。
- [fix] **`/skill:` 与引用芯片同用时也会展开**：vendor 的展开只认消息**首位**的 `/skill:`（`agent-session.ts` 的 `_expandSkillCommand`），而 `composeMessageWithAttachments` 把引用芯片排在前面——带 `@` 引用的技能指令会退化成一段普通文本。现在文本以 `/skill:` 开头时把它提到最前。
- [fix] **选中命令后直接出候选**：`InputBar` 的 `insertRange` 加了 `reopenMenu`，插入的正是 `/命令 ` 时立刻重算菜单——此前只在 onChange/keyup 上重算，于是选完 `/skill` 菜单关闭、技能清单要等用户**再敲一个字**才出现（`/node`、`/chapter` 是 `@` 引用菜单不受影响，`/compact` 也顺带直接显示它的动作候选）。
- [docs] `onboarding` 技能的三处「不自动套用」表述改成「多轮流程先问一句 + `/skill:` 点名不用再问」（`SKILL.md` 铁律一、`references/environment.md` 技能清单、`references/style-setup.md` 的四连问）；pi-writer SKILL 补 `/skill` 与技能纪律两条索引。舞台角色**故意不参与**：演员 / 导演是 `packagedSkills:false` 装配，放开技能浏览会诱导它们去改正文（2026-09-22 的既有设计），它们只有 `{SKILLS_PATH}` 指到的方法论文件。
- [test] 新增 `test/skills-index.test.ts`（自带技能在列、`disable-model-invocation` 标 `explicitOnly`、坏目录不抛错）；`test/slash-commands.test.ts` 补 4 例（`/skill` 命令形态、插入文本字面量、描述过滤与显式调用标注、`/skill:` 带芯片时排最前）；`test/prompts.test.ts` 把旧断言换成新的按需使用边界（含「旧的全禁写法不许回来」）；`test/server.test.ts` 补 `GET /api/skills`。
- [verify] **端到端跑通**（本机无可用模型，用临时 mock LLM）：浏览器里 `/` → `/skill` → `/critique` 插入 `/skill:critique `，发送后会话 jsonl 里的用户消息是展开后的 `<skill name="critique" location="…/skills/critique/SKILL.md">…` 块，mock LLM 收到的 prompt 里确实带这份内容——菜单、插入格式、vendor 展开、送达模型四段全链路验证。

默认创作方式翻转为单 Agent（经典模式）：新用户第一眼就是「一个对话口直接写」，不用先弄懂导演 / 演员 / 编剧的分工。

- [feat] **`classicMode` 缺省值 false → true**（`src/writer-settings.ts` 的 `defaultWriterSettings()`）。多 Agent 那套要用户先理解角色分工才用得起来，新用户容易卡在「我该跟谁说话」；单 Agent 只有一个写作 agent、工具全开，先能写起来更重要。首启向导「创作方式」步里「默认」标签跟着搬到单 Agent 那张卡（多 Agent 改成「多角色」标签），向导说明也改成「不确定就用带默认的那一张」。
- [fix] **前端首帧缓存同步翻转**（`web/src/settings.ts` 的 `parseClassicMode`：仅显式 `"0"` 表示多 Agent）。这个默认值在前后端各有一份（服务端权威 + 浏览器缓存，后者决定首帧顶栏画哪几页、落在哪一页），只改一处会先渲染出舞台入口再收回。`test/settings.test.ts` 新增一条**跨模块护栏**直接比对两处默认结论（`parseClassicMode(null) === defaultWriterSettings().classicMode`），`test/writer-settings.test.ts` 新增「旧文件缺 `classicMode` → 走新默认；显式 `false` 仍保持多 Agent」。
- [docs] 跟着改的还有：`docs/architecture.md`（默认落地页：单 Agent → 编辑页 / 多 Agent → 舞台；设置入口已迁到「高级 → Agent 形态」）、`skills/onboarding/references/environment.md`（两种形态表把默认列换到经典模式，并写明「别自作主张替用户切模式」）、pi-writer SKILL 的 `prompts/` 行与创作方式索引条。
- **升级影响**：`settings.json` 已经存在（即改过任何服务端设置、或在设置 / 向导里选过创作方式）的安装**不受影响** —— 文件里 `classicMode` 是显式值，解析时覆盖默认。只有「从未写过 `settings.json`」的安装会跟着新默认切到单 Agent（表现形式：舞台入口消失、编辑页的 AI 换成带全量工具的写作 agent）。

给编剧一条「只写写作风格」的窄通道，并把约束默认范围从「全部」收窄到「编剧」。

- [feat] 新增工具 `style_update`（编剧专用窄通道）：只写**写作风格三件套**——写作约束 / 文风采样 / 世界观概述；人物 / 关系 / 时间线 / 大纲 / 发展线 / Notice 一律碰不到（仍是导演的活）。此前编剧只有只读的 `world_find`，于是用户在编辑页说「以后别用破折号」时，它只能把结论写进 `advice.md` 等导演下次开会话才落盘——**"说了没生效"**。两条与 `world_update` 不同的语义是刻意的：① 约束**强制** `target="writer"`（编剧只约束自己，要约束导演得用户直接对导演讲）；② 约束按**名字** upsert / 删除——注入给编剧的【写作约束】块只有 `名字: 正文`、没有 id，不能要求模型先查 id。实现复用 `applyWorldUpdate` 的引擎与校验（`applyStyleUpdate` 纯函数），不另写一套写入逻辑；也**不写** `stage/last-world-edit.json` 编辑记录（那只归舞台页消费，编辑页写它既无消费方、又会在窄窗口里串成一张舞台预览卡）。
- [feat] 约束默认生效范围从「全部」改为**「编剧」**：动笔写正文的是编剧（多 Agent 的收幕成文与编辑页对话，单 Agent 的写作 agent），导演管节奏与调度，不该被写作风格绑住；只有用户明确说「连剧本和演出也要守」时才用「全部」。`onboarding` 剧本、导演与编剧提示词都按这个默认值改写。
- [fix] **改这个默认值会踩到的坑**：`buildChapterContext`（TUI / 单 Agent 走这条）此前只收 `target ∈ {main, all}`，而 `writer-host` 的经典模式早就是 `writer || main` 的并集——两份口径不一致。约束默认一旦收窄到 `writer`，TUI 就会**静默丢约束**。现在主会话也收 `writer`（主会话在 TUI 里就是唯一动笔的那个，既是「主会话」也是「编剧」）。
- [refactor] 写作 agent 的工具清单从 `roleFactory` 内联里抽成纯函数 `writerToolset`：这段「编剧只有 world_find、经典模式才是全量」的权限边界，此前埋在一个几百行的私有工厂里、**没有任何测试看守**——这次两个 bug 都长在这种缝里。抽出来后单测直接钉住边界。
- [test] 新增 13 例：`applyStyleUpdate` 六例（强制 writer 范围 / 同名 upsert 不重复立规矩 / 重述即重新启用 / 按名字删且未命中报错并指路约束块 / 采样与概述同语义 / 参数 schema 只有四个 op）；`writerToolset` 三例（编剧有 `style_update` 无 `world_update`、经典模式相反、MCP 两侧都带）；`buildChapterContext` 的 target 过滤补 `writer` 一例；`prompts` 里编剧那条从"不得谎称已写入"改成"当场用 style_update 落盘 + 边界仍在"。

首启向导把「创作方式」从设置页里一个不显眼的开关，搬成两张大选项卡；顺带把危险的工具开关摆到首启一屏内（带风险确认）。

- [feat] **新增「创作方式」步**（向导 5 步 → 6 步，插在介绍之后、接模型服务之前）：两张大选项卡把「多 Agent 协作 / 单 Agent 写作」的差别写在卡面上（各三到四条要点），选完立即写服务端 `~/.pi/writer/settings.json` 的 `classicMode`。此前它是「设置 → 高级」里的一行 `ToggleSwitch`——用户既看不到两者的差别，也找不到那个开关。
- [feat] **同一个组件两处复用**：新组件 `web/src/components/CreationModeCards.tsx` 同时供向导「创作方式」步与设置页「Agent 形态」卡使用；设置页也从一行开关换成这两张大卡（手机端设置索引里「经典模式」那行改成「Agent 形态」子页，卡片样式 `cmode-*` 写在 `styles.css`）。文案与要点只有一份，两处说法不会漂移。
- [feat] **工具配置首次进向导**：同一屏给出「执行命令(shell)」开关，复用设置页已有的 `enableShell` 服务端设置与同款风险确认条（打开前必须过一条明确说明：命令以与本程序相同的权限运行，书目录的路径限制对它无效）。shell 方言（bash / pwsh）与可执行文件路径仍只在「设置 → 高级 → 执行命令」里改。
- [refactor] 向导的步骤判断从 `step === N` 下标改成 `stepId`：这次插步骤正好暴露了下标判断的脆弱——介绍步之后的所有分支都要顺移，漏一处就是「进度条在第 3 步、界面还是第 2 步的控件」。进度条列数也改成随步骤表走（`grid-auto-flow: column`），以后加步骤不用再改 CSS。
- [fix] 步骤表追加式兼容：`SETUP_STEPS` 加 `mode` **不**递增 `SETUP_VERSION`——旧 `setup.json`（五步）读到缺键按「未走过」解析，已完成的用户不会因加步骤被重新弹一遍。
- [test] `test/setup.test.ts` 跟上六步（新增「旧五步文件 → mode 未走过且 `completedAt` 仍生效」一例）；`test/uiroom.test.ts` 的覆盖 / 逐字同序 / SSR 冒烟自动覆盖新组件与向导新档。

按「两种模式」核对风格落点，揪出两处「设了但没送到」——都只在多 Agent 模式下成立。

- [fix] **TUI 多 Agent 模式下写作约束到不了真正落笔的地方**：收幕成文的委托消息（`buildWriterMessage`）只带【文风采样】不带【写作约束】。web 侥幸不漏——收幕委托走常驻编剧会话，那个会话的 context 钩子会注入 writer/all 的约束；但 CLI/TUI 的内置收幕编剧是 `writerRole()`（`extensions: []`，**没有任何 context 钩子**），于是用户设的「禁用破折号 / 每章 2500 字 / 人称」在**真正写正文那一步**被完全无视。现在约束进委托消息，与文风采样同款（web 下会与 context 钩子重复一次，这是既有设计、也是刻意的：换来整条委托链路自包含）。
- [fix] **导演看不到【文风采样】**：`directorContext` 注入了发展线 / Notice / 写作约束(director) / 编剧建议，唯独没有采样——可导演正是它的**维护者**（剧本文字段的【风格示例】按它校准，收幕编剧收到的采样还被标成「来源: 导演维护的风格基准」）。那句「导演维护」在导演本人那儿一直是空的：用户改了采样，舞台表演语气照旧漂移，导演也无从对照样本。现在随 `storylineBlock` 注入，只在**剧本模式 / 讨论模式**挂载；演出中不挂——演出时导演每轮都在看舞台，每轮多带一份 300–500 字样本不值当。
- [test] `test/stage-orchestrator.test.ts` 补 4 例：约束进委托消息 / 无约束不出现 / 导演收到采样 / 空世界不注入；并锁住「约束块排在委托指令之前」的顺序（与 `world-context` 常驻组的「约束 → 采样」一致）。
- [docs] `onboarding` 的风格剧本补一张「约束生效范围」的表。（**该默认值已在上面那组改为「编剧」**，此处保留说明、不再以「全部」为准。）

开场纪律进系统提示词：新书还没定风格时，AI 必须主动提一次，而不是等用户问。

- [feat] **开场纪律**写进三个对话入口的提示词（不是靠技能被问到才生效）：触发条件是三条同时成立——上下文里没有【写作约束】、没有【文风采样】、当前章节还没有正文。满足时**在写任何正文之前先用一句话提议**（「这本书还没定风格。要不要先花两分钟定一下？…」），并在用户同意后按剧本执行：一轮 `ask_user` 问四件事 → 要一段 300–500 字样本 → 写进世界书。**同一场对话只提一次**，用户拒绝或直接给了写作指令就不再提；三条里任一条不成立也不提（所以一旦开写就自然消失，不会每章追问）。
- [feat] **三个入口落盘能力不同，提示词各自写明**——这是查代码才看清的一处关键事实，也是只改一个文件会漏掉的地方：web 默认落地页是**舞台**（非经典模式 → `App` 初始 view 为 `"stage"`），用户第一个说话的是**导演**（有 `world_update`，能落盘）；TUI 与经典模式走**写作 agent**（`writer-main.md`，能落盘）；**常驻编剧**（`writer-editor.md`，编辑页 AI 伙伴）只有 `world_find`，**写不了世界书**——所以它的纪律是「提议 + 把结论写进 `advice.md` 交给导演落盘 + 告诉用户也可以在世界书页自己加」，并明写**绝不谎称已经写进世界书**。
- [feat] **长期偏好必须落盘**：用户说「以后都这样写」「记住：别用破折号」这类明确表达长期性的要求时，不能只在回复里答应——当场写进世界书（写作约束 / 文风采样）。此前这类话会被答应下来然后下一章就丢。三个入口都加了这条，并限定「只针对长期要求，一次性要求不要写成规则」。
- [feat] 导演提示词新增 `{STYLE_SETUP_PATH}` 占位，由 `src/stage/stage-extension.ts` 的 `styleSetupScriptPath()` 渲染成 `onboarding` 剧本的**绝对路径**（舞台角色是 `packagedSkills:false` 装配，拿不到 `<available_skills>`，相对路径又会解析到书目录内、读不到——同 2026-08-11 `{SKILLS_PATH}` 的根因）。
- [fix] `writer-main.md`「不自动套用 outline/critique/revise 方法论」这条纪律保留，并开了一条**明确且唯一**的例外（开场纪律那一次提议）——否则两条规则会互相打架。
- [test] `test/prompts.test.ts` 新增 6 例回归护栏（8 → 14）：三个入口各自的触发条件 / 只提一次 / 落盘纪律与「不得谎称已写入」；「不自动套用」例外仍在；并直接取真实 `directorRole({}).systemPrompt` 断言 `{STYLE_SETUP_PATH}` **与** `{SKILLS_PATH}` 都已渲染、指向真实存在的文件——只断言模板是不够的（`renderPrompt` 会把未提供的键原样留下，模板测试照样绿，而导演读到的是一个字面量路径）。

新增上手引导技能：模型终于知道「pi-writer 是什么、怎么教用户用、动笔前怎么把风格定下来」。

- [feat] 新增 `onboarding` 技能，补的是**首启向导够不着的那块**：`SetupWizard` 只管模型服务 → 默认模型 → 第一本书 → 主题与界面偏好，**完全不管写作风格与题材风格**。三份 references 分工——`environment.md`（给模型自己看的心智模型：三句话版本、世界书里存什么、背景包注入哪些东西、落点纪律、舞台 vs 经典模式、可用技能与「不自动套用」纪律、边界问题怎么答）、`style-setup.md`（风格引导剧本）、`feature-tour.md`（功能教程备料）。`SKILL.md` 只做路由，不装内容。
- [feat] **风格引导剧本**：先在现有世界书里查一遍（已有就复述现状、只问要改的那项，不重问），再用一轮 `ask_user` 问清四件事（题材 / 人称视角 / 基调节奏 / 篇幅），然后要一段 300–500 字的文风样本（自己写的或想靠近的片段，**绝不编造**），最后真的落进世界书——世界观概述 + 写作约束 + 文风采样。剧本里写死了两条经验：约束必须**可判定**（「不用破折号」而不是「文笔要优美」）、**条数 ≤ 8**（多了互相打架且挤上下文预算）。
- [feat] **三条铁律**写进 `SKILL.md`，都是对齐既有纪律而不是新发明：① 用户没问就不讲——系统提示词里「不自动套用 outline/critique/revise 方法论」这条对引导同样适用；② 回复里不出现内部名（`world.json` / `world_update` / 背景包 / 约束 target 一律翻译成界面语言，对齐 `writer-main.md` 的回复纪律）；③ 一次只讲一条，不朗读功能清单。
- [test] `test/skill-references.test.ts` 从「只管 craft」扩成**所有技能通用**的护栏（12 → 15 例）：每个技能的 SKILL.md 都能被 vendor 真实加载并出现在 `<available_skills>` 里、`<location>` 正确；显式写出的 `references/` 路径不悬空，**跨技能转发**（`outline`/`critique`/`revise` 指向 `craft` 的方法论）在别的技能里唯一命中、不歧义；每个技能 `references/` 下的文件都被自己的 SKILL.md 提到过；每个技能的 frontmatter `name` 与目录名一致、`description` 不超 vendor 的 1024 字符上限、且都能通过 vendor 的加载校验。以后新增技能忘接线，这组直接拦下。
- [docs] README 的「写作技能」一行补上 `onboarding` 与 `craft`（此前只列了四个）。

引入网文创作方法论文库：agent 有了「怎么写」的方法，而不只是「写到哪」的工具。

- [feat] 新增 `craft` 技能（`skills/craft/`）：收录开源项目 oh-story-claudecode（MIT）的**纯创作方法**文档 76 份 / 约 884KB，覆盖选题卖点、金手指、大纲与卷纲节奏、开篇黄金一章、人物设计与关系感情线、情绪与爽点、章级钩子、反转与悬念、对话、场景、去 AI 味与文风裁决、题材框架与 32 张题材正文卡、审稿 rubric。其中**只有 `SKILL.md` 是手写的**——一张「什么场景读哪一份」的路由表；方法论文档逐字节原样保留（已逐份 sha1 比对上游），既保真，也让以后同步上游可机械化。
- [feat] 收录判据（写在 `ATTRIBUTION.md` 里）：只收**方法**，不收**流程**。凡依赖上游宿主机制才能执行的一律排除——8 个 hook、7 个专业 agent、`/story-setup` 部署器、`workflow-*.md` 与 `_tracking-state.json` 追踪协议、拆文/扫榜/导入流程、宿主适配、短篇专用，以及上游在多个 skill 下重复存放的同名副本（342 份 references 里只有 252 份唯一，重复占用约 850KB）。
- [feat] `outline` / `critique` / `revise` 三个技能各加一节，把对应方法论转发到 `craft` 的具体文件——**不复制副本**，符合本仓库「单一真相源」的约定。`craft/SKILL.md` 另有一条硬约束：这批文档配的是上游的「文件树当记忆」，本仓库的落地形态仍是 `world.json` 唯一真相源，文档里出现的 `设定/`、`大纲/`、`追踪/`、`拆文库/` 路径只当内容组织思路看，不得照写。
- [docs] MIT 许可证随副本保留（`references/LICENSE-oh-story-claudecode.txt`）；上游 commit `dab9e18` 与「再 vendor 步骤」记在 `ATTRIBUTION.md`。收录文件里残留 5 个指向上游流程文件的交叉引用，逐个登记在案并写明「忽略即可、不要去找」——改写上游原文会让「逐字节一致、可机械升级」失效，不值当。
- [test] 新增 `test/skill-references.test.ts`（12 例）：① 路由表索引的每份文档都在磁盘上、磁盘上每份文档都被索引到（双向一致——同步上游时挑进新文件却忘登记、或漏改路由表，直接红）；② 收录文件不含上游流程/宿主耦合标记（`拆文库`、`tracking_commit`、`storyctl`、`{PYTHON}`、`target_cli` 等），防止同步时夹带流程类进来；③ 残留断链逐个在 `ATTRIBUTION.md` 登记过；④ `description` 不超过 vendor 的 1024 字符上限；⑤ 用真实的 vendor `loadSkills`/`formatSkillsForPrompt` 跑一遍，确认 `craft` 真的进得了 `<available_skills>` 且 `<location>` 正确（前四组只证明「文件是对的」，这一组证明「模型看得见」）。

技能目录清单收敛到唯一真相源：编辑页对话（常驻编剧会话）也拿到打包自带的技能。

- [fix] 「模型说它目录里有 skill，但没加载进系统提示词」：打包自带 `skills/`（outline / critique / revise / stage-scripting）此前靠各装配点自己经 `additionalSkillPaths` 传入，`src/web/writer-host.ts`（编辑页「AI 伙伴」对话与经典模式背后的常驻编剧会话）漏传——它的系统提示词里只剩全局 `~/.agents/skills`，而模型能经 `read` 读到 `skills/<name>/SKILL.md`（工具守卫只读放行），于是自报「目录里有、提示词里没有」。现在清单收敛到 `src/session-factory.ts` 的 `sessionSkillDirs()`（自带 `skills/` 恒加载 + 调用方附加目录 + 全局技能目录，且 `skillPaths` 与守卫的 `readOnlyDirs` 同源），cli / web 不再各自传；舞台角色显式 `packagedSkills: false` 保留原有收窄（剧本方法以绝对路径注入）。回归护栏 `test/skills-dir.test.ts`。

会话级设置真正换得动：`POST /api/model` 与 `POST /api/thinking` 此前只打**主会话宿主**，而聊天根本不走它。

- [fix] 「在同一个对话窗口里换模型」不生效：编辑页的对话走编剧会话（`/api/writer/:slug/chat`）、舞台页走编排器会话，模型在会话创建时就绑死（vendor `sdk.ts` 的 `defaultModelId: settingsManager.getDefaultModel()`，之后只有 `session.setModel()` 能改），于是换完模型要等换章或重启才生效；而设置页读到的「当前模型」来自主会话——看起来还切成功了。现在 `applyToAllSessions` 把主会话 / 编剧 / 舞台三处一起换（与 `POST /api/sampling` 早就在做的转发对齐），逐个宿主尝试后再报错：某个宿主临时不可用不该让其余的也跟着不动（失败 → 400，消息里点名是哪个没换）。
- [feat] `WriterHost.setModel` / `setThinkingLevel`（已建编剧会话即时生效，之后新建的会话按新值装配）、`StageHost` 与 `StageOrchestrator` 的同名方法（导演 / 收幕编剧即时生效；演员在 `cast.json` 里单独指定 `model` 的保留覆盖，思考档位属于角色设计、不动演员）。
- [fix] 会话装配工厂里的模型与思考档位改成 getter：`createSessionRuntimeFactory` 在**每次**装配（含 `reloadRuntime`）时才读它们，此前把构造时的 `--model` 固定进闭包——带 `--model` 启动时换完模型、会话一重建又退回旧值。
- [fix] 设置页文案「切换后对下一次对话生效」改成「切换后立即生效，包括已经开着的对话（编剧与舞台会话一并更换）」；思考级别补一句「舞台演员的思考档位属于角色设定，不受影响」。

状态切换动画覆盖度：把「进场有动画、退场硬切」的整片缺口补齐，并把散落的时长/技术收敛到同一套 token。

- [feat] 新增退场机制 `web/src/use-exit-presence.ts`（`useExitPresence`）+ `web/src/styles/presence.css`：条件挂载的弹层在卸载前多驻留一个动画时长并加 `.is-closing`，播放与入场对应的反向动画（居中弹窗缩回、底部表单页/整屏导出下滑、下拉与 ⋯ 菜单下沉、整屏层淡出）。系统开启「减少动态效果」时直接卸载，不做无意义等待。
- [feat] 退场补齐的清单：设置页供应商整屏层、添加供应商 / 添加（编辑）模型、修订剧本模态、ask_user 提问浮层、全屏编辑器、工作区文件预览、导出面板、手机端整屏导出、会话用量卡、统一 Select 下拉、手机端页头 ⋯ 菜单、手机端主题选单、重运行配置向导。
- [fix] 桌面右栏（AI 伙伴）与舞台右面板的收起/展开不再是硬切：宽度落到子项自身、grid 轨改成 `auto`（`grid-template-columns` 本身不可动画），走 `--dur-slow` 宽度过渡；拖拽调宽期间自动关掉过渡保持跟手。
- [fix] 手机端舞台右面板打不开：CSS 里的 `.stage-grid.phone-panel-open` 从未被 StagePage 应用（≤900px 时 `.stage-panel` 还是 `display:none`），点「剧本与设定」只挂出一层遮罩。现在类名真的挂上、抽屉从下缘滑入滑出。
- [fix] 右栏标签 chat ⇄ memo 两个方向都有动画（此前只有 memo → chat 一条单向滑入），方向与舞台右栏同一套约定。
- [fix] 反馈类状态不再是瞬时跳变：`.notice` 提示条（含上下文占用 ≥80% 警告）入场淡入、草稿错误框、备忘录新增与完成态、工具块出现与 run→ok/err 变色、压缩指示器、思考指示器、空态 ↔ 消息列表、分支栏、书库列表新增条目、世界树子节点。
- [fix] 顶栏保存状态文案改成「重挂载 + `fade-in`」（原来的 `key` + 内联 `transition` 没有过渡起点，等于空转）；手机端页头状态圆点的绿/琥珀/红也走过渡。
- [fix] 长内容折叠块（FoldablePre）改用与思考块 / 预览卡同一套 framer 交叉淡入（此前是换文本硬切）。
- [feat] 骨架屏：新增 `.skeleton` / `.sk-lines` / `.sk-rows`（书库栏章节区、纸张区、世界书三处替换「加载中…」纯文字），首屏拉书不再先闪一帧「还没有书」。
- [feat] 手机端层级导航有方向：世界书条目详情自右推入、返回时详情向右退出（延迟清空选中，等退场播完）；供应商列表 / 选择 / 详情三态与设置子页同样。
- [fix] 26 个「有 hover 反馈但没有 transition」的选择器（拖拽手柄、错误链接、导出次按钮、用量关闭、确认卡按钮、工作区文件行、世界书信息按钮、关键词 chip 等）与手机端 7 处 `:active`、全局按压 `scale(0.96)` 补上 token；3 处裸时长 `0.15s` 改成 `var(--dur-fast)`。
- [feat] 预览卡「智能折叠」：卡片级开合此前只有手动入口且默认全开，一回合改了几百行 diff / 多条词条时，一张卡就把消息流撑爆。现在默认开/收由内容体量决定（`fold.ts` 的 `previewWeight`/`shouldAutoFold`：草稿按 diff 行数、词条按条数、世界树按变更处数、剧本按节拍数），体量超过 `PREVIEW_AUTO_FOLD_WEIGHT`(60) 才默认收起；**体内有动作按钮、或 `forceOpen` 时一律展开**（否则按钮会被藏进折叠体）；收起时补一行「共 N 行 diff / N 个词条」摘要，让"收了多少"可见；收起的卡片**不渲染 body**，大 diff 的行不再进 DOM。内容在流式中"先小后大"时会跟着自动收起，但**用户一旦手动开合就不再自动干预**。
- [fix] 弹出层时长漂移收敛：`.slash-menu` / `.at-menu` / `.export-panel` / `.usage-pop` 原先用 `card-in-bottom 120ms`（120ms 不在 token 三档里，且与卡片档共用 60px 位移）。新增 `@keyframes pop-in`（6px 淡入上移）承担浮层小位移档，时长改 `var(--dur-fast)`；`card-in-bottom` 的 60px 只留给卡片级容器。
- [fix] 退场时长与卸载超时对齐：`presence.css` 的退场规则原先混用 `--dur-slow`(320ms) 与 hook 的 200ms 默认值，导致宽屏弹窗/手机抽屉在动画播到一半时被卸载（表现为「卡一下再消失」）；现在统一 `--dur-base`，并让每处退场方向对偶其入场。同时补齐 `.rsm-mask` / `.wz-overlay` / `.m-sheet` / `.stage-panel` 的选择器（原先泛型 `.is-closing` 覆盖不到，退场动画实际没播）。
- [feat] 调试模式新增「UI 房」（`web/src/pages/UIRoom.tsx`）：全部 UI 组件的陈列室——调试模式打开时顶栏（手机端是抽屉导航）多一个入口，页内按六个分组铺开每个组件，每格可切 2-4 个状态档（空态 / 满态 / 极端长内容 / 失败态 / 禁用态 / 折叠态），另有搜索、分组筛选与「带框格子」宽度档。固定定位的弹层用一层 `transform` 容器当包含块关进格子里，不再一展开就盖住整页。
- [feat] 展项表本身是契约：`web/src/uiroom-types.ts`（分组 / 展项 / 状态档类型 + 覆盖计算）+ 六个展项文件 `web/src/uiroom/{atoms,chat,world,settings,stage,tokens}.tsx`。`test/uiroom.test.ts` 扫 `web/src/components/` 的真实文件清单逐一对照——**漏陈列的组件、登记了却没渲染的展项、状态档文案与顺序不一致、渲染期抛错，测试全红**（node 下用 `react-dom/server` 把每个状态档渲染一遍）。以后新增组件忘了进 UI 房，契约测试会直接拦下。
- [feat] UI 房默认走「隔离演示」：有一批组件（供应商列表 / MCP / 插件 / 导出 / 工作区 / 全屏编辑器 / 配置向导）是**直接拿 client 干活**的，格子里点一下就会真的删凭据、改配置、导出整本书或写文件。UI 房用 `stubClient()`（所有请求 reject）渲染它们并在格子上打标，所以误点不会动真实数据；顺带把「请求失败」这一档平时构造不出来的状态也陈列了。要看真实内容就在工具条切「数据:真实服务」（标记转红警示）。
- [fix] `graph-styles.ts` 的 `themeVar()` 在没有 DOM 时回退默认色(此前直接读 `getComputedStyle(document.documentElement)`,node 下抛 ReferenceError)。它在**渲染期**被 `PreviewEntryCard` 的首字头像调用,所以这是个只在浏览器里不炸的取值口;现在与 `useMediaQuery` / `useExitPresence` 的「SSR 安全」写法一致,该组件也因此重新进了 UI 房的 SSR 冒烟(不再挂免测牌)。
- [refactor] 页面导航条目收敛到唯一真相源 `web/src/nav.ts`（页面集合 + 经典模式去掉舞台 + 调试模式追加 UI 房）：`ChapterSidebar` 的手机抽屉与 UI 房自带的手机导航共用一份；设置页「调试模式」卡里加了「打开 UI 房 ›」。
- [fix] 关掉调试模式时若正停在 UI 房，视图拉回编辑页——UI 房与调试模式同生命周期（关掉即卸载），否则会停在一张不存在的页面上。

- [fix] 动效审查的剩余机械收敛（收尾）：① 全仓 **174 处**「给了时长但没写缓动曲线」的 `transition` 子声明补上 `var(--ease-out)`（浏览器默认的 `ease` 不是 token 曲线，同一交互不同属性会各踩一条）；② 4 处循环呼吸动画的裸 `ease-in-out` 换 `var(--ease-inout)`；③ 重复关键帧收敛到各留一份：`wz-fade`/`rsm-fade` → `fade-in`、`ws-pv-in` → `fade-up`、`rsm-pop` → `wz-pop`、`.compact-spin` 并入 `.act-spin`、`.m-live` 复用 `.companion-live`；④ 「减少动态效果」下章节目录的折叠退场不再收缩 margin/padding（framer 的 `reducedMotion` 只覆盖位移类属性），关系图联动居中改直接 `cy.center`；⑤ reduced-motion 熔断块补 `animation-delay: 0s / transition-delay: 0s`（只清时长不够——关闭态靠 `visibility 0s var(--dur-slow)` 的兜底延迟仍会真等 320ms）；⑥ 删死代码 `motion.ts` 的 `T` 与 `EDGE_IN.left`（无消费点），关系图内联表单的遮罩补淡入、正在滑出的视图交还点击、折叠箭头时长与其余 5 处对齐;⑦ 抽屉遮罩(mask)退场的一帧就 `pointer-events: none`(200ms 淡出期间遮罩仍铺满全屏,会吞掉抽屉关闭后紧接着的那一下点击——headless chromium 实测过穿透)。
- [docs] 新增动效契约 `test/motion.test.ts`：扫全部 CSS 校验 —— ① `DUR`/`EASE` 与 `--dur-*`/`--ease-*` 逐值相等；② `EDGE_SLIDE` 与 `slide-*` 关键帧位移一致；③ 每个被引用的 animation 名都有 `@keyframes`；④ reduced-motion 块同时熔断 animation/transition 时长；⑤ **裸时长白名单只放无限环境循环与 spinner**（`sk-flow 1.4s` 属前者）。一次性时长一律必须走 token，否则测试直接红。

对话流里的重复渲染修掉:provider 把正文放进**第一个分片**时,AI 回复会在流里出现两份。

- [fix] **首帧就带正文的流不再渲染两遍**:vendor 的 `message_start` 是 `{ ...partialMessage }` 浅拷贝,`content` 与流式对象**共享同一个数组** —— provider 把正文放进第一个分片时(部分 OpenAI 兼容网关、非流式代理转流式),reducer 收到 message_start 里已经是全文,而紧随其后的 `text_start`/`text_delta` 又把同一段送一遍,于是正文与思考都出现两份。整段放进首个 chunk 的流必现,多段小 delta 的常规流不触发,所以一直没被发现。修法:末块文本以事件里的 `partial`(该条消息的累积快照)为准 —— **整块覆盖**天然幂等,重复投递 / SSE 重放也不会数错;`*_start` 同样按快照判断「末块就是这一块」,不再多开一个空块。事件不带 `partial` 时退回原来的追加路径,老行为一字不变;水合与 user 消息的 echo 照旧在 message_start 种 content。
- [test] `test/store.test.ts` 新增 8 例:首帧带全文只出现一遍 / 快照重复投递幂等 / 思考同理 / 一段消息里两段正文不被合并 / 常规流不回归 / 无 `partial` 走老路 / 水合与 user 消息照旧。真机复验(无头 chromium + 单块 delta 的 mock):修前消息流里两个节点各一份,修后只剩一个。

手机端：编辑、伙伴对话、世界书、舞台、设置全部按手机重排 + 一批窄屏缺陷修复。

- [feat] 窄屏与手机端分成两档：≤900px 仍是原来那套（两侧栏变抽屉，平板竖屏照用），≤700px 才换手机端布局——顶栏下线，四个页面各自的页头显示标题、保存状态与字数。
- [feat] 四个页面的入口收进书库抽屉：品牌头 + 舞台 / 编辑 / 世界书 / 设置，点条目先切页再关抽屉。
- [feat] 编辑页：页头是章节名 + 「已保存 · 1,284 字」；底部常驻输入条（输入框 + 上下文圆环 + 发送钮）。它和伙伴对话共用同一条，切到哪边都是它，草稿不会分成两份。
- [feat] 编辑页不再套一层纸面卡片，正文直接落在底上（16px / 行高 1.9 / 左右 20px）；原本占一行的导出与全屏编辑收进页头「⋯」菜单。
- [feat] 伙伴对话改整屏页：页头是「← 编剧 · 第一章 · 上下文 62%」+ 备忘录 / 用量；用户消息改成右对齐的琥珀气泡。
- [feat] 文件抽屉加了搜索框（按章节名与书名过滤，计数跟着变）和页脚「本地草稿 · 不上传 | N 字」。
- [feat] 世界书条目页改成「搜索 + 类型筛选（全部 / 人物 / 世界 / 时间线 / 大纲）+ 卡片列表 + 底部「＋ 新建条目」」；卡片上直接看得到类型、关联数、摘要与标签。
- [feat] 世界书条目详情分成两级：先看只读详情（配图、名称、类型、关系数、正文、标签，以及条目 ID / 状态 / 关联章节 / 关键词 / 更新时间），底部「编辑条目」再进表单；返回箭头跟着层级走（回列表 / 回详情 / 回编辑）。
- [feat] 舞台页新增演员条：头像 + 角色名，末尾「＋」直接开选角。
- [feat] 舞台的演出流按手机重排：场景胶囊居中、旁白居中斜体、演员发言是「头像 + 名字 + 气泡」、导演的指令是琥珀色一条；手机上固定用气泡形态，桌面选的文档流不带进来。
- [feat] 演员按身份着色：主角琥珀、群像蓝、旁白灰，名字与头像圈同色。
- [feat] 舞台新增「下一步 · 可选」：把剧本节拍摆成几个芯片，点一条就直接发给导演推进。
- [feat] 剧本 / 选角 / 修订 / 备忘录在手机上是底部抽屉，从页头打开。
- [feat] 设置改成手机端的一屏分组清单：按小节列出真实设置（外观 / 模型与服务 / 写作 / 实验 / 高级 / 集成），行上直接显示当前值（主题名、当前模型、思考级别、已配置服务数、世界书条目数、shell 方言），开关行就地切（自动展开思考、回车直接发送、编辑免确认、经典模式、调试模式），主题行就地弹选单（浅色深色合并成一条，再点一次在浅深之间换）。
- [feat] 设置页页脚显示版本号：「pi·writer vX · 数据仅保存在本机」。
- [feat] 设置页的手机端改成「一屏一件事」：点一行只进只放这一项的页面（默认模型 / 思考级别 / 采样参数 / 世界书注入 / 图片生成 / 执行命令 / 依赖与配置向导 / 自定义主题 / MCP 服务器 / 插件），不再把一个桌面分类整页搬进手机。
- [feat] 「添加供应商」与「添加模型」分成两件事：添加供应商只填它自己的 ID / 名称 / 接口地址 / Key，保存后到它的详情里再逐个添加模型。
- [feat] 管理供应商在手机上是整屏页，分两层：先是「已连接的供应商」各一张卡（名称、在用的模型、当前默认标记），点进详情看 Base URL、API 格式、Key 与模型列表，可就地测试连接、移除凭据；底部「添加供应商」进全部供应商清单里挑一个（默认不替你挑，先给列表）。
- [feat] 导出在手机上是整屏页（页头「← 导出 书名」）；桌面端页头那颗「导出」按钮与它弹出的面板照旧。
- [feat] 世界书关系图在手机上是全屏画布：顶部一排类型筛选（全部 / 人物 / 世界 / 时间线 / 大纲）、右上「连线」胶囊与撤销 / 重做、底部缩放条（一键排列 / 缩小 / 比例 / 放大 / 适应）；点节点从底部详情卡看它的类型、状态与关系清单，可就地「查看词条」或「在舞台使用」，卡也能收起只留一行。
- [fix] 手机端点世界书卡片进不去条目详情：点了只把搜索框收起来，列表还在原地。
- [fix] 手机端设置里的「供应商」一行点了没反应：打开的整屏浮层挂在另一个渲染分支上，索引页根本不会渲染它。
- [fix] 桌面设置页里「说明在左、控件在右」的行（shell 方言、shell 路径、下拉选择）在手机上会把左侧说明挤成一列单字，现在窄屏一律上下排、控件占整行。
- [fix] 在已有供应商下添加模型时，不再把整条供应商标成 Chat Completions，也不再顺手改掉它的接口地址（之前会连带影响该供应商的所有模型）。
- [fix] 添加 / 编辑模型与添加供应商在手机上是底部表单页，不再用居中弹窗；桌面这两张表单也不再被撑到 680 宽。
- [fix] 手机端设置里的开关被撑成一颗琥珀药丸、发送钮被拉成椭圆，现在都回到正常尺寸。
- [fix] ⋯ 菜单里的导出打开后菜单不收、两层浮层叠在一起；现在导出是独立整屏，菜单点完即收。
- [fix] 关系图上写成长句的关系词不再沿边斜着铺满画布、盖住节点：画布上收成短标签，完整内容在详情卡的关系清单里看全。
- [fix] 手机端关系图条目少时不再把视野顶到 200% 以上（两个节点也撑满一屏，节点圈和名字溢出画布）。
- [fix] 手机端抽屉被底部输入条压住，现在抽屉与遮罩盖在输入条之上。
- [fix] 断点来回切换的瞬间，手机端的页头与输入条会闪一下。


## [0.1.0] - 2026-09-23

报错原文照实显示 + 供应商列表列全 + 一批假成功与丢数据的修复 + 会话用量。

- [feat] 模型报错时不再只显示一句「当前模型不可用」，而是在对话里落一张报错卡：归类标题 + HTTP 状态码徽标 + 供应商返回的原文逐字照抄 + 「重试 / 复制原文 / 去设置模型」。原文框另给一行 provider 与 model，复制按钮连这行一起复制。
- [feat] 报错归类覆盖密钥无效、未配置密钥、认证失效、未选择模型、余额不足、请求过于频繁、请求超时、模型不存在、上下文超长、网络连接失败、权限被拒绝、供应商 5xx，认不出的退回「模型返回错误」。归类失败只让标题笼统，原文永远完整。
- [feat] 报错卡的重试：已发出的消息会撤回并以同样的文本重发，重试多次只占一条分支；还没发出去就失败的（比如没配密钥）直接用本地留底重发。
- [fix] 真实的供应商报错（401、限流、余额不足）此前在界面上只表现为一个空的「PI」气泡，看起来像卡住，现在都会变成报错卡。
- [fix] 刷新页面后报错卡不再消失。
- [feat] 设置 - 模型 - 管理供应商的左栏列出全部供应商，已配置的排前面并带「已配置」胶囊；未配置的也能点开看 Base URL、API 格式与模型列表，并就地填写 key。
- [fix] 左栏此前只列出已配置的那一个，页脚却写着「共 17 个可选，点上方浏览全部」，点进去是自定义供应商表单，那 17 个在设置页根本没有入口。
- [fix] 测试连接不再对失效的密钥报「连接正常」：此前一把已被删掉的密钥会显示「连接正常，该供应商有 3 个模型可用」，现在直接红字报出供应商返回的鉴权错误。
- [fix] 首启向导的模型服务步存完 key 会立刻验证一次，被供应商拒绝的密钥当场说明，此前挂着绿色「已配置」一路放行，第一次真对话才炸。
- [change] 测试连接成功时的文案改为「目录刷新无误」，因为对目录来自内置清单的供应商，这个按钮验不了 key，不把话说过头。
- [fix] 未配置的供应商不再显示无法使用的测试连接；纯 OAuth 的供应商不再显示一个填了也会被拒的 key 输入框。
- [fix] 管理供应商弹窗底部的按钮与页脚不再被列表顶出视口；左栏加宽，最长的供应商名不再被挤成省略号。
- [fix] 生成过程中打字点发送，文字不再被清空：此时发送键置灰并写明原因，输入框原样保留，此前是文字消失、没发出去、也没有任何提示。
- [fix] 世界书自动保存期间继续编辑，最后一次改动不再丢失，此前会既没写盘、也不再显示未保存。
- [fix] 世界书被其他窗口或 AI 改过之后，保存不会再永远失败，按提示再保存一次即以本地版本覆盖，此前除刷新页面无路可走。
- [fix] 正文写盘失败后，其他窗口一改动该文件不再静默丢弃本地未保存的内容，而是给出冲突提示让用户自己选。
- [fix] 备忘录（待办板）在切换书籍后不再把内容写进上一本书。
- [fix] 舞台页的导出书与重命名章节失败时不再毫无反应。
- [fix] 报错卡的复制原文不再无条件显示「已复制」，写不进剪贴板时显示「复制失败」。
- [fix] 集成里的 MCP 直接编辑文件读取失败时不再毫无反应，此前点上去像按钮坏了。
- [fix] 导出面板的统计失败不再永远停在统计中，改为「统计不可用（仍可直接导出）」。
- [fix] AI 提问选项卡的提交与取消失败时会给出提示，此前浮层原地不动。
- [fix] 书库导出的下载在 Firefox 与 Safari 上不再偶发不开始。
- [feat] 输入条上的上下文圆环不再需要先在本章说一句话才出现，重启服务后打开页面就有。
- [fix] 编剧会话对齐失败时会自动重试，不再出现编剧对话永久空白，此前只能等一次断线重连。
- [fix] 舞台页正在流式输出的回复不再被截断。
- [fix] 插件启用、停用、删除后，设置页左栏的插件分类会跟着更新，此前要刷新页面。
- [fix] 首次启动向导不再装出两本书：书库已自动创建的那本「未命名」会被向导第 4 步复用（改名）。
- [fix] 重跑首启向导时，模型服务步的已完成标记不再一直是未完成。
- [feat] 点输入条的上下文圆环可查看本会话用量：消息数、工具调用次数、Token 合计、输入与输出、缓存读与写、成本，以及按模型拆分的成本与 token。
- [change] 用量卡的成本在该模型没有配价格时显示「该模型未配价格」，不显示成零让人以为免费。
- [chore] 测试不再往真实用户目录里写残留文件。


## [0.0.8] - 2026-09-21

界面改版 v2(思考链与工具块按事件顺序穿插)+ AI 提问选项卡 + shell 能力叙述与方言自动识别。

改造前 `ChatMessage` 是 `{text, thinking, toolCalls}` 三个平铺字段,一个用户回合里多段「思考 → 工具 → 思考 → 工具 → 正文」被 reducer 用 `\n\n` 拼成「全部思考 + 全部正文 + 全部工具」——顺序在归约那一刻就丢了;渲染侧顺序还写死成「思考胶囊 → 思考体 → 正文 → 工具区」,所以工具卡必然堆在正文末尾。这一版把顺序变成数据。

### 消息流

- 顺序即数据:`blocks`(思考 / 正文 / 工具的有序序列)取代三个平铺字段。`message_start` 是段边界,`*_start` 开块、delta 落末块,工具块由 `tool_execution_start` 开出——位置天然落在本段正文之后、下一段思考之前。
- 每个思考块自带折叠胶囊(`› 思考 · 243 字`),不再把整轮思考拼成一颗。
- 回合折叠胶囊:元信息行新增「`›` 已工作 2 分 53 秒」,一键把整轮过程(思考 + 工具)收起来只留正文结论;流式中强制展开。计时起点取 `turn_start`(用户发出那一刻),不是首个 token。
- 块渲染表(取代「简化输出」这个全局开关):`bash` → 终端块(命令与输出必须摊开);产出型(write/edit、world_update、script_confirm)→ 预览卡;读取型(read/grep/find/ls)→ 动作行;`word_count`/`world_find` → 默认不显示,失败时露出;未知工具(MCP)→ 动作行,不会消失。
- 删掉「动作流只保留最近 3 条」:行有了自己的位置之后,不该由全局逻辑替用户丢历史。

### 预览卡

- 预览卡 = 工具块自己的渲染结果,不再是锚定在 assistant 消息下的独立一层。挂载键从消息 id(`anchorId`)换成工具调用 id(`toolCallId`):块在,卡就在;取不到就降级为动作行,不再飘到列表末尾兜底。
- 连带删掉「最后一条 assistant 的内存随机 id 在 `message_end` 后升级为 entryId、再回头改写卡锚点」的接力——它存在的唯一理由就是卡片得自己找宿主消息。
- 舞台页的世界书预览与剧本确认卡从「锚在对话末尾的浮层」改为挂在 `world_update` / `script_confirm` 工具块上。

### 历史水合

- 水合还原工具调用(上一条的硬前置):`extractMessagesFromManager` 改为产出有序内容,工具结果按 `toolCallId` 从独立 `toolResult` entry 配对回填;纯工具调用段(无正文无思考)不再被丢掉。顺带修掉一个既有缺陷:刷新后历史工具卡本来就全没了。
- 回合耗时从 entry 首末时间还原,刷新后仍在。
- `text`/`thinking` 保留为兼容投影(TUI 与分支摘要仍按整条消息取文本)。

### 调试模式(取代「简化输出」)

- 「简化输出」是个默认开的开关,要看详细得去关掉它——方向与名字相反;而且挂在首启向导里,等于把开发者的排障开关摆给第一次用的用户。
- 现在它是排障开关:默认关,语义是「每个工具块退回原始工具名 + 完整参数 + 完整结果」(美化卡恰恰藏了参数,拿它排障是错的),并且平时界面里根本没有这一项——要在 F12 控制台跑 `piWriterDebug()` 解锁才出现,`piWriterDebugOff()` 关闭并重新隐藏。
- 旧键一次性迁移(取反):当时关掉简化输出的用户保持观感不变(迁移时一并解锁,否则界面里看不到这一项、也没有开关可关)。已从首启向导移除。
- ⚠️ 它不是权限门,防的是误触而非恶意。

### 新功能:AI 向用户提问的选项卡(`ask_user`)

AI 可以在岔路口弹出一张卡片让你选,而不是替你决定或者写一堆"你可以选择 A、也可以选择 B"。

- 工具即卡片:`ask_user` 一次可问 1-4 个提问(`‹ 2/3 ›` 翻页),每题 2-4 个候选,再给你一个「其他补充」自己写。卡片贴着当前输入条的上沿弹出(编辑页的 AI 在右栏、舞台页在主区,居中弹窗会飘在无关区域上方);有薄遮罩——工具阻塞着等这个回答,背后不该还能点。
- 单选与多选:单选给编号,多选给复选框(形态本身就在说明"能选几个"),多选时左下角显示「已选择 N 个」。每题的「其他补充」在多选下是追加项,不会清掉已勾的候选。
- 可选「跳过」:留空的题在工具结果里写成「（用户跳过，未作答）」,而不是一个空字符串 —— 模型才分得清"他没选"和"他选了空的"。两个前进动作(确认 / 跳过)都在没有未决题了时提交,不会答到一半就把其余静默丢空。
- 选完提交,AI 在同一个回合里接着往下写,不额外多一轮往返。
- 块模型直接复用:卡片挂在 `ask_user` 工具块上(`result === null` = 正在等回答),不需要新增事件类型 —— 2026-09-19 那套「块渲染表 + 工具块是卡片宿主」正好支持这个形态。已答的提问原地折成「问题一行 + 答案一行」留在对话里。
- 取消不报错:关闭卡片 / 中断本轮 → 工具结算为「用户未回答」并返回一段说明,让模型自行取最合理的一项;不抛错,否则模型会把「用户没选」当成工具故障去重试。
- 可用范围:编剧会话、经典模式写作会话、舞台导演(导演是舞台页主交互,「剧情往哪走」正是最该问用户的岔路)。演员不给(角色扮演不该跳出剧情向用户要决定)。
- 端点:`POST /api/ask-user/answer|cancel`;`中断本轮` 会一并结算所有未决提问,避免工具永远挂着导致回合结束不了。

### 新功能:回车键行为可选

设置 → 界面偏好新增「回车直接发送」。默认仍是回车换行、Ctrl+Enter 发送(后加的开关不替老用户改键位);开启后回车发送、Shift+Enter 换行、Ctrl/Cmd+Enter 依旧发送。舞台页底部的键位提示跟着切换。

### 修复:无正文的助手记录在刷新后整条消失

「只有思考 + 工具调用、没有正文」的记录(典型:提问卡片弹出来的时候)刷新后会消失,卡片跟着一起没。根因是导演对话在内存里又投影了一次(`getDirectorChat`),只拷 `role/text/thinking` 且 `text` 为空就跳过 —— 2026-09-19 升级水合时漏了这一处。现在与 `extractMessagesFromManager` / `readDirectorChatFromDisk` 同口径(带有序 `content`,`text` 与 `content` 皆空才算空记录)。

### 提示词:拿到 shell 就如实说清能力范围(2026-09-20)

- 此前三档方言都只写「工作目录为书目录」,还把联网说成「浏览器与联网能力仍需经外部工具挂载」——与事实相反:shell 以 pi-writer 服务进程的用户身份运行,能访问网络、执行任意代码与程序、读写书目录之外的路径(路径守卫管不到它,见 `docs/security.md`)。
- 模型不知道自己的能力范围就会绕远路:该联网查证时说自己没这能力、该跑脚本时纯手算。现在 `bash` / `pwsh` / `powershell` 三档都写明「这是整台机器的权限,不只是书目录」,并列出包括但不限于:访问网络、执行任意代码与程序、读写书目录之外的路径。`none` 档不变(没有就不能吹有)。
- 顺带修掉 `none` / `bash` 两档里多出来的一层反斜杠转义(`` \`bash\` `` → `` `bash` ``),与 pwsh 两档对齐——那层反斜杠是会被原样喂给模型的。

### shell 方言按平台自动识别(2026-09-20)

- `shellKind` 新增 `auto`(新缺省):非 Windows → bash;Windows → PowerShell(7 的标准安装目录 → PATH `pwsh` → 系统自带 5.1 带 warning),一个 PowerShell 都没有才落回 bash,并给出「需要 Git Bash」的 warning。
- 旧缺省是钉死的 `bash`——而 vendor 的 bash 通道在 Windows 上只找 Git Bash,找不到直接抛错,等于 Windows 用户一开「外部命令」就撞报错。现在按平台识别开箱可用,想固定方言仍可显式选 `bash` / `pwsh`(显式选择不做平台纠正)。
- 设置页下拉加「自动(按平台识别)」;「实际使用」那行改为只要开着、或有 warning 就显示——「自动没探到 PowerShell」「选了 pwsh 但本机没装」正是要在启用之前就看到的信息。

### 修复:斜杠菜单上下键不生效、输入框像被锁住(2026-09-20)

两个缺陷叠在一起:

- 选中项不动:textarea 的 `onKeyUp` 无条件 `refreshMenu()`,而刷新会把 `index` 打回 0 —— 方向键刚挪完就被重置。现在刷新只在查询变了时回到第一项,查询没变就保留当前项(并按新结果数夹紧)。
- 输入框被锁:只要菜单里有候选项就 `preventDefault`,于是候选项只有 1 个时方向键既不挪菜单、光标也动不了。现在候选项 ≤1 时把键还给文本框(`/compact` 这类 action 命令就是单候选项)。
- 方向键改函数式 `setMenu`,连按两次不再读上一帧的旧下标而丢掉一步;被菜单消费掉的 `keyup` 不再回灌给刷新逻辑。
- 判定逻辑抽成纯函数 `slashArrowMove` / `keepSlashIndex`(`web/src/slash-commands.ts`)并单测——「该不该吃键、挪到第几项、重建时保不保留」是这一处的全部规则,放在组件里测不到。

实测(chromium 实跑 `/` 菜单):`/` → 4 项,按下键 0 → 1 → 2,按上键 0 → 3(环回);`/compact` → 1 项,方向键 `defaultPrevented === false`(不再吞键)。

## [0.0.7] - 2026-09-19

界面改版 v1:重做 web 前端。

### 设计基座

- 字号收敛为 8 档:`11 / 12 / 13 / 14 / 15 / 18 / 22 / 34`,全站字号声明按语义归位。窄屏输入控件保留 16px。
- 圆角(8 / 12 / 16 / 999)、间距(4 / 8 / 12 / 16 / 20 / 24)、CSS token,页面样式只引用 token。
- 词条类型色独立成层:人物 / 世界 / 时间线 / 大纲各有专色,6 套内置主题各配一套,不再与表示成功、失败的绿红撞色。
- 图标全部换成同源图标:导航、侧栏、页签、思考胶囊箭头、工具、设置分类、世界书、首启向导共 58 枚,零新依赖。仅动作流的「进行中」转圈为自绘。
- 右栏收起态改为图标栏:舞台面板收起后为四个「图标 + 小标签」按钮,当前项带琥珀圆角底;编辑页伙伴栏收起态同款(两个标签)。收起态点其他页签只换选中、点当前页签才展开。
- 新增统一下拉组件:触发器 + 浮层 + 分组标题 + 搜索(选项多于 12 个时出现)+ 完整键盘导航;12 处原生下拉已迁移。条目表单的「关联章节」保留原生复选清单。
- 主题卡浅深合并:`<家族>` 与 `<家族>-dark` 合成一张卡,7 张收敛为 5 张;点未选中的卡取浅色,再点已选中的卡浅 ⇄ 深。设置页与首启向导共用同一实现。

### 界面

- 顶栏:导航移到品牌之后,去掉与页头重复的书名 / 字数;当前页只以字色区分,保存态改 `● 已保存`。
- 编辑页:纸张固定 728 居中;页头一行放完「章节名 + 状态胶囊 | 草稿路径 + 字数 + 全屏编辑」;左栏 240,书行只留书名、章节数移到「章节」标题右端,底部主动作改琥珀实心「＋ 新建章节」,新建书 / 导入收成一行小字;右栏 340,标签条改下划线式并加 `»` 收起(收起成 48px 竖条)。
- 舞台页:场景头收成一行(章节名 + 未开演胶囊 | 讨论模式 + `轮次 · 对话条数 · 字数`),导演指令预览收进可折叠次要行;右栏 340 + `»` 收起;四个页签改图标 + 下划线,内层「概要 / 节拍 / 演员指令」保留胶囊;新增 860px 修订剧本窗口;新增气泡差分(设置里选,默认仍是文档流)。
- 消息流与卡片:操作行从 hover-only 改常驻可点(编辑 / 复制);思考块默认收起(设置里可开「自动展开思考」);工具卡状态改胶囊;预览卡折叠头改「路径 + 增删行数」;确认卡加「待确认 / 已应用」状态胶囊;长内容(diff / 命令输出)改按行数分档折叠(>12 行折到 12 行 + 底部渐隐 + 「展开全部(共 N 行)」,展开后块内滚动);简化输出下工具调用压成一行带宾语的动词行(线性图标,不用 emoji),完成的行保留最近 3 条,bash 仍是完整卡片;失败行给失败动词(「✕ 写入失败 …」,不是「已编辑 …」)。
- 世界书:类型色更换;条目 / 关系图 / 设定三个视图切换;设定域从纵列改两栏卡片;关系图节点改「类型色环 + 首字 + 名字 + 关系数」;补条目详情空态与删除确认弹层。
- 设置页:内容列 1160、两栏卡片;新增「高级」分类(外部命令 / shell 方言与路径,带高风险胶囊 + 红色警示块);「界面」只留外观,自定义主题 CSS 下沉成默认收起的折叠区;供应商弹窗左栏只留已配置、模型按族聚合(12 → 6 族)。
- 备忘录控件收敛:待办行 = `--bg-elev-2` 卡片 + 方形勾选框(完成 = 琥珀实心 + 深色勾,文案变弱);添加行 = 描边圆角框 + ＋ 图标 + 输入框(回车添加);行尾不再挂删除按钮;舞台面板与编辑页伙伴栏从此是同一套元素。清空待办改 `world.json`(世界书页 / AI 均可)。
- 左栏(书库):书行 = 书本图标 + 书名 + ⋯(不再有章节数,也不再画琥珀左竖条);章节数挪到「章节」标题右端;章节行的操作改常驻 ⋯ 菜单;选中态统一成「圆角卡 + 字色」。
- 思考块改成元信息行内的胶囊:`› 思考 · 1,606 字`,千分位、`·` 分隔、有底色、跟着发言人排在同一行;展开时箭头翻转、正文缩进带左细线。
- 输入条统一:两处占位符只留短句(「向导演说话…」/「向编剧说话…」),键位与 `/` 命令说明不再塞进输入框;发送钮统一成琥珀圆形 ↑;带文字的琥珀主按钮另用 `.btn-primary`。
- 首启向导:从 680px 小弹窗改整屏引导;五步进度条 + 34 号标题 + 页脚主按钮;步骤二改成一列服务商单选 + 一行 key。

### 舞台 bug 修复(2026-09-18)

- 导演改「上限条数」不再误清剧本:修订剧本时只更新传入的字段,`shared`(场景 / 目标 / 节拍 / 基调 / 禁区)与 `perActor`(角色任务 / 每轮上限 / 风格示例)逐字段保留。
- 用 `script_confirm` 改正在演的一幕会被拒绝,错误里指向 `stage_revise`(不再被重写覆盖)。
- 收尾窗口改为真截止线:`/wrap` 后按截止线收束,演员每轮被告知的「剩余 X 条」如实递减,刷新 / 重连一致。
- 测试:补 `stage-script` / `stage-tools` / `stage-orchestrator` 用例。

## [0.0.6] - 2026-09-18

经典模式(单 Agent)、工作区面板、外部命令与 shell 方言。

- 经典模式:设置页「界面 → 模式」与首启向导偏好步可切换。开启后去掉的只有舞台(导演 / 演员 / 旁白那套多 Agent 共演)——顶栏不再有舞台入口、该页不再挂载;编辑页、世界书页、设置页照常,世界书页本就没有 agent,是面向人的设定编辑器。编辑页的 AI 不再是受限编剧,而是带全量工具的写作 agent(系统提示 `prompts/writer-main.md`;工具 `read/write/edit/grep/find/ls` + `word_count`/`world_update`/`world_find` + MCP;bash 默认不给,可由设置页「外部命令」显式放开),并解除「只能写当前章节草稿」的路径白名单(要能写 `outline.md` / `memory.md` / `notes/`)。
- 服务端设置:新增 `GET|PUT /api/settings` 与 `~/.pi/writer/settings.json`。经典模式改变 agent 装配,放服务端而非浏览器——多窗口/换浏览器一致;切换后 `WriterHost.setClassicMode` 释放已建会话,下一次对话按新装配重建,并经 `settings_changed` SSE 广播;前端 localStorage 仅作首帧渲染缓存,挂载后以服务端为准对账。
- 向导与设置页:首启向导「界面偏好」步新增经典模式开关(介绍步的功能卡片随模式变化);设置页新增「模式」卡与开关;编辑页在经典模式下把「编剧」标签/占位文案换成单 agent 说法。
- 测试:`test/writer-settings.test.ts`(解析容错 / 读改写 merge);`test/server.test.ts` 补 `/api/settings` 用例(缺省 / 开关落盘 / 应用宿主 / SSE 广播 / 非法字段 400);`test/settings.test.ts` 补本地缓存解析用例。

### 工作区(书目录文件清单与预览,只读)

- 定位收窄(按作者反馈):工作区只放 AI 产出的中间产物 —— 收集的资料、笔记片段、参考图,以及各章草稿。世界书生成物不再进清单:`outline.md`(大纲)、`.writer/timeline.md`(时间线)、`characters.md`(人物档案)、`world.md`(世界设定)是 world.json 的导出镜像,权威视图在世界书页,摆进工作区会被当成可以编辑的稿子(改了还会被下一次 `world_update` 覆盖)。排除逻辑收敛到 `isGeneratedView`,清单与读取端点同源(列不出来 = 也读不到)。
- 入口:编辑页左栏顶部(原来章节栏那一列)新增「章节 | 工作区」分段切换——工作区与章节列表是同一层级的两块内容,不占顶栏、不加页面;折叠态整条隐藏。
- 后端:`GET /api/books/:slug/files`(清单)与 `GET /api/books/:slug/file?path=`(单文件预览,文本回 JSON、图片回字节流)+ `src/book-files.ts` —— 按语义分组(草稿 / 资料与笔记 / 图片 / 其他)而不是镜像磁盘树:`draft/`、`stage/`、`*.jsonl` 是实现细节与机器数据,不该变成用户概念。条目带真实相对路径(想直连磁盘有出口)、展示名(`title`:草稿=章节标题,其余=文件名)、字节数、mtime、`chapterId`/`chapterTitle`;排序 = 分组序 → 草稿按书里的章序(不是 mtime)→ 组内时间倒序。
- 读取校验:`isWorkspaceFile` 与清单同源;`lstat` 拒末段符号链接、`realpath` 包含性检查拒中间目录符号链接(单测抓出来的越界洞);文本超过 512KB 截断并标记;`world.json`/`book.json`/`cast.json` 与世界书生成物一律 400。
- 前端:`WorkspacePanel`(语义分组列表 + 「AI 写过 · N 个文件」台账,台账来源是 `writer_event` 的 `tool_execution_start` 参数路径,刷新即空)+ `FilePreview`(只读覆盖层压在纸张区上,正文编辑器不卸载;文本走 marked 管线复用 `.record-md`,图片直接吃字节流,二进制给元信息)。点草稿条目 → 切回章节模式并选中该章;点其他条目 → 弹预览。
- 只读、无 CRUD:重命名/删除/移动会同时打断 `book.json` 章节索引、会话文件名与 `world.json` outline 的引用,UI 层不碰。
- 左栏布局修正:左栏改为「切换控件固定 + 中间滚动区 + 底部固定」三段——此前整条 `.chapters` 自己滚,于是「收起」钮在工作区模式(内容短)悬在半空(距侧栏底 504px)、在章节多时又被内容顶出视野。现在切到哪种模式、内容多长,收起钮都贴底(实测三种情形均距底 14px)。
- 提示词:让 AI 真的去产出中间产物(此前提示词在阻止它):`prompts/writer-main.md` 原来写着「写在其他任何位置(临时文件、`notes/`、别处新建的 .md)用户在界面上都看不见,等于没写」——那是工作区面板出现之前的事实(界面只镜像当前章节草稿),却正好卡住工作区「资料与笔记」唯一的内容来源。现在改成区分交付物 / 中间产物:散文只有一个落点 `draft/<章节id>.md`(这条硬规则保留,它是 2026-08「正文写到 draft/第一章.md、前端读到空」的修复);资料、研究、场景备选、废弃片段落 `notes/**`,并新增「中间产物」小节写明何时该写、一个主题一个文件、来源必须标(自己的知识要标"未核实")、绝不编造出处、没有联网检索工具就不要假装查过。`prompts/director.md` 补一条「资料收集纪律」(开演前背景查证与用户给的材料的落点,并明确 `notes/` 不进正文、不进世界书)。常驻编剧(`writer-editor.md`)不承担资料收集,未改。
- 测试:`test/book-files.test.ts`(分组 / 展示名 / 生成物排除 / 机器数据排除 / 深度上限 / 路径校验 / 符号链接 / 截断)+ `test/workspace-panel.test.ts`(体积与相对时间格式化)+ `test/server.test.ts` 两组端点用例(清单、文本、图片、越界 400、机器数据与生成物 400、缺失 404、符号链接逃逸 404)。

### 外部命令与 shell 方言

- 外部命令开关:设置页「模式 → 外部命令」放开 agent 的 shell 工具(缺省关闭)。这是唯一一条把边界从「书目录」扩大到「整台机器」的开关——命令以服务进程权限运行,`installToolPathGuard` 管不到它;因此默认关、开关带风险确认(写明「可读写整台磁盘、访问网络,书目录路径限制无效」),状态存服务端 `~/.pi/writer/settings.json`(`enableShell`)。切换后 `WriterHost.setShell` 释放已建会话,下一次对话按新装配重建。
- 命令与输出实时可见:开着「简化输出」也强制显示——这是外部命令唯一的约束方式。前端按 `toolCallId` 归并同一条命令的流式增量(`tool_execution_update`),而不是收尾才一次性贴出。
- shell 方言(bash / PowerShell):新增 `shellKind`(`bash` 缺省 / `pwsh`)与 `shellPath`(显式可执行文件,空 = 自动探测)。vendor 的 shell 通道是 bash 专用的(Windows 只找 Git Bash,找不到直接抛错),方言支持复用它已有的 `shellPath` 设置——PowerShell 的 `-Command` 可缩写为 `-c`,于是 pwsh 借用同一 spawn 形态跑起来(`args: ["-c"]`,已实测)。解析顺序收敛在 `src/shell-kind.ts`:显式路径(按文件名判方言)> `%ProgramFiles%\PowerShell\7\pwsh.exe` > PATH `pwsh` > 回退系统自带 Windows PowerShell 5.1(带 warning)。
- 提示词按方言叙述:工具名在 vendor 里始终是 `bash`(schema 与描述都是 bash 口径),不说清方言模型会写 bash 语法必然报错。`buildWriterSystemPrompt(customTools, shell)` 按 `none/bash/pwsh/powershell` 注入对应文案:pwsh 下点明「实际由 PowerShell 7 执行」+ 原生路径与 `$env:NAME` + `exit $LASTEXITCODE`(`pwsh -Command` 会把原生程序退出码折算成 1,不加这行模型判成败会误判);编剧的固定角色提示词没有占位符,由 `WriterHost.editorSystemPrompt()` 追加同一行文案。选了 pwsh 但本机解析不到 → 方言为 `none`,不放开 shell 工具,提示词如实说「没有 shell」,而不是给一个必然报错的工具。
- 测试:`test/shell-kind.test.ts`(方言解析:平台 / 环境 / 存在性 / which 全部注入,覆盖标准目录、PATH、5.1 回退、显式路径、路径不存在);`test/prompt.test.ts` 覆盖四套方言文案;`test/writer-settings.test.ts` 新字段解析与 merge 语义;`test/server.test.ts` 新字段校验与解析回显;`test/writer-host.test.ts` `setShell` 释放语义与编剧提示注入。

## [0.0.5] - 2026-09-06

插件系统:plugins 目录装载 + 设置页管理 + 声明式设置菜单与斜杠命令 + 完全信任(trusted)。

- 插件装载:`~/.pi/writer/plugins/<id>`/(plugin.json + 入口 index.mjs,default export = 扩展工厂);清单字段级白名单校验,坏插件错误隔离不阻塞其他插件;启用双层(作者 `enabled:false` 强制禁用优先、用户运行时开关缺省启用),切换后重建会话即时生效
- 声明式扩展:设置项(插件在设置页左侧注册分类;字段类型 string/number/boolean/select/textarea,值存 `plugins/<id>/settings.json`)、斜杠命令(如 `/灵感`,主进程执行、结果回插输入框)
- 完全信任(trusted):插件级开关(`plugin-state.json`,缺省关闭);开启后入口可导出 `routes` 注册后端自定义路由(自动加 `/api/plugins/<id>` 前缀,仅 trusted 注册)并加载前端 JS(`frontend.mjs` 经 `GET /api/plugins/:id/frontend.mjs` 加载,仅 trusted 返回);开关带「与主进程/渲染进程同权」风险确认;未信任插件两者一律不可用
- LLM 工具:插件经工厂注册工具(如 dice 的 `roll_dice`、inspire 的 `inspire`),与 MCP 工具同通道注入 agent
- 示例插件:掷骰子 dice(工具 + `/快骰` + 设置菜单 + 信任后掷骰历史)、灵感笔 inspire(工具 + `/灵感` + 灵感库设置 + 信任后灵感面板)
- 文档与测试:`docs/plugin-development.md` 插件开发指南(声明式清单、web 命令、完全信任、安全模型);loader/server/slash-commands 用例扩充

## [0.0.4] - 2026-09-05

首次启动配置向导 + 模型供应商配置界面重构。

- 首次启动配置向导：新用户五步引导（功能介绍 → 模型服务 → 默认模型+思考级别 → 建第一本书 → 界面偏好）；完成标记存 ~/.pi/writer/setup.json，跨窗口/跨浏览器一致，换环境不重复弹；设置页可「重新运行配置向导」
- 模型供应商配置双栏卡片：左侧供应商列表（已配置置顶、搜索、状态点），右侧详情（Base URL、API 格式、API Key 掩码/更换、模型列表带上下文/视觉/思考徽章）
- 添加模型弹窗：模型 ID、上下文窗口、最大输出 Token、输入类型（文本/图片，视频/PDF 未支持、输出固定文本）；Base URL/API Key 从当前供应商自动带入；自定义供应商入口并入弹窗，设置页原「自定义模型」折叠卡移除
- 后端：新增 `GET /api/providers/:id`（供应商全量模型列表，不按认证过滤，未配置也能预览）；`POST /api/models/custom` 支持同 provider 合并模型数组（修复第二次添加覆盖丢失）、`input`/`name` 字段

## [0.0.3] - 2026-08-21

设置页与 UI 评审修复 + 模型目录联网刷新。

- 模型列表联网刷新：设置页新增“联网刷新”按钮，调用 `POST /api/models/refresh`；DeepSeek 接入真实 `GET /models`，可拉取在线模型，不再只依赖静态/远程缓存目录
- DeepSeek 模型补齐：新增 `deepseek-v4-flash-vision-exp`，刷新后模型列表与官方接口一致
- 模型 Key 状态修复：添加/移除/更改 API Key 后，ProviderList 等待父级模型刷新完成；当前模型失效且无回退时清空前端当前模型，服务端也只返回仍然可用的当前模型
- UI 评审修复：按钮窄容器文字竖排、设置页错误色使用主题 token、顶栏书名去重、移动端隐藏快捷键提示、保存状态去重、舞台空态隐藏内部工具名、中文标点统一、图标按钮 title/aria-label 补齐
- 编辑器：中文长段落软换行；activeLine 使用主题中性色
- 其他：世界书旧版空 notice 不再生成空待办项；内联 SVG favicon


## [0.0.2] - 2026-08-13

主题系统资产化:CSS 文件即主题,零注册自动发现。

- 主题 = 纯 CSS 文件:内置 `web/public/themes/*.css`、自定义 `~/.pi/writer/themes/*.css`,放入即出现在设置页(名字取首行注释,色板取 token),无需改源码
- 内置 6 套主题:纸上书房 / 羊皮灯下 / 黑白浅色 / 黑白深色(冷烟灰淡雅)/ 莫兰迪色系 / 莫兰迪深色;四套玻璃主题带亚克力毛玻璃(环境色团 + 面板 blur + 场景头/输入条亮档)
- 主题文件完全自包含(token + 全部结构规则),`styles.css` 只留 night 默认基底与通用规则
- 备忘录待办板、约束面板改版(可折叠 + 规则包导入)、提示词外置与自定义模型
- 前端水合 / 事件 / 数据拉取缺陷修复(编剧按章节过滤、切章串对话、确认卡串书、舞台快照代数守卫等)

### 0.0.2 修订(2026-08-13)

- A 档:编剧确认卡切章守卫(append 前校验 scope)、edit-capture 取数带 slug、死代码清理(5 个 client 死方法、DraftWorkspace 死句柄、workspace.ts 孤儿逻辑)、App 导航 toggle、新建主题 stale closure、exportBook 复用
- B 档:导演流式快照守卫(切页/重连不打断流式,幂等比对)、顶栏字数节流(保存状态即时)、MessageList memo(内容级比较器,toolCalls 逐字段)、世界书关系图懒挂载 + 类型过滤改 show()/hide() 增量切换、备忘录板 409 冲突提示、舞台 auto/thoughts 命令失败回滚
- C 档:删主会话只写状态死代码 + 查看模式缓存链(主会话消息无 UI 不再进入 reducer;保留 ensureServerSession/hydrateQueueRef 骨架)、跨窗口 session_changed 空闲跟随仅限同书 + 脏编辑不跟随(M18)
- 会话 entryId 修复:message_end 的 entryId 附加(vendor 先 emit 后 appendMessage,第一条消息无 entryId、后续错位一条——编辑/撤回定位错误的根因;session-host 补发带正确 entryId 的 message_end)

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
