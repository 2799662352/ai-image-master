# 批量页面迁移设计规格

> 将剩余 6 个 React 页面迁移到 store + typed hooks 架构，消除所有 `(window as any).aiImageAPI` 调用。

## 目标

SettingsPage 迁移验证了 playbook 模式（独立 store + `useApi()` facade + 子组件拆分 + 测试）。本 spec 将该模式批量应用到剩余 6 个页面，完成后 React 应用中零 `window as any` 调用。

## 当前状态审计

现有 `pages-react/` 中的 6 个页面均为 UI-only 存根，调用的 API 方法名与实际 `ServiceBridge` 桥接对象不匹配，**所有页面当前都无法正常工作**。本次迁移同时修复这些断裂的集成。

| 页面 | 当前调用 | 桥接实际方法 | 状态 |
|------|----------|-------------|------|
| GeneratePage | `api?.generate?.(...)` | `generateImage(params)` | 方法名不匹配 |
| BatchPage | `api?.generate?.(...)` | `generateImage(params)` | 方法名不匹配 |
| ComparePage | `api?.generateWithModel?.(model, prompt)` | 不存在 | 方法不存在 |
| HistoryPage | `api?.getHistory?.()` / `api?.deleteHistoryItem?.(id)` | 不在 `aiImageAPI` 上 | 方法不存在 |
| UnderstandPage | `api?.analyzeImage?.(...)` | `understandImage(params)` | 方法名不匹配 |
| PromptTemplatesPage | `api?.getPromptTemplates?.()` | 不在 `aiImageAPI` 上 | 方法不存在 |

迁移后，所有调用都通过 typed hooks（`useApi()` / `useHistory()` / `useTemplates()`）路由到正确的实现。

## 不做什么

- 不切换 Vite 入口（留给下一个 spec）
- 不删除旧代码（`index.html`、原页面）
- 不添加组件渲染测试（当前项目无 `@testing-library/react` 组件测试基础设施）
- 不实现 BatchPage 的任务取消/中断功能（YAGNI，原代码也没有）
- 不迁移 DirectorPage（空壳 stub，无逻辑可迁移）

## 1. Hook 层扩展

### 1.1 `useApi()` 新增方法

在 `src/renderer/src/hooks/useService.ts` 的 `ApiActions` 接口中新增：

```typescript
understandImage(params: VisionParams): Promise<VisionResult>
```

需同时更新 `ApiActions` 接口和 `useApi()` 函数体：

```typescript
// ApiActions 接口新增
understandImage(params: VisionParams): Promise<VisionResult>

// useApi() 函数体新增
understandImage: (p) => api.understandImage(p),
```

### 1.2 新建 `useHistory()` hook

文件: `src/renderer/src/hooks/useHistory.ts`

```typescript
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

export function useHistory(): HistoryActions
```

底层使用 localStorage，key 为 `image_history`。数据格式为 JSON 数组。

### 1.3 新建 `useTemplates()` hook

文件: `src/renderer/src/hooks/useTemplates.ts`

```typescript
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

export function useTemplates(): TemplateActions
```

底层读取 localStorage key `prompt_templates`，同步返回。

## 2. Store 设计

每页一个独立 Zustand store，遵循 SettingsPage 已验证的模式：
- 类型安全的 state + actions 接口
- Actions 接收服务实例参数（`ApiActions` / `HistoryActions` / `TemplateActions`），不直接调用 React hooks
- **新增约定**：每个 store 导出 `initialState` 常量以便测试 reset（改进原 SettingsStore 测试中硬编码初始值的做法）。实施完成后回补 `useSettingsStore` 使其一致
- 异步 action 内部管理 loading/error 状态转换
- 使用原子选择器 `useStore(s => s.field)` 消费
- 派生数据（过滤、计数）不放 store 里，用 `useMemo` 在组件层计算
- 所有异步 action 统一错误提取：`err instanceof Error ? err.message : String(err)`
- 输入校验（空 prompt、未选模型）保留在组件层用 toast 提示，store action 假定输入有效
- `GenerateResult` 返回值读取：优先 `result.urls`，fallback `result.images`（`result.urls ?? result.images ?? []`）

### 2.1 `useGenerateStore`

文件: `src/renderer/src/stores/useGenerateStore.ts`

```typescript
interface GenerateState {
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
```

`generate` action 调用 `api.generateImage({prompt, ratio, model: modelKey, referenceImages})`。成功时 set `resultUrls`，失败时 set `error`。

### 2.2 `useBatchStore`

文件: `src/renderer/src/stores/useBatchStore.ts`

```typescript
interface BatchItem {
  id: string          // crypto.randomUUID()
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  resultUrl?: string
  error?: string
}

interface BatchState {
  items: BatchItem[]
  running: boolean

  addItem: (prompt: string) => void
  removeItem: (id: string) => void
  bulkAdd: (text: string) => void
  clearAll: () => void
  runBatch: (api: ApiActions, modelKey: string) => Promise<void>
}
```

修复原代码的 `let nextId = 1` 问题，改用 `crypto.randomUUID()`。`runBatch` 内部顺序处理 pending 项，**必须从 `set` 回调参数读取最新 state**（避免闭包过期引用）：

```typescript
// 正确模式 — 从回调参数获取最新 items
set(state => ({
  items: state.items.map(i =>
    i.id === item.id ? { ...i, status: 'generating' } : i
  )
}))
```

### 2.3 `useCompareStore`

文件: `src/renderer/src/stores/useCompareStore.ts`

```typescript
interface CompareState {
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
```

