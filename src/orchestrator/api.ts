/**
 * High-level orchestrator operations: preflight, status, pass1, pass2,
 * publishAll, publishOne, unpublishOne. Built on top of discover/order/resolve
 * and the single-note mirror operations (`publishNote`, `unpublishNote`).
 *
 * Every function here RETURNS structured data — there is NO console.* anywhere
 * in this module. This is mandatory: the MCP server speaks JSON-RPC over stdout,
 * so nothing reachable from a tool may write to stdout. Human-readable
 * formatting is the CLI's job (src/orchestrator/cli.ts), built from these
 * return values.
 *
 * Each operation takes a `subtree` (a kb-relative folder path under kbRoot) and,
 * for mutations, the `rootParent` the subtree-root index attaches under. Neither
 * is fixed — the caller supplies both per call.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Config } from '../config/index.js'
import { publishNote, type UnpublishResult, unpublishNote } from '../main/mirror/index.js'
import type { NotionParent } from '../main/notion-client/index.js'
import { buildLinkMap, discover, iconFor, indexKbPathFor, type Note, publishOrder, readFrontmatter, resolveParent } from './discover.js'
import type { OrchestratorSettings } from './settings.js'

const PLAN_PLACEHOLDER_URL = 'https://www.notion.so/PLANNED-00000000000000000000000000000000'

/** The outcome of acting on a single note during a pass. */
export interface NoteOutcome {
  kbPath: string
  action: 'create' | 'replace' | 'skip' | 'plan' | 'error'
  url?: string
  error?: string
}

/** Surface KB-shape issues that would force notes to be skipped during publish. */
export const preflight = (kbRoot: string, subtree: string, s: OrchestratorSettings): { issues: string[] } => {
  const notes = discover(kbRoot, subtree, s)
  const rootPath = join(kbRoot, subtree)
  const issues: string[] = []
  const dirsWithNotes = new Set<string>()
  for (const n of notes) dirsWithNotes.add(dirname(n.fullPath))
  for (const dir of dirsWithNotes) {
    if (dir === rootPath) continue
    const idxPath = join(dir, `${basename(dir)}.md`)
    try {
      statSync(idxPath)
    } catch {
      issues.push(`Missing folder index: ${relative(kbRoot, idxPath)}`)
    }
  }
  return { issues }
}

/** A published/pending listing, ordered like a publish would visit the notes. */
export const status = (kbRoot: string, subtree: string, s: OrchestratorSettings): { total: number; published: number; pending: number; notes: { kbPath: string; published: boolean }[] } => {
  const ordered = publishOrder(kbRoot, subtree, s, discover(kbRoot, subtree, s))
  let published = 0
  let pending = 0
  const notes = ordered.map((n) => {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    const isPublished = Boolean(fresh.notion_mirror_url)
    if (isPublished) published++
    else pending++
    return { kbPath: n.kbPath, published: isPublished }
  })
  return { total: ordered.length, published, pending, notes }
}

