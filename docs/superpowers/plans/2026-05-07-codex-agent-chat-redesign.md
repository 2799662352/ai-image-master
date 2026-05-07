# Codex Agent Chat Panel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-panel agent chat UI with a Cursor-style inline timeline where every agent activity appears chronologically inside message bubbles — plus resizable panel, multi-thread Command Palette, image Lightbox, and diff cards.

**Architecture:** Layered increments (L0–L5) atop a new `TimelineItem` discriminated union. The main-process `CodexNotificationRouter` maps raw Codex notifications to structured `AgentStreamEvent`s; the renderer Zustand store upserts items into the last assistant message. Prisma JSONB column stores `TimelineItem[]` per message.

**Tech Stack:** TypeScript 6, React 19, Zustand 5, Vitest 4, Electron 41, Prisma 7.8 (PGlite), Tailwind CSS 4

**Spec:** `docs/superpowers/specs/2026-05-07-codex-agent-chat-redesign-design.md`

**Worktree:** `.worktrees/codex-agent-mvp` (branch `feature/codex-agent-mvp`)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/types/agent-timeline.ts` | `TimelineItem` union, `Message`, `FileChange`, `AttachmentRef`, `getMessageText`, `upsertItemInLastMessage` |
| `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx` | Pure switch dispatcher: `item.type → Card` |
| `src/renderer/src/features/agent-chat/cards/TextCard.tsx` | Render `TextItem.content` as prose |
| `src/renderer/src/features/agent-chat/cards/ReasoningCard.tsx` | Collapsible reasoning pill/body |
| `src/renderer/src/features/agent-chat/cards/ShellCard.tsx` | Collapsible shell pill + stdout/stderr scroll |
| `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx` | Collapsible diff pill + unified diff body |
| `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx` | Single-file unified diff renderer |
| `src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx` | User-uploaded file chips/thumbnails |
| `src/renderer/src/features/agent-chat/cards/ArtifactCard.tsx` | Agent-produced artifact thumbnails |
| `src/renderer/src/features/agent-chat/ResizableHandle.tsx` | Left-edge drag gripper for panel resize |
| `src/renderer/src/features/agent-chat/Lightbox.tsx` | Full-screen image preview portal |
| `src/renderer/src/features/agent-chat/ThreadCommandPalette.tsx` | `Ctrl/Cmd+P` thread switcher modal |
| `src/shared/diffUtils.ts` | `countDiffLines`, `parseChange` pure functions (shared between main + renderer) |
| `src/main/agent/ThreadTitleSummarizer.ts` | One-shot Codex prompt for auto-naming |
| `src/main/agent/__tests__/codexNotificationRouterV2.test.ts` | Router V2 tests (shell + fileChange + new event shape) |
| `src/shared/__tests__/diffUtils.test.ts` | `countDiffLines` / `parseChange` unit tests |
| `src/renderer/src/features/agent-chat/__tests__/cards.test.tsx` | Card component tests |
| `src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx` | Resize handle test |
| `src/renderer/src/features/agent-chat/__tests__/Lightbox.test.tsx` | Lightbox unit test |
| `src/renderer/src/features/agent-chat/__tests__/ThreadCommandPalette.test.tsx` | Command palette test |

### Modified files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Rename `contentJson → items`; add `manualTitle`, `lastMessageAt` to `AgentThread` |
| `src/types/agent.ts` | Replace `AgentStreamEvent` with new `item_started / item_delta / item_completed` shape |
| `src/main/agent/codexNotificationRouter.ts` | Emit new event shape; handle `commandExecution`, `fileChange` |
| `src/main/agent/AgentManager.ts` | Save `items[]` on `turn_completed`; integrate `ThreadTitleSummarizer`; new IPC handlers |
| `src/main/agent/ThreadStore.ts` | Add `openThread`, `renameThread`, `deleteThread`, `updateLastMessageAt` methods |
| `src/renderer/src/features/agent-chat/store.ts` | New `Message` shape with `items[]`; `panelWidth`; `preview` slice; `upsertItemInLastMessage` |
| `src/renderer/src/features/agent-chat/types.ts` | Remove `AgentChatMessage` (replaced by `Message` from `agent-timeline.ts`) |
| `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | Use `ResizableHandle`, remove standalone `ReasoningPanel`/`ToolCallCard`/`ArtifactGrid` |
| `src/renderer/src/features/agent-chat/MessageBubble.tsx` | Render `items[]` via `TimelineItemRenderer` |
| `src/renderer/src/features/agent-chat/MentionInput.tsx` | No structural change; attachment wrapping moves to store |
| `src/preload/index.ts` | Add `agent.openThread`, `agent.renameThread`, `agent.deleteThread`, `shell.copyImage`, `shell.saveAs` IPC |
| `src/renderer/src/features/agent-chat/__tests__/store.test.ts` | Rewrite for new `items[]`-based message + new event types |
| `src/main/agent/__tests__/codexNotificationRouter.test.ts` | Update to assert new event shape |

### Deleted files (during final cleanup)

| File | Reason |
|------|--------|
| `src/renderer/src/features/agent-chat/ReasoningPanel.tsx` | Content moves to `ReasoningCard` inside timeline |
| `src/renderer/src/features/agent-chat/ToolCallCard.tsx` | Content moves to `ShellCard` inside timeline |
| `src/renderer/src/features/agent-chat/ArtifactGrid.tsx` | Content moves to `ArtifactCard` inside timeline |

---

## Task 1: Timeline Types & Pure Helpers

**Files:**
- Create: `src/types/agent-timeline.ts`
- Create: `src/shared/diffUtils.ts`
- Create: `src/shared/__tests__/diffUtils.test.ts`

- [ ] **Step 1: Write the diff utility tests**

```typescript
// src/shared/__tests__/diffUtils.test.ts
import { describe, expect, it } from 'vitest'
import { countDiffLines, parseChange } from '../diffUtils'

describe('countDiffLines', () => {
  it('counts added and removed lines in a basic diff', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' context',
      '-old line',
      '+new line 1',
      '+new line 2',
      ' context',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 })
  })

  it('ignores --- and +++ header lines', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 1, removed: 1 })
  })

  it('returns zeros for empty input', () => {
    expect(countDiffLines('')).toEqual({ added: 0, removed: 0 })
  })

  it('handles a create-only diff (all additions)', () => {
    const diff = [
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 3, removed: 0 })
  })

  it('handles a delete-only diff (all removals)', () => {
    const diff = [
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    ].join('\n')
    expect(countDiffLines(diff)).toEqual({ added: 0, removed: 2 })
  })
})

describe('parseChange', () => {
  it('maps create kind', () => {
    const result = parseChange({
      path: 'src/foo.ts',
      kind: 'create',
      unifiedDiff: '@@ -0,0 +1,1 @@\n+hello',
    })
    expect(result).toEqual({
      path: 'src/foo.ts',
      operation: 'create',
      diff: '@@ -0,0 +1,1 @@\n+hello',
      added: 1,
      removed: 0,
    })
  })

  it('maps delete kind', () => {
    const result = parseChange({
      path: 'old.txt',
      kind: 'delete',
      unifiedDiff: '@@ -1,1 +0,0 @@\n-gone',
    })
    expect(result.operation).toBe('delete')
    expect(result.removed).toBe(1)
  })

  it('maps modify kind to edit', () => {
    const result = parseChange({
      path: 'x.ts',
      kind: 'modify',
      unifiedDiff: '@@ -1,1 +1,1 @@\n-a\n+b',
    })
    expect(result.operation).toBe('edit')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/__tests__/diffUtils.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create `agent-timeline.ts` types**

```typescript
// src/types/agent-timeline.ts

