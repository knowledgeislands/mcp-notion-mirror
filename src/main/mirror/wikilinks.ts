/**
 * Wikilink → Notion @mention conversion.
 *
 * KB notes use `[[target]]` / `[[target|display]]` wikilinks. The orchestrator
 * supplies a `link_map` (wikilink target → mirror page URL) for the targets it
 * knows are already published; the MCP does not walk the KB to build it.
 *
 * Two pure phases (this module owns both, no `fs`, no network):
 *   1. `rewriteWikilinks` (string → string), run AFTER frontmatter strip but
 *      BEFORE martian. Resolved targets become a placeholder markdown link
 *      `[display](mention:<page_id>)`; unresolved targets become *italic* text
 *      so a broken KB reference is visible but not clickable.
 *   2. `convertMentionPlaceholders` (blocks → blocks), run on martian's output:
 *      every rich-text element whose link URL is `mention:<id>` becomes a real
 *      Notion page-mention rich-text object.
 */

const MENTION_PREFIX = 'mention:'
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
const PAGE_ID_RE = /([a-f0-9]{32})(?:$|\?|#)/

/** The 32-hex page id embedded in a notion.so URL, or undefined. */
const extractPageId = (url: string): string | undefined => url.match(PAGE_ID_RE)?.[1]

/** Default visible text for a bare `[[target]]`: the target's last path segment, sans `.md`. */
const basenameOf = (target: string): string => {
  const segments = target.split('/')
  // split() always yields a non-empty array, so the last element is a string.
  return (segments[segments.length - 1] as string).replace(/\.md$/i, '').trim()
}

/**
 * Rewrite `[[…]]` wikilinks to markdown martian can carry through. A target
 * present in `linkMap` (with a URL we can pull a page id from) becomes a
 * `mention:` placeholder link; everything else becomes italic plain text.
 */
export const rewriteWikilinks = (markdown: string, linkMap: Record<string, string>): string =>
  markdown.replace(WIKILINK_RE, (_match, rawTarget: string, rawDisplay: string | undefined) => {
    const target = rawTarget.trim()
    const text = (rawDisplay ?? basenameOf(target)).trim()
    const url = linkMap[target]
    const pageId = url ? extractPageId(url) : undefined
    return pageId ? `[${text}](${MENTION_PREFIX}${pageId})` : `*${text}*`
  })

interface RichTextItem {
  type?: string
  text?: { content?: string; link?: { url?: string } | null }
  [k: string]: unknown
}

const toMention = (item: RichTextItem): RichTextItem => {
  const url = item.text?.link?.url
  if (item.type === 'text' && typeof url === 'string' && url.startsWith(MENTION_PREFIX)) {
    const pageId = url.slice(MENTION_PREFIX.length)
    return { type: 'mention', mention: { type: 'page', page: { id: pageId } }, plain_text: item.text?.content ?? '' }
  }
  return item
}

/**
 * Walk a martian block tree and turn every `mention:` placeholder link into a
 * Notion page-mention rich-text object. Generic over martian's nesting: it
 * transforms any `rich_text` array it finds at any depth and recurses
 * everywhere else. Pure — returns a new tree, mutates nothing.
 */
export const convertMentionPlaceholders = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(convertMentionPlaceholders)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = key === 'rich_text' && Array.isArray(value) ? value.map((item) => toMention(item as RichTextItem)) : convertMentionPlaceholders(value)
    }
    return out
  }
  return node
}
