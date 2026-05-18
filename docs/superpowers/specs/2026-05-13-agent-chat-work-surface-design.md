# Agent Chat Work Surface Design

- Status: approved direction, awaiting spec review
- Date: 2026-05-13
- Scope: Scheme B, chat cards plus file detail surface

## Problem

The current agent chat can stream text and show file edits, but the user experience feels too much like logs:

- AI-generated markdown is rendered in chat, but it does not clearly feel like a file being created.
- File edits exist as `FileEditCard`, but the interaction is compact and hidden behind expansion.
- Red/green diff coloring exists in `FileDiffBlock`, but it is only an inline chat diff, not a full file-detail experience like VS Code, Cursor, or Codex.
- Clicking from chat into the file explorer is inconsistent: references can open, but markdown draft cards and file-change cards do not share one clear interaction model.

The goal is to make AI work feel visible and inspectable:

1. AI creates markdown with a typewriter-like live preview in the chat column.
2. When the markdown file is complete, clicking the chat card opens the concrete file in the file display panel.
3. AI file edits show red deletions and green additions in chat, then open a richer side-by-side diff in the file display panel.

## Existing Structure

Relevant existing pieces:

- `src/types/agent-timeline.ts`
  - `TextItem` holds assistant markdown text.
  - `FileEditItem` holds `changes: FileChange[]` where each change already contains `path`, `operation`, `diff`, `added`, and `removed`.
- `src/renderer/src/features/agent-chat/MarkdownContent.tsx`
  - Renders markdown in chat.
  - Supports fenced code block copy and apply flows.
