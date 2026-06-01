/**
 * Prune verb — archive ORPHANED mirror pages.
 *
 * An orphan is a Notion page whose backing KB note has been DELETED: its
 * `kb_notion_mirror_url` existed in git history (or is deleted in the working
 * tree) but is no longer present in any live note on disk. A note that merely
 * MOVED keeps its url in its new location, so it reads as live and is never an
 * orphan — only genuine deletions are pruned.
 *
 * Detection is git-driven: the KB root must be a git repository. For every note
 * deleted under the scanned path (committed deletions + working-tree deletions
 * relative to HEAD) we read its url from the pre-deletion blob, then diff against
 * the set of urls live in the current working tree. Archiving is dry-run by
 * default at the tool boundary.
 *
 * NOTE: a parent page that listed an archived child keeps a stale footer link
 * until the next `tree`/`roots` update re-renders it — run a publish after a
 * non-dry prune (or as part of the same reconcile).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../config/index.js'
import { archivePage, extractPageIdFromUrl } from '../notion-client/index.js'
import { readFrontmatter } from './discover.js'
import type { NoteOutcome, TreeResult } from './index.js'
import type { MirrorSettings } from './settings.js'

const requireRoot = (cfg: Config): string => {
  if (!cfg.kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set — prune needs the KB root.')
  return cfg.kbRoot
}

/** Run git in the KB root with paths never shell-expanded (KB paths contain spaces). Throws on non-zero exit. */
const git = (kbRoot: string, args: string[]): string => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: kbRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })

const ensureGitRepo = (kbRoot: string): void => {
  try {
    git(kbRoot, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error(`prune needs the KB root to be a git repository: ${kbRoot}`)
  }
}

/** Read `kb_notion_mirror_url` from a git blob (`<ref>:<path>`), or undefined if the blob/field is absent. Exported as a test seam. */
export const urlFromBlob = (kbRoot: string, ref: string): string | undefined => {
  let content: string
  try {
    content = git(kbRoot, ['show', ref]) // a path absent at <ref> exits non-zero
  } catch {
    return undefined
  }
  const url = readFrontmatter(content).kb_notion_mirror_url
  return url ? url.trim() : undefined
}

/**
 * Every `kb_notion_mirror_url` present in the current working tree, KB-wide.
 * Walks the filesystem (NOT git) so untracked/just-moved notes count as live —
 * otherwise a note moved into an untracked file would look deleted. Dotfolders
 * and skip-prefixed folders (e.g. the `+` inbox) are pruned.
 */
const liveUrls = (kbRoot: string, s: MirrorSettings): Set<string> => {
  const set = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (s.skipPrefixes.some((p) => e.name.startsWith(p))) continue
        walk(join(dir, e.name))
      } else if (e.name.endsWith('.md')) {
        const url = readFrontmatter(readFileSync(join(dir, e.name), 'utf-8')).kb_notion_mirror_url
        if (url) set.add(url.trim())
      }
    }
  }
  walk(kbRoot)
  return set
}

/** A note url recovered from a deletion, with the path it was deleted from. */
interface DeletedNote {
  kbPath: string
  url: string
}

/**
 * Every `(path, url)` recovered from a note deletion under `subtree` (or the
 * whole KB when omitted): for each path EVER deleted, the url from the blob just
 * before EACH of its deletions, plus working-tree deletions relative to HEAD.
 *
 * Reading every deletion (not just the latest) matters when a path is removed,
 * re-added with a different url, and removed again — each incarnation mirrored a
 * distinct page, so each can orphan. Pages whose url is still live (a move, or a
 * remove-then-readd of the same url) are filtered out later by `selectOrphans`.
 */
const deletedMirroredNotes = (kbRoot: string, subtree?: string): DeletedNote[] => {
  const pathspec = subtree ?? '.'
  const mdLines = (out: string): string[] =>
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.md'))
  const found: DeletedNote[] = []

  const everDeleted = new Set(mdLines(git(kbRoot, ['log', '--diff-filter=D', '--name-only', '--format=', '--', pathspec])))
  for (const kbPath of everDeleted) {
    const commits = git(kbRoot, ['log', '--diff-filter=D', '--format=%H', '--', kbPath])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    for (const c of commits) {
      const url = urlFromBlob(kbRoot, `${c}~1:${kbPath}`)
      if (url) found.push({ kbPath, url })
    }
  }

  // Working-tree deletions relative to HEAD (e.g. an uncommitted `rm`).
  for (const kbPath of mdLines(git(kbRoot, ['diff', '--diff-filter=D', '--name-only', 'HEAD', '--', pathspec]))) {
    const url = urlFromBlob(kbRoot, `HEAD:${kbPath}`)
    if (url) found.push({ kbPath, url })
  }

  return found
}

/**
 * Pure selection: from the recovered deletions and the live-url set, the pages
 * to archive — those whose url is no longer live anywhere in the working tree —
 * de-duplicated by Notion page id. Exported for unit testing without git/Notion.
 */
export const selectOrphans = (deleted: DeletedNote[], live: Set<string>): { kbPath: string; url: string; pageId: string }[] => {
  const seen = new Set<string>()
  const orphans: { kbPath: string; url: string; pageId: string }[] = []
  for (const { kbPath, url } of deleted) {
    if (live.has(url)) continue // moved / re-added under the same url — not an orphan
    const pageId = extractPageIdFromUrl(url)
    if (!pageId || seen.has(pageId)) continue
    seen.add(pageId)
    orphans.push({ kbPath, url, pageId })
  }
  return orphans
}

const prune = async (cfg: Config, s: MirrorSettings, opts: { subtree?: string; dryRun: boolean }): Promise<TreeResult> => {
  const kbRoot = requireRoot(cfg)
  ensureGitRepo(kbRoot)
  const orphans = selectOrphans(deletedMirroredNotes(kbRoot, opts.subtree), liveUrls(kbRoot, s))
  const outcomes: NoteOutcome[] = []
  for (const o of orphans) {
    if (opts.dryRun) {
      outcomes.push({ kbPath: o.kbPath, action: 'plan', url: o.url })
      continue
    }
    try {
      await archivePage(cfg, o.pageId)
      outcomes.push({ kbPath: o.kbPath, action: 'delete', url: o.url })
    } catch (err) {
      outcomes.push({ kbPath: o.kbPath, action: 'error', error: (err as Error).message })
    }
  }
  return { eligible: orphans.length, outcomes }
}

/**
 * Archive orphaned mirror pages for notes deleted under `subtree`. `dryRun`
 * (default true at the tool boundary) reports what would be archived without
 * calling Notion.
 */
export const pruneTree = (cfg: Config, subtree: string, s: MirrorSettings, opts: { dryRun: boolean }): Promise<TreeResult> => prune(cfg, s, { subtree, dryRun: opts.dryRun })

/** Archive orphaned mirror pages across the whole KB (every deleted note, any root). */
export const pruneRoots = (cfg: Config, s: MirrorSettings, opts: { dryRun: boolean }): Promise<TreeResult> => prune(cfg, s, { dryRun: opts.dryRun })
