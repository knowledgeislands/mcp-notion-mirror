# CLAUDE.md

Guidance for Claude Code when working in this repo. The user-facing tool surface, install/config, and Claude Desktop setup live in [README.md](./README.md); this file covers what Claude needs that isn't in README and isn't derivable from one grep.

## What this MCP does

Mirrors KB markdown notes into Notion and writes the resulting page URL back into each note's frontmatter. Two layers of tools:

- **Per-note mirror tools** (`notion_mirror_*`) — publish/move/unpublish/get one `kb_path` under a caller-supplied Notion `parent`. File-aware but layout-agnostic: no directory walking, no parent resolution.
- **Subtree orchestrator tools** (`notion_mirror_tree_*`) — walk a caller-supplied `subtree` folder under `cfg.kbRoot`, apply the folder-index hierarchy convention, and attach the subtree-root under a caller-supplied `parent`. Built on top of the per-note ops.

There is **no fixed root folder and no fixed wiki database**. The `subtree` and `parent` are supplied per call (tool args / CLI flags), never via env. The markdown→blocks step is delegated to `@tryfabric/martian`.

## Bun vs Node

This project uses Bun (≥ 1.3) for install and dev scripts, but the compiled `dist/` runs under Node (≥ 22) — that's what Claude Desktop launches.

