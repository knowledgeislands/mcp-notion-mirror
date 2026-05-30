/**
 * Append-only JSONL audit log for tool invocations. Mirrors the sibling MCPs:
 * scope is controlled by MCP_NOTION_MIRROR_AUDIT_LOG (`off` / `writes` /
 * `all`), level is derived from each tool's MCP annotations, path defaults to
 * ~/.local/state/mcp-notion-mirror/audit.jsonl.
 *
 * Only the tool args are recorded — never the Notion token (it lives in env,
 * not in any tool argument). Failures to write the audit line are swallowed
 * (stderr only) — a broken log must never prevent a tool call from completing.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AccessLevel, AuditLogMode } from '../config/index.js'

/** The audit-log slice of Config the caller passes in (keeps this util MCP-agnostic). */
export interface AuditConfig {
  mode: AuditLogMode
  path: string
  maxBytes: number
  keep: number
}

export interface AuditEvent {
  ts: string
  server: string
  tool: string
  level: AccessLevel
  ok: boolean
  duration_ms: number
  error?: string
  args: unknown
}

const SERVER_NAME = 'mcp-notion-mirror'
const MAX_ARG_CHARS = 4096

const sanitizeArgs = (args: unknown): unknown => {
  const serialized = JSON.stringify(args)
  if (serialized.length > MAX_ARG_CHARS) {
    return { _truncated: true, preview: serialized.slice(0, MAX_ARG_CHARS) }
  }
  return args
}

let chmodEnsured = false

const rotateIfNeeded = async (audit: AuditConfig): Promise<void> => {
  if (audit.maxBytes === 0) return
  let size: number
  try {
    size = (await fs.stat(audit.path)).size
  } catch {
    /* v8 ignore next 2 — file disappeared between appendFile and stat; nothing to rotate */
    return
  }
  if (size <= audit.maxBytes) return
  try {
    if (audit.keep > 0) {
      await fs.rm(`${audit.path}.${audit.keep}`, { force: true })
      for (let i = audit.keep - 1; i >= 1; i--) {
        try {
          await fs.rename(`${audit.path}.${i}`, `${audit.path}.${i + 1}`)
        } catch {
          // missing slot — fine, rotation history may not be full yet
        }
      }
      await fs.rename(audit.path, `${audit.path}.1`)
    } else {
      await fs.rm(audit.path, { force: true })
    }
  } catch (err) {
    /* v8 ignore next 2 — outer rename failure is unreachable from a single-process test (every per-slot rename has its own try/catch) */
    console.error(`[audit-log] rotation failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const writeAuditEvent = async (audit: AuditConfig, event: AuditEvent): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(audit.path), { recursive: true })
    await fs.appendFile(audit.path, `${JSON.stringify(event)}\n`, { encoding: 'utf-8', mode: 0o600 })
    if (!chmodEnsured) {
      try {
        await fs.chmod(audit.path, 0o600)
      } catch {
        // best-effort — log may have been rotated/removed between write and chmod
      }
      chmodEnsured = true
    }
    await rotateIfNeeded(audit)
  } catch (err) {
    /* v8 ignore next — fs.* always rejects with an Error, so the String(err) fallback is unreachable in practice */
    console.error(`[audit-log] failed to write: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Serialize appends through a single chain so concurrent callers can't race on
// the append → stat → rotate sequence (two simultaneous rotations would have
// one `rename(live → .1)` lose with ENOENT). Each call awaits the prior one;
// errors are swallowed inside writeAuditEvent so the chain never rejects.
let auditQueue: Promise<void> = Promise.resolve()

export const appendAuditEvent = (audit: AuditConfig, event: AuditEvent): Promise<void> => {
  auditQueue = auditQueue.then(() => writeAuditEvent(audit, event))
  return auditQueue
}

type ToolCallback = (...callbackArgs: unknown[]) => unknown | Promise<unknown>

const extractErrorText = (result: unknown): string | undefined => {
  const content = (result as { content?: { type: string; text: string }[] }).content
  if (!Array.isArray(content)) return undefined
  const first = content.find((c) => c.type === 'text')
  return first?.text
}

export const withAuditLog = (audit: AuditConfig, toolName: string, level: AccessLevel, callback: ToolCallback): ToolCallback => {
  if (audit.mode === 'off') return callback
  if (level === 'read' && audit.mode !== 'all') return callback
  return async (...callbackArgs: unknown[]) => {
    const start = Date.now()
    const args = callbackArgs[0]
    try {
      const result = await callback(...callbackArgs)
      const isError = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
      const errText = isError ? extractErrorText(result) : undefined
      void appendAuditEvent(audit, {
        ts: new Date().toISOString(),
        server: SERVER_NAME,
        tool: toolName,
        level,
        ok: !isError,
        duration_ms: Date.now() - start,
        error: errText,
        args: sanitizeArgs(args)
      })
      return result
    } catch (err) {
      void appendAuditEvent(audit, {
        ts: new Date().toISOString(),
        server: SERVER_NAME,
        tool: toolName,
        level,
        ok: false,
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        args: sanitizeArgs(args)
      })
      throw err
    }
  }
}
