// Offline smoke: can a LIVE (loaded) codex thread actually be re-bound to a
// different model provider? Reproduces the crossed-endpoint bug behind
// "端点/codex未配置模型grok-4.5" / "端点/grok未配置模型gpt-5.5".
//
// Upstream evidence (codex-rs app-server thread_processor.rs,
// resume_running_thread): when `thread/resume` targets an ALREADY LOADED
// thread and the model/modelProvider overrides mismatch the live config, the
// overrides are honored only if the thread has NO subscribers and is idle —
// otherwise codex logs "thread/resume overrides ignored for loaded thread"
// and rejoins with the OLD provider. Our connection auto-subscribes on
// thread/start, so the in-process Plan B switch (resume + overrides) is
// predicted to be a silent no-op on the provider.
//
// This smoke proves it against the BUNDLED binary with two local mock
// Responses endpoints (no network/API key needed), then measures the two
// candidate fixes:
//   A. thread/unsubscribe → thread/resume(overrides)  → turn routes to NEW?
//   B. thread/fork(model, modelProvider)              → turn routes to NEW?
//
// Usage: pnpm exec tsx scripts/smoke-live-thread-provider-switch.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  appendExtraProviders,
  appendProviderArgs,
  buildCodexLaunchArgs,
} from '../src/main/agent/codexLaunch'
import { resolveCodexBinary } from '../src/main/agent/paths'
import { pickFreePort } from '../src/main/agent/ports'

const SMOKE_TIMEOUT_MS = 120_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

interface MockHit {
  server: 'standard' | 'grok'
  path: string
  model: string | undefined
  at: number
}

const hits: MockHit[] = []

