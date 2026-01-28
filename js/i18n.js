/**
 * 国际化 (i18n) 核心模块
 * 支持多语言切换、动态加载、文本翻译
 */

// 默认语言包（内联，作为后备，包含关键翻译）
const DEFAULT_TRANSLATIONS = {
  "common": {
    "appName": "CATIMATION-Cyberpunk Master",
    "appNameShort": "CATIMATION",
    "appNameMobile": "CATIMATION",
    "generate": "生成",
    "batch": "批量",
    "compare": "对比",
    "history": "历史",
    "understand": "图像理解",
    "settings": "设置",
    "about": "说明",
    "docs": "开发文档",
    "save": "保存",
    "cancel": "取消",
    "delete": "删除",
    "download": "下载",
    "upload": "上传",
    "copy": "复制",
    "close": "关闭",
    "confirm": "确认",
    "clear": "清空",
    "loading": "正在加载 CATIMATION-AI图片生成测试平台...",
    "processing": "处理中...",
    "success": "成功",
    "error": "错误",
    "warning": "警告"
  },
  "nav": {
    "generateImage": "生成图片",
    "generateImageShort": "出图",
    "batchGenerate": "批量生成",
    "batchShort": "批量",
    "modelCompare": "模型对比",
    "compareShort": "对比",
    "historyRecords": "历史记录",
    "historyShort": "记录",
    "imageUnderstand": "图像理解",
    "understandShort": "识图",
    "director": "导演模式",
    "directorShort": "导演",
    "switchLanguage": "切换语言",
    "model": "模型",
    "activity": "活动",
    "menu": "菜单",
    "apiStatus": {
      "label": "API状态",
      "notConfigured": "未配置",
      "connected": "已连接"
    },
    "settingsButton": {
      "notConfigured": "未设置",
      "configured": "已设置"
    },
    "badge": {
      "lottery": "抽卡"
    }
  },
  "settings": {
    "title": "设置",
    "apiKey": "API Key",
    "apiKeyPlaceholder": "请输入你的 API Key",
    "apiKeyRequired": "API Key 是必需的",
    "baseUrl": "API 基础地址",
    "baseUrlPlaceholder": "请输入 API 基础地址",
    "testConnection": "测试连接",
    "saveSuccess": "设置保存成功",
    "testSuccess": "连接测试成功",
    "testFailed": "连接测试失败"
  },
  "generate": {
    "title": "生成图片",
    "prompt": "提示词",
    "promptPlaceholder": "描述你想要生成的图片...",
    "promptRequired": "请输入提示词",
    "negativePrompt": "负面提示词",
    "negativePromptPlaceholder": "描述你不想在图片中看到的内容...",
    "model": "模型",
    "selectModel": "选择模型",
    "aspectRatio": "比例",
    "resolution": "分辨率",
    "referenceImage": "参考图片",
    "uploadReference": "上传参考图",
    "removeReference": "移除参考图",
    "generating": "正在生成图片...",
    "generateSuccess": "图片生成成功",
    "generateFailed": "图片生成失败",
    "downloadImage": "下载图片",
    "copyPrompt": "复制提示词",
    "useTemplate": "使用模板",
    "templates": "提示词模板",
    "quantity": "数量",
    "quantityOptions": { "1": "1张", "2": "2张" },
    "finalResolution": "最终分辨率",
    "imageSize": "图片尺寸",
    "describeImage": "描述您想要的图片",
    "image2ImageLabel": "图生图 (垫图可选，不上传即文生图)",
    "clickToUpload": "点击上传参考图片",
    "pasteImageDesktop": "或按快捷键粘贴图片",
    "pasteImageMobile": "或直接粘贴图片",
    "autoCompressionInfo": "大图片在生成时自动压缩，不影响质量",
    "messages": {
      "promptRequired": "请输入图片描述",
      "apiKeyNotSet": "请先设置API Key",
      "generateSuccess": "图片生成成功",
      "generateError": "图片生成过程中出现错误"
    },
    "labels": {
      "generatedImagesPlaceholder": "生成的图片将在这里显示"
    },
    "buttons": {
      "generateButton": "开始生成",
      "generating": "生成中...",
      "clearInput": "清空输入",
      "download": "下载"
    }
  },
  "batch": {
    "title": "批量生成",
    "modes": { "card": "🎰 抽卡模式（推荐）", "multi": "📋 多提示词模式" },
    "buttons": { "startBatch": "开始批量生成", "stopBatch": "停止生成", "clearInput": "清空输入" },
    "labels": { "quantity": "生成数量（抽卡张数）", "emptyResults": "批量生成的结果将在这里显示" },
    "progress": { "processing": "正在处理...", "generating": "正在批量生成...", "completed": "已完成" },
    "status": { "batchCount": "生成数量", "concurrency": "并发数", "completed": "已完成", "failed": "失败" }
  },
  "compare": {
    "title": "模型对比",
    "buttons": { "startCompare": "开始对比", "clearInput": "清空输入" },
    "labels": { "leftModel": "左侧模型", "rightModel": "右侧模型", "selectModel": "选择模型" }
  },
  "history": {
    "title": "历史记录",
    "noHistory": "暂无历史记录",
    "clearHistory": "清空历史记录",
    "confirmClear": "确定要清空所有历史记录吗？",
    "buttons": { "view": "查看图片", "download": "下载图片", "delete": "删除记录" },
    "labels": { "empty": "暂无历史记录" }
  },
  "understand": {
    "title": "图像理解",
    "pageTitle": "上传图片进行理解",
    "multiImageSupport": "支持多图联合分析",
    "buttons": { "analyze": "分析图片", "startAnalysis": "开始分析" },
    "messages": { "uploadFirst": "请先上传图片" }
  },
  "director": {
    "title": "导演模式",
    "pageTitle": "漫画分镜自动生成",
    "buttons": { "generate": "一键生成漫画分镜" },
    "labels": { "emptyResults": "生成的漫画分镜将在这里显示" }
  },
  "messages": {
    "apiKeyNotSet": "请先设置 API Key",
    "promptRequired": "请输入提示词",
    "copied": "已复制到剪贴板",
    "networkError": "网络错误，请检查网络连接"
  },
  "settingsModal": {
    "title": "API设置",
    "selectSite": "选择 API 站点",
    "enterApiKey": "输入 API Key",
    "buttons": { "save": "保存", "test": "测试连接", "cancel": "取消" },
    "messages": { "saveSuccess": "设置保存成功", "testSuccess": "连接测试成功", "testFailed": "连接测试失败" }
  },
  "activity": {
    "title": "🎉 新用户专享福利",
    "buttons": { "close": "关闭" }
  },
  "about": {
    "title": "CATIMATION-Cyberpunk Master - 项目说明",
    "closeButton": "我知道了"
  },
  "footer": {
    "copyright": "2025 CATIMATION 保留所有权利"
  },
  "seo": {
    "title": "CATIMATION-Cyberpunk Master - 免费在线AI图片生成工具",
    "description": "CATIMATION-Cyberpunk Master是一款强大的在线AI图片生成工具",
    "keywords": "AI图片生成,AI绘画"
  }
};

