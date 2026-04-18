# Batch Page Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining 6 React pages from broken `(window as any).aiImageAPI` calls to typed Zustand stores + hooks architecture.

**Architecture:** Each page gets an independent Zustand store with typed state and actions. API calls go through `useApi()`, localStorage data through `useHistory()`/`useTemplates()`. Stores receive service instances as parameters (no direct hook calls in stores). Pages > 200 lines get sub-components extracted.

**Tech Stack:** React 19.2.5, Zustand 5.0.12, TypeScript 6.0.2, Vitest

**Spec:** `docs/superpowers/specs/2026-04-18-batch-page-migration-design.md`

---

## File Structure

### New files to create:
| File | Responsibility |
|------|---------------|
| `src/renderer/src/hooks/useHistory.ts` | localStorage CRUD for history data |
| `src/renderer/src/hooks/useTemplates.ts` | localStorage read for prompt templates |
| `src/renderer/src/hooks/__tests__/useHistory.test.ts` | useHistory unit tests |
| `src/renderer/src/hooks/__tests__/useTemplates.test.ts` | useTemplates unit tests |
| `src/renderer/src/stores/useGenerateStore.ts` | GeneratePage state + actions |
| `src/renderer/src/stores/useBatchStore.ts` | BatchPage state + actions |
| `src/renderer/src/stores/useCompareStore.ts` | ComparePage state + actions |
| `src/renderer/src/stores/useHistoryStore.ts` | HistoryPage state + actions |
| `src/renderer/src/stores/useUnderstandStore.ts` | UnderstandPage state + actions |
| `src/renderer/src/stores/useTemplatesStore.ts` | PromptTemplatesPage state + actions |
| `src/renderer/src/stores/__tests__/useGenerateStore.test.ts` | GenerateStore unit tests |
| `src/renderer/src/stores/__tests__/useBatchStore.test.ts` | BatchStore unit tests |
| `src/renderer/src/stores/__tests__/useCompareStore.test.ts` | CompareStore unit tests |
| `src/renderer/src/stores/__tests__/useHistoryStore.test.ts` | HistoryStore unit tests |
| `src/renderer/src/stores/__tests__/useUnderstandStore.test.ts` | UnderstandStore unit tests |
| `src/renderer/src/stores/__tests__/useTemplatesStore.test.ts` | TemplatesStore unit tests |
| `src/renderer/src/pages-react/generate/RatioSelector.tsx` | Ratio button group sub-component |
| `src/renderer/src/pages-react/generate/ReferenceImageList.tsx` | Reference images sub-component |
| `src/renderer/src/pages-react/generate/ResultGrid.tsx` | Result images grid sub-component |
| `src/renderer/src/pages-react/batch/BatchItemRow.tsx` | Single batch task row sub-component |
| `src/renderer/src/pages-react/batch/BulkAddPanel.tsx` | Bulk import textarea sub-component |
| `src/renderer/src/pages-react/compare/ModelPairSelector.tsx` | Dual model selector sub-component |

### Files to modify:
| File | Change |
|------|--------|
| `src/renderer/src/hooks/useService.ts` | Add `understandImage` to `ApiActions` + `useApi()` |
| `src/renderer/src/stores/index.ts` | Export all 6 new stores + public types |
| `src/renderer/src/pages-react/GeneratePage.tsx` | Rewrite to use store + sub-components |
| `src/renderer/src/pages-react/BatchPage.tsx` | Rewrite to use store + sub-components |
| `src/renderer/src/pages-react/ComparePage.tsx` | Rewrite to use store + sub-components |
| `src/renderer/src/pages-react/HistoryPage.tsx` | Rewrite to use store + useHistory() |
| `src/renderer/src/pages-react/UnderstandPage.tsx` | Rewrite to use store + useApi() |
| `src/renderer/src/pages-react/PromptTemplatesPage.tsx` | Rewrite to use store + useTemplates() |

---

### Task 1: Extend `useApi()` with `understandImage`

**Files:**
- Modify: `src/renderer/src/hooks/useService.ts:56-85`

- [ ] **Step 1: Add `understandImage` to `ApiActions` interface**

In `src/renderer/src/hooks/useService.ts`, add the import and interface member:

```typescript
import type { ApiService, ApiSite, GenerateImageParams, GenerateResult, VisionParams, VisionResult } from '../services/api'
```

Add to the `ApiActions` interface (after the `generateImage` line):

```typescript
export interface ApiActions {
  generateImage(params: GenerateImageParams): Promise<GenerateResult>
  understandImage(params: VisionParams): Promise<VisionResult>
  testConnection(apiKey: string): Promise<boolean>
  // ... rest unchanged
}
```

- [ ] **Step 2: Add delegation in `useApi()` function body**

In the `useApi()` return object, add after the `generateImage` line:

```typescript
export function useApi(): ApiActions {
  const api = useApiService()
  return {
    generateImage: (p) => api.generateImage(p),
    understandImage: (p) => api.understandImage(p),
    testConnection: (k) => api.testConnection(k),
    // ... rest unchanged
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors related to `understandImage`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/hooks/useService.ts
git commit -m "feat: add understandImage to ApiActions and useApi()"
```

---

### Task 2: Create `useHistory()` hook + tests

**Files:**
- Create: `src/renderer/src/hooks/useHistory.ts`
- Create: `src/renderer/src/hooks/__tests__/useHistory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/hooks/__tests__/useHistory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useHistory } from '../useHistory'
import type { HistoryItem } from '../useHistory'

const STORAGE_KEY = 'image_history'

describe('useHistory', () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => { mockStorage[key] = val })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => { delete mockStorage[key] })
  })

  it('getAll returns empty array when no data', () => {
    const history = useHistory()
    expect(history.getAll()).toEqual([])
  })

  it('getAll returns parsed items from localStorage', () => {
    const items: HistoryItem[] = [
      { id: 1, type: 'generate', prompt: 'test', urls: ['http://a.jpg'], timestamp: '2026-01-01' },
    ]
    mockStorage[STORAGE_KEY] = JSON.stringify(items)

    const history = useHistory()
    expect(history.getAll()).toEqual(items)
  })

  it('add creates item with auto-incremented id', () => {
    const history = useHistory()
    const item = history.add({ type: 'generate', prompt: 'hello', urls: ['http://b.jpg'], timestamp: '2026-01-02' })

    expect(item.id).toBe(1)
    expect(item.prompt).toBe('hello')

    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(1)
  })

  it('add auto-increments from existing max id', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 5, type: 'generate', prompt: 'old', urls: [], timestamp: '2026-01-01' },
    ])

    const history = useHistory()
    const item = history.add({ type: 'generate', prompt: 'new', urls: [], timestamp: '2026-01-03' })

    expect(item.id).toBe(6)
  })

  it('remove deletes item by id and returns true', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 1, type: 'generate', prompt: 'a', urls: [], timestamp: '2026-01-01' },
      { id: 2, type: 'generate', prompt: 'b', urls: [], timestamp: '2026-01-02' },
    ])

    const history = useHistory()
    const result = history.remove(1)

    expect(result).toBe(true)
    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(2)
  })

  it('remove returns false for non-existent id', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([])
    const history = useHistory()
    expect(history.remove(999)).toBe(false)
  })

  it('clear empties all history', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 1, type: 'generate', prompt: 'a', urls: [], timestamp: '2026-01-01' },
    ])

    const history = useHistory()
    history.clear()

    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toEqual([])
  })

  it('getAll returns empty array on malformed JSON', () => {
    mockStorage[STORAGE_KEY] = 'not-json'
    const history = useHistory()
    expect(history.getAll()).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/hooks/__tests__/useHistory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useHistory` hook**

Create `src/renderer/src/hooks/useHistory.ts`:

```typescript
const STORAGE_KEY = 'image_history'

export interface HistoryItem {
  id: number
  type: string
  prompt: string
  urls: string[]
  timestamp: string
  model?: string
}

export interface HistoryActions {
  getAll(): HistoryItem[]
  remove(id: number): boolean
  add(item: Omit<HistoryItem, 'id'>): HistoryItem
  clear(): void
}

function readItems(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeItems(items: HistoryItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function useHistory(): HistoryActions {
  return {
    getAll(): HistoryItem[] {
      return readItems()
    },

    add(item: Omit<HistoryItem, 'id'>): HistoryItem {
      const items = readItems()
      const maxId = items.reduce((max, i) => Math.max(max, i.id), 0)
      const newItem: HistoryItem = { ...item, id: maxId + 1 }
      writeItems([...items, newItem])
      return newItem
    },

    remove(id: number): boolean {
      const items = readItems()
      const filtered = items.filter((i) => i.id !== id)
      if (filtered.length === items.length) return false
      writeItems(filtered)
      return true
    },

    clear(): void {
      writeItems([])
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/hooks/__tests__/useHistory.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useHistory.ts src/renderer/src/hooks/__tests__/useHistory.test.ts
git commit -m "feat: add useHistory hook with localStorage CRUD + tests"
```

---

### Task 3: Create `useTemplates()` hook + tests

**Files:**
- Create: `src/renderer/src/hooks/useTemplates.ts`
- Create: `src/renderer/src/hooks/__tests__/useTemplates.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/hooks/__tests__/useTemplates.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTemplates } from '../useTemplates'
import type { Template } from '../useTemplates'

const STORAGE_KEY = 'prompt_templates'

describe('useTemplates', () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null)
  })

  it('getAll returns empty array when no data', () => {
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })

  it('getAll returns parsed templates from localStorage', () => {
    const data: Template[] = [
      { id: '1', name: 'Landscape', prompt: 'beautiful landscape', category: 'nature', tags: ['scenic'] },
      { id: '2', name: 'Portrait', prompt: 'professional portrait', category: 'people' },
    ]
    mockStorage[STORAGE_KEY] = JSON.stringify(data)

    const templates = useTemplates()
    expect(templates.getAll()).toEqual(data)
  })

  it('getAll returns empty array on malformed JSON', () => {
    mockStorage[STORAGE_KEY] = '{broken'
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })

  it('getAll returns empty array when value is not an array', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify({ not: 'array' })
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/hooks/__tests__/useTemplates.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useTemplates` hook**

Create `src/renderer/src/hooks/useTemplates.ts`:

```typescript
const STORAGE_KEY = 'prompt_templates'

export interface Template {
  id: string
  name: string
  prompt: string
  category: string
  tags?: string[]
}

export interface TemplateActions {
  getAll(): Template[]
}

export function useTemplates(): TemplateActions {
  return {
    getAll(): Template[] {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/hooks/__tests__/useTemplates.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useTemplates.ts src/renderer/src/hooks/__tests__/useTemplates.test.ts
git commit -m "feat: add useTemplates hook with localStorage read + tests"
```

---

### Task 4: Create `useGenerateStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useGenerateStore.ts`
- Create: `src/renderer/src/stores/__tests__/useGenerateStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useGenerateStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGenerateStore, initialState } from '../useGenerateStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn(),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  }
}

describe('useGenerateStore', () => {
  beforeEach(() => {
    useGenerateStore.setState(initialState, true)
  })

  it('has correct initial state', () => {
    const state = useGenerateStore.getState()
    expect(state.prompt).toBe('')
    expect(state.ratio).toBe('1:1')
    expect(state.generating).toBe(false)
    expect(state.resultUrls).toEqual([])
    expect(state.referenceImages).toEqual([])
    expect(state.error).toBeNull()
  })

  it('setPrompt updates prompt', () => {
    useGenerateStore.getState().setPrompt('a cat')
    expect(useGenerateStore.getState().prompt).toBe('a cat')
  })

  it('setRatio updates ratio', () => {
    useGenerateStore.getState().setRatio('16:9')
    expect(useGenerateStore.getState().ratio).toBe('16:9')
  })

  it('addReferenceImage appends to list', () => {
    useGenerateStore.getState().addReferenceImage('data:image/png;base64,abc')
    useGenerateStore.getState().addReferenceImage('data:image/png;base64,def')
    expect(useGenerateStore.getState().referenceImages).toHaveLength(2)
  })

  it('removeReferenceImage removes by index', () => {
    useGenerateStore.setState({ referenceImages: ['a', 'b', 'c'] })
    useGenerateStore.getState().removeReferenceImage(1)
    expect(useGenerateStore.getState().referenceImages).toEqual(['a', 'c'])
  })

  it('clearResults resets resultUrls and error', () => {
    useGenerateStore.setState({ resultUrls: ['http://x.jpg'], error: 'old' })
    useGenerateStore.getState().clearResults()
    expect(useGenerateStore.getState().resultUrls).toEqual([])
    expect(useGenerateStore.getState().error).toBeNull()
  })

  describe('generate', () => {
    it('sets generating=true then false, stores result urls', async () => {
      useGenerateStore.setState({ prompt: 'sunset', ratio: '16:9' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://a.jpg', 'http://b.jpg'] }),
      })

      let generatingDuringCall = false
      const origGenerate = api.generateImage as ReturnType<typeof vi.fn>
      origGenerate.mockImplementation(async (p: any) => {
        generatingDuringCall = useGenerateStore.getState().generating
        return { success: true, urls: ['http://a.jpg', 'http://b.jpg'] }
      })

      await useGenerateStore.getState().generate(api, 'flux-1')

      expect(generatingDuringCall).toBe(true)
      expect(useGenerateStore.getState().generating).toBe(false)
      expect(useGenerateStore.getState().resultUrls).toEqual(['http://a.jpg', 'http://b.jpg'])
      expect(useGenerateStore.getState().error).toBeNull()
      expect(api.generateImage).toHaveBeenCalledWith({
        prompt: 'sunset',
        ratio: '16:9',
        model: 'flux-1',
        referenceImages: undefined,
      })
    })

    it('falls back to result.images when urls is missing', async () => {
      useGenerateStore.setState({ prompt: 'test' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true, images: ['http://img.jpg'] }),
      })

      await useGenerateStore.getState().generate(api, 'model-1')

      expect(useGenerateStore.getState().resultUrls).toEqual(['http://img.jpg'])
    })

    it('sets error on failure', async () => {
      useGenerateStore.setState({ prompt: 'fail' })
      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue(new Error('API down')),
      })

      await useGenerateStore.getState().generate(api, 'model-1')

      expect(useGenerateStore.getState().generating).toBe(false)
      expect(useGenerateStore.getState().error).toBe('API down')
      expect(useGenerateStore.getState().resultUrls).toEqual([])
    })

    it('sets error for non-Error exceptions', async () => {
      useGenerateStore.setState({ prompt: 'fail' })
      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue('string error'),
      })

      await useGenerateStore.getState().generate(api, 'model-1')

      expect(useGenerateStore.getState().error).toBe('string error')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useGenerateStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useGenerateStore`**

Create `src/renderer/src/stores/useGenerateStore.ts`:

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface GenerateState {
  prompt: string
  ratio: string
  generating: boolean
  resultUrls: string[]
  referenceImages: string[]
  error: string | null

  setPrompt: (v: string) => void
  setRatio: (v: string) => void
  addReferenceImage: (dataUrl: string) => void
  removeReferenceImage: (index: number) => void
  clearResults: () => void
  generate: (api: ApiActions, modelKey: string) => Promise<void>
}

