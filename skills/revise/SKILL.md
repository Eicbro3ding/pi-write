---
name: revise
description: Use this skill when the user has decided what to fix (often after /skill:critique) and wants the agent to edit the chapter. Applies edits as targeted `edit` calls, never bulk rewrites.
---

# Revise skill

Activates when the user wants real, surgical edits applied to a draft file — not more discussion.

## When to use

- The user says: "revise", "fix the things from the critique", "tighten this chapter", "cut the adverbs", "tighten the dialogue".
- After they've reviewed a critique and prioritized what to fix.

## Steps

1. **Confirm scope and intent.** Ask once — at most — which of the critique points to act on. If the user already named them, proceed.
2. **Read the target file in full.** Re-read; do not edit from memory.
3. **Edit in surgical passes**, one concern at a time:
   - Use `edit` with the smallest precise `old_string` that contains the change. Do not replace whole paragraphs when one sentence is the fix.
   - Group related edits, but never batch unrelated concerns — if the model mixes voice fixes with continuity fixes, stop and split.
4. **After every pass**, run `word_count` if length was a concern, and re-read the changed region to confirm the edit landed cleanly and reads in context.
5. **Report at the end**:
   - what changed (per concern),
   - what was deliberately left alone (often more important),
   - the next step the user might want (`/skill:critique` again, or move to the next chapter).

## Editing rules

- Preserve the user's voice. You are allowed to cut, reorder, and substitute individual words; you are NOT allowed to rewrite a sentence the user clearly wrote in their own shape unless they asked.
- Do not introduce new names, beats, or plot. Revise *execution*, not *content*.
- Quoting convention: when you report a change, show the **old** → **new** for just the changed fragment.

## 深度方法论（craft 技能）

改稿手法在 `craft` 技能里（`<location>` 见系统提示词的 `<available_skills>`，方法论文档在
`references/` 下）。按这一轮要解决的问题选**一份** read，整份读：

| 要改什么 | 读 |
|---|---|
| 去 AI 味（指纹、模式检测、改写顺序、范例库） | `references/deslop/anti-ai-writing.md` |
| 去 AI 味的判定与放行标准 | `references/deslop/deslop-gates.md` |
| 禁用词与句式速查（对照着改） | `references/deslop/banned-words.md` |
| 文笔：镜头式写作、白描、视角、毒点 | `references/deslop/style-craft.md` |
| 装逼打脸写得不够爽 | `references/deslop/style-combat-face.md` |
| 文风取值顺序（当前请求/本书文风/作者偏好冲突时） | `references/deslop/style-resolution.md` |
| 正文密度与场景写法 | `references/prose/writing-craft.md` |

改稿仍受本技能的编辑规则约束：**只改执行，不改内容**；保留用户自己的句子形状；
不做整章重写。去 AI 味的目标是读感，不要为了过检测器而牺牲人物声音与场景任务。

## Do not

- Do not dump a rewritten chapter. Use `edit` calls. If the user wants a full redraft, they will say so explicitly.
- Do not delete more than two sentences silently. If a cut is larger than that, name it in your report.
- Do not chain revisions of different chapters in one go. One chapter per revise pass.