# Context Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-07-context-popover-design.md`
**Branch:** `feature/codex-agent-mvp`
**Goal:** Make `TokenUsageMeter` clickable; click opens a popover that shows a 4-segment context breakdown (Cached / Conversation / Reasoning / Output) with `% Full`, raw counts, and an optional "Last turn" delta line — all derived from data Codex already streams via `thread/tokenUsage/updated`.

**Architecture:** Extend `AgentTokenUsage` with an optional `last` slice; teach `extractTokenUsage()` to populate it from `tokenUsage.last`. Add a pure renderer-side function `buildContextSegments(usage)` that maps the cumulative usage into 4 clamped segments. Build a small `ContextPopover` component (with inline subcomponents) that consumes `buildContextSegments()` and the `last` slice. Refactor `TokenUsageMeter` from a `<div>` into a `<button>` wrapped in a `relative` container, holding local `open` state and conditionally rendering the popover. No IPC changes, no preload changes, no protocol changes.

**Tech Stack:** TypeScript, React 18, Vitest, `@testing-library/react`, Tailwind CSS, existing Zustand store. All work confined to `src/types/agent.ts`, `src/main/agent/codexNotificationRouter.ts`, `src/renderer/src/features/agent-chat/`.

**Defaults locked in (4 open questions from spec):**
1. Footnote wording: keep current draft (`Codex doesn't break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation.`)
2. "Last turn" position: under the legend, dim mono.
3. Cached segment color: emerald (`#10b981`).
4. Cmd+P behavior: outside-click closes the popover (no exception for command-palette opens).

User can override any of these between tasks; the relevant constants are colocated in single files for easy tweak.

---

## Task A: Extend `AgentTokenUsage` with optional `last` delta

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/codexNotificationRouter.ts` (function `extractTokenUsage` near line 162)
- Modify: `src/main/agent/__tests__/codexNotificationRouter.test.ts` (block `describe('thread/tokenUsage/updated')` near line 490)

### Steps (TDD)

- [ ] **Step 1: Add the failing tests for `last` extraction**

Open `src/main/agent/__tests__/codexNotificationRouter.test.ts`. Inside `describe('thread/tokenUsage/updated', ...)` (the existing block at line 490), add the following test cases AT THE END of that block (just before the closing `})`):

```ts
    it('captures tokenUsage.last as usage.last when both are present', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        tokenUsage: {
          total: { inputTokens: 12508, outputTokens: 308, cachedInputTokens: 8000, reasoningOutputTokens: 256 },
          last: { inputTokens: 200, outputTokens: 50, reasoningOutputTokens: 30, cachedInputTokens: 100 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: {
          inputTokens: 12508,
          last: {
            inputTokens: 200,
            outputTokens: 50,
            reasoningTokens: 30,
            cachedInputTokens: 100,
          },
        },
      })
    })

    it('omits usage.last when tokenUsage.last is missing', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: { total: { inputTokens: 100, outputTokens: 50 } },
      })
      // toMatchObject lets us assert the absence of the field by checking it's undefined.
      expect(event).toMatchObject({ type: 'token_usage_updated' })
      expect((event as { usage: { last?: unknown } }).usage.last).toBeUndefined()
    })

    it('omits usage.last when tokenUsage.last has all-zero input/output (no signal)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: {
          total: { inputTokens: 100, outputTokens: 50 },
          last: { inputTokens: 0, outputTokens: 0 },
        },
      })
      expect((event as { usage: { last?: unknown } }).usage.last).toBeUndefined()
    })

    it('handles snake_case aliases inside tokenUsage.last', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: {
          total: { inputTokens: 1000, outputTokens: 500 },
          last: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 40 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: { last: { inputTokens: 80, outputTokens: 30, cachedInputTokens: 40 } },
      })
    })
```

- [ ] **Step 2: Run tests; verify they fail**

```
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts
```

Expected: 4 new failures. They will fail with `usage.last` being undefined (existing extractor never set it).

- [ ] **Step 3: Extend the type**

In `src/types/agent.ts`, add the new delta interface and a `last?` field on `AgentTokenUsage`. Locate the existing `AgentTokenUsage` interface (line 60) and replace the entire block with:

```ts
export interface AgentTokenUsageDelta {
  /** Per-turn input tokens. */
  inputTokens: number
  /** Per-turn output tokens. */
  outputTokens: number
  /** Per-turn reasoning tokens (subset of output). */
  reasoningTokens?: number
  /** Per-turn cached input tokens. */
  cachedInputTokens?: number
}

