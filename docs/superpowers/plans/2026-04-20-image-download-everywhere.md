# 图片下载体验完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 History 页 `DonorPreview` 中加显式下载按钮，并为 Electron 全局图片元素提供原生右键「图片另存为…/复制图片地址/在浏览器中打开」菜单。

**Architecture:** Renderer 侧用与 `ResultsGallery` 一致的 `<a download>` 模式新增按钮；主进程新增独立模块 `electron/image-context-menu.js`，监听 `webContents.context-menu` 事件，根据 `params.mediaType` 弹出原生 `Menu`，通过 `dialog.showSaveDialog` + `webContents.downloadURL` + `session.will-download` 实现下载。

**Tech Stack:** Electron (Menu, MenuItem, dialog, clipboard, shell, session) / React 18 / Vitest + React Testing Library

**Spec:** `docs/superpowers/specs/2026-04-20-image-download-everywhere-design.md`

---

## File Structure

| File | Purpose |
|------|---------|
| `src/renderer/src/components/donor/DonorPreview.tsx` | 修改：在按钮组中新增 `[ SAVE.IMG ]` |
| `src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx` | 新增：DonorPreview 单元测试（验证下载按钮） |
| `electron/image-context-menu.js` | 新增：通用图片右键菜单模块（输入 webContents，无返回） |
| `electron/main.js` | 修改：在 `createWindow()` 中调用 `attachImageContextMenu(mainWindow.webContents)` |

---

## Task 1: DonorPreview 添加下载按钮

**Files:**
- Modify: `src/renderer/src/components/donor/DonorPreview.tsx`
- Create: `src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DonorPreview from '../DonorPreview'
import type { DonorItemView } from '../../../hooks/useHistoryData'

const mockItem: DonorItemView = {
  id: 'abc571019',
  prompt: 'test prompt',
  model: 'gemini',
  ratio: '1:1',
  displayUrls: ['https://example.com/img-a.png', 'https://example.com/img-b.png'],
} as DonorItemView

describe('DonorPreview', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('renders SAVE.IMG button when image url exists', () => {
    render(<DonorPreview item={mockItem} startIndex={0} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /SAVE\.IMG/i })).toBeTruthy()
  })

  it('clicking SAVE.IMG triggers anchor download with current image url and indexed filename', () => {
    const created: HTMLAnchorElement[] = []
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLAnchorElement
      if (tag === 'a') created.push(el)
      return el as unknown as HTMLElement
    })

    render(<DonorPreview item={mockItem} startIndex={0} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /SAVE\.IMG/i }))

    const anchor = created.find((a) => a.download)
    expect(anchor).toBeDefined()
    expect(anchor!.href).toContain('https://example.com/img-a.png')
    expect(anchor!.download).toBe('donor-571019-1.png')
  })

  it('SAVE.IMG button is hidden when no image url', () => {
    const empty = { ...mockItem, displayUrls: [] }
    render(<DonorPreview item={empty} startIndex={0} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /SAVE\.IMG/i })).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx`

Expected: FAIL — `Unable to find an accessible element with the role "button" and name /SAVE\.IMG/i`

- [ ] **Step 3: 实现 — 在 `DonorPreview.tsx` 添加下载按钮和 handler**

修改 `src/renderer/src/components/donor/DonorPreview.tsx`：

在文件 38-39 行（`copyPrompt` 函数下方）添加：

```tsx
  const handleSave = () => {
    if (!url) return
    const shortId = String(item.id).slice(-6).toLowerCase()
    const filename = `donor-${shortId}-${idx + 1}.png`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
```

然后在 JSX 中，把当前的：

```tsx
            <button
              type="button"
              onClick={copyPrompt}
              className="ml-auto d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
            >
              [ COPY.PROMPT ]
            </button>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase no-underline"
              >
                [ OPEN.URL ]
              </a>
            )}
```

替换为：

```tsx
            <button
              type="button"
              onClick={copyPrompt}
              className="ml-auto d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
            >
              [ COPY.PROMPT ]
            </button>
            {url && (
              <button
                type="button"
                onClick={handleSave}
                className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
              >
                [ SAVE.IMG ]
              </button>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase no-underline"
              >
                [ OPEN.URL ]
              </a>
            )}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx`

Expected: PASS — 所有 3 个测试通过

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit --skipLibCheck` （只看新增/修改文件相关错误）

Expected: 无新增错误（pre-existing 的 `electron/main.js` 与 vendor CDN 错误可忽略）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/donor/DonorPreview.tsx src/renderer/src/components/donor/__tests__/DonorPreview.test.tsx
git commit -m "feat(donor): add SAVE.IMG button to history preview modal"
```

---

## Task 2: 创建图片右键菜单模块

**Files:**
- Create: `electron/image-context-menu.js`

- [ ] **Step 1: 创建模块**

创建 `electron/image-context-menu.js`：

