/**
 * Tree verbs — status / preflight / touch / update / delete — over a `subtree`
 * (a kb-relative folder under kbRoot). Built on the discover/order/resolve
 * primitives and the single-note verbs (`touchNote`, `updateNote`, `deleteNote`).
 *
 * The tree layer's only job is traversal + ordering + parent resolution: it
 * walks the subtree, applies the folder-index hierarchy convention to compute
 * each note's Notion parent, and delegates the actual mirroring to the note
 * layer. Every function RETURNS structured data — there is NO console.* here, so
 * nothing reachable from a tool writes to stdout (the CLI does the printing).
 *
 * Mirroring stays two-phase: `touchTree` creates every scaffold (so all URLs
 * become known), then `updateTree` pushes bodies with a `linkMap` so
 * `[[wikilinks]]` resolve to `@mentions`. Pass an explicit `linkMap` to resolve
 * across a wider set than this subtree (e.g. cross-root, built by the CLI).
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from '../../config/index.js'
import { deleteNote, touchNote, updateNote } from '../notes/index.js'
import type { NotionParent } from '../notion-client/index.js'
import { buildLinkMap, discover, iconFor, indexKbPathFor, type Note, publishOrder, readFrontmatter, resolveParent } from './discover.js'
import type { MirrorSettings } from './settings.js'

/** The outcome of acting on a single note during a tree op. */
export interface NoteOutcome {
  kbPath: string
  action: 'touch' | 'update' | 'delete' | 'skip' | 'plan' | 'error'
  url?: string
  error?: string
}

export interface TreeResult {
  eligible: number
  outcomes: NoteOutcome[]
}

export interface TreeOneResult {
  chain: string[]
  outcomes: NoteOutcome[]
}

