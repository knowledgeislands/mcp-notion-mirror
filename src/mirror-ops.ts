/**
 * The four mirror operations — publish / unpublish / move / get — as pipeline
 * functions. The tool handlers (src/tools/mirror/index.ts) are thin wrappers
 * that validate args, call one of these, and map the result/throw to an MCP
 * envelope. Keeping the logic here (not in the excluded aggregator) makes every
 * branch unit-testable against a real temp file + a mocked Notion `fetch`.
 *
 * The MCP is file-aware but layout-agnostic: it reads the note's frontmatter +
 * body and writes back ONLY `notion_mirror_url` / `notion_mirror_published_at`.
 * It does not discover files, resolve parents, or know any folder convention —
 * the caller supplies `kb_path` and (for mutations) the Notion `parent`.
 */
import * as fs from 'node:fs/promises'
import { bannerBlock } from './banner.js'
import { refreshFooter } from './footer.js'
import { parseFrontmatter, removeFrontmatterFields, upsertFrontmatterFields } from './frontmatter.js'
import { bodyToBlocks, stripFrontmatter, stripLeadingH1, titleFromPath } from './markdown.js'
import {
  appendBlockChildren,
  archivePage,
  createPage,
  deleteBlock,
  extractPageIdFromUrl,
  getBlockChildren,
  getPage,
  type NotionIcon,
  type NotionParent,
  normalizePublishedAt,
  setPageParent,
  updatePage
} from './notion-client.js'
import { getDatabaseTitleProperty } from './title-property.js'
import { atomicWriteFile } from './utils/atomic-write.js'
import { resolveKbNotePath } from './utils/paths.js'
import { convertMentionPlaceholders, rewriteWikilinks } from './wikilinks.js'

export const MIRROR_FIELDS = ['notion_mirror_url', 'notion_mirror_published_at'] as const
const MAX_CHILDREN_PER_REQUEST = 100

/** Publish modes (Change in ENHANCEMENT-SPEC-02). `create` skips if mirrored; `replace` updates in place (URL preserved); `force` archives + recreates (URL changes). */
export type PublishMode = 'create' | 'replace' | 'force'

/** Optional publish extras: mode, legacy force alias, wikilink resolution, page icon. */
export interface PublishOptions {
  mode?: PublishMode
  /** @deprecated legacy alias for `mode: "force"`. */
  force?: boolean
  icon?: NotionIcon
  linkMap?: Record<string, string>
}

/** The page id of a Notion page parent, or undefined for a database/other parent. */
const pageParentId = (parent: Record<string, unknown>): string | undefined => (parent.type === 'page_id' ? (parent.page_id as string) : undefined)

/**
 * Refresh a parent's child-pages footer without ever failing the primary op —
 * the page is already published/moved/archived, so a flaky footer must not
 * surface as a tool error. Warns and swallows.
 */
const refreshFooterSafe = async (parentPageId: string): Promise<void> => {
  try {
    await refreshFooter(parentPageId)
  } catch (err) {
    console.error(`mcp-notion-mirror: child-pages footer refresh failed for parent ${parentPageId}:`, err)
  }
}

export type PublishResult = { url: string; page_id: string; published_at: string; mode: PublishMode } | { skipped: true; existing_url: string }

export type UnpublishResult =
  | { archived: true; page_id: string; url: string }
  | { dry_run: true; would_archive_url: string; would_archive_page_id: string; would_clear_fields: string[] }
  | { archived: false; reason: string }

export type MoveResult = { moved: true; page_id: string; previous_parent: Record<string, unknown>; new_parent: NotionParent }

export type GetResult =
  | { id: string; parent: Record<string, unknown>; title: string; created_time: string; last_edited_time: string; archived: boolean; url: string }
  | { exists: false; reason: string }

const readNote = async (kbPath: string): Promise<{ abs: string; raw: string; fields: Record<string, string>; hasFrontmatter: boolean }> => {
  const abs = resolveKbNotePath(kbPath)
  const raw = await fs.readFile(abs, 'utf-8')
  const { hasFrontmatter, fields } = parseFrontmatter(raw)
  return { abs, raw, fields, hasFrontmatter }
}

