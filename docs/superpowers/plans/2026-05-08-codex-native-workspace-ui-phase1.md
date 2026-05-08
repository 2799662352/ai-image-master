# Codex-Native Workspace UI — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase 1 of the spec at `docs/superpowers/specs/2026-05-08-codex-native-workspace-ui-design.md`: persistent reference model, real preview tab routing for code/markdown/image/PDF/URL/shell-output/JSON, reference chips on timeline cards and chat input, and safer Codex launch defaults — without altering Codex's running session, without shipping non-functional UI surfaces, and without introducing new IPC surfaces that accept arbitrary main-process configuration from the renderer.

**Phase boundary (must not appear in this plan):** `setSessionConfig` IPC, `agent:start-exec-job` IPC, `codex exec --json` runner, MCP status panel with real data, capabilities marketing copy, GitHub Actions auto-update workflow, slash-command palette. All of these belong to Phase 2 (`2026-05-08-codex-native-workspace-ui-phase2.md`) or are deliberately not built. The narrow `agent:set-allowed-roots` IPC is NOT a `setSessionConfig` — it accepts only a `string[]` and only mutates the writableRoots / cwd alignment; arbitrary session config (sandbox/approval/web search) is reserved for Phase 2 with confirmation gates.

**Tech Stack:** Electron, React 19, Zustand, TypeScript 5, CodeMirror 6, Vitest, OpenAI Codex CLI 0.128.

---

## Phase Scope and Out of Scope

### In Phase 1

- `AgentReference` shared type (`src/types/agent-reference.ts`).
- `referenceUtils` that converts timeline items, attachments, and ad-hoc inputs into references — with type-safe enum mapping and multi-attachment handling.
- New `kind: 'reference'` workspace tab + `openReference` action that **delegates to existing `openTab` for local-path file/code/markdown/image/PDF references** so CodeMirror, ImageViewer, BinaryViewer, and the existing `<embed>` PDF viewer are reused. Synthetic tabs are used **only** for non-file behaviors: `url`, `shellOutput`, `jsonResource`, `diff`. (`'external'` and `'activity'` open behaviors are NOT in Phase 1 — `UrlPreview` owns the safe/unsafe split for URLs, and activity items route to `jsonResource`.)
- New preview components: `UrlPreview` (locked-down sandbox WITHOUT `allow-same-origin` / `allow-popups-to-escape-sandbox` / `allow-forms`; HTTPS-only embedding; HTTP routed to "Open externally"), `ShellOutputPreview`, `JsonResourcePreview` (safe stringify).
- Path-containment hardening for the existing `fs:read-text` / `fs:list-dir` / `fs:stat` IPC handlers (reject paths outside persisted workspace roots + agent uploads dir). `local-file://` protocol handler rejects cross-origin requests via `Sec-Fetch-Site`. CSP `frame-src` opens up to `https:` (was `'none'`) so the iframe can actually load.
- `ReferenceChip` component, plus "Open" buttons on `ShellCard`, `ActivityCard`, `AttachmentCard`, `FileEditCard` that route through `openReference`.
- File-drop into `MentionInput` renders an inline reference chip while preserving the existing attachment payload and pure-markdown selection insertion. Chip × removes BOTH the chip AND the underlying attachment so user intent is honored.
- `buildCodexLaunchArgs` accepts an optional `sessionConfig` and **defaults to `workspace-write` + `on-request`** (changing the launch posture). The previous `appendProviderArgs` block is extracted into a named helper. No live mutation of a running backend.
- Narrow `agent:set-allowed-roots` IPC (string-array passthrough only — does NOT accept arbitrary `CodexSessionConfig`) so the renderer's persisted workspace roots seed Codex's `cwd` AND `--add-dir` writableRoots. Without this the status panel would say "0 root(s)" while Codex actually inherits write access to `process.cwd()` (install dir on packaged builds, dev tree under `npm run dev`).
- Read-only `agent:get-session-status` IPC + `CodexStatusPanel` rendered in chat header, surfacing model / sandbox / approval / web-search / writable roots.

### Out of Phase 1 (defer to Phase 2 plan)

- Mutating Codex session at runtime (`setSessionConfig`, IPC handler that restarts the backend, `dialog.showMessageBox` confirmation gates).
- `codex exec --json` background runner, fixture, IPC, and timeline normalisation.
- MCP panel that reads `~/.codex/config.toml`.
- GitHub Actions workflow that updates `codexCliVersion`.
- Codex CLI binary integrity verification (checksum manifest).
- Capabilities marketing panel (deleted from the original plan; not replaced).
- Slash-command palette as a separate UI surface — its supported actions (`/status`, `/permissions`, `/mcp`, `/diff`) are reachable through the panels and buttons added by this plan and Phase 2's `SessionConfigDialog` / `CodexMcpPanel`, so the palette is unnecessary. Phase 2 confirms this decision in its own out-of-scope list.

### Out of all phases (per spec §Out of Scope)

- Replacing Codex `app-server` with a custom runtime.
- Building a separate MCP registry that diverges from Codex `config.toml`.
- Auto-running attacker-influenced commands without an approval gate.

---

## File Structure

Only files actually created or modified by this plan:

### Shared types

- `src/types/agent-reference.ts` (new) — `AgentReference` union and helpers.

### Renderer — references

- `src/renderer/src/features/agent-chat/references/referenceUtils.ts` (new)
- `src/renderer/src/features/agent-chat/references/ReferenceChip.tsx` (new)
- `src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts` (new)
- `src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx` (new)

### Renderer — file explorer / workspace preview

- `src/renderer/src/features/file-explorer/types.ts` (modify) — extend `FileTabKind` and `FileTab`.
- `src/renderer/src/features/file-explorer/store.ts` (modify) — add `openReference`, gate `tab.path`-based logic on `tab.kind !== 'reference'`.
- `src/renderer/src/features/file-explorer/urlValidation.ts` (new) — single `validateExternalUrl(url)` helper.
- `src/renderer/src/features/file-explorer/UrlPreview.tsx` (new)
- `src/renderer/src/features/file-explorer/ShellOutputPreview.tsx` (new)
- `src/renderer/src/features/file-explorer/JsonResourcePreview.tsx` (new)
- `src/renderer/src/features/file-explorer/ReferencePreview.tsx` (new) — dispatcher for synthetic reference tabs.
- `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx` (modify) — extend `ActiveViewer` switch to handle `'reference'` kind.
- `src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts` (new)
- `src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts` (new)
- `src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx` (new)
- `src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx` (new)
- `src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx` (new)

### Renderer — chat

- `src/renderer/src/features/agent-chat/cards/ShellCard.tsx` (modify) — add "Open output".
- `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx` (modify) — add "Open details".
- `src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx` (modify) — add "Open file" / "Open image".
- `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx` (modify) — add "Open diff".
- `src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx` (new)
- `src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx` (new)
- `src/renderer/src/features/agent-chat/MentionInput.tsx` (modify) — render dropped files as reference chips while keeping `[file:name]` removal-friendly text behavior.
- `src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx` (new)
- `src/renderer/src/features/agent-chat/store.ts` (modify) — add `pendingReferences: AgentReference[]`, `addPendingReference`, `removePendingReference`, `clearPendingReferences`. Cleared after `send()`. **Not** plumbed into `AgentSendMessagePayload` (Phase 2 wires that).
- `src/renderer/src/features/agent-chat/CodexStatusPanel.tsx` (new)
- `src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx` (new)
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (modify) — render `<CodexStatusPanel status={status} />` in the existing header row, fetch via `useEffect` on mount.

### Main process

- `src/types/agent.ts` (modify) — add `CodexSandboxMode`, `CodexApprovalPolicy`, `CodexWebSearchMode`, `CodexSessionConfig`, `CodexSessionStatus`. **Do not** extend `AgentSendMessagePayload` in Phase 1.
- `src/main/agent/codexLaunch.ts` (modify) — extract `appendProviderArgs` helper, accept `sessionConfig`, default to safe values.
- `src/main/agent/CodexLocalBackend.ts` (modify) — add optional `sessionConfig?: Partial<CodexSessionConfig>` to `CodexLocalBackendOptions` and forward to `buildCodexLaunchArgs` in both `start()` and `testConnection()`.
- `src/main/agent/AgentManager.ts` (modify) — add `getSessionStatus()`, add narrow `setAllowedRoots(roots)` passthrough that updates `sessionConfig.writableRoots` AND calls `setFsAllowedRoots()`, and replace `cwd: process.cwd()` with `sessionConfig.writableRoots[0] ?? process.cwd()` in `sendMessage`. **Do not** add `setSessionConfig`.
- `src/main/agent/ipc.ts` (modify) — add `agent:get-session-status` (read-only) and `agent:set-allowed-roots` (string[]→string[] passthrough).
- `src/main/agent/__tests__/codexLaunch.test.ts` (modify) — keep the three existing regressions (no `serve` subcommand, no provider overrides without provider, `model_context_window` / `model_auto_compact_token_limit`); swap legacy permissive default assertions for safe defaults; add `sessionConfig` override / `writableRoots` / `appendProviderArgs` tests.
- `src/main/agent/__tests__/AgentManager.allowedRoots.test.ts` (new) — covers `setAllowedRoots` validation and `cwd` derivation.
- `src/main/file-explorer/fsIpc.ts` (modify) — add `setFsAllowedRoots(roots)` + `assertContained(p)` containment check; wrap `handleReadText`, `handleWriteText`, `handleListDir`, `handleStat`.
- `src/main/file-explorer/protocolHandler.ts` (modify) — reject cross-origin `local-file://` requests via `Sec-Fetch-Site`.
- `src/main/file-explorer/__tests__/fsIpc.containment.test.ts` (new) — workspace-roots containment tests.
- `src/main/file-explorer/__tests__/protocolHandler.test.ts` (modify or new) — Sec-Fetch-Site rejection tests.
- `src/main/index.ts` (modify) — change CSP `frame-src 'none'` → `frame-src https:`.
- `src/main/<existing shell IPC module>.ts` (modify) — add `IPC_CHANNELS.SHELL.OPEN_EXTERNAL` handler with main-side `validateExternalUrl` re-check.

### Preload

- `src/preload/index.ts` (modify) — expose `getSessionStatus()`, `setAllowedRoots(roots)`, and the IPC-routed `shell.openExternal(url)`. NO direct `import { shell } from 'electron'` in preload.

---

## Pre-Flight Reading

Before Task 1, the implementer **must read** these files to confirm assumptions match this plan. The plan was written against these exact shapes:

- `src/main/agent/codexLaunch.ts` (~74 content lines as of writing — no `appendProviderArgs` helper yet, `approval_policy` hardcoded to `"never"` and `sandbox_mode` to `"danger-full-access"`). The exact line count drifts trivially; treat the helper-absence and the hardcoded posture as the load-bearing facts.
- `src/main/agent/CodexLocalBackend.ts` (`CodexLocalBackendOptions` around lines 17–61, no `sessionConfig` field, `provider` field already exists; `start()` calls `buildCodexLaunchArgs` once; `testConnection()` calls it again — both are touched in Task 5 Step 5).
- `src/main/agent/AgentManager.ts` (`DEFAULT_PROVIDER` is `const`, lines 30–35; `backend?: IAgentBackend` injection seam at line 97; `DEFAULT_AGENT_MODEL = 'gpt-5.5'`; `sendMessage` currently sets `cwd: process.cwd()` around L250 — Task 5 Step 6 replaces that).
- `src/types/agent.ts` (existing `AgentSendMessagePayload` shape — Task 5 EXTENDS this file with `CodexSandboxMode`, `CodexApprovalPolicy`, `CodexSessionConfig`, `CodexSessionStatus`; Task 6 asserts via `expectTypeOf` that `pendingReferences` / `references` are NOT in `AgentSendMessagePayload`).
- `src/types/agent-timeline.ts` (`ActivityItem.status` is `'running' | 'success' | 'error' | 'cancelled'`; `AttachmentItem.attachments: AttachmentRef[]`; `ArtifactItem.artifacts: AttachmentRef[]`).
- `src/renderer/src/features/file-explorer/types.ts` (`FileTabKind = 'text' | 'image' | 'pdf' | 'binary'`).
- `src/renderer/src/features/file-explorer/store.ts` (chokidar handler around L77–78 uses `tabs.find((t) => t.path === event.path)`; `closeTab` already takes `options?.saveDirty`; `addFolder` / `removeFolder` / `loadWorkspaceFolders` exist and Task 5 Step 6 calls `setAllowedRoots` after each).
- `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx` (`ActiveViewer` switch at L21–30, PDF rendered via inline `<embed>` — Task 3 Step 7 inserts the `'reference'` branch).
- `src/renderer/src/features/agent-chat/cards/ShellCard.tsx` (uses `import type { ShellItem } from '../../../../../types/agent-timeline'` — **5 `../` segments**, this is the canonical depth for files in `cards/` and `references/`).
- `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx`, `AttachmentCard.tsx`, `FileEditCard.tsx` (each is touched by Task 4 Step 4 — preserve all existing rendering, including image lightbox / file-explorer reveal flows).
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (Task 5 Step 8 mounts `CodexStatusPanel` near the chat header; identify the existing slot before editing).
- `src/renderer/src/features/agent-chat/store.ts` (Task 6 adds `pendingReferences` slice + actions; the existing `removeAttachment(name)` action is reused by the chip × handler).
- `src/renderer/src/features/agent-chat/MentionInput.tsx` (existing `onDrop` parses `parseFileDrop` and currently inserts `[file:name]` plus an attachment).
- `src/main/agent/ipc.ts`, `src/preload/index.ts` (Task 5 Step 7 adds two narrow channels: `agent:get-session-status` (read-only) and `agent:set-allowed-roots` (string[]→string[] passthrough)).
- `src/main/file-explorer/fsIpc.ts` and `src/main/file-explorer/protocolHandler.ts` (Task 3 Steps 6b/6c add Sec-Fetch-Site rejection and workspace-roots containment respectively — read both files end-to-end before editing).
- `src/main/index.ts` (Task 3 Step 6a relaxes CSP `frame-src` from `'none'` to `https:` — read the existing CSP block at lines ~249–267 to confirm shape).

