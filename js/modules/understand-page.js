/**
 * 图像理解页面模块
 * 支持多图联合分析，使用 OpenAI 兼容 API
 */
class UnderstandPage {
    constructor(app) {
        this.app = app;
        this.uploadedImages = [];  // 存储上传的多张图片
        this.currentModel = null;  // 当前选择的模型ID
        this.modelConfig = null;   // 模型配置数据
        this.isAnalyzing = false;  // 防止重复提交
        this.customModelId = '';   // 自定义模型ID
        this.modalRendered = false;  // 模型弹窗是否已渲染（懒加载标记）

        // 角色系统
        this.roleConfig = null;    // 角色配置数据
        this.currentRole = null;   // 当前选择的角色ID
        this.isCustomPrompt = false;  // 是否使用自定义提示词

        // 调试标志：用于验证样式应用
        this.styleDebugLogged = false;

        this.init();
    }

    async init() {
        // 加载模型配置
        await this.loadModelConfig();
        // 加载角色配置
        await this.loadRoleConfig();
        // 绑定事件
        this.bindEvents();
        // 监听语言切换
        this.setupLanguageListener();
    }

    /**
     * 设置语言切换监听器
     */
    setupLanguageListener() {
        if (this.app?.i18n) {
            this.app.i18n.onLanguageChange((lang) => {
                console.log('UnderstandPage: 语言切换为', lang);
                // 重新渲染角色按钮
                this.renderRoleButtons();
                // 如果模型弹窗已渲染，重新渲染
                if (this.modalRendered) {
                    this.renderModelSelectionModal();
                }
            });
        }
    }

    /**
     * 加载模型配置JSON
     */
    async loadModelConfig() {
        try {
            const response = await fetch('data/vision-models.json?v=' + Date.now());
            this.modelConfig = await response.json();
            this.currentModel = this.modelConfig.defaultModel;
            console.log('✅ 模型配置加载成功:', this.modelConfig);

            // 根据配置控制自定义模型区域显示
            this.updateCustomModelArea();

            // 更新按钮显示
            this.updateCurrentModelDisplay();
        } catch (error) {
            console.error('❌ 模型配置加载失败:', error);
            // 使用默认配置
            this.modelConfig = {
                models: [
                    {
                        id: 'gpt-5.2',
                        displayName: 'GPT-5.2',
                        shortName: 'GPT-5.2',
                        icon: '🚀',
                        recommended: true
                    }
                ],
                defaultModel: 'gpt-5.2'
            };
            this.currentModel = 'gpt-5.2';
            this.updateCurrentModelDisplay();
        }
    }

    /**
     * 加载角色配置JSON
     */
    async loadRoleConfig() {
        try {
            const response = await fetch('data/understand-roles.json?v=' + Date.now());
            this.roleConfig = await response.json();

            // 设置默认角色
            const defaultRole = this.roleConfig.roles.find(r => r.default);
            this.currentRole = defaultRole ? defaultRole.id : this.roleConfig.roles[0].id;

            console.log('✅ 角色配置加载成功:', this.roleConfig);

            // 渲染角色按钮
            this.renderRoleButtons();
            // 应用默认角色提示词
            this.applyRolePrompt(this.currentRole);
        } catch (error) {
            console.error('❌ 角色配置加载失败:', error);
            // 使用默认配置
            this.roleConfig = {
                roles: [
                    {
                        id: 'universal',
                        name: '万物识别+百科',
                        icon: '🔍',
                        shortName: '万物识别',
                        prompt: '请详细识别并分析图片中的内容。',
                        default: true
                    }
                ]
            };
            this.currentRole = 'universal';
            this.renderRoleButtons();
        }
    }