/**
 * Replace a page's body in place, preserving its native `child_page` blocks.
 * The new body is inserted immediately before the first child page (so it stays
 * above the children), then the old non-child blocks are deleted. Notion's
 * append-only API can't reorder, hence the insert-then-delete dance.
 */
const replaceBody = async (pageId: string, children: unknown[]): Promise<void> => {
  const blocks = await getBlockChildren(pageId)
  // Anchor = the last block before the first child page (end of the old body).
  let anchor: string | undefined
  for (const block of blocks) {
    if (block.type === 'child_page') break
    anchor = block.id
  }
  for (let i = 0; i < children.length; i += MAX_CHILDREN_PER_REQUEST) {
    const ids = await appendBlockChildren(pageId, children.slice(i, i + MAX_CHILDREN_PER_REQUEST), anchor)
    anchor = ids[ids.length - 1]
  }
  // Remove the old body + old footer heading, sparing real sub-pages.
  for (const block of blocks) {
    if (block.type !== 'child_page') await deleteBlock(block.id)
  }
}

/**
 * Publish a note under the caller-supplied `parent`.
 * - `create` (default): skip if already mirrored, else create.
 * - `replace`: update an existing page's body + properties in place (URL kept), else create.
 * - `force`: archive the existing page and create a new one (URL changes), else create.
 * `force: true` is a legacy alias for `mode: "force"`.
 */
export const publishNote = async (kbPath: string, parent: NotionParent, options: PublishOptions = {}): Promise<PublishResult> => {
  const mode: PublishMode = options.mode ?? (options.force ? 'force' : 'create')
  if (options.force && options.mode === undefined) {
    console.error('mcp-notion-mirror: `force: true` is deprecated; pass `mode: "force"` instead.')
  }

  const { abs, raw, fields, hasFrontmatter } = await readNote(kbPath)
  if (!hasFrontmatter) throw new Error('Note has no YAML frontmatter; refusing to publish.')

  const existing = fields.notion_mirror_url
  if (existing && mode === 'create') return { skipped: true, existing_url: existing }

  const title = titleFromPath(abs)
  // Resolve wikilinks AFTER frontmatter/H1 strip but BEFORE martian, then turn
  // the mention placeholders martian carried through into real page mentions.
  const body = rewriteWikilinks(stripLeadingH1(stripFrontmatter(raw)), options.linkMap ?? {})
  const bodyBlocks = convertMentionPlaceholders(bodyToBlocks(body)) as unknown[]
  const banner = bannerBlock(new Date().toISOString().slice(0, 10))
  const children = banner ? [banner, ...bodyBlocks] : bodyBlocks
  if (children.length === 0) throw new Error('Nothing to publish: the note body is empty and the banner is disabled.')

  const titleProperty = parent.type === 'database_id' ? await getDatabaseTitleProperty(parent.database_id) : undefined

  // In-place update: keep the URL, refresh body + properties.
  if (existing && mode === 'replace') {
    const pageId = extractPageIdFromUrl(existing)
    if (!pageId) throw new Error(`Could not extract a 32-hex page id from notion_mirror_url: ${existing}`)
    const page = await updatePage(pageId, { parent, title, titleProperty, icon: options.icon })
    await replaceBody(pageId, children)
    const publishedAt = normalizePublishedAt(page.last_edited_time)
    await atomicWriteFile(abs, upsertFrontmatterFields(raw, { notion_mirror_published_at: publishedAt }))
    // Body replace cleared this page's footer heading; regenerate it. Refresh the
    // parent's footer too in case `replace` re-parented the page.
    await refreshFooterSafe(pageId)
    if (parent.type === 'page_id') await refreshFooterSafe(parent.page_id)
    return { url: existing, page_id: pageId, published_at: publishedAt, mode }
  }

  // force against an existing mirror: archive it first, then create a fresh page.
  if (existing && mode === 'force') {
    const oldId = extractPageIdFromUrl(existing)
    if (oldId) await archivePage(oldId).catch(() => undefined)
  }

  const page = await createPage({ parent, title, children, titleProperty, icon: options.icon })
  const publishedAt = normalizePublishedAt(page.created_time)
  await atomicWriteFile(abs, upsertFrontmatterFields(raw, { notion_mirror_url: page.url, notion_mirror_published_at: publishedAt }))

  // A new child page lands in its page parent; refresh that parent's footer.
  // Database parents need none — the database's views already list their rows.
  if (parent.type === 'page_id') await refreshFooterSafe(parent.page_id)

  return { url: page.url, page_id: page.id, published_at: publishedAt, mode }
}