If any of these no longer match (the worktree drifts), pause and reconcile before proceeding.

---

## Task 1: Define `AgentReference` Shared Type and Utilities

**Goal:** Land a strict, multi-result-friendly reference model with full test coverage. No virtual paths, no enum widening, no missing branches.

**Files:**
- Create: `src/types/agent-reference.ts`
- Create: `src/renderer/src/features/agent-chat/references/referenceUtils.ts`
- Create: `src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts`

### Step 1: Write failing reference tests

Create `src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  AttachmentItem,
  ArtifactItem,
  FileEditItem,
  ShellItem,
} from '../../../../../../types/agent-timeline'
import {
  makeFileReference,
  makeUrlReference,
  referencesFromTimelineItem,
} from '../referenceUtils'

describe('makeFileReference', () => {
  it('routes .ts files to the code preview behavior', () => {
    const ref = makeFileReference({ path: 'D:/repo/src/main.ts' })
    expect(ref.type).toBe('file')
    expect(ref.label).toBe('main.ts')
    expect(ref.source).toEqual({ kind: 'localPath', path: 'D:/repo/src/main.ts' })
    expect(ref.openBehavior).toBe('code')
  })

  it('routes .md files to markdown', () => {
    const ref = makeFileReference({ path: 'D:/repo/README.md' })
    expect(ref.openBehavior).toBe('markdown')
  })

  it('routes images by mime', () => {
    const ref = makeFileReference({ path: 'D:/repo/logo.png', mime: 'image/png' })
    expect(ref.openBehavior).toBe('image')
  })

  it('routes PDFs by extension', () => {
    const ref = makeFileReference({ path: 'D:/repo/spec.pdf' })
    expect(ref.openBehavior).toBe('pdf')
  })
})

describe('makeUrlReference', () => {
  it('marks non-http(s) URLs as error so the chip and preview both block', () => {
    const ref = makeUrlReference('javascript:alert(1)')
    // Phase 1 does not have a separate 'external' open behavior; the
    // safe/unsafe split is owned by UrlPreview + validateExternalUrl.
    expect(ref.openBehavior).toBe('url')
    expect(ref.status).toBe('error')
  })

  it('extracts host and path for https', () => {
    const ref = makeUrlReference('https://developers.openai.com/codex/mcp')
    expect(ref.type).toBe('url')
    expect(ref.label).toBe('developers.openai.com/codex/mcp')
    expect(ref.openBehavior).toBe('url')
    expect(ref.source).toEqual({ kind: 'url', url: 'https://developers.openai.com/codex/mcp' })
  })
})

describe('referencesFromTimelineItem', () => {
  it('returns a single shell reference with execution metadata', () => {
    const item: ShellItem = {
      type: 'shell',
      id: 'cmd_1',
      startedAt: 1,
      endedAt: 2,
      command: 'npm run test',
      cwd: 'D:/repo',
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }
    const refs = referencesFromTimelineItem(item)
    expect(refs).toHaveLength(1)
    const [ref] = refs
    expect(ref.type).toBe('command')
    expect(ref.label).toBe('npm run test')
    expect(ref.openBehavior).toBe('shellOutput')
    expect(ref.status).toBe('success')
  })

  it('marks shell items with missing exit code as error rather than ready', () => {
    const item: ShellItem = {
      type: 'shell',
      id: 'cmd_2',
      startedAt: 1,
      endedAt: 2,
      command: 'npm run test',
      stdout: '',
      stderr: '',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.status).toBe('error')
  })

  it('maps activity cancelled to stale, not raw cancelled', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'mcp_1',
      startedAt: 1,
      endedAt: 2,
      kind: 'mcpToolCall',
      label: 'mcp:github/get_file_contents',
      detail: '{"owner":"openai"}',
      status: 'cancelled',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('mcp')
    expect(ref.status).toBe('stale')
    expect(ref.openBehavior).toBe('jsonResource')
  })

  it('emits a real URL reference for webSearch (not a JSON resource)', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'ws_1',
      startedAt: 1,
      endedAt: 2,
      kind: 'webSearch',
      label: 'Codex MCP docs',
      detail: 'https://developers.openai.com/codex/mcp',
      status: 'success',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('url')
    expect(ref.openBehavior).toBe('url')
    expect(ref.source).toEqual({ kind: 'url', url: 'https://developers.openai.com/codex/mcp' })
  })

  it('emits one reference per attachment (not just the first)', () => {
    const item: AttachmentItem = {
      type: 'attachment',
      id: 'att_1',
      startedAt: 1,
      attachments: [
        { id: 'a1', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
        { id: 'a2', kind: 'image', name: 'two.png', mime: 'image/png', size: 1, uri: 'local-file:///D:/r/two.png' },
      ],
    }
    const refs = referencesFromTimelineItem(item)
    expect(refs).toHaveLength(2)
    expect(refs[0].label).toBe('one.ts')
    expect(refs[1].openBehavior).toBe('image')
  })

  it('decodes local-file URIs cross-platform (Windows + POSIX)', () => {
    const winItem: AttachmentItem = {
      type: 'attachment', id: 'att_w', startedAt: 1,
      attachments: [
        { id: 'w1', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
      ],
    }
    const [winRef] = referencesFromTimelineItem(winItem)
    expect(winRef.source).toEqual({ kind: 'localPath', path: 'D:/r/one.ts' })

    const posixItem: AttachmentItem = {
      type: 'attachment', id: 'att_p', startedAt: 1,
      attachments: [
        { id: 'p1', kind: 'file', name: 'b.ts', mime: 'text/typescript', size: 1, uri: 'local-file:////Users/me/b.ts' },
      ],
    }
    const [posixRef] = referencesFromTimelineItem(posixItem)
    // POSIX path must keep its leading slash — failing this means cross-platform regression.
    expect(posixRef.source).toEqual({ kind: 'localPath', path: '/Users/me/b.ts' })

    const encodedItem: AttachmentItem = {
      type: 'attachment', id: 'att_e', startedAt: 1,
      attachments: [
        { id: 'e1', kind: 'file', name: 'with space.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/with%20space.ts' },
      ],
    }
    const [encodedRef] = referencesFromTimelineItem(encodedItem)
    expect(encodedRef.source).toEqual({ kind: 'localPath', path: 'D:/r/with space.ts' })
  })

  it('namespaces artifact references separately from attachments', () => {
    const item: ArtifactItem = {
      type: 'artifact',
      id: 'art_1',
      startedAt: 1,
      artifacts: [
        { id: 'shared', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
      ],
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.id.startsWith('artifact:')).toBe(true)
  })

  it('drops attachment references with traversal in their URI', () => {
    const traversalItem: AttachmentItem = {
      type: 'attachment',
      id: 'evil_1',
      startedAt: 1,
      attachments: [
        { id: 'safe', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
        { id: 'traversal', kind: 'file', name: 'evil.txt', mime: 'text/plain', size: 1, uri: 'local-file:///D:/r/../../etc/passwd' },
        { id: 'encoded', kind: 'file', name: 'enc.txt', mime: 'text/plain', size: 1, uri: 'local-file:///D:/r/%2e%2e/etc/passwd' },
        { id: 'wrong-scheme', kind: 'file', name: 'h.html', mime: 'text/html', size: 1, uri: 'https://evil.example.com/x' },
      ],
    }
    const refs = referencesFromTimelineItem(traversalItem)
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('one.ts')
    expect(refs[0].source).toEqual({ kind: 'localPath', path: 'D:/r/one.ts' })
  })

  it('returns a diff reference for file edits', () => {
    const item: FileEditItem = {
      type: 'fileEdit',
      id: 'edit_1',
      startedAt: 1,
      endedAt: 2,
      changes: [{ path: 'a.ts', operation: 'edit', diff: '', added: 1, removed: 1 }],
      totalAdded: 1,
      totalRemoved: 1,
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('artifact')
    expect(ref.openBehavior).toBe('diff')
  })

  it('returns an empty list for text/reasoning items', () => {
    expect(referencesFromTimelineItem({
      type: 'text', id: 't_1', startedAt: 1, content: 'hi',
    })).toEqual([])
    expect(referencesFromTimelineItem({
      type: 'reasoning', id: 'r_1', startedAt: 1, content: 'hi',
    })).toEqual([])
  })
})
```

### Step 2: Run failing tests

Run: `npm run test:run -- src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts`

Expected: FAIL because `agent-reference.ts` and `referenceUtils.ts` do not exist.

### Step 3: Add `AgentReference` shared type

Create `src/types/agent-reference.ts`:

```typescript
// Phase 1 schema is intentionally minimal — only the types Phase 1 actually
// produces and consumes ship now. Phase 2 will reintroduce 'selection',
// 'github', 'mcp' / 'github' / 'inline' source kinds, line-range preview
// fields, and AgentReferenceExecutionPolicy WHEN they have consumers.
// Premature union members force exhaustive `Record<>` lookups to carry
// no-op slots, which future maintainers misread as "consumed somewhere".
export type AgentReferenceType =
  | 'file'
  | 'url'
  | 'command'
  | 'mcp'
  | 'image'
  | 'artifact'
  | 'activity'

export type AgentReferenceStatus =
  | 'ready'
  | 'running'
  | 'success'
  | 'error'
  | 'stale'

/**
 * Phase 1 open behaviors. `code/markdown/image/pdf` route through the
 * existing local-file viewers (FileViewer, ImageViewer, inline `<embed>`).
 * `url/shellOutput/diff/jsonResource` produce synthetic reference tabs.
 * Phase 2 may extend this.
 */
export type AgentReferenceOpenBehavior =
  | 'code'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'url'
  | 'shellOutput'
  | 'diff'
  | 'jsonResource'

export type AgentReferenceSource =
  | { kind: 'localPath'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'codexItem'; itemId: string }

export interface AgentReferencePreview {
  mime?: string
  summary?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  cwd?: string
  json?: unknown
  thumbnailUri?: string
}

export interface AgentReference {
  id: string
  type: AgentReferenceType
  label: string
  source: AgentReferenceSource
  status: AgentReferenceStatus
  openBehavior: AgentReferenceOpenBehavior
  preview?: AgentReferencePreview
}
```

### Step 4: Add reference utility implementation

Create `src/renderer/src/features/agent-chat/references/referenceUtils.ts`:

```typescript
import type {
  AgentReference,
  AgentReferenceOpenBehavior,
  AgentReferenceStatus,
  AgentReferenceType,
} from '../../../../../types/agent-reference'
import type {
  ActivityItem,
  ArtifactItem,
  AttachmentItem,
  AttachmentRef,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'

const URL_REGEX = /https?:\/\/[^\s]+/i

function createReferenceId(prefix: string, value: string): string {
  return `${prefix}:${value}`
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

function labelForUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

function openBehaviorForFile(name: string, mime?: string): AgentReferenceOpenBehavior {
  const lower = name.toLowerCase()
  if (mime?.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  return 'code'
}

/**
 * Decode a `local-file://` URI into a filesystem path that works on Windows
 * AND POSIX, AND rejects attacker-influenced traversal / non-local-file URIs.
 *
 * Returns '' (empty string) for any unsafe input. Callers MUST treat empty
 * string as "drop this reference" — never feed it into `openTab` / `fs.stat`.
 *
 * Examples (safe):
 *   Windows: `local-file:///D:/r/two.png` → `D:/r/two.png`
 *   POSIX:   `local-file:////Users/me/x`  → `/Users/me/x`
 *
 * Examples (rejected → ''):
 *   `https://evil.example.com/secret`         (wrong scheme)
 *   `local-file:///D:/r/../../etc/passwd`     (traversal segment)
 *   `local-file:///%2e%2e/etc/passwd`         (encoded traversal)
 *   `local-file://relative/path.txt`          (not absolute)
 */
function localPathFromUri(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'local-file:') return ''
    const decoded = decodeURIComponent(url.pathname)
    // Reject any traversal segment, even encoded ones.
    if (decoded.split(/[\\/]/).some((seg) => seg === '..')) return ''
    // Strip leading `/` only when it precedes a Windows drive letter (e.g. `/D:/...`).
    const stripped = decoded.replace(/^\/(?=[A-Za-z]:)/, '')
    // Require an absolute path: POSIX `/`-prefix or Windows drive-letter prefix.
    const isAbsolute = stripped.startsWith('/') || /^[A-Za-z]:[\\/]/.test(stripped)
    return isAbsolute ? stripped : ''
  } catch {
    return ''
  }
}

