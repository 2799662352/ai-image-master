# Codex Thread Sidebar, Persistence Recovery & Context Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, named-thread sidebar pinned to the right of the chat panel (Cursor parity), restore the most recent thread on app startup, wire up the missing rename/delete IPC handlers, and teach Codex its `model_context_window` so the existing token-usage popover can show `% Full` and Codex auto-compacts before hitting the wall.

**Architecture:**
- Most backend pieces (`ThreadStore.renameThread/deleteThread`, `AgentManager.{open,rename,delete}Thread`, preload `agent.{open,rename,delete}Thread` bridges, `AgentTokenUsage.contextWindow`, popover `pctFull` calculation) **already exist** in the codebase. The missing glue is on three precise seams: (1) `ipc.ts` never registered the open/rename/delete handlers, so renderer calls fail with `No handler registered`; (2) `codexLaunch.ts` never passes `model_context_window` / `model_auto_compact_token_limit`, so the `tokenUsage` notifications carry no `contextWindow`; (3) the renderer has no `bootstrap()` and no `ThreadSidebar` component.
- New `ThreadSidebar` is a `position: fixed` `<aside right=0 width=sidebarWidth>` rendered next to (and to the right of) the chat panel. The chat panel's `right` becomes `sidebarOpen ? sidebarWidth : RAIL_WIDTH` so toggling the sidebar slides the chat outward.
- All sidebar UI state (open/width) and thread list refresh logic lives in `useAgentChatStore`. We reuse the existing Zustand store to avoid a parallel state surface.

**Tech Stack:** TypeScript strict, Electron main + preload + renderer, React 18, Zustand, Tailwind CSS, Vitest + @testing-library/react. No new dependencies.

---

## File Map

### New files

| Path | Responsibility |
|---|---|
| `src/renderer/src/features/agent-chat/contextWindowDefaults.ts` | Export `DEFAULT_MODEL_CONTEXT_WINDOW = 200_000` constant shared between renderer fallback paths. |
| `src/renderer/src/features/agent-chat/relativeTime.ts` | Pure helpers: `formatRelativeTime(ms)` and `groupThreadsByRecency(threads, now)` for sidebar grouping (`Today` / `Yesterday` / `Last 7 days` / `Older`). |
| `src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts` | Unit tests for `formatRelativeTime` + `groupThreadsByRecency`. |
| `src/renderer/src/features/agent-chat/ThreadSidebar.tsx` | Right-edge thread list with grouping, `+ New chat`, ⋯ menu, inline rename, inline delete-confirm, drag-resize handle. |
| `src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx` | RTL tests for grouping render, rename, delete-confirm, switch-disabled-while-running. |
| `src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx` | Verifies `bootstrap()` runs once, restores most recent thread, and the panel offsets `right` to `sidebarWidth` when sidebar is open. |
| `src/main/agent/__tests__/ipc.test.ts` | Verifies `agent:open-thread`, `agent:rename-thread`, `agent:delete-thread` are registered and proxy to `AgentManager`. |

### Modified files

| Path | What changes |
|---|---|
| `src/main/agent/codexLaunch.ts` | Append `-c model_context_window=200000` and `-c model_auto_compact_token_limit=180000`. |
| `src/main/agent/__tests__/codexLaunch.test.ts` (or a new test if missing) | Asserts the two new `-c` flags are present. |
| `src/main/agent/ipc.ts` | Register three new handlers: `agent:open-thread`, `agent:rename-thread`, `agent:delete-thread`. |
| `src/types/agent.ts` | Extend `AgentThreadSummary` with optional `lastMessageAt?: string` and `manualTitle?: boolean`. |
| `src/main/agent/ThreadStore.ts` | Project `lastMessageAt` + `manualTitle` in `listThreads()` so the renderer can group + decorate rows. |
| `src/renderer/src/features/agent-chat/tokenSegments.ts` | Add optional `fallbackContextWindow` parameter so `pctFull` still computes when `usage.contextWindow` is missing. |
| `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts` | Add a test for the fallback path. |
| `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx` | Use `DEFAULT_MODEL_CONTEXT_WINDOW` as the fallback denominator when `usage.contextWindow` is missing (so the donut + `%` still appear). |
| `src/renderer/src/features/agent-chat/store.ts` | Add sidebar state (`sidebarOpen`, `sidebarWidth`), `threadList`, `bootstrap()`, `refreshThreadList()`, `toggleSidebar()`, `setSidebarWidth()`, `renameActiveThread()`, `deleteThread()`. Persist sidebar prefs to `localStorage`. Refresh thread list debounced after each `turn_completed`. |
| `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | Bootstrap on first open. Render `<ThreadSidebar />`. Make outer `<aside>` right offset = `sidebarOpen ? sidebarWidth : RAIL_WIDTH`. Add a sidebar toggle in the header. Bind `Cmd/Ctrl+B`. |

---

## Constants Used Across Tasks

```ts
// Stable, referenced by Task 1, Task 5, Task 6, Task 7. Defined once in
// contextWindowDefaults.ts (Task 1) and imported elsewhere — do NOT redeclare.
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000

// Sidebar geometry — defined inline in store.ts (Task 5).
export const SIDEBAR_WIDTH_DEFAULT = 240
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 360
export const SIDEBAR_RAIL_WIDTH = 24
export const SIDEBAR_OPEN_STORAGE_KEY = 'catimation.agent.sidebarOpen'
export const SIDEBAR_WIDTH_STORAGE_KEY = 'catimation.agent.sidebarWidth'

// Thread list refresh debounce — used in store.ts.
export const THREAD_LIST_REFRESH_DEBOUNCE_MS = 500
```

---

## Task 1: Codex context window awareness + renderer fallback

**Files:**
- Modify: `src/main/agent/codexLaunch.ts`
- Test: `src/main/agent/__tests__/codexLaunch.test.ts` (create if absent)
- Create: `src/renderer/src/features/agent-chat/contextWindowDefaults.ts`
- Modify: `src/renderer/src/features/agent-chat/tokenSegments.ts`
- Modify: `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts`
- Modify: `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx`
- Modify: `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx`

### Step 1.1: Add failing test for `codexLaunch` flags

- [ ] Open `src/main/agent/__tests__/codexLaunch.test.ts`. If the file does not yet exist, create it. Add this test:

```ts
import { describe, expect, it } from 'vitest'
import { buildCodexLaunchArgs } from '../codexLaunch'

describe('buildCodexLaunchArgs', () => {
  it('passes model_context_window and model_auto_compact_token_limit so Codex auto-compacts', () => {
    const args = buildCodexLaunchArgs()
    expect(args).toContain('model_context_window=200000')
    expect(args).toContain('model_auto_compact_token_limit=180000')
  })
})
```

### Step 1.2: Run the test, expect failure

- [ ] Run from worktree root:

```bash
npx vitest run src/main/agent/__tests__/codexLaunch.test.ts
```

Expected: FAIL with `expected [ ... ] to contain 'model_context_window=200000'`.

### Step 1.3: Add the two flags to `buildCodexLaunchArgs`

- [ ] In `src/main/agent/codexLaunch.ts`, immediately after the `model_reasoning_summary="auto"` line in the `args` array, insert:

```ts
    // Tell Codex the model's hard context limit so its tokenUsage
    // notifications carry `contextWindow`, and so it auto-compacts before
    // running into a wall. 200K matches GPT-5.5 / GPT-5.4 on apiyi; the
    // auto_compact threshold is 90% of that, the documented Codex default
    // ratio. See https://developers.openai.com/codex/config-advanced.
    '-c', 'model_context_window=200000',
    '-c', 'model_auto_compact_token_limit=180000',
```

### Step 1.4: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run src/main/agent/__tests__/codexLaunch.test.ts
```

Expected: PASS.

