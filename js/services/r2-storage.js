// Cloudflare R2 存储服务
class R2StorageService {
    constructor() {
        this.workerUrl = null;
        this.config = null;
        this.initialized = false;
        this.initPromise = null;
    }

    // 初始化服务
    async init() {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._initialize();
        await this.initPromise;
        this.initialized = true;
    }

    async _initialize() {
        // 直接使用本地配置，避免跨域问题
        this.workerUrl = this.getLocalWorkerUrl();
        this.config = this.getDefaultConfig();

        if (this.workerUrl) {
            console.log('R2存储服务已初始化，Worker URL:', this.workerUrl);
        } else {
            // 如果没有本地配置，尝试使用默认的 Worker URL
            this.workerUrl = 'https://ai-image-proxy.uchihasasiky.workers.dev';
            console.log('使用默认 Worker URL:', this.workerUrl);
        }
    }

    // 从云端获取配置
    async fetchCloudConfig() {
        // 云端配置端点 - 使用相对路径或检测当前域名
        let configUrl = '/api/config/r2-storage';

        // 如果是本地开发环境，使用完整的线上地址
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            configUrl = 'https://imagen.apiyi.com/api/config/r2-storage';
        } else if (window.location.hostname.includes('apiyi.com')) {
            // 如果是 apiyi.com 域名，使用相对路径
            configUrl = '/api/config/r2-storage';
        } else {
            // 其他情况使用线上地址
            configUrl = 'https://imagen.apiyi.com/api/config/r2-storage';
        }

