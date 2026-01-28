// 模型对比页面模块
class ComparePage {
    constructor(app) {
        this.app = app;
        this.leftModel = null;
        this.rightModel = null;
        this.currentRatio = '1:1';
        this.referenceImages = [];
        this.maxReferenceImages = 8;
        this.isProcessing = false;
        this.isSelectingFile = false; // 初始化文件选择标志
        // 获取API服务实例
        this.apiService = window.aiImageAPI;

        this.init();
    }

    init() {
        this.bindEvents();
    }

    // 获取 i18n 实例
    get i18n() {
        return this.app?.i18n;
    }

    // 响应语言切换
    onLanguageChange(lang) {
        console.log('ComparePage: 语言切换为', lang);
        // 重新初始化模型选择器以更新文本
        this.initModelSelectors();
        // 更新参考图显示
        this.updateReferenceImageDisplay();
        // 更新比例按钮（如果需要）
        this.updateRatioButtons();
    }

    bindEvents() {
        // 这些事件将在onActivate时动态绑定
    }

    onActivate() {
        console.log('模型对比页面已激活');
        this.setupEventListeners();

        // 确保API服务已经初始化后再初始化模型选择器
        // 增加延迟以确保在直接访问URL时API也已完全初始化
        setTimeout(() => {
            console.log('🔄 延迟初始化模型选择器开始...');
            this.initModelSelectors();
            this.updateRatioButtons();

            // 检查当前选中的模型是否有Flux
            this.checkFluxModelsAndUpdateLimit();
            this.updateReferenceImageDisplay();
        }, 300); // 增加到300ms
    }

    onDeactivate() {
        console.log('模型对比页面已停用');
        this.clearEventListeners();
    }

    setupEventListeners() {
        // 模型选择器
        const leftModelSelect = document.getElementById('leftModelSelect');
        const rightModelSelect = document.getElementById('rightModelSelect');

        if (leftModelSelect) {
            leftModelSelect.addEventListener('change', (e) => this.onLeftModelChange(e));
        }

        if (rightModelSelect) {
            rightModelSelect.addEventListener('change', (e) => this.onRightModelChange(e));
        }

        // 比例选择
        const compareRatioButtons = document.getElementById('compareRatioButtons');
        if (compareRatioButtons) {
            compareRatioButtons.addEventListener('click', (e) => {
                const button = e.target.closest('.ratio-btn');
                if (button && !button.hasAttribute('disabled')) {
                    const ratio = button.dataset.ratio;
                    if (ratio) {
                        this.selectRatio(ratio);
                    }
                }
            });
        }

        // 参考图上传
        const compareReferenceArea = document.getElementById('compareReferenceImageArea');
        if (compareReferenceArea) {
            compareReferenceArea.addEventListener('click', (e) => {
                // 检查是否点击了删除按钮
                if (e.target.closest('button')) {
                    return; // 不触发文件选择
                }

                // 检查是否点击了已上传的图片
                if (e.target.tagName === 'IMG' && e.target.closest('.relative')) {
                    return; // 不触发文件选择
                }

                // 如果没有图片，点击整个区域都触发上传
                if (this.referenceImages.length === 0) {
                    e.stopPropagation();
                    this.triggerFileSelection();
                    return;
                }

                // 如果有图片，只有点击"添加更多"按钮才触发（通过onclick处理）
                // 这里不需要额外处理，因为"添加更多"按钮有自己的onclick
            });
            compareReferenceArea.addEventListener('dragover', (e) => this.handleDragOver(e));
            compareReferenceArea.addEventListener('drop', (e) => this.handleDrop(e));
            compareReferenceArea.addEventListener('dragleave', (e) => {
                if (e.target === compareReferenceArea) {
                    compareReferenceArea.classList.remove('drag-over');
                }
            });
        }

        // 开始对比按钮
        const compareBtn = document.getElementById('compareBtn');
        if (compareBtn) {
            compareBtn.addEventListener('click', () => this.startComparison());
        }

        // 清空输入按钮
        const clearCompareInputBtn = document.getElementById('clearCompareInputBtn');
        if (clearCompareInputBtn) {
            clearCompareInputBtn.addEventListener('click', () => this.clearInput());
        }

        // 评价按钮
        const evaluationButtons = document.querySelectorAll('.evaluation-btn');
        evaluationButtons.forEach(btn => {
            btn.addEventListener('click', (e) => this.handleEvaluation(e));
        });
    }

    clearEventListeners() {
        // 清理事件监听器以避免内存泄漏
    }

