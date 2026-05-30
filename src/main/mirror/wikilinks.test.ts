import { describe, expect, it } from 'vitest'
import { convertMentionPlaceholders, rewriteWikilinks } from './wikilinks.js'

const HEX = '3709f7187cc2814e8652f99fd36857ff'
const MAP = { 'Product Delivery': `https://www.notion.so/Product-Delivery-${HEX}`, 'Docs/Guide': `https://www.notion.so/${HEX}?pvs=4` }

describe('rewriteWikilinks', () => {
  it('rewrites a resolved [[target]] to a mention placeholder link using the basename as text', () => {
    expect(rewriteWikilinks('See [[Product Delivery]].', MAP)).toBe(`See [Product Delivery](mention:${HEX}).`)
  })

  it('uses the basename (last path segment, no .md) for a resolved path target', () => {
    expect(rewriteWikilinks('See [[Docs/Guide]].', MAP)).toBe(`See [Guide](mention:${HEX}).`)
  })

  it('honours an explicit display for a resolved link', () => {
    expect(rewriteWikilinks('See [[Product Delivery|the plan]].', MAP)).toBe(`See [the plan](mention:${HEX}).`)
  })

  it('renders an unresolved [[target]] as italic text', () => {
    expect(rewriteWikilinks('See [[Unknown Note]].', MAP)).toBe('See *Unknown Note*.')
  })

  it('uses display for an unresolved [[target|display]]', () => {
    expect(rewriteWikilinks('See [[Unknown|that thing]].', MAP)).toBe('See *that thing*.')
  })

  it('falls back to italic when the mapped URL has no extractable page id', () => {
    expect(rewriteWikilinks('See [[X]].', { X: 'https://www.notion.so/no-id-here' })).toBe('See *X*.')
  })

  it('handles multiple links across multiple lines', () => {
    const out = rewriteWikilinks('[[Product Delivery]]\nand [[Unknown]] and [[Docs/Guide|g]]', MAP)
    expect(out).toBe(`[Product Delivery](mention:${HEX})\nand *Unknown* and [g](mention:${HEX})`)
  })

  it('treats an empty/omitted map as all-unresolved', () => {
    expect(rewriteWikilinks('[[Anything]]', {})).toBe('*Anything*')
  })
})

describe('convertMentionPlaceholders', () => {
  const para = (rich: unknown[]) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich } })

  it('converts a text element whose link is a mention: placeholder into a page mention', () => {
    const blocks = [para([{ type: 'text', text: { content: 'Delivery', link: { type: 'url', url: `mention:${HEX}` } } }])]
    const out = convertMentionPlaceholders(blocks) as Array<{ paragraph: { rich_text: Array<Record<string, unknown>> } }>
    expect(out[0].paragraph.rich_text[0]).toEqual({ type: 'mention', mention: { type: 'page', page: { id: HEX } }, plain_text: 'Delivery' })
  })

  it('leaves ordinary text and real links untouched', () => {
    const blocks = [
      para([
        { type: 'text', text: { content: 'plain' } },
        { type: 'text', text: { content: 'site', link: { url: 'https://example.com' } } }
      ])
    ]
    const out = convertMentionPlaceholders(blocks) as Array<{ paragraph: { rich_text: unknown[] } }>
    expect(out[0].paragraph.rich_text).toEqual(blocks[0].paragraph.rich_text)
  })

  it('sets empty plain_text when the mention link element has no content', () => {
    const blocks = [para([{ type: 'text', text: { link: { url: `mention:${HEX}` } } }])]
    const out = convertMentionPlaceholders(blocks) as Array<{ paragraph: { rich_text: Array<{ plain_text: string }> } }>
    expect(out[0].paragraph.rich_text[0].plain_text).toBe('')
  })

  it('leaves a pre-existing mention element untouched', () => {
    const mention = { type: 'mention', mention: { type: 'page', page: { id: HEX } } }
    const out = convertMentionPlaceholders([para([mention])]) as Array<{ paragraph: { rich_text: unknown[] } }>
    expect(out[0].paragraph.rich_text[0]).toEqual(mention)
  })

  it('recurses into nested children blocks', () => {
    const nested = [
      {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'x' } }], children: [para([{ type: 'text', text: { content: 'D', link: { url: `mention:${HEX}` } } }])] }
      }
    ]
    const out = convertMentionPlaceholders(nested) as Array<{ bulleted_list_item: { children: Array<{ paragraph: { rich_text: Array<{ type: string }> } }> } }>
    expect(out[0].bulleted_list_item.children[0].paragraph.rich_text[0].type).toBe('mention')
  })
})
