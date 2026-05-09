# Agent Chat Evidence Stack Design

## Summary

Redesign the agent chat timeline so assistant messages read like a normal Codex/Cursor conversation while tool calls, command output, file edits, and generated artifacts remain available as compact evidence. The chat should prioritize the natural-language answer, show real streamed text as it arrives, and let users inspect evidence without flooding the main thread.

Confirmed direction:

- Use a Cursor/Codex-style narrative chat, not a raw tool log.
- Render tool/file activity as compact evidence chips or an evidence stack.
- Single-click evidence expands details in the chat.
- Double-click evidence opens the right-side file/reference panel and jumps to the target.
- Use real streamed deltas for text. Do not fake a typewriter animation.

## Current Problems

The current UI renders `shell`, `fileEdit`, and generic `activity` items as independent cards in the same visual hierarchy as assistant text. This makes tool-heavy turns look like a log stream rather than a coherent answer.

Specific issues observed:

- Tool calls and file edits often show tiny pills or empty-looking boxes, so users cannot tell what actually happened.
- Some outputs are hidden behind `Open output` / `Open diff` buttons that do not communicate the result.
- File edit cards can show an empty diff body when the provider omits diff content.
- File edit cards can also lose available modification content because live `item/fileChange/outputDelta` events are currently dropped while waiting for `item/completed`.
- Text can appear all at once when the router falls back to completed message payloads instead of streaming deltas.
- Clicking file edits or generated files does not consistently open the right-side display panel.

## Goals

1. Keep the assistant response as the main reading path.
2. Make every tool/file operation visible as concise evidence.
3. Let users inspect evidence inline without losing chat context.
4. Let users jump to the right-side panel deliberately through double-click or keyboard shortcut.
5. Preserve real streaming behavior for text deltas.
6. Avoid blank output/diff containers when there is no content.

## Non-Goals

- Do not build a separate activity sidebar.
- Do not replace the existing timeline event model.
- Do not implement fake per-character animation for completed text.
- Do not redesign the whole file explorer.
- Do not remove existing command, diff, or reference details; reorganize how they are presented.

## Recommended Approach

Use an evidence stack inside each assistant message.

Assistant text and reasoning remain the main body. Tool-like items become compact evidence chips grouped below or between text blocks, depending on event order. Each chip summarizes the operation and its status. Details are available inline on click, and the right-side panel opens only on an explicit jump action.

This keeps the implementation close to existing primitives:

- `TimelineItem` remains the source of truth.
- `referencesFromTimelineItem()` remains the source of openable evidence.
- `useFileExplorerStore.openReference()` remains the right-panel bridge.
- Existing cards can be refactored into evidence detail renderers rather than discarded.

## User Interaction

### Evidence Chips

Each evidence item renders as a compact chip:

- Shell command: `cmd · success · exit 0`
- File edit: `file · 账单汇总.md · +4 -0`
- MCP/tool call: `mcp · tool-name · success`
- Web search: `web · query/result · success`
- Generic activity: `tool · label · status`

Running chips show a spinner. Successful chips use a low-emphasis success state. Failed chips use a clear red/amber state and include the error in the expandable detail.

### Single Click

Single click expands or collapses inline details in the chat:

- Shell: stdout/stderr, exit code, command.
- File edit: diff preview when available, otherwise a clear empty-state message.
- MCP/tool: JSON payload or readable detail summary.
- Web/file/image/artifact: relevant detail or preview metadata.

Single click must not open or focus the right-side panel.

Because browser double-clicks normally fire click events first, the implementation must avoid accidental expand/collapse flicker before a double-click jump. Use one of these deterministic strategies:

- Delay the single-click expand action briefly and cancel it when a double-click arrives.
- Or route double-click through an explicit event guard that prevents the pending single-click action from committing.

The implementation plan should choose one strategy and cover it with tests.

### Double Click

Double click opens the right-side panel through the item reference:

- Local files open a file tab.
- File edits open a diff/reference tab.
- Shell output opens command-output reference details.
- MCP/tool results open JSON/reference details.

The right panel should become visible and activate the target tab.

Double-click is a shortcut, not the only way to open the panel. When a chip is expanded and has an openable reference, its detail area must include a visible `Open in panel` action for mouse, touch, and screen-reader users.

### Keyboard

Evidence chips are keyboard accessible:

- `Enter` / `Space`: expand or collapse inline details.
- `Ctrl+Enter` / `Cmd+Enter`: open the right-side panel reference.
- Expanded details expose the same `Open in panel` action as a normal focusable button.
- Focus ring is visible.

Clickable elements use `cursor-pointer`, and hover/focus states must not shift layout.

## Data Flow

### Streaming Text

Text should update from live deltas:

- `item/agentMessage/delta` and other text delta events should append directly to the active text item.
- `item/completed#agentMessage` is only a fallback when no delta was streamed for that item.
- Store updates should preserve intermediate render states instead of waiting for the final completion event.

