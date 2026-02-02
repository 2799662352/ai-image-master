# HistoryPage 功能对齐升级计划

> **状态:** ✅ 已完成 (2026-02-02)

**Goal:** 将 TypeScript 版本的 HistoryPage 与原始 JavaScript 版本功能完全对齐，特别是恢复被简化的存储状态卡片 UI

**Architecture:** 分阶段补全缺失功能，优先处理存储状态卡片 UI（用户明确指出），然后处理其他功能差异

**Tech Stack:** TypeScript, Electron, Vite

---

## 执行记录

### 2026-02-02 完成的修复

| 修复项 | 文件 | 状态 |
|--------|------|------|
| 恢复完整存储状态卡片 UI (4个功能卡片) | `HistoryPage.ts` | ✅ 完成 |
| 添加卡片描述文字 | `HistoryPage.ts` | ✅ 完成 |
| 恢复响应式布局 `grid-cols-1 sm:grid-cols-2` | `HistoryPage.ts` | ✅ 完成 |
| 恢复按钮阴影和悬停效果 | `HistoryPage.ts` | ✅ 完成 |
| 修复 i18n 翻译不工作 | `ServiceBridge.ts` | ✅ 完成 |
| 修复 R2 存储状态检测 | `HistoryPage.ts` | ✅ 完成 |
| 修复 R2 服务初始化 | `R2StorageService.ts` | ✅ 完成 |
| 注册 window.historyPageTS | `HistoryPage.ts` | ✅ 完成 |

---

## 问题根因分析

### 1. 存储状态卡片 UI 简化
- 原因：TypeScript 迁移时简化了 UI，只保留了 2 个卡片
- 修复：恢复完整的 4 个功能卡片和所有描述文字

### 2. i18n 翻译不工作
- 原因：`ServiceBridge.ts` 只设置了 `window.i18nServiceTS`，但 `BasePage.t()` 使用的是 `window.i18n`
- 修复：添加 `(window as any).i18n = i18n` 兼容性设置

### 3. R2 存储状态总是显示"本地模式"
- 原因1：`this.app.getStorageInfo?.()` 返回 undefined（方法未实现）
- 原因2：`R2StorageService.init()` 没有被调用，导致 `workerUrl` 为 null
- 修复：
  - `HistoryPage.ts` 自行计算存储信息
  - `initR2StorageGlobal()` 自动调用 `service.init()`

---

## 修改的文件清单

### 1. `src/renderer/src/pages/HistoryPage.ts`

```typescript
// 1. 恢复完整的 buildStorageStatusHTML 方法
// - 云端模式：4 个功能卡片（隐私保护、智能存储、同步管理、有效期限）
// - 本地模式：警告卡片 + 高使用率提示
// - 按钮阴影和悬停效果

// 2. 修复 updateStorageStatusCached 方法
// - 自行计算存储信息
// - 正确检查 window.r2Storage.isAvailable()

// 3. 注册 window.historyPageTS
export function createHistoryPage(app: AppInterface): HistoryPage {
  historyPageInstance = new HistoryPage(app)
  ;(window as any).historyPageTS = historyPageInstance
  return historyPageInstance
}
```

### 2. `src/renderer/src/services/ServiceBridge.ts`

```typescript
// I18nService 初始化后添加兼容性设置
const i18n = getI18nService()
await i18n.init()
window.i18nServiceTS = i18n
// 兼容性：BasePage.t() 使用 window.i18n
;(window as any).i18n = i18n
```

### 3. `src/renderer/src/services/r2-storage/R2StorageService.ts`

```typescript
// initR2StorageGlobal() 自动调用 init()
export function initR2StorageGlobal(): R2StorageService {
  const service = getR2StorageService()
  
  // 确保服务初始化
  service.init().catch(err => {
    console.warn('[R2StorageService] 初始化失败:', err)
  })
  
  // 暴露到 window...
}
```

---

## 验证清单

- [x] 云端模式下显示 4 个功能卡片（隐私保护、智能存储、同步管理、有效期限）
- [x] 每个卡片有完整的描述文字
- [x] 本地模式下显示本地存储警告
- [x] 本地模式下使用率 > 50% 时显示建议配置云端存储卡片
- [x] 迁移按钮有阴影和悬停缩放效果
- [x] 清理缓存按钮有描述文字、阴影和悬停缩放效果
- [x] 响应式布局 `grid-cols-1 sm:grid-cols-2` 正常工作
- [x] 所有 i18n 键存在且翻译正确

---

## 经验总结（已记录到 Cursor 规则）

创建了 `.cursor/rules/i18n-fix.mdc` 规则文件，记录 i18n 翻译服务修复经验：

1. ServiceBridge 必须同时设置 `window.i18n` 和 `window.i18nServiceTS`
2. 服务初始化时必须调用 `init()` 方法
3. BasePage.t() 方法依赖 `window.i18n` 对象
