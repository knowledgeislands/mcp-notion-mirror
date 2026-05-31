# Contributing

Thanks for your interest. This file covers the dev loop, conventions, and what to check before you open a PR.

## Setup

You'll need [Bun](https://bun.sh) 1.3+ for the dev loop, and Node.js 22+ to run the compiled `dist/` output the published package ships.

```bash
git clone https://github.com/knowledgeislands/mcp-kb-notion-mirror.git
cd mcp-kb-notion-mirror
bun install
```

`bun install` triggers `prepare` which configures the husky pre-commit hook — so every commit will auto-run `lint-staged` and format your changes.

## Dev loop

```bash
bun run server:mcp:dev      # bun --watch — runs the server from source
bun run server:mcp:inspect  # MCP Inspector against the TS source
bun run lint:types          # tsc --noEmit
bun run test                # vitest (use `bun run test`, not `bun test`)
bun run test:watch          # vitest in watch mode
bun run test:coverage       # vitest with v8 coverage (100% thresholds)
bun run lint:check          # Biome lint + format check
bun run lint:fix            # Biome auto-fix
bun run lint:md             # prettier + markdownlint for *.md
bun run build               # tsc -p tsconfig.build.json → dist/
```

You'll need a Notion internal-integration secret in `MCP_KB_NOTION_MIRROR_TOKEN` and a KB root in `MCP_KB_NOTION_MIRROR_KB_ROOT` for any live publishing — see [README.md](./README.md#setup). The `subtree` to mirror and the Notion `parent` it attaches under are passed per call (tool args / CLI flags), not via env. Unit tests need none of this: the Notion client is exercised through `fetch` mocks and config is injected via `loadConfig(env)` literals.

## Conventions

### Code

- **TypeScript ES modules** — `"type": "module"`, internal imports use `.js` extensions (e.g. `from '../notion-client/index.js'`) so `tsc` emits valid JS.
- **Arrow functions** for top-level declarations (`export const foo = () => …`).
- **Config is injected, not imported as a singleton** — `loadConfig()` (in `src/config/index.ts`) builds a `Config`; `main/` functions take it (or its needed slice) as the first arg. Nothing reads env at import time.
- **No bare `fetch`** in tool callbacks — go through `src/main/notion-client/index.ts` so auth, the `Notion-Version` header, encoding, the 100-block chunking, and error translation stay centralised.
- **No bare `fs.*` on a user path** — resolve through `src/utils/paths.ts` first (`resolveKbNotePath(kbRoot, kbPath)`), for both `kb_path` and `subtree`. Write-backs go through `atomicWriteFile`.
- **Nothing reachable from a tool writes to stdout** — the MCP speaks JSON-RPC over stdout. The `src/main/` library returns structured data and never logs; only `src/cli/cli.ts` (not a tool) prints.
- **No YAML round-trip** — edit frontmatter by line surgery in `src/main/mirror/frontmatter.ts`; a YAML library would reorder keys and rewrite escaping.
- **Input validation**: every `kb_path` / `root` carries the `..`-rejecting refine and a length bound. Notion ids are validated with `normalizeId` before hitting an API path. New schemas must continue this.
- **Errors**: tools return MCP errors via `errorResult(...)`; structured results via `jsonResult(...)`. Never `throw` from a tool callback — the audit-log wrapper depends on the MCP `isError` envelope.
- **Annotations**: be honest with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on every tool registration. Use a preset from `src/utils/annotations.ts`.

### Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) so version bumps are easy to derive when releasing by hand. There is no auto-release pipeline.

| Type        | What it means           | Bumps |
| ----------- | ----------------------- | ----- |
| `feat:`     | new feature             | minor |
| `fix:`      | bug fix                 | patch |
| `perf:`     | performance improvement | patch |
| `docs:`     | documentation only      | patch |
| `deps:`     | dependency change       | patch |
| `refactor:` | internal restructuring  | none  |
| `test:`     | test-only changes       | none  |
| `chore:`    | tooling, config         | none  |
| `build:`    | build pipeline          | none  |
| `ci:`       | CI changes              | none  |

Add `!` for breaking changes (`feat!:` / `fix!:`) — bumps major.

### Testing

- New code ships with tests. Vitest is configured with V8 coverage and **100% thresholds** (line/branch/function/statement) — the aggregator `index.ts` files, `src/cli/cli.ts`, and the pure-data `src/utils/annotations.ts` + `src/utils/notion-args.ts` are excluded; everything else (including the `src/main/` library, e.g. `main/trees/discover.ts`) must stay fully covered.
- The Notion client is exercised through `fetch` mocks (`vi.stubGlobal('fetch', …)`), not a real network.
- Frontmatter parsing/writing has round-trip exact-string fixtures — a reformatting regression fails the test.

## Before opening a PR

- [ ] `bun run lint:check` passes
- [ ] `bun run lint:types` passes
- [ ] `bun run test:coverage` passes (no threshold failures)
- [ ] `bun run build` passes
- [ ] Commit messages follow Conventional Commits
- [ ] If you added a new tool, update `README.md`'s Tools section, `CLAUDE.md`'s tool registration call sites note, and `scripts/smoke.ts`'s `EXPECTED_TOOLS`

CI runs lint, types, and coverage on every PR.
