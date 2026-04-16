# AI Image Master — 全面 React 迁移设计

> **日期**: 2026-04-16  
> **状态**: Draft  
> **方法**: React Shell 包裹 + 逐页组件化 (Big-Bang 全重写)

---

## 1. 背景与问题

当前 `ai-image-master` 渲染层是"vanilla DOM shell + React islands"的混合架构：

- **`index.html`** 约 2800 行，包含 ~500 行内联 CSS、~230 行内联 JS（intro video）
- **Pages**（`GeneratePage.ts`、`BatchPage.ts` 等）通过 `document.getElementById` / `innerHTML` / `addEventListener` 直接操作 DOM
- **Features**（`ModelSelectorManager.ts`、`TabManager.ts` 等）是命令式单例，绑定 DOM 事件
- **React islands**（`react-app/`）仅覆盖 "理解" 页面及少量组件（12 个 .tsx），通过 `ReactDOM.createRoot` 挂载到 DOM 容器
- **Choices.js** 等 vanilla 库通过 CDN 引入，需手动管理生命周期

这种混合架构导致：状态在多处分散（DOM attributes、localStorage、singleton fields、Zustand stores）、事件处理容易产生级联冲突（如模型选择器 bug）、TypeScript 类型覆盖不完整。

## 2. 目标

- 将整个渲染层迁移为纯 React 19 应用
- 升级所有核心依赖到 2026-04-16 最新版本
- 消除所有命令式 DOM 操作，统一为 React 声明式 UI
- 统一状态管理为 Zustand 5 stores
- 保持现有 UI 外观和交互逻辑不变
- 保留并复用纯业务逻辑层（Services）

## 3. 技术栈升级

| 依赖 | 当前版本 | 目标版本 | 升级说明 |
|------|---------|---------|---------|
| React | ^19.2.4 | **19.2.5** | 小版本，直接升级 |
| React DOM | ^19.2.4 | **19.2.5** | 随 React 一起 |
| Zustand | ^5.0.11 | **5.0.12** | persist middleware 修复 |
| Tailwind CSS | **^3.4.19** | **4.2.2** | 大版本：新引擎、CSS-first 配置、逻辑属性工具类 |
| Electron | **^28.0.0** | **41.2.0** | 大版本：Chromium 146、新 API |
| electron-vite | ^5.0.0 | **5.0.0** | 已是最新 |
| Vite | ^7.3.1 | **8.0.8** | 大版本：性能改进 |
| TypeScript | ^5.9.3 | **6.0.2** | 大版本：最后的 JS 编译器版本 |
| Choices.js | CDN | **移除** | 替换为 react-select 5.10.2 |
| Masonry (vanilla) | CDN | **移除** | 替换为 react-masonry-css |
| Cropper.js (vanilla) | CDN | **移除** | 替换为 react-cropper |

### Tailwind CSS 3 → 4 迁移要点

- `tailwind.config.js` 转为 CSS-first 配置 (`@theme` directive)
- `@apply` 仍受支持，但推荐直接使用工具类
- 部分 class 名变更需全局替换（如 `bg-opacity-*` → `bg-*/opacity`）
- 新增逻辑属性工具类 (`pbs-*`, `mbs-*` 等)

### Electron 28 → 41 迁移要点

- 多个废弃 API 需更新（查看 breaking changes per major）
- `contextBridge.exposeInMainWorld` 接口不变，preload 层影响较小
- Chromium 升级带来新 Web API 支持

## 4. 架构设计

### 4.1 整体架构：React Shell

```
┌──────────────────────────────────────────────┐
│  index.html  (仅 <div id="root">)            │
├──────────────────────────────────────────────┤
│  App.tsx                                      │
│  ├── AppProviders (Zustand, I18n, Theme)     │
│  ├── IntroVideo (条件渲染)                    │
│  ├── AppLayout                               │
│  │   ├── Sidebar / TabBar                    │
│  │   ├── ModelSelector                       │
│  │   └── PageContainer (由 activeTab 切换)   │
│  │       ├── <GeneratePage />                │
│  │       ├── <BatchPage />                   │
│  │       ├── <ComparePage />                 │
│  │       ├── <HistoryPage />                 │
│  │       ├── <UnderstandPage /> (已有 React) │
│  │       ├── <SettingsPage />                │
│  │       └── <PromptTemplates />             │
│  └── GlobalOverlays (Toast, Dialog, Modal)   │
└──────────────────────────────────────────────┘
```

**路由方式**: 不引入 React Router。保留现有 TabManager 的 tab 切换逻辑，将其转化为 Zustand store (`useTabStore`)，通过 `activeTab` 状态条件渲染对应页面组件。

