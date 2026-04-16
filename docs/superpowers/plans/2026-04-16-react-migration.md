# AI Image Master React 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the entire renderer layer from vanilla DOM + React islands to a pure React 19 app, upgrading all core dependencies to latest 2026-04-16 versions.

**Architecture:** React Shell approach — `index.html` becomes a minimal root, `App.tsx` renders all pages via `activeTab` state (Zustand store), services stay as pure TS classes consumed via hooks.

**Tech Stack:** React 19.2.5, Zustand 5.0.12, TypeScript 6.0.2, Vite 8.0.8, Electron 41.2.0, Tailwind CSS 4.2.2, electron-vite 5.0.0, react-select 5.10.2, @tanstack/react-virtual

**Spec:** `docs/superpowers/specs/2026-04-16-react-migration-design.md`

---

## Phase 0: Dependency Upgrades

### Task 1: Upgrade TypeScript to 6.0.2

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json` (if needed)

- [ ] **Step 1: Upgrade TypeScript**

```bash
npm install -D typescript@^6.0.2
```

- [ ] **Step 2: Run typecheck to see baseline errors**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Expected: May show new strict-mode warnings. Record them for later fixes.

- [ ] **Step 3: Fix any TS6-specific breaking changes**

TS6 is backward compatible. If `moduleResolution` or `target` flags changed, update `tsconfig.json`. Most projects migrate cleanly.

- [ ] **Step 4: Verify build**

```bash
npx electron-vite build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: upgrade TypeScript to 6.0.2"
```

---

### Task 2: Upgrade Vite to 8.0.8

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Upgrade Vite and related plugins**

```bash
npm install -D vite@^8.0.8 @vitejs/plugin-react@latest
```

- [ ] **Step 2: Check electron-vite compatibility**

```bash
npx electron-vite build
```

electron-vite 5.0.0 supports Vite 8. If build fails, check `electron.vite.config.ts` for deprecated options.

- [ ] **Step 3: Run dev server to verify HMR**

```bash
npx electron-vite dev
```

Expected: Dev server starts without errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: upgrade Vite to 8.0.8"
```

---

### Task 3: Upgrade Electron to 41.2.0

**Files:**
- Modify: `package.json`
- Modify: `src/main/index.ts` (if breaking API changes)
- Modify: `src/preload/index.ts` (if breaking API changes)

- [ ] **Step 1: Upgrade Electron**

```bash
npm install -D electron@^41.2.0
```

- [ ] **Step 2: Check for breaking changes in main process**

Read `src/main/index.ts` and `src/preload/index.ts`. Key areas:
- `BrowserWindow` constructor options
- `contextBridge.exposeInMainWorld` (stable, unlikely to break)
- `ipcMain` / `ipcRenderer` handlers
- `app.on` event names

Fix any deprecated APIs.

- [ ] **Step 3: Verify build and launch**

```bash
npx electron-vite build && npx electron .
```

Expected: App launches without console errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/ src/preload/
git commit -m "chore: upgrade Electron to 41.2.0"
```

---

### Task 4: Upgrade Tailwind CSS to 4.2.2

**Files:**
- Modify: `package.json`
- Modify: `src/renderer/src/styles/index.css`
- Delete: `tailwind.config.js` or `tailwind.config.ts` (if exists, config moves to CSS)
- Delete: `postcss.config.js` (if exists, Tailwind v4 uses built-in PostCSS)

Note: `@tailwindcss/postcss` is already at `^4.1.18`, suggesting a partial v4 migration. Check current state first.

- [ ] **Step 1: Upgrade Tailwind packages**

```bash
npm install -D tailwindcss@^4.2.2 @tailwindcss/postcss@^4.2.2
npm uninstall autoprefixer
```

Tailwind v4 includes autoprefixer.

- [ ] **Step 2: Run the official upgrade tool**

```bash
npx @tailwindcss/upgrade
```

This auto-migrates `tailwind.config.js` to CSS `@theme` directives and renames changed utility classes.

- [ ] **Step 3: Verify styles render correctly**

```bash
npx electron-vite dev
```

Visually inspect the app. Check for missing styles, broken layouts.

- [ ] **Step 4: Fix any remaining class name issues**

Search for deprecated patterns:
- `bg-opacity-*` → `bg-{color}/{opacity}`
- `text-opacity-*` → `text-{color}/{opacity}`
- `divide-opacity-*` → `divide-{color}/{opacity}`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: upgrade Tailwind CSS to 4.2.2"
```

---

### Task 5: Upgrade React, Zustand, and install new React libraries

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Upgrade minor versions**

```bash
npm install react@^19.2.5 react-dom@^19.2.5 zustand@^5.0.12
```

- [ ] **Step 2: Install new React ecosystem packages**

```bash
npm install react-select@^5.10.2 react-masonry-css @tanstack/react-virtual react-cropper react-syntax-highlighter
npm install -D @types/react-syntax-highlighter
```

- [ ] **Step 3: Verify existing React code still works**

