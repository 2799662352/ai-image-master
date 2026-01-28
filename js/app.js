// 主应用 - 模块化架构
class AIImageApp {
    constructor() {
        console.log('[CONSTRUCT] 🏗️ AIImageApp 构造函数开始执行...');
        try {
        this.currentTab = 'generate';
        this.history = []; // 先初始化为空数组，在 init 中异步加载
            this.pages = {};
            this.lastUploadInteraction = null; // 记录最后一次上传区域交互时间
            this.defaultRatios = [
                { key: '1:1', label: '方形 1:1' },
                { key: '2:3', label: '竖版 2:3' },
                { key: '3:2', label: '横版 3:2' }
            ];
            console.log('[CONSTRUCT] ✅ 基础属性初始化完成');
            this.init();
            console.log('[CONSTRUCT] ✅ 构造函数执行完成');
        } catch (error) {
            console.error('[CONSTRUCT] ❌ 构造函数执行失败:', error);
            throw error;
        }
    }

    // 初始化应用
    async init() {
        console.log('🚀 AIImageApp 开始初始化...');

        // ========== 关键路径：立即执行 ==========
        // 初始化国际化系统（最优先）
        await this.initI18n();

        this.initPages();          // 先初始化页面模块
        this.bindEvents();         // 再绑定事件（包括路由）
        this.loadStoredApiKey();   // 加载已保存的API Key并更新状态

        console.log('📌 准备初始化模型选择器...');
        this.initModelSelector();

        // 触发应用就绪事件（让加载器隐藏）
        console.log('✅ AIImageApp 关键初始化完成');
        window.appInitialized = true;
        window.dispatchEvent(new Event('appReady'));
        console.log('🎉 appReady 事件已触发');

        // ========== 非关键路径：延迟执行 ==========
        this.initNonCriticalFeatures();
    }

    // 初始化非关键功能（延迟执行）
    initNonCriticalFeatures() {
        // 使用 requestIdleCallback 在浏览器空闲时执行
        if (window.requestIdleCallback) {
            requestIdleCallback(() => {
                this.loadNonCriticalFeatures();
            }, { timeout: 2000 }); // 最多等待 2 秒
        } else {
            // 降级到 setTimeout
            setTimeout(() => {
                this.loadNonCriticalFeatures();
            }, 100);
        }
    }

    // 加载非关键功能
    async loadNonCriticalFeatures() {
        console.log('📦 开始加载非关键功能...');
        
        this.initFluxImageCache();
        this.initR2UploadListener(); // 初始化 R2 上传监听器
        
        // 异步加载历史记录（支持 StorageBridge）
        this.loadHistory().then(history => {
            this.history = history;
            this.autoMigrateHistory();  // 自动迁移历史记录
        }).catch(err => {
            console.error('加载历史记录失败:', err);
            this.history = [];
        });
        
        this.initVersionChecker();  // 初始化版本检测
        
        console.log('✅ 非关键功能加载完成');
    }

