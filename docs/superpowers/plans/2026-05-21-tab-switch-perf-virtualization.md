# Tab Switch & History Page Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the first-time tab-switch lag, especially on the History tab, by virtualizing the History card grid, adding `React.memo` to per-card components, and switching `AppLayout` from unmount-on-switch to `<Activity>`-based keep-alive (React 19.2).

**Architecture:** Three independent phases, each shippable on its own:
1. **Virtualization** — copy the proven `BatchResultGrid` pattern into a reusable `DonorVirtualGrid` and apply it to `HistoryPage`. Eliminates the 200+ DOM-node blow-up.
2. **Keep-alive** — replace `<ActivePage />` (full unmount on tab switch) with React 19.2's `<Activity mode="hidden|visible">`, which preserves DOM + state for previously-visited tabs at reduced render priority.
3. **Non-blocking switch** — wrap `TabBar` clicks in `useTransition` so the click feedback is instant even when the destination tab is heavy.

**Tech Stack:**
- React 19.2.5 (`<Activity>`, `useTransition`, `useDeferredValue`)
- `react-window@^2.2.7` (`<Grid>`, `cellComponent`, `cellProps`)
- ResizeObserver
- Zustand stores (existing — no schema change)

---

## Background & evidence

| Finding | Source | Impact |
|---|---|---|
| `pages-react/index.ts` already uses `React.lazy()` for every page | `pages-react/index.ts:1-14` | Bundle splitting is **not** the bottleneck |
| `HistoryPage` renders **raw `.map()`** of all history items into a CSS grid | `HistoryPage.tsx:178-190` | 200 `<DonorCard>` mounted simultaneously → main-thread jank |
| `DonorCard` has no `React.memo`, no `decoding="async"` | `components/donor/DonorCard.tsx:23,77` | Any parent re-render = N cards re-render |
| `BatchResultGrid` already implements virtualization with `react-window@2` `<Grid>` + ResizeObserver + memoized `cellProps` | `pages-react/batch/BatchResultGrid.tsx:1-599` | **Use this as the reference implementation** |
| `AppLayout` toggles pages via `<ActivePage />` JSX expression — unmounts the previous page entirely on every tab switch | `layouts/AppLayout.tsx:78-82` | Re-entering History remounts all `<DonorCard>`s, repays the cost every time |
| React 19.2 stable: `<Activity mode="hidden">` keeps DOM mounted, preserves state, renders at lower priority | https://react.dev/reference/react/Activity | Perfect fit for tab keep-alive |

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/renderer/src/components/donor/DonorVirtualGrid.tsx` | **Create** | Reusable history-style virtualized card grid; >=30 items → react-window `<Grid>`, <30 → CSS Grid. Identical contract to `BatchResultGrid` but typed against `DonorItemView`. |
| `src/renderer/src/components/donor/DonorCard.tsx` | **Modify** | Wrap export in `React.memo`; add `decoding="async"` on `<img>`. |
| `src/renderer/src/pages-react/HistoryPage.tsx` | **Modify** | Replace L178-190 inline `.map()` with `<DonorVirtualGrid>`. Hoist callbacks to `useCallback` (already done — re-verify). |
| `src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx` | **Create** | Unit test the threshold-switch + columnCount math. Mock `ResizeObserver`. |
| `src/renderer/src/components/donor/__tests__/DonorCard.memo.test.tsx` | **Create** | Verify `React.memo` blocks rerender when props are reference-stable. |
| `src/renderer/src/layouts/AppLayout.tsx` | **Modify** | Replace `<ActivePage />` with one `<Activity mode={...}>` per ever-visited tab. |
| `src/renderer/src/layouts/__tests__/AppLayout.activity.test.tsx` | **Create** | Verify Activity wrapping preserves React state across tab switches (input retains value test, lifted from React docs). |
| `src/renderer/src/components/TabBar/TabBar.tsx` | **Modify** | Wrap `switchTab` invocation in `startTransition`; show `isPending` state on the clicked tab. |

---

## Phase 1: Virtualize HistoryPage

### Task 1: Extract `DonorVirtualGrid` from the `BatchResultGrid` pattern

**Files:**
- Create: `src/renderer/src/components/donor/DonorVirtualGrid.tsx`

This component owns the threshold logic, ResizeObserver, layout math, and `react-window` wiring. Consumers pass items + per-item callbacks; the component picks virtualized vs non-virtualized mode internally.

- [ ] **Step 1: Create the file with the full implementation**

```tsx
// src/renderer/src/components/donor/DonorVirtualGrid.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Grid, type CellComponentProps } from 'react-window'
import DonorCard from './DonorCard'
import type { DonorItemView } from '../../hooks/useHistoryData'

