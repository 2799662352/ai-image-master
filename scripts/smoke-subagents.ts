// What does app-server actually emit when the model spawns a sub-agent?
//
// This matters because the multi-agent surface is ON by default at 0.145 — the
// stock developer prompt tells the model it is `/root` in a team and hands it
// `spawn_agent` / `followup_task` / `send_message` / `wait_agent` /
// `interrupt_agent` / `list_agents`. Our app additionally raises the ceiling
// (`-c agents.max_threads=8`). But our client routes notifications strictly by
// `(threadId, turnId)` into the queue registered by the `send()` that started
// the turn, so anything a CHILD thread emits matches no queue. Before designing
// an adaptation we need the ground truth this script collects:
//
//   1. Do child agents surface as separate `threadId`s on the same connection,
//      or as items inside the parent turn?
//   2. Which methods carry them, and do the payloads name the parent?
//   3. Would a client that only listens to the parent's `(threadId, turnId)`
//      see the child's work at all?
//
// Deliberately raw: it speaks JSON-RPC over the websocket itself instead of
// going through `CodexProtocolClient`, because the client is exactly the layer
// under investigation — routing through it would hide whatever it drops.
//
// Costs real tokens (two live turns on a cheap model). Usage:
//   $env:OPENAI_API_KEY = "<apiyi key>"
//   pnpm exec tsx scripts/smoke-subagents.ts
//   pnpm exec tsx scripts/smoke-subagents.ts --base-url https://... --model gpt-5.5

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { resolveCodexBinary } from '../src/main/agent/paths'

const SMOKE_TIMEOUT_MS = 240_000
const CONNECT_TIMEOUT_MS = 20_000
const TURN_TIMEOUT_MS = 180_000
const PORT = 4290

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const BASE_URL = arg('base-url', 'https://api.apiyi.com/v1')
const MODEL = arg('model', 'gpt-5.5')

/** Instruction written to force delegation rather than hope for it. */
const PROMPT = [
  'Use the spawn_agent tool right now to create exactly one sub-agent.',
  'Give that sub-agent this task: reply with the single word "pong".',
  'Then use wait_agent to wait for it, and tell me what it replied.',
  'Do not answer the task yourself and do not run any shell command.',
].join(' ')

interface Observation {
  method: string
  threadId?: string
  turnId?: string
  itemType?: string
  raw: string
}