    // 初始化国际化系统（带超时保护）
    async initI18n() {
        try {
            console.log('[I18N] 开始初始化国际化系统...');
            
            // 设置超时：最多等待 1 秒
            const initPromise = i18n.init();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('I18N init timeout')), 1000)
            );
            
            const currentLang = await Promise.race([initPromise, timeoutPromise]);
            console.log(`[I18N] ✅ Language initialized: ${currentLang}`);

            // 保存 i18n 实例到 app
            this.i18n = i18n;

            // 注册语言切换回调
            i18n.onLanguageChange((lang) => {
                console.log(`Language changed to: ${lang}`);

                // 重新渲染动态生成的UI元素
                const currentModel = window.aiImageAPI?.getCurrentModel();
                if (currentModel) {
                    // 重新渲染比例按钮
                    this.renderRatioOptions(currentModel);
                    // 重新渲染分辨率按钮
                    this.renderResolutionOptions(currentModel);
                }

                // 更新模型选择器的 displayName（多语言）
                this.updateModelSelectorsDisplayName();

                // 通知所有页面模块语言已切换
                Object.values(this.pages || {}).forEach(page => {
                    if (page && typeof page.onLanguageChange === 'function') {
                        page.onLanguageChange(lang);
                    }
                });

                // 更新API状态显示
                this.updateApiStatus();

                // 更新SEO标签
                this.updateSEOForLanguage(lang);
            });

            // 初始化完成后，立即更新语言选择器显示
            this.updateLanguageSwitcherDisplay(currentLang);

            console.log('[I18N] ✅ 国际化系统初始化完成');
        } catch (error) {
            console.warn('[I18N] ⚠️ 国际化初始化失败或超时，使用默认语言:', error.message);
            // 降级：使用默认语言，不阻塞应用启动
            this.i18n = typeof i18n !== 'undefined' ? i18n : null;
            // 应用继续初始化，不抛出错误
        }
    }

    // 更新SEO标签
    updateSEOForLanguage(lang) {
        // 更新页面标题
        document.title = i18n.t('seo.title');

        // 更新 meta description
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute('content', i18n.t('seo.description'));
        }

        // 更新 meta keywords
        const metaKeywords = document.querySelector('meta[name="keywords"]');
        if (metaKeywords) {
            metaKeywords.setAttribute('content', i18n.t('seo.keywords'));
        }

        // 更新 Open Graph 标签
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
            ogTitle.setAttribute('content', i18n.t('seo.title'));
        }

        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc) {
            ogDesc.setAttribute('content', i18n.t('seo.description'));
        }

        // 更新 Twitter Card 标签
        const twitterTitle = document.querySelector('meta[name="twitter:title"]');
        if (twitterTitle) {
            twitterTitle.setAttribute('content', i18n.t('seo.title'));
        }

        const twitterDesc = document.querySelector('meta[name="twitter:description"]');
        if (twitterDesc) {
            twitterDesc.setAttribute('content', i18n.t('seo.description'));
        }
    }

    // 更新模型选择器的 displayName（用于多语言切换）
    updateModelSelectorsDisplayName() {
        // 更新导航栏的模型选择器（Choices.js 实例）
        const navDesktopSelector = document.getElementById('modelSelector');
        if (navDesktopSelector) {
            this.updateChoicesModelSelector(navDesktopSelector, this.desktopModelChoice);
        }

        const navMobileSelector = document.getElementById('modelSelectorMobile');
        if (navMobileSelector) {
            this.updateChoicesModelSelector(navMobileSelector, this.mobileModelChoice);
        }

        // 更新生成页面的模型选择器
        const selectGenerate = document.getElementById('modelSelect');
        if (selectGenerate) {
            this.updateSingleModelSelector(selectGenerate);
        }

        // 更新批量页面的模型选择器
        const selectBatch = document.getElementById('batchModelSelect');
        if (selectBatch) {
            this.updateSingleModelSelector(selectBatch);
        }
    }

    // 更新 Choices.js 实例的模型选择器
    updateChoicesModelSelector(selectElement, choicesInstance) {
        if (!selectElement || !this.api) return;

        const models = this.api.getAllModels();
        const currentValue = selectElement.value;

        // 更新每个选项的文本
        Array.from(selectElement.options).forEach(option => {
            const modelKey = option.value;
            const model = models[modelKey];
            if (model) {
                const displayName = typeof this.api.getModelDisplayName === 'function'
                    ? this.api.getModelDisplayName(modelKey)
                    : model.displayName;
                option.textContent = `${model.name} - ${displayName}`;
            }
        });

        // 如果存在 Choices 实例，重新设置选项以更新显示
        if (choicesInstance && typeof choicesInstance.setChoices === 'function') {
            const choices = Array.from(selectElement.options).map(option => ({
                value: option.value,
                label: option.textContent,
                selected: option.value === currentValue
            }));

            choicesInstance.clearStore();
            choicesInstance.setChoices(choices, 'value', 'label', true);
        }
    }

    // 更新单个模型选择器
    updateSingleModelSelector(selectElement) {
        if (!selectElement || !this.api) return;

        const models = this.api.getAllModels();
        const currentValue = selectElement.value;

        // 更新每个选项的文本
        Array.from(selectElement.options).forEach(option => {
            const modelKey = option.value;
            const model = models[modelKey];
            if (model) {
                const displayName = typeof this.api.getModelDisplayName === 'function'
                    ? this.api.getModelDisplayName(modelKey)
                    : model.displayName;
                option.textContent = `${model.name} - ${displayName}`;
            }
        });
    }

    // 初始化所有页面模块
    initPages() {
        // 创建各个页面实例
        this.pages = {
            generate: new GeneratePage(this),
            batch: new BatchPage(this),
            history: new HistoryPage(this),
            compare: new ComparePage(this),
            understand: new UnderstandPage(this),  // 图像理解页面
            director: new DirectorPage(this)  // 导演模式页面
        };

        // 初始化提示词模板模块
        this.promptTemplates = new PromptTemplates(this);

        // 设置全局引用便于其他模块访问
        window.generatePage = this.pages.generate;
        window.batchPage = this.pages.batch;
        window.comparePage = this.pages.compare;
        window.understandPage = this.pages.understand;  // 图像理解页面全局引用
        window.directorPage = this.pages.director;  // 导演模式页面全局引用
        window.promptTemplates = this.promptTemplates;
    }

    // 绑定主要事件监听器
    bindEvents() {
        // 设置模态框事件 - 添加安全检查
        const settingsBtn = document.getElementById('settingsBtn');
        // Note: closeSettingsX and saveApiConfig are handled in initSettingsModalEvents()

        if (settingsBtn) settingsBtn.addEventListener('click', () => this.openSettings());

        // 项目说明模态框事件 - 添加安全检查
        const aboutBtn = document.getElementById('aboutBtn');
        const aboutBtnFooter = document.getElementById('aboutBtnFooter');
        const closeAbout = document.getElementById('closeAbout');
        const closeAboutFooter = document.getElementById('closeAboutFooter');

        if (aboutBtn) aboutBtn.addEventListener('click', () => this.openAbout());
        if (aboutBtnFooter) aboutBtnFooter.addEventListener('click', () => this.openAbout());
        if (closeAbout) closeAbout.addEventListener('click', () => this.closeAbout());
        if (closeAboutFooter) closeAboutFooter.addEventListener('click', () => this.closeAbout());

        // 活动弹窗事件 - 添加安全检查
        const activityBtn = document.getElementById('activityBtn');
        const closeActivity = document.getElementById('closeActivity');
        const closeActivityFooter = document.getElementById('closeActivityFooter');

        if (activityBtn) activityBtn.addEventListener('click', () => this.openActivity());
        if (closeActivity) closeActivity.addEventListener('click', () => this.closeActivity());
        if (closeActivityFooter) closeActivityFooter.addEventListener('click', () => this.closeActivity());

        // 标签切换事件
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // 使用 currentTarget 确保获取到按钮本身的 data-tab 属性
                const tabName = e.currentTarget.dataset.tab;
                if (tabName) {
                    this.switchTab(tabName, true); // 添加参数表示是用户点击
                } else {
                    console.warn('按钮缺少 data-tab 属性:', e.currentTarget);
                }
            });
        });

        // 监听 URL hash 变化
        window.addEventListener('hashchange', () => {
            this.handleHashChange();
        });

        // 初始化时处理当前 URL hash
        this.handleHashChange();

        // 模态框外部点击关闭 - 添加安全检查
        // Note: settingsModal click handling is now in initSettingsModalEvents()

        // 项目说明模态框外部点击关闭 - 添加安全检查
        const aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
            aboutModal.addEventListener('click', (e) => {
                if (e.target.id === 'aboutModal') {
                    this.closeAbout();
                }
            });
        }

        // 活动弹窗外部点击关闭 - 添加安全检查
        const activityModal = document.getElementById('activityModal');
        if (activityModal) {
            activityModal.addEventListener('click', (e) => {
                if (e.target.id === 'activityModal') {
                    this.closeActivity();
                }
            });
        }

        // 键盘快捷键
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
        
        // 统一处理粘贴事件
        document.addEventListener('paste', (e) => this.handlePaste(e));

        // 模型选择器现在由 Choices.js 管理，无需手动绑定事件

        // 语言切换器事件
        const languageSwitcher = document.getElementById('languageSwitcher');
        if (languageSwitcher) {
            languageSwitcher.addEventListener('click', () => this.toggleLanguageDropdown());
        }

        // 语言选项点击事件（桌面端）
        document.querySelectorAll('#languageList button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const lang = e.currentTarget.dataset.lang;
                if (lang) {
                    this.switchLanguage(lang);
                }
            });
        });

        // 语言选项点击事件（移动端）
        document.querySelectorAll('#languageListMobile .language-option-mobile').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const lang = e.currentTarget.dataset.lang;
                if (lang) {
                    this.switchLanguage(lang);
                    // 关闭移动端菜单
                    this.closeMobileMenu();
                }
            });
        });

        // 点击外部关闭语言下拉菜单
        document.addEventListener('click', (e) => {
            const langDropdown = document.getElementById('languageDropdown');

            // 关闭语言下拉菜单
            if (langDropdown && !langDropdown.classList.contains('hidden')) {
                if (!e.target.closest('#languageSwitcher') &&
                    !e.target.closest('#languageDropdown')) {
                    this.closeLanguageDropdown();
                }
            }
        });

        // 移动端菜单相关事件
        this.bindMobileMenuEvents();
        
        // 绑定上传区域交互跟踪
        this.bindUploadInteractionTracking();
        
        // 绑定禁用元素的增强悬浮提示
        this.bindEnhancedTooltips();
        
        // 监听网络受限图片事件
        this.bindNetworkRestrictedImageEvents();
    }

    // 绑定移动端菜单事件
    bindMobileMenuEvents() {
        // 移动端菜单切换按钮
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => this.toggleMobileMenu());
        }

        // 移动端模型选择器现在由 Choices.js 管理，无需手动绑定事件

        // 移动端说明按钮
        const aboutBtnMobile = document.getElementById('aboutBtnMobile');
        if (aboutBtnMobile) {
            aboutBtnMobile.addEventListener('click', () => this.openAbout());
        }

        // 移动端设置按钮
        const settingsBtnMobile = document.getElementById('settingsBtnMobile');
        if (settingsBtnMobile) {
            settingsBtnMobile.addEventListener('click', () => this.openSettings());
        }

        // 移动端活动按钮
        const activityBtnMobile = document.getElementById('activityBtnMobile');
        if (activityBtnMobile) {
            activityBtnMobile.addEventListener('click', () => this.openActivity());
        }

        // 监听屏幕尺寸变化，自动关闭移动端菜单
        window.addEventListener('resize', () => {
            if (window.innerWidth >= 768) { // md断点
                this.closeMobileMenu();
            }
        });
    }

    // 切换移动端菜单
    toggleMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const isHidden = mobileMenu.classList.contains('hidden');
        
        if (isHidden) {
            this.openMobileMenu();
        } else {
            this.closeMobileMenu();
        }
    }

    // 打开移动端菜单
    openMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const menuLines = ['menuLine1', 'menuLine2', 'menuLine3'];
        
        // 显示菜单
        mobileMenu.classList.remove('hidden');
        
        // 汉堡菜单变成X的动画
        const line1 = document.getElementById('menuLine1');
        const line2 = document.getElementById('menuLine2');
        const line3 = document.getElementById('menuLine3');
        
        if (line1 && line2 && line3) {
            line1.style.transform = 'rotate(45deg) translate(5px, 5px)';
            line2.style.opacity = '0';
            line3.style.transform = 'rotate(-45deg) translate(7px, -6px)';
        }
    }

    // 关闭移动端菜单
    closeMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        
        // 隐藏菜单
        mobileMenu.classList.add('hidden');

        // 模型下拉菜单由 Choices.js 自动管理，无需手动关闭

        // 重置汉堡菜单动画
        const line1 = document.getElementById('menuLine1');
        const line2 = document.getElementById('menuLine2');
        const line3 = document.getElementById('menuLine3');
        
        if (line1 && line2 && line3) {
            line1.style.transform = '';
            line2.style.opacity = '';
            line3.style.transform = '';
        }
    }

    // 处理 URL hash 变化
    handleHashChange() {
        const hash = window.location.hash.slice(1); // 移除 # 号
        const validTabs = ['generate', 'batch', 'compare', 'history', 'understand'];

        if (hash && validTabs.includes(hash)) {
            // 切换到指定的标签，但不更新 URL（避免循环）
            this.switchTab(hash, false);
        } else if (!hash) {
            // 如果没有 hash，默认显示第一个标签
            this.switchTab('generate', false);
        }
    }

    // 加载存储的API Key
    loadStoredApiKey() {
        // 加载图片生成 API Key
        const apiKey = window.aiImageAPI.getStoredApiKey();
        if (apiKey) {
            document.getElementById('apiKeyInput').value = apiKey;
            this.updateApiStatus(true);
        }

        // 加载图像理解 API Key
        const visionApiKey = window.aiImageAPI.getStoredVisionApiKey();
        const visionInput = document.getElementById('visionApiKeyInput');
        if (visionInput) {
            // 无论是否有值，都设置输入框（确保清空已删除的 Key）
            visionInput.value = visionApiKey || '';
        }
    }

    // 初始化模型选择器 - 使用 Choices.js
    initModelSelector(retryCount = 0) {
        const MAX_RETRIES = 30; // 最多重试 30 次（3 秒）
        
        console.log('🚀 初始化模型选择器（Choices.js）');

        // 等待 Choices.js 加载完成
        if (typeof Choices === 'undefined') {
            if (retryCount >= MAX_RETRIES) {
                console.error('❌ Choices.js 加载超时，放弃初始化模型选择器');
                return;
            }
            console.warn(`⏳ Choices.js 未加载，延迟初始化... (${retryCount + 1}/${MAX_RETRIES})`);
            setTimeout(() => this.initModelSelector(retryCount + 1), 100);
            return;
        }

        // 检查 DOM 元素是否存在
        const desktopSelector = document.getElementById('modelSelector');
        const mobileSelector = document.getElementById('modelSelectorMobile');

        if (!desktopSelector || !mobileSelector) {
            console.warn('⏳ DOM 元素未就绪，延迟初始化...', {
                desktop: !!desktopSelector,
                mobile: !!mobileSelector
            });
            setTimeout(() => this.initModelSelector(), 100);
            return;
        }

        try {
            // 获取所有模型
            const models = window.aiImageAPI.getAllModels();
            const currentModelKey = window.aiImageAPI.model;

            console.log('📊 当前模型:', currentModelKey, '所有模型数:', Object.keys(models).length);

            // 初始化桌面端选择器
            this.initDesktopModelSelector(models, currentModelKey);

            // 初始化移动端选择器
            this.initMobileModelSelector(models, currentModelKey);

            // 更新UI状态
            this.updateUIForModel();

            console.log('✅ 模型选择器初始化完成');
        } catch (error) {
            console.error('❌ 模型选择器初始化失败:', error);
        }
    }

    // 初始化桌面端模型选择器
    initDesktopModelSelector(models, currentModelKey) {
        const selectElement = document.getElementById('modelSelector');
        if (!selectElement) {
            console.error('❌ 桌面端模型选择器元素未找到');
            return;
        }

        console.log('🖥️ 初始化桌面端模型选择器');

        // 如果已有 Choices 实例,先销毁
        if (this.desktopModelChoice) {
            console.log('🗑️ 销毁旧的桌面端 Choices 实例');
            this.desktopModelChoice.destroy();
            this.desktopModelChoice = null;
        }

        // 清空现有选项
        selectElement.innerHTML = '';

        // 填充选项
        Object.keys(models).forEach(modelKey => {
            const model = models[modelKey];
            const option = document.createElement('option');
            option.value = modelKey;
            // 使用翻译后的 displayName（如果 API 已初始化）
            const displayName = this.api && typeof this.api.getModelDisplayName === 'function'
                ? this.api.getModelDisplayName(modelKey)
                : model.displayName;
            option.textContent = `${model.name} - ${displayName}`;

            if (modelKey === currentModelKey) {
                option.selected = true;
            }

            selectElement.appendChild(option);
        });

        // 保存 this 引用以便在回调中使用
        const self = this;

        // 初始化 Choices.js
        this.desktopModelChoice = new Choices(selectElement, {
            searchEnabled: false,
            itemSelectText: '',
            shouldSort: false,
            position: 'bottom',
            renderChoiceLimit: -1,
            allowHTML: true,
            removeItemButton: false, // 禁用删除按钮
            callbackOnInit: function() {
                console.log('🎉 桌面端 Choices 实例初始化完成');
            },
            callbackOnCreateTemplates: function(template) {
                return {
                    // 选中项的显示模板
                    item: ({ classNames }, data) => {
                        const modelName = data.label.split(' - ')[0];
                        return template(`
                            <div class="${classNames.item}" style="display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-robot" style="font-size: 17px;"></i>
                                <span style="font-size: 16px; font-weight: 500;">${modelName}</span>
                            </div>
                        `);
                    },
                    // 下拉选项的显示模板
                    choice: ({ classNames }, data) => {
                        const parts = data.label.split(' - ');
                        const name = parts[0] || '';
                        const desc = parts[1] || '';

                        // 获取模型信息以显示徽章
                        const modelKey = data.value;
                        const modelInfo = window.aiImageAPI?.models?.[modelKey];

                        // 构建徽章 HTML
                        let badges = '';
                        if (modelInfo) {
                            if (modelInfo.time) {
                                badges += `<span class="model-badge model-badge-time">⏱ ${modelInfo.time}</span>`;
                            }
                            if (modelInfo.isNew) {
                                badges += `<span class="model-badge model-badge-new">New</span>`;
                            }
                        }

                        return template(`
                            <div class="${classNames.item} ${classNames.itemChoice} ${data.disabled ? classNames.itemDisabled : classNames.itemSelectable}" data-select-text="${this.config.itemSelectText}" data-choice ${data.disabled ? 'data-choice-disabled aria-disabled="true"' : 'data-choice-selectable'} data-id="${data.id}" data-value="${data.value}" ${data.groupId > 0 ? 'role="treeitem"' : 'role="option"'}>
                                <div class="model-header">
                                    <div class="model-name">${name}</div>
                                    ${badges ? `<div class="model-badges">${badges}</div>` : ''}
                                </div>
                                ${desc ? `<div class="model-desc">${desc}</div>` : ''}
                            </div>
                        `);
                    }
                };
            }
        });

        console.log('📋 准备绑定桌面端事件监听器');

        // 使用箭头函数保持 this 上下文
        const handleChoice = (event) => {
            console.log('🖥️ Choices choice 事件触发:', event);
            console.log('🖥️ Event detail:', event.detail);

            if (event.detail && event.detail.choice && event.detail.choice.value) {
                const selectedModel = event.detail.choice.value;
                console.log('🖥️ 桌面端模型已切换:', selectedModel);
                self.switchModel(selectedModel);
            } else {
                console.warn('⚠️ choice 事件没有包含有效的 choice 对象');
            }
        };

        const handleChange = (event) => {
            console.log('🖥️ change 事件触发, value:', event.target.value);
            // change 事件也可以触发切换
            if (event.target.value) {
                console.log('🖥️ 通过 change 事件切换模型:', event.target.value);
                self.switchModel(event.target.value);
            }
        };

        // 监听 Choices.js 的自定义事件
        selectElement.addEventListener('choice', handleChoice);
        selectElement.addEventListener('change', handleChange);

        console.log('✅ 桌面端事件监听器已绑定');
        console.log('📊 Choices 实例状态:', {
            initialized: !!this.desktopModelChoice,
            element: selectElement.id,
            optionCount: selectElement.options.length
        });
        console.log('✅ 桌面端模型选择器初始化完成');
    }

    // 初始化移动端模型选择器
    initMobileModelSelector(models, currentModelKey) {
        const selectElement = document.getElementById('modelSelectorMobile');
        if (!selectElement) {
            console.error('❌ 移动端模型选择器元素未找到');
            return;
        }

        console.log('📱 初始化移动端模型选择器');

        // 如果已有 Choices 实例,先销毁
        if (this.mobileModelChoice) {
            console.log('🗑️ 销毁旧的移动端 Choices 实例');
            this.mobileModelChoice.destroy();
            this.mobileModelChoice = null;
        }

        // 清空现有选项
        selectElement.innerHTML = '';

        // 填充选项
        Object.keys(models).forEach(modelKey => {
            const model = models[modelKey];
            const option = document.createElement('option');
            option.value = modelKey;
            // 使用翻译后的 displayName（如果 API 已初始化）
            const displayName = this.api && typeof this.api.getModelDisplayName === 'function'
                ? this.api.getModelDisplayName(modelKey)
                : model.displayName;
            option.textContent = `${model.name} - ${displayName}`;

            if (modelKey === currentModelKey) {
                option.selected = true;
            }

            selectElement.appendChild(option);
        });

        // 保存 this 引用
        const self = this;

        // 初始化 Choices.js（移动端禁用搜索）
        this.mobileModelChoice = new Choices(selectElement, {
            searchEnabled: false,
            itemSelectText: '',
            shouldSort: false,
            position: 'bottom',
            renderChoiceLimit: -1,
            allowHTML: true,
            removeItemButton: false, // 禁用删除按钮
            callbackOnCreateTemplates: function(template) {
                return {
                    item: ({ classNames }, data) => {
                        const modelName = data.label.split(' - ')[0];
                        return template(`
                            <div class="${classNames.item}" style="display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-robot" style="font-size: 17px;"></i>
                                <span style="font-size: 16px; font-weight: 500;">${modelName}</span>
                            </div>
                        `);
                    },
                    choice: ({ classNames }, data) => {
                        const parts = data.label.split(' - ');
                        const name = parts[0] || '';
                        const desc = parts[1] || '';

                        // 获取模型信息以显示徽章
                        const modelKey = data.value;
                        const modelInfo = window.aiImageAPI?.models?.[modelKey];

                        // 构建徽章 HTML
                        let badges = '';
                        if (modelInfo) {
                            if (modelInfo.time) {
                                badges += `<span class="model-badge model-badge-time">⏱ ${modelInfo.time}</span>`;
                            }
                            if (modelInfo.isNew) {
                                badges += `<span class="model-badge model-badge-new">New</span>`;
                            }
                        }

                        return template(`
                            <div class="${classNames.item} ${classNames.itemChoice} ${data.disabled ? classNames.itemDisabled : classNames.itemSelectable}" data-select-text="${this.config.itemSelectText}" data-choice ${data.disabled ? 'data-choice-disabled aria-disabled="true"' : 'data-choice-selectable'} data-id="${data.id}" data-value="${data.value}" ${data.groupId > 0 ? 'role="treeitem"' : 'role="option"'}>
                                <div class="model-header">
                                    <div class="model-name">${name}</div>
                                    ${badges ? `<div class="model-badges">${badges}</div>` : ''}
                                </div>
                                ${desc ? `<div class="model-desc">${desc}</div>` : ''}
                            </div>
                        `);
                    }
                };
            }
        });

        console.log('📋 准备绑定移动端事件监听器');

        // 使用箭头函数保持 this 上下文（self 已在上面声明）
        const handleChoice = (event) => {
            console.log('📱 Choices choice 事件触发:', event);
            console.log('📱 Event detail:', event.detail);

            if (event.detail && event.detail.choice && event.detail.choice.value) {
                const selectedModel = event.detail.choice.value;
                console.log('📱 移动端模型已切换:', selectedModel);
                self.switchModel(selectedModel);
            } else {
                console.warn('⚠️ choice 事件没有包含有效的 choice 对象');
            }
        };

        const handleChange = (event) => {
            console.log('📱 change 事件触发, value:', event.target.value);
            // change 事件也可以触发切换
            if (event.target.value) {
                console.log('📱 通过 change 事件切换模型:', event.target.value);
                self.switchModel(event.target.value);
            }
        };

        // 监听 Choices.js 的自定义事件
        selectElement.addEventListener('choice', handleChoice);
        selectElement.addEventListener('change', handleChange);

        console.log('✅ 移动端事件监听器已绑定');
        console.log('📊 Choices 实例状态:', {
            initialized: !!this.mobileModelChoice,
            element: selectElement.id,
            optionCount: selectElement.options.length
        });
        console.log('✅ 移动端模型选择器初始化完成');
    }

    // 切换模型
    switchModel(modelName) {
        console.log('🔄 切换模型到:', modelName);

        if (window.aiImageAPI.saveModel(modelName)) {
            // 更新两个选择器的值（确保同步）
            if (this.desktopModelChoice) {
                this.desktopModelChoice.setChoiceByValue(modelName);
            }
            if (this.mobileModelChoice) {
                this.mobileModelChoice.setChoiceByValue(modelName);
            }

            // 更新 UI
            this.updateUIForModel();

            const currentModel = window.aiImageAPI.getCurrentModel();
            this.showToast(`已切换到模型: ${currentModel.name}`, 'success');

            // 如果在生成页面，更新参考图片限制显示
            if (this.currentTab === 'generate' && this.generatePage) {
                this.generatePage.updateReferenceImageLimitDisplay();
                this.generatePage.updateReferenceImagesPreview();
            }

            // 如果在批量页面，更新抽卡模式的费用预估和默认尺寸
            if (this.currentTab === 'batch' && this.pages.batch) {
                this.pages.batch.onModelChanged();
            }

            console.log('✅ 模型切换完成');
        } else {
            this.showToast('模型切换失败', 'error');
        }
    }

    // 根据当前模型能力更新UI
    updateUIForModel() {
        const currentModel = window.aiImageAPI.getCurrentModel();
        const capabilities = currentModel.capabilities || { multipleImages: true, customSize: true };
        
        console.log('🔄 更新UI - 当前模型:', currentModel.name, '能力:', capabilities);
        
        // 重新渲染比例选项
        this.renderRatioOptions(currentModel);
        this.renderBatchRatioOptions(currentModel);
        
        // 渲染分辨率选项（如果模型支持）
        this.renderResolutionOptions(currentModel);
        
        // 控制数量选择器（Seedream 固定为1）
        this.toggleCountSelectors(!capabilities.multipleImages);
        this.setupSeedreamCountHint(currentModel);
        
        // 控制尺寸选择器  
        this.toggleSizeSelectors(!capabilities.customSize, capabilities.intelligentResize);
    }

    setupSeedreamCountHint(modelConfig) {
        const isSeedream = modelConfig && modelConfig.name && modelConfig.name.toLowerCase().includes('seedream');
        const batchCountLabel = document.getElementById('batchCountLabel');
        let hint = document.getElementById('batchCountHint');

        if (!batchCountLabel) {
            return;
        }

        if (isSeedream) {
            const message = 'Seedream 模型支持一次生成多张，每张按单价计费（最多 15 张）。如需批量多图，请分批提交任务。';

            if (!hint) {
                hint = document.createElement('button');
                hint.id = 'batchCountHint';
                hint.type = 'button';
                hint.className = 'ml-2 w-4 h-4 flex items-center justify-center text-orange-200 hover:text-orange-100 transition-colors';
                hint.innerHTML = `<i class="fas fa-question-circle"></i>`;
                hint.title = message;
                hint.setAttribute('aria-label', message);
                hint.addEventListener('click', () => {
                    this.showToast(message, 'info');
                });
                batchCountLabel.appendChild(hint);
            } else {
                hint.title = message;
                hint.setAttribute('aria-label', message);
            }
        } else if (hint) {
            hint.remove();
        }
    }

    // 渲染单图生成比例按钮
    renderRatioOptions(modelConfig) {
        const ratioContainer = document.getElementById('ratioButtons');
        if (!ratioContainer) {
            return;
        }

        const ratios = Array.isArray(modelConfig.ratios) && modelConfig.ratios.length > 0
            ? modelConfig.ratios
            : this.defaultRatios;

        const generatePage = this.pages?.generate || window.generatePage;
        let currentRatio = generatePage?.currentRatio || ratios[0].key;

        if (!ratios.some(ratio => ratio.key === currentRatio)) {
            currentRatio = ratios[0].key;
            if (generatePage) {
                generatePage.currentRatio = currentRatio;
            }
        }

        ratioContainer.className = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2';
        ratioContainer.innerHTML = '';

        ratios.forEach(ratio => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.ratio = ratio.key;
            button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${ratio.key === currentRatio ? 'active' : ''}`;

            // 尝试从 i18n 获取翻译，如果没有则使用原始值
            let label, subtitle;
            try {
                const i18nKey = `aspectRatios.${ratio.key}`;
                const translated = i18n.translations[i18n.currentLang]?.aspectRatios?.[ratio.key];
                if (translated) {
                    label = `${translated.label} ${ratio.key}`;
                    subtitle = translated.description || ratio.key;
                } else {
                    label = ratio.label || `比例 ${ratio.key}`;
                    subtitle = ratio.description || ratio.key;
                }
            } catch (e) {
                label = ratio.label || `比例 ${ratio.key}`;
                subtitle = ratio.description || ratio.key;
            }

            if (subtitle && subtitle !== ratio.key) {
                button.title = `${label} · ${subtitle}`;
            } else {
                button.title = label;
            }
            button.innerHTML = `
                <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
                    <span>${label}</span>
                    <span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>
                </div>
            `;
            ratioContainer.appendChild(button);
        });

        if (generatePage) {
            generatePage.selectRatio(currentRatio);
        }
    }

    // 渲染分辨率选项
    renderResolutionOptions(modelConfig) {
        const resolutionContainer = document.getElementById('resolutionContainer');
        const resolutionButtons = document.getElementById('resolutionButtons');
        
        if (!resolutionContainer || !resolutionButtons) {
            return;
        }

        // 检查模型是否支持分辨率控制
        if (!modelConfig.capabilities?.resolutionControl || !modelConfig.resolutions) {
            // 不支持的模型隐藏分辨率选择器
            resolutionContainer.classList.add('hidden');
            return;
        }

        // 支持的模型显示分辨率选择器
        resolutionContainer.classList.remove('hidden');

        const resolutions = modelConfig.resolutions;
        const generatePage = this.pages?.generate || window.generatePage;
        
        // 从 localStorage 读取保存的分辨率，如果没有则使用默认值
        let currentResolution = null;
        try {
            currentResolution = localStorage.getItem('gemini_resolution');
        } catch (error) {
            console.error('读取分辨率设置失败:', error);
        }
        
        // 如果没有保存的分辨率或不在可用列表中，使用默认值
        if (!currentResolution || !resolutions.some(res => res.key === currentResolution)) {
            currentResolution = modelConfig.defaultResolution || resolutions[0].key;
        }

        // 更新 generatePage 的当前分辨率
        if (generatePage) {
            generatePage.currentResolution = currentResolution;
        }

        // 清空并渲染分辨率按钮
        resolutionButtons.innerHTML = '';

        resolutions.forEach(resolution => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.resolution = resolution.key;
            button.className = `ratio-btn text-white py-2 px-2 md:px-4 rounded-md transition-all text-xs md:text-sm ${resolution.key === currentResolution ? 'active' : ''}`;

            // 尝试从 i18n 获取翻译，如果没有则使用原始值
            let label, subtitle;
            try {
                const translated = i18n.translations[i18n.currentLang]?.resolutions?.[resolution.key];
                if (translated) {
                    label = translated.label;
                    subtitle = translated.description || '';
                } else {
                    label = resolution.label || resolution.key;
                    subtitle = resolution.description || '';
                }
            } catch (e) {
                label = resolution.label || resolution.key;
                subtitle = resolution.description || '';
            }

            if (subtitle) {
                button.title = `${label} · ${subtitle}`;
            } else {
                button.title = label;
            }
            button.innerHTML = `
                <div class="flex flex-col md:flex-row items-center justify-center space-y-0.5 md:space-y-0 md:space-x-1">
                    <span>${label}</span>
                    ${subtitle ? `<span class="text-[11px] opacity-70 md:text-xs">${subtitle}</span>` : ''}
                </div>
            `;
            resolutionButtons.appendChild(button);
        });

        // 选中当前分辨率
        if (generatePage) {
            generatePage.selectResolution(currentResolution);
            // 初始化最终分辨率显示
            generatePage.updateFinalResolutionDisplay();
        }
    }

    // 渲染批量生成比例选项
    renderBatchRatioOptions(modelConfig) {
        const batchRatioSelect = document.getElementById('batchRatio');
        if (!batchRatioSelect || batchRatioSelect.classList.contains('intelligent-batch-display')) {
            return;
        }

        const ratios = Array.isArray(modelConfig.ratios) && modelConfig.ratios.length > 0
            ? modelConfig.ratios
            : this.defaultRatios;

        const previousValue = batchRatioSelect.value;
        const generatePage = this.pages?.generate || window.generatePage;
        const preferredRatio = generatePage?.currentRatio;
        batchRatioSelect.innerHTML = '';

        ratios.forEach(ratio => {
            const option = document.createElement('option');
            option.value = ratio.key;
            const label = ratio.label || ratio.key;
            const fullLabel = ratio.description ? `${label} ${ratio.description}` : label;
            option.textContent = fullLabel;
            option.label = label;
            option.dataset.shortLabel = label;
            option.dataset.fullLabel = fullLabel;
            batchRatioSelect.appendChild(option);
        });

        let targetValue = ratios[0].key;
        if (previousValue && ratios.some(ratio => ratio.key === previousValue)) {
            targetValue = previousValue;
        } else if (preferredRatio && ratios.some(ratio => ratio.key === preferredRatio)) {
            targetValue = preferredRatio;
        }
        batchRatioSelect.value = targetValue;

        this.updateBatchRatioTitle(batchRatioSelect);

        if (!batchRatioSelect.dataset.shortLabelListenerAttached) {
            batchRatioSelect.addEventListener('change', () => {
                this.updateBatchRatioTitle(batchRatioSelect);
            });
            batchRatioSelect.dataset.shortLabelListenerAttached = 'true';
        }
    }

    updateBatchRatioTitle(selectElement) {
        const option = selectElement.selectedOptions[0];
        if (!option) return;
        const fullLabel = option.dataset.fullLabel || option.textContent;
        selectElement.title = fullLabel;
    }

    // 切换数量选择器状态
    toggleCountSelectors(disabled) {
        const selectors = [
            { id: '#generateCount', tooltip: '当前模型仅支持生成1张图片' },
            { id: '#editCount', tooltip: '当前模型仅支持生成1张图片' },
            { id: '#batchCount', tooltip: '当前模型仅支持生成1张图片' }
        ];
        
        selectors.forEach(({ id, tooltip }) => {
            const element = document.querySelector(id);
            if (!element) return;

            const model = window.aiImageAPI.getCurrentModel();
            const isSeedream = model && model.name && model.name.toLowerCase().includes('seedream');

            const shouldDisable = disabled || (isSeedream && (id === '#batchCount' || id === '#generateCount'));
            element.disabled = shouldDisable;

            if (shouldDisable) {
                element.value = '1';
                element.style.opacity = '0.4';
                element.style.backgroundColor = '#f3f4f6';
                element.style.color = '#9ca3af';
                element.style.cursor = 'not-allowed';
                const finalTooltip = isSeedream && id === '#batchCount'
                    ? 'Seedream 模型一次最多生成 15 张，每张按单价计费'
                    : isSeedream && id === '#generateCount'
                        ? 'Seedream 模型按张计费，建议一次生成 1 张'
                    : tooltip;
                element.title = finalTooltip;
                element.setAttribute('data-disabled-tooltip', finalTooltip);
                this.addDisabledIndicator(element, 'lock');
            } else {
                element.style.opacity = '1';
                element.style.backgroundColor = '';
                element.style.color = '';
                element.style.cursor = '';
                element.title = '';
                element.removeAttribute('data-disabled-tooltip');
                this.removeDisabledIndicator(element);
            }
        });
    }

    // 切换尺寸选择器状态
    toggleSizeSelectors(disabled, intelligentResize = false) {
        console.log('切换尺寸选择器状态:', { disabled, intelligentResize });
        
        if (intelligentResize) {
            // Gemini智能尺寸模式：显示智能尺寸信息
            this.setupIntelligentResizeMode();
            // 注意：不要 return，还需要处理批量页面
        }
        
        // 确保显示原来的尺寸选择按钮容器（非智能模式时）
        if (!intelligentResize) {
            const ratioButtonsContainer = document.querySelector('.ratio-btn').closest('div');
            if (ratioButtonsContainer) {
                ratioButtonsContainer.style.display = '';
            }
            
            // 移除智能尺寸提示（非智能模式时）
            const intelligentHint = document.querySelector('.intelligent-resize-hint');
            if (intelligentHint) {
                intelligentHint.remove();
            }
        }
        
        const tooltip = '当前模型不支持自定义尺寸';
        
        // 生成页面的比例按钮（非智能模式时才处理）- 只影响宽高比按钮
        if (!intelligentResize) {
            document.querySelectorAll('#ratioButtons .ratio-btn').forEach(btn => {
                if (disabled) {
                btn.style.opacity = '0.3';
                btn.style.pointerEvents = 'none';
                btn.style.backgroundColor = '#f3f4f6';
                btn.style.color = '#9ca3af';
                btn.style.cursor = 'not-allowed';
                btn.style.filter = 'grayscale(1)';
                btn.title = tooltip;
                btn.setAttribute('data-disabled-tooltip', tooltip);
                
                // 确保选中1:1比例
                if (btn.dataset.ratio === '1:1') {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
                
                // 添加禁用图标指示器
                this.addDisabledIndicator(btn, 'ban');
            } else {
                btn.style.opacity = '1';
                btn.style.pointerEvents = 'auto';
                btn.style.backgroundColor = '';
                btn.style.color = '';
                btn.style.cursor = '';
                btn.style.filter = '';
                btn.title = '';
                btn.removeAttribute('data-disabled-tooltip');
                
                // 移除禁用图标指示器
                this.removeDisabledIndicator(btn);
            }
            });
        }
        
        // 编辑页面的比例按钮（非智能模式时才处理）
        if (!intelligentResize) {
        document.querySelectorAll('.edit-ratio-btn').forEach(btn => {
            if (disabled) {
                btn.style.opacity = '0.3';
                btn.style.pointerEvents = 'none';
                btn.style.backgroundColor = '#f3f4f6';
                btn.style.color = '#9ca3af';
                btn.style.cursor = 'not-allowed';
                btn.style.filter = 'grayscale(1)';
                btn.title = tooltip;
                btn.setAttribute('data-disabled-tooltip', tooltip);
                
                // 确保选中1:1比例
                if (btn.dataset.ratio === '1:1') {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
                
                // 添加禁用图标指示器
                this.addDisabledIndicator(btn, 'ban');
            } else {
                btn.style.opacity = '1';
                btn.style.pointerEvents = 'auto';
                btn.style.backgroundColor = '';
                btn.style.color = '';
                btn.style.cursor = '';
                btn.style.filter = '';
                btn.title = '';
                btn.removeAttribute('data-disabled-tooltip');
                
                // 移除禁用图标指示器
                this.removeDisabledIndicator(btn);
            }
            });
        }

        // 批量页面的尺寸选择器
        const batchRatioSelect = document.getElementById('batchRatio');
        if (batchRatioSelect) {
            if (intelligentResize) {
                // Gemini智能尺寸模式：显示智能尺寸信息
                console.log('🔧 批量页面 - 准备调用智能尺寸设置');
                this.setupBatchIntelligentResizeMode();
            } else if (disabled) {
                batchRatioSelect.style.opacity = '0.3';
                batchRatioSelect.style.pointerEvents = 'none';
                batchRatioSelect.style.backgroundColor = '#f3f4f6';
                batchRatioSelect.style.color = '#9ca3af';
                batchRatioSelect.style.cursor = 'not-allowed';
                batchRatioSelect.title = tooltip;
                batchRatioSelect.setAttribute('data-disabled-tooltip', tooltip);
                
                // 设置为1:1
                batchRatioSelect.value = '1:1';
                
                // 添加禁用图标指示器
                this.addDisabledIndicator(batchRatioSelect, 'ban');
            } else {
                batchRatioSelect.style.opacity = '1';
                batchRatioSelect.style.pointerEvents = 'auto';
                batchRatioSelect.style.backgroundColor = '';
                batchRatioSelect.style.color = '';
                batchRatioSelect.style.cursor = '';
                batchRatioSelect.title = '';
                batchRatioSelect.removeAttribute('data-disabled-tooltip');
                
                // 移除禁用图标指示器
                this.removeDisabledIndicator(batchRatioSelect);
            }
        }
        
        // 对于非智能模式，恢复批量选择器正常状态
        if (!intelligentResize) {
            const batchRatioSelect = document.getElementById('batchRatio');
            if (batchRatioSelect && batchRatioSelect.classList.contains('intelligent-batch-display')) {
                // 恢复正常的选择器
                batchRatioSelect.classList.remove('intelligent-batch-display');
                batchRatioSelect.style.pointerEvents = '';
                batchRatioSelect.style.cursor = '';
                batchRatioSelect.style.display = '';
                
                // 恢复原来的样式
                batchRatioSelect.style.appearance = '';
                batchRatioSelect.style.webkitAppearance = '';
                batchRatioSelect.style.mozAppearance = '';
                batchRatioSelect.style.backgroundImage = '';
                batchRatioSelect.style.fontWeight = '';
                
                // 恢复原来的选项
                const currentModel = window.aiImageAPI.getCurrentModel();
                this.renderBatchRatioOptions(currentModel);
                
                // 移除智能尺寸描述
                const batchRatioContainer = batchRatioSelect.closest('div');
                const intelligentDescription = batchRatioContainer?.querySelector('.batch-intelligent-description');
                if (intelligentDescription) {
                    intelligentDescription.remove();
                }
            }
            
            // 移除旧的智能尺寸提示（兼容之前的版本）
            const batchIntelligentHint = document.querySelector('.batch-intelligent-resize-hint');
            if (batchIntelligentHint) {
                batchIntelligentHint.remove();
            }
        }
    }

    // 添加禁用图标指示器
    addDisabledIndicator(element, iconType = 'ban') {
        // 避免重复添加
        if (element.querySelector('.disabled-indicator')) {
            return;
        }
        
        const icons = {
            'ban': 'fas fa-ban',
            'lock': 'fas fa-lock',
            'slash': 'fas fa-slash'
        };
        
        const indicator = document.createElement('div');
        indicator.className = 'disabled-indicator';
        indicator.innerHTML = `<i class="${icons[iconType] || icons.ban}"></i>`;
        indicator.style.cssText = `
            position: absolute;
            top: 50%;
            right: 8px;
            transform: translateY(-50%);
            color: #ef4444;
            font-size: 12px;
            z-index: 10;
            pointer-events: none;
            opacity: 0.8;
            text-shadow: 0 0 2px rgba(239, 68, 68, 0.5);
        `;
        
        // 设置父元素为相对定位
        if (element.style.position !== 'absolute' && element.style.position !== 'fixed') {
            element.style.position = 'relative';
        }
        
        element.appendChild(indicator);
    }

    // 移除禁用图标指示器
    removeDisabledIndicator(element) {
        const indicator = element.querySelector('.disabled-indicator');
        if (indicator) {
            indicator.remove();
        }
    }

    // 创建增强的悬浮提示
    createEnhancedTooltip(element, message) {
        const tooltip = document.createElement('div');
        tooltip.className = 'enhanced-tooltip';
        tooltip.textContent = message;
        tooltip.style.cssText = `
            position: absolute;
            bottom: 120%;
            left: 50%;
            transform: translateX(-50%);
            background: #1f2937;
            color: white;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            white-space: nowrap;
            z-index: 1000;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        `;
        
        // 添加小箭头
        const arrow = document.createElement('div');
        arrow.style.cssText = `
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            border: 4px solid transparent;
            border-top-color: #1f2937;
        `;
        tooltip.appendChild(arrow);
        
        return tooltip;
    }

    // 切换语言下拉菜单
    toggleLanguageDropdown() {
        const dropdown = document.getElementById('languageDropdown');
        const isHidden = dropdown.classList.contains('hidden');

        if (isHidden) {
            this.openLanguageDropdown();
        } else {
            this.closeLanguageDropdown();
        }
    }

    // 打开语言下拉菜单
    openLanguageDropdown() {
        const dropdown = document.getElementById('languageDropdown');
        if (dropdown) {
            dropdown.classList.remove('hidden');

            // 更新当前语言的选中状态
            const currentLang = this.i18n.getCurrentLanguage();
            document.querySelectorAll('[data-check]').forEach(checkIcon => {
                checkIcon.classList.add('hidden');
            });
            const currentCheckIcon = document.querySelector(`[data-check="${currentLang}"]`);
            if (currentCheckIcon) {
                currentCheckIcon.classList.remove('hidden');
            }
        }
    }

    // 关闭语言下拉菜单
    closeLanguageDropdown() {
        const dropdown = document.getElementById('languageDropdown');
        if (dropdown) {
            dropdown.classList.add('hidden');
        }
    }

    // 更新语言选择器显示
    updateLanguageSwitcherDisplay(lang) {
        const currentLangName = document.getElementById('currentLangName');
        if (currentLangName && this.i18n) {
            currentLangName.textContent = this.i18n.getLanguageName(lang, true);
            console.log(`[I18N] 更新语言选择器显示: ${lang} -> ${currentLangName.textContent}`);
        }

        // 更新桌面端语言选项的勾选标记
        document.querySelectorAll('#languageList [data-check]').forEach(icon => {
            const iconLang = icon.dataset.check;
            if (iconLang === lang) {
                icon.classList.remove('hidden');
            } else {
                icon.classList.add('hidden');
            }
        });

        // 更新移动端语言选项的勾选标记
        document.querySelectorAll('#languageListMobile [data-check-mobile]').forEach(icon => {
            const iconLang = icon.dataset.checkMobile;
            if (iconLang === lang) {
                icon.classList.remove('hidden');
            } else {
                icon.classList.add('hidden');
            }
        });
    }

    // 切换语言
    async switchLanguage(lang) {
        try {
            // 关闭下拉菜单
            this.closeLanguageDropdown();

            // 切换语言
            const success = await this.i18n.switchLanguage(lang);

            if (success) {
                // 更新导航栏显示
                this.updateLanguageSwitcherDisplay(lang);

                // 显示成功提示
                this.showToast(`语言已切换为 ${this.i18n.getLanguageName(lang)}`, 'success');
            }
        } catch (error) {
            console.error('Failed to switch language:', error);
            this.showToast('语言切换失败', 'error');
        }
    }

    // 打开设置模态框
    openSettings() {
        const modal = document.getElementById('settingsModal');
        if (modal) {
            modal.classList.remove('hidden');
            // 渲染站点卡片
            if (typeof renderSiteCards === 'function') {
                renderSiteCards();
            }
            // 加载并显示已保存的 API Keys
            this.loadStoredApiKey();
            
            // 加载当前站点的 API Key
            const apiKeyInput = document.getElementById('apiKeyInput');
            if (apiKeyInput && window.aiImageAPI) {
                const storedKey = window.aiImageAPI.getStoredApiKey(window.aiImageAPI.currentSite);
                const site = window.aiImageAPI.getCurrentSite();
                apiKeyInput.value = storedKey || site?.defaultApiKey || '';
            }
            
            // 更新模态框内的翻译
            if (typeof i18n !== 'undefined' && i18n.updateDOM) {
                i18n.updateDOM();
            }
        }
    }

    // 关闭设置模态框
    closeSettings() {
        document.getElementById('settingsModal').classList.add('hidden');
    }

    // 打开项目说明模态框
    openAbout() {
        document.getElementById('aboutModal').classList.remove('hidden');
    }

    // 关闭项目说明模态框
    closeAbout() {
        document.getElementById('aboutModal').classList.add('hidden');
    }

    // 打开活动弹窗
    openActivity() {
        document.getElementById('activityModal').classList.remove('hidden');
        // 关闭移动端菜单（如果打开的话）
        this.closeMobileMenu();
    }

    // 关闭活动弹窗
    closeActivity() {
        document.getElementById('activityModal').classList.add('hidden');
    }

    // 保存API Key
    async saveApiKey() {
        const apiKey = document.getElementById('apiKeyInput').value.trim();
        const visionApiKey = document.getElementById('visionApiKeyInput')?.value.trim();

        // 图片生成 API Key 是必需的
        if (!apiKey) {
            this.showToast('请输入图片生成 API Key', 'error');
            return;
        }

        let success = true;
        let messages = [];

        // 保存图片生成 API Key
        if (window.aiImageAPI.saveApiKey(apiKey)) {
            messages.push('图片生成 API Key 保存成功');
        } else {
            success = false;
            messages.push('图片生成 API Key 保存失败');
        }

        // 保存图像理解 API Key（包括清空操作）
        if (window.aiImageAPI.saveVisionApiKey(visionApiKey)) {
            if (visionApiKey) {
                messages.push('图像理解 API Key 保存成功');
            } else {
                messages.push('图像理解 API Key 已清除');
            }
        } else {
            messages.push('图像理解 API Key 保存失败');
        }

        // 显示结果
        if (success) {
            this.showToast(messages.join('\n'), 'success');
            this.updateApiStatus(true);
            this.closeSettings();
        } else {
            this.showToast(messages.join('\n'), 'error');
        }
    }

    // 更新API状态显示（通过设置按钮）
    updateApiStatus(isConnected = false) {
        console.log('🔄 更新API状态:', { isConnected, hasApiKey: !!(window.aiImageAPI && window.aiImageAPI.apiKey) });

        // 获取设置按钮元素
        const settingsBtn = document.getElementById('settingsBtn');
        const settingsBtnMobile = document.getElementById('settingsBtnMobile');

        // 检查 API Key 是否已配置
        const hasApiKey = window.aiImageAPI && window.aiImageAPI.apiKey;
        const isActive = isConnected || hasApiKey;

        console.log('✅ 最终状态:', { isActive, settingsBtnExists: !!settingsBtn, settingsBtnMobileExists: !!settingsBtnMobile });

        // 状态文本 - 添加 i18n 防护检查
        let statusText;
        if (this.i18n && typeof this.i18n.t === 'function') {
            statusText = isActive ?
                this.i18n.t('nav.settingsButton.configured') :
                this.i18n.t('nav.settingsButton.notConfigured');
        } else {
            // i18n 未加载时使用默认文本
            statusText = isActive ? '已设置' : '未设置';
        }

        console.log('📝 状态文本:', statusText);

        // 更新桌面端设置按钮
        if (settingsBtn) {
            const icon = settingsBtn.querySelector('i');
            const span = settingsBtn.querySelector('span');
            let badge = settingsBtn.querySelector('.status-badge');

            console.log('🖥️ 桌面端按钮元素:', { hasIcon: !!icon, hasSpan: !!span, hasBadge: !!badge });

            if (isActive) {
                console.log('✅ 应用已配置样式（绿色）');
                // 已配置状态 - 绿色样式
                if (icon) icon.className = 'fas fa-cog text-green-300';
                if (span) {
                    span.textContent = statusText;
                    span.className = 'hidden lg:inline text-green-100';
                }
                // 添加绿色徽章点
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full';
                    settingsBtn.appendChild(badge);
                    console.log('➕ 添加绿色徽章点');
                }
            } else {
                console.log('❌ 应用未配置样式（红色）');
                // 未配置状态 - 红色样式
                if (icon) icon.className = 'fas fa-cog text-red-300';
                if (span) {
                    span.textContent = statusText;
                    span.className = 'hidden lg:inline text-white';
                }
                // 移除徽章
                if (badge) badge.remove();
            }
        }

        // 更新移动端设置按钮
        if (settingsBtnMobile) {
            const icon = settingsBtnMobile.querySelector('i');
            const span = settingsBtnMobile.querySelector('span');
            let badge = settingsBtnMobile.querySelector('.status-badge');

            if (isActive) {
                // 已配置状态 - 绿色样式
                if (icon) icon.className = 'fas fa-cog text-green-300';
                if (span) {
                    span.textContent = statusText;
                    span.className = 'text-green-100';
                }
                // 添加绿色徽章点
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'status-badge absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full';
                    settingsBtnMobile.appendChild(badge);
                }
            } else {
                // 未配置状态 - 红色样式
                if (icon) icon.className = 'fas fa-cog text-red-300';
                if (span) {
                    span.textContent = statusText;
                    span.className = 'text-white';
                }
                // 移除徽章
                if (badge) badge.remove();
            }
        }
    }

    // 切换标签页
    switchTab(tabName, updateUrl = true) {
        // 检查目标面板是否存在
        const targetPanel = document.getElementById(`${tabName}Panel`);
        if (!targetPanel) {
            console.warn(`面板 ${tabName}Panel 不存在，无法切换`);
            this.showToast(`功能 ${tabName} 暂不可用`, 'error');
            return;
        }

        // 调用当前页面的失活回调
        if (this.pages && this.pages[this.currentTab] && typeof this.pages[this.currentTab].onDeactivate === 'function') {
            console.log(`🔄 失活页面: ${this.currentTab}`);
            this.pages[this.currentTab].onDeactivate();
        }

        // 更新标签按钮状态
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            }
        });

        // 显示对应面板
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.add('hidden');
        });

        // 安全地显示目标面板
        targetPanel.classList.remove('hidden');

        // 更新当前标签
        this.currentTab = tabName;

        // 调用新页面的激活回调
        if (this.pages && this.pages[tabName] && typeof this.pages[tabName].onActivate === 'function') {
            console.log(`🔄 激活页面: ${tabName}`);
            this.pages[tabName].onActivate();
        } else {
            console.warn(`⚠️ 页面 ${tabName} 未找到或未完全初始化`);
        }

        // 更新 URL hash（仅当需要时）
        if (updateUrl) {
            window.history.pushState(null, '', `#${tabName}`);
        }
    }

    // 下载图片 - 公共方法
    async downloadImage(url) {
        try {
            // 如果是生成页面，先检查是否有对应的 R2 URL（来自历史记录）
            const currentHistoryItem = this.history.find(item =>
                item.urls && item.urls.includes(url)
            );

            // 如果找到历史记录且有 R2 URL，优先使用 R2 URL
            if (currentHistoryItem && currentHistoryItem.r2Storage) {
                const urlIndex = currentHistoryItem.urls.indexOf(url);
                const r2Url = currentHistoryItem.urls[urlIndex];
                if (r2Url && r2Url.includes('r2/images/')) {
                    console.log('使用 R2 URL 下载图片');
                    url = r2Url;
                }
            }

            await window.aiImageAPI.downloadImage(url, null, window.aiImageAPI.model);
            this.showToast('图片下载成功', 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    }

    // 查看图片 - 公共方法，支持多图切换
    viewImage(urls, currentIndex = 0) {
        // 如果传入的是字符串，转换为数组
        if (typeof urls === 'string') {
            urls = [urls];
        }
        
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-90 z-[50000] flex items-center justify-center p-4';
        
        let currentIdx = currentIndex;
        
        const updateImage = () => {
            const imageContainer = modal.querySelector('.image-container');
            const counter = modal.querySelector('.image-counter');
            const prevBtn = modal.querySelector('.prev-btn');
            const nextBtn = modal.querySelector('.next-btn');
            const downloadBtn = modal.querySelector('.download-btn');
            
            imageContainer.innerHTML = `
                <img src="${urls[currentIdx]}" alt="查看图片" class="max-w-full object-contain rounded-lg" style="max-height: 500px;">
            `;
            
            counter.textContent = urls.length > 1 ? `${currentIdx + 1} / ${urls.length}` : '';
            prevBtn.style.display = urls.length > 1 ? 'block' : 'none';
            nextBtn.style.display = urls.length > 1 ? 'block' : 'none';
            
            // 更新下载按钮
            downloadBtn.onclick = () => this.downloadImage(urls[currentIdx]);
        };
        
        modal.innerHTML = `
            <div class="relative max-w-6xl max-h-full w-full h-full flex items-center justify-center">
                <!-- 图片容器 -->
                <div class="image-container flex items-center justify-center max-w-full max-h-full">
                    <img src="${urls[currentIdx]}" alt="查看图片" class="max-w-full object-contain rounded-lg" style="max-height: 500px;">
                </div>
                
                <!-- 控制按钮 -->
                <div class="absolute top-4 right-4 flex space-x-2">
                    <div class="image-counter bg-black bg-opacity-50 text-white px-3 py-1 rounded-full text-sm">
                        ${urls.length > 1 ? `${currentIdx + 1} / ${urls.length}` : ''}
                    </div>
                    <button class="download-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all" title="下载图片">
                        <i class="fas fa-download"></i>
                    </button>
                    ${urls.length > 1 ? `
                        <button class="batch-download-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all" title="批量下载">
                            <i class="fas fa-file-archive"></i>
                        </button>
                    ` : ''}
                    <button class="close-btn bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                
                <!-- 帮助提示 -->
                <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white text-sm px-4 py-2 rounded-full opacity-75">
                    <i class="fas fa-info-circle mr-1"></i>
                    提示：右键图片可选择"图片另存为"下载
                </div>
                
                <!-- 左右切换按钮 -->
                ${urls.length > 1 ? `
                    <button class="prev-btn absolute left-4 top-1/2 transform -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full transition-all">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <button class="next-btn absolute right-4 top-1/2 transform -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full transition-all">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                ` : ''}
            </div>
        `;
        
        // 绑定事件
        modal.querySelector('.close-btn').onclick = () => modal.remove();
        
        if (urls.length > 1) {
            modal.querySelector('.prev-btn').onclick = () => {
                currentIdx = (currentIdx - 1 + urls.length) % urls.length;
                updateImage();
            };
            
            modal.querySelector('.next-btn').onclick = () => {
                currentIdx = (currentIdx + 1) % urls.length;
                updateImage();
            };
            
            // 批量下载
            modal.querySelector('.batch-download-btn').onclick = async () => {
                try {
                    const zipFilename = `ai_images_${Date.now()}.zip`;
                    const result = await window.aiImageAPI.downloadImagesAsZip(urls, zipFilename, (completed, total) => {
                        this.showToast(`正在下载 ${completed}/${total}`, 'info');
                    }, window.aiImageAPI.model);
                    this.showToast(result.message || '批量下载完成', 'success');
                } catch (error) {
                    this.showToast(error.message, 'error');
                }
            };
        }
        
        modal.querySelector('.download-btn').onclick = () => this.downloadImage(urls[currentIdx]);
        
        // 键盘事件
        const handleKeyboard = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleKeyboard);
            } else if (urls.length > 1) {
                if (e.key === 'ArrowLeft') {
                    currentIdx = (currentIdx - 1 + urls.length) % urls.length;
                    updateImage();
                } else if (e.key === 'ArrowRight') {
                    currentIdx = (currentIdx + 1) % urls.length;
                    updateImage();
                }
            }
        };
        
        document.addEventListener('keydown', handleKeyboard);
        
        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
                document.removeEventListener('keydown', handleKeyboard);
            }
        });
        
        document.body.appendChild(modal);
        
        // 预加载所有图片到缓存，提升后续下载速度
        if (urls.length > 1) {
            window.aiImageAPI.preloadImages(urls);
        }
    }

    // 添加到历史记录 - 公共方法
    addToHistory(type, prompt, urls, ratio = null) {
        // 获取当前模型信息
        const currentModel = window.aiImageAPI.getCurrentModel();
        const modelName = currentModel ? currentModel.name : window.aiImageAPI.model;

        // 创建占位符 URLs（如果是 base64，暂时不保存）
        const placeholderUrls = urls.map(url => {
            if (url.startsWith('data:image')) {
                // 对于 base64 图片，创建占位符
                return 'pending:' + Date.now() + Math.random();
            }
            return url;
        });

        // 检测是否有 base64 数据需要上传
        const hasBase64 = urls.some(url => url.startsWith('data:image'));

        const historyItem = {
            id: Date.now(),
            type,
            prompt,
            urls: placeholderUrls,  // 使用占位符 URLs
            originalUrls: hasBase64 ? urls : null,  // 临时保存原始 base64（不保存到 localStorage）
            ratio,
            model: modelName,
            timestamp: new Date().toISOString(),
            uploading: hasBase64,  // 标记正在上传
            r2Storage: false  // 初始为 false
        };

        this.history.unshift(historyItem);

        // 限制历史记录数量
        if (this.history.length > 50) {
            this.history = this.history.slice(0, 50);
        }

        // 先保存不含 base64 的历史记录
        this.saveHistoryWithoutBase64();

        // 如果有 base64 数据，异步处理上传
        if (hasBase64 && window.r2Storage) {
            // 异步初始化并上传
            (async () => {
                try {
                    await window.r2Storage.init();
                    if (window.r2Storage.isAvailable()) {
                        this.uploadHistoryItemToR2(historyItem, urls);
                    } else {
                        // R2 不可用，直接保存 base64
                        historyItem.urls = urls;
                        historyItem.uploading = false;
                        delete historyItem.originalUrls;
                        this.saveHistory();
                    }
                } catch (err) {
                    console.warn('R2 初始化失败:', err);
                    historyItem.urls = urls;
                    historyItem.uploading = false;
                    delete historyItem.originalUrls;
                    this.saveHistory();
                }
            })();
        } else if (hasBase64) {
            // 如果没有 R2 可用，尝试保存完整的历史记录
            historyItem.urls = urls;
            historyItem.uploading = false;
            delete historyItem.originalUrls;
            this.saveHistory();
        }
    }

    // 保存历史记录（不包含 base64 数据）
    async saveHistoryWithoutBase64() {
        try {
            // 创建不含 originalUrls 的历史记录副本
            const historyToSave = this.history.map(item => {
                const { originalUrls, ...itemWithoutBase64 } = item;
                return itemWithoutBase64;
            });

            // 计算大小用于日志
            const dataStr = JSON.stringify(historyToSave);
            const sizeInKB = (dataStr.length / 1024).toFixed(2);

            // 使用 StorageBridge（支持 Electron 和浏览器）
            if (window.storageBridge) {
                await window.storageBridge.saveHistory(historyToSave);
                console.log(`历史记录已保存（StorageBridge）: ${historyToSave.length} 条, ${sizeInKB} KB`);
            } else {
                // 降级到 localStorage
                localStorage.setItem('ai_image_history', dataStr);
                console.log(`历史记录已保存（localStorage）: ${historyToSave.length} 条, ${sizeInKB} KB`);
            }

            return true;
        } catch (error) {
            console.error('保存历史记录失败:', error);
            this.showToast('存储空间不足，请清理部分历史记录', 'warning');
            return false;
        }
    }

    // 异步上传历史记录项到 R2
    async uploadHistoryItemToR2(historyItem, originalUrls) {
        try {
            console.log('开始上传历史记录图片到 R2...');

            // 批量上传到 R2
            const r2Urls = await window.r2Storage.batchProcess(originalUrls);

            // 更新历史记录
            const itemIndex = this.history.findIndex(item => item.id === historyItem.id);
            if (itemIndex !== -1) {
                this.history[itemIndex].urls = r2Urls;
                this.history[itemIndex].uploading = false;
                this.history[itemIndex].r2Storage = true;
                delete this.history[itemIndex].originalUrls;

                // 保存更新后的历史记录
                this.saveHistoryWithoutBase64();
                console.log('历史记录已更新为 R2 URLs');
            }
        } catch (error) {
            console.error('上传历史记录到 R2 失败:', error);

            // 如果上传失败，尝试保存原始 base64
            const itemIndex = this.history.findIndex(item => item.id === historyItem.id);
            if (itemIndex !== -1) {
                this.history[itemIndex].urls = originalUrls;
                this.history[itemIndex].uploading = false;
                delete this.history[itemIndex].originalUrls;
                this.saveHistory();
            }
        }
    }

    // 加载历史记录 - 公共方法（支持 StorageBridge）
    async loadHistory() {
        try {
            // 如果存在 StorageBridge，优先使用
            if (window.storageBridge) {
                const history = await window.storageBridge.loadHistory();
                return history || [];
            }
            // 降级到 localStorage
            const stored = localStorage.getItem('ai_image_history');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('加载历史记录失败:', error);
            return [];
        }
    }

    // 保存历史记录 - 公共方法（支持 StorageBridge）
    async saveHistory() {
        try {
            // 如果存在 StorageBridge，优先使用
            if (window.storageBridge) {
                const result = await window.storageBridge.saveHistory(this.history);
                if (result && result.success !== false) {
                    const sizeInKB = (JSON.stringify(this.history).length / 1024).toFixed(2);
                    console.log(`历史记录已保存（StorageBridge）: ${this.history.length} 条, ${sizeInKB} KB`);
                    return true;
                }
            }
            
            // 降级到 localStorage
            const dataStr = JSON.stringify(this.history);
            localStorage.setItem('ai_image_history', dataStr);

            // 记录存储大小（用于监控）
            const sizeInKB = (dataStr.length / 1024).toFixed(2);
            console.log(`历史记录已保存（localStorage）: ${this.history.length} 条, ${sizeInKB} KB`);

            return true;
        } catch (error) {
            console.error('保存历史记录失败:', error);

            if (error.name === 'QuotaExceededError') {
                // 存储超限处理
                this.showToast('存储空间不足，请清理部分历史记录', 'warning');

                // 自动清理最旧的记录
                if (this.history.length > 10) {
                    this.history = this.history.slice(0, 10);
                    try {
                        localStorage.setItem('ai_image_history', JSON.stringify(this.history));
                        this.showToast('已自动保留最近10条记录', 'info');
                        return true;
                    } catch (e) {
                        console.error('清理后仍然失败:', e);
                    }
                }
            }

            this.showToast('保存失败，请检查存储空间', 'error');
            return false;
        }
    }

    // 初始化 R2 上传监听器
    initR2UploadListener() {
        // 监听 R2 上传完成事件，更新历史记录
        window.addEventListener('r2UploadComplete', (event) => {
            const { originalUrls, r2Urls } = event.detail;

            // 更新历史记录中的 URL
            let historyUpdated = false;
            this.history.forEach(item => {
                // 处理占位符 URLs 的情况
                if (item.uploading && item.originalUrls) {
                    // 这是一个等待上传的项目
                    const newUrls = [];
                    let allUploaded = true;

                    item.originalUrls.forEach((originalUrl, index) => {
                        const uploadedIndex = originalUrls.indexOf(originalUrl);
                        if (uploadedIndex !== -1 && r2Urls[uploadedIndex]) {
                            newUrls[index] = r2Urls[uploadedIndex];
                        } else {
                            newUrls[index] = originalUrl;
                            allUploaded = false;
                        }
                    });

                    if (allUploaded) {
                        item.urls = newUrls;
                        item.uploading = false;
                        item.r2Storage = true;
                        delete item.originalUrls;
                        historyUpdated = true;
                    }
                } else if (item.urls && Array.isArray(item.urls)) {
                    // 处理已有的普通 URLs
                    item.urls.forEach((imgUrl, index) => {
                        const originalIndex = originalUrls.indexOf(imgUrl);
                        if (originalIndex !== -1 && r2Urls[originalIndex]) {
                            // 更新为 R2 URL
                            item.urls[index] = r2Urls[originalIndex];
                            item.r2Storage = true;  // 标记为已上传到 R2
                            historyUpdated = true;
                        }
                    });
                }
            });

            // 如果有更新，保存历史记录
            if (historyUpdated) {
                this.saveHistoryWithoutBase64();
                console.log('历史记录已更新为 R2 URL');
            }
        });
    }

    // 自动迁移历史记录
    async autoMigrateHistory() {
        // 延迟执行，避免影响页面加载
        setTimeout(async () => {
            // 检查 R2 存储是否存在
            if (!window.r2Storage) {
                console.log('R2 存储服务未加载，跳过自动迁移');
                return;
            }
            
            // 初始化 R2 存储（确保 workerUrl 已设置）
            try {
                await window.r2Storage.init();
            } catch (err) {
                console.warn('R2 存储初始化失败:', err);
            }
            
            // 检查是否有 R2 存储可用
            if (!window.r2Storage.isAvailable()) {
                console.log('R2 存储不可用，跳过自动迁移');
                return;
            }

            // 检查存储使用率
            const storageInfo = this.getStorageInfo();
            const usagePercent = (parseFloat(storageInfo.totalSize) / storageInfo.estimatedLimit) * 100;

            // 如果存储使用率超过 70%，自动迁移
            if (usagePercent > 70) {
                console.log(`存储使用率 ${usagePercent.toFixed(1)}%，开始自动迁移...`);

                // 找出需要迁移的记录（最旧的含有 base64 的记录）
                const itemsToMigrate = this.history
                    .filter(item =>
                        !item.r2Storage &&
                        !item.uploading &&
                        item.urls &&
                        item.urls.some(url => url.startsWith('data:'))
                    )
                    .slice(-10); // 每次最多迁移 10 条

                if (itemsToMigrate.length > 0) {
                    console.log(`自动迁移 ${itemsToMigrate.length} 条历史记录到云端...`);

                    for (const item of itemsToMigrate) {
                        try {
                            const base64Urls = item.urls.filter(url => url.startsWith('data:'));
                            const r2Urls = await window.r2Storage.batchProcess(base64Urls);

                            const updatedUrls = item.urls.map(url => {
                                const index = base64Urls.indexOf(url);
                                if (index !== -1 && r2Urls[index]) {
                                    return r2Urls[index];
                                }
                                return url;
                            });

                            item.urls = updatedUrls;
                            item.r2Storage = true;
                            item.uploading = false;
                            delete item.originalUrls;

                            console.log(`历史记录 ${item.id} 已迁移到云端`);
                        } catch (error) {
                            console.error(`自动迁移记录 ${item.id} 失败:`, error);
                        }
                    }

                    // 保存更新
                    this.saveHistoryWithoutBase64();
                    console.log('自动迁移完成');
                }
            }
        }, 3000); // 延迟 3 秒执行
    }

    // 初始化版本检测器
    initVersionChecker() {
        // 延迟执行版本检测，避免阻塞页面加载
        setTimeout(() => {
            if (window.versionChecker) {
                window.versionChecker.init();
            } else {
                console.warn('版本检测模块未加载');
            }
        }, 2000); // 延迟 2 秒执行
    }

    // 获取存储空间使用情况
    getStorageInfo() {
        const historyStr = localStorage.getItem('ai_image_history') || '[]';
        const historySizeKB = (historyStr.length / 1024).toFixed(2);
        const historyCount = this.history.length;

        // 计算所有 localStorage 的大小
        let totalSize = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                totalSize += localStorage[key].length;
            }
        }
        const totalSizeKB = (totalSize / 1024).toFixed(2);

        // 检查 R2 存储状态
        const r2Enabled = window.r2Storage && window.r2Storage.isAvailable();

        return {
            historySize: historySizeKB,
            historyCount: historyCount,
            totalSize: totalSizeKB,
            estimatedLimit: 5120, // localStorage 通常限制为 5MB
            r2Enabled: r2Enabled,
            storageMode: r2Enabled ? 'cloud' : 'local'
        };
    }

    // 清理历史记录
    async clearOldHistory(keepCount = 10) {
        if (this.history.length <= keepCount) {
            this.showToast(`历史记录少于${keepCount}条，无需清理`, 'info');
            return;
        }

        const oldCount = this.history.length;
        const itemsToDelete = this.history.slice(keepCount);

        // 如果启用了 R2，删除云端图片
        if (window.r2Storage && window.r2Storage.isAvailable()) {
            const r2Keys = [];
            itemsToDelete.forEach(item => {
                if (item.metadata && item.metadata.r2Keys) {
                    r2Keys.push(...item.metadata.r2Keys);
                }
            });

            if (r2Keys.length > 0) {
                console.log(`正在删除 ${r2Keys.length} 个云端图片...`);
                await window.r2Storage.batchDelete(r2Keys);
            }
        }

        // 清理本地历史
        this.history = this.history.slice(0, keepCount);
        const saved = this.saveHistory();

        if (saved) {
            const clearedCount = oldCount - keepCount;
            this.showToast(`已清理 ${clearedCount} 条历史记录`, 'success');

            // 刷新历史页面
            if (this.currentTab === 'history') {
                this.pages.history?.loadPanel();
            }
        }
    }

    // 添加历史记录项 - 公共方法
    async addHistory(historyItem) {
        // 添加元数据
        if (historyItem.urls && Array.isArray(historyItem.urls)) {
            // 提取 R2 键值
            const r2Keys = [];
            for (const url of historyItem.urls) {
                if (window.r2Storage && window.r2Storage.isR2Url(url)) {
                    const key = window.r2Storage.extractR2Key(url);
                    if (key) r2Keys.push(key);
                }
            }

            // 添加元数据
            historyItem.metadata = {
                ...historyItem.metadata,
                r2Keys: r2Keys,
                storageMode: r2Keys.length > 0 ? 'cloud' : 'local',
                savedAt: Date.now()
            };
        }

        // 添加到历史记录数组开头
        this.history.unshift(historyItem);

        // 限制历史记录数量
        const maxHistory = window.r2Storage && window.r2Storage.isAvailable() ? 100 : 30;
        if (this.history.length > maxHistory) {
            // 删除超出部分的云端图片
            const itemsToDelete = this.history.slice(maxHistory);
            if (window.r2Storage && window.r2Storage.isAvailable()) {
                const keysToDelete = [];
                itemsToDelete.forEach(item => {
                    if (item.metadata && item.metadata.r2Keys) {
                        keysToDelete.push(...item.metadata.r2Keys);
                    }
                });
                if (keysToDelete.length > 0) {
                    window.r2Storage.batchDelete(keysToDelete);
                }
            }

            this.history = this.history.slice(0, maxHistory);
        }

        // 保存到本地存储
        const saved = this.saveHistory();

        // 如果保存成功且当前在历史页面，刷新显示
        if (saved && this.currentTab === 'history') {
            this.pages.history?.loadPanel();
        }
    }

    // 显示Toast通知 - 公共方法
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        const toastIcon = document.getElementById('toastIcon');
        const toastMessage = document.getElementById('toastMessage');

        const icons = {
            success: '<i class="fas fa-check-circle text-green-500 text-xl"></i>',
            error: '<i class="fas fa-exclamation-circle text-red-500 text-xl"></i>',
            info: '<i class="fas fa-info-circle text-blue-500 text-xl"></i>',
            warning: '<i class="fas fa-exclamation-triangle text-yellow-500 text-xl"></i>'
        };

        toastIcon.innerHTML = icons[type] || icons.info;
        toastMessage.textContent = message;

        toast.classList.remove('hidden');
        
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    // 显示详细错误信息 - 新增方法
    showDetailedError(error, context = '') {
        // 使用API类的格式化方法来获取详细错误信息
        const errorInfo = window.aiImageAPI.formatDetailedError(error);
        
        // 创建错误详情模态框
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-70 z-[60000] flex items-center justify-center p-4';
        
        modal.innerHTML = `
            <div class="bg-white rounded-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
                <!-- 错误标题 -->
                <div class="bg-red-50 border-b border-red-200 px-6 py-4 rounded-t-xl">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-3">
                            <div class="bg-red-100 rounded-full p-2">
                                <i class="fas fa-exclamation-triangle text-red-600 text-xl"></i>
                            </div>
                            <div>
                                <h3 class="text-lg font-bold text-red-800">${errorInfo.title}</h3>
                                ${context ? `<p class="text-sm text-red-600">${context}</p>` : ''}
                            </div>
                        </div>
                        <button class="error-close-btn text-red-400 hover:text-red-600 transition-colors" title="关闭" aria-label="关闭错误详情">
                            <i class="fas fa-times text-xl"></i>
                        </button>
                    </div>
                </div>

                <!-- 错误内容 -->
                <div class="p-6 space-y-6">
                    <!-- 主要错误信息 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
                            <i class="fas fa-info-circle text-blue-500 mr-2"></i>
                            错误描述
                        </h4>
                        <div class="bg-gray-50 rounded-lg p-4">
                            <p class="text-gray-700">${errorInfo.message}</p>
                            
                            ${errorInfo.rawResponse ? `
                            <!-- 快速响应预览 -->
                            <div class="mt-4 border-t border-gray-300 pt-4">
                                <div class="flex items-center justify-between mb-2">
                                    <h5 class="font-medium text-gray-800 text-sm">
                                        <i class="fas fa-file-alt text-orange-500 mr-1"></i>
                                        API响应内容预览
                                    </h5>
                                    <span class="text-xs text-gray-500">完整内容请查看下方技术详情</span>
                                </div>
                                <div class="bg-gray-800 rounded p-3 overflow-x-auto max-h-32 overflow-y-auto">
                                    <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap">${errorInfo.rawResponse.substring(0, 500)}${errorInfo.rawResponse.length > 500 ? '\n\n... (内容已截断，完整内容请查看技术详情) ...' : ''}</pre>
                                </div>
                            </div>
                            ` : ''}
                        </div>
                    </div>

                    ${errorInfo.details && errorInfo.details.length > 0 ? `
                    <!-- 解决建议 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
                            <i class="fas fa-lightbulb text-yellow-500 mr-2"></i>
                            排查建议
                        </h4>
                        <div class="bg-yellow-50 rounded-lg p-4">
                            <ul class="space-y-2">
                                ${errorInfo.details.map(detail => `
                                    <li class="flex items-start space-x-2">
                                        <i class="fas fa-arrow-right text-yellow-600 mt-1 text-sm"></i>
                                        <span class="text-gray-700">${detail}</span>
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    </div>
                    ` : ''}

                    ${errorInfo.rejectionType ? `
                    <!-- Nano Banana Pro 常见问题提示 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
                            <i class="fas fa-info-circle text-orange-500 mr-2"></i>
                            Nano Banana Pro 常见问题
                        </h4>
                        <div class="bg-orange-50 border border-orange-200 rounded-lg p-4">
                            <div class="space-y-3">
                                <div class="flex items-start space-x-2">
                                    <i class="fas fa-exclamation-circle text-orange-600 mt-1"></i>
                                    <div>
                                        <p class="text-gray-800 font-medium">检测到错误类型: ${this.getRejectionTypeName(errorInfo.rejectionType)}</p>
                                        ${errorInfo.apiTextResponse ? `
                                        <p class="text-sm text-gray-600 mt-1">
                                            <span class="font-medium">API 原始响应:</span> 
                                            <span class="font-mono text-xs">"${errorInfo.apiTextResponse.substring(0, 100)}${errorInfo.apiTextResponse.length > 100 ? '...' : ''}"</span>
                                        </p>
                                        ` : ''}
                                    </div>
                                </div>
                                <div class="border-t border-orange-200 pt-3">
                                    <a href="#" class="view-faq-link text-blue-600 hover:text-blue-800 underline text-sm font-medium flex items-center">
                                        <i class="fas fa-book-open mr-1"></i>
                                        查看 Nano Banana Pro 完整常见问题说明
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                    ` : ''}

                    ${errorInfo.technicalDetails && errorInfo.technicalDetails.length > 0 ? `
                    <!-- 技术详情 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
                            <i class="fas fa-code text-gray-500 mr-2"></i>
                            技术详情
                            <button class="toggle-tech-details ml-2 text-xs text-blue-600 hover:text-blue-800 underline">
                                展开/收起
                            </button>
                        </h4>
                        <div class="tech-details-content ${errorInfo.rawResponse ? '' : 'hidden'} bg-gray-100 rounded-lg p-4 overflow-x-auto">
                            <div class="space-y-4 text-sm">
                                <!-- 基本技术信息 -->
                                <div class="space-y-2 font-mono">
                                    ${errorInfo.technicalDetails.map(detail => `
                                        <div class="text-gray-600">${detail}</div>
                                    `).join('')}
                                </div>
                                
                                ${errorInfo.candidateStructure ? `
                                <!-- Candidate 结构（重点展示）-->
                                <div class="border-t border-gray-300 pt-4">
                                    <div class="flex items-center justify-between mb-2">
                                        <h5 class="font-semibold text-gray-800 text-sm">
                                            <i class="fas fa-exclamation-triangle text-red-500 mr-1"></i>
                                            API 返回的 Candidate 结构
                                        </h5>
                                        <button class="copy-candidate-structure text-xs text-blue-600 hover:text-blue-800 underline">
                                            复制 Candidate 结构
                                        </button>
                                    </div>
                                    <div class="bg-red-900 rounded p-3 overflow-x-auto">
                                        <pre class="text-yellow-300 text-xs font-mono whitespace-pre-wrap candidate-structure-content">${errorInfo.candidateStructure}</pre>
                                    </div>
                                    <p class="text-xs text-gray-600 mt-2">
                                        <i class="fas fa-info-circle mr-1"></i>
                                        此结构包含 API 拒绝的具体原因（finishReason）及相关信息
                                    </p>
                                </div>
                                ` : ''}
                                
                                ${errorInfo.rawResponse ? `
                                <!-- 完整原始响应 -->
                                <div class="border-t border-gray-300 pt-4">
                                    <div class="flex items-center justify-between mb-2">
                                        <h5 class="font-semibold text-gray-800 text-sm">
                                            <i class="fas fa-file-code text-orange-500 mr-1"></i>
                                            完整接口响应 (原始JSON)
                                        </h5>
                                        <button class="copy-raw-response text-xs text-blue-600 hover:text-blue-800 underline">
                                            复制原始响应
                                        </button>
                                    </div>
                                    <div class="bg-black rounded p-3 overflow-x-auto">
                                        <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap raw-response-content">${errorInfo.rawResponse}</pre>
                                    </div>
                                </div>
                                ` : ''}
                                
                                ${errorInfo.parsedErrorData ? `
                                <!-- 解析后的错误数据 -->
                                <div class="border-t border-gray-300 pt-4">
                                    <h5 class="font-semibold text-gray-800 text-sm mb-2">
                                        <i class="fas fa-search text-blue-500 mr-1"></i>
                                        解析后的错误信息
                                    </h5>
                                    <div class="bg-blue-50 rounded p-3">
                                        <div class="space-y-1 text-xs">
                                            ${errorInfo.parsedErrorData.error?.code ? `
                                                <div><span class="font-medium text-blue-800">错误代码:</span> <span class="font-mono text-red-600">${errorInfo.parsedErrorData.error.code}</span></div>
                                            ` : ''}
                                            ${errorInfo.parsedErrorData.status_code ? `
                                                <div><span class="font-medium text-blue-800">状态码:</span> <span class="font-mono text-red-600">${errorInfo.parsedErrorData.status_code}</span></div>
                                            ` : ''}
                                            ${errorInfo.parsedErrorData.error?.message ? `
                                                <div><span class="font-medium text-blue-800">错误消息:</span> <span class="text-gray-700">${errorInfo.parsedErrorData.error.message}</span></div>
                                            ` : ''}
                                            ${errorInfo.parsedErrorData.error?.type ? `
                                                <div><span class="font-medium text-blue-800">错误类型:</span> <span class="font-mono text-gray-600">${errorInfo.parsedErrorData.error.type}</span></div>
                                            ` : ''}
                                        </div>
                                    </div>
                                </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                    ` : ''}

                    <!-- 操作按钮 -->
                    <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
                        ${errorInfo.errorData?.isNetworkError && errorInfo.errorData?.diagnosis ? `
                        <!-- 网络错误专用按钮 -->
                        <button class="retry-request-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-redo mr-2"></i>立即重试
                        </button>
                        <button class="test-connection-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-network-wired mr-2"></i>测试连接
                        </button>
                        ` : `
                        <button class="copy-error-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-copy mr-2"></i>复制错误信息
                        </button>
                        `}
                        <button class="error-close-btn-footer bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-times mr-2"></i>关闭
                        </button>
                    </div>
                </div>
            </div>
        `;

        // 绑定事件
        this.bindErrorModalEvents(modal, errorInfo);
        
        // 添加到页面
        document.body.appendChild(modal);
        
        // 自动聚焦到模态框（可访问性）
        setTimeout(() => {
            modal.focus();
        }, 100);
    }

    // 绑定错误模态框事件
    bindErrorModalEvents(modal, errorInfo) {
        // 关闭按钮事件
        const closeButtons = modal.querySelectorAll('.error-close-btn, .error-close-btn-footer');
        closeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                modal.remove();
            });
        });

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        // ESC键关闭
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);

        // 技术详情展开/收起
        const toggleBtn = modal.querySelector('.toggle-tech-details');
        const techContent = modal.querySelector('.tech-details-content');
        if (toggleBtn && techContent) {
            toggleBtn.addEventListener('click', () => {
                techContent.classList.toggle('hidden');
            });
        }

        // 复制错误信息
        const copyBtn = modal.querySelector('.copy-error-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const errorText = this.formatErrorForCopy(errorInfo);
                navigator.clipboard.writeText(errorText).then(() => {
                    this.showToast('错误信息已复制到剪贴板', 'success');
                }).catch(() => {
                    this.showToast('复制失败，请手动复制', 'error');
                });
            });
        }

        // 复制原始响应
        const copyRawBtn = modal.querySelector('.copy-raw-response');
        if (copyRawBtn) {
            copyRawBtn.addEventListener('click', () => {
                const rawResponse = errorInfo.rawResponse || 'N/A';
                navigator.clipboard.writeText(rawResponse).then(() => {
                    this.showToast('原始JSON响应已复制到剪贴板', 'success');
                }).catch(() => {
                    this.showToast('复制失败，请手动复制', 'error');
                });
            });
        }

        // 复制 Candidate 结构
        const copyCandidateBtn = modal.querySelector('.copy-candidate-structure');
        if (copyCandidateBtn) {
            copyCandidateBtn.addEventListener('click', () => {
                const candidateStructure = errorInfo.candidateStructure || 'N/A';
                navigator.clipboard.writeText(candidateStructure).then(() => {
                    this.showToast('Candidate 结构已复制到剪贴板', 'success');
                }).catch(() => {
                    this.showToast('复制失败，请手动复制', 'error');
                });
            });
        }

        // 查看常见问题链接
        const faqLink = modal.querySelector('.view-faq-link');
        if (faqLink) {
            faqLink.addEventListener('click', (e) => {
                e.preventDefault();
                this.showNanoBananaFAQ();
            });
        }

        // 立即重试按钮
        const retryBtn = modal.querySelector('.retry-request-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', async () => {
                // 检查在线状态
                if (!navigator.onLine) {
                    this.showToast('设备离线，请先连接网络', 'error');
                    return;
                }
                
                // 禁用按钮，显示重试中状态
                retryBtn.disabled = true;
                const originalHTML = retryBtn.innerHTML;
                retryBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>重试中...';
                
                try {
                    this.showToast('正在重试...', 'info');
                    
                    // 关闭错误弹窗
                    modal.remove();
                    
                    // 这里需要重新触发原始请求
                    // 由于不同页面的重试逻辑不同，这里触发一个自定义事件
                    window.dispatchEvent(new CustomEvent('retryFailedRequest', {
                        detail: {
                            error: error,
                            errorInfo: errorInfo
                        }
                    }));
                } catch (e) {
                    console.error('重试失败:', e);
                    retryBtn.disabled = false;
                    retryBtn.innerHTML = originalHTML;
                    this.showToast('重试失败，请稍后再试', 'error');
                }
            });
        }

        // 测试连接按钮
        const testBtn = modal.querySelector('.test-connection-btn');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                testBtn.disabled = true;
                const originalHTML = testBtn.innerHTML;
                testBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>测试中...';
                
                try {
                    const results = await window.aiImageAPI.testNetworkConnection();
                    testBtn.disabled = false;
                    testBtn.innerHTML = originalHTML;
                    
                    // 显示测试结果
                    this.showNetworkTestResults(results);
                } catch (e) {
                    testBtn.disabled = false;
                    testBtn.innerHTML = originalHTML;
                    this.showToast('测试失败', 'error');
                }
            });
        }

        // 移除了旧的重试按钮注释
    }

    // 获取拒绝类型的友好名称
    getRejectionTypeName(rejectionType) {
        const typeNames = {
            'watermark_removal': '去水印请求',
            'faceswap': '换脸请求',
            'nsfw': 'NSFW内容',
            'finish_reason': 'API 拒绝（finishReason）',
            'api_text_response': 'API 返回说明',
            'zero_candidates_token': '谷歌内容审核拒绝（candidatesTokenCount: 0）',
            'knowledge_cutoff': '知识库限制',
            'general_rejection': '内容被拒绝'
        };
        return typeNames[rejectionType] || rejectionType;
    }

    // 显示网络测试结果
    showNetworkTestResults(results) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-70 z-[60000] flex items-center justify-center p-4';
        
        const getStatusIcon = (status) => {
            if (status === true) return '<i class="fas fa-check-circle text-green-500"></i>';
            if (status === false) return '<i class="fas fa-times-circle text-red-500"></i>';
            return '<i class="fas fa-question-circle text-gray-400"></i>';
        };
        
        const getStatusText = (status) => {
            if (status === true) return '<span class="text-green-600 font-medium">正常</span>';
            if (status === false) return '<span class="text-red-600 font-medium">失败</span>';
            return '<span class="text-gray-500">未测试</span>';
        };
        
        // 生成诊断建议
        let suggestions = [];
        if (!results.browserOnline) {
            suggestions.push('设备处于离线状态，请检查网络连接');
        } else if (!results.internetAccess) {
            suggestions.push('无法访问互联网，请检查网络连接或防火墙设置');
        } else if (!results.apiReachable) {
            suggestions.push('API 服务器可能暂时不可用');
            suggestions.push('建议稍后重试或联系技术支持');
            suggestions.push('或检查防火墙是否阻止了 API 域名');
        } else {
            suggestions.push('网络连接正常，可以尝试重试请求');
        }
        
        modal.innerHTML = `
            <div class="bg-white rounded-xl w-full max-w-md mx-4">
                <div class="bg-blue-50 border-b border-blue-200 px-6 py-4 rounded-t-xl">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-3">
                            <div class="bg-blue-100 rounded-full p-2">
                                <i class="fas fa-network-wired text-blue-600 text-xl"></i>
                            </div>
                            <h3 class="text-lg font-bold text-blue-800">网络诊断结果</h3>
                        </div>
                        <button class="test-close-btn text-blue-400 hover:text-blue-600 transition-colors">
                            <i class="fas fa-times text-xl"></i>
                        </button>
                    </div>
                </div>
                
                <div class="p-6">
                    <!-- 测试结果 -->
                    <div class="space-y-3 mb-6">
                        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <span class="text-gray-700 font-medium">浏览器在线状态</span>
                            <div class="flex items-center space-x-2">
                                ${getStatusIcon(results.browserOnline)}
                                ${getStatusText(results.browserOnline)}
                            </div>
                        </div>
                        
                        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <span class="text-gray-700 font-medium">互联网连接</span>
                            <div class="flex items-center space-x-2">
                                ${getStatusIcon(results.internetAccess)}
                                ${getStatusText(results.internetAccess)}
                            </div>
                        </div>
                        
                        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <span class="text-gray-700 font-medium">API 端点</span>
                            <div class="flex items-center space-x-2">
                                ${getStatusIcon(results.apiReachable)}
                                ${getStatusText(results.apiReachable)}
                            </div>
                        </div>
                    </div>
                    
                    <!-- 诊断建议 -->
                    ${suggestions.length > 0 ? `
                    <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                        <h4 class="font-semibold text-yellow-800 mb-2 flex items-center">
                            <i class="fas fa-lightbulb mr-2"></i>诊断建议
                        </h4>
                        <ul class="space-y-1">
                            ${suggestions.map(s => `
                                <li class="flex items-start space-x-2 text-sm text-gray-700">
                                    <i class="fas fa-arrow-right text-yellow-600 mt-1 text-xs"></i>
                                    <span>${s}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                    ` : ''}
                    
                    <!-- 操作按钮 -->
                    <div class="flex gap-3">
                        <button class="copy-test-results flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-copy mr-2"></i>复制诊断报告
                        </button>
                        <button class="test-close-btn bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-times mr-2"></i>关闭
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // 绑定事件
        const closeButtons = modal.querySelectorAll('.test-close-btn');
        closeButtons.forEach(btn => {
            btn.addEventListener('click', () => modal.remove());
        });
        
        const copyBtn = modal.querySelector('.copy-test-results');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const report = `=== 网络诊断报告 ===
测试时间: ${new Date(results.timestamp).toLocaleString()}
浏览器: ${navigator.userAgent.split(' ').pop()}

测试结果:
- 浏览器在线状态: ${results.browserOnline ? '✅ 在线' : '❌ 离线'}
- 互联网连接: ${results.internetAccess === true ? '✅ 正常' : results.internetAccess === false ? '❌ 失败' : '⚠️ 未测试'}
- API 端点: ${results.apiReachable === true ? '✅ 正常' : results.apiReachable === false ? '❌ 失败' : '⚠️ 未测试'}
- API 地址: ${window.aiImageAPI.baseURL}

诊断建议:
${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;
                navigator.clipboard.writeText(report).then(() => {
                    this.showToast('诊断报告已复制', 'success');
                }).catch(() => {
                    this.showToast('复制失败', 'error');
                });
            });
        }
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        
        document.body.appendChild(modal);
    }

    // 显示 Nano Banana Pro 常见问题
    showNanoBananaFAQ() {
        // 暂时滚动到设置页面的 FAQ 区域
        // 如果设置页面的 FAQ 还未创建，则先显示提示
        this.switchTab('settings');
        
        // 稍后滚动到 FAQ 区域
        setTimeout(() => {
            const faqSection = document.getElementById('nano-banana-faq-section');
            if (faqSection) {
                faqSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // 高亮显示
                faqSection.classList.add('highlight-flash');
                setTimeout(() => {
                    faqSection.classList.remove('highlight-flash');
                }, 2000);
            } else {
                this.showToast('常见问题文档正在完善中，请稍后查看', 'info');
            }
        }, 300);
    }

    // 格式化错误信息用于复制
    formatErrorForCopy(errorInfo) {
        let text = `=== AI图片生成错误详情 ===\n\n`;
        text += `错误类型: ${errorInfo.title}\n`;
        text += `错误描述: ${errorInfo.message}\n\n`;
        
        if (errorInfo.details && errorInfo.details.length > 0) {
            text += `排查建议:\n`;
            errorInfo.details.forEach((detail, index) => {
                text += `${index + 1}. ${detail}\n`;
            });
            text += `\n`;
        }
        
        if (errorInfo.technicalDetails && errorInfo.technicalDetails.length > 0) {
            text += `技术详情:\n`;
            errorInfo.technicalDetails.forEach(detail => {
                text += `- ${detail}\n`;
            });
            text += `\n`;
        }
        
        // 添加解析后的错误信息
        if (errorInfo.parsedErrorData) {
            text += `解析后的错误信息:\n`;
            if (errorInfo.parsedErrorData.error?.code) {
                text += `- 错误代码: ${errorInfo.parsedErrorData.error.code}\n`;
            }
            if (errorInfo.parsedErrorData.status_code) {
                text += `- 状态码: ${errorInfo.parsedErrorData.status_code}\n`;
            }
            if (errorInfo.parsedErrorData.error?.message) {
                text += `- 错误消息: ${errorInfo.parsedErrorData.error.message}\n`;
            }
            if (errorInfo.parsedErrorData.error?.type) {
                text += `- 错误类型: ${errorInfo.parsedErrorData.error.type}\n`;
            }
            text += `\n`;
        }
        
        // 添加 Candidate 结构（如果有）
        if (errorInfo.candidateStructure) {
            text += `API 返回的 Candidate 结构:\n`;
            text += `${errorInfo.candidateStructure}\n\n`;
        }
        
        // 添加完整的原始JSON响应
        if (errorInfo.rawResponse) {
            text += `完整接口响应 (原始JSON):\n`;
            text += `${errorInfo.rawResponse}\n\n`;
        }
        
        text += `生成时间: ${new Date().toLocaleString()}`;
        return text;
    }

    // 键盘快捷键处理
    handleKeyboard(e) {
        // Ctrl/Cmd + Enter 执行当前页面的主要操作
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (this.currentTab === 'generate') {
                this.pages.generate.generateImage();
            } else if (this.currentTab === 'edit') {
                this.pages.edit.editImage();
            } else if (this.currentTab === 'batch') {
                this.pages.batch.batchGenerate();
            }
        }
        
        // Escape 关闭模态框
        if (e.key === 'Escape') {
            const settingsModal = document.getElementById('settingsModal');
            const customSiteModal = document.getElementById('customSiteModal');
            if (customSiteModal && !customSiteModal.classList.contains('hidden')) {
                closeCustomSiteModal();
            } else if (settingsModal && !settingsModal.classList.contains('hidden')) {
                this.closeSettings();
            }
            this.closeAbout();
            this.closeActivity();
        }
    }

    // 统一处理粘贴事件
    handlePaste(e) {
        // 检查是否在输入框中粘贴文本，如果是则不处理图片
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT')) {
            return;
        }

        // 检查是否有与上传相关的元素获得焦点或者最近被交互过
        const isInUploadContext = this.isInImageUploadContext();
        if (!isInUploadContext) {
            return; // 不在上传上下文中，不处理粘贴
        }

        // 根据当前激活的面板，分发粘贴事件
        if (this.currentTab === 'generate') {
            if (this.pages.generate && typeof this.pages.generate.handlePasteEvent === 'function') {
                this.pages.generate.handlePasteEvent(e);
            }
        } else if (this.currentTab === 'batch') {
            if (this.pages.batch && typeof this.pages.batch.handleBatchPasteEvent === 'function') {
                this.pages.batch.handleBatchPasteEvent(e);
            }
        }
        // 其他面板目前不需要粘贴功能，如需要可以在这里添加
    }

    // 绑定上传区域交互跟踪
    bindUploadInteractionTracking() {
        const uploadElementIds = ['referenceImageArea', 'batchReferenceImageArea'];
        
        uploadElementIds.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                // 监听多种交互事件
                ['mouseenter', 'click', 'focus', 'touchstart'].forEach(eventType => {
                    element.addEventListener(eventType, () => {
                        this.lastUploadInteraction = Date.now();
                    });
                });
                
                // 为子元素也添加交互跟踪
                element.addEventListener('click', (e) => {
                    this.lastUploadInteraction = Date.now();
                }, true); // 使用捕获阶段确保子元素点击也被捕获
            }
        });
    }

    // 检查是否在图片上传的上下文中
    isInImageUploadContext() {
        const activeElement = document.activeElement;
        
        // 检查当前焦点是否在上传相关的元素上
        if (activeElement) {
            const uploadIds = ['referenceImageArea', 'batchReferenceImageArea'];
            
            // 检查焦点是否在上传区域或其子元素中
            for (const id of uploadIds) {
                const uploadElement = document.getElementById(id);
                if (uploadElement && (activeElement === uploadElement || uploadElement.contains(activeElement))) {
                    return true;
                }
            }
        }

        // 检查最近是否有与上传区域的交互（鼠标悬浮、点击等）
        const currentTime = Date.now();
        if (this.lastUploadInteraction && (currentTime - this.lastUploadInteraction) < 3000) { // 3秒内的交互
            return true;
        }

        return false;
    }

    // 绑定禁用元素的增强悬浮提示
    bindEnhancedTooltips() {
        // 使用事件委托处理动态添加的禁用元素
        document.addEventListener('mouseenter', (e) => {
            const element = e.target;
            // 确保element是DOM元素且有hasAttribute方法
            if (element && element.nodeType === 1 && element.hasAttribute && element.hasAttribute('data-disabled-tooltip') && element.disabled) {
                const tooltip = element.getAttribute('data-disabled-tooltip');
                const tooltipElement = this.createEnhancedTooltip(element, tooltip);
                
                // 设置父元素为相对定位
                if (element.style.position !== 'absolute' && element.style.position !== 'fixed') {
                    element.style.position = 'relative';
                }
                
                element.appendChild(tooltipElement);
                
                // 显示动画
                setTimeout(() => {
                    tooltipElement.style.opacity = '1';
                }, 50);
            }
        }, true);
        
        document.addEventListener('mouseleave', (e) => {
            const element = e.target;
            // 确保element是DOM元素且有hasAttribute方法
            if (element && element.nodeType === 1 && element.hasAttribute && element.hasAttribute('data-disabled-tooltip')) {
                const tooltipElement = element.querySelector('.enhanced-tooltip');
                if (tooltipElement) {
                    tooltipElement.style.opacity = '0';
                    setTimeout(() => {
                        if (tooltipElement.parentNode) {
                            tooltipElement.remove();
                        }
                    }, 300);
                }
            }
        }, true);
    }

    // 绑定网络受限图片事件
    bindNetworkRestrictedImageEvents() {
        window.addEventListener('networkRestrictedImages', (e) => {
            const { inaccessibleUrls, allUrls, content, suggestions } = e.detail;
            this.showNetworkRestrictedDialog(inaccessibleUrls, allUrls, content, suggestions);
        });
    }

    // 显示网络受限提示对话框
    showNetworkRestrictedDialog(inaccessibleUrls, allUrls, content, suggestions) {
        // 创建特殊的网络受限提示模态框
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-70 z-[60000] flex items-center justify-center p-4';
        
        // 提取所有图片URL（包括可访问和不可访问的）
        const accessibleUrls = allUrls.filter(url => !inaccessibleUrls.includes(url));
        
        modal.innerHTML = `
            <div class="bg-white rounded-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
                <!-- 标题部分 -->
                <div class="bg-orange-50 border-b border-orange-200 px-6 py-4 rounded-t-xl">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-3">
                            <div class="bg-orange-100 rounded-full p-2">
                                <i class="fas fa-exclamation-triangle text-orange-600 text-xl"></i>
                            </div>
                            <div>
                                <h3 class="text-lg font-bold text-orange-800">图片生成成功，但网络访问受限</h3>
                                <p class="text-sm text-orange-600">API已成功生成图片，但部分图片可能因网络环境无法正常显示</p>
                            </div>
                        </div>
                        <button class="network-close-btn text-orange-400 hover:text-orange-600 transition-colors" title="关闭">
                            <i class="fas fa-times text-xl"></i>
                        </button>
                    </div>
                </div>

                <!-- 内容部分 -->
                <div class="p-6 space-y-6">
                    <!-- 状态说明 -->
                    <div class="bg-green-50 border-l-4 border-green-500 p-4 rounded">
                        <div class="flex items-center">
                            <i class="fas fa-check-circle text-green-500 mr-2"></i>
                            <span class="font-semibold text-green-800">生成状态：成功</span>
                        </div>
                        <p class="text-green-700 text-sm mt-1">API已成功处理您的请求并生成了图片，问题可能出现在网络访问环节。</p>
                    </div>

                    <!-- 图片地址列表 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
                            <i class="fas fa-link text-blue-500 mr-2"></i>
                            生成的图片地址 (${allUrls.length}张)
                        </h4>
                        <div class="space-y-3">
                            ${allUrls.map((url, index) => {
                                const isAccessible = !inaccessibleUrls.includes(url);
                                return `
                                    <div class="border rounded-lg p-3 ${isAccessible ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}">
                                        <div class="flex items-center justify-between mb-2">
                                            <div class="flex items-center space-x-2">
                                                <span class="text-sm font-medium">图片 ${index + 1}</span>
                                                <span class="text-xs px-2 py-1 rounded-full ${isAccessible ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
                                                    ${isAccessible ? '可访问' : '网络受限'}
                                                </span>
                                            </div>
                                            <div class="flex space-x-2">
                                                <button class="copy-url-btn text-xs bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded" data-url="${url}">
                                                    <i class="fas fa-copy mr-1"></i>复制地址
                                                </button>
                                            <button class="open-url-btn text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded" data-url="${url}">
                                                <i class="fas fa-external-link-alt mr-1"></i>新窗口打开
                                            </button>
                                            ${!isAccessible ? `
                                                <button class="mark-accessible-btn text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded" data-url="${url}">
                                                    <i class="fas fa-check mr-1"></i>标记可访问
                                                </button>
                                            ` : ''}
                                            </div>
                                        </div>
                                        <div class="text-xs font-mono bg-gray-100 p-2 rounded break-all">
                                            ${url}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- 解决方案 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
                            <i class="fas fa-lightbulb text-yellow-500 mr-2"></i>
                            解决方案
                        </h4>
                        <div class="bg-blue-50 rounded-lg p-4">
                            <ul class="space-y-2">
                                ${suggestions.map(suggestion => `
                                    <li class="flex items-start space-x-2">
                                        <i class="fas fa-arrow-right text-blue-600 mt-1 text-sm"></i>
                                        <span class="text-gray-700">${suggestion}</span>
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    </div>

                    <!-- 技术信息 -->
                    <div>
                        <div class="flex items-center justify-between mb-2">
                            <h4 class="font-semibold text-gray-800 flex items-center">
                                <i class="fas fa-info-circle text-gray-500 mr-2"></i>
                                技术详情
                            </h4>
                            <button class="toggle-technical-info text-xs text-blue-600 hover:text-blue-800 underline">
                                展开/收起
                            </button>
                        </div>
                        <div class="technical-info-content hidden bg-gray-100 rounded-lg p-4">
                            <div class="space-y-3 text-sm">
                                <div>
                                    <span class="font-medium text-gray-800">完整API响应内容:</span>
                                    <div class="bg-black rounded p-3 mt-2 overflow-x-auto">
                                        <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap">${content}</pre>
                                    </div>
                                </div>
                                <div>
                                    <span class="font-medium text-gray-800">网络检测结果:</span>
                                    <div class="mt-1 text-xs">
                                        <div class="text-green-700">✓ 可访问URL: ${accessibleUrls.length}个</div>
                                        <div class="text-red-700">✗ 受限URL: ${inaccessibleUrls.length}个</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 操作按钮 -->
                    <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
                        <button class="copy-all-urls-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-copy mr-2"></i>复制所有地址
                        </button>
                        <button class="save-to-history-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-history mr-2"></i>保存到历史记录
                        </button>
                        <button class="network-close-btn-footer bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-times mr-2"></i>关闭
                        </button>
                    </div>
                </div>
            </div>
        `;

        // 绑定事件
        this.bindNetworkRestrictedModalEvents(modal, allUrls, content);
        
        // 添加到页面
        document.body.appendChild(modal);
    }

    // 绑定网络受限模态框事件
    bindNetworkRestrictedModalEvents(modal, allUrls, content) {
        // 关闭按钮
        const closeButtons = modal.querySelectorAll('.network-close-btn, .network-close-btn-footer');
        closeButtons.forEach(btn => {
            btn.addEventListener('click', () => modal.remove());
        });

        // 背景点击关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        // ESC键关闭
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);

        // 复制单个URL
        modal.querySelectorAll('.copy-url-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                navigator.clipboard.writeText(url).then(() => {
                    this.showToast('图片地址已复制', 'success');
                }).catch(() => {
                    this.showToast('复制失败', 'error');
                });
            });
        });

        // 新窗口打开URL
        modal.querySelectorAll('.open-url-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                window.open(url, '_blank');
            });
        });

        // 复制所有地址
        const copyAllBtn = modal.querySelector('.copy-all-urls-btn');
        copyAllBtn.addEventListener('click', () => {
            const urlsText = allUrls.map((url, index) => `图片${index + 1}: ${url}`).join('\n\n');
            navigator.clipboard.writeText(urlsText).then(() => {
                this.showToast('所有图片地址已复制', 'success');
            }).catch(() => {
                this.showToast('复制失败', 'error');
            });
        });

        // 技术详情展开/收起
        const toggleBtn = modal.querySelector('.toggle-technical-info');
        const techContent = modal.querySelector('.technical-info-content');
        toggleBtn.addEventListener('click', () => {
            techContent.classList.toggle('hidden');
        });

        // 标记为可访问按钮
        modal.querySelectorAll('.mark-accessible-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                // 将URL标记为用户可访问，避免未来误判
                window.aiImageAPI.markUrlAsUserAccessible(url);
                // 移动URL到可访问列表
                const index = inaccessibleUrls.indexOf(url);
                if (index > -1) {
                    inaccessibleUrls.splice(index, 1);
                    // 更新显示
                    this.showToast('已标记为可访问，将记住此设置', 'success');
                    // 如果没有受限URL了，关闭弹窗
                    if (inaccessibleUrls.length === 0) {
                        modal.remove();
                        this.showToast('所有图片都已标记为可访问！', 'success');
                    } else {
                        // 重新渲染模态框
                        modal.remove();
                        this.showNetworkRestrictedDialog(inaccessibleUrls, allUrls, content, suggestions);
                    }
                }
            });
        });

        // 保存到历史记录
        const saveBtn = modal.querySelector('.save-to-history-btn');
        saveBtn.addEventListener('click', () => {
            // 获取当前的提示词（从当前页面）
            let prompt = '';
            if (this.currentTab === 'generate') {
                prompt = document.getElementById('promptInput')?.value || '未知提示词';
            } else if (this.currentTab === 'batch') {
                prompt = '批量生成';
            }
            
            // 检查是否还有无法访问的URL
            const historyType = inaccessibleUrls.length > 0 ? 'network_restricted' : 'generate';
            const historyRatio = inaccessibleUrls.length > 0 ? '网络受限' : null;
            
            // 添加到历史记录
            this.addToHistory(historyType, prompt, allUrls, historyRatio);
            this.showToast('已保存到历史记录', 'success');
            modal.remove();
        });
    }

    // 设置Gemini智能尺寸模式
    setupIntelligentResizeMode() {
        // 首先恢复所有宽高比按钮的正常状态（不影响分辨率按钮）
        document.querySelectorAll('#ratioButtons .ratio-btn, .edit-ratio-btn').forEach(btn => {
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
            btn.style.backgroundColor = '';
            btn.style.color = '';
            btn.style.cursor = '';
            btn.style.filter = '';
            btn.title = '';
            btn.removeAttribute('data-disabled-tooltip');
            this.removeDisabledIndicator(btn);
        });

        // 创建或更新智能尺寸提示UI
        this.updateIntelligentResizeUI();
    }

    // 更新智能尺寸UI显示
    updateIntelligentResizeUI() {
        console.log('开始更新智能尺寸UI');
        
        // 找到生成页面的尺寸选择区域
        const ratioContainer = document.querySelector('.ratio-btn').closest('div').parentElement;
        if (!ratioContainer) {
            console.log('未找到尺寸选择容器');
            return;
        }

        // 移除旧的智能尺寸提示
        const existingHint = ratioContainer.querySelector('.intelligent-resize-hint');
        if (existingHint) {
            existingHint.remove();
        }

        // 隐藏原来的尺寸选择按钮
        const ratioButtonsContainer = document.querySelector('.ratio-btn').closest('div');
        if (ratioButtonsContainer) {
            ratioButtonsContainer.style.display = 'none';
            console.log('已隐藏尺寸选择按钮');
        }

        // 创建智能尺寸提示元素
        const hint = document.createElement('div');
        hint.className = 'intelligent-resize-hint mt-2 p-3 bg-orange-100 bg-opacity-20 rounded-lg border border-orange-300 border-opacity-30';
        
        // 检查是否有参考图
        const generatePage = this.pages?.generate || window.generatePage;
        const hasReferenceImages = generatePage && generatePage.referenceImages && generatePage.referenceImages.length > 0;
        
        console.log('检查参考图状态:', hasReferenceImages, generatePage?.referenceImages?.length, 'generatePage存在:', !!generatePage);
        
        if (hasReferenceImages) {
            // 有参考图：显示基于参考图的预期输出
            console.log('显示参考图尺寸提示');
            // 先显示加载状态
            hint.innerHTML = `
                <div class="text-orange-200 text-sm">
                    <div class="flex items-center mb-2">
                        <i class="fas fa-magic mr-2"></i>
                        <span class="font-medium">智能遵循原图比例</span>
                    </div>
                    <div class="text-xs opacity-75">
                        📷 正在分析参考图尺寸信息...
                    </div>
                </div>
            `;
            // 然后异步加载尺寸信息
            this.showReferenceImageSizeHint(hint);
        } else {
            // 无参考图：显示提示用户上传参考图
            console.log('显示上传提示');
            hint.innerHTML = `
                <div class="flex items-center text-orange-200 text-sm">
                    <i class="fas fa-magic mr-2"></i>
                    <div>
                        <div class="font-medium">智能遵循原图比例</div>
                        <div class="text-xs opacity-75 mt-1">📷 请上传参考图片，将根据原图比例智能调整尺寸（最大1024×1024px）</div>
                    </div>
                </div>
            `;
        }
        
        // 添加到DOM
        ratioContainer.appendChild(hint);
        console.log('智能尺寸UI更新完成');
    }

    // 显示基于参考图的尺寸提示
    showReferenceImageSizeHint(hintElement) {
        try {
            const generatePage = this.pages?.generate || window.generatePage;
            if (!generatePage || !generatePage.referenceImages.length) {
                console.log('❌ 没有参考图数据，显示默认提示');
                return;
            }

            console.log('🔍 开始处理参考图尺寸信息，参考图数量:', generatePage.referenceImages.length);

            // 获取第一张参考图的数据
            const firstImageData = generatePage.referenceImages[0];
            console.log('📷 参考图数据:', {
                fileName: firstImageData?.fileName,
                width: firstImageData?.width,
                height: firstImageData?.height,
                hasSize: !!(firstImageData?.width && firstImageData?.height)
            });
            
            // 检查是否已有尺寸信息
            if (firstImageData.width && firstImageData.height) {
                const originalWidth = firstImageData.width;
                const originalHeight = firstImageData.height;
                const ratio = originalWidth / originalHeight;
                
                console.log('✅ 直接使用已获取的图片尺寸:', originalWidth, 'x', originalHeight, '比例:', ratio.toFixed(2));
                
                // 计算预期输出尺寸
                const outputSize = window.aiImageAPI.calculateGeminiOutputSize(originalWidth, originalHeight);
                
                console.log('🎯 计算出预期输出尺寸:', outputSize);
                
                // 格式化比例显示
                const ratioText = this.formatRatio(ratio);
                
                hintElement.innerHTML = `
                    <div class="text-orange-200 text-sm">
                        <div class="flex items-center mb-2">
                            <i class="fas fa-magic mr-2"></i>
                            <span class="font-medium">智能遵循原图比例</span>
                        </div>
                        <div class="bg-orange-100 bg-opacity-10 rounded p-2 text-xs">
                            <div class="flex justify-between items-center">
                                <span>原图尺寸:</span>
                                <span class="font-mono">${originalWidth} × ${originalHeight}px ${ratioText}</span>
                            </div>
                            <div class="flex justify-between items-center mt-1">
                                <span>预计输出:</span>
                                <span class="font-mono text-green-300">${outputSize.width} × ${outputSize.height}px</span>
                            </div>
                        </div>
                        <div class="text-xs opacity-75 mt-1">
                            📏 自动保持比例，最大1024×1024px
                        </div>
                    </div>
                `;
                
                console.log('🎉 参考图尺寸提示已更新完成!');
            } else {
                console.warn('⚠️ 参考图缺少尺寸信息，显示默认提示');
                hintElement.innerHTML = `
                    <div class="text-orange-200 text-sm">
                        <div class="flex items-center mb-2">
                            <i class="fas fa-magic mr-2"></i>
                            <span class="font-medium">智能遵循原图比例</span>
                        </div>
                        <div class="text-xs opacity-75 mt-1">
                            📷 正在分析参考图尺寸信息...
                        </div>
                    </div>
                `;
            }
            
        } catch (error) {
            console.error('💥 处理参考图尺寸时发生错误:', error);
        }
    }

    // 设置批量页面的Gemini智能尺寸模式
    setupBatchIntelligentResizeMode() {
        console.log('设置批量页面智能尺寸模式');
        
        // 找到批量页面的尺寸选择器
        const batchRatioSelect = document.getElementById('batchRatio');
        const batchRatioContainer = batchRatioSelect?.closest('div');
        if (!batchRatioSelect || !batchRatioContainer) {
            console.log('未找到批量尺寸选择器或容器');
            return;
        }

        // 移除旧的智能尺寸描述
        const existingDescription = batchRatioContainer.querySelector('.batch-intelligent-description');
        if (existingDescription) {
            existingDescription.remove();
        }

        // 设置选择器为智能模式
        batchRatioSelect.classList.add('intelligent-batch-display');
        batchRatioSelect.style.pointerEvents = 'none'; // 禁用点击
        batchRatioSelect.style.cursor = 'default';
        
        // 移除下拉箭头和调整样式
        batchRatioSelect.style.appearance = 'none';
        batchRatioSelect.style.webkitAppearance = 'none';
        batchRatioSelect.style.mozAppearance = 'none';
        batchRatioSelect.style.backgroundImage = 'none';
        batchRatioSelect.style.fontWeight = 'normal'; // 确保不加粗
        
        // 简洁的选择器显示
        batchRatioSelect.innerHTML = '<option>📏 智能遵循参考图</option>';

        // 创建独立的描述行
        const description = document.createElement('div');
        description.className = 'batch-intelligent-description mt-2 text-xs text-white opacity-75';
        
        const batchPage = this.pages?.batch;
        const hasBatchReferenceImages = batchPage && batchPage.batchReferenceImages && batchPage.batchReferenceImages.length > 0;
        
        console.log('检查批量参考图状态:', hasBatchReferenceImages, batchPage?.batchReferenceImages?.length);
        
        if (hasBatchReferenceImages) {
            // 有参考图：显示具体尺寸信息
            const firstImageData = batchPage.batchReferenceImages[0];
            if (firstImageData.width && firstImageData.height) {
                const outputSize = window.aiImageAPI.calculateGeminiOutputSize(firstImageData.width, firstImageData.height);
                const ratioText = this.formatRatio(firstImageData.width / firstImageData.height);
                
                description.innerHTML = `
                    <div class="flex items-center justify-between">
                        <span>参考图尺寸: ${firstImageData.width} × ${firstImageData.height}px ${ratioText}</span>
                        <span class="text-green-300">预计输出: ${outputSize.width} × ${outputSize.height}px</span>
                    </div>
                `;
            } else {
                description.innerHTML = '<div class="text-orange-300">正在分析参考图尺寸信息...</div>';
            }
        } else {
            // 无参考图：显示提示
            description.innerHTML = '<div>可选择上传参考图片，将根据参考图比例智能调整尺寸（最大1024×1024px）</div>';
        }
        
        // 添加到容器
        batchRatioContainer.appendChild(description);
        
        console.log('批量智能尺寸UI更新完成');
    }

    // 显示批量参考图的尺寸提示
    showBatchReferenceImageSizeHint(hintElement, batchReferenceImages) {
        try {
            if (!batchReferenceImages || !batchReferenceImages.length) {
                console.log('❌ 没有批量参考图数据');
                return;
            }

            console.log('🔍 开始处理批量参考图尺寸信息，参考图数量:', batchReferenceImages.length);

            // 获取第一张参考图的数据
            const firstImageData = batchReferenceImages[0];
            console.log('📷 批量参考图数据:', {
                fileName: firstImageData?.fileName,
                width: firstImageData?.width,
                height: firstImageData?.height,
                hasSize: !!(firstImageData?.width && firstImageData?.height)
            });
            
            // 检查是否已有尺寸信息
            if (firstImageData.width && firstImageData.height) {
                const originalWidth = firstImageData.width;
                const originalHeight = firstImageData.height;
                const ratio = originalWidth / originalHeight;
                
                console.log('✅ 直接使用已获取的批量图片尺寸:', originalWidth, 'x', originalHeight, '比例:', ratio.toFixed(2));
                
                // 计算预期输出尺寸
                const outputSize = window.aiImageAPI.calculateGeminiOutputSize(originalWidth, originalHeight);
                
                console.log('🎯 计算出批量预期输出尺寸:', outputSize);
                
                // 格式化比例显示
                const ratioText = this.formatRatio(ratio);
                
                hintElement.innerHTML = `
                    <div class="text-orange-200 text-sm">
                        <div class="flex items-center mb-2">
                            <i class="fas fa-magic mr-2"></i>
                            <span class="font-medium">智能遵循参考图</span>
                        </div>
                        <div class="bg-orange-100 bg-opacity-10 rounded p-2 text-xs">
                            <div class="flex justify-between items-center">
                                <span>参考图尺寸:</span>
                                <span class="font-mono">${originalWidth} × ${originalHeight}px ${ratioText}</span>
                            </div>
                            <div class="flex justify-between items-center mt-1">
                                <span>预计输出:</span>
                                <span class="font-mono text-green-300">${outputSize.width} × ${outputSize.height}px</span>
                            </div>
                        </div>
                        <div class="text-xs opacity-75 mt-1">
                            📏 所有图片将遵循此比例，最大1024×1024px
                        </div>
                    </div>
                `;
                
                console.log('🎉 批量参考图尺寸提示已更新完成!');
            } else {
                console.warn('⚠️ 批量参考图缺少尺寸信息，显示默认提示');
                hintElement.innerHTML = `
                    <div class="text-orange-200 text-sm">
                        <div class="flex items-center mb-2">
                            <i class="fas fa-magic mr-2"></i>
                            <span class="font-medium">智能遵循参考图</span>
                        </div>
                        <div class="text-xs opacity-75 mt-1">
                            📷 正在分析参考图尺寸信息...
                        </div>
                    </div>
                `;
            }
            
        } catch (error) {
            console.error('💥 处理批量参考图尺寸时发生错误:', error);
        }
    }

    // 格式化比例显示
    formatRatio(ratio) {
        if (Math.abs(ratio - 1) < 0.1) return '(约1:1)';
        if (Math.abs(ratio - 2/3) < 0.1) return '(约2:3)';
        if (Math.abs(ratio - 3/2) < 0.1) return '(约3:2)';
        if (ratio > 1) return `(约${ratio.toFixed(1)}:1)`;
        return `(约1:${(1/ratio).toFixed(1)})`;
    }
}

// 应用启动入口 - 增强DOM检查
function initializeApp() {
    // 防止重复初始化
    if (window.app) {
        console.log('[INIT] AIImageApp 已存在，跳过重复初始化');
        return;
    }
    try {
        console.log('[INIT] 准备创建 AIImageApp 实例...');

        // 检查关键DOM元素是否存在
        const requiredElements = [
            'modelSelector',
            'modelSelectorMobile',  // 移动端模型选择器
            // Choices.js 重构后，这些元素已删除：
            // 'modelDropdown', 'modelList', 'currentModelName'
            'referenceImageArea',
            'batchReferenceImageArea'
        ];

        const missingElements = requiredElements.filter(id => !document.getElementById(id));

        if (missingElements.length > 0) {
            console.warn('以下DOM元素未找到，延迟初始化:', missingElements);
            // 延迟重试，最多重试5次
            if (window.appInitRetries < 5) {
                window.appInitRetries = (window.appInitRetries || 0) + 1;
                setTimeout(initializeApp, 200);
                return;
            } else {
                console.error('DOM元素加载超时，强制初始化应用');
            }
        }

        // 初始化应用
        window.app = new AIImageApp();
        console.log('[INIT] AIImageApp 实例创建完成, window.app:', window.app);

    } catch (error) {
        console.error('❌ 应用初始化失败:', error);
        console.error('❌ 错误堆栈:', error.stack);

        // 显示错误信息给用户
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(220, 38, 38, 0.95);
            color: white;
            padding: 2rem;
            border-radius: 1rem;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
            z-index: 9999;
            max-width: 500px;
            text-align: center;
        `;
        errorDiv.innerHTML = `
            <h2 style="margin-bottom: 1rem;">❌ 应用初始化失败</h2>
            <p style="margin-bottom: 1rem;">${error.message}</p>
            <button onclick="location.reload()" style="
                background: white;
                color: #dc2626;
                border: none;
                padding: 0.5rem 1rem;
                border-radius: 0.5rem;
                cursor: pointer;
                font-weight: 600;
            ">刷新页面</button>
        `;
        document.body.appendChild(errorDiv);
    }
}

// 初始化应用 - 确保只初始化一次
// 备用初始化方案，防止DOMContentLoaded事件丢失（针对Cloudflare Rocket Loader等情况）
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM已经加载完成
    initializeApp();
}

// 备用:确保模型选择器在页面完全加载后初始化
window.addEventListener('load', () => {
    console.log('🔄 Window load 事件触发，检查模型选择器状态...');

    // 如果应用已初始化但模型选择器未初始化,则重新初始化
    if (window.app && (!window.app.desktopModelChoice || !window.app.mobileModelChoice)) {
        console.warn('⚠️ 模型选择器未初始化，重新初始化...');
        setTimeout(() => {
            if (window.app.initModelSelector) {
                window.app.initModelSelector();
            }
        }, 100);
    } else {
        console.log('✅ 模型选择器已就绪');
    }
});

// 全局函数：查看大图
function viewLargeImage(imageSrc) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-75 z-[50000] flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="relative max-w-4xl max-h-full">
            <img src="${imageSrc}" alt="查看大图" class="max-w-full max-h-full object-contain rounded-lg">
            <button class="absolute top-4 right-4 text-white text-2xl hover:text-gray-300 bg-black bg-opacity-50 rounded-full w-10 h-10 flex items-center justify-center" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    // 点击背景关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
    
    // ESC键关闭
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
    
    document.body.appendChild(modal);
}