export interface BaseItem {
  id: string
  startedAt: number
  endedAt?: number
}

export interface TextItem extends BaseItem {
  type: 'text'
  content: string
}

export interface ReasoningItem extends BaseItem {
  type: 'reasoning'
  content: string
}

export interface ShellItem extends BaseItem {
  type: 'shell'
  command: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode?: number
}

export interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string
  added: number
  removed: number
}

export interface FileEditItem extends BaseItem {
  type: 'fileEdit'
  changes: FileChange[]
  totalAdded: number
  totalRemoved: number
}

export interface AttachmentRef {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  uri: string
  thumbnailUri?: string
}

export interface AttachmentItem extends BaseItem {
  type: 'attachment'
  attachments: AttachmentRef[]
}

export interface ArtifactItem extends BaseItem {
  type: 'artifact'
  artifacts: AttachmentRef[]
}

export type TimelineItem =
  | TextItem
  | ReasoningItem
  | ShellItem
  | FileEditItem
  | AttachmentItem
  | ArtifactItem

export interface Message {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  items: TimelineItem[]
}

export function getMessageText(msg: Message): string {
  return msg.items
    .filter((i): i is TextItem => i.type === 'text')
    .map((i) => i.content)
    .join('\n')
}

export function upsertItemInLastMessage<T extends TimelineItem>(
  messages: Message[],
  itemId: string,
  factory: () => T,
  patch: (item: T) => T,
): Message[] {
  if (messages.length === 0) return messages

  const lastIdx = messages.length - 1
  const lastMsg = messages[lastIdx]
  if (lastMsg.role !== 'assistant') return messages

  const itemIdx = lastMsg.items.findIndex((i) => i.id === itemId)
  let newItems: TimelineItem[]

  if (itemIdx >= 0) {
    newItems = [...lastMsg.items]
    newItems[itemIdx] = patch(newItems[itemIdx] as T)
  } else {
    newItems = [...lastMsg.items, factory()]
  }

  const updated = [...messages]
  updated[lastIdx] = { ...lastMsg, items: newItems }
  return updated
}
```

- [ ] **Step 4: Create `diffUtils.ts`**

```typescript
// src/shared/diffUtils.ts
import type { FileChange } from '../types/agent-timeline'

export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export function parseChange(raw: {
  path: string
  kind: string
  unifiedDiff: string
}): FileChange {
  const { added, removed } = countDiffLines(raw.unifiedDiff)
  return {
    path: raw.path,
    operation: raw.kind === 'create' ? 'create' : raw.kind === 'delete' ? 'delete' : 'edit',
    diff: raw.unifiedDiff,
    added,
    removed,
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/diffUtils.test.ts`
Expected: PASS — all 8 assertions green

- [ ] **Step 6: Commit**

```bash
git add src/types/agent-timeline.ts src/shared/diffUtils.ts src/shared/__tests__/diffUtils.test.ts
git commit -m "feat(types): add TimelineItem types and diff parsing utilities"
```

---

## Task 2: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Update the Prisma schema**

Replace the `AgentMessage` model's `contentJson` field and add columns to `AgentThread`:

```prisma
// prisma/schema.prisma — changes only

model AgentThread {
  id            String            @id @default(cuid())
  title         String
  model         String
  manualTitle   Boolean           @default(false)
  lastMessageAt DateTime?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt
  messages      AgentMessage[]
  artifacts     AgentArtifact[]
  attachments   AgentAttachment[]

  @@index([lastMessageAt(sort: Desc)])
}

model AgentMessage {
  id        String          @id @default(cuid())
  threadId  String
  role      String
  items     Json            @default("[]")
  createdAt DateTime        @default(now())
  thread    AgentThread     @relation(fields: [threadId], references: [id], onDelete: Cascade)
  toolCalls AgentToolCall[]

  @@index([threadId, createdAt])
}
```

- [ ] **Step 2: Regenerate the Prisma init SQL**

Run: `npm run agent:init-sql`
Expected: `prisma/init.sql` is regenerated with the new column names.

Note: PGlite uses the raw SQL init script at runtime, not Prisma migrations. So we only need to regenerate `init.sql`. No `prisma migrate dev` needed for PGlite.

- [ ] **Step 3: Generate the Prisma client**

Run: `npx prisma generate`
Expected: `@prisma/client` regenerated, `items` field and `manualTitle`/`lastMessageAt` are available.

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: Compilation errors for files still referencing `contentJson` — note these for next task.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/init.sql
git commit -m "schema: rename contentJson→items, add manualTitle + lastMessageAt"
```

---

## Task 3: Update AgentStreamEvent Type & Notification Router

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/codexNotificationRouter.ts`
- Modify: `src/main/agent/__tests__/codexNotificationRouter.test.ts`

- [ ] **Step 1: Write new router tests for shell and fileChange notifications**

```typescript
// src/main/agent/__tests__/codexNotificationRouter.test.ts
// ADD these tests to the existing file, inside the top-level describe block:

describe('shell item lifecycle', () => {
  it('emits item_started for commandExecution', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/started', {
      threadId: 't',
      turnId: 'u',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'ls -la', cwd: '/tmp' },
    })
    expect(event).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'cmd-1',
      itemType: 'shell',
      payload: { command: 'ls -la', cwd: '/tmp' },
    })
  })

  it('emits item_delta for commandExecution stdout', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/commandExecution/output', {
      threadId: 't',
      turnId: 'u',
      itemId: 'cmd-1',
      stream: 'stdout',
      data: 'file.txt\n',
    })
    expect(event).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'cmd-1',
      itemType: 'shell',
      patch: { kind: 'appendText', field: 'stdout', text: 'file.txt\n' },
    })
  })

  it('emits item_delta for commandExecution stderr', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/commandExecution/output', {
      threadId: 't',
      turnId: 'u',
      itemId: 'cmd-1',
      stream: 'stderr',
      data: 'warn: ...',
    })
    expect(event).toMatchObject({
      type: 'item_delta',
      patch: { kind: 'appendText', field: 'stderr', text: 'warn: ...' },
    })
  })

  it('emits item_completed for commandExecution', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't',
      turnId: 'u',
      item: { type: 'commandExecution', id: 'cmd-1', exitCode: 0 },
    })
    expect(event).toEqual({
      type: 'item_completed',
      threadId: 't',
      itemId: 'cmd-1',
      itemType: 'shell',
      final: { exitCode: 0 },
    })
  })
})

