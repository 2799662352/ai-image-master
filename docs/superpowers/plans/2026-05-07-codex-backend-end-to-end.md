# Codex Backend End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Codex agent MVP actually start, talk to the real `codex app-server` over WebSocket, and stream a reply for an end-to-end "send prompt → get text back → cancel works" flow.

**Architecture:** Replace the placeholder JSON-RPC method names and process invocation in `CodexLocalBackend.ts` with the real Codex App-Server protocol (verified by running `codex app-server generate-ts --out`). Reshape `AgentManager` user input mapping to match the real `UserInput` discriminated union. Configure the spawned Codex with `approval_policy = never` and `sandbox_mode = danger-full-access` so server→client approval requests never fire (the user explicitly chose "no permission model"). Add a standalone `scripts/probe-codex.ts` integration smoke that exercises the binary end-to-end without Electron, and a manual dev-startup checklist.

**Tech Stack:** Node.js 20+, TypeScript, `ws` 8.x, Electron 41, Vitest 4 (`--pool=threads`), `tsx` for one-shot scripts, the bundled `resources/codex/<platform>-<arch>/codex(.exe)` binary at version `0.128.0`.

---

## Verified Protocol Reference (do not edit while implementing)

These were derived by running `codex app-server generate-ts --out docs/codex-app-server` against the bundled binary. Treat as ground truth for this plan; the helper output dir is git-ignored, so re-run the command if you need to inspect details.

- **Process invocation**: `codex app-server --listen ws://127.0.0.1:<PORT>`. There is **no `serve` subcommand**. Loopback (`127.0.0.1`) does not require `--ws-auth`.
- **`initialize`** request (`{clientInfo:{name,title?,version}, capabilities: null}`) → response `{userAgent, codexHome, platformFamily, platformOs}`.
- **`thread/start`** (params `ThreadStartParams`, all fields optional, e.g. `{model?, modelProvider?, cwd?, sandbox?, approvalPolicy?}`) → `ThreadStartResponse = {thread: Thread, model, modelProvider, ...}`. `thread.id` is the threadId.
- **`turn/start`** (params `{threadId, input: UserInput[]}`) → `TurnStartResponse = {turn: Turn}`. `turn.id` is the turnId we must remember for `turn/interrupt`.
- **`turn/interrupt`** (params `{threadId, turnId}`) — this is the cancel method. It is **not** `turn/cancel`.
- **`UserInput`** is a discriminated union tagged by `type`:
  - `{ "type": "text", "text": string, "text_elements": [] }` — note `text_elements` is snake_case on the wire.
  - `{ "type": "image", "url": string }` — field is `url`, **not** `imageUrl`.
  - `{ "type": "localImage", "path": string }` — for files on disk (use this for our attachment paths).
  - `{ "type": "skill"|"mention", "name": string, "path": string }` — not used in this MVP.
- **Streaming notifications we care about**:
  - `thread/started` `{ thread: Thread }`
  - `turn/started` `{ threadId, turn }`
  - `item/started` / `item/completed` `{ item: ThreadItem, threadId, turnId }`
  - `item/agentMessage/delta` `{ threadId, turnId, itemId, delta }`
  - `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` `{ threadId, turnId, itemId, delta }` — note: **not** `item/reasoning/delta` like our current code assumes.
  - `turn/completed` `{ threadId, turn }` (turnId is `turn.id`).
  - `error` `{ error, willRetry, threadId, turnId }`.
