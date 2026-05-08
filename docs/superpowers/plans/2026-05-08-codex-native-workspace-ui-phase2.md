# Codex-Native Workspace UI — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Phase 1 (`docs/superpowers/plans/2026-05-08-codex-native-workspace-ui-phase1.md`) must be merged first. Phase 2 reuses `AgentReference`, `referencesFromTimelineItem`, `ReferenceChip`, `openReference`, `buildCodexLaunchArgs(options.sessionConfig)`, `appendProviderArgs`, `agent:get-session-status` IPC, and `CodexStatusPanel`.

**Goal:** Land Phase 2 of the spec (`docs/superpowers/specs/2026-05-08-codex-native-workspace-ui-design.md` §Codex Controls and Background Jobs):

1. **Recorded `codex exec --json` event fixture** (Task 1) — first, so all parsing is data-driven instead of guessed.
2. **Mutable session configuration with confirmation** — `agent:set-session-config` IPC with main-process validation, `writableRoots` containment, `dialog.showMessageBox` confirmation when transitioning into unsafe modes, and audit logging.
3. **`codex exec --json` background runner** — pipe stdout JSONL to event mapper, pipe stderr to a ring buffer, support cancel + timeout, emit `turn_completed` on success, route through the existing `agent:event` channel.
4. **MCP status panel with real data** — minimal, well-tested TOML reader for the parts of `~/.codex/config.toml` that list MCP servers.
5. **GitHub Actions workflow that opens an update PR** for the bundled Codex CLI — SHA-pinned actions, output-injection-safe scripts, optional GitHub App installation token, SHA-256 manifest verification.

**Out of scope for Phase 2 (defer to a later plan):**
- Subagent thread switching UI.
- Codex skills/plugins discovery surface.
- Image generation artifact viewer (beyond reusing the existing image viewer).
- Resume/fork/side-conversation affordances.
- Capabilities marketing panel (intentionally never implemented).
- Slash-command palette as a separate UI surface — its supported actions (`/status`, `/permissions`, `/mcp`, `/diff`) are reachable through the new panels and buttons added by this plan, so the palette is unnecessary.

**Tech Stack:** Electron, React 19, Zustand, TypeScript 5, Vitest, GitHub Actions, OpenAI Codex CLI 0.128+.

---

## Phase Scope and Out of Scope

### In Phase 2

- Real fixture file capturing `codex exec --json` output for two scenarios (`echo` round-trip, `npm run typecheck` round-trip).
- Tested `mapCodexExecJsonLine` derived from those fixtures.
- `CodexExecJobRunner` with stdout pipe, stderr ring buffer, abort/timeout, deterministic event emission, and explicit cleanup.
- `agent:set-session-config` IPC with: schema validation, `writableRoots` containment under known workspace roots, confirmation dialog when transitioning to unsafe modes, audit log entry, and a soft-restart of `CodexLocalBackend` that surfaces a clear "session restarted" event so the renderer state can resync.
- `agent:start-exec-job` IPC with: prompt length cap, `cwd` containment, sessionConfig validation reused from above, optional output-schema URI containment.
- `CodexMcpPanel` with real data sourced from a minimal TOML reader.
- GitHub Actions workflow `update-codex.yml` with all hardenings.
- Optional Phase 1 deferred items (re-run for command references via the workspace approval flow) when their dependencies are unblocked here.

### Out of Phase 2

- Anything covered by §Out of Scope in `phase2 — Goal` above.

---

## File Structure

### Fixtures and Probes

- `src/main/agent/__tests__/fixtures/codex-exec-echo.jsonl` (new)
- `src/main/agent/__tests__/fixtures/codex-exec-typecheck.jsonl` (new)
- `scripts/record-codex-exec-fixture.ts` (new) — one-shot capture script.
- `scripts/__tests__/record-codex-exec-fixture.test.ts` (new) — unit test for the redaction layer.

### Codex `exec --json` Pipeline

- `src/main/agent/codexExecJson.ts` (new)
- `src/main/agent/CodexExecJobRunner.ts` (new)
- `src/main/agent/__tests__/codexExecJson.test.ts` (new) — pure parser, fixture-driven.
- `src/main/agent/__tests__/CodexExecJobRunner.test.ts` (new) — uses an injected `spawnFactory` that replays fixture lines.

### Mutable Session

- `src/main/agent/AgentManager.ts` (modify) — add `setSessionConfig`, audit log, restart hook.
- `src/main/agent/sessionConfigValidation.ts` (new)
- `src/main/agent/ipc.ts` (modify) — add `agent:set-session-config`, `agent:start-exec-job`.
- `src/main/agent/__tests__/sessionConfigValidation.test.ts` (new)
- `src/main/agent/__tests__/AgentManager.setSessionConfig.test.ts` (new)
- `src/preload/index.ts` (modify) — expose `setSessionConfig` and `startExecJob`.
- `src/types/agent.ts` (modify) — extend `AgentSendMessagePayload` with `references` and `sessionConfig`, add `CodexExecJobPayload`.

### MCP Panel

- `src/main/agent/codexConfigToml.ts` (new) — minimal TOML reader scoped to MCP sections.
- `src/main/agent/__tests__/codexConfigToml.test.ts` (new)
- `src/main/agent/AgentManager.ts` (modify, second pass) — `getMcpSummary()` reads via `codexConfigToml`.
- `src/renderer/src/features/agent-chat/CodexMcpPanel.tsx` (new)
- `src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx` (new)
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (modify) — render `<CodexMcpPanel />` behind a collapsible header section.

### GitHub Workflow

- `scripts/check-codex-release.ts` (new)
- `scripts/update-codex-version.ts` (new)
- `scripts/__tests__/check-codex-release.test.ts` (new)
- `scripts/__tests__/update-codex-version.test.ts` (new)
- `package.json` (modify) — add `codex:check-latest`, `codex:update-version`.
- `.github/workflows/update-codex.yml` (new)
- `docs/codex-update-runbook.md` (new) — operator runbook (PAT vs GitHub App, rotating tokens, dry-run).

---

## Pre-Flight Reading

Before starting Task 1, the implementer **must read** these files to confirm assumptions:

- `src/main/agent/codexLaunch.ts` (after Phase 1 — `appendProviderArgs` exists, `DEFAULT_CODEX_SESSION_CONFIG` exists with safe `workspace-write` + `on-request` defaults).
- `src/main/agent/AgentManager.ts` (after Phase 1 — `getSessionStatus`, `setAllowedRoots`, and `sessionConfig` (mutable, scoped to `writableRoots` only) all exist; `sendMessage` uses `sessionConfig.writableRoots[0] ?? process.cwd()`. Phase 2 EXTENDS the mutability scope to sandbox / approval / web-search via `setSessionConfig`).
- `src/main/agent/CodexLocalBackend.ts` (after Phase 1 — `CodexLocalBackendOptions.sessionConfig: Partial<CodexSessionConfig>` exists; both `start()` and `testConnection()` thread it through `buildCodexLaunchArgs`).
- `src/main/file-explorer/fsIpc.ts` (after Phase 1 — `setFsAllowedRoots` and `assertContained` exist; Phase 2's `setSessionConfig` reuses the same containment helper).
- `src/main/file-explorer/protocolHandler.ts` (after Phase 1 — Sec-Fetch-Site rejection exists).
- `src/main/index.ts` (after Phase 1 — CSP `frame-src https:`).
- `src/types/agent.ts` (after Phase 1 — `CodexSessionConfig`, `CodexSessionStatus`, `CodexApprovalPolicy`, `CodexSandboxMode` defined; `AgentSendMessagePayload` does NOT yet have `references` — Phase 2 adds that AND deletes `payloadShape.test.ts`'s negative assertion in the same commit).
- A live `codex --version` from the bundled binary, so Task 1 records fixtures against the real surface.

If any of these no longer match (Phase 1 drifted, Codex CLI updated mid-plan), pause and reconcile before proceeding.

---

## Task 1: Record `codex exec --json` Fixtures (No Speculation)

**Goal:** Before any parser code is written, capture two real `codex exec --json` runs as JSONL fixtures. Every event mapping in Task 2 is asserted against these fixtures so we never invent a schema. Redact API key bytes before checking in.

**Files:**
- Create: `scripts/record-codex-exec-fixture.ts`
- Create: `scripts/__tests__/record-codex-exec-fixture.test.ts`
- Create: `src/main/agent/__tests__/fixtures/codex-exec-echo.jsonl`
- Create: `src/main/agent/__tests__/fixtures/codex-exec-typecheck.jsonl`

### Step 1: Implement the fixture recorder

Create `scripts/record-codex-exec-fixture.ts`:

```typescript
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const OPENAI_KEY_PATTERN = /sk-[A-Za-z0-9-_]{20,}/g
const APIYI_KEY_PATTERN = /api(yi)?-[A-Za-z0-9-_]{20,}/gi

export function redactSecrets(line: string): string {
  return line
    .replace(OPENAI_KEY_PATTERN, '<<REDACTED-OPENAI-KEY>>')
    .replace(APIYI_KEY_PATTERN, '<<REDACTED-APIYI-KEY>>')
}

interface RecordOptions {
  binary: string
  prompt: string
  cwd: string
  outFile: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval?: 'on-request' | 'on-failure' | 'never' | 'untrusted'
}

export async function recordFixture(options: RecordOptions): Promise<void> {
  const args = [
    'exec',
    '--json',
    '--cd', options.cwd,
    '--sandbox', options.sandbox ?? 'read-only',
    '--ask-for-approval', options.approval ?? 'on-request',
    options.prompt,
  ]
  const proc = spawn(options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  for await (const chunk of proc.stdout) {
    const text = chunk.toString('utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) lines.push(redactSecrets(trimmed))
    }
  }
  await new Promise<void>((resolve, reject) => {
    proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`codex exec exited ${code}`))))
    proc.once('error', reject)
  })
  await fs.writeFile(options.outFile, `${lines.join('\n')}\n`, 'utf8')
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [binary, prompt, cwd, outFile] = process.argv.slice(2)
  if (!binary || !prompt || !cwd || !outFile) {
    console.error('Usage: tsx scripts/record-codex-exec-fixture.ts <binary> <prompt> <cwd> <outFile>')
    process.exit(2)
  }
  recordFixture({ binary, prompt, cwd, outFile }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
```

### Step 2: Cover the redaction layer with a unit test

Create `scripts/__tests__/record-codex-exec-fixture.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../record-codex-exec-fixture'

describe('redactSecrets', () => {
  it('redacts OpenAI keys', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz')).toBe(
      'OPENAI_API_KEY=<<REDACTED-OPENAI-KEY>>',
    )
  })

  it('redacts apiyi keys regardless of case', () => {
    expect(redactSecrets('Bearer apiyi-ABCDEFG1234567890XYZQRSTUVWXY')).toBe(
      'Bearer <<REDACTED-APIYI-KEY>>',
    )
  })

  it('leaves normal text untouched', () => {
    expect(redactSecrets('hello "world"')).toBe('hello "world"')
  })
})
```

Run: `npm run test:run -- scripts/__tests__/record-codex-exec-fixture.test.ts`

Expected: PASS.

### Step 3: Capture two fixtures from the bundled binary

Resolve the on-disk binary path the same way `CodexLocalBackend.start()` does:

```typescript
import { app } from 'electron' // not used here — see below
```

Because Electron is not available outside the app, run this script via `tsx` against the binary that `npm run codex:fetch` already vendored. Example commands (Windows; adjust extension on macOS/Linux):

```bash
$bin = "$PWD\resources\codex\win32-x64\codex.exe"
$cwd = "$PWD"

# Echo round-trip
npx tsx scripts/record-codex-exec-fixture.ts `
  $bin "Reply with the literal word: ok" $cwd `
  src/main/agent/__tests__/fixtures/codex-exec-echo.jsonl

# Typecheck round-trip
npx tsx scripts/record-codex-exec-fixture.ts `
  $bin "Run npm run typecheck and summarise the result" $cwd `
  src/main/agent/__tests__/fixtures/codex-exec-typecheck.jsonl
```

Expected: each fixture file contains valid JSONL events. The exact event shape is whatever Codex emits — that becomes the source of truth for Task 2.

If the bundled binary is unavailable in the worktree, run `npm run codex:fetch` first. If `codex exec` requires an API key, set `OPENAI_API_KEY` in the shell session **only**; do not commit the key.

### Step 4: Sanity-check the fixtures

Open each fixture file and confirm:

- Every line is valid JSON (`jq -e . < fixture.jsonl` returns 0).
- No line contains a secret pattern (`rg 'sk-[A-Za-z0-9-_]{20,}' fixture.jsonl` returns nothing).
- The echo fixture contains at least one `agent_message`-like event whose payload includes the literal word `ok`.

If any line fails these checks, re-record with stricter prompts and tighter redaction patterns.

### Step 5: Commit Task 1

Commit message: `chore: record codex exec --json fixtures`

---

## Task 2: Implement `mapCodexExecJsonLine` Driven by Real Fixtures

**Goal:** Map every distinct event type that appears in the recorded fixtures to an `AgentStreamEvent`. Anything not in the fixtures is **not implemented** in Phase 2 — the Codex surface evolves and a future plan can extend this once a new fixture pins the new event.

**Files:**
- Create: `src/main/agent/codexExecJson.ts`
- Create: `src/main/agent/__tests__/codexExecJson.test.ts`

### Step 1: Inventory every event in the fixtures

Run a quick survey:

```bash
for f in src/main/agent/__tests__/fixtures/codex-exec-*.jsonl; do
  echo "--- $f ---"
  jq -r '.type' "$f" | sort -u
done
```

Record the unique `type` values you observe. Treat them as the authoritative event surface for this plan. Common values you should expect (subject to the recorded fixture — if Codex differs, follow Codex):

- Lifecycle: `task_started`, `task_complete` (or `turn.completed`).
- Content: `agent_message_delta`, `agent_message`, `agent_reasoning_delta`, `agent_reasoning`.
- Commands: `exec_command_begin`, `exec_command_output_delta`, `exec_command_end`.
- Errors: `error`, `stream_error`.
- Token usage: `token_count`.

### Step 2: Write fixture-replay tests

Create `src/main/agent/__tests__/codexExecJson.test.ts`:

```typescript
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapCodexExecJsonLine } from '../codexExecJson'

const ROOT = path.join(__dirname, 'fixtures')
const echoLines = readFileSync(path.join(ROOT, 'codex-exec-echo.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

const THREAD_ID = 'job_thread_1'

describe('mapCodexExecJsonLine — echo fixture', () => {
  it('produces no parser exception for any fixture line', () => {
    for (const line of echoLines) {
      expect(() => mapCodexExecJsonLine(line, THREAD_ID)).not.toThrow()
    }
  })

  it('emits at least one text event whose content includes "ok"', () => {
    const events = echoLines
      .map((line) => mapCodexExecJsonLine(line, THREAD_ID))
      .filter((event): event is NonNullable<typeof event> => event != null)
    const textEvent = events.find((event) =>
      event.type === 'item_completed' && event.itemType === 'text' && JSON.stringify(event.final ?? {}).includes('ok'),
    )
    expect(textEvent, `text event found among: ${events.map((event) => event.type).join(', ')}`).toBeTruthy()
  })

  it('emits exactly one turn-completion event', () => {
    const completions = echoLines
      .map((line) => mapCodexExecJsonLine(line, THREAD_ID))
      .filter((event): event is NonNullable<typeof event> => event?.type === 'turn_completed')
    expect(completions).toHaveLength(1)
  })

  it('returns null for malformed JSON', () => {
    expect(mapCodexExecJsonLine('{not json', THREAD_ID)).toBeNull()
  })

  it('returns null for events not yet supported, instead of throwing', () => {
    expect(mapCodexExecJsonLine(JSON.stringify({ type: 'future_event_type' }), THREAD_ID)).toBeNull()
  })
})
```

If the survey in Step 1 shows command-execution events present (because the typecheck fixture exercises `exec_command_*`), add an analogous test block against `codex-exec-typecheck.jsonl` asserting that:

- `exec_command_begin` produces an `item_started` event with `itemType: 'shell'`.
- `exec_command_output_delta` produces an `item_delta` event with `patch.kind === 'appendText'`.
- `exec_command_end` produces an `item_completed` event whose `final` includes `exitCode`.

### Step 3: Run failing tests

Run: `npm run test:run -- src/main/agent/__tests__/codexExecJson.test.ts`

Expected: FAIL because `codexExecJson.ts` does not exist.

### Step 4: Implement the parser

Create `src/main/agent/codexExecJson.ts`. Implement only the event types your survey produced. Use the structure below as a template, but **rename event keys to match the fixture exactly**:

```typescript
import type { AgentStreamEvent } from '../../types/agent'

interface RawExecEvent {
  type?: unknown
  // Add fields you observed in the fixtures here. Keep this interface narrow.
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export const FIXTURE_LINE_BYTE_LIMIT = 1_000_000 // 1 MB; reject pathological lines

export function mapCodexExecJsonLine(line: string, threadId: string): AgentStreamEvent | null {
  if (line.length > FIXTURE_LINE_BYTE_LIMIT) return null

  let parsed: RawExecEvent
  try {
    parsed = JSON.parse(line) as RawExecEvent
  } catch {
    return null
  }

  const type = isString(parsed.type) ? parsed.type : null
  if (!type) return null

  // === Replace the placeholders below with the real Codex event names you
  // observed in your fixtures. ===

  if (type === 'task_complete' /* or 'turn.completed' depending on fixture */) {
    return { type: 'turn_completed', threadId }
  }

  if (type === 'agent_message' /* or whichever final-text event */) {
    // Extract item id and final text from the fixture shape.
    // Return:
    //   { type: 'item_completed', threadId, itemId, itemType: 'text', final: { content } }
  }

  if (type === 'exec_command_begin') {
    // Return:
    //   { type: 'item_started', threadId, itemId, itemType: 'shell', payload: { command, cwd } }
  }

  if (type === 'exec_command_output_delta') {
    // Return:
    //   { type: 'item_delta', threadId, itemId, itemType: 'shell',
    //     patch: { kind: 'appendText', field: 'stdout' | 'stderr', text } }
  }

  if (type === 'exec_command_end') {
    // Return:
    //   { type: 'item_completed', threadId, itemId, itemType: 'shell', final: { exitCode } }
  }

  return null
}
```

The **only** rule is: every branch must be exercised by a fixture-backed test in Step 2. Branches that are not covered must not be added.

### Step 5: Run tests + typecheck

Run:

```bash
npm run test:run -- src/main/agent/__tests__/codexExecJson.test.ts
npm run typecheck
```

Expected: PASS.

### Step 6: Commit Task 2

Commit message: `feat: parse codex exec --json events from recorded fixtures`

---

## Task 3: Implement `CodexExecJobRunner` with Cancel + Stderr + Timeout

**Goal:** A reliable background-job runner. Spawns `codex exec --json`, pipes stdout through `mapCodexExecJsonLine`, captures stderr in a ring buffer, supports cancel via `AbortController`, supports timeout, and emits a final `turn_completed` (on success) or `error` (on failure) event so renderer state machines can rely on a single completion contract.

**Files:**
- Create: `src/main/agent/CodexExecJobRunner.ts`
- Create: `src/main/agent/__tests__/CodexExecJobRunner.test.ts`

### Step 1: Write failing runner tests

Create `src/main/agent/__tests__/CodexExecJobRunner.test.ts`:

```typescript
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../types/agent'
import { CodexExecJobRunner } from '../CodexExecJobRunner'

function makeProc(stdoutLines: string[], opts: { exitCode?: number; stderr?: string } = {}) {
  const stdout = Readable.from((async function* () {
    for (const line of stdoutLines) yield `${line}\n`
  })())
  const stderr = Readable.from((async function* () {
    if (opts.stderr) yield opts.stderr
  })())
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void }
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = vi.fn()
  setTimeout(() => proc.emit('exit', opts.exitCode ?? 0, null), 5)
  return proc
}

describe('CodexExecJobRunner', () => {
  it('emits turn_completed on a clean exit', async () => {
    const events: AgentStreamEvent[] = []
    const runner = new CodexExecJobRunner({
      binary: '/fake/codex',
      sessionConfig: { sandboxMode: 'read-only', approvalPolicy: 'on-request', webSearch: false, writableRoots: [] },
      spawnFactory: () => makeProc([JSON.stringify({ type: 'task_complete' })]) as never,
    })
    const job = runner.run('hi', '/cwd', (event) => events.push(event))
    await job.done
    expect(events.at(-1)).toEqual({ type: 'turn_completed', threadId: job.jobId })
  })

  it('emits error and forwards stderr tail when codex exits non-zero', async () => {
    const events: AgentStreamEvent[] = []
    const runner = new CodexExecJobRunner({
      binary: '/fake/codex',
      sessionConfig: { sandboxMode: 'read-only', approvalPolicy: 'on-request', webSearch: false, writableRoots: [] },
      spawnFactory: () => makeProc([], { exitCode: 42, stderr: 'permission denied' }) as never,
    })
    const job = runner.run('hi', '/cwd', (event) => events.push(event))
    await job.done
    const error = events.at(-1)
    expect(error?.type).toBe('error')
    expect((error as { error: string }).error).toMatch(/permission denied/)
  })

  it('kills the process on cancel and emits a single error event', async () => {
    const events: AgentStreamEvent[] = []
    const proc = makeProc([], { exitCode: null as unknown as number })
    const runner = new CodexExecJobRunner({
      binary: '/fake/codex',
      sessionConfig: { sandboxMode: 'read-only', approvalPolicy: 'on-request', webSearch: false, writableRoots: [] },
      spawnFactory: () => proc as never,
    })
    const job = runner.run('hi', '/cwd', (event) => events.push(event))
    job.cancel()
    expect(proc.kill).toHaveBeenCalledTimes(1)
    setTimeout(() => proc.emit('exit', null, 'SIGTERM'), 5)
    await job.done
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
  })

  it('honours timeout and emits a single timeout error', async () => {
    const events: AgentStreamEvent[] = []
    const proc = makeProc([])
    const runner = new CodexExecJobRunner({
      binary: '/fake/codex',
      sessionConfig: { sandboxMode: 'read-only', approvalPolicy: 'on-request', webSearch: false, writableRoots: [] },
      spawnFactory: () => proc as never,
      timeoutMs: 1,
    })
    const job = runner.run('hi', '/cwd', (event) => events.push(event))
    setTimeout(() => proc.emit('exit', null, 'SIGTERM'), 10)
    await job.done
    expect(events.some((event) => event.type === 'error' && /timeout/i.test((event as { error: string }).error))).toBe(true)
  })
})
```

### Step 2: Run failing runner tests

Run: `npm run test:run -- src/main/agent/__tests__/CodexExecJobRunner.test.ts`

Expected: FAIL.

### Step 3: Implement the runner

Create `src/main/agent/CodexExecJobRunner.ts`:

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { AgentStreamEvent, CodexSessionConfig } from '../../types/agent'
import { mapCodexExecJsonLine } from './codexExecJson'

const STDERR_TAIL_BYTES = 4_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export interface CodexExecJobRunnerOptions {
  binary: string
  sessionConfig: CodexSessionConfig
  spawnFactory?: typeof spawn
  timeoutMs?: number
}

export interface CodexExecJobHandle {
  jobId: string
  process: ChildProcess
  done: Promise<void>
  cancel: () => void
}

export class CodexExecJobRunner {
  private readonly spawnFactory: typeof spawn
  private readonly timeoutMs: number

  constructor(private readonly options: CodexExecJobRunnerOptions) {
    this.spawnFactory = options.spawnFactory ?? spawn
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  run(prompt: string, cwd: string, emit: (event: AgentStreamEvent) => void): CodexExecJobHandle {
    const jobId = randomUUID()
    const args = [
      'exec',
      '--json',
      '--cd', cwd,
      '--sandbox', this.options.sessionConfig.sandboxMode,
      '--ask-for-approval', this.options.sessionConfig.approvalPolicy,
      prompt,
    ]
    const proc = this.spawnFactory(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const stderrTail = new RingBuffer(STDERR_TAIL_BYTES)
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })

    const stdout = createInterface({ input: proc.stdout! })
    stdout.on('line', (line) => {
      const event = mapCodexExecJsonLine(line, jobId)
      if (event) emit(event)
    })

    let cancelled = false
    let timedOut = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }, this.timeoutMs)
    timeoutTimer.unref?.()

    const done = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        clearTimeout(timeoutTimer)
        if (timedOut) {
          emit({ type: 'error', threadId: jobId, error: `codex exec timeout after ${this.timeoutMs} ms` })
        } else if (cancelled) {
          emit({ type: 'error', threadId: jobId, error: `codex exec cancelled (signal=${signal ?? 'SIGTERM'})` })
        } else if (code === 0) {
          emit({ type: 'turn_completed', threadId: jobId })
        } else {
          const tail = stderrTail.read().slice(-STDERR_TAIL_BYTES)
          emit({ type: 'error', threadId: jobId, error: `codex exec exited ${code}${tail ? `\n${tail}` : ''}` })
        }
        resolve()
      })
    })

    return { jobId, process: proc, done, cancel }
  }
}