describe('fileChange item lifecycle', () => {
  it('emits item_started for fileChange', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/started', {
      threadId: 't',
      turnId: 'u',
      item: { type: 'fileChange', id: 'fc-1', status: 'pending' },
    })
    expect(event).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      payload: {},
    })
  })

  it('emits item_completed for fileChange with changes', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't',
      turnId: 'u',
      item: {
        type: 'fileChange',
        id: 'fc-1',
        status: 'completed',
        changes: [
          { path: 'src/foo.ts', kind: 'modify', unifiedDiff: '@@ -1,1 +1,2 @@\n-old\n+new1\n+new2' },
        ],
      },
    })
    expect(event).toMatchObject({
      type: 'item_completed',
      itemId: 'fc-1',
      itemType: 'fileEdit',
    })
  })
})

describe('text item lifecycle (new shape)', () => {
  it('emits item_started for agentMessage', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/started', {
      threadId: 't',
      turnId: 'u',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    expect(event).toEqual({
      type: 'item_started',
      threadId: 't',
      itemId: 'msg-1',
      itemType: 'text',
      payload: {},
    })
  })

  it('emits item_delta for agentMessage/delta', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/agentMessage/delta', {
      threadId: 't',
      turnId: 'u',
      itemId: 'msg-1',
      delta: 'hello',
    })
    expect(event).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hello' },
    })
  })

  it('emits item_delta for reasoning text delta', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/reasoning/textDelta', {
      threadId: 't',
      turnId: 'u',
      itemId: 'r-1',
      delta: 'thinking...',
    })
    expect(event).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'r-1',
      itemType: 'reasoning',
      patch: { kind: 'appendText', field: 'content', text: 'thinking...' },
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts`
Expected: FAIL — new event shapes don't match old router output

- [ ] **Step 3: Update `AgentStreamEvent` type in `agent.ts`**

```typescript
// src/types/agent.ts — replace the AgentStreamEvent type entirely

import type { TimelineItem } from './agent-timeline'

export type ItemDeltaPatch =
  | { kind: 'appendText'; field: 'content' | 'stdout' | 'stderr'; text: string }
  | { kind: 'mergeFields'; fields: Record<string, unknown> }

export interface AgentStreamEventBase {
  threadId: string
  turnId?: string
}

export type AgentStreamEvent =
  | (AgentStreamEventBase & { type: 'thread_created' })
  | (AgentStreamEventBase & { type: 'item_started'; itemId: string; itemType: TimelineItem['type']; payload: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'item_delta'; itemId: string; itemType: TimelineItem['type']; patch: ItemDeltaPatch })
  | (AgentStreamEventBase & { type: 'item_completed'; itemId: string; itemType: TimelineItem['type']; final: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'turn_completed' })
  | (AgentStreamEventBase & { type: 'error'; error: string })
  | (AgentStreamEventBase & { type: 'cancelled' })
```

Also remove the old fields from `AgentStreamEvent` (`delta`, `tool`, `artifact`). Keep `AgentToolEvent`, `AgentArtifact`, and other types unchanged for now — they're used by preload IPC and will be cleaned up when old components are removed.

- [ ] **Step 4: Rewrite `codexNotificationRouter.ts`**

```typescript
// src/main/agent/codexNotificationRouter.ts
import type { AgentStreamEvent } from '../../types/agent'
import { parseChange } from '../../shared/diffUtils'

export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()

  route(method: string, params: Record<string, any>): AgentStreamEvent | null {
    switch (method) {
      case 'item/started': {
        const item = params.item as { type?: string; id?: string; command?: string; cwd?: string } | undefined
        if (!item?.type || !item?.id) return null
        switch (item.type) {
          case 'agentMessage':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              payload: {},
            }
          case 'reasoning':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              payload: {},
            }
          case 'commandExecution':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              payload: {
                ...(item.command != null ? { command: item.command } : {}),
                ...(item.cwd != null ? { cwd: item.cwd } : {}),
              },
            }
          case 'fileChange':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              payload: {},
            }
          default:
            return null
        }
      }

      case 'item/agentMessage/delta': {
        const itemId = params.itemId as string | undefined
        if (typeof itemId === 'string' && itemId.length > 0) {
          this.streamedDeltaItemIds.add(itemId)
        }
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: itemId ?? '',
          itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: params.itemId ?? '',
          itemType: 'reasoning',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }

      case 'item/commandExecution/output': {
        const field = params.stream === 'stderr' ? 'stderr' : 'stdout'
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: params.itemId ?? '',
          itemType: 'shell',
          patch: { kind: 'appendText', field, text: params.data ?? '' },
        }
      }

      case 'item/completed': {
        const item = params.item as Record<string, any> | undefined
        if (!item?.type || !item?.id) return null

        switch (item.type) {
          case 'agentMessage': {
            if (this.streamedDeltaItemIds.has(item.id)) return null
            if (typeof item.text !== 'string' || item.text.length === 0) return null
            return {
              type: 'item_delta',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              patch: { kind: 'appendText', field: 'content', text: item.text },
            }
          }
          case 'commandExecution':
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              final: { exitCode: item.exitCode },
            }
          case 'fileChange': {
            const rawChanges = Array.isArray(item.changes) ? item.changes : []
            const changes = rawChanges.map(parseChange)
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              final: { changes },
            }
          }
          case 'reasoning':
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              final: {},
            }
          default:
            return null
        }
      }

      case 'turn/completed':
        return {
          type: 'turn_completed',
          threadId: params.threadId,
          turnId: params.turn?.id,
        }

      case 'error':
        return {
          type: 'error',
          threadId: params.threadId,
          error: params.error?.message ?? 'codex error',
        }

      default:
        return null
    }
  }
}
```

- [ ] **Step 5: Update old router tests to match new event shape**

Every existing test in `codexNotificationRouter.test.ts` needs to change its expected objects from `{ type: 'message_delta', delta: ... }` to `{ type: 'item_delta', itemType: 'text', patch: { kind: 'appendText', field: 'content', text: ... } }`. Update all of them in the same file.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/types/agent.ts src/main/agent/codexNotificationRouter.ts src/main/agent/__tests__/codexNotificationRouter.test.ts
git commit -m "feat(router): emit item_started/delta/completed events for shell + fileChange"
```

---

## Task 4: Rewrite Store with Timeline Items

