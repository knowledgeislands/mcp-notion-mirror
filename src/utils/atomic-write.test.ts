import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteFile } from './atomic-write.js'

describe('atomicWriteFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-kb-notion-mirror-atomic-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes a new file', async () => {
    const target = path.join(dir, 'note.md')
    await atomicWriteFile(target, 'hello')
    expect(await fs.readFile(target, 'utf-8')).toBe('hello')
  })

  it('overwrites an existing file and leaves no temp files behind', async () => {
    const target = path.join(dir, 'note.md')
    await fs.writeFile(target, 'old')
    await atomicWriteFile(target, 'new')
    expect(await fs.readFile(target, 'utf-8')).toBe('new')
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('rejects and cleans up when the target directory does not exist', async () => {
    const target = path.join(dir, 'missing-subdir', 'note.md')
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow()
    // nothing leaked into the parent dir
    expect(await fs.readdir(dir)).toEqual([])
  })
})
