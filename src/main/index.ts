// src/main/index.ts - Electron 主进程 (TypeScript)
import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, net, clipboard, nativeImage } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getAutoUpdaterInstance, AutoUpdater } from './updater'
import { resolveMainWindowShortcut } from './keyboardShortcuts'
import {
  submitSplit,
  cancelTask,
  cancelAllActiveTasks,
  getConfig as getSplitConfig,
  setCredentialsFromUI,
  setDefaultsFromUI,
  setMainWindow as setSplitMainWindow,
  deleteRemoteObjects,
} from './services/storyboardSplit'
import {
  submitErase,
  cancelEraseTask,
  cancelAllActiveSmartEraseTasks,
  getEraseConfig,
  setEraseCredentialsFromUI,
  deleteEraseRemoteObjects,
  setMainWindow as setEraseMainWindow,
} from './services/smartErase'
import { untrackAndCleanupAll as cleanupSmartEraseReaper } from './services/smartErase/reaper'
import { AgentManager } from './agent/AgentManager'
import { AttachmentService } from './agent/AttachmentService'
import { consumeStartupNotice, getPrisma, shutdownDatabase } from './agent/db'
import { registerAgentIpc } from './agent/ipc'
import { migrateLegacyUserSkills } from './agent/legacySkillsMigration'
import { registerMarketplaceIpc } from './marketplace/ipc'
import { ThreadStore } from './agent/ThreadStore'
import { uploadBufferToBucket } from './services/tencent/cosClient'
import { registerAttachmentsTreeIpc, wireAttachmentBroadcast } from './file-explorer/AttachmentTreeProvider'
import { AttachmentDirWatcher } from './file-explorer/AttachmentDirWatcher'
import { registerFsIpc } from './file-explorer/fsIpc'
import { registerLocalFileScheme, installLocalFileHandler } from './file-explorer/protocolHandler'
import { registerAttachmentsThumbIpc } from './file-explorer/attachmentsIpc'
import { registerMediaThumbIpc } from './file-explorer/mediaThumbIpc'
import { registerFsWatcherIpc, disposeAll as disposeFsWatchers } from './file-explorer/fsWatcher'
import { startCatimationMcpServer } from './mcp/server'
import type { McpRuntime } from './mcp/server'

// 检测开发模式：通过命令行参数或环境变量
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'

