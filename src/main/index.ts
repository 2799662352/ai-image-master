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
import { runStartupDedupOnce } from './agent/historyDedup'
import { installFirstPartySkills } from './agent/firstPartySkills'
import { registerMarketplaceIpc, registerPluginMarketplaceIpc } from './marketplace/ipc'
import { ThreadStore } from './agent/ThreadStore'
import { uploadBufferToBucket } from './services/tencent/cosClient'
import { saveAudioHistoryFile, readAudioHistoryFile, deleteAudioHistoryFile } from './services/audioHistoryFiles'
import { registerAttachmentsTreeIpc, wireAttachmentBroadcast } from './file-explorer/AttachmentTreeProvider'
import { AttachmentDirWatcher } from './file-explorer/AttachmentDirWatcher'
import { registerFsIpc } from './file-explorer/fsIpc'
import { registerLocalFileScheme, installLocalFileHandler } from './file-explorer/protocolHandler'
import { registerAttachmentsThumbIpc } from './file-explorer/attachmentsIpc'
import { registerMediaThumbIpc } from './file-explorer/mediaThumbIpc'
import { registerVideoPosterIpc } from './file-explorer/videoPosterIpc'
import { registerCanvasCheckpointIpc } from './file-explorer/canvasCheckpointIpc'
import { registerFsWatcherIpc, disposeAll as disposeFsWatchers } from './file-explorer/fsWatcher'
import { startCatimationMcpServer } from './mcp/server'
import type { McpRuntime } from './mcp/server'
import { wireRendererLifecycle } from './mcp/rendererLifecycle'
import { imageTaskManager } from './mcp/tools/imageTaskRegistry'
import { initSeedanceRuntime, registerSeedanceRendererIpc } from './services/seedance/runtime'
import { getCatimationBridgeEntryPath } from './mcp/bridge'
import type { CatimationMcpLaunchInfo } from './agent/codexLaunch'
import { resolveWorkspacePaths } from './agent/codexConfigStore'
import { getApiyiMcpEntryPath, resolveApiyiCommand } from './agent/apiyiMcpLauncher'
import { seedApiyiMcpEntry } from './agent/apiyiMcpSeed'
import { getCinematographyKbMcpEntryPath } from './agent/cinematographyKbMcpLauncher'
import { seedCinematographyKbMcpEntry } from './agent/cinematographyKbMcpSeed'

// 检测开发模式：通过命令行参数或环境变量
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'

// ─── attachments:save-from-url media-type helpers ───────────────────────────
// Some image/video channels return a presigned remote URL (COS/OSS) whose
// extension is hidden behind query-signed params and whose Content-Type may be
// a generic octet-stream. These resolve the real media mime + canonical file
// extension so a downloaded result is content-addressed under a sane name.
const URL_EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
}
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
}

/**
 * Resolve a downloadable media mime, preferring the server's Content-Type and
 * falling back to the URL pathname extension. Returns `null` when the result is
 * neither image/* nor video/* (so the caller can reject non-media downloads).
 */
function resolveMediaMime(headerMime: string, url: string): string | null {
  if (headerMime.startsWith('image/') || headerMime.startsWith('video/')) return headerMime
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    /* keep raw url */
  }
  const ext = pathname.split('.').pop()?.toLowerCase() ?? ''
  return URL_EXT_TO_MIME[ext] ?? null
}

/** Canonical file extension for a known media mime (defaults to `bin`). */
function extensionForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? 'bin'
}

/** Drop a trailing `.ext` from a filename (keeps dotfiles + no-ext names intact). */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

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

