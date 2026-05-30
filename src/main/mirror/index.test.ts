import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Config, DEFAULT_BANNER_TEMPLATE } from '../../config/index.js'
import { getNote, moveNote, publishNote, unpublishNote } from './index.js'
import { _clearTitlePropertyCache } from './title-property.js'

const DB_ID = '36f9f7187cc280f69272e60aa89bff24'
const PAGE_HEX = '3709f7187cc2814e8652f99fd36857ff'
const OLD_PARENT = 'a'.repeat(32)
const MIRROR_URL = `https://www.notion.so/My-Note-${PAGE_HEX}`
const PAGE_RESPONSE = {
  id: '3709f718-7cc2-814e-8652-f99fd36857ff',
  url: MIRROR_URL,
  created_time: '2026-05-30T01:13:00.000Z',
  last_edited_time: '2026-05-30T02:00:00.000Z',
  archived: false,
  parent: { type: 'database_id', database_id: DB_ID },
  properties: { Page: { type: 'title', title: [{ plain_text: 'My Note' }] } }
}
const DB_RESPONSE = { properties: { Tags: { id: 't', type: 'multi_select' }, Page: { id: 'p', type: 'title' } } }

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const fail = (status: number) => new Response(JSON.stringify({ code: 'x', message: 'boom' }), { status })
// A clean footer refresh: GET children returns an empty list, so refreshFooter
// finds no sentinel to delete and appends nothing — a single, side-effect-free GET.
const emptyChildren = () => ok({ results: [], has_more: false, next_cursor: null })

const FM = (extra = ''): string => `---\nstatus: current\nnotion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nnotion_path: A / B${extra}\n---\n# My Note\n\nBody paragraph.\n`

