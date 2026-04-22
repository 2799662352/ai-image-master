# 图片下载体验完善 设计文档

**Date:** 2026-04-20
**Status:** Implemented
**Author:** Pair-design with user

---

## 背景与问题

当前应用中图片下载体验存在两个明显缺口：

1. **History 页 `DonorPreview` 预览弹窗** — 已有 `[ COPY.PROMPT ]` 和 `[ OPEN.URL ]` 两个操作按钮，但缺失"下载本图"按钮。Batch 页 `ResultsGallery` 已有完善的下载实现，可以复用相同模式。
2. **Electron 全局缺失图片右键菜单** — `electron/main.js` 中 `Menu.setApplicationMenu(null)` 禁用了全部菜单，且没有自定义任何 `context-menu` 事件处理。用户在 Electron 内右键任意图片**没有任何反馈**。这与浏览器/原生应用的预期严重不符。

## 目标

提供一致的、随时可用的图片下载能力：

- **UI 级**：在 `DonorPreview` 预览中加显式下载按钮（与现有按钮风格一致）。
- **OS 级**：在所有 webContents 中提供原生右键菜单，包含「图片另存为…」「复制图片地址」「在浏览器中打开」三项。

## 非目标

- 不引入下载管理器/进度 UI（Batch 页已有的下载体验已经够用）。
- 不修改 Batch / Director / 其它页面的现有下载逻辑。
- 不为右键菜单加 i18n —— 中文写死即可（与现有应用界面风格一致）。

## 架构总览

```
┌─────────────────────────────────────────────┐
│  Renderer (React)                           │
│  ┌────────────────────────────────────────┐ │
│  │ DonorPreview.tsx                       │ │
│  │  [ COPY.PROMPT ] [ SAVE.IMG ] [OPEN.URL]│ │
│  │      ↓ <a href download>                │ │
│  │  浏览器/Chromium 触发下载                │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
                    ↓ context-menu event
┌─────────────────────────────────────────────┐
│  Main process (electron/main.js)            │
│  ┌────────────────────────────────────────┐ │
│  │ image-context-menu.js (新增模块)       │ │
│  │  attachImageContextMenu(webContents)   │ │
│  │   • 监听 context-menu 事件              │ │
│  │   • params.mediaType === 'image' 时    │ │
│  │     弹出 Menu.buildFromTemplate         │ │
│  │   • 「另存为」: dialog.showSaveDialog  │ │
│  │     → webContents.downloadURL(srcURL)  │ │
│  │     → session.will-download            │ │
│  │     → item.setSavePath(chosenPath)     │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## 组件设计

### 1. `DonorPreview` 下载按钮

**文件：** `src/renderer/src/components/donor/DonorPreview.tsx`

在已有的 `[ COPY.PROMPT ]` 按钮和 `[ OPEN.URL ]` 链接之间，新增 `[ SAVE.IMG ]` 按钮。

**行为：**
- 点击后通过隐式 `<a>` 元素触发浏览器下载（与 `ResultsGallery.downloadImage()` 一致的模式）。
- 文件名规则：`donor-{shortId}-{idx + 1}.png`，例如 `donor-571019-3.png`。
- 视觉上沿用 `d-hover-invert` 样式，不破坏 Cyberpunk 主题。
- 仅在 `url` 存在时显示（与 `[ OPEN.URL ]` 同步）。

**实现：**
```tsx
{url && (
  <button
    type="button"
    onClick={handleSave}
    className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
  >
    [ SAVE.IMG ]
  </button>
)}
```

`handleSave` 复用现有 `downloadImage(url, filename)` 模式。

### 2. Electron 图片右键菜单模块

**文件（新增）：** `electron/image-context-menu.js`

**接口：**
```js
function attachImageContextMenu(webContents)
module.exports = { attachImageContextMenu }
```

**职责：**
- 在传入的 `webContents` 上监听 `context-menu` 事件
- 仅当 `params.mediaType === 'image' && params.hasImageContents` 时弹出菜单
- 菜单三项：
  1. **图片另存为…** — 弹 `dialog.showSaveDialog`，确定后调用 `webContents.downloadURL(params.srcURL)`，在 `session.once('will-download')` 中 `item.setSavePath(filePath)` 完成保存
  2. **复制图片地址** — `clipboard.writeText(params.srcURL)`
  3. **在浏览器中打开** — `shell.openExternal(params.srcURL)`（仅当 `srcURL` 是 `http(s)://` 时显示）