```bash
npm run test:run
```

Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: upgrade React/Zustand, add react-select and react ecosystem libs"
```

---

### Task 6: Run full test suite after all upgrades

- [ ] **Step 1: Run all tests**

```bash
npm run test:run
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Run build**

```bash
npx electron-vite build
```

- [ ] **Step 4: Fix any failures from dependency upgrades**

If tests fail, fix one at a time. Most will be type-related or import path changes.

- [ ] **Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve dependency upgrade compatibility issues"
```

---

## Phase 1: React Shell Infrastructure

### Task 7: Create Zustand stores — useTabStore and useUIStore

**Files:**
- Create: `src/renderer/src/stores/useTabStore.ts`
- Create: `src/renderer/src/stores/useUIStore.ts`
- Create: `src/renderer/src/stores/__tests__/useTabStore.test.ts`

- [ ] **Step 1: Write failing test for useTabStore**

Create `src/renderer/src/stores/__tests__/useTabStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useTabStore } from '../useTabStore'

describe('useTabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ activeTab: 'generate' })
  })

  it('has generate as default tab', () => {
    expect(useTabStore.getState().activeTab).toBe('generate')
  })

  it('switches tab', () => {
    useTabStore.getState().switchTab('history')
    expect(useTabStore.getState().activeTab).toBe('history')
    expect(useTabStore.getState().previousTab).toBe('generate')
  })

  it('rejects invalid tab', () => {
    useTabStore.getState().switchTab('nonexistent')
    expect(useTabStore.getState().activeTab).toBe('generate')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/renderer/src/stores/__tests__/useTabStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement useTabStore**

Create `src/renderer/src/stores/useTabStore.ts`:

```typescript
import { create } from 'zustand'

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

export const useTabStore = create<TabState>((set, get) => ({
  activeTab: 'generate',
  previousTab: null,
  switchTab: (tab: string) => {
    if (!VALID_TABS.includes(tab as TabName)) return
    const prev = get().activeTab
    if (prev === tab) return
    set({ activeTab: tab as TabName, previousTab: prev })
    window.location.hash = tab
  },
}))
```

- [ ] **Step 4: Implement useUIStore**

Create `src/renderer/src/stores/useUIStore.ts`:

```typescript
import { create } from 'zustand'

interface UIState {
  sidebarOpen: boolean
  mobileMenuOpen: boolean
  theme: 'dark' | 'light'
  toggleSidebar: () => void
  toggleMobileMenu: () => void
  setTheme: (theme: 'dark' | 'light') => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  mobileMenuOpen: false,
  theme: 'dark',
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleMobileMenu: () => set((s) => ({ mobileMenuOpen: !s.mobileMenuOpen })),
  setTheme: (theme) => set({ theme }),
}))
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/renderer/src/stores/__tests__/useTabStore.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/stores/
git commit -m "feat: add useTabStore and useUIStore Zustand stores"
```

---

### Task 8: Create useToastStore, useDialogStore, and useModelStore

**Files:**
- Create: `src/renderer/src/stores/useToastStore.ts`
- Create: `src/renderer/src/stores/useDialogStore.ts`
- Create: `src/renderer/src/stores/useModelStore.ts`
- Create: `src/renderer/src/stores/__tests__/useModelStore.test.ts`

- [ ] **Step 1: Write failing test for useModelStore**

Create `src/renderer/src/stores/__tests__/useModelStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from '../useModelStore'

describe('useModelStore', () => {
  beforeEach(() => {
    useModelStore.setState({
      currentModelKey: '',
      models: {},
    })
  })

  it('switches model', () => {
    useModelStore.setState({
      models: { 'gpt-4': { name: 'GPT-4', capabilities: {} } },
    })
    useModelStore.getState().switchModel('gpt-4')
    expect(useModelStore.getState().currentModelKey).toBe('gpt-4')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/renderer/src/stores/__tests__/useModelStore.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement all three stores**

Create `src/renderer/src/stores/useToastStore.ts`:

```typescript
import { create } from 'zustand'

export interface ToastItem {
  id: string
  message: string
  type: 'success' | 'error' | 'info' | 'warning'
  duration?: number
}

interface ToastState {
  toasts: ToastItem[]
  addToast: (toast: Omit<ToastItem, 'id'>) => void
  removeToast: (id: string) => void
  clearAll: () => void
}

let toastId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = String(++toastId)
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    const duration = toast.duration ?? 3000
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearAll: () => set({ toasts: [] }),
}))
```

Create `src/renderer/src/stores/useDialogStore.ts`:

```typescript
import { create } from 'zustand'

interface DialogConfig {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm?: () => void
  onCancel?: () => void
  type?: 'confirm' | 'alert' | 'prompt'
}

