/**
 * Tests for the high-level orchestrator API (preflight / status / pass1 / pass2
 * / publishAll / publishOne / unpublishOne). A temp KB fixture + a mocked Notion
 * `fetch` (vi.stubGlobal) + injected Config/settings/parent literals exercise
 * every outcome: create, replace, skip, plan (dry-run), error, the publishOne
 * ancestor chain, unpublishOne, preflight issues, and status counts.
 *
 * Asserts there is NO stdout/stderr output from the api layer.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Config, DEFAULT_BANNER_TEMPLATE } from '../config/index.js'
import { _clearTitlePropertyCache } from '../main/mirror/title-property.js'
import type { NotionParent } from '../main/notion-client/index.js'
import { pass1, pass2, preflight, publishAll, publishOne, status, unpublishOne } from './api.js'
import type { OrchestratorSettings } from './settings.js'

const DB_ID = '36f9f7187cc280f69272e60aa89bff24'
const ROOT_PARENT: NotionParent = { type: 'database_id', database_id: DB_ID }
const SUBTREE = 'Pillars/Engineering'

const DB_RESPONSE = { properties: { Name: { id: 'p', type: 'title' } } }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

// A page-create / page-fetch response. `hex` controls the id baked into the url.
const pageResponse = (hex: string) => ({
  id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  url: `https://www.notion.so/Note-${hex}`,
  created_time: '2026-05-30T01:13:00.000Z',
  last_edited_time: '2026-05-30T02:00:00.000Z',
  archived: false,
  parent: ROOT_PARENT,
  properties: { Name: { type: 'title', title: [{ plain_text: 'Note' }] } }
})

const fm = (fields: Record<string, string>): string => {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n# title\n\nbody.\n`
}

const settings = (overrides: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
  skipPrefixes: ['+'],
  skipKbPaths: new Set<string>(),
  iconBaseUrl: 'https://unpkg.com/lucide-static@latest/icons',
  ...overrides
})

describe('orchestrator api', () => {
  let kbRoot: string
  let cfg: Config
  let s: OrchestratorSettings
  let fetchMock: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(kbRoot, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
  }

  const read = (rel: string): Promise<string> => fsp.readFile(path.join(kbRoot, rel), 'utf-8')

  // A small stateful Notion stub: each POST /v1/pages mints a fresh page whose
  // id is a counter (so every created note lands on a distinct, well-formed
  // mirror URL) and remembers the parent it was created under. GET/PATCH echo
  // that recorded parent, so the cross-parent-type guard in publishNote (which
  // compares the page's current parent type against the requested one) never
  // false-fires during a replace.
  let pageCounter: number
  const parentByHex = new Map<string, unknown>()
  const routeHappy = (): void => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/v1/databases/')) return ok(DB_RESPONSE)
      if (url.endsWith('/v1/pages') && method === 'POST') {
        const hex = (pageCounter++).toString(16).padStart(32, '0')
        const reqParent = init?.body ? (JSON.parse(init.body) as { parent: unknown }).parent : ROOT_PARENT
        parentByHex.set(hex, reqParent)
        return ok({ ...pageResponse(hex), parent: reqParent })
      }
      const m = url.match(/\/v1\/pages\/([a-f0-9]{32})$/)
      if (m && (method === 'GET' || method === 'PATCH')) {
        const hex = m[1] as string
        return ok({ ...pageResponse(hex), parent: parentByHex.get(hex) ?? ROOT_PARENT })
      }
      if (url.includes('/children') && method === 'GET') return ok({ results: [], has_more: false, next_cursor: null })
      return ok({ results: [{ id: 'x' }] })
    })
  }

  beforeEach(async () => {
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-api-'))
    cfg = {
      notionToken: 'ntn_secrettoken',
      notionApiBaseUrl: 'https://api.notion.test',
      notionApiVersion: '2022-06-28',
      kbRoot,
      bannerTemplate: DEFAULT_BANNER_TEMPLATE,
      accessLevel: 'destructive',
      auditLogMode: 'off',
      auditLogPath: '',
      auditLogMaxBytes: 0,
      auditLogKeep: 0
    }
    s = settings()
    pageCounter = 1
    parentByHex.clear()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    _clearTitlePropertyCache()
  })

  afterEach(async () => {
    // The whole point: nothing in api.ts writes to stdout/stderr.
    expect(logSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await fsp.rm(kbRoot, { recursive: true, force: true })
  })

  describe('preflight', () => {
    it('reports no issues when every folder with notes has an index', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Leaf.md', fm({}))
      expect(preflight(kbRoot, SUBTREE, s)).toEqual({ issues: [] })
    })

    it('flags a sub-folder that has notes but no folder index', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Leaf.md', fm({})) // no Bioweave/Bioweave.md
      expect(preflight(kbRoot, SUBTREE, s).issues).toEqual(['Missing folder index: Pillars/Engineering/Bioweave/Bioweave.md'])
    })
  })

  describe('status', () => {
    it('counts published vs pending, ordered like a publish', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: `https://www.notion.so/E-${'a'.repeat(32)}` }))
      await write('Pillars/Engineering/Leaf.md', fm({}))
      const res = status(kbRoot, SUBTREE, s)
      expect(res).toEqual({
        total: 2,
        published: 1,
        pending: 1,
        notes: [
          { kbPath: 'Pillars/Engineering/Engineering.md', published: true },
          { kbPath: 'Pillars/Engineering/Leaf.md', published: false }
        ]
      })
    })
  })

  describe('publishAll', () => {
    it('throws when kbRoot is unset', async () => {
      await expect(publishAll({ ...cfg, kbRoot: undefined }, SUBTREE, ROOT_PARENT, s)).rejects.toThrow(/MCP_KB_NOTION_MIRROR_KB_ROOT must be set/)
    })

    it('creates pages in pass 1 and replaces them in pass 2, writing URLs back', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Leaf.md', fm({}))
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s)
      expect(res.eligible).toBe(2)
      expect(res.pass1.map((o) => o.action)).toEqual(['create', 'create'])
      expect(res.pass2.map((o) => o.action)).toEqual(['replace', 'replace'])
      // URLs were written back to disk.
      expect(await read('Pillars/Engineering/Engineering.md')).toMatch(/notion_mirror_url:/)
    })

    it('dry-run plans without calling Notion', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Leaf.md', fm({}))
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { dryRun: true })
      expect(res.pass1.map((o) => o.action)).toEqual(['plan', 'plan'])
      // pass2 sees no on-disk URLs → skips with the "run pass 1" note.
      expect(res.pass2.every((o) => o.action === 'skip')).toBe(true)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('onlyPass1 runs just the create pass', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass1: true })
      expect(res.pass1).toHaveLength(1)
      expect(res.pass2).toEqual([])
    })

    it('onlyPass2 runs just the replace pass', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: `https://www.notion.so/E-${'a'.repeat(32)}` }))
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass2: true })
      expect(res.pass1).toEqual([])
      expect(res.pass2.map((o) => o.action)).toEqual(['replace'])
    })

    it('skips an already-mirrored note in pass 1', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: `https://www.notion.so/E-${'a'.repeat(32)}` }))
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass1: true })
      expect(res.pass1[0]?.action).toBe('skip')
    })

    it('reports skip when publishNote (create) reports an already-mirrored note', async () => {
      // The on-disk URL is the plan placeholder, so pass1 does NOT pre-skip it
      // (the early skip ignores the placeholder) and instead calls publishNote,
      // which sees the real frontmatter URL and returns { skipped }.
      const PLACEHOLDER = 'https://www.notion.so/PLANNED-00000000000000000000000000000000'
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: PLACEHOLDER }))
      routeHappy()
      const note = { kbPath: 'Pillars/Engineering/Engineering.md', fullPath: path.join(kbRoot, SUBTREE, 'Engineering.md'), base: 'Engineering', parentFolder: 'Engineering', isIndex: true, fields: {} }
      const res = await pass1(cfg, SUBTREE, ROOT_PARENT, s, [note], false)
      expect(res[0]).toMatchObject({ action: 'skip', url: PLACEHOLDER })
    })
  })

  describe('pass1 error handling', () => {
    it('records an error when the parent index is missing (unresolvable parent)', async () => {
      // A leaf whose containing folder index was never discovered/published.
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Sub/Leaf.md', fm({})) // no Sub/Sub.md index
      routeHappy()
      // Order the two real notes but hand pass1 only the leaf so its parent index is absent.
      const leafNote = { kbPath: 'Pillars/Engineering/Sub/Leaf.md', fullPath: path.join(kbRoot, 'Pillars/Engineering/Sub/Leaf.md'), base: 'Leaf', parentFolder: 'Sub', isIndex: false, fields: {} }
      const res = await pass1(cfg, SUBTREE, ROOT_PARENT, s, [leafNote], false)
      expect(res[0]).toMatchObject({ action: 'error' })
      expect(res[0]?.error).toMatch(/required parent index not yet published/)
    })

    it('records an error when publishNote throws (e.g. note without frontmatter)', async () => {
      await fsp.mkdir(path.join(kbRoot, SUBTREE), { recursive: true })
      await fsp.writeFile(path.join(kbRoot, SUBTREE, 'Engineering.md'), 'no frontmatter at all\n')
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass1: true })
      expect(res.pass1[0]).toMatchObject({ action: 'error' })
      expect(res.pass1[0]?.error).toMatch(/no YAML frontmatter/)
    })
  })

  describe('pass2 error handling', () => {
    it('records an error and keeps going when a replace throws', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: 'https://www.notion.so/no-id-here' }))
      routeHappy()
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass2: true })
      expect(res.pass2[0]).toMatchObject({ action: 'error' })
      expect(res.pass2[0]?.error).toMatch(/Could not extract a 32-hex page id/)
    })

    it('records an error when the parent index is unresolvable in pass 2', async () => {
      const leafNote = { kbPath: 'Pillars/Engineering/Sub/Leaf.md', fullPath: path.join(kbRoot, 'Pillars/Engineering/Sub/Leaf.md'), base: 'Leaf', parentFolder: 'Sub', isIndex: false, fields: {} }
      await write('Pillars/Engineering/Sub/Leaf.md', fm({ notion_mirror_url: `https://www.notion.so/L-${'a'.repeat(32)}` }))
      routeHappy()
      const res = await pass2(cfg, SUBTREE, ROOT_PARENT, s, [leafNote], false)
      expect(res[0]).toMatchObject({ action: 'error' })
      expect(res[0]?.error).toMatch(/required parent index not yet published/)
    })

    it('plans (no Notion call) for an already-published note in dry-run', async () => {
      const url = `https://www.notion.so/E-${'a'.repeat(32)}`
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: url }))
      const res = await publishAll(cfg, SUBTREE, ROOT_PARENT, s, { onlyPass2: true, dryRun: true })
      expect(res.pass2[0]).toMatchObject({ action: 'plan', url })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reports skip when a note in the set has no URL on disk', async () => {
      const note = { kbPath: 'Pillars/Engineering/Engineering.md', fullPath: path.join(kbRoot, SUBTREE, 'Engineering.md'), base: 'Engineering', parentFolder: 'Engineering', isIndex: true, fields: {} }
      await write('Pillars/Engineering/Engineering.md', fm({}))
      const res = await pass2(cfg, SUBTREE, ROOT_PARENT, s, [note], false)
      expect(res[0]).toMatchObject({ action: 'skip', error: 'not yet published — run pass 1' })
    })
  })

  describe('publishOne', () => {
    it('throws when kbRoot is unset', async () => {
      await expect(publishOne({ ...cfg, kbRoot: undefined }, SUBTREE, ROOT_PARENT, s, 'x', false)).rejects.toThrow(/must be set to publish/)
    })

    it('throws when the target note is not discoverable', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await expect(publishOne(cfg, SUBTREE, ROOT_PARENT, s, 'Pillars/Engineering/Nope.md', false)).rejects.toThrow(/Not a discoverable/)
    })

    it('walks the ancestor chain for a deep leaf and publishes from the root down', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Leaf.md', fm({}))
      routeHappy()
      const res = await publishOne(cfg, SUBTREE, ROOT_PARENT, s, 'Pillars/Engineering/Bioweave/Leaf.md', false)
      expect(res.chain).toEqual(['Pillars/Engineering/Engineering.md', 'Pillars/Engineering/Bioweave/Bioweave.md', 'Pillars/Engineering/Bioweave/Leaf.md'])
      expect(res.pass1.map((o) => o.action)).toEqual(['create', 'create', 'create'])
    })

    it('stops the chain at the subtree-root index', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      routeHappy()
      const res = await publishOne(cfg, SUBTREE, ROOT_PARENT, s, 'Pillars/Engineering/Engineering.md', false)
      expect(res.chain).toEqual(['Pillars/Engineering/Engineering.md'])
    })

    it('stops the chain when a leaf has no folder-index ancestor', async () => {
      // Orphans/ has a leaf but no Orphans/Orphans.md index → the chain walk for
      // the leaf finds no folder index and stops (the `?? null` leaf branch).
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Orphans/Stray.md', fm({}))
      routeHappy()
      const res = await publishOne(cfg, SUBTREE, ROOT_PARENT, s, 'Pillars/Engineering/Orphans/Stray.md', true)
      expect(res.chain).toEqual(['Pillars/Engineering/Orphans/Stray.md'])
    })

    it('stops the chain when a sub-index has no grandparent index', async () => {
      // Orphans/Orphans.md is an index, but its grandparent index
      // (Engineering/Engineering.md) is absent → the `?? null` index branch.
      await write('Pillars/Engineering/Orphans/Orphans.md', fm({}))
      routeHappy()
      const res = await publishOne(cfg, SUBTREE, ROOT_PARENT, s, 'Pillars/Engineering/Orphans/Orphans.md', true)
      expect(res.chain).toEqual(['Pillars/Engineering/Orphans/Orphans.md'])
    })
  })

  describe('unpublishOne', () => {
    it('returns a dry-run result without calling Notion', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: `https://www.notion.so/E-${'a'.repeat(32)}` }))
      const res = await unpublishOne(cfg, 'Pillars/Engineering/Engineering.md', true)
      expect(res).toMatchObject({ dry_run: true })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('archives and clears frontmatter when dry_run is false', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: `https://www.notion.so/E-${'a'.repeat(32)}` }))
      routeHappy()
      const res = await unpublishOne(cfg, 'Pillars/Engineering/Engineering.md', false)
      expect(res).toMatchObject({ archived: true })
      expect(await read('Pillars/Engineering/Engineering.md')).not.toMatch(/notion_mirror_url:/)
    })

    it('reports not-published for a note with no mirror URL', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      expect(await unpublishOne(cfg, 'Pillars/Engineering/Engineering.md', false)).toEqual({ archived: false, reason: 'not-published' })
    })
  })
})
