# Unified Provider Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user-visible Grok Provider cards with Gateway-scoped credentials and model-driven internal Channel routing, while preserving provider-specific context, compatibility, rollback, and custom Provider behavior.

**Architecture:** Introduce pure Gateway/Channel routing and catalog modules, a Channel controller, and one model-selection coordinator. `AgentManager` delegates route switching and rollback to those focused units; the renderer extracts model routing state from its oversized chat store into a dedicated Zustand slice. The settings page manages Gateways, while ModelPicker selects models and receives authoritative selection snapshots from the main process.

**Tech Stack:** Electron, TypeScript, React 19, Zustand, Vitest, Codex app-server Responses API.

## Global Constraints

- Keep API Yi at 500K and Right.Codes at 1M for Grok 4.5.
- Keep Low, Medium, and High reasoning for Grok 4.5.
- Preserve one credential slot per Gateway.
- Preserve custom Provider CRUD and single-Channel behavior.
- Preserve namespace/function translation, `web_search` field normalization, and streamed UTF-8 safety.
- Route Right.Codes Grok 4.5 through `https://right.codes/grok/v1`.
- Treat 429, timeout, and network failures as transient; do not mark models unauthorized.
- Use no new runtime dependencies.
- Keep imports at module scope.
- Use exhaustive `never` checks for TypeScript discriminated unions.
- Add concise JSDoc to public classes and methods; keep comments below 20%.
- Do not add model routing logic to `CodexLocalBackend`.
- Perform targeted extraction from `AgentManager.ts` and `agent-chat/store.ts`; do not broaden this work into a full-file rewrite.
- Never commit `.superpowers/` visual-companion files or API keys.

## File Structure

### New main-process units

- `src/main/agent/gatewayModelRouting.ts`
  - Owns Gateway, Channel, model-family, and model-to-Channel relationships.
- `src/main/agent/gatewayModelCatalog.ts`
  - Builds one deduplicated Gateway-scoped model catalog.
- `src/main/agent/ProviderChannelController.ts`
  - Applies a resolved Channel to the backend and skips same-Channel restarts.
- `src/main/agent/AgentModelSelectionCoordinator.ts`
  - Owns latest-wins model selection, context application, persistence, thread restoration, and rollback.

### New renderer unit

- `src/renderer/src/features/agent-chat/modelRoutingSlice.ts`
  - Owns model routing state, selection actions, catalog loading, retry, and persistence warnings.

### New tests

- `src/main/agent/__tests__/gatewayModelRouting.test.ts`
- `src/main/agent/__tests__/gatewayModelCatalog.test.ts`
- `src/main/agent/__tests__/ProviderChannelController.test.ts`
- `src/main/agent/__tests__/AgentModelSelectionCoordinator.test.ts`
- `src/main/agent/__tests__/AgentManager.modelSelection.test.ts`
- `src/main/agent/__tests__/ipc.modelSelection.test.ts`
- `src/preload/__tests__/preload.modelSelection.test.ts`
- `src/renderer/src/features/agent-chat/__tests__/store.modelRouting.test.ts`
- `scripts/smoke-provider-model-routing.ts`

---

### Task 1: Gateway, Channel, and model-route contracts

**Files:**
- Create: `src/main/agent/gatewayModelRouting.ts`
- Create: `src/main/agent/__tests__/gatewayModelRouting.test.ts`
- Modify: `src/main/agent/codexProviders.ts:9-244`
- Modify: `src/main/agent/codexLaunch.ts:1-80`
- Modify: `src/shared/modelSettings.ts:1-359`
- Modify: `src/shared/__tests__/modelSettings.test.ts`
- Modify: `src/types/agent.ts:162-184`
- Modify: `src/main/agent/__tests__/codexProviders.test.ts`

**Interfaces:**
- Produces: `GatewayPreset`, `ProviderChannelPreset`, `AgentModelRoute`, `AgentModelFamily`.
- Produces: `resolveGatewayModelRoute()`, `resolveProviderChannel()`, `channelsForGateway()`.
- Consumed by: Tasks 2–9.

- [ ] **Step 1: Write the failing route and capability tests**

```ts
import { describe, expect, it } from 'vitest'

import {
  channelsForGateway,
  resolveGatewayModelRoute,
  resolveProviderChannel,
} from '../gatewayModelRouting'

describe('gatewayModelRouting', () => {
  it('resolves API Yi GPT models to apiyi-standard', () => {
    expect(resolveGatewayModelRoute('apiyi', 'gpt-5.5')).toEqual({
      gatewayId: 'apiyi',
      channelId: 'apiyi-standard',
      modelId: 'gpt-5.5',
      family: 'openai',
    })
  })

  it('resolves API Yi Grok 4.5 to apiyi-grok', () => {
    expect(resolveGatewayModelRoute('apiyi', 'grok-4.5')).toEqual({
      gatewayId: 'apiyi',
      channelId: 'apiyi-grok',
      modelId: 'grok-4.5',
      family: 'xai',
    })
  })

  it('resolves Right.Codes Grok 4.5 to rightcode-grok', () => {
    const route = resolveGatewayModelRoute('rightcode', 'grok-4.5')
    const channel = resolveProviderChannel(route.channelId)

    expect(route.channelId).toBe('rightcode-grok')
    expect(channel.baseUrl).toBe('https://right.codes/grok/v1')
  })

  it('keeps builtin gateway cards separate from internal channels', () => {
    expect(channelsForGateway('apiyi').map((channel) => channel.id)).toEqual([
      'apiyi-standard',
      'apiyi-grok',
    ])
  })
})
```

Add assertions to `modelSettings.test.ts`:

```ts
expect(modelContextOptions('grok-4.5', 'apiyi', 'apiyi-grok')).toContainEqual({
  value: 500_000,
  label: '500K',
})
expect(modelContextOptions('grok-4.5', 'rightcode', 'rightcode-grok')).toContainEqual({
  value: 1_000_000,
  label: '1M',
})
```

- [ ] **Step 2: Run the tests and verify the new API fails**

Run:

```powershell
pnpm exec vitest run "src/main/agent/__tests__/gatewayModelRouting.test.ts" "src/main/agent/__tests__/codexProviders.test.ts" "src/shared/__tests__/modelSettings.test.ts"
```

Expected: FAIL because `gatewayModelRouting.ts` and the three-argument context policy do not exist.

- [ ] **Step 3: Add shared route and catalog types**

Add to `src/types/agent.ts`:

```ts
export type AgentModelFamily = 'openai' | 'xai' | 'other'

export interface AgentModelRoute {
  gatewayId: string
  channelId: string
  modelId: string
  family: AgentModelFamily
}

export type AgentModelAvailability =
  | { status: 'available' }
  | { status: 'needs-key'; reason: string }
  | { status: 'unauthorized'; reason: string }

export interface AgentGatewayRecord {
  id: string
  name: string
  description?: string
  credentialId: string
  defaultChannelId: string
  channelIds: string[]
  isCustom?: boolean
}
```

Extend `AgentModelSettingsEntry` and replace the Provider-scoped catalog fields:

```ts
export interface AgentModelSettingsEntry {
  id: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  family: AgentModelFamily
  route: AgentModelRoute
  availability: AgentModelAvailability
  capabilities: ModelSettingsCapabilities
}

export interface AgentModelSettingsCatalog {
  gatewayId: string
  revision: string
  source: 'codex' | 'mixed' | 'fallback'
  models: AgentModelSettingsEntry[]
}
```

- [ ] **Step 4: Implement the pure routing boundary**

Create `gatewayModelRouting.ts` with module-scope imports and these exports:

```ts
import type {
  AgentGatewayRecord,
  AgentModelFamily,
  AgentModelRoute,
} from '../../types/agent'
import type {
  CodexProviderConfig,
  ProviderCompatibilityPolicy,
} from './codexLaunch'
import type { ProviderPreset } from './codexProviders'

export interface GatewayPreset extends AgentGatewayRecord {
  channelIds: string[]
}

export interface ProviderChannelPreset extends CodexProviderConfig {
  id: string
  gatewayId: string
  allowedModels?: readonly string[]
  compatibilityPolicy: ProviderCompatibilityPolicy
}

const BUILTIN_GATEWAYS: readonly GatewayPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi',
    name: 'API Yi',
    description: 'API易 Responses 网关',
    credentialId: 'apiyi',
    defaultChannelId: 'apiyi-standard',
    channelIds: ['apiyi-standard', 'apiyi-grok'],
  }),
  Object.freeze({
    id: 'rightcode',
    name: 'Right.Codes',
    description: 'Right.Codes Codex 与 Grok 网关',
    credentialId: 'rightcode',
    defaultChannelId: 'rightcode-standard',
    channelIds: ['rightcode-standard', 'rightcode-grok'],
  }),
])

const BUILTIN_CHANNELS: readonly ProviderChannelPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi-standard',
    gatewayId: 'apiyi',
    name: 'API Yi',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    compatibilityPolicy: 'none',
  }),
  Object.freeze({
    id: 'apiyi-grok',
    gatewayId: 'apiyi',
    name: 'API Yi Grok',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-standard',
    gatewayId: 'rightcode',
    name: 'Right.Codes',
    baseUrl: 'https://right.codes/codex/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
  }),
  Object.freeze({
    id: 'rightcode-grok',
    gatewayId: 'rightcode',
    name: 'Right.Codes Grok',
    baseUrl: 'https://right.codes/grok/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
  }),
])

export function inferModelFamily(modelId: string): AgentModelFamily {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.startsWith('grok')) return 'xai'
  if (normalized.startsWith('gpt-') || /^o\d/.test(normalized)) return 'openai'
  return 'other'
}

export function builtinGateways(): readonly GatewayPreset[] {
  return BUILTIN_GATEWAYS
}

export function channelsForGateway(
  gatewayId: string,
): readonly ProviderChannelPreset[] {
  return BUILTIN_CHANNELS.filter((channel) => channel.gatewayId === gatewayId)
}

export function resolveProviderChannel(
  channelId: string,
  customProviders: readonly ProviderPreset[] = [],
): ProviderChannelPreset {
  const builtin = BUILTIN_CHANNELS.find((channel) => channel.id === channelId)
  if (builtin) return builtin

  const customId = channelId.startsWith('custom:')
    ? channelId.slice('custom:'.length)
    : channelId
  const custom = customProviders.find((provider) => provider.id === customId)
  if (!custom) throw new Error(`Unknown provider channel "${channelId}"`)

  return {
    ...custom,
    id: `custom:${custom.id}`,
    gatewayId: custom.id,
    compatibilityPolicy: 'none',
  }
}

export function resolveGatewayModelRoute(
  gatewayId: string,
  modelId: string,
  customProviders: readonly ProviderPreset[] = [],
): AgentModelRoute {
  const normalizedModel = modelId.trim()
  const family = inferModelFamily(normalizedModel)
  const builtin = BUILTIN_GATEWAYS.find((gateway) => gateway.id === gatewayId)

  if (!builtin) {
    const custom = customProviders.find((provider) => provider.id === gatewayId)
    if (!custom) throw new Error(`Unknown Codex gateway "${gatewayId}"`)
    return {
      gatewayId,
      channelId: `custom:${gatewayId}`,
      modelId: normalizedModel,
      family,
    }
  }

  const channelId = family === 'xai'
    ? `${gatewayId}-grok`
    : `${gatewayId}-standard`
  const channel = resolveProviderChannel(channelId, customProviders)
  if (
    channel.allowedModels
    && !channel.allowedModels.includes(normalizedModel)
  ) {
    throw new Error(
      `Model "${normalizedModel}" is unavailable in gateway "${gatewayId}"`,
    )
  }

  return { gatewayId, channelId, modelId: normalizedModel, family }
}
```

Before declaring Channel presets, add the policy to `codexLaunch.ts`:

```ts
export type ProviderCompatibilityPolicy =
  | 'none'
  | 'responses-namespace-bridge'

export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
  model?: string
  requiresOpenaiAuth?: boolean
  extraTopLevelConfig?: Readonly<Record<string, CodexConfigValue>>
  compatibilityPolicy?: ProviderCompatibilityPolicy
}
```

Export the two Gateway presets and four Channel presets from `codexProviders.ts`.
Keep `ProviderPreset` for custom Provider compatibility, but stop exposing Grok
Channel presets through the user-facing builtin list.

- [ ] **Step 5: Move capability policy keys to Gateway + Channel + model**

Change the context/reasoning lookup signatures in `modelSettings.ts`:

```ts
export function modelContextOptions(
  modelId: string,
  gatewayId: string,
  channelId: string,
): ModelContextOption[]

export function supportedReasoningEfforts(
  modelId: string,
  gatewayId: string,
  channelId: string,
): ConcreteModelReasoningEffort[]

export function mergeModelSettingsCapabilities(input: {
  model: string
  gatewayId: string
  channelId: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: readonly string[]
}): ModelSettingsCapabilities
```

Use keys in the form:

```ts
const PROVIDER_CONTEXT_POLICIES = new Map<string, ModelContextPolicy>([
  ['apiyi:apiyi-grok:grok-4.5', {
    defaultWindow: 500_000,
    allowExperimental1M: false,
  }],
  ['rightcode:rightcode-grok:grok-4.5', {
    defaultWindow: 1_000_000,
    allowExperimental1M: false,
  }],
])

const PROVIDER_REASONING_POLICIES =
  new Map<string, ProviderReasoningPolicy>([
    ['apiyi:apiyi-grok:grok-4.5', {
      defaultEffort: 'high',
      supportedEfforts: ['low', 'medium', 'high'],
    }],
    ['rightcode:rightcode-grok:grok-4.5', {
      defaultEffort: 'high',
      supportedEfforts: ['low', 'medium', 'high'],
    }],
])
```

- [ ] **Step 6: Run Task 1 tests and commit**

Run the Task 1 command again. Expected: all selected suites pass.

```powershell
git add src/main/agent/gatewayModelRouting.ts src/main/agent/__tests__/gatewayModelRouting.test.ts src/main/agent/codexProviders.ts src/main/agent/__tests__/codexProviders.test.ts src/main/agent/codexLaunch.ts src/shared/modelSettings.ts src/shared/__tests__/modelSettings.test.ts src/types/agent.ts
git commit -m "refactor(agent): separate gateways from provider channels"
```

---

### Task 2: Provider persistence and thread-model migration

**Files:**
- Modify: `src/main/agent/CodexProviderStore.ts:20-357`
- Modify: `src/main/agent/ThreadStore.ts`
- Modify: `src/main/agent/__tests__/CodexProviderStore.test.ts`
- Modify: `src/main/agent/__tests__/ThreadStore.test.ts`

**Interfaces:**
- Consumes: `GatewayPreset` and routing functions from Task 1.
- Produces: `PersistedProvidersV2`, `getSelectedGatewayId()`, `setSelectedGatewayId()`, `setSelectedModelId()`.
- Produces: `ThreadStore.setThreadModel(threadId, model)`.

- [ ] **Step 1: Write failing V1 migration tests**

```ts
it('migrates rightcode-grok to gateway plus Grok selection', async () => {
  await writePersistedProviders({
    version: 1,
    selectedProviderId: 'rightcode-grok',
    apiKeys: { rightcode: 'shared-key' },
    customProviders: [],
  })

  const state = await store.load()

  expect(state).toMatchObject({
    version: 2,
    selectedGatewayId: 'rightcode',
    selectedModelId: 'grok-4.5',
    apiKeys: { rightcode: 'shared-key' },
  })
})

it('never persists builtin channel ids as selected gateways', async () => {
  await store.setSelectedGatewayId('apiyi-grok')
  const state = await store.load()

  expect(state.selectedGatewayId).toBe('apiyi')
  expect(state.selectedModelId).toBe('grok-4.5')
})
```

Add to `ThreadStore.test.ts`:

```ts
it('updates the persisted thread model after confirmed selection', async () => {
  const thread = await store.createThread({ title: 'Route test', model: 'gpt-5.5' })
  await store.setThreadModel(thread.id, 'grok-4.5')

  expect((await store.getThread(thread.id))?.model).toBe('grok-4.5')
})
```

- [ ] **Step 2: Run migration tests and verify failure**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/CodexProviderStore.test.ts" "src/main/agent/__tests__/ThreadStore.test.ts"
```

Expected: FAIL because V2 fields and `setThreadModel()` do not exist.

- [ ] **Step 3: Implement V2 state and pure migration**

```ts
export interface PersistedProvidersV2 {
  version: 2
  selectedGatewayId: string
  selectedModelId: string
  apiKeys: Record<string, string>
  customProviders: ProviderPreset[]
}

export type PersistedProviders =
  | PersistedProvidersV1
  | PersistedProvidersV2

function migrateBuiltinSelection(
  selectedProviderId: string,
): Pick<PersistedProvidersV2, 'selectedGatewayId' | 'selectedModelId'> {
  switch (selectedProviderId) {
    case 'apiyi-grok':
      return { selectedGatewayId: 'apiyi', selectedModelId: 'grok-4.5' }
    case 'rightcode-grok':
      return { selectedGatewayId: 'rightcode', selectedModelId: 'grok-4.5' }
    case RETIRED_RIGHTCODE_PRO_ID:
      return { selectedGatewayId: 'rightcode', selectedModelId: 'gpt-5.5' }
    default:
      return {
        selectedGatewayId: selectedProviderId || DEFAULT_PROVIDER_ID,
        selectedModelId: 'gpt-5.5',
      }
  }
}

