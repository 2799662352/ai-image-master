# Director 页面 React 迁移实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 DirectorPageV2（导演模式）从原生 TypeScript DOM 操作架构迁移为 React 组件架构，以 UnderstandPage（图像理解页面）为参考模式。

**Architecture:** 在现有 electron-vite + Electron 项目中引入 React 18，使用 Zustand (slices pattern) 替代手写 EventEmitter 状态管理，将 DirectorUIRenderer (1367行 DOM 操作) 拆分为 10+ 独立 React 组件。Service 层（ServiceBridge、DirectorPipeline、BasePipeline）保持不变，通过 custom hooks 桥接到 React。采用渐进式迁移策略——Director 页面先行，其他页面后续跟进。

**Tech Stack:**
- React 18 + ReactDOM
- @vitejs/plugin-react (JSX transform for electron-vite)
- Zustand v5 (状态管理，slices pattern，TypeScript)
- react-i18next (替代 data-i18n 属性)
- Tailwind CSS 3 (保持现有样式)
- Vitest + @testing-library/react (测试)

**参考文档 (via Context7):**
- electron-vite React 配置: `/alex8088/electron-vite-docs`
- React hooks & patterns: `/reactjs/react.dev`
- Zustand slices pattern: `/pmndrs/zustand`
- react-i18next useTranslation: `/i18next/react-i18next`

---

## Phase 0: 基础设施搭建

### Task 1: 安装 React 依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装 React 核心依赖**

Run:
```bash
cd D:\tecx\text\temp-ai-image-master-source
npm install react react-dom zustand react-i18next i18next
npm install -D @types/react @types/react-dom @vitejs/plugin-react
```

**Step 2: 验证安装成功**

Run: `npm ls react react-dom zustand`
Expected: 显示已安装版本，无 UNMET PEER DEPENDENCY 错误

**Step 3: Commit**
```bash
git add package.json package-lock.json
git commit -m "deps: add React 18, Zustand, react-i18next"
```

---

### Task 2: 配置 electron-vite React 支持

**Files:**
- Modify: `electron.vite.config.ts`
- Create: `src/renderer/src/react-app/main.tsx` (React 入口)

**Step 1: 修改 electron.vite.config.ts — 添加 React 插件**

```typescript
// electron.vite.config.ts
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

const isAnalyze = process.env.npm_lifecycle_event === 'analyze' || process.argv.includes('--mode=analyze')
const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      target: 'node18',
      minify: isProd,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      target: 'node18',
      minify: isProd,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],  // <-- 新增 React 插件
    build: {
      outDir: 'dist/renderer',
      target: 'chrome120',
      cssCodeSplit: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        },
        output: {
          manualChunks: (id: string) => {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) {
                return 'vendor-react'
              }
              if (id.includes('zustand')) return 'vendor-zustand'
              if (id.includes('i18next') || id.includes('react-i18next')) return 'vendor-i18n'
              if (id.includes('choices.js')) return 'vendor-choices'
              if (id.includes('jszip')) return 'vendor-jszip'
              return 'vendor'
            }
            // React 组件 chunk
            if (id.includes('src/renderer/src/react-app')) return 'react-director'
            // 保留原有 chunk 策略
            if (id.includes('src/renderer/src/core') ||
                id.includes('src/renderer/src/services') ||
                id.includes('src/renderer/src/features/history') ||
                id.includes('src/renderer/src/pages/DirectorPage') ||
                id.includes('src/renderer/src/pages/HistoryPage')) {
              return 'core-services'
            }
            if (id.includes('src/renderer/src/pages/UnderstandPage')) return 'page-understand'
            if (id.includes('src/renderer/src/pages/BasePage')) return 'page-base'
            if (id.includes('src/renderer/src/utils')) return 'utils'
            return undefined
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      },
      minify: true,
      chunkSizeWarningLimit: 500,
      sourcemap: isAnalyze ? true : false,
      reportCompressedSize: !isProd,
      esbuild: {
        drop: isProd ? ['console', 'debugger'] : [],
        legalComments: 'none'
      }
    },
    server: {
      warmup: {
        clientFiles: [
          './src/main.ts',
          './src/react-app/main.tsx',
          './src/services/ServiceBridge.ts'
        ]
      }
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'zustand', 'choices.js', 'jszip']
    },
    resolve: {
      alias: {
        'node:async_hooks': resolve(__dirname, 'src/renderer/src/shims/async-hooks-shim.ts'),
        '@': resolve(__dirname, 'src/renderer/src'),
        '@react': resolve(__dirname, 'src/renderer/src/react-app'),
        '@core': resolve(__dirname, 'src/renderer/src/core'),
        '@services': resolve(__dirname, 'src/renderer/src/services'),
        '@features': resolve(__dirname, 'src/renderer/src/features'),
        '@pages': resolve(__dirname, 'src/renderer/src/pages'),
        '@utils': resolve(__dirname, 'src/renderer/src/utils'),
        '@types': resolve(__dirname, 'src/types'),
        '@skills': resolve(__dirname, 'skills')
      }
    }
  }
})
```

**Step 2: 创建 tsconfig 允许 JSX**

