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

## Do not

- Do not rewrite passages. Suggestions only. The actual rewrite belongs to /skill:revise.
- Do not critique traits the user chose deliberately (POV, tense, register). Comment on execution, not premise.
- Do not score generically; every point must cite a specific sentence from this chapter.