- **Server-initiated requests** (server → client, with `id`): `applyPatchApproval`, `execCommandApproval`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`. With `approval_policy=never` + `sandbox=danger-full-access` the approval ones should not fire, but we must respond with a JSON-RPC error to anything we don't handle so the server doesn't hang.

---

## File Structure

- **Modify** `src/main/agent/CodexLocalBackend.ts` — full rewrite of `start()`, `send()`, `cancel()`, message routing.
- **Modify** `src/main/agent/types.ts` — extend `AgentInput['items']` union to include `localImage` (for attachment file paths).
- **Modify** `src/main/agent/AgentManager.ts` — map saved attachments to `localImage` (with absolute path) instead of `image` with `imageUrl`, and forward the new shape.
- **Create** `src/main/agent/codexProtocol.ts` — minimal hand-curated TS types for the protocol surface we use (Initialize, ThreadStart, TurnStart, TurnInterrupt, ServerNotification subset). Keeps `CodexLocalBackend.ts` typed without dragging the 200+ generated files into source control.
- **Create** `scripts/probe-codex.ts` — standalone end-to-end smoke that spawns the binary, runs initialize → thread/start → turn/start("ping"), prints streamed deltas, then exits 0/1. Used in CI optionality and manual verification.
- **Modify** `src/main/agent/__tests__/codexRuntime.smoke.test.ts` — keep "documents binary presence" test, add a focused unit test for the new spawn argv shape via `resolveCodexLaunchArgs()` helper.
- **Create** `src/main/agent/__tests__/CodexLocalBackend.test.ts` — pure unit tests for the new message-routing/event-mapping logic with a fake WebSocket pair.
- **Modify** `package.json` — add `codex:probe` npm script wired to `tsx scripts/probe-codex.ts`.
- **Modify** `docs/superpowers/plans/2026-05-06-codex-agent-mvp.md` — append a "End-to-end follow-up" note pointing at this plan (one-line link, no rewrite).

---

## Tasks

### Task 1: Curate Codex protocol types

**Files:**
- Create: `src/main/agent/codexProtocol.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexProtocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isServerNotification, isServerRequest, type ServerMessage } from '../codexProtocol'

