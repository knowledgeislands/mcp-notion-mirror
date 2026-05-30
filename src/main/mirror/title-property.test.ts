import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotionConfig } from '../notion-client/index.js'
import { _clearTitlePropertyCache, getDatabaseTitleProperty } from './title-property.js'

const DB_ID = '36f9f7187cc280f69272e60aa89bff24'
const cfg: NotionConfig = { notionToken: 'ntn_secrettoken', notionApiBaseUrl: 'https://api.notion.test', notionApiVersion: '2022-06-28' }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('title-property', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    _clearTitlePropertyCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the name of the title-typed property', async () => {
    fetchMock.mockResolvedValueOnce(ok({ properties: { Tags: { id: 't', type: 'multi_select' }, Page: { id: 'p', type: 'title' } } }))
    expect(await getDatabaseTitleProperty(cfg, DB_ID)).toBe('Page')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.notion.test/v1/databases/${DB_ID}`)
  })

  it('caches the lookup (second call issues no request)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ properties: { Name: { id: 'n', type: 'title' } } }))
    await getDatabaseTitleProperty(cfg, DB_ID)
    await getDatabaseTitleProperty(cfg, DB_ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the database has no title property', async () => {
    fetchMock.mockResolvedValueOnce(ok({ properties: { Tags: { id: 't', type: 'multi_select' } } }))
    await expect(getDatabaseTitleProperty(cfg, DB_ID)).rejects.toThrow(/no title property/)
  })
})
