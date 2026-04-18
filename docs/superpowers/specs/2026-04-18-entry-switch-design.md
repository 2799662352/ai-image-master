# React 入口切换设计规格

> 将 Vite 构建入口从旧版 `index.html`（2846 行）切换到 `index-react.html`（30 行），让 React 应用成为实际运行的默认入口。

## 背景

React 迁移已完成：7 个页面拥有完整 store + hook 架构，78 个测试通过，React 层零 `(window as any)` 调用。但 Vite 仍构建旧入口，React 版本从未在 Electron 中实际运行过。

## 目标

1. React 应用成为 `electron-vite build` 和 `electron-vite dev` 的唯一渲染入口
2. 构建产物只包含 React 应用的 chunks
3. 旧文件保留不删（回退安全网）

## 不做什么

- 不删除旧文件（`index.html`、`pages/*.ts`、`features/*`）——留给后续清理 spec
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

### 3. `electron.vite.config.ts` — manualChunks 清理

当前 `manualChunks` 函数包含大量指向旧代码路径的规则。切换入口后，这些模块不再被 rollup 引入，规则成为死代码。

**删除以下规则：**
- `vendor-choices`（`choices.js` 是旧版 UI 依赖，React 版使用 `react-select`）
- `core-services`（`src/renderer/src/core`、`src/renderer/src/services`、`features/history`、`pages/HistoryPage`）
- 所有 `feature-*` 规则（`model-selector`、`image-viewer`、`settings`、`dialog`、`error-handler`、`mobile-menu`、`tab-manager`、`keyboard`、`intelligent-resize`、`ui-state`、`toast`、`language`、`accessibility`）
- 所有 `page-*` 规则（`generate`、`batch`、`compare`、`prompt-templates`、`understand`、`base`）
- `react-director` 规则（`src/renderer/src/react-app`）——该路径由旧入口引用

**保留的规则：**
- `vendor-react`（react/react-dom/scheduler）
- `vendor-zustand`
- `vendor-jszip`（React 版仍可能通过 utils 使用）
- `vendor`（其他 node_modules）
- `utils`（`src/renderer/src/utils`）

**新增规则（可选）：**
- 如果 `react-select` 体积较大，可单独拆为 `vendor-react-select`

### 4. `electron.vite.config.ts` — server.warmup 更新

当前 `server.warmup.clientFiles` 指向旧路径：

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
  './src/stores/index.ts'
]
```

### 5. `electron.vite.config.ts` — optimizeDeps 更新

第 193 行，`include` 列表中 `choices.js` 不再被引入：

```typescript
// 从
include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand']
// 改为
include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select']
```

## 验证标准

### 构建验证（自动化）

1. `npx electron-vite build` 成功无报错
2. `dist/renderer/` 无旧 chunk 名称（`page-generate`、`feature-settings`、`vendor-choices`、`core-services` 等）
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

如果验证失败，还原两行配置即可切回旧入口：
- `electron.vite.config.ts` 第 49 行 → `index.html`
- `src/main/index.ts` 第 307 行 → `index.html`

## 后续工作（不在本 spec 范围）

- 删除旧代码（`index.html`、`pages/*.ts`、`features/*`、`core/*`）
- bundle 大小分析与优化
- DirectorPage 集成（将 `react-app/DirectorApp.tsx` 接入 React Shell）
- agent-browser E2E 自动化测试