确认 `tsconfig.json` 中有:
```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

**Step 3: 验证 dev server 启动正常**

Run: `npm run dev`
Expected: 无编译错误，应用正常加载

**Step 4: Commit**
```bash
git add electron.vite.config.ts tsconfig.json
git commit -m "config: enable React plugin in electron-vite renderer"
```

---

### Task 3: 创建 React 挂载点 (渐进式桥接)

**Files:**
- Modify: `dist/renderer/index.html` (在 directorPanel 中添加 React 根节点)
- Create: `src/renderer/src/react-app/main.tsx`
- Create: `src/renderer/src/react-app/DirectorApp.tsx`

**核心策略：** 不替换整个 index.html，而是在 `#directorPanel` 内部添加一个 `<div id="director-react-root">` 作为 React 挂载点。原有的静态 HTML 逐步被 React 组件替代。

**Step 1: 在 index.html 的 directorPanel 中添加 React 挂载点**

找到 `<div id="directorPanel" ...>` 区域，在其内部（替换原有内容）添加:
```html
<div id="director-react-root"></div>
```

**Step 2: 创建 React 入口文件**

```typescript
// src/renderer/src/react-app/main.tsx
import { createRoot, Root } from 'react-dom/client'
import { DirectorApp } from './DirectorApp'

let root: Root | null = null

export function mountDirectorReact(): void {
  const container = document.getElementById('director-react-root')
  if (!container) {
    console.warn('[React] director-react-root not found')
    return
  }
  if (!root) {
    root = createRoot(container)
  }
  root.render(<DirectorApp />)
  console.log('[React] DirectorApp mounted')
}

export function unmountDirectorReact(): void {
  if (root) {
    root.unmount()
    root = null
    console.log('[React] DirectorApp unmounted')
  }
}
```

**Step 3: 创建 DirectorApp 占位组件**

```tsx
// src/renderer/src/react-app/DirectorApp.tsx
export function DirectorApp() {
  return (
    <div className="text-white p-4">
      <h2 className="text-xl font-bold mb-4">
        🎬 Director Mode (React)
      </h2>
      <p className="opacity-50">React 组件挂载成功</p>
    </div>
  )
}
```

**Step 4: 在 ServiceBridge 或 TabManager 中集成 React 挂载**

当 tab 切换到 director 时调用 `mountDirectorReact()`，切走时调用 `unmountDirectorReact()`。

在合适的位置（如现有的 tab 切换逻辑中）加入:
```typescript
import { mountDirectorReact, unmountDirectorReact } from '../react-app/main'

// 切换到 director tab 时
mountDirectorReact()

// 切走时
unmountDirectorReact()
```

**Step 5: 运行验证**

Run: `npm run dev`
Expected: 切换到导演模式 tab 时，看到 "Director Mode (React)" 文字

**Step 6: Commit**
```bash
git add -A
git commit -m "feat: add React mount point for Director page (progressive migration)"
```

---

## Phase 1: 状态管理层 (Zustand Store)

### Task 4: 创建 Director Zustand Store

**Files:**
- Create: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: 写失败的测试**

```typescript
// src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useDirectorStore } from '../useDirectorStore'

describe('useDirectorStore', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should have correct initial state', () => {
    const state = useDirectorStore.getState()
    expect(state.referenceImages).toEqual([])
    expect(state.isGenerating).toBe(false)
    expect(state.currentLayout).toBe('6grid')
    expect(state.currentRatio).toBe('3:2')
    expect(state.currentResolution).toBe('2K')
    expect(state.currentTemplate).toBeNull()
    expect(state.visionModel).toBe('')
    expect(state.sceneDescription).toBe('')
  })

  it('should add reference image', () => {
    const image = { data: 'base64data', mimeType: 'image/jpeg', name: 'test.jpg' }
    useDirectorStore.getState().addReferenceImage(image)
    expect(useDirectorStore.getState().referenceImages).toHaveLength(1)
    expect(useDirectorStore.getState().referenceImages[0]).toEqual(image)
  })

  it('should remove reference image by index', () => {
    const img1 = { data: 'a', mimeType: 'image/jpeg', name: '1.jpg' }
    const img2 = { data: 'b', mimeType: 'image/jpeg', name: '2.jpg' }
    useDirectorStore.getState().addReferenceImage(img1)
    useDirectorStore.getState().addReferenceImage(img2)
    useDirectorStore.getState().removeReferenceImage(0)
    expect(useDirectorStore.getState().referenceImages).toHaveLength(1)
    expect(useDirectorStore.getState().referenceImages[0].name).toBe('2.jpg')
  })

  it('should clear all reference images', () => {
    useDirectorStore.getState().addReferenceImage({ data: 'a', mimeType: 'image/jpeg', name: '1.jpg' })
    useDirectorStore.getState().clearReferenceImages()
    expect(useDirectorStore.getState().referenceImages).toEqual([])
  })

  it('should set layout', () => {
    useDirectorStore.getState().setLayout('4grid')
    expect(useDirectorStore.getState().currentLayout).toBe('4grid')
  })

  it('should set generation state', () => {
    useDirectorStore.getState().setIsGenerating(true)
    expect(useDirectorStore.getState().isGenerating).toBe(true)
  })

  it('should enforce max 8 reference images', () => {
    for (let i = 0; i < 10; i++) {
      useDirectorStore.getState().addReferenceImage({
        data: `img${i}`, mimeType: 'image/jpeg', name: `${i}.jpg`
      })
    }
    expect(useDirectorStore.getState().referenceImages).toHaveLength(8)
  })
})
```

**Step 2: 运行测试验证失败**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: FAIL — module not found

**Step 3: 实现 Zustand Store (Slices Pattern)**

