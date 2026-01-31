/**
 * page-state-manager.js - 页面状态管理器
 * 负责保存和恢复页面状态，支持 Electron 和浏览器环境
 * 
 * V16.3: 使用 window.appServices 命名空间
 */

// V16.3: 辅助函数获取 storageBridge (优先 appServices)
function getStorageBridgeJS() {
    return window.appServices?.services?.storage || window.storageBridgeTS;
}

class PageStateManager {
    constructor() {
        this.isElectron = window.electronAPI?.isElectron === true;
        this.stateCache = new Map(); // 内存缓存
        this.saveDebounceTimers = new Map(); // 防抖定时�?        this.defaultDebounceMs = 1000; // 默认防抖时间
        
        // 状态配�?        this.config = {
            maxImageSize: 500 * 1024, // 500KB，超过此大小的图片保存到本地文件（Electron）或过滤（浏览器�?            maxImagesPerPage: 5, // 每页最多保存的参考图数量（增加到5张，因为大图片现在可以存到文件）
            storagePrefix: 'pageState_',
            version: '1.1.0' // v1.1.0: 支持大图片保存到本地文件
        };

        console.log(`📦 PageStateManager 初始�? ${this.isElectron ? 'Electron 模式' : '浏览器模�?}`);
    }

    /**
     * 保存页面状态（带防抖）
     * @param {string} pageId - 页面标识�?(generate, batch, director, compare)
     * @param {object} state - 页面状态对�?     * @param {number} debounceMs - 防抖时间（毫秒）
     */
    saveState(pageId, state, debounceMs = this.defaultDebounceMs) {
        // 清除之前的定时器
        if (this.saveDebounceTimers.has(pageId)) {
            clearTimeout(this.saveDebounceTimers.get(pageId));
        }

        // 设置新的定时�?        const timer = setTimeout(() => {
            this._doSaveState(pageId, state);
            this.saveDebounceTimers.delete(pageId);
        }, debounceMs);

        this.saveDebounceTimers.set(pageId, timer);
    }

    /**
     * 立即保存页面状态（非阻塞，使用 requestIdleCallback�?     * @param {string} pageId - 页面标识�?     * @param {object} state - 页面状态对�?     */
    saveStateImmediate(pageId, state) {
        // 清除可能存在的防抖定时器
        if (this.saveDebounceTimers.has(pageId)) {
            clearTimeout(this.saveDebounceTimers.get(pageId));
            this.saveDebounceTimers.delete(pageId);
        }
        
        // 立即更新内存缓存（确保页面切换后立即可用�?        const stateWithMeta = {
            version: this.config.version,
            timestamp: Date.now(),
            pageId: pageId,
            data: state
        };
        this.stateCache.set(pageId, stateWithMeta);
        
        // 延迟持久化存储，不阻塞主线程
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => this._doSaveState(pageId, state), { timeout: 500 });
        } else {
            // 回退方案：使�?setTimeout 0 延迟执行
            setTimeout(() => this._doSaveState(pageId, state), 0);
        }
    }

    /**
     * 实际执行保存操作
     * @private
     */
    async _doSaveState(pageId, state) {
        try {
            // 处理状态中的图片数据（异步，可能需要保存大图片到文件）
            const processedState = await this._processStateForStorage(pageId, state);
            
            // 添加元数�?            const stateWithMeta = {
                version: this.config.version,
                timestamp: Date.now(),
                pageId: pageId,
                data: processedState
            };

            // 更新内存缓存
            this.stateCache.set(pageId, stateWithMeta);

            if (this.isElectron) {
                // Electron: 通过 IPC 保存�?electron-store
                await window.electronAPI.savePageState(pageId, stateWithMeta);
            } else {
                // 浏览�? 保存�?localStorage
                const key = this.config.storagePrefix + pageId;
                localStorage.setItem(key, JSON.stringify(stateWithMeta));
            }

            console.log(`💾 页面状态已保存: ${pageId}`);
        } catch (error) {
            console.error(`�?保存页面状态失�?(${pageId}):`, error);
        }
    }

    /**
     * 加载页面状�?     * @param {string} pageId - 页面标识�?     * @returns {object|null} 页面状态对象，如果不存在则返回 null
     */
    async loadState(pageId) {
        try {
            // 先检查内存缓�?            if (this.stateCache.has(pageId)) {
                const cached = this.stateCache.get(pageId);
                console.log(`📖 从缓存加载页面状�? ${pageId}`);
                return cached.data;
            }

            let stateWithMeta = null;

            if (this.isElectron) {
                // Electron: 通过 IPC �?electron-store 加载
                stateWithMeta = await window.electronAPI.loadPageState(pageId);
            } else {
                // 浏览�? �?localStorage 加载
                const key = this.config.storagePrefix + pageId;
                const stored = localStorage.getItem(key);
                if (stored) {
                    stateWithMeta = JSON.parse(stored);
                }
            }

            if (stateWithMeta) {
                // 验证版本
                if (stateWithMeta.version !== this.config.version) {
                    console.warn(`⚠️ 页面状态版本不匹配 (${pageId}), 将清除旧数据`);
                    await this.clearState(pageId);
                    return null;
                }

                // 处理存储引用，恢复图片数�?                const processedData = await this._processStateForLoad(stateWithMeta.data);

                // 更新内存缓存（使用处理后的数据）
                this.stateCache.set(pageId, { ...stateWithMeta, data: processedData });
                console.log(`📖 页面状态已加载: ${pageId}`);
                return processedData;
            }

            return null;
        } catch (error) {
            console.error(`�?加载页面状态失�?(${pageId}):`, error);
            return null;
        }
    }

    /**
     * 清除页面状�?     * @param {string} pageId - 页面标识�?     */
    async clearState(pageId) {
        try {
            // Electron 模式: 先清理本地图片文�?            // V16.3: 使用 appServices
            const storageBridge = getStorageBridgeJS();
            if (this.isElectron && storageBridge) {
                let stateToClean = null;
                
                if (this.stateCache.has(pageId)) {
                    stateToClean = this.stateCache.get(pageId)?.data;
                } else {
                    const storedState = await window.electronAPI.loadPageState(pageId);
                    stateToClean = storedState?.data;
                }

                if (stateToClean) {
                    await this._cleanupLocalImages(stateToClean);
                }
            }

            // 清除内存缓存
            this.stateCache.delete(pageId);

            if (this.isElectron) {
                await window.electronAPI.clearPageState(pageId);
            } else {
                const key = this.config.storagePrefix + pageId;
                localStorage.removeItem(key);
            }

            console.log(`🗑�?页面状态已清除: ${pageId}`);
        } catch (error) {
            console.error(`�?清除页面状态失�?(${pageId}):`, error);
        }
    }

    /**
     * 清除所有页面状�?     */
    async clearAllStates() {
        try {
            // Electron 模式: 先清理所有本地图片文�?            // V16.3: 使用 appServices
            if (this.isElectron && getStorageBridgeJS()) {
                const pageIds = await this.getSavedPageIds();

                for (const pageId of pageIds) {
                    let stateToClean = null;
                    
                    if (this.stateCache.has(pageId)) {
                        stateToClean = this.stateCache.get(pageId)?.data;
                    } else {
                        const storedState = await window.electronAPI.loadPageState(pageId);
                        stateToClean = storedState?.data;
                    }

                    if (stateToClean) {
                        await this._cleanupLocalImages(stateToClean);
                    }
                }
            }

            // 清除内存缓存
            this.stateCache.clear();

            if (this.isElectron) {
                await window.electronAPI.clearAllPageStates();
            } else {
                // 清除所有以 storagePrefix 开头的 localStorage �?                const keysToRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith(this.config.storagePrefix)) {
                        keysToRemove.push(key);
                    }
                }
                keysToRemove.forEach(key => localStorage.removeItem(key));
            }

            console.log(`🗑�?所有页面状态已清除`);
        } catch (error) {
            console.error(`�?清除所有页面状态失�?`, error);
        }
    }

    /**
     * 清理状态中保存的本地图片文件（�?Electron 模式�?     * @private
     */
    async _cleanupLocalImages(state) {
        // V16.3: 使用 appServices
        const storageBridge = getStorageBridgeJS();
        if (!state || !this.isElectron || !storageBridge) return;

        const localImages = [];

        // 收集本地文件引用
        if (state.referenceImages && Array.isArray(state.referenceImages)) {
            state.referenceImages.forEach(img => {
                if (img?.base64?.startsWith('electron://')) {
                    localImages.push(img.base64);
                }
            });
        }

        if (state.batchReferenceImages && Array.isArray(state.batchReferenceImages)) {
            state.batchReferenceImages.forEach(img => {
                if (img?.base64?.startsWith('electron://')) {
                    localImages.push(img.base64);
                }
            });
        }

        // 删除本地文件
        for (const imageUrl of localImages) {
            try {
                await storageBridge.deleteImage(imageUrl);
                console.log(`🗑�?已删除本地图�? ${imageUrl}`);
            } catch (error) {
                console.warn(`删除本地图片失败: ${imageUrl}`, error);
            }
        }
    }

    /**
     * 处理状态中的图片数据，大图片保存到本地文件（Electron）或过滤（浏览器�?     * @private
     */
    async _processStateForStorage(pageId, state) {
        const processed = { ...state };

        // 处理参考图数组
        if (processed.referenceImages && Array.isArray(processed.referenceImages)) {
            processed.referenceImages = await this._processImagesForSave(pageId, processed.referenceImages, 'ref');
        }

        // 批量页面的参考图
        if (processed.batchReferenceImages && Array.isArray(processed.batchReferenceImages)) {
            processed.batchReferenceImages = await this._processImagesForSave(pageId, processed.batchReferenceImages, 'batchRef');
        }

        return processed;
    }

    /**
     * 处理图片数组用于保存
     * - Electron 模式: 大图片保存到本地文件，返�?electron:// 引用
     * - 浏览器模�? 大图片过滤（localStorage 限制�?     * @private
     */
    async _processImagesForSave(pageId, images, prefix) {
        if (!images || !Array.isArray(images)) return [];

        // 限制数量
        const limitedImages = images.slice(0, this.config.maxImagesPerPage);

        const processedImages = await Promise.all(limitedImages.map(async (img, idx) => {
            if (!img) return img;

            // 如果已经是文件引用，保持不变
            if (img.base64 && img.base64.startsWith('electron://')) {
                return img;
            }

            // 检查是否是 base64 数据
            if (img.base64 && img.base64.startsWith('data:image')) {
                const estimatedSize = img.base64.length;

                // 大图片处�?                if (estimatedSize > this.config.maxImageSize) {
                    // Electron 模式: 保存到本地文�?                    // V16.3: 使用 appServices
                    const storageBridge = getStorageBridgeJS();
                    if (this.isElectron && storageBridge) {
                        try {
                            const imageId = `${prefix}_${pageId}_${idx}_${Date.now()}`;
                            const result = await storageBridge.saveImage(img.base64, imageId);
                            if (result.success) {
                                console.log(`📁 大图片已保存到本�? ${imageId} (${Math.round(estimatedSize / 1024)}KB)`);
                                return {
                                    ...img,
                                    base64: result.url, // electron://xxx.png
                                    _savedToFile: true,
                                    _originalSize: estimatedSize
                                };
                            }
                        } catch (error) {
                            console.error('保存大图片到本地文件失败:', error);
                        }
                    }

                    // 浏览器模�?�?Electron 保存失败: 过滤大图�?                    console.warn(`⚠️ 大图片已过滤 (${Math.round(estimatedSize / 1024)}KB)`);
                    return {
                        ...img,
                        base64: null,
                        _oversized: true,
                        _originalSize: estimatedSize
                    };
                }
            }

            return img;
        }));

        return processedImages;
    }

    /**
     * 处理加载的状态，将文件引用恢复为 base64
     * @private
     */
    async _processStateForLoad(state) {
        if (!state) return state;

        const processed = { ...state };

        // 处理参考图数组
        if (processed.referenceImages && Array.isArray(processed.referenceImages)) {
            processed.referenceImages = await this._processImagesForLoad(processed.referenceImages);
        }

        // 批量页面的参考图
        if (processed.batchReferenceImages && Array.isArray(processed.batchReferenceImages)) {
            processed.batchReferenceImages = await this._processImagesForLoad(processed.batchReferenceImages);
        }

        return processed;
    }

    /**
     * 处理图片数组用于加载，将 electron:// 引用恢复�?base64
     * @private
     */
    async _processImagesForLoad(images) {
        if (!images || !Array.isArray(images)) return [];

        const processedImages = await Promise.all(images.map(async (img) => {
            if (!img) return img;

            // 检查是否是 Electron 本地文件引用
            // V16.3: 使用 appServices
            const storageBridge = getStorageBridgeJS();
            if (img.base64 && img.base64.startsWith('electron://') && storageBridge) {
                try {
                    const base64Data = await storageBridge.readImage(img.base64);
                    if (base64Data) {
                        console.log(`📖 从本地文件恢复图�? ${img.base64}`);
                        return {
                            ...img,
                            base64: base64Data,
                            _savedToFile: undefined // 清除标记
                        };
                    }
                } catch (error) {
                    console.error('从本地文件读取图片失�?', error);
                }
                // 读取失败，标记为加载失败
                return {
                    ...img,
                    _loadFailed: true
                };
            }

            return img;
        }));

        return processedImages;
    }

    /**
     * 获取所有已保存的页�?ID 列表
     * @returns {Promise<string[]>}
     */
    async getSavedPageIds() {
        try {
            if (this.isElectron) {
                return await window.electronAPI.getSavedPageIds();
            } else {
                const pageIds = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith(this.config.storagePrefix)) {
                        pageIds.push(key.replace(this.config.storagePrefix, ''));
                    }
                }
                return pageIds;
            }
        } catch (error) {
            console.error('�?获取已保存页面列表失�?', error);
            return [];
        }
    }
}

// 创建全局实例
window.pageStateManager = new PageStateManager();
console.log('📦 PageStateManager 已初始化');
