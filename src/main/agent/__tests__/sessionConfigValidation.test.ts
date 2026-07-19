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

  it('returns writableRoots that cannot be mutated through the input array', () => {
    const root = path.resolve('D:/workspace')
    const inputRoots = [root]

    const result = validateSessionConfigPatch({ writableRoots: inputRoots }, [root])
    inputRoots.push(path.resolve('D:/workspace/other'))

    expect(result.writableRoots).toEqual([root])
  })
})
