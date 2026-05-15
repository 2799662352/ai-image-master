# Codex Agent Chat Panel — Cursor-Style Redesign

**Date:** 2026-05-07
**Author:** Brainstormed with user
**Branch:** `feature/codex-agent-mvp`
**Status:** Design — pending implementation plan

---

## 1. Background & Goals

The current Codex Agent chat panel (`src/renderer/src/features/agent-chat/`) is functional — messages stream in, attachments upload, a Codex 0.128 backend handles WebSocket protocol — but its layout pulls the four data streams (messages, reasoning, tool calls, artifacts) into four parallel rectangles. That UX scales poorly when the agent does multi-step work, edits files, or returns multiple images.

Goal: redesign the panel so that **every observable agent activity — text, thinking, shell command, file edit, attachment, artifact — appears inline in the message stream as a Cursor-style timeline**. Per-thread persistence, multi-thread switching, auto-naming, image preview, and a resizable panel are part of the same overhaul because they all hang off the same data model.

Out of scope (explicitly):

- Permission/approval model — already rejected by user; agent runs `--sandbox-mode danger-full-access`.
- Parallel multi-agent and embedded browser features — deferred.
- `apply_patch` Revert button — UI is reserved but disabled until the V2 git-stash workflow ships.

---

## 2. UX Decisions (locked)

| ID | Topic | Decision |
|----|-------|----------|
| Q1 | Thread switcher | **Command Palette** triggered by `Ctrl/Cmd+P` |
| Q2 | Panel sizing | Resizable left edge, **360–720px**, width persisted in `localStorage` |
| Q3 | Reasoning / shell / file change in timeline | **Cursor-style**: running = expanded, completed = auto-collapsed pill |
| Q4 | Image double-click | Built-in **Lightbox** (←/→ navigate, Esc/✕ close, ↓ download). Non-image files → `shell.openPath` |
| Q5 | Thread auto-naming | **Hybrid**: immediate truncation → LLM 4–6 word summary after first turn → manual rename locks (`manualTitle=true`) |
| Q6 | `apply_patch` UI | **Cursor-style inline diff card**: collapsed pill (`📝 src/foo.ts +12 −3`) → expand to unified diff |

---

## 3. Architecture

### 3.1 Component Tree

```
AgentChatPanel                            ← shell, IPC subscription, layout
├─ ResizableHandle                        L0 · drag left edge
├─ ChatHeader                             title, Ctrl+P entry, close
│   └─ ThreadCommandPalette (modal)       L5 · global Ctrl/Cmd+P
├─ MessageList
│   └─ MessageBubble                      L1 · rewrite
│       ├─ MessageHeader (role + time)
│       └─ TimelineItemRenderer[]         per-message timeline
│           ├─ TextItem                   L1
│           ├─ ReasoningCard              L3
│           ├─ ShellCard                  L3
│           ├─ FileEditCard               L3 · apply_patch diff
│           ├─ AttachmentItem             L3 · user uploads
│           └─ ArtifactItem               L3 · agent outputs
├─ Lightbox (portal)                      L4 · global preview
└─ ChatFooter
    ├─ AttachmentChips                    existing
    └─ MentionInput (with ModelPicker)    existing
```

### 3.2 Responsibility boundaries

| Unit | Owns | Depends on |
|------|------|------------|
| `AgentChatPanel` | Container; subscribes to `electronAPI.agent.onEvent`; mounts portals | store, IPC |
| `MessageBubble` | Given a `Message`, renders header and ordered items | TimelineItemRenderer |
| `TimelineItemRenderer` | Pure dispatcher — `switch` on `item.type`, no local state | each Card component |
| Each Card (Reasoning / Shell / FileEdit / Attachment / Artifact) | Single-type rendering + local collapse/expand state; doesn't read store | props only |
| `Lightbox` | Global singleton portal; reads `store.preview` | store.preview |
| `ThreadCommandPalette` | Self-managed open/search state; lists threads via IPC | store, IPC |
| `store` | New slices: `panelWidth`, `preview`, `threads`. Message shape changes to `items[]` | — |

