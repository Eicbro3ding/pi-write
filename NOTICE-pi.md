# pi 核心包声明 / Notice for the pi core packages

> 本文取代原 `vendor/NOTICE.md`。**2026-10-05（T11 / 决策 D2）起 pi 不再是仓库内的
> vendored 源码，而是 npm 依赖**；本文保留下来只做两件事：**版权与许可声明**（MIT 的
> 唯一义务）、**本地修改声明**（让升级的人知道我们改了什么）。

## 1. 版权与许可

pi-writer 依赖 pi 的六个 npm 包：

| npm 包名 | 上游 monorepo 目录 | 锁定版本 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | 1.0.2 |
| `@earendil-works/pi-agent-core` | `packages/agent` | 1.0.2 |
| `@earendil-works/pi-ai` | `packages/ai` | 1.0.2 |
| `@earendil-works/pi-tui` | `packages/tui` | 1.0.2 |
| `@earendil-works/pi-client` | （1.0 起收进 monorepo） | 1.0.2 |
| `@earendil-works/pi-protocol` | （1.0 起收进 monorepo） | 1.0.2 |

上游仓库：<https://github.com/earendil-works/pi>（项目站 <https://pi.dev>）
**Copyright (c) 2025 Mario Zechner，许可证 MIT** —— 许可全文见 [`LICENSE-pi.txt`](LICENSE-pi.txt)
（原样取自上游仓库根的 `LICENSE`）。

## 2. 为什么从 vendor 改成 npm 依赖

vendor 版并不是「上游的一份干净拷贝」。2026-10-05 的 T8 清点与 5171 条上游 commit 比对
确认：基线是上游 tag **v0.83.0**，而 `pi-coding-agent` 有 **107 / 183 个文件（59%）**与
基线不同，其中「B 类语义改动」约 **1000+ 行**。

这意味着 vendor 实质上是一条**自己维护的分支**：上游一升级就要手工重放上千行改动，
而「哪些是自研改的、哪些是上游本来就有的」在 diff 里已经分不清了（T8 期间就把
`temperature` 误判成自研新增，实际是上游 11 个 provider 共用的标准参数）。改成 npm 依赖
后，上游改动由 `npm install` 吸收，我们只需要维护**自己真正需要的那一小部分**。

## 3. 我们仍然保留的本地修改

本地改动不再写进包源码，而是放在 [`patches/`](patches/) 目录，由
[`scripts/apply-patches.mjs`](scripts/apply-patches.mjs) 在 `postinstall` 阶段施加。
**脚本是幂等的**（重复执行不会重复打），且刻意**不把 `package.json` 写进补丁** ——
它会被 `npm install` 重写，固化进 diff 必然失配。

| 补丁 | 作用 | 为什么不能没有 |
|---|---|---|
| `pi-coding-agent-pathguard.patch` | 给 `core/tools/path-utils` 注入 `setToolPathGuard` / `clearToolPathGuard`，并让 `write` / `edit` / `edit-diff` 三处调用方传入 `"write"` 模式 | **安全边界**。限制文件类工具（read/write/edit/grep/find/ls）的路径不得逃出当前书的工作目录 —— 例如阻止 agent 读 `~/.pi/writer/agent/auth.json`。上游 1.0.2 **没有**这个能力，自研侧经 `src/pi-adapter/guard.ts` 收口 |
| （脚本注入，非补丁） | 给包的 `exports` 增加 `./core/tools/path-utils` 与 `./core/usage-totals` 两个子路径 | 上游 1.0.2 的发布包没导出这两条深层路径，但 `pi-adapter/guard.ts` 与 `usage.ts` 需要它们。用脚本注入而不是写进补丁，是为了与版本解耦 |
| `src/providers/deepseek-dynamic.ts` | DeepSeek **动态发现**模型的推理档位推断 | 修 BUG-003（新推理模型选不到思考档位），**影响核心故保留**。上游 1.0.2 只有静态的 `deepseekProvider()`。将来要在线拉取模型列表，正路是上游的 `fetchModels` 扩展点，不是继续改包 |

## 4. 已被判定「不重放」的自研能力

按「**不影响 web 与整体核心功能的自研一律移除**」的口径，以下 vendor 时代的自研能力
**没有**迁到 1.0.2：

| 能力 | 影响面 | 处置 |
|---|---|---|
| TUI 的 `sidePanel` 挂件方位 | 仅终端界面；web 侧本来就有自己的三栏布局（`WritePage` / `DraftWorkspace`） | 改为上游的 `aboveEditor` —— 草稿面板纵向排布在编辑器上方 |
| `InteractiveModeOptions.uiMode` | 上游 1.0.2 改名为 `tuiMode`（取值不变） | 跟随上游改名 |

## 5. 上游升级时要看的地方

1. **先跑 `npm run typecheck`** —— 依赖化后 `skipLibCheck: true` 是必需品（`pi-ai` 在
   NodeNext 下有约 30 个 TS1543），若有人把它关掉会看到一片噪音。
2. **补丁失配**表现为 `postinstall` 报 `Hunk #1 FAILED` —— 多半是版本号漂移
   （`package.json` 里四个包都锁的是精确版本 `1.0.2`，不要改回 `^`）。
3. **路径守卫失效**是唯一会**静默**失败的东西：补丁只改 `path-utils.js` 而不改
   `write.js` / `edit.js` / `edit-diff.js` 的三处调用方，守卫装上了却没人传 `mode`，
   越权写入一次都不会被拦 —— 编译不报错、运行不报错，只有 `test/tool-guard.test.ts`
   能发现。详见 [`patches/README.md`](patches/README.md)。
4. 测试里但凡要 import pi，**必须 import 包名**（`@earendil-works/pi-coding-agent`），
   不能 import 任何 vendored 源码 —— 两者是独立的模块实例，守卫会装到另一份上。

---

## Vendored pi core packages (English, historical)

Before 2026-10-05 the six packages above were vendored under `vendor/` (baseline: upstream
tag `v0.83.0`, commit `845d6ff`); 107/183 files of `pi-coding-agent` differed from that
baseline (~1000+ lines of local semantic changes). They are now consumed as npm
dependencies, with local changes applied as patches (see §3). Copyright (c) 2025 Mario
Zechner, MIT licensed — full text in [`LICENSE-pi.txt`](LICENSE-pi.txt), which must
accompany every distribution (see [`THIRD-PARTY.md`](THIRD-PARTY.md)).