class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly maxSize: number) {}

  push(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    while (this.size > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
  }

  read(): string {
    return this.chunks.join('')
  }
}
```

### Step 4: Run runner tests + typecheck

Run:

```bash
npm run test:run -- src/main/agent/__tests__/CodexExecJobRunner.test.ts
npm run typecheck
```

Expected: PASS.

### Step 5: Commit Task 3

Commit message: `feat: add codex exec job runner with cancel and stderr capture`

---

## Task 4: Mutable Session Configuration with Validation and Confirmation

**Goal:** Allow the user to switch sandbox / approval / web-search / writable-roots from the renderer through `agent:set-session-config`, but only after main-process validation, `writableRoots` containment, an Electron `dialog.showMessageBox` confirmation when transitioning into unsafe modes, and an audit log entry.

**Files:**
- Create: `src/main/agent/sessionConfigValidation.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/types/agent.ts`
- Create: `src/main/agent/__tests__/sessionConfigValidation.test.ts`
- Create: `src/main/agent/__tests__/AgentManager.setSessionConfig.test.ts`

### Step 1: Add validation helper

Create `src/main/agent/sessionConfigValidation.ts`:

```typescript
import path from 'node:path'
import type { CodexApprovalPolicy, CodexSandboxMode, CodexSessionConfig } from '../../types/agent'