export interface AgentTokenUsage {
  /** Cumulative input tokens consumed in this thread. */
  inputTokens: number
  /** Cumulative output tokens emitted in this thread. */
  outputTokens: number
  /** Cumulative reasoning tokens (subset of output for reasoning-capable models). */
  reasoningTokens?: number
  /** Cached input tokens for this turn (provider-side prompt caching). */
  cachedInputTokens?: number
  /** Hard context window for the active model, in tokens. Optional because some gateways omit it. */
  contextWindow?: number
  /**
   * Tokens currently considered "in the prompt" — used to drive the context
   * usage meter and signal when Codex will compact. Falls back to
   * `inputTokens + outputTokens` if the gateway doesn't report it explicitly.
   */
  contextUsage?: number
  /**
   * Per-turn delta from Codex's `tokenUsage.last` slice. Cumulative fields
   * above describe the whole thread; `last` describes only the most-recent
   * turn so the popover can render "Last turn: +1.3K / +234". Omitted when
   * the gateway didn't send a `last` slice or when the slice carried only
   * zeroes (treated as "no signal" — we never fabricate per-turn data).
   */
  last?: AgentTokenUsageDelta
}
```

- [ ] **Step 4: Implement `last` extraction in `extractTokenUsage()`**

Open `src/main/agent/codexNotificationRouter.ts`. Replace the existing `extractTokenUsage` function (around line 162) with:

```ts
function extractTokenUsage(params: Record<string, unknown>): AgentTokenUsage | null {
  const counter = pickUsageCounter(params)
  if (!counter) return null
  const u = counter
  const inputTokens =
    readNumber(u.inputTokens) ?? readNumber(u.input_tokens) ?? readNumber(u.prompt_tokens)
  const outputTokens =
    readNumber(u.outputTokens) ?? readNumber(u.output_tokens) ?? readNumber(u.completion_tokens)
  if (inputTokens == null && outputTokens == null) return null

  const usage: AgentTokenUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
  const reasoningTokens =
    readNumber(u.reasoningTokens)
    ?? readNumber(u.reasoning_tokens)
    ?? readNumber(u.reasoningOutputTokens)
    ?? readNumber(u.reasoning_output_tokens)
  if (reasoningTokens != null) usage.reasoningTokens = reasoningTokens
  const cachedInputTokens =
    readNumber(u.cachedInputTokens)
    ?? readNumber(u.cached_input_tokens)
    ?? readNumber(u.cache_read_input_tokens)
  if (cachedInputTokens != null) usage.cachedInputTokens = cachedInputTokens
  const contextWindow =
    readNumber(params.contextWindow)
    ?? readNumber(params.context_window)
    ?? readNumber((params.tokenUsage as Record<string, unknown> | undefined)?.contextWindow)
  if (contextWindow != null) usage.contextWindow = contextWindow
  const contextUsage =
    readNumber(params.contextUsage)
    ?? readNumber(params.context_usage)
    ?? readNumber((params.tokenUsage as Record<string, unknown> | undefined)?.contextUsage)
  if (contextUsage != null) usage.contextUsage = contextUsage

  const last = extractLastDelta(params)
  if (last) usage.last = last
  return usage
}

/**
 * Read `tokenUsage.last` (per-turn delta). Returns `undefined` when the slice
 * is missing OR when both input/output are zero — we'd rather hide the
 * "Last turn" popover line than show "+0 / +0" noise. Mirrors the field
 * aliasing in `extractTokenUsage` so apiyi / OpenRouter snake_case still works.
 */
