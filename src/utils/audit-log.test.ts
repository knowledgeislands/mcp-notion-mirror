import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditConfig } from './audit-log.js'

describe('appendAuditEvent / withAuditLog (mcp-notion-mirror)', () => {
  const tmpDir = path.join(os.tmpdir(), 'mcp-notion-mirror-audit-log-tests', `run-${process.pid}-${Date.now()}`)
  const logPath = path.join(tmpDir, 'audit.jsonl')

  // The audit-log module keeps internal state (chmodEnsured, the append queue),
  // so reset modules per test for isolation. Config is passed in explicitly.
  const auditCfg = (o: Partial<AuditConfig> = {}): AuditConfig => ({ mode: 'writes', path: logPath, maxBytes: 10 * 1024 * 1024, keep: 5, ...o })

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
    vi.resetModules()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const flushAsync = () => new Promise((r) => setTimeout(r, 20))

  it('returns the handler verbatim for read-level tools in default writes mode', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const handler = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: 'ok' }] }))
    expect(withAuditLog(auditCfg(), 'notion_mirror_get', 'read', handler)).toBe(handler)
    await handler({})
    await flushAsync()
    await expect(fs.access(logPath)).rejects.toThrow()
  })

  it('logs write-level tools by default (writes mode)', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'x.md', mode: 'create' })
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.server).toBe('mcp-notion-mirror')
    expect(event.tool).toBe('notion_mirror_publish')
    expect(event.level).toBe('write')
    expect(event.ok).toBe(true)
    expect(event.args).toEqual({ kb_path: 'x.md', mode: 'create' })
  })

  it('logs read-level tools when audit mode is "all"', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ mode: 'all' }), 'notion_mirror_get', 'read', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'x.md' })
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.tool).toBe('notion_mirror_get')
    expect(event.ok).toBe(true)
  })

  it('records ok:false when isError:true', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ isError: true, content: [{ type: 'text', text: 'bad path' }] }))
    await wrapped({})
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('bad path')
  })

  it('records ok:false when the handler throws', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => {
      throw new Error('kaboom')
    })
    await expect(wrapped({})).rejects.toThrow(/kaboom/)
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('kaboom')
  })

  it('stringifies non-Error throws into the audit log', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => {
      throw 'string-throw'
    })
    await expect(wrapped({})).rejects.toBe('string-throw')
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.error).toBe('string-throw')
  })

  it('skips logging entirely when audit mode is "off"', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const writeHandler = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: 'ok' }] }))
    expect(withAuditLog(auditCfg({ mode: 'off' }), 'notion_mirror_publish', 'write', writeHandler)).toBe(writeHandler)
    await writeHandler({})
    await flushAsync()
    await expect(fs.access(logPath)).rejects.toThrow()
  })

  it('returns a non-error result envelope on success', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const result = (await wrapped({})) as { content: Array<{ type: string; text: string }> }
    expect(result.content[0]?.text).toBe('ok')
  })

  it('handles missing content array on isError results', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ isError: true }) as unknown as { content: { type: string; text: string }[] })
    await wrapped({})
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBeUndefined()
  })

  it('chmods the audit log to 0o600 on first write (even if it pre-existed at 0o644)', async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(logPath, '', { mode: 0o644 })
    expect(((await fs.stat(logPath)).mode & 0o777).toString(8)).toBe('644')

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({})
    await flushAsync()

    expect(((await fs.stat(logPath)).mode & 0o777).toString(8)).toBe('600')
  })

  it('truncates oversized argument payloads with a _truncated marker', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ blob: 'x'.repeat(8000) })
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.args._truncated).toBe(true)
    expect(typeof event.args.preview).toBe('string')
  })

  it('rotates the audit log when it exceeds maxBytes', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ maxBytes: 64 }), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'a.md' })
    await flushAsync()
    await wrapped({ kb_path: 'b.md' })
    await flushAsync()
    const rotated = await fs.readFile(`${logPath}.1`, 'utf-8')
    expect(rotated.length).toBeGreaterThan(0)
  })

  it('discards the live log when keep=0', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ maxBytes: 64, keep: 0 }), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'a.md' })
    await flushAsync()
    await wrapped({ kb_path: 'b.md' })
    await flushAsync()
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('shifts existing rotation slots when rotating', async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(`${logPath}.1`, 'prior-rotation\n', { mode: 0o600 })

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ maxBytes: 64, keep: 3 }), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'a.md' })
    await flushAsync()
    await wrapped({ kb_path: 'b.md' })
    await flushAsync()

    const three = await fs.readFile(`${logPath}.3`, 'utf-8')
    expect(three).toBe('prior-rotation\n')
  })

  it('is a no-op when maxBytes=0 (rotation disabled)', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ maxBytes: 0 }), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    await wrapped({ kb_path: 'a.md' })
    await flushAsync()
    await wrapped({ kb_path: 'b.md' })
    await flushAsync()
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('silently absorbs write failures (writes to a non-writable parent)', async () => {
    const badPath = path.join(tmpDir, 'no-perms', 'audit.jsonl')
    await fs.mkdir(path.dirname(badPath), { recursive: true })
    await fs.chmod(path.dirname(badPath), 0o500)

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ path: badPath }), 'notion_mirror_publish', 'write', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = (await wrapped({})) as { content: Array<{ type: string; text: string }> }
    expect(result.content[0]?.text).toBe('ok')
    await flushAsync()
    consoleErr.mockRestore()

    await fs.chmod(path.dirname(badPath), 0o700)
  })
})