export function migratePersistedProviders(
  input: PersistedProviders,
): PersistedProvidersV2 {
  if (input.version === 2) return input
  const selection = migrateBuiltinSelection(input.selectedProviderId)
  return {
    version: 2,
    ...selection,
    apiKeys: { ...input.apiKeys },
    customProviders: [...input.customProviders],
  }
}
```

Keep `getSelectedId()` and `setSelectedId()` as compatibility aliases that call
the Gateway methods until Task 8 removes renderer use of Provider terminology.

- [ ] **Step 4: Add thread model persistence**

Add a public method to `ThreadStore` using the same database execution helper as
the existing title and metadata updates:

```ts
/** Stores the confirmed model for an existing Agent thread. */
async setThreadModel(threadId: string, model: string): Promise<void> {
  await this.prisma.agentThread.update({
    where: { id: threadId },
    data: { model },
  })
}
```

- [ ] **Step 5: Run tests and commit**

Expected: selected persistence suites pass and no Prisma schema change is
generated.

```powershell
git add src/main/agent/CodexProviderStore.ts src/main/agent/ThreadStore.ts src/main/agent/__tests__/CodexProviderStore.test.ts src/main/agent/__tests__/ThreadStore.test.ts
git commit -m "refactor(agent): migrate provider state to gateways"
```

---

### Task 3: Channel runtime controller and compatibility policy

**Files:**
- Create: `src/main/agent/ProviderChannelController.ts`
- Create: `src/main/agent/__tests__/ProviderChannelController.test.ts`
- Modify: `src/main/agent/codexLaunch.ts:1-584`
- Modify: `src/main/agent/CodexLocalBackend.ts:1-884`
- Modify: `src/main/agent/responsesCompatibilityProxy.ts:1-418`
- Modify: `src/main/agent/__tests__/CodexLocalBackend.test.ts`
- Modify: `src/main/agent/__tests__/codexLaunch.test.ts`
- Modify: `src/main/agent/__tests__/responsesCompatibilityProxy.test.ts`

**Interfaces:**
- Consumes: `ProviderChannelPreset` and `resolveProviderChannel()`.
- Produces: `ProviderChannelController.apply()` and `ProviderChannelController.restore()`.
- Keeps: `CodexLocalBackend` generic and model-agnostic.

- [ ] **Step 1: Write failing controller tests**

```ts
import { vi } from 'vitest'
import type { CodexWorkspacePaths } from '../../../types/agent'
import {
  ProviderChannelController,
  type ProviderChannelBackend,
} from '../ProviderChannelController'

const paths: CodexWorkspacePaths = {
  personalConfigToml: 'personal-config.toml',
  personalSkillsRoot: 'personal-skills',
  workspaceConfigToml: 'workspace-config.toml',
  workspaceSkillsRoot: 'workspace-skills',
  runtimeConfigToml: 'runtime-config.toml',
  auditLogPath: 'audit.log',
}

function createBackend(): ProviderChannelBackend {
  return {
    setProvider: vi.fn(),
    restartCodex: vi.fn(async () => undefined),
    currentEpoch: vi.fn(() => 2),
  }
}

function createController(
  backend: ProviderChannelBackend,
  initialChannelId: string,
): ProviderChannelController {
  return new ProviderChannelController({
    backend,
    paths,
    initialChannelId,
    getCustomProviders: () => [],
  })
}

it('does not restart when the target channel is already active', async () => {
  const backend = createBackend()
  const controller = createController(backend, 'apiyi-standard')

  const result = await controller.apply('apiyi-standard')

  expect(result.changed).toBe(false)
  expect(backend.restartCodex).not.toHaveBeenCalled()
})

it('switches Right.Codes Grok through the Grok endpoint', async () => {
  const backend = createBackend()
  const controller = createController(backend, 'rightcode-standard')

  const result = await controller.apply('rightcode-grok')

  expect(result.changed).toBe(true)
  expect(backend.setProvider).toHaveBeenCalledWith(
    expect.objectContaining({ baseUrl: 'https://right.codes/grok/v1' }),
  )
  expect(backend.restartCodex).toHaveBeenCalledTimes(1)
})

it('restores the previous provider when a channel restart fails', async () => {
  const backend = createBackend()
  vi.mocked(backend.restartCodex!)
    .mockRejectedValueOnce(new Error('spawn failed'))
    .mockResolvedValueOnce(undefined)
  const controller = createController(backend, 'rightcode-standard')

  await expect(controller.apply('rightcode-grok')).rejects.toThrow(
    'spawn failed',
  )

  expect(backend.setProvider).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: 'rightcode-standard',
      baseUrl: 'https://right.codes/codex/v1',
    }),
  )
  expect(controller.currentChannelId()).toBe('rightcode-standard')
})
```

Add a compatibility test:

```ts
expect(
  shouldStartResponsesCompatibilityProxy(
    resolveProviderChannel('apiyi-grok'),
  ),
).toBe(true)
```

- [ ] **Step 2: Run controller and protocol tests**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/ProviderChannelController.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts" "src/main/agent/__tests__/codexLaunch.test.ts" "src/main/agent/__tests__/responsesCompatibilityProxy.test.ts"
```

Expected: FAIL because the controller and Channel compatibility policy are not
connected.

- [ ] **Step 3: Connect Channel compatibility to the proxy boundary**

Make the compatibility-proxy decision exhaustive:

```ts
export function shouldStartResponsesCompatibilityProxy(
  provider: CodexProviderConfig | undefined,
): boolean {
  switch (provider?.compatibilityPolicy ?? 'none') {
    case 'none':
      return false
    case 'responses-namespace-bridge':
      return true
    default: {
      const exhaustive: never = provider?.compatibilityPolicy as never
      throw new Error(`Unsupported compatibility policy: ${String(exhaustive)}`)
    }
  }
}
```

- [ ] **Step 4: Implement `ProviderChannelController`**

```ts
import type { CodexWorkspacePaths } from '../../types/agent'
import type { CodexProviderConfig } from './codexLaunch'
import type { ProviderPreset } from './codexProviders'
import { resolveProviderChannel } from './gatewayModelRouting'

export interface ProviderChannelTransition {
  changed: boolean
  previousChannelId: string
  channelId: string
  backendEpoch?: number
}

export interface ProviderChannelBackend {
  setProvider?: (provider: CodexProviderConfig | undefined) => void
  restartCodex?: (paths: CodexWorkspacePaths) => Promise<void>
  currentEpoch?: () => number
}

export interface ProviderChannelControllerOptions {
  backend: ProviderChannelBackend
  paths: CodexWorkspacePaths
  initialChannelId: string
  getCustomProviders: () => readonly ProviderPreset[]
}

/** Applies internal Provider Channels to the Codex backend. */
export class ProviderChannelController {
  private activeChannelId: string

  constructor(private readonly options: ProviderChannelControllerOptions) {
    this.activeChannelId = options.initialChannelId
  }

  currentChannelId(): string {
    return this.activeChannelId
  }

  async apply(channelId: string): Promise<ProviderChannelTransition> {
    const previousChannelId = this.activeChannelId
    if (channelId === previousChannelId) {
      return {
        changed: false,
        previousChannelId,
        channelId,
        backendEpoch: this.options.backend.currentEpoch?.(),
      }
    }

    const provider = resolveProviderChannel(
      channelId,
      this.options.getCustomProviders(),
    )
    try {
      this.options.backend.setProvider?.(provider)
      await this.options.backend.restartCodex?.(this.options.paths)
      this.activeChannelId = channelId
    } catch (error) {
      const previousProvider = resolveProviderChannel(
        previousChannelId,
        this.options.getCustomProviders(),
      )
      this.options.backend.setProvider?.(previousProvider)
      await this.options.backend.restartCodex?.(this.options.paths)
      throw error
    }
    return {
      changed: true,
      previousChannelId,
      channelId,
      backendEpoch: this.options.backend.currentEpoch?.(),
    }
  }

  async restore(channelId: string): Promise<void> {
    if (channelId === this.activeChannelId) return
    const provider = resolveProviderChannel(
      channelId,
      this.options.getCustomProviders(),
    )
    this.options.backend.setProvider?.(provider)
    await this.options.backend.restartCodex?.(this.options.paths)
    this.activeChannelId = channelId
  }
}
```

- [ ] **Step 5: Route proxy startup from Channel policy**

Update `CodexLocalBackend.startSpawnedClient()` to call
`shouldStartResponsesCompatibilityProxy(this.provider)` without checking model
IDs, Gateway IDs, or base URLs. Keep all imports at module scope.

- [ ] **Step 6: Run tests and commit**

```powershell
git add src/main/agent/ProviderChannelController.ts src/main/agent/__tests__/ProviderChannelController.test.ts src/main/agent/codexLaunch.ts src/main/agent/CodexLocalBackend.ts src/main/agent/responsesCompatibilityProxy.ts src/main/agent/__tests__/CodexLocalBackend.test.ts src/main/agent/__tests__/codexLaunch.test.ts src/main/agent/__tests__/responsesCompatibilityProxy.test.ts
git commit -m "refactor(agent): isolate provider channel switching"
```

---

### Task 4: Gateway-scoped model catalog

**Files:**
- Create: `src/main/agent/gatewayModelCatalog.ts`
- Create: `src/main/agent/__tests__/gatewayModelCatalog.test.ts`
- Modify: `src/main/agent/AgentManager.ts:1158-1242`
- Modify: `src/main/agent/__tests__/AgentManager.modelSettingsCatalog.test.ts`

**Interfaces:**
- Consumes: route and capability functions from Task 1.
- Produces: `buildGatewayModelCatalog()` and `modelCatalogRevision()`.
- Produces: one `AgentModelSettingsCatalog` for the active Gateway.

- [ ] **Step 1: Write failing aggregation tests**