```typescript
// src/renderer/src/react-app/stores/useDirectorStore.ts
import { create, StateCreator } from 'zustand'

// ===== Types =====

export interface DirectorReferenceImage {
  data: string
  mimeType: string
  name: string
}

export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid'
export type GenerationMode = 'single' | 'multi'

export interface GeneratedResult {
  success: boolean
  imageData?: string
  error?: string
  prompt: string
  index: number
}

// ===== Slices =====

interface ImageSlice {
  referenceImages: DirectorReferenceImage[]
  addReferenceImage: (img: DirectorReferenceImage) => void
  removeReferenceImage: (index: number) => void
  clearReferenceImages: () => void
}

interface GenerationSlice {
  isGenerating: boolean
  isProcessingFiles: boolean
  generatedResults: GeneratedResult[]
  lastAnalysisResult: string | null
  lastCharacterAnchor: string | null
  setIsGenerating: (val: boolean) => void
  setIsProcessingFiles: (val: boolean) => void
  setGeneratedResults: (results: GeneratedResult[]) => void
  setLastAnalysisResult: (result: string | null) => void
}

interface ConfigSlice {
  currentLayout: LayoutType
  currentTemplate: string | null
  currentMode: GenerationMode
  currentRatio: string
  currentResolution: string
  sceneDescription: string
  visionModel: string
  imageModel: string
  setLayout: (layout: LayoutType) => void
  setTemplate: (template: string | null) => void
  setMode: (mode: GenerationMode) => void
  setRatio: (ratio: string) => void
  setResolution: (resolution: string) => void
  setSceneDescription: (desc: string) => void
  setVisionModel: (model: string) => void
}

interface ResetSlice {
  reset: () => void
}

type DirectorStore = ImageSlice & GenerationSlice & ConfigSlice & ResetSlice

const MAX_REFERENCE_IMAGES = 8

const createImageSlice: StateCreator<DirectorStore, [], [], ImageSlice> = (set, get) => ({
  referenceImages: [],
  addReferenceImage: (img) => set((state) => {
    if (state.referenceImages.length >= MAX_REFERENCE_IMAGES) return state
    return { referenceImages: [...state.referenceImages, img] }
  }),
  removeReferenceImage: (index) => set((state) => ({
    referenceImages: state.referenceImages.filter((_, i) => i !== index),
    lastCharacterAnchor: null,
  })),
  clearReferenceImages: () => set({
    referenceImages: [],
    lastCharacterAnchor: null,
  }),
})

const createGenerationSlice: StateCreator<DirectorStore, [], [], GenerationSlice> = (set) => ({
  isGenerating: false,
  isProcessingFiles: false,
  generatedResults: [],
  lastAnalysisResult: null,
  lastCharacterAnchor: null,
  setIsGenerating: (val) => set({ isGenerating: val }),
  setIsProcessingFiles: (val) => set({ isProcessingFiles: val }),
  setGeneratedResults: (results) => set({ generatedResults: results }),
  setLastAnalysisResult: (result) => set({ lastAnalysisResult: result }),
})

const createConfigSlice: StateCreator<DirectorStore, [], [], ConfigSlice> = (set) => ({
  currentLayout: '6grid',
  currentTemplate: null,
  currentMode: 'single',
  currentRatio: '3:2',
  currentResolution: '2K',
  sceneDescription: '',
  visionModel: '',
  imageModel: '',
  setLayout: (layout) => set({ currentLayout: layout }),
  setTemplate: (template) => set({ currentTemplate: template }),
  setMode: (mode) => set({ currentMode: mode }),
  setRatio: (ratio) => set({ currentRatio: ratio }),
  setResolution: (resolution) => set({ currentResolution: resolution }),
  setSceneDescription: (desc) => set({ sceneDescription: desc }),
  setVisionModel: (model) => set({ visionModel: model }),
})

const INITIAL_STATE: Omit<DirectorStore,
  'addReferenceImage' | 'removeReferenceImage' | 'clearReferenceImages' |
  'setIsGenerating' | 'setIsProcessingFiles' | 'setGeneratedResults' | 'setLastAnalysisResult' |
  'setLayout' | 'setTemplate' | 'setMode' | 'setRatio' | 'setResolution' |
  'setSceneDescription' | 'setVisionModel' | 'reset'
> = {
  referenceImages: [],
  isGenerating: false,
  isProcessingFiles: false,
  generatedResults: [],
  lastAnalysisResult: null,
  lastCharacterAnchor: null,
  currentLayout: '6grid',
  currentTemplate: null,
  currentMode: 'single',
  currentRatio: '3:2',
  currentResolution: '2K',
  sceneDescription: '',
  visionModel: '',
  imageModel: '',
}

export const useDirectorStore = create<DirectorStore>()((...args) => ({
  ...createImageSlice(...args),
  ...createGenerationSlice(...args),
  ...createConfigSlice(...args),
  reset: () => args[0](INITIAL_STATE),
}))
```

**Step 4: 运行测试验证通过**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: ALL PASS

**Step 5: Commit**
```bash
git add -A
git commit -m "feat: add Director Zustand store with slices pattern and tests"
```

---

## Phase 2: Custom Hooks (业务逻辑桥接)

### Task 5: 创建 useDirectorGeneration Hook

**Files:**
- Create: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`
- Test: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`

**Step 1: 写失败的测试**

