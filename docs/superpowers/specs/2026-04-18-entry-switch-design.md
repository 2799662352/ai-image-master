# React 入口切换设计规格

> 将 Vite 构建入口从旧版 `index.html`（2846 行）切换到 `index-react.html`（30 行），让 React 应用成为实际运行的默认入口。

## 背景

React 迁移已完成：7 个页面拥有完整 store + hook 架构，79 个测试通过，React 层零 `(window as any)` 调用。但 Vite 仍构建旧入口，React 版本从未在 Electron 中实际运行过。

### ServiceBridge 的传递依赖

`main.tsx` → `ServiceBridge.ts` 是一个中心枢纽，它 import 了几乎所有旧模块：

- `features/*`（history、model-selector、image-viewer、settings、dialog 等 14 个 feature）
- `pages/*`（GeneratePage、HistoryPage、BatchPage 等 6 个旧页面工厂）
- `core/EventManager`
- `react-app/main`（DirectorReact 挂载）

因此切换入口后，**旧代码仍会被 Rollup 打包**。manualChunks 规则并非死代码——它们仍在控制这些模块的分块方式。只有 `choices.js`（仅被旧 `main.ts` import）和 `feature-accessibility`（无任何 import）是真正的死代码。

大规模清理 manualChunks 需先重构 ServiceBridge 以移除旧模块 import，这属于后续 spec 的范围。

## 目标

1. React 应用成为 `electron-vite build` 和 `electron-vite dev` 的唯一渲染入口
2. 旧文件保留不删（回退安全网）
3. 清理已确认的死代码配置（`choices.js`、`feature-accessibility`）

## 不做什么

- 不删除旧文件（`index.html`、`pages/*.ts`、`features/*`）——留给后续清理 spec
- 不大规模清理 manualChunks——依赖 ServiceBridge 重构（后续 spec）
- 不写 E2E 自动化测试——后续用 agent-browser 实现
- 不做 bundle 大小分析——留给清理阶段
- 不迁移 DirectorPage（仍为 stub）

## 变更清单

### 1. `electron.vite.config.ts` — 入口切换

第 49 行：

```typescript
// 从
input: { index: resolve(__dirname, 'src/renderer/index.html') }
// 改为
input: { index: resolve(__dirname, 'src/renderer/index-react.html') }
```

### 2. `src/main/index.ts` — loadFile 路径

第 307 行：

```typescript
// 从
mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
// 改为
mainWindow.loadFile(path.join(__dirname, '../renderer/index-react.html'))
```

### 3. `electron.vite.config.ts` — manualChunks 最小清理

仅删除已确认的死代码规则：

**删除：**
- `vendor-choices`（第 63-65 行）——`choices.js` 仅被旧 `main.ts` import，React 版使用 `react-select`
- `feature-accessibility`（第 122-124 行）——无任何模块 import 此 feature

**保留不动：** 所有其他规则（`core-services`、`feature-*`、`page-*`、`react-director`、`vendor-react`、`vendor-zustand`、`vendor-jszip`、`vendor`、`utils`）。ServiceBridge 传递依赖使得这些规则仍然有效。

### 4. `electron.vite.config.ts` — server.warmup 更新

第 180-188 行，更新为 React 入口的关键模块：

```typescript
// 从
clientFiles: [
  './src/main.ts',
  './src/services/ServiceBridge.ts',
  './src/pages/GeneratePage.ts',
  './src/pages/BasePage.ts',
  './src/features/history/index.ts',
  './src/features/model-selector/index.ts',
  './src/features/toast/index.ts'
]
// 改为
clientFiles: [
  './src/main.tsx',
  './src/services/ServiceBridge.ts',
  './src/App.tsx',
  './src/stores/index.ts',
  './src/pages-react/index.ts'
]
```

说明：`ServiceBridge.ts` 保留因为它仍是最重的传递依赖瓶颈。`pages-react/index.ts` 是 lazy 页面 barrel，预热可加速首次 tab 切换。

### 5. `electron.vite.config.ts` — optimizeDeps 更新

第 193 行：

```typescript
// 从
include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand']
// 改为
include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select']
```

`choices.js` 已死（仅旧入口使用），`react-select` 被 React 页面使用（`ModelPairSelector.tsx`、`ModelSelector.tsx`）。

## 验证标准

### 构建验证（自动化）

1. `npx electron-vite build` 成功无报错
2. `dist/renderer/` 中不存在 `vendor-choices` 和 `feature-accessibility` chunk
3. 79 个现有测试全部通过

### 运行时验证（手动 checklist）

1. `npx electron-vite dev` 正常启动，HMR 工作
2. 8 个 Tab 均可切换渲染（含 DirectorPage stub）
3. SettingsPage：加载站点、切换、保存 Key、测试连接
4. GeneratePage：输入提示词、选择比例/模型、生成
5. BatchPage：添加任务、批量导入、运行
6. ComparePage：双模型选择、生成对比
7. HistoryPage：加载、搜索、删除
8. UnderstandPage：上传图片、分析
9. PromptTemplatesPage：加载、搜索、分类、复制
10. Toast 通知正常
11. 控制台无 React 运行时报错

### 回退方案

按变更范围逐项还原：

| 变更 | 还原操作 |
|------|---------|
| Section 1 (入口) | `electron.vite.config.ts` 第 49 行 → `index.html` |
| Section 2 (loadFile) | `src/main/index.ts` 第 307 行 → `index.html` |
| Section 3 (manualChunks) | 恢复 `vendor-choices` 和 `feature-accessibility` 两条规则 |
| Section 4 (warmup) | 恢复旧 warmup 文件列表 |
| Section 5 (optimizeDeps) | `choices.js` 加回，`react-select` 移除 |

所有变更均在 `electron.vite.config.ts` 和 `src/main/index.ts` 两个文件内，可通过 `git checkout` 一步还原。

## 后续工作（不在本 spec 范围）

1. **ServiceBridge 解耦**（优先级高）——重构 `ServiceBridge.ts` 移除旧 `features/*`、`pages/*`、`core/*`、`react-app/*` 的 import。React 页面已使用独立 store + hook，ServiceBridge 的旧页面工厂可逐步替换
2. **manualChunks 大清理**——ServiceBridge 解耦后，删除所有不再被引用的 chunk 规则
3. **Resolve aliases 清理**——`@core`、`@features`、`@pages` 等别名待 ServiceBridge 解耦后移除
4. **删除旧代码**（`index.html`、`pages/*.ts`、`features/*`、`core/*`）
5. **bundle 大小分析与优化**
6. **DirectorPage 集成**（将 `react-app/DirectorApp.tsx` 接入 React Shell）
7. **agent-browser E2E 自动化测试**
