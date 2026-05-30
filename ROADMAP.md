# Roadmap

Forward-looking plans only. What the tool does today lives in [README.md](./README.md).

## Current limitations

These are known limitations of the current behaviour, not bugs:

1. **Images.** KB notes that reference local images render the image as alt-text + path rather than a real Notion image. Notion needs the file uploaded via `POST /v1/file_uploads` and referenced as an `image` block with `type: file_upload`; data URIs are rejected by Notion.
2. **Unresolved wikilinks.** `[[X]]` becomes a Notion `@`mention only when a `link_map` entry for `X` exists (the subtree tools build this from published notes). Targets not yet mirrored render as italic placeholder text.

## Next up

- **Image upload pipeline** — resolve `<Note> - images/` siblings, upload via `POST /v1/file_uploads`, and swap the alt-text placeholder paragraphs for real `image` blocks.
- **`notion_mirror_diff`** — show the block-level diff a publish/republish would produce without writing, so callers can review before mutating.

## Future ideas

- **Backlink sync** — write the mirror's inbound links back into the KB note for a fuller provenance trail.
- **Live integration test** — a token-gated `*.live.test.ts` (skipped by default) for occasional end-to-end verification against a throwaway Notion workspace, in particular the `notion_mirror_move` cross-parent-type silent-failure detection.
