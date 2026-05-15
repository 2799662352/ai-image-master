# Agent Chat Work Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI file work feel visible and inspectable by adding markdown draft cards, compact chat diffs, and side-by-side AI change tabs in the file explorer.

**Architecture:** Keep the backend protocol unchanged for v1. Derive markdown draft UI from completed markdown `FileEditItem` changes, parse unified diffs into before/after documents for side-by-side viewing, and extend the existing file explorer tab model with an `ai-change` kind. Chat remains the live summary surface; the file explorer becomes the detail surface.

**Tech Stack:** React, TypeScript, Zustand, Tailwind CSS, CodeMirror 6, `@codemirror/merge`, Vitest.

---

## File Structure

- Create `src/renderer/src/features/agent-chat/diff/parseUnifiedDiff.ts`
  - Pure parser that reconstructs before/after content from `FileChange.diff`.
- Create `src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts`
  - Parser coverage for edit/create/delete/malformed diffs.
- Create `src/renderer/src/features/agent-chat/cards/MarkdownDraftCard.tsx`
  - Renderer-derived markdown creation card with visual-only typewriter reveal.
- Create `src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx`
  - Animation and click behavior tests.
- Modify `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`
  - Improve compact diff styling and keep truncation behavior.
- Create or modify `src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx`
  - Verify red/green styling and truncation.
- Modify `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
  - Multi-file list behavior, markdown create card delegation, click-through to AI change tabs.
- Create or modify `src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx`
  - Verify labels, multi-file list, click-through.
- Modify `src/renderer/src/features/file-explorer/types.ts`
  - Extend `FileTabKind` with `ai-change`; add optional `aiChange` metadata.
- Modify `src/renderer/src/features/file-explorer/store.ts`
  - Add `openAiChange(change)` action.
- Create `src/renderer/src/features/file-explorer/AiChangeViewer.tsx`
  - Read-only detail viewer with split diff when parsing succeeds and unified fallback when parsing fails.
- Modify `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`
  - Render `AiChangeViewer` for `kind === 'ai-change'`.
- Add/modify file explorer store/component tests for `openAiChange`.

---

### Task 1: Unified Diff Parser

**Files:**
- Create: `src/renderer/src/features/agent-chat/diff/parseUnifiedDiff.ts`
- Create: `src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts`

- [ ] **Step 1: Write parser tests**

Create `src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../parseUnifiedDiff'

describe('parseUnifiedDiff', () => {
  it('reconstructs before/after content for an edit diff', () => {
    const diff = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1,4 +1,4 @@',
      ' # Title',
      '-old line',
      '+new line',
      ' shared line',
      '',
    ].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual({
      ok: true,
      beforeContent: '# Title\nold line\nshared line\n',
      afterContent: '# Title\nnew line\nshared line\n',
    })
  })

  it('reconstructs create diffs with empty before content', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1,3 @@',
      '+# New',
      '+',
      '+Body',
    ].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual({
      ok: true,
      beforeContent: '',
      afterContent: '# New\n\nBody',
    })
  })

  it('reconstructs delete diffs with empty after content', () => {
    const diff = [
      '--- a/docs/old.md',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-# Old',
      '-Body',
    ].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual({
      ok: true,
      beforeContent: '# Old\nBody',
      afterContent: '',
    })
  })

  it('ignores no-newline markers', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual({
      ok: true,
      beforeContent: 'old',
      afterContent: 'new',
    })
  })

  it('returns a failure result for empty or unsupported input', () => {
    expect(parseUnifiedDiff('')).toEqual({ ok: false, reason: 'empty diff' })
    expect(parseUnifiedDiff('not a unified diff')).toEqual({
      ok: false,
      reason: 'no diff lines found',
    })
  })
})
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts
```

Expected: fail because `parseUnifiedDiff.ts` does not exist.

- [ ] **Step 3: Implement parser**

Create `src/renderer/src/features/agent-chat/diff/parseUnifiedDiff.ts`:

```ts
export type ParsedUnifiedDiff =
  | { ok: true; beforeContent: string; afterContent: string }
  | { ok: false; reason: string }

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (!diff.trim()) return { ok: false, reason: 'empty diff' }

  const before: string[] = []
  const after: string[] = []
  let sawDiffLine = false

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ')) continue
    if (rawLine.startsWith('index ')) continue
    if (rawLine.startsWith('--- ')) continue
    if (rawLine.startsWith('+++ ')) continue
    if (rawLine.startsWith('@@')) continue
    if (rawLine.startsWith('\\ No newline at end of file')) continue

    if (rawLine.startsWith('-')) {
      before.push(rawLine.slice(1))
      sawDiffLine = true
      continue
    }

    if (rawLine.startsWith('+')) {
      after.push(rawLine.slice(1))
      sawDiffLine = true
      continue
    }

    before.push(rawLine)
    after.push(rawLine)
    if (rawLine.length > 0) sawDiffLine = true
  }

  if (!sawDiffLine) return { ok: false, reason: 'no diff lines found' }

  return {
    ok: true,
    beforeContent: before.join('\n'),
    afterContent: after.join('\n'),
  }
}
```

- [ ] **Step 4: Run parser tests and verify pass**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts
```