function extractLastDelta(params: Record<string, unknown>): AgentTokenUsageDelta | undefined {
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  const last = tu?.last as Record<string, unknown> | undefined
  if (!last || typeof last !== 'object') return undefined
  const inputTokens =
    readNumber(last.inputTokens) ?? readNumber(last.input_tokens) ?? readNumber(last.prompt_tokens) ?? 0
  const outputTokens =
    readNumber(last.outputTokens) ?? readNumber(last.output_tokens) ?? readNumber(last.completion_tokens) ?? 0
  if (inputTokens === 0 && outputTokens === 0) return undefined

  const delta: AgentTokenUsageDelta = { inputTokens, outputTokens }
  const reasoningTokens =
    readNumber(last.reasoningTokens)
    ?? readNumber(last.reasoning_tokens)
    ?? readNumber(last.reasoningOutputTokens)
    ?? readNumber(last.reasoning_output_tokens)
  if (reasoningTokens != null) delta.reasoningTokens = reasoningTokens
  const cachedInputTokens =
    readNumber(last.cachedInputTokens)
    ?? readNumber(last.cached_input_tokens)
    ?? readNumber(last.cache_read_input_tokens)
  if (cachedInputTokens != null) delta.cachedInputTokens = cachedInputTokens
  return delta
}
```

Also update the import at line 1:

```ts
import type { AgentStreamEvent, AgentTokenUsage, AgentTokenUsageDelta } from '../../types/agent'
```

- [ ] **Step 5: Run tests; verify all green**

```
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts
```

Expected: ALL existing tests + 4 new tests green. The pre-existing `extracts cumulative usage from the nested tokenUsage.total shape (codex 0.128)` test (line 544) **may** start failing because its `toEqual` assertion is strict and the response now includes `usage.last`. If it fails, edit that one test to use `toMatchObject` instead of `toEqual` so the new `last` field is acceptable but not required. (Don't change the rest of the test — just `toEqual` → `toMatchObject`.)

- [ ] **Step 6: Run typecheck**

```
npm run typecheck
```

Expected: 0 errors in `src/types/agent.ts` and `src/main/agent/codexNotificationRouter.ts`. Pre-existing errors elsewhere are out of scope.

- [ ] **Step 7: Commit**

```
git add src/types/agent.ts src/main/agent/codexNotificationRouter.ts src/main/agent/__tests__/codexNotificationRouter.test.ts
git commit -m "feat(agent): extract tokenUsage.last per-turn delta into AgentTokenUsage.last"
```

**Acceptance:** all router tests green; typecheck clean for the two modified TS files; no other files touched.

---

## Task B: Pure `buildContextSegments()` function

**Files:**
- Create: `src/renderer/src/features/agent-chat/tokenSegments.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts`

### Steps (TDD)

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts` with the following content:

```ts
import { describe, expect, it } from 'vitest'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { buildContextSegments } from '../tokenSegments'

const baseUsage: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
}

describe('buildContextSegments', () => {
  it('splits a happy-path usage into four ordered segments', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 10_000,
      cachedInputTokens: 8_000,
      outputTokens: 2_000,
      reasoningTokens: 500,
      contextWindow: 110_000,
    })
    expect(result.segments.map((s) => [s.key, s.tokens])).toEqual([
      ['cached', 8_000],
      ['conversation', 2_000],
      ['reasoning', 500],
      ['output', 1_500],
    ])
    expect(result.total).toBe(12_000)
    expect(result.windowTokens).toBe(110_000)
    expect(result.pctFull).toBe(11) // round(100 * 12000 / 110000) = 11
  })

  it('treats missing cachedInputTokens as zero (Conversation = full inputTokens)', () => {
    const result = buildContextSegments({ ...baseUsage, inputTokens: 5_000, outputTokens: 1_000 })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.cached).toBe(0)
    expect(map.conversation).toBe(5_000)
    expect(map.reasoning).toBe(0)
    expect(map.output).toBe(1_000)
  })

  it('treats missing reasoningTokens as zero (Output = full outputTokens)', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 1_000,
      outputTokens: 800,
      cachedInputTokens: 600,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.reasoning).toBe(0)
    expect(map.output).toBe(800)
  })

  it('clamps cached when gateway reports cached > input', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 1_000,
      cachedInputTokens: 9_999,
      outputTokens: 100,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.cached).toBe(1_000)
    expect(map.conversation).toBe(0)
  })

  it('clamps reasoning when gateway reports reasoning > output', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 999,
    })
    const map = Object.fromEntries(result.segments.map((s) => [s.key, s.tokens]))
    expect(map.reasoning).toBe(50)
    expect(map.output).toBe(0)
  })

  it('omits pctFull when contextWindow is missing', () => {
    const result = buildContextSegments({ ...baseUsage, inputTokens: 1, outputTokens: 1 })
    expect(result.pctFull).toBeUndefined()
    expect(result.windowTokens).toBeUndefined()
  })

  it('total equals the sum of segment tokens after clamping', () => {
    const result = buildContextSegments({
      ...baseUsage,
      inputTokens: 5_000,
      cachedInputTokens: 6_000, // intentionally > input
      outputTokens: 1_000,
      reasoningTokens: 1_500, // intentionally > output
    })
    const sum = result.segments.reduce((acc, s) => acc + s.tokens, 0)
    expect(result.total).toBe(sum)
    // After clamping: cached=5000, conversation=0, reasoning=1000, output=0 → 6000
    expect(result.total).toBe(6_000)
  })
})
```