// ─── 全局错误兜底 ────────────────────────────────────────────────────────────
//
// Node 15+ / Electron 15+ 的默认行为是: unhandledRejection 会让进程崩溃。
// Electron 官方文档 ("Utility Process unhandled rejection behavior change")
// 明确建议对此类事件自己接管, 不要让它直接 process.exit。
//
// 这里我们尽早(import 之后立刻)装上 listener, 这样后续任何模块加载或
// 同步初始化里抛出来的 promise rejection 都能被吃掉, 不会拖崩主进程。
// 95+ 个 ipcMain.handle 里的抛错 Electron 会自动序列化 reject 回 renderer,
// 那条路径不在这里覆盖范围内 —— 这里管的是 ipc handler **外部** 的:
//   - setTimeout / setInterval 里的 async 抛错
//   - .catch(...) 里再抛的二次错误
//   - unawaited promise (void fn(); 但 fn 内部 reject)
//   - 模块顶层 await 的失败
//
// 选择 log + 不 exit: 主进程崩了用户必须重启, 体验远差于把错误吞下打日志。
// 调试期通过 console + electron-log 落盘就能事后排查。
process.on('unhandledRejection', (reason, promise) => {
  const msg =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack}`
      : String(reason)
  console.error('[main] unhandledRejection (吞掉, 不让进程崩):', msg, promise)
})
process.on('uncaughtException', (error, origin) => {
  console.error(
    `[main] uncaughtException (吞掉, 不让进程崩) origin=${origin}:`,
    error?.stack || error,
  )
  // 注意: Node 文档说 uncaughtException 之后进程已处于"未定义状态",
  // 严格上应该 exit。但在 Electron 桌面应用里, 直接 exit 用户感知就是
  // "自我删除/无声闪退"; 我们选择继续运行, 配合 IPC 回执报错让用户重试
  // 当前操作。这是 ux-vs-correctness 的有意取舍。
})

// 类型定义
interface StoreInstance {
  get: (key: string) => any
  set: (key: string, value: any) => void
  delete: (key: string) => void
}

interface ImageSaveParams {
  base64Data: string
  filename: string
}

interface ImageExportParams {
  base64Data: string
  targetDir: string
  filename: string
}

interface GalleryImageParams {
  id: string
  name: string
  sourcePath: string
}

interface GalleryImageMeta {
  id: string
  name: string
  filename: string
  createdAt: string
}

// 延迟加载 electron-store，避免启动时阻塞
let Store: any
let pageStateStore: StoreInstance | null = null
let templateStore: StoreInstance | null = null
let galleryStore: StoreInstance | null = null

function getPageStateStore(): StoreInstance {
  if (!pageStateStore) {
    if (!Store) Store = require('electron-store')
    pageStateStore = new Store({
      name: 'page-states',
      defaults: {
        version: '1.0.0',
        states: {}
      }
    })
  }
  return pageStateStore!
}

function getTemplateStore(): StoreInstance {
  if (!templateStore) {
    if (!Store) Store = require('electron-store')
    templateStore = new Store({
      name: 'custom-templates',
      defaults: {
        version: '1.0.0',
        templates: {},
        overrides: {}
      }
    })
  }
  return templateStore!
}

function getGalleryStore(): StoreInstance {
  if (!galleryStore) {
    if (!Store) Store = require('electron-store')
    galleryStore = new Store({
      name: 'custom-gallery-meta',
      defaults: {
        version: '2.0.0',
        images: []
      }
    })
  }
  return galleryStore!
}

// 记录启动时间
const startTime = Date.now()

// 性能优化：禁用默认应用菜单
Menu.setApplicationMenu(null)

// 抑制 GPU 缓存警告
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-gpu-program-cache')

// 开发模式下禁用 HTTP 磁盘缓存，避免缓存锁定问题
if (isDev) {
  app.commandLine.appendSwitch('disable-http-cache')
}

registerLocalFileScheme()

/**
 * 清理可能损坏的 Chromium 缓存目录
 * 解决 Windows 上常见的缓存锁定/权限问题
 * - Unable to move the cache
 * - Unable to create cache
 * - Failed to delete the database (Service Worker)
 */
function cleanupCorruptedCache(): void {
  try {
    const userDataPath = app.getPath('userData')
    const cacheDirs = [
      'Cache',
      'Code Cache', 
      'GPUCache',
      'Service Worker',
      'databases'  // WebSQL legacy cleanup (Electron 32+)
    ]

    for (const dirName of cacheDirs) {
      const dirPath = path.join(userDataPath, dirName)
      if (fs.existsSync(dirPath)) {
        // 尝试重命名为临时目录（避免直接删除时的锁定问题）
        const tempPath = path.join(userDataPath, `${dirName}_old_${Date.now()}`)
        try {
          fs.renameSync(dirPath, tempPath)
          // 异步删除旧目录
          fs.rm(tempPath, { recursive: true, force: true }, () => {})
        } catch {
          // 如果重命名失败（文件被锁定），跳过
        }
      }
    }
  } catch (error) {
    // 缓存清理失败不影响应用启动
    console.warn('[Cache Cleanup] 清理缓存目录时出错:', error)
  }
}

// 在 app ready 之前清理缓存（仅首次启动或检测到问题时）
const cacheCleanupMarker = path.join(app.getPath('userData'), '.cache_cleaned')
if (!fs.existsSync(cacheCleanupMarker)) {
  cleanupCorruptedCache()
  // 标记已清理，避免每次启动都清理
  try {
    fs.writeFileSync(cacheCleanupMarker, new Date().toISOString())
  } catch {}
}

// 数据存储目录
let userDataPath: string
let imagesDir: string
let historyFile: string
let customGalleryPath: string | null = null
let mainWindow: BrowserWindow | null = null
let agentManager: AgentManager | null = null
let agentMcpRuntime: McpRuntime | null = null
let attachmentDirWatcher: AttachmentDirWatcher | null = null
let agentRuntimeCleanedUp = false
let isQuittingAfterAgentCleanup = false

// Single-instance lock — defends against the PGlite #884 dual-instance
// corruption pathway. PGlite is "Postgres in single-user mode" (per upstream
// docs/filesystems.md) and concurrent opens of the same dataDir reliably
// brick it with `RuntimeError: Aborted()`. Without this lock, a user can
// open two copies of the installer side-by-side and silently corrupt their
// agent thread history. With it, the second launch hands off to the first
// (focuses its window) and quits cleanly.
//
// @see https://github.com/electric-sql/pglite/issues/884
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  // `app.quit()` is asynchronous; calling `process.exit` here would race the
  // event loop. The renderer never starts because we exit `whenReady` early.
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Deferred promise resolved when AgentManager finishes initializing.
// Agent IPC handlers (registered eagerly at app ready) `await` this so renderer
// calls that fire before the manager is ready block instead of crashing with
// "No handler registered" — the first-launch race we hit before this fix.
let resolveAgentManager: (manager: AgentManager) => void = () => {}
let rejectAgentManager: (error: unknown) => void = () => {}
const agentManagerReadyPromise: Promise<AgentManager> = new Promise((resolve, reject) => {
  resolveAgentManager = resolve
  rejectAgentManager = reject
})
// Mark the promise as handled so an early-init failure does not show up as an
// unhandled rejection. Handlers that await the promise will still see the error.
agentManagerReadyPromise.catch(() => {})

function getReadyAgentManager(): Promise<AgentManager> {
  return agentManagerReadyPromise
}

function getReadyToolRouter() {
  return agentMcpRuntime?.router ?? null
}

function initPaths(): void {
  userDataPath = app.getPath('userData')
  imagesDir = path.join(userDataPath, 'generated-images')
  historyFile = path.join(userDataPath, 'history.json')
}

async function ensureDirectories(): Promise<void> {
  try {
    await fs.promises.mkdir(imagesDir, { recursive: true })
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      console.error('创建目录失败:', error)
    }
  }
}

function initCustomGalleryPath(): string {
  if (!customGalleryPath && userDataPath) {
    customGalleryPath = path.join(userDataPath, 'custom-gallery')
    if (!fs.existsSync(customGalleryPath)) {
      fs.mkdirSync(customGalleryPath, { recursive: true })
    }
  }
  return customGalleryPath!
}

/**
 * 一次性注册 nativeTheme 监听 —— createWindow() 在 macOS dock 重新点击或
 * 其他场景下会被多次调用, 旧实现每次都 `nativeTheme.on('updated', ...)`,
 * 全局 EventEmitter 上累积 N 个相同 listener, 切主题时被回调 N 次, 还会触发
 * MaxListenersExceededWarning。这里改为模块级一次性注册。
 *
 * Windows 在切 dark/light、wallpaper accent、高对比度时会短时间内连续触发
 * 多次 `updated` 事件; 我们用 50ms throttle + 值比较去抖, 没变就不发, 避免
 * renderer 跟着反复重渲。
 */
let nativeThemeListenerInstalled = false
function setupNativeThemeListenerOnce(): void {
  if (nativeThemeListenerInstalled) return
  nativeThemeListenerInstalled = true

  let lastTheme = {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
  }
  let themeUpdateTimer: ReturnType<typeof setTimeout> | null = null

  nativeTheme.on('updated', () => {
    if (themeUpdateTimer !== null) return
    themeUpdateTimer = setTimeout(() => {
      themeUpdateTimer = null
      const next = {
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
      }
      if (
        next.shouldUseDarkColors === lastTheme.shouldUseDarkColors &&
        next.prefersReducedTransparency === lastTheme.prefersReducedTransparency
      ) return
      lastTheme = next
      mainWindow?.webContents.send('native-theme-changed', next)
    }, 50)
  })
}

function createWindow(): void {
  console.log(`[Performance] Window created: ${Date.now() - startTime}ms`)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'CATIMATION-Cyberpunk Master',
    icon: path.join(__dirname, '../../build/icon.png'),
    show: false,
    backgroundColor: '#09090B',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js'),
      // 安全加固选项
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })

  // 安全: 设置 Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' node: https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: blob: https: file: local-file:",
          "connect-src 'self' https: wss: data: http://175.178.198.17:* http://127.0.0.1:* http://localhost:*",
            // allow COS HTTPS presigned URLs (smart erase output), file:// (compare-with-original),
            // and local-file:// for the file-explorer video previewer.
            "media-src 'self' data: blob: https: file: local-file:",
          "worker-src 'self' blob:", // 允许 Web Worker 从 blob URL 创建（图片压缩库需要）
          "frame-src https:"
        ].join('; ')
      }
    })
  })

  // 安全: 限制导航 - 防止打开外部链接
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    // 只允许同源导航和 file:// 协议
    if (parsedUrl.protocol !== 'file:' && parsedUrl.origin !== 'http://localhost:5173') {
      console.warn(`[Security] 阻止导航到: ${navigationUrl}`)
      event.preventDefault()
    }
  })

  // 安全: 阻止新窗口创建
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 使用默认浏览器打开外部链接
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 键盘快捷键: F5 / Ctrl+R / Cmd+R 刷新, F12 devtools, F11 全屏。
  //
  // 路由逻辑抽到 `resolveMainWindowShortcut` 纯函数里:
  //   1. 单测覆盖所有分支(`src/main/__tests__/keyboardShortcuts.test.ts`)。
  //   2. 关键顺序约束(Ctrl+Shift+R 先于 Ctrl+R)封装在那里,避免改本文件
  //      时不小心把顺序弄反 —— v4.2.x 曾因此一次强刷闪两次。
  //   3. F11 是 v4.3.12 重新接回的 affordance:`Menu.setApplicationMenu(null)`
  //      去掉默认菜单后副作用是 togglefullscreen role 的 accelerator 也丢,
  //      这里在 keyDown 上显式 toggle 把行为还回来。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const action = resolveMainWindowShortcut(input)
    if (!action || !mainWindow) return
    switch (action.type) {
      case 'toggleDevTools':
        mainWindow.webContents.toggleDevTools()
        break
      case 'reload':
        mainWindow.webContents.reload()
        break
      case 'reloadIgnoringCache':
        mainWindow.webContents.reloadIgnoringCache()
        break
      case 'toggleFullScreen':
        mainWindow.setFullScreen(!mainWindow.isFullScreen())
        break
    }
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', async () => {
    console.log(`[Performance] Ready to show: ${Date.now() - startTime}ms`)
    
    // 清理 Service Worker 缓存（解决 service_worker_storage 错误）
    if (isDev) {
      try {
        await mainWindow?.webContents.session.clearStorageData({
          storages: ['serviceworkers']
        })
      } catch {
        // 忽略清理错误
      }
    }
    
    mainWindow?.show()
    
    // 发送初始主题状态
    mainWindow?.webContents.send('native-theme-changed', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency
    })
  })

  // nativeTheme 监听已经移到 `setupNativeThemeListenerOnce()`(模块级),
  // 这样 createWindow() 即便在 app.on('activate') 时被重复调用, 也不会
  // 给全局 nativeTheme 重复挂 listener。这里只负责一次性同步初始状态,
  // 同步逻辑写在上面的 ready-to-show 里。
  setupNativeThemeListenerOnce()

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  
  // 开发模式打开 DevTools
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[Performance] Page loaded: ${Date.now() - startTime}ms`)
  })

  // 右键菜单 - 支持图片保存
  mainWindow.webContents.on('context-menu', async (_event, params) => {
    // File Explorer 面板内的右键由 React 自定义菜单处理；
    // 主进程跳过原生 fallback，避免「刷新 / 开发者工具」漏出覆盖到自定义菜单上方。
    try {
      const inFileExplorer = await mainWindow!.webContents.executeJavaScript(
        `(() => { const el = document.elementFromPoint(${params.x}, ${params.y}); return !!(el && el.closest && el.closest('[data-file-explorer-root]')); })()`,
        true,
      )
      if (inFileExplorer) return
    } catch {
      // executeJavaScript 失败时退回到默认行为
    }

    const menuTemplate: Electron.MenuItemConstructorOptions[] = []

    const isImage = params.mediaType === 'image'
    const hasSrc = !!params.srcURL
    const hasContent = params.hasImageContents

    if (isImage && (hasSrc || hasContent)) {
      const resolveImageUrl = async (): Promise<string | null> => {
        if (params.srcURL) return params.srcURL
        try {
          return await mainWindow!.webContents.executeJavaScript(
            `(function(){var e=document.elementFromPoint(${params.x},${params.y});` +
            `if(e&&e.tagName==='IMG'&&e.src)return e.src;return null})()`
          )
        } catch { return null }
      }

      menuTemplate.push({
        label: '图片另存为…',
        click: async () => {
          try {
            const url = await resolveImageUrl()
            if (!url) throw new Error('Could not retrieve image URL')

            const isDataUri = url.startsWith('data:')
            let ext = '.png'
            if (url.includes('.jpg') || url.includes('.jpeg') || url.startsWith('data:image/jpeg')) ext = '.jpg'
            else if (url.includes('.webp') || url.startsWith('data:image/webp')) ext = '.webp'
            else if (url.includes('.gif') || url.startsWith('data:image/gif')) ext = '.gif'

            const defaultName = params.suggestedFilename || `image_${Date.now()}${ext}`
            const result = await dialog.showSaveDialog(mainWindow!, {
              title: '图片另存为',
              defaultPath: path.join(app.getPath('downloads'), defaultName),
              filters: [
                { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
                { name: '所有文件', extensions: ['*'] }
              ]
            })
            if (result.canceled || !result.filePath) return

            if (isDataUri) {
              const base64Data = url.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
              await fs.promises.writeFile(result.filePath, Buffer.from(base64Data, 'base64'))
            } else {
              const res = await net.fetch(url)
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const arrayBuf = await res.arrayBuffer()
              await fs.promises.writeFile(result.filePath, Buffer.from(arrayBuf))
            }
          } catch (error) {
            console.error('[context-menu] 保存图片失败:', error)
          }
        }
      })

      menuTemplate.push({
        label: '复制图片',
        click: () => {
          mainWindow?.webContents.copyImageAt(params.x, params.y)
        }
      })

      const directUrl = params.srcURL
      const isHttpUri = directUrl && /^https?:\/\//i.test(directUrl)
      if (isHttpUri) {
        menuTemplate.push({
          label: '复制图片地址',
          click: () => {
            clipboard.writeText(directUrl)
          }
        })
        menuTemplate.push({ type: 'separator' })
        menuTemplate.push({
          label: '在浏览器中打开',
          click: () => shell.openExternal(directUrl)
        })
      }

      menuTemplate.push({ type: 'separator' })
    }

    if (params.linkURL) {
      menuTemplate.push(
        {
          label: '复制链接',
          click: () => {
            clipboard.writeText(params.linkURL)
          }
        },
        {
          label: '在浏览器中打开',
          click: () => shell.openExternal(params.linkURL)
        },
        { type: 'separator' }
      )
    }

    if (params.selectionText) {
      menuTemplate.push(
        { role: 'copy', label: '复制' },
        { type: 'separator' }
      )
    }

    if (params.isEditable) {
      menuTemplate.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      )
    }

    if (menuTemplate.length === 0) {
      menuTemplate.push(
        { role: 'reload', label: '刷新' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      )
    }

    if (menuTemplate.length > 0) {
      const menu = Menu.buildFromTemplate(menuTemplate)
      menu.popup()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function initAgentRuntime(win: BrowserWindow): Promise<void> {
  // Once the AgentManager exists this conversation is initialized — we just
  // rebind the new BrowserWindow. We deliberately do NOT key off
  // `agentMcpRuntime` here because it can legitimately be null when the
  // local HTTP listener failed to bind (see startCatimationMcpServer); the
  // rest of the agent surface is still usable in that case.
  if (agentManager) {
    agentManager.setWindow(win)
    agentMcpRuntime?.router.setWindow(win)
    return
  }

  try {
    const prisma = await getPrisma()
    const threadStore = new ThreadStore(prisma)
    const attachmentService = new AttachmentService(prisma)
    // Defense-in-depth invalidation for the renderer ATTACHMENTS panel
    // (mirrors VSCode's parcelWatcher.ts pattern of "watcher emits, consumer
    // pulls"):
    //   (A) Synchronous in-process success signal — fires the instant a chat
    //       upload's DB row + disk file both exist. AttachmentService.emit
    //       → wireAttachmentBroadcast → BrowserWindow.send.
    //   (B) Native FS watcher on the uploads directory — catches external
    //       writes (manual drag-in, backup restore, concurrent processes) that
    //       (A) can't observe. 75ms trailing aggregator collapses the
    //       tmp-then-rename burst into a single renderer broadcast.
    // Either path alone closes the original bug; both together also keep the
    // panel correct when the FS watcher is degraded (macOS seatbelt, EACCES).
    wireAttachmentBroadcast(attachmentService)
    const uploadsDir = path.join(app.getPath('userData'), 'agent', 'uploads')
    attachmentDirWatcher = new AttachmentDirWatcher(uploadsDir)
    // Fire-and-forget: start() resolves once @parcel/watcher.subscribe finishes
    // its async native handshake. The watcher gracefully degrades on failure
    // (AttachmentService.emit is the in-process fallback), and downstream
    // initAgentRuntime steps don't depend on the watcher being live, so we
    // don't block the boot path.
    void attachmentDirWatcher.start()
    agentMcpRuntime = await startCatimationMcpServer(win)
    if (!agentMcpRuntime) {
      console.warn(
        '[AgentRuntime] catimation MCP HTTP listener unavailable; ' +
          'agent will run without the local MCP tool surface.',
      )
    }
    agentManager = new AgentManager({
      userDataDir: app.getPath('userData'),
      win,
      store: threadStore,
      attachments: attachmentService,
    })
    // Unblock any IPC handlers that fired before the manager was ready (e.g.
    // the renderer's mount-time `agent:list-threads`).
    resolveAgentManager(agentManager)
    void attachmentService.cleanup().catch((error) => {
      console.warn('[AgentRuntime] attachment cleanup failed:', error)
    })

    try {
      await agentManager.start()
    } catch (error) {
      console.error('[AgentRuntime] Codex backend init failed:', error)
    }

    // Flush any startup notice queued by the PGlite recovery branch (e.g.
    // "数据库已自动重建"). Two-step delivery to dodge two well-known races:
    //   1. webContents.send is fire-and-forget — if the page hasn't finished
    //      loading, the message is dropped on the floor (electron/electron#9384
    //      community thread). Wait for did-finish-load if needed.
    //   2. Even after did-finish-load, the renderer's ipcRenderer.on('agent:event')
    //      subscription happens inside React effects which run a tick later. Add
    //      a small grace delay so the chat store is mounted and listening.
    const startupNotice = consumeStartupNotice()
    if (startupNotice && win && !win.isDestroyed()) {
      const dispatchNotice = (): void => {
        if (win.isDestroyed()) return
        // 250ms: empirically lands after AgentChatPanel mounts and registers
        // its IPC listener via store init. Tested with `npm run dev`; if it
        // becomes flaky, switch to an explicit "renderer-ready" handshake.
        setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:event', { type: 'notice', notice: startupNotice })
          }
        }, 250)
      }
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', dispatchNotice)
      } else {
        dispatchNotice()
      }
    }
  } catch (error) {
    // Surface the real init failure to renderer IPC calls instead of leaving
    // them hanging forever on a never-resolving promise.
    rejectAgentManager(error)
    throw error
  }
}