interface DialogState {
  isOpen: boolean
  config: DialogConfig | null
  openDialog: (config: DialogConfig) => void
  closeDialog: () => void
  confirm: () => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  isOpen: false,
  config: null,
  openDialog: (config) => set({ isOpen: true, config }),
  closeDialog: () => {
    get().config?.onCancel?.()
    set({ isOpen: false, config: null })
  },
  confirm: () => {
    get().config?.onConfirm?.()
    set({ isOpen: false, config: null })
  },
}))
```

Create `src/renderer/src/stores/useModelStore.ts`:

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ModelInfo {
  name: string
  capabilities: Record<string, unknown>
  [key: string]: unknown
}

interface ModelState {
  currentModelKey: string
  models: Record<string, ModelInfo>
  setModels: (models: Record<string, ModelInfo>) => void
  switchModel: (key: string) => void
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      currentModelKey: '',
      models: {},
      setModels: (models) => set({ models }),
      switchModel: (key) => {
        if (get().models[key] || key === '') {
          set({ currentModelKey: key })
        }
      },
    }),
    { name: 'model-store' }
  )
)
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/renderer/src/stores/__tests__/useModelStore.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/
git commit -m "feat: add useToastStore, useDialogStore, useModelStore"
```

---

### Task 9: Create useService hooks

**Files:**
- Create: `src/renderer/src/hooks/useService.ts`
- Create: `src/renderer/src/hooks/__tests__/useService.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/hooks/__tests__/useService.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ServiceRegistry } from '../../services/ServiceBridge'
import { getService } from '../useService'

describe('getService', () => {
  it('returns a registered service', () => {
    ServiceRegistry.register('test-svc', { name: 'test' })
    const svc = getService<{ name: string }>('test-svc')
    expect(svc.name).toBe('test')
    ServiceRegistry.clear()
  })

  it('throws if service not registered', () => {
    expect(() => getService('missing')).toThrow('Service not found')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/renderer/src/hooks/__tests__/useService.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement useService hooks**

Create `src/renderer/src/hooks/useService.ts`:

```typescript
import { useMemo } from 'react'
import { ServiceRegistry } from '../services/ServiceBridge'
import type { ApiService } from '../services/api'
import type { I18nService } from '../services/i18n'
import type { ImageCacheService } from '../services/cache'
import { SERVICE_KEYS } from '../services/ServiceBridge'

export function getService<T>(key: string): T {
  return ServiceRegistry.getRequired<T>(key)
}

export function useApi(): ApiService {
  return useMemo(() => getService<ApiService>(SERVICE_KEYS.API), [])
}

export function useI18n(): I18nService {
  return useMemo(() => getService<I18nService>(SERVICE_KEYS.I18N), [])
}