export function makeFileReference(input: {
  path: string
  name?: string
  mime?: string
}): AgentReference {
  const name = input.name ?? basename(input.path)
  return {
    id: createReferenceId('file', input.path),
    type: 'file',
    label: name,
    source: { kind: 'localPath', path: input.path },
    status: 'ready',
    openBehavior: openBehaviorForFile(name, input.mime),
    preview: { mime: input.mime },
  }
}

export function makeUrlReference(url: string): AgentReference {
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  const isSafe = parsed != null && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
  // Always emit `openBehavior: 'url'`; UrlPreview owns the safe/unsafe split
  // via `validateExternalUrl`. Encoding "this URL is unsafe" twice (here AND
  // in UrlPreview) just creates two sources of truth that drift.
  return {
    id: createReferenceId('url', url),
    type: 'url',
    label: isSafe ? labelForUrl(url) : url,
    source: { kind: 'url', url },
    status: isSafe ? 'ready' : 'error',
    openBehavior: 'url',
  }
}

function shellStatus(item: ShellItem): AgentReferenceStatus {
  if (!item.endedAt) return 'running'
  if (item.exitCode == null) return 'error' // ended without exit code → unknown failure
  return item.exitCode === 0 ? 'success' : 'error'
}

function referenceFromShellItem(item: ShellItem): AgentReference {
  return {
    id: createReferenceId('command', item.id),
    type: 'command',
    label: item.command || 'command',
    source: { kind: 'codexItem', itemId: item.id },
    status: shellStatus(item),
    openBehavior: 'shellOutput',
    preview: {
      command: item.command,
      cwd: item.cwd,
      stdout: item.stdout,
      stderr: item.stderr,
      exitCode: item.exitCode,
    },
  }
}

function activityStatus(input: ActivityItem['status'], hasEnded: boolean): AgentReferenceStatus {
  switch (input) {
    case 'success': return 'success'
    case 'error': return 'error'
    case 'running': return 'running'
    case 'cancelled': return 'stale'
    case undefined: return hasEnded ? 'success' : 'running'
  }
}

function extractFirstUrl(...sources: Array<string | undefined>): string | null {
  for (const source of sources) {
    if (!source) continue
    const match = source.match(URL_REGEX)
    if (match) return match[0]
  }
  return null
}

function activityType(kind: string): AgentReferenceType {
  if (kind === 'mcpToolCall') return 'mcp'
  if (kind === 'webSearch') return 'url'
  return 'activity'
}

function referenceFromActivityItem(item: ActivityItem): AgentReference {
  const type = activityType(item.kind)

  if (type === 'url') {
    const url = extractFirstUrl(item.detail, item.label)
    if (url) {
      // webSearch with a usable URL — produce a real URL reference so the
      // chip and preview surfaces stay coherent (open behavior, source kind,
      // and preview tab routing all line up).
      return {
        id: createReferenceId('url', url),
        type: 'url',
        label: item.label ?? labelForUrl(url),
        source: { kind: 'url', url },
        status: activityStatus(item.status, item.endedAt != null),
        openBehavior: 'url',
        preview: { summary: item.detail },
      }
    }
  }

  // Fall-through: webSearch without an extractable URL must NOT keep
  // `type: 'url'` while routing to the JSON preview — the chip would say "url"
  // and the preview would render JSON. Downgrade to 'activity' for coherence.
  const safeType: AgentReferenceType = type === 'url' ? 'activity' : type
  return {
    id: createReferenceId(safeType, item.id),
    type: safeType,
    label: item.label ?? item.kind,
    source: { kind: 'codexItem', itemId: item.id },
    status: activityStatus(item.status, item.endedAt != null),
    openBehavior: 'jsonResource',
    preview: {
      summary: item.detail,
      json: { kind: item.kind, label: item.label, detail: item.detail, status: item.status },
    },
  }
}

function referenceFromFileEditItem(item: FileEditItem): AgentReference {
  return {
    id: createReferenceId('fileEdit', item.id),
    type: 'artifact',
    label: `${item.changes.length} file change${item.changes.length === 1 ? '' : 's'}`,
    source: { kind: 'codexItem', itemId: item.id },
    status: item.endedAt ? 'success' : 'running',
    openBehavior: 'diff',
    preview: { json: item.changes },
  }
}

// Returns null when the AttachmentRef's URI fails the security gate
// (non-`local-file:` scheme, traversal segment, or relative path). The caller
// MUST drop these — never return a reference whose source path is empty,
// because the chip would look usable while clicking it would either fall
// through to a broken read or escape via a stale absolute path elsewhere
// in the call chain.
function referenceFromAttachmentRef(prefix: 'attachment' | 'artifact', ref: AttachmentRef): AgentReference | null {
  const localPath = localPathFromUri(ref.uri)
  if (!localPath) return null
  return {
    id: createReferenceId(prefix, ref.id),
    type: ref.kind === 'image' ? 'image' : 'file',
    label: ref.name,
    source: { kind: 'localPath', path: localPath },
    status: 'ready',
    openBehavior: openBehaviorForFile(ref.name, ref.mime),
    preview: { mime: ref.mime, thumbnailUri: ref.thumbnailUri },
  }
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}

export function referencesFromTimelineItem(item: TimelineItem): AgentReference[] {
  switch (item.type) {
    case 'shell':
      return [referenceFromShellItem(item)]
    case 'activity':
      return [referenceFromActivityItem(item)]
    case 'fileEdit':
      return [referenceFromFileEditItem(item)]
    case 'attachment': {
      const attachmentItem = item as AttachmentItem
      return attachmentItem.attachments
        .map((ref) => referenceFromAttachmentRef('attachment', ref))
        .filter(nonNull)
    }
    case 'artifact': {
      const artifactItem = item as ArtifactItem
      return artifactItem.artifacts
        .map((ref) => referenceFromAttachmentRef('artifact', ref))
        .filter(nonNull)
    }
    case 'text':
    case 'reasoning':
      return []
  }
}

/**
 * Convenience for callers that only want the primary (first) reference.
 * Returns null when the item produces none.
 */
export function primaryReferenceFromTimelineItem(item: TimelineItem): AgentReference | null {
  return referencesFromTimelineItem(item)[0] ?? null
}
```

### Step 5: Run tests to verify they pass

Run: `npm run test:run -- src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts`

Expected: PASS.

### Step 6: Run typecheck

Run: `npm run typecheck`

Expected: PASS or fail only on documented pre-existing repository issues. Any new error in files touched in this task must be fixed before commit.

### Step 7: Commit Task 1

Commit message: `feat: add agent reference type and utilities`

---

## Task 2: Add Reference Tab Kind, `openReference` Action, and File-Watcher Gating

**Goal:** Land the workspace-side state primitives. Crucially, **delegate `code`/`markdown`/`image`/`pdf` references with `localPath` source to the existing `openTab` flow** so `FileViewer` / `ImageViewer` / the inline PDF `<embed>` are reused. Synthesize a `kind: 'reference'` tab only for `url`, `shellOutput`, `jsonResource`, `diff`, and `external` open behaviors. Gate file-watcher and dirty-close logic on `tab.kind !== 'reference'` so reference tabs cannot collide with filesystem paths.

**Files:**
- Modify: `src/renderer/src/features/file-explorer/types.ts`
- Modify: `src/renderer/src/features/file-explorer/store.ts`
- Create: `src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts`

### Step 1: Write failing store tests

Create `src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { useFileExplorerStore } from '../store'

const shellRef: AgentReference = {
  id: 'command:cmd_1',
  type: 'command',
  label: 'npm run test',
  source: { kind: 'codexItem', itemId: 'cmd_1' },
  status: 'success',
  openBehavior: 'shellOutput',
  preview: { command: 'npm run test', cwd: 'D:/repo', stdout: 'ok', stderr: '', exitCode: 0 },
}

const fileRef: AgentReference = {
  id: 'file:D:/repo/src/main.ts',
  type: 'file',
  label: 'main.ts',
  source: { kind: 'localPath', path: 'D:/repo/src/main.ts' },
  status: 'ready',
  openBehavior: 'code',
}

describe('file explorer reference tabs', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({
      tabs: [],
      activeTabId: null,
      conflict: null,
      pendingChatInsert: null,
    })
  })

  it('opens a synthetic reference tab for shell-output references', async () => {
    await useFileExplorerStore.getState().openReference(shellRef)
    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ kind: 'reference', referenceKey: shellRef.id })
    expect(state.tabs[0].path).toBe('') // synthetic tabs MUST NOT borrow filesystem paths
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('focuses an existing reference tab instead of duplicating it', async () => {
    await useFileExplorerStore.getState().openReference(shellRef)
    await useFileExplorerStore.getState().openReference(shellRef)
    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
  })

  it('delegates local-path file references to openTab so FileViewer is reused', async () => {
    const openTab = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openTab } as never)
    await useFileExplorerStore.getState().openReference(fileRef)
    expect(openTab).toHaveBeenCalledWith('D:/repo/src/main.ts', 'workspace')
    expect(useFileExplorerStore.getState().tabs).toHaveLength(0)
  })

  it('blocks watcher matching from picking up reference tabs by path collision', async () => {
    await useFileExplorerStore.getState().openReference({
      ...shellRef,
      id: 'command:D:/repo/src/main.ts', // contrived id that resembles a path
    })
    // Reference tab synthetic path is '' so it cannot match any real file event.
    const tab = useFileExplorerStore.getState().tabs[0]
    expect(tab.path).toBe('')
    expect(tab.referenceKey).toBe('command:D:/repo/src/main.ts')
  })
})
```

### Step 2: Run the failing store tests

Run: `npm run test:run -- src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts`

Expected: FAIL because `FileTabKind` lacks `'reference'`, `FileTab` lacks `referenceKey`, and `openReference` does not exist.

### Step 3: Extend file explorer tab types

Modify `src/renderer/src/features/file-explorer/types.ts`:

```typescript
import type { EditorState } from '@codemirror/state'
import type { AgentReference } from '../../../../types/agent-reference'

export type FileSource = 'workspace' | 'attachments'

export type FileNode = {
  path: string
  name: string
  kind: 'file' | 'dir'
  source: FileSource
  mime?: string
  size?: number
  childrenLoaded?: boolean
  children?: FileNode[]
}

export type FileTabKind = 'text' | 'image' | 'pdf' | 'binary' | 'reference'

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
  /**
   * Set on synthetic reference tabs only. `path` is intentionally empty for
   * `kind === 'reference'` so the file watcher cannot match these tabs by
   * filesystem path. `referenceKey` is `AgentReference.id` and is used to
   * identify duplicate-open requests.
   */
  referenceKey?: string
  reference?: AgentReference
}

export type WatchEvent = {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  path: string
  mtime?: number
}

export type Conflict =
  | { tabId: string; diskContent: string; show: 'modal' | 'merge' }
  | null
```

### Step 4: Add `openReference` action and gate path-based logic

Modify `src/renderer/src/features/file-explorer/store.ts`:

1. Add `openReference` to `Actions`:

```typescript
import type { AgentReference } from '../../../../types/agent-reference'

