# 来源与许可：oh-story-claudecode 创作方法论文库

本目录下的方法论文档**逐字节原样**取自开源项目 oh-story-claudecode，未做改写、
未做删节、未做术语替换。面向 pi-write 的适配（怎么选、什么时候读）全部写在上一级
的 `SKILL.md` 里，不散落在这些文件内部——这是「与上游保持一致、可机械升级」的前提。

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/zenstory-ai/oh-story-claudecode> |
| 收录 commit | `dab9e18d8f59ae6c8761a3b63aa71fd4b34d92e6` |
| 许可证 | MIT，全文见 [LICENSE-oh-story-claudecode.txt](LICENSE-oh-story-claudecode.txt) |
| Copyright | Copyright (c) 2025-2026 oh-story-claudecode |
| 收录日期 | 2026-10-01 |
| 收录规模 | 76 份 / 约 884KB |

## 收的是什么

**纯创作方法**：写作技法、情绪与爽点设计、章级钩子、反转、悬念、对话、人物设计、
人物关系与感情线、结构与大纲、开篇、去 AI 味、文风裁决、题材框架与题材正文卡、
审稿 rubric。

反面判据（据此排除）：一份文档如果必须靠上游的宿主机制才能执行，那它是**流程**不是
**方法**。出现下列任一痕迹的一律不收：`拆文库/`、`追踪/_tracking-state.json`、
`tracking_commit.py`、`storyctl.py`、`Stage N`、`.story/`、`{PYTHON}`、`workflow-*.md`、
`target_cli`、`.claude/`。按这条判据剔掉的具体文件已在下文登记。

## 刻意排除

| 排除项 | 理由 |
|---|---|
| 8 个自动化 hook、7 个 agent 定义、`/story-setup` 部署器 | pi-write 的 vendor 无 hook 与自定义 subagent 机制；上游部署物（`.claude/agents`、`.codex/hooks`、`.active-book`）pi-write 一概不读，收进来只会误导模型 |
| `workflow-*.md`、`artifact-protocols.md`、`tracking-*.md` | 上游的项目结构与状态机协议，与 pi-write 的 `world.json` 单一真相源冲突（详见 `SKILL.md`「与 world.json 的关系」） |
| 拆文 / 扫榜 / 导入流程（`stage*`、`analysis-*`、`import-*`、`deconstruction-*`、`structure-mapping-*`、`style-profile-protocol`、`quality-checklist`） | 流程编排与拆书产物迁移，pi-write 未引入对应能力 |
| 短篇专用（`short-*`） | pi-write 面向长篇；短篇方法另有平台差异，不混进来 |
| 宿主适配（`deploy-*`、`solo.md`、各 CLI 适配说明） | 只对上游支持的那 8 款编程 Agent 有意义 |
| 同名副本 | 上游同一文件在多个 skill 下重复存放（342 份 references 里只有 252 份唯一，重复占用约 850KB）；本目录每个文件只保留一份 |

## 已知残留：5 个指向未收录文件的交叉引用

这些文档正文里偶有「见 `workflow-volume.md`」这类旁注，目标文件属于上文排除的流程类，
本仓库没有：

- `workflow-volume.md` ← `structure/outline-structure-theory.md`、`structure/plot-frameworks.md`
- `workflow-outline.md` ← `structure/outline-structure-theory.md`
- `writing-workflow.md` ← `structure/villain-and-reveal.md`
- `short-reversal.md` ← `genre/genre-writing-techniques.md`
- `short-genre-formulas.md` ← `genre/genre-readers.md`（该文件是短篇题材公式，与已收录的
  `genre/genre-writing-formulas.md` 内容一致，故不重复收录）

**读到就直接忽略，不要去找这些文件**（找也找不到，只会浪费工具调用）。要彻底消掉就得
改写上游原文，那会让「逐字节一致、可机械升级」这条性质失效——不值当。

## 上游更新怎么同步

```bash
# 1. 取新版（tarball 比 git clone 稳，clone 在本机曾卡住）
curl -L -o /tmp/oh.tar.gz \
  https://codeload.github.com/zenstory-ai/oh-story-claudecode/tar.gz/refs/heads/main
mkdir -p /tmp/oh && tar xzf /tmp/oh.tar.gz -C /tmp/oh --strip-components=1

# 2. 先读 /tmp/oh/CHANGELOG.md，再按本文「收的是什么」的判据重挑
# 3. 覆盖 skills/craft/references/ 下的同名文件（分类目录保持不变）
# 4. 更新本文的收录 commit 与日期
# 5. npx vitest run --config vitest.tmp.config.ts test/skill-references.test.ts
```

`test/skill-references.test.ts` 会守住两件事：`SKILL.md` 索引的文件都在磁盘上、
磁盘上的文件都被索引到。第 3 步漏改路由表，或第 2 步挑进来一份新文件却忘了登记，
这条测试都会红。
