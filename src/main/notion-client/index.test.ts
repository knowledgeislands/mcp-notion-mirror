import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendBlockChildren,
  archivePage,
  createPage,
  deleteBlock,
  extractPageIdFromUrl,
  getBlockChildren,
  getDatabase,
  getPage,
  NotionApiError,
  type NotionConfig,
  normalizeId,
  normalizePublishedAt,
  setPageParent
} from './index.js'

const DB_ID = '36f9f7187cc280f69272e60aa89bff24'
const PAGE_HEX = '3709f7187cc2814e8652f99fd36857ff'
const PAGE_DASHED = '3709f718-7cc2-814e-8652-f99fd36857ff'
const cfg: NotionConfig = { notionToken: 'ntn_secrettoken', notionApiBaseUrl: 'https://api.notion.test', notionApiVersion: '2022-06-28' }
const PAGE_RESPONSE = {
  id: PAGE_DASHED,
  url: 'https://www.notion.so/Slug-3709f7187cc2814e8652f99fd36857ff',
  created_time: '2026-05-30T01:13:00.000Z',
  last_edited_time: '2026-05-30T02:00:00.000Z',
  archived: false,
  parent: { type: 'database_id', database_id: DB_ID },
  properties: { Page: { type: 'title', title: [{ plain_text: 'My ' }, { plain_text: 'Note' }] } }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('notion-client (mcp-notion-mirror)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('getDatabase', () => {
    it('sends Bearer + Notion-Version headers and returns the raw database', async () => {
      fetchMock.mockResolvedValueOnce(ok({ properties: { Page: { id: 'p', type: 'title' } } }))
      const db = await getDatabase(cfg, DB_ID)
      expect(db.properties.Page.type).toBe('title')
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/databases/${DB_ID}`)
      expect(init.method).toBe('GET')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer ntn_secrettoken', 'Notion-Version': '2022-06-28', Accept: 'application/json', 'Content-Type': 'application/json' })
    })
  })

  describe('createPage', () => {
    it('creates a database-parented page with the named title property', async () => {
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE))
      const result = await createPage(cfg, { parent: { type: 'database_id', database_id: DB_ID }, titleProperty: 'Page', title: 'My Note', children: [{ a: 1 }, { b: 2 }] })
      expect(result).toEqual({ id: PAGE_RESPONSE.id, url: PAGE_RESPONSE.url, created_time: PAGE_RESPONSE.created_time })
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe('https://api.notion.test/v1/pages')
      const body = JSON.parse(init.body)
      expect(body.parent).toEqual({ type: 'database_id', database_id: DB_ID })
      expect(body.properties).toEqual({ Page: { title: [{ text: { content: 'My Note' } }] } })
      expect(body.children).toHaveLength(2)
    })

    it('creates a page-parented page with the reserved title property', async () => {
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE))
      await createPage(cfg, { parent: { type: 'page_id', page_id: PAGE_HEX }, title: 'Child', children: [{ a: 1 }] })
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body)
      expect(body.parent).toEqual({ type: 'page_id', page_id: PAGE_HEX })
      expect(body.properties).toEqual({ title: { title: [{ text: { content: 'Child' } }] } })
    })

    it('includes the icon in the POST body and never sends a format field', async () => {
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE))
      await createPage(cfg, { parent: { type: 'page_id', page_id: PAGE_HEX }, title: 'C', children: [{ a: 1 }], icon: { type: 'emoji', emoji: '📚' } })
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body)
      expect(body.icon).toEqual({ type: 'emoji', emoji: '📚' })
      expect(body.format).toBeUndefined()
    })

    it('throws when a database parent is given without a title property name', async () => {
      await expect(createPage(cfg, { parent: { type: 'database_id', database_id: DB_ID }, title: 'x', children: [] })).rejects.toThrow(NotionApiError)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('appends children beyond the 100-block limit via PATCH /v1/blocks/{id}/children (id de-dashed)', async () => {
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // create (id is dashed)
      fetchMock.mockResolvedValueOnce(ok({})) // append batch
      const children = Array.from({ length: 150 }, (_, i) => ({ i }))
      await createPage(cfg, { parent: { type: 'database_id', database_id: DB_ID }, titleProperty: 'Page', title: 'Big', children })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [createInit, appendCall] = [JSON.parse(fetchMock.mock.calls[0]?.[1].body), fetchMock.mock.calls[1]]
      expect(createInit.children).toHaveLength(100)
      expect(appendCall?.[0]).toBe(`https://api.notion.test/v1/blocks/${PAGE_HEX}/children`)
      expect(appendCall?.[1].method).toBe('PATCH')
      expect(JSON.parse(appendCall?.[1].body).children).toHaveLength(50)
    })
  })

  describe('getPage', () => {
    it('returns id/url/parent/timestamps/archived and the extracted title', async () => {
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE))
      const page = await getPage(cfg, PAGE_HEX)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/pages/${PAGE_HEX}`)
      expect(init.method).toBe('GET')
      expect(page).toEqual({
        id: PAGE_RESPONSE.id,
        url: PAGE_RESPONSE.url,
        parent: { type: 'database_id', database_id: DB_ID },
        created_time: PAGE_RESPONSE.created_time,
        last_edited_time: PAGE_RESPONSE.last_edited_time,
        archived: false,
        title: 'My Note'
      })
    })

    it('returns an empty title when no title-typed property is present', async () => {
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, properties: { Tags: { type: 'multi_select' } } }))
      const page = await getPage(cfg, PAGE_HEX)
      expect(page.title).toBe('')
    })

    it('tolerates a title property with no rich-text runs', async () => {
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, properties: { Page: { type: 'title', title: [{}] } } }))
      const page = await getPage(cfg, PAGE_HEX)
      expect(page.title).toBe('')
    })
  })

  describe('archivePage / setPageParent', () => {
    it('archivePage PATCHes the page with archived:true', async () => {
      fetchMock.mockResolvedValueOnce(ok({}))
      await archivePage(cfg, PAGE_HEX)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/pages/${PAGE_HEX}`)
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body)).toEqual({ archived: true })
    })

    it('setPageParent PATCHes the page with the new parent', async () => {
      fetchMock.mockResolvedValueOnce(ok({}))
      await setPageParent(cfg, PAGE_HEX, { type: 'page_id', page_id: '0000000000000000000000000000abcd' })
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/pages/${PAGE_HEX}`)
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body)).toEqual({ parent: { type: 'page_id', page_id: '0000000000000000000000000000abcd' } })
    })
  })

  describe('block helpers', () => {
    it('getBlockChildren follows pagination and returns all results in order', async () => {
      fetchMock.mockResolvedValueOnce(ok({ results: [{ id: '1', type: 'child_page' }], has_more: true, next_cursor: 'c1' }))
      fetchMock.mockResolvedValueOnce(ok({ results: [{ id: '2', type: 'paragraph' }], has_more: false, next_cursor: null }))
      const blocks = await getBlockChildren(cfg, PAGE_HEX)
      expect(blocks.map((b) => b.id)).toEqual(['1', '2'])
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.notion.test/v1/blocks/${PAGE_HEX}/children?page_size=100`)
      expect(fetchMock.mock.calls[1]?.[0]).toContain('start_cursor=c1')
    })

    it('appendBlockChildren PATCHes the children payload and returns created ids', async () => {
      fetchMock.mockResolvedValueOnce(ok({ results: [{ id: 'new1' }] }))
      const ids = await appendBlockChildren(cfg, PAGE_HEX, [{ type: 'heading_2' }])
      expect(ids).toEqual(['new1'])
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/blocks/${PAGE_HEX}/children`)
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body)).toEqual({ children: [{ type: 'heading_2' }] })
    })

    it('appendBlockChildren positions the payload after a sibling when `after` is given (id normalized)', async () => {
      fetchMock.mockResolvedValueOnce(ok({}))
      await appendBlockChildren(cfg, PAGE_HEX, [{ type: 'heading_2' }], PAGE_DASHED)
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ children: [{ type: 'heading_2' }], after: PAGE_HEX })
    })

    it('deleteBlock issues a DELETE', async () => {
      fetchMock.mockResolvedValueOnce(ok({}))
      await deleteBlock(cfg, PAGE_HEX)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe(`https://api.notion.test/v1/blocks/${PAGE_HEX}`)
      expect(init.method).toBe('DELETE')
    })
  })

  describe('error translation', () => {
    it('throws NotionApiError with status + code + message, never leaking the token', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'unauthorized', message: 'API token is invalid.' }), { status: 401 }))
      const err = await archivePage(cfg, PAGE_HEX).catch((e) => e)
      expect(err).toBeInstanceOf(NotionApiError)
      expect(err.status).toBe(401)
      expect(err.code).toBe('unauthorized')
      expect(err.message).toContain('API token is invalid.')
      expect(err.message).not.toContain('ntn_secrettoken')
    })

    it('falls back to the raw text for a non-JSON error body', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      await expect(archivePage(cfg, PAGE_HEX)).rejects.toThrow(/HTTP 502: Bad Gateway/)
    })

    it('truncates very long error detail', async () => {
      fetchMock.mockResolvedValueOnce(new Response(`${'x'.repeat(600)}END`, { status: 500 }))
      await expect(archivePage(cfg, PAGE_HEX)).rejects.toThrow(/HTTP 500:.*…/)
    })

    it('throws when a 2xx response body is not valid JSON', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
      await expect(getDatabase(cfg, DB_ID)).rejects.toThrow(/non-JSON body/)
    })
  })

  describe('pure helpers', () => {
    it('normalizeId accepts 32-hex and dashed UUIDs, rejects everything else', () => {
      expect(normalizeId(PAGE_HEX)).toBe(PAGE_HEX)
      expect(normalizeId(PAGE_DASHED)).toBe(PAGE_HEX)
      expect(normalizeId(PAGE_HEX.toUpperCase())).toBe(PAGE_HEX)
      expect(() => normalizeId('nope')).toThrow(NotionApiError)
      expect(() => normalizeId('')).toThrow(NotionApiError)
    })

    it('extractPageIdFromUrl pulls the 32-hex id out of a notion.so URL', () => {
      expect(extractPageIdFromUrl('https://www.notion.so/Slug-3709f7187cc2814e8652f99fd36857ff')).toBe(PAGE_HEX)
      expect(extractPageIdFromUrl('https://www.notion.so/3709f7187cc2814e8652f99fd36857ff?pvs=4')).toBe(PAGE_HEX)
      expect(extractPageIdFromUrl('https://example.com/no-id-here')).toBeUndefined()
    })

    it('normalizePublishedAt trims sub-second precision', () => {
      expect(normalizePublishedAt('2026-05-30T01:13:00.000Z')).toBe('2026-05-30T01:13:00Z')
      expect(normalizePublishedAt('2026-05-30T01:13:00Z')).toBe('2026-05-30T01:13:00Z')
    })
  })
})
