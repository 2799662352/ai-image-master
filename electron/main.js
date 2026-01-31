// electron/main.js - Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ⚡ 性能优化：延迟加载 electron-store，避免启动时阻塞
let Store;
let pageStateStore;
let templateStore;
let galleryStore;

// 延迟初始化 electron-store（首次使用时才加载）
function getPageStateStore() {
    if (!pageStateStore) {
        if (!Store) Store = require('electron-store');
        pageStateStore = new Store({
            name: 'page-states',
            defaults: {
                version: '1.0.0',
                states: {}
            }
        });
    }
    return pageStateStore;
}

function getTemplateStore() {
    if (!templateStore) {
        if (!Store) Store = require('electron-store');
        templateStore = new Store({
            name: 'custom-templates',
            defaults: {
                version: '1.0.0',
                templates: {},
                overrides: {}
            }
        });
    }
    return templateStore;
}

function getGalleryStore() {
    if (!galleryStore) {
        if (!Store) Store = require('electron-store');
        galleryStore = new Store({
            name: 'custom-gallery-meta',
            defaults: {
                version: '2.0.0',
                images: []
            }
        });
    }
    return galleryStore;
}

// 记录启动时间（用于性能追踪）
const startTime = Date.now();

// ⚡ 忽略 GPU 缓存警告（不影响功能）
// 这些错误是 Chromium 缓存权限问题，不影响应用运行

// ⚡ 性能优化：禁用默认应用菜单（在 app ready 前调用）
Menu.setApplicationMenu(null);

// ⚡ 抑制 GPU 缓存警告（不影响功能）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

// 数据存储目录 - 延迟到 app ready 后初始化
let userDataPath;
let imagesDir;
let historyFile;

let mainWindow;

function initPaths() {
    userDataPath = app.getPath('userData');
    imagesDir = path.join(userDataPath, 'generated-images');
    historyFile = path.join(userDataPath, 'history.json');
}

// 异步确保目录存在
async function ensureDirectories() {
    try {
        await fs.promises.mkdir(imagesDir, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error('创建目录失败:', error);
        }
    }
}

function createWindow() {
    console.log(`[Performance] Window created: ${Date.now() - startTime}ms`);
    
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'CATIMATION-Cyberpunk Master',
        icon: path.join(__dirname, '../build/icon.png'),
        // ⚡ 性能优化：初始隐藏窗口，避免白屏
        show: false,
        // ⚡ 性能优化：设置背景色匹配应用主题，避免白色闪烁
        backgroundColor: '#09090B',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true, // 🔒 安全：启用沙箱模式
            preload: path.join(__dirname, 'preload.js'),
            // 🔒 安全加固选项
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false
        }
    });

    // 🔒 安全: 设置 Content Security Policy
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'",
                    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com",
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
                    "font-src 'self' https://fonts.gstatic.com data:",
                    "img-src 'self' data: blob: https: file:",
                    "connect-src 'self' https: wss:",
                    "media-src 'self' data: blob:",
                    "frame-src 'none'"
                ].join('; ')
            }
        });
    });

    // 🔒 安全: 限制导航 - 防止打开恶意链接
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        // 只允许 file:// 协议的导航
        if (parsedUrl.protocol !== 'file:') {
            console.warn(`[Security] 阻止导航到: ${navigationUrl}`);
            event.preventDefault();
        }
    });

    // 🔒 安全: 阻止新窗口创建，外部链接用默认浏览器打开
    const { shell } = require('electron');
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // ⚡ 性能优化：等待渲染完成后再显示窗口
    mainWindow.once('ready-to-show', () => {
        console.log(`[Performance] Ready to show: ${Date.now() - startTime}ms`);
        mainWindow.show();
    });

    // 加载主页面
    mainWindow.loadFile('index.html');

    // 开发模式打开 DevTools
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    // 在主窗口加载完成后记录
    mainWindow.webContents.on('did-finish-load', () => {
        console.log(`[Performance] Page loaded: ${Date.now() - startTime}ms`);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    console.log(`[Performance] App ready: ${Date.now() - startTime}ms`);
    
    initPaths();
    await ensureDirectories();
    
    console.log(`[Performance] Paths initialized: ${Date.now() - startTime}ms`);
    
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// ==================== IPC 处理 ====================

// 保存图片到本地 - 使用异步 I/O
ipcMain.handle('save-image', async (event, { base64Data, filename }) => {
    try {
        const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const filePath = path.join(imagesDir, filename);
        await fs.promises.writeFile(filePath, buffer);
        return { success: true, path: filePath };
    } catch (error) {
        console.error('保存图片失败:', error);
        return { success: false, error: error.message };
    }
});

// 读取图片 - 使用异步 I/O
ipcMain.handle('read-image', async (event, filename) => {
    try {
        const filePath = path.join(imagesDir, filename);
        const buffer = await fs.promises.readFile(filePath);
        const ext = path.extname(filename).slice(1) || 'png';
        return `data:image/${ext};base64,${buffer.toString('base64')}`;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('读取图片失败:', error);
        }
        return null;
    }
});

// 删除图片 - 使用异步 I/O
ipcMain.handle('delete-image', async (event, filename) => {
    try {
        const filePath = path.join(imagesDir, filename);
        await fs.promises.unlink(filePath);
        return { success: true };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('删除图片失败:', error);
        }
        return { success: true }; // 文件不存在也视为成功
    }
});