function field(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function observe(method: string, params: Record<string, unknown>): Observation {
  const item = params.item
  const thread = params.thread
  return {
    method,
    threadId: field(params, 'threadId')
      ?? (typeof thread === 'object' && thread !== null
        ? field(thread as Record<string, unknown>, 'id')
        : undefined),
    turnId: field(params, 'turnId'),
    itemType: typeof item === 'object' && item !== null
      ? field(item as Record<string, unknown>, 'type')
      : undefined,
    raw: JSON.stringify(params).slice(0, 400),
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is required (this talks to a live pool)')

  const resourceRoot = process.env.CODEX_RESOURCE_ROOT?.trim()
    || path.join(path.resolve(__dirname, '..'), 'resources')
  const binary = resolveCodexBinary(resourceRoot)
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-subagent-smoke-'))

  // No MCP servers: a dead-port bridge wedges thread/turn start on rmcp
  // retries, which would look exactly like "the child never reported back".
  // `--no-agents` answers a question the release notes leave ambiguous: 0.145
  // calls multi-agent V2 "opt-in", but the stock developer prompt already
  // frames the model as `/root` in a team. Running app-server with NO `agents.*`
  // config tells us whether production is exposed by default or only because we
  // pass the concurrency flags.
  const withoutAgentsConfig = process.argv.includes('--no-agents')
  // `--v2` answers whether multi-agent V2 is usable on a non-OpenAI gateway.
  // V2 marks the task payload `.with_encrypted()`, which upstream #34833 (filed
  // against 0.145.0) reports the child cannot decode when parent and child sit
  // behind an OpenAI-compatible gateway — the child sees an empty `Payload:`
  // and the parent can die on "Encrypted function output content could not be
  // decrypted". V2 additionally only offers spawn targets whose model catalog
  // self-declares v2. Both are claims worth testing against the actual pool
  // rather than inheriting.
  const v2 = process.argv.includes('--v2')
  const args = [
    'app-server', '--listen', `ws://127.0.0.1:${PORT}`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
    ...(v2 ? ['-c', 'features.multi_agent_v2=true'] : []),
    ...(withoutAgentsConfig ? [] : ['-c', 'agents.max_threads=2', '-c', 'agents.max_depth=1']),
    '-c', 'model_provider="probe"',
    '-c', 'model_providers.probe.name="probe"',
    '-c', `model_providers.probe.base_url="${BASE_URL}"`,
    '-c', 'model_providers.probe.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.probe.wire_api="responses"',
    '-c', `model="${MODEL}"`,
  ]

  let child: ChildProcess | undefined
  let socket: WebSocket | undefined
  const observations: Observation[] = []

  try {
    child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: apiKey },
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.log(`[codex] ${text.slice(0, 200)}`)
    })

    socket = await connect(`ws://127.0.0.1:${PORT}`)
    console.log('[smoke] connected\n')

    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()

    socket.on('message', (data) => {
      const text = String(data)
      let message: Record<string, unknown>
      try { message = JSON.parse(text) as Record<string, unknown> } catch { return }
      if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (!waiter) return
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
        return
      }
      if (typeof message.method === 'string') {
        const params = (message.params ?? {}) as Record<string, unknown>
        const seen = observe(message.method, params)
        observations.push(seen)
        console.log(`  ${seen.method}`
          + (seen.itemType ? `#${seen.itemType}` : '')
          + `  thread=${seen.threadId?.slice(0, 8) ?? '-'}`
          + `  turn=${seen.turnId?.slice(0, 8) ?? '-'}`)
      }
    })

    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket!.send(payload)
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`))
        }, TURN_TIMEOUT_MS).unref?.()
      })
    }

    await rpc('initialize', {
      clientInfo: { name: 'subagent-smoke', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))

    const started = await rpc('thread/start', { cwd: process.cwd() }) as { thread: { id: string } }
    const parentThreadId = started.thread.id
    console.log(`[smoke] parent thread ${parentThreadId}\n`)

    const turn = await rpc('turn/start', {
      threadId: parentThreadId,
      input: [{ type: 'text', text: PROMPT }],
      model: MODEL,
    }) as { turn: { id: string } }
    console.log(`[smoke] parent turn ${turn.turn.id}; streaming…\n`)

    await waitForTurnEnd(observations, parentThreadId)

    // ── verdict ─────────────────────────────────────────────────────────────
    const threads = new Set(observations.map((o) => o.threadId).filter(Boolean) as string[])
    const otherThreads = [...threads].filter((id) => id !== parentThreadId)
    const spawnItems = observations.filter((o) => o.itemType === 'collabAgentToolCall')
    const childEvents = observations.filter(
      (o) => o.threadId !== undefined && o.threadId !== parentThreadId,
    )

    console.log('\n[smoke] ── verdict ──')
    console.log(`[smoke] distinct threadIds seen: ${threads.size}`)
    console.log(`[smoke] parent: ${parentThreadId}`)
    console.log(`[smoke] non-parent threads: ${otherThreads.length ? otherThreads.join(', ') : 'NONE'}`)
    console.log(`[smoke] item types seen: ${[...new Set(observations.map((o) => o.itemType).filter(Boolean))].join(', ')}`)
    console.log(`[smoke] methods seen: ${[...new Set(observations.map((o) => o.method))].join(', ')}`)
    if (spawnItems.length > 0) {
      console.log('\n[smoke] collabAgentToolCall payloads (the parent-visible record of delegation):')
      for (const item of spawnItems) console.log(`  ${item.method}: ${item.raw}\n`)
    }
    // V2 replaces agent ids with a path namespace and reports spawns through
    // `subAgentActivity` instead of filling in `receiverThreadIds`, so dump it.
    const activity = observations.filter((o) => o.itemType === 'subAgentActivity')
    if (activity.length > 0) {
      console.log('\n[smoke] subAgentActivity payloads (V2 discovery hook):')
      for (const item of activity) console.log(`  ${item.raw}\n`)
    }

    // The words themselves settle the cross-provider encryption question: a
    // child that never received its task says so.
    const said = observations.filter(
      (o) => o.itemType === 'agentMessage' && o.method === 'item/completed',
    )
    if (said.length > 0) {
      console.log('[smoke] completed agentMessages (who said what):')
      for (const item of said) {
        const who = item.threadId === parentThreadId ? 'PARENT' : `child ${item.threadId?.slice(0, 8)}`
        console.log(`  ${who}: ${item.raw}\n`)
      }
    }

    console.log(`[smoke] events carrying a NON-parent threadId: ${childEvents.length}`)
    for (const event of childEvents) {
      console.log(`  ${event.method}${event.itemType ? `#${event.itemType}` : ''}`
        + `  thread=${event.threadId}  turn=${event.turnId ?? '-'}`)
    }
    console.log(
      otherThreads.length > 0
        ? '\n[smoke] → child work arrives on ITS OWN threadId: a parent-only listener sees nothing.'
        : '\n[smoke] → everything stayed on the parent thread id.',
    )
  } finally {
    try { socket?.close() } catch { /* ignore */ }
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
    }
    await rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    const attempt = (): void => {
      const socket = new WebSocket(url)
      socket.once('open', () => resolve(socket))
      socket.once('error', () => {
        socket.terminate()
        if (Date.now() > deadline) reject(new Error(`could not connect to ${url}`))
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

/** Resolves when the parent turn ends, or after the turn budget elapses. */
function waitForTurnEnd(observations: Observation[], parentThreadId: string): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    const poll = setInterval(() => {
      const done = observations.some(
        (o) => o.method === 'turn/completed' && o.threadId === parentThreadId,
      )
      if (done || Date.now() > deadline) {
        clearInterval(poll)
        resolve()
      }
    }, 500)
    poll.unref?.()
  })
}

const guard = setTimeout(() => {
  console.error('[smoke] FAIL: overall timeout')
  process.exit(1)
}, SMOKE_TIMEOUT_MS)
guard.unref?.()

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
