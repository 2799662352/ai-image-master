# Codex Model Settings Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a capability-driven Codex model settings panel with separate Default/Plan reasoning, model-specific official context defaults, an explicit experimental 1M override, and a transactional restart/resume path for real context changes.

**Architecture:** Runtime `model/list` remains authoritative for visible models and reasoning levels; a shared versioned policy adds context defaults and filters provider-specific unsupported efforts. Renderer preferences are model-scoped, while the main process owns the confirmed active context and applies changes through a serialized, compensating restart transaction.

**Tech Stack:** Electron 28, TypeScript, React 19, Zustand, Codex app-server 0.144.1, Vitest, Testing Library, Node filesystem APIs.

**Design:** `docs/superpowers/specs/2026-07-12-codex-model-settings-alignment-design.md`

---

## Scope and file map

### New files

- `src/shared/modelSettings.ts` — shared effort union, context defaults, provider policy, legacy selection migration, 90% compact calculation.
- `src/shared/__tests__/modelSettings.test.ts` — pure capability and migration contract.
- `src/renderer/src/features/agent-chat/ModelSettingsPanel.tsx` — focused Context/Reasoning settings UI.
- `src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx` — canonical model list and panel behavior.
- `src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts` — model-scoped persistence and context request lifecycle.
- `src/main/agent/CodexRuntimeSettingsStore.ts` — atomic confirmed/pending context journal.
- `src/main/agent/__tests__/CodexRuntimeSettingsStore.test.ts` — persistence and crash recovery.
- `src/main/agent/__tests__/AgentManager.modelContext.test.ts` — strict restart/resume/rollback saga.
- `src/main/agent/__tests__/ipc.modelContext.test.ts` — IPC validation and envelopes.
- `src/preload/__tests__/preload.modelContext.test.ts` — renderer bridge contract.

### Modified files

- `src/shared/collaborationMode.ts`
- `src/types/agent.ts`
- `src/main/agent/codexProtocol.ts`
- `src/main/agent/types.ts`
- `src/main/agent/codexProviders.ts`
- `src/main/agent/codexLaunch.ts`
- `src/main/agent/CodexLocalBackend.ts`
- `src/main/agent/AgentManager.ts`
- `src/main/agent/ipc.ts`
- `src/preload/index.ts`
- `src/renderer/src/features/agent-chat/models.ts`
- `src/renderer/src/features/agent-chat/store.ts`
- `src/renderer/src/features/agent-chat/ModelPicker.tsx`
- `src/renderer/src/features/agent-chat/CollabModeControl.tsx`
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx`
- `src/renderer/src/features/agent-chat/contextWindowDefaults.ts`
- Existing tests named in each task.

### Deliberately unchanged

- `src/main/agent/CodexProtocolClient.ts` already omits absent effort and passes concrete strings.
- `src/renderer/src/features/agent-chat/ContextPopover.tsx` already accepts a fallback context window.
- `src/renderer/src/features/agent-chat/tokenSegments.ts` already prefers reported context over fallback.
- `src/renderer/src/features/agent-chat/MentionInput.tsx` already mounts `ModelPicker` and `CollabModeControl`.

---

### Task 1: Shared model capability policy and migration

**Files:**
- Create: `src/shared/modelSettings.ts`
- Create: `src/shared/__tests__/modelSettings.test.ts`
- Modify: `src/renderer/src/features/agent-chat/contextWindowDefaults.ts`

- [ ] **Step 1: Write failing shared capability tests**

Create `src/shared/__tests__/modelSettings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  EXPERIMENTAL_CONTEXT_WINDOW,
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  defaultContextWindowForModel,
  mergeModelSettingsCapabilities,
  migrateLegacyModelSelection,
  modelAutoCompactTokenLimit,
  modelContextOptions,
} from '../modelSettings'

