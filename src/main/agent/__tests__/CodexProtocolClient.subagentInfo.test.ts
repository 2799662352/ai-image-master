import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { CodexProtocolClient } from '../CodexProtocolClient'

/**
 * Multi-agent V2 announces a spawn with only a thread id and the agent
 * definition's path, so the delegation card would otherwise label its agents
 * `/root/pong_agent`. Upstream assigns each spawn a human nickname and exposes
 * it through `thread/read`, which is how the TUI's agent picker labels
 * children.
 *
 * Field shape measured against codex-cli 0.145.0 with
 * `scripts/smoke-subagents.ts --v2 --read-child`: the nickname is a top-level
 * camelCase `agentNickname`, mirrored in the snake_case spawn record under
 * `source.subAgent.thread_spawn`. The same probe showed what is NOT there —
 * no `model` field and no `userMessage` item carrying the assigned task — so
 * this deliberately fetches nothing but the identity fields.
 */

interface FakeServer {
  port: number
  received: Record<string, unknown>[]
  close: () => Promise<void>
}

async function startServer(threadPayload: unknown): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const received: Record<string, unknown>[] = []

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      received.push(msg)
      if (msg.id === undefined) return
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }))
        return
      }
      if (msg.method === 'thread/read') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: threadPayload }))
      }
    })
  })

  return {
    port: (wss.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

let server: FakeServer | undefined
let client: CodexProtocolClient | undefined

async function connect(): Promise<CodexProtocolClient> {
  const created = new CodexProtocolClient({ url: `ws://127.0.0.1:${server!.port}` })
  await created.start()
  client = created
  return created
}

afterEach(async () => {
  await client?.stop()
  client = undefined
  await server?.close()
  server = undefined
})

describe('CodexProtocolClient.readSubagentInfo', () => {
  it('reads the nickname upstream assigned to a spawned agent', async () => {
    server = await startServer({
      thread: {
        id: 'child-1',
        parentThreadId: 'parent-1',
        threadSource: 'subagent',
        agentNickname: 'Newton',
        agentRole: null,
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: 'parent-1', depth: 1, agent_path: '/root/pong_agent' },
          },
        },
      },
    })

    const info = await (await connect()).readSubagentInfo('child-1')

    expect(info).toEqual({ nickname: 'Newton' })
    expect(server.received.find((m) => m.method === 'thread/read')?.params)
      .toEqual({ threadId: 'child-1' })
  })

  it('falls back to the snake_case spawn record when the top-level field is absent', async () => {
    server = await startServer({
      thread: {
        id: 'child-1',
        threadSource: 'subagent',
        source: { subAgent: { thread_spawn: { depth: 2, agent_nickname: 'Maxwell' } } },
      },
    })

    expect(await (await connect()).readSubagentInfo('child-1')).toEqual({ nickname: 'Maxwell' })
  })

  it('returns null for a thread that carries no sub-agent identity', async () => {
    server = await startServer({ thread: { id: 'plain-1', title: 'A normal session' } })

    expect(await (await connect()).readSubagentInfo('plain-1')).toBeNull()
  })
})
