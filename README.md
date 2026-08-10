# pi-writer

Standalone creative writing agent built on the [pi](https://pi.dev) framework, with three faces: a **TUI**, a **local web GUI** (React), and an **Electron shell**. It ships as its own `pi-writer` binary and does not load pi's coding-agent extensions, skills, settings, or sessions.

- Book/chapter session management, a componentized **world-book** (single-source `world.json`), a character relationship graph, and writer tools for prose and fiction.
- Fully vendored pi core packages under `vendor/` — zero `@earendil-works` npm dependencies.
- All state lives under `~/.pi/writer` (books, sessions, agent config), never `~/.pi/agent`.

## Features

- **Three frontends, one data store** — full-screen TUI, local web GUI (`127.0.0.1:8811` by default), and an Electron desktop shell; all three share `~/.pi/writer` and can run in parallel on different ports.
- **Chapter = session** — every chapter is an independent pi session file; each has its own context, compaction, and branching.
- **Componentized world-book** — `world.json` holds typed entries (character/world/timeline/outline), a relation graph, writing constraints, style samples, Notice, a storyline, and timeline events; `.writer/*.md` views are generated exports.
- **Context activation engine** — per-chapter "背景包": only entries whose `keys` hit the draft/recent messages are injected, within a token budget.
- **Built-in editor** — full-screen editor inside the TUI (plain mode by default, vim mode optional) with undo/redo, mouse support, and a chat sidebar.
- **Web GUI** — "深夜书房" design: three-column writing desk (**书库** library | **纸张** always-visible draft | **AI 伙伴** chat/annotations panel), CodeMirror 6 editor (vim mode), selection → AI suggestion → apply/undo annotations, world list & relation-graph views, three themes (night/paper/parchment), slide/fade transitions, settings page.
- **Writer tools** — `word_count` (CJK-aware length metrics), `world_update` (14 structured world-book mutation ops). No `bash` for the model in web mode.

## Concepts

| Concept | What it means |
|---------|---------------|
| **Book** | A workspace directory (`~/.pi/writer/books/<slug>/`) containing `book.json` (index), `world.json`, `outline.md`, `draft/`, `notes/`, and the generated `.writer/` markdown views. `images/` is created on first image upload. |
| **Chapter** | An independent pi session file (`~/.pi/writer/sessions/<slug>/chXX.jsonl`) plus a draft file (`draft/chXX.md`). Each chapter has its own `/tree`, compaction, and branching. |
| **Memory** | `books/<slug>/memory.md` — book-level cross-chapter memory (~1500-token budget). Its content is injected into every chapter's context pack before writing; the agent updates it at chapter close (newest first, trimming the oldest when full). The only delivery file allowed outside `draft/`. |
| **World-book** | A componentized world store (`books/<slug>/world.json`): typed entries, relations, constraints, style samples, Notice, storyline, timeline events. The markdown views in `.writer/` are generated from it (export-only, header warns against manual edits). |
| **Relation graph** | Cytoscape-based character/world graph in the web GUI: circular avatar nodes (entry `avatar` image, or an auto-generated letter avatar), per-book persisted node layout & viewport, right-click quick edit, link mode, undo. |
| **Skills** | Bundled Markdown methodologies loaded as pi skills: `outline`, `critique`, `revise`, `stage-scripting` (the latter serves stage directing; it is loadable as `/skill:stage-scripting` too). Typing `/skill:name` expands the skill inline (TUI and web chat alike); the `/` command menu does not list skill commands. |

## Standalone identity

pi-writer keeps all of its configuration under `~/.pi/writer`:

- `~/.pi/writer/agent/` — auth (`auth.json`), models, settings, extensions, skills, themes, packages, keybindings
- `~/.pi/writer/books/` — book workspaces
- `~/.pi/writer/sessions/` — chapter session transcripts (outside the book workspace, "so prose grep does not trip over transcript JSONL")

It never reads `~/.pi/agent` (pi's coding-agent config). Authenticate once inside pi-writer with `/login`, or set provider API key environment variables such as `ANTHROPIC_API_KEY`.

## Prerequisites

- Node.js >= 18.20.4 (Android nodejs-mobile is 18.20.4)
- Optional: [bun](https://bun.sh) — needed for `npm run bundle` (the TUI single-file executable and its multi-platform cross-compilation) **and `npm run build:electron`** (the Electron main/preload bundles are built with bun). `npm run build:web` (web backend via esbuild + vite frontend) does not need bun.

## Quick start

This repository is a standalone checkout (the pi core packages are vendored under `vendor/`); the package root is the repository root.

```bash
# Install dependencies
npm install

# TUI: create and open a new book
npx tsx src/cli.ts --new-book "我的小说"

# TUI: open an existing book
npx tsx src/cli.ts --book my-novel

# TUI: non-interactive (print mode)
npx tsx src/cli.ts -p "Outline a short story about autumn rain"

# Web GUI: start the local server and open the browser (default 127.0.0.1:8811)
npx tsx src/cli.ts --web [--book my-novel]

# Web GUI: server only (no browser; pair with `cd web && npx vite dev` for HMR)
npx tsx src/cli.ts --web --no-browser

# Web GUI: Electron shell
npx tsx src/cli.ts --web --electron

# Version
npx tsx src/cli.ts --version
```

## CLI reference

Argument parsing lives in `src/cli.ts` (`parseArgs`, hand-rolled loop, no arg library) and `src/web.ts` (`parseWebArgs`).

| Flag | Type / default | Behavior |
|------|----------------|----------|
| `--web` | boolean | Start the web GUI path (routes to `parseWebArgs` + `startWebServer`, or Electron shell with `--electron`). |
| `--port <N>` | int, web only | Web server port (default **8811**), validated 1–65535 in `parseWebArgs`. |
| `--no-browser` | boolean, web only | Start the server without spawning a browser. |
| `--electron` | boolean, web only | Launch the Electron shell (`dist/electron/main.cjs`); the service is started in-process by Electron main. |
| `--book`, `-b <slug>` | string | Open a book; creates it if missing (slug used as title). Also forwarded to web mode. |
| `--new-book`, `--title <title>` | string | Create a book (Chinese titles preserved via `slugify`) and open it. |
| `--chapter <selector>` | string | Chapter selector: 1-based index, id (`ch01`), file, or `file + ".jsonl"` (via `resolveChapter`). Not forwarded to web mode. |
| `--model`, `-m <pattern>` | string | Model pattern, resolved via `resolveCliModel`; forwarded to web mode. |
| `--thinking <level>` | string | One of `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`; forwarded to web mode. |
| `-p`, `--print [prompt]` | boolean | Non-interactive print mode: runs one prompt, prints the reply, exits. |
| `--stage` | boolean | Stage mode: headless stage orchestration CLI (runs a stage script against the world). |
| `--verbose` | boolean | Force verbose startup diagnostics. |
| `-c`, `--continue` | boolean | Accepted no-op — default startup already continues the most recent book's current chapter. |
| `-v`, `--version` | boolean | Print `VERSION`. |
| `-h`, `--help` | boolean | Print help text. |
| positional | string | First non-dash argument becomes the initial prompt. |

Book resolution order: `--new-book` → `--book` → most recently updated book → `createBook("未命名")`. Chapter resolution: `--chapter` → `book.currentChapterFile` → `book.chapters[0]` → `addChapter(slug, "第一章")`.

TUI tool list (as configured in `src/cli.ts`): `read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`, `word_count`, `world_update`, `world_find`. Web mode uses a subset without `bash`: `read`, `write`, `edit`, `grep`, `find`, `ls`, `word_count`, `world_update`, `world_find`. The system prompt tells the model **"你可以使用 `bash`(工作目录为书目录)"** in the TUI (bash present in the tool list), and "你**没有** `bash`" in web mode (omitted entirely).

## Commands (inside the TUI)

Registered by the inline extension `writerExtension` (`src/extension.ts`):

| Command | Description |
|---------|-------------|
| `/chapters` | List all chapters in the current book and switch to one. |
| `/new-chapter [title]` | Add a new chapter and switch to it. Default title: `第 N 章`; default label: `草稿`. |
| `/rename-chapter TITLE [LABEL]` | Rename and/or relabel the current chapter. |
| `/world` | Browse the world-book (人物/世界/时间线/大纲); selecting an entry offers to edit it. |
| `/notice` | Show the Notice (current story guidance). |
| `/storyline` | View the storyline and mark a node done (`advance_storyline`). |
| `/constraints` | View enabled writing constraints (read-only; edit in the web GUI). |
| `/relations` | View the relation graph as text (edit in the web relation graph). |
| `/new-book [title]` | Create a book and switch to its first chapter. |
| `/rename-book TITLE` | Rename the current book (title → new slug; workspace/session dirs migrate). |
| `/book` | List all books, pick one, then pick a chapter to switch to. |
| `/edit [path]` | Open the built-in full-screen editor (default: `draft/<chapter-id>.md`; `--vim` for vim mode; `--force` bypasses the `.writer/` / `outline.md` read-only guard). |
| `/adopt-draft` | Regenerate a chapter session from its draft file (rebase the session transcript on current prose). |
| `/skill:name` | Invoke a bundled writing skill (`outline`, `critique`, `revise`, `stage-scripting`). Note: skill commands are excluded from the `/` command menu (`setEnableSkillCommands(false)`), but typing `/skill:name` still expands — including in web chat. |

TUI chrome: status line (`📖 《title》 · ch01 · 第一章 [label]`), `writer-info` widget (below-editor info bar with word count), persistent `draft-panel` widget (side-panel editor with 800 ms autosave), footer (`esc 中断 · / 命令 · /edit 编辑器 · /world 世界书`), and a branded startup header (`✒ pi-writer` wordmark, tagline `以笔为舟 · 一章一章，写就你的世界`).

## Agent tools

Tool definitions live in `src/tools.ts` (typebox schemas, no hand-written JSON Schema). All file tools are confined to the book directory by `src/tool-guard.ts` (`installToolPathGuard(bookDir, readOnlyDirs = [skillsDir])` — the bundled `skills/` dir is read-only).

### `word_count`

Accurate length metrics for draft files or directories (`*.md` walked recursively). Never estimates by eye — the system prompt instructs the agent to call it after drafting/revising.

| Param | Type | Notes |
|-------|------|-------|
| `path` | string (required) | File or directory (relative to the book dir). |
| `modes` | `("cn_chars" \| "en_words" \| "sentences" \| "paragraphs" \| "all")[]` | Default `["all"]`. |
| `target` | number | Optional target for the primary metric (cn_chars if present, else en_words); reports `Target <n> <metric>: +delta (pct%)`. |

Counting rules: CJK ideographs via `src/cjk.ts` (code-point ranges `0x3400–0x4DBF`, `0x4E00–0x9FFF`, `0xF900–0xFAFF`); English words via a hand-rolled scanner (`src/tools.ts` `countEnglishWords` — ASCII + Latin-1 supplement + Latin Extended-A, apostrophe-joined words like `don't` stay one word; no `\p{L}` regex because Android lacks full ICU); sentences split on `[.。!！?？]`; paragraphs split on blank lines. Output: per-file lines `rel/path: N cn | N en | N 句 | N 段` plus a `Total:` block.

### `world_update`

The **only** channel for mutating the world-book (the system prompt forbids `edit`/`write` on `world.json`). One `update` param — a discriminated union of 14 ops, applied via the pure function `applyWorldUpdate(data, update): WorldData` (clone → mutate → `validateWorld`, throwing `WorldValidationError` on violations). Server-side reads, applies, and saves atomically under a per-book promise lock (`withWorldLock`).

| op | Required params | Optional params | Semantics / errors |
|----|-----------------|-----------------|--------------------|
| `upsert_entry` | `type`, `title` | `id`, `keys`, `chapters`, `status`, `parent`, `body`, `avatar`, `images` | True upsert: with `id`, patch the existing entry or create one **with that id** if missing; without `id`, match an existing entry by `(type, title)` — update it in place (id preserved) or create with `newId("entry")`, status `active`. |
| `delete_entry` | `id` | — | Blocked while any relation references the entry (`条目 <id> 仍被关系引用,请先删除相关关系`); children's `parent` reset to null. |
| `set_status` | `id`, `status` | — | Sets entry status + `updatedAt`. |
| `append_timeline` | `text` | `chapter` | Push `{ id: newId("evt"), chapter, text }`. |
| `update_timeline` | `id` | `chapter`, `text` | Missing → `时间线事件不存在: <id>`. |
| `delete_timeline` | `id` | — | Missing → `时间线事件不存在: <id>`. |
| `update_notice` | `text` | — | Sets Notice text + `updatedAt` (max 1000 字). |
| `advance_storyline` | `id`, `status` | `next` | Missing node → auto-created with `title: id`. Enforces at most one `in-progress` node. |
| `upsert_storyline_node` | `title` | `id`, `status`, `goal`, `next` | Create (`newId("story")`, status `pending`) or patch. |
| `upsert_constraint` | `name`, `text` | `id`, `enabled` | With `id`: must exist (`约束不存在: <id>`), name/text always overwritten. Without: create (max 800 字). |
| `delete_constraint` | `id` | — | Filter; no error if missing. |
| `update_style_sample` | `text` | `source` | Sets `{ text, source, updatedAt }` (max 500 字). |
| `upsert_relation` | `from`, `to` | `id`, `type`, `label`, `emphasized`, `arrow` | With `id`: must exist, `from`/`to` always overwritten. Without: create (`newId("rel")`, `arrow` defaults `"double"`). Rejects dangling endpoints and self-loops. |
| `delete_relation` | `id` | — | Filter; no error if missing. |

`arrow` enum: `"none"` (无箭头) / `"single"` (单向 from→to) / `"double"` (双向).

### MCP tools (external)

MCP (Model Context Protocol) servers can extend the agent's toolset beyond the built-ins. Servers live in `~/.pi/writer/agent/mcp.json`:

- **Config shape**: either the native `{ "servers": [...] }` array or the Claude Code format — a `mcpServers` object (transport inferred from `command` / `url` + `transportType`; `directTools`/`disabled` handled; `imports: ["claude-code"]` merges servers from `~/.claude.json`, local entries override same names).
- **Transports**: `stdio` (local command), `http` (Streamable HTTP, current standard), `sse` (legacy, still supported). OAuth-protected endpoints fail with a clear "auth required" message (auth flow not implemented).
- **Runtime**: unexpected disconnects auto-reconnect (3s→30s backoff, session rebuilt on success); stdio startup failures surface the process's stderr tail in the error; tool results carry resource text bodies (truncated at 20k chars) and server-reported `_meta.usage` token counts.
- The settings page shows connection status/tool counts and offers an "edit file directly" editor that reads/writes `mcp.json` verbatim (for `imports`/Claude shapes the form cannot express).
- Configured tools are injected into the agent's system prompt (name + one-line description each) — tool visibility is dynamic, not a hardcoded list.

API keys (e.g. `TAVILY_API_KEY`) live only in your local `mcp.json` — never commit them (`.gitignore` blocks `**/mcp.json`).

## World-book data model (`world.json`)

Schema, validation, atomic save, and markdown view rendering live in `src/world-data.ts`; `version` is a literal `1` (legacy support is field-level normalization, no version migration path yet).

```ts
interface WorldData {
  version: 1;
  entries: WorldEntry[];
  relations: WorldRelation[];
  constraints: WorldConstraint[];
  styleSample: StyleSample | null;
  notice: NoticeData;
  storyline: StorylineData;
  timeline: TimelineEvent[];
}
```

| Type | Fields |
|------|--------|
| `WorldEntry` | `id`, `type` (`"character" \| "world" \| "timeline" \| "outline"`), `title`, `keys: string[]` (activation keywords), `chapters: string[]` (empty = active in every chapter), `status` (`"alive" \| "dead" \| "unknown" \| "active" \| "archived" \| "draft"`), `active: boolean`, `parent: string \| null`, `tags: string[]`, `body`, `avatar: string \| null`, `images: string[]` (max **9**), `updatedAt` |
| `WorldRelation` | `id`, `from`, `to` (entry ids), `type`, `label`, `emphasized: boolean`, `arrow: "none" \| "single" \| "double"` (legacy default `"double"`) |
| `WorldConstraint` | `id`, `name`, `text` (max **800** 字), `enabled` |
| `StyleSample` | `text` (max **500** 字), `source`, `updatedAt` |
| `NoticeData` | `text` (max **1000** 字), `enabled`, `updatedAt` |
| `StoryNode` | `id`, `title`, `status` (`"pending" \| "in-progress" \| "done" \| "shelved"`), `goal`, `next: string \| null` |
| `StorylineData` | `enabled`, `nodes: StoryNode[]` (at most one `in-progress`) |
| `TimelineEvent` | `id`, `chapter`, `text` |

Image refs must match `images/<single-file-name>` (`IMAGE_REF_RE`) — absolute paths, subdirectories, `..`, and backslash forms are all rejected.

Validation highlights (all throw `WorldValidationError` with Chinese messages): duplicate ids, dangling `parent`/relation endpoints, self-parent, self-loop relations, bad enum values, missing `notice`/`storyline` sections, over-limit texts, more than one in-progress storyline node. Normalization: legacy relations without `arrow` get `"double"`; entries missing `avatar`/`images` get `avatar: null, images: []`; a non-null avatar not in `images` is unshifted to the front (and deduped).

**Atomic save** (`saveWorld`): validate → copy existing file to `world.json.bak` → write unique tmp `world.json.tmp.<pid>.<rand>` → rename (up to 3 attempts with backoff for Windows EPERM) → re-read and validate the on-disk result; on failure restore from `.bak` and throw. After every save, `writeWorldViews` regenerates the export markdown: `.writer/characters.md` (`# 人物档案`), `.writer/world.md` (`# 世界设定`), `.writer/timeline.md` (`# 时间线`), `outline.md` (`# 大纲`) — each starting with `> 此文件为 world.json 的导出视图,编辑请走界面(web 世界书页 / TUI 命令)。`.

**Migration**: when no `world.json` exists, `ensureWorld` runs `migrateFromMarkdown` — headings `#`/`##`/`###` of the four legacy markdown files become entries (first `# ` of each file is the container, skipped); `- parent:` / `- avatar:` / `- images:` metadata lines are parsed out; self-parents and unknown parents are dropped.

## Context activation engine (`src/world-context.ts`)

`buildChapterContext(data, { chapterId, draftText, recentUserMessages, budget })` produces the per-chapter "背景包" injected into the session as a `world-context` custom message (`deliverAs: "nextTurn"` — arrives with the next user turn, invisible in the UI). Default budget `DEFAULT_CONTEXT_BUDGET = 2000` tokens; `estimateTokens`: CJK chars = 1 token each, everything else `ceil(len / 4)`.

Activation (`activatedEntryIds`): an entry is included iff `active === true` AND (`chapters` empty OR contains `chapterId`) AND at least one non-empty `keys` entry is a substring of `draftText` + the first 2 recent user messages. Entries with no `keys` never activate. Activated entries are packed in type priority order (`character` → `world` → `timeline` → `outline`), first entry always included ("至少一条相关设定"), over-budget entries trimmed with a `(已裁剪 <n> 条,需要可 read world.json)` note.

Pack shape: `【写作约束】` (enabled constraints; trimmed last, sample first when over budget) → `【文风采样】` (with `(来源: ...)`) → `【世界书·本章相关】` (activated entries as `- <title>: <body>`) → tail, never trimmed: `【Notice】` and `【发展线】` (当前位置/目标/下一步 of the in-progress node).

## Bundled skills

| Skill | Purpose |
|-------|---------|
| `outline` | Structure a book (3-act, hero's journey, kishōtenketsu, episodes) and write the outline as a `type: "outline"` world-book entry via `world_update upsert_entry` (`# Title` / `Premise:` / `## Chapters` / `### N. <title>` with `Promise:` / `Turn:` / `Cliff/open:` rows; ≤ ~12 chapters first pass). Never writes `outline.md` directly — it is a generated view of `world.json`. |
| `critique` | Structured diagnostic pass without rewriting: Opening & promise, Scene structure, Pacing & rhythm, Dialogue, Voice & redundancy, Continuity, Show vs tell, Closing — one-line verdict + 1–3 quoted instances + concrete suggestion per section, then a prioritized list of the 3 most impactful fixes. |
| `revise` | Surgical edits from critique results: one targeted `edit` per concern, `old → new` quoting, never bulk rewrites; `word_count` after every pass. |
| `stage-scripting` | Stage-mode (舞台区) methodology: scene structure, casting rules, and the `stage_script` tool contract — read by the director session in `--stage` mode; also loadable as `/skill:stage-scripting`. |

## Architecture

### Layered overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Faces                                                                    │
│   TUI (pi-tui InteractiveMode)   Web GUI (React)   Electron shell        │
└───────────────┬──────────────────────────┬───────────────────────────────┘
                │  src/cli.ts               │  HTTP REST + SSE (127.0.0.1)
                │  src/extension.ts         ▼
                │                    ┌──────────────────────┐
                │                    │ WriterServer         │  src/web/server.ts
                │                    │ 40 REST endpoints +  │
                │                    │ /api/events (SSE)    │
                │                    └──────────┬───────────┘
                ▼                               ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ Runtime (pi-coding-agent)│◄────►│ SessionHost              │  src/web/session-host.ts
│ session manager, tools   │      │ headless session wrapper │
│ (read/write/edit/grep/   │      │ sendMessage/abort/       │
│  find/ls + word_count +  │      │ switchSession/injectContext
│  world_update)           │      └──────────────────────────┘
└───────┬───────────┬──────┘
        │           │
        ▼           ▼
┌──────────────────────────────────────────────────────────┐
│ Data layer                                                 │
│  book-manager.ts  book.json index, chapters, sessions     │
│  world-data.ts    world.json schema/validation/atomic save │
│                   + .writer/*.md export views + migration │
│  world-context.ts per-chapter activation + token budget   │
│  world-lock.ts    per-book read-modify-write serialization│
│  tool-guard.ts    path confinement to the book dir        │
└──────────────────────────────────────────────────────────┘
```

### Source layout

```
pi-writer/
├── package.json              # "type": "module"; web frontend lives HERE (no web/package.json)
├── tsconfig.build.json       # extends ../../tsconfig.base.json (monorepo root, not in this checkout)
├── tsconfig.tmp.json         # standalone type-check config (src + vendor + electron)
├── vitest.config.ts          # extends ../../vitest.base.ts (also missing here)
├── vitest.tmp.config.ts      # standalone test config (globals, node env, PI_OFFLINE=1)
├── scripts/
│   └── web-build.mjs         # web packaging orchestration (see Development)
├── skills/
│   ├── outline/SKILL.md      ├── critique/SKILL.md      └── revise/SKILL.md
├── vendor/                   # vendored pi core packages (monorepo main, relative imports)
│   ├── pi-coding-agent/      #   includes the local sidePanel widget placement extension
│   └── pi-ai/ pi-tui/ pi-agent-core/ pi-client/ pi-protocol/
├── src/
│   ├── cli.ts                # CLI entry: parseArgs, TUI/print/web routing
│   ├── web.ts                # web subcommand: parseWebArgs / startWebServer / runMain
│   ├── config.ts             # paths (getWriterDir/getAgentDir/getBooksDir), slugify, VERSION
│   ├── book-manager.ts       # book/chapter index (book.json), sessions layout
│   ├── world-data.ts         # world.json schema/validation/atomic save/md views/migration
│   ├── world-context.ts      # activation engine (chapter filter → key match → budget)
│   ├── world-lock.ts         # per-book promise queue for world_update serialization
│   ├── world-tree.ts         # legacy markdown world-book tree (TUI /world picker)
│   ├── tool-guard.ts         # installToolPathGuard: confine tools to the book dir
│   ├── tools.ts              # word_count + world_update (typebox schemas, applyWorldUpdate)
│   ├── extension.ts          # inline writerExtension: commands, status line, widgets
│   ├── prompt.ts             # WRITER_SYSTEM_PROMPT
│   ├── startup-header.ts     # pi-writer branded startup header
│   ├── draft-panel.ts        # persistent side-panel draft editor (800 ms autosave)
│   ├── writer-ui.ts          # WriterUiState, WriterInfoBar, WriterFooter, countWriting
│   ├── writer-theme.ts       # buildWriterTheme(): warm "ink & paper" palette
│   ├── session-factory.ts    # session assembly: createSessionRuntimeFactory (cli/web/stage)
│   ├── cjk.ts                # CJK char counting — single source (code-point ranges, no \p{)
│   ├── atomic-write.ts       # atomic file write — single source (unique tmp + rename retry)
│   ├── session-text.ts       # session message text extraction (shared TUI/web)
│   ├── index.ts              # public API exports
│   ├── mcp/                  # MCP config (typebox) / manager (SDK) / tool adaptation
│   ├── stage/                # stage mode: director/actor/writer multi-agent demo
│   ├── editor/               # built-in editor (plain by default, vim optional)
│   │   ├── document.ts       #   VimDocument: pure vim document model (unit-tested)
│   │   ├── vim-file-editor.ts#   full-screen TUI component
│   │   ├── mouse.ts          #   SGR mouse protocol parser
│   │   ├── args.ts           #   parseEditArgs (--vim / --force / path)
│   │   ├── chat.ts           #   ChatApi / ChatMessage contract
│   │   └── index.ts          #   openFileEditor entry
│   └── web/
│       ├── server.ts         # WriterServer: Node http, 40 REST endpoints (route-table
│       │                     #   driven) + SSE + static; multipart via busboy
│       ├── session-host.ts   # SessionHost: headless session wrapper
│       ├── provider-auth.ts  # ProviderAuthKind, ProviderListItem, key login
│       ├── file-watcher.ts   # WorldWatcher: external world/draft change polling
│       ├── stage-host.ts     # stage web host (per-book orchestrator, lazy)
│       └── book-zip.ts       # book export/import as zip (limits: 50 MB / 2000 entries)
├── web/
│   ├── index.html            # lang="zh-CN"
│   ├── vite.config.ts        # dev port 5173, /api proxy → 127.0.0.1:8811, outDir dist
│   ├── public/fonts/         # HarmonyOS Sans SC (Regular/Medium/Bold)
│   └── src/
│       ├── main.tsx / App.tsx            # tab shell (write/world/settings), no router lib
│       ├── pages/            # WritePage, WorldPage, SettingsPage
│       ├── components/       # DraftWorkspace, ChapterSidebar, InputBar, MessageList,
│       │                     #   RelationGraph, WorldTree, EntryForm, EntryCard,
│       │                     #   AnnotationPanel/History, FullScreenEditor, ProviderList...
│       ├── editor/           # CodeMirrorBox (CodeMirror 6 + markdown + optional vim)
│       ├── api/              # client.ts (API client + EventSource SSE), types.ts
│       ├── store.ts          # session reducer (processAgentEvent)
│       ├── workspace.ts      # workspace reducer + pure helpers (annotations/apply/undo)
│       ├── workspace-binding.ts, graph-logic.ts, markdown.ts, themes.ts, theme.ts,
│       ├── errors.ts, motion.ts, id.ts, file-input.ts, Icons.tsx
│       └── styles.css        # A3 minimal design tokens, 3 themes (ink/paper/parchment)
├── electron/
│   ├── main.ts               # in-process server (loadServerBundle) + BrowserWindow
│   └── preload.ts            # placeholder (no contextBridge yet — HTTP only)
├── dist/                     # build output: web/server.cjs, electron/main.cjs, preload.js
├── release/                  # bundle output (pi-writer.exe), electron installer output
└── test/                     # vitest suite (globals: true, pure logic only)
```

## Key APIs

### Public package API (`src/index.ts`)

```ts
// book-manager.ts
addChapter(slug, title, label?): Promise<ChapterRef>        // default title 第 N 章, label 草稿
createBook(title): Promise<BookIndex>                        // slug dedup: -2, -3…
ensureBook(slug, displayTitle?): Promise<BookIndex>
initChapterFile(absPath, cwd): Promise<void>                 // writes {type:"session",version:3,id,timestamp,cwd}
listBooks(): Promise<BookListEntry[]>                        // sorted by updatedAt desc
loadBook(slug): Promise<BookIndex | null>
resolveChapter(index, selector): ChapterRef | undefined      // 1-based index | id | file | file+".jsonl"
setCurrentChapter(slug, file): Promise<BookIndex>
updateChapter(slug, selector, patch: {title?, label?}): Promise<BookIndex>
getBookSessionsDir(slug): string   getChapterSessionsPath(slug, file): string

// config.ts
APP_NAME, APP_TITLE, VERSION
getWriterDir(): string   getAgentDir(): string   getBooksDir(): string
getBookDir(slug)   getBookIndexPath(slug)   getChapterFile(slug, fileName)
slugify(input): string   // preserves CJK: [a-z0-9\u4e00-\u9fff] kept, rest → "-", empty → "untitled"

// others
writerExtension            // inline pi extension (TUI commands + status line + widgets)
WRITER_SYSTEM_PROMPT       // writing system prompt
wordCountTool              // defineTool("word_count", …)
```

### REST API (`src/web/server.ts` — `WriterServer`)

Base URL `http://127.0.0.1:8811`. Error contract: uniform `{ "error": { "code", "message" } }` with codes `forbidden` / `bad_request` / `bad_path` / `not_found` / `payload_too_large` / `too_large` / `error`. JSON bodies over 1 MB → 413; invalid JSON → 400.

| Method | Path | Params (body unless noted) | Success | Errors |
|--------|------|----------------------------|---------|--------|
| GET | `/api/events` | — | SSE event stream (below) | 403 guards |
| GET | `/api/books` | — | `{ books }` | — |
| POST | `/api/books` | `title` (required) | `{ book }` | 400 missing |
| GET | `/api/session/tree` | — | `{ currentLeafId, branches[] }` (branch bar data) | — |
| GET | `/api/session` | — | `SessionStateSnapshot` (see SessionHost) | — |
| POST | `/api/chat` | `text` (required) | **202** `{ ok: true }` (async; output via SSE) | 400 missing |
| POST | `/api/messages/retract` | `entryId`, `replacement?` | `{ ok: true }` + SSE `messages_retracted` | 400 not latest user msg / streaming |
| POST | `/api/messages/branch` | `entryId` | `{ ok: true }` + SSE `messages_retracted` | 400 unknown / not a message |
| POST | `/api/messages/navigate` | `entryId` | `{ ok: true }` + SSE `messages_retracted` | 400 unknown / streaming |
| POST | `/api/abort` | — | `{ ok: true }` | — |
| GET | `/api/models` | — | `{ models, current, thinking }` | — |
| POST | `/api/model` | `model` (required) | `{ ok: true }` | 400 missing |
| POST | `/api/thinking` | `level` (required) | `{ ok: true }` | 400 missing |
| GET | `/api/providers` | — | `{ providers: ProviderListItem[] }` | — |
| POST | `/api/providers/:id/apikey` | `key` (required) | `{ ok: true }` | 404 unknown; 400 not api-key-auth; 400 `ProviderAuthError` |
| DELETE | `/api/providers/:id` | — | `{ ok: true }` | 404 unknown |
| GET | `/api/world` | — | `{ world }` (full world.json) | 404 no open book |
| PUT | `/api/world` | `world` (required object) | `{ ok: true }` + SSE `world_changed` | 400 missing / `WorldValidationError` |
| GET | `/api/draft` | query `file` (required), `slug` (optional) | `{ text }` | 400 bad path; 404 missing |
| PUT | `/api/draft` | `file`, `text` (required), `slug` (optional) | `{ ok: true }` + SSE `draft_changed` | 400 bad path |
| GET | `/api/cards` | query `slug`, `chapterFile` (required) | `{ cards }` (empty if file missing/corrupt) | 400 missing; 404 book/chapter |
| PUT | `/api/cards` | `slug`, `chapterFile`, `cards` (array) | `{ ok: true }` (empty array deletes the file) | 400 missing/not array; 404 book/chapter |
| GET | `/api/books/:slug` | — | `{ book }` | 404 `书不存在: <slug>` |
| PATCH | `/api/books/:slug` | `title` (required) | `{ book }` (renamed; workspace/session dirs migrate, current session follows) | 404 unknown book; 400 empty title / slug conflict |
| POST | `/api/books/:slug/session` | `chapterFile` (required) | **202** `{ ok: true }` (queued in switch mutex) | 404 book / 404 `章节不存在: <file>` / 400 `bad_path` |
| POST | `/api/books/:slug/images` | multipart `file` | `{ file: "images/img-<6hex>.png" }` (server-named) | 400 not png/jpeg/webp/gif (`仅支持 png/jpeg/webp/gif 图片`) / >5 MB (`图片超过 5MB`) |
| GET | `/api/books/:slug/images/:file` | `:file` = URL-encoded `images/x.png` | raw bytes (content-type by extension) | 400 `bad_path`; 404 |
| DELETE | `/api/books/:slug/images/:file` | same | `{ ok: true }` | 400 `bad_path`; 404 |
| GET | `/api/books/:slug/export` | — | `application/zip` (whole book dir) | 404 unknown book |
| POST | `/api/books/import` | multipart `file` (zip) | `{ book }` (slug conflict → `<slug>-import-N`) | 400 all validation failures |
| DELETE | `/api/books/:slug` | — | `{ ok: true }` (book dir + sessions removed) | 404 unknown book |
| POST | `/api/books/:slug/chapters` | `title` (required, may be empty) | `{ chapter }` | 404 unknown book |
| PATCH | `/api/books/:slug/chapters/:id` | `title?`, `label?` (string or null) | `{ book }` (full index) | 404 book; 400 unknown chapter / invalid label |
| GET | `/api/mcp` | — | `{ servers, status }` (config + connection status) | 404 MCP disabled |
| POST | `/api/mcp` | `{ name, type, command/url, ... }` | `{ servers, status }` (reloads + rebuilds session) | 400 dup name; 404 disabled |
| GET | `/api/mcp/raw` | — | `{ text }` (mcp.json verbatim) | 404 disabled |
| PUT | `/api/mcp/raw` | `text` (required) | `{ servers, status }` (verbatim save + reload) | 400 invalid; 404 disabled |
| PUT | `/api/mcp/:name` | server config | `{ servers, status }` | 400 name mismatch; 404 unknown/disabled |
| DELETE | `/api/mcp/:name` | — | `{ servers, status }` | 404 unknown/disabled |
| GET | `/api/stage/:slug` | — | `StageSnapshot` (phase/cast/transcript/counts) | 404 stage disabled |
| POST | `/api/stage/:slug/command` | `cmd` + args | 200 `{ text }` (sync) / **202** (long cmd → `stage_done` SSE) | 400 `StageCommandError`; 404 disabled |
| any | `/api/...` unmatched | — | — | 404 `{ error: { code: "not_found", message: "未找到" } }` |

Non-`/api` GET/HEAD requests serve static files from `web/dist` (SPA fallback to `index.html` for extensionless paths; path traversal → 400 `bad_path`); missing `staticRoot` → 404 JSON. There is **no WebSocket** — live updates are SSE only.

### SSE event stream

`GET /api/events` (`text/event-stream`, `cache-control: no-cache`). All frames are `data: {json}` (no `event:`/`id:` fields); a comment heartbeat `: ping` is broadcast every 30 s (`PING_INTERVAL_MS`).

1. Every vendor `AgentSessionEvent` from SessionHost, passed through verbatim: `turn_start`, `turn_end`, `message_start`, `message_update` (with `text_delta` / `thinking_delta` parts), `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_settled`, …
2. Synthetic multi-client sync events:
   - `{ "type": "session_changed", "bookSlug", "chapterFile" }` — after a chapter switch
   - `{ "type": "world_changed", "slug" }` — after `PUT /api/world`
   - `{ "type": "draft_changed", "slug", "file" }` — after `PUT /api/draft`

The frontend subscribes via `new EventSource(...)` (native auto-reconnect; chat history re-aligned `onopen`). Chapter switches are serialized by an internal promise mutex so concurrent browsers switch FIFO.

### SessionHost (`src/web/session-host.ts`)

Headless wrapper around a pi agent session; a plain listener set (no EventEmitter).

```ts
new SessionHost({ createRuntime, cwd, agentDir, sessionManager })
start(): Promise<void>                       // wraps factory, binds session
subscribe(listener: (e: AgentSessionEvent) => void): () => void   // returns unsubscribe
sendMessage(text): Promise<void>             // → session.prompt(text)
injectContext(text): Promise<void>           // world-context custom message, deliverAs "nextTurn"
abort(): Promise<void>                       // → session.abort()
switchSession(chapterAbsPath): Promise<void> // → runtime.switchSession + rebind
setModel(model): Promise<void>               // resolveCliModel then session.setModel
setThinkingLevel(level): Promise<void>       // cast to ThinkingLevel
getRuntime(): AgentSessionRuntime
listProviders(): Promise<ProviderListItem[]> // deduped from modelRuntime.getModels()
setProviderApiKey(providerId, key): Promise<void>   // modelRuntime.login(id, "api_key", …)
removeProvider(providerId): Promise<void>    // modelRuntime.logout(id)
getState(): SessionStateSnapshot             // see below
dispose(): Promise<void>
```

`SessionStateSnapshot` (returned by `GET /api/session`):

```ts
{
  sessionFile: string | null,   // e.g. …/sessions/<slug>/ch01.jsonl
  bookSlug: string | null,      // basename of the sessions subdir
  chapterFile: string | null,   // basename of the session file
  isStreaming: boolean,
  messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: string }>,
  diagnostics: Array<{ type: "error" | "warning" | "info"; message: string }>,
}
```

### Built-in editor (`src/editor/`)

`/edit [path]` mounts a full-screen overlay (`openFileEditor(ctx, options)` → `Promise<VimFileEditorResult { saved, content }>`); the default path is `draft/<chapter-id>.md`. Result: plain mode (start typing immediately) or vim mode (`--vim`).

**Plain mode keys** — typing, Enter newline, Backspace/Delete, arrows, Home/End, PageUp/PageDown (10 lines); `Ctrl+S` save · `Ctrl+Z`/`Ctrl+Y` undo/redo · `Ctrl+A` select all · `Ctrl+Q` quit · `Esc` quit · `Tab` focus chat; toolbar buttons 保存 / 退出 / 撤回 / 重做 (clickable); bracketed paste supported. Mouse: click cursor, press-and-drag select, double-click word, triple-click line, wheel scroll, right-click (or `Shift+F10`) context menu (和 AI 讨论 / 复制 / 全选), drag the `│` divider to resize the chat sidebar (`CHAT_MIN_WIDTH 26`, `CHAT_MAX_RATIO 0.6`).

**Vim mode** — normal/insert/visual; `h j k l` / `w b e` (count prefixes `1-9`) / `0 ^ $` / `gg G`; `x` delete, `dd`/`yy` (linewise, count-aware), `p P` paste, `u` undo, `Ctrl+R` redo, `r<char>` replace; `i a A I o O v`; visual: motions + `y`/`d`/`x`/`v`; `:` command line: `w` / `q` (dirty → `未保存，:q! 强制退出`) / `q!` / `wq` / `x` / `wq!`. Dirty-buffer exits never close silently — the status bar shows `未保存！Ctrl+S 保存 / Ctrl+Q 放弃` (plain) or `未保存，:w 保存 / :q! 放弃` (vim).

**`VimDocument`** (`src/editor/document.ts`) — pure, TUI-free, unit-tested:

```ts
class VimDocument {
  lines: string[]; cursor: { line, col }; mode: "normal"|"insert"|"visual";
  visualAnchor: Cursor | null; register: string | null; dirty: boolean;
  constructor(text = "");
  getText(): string;  setText(text): void;  markSaved(): void;
  moveLeft/Right/Down/Up(count = 1);  lineStart();  firstNonBlank();  lineEnd();
  gotoLine(line: number /* 1-based */);
  nextWord();  prevWord();  endOfWord();           // vim w/b/e, Unicode-aware
  pushUndo();  undo();  redo();                    // stack cap MAX_UNDO = 200
  insertText(text);  newLine();  backspace();  deleteForward();  deleteChar(count = 1);
  deleteLine(count = 1);  yankLine(count = 1);  pasteAfter();  pasteBefore();
  startVisual();  cancelVisual();  selection(): Selection | null;  selectedText(): string;
  deleteSelection();  yankSelection();
}
```

`dirty` is computed as drift from `savedText` (the last content the caller persisted via `markSaved()`), so undo back to the saved baseline clears it.

**Mouse protocol** (`src/editor/mouse.ts`) — SGR: `parseSgrMouse(seq): SgrMouseEvent | undefined`; enable/disable via `\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h` / `\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l`. Events: `{ kind: "press"|"drag"|"release"|"wheel", button: "left"|"middle"|"right"|"none", x, y, shift, ctrl, alt, delta }` (x/y 1-based terminal cells; delta `-1` up / `1` down).

**Chat sidebar** (`src/editor/chat.ts`) — contract only: `ChatMessage { role: "user"|"assistant"; text }` and `ChatApi { send(text); subscribe(listener): () => void }`, wired in `extension.ts` to `api.sendUserMessage` and the `message_end` event (local echo deduped within a 3 s window; pending bubble replaced on reply).

## Web GUI

React 18 + Vite 6 + CodeMirror 6 + Cytoscape, all inside the root package (no separate `web/package.json`). Tab shell without a router library (`App.tsx`, `useState<View>` + per-view fade-in; pages stay mounted, `display:none` keeps streaming state). Three pages:

- **写作 (Write)** — `WritePage`, "深夜书房" three-column desk:
  - **书库 (library)** — collapsible 56 px icon rail / 200–340 px drag-resize chapter sidebar (books + numbered chapters, 新建章节/新建书/导入/导出 zip, rename/delete inline). Collapse state persisted in `localStorage` (`pi-writer:library-collapsed`).
  - **纸张 (paper)** — the draft is **always visible**: chapter-title header (20 px) + full-screen-edit button (Alt+E) + CodeMirror 6 editor (`@codemirror/lang-markdown`, optional vim, hidden gutter, amber caret/selection) on an elevated "paper" card, autosaving 800 ms after edits (`putDraft`, status machine `loading → saved → dirty → saving → save-error`, `draft_changed` multi-window conflict handling).
  - **AI 伙伴 (companion)** — 380 px right panel with **对话 / 批注** tabs (both stay mounted so scroll & input state survive tab switches):
    - 对话: `InputBar` (Ctrl+Enter send, auto-growing textarea), record-style messages (markdown via marked 18, HTML escaped), thinking fold, tool cards, branch bar, optimistic-bubble FIFO dedupe, SSE `session_changed` re-sync with generation guard.
    - 批注: select text in the draft (auto-switches to the tab) → AI suggestion → apply (replace/insert)/undo/follow-up, history list.
  - Preview cards (AI edit diffs) are anchored to the reply, keyed by a stable `id` (no array indexes), and **persisted server-side** via `GET/PUT /api/cards` (`sessions/<slug>/<id>.cards.json` — shared across windows/restarts, pre-fetched on book open).
- **世界书 (World)** — `WorldPage`, two views over `world.json`, switched with slide transitions (both stay mounted):
  - **列表 (list)** — `WorldTree` (grouped 人物/世界/时间线/大纲, parent nesting, cycle-guarded) + `EntryForm` (title, status, keys, chapter multi-select, parent, active toggle, body) + `EntryCard` (wiki-style viewer: image carousel with 主图 avatar, thumbnail strip, relations list with jump/★) + `NoticePanel` (1000 字, injection switch) + `StorylinePanel` (statuses 待办/进行中/完成/搁置; one in-progress demotes others) + `TimelinePanel` + `ConstraintsPanel` (800 字 each, style sample 500 字).
  - **关系图 (graph)** — Cytoscape: circular avatar nodes (entry `avatar` or generated letter disc), type colors, type filters, link mode (two taps create a relation), emphasized/thick edges, arrow directions, right-click node menu (重命名/编辑正文/断开所有连线/删除节点) and edge menu, **undo** (button or Ctrl+Z, `MAX_UNDO = 50`), debounced 800 ms autosave, layout+viewport persisted per book in `localStorage` (`pi-writer:graph-layout:<slug>`, `pi-writer:graph-viewport:<slug>`), missing/overlapping nodes self-heal.
  - Multi-window: `world_changed` SSE — own echo (<1 s) skipped; dirty → conflict notice `世界书已在其他窗口被修改,保存将覆盖`; clean → reload.
- **设置 (Settings)** — `SettingsPage`: 主题 (three themes of the 深夜书房 design language — 深夜书房 night (dark, default) / 纸上书房 paper (light) / 羊皮灯下 parchment (warm), applied via `data-theme` + localStorage, 26 color tokens fully overridden per theme, WCAG-checked by tests), 模型 (grouped `<select>` by provider, auto-fallback `当前模型已不可用,已自动切换到 …`), 思考级别 (`off … max`), 世界书注入 toggles (Notice / storyline enabled), 模型提供商 (`ProviderList`: search, configured/env/未配置 tags, inline key input — keys stored in `~/.pi/writer/agent/auth.json`; OAuth providers listed as `支持订阅登录(暂未支持)`).

State: `web/src/store.ts` — session reducer (`processAgentEvent`): `message_start` (user/assistant only), `message_update` (text_delta/thinking_delta), `tool_execution_start/end`, `message_end`, `turn_start`/`agent_settled` (isStreaming). `web/src/workspace.ts` — workspace reducer + pure helpers (`applyTextEdit`, `undoAppliedEdit`, `selectionStillMatches`, `resolveSaveOutcome`, `formatAnnotationPrompt`, `latestAssistantAfter`).

API client (`web/src/api/client.ts`): same-origin relative paths; methods `getBooks/createBook/getBook/exportBook/importBook/uploadImage/deleteImage/deleteBook/createChapter/patchChapter/switchSession/getSession/sendChat/abort/getModels/setModel/setThinking/getProviders/setProviderApiKey/deleteProvider/getWorld/putWorld/getDraft/putDraft/getCards/putCards` + `subscribeEvents(onEvent, onOpen?)` (EventSource with auto-reconnect). `getDraft` maps 404 → `""`; `friendlyError` maps 404/401/403/network errors to Chinese hints.

## Stage mode (multi-agent co-performance, experimental)

A multi-agent demo on the `stage-demo` branch: a **director** agent plans the scene with you
(maintains the world-book, writes a structured script via the `stage_script` tool), **actor**
agents (peer characters on a shared stage, not sub-agents) improvise under the script, and a
**writer** agent turns the stage record into prose at curtain close. Users step performances
with `/next`; OOC detection and intervention are human-driven (feedback → director revision →
replay).

Run (interactive CLI):

```bash
npx tsx src/cli.ts --stage [--book <slug>] [--model <pattern>] [--thinking <level>]
```

Stage commands:

| Command | Description |
|---|---|
| `/next` | Step one turn (step mode; a no-op while a turn is running — wait for the line) |
| `/auto` | Toggle continuous performance |
| `/force <角色>` | Force the next turn to a character |
| `/retry [说明]` | Replay the last entry with the same actor |
| `/fix <序号> <反馈>` | Feedback packet → director revises the script → replay from that entry |
| `/revise k=v ...` | Patch the script (min=/max=/wrap=/setting=/goal=/tone=/beats=…/actor:<id>.<field>=) |
| `/wrap [N]` | Inject the wrap-up hint (close after ~N lines) |
| `/cut` | Close the scene immediately |
| `/thoughts <1|2|3>` | Writer thought-chain visibility (1 none / 2 director distillation / 3 raw) |
| `/stage` `/script` `/cast` `/mode` | Print transcript / script / cast / director mode |

**Agent roles & one-scene workflow**

| Role | Responsibilities |
|---|---|
| **导演 Director** | Discusses the story with you → maintains the world-book (`world_update`) → outputs a structured script via `stage_script` (definition: cast/inject/rules; text: shared + perActor) → at curtain close reads every actor's thought chain and writes the distilled inner life back into the world-book. Three-mode state machine: 讨论 discussion (pre-scene) → 剧本 scripting (writing) → 导演 directing (during performance; the stage view is injected into its context — you can chat with the director mid-scene and it may fine-tune the script via stage_revise). |
| **演员 Actors** | One headless session per role (peers — not director sub-agents). First-person thinking chain (kept out of the transcript). Context per turn: world-book injection block + stage slice + script lines + live counter block. Action-first, only-self (never acts for others); output `<pass>` when nothing to say. Roles assigned by the director's cast table (pool slots). |
| **编剧 Writer** | Woken at curtain close. Input = stage transcript + script state + world-book (already updated by the director) + optional thought chains (`/thoughts 1|2|3`). Output prose → `draft/<chapter>.md`; style baseline from the book's style sample. |

One-scene lifecycle: **讨论** (you give the director a story brief) → **剧本** (director `world_update` creates characters/scene → `stage_script` opens the scene; casting validated, actor sessions created lazily) → **演出** (you step with `/next` or `/auto`; actors rotate, narrator interjects every 4 turns; pass fallbacks: 2 consecutive passes warn + force speak, all-silent closes; mid-scene chat goes to the **director** (stage view injected; it may stage_revise); `/revise` takes effect next turn; `/fix` = feedback → director revision → replay) → **收尾** (`/wrap` injects the wrap-up hint; scene closes at minLines) → **收幕** (director reads all thought chains → `world_update` writes back distilled inner life → writer produces prose). Artifacts: `stage/*.jsonl` transcript + script vN + `world.json` write-back + `draft/<chapter>.md`.

Web endpoints (frontend stage page shipped 2026-08-10, four top-level views:

**舞台** (default; pre-performance director room / live stage) · **编辑** (draft + writer
agent tabs) · **世界书** · **设置**):

- `GET /api/stage/:slug` — stage snapshot (sceneId/phase/mode/script/cast/transcript/counts
  + `avatars` map: character name → world-book avatar file, fallback = first char + hue)
- `POST /api/stage/:slug/command` — sync commands → 200 `{ text }`; long commands
  (`director`/`fix`/`cut`, contain model turns) → 202, result via the `stage_done` SSE event
- SSE (shared `/api/events` stream): `stage_entry` (new stage line), `stage_system`
  (scene open/close/revise…), `stage_done` (long command finished)

Resident writer (edit agent, `src/web/writer-host.ts`; one `SessionHost` per book, session
file `sessions/<slug>/writer.jsonl`, independent from the curtain-close writer):

- `GET /api/writer/:slug` — writer session state (read-only; empty state until first chat)
- `POST /api/writer/:slug/chat` `{ text, chapterFile? }` → 202; messages/tool events arrive
  as `writer_event { slug, event }` on the shared SSE stream (inner event is the same shape
  as the main session's — the frontend reuses `processAgentEvent` verbatim)
- `POST /api/writer/:slug/abort` — abort the in-flight generation
- Context injection per turn: current chapter draft + world-book entries + style sample
- Edit confirmation (frontend-only): writer's `write`/`edit` land immediately; the 批注 tab
  shows a confirm queue (diff card) — 确认 archives, 回退 restores the pre-edit text via PUT

Implementation: `src/stage/` (orchestrator/assembler/script-store/stage-store/cast/counters/CLI)
+ `src/web/stage-host.ts` (per-book lazy orchestrator registry, wired via
`WriterServerOptions.stageHost`); design doc
`docs/superpowers/specs/2026-08-09-stage-demo-design.md` (§1–§16, gitignored); the
`stage-scripting` skill documents the script contract. **Experimental**: one book is active
in exactly one entry (CLI or web), scene state is in-memory (lost on restart), and the stage
cost baseline is ≈ ¥0.10–0.14 per scene on deepseek-v4-flash.

## Electron shell

`electron/main.ts` — on `app.whenReady()`: `loadServerBundle()` imports `../web/server.cjs` (relative to `dist/electron/main.cjs`; falls back to `mod.default` for bun's `__toCommonJS` CJS export shape) and calls `startWebServer({ port: 8811, noBrowser: true, electron: true })` **in-process**. `createWindow` → `BrowserWindow` 1280×800, `contextIsolation: true`, `nodeIntegration: false`, preload probed from `dist/electron/preload.js` or `preload.js`. External links → `shell.openExternal` + `action: "deny"`. On window close: `server.stop()` + `app.quit()`. `preload.ts` is a placeholder (stage-1 has no IPC — the renderer talks HTTP to `127.0.0.1` only).

## Security

- The web server binds **`127.0.0.1`** and rejects requests whose `Host` is not a loopback name (`127.0.0.1` / `localhost` / `::1`, IPv6 zone ids stripped) — blocks DNS-rebinding attacks; `Origin` and `Sec-Fetch-Site` (`same-origin`/`same-site`/`none`) are additionally checked; headerless local requests (curl, scripts) pass. **Optional token auth**: set `PI_WRITER_TOKEN` to require `Authorization: Bearer <token>` or the `pi_writer_token` cookie on every `/api` request (401 `unauthorized` without it) — intended for exposing the port to other devices.
- The agent's file tools are **confined to the book directory** (`tool-guard.ts`): absolute paths, drive letters, `~` expansion, and `../` traversal are rejected (400 `bad_path`), so the model cannot read sensitive files such as `agent/auth.json` (provider API keys). `skills/` is read-only.
- Imported zips are re-validated entry-by-entry (path safety, duplicates, ≤ 2000 entries, ≤ 50 MB, `book.json` sanity) before any write.
- Frontend markdown rendering escapes raw HTML (XSS); links open with `rel="noopener noreferrer"`.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_WRITER_DIR` | `~/.pi/writer` | Writer data root (books, agent config, sessions). |
| `PI_WRITER_AGENT_DIR` | `~/.pi/writer/agent` | Agent config dir (auth, models, settings, extensions, skills). |
| `PI_WRITER_TOKEN` | unset | Optional bearer token for `/api` requests (see Security). |
| `PI_WRITER_SKILLS_DIR` | exe-side / source tree | Override the bundled skills directory (Android shell injection). |
| `PI_WRITER_WEB_DIR` | exe-side / source tree | Override the web/dist static directory (Android shell injection). |
| `PI_WRITER_NO_SPAWN_TOOLS` | unset | Web mode: drop `grep`/`find` (mobile environments where spawning fails). |

Limits (constants): HTTP body 1 MB · image upload 5 MB (png/jpeg/webp/gif) · zip 50 MB / 2000 entries / 100 MB uncompressed · `MAX_ENTRY_IMAGES` 9 · Notice 1000 字 · constraint 800 字 · style sample 500 字 · context budget 2000 tokens · editor undo stack 200 · graph undo stack 50 · SSE ping 30 s · draft autosave 800 ms.

## Development

```bash
# Run the TUI or web server directly from source
npx tsx src/cli.ts --book my-novel
npx tsx src/cli.ts --web --no-browser          # terminal 1: API server on 8811
cd web && npx vite dev                          # terminal 2: frontend with HMR (proxies /api → 8811)

# Type check (temporary config until the monorepo base lands)
npx tsc -p tsconfig.tmp.json                    # src + vendor + electron
npx tsc -p web/tsconfig.json                    # web frontend

# Tests (temporary vitest config; vitest.config.ts needs the missing ../../vitest.base.ts)
npx vitest run --config vitest.tmp.config.ts

# Lint (needs @biomejs/biome installed; no biome config in repo)
npx @biomejs/biome check

# Bundle the TUI single-file executable (needs bun) -> release/pi-writer.exe
npm run bundle

# Build the web bundle (esbuild, no bun needed) -> dist/web/server.cjs + dist/electron/* + web/dist
npm run build:web
npm run web                                   # run the built server (dist/web/server.cjs)

# Electron smoke test (build:electron needs bun; the smoke itself is plain node/electron)
npm run build:electron && npm run electron

# Desktop installer (after build:web) -> release/electron/pi-writer-web-<version>.exe
npx electron-builder --win nsis
```

Build pipeline (`scripts/web-build.mjs`, esbuild, no bun required):
1. `esbuild src/web.ts --bundle --platform=node --format=cjs` → `dist/web/server.cjs` (single file, zero external requires beyond `node:`).
2. `esbuild electron/main.ts` + `electron/preload.ts` → `dist/electron/main.cjs` / `dist/electron/preload.js` (`--external:electron*`).
3. `vite build` in `web/` → `web/dist`.
4. Checks: `checkSelfContained` (all static `require(...)` specifiers must be `node:`-prefixed or a known builtin), `smokeRequire` (requires the bundle, asserts `startWebServer` + `parseWebArgs` exports), `node --check`, `web/dist/index.html` existence.

Notes:
- The server bundle must be named `.cjs` — the package root is `"type": "module"`, and a `.js` CJS file would be parsed as ESM (`require is not defined`).
- bun bakes `import.meta.url` into source-URL constants; vendor loaders use `new URL(specifier, import.meta.url)` which survives CJS bundling.
- Electron takes exports from `import()` of the bundle's `default` (cjs-module-lexer cannot see bun `__toCommonJS` named exports); `loadServerBundle` keeps a named-export fallback.
- Test suite (`test/`): pure logic only — book-manager, config, editor (`VimDocument`, `parseEditArgs`, `parseSgrMouse`), extension, world-data (validation/migration/concurrency/backup-rollback), world-context (activation/budget), tools (`applyWorldUpdate`), server (endpoints/host-guard/static/multipart-busboy branches), session-host, graph-logic, relation-graph-dom, web-cli, mcp, stage.

## Development conventions

**Single source of truth — never duplicate these** (each was converged from 2–5 copies in 2026-08-10; new code must import them, duplicate copies are deleted on sight):

| Module | What it owns |
|---|---|
| `src/session-factory.ts` `createSessionRuntimeFactory` | Session assembly boilerplate (cli/web/stage share it) |
| `src/cjk.ts` `cjkCount`/`isCjkChar` | CJK char counting (code-point ranges; **no `\p{` regex** — Android has no full ICU) |
| `src/atomic-write.ts` `atomicWriteFile` | Atomic file writes (unique tmp + rename retry) |
| `src/session-text.ts` `chatTextOfMessage`/`chatThinkingOfMessage` | Session message text extraction (TUI + web) |
| `src/config.ts` `resolveSkillsDir` | Skills dir resolution (env → exe dir → source tree) |
| `src/world-data.ts` `WORLD_FILES`/`WORLD_FILE_TITLES` | World-book file layout table (world-tree imports it) |

**Hand-writing boundaries** — what is allowed to stay hand-rolled vs. what must use a library:

- **Allowed hand-written** (deliberately no HTTP framework): the route table (`server.ts` `Route[]` + `matchRoute`, ~30 lines; add an endpoint = one table row + one handler grouped by domain), SSE framing, static file serving + SPA fallback, CLI arg parsing, loopback Host/Origin guards, If-Match mtime conditional writes. Rule of thumb: logic ≤ ~50 lines with no security boundary → hand-roll OK.
- **Must use a library, never hand-roll**: multipart parsing → **busboy** (replaced a hand-written boundary parser in 2026-08-10; busboy 1.x is called as `busboy({ headers, limits })`, not `new`); zip pack/unpack → yazl/yauzl; JSON Schema → typebox (`Compile().Check()` for runtime validation).
- **Route-table ordering is load-bearing**: among entries with the same method and segment count, static segments (`mcp/raw`) must come before parameter segments (`mcp/:name`); matching receives `parts.slice(1)` (the `api` prefix is stripped).
- **New dependency flow**: `npm i <pkg>` (+ `@types/<pkg>`) → `tsc -p tsconfig.tmp.json` → **one behavior test per API call point** (each method/event/branch the code touches — type checking proves methods exist, it does not prove runtime behavior; event paths like `error`/`limit`/`close` need explicit cases) → `npm run build:web` (self-containment check rejects external requires) → consider Android (pure JS, bundleable).
- **Environment notes**: `tsc -p tsconfig.tmp.json` (`src/` must be 0 errors; vendor errors are pre-existing and ignored), tests via `npx vitest run --config vitest.tmp.config.ts` (640+ tests), production smoke via `env PI_WRITER_DIR=<tmp> node dist/web/server.cjs --no-browser --port 8899` with `node --input-type=module -e` + `fetch` (Git Bash curl mangles Chinese and maps `/tmp` differently than node).

## License

MIT

---

# 中文版

# pi-writer

基于 [pi](https://pi.dev) 框架的独立创意写作 agent，拥有三种面孔：**TUI**、**本地 Web GUI**(React)与 **Electron 壳**。它作为独立的 `pi-writer` 程序发布，不加载 pi 的 coding-agent 扩展、技能、设置与会话。

- 书/章节会话管理、组件化**世界书**(单一数据源 `world.json`)、人物关系图与面向小说/散文的写作工具。
- 核心 pi 包全部 vendor 在 `vendor/` 下——不依赖 `@earendil-works` npm 依赖。
- 所有状态存于 `~/.pi/writer`(书、会话、agent 配置),不使用 `~/.pi/agent`。

## 功能特性

- **三端共用一份数据**——全屏 TUI、本地 Web GUI(默认 `127.0.0.1:8811`)与 Electron 桌面壳;三端共享 `~/.pi/writer`,可开不同端口并行运行。
- **章节即会话**——每章是一个独立的 pi 会话文件,各自拥有上下文、压缩与分支。
- **组件化世界书**——`world.json` 承载类型化条目(人物/世界/时间线/大纲)、关系网、写作约束、文风采样、Notice、发展线与时间线事件;`.writer/*.md` 视图为自动生成的导出。
- **上下文激活引擎**——按章生成"背景包":只有 `keys` 命中草稿/最近消息的条目才会被注入,并受 token 预算约束。
- **内置编辑器**——TUI 内的全屏编辑器(默认纯文本模式,可 `--vim` 启用 vim 模式),支持撤销/重做、鼠标操作与聊天侧栏。
- **Web GUI**——「深夜书房」设计:三栏写作台(**书库** | **纸张**(正文常驻)| **AI 伙伴**(对话/批注面板)),CodeMirror 6 编辑器(vim 模式可选)、选区 → AI 建议 → 应用/撤回批注、世界书列表/关系图、三套主题(深夜书房/纸上书房/羊皮灯下)、滑动/淡入过渡动画、设置页。
- **写作工具**——`word_count`(CJK 感知的字数统计)与 `world_update`(14 种结构化世界书变更操作);模型无 `bash`。

## 核心概念

| 概念 | 含义 |
|------|------|
| **书 (Book)** | 工作区目录(`~/.pi/writer/books/<slug>/`),含 `book.json`(索引)、`world.json`、`outline.md`、`draft/`、`notes/` 与生成的 `.writer/` markdown 视图;`images/` 在首次上传图片时创建。 |
| **章节 (Chapter)** | 独立的 pi 会话文件(`~/.pi/writer/sessions/<slug>/chXX.jsonl`)与对应的草稿文件(`draft/chXX.md`)。每章有独立的 `/tree`、压缩与分支。 |
| **记忆 (Memory)** | `books/<slug>/memory.md` —— 书级跨章节记忆(约 1500 token 预算)。内容在每章开写前注入上下文包;章节收尾时 agent 自主更新(最新在上,装不下压缩最旧)。是唯一允许写在 `draft/` 之外的交付物。 |
| **世界书 (World-book)** | 组件化的世界存储(`books/<slug>/world.json`):类型化条目、关系、约束、文风采样、Notice、发展线、时间线事件。`.writer/` 中的 markdown 视图由它生成(仅导出,文件头明确提示请走界面编辑)。 |
| **关系图 (Relation graph)** | Web GUI 中基于 Cytoscape 的人物/世界关系图:圆形头像节点(条目 `avatar` 图片,或自动生成的首字字母头像)、按书持久化的节点布局与视口、右键快速编辑、连线模式、撤销。 |
| **技能 (Skills)** | 以 pi 技能形式打包的 Markdown 方法论:`outline`、`critique`、`revise`、`stage-scripting`(后者供 stage 导演使用,也可作 `/skill:stage-scripting` 调用)。输入 `/skill:name` 会内联展开技能(TUI 与 web 聊天皆然);`/` 命令菜单不列出技能命令。 |

## 独立身份

pi-writer 的全部配置都在 `~/.pi/writer` 下:

- `~/.pi/writer/agent/` — 认证(`auth.json`)、模型、设置、扩展、技能、主题、包、快捷键
- `~/.pi/writer/books/` — 书的工作区
- `~/.pi/writer/sessions/` — 章节会话记录(位于书工作区之外,"避免散文 grep 被会话 JSONL 干扰")

它从不读取 `~/.pi/agent`(pi 的 coding-agent 配置)。在 pi-writer 内用 `/login` 认证一次,或设置 `ANTHROPIC_API_KEY` 等 provider 环境变量。

## 环境要求

- Node.js >= 18.20.4(Android nodejs-mobile 为 18.20.4)
- 可选:[bun](https://bun.sh),用于 `npm run bundle`(TUI 单文件可执行程序及其跨平台交叉编译)与 `npm run build:electron`(Electron 主进程/preload 用 bun 打包);`npm run build:web`(esbuild 服务端 + vite 前端)不需要 bun。

## 快速开始

本仓库是独立检出(pi 核心包 vendor 在 `vendor/` 下);包根即仓库根。

```bash
# 安装依赖
npm install

# TUI:新建并打开一本书
npx tsx src/cli.ts --new-book "我的小说"

# TUI:打开已有书
npx tsx src/cli.ts --book my-novel

# TUI:非交互打印模式
npx tsx src/cli.ts -p "Outline a short story about autumn rain"

# Web GUI:启动本地服务并打开浏览器(默认 127.0.0.1:8811)
npx tsx src/cli.ts --web [--book my-novel]

# Web GUI:仅起服务不拉浏览器(可配合 `cd web && npx vite dev` 做热更新)
npx tsx src/cli.ts --web --no-browser

# Web GUI:Electron 壳
npx tsx src/cli.ts --web --electron

# 版本号
npx tsx src/cli.ts --version
```

## CLI 参数参考

参数解析位于 `src/cli.ts`(`parseArgs`,手写循环,不依赖参数库)与 `src/web.ts`(`parseWebArgs`)。

| 参数 | 类型/默认 | 行为 |
|------|-----------|------|
| `--web` | 布尔 | 进入 web 模式(路由到 `parseWebArgs` + `startWebServer`,配合 `--electron` 则启动 Electron 壳)。 |
| `--port <N>` | 整数,仅 web | Web 服务端口(默认 **8811**),`parseWebArgs` 中校验 1–65535。 |
| `--no-browser` | 布尔,仅 web | 只起服务,不拉浏览器。 |
| `--electron` | 布尔,仅 web | 启动 Electron 壳(`dist/electron/main.cjs`);服务由 Electron 主进程进程内启动。 |
| `--book`、`-b <slug>` | 字符串 | 打开一本书;不存在则创建(以 slug 为标题)。同时透传给 web 模式。 |
| `--new-book`、`--title <标题>` | 字符串 | 新建书(中文标题经 `slugify` 保留)并打开。 |
| `--chapter <选择器>` | 字符串 | 章节选择器:1 基索引、id(`ch01`)、文件名或 `文件名 + ".jsonl"`(`resolveChapter`)。不透传 web。 |
| `--model`、`-m <pattern>` | 字符串 | 模型匹配,经 `resolveCliModel` 解析;透传 web。 |
| `--thinking <level>` | 字符串 | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 之一;透传 web。 |
| `-p`、`--print [prompt]` | 布尔 | 非交互打印模式:执行一次提示、打印回复后退出。 |
| `--verbose` | 布尔 | 强制输出详细启动诊断。 |
| `-c`、`--continue` | 布尔 | 接受但无操作——默认启动已续接最近一本书的当前章节。 |
| `-v`、`--version` | 布尔 | 打印 `VERSION`。 |
| `-h`、`--help` | 布尔 | 打印帮助。 |
| 位置参数 | 字符串 | 首个非 `-` 参数作为初始提示词。 |

书解析顺序:`--new-book` → `--book` → 最近更新的书 → `createBook("未命名")`。章节解析:`--chapter` → `book.currentChapterFile` → `book.chapters[0]` → `addChapter(slug, "第一章")`。

TUI 工具清单(`src/cli.ts` 中配置):`read`、`bash`、`write`、`edit`、`grep`、`find`、`ls`、`word_count`、`world_update`、`world_find`。web 模式为不含 `bash` 的子集:`read`、`write`、`edit`、`grep`、`find`、`ls`、`word_count`、`world_update`、`world_find`。系统提示词在 TUI 中告知模型**「你可以使用 `bash`(工作目录为书目录)」**(工具列表中确实有 bash);web 模式完全移除并告知「你**没有** `bash`」。

## TUI 命令

由内联扩展 `writerExtension`(`src/extension.ts`)注册:

| 命令 | 说明 |
|------|------|
| `/chapters` | 列出本书所有章节并切换。 |
| `/new-chapter [标题]` | 新建一章并切换。默认标题 `第 N 章`,默认标签 `草稿`。 |
| `/rename-chapter 新标题 [新标签]` | 重命名/重设当前章节标签。 |
| `/world` | 浏览世界书(人物/世界/时间线/大纲);选中条目后可编辑。 |
| `/notice` | 查看 Notice(当前剧情指引)。 |
| `/storyline` | 查看发展线并标记节点完成(`advance_storyline`)。 |
| `/constraints` | 查看启用的写作约束(只读;编辑请去 web)。 |
| `/relations` | 以文本查看关系网(编辑请去 web 关系图)。 |
| `/new-book [标题]` | 新建一本书并切换到它的第一章。 |
| `/book` | 列出所有书,选书后再选章节切换。 |
| `/edit [路径]` | 打开内置全屏编辑器(默认 `draft/<章节id>.md`;`--vim` 启用 vim 模式;`--force` 绕过 `.writer/` 与 `outline.md` 只读保护)。 |
| `/skill:name` | 调用打包的写作技能(`outline`、`critique`、`revise`、`stage-scripting`)。注意:技能命令不在 `/` 命令菜单中列出(`setEnableSkillCommands(false)`),但输入 `/skill:name` 仍会展开——包括 web 聊天。 |

TUI 界面元素:状态栏(`✒ 《书名》 · ch01 · 第一章 [标签]`)、`writer-info` 组件(编辑区下方信息栏,含字数)、常驻 `draft-panel` 组件(侧栏编辑器,800 ms 自动保存)、页脚(`esc 中断 · / 命令 · /edit 编辑器 · /world 世界书`)与品牌化启动头(`✒ pi-writer` 字标,标语 `以笔为舟 · 一章一章，写就你的世界`)。

## Agent 工具

工具定义在 `src/tools.ts`(typebox schema,不手写 JSON Schema)。所有文件工具由 `src/tool-guard.ts`(`installToolPathGuard(bookDir, readOnlyDirs = [skillsDir])`)限制在书目录内;打包的 `skills/` 目录只读。

### `word_count`

对草稿文件或目录(递归 `*.md`)做精确字数统计。系统提示词要求 agent 写完/改完后调用它,禁止目测。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | 字符串(必填) | 文件或目录(相对书目录)。 |
| `modes` | `("cn_chars" \| "en_words" \| "sentences" \| "paragraphs" \| "all")[]` | 默认 `["all"]`。 |
| `target` | 数字 | 可选目标字数(主指标优先 cn_chars,其次 en_words);输出 `Target <n> <metric>: +delta (pct%)`。 |

统计规则:CJK 汉字按 `src/cjk.ts`(码点区间 `0x3400–0x4DBF`、`0x4E00–0x9FFF`、`0xF900–0xFAFF`);英文词用手写扫描(`src/tools.ts` `countEnglishWords`——ASCII + Latin-1 补充 + Latin Extended-A,撇号连接词如 `don't` 计一个词;**不用 `\p{L}` 正则,Android 无 full ICU**);句子按 `[.。!！?？]` 切分;段落按空行切分。输出每文件一行 `rel/path: N cn | N en | N 句 | N 段`,附 `Total:` 汇总。

### `world_update`

修改世界书的**唯一通道**(系统禁止对 `world.json` 使用 `edit`/`write`)。单个 `update` 参数——14 种操作的判别联合,由纯函数 `applyWorldUpdate(data, update): WorldData` 执行(克隆 → 变更 → `validateWorld`,违规抛 `WorldValidationError`)。服务端在每书一把的 promise 锁(`withWorldLock`)内完成读-改-写与原子落盘。

| 操作 | 必填参数 | 可选参数 | 语义/错误 |
|------|----------|----------|-----------|
| `upsert_entry` | `type`、`title` | `id`、`keys`、`chapters`、`status`、`parent`、`body`、`avatar`、`images` | 真 upsert:带 `id` 时补丁已有条目,查不到则**按该 id 新建**;不带 `id` 时按 `(type, title)` 匹配已有条目——存在则原地更新(id 保留),否则 `newId("entry")` 新建,status 默认 `active`。 |
| `delete_entry` | `id` | — | 仍被关系引用时拒绝(`条目 <id> 仍被关系引用,请先删除相关关系`);子条目 `parent` 重置为 null。 |
| `set_status` | `id`、`status` | — | 设置条目状态并刷新 `updatedAt`。 |
| `append_timeline` | `text` | `chapter` | 追加 `{ id: newId("evt"), chapter, text }`。 |
| `update_timeline` | `id` | `chapter`、`text` | 不存在 → `时间线事件不存在: <id>`。 |
| `delete_timeline` | `id` | — | 不存在 → `时间线事件不存在: <id>`。 |
| `update_notice` | `text` | — | 设置 Notice 文本 + `updatedAt`(上限 1000 字)。 |
| `advance_storyline` | `id`、`status` | `next` | 节点不存在则自动创建(`title: id`)。强制至多一个 `in-progress` 节点。 |
| `upsert_storyline_node` | `title` | `id`、`status`、`goal`、`next` | 新建(`newId("story")`,status `pending`)或补丁。 |
| `upsert_constraint` | `name`、`text` | `id`、`enabled` | 带 `id`:必须存在(`约束不存在: <id>`),name/text 总是覆盖。不带则新建(上限 800 字)。 |
| `delete_constraint` | `id` | — | 过滤;不存在不报错。 |
| `update_style_sample` | `text` | `source` | 设置 `{ text, source, updatedAt }`(上限 500 字)。 |
| `upsert_relation` | `from`、`to` | `id`、`type`、`label`、`emphasized`、`arrow` | 带 `id`:必须存在,`from`/`to` 总是覆盖。不带则新建(`newId("rel")`,`arrow` 默认 `"double"`)。拒绝悬空端点与自环。 |
| `delete_relation` | `id` | — | 过滤;不存在不报错。 |

`arrow` 枚举:`"none"`(无箭头)/ `"single"`(单向 from→to)/ `"double"`(双向)。

### MCP 外部工具

MCP(Model Context Protocol)服务器可扩展 agent 工具集(如网络搜索、浏览器)。配置在 `~/.pi/writer/agent/mcp.json`:

- **配置格式**:原生 `{ "servers": [...] }` 数组,或直接粘贴 Claude Code 格式——`mcpServers` 对象(按 `command`/`url`+`transportType` 自动推断传输类型;`directTools`/`disabled` 等专属字段处理);`imports: ["claude-code"]` 自动合并 `~/.claude.json` 的服务器(本地条目覆盖同名)。
- **传输类型**:`stdio`(本地命令)、`http`(Streamable HTTP,现行标准)、`sse`(旧版,兼容);需要 OAuth 授权的端点报错明确提示(授权流未实现)。
- **运行时**:意外断线自动重连(3s→30s 退避,成功重建会话);stdio 启动失败时错误信息携带进程 stderr 尾部;工具结果透传 resource 正文(20k 字符截断)与服务器上报的 `_meta.usage` token 统计。
- 设置页展示连接状态/工具数,并提供「直接编辑文件」——原样读写 mcp.json(表单表达不了的 `imports`/Claude 形状在此配置)。
- 已配置工具会注入 agent 系统提示(名称+单行描述)——工具可见性是动态的,不是硬编码清单。

API key(如 `TAVILY_API_KEY`)只存在于本地 `mcp.json`,绝不入库(`.gitignore` 已拦截 `**/mcp.json`)。

## 世界书数据模型(`world.json`)

Schema、校验、原子保存与 markdown 视图渲染都在 `src/world-data.ts`;`version` 是字面量 `1`(旧数据仅做字段级归一化,暂无版本迁移路径)。

```ts
interface WorldData {
  version: 1;
  entries: WorldEntry[];
  relations: WorldRelation[];
  constraints: WorldConstraint[];
  styleSample: StyleSample | null;
  notice: NoticeData;
  storyline: StorylineData;
  timeline: TimelineEvent[];
}
```

| 类型 | 字段 |
|------|------|
| `WorldEntry` | `id`、`type`(`"character" \| "world" \| "timeline" \| "outline"`)、`title`、`keys: string[]`(激活关键词)、`chapters: string[]`(空 = 每章都激活)、`status`(`"alive" \| "dead" \| "unknown" \| "active" \| "archived" \| "draft"`)、`active: boolean`、`parent: string \| null`、`tags: string[]`、`body`、`avatar: string \| null`、`images: string[]`(最多 **9** 张)、`updatedAt` |
| `WorldRelation` | `id`、`from`、`to`(条目 id)、`type`、`label`、`emphasized: boolean`、`arrow: "none" \| "single" \| "double"`(旧数据默认 `"double"`) |
| `WorldConstraint` | `id`、`name`、`text`(上限 **800** 字)、`enabled` |
| `StyleSample` | `text`(上限 **500** 字)、`source`、`updatedAt` |
| `NoticeData` | `text`(上限 **1000** 字)、`enabled`、`updatedAt` |
| `StoryNode` | `id`、`title`、`status`(`"pending" \| "in-progress" \| "done" \| "shelved"`)、`goal`、`next: string \| null` |
| `StorylineData` | `enabled`、`nodes: StoryNode[]`(至多一个 `in-progress`) |
| `TimelineEvent` | `id`、`chapter`、`text` |

图片引用必须匹配 `images/<单个文件名>`(`IMAGE_REF_RE`)——绝对路径、子目录、`..`、反斜杠形式一律拒绝。

校验要点(均抛 `WorldValidationError`,中文消息):id 重复、悬空 `parent`/关系端点、自为 parent、关系自环、非法枚举值、缺少 `notice`/`storyline` 段、文本超限、多个 in-progress 发展线节点。归一化:旧关系无 `arrow` 补 `"double"`;条目缺 `avatar`/`images` 补 `avatar: null, images: []`;非 null 的 avatar 不在 images 中时插入最前(并去重)。

**原子保存**(`saveWorld`):校验 → 旧文件复制为 `world.json.bak` → 写唯一临时文件 `world.json.tmp.<pid>.<随机>` → rename(最多重试 3 次,为 Windows EPERM 退避)→ 回读并校验落盘结果;失败则从 `.bak` 恢复并抛错。每次保存后 `writeWorldViews` 重新生成导出 markdown:`.writer/characters.md`(`# 人物档案`)、`.writer/world.md`(`# 世界设定`)、`.writer/timeline.md`(`# 时间线`)、`outline.md`(`# 大纲`)——文件头均为 `> 此文件为 world.json 的导出视图,编辑请走界面(web 世界书页 / TUI 命令)。`。

**迁移**:无 `world.json` 时,`ensureWorld` 执行 `migrateFromMarkdown`——四个旧 markdown 文件中的 `#`/`##`/`###` 标题成为条目(每个文件首个 `# ` 是容器,跳过);解析 `- parent:` / `- avatar:` / `- images:` 元数据行;自引用 parent 与未知 parent 直接丢弃。

## 上下文激活引擎(`src/world-context.ts`)

`buildChapterContext(data, { chapterId, draftText, recentUserMessages, budget })` 生成每章"背景包",以 `world-context` 自定义消息注入会话(`deliverAs: "nextTurn"`——随下一条用户消息进入,UI 不可见)。默认预算 `DEFAULT_CONTEXT_BUDGET = 2000` token;`estimateTokens`:CJK 每字 1 token,其余 `ceil(len / 4)`。

激活规则(`activatedEntryIds`):`active === true` 且(`chapters` 为空或含 `chapterId`)且至少一个非空 `keys` 是 `draftText` + 最近 2 条用户消息的子串。无 `keys` 的条目不激活。激活条目按类型优先级(`character` → `world` → `timeline` → `outline`)装入,首条无条件装入("至少一条相关设定"),超预算条目裁剪并在末尾标注 `(已裁剪 <n> 条,需要可 read world.json)`。

背景包结构:`【写作约束】`(启用的约束;超预算时先裁采样、保留约束)→ `【文风采样】`(含 `(来源: ...)`)→ `【世界书·本章相关】`(激活条目,`- <title>: <body>`)→ 尾部永不被裁:`【Notice】` 与 `【发展线】`(进行中节点的当前位置/目标/下一步)。

## 内置技能

| 技能 | 用途 |
|------|------|
| `outline` | 结构规划(三幕、英雄之旅、起承转合、单元剧)并以 `world_update upsert_entry` 写入 `type: "outline"` 世界书条目(`# 书名` / `Premise:` / `## Chapters` / `### N. <标题>` 含 `Promise:` / `Turn:` / `Cliff/open:`;首轮不超过约 12 章)。绝不直接写 `outline.md`——它是 `world.json` 的导出视图,会被再生成覆盖。 |
| `critique` | 不重写的结构化诊断:开场与承诺、场景结构、节奏、对话、声音与冗余、连贯性、show vs tell、收尾——每节一行结论 + 1–3 处带引文的具体问题 + 具体建议,最后给出 3 个最优先修复项。 |
| `revise` | 依据 critique 结果做外科手术式修改:每次 `edit` 只针对一个关注点,`old → new` 引用约定,绝不整章重写;每轮后用 `word_count` 校验。 |
| `stage-scripting` | 舞台区方法论:一幕的结构、选角规则与 `stage_script` 工具契约——`--stage` 模式的导演会话经 `read` 查阅;也可 `/skill:stage-scripting` 调用。 |

## 架构

### 分层总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│  三种前端                                                                │
│   TUI (pi-tui InteractiveMode)   Web GUI (React)   Electron 壳           │
└───────────────┬──────────────────────────┬───────────────────────────────┘
                │  src/cli.ts               │  HTTP REST + SSE (127.0.0.1)
                │  src/extension.ts         ▼
                │                    ┌──────────────────────┐
                │                    │ WriterServer         │  src/web/server.ts
                │                    │ 40 个 REST 端点 +     │
                │                    │ /api/events (SSE)    │
                │                    └──────────┬───────────┘
                ▼                               ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ 运行时 (pi-coding-agent) │◄────►│ SessionHost              │  src/web/session-host.ts
│ 会话管理、工具            │      │ 无头会话封装              │
│ (read/write/edit/grep/   │      │ sendMessage/abort/       │
│  find/ls + word_count +  │      │ switchSession/injectContext
│  world_update)           │      └──────────────────────────┘
└───────┬───────────┬──────┘
        │           │
        ▼           ▼
┌──────────────────────────────────────────────────────────┐
│ 数据层                                                    │
│  book-manager.ts  book.json 索引、章节、会话               │
│  world-data.ts    world.json schema/校验/原子保存          │
│                   + .writer/*.md 导出视图 + 迁移           │
│  world-context.ts 按章激活 + token 预算                    │
│  world-lock.ts    按书串行化读-改-写                       │
│  tool-guard.ts    工具路径限制在书目录内                   │
└──────────────────────────────────────────────────────────┘
```

### 目录结构

```
pi-writer/
├── package.json              # "type": "module";web 前端就在根包里(没有 web/package.json)
├── tsconfig.build.json       # extends ../../tsconfig.base.json(monorepo 根文件,本检出没有)
├── tsconfig.tmp.json         # 独立类型检查配置(src + vendor + electron)
├── vitest.config.ts          # extends ../../vitest.base.ts(同样缺失)
├── vitest.tmp.config.ts      # 独立测试配置(globals、node 环境、PI_OFFLINE=1)
├── scripts/
│   └── web-build.mjs         # web 打包编排(见"开发与构建")
├── skills/
│   ├── outline/SKILL.md      ├── critique/SKILL.md      └── revise/SKILL.md
├── vendor/                   # vendor 的 pi 核心包(monorepo main 分支,相对导入)
│   ├── pi-coding-agent/      #   含本地新增的 sidePanel widget 布局扩展
│   └── pi-ai/ pi-tui/ pi-agent-core/ pi-client/ pi-protocol/
├── src/
│   ├── cli.ts                # CLI 入口:parseArgs、TUI/打印/web 路由
│   ├── web.ts                # web 子命令:parseWebArgs / startWebServer / runMain
│   ├── config.ts             # 路径(getWriterDir/getAgentDir/getBooksDir)、slugify、VERSION
│   ├── book-manager.ts       # 书/章节索引(book.json)、会话布局
│   ├── world-data.ts         # world.json schema/校验/原子保存/md 视图/迁移
│   ├── world-context.ts      # 激活引擎(章节过滤 → 关键词匹配 → 预算)
│   ├── world-lock.ts         # 按书串行化 world_update 的 promise 队列
│   ├── world-tree.ts         # 旧式 markdown 世界书树(TUI /world 选择器)
│   ├── tool-guard.ts         # installToolPathGuard:工具限制在书目录内
│   ├── tools.ts              # word_count + world_update(typebox schema、applyWorldUpdate)
│   ├── extension.ts          # 内联 writerExtension:命令、状态栏、组件
│   ├── prompt.ts             # WRITER_SYSTEM_PROMPT
│   ├── startup-header.ts     # pi-writer 品牌化启动头
│   ├── draft-panel.ts        # 常驻侧栏草稿编辑器(800 ms 自动保存)
│   ├── writer-ui.ts          # WriterUiState、WriterInfoBar、WriterFooter、countWriting
│   ├── writer-theme.ts       # buildWriterTheme():暖色"墨与纸"配色
│   ├── session-factory.ts    # 会话装配唯一入口:createSessionRuntimeFactory(cli/web/stage 共用)
│   ├── cjk.ts                # CJK 计数唯一实现(码点范围,不用 \p{ 正则)
│   ├── atomic-write.ts       # 原子写唯一实现(唯一 tmp + rename 重试)
│   ├── session-text.ts       # 会话消息文本提取(TUI/web 共用)
│   ├── index.ts              # 公共 API 导出
│   ├── mcp/                  # MCP 配置(typebox)/连接管理(SDK)/工具适配
│   ├── stage/                # 舞台区:导演/演员/编剧多 agent 共演 demo
│   ├── editor/               # 内置编辑器(默认纯文本,vim 可选)
│   │   ├── document.ts       #   VimDocument:纯 vim 文档模型(单测覆盖)
│   │   ├── vim-file-editor.ts#   全屏 TUI 组件
│   │   ├── mouse.ts          #   SGR 鼠标协议解析
│   │   ├── args.ts           #   parseEditArgs(--vim / --force / 路径)
│   │   ├── chat.ts           #   ChatApi / ChatMessage 契约
│   │   └── index.ts          #   openFileEditor 入口
│   └── web/
│       ├── server.ts         # WriterServer:Node http,40 个 REST 端点(路由表驱动)
│       │                     #   + SSE + 静态服务;multipart 用 busboy
│       ├── session-host.ts   # SessionHost:无头会话封装
│       ├── provider-auth.ts  # ProviderAuthKind、ProviderListItem、key 登录
│       ├── file-watcher.ts   # WorldWatcher:world.json + draft 外部变更轮询
│       ├── stage-host.ts     # 舞台区 web 宿主(每书一个编排器,惰性创建)
│       └── book-zip.ts       # 书 zip 导入/导出(限制:50 MB / 2000 条目)
├── web/
│   ├── index.html            # lang="zh-CN"
│   ├── vite.config.ts        # dev 端口 5173,/api 代理 → 127.0.0.1:8811,产物 dist
│   ├── public/fonts/         # HarmonyOS Sans SC(Regular/Medium/Bold)
│   └── src/
│       ├── main.tsx / App.tsx            # 标签页壳(write/world/settings),无路由库
│       ├── pages/            # WritePage、WorldPage、SettingsPage
│       ├── components/       # DraftWorkspace、ChapterSidebar、InputBar、MessageList、
│       │                     #   RelationGraph、WorldTree、EntryForm、EntryCard、
│       │                     #   AnnotationPanel/History、FullScreenEditor、ProviderList…
│       ├── editor/           # CodeMirrorBox(CodeMirror 6 + markdown + 可选 vim)
│       ├── api/              # client.ts(API 客户端 + EventSource SSE)、types.ts
│       ├── store.ts          # 会话 reducer(processAgentEvent)
│       ├── workspace.ts      # 工作区 reducer + 纯函数(批注/应用/撤回)
│       ├── workspace-binding.ts、graph-logic.ts、markdown.ts、themes.ts、theme.ts、
│       ├── errors.ts、motion.ts、id.ts、file-input.ts、Icons.tsx
│       └── styles.css        # A3 极简设计变量,3 套主题(墨与纸/纸白/羊皮纸)
├── electron/
│   ├── main.ts               # 进程内起服务(loadServerBundle)+ BrowserWindow
│   └── preload.ts            # 占位(暂无 contextBridge——仅 HTTP)
├── dist/                     # 构建产物:web/server.cjs、electron/main.cjs、preload.js
├── release/                  # bundle 产物(pi-writer.exe)、Electron 安装包产物
└── test/                     # vitest 测试(globals: true,仅纯逻辑)
```

## 关键 API

### 公共包 API(`src/index.ts`)

```ts
// book-manager.ts
addChapter(slug, title, label?): Promise<ChapterRef>        // 默认标题 第 N 章,标签 草稿
createBook(title): Promise<BookIndex>                        // slug 去重:-2、-3…
ensureBook(slug, displayTitle?): Promise<BookIndex>
initChapterFile(absPath, cwd): Promise<void>                 // 写 {type:"session",version:3,id,timestamp,cwd}
listBooks(): Promise<BookListEntry[]>                        // 按 updatedAt 降序
loadBook(slug): Promise<BookIndex | null>
resolveChapter(index, selector): ChapterRef | undefined      // 1 基索引 | id | 文件 | 文件+".jsonl"
setCurrentChapter(slug, file): Promise<BookIndex>
updateChapter(slug, selector, patch: {title?, label?}): Promise<BookIndex>
getBookSessionsDir(slug): string   getChapterSessionsPath(slug, file): string

// config.ts
APP_NAME、APP_TITLE、VERSION
getWriterDir(): string   getAgentDir(): string   getBooksDir(): string
getBookDir(slug)   getBookIndexPath(slug)   getChapterFile(slug, fileName)
slugify(input): string   // 保留 CJK:[a-z0-9\u4e00-\u9fff] 保留,其余 → "-",空 → "untitled"

// 其他
writerExtension            // 内联 pi 扩展(TUI 命令 + 状态栏 + 组件)
WRITER_SYSTEM_PROMPT       // 写作系统提示词
wordCountTool              // defineTool("word_count", …)
```

### REST API(`src/web/server.ts` — `WriterServer`)

基址 `http://127.0.0.1:8811`。错误契约:统一 `{ "error": { "code", "message" } }`,code 取值 `forbidden` / `bad_request` / `bad_path` / `not_found` / `payload_too_large` / `too_large` / `error`。JSON 请求体超 1 MB → 413;JSON 非法 → 400。

| 方法 | 路径 | 参数(未注明均为 body) | 成功 | 错误 |
|------|------|------------------------|------|------|
| GET | `/api/events` | — | SSE 事件流(见下) | 403 守卫 |
| GET | `/api/books` | — | `{ books }` | — |
| POST | `/api/books` | `title`(必填) | `{ book }` | 400 缺字段 |
| GET | `/api/session/tree` | — | `{ currentLeafId, branches[] }`(分支栏数据) | — |
| GET | `/api/session` | — | `SessionStateSnapshot`(见 SessionHost) | — |
| POST | `/api/chat` | `text`(必填) | **202** `{ ok: true }`(异步;输出走 SSE) | 400 缺字段 |
| POST | `/api/messages/retract` | `entryId`、`replacement?` | `{ ok: true }` + SSE `messages_retracted` | 400 非最新用户消息/流式中 |
| POST | `/api/messages/branch` | `entryId` | `{ ok: true }` + SSE `messages_retracted` | 400 未知/非消息 |
| POST | `/api/messages/navigate` | `entryId` | `{ ok: true }` + SSE `messages_retracted` | 400 未知/流式中 |
| POST | `/api/abort` | — | `{ ok: true }` | — |
| GET | `/api/models` | — | `{ models, current, thinking }` | — |
| POST | `/api/model` | `model`(必填) | `{ ok: true }` | 400 缺字段 |
| POST | `/api/thinking` | `level`(必填) | `{ ok: true }` | 400 缺字段 |
| GET | `/api/providers` | — | `{ providers: ProviderListItem[] }` | — |
| POST | `/api/providers/:id/apikey` | `key`(必填) | `{ ok: true }` | 404 未知 id;400 非 api-key 认证;400 `ProviderAuthError` |
| DELETE | `/api/providers/:id` | — | `{ ok: true }` | 404 未知 id |
| GET | `/api/world` | — | `{ world }`(完整 world.json) | 404 未打开书 |
| PUT | `/api/world` | `world`(必填对象) | `{ ok: true }` + SSE `world_changed` | 400 缺失 / `WorldValidationError` |
| GET | `/api/draft` | 查询 `file`(必填)、`slug`(可选) | `{ text }` | 400 坏路径;404 不存在 |
| PUT | `/api/draft` | `file`、`text`(必填)、`slug`(可选) | `{ ok: true }` + SSE `draft_changed` | 400 坏路径 |
| GET | `/api/cards` | 查询 `slug`、`chapterFile`(必填) | `{ cards }`(文件缺失/损坏 → 空列表) | 400 缺参;404 书/章节不存在 |
| PUT | `/api/cards` | `slug`、`chapterFile`、`cards`(数组) | `{ ok: true }`(空数组 = 删除文件) | 400 缺参/非数组;404 书/章节不存在 |
| GET | `/api/books/:slug` | — | `{ book }` | 404 `书不存在: <slug>` |
| PATCH | `/api/books/:slug` | `title`(必填) | `{ book }`(重命名;工作区/会话目录整体迁移,当前会话跟随) | 404 未知书;400 空标题 / slug 冲突 |
| POST | `/api/books/:slug/session` | `chapterFile`(必填) | **202** `{ ok: true }`(进入切换互斥队列) | 404 书 / 404 `章节不存在: <file>` / 400 `bad_path` |
| POST | `/api/books/:slug/images` | multipart `file` | `{ file: "images/img-<6hex>.png" }`(服务端命名) | 400 非 png/jpeg/webp/gif(`仅支持 png/jpeg/webp/gif 图片`)/ >5 MB(`图片超过 5MB`) |
| GET | `/api/books/:slug/images/:file` | `:file` = URL 编码的 `images/x.png` | 原始字节(按扩展名定 content-type) | 400 `bad_path`;404 |
| DELETE | `/api/books/:slug/images/:file` | 同上 | `{ ok: true }` | 400 `bad_path`;404 |
| GET | `/api/books/:slug/export` | — | `application/zip`(整个书目录) | 404 未知书 |
| POST | `/api/books/import` | multipart `file`(zip) | `{ book }`(slug 冲突 → `<slug>-import-N`) | 400 各类校验失败 |
| DELETE | `/api/books/:slug` | — | `{ ok: true }`(书目录 + 会话一并删除) | 404 未知书 |
| POST | `/api/books/:slug/chapters` | `title`(必填,允许为空) | `{ chapter }` | 404 未知书 |
| PATCH | `/api/books/:slug/chapters/:id` | `title?`、`label?`(字符串或 null) | `{ book }`(完整索引) | 404 书;400 未知章节/非法标签 |
| GET | `/api/mcp` | — | `{ servers, status }`(配置 + 连接状态) | 404 MCP 未启用 |
| POST | `/api/mcp` | `{ name, type, command/url, ... }` | `{ servers, status }`(重连 + 重建会话) | 400 重名;404 未启用 |
| GET | `/api/mcp/raw` | — | `{ text }`(mcp.json 原样) | 404 未启用 |
| PUT | `/api/mcp/raw` | `text`(必填) | `{ servers, status }`(原样保存 + 重连) | 400 非法;404 未启用 |
| PUT | `/api/mcp/:name` | 服务器配置 | `{ servers, status }` | 400 名称不可改;404 未知/未启用 |
| DELETE | `/api/mcp/:name` | — | `{ servers, status }` | 404 未知/未启用 |
| GET | `/api/stage/:slug` | — | `StageSnapshot`(phase/cast/转录/计数) | 404 舞台区未启用 |
| POST | `/api/stage/:slug/command` | `cmd` + 参数 | 200 `{ text }`(同步)/ **202**(长命令 → `stage_done` SSE) | 400 `StageCommandError`;404 未启用 |
| any | `/api/...` 未匹配 | — | — | 404 `{ error: { code: "not_found", message: "未找到" } }` |

非 `/api` 的 GET/HEAD 请求从 `web/dist` 提供静态文件(无扩展名且文件缺失时回退 `index.html` 的 SPA 行为;路径穿越 → 400 `bad_path`);无静态根 → 404 JSON。**没有 WebSocket**——实时更新只有 SSE。

### SSE 事件流

`GET /api/events`(`text/event-stream`、`cache-control: no-cache`)。所有帧均为 `data: {json}`(无 `event:`/`id:` 字段);每 30 s(`PING_INTERVAL_MS`)广播注释帧心跳 `: ping`。

1. SessionHost 透传的 vendor `AgentSessionEvent`:`turn_start`、`turn_end`、`message_start`、`message_update`(含 `text_delta` / `thinking_delta`)、`message_end`、`tool_execution_start`、`tool_execution_end`、`agent_settled` 等。
2. 多客户端同步的合成事件:
   - `{ "type": "session_changed", "bookSlug", "chapterFile" }` — 章节切换后
   - `{ "type": "world_changed", "slug" }` — `PUT /api/world` 后
   - `{ "type": "draft_changed", "slug", "file" }` — `PUT /api/draft` 后

前端用 `new EventSource(...)` 订阅(原生断线重连;`onopen` 时重对齐聊天历史)。章节切换由内部 promise 互斥串行化,多浏览器并发切换按 FIFO 执行。

### SessionHost(`src/web/session-host.ts`)

pi agent 会话的无头封装;使用普通监听器 Set(非 EventEmitter)。

```ts
new SessionHost({ createRuntime, cwd, agentDir, sessionManager })
start(): Promise<void>                       // 包装工厂并绑定会话
subscribe(listener: (e: AgentSessionEvent) => void): () => void   // 返回退订函数
sendMessage(text): Promise<void>             // → session.prompt(text)
injectContext(text): Promise<void>           // world-context 自定义消息,deliverAs "nextTurn"
abort(): Promise<void>                       // → session.abort()
switchSession(chapterAbsPath): Promise<void> // → runtime.switchSession + 重新绑定
setModel(model): Promise<void>               // resolveCliModel 后 session.setModel
setThinkingLevel(level): Promise<void>       // 转型为 ThinkingLevel
getRuntime(): AgentSessionRuntime
listProviders(): Promise<ProviderListItem[]> // 从 modelRuntime.getModels() 去重
setProviderApiKey(providerId, key): Promise<void>   // modelRuntime.login(id, "api_key", …)
removeProvider(providerId): Promise<void>    // modelRuntime.logout(id)
getState(): SessionStateSnapshot             // 见下
dispose(): Promise<void>
```

`SessionStateSnapshot`(`GET /api/session` 直接返回):

```ts
{
  sessionFile: string | null,   // 如 …/sessions/<slug>/ch01.jsonl
  bookSlug: string | null,      // 会话子目录名
  chapterFile: string | null,   // 会话文件名
  isStreaming: boolean,
  messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: string }>,
  diagnostics: Array<{ type: "error" | "warning" | "info"; message: string }>,
}
```

### 内置编辑器(`src/editor/`)

`/edit [路径]` 挂载全屏覆盖层(`openFileEditor(ctx, options)` → `Promise<VimFileEditorResult { saved, content }>`);默认路径 `draft/<章节id>.md`。纯文本模式(立即可输入)或 vim 模式(`--vim`)。

**纯文本模式按键** — 直接输入、Enter 换行、Backspace/Delete、方向键、Home/End、PageUp/PageDown(10 行);`Ctrl+S` 保存 · `Ctrl+Z`/`Ctrl+Y` 撤销/重做 · `Ctrl+A` 全选 · `Ctrl+Q` 退出 · `Esc` 退出 · `Tab` 聚焦聊天;顶部可点击工具栏 保存 / 退出 / 撤回 / 重做;支持括号粘贴。鼠标:点击定位光标、按住拖选、双击选词、三击选行、滚轮滚动、右键(或 `Shift+F10`)打开菜单(和 AI 讨论 / 复制 / 全选)、拖动 `│` 分隔条调整聊天侧栏宽度(`CHAT_MIN_WIDTH 26`、`CHAT_MAX_RATIO 0.6`)。

**vim 模式** — normal/insert/visual 三种模式;`h j k l` / `w b e`(支持 `1-9` 计数前缀)/ `0 ^ $` / `gg G`;`x` 删除、`dd`/`yy`(行级,可计数)、`p P` 粘贴、`u` 撤销、`Ctrl+R` 重做、`r<字符>` 替换;`i a A I o O v`;visual 模式:移动 + `y`/`d`/`x`/`v`;`:` 命令行:`w` / `q`(脏时提示 `未保存，:q! 强制退出`)/ `q!` / `wq` / `x` / `wq!`。脏缓冲退出绝不静默关闭——状态栏提示 `未保存！Ctrl+S 保存 / Ctrl+Q 放弃`(纯文本)或 `未保存，:w 保存 / :q! 放弃`(vim)。

**`VimDocument`**(`src/editor/document.ts`)——纯逻辑、不依赖 TUI、单测覆盖:

```ts
class VimDocument {
  lines: string[]; cursor: { line, col }; mode: "normal"|"insert"|"visual";
  visualAnchor: Cursor | null; register: string | null; dirty: boolean;
  constructor(text = "");
  getText(): string;  setText(text): void;  markSaved(): void;
  moveLeft/Right/Down/Up(count = 1);  lineStart();  firstNonBlank();  lineEnd();
  gotoLine(line: number /* 1 基 */);
  nextWord();  prevWord();  endOfWord();           // vim w/b/e,Unicode 感知
  pushUndo();  undo();  redo();                    // 撤销栈上限 MAX_UNDO = 200
  insertText(text);  newLine();  backspace();  deleteForward();  deleteChar(count = 1);
  deleteLine(count = 1);  yankLine(count = 1);  pasteAfter();  pasteBefore();
  startVisual();  cancelVisual();  selection(): Selection | null;  selectedText(): string;
  deleteSelection();  yankSelection();
}
```

`dirty` 是相对 `savedText`(调用方最后一次经 `markSaved()` 持久化的内容)的漂移,因此撤销回已保存基线会清除脏标记。

**鼠标协议**(`src/editor/mouse.ts`)——SGR:`parseSgrMouse(seq): SgrMouseEvent | undefined`;启用/禁用序列为 `\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h` / `\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l`。事件:`{ kind: "press"|"drag"|"release"|"wheel", button: "left"|"middle"|"right"|"none", x, y, shift, ctrl, alt, delta }`(x/y 为 1 基终端格;delta `-1` 上滚 / `1` 下滚)。

**聊天侧栏**(`src/editor/chat.ts`)——仅契约:`ChatMessage { role: "user"|"assistant"; text }` 与 `ChatApi { send(text); subscribe(listener): () => void }`;在 `extension.ts` 中接到 `api.sendUserMessage` 与 `message_end` 事件(3 秒窗口内去重本地回显;回复到达时替换 pending 气泡)。

## Web GUI

React 18 + Vite 6 + CodeMirror 6 + Cytoscape,全部在根包内(无独立 `web/package.json`)。无路由库的标签页壳(`App.tsx`,`useState<View>` + 页面淡入;三页常驻挂载,`display:none` 切换保住流式状态)。三个页面:

- **写作 (Write)** — `WritePage`,「深夜书房」三栏写作台:
  - **书库 (library)** — 可折叠 56 px 图标条 / 200–340 px 拖拽调宽的章节侧栏(书 + 带序号的章节,新建章节/新建书/导入/导出 zip、行内重命名/删除)。折叠状态存 `localStorage`(`pi-writer:library-collapsed`)。
  - **纸张 (paper)** — 正文**常驻可见**:章节名大字头部(20 px)+ 全屏编辑入口(Alt+E)+ CodeMirror 6 编辑器(`@codemirror/lang-markdown`,可选 vim,隐藏行号,琥珀光标/选区)悬浮于「纸面」卡片,改动 800 ms 自动保存(`putDraft`,状态机 `loading → saved → dirty → saving → save-error`,`draft_changed` 多窗口冲突处理)。
  - **AI 伙伴 (companion)** — 380 px 右栏,**对话 / 批注**双标签(双内容常驻挂载,切换保留滚动位置与输入状态):
    - 对话:`InputBar`(Ctrl+Enter 发送,自动增高 textarea)、记录式消息(marked 18 渲染,HTML 转义)、思考折叠、工具卡、分支栏、乐观气泡 FIFO 去重、远端 `session_changed` 经 generation 守卫重同步。
    - 批注:正文选中文本(自动切到批注标签)→ 请求 AI 建议 → 应用(替换/插入)/撤回/追问,历史列表。
  - 预览卡片(AI 编辑 diff)锚定在回复消息后,以稳定 `id` 为 key(不依赖数组下标),**持久化在服务端**(`GET/PUT /api/cards`,`sessions/<slug>/<id>.cards.json`——跨窗口/重启共享,开书时预读)。
- **世界书 (World)** — `WorldPage`,基于 `world.json` 的两种视图,滑动过渡切换(双视图常驻挂载):
  - **列表 (list)** — `WorldTree`(人物/世界/时间线/大纲分组,parent 嵌套,防环)+ `EntryForm`(标题、状态、keys、章节多选、parent、active 开关、正文)+ `EntryCard`(百科式查看器:图片轮播含主图头像、缩略图条、关系列表含跳转/★)+ `NoticePanel`(1000 字,注入开关)+ `StorylinePanel`(状态 待办/进行中/完成/搁置;设一个为进行中会将其余降级为待办)+ `TimelinePanel` + `ConstraintsPanel`(每条 800 字,文风采样 500 字)。
  - **关系图 (graph)** — Cytoscape:圆形头像节点(条目 `avatar` 或生成的首字字母盘)、类型配色、类型过滤、连线模式(点两次创建关系)、强调加粗边、箭头方向、右键节点菜单(重命名/编辑正文/断开所有连线/删除节点)与边菜单、**撤销**(按钮或 Ctrl+Z,`MAX_UNDO = 50`)、800 ms 防抖自动保存、布局+视口按书持久化到 `localStorage`(`pi-writer:graph-layout:<slug>`、`pi-writer:graph-viewport:<slug>`)、缺失/重叠节点自愈。
  - 多窗口:`world_changed` SSE——自身回显(<1 s)跳过;脏时提示冲突 `世界书已在其他窗口被修改,保存将覆盖`;干净则重新加载。
- **设置 (Settings)** — `SettingsPage`:主题(深夜书房设计语言三套——深夜书房 night 暗色默认 / 纸上书房 paper 亮色 / 羊皮灯下 parchment 暖色,`data-theme` + localStorage 应用,26 色 token 按主题全量覆盖,对比度有测试把关)、模型(按 provider 分组的 `<select>`,自动回退 `当前模型已不可用,已自动切换到 …`)、思考级别(`off … max`)、世界书注入开关(Notice / storyline 启用)、模型提供商(`ProviderList`:搜索、已配置/环境变量/未配置 标签、内联 key 输入——key 存于 `~/.pi/writer/agent/auth.json`;OAuth provider 显示 `支持订阅登录(暂未支持)`)。

状态管理:`web/src/store.ts` — 会话 reducer(`processAgentEvent`):`message_start`(仅 user/assistant)、`message_update`(text_delta/thinking_delta)、`tool_execution_start/end`、`message_end`、`turn_start`/`agent_settled`(isStreaming)。`web/src/workspace.ts` — 工作区 reducer + 纯函数(`applyTextEdit`、`undoAppliedEdit`、`selectionStillMatches`、`resolveSaveOutcome`、`formatAnnotationPrompt`、`latestAssistantAfter`)。

API 客户端(`web/src/api/client.ts`):同源相对路径;方法 `getBooks/createBook/getBook/exportBook/importBook/uploadImage/deleteImage/deleteBook/createChapter/patchChapter/switchSession/getSession/sendChat/abort/getModels/setModel/setThinking/getProviders/setProviderApiKey/deleteProvider/getWorld/putWorld/getDraft/putDraft/getCards/putCards` + `subscribeEvents(onEvent, onOpen?)`(EventSource 自动重连)。`getDraft` 将 404 映射为 `""`;`friendlyError` 把 404/401/403/网络错误映射为中文提示。

## 舞台模式(舞台区共演 demo,实验性)

`stage-demo` 分支上的多 agent 共演 demo:**导演** agent 与你讨论剧情、维护世界书、经
`stage_script` 工具输出结构化剧本(定义段+文字段);**演员** agents(共享舞台上的对等角色,
不是导演的子 agent)受剧本约束即兴共演;**编剧** agent 在收幕时把舞台记录整理成 prose。
用户以 `/next` 逐步推进;OOC 的第一个发现者是用户,干预走「反馈 → 导演修订 → 重演」链路。

运行(CLI 交互):

```bash
npx tsx src/cli.ts --stage [--book <slug>] [--model <pattern>] [--thinking <level>]
```

舞台命令:

| 命令 | 说明 |
|---|---|
| `/next` | 逐步模式:演下一轮(回合进行中再发是 no-op——等舞台行出现再发) |
| `/auto` | 切换自动连续演 |
| `/force <角色>` | 强制下一轮指定角色发言 |
| `/retry [说明]` | 截断最后一条,同演员重演 |
| `/fix <序号> <反馈>` | 反馈包 → 导演修订剧本 → 从问题处续演 |
| `/revise k=v ...` | 修改剧本(min=/max=/wrap=/setting=/goal=/tone=/beats=…/actor:<id>.<字段>=) |
| `/wrap [N]` | 注入收尾提示(剩余约 N 条后收幕) |
| `/cut` | 立即收幕 |
| `/thoughts <1|2|3>` | 编剧思考链可见性(1 不看 / 2 导演提炼版 / 3 原始思考链) |
| `/stage` `/script` `/cast` `/mode` | 打印舞台转录 / 剧本 / 演员编制 / 导演模式 |

**三 agent 分工与一幕链路**

| 角色 | 职责 |
|---|---|
| **导演 Director** | 与你讨论剧情 → 维护世界书(`world_update`)→ 经 `stage_script` 输出结构化剧本(定义段:cast/inject/rules;文字段:shared + perActor)→ 收幕时读各演员思考链,把提炼的内心回写世界书。三模式状态机:讨论(开演前)→ 剧本(写作中)→ 导演(演出途中;每轮注入舞台视图,可与你讨论、经 stage_revise 微调剧本)。 |
| **演员 Actors** | 每个角色一个 headless 会话(对等角色,不是导演的子 agent)。第一人称思考链(不进转录)。每轮上下文 = 世界书注入块 + 舞台切片 + 剧本文字段 + 实时计数块。动作优先、只演自己(only-self,不代演他人);无话可说时输出 `<pass>`。角色由导演选角表分配(pool 槽位)。 |
| **编剧 Writer** | 收幕时被唤起。输入 = 舞台转录 + 剧本状态 + 世界书(导演已回写)+ 可选思考链(`/thoughts 1|2|3`)。输出 prose → `draft/<chapter>.md`;文风基准取自书的文风采样。 |

一幕链路:**讨论**(用户给导演剧情意向)→ **剧本**(导演 `world_update` 建角色/场景 → `stage_script` 开演;选角校验、演员会话惰性创建)→ **演出**(用户 `/next` 逐步或 `/auto` 连续;演员轮转发言,叙述者每 4 轮插播;pass 兜底:连续 2 次警告+强制发言、全员沉默收幕;演出途中随时可与**导演**对话——导演可见舞台全貌,可用 stage_revise 微调;`/revise` 下一轮生效;`/fix` = 反馈→导演修订→重演)→ **收尾**(`/wrap` 注入收尾提示,达 minLines 收幕)→ **收幕**(导演读全部思考链 → `world_update` 回写内心提炼 → 编剧成文)。产物:`stage/*.jsonl` 转录 + 剧本 vN + `world.json` 回写 + `draft/<chapter>.md`。

Web 端点(前端已随 2026-08-10 四页结构落地:顶层视图 = **舞台**(默认,演出前=导演讨论室/演出中同页两形态)· **编辑**(正文 + 伙伴栏「对话|批注|编剧」三标签)· **世界书** · **设置**;书库栏两页常驻):

- `GET /api/stage/:slug` — 舞台快照(sceneId/phase/mode/script/cast/transcript/counts +
  `avatars`:角色名 → 世界书头像文件,无头像前端走首字+角色色兜底)
- `POST /api/stage/:slug/command` — 同步命令 200 `{ text }`;长命令(`director`/`fix`/
  `cut`,内部含模型回合)202,结果经 `stage_done` SSE 事件
- SSE(共用 `/api/events` 流):`stage_entry`(新舞台行)、`stage_system`(开演/收幕/修订)、
  `stage_done`(长命令完成)

常驻编剧(编辑 agent,`src/web/writer-host.ts`;每书一个 `SessionHost`,会话文件
`sessions/<slug>/writer.jsonl`,与收幕编剧独立):

- `GET /api/writer/:slug` — 编剧会话状态(纯读;未对话过的书返回空态)
- `POST /api/writer/:slug/chat` `{ text, chapterFile? }` → 202;消息/工具事件经共用
  SSE 流以 `writer_event { slug, event }` 到达(内层与主会话事件同形状——前端原样复用
  `processAgentEvent`)
- `POST /api/writer/:slug/abort` — 中止在途生成
- 每轮上下文注入:当前章节草稿 + 世界书条目 + 文风采样(截断保护)
- 编辑确认(纯前端):编剧的 write/edit 立即落盘,批注栏顶部出「待确认」卡(diff 与
  主会话预览卡同源)——确认=归档,回退=PUT 写回编辑前文本

实现:`src/stage/`(orchestrator/assembler/script-store/stage-store/cast/counters/cli)+
`src/web/stage-host.ts`(每书一个惰性编排器注册表,经 `WriterServerOptions.stageHost`
接线);设计文档 `docs/superpowers/specs/2026-08-09-stage-demo-design.md`(§1–§16,
gitignored);`stage-scripting` 技能描述剧本契约。**实验性**:同一本书同一时刻只在一个
入口活跃(CLI 或 web)、场景状态在内存(重启即失)、web 舞台页未建;成本基线
deepseek-v4-flash 下单幕 ≈ ¥0.10-0.14。

## Electron 壳

`electron/main.ts` — `app.whenReady()` 后:`loadServerBundle()` import `../web/server.cjs`(相对 `dist/electron/main.cjs`;兼容 bun `__toCommonJS` 的 CJS 导出形态,回退 `mod.default`)并**进程内**调用 `startWebServer({ port: 8811, noBrowser: true, electron: true })`。`createWindow` → `BrowserWindow` 1280×800,`contextIsolation: true`、`nodeIntegration: false`,preload 依次探测 `dist/electron/preload.js` 与 `preload.js`。外链 → `shell.openExternal` + `action: "deny"`。窗口关闭:`server.stop()` + `app.quit()`。`preload.ts` 为占位(阶段 1 无 IPC——渲染进程只通过 HTTP 访问 `127.0.0.1`)。

## 安全

- Web 服务只绑定 **`127.0.0.1`**,并拒绝 `Host` 不是回环名(`127.0.0.1` / `localhost` / `::1`,剥离 IPv6 zone id)的请求——阻断 DNS rebinding 攻击;同时校验 `Origin` 与 `Sec-Fetch-Site`(`same-origin`/`same-site`/`none`);无这些头的本机请求(curl、脚本)放行。**可选 token 鉴权**:设置 `PI_WRITER_TOKEN` 后,每个 `/api` 请求都需携带 `Authorization: Bearer <token>` 或 `pi_writer_token` cookie(否则 401 `unauthorized`)——用于向其他设备开放端口时。
- agent 的文件工具**限制在书目录内**(`tool-guard.ts`):绝对路径、盘符、`~` 展开、`../` 穿越一律拒绝(400 `bad_path`),模型无法读取 `agent/auth.json`(provider API key)等敏感文件。`skills/` 只读。
- 导入的 zip 逐条目重新校验(路径安全、重复、≤ 2000 条目、≤ 50 MB、`book.json` 合法性)后才写入。
- 前端 markdown 渲染转义原始 HTML(XSS);链接带 `rel="noopener noreferrer"`。

## 配置

| 变量 | 默认 | 用途 |
|------|------|------|
| `PI_WRITER_DIR` | `~/.pi/writer` | 写作数据根(书、agent 配置、会话)。 |
| `PI_WRITER_AGENT_DIR` | `~/.pi/writer/agent` | Agent 配置目录(认证、模型、设置、扩展、技能)。 |
| `PI_WRITER_TOKEN` | 未设置 | `/api` 请求的可选 Bearer token(见「安全」)。 |
| `PI_WRITER_SKILLS_DIR` | exe 旁 / 源码树 | 覆盖打包技能目录(Android 壳注入)。 |
| `PI_WRITER_WEB_DIR` | exe 旁 / 源码树 | 覆盖 web/dist 静态目录(Android 壳注入)。 |
| `PI_WRITER_NO_SPAWN_TOOLS` | 未设置 | web 模式剔除 `grep`/`find`(spawn 受限的移动端环境)。 |

限制(常量):HTTP 请求体 1 MB · 图片上传 5 MB(png/jpeg/webp/gif)· zip 50 MB / 2000 条目 / 解压 100 MB · `MAX_ENTRY_IMAGES` 9 · Notice 1000 字 · 约束 800 字 · 文风采样 500 字 · 上下文预算 2000 token · 编辑器撤销栈 200 · 关系图撤销栈 50 · SSE 心跳 30 s · 草稿自动保存 800 ms。

## 开发与构建

```bash
# 从源码直接运行 TUI 或 web 服务
npx tsx src/cli.ts --book my-novel
npx tsx src/cli.ts --web --no-browser          # 终端一:8811 上的 API 服务
cd web && npx vite dev                          # 终端二:前端热更新(代理 /api → 8811)

# 类型检查(monorepo base 就位前的临时配置)
npx tsc -p tsconfig.tmp.json                    # src + vendor + electron
npx tsc -p web/tsconfig.json                    # web 前端

# 测试(vitest.config.ts 需要缺失的 ../../vitest.base.ts,用临时配置)
npx vitest run --config vitest.tmp.config.ts

# Lint(需安装 @biomejs/biome;仓库无 biome 配置)
npx @biomejs/biome check

# 打包 TUI 二进制(需 bun)-> release/pi-writer.exe
npm run bundle

# 构建 web 全套 -> dist/web/server.cjs + dist/electron/* + web/dist
npm run build:web
npm run web                                   # 运行构建产物(dist/web/server.cjs)

# Electron 冒烟(需 bun)
npm run build:electron && npm run electron

# 桌面安装包(build:web 之后)-> release/electron/pi-writer-web-<version>.exe
npx electron-builder --win nsis
```

构建流水线(`scripts/web-build.mjs`,需要 bun):
1. `bun build src/web.ts --target node --format cjs` → `dist/web/server.cjs`(单文件,除 `node:` 外零外部 require)。
2. `bun build electron/main.ts` + `electron/preload.ts` → `dist/electron/main.cjs` / `dist/electron/preload.js`(`--external "electron*"`)。
3. 在 `web/` 执行 `vite build` → `web/dist`。
4. 检查:`checkSelfContained`(所有静态 `require(...)` 说明符必须 `node:` 前缀或已知内建)、`smokeRequire`(require 产物并断言导出 `startWebServer` + `parseWebArgs`)、`node --check`、`web/dist/index.html` 存在。

注意事项:
- 服务端产物必须叫 `.cjs`——包根为 `"type": "module"`,`.js` 会把 CJS 当 ESM 解析(`require is not defined`)。
- bun 会把 `import.meta.url` 烘焙成源码 URL 常量;vendor loader 用 `new URL(specifier, import.meta.url)`,CJS 打包后语义一致。
- Electron 从 `import()` 产物的 `default` 取导出(cjs-module-lexer 识别不出 bun `__toCommonJS` 包装上的命名导出);`loadServerBundle` 保留命名导出兜底。
- 测试套件(`test/`):只测纯逻辑——book-manager、config、editor(`VimDocument`、`parseEditArgs`、`parseSgrMouse`)、extension、world-data(校验/迁移/并发/备份回滚)、world-context(激活/预算)、tools(`applyWorldUpdate`)、server(端点/host 守卫/静态服务/multipart-busboy 分支)、session-host、graph-logic、relation-graph-dom、web-cli、mcp、stage。

## 开发规范

**单一真相源,禁止再造副本**(下列模块均在 2026-08-10 从 2–5 份重复实现收敛而来;新代码必须 import 复用,发现第二份副本就地删除):

| 模块 | 独占职责 |
|---|---|
| `src/session-factory.ts` `createSessionRuntimeFactory` | 会话装配样板(cli/web/stage 共用) |
| `src/cjk.ts` `cjkCount`/`isCjkChar` | CJK 字符计数(码点范围;**禁用 `\p{` 正则,Android 无 full ICU**) |
| `src/atomic-write.ts` `atomicWriteFile` | 文件原子写(唯一 tmp + rename 重试) |
| `src/session-text.ts` `chatTextOfMessage`/`chatThinkingOfMessage` | 会话消息文本提取(TUI + web) |
| `src/config.ts` `resolveSkillsDir` | skills 目录解析(env → exe 旁 → 源码树) |
| `src/world-data.ts` `WORLD_FILES`/`WORLD_FILE_TITLES` | 世界书文件布局表(world-tree 引用) |

**手写边界**(允许手写 vs 必须用库):

- **允许手写**(刻意不引 HTTP 框架):路由表(`server.ts` 的 `Route[]` + `matchRoute`,约 30 行;加端点 = 表加一行 + 按域分组的一个 handler)、SSE 帧协议、静态文件服务 + SPA 回退、CLI 参数解析、回环 Host/Origin 守卫、If-Match mtime 条件写。判断标准:逻辑 ≤ 约 50 行且无安全边界 → 可手写。
- **必须用库,禁止手写**:multipart 解析 → **busboy**(2026-08-10 替换手写 boundary 切分;busboy 1.x 是**函数调用** `busboy({ headers, limits })`,不是 `new`);zip 打包/解包 → yazl/yauzl;JSON Schema → typebox(`Compile().Check()` 做运行时校验)。
- **路由表顺序是承重结构**:同方法同段数的条目中,静态段(`mcp/raw`)必须排在参数段(`mcp/:name`)之前;匹配时传入的是去掉 `api` 前缀后的 parts(`parts.slice(1)`)。
- **新依赖引入流程**:`npm i <pkg>`(+ `@types/<pkg>`)→ `tsc -p tsconfig.tmp.json` → **每个 API 调用点一条行为测试**(代码用到的每个方法/事件/分支——类型检查只保证方法存在,保证不了运行时行为;`error`/`limit`/`close` 等事件路径必须显式用例)→ `npm run build:web`(自包含检查拒绝外部 require)→ 评估 Android 兼容(纯 JS、可内联)。
- **环境要点**:类型检查 `npx tsc -p tsconfig.tmp.json`(`src/` 必须 0 错误;vendor 既有错误忽略)、测试 `npx vitest run --config vitest.tmp.config.ts`(640+ 条)、生产冒烟 `env PI_WRITER_DIR=<临时目录> node dist/web/server.cjs --no-browser --port 8899` 后用 `node --input-type=module -e` + `fetch` 请求(Git Bash curl 中文乱码且 `/tmp` 路径映射与 node 不一致)。

## License

MIT

