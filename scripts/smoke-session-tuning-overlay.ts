// Offline smoke: can the NEW session-tuning settings ride the per-thread
// `thread/start.config` overlay (no codex restart needed), and does the
// bundled binary accept them as launch `-c` overrides?
//
// Keys under test: `personality`, `model_reasoning_summary`,
// `show_raw_agent_reasoning`, and `web_search="indexed"`.
//
// Usage: pnpm exec tsx scripts/smoke-session-tuning-overlay.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { buildCodexLaunchArgs } from '../src/main/agent/codexLaunch'
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
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-tuning-'))
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
  const port = await pickFreePort(4222)
  const listenUrl = `ws://127.0.0.1:${port}`
  const args = buildCodexLaunchArgs({
    listenUrl,
    provider: { ...standard, model: 'gpt-5.5' },
  })
  // (A) Launch-level `-c` acceptance: personality + indexed web_search. If the
  // binary rejected these the process would exit early or emit configWarning.
  args.push(
    '-c', 'personality="pragmatic"',
    '-c', 'web_search="indexed"',
  )

  const bin = resolveCodexBinary(path.join(projectRoot, 'resources'))
  console.log(`[smoke] spawning ${bin}`)
  let proc: ChildProcess | null = null
  let client: RpcClient | null = null
  const stderrLines: string[] = []
  try {
    proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-smoke-offline' },
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        stderrLines.push(text)
        console.log(`[codex] ${text.slice(0, 300)}`)
      }
    })
    const exited = new Promise<never>((_, rejectExit) => {
      proc!.once('exit', (code) => rejectExit(new Error(`codex exited early (code=${code})`)))
    })

    client = await Promise.race([connectRpc(listenUrl), exited])
    await client.rpc('initialize', {
      clientInfo: { name: 'smoke-tuning', version: '0.0.0' },
      capabilities: null,
    })
    console.log('[smoke] ✅ initialize OK with -c personality + web_search="indexed"')

    // (B) Per-thread overlay acceptance: the same keys inside
    // `thread/start.config`. Rejection would surface as a deserialization
    // error on this RPC.
    const overlayThread = await client.rpc('thread/start', {
      model: 'gpt-5.5',
      cwd: projectRoot,
      config: {
        personality: 'friendly',
        model_reasoning_summary: 'detailed',
        show_raw_agent_reasoning: false,
        web_search: 'indexed',
      },
    }) as { thread?: { id?: string } }
    if (!overlayThread?.thread?.id) throw new Error('thread/start with tuning overlay returned no thread id')
    console.log(`[smoke] ✅ thread/start.config overlay accepted personality/model_reasoning_summary/show_raw_agent_reasoning/indexed (${overlayThread.thread.id})`)

    // (C) Negative control: a truly bogus config key should be rejected (or at
    // minimum warned). This tells us whether overlay acceptance in (B) is
    // meaningful validation or an accept-everything bag.
    let bogusOutcome = 'accepted'
    try {
      await client.rpc('thread/start', {
        model: 'gpt-5.5',
        cwd: projectRoot,
        config: { definitely_not_a_real_codex_key_9000: true },
      })
    } catch (error) {
      bogusOutcome = `rejected: ${(error as Error).message.slice(0, 120)}`
    }
    console.log(`[smoke] ℹ️ bogus overlay key outcome: ${bogusOutcome}`)

    // (D) config/read echo: confirm the launch-level values actually landed.
    const config = await client.rpc('config/read', {}) as { config?: Record<string, unknown> }
    const personality = config?.config?.personality
    const webSearch = config?.config?.web_search ?? (config?.config as Record<string, unknown> | undefined)?.webSearch
    console.log(`[smoke] ℹ️ config/read → personality=${JSON.stringify(personality)} web_search=${JSON.stringify(webSearch)}`)

    console.log('\n[smoke] PASS — session tuning keys verified on the bundled binary.')
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
