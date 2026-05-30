/**
 * Child-pages footer maintenance.
 *
 * Notion already renders a parent's child pages inline as native `child_page`
 * blocks (clickable, with their own icons). The footer's only job is to LABEL
 * that section with a single "Child Pages" heading sitting immediately above
 * those native links — we do NOT duplicate the children as a bulleted mention
 * list. The footer is MIRROR-ONLY: never written into the KB source.
 *
 * The heading is identifiable by a sentinel `heading_2` whose text is exactly
 * `Child Pages`. A future "read mirror back into the KB" path MUST recognise
 * this sentinel and strip it before importing.
 *
 * `refreshFooter` regenerates the heading: it removes any prior footer heading
 * (and legacy mention bullets that followed it), then — if the page has any
 * child pages — inserts a single heading right before the first one. New child
 * pages Notion appends at the end naturally fall under the heading. Refreshes
 * are serialised per parent id (in-memory lock) so concurrent sibling
 * publishes don't race.
 */
import { appendBlockChildren, deleteBlock, getBlockChildren, type NotionBlock, type NotionConfig } from '../notion-client/index.js'

/** The sentinel heading text that marks the footer. */
export const SENTINEL_TEXT = 'Child Pages'
/** The pre-1.x footer heading (with a folder emoji); recognised so it gets cleaned up. */
const LEGACY_SENTINEL_TEXT = '📂 Child Pages'

/** The footer: a single "Child Pages" sentinel heading. */
export const buildFooterBlocks = (): Record<string, unknown>[] => [{ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: SENTINEL_TEXT } }] } }]

const blockText = (block: NotionBlock): string => {
  const rt = (block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text
  return Array.isArray(rt) ? rt.map((t) => t.plain_text ?? '').join('') : ''
}

const isSentinel = (block: NotionBlock): boolean => {
  if (block.type !== 'heading_2') return false
  const text = blockText(block)
  return text === SENTINEL_TEXT || text === LEGACY_SENTINEL_TEXT
}

const doRefresh = async (cfg: NotionConfig, parentPageId: string): Promise<void> => {
  const blocks = await getBlockChildren(cfg, parentPageId)
  const hasChildren = blocks.some((b) => b.type === 'child_page')

  // Remove the existing footer: the sentinel heading and any following blocks
  // that are NOT child pages (legacy mention bullets). Child pages are spared —
  // they are real sub-pages and Notion appends new ones after the footer.
  const sentinelIdx = blocks.findIndex(isSentinel)
  const deleted = new Set<string>()
  if (sentinelIdx !== -1) {
    for (const block of blocks.slice(sentinelIdx)) {
      if (block.type !== 'child_page') {
        await deleteBlock(cfg, block.id)
        deleted.add(block.id)
      }
    }
  }

  if (!hasChildren) return // no children → no heading (don't leave an orphan)

  // Insert one heading immediately before the first child page so it heads the
  // native child links. `after` anchors it to the block just before that child
  // (undefined when a child page is the very first block → heading goes last).
  let anchorId: string | undefined
  let prevId: string | undefined
  for (const block of blocks) {
    if (deleted.has(block.id)) continue
    if (block.type === 'child_page') {
      anchorId = prevId
      break
    }
    prevId = block.id
  }
  await appendBlockChildren(cfg, parentPageId, buildFooterBlocks(), anchorId)
}

const footerLocks = new Map<string, Promise<unknown>>()

/**
 * Regenerate a parent page's "Child Pages" heading from its current Notion-side
 * children. Idempotent and serialised per parent id so concurrent calls for the
 * same parent run one-at-a-time. The returned promise rejects if THIS refresh
 * fails; the per-parent chain continues regardless.
 */
export const refreshFooter = (cfg: NotionConfig, parentPageId: string): Promise<void> => {
  // The stored promise is always already-caught, so `prev` never rejects.
  const prev = footerLocks.get(parentPageId) ?? Promise.resolve()
  const next = prev.then(() => doRefresh(cfg, parentPageId))
  footerLocks.set(
    parentPageId,
    next.catch(() => {})
  )
  return next
}
