// API调用模块
class AIImageAPI {
    constructor() {
        // 可选的API站点配置（内置站点）
        const builtInSites = {
            'apiyi': {
                name: 'API易官方',
                baseURL: 'https://api.apiyi.com',
                description: '官方站点，稳定可靠',
                authType: 'bearer', // 使用 Authorization: Bearer
                isBuiltIn: true
            },
            'b-apiyi': {
                name: 'API易 B站',
                baseURL: 'https://b.apiyi.com',
                description: 'API易 B站端点',
                authType: 'bearer',
                isBuiltIn: true
            },
            'local': {
                name: '本地服务器',
                baseURL: 'http://45.8.22.95:666',
                description: '本地部署站点',
                authType: 'bearer',
                isBuiltIn: true
            },
            'antigravity': {
                name: 'Antigravity',
                baseURL: 'http://145.239.142.185:8000',
                description: 'Antigravity API 站点，Google原生格式',
                authType: 'bearer', // 使用 Authorization: Bearer（服务器要求）
                pathPrefix: '/antigravity', // 路径前缀
                defaultApiKey: '',
                isBuiltIn: true
            },
            'yunwu': {
                name: '云雾 API',
                baseURL: 'https://yunwu.ai',
                description: 'yunwu.ai 中转站点，支持多种模型',
                authType: 'bearer',
                defaultApiKey: '',
                isBuiltIn: true
            },
            'bolatu': {
                name: '柏拉图 API',
                baseURL: 'https://api.bltcy.ai',
                description: '柏拉图 API 站点，支持 Gemini 图片生成',
                authType: 'bearer',
                defaultApiKey: '',
                isBuiltIn: true
            }
        };
        
        // 加载用户自定义站点并合并到 apiSites
        this.customSites = this.loadCustomSites();
        this.apiSites = { ...builtInSites, ...this.customSites };
        
        // 默认配置（兼容旧版本）
        this.defaultBaseURL = 'https://b.apiyi.com/v1/chat/completions';
        this.defaultApiKey = null;

        // 获取用户选择的站点，默认使用 b-apiyi（对应原型的默认端点）
        this.currentSite = this.getStoredSite() || 'b-apiyi';
        this.siteBaseURL = this.apiSites[this.currentSite]?.baseURL || this.apiSites['b-apiyi'].baseURL;

        // 加载自定义配置（保留兼容性）
        this.useCustomConfig = this.getUseCustomConfig();
        this.customConfig = this.loadCustomConfig();

        // 根据配置模式设置当前使用的配置
        // 优先使用站点配置，其次使用自定义配置，最后使用默认配置
        if (this.useCustomConfig && this.customConfig.baseURL) {
            this.baseURL = this.customConfig.baseURL;
        } else {
            this.baseURL = this.siteBaseURL + '/v1/chat/completions';
        }
        
        // 获取当前站点的 API Key（用户存储的优先，否则用默认的）
        const storedKey = this.getStoredApiKey(this.currentSite);
        this.apiKey = storedKey || this.apiSites[this.currentSite]?.defaultApiKey || null;
        this.visionApiKey = this.getStoredVisionApiKey(this.currentSite); // 图像理解 API Key（按站点存储）
        this.userMarkedAccessible = this.loadUserMarkedAccessible(); // 用户标记为可访问的URL列表
        this.models = {
            'gemini-3-pro-image-preview': {
                name: '🍌 Nano Banana Pro',
                displayName: '60s，gemini-3-pro-image-preview 谷歌原生端点请求，支持多尺寸4K，$0.05/张🔥 官网1/5价格',
                time: '60s',           // 生成时间
                isNew: true,           // 标记为新模型
                baseURL: 'https://b.apiyi.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
                apiType: 'gemini-native',
                internalPrompt: '生成图片：',
                ratios: [
                    { key: 'auto', label: '自适应', description: '智能' },
                    { key: '1:1', label: '方形 1:1', description: '常用' },
                    { key: '16:9', label: '横版 16:9', description: '宽屏' },
                    { key: '9:16', label: '竖版 9:16', description: '竖屏' },
                    { key: '4:3', label: '横版 4:3', description: '标准' },
                    { key: '3:4', label: '竖版 3:4', description: '标准' },
                    { key: '3:2', label: '横版 3:2', description: '经典' },
                    { key: '2:3', label: '竖版 2:3', description: '经典' },
                    { key: '21:9', label: '影院 21:9', description: '超宽屏' },
                    { key: '5:4', label: '横版 5:4', description: '传统' },
                    { key: '4:5', label: '竖版 4:5', description: '社媒' }
                ],
                resolutions: [
                    { key: '1K', label: '1K 标准', description: '高效' },
                    { key: '2K', label: '2K 高清', description: '稍慢速度' },
                    { key: '4K', label: '4K 超清', description: '印刷所需' }
                ],
                defaultResolution: '1K',
                resolutionMap: {
                    '1:1': { '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
                    '2:3': { '1K': '848×1264', '2K': '1696×2528', '4K': '3392×5056' },
                    '3:2': { '1K': '1264×848', '2K': '2528×1696', '4K': '5056×3392' },
                    '3:4': { '1K': '896×1200', '2K': '1792×2400', '4K': '3584×4800' },
                    '4:3': { '1K': '1200×896', '2K': '2400×1792', '4K': '4800×3584' },
                    '4:5': { '1K': '928×1152', '2K': '1856×2304', '4K': '3712×4608' },
                    '5:4': { '1K': '1152×928', '2K': '2304×1856', '4K': '4608×3712' },
                    '9:16': { '1K': '768×1376', '2K': '1536×2752', '4K': '3072×5504' },
                    '16:9': { '1K': '1376×768', '2K': '2752×1536', '4K': '5504×3072' },
                    '21:9': { '1K': '1584×672', '2K': '3168×1344', '4K': '6336×2688' }
                },
                capabilities: {
                    multipleImages: false,   // 只能生成1张图片
                    customSize: true,        // 支持自定义尺寸
                    aspectRatioControl: true, // 支持改变原图比例
                    referenceImage: true,     // 支持参考图
                    imageEdit: true,          // 支持图片编辑
                    maxOutputs: 1,
                    resolutionControl: true  // 支持分辨率控制
                }
            },
            'gemini-2.5-flash-image': {
                name: '🍌 Nano Banana ',
                displayName: '15s，gemini-2.5-flash-image 谷歌原生端点请求，支持多宽高比，固定1K分辨率，$0.025/张',
                time: '15s',           // 生成时间
                isNew: false,          // 非新模型
                baseURL: 'https://b.apiyi.com/v1beta/models/gemini-2.5-flash-image:generateContent',
                apiType: 'gemini-native',
                internalPrompt: '生成图片：',
                ratios: [
                    { key: 'auto', label: '自适应', description: '智能' },
                    { key: '1:1', label: '方形 1:1', description: '常用' },
                    { key: '16:9', label: '横版 16:9', description: '宽屏' },
                    { key: '9:16', label: '竖版 9:16', description: '竖屏' },
                    { key: '4:3', label: '横版 4:3', description: '标准' },
                    { key: '3:4', label: '竖版 3:4', description: '标准' },
                    { key: '3:2', label: '横版 3:2', description: '经典' },
                    { key: '2:3', label: '竖版 2:3', description: '经典' },
                    { key: '21:9', label: '影院 21:9', description: '超宽屏' },
                    { key: '5:4', label: '横版 5:4', description: '传统' },
                    { key: '4:5', label: '竖版 4:5', description: '社媒' }
                ],
                capabilities: {
                    multipleImages: false,   // 只能生成1张图片
                    customSize: true,        // 支持自定义尺寸
                    aspectRatioControl: true, // 支持改变原图比例
                    referenceImage: true,     // 支持参考图
                    imageEdit: true,          // 支持图片编辑
                    maxOutputs: 1,
                    resolutionControl: false  // 不支持分辨率控制（固定1K）
                }
            },
            'seedream-4-5-251128': {
                name: 'SeeDream 4.5',
                displayName: '15s出图，即梦海外版seedream-4-5-251128，超清生图编辑，支持2K/4K分辨率，支持URL与Base64输出, $0.045/张',
                time: '15s',           // 生成时间
                isNew: true,           // 标记为新模型
                baseURL: 'https://b.apiyi.com/v1/images/generations',
                apiType: 'image-generation',
                sizeStrategy: 'seedream',
                ratios: [
                    { key: '1:1', label: '方形 1:1', description: '常用' },
                    { key: '4:3', label: '横版 4:3', description: '标准' },
                    { key: '3:4', label: '竖版 3:4', description: '标准' },
                    { key: '16:9', label: '横版 16:9', description: '宽屏' },
                    { key: '9:16', label: '竖版 9:16', description: '竖屏' },
                    { key: '3:2', label: '横版 3:2', description: '经典' },
                    { key: '2:3', label: '竖版 2:3', description: '经典' },
                    { key: '21:9', label: '影院 21:9', description: '超宽屏' }
                ],
                resolutions: [
                    { key: '2K', label: '2K 高清', description: '标准分辨率' },
                    { key: '4K', label: '4K 超清', description: '超高分辨率' }
                ],
                defaultResolution: '2K',
                resolutionMap: {
                    '1:1': { '2K': '2048×2048', '4K': '4096×4096' },
                    '4:3': { '2K': '2304×1728', '4K': '4608×3456' },
                    '3:4': { '2K': '1728×2304', '4K': '3456×4608' },
                    '16:9': { '2K': '2560×1440', '4K': '5120×2880' },
                    '9:16': { '2K': '1440×2560', '4K': '2880×5120' },
                    '3:2': { '2K': '2496×1664', '4K': '4992×3328' },
                    '2:3': { '2K': '1664×2496', '4K': '3328×4992' },
                    '21:9': { '2K': '3024×1296', '4K': '6048×2592' }
                },
                defaultParams: {
                    sequential_image_generation: 'disabled',
                    response_format: 'url',
                    size: '2K',
                    stream: false,
                    watermark: false
                },
                responseFormats: ['url', 'b64_json'],
                capabilities: {
                    multipleImages: true,
                    customSize: true,
                    referenceImage: true,
                    imageEdit: true,
                    maxOutputs: 2,
                    resolutionControl: true
                }
            },
            'sora_image': {
                name: 'Sora_image',
                displayName: '90s出图，Sora网页版出图， 同名 gpt-4o-image，价格最便宜~！$0.01/张【荐】',
                time: '90s',           // 生成时间
                isNew: false,          // 非新模型
                baseURL: 'https://b.apiyi.com/v1/chat/completions',
                capabilities: {
                    multipleImages: true,
                    customSize: true
                }
            },
            'flux-kontext-pro': {
                name: 'Flux Kontext Pro',
                displayName: '15s出图，flux-kontext-pro，只支持英文提示词，高质量图片生成，$0.035/张',
                time: '15s',           // 生成时间
                isNew: false,          // 非新模型
                baseURL: 'https://b.apiyi.com/v1/images/generations',
                editURL: 'https://b.apiyi.com/v1/images/edits',
                apiType: 'flux-kontext',
                ratios: [
                    { key: '1:1', label: '方形 1:1', description: '1024×1024' },
                    { key: '2:3', label: '竖版 2:3', description: '832×1248' },
                    { key: '3:2', label: '横版 3:2', description: '1248×832' },
                    { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
                    { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
                    { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
                    { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
                ],
                defaultParams: {
                    response_format: 'url',
                    safety_tolerance: 6  // 最宽松的内容审核级别
                },
                responseFormats: ['url', 'b64_json'],
                capabilities: {
                    multipleImages: false,
                    customSize: true,
                    referenceImage: true,
                    imageEdit: true,
                    maxOutputs: 1,
                    useExtraBody: true
                }
            },
            'flux-kontext-max': {
                name: 'Flux Kontext Max',
                displayName: '15s出图，flux-kontext-max，提示词支持中文，超高质量图片编辑。$0.07/张',
                time: '15s',           // 生成时间
                isNew: false,          // 非新模型
                baseURL: 'https://b.apiyi.com/v1/images/generations',
                editURL: 'https://b.apiyi.com/v1/images/edits',
                apiType: 'flux-kontext',
                ratios: [
                    { key: '1:1', label: '方形 1:1', description: '1024×1024' },
                    { key: '2:3', label: '竖版 2:3', description: '832×1248' },
                    { key: '3:2', label: '横版 3:2', description: '1248×832' },
                    { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
                    { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
                    { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
                    { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
                ],
                defaultParams: {
                    response_format: 'url',
                    safety_tolerance: 6  // 最宽松的内容审核级别
                },
                responseFormats: ['url', 'b64_json'],
                capabilities: {
                    multipleImages: false,
                    customSize: true,
                    referenceImage: true,
                    imageEdit: true,
                    maxOutputs: 1,
                    useExtraBody: true
                }
            }
        };
        this.model = this.getStoredModel() || 'gemini-3-pro-image-preview';

        // 根据配置模式选择使用的 baseURL（考虑自定义配置优先级）
        const defaultModelURL = this.models[this.model].baseURL;
        if (this.useCustomConfig && this.customConfig.modelURLs && this.customConfig.modelURLs[this.model]) {
            // 优先使用模型专属的自定义 URL
            this.baseURL = this.customConfig.modelURLs[this.model];
        } else if (this.useCustomConfig && this.customConfig.baseURL) {
            // 其次使用全局自定义 URL
            this.baseURL = this.customConfig.baseURL;
        } else {
            // 最后使用默认 URL
            this.baseURL = defaultModelURL;
        }

        // 请求配置
        this.requestTimeout = 300000; // 默认300秒超时
        this.maxRetries = 1; // 图片生成不重试，只允许网络层重试一次
        this.baseRetryDelay = 2000; // 基础重试延迟2秒

        // 调试日志：显示当前配置
        console.log('🔧 API 配置初始化:');
        console.log('  - 配置模式:', this.useCustomConfig ? '自定义配置' : '默认配置');
        if (this.useCustomConfig) {
            console.log('  - 自定义根域名:', this.customConfig.rootDomain || '(未设置)');
            console.log('  - 自定义 API Key:', this.customConfig.apiKey ? `${this.customConfig.apiKey.substring(0, 10)}...` : '(未设置)');
        }
        console.log('  - 当前模型:', this.model);
        console.log('  - 当前 Base URL:', this.baseURL);
        console.log('  - API Key 已设置:', this.apiKey ? '是' : '否');
    }

    // 获取存储的API Key（支持站点参数）
    getStoredApiKey(siteKey = null) {
        try {
            // 如果使用自定义配置且自定义 API Key 存在，则优先使用
            if (this.useCustomConfig && this.customConfig && this.customConfig.apiKey) {
                return this.customConfig.apiKey;
            }

            // 使用站点特定的存储
            const site = siteKey || this.currentSite;
            const storageKey = `ai_image_api_key_${site}`;
            const encrypted = localStorage.getItem(storageKey);
            return encrypted ? this.decrypt(encrypted) : null;
        } catch (error) {
            console.error('获取API Key失败:', error);
            return null;
        }
    }

    // 获取存储的站点
    getStoredSite() {
        try {
            return localStorage.getItem('ai_image_site') || 'b-apiyi';
        } catch (error) {
            console.error('获取站点失败:', error);
            return 'b-apiyi';
        }
    }

    // 保存站点选择
    saveSite(siteKey) {
        try {
            if (this.apiSites[siteKey]) {
                localStorage.setItem('ai_image_site', siteKey);
                this.currentSite = siteKey;
                this.siteBaseURL = this.apiSites[siteKey].baseURL;
                this.baseURL = this.siteBaseURL + '/v1/chat/completions';
                
                // 切换站点后加载该站点的 API Key
                const storedKey = this.getStoredApiKey(siteKey);
                this.apiKey = storedKey || this.apiSites[siteKey]?.defaultApiKey || null;
                
                // 切换站点后加载该站点的图像理解 API Key
                this.visionApiKey = this.getStoredVisionApiKey(siteKey);
                
                console.log(`[站点切换] 已切换到: ${this.apiSites[siteKey].name} (${this.siteBaseURL}), API Key: ${this.apiKey ? '已设置' : '未设置'}, Vision API Key: ${this.visionApiKey ? '已设置' : '未设置'}`);
                return true;
            }
            return false;
        } catch (error) {
            console.error('保存站点失败:', error);
            return false;
        }
    }

    // 获取所有可用站点
    getAllSites() {
        return this.apiSites;
    }

    // 获取内置站点（不含自定义）
    getBuiltInSites() {
        return {
            'apiyi': {
                name: 'API易官方',
                baseURL: 'https://api.apiyi.com',
                description: '官方站点，稳定可靠',
                authType: 'bearer',
                isBuiltIn: true
            },
            'b-apiyi': {
                name: 'API易 B站',
                baseURL: 'https://b.apiyi.com',
                description: 'API易 B站端点',
                authType: 'bearer',
                isBuiltIn: true
            },
            'local': {
                name: '本地服务器',
                baseURL: 'http://45.8.22.95:666',
                description: '本地部署站点',
                authType: 'bearer',
                isBuiltIn: true
            },
            'antigravity': {
                name: 'Antigravity',
                baseURL: 'http://145.239.142.185:8000',
                description: 'Antigravity API 站点，Google原生格式',
                authType: 'bearer',
                pathPrefix: '/antigravity',
                defaultApiKey: '',
                isBuiltIn: true
            },
            'yunwu': {
                name: '云雾 API',
                baseURL: 'https://yunwu.ai',
                description: 'yunwu.ai 中转站点，支持多种模型',
                authType: 'bearer',
                defaultApiKey: '',
                isBuiltIn: true
            },
            'bolatu': {
                name: '柏拉图 API',
                baseURL: 'https://api.bltcy.ai',
                description: '柏拉图 API 站点，支持 Gemini 图片生成',
                authType: 'bearer',
                defaultApiKey: '',
                isBuiltIn: true
            }
        };
    }

    // 加载用户自定义站点
    loadCustomSites() {
        try {
            const stored = localStorage.getItem('ai_image_custom_sites');
            return stored ? JSON.parse(stored) : {};
        } catch (error) {
            console.error('加载自定义站点失败:', error);
            return {};
        }
    }

    // 保存用户自定义站点
    saveCustomSites(sites) {
        try {
            localStorage.setItem('ai_image_custom_sites', JSON.stringify(sites));
            this.customSites = sites;
            // 重新合并站点
            this.apiSites = { ...this.getBuiltInSites(), ...sites };
            return true;
        } catch (error) {
            console.error('保存自定义站点失败:', error);
            return false;
        }
    }

    // 添加自定义站点
    addCustomSite(key, config) {
        if (!key || !config.name || !config.baseURL) {
            console.error('自定义站点配置不完整');
            return false;
        }
        
        // 检查是否与内置站点冲突
        if (this.getBuiltInSites()[key]) {
            console.error('站点 key 与内置站点冲突');
            return false;
        }
        
        const newSite = {
            name: config.name,
            baseURL: config.baseURL,
            description: config.description || '用户自定义站点',
            authType: config.authType || 'bearer',
            pathPrefix: config.pathPrefix || '',
            defaultApiKey: config.defaultApiKey || '',
            isBuiltIn: false,
            isCustom: true
        };
        
        const updatedSites = { ...this.customSites, [key]: newSite };
        return this.saveCustomSites(updatedSites);
    }

    // 更新自定义站点
    updateCustomSite(key, config) {
        if (!this.customSites[key]) {
            console.error('站点不存在或非自定义站点');
            return false;
        }
        
        const updatedSite = { ...this.customSites[key], ...config, isCustom: true };
        const updatedSites = { ...this.customSites, [key]: updatedSite };
        return this.saveCustomSites(updatedSites);
    }

    // 删除自定义站点
    removeCustomSite(key) {
        if (!this.customSites[key]) {
            console.error('站点不存在或非自定义站点');
            return false;
        }
        
        const { [key]: removed, ...remaining } = this.customSites;
        
        // 如果删除的是当前站点，切换到默认站点
        if (this.currentSite === key) {
            this.saveSite('b-apiyi');
        }
        
        return this.saveCustomSites(remaining);
    }

    // 检查站点是否为自定义站点
    isCustomSite(key) {
        return this.customSites && this.customSites[key] !== undefined;
    }

    // 获取当前站点信息
    getCurrentSite() {
        return {
            key: this.currentSite,
            ...this.apiSites[this.currentSite]
        };
    }

    // 获取完整的请求URL（将相对路径转换为完整URL）
    getFullURL(relativePath) {
        if (!relativePath) return this.siteBaseURL;
        if (relativePath.startsWith('http')) {
            return relativePath; // 已是完整URL，直接返回
        }
        // 检查当前站点是否有路径前缀
        const currentSiteConfig = this.apiSites[this.currentSite];
        const pathPrefix = currentSiteConfig?.pathPrefix || '';
        return this.siteBaseURL + pathPrefix + relativePath;
    }

    // 获取认证头（根据站点配置返回不同格式）
    getAuthHeaders() {
        const currentSiteConfig = this.apiSites[this.currentSite];
        const authType = currentSiteConfig?.authType || 'bearer';
        // 优先使用用户设置的 apiKey，如果没有则使用站点默认 apiKey
        let apiKey = this.apiKey || currentSiteConfig?.defaultApiKey;
        
        // 安全检查：确保 API Key 只包含 ASCII 字符（HTTP headers 要求）
        if (apiKey && !/^[\x00-\x7F]*$/.test(apiKey)) {
            console.warn('API Key 包含非 ASCII 字符，使用默认 Key');
            apiKey = currentSiteConfig?.defaultApiKey || '';
        }
        
        if (authType === 'x-goog-api-key') {
            return {
                'X-Goog-Api-Key': `Bearer ${apiKey}`
            };
        }
        // 默认使用 Authorization: Bearer
        return {
            'Authorization': `Bearer ${apiKey}`
        };
    }

    // 获取请求 URL（考虑站点配置和自定义根域名配置）
    getRequestUrl(modelConfig) {
        let url = modelConfig.baseURL;

        // 如果 baseURL 是相对路径，使用站点 URL 构建完整 URL
        if (url && !url.startsWith('http')) {
            url = this.getFullURL(url);
        } else if (url && url.startsWith('http')) {
            // 如果是完整 URL，提取路径部分，然后根据当前站点重新构建
            try {
                const urlObj = new URL(url);
                const path = urlObj.pathname;
                // 使用当前站点构建新 URL
                url = this.getFullURL(path);
            } catch (e) {
                // 如果解析失败，保持原 URL
                console.warn('URL 解析失败，使用原 URL:', url);
            }
        }

        // 如果启用自定义配置且配置了根域名，替换域名部分
        if (this.useCustomConfig && this.customConfig && this.customConfig.rootDomain) {
            try {
                const urlObj = new URL(url);
                const customDomainObj = new URL(this.customConfig.rootDomain);
                // 替换协议和域名，保持路径不变
                urlObj.protocol = customDomainObj.protocol;
                urlObj.host = customDomainObj.host;
                const replacedUrl = urlObj.toString();
                console.log(`🔄 URL 替换: ${url} → ${replacedUrl}`);
                return replacedUrl;
            } catch (e) {
                console.error('❌ URL 替换失败:', e);
                console.log('   原始 URL:', url);
                console.log('   自定义根域名:', this.customConfig.rootDomain);
            }
        }

        // 使用默认 URL
        return url;
    }

    // 保存API Key（支持站点参数）
    saveApiKey(apiKey, siteKey = null) {
        try {
            const site = siteKey || this.currentSite;
            const storageKey = `ai_image_api_key_${site}`;
            
            if (apiKey) {
                const encrypted = this.encrypt(apiKey);
                localStorage.setItem(storageKey, encrypted);
                this.apiKey = apiKey;
            } else {
                // 空值则清除该站点的 Key
                localStorage.removeItem(storageKey);
                // 使用默认 Key（如果有）
                this.apiKey = this.apiSites[site]?.defaultApiKey || null;
            }
            return true;
        } catch (error) {
            console.error('保存API Key失败:', error);
            return false;
        }
    }

    // 获取存储的模型
    getStoredModel() {
        try {
            return localStorage.getItem('ai_image_model') || 'gemini-3-pro-image-preview';
        } catch (error) {
            console.error('获取存储的模型失败:', error);
            return 'gemini-3-pro-image-preview';
        }
    }

    // 保存模型选择
    saveModel(modelName) {
        try {
            if (this.models[modelName]) {
                localStorage.setItem('ai_image_model', modelName);
                this.model = modelName;

                // 根据配置模式选择使用的 baseURL
                const defaultBaseURL = this.models[modelName].baseURL;
                if (this.useCustomConfig && this.customConfig.modelURLs && this.customConfig.modelURLs[modelName]) {
                    this.baseURL = this.customConfig.modelURLs[modelName];
                } else {
                    this.baseURL = defaultBaseURL;
                }

                return true;
            }
            return false;
        } catch (error) {
            console.error('保存模型失败:', error);
            return false;
        }
    }

    // 获取当前模型信息
    getCurrentModel() {
        return this.models[this.model] || this.models['gemini-3-pro-image-preview'];
    }

    // 根据模型和分辨率获取超时时间
    getModelTimeout(resolution = null) {
        const modelKey = this.model?.toLowerCase() || '';

        // Gemini 模型：根据分辨率动态调整超时时间
        if (modelKey.includes('gemini')) {
            if (resolution === '4K') {
                return 1200000; // 20分钟 - 4K 高清生成
            }
            if (resolution === '2K') {
                return 600000; // 10分钟 - 2K 标准
            }
            if (resolution === '1K') {
                return 360000; // 6分钟 - 1K 快速
            }
            return 600000; // 未指定分辨率，默认 10分钟
        }

        // sora_image 模型：600秒
        if (modelKey.includes('sora')) {
            return 600000; // 600秒 = 10分钟
        }

        // Seedream 和其他模型：300秒
        return 300000; // 300秒 = 5分钟
    }

    // 获取所有可用模型
    getAllModels() {
        return this.models;
    }

    // 获取模型的翻译后显示名称
    getModelDisplayName(modelKey) {
        const model = this.models[modelKey];
        if (!model) return modelKey;

        // 尝试从 i18n 获取翻译
        if (typeof i18n !== 'undefined' && i18n.t) {
            const translatedName = i18n.t(`models.${modelKey}.displayName`);
            // 如果找到了翻译且不是返回的键名本身，使用翻译
            if (translatedName && !translatedName.startsWith('models.')) {
                return translatedName;
            }
        }

        // 降级：返回原始 displayName
        return model.displayName || model.name;
    }

    isImageGenerationModel(modelConfig) {
        return modelConfig && (modelConfig.apiType === 'image-generation' || modelConfig.apiType === 'flux-kontext' || modelConfig.apiType === 'gemini-native');
    }

    getActualImageCount(requestedCount, capabilities = {}) {
        if (!capabilities.multipleImages) {
            return 1;
        }
        const maxOutputs = capabilities.maxOutputs ? Number(capabilities.maxOutputs) : null;
        const safeRequested = Number(requestedCount) || 1;
        if (maxOutputs && maxOutputs > 0) {
            return Math.min(safeRequested, maxOutputs);
        }
        return safeRequested;
    }

    getImageGenerationSize(modelConfig, ratio = '1:1', resolution = null) {
        if (!modelConfig) return null;

        // 优先使用 resolutionMap（支持多分辨率模型，如 Nano Banana Pro 和 SeeDream 4.5）
        if (modelConfig.resolutionMap) {
            const normalizedRatio = ratio || '1:1';
            const useResolution = resolution || modelConfig.defaultResolution || '2K';

            // 从 resolutionMap 获取分辨率（格式：'2048×2048'）
            const sizeValue = modelConfig.resolutionMap[normalizedRatio]?.[useResolution];

            if (sizeValue) {
                // 转换格式：'2048×2048' -> '2048x2048' (用于 API)
                return sizeValue.replace(/×/g, 'x');
            }

            // 回退到默认值
            const defaultSize = modelConfig.resolutionMap['1:1']?.[useResolution];
            if (defaultSize) {
                return defaultSize.replace(/×/g, 'x');
            }
        }

        // Seedream 旧版兼容（如果没有 resolutionMap 但有 sizeStrategy）
        if (modelConfig.sizeStrategy === 'seedream') {
            const normalizedRatio = ratio || '1:1';
            const useResolution = resolution || modelConfig.defaultResolution || '2K';

            const ratioMap2K = {
                '1:1': '2048x2048',
                '4:3': '2304x1728',
                '3:4': '1728x2304',
                '16:9': '2560x1440',
                '9:16': '1440x2560',
                '3:2': '2496x1664',
                '2:3': '1664x2496',
                '21:9': '3024x1296'
            };

            const ratioMap4K = {
                '1:1': '4096x4096',
                '4:3': '4608x3456',
                '3:4': '3456x4608',
                '16:9': '5120x2880',
                '9:16': '2880x5120',
                '3:2': '4992x3328',
                '2:3': '3328x4992',
                '21:9': '6048x2592'
            };

            const ratioMap = useResolution === '4K' ? ratioMap4K : ratioMap2K;
            return ratioMap[normalizedRatio] || ratioMap['1:1'];
        }

        if (modelConfig.defaultParams && modelConfig.defaultParams.size) {
            return modelConfig.defaultParams.size;
        }

        return null;
    }

    normalizeImageSource(source, fallbackMime = 'image/jpeg') {
        if (!source) {
            return null;
        }

        const defaultMime = (fallbackMime || 'image/jpeg').toLowerCase();

        if (typeof source === 'string') {
            const trimmed = source.trim();
            if (!trimmed) {
                return null;
            }
            if (/^https?:\/\//i.test(trimmed)) {
                return trimmed;
            }
            if (trimmed.toLowerCase().startsWith('data:image/')) {
                return trimmed;
            }
            return `data:${defaultMime};base64,${trimmed}`;
        }

        if (typeof source === 'object') {
            if (source.dataUrl) {
                return this.normalizeImageSource(source.dataUrl, source.mimeType || defaultMime);
            }
            if (source.url) {
                return this.normalizeImageSource(source.url, source.mimeType || defaultMime);
            }
            if (source.base64) {
                const mime = (source.mimeType || defaultMime || 'image/jpeg').toLowerCase();
                const base64 = source.base64.trim();
                if (base64.toLowerCase().startsWith('data:image/')) {
                    return base64;
                }
                return `data:${mime};base64,${base64}`;
            }
        }

        return null;
    }

    buildImageGenerationPayload({ modelConfig, prompt, ratio = '1:1', n = 1, referenceImages = [], imageBase64 = null, resolution = null }) {
        // 特殊处理 gemini-native 模型（Google 原生格式）
        if (modelConfig && modelConfig.apiType === 'gemini-native') {
            const parts = [{ text: prompt }];
            
            // 添加参考图或编辑图
            if (imageBase64) {
                // 图片编辑模式：单张图片
                const normalized = this.normalizeImageSource(imageBase64);
                if (normalized && normalized.startsWith('data:image/')) {
                    // 提取 base64 数据和 MIME 类型
                    const match = normalized.match(/^data:(image\/[^;]+);base64,(.+)$/);
                    if (match) {
                        parts.push({
                            inline_data: {
                                mime_type: match[1],
                                data: match[2]
                            }
                        });
                    }
                }
            } else if (referenceImages && referenceImages.length > 0) {
                // 参考图模式：可能有多张图
                referenceImages.forEach(item => {
                    const normalized = this.normalizeImageSource(item, item?.mimeType);
                    if (normalized && normalized.startsWith('data:image/')) {
                        const match = normalized.match(/^data:(image\/[^;]+);base64,(.+)$/);
                        if (match) {
                            parts.push({
                                inline_data: {
                                    mime_type: match[1],
                                    data: match[2]
                                }
                            });
                        }
                    }
                });
            }

            const imageConfig = {};

            // 只有非自适应模式才传递 aspectRatio
            if (ratio && ratio !== 'auto') {
                imageConfig.aspectRatio = ratio;
            }

            // 只有支持分辨率控制的 gemini-native 模型才传递 imageSize 参数
            if (modelConfig.capabilities?.resolutionControl && resolution) {
                imageConfig.imageSize = resolution;  // 使用正确的驼峰命名
                console.log(`🎨 [API] 设置分辨率: imageSize=${resolution}`);
            }
            // gemini-2.5-flash-image 的 resolutionControl 为 false
            // 不传 imageSize，自适应模式下也不传 aspectRatio
            // 这样 imageConfig 为空对象 {}，API 会自动根据参考图比例输出

            const payload = {
                contents: [{
                    role: 'user',
                    parts
                }],
                generationConfig: {
                    responseModalities: ["IMAGE"],
                    imageConfig: imageConfig
                }
            };

            return {
                __isGeminiNative: true,
                payload
            };
        }

        // 特殊处理 flux-kontext 模型
        if (modelConfig && modelConfig.apiType === 'flux-kontext') {
            // 检查是否有图片输入（需要使用multipart/form-data）
            const hasImages = (referenceImages && referenceImages.length > 0) || imageBase64;

            if (hasImages) {
                // 有图片时返回特殊标记，表示需要用FormData
                return {
                    __isFluxKontextWithImage: true,
                    model: this.model,
                    prompt,
                    ratio,
                    referenceImages,
                    imageBase64
                };
            } else {
                // 纯文本生成使用JSON格式
                const payload = {
                    model: this.model,
                    prompt,
                    n: 1
                };

                // 添加 extra_body 传递 aspect_ratio 和其他参数
                if (modelConfig.capabilities && modelConfig.capabilities.useExtraBody) {
                    payload.extra_body = {
                        aspect_ratio: ratio
                    };

                    // 如果有默认参数（如safety_tolerance），也添加到extra_body
                    if (modelConfig.defaultParams) {
                        payload.extra_body = {
                            ...payload.extra_body,
                            ...modelConfig.defaultParams
                        };
                    }
                }

                return payload;
            }
        }

        // 原有逻辑保持不变
        const payload = {
            model: this.model,
            prompt,
            n,
        };

        if (modelConfig && modelConfig.defaultParams) {
            Object.assign(payload, modelConfig.defaultParams);
        }

        const sizeValue = this.getImageGenerationSize(modelConfig, ratio, resolution);
        if (sizeValue) {
            payload.size = sizeValue;
        }

        const sources = [];

        if (referenceImages && referenceImages.length > 0) {
            referenceImages.forEach(item => {
                const normalized = this.normalizeImageSource(item, item?.mimeType);
                if (normalized && !sources.includes(normalized)) {
                    sources.push(normalized);
                }
            });
        }

        if (imageBase64) {
            const normalized = this.normalizeImageSource(imageBase64);
            if (normalized && !sources.includes(normalized)) {
                sources.push(normalized);
            }
        }

        if (sources.length > 0) {
            if (sources.length === 1) {
                payload.image = sources[0];
            } else {
                payload.image = sources;
                payload.image_list = sources;
                // 保持兼容，部分服务可能读取 images 字段
                payload.images = sources;
            }
        }

        return payload;
    }

    // 构建flux-kontext的FormData请求
    async buildFluxKontextFormData(payload) {
        console.log('🔧 构建Flux Kontext FormData请求');
        console.log('📋 原始payload:', {
            model: payload.model,
            prompt: payload.prompt?.substring(0, 50) + '...',
            ratio: payload.ratio,
            n: payload.n,
            referenceImagesCount: payload.referenceImages?.length || 0,
            hasImageBase64: !!payload.imageBase64
        });

        const formData = new FormData();

        // 添加基本参数
        formData.append('model', payload.model);
        formData.append('prompt', payload.prompt);

        // 添加aspect_ratio
        if (payload.ratio) {
            formData.append('aspect_ratio', payload.ratio);
        }

        // 添加safety_tolerance参数（固定为6，最宽松）
        formData.append('safety_tolerance', '6');

        // 添加生成数量参数（如果有）
        if (payload.n) {
            formData.append('n', payload.n.toString());
        }

        // 处理图片 - 根据API错误信息，使用 image 字段
        const imageSources = [];

        // 优先使用referenceImages（多张参考图）
        if (payload.referenceImages && payload.referenceImages.length > 0) {
            imageSources.push(...payload.referenceImages);
            console.log(`📸 使用referenceImages，共${payload.referenceImages.length}张图片`);
        }
        // 如果没有referenceImages，使用imageBase64（单张图）
        else if (payload.imageBase64) {
            imageSources.push(payload.imageBase64);
            console.log('📸 使用imageBase64，单张图片');
        }

        console.log(`📊 准备处理${imageSources.length}张图片`);
        imageSources.forEach((img, index) => {
            if (typeof img === 'object' && img.fileName) {
                console.log(`📷 图片${index + 1}: ${img.fileName} (${img.fileSize} bytes)`);
            } else {
                console.log(`📷 图片${index + 1}: ${typeof img}`);
            }
        });

        // 处理图片：Flux模型目前仅支持单张图片
        if (imageSources.length > 0) {
            const imageSource = imageSources[0]; // 只使用第一张图片
            console.log(`\n🔄 处理图片: ${imageSources.length > 1 ? `共${imageSources.length}张，仅使用第一张` : '单张图片'}`);

            try {
                let blob = null;

                // 从不同类型的图片源创建 Blob
                if (typeof imageSource === 'object' && imageSource.base64) {
                    console.log(`📝 处理对象类型图片: ${imageSource.fileName}`);

                    // 从对象中提取 base64 并转换为 Blob
                    const base64String = imageSource.base64;
                    const mimeType = imageSource.mimeType || 'image/jpeg';

                    // 创建完整的 data URL
                    let dataUrl;
                    if (base64String.startsWith('data:')) {
                        dataUrl = base64String;
                    } else {
                        dataUrl = `data:${mimeType};base64,${base64String}`;
                    }

                    // 转换为 Blob
                    const response = await fetch(dataUrl);
                    blob = await response.blob();

                    console.log(`✅ 图片Blob创建成功:`, {
                        fileName: imageSource.fileName,
                        blobSize: blob.size,
                        blobType: blob.type
                    });
                } else if (typeof imageSource === 'string') {
                    console.log(`📝 处理字符串类型图片`);
                    // 字符串类型，使用现有的转换方法
                    blob = await this.convertImageSourceToBlob(imageSource);
                    console.log(`✅ 字符串图片转换完成，大小: ${blob?.size || 0}`);
                } else {
                    console.error(`❌ 图片类型不支持:`, typeof imageSource, imageSource);
                }

                if (blob && blob.size > 0) {
                    // 使用 'image' 字段名
                    formData.append('image', blob, 'image.jpg');
                    console.log(`✅ 图片已添加到FormData:`, {
                        fieldName: 'image',
                        blobSize: blob.size,
                        blobType: blob.type
                    });
                } else {
                    console.error(`❌ 无法创建有效的Blob对象:`, blob);
                }
            } catch (error) {
                console.error(`❌ 处理图片失败:`, error);
            }
        }

        return formData;
    }

    // 构建flux-kontext的JSON请求体（处理extra_body）
    buildFluxKontextJsonPayload(payload) {
        if (payload.extra_body) {
            // 对于flux-kontext，extra_body中的参数需要提升到顶层
            const finalPayload = {
                model: payload.model,
                prompt: payload.prompt,
                n: payload.n || 1,
                ...payload.extra_body  // 将extra_body的内容展开到顶层
            };

            console.log('构建flux-kontext JSON payload:', finalPayload);
            return JSON.stringify(finalPayload);
        } else {
            return JSON.stringify(payload);
        }
    }

    // 将图片源转换为Blob
    async convertImageSourceToBlob(imageSource) {
        try {
            // 标准化图片源
            const normalized = this.normalizeImageSource(imageSource);
            if (!normalized) {
                throw new Error('无法标准化图片源');
            }

            if (normalized.startsWith('data:image/')) {
                // Data URL转Blob
                const response = await fetch(normalized);
                return await response.blob();
            } else if (normalized.startsWith('http')) {
                // URL转Blob
                const response = await fetch(normalized, { mode: 'cors' });
                return await response.blob();
            } else {
                throw new Error('不支持的图片格式');
            }
        } catch (error) {
            console.error('转换图片为Blob失败:', error);
            throw error;
        }
    }

    // 将Blob转换为Base64字符串
    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // 简单加密（实际项目中应该使用更安全的方法）
    encrypt(text) {
        return btoa(text);
    }

    // 简单解密
    decrypt(encrypted) {
        return atob(encrypted);
    }

    // ========== 图像理解 API Key 管理 ==========

    /**
     * 保存图像理解 API Key（按站点存储）
     * @param {String} apiKey - API Key
     * @param {String} siteKey - 站点键（可选，默认使用当前站点）
     */
    saveVisionApiKey(apiKey, siteKey = null) {
        try {
            const site = siteKey || this.currentSite;
            const storageKey = `ai_image_vision_api_key_${site}`;
            
            if (apiKey) {
                // 保存 API Key
                const encrypted = this.encrypt(apiKey);
                localStorage.setItem(storageKey, encrypted);
                // 如果保存的是当前站点的 Key，更新运行时值
                if (site === this.currentSite) {
                    this.visionApiKey = apiKey;
                }
                console.log(`✅ 图像理解 API Key 已保存 (站点: ${site})`);
            } else {
                // 清除 API Key
                localStorage.removeItem(storageKey);
                // 如果清除的是当前站点的 Key，清空运行时值
                if (site === this.currentSite) {
                    this.visionApiKey = null;
                }
                console.log(`✅ 图像理解 API Key 已清除 (站点: ${site})`);
            }
            return true;
        } catch (error) {
            console.error('❌ 保存图像理解 API Key 失败:', error);
            return false;
        }
    }

    /**
     * 获取存储的图像理解 API Key（按站点）
     * @param {String} siteKey - 站点键（可选，默认使用当前站点）
     */
    getStoredVisionApiKey(siteKey = null) {
        try {
            const site = siteKey || this.currentSite;
            const storageKey = `ai_image_vision_api_key_${site}`;
            const encrypted = localStorage.getItem(storageKey);
            if (encrypted) {
                return this.decrypt(encrypted);
            }
            return null;
        } catch (error) {
            console.error('❌ 读取图像理解 API Key 失败:', error);
            return null;
        }
    }

    /**
     * 检查图像理解 API Key 是否已设置
     */
    hasVisionApiKey() {
        return !!this.visionApiKey;
    }

    // ========== 图像理解 API 调用 ==========

    /**
     * 分析图片（支持多图联合分析）
     * @param {Array} images - 图片数组，每个元素包含 {base64, fileName, mimeType}
     * @param {String} prompt - 用户提示词
     * @param {String} model - 模型名称
     * @returns {Promise<String>} 分析结果文本
     */
    async analyzeImages(images, prompt, model, maxTokens = null) {
        if (!this.visionApiKey) {
            throw new Error('请先设置图像理解 API Key');
        }

        if (!images || images.length === 0) {
            throw new Error('请至少上传一张图片');
        }

        // 判断是否设置 maxTokens
        const useMaxTokens = (typeof maxTokens === 'number' && maxTokens > 0);

        // 调试日志：显示当前 API 配置
        console.log('🔍 开始图像理解分析:', {
            model,
            imageCount: images.length,
            promptLength: prompt.length,
            maxTokens: useMaxTokens ? maxTokens : '使用模型默认',
            currentSite: this.currentSite,
            siteBaseURL: this.siteBaseURL,
            visionApiKeySet: !!this.visionApiKey,
            visionApiKeyPrefix: this.visionApiKey ? this.visionApiKey.substring(0, 10) + '...' : 'null'
        });

        // 构造 OpenAI 兼容格式的请求
        const content = [
            {
                type: 'text',
                text: prompt
            }
        ];

        // 添加所有图片
        for (const image of images) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`
                }
            });
        }

        const requestBody = {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: content
                }
            ],
            temperature: 0.7
        };

        // 只有明确传入 maxTokens 时才设置（避免影响推理模型）
        if (useMaxTokens) {
            requestBody.max_tokens = maxTokens;
        }

        try {
            const apiUrl = `${this.siteBaseURL}/v1/chat/completions`;
            console.log('🔗 图像理解 API 请求 URL:', apiUrl);
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.visionApiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    errorData.error?.message ||
                    `API 请求失败: ${response.status} ${response.statusText}`
                );
            }

            const data = await response.json();

            // 解析响应
            if (data.choices && data.choices.length > 0) {
                const result = data.choices[0].message.content;
                console.log('✅ 图像理解分析成功');
                return result;
            } else {
                throw new Error('API 返回了空结果');
            }

        } catch (error) {
            console.error('❌ 图像理解分析失败:', error);
            throw error;
        }
    }

    /**
     * 分析图片（流式输出版本）
     * @param {Array} images - 图片数组，每个包含 {base64, mimeType, compressed}
     * @param {String} prompt - 用户提示词
     * @param {String} model - 模型名称
     * @param {Number} maxTokens - 最大输出 tokens 数量（可选，不设置则使用模型默认）
     * @param {Function} onChunk - 流式回调函数，接收每个文本片段
     * @param {Function} onComplete - 完成回调
     * @param {Function} onError - 错误回调
     */
    async analyzeImagesStream(images, prompt, model, maxTokens, onChunk, onComplete, onError) {
        if (!this.visionApiKey) {
            const error = new Error('请先设置图像理解 API Key');
            if (onError) onError(error);
            throw error;
        }

        if (!images || images.length === 0) {
            const error = new Error('请至少上传一张图片');
            if (onError) onError(error);
            throw error;
        }

        // 判断是否设置 maxTokens
        const useMaxTokens = (typeof maxTokens === 'number' && maxTokens > 0);

        // 调试日志：显示当前 API 配置
        console.log('🔍 开始图像理解分析 (流式输出):', {
            model,
            imageCount: images.length,
            promptLength: prompt.length,
            maxTokens: useMaxTokens ? maxTokens : '使用模型默认',
            currentSite: this.currentSite,
            siteBaseURL: this.siteBaseURL,
            visionApiKeySet: !!this.visionApiKey,
            visionApiKeyPrefix: this.visionApiKey ? this.visionApiKey.substring(0, 10) + '...' : 'null'
        });

        // 构造 OpenAI 兼容格式的请求
        const content = [
            {
                type: 'text',
                text: prompt
            }
        ];

        // 添加所有图片
        for (const image of images) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`
                }
            });
        }

        const requestBody = {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: content
                }
            ],
            temperature: 0.7,
            stream: true  // 关键：启用流式输出
        };

        // 只有明确传入 maxTokens 时才设置（避免影响推理模型）
        if (useMaxTokens) {
            requestBody.max_tokens = maxTokens;
        }

        try {
            const apiUrl = `${this.siteBaseURL}/v1/chat/completions`;
            console.log('🔗 图像理解流式 API 请求 URL:', apiUrl);
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.visionApiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const error = new Error(
                    errorData.error?.message ||
                    `API 请求失败: ${response.status} ${response.statusText}`
                );
                if (onError) onError(error);
                throw error;
            }

            // 使用 ReadableStream 读取流式数据
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';  // 缓冲区，处理不完整的数据块
            let jsonLogCount = 0;  // JSON 结构日志计数器

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    console.log('✅ 流式输出完成');
                    if (onComplete) onComplete();
                    break;
                }

                // 解码数据块
                buffer += decoder.decode(value, { stream: true });

                // 按行分割（SSE 格式是按行传输的）
                const lines = buffer.split('\n');

                // 保留最后一行（可能不完整），其他行处理
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();

                    // SSE 格式: "data: {...}"
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);  // 移除 "data: " 前缀

                        // OpenAI 流式输出结束标记
                        if (data === '[DONE]') {
                            console.log('📌 收到结束标记 [DONE]');
                            continue;
                        }

                        try {
                            const json = JSON.parse(data);

                            // 【调试】输出完整 JSON 结构（仅前几次）
                            if (jsonLogCount < 3) {
                                console.log(`🔍 SSE JSON 结构 #${jsonLogCount + 1}:`, json);
                                jsonLogCount++;
                            }

                            // 提取内容片段 - 尝试多种可能的字段路径
                            let content = json.choices?.[0]?.delta?.content;  // OpenAI 标准格式

                            // 如果标准格式没有，尝试其他可能的格式
                            if (!content) {
                                content = json.choices?.[0]?.message?.content;  // 非流式格式
                            }
                            if (!content) {
                                content = json.delta?.content;  // 简化格式
                            }
                            if (!content) {
                                content = json.content;  // 最简格式
                            }

                            const finishReason = json.choices?.[0]?.finish_reason || json.finish_reason;

                            if (finishReason) {
                                console.log(`🏁 finish_reason: ${finishReason}`);
                            }

                            if (content && onChunk) {
                                console.log(`📨 收到 chunk: "${content.substring(0, 50)}..." (长度: ${content.length})`);
                                onChunk(content);  // 回调处理每个片段
                            }
                            // 空 content 是 SSE 流式输出的正常情况（初始化/结束标记），无需警告
                        } catch (parseError) {
                            // 忽略解析错误（某些行可能不是 JSON）
                            console.warn('解析 SSE 数据失败:', parseError, '原始数据:', data.substring(0, 100));
                        }
                    }
                }
            }

        } catch (error) {
            console.error('❌ 图像理解分析失败 (流式):', error);
            if (onError) onError(error);
            throw error;
        }
    }

    // ========== 自定义配置管理 ==========

    // 获取是否使用自定义配置
    getUseCustomConfig() {
        try {
            const value = localStorage.getItem('ai_image_use_custom_config');
            return value === 'true';
        } catch (error) {
            console.error('获取配置模式失败:', error);
            return false;
        }
    }

    // 设置是否使用自定义配置
    setUseCustomConfig(useCustom) {
        try {
            localStorage.setItem('ai_image_use_custom_config', useCustom ? 'true' : 'false');
            this.useCustomConfig = useCustom;

            // 更新当前使用的 API Key 和 baseURL
            this.apiKey = this.getStoredApiKey();
            if (this.model && this.models[this.model]) {
                const defaultBaseURL = this.models[this.model].baseURL;
                if (useCustom && this.customConfig.modelURLs && this.customConfig.modelURLs[this.model]) {
                    this.baseURL = this.customConfig.modelURLs[this.model];
                } else {
                    this.baseURL = defaultBaseURL;
                }
            }

            return true;
        } catch (error) {
            console.error('设置配置模式失败:', error);
            return false;
        }
    }

    // 加载自定义配置
    loadCustomConfig() {
        try {
            const config = {
                rootDomain: localStorage.getItem('ai_image_custom_root_domain') || '',
                apiKey: localStorage.getItem('ai_image_custom_api_key') || ''
            };

            return config;
        } catch (error) {
            console.error('加载自定义配置失败:', error);
            return { rootDomain: '', apiKey: '' };
        }
    }

    // 保存自定义配置
    saveCustomConfig(config) {
        try {
            if (config.rootDomain !== undefined) {
                localStorage.setItem('ai_image_custom_root_domain', config.rootDomain);
            }
            if (config.apiKey !== undefined) {
                localStorage.setItem('ai_image_custom_api_key', config.apiKey);
            }

            // 重新加载配置
            this.customConfig = this.loadCustomConfig();

            // 如果当前正在使用自定义配置，更新运行时的值
            if (this.useCustomConfig) {
                if (config.apiKey !== undefined) {
                    this.apiKey = config.apiKey;
                }
            }

            return true;
        } catch (error) {
            console.error('保存自定义配置失败:', error);
            return false;
        }
    }

    // ========== 自定义配置管理结束 ==========

    // 测试API连接
    async testConnection() {
        if (!this.apiKey) {
            throw new Error('API Key未设置');
        }

        try {
            const currentModel = this.getCurrentModel();
            const requestUrl = this.getRequestUrl(currentModel);
            let payload;

            if (this.isImageGenerationModel(currentModel)) {
                payload = this.buildImageGenerationPayload({
                    modelConfig: currentModel,
                    prompt: 'Test connection',
                    ratio: '1:1',
                    n: 1
                });
            } else {
                payload = {
                    model: this.model,
                    messages: [{
                        role: 'user',
                        content: '测试连接'
                    }]
                };
            }

            const response = await this.requestWithRetry(requestUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            return { success: true, data };
        } catch (error) {
            throw new Error(`连接测试失败: ${error.message}`);
        }
    }

    // 生成图片
    async generateImage(prompt, ratio = '1:1', n = 1, resolution = null) {
        if (!this.apiKey) {
            throw new Error('请先设置API Key');
        }

        // 记录开始时间
        const startTime = Date.now();

        // 打印当前模型的超时设置
        const timeout = this.getModelTimeout(resolution);
        console.log(`[${this.model}] ${resolution ? `分辨率: ${resolution}, ` : ''}请求超时时间: ${timeout/1000}秒`);

        // 检查当前模型能力
        const currentModel = this.getCurrentModel();
        const capabilities = currentModel.capabilities || { multipleImages: true, customSize: true };

        // 根据模型能力调整参数
        const actualN = this.getActualImageCount(n, capabilities);
        const fullPrompt = this.preparePrompt(prompt, ratio);

        // 如果没有提供分辨率且模型支持分辨率控制，使用默认分辨率
        if (!resolution && currentModel.capabilities?.resolutionControl && currentModel.defaultResolution) {
            resolution = currentModel.defaultResolution;
        }

        // 根据模型类型选择正确的URL
        let requestUrl = this.getRequestUrl(currentModel);

        try {
            let payload;
            let requestBody;
            let headers = {
                'Authorization': `Bearer ${this.apiKey}`
            };

            if (this.isImageGenerationModel(currentModel) || currentModel.apiType === 'flux-kontext') {
                payload = this.buildImageGenerationPayload({
                    modelConfig: currentModel,
                    prompt: fullPrompt,
                    ratio,
                    n: actualN,
                    resolution
                });

                // 检查是否为 gemini-native 请求
                if (payload.__isGeminiNative) {
                    headers['Content-Type'] = 'application/json';
                    requestBody = JSON.stringify(payload.payload);
                    console.log(`[${this.model}] 📤 Gemini Native 请求 payload:`, {
                        imageConfig: payload.payload?.generationConfig?.imageConfig,
                        hasAspectRatio: !!payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        aspectRatio: payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        resolution: payload.payload?.generationConfig?.imageConfig?.image_size,
                        fullPayload: JSON.stringify(payload.payload, null, 2)
                    });
                }
                // 检查是否为flux-kontext的图片请求
                else if (payload.__isFluxKontextWithImage) {
                    // 使用FormData
                    requestBody = await this.buildFluxKontextFormData(payload);
                    // 不设置Content-Type，让浏览器自动设置multipart/form-data
                } else {
                    // 使用JSON，但需要特殊处理flux-kontext的extra_body
                    headers['Content-Type'] = 'application/json';
                    requestBody = this.buildFluxKontextJsonPayload(payload);
                }
            } else {
                payload = {
                    model: this.model,
                    messages: [{
                        role: 'user',
                        content: fullPrompt
                    }]
                };

                if (actualN > 1) {
                    payload.n = actualN;
                }

                headers['Content-Type'] = 'application/json';
                requestBody = JSON.stringify(payload);
            }

            const response = await this.requestWithRetry(requestUrl, {
                method: 'POST',
                headers: headers,
                body: requestBody
            }, this.maxRetries, timeout);

            const data = await response.json();
            const result = await this.processImageResponse(data, currentModel);

            // 添加生成时间
            result.generationTime = Date.now() - startTime;

            return result;
        } catch (error) {
            // 创建增强的错误信息
            const enhancedError = new Error(`图片生成失败: ${error.message}`);
            enhancedError.detailedError = error.detailedError;
            enhancedError.originalError = error;
            enhancedError.operation = 'generateImage';
            enhancedError.parameters = { prompt, ratio, n: actualN };
            throw enhancedError;
        }
    }

    // 基于参考图生成图片 (垫图功能) - 支持多张参考图
    async generateImageWithReference(prompt, referenceImages, ratio = '1:1', n = 1, resolution = null) {
        if (!this.apiKey) {
            throw new Error('请先设置API Key');
        }

        if (!referenceImages || referenceImages.length === 0) {
            throw new Error('参考图片不能为空');
        }

        // 记录开始时间
        const startTime = Date.now();

        // 检查当前模型能力
        const currentModel = this.getCurrentModel();
        const capabilities = currentModel.capabilities || { multipleImages: true, customSize: true };

        // 根据模型能力调整参数
        const actualN = this.getActualImageCount(n, capabilities);
        const fullPrompt = this.preparePrompt(prompt, ratio);

        // 如果没有提供分辨率且模型支持分辨率控制，使用默认分辨率
        if (!resolution && currentModel.capabilities?.resolutionControl && currentModel.defaultResolution) {
            resolution = currentModel.defaultResolution;
        }

        // 打印当前模型的超时设置
        const timeout = this.getModelTimeout(resolution);
        console.log(`[${this.model}] ${resolution ? `分辨率: ${resolution}, ` : ''}请求超时时间: ${timeout/1000}秒`);

        // 根据模型类型选择正确的URL
        // flux-kontext 模型有图片输入时使用编辑端点
        let baseUrlToUse = (currentModel.apiType === 'flux-kontext' && currentModel.editURL)
            ? currentModel.editURL
            : currentModel.baseURL;

        // 创建临时配置对象用于 URL 替换
        const tempModelConfig = { ...currentModel, baseURL: baseUrlToUse };
        let requestUrl = this.getRequestUrl(tempModelConfig);

        try {
            let payload;
            let requestBody;
            let headers = {
                'Authorization': `Bearer ${this.apiKey}`
            };

            if (this.isImageGenerationModel(currentModel) || currentModel.apiType === 'flux-kontext') {
                payload = this.buildImageGenerationPayload({
                    modelConfig: currentModel,
                    prompt: fullPrompt,
                    ratio,
                    n: actualN,
                    referenceImages,
                    resolution
                });

                // 只有 flux-kontext 模型才显示相关日志
                if (currentModel.apiType === 'flux-kontext') {
                    console.log('🎯 generateImageWithReference - 检查Flux-Kontext图片请求:', payload.__isFluxKontextWithImage);
                    console.log('📷 referenceImages数量:', referenceImages?.length || 0);
                }

                // 检查是否为 gemini-native 请求
                if (payload.__isGeminiNative) {
                    headers['Content-Type'] = 'application/json';
                    requestBody = JSON.stringify(payload.payload);
                    console.log(`[${this.model}] 📤 Gemini Native 请求 payload:`, {
                        imageConfig: payload.payload?.generationConfig?.imageConfig,
                        hasAspectRatio: !!payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        aspectRatio: payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        resolution: payload.payload?.generationConfig?.imageConfig?.image_size,
                        fullPayload: JSON.stringify(payload.payload, null, 2)
                    });
                }
                // 检查是否为flux-kontext的图片请求
                else if (payload.__isFluxKontextWithImage) {
                    console.log('📤 generateImageWithReference - 使用FormData方式发送Flux请求');
                    // 使用FormData
                    requestBody = await this.buildFluxKontextFormData(payload);
                    console.log('✅ generateImageWithReference - FormData构建完成，准备发送请求');
                    // 不设置Content-Type，让浏览器自动设置multipart/form-data
                } else {
                    // 对于非 Flux 模型，只是简单使用 JSON
                    if (currentModel.apiType === 'flux-kontext') {
                        console.log('📤 generateImageWithReference - 使用JSON方式发送Flux请求');
                        requestBody = this.buildFluxKontextJsonPayload(payload);
                    } else {
                        console.log(`📤 [${this.model}] generateImageWithReference - 使用JSON方式发送请求`);
                        requestBody = JSON.stringify(payload);
                    }
                    headers['Content-Type'] = 'application/json';
                }
            } else {
                // 构建内容数组，包含文本和多张参考图
                const contentArray = [
                    {
                        type: 'text',
                        text: `参考下面的${referenceImages.length}张图片，${fullPrompt}`
                    }
                ];

                // 添加每张参考图
            referenceImages.forEach((imageData, index) => {
                const normalized = this.normalizeImageSource(imageData, imageData?.mimeType);
                console.log(`[${this.model}] 参考图${index + 1} normalized:`, normalized?.substring(0, 100));
                if (!normalized) {
                    console.warn(`[${this.model}] 参考图${index + 1} 无法标准化，跳过`);
                    return;
                }
                contentArray.push({
                    type: 'image_url',
                    image_url: {
                        url: normalized
                    }
                });
            });

                payload = {
                    model: this.model,
                    messages: [{
                        role: 'user',
                        content: contentArray
                    }]
                };

                if (actualN > 1) {
                    payload.n = actualN;
                }

                headers['Content-Type'] = 'application/json';
                requestBody = JSON.stringify(payload);
            }

            const response = await this.requestWithRetry(requestUrl, {
                method: 'POST',
                headers: headers,
                body: requestBody
            }, this.maxRetries, timeout);

            const data = await response.json();

            // 添加详细日志用于调试参考图生成
            console.log(`[${this.model}] generateImageWithReference响应:`, {
                status: response.status,
                model: this.model,
                hasChoices: !!data.choices,
                choicesLength: data.choices?.length,
                firstChoiceContent: data.choices?.[0]?.message?.content?.substring(0, 200)
            });

            const result = await this.processImageResponse(data, currentModel);

            // 添加生成时间
            result.generationTime = Date.now() - startTime;

            return result;
        } catch (error) {
            // 创建增强的错误信息
            const enhancedError = new Error(`参考图生成失败: ${error.message}`);
            enhancedError.detailedError = error.detailedError;
            enhancedError.originalError = error;
            enhancedError.operation = 'generateImageWithReference';
            enhancedError.parameters = { prompt, ratio, n: actualN, referenceImageCount: referenceImages.length };
            throw enhancedError;
        }
    }

    // 编辑图片
    async editImage(imageBase64, prompt, ratio = '1:1', n = 1) {
        if (!this.apiKey) {
            throw new Error('请先设置API Key');
        }

        if (!imageBase64) {
            throw new Error('原始图片不能为空');
        }

        // 检查当前模型能力
        const currentModel = this.getCurrentModel();
        const capabilities = currentModel.capabilities || { multipleImages: true, customSize: true };

        // 根据模型能力调整参数
        const actualN = this.getActualImageCount(n, capabilities);
        const fullPrompt = this.preparePrompt(prompt, ratio);

        // 根据模型类型选择正确的URL
        // flux-kontext 模型有图片输入时使用编辑端点
        let baseUrlToUse = (currentModel.apiType === 'flux-kontext' && currentModel.editURL)
            ? currentModel.editURL
            : currentModel.baseURL;

        // 创建临时配置对象用于 URL 替换
        const tempModelConfig = { ...currentModel, baseURL: baseUrlToUse };
        let requestUrl = this.getRequestUrl(tempModelConfig);

        try{
            let payload;
            let requestBody;
            let headers = {
                'Authorization': `Bearer ${this.apiKey}`
            };

            if (this.isImageGenerationModel(currentModel) || currentModel.apiType === 'flux-kontext') {
                payload = this.buildImageGenerationPayload({
                    modelConfig: currentModel,
                    prompt: fullPrompt,
                    ratio,
                    n: actualN,
                    imageBase64
                });

                // 检查是否为 gemini-native 请求
                if (payload.__isGeminiNative) {
                    headers['Content-Type'] = 'application/json';
                    requestBody = JSON.stringify(payload.payload);
                    console.log(`[${this.model}] 📤 Gemini Native 请求 payload:`, {
                        imageConfig: payload.payload?.generationConfig?.imageConfig,
                        hasAspectRatio: !!payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        aspectRatio: payload.payload?.generationConfig?.imageConfig?.aspectRatio,
                        resolution: payload.payload?.generationConfig?.imageConfig?.image_size,
                        fullPayload: JSON.stringify(payload.payload, null, 2)
                    });
                }
                // 检查是否为flux-kontext的图片请求
                else if (payload.__isFluxKontextWithImage) {
                    // 使用FormData
                    requestBody = await this.buildFluxKontextFormData(payload);
                    // 不设置Content-Type，让浏览器自动设置multipart/form-data
                } else {
                    // 使用JSON，但需要特殊处理flux-kontext的extra_body
                    headers['Content-Type'] = 'application/json';
                    requestBody = this.buildFluxKontextJsonPayload(payload);
                }
            } else {
                payload = {
                    model: this.model,
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `请基于下面的图片，${fullPrompt}`
                            },
                        {
                            type: 'image_url',
                            image_url: {
                                url: this.normalizeImageSource({ base64: imageBase64 })
                            }
                        }
                        ]
                    }]
                };

                if (actualN > 1) {
                    payload.n = actualN;
                }

                headers['Content-Type'] = 'application/json';
                requestBody = JSON.stringify(payload);
            }

            const response = await this.requestWithRetry(requestUrl, {
                method: 'POST',
                headers: headers,
                body: requestBody
            });

            const data = await response.json();
            return await this.processImageResponse(data, currentModel);
        } catch (error) {
            // 创建增强的错误信息
            const enhancedError = new Error(`图片编辑失败: ${error.message}`);
            enhancedError.detailedError = error.detailedError;
            enhancedError.originalError = error;
            enhancedError.operation = 'editImage';
            enhancedError.parameters = { prompt, ratio, n: actualN };
            throw enhancedError;
        }
    }

    // 计算Gemini模型的智能输出尺寸
    calculateGeminiOutputSize(width, height) {
        const maxPixels = 1024 * 1024; // 最大像素数 1024×1024
        const aspectRatio = width / height;
        
        // 如果原图已经在限制范围内，直接返回
        if (width * height <= maxPixels) {
            return { width, height };
        }
        
        // 计算在最大像素限制下的最佳尺寸
        let newWidth, newHeight;
        if (aspectRatio >= 1) {
            // 横图或方图：以高度为基准计算
            newHeight = Math.sqrt(maxPixels / aspectRatio);
            newWidth = newHeight * aspectRatio;
        } else {
            // 竖图：以宽度为基准计算
            newWidth = Math.sqrt(maxPixels * aspectRatio);
            newHeight = newWidth / aspectRatio;
        }
        
        return {
            width: Math.round(newWidth),
            height: Math.round(newHeight)
        };
    }

    // 预处理提示词：添加内置提示词和尺寸比例
    preparePrompt(prompt, ratio) {
        const currentModel = this.getCurrentModel();
        let finalPrompt = prompt;

        // 1. gemini-native 模型特殊处理
        if (currentModel.apiType === 'gemini-native') {
            // 如果有内置提示词，添加它
            if (currentModel.internalPrompt) {
                finalPrompt = currentModel.internalPrompt + finalPrompt;
            }
            // gemini-native 通过 generationConfig 传递比例，不在 prompt 中添加
            return finalPrompt;
        }

        // 2. 其他模型：添加内置提示词（如果有）
        if (currentModel.internalPrompt) {
            finalPrompt = currentModel.internalPrompt + finalPrompt;
            // Nano Banana等模型有内置提示词，不需要添加比例
            return finalPrompt;
        }

        // 3. flux-kontext 模型通过 extra_body 传递比例，不在 prompt 中添加
        if (currentModel.apiType === 'flux-kontext') {
            return finalPrompt;
        }

        // 4. 其他模型添加尺寸比例
        finalPrompt = this.addRatio(finalPrompt, ratio);

        return finalPrompt;
    }

    // 添加尺寸比例到提示词
    addRatio(prompt, ratio) {
        // 检查当前模型是否支持自定义尺寸
        const currentModel = this.getCurrentModel();
        const capabilities = currentModel.capabilities || { customSize: true };
        
        if (!capabilities.customSize) {
            // 不支持自定义尺寸的模型，直接返回原prompt
            return prompt;
        }
        
        // 检查是否已经有尺寸标记
        if (/【\d+:\d+】$/.test(prompt)) {
            return prompt;
        }
        
        // 验证比例格式
        if (!['1:1', '2:3', '3:2'].includes(ratio)) {
            ratio = '1:1';
        }
        
        return `${prompt}【${ratio}】`;
    }

    // 处理图片响应
    async processImageResponse(data, modelConfig = this.getCurrentModel()) {
        const isImageGeneration = this.isImageGenerationModel(modelConfig) || (Array.isArray(data?.data) && data.data.length > 0);
        // 检查是否是 gemini-native 格式响应
        const isGeminiNative = modelConfig && modelConfig.apiType === 'gemini-native';
        // 检查是否是返回Base64的模型（Nano Banana预览版）
        const isGeminiBase64Model = !isImageGeneration && !isGeminiNative && (
            this.model === 'gemini-2.5-flash-image-preview' ||
            this.model === 'gemini-2.0-flash-image-preview'
        );
        let allUrls = [];
        let fullContent = '';

        if (isGeminiNative) {
            // 处理 Google 原生格式响应
            console.log(`[${this.model}] 开始处理 Gemini Native 格式响应`);
            console.log(`[${this.model}] API 原始响应结构:`, {
                hasCandidates: !!data.candidates,
                candidatesLength: data.candidates?.length || 0,
                candidatesTokenCount: data.usageMetadata?.candidatesTokenCount,
                topLevelKeys: Object.keys(data),
                fullResponse: JSON.stringify(data, null, 2)
            });
            
            // 检查 candidatesTokenCount 是否为 0 - 这是谷歌拒绝出图的明确指标
            if (data.usageMetadata && data.usageMetadata.candidatesTokenCount === 0) {
                console.error(`[${this.model}] ❌ 检测到 candidatesTokenCount 为 0，谷歌拒绝出图`);
                console.error(`[${this.model}] 完整响应数据:`, JSON.stringify(data, null, 2));
                
                const error = new Error('当前输入的提示词或图片谷歌拒绝出图，请修改后重试');
                error.responseData = data;
                error.isGoogleRejection = true; // 标记为谷歌拒绝
                error.detailedError = {
                    status: 200,
                    statusText: 'OK',
                    url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                    method: 'POST',
                    errorData: data,
                    rawResponse: JSON.stringify(data, null, 2),
                    attempt: 1,
                    maxRetries: 1,
                    timestamp: new Date().toISOString(),
                    operation: 'processImageResponse',
                    candidatesTokenCount: 0
                };
                throw error;
            }
            
            if (!data.candidates || !data.candidates.length) {
                console.error(`[${this.model}] ❌ 错误：未找到 candidates 数组或数组为空`);
                console.error(`[${this.model}] 完整响应数据:`, JSON.stringify(data, null, 2));
                
                // 检查是否有 promptFeedback 或其他有用信息
                let errorMessage = 'API 返回数据中 candidates 为空';
                if (data.promptFeedback) {
                    errorMessage += '，但包含 promptFeedback 信息';
                }
                
                const error = new Error(errorMessage);
                error.responseData = data;
                error.detailedError = {
                    status: 200,
                    statusText: 'OK',
                    url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                    method: 'POST',
                    errorData: data,
                    rawResponse: JSON.stringify(data, null, 2), // 完整响应
                    attempt: 1,
                    maxRetries: 1,
                    timestamp: new Date().toISOString(),
                    operation: 'processImageResponse'
                };
                throw error;
            }

            const candidate = data.candidates[0];
            console.log(`[${this.model}] candidates[0] 结构:`, {
                hasContent: !!candidate.content,
                hasParts: !!candidate.content?.parts,
                partsLength: candidate.content?.parts?.length || 0,
                candidateKeys: Object.keys(candidate),
                contentKeys: candidate.content ? Object.keys(candidate.content) : []
            });
            
            if (!candidate.content || !candidate.content.parts) {
                console.error(`[${this.model}] ❌ 错误：candidate.content 或 candidate.content.parts 不存在`);
                console.error(`[${this.model}] candidate 完整数据:`, JSON.stringify(candidate, null, 2));
                
                // 通用的 finishReason 处理（适用于所有拒绝场景）
                if (candidate.finishReason && candidate.finishReason !== 'STOP') {
                    const error = new Error(`API 拒绝处理：${candidate.finishReason}`);
                    error.hasFinishReason = true; // 标记为有 finishReason 的错误
                    error.finishReason = candidate.finishReason;
                    error.candidateData = candidate; // 保存完整的 candidate 数据
                    error.responseData = data;
                    // 创建详细错误信息
                    error.detailedError = {
                        status: 200,
                        statusText: 'OK',
                        url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                        method: 'POST',
                        errorData: data,
                        rawResponse: JSON.stringify(data, null, 2),
                        candidateStructure: JSON.stringify(candidate, null, 2), // 单独保存 candidate 结构
                        attempt: 1,
                        maxRetries: 1,
                        timestamp: new Date().toISOString(),
                        operation: 'processImageResponse'
                    };
                    throw error;
                }
                
                const error = new Error('API响应格式错误：未找到图片数据');
                error.responseData = data;
                error.detailedError = {
                    status: 200,
                    statusText: 'OK',
                    url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                    method: 'POST',
                    errorData: data,
                    rawResponse: JSON.stringify(data, null, 2),
                    attempt: 1,
                    maxRetries: 1,
                    timestamp: new Date().toISOString(),
                    operation: 'processImageResponse'
                };
                throw error;
            }

            console.log(`[${this.model}] candidates[0].content.parts 数量: ${candidate.content.parts.length}`);
            
            // 提取图片数据和文本响应（兼容多种格式）
            let apiTextResponses = []; // 收集 API 返回的文本响应
            
            for (const part of candidate.content.parts) {
                const hasThoughtSignature = !!part.thoughtSignature;
                
                console.log(`[${this.model}] 检查 part 结构:`, {
                    hasInlineData: !!part.inlineData,
                    hasText: !!part.text,
                    hasThoughtSignature: hasThoughtSignature,
                    textValue: part.text ? part.text.substring(0, 50) : null,
                    allKeys: Object.keys(part)
                });
                
                // 先收集文本响应（包括可能的拒绝信息）- 即使有 thoughtSignature 也要收集
                if (part.text && typeof part.text === 'string' && !part.text.startsWith('data:image/')) {
                    apiTextResponses.push(part.text);
                    console.log(`[${this.model}] 📝 收集到文本响应:`, part.text.substring(0, 100));
                }
                
                // 如果只有 thoughtSignature 和 text（没有图片数据），跳过后续的图片检查
                if (hasThoughtSignature && part.text && !part.inlineData) {
                    console.log(`[${this.model}] ⏭️ 跳过包含 thoughtSignature 的 part 的图片检查，继续检查其他 parts`);
                    continue;
                }
                
                // 格式1: Google 官方格式 - part.inlineData.data
                if (part.inlineData && part.inlineData.data) {
                    const mimeType = part.inlineData.mimeType || 'image/jpeg';
                    const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
                    allUrls.push(dataUrl);
                    console.log(`[${this.model}] 检测到 Google 官方格式图片数据`);
                }
                // 格式2: 后端 API 转换格式 - data URI 作为属性名
                else {
                    // 检查 part.text 是否包含完整的 data URI
                    if (part.text && typeof part.text === 'string' && part.text.startsWith('data:image/')) {
                        allUrls.push(part.text);
                        console.log(`[${this.model}] 从 text 字段提取到 data URI`);
                    }
                    
                    // 遍历 part 对象的所有属性，查找 data URI 作为键名的情况
                    for (const key in part) {
                        if (typeof key === 'string' && key.startsWith('data:image/')) {
                            // 找到了以 data:image/ 开头的属性名，这就是图片数据
                            allUrls.push(key);
                            console.log(`[${this.model}] 从属性名提取到 data URI，长度: ${key.length}`);
                            break; // 找到一个就够了
                        }
                    }
                }
            }

            console.log(`[${this.model}] Gemini Native 格式处理完成，共提取 ${allUrls.length} 个图片，${apiTextResponses.length} 个文本响应`);
            
            if (allUrls.length === 0) {
                console.error(`[${this.model}] ❌ 警告：未能从任何 part 中提取到图片数据`);
                console.error(`[${this.model}] 所有 parts 详细信息:`, JSON.stringify(candidate.content.parts, null, 2));
                if (apiTextResponses.length > 0) {
                    console.warn(`[${this.model}] ⚠️ 但收集到 ${apiTextResponses.length} 个文本响应:`, apiTextResponses);
                }
            } else {
                console.log(`[${this.model}] ✅ 成功提取图片，URLs 长度:`, allUrls.map(url => url.length));
            }
            
            fullContent = JSON.stringify(data, null, 2);
        } else if (isImageGeneration) {
            const generationItems = Array.isArray(data?.data) ? data.data : [];
            generationItems.forEach(item => {
                if (item.url) {
                    allUrls.push(item.url);
                }
                if (item.b64_json) {
                    const dataUrl = `data:image/jpeg;base64,${item.b64_json}`;
                    allUrls.push(dataUrl);
                }
            });
            fullContent = JSON.stringify(generationItems, null, 2);
        } else {
            if (!data.choices || !data.choices.length) {
                const error = new Error('API响应格式错误：未找到有效的图片生成结果');
                error.responseData = data;
                error.detailedError = {
                    status: 200,
                    statusText: 'OK',
                    url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                    method: 'POST',
                    errorData: data,
                    rawResponse: JSON.stringify(data, null, 2),
                    attempt: 1,
                    maxRetries: 1,
                    timestamp: new Date().toISOString(),
                    operation: 'processImageResponse'
                };
                throw error;
            }

            if (isGeminiBase64Model) {
                // Gemini Base64 模型特殊处理：从 Base64 数据创建图片URL
                const content = data.choices[0]?.message?.content;
                if (content) {
                    fullContent = content;
                    console.log(`[${this.model}] 正在处理Base64响应，内容长度: ${content.length}`);
                    console.log(`[${this.model}] 内容前100字符:`, content.substring(0, 100));
                    console.log(`[${this.model}] 内容后100字符:`, content.substring(content.length - 100));

                    const base64Urls = this.extractBase64Images(content);
                    console.log(`[${this.model}] 提取到 ${base64Urls.length} 个Base64图片`);
                    allUrls.push(...base64Urls);
                }
            } else {
                // 其他模型：处理URL格式响应
                // 处理多个choices的情况（n>1时可能出现）
                for (let i = 0; i < data.choices.length; i++) {
                    const choice = data.choices[i];
                    if (choice.message && choice.message.content) {
                        const urls = this.extractImageUrls(choice.message.content);
                        allUrls.push(...urls);
                    }
                }
                
                // 获取完整内容
                fullContent = data.choices.map(choice => choice.message?.content).join('\n\n');
                
                // 如果没有找到任何URL，尝试从第一个choice提取
                if (allUrls.length === 0 && data.choices[0] && data.choices[0].message) {
                    const content = data.choices[0].message.content;
                    allUrls = this.extractImageUrls(content);
                }
            }
        }

        // 检查是否找到了图片数据
        if (allUrls.length === 0) {
            console.error(`[${this.model}] ❌ 最终检查：未找到任何图片数据`);
            console.error(`[${this.model}] 模型类型:`, {
                isGeminiNative,
                isImageGeneration,
                isGeminiBase64Model,
                apiType: modelConfig?.apiType
            });
            console.error(`[${this.model}] 完整响应数据:`, JSON.stringify(data, null, 2));
            
            // 没有找到图片数据，创建包含完整原始响应的详细错误
            const detailedError = {
                status: 200,
                statusText: 'OK',
                url: (modelConfig && modelConfig.baseURL) || this.baseURL,
                method: 'POST',
                errorData: data,
                rawResponse: JSON.stringify(data, null, 2), // 完整的原始JSON响应
                attempt: 1,
                maxRetries: 1,
                timestamp: new Date().toISOString(),
                operation: 'processImageResponse'
            };
            
            // 从 Gemini Native 格式中提取文本响应（如果有）
            let apiTextResponses = [];
            if (isGeminiNative && data.candidates && data.candidates[0]?.content?.parts) {
                for (const part of data.candidates[0].content.parts) {
                    if (part.text && typeof part.text === 'string' && !part.text.startsWith('data:image/') && !part.thoughtSignature) {
                        apiTextResponses.push(part.text);
                    }
                }
            }
            
            // 如果有文本响应，优先使用文本内容作为错误消息
            let errorMessage;
            if (apiTextResponses && apiTextResponses.length > 0) {
                // 使用 API 返回的文本作为主要错误消息
                const textContent = apiTextResponses.join('\n');
                errorMessage = `${textContent}`;
                console.log(`[${this.model}] 📝 使用 API 返回的文本作为错误消息`);
            } else {
                // 兜底：通用错误消息
                errorMessage = `API返回成功但未找到图片数据。响应内容长度: ${fullContent.length} 字符。可能原因：1) 提示词被拒绝 2) 内容违规 3) 模型返回格式异常。请检查完整响应内容。`;
            }
            
            const error = new Error(errorMessage);
            error.detailedError = detailedError;
            error.apiTextResponses = apiTextResponses; // 附加文本响应信息
            error.isGeminiNative = isGeminiNative; // 标记是否为 Gemini Native 格式
            error.hasApiTextResponse = apiTextResponses && apiTextResponses.length > 0; // 标记是否有文本响应
            throw error;
        }
        
        // 异步上传到 R2（不阻塞图片显示）
        if (window.r2Storage) {
            // 立即开始异步上传，但不等待结果
            this.asyncUploadToR2(allUrls, modelConfig).catch(error => {
                console.warn('后台 R2 上传失败:', error);
            });
        }

        // 检测图片URL的可访问性（异步，不阻塞主流程）
        // 只对外网域名进行检测，避免对正常图片的误判
        const shouldCheckUrls = allUrls.filter(url => this.shouldCheckAccessibility(url));

        if (shouldCheckUrls.length > 0) {
            const urlAccessibilityPromises = shouldCheckUrls.map(url => this.checkUrlAccessibility(url));
            Promise.allSettled(urlAccessibilityPromises).then(results => {
                const inaccessibleUrls = results
                    .map((result, index) => result.status === 'rejected' ? shouldCheckUrls[index] : null)
                    .filter(url => url !== null);
                
                if (inaccessibleUrls.length > 0) {
                    console.warn('检测到可能无法访问的图片URL:', inaccessibleUrls);
                    // 触发网络受限提示事件
                    window.dispatchEvent(new CustomEvent('networkRestrictedImages', {
                        detail: {
                            inaccessibleUrls,
                            allUrls,
                            accessibleUrls: allUrls.filter(url => !inaccessibleUrls.includes(url)),
                            content: fullContent,
                            suggestions: [
                                '检查网络连接是否正常',
                                '尝试使用VPN或代理服务',
                                '复制图片地址到浏览器直接访问',
                                '如图片可正常打开，可点击"标记为可访问"',
                                '联系技术支持获取国内镜像地址'
                            ]
                        }
                    }));
                }
            });
        }

        // flux-kontext 模型自动缓存图片到本地
        if (modelConfig && modelConfig.apiType === 'flux-kontext' && allUrls.length > 0) {
            this.cacheFluxKontextImages(allUrls).then(cachedUrls => {
                if (cachedUrls.length > 0) {
                    console.log(`已缓存 ${cachedUrls.length} 张 flux-kontext 图片到本地`);

                    // 显示缓存成功提示
                    if (this.app && this.app.showToast) {
                        this.app.showToast(`已自动缓存 ${cachedUrls.length} 张图片到本地，历史记录可长期查看`, 'success', 3000);
                    }

                    // 触发缓存完成事件，更新历史记录
                    window.dispatchEvent(new CustomEvent('fluxImagesCached', {
                        detail: {
                            originalUrls: allUrls,
                            cachedUrls: cachedUrls
                        }
                    }));
                } else {
                    // 缓存失败提示
                    if (this.app && this.app.showToast) {
                        this.app.showToast('图片链接10分钟后失效，请及时保存', 'warning', 5000);
                    }
                }
            }).catch(error => {
                console.warn('缓存 flux-kontext 图片失败:', error);
                // 缓存失败提示
                if (this.app && this.app.showToast) {
                    this.app.showToast('图片链接10分钟后失效，请及时保存', 'warning', 5000);
                }
            });
        }

        return {
            success: true,
            urls: allUrls,
            content: fullContent,
            usage: data.usage,
            networkStatus: 'checking' // 标记网络状态检查中
        };
    }

    // 检查URL可访问性（改进版本，减少误判）
    async checkUrlAccessibility(url, timeout = 8000) {
        return new Promise((resolve, reject) => {
            // 方法1：不设置 crossOrigin，先尝试基本加载
            const img = new Image();
            const timer = setTimeout(() => {
                // 超时时，尝试方法2
                this.checkUrlWithFetch(url).then(resolve).catch(() => {
                    reject(new Error('网络访问超时'));
                });
            }, timeout);
            
            img.onload = () => {
                clearTimeout(timer);
                console.log('图片可通过Image对象访问:', url);
                resolve(true);
            };
            
            img.onerror = (e) => {
                clearTimeout(timer);
                console.log('Image对象加载失败，尝试fetch检测:', url);
                // Image加载失败时，尝试fetch检测
                this.checkUrlWithFetch(url).then(resolve).catch(() => {
                    reject(new Error('图片无法通过多种方式访问'));
                });
            };
            
            // 不设置 crossOrigin，避免 CORS 问题
            img.src = url;
        });
    }

    // 使用fetch进行URL可访问性检测
    async checkUrlWithFetch(url, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Fetch超时'));
            }, timeout);

            fetch(url, {
                method: 'HEAD', // 只获取头信息，不下载内容
                mode: 'no-cors', // 不检查CORS，允许跨域
                signal: controller.signal,
                cache: 'no-cache'
            }).then(response => {
                clearTimeout(timer);
                console.log('Fetch检测结果:', url, 'ok:', response.ok, 'type:', response.type);
                // 在no-cors模式下，response.ok可能为false，但type为'opaque'表示请求成功
                if (response.ok || response.type === 'opaque') {
                    resolve(true);
                } else {
                    reject(new Error(`HTTP ${response.status}`));
                }
            }).catch(error => {
                clearTimeout(timer);
                if (error.name === 'AbortError') {
                    reject(new Error('Fetch被中止'));
                } else {
                    reject(error);
                }
            });
        });
    }

    // 从Gemini模型响应中提取Base64图片数据并转换为可用的URL
    extractBase64Images(content) {
        let urls = [];

        console.log('开始提取Base64图片，内容长度:', content.length);

        // 首先尝试清理内容（移除可能的换行和空格）
        const cleanedContent = content.replace(/\s+/g, '');
        console.log('清理后内容长度:', cleanedContent.length);

        // 方法1: 查找标准格式 data:image/type;base64,data
        const standardFormatRegex = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g;
        let matches = [...content.matchAll(standardFormatRegex)];

        if (matches.length > 0) {
            console.log('找到标准格式的Base64数据:', matches.length, '个');
            for (const match of matches) {
                urls.push(match[0]);
            }
            return urls;
        }

        // 方法2: 对于超长内容（>100KB），很可能就是纯Base64
        if (content.length > 100000) {
            console.log('检测到超长内容，可能是纯Base64');

            // 检查是否主要由Base64字符组成
            const base64CharCount = (cleanedContent.match(/[A-Za-z0-9+/=]/g) || []).length;
            const base64Ratio = base64CharCount / cleanedContent.length;

            console.log('Base64字符比例:', (base64Ratio * 100).toFixed(2) + '%');

            if (base64Ratio > 0.95) {
                console.log('确认为纯Base64内容，直接使用');
                // 使用清理后的内容创建data URL
                const dataUrl = `data:image/jpeg;base64,${cleanedContent}`;
                urls.push(dataUrl);
                return urls;
            }
        }

        // 方法3: 查找大段的Base64字符串
        const base64Pattern = /[A-Za-z0-9+/]{1000,}={0,2}/g;
        matches = [...content.matchAll(base64Pattern)];

        if (matches.length > 0) {
            console.log('找到大段Base64数据:', matches.length, '个');
            // 取最长的一个
            const longestMatch = matches.reduce((prev, current) =>
                current[0].length > prev[0].length ? current : prev
            );

            console.log('使用最长的Base64段，长度:', longestMatch[0].length);
            const dataUrl = `data:image/jpeg;base64,${longestMatch[0]}`;
            urls.push(dataUrl);
            return urls;
        }

        // 方法4: 如果还是没找到，但内容很长，尝试提取连续的Base64字符
        if (content.length > 10000) {
            // 尝试找到最长的连续Base64字符序列
            const continuousBase64 = cleanedContent.match(/[A-Za-z0-9+/=]+/);
            if (continuousBase64 && continuousBase64[0].length > 10000) {
                console.log('找到连续Base64字符，长度:', continuousBase64[0].length);
                const dataUrl = `data:image/jpeg;base64,${continuousBase64[0]}`;
                urls.push(dataUrl);
                return urls;
            }
        }

        console.warn('未能提取Base64图片');
        console.log('内容示例（前500字符）:', content.substring(0, 500));
        return urls;
    }

    // 异步上传到 R2（后台执行，不阻塞）
    async asyncUploadToR2(urls, modelConfig) {
        // 延迟100ms开始，让UI先响应
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            // 确保 R2 服务已初始化
            await window.r2Storage.init();

            if (!window.r2Storage.isAvailable()) {
                console.log('R2 服务不可用，跳过上传');
                return;
            }

            console.log('后台开始上传图片到 R2...');

            // 执行上传
            const r2Urls = await this.uploadImagesToR2(urls);

            if (r2Urls && r2Urls.length > 0) {
                console.log('R2 上传成功，触发完成事件');

                // 触发上传完成事件
                window.dispatchEvent(new CustomEvent('r2UploadComplete', {
                    detail: {
                        originalUrls: urls,
                        r2Urls: r2Urls,
                        model: modelConfig?.name || this.model,
                        timestamp: Date.now()
                    }
                }));

                // 显示成功提示
                this.showUploadSuccessNotification();
            }
        } catch (error) {
            console.error('后台 R2 上传错误:', error);
            // 上传失败不影响用户使用，只记录日志
        }
    }

    // 显示上传成功通知
    showUploadSuccessNotification() {
        // 创建一个小的通知提示
        const notification = document.createElement('div');
        notification.className = 'fixed bottom-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center space-x-2 z-50 animate-slide-up';
        notification.innerHTML = `
            <i class="fas fa-cloud-upload-alt"></i>
            <span>图片已备份到云端</span>
        `;
        document.body.appendChild(notification);

        // 3秒后自动消失
        setTimeout(() => {
            notification.classList.add('animate-fade-out');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    // 上传图片到 R2 存储
    async uploadImagesToR2(urls) {
        if (!window.r2Storage || !urls || urls.length === 0) {
            return urls;
        }

        try {
            // R2 服务已在调用前初始化，直接检查可用性
            if (!window.r2Storage.isAvailable()) {
                console.log('R2 服务不可用');
                return urls;
            }

            // 处理每个 URL
            const r2Urls = await Promise.all(
                urls.map(async (url) => {
                    try {
                        // 如果已经是 R2 URL，直接返回
                        if (window.r2Storage.isR2Url(url)) {
                            return url;
                        }

                        // 根据类型处理
                        if (url.startsWith('data:image')) {
                            // Base64 图片，上传到 R2
                            const r2Url = await window.r2Storage.uploadBase64(url, {
                                model: this.model,
                                timestamp: Date.now()
                            });
                            return r2Url;
                        } else {
                            // 远程 URL，缓存到 R2
                            const r2Url = await window.r2Storage.cacheRemoteUrl(url, {
                                model: this.model,
                                timestamp: Date.now()
                            });
                            return r2Url;
                        }
                    } catch (error) {
                        console.error(`上传单个图片失败: ${error.message}`);
                        return url; // 失败时返回原始 URL
                    }
                })
            );

            return r2Urls;
        } catch (error) {
            console.error('批量上传到 R2 失败:', error);
            return urls; // 失败时返回原始 URLs
        }
    }

    // 从响应内容中提取图片URL
    extractImageUrls(content) {
        let urls = [];

        // 方法1: 匹配markdown格式的图片链接（支持data URL和http URL）
        let pattern = /!\[.*?\]\((data:image\/[^;]+;base64,[^)]+|https?:\/\/[^)]+)\)/g;
        let match;

        while ((match = pattern.exec(content)) !== null) {
            const url = match[1];
            // 如果是data URL，直接使用；如果是http URL，解码转义字符
            if (url.startsWith('data:image/')) {
                urls.push(url);
                console.log('[extractImageUrls] 找到markdown格式的data URL');
            } else {
                const decodedUrl = this.decodeUrlEscapes(url);
                urls.push(decodedUrl);
            }
        }

        // 方法2: 如果没找到markdown格式，尝试直接匹配data URL
        if (urls.length === 0) {
            pattern = /data:image\/[^;]+;base64,[A-Za-z0-9+\/=]+/g;
            while ((match = pattern.exec(content)) !== null) {
                urls.push(match[0]);
                console.log('[extractImageUrls] 找到独立的data URL');
            }
        }

        // 方法3: 尝试匹配普通图片URL
        if (urls.length === 0) {
            pattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?/gi;
            while ((match = pattern.exec(content)) !== null) {
                const decodedUrl = this.decodeUrlEscapes(match[0]);
                urls.push(decodedUrl);
            }
        }

        // 方法4: 更宽泛的URL匹配（可能包含图片但没有明显扩展名）
        if (urls.length === 0) {
            pattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
            while ((match = pattern.exec(content)) !== null) {
                const url = match[0];
                // 过滤掉明显不是图片的URL
                if (!url.includes('api.') && !url.includes('docs.') && !url.includes('.html')) {
                    const decodedUrl = this.decodeUrlEscapes(url);
                    urls.push(decodedUrl);
                }
            }
        }

        // 去重
        urls = [...new Set(urls)];

        console.log(`[extractImageUrls] 找到 ${urls.length} 个图片URL`);
        if (urls.length > 0) {
            console.log(`[extractImageUrls] 第一个URL类型: ${urls[0].startsWith('data:') ? 'Data URL' : 'HTTP URL'}`);
        }

        return urls;
    }

    // 解码URL中的转义字符
    decodeUrlEscapes(url) {
        try {
            // 处理常见的转义字符
            let decodedUrl = url
                .replace(/\\u0026/g, '&')      // \u0026 -> &
                .replace(/\\u003D/g, '=')      // \u003D -> =
                .replace(/\\u002F/g, '/')      // \u002F -> /
                .replace(/\\u003A/g, ':')      // \u003A -> :
                .replace(/\\u003F/g, '?')      // \u003F -> ?
                .replace(/\\u0025/g, '%')      // \u0025 -> %
                .replace(/\\u002B/g, '+')      // \u002B -> +
                .replace(/\\u0023/g, '#');     // \u0023 -> #
            
            console.log('URL解码:', {
                original: url,
                decoded: decodedUrl,
                changed: url !== decodedUrl
            });
            
            return decodedUrl;
        } catch (error) {
            console.warn('URL解码失败，使用原始URL:', error);
            return url;
        }
    }

    // 判断URL是否需要进行可访问性检测
    shouldCheckAccessibility(url) {
        try {
            // 检查用户是否已标记此URL为可访问
            if (this.isUserMarkedAccessible(url)) {
                console.log('用户已标记此URL为可访问，跳过检测:', url);
                return false;
            }

            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();
            
            // 排除本地地址和已知稳定的域名
            const excludeDomains = [
                'localhost', '127.0.0.1', '0.0.0.0',
                'data:', 'blob:',  // Data URL 和 Blob URL
                'cdn.openai.com', 'oaidalleapiprodscus.blob.core.windows.net' // OpenAI 的稳定域名
            ];
            
            // 检查是否为排除的域名
            if (excludeDomains.some(domain => hostname.includes(domain))) {
                return false;
            }
            
            // 重点检测可能有访问限制的域名
            const checkDomains = [
                'sora.sapi.asia',
                'api.openai.com', 
                'files.oaiusercontent.com',
                'dalle-3-images', // DALL-E图片域名片段
                'amazonaws.com',   // AWS S3 等
                'googleapis.com',  // Google 相关
                'azurewebsites.net' // Azure 相关
            ];
            
            // 如果包含需要检测的域名，则进行检测
            return checkDomains.some(domain => hostname.includes(domain));
        } catch (error) {
            console.warn('URL解析失败，默认不检测:', url, error);
            return false;
        }
    }

    // 加载用户标记为可访问的URL列表
    loadUserMarkedAccessible() {
        try {
            const stored = localStorage.getItem('ai_image_user_marked_accessible');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('加载用户标记的可访问URL失败:', error);
            return [];
        }
    }

    // 保存用户标记为可访问的URL列表
    saveUserMarkedAccessible() {
        try {
            localStorage.setItem('ai_image_user_marked_accessible', JSON.stringify(this.userMarkedAccessible));
        } catch (error) {
            console.error('保存用户标记的可访问URL失败:', error);
        }
    }

    // 检查URL是否被用户标记为可访问
    isUserMarkedAccessible(url) {
        return this.userMarkedAccessible.includes(url);
    }

    // 标记URL为用户可访问
    markUrlAsUserAccessible(url) {
        if (!this.userMarkedAccessible.includes(url)) {
            this.userMarkedAccessible.push(url);
            this.saveUserMarkedAccessible();
            console.log('URL已标记为用户可访问:', url);
        }
    }

    // 移除URL的用户可访问标记
    unmarkUrlAsUserAccessible(url) {
        const index = this.userMarkedAccessible.indexOf(url);
        if (index > -1) {
            this.userMarkedAccessible.splice(index, 1);
            this.saveUserMarkedAccessible();
            console.log('URL可访问标记已移除:', url);
        }
    }

    // 下载图片 - 简化版本，优先使用 R2 URL
    async downloadImage(url, filename, modelKey = this.model) {
        try {
            console.log('准备下载图片:', { url, filename, modelKey });

            // 处理 Base64 图片
            if (url.startsWith('data:image/')) {
                console.log('检测到Base64图片，使用直接下载');
                return this.downloadBase64Image(url, filename, modelKey);
            }

            // 检查是否是 R2 URL（R2 URL 通常不会有跨域问题）
            const isR2Url = window.r2Storage && window.r2Storage.isR2Url && window.r2Storage.isR2Url(url);

            // 获取当前模型信息
            const currentModel = this.getCurrentModel();
            const isSeedreamModel = modelKey && modelKey.includes('seedream');

            // 准备文件名
            const extension = this.getFileExtension(url) || 'png';
            const prefix = this.getDownloadPrefix(modelKey);
            const finalFilename = filename || this.generateFilename(prefix, extension);
            console.log('准备下载文件名:', finalFilename);

            // 如果是 R2 URL 或本地可访问的 URL，尝试直接下载
            if (isR2Url || (!isSeedreamModel && !currentModel.apiType?.includes('flux'))) {
                try {
                    // 尝试简单的 fetch 下载
                    const response = await fetch(url);
                    if (response.ok) {
                        const blob = await response.blob();
                        if (blob && blob.size > 0) {
                            const objectUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = objectUrl;
                            a.download = finalFilename;
                            a.style.display = 'none';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(objectUrl);
                            console.log('直接下载成功');
                            return true;
                        }
                    }
                } catch (error) {
                    console.log('直接下载失败，将使用备用方案:', error.message);
                }
            }

            // 对于 Seedream 模型或其他有跨域问题的模型，直接在新标签页打开
            if (isSeedreamModel || currentModel.apiType === 'flux-kontext') {
                console.log(`${isSeedreamModel ? 'Seedream' : 'flux-kontext'} 模型：在新标签页打开图片`);
                const newWindow = window.open(url, '_blank');
                if (newWindow) {
                    // 使用 console.log 替代 showToast，避免 this.app 未定义的问题
                    console.log('图片已在新标签页打开，请右键选择"图片另存为"进行保存');
                    // 如果 app 实例存在，才调用 showToast
                    if (this.app && this.app.showToast) {
                        this.app.showToast('图片已在新标签页打开，请右键选择"图片另存为"进行保存', 'info', 5000);
                    }
                    return true;
                } else {
                    // 如果浏览器阻止了弹出窗口，使用 a 标签方式
                    const a = document.createElement('a');
                    a.href = url;
                    a.target = '_blank';
                    a.rel = 'noreferrer noopener';
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    console.log('请在新标签页中右键保存图片');
                    if (this.app && this.app.showToast) {
                        this.app.showToast('请在新标签页中右键保存图片', 'info', 5000);
                    }
                    return true;
                }
            }

            // 其他情况，尝试使用传统的 a 标签下载
            const a = document.createElement('a');
            a.href = url;
            a.download = finalFilename;
            a.rel = 'noreferrer noopener';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            console.log('使用 a 标签下载完成');

            return true;
        } catch (error) {
            console.error('下载图片失败:', error);
            throw new Error(`下载图片失败: ${error.message}`);
        }
    }

    // 下载Base64格式的图片
    downloadBase64Image(dataUrl, filename, modelKey = this.model) {
        try {
            // 从Data URL中提取MIME类型和扩展名
            const mimeMatch = dataUrl.match(/data:image\/([^;]+)/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'png';
            
            // 如果没有提供文件名，生成一个
            if (!filename) {
                const prefix = this.getDownloadPrefix(modelKey);
                filename = this.generateFilename(prefix, mimeType);
            }
            
            // 创建下载链接
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            
            // 触发下载
            a.click();
            document.body.removeChild(a);
            
            console.log('Base64图片下载成功:', filename);
            return true;
        } catch (error) {
            console.error('Base64图片下载失败:', error);
            throw new Error(`Base64图片下载失败: ${error.message}`);
        }
    }

    // 批量下载图片为压缩包 - 简化版本
    async downloadImagesAsZip(urls, zipFilename, progressCallback, modelKey = this.model) {
        if (!urls || !urls.length) {
            throw new Error('没有图片可下载');
        }

        // 对于 Seedream 模型，直接在新标签页逐个打开
        if (modelKey?.includes('seedream') || this.getCurrentModel().apiType === 'flux-kontext') {
            console.log('Seedream 或 Flux 模型：逐个在新标签页打开图片');
            urls.forEach((url, index) => {
                setTimeout(() => {
                    window.open(url, `_blank_${index}`);
                }, index * 500); // 每500ms打开一个，避免被浏览器阻止
            });
            throw new Error(`已为您在新标签页打开 ${urls.length} 张图片，请逐个右键保存。`);
        }

        try {
            const zip = new JSZip();
            let completed = 0;
            let successCount = 0;
            const prefix = this.getDownloadPrefix(modelKey);

            // 简化的下载逻辑
            const downloadPromises = urls.map(async (url, index) => {
                try {
                    let blob;

                    // 检查是否为Base64 Data URL
                    if (url.startsWith('data:image/')) {
                        blob = await this.dataUrlToBlob(url);
                    } else {
                        // 检查是否是 R2 URL（R2 URL 应该可以正常下载）
                        const isR2Url = window.r2Storage && window.r2Storage.isR2Url && window.r2Storage.isR2Url(url);
                        if (isR2Url) {
                            const response = await fetch(url);
                            if (response.ok) {
                                blob = await response.blob();
                            }
                        } else {
                            // 其他 URL 尝试基本的 fetch
                            try {
                                const response = await fetch(url, { mode: 'cors' });
                                if (response.ok) {
                                    blob = await response.blob();
                                }
                            } catch (error) {
                                console.warn(`下载失败: ${url}`, error.message);
                            }
                        }
                    }

                    if (blob && blob.size > 0) {
                        const extension = this.getFileExtension(url) || 'png';
                        const filename = `${prefix}_${index + 1}.${extension}`;
                        zip.file(filename, blob);
                        successCount++;
                    }

                    completed++;
                    if (progressCallback) {
                        progressCallback(completed, urls.length);
                    }
                } catch (error) {
                    console.warn(`下载图片失败: ${url}`, error);
                    completed++;
                    if (progressCallback) {
                        progressCallback(completed, urls.length);
                    }
                }
            });

            await Promise.all(downloadPromises);

            if (successCount === 0) {
                throw new Error('由于跨域限制，无法下载图片。建议右键图片选择"图片另存为"进行下载。');
            }

            // 生成压缩包
            const zipBlob = await zip.generateAsync({type: 'blob'});

            // 下载压缩包
            const downloadUrl = window.URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            const zipName = zipFilename || this.generateFilename(prefix, 'zip');
            a.download = zipName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(downloadUrl);

            let resultMessage = `成功下载 ${successCount}/${urls.length} 张图片`;

            if (successCount < urls.length) {
                throw new Error(`部分图片下载失败，${resultMessage}`);
            }

            return { success: true, message: resultMessage };
        } catch (error) {
            throw new Error(`批量下载失败: ${error.message}`);
        }
    }



    // 简化的网络下载图片blob - 仅用于批量下载等必要场景
    async downloadImageBlob(url) {
        console.log('尝试下载blob:', url);

        // 检查是否是 R2 URL
        const isR2Url = window.r2Storage && window.r2Storage.isR2Url && window.r2Storage.isR2Url(url);

        // R2 URL 应该可以直接下载
        if (isR2Url) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    return await response.blob();
                }
            } catch (error) {
                console.warn('R2 URL 下载失败:', error.message);
            }
        }

        // 对于 Seedream 和 flux 模型，直接返回失败，让调用方处理
        const currentModel = this.getCurrentModel();
        if (currentModel.apiType === 'flux-kontext' || this.model?.includes('seedream')) {
            throw new Error('此模型不支持 blob 下载，请使用新标签页方式');
        }

        // 其他情况，只尝试最基本的方法
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (response.ok) {
                return await response.blob();
            }
        } catch (error) {
            // 静默失败，让调用方决定如何处理
        }

        throw new Error('无法通过网络下载图片');
    }



    // Fetch下载方法
    async downloadViaFetch(url, mode = 'cors') {
        try {
            const response = await fetch(url, {
                mode,
                cache: 'no-store',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                headers: {
                    'Accept': 'image/*'
                }
            });

            if (mode === 'cors') {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return await response.blob();
            }

            if (response.type === 'opaque' || response.ok) {
                return await response.blob();
            }

            throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            throw error;
        }
    }

    // 代理下载方法
    async downloadViaProxy(url, proxyBase) {
        let proxyUrl;
        if (proxyBase.endsWith('?url=')) {
            proxyUrl = `${proxyBase}${encodeURIComponent(url)}`;
        } else if (proxyBase.endsWith('/')) {
            proxyUrl = `${proxyBase}${url}`;
        } else {
            proxyUrl = `${proxyBase}/${url}`;
        }

        const response = await fetch(proxyUrl, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) {
            throw new Error(`代理下载失败: HTTP ${response.status}`);
        }
        
                 return await response.blob();
    }


    // 降级方案：逐个下载图片
    async fallbackIndividualDownload(urls, modelKey = this.model) {
        let successCount = 0;
        const prefix = this.getDownloadPrefix(modelKey);
        
        for (let i = 0; i < urls.length; i++) {
            try {
                const url = urls[i];
                try {
                    const blob = await this.downloadImageBlob(url);
                    if (blob) {
                        const extension = this.getFileExtension(url) || 'png';
                        const filename = `${prefix}_${i + 1}.${extension}`;
                        const objectUrl = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = objectUrl;
                        a.download = filename;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(objectUrl);
                        successCount++;
                        continue;
                    }
                } catch (error) {
                    console.warn('降级下载blob失败，使用原链接:', error.message);
                }

                const extension = this.getFileExtension(url) || 'png';
                const filename = `${prefix}_${i + 1}.${extension}`;
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.target = '_blank';
                a.rel = 'noreferrer noopener';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                successCount++;
                
                // 延迟一下，避免浏览器阻止多个下载
                if (i < urls.length - 1) {
                    await this.delay(500);
                }
            } catch (error) {
                console.warn(`逐个下载第 ${i + 1} 张图片失败:`, error);
            }
        }
        
        return successCount;
    }

    // 将Data URL转换为Blob
    async dataUrlToBlob(dataUrl) {
        try {
            // 方法1: 使用fetch API（现代浏览器推荐）
            const response = await fetch(dataUrl);
            return await response.blob();
        } catch (error) {
            // 方法2: 手动解析Base64数据（兼容性方案）
            const parts = dataUrl.split(',');
            if (parts.length !== 2) {
                throw new Error('无效的Data URL格式');
            }
            
            const header = parts[0];
            const data = parts[1];
            
            // 提取MIME类型
            const mimeMatch = header.match(/data:([^;]+)/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            
            // 解码Base64数据
            const byteCharacters = atob(data);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
            return new Blob([byteArray], { type: mimeType });
        }
    }

    // 获取文件扩展名
    getFileExtension(url) {
        // 如果是Data URL，从MIME类型提取扩展名
        if (url.startsWith('data:image/')) {
            const mimeMatch = url.match(/data:image\/([^;]+)/);
            if (mimeMatch) {
                const mimeType = mimeMatch[1].toLowerCase();
                // 将常见MIME类型映射到扩展名
                const mimeToExt = {
                    'jpeg': 'jpg',
                    'jpg': 'jpg',
                    'png': 'png',
                    'gif': 'gif',
                    'webp': 'webp',
                    'bmp': 'bmp',
                    'tiff': 'tiff'
                };
                return mimeToExt[mimeType] || 'png';
            }
            return 'png';
        }
        
        // 普通URL的处理
        const match = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
        return match ? match[1] : 'png';
    }

    // 预加载图片到浏览器缓存
    async preloadImages(urls) {
        if (!urls || !urls.length) return;
        
        const preloadPromises = urls.map(url => {
            return new Promise((resolve) => {
                // Data URL不需要预加载（已经是内嵌数据）
                if (url.startsWith('data:image/')) {
                    resolve();
                    return;
                }
                
                // 跳过 pending 占位符 URL（正在上传中的图片）
                if (url.startsWith('pending:')) {
                    resolve();
                    return;
                }
                
                // 检查是否已经缓存
                const existingImg = document.querySelector(`img[src="${url}"]`);
                if (existingImg && existingImg.complete) {
                    resolve();
                    return;
                }
                
                // 创建隐藏的图片元素进行预加载
                const img = new Image();
                img.onload = () => {
                    // 图片加载完成，添加到DOM中但隐藏（保持在缓存中）
                    img.style.position = 'absolute';
                    img.style.left = '-9999px';
                    img.style.top = '-9999px';
                    img.style.opacity = '0';
                    img.style.pointerEvents = 'none';
                    document.body.appendChild(img);
                    resolve();
                };
                img.onerror = () => resolve(); // 即使失败也继续
                img.src = url;
            });
        });
        
        // 不等待所有图片加载完成，这样不会阻塞其他操作
        Promise.allSettled(preloadPromises);
    }

    // 生成文件名
    generateFilename(prefix = 'ai_image', extension = 'png') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `${prefix}_${timestamp}.${extension}`;
    }

    getDownloadPrefix(modelKey = this.model) {
        const key = (modelKey || '').toLowerCase();

        if (key.includes('seedream')) {
            return 'seedream';
        }
        if (key.includes('sora')) {
            return 'sora_image';
        }
        if (key === 'gemini-3-pro-image-preview') {
            return 'nano_banana_pro';
        }
        if (key.includes('gemini') || key.includes('nano')) {
            return 'nano_banana';
        }
        if (key.includes('flux-kontext')) {
            return 'flux_kontext';
        }

        const raw = modelKey || 'ai_image';
        return raw.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    }

    // 缓存 flux-kontext 图片到本地存储
    async cacheFluxKontextImages(urls) {
        // 首先尝试使用 Cloudflare Worker 缓存
        const workerUrl = this.getWorkerUrl();
        if (workerUrl) {
            try {
                console.log('使用 Cloudflare Worker 缓存图片...');
                const cachedUrls = await this.cacheViaWorker(urls, workerUrl);
                if (cachedUrls && cachedUrls.length > 0) {
                    console.log(`成功通过 Worker 缓存 ${cachedUrls.length} 张图片`);
                    return cachedUrls;
                }
            } catch (error) {
                console.warn('Worker 缓存失败，尝试本地缓存:', error);
            }
        }

        // 回退到本地缓存（localStorage）
        console.log('回退到本地缓存方案...');
        const cachedUrls = [];
        const cachePromises = urls.map(async (url, index) => {
            try {
                // 为每个URL生成唯一的缓存key
                const cacheKey = `flux_image_${Date.now()}_${index}`;

                // 尝试下载图片并转换为base64
                const base64Data = await this.convertUrlToBase64(url);
                if (base64Data) {
                    // 存储到localStorage
                    localStorage.setItem(cacheKey, base64Data);

                    // 记录原始URL和缓存key的映射
                    const mappingKey = `flux_url_mapping_${this.hashUrl(url)}`;
                    localStorage.setItem(mappingKey, JSON.stringify({
                        originalUrl: url,
                        cacheKey: cacheKey,
                        timestamp: Date.now(),
                        expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24小时后过期
                    }));

                    cachedUrls.push(base64Data);
                    console.log(`成功缓存图片到本地: ${url.substring(0, 50)}...`);
                }
            } catch (error) {
                console.warn(`本地缓存图片失败 ${url}:`, error.message);
            }
        });

        await Promise.allSettled(cachePromises);
        return cachedUrls;
    }

    // 通过 Cloudflare Worker 缓存图片
    async cacheViaWorker(urls, workerUrl) {
        try {
            const response = await fetch(`${workerUrl}/api/cache-images`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ urls })
            });

            if (!response.ok) {
                throw new Error(`Worker 响应错误: ${response.status}`);
            }

            const data = await response.json();

            if (data.success && data.cached && data.cached.length > 0) {
                // 保存 Worker URL 映射到 localStorage
                data.cached.forEach(item => {
                    if (item.originalUrl && item.cachedUrl) {
                        const mappingKey = `flux_worker_url_${this.hashUrl(item.originalUrl)}`;
                        localStorage.setItem(mappingKey, JSON.stringify({
                            originalUrl: item.originalUrl,
                            cachedUrl: item.cachedUrl,
                            timestamp: Date.now(),
                            permanent: true  // Worker缓存是永久的
                        }));
                    }
                });

                // 返回缓存的URL列表
                return data.cached.map(item => item.cachedUrl);
            }

            return [];
        } catch (error) {
            console.error('Worker 缓存请求失败:', error);
            throw error;
        }
    }

    // 获取 Worker URL（可以从配置或环境变量中读取）
    getWorkerUrl() {
        // 可以在这里配置你的 Worker URL
        // 例如：https://api.your-domain.com 或 https://ai-image-proxy.your-account.workers.dev
        const workerUrl = localStorage.getItem('worker_url') || window.CLOUDFLARE_WORKER_URL || '';

        // 如果没有配置 Worker URL，返回 null
        return workerUrl || null;
    }

    // 将URL转换为base64
    async convertUrlToBase64(url) {
        try {
            // 专门为缓存目的的下载方法，绕过flux-kontext的限制
            const blob = await this.downloadImageBlobForCache(url);
            if (blob && blob.size > 0) {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                });
            }
            return null;
        } catch (error) {
            console.warn('URL转base64失败:', error);
            return null;
        }
    }

    // 专门用于缓存的下载方法（不受模型类型限制）
    async downloadImageBlobForCache(url) {
        console.log('缓存目的下载blob:', url);

        const downloadMethods = [
            () => this.downloadViaFetch(url, 'no-cors'),
            () => this.downloadViaFetch(url, 'cors'),
            () => this.downloadViaProxy(url, 'https://api.allorigins.win/raw?url='),
            () => this.downloadViaProxy(url, 'https://cors.isomorphic-git.org/'),
            () => this.downloadViaProxy(url, 'https://thingproxy.freeboard.io/fetch/')
        ];

        for (let i = 0; i < downloadMethods.length; i++) {
            try {
                console.log(`缓存下载尝试方法 ${i + 1}/${downloadMethods.length}`);
                const blob = await downloadMethods[i]();
                if (blob && blob.size > 0) {
                    console.log(`缓存下载方法 ${i + 1} 成功，blob大小:`, blob.size);
                    return blob;
                }
            } catch (error) {
                console.warn(`缓存下载方法 ${i + 1} 失败:`, error.message);
            }
        }

        throw new Error('所有缓存下载方法都失败了');
    }

    // 生成URL的简单hash
    hashUrl(url) {
        let hash = 0;
        for (let i = 0; i < url.length; i++) {
            const char = url.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转为32位整数
        }
        return Math.abs(hash).toString(36);
    }

    // 获取缓存的图片
    getCachedImage(originalUrl) {
        try {
            // 首先检查是否有 Worker 缓存的URL
            const workerMappingKey = `flux_worker_url_${this.hashUrl(originalUrl)}`;
            const workerMappingData = localStorage.getItem(workerMappingKey);

            if (workerMappingData) {
                const workerMapping = JSON.parse(workerMappingData);
                // Worker 缓存是永久的，直接返回URL
                if (workerMapping.cachedUrl) {
                    console.log('使用 Worker 缓存URL:', workerMapping.cachedUrl);
                    return workerMapping.cachedUrl;
                }
            }

            // 然后检查本地缓存
            const mappingKey = `flux_url_mapping_${this.hashUrl(originalUrl)}`;
            const mappingData = localStorage.getItem(mappingKey);

            if (mappingData) {
                const mapping = JSON.parse(mappingData);

                // 检查是否过期
                if (!mapping.permanent && Date.now() > mapping.expiresAt) {
                    // 清理过期缓存
                    localStorage.removeItem(mappingKey);
                    localStorage.removeItem(mapping.cacheKey);
                    return null;
                }

                // 获取缓存的base64数据
                const cachedData = localStorage.getItem(mapping.cacheKey);
                return cachedData;
            }

            return null;
        } catch (error) {
            console.warn('获取缓存图片失败:', error);
            return null;
        }
    }

    // 清理过期的缓存（增强版）
    cleanupExpiredCache() {
        try {
            const keysToRemove = [];
            const now = Date.now();
            
            // 1. 清理过期的 flux 图片缓存
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                
                // Flux URL 映射
                if (key.startsWith('flux_url_mapping_')) {
                    const data = localStorage.getItem(key);
                    if (data) {
                        try {
                            const mapping = JSON.parse(data);
                            if (mapping.expiresAt && now > mapping.expiresAt) {
                                keysToRemove.push(key);
                                if (mapping.cacheKey) {
                                    keysToRemove.push(mapping.cacheKey);
                                }
                            }
                        } catch (e) {
                            // JSON 解析失败，删除损坏的缓存
                            keysToRemove.push(key);
                        }
                    }
                }
                
                // 清理损坏或孤立的 flux 缓存数据
                if (key.startsWith('flux_cache_')) {
                    // 检查是否有对应的映射
                    const mappingExists = localStorage.getItem(key.replace('flux_cache_', 'flux_url_mapping_'));
                    if (!mappingExists) {
                        keysToRemove.push(key);
                    }
                }
            }
            
            // 2. 检查 localStorage 总使用量
            let totalSize = 0;
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    totalSize += (localStorage[key]?.length || 0) * 2; // UTF-16
                }
            }
            const totalSizeKB = totalSize / 1024;
            const limitKB = 4096; // 4MB 阈值
            
            // 3. 如果超过阈值，强制清理大型缓存
            if (totalSizeKB > limitKB) {
                console.warn(`localStorage 使用量过高: ${totalSizeKB.toFixed(2)} KB，开始强制清理`);
                
                // 清理所有 flux 缓存
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('flux_') || key.startsWith('i18n_cache_'))) {
                        keysToRemove.push(key);
                    }
                }
            }
            
            // 4. 执行删除
            const uniqueKeys = [...new Set(keysToRemove)];
            uniqueKeys.forEach(key => {
                try {
                    localStorage.removeItem(key);
                } catch (e) {
                    console.warn(`删除缓存键失败: ${key}`, e);
                }
            });
            
            if (uniqueKeys.length > 0) {
                console.log(`清理了 ${uniqueKeys.length} 个过期/损坏的缓存项`);
            }
            
            // 5. 返回清理结果
            return {
                cleaned: uniqueKeys.length,
                totalSizeBefore: totalSizeKB,
                overLimit: totalSizeKB > limitKB
            };
        } catch (error) {
            console.warn('清理缓存失败:', error);
            return { cleaned: 0, error: error.message };
        }
    }

    // 批量生成图片
    async batchGenerate(prompts, ratio = '1:1', concurrency = 2, n = 1, resolution = null) {
        if (!Array.isArray(prompts) || prompts.length === 0) {
            throw new Error('提示词列表不能为空');
        }

        const results = [];
        const batches = this.chunk(prompts, concurrency);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const batchPromises = batch.map(async (prompt, index) => {
                const promptIndex = i * concurrency + index;
                try {
                    const result = await this.generateImage(prompt, ratio, n, resolution);
                    const resultData = {
                        index: promptIndex,
                        prompt,
                        success: true,
                        ...result
                    };
                    
                    // 立即触发单个结果显示事件
                    window.dispatchEvent(new CustomEvent('batchItemComplete', {
                        detail: {
                            result: resultData,
                            completed: promptIndex + 1,
                            total: prompts.length
                        }
                    }));
                    
                    return resultData;
                } catch (error) {
                    const errorData = {
                        index: promptIndex,
                        prompt,
                        success: false,
                        error: error, // 保存完整的错误对象，包含detailedError
                        errorMessage: error.message // 同时保存错误信息字符串
                    };
                    
                    // 立即触发错误结果显示事件
                    window.dispatchEvent(new CustomEvent('batchItemComplete', {
                        detail: {
                            result: errorData,
                            completed: promptIndex + 1,
                            total: prompts.length
                        }
                    }));
                    
                    return errorData;
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults.map(result => 
                result.status === 'fulfilled' ? result.value : {
                    success: false,
                    error: result.reason, // 保存完整错误对象
                    errorMessage: result.reason?.message || '请求失败，请查看详细错误信息'
                }
            ));

            // 触发进度更新事件
            window.dispatchEvent(new CustomEvent('batchProgress', {
                detail: {
                    completed: results.length,
                    total: prompts.length,
                    currentBatch: i + 1,
                    totalBatches: batches.length
                }
            }));

            // 批次间延迟，避免API限流
            if (i < batches.length - 1) {
                await this.delay(1000);
            }
        }

        return results;
    }

    // 批量生成图片（带参考图） - 支持多张参考图
    async batchGenerateWithReference(prompts, referenceImages, ratio = '1:1', concurrency = 2, n = 1, resolution = null) {
        if (!Array.isArray(prompts) || prompts.length === 0) {
            throw new Error('提示词列表不能为空');
        }

        if (!referenceImages || referenceImages.length === 0) {
            throw new Error('参考图片不能为空');
        }

        const results = [];
        const batches = this.chunk(prompts, concurrency);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const batchPromises = batch.map(async (prompt, index) => {
                const promptIndex = i * concurrency + index;
                try {
                    const result = await this.generateImageWithReference(prompt, referenceImages, ratio, n, resolution);
                    const resultData = {
                        index: promptIndex,
                        prompt,
                        success: true,
                        ...result
                    };
                    
                    // 立即触发单个结果显示事件
                    window.dispatchEvent(new CustomEvent('batchItemComplete', {
                        detail: {
                            result: resultData,
                            completed: promptIndex + 1,
                            total: prompts.length
                        }
                    }));
                    
                    return resultData;
                } catch (error) {
                    const errorData = {
                        index: promptIndex,
                        prompt,
                        success: false,
                        error: error, // 保存完整的错误对象，包含detailedError
                        errorMessage: error.message // 同时保存错误信息字符串
                    };
                    
                    // 立即触发错误结果显示事件
                    window.dispatchEvent(new CustomEvent('batchItemComplete', {
                        detail: {
                            result: errorData,
                            completed: promptIndex + 1,
                            total: prompts.length
                        }
                    }));
                    
                    return errorData;
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults.map(result => 
                result.status === 'fulfilled' ? result.value : {
                    success: false,
                    error: result.reason, // 保存完整错误对象
                    errorMessage: result.reason?.message || '请求失败，请查看详细错误信息'
                }
            ));

            // 触发进度更新事件
            window.dispatchEvent(new CustomEvent('batchProgress', {
                detail: {
                    completed: results.length,
                    total: prompts.length,
                    currentBatch: i + 1,
                    totalBatches: batches.length
                }
            }));

            // 批次间延迟，避免API限流
            if (i < batches.length - 1) {
                await this.delay(1000);
            }
        }

        return results;
    }

    // 数组分块
    chunk(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    // 延迟函数
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 创建带超时控制的fetch请求
    async fetchWithTimeout(url, options = {}, timeout = this.requestTimeout) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`请求超时 (${timeout/1000}秒)，请检查网络连接或稍后重试`);
            }
            throw error;
        }
    }

    // 测试网络连接
    async testNetworkConnection() {
        const results = {
            browserOnline: navigator.onLine,
            internetAccess: null,
            apiReachable: null,
            timestamp: new Date().toISOString()
        };
        
        // 1. 测试互联网连接（访问百度）
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            await fetch('https://www.baidu.com', { 
                mode: 'no-cors',
                cache: 'no-cache',
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            results.internetAccess = true;
        } catch(e) {
            results.internetAccess = false;
        }
        
        // 2. 测试 API 端点连通性
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(this.baseURL, {
                method: 'OPTIONS',
                cache: 'no-cache',
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            results.apiReachable = response.ok || response.status === 405; // OPTIONS 可能返回 405
        } catch(e) {
            results.apiReachable = false;
        }
        
        return results;
    }

    // 诊断网络错误类型
    diagnoseNetworkError(error, url) {
        const diagnosis = {
            type: 'unknown',
            isOnline: navigator.onLine,
            url: url,
            errorName: error.name,
            errorMessage: error.message,
            timestamp: new Date().toISOString()
        };
        
        // 离线状态（最高优先级）
        if (!navigator.onLine) {
            diagnosis.type = 'offline';
            diagnosis.friendlyMessage = '设备离线';
            diagnosis.suggestions = [
                '检查 WiFi/移动网络连接',
                '确认网络已启用',
                '连接网络后点击"立即重试"'
            ];
            return diagnosis;
        }
        
        // 请求超时
        if (error.name === 'AbortError' || error.message.includes('请求超时')) {
            diagnosis.type = 'timeout';
            diagnosis.friendlyMessage = '请求超时';
            diagnosis.suggestions = [
                '网络较慢或服务器响应慢',
                '建议：使用稳定的网络连接',
                '或降低并发数量后重试',
                '点击下方"测试连接"进行诊断'
            ];
            return diagnosis;
        }
        
        // TypeError: Failed to fetch - 可能是 CORS 或网络不可达
        if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
            diagnosis.type = 'cors_or_network';
            diagnosis.friendlyMessage = 'CORS 或网络连接失败';
            diagnosis.suggestions = [
                '可能是跨域(CORS)配置问题或网络不可达',
                '点击下方"测试连接"进行网络诊断',
                '检查防火墙是否阻止了请求',
                '暂时关闭 VPN/代理后重试'
            ];
            return diagnosis;
        }
        
        // NetworkError
        if (error.name === 'NetworkError') {
            diagnosis.type = 'network';
            diagnosis.friendlyMessage = '网络连接失败';
            diagnosis.suggestions = [
                'DNS 解析失败或服务器不可达',
                '尝试访问其他网站确认网络正常',
                '检查防火墙设置',
                '点击"测试连接"进行诊断'
            ];
            return diagnosis;
        }
        
        // 通用网络错误
        diagnosis.type = 'general_network';
        diagnosis.friendlyMessage = '网络连接错误';
        diagnosis.suggestions = [
            '网络连接出现问题',
            '点击"测试连接"进行诊断',
            '检查网络连接是否正常',
            '或稍后重试'
        ];
        
        return diagnosis;
    }

    // 带重试机制的API请求
    async requestWithRetry(url, options = {}, maxRetries = this.maxRetries, customTimeout = null) {
        let lastError;

        // 使用自定义超时时间，如果没有则根据当前模型获取
        const timeout = customTimeout || this.getModelTimeout();

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await this.fetchWithTimeout(url, options, timeout);
                
                if (!response.ok) {
                    let errorData;
                    let responseText = '';
                    
                    try {
                        // 尝试解析JSON错误响应
                        const responseClone = response.clone();
                        responseText = await responseClone.text();
                        errorData = JSON.parse(responseText);
                    } catch (parseError) {
                        // 如果不是JSON，使用原始响应文本
                        errorData = { error: { message: responseText || response.statusText } };
                    }
                    
                    // 构建详细的错误信息
                    const detailedError = {
                        status: response.status,
                        statusText: response.statusText,
                        url: url,
                        method: options.method || 'GET',
                        errorData: errorData,
                        rawResponse: responseText,
                        attempt: attempt,
                        maxRetries: maxRetries,
                        timestamp: new Date().toISOString()
                    };
                    
                    // 提取主要错误消息
                    let mainErrorMessage = errorData.error?.message || 
                                         errorData.message || 
                                         errorData.error?.code || 
                                         responseText || 
                                         `HTTP ${response.status} ${response.statusText}`;
                    
                    // 对于任何HTTP错误（400+），都不重试，直接抛出
                    if (response.status >= 400) {
                        let errorType = '请求错误';
                        if (response.status === 401 || response.status === 403) {
                            errorType = '认证失败';
                        } else if (response.status === 400) {
                            errorType = '请求参数错误或内容违规';
                        } else if (response.status === 429) {
                            errorType = 'API调用频率限制';
                        } else if (response.status >= 500) {
                            errorType = '服务器内部错误';
                        }
                        
                        const httpError = new Error(`${errorType}: ${mainErrorMessage}。HTTP错误不会自动重试，请检查后手动重新生成。`);
                        httpError.detailedError = detailedError;
                        throw httpError;
                    }
                    
                    // 创建包含详细信息的错误
                    const apiError = new Error(mainErrorMessage);
                    apiError.detailedError = detailedError;
                    throw apiError;
                }
                
                return response;
            } catch (error) {
                lastError = error;
                
                // 诊断网络错误
                const diagnosis = this.diagnoseNetworkError(error, url);
                
                // 为网络错误等非API错误也添加详细信息
                if (!error.detailedError) {
                    error.detailedError = {
                        status: null,
                        statusText: 'Network Error',
                        url: url,
                        method: options.method || 'GET',
                        errorData: { error: { message: error.message } },
                        rawResponse: '',
                        attempt: attempt,
                        maxRetries: maxRetries,
                        timestamp: new Date().toISOString(),
                        isNetworkError: true,
                        diagnosis: diagnosis // 保存诊断结果
                    };
                }
                
                // 保存请求上下文供重试使用
                error.requestContext = {
                    url: url,
                    options: options,
                    maxRetries: maxRetries,
                    customTimeout: customTimeout,
                    retryable: true // 标记为可重试
                };
                
                // 对于网络连接错误，只在第一次失败时重试一次
                if (attempt === maxRetries) {
                    throw error;
                }
                
                // 只对真正的网络连接问题进行重试（非HTTP错误）
                if (error.message.includes('请求超时') || 
                    error.message.includes('网络连接') || 
                    error.name === 'TypeError' || 
                    error.name === 'NetworkError' ||
                    error.name === 'AbortError') {
                    
                    const retryDelay = this.baseRetryDelay;
                    console.warn(`网络连接问题，${retryDelay/1000}秒后重试一次: ${error.message}`);
                    await this.delay(retryDelay);
                } else {
                    // 其他错误直接抛出，不重试
                    throw error;
                }
            }
        }
        
        throw lastError;
    }

    // 智能识别 API 拒绝原因（针对 Nano Banana Pro API）
    detectRejectionReason(textResponse) {
        if (!textResponse || typeof textResponse !== 'string') {
            return null;
        }
        
        const lowerText = textResponse.toLowerCase();
        
        // 1. 检测通用拒绝响应（扩展模式）
        const isRejection = 
            lowerText.includes("i'm just a language model") || 
            lowerText.includes("i can't help with that") ||
            lowerText.includes("i cannot help with that") ||
            lowerText.includes("i can't generate") ||
            lowerText.includes("i cannot generate") ||
            lowerText.includes("i can't create") ||
            lowerText.includes("i cannot create") ||
            lowerText.includes("我不能") ||
            lowerText.includes("无法生成") ||
            lowerText.includes("违反") && (lowerText.includes("政策") || lowerText.includes("policy"));
        
        if (isRejection) {
            
            // 2. 检测去水印请求
            if (lowerText.includes('watermark') || lowerText.includes('remove') && lowerText.includes('mark')) {
                return {
                    type: 'watermark_removal',
                    title: '去水印功能不被支持',
                    message: '检测到您尝试去除水印，Nano Banana Pro API 不支持此类请求。',
                    details: [
                        '去水印功能违反内容政策，API 会拒绝处理',
                        '建议：使用专门的图片编辑工具进行水印处理',
                        '或调整您的请求，专注于其他图片编辑需求'
                    ]
                };
            }
            
            // 3. 检测换脸请求
            if (lowerText.includes('faceswap') || lowerText.includes('face swap') || 
                lowerText.includes('swap face') || (lowerText.includes('face') && lowerText.includes('replace'))) {
                return {
                    type: 'faceswap',
                    title: '换脸功能不被支持',
                    message: '检测到您尝试进行换脸操作，Nano Banana Pro API 不支持此类请求。',
                    details: [
                        '换脸功能可能涉及隐私和伦理问题，API 会拒绝处理',
                        '建议：使用其他专门的换脸应用',
                        '或重新考虑您的图片编辑需求'
                    ]
                };
            }
            
            // 4. 检测 NSFW/色情内容
            if (lowerText.includes('nsfw') || 
                lowerText.includes('inappropriate') || 
                lowerText.includes('explicit') || 
                lowerText.includes('sexually') ||
                lowerText.includes('adult content') ||
                lowerText.includes('色情') ||
                lowerText.includes('不雅') ||
                lowerText.includes('冒犯')) {
                return {
                    type: 'nsfw',
                    title: '内容违反安全策略',
                    message: `${textResponse}`, // 直接使用 API 返回的说明
                    details: [
                        'NSFW（不适合工作场所）或色情内容不被允许',
                        '请确保您的提示词和图片内容符合使用政策',
                        '建议：调整提示词，避免敏感或不适当的描述',
                        '如使用参考图，请确保图片内容健康、正面'
                    ]
                };
            }
            
            // 5. 通用拒绝（无法识别具体原因）
            return {
                type: 'general_rejection',
                title: '内容被AI拒绝处理',
                message: 'AI 模型判断该请求不适合处理，可能涉及内容政策限制。',
                details: [
                    `API 返回: "${textResponse.substring(0, 150)}${textResponse.length > 150 ? '...' : ''}"`,
                    '可能原因：内容违反使用政策、请求不明确或超出模型能力范围',
                    '建议：重新审视您的提示词和输入图片',
                    '确保请求符合内容政策并清晰表达您的需求'
                ]
            };
        }
        
        // 6. 检测知识库限制（提及未来产品/不存在的概念）
        // 注意：Nano Banana Pro 知识库更新到 2025年1月
        const futureYearMatch = textResponse.match(/202[6-9]|20[3-9]\d/);
        if (futureYearMatch || lowerText.includes('iphone 17') || lowerText.includes('iphone 18')) {
            return {
                type: 'knowledge_cutoff',
                title: '请求超出模型知识库范围',
                message: '您的请求包含模型知识库之外的内容（知识库截止至 2025年1月）。',
                details: [
                    `检测到: ${futureYearMatch ? futureYearMatch[0] + '年相关内容' : '未来产品引用'}`,
                    'Nano Banana Pro API 知识库更新至 2025年1月',
                    '对于未来产品或概念，模型可能无法准确理解和处理',
                    '建议：使用已存在的产品或概念进行图片生成/编辑'
                ]
            };
        }
        
        return null;
    }
    
    // 格式化详细错误信息用于展示
    formatDetailedError(error) {
        // 特殊处理：candidatesTokenCount 为 0 的情况（谷歌拒绝出图）
        if (error && error.isGoogleRejection) {
            return {
                title: '谷歌拒绝出图',
                message: '当前输入的提示词或图片谷歌拒绝出图，请修改后重试',
                details: [
                    '检测到 candidatesTokenCount 为 0',
                    '这表明 Google API 在内容审核阶段就拒绝了请求',
                    '可能原因：提示词或参考图包含不适当内容',
                    '建议：重新检查提示词，确保符合内容政策',
                    '如使用参考图，请确保图片内容健康、正面'
                ],
                technicalDetails: [
                    `模型: ${this.model}`,
                    `candidatesTokenCount: 0`,
                    `promptTokenCount: ${error.responseData?.usageMetadata?.promptTokenCount || 'N/A'}`,
                    `完整响应: 见下方原始JSON`
                ],
                rawResponse: error.detailedError?.rawResponse,
                parsedErrorData: error.detailedError?.errorData,
                errorData: error.detailedError,
                rejectionType: 'zero_candidates_token' // 用于前端展示
            };
        }
        
        // 通用的 finishReason 处理（适用于所有非正常结束的情况）
        if (error && error.hasFinishReason && error.finishReason) {
            const finishReason = error.finishReason;
            const candidateStructure = error.detailedError?.candidateStructure || 
                                      (error.candidateData ? JSON.stringify(error.candidateData, null, 2) : 'N/A');
            
            // finishReason 友好名称映射（可扩展）
            const finishReasonNames = {
                'PROHIBITED_CONTENT': '违禁内容',
                'NO_IMAGE': '未生成图片',
                'SAFETY': '安全过滤',
                'RECITATION': '引用限制',
                'MAX_TOKENS': 'Token 超限',
                'OTHER': '其他原因'
            };
            
            const friendlyName = finishReasonNames[finishReason] || finishReason;
            
            // finishReason 通用建议（可扩展）
            const commonSuggestions = {
                'PROHIBITED_CONTENT': [
                    '检测到违禁内容（如色情、暴力、仇恨言论等）',
                    '请检查您的提示词，确保内容健康、正面',
                    '如使用参考图，请确保图片内容符合使用政策',
                    '避免涉及敏感话题或不适当的描述'
                ],
                'SAFETY': [
                    'API 安全过滤器拦截了此请求',
                    '请调整提示词，避免可能引发安全问题的内容',
                    '确保描述符合内容使用政策'
                ],
                'NO_IMAGE': [
                    '模型判断不需要生成图片',
                    '请在提示词中明确表达图片生成或编辑的意图',
                    '例如："生成一张..."、"创建图片..."、"编辑图片使其..."'
                ],
                'RECITATION': [
                    '内容可能涉及版权或引用限制',
                    '请避免直接复制或引用受保护的内容',
                    '尝试使用原创的描述方式'
                ]
            };
            
            const suggestions = commonSuggestions[finishReason] || [
                `API 返回了非正常的结束原因：${finishReason}`,
                '这可能意味着请求被拒绝或遇到了特定限制',
                '请查看下方的 Candidate 结构了解详细信息',
                '建议：调整提示词或参考图后重试'
            ];
            
            return {
                title: `API 拒绝处理：${friendlyName}`,
                message: `API 返回了 finishReason: ${finishReason}，表示请求未能正常完成。`,
                details: suggestions,
                technicalDetails: [
                    `模型: ${this.model}`,
                    `finishReason: ${finishReason}`,
                    `Candidate 结构: 见下方专门展示区域`
                ],
                rawResponse: error.detailedError?.rawResponse,
                candidateStructure: candidateStructure, // 专门展示 candidate 结构
                parsedErrorData: error.detailedError?.errorData,
                errorData: error.detailedError,
                rejectionType: 'finish_reason', // 用于前端展示
                finishReason: finishReason // 传递给前端
            };
        }
        
        // 智能识别 Nano Banana Pro API (gemini-3-pro-image-preview) 的拒绝响应
        if (error && error.apiTextResponses && error.apiTextResponses.length > 0) {
            const textResponse = error.apiTextResponses.join('\n');
            const rejectionInfo = this.detectRejectionReason(textResponse);
            
            if (rejectionInfo) {
                // 使用智能识别的结果
                return {
                    title: rejectionInfo.title,
                    message: rejectionInfo.message,
                    details: rejectionInfo.details,
                    technicalDetails: [
                        `模型: ${this.model}`,
                        `API 文本响应: ${textResponse.substring(0, 200)}${textResponse.length > 200 ? '...' : ''}`,
                        `识别类型: ${rejectionInfo.type}`
                    ],
                    rawResponse: error.detailedError?.rawResponse,
                    parsedErrorData: error.detailedError?.errorData,
                    errorData: error.detailedError,
                    rejectionType: rejectionInfo.type, // 用于前端展示常见问题提示
                    apiTextResponse: textResponse // 原始文本响应
                };
            } else {
                // 无法智能识别，但有文本响应 - 直接展示 API 返回的文本
                return {
                    title: 'API 拒绝处理',
                    message: textResponse, // 直接使用 API 返回的文本（如中文说明）
                    details: [
                        '这是 API 返回的说明信息',
                        '请根据提示调整您的请求内容',
                        '确保提示词和图片符合使用政策'
                    ],
                    technicalDetails: [
                        `模型: ${this.model}`,
                        `返回状态: 成功但未生成图片`,
                        `API 文本响应长度: ${textResponse.length} 字符`
                    ],
                    rawResponse: error.detailedError?.rawResponse,
                    parsedErrorData: error.detailedError?.errorData,
                    errorData: error.detailedError,
                    rejectionType: 'api_text_response', // 用于前端展示
                    apiTextResponse: textResponse // 原始文本响应
                };
            }
        }
        
        if (!error || !error.detailedError) {
            // 永远不展示"未知错误"，而是提供尽可能多的信息
            const errorMessage = error?.message || 'API 返回了异常响应';
            const errorStack = error?.stack || '';
            const responseData = error?.responseData ? JSON.stringify(error.responseData, null, 2) : null;
            
            return {
                title: '生成失败',
                message: errorMessage,
                details: [
                    '这是一个未预期的错误类型',
                    '请查看下方的完整响应数据进行排查',
                    '如需帮助，请将完整错误信息反馈给技术支持'
                ],
                technicalDetails: [
                    `错误信息: ${errorMessage}`,
                    error?.name ? `错误类型: ${error.name}` : null,
                    `模型: ${this.model || 'N/A'}`
                ].filter(Boolean),
                rawResponse: responseData, // 展示完整响应数据
                errorData: {
                    error: error,
                    message: errorMessage,
                    stack: errorStack
                }
            };
        }

        const detail = error.detailedError;
        let title = '图片生成失败';
        let message = error.message;
        let details = [];

        // 根据状态码提供具体的错误分析
        if (detail.status) {
            switch (detail.status) {
                case 400:
                    title = '请求参数错误';
                    details.push('请检查提示词是否符合要求，是否包含敏感内容');
                    break;
                case 401:
                    title = 'API Key认证失败';
                    details.push('请检查API Key是否正确');
                    details.push('确认API Key是否有效且未过期');
                    break;
                case 403:
                    title = '访问权限不足';
                    details.push('API Key可能没有图片生成权限');
                    details.push('或账户余额不足');
                    break;
                case 429:
                    title = 'API调用频率限制';
                    details.push('请求过于频繁，请稍后重试');
                    details.push('建议降低并发数量');
                    break;
                case 500:
                    title = '服务器内部错误';
                    details.push('API服务器遇到内部问题');
                    details.push('请稍后手动重新生成');
                    break;
                case 502:
                case 503:
                case 504:
                    title = '服务暂时不可用';
                    details.push('API服务器暂时无法响应');
                    details.push('请稍后手动重新生成');
                    break;
                default:
                    title = `HTTP ${detail.status} 错误`;
            }
        } else if (detail.isNetworkError) {
            // 使用诊断结果（如果有）
            if (detail.diagnosis) {
                const diag = detail.diagnosis;
                title = diag.friendlyMessage || '网络连接错误';
                
                // 使用诊断建议
                if (diag.suggestions && diag.suggestions.length > 0) {
                    details.push(...diag.suggestions);
                }
                
                // 添加浏览器在线状态
                technicalDetails.push(`浏览器在线状态: ${diag.isOnline ? '在线' : '离线'}`);
                technicalDetails.push(`错误类型: ${diag.type}`);
            } else {
                // 降级处理：使用原有逻辑
                if (error.message && error.message.includes('请求超时')) {
                    title = '图片生成超时';
                    details.push('图片生成时间超过预期');
                    
                    const timeoutMatch = error.message.match(/(\d+)秒/);
                    if (timeoutMatch) {
                        const timeoutSeconds = parseInt(timeoutMatch[1]);
                        const timeoutMinutes = Math.floor(timeoutSeconds / 60);
                        details.push(`超时限制: ${timeoutMinutes} 分钟`);
                        
                        if (timeoutSeconds >= 360) {
                            details.push('建议：尝试使用较低分辨率（2K 或 1K）');
                            details.push('或检查网络连接后重试');
                        } else if (timeoutSeconds >= 300) {
                            details.push('建议：尝试使用 1K 分辨率');
                            details.push('或检查网络连接后重试');
                        } else {
                            details.push('建议：检查网络连接是否稳定');
                            details.push('或稍后重试');
                        }
                    } else {
                        details.push('建议：检查网络连接后重试');
                    }
                    
                    details.push('请确保浏览器标签页保持激活状态');
                } else {
                    title = '网络连接错误';
                    details.push('请检查网络连接是否正常');
                    details.push('确认防火墙是否阻止了请求');
                    details.push('点击下方"测试连接"进行网络诊断');
                }
            }
        }

        // 添加技术详情
        const technicalDetails = [];
        if (detail.status) {
            technicalDetails.push(`状态码: ${detail.status} ${detail.statusText}`);
        }
        if (detail.timestamp) {
            technicalDetails.push(`时间: ${new Date(detail.timestamp).toLocaleString()}`);
        }
        if (detail.attempt && detail.maxRetries) {
            technicalDetails.push(`重试: ${detail.attempt}/${detail.maxRetries}`);
        }
        if (detail.operation) {
            technicalDetails.push(`操作: ${error.operation || detail.operation}`);
        }

        // 如果有原始错误响应，添加到技术详情（简短版本）
        if (detail.rawResponse && detail.rawResponse.trim() && detail.rawResponse !== detail.statusText) {
            technicalDetails.push(`服务器响应摘要: ${detail.rawResponse.substring(0, 100)}${detail.rawResponse.length > 100 ? '...' : ''}`);
        }

        return {
            title,
            message,
            details,
            technicalDetails,
            rawResponse: detail.rawResponse, // 完整的原始响应
            parsedErrorData: detail.errorData, // 解析后的错误数据
            errorData: detail
        };
    }
}

// 导出API实例
window.aiImageAPI = new AIImageAPI();