// Windows toast prerequisite: the App User Model ID must be set before any
// Notification is shown, and must match electron-builder's `appId` so packaged
// builds attribute toasts to the Start-menu shortcut. Dev builds fall back to
// the exe path (Electron's default identity) — toasts still work there.
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.catimation.cyberpunk-master' : process.execPath)
}

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
          // tldraw loads its IBM Plex / Shantell Sans woff2 fonts from its CDN
          // (https://cdn.tldraw.com/<version>/fonts/*). Without this origin the
          // canvas throws a font-src CSP violation + NetworkError on mount.
          "font-src 'self' https://fonts.gstatic.com https://cdn.tldraw.com data:",
          "img-src 'self' data: blob: https: http://175.178.198.17:* http://43.161.233.87:* file: local-file:",
          // blob: is required for tldraw image export: toImageDataUrl/exportToSvg
          // fetch() the image's blob: object URL to inline it as a data URI. Without
          // it the canvas edit pipeline can't produce a targetImagePath (export throws
          // "Refused to connect"/timeout), so annotations never reach the edit queue.
          "connect-src 'self' https: wss: data: blob: http://43.161.233.87:* http://175.178.198.17:* http://127.0.0.1:* http://localhost:*",
            // allow COS HTTPS presigned URLs (smart erase output), file:// (compare-with-original),
            // and local-file:// for the file-explorer video previewer.
            "media-src 'self' data: blob: https: http://175.178.198.17:* http://43.161.233.87:* file: local-file:",
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

  // ───────────────────────────────────────────────────────────────
  // P0 黑屏自愈 (2026-06-23)
  //
  // 渲染进程一旦 OOM/崩溃, 此前没有任何处理 → 窗口永久黑屏, 也没有任何日志。
  // 按 Electron 官方建议监听 render-process-gone: ① 记录 reason/exitCode
  // (便于线上确认是否 OOM); ② 对崩溃类原因自动 reload 到全新进程恢复。
  //
  // 主因(会话内 4K 模型 base64 常驻渲染进程)已在渲染层修复(上传成功后
  // 释放 base64, 见 useGenerateStore / useBatchStore)。这里是兜底安全网:
  // 即便出现别的 OOM 来源、或用户未配置 COS 导致 base64 未及时释放, 也不会
  // 停在黑屏。clean-exit / killed 是正常关闭或我们主动 kill, 不处理。
  //
  // 防 reload 风暴: 60s 内崩溃 >= CRASH_MAX_RELOADS 次就停手并弹窗交给用户,
  // 避免"崩溃→reload→立刻又崩"的死循环空烧 CPU。
  const RELOAD_WORTHY_CRASH_REASONS = new Set<string>([
    'crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure',
  ])
  const CRASH_WINDOW_MS = 60_000
  const CRASH_MAX_RELOADS = 3
  let recentRendererCrashes: number[] = []

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const { reason, exitCode } = details
    console.error(`[Renderer] render-process-gone reason=${reason} exitCode=${exitCode}`)
    if (!RELOAD_WORTHY_CRASH_REASONS.has(reason)) return
    if (isQuittingAfterAgentCleanup || AutoUpdater.isInstallingUpdate) return
    const win = mainWindow
    if (!win || win.isDestroyed()) return

    const now = Date.now()
    recentRendererCrashes = recentRendererCrashes.filter((t) => now - t < CRASH_WINDOW_MS)
    recentRendererCrashes.push(now)

    if (recentRendererCrashes.length > CRASH_MAX_RELOADS) {
      void dialog
        .showMessageBox(win, {
          type: 'error',
          title: '界面进程反复崩溃',
          message: '检测到界面进程在短时间内多次崩溃(通常是内存不足导致)。',
          detail: `最近一次原因: ${reason} (exitCode ${exitCode})。\n建议: 降低出图分辨率 / 减少单次批量数量, 或重启应用。`,
          buttons: ['立即重载', '稍后'],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
            recentRendererCrashes = []
            mainWindow.webContents.reload()
          }
        })
        .catch(() => {
          /* best-effort, 弹窗失败不致命 */
        })
      return
    }

    console.warn('[Renderer] auto-reloading window after crash to recover from black screen')
    try {
      win.webContents.reload()
    } catch {
      /* noop */
    }
  })

  // unresponsive: 仅记录, 不主动 forcefullyCrashRenderer。本应用大图解码 /
  // 大批量渲染可能让主线程短时无响应但并未崩溃, 主动 kill 会丢失内存里的
  // 结果与队列。真正的崩溃由上面的 render-process-gone 自愈兜底。
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Renderer] unresponsive (not killing; will self-recover, or crash→auto-reload)')
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
            } else if (url.startsWith('blob:')) {
              // blob: URL 只存在于渲染进程上下文 —— net.fetch（主进程）读不到它。
              // 批量/预览页把模型直出的 dataURL 经 useDisplaySrc 换成了 blob:，
              // 所以这里必须回渲染进程 fetch 出字节、转成 dataURL 再落盘，
              // 否则「图片另存为」会静默失败（用户感知为「另存为没反应」）。
              const dataUrl = await mainWindow!.webContents.executeJavaScript(
                `(async () => {` +
                `try {` +
                `const r = await fetch(${JSON.stringify(url)});` +
                `const b = await r.blob();` +
                `return await new Promise((res, rej) => {` +
                `const fr = new FileReader();` +
                `fr.onload = () => res(fr.result);` +
                `fr.onerror = () => rej(fr.error);` +
                `fr.readAsDataURL(b);` +
                `});` +
                `} catch (e) { return null; }` +
                `})()`,
                true,
              )
              if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
                throw new Error('无法从渲染进程读取 blob 图片字节')
              }
              const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '')
              await fs.promises.writeFile(result.filePath, Buffer.from(base64Data, 'base64'))
            } else {
              const res = await net.fetch(url)
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const arrayBuf = await res.arrayBuffer()
              await fs.promises.writeFile(result.filePath, Buffer.from(arrayBuf))
            }
          } catch (error) {
            console.error('[context-menu] 保存图片失败:', error)
            // 不再静默：弹个错误框，避免「另存为点了没反应」的体验。
            try {
              dialog.showErrorBox(
                '图片另存为失败',
                error instanceof Error ? error.message : String(error),
              )
            } catch {
              // showErrorBox 本身失败就只能吞掉了
            }
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
  // 渲染进程重载/崩溃 ⇒ 挂起中的图片任务与渲染层工具调用立即清账,
  // 不再等 30 分钟超时(幂等,重复接线安全)。router 惰性取:MCP 监听
  // 可能尚未起来或绑定失败,均降级为只清图片任务。
  wireRendererLifecycle(win.webContents, {
    failAllRunningImageTasks: (error) => imageTaskManager.failAllRunning(error),
    getRouter: () => agentMcpRuntime?.router ?? null,
  })

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

    // One-time cleanup of duplicated assistant paragraphs (stream-retry
    // artifacts AND the cumulative-snapshot gateway pattern fixed in
    // v4.3.31, see historyDedup.ts / dropSupersededStreamItems). Awaited so
    // threads are already clean by the time the renderer can open them; its
    // own try/catch keeps a cleanup failure from blocking agent startup —
    // the marker is only written on success, so the next launch retries.
    // v2: re-runs once for installs that already completed the v1 pass,
    // catching rows written between v1 and the live snapshot-dedup fix,
    // plus the new empty-reasoning collapse.
    try {
      const markerPath = path.join(app.getPath('userData'), 'agent-retry-dedup-v2.done')
      const stats = await runStartupDedupOnce({ prisma, markerPath })
      if (stats && stats.cleaned > 0) {
        console.log(
          `[historyDedup] cleaned ${stats.cleaned}/${stats.scanned} assistant messages, removed ${stats.itemsRemoved} duplicated items`,
        )
      }
    } catch (err) {
      console.warn('[historyDedup] startup cleanup failed (will retry next launch):', err)
    }

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

    // `attachments:save` — lets the renderer persist an image it produced
    // (codex `generate_image` results) into the watched uploads dir so it shows
    // up in the ATTACHMENTS file panel. Reuses AttachmentService so the file is
    // content-addressed, size-capped, and broadcasts `attachments:changed`.
    // Narrow surface: image mimes only, bytes the renderer already holds.
    ipcMain.removeHandler('attachments:save')
    ipcMain.handle(
      'attachments:save',
      async (
        _event,
        args: { threadId?: unknown; name?: unknown; mime?: unknown; base64?: unknown },
      ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
        const threadId = typeof args?.threadId === 'string' ? args.threadId : ''
        const name = typeof args?.name === 'string' ? args.name : ''
        const mime = typeof args?.mime === 'string' ? args.mime : ''
        const base64 = typeof args?.base64 === 'string' ? args.base64 : ''
        if (!threadId || !name || !mime || !base64) {
          return { ok: false, reason: 'attachments:save requires threadId, name, mime, base64' }
        }
        if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
          return { ok: false, reason: 'attachments:save only accepts image/* or video/* mimes' }
        }
        let buffer: Buffer
        try {
          buffer = Buffer.from(base64, 'base64')
        } catch {
          return { ok: false, reason: 'attachments:save received invalid base64' }
        }
        if (buffer.byteLength === 0) {
          return { ok: false, reason: 'attachments:save received empty image' }
        }
        try {
          const [saved] = await attachmentService.ingest(threadId, [
            {
              name,
              mime,
              size: buffer.byteLength,
              buffer: buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength,
              ) as ArrayBuffer,
            },
          ])
          if (!saved) return { ok: false, reason: 'attachments:save: ingest produced no file' }
          return { ok: true, path: saved.localPath }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    // `attachments:save-from-url` — the URL twin of `attachments:save`. Some
    // image/video channels return a remote result URL (presigned COS/OSS) rather
    // than inline base64; the renderer cannot `fetch()` those (no
    // Access-Control-Allow-Origin → CORS block, the `net::ERR_FAILED 200` in the
    // logs). We download here in MAIN (Node fetch isn't bound by browser CORS),
    // detect the real mime from Content-Type, then reuse the same content-addressed
    // AttachmentService ingest + `attachments:changed` broadcast.
    ipcMain.removeHandler('attachments:save-from-url')
    ipcMain.handle(
      'attachments:save-from-url',
      async (
        _event,
        args: { threadId?: unknown; name?: unknown; url?: unknown },
      ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
        const threadId = typeof args?.threadId === 'string' ? args.threadId : ''
        const name = typeof args?.name === 'string' ? args.name : ''
        const url = typeof args?.url === 'string' ? args.url : ''
        if (!threadId || !name || !url) {
          return { ok: false, reason: 'attachments:save-from-url requires threadId, name, url' }
        }
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, reason: 'attachments:save-from-url only accepts http(s) URLs' }
        }
        if (typeof net?.fetch !== 'function') {
          return { ok: false, reason: 'attachments:save-from-url: net.fetch unavailable in main' }
        }
        const MAX_BYTES = 100 * 1024 * 1024
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
          // Use Electron `net.fetch` (Chrome's network stack) — NOT Node's global
          // `fetch` (undici). Node's stack ignores the app/system proxy and uses
          // stricter standalone TLS, so presigned COS/OSS hosts that the renderer
          // reaches fine (Chromium stack → the `200 OK` in the CORS log) throw a
          // bare "fetch failed" under undici. `net.fetch` issues from the default
          // session (proxy + system certs) and is not bound by CORS in main.
          // Ref: electron/electron docs/api/net.md (net.fetch vs Node fetch).
          const res = await net.fetch(url, { signal: controller.signal })
          if (!res.ok) {
            return { ok: false, reason: `attachments:save-from-url: download failed (HTTP ${res.status})` }
          }
          const declared = Number(res.headers.get('content-length') ?? '')
          if (Number.isFinite(declared) && declared > MAX_BYTES) {
            return { ok: false, reason: 'attachments:save-from-url: remote file too large' }
          }
          const arrayBuffer = await res.arrayBuffer()
          if (arrayBuffer.byteLength === 0) {
            return { ok: false, reason: 'attachments:save-from-url: downloaded empty file' }
          }
          if (arrayBuffer.byteLength > MAX_BYTES) {
            return { ok: false, reason: 'attachments:save-from-url: remote file too large' }
          }
          const headerMime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
          const mime = resolveMediaMime(headerMime, url)
          if (!mime) {
            return {
              ok: false,
              reason: `attachments:save-from-url: not an image/video (content-type: ${headerMime || 'unknown'})`,
            }
          }
          // Force the filename extension to match the detected mime — the renderer
          // can only guess (URLs hide the real type behind query-signed params).
          const finalName = `${stripExtension(name)}.${extensionForMime(mime)}`
          const [saved] = await attachmentService.ingest(threadId, [
            { name: finalName, mime, size: arrayBuffer.byteLength, buffer: arrayBuffer },
          ])
          if (!saved) return { ok: false, reason: 'attachments:save-from-url: ingest produced no file' }
          return { ok: true, path: saved.localPath }
        } catch (error) {
          // Surface `error.cause` — undici/net wrap the real network failure
          // (ENOTFOUND / TLS / ECONNRESET / proxy) under a bare "fetch failed",
          // and dropping the cause is what made the previous failure undiagnosable.
          const base = error instanceof Error ? error.message : String(error)
          const cause =
            error instanceof Error && error.cause
              ? ` (cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)})`
              : ''
          return { ok: false, reason: `attachments:save-from-url: ${base}${cause}` }
        } finally {
          clearTimeout(timer)
        }
      },
    )

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
    } else {
      // Seedance 视频生成：注册 generate_video / check_video_task 的主进程
      // handler + 任务状态机 + 设置页 IPC。状态全在 TaskManager 单例，
      // server-per-connection 的 MCP 工厂随便建几个实例都安全。
      initSeedanceRuntime({
        router: agentMcpRuntime.router,
        attachments: attachmentService,
        getWindow: () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null,
      })
    }
    // Prefer the stdio bridge transport for the spawned codex: codex runs
    // resources/catimation-bridge/index.js as a plain stdio MCP server and
    // the bridge pipes bytes to our loopback TCP listener. This takes codex's
    // rmcp streamable-HTTP client (whose keep-alive/session failure modes
    // wedged long generate_image turns) off the critical path. Falls back to
    // the HTTP url entry when the bridge listener or script is unavailable.
    let catimationMcpLaunch: CatimationMcpLaunchInfo | undefined
    if (agentMcpRuntime) {
      catimationMcpLaunch = { port: agentMcpRuntime.port, token: agentMcpRuntime.token }
      if (agentMcpRuntime.bridge) {
        const bridgeEntry = getCatimationBridgeEntryPath({
          appPath: app.getAppPath(),
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        })
        if (fs.existsSync(bridgeEntry)) {
          // Same node-vs-Electron-as-Node resolution the apiyi stdio server
          // already uses (system `node` when on PATH, otherwise our own
          // binary with ELECTRON_RUN_AS_NODE=1).
          const resolved = await resolveApiyiCommand(process.execPath)
          catimationMcpLaunch.stdio = {
            command: resolved.command,
            args: [bridgeEntry],
            env: {
              ...resolved.extraEnv,
              CATIMATION_BRIDGE_PORT: String(agentMcpRuntime.bridge.port),
              CATIMATION_BRIDGE_TOKEN: agentMcpRuntime.bridge.token,
            },
          }
          console.log('[AgentRuntime] catimation MCP: stdio bridge enabled (port', agentMcpRuntime.bridge.port, ')')
        } else {
          console.warn('[AgentRuntime] catimation bridge script missing at', bridgeEntry, '— falling back to HTTP transport')
        }
      } else {
        console.warn('[AgentRuntime] catimation bridge listener unavailable — falling back to HTTP transport')
      }
    }
    agentManager = new AgentManager({
      userDataDir: app.getPath('userData'),
      win,
      store: threadStore,
      attachments: attachmentService,
      // Hand the spawned Codex subprocess the local MCP server coordinates
      // (stdio bridge preferred, HTTP fallback) so it can actually call our
      // `generate_image` tool. Undefined when the listener failed to bind
      // (agent still works, sans tools).
      mcpRuntime: catimationMcpLaunch,
    })
    // Let the MCP ToolRouter reverse-map Codex thread UUIDs (carried in each
    // tool call's `_meta`) to our DB thread ids, so renderer tools like
    // `generate_image` route their UI to the chat that requested them instead
    // of whatever chat is active when the render finishes.
    agentMcpRuntime?.router.setThreadIdResolver((codexThreadId) =>
      agentManager?.resolveDbThreadId(codexThreadId),
    )

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
  // media:ensure-video-poster — generate-once + persist a video still as a
  // static COS object so chat never re-runs the billable 数据万象 snapshot.
  registerVideoPosterIpc()
  // canvas:{save,read,list}-checkpoint — restorable tldraw snapshot JSON on disk
  // (gap-analysis §8/§9). Separate from attachments (image/video only).
  registerCanvasCheckpointIpc(path.join(app.getPath('userData'), 'agent', 'canvas-checkpoints'))
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

  // 同理:人像库的渲染端 IPC(配置/素材/叠加层)只依赖凭证与本地叠加层模块,
  // 与 MCP router 无关 —— 必须在窗口加载前注册。否则人像库页面挂载时的
  // getConfig()/listAssets() 会与延迟、未 await 的 initSeedanceRuntime()
  // (它要等 await startCatimationMcpServer 之后才注册这些 handler)竞态,被
  // "No handler registered" reject,页面随即钉死在「人像库未就绪」,只能整页
  // 刷新才恢复。提前注册即可让人像库启动即自动连接。
  registerSeedanceRendererIpc(
    () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null,
  )

  // 关键路径：创建窗口
  createWindow()

  if (mainWindow) setSplitMainWindow(mainWindow)
  if (mainWindow) setEraseMainWindow(mainWindow)
  if (mainWindow) {
    void initAgentRuntime(mainWindow).catch((error) => {
      console.error('[AgentRuntime] init failed:', error)
    })
  }

  // First-boot seed: ensure mcp_servers.apiyi exists (disabled) in the
  // user's personal codex config. Cheap (~5-50ms), idempotent, best-effort.
  try {
    const apiyiPaths = resolveWorkspacePaths({
      home: app.getPath('home'),
      cwd: process.cwd(),
      userData: app.getPath('userData'),
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    })
    const apiyiEntry = getApiyiMcpEntryPath({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    })
    // -------------------------------------------------------------------
    // v4.3.18: previously this site passed `nodeBin: process.execPath`,
    // but SeedApiyiMcpInput was refactored in v4.3.16 to take
    // `command` + `extraEnv?` — `nodeBin` is now silently ignored and
    // `input.command` resolves to `undefined`. @iarna/toml.stringify
    // skips undefined fields, so freshly-seeded toml entries had NO
    // `command = "..."` line at all. codex 0.132's deserializer then
    // sees `command = None && url = None` and aborts the entire config
    // load with bare `"invalid transport"` (codex-rs/core/src/config/
    // types.rs:124-155), wedging the MCP page for any user whose first
    // boot landed on v4.3.16+.
    //
    // Fix: pick the right binary via `resolveApiyiCommand` (system
    // `node` if on PATH, else Electron-as-Node with ELECTRON_RUN_AS_NODE
    // in extraEnv) and forward both fields with their correct names.
    // -------------------------------------------------------------------
    const apiyiCmd = await resolveApiyiCommand(process.execPath)
    // FORCE convergence: the apiyi entry is app-managed — every boot rewrites
    // it to the canonical form (fresh command/args, env scaffold, enabled=true)
    // regardless of user edits. See seedApiyiMcpEntry for the rationale.
    const apiyiAction = await seedApiyiMcpEntry({
      personalConfigToml: apiyiPaths.personalConfigToml,
      entryPath: apiyiEntry,
      command: apiyiCmd.command,
      extraEnv: apiyiCmd.extraEnv,
    })
    console.log(`[apiyi-mcp] boot convergence: ${apiyiAction} (command=${apiyiCmd.command})`)
  } catch (err) {
    console.warn('[apiyi-mcp] seed failed:', err)
  }

  // First-boot seed: ensure the first-party cinematography knowledge-base MCP
  // (mcp_servers.cinematography_kb) exists in the user's personal codex config.
  // Shares the maintainer's Bailian KB + key, so it works with zero setup.
  // Cheap, idempotent, best-effort. Reuses the same node-vs-Electron command
  // resolution as apiyi/catimation stdio servers.
  try {
    const kbPaths = resolveWorkspacePaths({
      home: app.getPath('home'),
      cwd: process.cwd(),
      userData: app.getPath('userData'),
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    })
    const kbEntry = getCinematographyKbMcpEntryPath({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    })
    const kbCmd = await resolveApiyiCommand(process.execPath)
    const kbAction = await seedCinematographyKbMcpEntry({
      personalConfigToml: kbPaths.personalConfigToml,
      entryPath: kbEntry,
      command: kbCmd.command,
      extraEnv: kbCmd.extraEnv,
    })
    console.log(`[cinematography-kb-mcp] boot convergence: ${kbAction} (command=${kbCmd.command})`)
  } catch (err) {
    console.warn('[cinematography-kb-mcp] seed failed:', err)
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

// First-party "system" skill install. Codex's own `.system` skills are
// binary-embedded and wiped per binary version, so the app-controlled
// equivalent is a skill we always ship into the Codex USER scope
// (`officialUserSkillsDir`) that Codex natively discovers and the skills panel
// lists. Currently this ships `catimation-image`, which steers the agent to our
// in-chat + history-persisting `generate_image` MCP tool (we also disable the
// competing built-in `imagegen` skill at codex launch). Idempotent and
// non-destructive: user edits to the SKILL.md are preserved.
const firstPartySkillsPromise: Promise<void> = legacySkillsMigrationPromise
  .then(() => installFirstPartySkills({ officialRoot: officialUserSkillsDir }))
  .then((report) => {
    const touched = [...report.installed, ...report.updated]
    if (touched.length > 0) {
      console.info(
        `[skills] first-party skill(s) ${report.installed.length ? `installed: ${report.installed.join(', ')}` : ''}${
          report.installed.length && report.updated.length ? '; ' : ''
        }${report.updated.length ? `updated: ${report.updated.join(', ')}` : ''} → ${officialUserSkillsDir}`,
      )
    }
  })
  .catch((err) => {
    console.warn('[skills] first-party skill install failed (non-fatal):', err)
  })

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

// Plugin Marketplace wiring. A plugin is a one-click bundle of skills; install
// extracts its bundled skills into the same `officialUserSkillsDir` so existing
// skill discovery picks them up. Ledger persists separately so plugin and
// per-skill installs don't clobber each other's state.
const pluginMarketplaceStateFile = path.join(app.getPath('userData'), 'plugin-marketplace-state.json')
registerPluginMarketplaceIpc({
  userSkillsDir: officialUserSkillsDir,
  stateFile: pluginMarketplaceStateFile,
  // Lets plugin uninstall avoid deleting a skill the per-skill marketplace
  // independently owns (review finding I2).
  skillStateFile: marketplaceStateFile,
})

// One-shot adoption pass. v4.3.4 users have ~20 bundled skills already on
// disk (we used to mirror them every launch); marking them as `adopted`
// lets the marketplace UI show them under "Installed" so users can
// uninstall/replace selectively. Failure is non-fatal — the UI's first
// `adopt-existing` IPC call will just retry.
// Chained after the first-party install so `catimation-image` is on disk and
// gets adopted into marketplace state in the same pass (shows under "Installed").
firstPartySkillsPromise
  .then(() => marketplaceService.adoptExisting())
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
    // Also wait for the first-party `catimation-image` install so it appears in
    // the panel on the first load after upgrade.
    await legacySkillsMigrationPromise
    await firstPartySkillsPromise
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

/**
 * 占一个上传并发槽位, 返回释放函数。
 *
 * 单独抽出来(而不只在 enqueueUpload 里内联)是为了让 fire-and-forget
 * 通道能把 **fetch/base64 解码也圈进闸门**: 修复前 N 个入队请求会先各自
 * 分配 Buffer 再排队等槽位, N 份 30MB+ buffer 同时驻留主进程 → OOM 闪退。
 */
async function acquireUploadSlot(): Promise<() => void> {
  while (inflightUploads.size >= MAX_CONCURRENT_UPLOADS_MAIN) {
    await Promise.race(inflightUploads)
  }
  let resolveSlot!: () => void
  const slot = new Promise<void>((r) => {
    resolveSlot = r
  })
  inflightUploads.add(slot)
  return () => {
    inflightUploads.delete(slot)
    resolveSlot()
  }
}

async function enqueueUpload(
  opts: Parameters<typeof uploadBufferToBucket>[0],
): Promise<string> {
  const release = await acquireUploadSlot()
  try {
    return await uploadBufferToBucket(opts)
  } finally {
    release()
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
    | { requestId: string; success: true; url: string; key: string; localPath?: string }
    | { requestId: string; success: false; error: string; localPath?: string },
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('cos:upload-result', result)
    }
  }
}

