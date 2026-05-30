import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotionConfig } from '../notion-client/index.js'
import { buildFooterBlocks, refreshFooter, SENTINEL_TEXT } from './footer.js'

const cfg: NotionConfig = { notionToken: 'ntn_secrettoken', notionApiBaseUrl: 'https://api.notion.test', notionApiVersion: '2022-06-28' }
const PARENT = 'a'.repeat(32)
const CONTENT = '1'.repeat(32)
const CHILD_A = 'b'.repeat(32)
const CHILD_B = 'c'.repeat(32)
const SENT = 'd'.repeat(32)
const OLD_BULLET = 'e'.repeat(32)

const content = (id: string) => ({ id, type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } })
const childPage = (id: string) => ({ id, type: 'child_page', child_page: { title: 'X' } })
const heading = (id: string, text: string) => ({ id, type: 'heading_2', heading_2: { rich_text: [{ plain_text: text }] } })
const oldBullet = (id: string) => ({ id, type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'old' }] } })

const childrenPage = (results: unknown[], next: string | null = null) => new Response(JSON.stringify({ results, has_more: next !== null, next_cursor: next }), { status: 200 })
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 })

interface Call {
  method: string
  url: string
  body?: { children?: Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> } }>; after?: string }
}

describe('footer', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const calls: Call[] = []

  beforeEach(() => {
    calls.length = 0
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('buildFooterBlocks', () => {
    it('is a single "Child Pages" heading with no folder emoji and no bullets', () => {
      expect(SENTINEL_TEXT).toBe('Child Pages')
      const blocks = buildFooterBlocks()
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as unknown as { type: string; heading_2: { rich_text: Array<{ text: { content: string } }> } }).type).toBe('heading_2')
      expect((blocks[0] as unknown as { heading_2: { rich_text: Array<{ text: { content: string } }> } }).heading_2.rich_text[0].text.content).toBe('Child Pages')
    })
  })

  describe('refreshFooter', () => {
    // Route a single fetch, recording it, replying by method (+ pagination on GET).
    const route = (pages: unknown[][]) => {
      let getCount = 0
      fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET'
        calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined })
        if (method === 'GET') {
          const idx = Math.min(getCount, pages.length - 1)
          getCount++
          return childrenPage(pages[idx], idx < pages.length - 1 ? `cur${idx}` : null)
        }
        return ok()
      })
    }
    const patch = () => calls.find((c) => c.method === 'PATCH')
    const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url)

    it('inserts the heading right before the first child page when there is no prior footer', async () => {
      route([[content(CONTENT), childPage(CHILD_A)]])
      await refreshFooter(cfg, PARENT)
      expect(deletes()).toHaveLength(0)
      expect(patch()?.url).toBe(`https://api.notion.test/v1/blocks/${PARENT}/children`)
      expect(patch()?.body?.children?.[0].heading_2?.rich_text[0].text.content).toBe('Child Pages')
      expect(patch()?.body?.after).toBe(CONTENT) // anchored just before the first child page
    })

    it('cleans up a legacy "📂 Child Pages" heading + mention bullets, sparing child pages after it', async () => {
      route([[content(CONTENT), heading(SENT, '📂 Child Pages'), oldBullet(OLD_BULLET), childPage(CHILD_A)]])
      await refreshFooter(cfg, PARENT)
      expect(deletes()).toEqual([`https://api.notion.test/v1/blocks/${SENT}`, `https://api.notion.test/v1/blocks/${OLD_BULLET}`])
      expect(patch()?.body?.after).toBe(CONTENT)
      expect(patch()?.body?.children?.[0].heading_2?.rich_text[0].text.content).toBe('Child Pages')
    })

    it('is idempotent: removes the current heading and re-inserts it in the same place', async () => {
      route([[content(CONTENT), heading(SENT, 'Child Pages'), childPage(CHILD_A)]])
      await refreshFooter(cfg, PARENT)
      expect(deletes()).toEqual([`https://api.notion.test/v1/blocks/${SENT}`]) // child spared
      expect(patch()?.body?.after).toBe(CONTENT)
    })

    it('appends the heading at the end (no anchor) when a child page is the very first block', async () => {
      route([[childPage(CHILD_A), childPage(CHILD_B)]])
      await refreshFooter(cfg, PARENT)
      expect(patch()?.body?.after).toBeUndefined()
      expect(patch()?.body?.children?.[0].heading_2?.rich_text[0].text.content).toBe('Child Pages')
    })

    it('deletes a stale heading and appends nothing when there are no child pages', async () => {
      route([[content(CONTENT), heading(SENT, 'Child Pages')]])
      await refreshFooter(cfg, PARENT)
      expect(deletes()).toEqual([`https://api.notion.test/v1/blocks/${SENT}`])
      expect(patch()).toBeUndefined()
    })

    it('is a no-op (single GET) when there is neither a heading nor any child page', async () => {
      route([[content(CONTENT)]])
      await refreshFooter(cfg, PARENT)
      expect(calls.map((c) => c.method)).toEqual(['GET'])
    })

    it('follows pagination across multiple GET pages', async () => {
      route([[content(CONTENT)], [childPage(CHILD_A)]])
      await refreshFooter(cfg, PARENT)
      const gets = calls.filter((c) => c.method === 'GET')
      expect(gets).toHaveLength(2)
      expect(gets[1].url).toContain('start_cursor=cur0')
      expect(patch()?.body?.after).toBe(CONTENT)
    })

    it('tolerates odd heading blocks (no inner / no plain_text) while scanning for the sentinel', async () => {
      const H1 = '7'.repeat(32)
      const H2 = '8'.repeat(32)
      route([
        [
          { id: H1, type: 'heading_2' }, // no heading_2 object
          { id: H2, type: 'heading_2', heading_2: { rich_text: [{}] } }, // item without plain_text
          childPage(CHILD_A)
        ]
      ])
      await refreshFooter(cfg, PARENT)
      expect(deletes()).toHaveLength(0) // neither odd heading is the sentinel
      expect(patch()?.body?.after).toBe(H2) // anchored to the block before the first child page
    })

    it('serialises refreshes for the same parent (no interleaving)', async () => {
      route([[content(CONTENT), childPage(CHILD_A)]])
      await Promise.all([refreshFooter(cfg, PARENT), refreshFooter(cfg, PARENT)])
      expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH'])
    })

    it('continues the per-parent chain after a failed refresh (lock survives rejection)', async () => {
      let n = 0
      fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET'
        calls.push({ method, url })
        n++
        if (n === 1) return new Response(JSON.stringify({ code: 'x', message: 'boom' }), { status: 500 })
        if (method === 'GET') return childrenPage([content(CONTENT), childPage(CHILD_A)])
        return ok()
      })
      const [first, second] = await Promise.allSettled([refreshFooter(cfg, PARENT), refreshFooter(cfg, PARENT)])
      expect(first.status).toBe('rejected')
      expect(second.status).toBe('fulfilled')
    })
  })
})
