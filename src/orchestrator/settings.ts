/**
 * Orchestrator settings — the small KB-specific knobs the orchestrator needs in
 * addition to the per-call Config that the mirror operations already take.
 *
 * These are layout-agnostic: there is NO fixed root folder and NO fixed wiki
 * parent. The subtree to walk and the Notion parent its root attaches under are
 * supplied per operation (tool args / CLI flags), not via env. Settings only
 * carry the exclusion + icon knobs that apply uniformly across every subtree.
 *
 * Loaded from env at CLI / tool-handler start; constructed directly in tests.
 */

export interface OrchestratorSettings {
  /** Filename prefixes whose notes are excluded from publishing. Default ["+"]. */
  skipPrefixes: string[]
  /** Specific kb-paths (relative to kbRoot) to skip. Default: []. */
  skipKbPaths: Set<string>
  /** Base URL pattern for Lucide-style external icons. `<name>.svg` is appended. */
  iconBaseUrl: string
}

const splitCsv = (raw: string | undefined, fallback: string[]): string[] => {
  if (raw === undefined || raw.trim() === '') return fallback
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build settings from env. No required var — the subtree + parent are passed
 * per call, so a missing env just falls back to the defaults below.
 *   MCP_KB_NOTION_MIRROR_SKIP_PREFIXES  default ["+"]
 *   MCP_KB_NOTION_MIRROR_SKIP_PATHS     default []
 *   MCP_KB_NOTION_MIRROR_ICON_BASE_URL  default the lucide-static CDN URL
 */
export const loadOrchestratorSettings = (env: NodeJS.ProcessEnv = process.env): OrchestratorSettings => {
  const skipPrefixes = splitCsv(env.MCP_KB_NOTION_MIRROR_SKIP_PREFIXES, ['+'])
  const skipKbPaths = new Set(splitCsv(env.MCP_KB_NOTION_MIRROR_SKIP_PATHS, []))
  const iconBaseUrl = (env.MCP_KB_NOTION_MIRROR_ICON_BASE_URL ?? 'https://unpkg.com/lucide-static@latest/icons').replace(/\/+$/, '')
  return { skipPrefixes, skipKbPaths, iconBaseUrl }
}