type Actions = {
  // ...existing actions unchanged...
  openReference: (reference: AgentReference) => Promise<void>
}
```

2. Add the implementation inside `useFileExplorerStore`. The branch for `localPath` references with file-friendly behaviors delegates to `openTab` so the existing viewers are reused; everything else creates a synthetic tab:

```typescript
  openReference: async (reference) => {
    if (
      reference.source.kind === 'localPath' &&
      (reference.openBehavior === 'code' ||
        reference.openBehavior === 'markdown' ||
        reference.openBehavior === 'image' ||
        reference.openBehavior === 'pdf')
    ) {
      await get().openTab(reference.source.path, 'workspace')
      return
    }

    const existing = get().tabs.find((t) => t.referenceKey === reference.id)
    if (existing) {
      set({ activeTabId: existing.id, fxOpen: true })
      writeStorage(FX_OPEN_KEY, '1')
      return
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `ref-${Date.now()}-${Math.random().toString(36).slice(2)}`
    set((s) => ({
      fxOpen: true,
      activeTabId: id,
      tabs: [
        ...s.tabs,
        {
          id,
          path: '', // see FileTab.referenceKey docstring
          name: reference.label,
          source: 'workspace',
          kind: 'reference',
          state: null,
          diskContent: '',
          diskMtime: 0,
          dirty: false,
          referenceKey: reference.id,
          reference,
        },
      ],
    }))
    writeStorage(FX_OPEN_KEY, '1')
  },
```

3. Gate the existing chokidar handler so `kind === 'reference'` tabs are ignored by file events:

Replace the lookup at L78 of `store.ts`:

```typescript
const tab = getState().tabs.find((t) => t.path === event.path)
```

with:

```typescript
const tab = getState().tabs.find((t) => t.kind !== 'reference' && t.path === event.path)
```

4. Confirm `closeTab` already only invokes `getApi().fs.watchStop(tab.path)` when `tab.kind === 'text'` (it does — see L357 of the existing store). No change needed there.

### Step 5: Run store reference tests

Run: `npm run test:run -- src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts`

Expected: PASS.

### Step 6: Run typecheck and existing store tests

Run: `npm run typecheck && npm run test:run -- src/renderer/src/features/file-explorer/__tests__/store.test.ts`

Expected: PASS.

### Step 7: Commit Task 2

Commit message: `feat: add reference tab kind to file explorer store`

---

## Task 3: Add Real Preview Components

**Goal:** Land synthetic-tab preview components — `UrlPreview`, `ShellOutputPreview`, `JsonResourcePreview` — and a `ReferencePreview` dispatcher. **All URL handling routes through a single `validateExternalUrl` helper**. Iframe sandbox uses the safe set without `allow-same-origin`. JSON stringify is wrapped in `try/catch`. Reference tab content is wired into `FileExplorerPanel.ActiveViewer`.

**Files:**
- Create: `src/renderer/src/features/file-explorer/urlValidation.ts`
- Create: `src/renderer/src/features/file-explorer/UrlPreview.tsx`
- Create: `src/renderer/src/features/file-explorer/ShellOutputPreview.tsx`
- Create: `src/renderer/src/features/file-explorer/JsonResourcePreview.tsx`
- Create: `src/renderer/src/features/file-explorer/ReferencePreview.tsx`
- Modify: `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`
- Create: `src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts`
- Create: `src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx`
- Create: `src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx`
- Create: `src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx`

### Step 1: Write failing URL validation tests

Create `src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { validateExternalUrl } from '../urlValidation'

describe('validateExternalUrl', () => {
  it.each([
    'https://developers.openai.com',
    'https://example.com/path?q=1',
    'http://localhost:3000/preview',
  ])('accepts %s', (url) => {
    expect(validateExternalUrl(url)).toEqual({ ok: true, url })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'about:blank',
    'chrome://flags',
    'chrome-extension://abc/options.html',
    'blob:https://example.com/abc',
  ])('rejects %s', (url) => {
    const result = validateExternalUrl(url)
    expect(result.ok).toBe(false)
  })

  it('rejects malformed input safely', () => {
    expect(validateExternalUrl('not a url').ok).toBe(false)
    expect(validateExternalUrl('').ok).toBe(false)
  })
})
```

### Step 2: Run failing URL tests

Run: `npm run test:run -- src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts`

Expected: FAIL because `urlValidation.ts` does not exist.

### Step 3: Implement URL validator

Create `src/renderer/src/features/file-explorer/urlValidation.ts`:

```typescript
// Iframe embedding allows HTTPS only — `http://` is reachable via the
// "Open externally" button (still validated below) but is never embedded
// to avoid mixed-content downgrades on networks the user doesn't trust.
const IFRAME_PROTOCOLS = new Set(['https:'])
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:'])

export type UrlValidationResult =
  | { ok: true; url: string; embeddable: boolean }
  | { ok: false; reason: string }

export function validateExternalUrl(input: string): UrlValidationResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, reason: 'empty' }
  }
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `disallowed-scheme:${parsed.protocol}` }
  }
  return { ok: true, url: parsed.toString(), embeddable: IFRAME_PROTOCOLS.has(parsed.protocol) }
}
```

### Step 4: Write failing component tests

Create `src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { UrlPreview } from '../UrlPreview'

afterEach(cleanup)

const safeRef: AgentReference = {
  id: 'url:https://developers.openai.com',
  type: 'url',
  label: 'developers.openai.com',
  source: { kind: 'url', url: 'https://developers.openai.com' },
  status: 'ready',
  openBehavior: 'url',
}

const unsafeRef: AgentReference = {
  ...safeRef,
  source: { kind: 'url', url: 'javascript:alert(1)' },
}