```typescript
// src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('useDirectorGeneration', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should return canGenerate=false when no reference images', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(false)
  })

  it('should return canGenerate=true when images exist and not generating', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'test', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(true)
  })

  it('should return canGenerate=false when isGenerating', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'test', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    useDirectorStore.getState().setIsGenerating(true)
    const { result } = renderHook(() => useDirectorGeneration())
    expect(result.current.canGenerate).toBe(false)
  })

  it('should provide getLayoutConfig', () => {
    const { result } = renderHook(() => useDirectorGeneration())
    const config = result.current.getLayoutConfig('6grid')
    expect(config).toEqual({ rows: 2, cols: 3, panelCount: 6 })
  })
})
```

**Step 2: 运行测试验证失败**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`
Expected: FAIL

**Step 3: 实现 Hook**

```typescript
// src/renderer/src/react-app/hooks/useDirectorGeneration.ts
import { useCallback } from 'react'
import { useDirectorStore, type LayoutType } from '../stores/useDirectorStore'
import type { PipelineProgress } from '@/services/pipeline/types'

const LAYOUT_CONFIGS: Record<string, { rows: number; cols: number; panelCount: number }> = {
  '2closeup': { rows: 1, cols: 2, panelCount: 2 },
  '4grid': { rows: 2, cols: 2, panelCount: 4 },
  '6grid': { rows: 2, cols: 3, panelCount: 6 },
  '9grid': { rows: 3, cols: 3, panelCount: 9 },
}

export function useDirectorGeneration() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const visionModel = useDirectorStore((s) => s.visionModel)
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)
  const setIsGenerating = useDirectorStore((s) => s.setIsGenerating)
  const setGeneratedResults = useDirectorStore((s) => s.setGeneratedResults)
  const setLastAnalysisResult = useDirectorStore((s) => s.setLastAnalysisResult)

  const canGenerate = referenceImages.length > 0 && !isGenerating

  const getLayoutConfig = useCallback((layout?: string) => {
    return LAYOUT_CONFIGS[layout || currentLayout] || LAYOUT_CONFIGS['6grid']
  }, [currentLayout])

  const startGeneration = useCallback(async (
    onProgress?: (progress: PipelineProgress) => void,
    styleInstructions?: string,
  ) => {
    if (!canGenerate) return

    setIsGenerating(true)
    try {
      const { getDirectorPipelineService } = await import('@/services/ServiceBridge')
      const pipeline = await getDirectorPipelineService(visionModel)
      if (!pipeline) throw new Error('Pipeline 服务不可用')

      const result = await pipeline.execute(
        {
          inputImages: referenceImages.map((img) => ({
            data: img.data,
            mimeType: img.mimeType,
          })),
          sceneDescription,
          layout: getLayoutConfig(),
          template: currentTemplate || 'default',
          styleInstructions: styleInstructions || '',
          ratio: currentRatio,
          resolution: currentResolution,
        },
        onProgress || (() => {}),
      )

      if (result.scene) {
        setLastAnalysisResult(JSON.stringify(result.scene, null, 2))
      }

      setGeneratedResults(
        result.images.map((img: any, i: number) => ({
          success: !!img.url && !img.error,
          imageData: img.url,
          error: img.error,
          prompt: img.prompt,
          index: img.id ?? i,
        }))
      )

      return result
    } finally {
      setIsGenerating(false)
    }
  }, [canGenerate, referenceImages, visionModel, sceneDescription, currentLayout, currentTemplate, currentRatio, currentResolution, getLayoutConfig, setIsGenerating, setGeneratedResults, setLastAnalysisResult])

  return {
    canGenerate,
    isGenerating,
    startGeneration,
    getLayoutConfig,
  }
}
```

**Step 4: 运行测试验证通过**

Run: `npx vitest run src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`
Expected: ALL PASS

**Step 5: Commit**
```bash
git add -A
git commit -m "feat: add useDirectorGeneration hook bridging Pipeline service"
```

---

## Phase 3: React 组件树

### Task 6: ReferenceImageUpload 组件

**Files:**
- Create: `src/renderer/src/react-app/components/ReferenceImageUpload.tsx`
- Test: `src/renderer/src/react-app/components/__tests__/ReferenceImageUpload.test.tsx`

**Step 1: 写失败的测试**

```tsx
// src/renderer/src/react-app/components/__tests__/ReferenceImageUpload.test.tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReferenceImageUpload } from '../ReferenceImageUpload'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('ReferenceImageUpload', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should show upload prompt when no images', () => {
    render(<ReferenceImageUpload />)
    expect(screen.getByText(/点击或拖拽上传参考图/)).toBeTruthy()
  })

  it('should show image count when images exist', () => {
    useDirectorStore.getState().addReferenceImage({
      data: 'base64', mimeType: 'image/jpeg', name: 'test.jpg'
    })
    render(<ReferenceImageUpload />)
    expect(screen.getByText(/1\/8/)).toBeTruthy()
  })
})
```

**Step 2: 运行测试验证失败**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/ReferenceImageUpload.test.tsx`
Expected: FAIL

**Step 3: 实现组件**