**Files:**
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/types.ts`
- Modify: `src/renderer/src/features/agent-chat/__tests__/store.test.ts`

- [ ] **Step 1: Write new store tests**

```typescript
// src/renderer/src/features/agent-chat/__tests__/store.test.ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { DEFAULT_MODEL_ID } from '../models'
import type { Message } from '../../../../../types/agent-timeline'

function lastMsg(): Message | undefined {
  const msgs = useAgentChatStore.getState().messages
  return msgs[msgs.length - 1]
}

describe('useAgentChatStore — timeline items', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: true,
      error: undefined,
      panelWidth: 420,
    })
  })

  it('item_started creates an assistant message with a text item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'msg-1',
      itemType: 'text',
      payload: {},
    })
    const msg = lastMsg()!
    expect(msg.role).toBe('assistant')
    expect(msg.items).toHaveLength(1)
    expect(msg.items[0]).toMatchObject({ type: 'text', id: 'msg-1', content: '' })
  })

  it('item_delta appends text to existing text item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'msg-1',
      itemType: 'text',
      payload: {},
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hello ' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'world' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ content: 'hello world' })
  })

  it('item_started for shell creates a shell item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'cmd-1',
      itemType: 'shell',
      payload: { command: 'ls', cwd: '/tmp' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({
      type: 'shell',
      command: 'ls',
      cwd: '/tmp',
      stdout: '',
      stderr: '',
    })
  })

  it('item_delta appends to shell stdout', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'cmd-1',
      itemType: 'shell',
      payload: { command: 'echo hi' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      itemId: 'cmd-1',
      itemType: 'shell',
      patch: { kind: 'appendText', field: 'stdout', text: 'hi\n' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ stdout: 'hi\n' })
  })

  it('item_completed sets exitCode on shell item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'cmd-1',
      itemType: 'shell',
      payload: { command: 'ls' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      itemId: 'cmd-1',
      itemType: 'shell',
      final: { exitCode: 0 },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ exitCode: 0 })
    expect(lastMsg()!.items[0].endedAt).toBeGreaterThan(0)
  })

  it('turn_completed sets isRunning to false', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'turn_completed',
      threadId: 'thread-1',
    })
    expect(useAgentChatStore.getState().isRunning).toBe(false)
  })

  it('ignores events from stale threads', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'other-thread',
      itemId: 'x',
      itemType: 'text',
      payload: {},
    })
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })
})

describe('useAgentChatStore — panelWidth', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('defaults to 420', () => {
    expect(useAgentChatStore.getState().panelWidth).toBe(420)
  })

  it('setPanelWidth clamps to [360, 720]', () => {
    useAgentChatStore.getState().setPanelWidth(200)
    expect(useAgentChatStore.getState().panelWidth).toBe(360)
    useAgentChatStore.getState().setPanelWidth(999)
    expect(useAgentChatStore.getState().panelWidth).toBe(720)
  })
})

describe('useAgentChatStore selected model', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('exposes a default model id', () => {
    expect(useAgentChatStore.getState().selectedModelId).toBe(DEFAULT_MODEL_ID)
  })

  it('persists setSelectedModel to localStorage', () => {
    useAgentChatStore.getState().setSelectedModel('o3-pro')
    expect(useAgentChatStore.getState().selectedModelId).toBe('o3-pro')
    expect(localStorage.getItem('catimation.agent.selectedModel')).toBe('o3-pro')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/store.test.ts`
Expected: FAIL — `panelWidth`, `setPanelWidth`, new `applyEvent` shape not implemented

- [ ] **Step 3: Update `types.ts`**

```typescript
// src/renderer/src/features/agent-chat/types.ts
// Remove AgentChatMessage — replaced by Message from agent-timeline.ts
export type { Message as AgentChatMessage } from '../../../../types/agent-timeline'
```

- [ ] **Step 4: Rewrite `store.ts` with timeline items**

Full rewrite of `store.ts`. Key changes:
- `messages` becomes `Message[]` (from `agent-timeline.ts`)
- Remove flat `reasoning`, `toolEvents`, `artifacts` — all moved into message items
- Add `panelWidth`, `setPanelWidth`
- `applyEvent` handles `item_started`, `item_delta`, `item_completed` via `upsertItemInLastMessage`
- `send()` wraps user attachments into an `AttachmentItem` inside the user message

The complete store code should be ~180 lines. The `applyEvent` switch cases:
- `item_started` → ensure an assistant message exists, push a new item via `upsertItemInLastMessage` with factory
- `item_delta` with `appendText` → upsert the item, append to the named field
- `item_completed` → upsert the item, merge `final` fields + set `endedAt`
- `turn_completed` → `isRunning = false`
- `error` → `error = event.error, isRunning = false`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/store.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/types.ts src/renderer/src/features/agent-chat/__tests__/store.test.ts
git commit -m "feat(store): rewrite with TimelineItem items[] and panelWidth"
```

---

## Task 5: L0 — Resizable Panel Handle

**Files:**
- Create: `src/renderer/src/features/agent-chat/ResizableHandle.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx`

- [ ] **Step 1: Write ResizableHandle test**

```typescript
// src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ResizableHandle } from '../ResizableHandle'

describe('ResizableHandle', () => {
  it('calls onResize during pointer drag', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    const { container } = render(
      <ResizableHandle panelRight={1000} onResize={onResize} onResizeEnd={onResizeEnd} />,
    )
    const handle = container.firstElementChild!
    fireEvent.pointerDown(handle, { clientX: 1000 })
    fireEvent.pointerMove(document, { clientX: 900 })
    expect(onResize).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ResizableHandle**

```tsx
// src/renderer/src/features/agent-chat/ResizableHandle.tsx
import { useCallback, useRef } from 'react'

const MIN_WIDTH = 360
const MAX_WIDTH = 720

interface ResizableHandleProps {
  panelRight: number
  onResize: (width: number) => void
  onResizeEnd: () => void
}

export function ResizableHandle({ panelRight, onResize, onResizeEnd }: ResizableHandleProps) {
  const dragging = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'ew-resize'

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, panelRight - ev.clientX))
        onResize(width)
      }

      const onUp = () => {
        dragging.current = false
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        onResizeEnd()
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [panelRight, onResize, onResizeEnd],
  )

  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute left-0 top-0 z-10 h-full w-1 cursor-ew-resize hover:bg-cyan-400/40 active:bg-cyan-400/60"
    />
  )
}

export { MIN_WIDTH, MAX_WIDTH }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-chat/ResizableHandle.tsx src/renderer/src/features/agent-chat/__tests__/ResizableHandle.test.tsx
git commit -m "feat(L0): add ResizableHandle component"
```

---

## Task 6: L1 — TimelineItemRenderer + TextCard + MessageBubble Rewrite

**Files:**
- Create: `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/TextCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/MessageBubble.tsx`

- [ ] **Step 1: Create TextCard**

```tsx
// src/renderer/src/features/agent-chat/cards/TextCard.tsx
import type { TextItem } from '../../../../../types/agent-timeline'

