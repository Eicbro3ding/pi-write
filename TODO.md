# 待办清单

> 这份文件是本仓库**唯一的待办真相源**。此前所有「P0/P1/P2」编号都是对话里即兴排的,
> 没有落到文件上 —— 结果是同一类问题会被重复发现、优先级会被临时起意地拔高
> (2026-10-05 就有一次:「删条目要硬拦」被当成 P0-b 推给用户,一句「为什么要拦截删除」
> 就推翻了)。**本文件的规矩:每一条都要写清来源、判断依据、以及是否需用户拍板。**

## 用法

- 做完一条 → 移到 `## 已完成` 并注明提交号,不删(留痕)。
- 新发现的 → 追加到对应分区,标明**怎么发现的**(源码审计 / 实机事故 / 用户反馈)。
- 优先级只写「高 / 中 / 低」+ 一句为什么,不再用 P0/P1 这类看起来像工程计划的编号。

## 待办

### 高

- [ ] **记忆锚与压缩补偿仍只挂在 TUI 路径** —— **需用户拍板**
  - 来源:2026-10-05 护栏统一注入时发现(本轮**有意未搬**,见 CHANGELOG 已知边界)。
  - 现状:`before_agent_start` 记忆锚(memory/Notice/发展线注入 systemPrompt)与
    `session_before_compact`(压缩前保用户原话)都注册在 `writerExtension` 里,
    而 web 编剧会话不装配它 —— 与刚修的工具护栏是**同一个坑**。
  - 未搬的理由:它们会**改变 web 会话的 prompt 内容**,影响面比工具护栏大得多
    (护栏只在下手时拦,锚是每轮都在 systemPrompt 里)。
  - 需拍板:要不要搬?搬的话是否先只搬压缩补偿(它只在压缩时触发、更局部)?

### 中

- [ ] **采样单源护栏的白名单掩盖了真实注入点**(`test/world-context.test.ts`)
  - 来源:2026-10-05 源码审计。
  - 现状:护栏断言「【文风采样】」只出现在 `src/tools.ts` 与 `src/stage/orchestrator.ts`,
    但 orchestrator 里实际有**两处独立注入**(给编剧 / 给导演),白名单把两处压成一个
    文件条目 —— 新增第三处注入不会破坏断言。
  - 修法:白名单细化到「文件 + 函数名」或改用行号锚点。

### 低

- [ ] **`writer-host.ts:753` 的过期 JSDoc**(`src/web/writer-host.ts`)
  - 来源:2026-10-05 采样收口后**我漏改的一处**。
  - 现状:753 行注释仍写「稳定块(世界观概述/世界书条目/**文风采样**/写作约束)」,
    而采样早已移出稳定块 —— 同文件 :677 / :803 / :824 三处都已更正,**同文件内前后矛盾**。
  - 修法:删掉该行注释里的「文风采样/」,与 :824 的口径对齐。
  - 注:为一行注释单开提交不划算,可搭下一次触碰 `writer-host.ts` 的改动顺带修。

- [ ] **`@modelcontextprotocol/sdk` 成孤儿依赖**(T9-A 副作用)
  - 来源:2026-10-05 文档/skill 同步时发现。
  - 现状:自研 MCP 删除后 `src/` 内**已无 SDK 引用**(全仓只剩 `McpServerList.tsx` 一处
    占位符文案 `-y,@modelcontextprotocol/server-everything`)。传输、OAuth、资源列表
    全由上游 pi 扩展负责。
  - 处置:确认无引用后从 `package.json` 移除(顺带减依赖体积 —— 自包含产物会跟着瘦);
    移除前先 `grep -rn "modelcontextprotocol" src/ test/ web/src/` 复核。
  - 注:别为 MCP 把它用回来 —— 那等于回退到 T9-A 之前(自研 843 行重造上游已有的东西)。

- [ ] **MCP 上游化后还有三处未收口**(T9-A 遗留)
  - 来源:2026-10-05 T9-A 实施时有意留下(避免一次改太多、便于回滚)。
  - ① **`src/mcp/migrate.ts` 的备份不会清理**:每次迁移写一份 `.bak-<ts>`,迁移只在
    配置还是旧形状时触发,所以正常只写一次;但若用户手工把配置改回旧形状再启动,
    会再写一份,长期堆积。
  - ② **`sse` 降级只告警一次**:降级发生在迁移时,用户改回 `sse` 会在保存时被 400 挡住
    (不会静默),但**已存在的 sse 条目**若在迁移后又被外部工具写入 `mcp.json`,
    不会二次校验 —— 上游读到时行为未知(大概率报错)。
  - ③ **`exposure` 默认值的双写**:迁移写 `direct`,而前端新建服务器默认也是 `direct`
    (`McpServerList.tsx`)。两个默认值分散在两处,将来改一处会不一致。

## 明确不做(附理由,避免被重新提出)

