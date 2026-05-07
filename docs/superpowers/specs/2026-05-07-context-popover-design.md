# Context Popover for Token Usage Meter — Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-05-07
**Author:** Cursor agent at user request
**Related:** `2026-05-07-codex-agent-chat-redesign-design.md` (parent), `TokenUsageMeter.tsx` (current widget being extended)

## Goal

Make the existing **`TokenUsageMeter`** pill in the chat panel header **clickable**, opening a small popover that shows _where the context budget is going_ — input vs cached vs reasoning vs output, with the same level of honesty Codex's wire data allows. The reference is Claude Code's "Context" popover (Image 2 in the user's brief): a stacked bar split by category, a `% Full` headline, raw token counts, and a "Last turn" delta.

Mechanically: take the data we already extract in `extractTokenUsage()` (`AgentTokenUsage`), categorize it into 4 segments, and render it as a stacked bar + legend inside a popover anchored to the meter pill.

## Non-Goals

- **Faking Claude-like categories we don't have.** Codex 0.128's `thread/tokenUsage/updated` does not break input down into "System prompt", "Tools", "MCP tools", "Custom agents", "Memory files", "Messages". Building 7 fake columns by guessing splits would lie to the user. We render only what the wire reports.
- Live re-categorization based on which tools/MCP/skills are loaded. That would require parsing the system prompt and reverse-engineering token boundaries — out of scope for MVP.
- Cost / pricing display. Some gateways report `$X.XX` per turn, but apiyi doesn't, so any number we showed would be model-pricing extrapolation. Skip.
- Editing the context window from the popover. Read-only.
- Multi-thread aggregation. Popover shows the active thread only.
- Animating segment growth. The bar repaints on each `token_usage_updated` event; CSS transitions on `width` are nice-to-have but not part of MVP scope.

## User Story

1. User sends a few messages in a thread; assistant streams replies.
2. The header meter ticks up: e.g. donut at 23%, label `23%`.
3. User hovers the pill — current tooltip still works ("Context: 25,300 / 110,000 tokens (23%) — Codex compacts when full").
4. **(NEW)** User clicks the pill. A popover opens immediately below it, anchored to the right edge of the panel header.
5. Popover shows:
   - `Context` heading + small close `×`.
   - **`23% Full`** big number, then `~25.3K / 110K Tokens` underneath.
   - 4-color stacked bar (~6px tall) sized to total `contextUsage` (or `inputTokens + outputTokens`), capped at `contextWindow` width.
   - Below the bar, 4 colored rows:
     - `🟢 Cached prompt   18.4K`
     - `🟠 Conversation     3.2K`
     - `🟣 Reasoning          780`
     - `🔵 Output            2.9K`
   - **`Last turn:` `+1.3K input  •  +234 output`** in dim mono text. Hidden when `tokenUsage.last` is unavailable.
   - Tiny footnote: `Codex doesn't break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation.`
6. User presses `Esc`, clicks outside the popover, or clicks the pill again → popover closes.
7. If the gateway never sent `tokenUsage` (e.g. very early in a thread, or apiyi dropped the field): the pill is still rendered as a dimmed dot (existing behavior); clicking it shows a popover that says `No usage data yet` and nothing else. We don't fabricate zeros.

## Architecture

### Data shape — extend `AgentTokenUsage` with a `last` slice

`extractTokenUsage()` already prefers `tokenUsage.total` then falls back to `tokenUsage.last`. To drive the "Last turn" line we need both. The minimal change:

```ts
// src/types/agent.ts
export interface AgentTokenUsageDelta {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

export interface AgentTokenUsage {
  // ...existing cumulative fields unchanged...

  /**
   * Per-turn delta from Codex's `tokenUsage.last` slice. Cumulative fields
   * above describe the whole thread; `last` describes only the most-recent
   * turn so the popover can render "Last turn: +1.3K / +234".
   */
  last?: AgentTokenUsageDelta
}
```

`extractTokenUsage()` is updated:
- Still returns the cumulative `AgentTokenUsage` from `tokenUsage.total` (or fallbacks) — unchanged contract.
- **Additionally** reads `params.tokenUsage.last` (when present) into the new `usage.last` field, using the same field-aliasing logic (`inputTokens` / `input_tokens` / `prompt_tokens`, etc.) factored into a shared helper.
- If `last` exists but has zeroed counts (e.g. an `item/started` arrived without `tokenUsage.last`), `usage.last` is omitted rather than set to all-zeros — same "no fake data" stance.

### Token category mapping (4 segments, derived purely client-side)

Pure function in a new file `src/renderer/src/features/agent-chat/tokenSegments.ts`:

```ts
export type SegmentKey = 'cached' | 'conversation' | 'reasoning' | 'output'

export interface Segment {
  key: SegmentKey
  label: string        // "Cached prompt" | "Conversation" | "Reasoning" | "Output"
  color: string        // tailwind text class for legend dot, hex for bar fill
  tokens: number       // >= 0
}

export interface ContextSegments {
  segments: Segment[]  // length 4, in fixed order
  total: number        // sum of segment tokens (used for bar width)
  windowTokens?: number
  pctFull?: number     // 0..100 if window known
}

export function buildContextSegments(usage: AgentTokenUsage): ContextSegments
```

Mapping rules (all clamp to `>= 0` to defend against gateway off-by-ones):

| Segment | Formula | Color | Notes |
|---|---|---|---|
| Cached prompt  | `min(cachedInputTokens ?? 0, inputTokens)` | `#10b981` (emerald-500) | Cap at `inputTokens` so we never paint >100% input. Reflects provider-side prompt caching (system prompt + tools + sticky context). |
| Conversation   | `max(inputTokens - cachedInputTokens, 0)` | `#f59e0b` (amber-500) | The non-cached residue: messages, dynamic tool descriptions, attachment text. |
| Reasoning      | `min(reasoningTokens ?? 0, outputTokens)` | `#a855f7` (purple-500) | Cap at `outputTokens` since reasoning is a subset (Responses API contract). |
| Output         | `max(outputTokens - reasoningTokens, 0)` | `#22d3ee` (cyan-400) | Visible assistant text + tool calls. |

`total = sum(segments)` (re-computed; should equal `contextUsage ?? input+output` modulo clamping).
`pctFull = round(100 * total / windowTokens)` when `windowTokens > 0`; otherwise `undefined`.

### Components

```
TokenUsageMeter (existing, refactored to be clickable)
  └─ on click: toggles `open` state in local React state
  └─ when open, renders <ContextPopover />

ContextPopover (NEW)
  ├─ headline: "Context", close button
  ├─ <PctFullDisplay segments=… />     // big "23% Full" + "25.3K / 110K Tokens"
  ├─ <StackedBar segments=… />          // single-row 4-color bar
  ├─ <SegmentLegend segments=… />       // 4 colored rows w/ values
  ├─ <LastTurnLine usage=… />           // optional, hidden when usage.last missing
  └─ footnote: "Codex doesn't break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation."
```

`StackedBar`, `PctFullDisplay`, `SegmentLegend`, `LastTurnLine` are tiny presentational components colocated in `ContextPopover.tsx` (no separate files — keeps the diff small and the file under 200 LOC).

### Click-to-open mechanics

`TokenUsageMeter` becomes a `<button>` (was `<div>`):

```tsx
const [open, setOpen] = useState(false)
return (
  <div className="relative">
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={existingPillClasses}
    >
      {donut}{label}
    </button>
    {open ? (
      <ContextPopover
        usage={usage}
        onClose={() => setOpen(false)}
      />
    ) : null}
  </div>
)
```

The wrapper `div` adds `relative` so the popover can absolutely-position itself. The donut+label svg/markup is unchanged.

`ContextPopover` itself:
- `position: absolute; right: 0; top: calc(100% + 6px);` — opens below the pill, right-aligned, so it never overflows the panel's left edge.
- `z-[60000]` (above panel’s `z-[40000]`).
- `min-w: 240px; max-w: 320px`.
- Closes on:
  - `Esc` keydown anywhere on the document (single `useEffect` listener).
  - Click outside the popover (`useRef` + `mousedown` listener with `contains()` check).
  - Click on the pill again (toggle).
- No portal. Worth less complexity than the regression risk of teleporting out of the chat panel's stacking context.

### Why no IPC / no main-process changes

All categorization is pure renderer-side math on the existing `AgentTokenUsage` state already streamed via `token_usage_updated`. The only protocol-router change is `extractTokenUsage()` learning to also collect the `last` slice. No new IPC channels, no preload changes.

## Edge Cases

| Case | Behavior |
|---|---|
| `usage` undefined (very early thread) | `TokenUsageMeter` returns `null` (existing). No popover possible. |
| `usage` present, `cachedInputTokens` missing | Cached segment = 0, Conversation segment = full `inputTokens`. Legend still shows `Cached prompt 0`. |
| `usage.contextWindow` missing | Bar still renders sized to `total`, but no `% Full` headline; show only `~25.3K Tokens`. |
| `cachedInputTokens > inputTokens` (gateway bug) | Cached clamped to `inputTokens`; Conversation = 0. Console warns once via `console.debug` so we know if a gateway is doing this. |
| `reasoningTokens > outputTokens` (gateway bug) | Same clamp pattern. Reasoning clamped to `outputTokens`; Output = 0. |
| Total = 0 (all four segments zero) | Show "No usage data yet" placeholder instead of an empty bar. |
| Popover open + new `token_usage_updated` arrives | Numbers update live; bar widths re-flow. No close/reopen logic. |
| Panel resized while popover is open | Popover stays anchored (right-aligned); no special handling needed. |
| User clicks pill, then opens command palette (Cmd+P) | Palette has its own focus trap; popover doesn't block it. We close popover on Esc and on outside-click; opening the palette counts as outside-click (palette mounts at the document level). |
| Codex compacts mid-thread (`contextCompaction` activity) | Cumulative counters reset on Codex's side; next `token_usage_updated` event delivers smaller numbers. Popover repaints; nothing special. |

## Testing Strategy

Three test files:

### 1. `tokenSegments.test.ts` (NEW, pure logic)

Vitest, no React. Cases:
- Happy path: `inputTokens=10000, cachedInputTokens=8000, outputTokens=2000, reasoningTokens=500` → segments `(8000, 2000, 500, 1500)`, `pctFull` requires `windowTokens`.
- No cache: `cachedInputTokens` missing → `Cached=0, Conversation=inputTokens`.
- No reasoning: `reasoningTokens` missing → `Reasoning=0, Output=outputTokens`.
- Clamp Cached: `cachedInputTokens > inputTokens` → Cached = inputTokens, Conversation = 0.
- Clamp Reasoning: `reasoningTokens > outputTokens` → Reasoning = outputTokens, Output = 0.
- `pctFull` rounds to integer; missing `contextWindow` → `pctFull` undefined.
- Total = sum of segments (regression: must match input arithmetic after clamping).

### 2. `ContextPopover.test.tsx` (NEW, React Testing Library)

- Renders all 4 legend rows with correct labels and formatted token counts (`18.4K`, etc.).
- Renders `pctFull` headline when window known; renders only token total when window missing.
- Renders `Last turn` line iff `usage.last` is present.
- Hides `Last turn` line when `usage.last.inputTokens === 0 && usage.last.outputTokens === 0`.
- Empty-state: renders `No usage data yet` when total = 0.
- Clicking close button calls `onClose`.
- Pressing `Esc` calls `onClose`.
- Clicking outside the popover (a sibling div) calls `onClose`.
- Clicking inside the popover does NOT call `onClose`.

### 3. `TokenUsageMeter.test.tsx` (NEW, integration)

- Pill renders without popover when `open=false` (`queryByRole('dialog')` is null).
- Clicking pill opens popover (`getByRole('dialog')` resolves).
- Clicking pill again toggles closed.
- `aria-expanded` on the button mirrors `open`.

### 4. `codexNotificationRouter.test.ts` (EXTENDED)

Add cases to the existing `thread/tokenUsage/updated` block:
- `tokenUsage.total` + `tokenUsage.last` both present → returned `usage.last` matches `tokenUsage.last`.
- `tokenUsage.total` only, no `tokenUsage.last` → returned `usage.last` is `undefined`.
- `tokenUsage.last` with all-zero counts → `usage.last` omitted (no fake data).
- Snake-case aliases inside `last` (`input_tokens` etc.) handled identically to camelCase.

Existing extraction tests must still pass — refactor of `extractTokenUsage` is purely additive.

## Rollout / Risk

- **Risk: layout regression on small panels.** Mitigation: spec width is `min 240 / max 320` with `right-0` anchoring. If panel is < 280px wide the popover may overflow the panel's left edge — acceptable; user already has a horizontal panel resize handle, and content remains readable. (Tested by manually resizing in dev.)
- **Risk: stale numbers if `token_usage_updated` is throttled.** Codex emits this on each turn; latency is bounded. Not mitigating in MVP.
- **Risk: clamping hides real gateway bugs.** Mitigation: `console.debug` log once per session when a clamp fires (`if (cachedInputTokens > inputTokens) ...`). Visible in DevTools but not surfaced in UI.
- **Risk: a future Codex version adds the granular categories (system/tools/etc.).** That's a future enhancement; today's 4-segment design lives behind the same `buildContextSegments()` pure function so a v2 can swap in a 7-segment derivation without touching the popover JSX layout.

## File Changes Summary

| File | Change |
|---|---|
| `src/types/agent.ts` | Add `AgentTokenUsageDelta`, add `last?: AgentTokenUsageDelta` to `AgentTokenUsage`. |
| `src/main/agent/codexNotificationRouter.ts` | `extractTokenUsage()` also reads `tokenUsage.last`; factored shared sub-helper. |
| `src/main/agent/__tests__/codexNotificationRouter.test.ts` | 4 new test cases for `last` extraction. |
| `src/renderer/src/features/agent-chat/tokenSegments.ts` (NEW) | Pure `buildContextSegments(usage)` function + types. |
| `src/renderer/src/features/agent-chat/__tests__/tokenSegments.test.ts` (NEW) | 7 cases per §Testing Strategy. |
| `src/renderer/src/features/agent-chat/ContextPopover.tsx` (NEW) | Popover component + small subcomponents (StackedBar, PctFullDisplay, SegmentLegend, LastTurnLine). |
| `src/renderer/src/features/agent-chat/__tests__/ContextPopover.test.tsx` (NEW) | RTL tests per §Testing Strategy. |
| `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx` | Wrap pill in `<div className="relative">`, change pill to `<button>`, add `useState(open)`, conditionally render `<ContextPopover />`. |
| `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx` (NEW) | RTL tests for click-toggle. |
| `src/renderer/src/features/agent-chat/store.ts` | No change — `tokenUsage` already in state and reset on `newThread`/`switchThread`. |

Estimated diff size: ~350 LOC of production code + ~250 LOC of tests, contained within the agent-chat feature folder.

## Open Questions for User Review

1. **Footnote wording.** Current draft: `Codex doesn't break input into Tools / Rules / MCP — those tokens are inside Cached prompt / Conversation.` Is that honest enough, or do you want it shorter / removed?
2. **`Last turn` line position.** Reference image puts it inside the bar block; this spec puts it under the legend in dim mono. Either works — confirm placement.
3. **Cached color.** I'm proposing emerald (matches Claude Code reference). If the panel's existing accent is cyan and you want the popover to feel cohesive, we could swap to teal/cyan and shift Output to a neutral grey. Aesthetic call.
4. **Popover dismiss on Cmd+P.** Currently we let the palette handler close us via outside-click. If you'd prefer the popover to survive command-palette opens (so you can read the breakdown while jumping threads), say so and we'll skip the document-level mousedown listener.