async function cleanupAgentRuntime(): Promise<void> {
  if (agentRuntimeCleanedUp) return
  agentRuntimeCleanedUp = true
  try {
    await attachmentDirWatcher?.dispose()
    attachmentDirWatcher = null
    await agentManager?.stop()
    // Don't leak the docker mcp gateway sidecar on app quit. Best-effort
    // since the user may have already killed `docker` independently.
    try {
      const { getDockerMcpGatewayService } = await import('./agent/dockerMcpGateway')
      await getDockerMcpGatewayService().stop()
    } catch (err) {
      console.warn('[AgentRuntime] dockerMcpGateway cleanup failed:', err)
    }
  } finally {
    await shutdownDatabase()
  }
}

// App 生命周期
app.whenReady().then(async () => {
  console.log(`[Performance] App ready: ${Date.now() - startTime}ms`)
  installLocalFileHandler()
  registerFsIpc()
  registerAttachmentsTreeIpc(getPrisma)
  registerAttachmentsThumbIpc()
  // media:thumb — resized-JPEG hot-path IPC for chat/thumbnail render surfaces
  // (PR-A of fix-codex-chat-image-attachment-lag). attachments:read-thumb
  // stays registered above for the lightbox / download path (fullFidelity).
  registerMediaThumbIpc()
  registerFsWatcherIpc()

  // 关键路径：仅初始化必要的路径和目录
  initPaths()
  await ensureDirectories()

  console.log(`[Performance] Paths initialized: ${Date.now() - startTime}ms`)

  // Register agent IPC handlers BEFORE the window starts loading so the
  // renderer's mount-time calls (e.g. `agent:list-threads`) always hit a
  // registered handler. Each handler awaits `getReadyAgentManager()` so it
  // transparently blocks until `initAgentRuntime` resolves the manager.
  registerAgentIpc(getReadyAgentManager, getReadyToolRouter)

  // 关键路径：创建窗口
  createWindow()

  if (mainWindow) setSplitMainWindow(mainWindow)
  if (mainWindow) setEraseMainWindow(mainWindow)
  if (mainWindow) {
    void initAgentRuntime(mainWindow).catch((error) => {
      console.error('[AgentRuntime] init failed:', error)
    })
  }

  // 非关键路径：延迟初始化
  deferNonCriticalInit()
})

