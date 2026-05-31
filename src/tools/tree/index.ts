import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import type { NotionParent } from '../../main/notion-client/index.js'
import { deleteTree, preflightTree, statusTree, touchTree, updateTree } from '../../main/trees/index.js'
import type { MirrorSettings } from '../../main/trees/settings.js'
import { DESTRUCTIVE_REMOTE, READ_ONLY_REMOTE, WRITE_REMOTE_IDEMPOTENT } from '../../utils/annotations.js'
import { parentArg } from '../../utils/notion-args.js'
import { resolveKbNotePath } from '../../utils/paths.js'
import { errorResult, jsonResult } from '../../utils/results.js'

const noParentSegment = (s: string): boolean => !s.split(/[\\/]/).includes('..')

const subtreeArg = z
  .string()
  .min(1)
  .max(4096)
  .refine(noParentSegment, 'subtree must not contain ".." segments')
  .describe('KB-relative folder path to mirror, e.g. "Alpha/Beta". Any folder under MCP_KB_NOTION_MIRROR_KB_ROOT. ".." segments are rejected and the path is confined under the KB root.')

const kbPathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine(noParentSegment, 'kb_path must not contain ".." segments')
  .describe('Optional single note (kb-relative) to act on, walking up its ancestor indexes. Omit to act on the whole subtree.')

const linkMapArg = z
  .record(z.string().max(1024), z.string().max(2048))
  .describe(
    'Wikilink resolution map ([[target]] → mirror URL). Pass a map spanning MORE than this subtree (e.g. every root, built from roots_list + statuses) to resolve cross-root [[wikilinks]] into @mentions. Omit → built from this subtree only.'
  )

const statusInput = z.object({ subtree: subtreeArg }).strict()
const preflightInput = z.object({ subtree: subtreeArg }).strict()
const touchInput = z.object({ subtree: subtreeArg, parent: parentArg, kb_path: kbPathArg.optional() }).strict()
const updateInput = z.object({ subtree: subtreeArg, parent: parentArg, kb_path: kbPathArg.optional(), link_map: linkMapArg.optional() }).strict()
const deleteInput = z
  .object({
    subtree: subtreeArg,
    kb_path: kbPathArg.optional(),
    dry_run: z.boolean().default(true).describe('When true (default) report what would be archived without calling Notion or editing notes.')
  })
  .strict()

/**
 * Confine a kb-relative folder/note path under `cfg.kbRoot`, returning the
 * realpath. Reuses the per-note guard (lexical `..` reject + symlink realpath
 * check) — a folder need not exist for the walk, but the guard still rejects
 * anything escaping the root. Throws if kbRoot is unset.
 */