Each Card satisfies "props in / DOM out / no store reads" — easy to test, swap, and reason about.

### 3.3 Implementation route — Layered Increments

| Layer | Scope | Key files |
|-------|-------|-----------|
| **L0 · Foundation** | Resizable handle + `panelWidth` persistence | `ResizableHandle.tsx`, `store.ts` |
| **L1 · Message Bubble v2** | Rewrite bubble; introduce `items: TimelineItem[]`; refactor store accordingly | `MessageBubble.tsx`, `TimelineItemRenderer.tsx`, `store.ts` |
| **L2 · Notification Router** | Extend `codexNotificationRouter.ts` to emit `item_started / item_delta / item_completed` events for shell + fileChange | `codexNotificationRouter.ts` |
| **L3 · Cards** | Build Reasoning → Shell → FileEdit → AttachmentGrid one at a time | 6 new components |
| **L4 · Preview** | Lightbox + thread image collection + `shell.openPath` | `Lightbox.tsx`, preload IPC |
| **L5 · Multi-thread** | Command Palette + auto-naming worker | `ThreadCommandPalette.tsx`, main `ThreadTitleSummarizer.ts` |

Each layer ships as an independent commit/PR. L1 is the architectural keystone — every other layer plugs into the `TimelineItem` abstraction.

---

## 4. Data Model — The Timeline Spine

### 4.1 Types (`src/types/agent-timeline.ts`)

```typescript
interface BaseItem {
  id: string             // codex itemId when available, else generated uuid
  startedAt: number      // ms epoch
  endedAt?: number       // set on completion; drives running → collapsed transition (Q3)
}

type TimelineItem =
  | TextItem
  | ReasoningItem
  | ShellItem
  | FileEditItem
  | AttachmentItem
  | ArtifactItem

interface TextItem      extends BaseItem { type: 'text';      content: string }
interface ReasoningItem extends BaseItem { type: 'reasoning'; content: string }

interface ShellItem extends BaseItem {
  type: 'shell'
  command: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode?: number
}

interface FileEditItem extends BaseItem {
  type: 'fileEdit'
  changes: FileChange[]
  totalAdded: number
  totalRemoved: number
}

interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string           // unified diff text
  added: number
  removed: number
}

interface AttachmentItem extends BaseItem {
  type: 'attachment'
  attachments: AttachmentRef[]
}

interface ArtifactItem extends BaseItem {
  type: 'artifact'
  artifacts: AttachmentRef[]
}

interface AttachmentRef {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  uri: string            // file://, data:, http(s)://, or app://attachments/<sha>.<ext>
  thumbnailUri?: string
}
```

`AttachmentItem` and `ArtifactItem` stay separate (not unified) because the renderer styles them differently (user-side vs agent-side bubble) even though their shape is identical.

### 4.2 Message shape

```typescript
interface Message {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  items: TimelineItem[]
}
```

The legacy `content: string` field is **removed**. Anywhere that needs plain text (clipboard copy, search, auto-naming) calls a derived helper:

```typescript
function getMessageText(msg: Message): string {
  return msg.items.filter(i => i.type === 'text').map(i => i.content).join('\n')
}
```

### 4.3 Streaming updates

Every Codex delta carries an `itemId`. The store's `applyEvent` uses an upsert helper:

```typescript
function upsertItemInLastMessage<T extends TimelineItem>(
  messages: Message[],
  itemId: string,
  factory: () => T,
  patch: (item: T) => T,
): Message[]
```

1. Find the last assistant message (create one if none).
2. Search its `items[]` for `id === itemId`.
3. Found → run `patch`. Not found → push `factory()`.

Each message holds at most ~20 items, so O(n) scans are fine — no need for a side-Map.

### 4.4 Persistence

The existing `AgentMessage.contentJson` JSONB column is **renamed** to `items` (it has no production writers yet — confirmed via codebase search — so renaming is safe and avoids a redundant column). The new shape stored in this column is `TimelineItem[]`.