- [ ] **Step 2: Run tests; verify they fail**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts
```

Expected: All 7 fail with `Cannot find module '../tokenSegments'`.

- [ ] **Step 3: Implement `tokenSegments.ts`**

Create `src/renderer/src/features/agent-chat/tokenSegments.ts`:

```ts
import type { AgentTokenUsage } from '../../../../types/agent'

export type SegmentKey = 'cached' | 'conversation' | 'reasoning' | 'output'

export interface Segment {
  key: SegmentKey
  /** Human-facing label rendered in the legend. */
  label: string
  /** Hex color used both for the bar fill and the legend dot. */
  color: string
  /** Token count for this segment (>= 0, clamped). */
  tokens: number
}

export interface ContextSegments {
  /** Always 4 segments, in fixed order: cached → conversation → reasoning → output. */
  segments: Segment[]
  /** Sum of all segment tokens after clamping. Used as the bar's width basis. */
  total: number
  /** Hard context window from `usage.contextWindow`, when present. */
  windowTokens?: number
  /** Rounded percent of `windowTokens` consumed. Undefined if window is missing. */
  pctFull?: number
}

/**
 * Map an `AgentTokenUsage` onto the four segments rendered in the popover.
 *
 * Why these four (and only these four): Codex's `thread/tokenUsage/updated`
 * notification reports cumulative `inputTokens` (with an optional
 * `cachedInputTokens` subset) and cumulative `outputTokens` (with an optional
 * `reasoningTokens` subset). It does NOT break inputTokens further into
 * "system prompt vs tools vs MCP vs custom skills vs message history". Splitting
 * those would require wire-level changes Codex hasn't shipped. Until it does,
 * we render only what the wire actually reports.
 *
 * Clamping rationale: gateways occasionally report `cached > input` or
 * `reasoning > output` (off-by-ones, rounding). Without clamping the bar would
 * paint a negative region and totals would lie. We clamp non-negatively so
 * `total === sum(segments)` always holds.
 */
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
    { key: 'cached',       label: 'Cached prompt', color: '#10b981', tokens: cached },
    { key: 'conversation', label: 'Conversation',  color: '#f59e0b', tokens: conversation },
    { key: 'reasoning',    label: 'Reasoning',     color: '#a855f7', tokens: reasoning },
    { key: 'output',       label: 'Output',        color: '#22d3ee', tokens: visibleOutput },
  ]
  const total = segments.reduce((acc, s) => acc + s.tokens, 0)
  const windowTokens =
    typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : undefined
  const pctFull = windowTokens != null ? Math.round((100 * total) / windowTokens) : undefined

  return { segments, total, windowTokens, pctFull }
}
```

- [ ] **Step 4: Run tests; verify all green**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```
git add src/renderer/src/features/agent-chat/tokenSegments.ts src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts
git commit -m "feat(agent): add buildContextSegments pure mapper for token usage popover"
```

**Acceptance:** 7 passing tests in `tokenSegments.test.ts`; no other files touched.

---

## Task C: `ContextPopover` component

**Files:**
- Create: `src/renderer/src/features/agent-chat/ContextPopover.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx`

### Steps (TDD)

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { ContextPopover } from '../ContextPopover'

const fullUsage: AgentTokenUsage = {
  inputTokens: 10_000,
  cachedInputTokens: 8_000,
  outputTokens: 2_000,
  reasoningTokens: 500,
  contextWindow: 110_000,
  last: { inputTokens: 1_300, outputTokens: 234 },
}

describe('ContextPopover', () => {
  it('renders pct full headline when contextWindow is known', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    // Total = 12_000; 12000 / 110000 = 10.9 → round 11.
    expect(screen.getByText(/11% Full/i)).toBeTruthy()
  })

  it('shows token total even when contextWindow is missing', () => {
    const { contextWindow: _omit, ...rest } = fullUsage
    render(<ContextPopover usage={rest} onClose={() => {}} />)
    expect(screen.queryByText(/% Full/)).toBeNull()
    // Total is 12_000; formatted as "12.0K" or similar — assert the K suffix.
    expect(screen.getByText(/12(\.0)?K/i)).toBeTruthy()
  })

  it('renders all four segment labels with their token counts', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    expect(screen.getByText(/Cached prompt/i)).toBeTruthy()
    expect(screen.getByText(/Conversation/i)).toBeTruthy()
    expect(screen.getByText(/Reasoning/i)).toBeTruthy()
    expect(screen.getByText(/^Output$/i)).toBeTruthy()
  })

  it('renders a Last turn line when usage.last is present', () => {
    render(<ContextPopover usage={fullUsage} onClose={() => {}} />)
    expect(screen.getByText(/Last turn/i)).toBeTruthy()
    expect(screen.getByText(/\+1\.3K/)).toBeTruthy()
    expect(screen.getByText(/\+234/)).toBeTruthy()
  })

  it('hides Last turn line when usage.last is missing', () => {
    const { last: _omit, ...rest } = fullUsage
    render(<ContextPopover usage={rest} onClose={() => {}} />)
    expect(screen.queryByText(/Last turn/i)).toBeNull()
  })

  it('shows empty-state copy when total is zero', () => {
    render(
      <ContextPopover
        usage={{ inputTokens: 0, outputTokens: 0 }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/No usage data yet/i)).toBeTruthy()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape keydown', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when clicking outside the popover', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="outside">outside</div>
        <ContextPopover usage={fullUsage} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside the popover', () => {
    const onClose = vi.fn()
    render(<ContextPopover usage={fullUsage} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests; verify they fail**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx
```