const requireRoot = (cfg: Config): string => {
  if (!cfg.kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set — the tree walk needs a root.')
  return cfg.kbRoot
}

/** Surface KB-shape issues that would force notes to be skipped during a tree op. */
export const preflightTree = (kbRoot: string, subtree: string, s: MirrorSettings): { issues: string[] } => {
  const notes = discover(kbRoot, subtree, s)
  const rootPath = `${kbRoot}/${subtree}`
  const issues: string[] = []
  const dirsWithNotes = new Set<string>()
  for (const n of notes) dirsWithNotes.add(dirname(n.fullPath))
  for (const dir of dirsWithNotes) {
    if (dir === rootPath) continue
    const folderName = dir.slice(dir.lastIndexOf('/') + 1)
    const idxPath = `${dir}/${folderName}.md`
    if (!notes.some((n) => n.fullPath === idxPath)) {
      issues.push(`Missing folder index: ${idxPath.slice(kbRoot.length + 1)}`)
    }
  }
  return { issues }
}

/** A published/pending listing, ordered like a tree op would visit the notes. */
export const statusTree = (kbRoot: string, subtree: string, s: MirrorSettings): { total: number; published: number; pending: number; notes: { kbPath: string; published: boolean }[] } => {
  const ordered = publishOrder(kbRoot, subtree, s, discover(kbRoot, subtree, s))
  let published = 0
  let pending = 0
  const notes = ordered.map((n) => {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    const isPublished = Boolean(fresh.kb_notion_mirror_url)
    if (isPublished) published++
    else pending++
    return { kbPath: n.kbPath, published: isPublished }
  })
  return { total: ordered.length, published, pending, notes }
}

/**
 * Resolve the note set a tree op acts on. With `kbPath`, restrict to that note's
 * ancestor chain (so an unmirrored ancestor is scaffolded before the leaf);
 * otherwise the whole ordered subtree.
 */
const notesFor = (kbRoot: string, subtree: string, s: MirrorSettings, kbPath: string | undefined): Note[] => {
  const all = publishOrder(kbRoot, subtree, s, discover(kbRoot, subtree, s))
  if (kbPath === undefined) return all
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
  return chain
}

/** Seed a kbPath→URL map from disk (already-touched notes), so resolveParent finds ancestor URLs. */
const seedUrls = (notes: Note[]): Map<string, string> => {
  const urlByKbPath = new Map<string, string>()
  for (const n of notes) {
    const fresh = readFrontmatter(readFileSync(n.fullPath, 'utf-8'))
    if (fresh.kb_notion_mirror_url) urlByKbPath.set(n.kbPath, fresh.kb_notion_mirror_url)
  }
  return urlByKbPath
}

/**
 * Touch every note in the subtree (or one note's ancestor chain) in DFS order,
 * scaffolding each under its folder-index parent so all URLs become known.
 * Idempotent — already-mirrored notes are skipped.
 */
export const touchTree = async (cfg: Config, subtree: string, parent: NotionParent, s: MirrorSettings, kbPath?: string): Promise<TreeResult> => {
  const kbRoot = requireRoot(cfg)
  const notes = notesFor(kbRoot, subtree, s, kbPath)
  // Seed ancestor URLs from disk so resolveParent finds indexes touched in a
  // prior run; touchNote itself is idempotent, so already-mirrored notes report
  // `skip` without a Notion create.
  const urlByKbPath = seedUrls(notes)
  const outcomes: NoteOutcome[] = []
  for (const n of notes) {
    let resolved: NotionParent
    try {
      resolved = resolveParent(n, subtree, parent, urlByKbPath)
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
      continue
    }
    try {
      const res = await touchNote(cfg, n.kbPath, resolved, { icon: iconFor(n.fields.icon, s) })
      const url = 'skipped' in res ? res.existing_url : res.url
      urlByKbPath.set(n.kbPath, url)
      outcomes.push({ kbPath: n.kbPath, action: 'skipped' in res ? 'skip' : 'touch', url })
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return { eligible: notes.length, outcomes }
}

/**
 * Update every touched note in the subtree (or one note's chain), pushing its
 * body and resolving `[[wikilinks]]` via `linkMap` (defaults to one built from
 * this subtree's notes; pass an explicit map for cross-root resolution). A note
 * that hasn't been touched is reported skipped, not created.
 */
export const updateTree = async (cfg: Config, subtree: string, parent: NotionParent, s: MirrorSettings, opts: { kbPath?: string; linkMap?: Record<string, string> } = {}): Promise<TreeResult> => {
  const kbRoot = requireRoot(cfg)
  const notes = notesFor(kbRoot, subtree, s, opts.kbPath)
  const linkMap = opts.linkMap ?? buildLinkMap(notes)
  const urlByKbPath = seedUrls(notes)
  const outcomes: NoteOutcome[] = []
  for (const n of notes) {
    const have = urlByKbPath.get(n.kbPath)
    if (!have) {
      outcomes.push({ kbPath: n.kbPath, action: 'skip', error: 'not yet touched — run touch first' })
      continue
    }
    let resolved: NotionParent
    try {
      resolved = resolveParent(n, subtree, parent, urlByKbPath)
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
      continue
    }
    try {
      const res = await updateNote(cfg, n.kbPath, resolved, { icon: iconFor(n.fields.icon, s), linkMap })
      outcomes.push({ kbPath: n.kbPath, action: 'update', url: res.url })
    } catch (err) {
      // Best-effort — record the error but keep going so the rest of the tree still updates.
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return { eligible: notes.length, outcomes }
}

/**
 * Delete every mirrored note in the subtree (or one note's chain), children
 * before parents. `dryRun` (default true at the tool boundary) reports what
 * would be archived without calling Notion or editing notes.
 */
export const deleteTree = async (cfg: Config, subtree: string, s: MirrorSettings, opts: { kbPath?: string; dryRun: boolean }): Promise<TreeResult> => {
  const kbRoot = requireRoot(cfg)
  const notes = [...notesFor(kbRoot, subtree, s, opts.kbPath)].reverse()
  const outcomes: NoteOutcome[] = []
  for (const n of notes) {
    try {
      const res = await deleteNote(cfg, n.kbPath, opts.dryRun)
      if ('dry_run' in res) outcomes.push({ kbPath: n.kbPath, action: 'plan', url: res.would_archive_url })
      else if (res.archived) outcomes.push({ kbPath: n.kbPath, action: 'delete', url: res.url })
      else outcomes.push({ kbPath: n.kbPath, action: 'skip' })
    } catch (err) {
      outcomes.push({ kbPath: n.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return { eligible: notes.length, outcomes }
}

/** Touch then update one note's ancestor chain in a subtree (single-note convenience for the CLI). */
export const publishTreeNote = async (cfg: Config, subtree: string, parent: NotionParent, s: MirrorSettings, kbPath: string): Promise<TreeOneResult> => {
  const touched = await touchTree(cfg, subtree, parent, s, kbPath)
  const updated = await updateTree(cfg, subtree, parent, s, { kbPath })
  return { chain: touched.outcomes.map((o) => o.kbPath), outcomes: [...touched.outcomes, ...updated.outcomes] }
}

export { pruneRoots, pruneTree, selectOrphans } from './prune.js'