class I18n {
    constructor() {
        // 支持的语言列表
        this.languages = {
            'zh-CN': { name: '简体中文', shortName: '中' },
            'en': { name: 'English', shortName: 'EN' },
            'zh-TW': { name: '繁體中文', shortName: '繁' },
            'ru': { name: 'Русский', shortName: 'РУ' }
        };

        // 默认语言
        this.defaultLang = 'zh-CN';

        // 语言回退链配置（基于 i18next 最佳实践）
        this.fallbackLng = {
            'zh-TW': ['zh-CN', 'en'],
            'zh-HK': ['zh-TW', 'zh-CN', 'en'],
            'ru': ['en', 'zh-CN'],
            'default': ['zh-CN']
        };

        // 当前语言
        this.currentLang = null;

        // 翻译数据缓存
        this.translations = {};

        // localStorage 缓存配置
        this.cacheConfig = {
            enabled: true,
            prefix: 'i18n_cache_',
            version: '1.1.0', // 更新版本号会强制刷新缓存
            expirationTime: 7 * 24 * 60 * 60 * 1000 // 7天过期
        };

        // 加载状态
        this.loaded = false;

        // 回调函数列表
        this.onLanguageChangeCallbacks = [];

        // 缺失翻译键记录（用于调试）
        this.missingKeys = new Set();
    }

