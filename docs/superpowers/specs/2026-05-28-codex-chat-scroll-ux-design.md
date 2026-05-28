# Codex Chat Scroll UX — Design Spec

**Date:** 2026-05-28
**Author:** brainstorming pair-session with user
**Status:** Approved (user said "approve → write spec + start TDD")
**Branch:** `feat/codex-chat-scroll-ux`

## 1. Goal

Make the Codex chat panel feel like Cursor / VS Code / ChatGPT chat instead of a "static document":

1. **Open default = bottom** — opening or switching to a thread lands at the most recent message, not the top.
2. **Stick-to-bottom during streaming** — "AI 输出 滑轮只要在最底部 滑轮应该和输出一起动" — the viewport follows tokens as they arrive.
3. **User scroll-up unlocks** — user can scroll up freely without being yanked back; auto-follow resumes when user returns to bottom or clicks the floating button.
4. **Ghost scrollbar that gently widens on hover** — replace the default browser scrollbar with a macOS-style overlay that auto-hides and widens with a 200 ms transition.
5. **Virtualization (lazy render, not lazy load)** — only render visible rows; DOM stays small regardless of thread size. **No backend pagination** in this iteration (user picked option A in brainstorming).

## 2. Non-Goals (YAGNI)

- ❌ Backend pagination (`agent.loadThread(id, { cursor, limit })`). Deferred to a separate proposal if a user ever hits a 5000+ message thread.
- ❌ Reverse infinite scroll on hitting top.
- ❌ Smooth scroll during token streaming (VS Code #274099 documents this as a hard problem — we explicitly skip it and let Virtuoso's default jump-to-bottom suffice).
- ❌ Replacing the chat data model / IPC schema / store reducer.

## 3. Industry Context (why this design, not another)

| Signal | Source | Influence |
|---|---|---|
| Codex desktop itself has **no virtualization** and chokes on big threads | `openai/codex#18693` (open) | We must do better — virtualization is the right ceiling-raiser |
| Smooth scroll fights dynamic-height rows during streaming | `microsoft/vscode#274099` (open) | We pick `behavior: "auto"` during streaming, only `smooth` when user clicks the floating button |
| Floating "scroll to bottom" button when user is >20% from bottom is the converged industry pattern | `microsoft/vscode#291847` (open PR), Copilot IntelliJ #448, GitNexus #767 | We adopt the same UX |
| Stick-to-bottom + unlock-on-user-scroll is the converged interaction | Copilot IntelliJ #448, GitNexus #767 | Virtuoso's `followOutput` + `atBottomStateChange` is a direct fit |
| `react-virtuoso` Benchmark 95.6 with 1191 snippets, ships an AI-chatbot example | Context7 `/petyosi/react-virtuoso` | Library of choice |
| `use-stick-to-bottom` reinvents what Virtuoso already does | Context7 `/stackblitz-labs/use-stick-to-bottom` | Skipped to avoid two-hook coordination |

## 4. Library Choice

Two new runtime dependencies (≈ 18 KB gzip total):

| Package | Version Pin Policy | Role |
|---|---|---|
| `react-virtuoso` | `^4` (latest stable) | virtualization + stick-to-bottom |
| `overlayscrollbars-react` + `overlayscrollbars` | `^2` (latest stable) | macOS-style ghost scrollbar |

Both have React 19 support confirmed via Context7. No native modules — pure JS, vite-friendly.

## 5. Scroll State Machine

```
                ┌──────────────────────────────────────────────┐
                │  mount / thread switch / message-edit replay  │
                └────────────────────────┬─────────────────────┘
                                         │
                                         ▼
                       initialTopMostItemIndex = messages.length - 1
                                         │
                                         ▼
                ┌────────────── follow = true ─────────────────┐
                │                                              │
                │   AI streams → followOutput="smooth"          │
                │   (viewport tails tokens — user requirement) │
                │                                              │
                └─────────┬──────────────────────┬─────────────┘
                          │                      │
                  user scrolls up         user back at bottom
                          │                      │
                          ▼                      ▼
                  follow = false  ←──────  follow = true
                  + show floating "↓" button
                          │
                  click button → scrollToIndex('LAST') → follow = true
```

**Invariants:**
- `atBottomThreshold = 48 px` — within 48 px of bottom counts as "at bottom" (matches Virtuoso default + GitNexus #767 threshold).
- `followOutput="smooth"` is the **only** Virtuoso prop that drives the stick behavior. We do **not** layer our own `scrollIntoView`-on-every-update — that's the failure mode in VS Code #274099.
- Floating button visibility = `!atBottom`. Optional new-message counter is **out of scope** for v1; the button just says "↓" (a pure return-to-bottom arrow per user feedback in approach question).

## 6. Component Architecture

### File map

| File | Action | Reason |
|---|---|---|
| `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | Modify L251-298 | Replace `<div className="flex-1 overflow-y-auto">` with `<MessageList />` |
| `src/renderer/src/features/agent-chat/MessageList.tsx` | **New** | Encapsulate Virtuoso + OverlayScrollbars + floating button. Single-purpose component. |
| `src/renderer/src/features/agent-chat/MessageList.css` | **New** | Tailwind doesn't reach into OverlayScrollbars' shadow-DOM-like theme variables — keep these in a small dedicated CSS file. |
| `src/renderer/src/features/agent-chat/__tests__/MessageList.test.tsx` | **New** | RED→GREEN regression tests around state-machine and prop wiring. |
| `package.json` | Add deps | `react-virtuoso`, `overlayscrollbars`, `overlayscrollbars-react` |

### `MessageList.tsx` shape

```tsx
type Props = {
  messages: Message[]
  editingMessageId: string | undefined
  pendingApprovals: CodexApprovalRequest[]
  error: string | undefined
  threadId: string | undefined  // used as `key` to remount on thread switch
  onRespondApproval: (response: ApprovalResponse) => void
}

export function MessageList(props: Props) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  return (
    <div className="relative flex-1 min-h-0" key={props.threadId}>
      <Virtuoso
        ref={virtuosoRef}
        data={props.messages}
        computeItemKey={(_, m) => m.id}
        initialTopMostItemIndex={Math.max(0, props.messages.length - 1)}
        followOutput="smooth"
        atBottomThreshold={48}
        atBottomStateChange={setAtBottom}
        components={{
          Scroller: OverlayScrollbarsScroller,
          Header: () => <ChatListHeader
            pendingApprovals={props.pendingApprovals}
            onRespond={props.onRespondApproval}
          />,
          Footer: () => props.error
            ? <div className="mt-3 rounded-xl border border-red-400/30 ...">{props.error}</div>
            : null,
          EmptyPlaceholder: () => <ChatEmptyPlaceholder />,
        }}
        itemContent={(_, message) =>
          message.id === props.editingMessageId
            ? <InlineEditCard message={message} />
            : <MessageBubble message={message} />
        }
      />
      {!atBottom && (
        <button
          type="button"
          onClick={() => virtuosoRef.current?.scrollToIndex({
            index: 'LAST',
            align: 'end',
            behavior: 'smooth',
          })}
          className="absolute bottom-4 right-4 ..."
          aria-label="Scroll to latest message"
        >↓</button>
      )}
    </div>
  )
}
```

### `OverlayScrollbarsScroller` shape

Defined inside `MessageList.tsx` as a small forward-ref'd wrapper:

```tsx
const OverlayScrollbarsScroller = forwardRef<HTMLElement, ScrollerProps>(
  function OverlayScrollbarsScroller({ children, style, ...rest }, ref) {
    return (
      <OverlayScrollbarsComponent
        element="div"
        style={style}
        options={{
          scrollbars: {
            theme: 'os-theme-dark',
            autoHide: 'leave',
            autoHideDelay: 800,
            clickScroll: true,
          },
        }}
        ref={ref}
        defer
        {...rest}
      >{children}</OverlayScrollbarsComponent>
    )
  }
)
```

> **CSS note:** OverlayScrollbars ships a built-in 200 ms width transition on hover via its CSS variables — no manual `transition` required.

## 7. AgentChatPanel.tsx Touch-Points

Diff scope (target):

```tsx
// L251-298, BEFORE:
<div className="flex-1 overflow-y-auto px-4 py-4">
  <NoticesBanner />
  {pendingApprovals.length > 0 ? <>...</> : null}
  {messages.length === 0 ? <>...placeholder...</> : null}
  {messages.map((m) => (
    m.id === editingMessageId ? <InlineEdit ... /> : <MessageBubble ... />
  ))}
  {error ? <>...</> : null}
</div>

// AFTER:
<MessageList
  threadId={currentThreadId}
  messages={messages}
  editingMessageId={editingMessageId}
  pendingApprovals={pendingApprovals}
  error={error}
  onRespondApproval={respondToApproval}
/>
```

`NoticesBanner` moves into `ChatListHeader` (inside the new `MessageList`). It scrolls with the list — matches existing behavior (the banner already scrolls today because it's inside the `overflow-y-auto` div).

## 8. Edge Cases

| Case | Handling |
|---|---|
| Thread switch (`threadId` changes) | `key={threadId}` on the outer wrapper forces Virtuoso remount → `initialTopMostItemIndex` re-evaluates → lands at bottom of new thread |
| Empty thread (0 messages) | `EmptyPlaceholder` slot renders the existing "Tell the agent what to create…" copy |
| Inline edit mode | `itemContent` branches on `editingMessageId` — Virtuoso's `ResizeObserver` re-measures the item when the bubble swaps to the edit card |
| Stream updates last bubble only | `computeItemKey={m.id}` keeps key stable; Virtuoso re-measures via ResizeObserver and re-applies `followOutput` if still at bottom |
| User mid-scroll, new chunk arrives | `followOutput` is internally gated on `atBottom` — does not pull user back. ✓ matches non-goal #3 |
| Approval request mid-conversation | Renders in `Header` slot. Scrolls with the list. Does not impact virtualization (Header is outside the virtualized range) |
| Error banner | Rendered via `Footer` slot. Stays visually below messages. |

## 9. Test Strategy

Virtuoso requires `ResizeObserver` + element layout APIs that happy-dom lacks. We avoid testing **the virtualization output** (that's Virtuoso's own test suite). We test our **state machine and prop wiring**:

```tsx
// Mock Virtuoso to a thin pass-through component that:
//  1. captures props,
//  2. exposes a fake `ref.current` with .scrollToIndex spy,
//  3. lets the test trigger atBottomStateChange callback.
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(({ atBottomStateChange, ...props }, ref) => {
    useImperativeHandle(ref, () => ({
      scrollToIndex: scrollToIndexSpy,
    }))
    return <div data-testid="virtuoso" data-props={JSON.stringify(props.followOutput)}>
      {/* expose callback for tests */}
      <button data-testid="trigger-leave-bottom" onClick={() => atBottomStateChange?.(false)} />
      <button data-testid="trigger-enter-bottom" onClick={() => atBottomStateChange?.(true)} />
    </div>
  }),
}))
```

Tests (TDD order):

1. **renders with initialTopMostItemIndex = messages.length - 1** — verifies "open default = bottom"
2. **floating button is hidden when atBottom = true** — initial state
3. **floating button appears after atBottomStateChange(false)** — verifies scroll-up unlocks UI
4. **clicking floating button calls virtuosoRef.scrollToIndex with index='LAST' behavior='smooth'** — verifies return-to-bottom
5. **floating button disappears after atBottomStateChange(true)** — verifies re-lock
6. **threadId change re-mounts (key prop wiring)** — switching threads resets to bottom
7. **inline edit message renders the edit card via itemContent branch** — preserves existing edit UX

We do **not** test:
- Virtuoso internal scrolling math (their problem)
- OverlayScrollbars rendering (their problem)
- Streaming-token follow behavior (that's `followOutput="smooth"` prop value — covered by test #1)

## 10. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Virtuoso 4.x breaks on React 19 strict mode double-mount | Low | React 19 support is documented; we mount with stable `key={threadId}`. CI catches regressions. |
| OverlayScrollbars `Scroller` slot in Virtuoso passes wrong ref shape | Medium | `forwardRef` + `defer` flag — pattern documented in OverlayScrollbars docs for virtualization wrappers. Test it in step 5 of TDD. |
| 18 KB gzip dep growth | Low | Both libs are tree-shake-friendly. We can audit `pnpm exec vite-bundle-visualizer` if it lands hot. |
| Streaming token updates fight virtualization size cache | Medium | `computeItemKey={m.id}` + ResizeObserver covers it. Already validated in Virtuoso's own AI-chatbot example. |
| Happy-dom test env can't render Virtuoso | High → mitigated | Mock Virtuoso (see §9). Skipping virtualization testing is intentional. |

## 11. Open Questions

None. All design decisions locked.

## 12. Acceptance Criteria

A reviewer can confirm shipping by manually exercising the dev build:

- [ ] Open Codex panel → see most recent assistant message immediately, no scroll-up required.
- [ ] Send a 5-line prompt → assistant streams → viewport stays glued to bottom.
- [ ] Mid-stream, scroll up → response keeps streaming, viewport stops moving.
- [ ] Floating "↓" button appears in bottom-right.
- [ ] Click "↓" → smooth-scrolls to latest token, button disappears.
- [ ] Scroll bar fades out within ~1 s of stopping; hover the list → bar slides in slightly wider.
- [ ] Open a thread with 200+ messages → no perceptible mount delay; React DevTools shows < 30 `MessageBubble` instances mounted at any time.
- [ ] All existing tests still green.
- [ ] No new TypeScript errors on touched files.