### Step 1.5: Create `contextWindowDefaults.ts`

- [ ] Create `src/renderer/src/features/agent-chat/contextWindowDefaults.ts` with exactly:

```ts
/**
 * Renderer-side fallback for the model's hard context window in tokens.
 *
 * Codex normally reports this via `tokenUsage.contextWindow` once the
 * `-c model_context_window=…` flag is in effect (see codexLaunch.ts).
 * Some legacy gateways and very early turns may still arrive without
 * the field — we use this constant so the donut/percent UI can keep
 * functioning instead of falling back to the raw token label.
 *
 * Keep in sync with the `model_context_window` value in
 * `src/main/agent/codexLaunch.ts` (currently 200_000).
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000
```

### Step 1.6: Add failing test for `tokenSegments` fallback

- [ ] In `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts`, append this test inside the existing `describe('buildContextSegments')`:

```ts
  it('uses fallbackContextWindow when usage.contextWindow is missing', () => {
    const result = buildContextSegments(
      { inputTokens: 50_000, outputTokens: 50_000 },
      { fallbackContextWindow: 200_000 },
    )
    expect(result.windowTokens).toBe(200_000)
    expect(result.pctFull).toBe(50)
  })

  it('prefers usage.contextWindow over fallbackContextWindow', () => {
    const result = buildContextSegments(
      { inputTokens: 25_000, outputTokens: 25_000, contextWindow: 100_000 },
      { fallbackContextWindow: 200_000 },
    )
    expect(result.windowTokens).toBe(100_000)
    expect(result.pctFull).toBe(50)
  })
```

### Step 1.7: Run tokenSegments tests, expect failure

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts
```

Expected: 2 FAILs — `buildContextSegments` currently takes a single argument.

### Step 1.8: Extend `buildContextSegments` signature

- [ ] In `src/renderer/src/features/agent-chat/tokenSegments.ts`, replace the function signature and the `windowTokens` / `pctFull` block. Replace this:

```ts
export function buildContextSegments(usage: AgentTokenUsage): ContextSegments {
  const input = Math.max(0, usage.inputTokens ?? 0)
  const output = Math.max(0, usage.outputTokens ?? 0)
  const cachedRaw = Math.max(0, usage.cachedInputTokens ?? 0)
  const reasoningRaw = Math.max(0, usage.reasoningTokens ?? 0)

  const cached = Math.min(cachedRaw, input)
  const conversation = Math.max(input - cached, 0)
  const reasoning = Math.min(reasoningRaw, output)
  const visibleOutput = Math.max(output - reasoning, 0)

  const segments: Segment[] = [
    { key: 'cached', label: 'Cached prompt', color: '#10b981', tokens: cached },
    { key: 'conversation', label: 'Conversation', color: '#f59e0b', tokens: conversation },
    { key: 'reasoning', label: 'Reasoning', color: '#a855f7', tokens: reasoning },
    { key: 'output', label: 'Output', color: '#22d3ee', tokens: visibleOutput },
  ]
  const total = segments.reduce((acc, s) => acc + s.tokens, 0)
  const windowTokens =
    typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : undefined
  const pctFull = windowTokens != null ? Math.round((100 * total) / windowTokens) : undefined

  return { segments, total, windowTokens, pctFull }
}
```

with this:

```ts
export interface BuildContextSegmentsOptions {
  /**
   * Used as the percent-full denominator when `usage.contextWindow` is
   * not reported by the gateway. Pass `DEFAULT_MODEL_CONTEXT_WINDOW`
   * from `contextWindowDefaults.ts`. Optional — when omitted, `pctFull`
   * stays undefined unless `usage.contextWindow` is set, preserving the
   * old behaviour for callers that don't care about the fallback.
   */
  fallbackContextWindow?: number
}

export function buildContextSegments(
  usage: AgentTokenUsage,
  options: BuildContextSegmentsOptions = {},
): ContextSegments {
  const input = Math.max(0, usage.inputTokens ?? 0)
  const output = Math.max(0, usage.outputTokens ?? 0)
  const cachedRaw = Math.max(0, usage.cachedInputTokens ?? 0)
  const reasoningRaw = Math.max(0, usage.reasoningTokens ?? 0)

  const cached = Math.min(cachedRaw, input)
  const conversation = Math.max(input - cached, 0)
  const reasoning = Math.min(reasoningRaw, output)
  const visibleOutput = Math.max(output - reasoning, 0)

  const segments: Segment[] = [
    { key: 'cached', label: 'Cached prompt', color: '#10b981', tokens: cached },
    { key: 'conversation', label: 'Conversation', color: '#f59e0b', tokens: conversation },
    { key: 'reasoning', label: 'Reasoning', color: '#a855f7', tokens: reasoning },
    { key: 'output', label: 'Output', color: '#22d3ee', tokens: visibleOutput },
  ]
  const total = segments.reduce((acc, s) => acc + s.tokens, 0)

  const reportedWindow =
    typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : undefined
  const fallbackWindow =
    typeof options.fallbackContextWindow === 'number' && options.fallbackContextWindow > 0
      ? options.fallbackContextWindow
      : undefined
  const windowTokens = reportedWindow ?? fallbackWindow
  const pctFull = windowTokens != null ? Math.round((100 * total) / windowTokens) : undefined

  return { segments, total, windowTokens, pctFull }
}
```

### Step 1.9: Run tokenSegments tests, expect pass

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts
```

Expected: all (existing + 2 new) tests PASS.

### Step 1.10: Wire fallback through `TokenUsageMeter`

- [ ] In `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx`, replace this block:

```ts
  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  const window = usage.contextWindow
  const ratio = window != null && window > 0 ? Math.min(1, Math.max(0, used / window)) : null
  const pct = ratio != null ? Math.round(ratio * 100) : null
```

with this:

```ts
  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  // Fallback so the donut + percent render even when a gateway omits
  // contextWindow on early turns. Codex 0.128+ should always report it
  // once `model_context_window` is in effect (see codexLaunch.ts).
  const window =
    typeof usage.contextWindow === 'number' && usage.contextWindow > 0
      ? usage.contextWindow
      : DEFAULT_MODEL_CONTEXT_WINDOW
  const ratio = window > 0 ? Math.min(1, Math.max(0, used / window)) : null
  const pct = ratio != null ? Math.round(ratio * 100) : null
```

- [ ] At the top of the same file, add this import (immediately after the existing `import type { AgentTokenUsage }` line):

```ts
import { DEFAULT_MODEL_CONTEXT_WINDOW } from './contextWindowDefaults'
```

- [ ] Pass the same fallback through to the popover. Find the JSX:

```tsx
      {open ? (
        <ContextPopover usage={usage} onClose={() => setOpen(false)} triggerRef={triggerRef} />
      ) : null}
```

and replace with:

```tsx
      {open ? (
        <ContextPopover
          usage={usage}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fallbackContextWindow={DEFAULT_MODEL_CONTEXT_WINDOW}
        />
      ) : null}
```

### Step 1.11: Thread `fallbackContextWindow` into `ContextPopover`

- [ ] In `src/renderer/src/features/agent-chat/ContextPopover.tsx`, locate the existing `interface ContextPopoverProps { ... }` block (lines 7–18). **Do NOT replace it whole — only insert one new field** so we keep the existing `RefObject<HTMLElement | null>` constraint intact.

  Find this line inside the interface:

```ts
  triggerRef?: RefObject<HTMLElement | null>
```

  and replace it with:

```ts
  triggerRef?: RefObject<HTMLElement | null>
  /**
   * Used as the percent-full denominator when `usage.contextWindow` is
   * not reported by Codex. Forwarded to `buildContextSegments` so the
   * popover's `% Full` line stays meaningful even on early turns. When
   * omitted, the popover preserves its previous "no window → no pctFull"
   * behaviour.
   */
  fallbackContextWindow?: number
```

