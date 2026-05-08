# Codex Agent — File Explorer + Attachment Viewer — Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-05-08
**Author:** Cursor agent at user request
**Related:** `2026-05-07-codex-thread-sidebar-and-context-window-design.md` (sibling — same chat panel, separate concern). `2026-05-07-codex-agent-chat-redesign-design.md` (parent design).

## Goal

Add a Cursor/VSCode-style File Explorer panel to the right of the main app (left of the chat panel) that doubles as the unified viewer for everything file-shaped: a real workspace folder the user picks, **and** the historical attachments that were lost on restart. One CodeMirror 6-based viewer covers preview, edit, and conflict-merge for both roots, so a single implementation pass fixes two pre-existing attachment bugs and lands the new feature.

Concretely:

1. **Bug F (regression).** Attachments still on disk after restart but the renderer can't render them. Fix: replace the raw OS path stored in `AttachmentRef.uri` with a `local-file://` URL served by an Electron 30+ `protocol.handle` registration. `<img src>` and the new viewer both use the same URL.
2. **Bug G (missing feature).** Attachments today are read-only chips — no preview-modify-save loop. Fix: route attachments through the same File Explorer `Attachments` root, where they get the same CodeMirror viewer with full edit + Ctrl+S + dirty tracking + external-change detection.
3. **New feature.** A File Explorer panel that points at a real OS folder the user picks, supports drag-and-drop into the chat input, and supports "send selected text as quote block" so users can show the agent specific lines without copy-pasting.

## Non-Goals

- **No multi-workspace.** One Workspace root at a time. Switching folders replaces (not adds) the root. Multi-root would require a workspace tab bar; defer.
- **No git diff / SCM panel.** The CodeMirror `MergeView` is used for conflict resolution, not for viewing git changes.
- **No codebase search / find-in-files.** Future work.
- **No language server / go-to-definition / hover types.** CM6 syntax highlighting only.
- **No minimap.** CM6 doesn't ship one and we won't backfill.
- **No integrated terminal.**
- **No live collaboration.** Single-user, single-renderer.
- **No tree mutation operations.** The user can't rename / create / delete files in the tree (one exception: `Delete` on Attachments root rows, which deletes the `AgentAttachment` row + the file). File creation goes through the OS or the agent's `apply_patch` tool.
- **No path whitelist on the `local-file://` protocol.** Explicit user decision: this is a single-user local dev environment running with `sandbox_mode="danger-full-access"` already; an extra layer of path validation is double-locking. Documented in **Security Notes** with a `// FIXME-prod` comment in the protocol handler so the future productionization pass can add it back.
- **No drag-and-drop reorder of file tabs.** Tabs are append-only with `Cmd+W` close.

## User Story

1. App starts. User opens chat panel. Pre-existing thread sidebar restores most-recent thread (sibling design).
2. User clicks the new file-icon button at the top-left of the chat panel header (or hits `Ctrl/Cmd+Shift+I`). A 240px-wide tree + flex-width viewer slides in to the **left** of the chat panel.
3. The tree shows two top-level roots:
   - **Workspace** — empty state on first run with `[Open folder…]` button. After picking a folder, that becomes the persisted root (localStorage).
   - **Attachments** — auto-populated from `userData/agent/uploads/` joined with the `AgentAttachment` DB table so display names are `originalName` not `<sha>.png`.
4. User clicks `src/foo.ts` in Workspace tree → a new tab opens in the viewer pane. CodeMirror 6 highlights TypeScript syntax.
5. User edits the file. Tab title gets a `●` dot prefix.
6. User hits `Ctrl/Cmd+S`. Dot disappears, file written to disk.
7. The agent (separately) modifies the same file via `apply_patch` while the user has it open and dirty. A modal appears: `[Keep yours] [Use disk] [Show diff]`. "Show diff" opens a CodeMirror `MergeView` (left = disk, right = yours) so the user can pick.
8. User selects 17 lines in `src/foo.ts`. A floating `[Send to chat ⌘L]` button appears above the selection. Clicking it appends a fenced quote block ` ```ts:42-58:src/foo.ts\n…\n``` ` to the chat input. Or the user drags the selection straight into the chat input, same result.
9. User drags `src/foo.ts` (the whole file) onto the chat input. The file is added as an attachment chip (going through the existing `AttachmentService.ingest` path). The chat input gets `[file:src/foo.ts]` appended on a new line.
10. After typing additional prompt text, user presses Enter. Existing prompt-attachment merging logic in `AgentManager.buildPromptWithAttachments` already handles the rest.
11. User restarts the app. The `Attachments` tree root now shows last week's images by their original names. Double-clicking opens them in the same viewer (image preview, not text editor). Lightbox-style zoom is still available via the existing image lightbox component.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer (React + Zustand)                                           │
│                                                                      │
│  features/file-explorer/        features/agent-chat/  (existing)     │
│  ├─ FileExplorerPanel.tsx       ├─ AgentChatPanel.tsx                │
│  ├─ FileTree.tsx                ├─ ThreadSidebar.tsx                 │
│  ├─ FileTreeNode.tsx            ├─ AttachmentChips.tsx               │
│  ├─ FileTabStrip.tsx            ├─ MentionInput.tsx (new drop zone)  │
│  ├─ FileViewer.tsx (CM6)        └─ store.ts                          │
│  ├─ ImageViewer.tsx                       ▲                          │
│  ├─ BinaryViewer.tsx                      │                          │
│  ├─ ConflictModal.tsx                     │ drag/drop bridge         │
│  ├─ SelectionFloatingBar.tsx ─────────────┘                          │
│  ├─ icons.tsx                                                        │
│  └─ store.ts (workspace, tabs, dirty)                                │
└──────────┬───────────────────────────────────────────────────────────┘
           │ IPC + protocol
