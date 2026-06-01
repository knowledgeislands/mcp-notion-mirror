/**
 * Tests for the prune verb (orphan detection + archival). A real temp GIT repo
 * fixture drives the git-diff orphan finder; a mocked Notion `fetch`
 * (vi.stubGlobal) exercises the archive path. Covers: a committed deletion that
 * orphans, a committed deletion with no mirror url (ignored), a MOVE (url stays
 * live → not an orphan), a working-tree deletion that orphans, the dry-run plan
 * path, the non-dry archive (success + error), pruneRoots vs pruneTree, the
 * git-repo guard, the kbRoot guard, and the selectOrphans/urlFromBlob seams.
 *
 * Fixtures use a synthetic Greek scheme (Alpha/Beta…), never real KB names.
 * Asserts the prune layer writes nothing to stdout/stderr.
 */
import { execFileSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Config, DEFAULT_BANNER_TEMPLATE } from '../../config/index.js'
import { pruneRoots, pruneTree, selectOrphans } from './index.js'
import { urlFromBlob } from './prune.js'
import type { MirrorSettings } from './settings.js'

const hex = (n: number): string => n.toString(16).padStart(32, '0')
const noteUrl = (n: number): string => `https://www.notion.so/Note-${hex(n)}`
const fm = (fields: Record<string, string>): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n# t\n\nbody.\n`

const settings = (overrides: Partial<MirrorSettings> = {}): MirrorSettings => ({
  skipPrefixes: ['+'],
  skipKbPaths: new Set<string>(),
  iconBaseUrl: 'https://unpkg.com/lucide-static@latest/icons',
  ...overrides
})

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('selectOrphans', () => {
  it('keeps deleted urls absent from the live set, drops moved/duplicate/malformed', () => {
    const deleted = [
      { kbPath: 'A/Gone.md', url: noteUrl(3) }, // orphan
      { kbPath: 'A/Moved.md', url: noteUrl(4) }, // moved — url is live
      { kbPath: 'A/Dup.md', url: noteUrl(3) }, // same page id as Gone → de-duped
      { kbPath: 'A/Bad.md', url: 'https://www.notion.so/no-hex-here' } // no extractable page id
    ]
    const live = new Set([noteUrl(4)])
    expect(selectOrphans(deleted, live)).toEqual([{ kbPath: 'A/Gone.md', url: noteUrl(3), pageId: hex(3) }])
  })
})