    initModelSelectors() {
        console.log('🔧 初始化模型选择器...');

        const models = window.aiImageAPI?.getAllModels();
        const leftSelect = document.getElementById('leftModelSelect');
        const rightSelect = document.getElementById('rightModelSelect');

        console.log('📋 获取到的模型数据:', models);
        console.log('🎯 DOM元素检查:', { leftSelect: !!leftSelect, rightSelect: !!rightSelect });

        if (!leftSelect || !rightSelect) {
            console.error('❌ 模型选择器DOM元素未找到');
            return;
        }

        if (!models || Object.keys(models).length === 0) {
            console.error('❌ 模型数据为空');
            return;
        }

        // 清空现有选项
        const leftPlaceholder = this.i18n ? this.i18n.t('compare.models.selectLeft') : '选择左侧模型';
        const rightPlaceholder = this.i18n ? this.i18n.t('compare.models.selectRight') : '选择右侧模型';
        leftSelect.innerHTML = `<option value="">${leftPlaceholder}</option>`;
        rightSelect.innerHTML = `<option value="">${rightPlaceholder}</option>`;

        // 添加模型选项
        Object.entries(models).forEach(([key, model]) => {
            console.log(`➕ 添加模型: ${key} - ${model.name}`);
            const leftOption = new Option(model.name, key);
            const rightOption = new Option(model.name, key);
            leftSelect.add(leftOption);
            rightSelect.add(rightOption);
        });

        // 设置默认选择: Nano Banana Pro vs Seedream 4.5
        const defaultLeft = 'gemini-3-pro-image-preview';  // Nano Banana Pro
        const defaultRight = 'seedream-4-5-251128';          // Seedream 4.5

        console.log(`🎯 尝试设置默认模型: 左=${defaultLeft}, 右=${defaultRight}`);
        console.log(`✅ 模型存在检查: 左=${!!models[defaultLeft]}, 右=${!!models[defaultRight]}`);

        if (models[defaultLeft] && models[defaultRight]) {
            leftSelect.value = defaultLeft;
            rightSelect.value = defaultRight;
            this.leftModel = defaultLeft;
            this.rightModel = defaultRight;
            console.log('✅ 默认模型设置成功');
        } else {
            // 如果默认模型不存在，使用前两个模型
            const modelKeys = Object.keys(models);
            console.log('⚠️ 默认模型不存在，使用前两个可用模型:', modelKeys);

            if (modelKeys.length >= 2) {
                leftSelect.value = modelKeys[0];
                rightSelect.value = modelKeys[1];
                this.leftModel = modelKeys[0];
                this.rightModel = modelKeys[1];
                console.log(`✅ 备用模型设置成功: 左=${modelKeys[0]}, 右=${modelKeys[1]}`);
            }
        }

        // 更新模型信息显示
        this.updateModelInfo('left', this.leftModel);
        this.updateModelInfo('right', this.rightModel);

        console.log(`🎯 最终模型状态: 左=${this.leftModel}, 右=${this.rightModel}`);
    }

    onLeftModelChange(e) {
        this.leftModel = e.target.value;
        this.updateRatioButtons();
        this.updateModelInfo('left', this.leftModel);
        this.checkFluxModelsAndUpdateLimit();
    }

    onRightModelChange(e) {
        this.rightModel = e.target.value;
        this.updateRatioButtons();
        this.updateModelInfo('right', this.rightModel);
        this.checkFluxModelsAndUpdateLimit();
    }

    // 检查是否有任一模型是Flux模型
    hasAnyFluxModel() {
        if (!this.apiService) return false;

        const models = this.apiService.getAllModels();

        // 检查左侧模型
        if (this.leftModel && models[this.leftModel]) {
            const leftModelConfig = models[this.leftModel];
            if (leftModelConfig.apiType === 'flux-kontext') {
                return true;
            }
        }

        // 检查右侧模型
        if (this.rightModel && models[this.rightModel]) {
            const rightModelConfig = models[this.rightModel];
            if (rightModelConfig.apiType === 'flux-kontext') {
                return true;
            }
        }

        return false;
    }

    // 检查是否有Flux模型并更新图片限制
    checkFluxModelsAndUpdateLimit() {
        const hasFluxModel = this.hasAnyFluxModel();
        const oldLimit = this.maxReferenceImages;

        // 如果任一模型是Flux，限制为1张
        if (hasFluxModel) {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }

        // 如果限制变化了，更新UI并可能移除多余图片
        if (oldLimit !== this.maxReferenceImages) {
            // 如果当前图片数超过新限制，移除多余的
            if (this.referenceImages.length > this.maxReferenceImages) {
                const removed = this.referenceImages.length - this.maxReferenceImages;
                this.referenceImages = this.referenceImages.slice(0, this.maxReferenceImages);
                this.app.showToast(this.i18n ? this.i18n.t('compare.messages.fluxLimitRemoved', { removed }) : `Flux 模型仅支持1张图片，已移除多余的${removed}张图片`, 'info', 4000);
            }
            this.updateReferenceImageDisplay();
        }
    }

    updateModelInfo(side, modelKey) {
        const infoElement = document.getElementById(`${side}ModelInfo`);
        if (!infoElement || !modelKey) return;

        const model = window.aiImageAPI.getAllModels()[modelKey];
        if (!model) return;

        // 提取价格信息
        const priceMatch = model.displayName.match(/\$([0-9.]+)\/张/);
        const price = priceMatch ? priceMatch[1] : '未知';

        // 提取速度信息
        const speedMatch = model.displayName.match(/(\d+s)出图/);
        const speed = speedMatch ? speedMatch[1] : '未知';

        infoElement.innerHTML = `
            <div class="text-xs text-white opacity-70">
                <span>${this.i18n ? this.i18n.t('compare.models.speed', { speed }) : `速度: ${speed}`}</span> |
                <span>${this.i18n ? this.i18n.t('compare.models.price', { price }) : `价格: $${price}/张`}</span>
            </div>
        `;
    }

