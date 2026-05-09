# Agent Chat Evidence Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent chat read like a Codex/Cursor conversation while compactly preserving tool calls, command output, file edits, and artifacts as inspectable evidence.

**Architecture:** Keep the existing `TimelineItem` and reference model. Add an evidence rendering layer in the chat renderer, group adjacent evidence items at the message level, and keep `useFileExplorerStore.openReference()` as the single bridge into the right-side panel. Preserve true streaming by locking the store/router behavior with tests rather than adding fake frontend typing.

**Tech Stack:** React, TypeScript, Zustand, Vitest, React Testing Library, Tailwind utility classes.

---

## File Structure

- Create `src/renderer/src/features/agent-chat/evidence/evidenceModel.ts`
  - Classifies timeline items as narrative or evidence.
  - Builds deterministic render groups for `MessageBubble`.
  - Produces chip labels, status, and detail availability.
- Create `src/renderer/src/features/agent-chat/evidence/EvidenceStack.tsx`
  - Renders grouped evidence chips.
  - Owns expanded state per evidence item.
  - Handles single-click expand, delayed double-click jump, keyboard expand, and `Open in panel`.
- Create `src/renderer/src/features/agent-chat/evidence/EvidenceDetails.tsx`
  - Renders inline detail for shell, file edit, activity, artifact, and attachment evidence.
  - Reuses `FileDiffBlock` for diffs.
  - Provides no-output/no-diff empty states.
- Modify `src/main/agent/codexNotificationRouter.ts`
  - Preserve `item/fileChange/outputDelta` text instead of dropping it.
  - Use streamed file-change output as a fallback when completed `changes[]` omit diff text.
- Modify `src/renderer/src/features/agent-chat/MessageBubble.tsx`
  - Render narrative items through `TimelineItemRenderer`.
  - Render adjacent evidence items through `EvidenceStack`.
- Modify `src/renderer/src/features/agent-chat/TimelineItemRenderer.tsx`
  - Keep narrative rendering for `text` and `reasoning`.
  - Keep fallback rendering for non-grouped cases if needed by tests.
- Modify `src/renderer/src/features/file-explorer/store.ts`
  - Ensure `openReference()` opens the right-side panel for local file references as well as reference tabs.
- Test `src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts`
- Test `src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx`
- Test `src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx`
- Modify or add tests in `src/main/agent/__tests__/codexNotificationRouter.test.ts`
- Modify or add tests in `src/renderer/src/features/file-explorer/__tests__/openReference.test.ts`
- Modify or add tests in `src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts`

## Task 1: Evidence Grouping Model

**Files:**
- Create: `src/renderer/src/features/agent-chat/evidence/evidenceModel.ts`
- Create: `src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts`

- [ ] **Step 1: Write failing tests for deterministic grouping**

Create `src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../../../../../types/agent-timeline'
import { groupTimelineItemsForChat, getEvidenceSummary, isEvidenceItem } from '../evidenceModel'

const text = (id: string, content = id): TimelineItem => ({ type: 'text', id, startedAt: 1, content })
const reasoning = (id: string): TimelineItem => ({ type: 'reasoning', id, startedAt: 1, content: 'thinking' })
const shell = (id: string): TimelineItem => ({
  type: 'shell',
  id,
  startedAt: 1,
  endedAt: 2,
  command: 'pnpm test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
})
const fileEdit = (id: string): TimelineItem => ({
  type: 'fileEdit',
  id,
  startedAt: 1,
  endedAt: 2,
  changes: [{ path: 'src/a.ts', operation: 'edit', diff: '@@\n-old\n+new', added: 1, removed: 1 }],
  totalAdded: 1,
  totalRemoved: 1,
})
const activity = (id: string): TimelineItem => ({
  type: 'activity',
  id,
  startedAt: 1,
  endedAt: 2,
  kind: 'mcpToolCall',
  label: 'mcp:fs/read',
  detail: '{"path":"src/a.ts"}',
  status: 'success',
})

describe('evidenceModel', () => {
  it('classifies tool-like items as evidence and text/reasoning as narrative', () => {
    expect(isEvidenceItem(shell('cmd'))).toBe(true)
    expect(isEvidenceItem(fileEdit('edit'))).toBe(true)
    expect(isEvidenceItem(activity('act'))).toBe(true)
    expect(isEvidenceItem(text('t'))).toBe(false)
    expect(isEvidenceItem(reasoning('r'))).toBe(false)
  })

  it('groups adjacent evidence and starts a new stack after narrative resumes', () => {
    const groups = groupTimelineItemsForChat([
      text('t1'),
      shell('cmd1'),
      fileEdit('edit1'),
      text('t2'),
      activity('act1'),
    ])

    expect(groups).toEqual([
      { type: 'item', item: text('t1') },
      { type: 'evidence', items: [shell('cmd1'), fileEdit('edit1')] },
      { type: 'item', item: text('t2') },
      { type: 'evidence', items: [activity('act1')] },
    ])
  })

  it('summarizes shell, file edit, and activity evidence without emoji', () => {
    expect(getEvidenceSummary(shell('cmd'))).toMatchObject({
      kind: 'cmd',
      label: 'pnpm test',
      meta: 'success · exit 0',
      status: 'success',
      hasDetails: true,
    })
    expect(getEvidenceSummary(fileEdit('edit'))).toMatchObject({
      kind: 'file',
      label: 'src/a.ts',
      meta: '+1 -1',
      status: 'success',
      hasDetails: true,
    })
    expect(getEvidenceSummary(activity('act'))).toMatchObject({
      kind: 'mcp',
      label: 'mcp:fs/read',
      status: 'success',
      hasDetails: true,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts
```