```js
// electron/image-context-menu.js
//
// 通用图片右键菜单：在任意 webContents 上注册 context-menu 事件，
// 当用户右击图片时弹出原生菜单（图片另存为 / 复制图片地址 / 在浏览器中打开）。
//
// 设计：纯函数形态，输入 webContents，不返回。无副作用泄漏：
//   - 每次 SaveAs 用 session.once('will-download')，避免污染其它下载流。
//   - data: URI 走 fs.writeFile 直接落盘，不经下载链路。
//   - blob: URI 主进程拿不到，菜单中隐藏「另存为」项。

const { Menu, MenuItem, dialog, clipboard, shell, app } = require('electron')
const path = require('path')
const fs = require('fs')

const IMAGE_FILTERS = [
  { name: 'PNG Image', extensions: ['png'] },
  { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP Image', extensions: ['webp'] },
  { name: 'All Files', extensions: ['*'] },
]

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

function isDataUrl(url) {
  return typeof url === 'string' && /^data:image\//i.test(url)
}

function inferExtFromMime(dataUrl) {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,/.exec(dataUrl)
  if (!m) return 'png'
  const mime = m[1].toLowerCase()
  if (mime === 'jpeg') return 'jpg'
  if (mime === 'svg+xml') return 'svg'
  return mime
}

function defaultFilenameFor(srcURL, suggested) {
  if (suggested && suggested.trim()) return suggested
  if (isDataUrl(srcURL)) return `image-${Date.now()}.${inferExtFromMime(srcURL)}`
  try {
    const u = new URL(srcURL)
    const last = path.basename(u.pathname) || ''
    if (last && last.includes('.')) return last
  } catch {}
  return `image-${Date.now()}.png`
}

async function saveDataUrl(parentWindow, srcURL, suggested) {
  const defaultPath = path.join(app.getPath('downloads'), defaultFilenameFor(srcURL, suggested))
  const result = await dialog.showSaveDialog(parentWindow, {
    title: '图片另存为',
    defaultPath,
    filters: IMAGE_FILTERS,
  })
  if (result.canceled || !result.filePath) return
  const base64 = srcURL.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
  await fs.promises.writeFile(result.filePath, Buffer.from(base64, 'base64'))
}

async function saveHttpUrl(parentWindow, webContents, srcURL, suggested) {
  const defaultPath = path.join(app.getPath('downloads'), defaultFilenameFor(srcURL, suggested))
  const result = await dialog.showSaveDialog(parentWindow, {
    title: '图片另存为',
    defaultPath,
    filters: IMAGE_FILTERS,
  })
  if (result.canceled || !result.filePath) return

  const session = webContents.session
  const onWillDownload = (_event, item) => {
    item.setSavePath(result.filePath)
  }
  session.once('will-download', onWillDownload)
  try {
    webContents.downloadURL(srcURL)
  } catch (err) {
    session.removeListener('will-download', onWillDownload)
    console.error('[image-context-menu] downloadURL failed:', err)
  }
}

function buildMenu({ parentWindow, webContents, params }) {
  const srcURL = params.srcURL || ''
  const suggested = params.suggestedFilename || params.altText || ''
  const menu = new Menu()

  const canSave = isHttpUrl(srcURL) || isDataUrl(srcURL)
  if (canSave) {
    menu.append(
      new MenuItem({
        label: '图片另存为…',
        click: () => {
          if (isDataUrl(srcURL)) {
            saveDataUrl(parentWindow, srcURL, suggested).catch((err) =>
              console.error('[image-context-menu] saveDataUrl failed:', err),
            )
          } else {
            saveHttpUrl(parentWindow, webContents, srcURL, suggested).catch((err) =>
              console.error('[image-context-menu] saveHttpUrl failed:', err),
            )
          }
        },
      }),
    )
  }

  if (srcURL) {
    menu.append(
      new MenuItem({
        label: '复制图片地址',
        click: () => clipboard.writeText(srcURL),
      }),
    )
  }

  if (isHttpUrl(srcURL)) {
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(
      new MenuItem({
        label: '在浏览器中打开',
        click: () => shell.openExternal(srcURL),
      }),
    )
  }

  return menu
}

function attachImageContextMenu(webContents) {
  if (!webContents) return
  webContents.on('context-menu', (_event, params) => {
    const isImage = params.mediaType === 'image' && params.hasImageContents
    if (!isImage) return
    if (!params.srcURL) return

    const parentWindow =
      typeof webContents.getOwnerBrowserWindow === 'function'
        ? webContents.getOwnerBrowserWindow()
        : null

    const menu = buildMenu({ parentWindow, webContents, params })
    if (menu.items.length === 0) return
    menu.popup({ window: parentWindow ?? undefined })
  })
}

module.exports = { attachImageContextMenu }
```

- [ ] **Step 2: 验证模块语法**

Run: `node -e "require('./electron/image-context-menu.js'); console.log('ok')"`

