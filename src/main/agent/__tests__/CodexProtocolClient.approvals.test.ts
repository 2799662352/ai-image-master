import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'
import type { CodexApprovalRequest } from '../../../types/agent'

interface FakeApprovalServer {
  url: string
  receivedFromClient: any[]
  sendRequest: (request: { id: number; method: string; params?: Record<string, unknown> }) => void
  close: () => Promise<void>
}

async function startFakeApprovalServer(): Promise<FakeApprovalServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  const received: any[] = []
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.method === 'initialize' && msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    receivedFromClient: received,
    sendRequest(request) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', ...request }))
    },
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

describe('CodexProtocolClient approvals', () => {
  let server: FakeApprovalServer | null = null
  let client: CodexProtocolClient | null = null

  afterEach(async () => {
    vi.useRealTimers()
    await client?.stop()
    client = null
    await server?.close()
    server = null
  })

  it('surfaces server requests and waits for an explicit decision before replying', async () => {
    const approvals: CodexApprovalRequest[] = []
    server = await startFakeApprovalServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'catimation-test', version: '0.0.0' },
      onApprovalRequest: (request) => approvals.push(request),
    })
    await client.start()

    server.sendRequest({
      id: 41,
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm test' },
    })
    await vi.waitFor(() => expect(approvals).toHaveLength(1))

    expect(approvals[0]).toMatchObject({
      id: '41',
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm test' },
    })
    expect(server.receivedFromClient.some((msg) => msg.id === 41 && msg.result !== undefined)).toBe(false)

    client.respondToServerRequest({ id: '41', approved: false, message: 'not now' })
    await vi.waitFor(() => {
      expect(server.receivedFromClient).toContainEqual({
        jsonrpc: '2.0',
        id: 41,
        result: { approved: false, message: 'not now' },
      })
    })
  })

  it('denies and cleans up pending requests when they expire', async () => {
    vi.useFakeTimers()
    server = await startFakeApprovalServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'catimation-test', version: '0.0.0' },
      approvalTimeoutMs: 50,
      onApprovalRequest: () => undefined,
    })
    await client.start()

    server.sendRequest({
      id: 42,
      method: 'request_permission',
      params: { reason: 'run command', command: 'npm test' },
    })

    await vi.advanceTimersByTimeAsync(50)
    await vi.waitFor(() => {
      expect(server.receivedFromClient).toContainEqual({
        jsonrpc: '2.0',
        id: 42,
        result: { approved: false, message: 'approval request timed out' },
      })
    })

    expect(() => client!.respondToServerRequest({ id: '42', approved: true })).toThrow(/No pending/)
  })

  it('uses the 0.144 MCP elicitation response envelope instead of approved:boolean', async () => {
    const approvals: CodexApprovalRequest[] = []
    server = await startFakeApprovalServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 'catimation-test', version: '0.0.0' },
      onApprovalRequest: (request) => approvals.push(request),
    })
    await client.start()

    server.sendRequest({
      id: 43,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'codex_apps',
        mode: 'url',
        message: 'Sign in to continue',
        url: 'https://example.com/auth',
        elicitationId: 'elicit-1',
      },
    })
    await vi.waitFor(() => expect(approvals).toHaveLength(1))

    client.respondToServerRequest({ id: '43', approved: true })

    await vi.waitFor(() => {
      expect(server.receivedFromClient).toContainEqual({
        jsonrpc: '2.0',
        id: 43,
        result: { action: 'accept', content: null, _meta: null },
      })
    })
  })

  describe('item/tool/requestUserInput (codex 内置 request_user_input)', () => {
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      isBlocking: true,
      questions: [
        {
          id: 'style',
          header: '风格',
          question: '要什么风格？',
          isOther: false,
          isSecret: false,
          options: [{ label: '写实', description: '' }],
        },
      ],
    }

    it('照原样把 questions 交给渲染层,应答按 { answers } 回包而不是 approved:boolean', async () => {
      const approvals: CodexApprovalRequest[] = []
      server = await startFakeApprovalServer()
      client = new CodexProtocolClient({
        url: server.url,
        clientInfo: { name: 'catimation-test', version: '0.0.0' },
        onApprovalRequest: (request) => approvals.push(request),
      })
      await client.start()

      server.sendRequest({ id: 44, method: 'item/tool/requestUserInput', params })
      await vi.waitFor(() => expect(approvals).toHaveLength(1))
      expect(approvals[0]).toMatchObject({
        id: '44',
        threadId: 'thread-1',
        method: 'item/tool/requestUserInput',
        params,
      })

      client.respondToServerRequest({
        id: '44',
        approved: true,
        answers: { style: { answers: ['写实'] } },
      })

      await vi.waitFor(() => {
        expect(server.receivedFromClient).toContainEqual({
          jsonrpc: '2.0',
          id: 44,
          result: { answers: { style: { answers: ['写实'] } } },
        })
      })
      // 绝不能夹带审批的字段 —— app-server 对多余字段不宽容。
      const reply = server.receivedFromClient.find((m) => m.id === 44 && m.result)
      expect(reply.result).not.toHaveProperty('approved')
    })

    it('超时用 userInputTimeoutMs(不是审批的 5 分钟),到点回空答案表', async () => {
      vi.useFakeTimers()
      server = await startFakeApprovalServer()
      client = new CodexProtocolClient({
        url: server.url,
        clientInfo: { name: 'catimation-test', version: '0.0.0' },
        approvalTimeoutMs: 50,
        userInputTimeoutMs: 500,
        onApprovalRequest: () => undefined,
      })
      await client.start()

      server.sendRequest({ id: 45, method: 'item/tool/requestUserInput', params })

      // 过了审批超时,提问必须还挂着。
      await vi.advanceTimersByTimeAsync(60)
      expect(server.receivedFromClient.some((m) => m.id === 45 && m.result !== undefined)).toBe(false)

      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => {
        expect(server.receivedFromClient).toContainEqual({
          jsonrpc: '2.0',
          id: 45,
          result: { answers: {} },
        })
      })
    })

    it('未带 answers 的应答(比如渲染层走了通用路径)也回合法的空答案表', async () => {
      const approvals: CodexApprovalRequest[] = []
      server = await startFakeApprovalServer()
      client = new CodexProtocolClient({
        url: server.url,
        clientInfo: { name: 'catimation-test', version: '0.0.0' },
        onApprovalRequest: (request) => approvals.push(request),
      })
      await client.start()
      server.sendRequest({ id: 46, method: 'item/tool/requestUserInput', params })
      await vi.waitFor(() => expect(approvals).toHaveLength(1))

      client.respondToServerRequest({ id: '46', approved: false, message: 'nope' })

      await vi.waitFor(() => {
        expect(server.receivedFromClient).toContainEqual({
          jsonrpc: '2.0',
          id: 46,
          result: { answers: {} },
        })
      })
    })
  })
})
