// Offline smoke for the EXPERIMENTAL collaborationMode surface against the
// real bundled Codex binary. It verifies initialize gating, preset masks,
// Plan/Default settings confirmation (or exact compatibility fallback), and
// turn/start parsing.
//
// Safety invariant: this script cannot issue a real model request.
// - Every backend uses a fresh temporary CODEX_HOME and no OPENAI_API_KEY.
// - The valid thread generator is return()ed immediately after thread_created,
//   before its turn/start branch can execute.
// - The parse probe uses a distinct random UUID that cannot exist in that empty
//   home, so a binary that ignored the bogus mode could only fail thread lookup.
//
// Usage: pnpm exec tsx scripts/smoke-collaboration-mode.ts
// Worktree/CI: CODEX_RESOURCE_ROOT=<absolute-resources-path> pnpm exec tsx ...

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import type {
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
} from '../src/main/agent/codexProtocol'
import { resolveCodexBinary } from '../src/main/agent/paths'
import type { AgentStreamEvent } from '../src/types/agent'

type ThreadSettingsEvent = Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>
type SettingsMode = ThreadSettingsEvent['mode']
type SettingsProbeResult = 'confirmed' | 'fallback'
type TerminationSignal = 'SIGINT' | 'SIGTERM'

const SMOKE_TIMEOUT_MS = 90_000
const BACKEND_START_TIMEOUT_MS = 10_000
const STEP_TIMEOUT_MS = 15_000
const SETTINGS_TIMEOUT_MS = 10_000
const CLEANUP_DRAIN_TIMEOUT_MS = 15_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const activeBackends = new Set<CodexLocalBackend>()

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'smoke aborted')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const contenders: Array<Promise<T>> = [
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)),
        STEP_TIMEOUT_MS,
      )
    }),
  ]
  if (signal) {
    contenders.push(new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(signal))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }))
  }
  try {
    return await Promise.race(contenders)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function resolveAndValidateResourceRoot(): Promise<string> {
  const configured = process.env.CODEX_RESOURCE_ROOT?.trim()
  if (configured && !path.isAbsolute(configured)) {
    throw new Error(`CODEX_RESOURCE_ROOT must be absolute, got: ${configured}`)
  }
  const resourceRoot = configured || path.join(path.resolve(__dirname, '..'), 'resources')
  const binaryPath = resolveCodexBinary(resourceRoot)
  let binaryStat
  try {
    binaryStat = await stat(binaryPath)
  } catch (error) {
    throw new Error(`Codex binary not found at ${binaryPath}: ${errorMessage(error)}`)
  }
  if (!binaryStat.isFile()) throw new Error(`Codex binary path is not a file: ${binaryPath}`)
  console.log(`[smoke] ✅ Codex binary verified: ${binaryPath}`)
  return resourceRoot
}

async function removeTempHome(codexHome: string): Promise<void> {
  await rm(codexHome, { recursive: true, force: true })
  try {
    await stat(codexHome)
  } catch (error) {
    if (isNotFoundError(error)) {
      console.log(`[smoke] ✅ temporary CODEX_HOME removed: ${codexHome}`)
      return
    }
    throw error
  }
  throw new Error(`temporary CODEX_HOME still exists after cleanup: ${codexHome}`)
}

async function cleanupActiveBackends(): Promise<void> {
  await Promise.allSettled([...activeBackends].map((backend) => backend.stop()))
}

async function drainAfterFailure(workflow?: Promise<unknown>): Promise<boolean> {
  // Start stop/WS-close immediately, then wait only a bounded interval for both
  // cleanup and the retained workflow to settle. This is best-effort bounded
  // drain, not a hard process kill.
  const cleanup = cleanupActiveBackends()
  const workflowSettled = workflow?.then(
    () => undefined,
    () => undefined,
  ) ?? Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.allSettled([cleanup, workflowSettled]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), CLEANUP_DRAIN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function settingsResultText(result: SettingsProbeResult): string {
  return result === 'confirmed'
    ? 'Plan/Default settings verified'
    : 'thread/settings/update unavailable; next-turn compatibility fallback verified'
}

function exitCodeFor(signal?: TerminationSignal): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}

async function seedInertMcpTransports(codexHome: string): Promise<void> {
  // Production boot normally seeds these transports before Codex starts.
  // A fresh smoke home has no boot phase, while launch args still overlay
  // leaves on both tables. Seed only disabled transport shape—never auth.
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

async function withBackend<T>(
  options: {
    resourceRoot: string
    experimentalApi: boolean
    onThreadSettingsNotification?: (event: ThreadSettingsEvent) => void
  },
  signal: AbortSignal,
  run: (backend: CodexLocalBackend) => Promise<T>,
): Promise<T> {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'catimation-codex-smoke-'))
  let backend: CodexLocalBackend | undefined
  try {
    await seedInertMcpTransports(codexHome)
    throwIfAborted(signal)
    if (activeBackends.size !== 0) throw new Error('backend scopes must run serially')
    backend = new CodexLocalBackend({
      resourceRoot: options.resourceRoot,
      codexHome,
      connectTimeoutMs: BACKEND_START_TIMEOUT_MS,
      getApiKey: () => undefined,
      experimentalApi: options.experimentalApi,
      onThreadSettingsNotification: options.onThreadSettingsNotification,
    })
    activeBackends.add(backend)
    try {
      const startedAt = Date.now()
      // Do not race start() against abort: its own connectTimeoutMs bounds it.
      // If global timeout/signal arrives mid-start, await settlement first,
      // then throwIfAborted and finally stop the handles start just published.
      await backend.start()
      throwIfAborted(signal)
      console.log(
        `[smoke] ✅ initialize OK with experimentalApi=${options.experimentalApi} `
        + `(${Date.now() - startedAt}ms)`,
      )
      return await run(backend)
    } finally {
      try {
        await backend.stop()
      } finally {
        activeBackends.delete(backend)
      }
    }
  } finally {
    await removeTempHome(codexHome)
  }
}

