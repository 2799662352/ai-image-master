// electron/preload.js - 预加载脚本，暴露安全的 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

// 暴露 electronAPI 到 window 对象
contextBridge.exposeInMainWorld('electronAPI', {
    // 检测是否在 Electron 环境
    isElectron: true,
    
    // 图片存储
    saveImage: (base64Data, filename) => 
        ipcRenderer.invoke('save-image', { base64Data, filename }),
    
    readImage: (filename) => 
        ipcRenderer.invoke('read-image', filename),
    
    deleteImage: (filename) => 
        ipcRenderer.invoke('delete-image', filename),
    
    // 历史记录
    saveHistory: (history) => 
        ipcRenderer.invoke('save-history', history),
    
    loadHistory: () => 
        ipcRenderer.invoke('load-history'),
    
    // 存储信息
    getStorageInfo: () => 
        ipcRenderer.invoke('get-storage-info'),
    
    // 文件操作
    selectSavePath: () => 
        ipcRenderer.invoke('select-save-path'),
    
    exportImage: (base64Data, targetDir, filename) => 
        ipcRenderer.invoke('export-image', { base64Data, targetDir, filename }),
    
    openPath: (filePath) => 
        ipcRenderer.invoke('open-path', filePath),
    
    // 页面状态持久化
    savePageState: (pageId, state) => 
        ipcRenderer.invoke('save-page-state', pageId, state),
    
    loadPageState: (pageId) => 
        ipcRenderer.invoke('load-page-state', pageId),
    
    clearPageState: (pageId) => 
        ipcRenderer.invoke('clear-page-state', pageId),
    
    clearAllPageStates: () => 
        ipcRenderer.invoke('clear-all-page-states'),
    
    getSavedPageIds: () => 
        ipcRenderer.invoke('get-saved-page-ids'),
    
    // 缓存清理
    clearWebCache: () => 
        ipcRenderer.invoke('clear-web-cache'),
    
    getCacheSize: () => 
        ipcRenderer.invoke('get-cache-size')
});

console.log('Electron preload 已加载，electronAPI 可用');

