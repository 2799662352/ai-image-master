// 批量生成页面模块
class BatchPage {
    constructor(app) {
        this.app = app;
        this.currentResolution = '2K'; // 默认分辨率
        this.batchReferenceImages = []; // 存储多张批量参考图片的base64数据
        this.maxReferenceImages = 8; // 默认最多8张，Flux模型仅支持1张
        this.isProcessingBatchFiles = false; // 防止重复触发文件处理
        this.isBatchFileSelectionActive = false; // 防止重复触发批量文件选择
        this.currentBatchResults = []; // 存储当前批量生成的结果
        this.isBatchGenerating = false; // 标记是否正在批量生成
        this.currentBatchMode = 'card'; // 当前批量模式：'card' 或 'multi'
        this.stateRestored = false; // 标记状态是否已恢复

        // 批量上传配置
        this.uploadConfig = {
            maxConcurrency: 5, // 最大并发数
            retryAttempts: 3,  // 文件上传转换重试次数（技术性问题）
            timeout: 30000     // 超时时间
        };

        this.init();
    }

    init() {
        this.bindEvents();
        this.bindStateAutoSave();
    }

    // 响应语言切换
    onLanguageChange(lang) {
        console.log('BatchPage: 语言切换为', lang);
        // 更新动态生成的UI元素
        this.updateBatchReferenceImagesPreview();
        this.updateCardCostEstimate();
        // 更新空状态提示
        this.updateEmptyStateText();
    }

    // 获取 i18n 实例
    get i18n() {
        return this.app?.i18n;
    }

    // 更新空状态文本
    updateEmptyStateText() {
        const batchResults = document.getElementById('batchResults');
        if (batchResults && batchResults.querySelector('.col-span-full')) {
            const emptyDiv = batchResults.querySelector('.col-span-full');
            if (emptyDiv && this.i18n) {
                emptyDiv.querySelector('p').textContent = this.i18n.t('batch.labels.emptyResults');
            }
        }
    }

    bindEvents() {
        // 批量生成事件
        document.getElementById('batchGenerateBtn').addEventListener('click', () => this.batchGenerate());
        window.addEventListener('batchProgress', (e) => this.updateBatchProgress(e.detail));
        
        // 监听单个项目完成事件，实现渐进式显示
        window.addEventListener('batchItemComplete', (e) => this.addSingleResult(e.detail));
        
        // 批量参考图上传相关事件
        this.bindBatchReferenceImageEvents();
        
        // 模式切换事件
        document.querySelectorAll('input[name="batchMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => this.switchBatchMode(e.target.value));
        });
        
        // 抽卡数量滑块事件
        const cardCountSlider = document.getElementById('cardCount');
        if (cardCountSlider) {
            cardCountSlider.addEventListener('input', () => this.updateCardCostEstimate());
        }
        
        // 二次确认对话框事件
        const cancelCardConfirmBtn = document.getElementById('cancelCardConfirm');
        if (cancelCardConfirmBtn) {
            cancelCardConfirmBtn.addEventListener('click', () => {
                document.getElementById('cardConfirmModal').classList.add('hidden');
            });
        }
        
        const confirmCardGenerateBtn = document.getElementById('confirmCardGenerate');
        if (confirmCardGenerateBtn) {
            confirmCardGenerateBtn.addEventListener('click', () => {
                document.getElementById('cardConfirmModal').classList.add('hidden');
                this.executeCardGeneration();
            });
        }
        
