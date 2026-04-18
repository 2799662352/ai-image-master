# React 架构修复 + SettingsPage 功能对等设计

> **日期**: 2026-04-18
> **状态**: Draft
> **前置**: `docs/superpowers/specs/2026-04-16-react-migration-design.md` (React 迁移设计)
> **范围**: Infrastructure fixes + SettingsPage 完整打样 + Migration Playbook

---

## 1. 背景

React 迁移的 Phase 0-3 已完成（17 commits, f24dbfa..bcf163b），建立了 Zustand stores、service hooks、lazy-loaded 页面骨架和双入口共存。

Code review 发现 4 个架构级问题：
1. 页面绕过 service hooks，直接使用 `(window as any).aiImageAPI`（11 处 / 7 个文件）
2. 计划中的 6 个页面级 stores 全部缺失
3. 页面功能覆盖率仅 10-15%
4. `useTabStore.switchTab` 含 `window.location.hash` 副作用

本 spec 的目标是修复架构基础并以 SettingsPage 为第一个 100% 功能对等的打样页面，为后续页面迁移建立可复用模式。

## 2. 目标

- 创建 typed `useApi()` hook 并在 SettingsPage 中验证，为后续页面消除 `(window as any).aiImageAPI` 铺路
- 修复 store 层的副作用和 ID 生成问题
- SettingsPage 达到与旧 `Settings.ts` / `SiteManager.ts` 完全功能对等
- 提取 Page Migration Playbook 供后续页面迁移复用

## 3. 不做什么

- 不迁移 SettingsPage 之外的其他页面（各自独立 spec）
- 不删除旧代码（保持回滚安全）
- 不新增旧版没有的功能

---

## 4. Infrastructure Fixes

### 4.1 Typed API Facade Hook

**文件**: `src/renderer/src/hooks/useService.ts`（修改）

在现有 hooks 文件中新增 `useApi()` facade hook。它包装 `ServiceRegistry` 中的 `ApiService`，返回一个 typed method object：

```typescript
export interface GenerateParams {
  prompt: string
  ratio: string
  model: string
  referenceImages?: string[]
}

export interface GenerateResult {
  urls: string[]
}

export interface SiteConfig {
  name: string
  baseURL: string
  description?: string
  isCustom?: boolean
  defaultApiKey?: string
}

export interface ApiActions {
  generate(params: GenerateParams): Promise<GenerateResult>
  testConnection(apiKey: string): Promise<boolean>
  saveApiKey(key: string): Promise<void>
  saveVisionApiKey(key: string): Promise<void>
  getAllSites(): Record<string, SiteConfig>
  switchSite(key: string): void
  getStoredApiKey(siteKey: string): string
  getCurrentSite(): SiteConfig | null
  getSiteConfig(key: string): SiteConfig | null
  get currentSite(): string
}

export function useApi(): ApiActions {
  const api = useApiService()
  return useMemo(() => ({
    generate: (p) => api.generate(p),
    testConnection: (k) => api.testConnection(k),
    saveApiKey: (k) => api.saveApiKey(k),
    saveVisionApiKey: (k) => api.saveVisionApiKey(k),
    getAllSites: () => api.getAllSites(),
    switchSite: (k) => api.switchSite(k),
    getStoredApiKey: (k) => api.getStoredApiKey(k),
    getCurrentSite: () => api.getCurrentSite(),
    getSiteConfig: (k) => api.getSiteConfig(k),
    get currentSite() { return api.currentSite },
  }), [api])
}
```

`ApiActions` 接口的方法签名从 `ApiService` 类的公开方法中提取。如果 `ApiService` 上缺少某个方法（如 `getAllSites`），需要先在 `ApiService` 中补齐（查看 `SiteManager` 上对应方法并委托调用）。

### 4.2 Shared Dark Select Theme

**文件**: `src/renderer/src/styles/selectTheme.ts`（新建）

基于 react-select 的 `StylesConfig<T>` 泛型，创建复用的 cyberpunk 暗色主题：

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