describe('codexProtocol type guards', () => {
  it('detects notifications (no id)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't', turn: { id: 'u' } } }
    expect(isServerNotification(msg)).toBe(true)
    expect(isServerRequest(msg)).toBe(false)
  })

  it('detects server requests (id + method)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', id: 17, method: 'applyPatchApproval', params: {} }
    expect(isServerRequest(msg)).toBe(true)
    expect(isServerNotification(msg)).toBe(false)
  })

  it('detects rpc responses (id + result/error, no method)', () => {
    const msg: ServerMessage = { jsonrpc: '2.0', id: 3, result: { ok: true } }
    expect(isServerNotification(msg)).toBe(false)
    expect(isServerRequest(msg)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexProtocol.test.ts --pool=threads`
Expected: FAIL with `Cannot find module '../codexProtocol'`.

- [ ] **Step 3: Write the protocol module**

Create `src/main/agent/codexProtocol.ts`:

```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface JsonRpcServerRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }

export type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest

export function isServerNotification(msg: ServerMessage): msg is JsonRpcNotification {
  return typeof (msg as JsonRpcNotification).method === 'string' && (msg as JsonRpcServerRequest).id === undefined
}

export function isServerRequest(msg: ServerMessage): msg is JsonRpcServerRequest {
  return typeof (msg as JsonRpcServerRequest).method === 'string' && typeof (msg as JsonRpcServerRequest).id === 'number'
}

export interface ClientInfo { name: string; title?: string | null; version: string }
export interface InitializeParams { clientInfo: ClientInfo; capabilities: null }
export interface InitializeResponse { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

export interface Thread { id: string; preview: string; cwd: string }
export interface Turn { id: string; status: string }

export interface ThreadStartParams { model?: string; modelProvider?: string; cwd?: string; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' }
export interface ThreadStartResponse { thread: Thread }

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }

export interface TurnStartParams { threadId: string; input: CodexUserInput[] }
export interface TurnStartResponse { turn: Turn }

export interface TurnInterruptParams { threadId: string; turnId: string }

export interface AgentMessageDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface ReasoningTextDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface TurnStartedNotification { threadId: string; turn: Turn }
export interface TurnCompletedNotification { threadId: string; turn: Turn }
export interface ErrorNotification { error: { message?: string }; willRetry: boolean; threadId: string; turnId: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/agent/__tests__/codexProtocol.test.ts --pool=threads`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexProtocol.ts src/main/agent/__tests__/codexProtocol.test.ts
git commit -m "feat(agent): add curated Codex app-server protocol types"
```

---

### Task 2: Pure helper for Codex launch args

**Files:**
- Create: `src/main/agent/codexLaunch.ts`
- Test: `src/main/agent/__tests__/codexLaunch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexLaunch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveCodexLaunchArgs } from '../codexLaunch'

describe('resolveCodexLaunchArgs', () => {
  it('uses app-server with --listen and unrestricted defaults', () => {
    const args = resolveCodexLaunchArgs({ port: 4222 })
    expect(args).toEqual([
      'app-server',
      '--listen', 'ws://127.0.0.1:4222',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
    ])
  })

  it('does NOT include the legacy "serve" subcommand', () => {
    const args = resolveCodexLaunchArgs({ port: 1 })
    expect(args).not.toContain('serve')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexLaunch.test.ts --pool=threads`
Expected: FAIL with `Cannot find module '../codexLaunch'`.

- [ ] **Step 3: Write the helper**

Create `src/main/agent/codexLaunch.ts`:

```ts
export interface CodexLaunchOptions { port: number }

export function resolveCodexLaunchArgs(options: CodexLaunchOptions): string[] {
  return [
    'app-server',
    '--listen', `ws://127.0.0.1:${options.port}`,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/agent/__tests__/codexLaunch.test.ts --pool=threads`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexLaunch.ts src/main/agent/__tests__/codexLaunch.test.ts
git commit -m "feat(agent): add Codex launch arg helper with permissive defaults"
```

---

### Task 3: WebSocket connect retry

**Files:**
- Modify: `src/main/agent/CodexLocalBackend.ts` (add new helper, do not yet rewire)
- Test: `src/main/agent/__tests__/connectWithRetry.test.ts` (new)
- Create: `src/main/agent/connectWithRetry.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/connectWithRetry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { connectWithRetry } from '../connectWithRetry'

describe('connectWithRetry', () => {
  it('retries until factory succeeds within timeout', async () => {
    let attempts = 0
    const result = await connectWithRetry({
      attempt: () => {
        attempts += 1
        if (attempts < 3) throw new Error('not ready')
        return Promise.resolve('ws')
      },
      timeoutMs: 2000,
      intervalMs: 10,
    })
    expect(result).toBe('ws')
    expect(attempts).toBe(3)
  })

  it('rejects after timeout with the last error', async () => {
    await expect(
      connectWithRetry({
        attempt: () => Promise.reject(new Error('boom')),
        timeoutMs: 50,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/timed out.*boom/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/connectWithRetry.test.ts --pool=threads`
Expected: FAIL with `Cannot find module '../connectWithRetry'`.

- [ ] **Step 3: Implement the helper**

Create `src/main/agent/connectWithRetry.ts`:

```ts
export interface RetryOptions<T> {
  attempt: () => Promise<T>
  timeoutMs: number
  intervalMs: number
}

export async function connectWithRetry<T>(options: RetryOptions<T>): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown = new Error('no attempt made')

  while (Date.now() < deadline) {
    try {
      return await options.attempt()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`connectWithRetry timed out after ${options.timeoutMs}ms: ${reason}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/agent/__tests__/connectWithRetry.test.ts --pool=threads`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/connectWithRetry.ts src/main/agent/__tests__/connectWithRetry.test.ts
git commit -m "feat(agent): add bounded WebSocket connect retry"
```

---

### Task 4: Extend AgentInput to support local image attachments

**Files:**
- Modify: `src/main/agent/types.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Test: `src/main/agent/__tests__/AgentManager.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/AgentManager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('../CodexLocalBackend', () => {
  return {
    CodexLocalBackend: class {
      lastInput: any
      async start() {}
      async stop() {}
      async cancel() {}
      isHealthy() { return true }
      send(_threadId: string | undefined, input: any) {
        this.lastInput = input
        const self = this
        async function* gen() {
          yield { type: 'turn_completed', threadId: 't', turnId: 'u' }
        }
        return gen()
      }
    },
  }
})

import { AgentManager } from '../AgentManager'

const fakeWin = { webContents: { send: vi.fn() }, isDestroyed: () => false } as any

const fakeStore = {
  createThread: vi.fn(async () => ({ id: 't' })),
  listThreads: vi.fn(),
  loadThread: vi.fn(),
} as any

const fakeAttachments = {
  ingest: vi.fn(async () => [
    { localPath: '/tmp/cat.png', mime: 'image/png' },
  ]),
} as any

it('maps image attachments to localImage with an absolute path (not imageUrl)', async () => {
  const manager = new AgentManager(fakeWin, fakeStore, fakeAttachments)
  await manager.sendMessage({ content: 'look at this', attachments: [{ name: 'cat.png', mime: 'image/png', size: 1, path: '/tmp/cat.png' }] })
  // wait one tick so forwardEvents starts and records lastInput
  await new Promise((r) => setTimeout(r, 0))
  const backend = (manager as any).backend
  expect(backend.lastInput.items).toEqual([
    { type: 'text', text: 'look at this' },
    { type: 'localImage', path: '/tmp/cat.png' },
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/AgentManager.test.ts --pool=threads`
Expected: FAIL — current implementation produces `{ type: 'image', imageUrl: 'file://...' }`.

- [ ] **Step 3: Update the types**

In `src/main/agent/types.ts`, replace the `items` union:

```ts
export interface AgentInput extends AgentSendMessagePayload {
  model: string
  cwd: string
  items: Array<
    | { type: 'text'; text: string }
    | { type: 'localImage'; path: string }
    | { type: 'image'; url: string }
  >
}
```

- [ ] **Step 4: Update AgentManager mapping**

In `src/main/agent/AgentManager.ts`, replace the items construction (the block currently using `pathToFileURL(item.localPath)`):

```ts
const items: AgentInput['items'] = [
  { type: 'text', text: payload.content },
  ...savedAttachments
    .filter((item) => item.mime.startsWith('image/'))
    .map((item) => ({ type: 'localImage' as const, path: item.localPath })),
]
```

Also remove the now-unused import `import { pathToFileURL } from 'node:url'`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/agent/__tests__/AgentManager.test.ts --pool=threads`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/types.ts src/main/agent/AgentManager.ts src/main/agent/__tests__/AgentManager.test.ts
git commit -m "feat(agent): map image attachments to Codex localImage user input"
```

---

### Task 5: Rewrite CodexLocalBackend against the real protocol

**Files:**
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Test: `src/main/agent/__tests__/CodexLocalBackend.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/CodexLocalBackend.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapServerNotification } from '../CodexLocalBackend'

describe('mapServerNotification', () => {
  it('maps item/agentMessage/delta to message_delta', () => {
    expect(
      mapServerNotification('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hi' }),
    ).toEqual({ type: 'message_delta', threadId: 't', turnId: 'u', delta: 'hi' })
  })

  it('maps item/reasoning/textDelta to reasoning_delta', () => {
    expect(
      mapServerNotification('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'thought' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 'thought' })
  })

  it('maps item/reasoning/summaryTextDelta to reasoning_delta as well', () => {
    expect(
      mapServerNotification('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'summary' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 'summary' })
  })

  it('maps turn/completed using turn.id for turnId', () => {
    expect(
      mapServerNotification('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } }),
    ).toEqual({ type: 'turn_completed', threadId: 't', turnId: 'u' })
  })

  it('maps error notifications to error events', () => {
    expect(
      mapServerNotification('error', { error: { message: 'kaboom' }, willRetry: false, threadId: 't', turnId: 'u' }),
    ).toEqual({ type: 'error', threadId: 't', turnId: 'u', error: 'kaboom' })
  })

  it('returns null for notifications we do not consume', () => {
    expect(mapServerNotification('account/updated', {})).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/CodexLocalBackend.test.ts --pool=threads`
Expected: FAIL — `mapServerNotification` is not exported.

- [ ] **Step 3: Rewrite CodexLocalBackend.ts**

Replace the entire file contents with:

```ts
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { createAgentLogStream } from './logger'
import { resolveCodexLaunchArgs } from './codexLaunch'
import { connectWithRetry } from './connectWithRetry'
import { getCodexResourceRoot, resolveCodexBinary } from './paths'
import { pickFreePort } from './ports'
import {
  isServerNotification,
  isServerRequest,
  type CodexUserInput,
  type ServerMessage,
  type Thread,
  type ThreadStartResponse,
  type Turn,
  type TurnStartResponse,
} from './codexProtocol'
import type { AgentStreamEvent } from '../../types/agent'
import type { AgentInput, IAgentBackend, JsonRpcMessage } from './types'

const RPC_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000
const CONNECT_INTERVAL_MS = 100

type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

type TurnQueue = {
  buffer: AgentStreamEvent[]
  waiter?: (event: AgentStreamEvent) => void
  closed: boolean
}

export function mapServerNotification(method: string, params: any): AgentStreamEvent | null {
  switch (method) {
    case 'item/agentMessage/delta':
      return { type: 'message_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return { type: 'reasoning_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    case 'turn/started':
      return { type: 'tool_call_start', threadId: params.threadId, turnId: params.turn?.id, tool: { id: params.turn?.id ?? 'turn', name: 'turn', status: 'running' } }
    case 'turn/completed':
      return { type: 'turn_completed', threadId: params.threadId, turnId: params.turn?.id }
    case 'error':
      return { type: 'error', threadId: params.threadId, turnId: params.turnId, error: params.error?.message ?? 'codex error' }
    default:
      return null
  }
}

function mapUserInput(items: AgentInput['items']): CodexUserInput[] {
  return items.map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text, text_elements: [] }
    if (item.type === 'localImage') return { type: 'localImage', path: item.path }
    return { type: 'image', url: item.url }
  })
}

export class CodexLocalBackend implements IAgentBackend {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, PendingRpc>()
  private turnIdByThread = new Map<string, string>()
  private queues = new Map<string, TurnQueue>()

  async start(): Promise<void> {
    const port = await pickFreePort(4222)
    const resourceRoot = getCodexResourceRoot({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
    const bin = resolveCodexBinary(resourceRoot)
    const log = createAgentLogStream('codex')

    this.proc = spawn(bin, resolveCodexLaunchArgs({ port }), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    this.proc.stdout?.pipe(log)
    this.proc.stderr?.pipe(log)
    this.proc.once('error', (error) => { log.write(`[codex process error] ${error.message}\n`); this.rejectPending(error) })
    this.proc.on('exit', (code) => { log.write(`[codex exited] code=${code}\n`); this.ws?.close(); this.ws = null; this.failAllQueues(new Error(`codex exited with code ${code}`)) })

    this.ws = await connectWithRetry({
      attempt: () => new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
      }),
      timeoutMs: CONNECT_TIMEOUT_MS,
      intervalMs: CONNECT_INTERVAL_MS,
    })

    this.ws.on('message', (data) => this.handleRaw(String(data)))
    this.ws.on('close', () => this.failAllQueues(new Error('codex websocket closed')))

    await this.rpc('initialize', { clientInfo: { name: 'catimation', version: '0.0.0' }, capabilities: null })
  }

  async stop(): Promise<void> {
    this.ws?.close()
    this.proc?.kill()
    this.ws = null
    this.proc = null
    this.failAllQueues(new Error('Codex backend stopped'))
    this.rejectPending(new Error('Codex backend stopped'))
  }

  async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    const actualThreadId = threadId ?? await this.startThread(input)
    const turn = await this.rpc<TurnStartResponse>('turn/start', { threadId: actualThreadId, input: mapUserInput(input.items) })
    const turnId = turn.turn.id
    this.turnIdByThread.set(actualThreadId, turnId)

    const key = `${actualThreadId}:${turnId}`
    const queue: TurnQueue = { buffer: [], closed: false }
    this.queues.set(key, queue)

    try {
      while (true) {
        const event = await this.takeEvent(queue)
        yield event
        if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') return
      }
    } finally {
      this.queues.delete(key)
      if (this.turnIdByThread.get(actualThreadId) === turnId) this.turnIdByThread.delete(actualThreadId)
    }
  }

  async cancel(threadId: string): Promise<void> {
    const turnId = this.turnIdByThread.get(threadId)
    if (!turnId) return
    await this.rpc('turn/interrupt', { threadId, turnId })
  }

  isHealthy(): boolean { return this.proc !== null && this.ws?.readyState === WebSocket.OPEN }

  private async startThread(input: AgentInput): Promise<string> {
    const response = await this.rpc<ThreadStartResponse>('thread/start', { model: input.model, cwd: input.cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' })
    return response.thread.id
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.rpcId
    const payload: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }

    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) { reject(new Error('Codex websocket is not connected')); return }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`)) }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.ws.send(JSON.stringify(payload), (error) => { if (!error) return; clearTimeout(timer); this.pending.delete(id); reject(error) })
    })
  }

  private handleRaw(raw: string): void {
    let msg: ServerMessage
    try { msg = JSON.parse(raw) as ServerMessage } catch { return }

    if ('id' in msg && msg.id !== undefined && (msg as any).method === undefined) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      const response = msg as { id: number; result?: unknown; error?: { code: number; message: string } }
      response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result)
      return
    }

    if (isServerRequest(msg)) {
      this.respondNotImplemented(msg.id, msg.method)
      return
    }

    if (isServerNotification(msg)) {
      const event = mapServerNotification(msg.method, msg.params ?? {})
      if (!event) return
      const turnId = event.turnId ?? this.turnIdByThread.get(event.threadId)
      if (!turnId) return
      const queue = this.queues.get(`${event.threadId}:${turnId}`)
      if (!queue) return
      if (queue.waiter) { const w = queue.waiter; queue.waiter = undefined; w(event) } else { queue.buffer.push(event) }
    }
  }

  private respondNotImplemented(id: number, method: string): void {
    const payload: JsonRpcMessage = { jsonrpc: '2.0', id, error: { code: -32601, message: `client cannot handle ${method}` } }
    this.ws?.send(JSON.stringify(payload))
  }

  private takeEvent(queue: TurnQueue): Promise<AgentStreamEvent> {
    return new Promise<AgentStreamEvent>((resolve, reject) => {
      if (queue.closed) { reject(new Error('queue closed')); return }
      const buffered = queue.buffer.shift()
      if (buffered) { resolve(buffered); return }
      queue.waiter = resolve
    })
  }

  private failAllQueues(error: Error): void {
    for (const queue of this.queues.values()) {
      queue.closed = true
      queue.waiter?.({ type: 'error', threadId: '', error: error.message })
    }
    this.queues.clear()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/agent/__tests__/CodexLocalBackend.test.ts --pool=threads`
Expected: PASS, 6 tests.

- [ ] **Step 5: Re-run prior agent suites to confirm no regression**

Run: `npx vitest run src/main/agent --pool=threads`
Expected: PASS for all agent tests previously green (resolveCodexBinary, codexRuntime smoke, AttachmentService, ipc, AgentManager, codexProtocol, codexLaunch, connectWithRetry, CodexLocalBackend).

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/CodexLocalBackend.ts src/main/agent/__tests__/CodexLocalBackend.test.ts
git commit -m "fix(agent): drive Codex app-server with the real protocol"
```

---

### Task 6: Standalone end-to-end probe script

**Files:**
- Create: `scripts/probe-codex.ts`
- Modify: `package.json` (add `codex:probe` script)

- [ ] **Step 1: Add the npm script**

In `package.json`, in the `scripts` block, add right after `codex:fetch`:

```json
"codex:probe": "tsx scripts/probe-codex.ts",
```

- [ ] **Step 2: Write the probe**

Create `scripts/probe-codex.ts`:

```ts
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { createServer } from 'node:net'
import WebSocket from 'ws'

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required to run the Codex probe.')
    process.exit(2)
  }

  const platform = process.platform
  const arch = process.arch
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  const bin = path.join(process.cwd(), 'resources', 'codex', `${platform}-${arch}`, exe)

  const port = await pickPort()
  console.log(`spawning ${bin} on ws://127.0.0.1:${port}`)
  const proc = spawn(bin, ['app-server', '--listen', `ws://127.0.0.1:${port}`, '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'], { stdio: ['ignore', 'inherit', 'inherit'] })

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const tryConnect = () => {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}`)
      candidate.once('open', () => resolve(candidate))
      candidate.once('error', () => Date.now() < deadline ? setTimeout(tryConnect, 100) : reject(new Error('ws connect timeout')))
    }
    tryConnect()
  })

  let nextId = 0
  const pending = new Map<number, (result: any) => void>()
  let agentText = ''
  let turnId: string | undefined
  let threadId: string | undefined

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.id !== undefined && msg.method === undefined) {
      const cb = pending.get(msg.id)
      if (cb) { pending.delete(msg.id); cb(msg.result ?? msg.error) }
      return
    }
    if (msg.id !== undefined && msg.method) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unhandled ${msg.method}` } }))
      return
    }
    if (msg.method === 'item/agentMessage/delta') { agentText += msg.params.delta; process.stdout.write(msg.params.delta) }
    if (msg.method === 'turn/started') { turnId = msg.params.turn.id }
    if (msg.method === 'turn/completed') { console.log(`\n[turn complete: ${msg.params.turn?.id}]`); shutdown(0) }
    if (msg.method === 'error') { console.error(`\n[codex error] ${msg.params?.error?.message}`); shutdown(1) }
  })

  function rpc<T>(method: string, params: any): Promise<T> {
    const id = ++nextId
    return new Promise((resolve) => { pending.set(id, resolve as any); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })) })
  }

  function shutdown(code: number): void { try { ws.close() } catch {}; try { proc.kill() } catch {}; setTimeout(() => process.exit(code), 100) }

  await rpc('initialize', { clientInfo: { name: 'catimation-probe', version: '0.0.0' }, capabilities: null })
  const thread = await rpc<{ thread: { id: string } }>('thread/start', { sandbox: 'danger-full-access', approvalPolicy: 'never' })
  threadId = thread.thread.id
  console.log(`thread=${threadId}`)
  const turn = await rpc<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word: PONG.', text_elements: [] }] })
  turnId = turn.turn.id
  console.log(`turn=${turnId}\n--- agent reply ---`)

  setTimeout(() => { console.error('\n[probe timeout]'); shutdown(3) }, 60_000)
}

