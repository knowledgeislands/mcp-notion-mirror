/**
 * KB path validation. Every `kb_path` runs through here before any `fs.*` call.
 * Config-agnostic: the caller passes the `kbRoot` (from its Config) rather than
 * this module reading any singleton, so it's reusable across MCPs.
 *
 * Two-layer guard, matching the sibling MCPs:
 *   1. Lexical — reject `..` segments and (when `kbRoot` is set) confine the
 *      normalized path under `kbRoot`.
 *   2. Realpath — resolve the deepest existing ancestor with `fs.realpathSync`
 *      and re-check confinement, catching symlink escapes that survive the
 *      lexical check.
 *
 * When `kbRoot` is undefined, relative paths are rejected (we can't anchor
 * them) and absolute paths are accepted after the `..` check — there is no
 * confinement because there is no root to confine against (caller's
 * responsibility). There is NO layout (`Pillars/` etc.) confinement.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export class KbPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KbPathError'
  }
}

const hasParentSegment = (p: string): boolean => p.split(/[\\/]/).includes('..')

/** realpath the deepest existing ancestor of `p`, re-joining the missing tail. */
const realpathDeepestExisting = (p: string): string => {
  let prefix = p
  const tail: string[] = []
  while (true) {
    try {
      return path.join(fs.realpathSync(prefix), ...tail.reverse())
    } catch {
      const parent = path.dirname(prefix)
      /* v8 ignore next — path.dirname stabilises at '/' which always realpaths, so the root is never missing */
      if (parent === prefix) return p
      tail.push(path.basename(prefix))
      prefix = parent
    }
  }
}

const assertWithin = (root: string, candidate: string): void => {
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new KbPathError(`Path escapes the allowed KB root: ${candidate} is not under ${root}`)
  }
}

/**
 * Resolve and validate a single KB note path against `kbRoot`. Returns the
 * realpath of the note (the note itself need not exist yet, but its directory
 * chain is realpath-ed). Confined under `kbRoot` when set; otherwise only
 * absolute paths are accepted.
 */
export const resolveKbNotePath = (kbRoot: string | undefined, kbPath: string): string => {
  if (kbPath.trim() === '') throw new KbPathError('kb_path must not be empty')
  if (hasParentSegment(kbPath)) throw new KbPathError(`kb_path must not contain ".." segments: ${kbPath}`)

  let resolved: string
  if (path.isAbsolute(kbPath)) {
    resolved = path.normalize(kbPath)
  } else {
    if (kbRoot === undefined) {
      throw new KbPathError('kb_path is relative but MCP_KB_NOTION_MIRROR_KB_ROOT is not set. Pass an absolute path or set the KB root.')
    }
    resolved = path.resolve(kbRoot, kbPath)
  }

  if (kbRoot !== undefined) {
    assertWithin(kbRoot, resolved)
    const real = realpathDeepestExisting(resolved)
    assertWithin(realpathDeepestExisting(kbRoot), real)
    return real
  }
  return realpathDeepestExisting(resolved)
}
