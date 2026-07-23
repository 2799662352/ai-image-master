// Offline smoke for the cross-session MEMORY surface against the real bundled
// Codex binary (0.145.x). Re-verifies the 0.142-era `features.memories=true`
// launch pin after the 0.145 upstream changes (flag promoted to Stable with
// default_enabled still false — PR #31804; artifact validation #32193/#32197;
// HTTP client factory #31362), and exercises the two `#[experimental]` memory
// RPCs whose method names were pinned from `client_request_definitions!` @
// codex-rs/app-server-protocol/src/protocol/common.rs rust-v0.145.0:
//
//   thread/memoryMode/set  { threadId, mode: "enabled"|"disabled" }  →  {}
//   memory/reset           params OMITTED (upstream `Option<()>`)    →  {}
//
// Safety invariant: this script cannot issue a real model request.
// - Fresh temporary CODEX_HOME, no OPENAI_API_KEY, no catimation MCP (a
//   dead-port MCP would wedge thread/turn start on rmcp retries).
// - The only thread is created no-turn: its send() iterator is closed right
//   after thread_created, before any turn/start can fire.
//
// Usage: pnpm exec tsx scripts/smoke-codex-memories.ts
// Worktree/CI: CODEX_RESOURCE_ROOT=<absolute-resources-path> pnpm exec tsx ...

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import { resolveCodexBinary } from '../src/main/agent/paths'

const SMOKE_TIMEOUT_MS = 90_000
const BACKEND_START_TIMEOUT_MS = 10_000
const STEP_TIMEOUT_MS = 15_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)),
          STEP_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveAndValidateResourceRoot(): Promise<string> {
  const configured = process.env.CODEX_RESOURCE_ROOT?.trim()
  if (configured && !path.isAbsolute(configured)) {
    throw new Error(`CODEX_RESOURCE_ROOT must be absolute, got: ${configured}`)
  }
  const resourceRoot = configured || path.join(path.resolve(__dirname, '..'), 'resources')
  const binaryPath = resolveCodexBinary(resourceRoot)
  const binaryStat = await stat(binaryPath).catch((error: unknown) => {
    throw new Error(`Codex binary not found at ${binaryPath}: ${errorMessage(error)}`)
  })
  if (!binaryStat.isFile()) throw new Error(`Codex binary path is not a file: ${binaryPath}`)
  console.log(`[smoke] ✅ Codex binary verified: ${binaryPath}`)
  return resourceRoot
}

async function seedInertMcpTransports(codexHome: string): Promise<void> {
  // Production boot normally seeds these transports before Codex starts. A
  // fresh smoke home has no boot phase, while launch args still overlay
  // leaves on both tables. Seed only disabled transport shape — never auth.
  const node = JSON.stringify(process.execPath)
  const config = [
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
  ].join('\n')
  await writeFile(path.join(codexHome, 'config.toml'), config, 'utf8')
}

async function createThreadWithoutTurn(backend: CodexLocalBackend): Promise<string> {
  const input = {
    model: 'gpt-5.5',
    cwd: process.cwd(),
    items: [{ type: 'text' as const, text: 'smoke: never sent to turn/start' }],
  }
  const iterator = backend.send(undefined, input as never)[Symbol.asyncIterator]()
  let threadId: string | undefined
  try {
    const first = await withTimeout(iterator.next(), 'thread/start no-turn setup')
    if (first.done || first.value.type !== 'thread_created' || !first.value.threadId) {
      throw new Error(`expected first event thread_created, got ${JSON.stringify(first)}`)
    }
    threadId = first.value.threadId
  } finally {
    if (iterator.return) await withTimeout(iterator.return(), 'closing no-turn iterator')
  }
  if (!threadId) throw new Error('thread/start completed without a thread id')
  console.log(`[smoke] ✅ thread/start created no-turn thread ${threadId}; iterator closed`)
  return threadId
}

function assertEmptyObject(value: unknown, label: string): void {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value as object).length !== 0
  ) {
    throw new Error(`${label} returned non-empty response: ${JSON.stringify(value)}`)
  }
}

