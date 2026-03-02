# TypeScript 类型错误修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 6 个 pre-existing TypeScript 编译错误，其中 1 个是隐藏的运行时 bug

**Architecture:** 3 个独立问题：(1) Window 类型声明缺失 4 个属性，(2) KeyboardShortcuts 配置接口与调用不匹配（含运行时 bug），(3) electron-vite renderer 配置中 esbuild 位置错误

**Tech Stack:** TypeScript, electron-vite 5, Vite 7

---

## Task 1: 修复 Window 类型声明缺失（2 个 TS 错误）

**问题根因:** `ServiceBridge.ts` L391-400 向 `window` 赋值了 4 个属性，但 L1124-1168 的 `declare global { interface Window }` 中未声明。

**错误信息:**
- L391: `Property 'updateNotificationTS' does not exist on type 'Window & typeof globalThis'`
- L392: `Property 'UpdateNotificationTS' does not exist on type 'Window & typeof globalThis'`
- L399: `Property 'performanceDashboardTS' does not exist on type 'Window & typeof globalThis'`
- L400: `Property 'PerformanceDashboardTS' does not exist on type 'Window & typeof globalThis'`

**Files:**

- 修改: `src/renderer/src/services/ServiceBridge.ts:1124-1168`

### Step 1: 在 Window 接口中添加缺失的 4 个属性

在 `declare global { interface Window { ... } }` 块内，`keyboardShortcutsTS` 之后添加:

```typescript
    updateNotificationTS?: UpdateNotification
    UpdateNotificationTS?: typeof UpdateNotification
    performanceDashboardTS?: PerformanceDashboard
    PerformanceDashboardTS?: typeof PerformanceDashboard
```

### Step 2: 验证

```bash
npx electron-vite build 2>&1 | Select-String "error"
```

预期: 这 4 个错误消失。

---

## Task 2: 修复 KeyboardShortcutsConfig 接口不匹配（1 个 TS 错误 + 运行时 bug）

**问题根因:** `ServiceBridge.ts` L406-424 调用 `createKeyboardShortcuts()` 传入 `{ executeAction, copyToClipboard, showToast }`，但 `KeyboardShortcutsConfig` 接口要求 `{ getCurrentTab, getPages, ... }`。

**运行时影响:** 当前 Ctrl/Cmd+Enter 快捷键会触发 `handleExecuteAction()` → `this.config.getCurrentTab()`，但 `getCurrentTab` 未提供 → **运行时 TypeError**。

**错误信息:**
- L407: `Object literal may only specify known properties, and 'executeAction' does not exist in type 'KeyboardShortcutsConfig'`

**Files:**

- 修改: `src/renderer/src/services/ServiceBridge.ts:406-424`

### Step 1: 替换 createKeyboardShortcuts 配置

当前代码 (`ServiceBridge.ts` L406-424):

```typescript
const keyboardShortcuts = createKeyboardShortcuts({
  executeAction: () => {
    const tabManager = ServiceRegistry.get<any>(SERVICE_KEYS.TAB_MANAGER)
    const currentTab = tabManager?.getCurrentTab()
    if (currentTab === 'generate') {
      ;(window as any).generatePageTS?.generateImage?.()
    } else if (currentTab === 'batch') {
      ;(window as any).batchPageTS?.startBatch?.()
    }
  },
  copyToClipboard: async (text: string) => {
    await navigator.clipboard.writeText(text)
  },
  showToast: (msg: string, type: 'success' | 'error' | 'info') => {
    const toast = ServiceRegistry.get<any>(SERVICE_KEYS.TOAST)
    toast?.show(msg, type)
  }
})
```

改为符合 `KeyboardShortcutsConfig` 接口:

```typescript
const keyboardShortcuts = createKeyboardShortcuts({
  getCurrentTab: () => {
    const tabManager = ServiceRegistry.get<any>(SERVICE_KEYS.TAB_MANAGER)
    return tabManager?.getCurrentTab() || 'generate'
  },
  getPages: () => ({
    generate: { generateImage: () => (window as any).generatePageTS?.generateImage?.() },
    batch: { batchGenerate: () => (window as any).batchPageTS?.startBatch?.() }
  }),
  closeSettings: () => {
    const settingsEl = document.getElementById('settingsModal')
    if (settingsEl) settingsEl.classList.add('hidden')
  },
  closeAbout: () => {
    const aboutEl = document.getElementById('aboutModal')
    if (aboutEl) aboutEl.classList.add('hidden')
  },
  closeActivity: () => {
    const activityEl = document.getElementById('activityModal')
    if (activityEl) activityEl.classList.add('hidden')
  }
})
```

### Step 2: 验证

```bash
npx electron-vite build 2>&1 | Select-String "error"
```

预期: `executeAction` 类型错误消失，且 Ctrl+Enter 快捷键恢复运行时功能。

---

## Task 3: 修复 esbuild 配置位置（1 个 TS 错误）

**问题根因:** `electron.vite.config.ts` L166 将 `esbuild` 放在 `renderer.build` 内部，但在 Vite/electron-vite 中，`esbuild` 是顶层选项，不属于 `build`。

**错误信息:**
- L166: `Object literal may only specify known properties, and 'esbuild' does not exist in type 'RendererBuildOptions'`

**Context7 参考:** electron-vite 的 renderer 配置遵循 Vite 配置结构，`esbuild` 应在 `renderer` 顶层。

**Files:**

- 修改: `electron.vite.config.ts:36,165-169`

### Step 1: 将 esbuild 从 build 内移到 renderer 顶层

当前 (`electron.vite.config.ts` L36-170):

```typescript
renderer: {
  root: 'src/renderer',
  build: {
    // ... 其他配置 ...
    esbuild: {           // ← 错误位置
      drop: isProd ? ['console', 'debugger'] : [],
      legalComments: 'none'
    }
  },
```

改为:

```typescript
renderer: {
  root: 'src/renderer',
  esbuild: {             // ← 移到 renderer 顶层
    drop: isProd ? ['console', 'debugger'] : [],
    legalComments: 'none'
  },
  build: {
    // ... 其他配置 (不含 esbuild) ...
  },
```

### Step 2: 验证构建

```bash
npx electron-vite build 2>&1 | Select-String "error"
```

预期: `esbuild` 类型错误消失，构建产物中不包含 console.log。

---

## 执行顺序与预期收益

| Task | 错误数 | 类型 | 影响 |
|------|--------|------|------|
| Task 1: Window 类型声明 | 4 | 纯类型 | 消除 TS 编译警告 |
| Task 2: Keyboard 配置修复 | 1 | 类型+运行时 | **修复 Ctrl+Enter 快捷键** |
| Task 3: esbuild 位置修复 | 1 | 类型+构建 | 生产环境正确移除 console |
