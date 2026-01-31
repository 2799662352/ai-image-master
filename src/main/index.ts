// src/main/index.ts - Electron 主进程 (TypeScript)
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { autoUpdaterInstance } from './updater'

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

// 数据存储目录
let userDataPath: string
let imagesDir: string
let historyFile: string
let customGalleryPath: string | null = null
let mainWindow: BrowserWindow | null = null

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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // 启用沙箱模式
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
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // 允许内联脚本（开发阶段）
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: blob: https: file:",
          "connect-src 'self' https: wss:",
          "media-src 'self' data: blob:",
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

  mainWindow.once('ready-to-show', () => {
    console.log(`[Performance] Ready to show: ${Date.now() - startTime}ms`)
    mainWindow?.show()
  })

  // 开发模式使用 Vite dev server
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[Performance] Page loaded: ${Date.now() - startTime}ms`)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
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

  // 非关键路径：初始化自动更新（生产环境，延迟 15 秒）
  // 用户完全交互后再检查更新，避免网络争用
  if (mainWindow && process.env.NODE_ENV !== 'development') {
    setTimeout(() => {
      autoUpdaterInstance.setMainWindow(mainWindow!)
      autoUpdaterInstance.checkForUpdatesOnStartup(0)
      console.log(`[Performance] Auto-updater initialized: ${Date.now() - startTime}ms`)
    }, 15000)
  }

  // 非关键路径：预热 Gallery store（延迟 20 秒）
  // 自定义图库功能使用频率较低
  setTimeout(() => {
    getGalleryStore()
    console.log(`[Performance] Gallery store warmed up: ${Date.now() - startTime}ms`)
  }, 20000)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

// ==================== IPC 处理 ====================

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
