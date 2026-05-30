# mcp-notion-mirror

Local stdio MCP server that **mirrors** a Knowledge Base markdown note to a Notion page and records the resulting Notion URL back into the note's YAML frontmatter.

The KB is canonical; the Notion mirror is a derivative read surface for people who don't work in the KB. The MCP is **file-aware but layout-agnostic**: it acts on one `kb_path` per call and (for mutations) a Notion `parent` you supply. It does **not** walk directories, discover files, resolve parents, or know any folder convention — that's the orchestrator's job (a skill or script in the calling project).

## What it does

Given a KB markdown note and a Notion parent, `notion_mirror_publish`:

1. Strips the frontmatter and the leading `# Title` H1 (Notion takes the title from a page property; the title is the note's filename).
2. Converts the markdown body to Notion blocks via [`@tryfabric/martian`](https://github.com/tryfabric/martian) — paragraphs, headings, nested lists, code fences, blockquotes, dividers, GFM tables, inline formatting, links.
3. Prepends a "Mirrored from Knowledge Base" banner callout dated with the publish day.
4. Creates the page under the `parent` you passed (verbatim).
5. Writes `notion_mirror_url` + `notion_mirror_published_at` back into the note's frontmatter (atomically, preserving field order and formatting).

The other three tools (`unpublish`, `move`, `get`) act on the page recorded in `notion_mirror_url`.

## Layering

| Layer                        | Owns                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **MCP (this repo)**          | Notion API plumbing · markdown→blocks · banner · reading/writing the `notion_mirror_*` frontmatter fields                 |
| **Orchestrator (elsewhere)** | Walking the KB · deciding what to publish · resolving parents · folder/exclusion conventions · publish order · bulk loops |

A KB convention change (a new exclusion rule, a folder-layout shift, banner-text wording) is an orchestrator/script change — never an MCP change.

## Tools

### `notion_mirror_publish(kb_path, parent, mode?, icon?, link_map?)` — write

Mirror one note under `parent` and record the URL in its frontmatter.

- `kb_path` (string) — the KB markdown note.
- `parent` (object) — `{ type: "database_id", database_id }` or `{ type: "page_id", page_id }`, passed to Notion verbatim. A database parent creates a wiki row; a page parent creates a child page.
- `mode` (`"create"` | `"replace"` | `"force"`, default `"create"`) — how to handle an already-mirrored note (see [When to use which mode](#when-to-use-which-mode)). A non-mirrored note is created in every mode.
- `force` (boolean, deprecated) — legacy alias for `mode: "force"`. Prefer `mode`; `force` will be dropped.
- `icon` (object, optional) — `{ type: "emoji", emoji }` or `{ type: "external", external: { url } }`, passed to Notion verbatim. Omit for no icon.
- `link_map` (object, optional) — maps a `[[target]]` string to that note's mirror URL. Resolved wikilinks become Notion `@`mentions; unresolved ones render as italic text. Omit/empty → all wikilinks italic. The MCP does not build this map — the orchestrator does (see [Wikilinks](#wikilinks-link_map)).

Returns `{ url, page_id, published_at, mode }`. For `replace`, `url` equals the pre-existing `notion_mirror_url`. When already mirrored in `create` mode, returns `{ skipped: true, existing_url }`. Errors `Nothing to publish …` if the body is empty and the banner is disabled.

**Side effect:** when `parent.type` is `"page_id"`, the parent's child-pages heading is refreshed after the page is created/updated (see [Child-pages footer](#child-pages-footer)).

#### When to use which mode

| `mode`               | Already mirrored?                                             | URL after   |
| -------------------- | ------------------------------------------------------------- | ----------- |
| `"create"` (default) | Skip — `{ skipped: true, existing_url }`, no Notion call.     | unchanged   |
| `"replace"`          | Update the page's body + properties **in place** (see below). | **kept**    |
| `"force"`            | Archive the old page, create a new one.                       | **changes** |

`replace` is for re-rendering a page without breaking inbound links — e.g. the second pass of wikilink resolution (see [Two-pass publishing](#two-pass-publishing-orchestrator)). It deletes the old body blocks and appends the new body **above** the page's native child links, then re-labels them with the `Child Pages` heading.

> **Comment-loss caveat.** `replace` is body-destructive: Notion attaches **block-level comments** to specific blocks, which `replace` deletes. Page-level comments and child pages are preserved. Fold any block comments back into the KB before a replace pass — the canonical KB body always wins.

### `notion_mirror_move(kb_path, parent)` — write

Re-parent the already-published mirror page to `parent`. Content and URL are unchanged; no frontmatter change. Returns `{ moved: true, page_id, previous_parent, new_parent }`.

> **Caveat:** Notion cannot move a page between a `page_id` parent and a `database_id` parent — `PATCH /v1/pages` silently ignores it. This tool detects that case and errors clearly; use `unpublish` + `publish` instead.

**Side effect:** both the old and new parents' child-pages footers are refreshed (page parents only).

### `notion_mirror_unpublish(kb_path, dry_run?)` — destructive

Archive the Notion page in `notion_mirror_url` and clear the two mirror frontmatter fields.

- `dry_run` (boolean, default `true`) — when true, report what _would_ happen without calling Notion or editing the note.

Dry run returns `{ dry_run: true, would_archive_url, would_archive_page_id, would_clear_fields }`. A real run returns `{ archived: true, page_id, url }`. A note with no `notion_mirror_url` returns `{ archived: false, reason: "not-published" }`.

> **Caveat:** archiving cascade-archives descendant pages on the Notion side. This tool clears only the one note's frontmatter; descendants still point at now-archived pages (caller's responsibility).

**Side effect:** when `dry_run` is false and the archived page had a page parent, that parent's child-pages footer is refreshed.

### `notion_mirror_get(kb_path)` — read

Fetch the live Notion page in `notion_mirror_url`. Pure read — no Notion mutation, no file change. Returns `{ id, parent, title, created_time, last_edited_time, archived, url }`, or `{ exists: false, reason: "not-published" }` when the note has no mirror URL.

## Wikilinks (`link_map`)

KB notes use `[[target]]` / `[[target|display]]` wikilinks. Pass `link_map` to `publish` — a map from the wikilink target string to that note's mirror URL — and each resolved `[[…]]` becomes a Notion page `@`mention; unresolved targets render as italic text (so a broken reference is visible but not clickable). The visible text is the explicit `display`, or the target's basename (last path segment, sans `.md`).

The MCP does **not** build the map — it doesn't walk the KB. The orchestrator typically walks every KB note with a `notion_mirror_url` once and passes the relevant slice on each publish call. Omitting `link_map` (or passing `{}`) renders all wikilinks italic.

## Child-pages footer

Notion already renders a parent's children inline as native, clickable `child_page` blocks. So the footer doesn't duplicate them as a list — it's just a single **"Child Pages"** `heading_2` placed immediately **above** those native child links, to label the section. Footer maintenance is automatic — there is no separate tool:

- after `publish` under a `page_id` parent → that parent's heading is refreshed;
- after a real `unpublish` of a page-parented child → that parent's heading is refreshed;
- after `move` → both the old and new page parents' headings are refreshed.

A refresh removes any prior heading (and legacy `📂 Child Pages` footer bullets from earlier versions), then — if the page has any child pages — inserts one heading right before the first child-page block. New children Notion appends at the end fall under it. Database parents need no heading (their views already list rows). Refreshes are serialised per parent and never fail the primary operation (a footer error is logged and swallowed).

> **Mirror-only / sentinel.** The heading is **never** written into the KB source. Its text is exactly `Child Pages` (a `heading_2`). Any future "read the mirror back into the KB" path **must** recognise this sentinel heading and strip it before importing.

## Orchestrator example

The MCP no longer figures out parents — the caller does. A minimal single-note publish, computing the parent from the parent KB note's own `notion_mirror_url`:

```ts
// Pseudo-orchestration — lives in the caller (skill/script), NOT the MCP.
import { readFrontmatter, resolveParentKbPath } from "./kb-helpers"; // KB-specific

const WIKI_DB_ID = "36f9f7187cc280f69272e60aa89bff24";
const extractPageId = (url: string) =>
  url.match(/([a-f0-9]{32})(?:$|\?|#)/)?.[1];

async function publishOne(kb_path: string) {
  // The parent is whichever KB note owns this one in your tree.
  const parentKbPath = resolveParentKbPath(kb_path); // e.g. the folder index
  const parentMirror = parentKbPath
    ? readFrontmatter(parentKbPath).notion_mirror_url
    : undefined;

  const parent = parentMirror
    ? { type: "page_id", page_id: extractPageId(parentMirror)! } // nest under the parent page
    : { type: "database_id", database_id: WIKI_DB_ID }; // top of the tree

  // Optional extras the caller computes from the KB:
  const fm = readFrontmatter(kb_path);
  const icon = fm.icon?.startsWith("http")
    ? { type: "external", external: { url: fm.icon } }
    : fm.icon
      ? { type: "emoji", emoji: fm.icon }
      : undefined;
  const link_map = buildLinkMapForOutboundWikilinks(kb_path); // { "[[target]]": mirrorUrl }

  // MCP does the rest — markdown, banner, wikilink mentions, frontmatter write-back,
  // and (for page parents) refreshing the parent's child-pages footer.
  await callTool("notion_mirror_publish", { kb_path, parent, icon, link_map });
}
```

Publish parents before children (the caller orders the loop). To re-home a page published flat by an earlier version, call `notion_mirror_move` once per page with the new parent.

### Two-pass publishing (orchestrator)

Wikilink `@`mentions need every target's URL to exist first, and those URLs must stay stable — so resolution is a second pass using `mode: "replace"` (which keeps URLs):

```text
Pass 1 — initial publish (URLs don't exist yet; wikilinks render italic)
  for each note in tree order:
    notion_mirror_publish({ kb_path, parent, mode: "create", icon })
  → every note now has a stable notion_mirror_url

Pass 2 — wikilink resolution (URLs are stable; any order)
  build link_map: { "[[target]]" → notion_mirror_url } from every note
  for each note:
    notion_mirror_publish({ kb_path, parent, mode: "replace", icon, link_map })
  → every [[X]] is now an @mention pointing at the right page
```

`replace` updates the body in place, so the `@`mentions other notes make to this one keep resolving. (Using `force` here would change every URL and the round-trip would never converge.)

## Access levels

Tools are gated by `MCP_NOTION_MIRROR_ACCESS_LEVEL` (default `write`). Each level implies the lower ones:

| Level         | Tools registered                                          |
| ------------- | --------------------------------------------------------- |
| `read`        | `notion_mirror_get`                                       |
| `write`       | the above + `notion_mirror_publish`, `notion_mirror_move` |
| `destructive` | the above + `notion_mirror_unpublish`                     |

This MCP's whole purpose is mutating the mirror, so `write` is the practical baseline; `unpublish` (archive) additionally requires `destructive`.

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
    "mcp-notion-mirror": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-notion-mirror/dist/mcp-server/index.js"],
      "env": {
        "MCP_NOTION_MIRROR_TOKEN": "ntn_YOUR_INTEGRATION_SECRET",
        "MCP_NOTION_MIRROR_KB_ROOT": "/absolute/path/to/your/kb"
      }
    }
  }
}
```

Restart Claude.

## Environment variables

| Variable                                | Required | Default                                        | Purpose                                                                                                                |
| --------------------------------------- | -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MCP_NOTION_MIRROR_TOKEN`               | yes      | —                                              | Notion internal-integration secret (`ntn_…`). Needs Insert + Update content and a Connection to the target.            |
| `MCP_NOTION_MIRROR_KB_ROOT`             | no       | unset                                          | Absolute KB root. When set, `kb_path` resolves under it and is confined to it. When unset, `kb_path` must be absolute. |
| `MCP_NOTION_MIRROR_ACCESS_LEVEL`        | no       | `write`                                        | `read` / `write` / `destructive`. `write` enables publish + move; `destructive` adds unpublish.                        |
| `MCP_NOTION_MIRROR_BANNER_TEMPLATE`     | no       | KB default                                     | Banner copy; `{date}` → today's UTC date; `**bold**` honoured. Empty string disables the banner.                       |
| `MCP_NOTION_MIRROR_API_BASE_URL`        | no       | `https://api.notion.com`                       | Notion API base URL.                                                                                                   |
| `MCP_NOTION_MIRROR_AUDIT_LOG`           | no       | `writes`                                       | Audit-log scope. `off` / `writes` (non-read tool calls) / `all` (every invocation).                                    |
| `MCP_NOTION_MIRROR_AUDIT_LOG_PATH`      | no       | `~/.local/state/mcp-notion-mirror/audit.jsonl` | Path to the JSONL audit log.                                                                                           |
| `MCP_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES` | no       | `10485760` (10 MiB)                            | Size-based rotation threshold in bytes. `0` disables rotation.                                                         |
| `MCP_NOTION_MIRROR_AUDIT_LOG_KEEP`      | no       | `5`                                            | Number of rotated audit-log files to retain.                                                                           |

The Notion token is never written to logs, error messages, or tool output.

## Running locally

```bash
bun run server:mcp:dev      # bun --watch, runs the server from TS source
bun run server:mcp:inspect  # MCP Inspector against the TS source
```

Both set `NODE_ENV=development`, so a local `.env.development` is auto-loaded. Copy [`.env.example`](./.env.example) to `.env.development` and fill in your token to get started; it documents every variable from the table above.

## Frontmatter contract

Every publishable note has YAML frontmatter; this MCP touches **only** two fields and never reorders or reformats the rest:

```yaml
---
status: current — May 2026
purpose: <one-line>
notion_source_url: https://www.notion.so/<32hex>
notion_path: Product & Eng (Old) / Platform Architecture / …
notion_mirror_url: https://www.notion.so/<slug>-<32hex> # written by this MCP
notion_mirror_published_at: 2026-05-30T01:13:00Z # written by this MCP, ISO-8601 UTC
---
```

New fields are inserted right after `notion_path` (falling back to `notion_source_url_secondary` / `notion_source_url`). A note with no frontmatter is an error — the MCP never invents one. `notion_source_url`, `mirror:`, and any other field are **orchestrator-owned**: the MCP reads `notion_mirror_url` only.

## Known gaps

See [ROADMAP.md](./ROADMAP.md): local images render as their alt-text path (not uploaded), `[[wikilinks]]` pass through as literal text, and re-publishing changes the mirror URL.