The desired behavior is real streaming, not simulated typing.

### Evidence Items

The renderer should classify these timeline item types as evidence:

- `shell`
- `fileEdit`
- `activity`
- `artifact`
- openable `attachment` items when used as produced evidence

Evidence placement is deterministic:

- Preserve chronological order inside each assistant message.
- Render text/reasoning as the narrative path.
- Collapse adjacent evidence items into one `EvidenceStack`.
- Start a new `EvidenceStack` after the next text/reasoning item appears.

This avoids a random mix of chips and text while still making it clear which tools supported which part of the answer.

### File Change Content

File change details should use the richest available data:

- If `item/completed` includes structured `changes[].unifiedDiff`, render that diff.
- If structured completed changes omit `unifiedDiff`, preserve any `item/fileChange/outputDelta` text received during the item and use it as a fallback diff/detail.
- If neither completed changes nor output deltas provide content, show the explicit no-diff empty state.

The UI must not silently drop file-change deltas and then render a blank diff container.

### References

`referencesFromTimelineItem()` remains the canonical reference adapter.

`openReference()` should guarantee right-panel visibility for all openable reference types, including local file references. Today local files call `openTab()` and return, which can leave the right panel closed. The new behavior should set `fxOpen: true` before or after opening local files.

### Missing Details

Provider events can omit details such as `unifiedDiff` or stdout. The UI should not render empty black boxes as if content exists.

Required empty states:

- No command output: show a small muted `No output` line only when expanded.
- No diff content: show `File changed, but no diff was provided`.
- No tool detail: show the status chip only; no expandable caret.

## Components

### `EvidenceStack`

Renders a list of evidence items for one assistant message. It owns expanded state per item and delegates detail rendering to smaller components.

Responsibilities:

- Render compact chips.
- Manage click/double-click behavior.
- Choose status and labels.
- Call `openReference()` for jump actions.

### `EvidenceChip`

Accessible chip button with status, label, summary, and optional expand indicator.

Responsibilities:

- Keyboard handling.
- Focus/hover states.
- Running/success/error/cancelled visual treatment.
- No emoji icons. Existing emoji-like symbols in current cards should be replaced with short text labels or SVG icons when those cards are refactored into evidence chips.

### Evidence Detail Renderers

Reuse or adapt existing card internals:

- Shell detail: command, stdout, stderr, exit code.
- File edit detail: `FileDiffBlock` list or no-diff empty state.
- Activity detail: JSON/text detail with readable wrapping.
- Artifact/attachment detail: preview metadata and reference actions.

## Visual Design

The style should fit the existing dark cyberpunk chat without adding visual noise.

Guidelines:

- Evidence chips are smaller than assistant text and use subdued borders.
- Running state uses a spinner but should not dominate the conversation.
- Error state must be visible enough to diagnose failed tools.
- Avoid emoji UI icons in new components; prefer short labels or existing SVG icon patterns.
- Preserve readable contrast and visible focus states.
- Use 150-300ms color/opacity transitions only; avoid layout-shifting hover transforms.

## Error Handling

- Unknown evidence kinds fall back to a generic `tool` chip.
- Missing reference means the chip can still expand inline but does not offer right-panel jump.
- `openReference()` failures should leave the inline detail visible and surface a small error message if the store exposes one later.
- Missing diff/output content is an empty detail state, not a crash and not a large blank panel.

## Testing Plan

### Store and Router

- Consecutive text deltas update the assistant text incrementally.
- Completed agent message payload does not duplicate text when deltas were already streamed.
- Completed agent message payload must not replace or remount an already streamed text item.
- Tests should assert an intermediate streamed render state before final completion, not only final content.
- Missing diff fields in provider file-change events do not crash.
- File-change output deltas are preserved and used when completed file-change payloads omit `unifiedDiff`.

### Evidence UI

- Shell/file/tool items render as compact evidence chips by default.
- Single click expands inline detail.
- Double click calls `openReference()` with the expected reference.
- Double click does not leave the chip in an unintended expanded/collapsed state from the first click.
- Keyboard `Enter`/`Space` expands, and `Ctrl/Cmd+Enter` opens the reference.
- Expanded evidence with a reference renders a visible `Open in panel` action.
- No-output and no-diff states render clear muted messages.

### File Explorer Linkage

- Opening a local file reference sets `fxOpen: true` and activates the file tab.
- Opening a diff reference sets `fxOpen: true` and activates the reference tab.
- Opening command/MCP details sets `fxOpen: true` and activates the reference tab.

### Manual Acceptance

Run a Codex turn that reads a file, edits a file, and runs a command.

Expected result:

- Assistant text streams in as deltas arrive.
- Tool and file operations appear as compact evidence.
- Single click expands details in chat.
- Double click opens the right-side panel and jumps to the corresponding file, diff, or output.

## Open Decisions

None. The user approved:

- Cursor/Codex-style narrative chat.
- Single-click inline expansion.
- Double-click right-panel jump.
- Real streaming text only.