function assertEmptyResponse(response: ThreadSettingsUpdateResponse, mode: SettingsMode): void {
  if (
    response === null
    || typeof response !== 'object'
    || Array.isArray(response)
    || Object.keys(response).length !== 0
  ) {
    throw new Error(`thread/settings/update ${mode} returned: ${JSON.stringify(response)}`)
  }
}

function assertCollaborationModePresets(result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('collaborationMode/list must return an object')
  }
  const data = (result as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('collaborationMode/list.data must be a non-empty array')
  }
  if (data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('collaborationMode/list.data contains a non-object preset')
  }
  const rows = data as Array<Record<string, unknown>>
  const plans = rows.filter((row) => row.name === 'Plan' || row.mode === 'plan')
  const defaults = rows.filter((row) => row.name === 'Default' || row.mode === 'default')
  if (plans.length !== 1) throw new Error(`expected exactly one Plan preset, got ${plans.length}`)
  if (defaults.length !== 1) {
    throw new Error(`expected exactly one Default preset, got ${defaults.length}`)
  }
  const planPreset = plans[0]
  if (
    planPreset.name !== 'Plan'
    || planPreset.mode !== 'plan'
    || planPreset.reasoning_effort !== 'medium'
    || planPreset.model !== null
  ) {
    throw new Error(`invalid Plan preset mask: ${JSON.stringify(planPreset)}`)
  }
  const defaultPreset = defaults[0]
  if (
    defaultPreset.name !== 'Default'
    || defaultPreset.mode !== 'default'
    || defaultPreset.reasoning_effort !== null
    || defaultPreset.model !== null
  ) {
    throw new Error(`invalid Default preset mask: ${JSON.stringify(defaultPreset)}`)
  }
}

interface PendingSettings {
  threadId: string
  mode: SettingsMode
  model: string
  effort: string | null
  timer: NodeJS.Timeout
  signal: AbortSignal
  onAbort: () => void
  resolve: (event: ThreadSettingsEvent) => void
  reject: (error: Error) => void
}

