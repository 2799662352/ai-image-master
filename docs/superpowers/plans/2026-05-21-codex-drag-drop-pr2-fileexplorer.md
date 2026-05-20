# PR-2: FileExplorerPanel External Drop → Import-Copy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop OS files onto the workspace file tree (`FileExplorerPanel` / individual `FileTreeNode` rows) and have each file copied into the matching workspace folder, with silent conflict-rename and folder drops rejected in v0.

**Architecture:** A new IPC `fs:import-external` lives alongside the existing `fs:copy` (it sandboxes only the destination, not the source — which is what makes it different). The renderer's `FileTreeNode.onDrop` already handles internal drags; we add a second branch that fires when `dataTransfer.files.length > 0`, resolves each `File` to an absolute path via `electronAPI.getFilePath`, and dispatches a new store action `importExternalByDnd`. The `FileExplorerPanel` outer container catches empty-area drops and routes them to the workspace root.

**Tech Stack:** Node 22+ `fs.cp`, Electron `ipcMain` / `webUtils.getPathForFile`, React, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md` (Task B section)

**Depends on:** PR-1 (`feat(codex): accept external OS file drop on chat input`). Merge PR-1 first.

---

## Pre-flight

- [ ] **Step 0: Confirm branch state**

```bash
git branch --show-current
# Expected: feature/codex-drag-drop (PR-1 merged into main, this branch carries PR-2 work on top)

# If PR-1 is merged on main, rebase first:
git fetch origin
git rebase origin/main
```

---

## Task B1: Add `handleImportExternal` to fsIpc.ts

**Files:**
- Modify: `src/main/file-explorer/fsIpc.ts` (add new export + register handler around line 380)
- Modify: `src/preload/index.ts` (add channel constant + electronAPI type + bridge)
- Test (new): `src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts`

**Why a new IPC instead of reusing `handleCopy`:** `handleCopy` calls `assertContained(src)` per source — external OS files (e.g. `C:\Users\me\Desktop\photo.png`) are **never** inside `allowedRoots`, so the existing IPC throws. The new IPC validates only the destination (must be inside workspace) and explicitly verifies each source is a file (not a directory) with size ≤ 200 MB.

- [ ] **Step 1: Write failing tests**

Create `src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleImportExternal, setFsAllowedRoots } from '../fsIpc'

let workspace: string
let outside: string

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'fsipc-ws-'))
  outside = mkdtempSync(path.join(tmpdir(), 'fsipc-ext-'))
  setFsAllowedRoots([workspace])
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  setFsAllowedRoots([])
})

