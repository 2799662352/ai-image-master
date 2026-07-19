# Codex Plan Mode Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Default/Plan mode state match Codex’s persistent thread settings, add an accessible split-button Plan effort UI, and keep old-binary fallback safe.

**Architecture:** Extend the app-server v2 protocol client with `thread/settings/update` and `thread/settings/updated`, route confirmed settings back to the renderer, and keep `turn/start` explicitly mode-complete. A shared pure module owns mode/effort rules; the renderer store owns pending UX and thread isolation; a focused `CollabModeControl` owns the split-button UI.

**Tech Stack:** TypeScript, Electron IPC/contextBridge, React 19, Zustand, Tailwind CSS, Vitest/jsdom, Codex app-server v2 WebSocket JSON-RPC.

---

## File map

### New files

- `src/shared/collaborationMode.ts` — shared mode/effort types and pure merge/validation helpers.
- `src/shared/__tests__/collaborationMode.test.ts` — pure helper regression tests.
- `src/renderer/src/features/agent-chat/CollabModeControl.tsx` — split button, Plan effort popover, focus and ARIA.
- `src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx` — component behavior and accessibility.
- `docs/superpowers/plans/2026-07-12-codex-plan-mode-alignment.md` — this plan.

### Modified files

- `src/main/agent/codexProtocol.ts` — official thread settings request/response/notification DTOs.
- `src/main/agent/CodexProtocolClient.ts` — settings update RPC and dedicated settings callback.
- `src/main/agent/codexNotificationRouter.ts` — defensive `thread/settings/updated` parsing.
- `src/main/agent/types.ts` — optional backend capabilities for settings update and collaboration metadata.
- `src/main/agent/CodexLocalBackend.ts` — protocol passthrough and callback wiring.
- `src/main/agent/AgentManager.ts` — capability query, effective mode construction, immediate update and fallback.
- `src/types/agent.ts` — renderer/main IPC payloads, result envelopes and stream event.
- `src/main/agent/ipc.ts` — collaboration capability/update handlers.
- `src/preload/index.ts` — channel constants, `AgentApi` typing and safeInvoke implementations.
- `src/renderer/src/features/agent-chat/store.ts` — confirmed/pending/thread state and global Plan effort persistence.
- `src/renderer/src/features/agent-chat/ModelPicker.tsx` — Plan-only vs all-modes scope prompt for same-model effort changes.
- `src/renderer/src/features/agent-chat/MentionInput.tsx` — replace `CollabModeToggle` with the focused control.
- `scripts/smoke-collaboration-mode.ts` — probe settings update/notification in the bundled binary.
- Existing collaboration-mode, router, manager, IPC, preload and store test files listed per task below.

### Removed file

- `src/renderer/src/features/agent-chat/CollabModeToggle.tsx` — replaced after the new control passes.

## Execution rules

- Follow red/green/refactor for every behavior change.
- Run the exact narrow test after each edit before broad suites.
- Do not change generated or marketplace artifacts; this feature does not touch skills.
- Do not create a Git commit unless the user explicitly requests commits. If authorized, use each task’s suggested commit message.
- Preserve unrelated working-tree changes.

---

### Task 1: Pin official thread settings protocol contracts