describe('prune', () => {
  let kbRoot: string
  let cfg: Config
  let s: MirrorSettings
  let fetchMock: ReturnType<typeof vi.fn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: kbRoot, stdio: 'pipe' })
  }
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(kbRoot, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
  }

  // Build a repo with one committed orphan (Gone), a no-url committed deletion
  // (NoMirror), a move (Moved → Sub/Moved, url stays live), a nested live note,
  // a no-url live note (Plain), a skip-prefixed note (+/Inbox), then an
  // uncommitted working-tree deletion (Keep).
  const buildFixture = async (): Promise<void> => {
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'Tester')
    git('config', 'commit.gpgsign', 'false')
    await write('Alpha/Alpha.md', fm({ kb_notion_mirror_url: noteUrl(1) }))
    await write('Alpha/Keep.md', fm({ kb_notion_mirror_url: noteUrl(2) }))
    await write('Alpha/Gone.md', fm({ kb_notion_mirror_url: noteUrl(3) }))
    await write('Alpha/Moved.md', fm({ kb_notion_mirror_url: noteUrl(4) }))
    await write('Alpha/NoMirror.md', fm({ status: 'draft' }))
    await write('Alpha/Plain.md', fm({ status: 'draft' }))
    await write('Alpha/PlainGone.md', fm({ status: 'draft' })) // no url, deleted in working tree
    await write('Alpha/Asset.txt', 'not markdown\n') // non-.md live file — must be ignored
    await write('Alpha/Sub/Sub.md', fm({ kb_notion_mirror_url: noteUrl(5) }))
    await write('Beta/Beta.md', fm({ kb_notion_mirror_url: noteUrl(6) }))
    await write('+/Inbox.md', fm({ kb_notion_mirror_url: noteUrl(7) }))
    git('add', '-A')
    git('commit', '-qm', 'c1')
    await fsp.rm(path.join(kbRoot, 'Alpha/Gone.md'))
    await fsp.rm(path.join(kbRoot, 'Alpha/NoMirror.md'))
    await write('Alpha/Sub/Moved.md', fm({ kb_notion_mirror_url: noteUrl(4) }))
    await fsp.rm(path.join(kbRoot, 'Alpha/Moved.md'))
    git('add', '-A')
    git('commit', '-qm', 'c2')
    await fsp.rm(path.join(kbRoot, 'Alpha/Keep.md')) // working-tree deletion (has url) → orphan
    await fsp.rm(path.join(kbRoot, 'Alpha/PlainGone.md')) // working-tree deletion (no url) → ignored
  }

  beforeEach(async () => {
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-prune-'))
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
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    expect(logSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await fsp.rm(kbRoot, { recursive: true, force: true })
  })

  it('dry-run plans the committed and working-tree orphans, ignoring moves and no-url deletions', async () => {
    await buildFixture()
    const res = await pruneTree(cfg, 'Alpha', s, { dryRun: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.eligible).toBe(2)
    expect(res.outcomes.map((o) => ({ kbPath: o.kbPath, action: o.action, url: o.url })).sort((a, b) => a.kbPath.localeCompare(b.kbPath))).toEqual([
      { kbPath: 'Alpha/Gone.md', action: 'plan', url: noteUrl(3) },
      { kbPath: 'Alpha/Keep.md', action: 'plan', url: noteUrl(2) }
    ])
  })

  it('finds nothing under a subtree with no deletions', async () => {
    await buildFixture()
    expect(await pruneTree(cfg, 'Beta', s, { dryRun: true })).toEqual({ eligible: 0, outcomes: [] })
  })

  it('catches every incarnation of a path removed, re-added under a new url, and removed again', async () => {
    kbRoot && (await fsp.rm(kbRoot, { recursive: true, force: true }))
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-prune-'))
    cfg = { ...cfg, kbRoot }
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'Tester')
    git('config', 'commit.gpgsign', 'false')
    await write('Gamma/Gamma.md', fm({ kb_notion_mirror_url: noteUrl(10) })) // keeps the subtree non-empty
    await write('Gamma/Twice.md', fm({ kb_notion_mirror_url: noteUrl(11) }))
    git('add', '-A')
    git('commit', '-qm', 'c1')
    await fsp.rm(path.join(kbRoot, 'Gamma/Twice.md'))
    git('add', '-A')
    git('commit', '-qm', 'c2 delete first incarnation')
    await write('Gamma/Twice.md', fm({ kb_notion_mirror_url: noteUrl(12) })) // re-added under a NEW url
    git('add', '-A')
    git('commit', '-qm', 'c3 re-add')
    await fsp.rm(path.join(kbRoot, 'Gamma/Twice.md'))
    git('add', '-A')
    git('commit', '-qm', 'c4 delete second incarnation')

    const res = await pruneTree(cfg, 'Gamma', s, { dryRun: true })
    expect(res.eligible).toBe(2)
    expect(new Set(res.outcomes.map((o) => o.url))).toEqual(new Set([noteUrl(11), noteUrl(12)]))
  })

  it('pruneRoots scans the whole KB and archives orphans when not a dry run', async () => {
    await buildFixture()
    fetchMock.mockImplementation(async () => ok({})) // fresh Response per call — bodies are single-use
    const res = await pruneRoots(cfg, s, { dryRun: false })
    expect(res.eligible).toBe(2)
    expect(res.outcomes.every((o) => o.action === 'delete')).toBe(true)
    // both orphan page ids were PATCH-archived
    const archived = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('/v1/pages/'))
    expect(archived).toEqual(expect.arrayContaining([`https://api.notion.test/v1/pages/${hex(2)}`, `https://api.notion.test/v1/pages/${hex(3)}`]))
  })

  it('records an error outcome when Notion archival fails', async () => {
    await buildFixture()
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const res = await pruneTree(cfg, 'Alpha', s, { dryRun: false })
    expect(res.eligible).toBe(2)
    expect(res.outcomes.every((o) => o.action === 'error')).toBe(true)
  })

  it('throws when the KB root is not a git repository', async () => {
    await expect(pruneRoots(cfg, s, { dryRun: true })).rejects.toThrow(/git repository/)
  })

  it('throws when no KB root is configured', async () => {
    await expect(pruneRoots({ ...cfg, kbRoot: undefined }, s, { dryRun: true })).rejects.toThrow(/KB root/)
  })

  describe('urlFromBlob', () => {
    it('reads a url from a blob, returns undefined for a missing ref or a url-less note', async () => {
      await buildFixture()
      expect(urlFromBlob(kbRoot, 'HEAD:Alpha/Alpha.md')).toBe(noteUrl(1))
      expect(urlFromBlob(kbRoot, 'HEAD:Alpha/Plain.md')).toBeUndefined()
      expect(urlFromBlob(kbRoot, 'HEAD:Alpha/does-not-exist.md')).toBeUndefined()
    })
  })
})