// 初始化Flux图片缓存系统
AIImageApp.prototype.initFluxImageCache = function() {
    // 清理过期缓存
    if (window.aiImageAPI) {
        window.aiImageAPI.cleanupExpiredCache();
    }

    // 监听flux图片缓存完成事件
    window.addEventListener('fluxImagesCached', (event) => {
        const { originalUrls, cachedUrls } = event.detail;
        console.log('收到flux图片缓存完成事件', { originalUrls, cachedUrls });

        // 更新历史记录中的URL映射
        this.updateHistoryWithCachedImages(originalUrls, cachedUrls);
    });
};

// 更新历史记录中的缓存图片映射
AIImageApp.prototype.updateHistoryWithCachedImages = function(originalUrls, cachedUrls) {
    try {
        const history = this.loadHistory();
        let updated = false;

        // 遍历历史记录，更新最新的记录
        for (let i = history.length - 1; i >= 0; i--) {
            const record = history[i];
            if (record.urls && Array.isArray(record.urls)) {
                // 检查是否有匹配的URL
                const hasMatching = record.urls.some(url => originalUrls.includes(url));
                if (hasMatching) {
                    // 添加缓存信息
                    record.cachedUrls = cachedUrls;
                    record.cacheTimestamp = Date.now();
                    updated = true;
                    console.log('更新历史记录缓存信息:', record.id);
                    break; // 只更新最新的匹配记录
                }
            }
        }

        if (updated) {
            this.saveHistory(history);
            // 如果当前在历史页面，刷新显示
            if (this.currentTab === 'history') {
                this.pages.history?.refreshDisplay();
            }
        }
    } catch (error) {
        console.warn('更新历史记录缓存失败:', error);
    }
};

