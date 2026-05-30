import { describe, expect, it } from 'vitest'
import { bodyToBlocks, stripFrontmatter, stripLeadingH1, titleFromPath } from './markdown.js'

describe('markdown helpers', () => {
  describe('stripFrontmatter', () => {
    it('drops the leading frontmatter block and following blank lines', () => {
      expect(stripFrontmatter('---\na: 1\n---\n\n# Title\n')).toBe('# Title\n')
    })

    it('returns the text unchanged when there is no frontmatter', () => {
      expect(stripFrontmatter('# Title\n\nbody')).toBe('# Title\n\nbody')
    })
  })

  describe('stripLeadingH1', () => {
    it('drops the first H1, skipping leading blank lines', () => {
      expect(stripLeadingH1('\n\n# Heading\n\nbody')).toBe('\n\n\nbody')
    })

    it('leaves H2 and bodies without an H1 untouched', () => {
      expect(stripLeadingH1('## Sub\n\nbody')).toBe('## Sub\n\nbody')
      expect(stripLeadingH1('just text')).toBe('just text')
    })

    it('handles empty input', () => {
      expect(stripLeadingH1('')).toBe('')
    })
  })

  describe('titleFromPath', () => {
    it('strips dir and .md extension (case-insensitive)', () => {
      expect(titleFromPath('/kb/Eng/My Note.md')).toBe('My Note')
      expect(titleFromPath('Other.MD')).toBe('Other')
    })
  })

  describe('bodyToBlocks', () => {
    it('converts markdown to Notion blocks', () => {
      const blocks = bodyToBlocks('## Heading\n\nA paragraph.') as Array<{ type: string }>
      const types = blocks.map((b) => b.type)
      expect(types).toContain('heading_2')
      expect(types).toContain('paragraph')
    })

    it('returns an empty array for empty input', () => {
      expect(bodyToBlocks('')).toEqual([])
    })
  })
})