Expected: all tests pass.

---

### Task 2: File Explorer AI Change Tabs

**Files:**
- Modify: `src/renderer/src/features/file-explorer/types.ts`
- Modify: `src/renderer/src/features/file-explorer/store.ts`
- Create: `src/renderer/src/features/file-explorer/__tests__/openAiChange.test.ts`

- [ ] **Step 1: Write store test for `openAiChange`**

Create `src/renderer/src/features/file-explorer/__tests__/openAiChange.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { useFileExplorerStore } from '../store'
import type { FileChange } from '../../../../../types/agent-timeline'

function resetStore() {
  useFileExplorerStore.setState({
    fxOpen: false,
    fxTreeWidth: 240,
    workspaceRoot: null,
    workspaceTree: [],
    attachmentsTree: [],
    treeLoading: false,
    tabs: [],
    activeTabId: null,
    conflict: null,
    pendingChatInsert: null,
    selectedPaths: [],
    lastSelectedPath: null,
    clipboard: null,
    pendingNewNode: null,
  })
}

describe('openAiChange', () => {
  beforeEach(() => resetStore())

  it('opens an ai-change tab with parsed before/after content', async () => {
    const change: FileChange = {
      path: 'docs/a.md',
      operation: 'edit',
      diff: ['--- a/docs/a.md', '+++ b/docs/a.md', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      added: 1,
      removed: 1,
    }

    await useFileExplorerStore.getState().openAiChange(change)

    const state = useFileExplorerStore.getState()
    expect(state.fxOpen).toBe(true)
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(state.tabs[0].id)
    expect(state.tabs[0]).toMatchObject({
      kind: 'ai-change',
      path: 'docs/a.md',
      name: 'a.md',
      source: 'workspace',
      dirty: false,
      diskContent: '',
      diskMtime: 0,
    })
    expect(state.tabs[0].aiChange).toMatchObject({
      beforeContent: 'old',
      afterContent: 'new',
      change,
    })
  })

  it('re-clicking the same change activates the existing tab', async () => {
    const change: FileChange = {
      path: 'docs/a.md',
      operation: 'edit',
      diff: ['--- a/docs/a.md', '+++ b/docs/a.md', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      added: 1,
      removed: 1,
    }

    await useFileExplorerStore.getState().openAiChange(change)
    const firstId = useFileExplorerStore.getState().activeTabId
    await useFileExplorerStore.getState().openAiChange(change)

    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(firstId)
  })

  it('opens a fallback tab when diff parsing fails', async () => {
    const change: FileChange = {
      path: 'docs/bad.md',
      operation: 'edit',
      diff: 'not a unified diff',
      added: 0,
      removed: 0,
    }

    await useFileExplorerStore.getState().openAiChange(change)

    const tab = useFileExplorerStore.getState().tabs[0]
    expect(tab.kind).toBe('ai-change')
    expect(tab.aiChange?.parseError).toBe('no diff lines found')
  })
})
```

- [ ] **Step 2: Run store test and verify failure**