┌──────────▼───────────────────────────────────────────────────────────┐
│ Main (Electron 41)                                                   │
│                                                                      │
│  src/main/file-explorer/                                             │
│  ├─ protocolHandler.ts ─ protocol.handle('local-file', …)            │
│  │                       + registerSchemesAsPrivileged before ready  │
│  ├─ fsIpc.ts ─ five handlers below                                   │
│  ├─ fsWatcher.ts ─ chokidar Map<path, FSWatcher>                     │
│  └─ AttachmentTreeProvider.ts ─ joins fs scan + AgentAttachment rows │
│                                                                      │
│  IPC channels:                                                       │
│  ├─ fs:read-text      (path) → { content, mtime }                    │
│  ├─ fs:write-text     (path, content) → { mtime }                    │
│  ├─ fs:list-dir       (path) → FileNode[]  (lazy, single level)      │
│  ├─ fs:watch-start    (path) → ()  emits fs:watch-event              │
│  ├─ fs:watch-stop     (path) → ()                                    │
│  ├─ workspace:pick-folder → string | null                            │
│  └─ attachments:list-tree → FileNode[]  (joins DB + uploads dir)     │
│                                                                      │
│  Existing (unchanged behavior, one URI shape change):                │
│  └─ AgentManager.buildUserTimelineItems                              │
│     uri: a.localPath  →  uri: `local-file:///${normalize(localPath)}`│
└──────────────────────────────────────────────────────────────────────┘
```

### Data flow — opening a file

```
User clicks tree node
  → store.openTab(path, source)
    → if path already in `tabs[]` → activate it, done
    → else: ipc.invoke('fs:read-text', path)
       → returns { content, mtime }
    → push new FileTab to store, set activeTabId
    → ipc.invoke('fs:watch-start', path)
       → main creates chokidar watcher, returns
  → React re-renders: FileViewer receives `activeTab`
    → @uiw/react-codemirror mounts with `state` prop populated from EditorState.create({ doc: content, extensions: [...] })
```

### Data flow — saving a file

```
User presses Ctrl/Cmd+S inside CM6
  → CM6 keymap handler → store.saveActiveTab()
    → grab `tabs[activeTabId].state.doc.toString()`
    → ipc.invoke('fs:write-text', { path, content })
      → main writes, returns new mtime
    → store updates: { dirty: false, diskMtime: newMtime }
    → tab strip re-renders (• dot disappears)
```

### Data flow — external change

```
agent's apply_patch tool writes file
  → chokidar emits 'change' on watched path
  → main IPC: 'fs:watch-event' { path, event: 'change', mtime }
  → renderer reducer:
     ├─ if !tab.dirty → ipc.invoke('fs:read-text') → replace state.doc
     │  + show toast "File reloaded from disk"
     └─ if tab.dirty → store.openConflict(path, diskContent)
        → ConflictModal renders three buttons:
           [Keep yours]  → close modal, no action
           [Use disk]    → replace state.doc with diskContent, dirty:false
           [Show diff]   → open MergeView side-by-side, then user picks
```

### Data flow — drag file to chat

```
User drags FileTreeNode into MentionInput drop zone
  → onDrop handler reads dataTransfer.types
    → if includes "application/x-catimation-file-path"
       → const path = dataTransfer.getData("application/x-catimation-file-path")
       → const stat = await ipc.invoke('fs:stat', path)  (light-weight)
       → use existing addAttachmentFromPath flow
         → main: AttachmentService.ingest({ path, name, mime, size })
           → reads file, hashes, writes to userData/agent/uploads/<sha>.<ext>
           → INSERT AgentAttachment row
           → returns AttachmentRef
       → renderer: store.addAttachment(ref)
       → MentionInput appends `\n[file:${ref.name}]` to current input
```

### Data flow — selected text to chat

```
User selects text in CM6
  → CM6 viewport-event listener computes selection bounding rect
  → SelectionFloatingBar mounts at rect.top - 32
    → button: "Send to chat (⌘L)"
  → User clicks (or drags selection into chat input)
    → const { from, to } = view.state.selection.main
    → const text = view.state.sliceDoc(from, to)
    → const fromLine = view.state.doc.lineAt(from).number
    → const toLine = view.state.doc.lineAt(to).number
    → const lang = pathToLangShort(activeTab.path)  // 'ts', 'py', ...
    → quote = "```" + lang + ":" + fromLine + "-" + toLine + ":" + path + "\n" + text + "\n```"
    → store.appendToChatInput(quote)
