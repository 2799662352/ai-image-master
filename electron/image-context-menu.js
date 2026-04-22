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

async function saveHttpUrl(parentWindow, _webContents, srcURL, suggested) {
  const defaultPath = path.join(app.getPath('downloads'), defaultFilenameFor(srcURL, suggested))
  const result = await dialog.showSaveDialog(parentWindow, {
    title: '图片另存为',
    defaultPath,
    filters: IMAGE_FILTERS,
  })
  if (result.canceled || !result.filePath) return

  const { net } = require('electron')
  const res = await net.fetch(srcURL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const arrayBuf = await res.arrayBuffer()
  await fs.promises.writeFile(result.filePath, Buffer.from(arrayBuf))
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
