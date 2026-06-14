import { describe, expect, it } from 'vitest'
import { DEFAULT_BANNER_TEMPLATE } from '../../config/index.js'
import { bannerBlock } from './banner.js'

describe('banner', () => {
  it('builds a 📘 callout, interpolates {date}, and renders **bold** via martian', () => {
    const block = bannerBlock(DEFAULT_BANNER_TEMPLATE, '2026-05-30') as {
      type: string
      callout: { icon: { emoji: string }; rich_text: Array<{ text: { content: string }; annotations?: { bold?: boolean } }> }
    }
    expect(block.type).toBe('callout')
    expect(block.callout.icon).toEqual({ type: 'emoji', emoji: '📘' })
    const fullText = block.callout.rich_text.map((r) => r.text.content).join('')
    expect(fullText).toContain('Mirrored from Knowledge Base - last updated on 2026-05-30')
    // The default template wraps the lead clause in bold.
    expect(block.callout.rich_text.some((r) => r.annotations?.bold)).toBe(true)
  })

  it('honours a custom template', () => {
    const block = bannerBlock('Synced {date} — see KB.', '2026-01-02') as { callout: { rich_text: Array<{ text: { content: string } }> } }
    expect(block.callout.rich_text.map((r) => r.text.content).join('')).toBe('Synced 2026-01-02 — see KB.')
  })

  it('returns undefined when the template is the empty string (disabled)', () => {
    expect(bannerBlock('', '2026-05-30')).toBeUndefined()
  })
})