Prisma migration:

```prisma
model AgentMessage {
  id        String          @id @default(cuid())
  threadId  String
  role      String
  items     Json            @default("[]")     // renamed from contentJson; shape: TimelineItem[]
  createdAt DateTime        @default(now())
  thread    AgentThread     @relation(fields: [threadId], references: [id], onDelete: Cascade)
  toolCalls AgentToolCall[]

  @@index([threadId, createdAt])
}
```

Generated SQL: `ALTER TABLE "AgentMessage" RENAME COLUMN "contentJson" TO "items";` plus a default-clause adjustment.

**Write path:** on `turn/completed`, the AgentManager serializes the in-memory message's `items` array and stores it in the column. Mid-stream state isn't persisted — if Electron crashes mid-turn, the unfinished message is lost (acceptable: no thread is "saved" until the turn completes anyway).

**Read path:** `loadThread` deserializes `items` directly. Existing rows in the column (if any) currently have arbitrary shape; the deserializer treats anything that isn't an array as `[]` and the row renders as empty (no production data is at risk because no writer exists yet).

**Why JSONB, not a separate `AgentMessageItem` table:**

- N+1 queries for rendering would be silly.
- TimelineItem shape will iterate; per-item migrations are costly.
- ≤ 20 items × small fields ≈ tiny JSONB.
- No need to query/index on individual items.

---

## 5. Codex Notification → TimelineItem Mapping (L2)

`CodexNotificationRouter` (extends the existing class in `src/main/agent/codexNotificationRouter.ts`) translates raw Codex `app-server` notifications into `AgentStreamEvent`s. Store routes each event onto the right TimelineItem.

### 5.1 Mapping table

| Codex notification | Trigger | Item affected | Operation |
|---|---|---|---|
| `item/started` (type=`agentMessage`) | model starts text output | `text` | upsert empty TextItem; `startedAt=now` |
| `item/agentMessage/delta` | text chunk | `text` | append `delta` to `content` (matched by `itemId`) |
| `item/started` (type=`reasoning`) | thinking starts | `reasoning` | upsert empty ReasoningItem |
| `item/reasoning/textDelta` / `summaryTextDelta` | thinking chunk | `reasoning` | append delta |
| `item/started` (type=`commandExecution`) | shell starts | `shell` | upsert; record `command` + `cwd` |
| `item/commandExecution/output` (stdout/stderr) | shell output chunk | `shell` | append to `stdout` or `stderr` |
| `item/completed` (type=`commandExecution`) | shell ends | `shell` | set `exitCode`, `endedAt` |
| `item/started` (type=`fileChange`) | apply_patch starts | `fileEdit` | upsert empty FileEditItem |
| `item/completed` (type=`fileChange`) | apply_patch ends | `fileEdit` | parse `changes[]`; set `endedAt` |
| `item/completed` (type=`agentMessage`) | text ends (fallback) | `text` | **existing logic**: drop if streamed; else inject full text |
| `turn/completed` | turn ends | — | `isRunning=false`; trigger auto-naming (L5) |
| `error` | failure | — | `isRunning=false`; `setError` |

> Exact field names for `commandExecution.output` and `fileChange.changes` are pinned to `docs/codex-app-server.schema.json`. The router maps them; UI components never see raw Codex shapes.

### 5.2 Attachment / artifact items

Codex doesn't know about local user files; these items are renderer-injected:

- **AttachmentItem**: when the user clicks Send, the store wraps `attachments[]` into an AttachmentItem at `items[0]` of the new user message. The same attachments are also serialized into Codex `input_image` / `input_file` for the backend.
- **ArtifactItem**: existing `artifact_created` events (from main process tool execution) are wrapped into ArtifactItems and appended to the current assistant message.

### 5.3 New `AgentStreamEvent` shape