/**
 * 延迟初始化非关键功能
 * 在窗口显示后再初始化，避免阻塞启动
 * 
 * 优化策略:
 * - 关键路径: app.whenReady -> initPaths -> createWindow (~200ms)
 * - 次关键: stores warmup (5s delay) - 用户可能很快需要
 * - 非关键: autoUpdater (15s delay) - 后台任务
 */
function deferNonCriticalInit(): void {
  // 次关键路径：预热存储（延迟 5 秒）
  // 大多数用户操作需要存储访问，但不需要立即可用
  setTimeout(() => {
    // 触发延迟加载 electron-store
    getPageStateStore()
    getTemplateStore()
    console.log(`[Performance] Stores warmed up: ${Date.now() - startTime}ms`)
  }, 5000)

  // 非关键路径：初始化自动更新（仅生产环境，延迟 15 秒）
  // 用户完全交互后再检查更新，避免网络争用
  if (!isDev) {
    // 捕获当前 mainWindow 引用，避免闭包问题
    const currentWindow = mainWindow
    setTimeout(() => {
      // 检查窗口是否仍然有效
      if (currentWindow && !currentWindow.isDestroyed()) {
        // 使用 getAutoUpdaterInstance() 获取已初始化的实例
        // 仅检测国内热更新 CDN（腾讯云 COS）。GitHub 上的 release 仅作为
        // 源码备份，autoUpdater 不再回退到 GitHub Releases — 当 COS 检测
        // 失败时直接抛错给用户，避免国内网络环境下卡在 GitHub 超时。
        const updater = getAutoUpdaterInstance({
          provider: 'generic',
          url: 'https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/',
          // round-5: 在 NSIS 接管之前必须杀掉 codex/docker mcp gateway 子进程,
          // 否则它们握着 resources/*.node / app.asar 句柄, NSIS partial-install
          // → 用户感知的"更新把自己卸载了"。详见 updater.ts:UpdaterConfig.preInstallCleanup。
          //
          // 注意: 这个 hook 跑完后 cleanupAgentRuntime 内部 agentRuntimeCleanedUp
          // 已置 true, 后续 before-quit 监听里的二次调用会幂等 no-op。
          preInstallCleanup: () => cleanupAgentRuntime(),
        })
        updater.setMainWindow(currentWindow)
        updater.checkForUpdatesOnStartup(0)
        console.log(`[Performance] Auto-updater initialized: ${Date.now() - startTime}ms`)
      }
    }, 15000)
  } else {
    console.log('[Dev] Auto-updater skipped in development mode')
  }

  // 非关键路径：预热 Gallery store（延迟 20 秒）
  // 自定义图库功能使用频率较低
  setTimeout(() => {
    getGalleryStore()
    console.log(`[Performance] Gallery store warmed up: ${Date.now() - startTime}ms`)
  }, 20000)
}