    updateRatioButtons() {
        if (!this.leftModel || !this.rightModel) {
            this.disableAllRatios();
            return;
        }

        const commonRatios = this.getCommonRatios(this.leftModel, this.rightModel);
        const ratioContainer = document.getElementById('compareRatioButtons');

        if (!ratioContainer) return;

        // 清空现有按钮
        ratioContainer.innerHTML = '';

        if (commonRatios.length === 0) {
            ratioContainer.innerHTML = '<div class="text-white opacity-70 text-sm">所选模型没有共同支持的尺寸</div>';
            return;
        }

        // 创建比例按钮（与首页样式保持一致）
        commonRatios.forEach((ratio, index) => {
            const button = document.createElement('button');
            button.className = 'ratio-btn px-3 py-2 rounded-md text-sm font-medium transition-all bg-white bg-opacity-15 text-white hover:bg-opacity-25';
            button.dataset.ratio = ratio.key;

            // 从 i18n 获取翻译后的文本
            const ratioData = this.i18n?.translations?.[this.i18n.currentLang]?.aspectRatios?.[ratio.key];
            const label = ratioData && ratioData.label ? ratioData.label : ratio.label;
            const description = ratioData && ratioData.description ? ratioData.description : ratio.description;

            button.innerHTML = `
                <span class="block">${label}</span>
                ${description ? `<span class="block text-xs opacity-70 mt-1">${description}</span>` : ''}
            `;

            if (index === 0) {
                button.classList.add('active');
                this.currentRatio = ratio.key;
            }

            ratioContainer.appendChild(button);
        });
    }

    getCommonRatios(model1Key, model2Key) {
        const model1 = window.aiImageAPI.getAllModels()[model1Key];
        const model2 = window.aiImageAPI.getAllModels()[model2Key];

        if (!model1 || !model2) return [];

        const ratios1 = this.getModelRatios(model1);
        const ratios2 = this.getModelRatios(model2);

        // 找出共同支持的比例
        return ratios1.filter(r1 =>
            ratios2.some(r2 => r2.key === r1.key)
        );
    }

    getModelRatios(model) {
        // 如果模型有自定义比例列表
        if (model.ratios) {
            return model.ratios;
        }

        // 如果模型支持自定义尺寸，返回默认比例
        if (model.capabilities && model.capabilities.customSize) {
            return this.app.defaultRatios;
        }

        // 如果模型不支持自定义尺寸，只返回1:1
        return [{ key: '1:1', label: '方形 1:1' }];
    }

    disableAllRatios() {
        const buttons = document.querySelectorAll('#compareRatioButtons .ratio-btn');
        buttons.forEach(btn => btn.setAttribute('disabled', 'true'));
    }