- [ ] Then update the function signature on line 31. Replace this:

```ts
export function ContextPopover({ usage, onClose, triggerRef }: ContextPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const ctx = buildContextSegments(usage)
```

  with this:

```ts
export function ContextPopover({ usage, onClose, triggerRef, fallbackContextWindow }: ContextPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const ctx = buildContextSegments(usage, { fallbackContextWindow })
```

  Leave every other line in the file untouched.

### Step 1.12: Add failing test that the meter shows a percent even without `usage.contextWindow`

- [ ] In `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx`, append:

```tsx
  it('renders a percent using DEFAULT_MODEL_CONTEXT_WINDOW when usage.contextWindow is missing', () => {
    render(<TokenUsageMeter usage={{ inputTokens: 50_000, outputTokens: 50_000 }} />)
    // 100_000 / 200_000 = 50%
    expect(screen.getByRole('button')).toHaveTextContent('50%')
  })
```

### Step 1.13: Run TokenUsageMeter tests, expect pass

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx
```

Expected: all tests PASS, including the new fallback test.

### Step 1.14: Commit

- [ ] Run:

```bash
git add src/main/agent/codexLaunch.ts src/main/agent/__tests__/codexLaunch.test.ts \
  src/renderer/src/features/agent-chat/contextWindowDefaults.ts \
  src/renderer/src/features/agent-chat/tokenSegments.ts \
  src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts \
  src/renderer/src/features/agent-chat/TokenUsageMeter.tsx \
  src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx \
  src/renderer/src/features/agent-chat/ContextPopover.tsx
git commit -m "feat(agent): teach Codex its context window and add renderer fallback so % Full always renders"
```

---

## Task 2: IPC handlers for thread management

**Files:**
- Modify: `src/main/agent/ipc.ts`
- Create: `src/main/agent/__tests__/ipc.test.ts`

### Step 2.1: Write failing test

- [ ] Create `src/main/agent/__tests__/ipc.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
      on: (_channel: string, _handler: unknown) => undefined,
      __getHandler: (channel: string) => handlers.get(channel),
      __reset: () => handlers.clear(),
    },
  }
})

import { ipcMain } from 'electron'
import { registerAgentIpc } from '../ipc'

interface FakeManager {
  openThread: ReturnType<typeof vi.fn>
  renameThread: ReturnType<typeof vi.fn>
  deleteThread: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  listThreads: ReturnType<typeof vi.fn>
  loadThread: ReturnType<typeof vi.fn>
  setCodexApiKey: ReturnType<typeof vi.fn>
  testConnection: ReturnType<typeof vi.fn>
}

function makeManager(): FakeManager {
  return {
    openThread: vi.fn().mockResolvedValue({ id: 't1' }),
    renameThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    cancel: vi.fn(),
    listThreads: vi.fn(),
    loadThread: vi.fn(),
    setCodexApiKey: vi.fn(),
    testConnection: vi.fn(),
  }
}

const router = { handleRendererResponse: vi.fn() } as unknown as {
  handleRendererResponse: (response: unknown) => void
}

const get = (channel: string): ((...args: unknown[]) => unknown) | undefined => {
  return (ipcMain as unknown as { __getHandler: (c: string) => ((...a: unknown[]) => unknown) | undefined })
    .__getHandler(channel)
}

describe('registerAgentIpc thread management handlers', () => {
  let manager: FakeManager

  beforeEach(() => {
    ;(ipcMain as unknown as { __reset: () => void }).__reset()
    manager = makeManager()
    registerAgentIpc(manager as unknown as Parameters<typeof registerAgentIpc>[0], router as unknown as Parameters<typeof registerAgentIpc>[1])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers agent:open-thread and forwards the threadId', async () => {
    const handler = get('agent:open-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc')
    expect(manager.openThread).toHaveBeenCalledWith('thread-abc')
  })

  it('registers agent:rename-thread and forwards id + title', async () => {
    const handler = get('agent:rename-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc', 'New title')
    expect(manager.renameThread).toHaveBeenCalledWith('thread-abc', 'New title')
  })

  it('registers agent:delete-thread and forwards the id', async () => {
    const handler = get('agent:delete-thread')
    expect(handler).toBeTypeOf('function')
    await handler!({}, 'thread-abc')
    expect(manager.deleteThread).toHaveBeenCalledWith('thread-abc')
  })
})
```

### Step 2.2: Run, expect failure

- [ ] Run:

```bash
npx vitest run src/main/agent/__tests__/ipc.test.ts
```

Expected: 3 FAILs — handlers undefined.

### Step 2.3: Register the three handlers

- [ ] In `src/main/agent/ipc.ts`, find this block:

```ts
  ipcMain.handle('agent:list-threads', () => manager.listThreads())
  ipcMain.handle('agent:load-thread', (_event, threadId: string) => manager.loadThread(threadId))
```

and append directly after it:

```ts
  ipcMain.handle('agent:open-thread', (_event, threadId: string) => manager.openThread(threadId))
  ipcMain.handle('agent:rename-thread', (_event, threadId: string, title: string) =>
    manager.renameThread(threadId, title),
  )
  ipcMain.handle('agent:delete-thread', (_event, threadId: string) => manager.deleteThread(threadId))
```

### Step 2.4: Run, expect pass

- [ ] Run:

```bash
npx vitest run src/main/agent/__tests__/ipc.test.ts
```

Expected: all 3 PASS.

### Step 2.5: Commit

- [ ] Run:

```bash
git add src/main/agent/ipc.ts src/main/agent/__tests__/ipc.test.ts
git commit -m "fix(agent): register open/rename/delete-thread IPC handlers (renderer was getting No handler registered)"
```

---

## Task 3: Extend `AgentThreadSummary` with `lastMessageAt` + `manualTitle` and project them in `ThreadStore`

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/ThreadStore.ts`
- Modify: `src/main/agent/__tests__/ThreadStore.test.ts` (or create)

### Step 3.1: Write failing test

- [ ] In `src/main/agent/__tests__/ThreadStore.test.ts` (create the file if it does not yet exist; if it does, append), add:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ThreadStore } from '../ThreadStore'

describe('ThreadStore.listThreads', () => {
  it('returns lastMessageAt and manualTitle on each row', async () => {
    const fakeRows = [
      {
        id: 't1',
        title: 'First',
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-07T10:00:00Z'),
        lastMessageAt: new Date('2026-05-07T10:00:00Z'),
        manualTitle: false,
      },
    ]
    const prisma = {
      agentThread: {
        findMany: vi.fn().mockResolvedValue(fakeRows),
      },
    } as unknown as ConstructorParameters<typeof ThreadStore>[0]
    const store = new ThreadStore(prisma)
    const result = await store.listThreads()
    expect(result[0]).toMatchObject({
      id: 't1',
      title: 'First',
      lastMessageAt: fakeRows[0].lastMessageAt,
      manualTitle: false,
    })
  })
})
```

### Step 3.2: Run, expect failure

- [ ] Run:

```bash
npx vitest run src/main/agent/__tests__/ThreadStore.test.ts
```

Expected: depends on existing Prisma row shape — usually FAIL because `findMany` is called without explicit `select`/`orderBy` choices that surface `lastMessageAt`. (The test verifies the projection, not just the call.)

### Step 3.3: Update `listThreads` to order by `lastMessageAt` and surface needed fields

- [ ] In `src/main/agent/ThreadStore.ts`, replace this:

```ts
  async listThreads() {
    return this.prisma.agentThread.findMany({ orderBy: { updatedAt: 'desc' } })
  }
```

with this:

```ts
  async listThreads() {
    // Order by lastMessageAt so empty threads (no messages yet) sink to the
    // bottom; fall back to updatedAt for rows whose lastMessageAt is still
    // null (Prisma sorts nulls to the end of `desc` by default).
    return this.prisma.agentThread.findMany({
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    })
  }