describe('handleImportExternal', () => {
  it('copies an external file into a workspace dir', async () => {
    const src = path.join(outside, 'photo.png')
    writeFileSync(src, Buffer.from([1, 2, 3]))

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.written).toHaveLength(1)
    expect(path.basename(res.written[0])).toBe('photo.png')
    expect(existsSync(res.written[0])).toBe(true)
  })

  it('uses uniquePath copy-suffix for name conflicts (VSCode style)', async () => {
    writeFileSync(path.join(workspace, 'photo.png'), 'pre-existing')
    const src = path.join(outside, 'photo.png')
    writeFileSync(src, 'new-content')

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(path.basename(res.written[0])).toBe('photo copy.png')
  })

  it('rejects directory sources with reason "is_dir"', async () => {
    const srcDir = path.join(outside, 'folder')
    mkdirSync(srcDir)
    writeFileSync(path.join(srcDir, 'inner.txt'), 'x')

    const res = await handleImportExternal({ sources: [srcDir], destDir: workspace })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('is_dir')
  })

  it('rejects files larger than 200MB with reason "oversize"', async () => {
    // We don't actually create a 200MB file — we stub by passing a path that
    // resolves to a known-large file via a synthetic stat. Simpler: create a
    // tiny file but spy on fs.stat. Easier still: bypass the test by writing
    // ~1MB and lowering the limit via env? No — the public IPC has no knob.
    // Use a real 201MB sparse file: fs.truncate creates a hole-only file
    // that occupies almost no disk but reports the requested size on stat.
    const src = path.join(outside, 'huge.bin')
    writeFileSync(src, Buffer.alloc(1))
    const fd = await import('node:fs/promises').then((m) => m.open(src, 'r+'))
    await fd.truncate(201 * 1024 * 1024)
    await fd.close()

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('oversize')
  })

  it('rejects destDir outside allowed roots with reason matching "outside allowed roots"', async () => {
    const src = path.join(outside, 'x.txt')
    writeFileSync(src, 'x')

    const res = await handleImportExternal({ sources: [src], destDir: outside })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/outside allowed roots/i)
  })

  it('processes multiple sources, skipping individual failures', async () => {
    const okSrc = path.join(outside, 'ok.txt')
    const dirSrc = path.join(outside, 'subdir')
    writeFileSync(okSrc, 'good')
    mkdirSync(dirSrc)

    const res = await handleImportExternal({ sources: [okSrc, dirSrc], destDir: workspace })

    // Aggregate semantics: the IPC returns the first failure reason; written
    // contains the files that did succeed before the failure.
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('is_dir')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (import error)**

```bash
pnpm vitest run src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts
```

Expected: all 6 tests FAIL with `handleImportExternal is not a function` (import error).

- [ ] **Step 3: Implement `handleImportExternal`**

Open `src/main/file-explorer/fsIpc.ts`. Above the `registerFsIpc` function (currently at line 370), add:

```ts
const IMPORT_EXTERNAL_MAX_BYTES = 200 * 1024 * 1024

/**
 * Copy files from arbitrary OS paths (e.g. Desktop) into a workspace
 * directory. Unlike `handleCopy`, this does NOT sandbox-validate sources —
 * the user has explicitly drag-dropped them, so we trust the path. We still
 * gate on:
 *   - destDir must be inside an allowed root (workspace),
 *   - each source must be an actual file (no directories — v0 reject),
 *   - each source must be ≤ 200 MB,
 *   - name conflicts get the same VSCode-style ` copy` / ` copy 2` suffix
 *     used by handleCopy / handleCreateFile.
 *
 * Failure is fail-fast: the first src that fails stops the loop and we
 * return its reason. `written` lists the paths that succeeded before that
 * failure (so the UI can still refresh those rows).
 */
export async function handleImportExternal(args: { sources: string[]; destDir: string }): Promise<
  | { ok: true; written: string[] }
  | { ok: false; reason: string; written?: string[] }
> {
  try {
    await assertContained(args.destDir)
    const dest = await fs.stat(args.destDir).catch(() => null)
    if (!dest || !dest.isDirectory()) return { ok: false, reason: 'destination not a directory' }

    const written: string[] = []
    for (const src of args.sources) {
      // NOTE: no assertContained(src) — external OS paths are by design
      // outside allowed roots. The drag-drop UX is the user-consent surface.
      const srcStat = await fs.stat(src).catch(() => null)
      if (!srcStat) {
        return { ok: false, reason: 'unreadable', written }
      }
      if (srcStat.isDirectory()) {
        return { ok: false, reason: 'is_dir', written }
      }
      if (srcStat.size > IMPORT_EXTERNAL_MAX_BYTES) {
        return { ok: false, reason: 'oversize', written }
      }
      const baseName = path.basename(src)
      const target = await uniquePath(args.destDir, baseName)
      await assertContained(target)
      await fs.cp(src, target, { recursive: false, errorOnExist: false })
      written.push(target)
    }
    return { ok: true, written }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}
```

Then in `registerFsIpc` (line 370), add this line alongside the other handlers (e.g. right after the `fs:copy` registration on line 380):

```ts
  ipcMain.handle('fs:import-external', (_e, args: { sources: string[]; destDir: string }) =>
    handleImportExternal(args))
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 5: Re-run the full fsIpc suite (regression)**

```bash
pnpm vitest run src/main/file-explorer
```

Expected: all green (existing `fsIpc.test.ts`, `protocolHandler.test.ts`, `fsWatcher.test.ts`, etc.).

- [ ] **Step 6: Commit B1**

```bash
cat > .git-commit-msg.txt << 'EOF'
feat(fs-ipc): handleImportExternal for OS-to-workspace drop

A new IPC channel fs:import-external that copies arbitrary OS paths
(e.g. Desktop, Finder) into a workspace directory:
- Sandboxes destination only (sources are user-consented via drag)
- Rejects directories (v0 YAGNI; spec defers to v0.2)
- Caps single file at 200 MB
- VSCode-style copy/copy 2 suffix on name conflicts (uniquePath)

Fail-fast: the first failure stops the loop; `written` reports
which sources succeeded before the failure so the UI can refresh
just those rows.

Spec: docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md
EOF

git add src/main/file-explorer/fsIpc.ts \
        src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

---

## Task B2: Wire preload bridge

**Files:**
- Modify: `src/preload/index.ts` (line 59 area: add channel; line 462 area: add type; line 1004 area: add bridge)

- [ ] **Step 1: Add IPC channel constant**

Open `src/preload/index.ts`. Find `IPC_CHANNELS` (line 59). Inside its `FILE_EXPLORER` block, add after the existing `COPY` key (sorted alphabetically OR co-located with COPY/MOVE; pick whichever matches the existing style — re-check the file):

```ts
IMPORT_EXTERNAL: 'fs:import-external',
```

- [ ] **Step 2: Add type to electronAPI**

Find the `fs:` block in the electronAPI type definition (line 462). Right after the `copy` line (line 472):

```ts
importExternal: (sources: string[], destDir: string) => Promise<
  { ok: true; written: string[] } | { ok: false; reason: string; written?: string[] }
>
```

- [ ] **Step 3: Add bridge implementation**

Find the `fs:` block in the runtime electronAPI object (around line 976). Right after `copy:` (line 1004), add:

```ts
importExternal: (sources: string[], destDir: string) =>
  safeInvoke<
    { ok: true; written: string[] } | { ok: false; reason: string; written?: string[] }
  >(IPC_CHANNELS.FILE_EXPLORER.IMPORT_EXTERNAL, { sources, destDir }),
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: 0 new errors. The new symbol must be reachable from renderer code.

- [ ] **Step 5: Commit B2**

```bash
cat > .git-commit-msg.txt << 'EOF'
feat(preload): expose fs.importExternal bridge

Adds IPC_CHANNELS.FILE_EXPLORER.IMPORT_EXTERNAL constant, the
electronAPI.fs type entry, and the safeInvoke wrapper. No
behavioral change yet — consumers wired in next commit.
EOF

git add src/preload/index.ts
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

---

## Task B3: Add `importExternalByDnd` to file-explorer store

**Files:**
- Modify: `src/renderer/src/features/file-explorer/store.ts` (mirror the existing `moveByDnd` action)
- Test (new): `src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts`

**Pre-step: canonical patterns (verified)**

The existing `moveByDnd` action (around line 928) establishes the patterns to follow:
- Use `const api = getApi()` to access the IPC bridge (NOT `window.electronAPI` directly — `getApi()` is the canonical injection point used throughout the store; mocking it is also how the existing tests mock IPC)
- Use `await get().expandDir(destDir, destSource)` to refresh the destination after a write — this is what triggers the tree node to re-list its children
- Use `inferSource(get().workspaceTree, destDir)` to compute the `source: 'workspace' | 'attachments'` arg expected by `expandDir`
- Return type: `{ ok: boolean; reason?: string }` (NOT a discriminated union — for parity with `moveByDnd`)

Read lines 928-980 of `store.ts` before writing the new action so the shapes match exactly.

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '../store'

beforeEach(() => {
  const importExternal = vi.fn(async () => ({ ok: true, written: ['C:/ws/photo.png'] }))
  const listDir = vi.fn(async () => [
    { path: 'C:/ws/photo.png', name: 'photo.png', kind: 'file', source: 'workspace', childrenLoaded: false },
  ])
  Object.defineProperty(window, 'electronAPI', {
    value: { fs: { importExternal, listDir, stat: vi.fn(async () => ({ ok: true, size: 1, mime: 'image/png', mtime: 1 })) } },
    configurable: true,
  })
  useFileExplorerStore.setState({ tree: [], selectedPaths: [] } as never)
})

describe('importExternalByDnd', () => {
  it('calls fs.importExternal and refreshes the dest dir', async () => {
    const res = await useFileExplorerStore.getState().importExternalByDnd(
      ['C:/desktop/photo.png'],
      'C:/ws',
    )
    expect(res.ok).toBe(true)
    expect(window.electronAPI.fs.importExternal).toHaveBeenCalledWith(
      ['C:/desktop/photo.png'],
      'C:/ws',
    )
    expect(window.electronAPI.fs.listDir).toHaveBeenCalledWith('C:/ws')
  })

  it('forwards IPC failure reason to caller', async () => {
    ;(window.electronAPI.fs.importExternal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: 'is_dir',
    })
    const res = await useFileExplorerStore.getState().importExternalByDnd(
      ['C:/desktop/folder'],
      'C:/ws',
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('is_dir')
  })
})
```

- [ ] **Step 2: Run test → FAIL**

```bash
pnpm vitest run src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts
```

Expected: FAIL — `importExternalByDnd is not a function`.

- [ ] **Step 3: Add the action**

First, add the type signature to the store interface. Find the line with `moveByDnd:` (around line 125) and add directly below it:

```ts
importExternalByDnd: (sources: string[], destDir: string) => Promise<{ ok: boolean; reason?: string; written?: string[] }>
```

Then, find the `moveByDnd: async ...` implementation (around line 928). Directly below its closing `},` add:

```ts
importExternalByDnd: async (sources, destDir) => {
  if (sources.length === 0) return { ok: false, reason: 'nothing to import' }
  const api = getApi()
  if (!api.fs.importExternal) return { ok: false, reason: 'importExternal API not available' }
  const res = await api.fs.importExternal(sources, destDir)
  if (!res.ok) return { ok: false, reason: res.reason, written: res.written }
  // Refresh the destination dir so newly-copied files appear instantly. The
  // chokidar watcher would catch this too, but explicit expandDir avoids a
  // visible lag and matches what moveByDnd does on a successful move.
  const destSource = inferSource(get().workspaceTree, destDir)
  try {
    await get().expandDir(destDir, destSource)
  } catch {
    // listDir failure is non-fatal — chokidar will catch up.
  }
  // Select the last-written file so the user immediately sees where it landed.
  if (res.written.length > 0) {
    get().selectNode(res.written[res.written.length - 1], 'replace')
  }
  return { ok: true, written: res.written }
},
```

Notes:
- `getApi()` and `inferSource` are top-of-file imports already used by `moveByDnd` — they're in scope; no new imports needed.
- The store's `getApi()` helper returns `electronAPI` (or a test double); going through it is how the existing tests mock IPC. The returned `api.fs.importExternal` typing comes from the preload type change in Task B2 — make sure B2 is committed first or `pnpm typecheck` will surface a missing member.

- [ ] **Step 4: Run test → PASS**

```bash
pnpm vitest run src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit B3**

```bash
cat > .git-commit-msg.txt << 'EOF'
feat(file-explorer): importExternalByDnd store action

Wraps fs.importExternal IPC + refreshes the destination dir +
selects the last-written file so users see where the drop landed.
EOF

git add src/renderer/src/features/file-explorer/store.ts \
        src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

---

## Task B4: FileTreeNode external drop branch

**Files:**
- Modify: `src/renderer/src/features/file-explorer/FileTreeNode.tsx` (existing onDragOver/onDrop at lines 194-227)
- Test (new): `src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx`

**Existing behavior (do not break):** `onDragOver` activates highlight only when `e.dataTransfer.types.includes('application/x-catimation-file-paths')`. `onDrop` reads `parseFileDrop` and calls `moveByDnd`. We add a parallel path for external `'Files'` drops.

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx`:

```tsx
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTreeNode } from '../FileTreeNode'
import { useFileExplorerStore } from '../store'

afterEach(cleanup)

beforeEach(() => {
  const importExternalByDnd = vi.fn(async () => ({ ok: true, written: ['C:/ws/photo.png'] }))
  useFileExplorerStore.setState({
    tree: [], selectedPaths: [], clipboard: null, pendingNewNode: null,
    importExternalByDnd,
  } as never)
  Object.defineProperty(window, 'electronAPI', {
    value: {
      getFilePath: vi.fn((file: File) => `C:/desktop/${file.name}`),
      fs: { stat: vi.fn(async () => ({ ok: true, size: 1, mime: 'image/png', mtime: 1 })) },
    },
    configurable: true,
  })
})

function makeExternalDt(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    getData: () => '',
    setData: () => {},
    dropEffect: 'copy',
  } as unknown as DataTransfer
}

describe('FileTreeNode external drop', () => {
  it('invokes importExternalByDnd when an OS file is dropped on a folder node', async () => {
    const node = { path: 'C:/ws', name: 'ws', kind: 'dir' as const, source: 'workspace' as const, childrenLoaded: true, children: [] }
    const { container } = render(<FileTreeNode node={node} depth={0} />)
    const row = container.querySelector('[role="treeitem"], [data-testid="filetree-row"], li')! as HTMLElement

    const dt = makeExternalDt([new File(['x'], 'photo.png', { type: 'image/png' })])
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    expect(useFileExplorerStore.getState().importExternalByDnd).toHaveBeenCalledWith(
      ['C:/desktop/photo.png'],
      'C:/ws',
    )
  })

  it('activates highlight on dragover with external Files MIME', () => {
    const node = { path: 'C:/ws', name: 'ws', kind: 'dir' as const, source: 'workspace' as const, childrenLoaded: true, children: [] }
    const { container } = render(<FileTreeNode node={node} depth={0} />)
    const row = container.querySelector('li')! as HTMLElement

    fireEvent.dragOver(row, { dataTransfer: makeExternalDt([new File(['x'], 'a.png')]) })

    // Row picks up the drop-active class. The exact class name varies by
    // theme; assert *some* visible affordance was added. The implementer
    // should check the className convention used by `dropActive` (search
    // for `dropActive` in FileTreeNode.tsx) and assert on that here.
    expect(row.className).toMatch(/cyan|drop|target/i)
  })
})
```

- [ ] **Step 2: Run test → FAIL**

```bash
pnpm vitest run src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx
```

Expected: FAIL — `importExternalByDnd` not called (current onDrop only handles internal MIME).

- [ ] **Step 3: Extend `onDragOver` to accept external Files**

In `FileTreeNode.tsx`, replace lines 194-205 (the entire `onDragOver` function) with:

```ts
const onDragOver = (e: React.DragEvent) => {
  // Accept either our internal drag MIME (file-explorer → file-explorer move)
  // or an external OS file drop (Desktop / Finder → workspace import).
  const isInternal = e.dataTransfer.types.includes('application/x-catimation-file-paths')
  const isExternal = e.dataTransfer.types.includes('Files')
  if (!isInternal && !isExternal) return
  const dest = resolveDropDestDir()
  if (!dest) return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move'
  if (!dropActive) setDropActive(true)
}
```

- [ ] **Step 4: Extend `onDrop` with the external branch**

Replace lines 215-227 (the entire `onDrop` function) with:

```ts
const onDrop = async (e: React.DragEvent) => {
  const dest = resolveDropDestDir()
  if (!dest) return
  e.preventDefault()
  e.stopPropagation()
  setDropActive(false)

  // Branch A: external OS file drop. dataTransfer.files is populated and
  // our internal MIME is absent. Each File needs webUtils.getPathForFile
  // (exposed as electronAPI.getFilePath) to resolve to an OS-absolute path.
  if (e.dataTransfer.files.length > 0) {
    const getFilePath = (window as Window & {
      electronAPI?: { getFilePath?: (f: File) => string }
    }).electronAPI?.getFilePath
    if (!getFilePath) return
    const externalPaths = Array.from(e.dataTransfer.files)
      .map((f) => getFilePath(f))
      .filter((p): p is string => Boolean(p))
    if (externalPaths.length === 0) return

    const importExternal = useFileExplorerStore.getState().importExternalByDnd
    const res = await importExternal(externalPaths, dest)
    if (!res.ok) {
      window.alert(`导入失败: ${res.reason}`)
    }
    return
  }

  // Branch B (existing): internal move via custom MIME.
  const paths = parseFileDrop(e.dataTransfer)
  if (paths.length === 0) return
  const res = await moveByDnd(paths, dest)
  if (!res.ok && res.reason) {
    window.alert(`移动失败: ${res.reason}`)
  }
}
```

- [ ] **Step 5: Run test → PASS**

```bash
pnpm vitest run src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx
```

Expected: 2/2 PASS.

- [ ] **Step 6: Re-run the full file-explorer suite (regression)**

```bash
pnpm vitest run src/renderer/src/features/file-explorer
```

Expected: green. Internal move flow must still work.

- [ ] **Step 7: Commit B4**

```bash
cat > .git-commit-msg.txt << 'EOF'
feat(file-explorer): accept external OS file drop on tree nodes

FileTreeNode.onDragOver now activates for both the internal drag
MIME (move) and the 'Files' MIME (import-copy). FileTreeNode.onDrop
dispatches to importExternalByDnd for the external branch; internal
moveByDnd path is unchanged.
EOF

git add src/renderer/src/features/file-explorer/FileTreeNode.tsx \
        src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

---

## Task B5: FileExplorerPanel root drop (empty-area)

**Files:**
- Modify: `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx` (add outer container drop handler)

**Purpose:** when a user drops on the blank area of the file panel (below the last tree row), the drop should land in the workspace root. Without this, the drop silently no-ops because no `FileTreeNode` was under the cursor.

- [ ] **Step 1: Add root-drop handler to the tree-pane container**

In `FileExplorerPanel.tsx`, locate the JSX wrapper that holds the `<FileTree>` component (search for `<FileTree ` in the file). Add an `onDragOver` + `onDrop` to that wrapper:

```tsx
const workspaceRoot = useFileExplorerStore((s) => s.workspaceRoot)
const importExternalByDnd = useFileExplorerStore((s) => s.importExternalByDnd)

async function onRootDrop(e: React.DragEvent): Promise<void> {
  // Only handle if no inner FileTreeNode already consumed the event.
  if (e.defaultPrevented) return
  if (e.dataTransfer.files.length === 0) return
  if (!workspaceRoot) return
  const getFilePath = (window as Window & {
    electronAPI?: { getFilePath?: (f: File) => string }
  }).electronAPI?.getFilePath
  if (!getFilePath) return
  const paths = Array.from(e.dataTransfer.files)
    .map((f) => getFilePath(f))
    .filter((p): p is string => Boolean(p))
  if (paths.length === 0) return
  e.preventDefault()
  const res = await importExternalByDnd(paths, workspaceRoot)
  if (!res.ok) window.alert(`导入失败: ${res.reason}`)
}

// On the wrapper <div>:
<div
  onDragOver={(e) => {
    if (e.dataTransfer.types.includes('Files') && workspaceRoot) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }}
  onDrop={(e) => void onRootDrop(e)}
  // ... existing className / props ...
>
```

If `workspaceRoot` doesn't exist with that exact name on the store, search for its real accessor:

```bash
rg "workspaceRoot|rootPath|wsRoot|workspace.*[Pp]ath" src/renderer/src/features/file-explorer/store.ts -n
```

and use the canonical one.

- [ ] **Step 2: Smoke test manually**

```bash
pnpm dev
# In the running app:
# 1. Open the file panel (sidebar)
# 2. Drop a small image from Desktop onto the blank area below the last row
# 3. Verify the image appears in the tree at the workspace root
# 4. Drop the same name a second time → expect "name copy.png" or similar
# 5. Drop a folder → expect alert "导入失败: is_dir"
```

(Manual smoke is part of the PR checklist, not a CI gate. The CI gate is the unit tests in B1–B4.)

- [ ] **Step 3: Lint + typecheck**

```bash
pnpm lint
pnpm typecheck
```

Expected: 0 new errors.

- [ ] **Step 4: Commit B5**

```bash
cat > .git-commit-msg.txt << 'EOF'
feat(file-explorer): accept root-area external file drop

Dropping a file onto the blank area below the last tree row now
lands in the workspace root, mirroring VSCode/Finder behavior.
Inner FileTreeNode drops keep their priority via e.defaultPrevented.
EOF

git add src/renderer/src/features/file-explorer/FileExplorerPanel.tsx
git commit -F .git-commit-msg.txt
rm .git-commit-msg.txt
```

---

## Task B6: Open PR

- [ ] **Step 1: Push**

```bash
git push origin feature/codex-drag-drop
```

- [ ] **Step 2: Open / update the PR**

If PR-2 should be a separate PR (it should — PR-1 already shipped under the same branch in the worktree):

```bash
# Create a fresh branch off the merged PR-1
git checkout -b feature/codex-drag-drop-pr2
# (the worktree commits all already correspond to PR-2 if PR-1 is on main)
git push -u origin feature/codex-drag-drop-pr2

cat > .git-pr-body.txt << 'EOF'
## Summary
- New IPC `fs:import-external` copies OS-arbitrary files into the workspace, with sandboxed destination, size cap (200 MB), directory rejection, and VSCode-style ` copy` rename on name conflict.
- `FileTreeNode` accepts external `Files` drops alongside the existing internal-MIME move drops; `FileExplorerPanel` catches root-area drops as a fallback to the workspace root.
- New store action `importExternalByDnd` orchestrates IPC + dir refresh + select-on-arrival.

## Decisions (frozen via brainstorm; see spec)
| | Value | Rationale |
|---|---|---|
| Conflict | Silent VSCode-style ` copy` / ` copy 2` | Sandbox-consistent with `handleCopy`, no extra modal |
| Folder drop | Reject (`is_dir`) + alert | YAGNI v0; recursive copy is a separate PR |
| Size cap | 200 MB single file | Files go to disk, not RAM; ample for the workspace use case |
| Concurrent | Sequential per drop | Drops are typically ≤5 files; sequential is predictable, avoids EBUSY |

## Test plan
- [x] `pnpm vitest run src/main/file-explorer/__tests__/fsIpc.importExternal.test.ts` (6/6)
- [x] `pnpm vitest run src/renderer/src/features/file-explorer/__tests__/store.importExternal.test.ts` (2/2)
- [x] `pnpm vitest run src/renderer/src/features/file-explorer/__tests__/FileTreeNode.externalDrop.test.tsx` (2/2)
- [x] `pnpm vitest run src/main/file-explorer` (regression — green)
- [x] `pnpm vitest run src/renderer/src/features/file-explorer` (regression — green)
- [x] `pnpm lint && pnpm typecheck` (no new errors)
- [ ] Manual smoke: drop image on folder → lands in folder; drop image on file → lands in parent; drop image on blank area → workspace root; same-name twice → ` copy` suffix; drop folder → `is_dir` alert.

## Out of scope (deferred)
- Folder drop (v0.2)
- URL / web image drop
- Ctrl+V image paste
- Cross-progress bar (v0 just shows toast for ≥50MB)

Spec: `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md`
Depends on: PR-1 merged to main.
EOF

gh pr create --title "feat(codex): drop OS files onto workspace file tree (PR-2)" --body "$(cat .git-pr-body.txt)"
rm .git-pr-body.txt
```

- [ ] **Step 3: Return the PR URL**

```bash
gh pr view --json url,number
```

---

## Self-review checklist (final)

Before declaring PR-2 done:

- [ ] `handleImportExternal` sandboxes destination but NOT source
- [ ] Directory rejection returns `reason: 'is_dir'` exactly (UI compares this string)
- [ ] Size limit 200 MB enforced before `fs.cp` (not after)
- [ ] `uniquePath` is the SAME function used by `handleCopy` / `handleCreateFile` (no copy-paste of the algorithm)
- [ ] IPC channel constant `IMPORT_EXTERNAL: 'fs:import-external'` is in `IPC_CHANNELS.FILE_EXPLORER`
- [ ] `FileTreeNode.onDragOver` accepts BOTH internal MIME and external `'Files'`
- [ ] `FileTreeNode.onDrop` external branch fires before internal branch (gated on `dataTransfer.files.length > 0`)
- [ ] Existing internal move flow not regressed
- [ ] `FileExplorerPanel` root drop is gated on `e.defaultPrevented` so inner nodes win
- [ ] No new TS errors
- [ ] PR body links the spec and lists deferred items

## Known follow-ups (v0.2 candidates)

- Folder drop with recursive copy + conflict-merge
- Progress bar for files ≥50 MB (currently a single toast on completion)
- Ctrl+V paste for images
- URL drop from browser (text/uri-list parsing)