```typescript
type AgentStreamEvent =
  | { type: 'thread_created';  threadId: string }
  | { type: 'item_started';    threadId: string; itemId: string; itemType: TimelineItem['type']; payload: Partial<TimelineItem> }
  | { type: 'item_delta';      threadId: string; itemId: string; itemType: TimelineItem['type']; patch: ItemDeltaPatch }
  | { type: 'item_completed';  threadId: string; itemId: string; itemType: TimelineItem['type']; final: Partial<TimelineItem> }
  | { type: 'turn_completed';  threadId: string }
  | { type: 'error';           threadId: string; error: string }

type ItemDeltaPatch =
  | { kind: 'appendText';   field: 'content' | 'stdout' | 'stderr'; text: string }
  | { kind: 'mergeFields';  fields: Record<string, unknown> }
```

Legacy `message_delta` / `reasoning_delta` events are deleted in L2. To avoid breaking the existing `codexProtocol.test.ts` assertions during the L1→L2 transition, the router and store ship together in a single L2 commit: existing tests are updated in the same commit to assert the new event shape. There is no period during which both legacy and new events coexist.

### 5.4 Errors

`error` events are thread-level and surface as a red banner in `store.error` — they do **not** become timeline items. A non-zero `exitCode` on a ShellItem is internal state (red border + visible stderr), not a thread error.

---

## 6. L0 — Resizable Panel

**Behavior:**

- Default width: **420px** (matches current).
- Drag left edge → width clamps to **[360, 720]** px.
- On `pointerup`, persist to `localStorage["catimation.agent.panelWidth"]`.
- On startup, read and clamp.

**`ResizableHandle.tsx`:** 4px-wide left-edge gripper; `cursor: ew-resize`; hover blue. `pointerdown` → `pointermove` (rAF-throttled store updates) → `pointerup` (persist + drop body `user-select: none`).

**Edge cases:** values outside `[360, 720]` (e.g. corrupted localStorage, screen resize) clamp via `Math.min(MAX, Math.max(MIN, raw))` on every read.

---

## 7. L5 — Multi-Thread + Command Palette + Auto-Naming

### 7.1 Schema additions

```sql
ALTER TABLE "AgentThread" ADD COLUMN "manualTitle" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentThread" ADD COLUMN "lastMessageAt" TIMESTAMP;
CREATE INDEX agent_thread_last_message_idx ON "AgentThread"("lastMessageAt" DESC);
```

- `manualTitle=true` → auto-naming never overwrites.
- `lastMessageAt` → command palette ordering ("most recently active", not creation time).

### 7.2 Auto-naming flow (Q5 D)

```
[1] User sends first message
       ↓
   AgentManager.createThread(title = content.slice(0,40), manualTitle=false)
       ↓ visible immediately
[2] turn/completed (first turn ends)
       ↓
   if (!thread.manualTitle && title still equals truncated form)
     → ThreadTitleSummarizer.summarize(thread)
        - Pull first user + assistant messages
        - One-shot Codex prompt: "Summarize this conversation in 4–6 Chinese words. No punctuation."
        - UPDATE thread SET title = summary WHERE id=? AND manualTitle=false
       ↓ ~1–2s later, title updates silently
[3] User right-clicks → Rename
       ↓
   UPDATE thread SET title=?, manualTitle=true
   → step [2] never fires again
```

`ThreadTitleSummarizer` (main process) reuses `CodexLocalBackend` for a one-shot turn that does **not** persist to DB or appear in the UI. Failures retry up to 3 times across subsequent `turn/completed` events; after that, the truncated title sticks.

### 7.3 Command Palette

`ThreadCommandPalette.tsx` — a modal triggered by `Ctrl+P` (Win/Linux) or `Cmd+P` (macOS), detected via `navigator.platform`.

```
┌─────────────────────────────────────┐
│  🔍 search threads...             │
├─────────────────────────────────────┤
│  ➕ New chat                  Enter │
│  ─────────────────────────────────  │
│  4图融合·霓虹反射          2 分钟前 │ ← active
│  调色脚本生成              昨天 14:22│
│  Sora prompt 优化         3 天前    │
└─────────────────────────────────────┘
```