**入口改造**: `index.html` 缩减为 ~30 行 (DOCTYPE + `<div id="root">` + `<script type="module" src="./src/main.tsx">`)。所有内联 CSS 和 JS 全部移除。

### 4.2 服务层适配

纯业务逻辑服务 **保持 TypeScript class 不变**，不需要改写为 React hook。它们通过一个薄的桥接层被 React 组件消费。

#### 保留不动的服务

| 服务 | 路径 | 说明 |
|------|------|------|
| `ApiService` | `services/api/ApiService.ts` | AI API 调用、模型管理 |
| `ImageCacheService` | `services/cache/ImageCacheService.ts` | 图片缓存 |
| `I18nService` | `services/i18n/I18nService.ts` | 国际化 |
| `R2StorageService` | `services/r2-storage/R2StorageService.ts` | R2 云存储 |
| `StorageBridge` | `services/storage/StorageBridge.ts` | 本地存储桥接 |
| `VersionChecker` | `services/version-checker/VersionChecker.ts` | 版本检查 |
| `LangChainDirectorService` | `services/LangChainDirectorService.ts` | AI 导演 |
| `LangChainStoryboardService` | `services/LangChainStoryboardService.ts` | 分镜脚本 |
| Pipeline 全系列 | `services/pipeline/` | Director/Storyboard 管线 |
| Storyboard 全系列 | `services/storyboard-pipeline/` | 分镜管线 |

#### 桥接模式

```typescript
// services/ServiceRegistry.ts — 单例注册表
class ServiceRegistry {
  private static instance: ServiceRegistry
  readonly api: ApiService
  readonly i18n: I18nService
  readonly cache: ImageCacheService
  // ...其它服务

  static getInstance(): ServiceRegistry { ... }
}

// hooks/useService.ts — React 消费入口
function useApi(): ApiService {
  return ServiceRegistry.getInstance().api
}
```

所有 React 组件通过 `useApi()` / `useI18n()` 等 hook 获取服务实例。服务本身不依赖 React，测试时可独立 mock。

#### 被替代的管理器

以下命令式"Manager"类将被 React 组件 + Zustand store 替代，原文件在迁移完成后删除：

| 原 Manager | 替代为 |
|------------|--------|
| `TabManager.ts` | `useTabStore` + `<TabBar />` |
| `ModelSelectorManager.ts` | `useModelStore` + `<ModelSelector />` (react-select) |
| `DialogManager.ts` + `ModalFactory.ts` | `useDialogStore` + `<DialogProvider />` |
| `ToastManager.ts` | `useToastStore` + `<ToastContainer />` |
| `UIStateManager.ts` | `useUIStore` |
| `UIComponentsService.ts` | 拆散到各 React 组件 |
| `MobileMenuManager.ts` | `<MobileMenu />` 组件 |
| `KeyboardShortcuts.ts` | `useKeyboardShortcuts` hook |
| `AccessibilityManager.ts` | 各组件 ARIA + `useA11y` hook |
| `IntroVideoController.ts` | `<IntroVideo />` 组件 |
| `ErrorHandler.ts` + `NetworkDiagnosticsModal.ts` | `<ErrorBoundary />` + `useErrorHandler` hook |
| `PerformanceDashboard.ts` | `<PerformanceDashboard />` 组件 |
| `SettingsManager / SiteManager` | `useSettingsStore` + `<SettingsPage />` |

### 4.3 页面组件映射

每个现有的命令式 Page 类对应一个 React 函数组件：

| 原 Page 类 | React 组件 | 主要 Zustand Store |
|------------|-----------|-------------------|
| `GeneratePage.ts` | `<GeneratePage />` | `useGenerateStore` |
| `BatchPage.ts` | `<BatchPage />` | `useBatchStore` |
| `ComparePage.ts` | `<ComparePage />` | `useCompareStore` |
| `HistoryPage.ts` | `<HistoryPage />` | `useHistoryStore` |
| `UnderstandPage.ts` | `<UnderstandPage />` (已有) | 已有 stores |
| `PromptTemplates.ts` | `<PromptTemplates />` | `useTemplateStore` |
| `BasePage.ts` | 删除（逻辑吸收到各组件） | — |

### 4.4 第三方库替换

| 原 (vanilla) | React 替代 | 用途 |
|---|---|---|
| Choices.js (CDN) | `react-select` ^5.10.2 | 模型选择器、下拉选择 |
| Masonry layout (vanilla) | `react-masonry-css` | 历史页面瀑布流 |
| Cropper.js (vanilla) | `react-cropper` | 图片裁剪 |
| Prism.js (CDN) | `react-syntax-highlighter` | 代码高亮 |
| 自定义 `VirtualScroller.ts` | `@tanstack/react-virtual` | 虚拟滚动 |

