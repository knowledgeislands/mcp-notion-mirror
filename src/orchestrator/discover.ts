/**
 * Discovery + ordering + parent resolution for the orchestrator.
 *
 * The convention this encodes (layout-agnostic, folder-index based): a folder's
 * index note (`<Folder>/<Folder>.md`, basename == containing-folder basename) is
 * that folder's Notion page. Leaf notes nest under their folder's index. A
 * sub-folder's index nests under the grandparent folder's index. The
 * subtree-root index (the index of the `subtree` folder itself) attaches to the
 * caller-supplied `rootParent`.
 *
 * Operations act on a `subtree` — a kb-relative folder path (e.g.
 * "Pillars/Engineering") — which may be ANY folder under kbRoot. There is no
 * fixed root folder and no fixed wiki database.
 *
 * All functions are pure: filesystem + settings in, plain values out — no
 * Notion calls, no logging. The async work happens in api.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { extractPageIdFromUrl, type NotionIcon, type NotionParent } from '../main/notion-client/index.js'
import type { OrchestratorSettings } from './settings.js'

export interface Note {
  /** Path relative to `kbRoot`, e.g. "Pillars/Engineering/Engineering.md". */
  kbPath: string
  fullPath: string
  /** Filename without `.md`. */
  base: string
  /** Basename of the containing directory. */
  parentFolder: string
  /** True iff `base === parentFolder` — the note is its folder's index. */
  isIndex: boolean
  /** Parsed top-level scalar frontmatter fields. */
  fields: Record<string, string>
}

/**
 * Read top-level scalar `key: value` lines from a YAML frontmatter block. Lists,
 * nested maps, and blank lines are ignored — the orchestrator only needs simple
 * fields (`icon`, `mirror`, `notion_mirror_url`, etc.).
 */
export const readFrontmatter = (content: string): Record<string, string> => {
  if (!content.startsWith('---\n')) return {}
  const close = content.indexOf('\n---', 4)
  if (close === -1) return {}
  const fm = content.slice(4, close)
  const out: Record<string, string> = {}
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!m) continue
    out[m[1] as string] = (m[2] as string).trim()
  }
  return out
}

const walkMd = function* (dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walkMd(full)
    else if (st.isFile() && name.endsWith('.md')) yield full
  }
}

const loadNote = (kbRoot: string, fullPath: string): Note => {
  const kbPath = relative(kbRoot, fullPath)
  const fields = readFrontmatter(readFileSync(fullPath, 'utf-8'))
  const base = basename(fullPath, '.md')
  const parentFolder = basename(dirname(fullPath))
  return { kbPath, fullPath, base, parentFolder, isIndex: base === parentFolder, fields }
}

const isEligible = (n: Note, s: OrchestratorSettings): boolean => {
  if (n.fields.mirror === 'exclude') return false
  if (s.skipKbPaths.has(n.kbPath)) return false
  if (s.skipPrefixes.some((p) => n.base.startsWith(p))) return false
  return true
}

/** Walk `<kbRoot>/<subtree>/` and return every mirror-eligible note. */
export const discover = (kbRoot: string, subtree: string, s: OrchestratorSettings): Note[] => {
  const rootPath = join(kbRoot, subtree)
  const out: Note[] = []
  for (const full of walkMd(rootPath)) {
    const n = loadNote(kbRoot, full)
    if (isEligible(n, s)) out.push(n)
  }
  return out
}

/**
 * Order `notes` for safe publishing: a folder's index first, then its leaves
 * alphabetically, then descend into sub-folders alphabetically (DFS preorder
 * from the `subtree` dir). Parents always come before children, so
 * `resolveParent` can find their URLs.
 */
export const publishOrder = (kbRoot: string, subtree: string, _s: OrchestratorSettings, notes: Note[]): Note[] => {
  const byDir = new Map<string, Note[]>()
  for (const n of notes) {
    const d = dirname(n.fullPath)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d)?.push(n)
  }
  const rootPath = join(kbRoot, subtree)
  const out: Note[] = []
  const visit = (dir: string): void => {
    const here = byDir.get(dir) ?? []
    const idx = here.find((n) => n.isIndex)
    const leaves = here.filter((n) => !n.isIndex).sort((a, b) => a.base.localeCompare(b.base))
    if (idx) out.push(idx)
    for (const l of leaves) out.push(l)
    const subs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
      .sort()
    for (const sub of subs) visit(sub)
  }
  visit(rootPath)
  return out
}

/** Compute the kb-path of the index note for a folder's kb-path. */
export const indexKbPathFor = (folderKbPath: string): string => `${folderKbPath}/${basename(folderKbPath)}.md`

/**
 * Resolve the Notion parent for `n`, given the subtree being published, the
 * caller-supplied `rootParent` (where the subtree-root index attaches), and a
 * map of already-published kbPath → URL. Throws if a required ancestor index
 * isn't in the map (parents must be published first; `publishOrder` ensures
 * this for non-degenerate trees).
 */
export const resolveParent = (n: Note, subtree: string, rootParent: NotionParent, urlByKbPath: Map<string, string>): NotionParent => {
  const folderKbPath = dirname(n.kbPath)
  if (n.isIndex) {
    if (folderKbPath === subtree) return rootParent
    const grandparentFolder = dirname(folderKbPath)
    const idx = indexKbPathFor(grandparentFolder)
    return pageParentFrom(idx, urlByKbPath)
  }
  const idx = indexKbPathFor(folderKbPath)
  return pageParentFrom(idx, urlByKbPath)
}

/** Look up the index note's mirror URL and turn it into a page_id parent. */
const pageParentFrom = (idx: string, urlByKbPath: Map<string, string>): NotionParent => {
  const url = urlByKbPath.get(idx)
  if (!url) throw new Error(`required parent index not yet published: ${idx}`)
  const pageId = extractPageIdFromUrl(url)
  if (!pageId) throw new Error(`bad URL on ${idx}: ${url}`)
  return { type: 'page_id', page_id: pageId }
}

/**
 * Build a wikilink → URL map by re-reading each note's `notion_mirror_url` from
 * disk. We read from disk (not from `notes[].fields`) because publish writes
 * URLs back to the file as it goes, so a fresh read gives the post-pass-1 state.
 *
 * Two aliases per note: bare basename (for `[[Engineering]]`) and the full path
 * sans `.md` (for `[[Pillars/Engineering/Engineering|Engineering]]`).
 */
export const buildLinkMap = (notes: Note[]): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const n of notes) {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    const url = fresh.notion_mirror_url
    if (!url) continue
    map[n.base] = url
    map[n.kbPath.replace(/\.md$/, '')] = url
  }
  return map
}

/** Build a Lucide external-icon for a kebab-case name, or undefined if no name. */
export const iconFor = (name: string | undefined, s: OrchestratorSettings): NotionIcon | undefined => {
  if (!name) return undefined
  return { type: 'external', external: { url: `${s.iconBaseUrl}/${name}.svg` } }
}
