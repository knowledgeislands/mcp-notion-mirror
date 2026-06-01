#!/usr/bin/env node
/**
 * CLI entry: `mcp-kb-notion-mirror-publish <resource> <verb> [args] [flags]`.
 *
 * Loads `.env.local` and `.env` from cwd before reading process.env so the
 * standard Node runtime gets the same auto-load behaviour Bun gives for free.
 * Then dispatches to the note/tree/roots library functions. ALL human-readable
 * printing happens here, from the structured values those functions return — the
 * library layer never writes to stdout/stderr.
 *
 * The surface mirrors the MCP tools:
 *   note  get|status|preflight|touch|update|move|delete  <kbPath>  [--parent-…]
 *   tree  status|preflight|touch|update|delete           <subtree> [--parent-…] [--note <kbPath>]
 *   roots list|touch|update|publish|delete                          [--dry-run]
 *
 * `roots` is the only place the cross-root multi-step lives: `roots publish`
 * touches every declared root, then updates them all with ONE link map spanning
 * every root so cross-root `[[wikilinks]]` resolve to @mentions.
 */
import { loadConfig } from '../config/index.js'
import type { NotionParent } from '../main/notion-client/index.js'
import {
  buildLinkMap,
  deleteNote,
  deleteTree,
  discover,
  getNote,
  listRoots,
  loadMirrorSettings,
  moveNote,
  preflightNote,
  preflightTree,
  pruneRoots,
  pruneTree,
  publishOrder,
  statusNote,
  statusTree,
  touchNote,
  touchTree,
  updateNote,
  updateTree
} from './index.js'

const tryLoadEnvFile = (path: string): void => {
  try {
    process.loadEnvFile(path)
  } catch {
    // not present — fine
  }
}
tryLoadEnvFile('.env.local')
tryLoadEnvFile('.env')