    /**
     * 初始化国际化系统（带内联默认语言优化）
     */
    async init() {
        // 检测当前语言
        this.currentLang = this.detectLanguage();
        console.log(`[i18n] Initializing with language: ${this.currentLang}`);

        // 始终从 JSON 文件加载翻译（确保翻译数据最新）
        // 如果加载失败，使用内联翻译作为后备
        try {
            await this.loadLanguage(this.currentLang);
            
            // 验证加载的翻译数据是否完整
            const loadedData = this.translations[this.currentLang];
            if (!loadedData || !this.validateTranslations(loadedData)) {
                console.warn(`[i18n] Loaded translations for ${this.currentLang} seem incomplete, reloading...`);
                this.clearCache(this.currentLang);
                await this.loadLanguage(this.currentLang);
            }
        } catch (error) {
            console.warn('[i18n] Failed to load translations from JSON, using fallback:', error);
            if (this.currentLang === this.defaultLang) {
                this.translations[this.currentLang] = DEFAULT_TRANSLATIONS;
            }
        }

        // 更新 DOM
        this.updateDOM();

        // 更新 HTML lang 属性
        document.documentElement.lang = this.currentLang;

        this.loaded = true;
        console.log(`[i18n] Initialized successfully with ${Object.keys(this.translations[this.currentLang] || {}).length} top-level keys`);

        return this.currentLang;
    }

    /**
     * 验证翻译数据是否完整（检查关键键是否存在）
     */
    validateTranslations(data) {
        const requiredKeys = ['common', 'nav', 'settings', 'generate', 'batch', 'history'];
        for (const key of requiredKeys) {
            if (!data[key] || typeof data[key] !== 'object') {
                console.warn(`[i18n] Missing required key: ${key}`);
                return false;
            }
        }
        return true;
    }

    /**
     * 检测当前应该使用的语言
     * 优先级：URL查询参数 > URL路径 > localStorage > 浏览器语言 > 默认语言
     */
    detectLanguage() {
        // 1. 从 URL 查询参数检测 (例如: ?lang=en)
        const urlParams = new URLSearchParams(window.location.search);
        const queryLang = urlParams.get('lang');
        if (queryLang && this.languages[queryLang]) {
            // 保存到 localStorage
            localStorage.setItem('user_language', queryLang);
            return queryLang;
        }

        // 2. 从 URL 路径检测 (例如: /en/, /zh-TW/)
        const pathLang = this.detectLanguageFromPath();
        if (pathLang && this.languages[pathLang]) {
            return pathLang;
        }

        // 3. 从 localStorage 读取用户上次选择
        const savedLang = localStorage.getItem('user_language');
        if (savedLang && this.languages[savedLang]) {
            return savedLang;
        }

        // 4. 从浏览器语言检测
        const browserLang = this.detectBrowserLanguage();
        if (browserLang && this.languages[browserLang]) {
            return browserLang;
        }

        // 5. 返回默认语言
        return this.defaultLang;
    }