    bindEvents() {
        // 等待 DOM 加载完成后绑定事件
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupEventListeners());
        } else {
            this.setupEventListeners();
        }
    }

    setupEventListeners() {
        // 分析按钮
        const analyzeBtn = document.getElementById('analyzeBtn');
        if (analyzeBtn) {
            analyzeBtn.addEventListener('click', () => this.analyzeImages());
        }

        // 模型选择按钮
        const selectModelBtn = document.getElementById('selectModelBtn');
        if (selectModelBtn) {
            selectModelBtn.addEventListener('click', () => this.openModelSelectionModal());
        }

        // 关闭模型选择弹窗
        const closeModalBtn = document.getElementById('closeVisionModelModal');
        const modal = document.getElementById('visionModelModal');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => this.closeModelSelectionModal());
        }
        if (modal) {
            // 点击弹窗外部关闭
            modal.addEventListener('click', (e) => {
                if (e.target.id === 'visionModelModal') {
                    this.closeModelSelectionModal();
                }
            });
        }

        // 图片上传区域 - 点击上传
        const imageArea = document.getElementById('understandImageArea');
        if (imageArea) {
            imageArea.addEventListener('click', (e) => {
                // 如果点击的是删除按钮，不触发上传
                if (e.target.closest('.delete-image-btn')) return;
                // 如果点击的是"添加更多"区域
                if (e.target.closest('#addMoreUnderstandArea')) {
                    this.triggerFileUpload();
                    return;
                }
                // 只有在显示上传提示时才触发上传
                const uploadPrompt = document.getElementById('understandUploadPrompt');
                if (uploadPrompt && !uploadPrompt.classList.contains('hidden')) {
                    this.triggerFileUpload();
                }
            });

            // 拖拽上传
            imageArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                imageArea.classList.add('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            imageArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                imageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            imageArea.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                imageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');

                const files = Array.from(e.dataTransfer.files).filter(file =>
                    file.type.startsWith('image/')
                );

                if (files.length > 0) {
                    this.handleMultipleImageUpload(files);
                }
            });
        }

        // 粘贴图片支持
        document.addEventListener('paste', (e) => {
            // 只在图像理解页面激活时处理粘贴
            if (this.app.currentTab !== 'understand') return;

            const items = e.clipboardData?.items;
            if (!items) return;

            const imageFiles = [];
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const file = items[i].getAsFile();
                    if (file) imageFiles.push(file);
                }
            }

            if (imageFiles.length > 0) {
                e.preventDefault();
                this.handleMultipleImageUpload(imageFiles);
            }
        });

        // 复制结果按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyResult());
        }

        // 自定义模型折叠按钮
        const toggleBtn = document.getElementById('toggleCustomModel');
        const customArea = document.getElementById('customModelInputArea');
        if (toggleBtn && customArea) {
            toggleBtn.addEventListener('click', () => {
                const isHidden = customArea.classList.contains('hidden');
                if (isHidden) {
                    customArea.classList.remove('hidden');
                    toggleBtn.innerHTML = '<i class="fas fa-chevron-up mr-1"></i>收起';
                } else {
                    customArea.classList.add('hidden');
                    toggleBtn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i>展开';
                }
            });
        }

        // 自定义模型输入
        const customInput = document.getElementById('customModelInput');
        if (customInput) {
            customInput.addEventListener('input', (e) => {
                this.customModelId = e.target.value.trim();
            });
        }

        // 角色选择器 - 使用事件委托
        const roleSelector = document.getElementById('understandRoleSelector');
        if (roleSelector) {
            roleSelector.addEventListener('click', (e) => {
                const roleBtn = e.target.closest('.role-btn');
                if (roleBtn) {
                    const roleId = roleBtn.dataset.roleId;
                    this.selectRole(roleId);
                }
            });
        }

        // 自定义提示词按钮
        const customPromptBtn = document.getElementById('customPromptBtn');
        if (customPromptBtn) {
            customPromptBtn.addEventListener('click', () => {
                this.enableCustomPrompt();
            });
        }
    }

    /**
     * 打开模型选择弹窗（懒加载）
     */
    openModelSelectionModal() {
        const modal = document.getElementById('visionModelModal');
        if (!modal) return;

        // 如果还没渲染过，现在渲染（懒加载）
        if (!this.modalRendered) {
            this.renderModelSelectionModal();
            this.modalRendered = true;
        }

        modal.classList.remove('hidden');
    }

    /**
     * 关闭模型选择弹窗
     */
    closeModelSelectionModal() {
        const modal = document.getElementById('visionModelModal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    /**
     * 渲染模型选择弹窗内容（懒加载）
     */
    renderModelSelectionModal() {
        const listContainer = document.getElementById('visionModelList');
        if (!listContainer || !this.modelConfig) return;

        const i18n = this.app?.i18n;

        listContainer.innerHTML = this.modelConfig.models.map(model => {
            // 使用 i18n 翻译，如果有的话
            const modelData = i18n?.t(`understand.visionModelData.${model.id}`) || {};
            const displayName = modelData.displayName || model.shortName || model.displayName || model.name || model.id;
            const description = modelData.description || model.description || '';
            const features = modelData.features || model.features || [];
            const recommendedText = i18n?.t('understand.visionModelData.recommended') || '推荐';
            const currentText = i18n?.t('understand.visionModelData.current') || '当前';

            return `
            <div class="model-card cursor-pointer p-4 border-2 rounded-lg transition-all hover:shadow-lg
                        ${model.id === this.currentModel
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-blue-300'}"
                 data-model-id="${model.id}"
                 onclick="understandPage.selectModelAndClose('${model.id}')">
                <div class="flex items-start space-x-4">
                    <div class="text-3xl">${model.icon || '🤖'}</div>
                    <div class="flex-1">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center space-x-2">
                                <span class="text-gray-800 font-semibold text-lg">${displayName}</span>
                                ${model.recommended ? `<span class="bg-yellow-400 text-white text-xs px-2 py-1 rounded font-medium">${recommendedText}</span>` : ''}
                                ${model.id === this.currentModel ? `<span class="bg-blue-500 text-white text-xs px-2 py-1 rounded font-medium">${currentText}</span>` : ''}
                            </div>
                            ${model.price ? `<span class="text-gray-500 text-sm font-mono">${model.price}</span>` : ''}
                        </div>
                        <p class="text-gray-600 text-sm mb-3">${description}</p>
                        ${features.length > 0 ? `
                            <div class="flex flex-wrap gap-2">
                                ${features.map(f => `<span class="bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded">${f}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
        }).join('');
    }

    /**
     * 选择模型并关闭弹窗
     */
    selectModelAndClose(modelId) {
        this.selectModel(modelId);
        this.closeModelSelectionModal();
        this.app.showToast(`已切换到 ${this.getModelDisplayName(modelId)}`, 'success');
    }

    /**
     * 选择模型
     */
    selectModel(modelId) {
        this.currentModel = modelId;
        this.updateCurrentModelDisplay();
        console.log('✅ 切换模型:', modelId);
    }

    /**
     * 更新当前模型显示
     */
    updateCurrentModelDisplay() {
        const iconEl = document.getElementById('visionModelIcon');
        const nameEl = document.getElementById('visionModelName');

        if (!this.modelConfig || !iconEl || !nameEl) return;

        const model = this.modelConfig.models.find(m => m.id === this.currentModel);
        if (model) {
            iconEl.textContent = model.icon || '🤖';
            nameEl.textContent = model.shortName || model.displayName || model.name || model.id;
        }
    }

    /**
     * 更新自定义模型区域显示
     */
    updateCustomModelArea() {
        if (!this.modelConfig) return;

        const customModelSection = document.querySelector('[data-custom-model-section]') || 
            document.getElementById('customModelInputArea')?.parentElement;
        const customInput = document.getElementById('customModelInput');

        // 根据配置显示/隐藏自定义模型区域
        if (this.modelConfig.customModelEnabled === false) {
            if (customModelSection) {
                customModelSection.style.display = 'none';
            }
        } else {
            if (customModelSection) {
                customModelSection.style.display = '';
            }
        }

        // 更新 placeholder
        if (customInput && this.modelConfig.customModelPlaceholder) {
            customInput.placeholder = this.modelConfig.customModelPlaceholder;
        }
    }

    /**
     * 渲染角色按钮
     */
    renderRoleButtons() {
        const container = document.getElementById('understandRoleSelector');
        if (!container || !this.roleConfig) return;

        container.innerHTML = '';

        this.roleConfig.roles.forEach(role => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'role-btn px-3 py-1.5 rounded-full text-sm transition-all';
            button.dataset.roleId = role.id;

            // 默认选中样式
            if (role.id === this.currentRole) {
                button.classList.add('bg-white', 'bg-opacity-20', 'text-white', 'font-medium');
            } else {
                button.classList.add('bg-white', 'bg-opacity-5', 'text-white', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10');
            }

            // 使用 i18n 翻译，如果没有则使用原始值
            const i18n = this.app?.i18n;
            const roleShortName = i18n
                ? (i18n.t(`understand.roleData.${role.id}.shortName`) || role.shortName || role.name)
                : (role.shortName || role.name);

            button.innerHTML = `
                <span class="mr-1">${role.icon}</span>
                <span>${roleShortName}</span>
            `;

            container.appendChild(button);
        });
    }

    /**
     * 选择角色
     */
    selectRole(roleId) {
        if (!this.roleConfig) return;

        const role = this.roleConfig.roles.find(r => r.id === roleId);
        if (!role) return;

        // 如果是同一个角色，不做任何操作
        if (this.currentRole === roleId && !this.isCustomPrompt) return;

        this.currentRole = roleId;
        this.isCustomPrompt = false;

        // 应用角色提示词
        this.applyRolePrompt(roleId);

        // 如果角色有推荐的默认模型，自动切换到该模型
        if (role.defaultModel) {
            this.currentModel = role.defaultModel;
            this.updateCurrentModelDisplay();
            console.log(`🔄 已切换到推荐模型: ${role.defaultModel}`);
        }

        // 更新角色按钮样式
        this.updateRoleButtonsStyle();

        // 更新角色名称显示
        this.updateRoleDisplay();

        console.log(`✅ 已切换到角色: ${role.name}`);
    }

    /**
     * 应用角色提示词
     */
    applyRolePrompt(roleId) {
        const role = this.roleConfig?.roles.find(r => r.id === roleId);
        if (!role) return;

        const textarea = document.getElementById('understandPrompt');
        if (textarea) {
            textarea.value = role.prompt;
            // 触发输入事件以便其他逻辑响应
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /**
     * 启用自定义提示词模式
     */
    enableCustomPrompt() {
        this.isCustomPrompt = true;

        // 清除角色选中样式
        const roleButtons = document.querySelectorAll('.role-btn');
        roleButtons.forEach(btn => {
            btn.classList.remove('bg-white', 'bg-opacity-20', 'font-medium');
            btn.classList.add('bg-white', 'bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10');
        });

        // 更新显示
        this.updateRoleDisplay();

        // 聚焦到文本框
        const textarea = document.getElementById('understandPrompt');
        if (textarea) {
            textarea.focus();
        }

        console.log('✅ 已切换到自定义提示词模式');
    }

    /**
     * 更新角色按钮样式
     */
    updateRoleButtonsStyle() {
        const roleButtons = document.querySelectorAll('.role-btn');
        roleButtons.forEach(btn => {
            const roleId = btn.dataset.roleId;
            if (roleId === this.currentRole && !this.isCustomPrompt) {
                btn.classList.remove('bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10');
                btn.classList.add('bg-white', 'bg-opacity-20', 'font-medium');
            } else {
                btn.classList.remove('bg-white', 'bg-opacity-20', 'font-medium');
                btn.classList.add('bg-white', 'bg-opacity-5', 'opacity-70', 'hover:opacity-100', 'hover:bg-opacity-10');
            }
        });
    }

    /**
     * 更新角色名称显示
     */
    updateRoleDisplay() {
        const nameEl = document.getElementById('currentRoleName');
        const hintEl = document.getElementById('roleHintText');

        if (!nameEl) return;

        if (this.isCustomPrompt) {
            nameEl.textContent = '提问（自定义）';
            if (hintEl) hintEl.textContent = '您正在使用自定义提示词';
        } else {
            const role = this.roleConfig?.roles.find(r => r.id === this.currentRole);
            if (role) {
                nameEl.textContent = `提问（${role.shortName || role.name}）`;
                if (hintEl) hintEl.textContent = '点击上方角色标签快速切换提示词';
            } else {
                nameEl.textContent = '提问（可选）';
                if (hintEl) hintEl.textContent = '点击上方角色标签快速应用专业提示词';
            }
        }
    }

    /**
     * 触发文件选择对话框
     */
    triggerFileUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;  // 支持多选
        input.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                this.handleMultipleImageUpload(files);
            }
        };
        input.click();
    }

    /**
     * 处理多张图片上传（自动压缩大于2MB的图片）
     */
    async handleMultipleImageUpload(files) {
        if (!files || files.length === 0) return;

        // 显示加载提示
        this.app.showToast(`正在处理 ${files.length} 张图片...`, 'info');

        try {
            const processedImages = [];

            for (const file of files) {
                // 文件验证
                if (!file.type.startsWith('image/')) {
                    console.warn(`跳过非图片文件: ${file.name}`);
                    continue;
                }

                // 文件大小限制 (50MB)
                if (file.size > 50 * 1024 * 1024) {
                    this.app.showToast(`图片 ${file.name} 超过 50MB，已跳过`, 'warning');
                    continue;
                }

                // 转换为 Base64
                const base64 = await this.fileToBase64(file);

                // 【关键优化】所有大于2MB的图片都自动压缩，省钱！
                const needsCompression = file.size > 2 * 1024 * 1024;
                const finalBase64 = needsCompression
                    ? await this.compressImage(base64, file.type)
                    : base64;

                // 如果压缩了，显示提示
                if (needsCompression) {
                    console.log(`✅ 图片 ${file.name} 已压缩 (${(file.size / 1024 / 1024).toFixed(2)}MB → 优化后)`);
                }

                processedImages.push({
                    base64: finalBase64,
                    fileName: file.name,
                    fileSize: file.size,
                    mimeType: file.type,
                    id: Date.now() + Math.random(),  // 唯一标识
                    compressed: needsCompression  // 标记是否压缩
                });
            }

            // 添加到已上传列表
            this.uploadedImages.push(...processedImages);

            // 更新预览
            this.updateImagePreview();

            // 统计压缩数量
            const compressedCount = processedImages.filter(img => img.compressed).length;
            const message = compressedCount > 0
                ? `成功上传 ${processedImages.length} 张图片 (${compressedCount} 张已压缩优化)`
                : `成功上传 ${processedImages.length} 张图片`;

            this.app.showToast(message, 'success');

        } catch (error) {
            console.error('图片上传失败:', error);
            this.app.showToast('图片上传失败: ' + error.message, 'error');
        }
    }

    /**
     * 文件转 Base64
     */
    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // 移除 data:image/xxx;base64, 前缀
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * 压缩图片（参考图片编辑页面的设计）
     */
    compressImage(base64, mimeType) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // 限制最大尺寸为 2048px
                const maxSize = 2048;
                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = (height / width) * maxSize;
                        width = maxSize;
                    } else {
                        width = (width / height) * maxSize;
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // 转换为 JPEG，质量 0.85（与图片编辑页面一致）
                const compressedDataURL = canvas.toDataURL('image/jpeg', 0.85);
                const compressedBase64 = compressedDataURL.split(',')[1];

                resolve(compressedBase64);
            };
            img.onerror = reject;
            img.src = `data:${mimeType};base64,${base64}`;
        });
    }

    /**
     * 更新图片预览（采用图片编辑页面的样式）
     */
    updateImagePreview() {
        const uploadPrompt = document.getElementById('understandUploadPrompt');
        const imagesPreview = document.getElementById('understandImagesPreview');
        const imagesList = document.getElementById('understandImagesList');
        const countText = document.getElementById('understandCountText');

        if (!uploadPrompt || !imagesPreview || !imagesList) return;

        if (this.uploadedImages.length === 0) {
            // 显示上传提示
            uploadPrompt.classList.remove('hidden');
            imagesPreview.classList.add('hidden');
        } else {
            // 显示图片预览
            uploadPrompt.classList.add('hidden');
            imagesPreview.classList.remove('hidden');

            // 渲染图片列表
            imagesList.innerHTML = this.uploadedImages.map((img, index) => `
                <div class="relative group aspect-square">
                    <img src="data:${img.mimeType};base64,${img.base64}"
                         alt="${img.fileName}"
                         class="w-full h-full object-cover rounded-lg shadow-md">
                    ${img.compressed ? '<div class="absolute top-1 left-1 bg-green-500 text-white text-xs px-1.5 py-0.5 rounded opacity-90" title="已压缩优化"><i class="fas fa-check"></i></div>' : ''}
                    <button class="delete-image-btn absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-7 h-7 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            onclick="understandPage.removeImage(${index}); event.stopPropagation();">
                        <i class="fas fa-times text-sm"></i>
                    </button>
                    <div class="absolute bottom-0 left-0 right-0 bg-black bg-opacity-70 text-white text-xs p-1.5 rounded-b-lg truncate">
                        ${img.fileName}
                    </div>
                </div>
            `).join('');

            // 更新计数
            if (countText) {
                countText.textContent = `(${this.uploadedImages.length})`;
            }
        }
    }

    /**
     * 删除单张图片
     */
    removeImage(index) {
        this.uploadedImages.splice(index, 1);
        this.updateImagePreview();
        this.app.showToast('已删除图片', 'info');
    }

    /**
     * 清空所有图片
     */
    clearAllImages() {
        this.uploadedImages = [];
        this.updateImagePreview();
        this.app.showToast('已清空所有图片', 'info');
    }

    /**
     * 分析图片
     */
    async analyzeImages() {
        // 验证：是否有图片
        if (this.uploadedImages.length === 0) {
            this.app.showToast('请先上传图片', 'error');
            return;
        }

        // 验证：是否有 API Key
        if (!window.aiImageAPI || !window.aiImageAPI.visionApiKey) {
            this.app.showToast('请先在设置中配置图像理解 API Key', 'error');
            this.app.openSettings();
            return;
        }

        // 防止重复提交
        if (this.isAnalyzing) {
            this.app.showToast('正在分析中，请稍候...', 'warning');
            return;
        }

        this.isAnalyzing = true;

        // 重置样式调试标志
        this.styleDebugLogged = false;

        // 获取提示词
        const promptInput = document.getElementById('understandPrompt');
        const prompt = promptInput ? promptInput.value.trim() : '';
        const finalPrompt = prompt || '请详细分析这些图片的内容，包括场景、物体、人物、氛围等。';

        // 确定使用的模型
        const modelToUse = this.customModelId || this.currentModel;

        // 显示加载状态（准备流式输出容器）
        this.showAnalyzingStream(modelToUse);

        // 用于累积完整结果（用于复制功能）
        let fullResult = '';

        try {
            // 调用流式 API（不传 maxTokens，让模型自己控制输出长度）
            await window.aiImageAPI.analyzeImagesStream(
                this.uploadedImages,
                finalPrompt,
                modelToUse,
                null,  // 不限制 max_tokens，避免影响推理模型
                // onChunk: 每次接收到文本片段时调用
                (chunk) => {
                    fullResult += chunk;
                    this.appendResultChunk(chunk);
                },
                // onComplete: 流式输出完成时调用
                () => {
                    console.log(`✅ 流式分析完成 - 总长度: ${fullResult.length} 字符`);
                    this.onStreamComplete(fullResult, modelToUse);
                    this.app.showToast('分析完成！', 'success');
                    this.isAnalyzing = false;
                },
                // onError: 发生错误时调用
                (error) => {
                    console.error('图像分析失败:', error);
                    this.showError(error.message || '分析失败，请重试');
                    this.app.showDetailedError(error, '图像分析失败');
                    this.isAnalyzing = false;
                }
            );

        } catch (error) {
            console.error('图像分析失败:', error);
            this.showError(error.message || '分析失败，请重试');
            this.app.showDetailedError(error, '图像分析失败');
            this.isAnalyzing = false;
        }
    }

    /**
     * 显示分析中状态
     */
    showAnalyzing(modelId) {
        const resultContainer = document.getElementById('understandResult');
        if (!resultContainer) return;

        const modelName = this.getModelDisplayName(modelId);
        const compressedCount = this.uploadedImages.filter(img => img.compressed).length;

        resultContainer.innerHTML = `
            <div class="text-center py-12">
                <div class="inline-block relative">
                    <i class="fas fa-brain text-6xl text-white opacity-30 mb-4 animate-pulse"></i>
                </div>
                <p class="text-white text-lg mb-2">AI 正在分析图片...</p>
                <p class="text-white opacity-50 text-sm">使用模型: ${modelName}</p>
                <p class="text-white opacity-50 text-xs mt-1">图片数量: ${this.uploadedImages.length} 张${compressedCount > 0 ? ` (${compressedCount} 张已优化)` : ''}</p>
                <div class="mt-4">
                    <div class="w-48 h-1 bg-white bg-opacity-20 rounded-full mx-auto overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full animate-progress"></div>
                    </div>
                </div>
            </div>
        `;

        // 隐藏复制按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) copyBtn.classList.add('hidden');
    }

    /**
     * 显示流式分析状态（准备流式输出容器）
     */
    showAnalyzingStream(modelId) {
        const resultContainer = document.getElementById('understandResult');
        if (!resultContainer) return;

        const modelName = this.getModelDisplayName(modelId);
        const compressedCount = this.uploadedImages.filter(img => img.compressed).length;

        // 初始化流式输出容器（直接在容器内显示，无嵌套）
        resultContainer.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <h3 class="text-white text-lg font-semibold flex items-center">
                    <i class="fas fa-brain text-blue-400 mr-2 animate-pulse"></i>
                    AI 正在分析中...
                </h3>
                <span class="text-white opacity-50 text-sm">
                    ${modelName}
                </span>
            </div>
            <div id="streamingContent" class="text-white" style="min-height: 300px; line-height: 1.8; word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap; width: 100%; display: block; overflow: visible;">
                <span class="typing-cursor"></span>
            </div>
            <div class="flex items-center justify-between text-white opacity-50 text-xs mt-3">
                <span>分析图片: ${this.uploadedImages.length} 张${compressedCount > 0 ? ` (${compressedCount} 张已优化)` : ''}</span>
                <span>正在接收数据...</span>
            </div>
        `;

        // 隐藏复制按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) copyBtn.classList.add('hidden');
    }

    /**
     * 追加流式输出的文本片段
     */
    appendResultChunk(chunk) {
        const contentEl = document.getElementById('streamingContent');
        if (!contentEl) {
            console.error('❌ streamingContent 元素不存在');
            return;
        }

        // 【调试】首次调用时验证样式是否正确应用
        if (!this.styleDebugLogged) {
            this.styleDebugLogged = true;
            const computedStyle = window.getComputedStyle(contentEl);
            console.log('🎨 streamingContent 实际应用的样式:');
            console.log('  - white-space:', computedStyle.whiteSpace);
            console.log('  - display:', computedStyle.display);
            console.log('  - min-height:', computedStyle.minHeight);
            console.log('  - overflow:', computedStyle.overflow);
            console.log('  - word-wrap:', computedStyle.wordWrap);
            console.log('  - line-height:', computedStyle.lineHeight);
        }

        // 移除光标（如果存在）
        const cursor = contentEl.querySelector('.typing-cursor');
        if (cursor) cursor.remove();

        // 创建文本节点并追加
        const textNode = document.createTextNode(chunk);
        contentEl.appendChild(textNode);

        // 调试：输出当前内容长度（排除光标）
        const textNodes = Array.from(contentEl.childNodes)
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent)
            .join('');
        console.log(`📝 追加 chunk: "${chunk}" (长度: ${chunk.length})`);
        console.log(`   当前文本总长度: ${textNodes.length} (不含光标)`);

        // 重新添加光标
        const newCursor = document.createElement('span');
        newCursor.className = 'typing-cursor';
        contentEl.appendChild(newCursor);

        // 自动滚动到底部
        const resultContainer = document.getElementById('understandResult');
        if (resultContainer) {
            resultContainer.scrollTop = resultContainer.scrollHeight;
        }
    }

    /**
     * 流式输出完成后的处理
     */
    onStreamComplete(fullResult, modelId) {
        const contentEl = document.getElementById('streamingContent');
        if (!contentEl) return;

        // 存储完整结果用于复制
        this.lastResult = fullResult;

        // 移除光标
        const cursor = contentEl.querySelector('.typing-cursor');
        if (cursor) cursor.remove();

        // 更新标题图标（移除 pulse 动画）
        const resultContainer = document.getElementById('understandResult');
        if (resultContainer) {
            const icon = resultContainer.querySelector('.fa-brain');
            if (icon) {
                icon.classList.remove('fa-brain', 'animate-pulse', 'text-blue-400');
                icon.classList.add('fa-check-circle', 'text-green-400');
            }
            const title = resultContainer.querySelector('h3');
            if (title && title.childNodes[1]) {
                title.childNodes[1].textContent = '分析结果';
            }

            // 更新底部时间戳
            const timeStamp = resultContainer.querySelector('.text-xs span:last-child');
            if (timeStamp) {
                timeStamp.textContent = new Date().toLocaleString('zh-CN');
            }
        }

        // 显示复制按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) copyBtn.classList.remove('hidden');

        console.log('✅ 流式输出完成，总字符数:', fullResult.length);
    }

    /**
     * 显示分析结果
     */
    showResult(resultText, modelId) {
        const resultContainer = document.getElementById('understandResult');
        if (!resultContainer) return;

        // 存储结果用于复制
        this.lastResult = resultText;

        const modelName = this.getModelDisplayName(modelId);

        resultContainer.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <h3 class="text-white text-lg font-semibold flex items-center">
                    <i class="fas fa-check-circle text-green-400 mr-2"></i>
                    分析结果
                </h3>
                <span class="text-white opacity-50 text-sm">
                    ${modelName}
                </span>
            </div>
            <div class="text-white leading-relaxed">
                ${this.formatResultText(resultText)}
            </div>
            <div class="flex items-center justify-between text-white opacity-50 text-xs mt-3">
                <span>分析图片: ${this.uploadedImages.length} 张</span>
                <span>${new Date().toLocaleString('zh-CN')}</span>
            </div>
        `;

        // 显示复制按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) copyBtn.classList.remove('hidden');
    }

    /**
     * 显示错误
     */
    showError(errorMessage) {
        const resultContainer = document.getElementById('understandResult');
        if (!resultContainer) return;

        resultContainer.innerHTML = `
            <div class="text-center py-12">
                <i class="fas fa-exclamation-triangle text-6xl text-red-400 opacity-70 mb-4"></i>
                <p class="text-white text-lg mb-2">分析失败</p>
                <p class="text-red-300 text-sm mb-4">${this.escapeHtml(errorMessage)}</p>
                <button onclick="understandPage.analyzeImages()"
                        type="button"
                        class="bg-blue-500 hover:bg-blue-600 text-white px-6 py-2 rounded-lg transition-colors">
                    <i class="fas fa-redo mr-2"></i>重试
                </button>
            </div>
        `;

        // 隐藏复制按钮
        const copyBtn = document.getElementById('copyResultBtn');
        if (copyBtn) copyBtn.classList.add('hidden');
    }

    /**
     * 格式化结果文本（支持换行）
     */
    formatResultText(text) {
        // 转义 HTML
        let formatted = this.escapeHtml(text);

        // 将换行符转换为 <br>
        formatted = formatted.replace(/\n/g, '<br>');

        // 检测 Markdown 格式的粗体 **text**
        formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // 检测列表项
        formatted = formatted.replace(/^- (.+?)$/gm, '<li>$1</li>');
        formatted = formatted.replace(/(<li>.*<\/li>)/s, '<ul class="list-disc pl-5 space-y-1">$1</ul>');

        return formatted;
    }

    /**
     * HTML 转义
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 获取模型显示名称
     */
    getModelDisplayName(modelId) {
        if (!this.modelConfig) return modelId;

        // 如果是自定义模型
        if (this.customModelId && modelId === this.customModelId) {
            return `自定义: ${modelId}`;
        }

        const model = this.modelConfig.models.find(m => m.id === modelId);
        return model ? model.displayName : modelId;
    }

    /**
     * 复制分析结果
     */
    async copyResult() {
        if (!this.lastResult) {
            this.app.showToast('没有可复制的内容', 'warning');
            return;
        }

        try {
            await navigator.clipboard.writeText(this.lastResult);
            this.app.showToast('已复制到剪贴板', 'success');
        } catch (error) {
            console.error('复制失败:', error);

            // 降级方案：使用传统方法
            const textarea = document.createElement('textarea');
            textarea.value = this.lastResult;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();

            try {
                document.execCommand('copy');
                this.app.showToast('已复制到剪贴板', 'success');
            } catch (err) {
                this.app.showToast('复制失败，请手动复制', 'error');
            }

            document.body.removeChild(textarea);
        }
    }

    /**
     * 页面激活时调用
     */
    onActivate() {
        console.log('图像理解页面已激活');

        // 更新当前模型显示
        if (this.modelConfig) {
            this.updateCurrentModelDisplay();
        }

        // 如果还没有图片，显示初始状态
        if (this.uploadedImages.length === 0) {
            this.updateImagePreview();
        }
    }

    /**
     * 页面失活时调用
     */
    onDeactivate() {
        console.log('图像理解页面已失活');
    }
}

// 导出为全局类
window.UnderstandPage = UnderstandPage;
