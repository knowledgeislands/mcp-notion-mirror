/**
 * Markdown → Notion block conversion for the publish pipeline.
 *
 * The body conversion is delegated to `@tryfabric/martian`
 * (`markdownToBlocks`), which handles paragraphs, headings, lists (incl.
 * nested), code fences, blockquotes, dividers, GFM tables, inline formatting,
 * and links. Two KB-specific transforms wrap it: stripping the frontmatter and
 * a leading `# Title` H1 (Notion takes the title from a page property). The
 * banner is prepended separately (see src/banner.ts) by the publish pipeline.
 *
 * Known gaps (tracked in ROADMAP.md): local image references render as their
 * alt-text paragraph rather than uploaded images, and `[[wikilinks]]` pass
 * through as literal text.
 */
import * as path from 'node:path'
import { markdownToBlocks } from '@tryfabric/martian'

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/

/** Drop the leading `---\n…\n---\n` frontmatter block, if present. */
export const stripFrontmatter = (text: string): string => text.replace(FRONTMATTER_RE, '').replace(/^\n+/, '')

/** Drop the first H1 (`# Title`) line — Notion gets the title from a page property. */
export const stripLeadingH1 = (text: string): string => {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.trim() !== '')
  if (idx !== -1 && /^#\s+/.test(lines[idx] as string)) lines.splice(idx, 1)
  return lines.join('\n')
}

/** Page title = the note's basename minus the `.md` extension. */
export const titleFromPath = (kbPath: string): string => path.basename(kbPath).replace(/\.md$/i, '')

/**
 * Convert a markdown body (frontmatter + leading H1 already stripped) to Notion
 * blocks. `martian` is run with `notionLimits.truncate` so per-block
 * rich-text/character limits never produce an API-rejecting payload.
 */
export const bodyToBlocks = (markdownBody: string): unknown[] => markdownToBlocks(markdownBody, { notionLimits: { truncate: true } })