**Files:**
- Modify: `src/main/agent/codexProtocol.ts`
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/main/agent/__tests__/CodexProtocolClient.collaborationMode.test.ts`

- [ ] **Step 1: Add a failing RPC test**

Extend the fake server in `CodexProtocolClient.collaborationMode.test.ts` so it records
`thread/settings/update` and returns `{}`. Add:

```ts
it('sends thread/settings/update with an explicit collaboration mode', async () => {
  const client = await makeClient({ experimentalApi: true })
  const collaborationMode: CodexCollaborationMode = {
    mode: 'default',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      developer_instructions: null,
    },
  }

  await client.updateThreadSettings({
    threadId: 'thread-1',
    collaborationMode,
  })

  expect(server.receivedFromClient).toContainEqual(expect.objectContaining({
    method: 'thread/settings/update',
    params: { threadId: 'thread-1', collaborationMode },
  }))
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/main/agent/__tests__/CodexProtocolClient.collaborationMode.test.ts
```

Expected: FAIL because `updateThreadSettings` and DTOs do not exist.

- [ ] **Step 3: Add the exact app-server v2 DTOs**

Add to `codexProtocol.ts`:

```ts
export interface ThreadSettingsUpdateParams {
  threadId: string
  collaborationMode?: CodexCollaborationMode | null
}

export type ThreadSettingsUpdateResponse = Record<string, never>

export interface CodexThreadSettings {
  cwd: string
  approvalPolicy: string
  approvalsReviewer: string
  sandboxPolicy: Record<string, unknown>
  activePermissionProfile: Record<string, unknown> | null
  model: string
  modelProvider: string
  serviceTier: string | null
  effort: string | null
  summary: string | null
  collaborationMode: CodexCollaborationMode
  personality: string | null
}

export interface ThreadSettingsUpdatedNotification {
  threadId: string
  threadSettings: CodexThreadSettings
}
```

Keep fields camelCase exactly as generated by upstream. Do not add unrelated update fields until a consumer exists.

- [ ] **Step 4: Implement the protocol client method**

Add to `CodexProtocolClient`:

```ts
async updateThreadSettings(
  params: ThreadSettingsUpdateParams,
): Promise<ThreadSettingsUpdateResponse> {
  return this.rpc<ThreadSettingsUpdateResponse>('thread/settings/update', params)
}
```

- [ ] **Step 5: Run the test and verify GREEN**

Run the Task 1 command again.

Expected: all collaboration-mode client tests PASS.

- [ ] **Step 6: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): add Codex thread settings update protocol
```

---

### Task 2: Route confirmed thread settings as an out-of-band event

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/codexNotificationRouter.ts`
- Modify: `src/main/agent/CodexProtocolClient.ts`
- Modify: `src/main/agent/__tests__/codexNotificationRouter.test.ts`
- Modify: `src/main/agent/__tests__/CodexProtocolClient.collaborationMode.test.ts`

- [ ] **Step 1: Add failing router tests**

Add:

```ts
it('maps thread/settings/updated to a confirmed collaboration state event', () => {
  const event = router.route('thread/settings/updated', {
    threadId: 'codex-thread-1',
    threadSettings: {
      model: 'gpt-5.5',
      effort: 'high',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          developer_instructions: null,
        },
      },
    },
  })

  expect(event).toEqual({
    type: 'thread_settings_updated',
    threadId: 'codex-thread-1',
    mode: 'default',
    model: 'gpt-5.5',
    effort: 'high',
  })
})

it('drops malformed thread/settings/updated payloads', () => {
  expect(router.route('thread/settings/updated', {
    threadId: '',
    threadSettings: {},
  })).toBeNull()
})
```

- [ ] **Step 2: Run router tests and verify RED**

Run:

```bash
npx vitest run src/main/agent/__tests__/codexNotificationRouter.test.ts
```

Expected: FAIL because the notification is unhandled.

- [ ] **Step 3: Define the internal event**

Add to `AgentStreamEvent` in `src/types/agent.ts`:

```ts
| {
    type: 'thread_settings_updated'
    threadId: string
    mode: 'default' | 'plan'
    model: string
    effort: string | null
  }
```

This event is thread-scoped but not part of a turn lifecycle. Declare it as its own
union member and dispatch it before per-turn queue routing; `turnId` is intentionally
absent.

- [ ] **Step 4: Parse the notification defensively**

Add a focused parser in `codexNotificationRouter.ts`:

```ts
function parseThreadSettingsUpdated(
  params: Record<string, unknown>,
): AgentStreamEvent | null {
  const threadId = params.threadId
  const settings = params.threadSettings
  if (typeof threadId !== 'string' || threadId.length === 0) return null
  if (!settings || typeof settings !== 'object') return null

  const record = settings as Record<string, unknown>
  const collaborationMode = record.collaborationMode
  if (!collaborationMode || typeof collaborationMode !== 'object') return null

  const mode = (collaborationMode as Record<string, unknown>).mode
  if (mode !== 'default' && mode !== 'plan') return null
  if (typeof record.model !== 'string' || record.model.length === 0) return null

  return {
    type: 'thread_settings_updated',
    threadId,
    mode,
    model: record.model,
    effort: typeof record.effort === 'string' ? record.effort : null,
  }
}
```

Route it before item/turn handling.

- [ ] **Step 5: Add a dedicated client callback test**

Construct a client with:

```ts
const onThreadSettingsNotification = vi.fn()
```

Send a fake `thread/settings/updated` notification and assert the callback receives the event while no per-turn queue is touched.

- [ ] **Step 6: Implement the dedicated callback**

Add to `CodexProtocolClientOptions`:

```ts
onThreadSettingsNotification?: (event: Extract<
  AgentStreamEvent,
  { type: 'thread_settings_updated' }
>) => void
```

In `routeNotification`, dispatch this variant before reading `event.turnId`:

```ts
if (event.type === 'thread_settings_updated') {
  this.options.onThreadSettingsNotification?.(event)
  return
}
```

- [ ] **Step 7: Run both narrow suites**

Run:

```bash
npx vitest run \
  src/main/agent/__tests__/codexNotificationRouter.test.ts \
  src/main/agent/__tests__/CodexProtocolClient.collaborationMode.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): surface confirmed Codex thread settings