```

## Data Model

### `FileNode` (renderer + IPC payload)

```ts
type FileNode = {
  path: string                 // OS absolute, normalized to forward slashes for cross-platform consistency
  name: string                 // display name (originalName for attachments, basename for workspace files)
  kind: 'file' | 'dir'
  source: 'workspace' | 'attachments'
  mime?: string                // attachments only; workspace files defer mime to extension
  size?: number                // optional, for sorting / display
  childrenLoaded?: boolean     // false → tree shows expand affordance, click triggers list-dir
  children?: FileNode[]        // populated lazily; absent until expanded
}
```

### `FileTab` (renderer-only)

```ts
type FileTab = {
  id: string                   // crypto.randomUUID()
  path: string                 // OS absolute
  source: 'workspace' | 'attachments'
  kind: 'text' | 'image' | 'pdf' | 'binary'
  state: EditorState | null    // null for non-text tabs
  diskMtime: number            // ms epoch; updated on read + on save
  dirty: boolean               // doc has changes vs diskContent
}
```

### `AgentChatStore` slice (extends existing)

```ts
type FileExplorerSlice = {
  // panel
  fxOpen: boolean
  fxTreeWidth: number          // 200..360, persisted
  // workspace root
  workspaceRoot: string | null // OS absolute, persisted; null = empty state
  // tree state
  workspaceTree: FileNode[]    // top-level only; sub-trees inside .children
  attachmentsTree: FileNode[]
  treeLoading: boolean
  // tabs
  tabs: FileTab[]
  activeTabId: string | null
  // external-change conflict
  conflict: { tabId: string; diskContent: string; show: 'modal' | 'merge' } | null

  // actions
  toggleFx: () => void
  setFxTreeWidth: (w: number) => void
  pickWorkspaceFolder: () => Promise<void>
  openTab: (path: string, source: FileNode['source']) => Promise<void>
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  saveActiveTab: () => Promise<void>
  applyExternalChange: (tabId: string, choice: 'mine' | 'disk') => void
  appendToChatInput: (text: string) => void
}
```

### Schema change

**None.** `AgentAttachment` table already stores everything we need. `AgentManager.buildUserTimelineItems` only changes the format of the URI string written into existing message JSON.

### Backwards compatibility for old messages

Threads created before this PR have `uri` like `D:\Users\27996\AppData\Roaming\…\uploads\abc.png`. New threads will have `uri` like `local-file:///D:/Users/27996/AppData/Roaming/…/uploads/abc.png` (path separators normalized to forward slashes via a single regex replace `localPath.replace(/\\/g, '/')` — the previous draft's `replaceAll('\\\\','/')` only matched literal `\\` substrings in the path, which Windows `localPath` never contains).

The renderer's `<img src>` accepts the new form natively. For backwards compatibility, `AttachmentCard` and `Lightbox` get a 1-line normalizer:

```ts
function toRenderableUri(uri: string): string {
  if (uri.startsWith('local-file://')) return uri
  if (/^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith('/')) {
    // Legacy raw path — wrap.
    return 'local-file:///' + uri.replace(/\\/g, '/')
  }
  return uri // blob:, data:, http(s):, etc — unchanged
}
```

This means **no migration script** is needed. Old threads visually heal on next render.

## Detailed Design

### Section A — Layout + entry points

The chat panel currently lives at `right: 0; width: panelWidth` and the thread sidebar (when open) eats the rightmost `sidebarWidth` from the panel's `right` offset.

The File Explorer panel is **independent** of both. It occupies the rightmost slice of the **main app canvas**, immediately to the left of the chat panel. Concretely:

- **Position:** `position: fixed; top: 0; height: 100vh; right: <panelWidth + (sidebarOpen ? sidebarWidth : 0)>; width: <fxTreeWidth + viewerPaneWidth>`. The viewer pane width is `flex: 1` of the panel itself, so the panel grows as wide as available; if the user wants a narrower panel they shrink the chat panel first. (No separate "full panel width" knob — keeps the resize affordances minimal.)
- When File Explorer is closed: `display: none`. No 24px rail residue.
- The chat panel does **not** shift when File Explorer opens. They're independent overlays. (Reasoning: chat panel is anchored to viewport right; File Explorer is anchored to its left edge of `panelRightOffset`. Both can coexist.)
- **Closing the chat panel auto-closes File Explorer.** Rationale: the persistent toggle button lives in the chat panel header, so a hidden chat panel would orphan the File Explorer with no on-screen way to close it. Reopening the chat panel does **not** auto-restore the File Explorer; user reopens explicitly. The state of `fxOpen` is preserved across this — when the user reopens the chat panel, the File Explorer stays closed because the button has been depressed. Concretely: `useEffect(() => { if (!chatOpen && fxOpen) setFxOpen(false) }, [chatOpen])`.

Entry points (every one of these toggles `fxOpen`):

