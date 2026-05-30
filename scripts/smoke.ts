#!/usr/bin/env node
// End-to-end smoke test: boot the built server over stdio MCP, list its tools,
// and assert the surface matches what the registration tests expect. Catches
// drift between code and the *wire* contract (the in-process access-level tests
// cover registration; this covers the actual protocol round-trip).
//
// Run via `bun run test:smoke` (builds dist/ first). Runs in CI without secrets:
// the server only needs MCP_KB_NOTION_MIRROR_TOKEN to boot, so we pass a throwaway
// placeholder — no real Notion call is ever made.

import * as os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Single source of truth for the tool surface — kept in sync with
// src/tools/mirror/index.ts, src/tools/tree/index.ts, and the access-level
// tests. Add a tool → update both.
const EXPECTED_TOOLS = [
  'notion_mirror_publish',
  'notion_mirror_unpublish',
  'notion_mirror_move',
  'notion_mirror_get',
  'notion_mirror_tree_status',
  'notion_mirror_tree_preflight',
  'notion_mirror_tree_publish'
] as const

const die = (msg: string, detail?: unknown): never => {
  console.error(`✗ smoke failed: ${msg}`)
  if (detail !== undefined) console.error(detail)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp-server/index.js'],
    // Placeholder config so boot validation passes headless, and access level
    // raised to `destructive` so the smoke sees the full surface (the default
    // `write` gate would otherwise hide unpublish).
    env: {
      ...(process.env as Record<string, string>),
      MCP_KB_NOTION_MIRROR_TOKEN: 'ntn_smoke_placeholder',
      MCP_KB_NOTION_MIRROR_KB_ROOT: os.tmpdir(),
      MCP_KB_NOTION_MIRROR_ACCESS_LEVEL: 'destructive',
      MCP_KB_NOTION_MIRROR_AUDIT_LOG: 'off'
    }
  })
  const client = new Client({ name: 'mcp-kb-notion-mirror-smoke', version: '0.0.0' }, { capabilities: {} })

  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    const expected = [...EXPECTED_TOOLS].sort()

    const missing = expected.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !expected.includes(n as (typeof EXPECTED_TOOLS)[number]))
    if (missing.length || extra.length) {
      die('tool surface mismatch', { missing, extra, actualCount: names.length, expectedCount: expected.length })
    }

    // Sanity: every tool advertises an inputSchema object.
    const missingSchema = tools.filter((t) => !t.inputSchema || typeof t.inputSchema !== 'object').map((t) => t.name)
    if (missingSchema.length) die('tools missing inputSchema', missingSchema)

    console.error(`✓ smoke passed: ${names.length} tools listed, all schemas present`)
  } finally {
    await client.close()
  }
}

main().catch((err) => die('uncaught', err))