- **T14–T19(阶段 4「用上 1.0 能力」)暂缓** —— 2026-10-06 用户决定:没有必要。
  - **它们依赖的东西真实存在**:`defineDoc` / `TaskGraph` / `TaskGraphWatch` /
    `rewindable` / `StorageRejected` / `ReadAfterWrite` 全在 **`@earendil-works/pi-durable`**
    (独立包,1.0.3,**2026-10-05 发布**)。任务文档 `PI_WRITER_IMPLEMENTATION.md` 第
    1234–1303 行(T14–T19)定义完整,"上游对应"栏**准确**。
    - 注意:这个包**不在本仓库依赖里**,`grep node_modules/` 是搜不到的 —— 曾据此误判
      "API 不存在"(搜不到 ≠ 不存在)。核对上游 API 必须查 `npm view` / `npm pack`,
      不能只扫已安装目录。
  - **不做的理由不是"没有",而是"不划算"**:
    - README 首行写明 **Experimental,API 在版本间无通知变化**;发布距今一天。
    - 它不是"加个依赖",而是 **durable agent harness** —— 会接管 conversations /
      model turns / tool calls 的整个存储层。
    - T14 的收益文档写的是"删掉 106 行手写并发控制"(`world-lock.ts` 20 +
      `atomic-write.ts` 42 + `write-queue.ts` 44)。**用整个会话运行时换 106 行,且换来的
      是实验品** —— 收益远低于成本与风险。
  - 若将来要重估,触发条件应是:pi-durable 从 Experimental 毕业(API 稳定)、或世界书
    并发控制真的出了事故。届时可按 T14 原方案重开。

- **条目删除不加硬拦**。它与「空内容 `write`」不是一类:模型删条目时**意图明确**
  (用户说「删掉那个临时角色」),结果**当场可见**(前端有 `last-world-edit.json` 的
  diff 预览卡)。加确认门槛成本高、收益低,还会挡住正常操作。
  —— 2026-10-05 由用户「为什么要拦截删除」一问纠正,原先被错误地列为 P0-b。

- **undo / 历史不做(未评估)**。删除侧真正的空白是没有 undo(只能从 `.bak` 手动恢复,
  而下一次保存会覆盖它)。这是另一个量级的工程,需要时单独评估。

## 已完成

- [x] **`delete_relation` 静默无操作** —— 本轮
      (`next.relations.filter(...)` 传错 id 不报错;补 `find` + 抛 `WorldValidationError
      ("关系不存在: …(未删除任何内容)")`,与 `delete_constraint`/`notice_delete` 口径一致。
      测试补齐:`test/tools.test.ts` 的「删除类 op 不静默无操作」组新增 1 例,该组注释原写
      「三个 op 本轮补齐」而实际只补了两个 —— 这是漏网的第三个。已反证:退回旧实现 → 测试红)
- [x] 工具清单护栏补洞:子串匹配改**清单内定位** —— `2f1ef05`
      (原 `expect(main).toContain(name)` 在整份提示词上子串匹配,`read` 是 `read_chapter`/
       `read_style` 的前缀、`write` 在散文里随处可见;改为只认清单条目形状:行首 `- ` +
       反引号包裹的工具名)
- [x] 反向护栏补 `writer-editor.md` —— `3631674`
      (原「提示词点名了却未装配」的反向断言只看 `writer-main.md`,现在两侧都查)
- [x] **`npm run build` 不产 `dist/cli.js`(`bin` 指向它)** —— `10e5d63`
  - 来源:2026-10-05 源码审计。原 `build` 为 `tsgo -p tsconfig.build.json && shx chmod +x
    dist/cli.js`,但 `rootDir:"."` + `outDir:"dist"` 实际产出 `dist/src/cli.js`,
    `dist/cli.js` 根本不存在 —— `npm run build` / `prepublishOnly` 必失败。
  - 已修:改为 `tsc -p tsconfig.build.json --emitDeclarationOnly --sourceMap false &&
    node scripts/build-cli.mjs`(esbuild 单独打一个自包含 `dist/cli.js`,699KB 可执行,与
    `bin.pi-writer` 一致);另有 `10e5d63` 同批修「npm 包的 CLI 真的能跑」。
  - 注:TUI 已冻结(2026-10-05 用户决定,冻结不删),但发版路径依赖这条,已随之解除。

- [x] **`npm run build` 不产 `dist/web/server.cjs`,但 `npm run web` 依赖它** —— `3594590`
  - 来源:2026-10-05 T13 端到端排查(误跑过期产物一度误判「迁移没生效」)。
  - **已修**:新增 `scripts/check-web-fresh.mjs`(比源码与产物 mtime,过期打醒目警告 +
    给出正确命令,`exit 0` 不阻断启动),挂在 `web` 脚本前置:
    `"web": "node scripts/check-web-fresh.mjs && node dist/web/server.cjs"`。
  - **护栏**:`test/build-scripts.test.ts` 三例钉住(web 脚本必须含自检且顺序在先 /
    自检脚本存在 / `build` 与 `build:web` 是两个产物这个事实本身)。已反证:
    把 web 脚本改回旧形态 → 测试红。
  - 未做的取舍:**没让 `build` 顺带产 `server.cjs`** —— 那会把 esbuild 全量打包
    塞进每次 build(含前端 vite),启动路径变慢;警告方案代价低且足够。

- [x] MCP 从自研切换为上游扩展(决策 D1 改判 B)—— `305038e`
      (删 manager/tools/config 共 843 行,新增 extension/migrate/host 三处胶水;
      配置自动迁移 + `.bak` 备份;SSE 降级为 http;`exposure` 默认 `direct`)
- [x] 文风采样收口成单源(新增 `read_style`,采样退出全部常驻块)—— `af27ef7`
- [x] 护栏统一注入(修「护栏只挂在 TUI,真正出事的会话全都没有」)—— `cb84125`
- [x] 世界书写入补两处静默(`delete_constraint` / `notice_delete` 存在性校验、
      `update_style_sample` 拒空、`emptiedEntryBodies` 提示)—— `bf0d215`
