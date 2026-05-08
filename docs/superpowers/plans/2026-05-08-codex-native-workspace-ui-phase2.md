# Codex-Native Workspace UI - Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 Codex wrapper into a safer app-server-native workspace UI: per-thread permissions, real approval prompts, direct image/reference inputs, Codex-owned thread resume/fork, and read-only MCP/skills visibility.

**Architecture:** Keep `codex app-server` as the execution kernel. Prefer JSON-RPC (`thread/*`, `turn/*`, `mcpServer/*`) and Codex's own config discovery over custom runners, duplicated persistence, or CLI parsing. The renderer remains a UI/reference layer; the main process validates all config changes, path roots, and server-request responses before sending them to Codex.

**Tech Stack:** Electron, React 19, Zustand, TypeScript 5, Vitest, OpenAI Codex CLI 0.128+ app-server JSON-RPC v2.

---

## Research Summary

- `codex exec --json` is not the right Phase 2 path for this Electron app. The equivalent app-server flow already exists: `initialize` -> `thread/start` -> `turn/start` -> consume `item/*` and `turn/completed` notifications.
- Most target capabilities are available through app-server RPC or thread config: `thread/start`, `thread/list`, `thread/read`, `thread/fork`, `thread/archive`, `thread/unarchive`, `turn/start`, `turn/steer`, `turn/interrupt`.
- Slash commands are TUI macros. Build first-class UI controls instead of a slash-command palette.
- MCP CRUD and OAuth login are CLI/config-owned. The app should expose read-only status and "open config / run command" affordances, not a divergent registry.

## Phase Scope

### In Phase 2

- Fix `thread/start` to use the active `CodexSessionConfig` instead of hardcoded `danger-full-access` + `never`.
- Replace boolean web-search state with official three-state `web_search = "cached" | "live" | "disabled"`.
- Add main-process session-config validation and a renderer permissions panel for sandbox, approval policy, web search, and writable roots.
- Add approval-prompt UI for Codex server requests. No request may be auto-approved by the renderer.
- Send dropped image references as Codex `localImage` / `image` inputs instead of text placeholders.
- Add Codex-native thread list/read/fork APIs and start migrating the sidebar away from custom-only `ThreadStore` reads.
- Add read-only MCP and skills visibility panels sourced from Codex config and filesystem discovery.

### Out of Phase 2

- `codex exec --json` background runner.
- User-defined slash-command palette.
- MCP CRUD (`codex mcp add/remove/login/logout`) inside the app.
- Full `codex login` automation.
- Plugin marketplace UI.
- Subagent tree visualization beyond surfaced timeline events.
- Deleting the Prisma thread schema. This plan adds Codex-native read-through first; destructive persistence cleanup belongs in a later migration.

## File Structure

### Shared Types

- Modify: `src/types/agent.ts` - `CodexWebSearchMode`, stricter session config/status types, approval request/response payloads, Codex thread summary types.

### Main Process - Codex Protocol

- Modify: `src/main/agent/codexProtocol.ts` - protocol types for `thread/list`, `thread/read`, `thread/fork`, `turn/steer`, server requests, and image inputs if missing.
- Modify: `src/main/agent/CodexProtocolClient.ts` - remove unsafe hardcoded `threadStartParams`, add public `listThreads`, `readThread`, `forkThread`, `steerTurn`, and server-request response plumbing.
- Modify: `src/main/agent/CodexLocalBackend.ts` - forward new client methods through `IAgentBackend`.
- Modify: `src/main/agent/types.ts` - backend interface additions.
- Create: `src/main/agent/sessionConfigValidation.ts` - validate sandbox/approval/web-search/writable-root updates.
- Modify: `src/main/agent/AgentManager.ts` - own current session config, confirm unsafe transitions, expose Codex thread/MCP/skills APIs.
- Modify: `src/main/agent/ipc.ts` - add narrow IPC handlers.

### Renderer

- Modify: `src/preload/index.ts` - expose new narrow agent APIs.
- Modify: `src/renderer/src/features/agent-chat/store.ts` - store pending approval prompts, session config draft, and Codex thread summaries.
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx` - keep chips for display but send image references as structured input.
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` - render permissions, approval prompt, and MCP/skills panels in the chat header area.
- Create: `src/renderer/src/features/agent-chat/CodexPermissionsPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/CodexApprovalPrompt.tsx`
- Create: `src/renderer/src/features/agent-chat/CodexMcpPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/CodexSkillsPanel.tsx`