export function useImageCache(): ImageCacheService {
  return useMemo(() => getService<ImageCacheService>(SERVICE_KEYS.IMAGE_CACHE), [])
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/renderer/src/hooks/__tests__/useService.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/
git commit -m "feat: add useService hooks for React-service bridge"
```

---

### Task 10: Create App.tsx, main.tsx, and AppProviders

**Files:**
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/providers/AppProviders.tsx`

- [ ] **Step 1: Create AppProviders**

Create `src/renderer/src/providers/AppProviders.tsx`:

```tsx
import React from 'react'

interface AppProvidersProps {
  children: React.ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  return <>{children}</>
}
```

- [ ] **Step 2: Create App.tsx**

Create `src/renderer/src/App.tsx`:

```tsx
import React, { Suspense, lazy } from 'react'
import { AppProviders } from './providers/AppProviders'
import { useTabStore } from './stores/useTabStore'

const GeneratePage = lazy(() => import('./pages/GeneratePage'))
const BatchPage = lazy(() => import('./pages/BatchPage'))
const ComparePage = lazy(() => import('./pages/ComparePage'))
const HistoryPage = lazy(() => import('./pages/HistoryPage'))
const UnderstandPage = lazy(() => import('./pages/UnderstandPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const PromptTemplatesPage = lazy(() => import('./pages/PromptTemplates'))

function PageContainer() {
  const activeTab = useTabStore((s) => s.activeTab)

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full">Loading...</div>}>
      {activeTab === 'generate' && <GeneratePage />}
      {activeTab === 'batch' && <BatchPage />}
      {activeTab === 'compare' && <ComparePage />}
      {activeTab === 'history' && <HistoryPage />}
      {activeTab === 'understand' && <UnderstandPage />}
      {activeTab === 'settings' && <SettingsPage />}
      {activeTab === 'promptTemplates' && <PromptTemplatesPage />}
    </Suspense>
  )
}

export default function App() {
  return (
    <AppProviders>
      <div className="app-container flex h-screen bg-gray-900 text-white">
        <main className="flex-1 overflow-auto">
          <PageContainer />
        </main>
      </div>
    </AppProviders>
  )
}
```

- [ ] **Step 3: Create main.tsx**

Create `src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'

import './styles/index.css'

if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as any).Buffer = Buffer
}

import { initServiceBridge, isServiceBridgeReady } from './services/ServiceBridge'
import { preloadLibraries } from './utils'

async function bootstrap() {
  console.log('🚀 CATIMATION-Cyberpunk Master React App 启动')

  await initServiceBridge({
    useTypescriptServices: true,
    exposeUtilFunctions: true,
    onReady: () => {
      console.log('[main.tsx] ✅ ServiceBridge ready')
      window.dispatchEvent(new CustomEvent('serviceBridgeReady'))
    },
  })

  if (isServiceBridgeReady()) {
    console.log('[main.tsx] ✅ All services ready')
    preloadLibraries()
  }

  const root = document.getElementById('root')
  if (!root) throw new Error('Root element not found')

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

bootstrap().catch(console.error)
```

Note: This does NOT replace `main.ts` yet. Both entry points coexist until Phase 3 is complete.

- [ ] **Step 4: Create stub page components**

For each page, create a minimal stub so `App.tsx` can import them. These will be replaced in Phase 3.

Create `src/renderer/src/pages/SettingsPage.tsx`:

```tsx
export default function SettingsPage() {
  return <div id="settingsPanel">Settings — stub (to be migrated)</div>
}
```

Repeat for: `GeneratePage.tsx`, `BatchPage.tsx`, `ComparePage.tsx`, `HistoryPage.tsx`, `UnderstandPage.tsx`, `PromptTemplates.tsx` — all as `.tsx` files with default exports and stub content.

Important: These are NEW `.tsx` files alongside the existing `.ts` page classes. They do NOT replace the old files yet.

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No new errors from the new files.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/main.tsx src/renderer/src/providers/ src/renderer/src/pages/*.tsx
git commit -m "feat: create React shell — App.tsx, main.tsx, AppProviders, stub pages"
```

---

## Phase 2: Common Components

### Task 11: Create TabBar component

**Files:**
- Create: `src/renderer/src/components/TabBar.tsx`
- Create: `src/renderer/src/components/__tests__/TabBar.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/components/__tests__/TabBar.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabBar } from '../TabBar'
import { useTabStore } from '../../stores/useTabStore'

describe('TabBar', () => {
  beforeEach(() => {
    useTabStore.setState({ activeTab: 'generate', previousTab: null })
  })

  it('renders tab buttons', () => {
    render(<TabBar />)
    expect(screen.getByText('生成')).toBeTruthy()
    expect(screen.getByText('历史')).toBeTruthy()
  })

  it('switches tab on click', () => {
    render(<TabBar />)
    fireEvent.click(screen.getByText('历史'))
    expect(useTabStore.getState().activeTab).toBe('history')
  })
})
```

- [ ] **Step 2: Implement TabBar**

Create `src/renderer/src/components/TabBar.tsx`:

```tsx
import React from 'react'
import { useTabStore, type TabName } from '../stores/useTabStore'

const TAB_CONFIG: { key: TabName; label: string; icon: string }[] = [
  { key: 'generate', label: '生成', icon: '🎨' },
  { key: 'batch', label: '批量', icon: '📦' },
  { key: 'compare', label: '对比', icon: '🔍' },
  { key: 'history', label: '历史', icon: '📋' },
  { key: 'understand', label: '理解', icon: '🧠' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export function TabBar() {
  const { activeTab, switchTab } = useTabStore()

  return (
    <nav className="flex gap-1 p-2 bg-gray-800 border-b border-gray-700">
      {TAB_CONFIG.map(({ key, label, icon }) => (
        <button
          key={key}
          onClick={() => switchTab(key)}
          className={`px-3 py-2 rounded text-sm transition-colors ${
            activeTab === key
              ? 'bg-purple-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          }`}
        >
          <span className="mr-1">{icon}</span>
          {label}
        </button>
      ))}
    </nav>
  )
}
```

- [ ] **Step 3: Run test**

```bash
npx vitest run src/renderer/src/components/__tests__/TabBar.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TabBar.tsx src/renderer/src/components/__tests__/
git commit -m "feat: add TabBar component with tab switching"
```

---

### Task 12: Create ModelSelector component (react-select)

**Files:**
- Create: `src/renderer/src/components/ModelSelector.tsx`
- Create: `src/renderer/src/components/__tests__/ModelSelector.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/components/__tests__/ModelSelector.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ModelSelector } from '../ModelSelector'
import { useModelStore } from '../../stores/useModelStore'

describe('ModelSelector', () => {
  beforeEach(() => {
    useModelStore.setState({
      currentModelKey: 'flux-schnell',
      models: {
        'flux-schnell': { name: 'Flux Schnell', capabilities: {} },
        'flux-pro': { name: 'Flux Pro', capabilities: {} },
      },
    })
  })

  it('renders with current model selected', () => {
    render(<ModelSelector />)
    expect(screen.getByText('Flux Schnell')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Implement ModelSelector**

Create `src/renderer/src/components/ModelSelector.tsx`:

```tsx
import React, { useMemo } from 'react'
import Select from 'react-select'
import { useModelStore } from '../stores/useModelStore'

export function ModelSelector() {
  const { currentModelKey, models, switchModel } = useModelStore()

  const options = useMemo(
    () =>
      Object.entries(models).map(([key, model]) => ({
        value: key,
        label: model.name,
      })),
    [models]
  )

  const selectedOption = options.find((o) => o.value === currentModelKey) ?? null

  return (
    <div className="model-selector">
      <Select
        value={selectedOption}
        onChange={(option) => {
          if (option) switchModel(option.value)
        }}
        options={options}
        classNamePrefix="react-select"
        placeholder="选择模型..."
        styles={{
          control: (base) => ({
            ...base,
            backgroundColor: '#1f2937',
            borderColor: '#374151',
            color: '#fff',
          }),
          menu: (base) => ({
            ...base,
            backgroundColor: '#1f2937',
          }),
          option: (base, state) => ({
            ...base,
            backgroundColor: state.isFocused ? '#374151' : '#1f2937',
            color: '#fff',
          }),
          singleValue: (base) => ({
            ...base,
            color: '#fff',
          }),
        }}
      />
    </div>
  )
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/renderer/src/components/__tests__/ModelSelector.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ModelSelector.tsx src/renderer/src/components/__tests__/
git commit -m "feat: add ModelSelector component using react-select"
```

---

### Task 13: Create Toast and Dialog components

**Files:**
- Create: `src/renderer/src/components/Toast/ToastContainer.tsx`
- Create: `src/renderer/src/components/Toast/ToastItem.tsx`
- Create: `src/renderer/src/components/Dialog/DialogProvider.tsx`
- Create: `src/renderer/src/components/Dialog/ConfirmDialog.tsx`
- Create: `src/renderer/src/components/ErrorBoundary.tsx`

- [ ] **Step 1: Create ToastContainer and ToastItem**

Create `src/renderer/src/components/Toast/ToastContainer.tsx`:

```tsx
import React from 'react'
import { useToastStore } from '../../stores/useToastStore'
import { ToastItem } from './ToastItem'

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
```

Create `src/renderer/src/components/Toast/ToastItem.tsx`:

```tsx
import React from 'react'
import { useToastStore, type ToastItem as ToastType } from '../../stores/useToastStore'

const TYPE_STYLES = {
  success: 'bg-green-600 border-green-500',
  error: 'bg-red-600 border-red-500',
  info: 'bg-blue-600 border-blue-500',
  warning: 'bg-yellow-600 border-yellow-500',
}

export function ToastItem({ toast }: { toast: ToastType }) {
  const removeToast = useToastStore((s) => s.removeToast)

  return (
    <div
      className={`px-4 py-3 rounded border text-white shadow-lg min-w-[280px] flex justify-between items-center ${TYPE_STYLES[toast.type]}`}
    >
      <span>{toast.message}</span>
      <button onClick={() => removeToast(toast.id)} className="ml-3 opacity-70 hover:opacity-100">
        ✕
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Create DialogProvider and ConfirmDialog**

Create `src/renderer/src/components/Dialog/DialogProvider.tsx`:

```tsx
import React from 'react'
import { useDialogStore } from '../../stores/useDialogStore'
import { ConfirmDialog } from './ConfirmDialog'

export function DialogProvider() {
  const { isOpen, config, closeDialog, confirm } = useDialogStore()

  if (!isOpen || !config) return null

  return <ConfirmDialog config={config} onConfirm={confirm} onCancel={closeDialog} />
}
```

Create `src/renderer/src/components/Dialog/ConfirmDialog.tsx`:

```tsx
import React from 'react'

interface ConfirmDialogProps {
  config: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
  }
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ config, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl border border-gray-700">
        <h3 className="text-lg font-semibold text-white mb-2">{config.title}</h3>
        <p className="text-gray-300 mb-6">{config.message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded bg-gray-600 text-white hover:bg-gray-500"
          >
            {config.cancelText ?? '取消'}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded bg-purple-600 text-white hover:bg-purple-500"
          >
            {config.confirmText ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create ErrorBoundary**

Create `src/renderer/src/components/ErrorBoundary.tsx`:

```tsx
import React, { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="p-8 text-center text-red-400">
            <h2 className="text-xl mb-2">页面出错了</h2>
            <p className="text-sm text-gray-500">{this.state.error?.message}</p>
            <button
              className="mt-4 px-4 py-2 bg-gray-700 rounded hover:bg-gray-600"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              重试
            </button>
          </div>
        )
      )
    }
    return this.props.children
  }
}
```

- [ ] **Step 4: Update App.tsx to include Toast, Dialog, and ErrorBoundary**

Modify `src/renderer/src/App.tsx` — wrap `PageContainer` with `ErrorBoundary`, add `ToastContainer` and `DialogProvider` to the overlay area:

```tsx
import React, { Suspense, lazy } from 'react'
import { AppProviders } from './providers/AppProviders'
import { useTabStore } from './stores/useTabStore'
import { TabBar } from './components/TabBar'
import { ModelSelector } from './components/ModelSelector'
import { ToastContainer } from './components/Toast/ToastContainer'
import { DialogProvider } from './components/Dialog/DialogProvider'
import { ErrorBoundary } from './components/ErrorBoundary'

const GeneratePage = lazy(() => import('./pages/GeneratePage'))
const BatchPage = lazy(() => import('./pages/BatchPage'))
const ComparePage = lazy(() => import('./pages/ComparePage'))
const HistoryPage = lazy(() => import('./pages/HistoryPage'))
const UnderstandPage = lazy(() => import('./pages/UnderstandPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const PromptTemplatesPage = lazy(() => import('./pages/PromptTemplates'))

function PageContainer() {
  const activeTab = useTabStore((s) => s.activeTab)

  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="flex items-center justify-center h-full">Loading...</div>}>
        {activeTab === 'generate' && <GeneratePage />}
        {activeTab === 'batch' && <BatchPage />}
        {activeTab === 'compare' && <ComparePage />}
        {activeTab === 'history' && <HistoryPage />}
        {activeTab === 'understand' && <UnderstandPage />}
        {activeTab === 'settings' && <SettingsPage />}
        {activeTab === 'promptTemplates' && <PromptTemplatesPage />}
      </Suspense>
    </ErrorBoundary>
  )
}

export default function App() {
  return (
    <AppProviders>
      <div className="app-container flex flex-col h-screen bg-gray-900 text-white">
        <header className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
          <ModelSelector />
        </header>
        <TabBar />
        <main className="flex-1 overflow-auto">
          <PageContainer />
        </main>
      </div>
      <ToastContainer />
      <DialogProvider />
    </AppProviders>
  )
}
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ src/renderer/src/App.tsx
git commit -m "feat: add Toast, Dialog, ErrorBoundary components and wire into App"
```

---

## Phase 3: Page Migration

Each page follows the same pattern:
1. Read the corresponding old `.ts` page class to understand its logic
2. Implement the React `.tsx` version using Zustand store + hooks
3. Test the component
4. Commit

### Task 14: Migrate SettingsPage

**Files:**
- Replace stub: `src/renderer/src/pages/SettingsPage.tsx`
- Create: `src/renderer/src/stores/useSettingsStore.ts`
- Reference: `src/renderer/src/features/settings/Settings.ts`

- [ ] **Step 1: Read old Settings.ts to understand all settings fields and logic**

```bash
wc -l src/renderer/src/features/settings/Settings.ts
```

Study every field and method. The React version must cover the same functionality.

- [ ] **Step 2: Create useSettingsStore**

Create `src/renderer/src/stores/useSettingsStore.ts` with `persist` middleware. Include all settings fields found in `Settings.ts` and `SiteManager.ts`.

- [ ] **Step 3: Implement SettingsPage.tsx**

Replace stub in `src/renderer/src/pages/SettingsPage.tsx`. Use Zustand store for state, react-select for dropdowns, standard form elements for inputs.

- [ ] **Step 4: Verify page renders**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/SettingsPage.tsx src/renderer/src/stores/useSettingsStore.ts
git commit -m "feat: migrate SettingsPage to React"
```

---

### Task 15: Migrate ComparePage

**Files:**
- Replace stub: `src/renderer/src/pages/ComparePage.tsx`
- Create: `src/renderer/src/stores/useCompareStore.ts`
- Reference: `src/renderer/src/pages/ComparePage.ts`

- [ ] **Step 1: Read old ComparePage.ts**
- [ ] **Step 2: Create useCompareStore**
- [ ] **Step 3: Implement ComparePage.tsx**
- [ ] **Step 4: Verify and commit**

```bash
git add src/renderer/src/pages/ComparePage.tsx src/renderer/src/stores/useCompareStore.ts
git commit -m "feat: migrate ComparePage to React"
```

---

### Task 16: Migrate HistoryPage

**Files:**
- Replace stub: `src/renderer/src/pages/HistoryPage.tsx`
- Create: `src/renderer/src/stores/useHistoryStore.ts`
- Reference: `src/renderer/src/pages/HistoryPage.ts`
- Reference: `src/renderer/src/features/history/HistoryDataService.ts` (keep as-is, consume via hook)

- [ ] **Step 1: Read old HistoryPage.ts and HistoryDataService.ts**
- [ ] **Step 2: Create useHistoryStore**

Use `@tanstack/react-virtual` for the virtual scrolling list (replacing `VirtualScroller.ts`).
Use `react-masonry-css` for the masonry layout (replacing vanilla masonry).

- [ ] **Step 3: Implement HistoryPage.tsx**
- [ ] **Step 4: Verify and commit**

```bash
git add src/renderer/src/pages/HistoryPage.tsx src/renderer/src/stores/useHistoryStore.ts
git commit -m "feat: migrate HistoryPage to React with virtual scrolling"
```

---

### Task 17: Migrate GeneratePage

**Files:**
- Replace stub: `src/renderer/src/pages/GeneratePage.tsx`
- Create: `src/renderer/src/stores/useGenerateStore.ts`
- Reference: `src/renderer/src/pages/GeneratePage.ts`
- Reuse: Existing `react-app/components/` (SceneInput, GenerateButton, ResultsGallery, etc.)

- [ ] **Step 1: Read old GeneratePage.ts — this is the most complex page**

It handles: prompt input, model parameters, reference image upload, generation progress, results display.

- [ ] **Step 2: Create useGenerateStore**
- [ ] **Step 3: Implement GeneratePage.tsx**

Reuse existing React components from `react-app/components/` (SceneInput, GenerateButton, GenerationProgress, ResultsGallery, ReferenceImageUpload, etc.) — move imports to point at their current locations.

- [ ] **Step 4: Verify and commit**

```bash
git add src/renderer/src/pages/GeneratePage.tsx src/renderer/src/stores/useGenerateStore.ts
git commit -m "feat: migrate GeneratePage to React"
```

---

### Task 18: Migrate BatchPage

**Files:**
- Replace stub: `src/renderer/src/pages/BatchPage.tsx`
- Create: `src/renderer/src/stores/useBatchStore.ts`
- Reference: `src/renderer/src/pages/BatchPage.ts`

- [ ] **Step 1: Read old BatchPage.ts**
- [ ] **Step 2: Create useBatchStore**
- [ ] **Step 3: Implement BatchPage.tsx**
- [ ] **Step 4: Verify and commit**

```bash
git add src/renderer/src/pages/BatchPage.tsx src/renderer/src/stores/useBatchStore.ts
git commit -m "feat: migrate BatchPage to React"
```

---

### Task 19: Migrate UnderstandPage

**Files:**
- Replace stub: `src/renderer/src/pages/UnderstandPage.tsx`
- Move: `src/renderer/src/react-app/` components and stores into main structure
- Reference: `src/renderer/src/pages/UnderstandPage.ts` + `react-app/`

- [ ] **Step 1: Study existing react-app/ structure**

The Understand page already has React components. Move them into the main component tree.

- [ ] **Step 2: Move stores**

Move `react-app/stores/useDirectorStore.ts` → `stores/useDirectorStore.ts`
Move `react-app/understand/stores/useStoryboardStore.ts` → `stores/useStoryboardStore.ts`

Update import paths in all consuming files.

- [ ] **Step 3: Move components**

Move reusable components from `react-app/components/` into `components/` or keep them as page-specific sub-components within `pages/understand/`.

- [ ] **Step 4: Implement UnderstandPage.tsx as the unified entry**
- [ ] **Step 5: Verify and commit**

```bash
git add -A
git commit -m "feat: migrate UnderstandPage — consolidate react-app/ into main structure"
```

---

### Task 20: Migrate PromptTemplates

**Files:**
- Replace stub: `src/renderer/src/pages/PromptTemplates.tsx`
- Create: `src/renderer/src/stores/useTemplateStore.ts`
- Reference: `src/renderer/src/pages/PromptTemplates.ts`

- [ ] **Step 1: Read old PromptTemplates.ts**
- [ ] **Step 2: Create useTemplateStore**
- [ ] **Step 3: Implement PromptTemplates.tsx**
- [ ] **Step 4: Verify and commit**

```bash
git add src/renderer/src/pages/PromptTemplates.tsx src/renderer/src/stores/useTemplateStore.ts
git commit -m "feat: migrate PromptTemplates to React"
```

---

## Phase 4: Switch Entry Point and Slim index.html

### Task 21: Switch entry from main.ts to main.tsx

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `electron.vite.config.ts` (if entry point is configured there)

- [ ] **Step 1: Update index.html**

Replace the entire `src/renderer/index.html` with:

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CATIMATION-Cyberpunk Master</title>
  </head>
  <body class="bg-gray-900">
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Update vite config if needed**

Check `electron.vite.config.ts` for `renderer.input` or `renderer.entry` — update to point at `main.tsx`.

- [ ] **Step 3: Verify dev server launches**

```bash
npx electron-vite dev
```

Expected: React app renders with TabBar, ModelSelector, and stub/migrated pages.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html electron.vite.config.ts
git commit -m "feat: switch entry point to main.tsx, slim index.html to React root"
```

---

## Phase 5: Cleanup

### Task 22: Remove Choices.js dependency

**Files:**
- Modify: `package.json`
- Delete references in old `main.ts`

- [ ] **Step 1: Uninstall Choices.js**

```bash
npm uninstall choices.js
```

- [ ] **Step 2: Remove all Choices.js imports and window.Choices references**

Search all files for `choices.js` and `window.Choices`. Remove them.

- [ ] **Step 3: Verify build**

```bash
npx electron-vite build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove Choices.js dependency (replaced by react-select)"
```

---

### Task 23: Delete old files

**Files to delete (per spec Section 5.2):**
- `src/renderer/src/main.ts`
- `src/renderer/src/pages/BasePage.ts`, `GeneratePage.ts`, `BatchPage.ts`, `ComparePage.ts`, `HistoryPage.ts`, `UnderstandPage.ts`, `PromptTemplates.ts`, `pages/index.ts`
- `src/renderer/src/features/tab-manager/`
- `src/renderer/src/features/model-selector/`
- `src/renderer/src/features/dialog/`
- `src/renderer/src/features/toast/`
- `src/renderer/src/features/ui-state/`
- `src/renderer/src/features/ui-components/`
- `src/renderer/src/features/mobile-menu/`
- `src/renderer/src/features/keyboard/`
- `src/renderer/src/features/accessibility/`
- `src/renderer/src/features/intro-video/`
- `src/renderer/src/features/error-handler/`
- `src/renderer/src/features/performance/`
- `src/renderer/src/features/settings/`
- `src/renderer/src/features/image-viewer/`
- `src/renderer/src/features/intelligent-resize/`
- `src/renderer/src/features/updater/`
- `src/renderer/src/features/language/`
- `src/renderer/src/features/history/HistoryManager.ts` + `features/history/index.ts`
- `src/renderer/src/features/index.ts`
- `src/renderer/src/core/` (entire directory)
- `src/renderer/src/react-app/` (content migrated)
- `src/renderer/src/utils/toast.ts`

- [ ] **Step 1: Delete old page classes**

```bash
rm src/renderer/src/pages/BasePage.ts src/renderer/src/pages/GeneratePage.ts src/renderer/src/pages/BatchPage.ts src/renderer/src/pages/ComparePage.ts src/renderer/src/pages/HistoryPage.ts src/renderer/src/pages/UnderstandPage.ts src/renderer/src/pages/PromptTemplates.ts src/renderer/src/pages/index.ts
```

- [ ] **Step 2: Delete features directories**

```bash
rm -rf src/renderer/src/features/tab-manager src/renderer/src/features/model-selector src/renderer/src/features/dialog src/renderer/src/features/toast src/renderer/src/features/ui-state src/renderer/src/features/ui-components src/renderer/src/features/mobile-menu src/renderer/src/features/keyboard src/renderer/src/features/accessibility src/renderer/src/features/intro-video src/renderer/src/features/error-handler src/renderer/src/features/performance src/renderer/src/features/settings src/renderer/src/features/image-viewer src/renderer/src/features/intelligent-resize src/renderer/src/features/updater src/renderer/src/features/language src/renderer/src/features/index.ts
```

- [ ] **Step 3: Clean up history feature (keep HistoryDataService)**

```bash
rm src/renderer/src/features/history/HistoryManager.ts src/renderer/src/features/history/index.ts
```

- [ ] **Step 4: Delete core directory**

```bash
rm -rf src/renderer/src/core/
```

- [ ] **Step 5: Delete old react-app directory**

```bash
rm -rf src/renderer/src/react-app/
```

- [ ] **Step 6: Delete old main.ts and toast utility**

```bash
rm src/renderer/src/main.ts src/renderer/src/utils/toast.ts
```

- [ ] **Step 7: Fix broken imports in ServiceBridge.ts**

`ServiceBridge.ts` imports many of the deleted managers. Update it to remove those imports and registration calls. Keep only the service registrations that still exist (ApiService, I18nService, etc.).

- [ ] **Step 8: Verify build compiles**

```bash
npx tsc --noEmit && npx electron-vite build
```

Fix any remaining import errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: delete old vanilla DOM files — pages, features, core, react-app"
```

---

## Phase 6: Verification

### Task 24: TypeScript strict mode check

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 2: Fix all type errors**

Address each error. Common patterns:
- Missing types for service hooks
- Event handler type mismatches
- Nullable type checks

- [ ] **Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve all TypeScript strict mode errors"
```

---

### Task 25: Run full test suite

- [ ] **Step 1: Run all tests**

```bash
npm run test:run
```

- [ ] **Step 2: Update/delete tests for removed modules**

Old test files that test deleted managers need to be removed or rewritten for new React components.

- [ ] **Step 3: Write smoke tests for critical flows**

At minimum, verify:
- App renders without crashing
- Tab switching works
- Model selection works
- Each page loads

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: update test suite for React migration"
```

---

### Task 26: Full build and manual verification

- [ ] **Step 1: Full build**

```bash
npx electron-vite build
```

- [ ] **Step 2: Launch packaged app**

```bash
npx electron .
```

- [ ] **Step 3: Manual verification checklist**

- [ ] App launches without console errors
- [ ] TabBar renders and switches pages
- [ ] ModelSelector loads models and switches
- [ ] Generate page: prompt input, generate, view results
- [ ] Batch page: batch generation works
- [ ] History page: shows history, virtual scrolling works
- [ ] Compare page: image comparison works
- [ ] Understand page: storyboard/director features work
- [ ] Settings page: all settings load and save
- [ ] Toast notifications appear correctly
- [ ] Dialog confirmations work
- [ ] Keyboard shortcuts work
- [ ] Mobile responsiveness works
- [ ] `index.html` is under 30 lines

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete React migration — all pages migrated, verified"
```
