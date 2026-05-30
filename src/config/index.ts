/**
 * Configuration loading. `loadConfig()` reads the environment (optionally
 * hydrated from a `.env.${NODE_ENV}` file) into a plain `Config` value that is
 * passed explicitly into every main call — so the same code runs as an MCP
 * server or from a standalone script. There is NO module-level config
 * singleton: nothing here is read at import time.
 */
import * as os from 'node:os'
import * as path from 'node:path'

const expandHome = (p: string): string => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

export type AccessLevel = 'read' | 'write' | 'destructive'
export const ACCESS_LEVELS: readonly AccessLevel[] = ['read', 'write', 'destructive'] as const
export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = { read: 1, write: 2, destructive: 3 }

export type AuditLogMode = 'off' | 'writes' | 'all'

/**
 * The mirrored-from-KB banner. `{date}` interpolates today's UTC date; markdown
 * `**bold**` is honoured. Override with `MCP_NOTION_MIRROR_BANNER_TEMPLATE`; an
 * empty string disables the banner. The default omits a leading emoji because
 * the callout renders the 📘 icon (see src/main/mirror/banner.ts).
 */
export const DEFAULT_BANNER_TEMPLATE = "**Mirrored from Knowledge Base on {date}** — canonical version lives in HNR's KB; feedback via comments here will be triaged back into the KB."

export interface Config {
  /** Notion internal-integration secret (`ntn_…`). Never logged or returned. */
  notionToken: string
  notionApiBaseUrl: string
  notionApiVersion: string
  /** Absolute KB root. When set, `kb_path`s resolve under it and are confined to it; when unset, only absolute paths are accepted. */
  kbRoot: string | undefined
  bannerTemplate: string
  accessLevel: AccessLevel
  auditLogMode: AuditLogMode
  auditLogPath: string
  auditLogMaxBytes: number
  auditLogKeep: number
}

const requireEnv = (env: NodeJS.ProcessEnv, name: string, hint: string): string => {
  const v = env[name]
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required but not set. ${hint}`)
  return v.trim()
}

const parseAccessLevel = (raw: string | undefined): AccessLevel => {
  const v = raw?.trim()
  if (v === undefined || v === '') return 'write'
  if ((ACCESS_LEVELS as readonly string[]).includes(v)) return v as AccessLevel
  throw new Error(`Invalid MCP_NOTION_MIRROR_ACCESS_LEVEL="${raw}". Allowed: ${ACCESS_LEVELS.join(', ')}`)
}

const parseAuditLogMode = (raw: string | undefined): AuditLogMode => {
  const v = raw?.trim().toLowerCase()
  if (v === undefined || v === '') return 'writes'
  if (v === 'off' || v === 'writes' || v === 'all') return v
  throw new Error(`Invalid MCP_NOTION_MIRROR_AUDIT_LOG="${raw}" — expected one of: off, writes, all.`)
}

const parseNonNegativeInt = (raw: string | undefined, fallback: number, varName: string): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${varName}="${raw}" — expected a non-negative integer.`)
  return n
}

const resolveKbRoot = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return path.resolve(expandHome(trimmed))
}

/**
 * Load configuration from `env` (defaults to `process.env`, after attempting to
 * hydrate it from `.env.${NODE_ENV}`). Throws if a required var is missing.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  try {
    process.loadEnvFile(`./.env.${process.env.NODE_ENV}`)
  } catch {
    // no .env present (or Bun, which auto-loads it) — that's fine
  }

  return {
    notionToken: requireEnv(
      env,
      'MCP_NOTION_MIRROR_TOKEN',
      'Create a Notion internal integration, grant it Read + Insert + Update content, connect it to the target page/database, and copy its secret (ntn_…) here.'
    ),
    notionApiBaseUrl: (env.MCP_NOTION_MIRROR_API_BASE_URL ?? 'https://api.notion.com').replace(/\/+$/, ''),
    // Notion versions the API via a header, not the URL. Bump when Notion ships a new stable date.
    notionApiVersion: '2022-06-28',
    kbRoot: resolveKbRoot(env.MCP_NOTION_MIRROR_KB_ROOT),
    bannerTemplate: env.MCP_NOTION_MIRROR_BANNER_TEMPLATE ?? DEFAULT_BANNER_TEMPLATE,
    accessLevel: parseAccessLevel(env.MCP_NOTION_MIRROR_ACCESS_LEVEL),
    auditLogMode: parseAuditLogMode(env.MCP_NOTION_MIRROR_AUDIT_LOG),
    auditLogPath: path.resolve(expandHome(env.MCP_NOTION_MIRROR_AUDIT_LOG_PATH ?? path.join(os.homedir(), '.local', 'state', 'mcp-notion-mirror', 'audit.jsonl'))),
    auditLogMaxBytes: parseNonNegativeInt(env.MCP_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES, 10 * 1024 * 1024, 'MCP_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES'),
    auditLogKeep: parseNonNegativeInt(env.MCP_NOTION_MIRROR_AUDIT_LOG_KEEP, 5, 'MCP_NOTION_MIRROR_AUDIT_LOG_KEEP')
  }
}