## Pre-Flight Reading

Before Task 1, read these files and confirm the assumptions still match:

- `src/main/agent/CodexProtocolClient.ts` - currently sends `thread/start` then `turn/start`. As of this plan, `threadStartParams()` still hardcodes `sandbox: 'danger-full-access'` and `approvalPolicy: 'never'`; Task 1 fixes this first.
- `src/main/agent/codexLaunch.ts` - has `DEFAULT_CODEX_SESSION_CONFIG`, but launch-level config is not enough because `thread/start` can override it.
- `src/main/agent/AgentManager.ts` - owns the backend, current model, allowed roots, and existing `getSessionStatus()`.
- `src/main/agent/codexUserInput.ts` - already maps `localImage` and `image`; renderer payloads need to use those types directly.
- `src/types/agent.ts` - currently models `webSearch` as boolean and `approvalPolicy` includes deprecated `on-failure`.
- `src/renderer/src/features/agent-chat/store.ts` and `MentionInput.tsx` - currently keep pending reference chips as UI-only state.
- `src/main/agent/ThreadStore.ts` and `ThreadSidebar.tsx` - custom thread persistence remains, but Phase 2 starts Codex-native read-through rather than deleting it.

---

## Task 1: Make `thread/start` Honor Safe Session Config

**Goal:** Ensure the app-server thread actually receives the selected sandbox, approval policy, web search mode, cwd, and model.

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/types.ts`
- Create: `src/main/agent/__tests__/CodexProtocolClient.sessionConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Create a fake WebSocket server test that starts a client with:

```typescript
sessionConfig: {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  webSearch: 'cached',
  writableRoots: ['D:/repo'],
}
```

Send one turn and assert the captured `thread/start` params include:

```typescript
{
  cwd: 'D:/repo',
  model: 'gpt-5.5',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  config: {
    web_search: 'cached',
    sandbox_workspace_write: { writable_roots: ['D:/repo'] },
  },
}
```

Also assert the serialized params do not contain `danger-full-access` or `"never"`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test:run -- src/main/agent/__tests__/CodexProtocolClient.sessionConfig.test.ts`

Expected: FAIL because `threadStartParams()` still sends unsafe literals.

- [ ] **Step 3: Update shared session types**

In `src/types/agent.ts`:

```typescript
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type CodexWebSearchMode = 'cached' | 'live' | 'disabled'
```

Update `CodexSessionConfig.webSearch` and `CodexSessionStatus.webSearch` to use `CodexWebSearchMode`.

- [ ] **Step 4: Thread session config through the protocol client**

Add `sessionConfig` to `CodexProtocolClientOptions` and replace `threadStartParams()` with config-derived params. Keep exact protocol keys `sandbox`, `approvalPolicy`, `config.web_search`, and `config.sandbox_workspace_write.writable_roots`.

- [ ] **Step 5: Forward config from backend to client**

Modify `CodexLocalBackend` so both ws override and spawned app-server clients receive the resolved session config.

- [ ] **Step 6: Run affected tests**

Run: `npm run test:run -- src/main/agent/__tests__/CodexProtocolClient.sessionConfig.test.ts src/main/agent/__tests__/codexLaunch.test.ts src/renderer/src/features/agent-chat/__tests__/CodexStatusPanel.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `fix(agent): honor codex session config on thread start`

---

## Task 2: Add Validated Permissions UI

**Goal:** Let users change sandbox mode, approval policy, web search mode, and writable roots from the UI, with main-process validation and confirmation for unsafe changes.

**Files:**
- Create: `src/main/agent/sessionConfigValidation.ts`
- Create: `src/main/agent/__tests__/sessionConfigValidation.test.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/features/agent-chat/CodexPermissionsPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexPermissionsPanel.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`

- [ ] **Step 1: Test validation**

`sessionConfigValidation.test.ts` covers official values, rejects deprecated `on-failure`, rejects non-string roots, and rejects writable roots outside allowed workspaces.

- [ ] **Step 2: Implement `validateSessionConfigPatch(input, allowedRoots)`**

The function returns `Partial<CodexSessionConfig>`, accepts only official enum values, normalizes roots with `path.resolve`, and requires every writable root to equal or sit under an allowed workspace root.

- [ ] **Step 3: Add main-process setter with confirmation**