main().catch((error) => { console.error(error); process.exit(1) })
```

- [ ] **Step 3: Run the probe (manual; needs API key)**

Run (PowerShell):

```powershell
$env:OPENAI_API_KEY = "<your-key>"
npm run codex:probe
```

Expected output: prints `thread=...`, `turn=...`, then streams the model's reply (e.g. `PONG`), then `[turn complete: ...]`, then exits 0.

If exit is non-zero, capture the codex stderr lines printed by the spawned process — most failures here are auth-related, not protocol.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-codex.ts package.json
git commit -m "test(agent): add standalone Codex end-to-end probe"
```

---

### Task 7: Manual dev-startup verification

**Files:** none (verification only)

- [ ] **Step 1: Build the renderer + main**

Run: `npm run build:vite`
Expected: build succeeds.

- [ ] **Step 2: Launch the dev app**

Run (separate terminal, PowerShell):

```powershell
$env:OPENAI_API_KEY = "<your-key>"
npm run dev
```

Expected: Electron window opens. Logs in `~/.codex` and the dev console show `initialize` succeeding (or, if the key is missing, a clear `error` notification with auth guidance).

- [ ] **Step 3: Open the agent panel**

In the app window press `Ctrl+Shift+A`. Expected: the right-side `CATIMATION Agent` panel slides in.