        try {
            const response = await fetch(configUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-Client-Version': '1.0.0',
                    'X-Client-Origin': window.location.origin
                }
            });

            if (!response.ok) {
                throw new Error(`配置服务响应错误: ${response.status}`);
            }

            const config = await response.json();

            // 验证配置完整性
            if (!config.workerUrl) {
                throw new Error('配置缺少 workerUrl');
            }

            return config;
        } catch (error) {
            console.error('获取云端配置失败:', error);
            // 如果是网络错误，返回硬编码的备用配置
            if (error.message.includes('fetch')) {
                return {
                    workerUrl: 'https://ai-image-proxy.uchihasasiky.workers.dev',
                    features: {
                        autoCache: true,
                        maxFileSize: 10485760,
                        allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
                        ttl: 2592000
                    }
                };
            }
            throw error;
        }
    }

    // 获取本地配置的 Worker URL
    getLocalWorkerUrl() {
        return localStorage.getItem('worker_url') ||
               window.CLOUDFLARE_WORKER_URL ||
               null;
    }

    // 默认配置
    getDefaultConfig() {
        return {
            features: {
                autoCache: true,
                maxFileSize: 52428800, // 50MB
                allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
                ttl: 2592000 // 30天
            }
        };
    }

    // 检查服务是否可用
    isAvailable() {
        // 检查是否有 Worker URL（本地配置或云端配置）
        const hasWorkerUrl = !!this.workerUrl || !!this.getLocalWorkerUrl();

        if (hasWorkerUrl && !this.workerUrl) {
            // 如果有本地配置但还没加载，立即加载
            this.workerUrl = this.getLocalWorkerUrl();
            this.config = this.getDefaultConfig();
            console.log('使用本地配置的 Worker URL:', this.workerUrl);
        }

        return !!this.workerUrl;
    }

    // 生成签名（用于安全验证）
    generateSignature(data) {
        const timestamp = Date.now();
        const nonce = Math.random().toString(36).substring(2);

        // 简单的签名算法（实际应用中应使用更安全的方法）
        const signString = `${timestamp}:${nonce}:${JSON.stringify(data)}`;
        const signature = btoa(signString);

        return {
            signature,
            timestamp,
            nonce
        };
    }

    // 上传 Base64 图片到 R2
    async uploadBase64(base64Data, metadata = {}) {
        await this.init();

        if (!this.isAvailable()) {
            console.log('R2服务不可用，返回原始数据, workerUrl:', this.workerUrl);
            return base64Data;
        }

        console.log('开始上传 Base64 图片到 R2, Worker URL:', this.workerUrl);

        try {
            // 提取 base64 数据
            const base64Match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
            if (!base64Match) {
                console.error('无效的 base64 数据');
                return base64Data;
            }

            const mimeType = base64Match[1];
            const base64Content = base64Match[2];

            // 生成签名
            const { signature, timestamp, nonce } = this.generateSignature({
                type: 'upload',
                mimeType,
                size: base64Content.length
            });

            // 上传到 R2
            const response = await fetch(`${this.workerUrl}/api/upload-base64`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature': signature,
                    'X-Timestamp': timestamp,
                    'X-Nonce': nonce,
                    'Origin': window.location.origin
                },
                body: JSON.stringify({
                    base64: base64Content,
                    mimeType,
                    metadata: {
                        ...metadata,
                        source: 'ai-image-master',
                        uploadedAt: new Date().toISOString()
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`上传失败: ${response.status}`);
            }

            const result = await response.json();

            if (result.success && result.url) {
                console.log('图片已上传到 R2:', result.url);
                return result.url;
            }

            throw new Error(result.error || '上传失败');
        } catch (error) {
            console.error('R2上传失败，返回原始数据:', error);
            return base64Data; // 降级处理
        }
    }

    // 缓存远程 URL 到 R2
    async cacheRemoteUrl(url, metadata = {}) {
        await this.init();

        if (!this.isAvailable()) {
            console.log('R2服务不可用，返回原始URL');
            return url;
        }

        // 如果已经是 R2 URL，直接返回
        if (this.isR2Url(url)) {
            return url;
        }

        console.log('开始缓存远程图片到 R2:', {
            url: url.substring(0, 100),
            workerUrl: this.workerUrl,
            endpoint: `${this.workerUrl}/api/cache-image`
        });

        try {
            // 生成签名
            const { signature, timestamp, nonce } = this.generateSignature({
                type: 'cache',
                url
            });

            // 缓存到 R2
            const requestUrl = `${this.workerUrl}/api/cache-image`;
            const requestBody = {
                url,
                metadata: {
                    ...metadata,
                    source: 'ai-image-master',
                    cachedAt: new Date().toISOString()
                }
            };

            console.log('发送缓存请求:', requestUrl);

            const response = await fetch(requestUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature': signature,
                    'X-Timestamp': timestamp,
                    'X-Nonce': nonce,
                    'Origin': window.location.origin
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`缓存失败: ${response.status}`);
            }

            const result = await response.json();

            if (result.success && result.cachedUrl) {
                console.log('远程图片已缓存到 R2:', result.cachedUrl);
                return result.cachedUrl;
            }

            throw new Error(result.error || '缓存失败');
        } catch (error) {
            console.error('R2缓存失败，返回原始URL:', error);
            return url; // 降级处理
        }
    }

    // 批量上传/缓存
    async batchProcess(items) {
        await this.init();

        if (!this.isAvailable()) {
            console.log('R2服务不可用，返回原始数据');
            return items;
        }

        const results = await Promise.allSettled(
            items.map(async (item) => {
                if (typeof item === 'string') {
                    // 字符串处理
                    if (item.startsWith('data:image')) {
                        return await this.uploadBase64(item);
                    } else {
                        return await this.cacheRemoteUrl(item);
                    }
                } else if (item.type === 'base64') {
                    return await this.uploadBase64(item.data, item.metadata);
                } else if (item.type === 'url') {
                    return await this.cacheRemoteUrl(item.data, item.metadata);
                }
                return item;
            })
        );

        return results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                console.error(`处理第 ${index + 1} 项失败:`, result.reason);
                return items[index]; // 降级返回原始数据
            }
        });
    }

    // 删除 R2 图片
    async deleteImage(r2Key) {
        await this.init();

        if (!this.isAvailable()) {
            console.log('R2服务不可用');
            return false;
        }

        try {
            const { signature, timestamp, nonce } = this.generateSignature({
                type: 'delete',
                key: r2Key
            });

            const response = await fetch(`${this.workerUrl}/api/delete-image`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature': signature,
                    'X-Timestamp': timestamp,
                    'X-Nonce': nonce,
                    'Origin': window.location.origin
                },
                body: JSON.stringify({
                    key: r2Key
                })
            });

            const result = await response.json();
            return result.success;
        } catch (error) {
            console.error('删除 R2 图片失败:', error);
            return false;
        }
    }

    // 批量删除
    async batchDelete(r2Keys) {
        const results = await Promise.allSettled(
            r2Keys.map(key => this.deleteImage(key))
        );

        const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
        console.log(`批量删除完成: ${successCount}/${r2Keys.length} 成功`);

        return successCount;
    }

    // 检查是否为 R2 URL
    isR2Url(url) {
        if (!url || !this.workerUrl) return false;

        // 检查是否为 R2 域名
        return url.includes('r2.imagen.apiyi.com') ||
               url.includes('r2.apiyi.com') ||
               url.includes('r2-image.apiyi.com') ||
               url.includes(this.workerUrl);
    }

    // 从 URL 提取 R2 Key
    extractR2Key(url) {
        if (!this.isR2Url(url)) return null;

        try {
            const urlObj = new URL(url);
            // 提取路径部分作为 key
            // 例如: /flux/202501/xxx.jpg
            return urlObj.pathname.replace(/^\//, '');
        } catch (error) {
            console.error('提取 R2 Key 失败:', error);
            return null;
        }
    }

    // 获取图片元数据
    async getImageMetadata(url) {
        try {
            if (url.startsWith('data:image')) {
                // Base64 数据
                const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (base64Match) {
                    return {
                        type: 'base64',
                        mimeType: base64Match[1],
                        size: Math.round(base64Match[2].length * 0.75) // 估算大小
                    };
                }
            } else {
                // URL 数据
                return {
                    type: 'url',
                    url: url,
                    r2Key: this.extractR2Key(url),
                    isR2: this.isR2Url(url)
                };
            }
        } catch (error) {
            console.error('获取图片元数据失败:', error);
            return null;
        }
    }

    // 获取存储统计信息
    getStorageStats() {
        const stats = {
            enabled: this.isAvailable(),
            workerUrl: this.workerUrl,
            configSource: this.config ? 'cloud' : 'local',
            features: this.config?.features || {}
        };

        return stats;
    }
}

// 创建全局实例
window.r2Storage = new R2StorageService();

// TypeScript 类型声明（如果需要）
if (typeof window !== 'undefined') {
    window.r2Storage = window.r2Storage || new R2StorageService();
}