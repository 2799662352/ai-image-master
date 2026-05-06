import { describe, expect, it } from 'vitest'
import type { JsonRpcMessage } from '../types'

describe('CodexLocalBackend protocol shape', () => {
  it('uses JSON-RPC 2.0 messages', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { model: 'gpt-5.4' } }
    expect(msg.jsonrpc).toBe('2.0')
    expect(msg.method).toBe('thread/start')
  })
})