/** Archive the note's mirror page and clear the two mirror fields. Dry-run by default. */
export const unpublishNote = async (kbPath: string, dryRun: boolean): Promise<UnpublishResult> => {
  const { abs, raw, fields } = await readNote(kbPath)
  const mirror = fields.notion_mirror_url
  if (!mirror) return { archived: false, reason: 'not-published' }
  const pageId = extractPageIdFromUrl(mirror)
  if (!pageId) throw new Error(`Could not extract a 32-hex page id from notion_mirror_url: ${mirror}`)

  if (dryRun) {
    return { dry_run: true, would_archive_url: mirror, would_archive_page_id: pageId, would_clear_fields: [...MIRROR_FIELDS] }
  }

  // Learn the parent before archiving so we can refresh its footer afterwards.
  const parentId = pageParentId((await getPage(pageId)).parent)
  await archivePage(pageId)
  const cleared = removeFrontmatterFields(raw, [...MIRROR_FIELDS])
  await atomicWriteFile(abs, cleared)

  // The archived child should fall out of its page parent's footer.
  if (parentId) await refreshFooterSafe(parentId)

  return { archived: true, page_id: pageId, url: mirror }
}

/** Re-parent the note's mirror page to `parent`. No frontmatter change — the URL is stable. */
export const moveNote = async (kbPath: string, parent: NotionParent): Promise<MoveResult> => {
  const { fields } = await readNote(kbPath)
  const mirror = fields.notion_mirror_url
  if (!mirror) throw new Error('Note is not published — cannot move.')
  const pageId = extractPageIdFromUrl(mirror)
  if (!pageId) throw new Error(`Could not extract a 32-hex page id from notion_mirror_url: ${mirror}`)

  const before = await getPage(pageId)
  await setPageParent(pageId, parent)

  // Notion silently ignores a parent change that crosses the page-id ↔
  // database-id boundary. Detect it: if the parent type changed but a re-fetch
  // shows the same parent, the move was a no-op.
  if (before.parent.type !== parent.type) {
    const after = await getPage(pageId)
    if (JSON.stringify(after.parent) === JSON.stringify(before.parent)) {
      throw new Error('Notion silently ignored the parent change — cannot move between page-id and database-id parents. Use unpublish + publish instead.')
    }
  }

  // The moved child falls out of the old parent's footer and into the new one;
  // refresh both (database parents need no footer).
  const oldParentId = pageParentId(before.parent)
  if (oldParentId) await refreshFooterSafe(oldParentId)
  if (parent.type === 'page_id') await refreshFooterSafe(parent.page_id)

  return { moved: true, page_id: pageId, previous_parent: before.parent, new_parent: parent }
}

/** Fetch the live Notion state of the note's mirror page. Pure read — no file mutation. */
export const getNote = async (kbPath: string): Promise<GetResult> => {
  const { fields } = await readNote(kbPath)
  const mirror = fields.notion_mirror_url
  if (!mirror) return { exists: false, reason: 'not-published' }
  const pageId = extractPageIdFromUrl(mirror)
  if (!pageId) throw new Error(`Could not extract a 32-hex page id from notion_mirror_url: ${mirror}`)

  const page = await getPage(pageId)
  return {
    id: page.id,
    parent: page.parent,
    title: page.title,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: page.archived,
    url: page.url
  }
}