const VALID_SANDBOX = new Set<CodexSandboxMode>(['read-only', 'workspace-write', 'danger-full-access'])
const VALID_APPROVAL = new Set<CodexApprovalPolicy>(['untrusted', 'on-failure', 'on-request', 'never'])

export interface SessionConfigValidationContext {
  allowedRoots: string[]
}

export type SessionConfigValidationResult =
  | { ok: true; value: CodexSessionConfig; isUnsafeTransition: boolean }
  | { ok: false; reason: string }

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

function isInside(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(`${p}/`)
}

export function validateSessionConfig(
  input: unknown,
  context: SessionConfigValidationContext,
): SessionConfigValidationResult {
  if (input == null || typeof input !== 'object') {
    return { ok: false, reason: 'sessionConfig must be an object' }
  }
  const raw = input as Record<string, unknown>

  const sandboxMode = raw.sandboxMode
  if (typeof sandboxMode !== 'string' || !VALID_SANDBOX.has(sandboxMode as CodexSandboxMode)) {
    return { ok: false, reason: `invalid sandboxMode: ${String(sandboxMode)}` }
  }

  const approvalPolicy = raw.approvalPolicy
  if (typeof approvalPolicy !== 'string' || !VALID_APPROVAL.has(approvalPolicy as CodexApprovalPolicy)) {
    return { ok: false, reason: `invalid approvalPolicy: ${String(approvalPolicy)}` }
  }

  const webSearch = raw.webSearch
  if (typeof webSearch !== 'boolean') {
    return { ok: false, reason: 'webSearch must be a boolean' }
  }

  const writableRootsInput = raw.writableRoots
  if (!Array.isArray(writableRootsInput)) {
    return { ok: false, reason: 'writableRoots must be an array' }
  }
  const writableRoots: string[] = []
  for (const root of writableRootsInput) {
    if (typeof root !== 'string') {
      return { ok: false, reason: 'writableRoots entries must be strings' }
    }
    if (!context.allowedRoots.some((allowed) => isInside(root, allowed))) {
      return { ok: false, reason: `writableRoot is outside allowed workspace roots: ${root}` }
    }
    writableRoots.push(path.resolve(root))
  }

  const value: CodexSessionConfig = {
    sandboxMode: sandboxMode as CodexSandboxMode,
    approvalPolicy: approvalPolicy as CodexApprovalPolicy,
    webSearch,
    writableRoots,
  }
  const isUnsafeTransition =
    value.sandboxMode === 'danger-full-access' || value.approvalPolicy === 'never'
  return { ok: true, value, isUnsafeTransition }
}
```

Create `src/main/agent/__tests__/sessionConfigValidation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { validateSessionConfig } from '../sessionConfigValidation'

