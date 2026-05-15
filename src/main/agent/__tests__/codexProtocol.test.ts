import { describe, expect, it } from 'vitest'
import { isServerNotification, isServerRequest, type ServerMessage } from '../codexProtocol'

describe('codexProtocol type guards', () => {
  it('detects notifications (no id)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't', turn: { id: 'u' } } }
    expect(isServerNotification(msg)).toBe(true)
    expect(isServerRequest(msg)).toBe(false)
  })

  it('detects server requests (id + method)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', id: 17, method: 'applyPatchApproval', params: {} }
    expect(isServerRequest(msg)).toBe(true)
    expect(isServerNotification(msg)).toBe(false)
  })

  it('detects rpc responses (id + result/error, no method)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', id: 3, result: { ok: true } }
    expect(isServerNotification(msg)).toBe(false)
    expect(isServerRequest(msg)).toBe(false)
  })
})
