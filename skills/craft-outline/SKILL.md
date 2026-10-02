---
name: craft-outline
description: "网文**选题与结构**方法论库（长篇为主）：题材选型与市场方向、核心梗三层递进与微创新、金手指设计、大结构框架与等级循环、大纲/卷纲/细纲方法、主线矛盾与冲突设计、设门槛拉长剧情、升级感与节奏、开篇黄金一章、反派系统与真相揭露、读者契约与阶段推进，外加 32 张题材正文卡。当用户要选题材、判断卖点能不能立住、定金手指、搭大纲/卷纲/细纲、设计主线矛盾、写开篇、做题材定位时使用。本技能只给方法，**不含落盘流程**（把大纲写进世界书看 `outline` 技能）。做法是按下面的路由表 read 至多两份文件，不要整库读。"
---

# 网文选题与结构（craft-outline）

方法论文库 + 路由，不含流程指令。需要「怎么把大纲落进世界书」→ 用 `outline` 技能；
需要写正文的技法 → `craft-prose`；去 AI 味 → `craft-deslop`；审稿标准 → `craft-review`。

## 怎么用

1. 按下面的路由表定位**至多两份**文件（多读一份 ≈ 多花几千 token，也容易互相打架）。
2. `read` **整份**。这些文件开头都有「决策路由」表，按它再跳到对应小节；
   `grep` 摘几句会漏掉判据和反例，等于没读。
3. **方法是参考，不是覆盖**：当前用户请求 > `world.json` 里的写作约束与文风 > 已有大纲条目 >
   本库默认值。本库给的是同类作品的通行做法，不是你这本书的事实。

## 路由表

### 选题、卖点与金手指

| 你在做什么 | 读 |
|---|---|
| 定选题/卖点、判断题材能不能做、金手指的总原则、商业模块 | `commercial-core-methods.md` |
| 金手指进阶（错位/反套路/极道流）、脑洞文怎么铺成完整故事 | `plot-special-topics.md` |
| 核心梗三层递进、微创新五法、冲突网络、事业线/爱情线 | `long-genre-mechanics.md` |
| 题材选型、对照整卷/全书的功能分配 | `long-genre-catalog.md` |

### 结构与大框架

| 你在做什么 | 读 |
|---|---|
| 搭全书大结构、选框架、等级循环与奖励节奏、打脸装逼的节奏 | `plot-frameworks.md` |
| 结构层级（一级/二级/三级）、三幕五幕、因果链、换地图、多线写长 | `outline-structure-theory.md` |
| 大纲的阶段方法、五步创建法、节点设计、八节点结构 | `outline-methods.md` |
| 主线矛盾、拉长剧情、设门槛、冲突设计、救赎文八法 | `outline-conflict.md` |
| 升级感、情绪节奏、高潮设计与逆推 | `outline-rhythm.md` |
| 小纲四步法、高潮构建、卡文对策、剧情过渡衔接 | `plot-core-methods.md` |
| 爽点体系、情绪模块与戏剧单元、递进对抗、节奏崩盘 | `plot-emotion-system.md` |
| 反派系统、真相揭露方式、报应设计 | `villain-and-reveal.md` |
| 读者契约四问、主角代理权、利益安全与阶段推进 | `reader-contract-and-progression.md` |

### 开篇

| 你在做什么 | 读 |
|---|---|
| **黄金一章**检查清单、题材开头模板、书名/简介/开篇三位一体 | `opening-design.md` |

### 题材与题材卡

| 你在做什么 | 读 |
|---|---|
| 跨题材通用写作技法 | `genre-writing-techniques.md` |
| 题材公式与结构套路 | `genre-writing-formulas.md` |
| 读者画像与平台口味 | `genre-readers.md` |
| 锁定具体题材后的**正文声线与提示词卡** | 先看索引 `genre-prose-cards.md`，再读 `cards/` 下对应的那一张 |

题材正文卡（32 张，按题材名取用）：

`cards/传统玄幻.md` `cards/东方仙侠.md` `cards/都市高武.md` `cards/都市脑洞.md`
`cards/都市日常.md` `cards/都市修真.md` `cards/都市种田.md` `cards/宫斗宅斗.md`
`cards/古风世情.md` `cards/古言脑洞.md` `cards/豪门总裁.md` `cards/抗战谍战.md`
`cards/科幻末世.md` `cards/快穿.md` `cards/历史古代.md` `cards/历史脑洞.md`
`cards/民国言情.md` `cards/年代.md` `cards/女频悬疑.md` `cards/女频种田.md`
`cards/青春甜宠.md` `cards/双男主.md` `cards/西方奇幻.md` `cards/现言脑洞.md`
`cards/星光璀璨.md` `cards/悬疑灵异.md` `cards/悬疑脑洞.md` `cards/玄幻脑洞.md`
`cards/玄幻言情.md` `cards/游戏体育.md` `cards/战神赘婿.md` `cards/职场婚恋.md`

## 与 world.json 的关系

上游把这套方法配的是「文件树当记忆」——`设定/角色/X.md`、`大纲/细纲_第N章.md`、`追踪/`。
**pi-write 不是那个形态**，别照着这些路径写文件：人物、世界观、关系、时间线、大纲条目一律经
`world_update` 落进 `world.json`；`outline.md` 这类是它的派生视图，直写会被覆盖。
文档里出现的那些路径只当**内容组织思路**看。

## 本库不做什么

- **不含流程**：上游的 hook 门禁、专业 agent、`/story-setup` 部署、追踪提交协议都没有收进来。
  正文里提到「跑 `scripts/xxx.py`」「读 `workflow-*.md`」的，忽略即可——那几处残留引用逐个登记在
  `references/ATTRIBUTION.md`（连同 MIT 许可证全文 `references/LICENSE-oh-story-claudecode.txt`），
  **不要去找那些不存在的文件**。
- **短篇方法**不适用（本库按长篇收的）。
- 本库只提供方法：开书落盘看 `outline` 技能，评析看 `critique`，改稿看 `revise`。
