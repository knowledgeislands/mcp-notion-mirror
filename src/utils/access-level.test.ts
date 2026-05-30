import { describe, expect, it } from 'vitest'
import type { AccessLevel } from '../config/index.js'
import { levelFromAnnotations, makeAccessGatedRegister } from './access-level.js'
import { DESTRUCTIVE_REMOTE, READ_ONLY_REMOTE, WRITE_REMOTE } from './annotations.js'
import type { AuditConfig } from './audit-log.js'

// Audit disabled so registration doesn't touch the filesystem.
const AUDIT_OFF: AuditConfig = { mode: 'off', path: '/dev/null', maxBytes: 0, keep: 0 }

const makeStub = () => {
  const calls: string[] = []
  const stub = { registerTool: (name: string, _config: unknown, _handler: unknown) => calls.push(name) }
  return { calls, stub }
}

const gateAt = (accessLevel: AccessLevel) => {
  const { calls, stub } = makeStub()
  const gated = makeAccessGatedRegister(stub as unknown as Parameters<typeof makeAccessGatedRegister>[0], accessLevel, AUDIT_OFF)
  gated('notion_mirror_get', { title: 't', description: 'd', annotations: READ_ONLY_REMOTE } as never, (async () => ({ content: [] })) as never)
  gated('notion_mirror_publish', { title: 't', description: 'd', annotations: WRITE_REMOTE } as never, (async () => ({ content: [] })) as never)
  gated('notion_mirror_unpublish', { title: 't', description: 'd', annotations: DESTRUCTIVE_REMOTE } as never, (async () => ({ content: [] })) as never)
  return calls
}

describe('levelFromAnnotations', () => {
  it('maps READ_ONLY_REMOTE to read', () => {
    expect(levelFromAnnotations(READ_ONLY_REMOTE)).toBe('read')
  })

  it('maps WRITE_REMOTE to write', () => {
    expect(levelFromAnnotations(WRITE_REMOTE)).toBe('write')
  })

  it('maps DESTRUCTIVE_REMOTE to destructive', () => {
    expect(levelFromAnnotations(DESTRUCTIVE_REMOTE)).toBe('destructive')
  })

  it('defaults to destructive (fail-safe) for missing annotations', () => {
    expect(levelFromAnnotations(undefined)).toBe('destructive')
  })
})

describe('makeAccessGatedRegister', () => {
  it('registers only read-level tools at gate=read', () => {
    expect(gateAt('read')).toEqual(['notion_mirror_get'])
  })

  it('registers read + write but not destructive at gate=write', () => {
    expect(gateAt('write')).toEqual(['notion_mirror_get', 'notion_mirror_publish'])
  })

  it('registers every level at gate=destructive', () => {
    expect(gateAt('destructive')).toEqual(['notion_mirror_get', 'notion_mirror_publish', 'notion_mirror_unpublish'])
  })

  it('treats an unannotated tool as destructive (fail-safe — skipped at gate=write)', () => {
    const { calls, stub } = makeStub()
    const gated = makeAccessGatedRegister(stub as unknown as Parameters<typeof makeAccessGatedRegister>[0], 'write', AUDIT_OFF)
    gated('unannotated_tool', { title: 't', description: 'd' } as never, (async () => ({ content: [] })) as never)
    expect(calls).toEqual([])
  })
})