```

---

### Task 3: Add shared collaboration mode rules

**Files:**
- Create: `src/shared/collaborationMode.ts`
- Create: `src/shared/__tests__/collaborationMode.test.ts`

- [ ] **Step 1: Write failing pure-function tests**

Create tests for:

```ts
describe('resolvePlanReasoningEffort', () => {
  it('uses the official preset for auto', () => {
    expect(resolvePlanReasoningEffort('auto', 'medium')).toBe('medium')
  })

  it('falls back to medium when auto has no preset value', () => {
    expect(resolvePlanReasoningEffort('auto', null)).toBe('medium')
  })

  it('keeps an explicit Plan override', () => {
    expect(resolvePlanReasoningEffort('high', 'medium')).toBe('high')
  })
})

describe('normaliseSupportedPlanEfforts', () => {
  it('keeps known efforts in display order and removes duplicates', () => {
    expect(normaliseSupportedPlanEfforts(['xhigh', 'low', 'low', 'medium']))
      .toEqual(['low', 'medium', 'xhigh'])
  })

  it('drops unknown upstream values without throwing', () => {
    expect(normaliseSupportedPlanEfforts(['medium', 'future-level']))
      .toEqual(['medium'])
  })
})
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run src/shared/__tests__/collaborationMode.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the complete pure module**

Create:

```ts
export type CollaborationModeKind = 'default' | 'plan'
export type PlanReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh'
export type ConcretePlanReasoningEffort = Exclude<PlanReasoningEffort, 'auto'>

export const PLAN_EFFORTS: readonly ConcretePlanReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

export function isPlanReasoningEffort(value: unknown): value is PlanReasoningEffort {
  return value === 'auto' || PLAN_EFFORTS.includes(value as ConcretePlanReasoningEffort)
}

export function resolvePlanReasoningEffort(
  preference: PlanReasoningEffort,
  presetEffort: string | null | undefined,
): ConcretePlanReasoningEffort {
  if (preference !== 'auto') return preference
  return PLAN_EFFORTS.includes(presetEffort as ConcretePlanReasoningEffort)
    ? (presetEffort as ConcretePlanReasoningEffort)
    : 'medium'
}

export function normaliseSupportedPlanEfforts(
  values: readonly string[],
): ConcretePlanReasoningEffort[] {
  const available = new Set(values)
  return PLAN_EFFORTS.filter((effort) => available.has(effort))
}
```

- [ ] **Step 4: Run and verify GREEN**

Run the Task 3 test command again.

Expected: PASS.

- [ ] **Step 5: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): centralize collaboration mode rules
```

---

### Task 4: Add backend and manager collaboration capabilities

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/types.ts`
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/__tests__/AgentManager.collaborationMode.test.ts`
- Create or modify: `src/main/agent/__tests__/CodexLocalBackend.collaborationMode.test.ts`

- [ ] **Step 1: Add failing backend passthrough tests**

Assert `CodexLocalBackend.updateThreadSettings(params)` forwards to the client and
that `onThreadSettingsNotification` supplied to the backend reaches its client options.

Run:

```bash
npx vitest run src/main/agent/__tests__/CodexLocalBackend.collaborationMode.test.ts
```

Expected: FAIL because the passthrough does not exist.

- [ ] **Step 2: Extend the backend interface**

Add to `IAgentBackend`:

```ts
updateThreadSettings?(
  params: ThreadSettingsUpdateParams,
): Promise<ThreadSettingsUpdateResponse>
```

Add `onThreadSettingsNotification` to `CodexLocalBackendOptions`, pass it to every
`CodexProtocolClient` construction path, and implement:

```ts
async updateThreadSettings(
  params: ThreadSettingsUpdateParams,
): Promise<ThreadSettingsUpdateResponse> {
  if (!this.client) {
    throw new Error('CodexLocalBackend.updateThreadSettings called before start')
  }
  return this.client.updateThreadSettings(params)
}
```

- [ ] **Step 3: Define IPC-domain payloads**

Add to `src/types/agent.ts`:

```ts
export interface AgentCollaborationCapabilities {
  planDefaultEffort: string
  supportedPlanEfforts: string[]
  source: 'codex' | 'fallback'
}

