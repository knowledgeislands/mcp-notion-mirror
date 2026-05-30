import { describe, expect, it } from 'vitest'
import { NoFrontmatterError, parseFrontmatter, removeFrontmatterFields, upsertFrontmatterFields } from './frontmatter.js'

const NOTE = `---
status: current — May 2026
purpose: one-line summary
notion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
notion_path: Product & Eng (Old) / Platform Architecture
notion_last_seen_at: 2026-04-08T00:00:00Z
captured_at: 2026-05-29T00:00:00Z
notion_action: keep
---
# Platform Architecture

Body paragraph.
`

describe('parseFrontmatter', () => {
  it('returns hasFrontmatter:false when there is no block', () => {
    const r = parseFrontmatter('# Just a heading\n\ntext')
    expect(r.hasFrontmatter).toBe(false)
    expect(r.fields).toEqual({})
  })

  it('parses top-level scalar fields and skips indented / list lines', () => {
    const text = `---
status: current
tags:
  - a
  - b
\tindented_with_tab: ignored
- bare list item
a line without a colon
notion_source_url: https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
---
body
`
    const { hasFrontmatter, fields } = parseFrontmatter(text)
    expect(hasFrontmatter).toBe(true)
    expect(fields.status).toBe('current')
    expect(fields.tags).toBe('')
    expect(fields.notion_source_url).toBe('https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(fields).not.toHaveProperty('a')
  })
})

describe('upsertFrontmatterFields', () => {
  it('inserts new mirror fields immediately after notion_path, preserving every other line', () => {
    const out = upsertFrontmatterFields(NOTE, {
      notion_mirror_url: 'https://www.notion.so/slug-cccccccccccccccccccccccccccccccc',
      notion_mirror_published_at: '2026-05-30T01:13:00Z'
    })
    expect(out).toBe(`---
status: current — May 2026
purpose: one-line summary
notion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
notion_path: Product & Eng (Old) / Platform Architecture
notion_mirror_url: https://www.notion.so/slug-cccccccccccccccccccccccccccccccc
notion_mirror_published_at: 2026-05-30T01:13:00Z
notion_last_seen_at: 2026-04-08T00:00:00Z
captured_at: 2026-05-29T00:00:00Z
notion_action: keep
---
# Platform Architecture

Body paragraph.
`)
  })

  it('replaces existing fields in place without reordering (re-publish)', () => {
    const once = upsertFrontmatterFields(NOTE, { notion_mirror_url: 'https://www.notion.so/v1-cccccccccccccccccccccccccccccccc', notion_mirror_published_at: '2026-05-30T01:13:00Z' })
    const twice = upsertFrontmatterFields(once, { notion_mirror_url: 'https://www.notion.so/v2-dddddddddddddddddddddddddddddddd', notion_mirror_published_at: '2026-06-01T09:00:00Z' })
    expect(twice).toContain('notion_mirror_url: https://www.notion.so/v2-dddddddddddddddddddddddddddddddd')
    expect(twice).toContain('notion_mirror_published_at: 2026-06-01T09:00:00Z')
    expect(twice).not.toContain('v1-')
    // order preserved: still right after notion_path, only one occurrence each
    expect(twice.match(/notion_mirror_url:/g)).toHaveLength(1)
  })

  it('falls back to notion_source_url_secondary as the insert anchor', () => {
    const text = `---
status: x
notion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
notion_source_url_secondary: https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
captured_at: 2026-05-29T00:00:00Z
---
body
`
    const out = upsertFrontmatterFields(text, { notion_mirror_url: 'u' })
    const lines = out.split('\n')
    expect(lines[lines.indexOf('notion_source_url_secondary: https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') + 1]).toBe('notion_mirror_url: u')
  })

  it('falls back to notion_source_url as the insert anchor', () => {
    const text = `---
status: x
notion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
captured_at: 2026-05-29T00:00:00Z
---
body
`
    const out = upsertFrontmatterFields(text, { notion_mirror_url: 'u' })
    const lines = out.split('\n')
    expect(lines[lines.indexOf('notion_source_url: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') + 1]).toBe('notion_mirror_url: u')
  })

  it('appends at the end when no anchor field is present', () => {
    const text = `---
status: x
purpose: y
---
body
`
    const out = upsertFrontmatterFields(text, { notion_mirror_url: 'u' })
    expect(out).toBe(`---
status: x
purpose: y
notion_mirror_url: u
---
body
`)
  })

  it('throws NoFrontmatterError when the note has no frontmatter', () => {
    expect(() => upsertFrontmatterFields('no frontmatter here', { notion_mirror_url: 'u' })).toThrow(NoFrontmatterError)
  })
})

describe('removeFrontmatterFields', () => {
  it('removes the named fields and leaves the rest byte-faithful', () => {
    const withMirror = upsertFrontmatterFields(NOTE, { notion_mirror_url: 'u', notion_mirror_published_at: 't' })
    const cleared = removeFrontmatterFields(withMirror, ['notion_mirror_url', 'notion_mirror_published_at'])
    expect(cleared).toBe(NOTE)
  })

  it('is a no-op when the note has no frontmatter', () => {
    expect(removeFrontmatterFields('plain text', ['notion_mirror_url'])).toBe('plain text')
  })
})
