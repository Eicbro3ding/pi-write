---
name: craft
description: "网文创作方法论文库（长篇为主）：选题卖点、金手指、大纲与卷纲节奏、开篇黄金一章、人物设计与关系感情线、情绪与爽点、章级钩子、反转与悬念、对话、场景、去 AI 味与文风裁决、题材框架与题材正文卡、审稿 rubric。当用户要开书、定选题、搭大纲、写正文、卡文，或抱怨人物立不住/情绪不到位/钩子不抓人/对话发平/太 AI 味，或要按番茄·起点·晋江·知乎盐言的标准审稿时使用。做法是按下面的路由表 read 至多两份 references 文件，不要整库读。"
---

# 网文创作方法（craft）

这是一个**知识库 + 路由**，不含流程指令。它不规定你先做什么、后做什么——
工作流按 pi-write 既有的走（开书/写章/审稿/改稿），需要方法时来这里查。

## 怎么用

1. 按下面的路由表定位**至多两份**文件（多读一份 ≈ 多花几千 token 的上下文，且容易互相打架）。
2. `read` **整份**。这些文件开头都有「决策路由」表，按它再跳到对应小节；
   `grep` 摘几句会漏掉判据和反例，等于没读。
3. **方法是参考，不是覆盖**：当前用户请求 > `world.json` 里的写作约束与文风 > 本章细纲/大纲 >
   本库默认值。本库给的是同类作品的通行做法，不是你这本书的事实。

## 路由表

路径都相对本技能的 `references/`。

### 一、选题、结构与大纲

| 你在做什么 | 读 |
|---|---|
| 定选题/卖点、判断题材能不能做、设计金手指的总原则 | `structure/commercial-core-methods.md` |
| 搭全书大结构、选框架、设计等级循环与奖励节奏、打脸装逼的节奏 | `structure/plot-frameworks.md` |
| 建小纲/细纲、设计高潮、卡文了怎么破、剧情过渡衔接 | `structure/plot-core-methods.md` |
| 设计主线矛盾、拉长剧情、设门槛、冲突设计 | `structure/outline-conflict.md` |
| 大纲的阶段方法、五步创建法、节点设计、八节点结构 | `structure/outline-methods.md` |
| 结构层级（一级/二级/三级）、三幕五幕、因果链、换地图、多线写长 | `structure/outline-structure-theory.md` |
| 升级感、情绪节奏、高潮分类与反推 | `structure/outline-rhythm.md` |
| 爽点体系、情绪模块与戏剧单元、递进对抗、节奏崩盘 | `structure/plot-emotion-system.md` |
| 特殊题材：金手指进阶（错位/反套路/极道流）、脑洞文怎么铺成完整故事 | `structure/plot-special-topics.md` |
| 反派系统、真相揭露方式、报应设计 | `structure/villain-and-reveal.md` |
| 读者契约四问、主角代理权、阶段推进 | `structure/reader-contract-and-progression.md` |
| **开篇**：黄金一章检查清单、题材开头模板、书名简介开篇三位一体 | `structure/opening-design.md` |

### 二、人物

| 你在做什么 | 读 |
|---|---|
| 写主角卡/配角卡、人物基础档案的必填字段 | `character/character-basics.md` |
| 三层标签反差人设、配角功能化、群像、记忆点、金手指绑人设 | `character/character-design-methods.md` |
| 人物关系类型、感情线人设核心、关系分层 | `character/character-relations.md` |
| 女频：核心原则、安全感/代入感、文案结构、主动性 | `character/female-audience-writing.md` |

### 三、正文执行（写一章时）

| 你在做什么 | 读 |
|---|---|
| **正文总纲**：情绪落地、贯穿道具、场景写法、密度诊断、镜头准入 | `prose/writing-craft.md` |
| 情绪落到纸面：前反应-复现-后反应、以小搏大、统一视角 | `prose/emotion-on-page.md` |
| 情感设计三板斧、拉扯节奏、失败模式 | `prose/emotional-methods.md`（长篇单元级看 `prose/long-emotional-methods.md`） |
| 情绪弧线选型（V 形、倒 V 形、波浪形与各自的谷底/高点位置） | `prose/emotional-arc-design.md` |
| 章首/章尾钩子选型、跨章期待、断章位置 | `prose/long-chapter-hooks.md` |
| 反转类型、嵌套反转、反转时机、误导技巧、打脸的深层节奏 | `prose/long-reversal.md` |
| 悬念体系、强度分级、单章信息顺序模板 | `prose/long-suspense.md` |
| 对话：权力博弈、潜台词、人物语言差异化、篇幅控制 | `prose/dialogue-mastery.md` |
| 一场戏的信息怎么揉进连续正文、疏密怎么分 | `prose/scene-craft.md` |
| 正文格式（段落、分行、标点、章节体例） | `prose/long-format.md`、`prose/format-and-structure.md` |
| 写完一章自查 | `prose/long-chapter-quality.md` |

