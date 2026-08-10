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

## Do not

- Do not write prose during outlining. Stay at beat level.
- Do not propose more than ~12 chapters for a first pass unless the user named a target length that warrants it.
- Do not invent character names; use placeholders (`[protagonist]`, `[mentor]`) until the user supplies them, then add them as `character` entries via `world_update upsert_entry`.