/**
 * 生成图先落本地盘 (2026-07-09, 参照 codex 页 MCP 出图的 saveToFilePanel):
 * 上传通道拿到字节后, 先写一份到 userData/generated-images, 再推 COS。
 * 本地文件是"永不丢图"的兜底 —— COS 失败/断网时渲染端可切
 * local-file:// 显示并把本地路径写进 history(跨重启仍可用);
 * 模型直出的临时签名 URL 几小时就 404, 之前失败即等于丢图。
 * 写盘失败(磁盘满等)不阻塞上传, 返回 null 即可。
 */
async function saveGeneratedImageLocally(
  requestId: string,
  body: Buffer,
  mimeType: string,
): Promise<string | undefined> {
  try {
    const safeId = requestId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64)
    const filename = `${Date.now()}-${safeId}-${randomBytes(4).toString('hex')}.${mimeTypeToExtension(mimeType)}`
    const filePath = path.join(imagesDir, filename)
    await fs.promises.writeFile(filePath, body)
    return filePath
  } catch (err: any) {
    console.warn('[cos-upload] 本地落盘失败(不影响上传):', err?.message ?? err)
    return undefined
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

    // 大 base64 在 IPC 入口直接拒绝 (P0 加固): 修复后正常路径走
    // cos:enqueue-upload-bytes, 还在传超大 data: 字符串的一定是异常调用方。
    if (sourceUrl.startsWith('data:')) {
      const oversized = rejectOversizedBase64(sourceUrl)
      if (oversized) return { queued: false, error: oversized }
    }

    // Don't await — kick off background work and return synchronously.
    void (async () => {
      // P0 闪退修复: 先占并发槽位再 fetch/解码。修复前 N 个入队各自先
      // 分配 30MB+ Buffer 再排队, N 份同时驻留主进程堆 → OOM。
      const release = await acquireUploadSlot()
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

        // 先落本地盘再推 COS —— 临时签名的模型直出 URL 几小时就过期,
        // 这份本地副本保证"生成过的图永远找得回来"。
        const localPath = await saveGeneratedImageLocally(requestId, body, mimeType)

        try {
          const key = generateImageHistoryKey(mimeType)
          const url = await uploadBufferToBucket({
            bucket: IMAGE_HISTORY_BUCKET,
            region: IMAGE_HISTORY_REGION,
            key,
            body,
            contentType: mimeType,
          })
          void metadata
          broadcastUploadResult({ requestId, success: true, url, key, localPath })
        } catch (uploadErr: any) {
          console.error('[cos:enqueue-upload-from-url] upload failed:', uploadErr?.message ?? uploadErr)
          broadcastUploadResult({
            requestId,
            success: false,
            error: uploadErr?.message ?? String(uploadErr) ?? 'upload failed',
            localPath,
          })
        }
      } catch (err: any) {
        console.error('[cos:enqueue-upload-from-url] background failed:', err?.message ?? err)
        broadcastUploadResult({
          requestId,
          success: false,
          error: err?.message ?? String(err) ?? 'upload failed',
        })
      } finally {
        release()
      }
    })()

    return { queued: true }
  },
)