### 四、去 AI 味与文风

| 你在做什么 | 读 |
|---|---|
| **去 AI 味主文件**：AI 写作指纹、10 种模式检测、改写顺序、范例库 | `deslop/anti-ai-writing.md` |
| Gate 执行细则（判定与放行标准） | `deslop/deslop-gates.md` |
| 禁用词与句式速查表（改写时对照） | `deslop/banned-words.md` |
| 文笔：镜头式写作、白描、视角、毒点规避、开篇定调 | `deslop/style-craft.md` |
| 装逼打脸与爽点释放（写这类场景时） | `deslop/style-combat-face.md` |
| 按题材取风格模块 | `deslop/style-genre-modules.md` |
| **文风裁决**：当前请求、本书文风、作者偏好冲突时按什么顺序取值 | `deslop/style-resolution.md` |

### 五、题材

| 你在做什么 | 读 |
|---|---|
| 选题材、对照整卷/全书的功能分配 | `genre/long-genre-catalog.md` |
| 核心梗三层递进、微创新五法、金手指匹配、事业线/爱情线 | `genre/long-genre-mechanics.md` |
| 跨题材通用写作技法 | `genre/genre-writing-techniques.md` |
| 题材公式与结构套路 | `genre/genre-writing-formulas.md` |
| 读者画像与平台口味 | `genre/genre-readers.md` |
| 锁定具体题材后的**正文声线与提示词卡** | 先看索引 `genre/genre-prose-cards.md`，再读下面对应的那一张 |

题材正文卡（32 张，按题材名取用；它们的用法与召回规范见索引文件）：

`genre/cards/传统玄幻.md` `genre/cards/东方仙侠.md` `genre/cards/都市高武.md` `genre/cards/都市脑洞.md`
`genre/cards/都市日常.md` `genre/cards/都市修真.md` `genre/cards/都市种田.md` `genre/cards/宫斗宅斗.md`
`genre/cards/古风世情.md` `genre/cards/古言脑洞.md` `genre/cards/豪门总裁.md` `genre/cards/抗战谍战.md`
`genre/cards/科幻末世.md` `genre/cards/快穿.md` `genre/cards/历史古代.md` `genre/cards/历史脑洞.md`
`genre/cards/民国言情.md` `genre/cards/年代.md` `genre/cards/女频悬疑.md` `genre/cards/女频种田.md`
`genre/cards/青春甜宠.md` `genre/cards/双男主.md` `genre/cards/西方奇幻.md` `genre/cards/现言脑洞.md`
`genre/cards/星光璀璨.md` `genre/cards/悬疑灵异.md` `genre/cards/悬疑脑洞.md` `genre/cards/玄幻脑洞.md`
`genre/cards/玄幻言情.md` `genre/cards/游戏体育.md` `genre/cards/战神赘婿.md` `genre/cards/职场婚恋.md`

### 六、审稿

| 你在做什么 | 读 |
|---|---|
| 逐项检查清单（章节结构/节奏/人物/情绪/文字） | `review/review-quality.md` |
| 按平台标准打分（未指定平台时的默认 rubric） | `review/quality-rubric.md` |

## 与 world.json 的关系（重要）

上游把这套方法配的是「文件树当记忆」——`设定/角色/X.md`、`大纲/细纲_第N章.md`、`追踪/`。
**pi-write 不是那个形态**，别照着这些路径写文件：

- 人物、世界观、关系、时间线、大纲条目一律经 `world_update` 落进 `world.json`；
- `outline.md` / `.writer/*.md` 是它的派生视图，直写会被覆盖；
- 正文写在 `draft/` 下的当前章节文件（有白名单守卫，自创文件名前端读不到）；
- 这些文档里出现的 `设定/`、`大纲/`、`追踪/`、`.story/`、`拆文库/` 路径，只当**内容组织思路**看。

## 本库不做什么

- **不含流程**：上游的 hook 门禁、7 个专业 agent、`/story-setup` 部署、追踪提交协议都没有收进来。
  凡正文里提到「跑 `scripts/xxx.py`」「读 `workflow-*.md`」的，忽略即可——
  那几处残留引用见 `references/ATTRIBUTION.md`，不要去找那些文件。
- **不重复 pi-write 自己的技能**：开书落盘流程看 `outline` 技能，审稿流程看 `critique` 技能，
  改稿落笔看 `revise` 技能；本技能只提供它们背后要用的方法。
- **短篇方法**默认不适用（本库按长篇收的）；确有短篇任务时按文件自陈的范围取用，不要外推。