describe('mirror-ops', () => {
  let kbRoot: string
  let cfg: Config
  let fetchMock: ReturnType<typeof vi.fn>

  const writeNote = async (name: string, content: string): Promise<string> => {
    const abs = path.join(kbRoot, name)
    await fsp.writeFile(abs, content)
    return abs
  }

  // Routes the calls a `replace` makes: GET page (before-parent snapshot), GET
  // database (title prop), PATCH page (updatePage), GET children (replaceBody +
  // footer), and PATCH/DELETE children. `pageParent` overrides the page's
  // parent in the GET/PATCH response — defaults to the database parent.
  const routeReplace = (children: unknown[], pageParent?: Record<string, unknown>) => {
    const pageResp = pageParent ? { ...PAGE_RESPONSE, parent: pageParent } : PAGE_RESPONSE
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/v1/databases/')) return ok(DB_RESPONSE)
      if (/\/v1\/pages\/[a-f0-9]+$/.test(url) && method === 'PATCH') return ok(pageResp)
      if (/\/v1\/pages\/[a-f0-9]+$/.test(url) && method === 'GET') return ok(pageResp)
      if (url.includes('/children') && method === 'GET') return ok({ results: children, has_more: false, next_cursor: null })
      return ok({ results: [{ id: 'x' }] })
    })
  }

  beforeEach(async () => {
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-ops-'))
    cfg = {
      notionToken: 'ntn_secrettoken',
      notionApiBaseUrl: 'https://api.notion.test',
      notionApiVersion: '2022-06-28',
      kbRoot,
      bannerTemplate: DEFAULT_BANNER_TEMPLATE,
      accessLevel: 'write',
      auditLogMode: 'off',
      auditLogPath: '',
      auditLogMaxBytes: 0,
      auditLogKeep: 0
    }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    _clearTitlePropertyCache()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fsp.rm(kbRoot, { recursive: true, force: true })
  })

  describe('publishNote', () => {
    it('publishes under a database parent: resolves the title prop, prepends the banner, strips the H1, writes back', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // GET database (title prop)
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST page
      const result = await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID })
      expect(result).toEqual({ url: MIRROR_URL, page_id: PAGE_RESPONSE.id, published_at: '2026-05-30T01:13:00Z', mode: 'create' })

      const postBody = JSON.parse(fetchMock.mock.calls[1]?.[1].body)
      expect(postBody.properties).toEqual({ Page: { title: [{ text: { content: 'My Note' } }] } })
      expect(postBody.children[0].type).toBe('callout') // banner first
      // H1 stripped: no heading_1 block in the body
      expect(postBody.children.some((b: { type: string }) => b.type === 'heading_1')).toBe(false)

      const written = await fsp.readFile(abs, 'utf-8')
      expect(written).toContain(`notion_mirror_url: ${MIRROR_URL}`)
      expect(written).toContain('notion_mirror_published_at: 2026-05-30T01:13:00Z')
    })

    it('skips when already mirrored in create mode (default), making no Notion call', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      const result = await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID })
      expect(result).toEqual({ skipped: true, existing_url: MIRROR_URL })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('legacy `force: true` is an alias for mode "force"', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // GET database (title prop)
      fetchMock.mockResolvedValueOnce(ok({})) // archive old
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, url: `https://www.notion.so/New-${PAGE_HEX}` })) // POST
      const result = await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID }, { force: true })
      expect((result as { mode: string }).mode).toBe('force')
      const archiveCall = fetchMock.mock.calls.find((c) => /\/v1\/pages\/[a-f0-9]+$/.test(String(c[0])) && c[1].method === 'PATCH')
      expect(JSON.parse(archiveCall?.[1].body)).toEqual({ archived: true }) // archived the old page
    })

    it('force re-publish archives the old page (tolerating archive failure) then posts a new one', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // GET database (title prop) — first now
      fetchMock.mockResolvedValueOnce(fail(500)) // archive old → fails, swallowed
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, url: `https://www.notion.so/New-${PAGE_HEX}` })) // POST
      const result = await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID }, { mode: 'force' })
      expect((result as { url: string }).url).toBe(`https://www.notion.so/New-${PAGE_HEX}`)
      const archiveCall = fetchMock.mock.calls.find((c) => /\/v1\/pages\/[a-f0-9]+$/.test(String(c[0])) && c[1].method === 'PATCH')
      expect(archiveCall?.[0]).toBe(`https://api.notion.test/v1/pages/${PAGE_HEX}`)
      expect(JSON.parse(archiveCall?.[1].body)).toEqual({ archived: true })
    })

    it('force re-publish with a malformed existing url skips the archive call', async () => {
      const abs = await writeNote('note.md', FM('\nnotion_mirror_url: https://www.notion.so/no-id-here'))
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // GET database (no archive call first)
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID }, { mode: 'force' })
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.notion.test/v1/databases/${DB_ID}`)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('under a page parent uses the reserved title and makes no GET database call', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET
      await publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body)
      expect(body.properties).toEqual({ title: { title: [{ text: { content: 'My Note' } }] } })
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/databases/'))).toBe(false)
    })

    it('passes a caller-supplied icon and resolves wikilinks via link_map (mention) / italic (unresolved)', async () => {
      const linkedHex = 'c'.repeat(32)
      const abs = await writeNote('My Note.md', `---\nstatus: x\nnotion_path: A\n---\nSee [[Other]] and [[Gone]].\n`)
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer
      await publishNote(
        cfg,
        abs,
        { type: 'page_id', page_id: PAGE_HEX },
        {
          icon: { type: 'emoji', emoji: '📚' },
          linkMap: { Other: `https://www.notion.so/Other-${linkedHex}` }
        }
      )
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body)
      expect(body.icon).toEqual({ type: 'emoji', emoji: '📚' })
      const rich = body.children[1].paragraph.rich_text as Array<Record<string, unknown>>
      expect(rich.some((r) => r.type === 'mention' && (r.mention as { page: { id: string } }).page.id === linkedHex)).toBe(true)
      expect(rich.some((r) => (r as { annotations?: { italic?: boolean } }).annotations?.italic && (r as { text?: { content?: string } }).text?.content === 'Gone')).toBe(true)
    })

    it('refreshes the parent footer after publishing under a page parent', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      fetchMock.mockResolvedValueOnce(ok({ results: [{ id: PAGE_HEX, type: 'child_page', child_page: { title: 'My Note' } }], has_more: false, next_cursor: null })) // footer GET
      fetchMock.mockResolvedValueOnce(ok({})) // footer PATCH append
      await publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      const footerGet = fetchMock.mock.calls[1]
      const footerPatch = fetchMock.mock.calls[2]
      expect(footerGet?.[0]).toBe(`https://api.notion.test/v1/blocks/${PAGE_HEX}/children?page_size=100`)
      expect(footerPatch?.[1].method).toBe('PATCH')
    })

    it('still succeeds when the parent footer refresh fails (failure is swallowed)', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      fetchMock.mockResolvedValueOnce(fail(500)) // footer GET fails
      const result = await publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      expect((result as { url: string }).url).toBe(MIRROR_URL)
      expect(await fsp.readFile(abs, 'utf-8')).toContain('notion_mirror_url:')
    })

    it('does NOT refresh a footer when publishing under a database parent', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // GET database
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST
      await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID })
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/children'))).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('throws when the note has no frontmatter', async () => {
      const abs = await writeNote('note.md', '# Just a heading\n\nbody\n')
      await expect(publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })).rejects.toThrow(/no YAML frontmatter/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('publishes just the banner when the body is empty', async () => {
      const abs = await writeNote('note.md', '---\nstatus: x\nnotion_path: A\n---\n')
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST (page parent)
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET
      await publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body)
      expect(body.children).toHaveLength(1)
      expect(body.children[0].type).toBe('callout')
    })

    it('errors when the body is empty and the banner is disabled', async () => {
      const abs = await writeNote('note.md', '---\nstatus: x\nnotion_path: A\n---\n')
      await expect(publishNote({ ...cfg, bannerTemplate: '' }, abs, { type: 'page_id', page_id: PAGE_HEX })).rejects.toThrow(/Nothing to publish/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    const OLD_BODY = '9'.repeat(32)
    const CHILD = 'e'.repeat(32)

    it('mode "replace" updates the page in place: PATCHes the page, replaces the body, spares child pages, keeps the URL', async () => {
      const abs = await writeNote('My Note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}\nnotion_mirror_published_at: 2020-01-01T00:00:00Z`))
      routeReplace([
        { id: OLD_BODY, type: 'paragraph' },
        { id: CHILD, type: 'child_page', child_page: { title: 'C' } }
      ])
      const result = await publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID }, { mode: 'replace' })
      expect(result).toMatchObject({ url: MIRROR_URL, page_id: PAGE_HEX, mode: 'replace' })
      // PATCHed the existing page (updatePage); never POSTed a new one.
      expect(fetchMock.mock.calls.some((c) => /\/v1\/pages\/[a-f0-9]+$/.test(String(c[0])) && c[1].method === 'PATCH')).toBe(true)
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false)
      // Deleted the old body block, spared the child page.
      const deleted = fetchMock.mock.calls.filter((c) => c[1]?.method === 'DELETE').map((c) => String(c[0]))
      expect(deleted).toContain(`https://api.notion.test/v1/blocks/${OLD_BODY}`)
      expect(deleted.some((u) => u.includes(CHILD))).toBe(false)
      // Frontmatter: URL unchanged; published_at refreshed from last_edited_time.
      const written = await fsp.readFile(abs, 'utf-8')
      expect(written).toContain(`notion_mirror_url: ${MIRROR_URL}`)
      expect(written).toContain('notion_mirror_published_at: 2026-05-30T02:00:00Z')
      expect(written).not.toContain('2020-01-01')
    })

    it('mode "replace" under a page parent sends the icon and refreshes the parent footer', async () => {
      const abs = await writeNote('My Note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      routeReplace([{ id: OLD_BODY, type: 'paragraph' }], { type: 'page_id', page_id: OLD_PARENT })
      await publishNote(cfg, abs, { type: 'page_id', page_id: OLD_PARENT }, { mode: 'replace', icon: { type: 'emoji', emoji: '📗' } })
      const pagePatch = fetchMock.mock.calls.find((c) => /\/v1\/pages\/[a-f0-9]+$/.test(String(c[0])) && c[1].method === 'PATCH')
      expect(JSON.parse(pagePatch?.[1].body).icon).toEqual({ type: 'emoji', emoji: '📗' })
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === `https://api.notion.test/v1/blocks/${OLD_PARENT}/children?page_size=100`)).toBe(true)
    })

    it('mode "replace" detects the page-id ↔ database-id silent-failure case and throws', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      const pageParent = { type: 'page_id', page_id: 'a'.repeat(32) }
      fetchMock.mockResolvedValueOnce(ok(DB_RESPONSE)) // title-property lookup for the new db parent
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: pageParent })) // GET before (page parent)
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: pageParent })) // PATCH parent (silently ignored, response still shows old parent)
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: pageParent })) // GET after — unchanged
      await expect(publishNote(cfg, abs, { type: 'database_id', database_id: DB_ID }, { mode: 'replace' })).rejects.toThrow(/silently ignored the parent change/)
    })

    it('mode "replace" accepts a cross-type re-parent that actually took effect and refreshes the old page parent footer', async () => {
      const abs = await writeNote('My Note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      const oldPageParent = { type: 'page_id' as const, page_id: OLD_PARENT }
      const newDbParent = { type: 'database_id' as const, database_id: DB_ID }
      fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET'
        if (url.includes('/v1/databases/')) return ok(DB_RESPONSE)
        if (/\/v1\/pages\/[a-f0-9]+$/.test(url) && method === 'PATCH') return ok({ ...PAGE_RESPONSE, parent: newDbParent })
        // Two GETs on the page: 1st returns OLD parent (before), 2nd returns NEW parent (after).
        if (/\/v1\/pages\/[a-f0-9]+$/.test(url) && method === 'GET') {
          const getCalls = fetchMock.mock.calls.filter((c) => /\/v1\/pages\/[a-f0-9]+$/.test(String(c[0])) && (c[1]?.method ?? 'GET') === 'GET').length
          return ok({ ...PAGE_RESPONSE, parent: getCalls <= 1 ? oldPageParent : newDbParent })
        }
        if (url.includes('/children') && method === 'GET') return ok({ results: [{ id: OLD_BODY, type: 'paragraph' }], has_more: false, next_cursor: null })
        return ok({ results: [{ id: 'x' }] })
      })
      const result = await publishNote(cfg, abs, newDbParent, { mode: 'replace' })
      expect((result as { mode: string }).mode).toBe('replace')
      // Old page parent's footer should be refreshed (we re-parented away from it).
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === `https://api.notion.test/v1/blocks/${OLD_PARENT}/children?page_size=100`)).toBe(true)
    })

    it('mode "replace" against a non-mirrored note creates a new page', async () => {
      const abs = await writeNote('My Note.md', FM())
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE)) // POST (page parent → no DB lookup)
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer
      const result = await publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX }, { mode: 'replace' })
      expect(fetchMock.mock.calls[0]?.[1].method).toBe('POST')
      expect((result as { mode: string }).mode).toBe('replace')
      expect(await fsp.readFile(abs, 'utf-8')).toContain('notion_mirror_url:')
    })

    it('mode "replace" with a malformed mirror url throws', async () => {
      const abs = await writeNote('note.md', FM('\nnotion_mirror_url: https://www.notion.so/no-id'))
      await expect(publishNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX }, { mode: 'replace' })).rejects.toThrow(/Could not extract a 32-hex page id/)
    })
  })

  describe('unpublishNote', () => {
    it('dry-run (default) returns the plan, makes no Notion call, leaves the file unchanged', async () => {
      const content = FM(`\nnotion_mirror_url: ${MIRROR_URL}`)
      const abs = await writeNote('note.md', content)
      const result = await unpublishNote(cfg, abs, true)
      expect(result).toEqual({ dry_run: true, would_archive_url: MIRROR_URL, would_archive_page_id: PAGE_HEX, would_clear_fields: ['notion_mirror_url', 'notion_mirror_published_at'] })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await fsp.readFile(abs, 'utf-8')).toBe(content)
    })

    it('with dry_run false archives the page and clears the mirror fields (database parent → no footer)', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}\nnotion_mirror_published_at: 2026-05-30T01:13:00Z`))
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'database_id', database_id: DB_ID } })) // GET page (learn parent)
      fetchMock.mockResolvedValueOnce(ok({})) // archive
      const result = await unpublishNote(cfg, abs, false)
      expect(result).toEqual({ archived: true, page_id: PAGE_HEX, url: MIRROR_URL })
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/children'))).toBe(false)
      const written = await fsp.readFile(abs, 'utf-8')
      expect(written).not.toContain('notion_mirror_url')
      expect(written).not.toContain('notion_mirror_published_at')
      expect(written).toContain('notion_path: A / B')
    })

    it('refreshes the parent footer when the archived page had a page parent', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'page_id', page_id: OLD_PARENT } })) // GET page
      fetchMock.mockResolvedValueOnce(ok({})) // archive
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET of OLD_PARENT
      await unpublishNote(cfg, abs, false)
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === `https://api.notion.test/v1/blocks/${OLD_PARENT}/children?page_size=100`)).toBe(true)
    })

    it('returns not-published when the note has no mirror url', async () => {
      const abs = await writeNote('note.md', FM())
      expect(await unpublishNote(cfg, abs, false)).toEqual({ archived: false, reason: 'not-published' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws on a malformed mirror url', async () => {
      const abs = await writeNote('note.md', FM('\nnotion_mirror_url: https://www.notion.so/no-id'))
      await expect(unpublishNote(cfg, abs, false)).rejects.toThrow(/Could not extract a 32-hex page id/)
    })
  })

  describe('moveNote', () => {
    it('re-parents the page (same parent type), refreshes both footers, and does not touch the file', async () => {
      const content = FM(`\nnotion_mirror_url: ${MIRROR_URL}`)
      const abs = await writeNote('note.md', content)
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'page_id', page_id: OLD_PARENT } })) // GET before
      fetchMock.mockResolvedValueOnce(ok({})) // PATCH parent
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET (old parent)
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET (new parent)
      const result = await moveNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      expect(result).toEqual({ moved: true, page_id: PAGE_HEX, previous_parent: { type: 'page_id', page_id: OLD_PARENT }, new_parent: { type: 'page_id', page_id: PAGE_HEX } })
      const footerGets = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/children')).map((c) => String(c[0]))
      expect(footerGets.some((u) => u.includes(OLD_PARENT))).toBe(true)
      expect(footerGets.some((u) => u.includes(PAGE_HEX))).toBe(true)
      expect(await fsp.readFile(abs, 'utf-8')).toBe(content)
    })

    it('detects the page-id ↔ database-id silent-failure case and errors', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      const pageParent = { type: 'page_id', page_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: pageParent })) // GET before (page parent)
      fetchMock.mockResolvedValueOnce(ok({})) // PATCH parent (silently ignored)
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: pageParent })) // GET after — unchanged
      await expect(moveNote(cfg, abs, { type: 'database_id', database_id: DB_ID })).rejects.toThrow(/silently ignored the parent change/)
    })

    it('accepts a cross-type move that actually took effect (refreshes only the old page parent)', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'page_id', page_id: OLD_PARENT } })) // GET before
      fetchMock.mockResolvedValueOnce(ok({})) // PATCH
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'database_id', database_id: DB_ID } })) // GET after — changed
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer refresh GET (old page parent; new database parent needs none)
      const result = await moveNote(cfg, abs, { type: 'database_id', database_id: DB_ID })
      expect((result as { moved: boolean }).moved).toBe(true)
      const footerGets = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/children')).map((c) => String(c[0]))
      expect(footerGets).toEqual([`https://api.notion.test/v1/blocks/${OLD_PARENT}/children?page_size=100`])
    })

    it('moving from a database parent to a page parent refreshes only the new parent', async () => {
      const abs = await writeNote('note.md', FM(`\nnotion_mirror_url: ${MIRROR_URL}`))
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'database_id', database_id: DB_ID } })) // GET before (db parent)
      fetchMock.mockResolvedValueOnce(ok({})) // PATCH
      fetchMock.mockResolvedValueOnce(ok({ ...PAGE_RESPONSE, parent: { type: 'page_id', page_id: PAGE_HEX } })) // GET after — changed
      fetchMock.mockResolvedValueOnce(emptyChildren()) // footer GET (new page parent only)
      const result = await moveNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })
      expect((result as { moved: boolean }).moved).toBe(true)
      const footerGets = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/children')).map((c) => String(c[0]))
      expect(footerGets).toEqual([`https://api.notion.test/v1/blocks/${PAGE_HEX}/children?page_size=100`])
    })

    it('throws when the note is not published', async () => {
      const abs = await writeNote('note.md', FM())
      await expect(moveNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })).rejects.toThrow(/not published — cannot move/)
    })

    it('throws on a malformed mirror url', async () => {
      const abs = await writeNote('note.md', FM('\nnotion_mirror_url: https://www.notion.so/no-id'))
      await expect(moveNote(cfg, abs, { type: 'page_id', page_id: PAGE_HEX })).rejects.toThrow(/Could not extract a 32-hex page id/)
    })
  })

  describe('getNote', () => {
    it('returns the live Notion page state without mutating the file', async () => {
      const content = FM(`\nnotion_mirror_url: ${MIRROR_URL}`)
      const abs = await writeNote('note.md', content)
      fetchMock.mockResolvedValueOnce(ok(PAGE_RESPONSE))
      const result = await getNote(cfg, abs)
      expect(result).toEqual({
        id: PAGE_RESPONSE.id,
        parent: { type: 'database_id', database_id: DB_ID },
        title: 'My Note',
        created_time: PAGE_RESPONSE.created_time,
        last_edited_time: PAGE_RESPONSE.last_edited_time,
        archived: false,
        url: MIRROR_URL
      })
      expect(await fsp.readFile(abs, 'utf-8')).toBe(content)
    })

    it('returns exists:false when the note has no mirror url', async () => {
      const abs = await writeNote('note.md', FM())
      expect(await getNote(cfg, abs)).toEqual({ exists: false, reason: 'not-published' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws on a malformed mirror url', async () => {
      const abs = await writeNote('note.md', FM('\nnotion_mirror_url: https://www.notion.so/no-id'))
      await expect(getNote(cfg, abs)).rejects.toThrow(/Could not extract a 32-hex page id/)
    })
  })
})