Expected: 9 failures with `Cannot find module '../ContextPopover'`.

- [ ] **Step 3: Implement `ContextPopover.tsx`**

Create `src/renderer/src/features/agent-chat/ContextPopover.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import type { AgentTokenUsage, AgentTokenUsageDelta } from '../../../../types/agent'
import type { ContextSegments, Segment } from './tokenSegments'
import { buildContextSegments } from './tokenSegments'

interface ContextPopoverProps {
  usage: AgentTokenUsage
  onClose: () => void
}

/**
 * Click-to-open breakdown of where the context budget is going. Anchored to
 * the right edge of the chat panel header, immediately below the
 * `TokenUsageMeter` pill. The popover is intentionally honest about Codex's
 * data limits — we render only the four segments Codex reports, and call out
 * what's NOT broken down (Tools / Rules / MCP) in the footnote.
 *
 * Closes on Escape, on outside mousedown, or on the explicit close button.
 * The Tab key is unbound — focus management piggybacks on the parent panel's
 * existing keyboard model (no focus trap; the popover is read-only).
 */
export function ContextPopover({ usage, onClose }: ContextPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const ctx = buildContextSegments(usage)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Context usage"
      className="absolute right-0 top-[calc(100%+6px)] z-[60000] w-[280px] rounded-lg border border-zinc-700/80 bg-zinc-950/95 p-3 text-zinc-200 shadow-2xl backdrop-blur"
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.24em] text-zinc-400">Context</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ×
        </button>
      </header>

      {ctx.total === 0 ? (
        <p className="py-2 text-center text-[11px] text-zinc-500">No usage data yet</p>
      ) : (
        <>
          <PctFullDisplay ctx={ctx} />
          <StackedBar ctx={ctx} />
          <SegmentLegend segments={ctx.segments} />
          <LastTurnLine last={usage.last} />
          <p className="mt-2 text-[9px] leading-relaxed text-zinc-500">
            Codex doesn&apos;t break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation.
          </p>
        </>
      )}
    </div>
  )
}

function PctFullDisplay({ ctx }: { ctx: ContextSegments }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      {ctx.pctFull != null ? (
        <span className="text-lg font-semibold text-zinc-100">{ctx.pctFull}% Full</span>
      ) : null}
      <span className="font-mono text-[10px] text-zinc-500">
        ~{formatTokens(ctx.total)}
        {ctx.windowTokens != null ? ` / ${formatTokens(ctx.windowTokens)}` : ''} Tokens
      </span>
    </div>
  )
}

function StackedBar({ ctx }: { ctx: ContextSegments }) {
  // Bar is sized to the WINDOW when known (so empty space at the right shows
  // remaining headroom); otherwise sized to total (popover with no window
  // info still renders proportions across the full width).
  const denom = ctx.windowTokens ?? ctx.total
  return (
    <div className="mb-2 flex h-[6px] w-full overflow-hidden rounded-full bg-zinc-800">
      {ctx.segments.map((s) => {
        const pct = denom > 0 ? (100 * s.tokens) / denom : 0
        if (pct === 0) return null
        return (
          <div
            key={s.key}
            data-segment={s.key}
            style={{ width: `${pct}%`, backgroundColor: s.color }}
            className="h-full"
          />
        )
      })}
    </div>
  )
}

function SegmentLegend({ segments }: { segments: Segment[] }) {
  return (
    <ul className="space-y-1">
      {segments.map((s) => (
        <li key={s.key} className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
          </span>
          <span className="font-mono text-zinc-400">{formatTokens(s.tokens)}</span>
        </li>
      ))}
    </ul>
  )
}

function LastTurnLine({ last }: { last?: AgentTokenUsageDelta }) {
  if (!last) return null
  return (
    <p className="mt-2 border-t border-zinc-800 pt-2 font-mono text-[10px] text-zinc-500">
      Last turn:{' '}
      <span className="text-zinc-300">+{formatTokens(last.inputTokens)}</span> input
      {' • '}
      <span className="text-zinc-300">+{formatTokens(last.outputTokens)}</span> output
    </p>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
```