// 获取图片显示URL（优先使用缓存）
AIImageApp.prototype.getDisplayUrl = function(originalUrl, cachedUrls) {
    // 如果有缓存URL，优先使用缓存
    if (cachedUrls && cachedUrls.length > 0) {
        // 简单的映射策略：使用第一个缓存URL
        return cachedUrls[0];
    }

    // 如果是flux-kontext的URL，检查是否有本地缓存
    if (originalUrl.includes('bfl.ai') && window.aiImageAPI) {
        const cachedData = window.aiImageAPI.getCachedImage(originalUrl);
        if (cachedData) {
            return cachedData;
        }
    }

    // 回退到原始URL
    return originalUrl;
};

// ==================== 站点选择功能 ====================

// 站点图标映射
const SITE_ICONS = {
    'apiyi': 'fa-bolt',
    'b-apiyi': 'fa-server',
    'local': 'fa-desktop',
    'antigravity': 'fa-rocket',
    'yunwu': 'fa-cloud',
    'bolatu': 'fa-layer-group',
    'default': 'fa-globe'
};

// 渲染站点卡片
function renderSiteCards() {
    const container = document.getElementById('siteCardsContainer');
    if (!container || !window.aiImageAPI) return;
    
    const sites = window.aiImageAPI.getAllSites();
    const currentSite = window.aiImageAPI.currentSite;
    
    container.innerHTML = '';
    
    Object.entries(sites).forEach(([key, site]) => {
        const isSelected = key === currentSite;
        const isCustom = site.isCustom;
        const icon = SITE_ICONS[key] || SITE_ICONS['default'];
        
        const card = document.createElement('div');
        card.className = `site-card relative cursor-pointer rounded-lg p-3 border-2 transition-all ${
            isSelected 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
        }`;
        card.dataset.siteKey = key;
        
        card.innerHTML = `
            <div class="text-center">
                <i class="fas ${icon} text-2xl ${isSelected ? 'text-blue-500' : 'text-gray-400'} mb-2"></i>
                <div class="text-sm font-medium ${isSelected ? 'text-blue-700' : 'text-gray-700'} truncate">${site.name}</div>
                ${isSelected ? '<div class="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center"><i class="fas fa-check text-white text-xs"></i></div>' : ''}
                ${isCustom ? '<div class="absolute -top-1 -left-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center" title="自定义站点"><i class="fas fa-user text-white text-xs"></i></div>' : ''}
            </div>
        `;
        
        // 点击选择站点
        card.addEventListener('click', () => selectSite(key));
        
        // 自定义站点可以右键编辑/删除
        if (isCustom) {
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showSiteContextMenu(e, key, site);
            });
        }
        
        container.appendChild(card);
    });
    
    // 更新当前站点提示
    updateCurrentSiteHint();
}

