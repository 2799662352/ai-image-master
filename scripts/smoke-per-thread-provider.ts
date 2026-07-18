// Offline smoke for the per-thread provider routing rearchitecture (Plan B).
//
// Proves three protocol facts on the BUNDLED binary, no network/API key needed:
//   1. One `codex app-server` process accepts TWO registered provider tables
//      (active `rightcode-standard` + extra `rightcode-grok`).
//   2. `thread/start.modelProvider` routes a thread to the EXTRA provider —
//      and a bogus provider id is rejected, proving the field is honored.
//   3. `thread/start.config` accepts per-thread `model_context_window` /
//      `model_auto_compact_token_limit` overrides (thread-scoped pin).
//
// Usage: pnpm exec tsx scripts/smoke-per-thread-provider.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  appendExtraProviders,
  buildCodexLaunchArgs,
} from '../src/main/agent/codexLaunch'
import { resolveProviderChannel } from '../src/main/agent/gatewayModelRouting'
import { resolveCodexBinary } from '../src/main/agent/paths'
import { pickFreePort } from '../src/main/agent/ports'

const SMOKE_TIMEOUT_MS = 45_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

interface RpcClient {
  rpc: (method: string, params: unknown) => Promise<unknown>
  close: () => void
}

function connectRpc(url: string): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    let nextId = 1
    const started = Date.now()
    const tryOpen = (): void => {
      const ws = new WebSocket(url)
      ws.on('open', () => {
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as {
            id?: number
            result?: unknown
            error?: { message?: string }
          }
          if (typeof message.id !== 'number') return
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

async function runSmoke(): Promise<void> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-per-thread-'))
  // Launch args overlay leaves (enabled=false) onto these tables; without a
  // seeded transport shape codex rejects the entry as "invalid transport".
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

  const standard = resolveProviderChannel('rightcode-standard')
  const grok = resolveProviderChannel('rightcode-grok')
  const port = await pickFreePort(4222)
  const listenUrl = `ws://127.0.0.1:${port}`
  const args = buildCodexLaunchArgs({
    listenUrl,
    provider: { ...standard, model: 'gpt-5.5' },
  })
  appendExtraProviders(args, [grok])

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
      if (text) console.log(`[codex] ${text.slice(0, 300)}`)
    })
    const exited = new Promise<never>((_, rejectExit) => {
      proc!.once('exit', (code) => rejectExit(new Error(`codex exited early (code=${code})`)))
    })

    client = await Promise.race([connectRpc(listenUrl), exited])
    await client.rpc('initialize', {
      clientInfo: { name: 'smoke-per-thread', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    console.log('[smoke] ✅ initialize OK (two provider tables in one process)')

    // (2) thread on the EXTRA provider table + (3) per-thread context pin.
    const grokThread = await client.rpc('thread/start', {
      model: 'grok-4.5',
      modelProvider: 'rightcode-grok',
      cwd: projectRoot,
      config: {
        model_context_window: 500_000,
        model_auto_compact_token_limit: 450_000,
      },
    }) as { thread?: { id?: string } }
    if (!grokThread?.thread?.id) throw new Error('thread/start(grok) returned no thread id')
    console.log(`[smoke] ✅ thread/start on EXTRA provider rightcode-grok + per-thread pin OK (${grokThread.thread.id})`)

    // Active-provider thread coexists in the same process, unpinned.
    const gptThread = await client.rpc('thread/start', {
      model: 'gpt-5.5',
      modelProvider: 'rightcode-standard',
      cwd: projectRoot,
    }) as { thread?: { id?: string } }
    if (!gptThread?.thread?.id) throw new Error('thread/start(gpt) returned no thread id')
    console.log(`[smoke] ✅ thread/start on ACTIVE provider rightcode-standard OK (${gptThread.thread.id})`)

    // Negative control: an unregistered provider id must be rejected, proving
    // modelProvider is actually consulted rather than silently ignored.
    let bogusRejected = false
    try {
      await client.rpc('thread/start', {
        model: 'gpt-5.5',
        modelProvider: 'bogus-not-registered',
        cwd: projectRoot,
      })
    } catch (error) {
      bogusRejected = true
      console.log(`[smoke] ✅ bogus modelProvider rejected: "${(error as Error).message.slice(0, 120)}"`)
    }
    if (!bogusRejected) throw new Error('bogus modelProvider was NOT rejected — field ignored?')

    // Resume with the per-thread route shape production will use. A turnless
    // smoke thread has no rollout on disk, so "no rollout found" is the
    // EXPECTED terminal state — it fires AFTER param deserialization, proving
    // `modelProvider` + per-thread `config` are valid resume params. Any
    // other rejection (unknown field, bad enum) is a real failure.
    try {
      await client.rpc('thread/resume', {
        threadId: grokThread.thread.id,
        model: 'grok-4.5',
        modelProvider: 'rightcode-grok',
        config: {
          model_context_window: 500_000,
          model_auto_compact_token_limit: 450_000,
        },
      })
      console.log('[smoke] ✅ thread/resume with per-thread provider + pin OK')
    } catch (error) {
      const message = (error as Error).message
      if (!/no rollout found/i.test(message)) throw error
      console.log('[smoke] ✅ thread/resume params accepted (turnless thread has no rollout — expected)')
    }

    console.log('\n[smoke] PASS — per-thread provider routing protocol assumptions all hold.')
  } finally {
    client?.close()
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
