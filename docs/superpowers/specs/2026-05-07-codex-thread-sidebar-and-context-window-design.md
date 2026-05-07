# Codex Agent — Thread Sidebar, Persistence Recovery & Context Window — Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-05-07
**Author:** Cursor agent at user request
**Related:** `2026-05-07-codex-agent-chat-redesign-design.md` (parent), `2026-05-07-context-popover-design.md` (sibling — popover gets its `% Full` headline once `contextWindow` is wired)

## Goal

Make the Codex agent chat panel feel like a real persistent multi-thread surface (Cursor-style) rather than a transient single-thread conversation. Concretely:

1. **Boot → most recent thread is restored automatically.** No more empty panel on app restart even though messages exist in the DB.
2. **A visible thread switcher.** Today the only switcher is `Cmd+P` (`ThreadCommandPalette`); users do not discover it. Add a Cursor-style sidebar grouped by `Today / Yesterday / Last 7 Days / Older`.
3. **Thread management primitives.** Rename / delete a thread inline, plus the still-broken `openThread` IPC channel actually wired up.
4. **Codex actually knows the model context window.** Currently it doesn't, so `tokenUsage.contextWindow` is undefined → popover shows no `% Full`, and Codex never auto-compacts because it doesn't know when to trigger.
5. **Verify auto-title generation works** end-to-end after (1)–(4) land.

## Non-Goals