- Real-time fuzzy match on `title` — hand-rolled `includes` + ranking (~30 lines, no fuse.js dependency).
- First row is always "New chat" (Enter creates + closes).
- Up/down arrows navigate; Enter switches; Esc closes.
- List comes from `agent:list-threads` IPC, capped at 50, ordered by `lastMessageAt DESC`.

Switching thread semantics: in-memory state (messages / artifacts / reasoning / toolEvents) swaps to the new thread's. New thread messages load from DB on first switch and cache in memory until panel close.

### 7.4 New IPC

```typescript
agent.listThreads(): Promise<AgentThreadSummary[]>      // 50 most recent
agent.openThread(id: string): Promise<{
  thread: AgentThreadSummary
  messages: Message[]
}>
agent.renameThread(id: string, title: string): Promise<void>   // sets manualTitle=true
agent.deleteThread(id: string): Promise<void>
```

New thread creation reuses the existing `agent.sendMessage` (no `threadId` triggers create).

### 7.5 Switching while running

V1 simple rule: when the current thread has `isRunning=true`, every non-current row in the Command Palette is rendered non-clickable with the tooltip "wait for the current turn to finish". The "New chat" row is also disabled. Switching only re-enables when `isRunning` flips back to `false` via `turn/completed`, `cancelled`, or `error`. Background-running threads (allowing switching while a turn streams in the background) are V2.

---

## 8. L4 — Lightbox + Preview

### 8.1 Trigger map

| Element | Double-click |
|---|---|
| Image thumbnail (`AttachmentItem.kind=image` / `ArtifactItem.kind=image`) | Open Lightbox |
| Non-image file (pdf / json / md / any) | `shell.openPath(uri)` — system default app |
| Image single-click | No-op (avoid accidental triggers) |

### 8.2 Lightbox behavior

- Full-screen overlay (`position: fixed; inset: 0; z-index: 50000`); backdrop `rgba(0,0,0,0.92)`.
- Centered image, scaled to fit `90vw / 80vh`.
- **Image source:** all image-typed items in the current thread, in chronological order, regardless of attachment vs artifact origin.
- Keyboard: `←` / `→` navigate, `Esc` / `✕` close, `↓` download, `Ctrl+C` copy to clipboard.
- Mouse: click backdrop to close; click image center to advance.
- Top bar: `2 / 7 · v2.png · 1.4MB`.

### 8.3 Store + IPC additions

```typescript
interface PreviewState {
  open: boolean
  images: AttachmentRef[]   // all thread images, chronological
  index: number
}
openPreview(itemId: string, attachmentId: string): void
closePreview(): void
nextPreview(): void
prevPreview(): void
```

`Lightbox` subscribes to `state.preview`, pure presentation. The image list is built once on `openPreview`; navigation only mutates `index` (memoized).

**New preload-exposed IPC:**

```typescript
electronAPI.shell.openPath(uri: string): Promise<void>
electronAPI.shell.copyImage(uri: string): Promise<void>     // file → nativeImage → clipboard
electronAPI.shell.saveAs(uri: string, suggestedName: string): Promise<void>
```

Main backs them with `shell.openPath`, `clipboard.writeImage`, `dialog.showSaveDialog`.

### 8.4 `app://` protocol

`AttachmentRef.uri` formats:

- User uploads → main stores file at `userData/agent-attachments/<sha1>.<ext>`, returns `app://attachments/<sha1>.<ext>`.
- Codex outputs → same path scheme.
- Remote URLs → `https://...` directly.

A custom `app://` protocol handler is registered on `app.whenReady()` mapping `app://attachments/<file>` → `userData/agent-attachments/<file>` on disk. Path traversal is blocked (reject any path containing `..` or absolute roots).

Benefits: `<img src=>` works directly; no IPC needed for Lightbox; deletion-by-thread can clean disk in one place.

---

## 9. L3 — `apply_patch` Diff Card

### 9.1 Codex protocol

