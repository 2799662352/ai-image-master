import { describe, it, expect } from 'vitest'
import { validateMcpServerEntry, formatValidationError } from '../mcpEntryValidator'

describe('validateMcpServerEntry', () => {
  describe('passes (returns null)', () => {
    it('stdio with command + args', () => {
      expect(validateMcpServerEntry('apiyi', { command: 'node', args: ['index.js'] })).toBeNull()
    })

    it('stdio with command only (args optional)', () => {
      expect(validateMcpServerEntry('echo', { command: 'echo' })).toBeNull()
    })

    it('streamable_http with url', () => {
      expect(validateMcpServerEntry('linear', { url: 'https://mcp.linear.app/mcp' })).toBeNull()
    })

    it('passes when extra unknown fields exist alongside command (codex tolerates them)', () => {
      // The renderer pre-validator only gates on the transport rule that
      // produces codex's `"invalid transport"` error. It must not be
      // STRICTER than codex itself; e.g. `enabled`, `tool_timeout_sec`,
      // `env` are valid codex fields and must pass.
      expect(
        validateMcpServerEntry('apiyi', {
          command: 'node',
          args: ['index.js'],
          enabled: true,
          tool_timeout_sec: null,
          env: { APIYI_API_KEY: 'sk-...' },
        }),
      ).toBeNull()
    })
  })

  describe('rejects with missing-transport (the actual user-facing bug)', () => {
    it('empty object — exactly the codex "invalid transport" root cause', () => {
      const err = validateMcpServerEntry('apiyi', {})
      expect(err).toEqual({ kind: 'missing-transport', name: 'apiyi' })
    })

    it('only env block (no command, no url) — common after partial edits', () => {
      const err = validateMcpServerEntry('apiyi', { env: { KEY: 'v' }, enabled: true })
      expect(err?.kind).toBe('missing-transport')
    })

    it('only args (no command) — codex would fail this too', () => {
      const err = validateMcpServerEntry('orphan', { args: ['index.js'] })
      expect(err?.kind).toBe('missing-transport')
    })
  })

  describe('rejects with bad shape', () => {
    it('null config', () => {
      expect(validateMcpServerEntry('x', null)?.kind).toBe('not-object')
    })

    it('array config (TOML never produces this, but JSON can)', () => {
      expect(validateMcpServerEntry('x', ['command', 'node'])?.kind).toBe('not-object')
    })

    it('string config', () => {
      expect(validateMcpServerEntry('x', 'command=node')?.kind).toBe('not-object')
    })
  })

  describe('rejects with empty / wrong-typed command/url', () => {
    it('command = ""', () => {
      expect(validateMcpServerEntry('x', { command: '' })?.kind).toBe('empty-command')
    })

    it('command = "   " (whitespace only — treated as empty)', () => {
      expect(validateMcpServerEntry('x', { command: '   ' })?.kind).toBe('empty-command')
    })

    it('command = 123 (number)', () => {
      expect(validateMcpServerEntry('x', { command: 123 })?.kind).toBe('invalid-command-type')
    })

    it('command = null is treated as type mismatch (not absent)', () => {
      // `"command": null` in JSON is a present-but-null key. Codex would
      // also reject this — Option<String> can deserialize null as None
      // OR as TypeError depending on serde mode, so we conservatively
      // surface it as a type error rather than fall through to
      // missing-transport which would be misleading (the user clearly
      // intended to set command, they just have a wrong value).
      expect(validateMcpServerEntry('x', { command: null })?.kind).toBe('invalid-command-type')
    })

    it('url = ""', () => {
      expect(validateMcpServerEntry('x', { url: '' })?.kind).toBe('empty-url')
    })

    it('url = 42', () => {
      expect(validateMcpServerEntry('x', { url: 42 })?.kind).toBe('invalid-url-type')
    })
  })

  describe('error formatting', () => {
    it('missing-transport message mentions BOTH command and url (so user knows the choice)', () => {
      const msg = formatValidationError({ kind: 'missing-transport', name: 'apiyi' })
      expect(msg).toContain('command')
      expect(msg).toContain('url')
      expect(msg).toContain('apiyi')
      // Should also reference the codex error string so it's grep-able
      // when the user comes back from a search engine looking for the
      // exact message they saw.
      expect(msg).toContain('invalid transport')
    })

    it('not-object message gives a concrete example shape', () => {
      const msg = formatValidationError({ kind: 'not-object', name: 'foo' })
      expect(msg).toContain('foo')
      expect(msg.toLowerCase()).toContain('command')
    })

    it('all error kinds produce a non-empty Chinese message including the server name', () => {
      const kinds = [
        'not-object', 'missing-transport', 'empty-command',
        'empty-url', 'invalid-command-type', 'invalid-url-type',
      ] as const
      for (const kind of kinds) {
        const msg = formatValidationError({ kind, name: 'broken' } as any)
        expect(msg).toContain('broken')
        expect(msg.length).toBeGreaterThan(5)
      }
    })
  })
})