```

### Step 3.4: Extend `AgentThreadSummary` type

- [ ] In `src/types/agent.ts`, replace this block:

```ts
export interface AgentThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}
```

with this:

```ts
export interface AgentThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /**
   * ISO timestamp of the most recent persisted message in the thread.
   * Drives sidebar grouping ("Today" / "Yesterday" / etc). Optional because
   * a brand-new empty thread has none yet.
   */
  lastMessageAt?: string | null
  /**
   * `true` once the user manually renamed the thread. Sidebar uses this to
   * skip auto-title summarization side-effects and to show a small "✎" hint.
   */
  manualTitle?: boolean
}
```

### Step 3.5: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run src/main/agent/__tests__/ThreadStore.test.ts
```

Expected: PASS.

### Step 3.6: Commit

- [ ] Run:

```bash
git add src/types/agent.ts src/main/agent/ThreadStore.ts src/main/agent/__tests__/ThreadStore.test.ts
git commit -m "feat(agent): expose lastMessageAt and manualTitle on AgentThreadSummary so the sidebar can group and decorate"
```

---

## Task 4: `relativeTime.ts` — pure helpers for sidebar grouping

**Files:**
- Create: `src/renderer/src/features/agent-chat/relativeTime.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts`

### Step 4.1: Write failing tests

- [ ] Create `src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatRelativeTime, groupThreadsByRecency } from '../relativeTime'
import type { AgentThreadSummary } from '../../../../../types/agent'

const NOW = new Date('2026-05-07T15:00:00Z').getTime()

function thread(id: string, lastMessageAt: string | null): AgentThreadSummary {
  return {
    id,
    title: id,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: lastMessageAt ?? '2026-05-01T00:00:00Z',
    lastMessageAt: lastMessageAt ?? undefined,
  }
}

describe('formatRelativeTime', () => {
  it('renders "just now" for under 60s', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now')
  })

  it('renders Nm for under 60min', () => {
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toBe('12m ago')
  })

  it('renders Nh for under 24h', () => {
    expect(formatRelativeTime(NOW - 5 * 60 * 60_000, NOW)).toBe('5h ago')
  })

  it('renders Nd for >= 24h and < 7d', () => {
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3d ago')
  })

  it('renders ISO date for >= 7d', () => {
    const ts = new Date('2026-04-01T00:00:00Z').getTime()
    expect(formatRelativeTime(ts, NOW)).toBe('2026-04-01')
  })

  it('renders "—" for null/undefined timestamps', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—')
    expect(formatRelativeTime(undefined, NOW)).toBe('—')
  })
})

describe('groupThreadsByRecency', () => {
  it('groups threads into Today / Yesterday / Last 7 days / Older buckets', () => {
    const threads = [
      thread('today',     new Date(NOW - 1 * 60 * 60_000).toISOString()),     // 1h ago
      thread('yesterday', new Date(NOW - 30 * 60 * 60_000).toISOString()),    // 30h ago
      thread('week',      new Date(NOW - 5 * 24 * 60 * 60_000).toISOString()),// 5 days ago
      thread('older',     new Date(NOW - 60 * 24 * 60 * 60_000).toISOString()),// 60 days ago
    ]
    const groups = groupThreadsByRecency(threads, NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Older'])
    expect(groups[0].threads.map((t) => t.id)).toEqual(['today'])
    expect(groups[1].threads.map((t) => t.id)).toEqual(['yesterday'])
    expect(groups[2].threads.map((t) => t.id)).toEqual(['week'])
    expect(groups[3].threads.map((t) => t.id)).toEqual(['older'])
  })

  it('omits empty groups', () => {
    const groups = groupThreadsByRecency([thread('only', new Date(NOW).toISOString())], NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today'])
  })

  it('threads without lastMessageAt fall into "Older"', () => {
    const groups = groupThreadsByRecency([thread('orphan', null)], NOW)
    expect(groups[0].label).toBe('Older')
    expect(groups[0].threads[0].id).toBe('orphan')
  })
})
```

### Step 4.2: Run tests, expect failure

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts
```

Expected: file-not-found / module-not-found errors for `'../relativeTime'`.

### Step 4.3: Implement `relativeTime.ts`

- [ ] Create `src/renderer/src/features/agent-chat/relativeTime.ts`:

```ts
import type { AgentThreadSummary } from '../../../../types/agent'

/** Local-time start-of-day for a given epoch ms. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Render a short relative time like Cursor's sidebar — "just now", "12m ago", "5h ago", "3d ago", or ISO date. */
export function formatRelativeTime(ts: number | string | null | undefined, now: number = Date.now()): string {
  if (ts == null) return '—'
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!Number.isFinite(ms)) return '—'

  const diff = now - ms
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(diff / (60 * 60_000))
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(diff / (24 * 60 * 60_000))
  if (days < 7) return `${days}d ago`
  // >= 7 days: show ISO date so users can scan timestamps without ambiguity
  return new Date(ms).toISOString().slice(0, 10)
}

export interface ThreadGroup {
  label: 'Today' | 'Yesterday' | 'Last 7 days' | 'Older'
  threads: AgentThreadSummary[]
}

/**
 * Bucket threads into Cursor-style sidebar groups by `lastMessageAt`. Threads
 * without `lastMessageAt` always land in `Older` so the active groups stay
 * meaningful. Each bucket preserves the input order (caller is expected to
 * have already sorted by recency).
 */
export function groupThreadsByRecency(
  threads: ReadonlyArray<AgentThreadSummary>,
  now: number = Date.now(),
): ThreadGroup[] {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 24 * 60 * 60_000
  const weekStart = todayStart - 7 * 24 * 60 * 60_000

  const today: AgentThreadSummary[] = []
  const yesterday: AgentThreadSummary[] = []
  const week: AgentThreadSummary[] = []
  const older: AgentThreadSummary[] = []

  for (const t of threads) {
    const raw = t.lastMessageAt
    const ts = raw == null ? null : Date.parse(raw)
    if (ts == null || !Number.isFinite(ts)) {
      older.push(t)
      continue
    }
    if (ts >= todayStart) today.push(t)
    else if (ts >= yesterdayStart) yesterday.push(t)
    else if (ts >= weekStart) week.push(t)
    else older.push(t)
  }

  const out: ThreadGroup[] = []
  if (today.length) out.push({ label: 'Today', threads: today })
  if (yesterday.length) out.push({ label: 'Yesterday', threads: yesterday })
  if (week.length) out.push({ label: 'Last 7 days', threads: week })
  if (older.length) out.push({ label: 'Older', threads: older })
  return out
}
```

### Step 4.4: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts
```

Expected: all 9 tests PASS.

### Step 4.5: Commit

- [ ] Run:

```bash
git add src/renderer/src/features/agent-chat/relativeTime.ts \
  src/renderer/src/features/agent-chat/__tests__/relativeTime.test.ts
git commit -m "feat(agent): add relativeTime helpers (formatRelativeTime + groupThreadsByRecency)"
```

---

## Task 5: Store — sidebar state, bootstrap, thread management actions

**Files:**
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify (or create) tests: `src/renderer/src/features/agent-chat/__tests__/store.bootstrap.test.ts`, `src/renderer/src/features/agent-chat/__tests__/store.sidebar.test.ts`

### Step 5.1: Write failing test for `bootstrap()`