// 选择站点
function selectSite(siteKey) {
    if (!window.aiImageAPI) return;
    
    window.aiImageAPI.saveSite(siteKey);
    renderSiteCards();
    
    // 加载该站点的图片生成 API Key 到输入框
    const apiKeyInput = document.getElementById('apiKeyInput');
    const storedKey = window.aiImageAPI.getStoredApiKey(siteKey);
    const site = window.aiImageAPI.getAllSites()[siteKey];
    
    if (apiKeyInput) {
        apiKeyInput.value = storedKey || site?.defaultApiKey || '';
    }
    
    // 加载该站点的图像理解 API Key 到输入框
    const visionApiKeyInput = document.getElementById('visionApiKeyInput');
    const storedVisionKey = window.aiImageAPI.getStoredVisionApiKey(siteKey);
    
    if (visionApiKeyInput) {
        visionApiKeyInput.value = storedVisionKey || '';
    }
    
    updateCurrentSiteHint();
}

// 更新当前站点提示
function updateCurrentSiteHint() {
    const hintEl = document.getElementById('currentSiteHint');
    if (!hintEl || !window.aiImageAPI) return;
    
    const site = window.aiImageAPI.getCurrentSite();
    const span = hintEl.querySelector('span');
    
    if (site.defaultApiKey) {
        span.textContent = `${site.name} 已配置默认 Key，可直接使用。也可输入自己的 Key。`;
        hintEl.classList.remove('hidden');
    } else {
        span.textContent = `请输入 ${site.name} 的 API Key`;
        hintEl.classList.remove('hidden');
    }
}