- `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
  - Renders file edit summaries and can expand to show diffs.
- `src/renderer/src/features/agent-chat/cards/FileDiffBlock.tsx`
  - Already applies green styling for `+` lines and red styling for `-` lines.
- `src/renderer/src/features/file-explorer/FileViewer.tsx`
  - Opens real files in CodeMirror.
- `src/renderer/src/features/file-explorer/DiffMergeView.tsx`
  - Uses CodeMirror MergeView for side-by-side diff display.
- `src/renderer/src/features/file-explorer/store.ts`
  - Owns tabs, active file, references, and external content apply flows.

This means the work should be additive. We should not replace the whole chat or file explorer.

## Chosen Approach

Use a two-layer "AI Work Surface":

1. Chat remains the live activity surface.
2. The file explorer becomes the detail surface for final files and full diffs.

Chat should answer: "What is the AI doing right now?"

File display should answer: "What exactly changed in this file?"

## Interaction Model

### Markdown Creation

When the AI is creating a markdown file:

1. Chat shows a `Draft Markdown` card.
2. The card header shows a running state, for example `Creating docs/foo.md...`.
3. The body renders the markdown using `MarkdownContent`.
4. Incoming content is revealed with a typewriter-like animation.
5. The markdown is not written to the workspace until the AI's file operation completes.
6. Once complete, the card changes to `Created docs/foo.md`.
7. Clicking the card opens the real file in the file display panel.

If creation fails:

- Keep the draft card visible.
- Mark it as failed.
- Show the error.
- Do not create a half-written workspace file.

### File Edits

When the AI edits a file:

1. Chat shows a `File Change` card immediately.
2. While running, the header shows `Editing src/foo.ts...`.
3. Once diff data exists, the card shows a compact unified diff.
4. Deletions are red.
5. Additions are green.
6. Large diffs are truncated in chat.
7. Clicking the card opens a file-detail tab with a side-by-side diff.

The chat card is for quick confidence. The file-detail tab is for inspection.

### File Deletes

When the AI deletes a file:

1. Chat shows a destructive red-accent `Deleted path/to/file` card.
2. The compact diff shows removed content when available.
3. Clicking opens a deleted-file preview in the file display panel.
4. The deleted-file preview is read-only.

## Data Model

Keep `FileEditItem` as the source of truth for file changes. Extend only where required.

Do not add a backend-emitted `MarkdownDraftItem` in v1. The current protocol already emits `TextItem` and `FileEditItem`, but it does not expose token-level file write deltas. Adding a new timeline protocol item first would force main-process/backend changes before the UI can ship.

Instead, v1 derives markdown draft cards in the renderer from existing file-change data.

Future protocol shape, if the backend later exposes file-write chunks:

```ts
export interface MarkdownDraftItem extends BaseItem {
  type: 'markdownDraft'
  path?: string
  title?: string
  content: string
  status: 'streaming' | 'created' | 'failed'
  error?: string
}
```

Why keep this as future-only:

- `TextItem` is general assistant prose.
- `MarkdownDraftItem` represents a concrete file artifact in progress.
- It gives the renderer a stable click target and a stable state machine.
- The renderer can be written against this shape internally now, without requiring backend protocol support yet.

For file diffs, keep the existing `FileEditItem` shape:

```ts
export interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string
  added: number
  removed: number
}
```

Do not introduce accept/reject state in this iteration. The current request is about visibility and navigation, not approvals.

## Event Mapping

Do not infer markdown drafts from ordinary assistant prose. A markdown draft only exists when the agent work stream clearly indicates a file creation/update for a markdown path.

Rules:

- Plain assistant markdown remains a normal `TextItem`.
- A renderer-derived markdown draft card is created only for file work where:
  - the path ends in `.md`, `.mdx`, or `.markdown`, and
  - the operation is `create`, or the event payload explicitly marks the item as a file draft.
- Since the current backend emits `FileEditItem` after completion, the first implementation animates the completed markdown into chat after the file edit completes. This still improves perceived clarity without pretending we have token-level file-write deltas.
- If later backend events expose file-write chunks, the same `MarkdownDraftItem` can transition from real streaming to completed file without changing the renderer contract.

This keeps the design honest: the UI should never claim a file is being written live unless the protocol actually tells us that.

## Unified Diff Parsing

`FileChange.diff` is unified diff text, not two complete documents. `DiffMergeView` needs old and new content. Therefore v1 must parse unified diffs before opening the side-by-side detail view.

Add a small parser:

```ts
type ParsedUnifiedDiff = {
  beforeContent: string
  afterContent: string
  ok: true
} | {
  ok: false
  reason: string
}
```

Parsing rules:

- Ignore file headers such as `---`, `+++`, and `diff --git`.
- Ignore hunk headers (`@@ ... @@`) for document reconstruction.
- Lines beginning with `-` go only into `beforeContent`.
- Lines beginning with `+` go only into `afterContent`.
- Context lines go into both sides.
- Preserve blank lines.
- Preserve `\ No newline at end of file` as metadata, not content.

Fallback behavior:

- If parsing fails, the chat card still shows the unified diff.
- The file-detail tab falls back to a read-only unified diff viewer instead of `DiffMergeView`.
- Do not read the current disk file as the "before" side for edits, because the AI may have already written the file. Reading disk would often produce the after state on both sides.

For `create`, if parsing cannot recover both sides:

- before side is empty;
- after side is reconstructed from `+` and context lines when possible.

For `delete`, if parsing cannot recover both sides:

- before side is reconstructed from `-` and context lines when possible;
- after side is empty.

## Rendering Components

### New Components

Create:

- `cards/MarkdownDraftCard.tsx`
  - Renders renderer-derived markdown draft with typewriter reveal.
  - Clicks through to file display once `status === 'created'` and `path` exists.
  - Shows failed state if needed.

- `cards/FileChangeCard.tsx` or upgrade `FileEditCard.tsx`
  - Prefer upgrading `FileEditCard.tsx` unless the file grows too large.
  - Header: operation, path, `+N -N`, running/completed state.
  - Body: compact unified diff using an improved `FileDiffBlock`.
  - Click target: open file-detail diff tab.

- `file-explorer/AiChangeViewer.tsx`
  - Read-only detail view for a single `FileChange`.
  - Uses `DiffMergeView` when unified diff parsing succeeds.
  - Uses a read-only unified diff viewer when parsing fails.
  - Uses a read-only removed-content view for delete changes.

### Existing Components To Reuse

- `MarkdownContent` for markdown rendering.
- `FileDiffBlock` for compact unified diff, after visual improvements.
- `DiffMergeView` for side-by-side file detail.
- `FileViewer` for normal created markdown files after completion.

## File Explorer Integration

Add an "AI change" tab kind to file explorer tabs.

Current `FileTab` is not a minimal discriminated union. It has required fields such as `id`, `path`, `name`, `source`, `kind`, `state`, `diskContent`, `diskMtime`, and `dirty`. Do not introduce a separate incompatible `AiChangeTab` object.

Instead:

1. Extend `FileTabKind`:

```ts
export type FileTabKind =
  | 'text'
  | 'image'
  | 'video'
  | 'pdf'
  | 'binary'
  | 'reference'
  | 'compare'
  | 'ai-change'