- [ ] Create `src/renderer/src/features/agent-chat/__tests__/store.bootstrap.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeAgentApi = {
  listThreads: vi.fn(),
  openThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
}

beforeEach(async () => {
  vi.resetModules()
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgentApi } } }).window = {
    electronAPI: { agent: fakeAgentApi },
  }
  fakeAgentApi.listThreads.mockReset()
  fakeAgentApi.openThread.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bootstrap()', () => {
  it('lists threads, switches to the most recent one, and stores the list', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([
      { id: 'recent', title: 'Recent', createdAt: '', updatedAt: '', lastMessageAt: '2026-05-07T10:00:00Z' },
      { id: 'older',  title: 'Older',  createdAt: '', updatedAt: '', lastMessageAt: '2026-05-01T10:00:00Z' },
    ])
    fakeAgentApi.openThread.mockResolvedValue({ id: 'recent', messages: [] })

    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()

    expect(fakeAgentApi.listThreads).toHaveBeenCalledTimes(1)
    expect(fakeAgentApi.openThread).toHaveBeenCalledWith('recent')
    expect(useAgentChatStore.getState().threadList.map((t) => t.id)).toEqual(['recent', 'older'])
    expect(useAgentChatStore.getState().threadId).toBe('recent')
  })

  it('does nothing destructive when there are no threads', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([])
    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()
    expect(fakeAgentApi.openThread).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(useAgentChatStore.getState().threadList).toEqual([])
  })

  it('is a no-op on second call (already bootstrapped)', async () => {
    fakeAgentApi.listThreads.mockResolvedValue([
      { id: 't1', title: 'T1', createdAt: '', updatedAt: '', lastMessageAt: '2026-05-07T10:00:00Z' },
    ])
    fakeAgentApi.openThread.mockResolvedValue({ id: 't1', messages: [] })
    const { useAgentChatStore } = await import('../store')
    await useAgentChatStore.getState().bootstrap()
    await useAgentChatStore.getState().bootstrap()
    expect(fakeAgentApi.listThreads).toHaveBeenCalledTimes(1)
  })
})
```

### Step 5.2: Write failing test for sidebar state

- [ ] Create `src/renderer/src/features/agent-chat/__tests__/store.sidebar.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
  globalThis.localStorage?.clear()
})

describe('sidebar state', () => {
  it('toggleSidebar flips sidebarOpen and persists to localStorage', async () => {
    const { useAgentChatStore } = await import('../store')
    const initial = useAgentChatStore.getState().sidebarOpen
    useAgentChatStore.getState().toggleSidebar()
    expect(useAgentChatStore.getState().sidebarOpen).toBe(!initial)
    expect(globalThis.localStorage?.getItem('catimation.agent.sidebarOpen'))
      .toBe(String(!initial))
  })

  it('setSidebarWidth clamps to [200, 360] and persists', async () => {
    const { useAgentChatStore } = await import('../store')
    useAgentChatStore.getState().setSidebarWidth(50)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(200)
    useAgentChatStore.getState().setSidebarWidth(9999)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(360)
    useAgentChatStore.getState().setSidebarWidth(280)
    expect(useAgentChatStore.getState().sidebarWidth).toBe(280)
    expect(globalThis.localStorage?.getItem('catimation.agent.sidebarWidth')).toBe('280')
  })
})
```

### Step 5.3: Run tests, expect failure

- [ ] Run:

```bash
npx vitest run \
  src/renderer/src/features/agent-chat/__tests__/store.bootstrap.test.ts \
  src/renderer/src/features/agent-chat/__tests__/store.sidebar.test.ts
```

Expected: both files FAIL — `bootstrap`, `toggleSidebar`, `setSidebarWidth`, `threadList`, `sidebarOpen`, `sidebarWidth` are not on the store.

### Step 5.4: Extend the store

- [ ] In `src/renderer/src/features/agent-chat/store.ts`, **at the top of the file** add the new constants right below the existing `PANEL_WIDTH_*` block (around line 14–18):

```ts
const SIDEBAR_OPEN_STORAGE_KEY = 'catimation.agent.sidebarOpen'
const SIDEBAR_WIDTH_STORAGE_KEY = 'catimation.agent.sidebarWidth'
const SIDEBAR_WIDTH_DEFAULT = 240
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 360
const SIDEBAR_OPEN_DEFAULT = true
const THREAD_LIST_REFRESH_DEBOUNCE_MS = 500
```

- [ ] Add three persistence helpers right under `readPersistedPanelWidth` (around line 48):

```ts
function readPersistedSidebarOpen(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_OPEN_STORAGE_KEY)
    if (raw == null) return SIDEBAR_OPEN_DEFAULT
    return raw === 'true'
  } catch {
    return SIDEBAR_OPEN_DEFAULT
  }
}

function readPersistedSidebarWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return SIDEBAR_WIDTH_DEFAULT
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < SIDEBAR_WIDTH_MIN || n > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_DEFAULT
    return n
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

function persistSidebarOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
  } catch {
    /* localStorage unavailable; silently ignore */
  }
}

function persistSidebarWidth(w: number): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(w))
  } catch {
    /* localStorage unavailable; silently ignore */
  }
}
```

- [ ] Replace the existing `AgentElectronApi` block (around line 50–55) with one that also covers the new methods:

```ts
type AgentElectronApi = {
  agent?: {
    sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
    cancel: (payload: AgentCancelPayload) => Promise<unknown>
    listThreads?: () => Promise<AgentThreadSummary[]>
    openThread?: (id: string) => Promise<unknown>
    renameThread?: (id: string, title: string) => Promise<void>
    deleteThread?: (id: string) => Promise<void>
  }
}
```

- [ ] Add `import type { AgentThreadSummary } from '../../../../types/agent'` to the existing `import type { ... }` block at the top.

- [ ] Extend the `AgentChatState` interface (around line 63). Replace the closing brace's preceding lines (you'll insert before `applyEvent`):

  Replace this snippet:

```ts
  cancel: () => Promise<void>
  newThread: () => void
  switchThread: (threadId: string) => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void
}
```

  with:

```ts
  cancel: () => Promise<void>
  newThread: () => void
  switchThread: (threadId: string) => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void

  // ----- Sidebar / thread list -----
  sidebarOpen: boolean
  sidebarWidth: number
  threadList: AgentThreadSummary[]
  threadListLoading: boolean
  bootstrapped: boolean

  bootstrap: () => Promise<void>
  refreshThreadList: () => Promise<void>
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  renameActiveThread: (title: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
}
```

- [ ] Inside `create<AgentChatState>((set, get) => ({` (around line 215), **after the existing `panelWidth: readPersistedPanelWidth(),` line**, add:

```ts
  sidebarOpen: readPersistedSidebarOpen(),
  sidebarWidth: readPersistedSidebarWidth(),
  threadList: [],
  threadListLoading: false,
  bootstrapped: false,
```

- [ ] At the bottom of the store object, locate the closing `}))` of the `create<AgentChatState>((set, get) => ({ ... }))` call. Immediately above that line — and after the trailing comma that already terminates the `applyEvent: (event) => { ... },` block — append:

```ts
  bootstrap: async () => {
    if (get().bootstrapped) return
    set({ bootstrapped: true, threadListLoading: true })
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.listThreads) {
      set({ threadListLoading: false })
      return
    }
    try {
      const list = await agent.listThreads()
      set({ threadList: list })
      const top = list[0]
      if (top && agent.openThread) {
        await get().switchThread(top.id)
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ threadListLoading: false })
    }
  },

  refreshThreadList: async () => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.listThreads) return
    try {
      const list = await agent.listThreads()
      set({ threadList: list })
    } catch {
      /* swallow refresh errors — stale list is preferable to a banner */
    }
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen
    persistSidebarOpen(next)
    set({ sidebarOpen: next })
  },

  setSidebarWidth: (width) => {
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
    persistSidebarWidth(clamped)
    set({ sidebarWidth: clamped })
  },

  renameActiveThread: async (title) => {
    const id = get().threadId
    if (!id) return
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.renameThread) return
    await agent.renameThread(id, trimmed)
    await get().refreshThreadList()
  },

  deleteThread: async (threadId) => {
    const agent = (window as Window & { electronAPI?: AgentElectronApi }).electronAPI?.agent
    if (!agent?.deleteThread) return
    await agent.deleteThread(threadId)
    if (get().threadId === threadId) {
      // Drop into the empty-thread state and let the user pick another row.
      set({ threadId: undefined, messages: [], tokenUsage: undefined, error: undefined, isRunning: false })
    }
    await get().refreshThreadList()
  },
```