describe('UrlPreview', () => {
  it('renders an iframe with a sandbox that omits allow-same-origin for safe URLs', () => {
    const { container } = render(<UrlPreview reference={safeRef} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    const sandbox = iframe?.getAttribute('sandbox') ?? ''
    expect(sandbox.split(/\s+/)).not.toContain('allow-same-origin')
    expect(sandbox.split(/\s+/)).toContain('allow-forms')
    expect(sandbox.split(/\s+/)).toContain('allow-popups')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('refuses to render iframe for unsafe schemes', () => {
    render(<UrlPreview reference={unsafeRef} />)
    expect(screen.queryByText(/Embedded preview blocked/i)).toBeTruthy()
  })
})
```

Create `src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { ShellOutputPreview } from '../ShellOutputPreview'

afterEach(cleanup)

const ref: AgentReference = {
  id: 'command:cmd_1',
  type: 'command',
  label: 'npm run test',
  source: { kind: 'codexItem', itemId: 'cmd_1' },
  status: 'success',
  openBehavior: 'shellOutput',
  preview: {
    command: 'npm run test',
    cwd: 'D:/repo',
    stdout: '\u001b[32mok\u001b[0m',
    stderr: '',
    exitCode: 0,
  },
}

describe('ShellOutputPreview', () => {
  it('shows command, cwd, exit, and strips ANSI escape codes from stdout', () => {
    render(<ShellOutputPreview reference={ref} />)
    expect(screen.getByText('npm run test')).toBeTruthy()
    expect(screen.getByText(/cwd:\s*D:\/repo/)).toBeTruthy()
    expect(screen.getByText(/exit:\s*0/)).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
    expect(screen.queryByText(/\u001b\[32m/)).toBeNull()
  })
})
```

Create `src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { JsonResourcePreview } from '../JsonResourcePreview'

afterEach(cleanup)

describe('JsonResourcePreview', () => {
  it('renders prettified JSON safely for normal payloads', () => {
    const ref: AgentReference = {
      id: 'mcp:test',
      type: 'mcp',
      label: 'mcp:test',
      source: { kind: 'codexItem', itemId: 'mcp_1' },
      status: 'success',
      openBehavior: 'jsonResource',
      preview: { json: { hello: 'world' } },
    }
    render(<JsonResourcePreview reference={ref} />)
    expect(screen.getByText(/"hello": "world"/)).toBeTruthy()
  })

  it('falls back to String(value) for circular structures without throwing', () => {
    const cyclic: { a?: unknown } = {}
    cyclic.a = cyclic
    const ref: AgentReference = {
      id: 'mcp:cyclic',
      type: 'mcp',
      label: 'mcp:cyclic',
      source: { kind: 'codexItem', itemId: 'cyclic_1' },
      status: 'success',
      openBehavior: 'jsonResource',
      preview: { json: cyclic },
    }
    expect(() => render(<JsonResourcePreview reference={ref} />)).not.toThrow()
    expect(screen.getByText(/Unable to render JSON|object/)).toBeTruthy()
  })
})
```

### Step 5: Run failing component tests

Run:

```bash
npm run test:run -- \
  src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx
```

Expected: FAIL.

### Step 6: Implement preview components

Create `src/renderer/src/features/file-explorer/UrlPreview.tsx`. The existing `BinaryViewer.tsx` already reaches `showItemInFolder` via `window.electronAPI?.shell` which is itself wired through `safeInvoke<IPC_CHANNELS.SHELL.SHOW_ITEM_IN_FOLDER>`; mirror that pattern. We do **not** add `import { shell } from 'electron'` to the renderer — even though `contextIsolation` is currently `false` in this codebase, treating the IPC channel as the security boundary keeps a single auditable main-side handler and survives a future flip to `contextIsolation: true`. If `openExternal` is not yet exposed in `src/preload/index.ts`, add it there as part of this task — the preload change is small and self-contained (see "preload + main-side handler" below):

```tsx
import type { AgentReference } from '../../../../types/agent-reference'
import { validateExternalUrl } from './urlValidation'

// Phase 1 sandbox is intentionally minimal:
//   - NO `allow-same-origin` (prevents iframe from reading parent origin / cookies / storage)
//   - NO `allow-popups-to-escape-sandbox` (popups stay sandboxed; window.open routes through
//     the parent's setWindowOpenHandler, which is the right chokepoint for external nav)
//   - NO `allow-forms` (no form submission from embedded pages — re-add when there's a
//     documented use case like an embedded login flow; not needed for URL preview)
// Result: scripts run, popups can spawn (and get rerouted), nothing else leaks.
const SAFE_SANDBOX = 'allow-popups allow-scripts'

type ShellBridge = { openExternal?: (url: string) => Promise<unknown> }

function openExternal(url: string): void {
  const validated = validateExternalUrl(url)
  if (!validated.ok) return
  const bridge = (window as Window & { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
  void bridge?.openExternal?.(validated.url)
}

export function UrlPreview({ reference }: { reference: AgentReference }) {
  const rawUrl = reference.source.kind === 'url' ? reference.source.url : ''
  const validated = validateExternalUrl(rawUrl)

  // Branch 1: URL fails the scheme allowlist entirely (e.g. javascript:, data:, file:).
  // Branch 2: URL is `http:` — allowed for "open externally" but never embedded
  //           (mixed-content downgrade risk on untrusted networks). Show summary card.
  // Branch 3: URL is `https:` — embed in iframe.
  if (!validated.ok) {
    return (
      <div className="flex h-full flex-col bg-zinc-950 p-4 text-xs text-zinc-200">
        <p className="font-medium text-amber-200">Embedded preview blocked</p>
        <p className="mt-1 opacity-70">
          The URL <code className="break-all text-amber-100">{rawUrl}</code> uses a scheme
          that is not allowed inside the workspace iframe.
        </p>
      </div>
    )
  }

  if (!validated.embeddable) {
    return (
      <div className="flex h-full flex-col bg-zinc-950 p-4 text-xs text-zinc-200">
        <p className="font-medium text-amber-200">HTTP preview not embedded</p>
        <p className="mt-1 opacity-70">
          The URL <code className="break-all text-amber-100">{validated.url}</code> uses
          plain <code>http</code>; embedding it in the workspace would expose it to active
          network attackers. Open it in your browser instead.
        </p>
        <button
          type="button"
          className="mt-3 self-start rounded border border-zinc-700 px-2 py-1 text-[11px] hover:border-cyan-400/50"
          onClick={() => openExternal(validated.url)}
        >
          Open external (validated)
        </button>
      </div>
    )
  }

  const url = validated.url

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">
        <span className="truncate">{url}</span>
        <button
          type="button"
          className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] hover:border-cyan-400/50"
          onClick={() => openExternal(url)}
        >
          Open external
        </button>
      </div>
      <iframe
        title={reference.label}
        src={url}
        sandbox={SAFE_SANDBOX}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    </div>
  )
}
```

If `shell.openExternal` is not yet exposed by the preload, add it — but route it through the existing `safeInvoke` IPC pattern (matching `IPC_CHANNELS.SHELL.SHOW_ITEM_IN_FOLDER` already in this codebase). DO NOT call `shell.openExternal` directly from the preload: the renderer is `contextIsolation: false`, so any compromised renderer code could otherwise reach the function with arbitrary input; routing through IPC gives us a single auditable handler in main where we re-run `validateExternalUrl` before hitting the OS.

```typescript
// src/preload/index.ts — extend the existing IPC_CHANNELS.SHELL block
SHELL: {
  COPY_IMAGE: 'shell:copy-image',
  SAVE_AS: 'shell:save-as',
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  OPEN_EXTERNAL: 'shell:open-external', // new
},

// src/preload/index.ts — extend the existing electronAPI.shell object literal
// (do NOT add `import { shell } from 'electron'` — keep the renderer-only
// preload surface free of direct main-process modules):
shell: {
  // …existing entries unchanged…
  openExternal: (url: string) =>
    safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.OPEN_EXTERNAL, url),
},
```

Add a main-side handler that re-validates the URL before calling `shell.openExternal`. `electron`'s `shell.openExternal` will hand `javascript:` and other dangerous schemes to the OS handler on some platforms, so this main-side gate is the security boundary — the renderer-side `validateExternalUrl` is only defense-in-depth. Place the handler alongside the existing `SHOW_ITEM_IN_FOLDER` handler in main:

```typescript
// src/main/<existing shell IPC module>.ts (additive)
import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels' // adjust to local convention

const ALLOWED = new Set(['http:', 'https:'])

function validateExternalUrlMain(input: string): { ok: true; url: string } | { ok: false } {
  try {
    const parsed = new URL(input)
    if (!ALLOWED.has(parsed.protocol)) return { ok: false }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false }
  }
}

ipcMain.handle(IPC_CHANNELS.SHELL.OPEN_EXTERNAL, async (_event, raw: unknown) => {
  if (typeof raw !== 'string') return { success: false, error: 'invalid_url' }
  const validated = validateExternalUrlMain(raw)
  if (!validated.ok) return { success: false, error: 'unsafe_scheme' }
  await shell.openExternal(validated.url)
  return { success: true }
})
```

#### Step 6a: Relax CSP `frame-src` so the iframe can actually load (P0 from doc-review)

**Problem.** `src/main/index.ts:263` currently sets `"frame-src 'none'"`, which blocks Chromium from attaching ANY iframe — including the new `UrlPreview`. Without this fix the preview component ships dead code: every URL falls through to "Embedded preview blocked" regardless of `validateExternalUrl`'s output. jsdom doesn't enforce CSP so the unit tests pass; the failure only surfaces at runtime in Electron.

**Fix.** Modify `src/main/index.ts:263` from `"frame-src 'none'"` to `"frame-src https:"`. This permits HTTPS-only embedded iframes (matching the `validateExternalUrl.embeddable` allowlist exactly). Do NOT add `http:` to `frame-src`; HTTP URLs still travel through "Open externally", not embedding.

```typescript
// src/main/index.ts — inside the existing onHeadersReceived CSP block
'Content-Security-Policy': [
  // …all existing directives unchanged…
  "frame-src https:",   // CHANGED FROM `frame-src 'none'`
].join('; ')
```

#### Step 6b: Reject cross-origin probing on the `local-file://` protocol (P1 from doc-review)

**Problem.** Once `frame-src` is loosened, an attacker page rendered inside `UrlPreview`'s iframe can probe local files via `<img src="local-file:///D:/secrets.txt">`, `<script src="local-file:///...">`, etc. CSP from the parent doesn't apply inside a sandboxed iframe with an opaque origin. CORS blocks opaque-body reads but cross-origin probes (image dimensions, script load events) can still leak file existence and metadata.

**Fix.** Modify `src/main/file-explorer/protocolHandler.ts:installLocalFileHandler` to reject any request whose `Sec-Fetch-Site` is not `same-origin` or `none`. The renderer's own `local-file://` reads (Image preview, PDF embed) come from `same-origin` because they're issued by the renderer that registered the scheme; iframe-originated requests come from `cross-site` and are rejected.

```typescript
// src/main/file-explorer/protocolHandler.ts — inside protocol.handle('local-file', ...)
export function installLocalFileHandler(): void {
  protocol.handle('local-file', async (request) => {
    // Sec-Fetch-Site is set by Chromium for navigations and subresource fetches.
    // The renderer's own reads (FileViewer, ImageViewer, BinaryViewer, PDF embed)
    // are 'same-origin' or 'none'; everything else (sandboxed iframes, popups,
    // attacker-controlled fetch initiators) lands as 'cross-site' / 'same-site'.
    const site = request.headers.get('Sec-Fetch-Site')
    if (site && site !== 'same-origin' && site !== 'none') {
      return new Response('Forbidden: cross-origin', { status: 403 })
    }

    const r = resolveOsPathFromRequest(request.url)
    if (!r.ok) {
      return new Response(`Forbidden: ${r.reason}`, { status: r.reason === 'traversal' ? 403 : 400 })
    }
    try {
      return await net.fetch(pathToFileURL(r.path).toString())
    } catch (err) {
      return new Response(`local-file fetch error: ${String(err)}`, { status: 500 })
    }
  })
}
```

Add a Vitest case to `src/main/file-explorer/__tests__/protocolHandler.test.ts` (or create one alongside the existing handler tests) asserting that requests with `Sec-Fetch-Site: cross-site` get a 403, and requests without the header (or with `same-origin`/`none`) succeed for in-tree paths.

#### Step 6c: Container-level path containment for `fs:read-text` / `fs:list-dir` / `fs:stat` (P0 from doc-review)

**Problem.** The plan exposes `openReference({ source: { kind: 'localPath', path } })` and routes file-shaped references through the existing `openTab` → `fs:read-text` / `fs:stat` IPC handlers. Those handlers (`src/main/file-explorer/fsIpc.ts:44-86`) currently pass the path straight to `fs.stat` / `fs.readFile` with **no containment check**.

`AgentManager.applyAssistantEvent.applyItemPatch` accepts arbitrary `patch.fields` for `attachment` items, so a Codex-emitted (or MCP-tool-derived, or web-search-derived) `attachment` whose `attachments[].uri` is attacker-controlled can produce a reference with `source.path = '../../../../etc/passwd'` or `D:/Users/<victim>/.aws/credentials`. One user click on the chip → file content read into the renderer.

**Fix (renderer-side defense-in-depth).** Task 1 Step 4 already lands the strict `localPathFromUri` (rejects non-`local-file:` schemes, `..` segments, and non-absolute paths) AND `referenceFromAttachmentRef` already drops references whose source path comes back empty. **Do not redefine `localPathFromUri` in Task 3** — re-read Task 1 Step 4 and confirm that helper is exported (or co-located) so the same definition is reused. The renderer-side gate is defense-in-depth only.

**Fix (main-side security boundary, REQUIRED).** Wrap the existing fs handlers with workspace-roots containment. Reuse `resolveOsPathFromRequest`'s `..` rejection style (already battle-tested in `protocolHandler.ts`), plus a containment check against persisted workspace roots and the agent uploads directory:

```typescript
// src/main/file-explorer/fsIpc.ts — additive
import { app } from 'electron'

// Lazy because tests stub the IPC layer; production wires this once at boot.
let allowedRoots: string[] | null = null

export function setFsAllowedRoots(roots: string[]): void {
  allowedRoots = roots.map((r) => path.resolve(r))
}

function resolveAllowedRoots(): string[] {
  const fromCaller = allowedRoots ?? []
  // The agent uploads dir is always allowed — those paths are sha256-named under userData.
  const uploadsDir = path.resolve(app.getPath('userData'), 'agent', 'uploads')
  return [...fromCaller, uploadsDir]
}

function isInsideAllowedRoot(target: string): boolean {
  const resolved = path.resolve(target)
  return resolveAllowedRoots().some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

function assertContained(p: string): void {
  if (!isInsideAllowedRoot(p)) {
    throw new Error('fs path outside allowed roots')
  }
}
```

Update each existing handler to call `assertContained(p)` before touching the disk:

```typescript
export async function handleReadText(p: string): Promise<{ content: string; mtime: number }> {
  assertContained(p)
  // ...existing body...
}

export async function handleWriteText(args: { path: string; content: string }): Promise<{ mtime: number }> {
  assertContained(args.path)
  // ...existing body...
}

export async function handleListDir(p: string): Promise<FileNodeIpc[]> {
  assertContained(p)
  // ...existing body...
}

export async function handleStat(p: string): Promise<...> {
  try {
    assertContained(p)
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
  // ...existing body...
}
```

Wire `setFsAllowedRoots(...)` from the renderer's persisted workspace roots. The cleanest place is the same `addFolder` / `removeFolder` actions that already maintain the workspace tree — when those mutate, push the new root list over IPC (`fs:set-allowed-roots`) and let main update its allow-list. The IPC takes only string array input; main filters out anything that isn't an absolute existing directory.

**Tests.**
- `src/main/file-explorer/__tests__/fsIpc.containment.test.ts`: assert `handleReadText('/etc/passwd')` rejects when the allow-list excludes `/`; assert it succeeds when the allow-list contains the file's parent; assert `..` traversal is rejected even when the resolved canonical path would land inside an allowed root.
- `src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts`: extend the cross-platform test with a traversal case — `'local-file:///D:/r/../../etc/passwd'` MUST produce an empty-string source path, and `referenceFromAttachmentRef` MUST surface that as a dropped reference (not a ready chip).

**Implementation note.** This work is the security boundary that justifies introducing `openReference`. Do NOT ship the rest of Task 3 without it; otherwise Phase 1 actively widens the attack surface beyond Phase 0's posture.

Create `src/renderer/src/features/file-explorer/ShellOutputPreview.tsx`:

```tsx
import type { AgentReference } from '../../../../types/agent-reference'

const ANSI_REGEX = /\u001b\[[0-9;]*m/g

function stripAnsi(input: string | undefined): string {
  if (!input) return ''
  return input.replace(ANSI_REGEX, '')
}

export function ShellOutputPreview({ reference }: { reference: AgentReference }) {
  const preview = reference.preview
  const stdout = stripAnsi(preview?.stdout)
  const stderr = stripAnsi(preview?.stderr)
  return (
    <div className="h-full overflow-auto bg-zinc-950 p-3 text-xs text-zinc-200">
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Command</div>
        <code className="mt-1 block break-all text-cyan-50">{preview?.command ?? reference.label}</code>
        {preview?.cwd ? <div className="mt-2 text-zinc-500">cwd: {preview.cwd}</div> : null}
        {preview?.exitCode != null ? <div className="mt-1 text-zinc-500">exit: {preview.exitCode}</div> : null}
      </div>
      {stdout ? <pre className="whitespace-pre-wrap text-zinc-200">{stdout}</pre> : null}
      {stderr ? <pre className="mt-3 whitespace-pre-wrap text-red-300/90">{stderr}</pre> : null}
      {!stdout && !stderr ? <p className="italic text-zinc-600">No output</p> : null}
    </div>
  )
}
```

Create `src/renderer/src/features/file-explorer/JsonResourcePreview.tsx`:

```tsx
import type { AgentReference } from '../../../../types/agent-reference'

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return `Unable to render JSON: ${typeof value === 'object' ? '[object]' : String(value)}`
  }
}

export function JsonResourcePreview({ reference }: { reference: AgentReference }) {
  const value = reference.preview?.json ?? reference.preview?.summary ?? reference
  const text = safeStringify(value)

  return (
    <div className="h-full overflow-auto bg-zinc-950 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">
        {reference.type}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200">
        {text}
      </pre>
    </div>
  )
}
```

Create `src/renderer/src/features/file-explorer/ReferencePreview.tsx`:

```tsx
import type { AgentReference } from '../../../../types/agent-reference'
import { JsonResourcePreview } from './JsonResourcePreview'
import { ShellOutputPreview } from './ShellOutputPreview'
import { UrlPreview } from './UrlPreview'

/**
 * Dispatcher for SYNTHETIC reference tabs (kind: 'reference'). Local-path
 * file/image/PDF references must NOT reach this component — `openReference`
 * delegates them to `openTab` so the existing FileViewer / ImageViewer /
 * inline `<embed>` PDF viewer are reused. If those branches ever do hit
 * this dispatcher in production, fall back to the JSON inspector with an
 * explicit "unsupported preview" header rather than silently rendering
 * a misleading view.
 */
export function ReferencePreview({ reference }: { reference: AgentReference }) {
  switch (reference.openBehavior) {
    case 'url':
      return <UrlPreview reference={reference} />
    case 'shellOutput':
      return <ShellOutputPreview reference={reference} />
    case 'jsonResource':
    case 'diff':
      return <JsonResourcePreview reference={reference} />
    case 'code':
    case 'markdown':
    case 'image':
    case 'pdf':
      return (
        <div className="flex h-full flex-col gap-2 p-4 text-xs text-amber-200">
          <p>This reference points at a file but reached the synthetic-preview dispatcher.</p>
          <p className="opacity-70">
            Open the file from the file explorer instead — local-path file references
            should be delegated to the existing viewer.
          </p>
        </div>
      )
  }
}
```

### Step 7: Wire reference tabs into `FileExplorerPanel.ActiveViewer`

Modify `src/renderer/src/features/file-explorer/FileExplorerPanel.tsx`'s `ActiveViewer` switch:

```tsx
import { ReferencePreview } from './ReferencePreview'

// ...inside ActiveViewer:
  switch (tab.kind) {
    case 'text':
      return <FileViewer tab={tab} />
    case 'image':
      return <ImageViewer tab={tab} />
    case 'pdf':
      return <embed src={`local-file:///${tab.path.replace(/\\/g, '/')}`} type="application/pdf" className="h-full w-full" />
    case 'binary':
      return <BinaryViewer tab={tab} />
    case 'reference':
      return tab.reference
        ? <ReferencePreview reference={tab.reference} />
        : (
          <div className="p-4 text-xs text-amber-200">
            Reference tab is missing its payload.
          </div>
        )
  }
```

### Step 8: Run all preview tests + typecheck

Run:

```bash
npm run test:run -- \
  src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts \
  src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 9: Commit Task 3

Commit message: `feat: add reference preview components with safe url sandbox`

---

## Task 4: Add `ReferenceChip` and Timeline Card Open Actions

**Goal:** Land the chip component plus "Open" buttons on the four timeline cards that produce references. Uses `referencesFromTimelineItem` (multi-result aware) so messages with multiple attachments expose multiple chips. Card "Open" tests assert behavior, not internal Zustand wiring.

**Files:**
- Create: `src/renderer/src/features/agent-chat/references/ReferenceChip.tsx`
- Create: `src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/cards/ShellCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/cards/AttachmentCard.tsx`
- Modify: `src/renderer/src/features/agent-chat/cards/FileEditCard.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx`
- Create: `src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx`

### Step 1: Write failing chip + card tests

Create `src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../../types/agent-reference'
import { ReferenceChip } from '../ReferenceChip'

afterEach(cleanup)

const ref: AgentReference = {
  id: 'url:https://example.com',
  type: 'url',
  label: 'example.com',
  source: { kind: 'url', url: 'https://example.com' },
  status: 'ready',
  openBehavior: 'url',
}

describe('ReferenceChip', () => {
  it('renders the type and label', () => {
    render(<ReferenceChip reference={ref} />)
    expect(screen.getByText('url')).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
  })

  it('invokes onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(<ReferenceChip reference={ref} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith(ref)
  })
})
```

Create `src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { ShellCard } from '../ShellCard'

afterEach(cleanup)

const baseItem: ShellItem = {
  type: 'shell',
  id: 'cmd_1',
  startedAt: 1,
  endedAt: 2,
  command: 'npm run test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
}

describe('ShellCard reference action', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens shell output by calling openReference with a shellOutput reference', () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<ShellCard item={baseItem} />)
    fireEvent.click(screen.getByText(/Open output/i))

    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openReference.mock.calls[0]?.[0]).toMatchObject({
      type: 'command',
      label: 'npm run test',
      openBehavior: 'shellOutput',
    })
  })

  it('renders Open output even for empty-command items because label fallback derives a reference', () => {
    render(<ShellCard item={{ ...baseItem, command: '' }} />)
    expect(screen.queryByText(/Open output/i)).not.toBeNull()
  })
})
```

Create `src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { ActivityCard } from '../ActivityCard'

afterEach(cleanup)

const item: ActivityItem = {
  type: 'activity',
  id: 'mcp_1',
  startedAt: 1,
  endedAt: 2,
  kind: 'mcpToolCall',
  label: 'mcp:github/get_file_contents',
  detail: '{"owner":"openai","repo":"codex"}',
  status: 'success',
}

describe('ActivityCard reference action', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens MCP details via openReference', () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<ActivityCard item={item} />)
    fireEvent.click(screen.getByText(/Open details/i))

    expect(openReference).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mcp',
      openBehavior: 'jsonResource',
    }))
  })
})
```

### Step 2: Run failing chip + card tests

Run:

```bash
npm run test:run -- \
  src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx
```

Expected: FAIL — `ReferenceChip` not implemented; cards have no Open buttons yet.

### Step 3: Implement `ReferenceChip`

Create `src/renderer/src/features/agent-chat/references/ReferenceChip.tsx`:

```tsx
import type { AgentReference } from '../../../../../types/agent-reference'

const TYPE_LABELS: Record<AgentReference['type'], string> = {
  file: 'file',
  url: 'url',
  command: 'cmd',
  mcp: 'mcp',
  image: 'image',
  artifact: 'artifact',
  activity: 'activity',
}

export function ReferenceChip({
  reference,
  onOpen,
}: {
  reference: AgentReference
  onOpen?: (reference: AgentReference) => void
}) {
  const handleClick = (): void => {
    if (onOpen) onOpen(reference)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex max-w-[280px] items-center gap-1.5 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-100 hover:border-cyan-300/60"
      title={`${reference.type}: ${reference.label}`}
    >
      <span className="uppercase tracking-[0.16em] text-cyan-300/80">{TYPE_LABELS[reference.type]}</span>
      <span className="truncate">{reference.label}</span>
    </button>
  )
}
```

### Step 4: Add Open actions to cards

Modify `src/renderer/src/features/agent-chat/cards/ShellCard.tsx`. The card now derives the primary reference (single shell reference per item) and renders an "Open output" button below the existing toggle:

```tsx
import { useState } from 'react'
import type { ShellItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { primaryReferenceFromTimelineItem } from '../references/referenceUtils'

export function ShellCard({ item }: { item: ShellItem }) {
  const isRunning = !item.endedAt
  const [expanded, setExpanded] = useState(isRunning)
  const failed = item.exitCode != null && item.exitCode !== 0
  const openReference = useFileExplorerStore((state) => state.openReference)
  const reference = primaryReferenceFromTimelineItem(item)

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
      <div className="mt-1 flex flex-wrap gap-1">
        {reference ? (
          <button
            type="button"
            onClick={() => void openReference(reference)}
            className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
          >
            Open output
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(item.command)}
          className="rounded border border-zinc-700/70 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
        >
          Copy command
        </button>
      </div>
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

For `ActivityCard.tsx`, `AttachmentCard.tsx`, and `FileEditCard.tsx`, apply the same pattern, but use `referencesFromTimelineItem` so multi-attachment items get one button per attachment. The pattern below replaces or augments the existing card body — preserve all existing rendering / image lightbox behavior:

```tsx
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'

// Inside the component body, after existing rendering:
const openReference = useFileExplorerStore((state) => state.openReference)
const references = referencesFromTimelineItem(item)

{references.length > 0 ? (
  <div className="mt-1 flex flex-wrap gap-1">
    {references.map((reference) => (
      <button
        key={reference.id}
        type="button"
        onClick={() => void openReference(reference)}
        className="rounded border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10"
      >
        Open details
      </button>
    ))}
  </div>
) : null}
```

For `AttachmentCard.tsx`, label the buttons "Open file" or "Open image" based on `reference.type` — keep the existing image double-click lightbox unchanged.

### Step 5: Run chip + card tests + typecheck

Run:

```bash
npm run test:run -- \
  src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 6: Commit Task 4

Commit message: `feat: open codex outputs as references`

---

## Task 5: Default to Safer Codex Launch Posture (Read-Only Status Surface)

**Goal:** Stop hardcoding `approval_policy="never"` + `sandbox_mode="danger-full-access"`. Make `buildCodexLaunchArgs` accept an explicit `sessionConfig`; default it to `workspace-write` + `on-request` + `web_search` boolean = true (the currently documented Codex 0.128 surface). Extract the existing inlined provider block into `appendProviderArgs(args, provider)` *before* anything calls it. Surface the effective configuration via a read-only IPC handler and a `CodexStatusPanel`. **Do not introduce `setSessionConfig`** — Phase 2 will add it with confirmation gating.

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/codexLaunch.ts`
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/features/agent-chat/CodexStatusPanel.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Modify: `src/main/agent/__tests__/codexLaunch.test.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx`

### Step 1: Update `codexLaunch.test.ts` — keep regressions, swap legacy assertions

Modify `src/main/agent/__tests__/codexLaunch.test.ts`. The current file (read it before editing — it has six tests) only needs **two assertions swapped** (the ones that pin the legacy permissive defaults) and **three new tests added** (sessionConfig override, writableRoots, appendProviderArgs). DO NOT delete the existing regressions:

- "does not include the legacy `serve` subcommand"
- "omits provider overrides when no provider config is supplied"
- "passes `model_context_window` and `model_auto_compact_token_limit` so Codex auto-compacts"

The final file should have nine tests. The diffs against the existing file are:

1. In the existing default-args test, replace `expect(args).toContain('approval_policy="never"')` and `expect(args).toContain('sandbox_mode="danger-full-access"')` with the safe-default assertions below, and ADD the negative assertions to lock in the regression:

```typescript
expect(args).toContain('approval_policy="on-request"')
expect(args).toContain('sandbox_mode="workspace-write"')
expect(args).toContain('tools.web_search=true')
expect(args).not.toContain('approval_policy="never"')
expect(args).not.toContain('sandbox_mode="danger-full-access"')
```

2. Append three new tests at the bottom of the existing `describe('buildCodexLaunchArgs', ...)` block:

```typescript
it('accepts explicit unsafe overrides via sessionConfig', () => {
  const args = buildCodexLaunchArgs({
    listenUrl: 'ws://127.0.0.1:1234',
    sessionConfig: { approvalPolicy: 'never', sandboxMode: 'danger-full-access', webSearch: false },
  })

  expect(args).toContain('approval_policy="never"')
  expect(args).toContain('sandbox_mode="danger-full-access"')
  expect(args).toContain('tools.web_search=false')
})

it('forwards writableRoots as --add-dir flags', () => {
  const args = buildCodexLaunchArgs({
    listenUrl: 'ws://127.0.0.1:1234',
    sessionConfig: { writableRoots: ['D:/repo/sub'] },
  })
  const idx = args.indexOf('--add-dir')
  expect(idx).toBeGreaterThanOrEqual(0)
  expect(args[idx + 1]).toBe('D:/repo/sub')
})

it('uses appendProviderArgs to attach provider config when supplied', () => {
  const args = buildCodexLaunchArgs({
    listenUrl: 'ws://127.0.0.1:1234',
    provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
  })

  expect(args).toContain('model_provider="apiyi"')
  expect(args).toContain('model_providers.apiyi.base_url="https://api.apiyi.com/v1"')
  expect(args).toContain('model_providers.apiyi.wire_api="responses"')
})
```

### Step 2: Run failing launch tests

Run: `npm run test:run -- src/main/agent/__tests__/codexLaunch.test.ts`

Expected: FAIL — current `codexLaunch.ts` is hardcoded.

### Step 3: Add Codex session types

Modify `src/types/agent.ts` (do **not** extend `AgentSendMessagePayload` in Phase 1):

```typescript
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

export interface CodexSessionConfig {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  /** Codex 0.128 exposes web_search as a boolean toggle (`tools.web_search`). */
  webSearch: boolean
  writableRoots: string[]
}

export interface CodexSessionStatus {
  model: string
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  webSearch: boolean
  writableRoots: string[]
}
```

### Step 4: Make `codexLaunch.ts` configurable and extract `appendProviderArgs`

Modify `src/main/agent/codexLaunch.ts`. Preserve the existing top-of-file comment block. The new file (≤ 100 lines) is:

```typescript
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionConfig,
} from '../../types/agent'

