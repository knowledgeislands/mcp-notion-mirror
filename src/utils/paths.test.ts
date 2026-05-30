import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KbPathError, resolveKbNotePath } from './paths.js'

let kbRoot: string
const real = (p: string) => fs.realpathSync(p)

beforeEach(async () => {
  kbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-notion-mirror-paths-'))
  await fsp.mkdir(path.join(kbRoot, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(kbRoot, 'sub', 'note.md'), 'x')
})

afterEach(async () => {
  await fsp.rm(kbRoot, { recursive: true, force: true })
})

describe('resolveKbNotePath (kbRoot set)', () => {
  it('resolves a relative path under the root to the note realpath', () => {
    expect(resolveKbNotePath(kbRoot, 'sub/note.md')).toBe(real(path.join(kbRoot, 'sub', 'note.md')))
  })

  it('accepts an absolute path under the root', () => {
    expect(resolveKbNotePath(kbRoot, path.join(kbRoot, 'sub', 'note.md'))).toBe(real(path.join(kbRoot, 'sub', 'note.md')))
  })

  it('rejects ".." segments', () => {
    expect(() => resolveKbNotePath(kbRoot, '../etc/passwd')).toThrow(KbPathError)
  })

  it('rejects an empty path', () => {
    expect(() => resolveKbNotePath(kbRoot, '   ')).toThrow(KbPathError)
  })

  it('rejects an absolute path outside the root (lexical confinement)', () => {
    expect(() => resolveKbNotePath(kbRoot, '/etc/hosts')).toThrow(/escapes the allowed KB root/)
  })

  it('rejects a symlink that escapes the root (realpath confinement)', async () => {
    const outsideParent = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-notion-mirror-outside-'))
    try {
      await fsp.symlink(outsideParent, path.join(kbRoot, 'link'))
      expect(() => resolveKbNotePath(kbRoot, 'link/escaped.md')).toThrow(/escapes the allowed KB root/)
    } finally {
      await fsp.rm(outsideParent, { recursive: true, force: true })
    }
  })
})

describe('resolveKbNotePath (kbRoot undefined)', () => {
  it('rejects a relative path', () => {
    expect(() => resolveKbNotePath(undefined, 'sub/note.md')).toThrow(KbPathError)
  })

  it('accepts an absolute path (no confinement)', () => {
    const abs = path.join(kbRoot, 'sub', 'note.md')
    expect(resolveKbNotePath(undefined, abs)).toBe(real(abs))
  })

  it('still rejects ".." segments', () => {
    expect(() => resolveKbNotePath(undefined, '/a/../b')).toThrow(KbPathError)
  })
})