- [ ] Schedule a debounced `refreshThreadList()` call after every `turn_completed`. Find the `case 'turn_completed':` block inside `applyEvent` (around line 452):

```ts
      case 'turn_completed':
        set({ isRunning: false })
        break
```

  and replace with:

```ts
      case 'turn_completed':
        set({ isRunning: false })
        scheduleThreadListRefresh(() => void get().refreshThreadList())
        break
```

- [ ] **At module scope** (top of the file, right under the imports), add the debounce machinery:

```ts
let threadListRefreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleThreadListRefresh(run: () => void): void {
  if (threadListRefreshTimer) clearTimeout(threadListRefreshTimer)
  threadListRefreshTimer = setTimeout(() => {
    threadListRefreshTimer = null
    run()
  }, THREAD_LIST_REFRESH_DEBOUNCE_MS)
}
```

### Step 5.5: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run \
  src/renderer/src/features/agent-chat/__tests__/store.bootstrap.test.ts \
  src/renderer/src/features/agent-chat/__tests__/store.sidebar.test.ts
```

Expected: all tests in both files PASS.

### Step 5.6: Commit

- [ ] Run:

```bash
git add src/renderer/src/features/agent-chat/store.ts \
  src/renderer/src/features/agent-chat/__tests__/store.bootstrap.test.ts \
  src/renderer/src/features/agent-chat/__tests__/store.sidebar.test.ts
git commit -m "feat(agent): bootstrap, sidebar state, and rename/delete actions in chat store"
```

---

## Task 6: `ThreadSidebar` component

**Files:**
- Create: `src/renderer/src/features/agent-chat/ThreadSidebar.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx`

### Step 6.1: Write failing tests

- [ ] Create `src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadSidebar } from '../ThreadSidebar'
import { useAgentChatStore } from '../store'

const fakeAgent = {
  listThreads: vi.fn(),
  openThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgent } } }).window = {
    electronAPI: { agent: fakeAgent },
  }
  fakeAgent.renameThread.mockResolvedValue(undefined)
  fakeAgent.deleteThread.mockResolvedValue(undefined)
  fakeAgent.listThreads.mockResolvedValue([])
  useAgentChatStore.setState({
    threadId: 'today-1',
    threadList: [
      {
        id: 'today-1',
        title: 'Today thread',
        createdAt: '',
        updatedAt: '',
        lastMessageAt: new Date().toISOString(),
      },
      {
        id: 'older-1',
        title: 'Older thread',
        createdAt: '',
        updatedAt: '',
        lastMessageAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
      },
    ],
    sidebarOpen: true,
    sidebarWidth: 240,
    isRunning: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ThreadSidebar', () => {
  it('renders a Today group and an Older group with their threads', () => {
    render(<ThreadSidebar />)
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.getByText('Today thread')).toBeInTheDocument()
    expect(screen.getByText('Older thread')).toBeInTheDocument()
  })

  it('clicking + New chat resets to the empty thread', () => {
    render(<ThreadSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }))
    expect(useAgentChatStore.getState().threadId).toBeUndefined()
    expect(useAgentChatStore.getState().messages).toEqual([])
  })

  it('inline rename: double-click title, edit, Enter', async () => {
    render(<ThreadSidebar />)
    fireEvent.doubleClick(screen.getByText('Today thread'))
    const input = screen.getByLabelText(/rename thread/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(fakeAgent.renameThread).toHaveBeenCalledWith('today-1', 'Renamed')
    })
  })

  it('inline delete confirm: ⋯ → Delete → confirm', async () => {
    render(<ThreadSidebar />)
    // Open ⋯ menu for the older thread (use a stable test id so we never
    // collide with the Today menu).
    fireEvent.click(screen.getByTestId('thread-menu-older-1'))
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    // Confirm step appears in place
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => {
      expect(fakeAgent.deleteThread).toHaveBeenCalledWith('older-1')
    })
  })

  it('disables row click while a turn is running', () => {
    useAgentChatStore.setState({ isRunning: true })
    render(<ThreadSidebar />)
    const row = screen.getByText('Older thread').closest('button')
    expect(row).toBeDisabled()
  })

  it('renders nothing when sidebarOpen is false', () => {
    useAgentChatStore.setState({ sidebarOpen: false })
    const { container } = render(<ThreadSidebar />)
    expect(container.firstChild).toBeNull()
  })
})
```

### Step 6.2: Run tests, expect failure

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx
```

Expected: module-not-found error for `'../ThreadSidebar'`.

### Step 6.3: Implement `ThreadSidebar`

- [ ] Create `src/renderer/src/features/agent-chat/ThreadSidebar.tsx`:

```tsx
import { useCallback, useMemo, useRef, useState } from 'react'
import type { AgentThreadSummary } from '../../../../types/agent'
import { groupThreadsByRecency, formatRelativeTime, type ThreadGroup } from './relativeTime'
import { useAgentChatStore } from './store'

const RAIL_WIDTH = 24

/**
 * Right-edge thread sidebar. Pinned to `right: 0` so it always sits on the
 * screen edge — the chat panel is responsible for offsetting its own `right`
 * by `sidebarWidth` (or RAIL_WIDTH when collapsed) to make room.
 *
 * Renders nothing at all when `sidebarOpen` is false; the parent can show a
 * 24px rail with an expand button instead.
 */
export function ThreadSidebar(): JSX.Element | null {
  const sidebarOpen = useAgentChatStore((s) => s.sidebarOpen)
  const sidebarWidth = useAgentChatStore((s) => s.sidebarWidth)
  const threadList = useAgentChatStore((s) => s.threadList)
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const threadId = useAgentChatStore((s) => s.threadId)
  const newThread = useAgentChatStore((s) => s.newThread)
  const switchThread = useAgentChatStore((s) => s.switchThread)
  const renameActiveThread = useAgentChatStore((s) => s.renameActiveThread)
  const deleteThread = useAgentChatStore((s) => s.deleteThread)
  const toggleSidebar = useAgentChatStore((s) => s.toggleSidebar)

  const groups: ThreadGroup[] = useMemo(() => groupThreadsByRecency(threadList), [threadList])

  if (!sidebarOpen) return null

  return (
    <aside
      data-testid="thread-sidebar"
      className="fixed top-0 right-0 z-[40000] flex h-screen flex-col border-l border-zinc-800/80 bg-zinc-950/95 text-zinc-200 backdrop-blur"
      style={{ width: sidebarWidth }}
    >
      <header className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">Threads</span>
        <button
          type="button"
          onClick={() => newThread()}
          className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/20"
          title="Start a new chat"
        >
          + New chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-zinc-500">No threads yet.</p>
        ) : (
          groups.map((group) => (
            <ThreadGroupSection
              key={group.label}
              group={group}
              activeThreadId={threadId}
              isRunning={isRunning}
              onSwitch={switchThread}
              onRename={renameActiveThread}
              onDelete={deleteThread}
            />
          ))
        )}
      </div>

      <footer className="border-t border-zinc-800/80 px-3 py-2">
        <button
          type="button"
          onClick={() => toggleSidebar()}
          className="text-[10px] text-zinc-500 hover:text-zinc-200"
          aria-label="Collapse sidebar"
        >
          ▶ collapse ({RAIL_WIDTH}px rail)
        </button>
      </footer>
    </aside>
  )
}

interface ThreadGroupSectionProps {
  group: ThreadGroup
  activeThreadId: string | undefined
  isRunning: boolean
  onSwitch: (id: string) => Promise<void> | void
  onRename: (title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function ThreadGroupSection(props: ThreadGroupSectionProps): JSX.Element {
  return (
    <section>
      <h3 className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.24em] text-zinc-500">
        {props.group.label}
      </h3>
      <ul className="px-1 pb-2">
        {props.group.threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === props.activeThreadId}
            isRunning={props.isRunning}
            onSwitch={props.onSwitch}
            onRename={props.onRename}
            onDelete={props.onDelete}
          />
        ))}
      </ul>
    </section>
  )
}

interface ThreadRowProps {
  thread: AgentThreadSummary
  active: boolean
  isRunning: boolean
  onSwitch: (id: string) => Promise<void> | void
  onRename: (title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

type RowMode = 'idle' | 'menu' | 'rename' | 'confirm-delete'

function ThreadRow(props: ThreadRowProps): JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [draftTitle, setDraftTitle] = useState(props.thread.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const disabled = props.isRunning && !props.active

  const startRename = useCallback(() => {
    setDraftTitle(props.thread.title)
    setMode('rename')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [props.thread.title])

  const commitRename = useCallback(async () => {
    const next = draftTitle.trim()
    setMode('idle')
    if (!next || next === props.thread.title) return
    if (!props.active) {
      // Renaming a non-active thread — switch to it first so renameActiveThread targets it.
      await props.onSwitch(props.thread.id)
    }
    await props.onRename(next)
  }, [draftTitle, props])

  return (
    <li className="group relative">
      {mode === 'rename' ? (
        <div className="flex items-center gap-1 px-2 py-1.5">
          <input
            ref={inputRef}
            aria-label="Rename thread"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setMode('idle')
              }
            }}
            className="w-full rounded border border-cyan-400/40 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none"
          />
        </div>
      ) : mode === 'confirm-delete' ? (
        <div className="flex items-center justify-between gap-1 px-2 py-1.5 text-[11px] text-red-200">
          <span className="truncate">Delete "{props.thread.title}"?</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                setMode('idle')
                await props.onDelete(props.thread.id)
              }}
              className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-100 hover:bg-red-500/40"
            >
              Delete
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (props.active) return
              void props.onSwitch(props.thread.id)
            }}
            onDoubleClick={() => startRename()}
            title={props.thread.title}
            className={[
              'flex flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] transition',
              props.active ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-200 hover:bg-zinc-800/60',
              disabled ? 'cursor-not-allowed opacity-40' : '',
              props.active ? 'border-l-2 border-cyan-400' : '',
            ].join(' ')}
          >
            <span className="truncate">{props.thread.title}</span>
            <span className="shrink-0 text-[10px] text-zinc-500">
              {formatRelativeTime(props.thread.lastMessageAt)}
            </span>
          </button>
          <button
            type="button"
            data-testid={`thread-menu-${props.thread.id}`}
            aria-label={`Thread actions for ${props.thread.title}`}
            onClick={() => setMode((m) => (m === 'menu' ? 'idle' : 'menu'))}
            className="px-1.5 text-zinc-500 hover:text-zinc-200"
          >
            ⋯
          </button>
          {mode === 'menu' ? (
            <div
              role="menu"
              className="absolute right-1 top-full z-10 mt-1 min-w-[120px] rounded border border-zinc-800 bg-zinc-950/95 py-1 text-[12px] text-zinc-200 shadow-xl"
              onMouseLeave={() => setMode('idle')}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMode('idle')
                  startRename()
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-zinc-800/60"
              >
                Rename
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => setMode('confirm-delete')}
                className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-zinc-800/60"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      )}
    </li>
  )
}
```

### Step 6.4: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx
```

Expected: all 6 tests PASS. If the menu test fails because of timing, the menu's `onMouseLeave` may close it before `getByRole('menuitem')` resolves — `fireEvent.click` on the trigger (instead of `mouseDown`/`mouseUp`) keeps the menu open in jsdom because there's no real pointer.

### Step 6.5: Commit

- [ ] Run:

```bash
git add src/renderer/src/features/agent-chat/ThreadSidebar.tsx \
  src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx
git commit -m "feat(agent): right-edge ThreadSidebar with grouping, rename, and inline delete-confirm"
```

---

## Task 7: Wire `ThreadSidebar` into `AgentChatPanel` + bootstrap on mount

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx`

### Step 7.1: Write failing test

- [ ] Create `src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatPanel } from '../AgentChatPanel'
import { useAgentChatStore } from '../store'

const fakeAgent = {
  listThreads: vi.fn(),
  openThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  loadThread: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onToolRequest: vi.fn(() => () => undefined),
  sendToolResponse: vi.fn(),
  setApiKey: vi.fn(),
  testConnection: vi.fn(),
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { electronAPI: { agent: typeof fakeAgent } } }).window = {
    electronAPI: { agent: fakeAgent },
  }
  useAgentChatStore.setState({
    isOpen: true,
    threadId: undefined,
    messages: [],
    threadList: [],
    bootstrapped: false,
    sidebarOpen: true,
    sidebarWidth: 240,
  })
  fakeAgent.listThreads.mockResolvedValue([
    {
      id: 'top-thread',
      title: 'Top thread',
      createdAt: '',
      updatedAt: '',
      lastMessageAt: new Date().toISOString(),
    },
  ])
  fakeAgent.openThread.mockResolvedValue({ id: 'top-thread', messages: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AgentChatPanel bootstrap + sidebar offset', () => {
  it('runs bootstrap exactly once on mount when isOpen', async () => {
    render(<AgentChatPanel />)
    await waitFor(() => {
      expect(fakeAgent.listThreads).toHaveBeenCalledTimes(1)
      expect(fakeAgent.openThread).toHaveBeenCalledWith('top-thread')
    })
  })

  it('chat panel right offset = sidebarWidth when sidebar is open', async () => {
    render(<AgentChatPanel />)
    const panel = await screen.findByTestId('agent-chat-panel')
    expect(panel.style.right).toBe('240px')
  })

  it('toggles sidebar via Cmd+B', async () => {
    render(<AgentChatPanel />)
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true })
    await waitFor(() => {
      expect(useAgentChatStore.getState().sidebarOpen).toBe(false)
    })
  })
})
```

### Step 7.2: Run, expect failure

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx
```

Expected: 3 FAILs — `listThreads` not called, `data-testid="agent-chat-panel"` not present, Cmd+B not bound.

### Step 7.3: Modify `AgentChatPanel.tsx`

- [ ] Replace the entire contents of `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` with:

```tsx
import { useEffect } from 'react'
import { AttachmentChips } from './AttachmentChips'
import { Lightbox } from './Lightbox'
import { MentionInput } from './MentionInput'
import { MessageBubble } from './MessageBubble'
import { ResizableHandle } from './ResizableHandle'
import { ThreadCommandPalette } from './ThreadCommandPalette'
import { ThreadSidebar } from './ThreadSidebar'
import { TokenUsageMeter } from './TokenUsageMeter'
import { useAgentChatStore } from './store'
import type { AgentStreamEvent } from '../../../../types/agent'

const SIDEBAR_RAIL_WIDTH = 24