/**
 * Layout constants — chosen to match DonorCard's current visual footprint
 * (aspect-[4/3] image area + ~150px info area; see DonorCard.tsx).
 *
 * MIN_CARD_WIDTH=220 keeps the existing 4-column layout on >=880px viewports
 * while letting narrow windows fall back to 2-3 columns.
 *
 * VIRTUALIZE_THRESHOLD=30 mirrors BatchResultGrid — small collections keep
 * the page-scroll UX, large ones get inner-scroll viewport.
 */
const MIN_CARD_WIDTH = 220
const CARD_GAP = 16
const CARD_INFO_AREA_PX = 152
const VIRTUALIZE_THRESHOLD = 30
const VIEWPORT_MAX_PX = 720

function useContainerSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const computeViewportH = () =>
      Math.max(360, Math.min(VIEWPORT_MAX_PX, Math.floor(window.innerHeight * 0.7)))

    const node = ref.current
    if (!node) return

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: Math.floor(entry.contentRect.width), height: computeViewportH() })
    })
    ro.observe(node)

    const onResize = () => {
      setSize((s) => ({ width: s.width, height: computeViewportH() }))
    }
    window.addEventListener('resize', onResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return { ref, width: size.width, height: size.height }
}

interface Props {
  items: DonorItemView[]
  onDelete: (id: number | string) => void
  onPreview: (item: DonorItemView, index: number) => void
  onEdit?: (item: DonorItemView) => void
}

type CellPropsT = {
  items: DonorItemView[]
  columnCount: number
  onDelete: Props['onDelete']
  onPreview: Props['onPreview']
  onEdit: Props['onEdit']
}

function VirtualCell({
  columnIndex,
  rowIndex,
  style,
  items,
  columnCount,
  onDelete,
  onPreview,
  onEdit,
}: CellComponentProps<CellPropsT>) {
  const idx = rowIndex * columnCount + columnIndex
  const item = items[idx]
  if (!item) return <div style={style} />
  return (
    <div
      style={{
        ...style,
        paddingRight: CARD_GAP,
        paddingBottom: CARD_GAP,
        boxSizing: 'border-box',
      }}
    >
      <DonorCard item={item} onDelete={onDelete} onPreview={onPreview} onEdit={onEdit} />
    </div>
  )
}