- [ ] **Step 4: Run tests; verify all green**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx
```

Expected: 9 passing. If the empty-state test fails because both `0% Full` and `No usage data yet` render simultaneously, fix the implementation — the empty-state branch (`ctx.total === 0`) should short-circuit BEFORE rendering `PctFullDisplay`. (The provided code already does this.)

- [ ] **Step 5: Run typecheck**

```
npm run typecheck
```

Expected: no new errors in the new file.

- [ ] **Step 6: Commit**

```
git add src/renderer/src/features/agent-chat/ContextPopover.tsx src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx
git commit -m "feat(agent): ContextPopover with stacked bar + legend + last turn line"
```

**Acceptance:** 9 passing tests; component renders standalone without `TokenUsageMeter` integration.

---

## Task D: Refactor `TokenUsageMeter` into a clickable button

**Files:**
- Modify: `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx`

### Steps (TDD)

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AgentTokenUsage } from '../../../../../types/agent'
import { TokenUsageMeter } from '../TokenUsageMeter'

const sampleUsage: AgentTokenUsage = {
  inputTokens: 10_000,
  cachedInputTokens: 6_000,
  outputTokens: 1_000,
  contextWindow: 100_000,
}

describe('TokenUsageMeter', () => {
  it('renders nothing when usage is undefined', () => {
    const { container } = render(<TokenUsageMeter usage={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the pill as a button when usage is present', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    const btn = screen.getByRole('button', { name: /context/i })
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not render the popover by default', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the popover when the pill is clicked', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: /context/i }).getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles the popover closed when the pill is clicked again', () => {
    render(<TokenUsageMeter usage={sampleUsage} />)
    const btn = screen.getByRole('button', { name: /context/i })
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(btn)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests; verify they fail**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx
```

Expected: failures because:
- The pill is currently a `<div>`, not `<button>`.
- The pill currently has no `aria-expanded`, no clickable behavior, no `name` query target.
- Opening the popover isn't wired up.

- [ ] **Step 3: Refactor `TokenUsageMeter.tsx`**

Replace the entire contents of `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx` with:

```tsx
import { useState } from 'react'
import type { AgentTokenUsage } from '../../../../types/agent'
import { ContextPopover } from './ContextPopover'

/**
 * Compact donut + counter shown in the chat panel header. Clicking it opens a
 * `ContextPopover` with a 4-segment breakdown of where the context budget is
 * going. The donut itself still mirrors `usage.contextUsage / contextWindow`
 * — the popover is purely additive.
 */
export function TokenUsageMeter({ usage }: { usage?: AgentTokenUsage }) {
  const [open, setOpen] = useState(false)
  if (!usage) return null

  const used = usage.contextUsage ?? usage.inputTokens + usage.outputTokens
  const window = usage.contextWindow
  const ratio = window != null && window > 0 ? Math.min(1, Math.max(0, used / window)) : null
  const pct = ratio != null ? Math.round(ratio * 100) : null

  const radius = 8
  const stroke = 2
  const circ = 2 * Math.PI * radius
  const dash = ratio != null ? circ * ratio : 0

  const tone = pickTone(ratio)
  const label = formatTokens(used)
  const ariaLabel =
    ratio != null
      ? `Context: ${used} / ${window} tokens (${pct}%)`
      : `Tokens used: in=${usage.inputTokens} out=${usage.outputTokens}`

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={
          ratio != null
            ? `Context: ${used} / ${window} tokens (${pct}%) — Codex compacts when full`
            : `Tokens used: in=${usage.inputTokens} out=${usage.outputTokens}${
                usage.cachedInputTokens != null ? ` cached=${usage.cachedInputTokens}` : ''
              }`
        }
        className="flex items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-900/60 px-2 py-0.5 text-[10px] text-zinc-300 transition hover:border-cyan-300/60 hover:text-cyan-100"
      >
        {ratio != null ? (
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r={radius} fill="none" stroke="rgba(63,63,70,0.6)" strokeWidth={stroke} />
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              stroke={tone.stroke}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ}`}
              transform="rotate(-90 10 10)"
            />
          </svg>
        ) : (
          <span className="inline-block h-3 w-3 rounded-full border border-zinc-600 bg-zinc-800/50" />
        )}
        <span className={`font-mono ${tone.text}`}>{pct != null ? `${pct}%` : label}</span>
      </button>
      {open ? <ContextPopover usage={usage} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

function pickTone(ratio: number | null): { stroke: string; text: string } {
  if (ratio == null) return { stroke: '#71717a', text: 'text-zinc-400' }
  if (ratio >= 0.9) return { stroke: '#ef4444', text: 'text-red-300' }
  if (ratio >= 0.7) return { stroke: '#f59e0b', text: 'text-amber-300' }
  return { stroke: '#22d3ee', text: 'text-cyan-200' }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
```

- [ ] **Step 4: Run tests; verify all green**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx
```

Expected: 5 passing. If the "renders the pill as a button when usage is present" test fails because `getByRole('button', { name: /context/i })` doesn't match, that means the `aria-label` doesn't include "Context" — confirm `ariaLabel` is built with the prefix `Context:` (it is in the code above). RTL matches the accessible name case-insensitively against the regex, so `Context: 7000 / 100000 tokens (7%)` matches `/context/i`.

- [ ] **Step 5: Re-run the popover tests for sanity**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx
```

Expected: still 9 passing — popover behavior is unchanged because the meter integration only adds a parent wrapper.

- [ ] **Step 6: Re-run the existing store tests**

```
npx vitest run src/renderer/src/features/agent-chat/__tests__/store.test.ts
```

Expected: green (no changes to store).

- [ ] **Step 7: Commit**

```
git add src/renderer/src/features/agent-chat/TokenUsageMeter.tsx src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx
git commit -m "feat(agent): make TokenUsageMeter clickable to open ContextPopover"
```

**Acceptance:** 5 new meter tests + 9 popover tests + existing store tests all green.

---

## Task E: Full feature-folder regression sweep + manual smoke

**Files:** none modified — verification only.

### Steps

- [ ] **Step 1: Run the entire agent-chat folder test suite**

```
npx vitest run src/renderer/src/features/agent-chat
```

Expected: ALL tests pass — `tokenSegments`, `ContextPopover`, `TokenUsageMeter`, `store`, plus any others present.

- [ ] **Step 2: Run the entire agent main-process test suite**

```
npx vitest run src/main/agent
```

Expected: ALL tests pass — `codexNotificationRouter` (with the 4 new `last`-extraction tests), `codexLaunch`, `AgentManager`, `ThreadStore`, `ensureSchema`, `electronViteConfig`, etc.

- [ ] **Step 3: Run typecheck**

```
npm run typecheck
```

Expected: no new errors introduced by Tasks A-D. Pre-existing errors are out of scope (do NOT fix them in this plan).

- [ ] **Step 4: Manual smoke test**

Start the app:

```
npm run dev
```

Verification checklist (all must pass before declaring complete):

1. Open the app. Press `Ctrl+Shift+A` to open the agent panel.
2. Type a short prompt (e.g., `hello`) and send.
3. Wait for `turn/completed`. The `TokenUsageMeter` pill in the header should now show a percentage or token count.
4. **Hover** the pill — tooltip still appears (existing behavior).
5. **Click** the pill — popover opens below it, anchored to the right edge of the panel header.
6. Popover contains:
   - "Context" header + close `×`.
   - "X% Full" big number (or just `~Y.YK Tokens` if no `contextWindow`).
   - Stacked bar with at least one colored segment.
   - All four legend rows (Cached prompt / Conversation / Reasoning / Output) with token counts.
   - "Last turn: +X / +Y" line IF Codex sent a `last` slice (apiyi/Codex 0.128 should).
   - Footnote about Tools / Rules / MCP.
7. Press `Esc` — popover closes.
8. Click the pill again — popover opens again.
9. Click outside the popover (e.g., on a message bubble) — popover closes.
10. Click the close `×` — popover closes.
11. Resize the chat panel narrower (drag the resize handle) — popover stays anchored to the pill, may overflow the panel's left edge slightly at extreme widths (acceptable).
12. Send another message; while the popover is open, the bar / numbers update live as `token_usage_updated` events arrive.

If any checklist item fails: stop, file the regression, fix per `/systematic-debugging`, re-run all vitest suites, commit the fix as a separate commit (`fix(agent): <what>`), repeat the smoke test.

- [ ] **Step 5: No commit needed for this task**

Task E is verification-only; if all steps pass without code changes, do not create an empty commit. If a fix was needed, that's already its own commit from Step 4.

**Acceptance:** all vitest suites green; typecheck clean for changed files; manual smoke test all 12 items pass.

---

## Self-Review Checklist (run before declaring plan complete)

This is the plan author's responsibility — check it BEFORE handing off:

**1. Spec coverage:** Every section of the spec has a task that implements it.
- Goal → Tasks A+B+C+D
- Non-Goals → no tasks (correct — they're explicit exclusions)
- User Story step 5 (popover content) → Task C
- User Story step 6 (Esc/outside-click) → Task C steps + Task D integration
- Architecture/Data shape → Task A
- Architecture/Token category mapping → Task B
- Architecture/Components → Tasks C, D
- Architecture/Click-to-open mechanics → Task D
- Edge Cases → Task B (clamps), Task C (empty state, missing window, missing last)
- Testing Strategy → Tasks A, B, C, D test files match the spec's per-test enumeration

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" markers in this plan. Every code block contains real, runnable code.

**3. Type consistency:** `Segment` / `ContextSegments` / `SegmentKey` / `AgentTokenUsage` / `AgentTokenUsageDelta` are introduced in Task A & B and used consistently in Tasks C & D. Function name `buildContextSegments(usage)` is identical across all tasks. Hex color values match between `tokenSegments.ts` and the popover (rendered straight from segment data, not duplicated).

**4. No scope creep:**
- Each task touches files declared in its "Files" header. No "while I'm here" creep.
- The `console.debug` clamp warning from the spec (§Risk) was DROPPED from the implementation (not in any task) to keep the diff minimal. If a clamp fires in production we'll find out via screenshots; we don't need automatic logging for MVP.

If you spot any issue, fix it inline before invoking `subagent-driven-development`.

---

## Execution Handoff

After this plan is reviewed and approved:

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-context-popover.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — One implementer subagent per task, with spec-review + code-quality review between tasks. Matches the project's established workflow (per AGENTS.md). Best for: catching design drift early, parallel review.

**2. Inline Execution** — Run all tasks in this session sequentially, with a checkpoint review after Task D. Best for: fast iteration when you want to watch each step happen.

**Which approach?**
