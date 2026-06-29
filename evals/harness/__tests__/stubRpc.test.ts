import { describe, expect, it } from 'vitest'
// Importing the runtime ESM module the stub entry uses, so the test exercises
// the EXACT logic codex will hit over stdio.
import { handleRpc, PROTOCOL_VERSION_FALLBACK } from '../stub/stubRpc.mjs'

const toolset = [
  { name: 'ask_user', description: 'choice card', cannedResult: { selected: [{ id: 'mid' }] } },
  { name: 'broken_tool', cannedError: 'simulated failure' },
]

describe('handleRpc: initialize', () => {
  it('echoes the client protocolVersion and advertises tools capability', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, toolset)
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    })
    expect((res as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBeTruthy()
  })

  it('falls back to a default protocolVersion when the client omits it', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, toolset)
    expect((res as { result: { protocolVersion: string } }).result.protocolVersion).toBe(PROTOCOL_VERSION_FALLBACK)
  })
})

describe('handleRpc: notifications', () => {
  it('returns null for notifications/initialized (no id, no response)', () => {
    expect(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, toolset)).toBeNull()
  })

  it('returns null for any notification (request without an id)', () => {
    expect(handleRpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ask_user' } }, toolset)).toBeNull()
  })
})

describe('handleRpc: tools/list', () => {
  it('lists every tool, filling a default object inputSchema when omitted', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, toolset)
    const tools = (res as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result.tools
    expect(tools.map((t) => t.name)).toEqual(['ask_user', 'broken_tool'])
    expect(tools[0].inputSchema.type).toBe('object')
  })
})

describe('handleRpc: tools/call', () => {
  it('returns the canned result as JSON text content', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'q' } } }, toolset)
    const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
    expect(result.isError).toBeFalsy()
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text)).toEqual({ selected: [{ id: 'mid' }] })
  })

  it('returns an isError result (not a JSON-RPC error) when the tool has a cannedError', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'broken_tool', arguments: {} } }, toolset)
    const result = (res as { result: { content: Array<{ text: string }>; isError: boolean } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('simulated failure')
  })

  it('returns a JSON-RPC error for an unknown tool', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, toolset)
    expect((res as { error: { code: number } }).error.code).toBe(-32602)
  })

  it('defaults the canned result to {} when none is configured', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_user' } }, [{ name: 'ask_user' }])
    const result = (res as { result: { content: Array<{ text: string }> } }).result
    expect(JSON.parse(result.content[0].text)).toEqual({})
  })
})

describe('handleRpc: misc', () => {
  it('answers ping with an empty result', () => {
    expect(handleRpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, toolset)).toMatchObject({ id: 7, result: {} })
  })

  it('returns method-not-found for unknown methods', () => {
    const res = handleRpc({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, toolset)
    expect((res as { error: { code: number } }).error.code).toBe(-32601)
  })
})
