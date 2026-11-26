import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { validateSessionConfigPatch } from '../sessionConfigValidation'

describe('validateSessionConfigPatch', () => {
  it('accepts official values and normalized roots', () => {
    const root = path.resolve('D:/workspace')
    const child = path.join(root, 'project')

    const result = validateSessionConfigPatch({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: 'cached',
      writableRoots: [child],
    }, [root])

    expect(result).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: 'cached',
      writableRoots: [path.resolve(child)],
    })
  })

  it('rejects deprecated on-failure approval policy', () => {
    expect(() => validateSessionConfigPatch({ approvalPolicy: 'on-failure' }, []))
      .toThrow(/approvalPolicy/i)
  })

  it('rejects the retired untrusted approval policy (openai/codex#39630)', () => {
    // Migration of legacy persisted values belongs to SessionConfigStore; the
    // IPC path stays strict so the panel can never send a value that makes
    // codex fail config load.
    expect(() => validateSessionConfigPatch({ approvalPolicy: 'untrusted' }, []))
      .toThrow(/approvalPolicy/i)
  })

  it('rejects roots outside allowed workspaces', () => {
    expect(() => validateSessionConfigPatch({
      writableRoots: [path.resolve('D:/outside')],
    }, [path.resolve('D:/workspace')])).toThrow(/outside allowed workspace/i)
  })

  it('rejects arrays and non-object patches', () => {
    expect(() => validateSessionConfigPatch([], [])).toThrow(/object/i)
    expect(() => validateSessionConfigPatch(null, [])).toThrow(/object/i)
    expect(() => validateSessionConfigPatch('bad', [])).toThrow(/object/i)
  })

  it('rejects invalid enum strings', () => {
    expect(() => validateSessionConfigPatch({ sandboxMode: 'full' }, [])).toThrow(/sandboxMode/i)
    expect(() => validateSessionConfigPatch({ approvalPolicy: 'always' }, [])).toThrow(/approvalPolicy/i)
    expect(() => validateSessionConfigPatch({ webSearch: 'enabled' }, [])).toThrow(/webSearch/i)
  })

  it('accepts the session tuning fields (personality/reasoningSummary/showRawReasoning/indexed search)', () => {
    const result = validateSessionConfigPatch({
      webSearch: 'indexed',
      personality: 'pragmatic',
      reasoningSummary: 'detailed',
      showRawReasoning: false,
    }, [])

    expect(result).toEqual({
      webSearch: 'indexed',
      personality: 'pragmatic',
      reasoningSummary: 'detailed',
      showRawReasoning: false,
    })
  })

  it('rejects invalid session tuning values', () => {
    expect(() => validateSessionConfigPatch({ personality: 'sassy' }, [])).toThrow(/personality/i)
    expect(() => validateSessionConfigPatch({ reasoningSummary: 'verbose' }, [])).toThrow(/reasoningSummary/i)
    expect(() => validateSessionConfigPatch({ showRawReasoning: 'yes' }, [])).toThrow(/showRawReasoning/i)
  })

  it('accepts the batch-2 modelVerbosity field, including "default" (= omit the key)', () => {
    expect(validateSessionConfigPatch({ modelVerbosity: 'high' }, []))
      .toEqual({ modelVerbosity: 'high' })
    expect(validateSessionConfigPatch({ modelVerbosity: 'default' }, []))
      .toEqual({ modelVerbosity: 'default' })
  })

  it('rejects invalid modelVerbosity values', () => {
    expect(() => validateSessionConfigPatch({ modelVerbosity: 'medium-rare' }, [])).toThrow(/modelVerbosity/i)
    // planReasoningEffort is a composer-level preference, not a session key.
    expect(validateSessionConfigPatch({ planReasoningEffort: 'xhigh' } as Record<string, unknown>, []))
      .toEqual({})
  })

  it('accepts the memoriesEnabled boolean (cross-session memory toggle)', () => {
    expect(validateSessionConfigPatch({ memoriesEnabled: false }, []))
      .toEqual({ memoriesEnabled: false })
    expect(validateSessionConfigPatch({ memoriesEnabled: true }, []))
      .toEqual({ memoriesEnabled: true })
  })

  it('rejects non-boolean memoriesEnabled values', () => {
    expect(() => validateSessionConfigPatch({ memoriesEnabled: 'on' }, [])).toThrow(/memoriesEnabled/i)
    expect(() => validateSessionConfigPatch({ memoriesEnabled: 1 }, [])).toThrow(/memoriesEnabled/i)
  })

  it('accepts the xAI server-tool switches (booleans only)', () => {
    expect(validateSessionConfigPatch({ grokXSearch: true, grokCodeInterpreter: false }, []))
      .toEqual({ grokXSearch: true, grokCodeInterpreter: false })
    expect(() => validateSessionConfigPatch({ grokXSearch: 'yes' }, [])).toThrow(/grokXSearch/)
    expect(() => validateSessionConfigPatch({ grokXSearch: 1 }, [])).toThrow(/grokXSearch/)
    expect(() => validateSessionConfigPatch({ grokCodeInterpreter: 'on' }, [])).toThrow(/grokCodeInterpreter/)
    expect(() => validateSessionConfigPatch({ grokCodeInterpreter: null }, [])).toThrow(/grokCodeInterpreter/)
  })

  it('accepts a valid remote MCP list (and an empty one to clear it)', () => {
    const list = [{ label: 'deepwiki', url: ' https://mcp.deepwiki.com/mcp ' }]
    expect(validateSessionConfigPatch({ grokRemoteMcp: list }, []))
      .toEqual({ grokRemoteMcp: [{ label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }] })
    expect(validateSessionConfigPatch({ grokRemoteMcp: [] }, [])).toEqual({ grokRemoteMcp: [] })
  })

  it('rejects remote MCP lists that are not public https, are duplicated, or are malformed', () => {
    const bad = [
      'not an array',
      [{ label: 'a', url: 'http://example.com/mcp' }],
      [{ label: 'a', url: 'https://localhost/mcp' }],
      [{ label: 'a', url: 'https://192.168.1.2/mcp' }],
      [{ label: 'a', url: 'https://u:p@example.com/mcp' }],
      [{ label: 'a b', url: 'https://example.com/mcp' }],
      [{ label: 'a', url: 'https://a.example.com/mcp' }, { label: 'A', url: 'https://b.example.com/mcp' }],
      Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, url: `https://s${i}.example.com/mcp` })),
    ]
    for (const grokRemoteMcp of bad) {
      expect(() => validateSessionConfigPatch({ grokRemoteMcp }, [])).toThrow()
    }
  })

  it('returns writableRoots that cannot be mutated through the input array', () => {
    const root = path.resolve('D:/workspace')
    const inputRoots = [root]

    const result = validateSessionConfigPatch({ writableRoots: inputRoots }, [root])
    inputRoots.push(path.resolve('D:/workspace/other'))

    expect(result.writableRoots).toEqual([root])
  })
})