const requireKbRoot = (cfg: Config): string => {
  if (!cfg.kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set to use the tree tools.')
  return cfg.kbRoot
}

export const registerTreeTools = (server: McpServer, cfg: Config, settings: MirrorSettings): void => {
  server.registerTool(
    'kb_notion_mirror_tree_status',
    {
      title: 'Status of a KB subtree mirror',
      description: `Report which notes in a KB subtree are already mirrored to Notion, ordered the way a touch/update would visit them.

Args:
  - subtree (string, required): kb-relative folder to walk (e.g. "Alpha/Beta").

Returns: { total, published, pending, notes: [{ kbPath, published }] }. Pure read — no Notion call, no file change.`,
      inputSchema: statusInput,
      annotations: READ_ONLY_REMOTE
    },
    async ({ subtree }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        return jsonResult(statusTree(kbRoot, subtree, settings))
      } catch (err) {
        return errorResult('reading subtree status', err)
      }
    }
  )

  server.registerTool(
    'kb_notion_mirror_tree_preflight',
    {
      title: 'Preflight a KB subtree for mirroring',
      description: `Check a KB subtree for structural issues that would force notes to be skipped — currently, folders that contain notes but lack a folder-index note (<Folder>/<Folder>.md).

Args:
  - subtree (string, required): kb-relative folder to walk.

Returns: { issues: string[] } — empty when the subtree is mirror-ready. Pure read.`,
      inputSchema: preflightInput,
      annotations: READ_ONLY_REMOTE
    },
    async ({ subtree }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        return jsonResult(preflightTree(kbRoot, subtree, settings))
      } catch (err) {
        return errorResult('preflighting subtree', err)
      }
    }
  )

  server.registerTool(
    'kb_notion_mirror_tree_touch',
    {
      title: 'Touch a KB subtree — scaffold every page so URLs become known',
      description: `Create body-less scaffold pages for a whole KB subtree (or one note within it), attaching the subtree-root index under the parent you supply and nesting the rest by the folder-index convention. Idempotent — already-mirrored notes are skipped. Run this first, then tree_update to push bodies and resolve wikilinks.

Args:
  - subtree (string, required): kb-relative folder to walk (e.g. "Alpha/Beta").
  - parent (object, required): the Notion parent the subtree-root index attaches under.
  - kb_path (string, optional): touch just this note (walking up its unmirrored ancestor indexes first).

Returns: { eligible, outcomes: NoteOutcome[] } where NoteOutcome = { kbPath, action: "touch"|"skip"|"error", url?, error? }.`,
      inputSchema: touchInput,
      annotations: WRITE_REMOTE_IDEMPOTENT
    },
    async ({ subtree, parent, kb_path }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        if (kb_path !== undefined) resolveKbNotePath(kbRoot, kb_path)
        return jsonResult(await touchTree(cfg, subtree, parent as NotionParent, settings, kb_path))
      } catch (err) {
        return errorResult('touching subtree', err)
      }
    }
  )

  server.registerTool(
    'kb_notion_mirror_tree_update',
    {
      title: 'Update a KB subtree — push bodies and resolve wikilinks',
      description: `Push the body of every touched note in a subtree (or one note within it), resolving [[wikilinks]] into @mentions. Notes not yet touched are reported skipped, not created. By default the link map is built from this subtree alone; pass link_map to resolve across a wider set (e.g. cross-root).

Args:
  - subtree (string, required): kb-relative folder to walk.
  - parent (object, required): the parent the subtree-root index sits under (same as the touch).
  - kb_path (string, optional): update just this note's ancestor chain.
  - link_map (object, optional): wikilink → mirror URL map spanning more than this subtree (for cross-root @mentions).

Returns: { eligible, outcomes: NoteOutcome[] } where NoteOutcome = { kbPath, action: "update"|"skip"|"error", url?, error? }.`,
      inputSchema: updateInput,
      annotations: WRITE_REMOTE_IDEMPOTENT
    },
    async ({ subtree, parent, kb_path, link_map }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        if (kb_path !== undefined) resolveKbNotePath(kbRoot, kb_path)
        return jsonResult(await updateTree(cfg, subtree, parent as NotionParent, settings, { kbPath: kb_path, linkMap: link_map }))
      } catch (err) {
        return errorResult('updating subtree', err)
      }
    }
  )

  server.registerTool(
    'kb_notion_mirror_tree_delete',
    {
      title: 'Delete a KB subtree mirror',
      description: `Archive the mirror page of every note in a subtree (or one note's chain) and clear their mirror frontmatter, children before parents. Destructive — defaults to a dry run. Archiving breaks any @mention pointing at these pages.

Args:
  - subtree (string, required): kb-relative folder to walk.
  - kb_path (string, optional): delete just this note's ancestor chain.
  - dry_run (boolean, default true): when true, report what would be archived without calling Notion or editing notes.

Returns: { eligible, outcomes: NoteOutcome[] } where NoteOutcome = { kbPath, action: "delete"|"plan"|"skip"|"error", url?, error? }.`,
      inputSchema: deleteInput,
      annotations: DESTRUCTIVE_REMOTE
    },
    async ({ subtree, kb_path, dry_run }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        if (kb_path !== undefined) resolveKbNotePath(kbRoot, kb_path)
        return jsonResult(await deleteTree(cfg, subtree, settings, { kbPath: kb_path, dryRun: dry_run }))
      } catch (err) {
        return errorResult('deleting subtree', err)
      }
    }
  )
}
