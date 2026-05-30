/**
 * YAML frontmatter manipulation for KB notes.
 *
 * Deliberately NOT a YAML round-trip. `js-yaml` / `yaml` reorder keys and
 * rewrite escaping; the KB's strict field-order and value-formatting rules
 * (see BUILD-SPEC §Frontmatter contract) require byte-faithful edits. So we
 * regex out the leading `---\n…\n---\n` block and do per-line field surgery,
 * mirroring the reference `upsert_frontmatter_fields` algorithm.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/

export class NoFrontmatterError extends Error {
  constructor(message = 'Note has no YAML frontmatter; refusing to invent it.') {
    super(message)
    this.name = 'NoFrontmatterError'
  }
}

/**
 * Anchors after which newly-inserted fields are placed, in priority order. The
 * KB note shape puts mirror fields directly after `notion_path`; the fallbacks
 * cover notes that omit it.
 */
const INSERT_AFTER_ANCHORS = ['notion_path', 'notion_source_url_secondary', 'notion_source_url'] as const

/** The top-level key of a frontmatter line, or undefined for indented / list / non-field lines. */
const lineKey = (line: string): string | undefined => {
  if (line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')) return undefined
  const m = line.match(/^([A-Za-z0-9_]+):/)
  return m ? m[1] : undefined
}

export interface ParsedFrontmatter {
  hasFrontmatter: boolean
  fields: Record<string, string>
}

/** Parse the leading frontmatter block into a flat field map (top-level scalars only). */
export const parseFrontmatter = (text: string): ParsedFrontmatter => {
  const m = FRONTMATTER_RE.exec(text)
  if (!m || m[1] === undefined) return { hasFrontmatter: false, fields: {} }
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const key = lineKey(line)
    if (key !== undefined) fields[key] = line.slice(key.length + 1).trim()
  }
  return { hasFrontmatter: true, fields }
}

/**
 * Insert or update the given fields in the frontmatter, preserving the order
 * and formatting of every other line. Existing fields are replaced in place;
 * new fields are inserted after the highest-priority present anchor.
 * Throws NoFrontmatterError when there is no frontmatter block to edit.
 */
export const upsertFrontmatterFields = (text: string, updates: Record<string, string>): string => {
  const m = FRONTMATTER_RE.exec(text)
  if (!m || m[1] === undefined) throw new NoFrontmatterError()
  const body = text.slice(m[0].length)
  const lines = m[1].split('\n')

  const seen = new Set<string>()
  const out = lines.map((line) => {
    const key = lineKey(line)
    if (key !== undefined && key in updates) {
      seen.add(key)
      return `${key}: ${updates[key]}`
    }
    return line
  })

  const toInsert = Object.entries(updates).filter(([k]) => !seen.has(k))
  if (toInsert.length > 0) {
    const newLines = toInsert.map(([k, v]) => `${k}: ${v}`)
    let anchorIdx = -1
    for (const anchor of INSERT_AFTER_ANCHORS) {
      anchorIdx = out.findIndex((line) => lineKey(line) === anchor)
      if (anchorIdx !== -1) break
    }
    if (anchorIdx === -1) out.push(...newLines)
    else out.splice(anchorIdx + 1, 0, ...newLines)
  }

  return `---\n${out.join('\n')}\n---\n${body}`
}

/**
 * Remove the given fields from the frontmatter, leaving every other line
 * untouched. A no-op (returns the input unchanged) when there is no
 * frontmatter or none of the keys are present.
 */
export const removeFrontmatterFields = (text: string, keys: string[]): string => {
  const m = FRONTMATTER_RE.exec(text)
  if (!m || m[1] === undefined) return text
  const body = text.slice(m[0].length)
  const drop = new Set(keys)
  const out = m[1].split('\n').filter((line) => {
    const key = lineKey(line)
    return key === undefined || !drop.has(key)
  })
  return `---\n${out.join('\n')}\n---\n${body}`
}