export function TextCard({ item }: { item: TextItem }) {
  if (!item.content) return null
  return <div className="whitespace-pre-wrap text-sm leading-relaxed">{item.content}</div>
}
```

- [ ] **Step 2: Create TimelineItemRenderer**

```tsx
// src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx
import type { TimelineItem } from '../../../../types/agent-timeline'
import { TextCard } from './cards/TextCard'

export function TimelineItemRenderer({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'text':
      return <TextCard item={item} />
    case 'reasoning':
    case 'shell':
    case 'fileEdit':
    case 'attachment':
    case 'artifact':
      return (
        <div className="rounded border border-zinc-700/50 bg-zinc-900/50 px-2 py-1 text-xs text-zinc-400">
          {item.type} (coming soon)
        </div>
      )
    default: {
      const _exhaustive: never = item
      return null
    }
  }
}
```

Placeholder cases for card types not yet built — they render a stub that proves the switch is exhaustive. Each subsequent task replaces one stub with the real card.

- [ ] **Step 3: Rewrite MessageBubble to render items**

```tsx
// src/renderer/src/features/agent-chat/MessageBubble.tsx
import type { Message } from '../../../../types/agent-timeline'
import { TimelineItemRenderer } from './TimelineItemRenderer'

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[88%] rounded-2xl px-3 py-2 shadow-lg',
          isUser
            ? 'rounded-br-sm border border-cyan-300/30 bg-cyan-400/15 text-cyan-50'
            : 'rounded-bl-sm border border-zinc-700/70 bg-zinc-900/90 text-zinc-100',
        ].join(' ')}
      >
        {message.items.map((item) => (
          <TimelineItemRenderer key={item.id} item={item} />
        ))}
        {message.items.length === 0 && (
          <span className="text-sm text-zinc-500 italic">Empty message</span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Update AgentChatPanel to use resizable width and remove standalone sections**

Modify `AgentChatPanel.tsx`:
- Read `panelWidth` from store, apply as `style={{ width: panelWidth }}`
- Add `ResizableHandle` inside the `<aside>`
- Remove `<ArtifactGrid>`, `<ReasoningPanel>`, and `<ToolCallCard>` sections (their data now flows through items)
- Keep the error banner (thread-level errors remain separate)

- [ ] **Step 5: Run full test suite to confirm nothing is broken**

Run: `npx vitest run`
Expected: All existing tests pass (store tests were updated in Task 4; router tests in Task 3)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx src/renderer/src/features/agent-chat/cards/TextCard.tsx src/renderer/src/features/agent-chat/MessageBubble.tsx src/renderer/src/features/agent-chat/AgentChatPanel.tsx
git commit -m "feat(L1): rewrite MessageBubble with TimelineItemRenderer + TextCard"
```

---

## Task 7: L3 — ReasoningCard

**Files:**
- Create: `src/renderer/src/features/agent-chat/cards/ReasoningCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`

- [ ] **Step 1: Create ReasoningCard**

```tsx
// src/renderer/src/features/agent-chat/cards/ReasoningCard.tsx
import { useState } from 'react'
import type { ReasoningItem } from '../../../../../types/agent-timeline'

export function ReasoningCard({ item }: { item: ReasoningItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(isRunning)

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300"
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : (
          <span className="text-cyan-400/70">💭</span>
        )}
        <span>{isRunning ? 'Thinking…' : 'Thought'}</span>
        <span className="ml-1 text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[300px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
          {item.content || '…'}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire into TimelineItemRenderer**

Replace the `case 'reasoning':` stub with:

```tsx
case 'reasoning':
  return <ReasoningCard item={item} />
```

Add the import at the top.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/agent-chat/cards/ReasoningCard.tsx src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx
git commit -m "feat(L3): add ReasoningCard with auto-collapse on completion"
```

---

## Task 8: L3 — ShellCard

**Files:**
- Create: `src/renderer/src/features/agent-chat/cards/ShellCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`

- [ ] **Step 1: Create ShellCard**

```tsx
// src/renderer/src/features/agent-chat/cards/ShellCard.tsx
import { useState } from 'react'
import type { ShellItem } from '../../../../../types/agent-timeline'

export function ShellCard({ item }: { item: ShellItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(isRunning)
  const failed = item.exitCode != null && item.exitCode !== 0

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={[
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition',
          failed
            ? 'border-red-500/40 bg-red-500/10 text-red-300'
            : 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300',
        ].join(' ')}
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : (
          <span>{failed ? '✕' : '⚡'}</span>
        )}
        <code className="max-w-[260px] truncate">{item.command}</code>
        {item.exitCode != null && (
          <span className="ml-auto text-[9px] opacity-70">exit {item.exitCode}</span>
        )}
        <span className="text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[400px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 p-2 font-mono text-[11px] leading-relaxed">
          {item.stdout && <pre className="text-zinc-300 whitespace-pre-wrap">{item.stdout}</pre>}
          {item.stderr && <pre className="text-red-300/80 whitespace-pre-wrap">{item.stderr}</pre>}
          {!item.stdout && !item.stderr && <span className="text-zinc-600 italic">No output</span>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire into TimelineItemRenderer**

Replace `case 'shell':` stub with `<ShellCard item={item} />`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/agent-chat/cards/ShellCard.tsx src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx
git commit -m "feat(L3): add ShellCard with exit code coloring"
```

---

## Task 9: L3 — FileEditCard + FileDiffBlock

**Files:**
- Create: `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`
- Modify: `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`

- [ ] **Step 1: Create FileDiffBlock**

```tsx
// src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx
import { useState } from 'react'
import type { FileChange } from '../../../../../types/agent-timeline'

const MAX_VISIBLE_LINES = 200

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-zinc-500'
  if (line.startsWith('+')) return 'text-[#5fdb89] bg-[#0e1b14]'
  if (line.startsWith('-')) return 'text-[#f47b6f] bg-[#1c0e0e]'
  return 'text-zinc-400'
}

export function FileDiffBlock({ change }: { change: FileChange }) {
  const [showAll, setShowAll] = useState(false)
  const lines = change.diff.split('\n')
  const truncated = !showAll && lines.length > MAX_VISIBLE_LINES
  const visible = truncated ? lines.slice(0, MAX_VISIBLE_LINES) : lines

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <code className="font-medium text-zinc-200">{change.path}</code>
        <span className="text-emerald-400">+{change.added}</span>
        <span className="text-red-400">−{change.removed}</span>
      </div>
      <pre className="overflow-x-auto rounded border border-zinc-800/60 bg-zinc-950/70 p-2 font-mono text-[11px] leading-[1.6]">
        {visible.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[10px] text-cyan-400 hover:underline"
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create FileEditCard**

```tsx
// src/renderer/src/features/agent-chat/cards/FileEditCard.tsx
import { useState } from 'react'
import type { FileEditItem } from '../../../../../types/agent-timeline'
import { FileDiffBlock } from './FileDiffBlock'

export function FileEditCard({ item }: { item: FileEditItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(false)

  const summary =
    item.changes.length === 1
      ? `📝 ${item.changes[0].path} +${item.totalAdded} −${item.totalRemoved}`
      : `📝 ${item.changes.length} files changed +${item.totalAdded} −${item.totalRemoved}`

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-600"
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-cyan-400" />
        ) : null}
        <span>{isRunning ? '📝 applying patch…' : summary}</span>
        <span className="ml-1 text-[9px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-zinc-800/50 bg-zinc-950/40 p-1">
          {item.changes.map((change) => (
            <FileDiffBlock key={change.path} change={change} />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire into TimelineItemRenderer**

Replace `case 'fileEdit':` stub with `<FileEditCard item={item} />`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/agent-chat/cards/FileEditCard.tsx src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx
git commit -m "feat(L3): add FileEditCard + FileDiffBlock with unified diff rendering"
```

---

## Task 10: L3 — AttachmentCard + ArtifactCard

**Files:**
- Create: `src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/ArtifactCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`

- [ ] **Step 1: Create AttachmentCard**

```tsx
// src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx
import type { AttachmentItem } from '../../../../../types/agent-timeline'

export function AttachmentCard({
  item,
  onImageDoubleClick,
}: {
  item: AttachmentItem
  onImageDoubleClick?: (attachmentId: string) => void
}) {
  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.attachments.map((ref) =>
        ref.kind === 'image' ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
            alt={ref.name}
            onDoubleClick={() => onImageDoubleClick?.(ref.id)}
            className="h-16 w-16 rounded border border-zinc-700/50 object-cover cursor-pointer hover:border-cyan-400/50"
            title={ref.name}
          />
        ) : (
          <div
            key={ref.id}
            className="flex h-16 items-center gap-1.5 rounded border border-zinc-700/50 bg-zinc-900/50 px-2 text-[10px] text-zinc-300"
            title={ref.name}
          >
            📄 <span className="max-w-[100px] truncate">{ref.name}</span>
          </div>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create ArtifactCard (same shape, different style)**

```tsx
// src/renderer/src/features/agent-chat/cards/ArtifactCard.tsx
import type { ArtifactItem } from '../../../../../types/agent-timeline'

export function ArtifactCard({
  item,
  onImageDoubleClick,
}: {
  item: ArtifactItem
  onImageDoubleClick?: (artifactId: string) => void
}) {
  return (
    <div className="my-1 flex flex-wrap gap-2">
      {item.artifacts.map((ref) =>
        ref.kind === 'image' ? (
          <img
            key={ref.id}
            src={ref.thumbnailUri ?? ref.uri}
            alt={ref.name}
            onDoubleClick={() => onImageDoubleClick?.(ref.id)}
            className="h-20 w-20 rounded border border-cyan-400/25 object-cover cursor-pointer hover:border-cyan-300/50"
            title={ref.name}
          />
        ) : (
          <div
            key={ref.id}
            className="flex h-16 items-center gap-1.5 rounded border border-cyan-400/20 bg-cyan-400/5 px-2 text-[10px] text-cyan-200"
            title={ref.name}
          >
            📦 <span className="max-w-[100px] truncate">{ref.name}</span>
          </div>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire into TimelineItemRenderer**

Replace `case 'attachment':` and `case 'artifact':` stubs. Pass `onImageDoubleClick` prop down from MessageBubble through TimelineItemRenderer.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx src/renderer/src/features/agent-chat/cards/ArtifactCard.tsx src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx
git commit -m "feat(L3): add AttachmentCard + ArtifactCard with image double-click"
```

---

## Task 11: L4 — Lightbox

**Files:**
- Create: `src/renderer/src/features/agent-chat/Lightbox.tsx`
- Modify: `src/renderer/src/features/agent-chat/store.ts` (add preview slice)
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (mount portal)

- [ ] **Step 1: Add preview state to store**

Add to `store.ts`:

```typescript
interface PreviewState {
  open: boolean
  images: AttachmentRef[]
  index: number
}

// In the store:
preview: { open: false, images: [], index: 0 } as PreviewState,
openPreview: (images: AttachmentRef[], startIndex: number) =>
  set({ preview: { open: true, images, index: startIndex } }),
closePreview: () =>
  set((s) => ({ preview: { ...s.preview, open: false } })),
nextPreview: () =>
  set((s) => ({
    preview: { ...s.preview, index: Math.min(s.preview.index + 1, s.preview.images.length - 1) },
  })),
prevPreview: () =>
  set((s) => ({
    preview: { ...s.preview, index: Math.max(s.preview.index - 1, 0) },
  })),
```

- [ ] **Step 2: Create Lightbox component**

```tsx
// src/renderer/src/features/agent-chat/Lightbox.tsx
import { useEffect, useCallback } from 'react'
import { useAgentChatStore } from './store'

export function Lightbox() {
  const preview = useAgentChatStore((s) => s.preview)
  const closePreview = useAgentChatStore((s) => s.closePreview)
  const nextPreview = useAgentChatStore((s) => s.nextPreview)
  const prevPreview = useAgentChatStore((s) => s.prevPreview)

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!preview.open) return
      switch (e.key) {
        case 'Escape': closePreview(); break
        case 'ArrowLeft': prevPreview(); break
        case 'ArrowRight': nextPreview(); break
      }
    },
    [preview.open, closePreview, nextPreview, prevPreview],
  )

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  if (!preview.open || preview.images.length === 0) return null

  const current = preview.images[preview.index]
  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-[50000] flex items-center justify-center bg-black/92"
      onClick={closePreview}
    >
      <div className="absolute left-4 right-4 top-4 flex items-center justify-between text-sm text-zinc-300">
        <span>
          {preview.index + 1} / {preview.images.length} · {current.name}
        </span>
        <button type="button" onClick={closePreview} className="text-zinc-400 hover:text-white text-xl">
          ✕
        </button>
      </div>
      <img
        src={current.uri}
        alt={current.name}
        className="max-h-[80vh] max-w-[90vw] object-contain"
        onClick={(e) => {
          e.stopPropagation()
          nextPreview()
        }}
      />
      {preview.index > 0 && (
        <button
          type="button"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => { e.stopPropagation(); prevPreview() }}
        >
          ‹
        </button>
      )}
      {preview.index < preview.images.length - 1 && (
        <button
          type="button"
          className="absolute right-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => { e.stopPropagation(); nextPreview() }}
        >
          ›
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add `shell.copyImage` and `shell.saveAs` IPC to preload**

In `src/preload/index.ts`, add to the `electronAPI` object:

```typescript
shell: {
  copyImage: (uri: string) => safeInvoke<void>('shell:copy-image', uri),
  saveAs: (uri: string, suggestedName: string) => safeInvoke<void>('shell:save-as', uri, suggestedName),
},
```

Register handlers in the main process to back them with `clipboard.writeImage` and `dialog.showSaveDialog`.

Note: `app://` protocol registration (spec Sec 8.4) is deferred to a follow-up task. For this MVP, image URIs use `file://` paths pointing to `userData/agent-attachments/`. The `app://` protocol can be added as a refinement when we need CSP-safe URLs.

- [ ] **Step 4: Mount Lightbox in AgentChatPanel**

Add `<Lightbox />` at the end of `AgentChatPanel`'s return, outside the `<aside>`.

- [ ] **Step 5: Run test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/Lightbox.tsx src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/AgentChatPanel.tsx src/preload/index.ts
git commit -m "feat(L4): add Lightbox image preview with keyboard navigation"
```

---

## Task 12: L5 — ThreadStore Extensions + IPC + Command Palette

**Files:**
- Modify: `src/main/agent/ThreadStore.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/features/agent-chat/ThreadCommandPalette.tsx`

- [ ] **Step 1: Extend ThreadStore**

Add methods to `ThreadStore`:

```typescript
async openThread(threadId: string) {
  const thread = await this.prisma.agentThread.findUnique({
    where: { id: threadId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  })
  return thread
}

async renameThread(threadId: string, title: string) {
  await this.prisma.agentThread.update({
    where: { id: threadId },
    data: { title, manualTitle: true },
  })
}

async deleteThread(threadId: string) {
  await this.prisma.agentThread.delete({ where: { id: threadId } })
}

async updateLastMessageAt(threadId: string) {
  await this.prisma.agentThread.update({
    where: { id: threadId },
    data: { lastMessageAt: new Date() },
  })
}
```

- [ ] **Step 2: Add IPC handlers in AgentManager or main index**

Register new IPC handlers:

```typescript
ipcMain.handle('agent:open-thread', (_e, threadId: string) => agentManager.openThread(threadId))
ipcMain.handle('agent:rename-thread', (_e, threadId: string, title: string) => agentManager.renameThread(threadId, title))
ipcMain.handle('agent:delete-thread', (_e, threadId: string) => agentManager.deleteThread(threadId))
```

Add corresponding `openThread`, `renameThread`, `deleteThread` methods on `AgentManager` that delegate to `this.store`.

- [ ] **Step 3: Update preload**

Add to `IPC_CHANNELS.AGENT`:

```typescript
OPEN_THREAD: 'agent:open-thread',
RENAME_THREAD: 'agent:rename-thread',
DELETE_THREAD: 'agent:delete-thread',
```

Add to `ElectronAPI.agent`:

```typescript
openThread: (threadId: string) => Promise<unknown>
renameThread: (threadId: string, title: string) => Promise<void>
deleteThread: (threadId: string) => Promise<void>
```

Wire them in the electronAPI object:

```typescript
openThread: (threadId: string) =>
  safeInvoke(IPC_CHANNELS.AGENT.OPEN_THREAD, threadId),
renameThread: (threadId: string, title: string) =>
  safeInvoke(IPC_CHANNELS.AGENT.RENAME_THREAD, threadId, title),
deleteThread: (threadId: string) =>
  safeInvoke(IPC_CHANNELS.AGENT.DELETE_THREAD, threadId),
```

- [ ] **Step 4: Create ThreadCommandPalette**

```tsx
// src/renderer/src/features/agent-chat/ThreadCommandPalette.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentThreadSummary } from '../../../../types/agent'
import { useAgentChatStore } from './store'

export function ThreadCommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<AgentThreadSummary[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const currentThreadId = useAgentChatStore((s) => s.threadId)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIdx(0)
    const agent = (window as any).electronAPI?.agent
    if (agent?.listThreads) {
      agent.listThreads().then((list: AgentThreadSummary[]) => setThreads(list))
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => t.title.toLowerCase().includes(q))
  }, [query, threads])

  const handleSelect = useCallback(
    (threadId: string | null) => {
      if (isRunning) return
      setOpen(false)
      if (threadId === null) {
        useAgentChatStore.getState().newThread()
      } else {
        useAgentChatStore.getState().switchThread(threadId)
      }
    },
    [isRunning],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = filtered.length + 1
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, total - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (selectedIdx === 0) handleSelect(null)
        else handleSelect(filtered[selectedIdx - 1]?.id ?? null)
      }
      else if (e.key === 'Escape') setOpen(false)
    },
    [filtered, selectedIdx, handleSelect],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[49000] flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div
        className="w-[400px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.7)] backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-zinc-800/80 p-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0) }}
            placeholder="Search threads…"
            className="w-full rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/40"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          <button
            type="button"
            disabled={isRunning}
            onClick={() => handleSelect(null)}
            className={[
              'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition',
              selectedIdx === 0 ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-300 hover:bg-zinc-800/60',
              isRunning ? 'opacity-40 cursor-not-allowed' : '',
            ].join(' ')}
            title={isRunning ? 'Wait for the current turn to finish' : 'Create a new chat'}
          >
            ➕ New chat
          </button>
          {filtered.map((t, i) => {
            const idx = i + 1
            const isCurrent = t.id === currentThreadId
            const disabled = isRunning && !isCurrent
            return (
              <button
                key={t.id}
                type="button"
                disabled={disabled}
                onClick={() => handleSelect(t.id)}
                className={[
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition',
                  selectedIdx === idx ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-200 hover:bg-zinc-800/60',
                  disabled ? 'opacity-40 cursor-not-allowed' : '',
                  isCurrent ? 'border-l-2 border-cyan-400' : '',
                ].join(' ')}
                title={disabled ? 'Wait for the current turn to finish' : t.title}
              >
                <span className="truncate">{t.title}</span>
                <span className="text-[10px] text-zinc-500">{new Date(t.updatedAt).toLocaleDateString()}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Add `newThread` and `switchThread` actions to store**

```typescript
newThread: () => set({
  threadId: undefined,
  messages: [],
  isRunning: false,
  error: undefined,
}),
switchThread: async (threadId: string) => {
  const agent = (window as any).electronAPI?.agent
  if (!agent?.openThread) return
  const data = await agent.openThread(threadId)
  if (!data) return
  set({
    threadId,
    messages: (data as any).messages ?? [],
    isRunning: false,
    error: undefined,
  })
},
```

- [ ] **Step 6: Mount ThreadCommandPalette in AgentChatPanel**

Add `<ThreadCommandPalette />` inside the `AgentChatPanel` return.

- [ ] **Step 7: Run test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/agent/ThreadStore.ts src/main/agent/AgentManager.ts src/preload/index.ts src/renderer/src/features/agent-chat/ThreadCommandPalette.tsx src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/AgentChatPanel.tsx
git commit -m "feat(L5): add Thread Command Palette with Ctrl+P switching"
```

---

## Task 13: L5 — Thread Auto-Naming (ThreadTitleSummarizer)

**Files:**
- Create: `src/main/agent/ThreadTitleSummarizer.ts`
- Modify: `src/main/agent/AgentManager.ts`

- [ ] **Step 1: Create ThreadTitleSummarizer**

```typescript
// src/main/agent/ThreadTitleSummarizer.ts
import type { ThreadStore } from './ThreadStore'
import type { IAgentBackend, AgentInput } from './types'

const SUMMARIZE_PROMPT = 'Summarize this conversation in 4–6 Chinese words. No punctuation. Reply with the title only.'
const MAX_RETRIES = 3

export class ThreadTitleSummarizer {
  private readonly retryCountByThread = new Map<string, number>()

  constructor(
    private readonly store: ThreadStore,
    private readonly backend: IAgentBackend,
    private readonly model: string,
  ) {}

  async maybeSummarize(threadId: string): Promise<void> {
    const thread = await this.store.loadThread(threadId)
    if (!thread || thread.manualTitle) return

    const retries = this.retryCountByThread.get(threadId) ?? 0
    if (retries >= MAX_RETRIES) return

    const messages = thread.messages ?? []
    if (messages.length < 2) return

    const firstUser = messages.find((m) => m.role === 'user')
    const firstAssistant = messages.find((m) => m.role === 'assistant')
    if (!firstUser || !firstAssistant) return

    const userText = JSON.stringify(firstUser.items)
    const assistantText = JSON.stringify(firstAssistant.items)
    const context = `User: ${userText.slice(0, 200)}\nAssistant: ${assistantText.slice(0, 200)}`

    try {
      let title = ''
      const input: AgentInput = {
        content: `${context}\n\n${SUMMARIZE_PROMPT}`,
        model: this.model,
        cwd: process.cwd(),
        items: [{ type: 'text', text: `${context}\n\n${SUMMARIZE_PROMPT}` }],
        attachments: [],
      }

      for await (const event of this.backend.send(undefined, input)) {
        if (event.type === 'item_delta' && 'patch' in event) {
          const patch = event.patch as { kind: string; text?: string }
          if (patch.kind === 'appendText' && patch.text) {
            title += patch.text
          }
        }
      }

      title = title.trim().slice(0, 40)
      if (title.length > 0) {
        await this.store.renameThreadIfNotManual(threadId, title)
      }
      this.retryCountByThread.delete(threadId)
    } catch {
      this.retryCountByThread.set(threadId, retries + 1)
    }
  }
}
```

- [ ] **Step 2: Add `renameThreadIfNotManual` to ThreadStore**

```typescript
async renameThreadIfNotManual(threadId: string, title: string) {
  await this.prisma.agentThread.updateMany({
    where: { id: threadId, manualTitle: false },
    data: { title },
  })
}
```

- [ ] **Step 3: Integrate into AgentManager**

In `AgentManager`, after processing `turn_completed` in `forwardEvents`:
- Check if this is the first completed turn for the thread
- Call `this.summarizer.maybeSummarize(dbThreadId)` (fire-and-forget with `.catch`)

Create the summarizer in the constructor:

```typescript
if (this.store) {
  this.summarizer = new ThreadTitleSummarizer(this.store, this.backend, DEFAULT_AGENT_MODEL)
}
```

- [ ] **Step 4: Run test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/ThreadTitleSummarizer.ts src/main/agent/ThreadStore.ts src/main/agent/AgentManager.ts
git commit -m "feat(L5): add ThreadTitleSummarizer for auto-naming after first turn"
```

---

## Task 14: Cleanup — Delete Legacy Components

**Files:**
- Delete: `src/renderer/src/features/agent-chat/ReasoningPanel.tsx`
- Delete: `src/renderer/src/features/agent-chat/ToolCallCard.tsx`
- Delete: `src/renderer/src/features/agent-chat/ArtifactGrid.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (remove imports)

- [ ] **Step 1: Remove legacy component imports from AgentChatPanel**

Remove import lines for `ArtifactGrid`, `ReasoningPanel`, `ToolCallCard` from `AgentChatPanel.tsx`. If they were already removed in Task 6, verify with `npx tsc --noEmit`.

- [ ] **Step 2: Delete the files**

```bash
rm src/renderer/src/features/agent-chat/ReasoningPanel.tsx
rm src/renderer/src/features/agent-chat/ToolCallCard.tsx
rm src/renderer/src/features/agent-chat/ArtifactGrid.tsx
```

- [ ] **Step 3: Delete old test file if present**

```bash
rm -f src/renderer/src/features/agent-chat/__tests__/ArtifactGrid.test.tsx
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS — no references to deleted modules remain

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy ReasoningPanel, ToolCallCard, ArtifactGrid"
```

---

## Task 15: Full Integration Verification

**Files:**
- No new files; verification only.

- [ ] **Step 1: Run the full unit test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Start the app and verify manually**

Run: `npm run dev`

Manual checks:
1. Open agent panel → resizable handle works (drag left edge)
2. Type a message → send → see text items stream in assistant bubble
3. If the agent runs a shell command → collapsed ShellCard appears, click to expand
4. If the agent edits a file → collapsed FileEditCard appears, click to expand diff
5. `Ctrl+P` → Command Palette opens → "New chat" works
6. Upload an image → double-click → Lightbox opens → Esc closes
7. Close panel, reopen → width persisted

- [ ] **Step 4: Commit any quick fixes found during manual test**

```bash
git add -A
git commit -m "fix: address issues found during integration verification"
```

---

## Summary

| Task | Layer | What | Est. |
|------|-------|------|------|
| 1 | — | Timeline types + diff utils | 10 min |
| 2 | — | Prisma schema migration | 5 min |
| 3 | L2 | AgentStreamEvent V2 + Router rewrite | 20 min |
| 4 | L1 | Store rewrite with items[] | 20 min |
| 5 | L0 | ResizableHandle | 10 min |
| 6 | L1 | TimelineItemRenderer + TextCard + MessageBubble | 15 min |
| 7 | L3 | ReasoningCard | 5 min |
| 8 | L3 | ShellCard | 5 min |
| 9 | L3 | FileEditCard + FileDiffBlock | 10 min |
| 10 | L3 | AttachmentCard + ArtifactCard | 10 min |
| 11 | L4 | Lightbox | 15 min |
| 12 | L5 | Thread IPC + Command Palette | 20 min |
| 13 | L5 | ThreadTitleSummarizer | 15 min |
| 14 | — | Delete legacy components | 5 min |
| 15 | — | Full integration verification | 10 min |
