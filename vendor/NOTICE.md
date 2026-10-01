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
`initialActiveToolNames`、技能目录装配、shell 方言等),**没有逐条标注 diff**,也不保证与
上游任意 commit 一致;升级上游时是手工比对而非脚本同步。MIT 允许修改与再分发,要求的是
保留上面的版权声明与许可全文 —— 因此这两份文件必须**随发行物一起分发**(见根目录
[`THIRD-PARTY.md`](../THIRD-PARTY.md) 的「发行物」一节)。

### Vendored pi core packages (English)

The six packages under `vendor/` are vendored from pi (<https://github.com/earendil-works/pi>).
Copyright (c) 2025 Mario Zechner. Licensed under the MIT License — full text in
[`LICENSE-pi.txt`](LICENSE-pi.txt), copied verbatim from the upstream repository's root `LICENSE`.

**This copy is modified** relative to upstream (pi-writer carries local changes for the writing
use case). Modifications are not individually annotated and this tree is not guaranteed to match
any upstream commit; upstream updates are applied by hand. The MIT notice above must accompany
every distribution of this code.

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