// 显示站点右键菜单（用于编辑/删除自定义站点）
function showSiteContextMenu(event, siteKey, site) {
    // 移除已存在的菜单
    const existingMenu = document.getElementById('siteContextMenu');
    if (existingMenu) existingMenu.remove();
    
    const menu = document.createElement('div');
    menu.id = 'siteContextMenu';
    menu.className = 'fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-[50002]';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    
    menu.innerHTML = `
        <button class="w-full px-4 py-2 text-left hover:bg-gray-100 flex items-center" data-action="edit">
            <i class="fas fa-edit mr-2 text-blue-500"></i>编辑
        </button>
        <button class="w-full px-4 py-2 text-left hover:bg-gray-100 flex items-center text-red-600" data-action="delete">
            <i class="fas fa-trash mr-2"></i>删除
        </button>
    `;
    
    document.body.appendChild(menu);
    
    // 点击其他地方关闭菜单
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
    
    // 菜单项点击
    menu.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            menu.remove();
            
            if (action === 'edit') {
                openEditCustomSiteModal(siteKey, site);
            } else if (action === 'delete') {
                if (confirm(`确定要删除站点 "${site.name}" 吗？`)) {
                    window.aiImageAPI.removeCustomSite(siteKey);
                    renderSiteCards();
                }
            }
        });
    });
}