const ROOTS = ['D:/repo']

describe('validateSessionConfig', () => {
  it('accepts a safe config inside allowed roots', () => {
    const result = validateSessionConfig({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: true,
      writableRoots: ['D:/repo/sub'],
    }, { allowedRoots: ROOTS })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.isUnsafeTransition).toBe(false)
  })

  it('flags unsafe transitions', () => {
    const result = validateSessionConfig({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: false,
      writableRoots: [],
    }, { allowedRoots: ROOTS })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.isUnsafeTransition).toBe(true)
  })

  it('rejects writable roots outside the workspace', () => {
    const result = validateSessionConfig({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: true,
      writableRoots: ['C:/Windows'],
    }, { allowedRoots: ROOTS })
    expect(result.ok).toBe(false)
  })

  it.each([
    [{ sandboxMode: 'evil' }, 'sandbox'],
    [{ approvalPolicy: 'whatever' }, 'approval'],
    [{ webSearch: 'yes' }, 'webSearch'],
    [{ writableRoots: 'D:/repo' }, 'writableRoots'],
  ] as const)('rejects malformed input %#', (overrides, expected) => {
    const result = validateSessionConfig({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: true,
      writableRoots: [],
      ...overrides,
    }, { allowedRoots: ROOTS })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.toLowerCase()).toContain(expected)
  })
})
```

### Step 2: Add `setSessionConfig` to `AgentManager`

Modify `src/main/agent/AgentManager.ts`. Phase 1 already made `sessionConfig` mutable to support `setAllowedRoots`. Phase 2 widens the mutation surface to sandbox / approval / web-search behind a confirmation gate. Reuse the canonicalization Phase 1 already applies to `writableRoots`:

1. (`sessionConfig` is already mutable from Phase 1 — no change needed.)
2. Add a constructor option `confirmUnsafe?: (config: CodexSessionConfig) => Promise<boolean>` that defaults to a function returning `true` only after `dialog.showMessageBox` confirmation. Tests inject a stub.
3. Add an audit log seam `auditLog?: (entry: { event: string; payload: unknown; ts: number }) => void` that defaults to writing through `createAgentLogStream`.
4. Implement `setSessionConfig`. When the new config's `writableRoots` differs from the current set, the implementation MUST also call `setFsAllowedRoots(...)` (from `src/main/file-explorer/fsIpc.ts`) to keep the path-containment allow-list in sync. Phase 1's `setAllowedRoots` becomes a thin wrapper around `setSessionConfig({ ...current, writableRoots: validated })` once Phase 2 lands — preserve `setAllowedRoots` as a dedicated narrow IPC for the file-explorer's mutation hot path so workspace-tree edits don't trigger the unsafe-transition prompt.

```typescript
import { dialog } from 'electron'
import {
  validateSessionConfig,
  type SessionConfigValidationContext,
} from './sessionConfigValidation'
import type { CodexSessionConfig, CodexSessionStatus } from '../../types/agent'

private async defaultConfirmUnsafe(config: CodexSessionConfig): Promise<boolean> {
  const win = this.win
  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Switch Codex into an unsafe mode?',
        detail: `Sandbox: ${config.sandboxMode}\nApproval: ${config.approvalPolicy}\nWeb search: ${config.webSearch ? 'on' : 'off'}\nWritable roots: ${config.writableRoots.join(', ') || '(none)'}`,
        buttons: ['Cancel', 'Confirm unsafe mode'],
        defaultId: 0,
        cancelId: 0,
      })
    : { response: 0 }
  return choice.response === 1
}

async setSessionConfig(
  input: unknown,
  context: SessionConfigValidationContext,
): Promise<{ ok: true; status: CodexSessionStatus } | { ok: false; reason: string }> {
  const validation = validateSessionConfig(input, context)
  if (!validation.ok) return { ok: false, reason: validation.reason }

  if (validation.isUnsafeTransition) {
    const confirm = this.confirmUnsafe ?? this.defaultConfirmUnsafe.bind(this)
    const ok = await confirm(validation.value)
    if (!ok) return { ok: false, reason: 'unsafe transition cancelled' }
  }

  this.audit({ event: 'session-config:apply', payload: validation.value, ts: Date.now() })
  this.sessionConfig = validation.value

  // Soft-restart the backend so the new launch flags are applied. Do not
  // mutate test-injected backends — preserve the test seam.
  if (!this.options.backend) {
    await this.stop().catch(() => undefined)
    this.backend = new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      provider: DEFAULT_PROVIDER,
      sessionConfig: this.sessionConfig,
    })
    await this.start()
  }

  this.emitEvent({ type: 'session_restarted' as never, threadId: 'system' as never })
  return { ok: true, status: this.getSessionStatus() }
}

