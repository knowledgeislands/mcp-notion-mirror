import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import type { NotionParent } from '../../main/notion-client/index.js'
import { preflight, publishAll, publishOne, status } from '../../orchestrator/api.js'
import { loadOrchestratorSettings } from '../../orchestrator/settings.js'
import { DESTRUCTIVE_REMOTE, READ_ONLY_REMOTE } from '../../utils/annotations.js'
import { parentArg } from '../../utils/notion-args.js'
import { resolveKbNotePath } from '../../utils/paths.js'
import { errorResult, jsonResult } from '../../utils/results.js'

const noParentSegment = (s: string): boolean => !s.split(/[\\/]/).includes('..')

const subtreeArg = z
  .string()
  .min(1)
  .max(4096)
  .refine(noParentSegment, 'subtree must not contain ".." segments')
  .describe('KB-relative folder path to mirror, e.g. "Pillars/Engineering". Any folder under MCP_KB_NOTION_MIRROR_KB_ROOT. ".." segments are rejected and the path is confined under the KB root.')

const kbPathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine(noParentSegment, 'kb_path must not contain ".." segments')
  .describe('Optional single note (kb-relative) to publish, walking up its ancestor indexes. Omit to publish the whole subtree.')

const statusInput = z.object({ subtree: subtreeArg }).strict()
const preflightInput = z.object({ subtree: subtreeArg }).strict()
const publishInput = z
  .object({
    subtree: subtreeArg,
    parent: parentArg,
    kb_path: kbPathArg.optional(),
    dry_run: z.boolean().default(true).describe('When true (default) compute what would be published without calling Notion or editing notes.'),
    pass: z.enum(['both', 'pass1', 'pass2']).default('both').describe('both (default): create then resolve wikilinks. pass1: create only. pass2: replace/resolve only.')
  })
  .strict()

/**
 * Confine a kb-relative folder/note path under `cfg.kbRoot`, returning the
 * realpath. Reuses the per-note guard (lexical `..` reject + symlink realpath
 * check) — a folder need not exist for the orchestrator to walk it, but the
 * guard still rejects anything escaping the root. Throws if kbRoot is unset
 * (the orchestrator needs a root to resolve a relative subtree against).
 */
const requireKbRoot = (cfg: Config): string => {
  if (!cfg.kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set to use the subtree orchestrator tools.')
  return cfg.kbRoot
}

export const registerTreeTools = (server: McpServer, cfg: Config): void => {
  server.registerTool(
    'notion_mirror_tree_status',
    {
      title: 'Status of a KB subtree mirror',
      description: `Report which notes in a KB subtree are already mirrored to Notion, ordered the way a publish would visit them.

Args:
  - subtree (string, required): kb-relative folder to walk (e.g. "Pillars/Engineering").

Returns: { total, published, pending, notes: [{ kbPath, published }] }. Pure read — no Notion call, no file change.`,
      inputSchema: statusInput,
      annotations: READ_ONLY_REMOTE
    },
    async ({ subtree }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        return jsonResult(status(kbRoot, subtree, loadOrchestratorSettings(process.env)))
      } catch (err) {
        return errorResult('reading subtree status', err)
      }
    }
  )

  server.registerTool(
    'notion_mirror_tree_preflight',
    {
      title: 'Preflight a KB subtree for publishing',
      description: `Check a KB subtree for structural issues that would force notes to be skipped during publish — currently, folders that contain notes but lack a folder-index note (<Folder>/<Folder>.md).

Args:
  - subtree (string, required): kb-relative folder to walk.

Returns: { issues: string[] } — empty when the subtree is publish-ready. Pure read.`,
      inputSchema: preflightInput,
      annotations: READ_ONLY_REMOTE
    },
    async ({ subtree }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        return jsonResult(preflight(kbRoot, subtree, loadOrchestratorSettings(process.env)))
      } catch (err) {
        return errorResult('preflighting subtree', err)
      }
    }
  )

  server.registerTool(
    'notion_mirror_tree_publish',
    {
      title: 'Publish a KB subtree to Notion under a caller-supplied parent',
      description: `Mirror a whole KB subtree (or one note within it) to Notion, attaching the subtree-root index under the parent you supply and nesting the rest by the folder-index convention. Two passes: pass1 creates pages, pass2 replaces bodies to resolve [[wikilinks]] into @mentions. Destructive — defaults to a dry run.

Args:
  - subtree (string, required): kb-relative folder to walk (e.g. "Pillars/Engineering").
  - parent (object, required): the Notion parent the subtree-root index attaches under — { type: "database_id", database_id } or { type: "page_id", page_id }.
  - kb_path (string, optional): publish just this note (walking up its unpublished ancestor indexes first) instead of the whole subtree.
  - dry_run (boolean, default true): when true, compute outcomes without calling Notion or editing notes.
  - pass ("both" | "pass1" | "pass2", default "both"): which pass(es) to run for a whole-subtree publish (ignored for a single kb_path, which always runs both over its chain).

Returns:
  - whole subtree: { eligible, pass1: NoteOutcome[], pass2: NoteOutcome[] }.
  - single note: { chain: string[], pass1: NoteOutcome[], pass2: NoteOutcome[] }.
  NoteOutcome = { kbPath, action: "create"|"replace"|"skip"|"plan"|"error", url?, error? }.`,
      inputSchema: publishInput,
      annotations: DESTRUCTIVE_REMOTE
    },
    async ({ subtree, parent, kb_path, dry_run, pass }) => {
      try {
        const kbRoot = requireKbRoot(cfg)
        resolveKbNotePath(kbRoot, subtree)
        const settings = loadOrchestratorSettings(process.env)
        if (kb_path !== undefined) {
          resolveKbNotePath(kbRoot, kb_path)
          return jsonResult(await publishOne(cfg, subtree, parent as NotionParent, settings, kb_path, dry_run))
        }
        return jsonResult(await publishAll(cfg, subtree, parent as NotionParent, settings, { dryRun: dry_run, onlyPass1: pass === 'pass1', onlyPass2: pass === 'pass2' }))
      } catch (err) {
        return errorResult('publishing subtree', err)
      }
    }
  )
}