app.on('window-all-closed', () => {
  cancelAllActiveTasks()
  cancelAllActiveSmartEraseTasks()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

app.on('before-quit', (event) => {
  disposeFsWatchers()
  // smartErase reaper 是个 5s setInterval, 还会握着 tracked Map 不放。
  // app.quit() 最终会 kill 进程, 但在那之前的 cleanupAgentRuntime 阶段
  // 这个 interval 会被 v8 当作 "还有事要做" 而拖住 quit 周期。
  // 同步调用, 不需要 await —— 函数内部 tracked.clear() + stopInterval()
  // 都是同步的, async 标记仅为接口对称。
  void cleanupSmartEraseReaper().catch(() => { /* best-effort */ })
  if (isQuittingAfterAgentCleanup) return

  // 安装更新时绝对不能拦截 quit —— electron-updater 在 quitAndInstall
  // 内部已经把 NSIS 安装器拉起来等父进程退出, 我们这里再 preventDefault
  // 一次会让安装器的退出协议错位, 旧 exe 在 Windows 上常会被改名/删除
  // 但新 exe 还没就位, 直接命中"自我删除/启动失败"的坑。所以更新中直接
  // 放行, 让 quit 周期完整跑完。
  if (AutoUpdater.isInstallingUpdate) return

  event.preventDefault()

  const drainUploads = inflightUploads.size > 0
    ? Promise.race([
        Promise.allSettled(inflightUploads),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ])
    : Promise.resolve()

  void Promise.all([
    cleanupAgentRuntime().catch((error) => {
      console.error('[AgentRuntime] cleanup failed:', error)
    }),
    drainUploads,
  ]).finally(() => {
    isQuittingAfterAgentCleanup = true
    app.quit()
  })
})

// ==================== IPC 处理 ====================

// AI Skills 读写
// ---------------------------------------------------------------------------
// Codex CLI builds its skill registry at session start by scanning the
// official roots ONLY: `$HOME/.agents/skills` (USER), `<repo>/.agents/skills`
// (REPO), bundled installer (SYSTEM). A `skill` input item pointing outside
// those roots is rejected by the model with "is not an installed skill in
// this session" (see openai/codex#21524). So all skill IPC entry points
// (open / load / save) must target `$HOME/.agents/skills` from now on.
//
// `userSkillsDir` remains defined as the legacy `<userData>/skills` path
// because:
//   - `migrateLegacyUserSkills` copies its contents into `officialUserSkillsDir`
//     once on startup, then leaves the legacy folder alone (non-destructive);
//   - the side-panel + `/` palette scanners (`codexConfigStore.listSkills` and
//     `codexConfigDiscovery.discoverCodexSkills`) keep reading it via
//     `legacyUserSkillsRoots` so old installs still see their skills even
//     before the migration has run for them.
// ---------------------------------------------------------------------------
const builtinSkillsDir = app.isPackaged
  ? path.join(process.resourcesPath, 'skills')
  : path.resolve(__dirname, '../../skills')
const officialUserSkillsDir = path.join(app.getPath('home'), '.agents', 'skills')
const userSkillsDir = path.join(app.getPath('userData'), 'skills')

// Fire-and-forget startup migration. Resolves to the report so callers (tests
// or future telemetry) can inspect counts, but we don't await it from the
// top-level since the IPC handlers below tolerate the official root being
// created lazily by `mkdirSync(officialUserSkillsDir, { recursive: true })`.
const legacySkillsMigrationPromise: Promise<{ copied: string[]; skipped: string[] }> =
  migrateLegacyUserSkills({
    legacyRoot: userSkillsDir,
    officialRoot: officialUserSkillsDir,
  }).then(
    (report) => {
      if (report.copied.length > 0) {
        console.info(
          `[skills] migrated ${report.copied.length} legacy skill(s) → ${officialUserSkillsDir}: ${report.copied.join(', ')}`,
        )
      }
      return report
    },
    (err) => {
      console.warn('[skills] legacy migration failed (non-fatal):', err)
      return { copied: [], skipped: [] }
    },
  )

// NOTE: As of v4.3.5 we no longer mirror bundled Codex-only skills
// (`resources/codex-skills/*`) into `$HOME/.agents/skills/` on launch. They
// are now published out-of-band through the Skill Marketplace (catalog.json
// + per-skill zips on Tencent COS) and the user opts in to install/update
// each one via the in-app marketplace page. See
// `src/main/marketplace/` and `scripts/upload-skills-to-cos.mjs` for the
// publish + install pipeline.

// Skill Marketplace wiring. The service installs each chosen skill into
// `officialUserSkillsDir` (so existing skill discovery picks them up with
// no further changes) and persists its install ledger to
// `<userData>/marketplace-state.json`.
const marketplaceStateFile = path.join(app.getPath('userData'), 'marketplace-state.json')
const marketplaceService = registerMarketplaceIpc({
  userSkillsDir: officialUserSkillsDir,
  stateFile: marketplaceStateFile,
})

// One-shot adoption pass. v4.3.4 users have ~20 bundled skills already on
// disk (we used to mirror them every launch); marking them as `adopted`
// lets the marketplace UI show them under "Installed" so users can
// uninstall/replace selectively. Failure is non-fatal — the UI's first
// `adopt-existing` IPC call will just retry.
marketplaceService
  .adoptExisting()
  .then((adopted) => {
    if (adopted.length > 0) {
      console.info(
        `[marketplace] adopted ${adopted.length} pre-existing skill(s) into marketplace state: ${adopted.map((r) => r.name).join(', ')}`,
      )
    }
  })
  .catch((err) => {
    console.warn('[marketplace] startup adoption failed (non-fatal):', err)
  })

function readSkillsFromDir(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!fs.existsSync(dir)) return result
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(dir, entry.name, 'SKILL.md')
    if (fs.existsSync(skillFile)) {
      result[entry.name] = fs.readFileSync(skillFile, 'utf-8')
    }
  }
  return result
}

ipcMain.handle('load-skills', async () => {
  try {
    // Wait for legacy <userData>/skills → ~/.agents/skills migration so the
    // first call after a fresh upgrade returns the complete user-scope set.
    // Bundled Codex-only skills are no longer auto-mirrored — they install
    // on-demand through the Skill Marketplace (see scripts/upload-skills-to-cos.mjs).
    await legacySkillsMigrationPromise
    fs.mkdirSync(officialUserSkillsDir, { recursive: true })
    const builtin = readSkillsFromDir(builtinSkillsDir)
    const user = readSkillsFromDir(officialUserSkillsDir)
    // Fallback: still read pre-migration legacy entries (e.g. ones whose
    // target name collided with an official skill during migration).
    const legacy = readSkillsFromDir(userSkillsDir)
    return { ...builtin, ...legacy, ...user }
  } catch (error: any) {
    console.error('加载 Skills 失败:', error)
    return {}
  }
})

ipcMain.handle('save-skill', async (_event, skillName: string, content: string) => {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
      return { success: false, error: 'Invalid skill name' }
    }
    // Write to the Codex-official USER scope so the CLI's skill registry
    // discovers the new skill on next session start. Writing to
    // `<userData>/skills` (the pre-Codex path) would leave the skill
    // invisible to the model — see openai/codex#21524.
    const dir = path.join(officialUserSkillsDir, skillName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
    return { success: true, path: dir }
  } catch (error: any) {
    console.error('保存 Skill 失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('open-skills-folder', async () => {
  try {
    fs.mkdirSync(officialUserSkillsDir, { recursive: true })
    const errorMessage = await shell.openPath(officialUserSkillsDir)
    if (errorMessage) {
      return { success: false, error: errorMessage, path: officialUserSkillsDir }
    }
    return { success: true, path: officialUserSkillsDir }
  } catch (error: any) {
    console.error('打开 Skills 文件夹失败:', error)
    return { success: false, error: error.message, path: officialUserSkillsDir }
  }
})

// ---------------------------------------------------------------------------
// Image History bucket (Tencent COS)
// ---------------------------------------------------------------------------
// The image-history page uploads previews to a *dedicated* bucket separate
// from the storyboardSplit / smartErase bucket (`map-tiles-bucket-...`) so
// that lifecycle policies, public-read settings, and quota don't collide.
// Bucket is hardcoded — switching it requires a coordinated content
// migration; keep it visible in source for code search.
const IMAGE_HISTORY_BUCKET = 'image-master-1345773498'
const IMAGE_HISTORY_REGION = 'ap-guangzhou'

function generateImageHistoryKey(mimeType: string): string {
  const ext = mimeTypeToExtension(mimeType)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  // 16-byte random identifier — `crypto.randomUUID` would also work but
  // keys never need to be cryptographically secret, so randomBytes keeps
  // the dependency surface to `node:crypto` only.
  const id = randomBytes(8).toString('hex')
  return `image-history/${yyyy}/${mm}/${dd}/${id}.${ext}`
}

function mimeTypeToExtension(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/jpeg': case 'image/jpg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/avif': return 'avif'
    case 'image/heic': return 'heic'
    default: return 'bin'
  }
}

/**
 * IPC base64 → Buffer 输入硬上限 (round-5 安全加固)。
 *
 * 大小取舍: 一张 4K PNG 极限大约 30MB binary, base64 编码后 ≈ 40MB。
 * 我们给到 80MB base64 字符串 (≈ 60MB binary) 留足余量, 但坚决拒绝
 * 100MB+ 的输入 —— 因为 main process 没有 v8 heap 之外的 buffer pool,
 * Buffer.from(huge, 'base64') 会瞬间在主进程堆里分配 60MB+ 临时副本,
 * 并发几个 IPC 一起来就能直接 OOM 把主进程打死。
 *
 * 拒绝时尽量在 string 长度阶段就否决, 避免先 allocate 再丢弃。
 */