```tsx
// src/renderer/src/react-app/components/ReferenceImageUpload.tsx
import { useCallback, useRef, type DragEvent } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

const MAX_IMAGES = 8

export function ReferenceImageUpload() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const addReferenceImage = useDirectorStore((s) => s.addReferenceImage)
  const removeReferenceImage = useDirectorStore((s) => s.removeReferenceImage)
  const clearReferenceImages = useDirectorStore((s) => s.clearReferenceImages)
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (useDirectorStore.getState().referenceImages.length >= MAX_IMAGES) break

      const base64 = await fileToBase64(file)
      addReferenceImage({ data: base64, mimeType: file.type, name: file.name })
    }
  }, [addReferenceImage])

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
    if (files.length > 0) processFiles(files)
  }, [processFiles])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) processFiles(files)
    if (inputRef.current) inputRef.current.value = ''
  }, [processFiles])

  const triggerUpload = useCallback(() => {
    if (isGenerating) return
    inputRef.current?.click()
  }, [isGenerating])

  if (referenceImages.length === 0) {
    return (
      <div className="bg-[#27272A] rounded-none p-4">
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-image mr-2 text-blue-400" />
          <span>参考图</span>
        </h3>
        <div
          role="button"
          tabIndex={0}
          onClick={triggerUpload}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-white border-opacity-30 rounded-none p-6 text-center cursor-pointer hover:border-opacity-50 hover:bg-white hover:bg-opacity-5 transition-all focus:outline-none focus:border-[#FCE300]"
        >
          <i className="fas fa-cloud-upload-alt text-4xl text-white opacity-50 mb-3" />
          <p className="text-white opacity-70 mb-2">点击或拖拽上传参考图</p>
          <p className="text-white opacity-50 text-sm">支持 JPG、PNG、WebP 格式，最多8张</p>
        </div>
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
      </div>
    )
  }

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-white text-sm opacity-70">
          <i className="fas fa-images mr-1" />
          参考图 ({referenceImages.length}/{MAX_IMAGES})
        </span>
        {referenceImages.length > 1 && (
          <button onClick={clearReferenceImages} className="text-red-400 hover:text-red-300 text-xs transition-colors">
            <i className="fas fa-trash-alt mr-1" />清空全部
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2 mb-3">
        {referenceImages.map((img, index) => (
          <div key={`${img.name}-${index}`} className="relative group aspect-square">
            <img
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={img.name}
              className="w-full h-full object-cover rounded-lg"
            />
            <button
              onClick={() => removeReferenceImage(index)}
              className="absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              <i className="fas fa-times text-white text-xs" />
            </button>
          </div>
        ))}
        {referenceImages.length < MAX_IMAGES && (
          <div
            onClick={triggerUpload}
            className="aspect-square border-2 border-dashed border-gray-500 rounded-lg flex items-center justify-center cursor-pointer hover:border-pink-500 transition-colors"
          >
            <i className="fas fa-plus text-gray-400" />
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
    </div>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
```

**Step 4: 运行测试验证通过**

Run: `npx vitest run src/renderer/src/react-app/components/__tests__/ReferenceImageUpload.test.tsx`
Expected: ALL PASS

**Step 5: Commit**
```bash
git add -A
git commit -m "feat: add ReferenceImageUpload React component"
```

---

### Task 7: LayoutSelector 组件

**Files:**
- Create: `src/renderer/src/react-app/components/LayoutSelector.tsx`

**Step 1: 实现组件**

```tsx
// src/renderer/src/react-app/components/LayoutSelector.tsx
import { useDirectorStore, type LayoutType } from '../stores/useDirectorStore'

const LAYOUTS: { key: LayoutType; icon: string; label: string; grid: string }[] = [
  { key: '2closeup', icon: '⬜⬜', label: '2格特写', grid: '1×2' },
  { key: '4grid', icon: '⬜⬜\n⬜⬜', label: '4格宫格', grid: '2×2' },
  { key: '6grid', icon: '⬜⬜⬜\n⬜⬜⬜', label: '6格宫格', grid: '2×3' },
  { key: '9grid', icon: '⬜⬜⬜\n⬜⬜⬜\n⬜⬜⬜', label: '9格宫格', grid: '3×3' },
]

export function LayoutSelector() {
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const setLayout = useDirectorStore((s) => s.setLayout)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold mb-3 flex items-center">
        <i className="fas fa-th mr-2 text-green-400" />
        <span>布局选择</span>
      </h3>
      <div className="grid grid-cols-4 gap-2">
        {LAYOUTS.map((layout) => {
          const isSelected = currentLayout === layout.key
          return (
            <button
              key={layout.key}
              onClick={() => setLayout(layout.key)}
              className={`layout-card p-3 rounded-none text-center transition-all cursor-pointer ${
                isSelected
                  ? 'bg-blue-500 bg-opacity-30 ring-2 ring-blue-400'
                  : 'bg-[#09090B] border border-[#3F3F46] hover:bg-white hover:bg-opacity-5'
              }`}
            >
              <div className="text-white text-xs font-mono mb-1">{layout.grid}</div>
              <div className="text-white text-xs opacity-70">{layout.label}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

**Step 2: Commit**
```bash
git add -A
git commit -m "feat: add LayoutSelector React component"
```

---

### Task 8: GenerationProgress 组件

**Files:**
- Create: `src/renderer/src/react-app/components/GenerationProgress.tsx`

**Step 1: 实现组件**

```tsx
// src/renderer/src/react-app/components/GenerationProgress.tsx
import { useState, useCallback } from 'react'
import type { PipelineProgress, PassCardData } from '@/services/pipeline/types'

const PASS_LABELS = [
  'Pass 1: 图像深度分析',
  'Pass 2: 角色锚点提取',
  'Pass 3: 分镜镜头设计',
  'Pass 4: 提示词组装',
  'Pass 5: 一致性校验',
  'Pass 6: 图像生成',
]