- `bun run test` (NOT `bun test` — the latter invokes Bun's own runner instead of vitest).
- Bun auto-loads `.env.${NODE_ENV}` from the CWD; Node needs the explicit `process.loadEnvFile()` call inside `loadConfig()` in [src/config/index.ts](./src/config/index.ts). The try/catch swallows the `TypeError` Bun raises (no `process.loadEnvFile`), so the same code works under both.
- `NODE_ENV` is set to `development` only by `server:mcp:dev` and `server:mcp:inspect`. Claude Desktop doesn't set it, so `.env.*` is ignored in production — `MCP_KB_NOTION_MIRROR_TOKEN` must come from the Claude Desktop config `env` block.

Run `bun run` with no args for the full script list.

## Architecture Invariants

### Project layout & config injection (the workspace MCP shape)

- **[src/config/index.ts](./src/config/index.ts)** — `loadConfig(env?) → Config`. Reads env (optionally hydrated from `.env.${NODE_ENV}`) into a plain `Config` value. **There is no module-level config singleton — nothing reads env at import time.**
- **[src/mcp-server/index.ts](./src/mcp-server/index.ts)** — the stdio MCP wrapper. Calls `loadConfig()` once, wires the access gate, and threads the `Config` into `registerMirrorTools` then `registerTreeTools`. Excluded from coverage.
- **[src/tools/](./src/tools/)** — MCP tool definitions only. Thin: validate args (zod), confine paths, call a `main/`-or-`orchestrator/` function, map result/throw to an MCP envelope via `jsonResult`/`errorResult`. `src/tools/**/index.ts` is excluded from coverage — never put logic there.
- **[src/main/](./src/main/)** — the per-note implementation: `main/notion-client/index.ts` (HTTP layer) and `main/mirror/` (publish/unpublish/move/get + banner, footer, wikilinks, markdown, frontmatter, title-property). Every entry point takes `Config` (or its needed slice) as its first argument.
- **[src/orchestrator/](./src/orchestrator/)** — the subtree layer. `discover.ts` (pure FS: discover/publishOrder/resolveParent/buildLinkMap/iconFor), `settings.ts` (`loadOrchestratorSettings`), `api.ts` (preflight/status/pass1/pass2/publishAll/publishOne/unpublishOne — **returns structured data, NO console.\***), `cli.ts` (the `mcp-kb-notion-mirror-publish` bin — does all human-readable printing; coverage-excluded), `index.ts` (re-exports). The subtree ops take `(kbRoot|cfg, subtree, [parent], settings, …)`.
- **[src/utils/](./src/utils/)** — cross-MCP reusable helpers that take the specific config primitive they need (`resolveKbNotePath(kbRoot, kbPath)`, `withAuditLog(auditConfig, …)`, `makeAccessGatedRegister(server, accessLevel, audit)`). `notion-args.ts` holds the shared `parentArg`/`notionId` zod schemas; it and `annotations.ts` are pure data and coverage-excluded.

To use the code from a script: `const cfg = loadConfig(); await publishAll(cfg, 'Pillars/Engineering', { type: 'database_id', database_id }, loadOrchestratorSettings(), { dryRun: true })`.

### Nothing reachable from a tool may write to stdout

The MCP speaks JSON-RPC over stdout. `orchestrator/api.ts` therefore **returns** structured data and never logs — the only `console.*` lives in `cli.ts` (not a tool) and in `main/mirror/index.ts`'s footer-refresh path which uses `console.error` (stderr, not stdout). `api.test.ts` asserts the api layer makes no `console.log`/`console.error` calls. Keep it that way: when adding orchestrator logic, return data; let the CLI print it.

### The folder-index convention (orchestrator/discover.ts)

`resolveParent(n, subtree, rootParent, urlByKbPath)`:

- `folderKbPath = dirname(n.kbPath)`.
- index note (`base === parentFolder`): if `folderKbPath === subtree` → `rootParent`; else look up the index of the **grandparent** folder (`dirname(folderKbPath)`) in `urlByKbPath` → `page_id` parent (throws if missing/bad URL).
- leaf note: look up the index of `folderKbPath` → `page_id` parent.

`publishOrder` is DFS preorder from the subtree dir (index first, then leaves alphabetically, then sub-folders). `publishOne` walks the ancestor chain up to the subtree-root index so an unpublished ancestor is created first.

### Naming convention

Tool names follow `<app>_<resource>_<action>` (snake_case) with `<app>` = `notion_mirror`. Surface (7 tools):

- per-note: `notion_mirror_get` (read) · `notion_mirror_publish` (write) · `notion_mirror_move` (write) · `notion_mirror_unpublish` (destructive) — all in [src/tools/mirror/index.ts](./src/tools/mirror/index.ts).
- subtree: `notion_mirror_tree_status` (read) · `notion_mirror_tree_preflight` (read) · `notion_mirror_tree_publish` (destructive) — all in [src/tools/tree/index.ts](./src/tools/tree/index.ts).

The wire names keep the `notion_mirror_*` namespace; only the package/env/server identity carries the `kb` prefix (`mcp-kb-notion-mirror`, `MCP_KB_NOTION_MIRROR_*`).

### Access-level gate — driven by annotations, not names

[src/utils/access-level.ts](./src/utils/access-level.ts) `makeAccessGatedRegister(server, accessLevel, audit)` derives each tool's level from `config.annotations`: `readOnlyHint:true → read`; `destructiveHint:true → destructive`; both explicitly `false → write`; anything else → `destructive` (fail-safe). A tool registers when its derived level is ≤ `cfg.accessLevel` (**default `write`**). Presets in [src/utils/annotations.ts](./src/utils/annotations.ts): `READ_ONLY_REMOTE`, `WRITE_REMOTE`, `DESTRUCTIVE_REMOTE` (every tool is open-world — it calls Notion). `notion_mirror_tree_publish` is `DESTRUCTIVE_REMOTE` (bulk mutation, defaults to dry-run); the tree read tools are `READ_ONLY_REMOTE`. New tools MUST set `annotations` to one of those presets.

### Single HTTP client

All Notion API calls go through [src/main/notion-client/index.ts](./src/main/notion-client/index.ts). Every call takes a `NotionConfig` slice first. It owns the Bearer header, `Notion-Version`, JSON content-type, the API-error→`NotionApiError` translation, and the 100-block-per-request cap. Reuse it — no tool builds a raw `fetch`.

### Notion ids: normalize before they hit a URL path

`normalizeId()` accepts a bare 32-hex id or a dashed UUID, lowercases, strips dashes, throws otherwise. Every id substituted into an API path goes through it. Parent objects go to Notion verbatim in the request body (not the URL), so they're zod-format-validated only.

### `move` and the cross-parent-type silent failure

`PATCH /v1/pages` silently ignores a parent change crossing the page-id ↔ database-id boundary. `moveNote` (and `publishNote` replace) detect it by GETting the parent before, PATCHing, and — only when the parent type changed — re-GETting and erroring if unchanged. Keep this guard.

### Frontmatter is edited by line surgery, NOT a YAML round-trip

[src/main/mirror/frontmatter.ts](./src/main/mirror/frontmatter.ts) regex-matches the leading block and edits per-line. A YAML library would reorder keys and rewrite escaping, corrupting the KB's strict field-order rules. Exact-string round-trip tests guard this — keep them green.

## Security Requirements

This server holds a Notion token, reads user-supplied paths, and writes back to KB notes. New tools and changes MUST preserve every invariant:

1. **The token never leaves the process unredacted.** Read in [src/config/index.ts](./src/config/index.ts), attached as the Bearer header in [src/main/notion-client/index.ts](./src/main/notion-client/index.ts) only. `NotionApiError` carries status/code/body — never the token.
2. **Every `kb_path` and `subtree` runs through [src/utils/paths.ts](./src/utils/paths.ts) before any `fs.*` call.** `resolveKbNotePath(cfg.kbRoot, p)` — lexical (`..` rejected; confined under `kbRoot` when set) plus realpath of the deepest existing ancestor (catches symlink escapes). The tree tools confine BOTH `subtree` and `kb_path` under `cfg.kbRoot` before walking. Schemas also reject `..` at the zod layer.
3. **Notion ids are validated before substitution into an API path** via `normalizeId()`. `extractPageIdFromUrl()` pulls the id out of `notion_mirror_url`; a malformed URL errors before any call.
4. **Destructive tools default to `dry_run: true`.** `notion_mirror_unpublish` and `notion_mirror_tree_publish` only mutate when `dry_run` is explicitly `false`. The `destructive` access level is opt-in.
5. **Frontmatter write-backs are atomic** via `atomicWriteFile()`.
6. **Zod schemas are `.strict()` with bounded sizes.** `kb_path` / `subtree` cap at 4096 chars; `parent` ids are regex-validated (32-hex or dashed UUID) via the shared `parentArg` in [src/utils/notion-args.ts](./src/utils/notion-args.ts).
7. **Errors return via `errorResult(...)`, not `throw`** at the tool boundary. `main`/`orchestrator` functions throw; the handler catches and maps. The audit-log wrapper depends on the `isError` envelope.
8. **Nothing reachable from a tool writes to stdout.** See [the stdout invariant](#nothing-reachable-from-a-tool-may-write-to-stdout) above.

## Testing

- `bun run test:coverage` enforces 100% line/branch/function/statement coverage. Excluded: `src/mcp-server/index.ts`, `src/tools/**/index.ts`, `src/orchestrator/cli.ts` (entry points / wiring), and the pure-data `src/utils/annotations.ts` + `src/utils/notion-args.ts`. Everything else — including `orchestrator/api.ts` and `orchestrator/discover.ts` — stays fully covered. Tests are co-located.
- Real Notion API calls are out of tests — the client is exercised through `fetch` mocks (`vi.stubGlobal('fetch', …)`). `orchestrator/api.test.ts` uses a small stateful fetch stub (records each created page's parent so the cross-parent-type guard doesn't false-fire on replace).
- Config is injected, so tests build a `Config`/`OrchestratorSettings` literal and pass it. A couple of modules keep process-lifetime caches (title-property cache, audit-log append queue) — their tests use the exported reset hook.
- `bun run test:smoke` boots the built server over stdio and asserts the 7-tool wire surface. Keep `scripts/smoke.ts` `EXPECTED_TOOLS` in sync with the two registration sites.

## Tool registration call sites

Tools are registered in [src/tools/mirror/index.ts](./src/tools/mirror/index.ts) and [src/tools/tree/index.ts](./src/tools/tree/index.ts). To survey the surface, `grep -r "registerTool" src/tools`. README's [Tools](./README.md#tools) section tabulates all 7 with purposes and I/O shapes.
