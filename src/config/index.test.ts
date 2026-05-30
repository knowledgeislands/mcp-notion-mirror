import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './index.js'

// loadConfig reads from the env object it's given, so tests pass explicit envs
// (no process.env mutation, no module-reset dance).
const load = (extra: Record<string, string> = {}) => loadConfig({ MCP_KB_NOTION_MIRROR_TOKEN: 'ntn_placeholder', ...extra })

describe('loadConfig', () => {
  describe('notionToken', () => {
    it('reads + trims the token', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_TOKEN: '  ntn_abc  ' }).notionToken).toBe('ntn_abc')
    })

    it('throws when unset', () => {
      expect(() => loadConfig({})).toThrow(/MCP_KB_NOTION_MIRROR_TOKEN is required/)
    })

    it('throws when blank', () => {
      expect(() => loadConfig({ MCP_KB_NOTION_MIRROR_TOKEN: '   ' })).toThrow(/MCP_KB_NOTION_MIRROR_TOKEN is required/)
    })
  })

  describe('notionApiBaseUrl + version', () => {
    it('defaults to https://api.notion.com', () => {
      expect(load().notionApiBaseUrl).toBe('https://api.notion.com')
    })

    it('respects the override and strips trailing slashes', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_API_BASE_URL: 'https://example.test///' }).notionApiBaseUrl).toBe('https://example.test')
    })

    it('pins the Notion API version', () => {
      expect(load().notionApiVersion).toBe('2022-06-28')
    })
  })

  describe('kbRoot', () => {
    it('is undefined when unset', () => {
      expect(load().kbRoot).toBeUndefined()
    })

    it('is undefined when blank', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_KB_ROOT: '  ' }).kbRoot).toBeUndefined()
    })

    it('resolves and expands ~/ in the path', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_KB_ROOT: '~/kb' }).kbRoot).toBe(path.join(os.homedir(), 'kb'))
    })

    it('expands a bare ~', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_KB_ROOT: '~' }).kbRoot).toBe(os.homedir())
    })

    it('passes absolute paths through', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_KB_ROOT: '/tmp/kb' }).kbRoot).toBe('/tmp/kb')
    })
  })

  describe('bannerTemplate', () => {
    it('defaults to the KB banner template (with the {date} placeholder) when unset', async () => {
      const { DEFAULT_BANNER_TEMPLATE } = await import('./index.js')
      expect(load().bannerTemplate).toBe(DEFAULT_BANNER_TEMPLATE)
      expect(load().bannerTemplate).toContain('{date}')
    })

    it('is the empty string when set empty (banner disabled)', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_BANNER_TEMPLATE: '' }).bannerTemplate).toBe('')
    })

    it('passes a custom template through verbatim', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_BANNER_TEMPLATE: 'Synced {date}.' }).bannerTemplate).toBe('Synced {date}.')
    })
  })

  describe('accessLevel', () => {
    it('defaults to write when unset', () => {
      expect(load().accessLevel).toBe('write')
    })

    it('defaults to write when blank', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_ACCESS_LEVEL: '  ' }).accessLevel).toBe('write')
    })

    it.each(['read', 'write', 'destructive'] as const)('accepts %s', (level) => {
      expect(load({ MCP_KB_NOTION_MIRROR_ACCESS_LEVEL: level }).accessLevel).toBe(level)
    })

    it('throws on an unknown value', () => {
      expect(() => load({ MCP_KB_NOTION_MIRROR_ACCESS_LEVEL: 'admin' })).toThrow(/Invalid MCP_KB_NOTION_MIRROR_ACCESS_LEVEL="admin"/)
    })
  })

  describe('auditLogMode', () => {
    it('defaults to writes', () => {
      expect(load().auditLogMode).toBe('writes')
    })

    it('defaults to writes when blank', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG: '  ' }).auditLogMode).toBe('writes')
    })

    it.each(['off', 'writes', 'all'] as const)('accepts %s', (mode) => {
      expect(load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG: mode }).auditLogMode).toBe(mode)
    })

    it('throws on an unknown value', () => {
      expect(() => load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG: 'sometimes' })).toThrow(/Invalid MCP_KB_NOTION_MIRROR_AUDIT_LOG/)
    })
  })

  describe('auditLogPath', () => {
    it('defaults to ~/.local/state/mcp-kb-notion-mirror/audit.jsonl', () => {
      expect(load().auditLogPath).toBe(path.join(os.homedir(), '.local', 'state', 'mcp-kb-notion-mirror', 'audit.jsonl'))
    })

    it('expands a bare ~ in the override', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_PATH: '~' }).auditLogPath).toBe(os.homedir())
    })

    it('expands ~/foo in the override', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_PATH: '~/foo/audit.jsonl' }).auditLogPath).toBe(path.join(os.homedir(), 'foo', 'audit.jsonl'))
    })

    it('passes absolute paths through unchanged', () => {
      expect(load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_PATH: '/tmp/audit.jsonl' }).auditLogPath).toBe('/tmp/audit.jsonl')
    })
  })

  describe('auditLogMaxBytes / auditLogKeep', () => {
    it('use sensible defaults when unset', () => {
      const cfg = load()
      expect(cfg.auditLogMaxBytes).toBe(10 * 1024 * 1024)
      expect(cfg.auditLogKeep).toBe(5)
    })

    it('use defaults when blank', () => {
      const cfg = load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES: '  ', MCP_KB_NOTION_MIRROR_AUDIT_LOG_KEEP: '  ' })
      expect(cfg.auditLogMaxBytes).toBe(10 * 1024 * 1024)
      expect(cfg.auditLogKeep).toBe(5)
    })

    it('accept non-negative ints', () => {
      const cfg = load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES: '0', MCP_KB_NOTION_MIRROR_AUDIT_LOG_KEEP: '3' })
      expect(cfg.auditLogMaxBytes).toBe(0)
      expect(cfg.auditLogKeep).toBe(3)
    })

    it('throws on a negative value', () => {
      expect(() => load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES: '-1' })).toThrow(/MCP_KB_NOTION_MIRROR_AUDIT_LOG_MAX_BYTES/)
    })

    it('throws on a non-numeric value', () => {
      expect(() => load({ MCP_KB_NOTION_MIRROR_AUDIT_LOG_KEEP: 'lots' })).toThrow(/MCP_KB_NOTION_MIRROR_AUDIT_LOG_KEEP/)
    })
  })
})