所有 react-select 使用点（`ModelSelector`、`ComparePage` 等）统一引用 `darkSelectStyles<OptionType>()`。

### 4.3 Tab Store Hash 副作用修复

**文件**: `src/renderer/src/stores/useTabStore.ts`（修改）, `src/renderer/src/layouts/AppLayout.tsx`（修改）

从 `switchTab` action 中删除 `window.location.hash = tab`。

在 `AppLayout.tsx` 中用 Zustand v5 的 `subscribe` with selector 订阅 hash 同步：

```typescript
useEffect(() => {
  const unsub = useTabStore.subscribe(
    (state) => state.activeTab,
    (tab) => { window.location.hash = tab }
  )
  return unsub
}, [])
```

同时在 `AppLayout` mount 时读取 `window.location.hash` 恢复 tab 状态：

```typescript
useEffect(() => {
  const hash = window.location.hash.slice(1)
  if (hash) useTabStore.getState().switchTab(hash)
}, [])
```

### 4.4 Toast ID 生成器修复

**文件**: `src/renderer/src/stores/useToastStore.ts`（修改）

删除模块级 `let toastId = 0` 计数器，改用 `crypto.randomUUID()`：

```typescript
addToast: (toast) => {
  const id = crypto.randomUUID()
  set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
  // ...
}
```

---

## 5. SettingsPage 完整打样

### 5.1 useSettingsStore

**文件**: `src/renderer/src/stores/useSettingsStore.ts`（新建）

```typescript
interface SettingsState {
  sites: Record<string, SiteConfig>
  activeSiteKey: string
  apiKeys: Record<string, string>
  visionApiKey: string
  connectionStatus: 'idle' | 'testing' | 'success' | 'error'
  saving: boolean

  loadFromService: (api: ApiActions) => void
  switchSite: (key: string, api: ApiActions) => void
  setApiKey: (key: string) => void
  setVisionApiKey: (key: string) => void
  testConnection: (api: ApiActions) => Promise<boolean>
  saveAll: (api: ApiActions) => Promise<void>
}
```

**设计决策：**

- **Actions 接收 `api` 参数**而非内部调用 hook — Zustand actions 在 store 创建时绑定，不能在内部调用 React hooks。所以 actions 接受 `ApiActions` 作为参数，由组件传入。
- **Store 只管 UI 状态** — `sites`/`apiKeys` 从 service 加载后缓存在 store，用户修改时更新 store，点"保存"时 `saveAll` 调用 `api.saveApiKey()` 持久化。
- **`connectionStatus` 状态机** — `idle → testing → success|error`。UI 根据此状态显示按钮文字和颜色。
- **不使用 `persist` middleware** — 设置数据已由 Electron Store 持久化（通过 ApiService），无需 Zustand 双重持久化。

### 5.2 SettingsPage 组件结构

```
pages-react/
  SettingsPage.tsx          ← 主页面 (~120 行), 编排子组件 + 调用 store actions
  settings/
    SiteGrid.tsx            ← 站点卡片网格 (~60 行)
    ApiKeyInput.tsx          ← API Key 输入框 + 显隐切换 (~50 行)
```

**SettingsPage.tsx 职责：**
- `useEffect` 内调用 `loadFromService(api)` 初始化
- 编排 `<SiteGrid>` → `<ApiKeyInput>` → Vision Key → Action Buttons
- 通过 `useSettingsStore` selector 读取状态
- 通过 store actions + `useApi()` 处理交互

**旧代码功能覆盖清单：**

| 旧功能 | 来源 | 新实现 |
|--------|------|--------|
| 站点列表展示 | `SiteManager.renderSiteCards()` | `<SiteGrid sites={} active={} onSelect={} />` |
| 站点切换 | `SiteManager.switchSite()` | `store.switchSite(key, api)` |
| API Key 输入 | `Settings.renderApiKeySection()` | `<ApiKeyInput value={} onChange={} />` |
| Key 显隐切换 | `Settings` inline | `<ApiKeyInput showToggle />` |
| Vision API Key | `Settings.renderVisionSection()` | 复用 `<ApiKeyInput>` |
| 连接测试 | `Settings.testConnection()` | `store.testConnection(api)` |
| 保存配置 | `Settings.saveSettings()` | `store.saveAll(api)` |
| 加载已保存 key | `SiteManager.getStoredApiKey()` | `store.loadFromService(api)` |