const USAGE = `Usage: mcp-kb-notion-mirror-publish <resource> <verb> [args] [flags]

note  <verb> <kbPath>   verbs: get | status | preflight | touch | update | move | delete
tree  <verb> <subtree>  verbs: status | preflight | touch | update | delete | prune
roots <verb>            verbs: list | touch | update | publish | delete | prune

Flags:
  --parent-db <id>    Notion wiki database parent (note/tree touch|update, note move)
  --parent-page <id>  Notion page parent (same verbs)
  --note <kbPath>     restrict a tree op to one note's ancestor chain
  --dry-run           delete/prune only: report what would be archived without touching Notion

Env:
  MCP_KB_NOTION_MIRROR_TOKEN          required for Notion calls — integration secret
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
  console.error('this verb requires --parent-db <id> or --parent-page <id>')
  process.exit(2)
}

const requireKbRoot = (): string => {
  const kbRoot = process.env.MCP_KB_NOTION_MIRROR_KB_ROOT
  if (!kbRoot) {
    console.error('MCP_KB_NOTION_MIRROR_KB_ROOT is required.')
    process.exit(1)
  }
  return kbRoot
}

const ACTION_GLYPH: Record<string, string> = { touch: '+', update: '~', delete: '✗', skip: '↻', plan: '·', error: '✗' }

const printOutcomes = (outcomes: { kbPath: string; action: string; url?: string; error?: string }[]): void => {
  for (const o of outcomes) {
    const detail = o.error ? `  (${o.error})` : o.url ? `  → ${o.url}` : ''
    console.log(`  ${ACTION_GLYPH[o.action] ?? '?'} ${o.action.padEnd(7)} ${o.kbPath}${detail}`)
  }
}

const json = (v: unknown): void => console.log(JSON.stringify(v, null, 2))

// ── note ────────────────────────────────────────────────────────────────────
const runNote = async (verb: string, kbPath: string, argv: string[], dryRun: boolean): Promise<void> => {
  if (!kbPath) {
    console.error('note <verb> requires a <kbPath>')
    process.exit(2)
  }
  // Local-only verbs need no token.
  if (verb === 'status' || verb === 'preflight') {
    const cfg = { kbRoot: requireKbRoot() } as ReturnType<typeof loadConfig>
    json(verb === 'status' ? await statusNote(cfg, kbPath) : await preflightNote(cfg, kbPath))
    return
  }
  const cfg = loadConfig(process.env)
  switch (verb) {
    case 'get':
      return json(await getNote(cfg, kbPath))
    case 'touch':
      return json(await touchNote(cfg, kbPath, parentFromFlags(argv)))
    case 'update':
      return json(await updateNote(cfg, kbPath, parentFromFlags(argv)))
    case 'move':
      return json(await moveNote(cfg, kbPath, parentFromFlags(argv)))
    case 'delete':
      return json(await deleteNote(cfg, kbPath, dryRun))
    default:
      console.error(`Unknown note verb: ${verb}\n\n${USAGE}`)
      process.exit(2)
  }
}

// ── tree ────────────────────────────────────────────────────────────────────
const runTree = async (verb: string, subtree: string, argv: string[], dryRun: boolean): Promise<void> => {
  if (!subtree) {
    console.error('tree <verb> requires a <subtree>')
    process.exit(2)
  }
  const s = loadMirrorSettings(process.env)
  const note = flagValue(argv, '--note')
  if (verb === 'status' || verb === 'preflight') {
    const kbRoot = requireKbRoot()
    return json(verb === 'status' ? statusTree(kbRoot, subtree, s) : preflightTree(kbRoot, subtree, s))
  }
  const cfg = loadConfig(process.env)
  switch (verb) {
    case 'touch':
      return printOutcomes((await touchTree(cfg, subtree, parentFromFlags(argv), s, note)).outcomes)
    case 'update':
      return printOutcomes((await updateTree(cfg, subtree, parentFromFlags(argv), s, { kbPath: note })).outcomes)
    case 'delete':
      return printOutcomes((await deleteTree(cfg, subtree, s, { kbPath: note, dryRun })).outcomes)
    case 'prune':
      return printOutcomes((await pruneTree(cfg, subtree, s, { dryRun })).outcomes)
    default:
      console.error(`Unknown tree verb: ${verb}\n\n${USAGE}`)
      process.exit(2)
  }
}

// ── roots (batch over every declared root) ────────────────────────────────────
const runRoots = async (verb: string, dryRun: boolean): Promise<void> => {
  const s = loadMirrorSettings(process.env)
  if (verb === 'list') {
    return json(listRoots(requireKbRoot(), s))
  }
  const cfg = loadConfig(process.env)
  // prune scans git for deleted notes across the whole KB — it needs no roots list
  // and must work even after every root has been removed.
  if (verb === 'prune') return printOutcomes((await pruneRoots(cfg, s, { dryRun })).outcomes)
  const kbRoot = requireKbRoot()
  const roots = listRoots(kbRoot, s)
  if (roots.length === 0) {
    console.log('No mirror roots declared (kb_notion_mirror_root).')
    return
  }
  const globalLinkMap = (): Record<string, string> => buildLinkMap(roots.flatMap((r) => publishOrder(kbRoot, r.subtree, s, discover(kbRoot, r.subtree, s))))

  for (const r of roots) {
    const desc = r.parent.type === 'database_id' ? `db ${r.parent.database_id}` : `page ${r.parent.page_id}`
    console.log(`\n########## ${r.subtree}  (→ ${desc}) ##########`)
    if (verb === 'touch' || verb === 'publish') printOutcomes((await touchTree(cfg, r.subtree, r.parent, s)).outcomes)
  }
  if (verb === 'update' || verb === 'publish') {
    const linkMap = globalLinkMap() // one map across ALL roots → cross-root wikilinks resolve
    for (const r of roots) {
      console.log(`\n########## update ${r.subtree} ##########`)
      printOutcomes((await updateTree(cfg, r.subtree, r.parent, s, { linkMap })).outcomes)
    }
  }
  if (verb === 'delete') {
    for (const r of roots) {
      console.log(`\n########## delete ${r.subtree} ##########`)
      printOutcomes((await deleteTree(cfg, r.subtree, s, { dryRun })).outcomes)
    }
  }
  if (!['touch', 'update', 'publish', 'delete'].includes(verb)) {
    console.error(`Unknown roots verb: ${verb}\n\n${USAGE}`)
    process.exit(2)
  }
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const valueFlags = new Set(['--parent-db', '--parent-page', '--note'])
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      if (valueFlags.has(a)) i++
      continue
    }
    positional.push(a)
  }
  const [resource, verb, target] = positional

  if (!resource || resource === 'help' || resource === '--help' || resource === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (!verb) {
    console.error(`${resource} needs a verb\n\n${USAGE}`)
    process.exit(2)
  }

  if (resource === 'note') return runNote(verb, target as string, argv, dryRun)
  if (resource === 'tree') return runTree(verb, target as string, argv, dryRun)
  if (resource === 'roots') return runRoots(verb, dryRun)
  console.error(`Unknown resource: ${resource}\n\n${USAGE}`)
  process.exit(2)
}

main().catch((err) => {
  console.error('\nFAILED:', (err as Error).message)
  process.exit(1)
})