**为什么独立成模块：**
- 把 `main.js`（已 698 行）保持在简洁状态
- 单元上下文清晰 —— 输入是一个 `webContents`，副作用是注册一个监听器
- 未来若新开窗口（如设置窗口）可以直接复用

### 3. 在 main.js 中挂载

**文件：** `electron/main.js`（修改 `createWindow` 函数）

在已有的 `setWindowOpenHandler` 之后插入一行：
```js
const { attachImageContextMenu } = require('./image-context-menu');
attachImageContextMenu(mainWindow.webContents);
```

由于本应用 `setWindowOpenHandler` 中所有 `http(s)` 链接都被 `shell.openExternal` 接管（new window action: deny），唯一存在的 `webContents` 就是 `mainWindow.webContents`。**因此挂载到 mainWindow 即可覆盖全部页面**，不需要 `app.on('web-contents-created')`。

## 数据流：右键另存为

```
User 右键图片
  ↓
context-menu event (params.mediaType === 'image', srcURL = 'https://...')
  ↓
弹出原生 Menu —— 用户选「图片另存为…」
  ↓
dialog.showSaveDialog
  defaultPath: app.getPath('downloads') + '/' + suggestedFilename
  filters: PNG/JPG/WebP/All Files
  ↓
用户选择路径 P
  ↓
session.once('will-download') 注册一次性监听器（避免污染其它下载流）
  ↓
webContents.downloadURL(srcURL)
  ↓
will-download 触发 → item.setSavePath(P) → Chromium 下载
  ↓
item.once('done') → 通过 webContents.send('image-saved', {success, path?, error?})
  ↓
Renderer 可选地展示 toast（已有 toast 系统）
```

## 错误处理

| 场景 | 处理 |
|------|------|
| `srcURL` 是 `data:` URI | 不走下载，直接 `dialog.showSaveDialog` 后写入文件（`fs.writeFile` + base64 解码） |
| `srcURL` 是 `blob:` URI | renderer 内的 blob 主进程拿不到，不显示「另存为」项（仅复制地址 + 打开） |
| 用户取消 SaveDialog | 静默返回，不触发下载 |
| 下载失败 (`item.done` state ≠ 'completed') | 通过 IPC 回报 renderer，renderer 弹错误 toast |
| `params.srcURL` 为空 | 跳过菜单（防御性） |

## 安全考量

- **CSP 已允许 `img-src https: data: blob: file:`** —— 不需修改
- `shell.openExternal` 仅对 `http(s)` 协议开放（现有逻辑已限制）
- `webContents.downloadURL` 走 Chromium 内部下载，遵循 session cookies 等
- 一次性监听器（`session.once`）避免影响其它 download flow

## 测试策略

### 自动化（Vitest + RTL）
- `DonorPreview.test.tsx` — 验证下载按钮渲染、点击触发 `<a>` 下载、文件名正确

### 手动 smoke test（写入 plan 作为 checklist）
1. 在 History 页打开任意图片预览 → 点 `[ SAVE.IMG ]` → 文件下载到默认下载目录 ✓
2. 在 Director 页右键已生成图片 → 弹出菜单 → 选「图片另存为…」→ 选择路径 → 文件保存成功 ✓
3. 右键非图片元素（如文字）→ **不**弹出菜单 ✓
4. 右键 base64 内嵌图片（生成预览）→ 「另存为」走 fs.writeFile 路径 → 文件正确 ✓
5. 右键菜单选「复制图片地址」→ 系统剪贴板包含正确 URL ✓

## 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer/src/components/donor/DonorPreview.tsx` | 修改 | 添加 `[ SAVE.IMG ]` 按钮和 `handleSave` 函数 |
| `src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx` | 新增 | 下载按钮单元测试 |
| `electron/image-context-menu.js` | 新增 | 通用图片右键菜单模块 |
| `electron/main.js` | 修改 | 在 `createWindow()` 中调用 `attachImageContextMenu` |

## 不做的事

- 不实现复制图片像素到剪贴板（`clipboard.writeImage`）—— 用户没有要求，多数场景"复制地址"够用
- 不为图片右键加「保存到自定义图库」选项 —— 那是另一个功能域
- 不增加批量下载 / 拖拽下载 —— Batch 页已有，不需要扩展到 History