Add `AgentManager.setSessionConfigPatch(input: unknown): Promise<CodexSessionStatus>`. Show `dialog.showMessageBox` when entering `danger-full-access`, `approvalPolicy: 'never'`, or `webSearch: 'live'`. If cancelled, throw `Error('session config change cancelled')`.

- [ ] **Step 4: Expose IPC and preload API**

Add `agent:set-session-config` and `window.agent.setSessionConfig(patch)`. The IPC handler accepts only the patch object and returns `CodexSessionStatus`.

- [ ] **Step 5: Build `CodexPermissionsPanel`**

Render sandbox, approval, and web-search radios. Disable Apply until the draft differs from status. Show an inline warning when unsafe values are selected.

- [ ] **Step 6: Run tests**

Run: `npm run test:run -- src/main/agent/__tests__/sessionConfigValidation.test.ts src/main/agent/__tests__/AgentManager.sessionConfig.test.ts src/renderer/src/features/agent-chat/__tests__/CodexPermissionsPanel.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat(agent): add validated codex permissions controls`

---

## Task 3: Add Approval Prompt Handling

**Goal:** Surface Codex server requests in the renderer and require explicit user approval or denial.

**Files:**
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Create: `src/renderer/src/features/agent-chat/CodexApprovalPrompt.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexApprovalPrompt.test.tsx`

- [ ] **Step 1: Test server request capture**

Fake server sends `{"jsonrpc":"2.0","id":41,"method":"request_permission","params":{"reason":"run command","command":"npm test"}}`. Assert the client queues the request and does not reply until a decision is provided.

- [ ] **Step 2: Add approval types**

Add `CodexApprovalRequest` and `CodexApprovalResponse` to `src/types/agent.ts`.

- [ ] **Step 3: Implement request queue**

When `isServerRequest(msg)` is true, store it by JSON-RPC id, notify `AgentManager`, and reply only from `respondToServerRequest(id, response)`. Default to deny after 5 minutes.

- [ ] **Step 4: Add renderer UI**

`CodexApprovalPrompt` shows method, command/tool summary, Approve, Deny, and an optional denial message textarea. No auto-approve button in Phase 2.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- src/main/agent/__tests__/CodexProtocolClient.approvals.test.ts src/renderer/src/features/agent-chat/__tests__/CodexApprovalPrompt.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(agent): surface codex approval prompts`

---

## Task 4: Send References as Structured Codex Inputs

**Goal:** Preserve Phase 1 chips while sending images through Codex's structured input array instead of text placeholders.

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/codexUserInput.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx`
- Modify: `src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx`
- Create: `src/main/agent/__tests__/codexUserInput.reference.test.ts`

- [ ] **Step 1: Extend payload**

Add `references?: AgentReference[]` to `AgentSendMessagePayload`. Update the Phase 1 negative payload-shape test in the same commit.

- [ ] **Step 2: Add mapping tests**

Assert local image references map to `{ type: 'localImage', path }`, remote HTTPS images map to `{ type: 'image', url }`, and non-image local files remain text mentions plus attachments until Codex file mention support is implemented.

- [ ] **Step 3: Update renderer send path**

Include `pendingReferences` as `references` and clear them only after IPC succeeds.

- [ ] **Step 4: Update main input assembly**

In `AgentManager.sendMessage`, combine text, structured image reference inputs, and existing attachment-derived image inputs. Deduplicate by path and reject paths outside allowed roots/uploads.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- src/main/agent/__tests__/codexUserInput.reference.test.ts src/renderer/src/features/agent-chat/__tests__/MentionInput.reference.test.tsx src/renderer/src/features/agent-chat/__tests__/payloadShape.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(agent): send image references as codex inputs`

---

## Task 5: Add Codex-Native Thread List, Read, and Fork

**Goal:** Start migrating thread navigation to Codex-owned session history instead of relying only on Prisma `ThreadStore`.

**Files:**
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/types.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/ThreadSidebar.tsx`
- Create: `src/main/agent/__tests__/CodexProtocolClient.threads.test.ts`

- [ ] **Step 1: Test RPC wrappers**

Verify `listThreads()` sends `thread/list`, `readThread(threadId)` sends `thread/read`, and `forkThread(threadId)` sends `thread/fork`.

- [ ] **Step 2: Implement wrappers**

Add public methods returning narrow DTOs: id, title, createdAt, updatedAt, cwd, and model when present.

- [ ] **Step 3: Add IPC**