```
item/started   { item: { type: 'fileChange', id, status: 'pending' } }
item/completed { item: { type: 'fileChange', id, status: 'completed',
                          changes: [
                            { path, kind: 'create' | 'modify' | 'delete',
                              unifiedDiff: '@@ -10,3 +10,5 @@\n-foo\n+bar\n...' },
                            ...
                          ] } }
```

Field names pinned to the schema; router converts to internal `FileChange` shape.

### 9.2 Parsing

```typescript
function parseChange(c: any): FileChange {
  const { added, removed } = countDiffLines(c.unifiedDiff)
  return {
    path: c.path,
    operation: c.kind === 'create' ? 'create'
              : c.kind === 'delete' ? 'delete'
              : 'edit',
    diff: c.unifiedDiff,
    added, removed,
  }
}
```

`countDiffLines` is ~10 lines: scan by line, ignore `+++` / `---`, skip `@@`, count leading `+` / `-`. No external diff library — keeps Electron bundle slim.

### 9.3 UI states (Q3 / Q6)

| State | Pill |
|---|---|
| Pending | `📝 applying patch...` (gray + spinner) |
| Completed (single file) | `📝 src/foo.ts +12 −3` (collapsed) |
| Completed (multi-file) | `📝 3 files changed +47 −12` |
| Failed | `✕ apply_patch failed` (red border) |

Click → expand → unified diff with line coloring:

- `+` line: bg `#0e1b14`, text `#5fdb89`
- `-` line: bg `#1c0e0e`, text `#f47b6f`
- `@@` line: gray monospace header
- context line: default

Diffs longer than 200 lines are truncated with a "Show all" button.

### 9.4 Component layout

```typescript
<FileEditCard item={fileEditItem}>
  <PillSummary onClick={() => setExpanded(true)} />     // collapsed
  {expanded && <FileList>
    {item.changes.map(change => (
      <FileDiffBlock change={change} key={change.path} />
    ))}
  </FileList>}
</FileEditCard>
```

`FileDiffBlock` owns its own `expanded` state (default collapsed). The card-level vs file-level expansion are independent dimensions, mirroring Cursor.

### 9.5 Multi-file vs single-file

Each `apply_patch` call → one `FileEditItem` whose `changes[]` may have N entries. Multiple `apply_patch` calls in the same turn → multiple sequential `FileEditItem`s. Don't merge — chronological order is more readable than aggregation.

### 9.6 Revert (V2 — UI not in this spec)

The card layout has no Revert button in V1. Implementing Revert correctly requires:

1. Stashing the working tree before each `apply_patch`.
2. Recording a commit-hash anchor for `git apply -R`.

That's a separate workstream. We don't show a disabled "coming soon" button — it would set false expectations.

### 9.7 Edge cases

- **Large patch** (>50KB single diff): store keeps `{ truncated: true, head: <first 5000 chars> }`; pill shows "patch too large".
- **Binary file**: pill shows "binary diff", body not rendered.
- **Unicode / spaces in path**: rendered as-is in monospace; no escaping.

---

## 10. Testing Strategy

```
       ╱╲          E2E (Electron + Playwright)
      ╱──╲           - 1 smoke: send → reply → screenshot
     ╱────╲          - 1 happy path: upload → preview → close
    ╱──────╲       Integration (main + protocol)
   ╱        ╲       - codexNotificationRouter × 6 item-type fixtures
  ╱          ╲      - AgentManager.sendMessage end-to-end (mock WS)
 ╱            ╲    Unit (pure functions / components)
╱──────────────╲    - each Card (collapse/expand/click)
                    - each store reducer branch
                    - parsers (countDiffLines / parseChange / getMessageText)
```

### 10.1 Unit (the load-bearing layer)

