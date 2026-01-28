// electron/main.js - Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// electron-store 配置
const pageStateStore = new Store({
    name: 'page-states',
    defaults: {
        version: '1.0.0',
        states: {}
    }
});

// 模板存储配置
const templateStore = new Store({
    name: 'custom-templates',
    defaults: {
        version: '1.0.0',
        templates: {},  // 用户自定义模板
        overrides: {}   // 对内置模板的修改
    }
});

// 记录启动时间（用于性能追踪）
const startTime = Date.now();

// ⚡ 忽略 GPU 缓存警告（不影响功能）
// 这些错误是 Chromium 缓存权限问题，不影响应用运行

// ⚡ 性能优化：禁用默认应用菜单（在 app ready 前调用）
Menu.setApplicationMenu(null);

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
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
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
        pageStateStore.set(`states.${pageId}`, state);
        return { success: true };
    } catch (error) {
        console.error('保存页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 加载页面状态
ipcMain.handle('load-page-state', async (event, pageId) => {
    try {
        const state = pageStateStore.get(`states.${pageId}`);
        return state || null;
    } catch (error) {
        console.error('加载页面状态失败:', error);
        return null;
    }
});

// 清除指定页面状态
ipcMain.handle('clear-page-state', async (event, pageId) => {
    try {
        pageStateStore.delete(`states.${pageId}`);
        return { success: true };
    } catch (error) {
        console.error('清除页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 清除所有页面状态
ipcMain.handle('clear-all-page-states', async () => {
    try {
        pageStateStore.set('states', {});
        return { success: true };
    } catch (error) {
        console.error('清除所有页面状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 获取所有已保存的页面 ID 列表
ipcMain.handle('get-saved-page-ids', async () => {
    try {
        const states = pageStateStore.get('states') || {};
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
        templateStore.set(`templates.${templateKey}`, templateData);
        return { success: true };
    } catch (error) {
        console.error('保存模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 保存内置模板的修改
ipcMain.handle('save-template-override', async (event, templateKey, templateData) => {
    try {
        templateStore.set(`overrides.${templateKey}`, templateData);
        return { success: true };
    } catch (error) {
        console.error('保存模板修改失败:', error);
        return { success: false, error: error.message };
    }
});

// 加载所有自定义模板
ipcMain.handle('load-custom-templates', async () => {
    try {
        return templateStore.get('templates') || {};
    } catch (error) {
        console.error('加载自定义模板失败:', error);
        return {};
    }
});

// 加载内置模板的修改
ipcMain.handle('load-template-overrides', async () => {
    try {
        return templateStore.get('overrides') || {};
    } catch (error) {
        console.error('加载模板修改失败:', error);
        return {};
    }
});

// 删除自定义模板
ipcMain.handle('delete-template', async (event, templateKey) => {
    try {
        templateStore.delete(`templates.${templateKey}`);
        return { success: true };
    } catch (error) {
        console.error('删除模板失败:', error);
        return { success: false, error: error.message };
    }
});

// 重置内置模板修改
ipcMain.handle('reset-template-override', async (event, templateKey) => {
    try {
        templateStore.delete(`overrides.${templateKey}`);
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
            templates: templateStore.get('templates') || {},
            overrides: templateStore.get('overrides') || {}
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
            const existing = templateStore.get('templates') || {};
            templateStore.set('templates', { ...existing, ...importData.templates });
        }
        if (importData.overrides) {
            const existing = templateStore.get('overrides') || {};
            templateStore.set('overrides', { ...existing, ...importData.overrides });
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

console.log('CATIMATION-Cyberpunk Master Electron 应用已启动');
console.log('用户数据目录:', userDataPath);

