#!/usr/bin/env node
/**
 * CLI entry: `mcp-kb-notion-mirror-publish [args]`.
 *
 * Loads `.env.local` and `.env` from cwd before reading process.env so the
 * standard Node runtime gets the same auto-load behaviour Bun gives for free.
 * Then dispatches to the high-level operations in `./api.ts`. ALL human-readable
 * printing happens here, from the structured values the api functions return —
 * api.ts itself never writes to stdout/stderr.
 *
 * Layout-agnostic: every mutating command takes `--subtree <kbPath>` (the folder
 * to walk) and one of `--parent-db <id>` / `--parent-page <id>` (the Notion
 * parent the subtree-root index attaches under). Neither is read from env.
 */
import { loadConfig } from '../config/index.js'
import type { NotionParent } from '../main/notion-client/index.js'
import { preflight, publishAll, publishOne, status, unpublishOne } from './api.js'
import { loadOrchestratorSettings } from './settings.js'

const tryLoadEnvFile = (path: string): void => {
  try {
    process.loadEnvFile(path)
  } catch {
    // not present — fine
  }
}
tryLoadEnvFile('.env.local')
tryLoadEnvFile('.env')

const USAGE = `Usage:
  mcp-kb-notion-mirror-publish status    --subtree <kbPath>
  mcp-kb-notion-mirror-publish preflight --subtree <kbPath>
  mcp-kb-notion-mirror-publish publish   --subtree <kbPath> (--parent-db <id> | --parent-page <id>) [<kbPath>] [--pass1|--pass2] [--dry-run]
  mcp-kb-notion-mirror-publish unpublish <kbPath> [--dry-run]

Flags:
  --subtree <kbPath>     kb-relative folder to walk (required for status/preflight/publish)
  --parent-db <id>       publish under this Notion wiki database (subtree-root parent)
  --parent-page <id>     publish under this Notion page (subtree-root parent)
  --dry-run              compute outcomes without calling Notion or editing notes
  --pass1 | --pass2      run only the create pass / only the replace pass

Env:
  MCP_KB_NOTION_MIRROR_TOKEN          required for publish/unpublish — Notion integration secret
  MCP_KB_NOTION_MIRROR_KB_ROOT        required — absolute path to KB root
  MCP_KB_NOTION_MIRROR_SKIP_PREFIXES  default "+"
  MCP_KB_NOTION_MIRROR_SKIP_PATHS     default "" (none)
  MCP_KB_NOTION_MIRROR_ICON_BASE_URL  default https://unpkg.com/lucide-static@latest/icons
`

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const parentFromFlags = (argv: string[]): NotionParent => {
  const db = flagValue(argv, '--parent-db')
  const page = flagValue(argv, '--parent-page')
  if (db) return { type: 'database_id', database_id: db }
  if (page) return { type: 'page_id', page_id: page }
  console.error('publish requires --parent-db <id> or --parent-page <id>')
  process.exit(2)
}

const ACTION_GLYPH: Record<string, string> = { create: '+', replace: '~', skip: '↻', plan: '·', error: '✗' }

const printOutcomes = (label: string, outcomes: { kbPath: string; action: string; url?: string; error?: string }[]): void => {
  if (outcomes.length === 0) return
  console.log(`\n=== ${label} ===`)
  for (const o of outcomes) {
    const detail = o.error ? `  (${o.error})` : o.url ? `  → ${o.url}` : ''
    console.log(`  ${ACTION_GLYPH[o.action] ?? '?'} ${o.action.padEnd(7)} ${o.kbPath}${detail}`)
  }
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const onlyPass1 = argv.includes('--pass1')
  const onlyPass2 = argv.includes('--pass2')
  const subtree = flagValue(argv, '--subtree')
  const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--parent') && argv[i - 1] !== '--subtree')
  const cmd = positional[0] ?? 'status'

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE)
    return
  }

  // status/preflight only touch local files — no token needed, just the kb root.
  if (cmd === 'status' || cmd === 'preflight') {
    const kbRoot = process.env.MCP_KB_NOTION_MIRROR_KB_ROOT
    if (!kbRoot) {
      console.error('MCP_KB_NOTION_MIRROR_KB_ROOT is required.')
      process.exit(1)
    }
    if (!subtree) {
      console.error(`${cmd} requires --subtree <kbPath>`)
      process.exit(2)
    }
    const settings = loadOrchestratorSettings(process.env)
    if (cmd === 'status') {
      const s = status(kbRoot, subtree, settings)
      for (const n of s.notes) console.log(`${n.published ? '✓' : '·'} ${n.kbPath}`)
      console.log(`\nTotal: ${s.total}   Published: ${s.published}   Pending: ${s.pending}`)
    } else {
      const { issues } = preflight(kbRoot, subtree, settings)
      if (issues.length === 0) {
        console.log('Preflight: no structural issues.')
      } else {
        console.log(`Preflight: ${issues.length} issue(s):`)
        for (const i of issues) console.log(`  - ${i}`)
      }
      process.exit(issues.length === 0 ? 0 : 1)
    }
    return
  }

  // Everything below mutates Notion → token required.
  const cfg = loadConfig(process.env)
  const settings = loadOrchestratorSettings(process.env)
  console.log(`KB_ROOT: ${cfg.kbRoot ?? '(unset)'}`)

  if (cmd === 'publish') {
    if (!subtree) {
      console.error('publish requires --subtree <kbPath>')
      process.exit(2)
    }
    const parent = parentFromFlags(argv)
    if (positional.length > 1) {
      const res = await publishOne(cfg, subtree, parent, settings, positional[1] as string, dryRun)
      console.log(`Chain: ${res.chain.join(' → ')}`)
      printOutcomes('Pass 1 (create)', res.pass1)
      printOutcomes('Pass 2 (replace)', res.pass2)
    } else {
      const res = await publishAll(cfg, subtree, parent, settings, { dryRun, onlyPass1, onlyPass2 })
      console.log(`Eligible: ${res.eligible} note(s)`)
      printOutcomes('Pass 1 (create)', res.pass1)
      printOutcomes('Pass 2 (replace)', res.pass2)
    }
    return
  }
  if (cmd === 'unpublish') {
    if (positional.length < 2) {
      console.error('unpublish requires <kbPath>')
      process.exit(2)
    }
    const res = await unpublishOne(cfg, positional[1] as string, dryRun)
    console.log(JSON.stringify(res, null, 2))
    return
  }
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`)
  process.exit(2)
}

main().catch((err) => {
  console.error('\nFAILED:', (err as Error).message)
  process.exit(1)
})
