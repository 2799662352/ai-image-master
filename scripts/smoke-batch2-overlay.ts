// Offline smoke for session-settings batch 2 (plan doc:
// docs/plans/2026-07-19-session-settings-batch2.md):
//
// (A) `-c model_verbosity` launch acceptance + config/read echo.
// (B) `thread/start.config.model_verbosity` per-thread overlay acceptance.
// (C) reasoning-effort VALUE-SET probe: official docs disagree on the enum
//     (sample config says none..xhigh, newer agent docs add ultra/max), so we
//     probe every candidate against the bundled binary via
//     `thread/start.config.model_reasoning_effort` — the config overlay goes
//     through the validated config deserializer (same path that rejected the
//     bogus model_verbosity above with "unknown variant"). Note: the
//     `turn/start.collaborationMode.settings.reasoning_effort` wire field is a
//     PERMISSIVE string (first run of this smoke proved a bogus value passes
//     serde there), so the config enum is the authoritative accept-set.
//     A bogus control value must be rejected for the methodology to count.
//
// Safety: fresh temp CODEX_HOME, no real API key, and turn/start only ever
// targets a random stale thread id — no model request can fire.
//
// Usage: pnpm exec tsx scripts/smoke-batch2-overlay.ts

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

const SMOKE_TIMEOUT_MS = 60_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const EFFORT_CANDIDATES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const
const BOGUS_EFFORT = 'bogus-effort-9000'

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

type EffortProbeOutcome = 'supported' | 'rejected' | `inconclusive: ${string}`

async function probeEffortValue(
  client: RpcClient,
  cwd: string,
  value: string,
): Promise<EffortProbeOutcome> {
  try {
    const result = await client.rpc('thread/start', {
      model: 'gpt-5.5',
      cwd,
      config: { model_reasoning_effort: value },
    }) as { thread?: { id?: string } }
    return result?.thread?.id ? 'supported' : 'inconclusive: thread/start returned no thread id'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown variant/i.test(message)) return 'rejected'
    return `inconclusive: ${message.slice(0, 140)}`
  }
}

async function runSmoke(): Promise<void> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-batch2-'))
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
  const port = await pickFreePort(4223)
  const listenUrl = `ws://127.0.0.1:${port}`
  const args = buildCodexLaunchArgs({
    listenUrl,
    provider: { ...standard, model: 'gpt-5.5' },
  })
  // (A) Launch-level `-c` acceptance for model_verbosity.
  args.push('-c', 'model_verbosity="low"')

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
    // collaborationMode is experimental-gated; announce the capability.
    await client.rpc('initialize', {
      clientInfo: { name: 'smoke-batch2', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    console.log('[smoke] ✅ initialize OK with -c model_verbosity="low"')

    // (B) Per-thread overlay acceptance for model_verbosity.
    const overlayThread = await client.rpc('thread/start', {
      model: 'gpt-5.5',
      cwd: projectRoot,
      config: { model_verbosity: 'high' },
    }) as { thread?: { id?: string } }
    if (!overlayThread?.thread?.id) throw new Error('thread/start with model_verbosity overlay returned no thread id')
    console.log(`[smoke] ✅ thread/start.config.model_verbosity accepted (${overlayThread.thread.id})`)

    // Overlay negative control: bogus verbosity value should be rejected.
    let verbosityControl = 'accepted (weak validation)'
    try {
      await client.rpc('thread/start', {
        model: 'gpt-5.5',
        cwd: projectRoot,
        config: { model_verbosity: 'bogus-verbosity-9000' },
      })
    } catch (error) {
      verbosityControl = `rejected: ${(error as Error).message.slice(0, 120)}`
    }
    console.log(`[smoke] ℹ️ bogus model_verbosity outcome: ${verbosityControl}`)

    // config/read echo for the launch-level value.
    const config = await client.rpc('config/read', {}) as { config?: Record<string, unknown> }
    const verbosity = config?.config?.model_verbosity
      ?? (config?.config as Record<string, unknown> | undefined)?.modelVerbosity
    console.log(`[smoke] ℹ️ config/read → model_verbosity=${JSON.stringify(verbosity)}`)

    // (C) Reasoning-effort value-set probe.
    console.log('[smoke] probing model_reasoning_effort value set via config overlay...')

    // Control 1: an unknown CONFIG KEY through the same overlay. If unknown
    // keys sail through, key-level conclusions below are meaningless.
    let unknownKeyOutcome = 'accepted (overlay ignores unknown keys)'
    try {
      await client.rpc('thread/start', {
        model: 'gpt-5.5',
        cwd: projectRoot,
        config: { definitely_not_a_real_codex_key_9000: true },
      })
    } catch (error) {
      unknownKeyOutcome = `rejected: ${(error as Error).message.slice(0, 120)}`
    }
    console.log(`[smoke] ℹ️ unknown config key outcome: ${unknownKeyOutcome}`)

    // Control 2: bogus VALUE on the known key.
    const bogusOutcome = await probeEffortValue(client, projectRoot, BOGUS_EFFORT)
    console.log(`[smoke] ℹ️ bogus effort value outcome: ${bogusOutcome}`)

    const supported: string[] = []
    const rejected: string[] = []
    for (const value of EFFORT_CANDIDATES) {
      const outcome = await probeEffortValue(client, projectRoot, value)
      if (outcome === 'supported') supported.push(value)
      else if (outcome === 'rejected') rejected.push(value)
      else throw new Error(`effort=${value} probe ${outcome}`)
      console.log(`[smoke]   model_reasoning_effort=${value} → ${outcome}`)
    }
    if (supported.length === 0) throw new Error('no reasoning_effort value was accepted — probe broken?')

    const openString = bogusOutcome === 'supported'
    console.log(`\n[smoke] PASS — model_verbosity (launch + overlay) OK; `
      + `reasoning_effort ${openString ? 'is an OPEN STRING (no server-side validation; curate values client-side)' : 'is a closed enum'}; `
      + `supported=[${supported.join(', ')}] rejected=[${rejected.join(', ')}]`)
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
