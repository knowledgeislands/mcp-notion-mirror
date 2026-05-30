# CLAUDE.md

Guidance for Claude Code when working in this repo. The user-facing tool surface, install/config, and Claude Desktop setup live in [README.md](./README.md); this file covers what Claude needs that isn't in README and isn't derivable from one grep.

## What this MCP does

Publishes a single local KB markdown note to Notion under a **caller-supplied parent** and writes the resulting page URL back into the note's frontmatter. It is **file-aware but layout-agnostic**: one `kb_path` per call, no directory walking, no parent resolution, no folder/exclusion conventions. The orchestrator (a skill/script in the calling project) owns all of that. The markdown→blocks step is delegated to `@tryfabric/martian`.

## Bun vs Node

This project uses Bun (≥ 1.3) for install and dev scripts, but the compiled `dist/` runs under Node (≥ 22) — that's what Claude Desktop launches.

- `bun run test` (NOT `bun test` — the latter invokes Bun's own runner instead of vitest).
- Bun auto-loads `.env.${NODE_ENV}` from the CWD; Node needs the explicit `process.loadEnvFile()` call inside `loadConfig()` in [src/config/index.ts](./src/config/index.ts). The try/catch swallows the `TypeError` Bun raises (no `process.loadEnvFile`), so the same code works under both.
- `NODE_ENV` is set to `development` only by `server:mcp:dev` and `server:mcp:inspect`. Claude Desktop doesn't set it, so `.env.*` is ignored in production — `MCP_NOTION_MIRROR_TOKEN` must come from the Claude Desktop config `env` block.

Run `bun run` with no args for the full script list.

## Architecture Invariants

### Project layout & config injection (the workspace MCP shape)

This is the canonical layout we roll out across the MCPs:

- **[src/config/index.ts](./src/config/index.ts)** — `loadConfig(env?) → Config`. Reads env (optionally hydrated from `.env.${NODE_ENV}`) into a plain `Config` value. **There is no module-level config singleton — nothing reads env at import time.**
- **[src/mcp-server/index.ts](./src/mcp-server/index.ts)** — the stdio MCP wrapper. Calls `loadConfig()` once and threads the `Config` into tool registration.
- **[src/tools/](./src/tools/)** — MCP tool definitions only. Thin: validate args, call a `main/` function, map result/throw to an MCP envelope. Excluded from coverage.
- **[src/main/](./src/main/)** — the real implementation, usable outside the MCP server (e.g. from a script). Grouped by concern: `main/notion-client/index.ts` (HTTP layer) and `main/mirror/` (publish/unpublish/move/get + banner, footer, wikilinks, markdown, frontmatter, title-property). Every `main` entry point takes `Config` (or the slice it needs) as its **first argument** — `publishNote(cfg, kbPath, parent, opts)`, `createPage(cfg, params)`. No hidden state.
- **[src/utils/](./src/utils/)** — cross-MCP reusable helpers; keep in sync with sibling repos. These take the **specific config primitive** they need (e.g. `resolveKbNotePath(kbRoot, kbPath)`, `withAuditLog(auditConfig, …)`, `makeAccessGatedRegister(server, accessLevel, audit)`), not the whole `Config`, so they stay MCP-agnostic.

To use the code from a script: `const cfg = loadConfig(); await publishNote(cfg, './note.md', parent, {})`.

### Layering — the MCP owns plumbing, the caller owns policy

| Layer                        | Owns                                                                                       | Frontmatter fields                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **MCP (this repo)**          | Notion API plumbing, markdown→blocks, banner, frontmatter write-back                       | reads/writes `notion_mirror_url`, `notion_mirror_published_at` |
| **Orchestrator (elsewhere)** | file discovery, parent resolution, exclusion/folder conventions, publish order, bulk loops | reads `notion_source_url`, `mirror`, everything else           |

A KB-convention change is a caller change, **never** an MCP version bump. Do not add file-walking, parent-derivation, or a `publish_all` tool here — that's out of scope by design — the MCP is plumbing, not policy.

### Naming convention

Tool names follow `<app>_<resource>_<action>` (snake_case) with `<app>` = `notion_mirror`. Surface (4 tools, all in [src/tools/mirror/index.ts](./src/tools/mirror/index.ts)):

- `notion_mirror_get` (read) · `notion_mirror_publish` (write) · `notion_mirror_move` (write) · `notion_mirror_unpublish` (destructive).

### Thin tools, testable ops

The tool handlers are thin: validate args (zod), call one function in [src/main/mirror/index.ts](./src/main/mirror/index.ts), map the result/throw to an MCP envelope via `jsonResult` / `errorResult`. **All pipeline logic lives in `main/mirror/index.ts`** (`publishNote` / `unpublishNote` / `moveNote` / `getNote`, each taking `cfg` first) so every branch is unit-testable against a real temp file + a mocked Notion `fetch`. `src/tools/**/index.ts` is excluded from coverage — never put logic there.

### Access-level gate — driven by annotations, not names

[src/utils/access-level.ts](./src/utils/access-level.ts) `makeAccessGatedRegister(server, accessLevel, audit)` decides at startup whether to register each tool from `config.annotations`: `readOnlyHint:true → read`; `destructiveHint:true → destructive`; both explicitly `false → write`; anything else → `destructive` (fail-safe). A tool registers when its derived level is ≤ `cfg.accessLevel` (**default `write`** — this MCP is a publisher; `read` exposes only `get`, `destructive` adds `unpublish`). Presets live in [src/utils/annotations.ts](./src/utils/annotations.ts) (`READ_ONLY_REMOTE`, `WRITE_REMOTE`, `DESTRUCTIVE_REMOTE`) — every tool is open-world (calls Notion). New tools MUST set `annotations` to one of those presets.

### Single HTTP client

All Notion API calls go through [src/main/notion-client/index.ts](./src/main/notion-client/index.ts): `createPage` / `updatePage` / `archivePage` / `setPageParent` / `getPage` / `getDatabase` / `getBlockChildren` / `appendBlockChildren` / `deleteBlock`. Every one takes a `NotionConfig` (the `notionToken`/`notionApiBaseUrl`/`notionApiVersion` slice of `Config`) as its first argument. It owns the Bearer header, `Notion-Version`, JSON content-type, the API-error→`NotionApiError` translation, and the 100-block-per-request cap (`createPage` appends overflow via PATCH /v1/blocks/{id}/children). Reuse it — no tool builds a raw `fetch`.

### Notion ids: normalize before they hit a URL path

`normalizeId()` accepts a bare 32-hex id **or** a dashed UUID (callers may pass either as `parent.page_id`/`database_id`), lowercases, strips dashes, and throws on anything else. Every id substituted into an API path goes through it. Parent objects are passed to Notion **verbatim in the request body** (not the URL), so they're zod-format-validated only — not asserted (no path-injection risk).

### Title property depends on the parent kind

Under a `database_id` parent the title goes in the database's title-typed property (name varies per wiki; discovered + cached in [src/main/mirror/title-property.ts](./src/main/mirror/title-property.ts) via `GET /v1/databases/{id}`). Under a `page_id` parent the new page is a child page and Notion only accepts the reserved `title` property — **no lookup, no walk-up** (this is the proven behavior; do not "resolve" a database for page parents). Handled in `notion-client` `titleProperties`.

### `move` and the cross-parent-type silent failure

`PATCH /v1/pages` silently ignores a parent change that crosses the page-id ↔ database-id boundary. `moveNote` detects it: it `GET`s the parent before, PATCHes, and — only when the parent **type** changed — re-`GET`s and errors if the parent is unchanged. Keep this guard.

### Banner

[src/main/mirror/banner.ts](./src/main/mirror/banner.ts) builds the 📘 callout from a template string the caller passes (`cfg.bannerTemplate`; `{date}` interpolated, `**bold**` via martian's `markdownToRichText`). An **empty** template returns `undefined` → publish omits the banner; if the body is also empty, publish errors (`Nothing to publish …`).

### Frontmatter is edited by line surgery, NOT a YAML round-trip

[src/main/mirror/frontmatter.ts](./src/main/mirror/frontmatter.ts) regex-matches the leading `---\n…\n---\n` block and edits per-line. `js-yaml` / `yaml` reorder keys and rewrite escaping, which would corrupt the KB's strict field-order rules. `upsertFrontmatterFields` replaces existing fields in place and inserts new ones after `notion_path` (falling back to `notion_source_url_secondary` / `notion_source_url`). The exact-string round-trip tests in [src/main/mirror/frontmatter.test.ts](./src/main/mirror/frontmatter.test.ts) guard against accidental reformatting — keep them green.

## Security Requirements

This server holds a Notion token, reads a user-supplied path, and writes back to KB notes. New tools and changes MUST preserve every invariant:

1. **The token never leaves the process unredacted.** Read in [src/config/index.ts](./src/config/index.ts), attached as the Bearer header in [src/main/notion-client/index.ts](./src/main/notion-client/index.ts) only. `NotionApiError` carries status/code/body — never the token. Tests assert the token never appears in error messages.
2. **Every `kb_path` runs through [src/utils/paths.ts](./src/utils/paths.ts) before any `fs.*` call.** `resolveKbNotePath(cfg.kbRoot, kbPath)` — two-layer guard: lexical (`..` rejected; confinement under `kbRoot` when set) plus realpath of the deepest existing ancestor (catches symlink escapes). When `kbRoot` is undefined, relative paths are rejected and absolute paths accepted unconfined (caller's responsibility). There is **no** `Pillars/` confinement — the MCP is layout-agnostic. Schemas in [src/tools/mirror/index.ts](./src/tools/mirror/index.ts) also reject `..` at the zod layer.
3. **Notion ids are validated before substitution into an API path** via `normalizeId()` (see above). `extractPageIdFromUrl()` pulls a 32-hex id out of `notion_mirror_url`; a malformed URL errors before any call.
4. **Destructive tools default to `dry_run: true`.** `notion_mirror_unpublish` only calls Notion / edits the note when `dry_run` is explicitly `false`. The `destructive` access level is opt-in.
5. **Frontmatter write-backs are atomic.** `atomicWriteFile()` in [src/utils/atomic-write.ts](./src/utils/atomic-write.ts) writes a temp file then renames.
6. **Zod schemas are `.strict()` with bounded sizes.** `kb_path` caps at 4096 chars; `parent.page_id`/`database_id` are regex-validated (32-hex or dashed UUID). Add bounds for every new field.
7. **Errors return via `errorResult(...)`, not `throw`** at the tool boundary. `main/mirror` functions throw; the handler catches and maps. The audit-log wrapper depends on the `isError` envelope to log failures.

## Testing

- `bun run test:coverage` enforces 100% line/branch/function/statement coverage. The aggregators (`src/mcp-server/index.ts`, `src/tools/**/index.ts`) and the pure-data `src/utils/annotations.ts` are excluded — everything else stays fully covered. Pipeline logic lives in `main/mirror/index.ts` precisely so it's covered. Tests are co-located (`index.test.ts` beside `index.ts`).
- Real Notion API calls are out of tests — the client is exercised through `fetch` mocks (`vi.stubGlobal('fetch', …)`).
- Because config is injected (not read at import), tests build a `Config`/`NotionConfig`/`AuditConfig` literal and pass it — no `vi.resetModules()` + env dance. (A couple of modules keep process-lifetime caches — the title-property cache, the audit-log append queue/chmod flag — so their tests call the exported `_clear…`/reset hook or are still isolated as noted in-file.)
- `bun run test:smoke` boots the built server over stdio and asserts the 4-tool wire surface. Keep `scripts/smoke.ts` `EXPECTED_TOOLS` in sync with the registration sites.

## Tool registration call sites

Tools are registered in [src/tools/mirror/index.ts](./src/tools/mirror/index.ts). To survey the surface, `grep "registerTool" src/tools/*/index.ts`. README's [Tools](./README.md#tools) section tabulates them with purposes and I/O shapes.
