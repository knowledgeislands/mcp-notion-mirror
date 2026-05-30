# Roadmap

Forward-looking plans only. Shipped features live in [README.md](./README.md); release history lives in [CHANGELOG.md](./CHANGELOG.md) and the git log.

## Known gaps (deferred)

These are _known_ limitations, not bugs:

1. **Images.** Many KB notes reference local PNGs (`<Note Name> - images/foo.png`). Notion needs these uploaded via `POST /v1/file_uploads`, then referenced as `image` blocks with `type: file_upload`. The current iteration **skips** images: `@tryfabric/martian` renders a markdown image as a paragraph containing the alt text + path, which is visually obvious as "this needs fixing". Inlining data URIs is not an option — Notion rejects them.
2. **Unresolved wikilinks.** `[[X]]` resolves to a Notion `mention` only when the caller supplies a `link_map` entry for `X` (see Shipped); targets the caller hasn't mirrored yet still render as italic placeholder text rather than a live link.

## Next Up

- **Image upload pipeline** — resolve `<Note> - images/` siblings, upload via `POST /v1/file_uploads`, swap the alt-text placeholder paragraphs for real `image` blocks.
- **`notion_mirror_diff`** — show the block-level diff a publish/republish would produce without writing, so callers can review before mutating.

## Future Advanced Capabilities

- **Backlink sync** — write the mirror's inbound links back into the KB note for a fuller provenance trail.

## Tooling

- Live integration test gated behind a real token env var (`src/**/*.live.test.ts`), skipped by default, for occasional end-to-end verification against a throwaway Notion workspace — in particular to confirm the `notion_mirror_move` cross-parent-type silent-failure detection behaves against the live API.

## Shipped

- **Links, icons, footer & in-place update.** `notion_mirror_publish` gained `link_map` (caller-supplied `[[wikilink]]` → mirror-URL map; resolved links render as Notion `mention`s, unresolved as italic text) and `icon`; page-parented mirror pages get an auto-maintained `Child Pages` footer heading. Publish also gained a tri-state `mode` — `create` / `replace` (in-place body+property update that **preserves the page URL**, enabling stable `@mention` resolution across passes) / `force` (archive + recreate); the old `force: true` boolean is a deprecated alias for `mode: "force"`.
- **v1.0.0 — File-aware publisher rewrite.** Clean break: the tool surface is now `notion_mirror_publish` / `notion_mirror_move` / `notion_mirror_unpublish` / `notion_mirror_get`, each taking `kb_path` (+ a caller-supplied Notion `parent` for mutations). All orchestration — file discovery, parent resolution, folder/exclusion conventions, publish order — moved to the caller. `MCP_NOTION_MIRROR_WIKI_DATABASE_ID` is gone; the banner is now a `{date}` template (`MCP_NOTION_MIRROR_BANNER_TEMPLATE`, empty = disabled). The prior surface (`notion_mirror_note_*`, `notion_mirror_unpublished_list`, hierarchy auto-derivation from v0.1–v0.3) is removed.