1. **Persistent button** in the chat panel header, immediately to the left of the existing `Threads` button. Icon: `FileTreeIcon` (folder + small dot tree). Title: `Show files (Ctrl/Cmd+Shift+I)` / `Hide files (Ctrl/Cmd+Shift+I)`.
2. **Keyboard shortcut** `Ctrl/Cmd+Shift+I` registered on `document` while the chat panel is open (consistent with existing `Ctrl/Cmd+B` for the thread sidebar — same gating to avoid stealing global shortcuts).
3. **Close button** inside the File Explorer panel header (same `CloseIcon` styling as chat panel).

Resize handle on the **right edge** of the tree pane (200..360 clamp, persisted to `localStorage` key `agent-chat:fx-tree-width`). The viewer pane fills the rest of the panel.

### Section B — File tree (workspace + attachments)

**Workspace root rendering:**

- `workspaceRoot === null` → show empty state inside the tree pane:
  ```
  [folder icon]
  No folder open
  [Open folder…]
  ```
- `workspaceRoot !== null` → top-level row with the basename of the path; expanding fetches `fs:list-dir` for that folder.

**Attachments root rendering:**

- Always present.
- Top-level row labeled `Attachments` with attachment icon.
- Expanded children are loaded via `attachments:list-tree` IPC, which the main process implements by:
  1. `fs.readdir(uploadsDir)` → list of `<sha>.<ext>` filenames.
  2. `prisma.agentAttachment.findMany({ orderBy: { uploadedAt: 'desc' } })` → metadata.
  3. Outer-join: any attachment row whose `localPath` ends with one of the disk filenames is shown with `name: row.originalName`. Orphan files on disk get `name: filename`. Orphan DB rows (file gone from disk) are **silently filtered from the tree response** — the row stays in the DB and is left to the existing `AttachmentService.cleanup` to harvest. Read paths must not mutate.
  4. Sort by `uploadedAt` desc.

**Tree behavior:**

- Single-click on dir row → expand/collapse (no separate caret zone — whole row is the affordance, easier to click).
- Single-click on file row → `openTab(path, source)`.
- Right-click context menu:
  - Workspace files: `Open` / `Reveal in OS` / `Copy path`.
  - Attachments: `Open` / `Reveal in OS` / `Delete` (deletes both DB row and file with confirm).
- Drag affordance: any file row is draggable. `dragstart` sets `dataTransfer.setData('application/x-catimation-file-path', node.path)` plus a text fallback `dataTransfer.setData('text/plain', node.path)`.

**Lazy loading:**

- Each dir node has `childrenLoaded: false` until expanded.
- On expand → IPC `fs:list-dir(path)` returns immediate children only.
- Subdirectories within those children also start `childrenLoaded: false`. Recursing requires another expand click.
- This means even a workspace pointing at the user's home directory won't kill the renderer.

**Sort order:** dirs first, then files, alphabetical within each group. Hidden files (leading `.`) shown by default (we're a dev-environment tool; users want to see `.env`, `.gitignore`, etc.).

### Section C — Viewer (CodeMirror 6 via @uiw/react-codemirror)

**Tab strip** at the top of the viewer pane:
- Horizontal scrollable list of tab pills.
- Each pill: `[● kind-icon name ✕]` (the `●` only shows when dirty).
- Active tab: cyan accent underline + slightly brighter background.
- Click pill → `setActiveTab(id)`.
- `Cmd+W` / middle-click on pill / click `✕` → `closeTab(id)`. If `dirty` → confirm modal `[Save] [Discard] [Cancel]` then proceed.

**Viewer pane** routes by `activeTab.kind`:
- `text` → `<FileViewer />` (CM6)
- `image` → `<ImageViewer src={'local-file:///' + path} />` (zoom + 1:1 + fit)
- `pdf` → `<embed src={'local-file:///' + path} type="application/pdf">`
- `binary` → `<BinaryViewer name={name} sizeMB={...} onRevealInOs={...} />` — gray card, no embedded preview.

`activeTab.kind` is decided once on `openTab` based on file extension, file size, and (for attachments) `mime`:

```ts
const TEXT_EDIT_LIMIT = 10 * 1024 * 1024   // 10 MB

function classify(name: string, size: number, mime?: string): FileTab['kind'] {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (mime?.startsWith('image/') || ['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)) return 'image'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  // Size guard: any file >10 MB is shown as a binary card regardless of extension,
  // so the user gets a consistent experience whether they double-click in the tree
  // or drag the same file into chat. The text-IPC handler enforces the same limit.
  if (size > TEXT_EDIT_LIMIT) return 'binary'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}
```

`TEXT_EXT = { 'js','jsx','ts','tsx','json','html','css','md','py','yaml','yml','sh','txt', '' }` (extensionless = text). Anything else → binary card.

**Size-threshold matrix (single source of truth):**

| Size | Open in viewer | Drag into chat as attachment |
|---|---|---|
| ≤ 10 MB | text/image/pdf as classified | accepted |
| 10 – 100 MB | binary card (no inline edit) | accepted |
| > 100 MB | binary card | rejected with error toast |

**FileViewer (CM6) integration:**

`@uiw/react-codemirror`'s public `ReactCodeMirrorProps` (verified against the wrapper's README via Context7) **does not accept an `EditorState` prop directly**. The supported props are `value`, `initialState ({json, fields?})`, `extensions`, `onChange`, `onUpdate`, `onCreateEditor`, `ref`, etc. Driving multi-tab state-swap therefore goes through the editor `ref` + imperative `view.setState()`, not through a prop. The store still holds `tab.state: EditorState`; only the write/read path into CM6 changes.

