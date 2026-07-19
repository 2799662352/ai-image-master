// Offline smoke: does the BUNDLED codex binary speak app-server JSON-RPC over
// STDIO (JSONL on stdin/stdout) when launched WITHOUT `--listen`?
// This is the upstream-recommended stable transport; proving it works is the
// prerequisite for offering a WebSocket/stdio transport setting.
//
// Usage: pnpm exec tsx scripts/smoke-stdio-transport.ts

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { buildCodexLaunchArgs } from '../src/main/agent/codexLaunch'
import { resolveProviderChannel } from '../src/main/agent/gatewayModelRouting'
import { resolveCodexBinary } from '../src/main/agent/paths'

const SMOKE_TIMEOUT_MS = 45_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

async function runSmoke(): Promise<void> {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-stdio-'))
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
  // Production arg set, minus the WebSocket listener: strip `--listen <url>`
  // so app-server falls back to its default stdio transport.
  const args = buildCodexLaunchArgs({ provider: { ...standard, model: 'gpt-5.5' } })
  const listenIdx = args.indexOf('--listen')
  if (listenIdx >= 0) args.splice(listenIdx, 2)

  const bin = resolveCodexBinary(path.join(projectRoot, 'resources'))
  console.log(`[smoke] spawning ${bin} (stdio transport, no --listen)`)
  const proc = spawn(bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-smoke-offline' },
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.log(`[codex] ${text.slice(0, 300)}`)
  })

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  const rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`[codex stdout non-json] ${line.slice(0, 200)}`)
      return
    }
    if (typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message ?? 'rpc error'))
    else entry.resolve(message.result)
  })

  const rpc = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const exited = new Promise<never>((_, rejectExit) => {
    proc.once('exit', (code) => rejectExit(new Error(`codex exited early (code=${code})`)))
  })

  try {
    const init = await Promise.race([
      rpc('initialize', {
        clientInfo: { name: 'smoke-stdio', version: '0.0.0' },
        capabilities: null,
      }),
      exited,
    ]) as { userAgent?: string }
    console.log(`[smoke] ✅ initialize over STDIO OK (userAgent=${init?.userAgent ?? '?'})`)

    const thread = await Promise.race([
      rpc('thread/start', { model: 'gpt-5.5', cwd: projectRoot }),
      exited,
    ]) as { thread?: { id?: string } }
    if (!thread?.thread?.id) throw new Error('thread/start over stdio returned no thread id')
    console.log(`[smoke] ✅ thread/start over STDIO OK (${thread.thread.id})`)

    console.log('\n[smoke] PASS — bundled binary speaks app-server JSON-RPC over stdio with the production -c arg set.')
  } finally {
    rl.close()
    if (proc.exitCode === null) {
      proc.kill('SIGTERM')
      await new Promise((resolve) => {
        proc.once('exit', resolve)
        setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* dead */ } resolve(null) }, 2_000)
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
