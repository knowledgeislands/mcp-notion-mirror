/**
 * Tests for the pure-FS pieces of the tree walk: discover, publishOrder,
 * resolveParent, buildLinkMap, iconFor, readFrontmatter. Subtree-based — every
 * operation takes a kb-relative folder; the async verbs in `./index.ts` are
 * covered separately (index.test.ts), and roots discovery in `../roots`.
 *
 * Fixtures use a synthetic Greek scheme (Alpha/Beta/Gamma…), never real KB names.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotionParent } from '../notion-client/index.js'
import { buildLinkMap, discover, iconFor, indexKbPathFor, publishOrder, readFrontmatter, resolveParent } from './discover.js'
import type { MirrorSettings } from './settings.js'

const PAGE_ID = '3709f7187cc281dd9a32c190c3eaf8b6'
const DB_ID = '36f9f7187cc280f69272e60aa89bff24'

const ALPHA_URL = `https://www.notion.so/Alpha-${PAGE_ID}`
const BETA_URL = `https://www.notion.so/Beta-${'b'.repeat(32)}`

const ROOT_PARENT: NotionParent = { type: 'database_id', database_id: DB_ID }

const fm = (fields: Record<string, string>): string => {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n# title\n\nbody.\n`
}

const settings = (overrides: Partial<MirrorSettings> = {}): MirrorSettings => ({
  skipPrefixes: ['+'],
  skipKbPaths: new Set<string>(),
  iconBaseUrl: 'https://unpkg.com/lucide-static@latest/icons',
  ...overrides
})

// Asserts a lookup actually found something, then narrows it for the call that follows.
// Fails the test with a clear message rather than passing `undefined` downstream.
const defined = <T>(value: T | undefined): T => {
  expect(value).toBeDefined()
  return value as T
}

describe('readFrontmatter', () => {
  it('extracts top-level scalar fields, ignoring list items and nested keys', () => {
    const text = `---
tags:
  - card/note
status: current — May 2026
icon: cpu
---
# body
`
    expect(readFrontmatter(text)).toEqual({ tags: '', status: 'current — May 2026', icon: 'cpu' })
  })

  it('returns {} for content without a frontmatter block', () => {
    expect(readFrontmatter('no frontmatter here')).toEqual({})
    expect(readFrontmatter('---\nonly an opener')).toEqual({})
  })
})

describe('tree FS layer', () => {
  let kbRoot: string
  let s: MirrorSettings
  const SUBTREE = 'Alpha'

  const write = async (rel: string, content: string): Promise<string> => {
    const abs = path.join(kbRoot, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
    return abs
  }

  beforeEach(async () => {
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-discover-'))
    s = settings()
  })

  afterEach(async () => {
    await fsp.rm(kbRoot, { recursive: true, force: true })
  })

  describe('discover', () => {
    it('includes folder-indexes and leaves; excludes mirror:exclude, "+"-prefixed, and skip paths', async () => {
      await write('Alpha/Alpha.md', fm({ icon: 'cpu' }))
      await write('Alpha/Beta/Beta.md', fm({ icon: 'compass' }))
      await write('Alpha/Beta/Gamma.md', fm({ icon: 'git-branch' }))
      await write('Alpha/Beta/Skip Me.md', fm({ mirror: 'exclude' }))
      await write('Alpha/+Mirror Home.md', fm({}))
      const skip = settings({ skipKbPaths: new Set(['Alpha/Beta/Gamma.md']) })
      const found = discover(kbRoot, SUBTREE, skip)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Alpha/Alpha.md', 'Alpha/Beta/Beta.md'])
    })

    it('walks any folder under kbRoot, not a fixed root', async () => {
      await write('Other/Team/Team.md', fm({}))
      await write('Other/Team/Charter.md', fm({}))
      const found = discover(kbRoot, 'Other/Team', s)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Other/Team/Charter.md', 'Other/Team/Team.md'])
    })

    it('honours custom skip prefixes from settings', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/_internal.md', fm({}))
      const custom = settings({ skipPrefixes: ['_'] })
      const found = discover(kbRoot, SUBTREE, custom)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Alpha/Alpha.md'])
    })

    it('ignores non-markdown files and hidden entries in the tree', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/diagram.png', 'binary-ish')
      await write('Alpha/notes.txt', 'plain')
      await write('Alpha/.hidden.md', fm({})) // dotfile → skipped
      await write('Alpha/.obsidian/cfg.md', fm({})) // dot-dir → not descended
      const found = discover(kbRoot, SUBTREE, s).map((n) => n.kbPath)
      expect(found).toEqual(['Alpha/Alpha.md'])
    })

    it('drops a single note flagged kb_notion_mirror_exclude', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Secret.md', fm({ kb_notion_mirror_exclude: 'true' }))
      const found = discover(kbRoot, SUBTREE, s)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Alpha/Alpha.md'])
    })

    it('prunes the whole subtree when kb_notion_mirror_exclude is on a folder index', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Private/Private.md', fm({ kb_notion_mirror_exclude: 'true' }))
      await write('Alpha/Private/Deep/Deep.md', fm({}))
      await write('Alpha/Private/Deep/Leaf.md', fm({}))
      // A sibling folder sharing a name prefix must NOT be pruned.
      await write('Alpha/PrivateNotes/PrivateNotes.md', fm({}))
      const found = discover(kbRoot, SUBTREE, s)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Alpha/Alpha.md', 'Alpha/PrivateNotes/PrivateNotes.md'])
    })
  })

  describe('publishOrder', () => {
    it('puts index notes before their leaf siblings, and visits sub-folders alphabetically', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Zeta Note.md', fm({}))
      await write('Alpha/Alpha Note.md', fm({}))
      await write('Alpha/Delta/Delta.md', fm({}))
      await write('Alpha/Beta/Beta.md', fm({}))
      const ordered = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s)).map((n) => n.kbPath)
      expect(ordered).toEqual(['Alpha/Alpha.md', 'Alpha/Alpha Note.md', 'Alpha/Zeta Note.md', 'Alpha/Beta/Beta.md', 'Alpha/Delta/Delta.md'])
    })

    it('handles a folder with leaves but no index, and descends through an empty intermediate folder', async () => {
      await write('Alpha/Alpha.md', fm({}))
      // A leaf-only folder (no Orphans/Orphans.md index) → the `if (idx)` false branch.
      await write('Alpha/Orphans/Stray.md', fm({}))
      // An intermediate folder with no eligible notes of its own (only a deeper note)
      // → the `byDir.get(dir) ?? []` empty branch when visited.
      await write('Alpha/Empty/Deeper/Deeper.md', fm({}))
      const ordered = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s)).map((n) => n.kbPath)
      expect(ordered).toEqual(['Alpha/Alpha.md', 'Alpha/Empty/Deeper/Deeper.md', 'Alpha/Orphans/Stray.md'])
    })
  })

  describe('resolveParent', () => {
    it('routes the subtree-root index to the caller-supplied root parent', async () => {
      await write('Alpha/Alpha.md', fm({}))
      const [note] = discover(kbRoot, SUBTREE, s)
      expect(resolveParent(defined(note), SUBTREE, ROOT_PARENT, new Map())).toEqual(ROOT_PARENT)
    })

    it('routes a deeper folder index to the grandparent folder index page', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Beta/Beta.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const beta = defined(notes.find((n) => n.kbPath === 'Alpha/Beta/Beta.md'))
      const urls = new Map([['Alpha/Alpha.md', ALPHA_URL]])
      expect(resolveParent(beta, SUBTREE, ROOT_PARENT, urls)).toEqual({ type: 'page_id', page_id: PAGE_ID })
    })

    it('routes a leaf to its containing folder index page', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Beta/Beta.md', fm({}))
      await write('Alpha/Beta/Gamma.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const leaf = defined(notes.find((n) => n.kbPath === 'Alpha/Beta/Gamma.md'))
      const urls = new Map([
        ['Alpha/Alpha.md', ALPHA_URL],
        ['Alpha/Beta/Beta.md', BETA_URL]
      ])
      const parent = resolveParent(leaf, SUBTREE, ROOT_PARENT, urls)
      expect(parent.type).toBe('page_id')
      expect((parent as { type: 'page_id'; page_id: string }).page_id).toBe('b'.repeat(32))
    })

    it("throws when the required parent index isn't in the URL map yet", async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Beta/Beta.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const beta = defined(notes.find((n) => n.kbPath === 'Alpha/Beta/Beta.md'))
      expect(() => resolveParent(beta, SUBTREE, ROOT_PARENT, new Map())).toThrow(/required parent index not yet published/)
    })

    it('throws on a malformed index URL', async () => {
      await write('Alpha/Alpha.md', fm({}))
      await write('Alpha/Beta/Beta.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const beta = defined(notes.find((n) => n.kbPath === 'Alpha/Beta/Beta.md'))
      const urls = new Map([['Alpha/Alpha.md', 'https://www.notion.so/no-id-here']])
      expect(() => resolveParent(beta, SUBTREE, ROOT_PARENT, urls)).toThrow(/bad URL/)
    })
  })

  describe('buildLinkMap', () => {
    it('aliases each published note by basename and by full kbPath without .md', async () => {
      await write('Alpha/Alpha.md', fm({ kb_notion_mirror_url: ALPHA_URL }))
      await write('Alpha/Beta/Beta.md', fm({})) // unpublished — should be skipped
      const notes = discover(kbRoot, SUBTREE, s)
      expect(buildLinkMap(notes)).toEqual({
        Alpha: ALPHA_URL,
        'Alpha/Alpha': ALPHA_URL
      })
    })
  })

  describe('iconFor', () => {
    it('builds an external Lucide icon URL from a kebab-case name', () => {
      expect(iconFor('code-2', s)).toEqual({ type: 'external', external: { url: 'https://unpkg.com/lucide-static@latest/icons/code-2.svg' } })
    })
    it('returns undefined when no icon name is set', () => {
      expect(iconFor(undefined, s)).toBeUndefined()
    })
    it('honours a custom iconBaseUrl from settings', () => {
      const custom = settings({ iconBaseUrl: 'https://icons.example.com' })
      expect(iconFor('cpu', custom)).toEqual({ type: 'external', external: { url: 'https://icons.example.com/cpu.svg' } })
    })
  })
})

describe('indexKbPathFor', () => {
  it('appends the folder basename + .md', () => {
    expect(indexKbPathFor('Alpha')).toBe('Alpha/Alpha.md')
    expect(indexKbPathFor('Alpha/Beta')).toBe('Alpha/Beta/Beta.md')
  })
})