private audit(entry: { event: string; payload: unknown; ts: number }): void {
  (this.auditLog ?? defaultAuditLog)(entry)
}
```

> The `session_restarted` event is a new event type — extend `AgentStreamEvent` accordingly in `src/types/agent.ts`. Renderer code that subscribes to events should treat it as a hint to refetch session status and clear in-flight UI state.

> **Test-seam preservation:** when `opts.backend` was provided, the manager **never** swaps it. Phase 1's test that injects a fake backend continues to work after Phase 2 lands.

Create `src/main/agent/__tests__/AgentManager.setSessionConfig.test.ts` covering:

- Validation failure leaves the existing config and backend untouched.
- Safe transitions skip the confirmation hook entirely.
- Unsafe transitions call `confirmUnsafe`; a `false` response leaves the config untouched.
- A successful apply emits `session_restarted`.
- The audit hook receives a redacted payload (assert the recorded entry shape).

### Step 3: Wire IPC and preload

Modify `src/main/agent/ipc.ts`:

```typescript
ipcMain.handle('agent:set-session-config', async (_event, payload: unknown) => {
  const allowedRoots = readAllowedRoots() // implement: pull from `app.getPath('userData')` + active workspace roots tracked by FileExplorerService
  return manager.setSessionConfig(payload, { allowedRoots })
})

ipcMain.handle('agent:start-exec-job', async (_event, payload: unknown) => {
  const validated = validateExecJobPayload(payload, { allowedRoots: readAllowedRoots() })
  if (!validated.ok) return { ok: false as const, reason: validated.reason }
  const job = manager.startExecJob(validated.value)
  return { ok: true as const, jobId: job.jobId }
})
```

Implement `validateExecJobPayload` next to `sessionConfigValidation.ts`. It must:
- Cap `prompt.length` at e.g. 64 KB.
- Verify `cwd` is inside `allowedRoots`.
- Reuse `validateSessionConfig` for the optional `sessionConfig` field.

Modify `src/preload/index.ts`:

```typescript
setSessionConfig: (config: unknown) => ipcRenderer.invoke('agent:set-session-config', config),
startExecJob: (payload: unknown) => ipcRenderer.invoke('agent:start-exec-job', payload),
```

### Step 4: Extend types and run typecheck

Modify `src/types/agent.ts`:

```typescript
export interface CodexExecJobPayload {
  prompt: string
  cwd: string
  sessionConfig?: Partial<CodexSessionConfig>
}

// Extend AgentSendMessagePayload now that references and per-message session
// overrides have a validated landing path:
export interface AgentSendMessagePayload {
  threadId?: string
  content: string
  attachments: AgentAttachmentInput[]
  currentPage?: string
  model?: string
  references?: import('./agent-reference').AgentReference[]
  sessionConfig?: Partial<CodexSessionConfig>
}

// Add the new event type used by setSessionConfig:
export type AgentStreamEvent =
  | /* ...existing variants... */
  | { type: 'session_restarted'; threadId: string }
```

Run: `npm run typecheck && npm run test:run -- src/main/agent/__tests__/sessionConfigValidation.test.ts src/main/agent/__tests__/AgentManager.setSessionConfig.test.ts`

Expected: PASS.

### Step 5: Commit Task 4

Commit message: `feat: add validated codex session config switching`

---

## Task 5: MCP Status Panel Backed by `~/.codex/config.toml`

**Goal:** A real `getMcpSummary` that reads the configured MCP servers, fed by a tightly-scoped TOML reader. No raw `payload` rendering — only the names, transport types, and user-visible status. The renderer panel uses `JsonResourcePreview`'s safe-stringify for any debug payloads.

**Files:**
- Create: `src/main/agent/codexConfigToml.ts`
- Create: `src/main/agent/__tests__/codexConfigToml.test.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/features/agent-chat/CodexMcpPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`

### Step 1: Implement scoped TOML reader

Use the npm `@iarna/toml` parser (already vendored if `package.json` lists it; otherwise add as a regular dependency). Create `src/main/agent/codexConfigToml.ts` that exports:

```typescript
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import TOML from '@iarna/toml'
import type { CodexMcpServerSummary } from '../../types/agent'

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')

export async function readCodexMcpServers(configPath: string = DEFAULT_CONFIG_PATH): Promise<CodexMcpServerSummary[]> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch {
    return []
  }
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }
  const block = parsed.mcp_servers
  if (!block || typeof block !== 'object') return []
  const out: CodexMcpServerSummary[] = []
  for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    out.push({
      name,
      status: entry.disabled === true ? 'disabled' : 'configured',
      tools: [],
    })
  }
  return out
}
```

Add `CodexMcpServerSummary` to `src/types/agent.ts`:

```typescript
export interface CodexMcpServerSummary {
  name: string
  status: 'configured' | 'connected' | 'disabled' | 'auth-required' | 'error'
  tools: string[]
  error?: string
}
```

Create `src/main/agent/__tests__/codexConfigToml.test.ts` covering:

- Missing config file → empty array.
- Malformed TOML → empty array.
- Valid file with `[mcp_servers.github]` and `[mcp_servers.context7]` → both surfaced.
- `[mcp_servers.disabled-one] disabled = true` → status `disabled`.

### Step 2: Wire `getMcpSummary` and IPC

Modify `src/main/agent/AgentManager.ts`:

```typescript
async getMcpSummary(): Promise<CodexMcpServerSummary[]> {
  return readCodexMcpServers()
}
```

Modify `src/main/agent/ipc.ts`:

```typescript
ipcMain.handle('agent:get-mcp-summary', () => manager.getMcpSummary())
```

Modify `src/preload/index.ts`:

```typescript
getMcpSummary: () => ipcRenderer.invoke('agent:get-mcp-summary'),
```

### Step 3: Implement `CodexMcpPanel`

Create the panel component that takes `servers: CodexMcpServerSummary[]`. When the array is empty, show a one-line "Configure MCP through `~/.codex/config.toml`" hint. For each server, render the name, status pill, and a list of tool chips. Add a test in `__tests__/CodexMcpPanel.test.tsx` that asserts both the empty and populated states.

Render the panel inside `AgentChatPanel` behind a collapsible "MCP" header, using a one-shot `useEffect` that calls `getMcpSummary()` on mount.

### Step 4: Run tests + typecheck + commit

Run:

```bash
npm run test:run -- src/main/agent/__tests__/codexConfigToml.test.ts src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx
npm run typecheck
```

Expected: PASS.

Commit message: `feat: surface codex mcp servers from config.toml`

---

## Task 6: GitHub Actions Workflow with Hardenings

**Goal:** A scheduled / `workflow_dispatch` workflow that detects a new `openai/codex` release, updates `package.json:codexCliVersion`, fetches and SHA-256-verifies the binary, and opens a PR. All third-party actions are SHA-pinned. The script-side output handling is injection-safe. Tokens are only read from secrets — never from chat or local config.

**Files:**
- Create: `scripts/check-codex-release.ts`
- Create: `scripts/update-codex-version.ts`
- Create: `scripts/__tests__/check-codex-release.test.ts`
- Create: `scripts/__tests__/update-codex-version.test.ts`
- Modify: `package.json`
- Create: `.github/workflows/update-codex.yml`
- Create: `docs/codex-update-runbook.md`

### Step 1: Implement and test the version checker

Create `scripts/check-codex-release.ts`:

```typescript
import fs from 'node:fs/promises'
import process from 'node:process'