    /**
     * 从 URL 路径检测语言
     * 支持格式: /en/, /zh-TW/, /ru/
     */
    detectLanguageFromPath() {
        const path = window.location.pathname;

        // 匹配 /lang/ 格式
        const match = path.match(/^\/([a-z]{2}(?:-[A-Z]{2})?)\//);
        if (match) {
            return match[1];
        }

        // 匹配根路径下的语言子目录 (例如: /en, /zh-TW)
        const parts = path.split('/').filter(p => p);
        if (parts.length > 0) {
            const firstPart = parts[0];
            if (this.languages[firstPart]) {
                return firstPart;
            }
        }

        return null;
    }

    /**
     * 检测浏览器语言
     */
    detectBrowserLanguage() {
        const lang = navigator.language || navigator.userLanguage;

        // 精确匹配
        if (this.languages[lang]) {
            return lang;
        }

        // 模糊匹配 (例如: en-US -> en)
        const shortLang = lang.split('-')[0];
        if (this.languages[shortLang]) {
            return shortLang;
        }

        // 特殊处理中文
        if (lang.startsWith('zh')) {
            // zh-CN, zh-Hans -> 简体中文
            if (lang.includes('CN') || lang.includes('Hans') || lang.includes('SG')) {
                return 'zh-CN';
            }
            // zh-TW, zh-Hant, zh-HK -> 繁体中文
            if (lang.includes('TW') || lang.includes('Hant') || lang.includes('HK') || lang.includes('MO')) {
                return 'zh-TW';
            }
        }

        return null;
    }

    /**
     * 加载指定语言的翻译资源（带 localStorage 缓存优化）
     */
    async loadLanguage(lang) {
        // 如果内存中已加载，直接返回
        if (this.translations[lang]) {
            return this.translations[lang];
        }

        // 尝试从 localStorage 缓存加载
        if (this.cacheConfig.enabled) {
            const cached = this.loadFromLocalStorage(lang);
            if (cached) {
                console.log(`[i18n] Loaded ${lang} from localStorage cache`);
                this.translations[lang] = cached;
                return cached;
            }
        }

        try {
            // 添加时间戳防止浏览器缓存
            const cacheBuster = `?v=${Date.now()}`;
            // 使用相对路径，兼容 Electron 和 Web 环境
            const basePath = window.location.protocol === 'file:' ? './i18n/' : '/i18n/';
            const response = await fetch(`${basePath}${lang}.json${cacheBuster}`);
            if (!response.ok) {
                throw new Error(`Failed to load language file: ${lang}`);
            }

            const data = await response.json();
            this.translations[lang] = data;

            // 保存到 localStorage 缓存
            if (this.cacheConfig.enabled) {
                this.saveToLocalStorage(lang, data);
            }

            console.log(`[i18n] Loaded ${lang} from server`);
            return data;
        } catch (error) {
            console.error(`[i18n] Error loading language ${lang}:`, error);

            // 尝试从回退链加载
            const fallbacks = this.getFallbackLanguages(lang);
            for (const fallbackLang of fallbacks) {
                if (fallbackLang !== lang && !this.translations[fallbackLang]) {
                    console.log(`[i18n] Trying fallback language: ${fallbackLang}`);
                    try {
                        const fallbackData = await this.loadLanguage(fallbackLang);
                        if (fallbackData && this.validateTranslations(fallbackData)) {
                            return fallbackData;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            // 如果是默认语言加载失败，使用内联备用翻译
            if (lang === this.defaultLang) {
                console.warn('[i18n] Using inline fallback translations for default language');
                this.translations[lang] = DEFAULT_TRANSLATIONS;
                return DEFAULT_TRANSLATIONS;
            }

            // 最终回退到默认语言
            console.warn(`[i18n] Final fallback to default language: ${this.defaultLang}`);
            return this.loadLanguage(this.defaultLang);
        }
    }

    /**
     * 获取语言的回退链
     */
    getFallbackLanguages(lang) {
        if (this.fallbackLng[lang]) {
            return this.fallbackLng[lang];
        }
        return this.fallbackLng['default'] || [this.defaultLang];
    }

    /**
     * 从 localStorage 加载翻译缓存
     */
    loadFromLocalStorage(lang) {
        try {
            const cacheKey = this.cacheConfig.prefix + lang;
            const cached = localStorage.getItem(cacheKey);
            if (!cached) return null;

            const { data, timestamp, version } = JSON.parse(cached);
            
            // 检查版本号 - 版本不匹配则清除缓存
            if (version !== this.cacheConfig.version) {
                console.log(`[i18n] Cache version mismatch for ${lang} (cached: ${version}, current: ${this.cacheConfig.version})`);
                localStorage.removeItem(cacheKey);
                return null;
            }

            const isExpired = Date.now() - timestamp > this.cacheConfig.expirationTime;
            if (isExpired) {
                console.log(`[i18n] Cache expired for ${lang}`);
                localStorage.removeItem(cacheKey);
                return null;
            }

            // 验证缓存数据完整性
            if (!data || !this.validateTranslations(data)) {
                console.warn(`[i18n] Invalid cache data for ${lang}`);
                localStorage.removeItem(cacheKey);
                return null;
            }

            return data;
        } catch (e) {
            console.warn('[i18n] Failed to load from localStorage:', e);
            return null;
        }
    }

    /**
     * 保存翻译到 localStorage 缓存
     */
    saveToLocalStorage(lang, data) {
        try {
            const cacheKey = this.cacheConfig.prefix + lang;
            const cacheData = {
                data: data,
                timestamp: Date.now(),
                version: this.cacheConfig.version
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
            console.log(`[i18n] Saved ${lang} to localStorage cache (v${this.cacheConfig.version})`);
        } catch (e) {
            // localStorage 可能已满或不可用
            console.warn('[i18n] Failed to save to localStorage:', e);
        }
    }

    /**
     * 清除 localStorage 中的翻译缓存
     */
    clearLocalStorageCache(lang = null) {
        try {
            if (lang) {
                localStorage.removeItem(this.cacheConfig.prefix + lang);
            } else {
                // 清除所有 i18n 缓存
                Object.keys(localStorage)
                    .filter(key => key.startsWith(this.cacheConfig.prefix))
                    .forEach(key => localStorage.removeItem(key));
            }
            console.log(`[i18n] Cleared localStorage cache${lang ? ` for ${lang}` : ''}`);
        } catch (e) {
            console.warn('[i18n] Failed to clear localStorage cache:', e);
        }
    }

    /**
     * 翻译函数
     * @param {string} key - 翻译键，支持嵌套（例如: "common.appName"）
     * @param {object} params - 参数对象，用于替换占位符（例如: {count: 5}）
     * @returns {string} 翻译后的文本
     */
    t(key, params = {}) {
        if (!key) return '';

        // 获取当前语言的翻译数据
        let translations = this.translations[this.currentLang] || {};

        // 解析嵌套键
        const keys = key.split('.');
        let value = translations;

        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                // 尝试从回退语言查找
                value = this.findInFallbackLanguages(key);
                if (value !== null) {
                    break;
                }
                // 记录缺失的翻译键（用于调试）
                this.handleMissingKey(key);
                return key;
            }
        }

        // 如果值不是字符串，返回键名
        if (typeof value !== 'string') {
            this.handleMissingKey(key);
            return key;
        }

        // 替换参数占位符 (例如: "已选择 {count} 个模型" -> "已选择 3 个模型")
        let result = value;
        for (const [param, paramValue] of Object.entries(params)) {
            const placeholder = `{${param}}`;
            result = result.replace(new RegExp(placeholder, 'g'), paramValue);
        }

        return result;
    }

    /**
     * 从回退语言中查找翻译
     */
    findInFallbackLanguages(key) {
        const fallbacks = this.getFallbackLanguages(this.currentLang);
        
        for (const fallbackLang of fallbacks) {
            if (fallbackLang === this.currentLang) continue;
            
            const translations = this.translations[fallbackLang];
            if (!translations) continue;

            const keys = key.split('.');
            let value = translations;
            let found = true;

            for (const k of keys) {
                if (value && typeof value === 'object' && k in value) {
                    value = value[k];
                } else {
                    found = false;
                    break;
                }
            }

            if (found && typeof value === 'string') {
                return value;
            }
        }

        return null;
    }

    /**
     * 处理缺失的翻译键
     */
    handleMissingKey(key) {
        // 避免重复警告
        const cacheKey = `${this.currentLang}:${key}`;
        if (!this.missingKeys.has(cacheKey)) {
            this.missingKeys.add(cacheKey);
            console.warn(`[i18n] Missing translation: "${key}" (lang: ${this.currentLang})`);
            
            // 可选：在开发模式下收集缺失键用于后续补充
            if (typeof window !== 'undefined' && window.__i18nMissingKeys) {
                window.__i18nMissingKeys.push({ lang: this.currentLang, key });
            }
        }
    }

    /**
     * 获取所有缺失的翻译键（用于调试）
     */
    getMissingKeys() {
        return Array.from(this.missingKeys);
    }

    /**
     * 清除翻译缓存（内存 + localStorage）
     * @param {string} lang - 可选，指定清除某个语言的缓存，不指定则清除所有
     * @param {boolean} includeLocalStorage - 是否同时清除 localStorage 缓存，默认 true
     */
    clearCache(lang = null, includeLocalStorage = true) {
        if (lang) {
            delete this.translations[lang];
            // 清除该语言的缺失键记录
            this.missingKeys.forEach(key => {
                if (key.startsWith(`${lang}:`)) {
                    this.missingKeys.delete(key);
                }
            });
        } else {
            this.translations = {};
            this.missingKeys.clear();
        }

        // 同时清除 localStorage 缓存
        if (includeLocalStorage) {
            this.clearLocalStorageCache(lang);
        }
    }

    /**
     * 切换语言
     * @param {string} lang - 要切换到的语言代码
     * @param {boolean} updateURL - 是否更新 URL（默认 true）
     */
    async switchLanguage(lang, updateURL = true) {
        if (!this.languages[lang]) {
            console.error(`Unsupported language: ${lang}`);
            return false;
        }

        // 如果已经是当前语言，不做任何操作
        if (lang === this.currentLang) {
            return true;
        }

        // 清除目标语言的缓存，强制重新加载
        this.clearCache(lang);

        // 加载新语言资源
        await this.loadLanguage(lang);

        // 更新当前语言
        this.currentLang = lang;

        // 保存到 localStorage
        localStorage.setItem('user_language', lang);

        // 更新 DOM
        this.updateDOM();

        // 更新 HTML lang 属性
        document.documentElement.lang = lang;

        // 更新 URL
        if (updateURL) {
            this.updateURL(lang);
        }

        // 触发回调
        this.onLanguageChangeCallbacks.forEach(callback => {
            try {
                callback(lang);
            } catch (error) {
                console.error('Error in language change callback:', error);
            }
        });

        return true;
    }

    /**
     * 更新 URL 以反映当前语言
     */
    updateURL(lang) {
        const path = window.location.pathname;
        const hash = window.location.hash;
        const search = window.location.search;

        // 移除现有的语言前缀
        let newPath = path;
        Object.keys(this.languages).forEach(l => {
            const prefix = `/${l}/`;
            if (newPath.startsWith(prefix)) {
                newPath = newPath.substring(prefix.length - 1);
            }
            if (newPath === `/${l}`) {
                newPath = '/';
            }
        });

        // 添加新的语言前缀（默认语言不添加前缀）
        if (lang !== this.defaultLang) {
            newPath = `/${lang}${newPath}`;
        }

        // 更新浏览器历史记录
        const newURL = newPath + search + hash;
        if (newURL !== window.location.pathname + search + hash) {
            window.history.pushState({}, '', newURL);
        }
    }

    /**
     * 更新 DOM 中所有带 data-i18n 属性的元素
     */
    updateDOM() {
        // 更新文本内容
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) {
                el.textContent = this.t(key);
            }
        });

        // 更新属性（例如: placeholder, title, aria-label）
        document.querySelectorAll('[data-i18n-attr]').forEach(el => {
            const attrMap = el.getAttribute('data-i18n-attr');
            if (attrMap) {
                // 格式: "placeholder:key1,title:key2"
                const pairs = attrMap.split(',').map(p => p.trim());
                pairs.forEach(pair => {
                    const [attr, key] = pair.split(':').map(s => s.trim());
                    if (attr && key) {
                        el.setAttribute(attr, this.t(key));
                    }
                });
            }
        });

        // 更新 select 选项（特殊处理）
        this.updateSelectOptions();

        // 更新页面标题
        const titleKey = document.querySelector('meta[name="i18n-title"]');
        if (titleKey) {
            const key = titleKey.getAttribute('content');
            if (key) {
                document.title = this.t(key);
            }
        }

        // 更新 meta description
        const descKey = document.querySelector('meta[name="i18n-description"]');
        if (descKey) {
            const key = descKey.getAttribute('content');
            if (key) {
                const metaDesc = document.querySelector('meta[name="description"]');
                if (metaDesc) {
                    metaDesc.setAttribute('content', this.t(key));
                }
            }
        }
    }

    /**
     * 更新 select 选项内容
     */
    updateSelectOptions() {
        // 更新数量选择器
        const generateCount = document.getElementById('generateCount');
        if (generateCount) {
            Array.from(generateCount.options).forEach(option => {
                const value = option.value;
                const translated = this.t(`generate.quantityOptions.${value}`);
                if (translated && !translated.startsWith('generate.')) {
                    option.textContent = translated;
                }
            });
        }

        // 如果有其他需要更新的 select，可以在这里添加
    }

    /**
     * 注册语言切换回调
     */
    onLanguageChange(callback) {
        if (typeof callback === 'function') {
            this.onLanguageChangeCallbacks.push(callback);
        }
    }

    /**
     * 获取当前语言
     */
    getCurrentLanguage() {
        return this.currentLang;
    }

    /**
     * 获取所有支持的语言
     */
    getSupportedLanguages() {
        return this.languages;
    }

    /**
     * 获取语言显示名称
     */
    getLanguageName(lang, short = false) {
        const langInfo = this.languages[lang];
        if (!langInfo) return lang;
        return short ? langInfo.shortName : langInfo.name;
    }
}

// 创建全局 i18n 实例
const i18n = new I18n();

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = i18n;
}
