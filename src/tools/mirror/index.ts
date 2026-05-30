import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import { getNote, moveNote, publishNote, unpublishNote } from '../../main/mirror/index.js'
import type { NotionIcon, NotionParent } from '../../main/notion-client/index.js'
import { DESTRUCTIVE_REMOTE, READ_ONLY_REMOTE, WRITE_REMOTE } from '../../utils/annotations.js'
import { parentArg } from '../../utils/notion-args.js'
import { errorResult, jsonResult } from '../../utils/results.js'

const noParentSegment = (s: string): boolean => !s.split(/[\\/]/).includes('..')

const kbPathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine(noParentSegment, 'kb_path must not contain ".." segments')
  .describe('Path to the KB markdown note. Relative paths resolve against MCP_KB_NOTION_MIRROR_KB_ROOT; absolute paths must fall under it when set. ".." segments are rejected.')

const iconArg = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('emoji'), emoji: z.string().min(1).max(64) }).strict(),
    z.object({ type: z.literal('external'), external: z.object({ url: z.string().url().max(2048) }).strict() }).strict()
  ])
  .describe('Notion page icon, passed verbatim: { type: "emoji", emoji } or { type: "external", external: { url } }. Omit for no icon.')

const linkMapArg = z
  .record(z.string().max(1024), z.string().max(2048))
  .describe(
    "Wikilink resolution: maps a [[target]] string to that note's mirror URL. Resolved [[…]] become Notion @mentions; unresolved ones render as italic text. Omit/empty → all wikilinks italic."
  )

const publishInput = z
  .object({
    kb_path: kbPathArg,
    parent: parentArg,
    mode: z
      .enum(['create', 'replace', 'force'])
      .optional()
      .describe(
        'create (default): skip if already mirrored, else create. replace: update the existing page body+properties in place, preserving its URL. force: archive the existing page and create a new one (URL changes).'
      ),
    force: z.boolean().optional().describe('Deprecated: legacy alias for mode:"force". Prefer `mode`.'),
    icon: iconArg.optional(),
    link_map: linkMapArg.optional()
  })
  .strict()

const unpublishInput = z
  .object({
    kb_path: kbPathArg,
    dry_run: z
      .boolean()
      .default(true)
      .describe('When true (default) report what would be archived without calling Notion or editing the note. Set false to actually archive and clear the mirror frontmatter fields.')
  })
  .strict()

const moveInput = z.object({ kb_path: kbPathArg, parent: parentArg }).strict()
const getInput = z.object({ kb_path: kbPathArg }).strict()