// 打开添加自定义站点模态框
function openAddCustomSiteModal() {
    const modal = document.getElementById('customSiteModal');
    const title = document.getElementById('customSiteModalTitle');
    const editingKey = document.getElementById('editingSiteKey');
    
    // 清空表单
    document.getElementById('customSiteName').value = '';
    document.getElementById('customSiteBaseURL').value = '';
    document.getElementById('customSitePathPrefix').value = '';
    document.getElementById('customSiteApiKey').value = '';
    document.getElementById('customSiteDescription').value = '';
    editingKey.value = '';
    
    // 使用 i18n 翻译标题
    const titleText = typeof i18n !== 'undefined' ? i18n.t('settingsModal.customSite.addTitle') : '添加自定义站点';
    title.innerHTML = `<i class="fas fa-plus-circle text-green-500 mr-2"></i><span>${titleText}</span>`;
    
    if (modal) {
        modal.classList.remove('hidden');
        // 更新模态框内的翻译
        if (typeof i18n !== 'undefined' && i18n.updateDOM) {
            i18n.updateDOM();
        }
    }
}

// 打开编辑自定义站点模态框
function openEditCustomSiteModal(siteKey, site) {
    const modal = document.getElementById('customSiteModal');
    const title = document.getElementById('customSiteModalTitle');
    const editingKey = document.getElementById('editingSiteKey');
    
    // 填充表单
    document.getElementById('customSiteName').value = site.name || '';
    document.getElementById('customSiteBaseURL').value = site.baseURL || '';
    document.getElementById('customSitePathPrefix').value = site.pathPrefix || '';
    document.getElementById('customSiteApiKey').value = site.defaultApiKey || '';
    document.getElementById('customSiteDescription').value = site.description || '';
    editingKey.value = siteKey;
    
    // 使用 i18n 翻译标题
    const titleText = typeof i18n !== 'undefined' ? i18n.t('settingsModal.customSite.editTitle') : '编辑自定义站点';
    title.innerHTML = `<i class="fas fa-edit text-blue-500 mr-2"></i><span>${titleText}</span>`;
    
    if (modal) {
        modal.classList.remove('hidden');
        // 更新模态框内的翻译
        if (typeof i18n !== 'undefined' && i18n.updateDOM) {
            i18n.updateDOM();
        }
    }
}

