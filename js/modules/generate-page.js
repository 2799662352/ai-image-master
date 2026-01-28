// 图片生成页面模块
class GeneratePage {
    constructor(app) {
        this.app = app;
        this.currentRatio = 'auto'; // 默认自适应
        this.currentResolution = '2K'; // 默认分辨率
        this.referenceImages = []; // 存储多张参考图片的base64数据
        this.maxReferenceImages = 8; // 默认最多8张，Flux模型支持1张
        this.isProcessingFiles = false; // 防止重复触发文件处理
        this.isFileSelectionActive = false; // 防止重复触发文件选择
        this.lastGeneratedUrls = []; // 保存最后生成的图片URL
        this.r2UploadListener = null; // R2 上传事件监听器
        this.stateRestored = false; // 标记状态是否已恢复

        // 上传配置
        this.uploadConfig = {
            maxConcurrency: 5, // 最大并发数
            retryAttempts: 3,  // 文件上传转换重试次数（技术性问题）
            timeout: 30000     // 超时时间
        };

        this.init();
    }

    init() {
        this.bindEvents();
        this.bindResultTabEvents();
        this.bindStateAutoSave();
    }

    bindEvents() {
        // 图片生成相关事件
        document.getElementById('generateBtn').addEventListener('click', () => this.generateImage());

        // 清空输入按钮事件
        const clearInputBtn = document.getElementById('clearInputBtn');
        if (clearInputBtn) {
            clearInputBtn.addEventListener('click', () => this.clearInput());
        }

        const ratioButtonsContainer = document.getElementById('ratioButtons');
        if (ratioButtonsContainer) {
            ratioButtonsContainer.addEventListener('click', (e) => {
                const button = e.target.closest('.ratio-btn');
                if (!button || button.hasAttribute('disabled')) {
                    return;
                }
                const ratio = button.dataset.ratio;
                if (ratio) {
                    this.selectRatio(ratio);
                }
            });
        }

        // 分辨率按钮事件
        const resolutionButtonsContainer = document.getElementById('resolutionButtons');
        if (resolutionButtonsContainer) {
            resolutionButtonsContainer.addEventListener('click', (e) => {
                const button = e.target.closest('.ratio-btn');
                if (!button || button.hasAttribute('disabled')) {
                    return;
                }
                const resolution = button.dataset.resolution;
                if (resolution) {
                    this.selectResolution(resolution);
                }
            });
        }

        // 参考图上传相关事件
        this.bindReferenceImageEvents();
    }

    // 触发文件选择 - 动态创建input避免缓存问题
    triggerFileSelection() {
        // 如果正在处理文件或者文件选择已激活，避免重复触发
        if (this.isProcessingFiles) {
            console.log(i18n.t('generate.messages.processingFile'));
            return;
        }

        if (this.isFileSelectionActive) {
            console.log(i18n.t('generate.messages.fileSelectionActive'));
            return;
        }

        // 设置文件选择激活标志位
        this.isFileSelectionActive = true;
        console.log('设置文件选择激活标志位');

        // 创建新的input元素
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';

        // 添加唯一标识
        const inputId = 'dynamic-input-' + Date.now() + '-' + Math.random();
        input.id = inputId;

        // 清理函数
        const cleanup = () => {
            this.isFileSelectionActive = false;
            console.log('重置文件选择激活标志位');
            if (input.parentNode) {
                input.parentNode.removeChild(input);
                console.log('已清理动态input:', inputId);
            }
        };

        // 绑定change事件
        input.addEventListener('change', (e) => {
            console.log('动态input change事件触发:', inputId);
            if (e.target.files.length > 0 && !this.isProcessingFiles) {
                const files = Array.from(e.target.files);
                this.handleMultipleReferenceImageUpload(files);
            }
            cleanup();
        });

        // 绑定cancel事件（用户取消选择文件时）
        input.addEventListener('cancel', () => {
            console.log('用户取消文件选择:', inputId);
            cleanup();
        });

        // 监听焦点丢失事件（兼容性处理）
        input.addEventListener('blur', () => {
            // 延迟一下检查，给change事件时间触发
            setTimeout(() => {
                if (this.isFileSelectionActive) {
                    console.log('检测到焦点丢失，可能用户取消了选择:', inputId);
                    cleanup();
                }
            }, 100);
        });

        // 添加到DOM并触发点击
        document.body.appendChild(input);
        console.log('创建动态input并触发点击:', inputId);
        input.click();
    }

    // 绑定参考图相关事件
    bindReferenceImageEvents() {
        const referenceImageArea = document.getElementById('referenceImageArea');
        const addMoreReferenceArea = document.getElementById('addMoreReferenceArea');

        // 检查必需的DOM元素是否存在
        if (!referenceImageArea) {
            console.error(i18n.t('generate.errors.pageElementNotFound'));
            return;
        }

        // 点击上传区域 - 处理初始上传和添加更多
        const handleUploadAreaClick = (e) => {
            // 阻止事件冒泡
            e.stopPropagation();

            // 检查是否点击了移除按钮
            if (e.target.closest('.remove-reference-btn')) {
                return;
            }

            // 检查是否点击了动态创建的添加更多按钮
            if (e.target.closest('[data-dynamic-add-button="true"]')) {
                console.log('点击了动态添加更多按钮，跳过主区域处理');
                return;
            }

            // 检查是否点击了已上传的图片容器（禁用图片点击，避免误操作）
            if (e.target.closest('.relative.bg-white.bg-opacity-10')) {
                console.log('点击了已上传的图片，已禁用点击上传功能');
                return;
            }

            console.log('点击上传区域');
            this.triggerFileSelection();
        };

        referenceImageArea.addEventListener('click', handleUploadAreaClick);

        // 添加粘贴事件监听器
        this.bindPasteEvents();

        // 添加更多参考图区域点击事件
        if (addMoreReferenceArea) {
            addMoreReferenceArea.addEventListener('click', (e) => {
                // 阻止事件冒泡
                e.stopPropagation();

                console.log('点击添加更多参考图区域');
                if (this.referenceImages.length < this.maxReferenceImages) {
                    this.triggerFileSelection();
                } else {
                    // 检查是否为Flux模型并显示友好提示
                    const currentModel = window.aiImageAPI?.getCurrentModel();
                    if (currentModel && currentModel.apiType === 'flux-kontext') {
                        this.app.showToast(i18n.t('generate.messages.fluxModelLimitInfo'), 'info', 4000);
                    } else {
                        this.app.showToast(i18n.t('generate.messages.reachedMaxImages', {max: this.maxReferenceImages}), 'warning');
                    }
                }
            });
        }

        // 完全禁用原始HTML input元素，避免任何事件冲突
        // 我们只使用动态创建的input元素
    }

