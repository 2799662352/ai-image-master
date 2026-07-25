// `serverRequest/resolved`：服务端告知某个待决请求已被它自己解决或清理。
//
// 上游 app-server README：「If the pending request is cleared by turn start, turn
// completion, or turn interruption before the client answers, the server emits the
// same notification for that cleanup.」我们绑定的 0.145.0 二进制里确实含这个字符串
// （在 resources/codex/win32-x64/codex.exe 里 grep 到），所以这条是活的。
//
// 忽略它的后果：pendingServerRequests 里的条目一直留到 approvalTimeoutMs，然后我们
// 对一个服务端早已丢弃的请求发响应；渲染层的 pendingApprovals 只在切换线程/新会话/
// 删除线程时清空（不在 turn 完成时），所以那张审批卡会一直挂着，用户点它也只是再发
// 一个会被拒的响应。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { CodexApprovalRequest } from '../../../types/agent'

interface Harness {
  url: string
  /** 客户端发回服务端的所有消息（用来断言「没有回响应」）。 */
  received: Array<Record<string, unknown>>
  push: (payload: Record<string, unknown>) => void
  close: () => Promise<void>
}

async function startFakeServer(): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0 })
  const received: Array<Record<string, unknown>> = []
  let socket: import('ws').WebSocket | undefined

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>
      received.push(msg)
      // initialize / 任何 RPC 一律立刻回一个空结果，免得客户端卡在握手上。
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      }
    })
  })

  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    push: (payload) => socket?.send(JSON.stringify(payload)),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve())
      }),
  }
}

describe('CodexProtocolClient serverRequest/resolved', () => {
  let harness: Harness | undefined
  let client: CodexProtocolClient | undefined

  afterEach(async () => {
    await client?.stop()
    client = undefined
    await harness?.close()
    harness = undefined
  })

  async function connect(onApprovalRequest: (r: CodexApprovalRequest) => void, onApprovalResolved: (r: { id: string }) => void) {
    harness = await startFakeServer()
    client = new CodexProtocolClient({
      url: harness.url,
      clientInfo: { name: 'test', version: '0' },
      approvalTimeoutMs: 60_000,
      onApprovalRequest,
      onApprovalResolved,
    })
    await client.start()
    return harness
  }

  it('清掉待决请求，且不向服务端回任何响应', async () => {
    const requests: CodexApprovalRequest[] = []
    const resolved: Array<{ id: string }> = []
    const h = await connect((r) => requests.push(r), (r) => resolved.push(r))

    h.push({ jsonrpc: '2.0', id: 77, method: 'item/fileChange/requestApproval', params: { threadId: 't1' } })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    const before = h.received.length
    h.push({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 77 } })
    await vi.waitFor(() => expect(resolved).toEqual([expect.objectContaining({ id: '77' })]))

    // 关键：服务端已经自己解决了，我们不能再回一个响应。
    expect(h.received.length).toBe(before)

    // 条目已清掉 —— 再回答它应当报「没有待决请求」而不是静默发出去。
    expect(() => client!.respondToServerRequest({ id: '77', decision: 'accept' } as never)).toThrow(/No pending/)
  })

  it('未知 requestId 不炸、不误清其他待决项', async () => {
    const requests: CodexApprovalRequest[] = []
    const resolved: Array<{ id: string }> = []
    const h = await connect((r) => requests.push(r), (r) => resolved.push(r))

    h.push({ jsonrpc: '2.0', id: 5, method: 'item/fileChange/requestApproval', params: { threadId: 't1' } })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    h.push({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 999 } })
    await new Promise((r) => setTimeout(r, 50))

    expect(resolved).toHaveLength(0)
    // 原来那条仍可正常回答。
    expect(() => client!.respondToServerRequest({ id: '5', decision: 'accept' } as never)).not.toThrow()
  })

  it('requestId 是字符串形态时同样认得', async () => {
    const requests: CodexApprovalRequest[] = []
    const resolved: Array<{ id: string }> = []
    const h = await connect((r) => requests.push(r), (r) => resolved.push(r))

    h.push({ jsonrpc: '2.0', id: 12, method: 'mcpServer/elicitation/request', params: { threadId: 't1' } })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    h.push({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 't1', requestId: '12' } })
    await vi.waitFor(() => expect(resolved).toHaveLength(1))
  })
})
