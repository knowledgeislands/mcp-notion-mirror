/**
 * Tests for the pure-FS pieces of the orchestrator: discover, publishOrder,
 * resolveParent, buildLinkMap, iconFor, readFrontmatter. Subtree-based — every
 * operation takes a kb-relative folder and the async API in `./api.ts` is
 * covered separately (api.test.ts).
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotionParent } from '../main/notion-client/index.js'
import { buildLinkMap, discover, iconFor, indexKbPathFor, publishOrder, readFrontmatter, resolveParent } from './discover.js'
import type { OrchestratorSettings } from './settings.js'

const PAGE_ID = '3709f7187cc281dd9a32c190c3eaf8b6'
const DB_ID = '36f9f7187cc280f69272e60aa89bff24'

const ENG_URL = `https://www.notion.so/Engineering-${PAGE_ID}`
const BIO_URL = `https://www.notion.so/Bioweave-${'b'.repeat(32)}`

const ROOT_PARENT: NotionParent = { type: 'database_id', database_id: DB_ID }

const fm = (fields: Record<string, string>): string => {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n# title\n\nbody.\n`
}

const settings = (overrides: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
  skipPrefixes: ['+'],
  skipKbPaths: new Set(['Pillars/Pillars.md']),
  iconBaseUrl: 'https://unpkg.com/lucide-static@latest/icons',
  ...overrides
})

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

describe('orchestrator FS layer', () => {
  let kbRoot: string
  let s: OrchestratorSettings
  const SUBTREE = 'Pillars/Engineering'

  const write = async (rel: string, content: string): Promise<string> => {
    const abs = path.join(kbRoot, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
    return abs
  }

  beforeEach(async () => {
    kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-orchestrator-'))
    s = settings()
  })

  afterEach(async () => {
    await fsp.rm(kbRoot, { recursive: true, force: true })
  })

  describe('discover', () => {
    it('includes folder-indexes and leaves; excludes mirror:exclude, "+"-prefixed, and skip paths', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ icon: 'cpu' }))
      await write('Pillars/Engineering/Approach/Approach.md', fm({ icon: 'compass' }))
      await write('Pillars/Engineering/Approach/Repositories.md', fm({ icon: 'git-branch' }))
      await write('Pillars/Engineering/Approach/Skip Me.md', fm({ mirror: 'exclude' }))
      await write('Pillars/Engineering/+Mirror Home.md', fm({}))
      const skip = settings({ skipKbPaths: new Set(['Pillars/Engineering/Approach/Repositories.md']) })
      const found = discover(kbRoot, SUBTREE, skip)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Pillars/Engineering/Approach/Approach.md', 'Pillars/Engineering/Engineering.md'])
    })

    it('walks any folder under kbRoot, not a fixed root', async () => {
      await write('Knowledge/Team/Team.md', fm({}))
      await write('Knowledge/Team/Charter.md', fm({}))
      const found = discover(kbRoot, 'Knowledge/Team', s)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Knowledge/Team/Charter.md', 'Knowledge/Team/Team.md'])
    })

    it('honours custom skip prefixes from settings', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/_internal.md', fm({}))
      const custom = settings({ skipPrefixes: ['_'] })
      const found = discover(kbRoot, SUBTREE, custom)
        .map((n) => n.kbPath)
        .sort()
      expect(found).toEqual(['Pillars/Engineering/Engineering.md'])
    })

    it('ignores non-markdown files in the tree', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/diagram.png', 'binary-ish')
      await write('Pillars/Engineering/notes.txt', 'plain')
      const found = discover(kbRoot, SUBTREE, s).map((n) => n.kbPath)
      expect(found).toEqual(['Pillars/Engineering/Engineering.md'])
    })
  })

  describe('publishOrder', () => {
    it('puts index notes before their leaf siblings, and visits sub-folders alphabetically', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Zeta Note.md', fm({}))
      await write('Pillars/Engineering/Alpha Note.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      await write('Pillars/Engineering/Approach/Approach.md', fm({}))
      const ordered = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s)).map((n) => n.kbPath)
      expect(ordered).toEqual([
        'Pillars/Engineering/Engineering.md',
        'Pillars/Engineering/Alpha Note.md',
        'Pillars/Engineering/Zeta Note.md',
        'Pillars/Engineering/Approach/Approach.md',
        'Pillars/Engineering/Bioweave/Bioweave.md'
      ])
    })

    it('handles a folder with leaves but no index, and descends through an empty intermediate folder', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      // A leaf-only folder (no Orphans/Orphans.md index) → the `if (idx)` false branch.
      await write('Pillars/Engineering/Orphans/Stray.md', fm({}))
      // An intermediate folder with no eligible notes of its own (only a deeper note)
      // → the `byDir.get(dir) ?? []` empty branch when visited.
      await write('Pillars/Engineering/Empty/Deeper/Deeper.md', fm({}))
      const ordered = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s)).map((n) => n.kbPath)
      expect(ordered).toEqual(['Pillars/Engineering/Engineering.md', 'Pillars/Engineering/Empty/Deeper/Deeper.md', 'Pillars/Engineering/Orphans/Stray.md'])
    })
  })

  describe('resolveParent', () => {
    it('routes the subtree-root index to the caller-supplied root parent', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      const [note] = discover(kbRoot, SUBTREE, s)
      expect(resolveParent(note!, SUBTREE, ROOT_PARENT, new Map())).toEqual(ROOT_PARENT)
    })

    it('routes a deeper folder index to the grandparent folder index page', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const bioweave = notes.find((n) => n.kbPath === 'Pillars/Engineering/Bioweave/Bioweave.md')!
      const urls = new Map([['Pillars/Engineering/Engineering.md', ENG_URL]])
      expect(resolveParent(bioweave, SUBTREE, ROOT_PARENT, urls)).toEqual({ type: 'page_id', page_id: PAGE_ID })
    })

    it('routes a leaf to its containing folder index page', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Domain Name Scheme.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const leaf = notes.find((n) => n.kbPath === 'Pillars/Engineering/Bioweave/Domain Name Scheme.md')!
      const urls = new Map([
        ['Pillars/Engineering/Engineering.md', ENG_URL],
        ['Pillars/Engineering/Bioweave/Bioweave.md', BIO_URL]
      ])
      const parent = resolveParent(leaf, SUBTREE, ROOT_PARENT, urls)
      expect(parent.type).toBe('page_id')
      expect((parent as { type: 'page_id'; page_id: string }).page_id).toBe('b'.repeat(32))
    })

    it("throws when the required parent index isn't in the URL map yet", async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const bioweave = notes.find((n) => n.kbPath === 'Pillars/Engineering/Bioweave/Bioweave.md')!
      expect(() => resolveParent(bioweave, SUBTREE, ROOT_PARENT, new Map())).toThrow(/required parent index not yet published/)
    })

    it('throws on a malformed index URL', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({}))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({}))
      const notes = publishOrder(kbRoot, SUBTREE, s, discover(kbRoot, SUBTREE, s))
      const bioweave = notes.find((n) => n.kbPath === 'Pillars/Engineering/Bioweave/Bioweave.md')!
      const urls = new Map([['Pillars/Engineering/Engineering.md', 'https://www.notion.so/no-id-here']])
      expect(() => resolveParent(bioweave, SUBTREE, ROOT_PARENT, urls)).toThrow(/bad URL/)
    })
  })

  describe('buildLinkMap', () => {
    it('aliases each published note by basename and by full kbPath without .md', async () => {
      await write('Pillars/Engineering/Engineering.md', fm({ notion_mirror_url: ENG_URL }))
      await write('Pillars/Engineering/Bioweave/Bioweave.md', fm({})) // unpublished — should be skipped
      const notes = discover(kbRoot, SUBTREE, s)
      expect(buildLinkMap(notes)).toEqual({
        Engineering: ENG_URL,
        'Pillars/Engineering/Engineering': ENG_URL
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
    expect(indexKbPathFor('Pillars/Engineering')).toBe('Pillars/Engineering/Engineering.md')
    expect(indexKbPathFor('Pillars/Engineering/Bioweave')).toBe('Pillars/Engineering/Bioweave/Bioweave.md')
  })
})
