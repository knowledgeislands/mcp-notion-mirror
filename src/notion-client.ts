/**
 * Minimal HTTP client for the Notion API. Every Notion call in this MCP goes
 * through here — no tool builds a raw `fetch`. This module owns the Bearer
 * header, the `Notion-Version` header, the JSON content type, and the
 * API-error → typed-error translation.
 *
 * Security: the token is read from config and attached as the Bearer header
 * only. It is NEVER interpolated into an error message, log line, or tool
 * output — NotionApiError carries the response status/code/body, none of which
 * contains the secret.
 */
import { NOTION_API_BASE_URL, NOTION_API_VERSION, NOTION_TOKEN } from './config.js'

/** Notion's hard cap on `children` per page-create / block-append request. */
const MAX_CHILDREN_PER_REQUEST = 100

export class NotionApiError extends Error {
  status: number
  code: string | undefined
  body: string
  constructor(status: number, body: string, code: string | undefined, message: string) {
    super(message)
    this.name = 'NotionApiError'
    this.status = status
    this.body = body
    this.code = code
  }
}

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_API_VERSION,
  Accept: 'application/json',
  'Content-Type': 'application/json'
})

const request = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', apiPath: string, body?: unknown): Promise<T> => {
  const resp = await fetch(`${NOTION_API_BASE_URL}${apiPath}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    let code: string | undefined
    let detail = text
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string }
      code = parsed.code
      if (parsed.message) detail = parsed.message
    } catch {
      // non-JSON error body — fall back to the raw text
    }
    const snippet = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
    throw new NotionApiError(resp.status, text, code, `Notion ${method} ${apiPath} → HTTP ${resp.status}${code ? ` (${code})` : ''}: ${snippet}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new NotionApiError(resp.status, text, undefined, `Notion ${method} ${apiPath} returned a non-JSON body (HTTP ${resp.status})`)
  }
}

const BARE_ID_RE = /^[a-f0-9]{32}$/
const DASHED_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/**
 * Normalise a Notion id to the 32-hex form Notion accepts in a URL path,
 * accepting either a bare 32-hex id or a dashed UUID (case-insensitive).
 * Throws before any id reaches an API path, so a malformed id can never be
 * substituted into a request URL.
 */
export const normalizeId = (id: string): string => {
  const lower = id.toLowerCase()
  if (BARE_ID_RE.test(lower)) return lower
  if (DASHED_ID_RE.test(lower)) return lower.replace(/-/g, '')
  throw new NotionApiError(0, '', 'invalid_id', `Refusing to call Notion with a malformed id: "${id}" (expected 32 hex chars or a dashed UUID)`)
}