// 保存历史记录 - 使用异步 I/O
ipcMain.handle('save-history', async (event, history) => {
    try {
        await fs.promises.writeFile(historyFile, JSON.stringify(history, null, 2), 'utf-8');
        return { success: true };
    } catch (error) {
        console.error('保存历史记录失败:', error);
        return { success: false, error: error.message };
    }
});

// 读取历史记录 - 使用异步 I/O
ipcMain.handle('load-history', async () => {
    try {
        const data = await fs.promises.readFile(historyFile, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('读取历史记录失败:', error);
        }
        return [];
    }
});

// 获取存储信息 - 使用异步 I/O
ipcMain.handle('get-storage-info', async () => {
    try {
        const files = await fs.promises.readdir(imagesDir);
        let totalSize = 0;
        for (const file of files) {
            const filePath = path.join(imagesDir, file);
            const stats = await fs.promises.stat(filePath);
            totalSize += stats.size;
        }
        return {
            imageCount: files.length,
            totalSize: totalSize,
            storagePath: userDataPath
        };
    } catch (error) {
        console.error('获取存储信息失败:', error);
        return { imageCount: 0, totalSize: 0, storagePath: userDataPath };
    }
});

// 选择保存路径
ipcMain.handle('select-save-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择保存目录'
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// 导出图片到指定目录 - 使用异步 I/O
ipcMain.handle('export-image', async (event, { base64Data, targetDir, filename }) => {
    try {
        const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const filePath = path.join(targetDir, filename);
        await fs.promises.writeFile(filePath, buffer);
        return { success: true, path: filePath };
    } catch (error) {
        console.error('导出图片失败:', error);
        return { success: false, error: error.message };
    }
});

// 打开文件所在目录
ipcMain.handle('open-path', async (event, filePath) => {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
});

// ==================== 页面状态持久化 IPC ====================

// 保存页面状态
ipcMain.handle('save-page-state', async (event, pageId, state) => {
    try {
        getPageStateStore().set(`states.${pageId}`, state);
        return { success: true };
    } catch (error) {
        console.error('保存页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 加载页面状态
ipcMain.handle('load-page-state', async (event, pageId) => {
    try {
        const state = getPageStateStore().get(`states.${pageId}`);
        return state || null;
    } catch (error) {
        console.error('加载页面状态失败:', error);
        return null;
    }
});

// 清除指定页面状态
ipcMain.handle('clear-page-state', async (event, pageId) => {
    try {
        getPageStateStore().delete(`states.${pageId}`);
        return { success: true };
    } catch (error) {
        console.error('清除页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 清除所有页面状态
ipcMain.handle('clear-all-page-states', async () => {
    try {
        getPageStateStore().set('states', {});
        return { success: true };
    } catch (error) {
        console.error('清除所有页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 获取所有已保存的页面 ID 列表
ipcMain.handle('get-saved-page-ids', async () => {
    try {
        const states = getPageStateStore().get('states') || {};
        return Object.keys(states);
    } catch (error) {
        console.error('获取页面列表失败:', error);
        return [];
    }
});

// ==================== 缓存清理 IPC ====================

// 清理网页缓存（localStorage, IndexedDB, Cache Storage 等）
ipcMain.handle('clear-web-cache', async () => {
    try {
        if (!mainWindow) {
            return { success: false, error: '窗口未初始化' };
        }
        
        const ses = mainWindow.webContents.session;
        
        // 清理 localStorage, IndexedDB, WebSQL, Cache Storage
        await ses.clearStorageData({
            storages: ['localstorage', 'indexdb', 'websql', 'cachestorage']
        });
        
        // 清理 HTTP 缓存
        await ses.clearCache();
        
        console.log('网页缓存已清理');
        return { success: true };
    } catch (error) {
        console.error('清理网页缓存失败:', error);
        return { success: false, error: error.message };
    }
});

// 获取缓存大小信息
ipcMain.handle('get-cache-size', async () => {
    try {
        if (!mainWindow) {
            return { cacheSize: 0 };
        }
        
        const ses = mainWindow.webContents.session;
        const cacheSize = await ses.getCacheSize();
        
        return { cacheSize };
    } catch (error) {
        console.error('获取缓存大小失败:', error);
        return { cacheSize: 0 };
    }
});

// ==================== 模板存储 IPC ====================

// 保存自定义模板
ipcMain.handle('save-template', async (event, templateKey, templateData) => {
    try {
        getTemplateStore().set(`templates.${templateKey}`, templateData);
        return { success: true };
    } catch (error) {
        console.error('保存模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 保存内置模板的修改
ipcMain.handle('save-template-override', async (event, templateKey, templateData) => {
    try {
        getTemplateStore().set(`overrides.${templateKey}`, templateData);
        return { success: true };
    } catch (error) {
        console.error('保存模板修改失败:', error);
        return { success: false, error: error.message };
    }
});

// 加载所有自定义模板
ipcMain.handle('load-custom-templates', async () => {
    try {
        return getTemplateStore().get('templates') || {};
    } catch (error) {
        console.error('加载自定义模板失败:', error);
        return {};
    }
});

// 加载内置模板的修改
ipcMain.handle('load-template-overrides', async () => {
    try {
        return getTemplateStore().get('overrides') || {};
    } catch (error) {
        console.error('加载模板修改失败:', error);
        return {};
    }
});

// 删除自定义模板
ipcMain.handle('delete-template', async (event, templateKey) => {
    try {
        getTemplateStore().delete(`templates.${templateKey}`);
        return { success: true };
    } catch (error) {
        console.error('删除模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 重置内置模板修改
ipcMain.handle('reset-template-override', async (event, templateKey) => {
    try {
        getTemplateStore().delete(`overrides.${templateKey}`);
        return { success: true };
    } catch (error) {
        console.error('重置模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 导出模板到文件
ipcMain.handle('export-templates', async () => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出模板',
            defaultPath: 'my-templates.json',
            filters: [{ name: 'JSON 文件', extensions: ['json'] }]
        });
        
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        
        const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            templates: getTemplateStore().get('templates') || {},
            overrides: getTemplateStore().get('overrides') || {}
        };
        
        await fs.promises.writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
        return { success: true, path: result.filePath };
    } catch (error) {
        console.error('导出模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 从文件导入模板
ipcMain.handle('import-templates', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '导入模板',
            filters: [{ name: 'JSON 文件', extensions: ['json'] }],
            properties: ['openFile']
        });
        
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        
        const data = await fs.promises.readFile(result.filePaths[0], 'utf-8');
        const importData = JSON.parse(data);
        
        // 验证数据格式
        if (!importData.templates && !importData.overrides) {
            return { success: false, error: '无效的模板文件格式' };
        }
        
        // 合并导入的模板
        if (importData.templates) {
            const existing = getTemplateStore().get('templates') || {};
            getTemplateStore().set('templates', { ...existing, ...importData.templates });
        }
        if (importData.overrides) {
            const existing = getTemplateStore().get('overrides') || {};
            getTemplateStore().set('overrides', { ...existing, ...importData.overrides });
        }
        
        return { 
            success: true, 
            imported: {
                templates: Object.keys(importData.templates || {}).length,
                overrides: Object.keys(importData.overrides || {}).length
            }
        };
    } catch (error) {
        console.error('导入模板失败:', error);
        return { success: false, error: error.message };
    }
});

// ==================== 自定义图库存储 IPC ====================

// 自定义图库目录 - 延迟初始化
let customGalleryPath = null;

// 初始化自定义图库目录
function initCustomGalleryPath() {
    if (!customGalleryPath && userDataPath) {
        customGalleryPath = path.join(userDataPath, 'custom-gallery');
        // 确保目录存在
        if (!fs.existsSync(customGalleryPath)) {
            fs.mkdirSync(customGalleryPath, { recursive: true });
        }
    }
    return customGalleryPath;
}

// 元数据存储 - 使用 getGalleryStore() 延迟加载

// 获取图库目录路径
ipcMain.handle('get-custom-gallery-path', async () => {
    return initCustomGalleryPath();
});

// 添加图片到图库（复制文件）
ipcMain.handle('add-custom-gallery-image', async (event, { id, name, sourcePath }) => {
    try {
        const galleryPath = initCustomGalleryPath();
        const ext = path.extname(sourcePath) || '.png';
        const filename = `${id}${ext}`;
        const destPath = path.join(galleryPath, filename);
        
        // 复制文件
        fs.copyFileSync(sourcePath, destPath);
        
        // 更新元数据
        const images = getGalleryStore().get('images') || [];
        images.push({
            id,
            name,
            filename,
            createdAt: new Date().toISOString()
        });
        getGalleryStore().set('images', images);
        
        return { success: true, filename, path: destPath };
    } catch (error) {
        console.error('添加图片到图库失败:', error);
        return { success: false, error: error.message };
    }
});

// 保存自定义图库（仅元数据，兼容旧版）
ipcMain.handle('save-custom-gallery', async (event, images) => {
    try {
        // 过滤掉 base64 数据，只保留元数据
        const metaImages = images.map(img => ({
            id: img.id,
            name: img.name,
            filename: img.filename || `${img.id}.png`,
            createdAt: img.createdAt
        }));
        getGalleryStore().set('images', metaImages);
        return { success: true };
    } catch (error) {
        console.error('保存自定义图库失败:', error);
        return { success: false, error: error.message };
    }
});

// 加载自定义图库
ipcMain.handle('load-custom-gallery', async () => {
    try {
        const galleryPath = initCustomGalleryPath();
        const images = getGalleryStore().get('images') || [];
        // 为每个图片添加完整路径
        return images.map(img => ({
            ...img,
            path: path.join(galleryPath, img.filename || `${img.id}.png`),
            // 生成 file:// URL 供渲染进程使用
            url: `file://${path.join(galleryPath, img.filename || `${img.id}.png`).replace(/\\/g, '/')}`
        })).filter(img => {
            // 过滤掉文件不存在的记录
            const exists = fs.existsSync(img.path);
            if (!exists) {
                console.warn('图片文件不存在:', img.path);
            }
            return exists;
        });
    } catch (error) {
        console.error('加载自定义图库失败:', error);
        return [];
    }
});

// 删除单个自定义图库图片
ipcMain.handle('delete-custom-gallery-image', async (event, imageId) => {
    try {
        const galleryPath = initCustomGalleryPath();
        const images = getGalleryStore().get('images') || [];
        const imageToDelete = images.find(img => img.id === imageId);
        
        if (imageToDelete) {
            // 删除文件
            const filePath = path.join(galleryPath, imageToDelete.filename || `${imageId}.png`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
        
        // 更新元数据
        const filtered = images.filter(img => img.id !== imageId);
        getGalleryStore().set('images', filtered);
        return { success: true };
    } catch (error) {
        console.error('删除自定义图库图片失败:', error);
        return { success: false, error: error.message };
    }
});

// 启动日志在 app.whenReady 中输出，此处 userDataPath 尚未初始化