function createSettingsObserver(): {
  onNotification: (event: ThreadSettingsEvent) => void
  updateAndWait: (
    backend: CodexLocalBackend,
    params: ThreadSettingsUpdateParams,
    signal: AbortSignal,
  ) => Promise<ThreadSettingsEvent>
} {
  let pending: PendingSettings | undefined
  const clear = (request: PendingSettings): void => {
    if (pending === request) pending = undefined
    clearTimeout(request.timer)
    request.signal.removeEventListener('abort', request.onAbort)
  }
  return {
    onNotification(event) {
      const request = pending
      if (!request || event.threadId !== request.threadId || event.mode !== request.mode) return
      clear(request)
      if (event.model !== request.model || event.effort !== request.effort) {
        request.reject(new Error(
          `${event.mode} notification mismatch: expected model=${request.model}, `
          + `effort=${request.effort ?? 'null'}; got model=${event.model}, `
          + `effort=${event.effort ?? 'null'}`,
        ))
      } else {
        request.resolve(event)
      }
    },
    async updateAndWait(backend, params, signal) {
      throwIfAborted(signal)
      const mode = params.collaborationMode?.mode
      if (!mode) throw new Error('settings smoke requires an explicit collaboration mode')
      if (pending) throw new Error('another settings notification wait is active')
      const model = params.collaborationMode.settings.model
      const effort = params.collaborationMode.settings.reasoning_effort
      let request!: PendingSettings
      const notification = new Promise<ThreadSettingsEvent>((resolve, reject) => {
        const onAbort = () => {
          clear(request)
          reject(abortError(signal))
        }
        const timer = setTimeout(() => {
          clear(request)
          reject(new Error(
            `settings notification timed out for threadId=${params.threadId}, mode=${mode}`,
          ))
        }, SETTINGS_TIMEOUT_MS)
        request = {
          threadId: params.threadId,
          mode,
          model,
          effort,
          timer,
          signal,
          onAbort,
          resolve,
          reject,
        }
        pending = request
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try {
        const [response, event] = await Promise.all([
          backend.updateThreadSettings(params),
          notification,
        ])
        throwIfAborted(signal)
        assertEmptyResponse(response, mode)
        return event
      } finally {
        clear(request)
      }
    },
  }
}

function isSettingsCompatibilityError(error: unknown): boolean {
  const message = errorMessage(error)
  return (
    /\bmethod not found\b/i.test(message)
    || /\bunknown method\b/i.test(message)
    || /thread\/settings\/update[^\n]*(?:unsupported|not supported)/i.test(message)
    || /requires experimentalApi capability/i.test(message)
  )
}

function settingsParams(threadId: string, mode: SettingsMode): ThreadSettingsUpdateParams {
  return {
    threadId,
    collaborationMode: {
      mode,
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: mode === 'plan' ? 'medium' : null,
        developer_instructions: null,
      },
    },
  }
}

async function probeSettings(
  backend: CodexLocalBackend,
  observer: ReturnType<typeof createSettingsObserver>,
  threadId: string,
  signal: AbortSignal,
): Promise<SettingsProbeResult> {
  let planEvent: ThreadSettingsEvent
  try {
    planEvent = await observer.updateAndWait(backend, settingsParams(threadId, 'plan'), signal)
  } catch (error) {
    throwIfAborted(signal)
    if (!isSettingsCompatibilityError(error)) throw error
    console.log(
      `[smoke] ⚠️ thread/settings/update unavailable; `
      + `next-turn compatibility fallback verified ("${errorMessage(error)}")`,
    )
    return 'fallback'
  }
  console.log(
    `[smoke] ✅ thread/settings/update → Plan confirmed `
    + `(model=${planEvent.model}, effort=${planEvent.effort})`,
  )

  try {
    const defaultEvent = await observer.updateAndWait(
      backend,
      settingsParams(threadId, 'default'),
      signal,
    )
    console.log(
      `[smoke] ✅ thread/settings/update → Default confirmed `
      + `(model=${defaultEvent.model}, effort=${defaultEvent.effort ?? 'null'})`,
    )
  } catch (error) {
    throwIfAborted(signal)
    if (isSettingsCompatibilityError(error)) {
      throw new Error(
        `Default update failed after Plan confirmation; refusing fallback: ${errorMessage(error)}`,
      )
    }
    throw error
  }
  return 'confirmed'
}

async function createThreadWithoutTurn(
  backend: CodexLocalBackend,
  signal: AbortSignal,
): Promise<string> {
  const input = {
    model: 'gpt-5.5',
    cwd: process.cwd(),
    items: [{ type: 'text' as const, text: 'smoke: never sent to turn/start' }],
  }
  const iterator = backend.send(undefined, input as never)[Symbol.asyncIterator]()
  let threadId: string | undefined
  try {
    const first = await withTimeout(iterator.next(), 'thread/start no-turn setup', signal)
    throwIfAborted(signal)
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

async function probeTurnStartParsing(
  backend: CodexLocalBackend,
  liveThreadId: string,
  signal: AbortSignal,
): Promise<void> {
  let staleThreadId = randomUUID()
  while (staleThreadId === liveThreadId) staleThreadId = randomUUID()
  const input = {
    model: 'gpt-5.5',
    cwd: process.cwd(),
    items: [{ type: 'text' as const, text: 'smoke: stale thread cannot run this' }],
    collaborationMode: {
      mode: 'bogus',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
  }
  const iterator = backend.send(staleThreadId, input as never)[Symbol.asyncIterator]()
  try {
    await withTimeout(iterator.next(), 'stale-thread collaborationMode parse', signal)
    throw new Error('turn/start unexpectedly accepted bogus mode on a stale thread')
  } catch (error) {
    throwIfAborted(signal)
    const message = errorMessage(error)
    if (/unknown variant/i.test(message) && /bogus/i.test(message)) {
      console.log(`[smoke] ✅ turn/start rejected bogus collaborationMode: "${message.slice(0, 140)}"`)
      return
    }
    if (/unknown variant/i.test(message)) {
      throw new Error(`turn/start rejected an unrelated enum, not bogus mode: ${message}`)
    }
    if (/thread[^\n]*(?:not found|unknown)|(?:not found|unknown)[^\n]*thread/i.test(message)) {
      throw new Error(`collaborationMode may have been ignored; stale thread failed safely: ${message}`)
    }
    if (/unknown field.*collaborationMode/i.test(message)) {
      throw new Error(`binary does not know turn/start.collaborationMode: ${message}`)
    }
    throw error
  } finally {
    if (iterator.return) await iterator.return().catch(() => undefined)
  }
}

async function runExperimentalProbe(
  resourceRoot: string,
  signal: AbortSignal,
): Promise<SettingsProbeResult> {
  const observer = createSettingsObserver()
  return withBackend({
    resourceRoot,
    experimentalApi: true,
    onThreadSettingsNotification: observer.onNotification,
  }, signal, async (backend) => {
    let presets: unknown
    try {
      presets = await backend.listCollaborationModes()
    } catch (error) {
      throw new Error(`collaborationMode/list failed with capability: ${errorMessage(error)}`)
    }
    throwIfAborted(signal)
    assertCollaborationModePresets(presets)
    console.log(`[smoke] ✅ collaborationMode/list masks confirmed: ${JSON.stringify(presets)}`)

    const threadId = await createThreadWithoutTurn(backend, signal)
    const settingsResult = await probeSettings(backend, observer, threadId, signal)
    throwIfAborted(signal)
    await probeTurnStartParsing(backend, threadId, signal)
    return settingsResult
  })
}

async function runControlProbe(resourceRoot: string, signal: AbortSignal): Promise<void> {
  await withBackend({ resourceRoot, experimentalApi: false }, signal, async (backend) => {
    try {
      const result = await backend.listCollaborationModes()
      throw new Error(`list unexpectedly succeeded without capability: ${JSON.stringify(result)}`)
    } catch (error) {
      throwIfAborted(signal)
      const message = errorMessage(error)
      if (!/requires experimentalApi capability/i.test(message)) {
        throw new Error(`unexpected no-capability control error: ${message}`)
      }
      console.log(`[smoke] ✅ control rejected without capability: "${message}"`)
    }
  })
}

async function runWorkflow(
  resourceRoot: string,
  signal: AbortSignal,
): Promise<SettingsProbeResult> {
  // No catimation MCP: dead-port retries would mask this protocol-only smoke.
  const settingsResult = await runExperimentalProbe(resourceRoot, signal)
  throwIfAborted(signal)
  await runControlProbe(resourceRoot, signal)
  return settingsResult
}

async function main(): Promise<void> {
  const controller = new AbortController()
  let receivedSignal: TerminationSignal | undefined
  const abortFor = (name: TerminationSignal) => {
    receivedSignal ??= name
    if (!controller.signal.aborted) controller.abort(new Error(`smoke aborted by ${name}`))
  }
  const onSigint = () => abortFor('SIGINT')
  const onSigterm = () => abortFor('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  let timer: NodeJS.Timeout | undefined
  let onAbortWake: (() => void) | undefined
  let workflow: Promise<SettingsProbeResult> | undefined
  let settingsResult: SettingsProbeResult | undefined
  let failed = false
  let failure: unknown
  try {
    const resourceRoot = await resolveAndValidateResourceRoot()
    throwIfAborted(controller.signal)
    workflow = runWorkflow(resourceRoot, controller.signal)
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)
        controller.abort(error)
        reject(error)
      }, SMOKE_TIMEOUT_MS)
      timer.unref?.()
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbortWake = () => reject(abortError(controller.signal))
      if (controller.signal.aborted) onAbortWake()
      else controller.signal.addEventListener('abort', onAbortWake, { once: true })
    })
    settingsResult = await Promise.race([workflow, guard, aborted])
    throwIfAborted(controller.signal)
  } catch (error) {
    failed = true
    failure = error
    if (!controller.signal.aborted) controller.abort(error)
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbortWake) controller.signal.removeEventListener('abort', onAbortWake)
    if (failed) {
      const drained = await drainAfterFailure(workflow)
      if (!drained) {
        failure = new Error(
          `${errorMessage(failure)}; cleanup/workflow drain timed out after `
          + `${CLEANUP_DRAIN_TIMEOUT_MS}ms`,
        )
      }
    } else {
      await cleanupActiveBackends()
    }
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (failed) {
      console.error('\n[smoke] FAIL:', errorMessage(failure))
      process.exitCode = exitCodeFor(receivedSignal)
    } else {
      console.log(
        `\n[smoke] PASS — preset masks + no-turn thread + `
        + `${settingsResultText(settingsResult!)} + safe stale-thread parse `
        + `+ capability control verified.`,
      )
    }
  }
}

main().catch(async (error) => {
  console.error('[smoke] unexpected error:', error)
  const drained = await drainAfterFailure()
  if (!drained) {
    console.error(`[smoke] cleanup drain timed out after ${CLEANUP_DRAIN_TIMEOUT_MS}ms`)
  }
  process.exitCode = 1
})