export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

export const DEFAULT_CODEX_SESSION_CONFIG: CodexSessionConfig = {
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  webSearch: true,
  writableRoots: [],
}

export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
}

export interface CodexLaunchOptions {
  listenUrl?: string
  provider?: CodexProviderConfig
  sessionConfig?: Partial<CodexSessionConfig>
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function resolveSessionConfig(input?: Partial<CodexSessionConfig>): CodexSessionConfig {
  return {
    approvalPolicy: (input?.approvalPolicy ?? DEFAULT_CODEX_SESSION_CONFIG.approvalPolicy) as CodexApprovalPolicy,
    sandboxMode: (input?.sandboxMode ?? DEFAULT_CODEX_SESSION_CONFIG.sandboxMode) as CodexSandboxMode,
    webSearch: input?.webSearch ?? DEFAULT_CODEX_SESSION_CONFIG.webSearch,
    writableRoots: input?.writableRoots ?? DEFAULT_CODEX_SESSION_CONFIG.writableRoots,
  }
}

/**
 * Appends Codex `model_provider` config when a custom provider is supplied.
 * Extracted from the inline block that previously lived in `buildCodexLaunchArgs`
 * so callers (tests, future Phase 2 code) can reuse the exact same wiring.
 *
 * Mutates and returns `args` for ergonomic chaining; callers may also ignore
 * the return value.
 */
export function appendProviderArgs(
  args: string[],
  provider?: CodexProviderConfig,
): string[] {
  if (!provider) return args
  const id = provider.id
  args.push(
    '-c', `model_provider="${id}"`,
    '-c', `model_providers.${id}.name="${provider.name}"`,
    '-c', `model_providers.${id}.base_url="${provider.baseUrl}"`,
    '-c', `model_providers.${id}.env_key="${provider.envKey}"`,
    '-c', `model_providers.${id}.wire_api="responses"`,
  )
  return args
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  const sessionConfig = resolveSessionConfig(options?.sessionConfig)
  const args: string[] = [
    'app-server',
    '--listen', url,
    '-c', `approval_policy=${quote(sessionConfig.approvalPolicy)}`,
    '-c', `sandbox_mode=${quote(sessionConfig.sandboxMode)}`,
    '-c', `tools.web_search=${sessionConfig.webSearch ? 'true' : 'false'}`,
    '-c', 'show_raw_agent_reasoning=true',
    '-c', 'model_reasoning_summary="auto"',
    '-c', 'model_context_window=200000',
    '-c', 'model_auto_compact_token_limit=180000',
  ]

  for (const root of sessionConfig.writableRoots) {
    args.push('--add-dir', root)
  }

  return appendProviderArgs(args, options?.provider)
}
```

> **`web_search` config key.** This is the documented Codex 0.128 toggle (`tools.web_search`, see `~/.codex/config.toml`). Older internal tooling may have used a different key. The Phase 2 task that wires `setSessionConfig` will smoke-test this key against a real binary; if Codex changes the surface, Phase 2 absorbs the migration.

### Step 5: Forward `sessionConfig` through `CodexLocalBackend`

Modify `src/main/agent/CodexLocalBackend.ts`. Add `sessionConfig?: Partial<CodexSessionConfig>` to `CodexLocalBackendOptions` (preserve all other fields) and pass it through to `buildCodexLaunchArgs`. Note the `Partial<>` matches the type already accepted by `buildCodexLaunchArgs` so callers can pass `{ writableRoots: ['x'] }` without supplying every field; defaults come from `DEFAULT_CODEX_SESSION_CONFIG`:

```typescript
import type { CodexSessionConfig } from '../../types/agent'

export interface CodexLocalBackendOptions {
  // ...existing fields unchanged...
  sessionConfig?: Partial<CodexSessionConfig>
}

// Inside start(), where buildCodexLaunchArgs is currently called (around L124):
const proc = spawnFactory(
  bin,
  buildCodexLaunchArgs({
    listenUrl,
    provider: this.options.provider,
    sessionConfig: this.options.sessionConfig,
  }),
  { stdio: ['ignore', 'pipe', 'pipe'], env },
)

// And in testConnection() (around L169-L173) — same change so the smoke test
// uses the same launch posture instead of silently bypassing sessionConfig:
const args = buildCodexLaunchArgs({
  listenUrl: 'ws://127.0.0.1:0',
  provider: this.options.provider,
  sessionConfig: this.options.sessionConfig,
})
```

No other behavior in `CodexLocalBackend` changes.

### Step 6: Surface read-only status + align effective cwd / writableRoots with the user's workspace (P1 from doc-review)

Modify `src/main/agent/AgentManager.ts`. **Do not** introduce `setSessionConfig` (that's Phase 2 and includes confirmation gates). Phase 1 introduces:

1. A read-only `getSessionStatus()`.
2. A narrow `setAllowedRoots(roots)` passthrough — accepts a string array, filters to existing absolute directories, updates `sessionConfig.writableRoots`, AND forwards to `setFsAllowedRoots()` (Task 3 Step 6c). The IPC handler validates input shape; main owns the trust boundary.
3. `sendMessage` uses the first allowed root as `cwd` instead of `process.cwd()`. **Critical**: with `sandbox_mode="workspace-write"` Codex permits writes inside `cwd` plus any `--add-dir` roots. If `cwd` falls back to `process.cwd()` (the install dir on packaged builds, the dev tree on `npm run dev`), the status panel's "0 root(s)" reads as "nothing is writable" while Codex actually has write access to the install directory. Aligning `cwd` with the user's workspace root makes the displayed surface match reality.

```typescript
import { DEFAULT_CODEX_SESSION_CONFIG } from './codexLaunch'
import { setFsAllowedRoots } from '../file-explorer/fsIpc'
import type { CodexSessionConfig, CodexSessionStatus } from '../../types/agent'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Inside the AgentManager class, alongside DEFAULT_PROVIDER usage (around L127):
private sessionConfig: CodexSessionConfig = { ...DEFAULT_CODEX_SESSION_CONFIG }

// constructor body (replace the existing default backend instantiation):
this.backend = opts.backend ?? new CodexLocalBackend({
  getApiKey: () => this.codexApiKey,
  provider: DEFAULT_PROVIDER,
  sessionConfig: this.sessionConfig,
})

// New method, near the existing setCodexApiKey method.
// Returns the canonicalized list that was actually accepted, so the renderer
// can reconcile any stale entries that no longer exist on disk.
async setAllowedRoots(roots: unknown): Promise<string[]> {
  if (!Array.isArray(roots)) return [...this.sessionConfig.writableRoots]
  const validated: string[] = []
  for (const candidate of roots) {
    if (typeof candidate !== 'string') continue
    const resolved = path.resolve(candidate)
    if (!path.isAbsolute(resolved)) continue
    try {
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) validated.push(resolved)
    } catch {
      // skip non-existent paths
    }
  }
  this.sessionConfig = { ...this.sessionConfig, writableRoots: validated }
  setFsAllowedRoots(validated)
  return [...validated]
}