export const initialState = {
  prompt: '',
  ratio: '1:1',
  generating: false,
  resultUrls: [] as string[],
  referenceImages: [] as string[],
  error: null as string | null,
}

export const useGenerateStore = create<GenerateState>((set, get) => ({
  ...initialState,

  setPrompt: (v) => set({ prompt: v }),
  setRatio: (v) => set({ ratio: v }),
  addReferenceImage: (dataUrl) => set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReferenceImage: (index) => set((s) => ({
    referenceImages: s.referenceImages.filter((_, i) => i !== index),
  })),
  clearResults: () => set({ resultUrls: [], error: null }),

  generate: async (api, modelKey) => {
    set({ generating: true, error: null, resultUrls: [] })
    try {
      const { prompt, ratio, referenceImages } = get()
      const result = await api.generateImage({
        prompt,
        ratio,
        model: modelKey,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      })
      const urls = result.urls ?? result.images ?? []
      set({ resultUrls: urls, generating: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), generating: false })
    }
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useGenerateStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useGenerateStore.ts src/renderer/src/stores/__tests__/useGenerateStore.test.ts
git commit -m "feat: add useGenerateStore with generate action + tests"
```

---

### Task 5: Create `useBatchStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useBatchStore.ts`
- Create: `src/renderer/src/stores/__tests__/useBatchStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useBatchStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBatchStore, initialState } from '../useBatchStore'
import type { BatchItem } from '../useBatchStore'
import type { ApiActions } from '../../hooks/useService'

vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('uuid-1') })

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn(),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  }
}