const TAG_REGEX = /^[A-Za-z0-9._-]+$/
const VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/

export function parseCodexVersionFromTag(tag: string): string | null {
  if (typeof tag !== 'string' || !TAG_REGEX.test(tag)) return null
  const stripped = tag.replace(/^rust-v/, '').replace(/^v/, '')
  return VERSION_REGEX.test(stripped) ? stripped : null
}

export function shouldUpdateCodex(current: string, latest: string): boolean {
  return current !== latest
}

interface FetchResult { tag: string; sha: string }

async function fetchLatestRelease(): Promise<FetchResult> {
  const response = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`)
  const json = await response.json() as { tag_name?: unknown; target_commitish?: unknown }
  if (typeof json.tag_name !== 'string') throw new Error('release response missing tag_name')
  return { tag: json.tag_name, sha: typeof json.target_commitish === 'string' ? json.target_commitish : '' }
}

async function writeOutput(name: string, value: string): Promise<void> {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid output name: ${name}`)
  if (typeof value !== 'string') throw new Error(`output ${name} must be a string`)
  if (value.includes('\n') || value.includes('\r') || value.includes('=')) {
    throw new Error(`output ${name} contains forbidden character`)
  }
  const out = process.env.GITHUB_OUTPUT
  const line = `${name}=${value}\n`
  if (out) await fs.appendFile(out, line, 'utf8')
  else process.stdout.write(line)
}

interface PackageJson { codexCliVersion?: string }