```ts
import { mergeModelSettingsCapabilities } from '../../../shared/modelSettings'
import { buildGatewayModelCatalog } from '../gatewayModelCatalog'

function dynamicModel(
  id: string,
  gatewayId = 'rightcode',
  channelId = 'rightcode-standard',
) {
  return {
    id,
    displayName: id,
    description: 'Dynamic model',
    hidden: false,
    isDefault: id === 'gpt-5.5',
    capabilities: mergeModelSettingsCapabilities({
      model: id,
      gatewayId,
      channelId,
      supportedReasoningEfforts: [],
    }),
  }
}

it('aggregates standard and Grok models for Right.Codes', () => {
  const catalog = buildGatewayModelCatalog({
    gatewayId: 'rightcode',
    dynamicSource: 'codex',
    dynamicModels: [dynamicModel('gpt-5.5')],
    hasCredential: true,
    availabilityByModel: new Map(),
  })

  expect(catalog.models.map((model) => model.id)).toEqual([
    'gpt-5.5',
    'grok-4.5',
  ])
  expect(catalog.models.find((model) => model.id === 'grok-4.5')?.route)
    .toMatchObject({ channelId: 'rightcode-grok', family: 'xai' })
})

it('keeps deterministic unauthorized Grok visible', () => {
  const catalog = buildGatewayModelCatalog({
    gatewayId: 'apiyi',
    dynamicSource: 'codex',
    dynamicModels: [dynamicModel('gpt-5.5', 'apiyi', 'apiyi-standard')],
    hasCredential: true,
    availabilityByModel: new Map([
      ['grok-4.5', { status: 'unauthorized', reason: '当前 Key 未开通' }],
    ]),
  })

  expect(catalog.models.find((model) => model.id === 'grok-4.5')?.availability)
    .toEqual({ status: 'unauthorized', reason: '当前 Key 未开通' })
})
```

- [ ] **Step 2: Run catalog tests and verify failure**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/gatewayModelCatalog.test.ts" "src/main/agent/__tests__/AgentManager.modelSettingsCatalog.test.ts"
```

Expected: FAIL because Gateway aggregation does not exist.

- [ ] **Step 3: Implement the catalog builder**

```ts
import { createHash } from 'node:crypto'

import type {
  AgentModelAvailability,
  AgentModelSettingsCatalog,
  AgentModelSettingsEntry,
} from '../../types/agent'
import {
  channelsForGateway,
  resolveGatewayModelRoute,
} from './gatewayModelRouting'
import {
  mergeModelSettingsCapabilities,
} from '../../shared/modelSettings'

export interface GatewayModelCatalogInput {
  gatewayId: string
  dynamicSource: 'codex' | 'fallback'
  dynamicModels: readonly Omit<
    AgentModelSettingsEntry,
    'family' | 'route' | 'availability'
  >[]
  hasCredential: boolean
  availabilityByModel: ReadonlyMap<string, AgentModelAvailability>
}

export function modelCatalogRevision(
  gatewayId: string,
  models: readonly AgentModelSettingsEntry[],
): string {
  const stableModels = [...models].sort((left, right) =>
    left.id.localeCompare(right.id))
  return createHash('sha256')
    .update(JSON.stringify({
      gatewayId,
      models: stableModels.map((model) => ({
        id: model.id,
        route: model.route,
        availability: model.availability,
        capabilities: model.capabilities,
      })),
    }))
    .digest('hex')
    .slice(0, 16)
}

export function buildGatewayModelCatalog(
  input: GatewayModelCatalogInput,
): AgentModelSettingsCatalog {
  const byId = new Map<string, AgentModelSettingsEntry>()
  const declaredModels = channelsForGateway(input.gatewayId)
    .flatMap((channel) => [...(channel.allowedModels ?? [])])

  for (const row of input.dynamicModels) {
    const route = resolveGatewayModelRoute(input.gatewayId, row.id)
    byId.set(row.id, {
      ...row,
      family: route.family,
      route,
      availability: input.hasCredential
        ? input.availabilityByModel.get(row.id) ?? { status: 'available' }
        : { status: 'needs-key', reason: '请先配置网关 Key' },
      capabilities: mergeModelSettingsCapabilities({
        model: row.id,
        gatewayId: input.gatewayId,
        channelId: route.channelId,
        defaultReasoningEffort:
          row.capabilities.defaultReasoningEffort,
        supportedReasoningEfforts:
          row.capabilities.supportedReasoningEfforts,
      }),
    })
  }

  for (const modelId of declaredModels) {
    if (byId.has(modelId)) continue
    const route = resolveGatewayModelRoute(input.gatewayId, modelId)
    byId.set(modelId, {
      id: modelId,
      displayName: modelId === 'grok-4.5' ? 'Grok 4.5' : modelId,
      description: 'Responses model',
      hidden: false,
      isDefault: false,
      family: route.family,
      route,
      availability: input.hasCredential
        ? input.availabilityByModel.get(modelId) ?? { status: 'available' }
        : { status: 'needs-key', reason: '请先配置网关 Key' },
      capabilities: mergeModelSettingsCapabilities({
        model: modelId,
        gatewayId: input.gatewayId,
        channelId: route.channelId,
        supportedReasoningEfforts: [],
      }),
    })
  }

  const models = [...byId.values()]
  return {
    gatewayId: input.gatewayId,
    revision: modelCatalogRevision(input.gatewayId, models),
    source: input.dynamicSource === 'fallback'
      ? 'fallback'
      : declaredModels.length > 0
        ? 'mixed'
        : 'codex',
    models,
  }
}
```

- [ ] **Step 4: Delegate AgentManager catalog assembly**

Replace inline model-row mapping in `getModelSettingsCatalogRpc()` with:

```ts
const catalog = buildGatewayModelCatalog({
  gatewayId: this.activeGatewayId,
  dynamicSource,
  dynamicModels,
  hasCredential: Boolean(this.codexApiKey),
  availabilityByModel: this.modelAvailabilityByGateway.get(
    this.activeGatewayId,
  ) ?? new Map(),
})
return { ok: true, data: catalog }
```

Retain the existing capability barrier and backend epoch checks. If the
ownership check fails, retry the existing bounded loop; do not restart the
backend to read another Channel's directory.

- [ ] **Step 5: Run tests and commit**

```powershell
git add src/main/agent/gatewayModelCatalog.ts src/main/agent/__tests__/gatewayModelCatalog.test.ts src/main/agent/AgentManager.ts src/main/agent/__tests__/AgentManager.modelSettingsCatalog.test.ts
git commit -m "feat(agent): aggregate models by gateway"
```

---

### Task 5: Model-selection coordinator and turn admission

**Files:**
- Create: `src/main/agent/AgentModelSelectionCoordinator.ts`
- Create: `src/main/agent/__tests__/AgentModelSelectionCoordinator.test.ts`
- Create: `src/main/agent/__tests__/AgentManager.modelSelection.test.ts`
- Modify: `src/main/agent/AgentManager.ts:644-826, 1244-1450, 2502-2645`
- Modify: `src/main/agent/CodexRuntimeSettingsStore.ts:1-282`
- Modify: `src/main/agent/ThreadStore.ts`
- Modify: `src/main/agent/__tests__/AgentManager.modelContext.test.ts`
- Modify: `src/main/agent/__tests__/AgentManager.test.ts`
- Modify: `src/main/agent/__tests__/AgentManager.steer.test.ts`
- Modify: `src/types/agent.ts:89-160, 195-260`

**Interfaces:**
- Consumes: `ProviderChannelController`, route resolver, provider/runtime stores.
- Produces: `AgentModelSelectionCoordinator.apply()` and `.ensureForTurn()`.
- Produces: `AgentModelSelectionApplyPayload`, `AgentModelSelectionApplyResult`, `AgentModelSelectionSnapshot`.

- [ ] **Step 1: Add the selection result types**

```ts
export interface AgentModelSelectionIntent {
  gatewayId: string
  modelId: string
  contextWindow: number
  catalogRevision: string
}

export interface AgentModelSelectionApplyPayload
  extends AgentModelSelectionIntent {
  threadId?: string
  requestVersion: number
}

export interface AgentModelSelectionSnapshot {
  gatewayId: string
  channelId: string
  modelId: string
  contextWindow: number
  autoCompactTokenLimit: number
  catalogRevision: string
  backendEpoch?: number
  threadRestored: boolean
}

export type AgentModelSelectionErrorKind =
  | 'configuration'
  | 'transient'
  | 'transaction'

export type AgentModelSelectionStage =
  | 'validate'
  | 'busy'
  | 'persist'
  | 'restart'
  | 'catalog'
  | 'resume'
  | 'verify'
  | 'rollback'

export type AgentModelSelectionApplyResult =
  | {
      ok: true
      data: AgentModelSelectionSnapshot & { requestVersion: number }
    }
  | {
      ok: false
      error: string
      kind: AgentModelSelectionErrorKind
      stage: AgentModelSelectionStage
      retryable: boolean
      requestVersion: number
      previous: AgentModelSelectionSnapshot
      rollback:
        | { ok: true; snapshot: AgentModelSelectionSnapshot }
        | { ok: false; error: string; effectiveSnapshot: null }
    }
```

Extend `AgentSendMessagePayload` without removing `model`:

```ts
modelSelection?: AgentModelSelectionIntent
```

- [ ] **Step 2: Write failing coordinator tests**

```ts
import { vi } from 'vitest'

import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionSnapshot,
} from '../../../types/agent'
import { AgentModelSelectionCoordinator } from '../AgentModelSelectionCoordinator'
import type { ProviderChannelController } from '../ProviderChannelController'

function selection(
  gatewayId: string,
  modelId: string,
  requestVersion: number,
): AgentModelSelectionApplyPayload {
  return {
    gatewayId,
    modelId,
    contextWindow: modelId === 'grok-4.5' ? 1_000_000 : 272_000,
    catalogRevision: 'catalog-1',
    requestVersion,
  }
}

