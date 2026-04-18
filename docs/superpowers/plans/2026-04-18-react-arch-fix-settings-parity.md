# React 架构修复 + SettingsPage 功能对等 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 architectural issues from code review and make SettingsPage the first 100%-parity React page, establishing patterns for future page migrations.

**Architecture:** Zustand stores with `subscribeWithSelector` middleware, typed `useApi()` facade hook wrapping `ServiceRegistry`, page-level stores with service injection via action parameters, shared `darkSelectStyles` for react-select.

**Tech Stack:** React 19.2.5, Zustand 5.0.12, TypeScript 6.0.2, react-select 5.10.2, Vitest, @testing-library/react, @testing-library/user-event

**Spec:** `docs/superpowers/specs/2026-04-18-react-arch-fix-settings-parity-design.md`

---

## File Structure

```
src/renderer/src/
├── hooks/
│   └── useService.ts                    ← MODIFY: add ApiActions interface + useApi() hook
├── stores/
│   ├── useTabStore.ts                   ← MODIFY: add subscribeWithSelector middleware
│   ├── useToastStore.ts                 ← MODIFY: replace toastId counter with crypto.randomUUID()
│   ├── useSettingsStore.ts              ← CREATE: page-level store for SettingsPage
│   └── __tests__/
│       ├── useTabStore.test.ts          ← MODIFY: update for subscribeWithSelector
│       └── useSettingsStore.test.ts     ← CREATE: store unit tests
├── styles/
│   └── selectTheme.ts                   ← CREATE: shared dark theme for react-select
├── layouts/
│   └── AppLayout.tsx                    ← MODIFY: add hash sync effects
├── pages-react/
│   ├── SettingsPage.tsx                 ← MODIFY: rewrite with store + useApi()
│   └── settings/
│       ├── SiteGrid.tsx                 ← CREATE: site card grid component
│       └── ApiKeyInput.tsx              ← CREATE: API key input with toggle
├── services/api/
│   └── ApiService.ts                    ← MODIFY: add testConnection() method
└── components/ModelSelector/
    └── ModelSelector.tsx                ← MODIFY: use shared darkSelectStyles
docs/superpowers/references/
    └── page-migration-playbook.md       ← CREATE: migration playbook
```

---

### Task 1: Add `testConnection` to ApiService

`ApiService` currently has no `testConnection` method. The old `SiteManager` implements it inline by fetching `/v1/models`. We need to add this to `ApiService` so the typed facade can expose it.

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts:1306-1318`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/services/api/__tests__/ApiService.testConnection.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiService } from '../ApiService'

describe('ApiService.testConnection', () => {
  let service: ApiService

  beforeEach(() => {
    service = new ApiService()
    vi.restoreAllMocks()
  })

  it('returns true when /v1/models responds 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    )

    const result = await service.testConnection('test-key-123')
    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key-123',
        }),
      })
    )
  })

  it('returns false when /v1/models responds non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401 })
    )

    const result = await service.testConnection('bad-key')
    expect(result).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

    const result = await service.testConnection('any-key')
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.testConnection.test.ts`
Expected: FAIL — `service.testConnection is not a function`

- [ ] **Step 3: Implement `testConnection` on ApiService**

Add this method to `ApiService` class in `src/renderer/src/services/api/ApiService.ts`, after the `setSite` method (around line 1318):