type AgentEventApi = {
  agent?: {
    onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
  }
}

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((state) => state.isOpen)
  const messages = useAgentChatStore((state) => state.messages)
  const error = useAgentChatStore((state) => state.error)
  const applyEvent = useAgentChatStore((state) => state.applyEvent)
  const panelWidth = useAgentChatStore((state) => state.panelWidth)
  const setPanelWidth = useAgentChatStore((state) => state.setPanelWidth)
  const tokenUsage = useAgentChatStore((state) => state.tokenUsage)
  const sidebarOpen = useAgentChatStore((state) => state.sidebarOpen)
  const sidebarWidth = useAgentChatStore((state) => state.sidebarWidth)
  const toggleSidebar = useAgentChatStore((state) => state.toggleSidebar)
  const bootstrap = useAgentChatStore((state) => state.bootstrap)

  // Bootstrap exactly once whenever the panel mounts in the open state.
  useEffect(() => {
    if (!isOpen) return
    void bootstrap()
  }, [isOpen, bootstrap])

  // Stream subscription, unchanged.
  useEffect(() => {
    if (!isOpen) return undefined
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    if (!agent) return undefined
    return agent.onEvent(applyEvent)
  }, [applyEvent, isOpen])

  // Cmd/Ctrl+B → toggle sidebar.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  // Panel right offset accounts for the sidebar so the two pieces sit flush.
  const panelRightOffset = sidebarOpen ? sidebarWidth : SIDEBAR_RAIL_WIDTH

  return (
    <>
      {isOpen ? (
        <aside
          data-testid="agent-chat-panel"
          // NOTE: do NOT add `relative` here. Tailwind's `.relative` is defined
          // after `.fixed` in the generated stylesheet, so when both classes
          // appear together `position: relative` wins the cascade — the panel
          // then leaves viewport-pinned mode, flows to the document tail, and
          // ends up rendered at the bottom of the page (regression "又跑下面去了").
          className="fixed top-0 z-[40000] flex h-screen flex-col border-l border-cyan-400/25 bg-zinc-950/95 text-white shadow-[-24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur"
          style={{ width: panelWidth, right: panelRightOffset }}
        >
          <ResizableHandle
            panelRight={typeof window !== 'undefined' ? window.innerWidth - panelRightOffset : 0}
            onResize={(width) => setPanelWidth(width)}
            onResizeEnd={() => {}}
          />
          <header className="border-b border-cyan-400/20 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">local codex</p>
                <h2 className="text-sm font-semibold text-cyan-50">CATIMATION Agent</h2>
              </div>
              <div className="flex items-center gap-2">
                <TokenUsageMeter usage={tokenUsage} />
                <button
                  type="button"
                  aria-label={sidebarOpen ? 'Hide thread sidebar' : 'Show thread sidebar'}
                  title={sidebarOpen ? 'Hide threads (Cmd/Ctrl+B)' : 'Show threads (Cmd/Ctrl+B)'}
                  onClick={() => toggleSidebar()}
                  className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
                >
                  {sidebarOpen ? '⇥' : '⇤'}
                </button>
                <button
                  className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
                  onClick={() => useAgentChatStore.getState().toggle()}
                  type="button"
                  aria-label="Close panel"
                >
                  x
                </button>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4 text-sm text-zinc-300">
                Tell the agent what to create or inspect. It can call CATIMATION tools and use local Codex
                capabilities.
              </div>
            ) : null}
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {error ? (
              <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}
          </div>

          <footer className="border-t border-cyan-400/20 p-3">
            <AttachmentChips />
            <MentionInput />
          </footer>
        </aside>
      ) : null}
      <ThreadSidebar />
      <Lightbox />
      <ThreadCommandPalette />
    </>
  )
}
```

### Step 7.4: Run tests, expect pass

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx
```

Expected: all 3 PASS.

### Step 7.5: Commit

- [ ] Run:

```bash
git add src/renderer/src/features/agent-chat/AgentChatPanel.tsx \
  src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.bootstrap.test.tsx
git commit -m "feat(agent): mount ThreadSidebar, bootstrap on first open, bind Cmd/Ctrl+B"
```

---

## Task 8: Full regression sweep + manual smoke (auto-title verification)

**Files:** none (read-only sweep)

### Step 8.1: Run the agent-chat renderer suite

- [ ] Run:

```bash
npx vitest run src/renderer/src/features/agent-chat
```

Expected: PASS, 0 unexpected failures. Note the total file/test counts and write them down for the next step.

### Step 8.2: Run the main/agent suite

- [ ] Run:

```bash
npx vitest run src/main/agent
```

Expected: PASS, 0 unexpected failures.

### Step 8.3: Run the type-check

- [ ] Run:

```bash
npx tsc --noEmit
```

Expected: 0 errors. (If pre-existing errors remain from elsewhere in the repo, document them and confirm they were not introduced by Tasks 1–7.)

### Step 8.4: Manual smoke — auto-title round-trip

- [ ] In a separate terminal, start the dev shell from the worktree root:

```bash
npm run dev
```

  Wait for the Electron window. Then from the in-app chat:

  1. Open the agent panel; the sidebar should render at the right edge with whatever existing threads exist.
  2. Click `+ New chat` (or close & reopen the panel — the new sidebar's button works either way).
  3. Send a one-line user message and wait for the assistant turn to finish.
  4. Hover over `TokenUsageMeter` — it should show a numeric percent (not just a token label). This confirms `model_context_window=200000` reached Codex via Task 1.
  5. Click `TokenUsageMeter` — popover should show `<used> / 200K Tokens · <pct>% Full`.
  6. Wait roughly 5–15 seconds after `turn_completed` for `ThreadTitleSummarizer` to run; the sidebar's row title should change from the seeded prefix (first 40 chars of the user message) to the auto-summarized title. Note the new title.
  7. Right-click ⋯ → Rename → type `Bug-D verified` → Enter. Confirm the row updates and the chat panel header still shows the right token usage.
  8. Restart the app. Confirm:
     - The sidebar shows the renamed thread.
     - The chat history is still loaded (i.e. bootstrap restored the most recent thread).
     - Token meter still shows a percent on the next turn.

  Record any deviations as a follow-up issue but do not block on them — they belong in a follow-up plan.

### Step 8.5: Commit a smoke-summary doc (optional but recommended)

- [ ] Append a short note to `docs/superpowers/specs/2026-05-07-codex-thread-sidebar-and-context-window-design.md` under a new `## Smoke Test Results (YYYY-MM-DD)` section recording:
  - Auto-title before / after string.
  - Whether bootstrap restored history after restart.
  - Whether `% Full` rendered on the very first turn after a fresh start.

  Then commit:

```bash
git add docs/superpowers/specs/2026-05-07-codex-thread-sidebar-and-context-window-design.md
git commit -m "docs(agent): record smoke test results for thread sidebar + context window feature"
```

---

## Spec Coverage Self-Check

Cross-checked the spec at `docs/superpowers/specs/2026-05-07-codex-thread-sidebar-and-context-window-design.md` against this plan:

- **Bug A — boot-time thread restoration:** Task 5 (`bootstrap()` action) + Task 7 (mount-time `useEffect`).
- **Bug B — visible thread switcher:** Task 6 (`ThreadSidebar`) + Task 7 (mount + Cmd/Ctrl+B + header toggle).
- **Bug C — thread management primitives:** Task 2 (IPC handlers) + Task 5 (`renameActiveThread`/`deleteThread` actions) + Task 6 (UI surfaces).
- **Bug D — auto-title verification:** Task 8.4 (manual smoke step 6).
- **Bug E — Codex knows model context window:** Task 1 (`-c model_context_window=200000` + renderer fallback so even pre-Codex-handshake turns render % Full).

No spec section is missing a task. The five sidebar-position-related changes from the most recent spec edit (right-edge layout) are implemented in Task 7's CSS `right: panelRightOffset` and Task 6's `right: 0` sidebar.

The four remaining open questions in the spec are all consciously left at their spec defaults (no plan task contradicts them):
- `Cmd+B` shortcut → wired in Task 7 step 7.3.
- Inline rename / inline delete confirm → Task 6 step 6.3.
- 500 ms refresh debounce → Task 5 step 5.4 (`THREAD_LIST_REFRESH_DEBOUNCE_MS`).