### 5.3 测试策略

1. **`useSettingsStore.test.ts`** — store 单元测试
   - `switchSite` 更新 `activeSiteKey` 和当前 `apiKey`
   - `testConnection` 正确转换 `connectionStatus` 状态
   - `saveAll` 调用 api 方法并处理异常
   - Mock `ApiActions` 接口

2. **`SettingsPage.test.tsx`** — 组件渲染测试
   - 站点卡片正确渲染
   - 点击卡片切换 active 状态
   - API Key 输入和显隐切换
   - 按钮在 testing/saving 时 disabled

3. **集成测试** — 完整流程
   - 选站点 → 输入 key → 测试连接 → 保存

### 5.4 数据流

```
User Action
    ↓
SettingsPage (React Component)
    ↓ reads via selector
useSettingsStore (Zustand)
    ↓ actions call api param
useApi() → ApiService (existing TS class)
    ↓
ServiceRegistry → Electron IPC → main process → Electron Store
```

---

## 6. Migration Playbook

### 6.1 产出物

**文件**: `docs/superpowers/references/page-migration-playbook.md`

在 SettingsPage 迁移完成后提取，内容基于实际经验而非预设：

1. **Store 创建模板** — state/actions 分离原则、TypeScript 接口模式、actions 接收 service 参数的模式
2. **Service Hook 使用规范** — `useApi()` 为主要入口、禁止 `(window as any)` 规则、何时用细粒度 hook
3. **组件拆分标准** — 页面文件 ≤200 行、子组件目录规范、shared vs page-specific 边界
4. **测试三件套** — store 单元测试 + 组件测试 + 集成测试的结构和 mock 模式
5. **完成验收 Checklist** — 类型安全、无 `window as any`、测试通过、功能对等

### 6.2 后续页面迁移顺序建议

每个页面独立 spec → plan → implementation 周期：

1. **ComparePage** — 结构简单，两个 model selector + 并排结果
2. **HistoryPage** — 引入 `@tanstack/react-virtual` + `react-masonry-css`
3. **BatchPage** — 队列状态管理，适合 `useReducer`
4. **PromptTemplatesPage** — 纯展示 + 过滤搜索
5. **GeneratePage** — 最复杂（进度追踪、参数面板、参考图裁剪），最后做
6. **UnderstandPage / DirectorPage** — 已有部分 React 代码，整合为主

---

## 7. 成功标准

- [ ] `useApi()` typed facade hook 创建并在 SettingsPage 中使用
- [ ] SettingsPage 中无 `(window as any).aiImageAPI` 调用
- [ ] `useTabStore.switchTab` 无副作用，hash 同步在组件层
- [ ] `useToastStore` 使用 `crypto.randomUUID()`
- [ ] react-select 暗色主题统一为 `darkSelectStyles()`
- [ ] `useSettingsStore` 测试全部通过
- [ ] SettingsPage 组件测试全部通过
- [ ] SettingsPage 功能与旧 `Settings.ts` 对等（站点切换、key 管理、连接测试、保存）
- [ ] Migration Playbook 文档完成
- [ ] 旧代码未被删除，回滚安全性不变

## 8. 技术参考

- **Zustand v5.0.12**: `persist` middleware with `partialize`, `subscribe` with selector, `createJSONStorage`
- **React 19.2.5**: `useSyncExternalStore` for external stores, `useTransition` for async state
- **react-select 5.10.2**: `StylesConfig<T>` typed styles, controlled value with `onChange`
- **Context7 文档拉取时间**: 2026-04-18
