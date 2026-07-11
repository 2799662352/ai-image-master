import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { CodexLocalBackend } from '../CodexLocalBackend'
import type { AgentStreamEvent } from '../../../types/agent'
import type { ThreadSettingsUpdateParams } from '../codexProtocol'

type ThreadSettingsEvent = Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>

interface FakeServer {
  url: string
  received: Array<{ id?: number; method?: string; params?: unknown }>
  notifyThreadSettings: () => void
  close: () => Promise<void>
}

const UPDATE_PARAMS: ThreadSettingsUpdateParams = {
  threadId: 'codex-thread-1',
  collaborationMode: {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null,
    },
  },
}

function threadSettingsNotification(): {
  jsonrpc: '2.0'
  method: 'thread/settings/updated'
  params: Record<string, unknown>
} {
  return {
    jsonrpc: '2.0',
    method: 'thread/settings/updated',
    params: {
      threadId: 'codex-thread-1',
      threadSettings: {
        model: 'gpt-5.5',
        effort: 'high',
        collaborationMode: UPDATE_PARAMS.collaborationMode,
      },
    },
  }
}

async function startFakeServer(): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as AddressInfo).port
  const received: FakeServer['received'] = []
  let socket: WebSocket | null = null

  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as FakeServer['received'][number]
      received.push(message)
      if (message.method === 'initialize' && message.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            userAgent: 'fake',
            codexHome: '/tmp',
            platformFamily: 'unix',
            platformOs: 'linux',
          },
        }))
      } else if (message.method === 'thread/settings/update' && message.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    notifyThreadSettings() {
      socket?.send(JSON.stringify(threadSettingsNotification()))
    },
    async close() {
      try { socket?.close() } catch { /* already closed */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

function makeFakeSpawnedServer(args: string[]): {
  proc: EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    kill: (signal?: NodeJS.Signals) => boolean
  }
  notificationSent: Promise<void>
} {
  const listenUrl = new URL(args[args.indexOf('--listen') + 1])
  const wss = new WebSocketServer({ host: listenUrl.hostname, port: Number(listenUrl.port) })
  let resolveNotification!: () => void
  const notificationSent = new Promise<void>((resolve) => {
    resolveNotification = resolve
  })

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string }
      if (message.method !== 'initialize' || message.id === undefined) return
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          userAgent: 'fake',
          codexHome: '/tmp',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      }))
      setImmediate(() => {
        ws.send(JSON.stringify(threadSettingsNotification()))
        resolveNotification()
      })
    })
  })

  let exitCode: number | null = null
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    kill: (signal?: NodeJS.Signals) => boolean
  }
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  Object.defineProperty(proc, 'exitCode', { get: () => exitCode })
  proc.kill = () => {
    if (exitCode !== null) return false
    exitCode = 0
    try { wss.close() } catch { /* already closed */ }
    setImmediate(() => proc.emit('exit', 0, null))
    return true
  }
  return { proc, notificationSent }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}

describe('CodexLocalBackend collaboration mode', () => {
  let backend: CodexLocalBackend | null = null
  let server: FakeServer | null = null

  afterEach(async () => {
    if (backend) await backend.stop()
    if (server) await server.close()
    backend = null
    server = null
  })

  it('forwards updateThreadSettings to the started protocol client', async () => {
    server = await startFakeServer()
    backend = new CodexLocalBackend({ wsUrl: server.url, experimentalApi: true })
    await backend.start()

    await expect(backend.updateThreadSettings(UPDATE_PARAMS)).resolves.toEqual({})
    expect(server.received.find((message) => message.method === 'thread/settings/update')?.params)
      .toEqual(UPDATE_PARAMS)
  })

  it('throws a clear error when updateThreadSettings is called before start', async () => {
    backend = new CodexLocalBackend()
    await expect(backend.updateThreadSettings(UPDATE_PARAMS))
      .rejects.toThrow('CodexLocalBackend.updateThreadSettings called before start')
  })

  it('passes onThreadSettingsNotification through the ws client construction path', async () => {
    const onThreadSettingsNotification = vi.fn<(event: ThreadSettingsEvent) => void>()
    server = await startFakeServer()
    backend = new CodexLocalBackend({
      wsUrl: server.url,
      experimentalApi: true,
      onThreadSettingsNotification,
    })
    await backend.start()

    server.notifyThreadSettings()
    await waitFor(() => onThreadSettingsNotification.mock.calls.length === 1)

    expect(onThreadSettingsNotification).toHaveBeenCalledWith({
      type: 'thread_settings_updated',
      threadId: 'codex-thread-1',
      mode: 'plan',
      model: 'gpt-5.5',
      effort: 'high',
    })
  })

  it('passes onThreadSettingsNotification through the spawned client construction path', async () => {
    const onThreadSettingsNotification = vi.fn<(event: ThreadSettingsEvent) => void>()
    let notificationSent: Promise<void> | null = null
    backend = new CodexLocalBackend({
      resourceRoot: '/tmp/codex-fake-root',
      experimentalApi: true,
      onThreadSettingsNotification,
      connectTimeoutMs: 1_000,
      spawnFactory: ((_binary: string, args: string[]) => {
        const spawned = makeFakeSpawnedServer(args)
        notificationSent = spawned.notificationSent
        return spawned.proc
      }) as never,
    })

    await backend.start()
    await notificationSent
    await waitFor(() => onThreadSettingsNotification.mock.calls.length === 1)

    expect(onThreadSettingsNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'thread_settings_updated',
      threadId: 'codex-thread-1',
    }))
  })
})
