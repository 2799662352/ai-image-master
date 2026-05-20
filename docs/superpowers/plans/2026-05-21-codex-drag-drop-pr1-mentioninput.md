# PR-1: MentionInput External Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop OS files (from Desktop / Finder / Windows Explorer) onto the Codex chat input and have each file appear as a path-only attachment + reference chip — same UX as the existing internal-drag-from-file-explorer path, just with `dataTransfer.files` as the source.

**Architecture:** Add a Tier 3 fallback inside `MentionInput.onDrop` — after the existing Tier 1 (`parseQuoteDrop`) and Tier 2 (`parseFileDrop` for internal `application/x-catimation-file-paths` MIME), check `event.dataTransfer.files` and resolve each `File` to its OS path via `electronAPI.getFilePath` (already wired through Electron's `webUtils.getPathForFile`). All downstream logic (quota, stat, `addAttachment`, `addPendingReference`, `setError` with skip reasons) is reused unchanged.

**Tech Stack:** React, TypeScript, Vitest + @testing-library/react, Electron 32+ `webUtils.getPathForFile` (already exposed on preload).

**Spec:** `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md` (Task A section)

---

## Pre-flight

- [ ] **Step 0: Confirm branch and worktree**

Run:
```bash
git branch --show-current
# Expected: feature/codex-drag-drop

git log --oneline -2
# Expected:
#   c8640b8 docs(specs): codex drag-drop design (Task A + Task B)
#   9693a12 perf(ui): tab switch latency + history virtualization ... (#13)
```

---

## Task A1: External OS file drop on MentionInput

**Files:**
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx` (the `onDrop` function around line 762)
- Test (new): `src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx`

**Background — what already exists** (do not re-implement):

`MentionInput.onDrop` (line 762) already does:
1. `parseQuoteDrop` → append to input
2. `parseFileDrop` (reads internal MIME `application/x-catimation-file-paths`) → returns `paths: string[]`
3. For each path: `fsApi.stat` → quota check → `addAttachment` + `addPendingReference`

`window.electronAPI.getFilePath(file: File): string` is implemented in `src/preload/index.ts:1119` via `webUtils.getPathForFile`. It returns `""` for synthetic File objects (e.g. clipboard paste); we treat empty as unavailable.

**The gap:** when an OS file is dragged in, `event.dataTransfer.types` includes `'Files'` (not the internal MIME). `parseFileDrop` returns `[]`, the function silently returns, and the user sees nothing.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

type TestElectronAPI = {
  agent: { sendMessage: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
  fs: { stat: ReturnType<typeof vi.fn> }
  getFilePath: ReturnType<typeof vi.fn>
}

// jsdom's DataTransfer constructor doesn't carry `files`, so we build a
// minimal stand-in that mirrors what Electron hands us on a real OS drop:
// `types` includes 'Files', `files` is a FileList-like with N File objects,
// and `getData(_anyType_)` returns '' so existing parseQuoteDrop /
// parseFileDrop short-circuit and we fall through to Tier 3.
function makeExternalFileTransfer(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    getData: () => '',
    setData: () => {},
  } as unknown as DataTransfer
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: {
        stat: vi.fn(async () => ({ ok: true, size: 42, mime: 'image/png', mtime: 1 })),
      },
      // Real preload: webUtils.getPathForFile. We mimic per-file mapping.
      getFilePath: vi.fn((file: File) => `D:/desktop/${file.name}`),
    },
    configurable: true,
  })
  useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
})

describe('MentionInput external OS file drop', () => {
  it('adds attachment + pending reference for each externally dropped file', async () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeExternalFileTransfer([
      new File(['a'], 'photo.png', { type: 'image/png' }),
      new File(['b'], 'note.md', { type: 'text/markdown' }),
    ])
    fireEvent.drop(textarea, { dataTransfer: dt })

    // onDrop is async (awaits fs.stat); flush microtasks
    await new Promise((r) => setTimeout(r, 0))

    const paths = useAgentChatStore.getState().attachments.map((a) => a.path)
    expect(paths).toEqual(['D:/desktop/photo.png', 'D:/desktop/note.md'])
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(2)
  })

  it('ignores files when getFilePath returns "" (synthetic File from clipboard)', async () => {
    const api = (window as unknown as { electronAPI: TestElectronAPI }).electronAPI
    api.getFilePath.mockImplementation(() => '')
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeExternalFileTransfer([new File(['x'], 'pasted.png', { type: 'image/png' })])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    expect(useAgentChatStore.getState().attachments).toEqual([])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('does not trigger Tier 3 when internal MIME is present (regression guard)', async () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // Simulate an internal drag: types includes our internal MIME and files is empty.
    const dt = {
      types: ['application/x-catimation-file-paths'],
      files: [] as unknown as FileList,
      getData: (t: string) =>
        t === 'application/x-catimation-file-paths' ? JSON.stringify(['D:/repo/main.ts']) : '',
      setData: () => {},
    } as unknown as DataTransfer
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    // Tier 2 path used: 1 attachment, getFilePath never called.
    const api = (window as unknown as { electronAPI: TestElectronAPI }).electronAPI
    expect(api.getFilePath).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().attachments.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx
```

Expected:
- Test 1 FAILS — paths array is empty (`expected ['D:/desktop/photo.png', 'D:/desktop/note.md'] to equal []`)
- Test 2 PASSES (already correct: no path → no attachment)
- Test 3 PASSES (existing Tier 2 behavior)

This confirms the gap is precisely external-file-drop, not internal drag.

- [ ] **Step 3: Implement Tier 3 in `onDrop`**

Open `src/renderer/src/features/agent-chat/MentionInput.tsx`. Find the function starting at line 762:

```ts
async function onDrop(event: React.DragEvent): Promise<void> {
  event.preventDefault()
  const quote = parseQuoteDrop(event.dataTransfer)
  if (quote) {
    appendInput(quote)
    return
  }

  const paths = parseFileDrop(event.dataTransfer)
  if (paths.length === 0) return
```

Change to (replace the `const paths = parseFileDrop(...)` line and the early-return):

```ts
async function onDrop(event: React.DragEvent): Promise<void> {
  event.preventDefault()
  const quote = parseQuoteDrop(event.dataTransfer)
  if (quote) {
    appendInput(quote)
    return
  }

  // Tier 2 (existing): internal file-explorer drag with custom MIME.
  let paths = parseFileDrop(event.dataTransfer)

  // Tier 3 (NEW): external OS drop via webUtils.getPathForFile. The internal
  // tier returns [] here because OS drops don't carry our custom MIME; they
  // carry dataTransfer.files instead. Map each File back to its absolute path
  // via preload's getFilePath wrapper (Electron 32+ webUtils API). Synthetic
  // files (e.g. from clipboard paste with no on-disk path) return '' and are
  // filtered out — Ctrl+V image paste is intentionally out of scope for PR-1.
  if (paths.length === 0 && event.dataTransfer.files.length > 0) {
    const getFilePath = (window as Window & {
      electronAPI?: { getFilePath?: (file: File) => string }
    }).electronAPI?.getFilePath
    if (getFilePath) {
      paths = Array.from(event.dataTransfer.files)
        .map((file) => getFilePath(file))
        .filter((p): p is string => Boolean(p))
    }
  }

  if (paths.length === 0) return
```

The downstream `for (const filePath of paths)` loop, quota tracking, `skippedReasons`, `addAttachment`, `addPendingReference`, and `setError` calls (lines 776-817) are unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm vitest run src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Re-run the full agent-chat test suite to confirm no regression**

Run:
```bash
pnpm vitest run src/renderer/src/features/agent-chat
```

Expected: all tests pass, including the pre-existing `MentionInput.reference.test.tsx` (internal drag flow must still work — the Tier 3 branch is gated on `paths.length === 0`, so internal drops never reach it).

- [ ] **Step 6: Lint and typecheck**

Run (in series, abort on first failure):
```bash
pnpm lint
pnpm typecheck
```

Expected: both exit 0. The baseline has ~18 pre-existing TS errors (see PR #13 thread); your change must add **zero** new errors. If `pnpm typecheck` reports more than 18 errors, inspect the diff — the most common cause is the `Window & { electronAPI?... }` cast above being phrased inconsistently with the existing pattern further down `MentionInput.tsx` (line 730). If so, copy that pattern verbatim.

- [ ] **Step 7: Commit**

Use a file-based commit message (PowerShell heredoc-breaks `git commit -m "..."`):

```bash
# Write message to file
cat > .git-commit-msg.txt << 'EOF'
feat(codex): accept external OS file drop on chat input

External files dragged from Desktop/Finder/Explorer now create
path-only attachments + reference chips, identical UX to internal
file-explorer drag. Uses webUtils.getPathForFile via the existing
electronAPI.getFilePath preload bridge — no file bytes touch
renderer memory. Synthetic File objects (clipboard paste) return ''
and are filtered out.

Spec: docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md
EOF

git add src/renderer/src/features/agent-chat/MentionInput.tsx \
        src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

Verify:
```bash
git log --oneline -1
# Expected: <hash> feat(codex): accept external OS file drop on chat input
```

---

## Task A2: Push branch and open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/codex-drag-drop
```

- [ ] **Step 2: Open PR**

```bash
cat > .git-pr-body.txt << 'EOF'
## Summary
- `MentionInput.onDrop` adds a Tier 3 fallback that reads `dataTransfer.files` and resolves each `File` to its absolute path via `electronAPI.getFilePath` (Electron 32+ `webUtils.getPathForFile`, already on preload).
- Net change: ~15 lines + 3 unit tests in `MentionInput.externalDrop.test.tsx`.
- Behavior matches the existing internal drag-from-file-explorer flow: each file becomes a path-only `AgentAttachment` + `AgentReference` chip; no buffer copy, no `structuredClone`.

## Why
External OS drops weren't handled — the existing `onDrop` only read the internal `application/x-catimation-file-paths` MIME and silently returned on `parseFileDrop` empty. Users dropping from Desktop saw no feedback.

## Test plan
- [x] `pnpm vitest run src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx` — 3/3 pass
- [x] `pnpm vitest run src/renderer/src/features/agent-chat` — regression suite green
- [x] `pnpm lint && pnpm typecheck` — no new errors
- [ ] Manual smoke: drag a `.png` from Desktop onto the chat textarea → chip appears + image thumbnail renders

## Out of scope (deferred to PR-2)
- `FileExplorerPanel` accepting drops to import-copy
- Folder drops, URL drops, paste-image

Spec: `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md`
EOF

gh pr create --title "feat(codex): accept external OS file drop on chat input (PR-1)" --body "$(cat .git-pr-body.txt)"
rm .git-pr-body.txt
```

- [ ] **Step 3: Verify PR is open and capture URL**

```bash
gh pr view --json url,number
```

Return the URL so the user can see it.

---

## Self-review checklist (final)

Before declaring PR-1 done, verify each:

- [ ] `MentionInput.onDrop` Tier 3 branch only fires when Tier 1 + Tier 2 both no-op (paths is `[]`)
- [ ] Synthetic File handling preserved (`getFilePath` returns `''` → filtered out)
- [ ] Downstream quota / stat / skip logic untouched
- [ ] No new TS errors vs. baseline
- [ ] Regression test for internal drag still passes
- [ ] PR body links the spec

## Known follow-ups (NOT this PR)

- PR-2: `FileExplorerPanel` drop-to-import (Task B in the spec)
- v0.2: folder drop, URL drop, paste-image