已通过 npm 安装的库 (如 LangChain、LangGraph、Zustand) 保持不动。

### 4.5 状态管理架构

所有状态统一到 Zustand 5 stores，按域划分：

```
stores/
├── useTabStore.ts        — 当前 tab、tab 切换
├── useModelStore.ts      — 当前模型、模型列表、切换
├── useGenerateStore.ts   — 生成页面状态 (prompt, params, results)
├── useBatchStore.ts      — 批量生成状态
├── useCompareStore.ts    — 对比页面状态
├── useHistoryStore.ts    — 历史记录、筛选
├── useSettingsStore.ts   — 用户设置 (persist middleware)
├── useUIStore.ts         — 全局 UI 状态 (sidebar, theme, mobile)
├── useToastStore.ts      — Toast 消息队列
├── useDialogStore.ts     — 对话框状态
├── useTemplateStore.ts   — 提示词模板
├── useDirectorStore.ts   — (已有) AI 导演
└── useStoryboardStore.ts — (已有) 分镜脚本
```

`useSettingsStore` 和 `useModelStore` 使用 `persist` middleware 自动同步 localStorage。

## 5. 文件结构

### 5.1 新增目录结构

```
src/renderer/src/
├── main.tsx                    ← 新入口 (替代 main.ts)
├── App.tsx                     ← React 根组件
├── providers/
│   ├── AppProviders.tsx        ← 组合所有 Provider
│   ├── ServiceProvider.tsx     ← 服务注册表 Context
│   └── I18nProvider.tsx        ← 国际化 Context
├── layouts/
│   ├── AppLayout.tsx           ← 主布局 (sidebar + content)
│   ├── Sidebar.tsx             ← 侧栏导航
│   └── MobileLayout.tsx        ← 移动端布局
├── components/                 ← 公共 UI 组件
│   ├── ModelSelector.tsx
│   ├── TabBar.tsx
│   ├── IntroVideo.tsx
│   ├── Toast/
│   │   ├── ToastContainer.tsx
│   │   └── ToastItem.tsx
│   ├── Dialog/
│   │   ├── DialogProvider.tsx
│   │   └── ConfirmDialog.tsx
│   ├── ErrorBoundary.tsx
│   ├── ImageViewer.tsx
│   ├── VirtualList.tsx
│   └── PerformanceDashboard.tsx
├── pages/                      ← 页面组件 (替代旧 pages/)
│   ├── GeneratePage.tsx
│   ├── BatchPage.tsx
│   ├── ComparePage.tsx
│   ├── HistoryPage.tsx
│   ├── UnderstandPage.tsx      ← 从 react-app/ 迁入
│   ├── SettingsPage.tsx
│   └── PromptTemplates.tsx
├── stores/                     ← Zustand stores
│   ├── useTabStore.ts
│   ├── useModelStore.ts
│   ├── useGenerateStore.ts
│   ├── useBatchStore.ts
│   ├── useCompareStore.ts
│   ├── useHistoryStore.ts
│   ├── useSettingsStore.ts
│   ├── useUIStore.ts
│   ├── useToastStore.ts
│   ├── useDialogStore.ts
│   ├── useTemplateStore.ts
│   ├── useDirectorStore.ts     ← 从 react-app/stores/ 迁入
│   └── useStoryboardStore.ts   ← 从 react-app/understand/ 迁入
├── hooks/                      ← 自定义 hooks
│   ├── useService.ts           ← useApi, useI18n, useCache 等
│   ├── useKeyboardShortcuts.ts
│   ├── useA11y.ts
│   └── useErrorHandler.ts
├── services/                   ← 保持不变
│   ├── api/
│   ├── cache/
│   ├── i18n/
│   ├── pipeline/
│   ├── storyboard-pipeline/
│   ├── r2-storage/
│   ├── storage/
│   ├── version-checker/
│   ├── ServiceRegistry.ts      ← 新增: 统一服务注册
│   ├── ServiceBridge.ts        ← 保留: window.aiImageAPI 桥接
│   ├── LangChainDirectorService.ts
│   ├── LangChainStoryboardService.ts
│   ├── StoryboardToDirectorAdapter.ts
│   └── PageStateManager.ts
├── utils/                      ← 保持不变
│   ├── clipboard.ts
│   ├── dom.ts                  ← 保留文件，删除 DOM 查询帮助函数
│   ├── format.ts
│   ├── image-compress.ts
│   ├── network-diagnostics.ts
│   ├── toast.ts                ← 迁移后删除 (由 useToastStore 替代)
│   └── url-validator.ts
├── styles/                     ← 保持不变 + Tailwind v4 配置
│   └── app.css                 ← Tailwind @theme 配置
└── shims/                      ← 保持不变
```