Add `agent:list-codex-threads`, `agent:read-codex-thread`, and `agent:fork-codex-thread`. Validate thread ids as non-empty strings.

- [ ] **Step 4: Render Codex sessions**

Keep current Prisma threads visible. Add a "Codex Sessions" section or toggle and a "Fork" action per Codex session.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- src/main/agent/__tests__/CodexProtocolClient.threads.test.ts src/renderer/src/features/agent-chat/__tests__/ThreadSidebar.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(agent): expose codex-native thread history`

---

## Task 6: Add Read-Only MCP and Skills Panels

**Goal:** Show what Codex already loads from config and filesystem without creating a parallel MCP/skills registry.

**Files:**
- Create: `src/main/agent/codexConfigDiscovery.ts`
- Create: `src/main/agent/__tests__/codexConfigDiscovery.test.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/features/agent-chat/CodexMcpPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/CodexSkillsPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CodexSkillsPanel.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`

- [ ] **Step 1: Test discovery**

Use temporary directories to assert `[mcp_servers.name]` entries are discovered, secrets are redacted, skills are discovered from `.agents/skills/*/SKILL.md` and `$HOME/.agents/skills/*/SKILL.md`, and invalid frontmatter reports a warning.

- [ ] **Step 2: Implement read-only discovery**

Add `readMcpSummary(configPath)` and `discoverCodexSkills({ cwd, home })`. Use an existing TOML parser if present; otherwise add the smallest maintained package through the package manager.

- [ ] **Step 3: Expose IPC**

Add `agent:get-mcp-summary` and `agent:get-skills-summary`. Both are read-only. Do not add MCP add/remove/login/logout handlers.

- [ ] **Step 4: Build panels**

`CodexMcpPanel` shows name, transport, enabled/required state, and redacted command/url. `CodexSkillsPanel` shows name, scope, description, and an "Insert $skill-name" button that only appends text into `MentionInput`.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- src/main/agent/__tests__/codexConfigDiscovery.test.ts src/renderer/src/features/agent-chat/__tests__/CodexMcpPanel.test.tsx src/renderer/src/features/agent-chat/__tests__/CodexSkillsPanel.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(agent): show codex mcp and skills summaries`

---

## Task 7: Final Verification and Security Review

**Goal:** Verify Phase 2 behavior end-to-end and ensure no secret-bearing config, unsafe auto-approval, or path escape was introduced.

- [ ] **Step 1: Run focused tests**

Run: `npm run test:run -- src/main/agent src/renderer/src/features/agent-chat`

Expected: PASS, except unrelated pre-existing failures must be listed with exact test names.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS. If legacy unrelated failures remain, list them and run a scoped check over files touched by this plan.

- [ ] **Step 3: Manual Electron verification**

Run: `npm run dev`

Verify permissions confirmation, approval denial, structured image input, Codex Sessions list/fork, and MCP/Skills redaction.

- [ ] **Step 4: Secret scan**

Run: `git grep -nE "(ghp_|github_pat_|sk-[A-Za-z0-9]|OPENAI_API_KEY=|apiyi-[A-Za-z0-9])" -- .`

Expected: zero matches in tracked files. If local untracked config contains a token, do not commit it; rotate any token that was pasted into chat.

- [ ] **Step 5: Review checklist**

Confirm no renderer IPC accepts arbitrary config without validation, no server request is auto-approved, no app code writes `~/.codex/config.toml`, no code path reintroduces `danger-full-access` + `never`, and no reference path is sent outside allowed roots/uploads.

- [ ] **Step 6: Commit**

Commit message: `test(agent): verify codex-native workspace phase 2`

---

## Implementation Notes

- **App-server first.** Do not build an exec runner for work that `thread/start` and `turn/start` already cover.
- **Unsafe choices require friction.** `danger-full-access`, `approvalPolicy: 'never'`, and `webSearch: 'live'` require main-process confirmation every time they are newly selected.
- **No MCP registry fork.** Codex owns `[mcp_servers.*]`; this app only reads and summarizes.
- **No slash-command palette.** Build explicit UI for permissions, MCP, skills, threads, and references.
- **Avoid backwards compatibility with unshipped Phase 1 internals.** The branch is not shipped; replace boolean `webSearch` and text-only references outright.
- **Token hygiene.** Any token pasted into chat is compromised. Rotate it before using GitHub/Codex automation on a real repo.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-05-08-codex-native-workspace-ui-phase2.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
