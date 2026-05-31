import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import { listRoots } from '../../main/roots/index.js'
import type { MirrorSettings } from '../../main/trees/settings.js'
import { READ_ONLY_REMOTE } from '../../utils/annotations.js'
import { errorResult, jsonResult } from '../../utils/results.js'

const listInput = z.object({}).strict()

export const registerRootsTools = (server: McpServer, cfg: Config, settings: MirrorSettings): void => {
  server.registerTool(
    'kb_notion_mirror_roots_list',
    {
      title: 'List declared KB mirror roots',
      description: `Discover every folder that declares itself a mirror root via kb_notion_mirror_root frontmatter, and the Notion parent each attaches under. Pure read — no Notion call, no file change.

This is discovery only: take the returned [{ subtree, parent }] and drive the tree tools (tree_touch / tree_update / tree_delete) per root with the parent given here — so you never rescan the KB and every mutation still takes an explicit parent.

Args: none.

Returns: [{ subtree, indexKbPath, parent }] sorted by subtree. A database parent is { type: "database_id", database_id }; a page parent is { type: "page_id", page_id }.`,
      inputSchema: listInput,
      annotations: READ_ONLY_REMOTE
    },
    async () => {
      try {
        if (!cfg.kbRoot) throw new Error('MCP_KB_NOTION_MIRROR_KB_ROOT must be set to list roots.')
        return jsonResult(listRoots(cfg.kbRoot, settings))
      } catch (err) {
        return errorResult('listing roots', err)
      }
    }
  )
}