const MAX_IPC_BASE64_STRING_BYTES = 80 * 1024 * 1024 // 80MB base64 ≈ 60MB binary

/**
 * 校验 IPC 来的 base64 字符串大小, 超限直接拒绝。
 * 返回 null 表示通过, 否则返回错误描述供 handler 透传给 renderer。
 */
function rejectOversizedBase64(s: unknown): string | null {
  if (typeof s !== 'string') return null // 让上层用 type guard 各自报错
  // 用 UTF-16 code unit 数 ≈ ascii 字符数估算字节; base64 全是 ASCII 所以等价。
  if (s.length > MAX_IPC_BASE64_STRING_BYTES) {
    const mb = (s.length / 1024 / 1024).toFixed(1)
    return `base64 payload too large: ${mb}MB (limit ${MAX_IPC_BASE64_STRING_BYTES / 1024 / 1024}MB)`
  }
  return null
}

const inflightUploads = new Set<Promise<void>>()
const MAX_CONCURRENT_UPLOADS_MAIN = 4

async function enqueueUpload(
  opts: Parameters<typeof uploadBufferToBucket>[0],
): Promise<string> {
  while (inflightUploads.size >= MAX_CONCURRENT_UPLOADS_MAIN) {
    await Promise.race(inflightUploads)
  }

  let resolveSlot!: () => void
  const slot = new Promise<void>((r) => {
    resolveSlot = r
  })
  inflightUploads.add(slot)

  try {
    return await uploadBufferToBucket(opts)
  } finally {
    inflightUploads.delete(slot)
    resolveSlot()
  }
}

function mimeFromUrl(url: string, fallback = 'image/png'): string {
  const lower = url.split('?')[0]?.toLowerCase() ?? ''
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  return fallback
}

ipcMain.handle(
  'cos:upload-image-history',
  async (
    _event,
    payload: { base64: string; mimeType: string; metadata?: Record<string, unknown> },
  ): Promise<
    | { success: true; url: string; key: string }
    | { success: false; error: string }
  > => {
    try {
      const { base64, mimeType, metadata } = payload
      if (typeof base64 !== 'string' || !base64) {
        return { success: false, error: 'invalid base64 payload' }
      }
      const oversized = rejectOversizedBase64(base64)
      if (oversized) return { success: false, error: oversized }
      if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
        return { success: false, error: 'invalid mimeType (must be image/*)' }
      }
      const body = Buffer.from(base64, 'base64')
      if (body.byteLength === 0) {
        return { success: false, error: 'empty buffer after base64 decode' }
      }
      const key = generateImageHistoryKey(mimeType)

      const url = await enqueueUpload({
        bucket: IMAGE_HISTORY_BUCKET,
        region: IMAGE_HISTORY_REGION,
        key,
        body,
        contentType: mimeType,
      })

      void metadata
      return { success: true, url, key }
    } catch (err: any) {
      console.error('[cos:upload-image-history] failed:', err)
      return {
        success: false,
        error: err?.message ?? String(err) ?? 'upload failed',
      }
    }
  },
)

// True fire-and-forget: renderer just enqueues a (requestId, sourceUrl)
// pair and returns immediately. Main process fetches the URL, uploads to
// COS in the background, then broadcasts a `cos:upload-result` event with
// the same requestId so the renderer can patch its store by item.id.
//
// Why this exists in addition to the await-based handlers below:
//   - Renderer holds zero pending promises per upload → no microtask
//     pressure, no .then() React re-render cascade when many uploads
//     finish in quick succession.
//   - History persistence at batch-end still works: items keep
//     uploadStatus='uploading' if cos hasn't returned yet; the result
//     event back-patches cosUrl into the item by id afterwards.
function broadcastUploadResult(
  result:
    | { requestId: string; success: true; url: string; key: string }
    | { requestId: string; success: false; error: string },
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('cos:upload-result', result)
    }
  }
}

ipcMain.handle(
  'cos:enqueue-upload-from-url',
  async (
    _event,
    payload: {
      requestId: string
      sourceUrl: string
      mimeType?: string
      metadata?: Record<string, unknown>
    },
  ): Promise<{ queued: true } | { queued: false; error: string }> => {
    const { requestId, sourceUrl, mimeType: hintMime, metadata } = payload || ({} as any)
    if (typeof requestId !== 'string' || !requestId) {
      return { queued: false, error: 'invalid requestId' }
    }
    if (typeof sourceUrl !== 'string' || !sourceUrl) {
      return { queued: false, error: 'invalid sourceUrl' }
    }
    if (!/^https?:\/\//i.test(sourceUrl) && !sourceUrl.startsWith('data:')) {
      return { queued: false, error: 'sourceUrl must be http(s):// or data:' }
    }

    // Don't await — kick off background work and return synchronously.
    void (async () => {
      try {
        let body: Buffer
        let mimeType: string
        if (sourceUrl.startsWith('data:')) {
          const m = /^data:([^;,]+);base64,(.+)$/i.exec(sourceUrl)
          if (!m) {
            broadcastUploadResult({ requestId, success: false, error: 'invalid data: URL' })
            return
          }
          mimeType = m[1] || hintMime || 'image/png'
          body = Buffer.from(m[2], 'base64')
        } else {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30_000)
          try {
            const resp = await fetch(sourceUrl, { signal: controller.signal })
            if (!resp.ok) {
              broadcastUploadResult({ requestId, success: false, error: `fetch ${resp.status}` })
              return
            }
            mimeType = hintMime || resp.headers.get('content-type') || mimeFromUrl(sourceUrl)
            const ab = await resp.arrayBuffer()
            body = Buffer.from(ab)
          } finally {
            clearTimeout(timer)
          }
        }

        if (body.byteLength === 0) {
          broadcastUploadResult({ requestId, success: false, error: 'empty body after fetch' })
          return
        }
        if (!mimeType.startsWith('image/')) {
          mimeType = mimeFromUrl(sourceUrl)
        }

        const key = generateImageHistoryKey(mimeType)
        const url = await enqueueUpload({
          bucket: IMAGE_HISTORY_BUCKET,
          region: IMAGE_HISTORY_REGION,
          key,
          body,
          contentType: mimeType,
        })

        void metadata
        broadcastUploadResult({ requestId, success: true, url, key })
      } catch (err: any) {
        console.error('[cos:enqueue-upload-from-url] background failed:', err?.message ?? err)
        broadcastUploadResult({
          requestId,
          success: false,
          error: err?.message ?? String(err) ?? 'upload failed',
        })
      }
    })()

    return { queued: true }
  },
)