/**
 * 字节版 fire-and-forget 入队 (P0 闪退修复, 2026-07-09)。
 *
 * 渲染端把模型直出 base64 就地转成 Blob 后, 经此通道传 ArrayBuffer:
 *   - 结构化克隆按原始字节拷贝, 比 base64 字符串体积小 25%;
 *   - 到达后 Buffer.from(ArrayBuffer) 是零拷贝视图, 不进 V8 字符串堆;
 *   - 主进程从头到尾不再持有任何 40MB 级字符串。
 * 结果同样通过 'cos:upload-result' 广播回渲染端。
 */
const MAX_IPC_UPLOAD_BYTES = 64 * 1024 * 1024 // 64MB binary, 4K PNG 极限 ~30MB 留足余量

ipcMain.handle(
  'cos:enqueue-upload-bytes',
  async (
    _event,
    payload: {
      requestId: string
      bytes: ArrayBuffer | Uint8Array
      mimeType?: string
      metadata?: Record<string, unknown>
    },
  ): Promise<{ queued: true } | { queued: false; error: string }> => {
    const { requestId, bytes, mimeType: hintMime, metadata } = payload || ({} as any)
    if (typeof requestId !== 'string' || !requestId) {
      return { queued: false, error: 'invalid requestId' }
    }
    // SCA 会把 ArrayBuffer 原样送达; Buffer/TypedArray 到达为 Uint8Array。两者都接。
    let body: Buffer
    if (bytes instanceof ArrayBuffer) {
      body = Buffer.from(bytes)
    } else if (ArrayBuffer.isView(bytes)) {
      body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } else {
      return { queued: false, error: 'invalid bytes payload' }
    }
    if (body.byteLength === 0) {
      return { queued: false, error: 'empty bytes payload' }
    }
    if (body.byteLength > MAX_IPC_UPLOAD_BYTES) {
      const mb = (body.byteLength / 1024 / 1024).toFixed(1)
      return {
        queued: false,
        error: `bytes payload too large: ${mb}MB (limit ${MAX_IPC_UPLOAD_BYTES / 1024 / 1024}MB)`,
      }
    }
    const mimeType =
      typeof hintMime === 'string' && hintMime.startsWith('image/') ? hintMime : 'image/png'

    void (async () => {
      const release = await acquireUploadSlot()
      // 先落本地盘 (参照 codex 页): 本地副本永不过期, 是 COS 失败时的
      // 持久兜底, 也让用户能在 userData/generated-images 里直接找到原图。
      const localPath = await saveGeneratedImageLocally(requestId, body, mimeType)
      try {
        const key = generateImageHistoryKey(mimeType)
        const url = await uploadBufferToBucket({
          bucket: IMAGE_HISTORY_BUCKET,
          region: IMAGE_HISTORY_REGION,
          key,
          body,
          contentType: mimeType,
        })
        void metadata
        broadcastUploadResult({ requestId, success: true, url, key, localPath })
      } catch (err: any) {
        console.error('[cos:enqueue-upload-bytes] background failed:', err?.message ?? err)
        broadcastUploadResult({
          requestId,
          success: false,
          error: err?.message ?? String(err) ?? 'upload failed',
          localPath,
        })
      } finally {
        release()
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

// ==================== 音频作品库本地文件 (AudioPage) ====================
// 音频字节落 userData/audio-history/,IndexedDB 只存元数据(方案 A)。
// read/delete 在 service 层做目录包含校验,渲染进程碰不到目录外文件。

ipcMain.handle('audio-history:save', async (_event, payload: { base64: string; format: string }) =>
  saveAudioHistoryFile(app.getPath('userData'), payload?.base64, payload?.format ?? 'mp3'))

ipcMain.handle('audio-history:read', async (_event, filePath: string) =>
  readAudioHistoryFile(app.getPath('userData'), filePath))

ipcMain.handle('audio-history:delete', async (_event, filePath: string) =>
  deleteAudioHistoryFile(app.getPath('userData'), filePath))

/**
 * 音频作品的 COS key。**必须放在 `image-history/` 前缀下** —— STS 临时凭证
 * (serverless/sts-cos)只授权 `image-history/*` 的 PutObject,放别的前缀会 403;
 * 用 `image-history/audio/` 子路径既复用现有授权(零 SCF 改动),又和图片资产分开。
 */
function generateAudioHistoryKey(format: string): string {
  const ext = audioExtensionForCos(format)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const id = randomBytes(8).toString('hex')
  return `image-history/audio/${yyyy}/${mm}/${dd}/${id}.${ext}`
}

function audioExtensionForCos(format: string): string {
  const f = (format || '').toLowerCase()
  if (f.includes('opus') || f.includes('ogg')) return 'ogg'
  if (f.includes('wav')) return 'wav'
  if (f.includes('pcm')) return 'pcm'
  return 'mp3'
}

function audioContentType(format: string): string {
  switch (audioExtensionForCos(format)) {
    case 'ogg': return 'audio/ogg'
    case 'wav': return 'audio/wav'
    case 'pcm': return 'audio/pcm'
    default: return 'audio/mpeg'
  }
}

// 音频上传 COS(方案 B):复用图片历史 bucket + STS,上传成功回权威 https URL。
// 与图片历史一致:走 enqueueUpload 占并发槽,base64 大小闸门复用 rejectOversizedBase64。
ipcMain.handle(
  'audio-history:upload-cos',
  async (
    _event,
    payload: { base64: string; format: string },
  ): Promise<
    | { success: true; url: string; key: string }
    | { success: false; error: string }
  > => {
    try {
      const { base64, format } = payload || ({} as { base64: string; format: string })
      if (typeof base64 !== 'string' || !base64) {
        return { success: false, error: 'invalid base64 payload' }
      }
      const oversized = rejectOversizedBase64(base64)
      if (oversized) return { success: false, error: oversized }
      const body = Buffer.from(base64, 'base64')
      if (body.length === 0) return { success: false, error: 'empty buffer after base64 decode' }

      const key = generateAudioHistoryKey(format)
      const url = await enqueueUpload({
        bucket: IMAGE_HISTORY_BUCKET,
        region: IMAGE_HISTORY_REGION,
        key,
        body,
        contentType: audioContentType(format),
      })
      return { success: true, url, key }
    } catch (err: any) {
      console.error('[audio-history:upload-cos] failed:', err)
      return { success: false, error: err?.message ?? String(err) ?? 'upload failed' }
    }
  },
)

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

// ==================== 历史记录 (P0 丢失修复, 2026-07-09) ====================
//
// 修复前的三个丢失/闪退根因:
//   ① 非原子写: writeFile 途中崩溃(常因同时刻的 base64 OOM) → history.json
//      截断 → 下次启动 JSON.parse 抛错 → 返回 [] → 记录"全丢"。
//   ② 并发写: 多张图同时完成会并发触发全量保存, 两个 writeFile 交错写同一
//      文件 → 内容交叉损坏。
//   ③ 巨型 payload: 上传失败兜底/参考图把 40MB 级 base64 写进 item,
//      JSON.stringify(整个数组) 直接把主进程堆打爆。
// 对策: 写盘串行化 + tmp→rename 原子替换 + 上一份好文件滚动为 .bak +
// 落盘前剥离一切超大 data: 字符串(防御性, 渲染层同样已修)。

/** 单个字符串字段落盘上限。缩图后的参考图 ~100KB, 1MB 已留足余量。 */
const MAX_HISTORY_STRING_CHARS = 1 * 1024 * 1024

function sanitizeHistoryValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_HISTORY_STRING_CHARS && value.startsWith('data:')
      ? '[base64-removed]'
      : value
  }
  if (Array.isArray(value)) return value.map(sanitizeHistoryValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeHistoryValue(v)
    }
    return out
  }
  return value
}

let historyWriteChain: Promise<void> = Promise.resolve()

async function writeHistoryAtomic(history: unknown[]): Promise<void> {
  const sanitized = sanitizeHistoryValue(history)
  // 紧凑序列化: pretty-print 会让文件体积翻倍, 对 MB 级数组纯浪费。
  const json = JSON.stringify(sanitized)
  const tmpFile = `${historyFile}.tmp`
  const bakFile = `${historyFile}.bak`
  await fs.promises.writeFile(tmpFile, json, 'utf-8')
  // 旧的好文件先滚动成 .bak(rename 原子), 再把 tmp 转正。任一步之间崩溃,
  // load-history 都能从 file 或 .bak 恢复出一份完整 JSON。
  try {
    await fs.promises.rename(historyFile, bakFile)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }
  await fs.promises.rename(tmpFile, historyFile)
}

ipcMain.handle('save-history', async (_event, history: any[]) => {
  // 串行化: 并发 save 依次排队, 后写覆盖先写(全量快照语义), 永不交错。
  const run = historyWriteChain.then(() => writeHistoryAtomic(history))
  historyWriteChain = run.catch(() => {})
  try {
    await run
    return { success: true }
  } catch (error: any) {
    console.error('保存历史记录失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-history', async () => {
  // 主文件损坏(上个会话崩在写盘途中)时回退 .bak, 最多丢一次保存的增量,
  // 而不是像修复前那样整库清零。
  for (const file of [historyFile, `${historyFile}.bak`]) {
    try {
      const data = await fs.promises.readFile(file, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) {
        if (file !== historyFile) {
          console.warn('[load-history] history.json 损坏, 已从 .bak 恢复')
        }
        return parsed
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`读取历史记录失败 (${path.basename(file)}):`, error.message)
      }
    }
  }
  return []
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
