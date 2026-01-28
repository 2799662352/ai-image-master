/**
 * storage-bridge.js - 存储桥接层
 * 自动检测 Electron 环境，使用本地文件存储；否则使用 localStorage
 */

class StorageBridge {
    constructor() {
        this.isElectron = window.electronAPI?.isElectron === true;
        this.imageCache = new Map(); // 内存缓存
        this.cachedStoragePath = null;
        console.log(`📦 存储模式: ${this.isElectron ? 'Electron 本地文件' : '浏览器 localStorage'}`);
        
        // 初始化时获取并缓存存储路径
        if (this.isElectron) {
            this.initStoragePath();
        }
    }

    async initStoragePath() {
        try {
            const info = await window.electronAPI.getStorageInfo();
            this.cachedStoragePath = info.storagePath;
            console.log(`📂 存储路径: ${this.cachedStoragePath}`);
        } catch (e) {
            console.error('获取存储路径失败:', e);
        }
    }

    getStoragePathSync() {
        return this.cachedStoragePath;
    }

    /**
     * 保存图片
     * @param {string} base64Data - base64 图片数据
     * @param {string} id - 图片唯一标识
     * @returns {Promise<{success: boolean, url: string}>}
     */
    async saveImage(base64Data, id) {
        if (this.isElectron) {
            const filename = `${id}.png`;
            const result = await window.electronAPI.saveImage(base64Data, filename);
            if (result.success) {
                this.imageCache.set(id, base64Data);
                return { success: true, url: `electron://${filename}`, localPath: result.path };
            }
            return { success: false, error: result.error };
        } else {
            // 浏览器模式：仅缓存，不存 localStorage (太大)
            this.imageCache.set(id, base64Data);
            return { success: true, url: base64Data };
        }
    }

    /**
     * 读取图片
     * @param {string} urlOrId - Electron URL 或原始 base64
     * @returns {Promise<string|null>}
     */
    async readImage(urlOrId) {
        // 已是 base64，直接返回
        if (urlOrId?.startsWith('data:image')) {
            return urlOrId;
        }

        // Electron 格式
        if (urlOrId?.startsWith('electron://')) {
            const filename = urlOrId.replace('electron://', '');
            const id = filename.replace(/\.\w+$/, '');
            
            // 先查缓存
            if (this.imageCache.has(id)) {
                return this.imageCache.get(id);
            }
            
            if (this.isElectron) {
                const data = await window.electronAPI.readImage(filename);
                if (data) {
                    this.imageCache.set(id, data);
                }
                return data;
            }
        }

        // 其他 URL (R2 等)
        return urlOrId;
    }

    /**
     * 删除图片
     * @param {string} urlOrId
     */
    async deleteImage(urlOrId) {
        if (urlOrId?.startsWith('electron://')) {
            const filename = urlOrId.replace('electron://', '');
            const id = filename.replace(/\.\w+$/, '');
            this.imageCache.delete(id);
            
            if (this.isElectron) {
                return await window.electronAPI.deleteImage(filename);
            }
        }
        return { success: true };
    }

    /**
     * 保存历史记录
     * @param {Array} history
     */
    async saveHistory(history) {
        if (this.isElectron) {
            // Electron: 存本地文件，图片保存到单独文件
            const historyWithRefs = await Promise.all(history.map(async (item) => {
                const newItem = { ...item };
                
                // 处理 imageUrl
                if (item.imageUrl?.startsWith('data:image')) {
                    const result = await this.saveImage(item.imageUrl, `img_${item.id}`);
                    if (result.success) {
                        newItem.imageUrl = result.url;
                    }
                }
                
                // 处理多图 images
                if (item.images?.length) {
                    newItem.images = await Promise.all(item.images.map(async (img, idx) => {
                        if (img?.startsWith('data:image')) {
                            const result = await this.saveImage(img, `img_${item.id}_${idx}`);
                            return result.success ? result.url : img;
                        }
                        return img;
                    }));
                }
                
                return newItem;
            }));
            
            return await window.electronAPI.saveHistory(historyWithRefs);
        } else {
            // 浏览器模式: 存 localStorage，但不存 base64
            try {
                const historyWithoutBase64 = history.map(item => {
                    const newItem = { ...item };
                    // 移除大型 base64 数据
                    if (newItem.imageUrl?.startsWith('data:image') && newItem.imageUrl.length > 1000) {
                        newItem.imageUrl = '[base64-removed]';
                    }
                    if (newItem.images?.length) {
                        newItem.images = newItem.images.map(img => 
                            img?.startsWith('data:image') && img.length > 1000 ? '[base64-removed]' : img
                        );
                    }
                    return newItem;
                });
                localStorage.setItem('ai_image_history', JSON.stringify(historyWithoutBase64));
                return { success: true };
            } catch (e) {
                console.error('localStorage 保存失败:', e);
                // 尝试清理旧数据
                try {
                    const trimmed = history.slice(0, 10).map(item => ({
                        id: item.id,
                        prompt: item.prompt,
                        model: item.model,
                        timestamp: item.timestamp
                    }));
                    localStorage.setItem('ai_image_history', JSON.stringify(trimmed));
                } catch (e2) {
                    console.error('无法保存历史记录');
                }
                return { success: false, error: e.message };
            }
        }
    }

    /**
     * 加载历史记录
     */
    async loadHistory() {
        if (this.isElectron) {
            const history = await window.electronAPI.loadHistory();
            return history || [];
        } else {
            try {
                const data = localStorage.getItem('ai_image_history');
                return data ? JSON.parse(data) : [];
            } catch (e) {
                console.error('读取历史记录失败:', e);
                return [];
            }
        }
    }

    /**
     * 获取存储状态信息
     */
    async getStorageInfo() {
        if (this.isElectron) {
            return await window.electronAPI.getStorageInfo();
        } else {
            // 浏览器: 估算 localStorage 使用量
            let total = 0;
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    total += localStorage[key].length * 2; // UTF-16
                }
            }
            return {
                imageCount: this.imageCache.size,
                totalSize: total,
                storagePath: 'localStorage',
                isElectron: false
            };
        }
    }

    /**
     * 导出图片到用户选择的目录
     */
    async exportImageToPath(base64Data, suggestedName) {
        if (this.isElectron) {
            const targetDir = await window.electronAPI.selectSavePath();
            if (targetDir) {
                return await window.electronAPI.exportImage(base64Data, targetDir, suggestedName);
            }
            return { success: false, error: '用户取消' };
        } else {
            // 浏览器: 下载
            const link = document.createElement('a');
            link.href = base64Data;
            link.download = suggestedName;
            link.click();
            return { success: true };
        }
    }

    /**
     * 打开文件所在目录
     */
    async openFilePath(path) {
        if (this.isElectron && path) {
            await window.electronAPI.openPath(path);
        }
    }
}

// 全局实例
window.storageBridge = new StorageBridge();
console.log('📦 StorageBridge 已初始化');

