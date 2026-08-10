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

## Do not

- Do not dump a rewritten chapter. Use `edit` calls. If the user wants a full redraft, they will say so explicitly.
- Do not delete more than two sentences silently. If a cut is larger than that, name it in your report.
- Do not chain revisions of different chapters in one go. One chapter per revise pass.