Expected: 输出 `ok`，无 SyntaxError（注意：`require('electron')` 在裸 node 下会报错，所以本步**只验证文件能被解析**。如果报 `Cannot find module 'electron'`，是预期的——继续下一步。）

如报 `Cannot find module 'electron'`，改用：
```bash
node --check electron/image-context-menu.js
```
Expected: 无输出（语法 OK）

- [ ] **Step 3: 提交**

```bash
git add electron/image-context-menu.js
git commit -m "feat(electron): add reusable image right-click context menu module"
```

---

## Task 3: 在主窗口挂载右键菜单

**Files:**
- Modify: `electron/main.js`（`createWindow()` 函数内）

- [ ] **Step 1: 在 main.js 中挂载**

打开 `electron/main.js`，找到现有的：

```js
    // 🔒 安全: 阻止新窗口创建，外部链接用默认浏览器打开
    const { shell } = require('electron');
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
```

在它**下方**插入：

```js
    // 🖱️ 图片右键菜单（图片另存为 / 复制地址 / 在浏览器中打开）
    const { attachImageContextMenu } = require('./image-context-menu');
    attachImageContextMenu(mainWindow.webContents);
```

- [ ] **Step 2: 启动应用，手动验证 smoke test**

Run: `npm run dev`

Expected: 应用正常启动，无 main 进程报错

- [ ] **Step 3: 手动 smoke checklist**

依次执行下列每一项，全部通过才算合格：

- [ ] **3.1** 在 History 页打开图片预览 → 点 `[ SAVE.IMG ]` → 浏览器下载到默认下载目录，文件名形如 `donor-571019-1.png`
- [ ] **3.2** 在 Director / Batch / History 任意页面右键一张已加载的图片 → 弹出菜单，包含「图片另存为…」「复制图片地址」「在浏览器中打开」
- [ ] **3.3** 选「图片另存为…」→ 弹出原生 SaveDialog，默认路径为下载目录 → 选路径并确认 → 文件正确保存
- [ ] **3.4** 选「复制图片地址」→ 在外部记事本粘贴 → 内容为图片 URL
- [ ] **3.5** 选「在浏览器中打开」→ 系统默认浏览器打开图片
- [ ] **3.6** 右键页面空白处 / 文字 → **不**弹出菜单
- [ ] **3.7** 右键 base64 内嵌图片（例如导演模式生成中间产物）→ 「另存为」可正常保存为 PNG
- [ ] **3.8** SaveDialog 中点取消 → 不下载，无任何报错

- [ ] **Step 4: 提交**

```bash
git add electron/main.js
git commit -m "feat(electron): attach image context menu to main window"
```

---

## Task 4: 文档更新

**Files:**
- Modify: `docs/superpowers/specs/2026-04-20-image-download-everywhere-design.md`（标记 Status）

- [ ] **Step 1: 在 spec 中标记完成**

修改 spec 顶部 `**Status:** Approved` → `**Status:** Implemented`

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-04-20-image-download-everywhere-design.md
git commit -m "docs: mark image-download-everywhere spec as implemented"
```

---

## Self-Review

**1. Spec coverage**

| Spec 要求 | 实现位置 |
|----------|---------|
| DonorPreview 增加 `[ SAVE.IMG ]` 按钮 | Task 1 Step 3 |
| 文件名规则 `donor-{shortId}-{idx+1}.png` | Task 1 Step 3 `handleSave` |
| 仅在 url 存在时显示 | Task 1 Step 3，`{url && (...)}` 条件 |
| 单元测试覆盖：渲染、点击、空 url 隐藏 | Task 1 Step 1 三个 it 块 |
| 创建独立模块 `electron/image-context-menu.js` | Task 2 |
| `params.mediaType === 'image' && hasImageContents` 守卫 | Task 2 `attachImageContextMenu` |
| 菜单三项（另存为/复制地址/在浏览器中打开） | Task 2 `buildMenu` |
| `dialog.showSaveDialog` + `webContents.downloadURL` + `session.once('will-download')` | Task 2 `saveHttpUrl` |
| `data:` URI 走 `fs.writeFile` | Task 2 `saveDataUrl` |
| `blob:` URI 隐藏「另存为」 | Task 2 `canSave` 仅 http/data 时为 true |
| 主进程在 `createWindow` 中挂载 | Task 3 Step 1 |
| 8 项手动 smoke test | Task 3 Step 3 |

✅ 全覆盖。

**2. Placeholder scan**
- 无 TBD/TODO/"实现细节略"
- 所有代码块完整，可直接拷贝
- 错误处理在每个 async 函数中显式 `console.error`

**3. Type / 命名一致性**
- `attachImageContextMenu` 在 Task 2 定义、Task 3 引用 — 一致
- `handleSave` 命名一致
- `buildMenu` 输入参数 `{ parentWindow, webContents, params }` 在调用点保持一致
- `IMAGE_FILTERS` 在 `saveDataUrl` 和 `saveHttpUrl` 都引用 — 一致

✅ 通过。
