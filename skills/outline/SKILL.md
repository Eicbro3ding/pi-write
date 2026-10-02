---
name: outline
description: Use this skill when the user is starting a new book, restructuring the spine of an existing one, or asking \"help me plan/outline\". Covers outline form choices, chapter beats, and how to seed a fresh book workspace.
---

# Outline skill

Activates when the user wants to set up or rework the spine of a book.

## When to use

- The user says: "outline", "plan this book", "structure", "I have an idea for a novel", "help me organize chapters".
- The book has no outline entry yet; the workspace needs seeding.
- The user is stuck mid-draft and wants to re-architect before more writing.

## Steps

1. **Read what exists.** Use `world_find` to read the current outline entry (`type: "outline"`); glance at `draft/*.md` chapter titles with `ls`/`read`. Do not assume a blank slate. Note: `outline.md` and `.writer/*.md` are generated views of `world.json` — never write them directly, they get regenerated and your edits would be silently overwritten. The world book is only updated through the `world_update` tool.
2. **Ask two things at most, briefly:**
   - Form: novel / novella / linked-stories / serialized. Approximate target length.
   - Spine: 3-act, hero's journey, kishōtenketsu, sequence of episodes, or "I have no idea."
3. **Propose a chapter-level outline** as an `outline` entry via `world_update upsert_entry` (omit `id` and match the existing entry by `(type, title)` so it updates in place). Each chapter row has: index, working title, one-sentence promise, the turn it makes, and the open question it leaves. Keep it editable, not a manifesto.
4. **Offer the next step** — `~/.pi/writer` lets the user run `/new-chapter` to start chapter 1, or iterate the outline first.

## Outline entry body format

```markdown
# <Book title>

Premise: one line.

## Chapters

### 1. <working title>
Promise: ...
Turn: ...
Cliff/open: ...

### 2. ...
```

## 深度方法论（craft-outline 技能）

本技能只讲**怎么把大纲落进 `world.json`**；大纲与结构本身的技法在 `craft-outline` 技能里
（它的 `<location>` 见系统提示词的 `<available_skills>`，方法论文档在 `references/` 下）。
需要时 read **一份**，整份读，别 grep 摘读：

| 要做的事 | 读 |
|---|---|
| 搭大结构、选框架、等级循环与奖励节奏 | `references/plot-frameworks.md` |
| 大纲阶段方法、五步创建法、节点设计、八节点结构 | `references/outline-methods.md` |
| 主线矛盾、拉长剧情、设门槛、冲突设计 | `references/outline-conflict.md` |
| 升级感、情绪节奏、高潮设计与逆推 | `references/outline-rhythm.md` |
| 开篇（黄金一章、题材开头模板） | `references/opening-design.md` |
| 选题与卖点是否立得住 | `references/commercial-core-methods.md` |
| 结构层级、三幕五幕、因果链、换地图、多线写长 | `references/outline-structure-theory.md` |
| 小纲四步法、高潮构建、卡文对策 | `references/plot-core-methods.md` |
| 题材选型、核心梗与微创新 | `references/long-genre-catalog.md`、`references/long-genre-mechanics.md` |

当前用户请求、本书 `world.json` 里的写作约束、以及已有的大纲条目，**都优先于这些默认做法**。

## Do not

- Do not write prose during outlining. Stay at beat level.
- Do not propose more than ~12 chapters for a first pass unless the user named a target length that warrants it.
- Do not invent character names; use placeholders (`[protagonist]`, `[mentor]`) until the user supplies them, then add them as `character` entries via `world_update upsert_entry`.