`compare` 内部用 `Promise.allSettled` 并行调用 `api.generateImage({model: leftModelKey, prompt})` 和 `api.generateImage({model: rightModelKey, prompt})`。`ratio` 参数有意省略（使用 API 默认值，对比关注模型差异而非尺寸）。注意：当前页面调用的 `generateWithModel(model, prompt)` 方法不存在于桥接层，本次迁移修正为 `generateImage({model, prompt})`。组件层需在 react-select `ModelOption` 对象和 store 的 `string | null` key 之间做转换。

### 2.4 `useHistoryStore`

文件: `src/renderer/src/stores/useHistoryStore.ts`

```typescript
interface HistoryState {
  items: HistoryItem[]
  searchQuery: string
  error: string | null

  setSearchQuery: (q: string) => void
  loadHistory: (history: HistoryActions) => void
  deleteItem: (id: number, history: HistoryActions) => void
}
```

Action 接收 `HistoryActions`（来自 `useHistory()` hook）。`loadHistory` 和 `deleteItem` 都是同步操作（localStorage），因此不需要 `loading` 状态。过滤逻辑在组件中用 `useMemo` 计算。

### 2.5 `useUnderstandStore`

文件: `src/renderer/src/stores/useUnderstandStore.ts`

```typescript
interface UnderstandState {
  imageUrl: string | null
  question: string
  analysisResult: string
  analyzing: boolean
  error: string | null

  setImageUrl: (url: string | null) => void
  setQuestion: (q: string) => void
  analyze: (api: ApiActions) => Promise<void>
}
```

`analyze` 调用 `api.understandImage({images: [imageUrl], prompt: question})`。成功时读取 `result.content`（`VisionResult` 的正确字段）写入 `analysisResult`。注意：当前页面错误地读取 `.text`（undefined），本次迁移修正此问题。

### 2.6 `useTemplatesStore`

文件: `src/renderer/src/stores/useTemplatesStore.ts`

```typescript
interface TemplatesState {
  templates: Template[]
  searchQuery: string
  activeCategory: string

  loadTemplates: (templates: TemplateActions) => void
  setSearchQuery: (q: string) => void
  setActiveCategory: (cat: string) => void
}
```

Action 接收 `TemplateActions`（来自 `useTemplates()` hook）。过滤逻辑在组件中用 `useMemo` 完成。

## 3. 子组件拆分

Playbook 规则：页面文件 ≤ 200 行，超过则提取子组件。子组件全部是纯展示组件，通过 props 接收数据。

| 页面 | 子组件 | 职责 |
|------|--------|------|
| GeneratePage | `generate/RatioSelector.tsx` | 比例选择按钮组 |
| GeneratePage | `generate/ReferenceImageList.tsx` | 参考图预览+删除 |
| GeneratePage | `generate/ResultGrid.tsx` | 结果图片网格 |
| BatchPage | `batch/BatchItemRow.tsx` | 单个任务行（状态+预览+删除） |
| BatchPage | `batch/BulkAddPanel.tsx` | 批量导入文本区 |
| ComparePage | `compare/ModelPairSelector.tsx` | 双模型选择器（使用共享 `darkSelectStyles`） |
| HistoryPage | -- | 105 行，不需要拆 |
| UnderstandPage | -- | 96 行，不需要拆 |
| PromptTemplatesPage | -- | 109 行，不需要拆 |

### ComparePage 样式修复

移除 ComparePage 内联的 `selectStyles`（21 行），替换为 `import { darkSelectStyles } from '../../styles/selectTheme'`。注意 `darkSelectStyles` 是泛型函数，使用时需调用：`styles={darkSelectStyles<ModelOption>()}`。

## 4. 测试策略

### 4.1 Store 单元测试

每个 store 一个测试文件（`stores/__tests__/use<Page>Store.test.ts`），共 6 个。

- Mock `ApiActions` / `HistoryActions` / `TemplateActions` 接口
- 测试所有 action 包括 happy path 和 error path
- 使用导出的 `initialState` + `store.setState(initialState, true)` 在 `beforeEach` 中 reset
- 异步 action 测试 loading 状态转换

### 4.2 Hook 单元测试

2 个文件：
- `hooks/__tests__/useHistory.test.ts` -- mock localStorage，测试 CRUD
- `hooks/__tests__/useTemplates.test.ts` -- mock localStorage，测试读取

### 4.3 不做的测试

- 组件渲染测试（当前项目无基础设施，YAGNI）
- E2E 测试（不在范围内）

## 5. 成功标准

1. `pages-react/` 目录下零 `(window as any)` 调用
2. 6 个新 store 及其公共接口类型（`BatchItem`、`HistoryItem`、`Template` 等）全部从 `stores/index.ts` barrel 导出
3. `useApi()` 新增 `understandImage` 方法
4. `useHistory()` 和 `useTemplates()` 两个新 hook 创建完成
5. 所有 store + hook 单元测试通过（Vitest green）
6. TypeScript 编译无错误（`tsc --noEmit`）
7. ComparePage 使用共享 `darkSelectStyles`
8. 旧代码保留（不删除 `index.html`、原页面文件）

## 6. 未来改进（不在本 spec 范围）

- 回补 `useSettingsStore` 导出 `initialState` 常量，与新 store 约定一致
- BatchPage 任务取消/中断（AbortController）
- 组件渲染测试基础设施搭建
- Vite 入口切换到 `index-react.html`
- DirectorPage 实际功能实现
- History 数据迁移到 Electron Store（从 localStorage 迁出）