async function main(): Promise<void> {
  const raw = await fs.readFile('package.json', 'utf8')
  const pkg = JSON.parse(raw) as PackageJson
  const current = pkg.codexCliVersion
  if (!current) throw new Error('package.json is missing codexCliVersion')

  const release = await fetchLatestRelease()
  const latest = parseCodexVersionFromTag(release.tag)
  if (!latest) throw new Error(`unparsable release tag: ${release.tag}`)
  const update = shouldUpdateCodex(current, latest)

  await writeOutput('current', current)
  await writeOutput('latest', latest)
  await writeOutput('update', update ? 'true' : 'false')
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
```

Create `scripts/__tests__/check-codex-release.test.ts` covering:

- `parseCodexVersionFromTag('rust-v0.129.0')` → `'0.129.0'`.
- `parseCodexVersionFromTag('v0.129.0-beta.1')` → `'0.129.0-beta.1'`.
- `parseCodexVersionFromTag('rm -rf')` → `null` (rejects shell-injection bait).
- `parseCodexVersionFromTag(';;')` → `null`.
- `shouldUpdateCodex('0.128.0', '0.129.0')` → `true`.
- `shouldUpdateCodex('0.129.0', '0.129.0')` → `false`.

The script's `writeOutput` rejects names that look like injection (newline, `=`, control chars). Because `latest` is funnelled through `parseCodexVersionFromTag` first, an attacker-supplied tag cannot bypass the validator.

### Step 2: Implement and test the version updater

Create `scripts/update-codex-version.ts`:

```typescript
import fs from 'node:fs/promises'
import process from 'node:process'

const VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/

export async function updateCodexVersion(version: string): Promise<void> {
  if (!VERSION_REGEX.test(version)) throw new Error(`invalid version: ${version}`)
  const raw = await fs.readFile('package.json', 'utf8')
  // Preserve trailing newline + indentation if the file uses spaces.
  const trailingNewline = raw.endsWith('\n')
  const pkg = JSON.parse(raw) as Record<string, unknown>
  pkg.codexCliVersion = version
  const next = JSON.stringify(pkg, null, 2) + (trailingNewline ? '\n' : '')
  await fs.writeFile('package.json', next, 'utf8')
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: tsx scripts/update-codex-version.ts <version>')
    process.exit(2)
  }
  updateCodexVersion(version).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
```

Create `scripts/__tests__/update-codex-version.test.ts` covering:

- A valid version updates `codexCliVersion` and preserves a trailing newline.
- An invalid version (`'rm -rf /'`) throws.

### Step 3: Add scripts to `package.json`

```json
"codex:check-latest": "tsx scripts/check-codex-release.ts",
"codex:update-version": "tsx scripts/update-codex-version.ts"
```

### Step 4: Add the workflow

Create `.github/workflows/update-codex.yml`. Use SHA-pinned actions (look up the current SHAs at the time of authoring; the SHAs in the snippet below are placeholders that the implementer **must replace** with the real ones):

```yaml
name: Update Codex CLI

on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * *'

permissions:
  contents: read

concurrency:
  group: update-codex
  cancel-in-progress: true

jobs:
  update-codex:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@<SHA-of-actions-checkout-v5>

      - name: Setup Node
        uses: actions/setup-node@<SHA-of-actions-setup-node-v5>
        with:
          node-version: 20
          cache: npm

      - name: Install
        run: npm ci

      - name: Check latest Codex release
        id: codex
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: npm run codex:check-latest

      - name: Skip if no update
        if: steps.codex.outputs.update != 'true'
        run: echo "no update"

      - name: Update Codex version
        if: steps.codex.outputs.update == 'true'
        run: npm run codex:update-version -- ${{ steps.codex.outputs.latest }}

      - name: Fetch and verify Codex binary (Linux smoke check)
        if: steps.codex.outputs.update == 'true'
        env:
          CODEX_CLI_VERSION: ${{ steps.codex.outputs.latest }}
          CODEX_TARGETS: linux-x64
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          npm run codex:fetch
          # SHA-256 manifest verification (manifest format defined by codex:fetch)
          test -f resources/codex/manifest.json
          node -e 'const m=require("./resources/codex/manifest.json"); if (!m.entries?.length) { process.exit(1) }'

      - name: Typecheck touched scripts
        if: steps.codex.outputs.update == 'true'
        run: npm run typecheck

      - name: Create update pull request
        if: steps.codex.outputs.update == 'true'
        uses: peter-evans/create-pull-request@<SHA-of-create-pull-request-v6>
        with:
          # Prefer GitHub App installation token so the resulting PR triggers
          # the usual CI workflows. Fall back to GITHUB_TOKEN only when the
          # CODEX_UPDATE_TOKEN secret is absent — note that PRs opened with
          # GITHUB_TOKEN do not trigger downstream Actions runs.
          token: ${{ secrets.CODEX_UPDATE_TOKEN || github.token }}
          branch: chore/update-codex-${{ steps.codex.outputs.latest }}
          delete-branch: true
          title: Update Codex CLI to ${{ steps.codex.outputs.latest }}
          commit-message: chore: update codex cli to ${{ steps.codex.outputs.latest }}
          body: |
            Updates bundled Codex CLI from `${{ steps.codex.outputs.current }}` to `${{ steps.codex.outputs.latest }}`.
            Verification (run by this workflow):
            - npm run codex:fetch
            - npm run typecheck
```

> **Pinning rule:** before merging this workflow, replace every `<SHA-of-…>` placeholder with the actual commit SHA you intend to pin to. Document the SHAs in `docs/codex-update-runbook.md` so future rotations know what to bump.

### Step 5: Operator runbook

Create `docs/codex-update-runbook.md` covering:

- How to mint and rotate `CODEX_UPDATE_TOKEN` (preferred: a dedicated GitHub App with `contents: write` + `pull_requests: write` and no other scopes).
- How to dry-run the workflow via `workflow_dispatch`.
- How to rollback a bad update PR (revert + reset binaries).
- The exact list of pinned action SHAs and how to bump them safely.

### Step 6: Run script tests + typecheck + commit

Run:

```bash
npm run test:run -- scripts/__tests__/check-codex-release.test.ts scripts/__tests__/update-codex-version.test.ts
npm run typecheck
```

Expected: PASS.

Commit message: `ci: add hardened codex update workflow`

---

## Task 7: Wire Phase 2 Surfaces into the Renderer and Verify End-to-End

**Goal:** Make the new capabilities discoverable from the UI without inventing a slash-command palette: a "Permissions" dialog (drives `setSessionConfig`), a "Run job" dialog (drives `startExecJob`), and the MCP panel from Task 5 are reachable from the chat header. Verify the full loop in dev mode.

**Files:**
- Create: `src/renderer/src/features/agent-chat/SessionConfigDialog.tsx`
- Create: `src/renderer/src/features/agent-chat/ExecJobDialog.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/SessionConfigDialog.test.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ExecJobDialog.test.tsx`

### Step 1: Implement `SessionConfigDialog`

A modal that:
- Reads the current status from `getSessionStatus()`.
- Lets the user pick a sandbox mode, approval policy, and toggle web search.
- Lets the user select writable roots from a checkbox list of currently-known workspace roots (no free-form path entry — the list comes from the file explorer store).
- On submit, calls `setSessionConfig(config)`. Shows the validation error inline if the IPC returns `{ ok: false }`.
- After a successful apply, listens for the new `session_restarted` stream event before closing the modal.

Add a focused test that asserts:
- The dialog refuses to allow free-form root entry.
- An invalid IPC response is surfaced inline.

### Step 2: Implement `ExecJobDialog`

A modal that:
- Lets the user enter a prompt and pick a `cwd` from the same workspace-root checkbox list.
- Shows the resolved `sessionConfig` (read-only) for the job.
- Calls `startExecJob({ prompt, cwd })` and routes returned `agent:event`s into the existing chat timeline so jobs and turns share rendering.

Add a focused test asserting that the dialog refuses to submit an empty prompt or an unknown `cwd`.

### Step 3: Header buttons

Modify `AgentChatPanel.tsx` to add two header buttons next to the existing `CodexStatusPanel`:

- "Permissions" → opens `SessionConfigDialog`.
- "Run job" → opens `ExecJobDialog`.

Both buttons are visible only when `getSessionStatus()` returned a value (so they degrade gracefully if the IPC is unavailable).

### Step 4: Run all Phase 2 tests + typecheck + manual verification

Run:

```bash
npm run test:run -- \
  src/main/agent/__tests__/codexExecJson.test.ts \
  src/main/agent/__tests__/CodexExecJobRunner.test.ts \
  src/main/agent/__tests__/sessionConfigValidation.test.ts \
  src/main/agent/__tests__/AgentManager.setSessionConfig.test.ts \
  src/main/agent/__tests__/codexConfigToml.test.ts \
  src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/SessionConfigDialog.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/ExecJobDialog.test.tsx \
  scripts/__tests__/record-codex-exec-fixture.test.ts \
  scripts/__tests__/check-codex-release.test.ts \
  scripts/__tests__/update-codex-version.test.ts
npm run typecheck
```

Run `npm run dev` and verify:

- Permissions dialog accepts a safe change without prompting; an unsafe change shows the Electron confirmation dialog.
- A successful Permissions change emits `session_restarted` and the status panel border flips to amber when unsafe.
- A submitted Run-job dialog produces shell / agent_message events in the timeline that match a manual `codex exec --json` run.
- MCP panel lists the configured servers from `~/.codex/config.toml`.
- The update workflow runs locally end-to-end via `act` (or via a `workflow_dispatch` dry-run on a fork).

### Step 5: Final secret scan

Run the same expanded `rg` invocation from Phase 1 Task 7 Step 4. Expected: zero matches.

### Step 6: Commit Task 7

Commit message: `test: verify codex workspace ui phase 2`

---

## Implementation Notes

- **Fixtures over speculation.** Task 1 ships first, and every parser branch in Task 2 must be backed by a fixture line. If Codex changes its event surface mid-plan, re-record the fixture, update the parser, and re-run the suite — do not guess.
- **No raw renderer config without main-process validation.** Every IPC handler that writes Codex state runs through `validateSessionConfig` or `validateExecJobPayload` before touching the backend.
- **Audit trail.** `setSessionConfig` writes a structured audit entry. The renderer never receives more than the resulting `CodexSessionStatus`, so audit data does not leak through chat.
- **`local-file://` containment.** Reference open behaviors that resolve to `localPath` references must continue to be gated on workspace roots (Phase 1 already does this via `openTab`).
- **Operator hygiene.** Any token previously pasted into chat or committed to local config is compromised. Rotate before running the workflow against the production repo.

## Out-of-Phase Hand-Off

- Subagents, skills/plugins, image generation viewer, and resume/fork/side-conversation surfaces remain deferred. A separate Phase 3 plan owns those.
- The slash-command palette is intentionally not part of this plan because Phase 2 routes its useful actions through dedicated dialogs and panels.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-05-08-codex-native-workspace-ui-phase2.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