Expected: FAIL because `evidenceModel.ts` does not exist.

- [ ] **Step 3: Implement evidence model**

Create `src/renderer/src/features/agent-chat/evidence/evidenceModel.ts`:

```ts
import type {
  ActivityItem,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
import { referencesFromTimelineItem } from '../references/referenceUtils'

export type ChatRenderGroup =
  | { type: 'item'; item: TimelineItem }
  | { type: 'evidence'; items: TimelineItem[] }

export type EvidenceStatus = 'running' | 'success' | 'error' | 'cancelled'

export type EvidenceSummary = {
  kind: string
  label: string
  meta: string
  status: EvidenceStatus
  hasDetails: boolean
  hasReference: boolean
}

export function isEvidenceItem(item: TimelineItem): boolean {
  return (
    item.type === 'shell' ||
    item.type === 'fileEdit' ||
    item.type === 'activity' ||
    item.type === 'artifact' ||
    item.type === 'attachment'
  )
}

export function groupTimelineItemsForChat(items: TimelineItem[]): ChatRenderGroup[] {
  const groups: ChatRenderGroup[] = []
  let pendingEvidence: TimelineItem[] = []

  const flushEvidence = (): void => {
    if (pendingEvidence.length === 0) return
    groups.push({ type: 'evidence', items: pendingEvidence })
    pendingEvidence = []
  }

  for (const item of items) {
    if (isEvidenceItem(item)) {
      pendingEvidence.push(item)
      continue
    }
    flushEvidence()
    groups.push({ type: 'item', item })
  }
  flushEvidence()
  return groups
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

function shellStatus(item: ShellItem): EvidenceStatus {
  if (!item.endedAt) return 'running'
  return item.exitCode === 0 ? 'success' : 'error'
}

function fileStatus(item: FileEditItem): EvidenceStatus {
  return item.endedAt ? 'success' : 'running'
}

function activityStatus(item: ActivityItem): EvidenceStatus {
  if (!item.endedAt) return 'running'
  return item.status ?? 'success'
}

function activityKind(kind: string): string {
  if (kind === 'mcpToolCall') return 'mcp'
  if (kind === 'webSearch') return 'web'
  if (kind === 'contextCompaction') return 'ctx'
  return 'tool'
}

export function getEvidenceSummary(item: TimelineItem): EvidenceSummary {
  const references = referencesFromTimelineItem(item)
  const hasReference = references.length > 0

  switch (item.type) {
    case 'shell': {
      const status = shellStatus(item)
      return {
        kind: 'cmd',
        label: item.command || 'command',
        meta: item.exitCode == null ? status : `${status} · exit ${item.exitCode}`,
        status,
        hasDetails: true,
        hasReference,
      }
    }
    case 'fileEdit': {
      const first = item.changes[0]
      const label = item.changes.length === 1 && first ? first.path : `${item.changes.length} files changed`
      return {
        kind: 'file',
        label,
        meta: `+${item.totalAdded} -${item.totalRemoved}`,
        status: fileStatus(item),
        hasDetails: item.changes.length > 0,
        hasReference,
      }
    }
    case 'activity': {
      return {
        kind: activityKind(item.kind),
        label: item.label ?? item.kind,
        meta: activityStatus(item),
        status: activityStatus(item),
        hasDetails: typeof item.detail === 'string' && item.detail.length > 0,
        hasReference,
      }
    }
    case 'artifact': {
      const first = item.artifacts[0]
      return {
        kind: 'file',
        label: first ? basename(first.name) : 'artifact',
        meta: `${item.artifacts.length} artifact${item.artifacts.length === 1 ? '' : 's'}`,
        status: item.endedAt ? 'success' : 'running',
        hasDetails: item.artifacts.length > 0,
        hasReference,
      }
    }
    case 'attachment': {
      const first = item.attachments[0]
      return {
        kind: 'file',
        label: first ? basename(first.name) : 'attachment',
        meta: `${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`,
        status: item.endedAt ? 'success' : 'running',
        hasDetails: item.attachments.length > 0,
        hasReference,
      }
    }
    case 'text':
    case 'reasoning':
      return {
        kind: 'text',
        label: item.type,
        meta: '',
        status: 'success',
        hasDetails: false,
        hasReference: false,
      }
  }
}
```

- [ ] **Step 4: Run model test**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-chat/evidence/evidenceModel.ts src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts
git commit -m "feat(agent-chat): model evidence timeline groups"
```

## Task 2: File Change Diff Preservation

**Files:**
- Modify: `src/main/agent/codexNotificationRouter.ts`
- Test: `src/main/agent/__tests__/codexNotificationRouter.test.ts`

- [ ] **Step 1: Write failing router tests for file-change output deltas**

Add these tests to `src/main/agent/__tests__/codexNotificationRouter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

describe('CodexNotificationRouter file change diffs', () => {
  it('preserves file-change output deltas when completed changes omit unifiedDiff', () => {
    const router = new CodexNotificationRouter()

    expect(
      router.route('item/started', {
        threadId: 'thread-1',
        item: { id: 'file-1', type: 'fileChange' },
      }),
    ).toMatchObject({
      type: 'item_started',
      itemId: 'file-1',
      itemType: 'fileEdit',
    })

    expect(
      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      }),
    ).toBeNull()

    expect(
      router.route('item/completed', {
        threadId: 'thread-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [{ path: 'src/a.ts', kind: 'edit' }],
        },
      }),
    ).toMatchObject({
      type: 'item_completed',
      itemId: 'file-1',
      itemType: 'fileEdit',
      final: {
        changes: [
          {
            path: 'src/a.ts',
            operation: 'edit',
            diff: '@@\n-old\n+new\n',
            added: 1,
            removed: 1,
          },
        ],
      },
    })
  })

  it('prefers structured completed unifiedDiff over streamed fallback text', () => {
    const router = new CodexNotificationRouter()

    router.route('item/fileChange/outputDelta', {
      threadId: 'thread-1',
      itemId: 'file-1',
      delta: 'fallback text',
    })

    expect(
      router.route('item/completed', {
        threadId: 'thread-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@\n-a\n+b\n' }],
        },
      }),
    ).toMatchObject({
      final: {
        changes: [
          {
            path: 'src/a.ts',
            diff: '@@\n-a\n+b\n',
            added: 1,
            removed: 1,
          },
        ],
      },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts
```

Expected: FAIL because `item/fileChange/outputDelta` is currently ignored and no fallback diff is applied.

- [ ] **Step 3: Preserve file-change output deltas in the router**

Modify `src/main/agent/codexNotificationRouter.ts`:

```ts
export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()
  private readonly streamedReasoningItemIds = new Set<string>()
  private readonly fileChangeOutputByItemId = new Map<string, string>()

  route(method: string, params: Record<string, any>): AgentStreamEvent | null {
```

Replace the current `item/fileChange/outputDelta` branch with:

```ts
      case 'item/fileChange/outputDelta': {
        const itemId = params.itemId as string | undefined
        if (typeof itemId !== 'string' || itemId.length === 0) return null
        const delta =
          typeof params.delta === 'string'
            ? params.delta
            : typeof params.data === 'string'
              ? params.data
              : ''
        if (delta.length === 0) return null
        this.fileChangeOutputByItemId.set(
          itemId,
          `${this.fileChangeOutputByItemId.get(itemId) ?? ''}${delta}`,
        )
        return null
      }
```

Replace the `fileChange` completion branch with:

```ts
          case 'fileChange': {
            const rawChanges = Array.isArray(item.changes) ? item.changes : []
            const fallbackDiff = this.fileChangeOutputByItemId.get(item.id) ?? ''
            this.fileChangeOutputByItemId.delete(item.id)
            const rawChangeInputs =
              rawChanges.length > 0
                ? rawChanges
                : fallbackDiff.length > 0
                  ? [{ path: item.path, kind: 'edit' }]
                  : []
            const changes = (rawChangeInputs as Parameters<typeof parseChange>[0][]).map((raw, index) => {
              const parsed = parseChange(raw)
              if (parsed.diff.length > 0 || fallbackDiff.length === 0 || index > 0) return parsed
              const fallbackCounts = countDiffLines(fallbackDiff)
              return {
                ...parsed,
                diff: fallbackDiff,
                added: fallbackCounts.added,
                removed: fallbackCounts.removed,
              }
            })
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              final: { changes },
            }
          }
```

Also update the imports at the top:

```ts
import { countDiffLines, parseChange } from '../../shared/diffUtils'
```

- [ ] **Step 4: Run router test**

Run:

```bash
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexNotificationRouter.ts src/main/agent/__tests__/codexNotificationRouter.test.ts
git commit -m "fix(agent): preserve file change diff output"
```

## Task 3: Evidence Stack UI

**Files:**
- Create: `src/renderer/src/features/agent-chat/evidence/EvidenceDetails.tsx`
- Create: `src/renderer/src/features/agent-chat/evidence/EvidenceStack.tsx`
- Create: `src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Create `src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { EvidenceStack } from '../EvidenceStack'

afterEach(cleanup)

const shell: TimelineItem = {
  type: 'shell',
  id: 'cmd-1',
  startedAt: 1,
  endedAt: 2,
  command: 'pnpm test',
  cwd: 'D:/repo',
  stdout: 'passed',
  stderr: '',
  exitCode: 0,
}

const noDiff: TimelineItem = {
  type: 'fileEdit',
  id: 'edit-1',
  startedAt: 1,
  endedAt: 2,
  changes: [{ path: 'src/a.ts', operation: 'edit', diff: '', added: 0, removed: 0 }],
  totalAdded: 0,
  totalRemoved: 0,
}

describe('EvidenceStack', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ openReference: vi.fn(async () => undefined) } as never)
  })

  it('renders compact evidence chips without exposing details by default', () => {
    render(<EvidenceStack items={[shell]} />)

    expect(screen.getByRole('button', { name: /cmd.*pnpm test.*success/i })).toBeTruthy()
    expect(screen.queryByText('passed')).toBeNull()
  })

  it('single click expands inline details without opening the side panel', () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<EvidenceStack items={[shell]} />)
    fireEvent.click(screen.getByRole('button', { name: /pnpm test/i }))

    expect(screen.getByText('passed')).toBeTruthy()
    expect(openReference).not.toHaveBeenCalled()
  })

  it('double click opens the reference and does not leave inline details expanded', async () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<EvidenceStack items={[shell]} />)
    fireEvent.doubleClick(screen.getByRole('button', { name: /pnpm test/i }))

    await waitFor(() => expect(openReference).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('passed')).toBeNull()
  })

  it('keyboard expands and ctrl-enter opens the reference', async () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<EvidenceStack items={[shell]} />)
    const chip = screen.getByRole('button', { name: /pnpm test/i })
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(screen.getByText('passed')).toBeTruthy()

    fireEvent.keyDown(chip, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(openReference).toHaveBeenCalledTimes(1))
  })

  it('expanded details include a visible Open in panel action', async () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<EvidenceStack items={[shell]} />)
    fireEvent.click(screen.getByRole('button', { name: /pnpm test/i }))
    fireEvent.click(screen.getByRole('button', { name: /open in panel/i }))

    await waitFor(() => expect(openReference).toHaveBeenCalledTimes(1))
  })

  it('renders a no-diff empty state instead of a blank diff panel', () => {
    render(<EvidenceStack items={[noDiff]} />)
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/i }))

    expect(screen.getByText(/File changed, but no diff was provided/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx
```

Expected: FAIL because `EvidenceStack.tsx` does not exist.

- [ ] **Step 3: Implement `EvidenceDetails`**

Create `src/renderer/src/features/agent-chat/evidence/EvidenceDetails.tsx`:

```tsx
import type {
  ActivityItem,
  ArtifactItem,
  AttachmentItem,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
import { FileDiffBlock } from '../cards/FileDiffBlock'

export function EvidenceDetails({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'shell':
      return <ShellDetails item={item} />
    case 'fileEdit':
      return <FileEditDetails item={item} />
    case 'activity':
      return <ActivityDetails item={item} />
    case 'artifact':
      return <AttachmentList title="Artifacts" item={item} />
    case 'attachment':
      return <AttachmentList title="Attachments" item={item} />
    case 'text':
    case 'reasoning':
      return null
  }
}

function ShellDetails({ item }: { item: ShellItem }) {
  const hasOutput = item.stdout.length > 0 || item.stderr.length > 0
  return (
    <div className="space-y-2">
      <div className="rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1 font-mono text-[11px] text-zinc-300">
        {item.command}
      </div>
      {hasOutput ? (
        <div className="max-h-[320px] overflow-y-auto rounded border border-zinc-800/60 bg-zinc-950/50 p-2 font-mono text-[11px] leading-relaxed">
          {item.stdout ? <pre className="whitespace-pre-wrap text-zinc-300">{item.stdout}</pre> : null}
          {item.stderr ? <pre className="whitespace-pre-wrap text-red-300/80">{item.stderr}</pre> : null}
        </div>
      ) : (
        <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-1 text-[11px] italic text-zinc-500">
          No output
        </div>
      )}
    </div>
  )
}

function FileEditDetails({ item }: { item: FileEditItem }) {
  const changesWithDiff = item.changes.filter((change) => change.diff.length > 0)
  if (changesWithDiff.length === 0) {
    return (
      <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-1 text-[11px] text-zinc-500">
        File changed, but no diff was provided.
      </div>
    )
  }
  return (
    <div className="rounded border border-zinc-800/50 bg-zinc-950/40 p-1">
      {changesWithDiff.map((change) => (
        <FileDiffBlock key={change.path} change={change} />
      ))}
    </div>
  )
}

function ActivityDetails({ item }: { item: ActivityItem }) {
  if (!item.detail) return null
  return (
    <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
      {item.detail}
    </pre>
  )
}

function AttachmentList({ title, item }: { title: string; item: ArtifactItem | AttachmentItem }) {
  const refs = item.type === 'artifact' ? item.artifacts : item.attachments
  if (refs.length === 0) return null
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-950/50 px-2 py-1.5 text-[11px] text-zinc-300">
      <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{title}</div>
      <ul className="space-y-1">
        {refs.map((ref) => (
          <li key={ref.id} className="truncate">
            {ref.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Implement `EvidenceStack`**

Create `src/renderer/src/features/agent-chat/evidence/EvidenceStack.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { TimelineItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { EvidenceDetails } from './EvidenceDetails'
import { getEvidenceSummary } from './evidenceModel'

const CLICK_DELAY_MS = 220

export function EvidenceStack({ items }: { items: TimelineItem[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openReference = useFileExplorerStore((state) => state.openReference)

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    }
  }, [])

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openInPanel = async (item: TimelineItem): Promise<void> => {
    const reference = referencesFromTimelineItem(item)[0]
    if (!reference) return
    await openReference(reference)
  }

  const scheduleSingleClick = (id: string): void => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      toggleExpanded(id)
      clickTimerRef.current = null
    }, CLICK_DELAY_MS)
  }

  const cancelSingleClick = (): void => {
    if (!clickTimerRef.current) return
    clearTimeout(clickTimerRef.current)
    clickTimerRef.current = null
  }

  return (
    <div className="my-1.5 flex flex-col gap-1">
      {items.map((item) => {
        const summary = getEvidenceSummary(item)
        const expanded = expandedIds.has(item.id)
        const canOpen = summary.hasReference
        const canExpand = summary.hasDetails
        return (
          <div key={item.id} className="min-w-0">
            <button
              type="button"
              aria-expanded={canExpand ? expanded : undefined}
              aria-label={`${summary.kind} ${summary.label} ${summary.meta}`.trim()}
              onClick={() => {
                if (canExpand) scheduleSingleClick(item.id)
              }}
              onDoubleClick={() => {
                cancelSingleClick()
                void openInPanel(item)
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void openInPanel(item)
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (canExpand) toggleExpanded(item.id)
                }
              }}
              className={[
                'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px]',
                'transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/70',
                colorForStatus(summary.status),
              ].join(' ')}
            >
              {summary.status === 'running' ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              ) : null}
              <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] opacity-70">{summary.kind}</span>
              <span className="truncate font-medium">{summary.label}</span>
              {summary.meta ? <span className="shrink-0 opacity-70">{summary.meta}</span> : null}
              {canExpand ? <span className="shrink-0 text-[9px] opacity-60">{expanded ? '▾' : '▸'}</span> : null}
            </button>
            {expanded ? (
              <div className="mt-1 space-y-1">
                <EvidenceDetails item={item} />
                {canOpen ? (
                  <button
                    type="button"
                    onClick={() => void openInPanel(item)}
                    className="cursor-pointer rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 transition-colors duration-200 hover:bg-cyan-500/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/70"
                  >
                    Open in panel
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-200'
    case 'cancelled':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    case 'success':
    default:
      return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600'
  }
}
```

- [ ] **Step 5: Run evidence stack tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/evidence/EvidenceDetails.tsx src/renderer/src/features/agent-chat/evidence/EvidenceStack.tsx src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx
git commit -m "feat(agent-chat): render compact evidence stack"
```

## Task 4: Message Bubble Evidence Grouping

**Files:**
- Modify: `src/renderer/src/features/agent-chat/MessageBubble.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx`

- [ ] **Step 1: Write failing message grouping test**

Create `src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../../../../types/agent-timeline'
import { MessageBubble } from '../MessageBubble'

afterEach(cleanup)

describe('MessageBubble evidence grouping', () => {
  it('keeps narrative text as the main path and groups adjacent evidence', () => {
    const message: Message = {
      id: 'm1',
      role: 'assistant',
      createdAt: 1,
      items: [
        { type: 'text', id: 't1', startedAt: 1, content: 'I will inspect it.' },
        {
          type: 'shell',
          id: 'cmd1',
          startedAt: 2,
          endedAt: 3,
          command: 'Get-Content file.txt',
          stdout: 'content',
          stderr: '',
          exitCode: 0,
        },
        {
          type: 'fileEdit',
          id: 'edit1',
          startedAt: 4,
          endedAt: 5,
          changes: [{ path: 'file.md', operation: 'edit', diff: '@@\n-a\n+b', added: 1, removed: 1 }],
          totalAdded: 1,
          totalRemoved: 1,
        },
        { type: 'text', id: 't2', startedAt: 6, content: 'Done.' },
      ],
    }

    render(<MessageBubble message={message} />)

    expect(screen.getByText('I will inspect it.')).toBeTruthy()
    expect(screen.getByText('Done.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /cmd.*Get-Content file\.txt/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file.*file\.md/i })).toBeTruthy()
    expect(screen.queryByText(/Open output/i)).toBeNull()
    expect(screen.queryByText(/Open diff/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx
```

Expected: FAIL because `MessageBubble` still renders `ShellCard` and `FileEditCard` directly.

- [ ] **Step 3: Update `MessageBubble`**

Modify `src/renderer/src/features/agent-chat/MessageBubble.tsx`:

```tsx
import type { Message } from '../../../../types/agent-timeline'
import { EvidenceStack } from './evidence/EvidenceStack'
import { groupTimelineItemsForChat } from './evidence/evidenceModel'
import { TimelineItemRenderer } from './TimelineItemRenderer'

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const groups = groupTimelineItemsForChat(message.items)

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
        {groups.map((group, index) =>
          group.type === 'item' ? (
            <TimelineItemRenderer key={group.item.id} item={group.item} />
          ) : (
            <EvidenceStack key={`evidence-${index}-${group.items[0]?.id ?? 'empty'}`} items={group.items} />
          ),
        )}
        {message.items.length === 0 && (
          <span className="text-sm text-zinc-500 italic">Empty message</span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run message grouping test**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run related chat card tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat/MessageBubble.tsx src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx
git commit -m "feat(agent-chat): group evidence inside assistant messages"
```

## Task 5: Right Panel Linkage for Local Files

**Files:**
- Modify: `src/renderer/src/features/file-explorer/store.ts`
- Test: `src/renderer/src/features/file-explorer/__tests__/openReference.test.ts`

- [ ] **Step 1: Write failing file explorer test**

Create `src/renderer/src/features/file-explorer/__tests__/openReference.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '../store'

const fakeApi = {
  agent: { setAllowedRoots: vi.fn(async (roots: string[]) => roots) },
  fs: {
    readText: vi.fn(async () => ({ content: '# hello', mtime: 1 })),
    writeText: vi.fn(),
    listDir: vi.fn(),
    stat: vi.fn(async () => ({ ok: true, size: 10, mime: 'text/markdown', mtime: 1 })),
    pickFolder: vi.fn(),
    watchStart: vi.fn(async () => undefined),
    watchStop: vi.fn(async () => undefined),
  },
  attachments: { listTree: vi.fn() },
}

describe('file explorer openReference', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: fakeApi,
    })
    useFileExplorerStore.setState({
      fxOpen: false,
      tabs: [],
      activeTabId: null,
    })
    vi.clearAllMocks()
  })

  it('opens the right panel when a local file reference is opened', async () => {
    await useFileExplorerStore.getState().openReference({
      id: 'file:D:/repo/a.md',
      type: 'file',
      label: 'a.md',
      source: { kind: 'localPath', path: 'D:/repo/a.md' },
      status: 'ready',
      openBehavior: 'markdown',
    })

    const state = useFileExplorerStore.getState()
    expect(state.fxOpen).toBe(true)
    expect(state.activeTabId).toBeTruthy()
    expect(state.tabs[0]).toMatchObject({ path: 'D:/repo/a.md', name: 'a.md' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/renderer/src/features/file-explorer/__tests__/openReference.test.ts
```

Expected: FAIL because local file references call `openTab()` and return without setting `fxOpen`.

- [ ] **Step 3: Update `openReference`**

Modify the local-file branch in `src/renderer/src/features/file-explorer/store.ts`:

```ts
  openReference: async (reference) => {
    if (
      reference.source.kind === 'localPath' &&
      (reference.openBehavior === 'code' ||
        reference.openBehavior === 'markdown' ||
        reference.openBehavior === 'image' ||
        reference.openBehavior === 'pdf')
    ) {
      set({ fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      await get().openTab(reference.source.path, 'workspace')
      return
    }

    const existing = get().tabs.find((t) => t.referenceKey === reference.id)
```

- [ ] **Step 4: Run file explorer test**

Run:

```bash
npx vitest run src/renderer/src/features/file-explorer/__tests__/openReference.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/file-explorer/store.ts src/renderer/src/features/file-explorer/__tests__/openReference.test.ts
git commit -m "fix(file-explorer): open panel for local references"
```

## Task 6: Streaming Text Regression

**Files:**
- Modify or create: `src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts`
- Modify only if test exposes a bug: `src/renderer/src/features/agent-chat/store.ts`

- [ ] **Step 1: Write streaming regression tests**

Create `src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'

describe('agent chat streaming text', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: false,
      error: undefined,
    })
  })

  it('renders intermediate text deltas before turn completion', () => {
    const store = useAgentChatStore.getState()

    store.applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'Hel' },
    })

    expect(useAgentChatStore.getState().messages[0]?.items).toEqual([
      expect.objectContaining({ type: 'text', id: 'msg-1', content: 'Hel' }),
    ])

    store.applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'lo' },
    })

    expect(useAgentChatStore.getState().messages[0]?.items[0]).toMatchObject({
      type: 'text',
      id: 'msg-1',
      content: 'Hello',
    })
  })

  it('does not replace streamed text when completion arrives for the same item', () => {
    const store = useAgentChatStore.getState()

    store.applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'streamed' },
    })
    const streamedItem = useAgentChatStore.getState().messages[0]?.items[0]

    store.applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      itemType: 'text',
      final: {},
    })

    const completedItem = useAgentChatStore.getState().messages[0]?.items[0]
    expect(completedItem).toMatchObject({ type: 'text', id: 'msg-1', content: 'streamed' })
    expect(completedItem?.id).toBe(streamedItem?.id)
  })
})
```

- [ ] **Step 2: Run test**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts
```

Expected: PASS if current store already preserves real streaming. If it fails, continue with Step 3.

- [ ] **Step 3: Fix only if failing**

If the second test fails because `item_completed` overwrites text content, update `applyItemCompleted` in `src/renderer/src/features/agent-chat/store.ts` so an empty final payload does not replace existing text fields:

```ts
function applyItemCompleted(item: TimelineItem, final: Record<string, unknown>): TimelineItem {
  const endedAt = Date.now()
  if (item.type === 'text' && final.content == null && final.text == null) {
    return { ...item, endedAt }
  }
  return { ...item, ...final, type: item.type, endedAt } as TimelineItem
}
```

If the actual helper has a different name or shape, preserve the same invariant: completion may add metadata but must not erase streamed content.

- [ ] **Step 4: Run streaming test**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

If only the test was needed:

```bash
git add src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts
git commit -m "test(agent-chat): cover streamed text updates"
```

If store changed too:

```bash
git add src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts
git commit -m "fix(agent-chat): preserve streamed text on completion"
```

## Task 7: Integrated Regression Sweep

**Files:**
- No new files expected.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts src/renderer/src/features/agent-chat/evidence/__tests__/evidenceModel.test.ts src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx src/renderer/src/features/agent-chat/__tests__/MessageBubble.evidence.test.tsx src/renderer/src/features/agent-chat/__tests__/store.streaming.test.ts src/renderer/src/features/file-explorer/__tests__/openReference.test.ts src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run linter diagnostics in IDE**

Use `ReadLints` for:

- `src/renderer/src/features/agent-chat/evidence/evidenceModel.ts`
- `src/renderer/src/features/agent-chat/evidence/EvidenceStack.tsx`
- `src/renderer/src/features/agent-chat/evidence/EvidenceDetails.tsx`
- `src/renderer/src/features/agent-chat/MessageBubble.tsx`
- `src/renderer/src/features/file-explorer/store.ts`
- `src/main/agent/codexNotificationRouter.ts`

Expected: no new lint errors.

- [ ] **Step 3: Manual smoke test**

Start or use the running app:

```bash
npm run dev
```

In the app, run a Codex prompt that reads a file, edits a file, and runs a command.

Expected:

- Assistant text appears as streamed deltas.
- Tool calls and file edits render as compact evidence chips.
- Single click expands inline details.
- Double click opens the right-side panel.
- Expanded `Open in panel` button opens the same target.
- Empty command output and missing diff states show readable empty messages.

- [ ] **Step 4: Commit verification changes only if Task 7 changed files**

Task 7 is expected to be verification-only. If it passes without edits, do not create a commit. If it exposes a small missing test or assertion in files already introduced by Tasks 1-6, commit only those exact files. For example, if the integrated sweep requires an extra assertion in the evidence stack test:

```bash
git add src/renderer/src/features/agent-chat/evidence/__tests__/EvidenceStack.test.tsx
git commit -m "test(agent-chat): verify evidence stack integration"
```

Do not create an empty commit.

## Self-Review

Spec coverage:

- Narrative chat over raw logs: Tasks 1, 3, and 4.
- Evidence chips/stack: Tasks 1, 3, and 4.
- Single-click inline details: Task 3.
- Double-click right-panel jump: Task 3.
- Accessible `Open in panel` alternative: Task 3.
- Keyboard support: Task 3.
- File-change streamed diff preservation: Task 2.
- Real streaming text: Task 6.
- Right panel linkage for local references: Task 5.
- Missing diff/output empty states: Task 3 and existing `diffUtils` crash coverage.
- Tests and manual acceptance: Task 7.

Completion-marker scan:

- No unfinished markers or unspecified implementation steps.
- Each code task includes exact file paths, test contents, commands, and expected results.

Type consistency:

- Uses existing `TimelineItem`, `Message`, `referencesFromTimelineItem()`, and `useFileExplorerStore.openReference()`.
- New model functions are introduced before UI tasks consume them.
- `EvidenceStack` depends only on existing store/reference APIs and new `evidenceModel`.
