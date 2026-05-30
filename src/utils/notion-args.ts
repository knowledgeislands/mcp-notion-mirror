/**
 * Shared zod schemas for Notion arguments accepted by the MCP tools. Kept here
 * so the per-note mirror tools and the subtree orchestrator tools validate
 * `parent` / id arguments identically (a 32-hex Notion id or a dashed UUID,
 * passed to Notion verbatim).
 */
import { z } from 'zod'

/** A Notion id: bare 32-hex or a dashed UUID (case-insensitive). Passed to Notion verbatim. */
export const notionId = z.string().regex(/^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'must be a 32-hex Notion id or a dashed UUID')

/** A Notion parent object: `{ type: "database_id", database_id }` or `{ type: "page_id", page_id }`. */
export const parentArg = z
  .discriminatedUnion('type', [z.object({ type: z.literal('database_id'), database_id: notionId }).strict(), z.object({ type: z.literal('page_id'), page_id: notionId }).strict()])
  .describe('Notion parent object, passed to Notion verbatim: { type: "database_id", database_id } or { type: "page_id", page_id }. The caller decides which.')