function startMockServer(label: MockHit['server']): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += String(chunk) })
      req.on('end', () => {
        let model: string | undefined
        try { model = (JSON.parse(body) as { model?: string }).model } catch { /* non-JSON */ }
        hits.push({ server: label, path: req.url ?? '', model, at: Date.now() })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock ${label} declines` } }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

interface RpcClient {
  rpc: (method: string, params: unknown) => Promise<unknown>
  notifications: Array<{ method: string; params: unknown }>
  close: () => void
}

function connectRpc(url: string): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const notifications: Array<{ method: string; params: unknown }> = []
    let nextId = 1
    const started = Date.now()
    const tryOpen = (): void => {
      const ws = new WebSocket(url)
      ws.on('open', () => {
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as {
            id?: number
            method?: string
            params?: unknown
            result?: unknown
            error?: { message?: string }
          }
          if (typeof message.id !== 'number') {
            if (message.method) notifications.push({ method: message.method, params: message.params })
            return
          }
          const entry = pending.get(message.id)
          if (!entry) return
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(message.error.message ?? 'rpc error'))
          else entry.resolve(message.result)
        })
        resolve({
          rpc: (method, params) => new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          }),
          notifications,
          close: () => { try { ws.close() } catch { /* ignore */ } },
        })
      })
      ws.on('error', () => {
        ws.terminate()
        if (Date.now() - started > 15_000) reject(new Error('ws connect timeout'))
        else setTimeout(tryOpen, 250)
      })
    }
    tryOpen()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Runs a turn and reports which mock endpoint(s) the chat request hit. */
async function probeTurn(
  client: RpcClient,
  threadId: string,
  model: string,
  label: string,
): Promise<Set<MockHit['server']>> {
  const notifCursor = client.notifications.length
  const hitCursor = hits.length
  await client.rpc('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hi' }],
    model,
  })
  const deadline = Date.now() + 20_000
  let terminal = false
  while (Date.now() < deadline && !terminal) {
    await sleep(200)
    for (const notif of client.notifications.slice(notifCursor)) {
      if (
        notif.method === 'turn/completed'
        || notif.method === 'turn/failed'
        || notif.method === 'error'
      ) {
        terminal = true
        break
      }
    }
  }
  // small grace so late retries are attributed to this probe, not the next
  await sleep(500)
  const seen = new Set<MockHit['server']>()
  for (const hit of hits.slice(hitCursor)) {
    // memories side-requests would also land here; the chat request is the
    // one carrying OUR model (mock declines everything with 400 anyway).
    if (hit.model === model || hit.model === undefined) seen.add(hit.server)
  }
  const detail = hits.slice(hitCursor)
    .map((h) => `${h.server}${h.path} model=${h.model ?? '?'}`)
    .join(' | ') || '(no upstream request)'
  console.log(`[probe] ${label}: terminal=${terminal} → ${detail}`)
  return seen
}

async function runSmoke(): Promise<void> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-live-switch-'))
  const node = JSON.stringify(process.execPath)
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      '[mcp_servers.apiyi]',
      `command = ${node}`,
      'args = ["-e", "process.exit(0)"]',
      'enabled = false',
      '',
      '[mcp_servers.cinematography_kb]',
      `command = ${node}`,
      'args = ["-e", "process.exit(0)"]',
      'enabled = false',
      '',
    ].join('\n'),
    'utf8',
  )

  const standard = await startMockServer('standard')
  const grok = await startMockServer('grok')

  const activeProvider = {
    id: 'mock-standard',
    name: 'Mock Standard',
    baseUrl: `http://127.0.0.1:${standard.port}/v1`,
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
  }
  const extraProvider = {
    id: 'mock-grok',
    name: 'Mock Grok',
    baseUrl: `http://127.0.0.1:${grok.port}/v1`,
    envKey: 'OPENAI_API_KEY',
  }

  const port = await pickFreePort(4222)
  const listenUrl = `ws://127.0.0.1:${port}`
  const args = buildCodexLaunchArgs({ listenUrl })
  appendProviderArgs(args, activeProvider)
  appendExtraProviders(args, [extraProvider])

  const bin = resolveCodexBinary(path.join(projectRoot, 'resources'))
  console.log(`[smoke] spawning ${bin}`)
  let proc: ChildProcess | null = null
  let client: RpcClient | null = null
  try {
    proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-smoke-offline' },
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.log(`[codex-stderr] ${text.slice(0, 600)}`)
    })
    const exited = new Promise<never>((_, rejectExit) => {
      proc!.once('exit', (code) => rejectExit(new Error(`codex exited early (code=${code})`)))
    })

    client = await Promise.race([connectRpc(listenUrl), exited])
    await client.rpc('initialize', {
      clientInfo: { name: 'smoke-live-switch', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    console.log('[smoke] initialize OK')

    const startResponse = await client.rpc('thread/start', {
      model: 'gpt-5.5',
      cwd: projectRoot,
    }) as { thread?: { id?: string } }
    const threadId = startResponse?.thread?.id
    if (!threadId) throw new Error('thread/start returned no thread id')
    console.log(`[smoke] thread started ${threadId} (active provider mock-standard)`)

    // Baseline: turn on the active provider must hit STANDARD.
    const baseline = await probeTurn(client, threadId, 'gpt-5.5', 'baseline gpt on active provider')
    if (!baseline.has('standard') || baseline.has('grok')) {
      throw new Error(`baseline turn expected standard only, saw: ${[...baseline].join(',')}`)
    }

    // ── Reproduction: LIVE thread resume with provider override ──────────────
    await client.rpc('thread/resume', {
      threadId,
      model: 'grok-4.5',
      modelProvider: 'mock-grok',
    })
    console.log('[smoke] thread/resume(live) with modelProvider=mock-grok returned OK')
    const afterResume = await probeTurn(client, threadId, 'grok-4.5', 'after live resume override')
    const resumeHonored = afterResume.has('grok') && !afterResume.has('standard')
    console.log(`[smoke] ${resumeHonored ? '✅' : '❌ BUG REPRODUCED'} live-resume override honored: ${resumeHonored} (hit: ${[...afterResume].join(',') || 'none'})`)

    // ── Candidate fix A: unsubscribe → resume(overrides) ─────────────────────
    let unsubscribeWorked: boolean | undefined
    try {
      await client.rpc('thread/unsubscribe', { threadId })
      await client.rpc('thread/resume', {
        threadId,
        model: 'grok-4.5',
        modelProvider: 'mock-grok',
      })
      const afterUnsub = await probeTurn(client, threadId, 'grok-4.5', 'after unsubscribe+resume')
      unsubscribeWorked = afterUnsub.has('grok') && !afterUnsub.has('standard')
      console.log(`[smoke] ${unsubscribeWorked ? '✅' : '❌'} unsubscribe+resume re-binds provider: ${unsubscribeWorked}`)
    } catch (error) {
      console.log(`[smoke] ⚠️ unsubscribe path unavailable: ${(error as Error).message.slice(0, 160)}`)
    }

    // ── Candidate fix B: fork with modelProvider ─────────────────────────────
    let forkWorked: boolean | undefined
    try {
      const forkResponse = await client.rpc('thread/fork', {
        threadId,
        model: 'grok-4.5',
        modelProvider: 'mock-grok',
      }) as { thread?: { id?: string } }
      const forkId = forkResponse?.thread?.id
      if (!forkId) throw new Error('thread/fork returned no thread id')
      const afterFork = await probeTurn(client, forkId, 'grok-4.5', 'forked thread on mock-grok')
      forkWorked = afterFork.has('grok') && !afterFork.has('standard')
      console.log(`[smoke] ${forkWorked ? '✅' : '❌'} fork(model, modelProvider) routes to new provider: ${forkWorked}`)
    } catch (error) {
      console.log(`[smoke] ⚠️ fork path failed: ${(error as Error).message.slice(0, 160)}`)
    }

    console.log('\n[smoke] SUMMARY')
    console.log(`  live resume override honored : ${resumeHonored}`)
    console.log(`  unsubscribe+resume works     : ${unsubscribeWorked ?? 'n/a'}`)
    console.log(`  fork with provider works     : ${forkWorked ?? 'n/a'}`)
  } finally {
    client?.close()
    standard.close()
    grok.close()
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM')
      await new Promise((resolve) => {
        proc!.once('exit', resolve)
        setTimeout(() => { try { proc!.kill('SIGKILL') } catch { /* dead */ } resolve(null) }, 2_000)
      })
    }
    try { rmSync(codexHome, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rejectGuard) => {
    timer = setTimeout(() => rejectGuard(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS)
  })
  try {
    await Promise.race([runSmoke(), guard])
    process.exit(0)
  } catch (error) {
    console.error('\n[smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

void main()