// Direct URL → COS handler (await-based). Kept for callers that want the
// URL back synchronously (e.g. one-off generate-then-display flows).
ipcMain.handle(
  'cos:upload-image-from-url',
  async (
    _event,
    payload: { sourceUrl: string; mimeType?: string; metadata?: Record<string, unknown> },
  ): Promise<
    | { success: true; url: string; key: string }
    | { success: false; error: string }
  > => {
    try {
      const { sourceUrl, mimeType: hintMime, metadata } = payload
      if (typeof sourceUrl !== 'string' || !sourceUrl) {
        return { success: false, error: 'invalid sourceUrl' }
      }
      if (!/^https?:\/\//i.test(sourceUrl) && !sourceUrl.startsWith('data:')) {
        return { success: false, error: 'sourceUrl must be http(s):// or data:' }
      }

      let body: Buffer
      let mimeType: string
      if (sourceUrl.startsWith('data:')) {
        const m = /^data:([^;,]+);base64,(.+)$/i.exec(sourceUrl)
        if (!m) return { success: false, error: 'invalid data: URL' }
        mimeType = m[1] || hintMime || 'image/png'
        body = Buffer.from(m[2], 'base64')
      } else {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30_000)
        try {
          const resp = await fetch(sourceUrl, { signal: controller.signal })
          if (!resp.ok) {
            return { success: false, error: `fetch ${resp.status}` }
          }
          mimeType = hintMime || resp.headers.get('content-type') || mimeFromUrl(sourceUrl)
          const ab = await resp.arrayBuffer()
          body = Buffer.from(ab)
        } finally {
          clearTimeout(timer)
        }
      }

      if (body.byteLength === 0) {
        return { success: false, error: 'empty body after fetch' }
      }
      if (!mimeType.startsWith('image/')) {
        mimeType = mimeFromUrl(sourceUrl)
      }

      const key = generateImageHistoryKey(mimeType)
      const url = await enqueueUpload({
        bucket: IMAGE_HISTORY_BUCKET,
        region: IMAGE_HISTORY_REGION,
        key,
        body,
        contentType: mimeType,
      })

      void metadata
      return { success: true, url, key }
    } catch (err: any) {
      console.error('[cos:upload-image-from-url] failed:', err)
      return {
        success: false,
        error: err?.message ?? String(err) ?? 'upload failed',
      }
    }
  },
)