Run:

```bash
npx vitest run src/renderer/src/features/file-explorer/__tests__/openAiChange.test.ts
```

Expected: fail because `openAiChange` and `ai-change` kind do not exist.

- [ ] **Step 3: Extend file tab types**

Modify `src/renderer/src/features/file-explorer/types.ts`:

```ts
import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'
import type { FileChange } from '../../../../types/agent-timeline'

export type FileSource = 'workspace' | 'attachments'

// ... existing FileNode ...

export type FileTabKind =
  | 'text'
  | 'image'
  | 'video'
  | 'pdf'
  | 'binary'
  | 'reference'
  | 'compare'
  | 'ai-change'

export type FileTab = {
  id: string
  path: string
  name: string
  source: FileSource
  kind: FileTabKind
  state: EditorState | null
  diskContent: string
  diskMtime: number
  dirty: boolean
  referenceKey?: string
  reference?: AgentReference
  compare?: { left: string; right: string; leftContent: string; rightContent: string }
  aiChange?: {
    change: FileChange
    beforeContent?: string
    afterContent?: string
    parseError?: string
  }
}
```

Keep the existing comments in place when editing; this code block shows the desired final shape.

- [ ] **Step 4: Add store action type**

In `src/renderer/src/features/file-explorer/store.ts`, import `FileChange` and add to `Actions`:

```ts
import type { FileChange } from '../../../../types/agent-timeline'
```

```ts
openAiChange: (change: FileChange) => Promise<void>
```

- [ ] **Step 5: Implement `openAiChange`**

In `src/renderer/src/features/file-explorer/store.ts`, import parser:

```ts
import { parseUnifiedDiff } from '../agent-chat/diff/parseUnifiedDiff'
```

Add helper near existing path helpers:

```ts
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
```

Add action near `openReference`:

```ts
  openAiChange: async (change) => {
    const existing = get().tabs.find((t) => t.kind === 'ai-change' && t.path === change.path)
    if (existing) {
      set({ activeTabId: existing.id, fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      return
    }

    const parsed = parseUnifiedDiff(change.diff)
    const id = globalThis.crypto?.randomUUID?.() ?? `ai-change-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const tab: FileTab = {
      id,
      path: change.path,
      name: basename(change.path),
      source: 'workspace',
      kind: 'ai-change',
      state: null,
      diskContent: '',
      diskMtime: 0,
      dirty: false,
      aiChange: {
        change,
        ...(parsed.ok
          ? { beforeContent: parsed.beforeContent, afterContent: parsed.afterContent }
          : { parseError: parsed.reason }),
      },
    }

    set((s) => ({
      fxOpen: true,
      activeTabId: id,
      tabs: [...s.tabs, tab],
    }))
    writeStorage(FX_OPEN_KEY, '1')
  },
```

- [ ] **Step 6: Run store test and verify pass**

Run:

```bash
npx vitest run src/renderer/src/features/file-explorer/__tests__/openAiChange.test.ts
```

Expected: all tests pass.

---

### Task 3: AI Change Viewer

**Files:**
- Create: `src/renderer/src/features/file-explorer/AiChangeViewer.tsx`
- Modify: `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`
- Modify: `src/renderer/src/features/file-explorer/DiffMergeView.tsx`

- [ ] **Step 1: Update `DiffMergeView` read-only behavior**

Modify `src/renderer/src/features/file-explorer/DiffMergeView.tsx` to use both read-only extensions:

```tsx
import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const readOnlyExtensions = [EditorView.editable.of(false), EditorState.readOnly.of(true)]

export function DiffMergeView({ disk, mine }: { disk: string; mine: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return undefined
    const view = new MergeView({
      a: { doc: disk, extensions: readOnlyExtensions },
      b: { doc: mine, extensions: readOnlyExtensions },
      parent: ref.current,
    })
    return () => view.destroy()
  }, [disk, mine])
  return <div ref={ref} className="h-full overflow-auto text-xs" />
}
```

- [ ] **Step 2: Create `AiChangeViewer`**

Create `src/renderer/src/features/file-explorer/AiChangeViewer.tsx`:

```tsx
import type { FileTab } from './types'
import { DiffMergeView } from './DiffMergeView'