export const registerMirrorTools = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    'notion_mirror_publish',
    {
      title: 'Publish a KB note to Notion under a caller-supplied parent',
      description: `Mirror one KB markdown note to Notion under the parent you supply, and record the resulting page URL in the note's frontmatter. The MCP owns markdown→blocks conversion, the banner, and the notion_mirror_* write-back. It does NOT discover files or resolve parents — the caller computes the parent.

Args:
  - kb_path (string, required): path to the KB markdown note.
  - parent (object, required): { type: "database_id", database_id } or { type: "page_id", page_id }. Passed to Notion verbatim. A database parent must be a wiki database; a page parent creates a child page.
  - mode ("create" | "replace" | "force", default "create"): how to handle an already-mirrored note.
    - create: skip (no Notion call), return { skipped: true, existing_url }.
    - replace: update the existing page's body + properties IN PLACE, preserving its URL (enables stable @mention resolution across passes). Body-destructive: deletes the old body blocks (and any block-level comments on them); child pages and page-level comments are preserved.
    - force: archive the existing page and create a new one — the URL CHANGES.
    A non-mirrored note is created in every mode.
  - force (boolean, deprecated): legacy alias for mode:"force". Prefer mode.
  - icon (object, optional): { type: "emoji", emoji } or { type: "external", external: { url } }. Page icon, passed to Notion verbatim. Omit for none.
  - link_map (object, optional): { "[[target]] text": "mirror url" }. Resolved wikilinks become Notion @mentions; unresolved ones render italic. Omit/empty → all italic.

Returns:
  - On publish/replace/force: { url, page_id, published_at, mode }. For replace, url equals the pre-existing notion_mirror_url.
  - On skip (already mirrored, mode "create"): { skipped: true, existing_url }.

Side effect: when parent.type is "page_id", the parent's "Child Pages" heading is refreshed (mirror-only; never written to the KB).

Errors:
  - "Note has no YAML frontmatter; refusing to publish."
  - "Nothing to publish: the note body is empty and the banner is disabled."
  - "Notion POST /v1/pages → HTTP 401/403" — token invalid or integration not connected to the parent.`,
      inputSchema: publishInput,
      annotations: WRITE_REMOTE
    },
    async ({ kb_path, parent, mode, force, icon, link_map }) => {
      try {
        return jsonResult(await publishNote(cfg, kb_path, parent as NotionParent, { mode, force, icon: icon as NotionIcon | undefined, linkMap: link_map }))
      } catch (err) {
        return errorResult('publishing note', err)
      }
    }
  )

  server.registerTool(
    'notion_mirror_move',
    {
      title: 'Re-parent an already-published mirror page',
      description: `Move an already-published mirror page under a caller-supplied parent. The page content and URL are unchanged — only its position in the Notion tree. No frontmatter change.

Caveat: Notion cannot move a page between a page_id parent and a database_id parent — PATCH /v1/pages silently ignores it. This tool detects that case and errors clearly; use unpublish + publish instead. (Tested 2026-05-30 against API version 2022-06-28.)

Args:
  - kb_path (string, required): the KB markdown note (must already have notion_mirror_url).
  - parent (object, required): the new Notion parent, same shape as publish.

Returns:
  JSON: { moved: true, page_id, previous_parent, new_parent } — parents in Notion's shape.

Errors:
  - "Note is not published — cannot move."
  - "Notion silently ignored the parent change …" — page-id ↔ database-id move attempted.`,
      inputSchema: moveInput,
      annotations: WRITE_REMOTE
    },
    async ({ kb_path, parent }) => {
      try {
        return jsonResult(await moveNote(cfg, kb_path, parent as NotionParent))
      } catch (err) {
        return errorResult('moving note', err)
      }
    }
  )

  server.registerTool(
    'notion_mirror_unpublish',
    {
      title: 'Archive a KB note Notion mirror page',
      description: `Archive the Notion page referenced by a note's notion_mirror_url and clear the two mirror frontmatter fields. Destructive — defaults to a dry run.

Caveat: archiving cascade-archives descendant pages on the Notion side. This tool only clears the one note's frontmatter; descendants' frontmatter still points at now-archived pages (caller's responsibility).

Args:
  - kb_path (string, required): path to the KB markdown note.
  - dry_run (boolean, default true): when true, report what would happen WITHOUT calling Notion or editing the note.

Returns:
  - dry_run true: { dry_run: true, would_archive_url, would_archive_page_id, would_clear_fields }.
  - dry_run false: { archived: true, page_id, url }.
  - note not mirrored: { archived: false, reason: "not-published" }.

Errors:
  - "Could not extract a 32-hex page id …" — the notion_mirror_url is malformed.`,
      inputSchema: unpublishInput,
      annotations: DESTRUCTIVE_REMOTE
    },
    async ({ kb_path, dry_run }) => {
      try {
        return jsonResult(await unpublishNote(cfg, kb_path, dry_run))
      } catch (err) {
        return errorResult('unpublishing note', err)
      }
    }
  )

  server.registerTool(
    'notion_mirror_get',
    {
      title: 'Fetch the live Notion state of a note mirror page',
      description: `Fetch the live Notion page referenced by a note's notion_mirror_url. Pure read — no Notion mutation, no file change.

Args:
  - kb_path (string, required): path to the KB markdown note.

Returns:
  - { id, parent, title, created_time, last_edited_time, archived, url }.
  - note not mirrored: { exists: false, reason: "not-published" }.

Errors:
  - "Could not extract a 32-hex page id …" — the notion_mirror_url is malformed.
  - "Notion GET /v1/pages/{id} → HTTP 404" — the page was deleted in Notion.`,
      inputSchema: getInput,
      annotations: READ_ONLY_REMOTE
    },
    async ({ kb_path }) => {
      try {
        return jsonResult(await getNote(cfg, kb_path))
      } catch (err) {
        return errorResult('getting note mirror', err)
      }
    }
  )
}
