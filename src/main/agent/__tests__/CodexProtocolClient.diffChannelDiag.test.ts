import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

/**
 * 每一轮改过文件的 turn 结束时,打一行「三条 file-change 通知各响了几次」。
 *
 * 存在的理由是「零」这个值必须被**显式打印**。三条通道一次都没发,和我们压根
 * 没打这条日志,在日志文件里长得一模一样 —— 都是什么都没有。而这两种情况的处
 * 置完全相反:前者要去接新通道,后者要去查渲染层。上游 openai/codex#38695 报
 * 的正是前者(per-file 事件十天一次没发过,新版改发聚合的 turn/diff/updated),
 * 症状与我们要修的一致,所以这个区分必须能一眼看出来。
 */

interface FakeCodexServer {
  url: string
  notify: (method: string, params: Record<string, unknown>) => void
  close: () => Promise<void>
}

async function startFakeCodexServer(): Promise<FakeCodexServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  let activeSocket: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeSocket = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.id === undefined) return
      if (msg.method === 'initialize') {
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
    notify(method, params) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    },
    async close() {
      try { activeSocket?.close() } catch { /* ignore */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

describe('file-change 通道诊断', () => {
  let server: FakeCodexServer | null = null
  let client: CodexProtocolClient | null = null
  let lines: string[] = []

  afterEach(async () => {
    await client?.stop()
    client = null
    await server?.close()
    server = null
    lines = []
  })

  async function connect(): Promise<FakeCodexServer> {
    server = await startFakeCodexServer()
    client = new CodexProtocolClient({
      url: server.url,
      clientInfo: { name: 't', version: '0' },
      onLog: (line) => { lines.push(line) },
    })
    await client.start()
    return server
  }

  function diagLine(): string | undefined {
    return lines.find((l) => l.includes('[codex diag] file-change channels'))
  }

  it('数清每条通道的命中数', async () => {
    const s = await connect()

    s.notify('item/started', { threadId: 't', item: { id: 'fc-1', type: 'fileChange' } })
    s.notify('item/fileChange/patchUpdated', { threadId: 't', itemId: 'fc-1', changes: [] })
    s.notify('item/fileChange/patchUpdated', { threadId: 't', itemId: 'fc-1', changes: [] })
    s.notify('item/fileChange/outputDelta', { threadId: 't', itemId: 'fc-1', delta: 'x' })
    s.notify('turn/completed', { threadId: 't', turn: { id: 'turn-1' } })
    await settle()

    expect(diagLine()).toContain('patchUpdated=2 outputDelta=1 turnDiff=0')
  })

  /** 这条是整个诊断的目的:一条都没发时,必须看得见三个零。 */
  it('一条实时通道都没发时,依然打出全零', async () => {
    const s = await connect()

    s.notify('item/started', { threadId: 't', item: { id: 'fc-1', type: 'fileChange' } })
    s.notify('item/completed', {
      threadId: 't',
      item: { id: 'fc-1', type: 'fileChange', changes: [{ path: 'a.ts', kind: 'edit' }] },
    })
    s.notify('turn/completed', { threadId: 't', turn: { id: 'turn-1' } })
    await settle()

    expect(diagLine()).toContain('patchUpdated=0 outputDelta=0 turnDiff=0')
  })

  it('没动过文件的 turn 不打,免得每轮都是一行全零噪音', async () => {
    const s = await connect()

    s.notify('item/started', { threadId: 't', item: { id: 'msg-1', type: 'agentMessage' } })
    s.notify('turn/completed', { threadId: 't', turn: { id: 'turn-1' } })
    await settle()

    expect(diagLine()).toBeUndefined()
  })

  it('计数按 turn 归零,不跨轮累加', async () => {
    const s = await connect()

    s.notify('item/started', { threadId: 't', item: { id: 'fc-1', type: 'fileChange' } })
    s.notify('item/fileChange/patchUpdated', { threadId: 't', itemId: 'fc-1', changes: [] })
    s.notify('turn/completed', { threadId: 't', turn: { id: 'turn-1' } })
    await settle()

    s.notify('item/started', { threadId: 't', item: { id: 'fc-2', type: 'fileChange' } })
    s.notify('turn/completed', { threadId: 't', turn: { id: 'turn-2' } })
    await settle()

    const all = lines.filter((l) => l.includes('[codex diag] file-change channels'))
    expect(all).toHaveLength(2)
    expect(all[1]).toContain('patchUpdated=0 outputDelta=0 turnDiff=0')
  })

  /** turn/diff/updated 是 turn/ 开头又不是 turn/completed,原 trace 条件正好漏掉它。 */
  it('turn/diff/updated 的原始 params 会被 dump 一次', async () => {
    const s = await connect()

    s.notify('turn/diff/updated', { threadId: 't', turnId: 'turn-1', diff: '@@ -1 +1 @@\n+x\n' })
    await settle()

    const trace = lines.find((l) => l.startsWith('[codex trace] turn/diff/updated'))
    expect(trace).toBeTruthy()
    expect(trace).toContain('"diff"')
  })
})