export type AgentCollaborationCapabilitiesResult =
  | { ok: true; data: AgentCollaborationCapabilities }
  | { ok: false; error: string }

export interface AgentCollaborationModeUpdatePayload {
  threadId: string
  mode: 'default' | 'plan'
  model: string
  defaultReasoningEffort?: string
  planReasoningEffort: PlanReasoningEffort
  requestVersion: number
}

export type AgentCollaborationModeUpdateResult =
  | { ok: true; data: { compatibility: 'immediate' | 'next-turn'; requestVersion: number } }
  | { ok: false; error: string; requestVersion: number }
```

Import `PlanReasoningEffort` from `src/shared/collaborationMode.ts`; do not redefine it.
Also add `planReasoningEffort?: PlanReasoningEffort` to
`AgentSendMessagePayload` and correct its `collaborationModeKind` comment:
explicit Default is sent on the wire; only a genuinely absent field preserves
legacy caller behavior.

- [ ] **Step 4: Replace the incorrect Default tests with failing correct tests**

In `AgentManager.collaborationMode.test.ts`:

- replace “default equals absent” with an assertion that explicit Default creates:

```ts
{
  mode: 'default',
  settings: {
    model: 'gpt-5.5',
    reasoning_effort: 'high',
    developer_instructions: null,
  },
}
```

- keep truly absent `collaborationModeKind` as omitted for non-capable callers;
- add Plan Auto, Plan High and “Plan does not mutate Default effort” cases;
- add capability response tests using `listCollaborationModes` plus `listModels`.

- [ ] **Step 5: Run manager tests and verify RED**

Run:

```bash
npx vitest run src/main/agent/__tests__/AgentManager.collaborationMode.test.ts
```

Expected: FAIL on explicit Default and missing manager RPC methods.

- [ ] **Step 6: Implement effective mode construction**

Add a private helper in `AgentManager`:

```ts
private async buildCollaborationMode(
  mode: CollaborationModeKind,
  model: string,
  defaultEffort: string | undefined,
  planPreference: PlanReasoningEffort,
): Promise<CodexCollaborationMode> {
  const reasoningEffort = mode === 'plan'
    ? resolvePlanReasoningEffort(
        planPreference,
        await this.planPresetReasoningEffort(),
      )
    : defaultEffort ?? null

  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null,
    },
  }
}
```

Update `assembleTurnInput` so an explicitly supplied Default is expanded instead of
dropped. Preserve omission only when no kind was supplied.

- [ ] **Step 7: Implement capability lookup**

Add:

```ts
async getCollaborationCapabilitiesRpc(
  model: string,
): Promise<AgentCollaborationCapabilitiesResult>
```

Behavior:

1. Fetch/cached `collaborationMode/list`.
2. Read Plan default effort.
3. Fetch `model/list` with `{ includeHidden: true }` and match
   `id === model || row.model === model`.
4. Return the row’s `supportedReasoningEfforts[].reasoningEffort`, normalized by
   `normaliseSupportedPlanEfforts`.
5. If either RPC is unavailable, return `{ planDefaultEffort: 'medium',
   supportedPlanEfforts: [], source: 'fallback' }`, not a thrown error.

- [ ] **Step 8: Implement immediate update with precise fallback**

Add:

```ts
async updateCollaborationModeRpc(
  payload: AgentCollaborationModeUpdatePayload,
): Promise<AgentCollaborationModeUpdateResult>
```

Resolve the DB thread id to Codex thread id, build the full mode, and call
`backend.updateThreadSettings`.

Treat only these as compatibility errors:

```ts
function isUnsupportedThreadSettingsUpdate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|unknown method|thread\/settings\/update.*(unsupported|requires experimentalApi)/i
    .test(message)
}
```

Return `compatibility: 'next-turn'` for that matcher. Return `{ ok: false }` for
auth, validation, timeout and all other failures.

Keep a process-generation support cache:

```ts
private threadSettingsUpdateSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown'
```

After the first unsupported result, do not call the missing RPC again; immediately
return `next-turn`. Mark successful calls as supported. Reset this support cache and
`collabModePresets` inside the existing Codex restart path so a newer replacement
binary is probed again.

- [ ] **Step 9: Wire confirmed settings to the DB-thread event sink**

When constructing `CodexLocalBackend`, pass a callback that maps the Codex thread id
back to its DB thread id and emits:

```ts
{
  type: 'thread_settings_updated',
  threadId: dbThreadId,
  mode,
  model,
  effort,
}
```

Reuse the existing `resolveDbThreadId(codexThreadId)` method, which already performs
the reverse lookup over `codexThreadIdByDbThreadId`; do not create a second mapping.

If no mapping exists, ignore the notification; never leak Codex ids to the renderer.
Cover mapped, unmapped and background-thread cases in the manager tests.

- [ ] **Step 10: Run manager/backend tests and verify GREEN**

Run:

```bash
npx vitest run \
  src/main/agent/__tests__/AgentManager.collaborationMode.test.ts \
  src/main/agent/__tests__/CodexLocalBackend.collaborationMode.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): align persistent Default and Plan thread settings
