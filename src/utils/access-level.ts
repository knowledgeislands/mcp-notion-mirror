import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { ACCESS_LEVEL_RANK, type AccessLevel } from '../config/index.js'
import { type AuditConfig, withAuditLog } from './audit-log.js'

/**
 * Derive a tool's access level from its MCP annotations.
 *
 *   readOnlyHint: true                               → 'read'
 *   destructiveHint: true                            → 'destructive'
 *   readOnlyHint: false AND destructiveHint: false   → 'write'   (explicit
 *                                                                non-destructive
 *                                                                mutation)
 *   anything else (unannotated / partially annotated) → 'destructive'
 *
 * The fail-safe default to `destructive` for missing annotations matches the
 * rest of the family.
 */
export const levelFromAnnotations = (annotations: ToolAnnotations | undefined): AccessLevel => {
  if (annotations?.readOnlyHint === true) return 'read'
  if (annotations?.destructiveHint === true) return 'destructive'
  if (annotations?.readOnlyHint === false && annotations?.destructiveHint === false) return 'write'
  return 'destructive'
}

type RegisterTool = McpServer['registerTool']

interface RegisterToolConfig {
  annotations?: ToolAnnotations
}
type ToolCallback = (...callbackArgs: unknown[]) => unknown | Promise<unknown>
type RegisterToolArgs = [name: string, config: RegisterToolConfig, callback: ToolCallback]

/**
 * Wraps `server.registerTool` so only tools whose derived access level is at or
 * below `accessLevel` are actually registered. Disabled tools are silently
 * skipped. Each registered tool's callback is wrapped with the audit logger
 * (configured by `audit`). Both come from the caller's loaded Config.
 */
export const makeAccessGatedRegister = (server: McpServer, accessLevel: AccessLevel, audit: AuditConfig): RegisterTool => {
  const proxied = new Proxy(server.registerTool.bind(server) as RegisterTool, {
    apply(target, thisArg, args: RegisterToolArgs) {
      const [name, config, callback] = args
      const level = levelFromAnnotations(config.annotations)
      if (ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[accessLevel]) return undefined as never
      const wrappedArgs: RegisterToolArgs = [name, config, withAuditLog(audit, name, level, callback)]
      return Reflect.apply(target, thisArg, wrappedArgs)
    }
  })
  return proxied
}
