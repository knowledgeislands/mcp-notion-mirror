#!/usr/bin/env node

/**
 * mcp-kb-notion-mirror
 *
 * Local stdio MCP server that mirrors local Knowledge Base markdown notes to a
 * Notion wiki and records the resulting Notion page URL back into each note's
 * YAML frontmatter. The KB is canonical; the mirror is a derivative read
 * surface for non-KB consumers.
 *
 * Three resources of tools:
 *   - note tools (kb_notion_mirror_note_*) act on one `kb_path` per call and (for
 *     mutations) a Notion `parent` the caller supplies — file-aware but
 *     layout-agnostic: no directory walking, no parent resolution;
 *   - tree tools (kb_notion_mirror_tree_*) walk a caller-given `subtree` folder
 *     under the KB root and apply the folder-index hierarchy convention,
 *     attaching the subtree-root under a caller-given `parent`;
 *   - the roots tool (kb_notion_mirror_roots_list) discovers the folders declared
 *     as mirror roots (kb_notion_mirror_root frontmatter) so a client can drive
 *     the tree tools per root without rescanning the KB.
 *
 * Configuration (environment variables):
 *   MCP_KB_NOTION_MIRROR_TOKEN            Required. Notion internal-integration
 *                                      secret (ntn_…). Needs Read + Insert +
 *                                      Update content and a Connection to every
 *                                      page/database it publishes into.
 *   MCP_KB_NOTION_MIRROR_KB_ROOT          Optional. Absolute KB root. When set,
 *                                      kb_path args resolve under it and are
 *                                      confined to it; when unset, kb_path must
 *                                      be absolute (caller bounds traversal).
 *   MCP_KB_NOTION_MIRROR_ACCESS_LEVEL     Optional. read | write | destructive.
 *                                      Default: write.
 *   MCP_KB_NOTION_MIRROR_BANNER_TEMPLATE  Optional. Banner copy; {date} → today's
 *                                      UTC date. Empty string disables the banner.
 *   MCP_KB_NOTION_MIRROR_AUDIT_LOG        Optional. off | writes | all. Default: writes.
 *   MCP_KB_NOTION_MIRROR_AUDIT_LOG_PATH   Optional. Default
 *                                      ~/.local/state/mcp-kb-notion-mirror/audit.jsonl.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../config/index.js'
import { loadMirrorSettings } from '../main/trees/settings.js'
import { registerNoteTools } from '../tools/note/index.js'
import { registerRootsTools } from '../tools/roots/index.js'
import { registerTreeTools } from '../tools/tree/index.js'
import { makeAccessGatedRegister } from '../utils/access-level.js'

const config = loadConfig()
const settings = loadMirrorSettings()

console.error(`mcp-kb-notion-mirror starting...`)
console.error(`  MCP_KB_NOTION_MIRROR_API_BASE_URL=${config.notionApiBaseUrl}`)
console.error(`  MCP_KB_NOTION_MIRROR_KB_ROOT=${config.kbRoot ?? '(unset — kb_path must be absolute)'}`)
console.error(`  MCP_KB_NOTION_MIRROR_ACCESS_LEVEL=${config.accessLevel}`)
console.error(`  MCP_KB_NOTION_MIRROR_AUDIT_LOG=${config.auditLogMode}${config.auditLogMode === 'off' ? '' : ` (path: ${config.auditLogPath})`}`)

const server = new McpServer({
  name: 'mcp-kb-notion-mirror',
  version: '1.0.0'
})
server.registerTool = makeAccessGatedRegister(server, config.accessLevel, {
  mode: config.auditLogMode,
  path: config.auditLogPath,
  maxBytes: config.auditLogMaxBytes,
  keep: config.auditLogKeep
})

registerNoteTools(server, config)
registerTreeTools(server, config, settings)
registerRootsTools(server, config, settings)

const main = async (): Promise<void> => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`mcp-kb-notion-mirror ready`)
}

main().catch((err) => {
  console.error('mcp-kb-notion-mirror fatal:', err)
  process.exit(1)
})