describe('model settings capabilities', () => {
  it('keeps max and filters ultra for Right Code gpt-5.6-sol', () => {
    expect(mergeModelSettingsCapabilities({
      model: 'gpt-5.6-sol',
      provider: 'rightcode',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }).supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('filters max and ultra for Right Code gpt-5.5', () => {
    expect(mergeModelSettingsCapabilities({
      model: 'gpt-5.5',
      provider: 'rightcode',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }).supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it.each([
    ['gpt-5.6-sol', 372_000],
    ['gpt-5.6-terra', 372_000],
    ['gpt-5.6-luna', 372_000],
    ['gpt-5.5', 272_000],
    ['gpt-5.4', 272_000],
    ['gpt-5.4-mini', 272_000],
    ['custom-model', UNKNOWN_MODEL_CONTEXT_WINDOW],
  ])('uses the verified default context for %s', (model, expected) => {
    expect(defaultContextWindowForModel(model)).toBe(expected)
  })

  it('adds an experimental 1M option to every model', () => {
    expect(modelContextOptions('custom-model')).toEqual([
      { value: UNKNOWN_MODEL_CONTEXT_WINDOW, experimental: false },
      { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
    ])
  })

  it.each([
    ['gpt-5.4-low', { model: 'gpt-5.4', reasoningEffort: 'low', migrated: true }],
    ['gpt-5.4-medium', { model: 'gpt-5.4', reasoningEffort: 'medium', migrated: true }],
    ['gpt-5.4-high', { model: 'gpt-5.4', reasoningEffort: 'high', migrated: true }],
    ['gpt-5.4-xhigh', { model: 'gpt-5.4', reasoningEffort: 'xhigh', migrated: true }],
    ['gpt-5.5-xhigh', { model: 'gpt-5.5', reasoningEffort: 'xhigh', migrated: true }],
    ['vendor-new-model', { model: 'vendor-new-model', reasoningEffort: 'auto', migrated: false }],
  ])('migrates picker id %s', (id, expected) => {
    expect(migrateLegacyModelSelection(id)).toEqual(expected)
  })

  it.each([
    [200_000, 180_000],
    [272_000, 244_800],
    [372_000, 334_800],
    [1_000_000, 900_000],
  ])('uses a floor 90 percent compact limit for %i', (window, expected) => {
    expect(modelAutoCompactTokenLimit(window)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
pnpm exec vitest run "src/shared/__tests__/modelSettings.test.ts"
```

Expected: FAIL because `../modelSettings` does not exist.

- [ ] **Step 3: Implement the shared policy**

Create `src/shared/modelSettings.ts`:

```ts
export const MODEL_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ConcreteModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]
export type ModelReasoningEffort = 'auto' | ConcreteModelReasoningEffort

export const UNKNOWN_MODEL_CONTEXT_WINDOW = 200_000
export const EXPERIMENTAL_CONTEXT_WINDOW = 1_000_000

export interface ModelContextOption {
  value: number
  experimental: boolean
}

export interface ModelSettingsCapabilities {
  model: string
  provider: string
  defaultContextWindow: number
  contextOptions: ModelContextOption[]
  defaultReasoningEffort?: string
  supportedReasoningEfforts: ConcreteModelReasoningEffort[]
}

export interface LegacyModelSelection {
  model: string
  reasoningEffort: ModelReasoningEffort
  migrated: boolean
}

const VERIFIED_CONTEXTS: Readonly<Record<string, number>> = Object.freeze({
  'gpt-5.6-sol': 372_000,
  'gpt-5.6-terra': 372_000,
  'gpt-5.6-luna': 372_000,
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
})

const LEGACY_SELECTIONS: Readonly<Record<string, Omit<LegacyModelSelection, 'migrated'>>> =
  Object.freeze({
    'gpt-5.4-low': { model: 'gpt-5.4', reasoningEffort: 'low' },
    'gpt-5.4-medium': { model: 'gpt-5.4', reasoningEffort: 'medium' },
    'gpt-5.4-high': { model: 'gpt-5.4', reasoningEffort: 'high' },
    'gpt-5.4-xhigh': { model: 'gpt-5.4', reasoningEffort: 'xhigh' },
    'gpt-5.5-xhigh': { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
  })

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return value === 'auto'
    || (typeof value === 'string'
      && (MODEL_REASONING_EFFORTS as readonly string[]).includes(value))
}

export function defaultContextWindowForModel(model: string): number {
  return VERIFIED_CONTEXTS[model] ?? UNKNOWN_MODEL_CONTEXT_WINDOW
}

export function modelContextOptions(model: string): ModelContextOption[] {
  const official = defaultContextWindowForModel(model)
  return official === EXPERIMENTAL_CONTEXT_WINDOW
    ? [{ value: official, experimental: false }]
    : [
        { value: official, experimental: false },
        { value: EXPERIMENTAL_CONTEXT_WINDOW, experimental: true },
      ]
}

export function mergeModelSettingsCapabilities(input: {
  model: string
  provider: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: readonly string[]
}): ModelSettingsCapabilities {
  const supported = new Set(input.supportedReasoningEfforts)
  const efforts = MODEL_REASONING_EFFORTS.filter((effort) => {
    if (!supported.has(effort)) return false
    if (input.provider === 'rightcode' && input.model === 'gpt-5.5' && effort === 'max') {
      return false
    }
    return true
  })
  return {
    model: input.model,
    provider: input.provider,
    defaultContextWindow: defaultContextWindowForModel(input.model),
    contextOptions: modelContextOptions(input.model),
    defaultReasoningEffort: input.defaultReasoningEffort,
    supportedReasoningEfforts: efforts,
  }
}

export function migrateLegacyModelSelection(id: string): LegacyModelSelection {
  const legacy = LEGACY_SELECTIONS[id]
  return legacy
    ? { ...legacy, migrated: true }
    : { model: id, reasoningEffort: 'auto', migrated: false }
}

export function modelAutoCompactTokenLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9)
}
```

Modify `contextWindowDefaults.ts` so it imports and re-exports
`UNKNOWN_MODEL_CONTEXT_WINDOW` instead of defining another 200K source:

```ts
import { UNKNOWN_MODEL_CONTEXT_WINDOW } from '../../../../shared/modelSettings'

export { UNKNOWN_MODEL_CONTEXT_WINDOW }

/** One-release compatibility alias for existing callers and tests. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = UNKNOWN_MODEL_CONTEXT_WINDOW
export const CONTEXT_BASELINE_TOKENS = 12_000
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run "src/shared/__tests__/modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/contextWindowDefaults.test.ts"
```

Expected: both files PASS.

- [ ] **Step 5: Commit the shared policy**

```powershell
git add "src/shared/modelSettings.ts" "src/shared/__tests__/modelSettings.test.ts" "src/renderer/src/features/agent-chat/contextWindowDefaults.ts" "src/renderer/src/features/agent-chat/__tests__/contextWindowDefaults.test.ts"
git commit -m "feat(agent): define model settings capabilities"
```

---

### Task 2: Extend Plan reasoning to Max and restore true Auto semantics

**Files:**
- Modify: `src/shared/collaborationMode.ts`
- Modify: `src/renderer/src/features/agent-chat/CollabModeControl.tsx`
- Modify: `src/main/agent/codexProviders.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts`
- Test: `src/main/agent/__tests__/AgentManager.collaborationMode.test.ts`
- Test: `src/main/agent/__tests__/ipc.collaborationMode.test.ts`
- Test: `src/main/agent/__tests__/codexProviders.test.ts`

- [ ] **Step 1: Add failing Max and Auto tests**

Add these assertions:

```ts
// shared/collaborationMode test or store.collabMode.test.ts
expect(isPlanReasoningEffort('max')).toBe(true)
expect(normaliseSupportedPlanEfforts([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
```

```tsx
// CollabModeControl.test.tsx
setControlState({
  collaborationCapabilities: {
    planDefaultEffort: 'low',
    supportedPlanEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    source: 'codex',
  },
})
render(<CollabModeControl />)
fireEvent.click(screen.getByRole('button', { name: 'Plan 推理设置' }))
expect(screen.getByRole('option', { name: /Max/ })).toBeTruthy()
```

```ts
// ipc.collaborationMode.test.ts
await handler({}, {
  threadId: 'thread-1',
  mode: 'plan',
  model: 'gpt-5.6-sol',
  planReasoningEffort: 'max',
  requestVersion: 1,
})
expect(updateCollaborationModeRpc).toHaveBeenCalledWith(
  expect.objectContaining({ planReasoningEffort: 'max' }),
)
```

```ts
// codexProviders.test.ts
const rightCode = BUILTIN_PROVIDER_PRESETS.find((provider) => provider.id === 'rightcode')
expect(rightCode?.model).toBe('gpt-5.5')
expect(rightCode).not.toHaveProperty('reasoningEffort')
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx" "src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts" "src/main/agent/__tests__/AgentManager.collaborationMode.test.ts" "src/main/agent/__tests__/ipc.collaborationMode.test.ts" "src/main/agent/__tests__/codexProviders.test.ts"
```

Expected failures:

- `max` is rejected by the current Plan union/IPC validator.
- `CollabModeControl` lacks a Max label/description.
- Right Code still pins `xhigh`.

- [ ] **Step 3: Implement Max using the shared effort union**

Modify `collaborationMode.ts`:

```ts
import {
  MODEL_REASONING_EFFORTS,
  type ConcreteModelReasoningEffort,
  type ModelReasoningEffort,
} from './modelSettings'

export type CollaborationModeKind = 'default' | 'plan'
export const PLAN_EFFORTS = MODEL_REASONING_EFFORTS
export type ConcretePlanReasoningEffort = ConcreteModelReasoningEffort
export type PlanReasoningEffort = ModelReasoningEffort
```

Keep `resolvePlanReasoningEffort()` fallback at `medium`; update the exhaustive
normalizer to return `low/medium/high/xhigh/max` in that order.

Modify `CollabModeControl.tsx`:

```ts
const EFFORT_LABELS: Record<PlanReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

const EFFORT_DESCRIPTIONS: Record<ConcretePlanReasoningEffort, string> = {
  low: '更快，通常减少推理用量',
  medium: '平衡计划深度、用量与延迟',
  high: '更深入；可能增加用量与延迟',
  xhigh: '最深入；可能显著增加用量与延迟',
  max: '最大推理深度；仅在当前模型与 Provider 支持时可用',
}
```

Modify the Plan IPC validator to call `isPlanReasoningEffort()` instead of
maintaining a second literal list.

In `AgentManager.getCollaborationCapabilitiesRpc()`, pass the selected model's
runtime efforts through the same Provider policy before returning them:

```ts
const providerAware = mergeModelSettingsCapabilities({
  model,
  provider: this.activeProviderId,
  defaultReasoningEffort: modelInfo.defaultReasoningEffort,
  supportedReasoningEfforts: modelInfo.supportedReasoningEfforts,
})

return {
  ok: true,
  data: {
    planDefaultEffort,
    supportedPlanEfforts: providerAware.supportedReasoningEfforts,
    source: 'codex',
  },
}
```

Extend `AgentManager.collaborationMode.test.ts` with separate Right Code
GPT-5.6 Sol and GPT-5.5 cases so Plan cannot bypass the Provider filter.

Remove `reasoningEffort: 'xhigh'` from `RIGHTCODE_PRESET`. Update its description
to avoid promising a global xhigh default:

```ts
const RIGHTCODE_PRESET: ProviderPreset = {
  id: 'rightcode',
  name: 'Right.Codes',
  baseUrl: 'https://right.codes/codex/v1',
  envKey: 'OPENAI_API_KEY',
  model: 'gpt-5.5',
  verbosity: 'high',
  requiresOpenaiAuth: true,
  extraTopLevelConfig: Object.freeze({
    disable_response_storage: true,
    windows_wsl_setup_acknowledged: true,
  }),
  description: 'Pro号池 0.4x · cache_read 1/10 输入价',
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2.

Expected: all named suites PASS, including existing unsupported-effort fallback tests.

- [ ] **Step 5: Commit Plan Max support**

```powershell
git add "src/shared/collaborationMode.ts" "src/renderer/src/features/agent-chat/CollabModeControl.tsx" "src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx" "src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts" "src/main/agent/codexProviders.ts" "src/main/agent/AgentManager.ts" "src/main/agent/ipc.ts" "src/main/agent/__tests__/AgentManager.collaborationMode.test.ts" "src/main/agent/__tests__/ipc.collaborationMode.test.ts" "src/main/agent/__tests__/codexProviders.test.ts"
git commit -m "feat(agent): support model-aware Plan Max effort"
```

---

### Task 3: Canonical model rows and model-scoped ordinary Reasoning

**Files:**
- Modify: `src/renderer/src/features/agent-chat/models.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/types/agent.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/models.test.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts`
- Modify: `src/renderer/src/features/agent-chat/__tests__/store.test.ts`

- [ ] **Step 1: Write failing canonical-model and store tests**

Replace effort-variant expectations in `models.test.ts`:

```ts
it('keeps one row per canonical model', () => {
  const ids = AGENT_MODELS.map((model) => model.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).not.toContain('gpt-5.4-high')
  expect(ids).not.toContain('gpt-5.5-xhigh')
})

it('omits effort for Auto and forwards Max unchanged', () => {
  expect(resolveModelSelection('gpt-5.6-sol', 'auto')).toEqual({
    model: 'gpt-5.6-sol',
  })
  expect(resolveModelSelection('gpt-5.6-sol', 'max')).toEqual({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
  })
})
```

Create `store.modelSettings.test.ts` with cold-module migration:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ordinary model settings', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('migrates an effort-suffixed picker id exactly once', async () => {
    localStorage.setItem('catimation.agent.selectedModel', 'gpt-5.5-xhigh')
    const { useAgentChatStore } = await import('../store')
    expect(useAgentChatStore.getState().selectedModelId).toBe('gpt-5.5')
    expect(useAgentChatStore.getState().modelReasoningEffortByModel).toMatchObject({
      'gpt-5.5': 'xhigh',
    })
  })

  it('persists ordinary reasoning without changing Plan reasoning', async () => {
    const { useAgentChatStore } = await import('../store')
    useAgentChatStore.setState({ planReasoningEffort: 'high' } as never)
    useAgentChatStore.getState().setModelReasoningEffort('gpt-5.6-sol', 'max')
    expect(useAgentChatStore.getState()).toMatchObject({
      planReasoningEffort: 'high',
      modelReasoningEffortByModel: { 'gpt-5.6-sol': 'max' },
    })
  })
})
```

Update `store.test.ts` send coverage:

```ts
useAgentChatStore.setState({
  selectedModelId: 'gpt-5.6-sol',
  modelReasoningEffortByModel: { 'gpt-5.6-sol': 'max' },
} as never)
await useAgentChatStore.getState().send()
expect(sendMessage).toHaveBeenCalledWith(
  expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'max' }),
)
```

Add an Auto test asserting the payload has no `reasoningEffort` own property.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/models.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.test.ts"
```

Expected: FAIL because model rows still encode effort and the store lacks model-scoped maps.

- [ ] **Step 3: Canonicalize `models.ts`**

Keep one row per real slug:

```ts
import {
  type ConcreteModelReasoningEffort,
  type ModelReasoningEffort,
} from '../../../../shared/modelSettings'

export interface ModelOption {
  id: string
  label: string
  tier: ModelTier
  description: string
}

export interface ResolvedModelSelection {
  model: string
  reasoningEffort?: ConcreteModelReasoningEffort
}

export function resolveModelSelection(
  model: string,
  effort: ModelReasoningEffort,
): ResolvedModelSelection {
  return effort === 'auto'
    ? { model }
    : { model, reasoningEffort: effort }
}
```

Remove the `model` and `reasoningEffort` fields from `ModelOption`; collapse
duplicate GPT-5.4/GPT-5.5 rows. Preserve the existing canonical GPT-5.6 rows.

- [ ] **Step 4: Add versioned model-scoped store state**

In `store.ts`, add:

```ts
const MODEL_REASONING_STORAGE_KEY = 'agent.modelReasoningByModel:v1'
const MODEL_CONTEXT_STORAGE_KEY = 'agent.modelContextByModel:v1'

modelReasoningEffortByModel: Record<string, ModelReasoningEffort>
modelContextWindowByModel: Record<string, number>

setModelReasoningEffort: (
  model: string,
  effort: ModelReasoningEffort,
) => void
```

Use lazy safe readers that validate every value with
`isModelReasoningEffort()` and finite positive integer checks. During initial
state creation:

```ts
const legacy = migrateLegacyModelSelection(readPersistedModelIdRaw())
const persistedReasoning = readModelReasoningByModel()
if (!(legacy.model in persistedReasoning) && legacy.reasoningEffort !== 'auto') {
  persistedReasoning[legacy.model] = legacy.reasoningEffort
}
```

Implement the action with a functional update:

```ts
setModelReasoningEffort: (model, effort) => {
  set((state) => {
    const next = {
      ...state.modelReasoningEffortByModel,
      [model]: effort,
    }
    persistModelReasoningByModel(next)
    return { modelReasoningEffortByModel: next }
  })
}
```

Update send/steer/requestCollabMode call sites:

```ts
const ordinaryEffort =
  state.modelReasoningEffortByModel[state.selectedModelId] ?? 'auto'
const modelSelection = resolveModelSelection(
  state.selectedModelId,
  ordinaryEffort,
)
```

Do not read Plan effort from this map.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2.

Expected: all three suites PASS and Auto payloads omit effort.

- [ ] **Step 6: Commit canonical model state**

```powershell
git add "src/renderer/src/features/agent-chat/models.ts" "src/renderer/src/features/agent-chat/store.ts" "src/types/agent.ts" "src/renderer/src/features/agent-chat/__tests__/models.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.test.ts"
git commit -m "refactor(agent): separate model and reasoning selection"
```

---

### Task 4: Build the isolated Model Settings panel

**Files:**
- Create: `src/renderer/src/features/agent-chat/ModelSettingsPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/__tests__/ModelSettingsPanel.test.tsx`

- [ ] **Step 1: Write failing component tests**

Create `ModelSettingsPanel.test.tsx` and test the component through props so
this task stays green before IPC/store integration:

```tsx
const capabilities = mergeModelSettingsCapabilities({
  model: 'gpt-5.6-sol',
  provider: 'rightcode',
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
})

render(
  <ModelSettingsPanel
    capabilities={capabilities}
    reasoningEffort="max"
    contextWindow={372_000}
    disabled={false}
    pending={false}
    onReasoningChange={vi.fn()}
    onContextChange={vi.fn().mockResolvedValue(undefined)}
  />,
)
expect(screen.getByRole('option', { name: /372K/ })).toBeTruthy()
expect(screen.getByRole('option', { name: /1M.*实验性/ })).toBeTruthy()
expect(screen.getByRole('option', { name: /Max/ })).toBeTruthy()
expect(screen.queryByRole('option', { name: /Ultra/ })).toBeNull()
expect(screen.queryByText(/Fast/)).toBeNull()
expect(screen.getByText(/Provider 可能拒绝/)).toBeTruthy()
```

Add:

- GPT-5.5 has no Max;
- running/pending disables both sections;
- context error is exposed via `aria-live`;
- clicking 1M calls `onContextChange(1_000_000)`;
- clicking Auto calls `onReasoningChange('auto')`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/ModelSettingsPanel.test.tsx"
```

Expected: FAIL because `ModelSettingsPanel` does not exist.

- [ ] **Step 3: Implement `ModelSettingsPanel`**

Use focused props so the component is independently testable:

```ts
import { useId } from 'react'

interface ModelSettingsPanelProps {
  capabilities: ModelSettingsCapabilities
  reasoningEffort: ModelReasoningEffort
  contextWindow: number
  disabled: boolean
  pending: boolean
  error?: string
  onReasoningChange: (effort: ModelReasoningEffort) => void
  onContextChange: (contextWindow: number) => Promise<void>
}

export function formatContextWindow(value: number): string {
  return value >= 1_000_000
    ? `${value / 1_000_000}M`
    : `${Math.round(value / 1_000)}K`
}
```

Render two listboxes:

```tsx
const id = useId()

<section aria-labelledby={`${id}-context-heading`}>
  <h3 id={`${id}-context-heading`}>Context</h3>
  <div role="listbox" aria-label="模型上下文">
    {capabilities.contextOptions.map((option) => (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={contextWindow === option.value}
        aria-disabled={disabled || pending}
        onClick={() => void onContextChange(option.value)}
      >
        {formatContextWindow(option.value)}
        {option.experimental ? ' · 实验性' : ''}
      </button>
    ))}
  </div>
</section>
```

Reasoning options are:

```ts
const efforts: ModelReasoningEffort[] = [
  'auto',
  ...capabilities.supportedReasoningEfforts,
]
```

Use the same exhaustive labels as Plan. Add a visible 1M risk notice and an
`aria-live="polite"` status for pending/error.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2.

Expected: the component suite PASS.

- [ ] **Step 5: Commit the isolated panel**

```powershell
git add "src/renderer/src/features/agent-chat/ModelSettingsPanel.tsx" "src/renderer/src/features/agent-chat/__tests__/ModelSettingsPanel.test.tsx"
git commit -m "feat(agent): add isolated model settings panel"
```

---

### Task 5: Persist confirmed runtime Context and launch with dynamic limits

**Files:**
- Create: `src/main/agent/CodexRuntimeSettingsStore.ts`
- Create: `src/main/agent/__tests__/CodexRuntimeSettingsStore.test.ts`
- Modify: `src/types/agent.ts`
- Modify: `src/main/agent/codexLaunch.ts`
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/types.ts`
- Test: `src/main/agent/__tests__/codexLaunch.test.ts`
- Test: `src/main/agent/__tests__/CodexLocalBackend.test.ts`

- [ ] **Step 1: Write failing persistence and launch tests**

Create store tests using a temporary directory:

```ts
it('loads a safe first-run default', () => {
  const store = new CodexRuntimeSettingsStore({ userDataDir })
  expect(store.loadSync()).toEqual({
    version: 1,
    confirmed: {
      modelContextWindow: 200_000,
      modelAutoCompactTokenLimit: 180_000,
    },
  })
})

it('clears an interrupted pending transaction on load', async () => {
  const writeFixture = (value: PersistedCodexRuntimeSettingsV1) =>
    writeFile(
      join(userDataDir, 'codex-runtime-settings.json'),
      JSON.stringify(value),
      'utf8',
    )
  await writeFixture({
    version: 1,
    confirmed: {
      modelContextWindow: 372_000,
      modelAutoCompactTokenLimit: 334_800,
    },
    pending: {
      target: {
        modelContextWindow: 1_000_000,
        modelAutoCompactTokenLimit: 900_000,
      },
      requestVersion: 7,
      startedAt: '2026-07-12T00:00:00.000Z',
    },
  })
  expect(new CodexRuntimeSettingsStore({ userDataDir }).loadSync().pending).toBeUndefined()
})
```

Update `codexLaunch.test.ts`:

```ts
const args = buildCodexLaunchArgs({
  provider: {
    id: 'test',
    name: 'Test',
    baseUrl: 'https://example.invalid/v1',
    envKey: 'OPENAI_API_KEY',
    extraTopLevelConfig: { custom_flag: true },
  },
  modelContextConfig: {
    modelContextWindow: 372_000,
    modelAutoCompactTokenLimit: 334_800,
  },
})
expect(args).toContain('model_context_window=372000')
expect(args).toContain('model_auto_compact_token_limit=334800')
expect(args.indexOf('model_context_window=372000')).toBeGreaterThan(
  args.findLastIndex((arg) => arg.includes('custom_flag=true')),
)
```

Update backend tests to assert every fresh spawn reads the latest Context getter
and busy restart rejects instead of resolving.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/CodexRuntimeSettingsStore.test.ts" "src/main/agent/__tests__/codexLaunch.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts"
```

Expected: FAIL because the store and dynamic launch options do not exist.

- [ ] **Step 3: Implement the atomic runtime settings store**

Define in `src/types/agent.ts`:

```ts
export interface CodexModelContextConfig {
  modelContextWindow: number
  modelAutoCompactTokenLimit: number
}
```

Create `CodexRuntimeSettingsStore.ts`:

```ts
export interface PersistedCodexRuntimeSettingsV1 {
  version: 1
  confirmed: CodexModelContextConfig
  pending?: {
    target: CodexModelContextConfig
    requestVersion: number
    startedAt: string
  }
}

export class CodexRuntimeSettingsStore {
  private readonly filePath: string

  constructor(options: { userDataDir: string }) {
    this.filePath = join(options.userDataDir, 'codex-runtime-settings.json')
  }

  loadSync(): PersistedCodexRuntimeSettingsV1 {
    const parsed = readAndValidateOrDefault(this.filePath)
    if (parsed.pending) {
      const recovered = { version: 1 as const, confirmed: parsed.confirmed }
      writeFileSync(this.filePath, JSON.stringify(recovered, null, 2))
      return recovered
    }
    return parsed
  }

  async replace(next: PersistedCodexRuntimeSettingsV1): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
    await rename(temp, this.filePath)
  }
}

const DEFAULT_RUNTIME_SETTINGS: PersistedCodexRuntimeSettingsV1 = {
  version: 1,
  confirmed: {
    modelContextWindow: 200_000,
    modelAutoCompactTokenLimit: 180_000,
  },
}

function readAndValidateOrDefault(
  filePath: string,
): PersistedCodexRuntimeSettingsV1 {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (!isPersistedRuntimeSettings(parsed)) return DEFAULT_RUNTIME_SETTINGS
    return parsed
  } catch {
    return DEFAULT_RUNTIME_SETTINGS
  }
}
```

Validation must require positive safe integers and enforce:

```ts
modelAutoCompactTokenLimit === modelAutoCompactTokenLimit(
  modelContextWindow,
)
```

`isPersistedRuntimeSettings()` validates `version`, `confirmed`, and optional
`pending.target/requestVersion/startedAt` with those rules. Return fresh object
copies from the default path so callers cannot mutate a module constant.

Malformed files return the safe 200K/180K default.

- [ ] **Step 4: Make launch Context explicit and last-wins**

Add to `CodexLaunchOptions`:

```ts
modelContextConfig?: CodexModelContextConfig
```

Remove the hard-coded 220K line. After provider and extra-provider overrides
have been assembled, append:

```ts
const context = options?.modelContextConfig ?? {
  modelContextWindow: 200_000,
  modelAutoCompactTokenLimit: 180_000,
}

return [
  ...argsWithProviderOverrides,
  '-c', `model_context_window=${context.modelContextWindow}`,
  '-c', `model_auto_compact_token_limit=${context.modelAutoCompactTokenLimit}`,
]
```

Reject `model_context_window` and `model_auto_compact_token_limit` inside
provider `extraTopLevelConfig` so provider presets cannot override the
application's confirmed truth.

- [ ] **Step 5: Make backend Context mutable per restart**

Extend `CodexLocalBackendOptions`:

```ts
getModelContextConfig?: () => CodexModelContextConfig
```

Call the getter inside `startSpawnedClient()` immediately before
`buildCodexLaunchArgs()`. Add:

```ts
hasInFlightWork(): boolean {
  return this.client?.hasInFlightWork() ?? false
}
```

Change the restart guard:

```ts
if (this.client?.hasInFlightWork()) {
  throw new Error('Codex context cannot restart while a turn is running')
}
```

Keep replacement-first switching so a failed replacement leaves the old
process alive.

- [ ] **Step 6: Run tests and verify GREEN**

Run the command from Step 2.

Expected: all named suites PASS; no launch args contain 220000.

- [ ] **Step 7: Commit runtime Context launch support**

```powershell
git add "src/main/agent/CodexRuntimeSettingsStore.ts" "src/main/agent/__tests__/CodexRuntimeSettingsStore.test.ts" "src/types/agent.ts" "src/main/agent/codexLaunch.ts" "src/main/agent/CodexLocalBackend.ts" "src/main/agent/types.ts" "src/main/agent/__tests__/codexLaunch.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts"
git commit -m "feat(agent): persist runtime context configuration"
```

---

### Task 6: Transactional Context restart, strict resume, and rollback

**Files:**
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/types.ts`
- Modify: `src/types/agent.ts`
- Create: `src/main/agent/__tests__/AgentManager.modelContext.test.ts`

- [ ] **Step 1: Write failing Manager saga tests**

Create a backend fake that records operations:

```ts
const operations: string[] = []
const backend = {
  currentEpoch: () => epoch,
  hasInFlightWork: () => false,
  restartCodex: async () => {
    operations.push('restart')
    epoch += 1
  },
  resumeThread: async (threadId: string) => {
    operations.push(`resume:${threadId}`)
  },
  listModels: async () => {
    operations.push('refresh-models')
    return MODEL_LIST
  },
} satisfies Partial<IAgentBackend>
```

Test:

```ts
it('orders persist restart resume refresh confirm', async () => {
  const result = await manager.applyModelContextRpc({
    threadId: 'db-thread-1',
    model: 'gpt-5.6-sol',
    contextWindow: 1_000_000,
    requestVersion: 4,
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      threadRestored: true,
      requestVersion: 4,
    },
  })
  expect(operations).toEqual([
    'persist-pending',
    'restart',
    'resume:codex-thread-1',
    'refresh-models',
    'persist-confirmed',
  ])
})
```

Add separate tests for:

- busy returns stage `busy` without persistence;
- same context returns success without restart;
- restart failure restores old confirmed settings and restarts once;
- resume failure triggers rollback;
- rollback failure returns both errors;
- rollback executes once and never recurses;
- a restart that leaves epoch unchanged is a failure;
- no current thread skips strict resume;
- sends/steers are rejected while the Context saga owns the lifecycle lock.

- [ ] **Step 2: Run the Manager test and verify RED**

Run:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/AgentManager.modelContext.test.ts"
```

Expected: FAIL because `applyModelContextRpc()` and lifecycle serialization do not exist.

- [ ] **Step 3: Add discriminated request/result types**

In `src/types/agent.ts`:

```ts
export interface AgentModelContextApplyPayload {
  threadId?: string
  model: string
  contextWindow: number
  requestVersion: number
}

export type AgentModelContextApplyStage =
  | 'validate'
  | 'busy'
  | 'persist'
  | 'restart'
  | 'resume'
  | 'verify'

export type AgentModelContextApplyResult =
  | {
      ok: true
      data: {
        model: string
        contextWindow: number
        autoCompactTokenLimit: number
        threadRestored: boolean
        requestVersion: number
      }
    }
  | {
      ok: false
      error: string
      stage: AgentModelContextApplyStage
      previousConfig: CodexModelContextConfig
      attemptedConfig: CodexModelContextConfig
      requestVersion: number
      rollback:
        | { ok: true; activeConfig: CodexModelContextConfig }
        | { ok: false; error: string; effectiveConfig: null }
    }
```

- [ ] **Step 4: Introduce an error-propagating lifecycle queue**

In `AgentManager`:

```ts
private lifecycleTail: Promise<void> = Promise.resolve()
private contextUpdateInProgress = false

private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const run = this.lifecycleTail.then(operation, operation)
  this.lifecycleTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
```

Migrate provider/key restarts to this same tail while preserving whether their
caller awaits the result. Do not catch inside the operation before the Context
saga receives its rejection.

At send/steer entry:

```ts
if (this.contextUpdateInProgress) {
  return { ok: false, error: 'Codex context settings are being applied' }
}
```

- [ ] **Step 5: Implement strict thread restore**

```ts
private async restoreCodexThreadStrict(
  dbThreadId: string,
  codexThreadId: string,
): Promise<void> {
  if (typeof this.backend.resumeThread !== 'function') {
    throw new Error('Codex backend does not support thread/resume')
  }
  await this.backend.resumeThread(codexThreadId)
  this.rememberCodexThread(dbThreadId, codexThreadId)
  const epoch = this.backend.currentEpoch?.()
  if (epoch !== undefined) {
    this.codexThreadEpochByDbThreadId.set(dbThreadId, epoch)
  }
}
```

Unlike the send path, this helper must never fall back to a new thread.

- [ ] **Step 6: Implement the forward saga and one-shot rollback**

Construct the backend with:

```ts
this.runtimeSettingsStore = new CodexRuntimeSettingsStore({
  userDataDir: opts.userDataDir,
})
this.runtimeSettings = this.runtimeSettingsStore.loadSync()

getModelContextConfig: () => this.runtimeSettings.pending?.target
  ?? this.runtimeSettings.confirmed
```

Implement:

```ts
async applyModelContextRpc(
  payload: AgentModelContextApplyPayload,
): Promise<AgentModelContextApplyResult> {
  return this.enqueueLifecycle(async () => {
    const previous = this.runtimeSettings.confirmed
    const attempted = {
      modelContextWindow: payload.contextWindow,
      modelAutoCompactTokenLimit: modelAutoCompactTokenLimit(payload.contextWindow),
    }
    const validPayload = typeof payload.model === 'string'
      && payload.model.trim().length > 0
      && Number.isSafeInteger(payload.requestVersion)
      && payload.requestVersion >= 0
      && modelContextOptions(payload.model)
        .some((option) => option.value === payload.contextWindow)
    if (!validPayload) {
      return this.modelContextFailureWithoutRollback(
        'validate',
        'Invalid model Context request',
        previous,
        attempted,
        payload,
      )
    }
    if (contextsEqual(previous, attempted)) {
      return this.modelContextSuccess(payload, attempted, false)
    }
    this.contextUpdateInProgress = true
    try {
      if (this.backend.hasInFlightWork?.()) {
        return this.modelContextFailureWithoutRollback(
          'busy',
          'A turn is still running',
          previous,
          attempted,
          payload,
        )
      }
      const codexThreadId = payload.threadId
        ? await this.resolveCodexThreadIdForRpc(payload.threadId)
        : undefined
      const epochBefore = this.backend.currentEpoch?.()
      try {
        await this.runContextStage('persist', () =>
          this.persistPending(previous, attempted, payload.requestVersion))
        this.runtimeSettings = {
          version: 1,
          confirmed: previous,
          pending: {
            target: attempted,
            requestVersion: payload.requestVersion,
            startedAt: new Date().toISOString(),
          },
        }
        await this.runContextStage('restart', async () => {
          if (!this.backend.restartCodex) {
            throw new Error('Codex backend does not support restart')
          }
          await this.backend.restartCodex(this.workspacePaths())
        })
        const epochAfter = this.backend.currentEpoch?.()
        if (
          epochBefore !== undefined
          && epochAfter !== undefined
          && epochAfter === epochBefore
        ) {
          throw new ContextApplyError('verify', 'Codex restart did not advance epoch')
        }
        if (payload.threadId && codexThreadId) {
          await this.runContextStage('resume', () =>
            this.restoreCodexThreadStrict(payload.threadId!, codexThreadId))
        }
        await this.refreshModelSettingsAfterRestart()
        await this.runContextStage('persist', () => this.persistConfirmed(attempted))
        return this.modelContextSuccess(payload, attempted, Boolean(codexThreadId))
      } catch (error) {
        return this.rollbackModelContext({
          payload,
          previous,
          attempted,
          originalError: error,
          dbThreadId: payload.threadId,
          codexThreadId,
        })
      }
    } finally {
      this.contextUpdateInProgress = false
    }
  })
}
```

Add the helpers used above in the same task:

```ts
class ContextApplyError extends Error {
  constructor(
    readonly stage: AgentModelContextApplyStage,
    message: string,
  ) {
    super(message)
  }
}

function contextsEqual(
  left: CodexModelContextConfig,
  right: CodexModelContextConfig,
): boolean {
  return left.modelContextWindow === right.modelContextWindow
    && left.modelAutoCompactTokenLimit === right.modelAutoCompactTokenLimit
}

private async runContextStage<T>(
  stage: AgentModelContextApplyStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new ContextApplyError(
      stage,
      error instanceof Error ? error.message : String(error),
    )
  }
}

private async persistPending(
  previous: CodexModelContextConfig,
  attempted: CodexModelContextConfig,
  requestVersion: number,
): Promise<void> {
  await this.runtimeSettingsStore.replace({
    version: 1,
    confirmed: previous,
    pending: {
      target: attempted,
      requestVersion,
      startedAt: new Date().toISOString(),
    },
  })
}

private async persistConfirmed(config: CodexModelContextConfig): Promise<void> {
  this.runtimeSettings = { version: 1, confirmed: config }
  await this.runtimeSettingsStore.replace(this.runtimeSettings)
}

private async refreshModelSettingsAfterRestart(): Promise<void> {
  this.collabModePresets = null
  this.collaborationCacheEpoch = undefined
  this.threadSettingsUpdateSupport = 'unknown'
  if (this.backend.listModels) {
    await this.backend.listModels({ includeHidden: false, limit: 100 })
  }
}

private modelContextSuccess(
  payload: AgentModelContextApplyPayload,
  config: CodexModelContextConfig,
  threadRestored: boolean,
): AgentModelContextApplyResult {
  return {
    ok: true,
    data: {
      model: payload.model,
      contextWindow: config.modelContextWindow,
      autoCompactTokenLimit: config.modelAutoCompactTokenLimit,
      threadRestored,
      requestVersion: payload.requestVersion,
    },
  }
}

private modelContextFailureWithoutRollback(
  stage: AgentModelContextApplyStage,
  error: string,
  previous: CodexModelContextConfig,
  attempted: CodexModelContextConfig,
  payload: AgentModelContextApplyPayload,
): AgentModelContextApplyResult {
  return {
    ok: false,
    error,
    stage,
    previousConfig: previous,
    attemptedConfig: attempted,
    requestVersion: payload.requestVersion,
    rollback: { ok: true, activeConfig: previous },
  }
}
```

Implement the compensating rollback once, without calling the public apply
method:

```ts
private async rollbackModelContext(input: {
  payload: AgentModelContextApplyPayload
  previous: CodexModelContextConfig
  attempted: CodexModelContextConfig
  originalError: unknown
  dbThreadId?: string
  codexThreadId?: string
}): Promise<AgentModelContextApplyResult> {
  const original = input.originalError instanceof ContextApplyError
    ? input.originalError
    : new ContextApplyError(
        'restart',
        input.originalError instanceof Error
          ? input.originalError.message
          : String(input.originalError),
      )
  try {
    this.runtimeSettings = { version: 1, confirmed: input.previous }
    await this.runtimeSettingsStore.replace(this.runtimeSettings)
    const before = this.backend.currentEpoch?.()
    if (!this.backend.restartCodex) {
      throw new Error('Codex backend does not support restart')
    }
    await this.backend.restartCodex(this.workspacePaths())
    const after = this.backend.currentEpoch?.()
    if (before !== undefined && after !== undefined && before === after) {
      throw new Error('Codex rollback restart did not advance epoch')
    }
    if (input.dbThreadId && input.codexThreadId) {
      await this.restoreCodexThreadStrict(input.dbThreadId, input.codexThreadId)
    }
    return {
      ok: false,
      error: original.message,
      stage: original.stage,
      previousConfig: input.previous,
      attemptedConfig: input.attempted,
      requestVersion: input.payload.requestVersion,
      rollback: { ok: true, activeConfig: input.previous },
    }
  } catch (rollbackError) {
    return {
      ok: false,
      error: original.message,
      stage: original.stage,
      previousConfig: input.previous,
      attemptedConfig: input.attempted,
      requestVersion: input.payload.requestVersion,
      rollback: {
        ok: false,
        error: rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError),
        effectiveConfig: null,
      },
    }
  }
}
```

- [ ] **Step 7: Run tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/AgentManager.modelContext.test.ts" "src/main/agent/__tests__/AgentManager.collaborationMode.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts"
```

Expected: all named suites PASS.

- [ ] **Step 8: Commit the Context transaction**

```powershell
git add "src/main/agent/AgentManager.ts" "src/main/agent/types.ts" "src/types/agent.ts" "src/main/agent/__tests__/AgentManager.modelContext.test.ts" "src/main/agent/__tests__/AgentManager.collaborationMode.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts"
git commit -m "feat(agent): apply context changes transactionally"
```

---

### Task 7: Model catalog, IPC/preload bridge, and renderer Context lifecycle

**Files:**
- Modify: `src/main/agent/codexProtocol.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Modify: `src/main/agent/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/types/agent.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Modify: `src/renderer/src/features/agent-chat/ModelPicker.tsx`
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Modify: `src/renderer/src/features/agent-chat/TokenUsageMeter.tsx`
- Create: `src/main/agent/__tests__/ipc.modelContext.test.ts`
- Create: `src/preload/__tests__/preload.modelContext.test.ts`
- Extend: `src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx`
- Modify: `src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx`

- [ ] **Step 1: Write failing IPC, preload, and store lifecycle tests**

IPC test:

```ts
await handler({}, {
  threadId: 'thread-1',
  model: 'gpt-5.6-sol',
  contextWindow: 1_000_000,
  requestVersion: 3,
})
expect(applyModelContextRpc).toHaveBeenCalledWith({
  threadId: 'thread-1',
  model: 'gpt-5.6-sol',
  contextWindow: 1_000_000,
  requestVersion: 3,
})
```

Reject negative, non-integer, `NaN`, unknown option, empty model, and malformed
requestVersion payloads.

Preload test:

```ts
await exposedApi.applyModelContext(payload)
expect(ipcRenderer.invoke).toHaveBeenCalledWith(
  'agent:model-context-apply',
  payload,
)
```

Renderer store tests:

```ts
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

it('commits context preference only after IPC success', async () => {
  const pending = deferred<AgentModelContextApplyResult>()
  applyModelContext.mockReturnValueOnce(pending.promise)
  const action = useAgentChatStore.getState()
    .setModelContextWindow('gpt-5.6-sol', 1_000_000)
  expect(useAgentChatStore.getState().modelContextWindowByModel).not.toMatchObject({
    'gpt-5.6-sol': 1_000_000,
  })
  pending.resolve({
    ok: true,
    data: {
      model: 'gpt-5.6-sol',
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      threadRestored: true,
      requestVersion: 1,
    },
  })
  await expect(action).resolves.toBe(true)
  expect(useAgentChatStore.getState().modelContextWindowByModel).toMatchObject({
    'gpt-5.6-sol': 1_000_000,
  })
})
```

Add stale request-version suppression and rollback-error display tests.

Model picker integration test:

```tsx
useAgentChatStore.setState({
  selectedModelId: 'gpt-5.6-sol',
  modelReasoningEffortByModel: { 'gpt-5.6-sol': 'max' },
  modelContextWindowByModel: { 'gpt-5.6-sol': 372_000 },
  activeModelContextWindow: 372_000,
  modelSettingsCatalog: runtimeCatalog,
} as never)
render(<ModelPicker />)
fireEvent.click(screen.getByRole('button', { name: /GPT-5.6 Sol/ }))
expect(screen.getAllByText('GPT-5.6 Sol')).toHaveLength(1)
expect(screen.getByRole('option', { name: /Max/ })).toBeTruthy()
expect(screen.queryByRole('option', { name: /Ultra/ })).toBeNull()
expect(screen.queryByText(/Fast/)).toBeNull()
```

Token fallback test:

```tsx
render(
  <TokenUsageMeter
    usage={{ inputTokens: 100_000, outputTokens: 0 }}
    fallbackContextWindow={372_000}
  />,
)
expect(screen.getByRole('button').textContent).toContain('24%')
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/ipc.modelContext.test.ts" "src/preload/__tests__/preload.modelContext.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx"
```

Expected: FAIL because channels, API methods, and store actions do not exist.

- [ ] **Step 3: Add a model settings catalog envelope**

Define:

```ts
export interface AgentModelSettingsEntry {
  id: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  capabilities: ModelSettingsCapabilities
}

export interface AgentModelSettingsCatalog {
  provider: string
  source: 'codex' | 'fallback'
  models: AgentModelSettingsEntry[]
}

export type AgentModelContextSnapshotResult =
  | { ok: true; data: CodexModelContextConfig }
  | { ok: false; error: string }
```

Extend `CodexModel` with 0.144.1 fields used for future-safe service gating:

```ts
export interface CodexModelServiceTier {
  id: string
  name: string
  description: string
}

additionalSpeedTiers: string[]
defaultServiceTier: string | null
serviceTiers: CodexModelServiceTier[]
```

In `AgentManager.getModelSettingsCatalogRpc()`, call `backend.listModels({
includeHidden: false })`, map each row through
`mergeModelSettingsCapabilities()`, and include `activeProviderId`. On RPC failure
return canonical fallback rows with `source: 'fallback'`.

Expose the confirmed main-process value without reading renderer storage:

```ts
getModelContextConfigRpc(): AgentModelContextSnapshotResult {
  return {
    ok: true,
    data: { ...this.runtimeSettings.confirmed },
  }
}
```

- [ ] **Step 4: Register validated IPC and preload methods**

Channels:

```ts
MODEL_SETTINGS_CATALOG: 'agent:model-settings-catalog',
MODEL_CONTEXT_GET: 'agent:model-context-get',
MODEL_CONTEXT_APPLY: 'agent:model-context-apply',
```

Preload methods:

```ts
getModelSettingsCatalog: () =>
  safeInvoke(IPC_CHANNELS.AGENT.MODEL_SETTINGS_CATALOG),

getModelContextConfig: () =>
  safeInvoke(IPC_CHANNELS.AGENT.MODEL_CONTEXT_GET),

applyModelContext: (payload: AgentModelContextApplyPayload) =>
  safeInvoke(IPC_CHANNELS.AGENT.MODEL_CONTEXT_APPLY, payload),
```

The main process computes the 90% compact limit. The renderer never submits it.

- [ ] **Step 5: Implement renderer catalog and Context actions**

Add state:

```ts
modelSettingsCatalog?: AgentModelSettingsCatalog
modelSettingsLoading: boolean
activeModelContextWindow: number
modelSettingsPending?: {
  model: string
  targetContextWindow: number
  requestVersion: number
}
modelSettingsError?: string
modelSettingsRequestSequence: number
```

Actions:

```ts
loadModelSettingsCatalog: async () => {
  set({ modelSettingsLoading: true, modelSettingsError: undefined })
  const [catalog, context] = await Promise.all([
    agent.getModelSettingsCatalog(),
    agent.getModelContextConfig(),
  ])
  set((state) => ({
    modelSettingsLoading: false,
    modelSettingsCatalog: catalog.ok
      ? catalog.data
      : state.modelSettingsCatalog,
    activeModelContextWindow: context.ok
      ? context.data.modelContextWindow
      : state.activeModelContextWindow,
    modelSettingsError: !catalog.ok
      ? catalog.error
      : !context.ok
        ? context.error
        : undefined,
  }))
}

setModelContextWindow: async (model, contextWindow) => {
  const requestVersion = get().modelSettingsRequestSequence + 1
  set({
    modelSettingsRequestSequence: requestVersion,
    modelSettingsPending: { model, targetContextWindow: contextWindow, requestVersion },
    modelSettingsError: undefined,
  })
  const result = await agent.applyModelContext({
    threadId: get().threadId,
    model,
    contextWindow,
    requestVersion,
  })
  if (get().modelSettingsRequestSequence !== requestVersion) return false
  if (!result.ok) {
    set({
      modelSettingsPending: undefined,
      modelSettingsError: formatContextApplyError(result),
      activeModelContextWindow: result.rollback.ok
        ? result.rollback.activeConfig.modelContextWindow
        : get().activeModelContextWindow,
    })
    return false
  }
  set((state) => {
    const next = {
      ...state.modelContextWindowByModel,
      [model]: result.data.contextWindow,
    }
    persistModelContextByModel(next)
    return {
      modelContextWindowByModel: next,
      activeModelContextWindow: result.data.contextWindow,
      modelSettingsPending: undefined,
      modelSettingsError: undefined,
    }
  })
  return true
}
```

Add the formatter used by the failure branch:

```ts
function formatContextApplyError(
  result: Extract<AgentModelContextApplyResult, { ok: false }>,
): string {
  return result.rollback.ok
    ? `${result.error}；已恢复原 Context`
    : `${result.error}；回滚失败：${result.rollback.error}。请手动重启 Agent Workspace`
}
```

`setSelectedModel` becomes async. If the target model's remembered/default
Context differs from `activeModelContextWindow`, await the Context action before
committing `selectedModelId`.

Call `loadModelSettingsCatalog()` once from the existing Agent chat bootstrap
effect. Use `Promise.all()` for independent catalog/context loading.

- [ ] **Step 6: Integrate the panel and model-aware token fallback**

Delete the old ModelPicker Plan-scope confirmation state and UI:

- `pendingOption`
- `needsPlanScope`
- `planEffortFor`
- `applyPendingOption`
- “仅 Plan / 所有模式” confirmation

Keep the existing search, groups, arrow keys, Home/End, Escape, outside pointer
handling, and focus restoration. Use runtime catalog rows when present and
canonical fallback rows otherwise. Mount the already-tested panel:

```tsx
<ModelSettingsPanel
  capabilities={selectedCapabilities}
  reasoningEffort={selectedReasoningEffort}
  contextWindow={selectedContextWindow}
  disabled={controlsDisabled}
  pending={modelSettingsPending !== undefined}
  error={modelSettingsError}
  onReasoningChange={(effort) =>
    setModelReasoningEffort(selectedModelId, effort)}
  onContextChange={(contextWindow) =>
    setModelContextWindow(selectedModelId, contextWindow).then(() => undefined)}
/>
```

The trigger summary is:

```ts
const REASONING_LABELS: Record<ModelReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

function reasoningLabel(effort: ModelReasoningEffort): string {
  return REASONING_LABELS[effort]
}

`${selected.label} · ${reasoningLabel(selectedReasoningEffort)}`
```

Change only the `TokenUsageMeter` signature and fallback selection; preserve its
existing percentage, toggle, and popover code unchanged:

```ts
export function TokenUsageMeter({
  usage,
  fallbackContextWindow,
}: {
  usage?: AgentTokenUsage
  fallbackContextWindow: number
}) {
  const window =
    typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
      ? usage.contextWindow
      : fallbackContextWindow
}
```

In `AgentChatPanel`, derive the current model's confirmed fallback and pass it
to `TokenUsageMeter`. Update every existing TokenUsageMeter test render with an
explicit fallback so the contract stays visible.

- [ ] **Step 7: Run tests and verify GREEN**

Run the command from Step 2, then:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/CodexProtocolClient.models.test.ts" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx" "src/renderer/src/features/agent-chat/__tests__/ModelSettingsPanel.test.tsx"
```

Expected: all named suites PASS.

- [ ] **Step 8: Commit the full bridge and UI integration**

```powershell
git add "src/main/agent/codexProtocol.ts" "src/main/agent/AgentManager.ts" "src/main/agent/ipc.ts" "src/preload/index.ts" "src/types/agent.ts" "src/renderer/src/features/agent-chat/store.ts" "src/renderer/src/features/agent-chat/ModelPicker.tsx" "src/renderer/src/features/agent-chat/AgentChatPanel.tsx" "src/renderer/src/features/agent-chat/TokenUsageMeter.tsx" "src/main/agent/__tests__/ipc.modelContext.test.ts" "src/preload/__tests__/preload.modelContext.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.planMode.test.tsx" "src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx" "src/main/agent/__tests__/CodexProtocolClient.models.test.ts"
git commit -m "feat(agent): connect model settings across IPC"
```

---

### Task 8: Smoke coverage, regressions, and final verification

**Files:**
- Modify: `scripts/smoke-codex-compaction.ts`
- Modify: `src/main/agent/__tests__/codexLaunch.test.ts`
- Modify: `docs/superpowers/specs/2026-07-12-codex-model-settings-alignment-design.md` only to mark implementation status after all evidence is collected.

- [ ] **Step 1: Update the compaction smoke to use the production Context path**

Remove provider `extraTopLevelConfig` overrides for Context. Construct the same
`CodexModelContextConfig` used by production:

```ts
const contextConfig = {
  modelContextWindow: Number(process.env.CODEX_SMOKE_CONTEXT_WINDOW ?? 372_000),
  modelAutoCompactTokenLimit: modelAutoCompactTokenLimit(
    Number(process.env.CODEX_SMOKE_CONTEXT_WINDOW ?? 372_000),
  ),
}
```

Pass it through the production launch option/getter. Add stable sentinel output:

```ts
console.log(`SMOKE_CONTEXT_CONFIG=${JSON.stringify(contextConfig)}`)
console.log('SMOKE_CONTEXT_OK')
```

- [ ] **Step 2: Run focused complete regression**

Run:

```powershell
pnpm exec vitest run "src/shared/__tests__/modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/models.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.collabMode.test.ts" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/features/agent-chat/__tests__/CollabModeControl.test.tsx" "src/renderer/src/features/agent-chat/__tests__/TokenUsageMeter.test.tsx" "src/main/agent/__tests__/CodexRuntimeSettingsStore.test.ts" "src/main/agent/__tests__/AgentManager.modelContext.test.ts" "src/main/agent/__tests__/AgentManager.collaborationMode.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts" "src/main/agent/__tests__/codexLaunch.test.ts" "src/main/agent/__tests__/ipc.modelContext.test.ts" "src/preload/__tests__/preload.modelContext.test.ts"
```

Expected: exit 0, zero failing tests.

- [ ] **Step 3: Run subsystem regressions**

Run:

```powershell
pnpm exec vitest run "src/main/agent"
pnpm exec vitest run "src/renderer/src/features/agent-chat"
pnpm exec vitest run "src/preload"
```

Expected: record exact pass/fail counts. If known baseline failures reproduce,
verify them against the base branch before classifying them as pre-existing.

- [ ] **Step 4: Run static verification**

Run:

```powershell
pnpm run typecheck
pnpm run build:vite
```

Expected:

- `build:vite` exits 0.
- `typecheck` exits 0, or every failure is reproduced on the untouched base and
  documented with file/line evidence.

- [ ] **Step 5: Run local Codex smoke checks**

Run:

```powershell
pnpm run codex:smoke:resume
pnpm run codex:smoke:compaction
```

Expected:

- resume smoke confirms the same Codex thread is restored after restart;
- compaction smoke prints `SMOKE_CONTEXT_OK`;
- no secret is printed.

Do not send a near-1M request. The smoke verifies launch/config/resume semantics,
not Provider capacity.

- [ ] **Step 6: Inspect final diff and request code review**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Then invoke the repository code-review workflow against the approved design.
Resolve all blocking findings and rerun Steps 2–5.

- [ ] **Step 7: Mark the spec implemented and commit verification changes**

Only after fresh evidence, change the spec status to:

```text
状态：已实现并验证
```

Commit:

```powershell
git add "scripts/smoke-codex-compaction.ts" "docs/superpowers/specs/2026-07-12-codex-model-settings-alignment-design.md"
git commit -m "test(agent): verify model settings alignment"
```

---

## Completion checklist

- [ ] One canonical row per model; legacy picker ids migrate without loss.
- [ ] Ordinary Auto omits `turn/start.effort`.
- [ ] Ordinary and Plan effort are independently persisted.
- [ ] GPT-5.6 Sol exposes Max; GPT-5.5 does not.
- [ ] Ultra and Fast are absent for the current API Key provider.
- [ ] GPT-5.6 official fallback is 372K.
- [ ] Every model offers a clearly marked experimental 1M override.
- [ ] 1M launches with a 900K compact limit, not 220K.
- [ ] Context changes serialize, restart, strictly resume, verify epoch, and confirm only after success.
- [ ] Failures roll back once; rollback failures surface both errors.
- [ ] Server-reported context remains authoritative over UI fallback.
- [ ] Focused tests, subsystem regressions, typecheck, build, and smoke checks have fresh evidence.
- [ ] Existing Electron E2E baseline failures are reported separately and not misclassified.