async function probeMemoriesFeatureFlag(backend: CodexLocalBackend): Promise<void> {
  // Step 2: experimentalFeature/list — the feature key must be `memories`
  // (NOT the docs-implied `memory`) and enabled=true because production args
  // pin `-c features.memories=true`. 0.145 promoted it to Stable.
  const listed = await withTimeout(backend.experimentalFeatureList(), 'experimentalFeature/list')
  const row = listed.data.find((feature) => feature.name === 'memories')
  if (!row) {
    const names = listed.data.map((feature) => feature.name).join(', ')
    throw new Error(`feature key 'memories' missing from experimentalFeature/list — got [${names}]`)
  }
  if (!row.enabled) {
    throw new Error(`features.memories=true launch pin did NOT take effect: ${JSON.stringify(row)}`)
  }
  console.log(
    `[smoke] ✅ experimentalFeature/list → memories enabled=true `
    + `(stage=${row.stage}, defaultEnabled=${row.defaultEnabled})`,
  )
  if (row.stage !== 'stable') {
    console.warn(`[smoke] ⚠️ expected stage=stable on 0.145, got stage=${row.stage} (non-fatal)`)
  }
}

async function probeConfigRead(backend: CodexLocalBackend): Promise<void> {
  // Step 3: config/read — the resolved config must carry features.memories=true.
  const { config } = await withTimeout(backend.readConfig(), 'config/read')
  const features = config.features
  const memories = features && typeof features === 'object' && !Array.isArray(features)
    ? (features as Record<string, unknown>).memories
    : undefined
  if (memories !== true) {
    throw new Error(
      `config/read features.memories !== true — features=${JSON.stringify(features)}`,
    )
  }
  console.log(`[smoke] ✅ config/read → features.memories=true (${Object.keys(config).length} top-level keys)`)
}

async function probeMemoryRpcs(backend: CodexLocalBackend): Promise<void> {
  // Step 4: the two experimental memory RPCs, with minimal legal params.
  const threadId = await createThreadWithoutTurn(backend)

  const disabled = await withTimeout(
    backend.setThreadMemoryMode(threadId, 'disabled'),
    'thread/memoryMode/set disabled',
  )
  assertEmptyObject(disabled, 'thread/memoryMode/set disabled')
  const enabled = await withTimeout(
    backend.setThreadMemoryMode(threadId, 'enabled'),
    'thread/memoryMode/set enabled',
  )
  assertEmptyObject(enabled, 'thread/memoryMode/set enabled')
  console.log('[smoke] ✅ thread/memoryMode/set accepted disabled → enabled round-trip ({} responses)')

  const reset = await withTimeout(backend.resetMemory(), 'memory/reset')
  assertEmptyObject(reset, 'memory/reset')
  console.log('[smoke] ✅ memory/reset accepted with params omitted ({} response)')
}

async function runSmoke(): Promise<void> {
  const resourceRoot = await resolveAndValidateResourceRoot()
  const codexHome = await mkdtemp(path.join(tmpdir(), 'catimation-codex-memories-smoke-'))
  let backend: CodexLocalBackend | undefined
  try {
    await seedInertMcpTransports(codexHome)
    backend = new CodexLocalBackend({
      resourceRoot,
      codexHome,
      connectTimeoutMs: BACKEND_START_TIMEOUT_MS,
      getApiKey: () => undefined,
      // Both memory RPCs are `#[experimental]` — same gate production uses.
      experimentalApi: true,
    })
    const startedAt = Date.now()
    await backend.start()
    console.log(
      `[smoke] ✅ app-server spawned + initialize OK in ${Date.now() - startedAt}ms `
      + '(full prod -c args incl. features.memories=true accepted)',
    )

    await probeMemoriesFeatureFlag(backend)
    await probeConfigRead(backend)
    await probeMemoryRpcs(backend)
  } finally {
    await backend?.stop().catch(() => undefined)
    try {
      await rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      console.log(`[smoke] ✅ temporary CODEX_HOME removed: ${codexHome}`)
    } catch (error) {
      // Windows can briefly retain a plugin-clone handle after app-server
      // exits; the probe result is already decided, so defer to OS temp reap.
      console.warn(`[smoke] temp CODEX_HOME cleanup deferred (${errorMessage(error)}): ${codexHome}`)
    }
    console.log('[smoke] ✅ stopped cleanly')
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)),
      SMOKE_TIMEOUT_MS,
    )
    timer.unref?.()
  })
  try {
    await Promise.race([runSmoke(), guard])
    if (timer) clearTimeout(timer)
    console.log(
      '\n[smoke] PASS — 0.145 memories re-verified: features.memories launch pin + '
      + 'experimentalFeature/list + config/read + thread/memoryMode/set + memory/reset.',
    )
  } catch (error) {
    if (timer) clearTimeout(timer)
    console.error('\n[smoke] FAIL:', errorMessage(error))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[smoke] unexpected error:', error)
  process.exitCode = 1
})