```typescript
  /**
   * 测试 API 连接
   * @param apiKey - 要测试的 API Key
   * @returns true if the API responds successfully
   */
  async testConnection(apiKey: string): Promise<boolean> {
    const site = this.apiSites[this.currentSite]
    if (!site) return false

    try {
      const response = await fetch(`${site.baseURL}/v1/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })
      return response.ok
    } catch {
      return false
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.testConnection.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts src/renderer/src/services/api/__tests__/ApiService.testConnection.test.ts
git commit -m "feat: add testConnection method to ApiService"
```

---

### Task 2: Create typed `useApi()` facade hook

**Files:**
- Modify: `src/renderer/src/hooks/useService.ts`

- [ ] **Step 1: Add interfaces and `useApi()` to `useService.ts`**

Add the following at the end of `src/renderer/src/hooks/useService.ts` (after the `useTranslation` function):

```typescript
import type { ApiSite, GenerateImageParams, GenerateResult } from '../services/api/ApiService'

export interface ApiActions {
  generateImage(params: GenerateImageParams): Promise<GenerateResult>
  testConnection(apiKey: string): Promise<boolean>
  saveApiKey(key: string): boolean
  saveVisionApiKey(key: string): boolean
  getAllSites(): Record<string, ApiSite>
  setSite(key: string): boolean
  getStoredApiKey(siteKey?: string): string | null
  getStoredVisionApiKey(siteKey?: string): string | null
  getCurrentSite(): ApiSite | undefined
  getSiteConfig(key: string): ApiSite | undefined
  readonly currentSiteKey: string
}

export function useApi(): ApiActions {
  const api = useApiService()
  return {
    generateImage: (p) => api.generateImage(p),
    testConnection: (k) => api.testConnection(k),
    saveApiKey: (k) => api.saveApiKey(k),
    saveVisionApiKey: (k) => api.saveVisionApiKey(k),
    getAllSites: () => api.getAllSites(),
    setSite: (k) => api.setSite(k),
    getStoredApiKey: (k) => api.getStoredApiKey(k),
    getStoredVisionApiKey: (k) => api.getStoredVisionApiKey(k),
    getCurrentSite: () => api.getCurrentSite(),
    getSiteConfig: (k) => api.getAllSites()[k],
    get currentSiteKey() { return api.currentSiteKey },
  }
}
```

Note: The `import` for `ApiSite`, `GenerateImageParams`, `GenerateResult` should be added at the top of the file alongside existing imports. The `useCallback` import that already exists can stay as is — `useApi` doesn't need it.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors from `useService.ts`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/useService.ts
git commit -m "feat: add typed useApi() facade hook"
```

---

### Task 3: Create shared `darkSelectStyles`

**Files:**
- Create: `src/renderer/src/styles/selectTheme.ts`
- Modify: `src/renderer/src/components/ModelSelector/ModelSelector.tsx`

- [ ] **Step 1: Create `selectTheme.ts`**

Create `src/renderer/src/styles/selectTheme.ts`:

```typescript
import type { StylesConfig } from 'react-select'

export function darkSelectStyles<T>(): StylesConfig<T> {
  return {
    control: (base, state) => ({
      ...base,
      backgroundColor: '#18181b',
      borderColor: state.isFocused ? '#facc15' : '#3f3f46',
      boxShadow: state.isFocused ? '0 0 0 1px #facc15' : 'none',
      '&:hover': { borderColor: state.isFocused ? '#facc15' : '#52525b' },
      minHeight: '38px',
    }),
    menu: (base) => ({
      ...base,
      backgroundColor: '#18181b',
      border: '1px solid #3f3f46',
    }),
    option: (base, { isFocused, isSelected }) => ({
      ...base,
      backgroundColor: isSelected ? '#facc15' : isFocused ? '#27272a' : '#18181b',
      color: isSelected ? '#09090b' : '#fafafa',
      cursor: 'pointer',
    }),
    singleValue: (base) => ({ ...base, color: '#fafafa' }),
    input: (base) => ({ ...base, color: '#fafafa' }),
    placeholder: (base) => ({ ...base, color: '#71717a' }),
  }
}
```

- [ ] **Step 2: Replace inline styles in `ModelSelector.tsx`**

In `src/renderer/src/components/ModelSelector/ModelSelector.tsx`, replace the `selectStyles` constant and its import:

Replace the entire `selectStyles` block (lines 10-28) with:

```typescript
import { darkSelectStyles } from '../../styles/selectTheme'

const selectStyles = darkSelectStyles<ModelOption>()
```

Remove the old `StylesConfig` import from the react-select import line. The updated import should be:

```typescript
import Select, { type SingleValue } from 'react-select'
```

- [ ] **Step 3: Verify ModelSelector still renders (TypeScript compile)**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/styles/selectTheme.ts src/renderer/src/components/ModelSelector/ModelSelector.tsx
git commit -m "refactor: extract shared darkSelectStyles for react-select"
```

---

### Task 4: Fix `useTabStore` — add `subscribeWithSelector` middleware

**Files:**
- Modify: `src/renderer/src/stores/useTabStore.ts`
- Modify: `src/renderer/src/stores/__tests__/useTabStore.test.ts`

- [ ] **Step 1: Update `useTabStore.ts`**

Replace the entire file content of `src/renderer/src/stores/useTabStore.ts` with:

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

const VALID_TABS = [
  'generate',
  'batch',
  'compare',
  'history',
  'understand',
  'director',
  'settings',
  'promptTemplates',
] as const

export type TabName = (typeof VALID_TABS)[number]

interface TabState {
  activeTab: TabName
  previousTab: TabName | null
  switchTab: (tab: string) => void
}

export const useTabStore = create<TabState>()(
  subscribeWithSelector((set, get) => ({
    activeTab: 'generate',
    previousTab: null,
    switchTab: (tab: string) => {
      if (!VALID_TABS.includes(tab as TabName)) return
      const prev = get().activeTab
      if (prev === tab) return
      set({ activeTab: tab as TabName, previousTab: prev })
    },
  }))
)
```

Key changes: (1) Added `subscribeWithSelector` middleware, (2) Removed `window.location.hash = tab` side effect.

- [ ] **Step 2: Run existing tab store tests**

Run: `npx vitest run src/renderer/src/stores/__tests__/useTabStore.test.ts`
Expected: PASS — all 4 existing tests should still pass (the hash side effect wasn't tested)

- [ ] **Step 3: Add subscribe-with-selector test**

Add to `src/renderer/src/stores/__tests__/useTabStore.test.ts`:

```typescript
  it('supports subscribe with selector', () => {
    const calls: string[] = []
    const unsub = useTabStore.subscribe(
      (state) => state.activeTab,
      (tab) => calls.push(tab)
    )

    useTabStore.getState().switchTab('history')
    expect(calls).toEqual(['history'])

    useTabStore.getState().switchTab('settings')
    expect(calls).toEqual(['history', 'settings'])

    unsub()
    useTabStore.getState().switchTab('generate')
    expect(calls).toEqual(['history', 'settings'])
  })
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/renderer/src/stores/__tests__/useTabStore.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useTabStore.ts src/renderer/src/stores/__tests__/useTabStore.test.ts
git commit -m "fix: add subscribeWithSelector to useTabStore, remove hash side effect"
```

---

### Task 5: Fix `useToastStore` ID generation + Add hash sync to `AppLayout`

**Files:**
- Modify: `src/renderer/src/stores/useToastStore.ts`
- Modify: `src/renderer/src/layouts/AppLayout.tsx`

- [ ] **Step 1: Fix toast ID in `useToastStore.ts`**

In `src/renderer/src/stores/useToastStore.ts`, delete line 17 (`let toastId = 0`).

Then replace `const id = String(++toastId)` (line 22) with:

```typescript
    const id = crypto.randomUUID()
```

The full `addToast` action should now read:

```typescript
  addToast: (toast) => {
    const id = crypto.randomUUID()
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    const duration = toast.duration ?? 3000
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },
```

- [ ] **Step 2: Add hash sync effects to `AppLayout.tsx`**

Replace the content of `src/renderer/src/layouts/AppLayout.tsx` with:

```typescript
import { Suspense, useEffect } from 'react'
import { useTabStore, type TabName } from '../stores'
import { TabBar } from '../components/TabBar'
import {
  GeneratePage,
  BatchPage,
  ComparePage,
  HistoryPage,
  UnderstandPage,
  SettingsPage,
  DirectorPage,
  PromptTemplatesPage,
} from '../pages-react'

const PAGE_MAP: Record<TabName, React.LazyExoticComponent<() => React.JSX.Element>> = {
  generate: GeneratePage,
  batch: BatchPage,
  compare: ComparePage,
  history: HistoryPage,
  understand: UnderstandPage,
  settings: SettingsPage,
  director: DirectorPage,
  promptTemplates: PromptTemplatesPage,
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

export function AppLayout() {
  const activeTab = useTabStore((s) => s.activeTab)
  const ActivePage = PAGE_MAP[activeTab]

  useEffect(() => {
    const unsub = useTabStore.subscribe(
      (state) => state.activeTab,
      (tab) => { window.location.hash = tab }
    )
    return unsub
  }, [])

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash) useTabStore.getState().switchTab(hash)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-cyberpunk-black text-white font-exo">
      <TabBar />
      <main className="flex-1 overflow-auto">
        <Suspense fallback={<PageFallback />}>
          <ActivePage />
        </Suspense>
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Run toast store tests**

Run: `npx vitest run src/renderer/src/stores/__tests__/useToastStore.test.ts`
Expected: PASS

- [ ] **Step 4: Verify TypeScript compile**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useToastStore.ts src/renderer/src/layouts/AppLayout.tsx
git commit -m "fix: use crypto.randomUUID for toast IDs, move hash sync to AppLayout"
```

---

### Task 6: Create `useSettingsStore` with tests

**Files:**
- Create: `src/renderer/src/stores/useSettingsStore.ts`
- Create: `src/renderer/src/stores/__tests__/useSettingsStore.test.ts`

- [ ] **Step 1: Write the store tests first**

Create `src/renderer/src/stores/__tests__/useSettingsStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    saveApiKey: vi.fn().mockReturnValue(true),
    saveVisionApiKey: vi.fn().mockReturnValue(true),
    getAllSites: vi.fn().mockReturnValue({
      'b-apiyi': { name: 'API易 B站', baseURL: 'https://b.apiyi.com', description: '推荐', authType: 'bearer', isBuiltIn: true },
      'yunwu': { name: '云雾 API', baseURL: 'https://yunwu.ai', description: '云雾', authType: 'bearer', isBuiltIn: true },
    }),
    setSite: vi.fn().mockReturnValue(true),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn().mockReturnValue({ name: 'API易 B站', baseURL: 'https://b.apiyi.com', description: '推荐', authType: 'bearer', isBuiltIn: true }),
    getSiteConfig: vi.fn().mockReturnValue(null),
    currentSiteKey: 'b-apiyi',
    ...overrides,
  }
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      sites: {},
      activeSiteKey: '',
      apiKey: '',
      visionApiKey: '',
      connectionStatus: 'idle',
      saving: false,
      loadError: null,
    })
  })

  describe('loadFromService', () => {
    it('loads sites and current key from api', async () => {
      const api = createMockApi({
        getStoredApiKey: vi.fn().mockImplementation((key) => {
          if (key === 'b-apiyi') return 'stored-key-123'
          return null
        }),
        getStoredVisionApiKey: vi.fn().mockReturnValue('vision-key-456'),
      })

      await useSettingsStore.getState().loadFromService(api)

      const state = useSettingsStore.getState()
      expect(Object.keys(state.sites)).toHaveLength(2)
      expect(state.activeSiteKey).toBe('b-apiyi')
      expect(state.apiKey).toBe('stored-key-123')
      expect(state.visionApiKey).toBe('vision-key-456')
      expect(state.loadError).toBeNull()
    })

    it('falls back to defaultApiKey when no stored key', async () => {
      const api = createMockApi({
        getAllSites: vi.fn().mockReturnValue({
          'demo': { name: 'Demo', baseURL: 'https://demo.com', defaultApiKey: 'default-123', authType: 'bearer' },
        }),
        getStoredApiKey: vi.fn().mockReturnValue(null),
        getCurrentSite: vi.fn().mockReturnValue({ name: 'Demo', baseURL: 'https://demo.com', defaultApiKey: 'default-123', authType: 'bearer' }),
        currentSiteKey: 'demo',
      })

      await useSettingsStore.getState().loadFromService(api)

      expect(useSettingsStore.getState().apiKey).toBe('default-123')
    })

    it('sets loadError on exception', async () => {
      const api = createMockApi({
        getAllSites: vi.fn().mockImplementation(() => { throw new Error('service down') }),
      })

      await useSettingsStore.getState().loadFromService(api)

      expect(useSettingsStore.getState().loadError).toBe('service down')
    })
  })

  describe('switchSite', () => {
    it('updates activeSiteKey and loads key for new site', () => {
      useSettingsStore.setState({
        sites: {
          'a': { name: 'A', baseURL: 'https://a.com', description: '', authType: 'bearer' as const },
          'b': { name: 'B', baseURL: 'https://b.com', description: '', authType: 'bearer' as const },
        },
        activeSiteKey: 'a',
        apiKey: 'key-a',
      })

      const api = createMockApi({
        getStoredApiKey: vi.fn().mockReturnValue('key-b'),
        getSiteConfig: vi.fn().mockReturnValue({ name: 'B', baseURL: 'https://b.com' }),
      })

      useSettingsStore.getState().switchSite('b', api)

      expect(useSettingsStore.getState().activeSiteKey).toBe('b')
      expect(useSettingsStore.getState().apiKey).toBe('key-b')
      expect(api.setSite).toHaveBeenCalledWith('b')
    })
  })

  describe('testConnection', () => {
    it('transitions status idle → testing → success', async () => {
      useSettingsStore.setState({ apiKey: 'test-key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockResolvedValue(true) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(true)
      expect(useSettingsStore.getState().connectionStatus).toBe('success')
      expect(api.testConnection).toHaveBeenCalledWith('test-key')
    })

    it('transitions to error on failure', async () => {
      useSettingsStore.setState({ apiKey: 'bad-key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockResolvedValue(false) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(false)
      expect(useSettingsStore.getState().connectionStatus).toBe('error')
    })

    it('transitions to error on exception', async () => {
      useSettingsStore.setState({ apiKey: 'key', connectionStatus: 'idle' })
      const api = createMockApi({ testConnection: vi.fn().mockRejectedValue(new Error('timeout')) })

      const result = await useSettingsStore.getState().testConnection(api)

      expect(result).toBe(false)
      expect(useSettingsStore.getState().connectionStatus).toBe('error')
    })
  })

  describe('saveAll', () => {
    it('saves apiKey and visionApiKey', async () => {
      useSettingsStore.setState({ apiKey: 'my-key', visionApiKey: 'v-key' })
      const api = createMockApi()

      await useSettingsStore.getState().saveAll(api)

      expect(api.saveApiKey).toHaveBeenCalledWith('my-key')
      expect(api.saveVisionApiKey).toHaveBeenCalledWith('v-key')
      expect(useSettingsStore.getState().saving).toBe(false)
    })

    it('sets saving state during operation', async () => {
      useSettingsStore.setState({ apiKey: 'k', visionApiKey: '' })
      let savingDuringCall = false
      const api = createMockApi({
        saveApiKey: vi.fn().mockImplementation(() => {
          savingDuringCall = useSettingsStore.getState().saving
          return true
        }),
      })

      await useSettingsStore.getState().saveAll(api)

      expect(savingDuringCall).toBe(true)
      expect(useSettingsStore.getState().saving).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/stores/__tests__/useSettingsStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `useSettingsStore.ts`**

Create `src/renderer/src/stores/useSettingsStore.ts`:

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import type { ApiSite } from '../services/api/ApiService'

interface SettingsState {
  sites: Record<string, ApiSite>
  activeSiteKey: string
  apiKey: string
  visionApiKey: string
  connectionStatus: 'idle' | 'testing' | 'success' | 'error'
  saving: boolean
  loadError: string | null

  loadFromService: (api: ApiActions) => Promise<void>
  switchSite: (key: string, api: ApiActions) => void
  setApiKey: (key: string) => void
  setVisionApiKey: (key: string) => void
  testConnection: (api: ApiActions) => Promise<boolean>
  saveAll: (api: ApiActions) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  sites: {},
  activeSiteKey: '',
  apiKey: '',
  visionApiKey: '',
  connectionStatus: 'idle',
  saving: false,
  loadError: null,

  loadFromService: async (api) => {
    try {
      const sites = api.getAllSites()
      const currentKey = api.currentSiteKey

      const storedKey = api.getStoredApiKey(currentKey)
      const currentSite = api.getCurrentSite()
      const apiKey = storedKey || currentSite?.defaultApiKey || ''

      const visionKey = api.getStoredVisionApiKey(currentKey)

      set({
        sites,
        activeSiteKey: currentKey,
        apiKey,
        visionApiKey: visionKey || '',
        connectionStatus: 'idle',
        loadError: null,
      })
    } catch (err) {
      set({ loadError: (err as Error).message })
    }
  },

  switchSite: (key, api) => {
    api.setSite(key)
    const storedKey = api.getStoredApiKey(key)
    const siteConfig = api.getSiteConfig(key)
    set({
      activeSiteKey: key,
      apiKey: storedKey || siteConfig?.defaultApiKey || '',
      connectionStatus: 'idle',
    })
  },

  setApiKey: (key) => set({ apiKey: key }),

  setVisionApiKey: (key) => set({ visionApiKey: key }),

  testConnection: async (api) => {
    set({ connectionStatus: 'testing' })
    try {
      const ok = await api.testConnection(get().apiKey)
      set({ connectionStatus: ok ? 'success' : 'error' })
      return ok
    } catch {
      set({ connectionStatus: 'error' })
      return false
    }
  },

  saveAll: async (api) => {
    set({ saving: true })
    try {
      api.saveApiKey(get().apiKey)
      api.saveVisionApiKey(get().visionApiKey)
    } finally {
      set({ saving: false })
    }
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useSettingsStore.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useSettingsStore.ts src/renderer/src/stores/__tests__/useSettingsStore.test.ts
git commit -m "feat: create useSettingsStore with full test coverage"
```

---

### Task 7: Create SettingsPage sub-components (`SiteGrid`, `ApiKeyInput`)

**Files:**
- Create: `src/renderer/src/pages-react/settings/SiteGrid.tsx`
- Create: `src/renderer/src/pages-react/settings/ApiKeyInput.tsx`

- [ ] **Step 1: Create `SiteGrid.tsx`**

Create `src/renderer/src/pages-react/settings/SiteGrid.tsx`:

```typescript
import type { ApiSite } from '../../services/api/ApiService'

interface SiteGridProps {
  sites: Record<string, ApiSite>
  activeSiteKey: string
  onSelect: (key: string) => void
}

export function SiteGrid({ sites, activeSiteKey, onSelect }: SiteGridProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {Object.entries(sites).map(([key, site]) => {
        const isActive = key === activeSiteKey
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`p-3 border-2 rounded text-left transition-all text-sm ${
              isActive
                ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
                : 'border-zinc-700 bg-zinc-900 text-gray-400 hover:border-zinc-500'
            }`}
          >
            <div className="font-semibold truncate">{site.name}</div>
            {site.description && (
              <div className="text-xs mt-1 opacity-70 truncate">{site.description}</div>
            )}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create `ApiKeyInput.tsx`**

Create `src/renderer/src/pages-react/settings/ApiKeyInput.tsx`:

```typescript
import { useState } from 'react'

interface ApiKeyInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  showToggle?: boolean
}

export function ApiKeyInput({
  value,
  onChange,
  placeholder = '请输入 API Key',
  label,
  showToggle = true,
}: ApiKeyInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-sm font-bold text-white">{label}</label>
      )}
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-3 pr-10 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        {showToggle && (
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-cyberpunk-yellow"
            onClick={() => setVisible(!visible)}
          >
            {visible ? '\u{1F648}' : '\u{1F441}\uFE0F'}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compile**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/settings/
git commit -m "feat: create SiteGrid and ApiKeyInput sub-components"
```

---

### Task 8: Rewrite SettingsPage with store + useApi

**Files:**
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`

- [ ] **Step 1: Replace SettingsPage content**

Replace the entire content of `src/renderer/src/pages-react/SettingsPage.tsx` with:

```typescript
import { useEffect } from 'react'
import { useToastStore } from '../stores'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useApi } from '../hooks/useService'
import { SiteGrid } from './settings/SiteGrid'
import { ApiKeyInput } from './settings/ApiKeyInput'

export default function SettingsPage() {
  const api = useApi()
  const addToast = useToastStore((s) => s.addToast)

  const sites = useSettingsStore((s) => s.sites)
  const activeSiteKey = useSettingsStore((s) => s.activeSiteKey)
  const apiKey = useSettingsStore((s) => s.apiKey)
  const visionApiKey = useSettingsStore((s) => s.visionApiKey)
  const connectionStatus = useSettingsStore((s) => s.connectionStatus)
  const saving = useSettingsStore((s) => s.saving)

  const { switchSite, setApiKey, setVisionApiKey, testConnection, saveAll, loadFromService } =
    useSettingsStore.getState()

  useEffect(() => {
    loadFromService(api)
  }, [])

  const handleTest = async () => {
    if (!apiKey.trim()) {
      addToast({ message: '请先输入 API Key', type: 'warning' })
      return
    }
    const ok = await testConnection(api)
    addToast({
      message: ok ? '连接成功!' : '连接失败',
      type: ok ? 'success' : 'error',
    })
  }

  const handleSave = async () => {
    try {
      await saveAll(api)
      addToast({ message: '配置已保存', type: 'success' })
    } catch {
      addToast({ message: '保存失败', type: 'error' })
    }
  }

  const isTesting = connectionStatus === 'testing'

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow flex items-center gap-2">
        <span>{'\u2699\uFE0F'}</span> API 设置
      </h1>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            1
          </span>
          <span className="font-bold text-white uppercase tracking-tight">选择 API 站点</span>
        </div>
        <SiteGrid
          sites={sites}
          activeSiteKey={activeSiteKey}
          onSelect={(key) => switchSite(key, api)}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            2
          </span>
          <span className="font-bold text-white uppercase tracking-tight">输入 API Key</span>
        </div>
        <ApiKeyInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="请输入您的图片生成 API Key"
        />
      </section>

      <section className="space-y-3">
        <ApiKeyInput
          value={visionApiKey}
          onChange={setVisionApiKey}
          label="图像理解 API Key（可选）"
          placeholder="请输入您的图像理解 API Key（可选）"
          showToggle={false}
        />
        <p className="text-xs text-zinc-500">用于图像理解功能，可选填</p>
      </section>

      <div className="flex gap-3 pt-2">
        <button
          onClick={handleTest}
          disabled={isTesting}
          className="flex-1 py-2.5 px-4 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white font-bold uppercase tracking-tight transition-colors disabled:opacity-50"
        >
          {isTesting ? '测试中...' : '\u{1F50C} 测试连接'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2.5 px-4 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold uppercase tracking-tight transition-all disabled:opacity-50"
        >
          {saving ? '保存中...' : '\u2705 保存配置'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compile**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors from SettingsPage

- [ ] **Step 3: Verify no `window as any` remains in SettingsPage**

Run: `rg "window as any" src/renderer/src/pages-react/SettingsPage.tsx`
Expected: No results — zero occurrences

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/SettingsPage.tsx
git commit -m "feat: rewrite SettingsPage with useSettingsStore + useApi, eliminate window.aiImageAPI"
```

---

### Task 9: Export `useSettingsStore` from stores barrel + final verification

**Files:**
- Modify: `src/renderer/src/stores/index.ts` (if barrel exists, add export)

- [ ] **Step 1: Check if stores barrel file exists and update**

If `src/renderer/src/stores/index.ts` exists, add:

```typescript
export { useSettingsStore } from './useSettingsStore'
```

If no barrel exists, skip this step — the direct import path used in SettingsPage already works.

- [ ] **Step 2: Run all store tests**

Run: `npx vitest run src/renderer/src/stores/__tests__/`
Expected: All tests PASS

- [ ] **Step 3: Run full TypeScript compile**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

- [ ] **Step 4: Verify success criteria**

Run these checks:

```bash
# No window.aiImageAPI in SettingsPage
rg "window as any" src/renderer/src/pages-react/SettingsPage.tsx

# useApi hook exists
rg "export function useApi" src/renderer/src/hooks/useService.ts

# subscribeWithSelector in tab store
rg "subscribeWithSelector" src/renderer/src/stores/useTabStore.ts

# crypto.randomUUID in toast store
rg "crypto.randomUUID" src/renderer/src/stores/useToastStore.ts

# darkSelectStyles shared
rg "darkSelectStyles" src/renderer/src/styles/selectTheme.ts

# useSettingsStore exists
rg "export const useSettingsStore" src/renderer/src/stores/useSettingsStore.ts
```

Expected: All checks return matches (except the first, which should return 0 results).

- [ ] **Step 5: Commit verification snapshot**

```bash
git add -A
git status
git commit -m "chore: final verification - all success criteria met"
```

---

### Task 10: Write Migration Playbook

**Files:**
- Create: `docs/superpowers/references/page-migration-playbook.md`

- [ ] **Step 1: Create the playbook document**

Create `docs/superpowers/references/page-migration-playbook.md`:

```markdown
# Page Migration Playbook

> Patterns extracted from SettingsPage migration (2026-04-18). Use this as a template for migrating remaining React pages to full feature parity.

## 1. Store Creation Template

Each page gets its own Zustand store in `src/renderer/src/stores/use<Page>Store.ts`.

**Interface pattern:**

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

interface <Page>State {
  // UI state fields
  loading: boolean

  // Actions — receive api as parameter for testability
  loadFromService: (api: ApiActions) => Promise<void>
  // ... page-specific actions
}

export const use<Page>Store = create<<Page>State>((set, get) => ({
  // ... state + actions
}))
```

**Key rules:**
- Actions receive `ApiActions` as a parameter — never call React hooks inside actions
- Use atomic selectors in components: `const field = useStore(s => s.field)`
- Async actions must handle loading/error states explicitly
- No `persist` middleware unless the page has data not already in Electron Store

## 2. Service Hook Usage

- Use `useApi()` as the single entry point for all API calls
- Import from `../hooks/useService`
- Never use `(window as any).aiImageAPI` — this is a hard rule
- For non-API services (storage, i18n), use the existing typed hooks

## 3. Component Split Standards

- Page file ≤ 200 lines
- Extract sub-components into `pages-react/<page-name>/` directory
- Sub-components receive data via props, not direct store access
- Shared UI components go in `components/`

## 4. Testing Three-Piece Set

Every migrated page needs:

1. **Store unit test** (`stores/__tests__/use<Page>Store.test.ts`)
   - Mock `ApiActions` interface
   - Test all actions including error paths
   - Use `store.getState()` and `store.setState()` for setup/assertion

2. **Component test** (`pages-react/__tests__/<Page>Page.test.tsx`)
   - Use `@testing-library/react` + `@testing-library/user-event`
   - Test rendering, interactions, disabled states

3. **Integration test** (within component test file)
   - Full user flow: action → store update → UI update

## 5. Completion Checklist

Before declaring a page migration complete:

- [ ] Zero `(window as any)` usage in page and sub-components
- [ ] Page store created with full TypeScript interfaces
- [ ] All store actions have unit tests
- [ ] Component renders with test data
- [ ] Feature parity table verified against old code
- [ ] TypeScript compiles with no errors
- [ ] Old code NOT deleted (rollback safety)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/references/page-migration-playbook.md
git commit -m "docs: create page migration playbook based on SettingsPage patterns"
```

---

## Summary

| Task | Description | Files | Estimated |
|------|-------------|-------|-----------|
| 1 | Add `testConnection` to ApiService | 2 | 3 min |
| 2 | Create typed `useApi()` facade | 1 | 3 min |
| 3 | Create shared `darkSelectStyles` | 2 | 3 min |
| 4 | Fix `useTabStore` + subscribeWithSelector | 2 | 3 min |
| 5 | Fix toast ID + hash sync in AppLayout | 2 | 3 min |
| 6 | Create `useSettingsStore` with tests | 2 | 5 min |
| 7 | Create sub-components (SiteGrid, ApiKeyInput) | 2 | 3 min |
| 8 | Rewrite SettingsPage | 1 | 3 min |
| 9 | Barrel export + final verification | 1 | 2 min |
| 10 | Migration Playbook document | 1 | 3 min |
