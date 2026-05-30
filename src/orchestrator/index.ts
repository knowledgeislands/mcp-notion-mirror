/**
 * Public surface of the orchestrator. The library API is everything in
 * `./api.ts` (publishAll, publishOne, status, preflight, unpublishOne, plus the
 * two passes), the lower-level building blocks in `./discover.ts`, and the
 * settings loader in `./settings.ts`. The CLI in `./cli.ts` is consumed as the
 * `mcp-kb-notion-mirror-publish` bin, not via this module.
 */

export type { NoteOutcome, PublishAllOptions, PublishAllResult, PublishOneResult } from './api.js'
export { pass1, pass2, preflight, publishAll, publishOne, status, unpublishOne } from './api.js'
export type { Note } from './discover.js'
export { buildLinkMap, discover, iconFor, indexKbPathFor, publishOrder, readFrontmatter, resolveParent } from './discover.js'
export type { OrchestratorSettings } from './settings.js'
export { loadOrchestratorSettings } from './settings.js'