function createSelectionHarness(
  overrides: Partial<AgentModelSelectionSnapshot> = {},
) {
  let snapshot: AgentModelSelectionSnapshot = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-standard',
    modelId: 'gpt-5.5',
    contextWindow: 272_000,
    autoCompactTokenLimit: 244_800,
    catalogRevision: 'catalog-1',
    backendEpoch: 1,
    threadRestored: false,
    ...overrides,
  }
  const channelController = {
    apply: vi.fn(async () => ({
      changed: false,
      previousChannelId: snapshot.channelId,
      channelId: snapshot.channelId,
      backendEpoch: snapshot.backendEpoch,
    })),
    restore: vi.fn(async () => undefined),
  } as unknown as ProviderChannelController
  const applyContext = vi.fn(async () => undefined)
  const persistSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const restoreSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const coordinator = new AgentModelSelectionCoordinator({
    channelController,
    getSnapshot: () => snapshot,
    catalogRevisionIsCurrent: () => true,
    applyContext,
    persistSelection,
    restoreSelection,
    resumeThread: vi.fn(async () => undefined),
    backendEpoch: () => 2,
  })

  return {
    coordinator,
    channelController,
    applyContext,
    persistSelection,
    restoreSelection,
  }
}

it('switches models in the same channel without restart', async () => {
  const harness = createSelectionHarness({
    gatewayId: 'rightcode',
    channelId: 'rightcode-standard',
    modelId: 'gpt-5.2',
  })

  const result = await harness.coordinator.apply(
    selection('rightcode', 'gpt-5.5', 1),
  )

  expect(result.ok).toBe(true)
  expect(harness.channelController.apply).toHaveBeenCalledWith(
    'rightcode-standard',
  )
})

it('rolls back channel model context and catalog on failure', async () => {
  const harness = createSelectionHarness()
  harness.applyContext.mockRejectedValueOnce(new Error('restart failed'))

  const result = await harness.coordinator.apply(
    selection('rightcode', 'grok-4.5', 1),
  )

  expect(result).toMatchObject({
    ok: false,
    kind: 'transaction',
    rollback: { ok: true },
  })
  expect(harness.channelController.restore).toHaveBeenCalledWith(
    'rightcode-standard',
  )
  expect(harness.persistSelection).not.toHaveBeenCalledWith(
    expect.objectContaining({ modelId: 'grok-4.5' }),
  )
})
```

Add AgentManager tests asserting that route repair runs before `addMessage()`.

- [ ] **Step 3: Run the coordinator suites**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/AgentModelSelectionCoordinator.test.ts" "src/main/agent/__tests__/AgentManager.modelSelection.test.ts" "src/main/agent/__tests__/AgentManager.modelContext.test.ts"
```

Expected: FAIL because the coordinator and selection RPC do not exist.

- [ ] **Step 4: Implement the coordinator boundary**

```ts
import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionErrorKind,
  AgentModelSelectionIntent,
  AgentModelSelectionSnapshot,
  AgentModelSelectionStage,
} from '../../types/agent'
import { modelAutoCompactTokenLimit } from '../../shared/modelSettings'
import { resolveGatewayModelRoute } from './gatewayModelRouting'
import type { ProviderChannelController } from './ProviderChannelController'

export interface AgentModelSelectionCoordinatorOptions {
  channelController: ProviderChannelController
  getSnapshot: () => AgentModelSelectionSnapshot
  catalogRevisionIsCurrent: (gatewayId: string, revision: string) => boolean
  applyContext: (contextWindow: number) => Promise<void>
  persistSelection: (
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ) => Promise<void>
  restoreSelection: (
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ) => Promise<void>
  resumeThread: (threadId: string) => Promise<void>
  backendEpoch: () => number | undefined
}

function classifySelectionError(
  error: unknown,
): AgentModelSelectionErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(?:401|403)\b|unauthori[sz]ed|not enabled/i.test(message)) {
    return 'configuration'
  }
  if (/\b429\b|timeout|ECONN|network|socket/i.test(message)) {
    return 'transient'
  }
  return 'transaction'
}

/** Applies model-driven Channel and context transitions atomically. */
export class AgentModelSelectionCoordinator {
  private latestRequestVersion = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: AgentModelSelectionCoordinatorOptions,
  ) {}

  apply(
    payload: AgentModelSelectionApplyPayload,
  ): Promise<AgentModelSelectionApplyResult> {
    this.latestRequestVersion = Math.max(
      this.latestRequestVersion,
      payload.requestVersion,
    )
    const operation = this.chain.then(() => this.applySerialized(payload))
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  ensureForTurn(
    intent: AgentModelSelectionIntent,
  ): Promise<AgentModelSelectionApplyResult> {
    const previous = this.options.getSnapshot()
    const route = resolveGatewayModelRoute(intent.gatewayId, intent.modelId)
    if (
      previous.gatewayId === intent.gatewayId
      && previous.channelId === route.channelId
      && previous.modelId === intent.modelId
      && previous.contextWindow === intent.contextWindow
      && previous.catalogRevision === intent.catalogRevision
    ) {
      return Promise.resolve({
        ok: true,
        data: {
          ...previous,
          requestVersion: this.latestRequestVersion,
        },
      })
    }
    return this.apply({
      ...intent,
      requestVersion: this.latestRequestVersion + 1,
    })
  }

  private async applySerialized(
    payload: AgentModelSelectionApplyPayload,
  ): Promise<AgentModelSelectionApplyResult> {
    const previous = this.options.getSnapshot()
    let stage: AgentModelSelectionStage = 'validate'
    try {
      stage = 'catalog'
      if (
        !this.options.catalogRevisionIsCurrent(
          payload.gatewayId,
          payload.catalogRevision,
        )
      ) {
        return this.failure(
          payload,
          previous,
          '模型目录已更新，请重新选择。',
          'configuration',
          'catalog',
          false,
          { ok: true, snapshot: previous },
        )
      }

      const route = resolveGatewayModelRoute(
        payload.gatewayId,
        payload.modelId,
      )
      stage = 'restart'
      await this.options.channelController.apply(route.channelId)
      await this.options.applyContext(payload.contextWindow)

      if (payload.requestVersion !== this.latestRequestVersion) {
        stage = 'rollback'
        await this.options.channelController.restore(previous.channelId)
        await this.options.restoreSelection(previous, payload.threadId)
        return this.failure(
          payload,
          previous,
          '模型选择已被更新的请求替代。',
          'transient',
          'rollback',
          true,
          { ok: true, snapshot: previous },
        )
      }

      let threadRestored = false
      if (payload.threadId) {
        stage = 'resume'
        await this.options.resumeThread(payload.threadId)
        threadRestored = true
      }
      const snapshot: AgentModelSelectionSnapshot = {
        gatewayId: payload.gatewayId,
        channelId: route.channelId,
        modelId: route.modelId,
        contextWindow: payload.contextWindow,
        autoCompactTokenLimit:
          modelAutoCompactTokenLimit(payload.contextWindow),
        catalogRevision: payload.catalogRevision,
        backendEpoch: this.options.backendEpoch(),
        threadRestored,
      }
      stage = 'persist'
      await this.options.persistSelection(snapshot, payload.threadId)
      return { ok: true, data: { ...snapshot, requestVersion: payload.requestVersion } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedStage = stage
      const kind = classifySelectionError(error)
      try {
        stage = 'rollback'
        await this.options.channelController.restore(previous.channelId)
        await this.options.restoreSelection(previous, payload.threadId)
        return this.failure(
          payload,
          previous,
          message,
          kind,
          failedStage,
          kind !== 'configuration',
          { ok: true, snapshot: previous },
        )
      } catch (rollbackError) {
        return this.failure(
          payload,
          previous,
          message,
          'transaction',
          'rollback',
          false,
          {
            ok: false,
            error: rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
            effectiveSnapshot: null,
          },
        )
      }
    }
  }

  private failure(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    error: string,
    kind: AgentModelSelectionErrorKind,
    stage: AgentModelSelectionStage,
    retryable: boolean,
    rollback: Extract<
      AgentModelSelectionApplyResult,
      { ok: false }
    >['rollback'],
  ): AgentModelSelectionApplyResult {
    return {
      ok: false,
      error,
      kind,
      stage,
      retryable,
      requestVersion: payload.requestVersion,
      previous,
      rollback,
    }
  }
}
```

Every catch result reports the last assigned stage. Do not duplicate the
transaction in `AgentManager`.

- [ ] **Step 5: Extract AgentManager context/provider mutation into the coordinator**

Add one `AgentModelSelectionCoordinator` field. Move model-context restart,
thread resume, and rollback callbacks out of `applyModelContextRpc()` into the
coordinator dependencies. Keep `applyModelContextRpc()` as a compatibility
adapter:

```ts
applyModelContextRpc(
  payload: AgentModelContextApplyPayload,
): Promise<AgentModelContextApplyResult> {
  return this.applyModelSelectionRpc({
    gatewayId: this.activeGatewayId,
    modelId: payload.model,
    contextWindow: payload.contextWindow,
    catalogRevision: this.currentModelCatalog.revision,
    threadId: payload.threadId,
    requestVersion: payload.requestVersion,
  }).then(mapSelectionResultToContextResult)
}
```

Wire persistence through one callback:

```ts
persistSelection: async (snapshot, threadId) => {
  await this.providerStore.setSelectedGatewayId(snapshot.gatewayId)
  await this.providerStore.setSelectedModelId(snapshot.modelId)
  await this.runtimeSettingsStore.replace({
    version: 1,
    confirmed: {
      modelContextWindow: snapshot.contextWindow,
      modelAutoCompactTokenLimit: snapshot.autoCompactTokenLimit,
    },
  })
  if (threadId && this.store) {
    await this.store.setThreadModel(threadId, snapshot.modelId)
  }
},
restoreSelection: async (snapshot, threadId) => {
  await this.providerStore.setSelectedGatewayId(snapshot.gatewayId)
  await this.providerStore.setSelectedModelId(snapshot.modelId)
  await this.runtimeSettingsStore.replace({
    version: 1,
    confirmed: {
      modelContextWindow: snapshot.contextWindow,
      modelAutoCompactTokenLimit: snapshot.autoCompactTokenLimit,
    },
  })
  if (threadId && this.store) {
    await this.store.setThreadModel(threadId, snapshot.modelId)
  }
},
```

The extraction must reduce `AgentManager.ts` net line count. Do not retain the
old independent context transaction after its tests pass through the adapter.

- [ ] **Step 6: Enforce route before persistence in send and steer**

At the start of `sendMessageAfterProviderBarrier()` and
`steerAfterProviderBarrier()`:

```ts
if (payload.modelSelection) {
  const route = await this.modelSelectionCoordinator.ensureForTurn(
    payload.modelSelection,
  )
  if (!route.ok) throw new Error(route.error)
}
```

For send, this call must occur before `ThreadStore.addMessage()`. For steer, it
must occur before persisting the steering message. Reuse coordinator
classification; do not add a second model-name conditional.

- [ ] **Step 7: Run tests and commit**

```powershell
git add src/main/agent/AgentModelSelectionCoordinator.ts src/main/agent/__tests__/AgentModelSelectionCoordinator.test.ts src/main/agent/__tests__/AgentManager.modelSelection.test.ts src/main/agent/AgentManager.ts src/main/agent/CodexRuntimeSettingsStore.ts src/main/agent/ThreadStore.ts src/main/agent/__tests__/AgentManager.modelContext.test.ts src/types/agent.ts
git commit -m "feat(agent): make model routing transactional"
```

---

### Task 6: Gateway and model-selection IPC

**Files:**
- Modify: `src/main/agent/ipc.ts:1-787`
- Modify: `src/preload/index.ts:1-1707`
- Create: `src/main/agent/__tests__/ipc.modelSelection.test.ts`
- Create: `src/preload/__tests__/preload.modelSelection.test.ts`
- Modify: `src/main/agent/__tests__/ipc.modelContext.test.ts`

**Interfaces:**
- Consumes: selection types and AgentManager methods from Task 5.
- Produces: renderer-safe Gateway and selection methods.

- [ ] **Step 1: Write failing IPC and preload tests**

```ts
it('applies one authoritative model-selection payload', async () => {
  const confirmed = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-grok',
    modelId: 'grok-4.5',
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 900_000,
    catalogRevision: 'catalog-1',
    backendEpoch: 2,
    threadRestored: false,
    requestVersion: 7,
  }
  manager.applyModelSelectionRpc.mockResolvedValue({
    ok: true,
    data: confirmed,
  })

  const result = await invoke('agent:model-selection-apply', {
    gatewayId: 'rightcode',
    modelId: 'grok-4.5',
    contextWindow: 1_000_000,
    catalogRevision: 'catalog-1',
    requestVersion: 7,
  })

  expect(manager.applyModelSelectionRpc).toHaveBeenCalledTimes(1)
  expect(result).toEqual({ ok: true, data: confirmed })
})
```

Preload assertion:

```ts
const payload: AgentModelSelectionApplyPayload = {
  gatewayId: 'rightcode',
  modelId: 'grok-4.5',
  contextWindow: 1_000_000,
  catalogRevision: 'catalog-1',
  requestVersion: 7,
}
await windowApi.agent.applyModelSelection(payload)
expect(ipcRenderer.invoke).toHaveBeenCalledWith(
  'agent:model-selection-apply',
  payload,
)
```

- [ ] **Step 2: Run IPC tests and verify failure**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/ipc.modelSelection.test.ts" "src/main/agent/__tests__/ipc.modelContext.test.ts" "src/preload/__tests__/preload.modelSelection.test.ts"
```

Expected: FAIL because the new IPC channels are unavailable.

- [ ] **Step 3: Add Gateway and selection APIs**

Register:

```ts
ipcMain.handle('agent:get-gateways', () => manager.getGatewaysSnapshotRpc())
ipcMain.handle(
  'agent:set-active-gateway',
  (_event, id: string) => manager.setActiveGatewayRpc(id),
)
ipcMain.handle(
  'agent:set-gateway-api-key',
  (_event, id: string, key: string) => manager.setGatewayApiKeyRpc(id, key),
)
ipcMain.handle(
  'agent:model-selection-apply',
  (_event, payload: AgentModelSelectionApplyPayload) =>
    manager.applyModelSelectionRpc(payload),
)
```

Expose matching preload methods:

```ts
getGateways: () => ipcRenderer.invoke('agent:get-gateways'),
setActiveGateway: (id) =>
  ipcRenderer.invoke('agent:set-active-gateway', id),
setGatewayApiKey: (id, key) =>
  ipcRenderer.invoke('agent:set-gateway-api-key', id, key),
applyModelSelection: (payload) =>
  ipcRenderer.invoke('agent:model-selection-apply', payload),
```

Keep custom Provider add/update/remove methods unchanged.

- [ ] **Step 4: Run IPC tests and commit**

```powershell
git add src/main/agent/ipc.ts src/preload/index.ts src/main/agent/__tests__/ipc.modelSelection.test.ts src/preload/__tests__/preload.modelSelection.test.ts src/main/agent/__tests__/ipc.modelContext.test.ts
git commit -m "feat(agent): expose gateway model selection IPC"
```

---

### Task 7: Extract renderer model routing slice

**Files:**
- Create: `src/renderer/src/features/agent-chat/modelRoutingSlice.ts`
- Create: `src/renderer/src/features/agent-chat/__tests__/store.modelRouting.test.ts`
- Modify: `src/renderer/src/features/agent-chat/store.ts:686-712, 820-823, 1978-1995, 2223-2481`
- Modify: `src/renderer/src/features/agent-chat/ModelSettingsPanel.tsx`
- Modify: `src/renderer/src/features/agent-chat/MentionInput.tsx`
- Modify: `src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts`

**Interfaces:**
- Consumes: preload selection RPC from Task 6.
- Produces: `ModelRoutingSliceState`, `ModelRoutingSliceActions`, `createModelRoutingSlice()`.
- Changes: `setSelectedModel()` returns `Promise<boolean>`.

- [ ] **Step 1: Write failing renderer transaction tests**

```ts
function deferredResult<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const confirmedSelection = {
  gatewayId: 'rightcode',
  channelId: 'rightcode-grok',
  modelId: 'grok-4.5',
  contextWindow: 1_000_000,
  autoCompactTokenLimit: 900_000,
  catalogRevision: 'catalog-1',
  backendEpoch: 2,
  threadRestored: false,
  requestVersion: 1,
}

it('commits selectedModelId only after main confirms selection', async () => {
  const deferred = deferredResult<AgentModelSelectionApplyResult>()
  mockAgent.applyModelSelection.mockReturnValue(deferred.promise)
  const store = createAgentChatStore()

  const pending = store.getState().setSelectedModel('grok-4.5')
  expect(store.getState().selectedModelId).toBe('gpt-5.5')
  expect(store.getState().modelSelectionPending?.modelId).toBe('grok-4.5')

  deferred.resolve({ ok: true, data: confirmedSelection })
  await expect(pending).resolves.toBe(true)
  expect(store.getState().selectedModelId).toBe('grok-4.5')
})

it('keeps the old model and exposes retry after rollback', async () => {
  mockAgent.applyModelSelection.mockResolvedValue({
    ok: false,
    error: 'gateway timeout',
    kind: 'transient',
    stage: 'restart',
    retryable: true,
    requestVersion: 1,
    previous: {
      ...confirmedSelection,
      channelId: 'rightcode-standard',
      modelId: 'gpt-5.5',
    },
    rollback: {
      ok: true,
      snapshot: {
        ...confirmedSelection,
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
      },
    },
  })
  const store = createAgentChatStore()

  await expect(store.getState().setSelectedModel('grok-4.5')).resolves.toBe(false)

  expect(store.getState()).toMatchObject({
    selectedModelId: 'gpt-5.5',
    modelSelectionError: { retryable: true },
  })
})
```

- [ ] **Step 2: Run renderer routing tests**

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/store.modelRouting.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts"
```

Expected: FAIL because selection is renderer-local and the slice does not exist.

- [ ] **Step 3: Define the extracted slice**