```tsx
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
// language extensions imported lazily via dynamic import inside an extension factory

export function FileViewer({ tab, onStateChange, onSave }: Props) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const extensions = useMemo(() => buildExtensions(tab.path, onSave), [tab.path, onSave])

  // On tab switch: imperative setState into the (single) underlying view.
  // tab.state is the latest snapshot the store has for this tab.
  useEffect(() => {
    const view = editorRef.current?.view
    if (!view || !tab.state) return
    // Only setState when the editor's current state belongs to a different tab,
    // to avoid clobbering the editor mid-typing on unrelated re-renders.
    if (view.state !== tab.state) view.setState(tab.state)
  }, [tab.id, tab.state])

  // Sync every state change back to the store, so when the user switches away
  // and comes back, undo history / selection / scroll are preserved.
  // CM6's onUpdate fires for ALL transactions (selection, scroll, doc) — we
  // forward the updated EditorState every time so the store mirror stays current.
  return (
    <CodeMirror
      ref={editorRef}
      // initialMount only — once mounted we drive via ref.setState.
      // value / initialState seed the FIRST mount; afterward they are ignored.
      value={tab.diskContent}
      onUpdate={(viewUpdate) => onStateChange(tab.id, viewUpdate.state)}
      extensions={extensions}
      theme={cyberpunkDarkTheme}     // matches existing chat panel
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
    />
  )
}
```

**Multi-tab state preservation pattern (revised):**

- Store holds `tabs[id].state: EditorState` as the source of truth.
- The viewer pane mounts **one** `<CodeMirror>` instance (not one per tab) — keeps memory footprint flat as N tabs grow.
- `setActiveTab(id)` triggers the `useEffect` above → `view.setState(tabs[id].state)`. CM6 internally swaps the entire state object: undo history, selection, scroll-into-view position all restore atomically. This is the documented imperative API on `EditorView`.
- `onUpdate` fires after every transaction; we mirror the updated `EditorState` back to `store.tabs[id].state`. Without this mirror, switching out and back would restore a stale snapshot from before the last edits.
- React 19 strict-mode double-mount: harmless because the `useEffect` no-ops when `view.state === tab.state` (already swapped on the first run).

`buildExtensions(path, onSave)`:

- `keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true } }])`
- language pack: `await import('@codemirror/lang-' + lang).then(m => m[lang]())` — inside an extension factory so unused languages aren't bundled. We dispatch by extension:
  - `ts/tsx` → `lang-javascript` with `{ typescript: true, jsx: true }`
  - `js/jsx` → `lang-javascript` with `{ jsx: true }`
  - `py` → `lang-python`
  - `json` → `lang-json`
  - `html` → `lang-html`
  - `css` → `lang-css`
  - `md` → `lang-markdown`
  - `yaml/yml` → `lang-yaml`
  - `sh` → no official lang pack; use plain text + a tiny custom highlighter (or just plain — bash isn't critical).

**Dirty tracking:**

```ts
function computeDirty(state: EditorState, diskContent: string): boolean {
  return state.doc.toString() !== diskContent
}
```

Recomputed on every `onChange`. Cheap because CM6 doc is rope-backed. On save, we set `diskContent = state.doc.toString()` (and update `diskMtime`).

### Section D — External-change detection

Main process owns **one** `chokidar.FSWatcher` for the entire app, with paths added/removed as tabs open and close. (Earlier draft used one watcher per file — Windows opens a `ReadDirectoryChangesW` handle per watcher, so 20 tabs × 1 watcher each can hit fd limits. `chokidar.watch([])` + `.add()`/`.unwatch()` is the recommended idiom.)

```ts
let watcher: FSWatcher | null = null
const watched = new Set<string>()

function ensureWatcher(send: (event: WatchEvent) => void): FSWatcher {
  if (watcher) return watcher
  watcher = chokidar.watch([], {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    atomic: true,
    ignoreInitial: true,
  })
  watcher.on('change', (p) => send({ type: 'change', path: p, mtime: Date.now() }))
  watcher.on('unlink', (p) => send({ type: 'unlink', path: p }))
  return watcher
}

export function startWatching(path: string, send: (event: WatchEvent) => void) {
  if (watched.has(path)) return
  ensureWatcher(send).add(path)
  watched.add(path)
}

export function stopWatching(path: string) {
  if (!watched.has(path)) return
  watcher?.unwatch(path)
  watched.delete(path)
}
```

Renderer subscribes via `electronAPI.fs.onWatchEvent(handler)` (preload bridges `ipcRenderer.on('fs:watch-event', …)`).

Renderer reducer behavior (already covered in **Architecture / data flow — external change**):
- Clean tab + change → silent reload + 1.5s "Reloaded from disk" toast at top of viewer.
- Dirty tab + change → `ConflictModal`.
- Unlink → if the closed tab is currently active, show a banner "File deleted on disk. Save to restore." Save will recreate the file.

`ConflictModal` (3 buttons):
- `[Keep yours]` → dismisses modal. Tab remains dirty. Next save will overwrite disk.
- `[Use disk]` → replaces `state.doc` with disk content, marks tab clean.
- `[Show diff]` → renders `<DiffMergeView diskContent={…} mineContent={state.doc.toString()} />` using `@codemirror/merge`'s `MergeView` (left = disk, right = mine, with change gutters). User then picks one of the first two from the merge pane footer. (Live merge editing of arbitrary chunks is not supported — too much UX surface for v1; if users need it they can save their version, then `apply_patch` the disk version manually.)

### Section E — Drag-and-drop + selection bridge to chat

**File drag → chat input:**

`MentionInput` already handles paste. Add `onDragOver` (preventDefault) + `onDrop`:

```ts
function onDrop(e: React.DragEvent) {
  e.preventDefault()
  const path = e.dataTransfer.getData('application/x-catimation-file-path')
  if (!path) return
  void handleFileDrop(path)
}

async function handleFileDrop(path: string) {
  const stat = await window.electronAPI.fs.stat(path)
  if (!stat.ok || stat.size > 100 * 1024 * 1024) {
    showError('File too large or unreadable')
    return
  }
  // Reuse existing attachment flow, which the AgentManager already understands.
  await store.addAttachmentFromPath({
    path,
    name: basename(path),
    mime: stat.mime,
    size: stat.size,
  })
  // Append a text reference so the user can see it in the input.
  store.appendToChatInput(`\n[file:${basename(path)}]`)
}
```

**Selection drag from CM6:** CM6 already supports text drag-out by default (the dropCursor extension). The dragged payload is `text/plain` containing the selected substring. We additionally inject a custom datatype so the chat input knows it's a code quote (not arbitrary paste):

```ts
const selectionDragHandler = EditorView.domEventHandlers({
  dragstart(event, view) {
    const sel = view.state.selection.main
    if (sel.empty) return false
    const text = view.state.sliceDoc(sel.from, sel.to)
    const fromLine = view.state.doc.lineAt(sel.from).number
    const toLine = view.state.doc.lineAt(sel.to).number
    const path = view.state.facet(activeTabPathFacet)
    const lang = pathToLangShort(path)
    const quote = '```' + lang + ':' + fromLine + '-' + toLine + ':' + path + '\n' + text + '\n```'
    event.dataTransfer?.setData('application/x-catimation-quote', quote)
    event.dataTransfer?.setData('text/plain', text)
    return false  // let CM6's default handler still set the basic text/plain too
  },
})
```

`MentionInput.onDrop` checks for the quote type first; falls back to plain text.

**Selection floating bar:** a small popover above the selection rectangle with a single `[Send to chat ⌘L]` button. Implementation: a CM6 `ViewPlugin` that listens for selection updates and renders/positions a portal-rendered React component on top of the viewer. Hides when selection is empty or window blurs.

**`Cmd/Ctrl+L` keymap:** registered inside `buildExtensions(...)` alongside Cmd+S:

```ts
keymap.of([
  { key: 'Mod-s', run: () => { onSave(); return true } },
  { key: 'Mod-l', run: (view) => {
    const sel = view.state.selection.main
    if (sel.empty) return false
    sendSelectionToChat(view, activeTabPath)
    return true
  }},
])
```

Both the floating button click and the `Mod-l` keypress route into the same `sendSelectionToChat(view, path)` helper that does the line-number computation + fenced-block formatting + `store.appendToChatInput(quote)`.

### Section F — `local-file://` protocol + IPC

**`src/main/file-explorer/protocolHandler.ts`:**

```ts
import { app, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'

// Must run BEFORE app.whenReady()
export function registerLocalFileScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // No CORS on a local scheme; renderer is the only client.
      },
    },
  ])
}

// Must run AFTER app.whenReady()
export function installLocalFileHandler() {
  protocol.handle('local-file', async (request) => {
    try {
      const url = new URL(request.url)
      // local-file:///D:/path/to/file → host='', pathname='/D:/path/to/file'
      // local-file:///home/user/x.txt → host='', pathname='/home/user/x.txt'
      let osPath = decodeURIComponent(url.pathname)
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(osPath)) {
        // Drop the leading slash so Windows sees `D:/path…`.
        osPath = osPath.slice(1)
      }
      // Reject explicit `..` path-traversal segments. This does NOT restrict
      // access to any directory — `local-file:///D:/anywhere/x.png` still works
      // — it only blocks URLs that try to escape through `..` (e.g.
      // `local-file:///D:/uploads/../../etc/passwd`). After normalize, such
      // URLs would still resolve, but a maliciously-crafted attachment filename
      // containing `..` would otherwise sneak through.
      const normalized = path.normalize(osPath)
      if (normalized.split(path.sep).some((seg) => seg === '..')) {
        return new Response('Forbidden: path traversal', { status: 403 })
      }
      // FIXME-prod: when this app gets distributed, add path whitelist
      // (uploadsDir + workspaceRoot) here. Local-dev decision: no whitelist.
      return await net.fetch(pathToFileURL(normalized).toString())
    } catch (err) {
      return new Response(`local-file handler error: ${String(err)}`, { status: 500 })
    }
  })
}
```

**`src/main/file-explorer/fsIpc.ts`** — five handlers:

```ts
ipcMain.handle('fs:read-text', async (_e, path: string) => {
  const stat = await fs.stat(path)
  if (!stat.isFile()) throw new Error(`${path} is not a file`)
  if (stat.size > 10 * 1024 * 1024) throw new Error(`File too large for inline edit (${stat.size}B)`)
  const content = await fs.readFile(path, 'utf-8')
  return { content, mtime: stat.mtimeMs }
})