        // 多提示词模式的模板按钮
        const batchPromptTemplateBtn2 = document.getElementById('batchPromptTemplateBtn2');
        if (batchPromptTemplateBtn2) {
            batchPromptTemplateBtn2.addEventListener('click', () => {
                // 触发与主模板按钮相同的事件
                window.dispatchEvent(new CustomEvent('showPromptTemplates', { 
                    detail: { targetInput: 'batchPrompts' } 
                }));
            });
        }
    }

    // 触发批量文件选择 - 动态创建input避免缓存问题
    triggerBatchFileSelection() {
        // 如果正在处理文件或者文件选择已激活，避免重复触发
        if (this.isProcessingBatchFiles) {
            console.log(this.i18n ? this.i18n.t('batch.upload.processing') : '正在处理批量文件，跳过重复触发');
            return;
        }

        if (this.isBatchFileSelectionActive) {
            console.log(this.i18n ? this.i18n.t('batch.upload.selectionActive') : '批量文件选择已激活，跳过重复触发');
            return;
        }
        
        // 设置批量文件选择激活标志位
        this.isBatchFileSelectionActive = true;
        console.log('设置批量文件选择激活标志位');
        
        // 创建新的input元素
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        
        // 添加唯一标识
        const inputId = 'batch-dynamic-input-' + Date.now() + '-' + Math.random();
        input.id = inputId;
        
        // 清理函数
        const cleanup = () => {
            this.isBatchFileSelectionActive = false;
            console.log('重置批量文件选择激活标志位');
            if (input.parentNode) {
                input.parentNode.removeChild(input);
                console.log('已清理批量动态input:', inputId);
            }
        };
        
        // 绑定change事件
        input.addEventListener('change', (e) => {
            console.log('批量动态input change事件触发:', inputId);
            if (e.target.files.length > 0 && !this.isProcessingBatchFiles) {
                const files = Array.from(e.target.files);
                this.handleMultipleBatchReferenceImageUpload(files);
            }
            cleanup();
        });
        
        // 绑定cancel事件（用户取消选择文件时）
        input.addEventListener('cancel', () => {
            console.log('用户取消批量文件选择:', inputId);
            cleanup();
        });
        
        // 监听焦点丢失事件（兼容性处理）
        input.addEventListener('blur', () => {
            // 延迟一下检查，给change事件时间触发
            setTimeout(() => {
                if (this.isBatchFileSelectionActive) {
                    console.log('检测到批量焦点丢失，可能用户取消了选择:', inputId);
                    cleanup();
                }
            }, 100);
        });
        
        // 添加到DOM并触发点击
        document.body.appendChild(input);
        console.log('创建批量动态input并触发点击:', inputId);
        input.click();
    }

    // 绑定批量参考图相关事件
    bindBatchReferenceImageEvents() {
        const batchReferenceImageArea = document.getElementById('batchReferenceImageArea');
        const addMoreBatchReferenceArea = document.getElementById('addMoreBatchReferenceArea');

        // 检查必需的DOM元素是否存在
        if (!batchReferenceImageArea) {
            console.error('batchReferenceImageArea 元素未找到，可能DOM还未完全加载');
            return;
        }

        // 点击上传区域 - 处理初始上传和添加更多
        const handleUploadAreaClick = (e) => {
            // 阻止事件冒泡
            e.stopPropagation();
            
            // 检查是否点击了移除按钮
            if (e.target.closest('.remove-batch-reference-btn')) {
                return;
            }
            
            // 检查是否点击了动态创建的添加更多按钮
            if (e.target.closest('[data-dynamic-add-button="true"]')) {
                console.log('点击了批量动态添加更多按钮，跳过主区域处理');
                return;
            }
            
            // 检查是否点击了已上传的图片容器（禁用图片点击，避免误操作）
            if (e.target.closest('.relative.bg-white.bg-opacity-10')) {
                console.log('点击了已上传的批量图片，已禁用点击上传功能');
                return;
            }
            
            console.log('点击批量上传区域');
            this.triggerBatchFileSelection();
        };

        batchReferenceImageArea.addEventListener('click', handleUploadAreaClick);

        // 添加更多参考图区域点击事件
        if (addMoreBatchReferenceArea) {
            addMoreBatchReferenceArea.addEventListener('click', (e) => {
                // 阻止事件冒泡
                e.stopPropagation();
                
                console.log('点击添加更多批量参考图区域');
                if (this.batchReferenceImages.length < this.maxReferenceImages) {
                    this.triggerBatchFileSelection();
                } else {
                    // 检查是否为Flux模型并显示友好提示
                    const currentModel = window.aiImageAPI?.getCurrentModel();
                    if (currentModel && currentModel.apiType === 'flux-kontext') {
                        this.app.showToast(this.i18n ? this.i18n.t('batch.messages.fluxModelLimit') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进 🚀', 'info', 4000);
                    } else {
                        this.app.showToast(this.i18n ? this.i18n.t('batch.messages.maxImagesReached', { max: this.maxReferenceImages }) : `最多只能上传${this.maxReferenceImages}张参考图`, 'warning');
                    }
                }
            });
        }

        // 完全禁用原始HTML input元素，避免任何事件冲突
        // 我们只使用动态创建的input元素

        // 添加粘贴事件监听器
        this.bindBatchPasteEvents();
    }

    // 绑定批量粘贴事件
    bindBatchPasteEvents() {
        // 粘贴事件由主应用程序统一处理和分发，这里只需要处理UI反馈

        // 为批量参考图区域添加视觉反馈
        const batchReferenceImageArea = document.getElementById('batchReferenceImageArea');
        if (batchReferenceImageArea) {
            // 添加焦点状态，让用户知道可以粘贴
            batchReferenceImageArea.setAttribute('tabindex', '0');
            batchReferenceImageArea.setAttribute('role', 'button');
            batchReferenceImageArea.setAttribute('aria-label', '上传批量参考图片，支持点击选择或Ctrl+V粘贴');

            // 键盘事件支持
            batchReferenceImageArea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.triggerBatchFileSelection();
                }
            });

            // 拖拽视觉反馈
            batchReferenceImageArea.addEventListener('dragenter', (e) => {
                e.preventDefault();
                batchReferenceImageArea.classList.add('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            batchReferenceImageArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                batchReferenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');
            });

            batchReferenceImageArea.addEventListener('dragover', (e) => {
                e.preventDefault();
            });

            batchReferenceImageArea.addEventListener('drop', (e) => {
                e.preventDefault();
                batchReferenceImageArea.classList.remove('border-opacity-70', 'bg-white', 'bg-opacity-5');
                
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) {
                    this.handleMultipleBatchReferenceImageUpload(files);
                }
            });
        }
    }

    // 处理批量粘贴事件
    async handleBatchPasteEvent(e) {
        const clipboardItems = e.clipboardData?.items;
        if (!clipboardItems) {
            return;
        }

        console.log('检测到批量粘贴事件，剪贴板项目数量:', clipboardItems.length);

        const imageFiles = [];
        
        // 遍历剪贴板项目
        for (let i = 0; i < clipboardItems.length; i++) {
            const item = clipboardItems[i];
            console.log('批量剪贴板项目类型:', item.type);
            
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
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.noImageInClipboard') : '剪贴板中没有找到图片，请复制图片后再试', 'warning');
            return;
        }

        // 检查是否超过数量限制
        if (this.batchReferenceImages.length >= this.maxReferenceImages) {
            const currentModel = window.aiImageAPI?.getCurrentModel();
            if (currentModel && currentModel.apiType === 'flux-kontext') {
                this.app.showToast(this.i18n ? this.i18n.t('batch.messages.fluxModelLimit') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进 🚀', 'info', 4000);
            } else {
                this.app.showToast(this.i18n ? this.i18n.t('batch.messages.maxImagesReached', { max: this.maxReferenceImages }) : `最多只能上传${this.maxReferenceImages}张参考图`, 'warning');
            }
            return;
        }

        console.log('从剪贴板获取到批量图片数量:', imageFiles.length);

        // 阻止默认粘贴行为
        e.preventDefault();

        // 处理粘贴的图片
        try {
            await this.handleMultipleBatchReferenceImageUpload(imageFiles);
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.pasteSuccess', { count: imageFiles.length }) : `成功粘贴 ${imageFiles.length} 张图片到批量参考图`, 'success');
        } catch (error) {
            console.error('处理批量粘贴图片时出错:', error);
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.pasteFailed') : '粘贴图片失败，请重试', 'error');
        }
    }

    // 增强版处理多张批量参考图上传
    async handleMultipleBatchReferenceImageUpload(files) {
        // 动态调整最大图片数量：Flux模型仅支持1张，其他模型3张
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }
        const uploadId = Date.now() + '-batch-' + Math.random().toString(36).substr(2, 9);
        console.log(`🔄 开始批量图片上传任务: ${uploadId}, 文件数量: ${files.length}`);
        
        // 更强的防重复检查
        if (this.isProcessingBatchFiles) {
            console.log(`⏭️ 检测到重复批量上传，忽略任务: ${uploadId}`);
            return;
        }
        
        // 设置处理锁
        this.isProcessingBatchFiles = true;
        this.currentBatchUploadId = uploadId;
        
        try {
            const startTime = Date.now();
            
            // 预处理：批量验证所有文件
            const validFiles = [];
            for (const file of files) {
                try {
                    this.validateImageFile(file);
                    
                    // 检查重复文件
                    const isDuplicate = this.batchReferenceImages.some(img => 
                        img.fileName === file.name && 
                        Math.abs(img.fileSize - file.size) < 1024
                    );
                    
                    if (isDuplicate) {
                        this.app.showToast(this.i18n ? this.i18n.t('batch.messages.duplicateFile', { name: file.name }) : `${file.name} 已存在，跳过重复文件`, 'warning');
                        continue;
                    }
                    
                    // 检查数量限制
                    if (this.batchReferenceImages.length + validFiles.length >= this.maxReferenceImages) {
                        if (validFiles.length === 0) {
                            const currentModel = window.aiImageAPI?.getCurrentModel();
                            if (currentModel && currentModel.apiType === 'flux-kontext') {
                                throw new Error(this.i18n ? this.i18n.t('batch.messages.fluxModelLimitError') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进');
                            } else {
                                throw new Error(this.i18n ? this.i18n.t('batch.messages.maxImagesReachedError', { max: this.maxReferenceImages }) : `最多只能上传${this.maxReferenceImages}张参考图`);
                            }
                        }

                        const currentModel = window.aiImageAPI?.getCurrentModel();
                        if (currentModel && currentModel.apiType === 'flux-kontext') {
                            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.fluxModelLimit') : 'Flux 模型目前暂时仅支持一张配图，静待后续改进 🚀', 'info', 4000);
                        } else {
                            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.uploadLimitReached', { max: this.maxReferenceImages }) : `已达到上传上限，仅处理前${this.maxReferenceImages}张图片`, 'warning');
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
            const progressToast = this.showProgressToast(this.i18n ? this.i18n.t('batch.messages.processingImages', { count: validFiles.length }) : `正在处理 ${validFiles.length} 张批量参考图...`);
            
            // 智能并发处理多个文件
            const concurrencyLimit = Math.min(this.uploadConfig.maxConcurrency, validFiles.length);
            console.log(`🚀 批量并发处理配置: ${concurrencyLimit}个文件同时处理`);
            const results = [];
            
            for (let i = 0; i < validFiles.length; i += concurrencyLimit) {
                const batch = validFiles.slice(i, i + concurrencyLimit);
                const batchPromises = batch.map(async (file, index) => {
                    try {
                        // 检查是否被取消
                        if (this.currentBatchUploadId !== uploadId) {
                            throw new Error('批量上传任务已被取消');
                        }
                        
                        const base64 = await this.fileToBase64Enhanced(file);
                        const dimensions = await this.getBatchImageDimensions(file);
                        
                        return {
                            base64,
                            originalFile: file,  // 保存原始File对象供生成时压缩使用
                            fileName: file.name,
                            fileSize: file.size,
                            mimeType: (file.type || 'image/jpeg').toLowerCase(),
                            id: Date.now() + Math.random(),
                            width: dimensions.width,
                            height: dimensions.height,
                            uploadTime: new Date().toISOString(),
                            needsCompression: file.size > 2 * 1024 * 1024  // 标记是否需要压缩（>2MB）
                        };
                    } catch (error) {
                        console.error(`❌ 处理批量文件 ${file.name} 失败:`, error);
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
                progressToast.update(this.i18n ? this.i18n.t('batch.messages.processedProgress', {
                    processed,
                    total: validFiles.length,
                    concurrent: Math.min(concurrencyLimit, validFiles.length - i)
                }) : `已处理 ${processed} / ${validFiles.length} 张批量参考图 (并发:${Math.min(concurrencyLimit, validFiles.length - i)})`);
            }
            
            // 添加成功处理的图片
            this.batchReferenceImages.push(...results);
            
            // 更新UI显示
            this.updateBatchReferenceImagesPreview();
            
            // 如果当前是Gemini智能尺寸模式，更新智能尺寸显示
            this.updateBatchIntelligentResizeIfNeeded();
            
            // 关闭进度提示
            progressToast.close();
            
            const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const successCount = results.length;
            
            if (successCount > 0) {
                const message = successCount === 1 ?
                    (this.i18n ? this.i18n.t('batch.messages.uploadSuccess', { time: processTime }) : `批量参考图上传成功 (耗时${processTime}秒)`) :
                    (this.i18n ? this.i18n.t('batch.messages.uploadSuccessMultiple', { count: successCount, time: processTime }) : `成功上传 ${successCount} 张批量参考图 (耗时${processTime}秒)`);
                this.app.showToast(message, 'success');
            }
            
            console.log(`✅ 批量上传任务完成: ${uploadId}, 成功: ${successCount}/${validFiles.length}, 耗时: ${processTime}秒`);
            
        } catch (error) {
            console.error(`❌ 批量上传任务失败: ${uploadId}`, error);
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.uploadFailed', { error: error.message }) : `批量图片上传失败: ${error.message}`, 'error');
        } finally {
            // 确保清理状态
            this.isProcessingBatchFiles = false;
            this.currentBatchUploadId = null;
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
                                throw new Error('FileReader返回无效结果');
                            }
                            
                            const base64 = result.split(',')[1];
                            if (!base64 || base64.length < 100) {
                                throw new Error('Base64数据异常短，可能转换失败');
                            }
                            
                            // 验证Base64格式
                            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
                                throw new Error('Base64格式验证失败');
                            }
                            
                            resolve(base64);
                        } catch (error) {
                            reject(error);
                        }
                    };
                    
                    reader.onerror = () => {
                        reject(new Error(`文件读取失败: ${reader.error?.message || '未知错误'}`));
                    };
                    
                    reader.onabort = () => {
                        reject(new Error('文件读取被中断'));
                    };
                    
                    // 设置超时
                    setTimeout(() => {
                        reader.abort();
                        reject(new Error('文件读取超时'));
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
                    throw new Error(`文件转换失败，已重试${maxRetries}次: ${error.message}`);
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
                        reject(new Error('图片尺寸无效'));
                    }
                };
                
                testImg.onerror = () => {
                    reject(new Error('Base64数据无法解析为有效图片'));
                };
                
                // 设置验证超时
                setTimeout(() => {
                    reject(new Error('图片验证超时'));
                }, 10000);
                
                testImg.src = dataUrl;
            });
            
        } catch (error) {
            throw new Error(`图片数据验证失败: ${error.message}`);
        }
    }

    // 增强版文件验证
    validateImageFile(file) {
        // 基础检查
        if (!file.type.startsWith('image/')) {
            throw new Error(this.i18n ? this.i18n.t('batch.messages.notImageFile', { name: file.name }) : `${file.name} 不是图片文件`);
        }

        // 文件大小检查
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
            const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
            throw new Error(this.i18n ? this.i18n.t('batch.messages.fileTooLarge', { name: file.name, size: fileSizeMB }) : `${file.name} 文件过大（${fileSizeMB}MB），最大支持50MB`);
        }

        // 支持的格式列表
        const supportedTypes = [
            'image/jpeg', 'image/jpg', 'image/png',
            'image/webp', 'image/bmp'
        ];

        if (!supportedTypes.includes(file.type.toLowerCase())) {
            throw new Error(this.i18n ? this.i18n.t('batch.messages.unsupportedFormat', { name: file.name }) : `${file.name} 格式不支持，请使用 JPG、PNG、WebP 或 BMP 格式`);
        }

        // 文件名检查
        if (file.name.length > 100) {
            console.warn(this.i18n ? this.i18n.t('batch.messages.filenameTooLong', { name: file.name }) : `文件名过长，将被截断: ${file.name}`);
        }

        // 最小尺寸检查
        if (file.size < 1024) { // 小于1KB
            throw new Error(this.i18n ? this.i18n.t('batch.messages.fileTooSmall', { name: file.name }) : `${file.name} 文件过小，可能不是有效的图片文件`);
        }

        console.log(`✅ 文件验证通过: ${file.name} (${file.type}, ${(file.size/1024).toFixed(1)}KB)`);
        return true;
    }

    // 更新批量参考图预览显示
    updateBatchReferenceImagesPreview() {
        // 动态调整最大图片数量：Flux模型仅支持1张，其他模型3张
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }
        const uploadPrompt = document.getElementById('batchReferenceUploadPrompt');
        const preview = document.getElementById('batchReferenceImagesPreview');
        const imagesList = document.getElementById('batchReferenceImagesList');
        const addMoreArea = document.getElementById('addMoreBatchReferenceArea');
        const countText = document.getElementById('batchReferenceCountText');

        if (this.batchReferenceImages.length === 0) {
            uploadPrompt.classList.remove('hidden');
            preview.classList.add('hidden');
            return;
        }

        uploadPrompt.classList.add('hidden');
        preview.classList.remove('hidden');

        // 清空现有预览
        imagesList.innerHTML = '';

        // 生成每张图片的预览
        this.batchReferenceImages.forEach((imageData, index) => {
            const imageItem = document.createElement('div');
            imageItem.className = 'relative bg-white bg-opacity-10 rounded-lg p-2 group';
            const mimeType = (imageData.mimeType || 'image/jpeg').toLowerCase();
            const altText = this.i18n ? this.i18n.t('batch.labels.referenceImageAlt', { index: index + 1 }) : `批量参考图${index + 1}`;
            const removeTitle = this.i18n ? this.i18n.t('batch.buttons.removeReference') : '移除此参考图';
            const removeAriaLabel = this.i18n ? this.i18n.t('batch.labels.removeReferenceAria', { index: index + 1 }) : `移除批量参考图${index + 1}`;
            imageItem.innerHTML = `
                <div class="relative">
                    <img src="data:${mimeType};base64,${imageData.base64}"
                         class="w-full aspect-square object-cover rounded-lg"
                         alt="${altText}">
                    <button class="remove-batch-reference-btn absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-colors opacity-0 group-hover:opacity-100"
                            title="${removeTitle}"
                            aria-label="${removeAriaLabel}"
                            data-image-id="${imageData.id}">
                        <i class="fas fa-times text-xs"></i>
                    </button>
                </div>
            `;
            imagesList.appendChild(imageItem);
        });

        // 添加"添加更多"按钮（如果还没达到上限）
        if (this.batchReferenceImages.length < this.maxReferenceImages) {
            const addButton = document.createElement('div');
            addButton.className = 'border-2 border-dashed border-white border-opacity-30 hover:border-opacity-50 rounded-lg p-2 cursor-pointer transition-all flex items-center justify-center aspect-square group';
            addButton.setAttribute('data-dynamic-add-button', 'true'); // 添加唯一标识
            const addMoreText = this.i18n ? this.i18n.t('batch.buttons.addMoreReference') : '添加更多参考图';
            addButton.innerHTML = `
                <div class="text-center">
                    <i class="fas fa-plus text-white opacity-50 group-hover:opacity-70 text-xl mb-1"></i>
                    <p class="text-white opacity-50 group-hover:opacity-70 text-xs">${addMoreText}</p>
                    <p class="text-white opacity-30 group-hover:opacity-50 text-xs">(${this.batchReferenceImages.length}/${this.maxReferenceImages})</p>
                </div>
            `;
            addButton.addEventListener('click', (e) => {
                // 阻止事件冒泡，避免触发父容器的点击事件
                e.stopPropagation();
                console.log('点击批量动态添加更多按钮');
                this.triggerBatchFileSelection();
            });
            imagesList.appendChild(addButton);
        }

        // 绑定移除按钮事件
        imagesList.querySelectorAll('.remove-batch-reference-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const imageId = parseFloat(e.target.closest('.remove-batch-reference-btn').dataset.imageId);
                this.removeBatchReferenceImage(imageId);
            });
        });

        // 更新计数显示 - 已集成到加号按钮内，无需单独显示
        // if (countText) {
        //     countText.textContent = `(${this.batchReferenceImages.length}/${this.maxReferenceImages})`;
        // }

        // 控制添加更多区域的显示 - 已集成到grid布局中，无需单独显示
        // if (addMoreArea) {
        //     if (this.batchReferenceImages.length >= this.maxReferenceImages) {
        //         addMoreArea.style.display = 'none';
        //     } else {
        //         addMoreArea.style.display = 'block';
        //     }
        // }

        // 保存状态
        this.saveCurrentState();
    }

    // 移除指定的批量参考图
    removeBatchReferenceImage(imageId) {
        const index = this.batchReferenceImages.findIndex(img => img.id === imageId);
        if (index > -1) {
            const removedImage = this.batchReferenceImages.splice(index, 1)[0];
            this.updateBatchReferenceImagesPreview();
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.imageRemoved', { name: removedImage.fileName }) : `已移除批量参考图: ${removedImage.fileName}`, 'info');
        }
    }

    // 清空所有批量参考图
    clearAllBatchReferenceImages() {
        this.batchReferenceImages = [];
        this.updateBatchReferenceImagesPreview();
    }

    // 模式切换方法
    switchBatchMode(mode) {
        this.currentBatchMode = mode;
        const cardUI = document.getElementById('cardModeUI');
        const multiUI = document.getElementById('multiModeUI');
        
        // 更新按钮样式
        const cardModeLabel = document.getElementById('cardModeLabel');
        const multiModeLabel = document.getElementById('multiModeLabel');
        
        if (mode === 'card') {
            cardUI?.classList.remove('hidden');
            multiUI?.classList.add('hidden');
            
            // 高亮抽卡模式按钮
            if (cardModeLabel) {
                cardModeLabel.className = 'flex items-center cursor-pointer px-4 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-lg text-white font-medium shadow-md hover:shadow-lg transition-all';
            }
            if (multiModeLabel) {
                multiModeLabel.className = 'flex items-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all';
            }
            
            this.updateCardCostEstimate();
        } else {
            cardUI?.classList.add('hidden');
            multiUI?.classList.remove('hidden');
            
            // 高亮多提示词模式按钮
            if (cardModeLabel) {
                cardModeLabel.className = 'flex items-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all';
            }
            if (multiModeLabel) {
                multiModeLabel.className = 'flex items-center cursor-pointer px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg text-white font-medium shadow-md hover:shadow-lg transition-all';
            }
        }

        // 保存状态
        this.saveCurrentState();
    }

    // 费用预估更新方法
    updateCardCostEstimate() {
        const cardCountSlider = document.getElementById('cardCount');
        const count = parseInt(cardCountSlider?.value || 5);
        const currentModel = window.aiImageAPI?.getCurrentModel();
        
        if (!currentModel) return;
        
        // 提取价格
        const price = this.extractPriceFromModel(currentModel);
        const totalCost = (price * count).toFixed(3);
        
        // 更新滑块进度显示（CSS变量）
        if (cardCountSlider) {
            const min = parseInt(cardCountSlider.min);
            const max = parseInt(cardCountSlider.max);
            const percentage = ((count - min) / (max - min)) * 100;
            cardCountSlider.style.setProperty('--range-progress', `${percentage}%`);
        }
        
        // 更新显示
        const cardCountDisplay = document.getElementById('cardCountDisplay');
        const cardModelName = document.getElementById('cardModelName');
        const cardUnitPrice = document.getElementById('cardUnitPrice');
        const cardQuantity = document.getElementById('cardQuantity');
        const cardTotalCost = document.getElementById('cardTotalCost');
        
        if (cardCountDisplay) cardCountDisplay.textContent = this.i18n ? this.i18n.t('batch.labels.quantityCount', { count }) : `${count} 张`;
        if (cardModelName) cardModelName.textContent = currentModel.name;
        if (cardUnitPrice) cardUnitPrice.textContent = `$${price.toFixed(3)}`;
        if (cardQuantity) cardQuantity.textContent = count;
        if (cardTotalCost) cardTotalCost.textContent = `$${totalCost}`;
    }

    // 从模型配置提取价格
    extractPriceFromModel(model) {
        // 从 displayName 中提取价格，格式：$0.025/张
        const match = model.displayName?.match(/\$([0-9.]+)\/张/);
        return match ? parseFloat(match[1]) : 0;
    }

    // 显示抽卡确认对话框
    showCardConfirmDialog() {
        const prompt = document.getElementById('cardPromptInput')?.value.trim();
        if (!prompt) {
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.promptRequired') : '请输入提示词', 'error');
            return;
        }

        if (!window.aiImageAPI.apiKey) {
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.apiKeyRequired') : '请先设置API Key', 'error');
            this.app.openSettings();
            return;
        }
        
        const count = parseInt(document.getElementById('cardCount')?.value || 5);
        const currentModel = window.aiImageAPI?.getCurrentModel();
        const price = this.extractPriceFromModel(currentModel);
        const totalCost = (price * count).toFixed(3);
        
        // 更新确认对话框内容
        const confirmCardCount = document.getElementById('confirmCardCount');
        const confirmModelName = document.getElementById('confirmModelName');
        const confirmUnitPrice = document.getElementById('confirmUnitPrice');
        const confirmQuantity = document.getElementById('confirmQuantity');
        const confirmCallCount = document.getElementById('confirmCallCount');
        const confirmTotalCost = document.getElementById('confirmTotalCost');
        
        if (confirmCardCount) confirmCardCount.textContent = `${count} 张`;
        if (confirmModelName) confirmModelName.textContent = currentModel.name;
        if (confirmUnitPrice) confirmUnitPrice.textContent = `$${price.toFixed(3)}`;
        if (confirmQuantity) confirmQuantity.textContent = count;
        if (confirmCallCount) confirmCallCount.textContent = count;
        if (confirmTotalCost) confirmTotalCost.textContent = `$${totalCost}`;
        
        // 显示对话框
        document.getElementById('cardConfirmModal')?.classList.remove('hidden');
    }

    // 执行抽卡生成
    async executeCardGeneration() {
        const prompt = document.getElementById('cardPromptInput').value.trim();
        const count = parseInt(document.getElementById('cardCount').value);
        const ratio = document.getElementById('batchRatio').value;
        const concurrency = parseInt(document.getElementById('batchConcurrency').value);
        
        // 获取分辨率（修复：之前缺少这个参数）
        const currentModel = window.aiImageAPI.getCurrentModel();
        const supportsResolution = currentModel.capabilities?.resolutionControl;
        const batchResolutionSelect = document.getElementById('batchResolution');
        const resolution = supportsResolution && batchResolutionSelect ? 
            batchResolutionSelect.value : null;
        
        console.log(`🎰 抽卡生成参数: 模型=${currentModel.name}, 分辨率=${resolution}, 比例=${ratio}, 数量=${count}`);
        
        const batchBtn = document.getElementById('batchGenerateBtn');
        const batchProgress = document.getElementById('batchProgress');
        const batchResults = document.getElementById('batchResults');
        
        this.isBatchGenerating = true;
        this.currentBatchResults = [];
        
        batchBtn.disabled = true;
        batchBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.i18n ? this.i18n.t('batch.progress.cardGenerating') : '抽卡生成中...'}`;
        batchProgress.classList.remove('hidden');
        batchResults.innerHTML = '';
        
        try {
            // 构造N个相同提示词的数组
            const prompts = Array(count).fill(prompt);
            
            let results;
            if (this.batchReferenceImages.length > 0) {
                // 在生成前准备参考图片（执行压缩）
                const preparedImages = await this.prepareReferenceImagesForGeneration();
                results = await window.aiImageAPI.batchGenerateWithReference(
                    prompts, preparedImages, ratio, concurrency, 1, resolution
                );
            } else {
                results = await window.aiImageAPI.batchGenerate(prompts, ratio, concurrency, 1, resolution);
            }
            
            const finalResults = this.currentBatchResults.filter(r => r);
            
            this.app.addToHistory(
                'batch-card',
                `🎰 抽卡生成 ${count} 张`,
                finalResults.filter(r => r.success).flatMap(r => r.urls || []),
                ratio,
                this.batchReferenceImages
            );
            
            const successCount = finalResults.filter(r => r.success).length;
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.cardComplete', { success: successCount, total: count }) : `抽卡完成！成功生成 ${successCount}/${count} 张图片`, 'success');

        } catch (error) {
            this.app.showDetailedError(error, this.i18n ? this.i18n.t('batch.messages.cardGenerationError') : '抽卡生成过程中出现错误');
        } finally {
            this.isBatchGenerating = false;
            batchBtn.disabled = false;
            batchBtn.innerHTML = `<i class="fas fa-layer-group mr-2"></i>${this.i18n ? this.i18n.t('batch.buttons.startGenerate') : '开始批量生成'}`;
            batchProgress.classList.add('hidden');
        }
    }

    // 执行多提示词生成（空行分割）
    async executeMultiPromptGeneration() {
        // 使用空行（\n\n）分割提示词
        const rawText = document.getElementById('batchPrompts').value.trim();
        const prompts = rawText
            .split(/\n\s*\n/)  // 匹配一个或多个空行
            .map(p => p.trim())
            .filter(p => p);
        
        if (prompts.length === 0) {
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.batchPromptsRequired') : '请输入批量提示词', 'error');
            return;
        }

        if (!window.aiImageAPI.apiKey) {
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.apiKeyRequired') : '请先设置API Key', 'error');
            this.app.openSettings();
            return;
        }
        
        const ratio = document.getElementById('batchRatio').value;
        const concurrency = parseInt(document.getElementById('batchConcurrency').value);
        const batchCount = parseInt(document.getElementById('batchCount').value) || 1;

        // 获取当前分辨率（从批量生成页面自己的分辨率选择器获取）
        const currentModel = window.aiImageAPI.getCurrentModel();
        const supportsResolution = currentModel.capabilities?.resolutionControl;
        const batchResolutionSelect = document.getElementById('batchResolution');
        const resolution = supportsResolution && batchResolutionSelect ? 
            batchResolutionSelect.value : null;
        
        // 调试日志：显示分辨率设置
        console.log(`🎨 批量生成参数: 模型=${currentModel.name}, 支持分辨率=${supportsResolution}, 选择分辨率=${resolution}, 比例=${ratio}`);

        const batchBtn = document.getElementById('batchGenerateBtn');
        const batchProgress = document.getElementById('batchProgress');
        const batchResults = document.getElementById('batchResults');

        this.isBatchGenerating = true;
        this.currentBatchResults = [];

        batchBtn.disabled = true;
        batchBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.i18n ? this.i18n.t('batch.progress.batchGenerating') : '批量生成中...'}`;
        batchProgress.classList.remove('hidden');
        batchResults.innerHTML = '';

        try {
            let results;
            if (this.batchReferenceImages.length > 0) {
                // 在生成前准备参考图片（执行压缩）
                const preparedImages = await this.prepareReferenceImagesForGeneration();
                results = await window.aiImageAPI.batchGenerateWithReference(
                    prompts, preparedImages, ratio, concurrency, batchCount, resolution
                );
            } else {
                results = await window.aiImageAPI.batchGenerate(prompts, ratio, concurrency, batchCount, resolution);
            }
            
            const finalResults = this.currentBatchResults.filter(r => r);
            
            this.app.addToHistory(
                this.batchReferenceImages.length > 0 ? 'batch-with-reference' : 'batch',
                `批量生成 ${prompts.length} 个提示词${this.batchReferenceImages.length > 0 ? ` (含${this.batchReferenceImages.length}张参考图)` : ''}`,
                finalResults.filter(r => r.success).flatMap(r => r.urls || []),
                ratio,
                this.batchReferenceImages
            );
            
            const totalImagesGenerated = finalResults.filter(r => r.success).reduce((total, r) => total + (r.urls ? r.urls.length : 0), 0);
            const totalExpected = prompts.length * batchCount;

            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.batchComplete', { success: totalImagesGenerated, total: totalExpected }) : `批量生成完成，成功生成 ${totalImagesGenerated}/${totalExpected} 张图片`, 'success');

        } catch (error) {
            this.app.showDetailedError(error, this.i18n ? this.i18n.t('batch.messages.batchGenerationError') : '批量生成过程中出现错误');
        } finally {
            this.isBatchGenerating = false;
            batchBtn.disabled = false;
            batchBtn.innerHTML = `<i class="fas fa-layer-group mr-2"></i>${this.i18n ? this.i18n.t('batch.buttons.startGenerate') : '开始批量生成'}`;
            batchProgress.classList.add('hidden');
        }
    }

    // 批量生成（入口方法）
    async batchGenerate() {
        if (this.currentBatchMode === 'card') {
            // 抽卡模式：显示确认对话框
            this.showCardConfirmDialog();
        } else {
            // 多提示词模式：直接执行（改用空行分割）
            await this.executeMultiPromptGeneration();
        }
    }


    // 更新批量进度
    updateBatchProgress(detail) {
        const progressBar = document.getElementById('batchProgressBar');
        const progressText = document.getElementById('batchProgressText');

        const percentage = (detail.completed / detail.total) * 100;
        progressBar.style.width = `${percentage}%`;
        
        // 获取数量参数以便正确显示预期生成的图片总数
        const batchCount = parseInt(document.getElementById('batchCount').value) || 1;
        const expectedImages = detail.total * batchCount;
        const completedImages = detail.completed * batchCount;
        
        progressText.textContent = this.i18n ? this.i18n.t('batch.progress.status', {
            currentBatch: detail.currentBatch,
            totalBatches: detail.totalBatches,
            completed: detail.completed,
            total: detail.total,
            completedImages,
            expectedImages
        }) : `正在处理第 ${detail.currentBatch}/${detail.totalBatches} 批，已完成 ${detail.completed}/${detail.total} 个提示词 (预计生成 ${completedImages}/${expectedImages} 张图片)`;
    }

    // 添加单个结果到显示区域（渐进式显示）
    addSingleResult(detail) {
        if (!this.isBatchGenerating) {
            return; // 如果不在批量生成状态，忽略事件
        }

        const container = document.getElementById('batchResults');
        const result = detail.result;
        
        // 添加到结果数组
        this.currentBatchResults[result.index] = result;
        
        // 创建结果卡片
        const resultCard = document.createElement('div');
        resultCard.className = 'bg-white bg-opacity-5 rounded-lg p-4 animate-fade-in';
        resultCard.dataset.index = result.index;

        if (result.success && result.urls && result.urls.length > 0) {
            const imagesText = this.i18n ? this.i18n.t('batch.labels.imageCount', { count: result.urls.length }) : `${result.urls.length}张`;
            const imageCountBadge = result.urls.length > 1 ?
                `<div class="absolute top-2 left-2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded-full">${imagesText}</div>` : '';
            const downloadText = this.i18n ? this.i18n.t('batch.buttons.download') : '下载图片';
            const batchDownloadText = this.i18n ? this.i18n.t('batch.buttons.batchDownload') : '批量下载';
            const viewText = this.i18n ? this.i18n.t('batch.buttons.view') : '查看图片';
            const successText = this.i18n ? this.i18n.t('batch.labels.generateSuccess') : '生成成功';
            const batchAltText = this.i18n ? this.i18n.t('batch.labels.batchGenerateAlt', { index: result.index + 1 }) : `批量生成 ${result.index + 1}`;

            resultCard.innerHTML = `
                <div class="relative group">
                    <img src="${result.urls[0]}" alt="${batchAltText}" class="w-full h-32 object-cover rounded-lg mb-2" loading="lazy">
                    ${imageCountBadge}
                    <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
                        ${result.urls.length === 1 ? `
                            <button onclick="app.downloadImage('${result.urls[0]}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${downloadText}">
                                <i class="fas fa-download"></i>
                            </button>
                        ` : `
                            <button onclick="app.pages.batch.downloadBatchImages(${JSON.stringify(result.urls).replace(/"/g, '&quot;')}, '${result.prompt}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${batchDownloadText}">
                                <i class="fas fa-file-archive"></i>
                            </button>
                        `}
                        <button onclick="app.viewImage(${JSON.stringify(result.urls).replace(/"/g, '&quot;')}, 0)" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${viewText}">
                            <i class="fas fa-expand"></i>
                        </button>
                    </div>
                </div>
                <p class="text-white text-xs truncate">${result.prompt}</p>
                <div class="flex items-center justify-between mt-2">
                    <span class="text-green-400 text-xs">
                        <i class="fas fa-check-circle mr-1"></i>${successText}
                    </span>
                    <span class="text-gray-400 text-xs">#${result.index + 1}</span>
                </div>
            `;
        } else {
            // 获取详细错误信息 - 智能处理各种错误格式
            let errorInfo;
            if (result.error instanceof Error) {
                // 如果是Error对象，直接格式化
                errorInfo = window.aiImageAPI.formatDetailedError(result.error);
            } else if (typeof result.error === 'object' && result.error !== null) {
                // 如果是对象（可能包含detailedError），尝试重构Error对象
                if (result.error.detailedError || result.error.message) {
                    const reconstructedError = new Error(result.error.message || result.errorMessage || '生成失败');
                    reconstructedError.detailedError = result.error.detailedError;
                    reconstructedError.operation = result.error.operation;
                    reconstructedError.parameters = result.error.parameters;
                    errorInfo = window.aiImageAPI.formatDetailedError(reconstructedError);
                } else {
                    // 普通对象，使用默认格式
                    errorInfo = { 
                        title: '生成失败', 
                        message: result.errorMessage || result.error.toString() || '未知错误', 
                        details: [] 
                    };
                }
            } else {
                // 字符串或其他类型
                errorInfo = { 
                    title: '生成失败', 
                    message: result.errorMessage || result.error || '未知错误', 
                    details: [] 
                };
            }
            
            const failedText = this.i18n ? this.i18n.t('batch.labels.generateFailed') : '生成失败';
            const detailsText = this.i18n ? this.i18n.t('batch.buttons.details') : '详情';
            const errorContextText = this.i18n ? this.i18n.t('batch.labels.batchItemError', { index: result.index + 1 }) : `批量项目 #${result.index + 1} 错误详情`;

            resultCard.innerHTML = `
                <div class="h-32 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
                    <i class="fas fa-exclamation-triangle text-red-400"></i>
                    <div class="absolute top-1 right-1 text-gray-400 text-xs">#${result.index + 1}</div>
                </div>
                <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
                <div class="bg-red-600 bg-opacity-20 rounded p-2 mb-2">
                    <p class="text-red-300 text-xs font-medium">${errorInfo.title}</p>
                    <p class="text-red-400 text-xs opacity-90">${errorInfo.message.substring(0, 50)}${errorInfo.message.length > 50 ? '...' : ''}</p>
                </div>
                <div class="flex items-center justify-between">
                    <span class="text-red-400 text-xs">
                        <i class="fas fa-times-circle mr-1"></i>${failedText}
                    </span>
                    <button onclick="window.batchPage.showDetailedBatchError(${result.index}, '${errorContextText}')"
                            class="text-blue-400 hover:text-blue-300 text-xs underline">
                        ${detailsText}
                    </button>
                </div>
            `;
        }

        // 根据索引插入到正确位置
        this.insertResultAtIndex(container, resultCard, result.index);
        
        // 如果生成成功，预加载图片
        if (result.success && result.urls) {
            window.aiImageAPI.preloadImages(result.urls);
        }
    }

    // 显示详细的批量错误信息
    showDetailedBatchError(resultIndex, context) {
        // 从当前结果中查找对应的错误
        const result = this.currentBatchResults[resultIndex];
        if (!result || result.success) {
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.errorNotFound') : '未找到错误信息', 'error');
            return;
        }

        // 重构完整的错误对象
        let errorToShow;
        if (result.error instanceof Error) {
            errorToShow = result.error;
        } else if (typeof result.error === 'object' && result.error !== null) {
            // 重构Error对象
            errorToShow = new Error(result.error.message || result.errorMessage || '生成失败');
            errorToShow.detailedError = result.error.detailedError;
            errorToShow.operation = result.error.operation;
            errorToShow.parameters = result.error.parameters;
        } else {
            // 创建简单的错误对象
            errorToShow = new Error(result.errorMessage || result.error || '生成失败');
            errorToShow.detailedError = {
                status: null,
                statusText: 'Unknown Error',
                url: '',
                method: 'POST',
                errorData: { error: { message: result.errorMessage || result.error || '生成失败' } },
                rawResponse: JSON.stringify({ error: '原始响应不可用' }, null, 2),
                attempt: 1,
                maxRetries: 1,
                timestamp: new Date().toISOString(),
                operation: 'batchGenerate'
            };
        }

        // 显示详细错误
        this.app.showDetailedError(errorToShow, context);
    }

    // 按索引插入结果卡片到正确位置
    insertResultAtIndex(container, newCard, index) {
        const existingCards = Array.from(container.children);
        let insertPosition = 0;
        
        // 找到应该插入的位置
        for (let i = 0; i < existingCards.length; i++) {
            const cardIndex = parseInt(existingCards[i].dataset.index);
            if (cardIndex > index) {
                insertPosition = i;
                break;
            }
            insertPosition = i + 1;
        }
        
        // 插入到正确位置
        if (insertPosition >= existingCards.length) {
            container.appendChild(newCard);
        } else {
            container.insertBefore(newCard, existingCards[insertPosition]);
        }
    }

    // 显示批量结果
    displayBatchResults(results) {
        const container = document.getElementById('batchResults');
        container.innerHTML = '';

        results.forEach((result, index) => {
            const resultCard = document.createElement('div');
            resultCard.className = 'bg-white bg-opacity-5 rounded-lg p-4';

            if (result.success && result.urls && result.urls.length > 0) {
                const imagesText = this.i18n ? this.i18n.t('batch.labels.imageCount', { count: result.urls.length }) : `${result.urls.length}张`;
                const imageCountBadge = result.urls.length > 1 ?
                    `<div class="absolute top-2 left-2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded-full">${imagesText}</div>` : '';
                const downloadText = this.i18n ? this.i18n.t('batch.buttons.download') : '下载图片';
                const batchDownloadText = this.i18n ? this.i18n.t('batch.buttons.batchDownload') : '批量下载';
                const viewText = this.i18n ? this.i18n.t('batch.buttons.view') : '查看图片';
                const batchAltText = this.i18n ? this.i18n.t('batch.labels.batchGenerateAlt', { index: index + 1 }) : `批量生成 ${index + 1}`;

                resultCard.innerHTML = `
                    <div class="relative group">
                        <img src="${result.urls[0]}" alt="${batchAltText}" class="w-full h-32 object-cover rounded-lg mb-2">
                        ${imageCountBadge}
                        <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
                            ${result.urls.length === 1 ? `
                                <button onclick="app.downloadImage('${result.urls[0]}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${downloadText}">
                                    <i class="fas fa-download"></i>
                                </button>
                            ` : `
                                <button onclick="app.pages.batch.downloadBatchImages(${JSON.stringify(result.urls).replace(/"/g, '&quot;')}, '${result.prompt}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${batchDownloadText}">
                                    <i class="fas fa-file-archive"></i>
                                </button>
                            `}
                            <button onclick="app.viewImage(${JSON.stringify(result.urls).replace(/"/g, '&quot;')}, 0)" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${viewText}">
                                <i class="fas fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <p class="text-white text-xs truncate">${result.prompt}</p>
                `;
            } else {
                // 获取详细错误信息
                const failedTitle = this.i18n ? this.i18n.t('batch.labels.generateFailed') : '生成失败';
                const unknownError = this.i18n ? this.i18n.t('batch.messages.unknownError') : '未知错误';
                const viewDetailsText = this.i18n ? this.i18n.t('batch.buttons.viewErrorDetails') : '查看错误详情';
                const batchItemDetailsText = this.i18n ? this.i18n.t('batch.labels.batchItemDetails') : '批量项目详情';
                const errorInfo = result.error instanceof Error ?
                    window.aiImageAPI.formatDetailedError(result.error) :
                    { title: failedTitle, message: result.error || unknownError, details: [] };

                resultCard.innerHTML = `
                    <div class="h-32 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
                        <i class="fas fa-exclamation-triangle text-red-400"></i>
                        <div class="absolute top-1 right-1 text-gray-400 text-xs">#${result.index + 1}</div>
                    </div>
                    <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
                    <div class="bg-red-600 bg-opacity-20 rounded p-2 mb-2">
                        <p class="text-red-300 text-xs font-medium">${errorInfo.title}</p>
                        <p class="text-red-400 text-xs opacity-90">${errorInfo.message.substring(0, 40)}${errorInfo.message.length > 40 ? '...' : ''}</p>
                    </div>
                    <button onclick="app.showDetailedError(${JSON.stringify(result.error || { message: result.error || failedTitle }).replace(/"/g, '&quot;')}, '${batchItemDetailsText}')"
                            class="w-full text-blue-400 hover:text-blue-300 text-xs underline">
                        ${viewDetailsText}
                    </button>
                `;
            }

            container.appendChild(resultCard);
        });
        
        // 预加载批量生成的图片，提升下载速度
        const allUrls = results.filter(r => r.success && r.urls).flatMap(r => r.urls);
        if (allUrls.length > 0) {
            window.aiImageAPI.preloadImages(allUrls);
        }
    }

    // 批量下载某个提示词生成的多张图片
    async downloadBatchImages(urls, prompt) {
        try {
            // 生成文件名：提示词前20个字符 + 时间戳
            const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipFilename = `${promptPrefix}_${timestamp}.zip`;
            
            this.app.showToast(this.i18n ? this.i18n.t('batch.messages.downloadStarting') : '开始批量下载...', 'info');

            const result = await window.aiImageAPI.downloadImagesAsZip(urls, zipFilename, (completed, total) => {
                this.app.showToast(this.i18n ? this.i18n.t('batch.messages.downloading', { completed, total }) : `正在下载 ${completed}/${total}`, 'info');
            }, window.aiImageAPI.model);

            this.app.showToast(result.message || (this.i18n ? this.i18n.t('batch.messages.downloadComplete') : '批量下载完成'), 'success');
        } catch (error) {
            this.app.showToast(error.message, 'error');
            
            // 如果是完全失败，显示帮助提示
            if (error.message.includes('右键图片选择')) {
                this.showDownloadHelpDialog(urls, prompt);
            }
        }
    }

    // 显示下载帮助对话框
    showDownloadHelpDialog(urls, prompt) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4';
        const helpTitle = this.i18n ? this.i18n.t('batch.downloadHelp.title') : '下载帮助';
        const helpWarning = this.i18n ? this.i18n.t('batch.downloadHelp.warning') : '由于浏览器安全限制，无法自动批量下载。';
        const helpInstructions = this.i18n ? this.i18n.t('batch.downloadHelp.instructions') : '请按以下步骤手动下载：';
        const step1 = this.i18n ? this.i18n.t('batch.downloadHelp.step1') : '点击下方"查看图片"按钮';
        const step2 = this.i18n ? this.i18n.t('batch.downloadHelp.step2') : '在图片预览中，右键图片';
        const step3 = this.i18n ? this.i18n.t('batch.downloadHelp.step3') : '选择"图片另存为"';
        const step4 = this.i18n ? this.i18n.t('batch.downloadHelp.step4') : '重复步骤2-3下载所有图片';
        const viewImagesBtn = this.i18n ? this.i18n.t('batch.downloadHelp.viewImages') : '查看图片';
        const gotItBtn = this.i18n ? this.i18n.t('batch.downloadHelp.gotIt') : '知道了';

        modal.innerHTML = `
            <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
                <h3 class="text-xl font-bold mb-4 text-gray-800">
                    <i class="fas fa-question-circle text-blue-500 mr-2"></i>
                    ${helpTitle}
                </h3>
                <div class="space-y-3 text-gray-600 text-sm">
                    <p><strong>${helpWarning}</strong></p>
                    <p>${helpInstructions}</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>${step1}</li>
                        <li>${step2}</li>
                        <li>${step3}</li>
                        <li>${step4}</li>
                    </ol>
                </div>
                <div class="flex space-x-3 mt-6">
                    <button onclick="app.viewImage(${JSON.stringify(urls).replace(/"/g, '&quot;')}, 0)" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
                        <i class="fas fa-eye mr-2"></i>${viewImagesBtn}
                    </button>
                    <button onclick="this.parentElement.parentElement.parentElement.remove()" class="bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
                        ${gotItBtn}
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

    // 模型切换时调用
    onModelChanged() {
        console.log('批量页面：检测到模型切换');
        
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (!currentModel) return;
        
        // 更新最大图片限制
        if (currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }
        
        // 如果是抽卡模式，更新费用预估
        if (this.currentBatchMode === 'card') {
            this.updateCardCostEstimate();
        }
        
        // 如果是Gemini模型，设置默认尺寸为自适应
        const batchRatioSelect = document.getElementById('batchRatio');
        if (batchRatioSelect && currentModel.apiType === 'gemini-native') {
            batchRatioSelect.value = 'auto';
            console.log('批量页面：Gemini模型已设置默认尺寸为自适应');
        }
        
        // 更新参考图预览
        this.updateBatchReferenceImagesPreview();
    }

    // 页面激活时调用
    async onActivate() {
        console.log('批量生成页面已激活');

        // 恢复保存的状态（仅在首次激活或状态未恢复时）
        if (!this.stateRestored && window.pageStateManager) {
            try {
                const savedState = await window.pageStateManager.loadState('batch');
                if (savedState) {
                    this.restoreState(savedState);
                }
            } catch (error) {
                console.error('恢复 BatchPage 状态失败:', error);
            }
        }

        // 根据当前模型更新最大图片限制
        const currentModel = window.aiImageAPI?.getCurrentModel();
        if (currentModel && currentModel.apiType === 'flux-kontext') {
            this.maxReferenceImages = 1;
        } else {
            this.maxReferenceImages = 8;
        }

        // 更新参考图预览
        this.updateBatchReferenceImagesPreview();

        // 根据当前模型更新智能尺寸UI
        this.updateBatchIntelligentResizeIfNeeded();
        
        // 初始化费用预估（抽卡模式）
        if (this.currentBatchMode === 'card') {
            this.updateCardCostEstimate();
        }
        
        // 如果是Gemini模型且状态未恢复，设置默认尺寸为自适应
        const batchRatioSelect = document.getElementById('batchRatio');
        if (batchRatioSelect && currentModel && currentModel.apiType === 'gemini-native' && !this.stateRestored) {
            batchRatioSelect.value = 'auto';
        }
        
        // 清空之前的结果，提供干净的界面（仅在没有内容时）
        const batchResults = document.getElementById('batchResults');
        if (batchResults && !batchResults.innerHTML.trim()) {
            // 如果没有结果，显示提示
            const emptyText = this.i18n ? this.i18n.t('batch.labels.emptyResults') : '批量生成的结果将在这里显示';
            batchResults.innerHTML = `
                <div class="col-span-full text-center text-white opacity-50 py-8">
                    <i class="fas fa-layer-group text-4xl mb-4"></i>
                    <p>${emptyText}</p>
                </div>
            `;
        }
    }

    // 获取批量图片尺寸信息
    async getBatchImageDimensions(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                console.log('📐 获取批量图片尺寸:', file.name, img.width + 'x' + img.height);
                resolve({
                    width: img.width,
                    height: img.height
                });
            };
            img.onerror = () => {
                console.warn('⚠️ 无法获取批量图片尺寸，使用默认值:', file.name);
                resolve({
                    width: 1024,
                    height: 1024
                });
            };
            img.src = URL.createObjectURL(file);
        });
    }

    // 如果需要，更新批量智能尺寸显示
    updateBatchIntelligentResizeIfNeeded() {
        // 检查当前模型是否为gemini智能尺寸模式
        const currentModel = window.aiImageAPI.getCurrentModel();
        const capabilities = currentModel.capabilities || {};
        
        console.log('🔍 检查批量是否需要更新智能尺寸 - 模型:', currentModel.name, '智能尺寸:', capabilities.intelligentResize);
        
        if (capabilities.intelligentResize && this.app) {
            console.log('✅ 批量需要更新智能尺寸，开始执行...');
            // 延迟一下确保DOM已更新
            setTimeout(() => {
                this.app.setupBatchIntelligentResizeMode();
            }, 100);
        } else {
            console.log('❌ 批量不需要更新智能尺寸 - intelligentResize:', capabilities.intelligentResize, 'app:', !!this.app);
        }
    }

    // 智能压缩图片（如果需要）
    async compressImageIfNeeded(file) {
        const MAX_SIZE_MB = 2;
        const fileSizeMB = file.size / (1024 * 1024);

        // 如果文件小于2MB，直接返回原文件
        if (fileSizeMB <= MAX_SIZE_MB) {
            console.log(`文件 ${file.name} 大小为 ${fileSizeMB.toFixed(2)}MB，无需压缩`);
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

            console.log(`⏩ 开始压缩文件: ${file.name}, 原大小: ${fileSizeMB.toFixed(2)}MB`);
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
                this.i18n ? this.i18n.t('batch.messages.compressionFailed', { error: error.message }) : `图片压缩失败，使用原图上传: ${error.message}`,
                'warning',
                3000
            );

            return file;
        }
    }

    // 生成前准备参考图片（执行压缩）
    async prepareReferenceImagesForGeneration() {
        if (this.batchReferenceImages.length === 0) {
            return [];
        }

        const processedImages = [];
        const imagesToCompress = this.batchReferenceImages.filter(img => img.needsCompression);

        console.log(`🖼️ 准备参考图片用于生成...`);
        console.log(`📊 需要压缩的图片: ${imagesToCompress.length}/${this.batchReferenceImages.length}`);

        // 如果有需要压缩的图片，显示统一提示
        let toastId = null;
        let toastRemoved = false;
        const startTime = Date.now();
        const MAX_TOAST_DISPLAY_TIME = 3000; // 最多显示3秒

        if (imagesToCompress.length > 0) {
            const compressingText = this.i18n ? this.i18n.t('batch.messages.compressing', { count: imagesToCompress.length }) : `正在压缩 ${imagesToCompress.length} 张大图片...`;
            const compressionNote = this.i18n ? this.i18n.t('batch.messages.compressionNote') : '大图片自动压缩，不影响生成质量';
            toastId = this.showProgressToast(
                `${compressingText}<br>` +
                `<span class="text-sm opacity-80">${compressionNote}</span>`
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
            for (const imageData of this.batchReferenceImages) {
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
                    this.i18n ? this.i18n.t('batch.messages.compressionComplete', { count: imagesToCompress.length }) : `已压缩 ${imagesToCompress.length} 张图片，开始生成...`,
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

    // 新增：上传进度提示
    showProgressToast(message) {
        const progressId = 'batch-upload-progress-' + Date.now();
        const progressElement = document.createElement('div');
        progressElement.id = progressId;
        progressElement.className = 'fixed top-20 right-4 bg-orange-500 text-white p-4 rounded-lg shadow-lg z-[10001]';
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
        const cardPromptInput = document.getElementById('cardPromptInput');
        const batchPromptsInput = document.getElementById('batchPrompts');
        const cardCountSlider = document.getElementById('cardCount');
        const batchRatioSelect = document.getElementById('batchRatio');
        const batchResolutionSelect = document.getElementById('batchResolution');
        const batchConcurrencySelect = document.getElementById('batchConcurrency');
        const batchCountSelect = document.getElementById('batchCount');

        return {
            mode: this.currentBatchMode,
            cardPrompt: cardPromptInput?.value || '',
            batchPrompts: batchPromptsInput?.value || '',
            cardCount: cardCountSlider?.value || '5',
            batchRatio: batchRatioSelect?.value || 'auto',
            batchResolution: batchResolutionSelect?.value || '2K',
            batchConcurrency: batchConcurrencySelect?.value || '3',
            batchCount: batchCountSelect?.value || '1',
            batchReferenceImages: this.batchReferenceImages.map(img => ({
                base64: img.base64,
                fileName: img.fileName,
                fileSize: img.fileSize,
                mimeType: img.mimeType,
                id: img.id,
                width: img.width,
                height: img.height,
                needsCompression: img.needsCompression
            }))
        };
    }

    /**
     * 恢复页面状态
     * @param {object} state - 页面状态对象
     */
    restoreState(state) {
        if (!state) return;

        console.log('📥 恢复 BatchPage 状态:', state);

        // 恢复模式
        if (state.mode) {
            this.currentBatchMode = state.mode;
            this.switchBatchMode(state.mode);
            // 设置 radio 按钮状态
            const modeRadio = document.querySelector(`input[name="batchMode"][value="${state.mode}"]`);
            if (modeRadio) {
                modeRadio.checked = true;
            }
        }

        // 恢复抽卡模式提示词
        const cardPromptInput = document.getElementById('cardPromptInput');
        if (cardPromptInput && state.cardPrompt) {
            cardPromptInput.value = state.cardPrompt;
        }

        // 恢复多提示词模式内容
        const batchPromptsInput = document.getElementById('batchPrompts');
        if (batchPromptsInput && state.batchPrompts) {
            batchPromptsInput.value = state.batchPrompts;
            this.updatePromptCount();
        }

        // 恢复抽卡数量
        const cardCountSlider = document.getElementById('cardCount');
        if (cardCountSlider && state.cardCount) {
            cardCountSlider.value = state.cardCount;
            this.updateCardCostEstimate();
        }

        // 恢复比例
        const batchRatioSelect = document.getElementById('batchRatio');
        if (batchRatioSelect && state.batchRatio) {
            batchRatioSelect.value = state.batchRatio;
        }

        // 恢复分辨率
        const batchResolutionSelect = document.getElementById('batchResolution');
        if (batchResolutionSelect && state.batchResolution) {
            batchResolutionSelect.value = state.batchResolution;
            this.currentResolution = state.batchResolution;
        }

        // 恢复并发数
        const batchConcurrencySelect = document.getElementById('batchConcurrency');
        if (batchConcurrencySelect && state.batchConcurrency) {
            batchConcurrencySelect.value = state.batchConcurrency;
        }

        // 恢复批量数量
        const batchCountSelect = document.getElementById('batchCount');
        if (batchCountSelect && state.batchCount) {
            batchCountSelect.value = state.batchCount;
        }

        // 恢复参考图（过滤掉没有 base64 的大图）
        if (state.batchReferenceImages && Array.isArray(state.batchReferenceImages)) {
            this.batchReferenceImages = state.batchReferenceImages.filter(img => img && img.base64);
            this.updateBatchReferenceImagesPreview();
        }

        this.stateRestored = true;
    }

    /**
     * 保存当前状态（带防抖）
     */
    saveCurrentState() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveState('batch', state);
        }
    }

    /**
     * 立即保存当前状态
     */
    saveCurrentStateImmediate() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveStateImmediate('batch', state);
        }
    }

    /**
     * 绑定状态自动保存事件
     */
    bindStateAutoSave() {
        // 抽卡模式提示词输入变化时保存
        const cardPromptInput = document.getElementById('cardPromptInput');
        if (cardPromptInput) {
            cardPromptInput.addEventListener('input', () => this.saveCurrentState());
        }

        // 多提示词输入变化时保存
        const batchPromptsInput = document.getElementById('batchPrompts');
        if (batchPromptsInput) {
            batchPromptsInput.addEventListener('input', () => this.saveCurrentState());
        }

        // 抽卡数量变化时保存
        const cardCountSlider = document.getElementById('cardCount');
        if (cardCountSlider) {
            cardCountSlider.addEventListener('input', () => this.saveCurrentState());
        }

        // 比例变化时保存
        const batchRatioSelect = document.getElementById('batchRatio');
        if (batchRatioSelect) {
            batchRatioSelect.addEventListener('change', () => this.saveCurrentState());
        }

        // 分辨率变化时保存
        const batchResolutionSelect = document.getElementById('batchResolution');
        if (batchResolutionSelect) {
            batchResolutionSelect.addEventListener('change', () => this.saveCurrentState());
        }

        // 并发数变化时保存
        const batchConcurrencySelect = document.getElementById('batchConcurrency');
        if (batchConcurrencySelect) {
            batchConcurrencySelect.addEventListener('change', () => this.saveCurrentState());
        }

        // 批量数量变化时保存
        const batchCountSelect = document.getElementById('batchCount');
        if (batchCountSelect) {
            batchCountSelect.addEventListener('change', () => this.saveCurrentState());
        }
    }

    // 页面失活时调用
    onDeactivate() {
        // 保存页面状态
        this.saveCurrentStateImmediate();

        console.log('批量生成页面已失活');
    }
}

// 导出模块
window.BatchPage = BatchPage;