    selectRatio(ratio) {
        this.currentRatio = ratio;

        // 更新按钮状态
        document.querySelectorAll('#compareRatioButtons .ratio-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.ratio === ratio) {
                btn.classList.add('active');
            }
        });
    }

    triggerFileSelection() {
        if (this.referenceImages.length >= this.maxReferenceImages) {
            if (this.hasAnyFluxModel()) {
                this.app.showToast(this.i18n ? this.i18n.t('compare.messages.fluxModelLimit') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进 🚀', 'info', 4000);
            } else {
                this.app.showToast(this.i18n ? this.i18n.t('compare.messages.maxImagesReached', { max: this.maxReferenceImages }) : `最多只能上传${this.maxReferenceImages}张参考图`, 'warning');
            }
            return;
        }

        // 防止重复触发
        if (this.isSelectingFile) {
            return;
        }
        this.isSelectingFile = true;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const files = Array.from(e.target.files);
                this.handleMultipleReferenceImageUpload(files);
            }
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
            this.isSelectingFile = false;
        });

        // 处理取消选择的情况
        input.addEventListener('cancel', () => {
            this.isSelectingFile = false;
        });

        // 添加焦点丢失处理
        setTimeout(() => {
            this.isSelectingFile = false;
        }, 1000);

        document.body.appendChild(input);
        input.click();
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';

        const area = document.getElementById('compareReferenceImageArea');
        if (area) {
            area.classList.add('drag-over');
        }
    }

    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();

        const area = document.getElementById('compareReferenceImageArea');
        if (area) {
            area.classList.remove('drag-over');
        }

        const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
        if (files.length > 0) {
            this.handleMultipleReferenceImageUpload(files);
        }
    }

    async handleMultipleReferenceImageUpload(files) {
        // 动态检查是否有Flux模型
        if (this.hasAnyFluxModel()) {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }

        const remainingSlots = this.maxReferenceImages - this.referenceImages.length;
        const filesToProcess = files.slice(0, remainingSlots);

        if (files.length > remainingSlots) {
            if (this.hasAnyFluxModel()) {
                this.app.showToast(this.i18n ? this.i18n.t('compare.messages.fluxModelLimit') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进 🚀', 'info', 4000);
            } else {
                this.app.showToast(this.i18n ? this.i18n.t('compare.messages.uploadLimitReached', { remaining: remainingSlots, max: this.maxReferenceImages }) : `只处理前${remainingSlots}张图片，已达到${this.maxReferenceImages}张的上限`, 'warning');
            }
        }

        for (const file of filesToProcess) {
            await this.processReferenceImage(file);
        }

        this.updateReferenceImageDisplay();
    }

    async processReferenceImage(file) {
        // 文件验证
        try {
            this.validateImageFile(file);
        } catch (error) {
            this.app.showToast(error.message, 'error');
            return;
        }

        const reader = new FileReader();

        return new Promise((resolve) => {
            reader.onload = (e) => {
                const imageData = e.target.result;

                // 保存原始文件和压缩标志
                const needsCompression = file.size > 2 * 1024 * 1024; // 超过 2MB 需要压缩

                this.referenceImages.push({
                    dataUrl: imageData,
                    name: file.name,
                    size: file.size,
                    originalFile: file,  // 保存原始文件对象用于后续压缩
                    needsCompression: needsCompression  // 标记是否需要压缩
                });
                resolve();
            };

            reader.onerror = () => {
                this.app.showToast(`读取文件 ${file.name} 失败`, 'error');
                resolve();
            };

            reader.readAsDataURL(file);
        });
    }

    // 验证上传的图片文件
    validateImageFile(file) {
        // 基础检查
        if (!file.type.startsWith('image/')) {
            throw new Error(this.i18n ? this.i18n.t('compare.messages.notImageFile', { name: file.name }) : `${file.name} 不是图片文件`);
        }

        // 文件大小检查
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
            const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
            throw new Error(this.i18n ? this.i18n.t('compare.messages.fileTooLarge', { name: file.name, size: fileSizeMB }) : `${file.name} 文件过大（${fileSizeMB}MB），最大支持50MB`);
        }

        // 支持的格式列表
        const supportedTypes = [
            'image/jpeg', 'image/jpg', 'image/png',
            'image/webp', 'image/bmp'
        ];

        if (!supportedTypes.includes(file.type.toLowerCase())) {
            throw new Error(this.i18n ? this.i18n.t('compare.messages.unsupportedFormat', { name: file.name }) : `${file.name} 格式不支持，请使用 JPG、PNG、WebP 或 BMP 格式`);
        }

        return true;
    }

    // 图片压缩方法（复用自 generate-page.js）
    async compressImageIfNeeded(file) {
        const MAX_SIZE_MB = 2;
        const fileSizeMB = file.size / (1024 * 1024);

        if (fileSizeMB <= MAX_SIZE_MB) {
            console.log(`[压缩] ${file.name} (${fileSizeMB.toFixed(2)}MB) 无需压缩`);
            return file;
        }

        // 检查压缩库是否可用
        if (typeof imageCompression === 'undefined') {
            console.warn('图片压缩库未加载，跳过压缩');
            this.app.showToast(`${file.name} 过大但压缩库未加载，可能影响生成速度`, 'warning');
            return file;
        }

        try {
            console.log(`[压缩] 开始压缩 ${file.name} (${fileSizeMB.toFixed(2)}MB)`);

            const options = {
                maxSizeMB: 2,
                maxWidthOrHeight: 2048,
                useWebWorker: true,
                fileType: file.type,
                initialQuality: 0.9,
                alwaysKeepResolution: false
            };

            const compressedFile = await imageCompression(file, options);
            const compressedSizeMB = compressedFile.size / (1024 * 1024);

            console.log(`[压缩] 压缩完成: ${file.name}`);
            console.log(`[压缩] 原始大小: ${fileSizeMB.toFixed(2)}MB`);
            console.log(`[压缩] 压缩后: ${compressedSizeMB.toFixed(2)}MB`);
            console.log(`[压缩] 压缩率: ${((1 - compressedSizeMB / fileSizeMB) * 100).toFixed(1)}%`);

            return compressedFile;
        } catch (error) {
            console.error(`[压缩] 压缩失败 ${file.name}:`, error);
            this.app.showToast(`压缩 ${file.name} 失败，使用原图`, 'warning');
            return file;
        }
    }

    // 为生成准备参考图片（包括压缩处理）
    async prepareReferenceImagesForGeneration() {
        // 检查是否有需要压缩的图片
        const imagesToCompress = this.referenceImages.filter(img => img.needsCompression);

        if (imagesToCompress.length === 0) {
            console.log('[压缩] 无需压缩的图片，直接使用');
            // 所有图片都不需要压缩，直接返回当前的 dataUrl
            return this.referenceImages.map(img => ({
                dataUrl: img.dataUrl,
                name: img.name,
                size: img.size
            }));
        }

        console.log(`[压缩] 发现 ${imagesToCompress.length} 张需要压缩的图片`);

        // 显示压缩进度提示
        this.showProgressToast(`正在压缩 ${imagesToCompress.length} 张图片...`, 'info');

        // 压缩所有需要压缩的图片
        const processedImages = [];

        for (let i = 0; i < this.referenceImages.length; i++) {
            const img = this.referenceImages[i];

            if (!img.needsCompression) {
                // 不需要压缩，直接使用
                processedImages.push({
                    dataUrl: img.dataUrl,
                    name: img.name,
                    size: img.size
                });
                continue;
            }

            try {
                // 需要压缩
                const compressedFile = await this.compressImageIfNeeded(img.originalFile);

                // 将压缩后的文件转换为 base64
                const compressedBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(compressedFile);
                });

                processedImages.push({
                    dataUrl: compressedBase64,
                    name: compressedFile.name,
                    size: compressedFile.size
                });
            } catch (error) {
                console.error(`[压缩] 处理图片失败 ${img.name}:`, error);
                // 失败时使用原图
                processedImages.push({
                    dataUrl: img.dataUrl,
                    name: img.name,
                    size: img.size
                });
            }
        }

        // 显示成功提示
        this.app.showToast('图片压缩完成', 'success', 2000);

        return processedImages;
    }

    // 显示进度提示（简化版）
    showProgressToast(message, type = 'info') {
        this.app.showToast(message, type, 3000);
    }

    updateReferenceImageDisplay() {
        const uploadPrompt = document.getElementById('compareReferenceUploadPrompt');
        const area = document.getElementById('compareReferenceImageArea');

        if (!area) return;

        if (this.referenceImages.length === 0) {
            // 显示上传提示 - 恢复原始的居中布局
            area.className = 'border-2 border-dashed border-white border-opacity-20 rounded-md p-4 cursor-pointer hover:border-opacity-30 transition-all min-h-[120px] flex items-center justify-center';
            area.innerHTML = `
                <div id="compareReferenceUploadPrompt" class="space-y-2 text-center">
                    <i class="fas fa-cloud-upload-alt text-2xl text-white opacity-50"></i>
                    <p class="text-white opacity-70 text-sm">${this.i18n ? this.i18n.t('compare.upload.clickOrDrag') : '点击或拖拽上传参考图片'}</p>
                    <p class="text-white opacity-50 text-xs">${this.i18n ? this.i18n.t('compare.upload.supportedFormats') : '支持 JPG、PNG 格式'}</p>
                </div>
            `;
            return;
        }

        // 显示图片网格 - 移除居中布局类
        area.className = 'border-2 border-dashed border-white border-opacity-20 rounded-md p-4';
        area.innerHTML = `
            <div class="grid grid-cols-3 gap-2">
                ${this.referenceImages.map((img, index) => `
                    <div class="relative bg-white bg-opacity-10 rounded-lg p-2 group">
                        <div class="relative">
                            <img src="${img.dataUrl}"
                                 class="w-full aspect-square object-cover rounded-lg"
                                 alt="参考图${index + 1}">
                            <button onclick="window.comparePage.removeReferenceImage(${index})"
                                    class="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5
                                           flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100"
                                    title="移除此参考图">
                                <i class="fas fa-times text-xs"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
                ${this.referenceImages.length < this.maxReferenceImages ? `
                    <div onclick="window.comparePage.triggerFileSelection()"
                         class="border-2 border-dashed border-white border-opacity-30 hover:border-opacity-50
                                rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center
                                aspect-square group">
                        <div class="text-center">
                            <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
                            <p class="text-white opacity-50 group-hover:opacity-70 text-xs">添加更多</p>
                            <p class="text-white opacity-30 group-hover:opacity-50 text-xs">(${this.referenceImages.length}/${this.maxReferenceImages})</p>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    removeReferenceImage(index) {
        this.referenceImages.splice(index, 1);
        this.updateReferenceImageDisplay();
    }

    clearInput() {
        // 清空提示词
        const promptInput = document.getElementById('comparePrompt');
        if (promptInput) {
            promptInput.value = '';
        }

        // 清空参考图
        this.referenceImages = [];
        this.updateReferenceImageDisplay();

        // 清空结果
        const resultContainer = document.getElementById('compareResults');
        if (resultContainer) {
            resultContainer.innerHTML = '';
        }

        // 隐藏评价区域
        const evaluationArea = document.getElementById('evaluationArea');
        if (evaluationArea) {
            evaluationArea.classList.add('hidden');
        }

        this.app.showToast(this.i18n ? this.i18n.t('compare.messages.inputCleared') : '已清空输入内容', 'success');
    }

    async startComparison() {
        if (this.isProcessing) {
            this.app.showToast(this.i18n ? this.i18n.t('compare.messages.processing') : '正在处理中，请稍候', 'warning');
            return;
        }

        // 验证输入
        const promptInput = document.getElementById('comparePrompt');
        const prompt = promptInput ? promptInput.value.trim() : '';

        if (!prompt && this.referenceImages.length === 0) {
            this.app.showToast(this.i18n ? this.i18n.t('compare.messages.promptOrImageRequired') : '请输入提示词或上传参考图', 'error');
            return;
        }

        if (!this.leftModel || !this.rightModel) {
            this.app.showToast(this.i18n ? this.i18n.t('compare.messages.selectTwoModels') : '请选择两个模型进行对比', 'error');
            return;
        }

        if (this.leftModel === this.rightModel) {
            this.app.showToast(this.i18n ? this.i18n.t('compare.messages.selectDifferentModels') : '请选择不同的模型进行对比', 'warning');
            return;
        }

        this.isProcessing = true;
        this.updateCompareButton(true);

        // 显示加载状态
        this.showLoadingState();

        try {
            // 准备API调用
            const api = window.aiImageAPI;
            const hasReferenceImages = this.referenceImages.length > 0;

            // 保存当前模型
            const originalModel = api.model;

            // 并行调用两个模型
            const promises = [
                this.generateWithModel(api, this.leftModel, prompt, this.currentRatio, hasReferenceImages),
                this.generateWithModel(api, this.rightModel, prompt, this.currentRatio, hasReferenceImages)
            ];

            const results = await Promise.allSettled(promises);

            // 恢复原始模型（已在generateWithModel中处理）

            // 处理结果
            this.handleComparisonResults(results, prompt);

        } catch (error) {
            console.error('对比生成失败:', error);
            this.app.showToast('对比生成失败: ' + error.message, 'error');
        } finally {
            this.isProcessing = false;
            this.updateCompareButton(false);
        }
    }

    async generateWithModel(api, modelKey, prompt, ratio, hasReferenceImages) {
        // 保存原始模型配置
        const originalModel = api.model;
        const originalBaseURL = api.baseURL;

        try {
            // 临时切换模型
            api.model = modelKey;
            api.baseURL = api.models[modelKey].baseURL;

            // 获取当前分辨率（从 generate page 共享）
            const currentModel = api.models[modelKey];
            const supportsResolution = currentModel.capabilities?.resolutionControl;
            const resolution = supportsResolution && this.app.pages?.generate ?
                this.app.pages.generate.currentResolution : null;

            console.log(`[${modelKey}] 开始生成，参考图: ${hasReferenceImages}, 比例: ${ratio}, 分辨率: ${resolution || '默认'}`);

            let result;
            if (hasReferenceImages) {
                // 使用参考图生成
                console.log(`[${modelKey}] 使用参考图生成，参考图数量: ${this.referenceImages.length}`);

                // 压缩处理参考图（如果需要）
                const preparedImages = await this.prepareReferenceImagesForGeneration();

                result = await api.generateImageWithReference(
                    prompt,
                    preparedImages,
                    ratio,
                    1,
                    resolution
                );
            } else {
                // 纯文本生成
                console.log(`[${modelKey}] 纯文本生成`);
                result = await api.generateImage(prompt, ratio, 1, resolution);
            }

            console.log(`[${modelKey}] 生成结果:`, {
                success: result.success,
                urlsCount: result.urls?.length || 0,
                firstUrl: result.urls?.[0]?.substring(0, 100)
            });

            return result;
        } catch (error) {
            console.error(`[${modelKey}] 生成过程出错:`, error);
            throw error;
        } finally {
            // 确保恢复原始模型配置
            api.model = originalModel;
            api.baseURL = originalBaseURL;
        }
    }

    showLoadingState() {
        const resultContainer = document.getElementById('compareResults');
        if (!resultContainer) return;

        resultContainer.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="bg-white bg-opacity-10 rounded-xl p-6 animate-pulse">
                    <div class="aspect-square bg-white bg-opacity-20 rounded-lg mb-4"></div>
                    <div class="h-4 bg-white bg-opacity-20 rounded w-3/4 mb-2"></div>
                    <div class="h-4 bg-white bg-opacity-20 rounded w-1/2"></div>
                </div>
                <div class="bg-white bg-opacity-10 rounded-xl p-6 animate-pulse">
                    <div class="aspect-square bg-white bg-opacity-20 rounded-lg mb-4"></div>
                    <div class="h-4 bg-white bg-opacity-20 rounded w-3/4 mb-2"></div>
                    <div class="h-4 bg-white bg-opacity-20 rounded w-1/2"></div>
                </div>
            </div>
            <div class="text-center mt-6">
                <div class="inline-flex items-center space-x-2 text-white">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>正在生成对比图片...</span>
                </div>
            </div>
        `;
    }

    handleComparisonResults(results, prompt) {
        const resultContainer = document.getElementById('compareResults');
        if (!resultContainer) return;

        const leftResult = results[0];
        const rightResult = results[1];

        // 构建结果HTML
        let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">';

        // 左侧结果
        html += this.buildResultCard('left', this.leftModel, leftResult);

        // 右侧结果
        html += this.buildResultCard('right', this.rightModel, rightResult);

        html += '</div>';

        // VS标识
        html += `
            <div class="hidden md:flex absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2
                        bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-full w-16 h-16
                        items-center justify-center font-bold text-xl shadow-lg z-10">
                VS
            </div>
        `;

        resultContainer.innerHTML = html;

        // 如果两个都成功，显示评价按钮并保存到历史记录
        if (leftResult.status === 'fulfilled' && rightResult.status === 'fulfilled') {
            this.showEvaluationButtons();

            // 获取成功的URL - API返回的是 {success: true, urls: [...]}
            const leftUrl = leftResult.value.urls?.[0] || leftResult.value.url;
            const rightUrl = rightResult.value.urls?.[0] || rightResult.value.url;

            // 保存本次对比数据
            this.currentComparison = {
                leftModel: this.leftModel,
                rightModel: this.rightModel,
                leftModelName: this.apiService.getAllModels()[this.leftModel]?.name,
                rightModelName: this.apiService.getAllModels()[this.rightModel]?.name,
                prompt: prompt,
                ratio: this.currentRatio,
                leftUrl: leftUrl,
                rightUrl: rightUrl,
                leftGenerationTime: leftResult.value.generationTime,
                rightGenerationTime: rightResult.value.generationTime,
                referenceImages: this.referenceImages.map(img => img.dataUrl),
                timestamp: Date.now()
            };

            // 保存到主应用的历史记录（先不设置胜者）
            this.saveComparisonToHistory();
        }
    }

    saveComparisonToHistory() {
        if (!this.currentComparison) return;

        // 创建历史记录项
        const historyItem = {
            id: Date.now(),
            type: 'compare',
            prompt: this.currentComparison.prompt,
            ratio: this.currentComparison.ratio,
            timestamp: this.currentComparison.timestamp,
            urls: [this.currentComparison.leftUrl, this.currentComparison.rightUrl],
            comparison: {
                leftModel: this.currentComparison.leftModel,
                rightModel: this.currentComparison.rightModel,
                leftModelName: this.currentComparison.leftModelName,
                rightModelName: this.currentComparison.rightModelName,
                leftGenerationTime: this.currentComparison.leftGenerationTime,
                rightGenerationTime: this.currentComparison.rightGenerationTime,
                winner: null, // 初始没有胜者
                evaluation: null
            },
            referenceImages: this.currentComparison.referenceImages || []
        };

        // 添加到应用历史记录
        this.app.addHistory(historyItem);
    }

    buildResultCard(side, modelKey, result) {
        const model = window.aiImageAPI.getAllModels()[modelKey];
        const isLeft = side === 'left';
        const borderColor = isLeft ? 'border-blue-500' : 'border-green-500';

        if (result.status === 'rejected') {
            // 详细记录错误信息
            console.error(`[${modelKey}] 生成失败:`, result.reason);

            // 检查是否有详细错误信息
            let errorMessage = result.reason.message || '未知错误';
            let detailedError = '';

            if (result.reason.detailedError) {
                const detail = result.reason.detailedError;
                console.error(`[${modelKey}] 详细错误:`, detail);

                // 如果有原始响应，记录它
                if (detail.rawResponse) {
                    console.error(`[${modelKey}] 原始响应:`, detail.rawResponse);

                    // 尝试解析响应看是否是base64数据
                    try {
                        const responseData = JSON.parse(detail.rawResponse);
                        if (responseData.choices?.[0]?.message?.content) {
                            const content = responseData.choices[0].message.content;
                            console.log(`[${modelKey}] 响应内容长度:`, content.length);
                            console.log(`[${modelKey}] 内容前100字符:`, content.substring(0, 100));
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }

                detailedError = `<div class="mt-2 text-xs opacity-50 max-h-20 overflow-y-auto">
                    <p>状态码: ${detail.status || 'N/A'}</p>
                    <p>URL: ${detail.url || 'N/A'}</p>
                    ${detail.errorData ? '<p>查看浏览器控制台获取完整错误信息</p>' : ''}
                </div>`;
            }

            return `
                <div class="bg-white bg-opacity-10 rounded-xl p-6 border-2 ${borderColor} border-opacity-30">
                    <h3 class="text-white font-bold mb-4 flex items-center">
                        <span class="inline-block w-2 h-2 ${isLeft ? 'bg-blue-500' : 'bg-green-500'} rounded-full mr-2"></span>
                        ${model.name}
                    </h3>
                    <div class="aspect-square bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center">
                        <div class="text-center p-4">
                            <i class="fas fa-exclamation-triangle text-4xl text-red-400 mb-4"></i>
                            <p class="text-white opacity-70">${this.i18n ? this.i18n.t('compare.labels.generateFailed') : '生成失败'}</p>
                            <p class="text-sm text-red-400 mt-2 break-words">${errorMessage}</p>
                            ${detailedError}
                        </div>
                    </div>
                </div>
            `;
        }

        // 正确提取图片URL - API返回的是 {success: true, urls: [...]}
        const imageUrl = result.value.urls?.[0] || result.value.url;

        return `
            <div class="bg-white bg-opacity-10 rounded-xl p-6 border-2 ${borderColor} border-opacity-30
                        hover:border-opacity-50 transition-all">
                <h3 class="text-white font-bold mb-4 flex items-center justify-between">
                    <span class="flex items-center">
                        <span class="inline-block w-2 h-2 ${isLeft ? 'bg-blue-500' : 'bg-green-500'} rounded-full mr-2"></span>
                        ${model.name}
                    </span>
                    <span class="text-xs opacity-70">${this.formatGenerationTime(result.value.generationTime)}</span>
                </h3>
                <div class="aspect-square bg-gray-800 rounded-lg overflow-hidden mb-4 group relative">
                    <img src="${imageUrl}"
                         alt="${model.name} 生成结果"
                         class="w-full h-full object-contain cursor-pointer hover:scale-105 transition-transform"
                         onclick="window.app.viewImage(['${imageUrl}'], 0)">
                    <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30
                                transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                        <button onclick="window.app.viewImage(['${imageUrl}'], 0)"
                                class="bg-white bg-opacity-20 backdrop-blur-sm text-white px-4 py-2 rounded-lg
                                       hover:bg-opacity-30 transition-all mr-2">
                            <i class="fas fa-search-plus mr-2"></i>查看
                        </button>
                        <button onclick="window.app.downloadImage('${imageUrl}')"
                                class="bg-white bg-opacity-20 backdrop-blur-sm text-white px-4 py-2 rounded-lg
                                       hover:bg-opacity-30 transition-all">
                            <i class="fas fa-download mr-2"></i>下载
                        </button>
                    </div>
                </div>
                <div id="${side}ModelInfo" class="text-xs text-white opacity-70">
                    ${this.getModelStats(model)}
                </div>
            </div>
        `;
    }

    formatGenerationTime(time) {
        if (!time) return '';
        const seconds = Math.round(time / 1000);
        return `${seconds}秒`;
    }

    getModelStats(model) {
        const priceMatch = model.displayName.match(/\$([0-9.]+)\/张/);
        const price = priceMatch ? priceMatch[1] : '未知';

        const speedMatch = model.displayName.match(/(\d+s)出图/);
        const speed = speedMatch ? speedMatch[1] : '未知';

        const speedText = this.i18n ? this.i18n.t('compare.models.speed', { speed }) : `速度: ${speed}`;
        const priceText = this.i18n ? this.i18n.t('compare.models.price', { price }) : `价格: $${price}/张`;
        return `${speedText} | ${priceText}`;
    }

    showEvaluationButtons() {
        const evaluationArea = document.getElementById('evaluationArea');
        if (!evaluationArea) return;

        evaluationArea.classList.remove('hidden');

        // 重置按钮状态
        document.querySelectorAll('.evaluation-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
    }

    handleEvaluation(e) {
        const button = e.target.closest('.evaluation-btn');
        if (!button) return;

        const evaluation = button.dataset.evaluation;
        if (!evaluation || !this.currentComparison) return;

        // 更新按钮状态
        document.querySelectorAll('.evaluation-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        button.classList.add('selected');

        // 确定胜者
        let winner = null;
        let winnerModelName = null;
        if (evaluation === 'left') {
            winner = this.currentComparison.leftModel;
            winnerModelName = this.currentComparison.leftModelName;
        } else if (evaluation === 'right') {
            winner = this.currentComparison.rightModel;
            winnerModelName = this.currentComparison.rightModelName;
        }

        // 更新历史记录中的评价结果
        this.updateHistoryWithEvaluation(evaluation, winner, winnerModelName);

        // 显示反馈
        const messages = {
            'left': `您认为 ${this.currentComparison.leftModelName} 更好`,
            'right': `您认为 ${this.currentComparison.rightModelName} 更好`,
            'equal_good': '您认为两个模型一样好',
            'equal_bad': '您认为两个模型都不好'
        };

        this.app.showToast(messages[evaluation], 'success');
    }

    updateHistoryWithEvaluation(evaluation, winner, winnerModelName) {
        // 获取历史记录
        const history = this.app.history;

        // 找到最新的对比记录（应该是刚刚添加的）
        const latestComparison = history.find(item =>
            item.type === 'compare' &&
            item.timestamp === this.currentComparison.timestamp
        );

        if (latestComparison && latestComparison.comparison) {
            // 更新评价信息
            latestComparison.comparison.evaluation = evaluation;
            latestComparison.comparison.winner = winner;
            latestComparison.comparison.winnerModelName = winnerModelName;

            // 保存更新后的历史记录
            this.app.saveHistory();
        }
    }



    updateCompareButton(isProcessing) {
        const button = document.getElementById('compareBtn');
        if (!button) return;

        if (isProcessing) {
            button.disabled = true;
            button.innerHTML = `
                <i class="fas fa-spinner fa-spin mr-2"></i>
                <span>生成中...</span>
            `;
        } else {
            button.disabled = false;
            button.innerHTML = `
                <i class="fas fa-balance-scale mr-2"></i>
                <span>开始对比</span>
            `;
        }
    }
}
// 导出模块
window.ComparePage = ComparePage;