- [ ] **Step 4: Send a prompt**

Type `say PONG` in the input, press `Ctrl+Enter`. Expected: assistant message bubble appears and incrementally fills with the streamed reply, ending with `turn_completed`.

- [ ] **Step 5: Cancel mid-turn**

Send `count to 100 slowly`, then click the cancel button while the assistant is still streaming. Expected: `turn/interrupt` request is sent, the stream stops within ~1s, `isRunning` flips to false, and `error` is unset.

- [ ] **Step 6: Record evidence in commit message**

```bash
git commit --allow-empty -m "chore(agent): record manual end-to-end verification

Verified npm run dev + Ctrl+Shift+A panel, send prompt streamed reply, cancel interrupted mid-turn."
```

---

### Task 8: Final test sweep

**Files:** none (verification only)

- [ ] **Step 1: Run all targeted agent unit tests**

Run: `npx vitest run src/main/agent src/renderer/src/features/agent-chat --pool=threads`
Expected: all green.

- [ ] **Step 2: Run the runtime smoke**

Run: `npx vitest run src/main/agent/__tests__/codexRuntime.smoke.test.ts --pool=threads`
Expected: PASS (binary present after Task 6 dev work; otherwise it warns and still passes).

- [ ] **Step 3: Re-run code-review subagent on the diff**