// New method, near the existing setCodexApiKey method:
getSessionStatus(model: string = DEFAULT_AGENT_MODEL): CodexSessionStatus {
  return {
    model,
    sandboxMode: this.sessionConfig.sandboxMode,
    approvalPolicy: this.sessionConfig.approvalPolicy,
    webSearch: this.sessionConfig.webSearch,
    writableRoots: [...this.sessionConfig.writableRoots],
  }
}

// Inside sendMessage(), where cwd is currently set (around L250) — replace
// `cwd: process.cwd()` with the first allowed root, falling back to process.cwd()
// only when no workspace has been registered:
const cwd = this.sessionConfig.writableRoots[0] ?? process.cwd()
```

`testConnection` should also pass `sessionConfig: this.sessionConfig` to the throwaway backend so the test path matches the production launch surface.

**Renderer wiring.** `src/renderer/src/features/file-explorer/store.ts` already maintains `workspaceTree: FileNode[]` from feedback round 1. After every `addFolder` / `removeFolder` / `loadWorkspaceFolders` mutation, call:

```typescript
const roots = workspaceTree.filter((n) => n.kind === 'dir').map((n) => n.path)
void getApi().agent.setAllowedRoots?.(roots)
```

`setAllowedRoots` is idempotent and tolerates being called before the agent IPC is ready (it's pushed by an `await` chain that no-ops on undefined).

**Tests.**
- `src/main/agent/__tests__/AgentManager.allowedRoots.test.ts`: cover (a) non-array input → no mutation, (b) string-array with mix of existing + non-existing dirs → only existing ones land, (c) input with non-string members → silently dropped, (d) `getSessionStatus().writableRoots` reflects the latest `setAllowedRoots()` call, (e) `sendMessage`'s `AgentInput.cwd` uses the first allowed root when present, falls back to `process.cwd()` when empty.
- `src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx`: extend the existing tests to assert the panel renders the workspace-root count when populated.

### Step 7: Add read-only IPC + preload exposure

Modify `src/main/agent/ipc.ts`. Add the read-only status channel AND the narrow allowed-roots channel:

```typescript
ipcMain.handle('agent:get-session-status', () => manager.getSessionStatus())
ipcMain.handle('agent:set-allowed-roots', async (_event, roots: unknown) =>
  manager.setAllowedRoots(roots),
)
```

Modify `src/preload/index.ts`. Add to the agent API surface:

```typescript
getSessionStatus: () => ipcRenderer.invoke('agent:get-session-status'),
setAllowedRoots: (roots: string[]) =>
  ipcRenderer.invoke('agent:set-allowed-roots', roots),
```

`set-allowed-roots` only accepts a string array and only ever resolves to a (possibly filtered) string array. It does NOT accept arbitrary `CodexSessionConfig` — that surface is reserved for Phase 2's `setSessionConfig` with confirmation gates.

### Step 8: Add `CodexStatusPanel`

Create `src/renderer/src/features/agent-chat/CodexStatusPanel.tsx`:

```tsx
import type { CodexSessionStatus } from '../../../../types/agent'

export function CodexStatusPanel({ status }: { status?: CodexSessionStatus }) {
  if (!status) {
    return <div className="text-[11px] text-zinc-500">Codex status unavailable</div>
  }

  const unsafe = status.sandboxMode === 'danger-full-access' || status.approvalPolicy === 'never'

  return (
    <div className={[
      'rounded-lg border px-2 py-1.5 text-[11px]',
      unsafe ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100',
    ].join(' ')}>
      <div className="font-medium">Codex {status.model}</div>
      <div className="mt-0.5 opacity-80">
        {status.sandboxMode} · {status.approvalPolicy} · search {status.webSearch ? 'on' : 'off'}
      </div>
      {status.writableRoots.length > 0 ? (
        <div className="mt-0.5 truncate opacity-60">{status.writableRoots.length} root(s)</div>
      ) : null}
    </div>
  )
}
```

Create `src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexStatusPanel } from '../CodexStatusPanel'

afterEach(cleanup)

describe('CodexStatusPanel', () => {
  it('renders the unavailable fallback when no status is provided', () => {
    render(<CodexStatusPanel />)
    expect(screen.getByText(/Codex status unavailable/i)).toBeTruthy()
  })

  it('renders safe defaults', () => {
    render(<CodexStatusPanel status={{
      model: 'gpt-5.5',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      webSearch: true,
      writableRoots: [],
    }} />)
    expect(screen.getByText(/Codex gpt-5.5/i)).toBeTruthy()
    expect(screen.getByText(/workspace-write/i)).toBeTruthy()
  })

  it('flags unsafe sandbox + approval', () => {
    const { container } = render(<CodexStatusPanel status={{
      model: 'gpt-5.5',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: false,
      writableRoots: ['D:/repo'],
    }} />)
    expect(container.querySelector('[class*="amber"]')).toBeTruthy()
  })
})
```

### Step 9: Render `CodexStatusPanel` in `AgentChatPanel`

Modify `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`. Add a state hook + effect that fetches status once on mount, then render the panel beside `TokenUsageMeter` in the existing header row. The fetch path:

```tsx
import { useEffect, useState } from 'react'
import { CodexStatusPanel } from './CodexStatusPanel'
import type { CodexSessionStatus } from '../../../../types/agent'

// inside the component:
const [codexStatus, setCodexStatus] = useState<CodexSessionStatus | undefined>(undefined)
useEffect(() => {
  const api = (window as Window & { electronAPI?: { agent?: { getSessionStatus?: () => Promise<CodexSessionStatus> } } }).electronAPI
  api?.agent?.getSessionStatus?.().then(setCodexStatus).catch(() => undefined)
}, [])
```

Render `<CodexStatusPanel status={codexStatus} />` next to the existing header content.

### Step 10: Run all Task-5 tests + typecheck

Run:

```bash
npm run test:run -- \
  src/main/agent/__tests__/codexLaunch.test.ts \
  src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 11: Commit Task 5

Commit message: `fix: default codex to safer permissions and surface status`

---

## Task 6: Render File Drops in `MentionInput` as Reference Chips

**Goal:** When a file is dropped into the chat input, replace the inline `[file:name]` text marker with a visible reference chip rendered above the textarea. Pure markdown selection drops (`parseQuoteDrop`) continue to insert text only — no chip. The existing `addAttachment` payload that drives Codex's prompt preamble is unchanged.

**Files:**
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx`

### Step 1: Write failing input tests

Create `src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

function makeFileDataTransfer(filePath: string): DataTransfer {
  const dt = new DataTransfer()
  dt.setData('application/x-agent-file-path', filePath)
  return dt
}