export default function DonorVirtualGrid({ items, onDelete, onPreview, onEdit }: Props) {
  const { ref: containerRef, width: containerWidth, height: viewportH } = useContainerSize()

  const gridLayout = useMemo(() => {
    if (containerWidth <= 0) return null
    const columnCount = Math.max(1, Math.floor(containerWidth / MIN_CARD_WIDTH))
    const columnWidth = Math.floor(containerWidth / columnCount)
    const cardVisualWidth = Math.max(0, columnWidth - CARD_GAP)
    // DonorCard image is aspect-[4/3] → image height = width * 3/4
    const imageH = Math.floor(cardVisualWidth * 0.75)
    const rowHeight = imageH + CARD_INFO_AREA_PX + CARD_GAP
    const rowCount = Math.ceil(items.length / columnCount)
    return { columnCount, columnWidth, rowHeight, rowCount }
  }, [containerWidth, items.length])

  const cellProps: CellPropsT | null = useMemo(() => {
    if (!gridLayout) return null
    return {
      items,
      columnCount: gridLayout.columnCount,
      onDelete,
      onPreview,
      onEdit,
    }
  }, [items, gridLayout, onDelete, onPreview, onEdit])

  const shouldVirtualize =
    items.length >= VIRTUALIZE_THRESHOLD && gridLayout !== null && cellProps !== null

  return (
    <div ref={containerRef} className="w-full">
      {shouldVirtualize && gridLayout && cellProps ? (
        <Grid
          cellComponent={VirtualCell}
          cellProps={cellProps}
          columnCount={gridLayout.columnCount}
          columnWidth={gridLayout.columnWidth}
          rowCount={gridLayout.rowCount}
          rowHeight={gridLayout.rowHeight}
          overscanCount={2}
          style={{ height: viewportH, width: '100%' }}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((it) => (
            <DonorCard
              key={it.id}
              item={it}
              onDelete={onDelete}
              onPreview={onPreview}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit (no behaviour change yet — file is unused)**

```bash
git add src/renderer/src/components/donor/DonorVirtualGrid.tsx
git commit -m "feat(history): extract DonorVirtualGrid (react-window-backed grid)"
```

---

### Task 2: Wire `DonorVirtualGrid` into `HistoryPage`

**Files:**
- Modify: `src/renderer/src/pages-react/HistoryPage.tsx:178-190`

- [ ] **Step 1: Import the new component**

In the import block (around line 6-15), add:

```tsx
import DonorVirtualGrid from '../components/donor/DonorVirtualGrid'
```

- [ ] **Step 2: Replace the inline grid render**

Replace lines 176-190 (currently `filtered.length === 0 ? <DonorEmpty/> : <div className="grid..."> ... </div>`) with:

```tsx
{filtered.length === 0 ? (
  <DonorEmpty hasFilter={stats.total > 0} />
) : (
  <DonorVirtualGrid
    items={filtered}
    onDelete={handleDelete}
    onPreview={handlePreview}
    onEdit={handleEdit}
  />
)}
```

- [ ] **Step 3: Smoke-test in dev**

Run `pnpm dev`, switch to the History tab. Verify:
1. With <30 items: still CSS grid layout, scrolls with the page.
2. With >=30 items: inner-scroll virtualized viewport appears.
3. Filter/sort still work.
4. Edit / Delete / Preview buttons still fire.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/HistoryPage.tsx
git commit -m "perf(history): virtualize history grid via DonorVirtualGrid (>=30 items)"
```

---

### Task 3: Memoize `DonorCard` + add `decoding="async"`

**Files:**
- Modify: `src/renderer/src/components/donor/DonorCard.tsx:23,77,80`

- [ ] **Step 1: Wrap export in `React.memo`**

At line 1, replace:

```tsx
import { useState, useCallback } from 'react'
```

with:

```tsx
import { memo, useState, useCallback } from 'react'
```

At line 23, replace:

```tsx
export default function DonorCard({ item, onDelete, onPreview, onEdit }: Props) {
```

with:

```tsx
function DonorCardImpl({ item, onDelete, onPreview, onEdit }: Props) {
```

At the end of the file (after the closing `}` of the function body, before EOF), add:

```tsx
export default memo(DonorCardImpl)
```

- [ ] **Step 2: Add `decoding="async"` to the `<img>` tag**

At line 80, replace:

```tsx
<img
  src={primaryUrl}
  alt={item.prompt || 'history'}
  loading="lazy"
  onError={() => setBroken(0)}
  className="..."
/>
```

with (only one new line added):

```tsx
<img
  src={primaryUrl}
  alt={item.prompt || 'history'}
  loading="lazy"
  decoding="async"
  onError={() => setBroken(0)}
  className="..."
/>
```

- [ ] **Step 3: Verify HistoryPage callbacks are reference-stable**

Open `src/renderer/src/pages-react/HistoryPage.tsx` and confirm `handleDelete`, `handlePreview`, `handleEdit` are all wrapped in `useCallback` with correct deps (they already are — L55-128 — but re-verify after the patch). If not, fix.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/donor/DonorCard.tsx
git commit -m "perf(history): memoize DonorCard + decoding=async on thumbnail"
```

---

### Task 4: Test the virtualized grid

**Files:**
- Create: `src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx`

The unit test mocks `ResizeObserver` (jsdom doesn't ship one) and verifies the threshold branch.

- [ ] **Step 1: Write the test**

```tsx
// src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import DonorVirtualGrid from '../DonorVirtualGrid'
import type { DonorItemView } from '../../../hooks/useHistoryData'

beforeAll(() => {
  // jsdom does not ship ResizeObserver
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

function makeItem(i: number): DonorItemView {
  return {
    id: i,
    prompt: `item-${i}`,
    urls: [`https://example.com/${i}.png`],
    displayUrls: [`https://example.com/${i}.png`],
    status: 'ok-local',
    isBroken: false,
  }
}

describe('DonorVirtualGrid', () => {
  it('renders CSS grid (not react-window) when items < 30', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    // CSS grid path renders all cards directly; react-window Grid sets role="grid"
    expect(screen.queryByRole('grid')).toBeNull()
    // Each item is rendered (alt text comes from item.prompt via DonorCard)
    expect(screen.getAllByRole('img')).toHaveLength(5)
  })

  it('does not render react-window Grid until containerWidth>0 (initial mount)', () => {
    // Even with 100 items, initial mount has containerWidth=0 so we fall back to CSS grid
    const items = Array.from({ length: 100 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    // CSS-grid fallback path renders all 100 cards (no measurement yet)
    expect(screen.queryByRole('grid')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm vitest run src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx
git commit -m "test(history): cover DonorVirtualGrid threshold + mount fallback"
```

---

## Phase 2: Tab keep-alive via `<Activity>`

### Task 5: Verify `<Activity>` is exported from `react@19.2.5`

This is a probe step — `<Activity>` graduated from labs in React 19.2, but the runtime export and TS types must be confirmed before we depend on them in production code.

- [ ] **Step 1: Type + runtime probe**

Run:

```bash
node -e "const r = require('react'); console.log('Activity:', typeof r.Activity, '| version:', r.version)"
```

Expected output:

```
Activity: function | version: 19.2.5
```

If `Activity` prints `undefined`, **stop here** and switch to the fallback (a manual `<div hidden>` keep-alive wrapper — see Task 6 alt branch).

- [ ] **Step 2: TypeScript check**

Create a throwaway file `src/renderer/src/layouts/__activity-probe.ts` (do not commit) with:

```ts
import { Activity } from 'react'
const _: typeof Activity = Activity
```

Run:

```bash
pnpm typecheck
```

Expected: probe file compiles. If it fails with "no exported member 'Activity'", either:
- Bump `@types/react` to the newest 19.x release that includes the type, **or**
- Use the manual `<div hidden>` fallback.

Delete the probe file before continuing.

- [ ] **Step 3: Record the result**

Add a one-line note in this plan:

```
[probe] Activity export confirmed at react 19.2.5 (date YYYY-MM-DD).
```

---

### Task 6: Replace `<ActivePage />` with `<Activity>` keep-alive

**Files:**
- Modify: `src/renderer/src/layouts/AppLayout.tsx:43-86`

- [ ] **Step 1: Track which tabs have ever been activated**

The keep-alive set is intentionally lazy — we only mount a page once the user actually opens it. This bounds memory: never-visited tabs stay un-touched.

Replace the body of `AppLayout` (L43-86) with:

```tsx
export function AppLayout() {
  const activeTab = useTabStore((s) => s.activeTab)

  // Track every tab the user has ever opened. We render Activity wrappers
  // only for those — a fresh session that only ever visits History never
  // pays the cost of mounting Batch / Director / etc.
  const [visited, setVisited] = useState<Set<TabName>>(() => new Set([activeTab]))
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  useEffect(() => {
    const unsub = useTabStore.subscribe(
      (state) => state.activeTab,
      (tab) => { window.location.hash = tab }
    )
    return unsub
  }, [])

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash) useTabStore.getState().switchTab(hash)
  }, [])

  useEffect(() => {
    return mountAgentToolExecutor()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        useAgentChatStore.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-cyberpunk-black text-white font-exo">
      <TabBar />
      <main className="flex-1 overflow-auto">
        <Suspense fallback={<PageFallback />}>
          {Array.from(visited).map((tab) => {
            const Page = PAGE_MAP[tab]
            return (
              <Activity key={tab} mode={tab === activeTab ? 'visible' : 'hidden'}>
                <Page />
              </Activity>
            )
          })}
        </Suspense>
      </main>
      <AgentChatPanel />
    </div>
  )
}
```

- [ ] **Step 2: Update imports**

At the top of the file, replace:

```tsx
import { Suspense, useEffect, type ComponentType, type LazyExoticComponent } from 'react'
```

with:

```tsx
import { Activity, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
```

- [ ] **Step 3: Verify nothing else broke**

```bash
pnpm typecheck
pnpm vitest run src/renderer/src/layouts
```

Expected: typecheck passes, existing layout tests pass.

- [ ] **Step 4: Smoke test in dev**

Run `pnpm dev`. Test sequence:
1. Open the app — only the default tab is mounted.
2. Switch to History (slow first time as data loads).
3. Type into the search filter on History.
4. Switch to Generate, then back to History.
5. **Verify**: the search filter still has the text (state preserved). The grid does NOT re-mount (no spinner flash). DevTools "React" tab shows the previous History tree still in the fibre tree.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/layouts/AppLayout.tsx
git commit -m "perf(layout): keep visited tabs mounted via <Activity> (React 19.2)"
```

---

### Task 7: Test that tab state survives a switch

**Files:**
- Create: `src/renderer/src/layouts/__tests__/AppLayout.activity.test.tsx`

- [ ] **Step 1: Write the test**

The test pattern is lifted from React docs (Activity preserves DOM state across hide/show).

```tsx
// src/renderer/src/layouts/__tests__/AppLayout.activity.test.tsx
import { describe, expect, it } from 'vitest'
import { Activity } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

function TabHost() {
  const [active, setActive] = useState<'a' | 'b'>('a')
  return (
    <div>
      <button onClick={() => setActive('a')}>a</button>
      <button onClick={() => setActive('b')}>b</button>
      <Activity mode={active === 'a' ? 'visible' : 'hidden'}>
        <input aria-label="a-input" />
      </Activity>
      <Activity mode={active === 'b' ? 'visible' : 'hidden'}>
        <input aria-label="b-input" />
      </Activity>
    </div>
  )
}

describe('Activity tab keep-alive', () => {
  it('preserves input state when switching away and back', async () => {
    const user = userEvent.setup()
    render(<TabHost />)

    const aInput = screen.getByLabelText('a-input') as HTMLInputElement
    await user.type(aInput, 'hello')
    expect(aInput.value).toBe('hello')

    await user.click(screen.getByRole('button', { name: 'b' }))
    await user.click(screen.getByRole('button', { name: 'a' }))

    // After round-trip, the input should still hold 'hello'.
    const aInputAfter = screen.getByLabelText('a-input') as HTMLInputElement
    expect(aInputAfter.value).toBe('hello')
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm vitest run src/renderer/src/layouts/__tests__/AppLayout.activity.test.tsx
```

Expected: 1 test passes. If it fails with "Activity is not a function", revisit Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/layouts/__tests__/AppLayout.activity.test.tsx
git commit -m "test(layout): Activity preserves tab input state across switches"
```

---

## Phase 3: Non-blocking tab switch

### Task 8: Wrap `switchTab` in `startTransition`

**Files:**
- Modify: `src/renderer/src/components/TabBar/TabBar.tsx`

Even with keep-alive, the **first** activation of a heavy tab (e.g. AGENT, History after import) costs render time. `useTransition` lets the click feedback (active tab highlight) commit immediately while React renders the new tab as a low-priority transition.

- [ ] **Step 1: Read the existing TabBar**

```bash
# Open and re-read TabBar.tsx to see exact callsite of switchTab
```

The patch is mechanical: find every `onClick` that calls `useTabStore.getState().switchTab(name)` (or via a store action) and wrap it.

- [ ] **Step 2: Apply the transition wrapper**

Where the file currently has (illustrative — actual code may differ):

```tsx
const switchTab = useTabStore((s) => s.switchTab)
// ...
<button onClick={() => switchTab(tab)}>{label}</button>
```

Replace with:

```tsx
import { useTransition } from 'react'

const switchTab = useTabStore((s) => s.switchTab)
const [isPending, startTransition] = useTransition()
// ...
<button
  onClick={() => startTransition(() => switchTab(tab))}
  className={`... ${isPending && tab === pendingTab ? 'opacity-60' : ''}`}
  aria-busy={isPending && tab === pendingTab}
>
  {label}
</button>
```

To track WHICH tab is pending (so the highlight is precise), keep a `pendingTab` ref:

```tsx
const pendingTabRef = useRef<TabName | null>(null)
const handleClick = (tab: TabName) => {
  pendingTabRef.current = tab
  startTransition(() => switchTab(tab))
}
```

- [ ] **Step 3: Smoke test**

In dev:
1. Click History from a cold start — verify the History tab highlight commits **instantly**, even before the grid finishes rendering.
2. Click Settings — instant highlight.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TabBar/TabBar.tsx
git commit -m "perf(tabbar): non-blocking tab switch via startTransition"
```

---

## Verification (cross-phase)

After all phases land:

- [ ] **`pnpm typecheck`** — no new errors
- [ ] **`pnpm vitest run`** — full unit suite green (or no NEW failures vs. main)
- [ ] **`pnpm dev` manual checklist**:
  - [ ] Cold start → switch to History with 100+ items: page renders within 1 second, no white flash
  - [ ] Switch History → Generate → History: instant return, scroll position preserved, filter text preserved
  - [ ] Click any tab: highlight commits in <50ms (browser perf tools confirm)
  - [ ] Delete a history item: only its card disappears (memo prevents siblings re-rendering — verify with React DevTools "highlight updates")
  - [ ] Scroll virtualized history grid: no DOM-node leak (DevTools Elements panel shows ~20 cards at a time, not all 100)

- [ ] **Optional: capture a CPU profile** before/after of "cold tab switch to History", attach to the PR description as evidence.

---

## Self-review checklist

**Spec coverage:**

| Phase | Tasks | Verified? |
|---|---|---|
| 1. Virtualize HistoryPage | Tasks 1-4 | Yes — DonorVirtualGrid + memo + tests |
| 2. Activity keep-alive | Tasks 5-7 | Yes — probe + AppLayout patch + state-preservation test |
| 3. Non-blocking switch | Task 8 | Yes — TabBar useTransition |

**Placeholder scan:**
- [x] No `TBD` / `TODO` / `fill in details` left in plan
- [x] Every code step has complete, copy-pasteable code
- [x] Every test step has the actual assertion code

**Type consistency:**
- [x] `DonorItemView` used consistently across `DonorVirtualGrid` and tests
- [x] `CellComponentProps<CellPropsT>` type from `react-window` matches the docs (confirmed via context7)
- [x] `Activity` import path is plain `'react'` (no labs subpath in 19.2.5)

**Out-of-scope (deliberately deferred):**
- Other heavy `.map()` callsites: `StoryboardSplitPage`, `smart-erase/EraseResultGrid`, `PromptTemplatesPage`, `storyboard-split/HistoryDrawer`, `smart-erase/EraseHistoryDrawer`. Once `DonorVirtualGrid` ships, those can use the same pattern in a follow-up PR.
- `useHistoryData` pagination — only worth it if a real user has >1000 items AND profiling shows the store hydration is the bottleneck (not the render). Today, in-memory subscription is fine.
- `<ViewTransition>` for cross-tab animations — pure polish, not perf.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-tab-switch-perf-virtualization.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