Use the requesting-code-review skill with `BASE_SHA=$(git merge-base origin/main HEAD)` and `HEAD_SHA=$(git rev-parse HEAD)`. Address Critical/Important findings before opening a follow-up commit.

---

## Self-Review

- **Spec coverage:** "fix spawn args" → Task 2 + 5; "WS connect retry" → Task 3 + 5; "real protocol method names + payloads" → Tasks 1, 4, 5; "auto-respond to server-initiated requests so agent doesn't hang" → Task 5 (`respondNotImplemented`); "no permission model" → Task 2 (`approval_policy=never`, `sandbox_mode=danger-full-access`); "end-to-end CLI probe" → Task 6; "manual dev verification" → Task 7. All scope items are claimed by a task.
- **Placeholder scan:** No `TBD`/`later`/`appropriate handling` remains. Every code-bearing step shows the actual code.
- **Type consistency:** `mapServerNotification` (Task 5) is the only function exported from `CodexLocalBackend.ts` for testing; Tasks 1 & 5 agree on `CodexUserInput`, `ThreadStartResponse`, `TurnStartResponse`, `TurnInterruptParams`. `AgentInput['items']` (Task 4) and `mapUserInput` (Task 5) agree on the three variants `text` / `localImage` / `image`. `resolveCodexLaunchArgs` (Task 2) matches the call site in Task 5.
- **Risk acknowledged inline:** auth (`OPENAI_API_KEY`), timeouts (RPC 30s, connect 10s), and unhandled server requests (return JSON-RPC `-32601` so the server proceeds) are all addressed in Task 5.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-codex-backend-end-to-end.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