/** Pass 1: `mode: "create"` everything that isn't already mirrored. Returns one outcome per note. */
export const pass1 = async (cfg: Config, subtree: string, parent: NotionParent, s: OrchestratorSettings, notes: Note[], dryRun: boolean): Promise<NoteOutcome[]> => {
  const urlByKbPath = new Map<string, string>()
  for (const n of notes) {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    if (fresh.notion_mirror_url) urlByKbPath.set(n.kbPath, fresh.notion_mirror_url)
  }
  const outcomes: NoteOutcome[] = []
  for (const n of notes) {
    const have = urlByKbPath.get(n.kbPath)
    if (have && have !== PLAN_PLACEHOLDER_URL) {
      outcomes.push({ kbPath: n.kbPath, action: 'skip', url: have })
      continue
    }
    let resolved: NotionParent
    try {
      resolved = resolveParent(n, subtree, parent, urlByKbPath)
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
      continue
    }
    const icon = iconFor(n.fields.icon, s)
    if (dryRun) {
      urlByKbPath.set(n.kbPath, PLAN_PLACEHOLDER_URL)
      outcomes.push({ kbPath: n.kbPath, action: 'plan' })
      continue
    }
    try {
      const res = await publishNote(cfg, n.kbPath, resolved, { mode: 'create', icon, linkMap: {} })
      if ('skipped' in res) {
        urlByKbPath.set(n.kbPath, res.existing_url)
        outcomes.push({ kbPath: n.kbPath, action: 'skip', url: res.existing_url })
      } else {
        urlByKbPath.set(n.kbPath, res.url)
        outcomes.push({ kbPath: n.kbPath, action: 'create', url: res.url })
      }
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return outcomes
}

/** Pass 2: `mode: "replace"` everything that IS mirrored, refreshing body + linkMap. */
export const pass2 = async (cfg: Config, subtree: string, parent: NotionParent, s: OrchestratorSettings, notes: Note[], dryRun: boolean): Promise<NoteOutcome[]> => {
  const linkMap = buildLinkMap(notes)
  const urlByKbPath = new Map<string, string>()
  for (const n of notes) {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    if (fresh.notion_mirror_url) urlByKbPath.set(n.kbPath, fresh.notion_mirror_url)
  }
  const outcomes: NoteOutcome[] = []
  for (const n of notes) {
    const have = urlByKbPath.get(n.kbPath)
    if (!have) {
      outcomes.push({ kbPath: n.kbPath, action: 'skip', error: 'not yet published — run pass 1' })
      continue
    }
    let resolved: NotionParent
    try {
      resolved = resolveParent(n, subtree, parent, urlByKbPath)
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
      continue
    }
    const icon = iconFor(n.fields.icon, s)
    if (dryRun) {
      outcomes.push({ kbPath: n.kbPath, action: 'plan', url: have })
      continue
    }
    try {
      // `replace` always updates in place (it never skips — skip is a create-mode
      // outcome), so the result is always the replaced page with a stable url.
      const res = (await publishNote(cfg, n.kbPath, resolved, { mode: 'replace', icon, linkMap })) as { url: string }
      outcomes.push({ kbPath: n.kbPath, action: 'replace', url: res.url })
    } catch (err) {
      // Pass 2 is best-effort — record the error but keep going so the rest of the tree still updates.
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return outcomes
}

export interface PublishAllOptions {
  dryRun?: boolean
  onlyPass1?: boolean
  onlyPass2?: boolean
}

export interface PublishAllResult {
  eligible: number
  pass1: NoteOutcome[]
  pass2: NoteOutcome[]
}

/** Full two-pass publish over every discovered note in the subtree (or just one pass when flagged). */
export const publishAll = async (cfg: Config, subtree: string, parent: NotionParent, s: OrchestratorSettings, opts: PublishAllOptions = {}): Promise<PublishAllResult> => {
  const kbRoot = cfg.kbRoot
  if (!kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set to publish — the orchestrator needs a root to walk.')
  const notes = publishOrder(kbRoot, subtree, s, discover(kbRoot, subtree, s))
  const dryRun = opts.dryRun ?? false
  const p1 = opts.onlyPass2 ? [] : await pass1(cfg, subtree, parent, s, notes, dryRun)
  const p2 = opts.onlyPass1 ? [] : await pass2(cfg, subtree, parent, s, notes, dryRun)
  return { eligible: notes.length, pass1: p1, pass2: p2 }
}

export interface PublishOneResult {
  chain: string[]
  pass1: NoteOutcome[]
  pass2: NoteOutcome[]
}

/**
 * Publish one note. Walks up the parent chain (containing / grandparent indexes)
 * within the subtree so any unpublished ancestor is created first — handy when a
 * leaf in a never-published subtree needs to land.
 */
export const publishOne = async (cfg: Config, subtree: string, parent: NotionParent, s: OrchestratorSettings, kbPath: string, dryRun: boolean): Promise<PublishOneResult> => {
  const kbRoot = cfg.kbRoot
  if (!kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set to publish.')
  const all = publishOrder(kbRoot, subtree, s, discover(kbRoot, subtree, s))
  const target = all.find((n) => n.kbPath === kbPath)
  if (!target) throw new Error(`Not a discoverable mirror-eligible note: ${kbPath}`)
  const chain: Note[] = []
  let cursor: Note | null = target
  while (cursor) {
    chain.unshift(cursor)
    const folder = dirname(cursor.kbPath)
    if (cursor.isIndex) {
      if (folder === subtree) break
      const idx = indexKbPathFor(dirname(folder))
      cursor = all.find((n) => n.kbPath === idx) ?? null
    } else {
      const idx = indexKbPathFor(folder)
      cursor = all.find((n) => n.kbPath === idx) ?? null
    }
  }
  const p1 = await pass1(cfg, subtree, parent, s, chain, dryRun)
  const p2 = await pass2(cfg, subtree, parent, s, chain, dryRun)
  return { chain: chain.map((n) => n.kbPath), pass1: p1, pass2: p2 }
}

/** Unpublish one note (archive its Notion page + clear mirror frontmatter). Returns the UnpublishResult. */
export const unpublishOne = (cfg: Config, kbPath: string, dryRun: boolean): Promise<UnpublishResult> => unpublishNote(cfg, kbPath, dryRun)