describe('MentionInput reference chips', () => {
  it('shows a reference chip for a file drop and does not insert [file:name] text', async () => {
    useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    fireEvent.drop(textarea, { dataTransfer: makeFileDataTransfer('D:/repo/main.ts') })

    await new Promise((r) => setTimeout(r, 0))

    expect(screen.queryByText(/\[file:main\.ts\]/)).toBeNull()
    expect(screen.getByText('main.ts')).toBeTruthy()
    expect(screen.getByText('file')).toBeTruthy()
  })

  it('still inserts pure markdown for code-selection drops', async () => {
    useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = new DataTransfer()
    dt.setData('text/x-agent-quote', '```ts\nconst x = 1\n```')
    fireEvent.drop(textarea, { dataTransfer: dt })

    await new Promise((r) => setTimeout(r, 0))

    expect(textarea.value).toContain('```ts')
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('chip × removes BOTH the chip and the underlying attachment', async () => {
    useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    fireEvent.drop(textarea, { dataTransfer: makeFileDataTransfer('D:/repo/main.ts') })
    await new Promise((r) => setTimeout(r, 0))

    expect(useAgentChatStore.getState().attachments.length).toBe(1)
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(1)

    fireEvent.click(screen.getByLabelText('Remove main.ts'))
    await new Promise((r) => setTimeout(r, 0))

    // Both stores must reflect removal — otherwise user intent is silently ignored.
    expect(useAgentChatStore.getState().attachments).toEqual([])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })
})
```

> If `DataTransfer` is not available in jsdom, replicate the `makeDataTransfer` helper used by `dragHelpers.test.ts`. The test file at `src/renderer/src/features/file-explorer/__tests__/dragHelpers.test.ts` already exports a working stub — reuse that pattern.

### Step 2: Run failing input tests

Run: `npm run test:run -- src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx`

Expected: FAIL.

### Step 3: Add `pendingReferences` slice to the agent-chat store

Modify `src/renderer/src/features/agent-chat/store.ts`. Add to the state and actions:

```typescript
import type { AgentReference } from '../../../../types/agent-reference'

// State additions:
pendingReferences: AgentReference[]

// Action additions:
addPendingReference: (reference: AgentReference) => void
removePendingReference: (referenceId: string) => void
clearPendingReferences: () => void
```

Initial state:

```typescript
pendingReferences: [],
```

Action implementations:

```typescript
addPendingReference: (reference) =>
  set((s) => ({
    pendingReferences: s.pendingReferences.some((r) => r.id === reference.id)
      ? s.pendingReferences
      : [...s.pendingReferences, reference],
  })),

removePendingReference: (referenceId) =>
  set((s) => ({
    pendingReferences: s.pendingReferences.filter((r) => r.id !== referenceId),
  })),

clearPendingReferences: () => set({ pendingReferences: [] }),
```

Inside the existing `send()` action body, after the network call has been started, call `clearPendingReferences()` so a fresh send does not double-attach. **Do not** plumb `pendingReferences` into `AgentSendMessagePayload`; Phase 2 wires that.

**Structural guard for the renderer-only invariant (P1 from doc-review).** A future commit can easily reach for `pendingReferences` when adding `references` to the payload — the data is sitting right there in the same store. Lock the boundary in two ways:

1. Add a compile-time-asserted test `src/renderer/src/features/agent-chat/__tests__/payloadShape.test.ts`:

```typescript
import { describe, expectTypeOf, it } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../../types/agent'

describe('AgentSendMessagePayload (Phase 1 invariant)', () => {
  it('does NOT contain a references field — Phase 2 owns that wiring', () => {
    expectTypeOf<AgentSendMessagePayload>().not.toHaveProperty('references')
    expectTypeOf<AgentSendMessagePayload>().not.toHaveProperty('pendingReferences')
  })
})
```

2. Add an inline `// PHASE-1-INVARIANT:` comment immediately above the `clearPendingReferences()` call in `send()` so the next maintainer who is about to thread `pendingReferences` through the wire gets a hard prompt to update Phase 2's plan first.

If Phase 2's plan extends `AgentSendMessagePayload`, this test will fail at type-check time, prompting the implementer to delete the negative assertion in the same commit that adds the new field. That's the correct sequence — the invariant survives until it's deliberately retired.

### Step 4: Render dropped files as chips, drop the inline text

Modify `src/renderer/src/features/agent-chat/MentionInput.tsx`:

1. Import the chip and the file-reference factory:

```tsx
import { ReferenceChip } from './references/ReferenceChip'
import { makeFileReference } from './references/referenceUtils'
```

2. Pull the slice out of the store. The chip × must remove BOTH the renderer-only chip and the underlying attachment, otherwise users see the chip vanish while the file still travels through `payload.attachments` to Codex. Reuse the existing `removeAttachment(name)` action (`store.ts:149`):

```tsx
const pendingReferences = useAgentChatStore((s) => s.pendingReferences)
const addPendingReference = useAgentChatStore((s) => s.addPendingReference)
const removePendingReference = useAgentChatStore((s) => s.removePendingReference)
const removeAttachment = useAgentChatStore((s) => s.removeAttachment)
```

3. Replace the existing line `appendInput(\`[file:${name}]\`)` inside `onDrop` with:

```tsx
addPendingReference(makeFileReference({ path: filePath, name, mime: stat.mime || undefined }))
```

The `addAttachment(...)` call is unchanged.

4. Above the `<textarea>`, render a chip strip. The `×` handler removes BOTH the chip and the attachment so user intent is honored:

```tsx
{pendingReferences.length > 0 ? (
  <div className="mb-2 flex flex-wrap gap-1">
    {pendingReferences.map((reference) => (
      <span key={reference.id} className="inline-flex items-center gap-1">
        <ReferenceChip reference={reference} />
        <button
          type="button"
          aria-label={`Remove ${reference.label}`}
          className="rounded border border-zinc-700 px-1 text-[10px] text-zinc-400 hover:text-red-200"
          onClick={() => {
            removePendingReference(reference.id)
            removeAttachment(reference.label)
          }}
        >
          ×
        </button>
      </span>
    ))}
  </div>
) : null}
```

### Step 5: Run input tests + typecheck

Run:

```bash
npm run test:run -- src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 6: Commit Task 6

Commit message: `feat: render dropped files as reference chips in chat input`

---

## Task 7: Integration Hardening

**Goal:** Confirm the new boundary holds — typecheck clean, all targeted suites green, broader existing suites green, manual Electron smoke clean, and an upgraded secret scan finds no regressions. Phase 1 ships only when each item below passes.

### Step 1: Run all new and adjacent tests

Run:

```bash
npm run test:run -- \
  src/renderer/src/features/agent-chat/references/__tests__/referenceUtils.test.ts \
  src/renderer/src/features/agent-chat/references/__tests__/ReferenceChip.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ShellCard.reference.test.tsx \
  src/renderer/src/features/agent-chat/cards/__tests__/ActivityCard.reference.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/payloadShape.test.ts \
  src/renderer/src/features/file-explorer/__tests__/store.reference.test.ts \
  src/renderer/src/features/file-explorer/__tests__/urlValidation.test.ts \
  src/renderer/src/features/file-explorer/__tests__/UrlPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/ShellOutputPreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/JsonResourcePreview.test.tsx \
  src/renderer/src/features/file-explorer/__tests__/store.test.ts \
  src/renderer/src/features/file-explorer/__tests__/FileTabStrip.test.tsx \
  src/main/agent/__tests__/codexLaunch.test.ts \
  src/main/agent/__tests__/AgentManager.allowedRoots.test.ts \
  src/main/file-explorer/__tests__/fsIpc.containment.test.ts \
  src/main/file-explorer/__tests__/protocolHandler.test.ts
```

Expected: PASS. If pre-existing environment failures (jsdom CodeMirror `getClientRects`, etc.) appear in the broader file-explorer tests, record them in the final commit notes and verify the new tests separately.

### Step 2: Run typecheck

Run: `npm run typecheck`

Expected: PASS, or fail only on documented pre-existing repository issues unrelated to this plan. Any new error in files touched by this plan must be fixed before commit.

### Step 3: Manual Electron verification

Run: `npm run dev`

Verify:

- The chat header shows `Codex gpt-5.5 · workspace-write · on-request · search on`. Border is cyan, not amber.
- After adding a workspace folder via the file explorer, the status panel updates to show `N root(s)` matching the count of registered folders. Removing the last root falls back to "0 root(s)" — and Codex's `cwd` falls back to `process.cwd()` (verified by emitting a no-op shell call and inspecting the timeline `cwd` field).
- Opening a `.ts` file from the file tree still uses the existing CodeMirror viewer (not a JSON dump).
- Opening a `.png` from the tree still uses the existing image viewer.
- Sending a message that triggers a shell command produces a `ShellCard` with both `Open output` and `Copy command`. Clicking `Open output` opens a new reference tab in the file explorer with command, cwd, exit code, and ANSI-stripped stdout.
- Activity events (e.g. an MCP tool call or a web search) produce `Open details` buttons. MCP / activity opens a `JsonResourcePreview` tab; webSearch with an extractable URL opens a `UrlPreview` tab whose iframe sandbox attribute is exactly `allow-popups allow-scripts` (no `allow-same-origin`, no `allow-popups-to-escape-sandbox`, no `allow-forms`).
- An HTTPS URL preview loads inside the iframe (no Chromium "blocked by CSP" error). An HTTP URL preview shows the "HTTP preview not embedded" branch with an "Open external (validated)" button.
- A cross-scheme URL reference (`javascript:` or `file://`) shows `Embedded preview blocked`, never an iframe.
- DevTools → Network: with the URL preview iframe loaded, attempt `fetch('local-file:///D:/repo/some-file.ts', {mode: 'no-cors'})` from the iframe's console. Expected: the response is 403 (Sec-Fetch-Site: cross-site rejection). Same probe from the parent renderer's console returns the file content (Sec-Fetch-Site: same-origin).
- Path containment smoke: in the parent renderer's console, call `window.electronAPI.fs.readText('/etc/passwd')` (or `'C:/Windows/System32/drivers/etc/hosts'` on Windows). Expected: rejected with "fs path outside allowed roots". Open a file inside the registered workspace root: succeeds.
- Dragging a file from the file explorer into the chat input shows a chip above the textarea (no `[file:main.ts]` text marker). Clicking the chip's × removes both the chip AND the underlying attachment (verify by clicking Send and observing zero attachments on the timeline). Pasting/dropping a code selection still inserts the original markdown fence into the textarea.
- Dirty file close still prompts Save / Don't Save / Cancel (regression check from earlier work).
- No token values are shown in logs or UI.

### Step 4: Upgraded secret scan

Run:

```bash
rg --no-heading --line-number --color never \
  -e 'gh[pousr]_[A-Za-z0-9]{36,255}' \
  -e 'github_pat_[A-Za-z0-9_]{20,}' \
  -e 'glpat-[A-Za-z0-9_-]{20,}' \
  -e 'sk-[A-Za-z0-9-]{20,}' \
  -e 'xox[abprs]-[A-Za-z0-9-]+' \
  -e 'AKIA[0-9A-Z]{16}' \
  --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/dist/**' .
```

Expected: zero matches. Plain string literals like `CODEX_UPDATE_TOKEN` referenced as a GitHub secret name are fine and will not match these patterns. If a match is found, treat it as a credential leak (rotate first, then unblock the plan).

### Step 5: Commit Task 7

Commit message: `test: verify codex workspace ui phase 1`

---

## Implementation Notes

- **No live Codex backend mutation of arbitrary session config.** Phase 1 ships read-only `getSessionStatus` AND a narrow `setAllowedRoots(roots: string[])` passthrough that only mutates the writableRoots / cwd alignment (one string-array goes in, the canonical-filtered string array comes out). Sandbox / approval / web-search mutation is reserved for Phase 2 with confirmation gates, audit logging, and backend soft-restart.
- **Path containment is the security boundary, not the chip UI.** `localPathFromUri` rejects `..` traversal and non-absolute paths in the renderer, but the actual gate is `assertContained(p)` in `src/main/file-explorer/fsIpc.ts`. Codex / MCP / web-search can emit `attachment.uri` values that traverse to `/etc/passwd` or `D:/Users/<victim>/.aws/credentials` — main-side containment is what stops the read. The list of allowed roots is the persisted workspace tree (pushed via `agent:set-allowed-roots`) plus `app.getPath('userData')/agent/uploads` (where `AttachmentService` writes sha256-named files).
- **CSP `frame-src` is widened from `'none'` to `https:`.** Required for `UrlPreview`'s iframe to load. HTTP URLs are NOT allowed in `frame-src`; they route through "Open externally" only. This keeps mixed-content downgrades off the embedded surface.
- **Iframe sandbox is intentionally minimal.** `'allow-popups allow-scripts'` only. NO `allow-same-origin` (parent origin / cookies / storage stay isolated). NO `allow-popups-to-escape-sandbox` (popups stay sandboxed and route through `setWindowOpenHandler`). NO `allow-forms`. Re-add any of these only with a documented use case in Phase 2+.
- **`local-file://` protocol handler rejects cross-origin requests** via `Sec-Fetch-Site` so a sandboxed iframe can't probe local files via `<img>` / `<script>` / `fetch` even with the loosened CSP.
- **No GitHub token in code, docs, workflow files, logs, or test snapshots.** Any token previously pasted into chat must be treated as compromised and rotated. Phase 2 plan owns the GitHub Actions workflow with SHA-pinned actions, output-injection-safe `tag_name` writing, optional GitHub App installation token, and SHA-256 manifests for the bundled Codex CLI.
- **Pure markdown selection insertion behavior is preserved.** `MentionInput.onDrop` still calls `parseQuoteDrop` first; only the file-drop branch is changed.
- **`tab.path` is empty for synthetic reference tabs.** Future code that iterates over `tabs` for filesystem operations must continue to gate on `tab.kind !== 'reference'` AS WELL AS the empty-string check (defense in depth).
- **`AgentReference` is genuinely minimal in Phase 1.** No `selection` / `github` types; no `mcp` / `github` / `inline` source kinds; no `language` / `fromLine` / `toLine` / `text` preview fields; no `executionPolicy`. Phase 2 reintroduces each WHEN it has a consumer.
- **`'external'` and `'activity'` open behaviors do NOT exist in Phase 1.** `UrlPreview` owns the safe/unsafe split for URLs; activity items route to `jsonResource`. If a future commit needs a separate `'external'` route, it must also extend `ReferencePreview`'s exhaustive switch — TypeScript will surface that.
- **`web_search` config key.** This plan uses `tools.web_search=<bool>` per Codex 0.128's documented surface. Before committing Task 5, run a one-shot `codex --help` (or `codex app-server --help`) smoke check to confirm the key still exists; otherwise `CodexStatusPanel` will display "search on" while Codex silently has it off. If the surface drifts, Phase 2's smoke test against the real binary is the second gate.
- **`shell.openExternal` MUST go through IPC, not the preload directly.** Even with `contextIsolation: false`, the preload exposes `openExternal` as `safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.OPEN_EXTERNAL, url)`, and the main-side handler re-runs `validateExternalUrl` before calling `shell.openExternal`. The renderer-side validator is defense-in-depth only; the main-side gate is the security boundary because `shell.openExternal('javascript:...')` is forwarded to `ShellExecuteW` on Windows on some Electron versions.
- **Cross-platform `local-file://` decoding.** `localPathFromUri` parses the URI as a real `URL`, rejects `..` segments, requires absolute paths, and only strips the leading `/` before a Windows drive letter so POSIX absolute paths keep their leading slash. The greedy `replace(/^local-file:\/\/+/, '')` pattern fails on POSIX and must not be reintroduced.
- **Chip × removes both halves of state.** `MentionInput`'s chip strip clears the chip AND calls the existing `removeAttachment(name)` so the file is also removed from the send payload. Otherwise the user observes the chip disappear while the file silently still travels to Codex.
- **Renderer-only `pendingReferences`.** Locked in by `payloadShape.test.ts` which type-asserts `AgentSendMessagePayload` has no `references` / `pendingReferences` field. Phase 2 deletes that test in the same commit it adds the field.
- **Pre-existing Electron security posture** — `nodeIntegration: true`, `contextIsolation: false`, `sandbox: false`, plus CSP `'unsafe-inline' 'unsafe-eval'` in `script-src` — is OUT of Phase 1 scope but worth acknowledging. Any new preview component (`ShellOutputPreview`, `JsonResourcePreview`) MUST treat its inputs as text-only (no `dangerouslySetInnerHTML`, no Markdown HTML rendering enabled) because attacker-influenced strings reach those components from Codex/MCP. The plan's snippets do this correctly with `<pre>`; defend that in code review.

## Phase 2 Hand-Off Checklist

When Phase 1 lands, the Phase 2 plan inherits these prerequisites:

- `AgentReference`, `referencesFromTimelineItem`, and `ReferenceChip` are stable, with the minimal Phase 1 schema.
- `openReference` exists and routes both delegation (local-path file types via `openTab`) and synthesis cases (URL / shellOutput / jsonResource / diff).
- `buildCodexLaunchArgs` accepts `options.sessionConfig`; `appendProviderArgs` is extracted as a helper.
- `agent:get-session-status` (read-only) and `agent:set-allowed-roots` (string[]→string[] passthrough) IPCs are wired; `CodexStatusPanel` renders accurate writableRoots.
- Path containment is enforced in `src/main/file-explorer/fsIpc.ts`; CSP allows `frame-src https:`; `local-file://` rejects cross-origin requests.
- `pendingReferences` exists in the agent-chat store but is not yet sent over the wire. `payloadShape.test.ts` enforces this. Phase 2 deletes that test in the same commit it plumbs `payload.references` through `AgentManager.sendMessage` after main-process validation.
- `setAllowedRoots` already canonicalizes input — Phase 2's broader `setSessionConfig` reuses the same validation pattern.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-05-08-codex-native-workspace-ui-phase1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
