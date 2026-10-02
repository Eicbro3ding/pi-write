---
name: critique
description: Use this skill when the user asks for a critique, review, or "what's wrong with this chapter". Runs a structured diagnostic pass over the current chapter without rewriting it.
---

# Critique skill

Activates when the user wants a cold read of the current chapter (or a chosen draft file), not a rewrite.

## When to use

- The user says: "critique", "review this", "what's wrong", "is this working", "beta read".
- Before a /skill:revise pass — critique first, then revise to fix.

## Steps

1. **Identify scope.** If the user names a file, use it; otherwise default to the current chapter file. `read` it in full.
2. **Run the checklist below**, section by section. Report only what applies; do not manufacture problems.
3. **For each section**, give:
   - a one-line verdict (strong / mixed / weak),
   - the 1–3 specific instances that drove it, with quoted snippets,
   - a concrete suggestion (not a rewrite).
4. **End with a prioritized list** of the 3 most impactful things to fix, in order.

## Checklist

**Opening & promise.** Does the first paragraph imply a tension the reader will want resolved? Is the implied promise delivered on by the end?

**Scene structure.** Is each scene a unit of change (someone wants something, something stands in the way, the situation is different after)? Or are there summary paragraphs doing scene work?

**Pacing & rhythm.** Sentence-length variation. Long stretches of similar sentence length drag. Stacked clauses collapse rhythm.

**Dialogue.** Does each speaker sound distinct? Is there subtext or are characters saying exactly what they think? Are dialogue tags overworked ("exclaimed", "intoned")?

**Voice & redundancy.** Repeated pet words. Adverb stack near verbs. Filter verbs ("seemed to", "began to", "could see"). Two adjectives sharing a noun where one would do.

**Continuity.** Names, places, prior events consistent with `draft/*.md` and `.writer/characters.md`? `grep` for anything in doubt.

**Show vs tell.** Emotional states reported ("she was angry") vs rendered through action, sensation, speech.

**Closing.** Does the chapter end on a turn, a question, or a held breath — or does it just stop?

## 深度方法论（craft-review / craft-prose / craft-deslop 技能）

上面的 checklist 是通用项；**网文口径的判据**在几个 `craft-*` 技能里（各自的 `<location>` 见
系统提示词的 `<available_skills>`，方法论文档在各自 `references/` 下）。按被审对象选**一份** read，整份读：

| 审什么 | 读 | 在哪个技能 |
|---|---|---|
| 逐项质量检查（章节结构/节奏/人物/情绪/文字） | `references/review-quality.md` | `craft-review` |
| 按平台标准打分（番茄/起点/知乎盐言） | `references/quality-rubric.md` | `craft-review` |
| 章首章尾钩子是否抓人 | `references/long-chapter-hooks.md` | `craft-prose` |
| 情绪有没有落到纸面 | `references/emotion-on-page.md` | `craft-prose` |
| 反转/悬念写得成不成立 | `references/long-reversal.md`、`references/long-suspense.md` | `craft-prose` |
| 对话是不是平的 | `references/dialogue-mastery.md` | `craft-prose` |
| 读起来太 AI | `references/anti-ai-writing.md` | `craft-deslop` |
| 结构/大纲层面立不立得住 | `references/plot-frameworks.md`、`references/outline-rhythm.md` | `craft-outline` |

仍然**只提建议、不改稿**；改稿走 `/skill:revise`。审的是执行，不是用户刻意选定的前提（POV、时态、语域）。

## Do not

- Do not rewrite passages. Suggestions only. The actual rewrite belongs to /skill:revise.
- Do not critique traits the user chose deliberately (POV, tense, register). Comment on execution, not premise.
- Do not score generically; every point must cite a specific sentence from this chapter.