### 5.2 删除清单

迁移完成后删除的文件/目录：

**命令式 Page 类** (逻辑重写为 React 组件):
- `pages/BasePage.ts`
- `pages/GeneratePage.ts`
- `pages/BatchPage.ts`
- `pages/ComparePage.ts`
- `pages/HistoryPage.ts`
- `pages/UnderstandPage.ts`
- `pages/PromptTemplates.ts`
- `pages/index.ts`

**命令式 Manager 类** (逻辑迁入 React 组件 + Zustand stores):
- `features/tab-manager/`
- `features/model-selector/`
- `features/dialog/`
- `features/toast/`
- `features/ui-state/`
- `features/ui-components/`
- `features/mobile-menu/`
- `features/keyboard/`
- `features/accessibility/`
- `features/intro-video/`
- `features/error-handler/`
- `features/performance/`
- `features/settings/`
- `features/image-viewer/`
- `features/intelligent-resize/`
- `features/updater/`
- `features/language/`
- `features/history/HistoryManager.ts` + `features/history/index.ts` (HistoryDataService.ts 保留为纯数据服务)
- `features/index.ts`

**Core 层** (逻辑被 React 路由 + 组件替代):
- `core/AppBootstrap.ts`
- `core/EventBus.ts`
- `core/EventManager.ts`
- `core/LoadingManager.ts`
- `core/PageLoader.ts`
- `core/RetryManager.ts` (重试逻辑迁入 hooks)
- `core/Router.ts`
- `core/VirtualScroller.ts` (替换为 @tanstack/react-virtual)
- `core/index.ts`

**旧 React islands 目录** (内容迁入新结构):
- `react-app/` (全部迁入 `pages/`、`stores/`、`components/`)

**旧入口**:
- `main.ts` (替换为 `main.tsx`)

**工具类精简**:
- `utils/toast.ts` (功能由 `useToastStore` 替代)
- `utils/dom.ts` 中仅删除 DOM 查询/操作帮助函数 (如 `getElementById` 封装)，保留通用 DOM 工具 (如 classname 处理)

### 5.3 保留清单

- `services/` 全部子目录及文件 (纯业务逻辑)
- `utils/clipboard.ts`, `utils/format.ts`, `utils/image-compress.ts`, `utils/url-validator.ts`, `utils/network-diagnostics.ts`
- `shims/` 全部
- `styles/` (Tailwind v4 改造)
- `__mocks__/` (测试 mock 更新适配)
- `features/history/HistoryDataService.ts` (纯数据服务，保留)

## 6. 迁移策略

采用 **Big-Bang 全重写** 方式：

1. **Phase 0 — 依赖升级**: 升级 Electron、Vite、TypeScript、Tailwind CSS 到最新版本，确保构建通过
2. **Phase 1 — 搭建 React Shell**: 创建 `main.tsx` + `App.tsx` + `AppProviders` + `AppLayout`，替换 `index.html`
3. **Phase 2 — 公共组件**: 实现 `ModelSelector`、`TabBar`、`Toast`、`Dialog`、`ErrorBoundary` 等
4. **Phase 3 — 逐页迁移**: 按页面复杂度从低到高迁移 (Settings → Compare → History → Generate → Batch → Understand)
5. **Phase 4 — 清理**: 删除旧文件、移除 CDN 依赖、精简 `index.html`
6. **Phase 5 — 验证**: 全量功能测试、TypeScript 严格模式检查

每个 Phase 结束后确保应用可构建并运行。

## 7. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Tailwind v3 → v4 class 名不兼容 | 使用官方 `@tailwindcss/upgrade` 工具自动迁移 |
| Electron 28 → 41 breaking changes | 逐版本查阅 release notes，preload 层影响小 |
| 命令式 → 声明式转换遗漏逻辑 | 以旧 Manager 为参考逐方法对照实现 |
| TypeScript 5 → 6 类型不兼容 | TS6 向后兼容良好，主要是新严格检查 |
| Vite 7 → 8 配置变更 | electron-vite 5.0 已适配，变更较小 |

## 8. 成功标准

- 所有页面功能与迁移前一致
- 零命令式 DOM 操作（`document.getElementById` 等）
- `index.html` 不超过 30 行
- TypeScript 严格模式零错误
- 所有依赖为 2026-04-16 最新稳定版本
- 现有测试全部通过或等效重写通过