```

---

### Task 5: Expose collaboration settings through Electron IPC

**Files:**
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/main/agent/__tests__/ipc.collaborationMode.test.ts`
- Modify or create: `src/preload/__tests__/preload.collaborationMode.test.ts`

- [ ] **Step 1: Write failing IPC handler tests**

Cover:

```ts
expect(ipcMain.handle).toHaveBeenCalledWith(
  'agent:collaboration-capabilities',
  expect.any(Function),
)
expect(ipcMain.handle).toHaveBeenCalledWith(
  'agent:collaboration-update',
  expect.any(Function),
)
```

Invoke handlers and assert delegation to:

```ts
manager.getCollaborationCapabilitiesRpc(model)
manager.updateCollaborationModeRpc(payload)
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run src/main/agent/__tests__/ipc.collaborationMode.test.ts
```

Expected: FAIL because channels are absent.

- [ ] **Step 3: Register main-process handlers**

Add both channel names to `AGENT_HANDLE_CHANNELS`, then:

```ts
ipcMain.handle('agent:collaboration-capabilities', async (_event, model: string) =>
  (await getManager()).getCollaborationCapabilitiesRpc(model),
)

ipcMain.handle('agent:collaboration-update', async (_event, payload) =>
  (await getManager()).updateCollaborationModeRpc(payload),
)
```

Validate `model`, `threadId`, `mode`, `planReasoningEffort`, and finite non-negative
`requestVersion` before delegating. Invalid payloads return the normal `{ ok: false }`
envelope instead of throwing across contextBridge.

- [ ] **Step 4: Add preload tests and verify RED**

Assert the exposed API invokes the exact new channel constants.

Run:

```bash
npx vitest run src/preload/__tests__/preload.collaborationMode.test.ts
```

- [ ] **Step 5: Implement channel constants and AgentApi methods**

Add:

```ts
COLLABORATION_CAPABILITIES: 'agent:collaboration-capabilities',
COLLABORATION_UPDATE: 'agent:collaboration-update',
```

Expose:

```ts
getCollaborationCapabilities: (model: string) =>
  safeInvoke<AgentCollaborationCapabilitiesResult>(
    IPC_CHANNELS.AGENT.COLLABORATION_CAPABILITIES,
    model,
  ),

updateCollaborationMode: (payload: AgentCollaborationModeUpdatePayload) =>
  safeInvoke<AgentCollaborationModeUpdateResult>(
    IPC_CHANNELS.AGENT.COLLABORATION_UPDATE,
    payload,
  ),
```

Use top-level type imports; do not add inline imports.

- [ ] **Step 6: Run IPC and preload suites**

Run:

```bash
npx vitest run \
  src/main/agent/__tests__/ipc.collaborationMode.test.ts \
  src/preload/__tests__/preload.collaborationMode.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): expose collaboration settings over IPC
```

---

### Task 6: Correct renderer store ownership and persistence

**Files:**
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts`
- Modify: `src/renderer/src/features/agent-chat/__tests__/store.test.ts`

- [ ] **Step 1: Replace obsolete store expectations**

Change the default send test to:

```ts
expect(sendMessage.mock.calls[0][0].collaborationModeKind).toBe('default')
```

Add tests for:

- mode pending until `thread_settings_updated`;
- success clears pending and writes confirmed mode;
- failure clears pending and retains confirmed;
- background thread event updates only its map entry;
- stale `requestVersion` response is ignored;
- new thread draft is attached to the first send;
- global Plan effort persists independently from thread mode;
- unsupported saved effort resets to Auto;
- Plan → Default → Plan keeps Default and Plan efforts isolated;
- persisted thread selection is restored after a renderer/app restart and is
  explicitly resubmitted on the next turn.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run \
  src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts \
  src/renderer/src/features/agent-chat/__tests__/store.test.ts
```

Expected: FAIL on explicit Default and missing pending/effort state.

- [ ] **Step 3: Add versioned Plan effort storage**

Use:

```ts
const PLAN_EFFORT_STORAGE_KEY = 'agent.planReasoningEffort:v1'
const THREAD_MODE_STORAGE_KEY = 'agent.collaborationModesByThread:v1'

function readPlanReasoningEffort(): PlanReasoningEffort {
  try {
    const value = localStorage.getItem(PLAN_EFFORT_STORAGE_KEY)
    return isPlanReasoningEffort(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}

function persistPlanReasoningEffort(value: PlanReasoningEffort): void {
  try {
    localStorage.setItem(PLAN_EFFORT_STORAGE_KEY, value)
  } catch {
    // Storage is optional in private/restricted renderer contexts.
  }
}
```

- [ ] **Step 4: Persist only the minimum per-thread restart state**

Store a JSON object of `{ [dbThreadId]: 'default' | 'plan' }` under
`THREAD_MODE_STORAGE_KEY`. Parse defensively, drop unknown values, and wrap all storage
access in `try/catch`. This restart cache is not authoritative while the process is
running: a `thread_settings_updated` notification always overwrites it.

The current upstream `thread/read` and `thread/resume` response types do not expose
`collaborationMode`, so restart recovery cannot fetch that field directly. Restore the
last confirmed local selection, then explicitly resubmit it on the next `turn/start`;
do not claim the restored value has already been server-confirmed.

- [ ] **Step 5: Add explicit store state**

Add:

```ts
collabModeKind: CollaborationModeKind
collabModeByThread: Record<string, CollaborationModeKind>
collabModePendingByThread: Record<string, {
  target: CollaborationModeKind
  requestVersion: number
}>
collabModeCompatibility: 'immediate' | 'next-turn'
planReasoningEffort: PlanReasoningEffort
collaborationCapabilities?: AgentCollaborationCapabilities
collaborationError?: string
```

Actions:

```ts
requestCollabMode(kind: CollaborationModeKind): Promise<void>
setPlanReasoningEffort(effort: PlanReasoningEffort): Promise<void>
loadCollaborationCapabilities(): Promise<void>
```

- [ ] **Step 6: Implement the confirmed-state transition**

For an existing thread:

1. reject if `isRunning`;
2. write pending with incremented version;
3. invoke `updateCollaborationMode`;
4. on ordinary failure clear pending and set `collaborationError`;
5. on `next-turn` set compatibility and keep the selected draft for the next send;
6. do not write confirmed until the notification event arrives.

When `collabModeCompatibility === 'next-turn'`, skip further immediate-update IPC
attempts for the current process and update only the next-turn draft. This prevents
repeated method-not-found errors.

For no thread id, update only `collabModeKind` as the composer draft.

- [ ] **Step 7: Handle confirmed notification events**

In `applyEvent`:

```ts
if (event.type === 'thread_settings_updated') {
  // Update collabModeByThread[event.threadId], clear matching pending,
  // and update collabModeKind only when event.threadId is active.
}
```

Keep this branch before turn-item routing because it is not turn-scoped.
Persist the confirmed mode for restart recovery. Clear pending only when its target
matches the confirmed mode; if the server confirms a different mode with no matching
request, accept it as authoritative and expose a concise notice.

- [ ] **Step 8: Always include the selected kind on send**

Replace spread-omit with:

```ts
collaborationModeKind: state.collabModeKind,
planReasoningEffort: state.planReasoningEffort,
```

Also include the same fields in fresh-turn steer fallback. A true `turn/steer` must
not switch modes because upstream steer has no collaboration mode field.

- [ ] **Step 9: Load capabilities on model changes**

Call `getCollaborationCapabilities` using the canonical model from
`resolveModelSelection(selectedModelId)`. If the saved explicit Plan effort is not in
the returned supported list, reset it to Auto and set one info notice.

- [ ] **Step 10: Run store suites and verify GREEN**

Run the Task 6 command again.

Expected: PASS.

- [ ] **Step 11: Commit if explicitly authorized**

Suggested message:

```text
fix(agent): keep renderer collaboration state server-confirmed
```

---

### Task 7: Build the accessible split-button Plan control

**Files:**
- Create: `src/renderer/src/features/agent-chat/CollabModeControl.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx`

- [ ] **Step 1: Write failing component tests**

Cover:

```tsx
it('toggles mode from the primary button', async () => {
  render(<CollabModeControl disabled={false} />)
  await user.click(screen.getByRole('button', { name: /切换到 Plan/i }))
  expect(requestCollabMode).toHaveBeenCalledWith('plan')
})

it('opens effort options from the arrow without toggling mode', async () => {
  render(<CollabModeControl disabled={false} />)
  await user.click(screen.getByRole('button', { name: /Plan 推理设置/i }))
  expect(requestCollabMode).not.toHaveBeenCalled()
  expect(screen.getByRole('listbox', { name: /Plan 推理强度/i })).toBeTruthy()
})
```

