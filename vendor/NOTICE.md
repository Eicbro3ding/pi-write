# Vendored code notice / 第三方代码声明

## 1. pi 核心包(`vendor/`)

`vendor/` 下的六个包 **vendored 自 pi**(monorepo:<https://github.com/earendil-works/pi>,项目站 <https://pi.dev>):

| 本地目录 | 上游包名 | 对应上游目录 |
|---|---|---|
| `vendor/pi-coding-agent/` | `@earendil-works/pi-coding-agent` | `packages/coding-agent` |
| `vendor/pi-agent-core/` | `@earendil-works/pi-agent-core` | `packages/agent` |
| `vendor/pi-ai/` | `@earendil-works/pi-ai` | `packages/ai` |
| `vendor/pi-tui/` | `@earendil-works/pi-tui` | `packages/tui` |
| `vendor/pi-client/` | `@earendil-works/pi-client` | (pi monorepo) |
| `vendor/pi-protocol/` | `@earendil-works/pi-protocol` | (pi monorepo) |

**版权与许可**:Copyright (c) 2025 Mario Zechner,许可证 **MIT** —— 全文见本目录的
[`LICENSE-pi.txt`](LICENSE-pi.txt)(从上游仓库根 `LICENSE` 原样拷入)。

**本副本相对上游有修改**:pi-writer 在自己的仓库里维护这份拷贝(为写作场景做过调整,例如
`initialActiveToolNames`、技能目录装配、shell 方言等)。MIT 允许修改与再分发,要求的是
保留上面的版权声明与许可全文 —— 因此这两份文件必须**随发行物一起分发**(见根目录
[`THIRD-PARTY.md`](../THIRD-PARTY.md) 的「发行物」一节)。

**基座与改动清单(2026-10-05,T8 清点)**:基线为上游 tag **`v0.83.0`**(`845d6ff`,经
全量历史 5171 条 commit 比对确认 —— 各包 `package.json` 所写的 `0.83.0` 属实)。改动分三类:

| 类 | 内容 | 规模 |
|---|---|---|
| A 路径重写 | `@earendil-works/*` → 相对路径 | `pi-coding-agent` 184 处、`pi-ai` 25、`pi-agent-core` 17 |
| B 语义改动 | 写作场景调整 | 约 1000+ 行,集中在 `pi-coding-agent` |
| C 自研新增 | `client/`、`pi-manifest.ts`、TUI 布局组件等 | 见下表 |

| 包 | 与 0.83.0 不同的文件 | 占全部 |
|---|---|---|
| `pi-coding-agent` | 107 / 183 | 59% |
| `pi-ai` | 21 / 169 | 13% |
| `pi-agent-core` | 13 / 37 | 36% |
| `pi-tui` | 7 / 37 | 19% |

**其中一处是安全边界,不可丢弃**:`pi-coding-agent/src/core/tools/path-utils.ts` 新增的
`setToolPathGuard` / `clearToolPathGuard`(上游 0.83.0 **没有**)。它限制文件类工具
(read/write/edit/grep/find/ls) 的路径不得逃出当前书的工作目录 —— 例如阻止 agent 读
`~/.pi/writer/agent/auth.json`。自研侧经 `src/pi-adapter/guard.ts` 收口。

**另注**:`pi-client` / `pi-protocol` 在上游 0.83.0 的 monorepo 里**不存在**(当时是独立
发布的 npm 包,1.0 才收进 monorepo),因此这两包**没有 0.83 基线可比对**。

逐条清单见仓库外的 `PI_WRITER_T8_DIFF.md`(三方对比:v0.83.0 / 本地 / 1.0.2)。

### Vendored pi core packages (English)

The six packages under `vendor/` are vendored from pi (<https://github.com/earendil-works/pi>).
Copyright (c) 2025 Mario Zechner. Licensed under the MIT License — full text in
[`LICENSE-pi.txt`](LICENSE-pi.txt), copied verbatim from the upstream repository's root `LICENSE`.

**This copy is modified** relative to upstream (pi-writer carries local changes for the writing
use case). Upstream updates are applied by hand. The MIT notice above must accompany every
distribution of this code.

**Baseline (2026-10-05, T8 audit)**: upstream tag **`v0.83.0`** (`845d6ff`), confirmed against
the full 5171-commit upstream history — the `0.83.0` in each `package.json` is accurate.
Local changes fall into three groups: (A) **import rewriting** — `@earendil-works/*` replaced
with relative paths (184 sites in `pi-coding-agent`, 25 in `pi-ai`, 17 in `pi-agent-core`);
(B) **semantic changes** for the writing use case (~1000+ lines, mostly in `pi-coding-agent`);
(C) **locally added files**. Files differing from 0.83.0: `pi-coding-agent` 107/183, `pi-ai`
21/169, `pi-agent-core` 13/37, `pi-tui` 7/37.

One of these is a **security boundary that must not be dropped**:
`setToolPathGuard` / `clearToolPathGuard`, added to `pi-coding-agent/src/core/tools/path-utils.ts`
(absent in upstream 0.83.0). It confines file tools (read/write/edit/grep/find/ls) to the current
book's working directory — e.g. it blocks the agent from reading
`~/.pi/writer/agent/auth.json`. Consumed by pi-writer via `src/pi-adapter/guard.ts`.

Note: `pi-client` / `pi-protocol` did **not exist** in the 0.83.0 monorepo (they were published
as standalone npm packages then, and only moved into the monorepo at 1.0), so they have **no
0.83 baseline** to diff against.

## 2. 技能库(`skills/`)

- `skills/craft/references/` 的 76 份方法论文档**逐字节**取自
  [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode)(MIT,
  Copyright (c) 2025-2026 oh-story-claudecode)—— 来源表、收录 commit、排除清单与许可全文见
  [`skills/craft/references/ATTRIBUTION.md`](../skills/craft/references/ATTRIBUTION.md)
  与同目录的 `LICENSE-oh-story-claudecode.txt`。
- `skills/onboarding/`、`skills/outline/`、`skills/critique/`、`skills/revise/`、
  `skills/stage-scripting/` 与 `skills/craft/SKILL.md` 为 pi-writer 自研(引用的工具与路径
  都是 pi-writer 自己的:`world_update` / `world_find` / `draft/` / `notes/` 等)。
- 上游 pi 的 `.pi/skills/` 只有三份开发文档(`add-llm-provider` / `interactive-testing` /
  `release`),**未被收录**到本仓库的 `skills/`。