/** Pull the 32-hex page id out of a notion.so URL (handles slug + query suffixes). */
export const extractPageIdFromUrl = (url: string): string | undefined => {
  const m = url.match(/([a-f0-9]{32})(?:$|\?|#)/)
  return m ? m[1] : undefined
}

/** Notion's `created_time` is RFC-3339 with millis (`…00.000Z`); the KB wants `…00Z`. */
export const normalizePublishedAt = (createdTime: string): string => createdTime.replace(/\.\d{3}Z$/, 'Z')

/** A Notion page parent — either a database row-host or another page. Passed to Notion verbatim. */
export type NotionParent = { type: 'database_id'; database_id: string } | { type: 'page_id'; page_id: string }

/** A Notion page icon, passed to Notion verbatim. */
export type NotionIcon = { type: 'emoji'; emoji: string } | { type: 'external'; external: { url: string } }

export interface NotionDatabase {
  properties: Record<string, { id: string; type: string }>
}

/** Raw `GET /v1/databases/{id}`. The title-property cache lives in title-property.ts. */
export const getDatabase = (databaseId: string): Promise<NotionDatabase> => request<NotionDatabase>('GET', `/v1/databases/${normalizeId(databaseId)}`)

interface NotionPageResponse {
  id: string
  url: string
  created_time: string
  last_edited_time: string
  archived: boolean
  parent: Record<string, unknown>
  properties: Record<string, unknown>
}

export interface CreatedPage {
  id: string
  url: string
  created_time: string
}

export interface UpdatedPage {
  id: string
  url: string
  last_edited_time: string
}

/**
 * Build the `properties` object for a page create. Under a database parent the
 * title lives in the database's title-typed property (its name varies per
 * wiki — discovered via title-property.ts). Under a page parent the new page is
 * a child page, and Notion only accepts the reserved `title` property.
 */
const titleProperties = (parent: NotionParent, title: string, titleProperty: string | undefined): Record<string, unknown> => {
  const value = { title: [{ text: { content: title } }] }
  if (parent.type === 'database_id') {
    if (titleProperty === undefined) {
      throw new NotionApiError(0, '', 'missing_title_property', 'A database-parented page needs the database title-property name.')
    }
    return { [titleProperty]: value }
  }
  return { title: value }
}

/**
 * Create a page under `parent`. Notion caps `children` at 100 per request, so
 * the first 100 blocks go in the create call and any remainder is appended in
 * 100-block batches via PATCH /v1/blocks/{id}/children.
 *
 * `titleProperty` is required for a database parent and ignored for a page
 * parent (where the title property is always the reserved `title`). `icon` (if
 * given) is set in the SAME create call — never a separate PATCH.
 */
export const createPage = async (params: { parent: NotionParent; title: string; children: unknown[]; titleProperty?: string; icon?: NotionIcon }): Promise<CreatedPage> => {
  const { parent, title, children, titleProperty, icon } = params
  const base: Record<string, unknown> = { parent, properties: titleProperties(parent, title, titleProperty), children: children.slice(0, MAX_CHILDREN_PER_REQUEST) }
  if (icon) base.icon = icon
  const page = await request<NotionPageResponse>('POST', '/v1/pages', base)
  for (let i = MAX_CHILDREN_PER_REQUEST; i < children.length; i += MAX_CHILDREN_PER_REQUEST) {
    await appendBlockChildren(page.id, children.slice(i, i + MAX_CHILDREN_PER_REQUEST))
  }
  return { id: page.id, url: page.url, created_time: page.created_time }
}

/**
 * Update an existing page's parent, title property, and icon in place (single
 * PATCH). Does NOT touch the page body — callers replace block children
 * separately. Returns the page's id/url/last_edited_time.
 */
export const updatePage = async (pageId: string, params: { parent: NotionParent; title: string; titleProperty?: string; icon?: NotionIcon }): Promise<UpdatedPage> => {
  const { parent, title, titleProperty, icon } = params
  const base: Record<string, unknown> = { parent, properties: titleProperties(parent, title, titleProperty) }
  if (icon) base.icon = icon
  const page = await request<NotionPageResponse>('PATCH', `/v1/pages/${normalizeId(pageId)}`, base)
  return { id: page.id, url: page.url, last_edited_time: page.last_edited_time }
}

/** Archive (soft-delete) a page. Idempotent — archiving an archived page is a no-op success. */
export const archivePage = async (pageId: string): Promise<void> => {
  await request('PATCH', `/v1/pages/${normalizeId(pageId)}`, { archived: true })
}

/** Re-parent a page. Notion moves the page (and its content) to the new parent; the URL is stable. */
export const setPageParent = async (pageId: string, parent: NotionParent): Promise<void> => {
  await request('PATCH', `/v1/pages/${normalizeId(pageId)}`, { parent })
}

export interface FetchedPage {
  id: string
  url: string
  parent: Record<string, unknown>
  created_time: string
  last_edited_time: string
  archived: boolean
  title: string
}

interface NotionRichText {
  plain_text?: string
}
interface NotionTitleProperty {
  type: string
  title?: NotionRichText[]
}

/** Extract the page title by concatenating the rich text of its title-typed property. */
const titleOf = (properties: Record<string, unknown>): string => {
  for (const value of Object.values(properties)) {
    const prop = value as NotionTitleProperty
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('')
    }
  }
  return ''
}

/** Fetch a page, returning its id/url, raw Notion `parent` object, timestamps, archived flag, and title. */
export const getPage = async (pageId: string): Promise<FetchedPage> => {
  const page = await request<NotionPageResponse>('GET', `/v1/pages/${normalizeId(pageId)}`)
  return {
    id: page.id,
    url: page.url,
    parent: page.parent,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: page.archived,
    title: titleOf(page.properties)
  }
}

/** One block in a `GET /v1/blocks/{id}/children` page. `child_page` blocks carry their title. */
export interface NotionBlock {
  id: string
  type: string
  child_page?: { title: string }
  [k: string]: unknown
}

interface BlockChildrenPage {
  results: NotionBlock[]
  has_more: boolean
  next_cursor: string | null
}

/**
 * All immediate children of a block/page, following pagination (Notion returns
 * 100 per page). Returns the blocks in Notion's natural (creation) order.
 */
export const getBlockChildren = async (blockId: string): Promise<NotionBlock[]> => {
  const id = normalizeId(blockId)
  const all: NotionBlock[] = []
  let cursor: string | null = null
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100'
    const page: BlockChildrenPage = await request<BlockChildrenPage>('GET', `/v1/blocks/${id}/children${qs}`)
    all.push(...page.results)
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor)
  return all
}

/**
 * Append children to a block/page, returning the created block ids (in order).
 * Pass `after` (a sibling block id) to position the new blocks right after it
 * instead of at the end.
 */
export const appendBlockChildren = async (blockId: string, children: unknown[], after?: string): Promise<string[]> => {
  const body = after === undefined ? { children } : { children, after: normalizeId(after) }
  const resp = await request<{ results?: Array<{ id: string }> }>('PATCH', `/v1/blocks/${normalizeId(blockId)}/children`, body)
  return (resp.results ?? []).map((b) => b.id)
}

/** Delete (archive) a single block. */
export const deleteBlock = async (blockId: string): Promise<void> => {
  await request('DELETE', `/v1/blocks/${normalizeId(blockId)}`)
}