Also test:

- Default and Plan visual labels;
- Auto subtitle shows current official value;
- unsupported efforts are absent;
- High/XHigh warning copy;
- pending spinner and disabled repeat click;
- running disabled title;
- ArrowUp/Down, Home/End, Enter and Escape;
- outside click;
- focus restoration to arrow;
- `aria-expanded`, `aria-controls`, `aria-selected`, `aria-live`;
- narrow-layout effort suffix class.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component structure**

Use one root and two adjacent buttons:

```tsx
<div ref={rootRef} className="relative inline-flex">
  <button
    type="button"
    aria-label={isPlan ? '切换到 Default' : '切换到 Plan'}
    title={disabled ? '当前回合结束后可切换' : undefined}
    onClick={() => void requestCollabMode(isPlan ? 'default' : 'plan')}
    disabled={disabled || pending}
  >
    <span aria-hidden="true">{isPlan ? '✦' : '○'}</span>
    <span>{isPlan ? 'Plan' : 'Default'}</span>
    {isPlan ? <span className="hidden sm:inline"> · {effortLabel}</span> : null}
  </button>
  <button
    ref={settingsButtonRef}
    type="button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-label="Plan 推理设置"
    onClick={() => setOpen((value) => !value)}
    disabled={disabled || pending}
  >
    <span aria-hidden="true">⌃</span>
  </button>
  {open ? (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Plan 推理强度"
      className="absolute bottom-full right-0 z-[40001] mb-2 rounded-lg border border-zinc-700 bg-zinc-950/95 shadow-xl backdrop-blur"
    >
      {effortOptions.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => { optionRefs.current[index] = node }}
          type="button"
          role="option"
          aria-selected={planReasoningEffort === option.value}
          onClick={() => void chooseEffort(option.value)}
          onKeyDown={(event) => handleOptionKeyDown(event, index)}
        >
          <span>{option.label}</span>
          <span>{option.description}</span>
        </button>
      ))}
    </div>
  ) : null}
  <span className="sr-only" aria-live="polite">{liveMessage}</span>
</div>
```

Define `effortOptions`, `chooseEffort`, `handleOptionKeyDown`, `optionRefs`,
`settingsButtonRef`, and `listboxId` locally in this file. Use `useId()` for the
control id and the existing chat store actions for all mutations; do not introduce a
second state source.

Follow the existing `ModelPicker`/`ImageChannelPicker` surface:

```text
bottom-full, z-[40001], rounded-lg, zinc-950/95, backdrop-blur,
cyan neutral state, fuchsia Plan state
```

- [ ] **Step 4: Implement keyboard and focus behavior**

Maintain `activeIndex`, focus the selected option on open, use exhaustive key handling,
and restore focus on Escape/selection. Do not register duplicate global listeners when
closed.

- [ ] **Step 5: Implement effort selection**

Render Auto first, then `supportedPlanEfforts`. Auto description is:

```text
跟随 Codex Plan 预设 · 当前 medium
```

Explicit option descriptions must explain latency/usage without claiming fixed cost.
Call `setPlanReasoningEffort` and close after acceptance.

- [ ] **Step 6: Run component test and lint**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx
```

Then use `ReadLints` on the component and test.

Expected: tests PASS; no new diagnostics.

- [ ] **Step 7: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): add accessible Plan mode split control
```

---

### Task 8: Integrate the control and ModelPicker scope choice

**Files:**
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx`
- Modify: `src/renderer/src/features/agent-chat/ModelPicker.tsx`
- Delete: `src/renderer/src/features/agent-chat/CollabModeToggle.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx`
- Modify relevant MentionInput tests if snapshots/imports reference the old control.

- [ ] **Step 1: Add failing ModelPicker scope tests**

For Plan active and a picker option resolving to the same canonical model with a
different effort, assert a small scope choice appears:

```text
仅 Plan
所有模式
```

Assert:

- “仅 Plan” calls `setPlanReasoningEffort`;
- “所有模式” calls `setSelectedModel` and resets Plan effort to Auto;
- a different canonical model follows the normal model pick without scope prompt;
- Default mode never shows the scope prompt.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx
```

- [ ] **Step 3: Implement scope comparison**

Before applying a model option:

```ts
const current = resolveModelSelection(selectedModelId)
const next = resolveModelSelection(id)
const needsPlanScope =
  collabModeKind === 'plan' &&
  current.model === next.model &&
  current.reasoningEffort !== next.reasoningEffort
```