```

2. Add optional metadata to `FileTab`:

```ts
export type FileTab = {
  // existing fields...
  aiChange?: {
    change: FileChange
    beforeContent?: string
    afterContent?: string
    parseError?: string
  }
}
```

`openAiChange(change)` should:

1. Ensure the file explorer panel is open.
2. Parse `change.diff` into before/after content.
3. Create or activate an `ai-change` tab for `change.path`.
4. Populate the tab's required `FileTab` fields with safe read-only defaults:
   - `source: 'workspace'`
   - `state: null`
   - `diskContent: ''`
   - `diskMtime: 0`
   - `dirty: false`
5. Render `AiChangeViewer`.

For markdown created files:

- When the file exists, use existing `openTab(path, 'workspace')`.
- Do not open an AI change tab unless the user clicked a diff card.

For multi-file changes:

- Chat should first show a file list, not every full diff.
- Each row shows operation, path, `+N -N`, and status.
- Clicking a row opens that file's `ai-change` detail tab.
- The card may expose "Show inline preview" for the first or selected file, but the default should keep the chat compact.

## Typewriter Behavior

The typewriter effect should be visual-only:

- Store the full content in state immediately.
- Animate visible length in the renderer.
- Do not delay actual data persistence.
- Disable or drastically speed up animation for large content.
- Respect reduced-motion preferences if available.

Recommended defaults:

- Small markdown: reveal around 60-120 characters per frame batch.
- Large markdown over 20 KB: skip animation and fade in.
- Running content: keep autoscroll behavior unchanged.

This avoids making the app feel slow while still improving perceived liveness.

## Diff Visual Design

Chat unified diff:

- One column.
- Compact monospace.
- `+` lines: green text, dark green background.
- `-` lines: red text, dark red background.
- `@@` hunk lines: muted zinc/cyan.
- Context lines: muted zinc.
- Large diffs: show first 200 lines and a `Show full diff` affordance.

File detail split diff:

- Side-by-side with old content on the left and new content on the right.
- Read-only using both `EditorView.editable.of(false)` and `EditorState.readOnly.of(true)`.
- Header includes file path, operation, added count, removed count.
- For `create`, left side can be empty and right side shows new file.
- For `delete`, left side shows deleted content and right side is empty/deleted state.
- If unified diff parsing fails, show a unified diff fallback rather than a broken split view.

## Error Handling

Markdown draft:

- If streaming succeeds but file creation fails, keep the draft card and mark it failed.
- The user can still copy the markdown content from the card.

File edit card:

- If diff data is missing, show a simple summary and allow opening the file if the path exists.
- If opening the AI change detail fails, show a warning notice and keep the chat card intact.

File explorer:

- AI change tabs are read-only.
- If the underlying file no longer exists, the AI change tab still renders from the stored diff.

## Testing

Add focused tests:

- `MarkdownDraftCard.test.tsx`
  - Streams visible content.
  - Skips animation for large markdown.
  - Opens file when created.
  - Does not open when failed.

- `FileEditCard.test.tsx`
  - Shows running state.
  - Shows compact unified diff.
  - Calls `openAiChange` when clicked.
  - Handles create/edit/delete labels.
  - For multi-file changes, defaults to a compact file list and opens the clicked file.

- `FileDiffBlock.test.tsx`
  - Styles added lines green.
  - Styles deleted lines red.
  - Truncates large diffs.

- `parseUnifiedDiff.test.ts`
  - Reconstructs before/after content for edit diffs.
  - Reconstructs create diffs with empty before content.
  - Reconstructs delete diffs with empty after content.
  - Ignores hunk/file headers and no-newline markers.
  - Returns a failure result for unsupported malformed input.

- `FileExplorerPanel` or store tests
  - `openAiChange` creates an AI change tab.
  - Re-clicking same change activates existing tab.
  - Parsing failure still opens a unified diff fallback tab.

## Non-goals

Do not implement these in this iteration:

- Accept/reject file changes.
- Git-style staging.
- Inline editor diff decorations inside normal `FileViewer`.
- Multi-file review session with batch approval.
- Persisting draft markdown as a separate artifact database table.

These are useful later, but they are larger product decisions.

## Rollout Plan

1. Add unified diff parser with tests.
2. Add renderer-derived markdown draft card for completed markdown create changes.
3. Upgrade `FileEditCard` and `FileDiffBlock` for stronger compact diff and multi-file list behavior.
4. Add `ai-change` tab support in file explorer store.
5. Add `AiChangeViewer` backed by `DiffMergeView` when parsing succeeds and unified diff fallback when parsing fails.
6. Wire click-through from chat cards to file explorer.
7. Add component/store tests.

## Success Criteria

- When AI creates markdown, the user sees a live markdown draft in chat.
- After creation completes, clicking the chat card opens the real file.
- When AI edits files, chat clearly shows what changed.
- Added lines are green and removed lines are red.
- Clicking a file edit opens a detailed side-by-side diff in the file display panel.
- Large diffs do not overwhelm the chat column.