function operationLabel(operation: string): string {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    default:
      return 'Edited'
  }
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-cyan-300/60'
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-200'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-200'
  return 'text-zinc-400'
}

export function AiChangeViewer({ tab }: { tab: FileTab }) {
  const meta = tab.aiChange
  if (!meta) return null

  const { change } = meta
  const canSplit = meta.beforeContent != null && meta.afterContent != null

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-cyan-500/10 px-3 py-2 text-[11px] text-zinc-300">
        <span className="rounded border border-cyan-400/20 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-100">
          {operationLabel(change.operation)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
          {change.path}
        </span>
        <span className="text-emerald-300">+{change.added}</span>
        <span className="text-red-300">-{change.removed}</span>
      </div>

      <div className="min-h-0 flex-1">
        {canSplit ? (
          <DiffMergeView disk={meta.beforeContent ?? ''} mine={meta.afterContent ?? ''} />
        ) : (
          <div className="h-full overflow-auto p-3">
            {meta.parseError && (
              <div className="mb-2 rounded border border-amber-400/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
                Could not reconstruct split diff: {meta.parseError}. Showing unified diff.
              </div>
            )}
            <pre className="m-0 overflow-x-auto rounded border border-zinc-800/70 bg-zinc-950/80 p-2 font-mono text-[11px] leading-[1.55]">
              {change.diff.split('\n').map((line, index) => (
                <div key={index} className={lineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render AI change tabs**

Modify `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`:

```tsx
import { AiChangeViewer } from './AiChangeViewer'
```

Add to `ActiveViewer` switch:

```tsx
    case 'ai-change':
      return <AiChangeViewer tab={tab} />
```

- [ ] **Step 4: Run TypeScript check for touched files**

Run:

```bash
npx tsc --noEmit
```

Expected: no new errors for `AiChangeViewer.tsx`, `FileExplorerPanel.tsx`, `DiffMergeView.tsx`, `types.ts`, or `store.ts`. Existing unrelated repository errors may still appear; filter if needed.

---

### Task 4: Compact Diff Block Improvements

**Files:**
- Modify: `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx`

- [ ] **Step 1: Write `FileDiffBlock` tests**

Create `src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileDiffBlock } from '../FileDiffBlock'
import type { FileChange } from '../../../../../../types/agent-timeline'

function change(diff: string): FileChange {
  return {
    path: 'docs/a.md',
    operation: 'edit',
    diff,
    added: 1,
    removed: 1,
  }
}

describe('FileDiffBlock', () => {
  it('styles added and deleted lines distinctly', () => {
    render(<FileDiffBlock change={change('@@ -1 +1 @@\n-old\n+new\n context')} />)

    expect(screen.getByText('-old').className).toContain('red')
    expect(screen.getByText('+new').className).toContain('emerald')
    expect(screen.getByText('@@ -1 +1 @@').className).toContain('cyan')
  })

  it('truncates large diffs in chat', () => {
    const diff = Array.from({ length: 220 }, (_, i) => `+line ${i}`).join('\n')
    render(<FileDiffBlock change={change(diff)} />)

    expect(screen.getByText(/Show all 220 lines/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run `FileDiffBlock` tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx
```

Expected: fail until classes are updated.

- [ ] **Step 3: Update `FileDiffBlock` styles**

Modify `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`:

```tsx
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'border-l border-cyan-400/20 bg-cyan-500/[0.05] pl-2 text-cyan-300/60'
  if (line.startsWith('+')) return 'border-l border-emerald-400/25 bg-emerald-500/10 pl-2 text-emerald-200'
  if (line.startsWith('-')) return 'border-l border-red-400/25 bg-red-500/10 pl-2 text-red-200'
  return 'border-l border-transparent pl-2 text-zinc-400'
}
```

Also change the `<pre>` class to:

```tsx
<pre className="overflow-x-auto rounded border border-zinc-800/60 bg-zinc-950/70 p-1.5 font-mono text-[11px] leading-[1.6]">
```

- [ ] **Step 4: Run `FileDiffBlock` tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx
```

Expected: all tests pass.

---

### Task 5: Markdown Draft Card

**Files:**
- Create: `src/renderer/src/features/agent-chat/cards/MarkdownDraftCard.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx`

- [ ] **Step 1: Write `MarkdownDraftCard` tests**

Create `src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownDraftCard } from '../MarkdownDraftCard'

describe('MarkdownDraftCard', () => {
  it('renders created markdown and opens the file when clicked', () => {
    const onOpen = vi.fn()
    render(
      <MarkdownDraftCard
        path="docs/a.md"
        content="# Title\n\nBody"
        status="created"
        onOpen={onOpen}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /open docs\/a.md/i }))
    expect(onOpen).toHaveBeenCalledWith('docs/a.md')
  })

  it('does not open failed drafts', () => {
    const onOpen = vi.fn()
    render(
      <MarkdownDraftCard
        path="docs/a.md"
        content="# Title"
        status="failed"
        error="write failed"
        onOpen={onOpen}
      />,
    )

    fireEvent.click(screen.getByText(/write failed/i))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders large markdown immediately', () => {
    const content = `# Title\n\n${'x'.repeat(21 * 1024)}`
    render(<MarkdownDraftCard path="docs/big.md" content={content} status="created" onOpen={vi.fn()} />)

    expect(screen.getByText(/x{20}/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx
```

Expected: fail because component does not exist.

- [ ] **Step 3: Implement `MarkdownDraftCard`**

Create `src/renderer/src/features/agent-chat/cards/MarkdownDraftCard.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { MarkdownContent } from '../MarkdownContent'

const LARGE_MARKDOWN_BYTES = 20 * 1024

type DraftStatus = 'streaming' | 'created' | 'failed'

export function MarkdownDraftCard({
  path,
  content,
  status,
  error,
  onOpen,
}: {
  path: string
  content: string
  status: DraftStatus
  error?: string
  onOpen: (path: string) => void
}) {
  const shouldAnimate = content.length < LARGE_MARKDOWN_BYTES && status !== 'failed'
  const [visibleLength, setVisibleLength] = useState(shouldAnimate ? 0 : content.length)

  useEffect(() => {
    if (!shouldAnimate) {
      setVisibleLength(content.length)
      return
    }
    setVisibleLength(0)
    let frame = 0
    const tick = () => {
      setVisibleLength((current) => {
        const next = Math.min(content.length, current + 96)
        if (next >= content.length) return next
        frame = window.setTimeout(tick, 16)
        return next
      })
    }
    frame = window.setTimeout(tick, 16)
    return () => window.clearTimeout(frame)
  }, [content, shouldAnimate])

  const visibleContent = useMemo(() => content.slice(0, visibleLength), [content, visibleLength])
  const canOpen = status === 'created' && Boolean(path)

  const label =
    status === 'failed'
      ? `Failed to create ${path}`
      : status === 'streaming'
        ? `Creating ${path}...`
        : `Created ${path}`

  return (
    <button
      type="button"
      aria-label={`Open ${path}`}
      disabled={!canOpen}
      onClick={() => {
        if (canOpen) onOpen(path)
      }}
      className="my-2 block w-full overflow-hidden rounded-lg border border-cyan-400/20 bg-zinc-950/70 text-left transition hover:border-cyan-300/40 disabled:cursor-default disabled:hover:border-cyan-400/20"
    >
      <div className="flex items-center gap-2 border-b border-cyan-500/10 px-2.5 py-1.5 text-[11px] text-cyan-100">
        {status === 'streaming' && (
          <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>{label}</span>
      </div>
      {error && (
        <div className="border-b border-red-400/10 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-100">
          {error}
        </div>
      )}
      <div className="max-h-[360px] overflow-auto px-3 py-2">
        <MarkdownContent source={visibleContent} />
      </div>
    </button>
  )
}
```

- [ ] **Step 4: Run component tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx
```

Expected: all tests pass. If the large markdown regex is brittle in jsdom, assert a shorter literal substring from the generated content instead.

---

### Task 6: FileEditCard Work Surface Behavior

**Files:**
- Modify: `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
- Create/modify: `src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx`

- [ ] **Step 1: Write `FileEditCard` tests**

Create or replace `src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEditCard } from '../FileEditCard'
import { useFileExplorerStore } from '../../file-explorer/store'
import type { FileEditItem } from '../../../../../../types/agent-timeline'

function item(overrides: Partial<FileEditItem> = {}): FileEditItem {
  return {
    type: 'fileEdit',
    id: 'edit-1',
    startedAt: 1,
    endedAt: 2,
    changes: [
      {
        path: 'docs/a.md',
        operation: 'create',
        diff: ['--- /dev/null', '+++ b/docs/a.md', '@@ -0,0 +1 @@', '+# Title'].join('\n'),
        added: 1,
        removed: 0,
      },
    ],
    totalAdded: 1,
    totalRemoved: 0,
    ...overrides,
  }
}

describe('FileEditCard', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({
      openAiChange: vi.fn(),
      openTab: vi.fn(),
    } as never)
  })

  it('renders markdown create as a draft card and opens the created file', () => {
    const openTab = vi.fn()
    useFileExplorerStore.setState({ openTab } as never)

    render(<FileEditCard item={item()} />)

    fireEvent.click(screen.getByRole('button', { name: /open docs\/a.md/i }))
    expect(openTab).toHaveBeenCalledWith('docs/a.md', 'workspace')
  })

  it('opens AI change detail for non-markdown edits', () => {
    const openAiChange = vi.fn()
    useFileExplorerStore.setState({ openAiChange } as never)

    const change = {
      path: 'src/a.ts',
      operation: 'edit' as const,
      diff: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      added: 1,
      removed: 1,
    }

    render(<FileEditCard item={item({ changes: [change], totalAdded: 1, totalRemoved: 1 })} />)

    fireEvent.click(screen.getByRole('button', { name: /open diff for src\/a.ts/i }))
    expect(openAiChange).toHaveBeenCalledWith(change)
  })

  it('uses a compact file list for multi-file changes', () => {
    render(
      <FileEditCard
        item={item({
          changes: [
            { path: 'a.ts', operation: 'edit', diff: '-a\n+b', added: 1, removed: 1 },
            { path: 'b.ts', operation: 'edit', diff: '-c\n+d', added: 1, removed: 1 },
          ],
          totalAdded: 2,
          totalRemoved: 2,
        })}
      />,
    )

    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    expect(screen.queryByText('-a')).not.toBeInTheDocument()
  })
})
```

If import paths differ from existing test conventions, adjust the relative paths to match the folder layout.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx
```

Expected: fail until `FileEditCard` uses new click-through behavior.

- [ ] **Step 3: Implement card behavior**

Modify `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`:

```tsx
import type { FileChange, FileEditItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { FileDiffBlock } from './FileDiffBlock'
import { MarkdownDraftCard } from './MarkdownDraftCard'

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function operationLabel(operation: FileChange['operation']): string {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    case 'edit':
      return 'Edited'
  }
}

function markdownContentFromCreateDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++ '))
    .map((line) => line.slice(1))
    .join('\n')
}

export function FileEditCard({ item }: { item: FileEditItem }) {
  const isRunning = !item.endedAt
  const openAiChange = useFileExplorerStore((state) => state.openAiChange)
  const openTab = useFileExplorerStore((state) => state.openTab)

  if (
    item.changes.length === 1 &&
    item.changes[0].operation === 'create' &&
    isMarkdownPath(item.changes[0].path)
  ) {
    const change = item.changes[0]
    return (
      <MarkdownDraftCard
        path={change.path}
        content={markdownContentFromCreateDiff(change.diff)}
        status={isRunning ? 'streaming' : 'created'}
        onOpen={(path) => void openTab(path, 'workspace')}
      />
    )
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/70">
      <div className="flex items-center gap-2 border-b border-zinc-800/70 px-2.5 py-1.5 text-[11px] text-zinc-300">
        {isRunning && <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />}
        <span className="font-medium text-zinc-100">
          {isRunning ? 'Applying changes...' : `${item.changes.length} file${item.changes.length === 1 ? '' : 's'} changed`}
        </span>
        <span className="ml-auto text-emerald-300">+{item.totalAdded}</span>
        <span className="text-red-300">-{item.totalRemoved}</span>
      </div>

      {item.changes.length > 1 ? (
        <div className="divide-y divide-zinc-800/70">
          {item.changes.map((change) => (
            <button
              key={`${change.operation}:${change.path}`}
              type="button"
              aria-label={`Open diff for ${change.path}`}
              onClick={() => void openAiChange(change)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-zinc-300 transition hover:bg-cyan-500/5"
            >
              <span className="w-14 shrink-0 text-cyan-200/70">{operationLabel(change.operation)}</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>{change.path}</span>
              <span className="text-emerald-300">+{change.added}</span>
              <span className="text-red-300">-{change.removed}</span>
            </button>
          ))}
        </div>
      ) : (
        item.changes.map((change) => (
          <div key={`${change.operation}:${change.path}`} className="p-1.5">
            <button
              type="button"
              aria-label={`Open diff for ${change.path}`}
              onClick={() => void openAiChange(change)}
              className="mb-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] text-zinc-300 hover:bg-cyan-500/5"
            >
              <span className="text-cyan-200/70">{operationLabel(change.operation)}</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>{change.path}</span>
              <span className="text-emerald-300">+{change.added}</span>
              <span className="text-red-300">-{change.removed}</span>
            </button>
            <FileDiffBlock change={change} />
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run `FileEditCard` tests**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx
```

Expected: all tests pass. If existing tests require old expand/collapse behavior, update them to the new approved behavior.

---

### Task 7: Focused Integration Checks

**Files:**
- No new files unless tests need small fixtures.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run \
  src/renderer/src/features/agent-chat/diff/__tests__/parseUnifiedDiff.test.ts \
  src/renderer/src/features/agent-chat/cards/__tests__/MarkdownDraftCard.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/FileDiffBlock.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/FileEditCard.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/openAiChange.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run lints for touched files**

Use the IDE lints tool or run TypeScript:

```bash
npx tsc --noEmit
```

Expected: no new errors in:

- `src/renderer/src/features/agent-chat/diff/parseUnifiedDiff.ts`
- `src/renderer/src/features/agent-chat/cards/MarkdownDraftCard.tsx`
- `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`
- `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
- `src/renderer/src/features/file-explorer/AiChangeViewer.tsx`
- `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`
- `src/renderer/src/features/file-explorer/store.ts`
- `src/renderer/src/features/file-explorer/types.ts`

Existing unrelated repository-wide TypeScript failures should be noted, not fixed in this plan.

- [ ] **Step 3: Manual smoke test in dev**

Run:

```bash
npm run dev
```

Manual checks:

1. Trigger an agent response that creates a markdown file.
2. Confirm chat shows a markdown draft card.
3. Click the draft card after completion.
4. Confirm the file explorer opens the created markdown file.
5. Trigger an agent edit to a non-markdown file.
6. Confirm chat shows a compact red/green diff.
7. Click the diff.
8. Confirm file explorer opens an AI change tab with side-by-side diff.
9. Trigger or mock a multi-file file edit item.
10. Confirm chat shows a compact file list and each row opens its own detail tab.

---

## Self-Review

Spec coverage:

- Markdown draft card: Task 5 and Task 6.
- Renderer-derived v1 behavior: Task 6.
- Unified diff parsing: Task 1.
- Red/green compact chat diff: Task 4 and Task 6.
- Side-by-side file detail: Task 2 and Task 3.
- `FileTab` compatibility: Task 2.
- Multi-file behavior: Task 6.
- Testing: Tasks 1, 2, 4, 5, 6, 7.

Placeholder scan:

- No TBD/TODO/fill-later placeholders.

Type consistency:

- `FileChange` is imported from `types/agent-timeline`.
- `FileTabKind` is extended with `'ai-change'`.
- Store action is consistently named `openAiChange(change)`.
- `AiChangeViewer` reads `tab.aiChange`.