describe('useBatchStore', () => {
  let uuidCounter: number

  beforeEach(() => {
    useBatchStore.setState(initialState, true)
    uuidCounter = 0
    ;(crypto.randomUUID as ReturnType<typeof vi.fn>).mockImplementation(() => `uuid-${++uuidCounter}`)
  })

  it('has correct initial state', () => {
    const s = useBatchStore.getState()
    expect(s.items).toEqual([])
    expect(s.running).toBe(false)
  })

  it('addItem appends a pending item with UUID', () => {
    useBatchStore.getState().addItem('test prompt')
    const items = useBatchStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({ id: 'uuid-1', prompt: 'test prompt', status: 'pending' })
  })

  it('removeItem removes by id', () => {
    useBatchStore.getState().addItem('a')
    useBatchStore.getState().addItem('b')
    useBatchStore.getState().removeItem('uuid-1')
    expect(useBatchStore.getState().items).toHaveLength(1)
    expect(useBatchStore.getState().items[0].id).toBe('uuid-2')
  })

  it('bulkAdd splits text by newlines and adds pending items', () => {
    useBatchStore.getState().bulkAdd('line one\nline two\n\nline three')
    expect(useBatchStore.getState().items).toHaveLength(3)
    expect(useBatchStore.getState().items[0].prompt).toBe('line one')
    expect(useBatchStore.getState().items[2].prompt).toBe('line three')
  })

  it('clearAll empties items', () => {
    useBatchStore.getState().addItem('x')
    useBatchStore.getState().clearAll()
    expect(useBatchStore.getState().items).toEqual([])
  })

  describe('runBatch', () => {
    it('processes pending items sequentially', async () => {
      useBatchStore.getState().addItem('prompt-a')
      useBatchStore.getState().addItem('prompt-b')

      const callOrder: string[] = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(async (p: any) => {
          callOrder.push(p.prompt)
          return { success: true, urls: [`http://${p.prompt}.jpg`] }
        }),
      })

      await useBatchStore.getState().runBatch(api, 'model-1')

      expect(callOrder).toEqual(['prompt-a', 'prompt-b'])
      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[0].resultUrl).toBe('http://prompt-a.jpg')
      expect(items[1].status).toBe('done')
      expect(useBatchStore.getState().running).toBe(false)
    })

    it('marks failed items as error without stopping batch', async () => {
      useBatchStore.getState().addItem('good')
      useBatchStore.getState().addItem('bad')
      useBatchStore.getState().addItem('also-good')

      let callCount = 0
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 2) throw new Error('fail')
          return { success: true, urls: ['http://ok.jpg'] }
        }),
      })

      await useBatchStore.getState().runBatch(api, 'model-1')

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[1].status).toBe('error')
      expect(items[1].error).toBe('fail')
      expect(items[2].status).toBe('done')
    })

    it('skips non-pending items', async () => {
      useBatchStore.setState({
        items: [
          { id: 'a', prompt: 'done-one', status: 'done', resultUrl: 'http://x.jpg' },
          { id: 'b', prompt: 'pending-one', status: 'pending' },
        ],
      })
      const api = createMockApi()

      await useBatchStore.getState().runBatch(api, 'model-1')

      expect(api.generateImage).toHaveBeenCalledTimes(1)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useBatchStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useBatchStore`**

Create `src/renderer/src/stores/useBatchStore.ts`:

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface BatchItem {
  id: string
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  resultUrl?: string
  error?: string
}

export interface BatchState {
  items: BatchItem[]
  running: boolean

  addItem: (prompt: string) => void
  removeItem: (id: string) => void
  bulkAdd: (text: string) => void
  clearAll: () => void
  runBatch: (api: ApiActions, modelKey: string) => Promise<void>
}

export const initialState = {
  items: [] as BatchItem[],
  running: false,
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...initialState,

  addItem: (prompt) => set((s) => ({
    items: [...s.items, { id: crypto.randomUUID(), prompt, status: 'pending' }],
  })),

  removeItem: (id) => set((s) => ({
    items: s.items.filter((i) => i.id !== id),
  })),

  bulkAdd: (text) => {
    const lines = text.split('\n').filter((l) => l.trim())
    const newItems: BatchItem[] = lines.map((line) => ({
      id: crypto.randomUUID(),
      prompt: line.trim(),
      status: 'pending',
    }))
    set((s) => ({ items: [...s.items, ...newItems] }))
  },

  clearAll: () => set({ items: [] }),

  runBatch: async (api, modelKey) => {
    const pending = get().items.filter((i) => i.status === 'pending')
    if (pending.length === 0) return

    set({ running: true })

    for (const item of pending) {
      set((state) => ({
        items: state.items.map((i) =>
          i.id === item.id ? { ...i, status: 'generating' as const } : i
        ),
      }))

      try {
        const result = await api.generateImage({ prompt: item.prompt, model: modelKey })
        const url = result.urls?.[0] ?? result.images?.[0]
        set((state) => ({
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, status: 'done' as const, resultUrl: url } : i
          ),
        }))
      } catch (err) {
        set((state) => ({
          items: state.items.map((i) =>
            i.id === item.id
              ? { ...i, status: 'error' as const, error: err instanceof Error ? err.message : String(err) }
              : i
          ),
        }))
      }
    }

    set({ running: false })
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useBatchStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useBatchStore.ts src/renderer/src/stores/__tests__/useBatchStore.test.ts
git commit -m "feat: add useBatchStore with sequential runBatch + tests"
```

---

### Task 6: Create `useCompareStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useCompareStore.ts`
- Create: `src/renderer/src/stores/__tests__/useCompareStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useCompareStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCompareStore, initialState } from '../useCompareStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn(),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  }
}

describe('useCompareStore', () => {
  beforeEach(() => {
    useCompareStore.setState(initialState, true)
  })

  it('has correct initial state', () => {
    const s = useCompareStore.getState()
    expect(s.leftModelKey).toBeNull()
    expect(s.rightModelKey).toBeNull()
    expect(s.prompt).toBe('')
    expect(s.comparing).toBe(false)
    expect(s.leftResult).toBeNull()
    expect(s.rightResult).toBeNull()
    expect(s.error).toBeNull()
  })

  it('setLeftModel updates leftModelKey', () => {
    useCompareStore.getState().setLeftModel('flux-1')
    expect(useCompareStore.getState().leftModelKey).toBe('flux-1')
  })

  it('setRightModel updates rightModelKey', () => {
    useCompareStore.getState().setRightModel('dall-e')
    expect(useCompareStore.getState().rightModelKey).toBe('dall-e')
  })

  it('setPrompt updates prompt', () => {
    useCompareStore.getState().setPrompt('a sunset')
    expect(useCompareStore.getState().prompt).toBe('a sunset')
  })

  describe('compare', () => {
    it('calls generateImage twice with different models via Promise.allSettled', async () => {
      useCompareStore.setState({ leftModelKey: 'model-a', rightModelKey: 'model-b', prompt: 'test' })
      const api = createMockApi({
        generateImage: vi.fn()
          .mockResolvedValueOnce({ success: true, urls: ['http://left.jpg'] })
          .mockResolvedValueOnce({ success: true, urls: ['http://right.jpg'] }),
      })

      await useCompareStore.getState().compare(api)

      expect(api.generateImage).toHaveBeenCalledTimes(2)
      expect(api.generateImage).toHaveBeenCalledWith({ model: 'model-a', prompt: 'test' })
      expect(api.generateImage).toHaveBeenCalledWith({ model: 'model-b', prompt: 'test' })
      expect(useCompareStore.getState().leftResult).toBe('http://left.jpg')
      expect(useCompareStore.getState().rightResult).toBe('http://right.jpg')
      expect(useCompareStore.getState().comparing).toBe(false)
      expect(useCompareStore.getState().error).toBeNull()
    })

    it('handles partial failure — left succeeds, right fails', async () => {
      useCompareStore.setState({ leftModelKey: 'a', rightModelKey: 'b', prompt: 'test' })
      const api = createMockApi({
        generateImage: vi.fn()
          .mockResolvedValueOnce({ success: true, urls: ['http://left.jpg'] })
          .mockRejectedValueOnce(new Error('right failed')),
      })

      await useCompareStore.getState().compare(api)

      expect(useCompareStore.getState().leftResult).toBe('http://left.jpg')
      expect(useCompareStore.getState().rightResult).toBeNull()
      expect(useCompareStore.getState().comparing).toBe(false)
    })

    it('handles both failing', async () => {
      useCompareStore.setState({ leftModelKey: 'a', rightModelKey: 'b', prompt: 'test' })
      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue(new Error('down')),
      })

      await useCompareStore.getState().compare(api)

      expect(useCompareStore.getState().leftResult).toBeNull()
      expect(useCompareStore.getState().rightResult).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useCompareStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useCompareStore`**

Create `src/renderer/src/stores/useCompareStore.ts`:

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface CompareState {
  leftModelKey: string | null
  rightModelKey: string | null
  prompt: string
  comparing: boolean
  leftResult: string | null
  rightResult: string | null
  error: string | null

  setLeftModel: (key: string | null) => void
  setRightModel: (key: string | null) => void
  setPrompt: (v: string) => void
  compare: (api: ApiActions) => Promise<void>
}

export const initialState = {
  leftModelKey: null as string | null,
  rightModelKey: null as string | null,
  prompt: '',
  comparing: false,
  leftResult: null as string | null,
  rightResult: null as string | null,
  error: null as string | null,
}

export const useCompareStore = create<CompareState>((set, get) => ({
  ...initialState,

  setLeftModel: (key) => set({ leftModelKey: key }),
  setRightModel: (key) => set({ rightModelKey: key }),
  setPrompt: (v) => set({ prompt: v }),

  compare: async (api) => {
    const { leftModelKey, rightModelKey, prompt } = get()
    set({ comparing: true, leftResult: null, rightResult: null, error: null })

    const [leftSettled, rightSettled] = await Promise.allSettled([
      api.generateImage({ model: leftModelKey!, prompt }),
      api.generateImage({ model: rightModelKey!, prompt }),
    ])

    const leftUrl = leftSettled.status === 'fulfilled'
      ? (leftSettled.value.urls?.[0] ?? leftSettled.value.images?.[0] ?? null)
      : null
    const rightUrl = rightSettled.status === 'fulfilled'
      ? (rightSettled.value.urls?.[0] ?? rightSettled.value.images?.[0] ?? null)
      : null

    set({ leftResult: leftUrl, rightResult: rightUrl, comparing: false })
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useCompareStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useCompareStore.ts src/renderer/src/stores/__tests__/useCompareStore.test.ts
git commit -m "feat: add useCompareStore with Promise.allSettled compare + tests"
```

---

### Task 7: Create `useHistoryStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useHistoryStore.ts`
- Create: `src/renderer/src/stores/__tests__/useHistoryStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useHistoryStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useHistoryStore, initialState } from '../useHistoryStore'
import type { HistoryActions, HistoryItem } from '../../hooks/useHistory'

function createMockHistory(items: HistoryItem[] = []): HistoryActions {
  let data = [...items]
  return {
    getAll: vi.fn(() => data),
    add: vi.fn((item) => {
      const newItem = { ...item, id: data.length + 1 } as HistoryItem
      data.push(newItem)
      return newItem
    }),
    remove: vi.fn((id: number) => {
      const before = data.length
      data = data.filter((i) => i.id !== id)
      return data.length < before
    }),
    clear: vi.fn(() => { data = [] }),
  }
}

describe('useHistoryStore', () => {
  beforeEach(() => {
    useHistoryStore.setState(initialState, true)
  })

  it('has correct initial state', () => {
    const s = useHistoryStore.getState()
    expect(s.items).toEqual([])
    expect(s.searchQuery).toBe('')
    expect(s.error).toBeNull()
  })

  it('setSearchQuery updates searchQuery', () => {
    useHistoryStore.getState().setSearchQuery('sunset')
    expect(useHistoryStore.getState().searchQuery).toBe('sunset')
  })

  it('loadHistory populates items from HistoryActions', () => {
    const items: HistoryItem[] = [
      { id: 1, type: 'generate', prompt: 'hello', urls: [], timestamp: '2026-01-01' },
      { id: 2, type: 'generate', prompt: 'world', urls: [], timestamp: '2026-01-02' },
    ]
    const history = createMockHistory(items)

    useHistoryStore.getState().loadHistory(history)

    expect(useHistoryStore.getState().items).toEqual(items)
    expect(history.getAll).toHaveBeenCalled()
  })

  it('deleteItem removes item and updates store', () => {
    const items: HistoryItem[] = [
      { id: 1, type: 'generate', prompt: 'a', urls: [], timestamp: '2026-01-01' },
      { id: 2, type: 'generate', prompt: 'b', urls: [], timestamp: '2026-01-02' },
    ]
    useHistoryStore.setState({ items })
    const history = createMockHistory(items)

    useHistoryStore.getState().deleteItem(1, history)

    expect(history.remove).toHaveBeenCalledWith(1)
    expect(useHistoryStore.getState().items).toHaveLength(1)
    expect(useHistoryStore.getState().items[0].id).toBe(2)
  })

  it('deleteItem sets error when remove fails', () => {
    useHistoryStore.setState({ items: [{ id: 1, type: 'g', prompt: 'x', urls: [], timestamp: '' }] })
    const history = createMockHistory()
    ;(history.remove as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('disk full') })

    useHistoryStore.getState().deleteItem(1, history)

    expect(useHistoryStore.getState().error).toBe('disk full')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useHistoryStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useHistoryStore`**

Create `src/renderer/src/stores/useHistoryStore.ts`:

```typescript
import { create } from 'zustand'
import type { HistoryItem, HistoryActions } from '../hooks/useHistory'

export interface HistoryState {
  items: HistoryItem[]
  searchQuery: string
  error: string | null

  setSearchQuery: (q: string) => void
  loadHistory: (history: HistoryActions) => void
  deleteItem: (id: number, history: HistoryActions) => void
}

export const initialState = {
  items: [] as HistoryItem[],
  searchQuery: '',
  error: null as string | null,
}

export const useHistoryStore = create<HistoryState>((set) => ({
  ...initialState,

  setSearchQuery: (q) => set({ searchQuery: q }),

  loadHistory: (history) => {
    try {
      const items = history.getAll()
      set({ items, error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteItem: (id, history) => {
    try {
      history.remove(id)
      set((s) => ({ items: s.items.filter((i) => i.id !== id), error: null }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useHistoryStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useHistoryStore.ts src/renderer/src/stores/__tests__/useHistoryStore.test.ts
git commit -m "feat: add useHistoryStore with sync localStorage actions + tests"
```

---

### Task 8: Create `useUnderstandStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useUnderstandStore.ts`
- Create: `src/renderer/src/stores/__tests__/useUnderstandStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useUnderstandStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUnderstandStore, initialState } from '../useUnderstandStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn(),
    understandImage: vi.fn().mockResolvedValue({ success: true, content: 'A cat sitting on a mat.' }),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  }
}

describe('useUnderstandStore', () => {
  beforeEach(() => {
    useUnderstandStore.setState(initialState, true)
  })

  it('has correct initial state', () => {
    const s = useUnderstandStore.getState()
    expect(s.imageUrl).toBeNull()
    expect(s.question).toBe('')
    expect(s.analysisResult).toBe('')
    expect(s.analyzing).toBe(false)
    expect(s.error).toBeNull()
  })

  it('setImageUrl updates imageUrl', () => {
    useUnderstandStore.getState().setImageUrl('data:image/png;base64,abc')
    expect(useUnderstandStore.getState().imageUrl).toBe('data:image/png;base64,abc')
  })

  it('setQuestion updates question', () => {
    useUnderstandStore.getState().setQuestion('What is this?')
    expect(useUnderstandStore.getState().question).toBe('What is this?')
  })

  describe('analyze', () => {
    it('calls understandImage and stores content', async () => {
      useUnderstandStore.setState({ imageUrl: 'data:image/png;base64,abc', question: 'describe' })
      const api = createMockApi({
        understandImage: vi.fn().mockResolvedValue({ success: true, content: 'A beautiful painting.' }),
      })

      let analyzingDuringCall = false
      ;(api.understandImage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        analyzingDuringCall = useUnderstandStore.getState().analyzing
        return { success: true, content: 'A beautiful painting.' }
      })

      await useUnderstandStore.getState().analyze(api)

      expect(analyzingDuringCall).toBe(true)
      expect(useUnderstandStore.getState().analyzing).toBe(false)
      expect(useUnderstandStore.getState().analysisResult).toBe('A beautiful painting.')
      expect(useUnderstandStore.getState().error).toBeNull()
      expect(api.understandImage).toHaveBeenCalledWith({
        images: ['data:image/png;base64,abc'],
        prompt: 'describe',
      })
    })

    it('handles missing content gracefully', async () => {
      useUnderstandStore.setState({ imageUrl: 'data:x', question: '' })
      const api = createMockApi({
        understandImage: vi.fn().mockResolvedValue({ success: true }),
      })

      await useUnderstandStore.getState().analyze(api)

      expect(useUnderstandStore.getState().analysisResult).toBe('')
    })

    it('sets error on failure', async () => {
      useUnderstandStore.setState({ imageUrl: 'data:x' })
      const api = createMockApi({
        understandImage: vi.fn().mockRejectedValue(new Error('Vision API unavailable')),
      })

      await useUnderstandStore.getState().analyze(api)

      expect(useUnderstandStore.getState().analyzing).toBe(false)
      expect(useUnderstandStore.getState().error).toBe('Vision API unavailable')
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useUnderstandStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useUnderstandStore`**

Create `src/renderer/src/stores/useUnderstandStore.ts`:

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface UnderstandState {
  imageUrl: string | null
  question: string
  analysisResult: string
  analyzing: boolean
  error: string | null

  setImageUrl: (url: string | null) => void
  setQuestion: (q: string) => void
  analyze: (api: ApiActions) => Promise<void>
}

export const initialState = {
  imageUrl: null as string | null,
  question: '',
  analysisResult: '',
  analyzing: false,
  error: null as string | null,
}

export const useUnderstandStore = create<UnderstandState>((set, get) => ({
  ...initialState,

  setImageUrl: (url) => set({ imageUrl: url }),
  setQuestion: (q) => set({ question: q }),

  analyze: async (api) => {
    set({ analyzing: true, error: null, analysisResult: '' })
    try {
      const { imageUrl, question } = get()
      const result = await api.understandImage({
        images: [imageUrl!],
        prompt: question || undefined,
      })
      set({ analysisResult: result.content ?? '', analyzing: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), analyzing: false })
    }
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useUnderstandStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useUnderstandStore.ts src/renderer/src/stores/__tests__/useUnderstandStore.test.ts
git commit -m "feat: add useUnderstandStore with vision analysis + tests"
```

---

### Task 9: Create `useTemplatesStore` + tests

**Files:**
- Create: `src/renderer/src/stores/useTemplatesStore.ts`
- Create: `src/renderer/src/stores/__tests__/useTemplatesStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/stores/__tests__/useTemplatesStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTemplatesStore, initialState } from '../useTemplatesStore'
import type { TemplateActions, Template } from '../../hooks/useTemplates'

function createMockTemplates(data: Template[] = []): TemplateActions {
  return {
    getAll: vi.fn(() => data),
  }
}

describe('useTemplatesStore', () => {
  beforeEach(() => {
    useTemplatesStore.setState(initialState, true)
  })

  it('has correct initial state', () => {
    const s = useTemplatesStore.getState()
    expect(s.templates).toEqual([])
    expect(s.searchQuery).toBe('')
    expect(s.activeCategory).toBe('all')
  })

  it('loadTemplates populates templates from TemplateActions', () => {
    const data: Template[] = [
      { id: '1', name: 'Landscape', prompt: 'beautiful landscape', category: 'nature' },
      { id: '2', name: 'Portrait', prompt: 'professional portrait', category: 'people' },
    ]
    const templates = createMockTemplates(data)

    useTemplatesStore.getState().loadTemplates(templates)

    expect(useTemplatesStore.getState().templates).toEqual(data)
    expect(templates.getAll).toHaveBeenCalled()
  })

  it('setSearchQuery updates searchQuery', () => {
    useTemplatesStore.getState().setSearchQuery('land')
    expect(useTemplatesStore.getState().searchQuery).toBe('land')
  })

  it('setActiveCategory updates activeCategory', () => {
    useTemplatesStore.getState().setActiveCategory('nature')
    expect(useTemplatesStore.getState().activeCategory).toBe('nature')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/stores/__tests__/useTemplatesStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `useTemplatesStore`**

Create `src/renderer/src/stores/useTemplatesStore.ts`:

```typescript
import { create } from 'zustand'
import type { Template, TemplateActions } from '../hooks/useTemplates'

export interface TemplatesState {
  templates: Template[]
  searchQuery: string
  activeCategory: string

  loadTemplates: (templates: TemplateActions) => void
  setSearchQuery: (q: string) => void
  setActiveCategory: (cat: string) => void
}

export const initialState = {
  templates: [] as Template[],
  searchQuery: '',
  activeCategory: 'all',
}

export const useTemplatesStore = create<TemplatesState>((set) => ({
  ...initialState,

  loadTemplates: (templates) => {
    set({ templates: templates.getAll() })
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  setActiveCategory: (cat) => set({ activeCategory: cat }),
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/stores/__tests__/useTemplatesStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/useTemplatesStore.ts src/renderer/src/stores/__tests__/useTemplatesStore.test.ts
git commit -m "feat: add useTemplatesStore with loadTemplates action + tests"
```

---

### Task 10: Update barrel exports in `stores/index.ts`

**Files:**
- Modify: `src/renderer/src/stores/index.ts`

- [ ] **Step 1: Add all new exports**

Replace `src/renderer/src/stores/index.ts` with:

```typescript
export { useTabStore } from './useTabStore'
export type { TabName } from './useTabStore'

export { useUIStore } from './useUIStore'

export { useToastStore } from './useToastStore'
export type { ToastItem } from './useToastStore'

export { useDialogStore } from './useDialogStore'
export type { DialogConfig } from './useDialogStore'

export { useModelStore } from './useModelStore'

export { useSettingsStore } from './useSettingsStore'

export { useGenerateStore } from './useGenerateStore'
export type { GenerateState } from './useGenerateStore'

export { useBatchStore } from './useBatchStore'
export type { BatchItem, BatchState } from './useBatchStore'

export { useCompareStore } from './useCompareStore'
export type { CompareState } from './useCompareStore'

export { useHistoryStore } from './useHistoryStore'
export type { HistoryState } from './useHistoryStore'

export { useUnderstandStore } from './useUnderstandStore'
export type { UnderstandState } from './useUnderstandStore'

export { useTemplatesStore } from './useTemplatesStore'
export type { TemplatesState } from './useTemplatesStore'
```

- [ ] **Step 2: Run all store tests**

Run: `npx vitest run src/renderer/src/stores/__tests__/`
Expected: All tests PASS (existing + new)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/stores/index.ts
git commit -m "feat: export all 6 new page stores from barrel"
```

---

### Task 11: Rewrite `GeneratePage` with store + sub-components

**Files:**
- Create: `src/renderer/src/pages-react/generate/RatioSelector.tsx`
- Create: `src/renderer/src/pages-react/generate/ReferenceImageList.tsx`
- Create: `src/renderer/src/pages-react/generate/ResultGrid.tsx`
- Modify: `src/renderer/src/pages-react/GeneratePage.tsx`

- [ ] **Step 1: Create `RatioSelector` sub-component**

Create `src/renderer/src/pages-react/generate/RatioSelector.tsx`:

```typescript
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

interface RatioSelectorProps {
  value: string
  onChange: (ratio: string) => void
}

export function RatioSelector({ value, onChange }: RatioSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {RATIOS.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-3 py-1.5 text-sm border-2 transition-colors ${
            value === r
              ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
              : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create `ReferenceImageList` sub-component**

Create `src/renderer/src/pages-react/generate/ReferenceImageList.tsx`:

```typescript
interface ReferenceImageListProps {
  images: string[]
  onRemove: (index: number) => void
  onAdd: () => void
}

export function ReferenceImageList({ images, onRemove, onAdd }: ReferenceImageListProps) {
  return (
    <div>
      <button
        onClick={onAdd}
        className="text-sm text-zinc-400 hover:text-cyberpunk-yellow transition-colors"
      >
        + 添加参考图
      </button>
      {images.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative w-16 h-16">
              <img src={img} alt="" className="w-full h-full object-cover border border-zinc-700" />
              <button
                onClick={() => onRemove(i)}
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create `ResultGrid` sub-component**

Create `src/renderer/src/pages-react/generate/ResultGrid.tsx`:

```typescript
interface ResultGridProps {
  urls: string[]
}

export function ResultGrid({ urls }: ResultGridProps) {
  if (urls.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-4">
      {urls.map((url, i) => (
        <div key={i} className="bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
          <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Rewrite `GeneratePage.tsx`**

Replace `src/renderer/src/pages-react/GeneratePage.tsx` with:

```typescript
import { useEffect, useRef } from 'react'
import { useModelStore, useToastStore, useGenerateStore } from '../stores'
import { useApi } from '../hooks/useService'
import { ModelSelector } from '../components/ModelSelector'
import { RatioSelector } from './generate/RatioSelector'
import { ReferenceImageList } from './generate/ReferenceImageList'
import { ResultGrid } from './generate/ResultGrid'

export default function GeneratePage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const prompt = useGenerateStore((s) => s.prompt)
  const ratio = useGenerateStore((s) => s.ratio)
  const generating = useGenerateStore((s) => s.generating)
  const resultUrls = useGenerateStore((s) => s.resultUrls)
  const referenceImages = useGenerateStore((s) => s.referenceImages)
  const error = useGenerateStore((s) => s.error)

  const { setPrompt, setRatio, addReferenceImage, removeReferenceImage, clearResults, generate } =
    useGenerateStore.getState()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentModel = models[currentModelKey]

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    if (!currentModelKey) {
      addToast({ message: '请选择模型', type: 'warning' })
      return
    }
    clearResults()
    await generate(api, currentModelKey)
    const urls = useGenerateStore.getState().resultUrls
    if (urls.length > 0) {
      addToast({ message: `生成完成 (${urls.length} 张)`, type: 'success' })
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') addReferenceImage(reader.result)
      }
      reader.readAsDataURL(file)
    })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🎨 AI 图片生成</h1>
        <ModelSelector />
      </div>

      {currentModel && (
        <div className="text-sm text-zinc-500">
          当前模型: <span className="text-cyberpunk-yellow">{currentModel.name}</span>
        </div>
      )}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想要生成的图片..."
        rows={4}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      <RatioSelector value={ratio} onChange={setRatio} />

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
      <ReferenceImageList
        images={referenceImages}
        onRemove={removeReferenceImage}
        onAdd={() => fileInputRef.current?.click()}
      />

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {generating ? '生成中...' : '开始生成'}
      </button>

      <ResultGrid urls={resultUrls} />
    </div>
  )
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors related to GeneratePage

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages-react/generate/ src/renderer/src/pages-react/GeneratePage.tsx
git commit -m "feat: rewrite GeneratePage with useGenerateStore + sub-components"
```

---

### Task 12: Rewrite `BatchPage` with store + sub-components

**Files:**
- Create: `src/renderer/src/pages-react/batch/BatchItemRow.tsx`
- Create: `src/renderer/src/pages-react/batch/BulkAddPanel.tsx`
- Modify: `src/renderer/src/pages-react/BatchPage.tsx`

- [ ] **Step 1: Create `BatchItemRow` sub-component**

Create `src/renderer/src/pages-react/batch/BatchItemRow.tsx`:

```typescript
import type { BatchItem } from '../../stores/useBatchStore'

interface BatchItemRowProps {
  item: BatchItem
  onRemove: (id: string) => void
}

export function BatchItemRow({ item, onRemove }: BatchItemRowProps) {
  const borderClass =
    item.status === 'done' ? 'border-green-700 bg-green-900/10'
    : item.status === 'error' ? 'border-red-700 bg-red-900/10'
    : item.status === 'generating' ? 'border-cyberpunk-yellow/50 bg-cyberpunk-yellow/5'
    : 'border-zinc-700 bg-zinc-900'

  return (
    <div className={`flex items-center gap-3 p-3 border-2 ${borderClass}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 truncate">{item.prompt}</p>
        {item.error && <p className="text-xs text-red-400 mt-1">{item.error}</p>}
      </div>
      {item.resultUrl && (
        <img src={item.resultUrl} alt="" className="w-10 h-10 object-cover border border-zinc-700" />
      )}
      {item.status === 'generating' && (
        <div className="w-4 h-4 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
      )}
      <button onClick={() => onRemove(item.id)} className="text-zinc-600 hover:text-red-400 text-sm">
        ×
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Create `BulkAddPanel` sub-component**

Create `src/renderer/src/pages-react/batch/BulkAddPanel.tsx`:

```typescript
interface BulkAddPanelProps {
  onBulkAdd: (text: string) => void
}

export function BulkAddPanel({ onBulkAdd }: BulkAddPanelProps) {
  return (
    <details className="text-sm">
      <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">批量导入（每行一个提示词）</summary>
      <textarea
        rows={4}
        placeholder="粘贴多行提示词..."
        className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 text-white text-sm resize-none focus:outline-none focus:border-cyberpunk-yellow"
        onBlur={(e) => {
          if (e.target.value.trim()) {
            onBulkAdd(e.target.value)
            e.target.value = ''
          }
        }}
      />
    </details>
  )
}
```

- [ ] **Step 3: Rewrite `BatchPage.tsx`**

Replace `src/renderer/src/pages-react/BatchPage.tsx` with:

```typescript
import { useState, useMemo } from 'react'
import { useModelStore, useToastStore, useBatchStore } from '../stores'
import { useApi } from '../hooks/useService'
import { BatchItemRow } from './batch/BatchItemRow'
import { BulkAddPanel } from './batch/BulkAddPanel'

export default function BatchPage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const addToast = useToastStore((s) => s.addToast)

  const items = useBatchStore((s) => s.items)
  const running = useBatchStore((s) => s.running)
  const { addItem, removeItem, bulkAdd, runBatch } = useBatchStore.getState()

  const [newPrompt, setNewPrompt] = useState('')

  const doneCount = useMemo(() => items.filter((i) => i.status === 'done').length, [items])

  const handleAdd = () => {
    if (!newPrompt.trim()) return
    addItem(newPrompt.trim())
    setNewPrompt('')
  }

  const handleRunBatch = async () => {
    if (!currentModelKey) {
      addToast({ message: '请先选择模型', type: 'warning' })
      return
    }
    if (items.filter((i) => i.status === 'pending').length === 0) {
      addToast({ message: '没有待处理的任务', type: 'warning' })
      return
    }
    await runBatch(api, currentModelKey)
    addToast({ message: '批量生成完成', type: 'success' })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📦 批量生成</h1>
        <span className="text-sm text-zinc-500">{doneCount}/{items.length} 完成</span>
      </div>

      <div className="flex gap-2">
        <input
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="输入提示词，回车添加..."
          className="flex-1 px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-cyberpunk-yellow hover:bg-zinc-700 transition-colors"
        >
          添加
        </button>
      </div>

      <BulkAddPanel onBulkAdd={bulkAdd} />

      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {items.map((item) => (
          <BatchItemRow key={item.id} item={item} onRemove={removeItem} />
        ))}
      </div>

      {items.length > 0 && (
        <button
          onClick={handleRunBatch}
          disabled={running}
          className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
        >
          {running ? `批量生成中... (${doneCount}/${items.length})` : '开始批量生成'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors related to BatchPage

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/batch/ src/renderer/src/pages-react/BatchPage.tsx
git commit -m "feat: rewrite BatchPage with useBatchStore + sub-components"
```

---

### Task 13: Rewrite `ComparePage` with store + sub-component

**Files:**
- Create: `src/renderer/src/pages-react/compare/ModelPairSelector.tsx`
- Modify: `src/renderer/src/pages-react/ComparePage.tsx`

- [ ] **Step 1: Create `ModelPairSelector` sub-component**

Create `src/renderer/src/pages-react/compare/ModelPairSelector.tsx`:

```typescript
import Select, { type SingleValue } from 'react-select'
import { darkSelectStyles } from '../../styles/selectTheme'

interface ModelOption {
  value: string
  label: string
}

interface ModelPairSelectorProps {
  options: ModelOption[]
  leftValue: string | null
  rightValue: string | null
  onLeftChange: (key: string | null) => void
  onRightChange: (key: string | null) => void
}

export function ModelPairSelector({ options, leftValue, rightValue, onLeftChange, onRightChange }: ModelPairSelectorProps) {
  const leftOption = options.find((o) => o.value === leftValue) ?? null
  const rightOption = options.find((o) => o.value === rightValue) ?? null

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="text-sm text-gray-400 mb-1 block">左侧模型</label>
        <Select<ModelOption>
          value={leftOption}
          onChange={(v: SingleValue<ModelOption>) => onLeftChange(v?.value ?? null)}
          options={options}
          styles={darkSelectStyles<ModelOption>()}
          placeholder="选择模型..."
        />
      </div>
      <div>
        <label className="text-sm text-gray-400 mb-1 block">右侧模型</label>
        <Select<ModelOption>
          value={rightOption}
          onChange={(v: SingleValue<ModelOption>) => onRightChange(v?.value ?? null)}
          options={options}
          styles={darkSelectStyles<ModelOption>()}
          placeholder="选择模型..."
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `ComparePage.tsx`**

Replace `src/renderer/src/pages-react/ComparePage.tsx` with:

```typescript
import { useEffect, useMemo } from 'react'
import { useModelStore, useToastStore, useCompareStore } from '../stores'
import { useApi } from '../hooks/useService'
import { ModelPairSelector } from './compare/ModelPairSelector'

export default function ComparePage() {
  const api = useApi()
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const leftModelKey = useCompareStore((s) => s.leftModelKey)
  const rightModelKey = useCompareStore((s) => s.rightModelKey)
  const prompt = useCompareStore((s) => s.prompt)
  const comparing = useCompareStore((s) => s.comparing)
  const leftResult = useCompareStore((s) => s.leftResult)
  const rightResult = useCompareStore((s) => s.rightResult)
  const error = useCompareStore((s) => s.error)

  const { setLeftModel, setRightModel, setPrompt, compare } = useCompareStore.getState()

  const options = useMemo(
    () => Object.entries(models).map(([k, v]) => ({ value: k, label: v.name })),
    [models]
  )

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleCompare = async () => {
    if (!leftModelKey || !rightModelKey) {
      addToast({ message: '请选择两个模型', type: 'warning' })
      return
    }
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    await compare(api)
    addToast({ message: '对比生成完成', type: 'success' })
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🔍 模型对比</h1>

      <ModelPairSelector
        options={options}
        leftValue={leftModelKey}
        rightValue={rightModelKey}
        onLeftChange={setLeftModel}
        onRightChange={setRightModel}
      />

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="输入提示词..."
        rows={3}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      <button
        onClick={handleCompare}
        disabled={comparing}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {comparing ? '生成对比中...' : '开始对比'}
      </button>

      <div className="grid grid-cols-2 gap-4 min-h-[300px]">
        <div className="bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
          {leftResult ? (
            <img src={leftResult} alt="Left" className="max-w-full max-h-[500px] object-contain" />
          ) : (
            <span className="text-zinc-600">
              {leftModelKey ? options.find((o) => o.value === leftModelKey)?.label ?? '左侧结果' : '左侧结果'}
            </span>
          )}
        </div>
        <div className="bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
          {rightResult ? (
            <img src={rightResult} alt="Right" className="max-w-full max-h-[500px] object-contain" />
          ) : (
            <span className="text-zinc-600">
              {rightModelKey ? options.find((o) => o.value === rightModelKey)?.label ?? '右侧结果' : '右侧结果'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/compare/ src/renderer/src/pages-react/ComparePage.tsx
git commit -m "feat: rewrite ComparePage with useCompareStore + shared darkSelectStyles"
```

---

### Task 14: Rewrite `HistoryPage` with store

**Files:**
- Modify: `src/renderer/src/pages-react/HistoryPage.tsx`

- [ ] **Step 1: Rewrite `HistoryPage.tsx`**

Replace `src/renderer/src/pages-react/HistoryPage.tsx` with:

```typescript
import { useEffect, useMemo } from 'react'
import { useToastStore, useHistoryStore } from '../stores'
import { useHistory } from '../hooks/useHistory'

export default function HistoryPage() {
  const history = useHistory()
  const addToast = useToastStore((s) => s.addToast)

  const items = useHistoryStore((s) => s.items)
  const searchQuery = useHistoryStore((s) => s.searchQuery)
  const error = useHistoryStore((s) => s.error)

  const { setSearchQuery, loadHistory, deleteItem } = useHistoryStore.getState()

  useEffect(() => {
    loadHistory(history)
  }, [])

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const filtered = useMemo(() => {
    if (!searchQuery) return items
    const q = searchQuery.toLowerCase()
    return items.filter((i) => i.prompt.toLowerCase().includes(q))
  }, [items, searchQuery])

  const handleDelete = (id: number) => {
    deleteItem(id, history)
    addToast({ message: '已删除', type: 'success' })
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📜 生成历史</h1>
        <span className="text-sm text-zinc-500">{items.length} 条记录</span>
      </div>

      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索提示词..."
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-600">暂无历史记录</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="bg-zinc-900 border-2 border-zinc-700 p-4 space-y-3 hover:border-zinc-500 transition-colors"
            >
              {item.urls?.[0] && (
                <img
                  src={item.urls[0]}
                  alt={item.prompt}
                  className="w-full h-40 object-cover bg-zinc-800"
                  loading="lazy"
                />
              )}
              <p className="text-sm text-gray-300 line-clamp-2">{item.prompt}</p>
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>{item.model ?? '未知模型'}</span>
                <span>{new Date(item.timestamp).toLocaleDateString()}</span>
              </div>
              <button
                onClick={() => handleDelete(item.id)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/HistoryPage.tsx
git commit -m "feat: rewrite HistoryPage with useHistoryStore + useHistory hook"
```

---

### Task 15: Rewrite `UnderstandPage` with store

**Files:**
- Modify: `src/renderer/src/pages-react/UnderstandPage.tsx`

- [ ] **Step 1: Rewrite `UnderstandPage.tsx`**

Replace `src/renderer/src/pages-react/UnderstandPage.tsx` with:

```typescript
import { useEffect, useRef } from 'react'
import { useToastStore, useUnderstandStore } from '../stores'
import { useApi } from '../hooks/useService'

export default function UnderstandPage() {
  const api = useApi()
  const addToast = useToastStore((s) => s.addToast)

  const imageUrl = useUnderstandStore((s) => s.imageUrl)
  const question = useUnderstandStore((s) => s.question)
  const analysisResult = useUnderstandStore((s) => s.analysisResult)
  const analyzing = useUnderstandStore((s) => s.analyzing)
  const error = useUnderstandStore((s) => s.error)

  const { setImageUrl, setQuestion, analyze } = useUnderstandStore.getState()
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }

  const handleAnalyze = async () => {
    if (!imageUrl) {
      addToast({ message: '请先上传图片', type: 'warning' })
      return
    }
    await analyze(api)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🧠 图像理解</h1>

      <div
        className="border-2 border-dashed border-zinc-700 hover:border-cyberpunk-yellow/50 p-8 text-center cursor-pointer transition-colors"
        onClick={() => fileInputRef.current?.click()}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="Uploaded" className="max-h-64 mx-auto object-contain" />
        ) : (
          <div className="text-zinc-500">
            <p className="text-4xl mb-2">📷</p>
            <p>点击或拖拽上传图片</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>

      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="输入问题（可选，留空将自动分析）"
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <button
        onClick={handleAnalyze}
        disabled={analyzing || !imageUrl}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {analyzing ? '分析中...' : '开始分析'}
      </button>

      {analysisResult && (
        <div className="bg-zinc-900 border-2 border-zinc-700 p-4">
          <h3 className="text-sm font-bold text-cyberpunk-yellow mb-2">分析结果</h3>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap">{analysisResult}</pre>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/UnderstandPage.tsx
git commit -m "feat: rewrite UnderstandPage with useUnderstandStore + correct VisionResult.content"
```

---

### Task 16: Rewrite `PromptTemplatesPage` with store

**Files:**
- Modify: `src/renderer/src/pages-react/PromptTemplatesPage.tsx`

- [ ] **Step 1: Rewrite `PromptTemplatesPage.tsx`**

Replace `src/renderer/src/pages-react/PromptTemplatesPage.tsx` with:

```typescript
import { useEffect, useMemo, useCallback } from 'react'
import { useToastStore, useTemplatesStore } from '../stores'
import { useTemplates } from '../hooks/useTemplates'
import type { Template } from '../hooks/useTemplates'

export default function PromptTemplatesPage() {
  const templatesSvc = useTemplates()
  const addToast = useToastStore((s) => s.addToast)

  const templates = useTemplatesStore((s) => s.templates)
  const searchQuery = useTemplatesStore((s) => s.searchQuery)
  const activeCategory = useTemplatesStore((s) => s.activeCategory)

  const { loadTemplates, setSearchQuery, setActiveCategory } = useTemplatesStore.getState()

  useEffect(() => {
    loadTemplates(templatesSvc)
  }, [])

  const categories = useMemo(
    () => ['all', ...new Set(templates.map((t) => t.category))],
    [templates]
  )

  const filtered = useMemo(() => {
    return templates.filter((t) => {
      const matchCategory = activeCategory === 'all' || t.category === activeCategory
      const matchSearch =
        !searchQuery ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.prompt.toLowerCase().includes(searchQuery.toLowerCase())
      return matchCategory && matchSearch
    })
  }, [templates, activeCategory, searchQuery])

  const handleUse = useCallback(
    (template: Template) => {
      navigator.clipboard.writeText(template.prompt)
      addToast({ message: `"${template.name}" 已复制到剪贴板`, type: 'success' })
    },
    [addToast]
  )

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📝 提示词模板</h1>

      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索模板..."
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-3 py-1 text-sm border transition-colors ${
              activeCategory === cat
                ? 'border-cyberpunk-yellow text-cyberpunk-yellow bg-cyberpunk-yellow/10'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {cat === 'all' ? '全部' : cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((t) => (
          <div
            key={t.id}
            className="bg-zinc-900 border-2 border-zinc-700 p-4 space-y-2 hover:border-zinc-500 transition-colors"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white">{t.name}</h3>
              <span className="text-xs text-zinc-500 px-2 py-0.5 border border-zinc-700">{t.category}</span>
            </div>
            <p className="text-sm text-gray-400 line-clamp-3">{t.prompt}</p>
            {t.tags && (
              <div className="flex gap-1 flex-wrap">
                {t.tags.map((tag) => (
                  <span key={tag} className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
            <button
              onClick={() => handleUse(t)}
              className="text-sm text-cyberpunk-yellow hover:underline"
            >
              使用此模板
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-600">没有找到匹配的模板</div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/PromptTemplatesPage.tsx
git commit -m "feat: rewrite PromptTemplatesPage with useTemplatesStore + useTemplates hook"
```

---

### Task 17: Final verification + run all tests

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing SettingsStore tests + 8 new test files)

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit --project src/renderer/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Verify zero `window as any` in pages-react**

Run: `rg "window as any" src/renderer/src/pages-react/`
Expected: No matches found

- [ ] **Step 4: Verify all stores exported**

Run: `rg "export.*Store" src/renderer/src/stores/index.ts`
Expected: 7 store exports (Settings + 6 new)

- [ ] **Step 5: Commit verification result**

If all checks pass, no commit needed. If any fixes were required, commit them:

```bash
git add -A
git commit -m "fix: address issues found during final verification"
```