```ts
export interface ModelRoutingSliceState {
  selectedModelId: string
  modelSettingsCatalog?: AgentModelSettingsCatalog
  modelSettingsLoading: boolean
  modelSettingsError?: string
  modelSelectionSnapshot?: AgentModelSelectionSnapshot
  modelSelectionPending?: AgentModelSelectionApplyPayload
  modelSelectionFailedIntent?: AgentModelSelectionApplyPayload
  modelSelectionError?: {
    message: string
    kind: AgentModelSelectionErrorKind
    retryable: boolean
  }
  modelSelectionRequestSequence: number
}

export interface ModelRoutingSliceActions {
  loadModelSettingsCatalog: (gatewayId?: string) => Promise<void>
  setSelectedModel: (modelId: string) => Promise<boolean>
  retryModelSelection: () => Promise<boolean>
  setModelContextWindow: (contextWindow: number) => Promise<boolean>
}

export type ModelRoutingSlice =
  & ModelRoutingSliceState
  & ModelRoutingSliceActions
```

Define a host contract instead of importing `AgentChatStore`:

```ts
export interface ModelRoutingHost {
  threadId?: string
  activeModelContextWindow: number
  modelContextWindowByModel: Record<string, number>
  invalidateCollaborationCapabilities: () => void
  loadCollaborationCapabilities: (gatewayId?: string) => Promise<void>
}

type ModelRoutingOwner = ModelRoutingSlice & ModelRoutingHost
type ModelRoutingSet = (
  partial: Partial<ModelRoutingOwner>,
) => void
type ModelRoutingGet = () => ModelRoutingOwner
```

- [ ] **Step 4: Implement latest-wins renderer actions**

```ts
export function createModelRoutingSlice(
  set: ModelRoutingSet,
  get: ModelRoutingGet,
): ModelRoutingSlice {
  return {
    selectedModelId: readPersistedModelId(),
    modelSettingsCatalog: undefined,
    modelSettingsLoading: false,
    modelSettingsError: undefined,
    modelSelectionSnapshot: undefined,
    modelSelectionPending: undefined,
    modelSelectionFailedIntent: undefined,
    modelSelectionError: undefined,
    modelSelectionRequestSequence: 0,

    setSelectedModel: async (modelId) => {
      const before = get()
      const row = before.modelSettingsCatalog?.models.find(
        (candidate) => candidate.id === modelId,
      )
      if (!row || row.availability.status !== 'available') return false

      const requestVersion = before.modelSelectionRequestSequence + 1
      const activeContextSupported = row.capabilities.contextOptions.some(
        (option) => option.value === before.activeModelContextWindow,
      )
      const payload: AgentModelSelectionApplyPayload = {
        gatewayId: before.modelSettingsCatalog.gatewayId,
        modelId,
        contextWindow: activeContextSupported
          ? before.activeModelContextWindow
          : before.modelContextWindowByModel[modelId]
            ?? row.capabilities.defaultContextWindow,
        catalogRevision: before.modelSettingsCatalog.revision,
        threadId: before.threadId,
        requestVersion,
      }
      set({
        modelSelectionPending: payload,
        modelSelectionFailedIntent: undefined,
        modelSelectionError: undefined,
        modelSelectionRequestSequence: requestVersion,
      })

      const result = await requireAgentApi().applyModelSelection(payload)
      if (get().modelSelectionRequestSequence !== requestVersion) return false
      if (!result.ok) {
        set({
          modelSelectionPending: undefined,
          modelSelectionFailedIntent: payload,
          modelSelectionError: {
            message: result.error,
            kind: result.kind,
            retryable: result.retryable,
          },
        })
        return false
      }

      persistCanonicalModelId(result.data.modelId)
      set({
        selectedModelId: result.data.modelId,
        activeModelContextWindow: result.data.contextWindow,
        modelSelectionSnapshot: result.data,
        modelSelectionPending: undefined,
        modelSelectionFailedIntent: undefined,
        modelSelectionError: undefined,
      })
      void get().loadCollaborationCapabilities(result.data.gatewayId)
      return true
    },

    retryModelSelection: async () => {
      const failedModel = get().modelSelectionFailedIntent?.modelId
      return failedModel ? get().setSelectedModel(failedModel) : false
    },

    loadModelSettingsCatalog: createCatalogLoader(set, get),
    setModelContextWindow: createContextApplier(set, get),
  }
}
```

- [ ] **Step 5: Integrate the slice and remove moved code**

Spread `createModelRoutingSlice(set, get)` into the store initializer. Delete
the moved model-selection/catalog/context action bodies and state initialization
from `store.ts`. Keep collaboration hooks in the host interface.

The completed diff must reduce `store.ts` net line count. Do not copy old code
into the slice and leave a second implementation behind.

- [ ] **Step 6: Connect pending state to composer controls**

Add `modelSelectionPending` to the existing `controlsDisabled` and
`settingsInteractionsDisabled` calculations in `MentionInput.tsx` and
`ModelSettingsPanel.tsx`.

- [ ] **Step 7: Run tests and commit**

```powershell
git add src/renderer/src/features/agent-chat/modelRoutingSlice.ts src/renderer/src/features/agent-chat/__tests__/store.modelRouting.test.ts src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/ModelSettingsPanel.tsx src/renderer/src/features/agent-chat/MentionInput.tsx src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts
git commit -m "refactor(agent-chat): extract model routing state"
```

---

### Task 8: Gateway settings and grouped ModelPicker UI

**Files:**
- Modify: `src/renderer/src/features/agent-chat/ModelPicker.tsx:1-478`
- Modify: `src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx`
- Modify: `src/renderer/src/stores/useSettingsStore.ts:1-613`
- Modify: `src/renderer/src/stores/__tests__/useSettingsStore.test.ts`
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`
- Modify: `src/renderer/src/pages-react/settings/CodexProviderManager.tsx:1-447`
- Modify: `src/renderer/src/pages-react/settings/CodexProviderManager.test.tsx`

**Interfaces:**
- Consumes: Gateway snapshot and ModelRouting slice.
- Produces: two builtin Gateway cards and grouped model selection UX.

- [ ] **Step 1: Write failing Gateway settings tests**

```tsx
it('renders two builtin gateways instead of Grok provider cards', async () => {
  render(<CodexProviderManager />)
  await screen.findByText('API Yi')

  expect(screen.getByText('Right.Codes')).toBeInTheDocument()
  expect(screen.queryByText('API Yi Grok')).not.toBeInTheDocument()
  expect(screen.queryByText('Right.Codes Grok')).not.toBeInTheDocument()
})

it('saves one shared key for the active gateway', async () => {
  render(<CodexProviderManager />)
  await userEvent.type(screen.getByLabelText('Right.Codes API Key'), 'shared-key')
  await userEvent.click(screen.getByRole('button', { name: '测试并保存' }))

  expect(agent.setGatewayApiKey).toHaveBeenCalledWith(
    'rightcode',
    'shared-key',
  )
})
```

- [ ] **Step 2: Write failing grouped ModelPicker tests**

```tsx
function setGatewayCatalog(
  grokAvailability: AgentModelAvailability = { status: 'available' },
) {
  const openaiRoute = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-standard',
    modelId: 'gpt-5.5',
    family: 'openai' as const,
  }
  const grokRoute = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-grok',
    modelId: 'grok-4.5',
    family: 'xai' as const,
  }
  useAgentChatStore.setState({
    selectedModelId: 'gpt-5.5',
    modelSettingsCatalog: {
      gatewayId: 'rightcode',
      revision: 'catalog-1',
      source: 'mixed',
      models: [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: 'OpenAI model',
          hidden: false,
          isDefault: true,
          family: 'openai',
          route: openaiRoute,
          availability: { status: 'available' },
          capabilities: mergeModelSettingsCapabilities({
            model: 'gpt-5.5',
            gatewayId: 'rightcode',
            channelId: 'rightcode-standard',
            supportedReasoningEfforts: [],
          }),
        },
        {
          id: 'grok-4.5',
          displayName: 'Grok 4.5',
          description: 'xAI model',
          hidden: false,
          isDefault: false,
          family: 'xai',
          route: grokRoute,
          availability: grokAvailability,
          capabilities: mergeModelSettingsCapabilities({
            model: 'grok-4.5',
            gatewayId: 'rightcode',
            channelId: 'rightcode-grok',
            supportedReasoningEfforts: ['low', 'medium', 'high'],
          }),
        },
      ],
    },
  })
}

it('groups models by family while keeping one keyboard index', async () => {
  const selectModel = vi.fn(async () => true)
  setGatewayCatalog()
  useAgentChatStore.setState({ setSelectedModel: selectModel })
  render(<ModelPicker />)
  await userEvent.click(screen.getByRole('button', { name: /GPT-5.5/ }))

  expect(screen.getByText('OPENAI')).toBeInTheDocument()
  expect(screen.getByText('XAI')).toBeInTheDocument()
  expect(screen.getByText(/Gateway.*Right\.Codes/)).toBeInTheDocument()

  screen.getByRole('option', { name: /GPT-5.5/ }).focus()
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(selectModel).toHaveBeenCalledWith('grok-4.5')
})

it('keeps deterministic unauthorized Grok visible and disabled', () => {
  setGatewayCatalog({
    status: 'unauthorized',
    reason: '当前 Key 未开通',
  })
  render(<ModelPicker />)

  expect(screen.getByText('Grok 4.5')).toBeInTheDocument()
  expect(screen.getByText('当前 Key 未开通')).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Grok 4.5/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})
```

- [ ] **Step 3: Run UI tests and verify failure**

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/stores/__tests__/useSettingsStore.test.ts" "src/renderer/src/pages-react/settings/CodexProviderManager.test.tsx"
```