// Shell helpers (clipboard / save dialog) — used by the Codex Agent Lightbox.
ipcMain.handle('shell:copy-image', async (_event, uri: string) => {
  try {
    const filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) {
      return { success: false, error: 'unable to load image' }
    }
    clipboard.writeImage(img)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('shell:save-as', async (_event, payload: { uri: string; suggestedName: string }) => {
  try {
    const { uri, suggestedName } = payload
    const filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName || path.basename(filePath),
    })
    if (result.canceled || !result.filePath) {
      return { success: true, canceled: true }
    }
    await fs.promises.copyFile(filePath, result.filePath)
    return { success: true, path: result.filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('shell:show-item-in-folder', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

function validateExternalUrlMain(input: string): { ok: true; url: string } | { ok: false } {
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false }
  }
}

ipcMain.handle('shell:open-external', async (_event, raw: unknown) => {
  if (typeof raw !== 'string') return { success: false, error: 'invalid_url' }
  const validated = validateExternalUrlMain(raw)
  if (!validated.ok) return { success: false, error: 'unsafe_scheme' }
  await shell.openExternal(validated.url)
  return { success: true }
})

// Agent thread CRUD channels (open/rename/delete) are wired by
// `registerAgentIpc` above; no duplicate top-level stubs needed.

// 图片操作
ipcMain.handle('save-image', async (_event, { base64Data, filename }: ImageSaveParams) => {
  try {
    if (typeof base64Data !== 'string') {
      return { success: false, error: 'invalid base64 payload' }
    }
    const oversized = rejectOversizedBase64(base64Data)
    if (oversized) {
      console.warn('[save-image] 拒绝超大 base64:', oversized)
      return { success: false, error: oversized }
    }
    const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const filePath = path.join(imagesDir, filename)
    await fs.promises.writeFile(filePath, buffer)
    return { success: true, path: filePath }
  } catch (error: any) {
    console.error('保存图片失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('read-image', async (_event, filename: string) => {
  try {
    const filePath = path.join(imagesDir, filename)
    const buffer = await fs.promises.readFile(filePath)
    const ext = path.extname(filename).slice(1) || 'png'
    return `data:image/${ext};base64,${buffer.toString('base64')}`
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('读取图片失败:', error)
    }
    return null
  }
})

ipcMain.handle('delete-image', async (_event, filename: string) => {
  try {
    const filePath = path.join(imagesDir, filename)
    await fs.promises.unlink(filePath)
    return { success: true }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('删除图片失败:', error)
    }
    return { success: true }
  }
})

// 历史记录
ipcMain.handle('save-history', async (_event, history: any[]) => {
  try {
    await fs.promises.writeFile(historyFile, JSON.stringify(history, null, 2), 'utf-8')
    return { success: true }
  } catch (error: any) {
    console.error('保存历史记录失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-history', async () => {
  try {
    const data = await fs.promises.readFile(historyFile, 'utf-8')
    return JSON.parse(data)
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('读取历史记录失败:', error)
    }
    return []
  }
})

// 存储信息
ipcMain.handle('get-storage-info', async () => {
  try {
    const files = await fs.promises.readdir(imagesDir)
    let totalSize = 0
    for (const file of files) {
      const filePath = path.join(imagesDir, file)
      const stats = await fs.promises.stat(filePath)
      totalSize += stats.size
    }
    return {
      imageCount: files.length,
      totalSize,
      storagePath: userDataPath
    }
  } catch (error) {
    console.error('获取存储信息失败:', error)
    return { imageCount: 0, totalSize: 0, storagePath: userDataPath }
  }
})

// 文件对话框
ipcMain.handle('select-save-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择保存目录'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0]
  }
  return null
})

ipcMain.handle('export-image', async (_event, { base64Data, targetDir, filename }: ImageExportParams) => {
  try {
    if (typeof base64Data !== 'string') {
      return { success: false, error: 'invalid base64 payload' }
    }
    const oversized = rejectOversizedBase64(base64Data)
    if (oversized) {
      console.warn('[export-image] 拒绝超大 base64:', oversized)
      return { success: false, error: oversized }
    }
    const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const filePath = path.join(targetDir, filename)
    await fs.promises.writeFile(filePath, buffer)
    return { success: true, path: filePath }
  } catch (error: any) {
    console.error('导出图片失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('open-path', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// ==================== 页面状态 IPC ====================

ipcMain.handle('save-page-state', async (_event, pageId: string, state: any) => {
  try {
    getPageStateStore().set(`states.${pageId}`, state)
    return { success: true }
  } catch (error: any) {
    console.error('保存页面状态失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-page-state', async (_event, pageId: string) => {
  try {
    const state = getPageStateStore().get(`states.${pageId}`)
    return state || null
  } catch (error) {
    console.error('加载页面状态失败:', error)
    return null
  }
})

ipcMain.handle('clear-page-state', async (_event, pageId: string) => {
  try {
    getPageStateStore().delete(`states.${pageId}`)
    return { success: true }
  } catch (error: any) {
    console.error('清除页面状态失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('clear-all-page-states', async () => {
  try {
    getPageStateStore().set('states', {})
    return { success: true }
  } catch (error: any) {
    console.error('清除所有页面状态失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('get-saved-page-ids', async () => {
  try {
    const states = getPageStateStore().get('states') || {}
    return Object.keys(states)
  } catch (error) {
    console.error('获取页面列表失败:', error)
    return []
  }
})

// ==================== 缓存清理 IPC ====================

ipcMain.handle('clear-web-cache', async () => {
  try {
    if (!mainWindow) {
      return { success: false, error: '窗口未初始化' }
    }

    const ses = mainWindow.webContents.session
    await ses.clearStorageData({
      storages: ['localstorage', 'indexdb', 'websql', 'cachestorage']
    })
    await ses.clearCache()

    console.log('网页缓存已清理')
    return { success: true }
  } catch (error: any) {
    console.error('清理网页缓存失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('get-cache-size', async () => {
  try {
    if (!mainWindow) {
      return { cacheSize: 0 }
    }

    const ses = mainWindow.webContents.session
    const cacheSize = await ses.getCacheSize()

    return { cacheSize }
  } catch (error) {
    console.error('获取缓存大小失败:', error)
    return { cacheSize: 0 }
  }
})

// ==================== 模板存储 IPC ====================

ipcMain.handle('save-template', async (_event, templateKey: string, templateData: any) => {
  try {
    getTemplateStore().set(`templates.${templateKey}`, templateData)
    return { success: true }
  } catch (error: any) {
    console.error('保存模板失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('save-template-override', async (_event, templateKey: string, templateData: any) => {
  try {
    getTemplateStore().set(`overrides.${templateKey}`, templateData)
    return { success: true }
  } catch (error: any) {
    console.error('保存模板修改失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-custom-templates', async () => {
  try {
    return getTemplateStore().get('templates') || {}
  } catch (error) {
    console.error('加载自定义模板失败:', error)
    return {}
  }
})

ipcMain.handle('load-template-overrides', async () => {
  try {
    return getTemplateStore().get('overrides') || {}
  } catch (error) {
    console.error('加载模板修改失败:', error)
    return {}
  }
})

ipcMain.handle('delete-template', async (_event, templateKey: string) => {
  try {
    getTemplateStore().delete(`templates.${templateKey}`)
    return { success: true }
  } catch (error: any) {
    console.error('删除模板失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('reset-template-override', async (_event, templateKey: string) => {
  try {
    getTemplateStore().delete(`overrides.${templateKey}`)
    return { success: true }
  } catch (error: any) {
    console.error('重置模板失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('export-templates', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出模板',
      defaultPath: 'my-templates.json',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    const exportData = {
      version: '1.0.0',
      exportDate: new Date().toISOString(),
      templates: getTemplateStore().get('templates') || {},
      overrides: getTemplateStore().get('overrides') || {}
    }

    await fs.promises.writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
    return { success: true, path: result.filePath }
  } catch (error: any) {
    console.error('导出模板失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('import-templates', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入模板',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    const data = await fs.promises.readFile(result.filePaths[0], 'utf-8')
    const importData = JSON.parse(data)

    if (!importData.templates && !importData.overrides) {
      return { success: false, error: '无效的模板文件格式' }
    }

    if (importData.templates) {
      const existing = getTemplateStore().get('templates') || {}
      getTemplateStore().set('templates', { ...existing, ...importData.templates })
    }
    if (importData.overrides) {
      const existing = getTemplateStore().get('overrides') || {}
      getTemplateStore().set('overrides', { ...existing, ...importData.overrides })
    }

    return {
      success: true,
      imported: {
        templates: Object.keys(importData.templates || {}).length,
        overrides: Object.keys(importData.overrides || {}).length
      }
    }
  } catch (error: any) {
    console.error('导入模板失败:', error)
    return { success: false, error: error.message }
  }
})

// ==================== 自定义图库 IPC ====================

ipcMain.handle('get-custom-gallery-path', async () => {
  return initCustomGalleryPath()
})

ipcMain.handle('add-custom-gallery-image', async (_event, { id, name, sourcePath }: GalleryImageParams) => {
  try {
    const galleryPath = initCustomGalleryPath()
    const ext = path.extname(sourcePath) || '.png'
    const filename = `${id}${ext}`
    const destPath = path.join(galleryPath, filename)

    fs.copyFileSync(sourcePath, destPath)

    const images: GalleryImageMeta[] = getGalleryStore().get('images') || []
    images.push({
      id,
      name,
      filename,
      createdAt: new Date().toISOString()
    })
    getGalleryStore().set('images', images)

    return { success: true, filename, path: destPath }
  } catch (error: any) {
    console.error('添加图片到图库失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('save-custom-gallery', async (_event, images: any[]) => {
  try {
    const metaImages = images.map(img => ({
      id: img.id,
      name: img.name,
      filename: img.filename || `${img.id}.png`,
      createdAt: img.createdAt
    }))
    getGalleryStore().set('images', metaImages)
    return { success: true }
  } catch (error: any) {
    console.error('保存自定义图库失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-custom-gallery', async () => {
  try {
    const galleryPath = initCustomGalleryPath()
    const images: GalleryImageMeta[] = getGalleryStore().get('images') || []
    return images
      .map(img => ({
        ...img,
        path: path.join(galleryPath, img.filename || `${img.id}.png`),
        url: `file://${path.join(galleryPath, img.filename || `${img.id}.png`).replace(/\\/g, '/')}`
      }))
      .filter(img => {
        const exists = fs.existsSync(img.path)
        if (!exists) {
          console.warn('图片文件不存在:', img.path)
        }
        return exists
      })
  } catch (error) {
    console.error('加载自定义图库失败:', error)
    return []
  }
})

ipcMain.handle('delete-custom-gallery-image', async (_event, imageId: string) => {
  try {
    const galleryPath = initCustomGalleryPath()
    const images: GalleryImageMeta[] = getGalleryStore().get('images') || []
    const imageToDelete = images.find(img => img.id === imageId)

    if (imageToDelete) {
      const filePath = path.join(galleryPath, imageToDelete.filename || `${imageId}.png`)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    const filtered = images.filter(img => img.id !== imageId)
    getGalleryStore().set('images', filtered)
    return { success: true }
  } catch (error: any) {
    console.error('删除自定义图库图片失败:', error)
    return { success: false, error: error.message }
  }
})

// 手动清理缓存（用于解决缓存问题）
ipcMain.handle('clear-app-cache', async () => {
  try {
    if (mainWindow) {
      await mainWindow.webContents.session.clearCache()
      await mainWindow.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage', 'shadercache']
      })
    }
    
    // 删除缓存清理标记，下次启动时会重新清理文件系统缓存
    const markerPath = path.join(app.getPath('userData'), '.cache_cleaned')
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath)
    }
    
    return { success: true, message: '缓存已清理，重启应用生效' }
  } catch (error: any) {
    console.error('清理缓存失败:', error)
    return { success: false, error: error.message }
  }
})

// ==================== 宫格拆图 IPC ====================

ipcMain.handle('storyboard-split:submit', async (_event, payload) => {
  return submitSplit(payload)
})

ipcMain.handle('storyboard-split:cancel', async (_event, { taskId }) => {
  return cancelTask(taskId)
})

ipcMain.handle('storyboard-split:get-config', async () => {
  return getSplitConfig()
})

ipcMain.handle('storyboard-split:set-credentials', async (_event, creds) => {
  return setCredentialsFromUI(creds)
})

ipcMain.handle('storyboard-split:set-defaults', async (_event, config) => {
  return setDefaultsFromUI(config)
})

ipcMain.handle('storyboard-split:delete-remote', async (_event, cosPaths: string[]) => {
  return deleteRemoteObjects(cosPaths)
})

// ==================== 智能去字幕 IPC ====================

// probe-batch IPC removed — probing now in renderer via HTML5 <video>

ipcMain.handle('smart-erase:submit', async (_event, payload) => {
  return submitErase(payload)
})

ipcMain.handle('smart-erase:cancel', async (_event, { taskId }: { taskId: string }) => {
  return cancelEraseTask(taskId)
})

ipcMain.handle('smart-erase:get-config', async () => {
  return getEraseConfig()
})

ipcMain.handle('smart-erase:set-credentials', async (_event, creds) => {
  return setEraseCredentialsFromUI(creds)
})

ipcMain.handle('smart-erase:delete-remote', async (_event, keys: string[]) => {
  return deleteEraseRemoteObjects(keys)
})

ipcMain.handle('smart-erase:download-file', async (_event, { url, suggestedName }: { url: string; suggestedName: string }) => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存去字幕视频',
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [
        { name: '视频文件', extensions: ['mp4'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }

    const res = await net.fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    await fs.promises.writeFile(result.filePath, Buffer.from(buf))
    return { success: true, path: result.filePath }
  } catch (error: any) {
    console.error('[smart-erase] download failed:', error)
    return { success: false, error: error.message }
  }
})