- **No multi-window / multi-pane editing.** One active thread at a time. (Cursor's tabs across the top are out of scope.)
- **No cross-thread search.** Cmd+P palette already filters by title prefix; we keep that.
- **No thread folders / tags / pinning.** Flat list grouped by recency only. Pinning could be added later behind the same `ThreadStore` API.
- **No optimistic title editing.** Renames go through the main process and re-fetch (eventual consistency). The list re-renders when the IPC roundtrip returns.
- **No thread export.** Out of scope for this pass.
- **No per-model context-window configuration.** Codex's `-c model_context_window=N` is a single value applied to all spawned models. We pick one value (200000) that fits the GPT-5.x family well enough; if a future model wants 1M, we revisit.
- **No animated transitions between thread switches.** Hard cut. The store already resets messages + tokenUsage on `switchThread`; we don't add fades.
- **No fixing `ThreadTitleSummarizer` proactively.** We assume it works (logic is sound — `AgentManager.forwardEvents` calls `maybeSummarize` on `turn_completed`, summarizer needs ≥2 messages). After (1)–(4) land we observe whether titles auto-generate; if not, that becomes a separate debug pass.

## User Story

1. User has used the panel for a few weeks. Postgres-backed `AgentThread` table holds 12 threads.
2. User restarts the app.
3. Panel opens → previously the panel was blank ("重启后历史对话记录丢失"). **Now**: store calls `agent.listThreads()` on mount, picks the latest thread, calls `switchThread(latest.id)`, and the panel renders the full history.
4. User clicks the new sidebar toggle in the panel header → a 240px sidebar slides in to the **left** of the chat (between main app and chat panel).
5. Sidebar shows:
   - Top: `+ New chat` button with a dimmed `⌘P` hint.
   - Sections: `Today`, `Yesterday`, `Last 7 Days`, `Older` (only sections with at least one thread render).
   - Each row: thread title (truncated, single-line) + relative time on the right.
   - Currently active thread row: 2px cyan left-border + slightly brighter background.
   - Hover row: `⋯` icon appears at the far right; clicking opens a tiny popover with `Rename` / `Delete`.
6. User clicks a `Yesterday` thread → `switchThread(id)` runs end-to-end (IPC channel `agent:open-thread` now wired); messages hydrate; tokenUsage resets to undefined and re-arrives on the next `thread/tokenUsage/updated`.
7. User clicks the same toggle → sidebar collapses to a 24px rail with just an expand chevron. State persists across app reloads via `localStorage`.
8. User opens the existing `TokenUsageMeter` popover → because Codex now knows `model_context_window=200000`, the popover shows `12% Full ~24K / 200K Tokens`. As the conversation grows past 180K tokens, Codex itself triggers auto-compaction; the next `thread/tokenUsage/updated` carries smaller cumulative counts.

## Architecture

### Bug B fix — IPC channel name mismatch

`src/main/agent/ipc.ts` currently registers:

```ts
ipcMain.handle('agent:list-threads', () => manager.listThreads())
ipcMain.handle('agent:load-thread', (_event, threadId: string) => manager.loadThread(threadId))
```

`src/preload/index.ts` exposes:

```ts
listThreads: () => safeInvoke(IPC_CHANNELS.AGENT.LIST_THREADS),   // 'agent:list-threads' ✓ matches
loadThread: () => safeInvoke(IPC_CHANNELS.AGENT.LOAD_THREAD),     // 'agent:load-thread' ✓ matches
openThread: () => safeInvoke(IPC_CHANNELS.AGENT.OPEN_THREAD),     // 'agent:open-thread' ✗ NO HANDLER
renameThread: () => safeInvoke(IPC_CHANNELS.AGENT.RENAME_THREAD), // 'agent:rename-thread' ✗ NO HANDLER
deleteThread: () => safeInvoke(IPC_CHANNELS.AGENT.DELETE_THREAD), // 'agent:delete-thread' ✗ NO HANDLER
```

`store.switchThread` calls `agent.openThread(id)` — that fails today because main has no handler for `agent:open-thread`.

Fix: add three handlers to `ipc.ts`. `AgentManager.openThread` already exists and proxies to `store.openThread`; we add `renameThread` and `deleteThread` proxies (the underlying `ThreadStore` methods exist — `renameThreadIfNotManual` is one, plus we need a generic `renameThread` that always sets `manualTitle`).

```ts
ipcMain.handle('agent:open-thread', (_event, threadId: string) => manager.openThread(threadId))
ipcMain.handle('agent:rename-thread', (_event, threadId: string, title: string) =>
  manager.renameThread(threadId, title))
ipcMain.handle('agent:delete-thread', (_event, threadId: string) =>
  manager.deleteThread(threadId))
```

### Bug A fix — boot-time thread restoration

A new `bootstrap()` action on the store + a single `useEffect` on `AgentChatPanel` (or one of its parents that already mounts):

```ts
// store.ts
bootstrap: async () => {
  const agent = (window as any).electronAPI?.agent
  if (!agent?.listThreads) return
  try {
    const threads = await agent.listThreads()
    if (threads.length === 0) return  // no threads → keep "new chat" state
    const latest = threads[0]          // listThreads returns updatedAt-DESC
    await get().switchThread(latest.id)
  } catch {
    // Boot recovery is best-effort; never block panel from rendering.
  }
}
```

`AgentChatPanel.tsx`:

```ts
useEffect(() => {
  void useAgentChatStore.getState().bootstrap()
}, [])
```

Edge cases:

- `bootstrap()` is idempotent: if `state.threadId` is already set when it runs, skip. Prevents double-load if mount fires twice in StrictMode.
- If user starts typing before `listThreads()` resolves, the in-flight `switchThread` would clobber `messages: []` and discard their unsent draft. Mitigation: `bootstrap()` checks `state.input.length === 0 && state.messages.length === 0` before switching.

### Bug C — `ThreadSidebar` component

New file: `src/renderer/src/features/agent-chat/ThreadSidebar.tsx`. Sibling of `AgentChatPanel`. Mounted unconditionally inside `AgentChatPanel.tsx` so it shares the panel's open state.

Layout (with both shown, matching the user's reference Cursor sidebar):

```
                            ┌─────────────┬───────────────────────┐
                            │             │                       │
[main app content area]     │  sidebar    │   chat panel          │
                            │  240px      │   420-720px           │
                            │             │                       │
                            └─────────────┴───────────────────────┘
                            ↑ left edge: right - (chat width + sidebar width)
                                                                  ↑ right edge: 0
```

Both `ThreadSidebar` and `AgentChatPanel` are `position: fixed`. Their `right` offsets are computed from a single `panelWidth + sidebarWidth` reduce in the store, so they slot together with no gap.

State (added to existing `useAgentChatStore`):

```ts
sidebarOpen: boolean              // localStorage-persisted
sidebarWidth: number              // 200..360, default 240, persisted
threadList: AgentThreadSummary[]  // refreshed on bootstrap, on send-completed, on rename/delete
threadListLoading: boolean
toggleSidebar: () => void
setSidebarWidth: (n: number) => void
refreshThreadList: () => Promise<void>
renameActiveThread: (title: string) => Promise<void>
deleteThread: (id: string) => Promise<void>
```

`ThreadSidebar` renders:

```
<aside fixed right=panelWidth top=0 width=sidebarWidth>
  <header> ⌘P toggle / +New chat </header>
  <ResizableHandle side="left" />   // mirror of the chat panel's right-side handle
  <nav scrollable>
    {grouped.map(group => (
      <Group title={group.label}>
        {group.threads.map(t => <ThreadRow ... />)}
      </Group>
    ))}
  </nav>
</aside>
```

`ThreadRow`:

```tsx
<button
  type="button"
  onClick={() => switchThread(t.id)}
  className={[
    'w-full px-3 py-1.5 text-left text-[12px] transition',
    isActive ? 'border-l-2 border-cyan-400 bg-cyan-500/10 text-cyan-100' : 'text-zinc-200 hover:bg-zinc-800/60',
  ].join(' ')}
>
  <span className="truncate">{t.title || 'Untitled'}</span>
  <span className="ml-auto text-[10px] text-zinc-500">{relativeTime(t.lastMessageAt)}</span>
  <button className="opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); openMenu(t.id) }}>⋯</button>
</button>
```

`relativeTime(ts)`:
- < 60s → `刚刚`
- < 60min → `Nm`
- < 24h → `Hh`
- < 7d → weekday name
- else → `MM-DD`

Grouping (computed in a `useMemo`):

```ts
const groups = [
  { label: 'Today', test: (t) => isToday(t.lastMessageAt) },
  { label: 'Yesterday', test: (t) => isYesterday(t.lastMessageAt) },
  { label: 'Last 7 Days', test: (t) => withinDays(t.lastMessageAt, 7) && !isToday(...) && !isYesterday(...) },
  { label: 'Older', test: () => true },
]
```

### Bug C — header toggle

Add to `AgentChatPanel`'s header, left of `<TokenUsageMeter />`:

```tsx
<button
  type="button"
  onClick={() => useAgentChatStore.getState().toggleSidebar()}
  aria-label="Toggle thread sidebar"
  title="Threads (⌘+B)"
  className="..."
>
  {sidebarOpen ? <CollapseIcon /> : <ExpandIcon />}
</button>
```

A second keyboard shortcut `Cmd+B` (or `Ctrl+B` on Windows) toggles. The existing `Cmd+P` palette stays — they coexist as fast vs visual switchers.

### Bug E fix — model_context_window + auto_compact

Add two `-c` overrides in `buildCodexLaunchArgs`:

```ts
'-c', 'model_context_window=200000',
'-c', 'model_auto_compact_token_limit=180000',
```

Rationale:
- 200000 covers GPT-5.x family (most are 128K–200K). Models with smaller windows will simply hit the gateway's own truncation before Codex's compaction triggers — Codex over-estimating doesn't break correctness, only timing.
- 180000 = 90% of 200000. Codex compacts when usage exceeds this number. Empirically the system summarizes the older half of the conversation and replaces it in-place.

`tokenUsage.contextWindow` doesn't change as a result of these flags — Codex still doesn't ship the window in `thread/tokenUsage/updated`. We need an additional pure-renderer fallback: when the cumulative `usage.contextWindow` is missing, the popover and meter consult a constant `DEFAULT_MODEL_CONTEXT_WINDOW = 200000` (kept in sync with `codexLaunch.ts` via a shared constant in `src/types/agent.ts`).

```ts
// src/types/agent.ts
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000

// TokenUsageMeter.tsx + ContextPopover.tsx via tokenSegments.ts
const window = usage.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW
```

This couples the renderer's display to the spawn-time Codex flag — they MUST agree. We document the constraint in a comment and add a unit test that pulls both values via a single import (so flipping one without the other becomes a compile-fail).

### Bug D — title generation verification (no code change yet)

After (A)+(B)+(C)+(E) ship and the user restarts:
1. Create a new thread.
2. Send 1 user message; wait for assistant reply (one full `turn_completed`).
3. After ~3 seconds, sidebar should re-fetch via `refreshThreadList()` (triggered on each `turn_completed`).
4. The new thread's title should be 4–6 Chinese words generated by `ThreadTitleSummarizer`.

**If the title is the default placeholder** (`"新对话"` or empty) instead of a real summary, that's a separate Bug D follow-up: we'd then debug whether `summarizer.maybeSummarize` is actually being invoked, whether the LLM call returns, etc. Not in scope for this spec.

### Auto-refresh hooks

Sidebar must reflect:
- New thread created → after `agent.sendMessage` resolves with a new `threadId`, call `refreshThreadList()`.
- Each `turn_completed` event → debounced `refreshThreadList()` (so titles + lastMessageAt update).
- Rename / delete → optimistic local update + `refreshThreadList()` afterward.

Implemented as a single subscriber inside `applyEvent` for `turn_completed`, using a 500ms debounce to avoid spamming the IPC channel during rapid back-to-back turns.

## Edge Cases

| Case | Behavior |
|---|---|
| App boot with empty DB | `listThreads()` returns `[]`. `bootstrap()` returns early. Panel shows the existing empty-state hint. Sidebar shows only the `+ New chat` button. |
| App boot with 1 thread | `bootstrap()` switches to it. Sidebar shows it under `Today`. |
| User on thread X clicks thread X | `switchThread` is called but is a no-op for same id. No re-fetch. Cursor's row stays highlighted. |
| User clicks a thread mid-turn (`isRunning=true`) | Disable thread rows when `isRunning && id !== currentThreadId`. Visual: dim + cursor:not-allowed. Tooltip: "Wait for the current turn to finish". (Already implemented in `ThreadCommandPalette`; same logic ported.) |
| User deletes the active thread | After delete: `refreshThreadList()`; if the active thread is gone from the list, set state to "new chat" (`newThread()`). |
| User renames a thread to empty string | Reject in `renameThread` (don't let the DB take an empty title). Inline editor shows "Title can't be empty" hint and reverts. |
| Sidebar collapsed + user presses ⌘+B | Sidebar opens. State persists. |
| Sidebar resized below 200 / above 360 | Clamped on `setSidebarWidth`. |
| `agent.listThreads` returns an unexpected shape (legacy DB) | `bootstrap()` and `refreshThreadList()` defensively check `Array.isArray(threads)`. Empty list shown if not. Console warn. |
| Codex truncates older messages itself before reaching 180K | Cumulative counts in `tokenUsage` will go DOWN suddenly (Codex's compaction wipes them). The meter's `contextUsage` simply drops; bar shrinks; popover updates. No special UI needed. |

## File Changes Summary

| File | Change |
|---|---|
| `src/main/agent/ipc.ts` | Add 3 handlers: `agent:open-thread`, `agent:rename-thread`, `agent:delete-thread`. |
| `src/main/agent/AgentManager.ts` | Add `renameThread(id, title)` + `deleteThread(id)` proxies to `ThreadStore`. |
| `src/main/agent/ThreadStore.ts` | Add `renameThread(id, title)` (always sets `manualTitle = true`) + `deleteThread(id)`. Add `lastMessageAt` to `listThreads` projection if not already there. |
| `src/main/agent/codexLaunch.ts` | Add 2 `-c` overrides for `model_context_window` and `model_auto_compact_token_limit`. |
| `src/types/agent.ts` | Export `DEFAULT_MODEL_CONTEXT_WINDOW = 200_000` constant. |
| `src/renderer/src/features/agent-chat/store.ts` | Add `bootstrap`, `refreshThreadList`, `toggleSidebar`, `setSidebarWidth`, `renameActiveThread`, `deleteThread` actions + `sidebarOpen`/`sidebarWidth`/`threadList`/`threadListLoading` state + localStorage persistence for sidebar prefs. |
| `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | `useEffect → bootstrap()`. Render `<ThreadSidebar />`. Compute `right` offset for `<aside>` from `sidebarOpen ? sidebarWidth : 0`. Add header toggle button. |
| `src/renderer/src/features/agent-chat/ThreadSidebar.tsx` (NEW) | The component itself + group/row presentational pieces. ~250 LOC. |
| `src/renderer/src/features/agent-chat/relativeTime.ts` (NEW) | Pure formatter for grouping/display. |
| `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx` | Read `usage.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW`. |
| `src/renderer/src/features/agent-chat/tokenSegments.ts` | Same fallback inside `buildContextSegments`. |

Estimated diff size: ~700 LOC production + ~400 LOC tests.

## Testing Strategy

### 1. `ipc.test.ts` (extend)

- Each of the 3 new channels: registered + handler routes to corresponding `manager` method.
- `agent:rename-thread` rejects empty title with a typed error.

### 2. `AgentManager.test.ts` (extend)

- `renameThread` happy-path → store called with id + title.
- `deleteThread` happy-path.
- Both throw if `store` is uninitialized.

### 3. `ThreadStore.test.ts` (extend)

- `renameThread` updates row + sets `manualTitle=true`.
- `deleteThread` removes thread row + cascade-deletes its messages.
- `listThreads` returns rows ordered by `lastMessageAt DESC`.

### 4. `codexLaunch.test.ts` (extend)

- New args contain `model_context_window=200000` and `model_auto_compact_token_limit=180000`.
- These constants match the renderer's `DEFAULT_MODEL_CONTEXT_WINDOW` import (regression guard against drift).

### 5. `store.test.ts` (extend)

- `bootstrap()` with non-empty `listThreads` → calls `switchThread(latest.id)`.
- `bootstrap()` with empty list → keeps `threadId: undefined`.
- `bootstrap()` is no-op when `state.threadId` already set or input is non-empty.
- `toggleSidebar` flips state + writes to localStorage.
- `setSidebarWidth` clamps to [200, 360].
- `refreshThreadList` updates state.threadList from IPC.
- `renameActiveThread` calls `agent.renameThread` and re-fetches.
- `deleteThread` calls IPC + falls back to `newThread()` when active thread is deleted.

### 6. `relativeTime.test.ts` (NEW)

- 6 cases covering each branch (just-now / Nm / Hh / weekday / MM-DD / future-clock-skew).

### 7. `ThreadSidebar.test.tsx` (NEW, RTL)

- Empty state: only `+ New chat` button visible.
- 5 threads grouped correctly across `Today / Yesterday / Last 7 Days / Older`.
- Click row → `switchThread` called.
- Active row has `border-l-2 border-cyan-400` class.
- `isRunning=true` + non-active row → row is `disabled`.
- Hover row → `⋯` button becomes visible. Click `⋯` → menu opens with `Rename` / `Delete`.
- Rename inline editor: empty submit shows error, valid submit calls `renameActiveThread`.
- Delete confirm dialog: cancel → no IPC call, confirm → `deleteThread` called.
- Resizable handle drags within [200, 360].

### 8. Manual smoke (post-merge)

1. Restart app → most recent thread auto-loads with full message history.
2. ⌘+B opens sidebar; click another thread → switches.
3. Hover thread row → ⋯ menu; rename to "测试" → row label updates.
4. Click ⋯ → Delete on a non-active thread → row disappears.
5. Click ⋯ → Delete on the active thread → panel goes to new-chat state.
6. Open `TokenUsageMeter` popover → confirm `12% Full ~24K / 200K Tokens` headline (no longer missing).
7. Send messages until cumulative tokens > 180K → confirm Codex auto-compacts (cumulative numbers drop, no error).
8. Create a new thread, send 1 user message + wait for reply → after ≤5s, sidebar shows the thread with an auto-generated title (Bug D verified working).

## Rollout / Risk

- **Risk: `bootstrap()` race with `Cmd+P` palette.** If user opens Cmd+P during boot, both code paths might call `switchThread`. Mitigation: `switchThread` is already idempotent for the same id; for different ids, the user's later click wins because async IPC resolves in submit order.
- **Risk: 200K context window too generous for some models.** Codex would happily try to send 180K tokens before compacting; the apiyi gateway might reject earlier. Empirical check during smoke test #7. If it fails, we lower the constant in `codexLaunch.ts` AND `agent.ts` together (single source of truth via shared constant).
- **Risk: title generation still doesn't fire after fixes.** Becomes the next debug pass. Spec scoped to NOT solve it preemptively; we observe and decide.
- **Risk: sidebar pushes chat panel off-screen on small monitors.** Default sidebar (240) + min panel (360) = 600px reserved on the right. If user's monitor is ≤ 800px wide and they collapse the main app, this is fine. Mitigation: sidebar can be collapsed independently — falls back to existing Cmd+P.
- **Risk: `lastMessageAt` is null on legacy threads.** `ensureSchema.alignSchema` already backfills it from `updatedAt`. No additional migration.

## Open Questions for User Review (before writing-plans)

1. **Sidebar position.** Spec puts sidebar to the **left** of chat panel (between main app and chat). Cursor's screenshot shows sidebar to the **right** of chat (further from main app). The latter requires the chat panel to detach from `right-0` and slide left — significant CSS surgery. Spec stays with "left of chat" as default; user can override.
2. **`Cmd+B` shortcut.** Borrowed from VS Code's "Toggle Side Bar". Confirm this doesn't collide with anything else in the host shell.
3. **Inline rename vs. modal rename.** Spec uses inline (double-click thread title or pick "Rename" from `⋯` menu, then a text input replaces the title in-place). Modal would be one extra component but more discoverable. Inline default; user can override.
4. **Delete confirmation.** Spec uses a small inline confirm (`Delete? [Cancel] [Delete]` replacing the row temporarily). Could be a modal instead. Inline default.
5. **Auto-refresh frequency.** Spec debounces 500ms after each `turn_completed`. Could be longer (1-2s) if it feels too aggressive. 500ms default.