// 关闭自定义站点模态框
function closeCustomSiteModal() {
    const modal = document.getElementById('customSiteModal');
    if (modal) modal.classList.add('hidden');
}

// 保存自定义站点
function saveCustomSiteFromModal() {
    const name = document.getElementById('customSiteName').value.trim();
    const baseURL = document.getElementById('customSiteBaseURL').value.trim();
    const pathPrefix = document.getElementById('customSitePathPrefix').value.trim();
    const apiKey = document.getElementById('customSiteApiKey').value.trim();
    const description = document.getElementById('customSiteDescription').value.trim();
    const editingKey = document.getElementById('editingSiteKey').value;
    
    // 验证必填项
    if (!name) {
        alert('请输入站点名称');
        return;
    }
    if (!baseURL) {
        alert('请输入 Base URL');
        return;
    }
    
    // 验证 URL 格式
    try {
        new URL(baseURL);
    } catch (e) {
        alert('Base URL 格式不正确，请输入完整的 URL（如 https://api.example.com）');
        return;
    }
    
    const config = {
        name,
        baseURL,
        pathPrefix,
        defaultApiKey: apiKey,
        description: description || '用户自定义站点'
    };
    
    let success;
    if (editingKey) {
        // 编辑模式
        success = window.aiImageAPI.updateCustomSite(editingKey, config);
    } else {
        // 添加模式 - 生成唯一 key
        const key = 'custom-' + Date.now();
        success = window.aiImageAPI.addCustomSite(key, config);
    }
    
    if (success) {
        closeCustomSiteModal();
        renderSiteCards();
    } else {
        alert('保存失败，请重试');
    }
}

// 初始化设置模态框事件监听
function initSettingsModalEvents() {
    // 打开设置模态框时渲染站点卡片
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsBtnMobile = document.getElementById('settingsBtnMobile');
    
    // 添加自定义站点按钮
    const addCustomSiteBtn = document.getElementById('addCustomSiteBtn');
    if (addCustomSiteBtn) {
        addCustomSiteBtn.addEventListener('click', openAddCustomSiteModal);
    }
    
    // 关闭设置模态框
    const closeSettingsX = document.getElementById('closeSettingsX');
    const closeSettings = document.getElementById('closeSettings');
    const settingsModal = document.getElementById('settingsModal');
    
    const closeSettingsModal = () => {
        if (settingsModal) settingsModal.classList.add('hidden');
    };
    
    if (closeSettingsX) closeSettingsX.addEventListener('click', closeSettingsModal);
    if (closeSettings) closeSettings.addEventListener('click', closeSettingsModal);
    
    // 点击模态框外部关闭
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) closeSettingsModal();
        });
    }
    
    // 自定义站点模态框事件
    const cancelCustomSite = document.getElementById('cancelCustomSite');
    const saveCustomSite = document.getElementById('saveCustomSite');
    const customSiteModal = document.getElementById('customSiteModal');
    
    if (cancelCustomSite) cancelCustomSite.addEventListener('click', closeCustomSiteModal);
    if (saveCustomSite) saveCustomSite.addEventListener('click', saveCustomSiteFromModal);
    
    // 点击模态框外部关闭
    if (customSiteModal) {
        customSiteModal.addEventListener('click', (e) => {
            if (e.target === customSiteModal) closeCustomSiteModal();
        });
    }
    
    // 保存 API 配置按钮
    const saveApiConfig = document.getElementById('saveApiConfig');
    if (saveApiConfig) {
        saveApiConfig.addEventListener('click', () => {
            const apiKeyInput = document.getElementById('apiKeyInput');
            const visionApiKeyInput = document.getElementById('visionApiKeyInput');
            if (apiKeyInput && window.aiImageAPI) {
                const apiKey = apiKeyInput.value.trim();
                const visionApiKey = visionApiKeyInput?.value.trim();
                
                // 保存图片生成 API Key
                window.aiImageAPI.saveApiKey(apiKey);
                
                // 保存图像理解 API Key（包括清空操作）
                if (visionApiKey !== undefined) {
                    window.aiImageAPI.saveVisionApiKey(visionApiKey);
                }
                
                // 显示保存成功提示
                if (window.app && window.app.showToast) {
                    window.app.showToast('配置已保存', 'success');
                } else {
                    alert('配置已保存');
                }
                closeSettingsModal();
                
                // 更新设置按钮状态
                if (window.app && window.app.updateApiStatus) {
                    window.app.updateApiStatus(true);
                }
            }
        });
    }
    
    // 测试连接按钮
    const testConnection = document.getElementById('testConnection');
    if (testConnection) {
        testConnection.addEventListener('click', async () => {
            const apiKeyInput = document.getElementById('apiKeyInput');
            const apiKey = apiKeyInput?.value.trim();
            
            if (!apiKey) {
                alert('请先输入 API Key');
                return;
            }
            
            testConnection.disabled = true;
            testConnection.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>测试中...';
            
            try {
                // 简单的连接测试 - 调用一个轻量级接口
                const currentSite = window.aiImageAPI.getCurrentSite();
                const testUrl = currentSite.baseURL + '/v1/models';
                
                const response = await fetch(testUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                    }
                });
                
                if (response.ok) {
                    alert('✅ 连接成功！');
                } else {
                    alert(`❌ 连接失败：${response.status} ${response.statusText}`);
                }
            } catch (error) {
                alert(`❌ 连接失败：${error.message}`);
            } finally {
                testConnection.disabled = false;
                testConnection.innerHTML = '<i class="fas fa-plug mr-2"></i>测试连接';
            }
        });
    }
    
    // API Key 显示/隐藏切换
    const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');
    const apiKeyInput = document.getElementById('apiKeyInput');
    if (toggleApiKeyVisibility && apiKeyInput) {
        toggleApiKeyVisibility.addEventListener('click', () => {
            const icon = toggleApiKeyVisibility.querySelector('i');
            if (apiKeyInput.type === 'password') {
                apiKeyInput.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                apiKeyInput.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });
    }
    
    // "如何获取 API Key" 折叠展开
    const toggleHowToGet = document.getElementById('toggleHowToGet');
    const howToGetContent = document.getElementById('howToGetContent');
    const howToGetIcon = document.getElementById('howToGetIcon');
    if (toggleHowToGet && howToGetContent && howToGetIcon) {
        toggleHowToGet.addEventListener('click', () => {
            howToGetContent.classList.toggle('hidden');
            howToGetIcon.classList.toggle('rotate-180');
        });
    }
}

// 在 DOMContentLoaded 时初始化设置模态框事件
document.addEventListener('DOMContentLoaded', () => {
    // 延迟初始化，确保 DOM 已完全加载
    setTimeout(() => {
        if (typeof initSettingsModalEvents === 'function') {
            initSettingsModalEvents();
        }
    }, 100);
});
