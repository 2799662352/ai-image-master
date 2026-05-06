// src/main/index.ts - Electron 主进程 (TypeScript)
import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, net, clipboard } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getAutoUpdaterInstance } from './updater'
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
import { AgentManager } from './agent/AgentManager'
import { getPrisma, shutdownDatabase } from './agent/db'
import { registerAgentIpc } from './agent/ipc'
import { ThreadStore } from './agent/ThreadStore'
import { startCatimationMcpServer } from './mcp/server'
import type { McpRuntime } from './mcp/server'

// 检测开发模式：通过命令行参数或环境变量
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'

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
let agentIpcRegistered = false
let agentRuntimeCleanedUp = false
let isQuittingAfterAgentCleanup = false

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
          "img-src 'self' data: blob: https: file:",
          "connect-src 'self' https: wss: data: http://175.178.198.17:* http://127.0.0.1:* http://localhost:*",
          // allow COS HTTPS presigned URLs (smart erase output) and file:// (compare-with-original)
          "media-src 'self' data: blob: https: file:",
          "worker-src 'self' blob:", // 允许 Web Worker 从 blob URL 创建（图片压缩库需要）
          "frame-src 'none'"
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

  // 键盘快捷键: F5, Ctrl+R, Cmd+R 刷新页面
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F5 刷新
    if (input.key === 'F5') {
      mainWindow?.webContents.reload()
      event.preventDefault()
    }
    // Ctrl+R 或 Cmd+R 刷新
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow?.webContents.reload()
      event.preventDefault()
    }
    // Ctrl+Shift+R 或 Cmd+Shift+R 强制刷新（清除缓存）
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
      mainWindow?.webContents.reloadIgnoringCache()
      event.preventDefault()
    }
    // F12 打开开发者工具（所有模式可用，方便调试）
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
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

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('native-theme-changed', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency
    })
  })

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
  mainWindow.webContents.on('context-menu', (_event, params) => {
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
  if (agentManager && agentMcpRuntime) {
    agentManager.setWindow(win)
    agentMcpRuntime.router.setWindow(win)
    return
  }

  const prisma = await getPrisma()
  const threadStore = new ThreadStore(prisma)
  agentMcpRuntime = await startCatimationMcpServer(win)
  agentManager = new AgentManager(win, threadStore)
  if (!agentIpcRegistered) {
    registerAgentIpc(agentManager, agentMcpRuntime.router)
    agentIpcRegistered = true
  }

  try {
    await agentManager.start()
  } catch (error) {
    console.error('[AgentRuntime] Codex backend init failed:', error)
  }
}

async function cleanupAgentRuntime(): Promise<void> {
  if (agentRuntimeCleanedUp) return
  agentRuntimeCleanedUp = true
  try {
    await agentManager?.stop()
  } finally {
    await shutdownDatabase()
  }
}

// App 生命周期
app.whenReady().then(async () => {
  console.log(`[Performance] App ready: ${Date.now() - startTime}ms`)

  // 关键路径：仅初始化必要的路径和目录
  initPaths()
  await ensureDirectories()

  console.log(`[Performance] Paths initialized: ${Date.now() - startTime}ms`)

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
        const updater = getAutoUpdaterInstance({
          provider: 'generic',
          url: 'https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/',
          fallback: {
            provider: 'github',
            owner: '2799662352',
            repo: 'ai-image-master'
          }
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
  if (isQuittingAfterAgentCleanup) return

  event.preventDefault()
  void cleanupAgentRuntime()
    .catch((error) => {
      console.error('[AgentRuntime] cleanup failed:', error)
    })
    .finally(() => {
      isQuittingAfterAgentCleanup = true
      app.quit()
    })
})

// ==================== IPC 处理 ====================

// AI Skills 读写
const builtinSkillsDir = app.isPackaged
  ? path.join(process.resourcesPath, 'skills')
  : path.resolve(__dirname, '../../skills')
const userSkillsDir = path.join(app.getPath('userData'), 'skills')

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
    // Ensure user skills directory exists to improve discoverability.
    fs.mkdirSync(userSkillsDir, { recursive: true })
    const builtin = readSkillsFromDir(builtinSkillsDir)
    const user = readSkillsFromDir(userSkillsDir)
    return { ...builtin, ...user }
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
    const dir = path.join(userSkillsDir, skillName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
    return { success: true }
  } catch (error: any) {
    console.error('保存 Skill 失败:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('open-skills-folder', async () => {
  try {
    fs.mkdirSync(userSkillsDir, { recursive: true })
    const errorMessage = await shell.openPath(userSkillsDir)
    if (errorMessage) {
      return { success: false, error: errorMessage, path: userSkillsDir }
    }
    return { success: true, path: userSkillsDir }
  } catch (error: any) {
    console.error('打开 Skills 文件夹失败:', error)
    return { success: false, error: error.message, path: userSkillsDir }
  }
})

// 图片操作
ipcMain.handle('save-image', async (_event, { base64Data, filename }: ImageSaveParams) => {
  try {
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