    // 绑定粘贴事件
    bindPasteEvents() {
        // 粘贴事件由主应用程序统一处理和分发，这里只需要处理UI反馈

        // 为参考图区域添加视觉反馈
        const referenceImageArea = document.getElementById('referenceImageArea');
        if (referenceImageArea) {
            // 添加焦点状态，让用户知道可以粘贴
            referenceImageArea.setAttribute('tabindex', '0');
            referenceImageArea.setAttribute('role', 'button');
            referenceImageArea.setAttribute('aria-label', i18n.t('generate.labels.uploadPrompt'));

            // 键盘事件支持
            referenceImageArea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.triggerFileSelection();
                }
            });

            // 粘贴视觉反馈
            referenceImageArea.addEventListener('dragenter', (e) => {
                e.preventDefault();
                referenceImageArea.classList.add('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            referenceImageArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                referenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            referenceImageArea.addEventListener('dragover', (e) => {
                e.preventDefault();
            });

            referenceImageArea.addEventListener('drop', (e) => {
                e.preventDefault();
                referenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');

                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) {
                    this.handleMultipleReferenceImageUpload(files);
                }
            });
        }
    }

    // 处理粘贴事件
    async handlePasteEvent(e) {
        const clipboardItems = e.clipboardData?.items;
        if (!clipboardItems) {
            return;
        }

        console.log('检测到粘贴事件，剪贴板项目数量:', clipboardItems.length);

        const imageFiles = [];

        // 遍历剪贴板项目
        for (let i = 0; i < clipboardItems.length; i++) {
            const item = clipboardItems[i];
            console.log('剪贴板项目类型:', item.type);

            // 检查是否为图片类型
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    imageFiles.push(file);
                }
            }
        }

        if (imageFiles.length === 0) {
            // 如果没有图片，给用户提示
            this.app.showToast(i18n.t('generate.messages.noImageInClipboard'), 'warning');
            return;
        }

        // 检查是否超过数量限制
        if (this.referenceImages.length >= this.maxReferenceImages) {
            const currentModel = window.aiImageAPI?.getCurrentModel();
            if (currentModel && currentModel.apiType === 'flux-kontext') {
                this.app.showToast(i18n.t('generate.messages.fluxModelLimitInfo'), 'info', 4000);
            } else {
                this.app.showToast(i18n.t('generate.messages.reachedMaxImages', {max: this.maxReferenceImages}), 'warning');
            }
            return;
        }

        console.log('从剪贴板获取到图片数量:', imageFiles.length);

        // 阻止默认粘贴行为
        e.preventDefault();

        // 处理粘贴的图片
        try {
            await this.handleMultipleReferenceImageUpload(imageFiles);
            this.app.showToast(i18n.t('generate.messages.pastedImagesSuccess', {count: imageFiles.length}), 'success');
        } catch (error) {
            console.error('处理粘贴图片时出错:', error);
            this.app.showToast(i18n.t('generate.messages.pasteError'), 'error');
        }
    }

    // 增强版处理多张参考图上传
    async handleMultipleReferenceImageUpload(files) {
        // 动态调整最大图片数量：Flux模型仅支持1张，其他模型6张
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }
        const uploadId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        console.log(`🔄 开始图片上传任务: ${uploadId}, 文件数量: ${files.length}`);

        // 更强的防重复检查
        if (this.isProcessingFiles) {
            console.log(`⏭️ ${i18n.t('generate.messages.skipDuplicateUpload')}: ${uploadId}`);
            return;
        }

        // 设置处理锁
        this.isProcessingFiles = true;
        this.currentUploadId = uploadId;

        try {
            const startTime = Date.now();

            // 预处理：批量验证所有文件
            const validFiles = [];
            for (const file of files) {
                try {
                    this.validateImageFile(file);

                    // 检查重复文件
                    const isDuplicate = this.referenceImages.some(img =>
                        img.fileName === file.name &&
                        Math.abs(img.fileSize - file.size) < 1024
                    );

                    if (isDuplicate) {
                        this.app.showToast(i18n.t('generate.messages.fileDuplicate', {filename: file.name}), 'warning');
                        continue;
                    }

                    // 检查数量限制
                    if (this.referenceImages.length + validFiles.length >= this.maxReferenceImages) {
                        if (validFiles.length === 0) {
                            const currentModel = window.aiImageAPI?.getCurrentModel();
                            if (currentModel && currentModel.apiType === 'flux-kontext') {
                                throw new Error(i18n.t('generate.messages.fluxModelLimitInfo'));
                            } else {
                                throw new Error(i18n.t('generate.messages.reachedMaxImages', {max: this.maxReferenceImages}));
                            }
                        }

                        const currentModel = window.aiImageAPI?.getCurrentModel();
                        if (currentModel && currentModel.apiType === 'flux-kontext') {
                            this.app.showToast(i18n.t('generate.messages.fluxModelLimitInfo'), 'info', 4000);
                        } else {
                            this.app.showToast(i18n.t('generate.messages.uploadLimitReached', {max: this.maxReferenceImages}), 'warning');
                        }
                        break;
                    }

                    validFiles.push(file);

                } catch (error) {
                    this.app.showToast(error.message, 'error');
                }
            }

            if (validFiles.length === 0) {
                return;
            }

            // 显示上传进度
            const progressToast = this.showProgressToast(`${i18n.t('generate.messages.processingFile')} ${validFiles.length} 张图片...`);

            // 智能并发处理多个文件
            const concurrencyLimit = Math.min(this.uploadConfig.maxConcurrency, validFiles.length);
            console.log(`🚀 并发处理配置: ${concurrencyLimit}个文件同时处理`);
            const results = [];

            for (let i = 0; i < validFiles.length; i += concurrencyLimit) {
                const batch = validFiles.slice(i, i + concurrencyLimit);
                const batchPromises = batch.map(async (file, index) => {
                    try {
                        // 检查是否被取消
                        if (this.currentUploadId !== uploadId) {
                            throw new Error(i18n.t('generate.messages.uploadCancelled'));
                        }

                        // 注意：不在上传时压缩，而是在点击生成时才压缩
                        // 这样用户可以快速预览和调整图片，避免不必要的压缩
                        const base64 = await this.fileToBase64Enhanced(file);
                        const dimensions = await this.getImageDimensions(file);

                        return {
                            base64,
                            originalFile: file,  // 保存原始File对象，供生成时压缩使用
                            fileName: file.name,
                            fileSize: file.size,
                            mimeType: (file.type || 'image/jpeg').toLowerCase(),
                            id: Date.now() + Math.random(),
                            width: dimensions.width,
                            height: dimensions.height,
                            uploadTime: new Date().toISOString(),
                            needsCompression: file.size > 2 * 1024 * 1024  // 标记是否需要压缩
                        };
                    } catch (error) {
                        console.error(`❌ 处理文件 ${file.name} 失败:`, error);
                        this.app.showToast(`${file.name} 处理失败: ${error.message}`, 'error');
                        return null;
                    }
                });

                const batchResults = await Promise.allSettled(batchPromises);
                const successResults = batchResults
                    .filter(result => result.status === 'fulfilled' && result.value !== null)
                    .map(result => result.value);

                results.push(...successResults);

                // 更新进度
                const processed = Math.min(i + concurrencyLimit, validFiles.length);
                progressToast.update(`已处理 ${processed} / ${validFiles.length} 张图片 (并发:${Math.min(concurrencyLimit, validFiles.length - i)})`);
            }

            // 添加成功处理的图片
            this.referenceImages.push(...results);

            // 更新UI显示
            this.updateReferenceImagesPreview();

            // 关闭进度提示
            progressToast.close();

            const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const successCount = results.length;

            if (successCount > 0) {
                const message = successCount === 1 ?
                    i18n.t('generate.messages.uploadSuccess', {time: processTime}) :
                    i18n.t('generate.messages.uploadSuccessMultiple', {count: successCount, time: processTime});
                this.app.showToast(message, 'success');
            }

            console.log(`✅ 上传任务完成: ${uploadId}, 成功: ${successCount}/${validFiles.length}, 耗时: ${processTime}秒`);

        } catch (error) {
            console.error(`❌ 上传任务失败: ${uploadId}`, error);
            this.app.showToast(i18n.t('generate.messages.uploadFailed', {error: error.message}), 'error');
        } finally {
            // 确保清理状态
            this.isProcessingFiles = false;
            this.currentUploadId = null;
        }
    }

    // 准备参考图片用于生成（执行压缩如果需要）
    async prepareReferenceImagesForGeneration() {
        if (this.referenceImages.length === 0) {
            return [];
        }

        const processedImages = [];
        const imagesToCompress = this.referenceImages.filter(img => img.needsCompression);

        console.log(`🖼️ 准备参考图片用于生成...`);
        console.log(`📊 需要压缩的图片: ${imagesToCompress.length}/${this.referenceImages.length}`);

        // 如果有需要压缩的图片，显示统一提示
        let toastId = null;
        let toastRemoved = false;
        const startTime = Date.now();
        const MAX_TOAST_DISPLAY_TIME = 3000; // 最多显示3秒

        if (imagesToCompress.length > 0) {
            toastId = this.showProgressToast(
                i18n.t('generate.messages.compressingImages', {count: imagesToCompress.length}) + '<br>' +
                `<span class="text-sm opacity-80">${i18n.t('generate.messages.compressionInfo')}</span>`
            );

            // 启动定时器：3秒后自动移除Toast（不管压缩是否完成）
            setTimeout(() => {
                if (toastId && !toastRemoved) {
                    toastId.close();  // 使用close()方法移除Toast
                    console.log('⏰ Toast显示已达3秒，自动移除');
                    toastRemoved = true;
                }
            }, MAX_TOAST_DISPLAY_TIME);
        }

        try {
            for (const imageData of this.referenceImages) {
                try {
                    if (imageData.needsCompression && imageData.originalFile) {
                        // 需要压缩：从原始文件压缩后生成新的base64
                        console.log(`🗜️ 压缩参考图: ${imageData.fileName}`);
                        const compressedFile = await this.compressImageIfNeeded(imageData.originalFile);
                        const compressedBase64 = await this.fileToBase64Enhanced(compressedFile);

                        processedImages.push({
                            ...imageData,
                            base64: compressedBase64,
                            fileSize: compressedFile.size
                        });
                    } else {
                        // 不需要压缩：直接使用现有base64
                        processedImages.push(imageData);
                    }
                } catch (error) {
                    console.error(`❌ 处理参考图失败: ${imageData.fileName}`, error);
                    // 压缩失败时使用原始base64
                    processedImages.push(imageData);
                }
            }

            // 移除蓝色Toast（如果还没被定时器移除）
            if (toastId && !toastRemoved) {
                toastId.close();
                toastRemoved = true;
            }

            // 压缩完成后显示成功提示
            if (imagesToCompress.length > 0) {
                const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ 压缩完成！共压缩 ${imagesToCompress.length} 张图片，耗时 ${totalTime} 秒`);

                this.app.showToast(
                    i18n.t('generate.messages.compressionComplete', {count: imagesToCompress.length}),
                    'success',
                    2000
                );
            }

        } finally {
            // 确保清理（防御性编程）
            if (toastId && !toastRemoved) {
                try {
                    toastId.close();
                } catch (e) {
                    console.warn('Toast清理失败:', e);
                }
            }
        }

        return processedImages;
    }

    // 智能图片压缩 - 仅当文件大于2MB时压缩
    async compressImageIfNeeded(file) {
        const MAX_SIZE_MB = 2;
        const fileSizeMB = file.size / (1024 * 1024);

        // 如果文件小于2MB，直接返回原文件
        if (fileSizeMB <= MAX_SIZE_MB) {
            console.log(this.i18n ? this.i18n.t('generate.messages.noCompressionNeeded', { filename: file.name, size: fileSizeMB.toFixed(2) }) : `文件 ${file.name} 大小为 ${fileSizeMB.toFixed(2)}MB，无需压缩`);
            return file;
        }

        // 检查压缩库是否加载
        if (typeof imageCompression === 'undefined') {
            console.warn('图片压缩库未加载，跳过压缩');
            return file;
        }

        try {
            const options = {
                maxSizeMB: 2,              // 压缩到最大2MB
                maxWidthOrHeight: 2048,    // 最大边长2048px，保证高清质量
                useWebWorker: true,        // 使用Web Worker避免阻塞UI
                fileType: file.type,       // 保持原有格式
                initialQuality: 0.9,       // 初始质量90%
                alwaysKeepResolution: false // 允许调整分辨率
            };

            console.log(this.i18n ? this.i18n.t('generate.messages.startCompression', { filename: file.name, size: fileSizeMB.toFixed(2) }) : `⏩ 开始压缩文件: ${file.name}, 原大小: ${fileSizeMB.toFixed(2)}MB`);
            const startTime = Date.now();

            const compressedFile = await imageCompression(file, options);

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const compressedSizeMB = compressedFile.size / (1024 * 1024);
            const compressionRatio = ((1 - compressedFile.size / file.size) * 100).toFixed(1);

            console.log(
                `✅ 压缩完成: ${file.name}\n` +
                `   原大小: ${fileSizeMB.toFixed(2)}MB\n` +
                `   压缩后: ${compressedSizeMB.toFixed(2)}MB\n` +
                `   压缩率: ${compressionRatio}%\n` +
                `   ⏱️ 耗时: ${duration}秒`
            );

            return compressedFile;

        } catch (error) {
            console.error('图片压缩失败:', error);

            // 压缩失败时使用原文件
            this.app.showToast(
                i18n.t('generate.messages.compressionFailed', {error: error.message}),
                'warning',
                3000
            );

            return file;
        }
    }

    // 增强版文件转base64 - 添加重试机制和验证
    async fileToBase64Enhanced(file) {
        const maxRetries = this.uploadConfig.retryAttempts;
        const retryDelay = 1000; // 1秒延迟

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();

                    reader.onload = () => {
                        try {
                            const result = reader.result;
                            if (!result || typeof result !== 'string') {
                                throw new Error(i18n.t('generate.errors.invalidFileReaderResult'));
                            }

                            const base64 = result.split(',')[1];
                            if (!base64 || base64.length < 100) {
                                throw new Error(i18n.t('generate.messages.invalidBase64'));
                            }

                            // 验证Base64格式
                            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
                                throw new Error(i18n.t('generate.messages.base64ValidationFailed'));
                            }

                            resolve(base64);
                        } catch (error) {
                            reject(error);
                        }
                    };

                    reader.onerror = () => {
                        reject(new Error(i18n.t('generate.errors.readerErrorMessage', {error: reader.error?.message || '未知错误'})));
                    };

                    reader.onabort = () => {
                        reject(new Error(i18n.t('generate.messages.fileReadAborted')));
                    };

                    // 设置超时
                    setTimeout(() => {
                        reader.abort();
                        reject(new Error(i18n.t('generate.messages.fileReadTimeout')));
                    }, this.uploadConfig.timeout); // 可配置超时

                    reader.readAsDataURL(file);
                });

                // 验证转换后的数据完整性
                await this.validateBase64Image(base64, file.name, (file.type || 'image/jpeg').toLowerCase());

                console.log(`✅ 文件 ${file.name} Base64转换成功 (第${attempt}次尝试)`);
                return base64;

            } catch (error) {
                console.warn(`⚠️ 文件 ${file.name} Base64转换失败 (第${attempt}/${maxRetries}次): ${error.message}`);

                if (attempt === maxRetries) {
                    throw new Error(i18n.t('generate.messages.conversionFailed', {retries: maxRetries, error: error.message}));
                }

                // 延迟后重试
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }
    }

    // 兼容性：保留原有函数名
    fileToBase64(file) {
        return this.fileToBase64Enhanced(file);
    }

    // 新增：Base64图片数据验证
    async validateBase64Image(base64, fileName, mimeType = 'image/jpeg') {
        try {
            // 创建测试图片对象验证数据有效性
            const testImg = new Image();
            let dataUrl = base64;
            if (!dataUrl.startsWith('data:image/')) {
                dataUrl = `data:${mimeType};base64,${base64}`;
            }

            return new Promise((resolve, reject) => {
                testImg.onload = () => {
                    if (testImg.width > 0 && testImg.height > 0) {
                        console.log(`✅ ${fileName} Base64数据验证通过: ${testImg.width}x${testImg.height}`);
                        resolve(true);
                    } else {
                        reject(new Error(i18n.t('generate.errors.imageSizeInvalid')));
                    }
                };

                testImg.onerror = () => {
                    reject(new Error(i18n.t('generate.messages.imageDecodeFailed')));
                };

                // 设置验证超时
                setTimeout(() => {
                    reject(new Error(i18n.t('generate.messages.imageValidationTimeout')));
                }, 10000);

                testImg.src = dataUrl;
            });

        } catch (error) {
            throw new Error(i18n.t('generate.messages.imageValidationFailed', {error: error.message}));
        }
    }

    // 增强版文件验证
    validateImageFile(file) {
        // 基础检查
        if (!file.type.startsWith('image/')) {
            throw new Error(i18n.t('generate.messages.fileNotImage', {filename: file.name}));
        }

        // 文件大小检查
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
            const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
            throw new Error(i18n.t('generate.messages.fileTooLarge', {filename: file.name, size: fileSizeMB}));
        }

        // 支持的格式列表
        const supportedTypes = [
            'image/jpeg', 'image/jpg', 'image/png',
            'image/webp', 'image/bmp'
        ];

        if (!supportedTypes.includes(file.type.toLowerCase())) {
            throw new Error(i18n.t('generate.messages.unsupportedFormat', {filename: file.name}));
        }

        // 文件名检查
        if (file.name.length > 100) {
            console.warn(this.i18n ? this.i18n.t('generate.messages.filenameTooLong', { filename: file.name }) : `文件名过长，将被截断: ${file.name}`);
        }

        // 最小尺寸检查
        if (file.size < 1024) { // 小于1KB
            throw new Error(i18n.t('generate.messages.fileTooSmall', {filename: file.name}));
        }

        console.log(`✅ 文件验证通过: ${file.name} (${file.type}, ${(file.size/1024).toFixed(1)}KB)`);
        return true;
    }

    // 获取图片尺寸信息
    async getImageDimensions(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                console.log('📐 获取图片尺寸:', file.name, img.width + 'x' + img.height);
                resolve({
                    width: img.width,
                    height: img.height
                });
            };
            img.onerror = () => {
                console.warn('⚠️ 无法获取图片尺寸，使用默认值:', file.name);
                resolve({
                    width: 1024,
                    height: 1024
                });
            };
            img.src = URL.createObjectURL(file);
        });
    }

    // 更新参考图预览显示
    updateReferenceImagesPreview() {
        // 动态调整最大图片数量：Flux模型仅支持1张，其他模型6张
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }

        console.log('updateReferenceImagesPreview 开始执行，参考图数量:', this.referenceImages.length, '最大限制:', this.maxReferenceImages);

        const uploadPrompt = document.getElementById('referenceUploadPrompt');
        const preview = document.getElementById('referenceImagesPreview');
        const imagesList = document.getElementById('referenceImagesList');
        const addMoreArea = document.getElementById('addMoreReferenceArea');
        const countText = document.getElementById('referenceCountText');

        // 调试：检查DOM元素是否找到
        console.log('DOM元素查找结果:', {
            uploadPrompt: !!uploadPrompt,
            preview: !!preview,
            imagesList: !!imagesList,
            addMoreArea: !!addMoreArea,
            countText: !!countText
        });

        if (this.referenceImages.length === 0) {
            if (uploadPrompt) uploadPrompt.classList.remove('hidden');
            if (preview) preview.classList.add('hidden');
            console.log('参考图为空，显示上传提示');
            return;
        }

        if (uploadPrompt) uploadPrompt.classList.add('hidden');
        if (preview) preview.classList.remove('hidden');
        console.log('开始显示参考图预览');

        // 清空现有预览
        if (imagesList) {
            imagesList.innerHTML = '';
            console.log('已清空现有预览');
        }

        // 生成每张图片的预览
        console.log('开始生成图片预览，参考图列表:', this.referenceImages);
        this.referenceImages.forEach((imageData, index) => {
            const imageItem = document.createElement('div');
            imageItem.className = 'relative bg-white bg-opacity-10 rounded-lg p-2 group';
            const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase();
            imageItem.innerHTML = `
                <div class="relative">
                    <img src="data:${mimeType};base64,${imageData.base64}"
                         class="w-full aspect-square object-cover rounded-lg"
                         alt="${i18n.t('generate.labels.referenceImageLabel', {index: index + 1})}">

                    ${imageData.needsCompression ? `
                        <div class="absolute top-1 left-1 bg-orange-500 bg-opacity-90 text-white text-xs px-2 py-0.5 rounded flex items-center space-x-1" title="${i18n.t('generate.labels.needsCompressionTooltip')}">
                            <i class="fas fa-compress-alt"></i>
                            <span>${i18n.t('generate.labels.fileSizeFormat', {size: (imageData.fileSize / (1024 * 1024)).toFixed(1)})} ${i18n.t('generate.labels.needsCompressionLabel')}</span>
                        </div>
                    ` : ''}

                    <button class="remove-reference-btn absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100"
                            title="移除此参考图"
                            aria-label="${i18n.t('generate.labels.removeButtonLabel', {index: index + 1})}"
                            data-image-id="${imageData.id}">
                        <i class="fas fa-times text-xs"></i>
                    </button>
                </div>
            `;
            if (imagesList) {
                imagesList.appendChild(imageItem);
                console.log(`已添加第${index + 1}张图片预览到DOM`);
            }
        });

        // 添加"添加更多"按钮（如果还没达到上限）
        if (this.referenceImages.length < this.maxReferenceImages && imagesList) {
            const addButton = document.createElement('div');
            addButton.className = 'border-2 border-dashed border-white border-opacity-30 hover:border-opacity-50 rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center aspect-square group';
            addButton.setAttribute('data-dynamic-add-button', 'true'); // 添加唯一标识
            addButton.innerHTML = `
                <div class="text-center">
                    <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
                    <p class="text-white opacity-50 group-hover:opacity-70 text-xs">${i18n.t('generate.labels.addMoreReferences')}</p>
                    <p class="text-white opacity-30 group-hover:opacity-50 text-xs">${i18n.t('generate.labels.referenceImageCount', {current: this.referenceImages.length, max: this.maxReferenceImages})}</p>
                </div>
            `;
            addButton.addEventListener('click', (e) => {
                // 阻止事件冒泡，避免触发父容器的点击事件
                e.stopPropagation();
                console.log('点击动态添加更多按钮');
                this.triggerFileSelection();
            });
            imagesList.appendChild(addButton);
        }

        // 绑定移除按钮事件
        if (imagesList) {
            const removeButtons = imagesList.querySelectorAll('.remove-reference-btn');
            console.log(`找到${removeButtons.length}个移除按钮，开始绑定事件`);

            removeButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const imageId = parseFloat(e.target.closest('.remove-reference-btn').dataset.imageId);
                    this.removeReferenceImage(imageId);
                });
            });
        }

        // 更新计数显示 - 已集成到加号按钮内，无需单独显示
        // if (countText) {
        //     const countTextContent = `(${this.referenceImages.length}/${this.maxReferenceImages})`;
        //     countText.textContent = countTextContent;
        //     console.log('已更新计数显示:', countTextContent);
        // }

        // 控制添加更多区域的显示 - 已集成到grid布局中，无需单独显示
        // if (addMoreArea) {
        //     if (this.referenceImages.length >= this.maxReferenceImages) {
        //         addMoreArea.style.display = 'none';
        //         console.log('已达到最大数量，隐藏添加更多区域');
        //     } else {
        //         addMoreArea.style.display = 'block';
        //         console.log('显示添加更多区域');
        //     }
        // }

        // 如果当前是Gemini智能尺寸模式，更新智能尺寸显示
        this.updateIntelligentResizeIfNeeded();

        // 保存状态
        this.saveCurrentState();

        console.log('updateReferenceImagesPreview 执行完成');
    }

    // 如果需要，更新智能尺寸显示
    // 更新参考图片数量限制显示
    updateReferenceImageLimitDisplay() {
        const limitElement = document.getElementById('referenceImageLimit');
        if (!limitElement) return;

        const currentModel = window.aiImageAPI?.getCurrentModel();
        const maxImages = (currentModel && currentModel.apiType === 'flux-kontext') ? 1 : 3;

        limitElement.textContent = i18n.t('generate.labels.supportedFormats', {max: maxImages});

        // 如果是Flux模型，添加特别提示
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            limitElement.innerHTML = `<span class="text-orange-300">${i18n.t('generate.labels.fluxModelInfo')}</span>`;
        }
    }

    updateIntelligentResizeIfNeeded() {
        // 检查当前模型是否为gemini智能尺寸模式
        const currentModel = window.aiImageAPI.getCurrentModel();
        const capabilities = currentModel.capabilities || {};

        console.log('🔍 检查是否需要更新智能尺寸 - 模型:', currentModel.name, '智能尺寸:', capabilities.intelligentResize);

        if (capabilities.intelligentResize && this.app) {
            console.log('✅ 需要更新智能尺寸，开始执行...');
            // 延迟一下确保DOM已更新
            setTimeout(() => {
                this.app.updateIntelligentResizeUI();
            }, 100);
        } else {
            console.log('❌ 不需要更新智能尺寸 - intelligentResize:', capabilities.intelligentResize, 'app:', !!this.app);
        }
    }

    // 移除指定的参考图
    removeReferenceImage(imageId) {
        const index = this.referenceImages.findIndex(img => img.id === imageId);
        if (index > -1) {
            const removedImage = this.referenceImages.splice(index, 1)[0];
            this.updateReferenceImagesPreview();
            this.app.showToast(i18n.t('generate.messages.referenceImageRemoved', {filename: removedImage.fileName}), 'info');
        }
    }

    // 清空所有参考图
    clearAllReferenceImages() {
        this.referenceImages = [];
        this.updateReferenceImagesPreview();
    }

    // 清空输入
    clearInput() {
        const promptInput = document.getElementById('promptInput');
        if (promptInput) {
            promptInput.value = '';
            promptInput.focus(); // 清空后聚焦到输入框

            // 显示成功提示
            if (this.app && this.app.showToast) {
                this.app.showToast(i18n.t('generate.messages.inputCleared'), 'success');
            }
        }
    }

    // 设置 R2 上传监听器
    setupR2UploadListener() {
        // 移除旧的监听器
        if (this.r2UploadListener) {
            window.removeEventListener('r2UploadComplete', this.r2UploadListener);
        }

        // 创建新的监听器
        this.r2UploadListener = (event) => {
            const { originalUrls, r2Urls, modelConfig } = event.detail;

            // 更新显示的图片的上传状态
            this.updateImageUploadStatus(originalUrls, r2Urls);
        };

        // 添加监听器
        window.addEventListener('r2UploadComplete', this.r2UploadListener);
    }

    // 更新图片的上传状态指示器
    updateImageUploadStatus(originalUrls, r2Urls) {
        // 查找所有结果图片，使用 imageResult 作为容器 ID
        const resultImages = document.querySelectorAll('#imageResult .result-item img');

        resultImages.forEach(img => {
            const imgSrc = img.src;

            // 检查这个图片是否在上传列表中
            const index = originalUrls.findIndex(url => {
                // 处理 base64 和普通 URL 的匹配
                if (imgSrc.startsWith('data:') && url.startsWith('data:')) {
                    return imgSrc === url;
                } else if (!imgSrc.startsWith('data:') && !url.startsWith('data:')) {
                    return imgSrc === url;
                }
                return false;
            });

            if (index !== -1 && r2Urls[index]) {
                // 找到对应的 result-item 容器
                const resultItem = img.closest('.result-item');
                if (resultItem) {
                    // 移除上传中状态，添加上传完成状态
                    const uploadIndicator = resultItem.querySelector('.upload-indicator');
                    if (uploadIndicator) {
                        uploadIndicator.classList.remove('uploading');
                        uploadIndicator.classList.add('uploaded');
                        uploadIndicator.innerHTML = '<i class="fas fa-cloud-check"></i>';
                        uploadIndicator.title = i18n.t('generate.labels.uploadCompleteTooltip');
                    }

                    // 更新图片的 data-r2-url 属性
                    img.dataset.r2Url = r2Urls[index];
                }
            }
        });
    }

    // 选择图片比例
    selectRatio(ratio) {
        // 只选择宽高比按钮容器内的按钮，避免影响分辨率按钮
        const ratioButtons = document.querySelectorAll('#ratioButtons .ratio-btn');
        ratioButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.ratio === ratio) {
                btn.classList.add('active');
            }
        });
        this.currentRatio = ratio;

        // 更新最终分辨率显示
        this.updateFinalResolutionDisplay();

        // 保存状态
        this.saveCurrentState();
    }

    // 选择图片分辨率
    selectResolution(resolution) {
        const resolutionButtons = document.querySelectorAll('#resolutionButtons .ratio-btn');
        resolutionButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.resolution === resolution) {
                btn.classList.add('active');
            }
        });
        this.currentResolution = resolution;

        // 保存到 localStorage
        try {
            localStorage.setItem('gemini_resolution', resolution);
        } catch (error) {
            console.error('保存分辨率设置失败:', error);
        }

        // 更新最终分辨率显示
        this.updateFinalResolutionDisplay();

        // 保存状态
        this.saveCurrentState();
    }

    // 更新最终分辨率显示
    updateFinalResolutionDisplay() {
        const currentModel = window.aiImageAPI.getCurrentModel();

        // 检查是否支持分辨率显示
        if (!currentModel.capabilities?.resolutionControl || !currentModel.resolutionMap) {
            return;
        }

        const displayElement = document.getElementById('finalResolutionDisplay');
        const valueElement = document.getElementById('finalResolutionValue');

        if (!displayElement || !valueElement) return;

        // 获取当前选择的宽高比和分辨率
        const ratio = this.currentRatio;
        const resolution = this.currentResolution;

        // 从映射表获取实际分辨率
        const actualResolution = currentModel.resolutionMap[ratio]?.[resolution];

        if (actualResolution) {
            valueElement.textContent = actualResolution;
            displayElement.classList.remove('hidden');
        } else {
            displayElement.classList.add('hidden');
        }
    }

    // 生成图片
    async generateImage() {
        const prompt = document.getElementById('promptInput').value.trim();
        if (!prompt) {
            this.app.showToast(i18n.t('generate.messages.promptRequired'), 'error');
            return;
        }

        if (!window.aiImageAPI.apiKey) {
            this.app.showToast(i18n.t('generate.messages.apiKeyNotSet'), 'error');
            this.app.openSettings();
            return;
        }

        // 获取数量参数
        const generateCountSelect = document.getElementById('generateCount');
        const generateCount = parseInt(generateCountSelect.value) || 1;

        const generateBtn = document.getElementById('generateBtn');
        const imageResult = document.getElementById('imageResult');
        const loadingProgress = document.getElementById('loadingProgress');
        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');

        // 检查必要元素是否存在
        if (!generateBtn) {
            console.error('生成按钮不存在');
            this.app.showToast(i18n.t('generate.messages.pageLoadIncomplete'), 'error');
            return;
        }

        // 禁用按钮，显示进度
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${i18n.t('generate.buttons.generating')}`;

        if (loadingProgress) {
            loadingProgress.classList.remove('hidden');
        }

        // 模拟进度条
        const progressInterval = this.simulateProgress(progressBar, progressText);

        try {
            let result;

            // 检查当前模型是否支持分辨率控制
            const currentModel = window.aiImageAPI.getCurrentModel();
            const supportsResolution = currentModel.capabilities?.resolutionControl;
            const resolution = supportsResolution ? this.currentResolution : null;

            // 根据分辨率显示预计生成时间提示
            if (resolution && supportsResolution) {
                let timeEstimate = '';
                if (resolution === '4K') {
                    timeEstimate = i18n.t('generate.messages.estimatedTime4K');
                } else if (resolution === '2K') {
                    timeEstimate = i18n.t('generate.messages.estimatedTime2K');
                } else if (resolution === '1K') {
                    timeEstimate = i18n.t('generate.messages.estimatedTime1K');
                }

                if (timeEstimate) {
                    console.log(`[生成提示] ${resolution} 分辨率图片生成，${timeEstimate}`);
                    // 显示一个简短的提示（不使用 toast，避免打断用户）
                    if (progressText) {
                        progressText.textContent = i18n.t('generate.messages.generatingWithEstimate', {estimate: timeEstimate});
                    }
                }
            }

            // 根据是否有参考图选择不同的生成方法
            if (this.referenceImages.length > 0) {
                // 在生成前压缩大图片（>2MB）
                const preparedImages = await this.prepareReferenceImagesForGeneration();
                result = await window.aiImageAPI.generateImageWithReference(prompt, preparedImages, this.currentRatio, generateCount, resolution);
            } else {
                result = await window.aiImageAPI.generateImage(prompt, this.currentRatio, generateCount, resolution);
            }

            if (result.success && result.urls.length > 0) {
                this.displayGeneratedImages(result.urls, imageResult);

                // 添加到历史记录时标记是否使用了参考图
                const historyType = this.referenceImages.length > 0 ? 'generate-with-reference' : 'generate';
                this.app.addToHistory(historyType, prompt, result.urls, this.currentRatio, this.referenceImages);

                const successMessage = this.referenceImages.length > 0 ?
                    i18n.t('generate.messages.generateWithReferenceSuccess', {count: this.referenceImages.length}) :
                    i18n.t('generate.messages.generateSuccess');
                this.app.showToast(successMessage, 'success');
            } else {
                throw new Error(i18n.t('generate.messages.invalidResult'));
            }
        } catch (error) {
            // 使用详细错误显示，而不是简单的toast
            this.app.showDetailedError(error, i18n.t('generate.messages.generateError'));

            // 尝试显示错误结果，如果容器存在
            if (imageResult) {
                this.showErrorResult(imageResult, error);
            } else {
                // 如果没有容器，至少显示一个提示
                console.error('无法显示错误结果，imageResult 元素不存在');
            }
        } finally {
            // 清理进度定时器
            if (progressInterval) {
                clearInterval(progressInterval);
            }

            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.innerHTML = `<i class="fas fa-magic mr-2"></i>${i18n.t('generate.buttons.generateButton')}`;
            }

            if (loadingProgress) {
                loadingProgress.classList.add('hidden');
            }

            if (progressBar) {
                progressBar.style.width = '0%';
            }

            if (progressText) {
                progressText.textContent = i18n.t('generate.messages.generatingProgress');
            }
        }
    }

    // 模拟进度条
    simulateProgress(progressBar, progressText) {
        let progress = 0;
        let stage = 0;
        const stages = [
            i18n.t('generate.messages.connectingServer'),
            i18n.t('generate.messages.analyzingPrompt'),
            i18n.t('generate.messages.startGenerating'),
            i18n.t('generate.messages.creatingArt'),
            i18n.t('generate.messages.generatingInProgress'),
            i18n.t('generate.messages.optimizingQuality'),
            i18n.t('generate.messages.almostComplete')
        ];

        const interval = setInterval(() => {
            // 前30秒快速进度到30%
            if (progress < 30) {
                progress += Math.random() * 8 + 2;
            }
            // 30秒到2分钟缓慢进度到70%
            else if (progress < 70) {
                progress += Math.random() * 2 + 0.5;
            }
            // 2分钟后很慢进度到90%
            else if (progress < 90) {
                progress += Math.random() * 0.5 + 0.1;
            }

            if (progress > 95) progress = 95; // 不要到100%，等实际完成

            progressBar.style.width = `${progress}%`;

            // 根据进度更新阶段提示
            const newStage = Math.floor((progress / 100) * stages.length);
            if (newStage !== stage && newStage < stages.length) {
                stage = newStage;
                progressText.textContent = stages[stage];
            }
        }, 1000); // 1秒更新一次，给用户更稳定的感觉

        // 清理定时器（在请求完成时会被覆盖）
        setTimeout(() => clearInterval(interval), 300000); // 5分钟后自动清理

        return interval; // 返回定时器ID，便于外部清理
    }

    // 显示生成的图片
    displayGeneratedImages(urls, container) {
        // 保存生成的URL
        this.lastGeneratedUrls = urls;

        // 监听 R2 上传完成事件
        this.setupR2UploadListener();

        // 显示Tab导航
        const resultTabs = document.getElementById('resultTabs');
        if (resultTabs) {
            resultTabs.classList.remove('hidden');
        }

        // 确保默认显示结果Tab
        this.showResultTab('result');

        container.innerHTML = '';
        // 不要修改容器的 ID，保持原来的 imageResult

        if (urls.length === 1) {
            // 单张图片直接显示
            const imageContainer = document.createElement('div');
            imageContainer.className = 'relative group result-item';  // 添加 result-item 类
            imageContainer.style.zIndex = '1';

            const img = document.createElement('img');
            img.src = urls[0];
            img.className = 'w-full h-auto rounded-lg shadow-lg';
            img.alt = '生成的图片';

            // 添加上传状态指示器
            const uploadIndicator = document.createElement('div');
            uploadIndicator.className = 'upload-indicator uploading absolute top-2 right-2 bg-black bg-opacity-50 rounded-full p-2 text-white';
            uploadIndicator.innerHTML = '<i class="fas fa-cloud-upload-alt fa-spin"></i>';
            uploadIndicator.title = i18n.t('generate.labels.uploadIndicatorTooltip');

            const overlay = document.createElement('div');
            overlay.className = 'absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2';

            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all';
            downloadBtn.innerHTML = '<i class="fas fa-download"></i>';
            downloadBtn.onclick = () => this.app.downloadImage(urls[0]);

            const viewBtn = document.createElement('button');
            viewBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all';
            viewBtn.innerHTML = '<i class="fas fa-expand"></i>';
            viewBtn.onclick = () => this.app.viewImage(urls, 0);

            overlay.appendChild(downloadBtn);
            overlay.appendChild(viewBtn);

            imageContainer.appendChild(img);
            imageContainer.appendChild(uploadIndicator);  // 添加上传指示器
            imageContainer.appendChild(overlay);
            container.appendChild(imageContainer);
        } else {
            // 多张图片网格显示
            const gridContainer = document.createElement('div');
            gridContainer.className = 'grid grid-cols-2 gap-3';

            urls.forEach((url, index) => {
                const imageContainer = document.createElement('div');
                imageContainer.className = 'relative group bg-white bg-opacity-5 rounded-lg p-2 result-item';  // 添加 result-item 类
                imageContainer.style.zIndex = '1';

                const img = document.createElement('img');
                img.src = url;
                img.className = 'w-full h-40 object-cover rounded-lg shadow-lg';
                img.alt = `生成的图片 ${index + 1}`;

                // 添加上传状态指示器
                const uploadIndicator = document.createElement('div');
                uploadIndicator.className = 'upload-indicator uploading absolute top-3 right-3 bg-black bg-opacity-50 rounded-full p-1.5 text-white text-xs';
                uploadIndicator.innerHTML = '<i class="fas fa-cloud-upload-alt fa-spin"></i>';
                uploadIndicator.title = i18n.t('generate.labels.uploadIndicatorTooltip');

                const overlay = document.createElement('div');
                overlay.className = 'absolute inset-2 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2 rounded-lg';

                const downloadBtn = document.createElement('button');
                downloadBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all';
                downloadBtn.innerHTML = '<i class="fas fa-download"></i>';
                downloadBtn.onclick = () => this.app.downloadImage(url);

                const viewBtn = document.createElement('button');
                viewBtn.className = 'bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all';
                viewBtn.innerHTML = '<i class="fas fa-expand"></i>';
                viewBtn.onclick = () => this.app.viewImage(urls, index);

                overlay.appendChild(downloadBtn);
                overlay.appendChild(viewBtn);

                imageContainer.appendChild(img);
                imageContainer.appendChild(uploadIndicator);  // 添加上传指示器
                imageContainer.appendChild(overlay);
                gridContainer.appendChild(imageContainer);
            });

                        // 添加批量下载按钮
            const batchDownloadContainer = document.createElement('div');
            batchDownloadContainer.className = 'mt-4 text-center';

            const batchDownloadBtn = document.createElement('button');
            batchDownloadBtn.className = 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white py-2 px-4 rounded-lg transition-all transform hover:scale-105 shadow-lg';
            batchDownloadBtn.innerHTML = '<i class="fas fa-file-archive mr-2"></i>' + i18n.t('generate.buttons.batchDownloadAll') + ' (' + urls.length + '张)';
            batchDownloadBtn.onclick = async () => {
                try {
                    const prompt = document.getElementById('promptInput').value.trim();
                    const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                    const zipFilename = `${promptPrefix}_${timestamp}.zip`;

                    const result = await window.aiImageAPI.downloadImagesAsZip(urls, zipFilename, (completed, total) => {
                        this.app.showToast(i18n.t('generate.messages.downloading', {completed: completed, total: total}), 'info');
                    }, window.aiImageAPI.model);

                    this.app.showToast(result.message || i18n.t('generate.messages.batchDownloadCompleted'), 'success');
                } catch (error) {
                    this.app.showToast(error.message, 'error');

                    // 如果是完全失败，显示帮助提示
                    if (error.message.includes('右键图片选择')) {
                        this.showDownloadHelpDialog(urls);
                    }
                }
            };

            batchDownloadContainer.appendChild(batchDownloadBtn);

            container.appendChild(gridContainer);
            container.appendChild(batchDownloadContainer);
        }
    }

    // 显示空结果
    showEmptyResult(container) {
        // 检查容器是否存在
        if (!container) {
            console.error(i18n.t('generate.errors.imageContainerNotFound'));
            return;
        }

        container.innerHTML = `
            <div class="text-center text-white opacity-50">
                <i class="fas fa-exclamation-triangle text-4xl mb-4"></i>
                <p>${i18n.t('generate.messages.generationFailed')}</p>
            </div>
        `;
    }

    // 显示错误结果
    showErrorResult(container, error) {
        // 检查容器是否存在
        if (!container) {
            console.error(i18n.t('generate.errors.errorContainerNotFound'));
            return;
        }

        // 获取格式化的错误信息
        const errorInfo = window.aiImageAPI.formatDetailedError(error);

        container.innerHTML = `
            <div class="text-center text-white">
                <div class="bg-red-500 bg-opacity-20 rounded-lg p-6 border border-red-400 border-opacity-30">
                    <!-- 错误图标 -->
                    <div class="bg-red-500 bg-opacity-30 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                        <i class="fas fa-exclamation-triangle text-2xl text-red-200"></i>
                    </div>

                    <!-- 错误标题 -->
                    <h3 class="text-lg font-semibold text-red-200 mb-2">${errorInfo.title}</h3>

                    <!-- 错误描述 -->
                    <p class="text-red-300 text-sm mb-4 opacity-90">${errorInfo.message}</p>

                    ${errorInfo.details && errorInfo.details.length > 0 ? `
                    <!-- 快速建议 -->
                    <div class="bg-red-400 bg-opacity-20 rounded-lg p-3 mb-4 text-left">
                        <h4 class="text-red-200 font-medium text-sm mb-2">
                            <i class="fas fa-lightbulb mr-1"></i>${i18n.t('generate.labels.quickSolutionTitle')}
                        </h4>
                        <ul class="text-red-300 text-xs space-y-1">
                            ${errorInfo.details.slice(0, 2).map(detail => `
                                <li class="flex items-start space-x-1">
                                    <span class="text-red-400 mt-0.5">•</span>
                                    <span>${detail}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                    ` : ''}

                    <!-- 操作按钮 -->
                    <div class="flex flex-col sm:flex-row gap-2 justify-center">
                        <button onclick="app.showDetailedError(${JSON.stringify(error).replace(/"/g, '&quot;')}, '${i18n.t('generate.errors.detailedErrorTitle')}')"
                                class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">
                            <i class="fas fa-info-circle mr-1"></i>${i18n.t('generate.buttons.viewDetails')}
                        </button>
                        <button onclick="generatePage.generateImage()"
                                class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm transition-colors">
                            <i class="fas fa-redo mr-1"></i>${i18n.t('generate.buttons.retryGenerate')}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    // 显示下载帮助对话框
    showDownloadHelpDialog(urls) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
                <h3 class="text-xl font-bold mb-4 text-gray-800">
                    <i class="fas fa-question-circle text-blue-500 mr-2"></i>
                    ${i18n.t('generate.messages.downloadHelperTitle')}
                </h3>
                <div class="space-y-3 text-gray-600 text-sm">
                    <p><strong>${i18n.t('generate.messages.downloadHelperMessage')}</strong></p>
                    <p>${i18n.t('generate.messages.downloadSteps')}</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>${i18n.t('generate.messages.downloadStep1')}</li>
                        <li>${i18n.t('generate.messages.downloadStep2')}</li>
                        <li>${i18n.t('generate.messages.downloadStep3')}</li>
                        <li>${i18n.t('generate.messages.downloadStep4')}</li>
                    </ol>
                </div>
                <div class="flex space-x-3 mt-6">
                    <button onclick="app.viewImage(${JSON.stringify(urls).replace(/"/g, '&quot;')}, 0)" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
                        <i class="fas fa-eye mr-2"></i>${i18n.t('generate.messages.viewImages')}
                    </button>
                    <button onclick="this.parentElement.parentElement.parentElement.remove()" class="bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
                        ${i18n.t('generate.messages.understood')}
                    </button>
                </div>
            </div>
        `;

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        document.body.appendChild(modal);
    }

    // 页面激活时调用
    async onActivate() {
        // 每次激活时可以进行一些初始化操作
        console.log(i18n.t('generate.messages.pageActivated'));

        // 恢复保存的状态（仅在首次激活或状态未恢复时）
        if (!this.stateRestored && window.pageStateManager) {
            try {
                const savedState = await window.pageStateManager.loadState('generate');
                if (savedState) {
                    this.restoreState(savedState);
                }
            } catch (error) {
                console.error('恢复 GeneratePage 状态失败:', error);
            }
        }

        // 重置结果显示状态（如果没有恢复的结果）
        if (!this.lastGeneratedUrls || this.lastGeneratedUrls.length === 0) {
            this.resetResultDisplay();
        }

        // 更新参考图片限制显示
        this.updateReferenceImageLimitDisplay();

        // 更新参考图预览
        this.updateReferenceImagesPreview();

        // 更新智能尺寸设置
        this.updateIntelligentResizeIfNeeded();

        // 设置 R2 上传监听器
        this.setupR2UploadListener();
    }

    // 重置结果显示状态
    resetResultDisplay() {
        const resultTabs = document.getElementById('resultTabs');
        if (resultTabs) {
            resultTabs.classList.add('hidden');
        }

        // 重置Tab状态
        document.querySelectorAll('.tab-result-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const resultTab = document.getElementById('resultTab');
        if (resultTab) {
            resultTab.classList.add('active');
        }

        // 隐藏所有结果区域
        const imageResult = document.getElementById('imageResult');
        const originalImages = document.getElementById('originalImages');
        const compareView = document.getElementById('compareView');

        if (imageResult) imageResult.classList.remove('hidden');
        if (originalImages) originalImages.classList.add('hidden');
        if (compareView) compareView.classList.add('hidden');

        // 重置为默认提示
        if (imageResult) {
            imageResult.innerHTML = `
                <div class="text-center text-white opacity-50">
                    <i class="fas fa-image text-4xl mb-4"></i>
                    <p>${i18n.t('generate.labels.generatedImagesPlaceholder')}</p>
                </div>
            `;
        }
    }

    // 绑定结果Tab切换事件
    bindResultTabEvents() {
        const resultTab = document.getElementById('resultTab');
        const originalTab = document.getElementById('originalTab');
        const compareTab = document.getElementById('compareTab');

        if (resultTab) {
            resultTab.addEventListener('click', () => this.showResultTab('result'));
        }
        if (originalTab) {
            originalTab.addEventListener('click', () => this.showResultTab('original'));
        }
        if (compareTab) {
            compareTab.addEventListener('click', () => this.showResultTab('compare'));
        }
    }

    // 显示指定的结果Tab
    showResultTab(tabType) {
        // 更新Tab按钮状态
        document.querySelectorAll('.tab-result-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        // 隐藏所有内容区域
        const imageResult = document.getElementById('imageResult');
        const originalImages = document.getElementById('originalImages');
        const compareView = document.getElementById('compareView');

        if (imageResult) imageResult.classList.add('hidden');
        if (originalImages) originalImages.classList.add('hidden');
        if (compareView) compareView.classList.add('hidden');

        // 显示对应的Tab和内容
        switch (tabType) {
            case 'result':
                document.getElementById('resultTab')?.classList.add('active');
                if (imageResult) imageResult.classList.remove('hidden');
                break;
            case 'original':
                document.getElementById('originalTab')?.classList.add('active');
                if (originalImages) originalImages.classList.remove('hidden');
                this.updateOriginalImagesDisplay();
                break;
            case 'compare':
                document.getElementById('compareTab')?.classList.add('active');
                if (compareView) compareView.classList.remove('hidden');
                this.updateCompareView();
                break;
        }
    }

    // 更新原图显示
    updateOriginalImagesDisplay() {
        const originalImagesContent = document.getElementById('originalImagesContent');
        if (!originalImagesContent) return;

        originalImagesContent.innerHTML = '';

        if (this.referenceImages.length === 0) {
            originalImagesContent.innerHTML = `
                <div class="text-center text-white opacity-50 py-8">
                    <i class="fas fa-image text-3xl mb-3"></i>
                    <p>${i18n.t('generate.messages.noReferencesUploaded')}</p>
                </div>
            `;
            return;
        }

        // 显示所有参考图
        this.referenceImages.forEach((imageData, index) => {
            const imageDiv = document.createElement('div');
            imageDiv.className = 'relative group bg-white bg-opacity-5 rounded-lg p-2';
            const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase();
            imageDiv.innerHTML = `
                <img src="data:${mimeType};base64,${imageData.base64}"
                     class="w-full h-auto rounded-lg"
                     alt="${i18n.t('generate.labels.referenceImageLabel', {index: index + 1})}">
                <div class="absolute top-2 left-2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded">
                    ${i18n.t('generate.labels.referenceImageLabel', {index: index + 1})}
                </div>
                <div class="absolute inset-2 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2 rounded-lg">
                    <button onclick="app.viewImage('data:${mimeType};base64,${imageData.base64}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${i18n.t('generate.buttons.expandView')}">
                        <i class="fas fa-expand"></i>
                    </button>
                </div>
            `;
            originalImagesContent.appendChild(imageDiv);
        });
    }

    // 更新对比视图
    updateCompareView() {
        const beforeImages = document.getElementById('beforeImages');
        const afterImages = document.getElementById('afterImages');

        if (!beforeImages || !afterImages) return;

        // 清空内容
        beforeImages.innerHTML = '';
        afterImages.innerHTML = '';

        // 显示参考图
        if (this.referenceImages.length === 0) {
            beforeImages.innerHTML = `
                <div class="text-center text-white opacity-50 py-4">
                    <i class="fas fa-image text-2xl mb-2"></i>
                    <p class="text-sm">${i18n.t('generate.messages.noReferencesUploaded')}</p>
                </div>
            `;
        } else {
            this.referenceImages.forEach((imageData, index) => {
                const imageDiv = document.createElement('div');
                imageDiv.className = 'relative bg-white bg-opacity-5 rounded-lg p-1';
                const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase();
                imageDiv.innerHTML = `
                    <img src="data:${mimeType};base64,${imageData.base64}"
                         class="w-full h-32 object-cover rounded-lg"
                         alt="${i18n.t('generate.labels.referenceImageLabel', {index: index + 1})}">
                    <div class="absolute top-1 left-1 bg-black bg-opacity-70 text-white text-xs px-1 py-0.5 rounded">
                        ${i18n.t('generate.labels.referenceImageLabel', {index: index + 1})}
                    </div>
                `;
                beforeImages.appendChild(imageDiv);
            });
        }

        // 显示生成结果（如果有的话）
        if (this.lastGeneratedUrls && this.lastGeneratedUrls.length > 0) {
            this.lastGeneratedUrls.forEach((url, index) => {
                const imageDiv = document.createElement('div');
                imageDiv.className = 'relative group bg-white bg-opacity-5 rounded-lg p-1';
                imageDiv.innerHTML = `
                    <img src="${url}"
                         class="w-full h-32 object-cover rounded-lg"
                         alt="${i18n.t('generate.labels.generateResultLabel', {index: index + 1})}">
                    <div class="absolute top-1 left-1 bg-black bg-opacity-70 text-white text-xs px-1 py-0.5 rounded">
                        ${i18n.t('generate.labels.generateResultLabel', {index: index + 1})}
                    </div>
                    <div class="absolute inset-1 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-1 rounded-lg">
                        <button onclick="app.downloadImage('${url}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-1 rounded text-xs transition-all" title="${i18n.t('generate.buttons.download')}">
                            <i class="fas fa-download"></i>
                        </button>
                        <button onclick="app.viewImage(${JSON.stringify(this.lastGeneratedUrls).replace(/"/g, '&quot;')}, ${index})" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-1 rounded text-xs transition-all" title="${i18n.t('generate.buttons.expandView')}">
                            <i class="fas fa-expand"></i>
                        </button>
                    </div>
                `;
                afterImages.appendChild(imageDiv);
            });
        } else {
            afterImages.innerHTML = `
                <div class="text-center text-white opacity-50 py-4">
                    <i class="fas fa-image text-2xl mb-2"></i>
                    <p class="text-sm">${i18n.t('generate.messages.noGeneratedImages')}</p>
                </div>
            `;
        }
    }

    // 新增：上传进度提示
    showProgressToast(message) {
        const progressId = 'upload-progress-' + Date.now();
        const progressElement = document.createElement('div');
        progressElement.id = progressId;
        progressElement.className = 'fixed top-20 right-4 bg-blue-500 text-white p-4 rounded-lg shadow-lg z-[10001]';
        progressElement.innerHTML = `
            <div class="flex items-center space-x-3">
                <i class="fas fa-spinner fa-spin"></i>
                <span class="progress-text">${message}</span>
            </div>
        `;

        document.body.appendChild(progressElement);

        return {
            update: (newMessage) => {
                const textElement = progressElement.querySelector('.progress-text');
                if (textElement) {
                    textElement.textContent = newMessage;
                }
            },
            close: () => {
                progressElement.remove();
            }
        };
    }

    // ==================== 状态持久化方法 ====================

    /**
     * 收集当前页面状态
     * @returns {object} 页面状态对象
     */
    collectState() {
        const promptInput = document.getElementById('promptInput');
        const generateCountSelect = document.getElementById('generateCount');

        return {
            prompt: promptInput?.value || '',
            ratio: this.currentRatio,
            resolution: this.currentResolution,
            generateCount: generateCountSelect?.value || '1',
            referenceImages: this.referenceImages.map(img => ({
                base64: img.base64,
                fileName: img.fileName,
                fileSize: img.fileSize,
                mimeType: img.mimeType,
                id: img.id,
                width: img.width,
                height: img.height,
                needsCompression: img.needsCompression
            })),
            lastGeneratedUrls: this.lastGeneratedUrls
        };
    }

    /**
     * 恢复页面状态
     * @param {object} state - 页面状态对象
     */
    restoreState(state) {
        if (!state) return;

        console.log('📥 恢复 GeneratePage 状态:', state);

        // 恢复提示词
        const promptInput = document.getElementById('promptInput');
        if (promptInput && state.prompt) {
            promptInput.value = state.prompt;
        }

        // 恢复比例
        if (state.ratio) {
            this.currentRatio = state.ratio;
            this.selectRatio(state.ratio);
        }

        // 恢复分辨率
        if (state.resolution) {
            this.currentResolution = state.resolution;
            this.selectResolution(state.resolution);
        }

        // 恢复生成数量
        const generateCountSelect = document.getElementById('generateCount');
        if (generateCountSelect && state.generateCount) {
            generateCountSelect.value = state.generateCount;
        }

        // 恢复参考图（过滤掉没有 base64 的大图）
        if (state.referenceImages && Array.isArray(state.referenceImages)) {
            this.referenceImages = state.referenceImages.filter(img => img && img.base64);
            this.updateReferenceImagesPreview();
        }

        // 恢复最后生成的图片 URL
        if (state.lastGeneratedUrls && Array.isArray(state.lastGeneratedUrls)) {
            this.lastGeneratedUrls = state.lastGeneratedUrls;
        }

        this.stateRestored = true;
    }

    /**
     * 保存当前状态（带防抖）
     */
    saveCurrentState() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveState('generate', state);
        }
    }

    /**
     * 立即保存当前状态
     */
    saveCurrentStateImmediate() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveStateImmediate('generate', state);
        }
    }

    /**
     * 绑定状态自动保存事件
     */
    bindStateAutoSave() {
        // 提示词输入变化时保存
        const promptInput = document.getElementById('promptInput');
        if (promptInput) {
            promptInput.addEventListener('input', () => this.saveCurrentState());
        }

        // 生成数量变化时保存
        const generateCountSelect = document.getElementById('generateCount');
        if (generateCountSelect) {
            generateCountSelect.addEventListener('change', () => this.saveCurrentState());
        }
    }

    // 页面失活时调用
    onDeactivate() {
        // 保存页面状态
        this.saveCurrentStateImmediate();

        // 每次失活时可以进行一些清理操作
        console.log(i18n.t('generate.messages.pageDeactivated'));

        // 移除 R2 上传监听器
        if (this.r2UploadListener) {
            window.removeEventListener('r2UploadComplete', this.r2UploadListener);
            this.r2UploadListener = null;
        }
    }

    // 语言切换时调用
    onLanguageChange(lang) {
        console.log(`GeneratePage: Language changed to ${lang}`);
        // 更新参考图片限制显示文本
        this.updateReferenceImageLimitDisplay();
    }
}

// 导出模块
window.GeneratePage = GeneratePage;