ipcMain.handle('fs:write-text', async (_e, args: { path: string; content: string }) => {
  await fs.writeFile(args.path, args.content, 'utf-8')
  const stat = await fs.stat(args.path)
  return { mtime: stat.mtimeMs }
})

ipcMain.handle('fs:list-dir', async (_e, path: string): Promise<FileNode[]> => {
  const entries = await fs.readdir(path, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith('.git'))     // skip noisy git internals
    .map((e) => ({
      path: pathLib.join(path, e.name),
      name: e.name,
      kind: e.isDirectory() ? 'dir' : 'file',
      source: 'workspace',
      childrenLoaded: false,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
})

ipcMain.handle('fs:stat', async (_e, path: string) => { /* size, mime by ext, ok */ })

ipcMain.handle('workspace:pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('attachments:list-tree', async (): Promise<FileNode[]> => {
  // join uploads dir + AgentAttachment table — see Section B
})
```

Watcher IPC documented separately in **Section D**.

## Technical Stack — Audit Result

Researched 2026-05-08 against official docs (Context7) and real source (gh CLI on `microsoft/vscode`, `openai/codex`, `codemirror/merge`).

| Choice | Status | Justification |
|---|---|---|
| **CodeMirror 6** (`@codemirror/state` + `view` + `commands` + `language` + `lang-*`) | ✅ | API verified live on Context7. Selection: `state.selection.main.from/to`. Dirty: `EditorView.updateListener.of(u => u.docChanged)`. Lazy lang import works fine inside extension factories. Bundle ~120KB (vs. Monaco ~4MB). |
| **`@uiw/react-codemirror`** | ✅ | Industry standard React wrapper for CM6 (≈11k stars). The `state` prop drives the editor as a controlled component, which is exactly what we need for multi-tab state swap. We confirmed via the wrapper's own docs that `state`-driven mode preserves undo/selection/scroll across tab switches, addressing the original concern about hand-rolling. |
| **`@codemirror/merge`** (`MergeView`) | ✅ | Verified the package's README on GitHub: exports `MergeView` (side-by-side) and `unifiedMergeView` (inline). We use side-by-side for "Show diff" because conflict resolution benefits from explicit `disk vs mine` columns. |
| **Electron `protocol.handle` + `registerSchemesAsPrivileged`** | ✅ | Electron 30+ replaces deprecated `protocol.registerFileProtocol`. We're on Electron 41.2.1. VSCode's own `src/main.ts` uses the same `registerSchemesAsPrivileged` pattern with `vscode-file:` and `vscode-webview:` schemes. We adopt their idiom 1:1 (sans the path whitelist they add — see Security Notes). |
| **`chokidar`** (file watcher) | ✅ | VSCode uses `@parcel/watcher` because it has to watch entire workspaces with millions of files. We watch ≤20 open tabs. `chokidar` is pure JS, has no native binding, and handles ~20 watchers comfortably. The Windows-quirk-prone debouncing is solved by `awaitWriteFinish: { stabilityThreshold: 200 }`, which is documented. |
| **Codex frontend (codex-rs/tui)** | ⚠ Not adopted | Codex's "frontend" is a Rust ratatui terminal UI with no web/Electron target. There is no transferable file-explorer pattern. We adopt only its `apply_patch` / `apply-patch` parsing (already done in chat panel). |

## Security Notes

**Decision — no path whitelist on `local-file://`.**

Recorded with explicit user consent on 2026-05-08. Rationale:

- This Electron build runs `sandbox_mode="danger-full-access"` for the agent itself, so the renderer is already de facto trusted with arbitrary file operations through the agent path. A second whitelist on the asset protocol is double-locking.
- The protocol is **not** registered for `webContents` other than the main renderer (Electron's `protocol.handle` is process-scoped). External web pages can't speak it.
- The protocol is `secure: true, standard: true` but does **not** enable `corsEnabled` or `bypassCSP`. CSP for the renderer remains the standard restrictive policy from `electron-vite`.

Future productionization (when this app gets distributed publicly):

1. Add `// FIXME-prod` markers on the `protocol.handle` callback.
2. Reintroduce whitelist:
   ```ts
   const allowed = [app.getPath('userData') + '/agent/uploads', currentWorkspaceRoot]
   const ok = allowed.some((root) => {
     const rel = path.relative(root, osPath)
     return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
   })
   if (!ok) return new Response('Forbidden', { status: 403 })
   ```
3. Same whitelist applied to `fs:read-text` / `fs:write-text` / `fs:list-dir` IPC handlers.

## Implementation Plan (high-level — detailed plan in writing-plans pass)

Approximate effort, in 0.5-day units, dependency-ordered:

| # | Task | Effort | Tests |
|---|---|---|---|
| 1 | Install deps; register `local-file` scheme + `protocol.handle`; flip `AgentManager.buildUserTimelineItems` to emit `local-file://` URIs (single-regex separator normalize); legacy URI normalizer in `AttachmentCard` + `Lightbox`. **Bug F dies here.** | 1.0 | unit on URI normalizer; integration: load a historical thread, image renders. |
| 2 | Five `fs:*` IPC handlers + `chokidar` watcher service. | 1.0 | each handler unit-tested with `tmp` dir; watcher emits on disk change. |
| 3 | `FileExplorer` zustand slice + persistence. | 0.5 | store unit tests for `pickWorkspace`, `openTab`, `closeTab`, `saveActiveTab`. |
| 4 | `FileExplorerPanel` shell + tree pane (workspace + attachments roots, lazy expand, drag affordance). | 1.0 | RTL tests: empty state → pick folder → tree renders → expand + click. |
| 5 | `FileViewer` (CM6 via `@uiw/react-codemirror` ref + imperative `view.setState()`) + `FileTabStrip` + multi-tab swap + Ctrl+S save + dirty dot + `onUpdate` mirror back to store. | 2.0 | RTL: type → dirty dot → Cmd+S → dot gone; switch tab → undo history preserved (assert via `view.state.history` count). |
| 6 | `ImageViewer` + `BinaryViewer` + PDF embed. | 0.5 | RTL: open `.png` → renders via `local-file://`; open `.zip` → binary card. |
| 7 | External-change watcher integration + `ConflictModal` + `MergeView` in "Show diff". | 1.0 | RTL: write a file externally while tab open and clean → reloads. Same when dirty → conflict modal. |
| 8 | Drag file + drag selection + `SelectionFloatingBar` + chat input drop zone. | 1.0 | RTL: drag tree node into input → attachment chip appears. Select text → click button → quote block appended. |
| 9 | Layout polish: panel header, resize handle, `Ctrl/Cmd+Shift+I`, persistent button, transitions. | 0.5 | RTL: shortcut toggles `fxOpen`; resize handle clamps. |
| 10 | Bug G coda: open an attachment from the Attachments root, edit it, save it. | 0.5 | RTL: same flow but `source: 'attachments'`. Verify `local-file://` writes back into `uploadsDir`. |
|  | **Total** | **~9 days** | |

## Testing Strategy

- **Unit:** URI normalizer, `classify(name, mime)`, `pathToLangShort`, `computeDirty`.
- **IPC:** Each `fs:*` handler in `__tests__/fsIpc.test.ts` against a temp directory (already a pattern in `__tests__/AttachmentService.test.ts`).
- **Watcher:** `fsWatcher.test.ts` writes a file in a tmp dir, asserts a `change` event arrives within 500ms.
- **Renderer (RTL + Vitest jsdom):**
  - `FileTree.test.tsx` — empty workspace, expand, click.
  - `FileTabStrip.test.tsx` — open / close / dirty dot.
  - `FileViewer.test.tsx` — mount, type, dirty, Cmd+S calls store action.
  - `MergeView.test.tsx` — render with `diskContent` ≠ `mineContent`, two columns visible.
  - `MentionInput.dropZone.test.tsx` — drop a `application/x-catimation-file-path` event → `addAttachmentFromPath` is called.
- **Manual smoke (post-merge):**
  - Restart the app, ensure historical attachment images render.
  - Open `src/main/agent/AgentManager.ts`, edit a comment, Cmd+S, verify file timestamp updated on disk.
  - Have the agent run `apply_patch` while the file is open dirty → conflict modal flow.

## Open Questions / Future Work

1. **Multi-workspace.** Likely the next ask once users accumulate ≥3 projects. Needs a workspace dropdown or tab. Defer until requested.
2. **Codebase search.** `Cmd+P` -> file fuzzy-find within Workspace would be straightforward (`fzf`-style on a flat path list). Not in v1.
3. **`apply_patch` integration.** Currently `apply_patch` writes the file directly via the agent's normal file-system tool. Future: surface those edits as inline diff cards in the chat (already partially done) **and** highlight them in the open file tab (CM6 decoration). Not in v1.
4. **Image-only attachments tree pruning.** The Attachments root currently shows every type. If users pile up tens of thousands of attachments we need pagination or filtering. Out of scope for v1.
5. **macOS Finder / Windows Explorer drag-in.** Right now drag must come from inside our File Explorer. Accepting drops from the OS shell is doable (`webContents` already gives us OS-native paths in `dataTransfer.files`) but adds a separate code path. Defer.