When true, show a focused two-option subview inside the existing popover instead of
using `window.confirm`.

- [ ] **Step 4: Replace the old control in MentionInput**

Change the import and footer:

```tsx
<ModelPicker disabled={isRunning} />
<CollabModeControl disabled={isRunning} />
<ImageChannelPicker disabled={isRunning} />
```

No mode business logic belongs in `MentionInput`.

- [ ] **Step 5: Delete the old component**

Delete `CollabModeToggle.tsx` only after all imports and tests use the new control.

- [ ] **Step 6: Run focused renderer suites**

Run:

```bash
npx vitest run \
  src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if explicitly authorized**

Suggested message:

```text
feat(agent): integrate Plan effort UX into composer
```

---

### Task 9: Extend the real-binary smoke test

**Files:**
- Modify: `scripts/smoke-collaboration-mode.ts`

- [ ] **Step 1: Add a settings update probe**

After initialization and preset listing:

1. create an empty thread through `thread/start`;
2. register a temporary settings-notification promise;
3. call `thread/settings/update` with explicit Plan;
4. assert response `{}`;
5. assert notification mode is Plan;
6. call update with explicit Default;
7. assert notification mode is Default;
8. never call `turn/start` with valid user input, so no model request occurs.

If method-not-found occurs, print an explicit compatibility result and continue to the
existing `turn/start` parse probe. Any other failure fails the smoke.

- [ ] **Step 2: Run the bundled binary smoke**

Run serially, not alongside Vitest port-using suites:

```bash
npx tsx scripts/smoke-collaboration-mode.ts
```

Expected on supported binary:

```text
initialize OK
collaborationMode/list → Plan/Default
thread/settings/update → Plan confirmed
thread/settings/update → Default confirmed
turn/start parses collaborationMode
PASS
```

Expected on an older compatible binary: one `next-turn fallback` line, followed by PASS.

- [ ] **Step 3: Update stale script comments**

Document all four probe guarantees: capability gate, preset list, settings update, and
turn/start parsing. Remove references that imply only Plan and list are tested.

- [ ] **Step 4: Commit if explicitly authorized**

Suggested message:

```text
test(agent): smoke persistent collaboration settings
```

---

### Task 10: Full verification and handoff

**Files:**
- Verify all changed files.
- Update design/plan docs only if implementation discovers a proven protocol difference.

- [ ] **Step 1: Run all collaboration tests**

```bash
npx vitest run \
  src/shared/__tests__/collaborationMode.test.ts \
  src/main/agent/__tests__/CodexProtocolClient.collaborationMode.test.ts \
  src/main/agent/__tests__/codexNotificationRouter.test.ts \
  src/main/agent/__tests__/CodexLocalBackend.collaborationMode.test.ts \
  src/main/agent/__tests__/AgentManager.collaborationMode.test.ts \
  src/main/agent/__tests__/ipc.collaborationMode.test.ts \
  src/preload/__tests__/preload.collaborationMode.test.ts \
  src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts \
  src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx \
  src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx
```

Expected: all PASS.

- [ ] **Step 2: Run related regressions**

```bash
npx vitest run src/main/agent src/renderer/src/features/agent-chat
```

Record any pre-existing failures separately; fix every newly introduced failure.

- [ ] **Step 3: Run real binary smoke serially**

```bash
npx tsx scripts/smoke-collaboration-mode.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck and build**

```bash
npm run typecheck
npm run build:vite
```

Expected: build PASS. For typecheck, compare any failures against the pre-change baseline;
no new errors are allowed.

- [ ] **Step 5: Check changed-file diagnostics**

Use `ReadLints` for every changed `.ts`/`.tsx` file. Fix all newly introduced diagnostics.

- [ ] **Step 6: Inspect final diff and workspace state**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm:

- no generated/marketplace drift;
- no secrets or local runtime files;
- no unrelated formatting churn;
- the design and implementation agree.

- [ ] **Step 7: Run a focused code review**

Review specifically for:

- Default mode always explicit after a thread has collaboration capability;
- server-confirmed state wins over optimistic UI;
- no Codex thread id leaks into renderer state;
- no Plan effort leaks into Default;
- method-not-found is the only compatibility fallback;
- out-of-order/thread-switch events cannot overwrite active state;
- keyboard and focus behavior remains usable.

- [ ] **Step 8: Commit only if explicitly authorized**

Suggested final squashed message if the user prefers one commit:

```text
feat(agent): fully align Codex Plan mode state and UX
```