Expected: FAIL because settings still exposes four builtins and ModelPicker has
no family/availability UI.

- [ ] **Step 4: Switch settings state from Provider to Gateway methods**

Replace builtin Provider selection/key actions with:

```ts
loadGateways: async () => {
  const result = await requireAgentApi().getGateways()
  if (!result.ok) throw new Error(result.error)
  set({
    gateways: result.data,
    activeGatewayId: result.data.activeId,
  })
},

selectGateway: async (gatewayId) => {
  set({ pendingGatewayId: gatewayId })
  const result = await requireAgentApi().setActiveGateway(gatewayId)
  if (!result.ok) {
    set({ pendingGatewayId: undefined, gatewayError: result.error })
    return false
  }
  set({
    activeGatewayId: result.data.activeId,
    pendingGatewayId: undefined,
    gatewayError: undefined,
  })
  await Promise.all([
    get().loadModelSettingsCatalog(result.data.activeId),
    get().loadCollaborationCapabilities(result.data.activeId),
  ])
  return true
},
```

Retain custom Provider CRUD fields and methods. Rename only user-visible builtin
state; do not change custom Provider form semantics.

- [ ] **Step 5: Render the approved Gateway cards**

In `CodexProviderManager.tsx`:

- Render API Yi and Right.Codes from `gateways.builtins`.
- Use radio-card semantics with visible focus.
- Show `Active`, `Ready`, or `Needs key` as text plus color.
- Show GPT, Grok 4.5, and maximum context chips.
- Render one labeled Key input for the active Gateway.
- Rename the section copy from Provider selection to Codex Gateway selection.

Use existing black/yellow CSS tokens and existing card spacing. Do not introduce
gradients, box shadows, emoji icons, or a new font dependency.

- [ ] **Step 6: Render grouped models and inline transition status**

Build groups without mutating catalog order:

```ts
const FAMILY_ORDER: readonly AgentModelFamily[] = [
  'openai',
  'xai',
  'other',
]

const FAMILY_LABEL: Record<AgentModelFamily, string> = {
  openai: 'OPENAI',
  xai: 'XAI',
  other: 'OTHER',
}

const groupedModels = FAMILY_ORDER
  .map((family) => ({
    family,
    models: visibleModels.filter((model) => model.family === family),
  }))
  .filter((group) => group.models.length > 0)

const flatModels = groupedModels.flatMap((group) => group.models)
```

Use `flatModels` for ArrowUp/ArrowDown and Enter. Render headers from
`groupedModels`. Add:

```tsx
<div aria-live="polite" className="agent-model-route-status">
  {modelSelectionPending
    ? `正在切换 ${pendingModelLabel} 通道…`
    : modelSelectionError?.message}
</div>
```

On success, close the popover and restore composer focus. On failure, leave it
open and show a retry button only when `retryable` is true.

- [ ] **Step 7: Run UI tests, lints, and commit**

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/stores/__tests__/useSettingsStore.test.ts" "src/renderer/src/pages-react/settings/CodexProviderManager.test.tsx"
```

Expected: all selected suites pass.

```powershell
git add src/renderer/src/features/agent-chat/ModelPicker.tsx src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx src/renderer/src/stores/useSettingsStore.ts src/renderer/src/stores/__tests__/useSettingsStore.test.ts src/renderer/src/pages-react/SettingsPage.tsx src/renderer/src/pages-react/settings/CodexProviderManager.tsx src/renderer/src/pages-react/settings/CodexProviderManager.test.tsx
git commit -m "feat(agent-ui): select gateway models in chat"
```

---

### Task 9: Regression coverage and real Gateway smoke tests

**Files:**
- Create: `scripts/smoke-provider-model-routing.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the completed Gateway, Channel, catalog, transaction, and UI contracts.
- Produces: one repeatable real-gateway verification command.

- [ ] **Step 1: Add a credential-safe smoke script**

The script must:

- read `APIYI_GROK_TEST_KEY` and `RIGHTCODE_TEST_KEY` from environment variables;
- never print either key;
- start one temporary Codex home per Gateway;
- select GPT, send one exact-response turn, select Grok, send one exact-response turn;
- assert the effective Channel and base URL through the model-selection snapshot;
- classify HTTP 429 as transient;
- close compatibility proxies and backend processes in `finally`.

Use this result shape:

```ts
interface SmokeResult {
  gatewayId: 'apiyi' | 'rightcode'
  modelId: string
  channelId: string
  baseUrl: string
  status: 'passed' | 'transient'
  detail?: string
}
```

Print only JSON rows matching `SmokeResult`.

- [ ] **Step 2: Add the smoke command**

```json
{
  "scripts": {
    "smoke:provider-model-routing": "tsx scripts/smoke-provider-model-routing.ts"
  }
}
```

- [ ] **Step 3: Run focused main-process regressions**

```powershell
pnpm exec vitest run "src/main/agent/__tests__/gatewayModelRouting.test.ts" "src/main/agent/__tests__/gatewayModelCatalog.test.ts" "src/main/agent/__tests__/ProviderChannelController.test.ts" "src/main/agent/__tests__/AgentModelSelectionCoordinator.test.ts" "src/main/agent/__tests__/AgentManager.modelSelection.test.ts" "src/main/agent/__tests__/AgentManager.modelSettingsCatalog.test.ts" "src/main/agent/__tests__/AgentManager.modelContext.test.ts" "src/main/agent/__tests__/CodexProviderStore.test.ts" "src/main/agent/__tests__/CodexLocalBackend.test.ts" "src/main/agent/__tests__/responsesCompatibilityProxy.test.ts" "src/main/agent/__tests__/ipc.modelSelection.test.ts"
```

Expected: all selected suites pass with zero failures.

- [ ] **Step 4: Run focused renderer regressions**

```powershell
pnpm exec vitest run "src/renderer/src/features/agent-chat/__tests__/store.modelRouting.test.ts" "src/renderer/src/features/agent-chat/__tests__/store.modelSettings.test.ts" "src/renderer/src/features/agent-chat/__tests__/ModelPicker.modelSettings.test.tsx" "src/renderer/src/stores/__tests__/useSettingsStore.test.ts" "src/renderer/src/pages-react/settings/CodexProviderManager.test.tsx"
```

Expected: all selected suites pass with zero failures.

- [ ] **Step 5: Run repository gates**

```powershell
npm run typecheck:ci
npm run audit:skill-arch
npm run test:skill-arch
npm run build:vite
```

Expected:

- `typecheck:ci`: zero new errors against the tracked baseline;
- skill architecture: zero violations and all tests pass;
- Vite build: exit code 0.

- [ ] **Step 6: Run real Gateway smoke tests**

```powershell
if (-not $env:APIYI_GROK_TEST_KEY) {
  throw 'APIYI_GROK_TEST_KEY must already be set in this shell'
}
if (-not $env:RIGHTCODE_TEST_KEY) {
  throw 'RIGHTCODE_TEST_KEY must already be set in this shell'
}
npm run smoke:provider-model-routing
```

Expected:

- API Yi GPT: `passed`;
- API Yi Grok 4.5: `passed`;
- Right.Codes GPT: `passed` or `transient` only for a real 429;
- Right.Codes Grok 4.5: `passed` or `transient` only for a real 429;
- every Grok row reports the `*-grok` Channel;
- Right.Codes Grok reports `https://right.codes/grok/v1`.

- [ ] **Step 7: Verify large-file extraction**

```powershell
(Get-Content src/main/agent/AgentManager.ts).Count
(Get-Content src/renderer/src/features/agent-chat/store.ts).Count
```

Expected: both files contain fewer lines than before this work
(`AgentManager.ts` below 3945 and `store.ts` below 4213). New route/catalog/
transaction logic must reside in the focused files listed above.

- [ ] **Step 8: Commit verification assets**

```powershell
git add scripts/smoke-provider-model-routing.ts package.json
git commit -m "test(agent): verify gateway model routing"
```

Do not add `.superpowers/`, terminal output, temporary Codex homes, or
credential files.

---

## Final acceptance checklist

- [ ] Settings shows API Yi and Right.Codes as the only builtin Gateway cards.
- [ ] One Key configures both standard and Grok Channels for each Gateway.
- [ ] ModelPicker shows GPT and Grok under one active Gateway.
- [ ] ModelPicker groups `OPENAI`, `XAI`, and `OTHER` with one keyboard index.
- [ ] Same-Channel model selection does not restart Codex.
- [ ] Cross-Channel selection displays inline progress and restores focus.
- [ ] Failed selection rolls back Channel, model, context, catalog, and thread.
- [ ] Send and steer ensure the authoritative route before persisting messages.
- [ ] API Yi Grok remains 500K; Right.Codes Grok remains 1M.
- [ ] Right.Codes Grok always uses `/grok/v1`.
- [ ] 429 and network failures remain retryable and never disable Grok.
- [ ] Existing `apiyi-grok` and `rightcode-grok` selections migrate without losing Keys or model preferences.
- [ ] Custom Provider CRUD and single-Channel behavior remain unchanged.
- [ ] Responses compatibility proxy behavior remains covered by regression tests.
- [ ] `AgentManager.ts` and `agent-chat/store.ts` shrink through targeted extraction.
- [ ] Typecheck, architecture audit, focused tests, Vite build, and real smoke evidence are recorded.