| Module | What | File |
|---|---|---|
| `codexNotificationRouter` | Each item-type's started/delta/completed path; streaming dedup | `__tests__/codexProtocol.test.ts` (extend) |
| `store.applyEvent` | Each `AgentStreamEvent` upsert; concurrent itemIds don't cross-contaminate | new `store.test.ts` |
| `countDiffLines` | 5 fixtures: create / delete / modify / binary / `+++`-prefixed | `__tests__/diff.test.ts` |
| `getMessageText` | Multi-item concat skipping non-text | `store.test.ts` |
| `ResizableHandle` | pointerdown→move→up clamps to [360,720] | component test |
| Each Card | Collapse/expand toggle; empty state; error state | 6 component tests |

Tools: **Vitest + jsdom + @testing-library/react** (already configured).

### 10.2 Integration

| Scenario | Asserts |
|---|---|
| `AgentManager.sendMessage` + mock Codex WS | `thread/created` → item events → `turn/completed` produces correct store state; CUID↔UUID mapping is consistent |
| `ThreadTitleSummarizer` | `manualTitle=true` blocks updates; failure retries up to 3 times |
| `app://attachments/*` protocol | Reads succeed inside attachments dir; path-traversal attempts (`..`) rejected |

### 10.3 E2E (slow, two scenarios only)

1. **Smoke:** launch → type → send → see assistant bubble → screenshot baseline.
2. **Image roundtrip:** upload PNG → send → assistant returns image artifact → double-click → Lightbox visible → Esc closes.

CI-only via `npm run test:e2e`; not in local watch loop.

### 10.4 Explicitly not tested

- Lightbox keyboard animations / zoom transitions — covered visually by E2E baseline screenshots.
- Command Palette global hotkey — too flaky outside a real window.
- `shell.openPath` — delegates to OS, not our code.

### 10.5 Regression hot spots (extra assertions)

1. **Streaming dedup**: `item/agentMessage/delta` × 5 followed by `item/completed` must not append a sixth chunk.
2. **CUID↔UUID mapping**: every `threadId` reaching the renderer is a DB CUID, never the Codex UUID.
3. **JSONB items deserialization**: legacy rows (only `content`, no `items`) read back as a single TextItem.

---

## 11. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Codex schema fields drift (`commandExecution.output` shape, `fileChange.changes` exact name) | Router maps from raw shape to internal types in one place; field-name mismatches caught by router unit tests with real fixtures |
| Large message bubble layout (multi-file edit + long shell output) | 200-line truncation in diff card, `max-height: 400px` + scroll on shell stdout, "Show all" expansions |
| `app://` protocol + Electron CSP collisions | Register protocol with `bypassCSP=true` only for `app://attachments/`; never for arbitrary user content |
| Auto-naming token cost | One extra one-shot turn per thread (~100 tokens). Acceptable. Skip for `manualTitle=true` |
| Thread switch during a running turn | V1: disable switching with tooltip. V2: background continuation |

---

## 12. Migration & Rollout

This is a worktree-isolated branch (`feature/codex-agent-mvp`). Each layer (L0–L5) lands as one commit. The DB migration (JSONB column, AgentThread columns) is one Prisma migration shipped with L1. Existing AgentMessage rows auto-wrap into single TextItems on read; no destructive schema changes.

No feature flag — the worktree branch is the rollout boundary. When merged to `main`, the new UI replaces the old one wholesale; the old `ReasoningPanel` / `ToolCallCard` / standalone `ArtifactGrid` are deleted (their content moves inside `MessageBubble` via TimelineItems).

---

## 13. Definition of Done

- [ ] Six TimelineItem types render correctly with fixtures
- [ ] Resizable panel persists across restarts
- [ ] `Ctrl/Cmd+P` opens Command Palette and switches threads
- [ ] First user message creates thread with truncated title; first `turn/completed` updates it via summarizer
- [ ] Manual rename sets `manualTitle=true` and is durable
- [ ] Double-clicking an image opens Lightbox; navigation + close work
- [ ] Double-clicking a non-image file opens system default
- [ ] `apply_patch` produces a collapsible diff card with correct +/− counts
- [ ] `npm run test` passes including new tests
- [ ] `npm run test:e2e` smoke + image-roundtrip pass
- [ ] No `console.error` in renderer during a complete demo flow
