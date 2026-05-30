# mcp-kb-notion-mirror

Local stdio MCP server that **mirrors** Knowledge Base markdown notes into Notion and records the resulting Notion URL back into each note's YAML frontmatter.

The KB is canonical; the Notion mirror is a derivative read surface for people who don't work in the KB. The server exposes **two layers** of tools:

- **Per-note mirror tools** (`notion_mirror_*`) — act on one `kb_path` per call and (for mutations) a Notion `parent` you supply. File-aware but layout-agnostic: no directory walking, no parent resolution.
- **Subtree orchestrator tools** (`notion_mirror_tree_*`) — walk a caller-supplied `subtree` folder under the KB root, apply the folder-index hierarchy convention, and attach the subtree's root under a caller-supplied `parent`. They are built on top of the per-note tools.

There is **no fixed root folder and no fixed wiki database**. Every operation takes the `subtree` to mirror and the `parent` it attaches under **per call** — so you can mirror any folder under any Notion parent.

## What it does

Given a KB markdown note and a Notion parent, the publish path:

1. Strips the frontmatter and the leading `# Title` H1 (Notion takes the title from a page property; the title is the note's filename).
2. Converts the markdown body to Notion blocks via [`@tryfabric/martian`](https://github.com/tryfabric/martian) — paragraphs, headings, nested lists, code fences, blockquotes, dividers, GFM tables, inline formatting, links.
3. Prepends a "Mirrored from Knowledge Base" banner callout dated with the publish day.
4. Creates (or replaces) the page under the `parent`.
5. Writes `notion_mirror_url` + `notion_mirror_published_at` back into the note's frontmatter (atomically, preserving field order and formatting).

## Layering

| Layer                                | Owns                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Per-note (`notion_mirror_*`)**     | Notion API plumbing · markdown→blocks · banner · reading/writing the `notion_mirror_*` frontmatter fields                           |
| **Subtree (`notion_mirror_tree_*`)** | Walking a subtree · ordering the publish · resolving each note's parent by the folder-index convention · the two-pass wikilink loop |

The subtree layer is layout-agnostic: it doesn't know about "Pillars" or any specific KB; you tell it which folder to mirror and which Notion parent to attach it under.

## The folder-index hierarchy convention

The subtree tools encode one convention for turning a folder tree into a Notion page tree:

- A folder's **index note** is `<Folder>/<Folder>.md` (its basename equals the containing folder's basename). That note becomes the folder's Notion page.
- A **leaf note** nests under its folder's index page.
- A **sub-folder's index** nests under the **grandparent** folder's index page.
- The **subtree-root index** (the index of the `subtree` folder itself) attaches to the caller-supplied `parent`.

So for `subtree = "Pillars/Engineering"` with parent = a wiki database:

```text
Pillars/Engineering/Engineering.md          → page under the wiki database (the parent)
Pillars/Engineering/Roadmap.md              → page under Engineering
Pillars/Engineering/Bioweave/Bioweave.md    → page under Engineering
Pillars/Engineering/Bioweave/DNS Scheme.md  → page under Bioweave
```

Notes excluded from mirroring: any with `mirror: exclude` in frontmatter, any whose filename starts with a configured skip prefix (default `+`), and any kb-path in the configured skip list. See [Environment variables](#environment-variables).

## Tools

### `notion_mirror_publish(kb_path, parent, mode?, icon?, link_map?)` — write

Mirror one note under `parent` and record the URL in its frontmatter.

- `kb_path` (string) — the KB markdown note.
- `parent` (object) — `{ type: "database_id", database_id }` or `{ type: "page_id", page_id }`, passed to Notion verbatim. A database parent creates a wiki row; a page parent creates a child page.
- `mode` (`"create"` | `"replace"` | `"force"`, default `"create"`) — how to handle an already-mirrored note (see [When to use which mode](#when-to-use-which-mode)). A non-mirrored note is created in every mode.
- `force` (boolean, deprecated) — legacy alias for `mode: "force"`. Prefer `mode`.
- `icon` (object, optional) — `{ type: "emoji", emoji }` or `{ type: "external", external: { url } }`, passed to Notion verbatim. Omit for no icon.
- `link_map` (object, optional) — maps a `[[target]]` string to that note's mirror URL. Resolved wikilinks become Notion `@`mentions; unresolved ones render as italic text. The per-note tool does not build this map; the subtree tools do (see [Wikilinks](#wikilinks-link_map)).

Returns `{ url, page_id, published_at, mode }`. For `replace`, `url` equals the pre-existing `notion_mirror_url`. When already mirrored in `create` mode, returns `{ skipped: true, existing_url }`.

**Side effect:** when `parent.type` is `"page_id"`, the parent's child-pages heading is refreshed (see [Child-pages footer](#child-pages-footer)).

#### When to use which mode

| `mode`               | Already mirrored?                                             | URL after   |
| -------------------- | ------------------------------------------------------------- | ----------- |
| `"create"` (default) | Skip — `{ skipped: true, existing_url }`, no Notion call.     | unchanged   |
| `"replace"`          | Update the page's body + properties **in place** (see below). | **kept**    |
| `"force"`            | Archive the old page, create a new one.                       | **changes** |

`replace` is for re-rendering a page without breaking inbound links — e.g. the second pass of wikilink resolution. It deletes the old body blocks and appends the new body **above** the page's native child links, then re-labels them with the `Child Pages` heading.

> **Comment-loss caveat.** `replace` is body-destructive: Notion attaches **block-level comments** to specific blocks, which `replace` deletes. Page-level comments and child pages are preserved. Fold any block comments back into the KB before a replace pass — the canonical KB body always wins.

### `notion_mirror_move(kb_path, parent)` — write

Re-parent the already-published mirror page to `parent`. Content and URL are unchanged; no frontmatter change. Returns `{ moved: true, page_id, previous_parent, new_parent }`.

> **Caveat:** Notion cannot move a page between a `page_id` parent and a `database_id` parent — `PATCH /v1/pages` silently ignores it. This tool detects that case and errors clearly; use `unpublish` + `publish` instead.

### `notion_mirror_unpublish(kb_path, dry_run?)` — destructive

Archive the Notion page in `notion_mirror_url` and clear the two mirror frontmatter fields.

- `dry_run` (boolean, default `true`) — when true, report what _would_ happen without calling Notion or editing the note.

Dry run returns `{ dry_run: true, would_archive_url, would_archive_page_id, would_clear_fields }`. A real run returns `{ archived: true, page_id, url }`. A note with no `notion_mirror_url` returns `{ archived: false, reason: "not-published" }`.

> **Caveat:** archiving cascade-archives descendant pages on the Notion side. This tool clears only the one note's frontmatter; descendants still point at now-archived pages.

### `notion_mirror_get(kb_path)` — read

Fetch the live Notion page in `notion_mirror_url`. Pure read. Returns `{ id, parent, title, created_time, last_edited_time, archived, url }`, or `{ exists: false, reason: "not-published" }`.

### `notion_mirror_tree_status(subtree)` — read

Report which notes in a subtree are already mirrored, ordered the way a publish would visit them.

- `subtree` (string) — kb-relative folder to walk (e.g. `"Pillars/Engineering"`).

Returns `{ total, published, pending, notes: [{ kbPath, published }] }`. Pure read.

### `notion_mirror_tree_preflight(subtree)` — read

Check a subtree for structural issues that would force notes to be skipped — currently, folders that contain notes but lack a folder-index note.

- `subtree` (string) — kb-relative folder to walk.

Returns `{ issues: string[] }` — empty when the subtree is publish-ready. Pure read.

### `notion_mirror_tree_publish(subtree, parent, kb_path?, dry_run?, pass?)` — destructive

Mirror a whole subtree (or one note within it) to Notion, attaching the subtree-root index under `parent` and nesting the rest by the folder-index convention. Two passes: pass 1 creates pages, pass 2 replaces bodies to resolve `[[wikilinks]]` into `@`mentions. Destructive — defaults to a dry run.

- `subtree` (string) — kb-relative folder to walk.
- `parent` (object) — the Notion parent the subtree-root index attaches under, same shape as `publish`.
- `kb_path` (string, optional) — publish just this note (walking up its unpublished ancestor indexes first) instead of the whole subtree.
- `dry_run` (boolean, default `true`) — when true, compute outcomes without calling Notion or editing notes.
- `pass` (`"both"` | `"pass1"` | `"pass2"`, default `"both"`) — which pass(es) to run for a whole-subtree publish (a single `kb_path` always runs both over its ancestor chain).

Returns, for a whole subtree, `{ eligible, pass1: NoteOutcome[], pass2: NoteOutcome[] }`; for a single note, `{ chain: string[], pass1, pass2 }`. Each `NoteOutcome` is `{ kbPath, action: "create"|"replace"|"skip"|"plan"|"error", url?, error? }`.

## Wikilinks (`link_map`)

KB notes use `[[target]]` / `[[target|display]]` wikilinks. The subtree tools build a `link_map` (target string → mirror URL) from every published note and pass it on each `replace` call, so each resolved `[[…]]` becomes a Notion page `@`mention; unresolved targets render as italic text. The per-note `publish` tool accepts a caller-supplied `link_map` directly.

## Two-pass publishing

Wikilink `@`mentions need every target's URL to exist first, and those URLs must stay stable — so the subtree publish runs two passes:

```text
Pass 1 — create (URLs don't exist yet; wikilinks render italic)
  for each note in tree order: publish mode "create"
  → every note now has a stable notion_mirror_url

Pass 2 — replace (URLs are stable)
  build link_map from every note's notion_mirror_url
  for each note: publish mode "replace" with link_map
  → every [[X]] is now an @mention pointing at the right page
```

`replace` updates the body in place, so the URLs other notes mention keep resolving.

## Child-pages footer

Notion renders a parent's children inline as native `child_page` blocks. The footer is a single **"Child Pages"** `heading_2` placed immediately above those native child links, to label the section. Maintenance is automatic (no separate tool):

- after `publish` under a `page_id` parent → that parent's heading is refreshed;
- after a real `unpublish` of a page-parented child → that parent's heading is refreshed;
- after `move` → both the old and new page parents' headings are refreshed.

A refresh removes any prior heading, then — if the page has child pages — inserts one heading right before the first child-page block. Database parents need no heading.

> **Mirror-only / sentinel.** The heading is **never** written into the KB source. Its text is exactly `Child Pages` (a `heading_2`). Any future "read the mirror back into the KB" path must recognise this sentinel heading and strip it.

## Publish CLI

The `mcp-kb-notion-mirror-publish` bin runs the same subtree orchestrator from the shell:

```bash
mcp-kb-notion-mirror-publish status    --subtree Pillars/Engineering
mcp-kb-notion-mirror-publish preflight --subtree Pillars/Engineering
mcp-kb-notion-mirror-publish publish   --subtree Pillars/Engineering --parent-db <wiki-db-id> --dry-run
mcp-kb-notion-mirror-publish publish   --subtree Pillars/Engineering --parent-page <page-id> Pillars/Engineering/Roadmap.md
mcp-kb-notion-mirror-publish unpublish Pillars/Engineering/Roadmap.md --dry-run
```

It auto-loads `.env.local` and `.env` from the working directory. The `--subtree` and `--parent-db`/`--parent-page` flags are per invocation — they are not read from env.

## Access levels

Tools are gated by `MCP_KB_NOTION_MIRROR_ACCESS_LEVEL` (default `write`). Each level implies the lower ones:

| Level         | Tools registered                                                                 |
| ------------- | -------------------------------------------------------------------------------- |
| `read`        | `notion_mirror_get`, `notion_mirror_tree_status`, `notion_mirror_tree_preflight` |
| `write`       | the above + `notion_mirror_publish`, `notion_mirror_move`                        |
| `destructive` | the above + `notion_mirror_unpublish`, `notion_mirror_tree_publish`              |

This server's whole purpose is mutating the mirror, so `write` is the practical baseline; the archive/bulk-publish tools additionally require `destructive`.

## Setup

### 1. Create the Notion integration

1. <https://www.notion.so/my-integrations> → **New integration** (internal). Give it **Read content**, **Insert content**, and **Update content** capabilities.
2. Copy the **Internal Integration Secret** (`ntn_…`). Treat it like a password.
3. Open every target page/database in Notion → **⋯** menu → **Connections** → add your integration. Without this connection the API returns `restricted_resource` / `403` even with a valid token.

### 2. Build

```bash
bun install
bun run build
```

### 3. Wire into Claude Desktop / Claude Code

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (or the Claude Code equivalent) — see [claude-config-sample.json](./claude-config-sample.json):

```json
{
  "mcpServers": {
    "mcp-kb-notion-mirror": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-kb-notion-mirror/dist/mcp-server/index.js"
      ],
      "env": {
        "MCP_KB_NOTION_MIRROR_TOKEN": "ntn_YOUR_INTEGRATION_SECRET",
        "MCP_KB_NOTION_MIRROR_KB_ROOT": "/absolute/path/to/your/kb"
      }
    }
  }
}
```

Restart Claude.

## Environment variables

| Variable                                   | Required | Default                                           | Purpose                                                                                          |
| ------------------------------------------ | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MCP_KB_NOTION_MIRROR_TOKEN`               | yes      | —                                                 | Notion internal-integration secret (`ntn_…`).                                                    |
| `MCP_KB_NOTION_MIRROR_KB_ROOT`             | no †     | unset                                             | Absolute KB root. `kb_path` / `subtree` resolve under it and are confined to it.                 |
| `MCP_KB_NOTION_MIRROR_ACCESS_LEVEL`        | no       | `write`                                           | `read` / `write` / `destructive`.                                                                |
| `MCP_KB_NOTION_MIRROR_BANNER_TEMPLATE`     | no       | KB default                                        | Banner copy; `{date}` → today's UTC date; `**bold**` honoured. Empty string disables the banner. |
| `MCP_KB_NOTION_MIRROR_API_BASE_URL`        | no       | `https://api.notion.com`                          | Notion API base URL.                                                                             |
| `MCP_KB_NOTION_MIRROR_SKIP_PREFIXES`       | no       | `+`                                               | Comma-separated filename prefixes excluded from subtree publishing.                              |
| `MCP_KB_NOTION_MIRROR_SKIP_PATHS`          | no       | (none)                                            | Comma-separated kb-paths excluded from subtree publishing.                                       |
| `MCP_KB_NOTION_MIRROR_ICON_BASE_URL`       | no       | `https://unpkg.com/lucide-static@latest/icons`    | Base URL for Lucide-style external page icons.                                                   |
| `MCP_KB_NOTION_MIRROR_AUDIT_LOG`           | no       | `writes`                                          | Audit-log scope. `off` / `writes` / `all`.                                                       |
| `MCP_KB_NOTION_MIRROR_AUDIT_LOG_PATH`      | no       | `~/.local/state/mcp-kb-notion-mirror/audit.jsonl` | Path to the JSONL audit log.                                                                     |
| `MCP_KB_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES` | no       | `10485760` (10 MiB)                               | Size-based rotation threshold in bytes. `0` disables rotation.                                   |
| `MCP_KB_NOTION_MIRROR_AUDIT_LOG_KEEP`      | no       | `5`                                               | Number of rotated audit-log files to retain.                                                     |

† The subtree orchestrator tools require `MCP_KB_NOTION_MIRROR_KB_ROOT`; the per-note tools work with absolute `kb_path`s when it is unset.

The `subtree` and `parent` are always supplied per call (tool args / CLI flags), never via env. The Notion token is never written to logs, error messages, or tool output.

## Running locally

```bash
bun run server:mcp:dev      # bun --watch, runs the server from TS source
bun run server:mcp:inspect  # MCP Inspector against the TS source
```

Both set `NODE_ENV=development`, so a local `.env.development` is auto-loaded. Copy [`.env.example`](./.env.example) to `.env.development` and fill in your token to get started.

## Frontmatter contract

Every publishable note has YAML frontmatter; this server touches **only** two fields and never reorders or reformats the rest:

```yaml
---
status: current — May 2026
purpose: <one-line>
notion_source_url: https://www.notion.so/<32hex>
notion_path: Product & Eng / Platform Architecture / …
notion_mirror_url: https://www.notion.so/<slug>-<32hex> # written by this server
notion_mirror_published_at: 2026-05-30T01:13:00Z # written by this server, ISO-8601 UTC
---
```

New fields are inserted right after `notion_path` (falling back to `notion_source_url_secondary` / `notion_source_url`). A note with no frontmatter is an error. `notion_source_url`, `mirror:`, and any other field are read-only to this server (it only writes the two `notion_mirror_*` fields); `mirror: exclude` opts a note out of subtree publishing.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned work (image uploads, a publish diff tool, backlink sync).