const PASS_ICONS = ['🔍', '👤', '🎬', '🔗', '✅', '🖼️']

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

export function GenerationProgress() {
  const [passStatuses, setPassStatuses] = useState<PassStatus[]>(
    PASS_LABELS.map(() => 'pending')
  )
  const [passCards, setPassCards] = useState<PassCardData[]>([])
  const [currentLabel, setCurrentLabel] = useState('')
  const [percentage, setPercentage] = useState(0)

  const onProgress = useCallback((progress: PipelineProgress) => {
    setCurrentLabel(progress.label)

    setPassStatuses((prev) => {
      const next = [...prev]
      if (progress.status === 'completed') {
        next[progress.pass - 1] = 'completed'
        if (progress.pass < PASS_LABELS.length) {
          next[progress.pass] = 'running'
        }
      } else {
        next[progress.pass - 1] = progress.status === 'retrying' ? 'retrying' : 'running'
      }
      return next
    })

    const completedCount = passStatuses.filter((s) => s === 'completed').length + (progress.status === 'completed' ? 1 : 0)
    setPercentage((completedCount / progress.totalPasses) * 100)

    if (progress.passData && progress.status === 'completed') {
      setPassCards((prev) => [...prev, progress.passData!])
    }
  }, [passStatuses])

  return {
    onProgress,
    ProgressUI: (
      <div className="text-center py-8">
        <div className="relative inline-block mb-4">
          <i className="fas fa-film text-6xl text-white opacity-30 animate-pulse" />
        </div>
        <p className="text-white text-lg mb-2">{currentLabel || '正在启动 6-Pass 导演管线...'}</p>
        <div className="w-64 h-2 bg-white bg-opacity-20 rounded-full mx-auto overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full transition-all duration-500"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div className="mt-6 max-w-lg mx-auto space-y-2 text-left">
          {PASS_LABELS.map((label, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <span className="text-xl">{PASS_ICONS[i]}</span>
              <span className="text-white opacity-70">{label}</span>
              <span className={`ml-auto ${
                passStatuses[i] === 'completed' ? 'text-green-400' :
                passStatuses[i] === 'running' ? 'text-yellow-400 animate-pulse' :
                passStatuses[i] === 'retrying' ? 'text-orange-400 animate-pulse' :
                'text-white opacity-30'
              }`}>
                {passStatuses[i] === 'completed' ? '✓ 完成' :
                 passStatuses[i] === 'running' ? '⏳ 进行中...' :
                 passStatuses[i] === 'retrying' ? '🔄 精修中...' :
                 '等待中'}
              </span>
            </div>
          ))}
        </div>
        {passCards.length > 0 && (
          <div className="mt-4 max-w-lg mx-auto space-y-2 text-left">
            {passCards.map((card) => (
              <div key={card.pass} className="p-3 bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg">
                <div className="text-sm text-blue-300 font-medium mb-1">
                  {PASS_ICONS[card.pass - 1]} Pass {card.pass}: {card.label}
                </div>
                <p className="text-white text-opacity-70 text-sm">{card.summary}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  }
}
```

**Step 2: Commit**
```bash
git add -A
git commit -m "feat: add GenerationProgress React component"
```

---

### Task 9: ResultsGallery 组件

**Files:**
- Create: `src/renderer/src/react-app/components/ResultsGallery.tsx`

**Step 1: 实现组件**

```tsx
// src/renderer/src/react-app/components/ResultsGallery.tsx
import { useState, useCallback } from 'react'
import { useDirectorStore, type GeneratedResult } from '../stores/useDirectorStore'

export function ResultsGallery() {
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const [currentIndex, setCurrentIndex] = useState(0)

  const successResults = generatedResults.filter((r) => r.success)
  if (successResults.length === 0) return null

  const current = generatedResults[currentIndex]
  const imageSrc = current?.imageData?.startsWith('data:') || current?.imageData?.startsWith('http')
    ? current.imageData
    : `data:image/png;base64,${current?.imageData}`

  const navigate = useCallback((dir: number) => {
    let idx = currentIndex + dir
    const len = generatedResults.length
    let attempts = 0
    while (attempts < len) {
      if (idx < 0) idx = len - 1
      if (idx >= len) idx = 0
      if (generatedResults[idx].success) {
        setCurrentIndex(idx)
        return
      }
      idx += dir
      attempts++
    }
  }, [currentIndex, generatedResults])

  const downloadImage = useCallback((src: string, filename: string) => {
    const a = document.createElement('a')
    a.href = src
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-white">
        <span className="opacity-70">
          <i className="fas fa-images mr-2" />
          成功 {successResults.length}/{generatedResults.length} 张
        </span>
        <span className="text-sm opacity-50">第 {currentIndex + 1}/{generatedResults.length} 张</span>
      </div>

      {current?.success && current.imageData && (
        <div className="relative group">
          <img src={imageSrc} alt={`漫画分镜 ${currentIndex + 1}`} className="w-full rounded-lg shadow-lg" />
          <button
            onClick={() => navigate(-1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center"
          >
            <i className="fas fa-chevron-left" />
          </button>
          <button
            onClick={() => navigate(1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center"
          >
            <i className="fas fa-chevron-right" />
          </button>
        </div>
      )}

      <div className="flex space-x-2 overflow-x-auto pb-2">
        {generatedResults.map((result, i) => (
          <div
            key={i}
            onClick={() => result.success && setCurrentIndex(i)}
            className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
              i === currentIndex ? 'border-blue-400 ring-2 ring-blue-400' : 'border-transparent opacity-60 hover:opacity-100'
            } ${!result.success ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            {result.success && result.imageData ? (
              <img
                src={result.imageData.startsWith('data:') || result.imageData.startsWith('http') ? result.imageData : `data:image/png;base64,${result.imageData}`}
                alt={`#${i + 1}`}
                className="w-16 h-16 object-cover"
              />
            ) : (
              <div className="w-16 h-16 bg-red-500 bg-opacity-20 flex items-center justify-center">
                <i className="fas fa-times text-red-400" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-center space-x-4">
        <button
          onClick={() => current?.imageData && downloadImage(imageSrc!, `comic-panel-${currentIndex + 1}-${Date.now()}.png`)}
          className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors text-sm"
        >
          <i className="fas fa-download mr-2" />下载当前
        </button>
        <button className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm">
          <i className="fas fa-file-archive mr-2" />下载全部 ({successResults.length})
        </button>
      </div>
    </div>
  )
}
```

**Step 2: Commit**
```bash
git add -A
git commit -m "feat: add ResultsGallery React component"
```

---

### Task 10: 组装 DirectorApp 完整页面

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`
- Create: `src/renderer/src/react-app/components/SceneInput.tsx`
- Create: `src/renderer/src/react-app/components/GenerateButton.tsx`
- Create: `src/renderer/src/react-app/components/ModeSelector.tsx`

**Step 1: 创建 SceneInput**

```tsx
// src/renderer/src/react-app/components/SceneInput.tsx
import { useDirectorStore } from '../stores/useDirectorStore'

export function SceneInput() {
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold mb-3 flex items-center">
        <i className="fas fa-pen-fancy mr-2 text-purple-400" />
        <span>场景描述（可选）</span>
      </h3>
      <textarea
        value={sceneDescription}
        onChange={(e) => setSceneDescription(e.target.value)}
        rows={4}
        placeholder="描述场景内容、角色动作、氛围..."
        className="w-full p-3 rounded-none bg-[#09090B] border border-[#3F3F46] text-white placeholder-white placeholder-opacity-30 focus:border-opacity-50 focus:outline-none resize-y text-sm"
      />
    </div>
  )
}
```

**Step 2: 创建 GenerateButton**

```tsx
// src/renderer/src/react-app/components/GenerateButton.tsx
import { useDirectorStore } from '../stores/useDirectorStore'

export function GenerateButton({ onGenerate }: { onGenerate: () => void }) {
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const disabled = isGenerating || referenceImages.length === 0

  return (
    <button
      onClick={onGenerate}
      disabled={disabled}
      className="w-full bg-[#FCE300] text-black py-3 px-6 rounded-none font-bold uppercase tracking-tighter transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
    >
      {isGenerating ? (
        <><i className="fas fa-spinner fa-spin mr-2" />生成中...</>
      ) : (
        <><i className="fas fa-wand-magic-sparkles mr-2" />一键生成漫画分镜</>
      )}
    </button>
  )
}
```

**Step 3: 组装 DirectorApp**

```tsx
// src/renderer/src/react-app/DirectorApp.tsx
import { useState, useCallback } from 'react'
import { ReferenceImageUpload } from './components/ReferenceImageUpload'
import { LayoutSelector } from './components/LayoutSelector'
import { SceneInput } from './components/SceneInput'
import { GenerateButton } from './components/GenerateButton'
import { GenerationProgress } from './components/GenerationProgress'
import { ResultsGallery } from './components/ResultsGallery'
import { useDirectorGeneration } from './hooks/useDirectorGeneration'
import { useDirectorStore } from './stores/useDirectorStore'

type ViewState = 'idle' | 'generating' | 'results'

export function DirectorApp() {
  const [viewState, setViewState] = useState<ViewState>('idle')
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const { startGeneration } = useDirectorGeneration()
  const progress = GenerationProgress()

  const handleGenerate = useCallback(async () => {
    setViewState('generating')
    try {
      await startGeneration(progress.onProgress)
      setViewState('results')
    } catch (error: any) {
      console.error('[DirectorApp] Generation failed:', error)
      setViewState('idle')
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error.message || '生成失败', 'error')
    }
  }, [startGeneration, progress.onProgress])

  return (
    <div className="relative z-10">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* 左侧：配置区 */}
        <div className="space-y-4">
          <ReferenceImageUpload />
          <LayoutSelector />
          <SceneInput />
          <GenerateButton onGenerate={handleGenerate} />
        </div>

        {/* 右侧：结果区 */}
        <div className="space-y-4">
          {viewState === 'idle' && generatedResults.length === 0 && (
            <div className="bg-[#27272A] rounded-none p-6 min-h-96 flex items-center justify-center">
              <div className="text-center text-white opacity-50">
                <i className="fas fa-film text-6xl mb-4 opacity-30" />
                <p>上传参考图并点击"一键生成"开始创作</p>
              </div>
            </div>
          )}
          {viewState === 'generating' && progress.ProgressUI}
          {(viewState === 'results' || generatedResults.length > 0) && viewState !== 'generating' && (
            <ResultsGallery />
          )}
        </div>
      </div>
    </div>
  )
}
```

**Step 4: 运行 dev 验证**

Run: `npm run dev`
Expected: 切换到导演模式，看到完整的 React UI：上传区、布局选择、场景输入、生成按钮

**Step 5: Commit**
```bash
git add -A
git commit -m "feat: assemble full DirectorApp with all React components"
```

---

## Phase 4: 集成与清理

### Task 11: 集成 Tab 切换与状态持久化

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts` (桥接 React mount/unmount)
- Modify: `src/renderer/src/react-app/main.tsx` (添加状态恢复)

**Step 1: 在 ServiceBridge 中桥接 React**

在创建 Director 页面的工厂函数附近，添加 React 桥接逻辑。当 tab 切换到 director 时，调用 `mountDirectorReact()`。

具体位置取决于 TabManager 的 tab 切换回调，在相应位置添加:
```typescript
// 当 activateTab('director') 时:
import { mountDirectorReact, unmountDirectorReact } from '../react-app/main'

// onActivate
mountDirectorReact()

// onDeactivate
unmountDirectorReact()
```

**Step 2: 添加状态持久化 (pageStateManager 桥接)**

```typescript
// 在 main.tsx 的 mountDirectorReact 中：
export function mountDirectorReact(): void {
  const container = document.getElementById('director-react-root')
  if (!container) return
  
  // 恢复状态
  const pm = (window as any).pageStateManager
  const saved = pm?.getState?.('director')
  if (saved) {
    const store = useDirectorStore.getState()
    if (saved.currentLayout) store.setLayout(saved.currentLayout)
    if (saved.currentTemplate !== undefined) store.setTemplate(saved.currentTemplate)
    if (saved.currentRatio) store.setRatio(saved.currentRatio)
    if (saved.currentResolution) store.setResolution(saved.currentResolution)
    if (saved.sceneDescription !== undefined) store.setSceneDescription(saved.sceneDescription)
    if (saved.visionModel) store.setVisionModel(saved.visionModel)
  }
  
  if (!root) root = createRoot(container)
  root.render(<DirectorApp />)
}

export function unmountDirectorReact(): void {
  // 保存状态
  const state = useDirectorStore.getState()
  const pm = (window as any).pageStateManager
  pm?.saveState?.('director', {
    currentLayout: state.currentLayout,
    currentTemplate: state.currentTemplate,
    currentRatio: state.currentRatio,
    currentResolution: state.currentResolution,
    sceneDescription: state.sceneDescription,
    visionModel: state.visionModel,
  })

  if (root) {
    root.unmount()
    root = null
  }
}
```

**Step 3: Commit**
```bash
git add -A
git commit -m "feat: integrate React Director with tab switching and state persistence"
```

---

### Task 12: 最终验证与清理

**Step 1: 运行所有测试**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误

**Step 3: 运行 dev 完整验证**

Run: `npm run dev`
验证清单:
- [ ] 应用正常启动
- [ ] 切换到导演模式 tab → React UI 渲染
- [ ] 上传参考图 → 图片预览正常
- [ ] 选择布局 → 选中高亮
- [ ] 输入场景描述 → 文字保存
- [ ] 点击生成按钮 → Pipeline 启动，进度显示
- [ ] 生成完成 → 结果图片显示
- [ ] 切换到其他 tab 再切回 → 状态恢复
- [ ] 其他页面（图像理解、生成等）不受影响

**Step 4: 构建验证**

Run: `npm run build:vite`
Expected: 构建成功，无错误

**Step 5: Final commit**
```bash
git add -A
git commit -m "feat: Director page React migration complete — Phase 1"
```

---

## 文件清单总览

| 操作 | 文件路径 |
|------|---------|
| Modify | `package.json` |
| Modify | `electron.vite.config.ts` |
| Modify | `tsconfig.json` |
| Modify | `dist/renderer/index.html` (directorPanel 区域) |
| Modify | `src/renderer/src/services/ServiceBridge.ts` |
| Create | `src/renderer/src/react-app/main.tsx` |
| Create | `src/renderer/src/react-app/DirectorApp.tsx` |
| Create | `src/renderer/src/react-app/stores/useDirectorStore.ts` |
| Create | `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts` |
| Create | `src/renderer/src/react-app/hooks/useDirectorGeneration.ts` |
| Create | `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts` |
| Create | `src/renderer/src/react-app/components/ReferenceImageUpload.tsx` |
| Create | `src/renderer/src/react-app/components/__tests__/ReferenceImageUpload.test.tsx` |
| Create | `src/renderer/src/react-app/components/LayoutSelector.tsx` |
| Create | `src/renderer/src/react-app/components/GenerationProgress.tsx` |
| Create | `src/renderer/src/react-app/components/ResultsGallery.tsx` |
| Create | `src/renderer/src/react-app/components/SceneInput.tsx` |
| Create | `src/renderer/src/react-app/components/GenerateButton.tsx` |

## 后续迁移路线 (Future Phases)

- **Phase 5:** 模板管理 → React 组件 (TemplateSelector, TemplateEditor)
- **Phase 6:** 示例图库 → React 组件 (ExampleGallery)
- **Phase 7:** 将 UnderstandPage 迁移到 React (同样模式)
- **Phase 8:** 抽取共享组件 (ImageUpload, ModelSelector, Toast Context)
- **Phase 9:** 引入 react-i18next 替代 data-i18n
- **Phase 10:** 移除旧版 DirectorPage.ts (4889行)
