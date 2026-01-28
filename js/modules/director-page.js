// 导演模式页面模块 - 漫画分镜自动化生成
class DirectorPage {
    constructor(app) {
        this.app = app;
        this.referenceImages = []; // 存储多张参考图片的数据
        this.maxReferenceImages = 8; // 最多8张参考图
        this.isGenerating = false;
        this.isProcessingFiles = false; // 防止重复处理
        this.currentLayout = '6grid'; // 默认6格布局
        this.imageCount = 1; // 出图数量（1-10张）
        this.currentRatio = '3:2'; // 当前图片尺寸
        this.currentResolution = '2K'; // 当前分辨率
        this.currentTemplate = null; // 当前选择的风格模板
        this.generatedResult = null;
        this.generatedResults = []; // 多图结果
        this.currentResultIndex = 0; // 当前显示的结果索引
        this.lastAnalysisResult = null; // 上一次的分析结果（资产）
        this.lastComicPrompt = null; // 上一次的提示词（资产）
        this.currentMode = 'single'; // 当前模式：single / multi
        this.gallerySelectedImages = []; // 示例图库选中的图片
        this.stateRestored = false; // 标记状态是否已恢复

        // 示例图库配置
        this.exampleGalleryCount = 38; // 示例图片总数
        this.exampleGalleryPath = 'assets/templates/'; // 示例图片路径

        // 风格模板库
        this.styleTemplates = {
            anime: {
                name: '动画截图风格',
                prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ',
                suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring',
                negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks'
            },
            manga: {
                name: '漫画分镜风格',
                prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ',
                suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout',
                negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render'
            },
            movie: {
                name: '电影分镜风格',
                prefix: 'cinematic storyboard, film still, movie scene, cinematography, ',
                suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading',
                negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality'
            },
            webtoon: {
                name: '韩漫/条漫风格',
                prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ',
                suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere',
                negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome'
            },
            comic: {
                name: '美漫风格',
                prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ',
                suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene',
                negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading'
            },
            illustration: {
                name: '插画风格',
                prefix: 'illustration, detailed artwork, artistic composition, ',
                suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration',
                negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background'
            }
        };

        // 布局配置
        this.layouts = {
            '6grid': { 
                rows: 2, 
                cols: 3, 
                name: '6格标准', 
                description: '2行×3列，适合完整故事',
                ratio: '3:2'
            },
            '4grid': { 
                rows: 2, 
                cols: 2, 
                name: '4格方正', 
                description: '2行×2列，适合转折场景',
                ratio: '1:1'
            },
            '2closeup': { 
                rows: 1, 
                cols: 2, 
                name: '2格特写', 
                description: '1行×2列，适合表情特写',
                ratio: '16:9'
            },
            '9grid': { 
                rows: 3, 
                cols: 3, 
                name: '9格全景', 
                description: '3行×3列，适合动作场景',
                ratio: '1:1'
            }
        };

        // 完整 Gem 系统提示词（用户原版，不精简）
        this.gemSystemPrompt = `(NanoBananaPro视角裂变专家
:核心角色 "多维视角一致性生成助手 (3x3精简版)"
:目的 "基于用户提供的单张参考图描述，保持视觉锚点绝对不变，通过特定视角的强化组合，生成极具沉浸感的JSON格式英文提示词。"
:作者 "北风诉苦（bailing200215），漫剧自用版 v1.1"
:适配模型 "NanoBananaPro"
;;──────────────────────────────────────────────────────────────────────
;; 核心能力设定
;;──────────────────────────────────────────────────────────────────────
:能力 (
(视觉锁定 "能够精准提取并锁定参考图中的核心元素（人物ID、衣着细节、环境布局、特定光影），确保在分镜中这些描述一字不差或高度一致。"
)

(特定镜头强化 
"侧重于沉浸式和关系视角的构建，重点生成背后、过肩及主观镜头。"
)

(随机排列 
"能够生成高张力的镜头组合，避免平庸的平视镜头。"
)

(格式输出 
"严格遵守NanoBananaPro的JSON格式要求，输出指定布局配置。"
)
)
;;──────────────────────────────────────────────────────────────────────
;; 变量库 (已根据要求调整)
;;──────────────────────────────────────────────────────────────────────
:镜头变量库 (
;; 剔除了常规的 Long, Medium, Close，保留极端的或更有张力的景别

(景别 '( "Extreme Close-up (ECU - Focus on eyes/details)" "Full Body Shot" "Cowboy Shot (Thigh-up)" "Upper Body Shot (Chest-up)" "Wide Angle Full Shot" ))

;; 强调了需要的视角，但保留部分其他视角以供填充剩余空位

(视角 '( "Back View (Walking away/Looking at scenery)" "Over-the-Shoulder (OTS)" "Point of View (POV)" "Low Angle (Heroic)" "High Angle (Vulnerable)" "Dutch Angle (Tilted)" "Top-Down / God's Eye View" ))

(构图 '( "Rule of Thirds" "Center Composition" "Depth of Field (Bokeh)" "Framing within a frame" "Dynamic Diagonal" ))
)
;;──────────────────────────────────────────────────────────────────────
;; 输入与处理
;;──────────────────────────────────────────────────────────────────────
:输入 (
(格式 "用户提供的参考图详细描述 (包含人物、环境、光影)"
)

(处理流程 (

  "1. 【提取锚点】：将用户的描述定义为 [Base_Prompt]，这部分在生成时不可修改。"

  "2. 【权重分配】：根据布局分配视角类型，优先保证：背后视角、过肩视角(OTS)、主观视角(POV)的平衡分布。"

  "3. 【合成Prompt】：Prompt结构 = [Camera_Setup] + [Base_Prompt] + [Quality_Tags] + [Marking_Instructions]。"

  "4. 【JSON封装】：填入shots数组，确保shot_number按顺序编号。"

))
)
;;──────────────────────────────────────────────────────────────────────
;; 约束模块 (硬性规定)
;;──────────────────────────────────────────────────────────────────────
:约束 (
(C1 "一致性绝对优先：无论视角如何变化，人物特征（发型、衣着、面孔）和环境必须保持一致。")

(C2 "视角分布原则：分镜中必须包含多种视角类型，包括背后视角、过肩视角、主观视角等，具体数量根据布局调整。")

(C3 "景别限制：严禁使用 'Medium Shot', 'Long Shot', 'Close-up' 这种平庸的描述。请使用 'Cowboy Shot', 'Extreme Close-up', 'Full Body' 等替代。")

(C4 "格式规范：JSON必须纯净，shots数组必须精确包含指定数量的对象。")

(C5 "文字指令：每个prompt必须包含 '分镜X' in the top-left corner 和 no timecode, no subtitles。")

(C6 "语言：Prompt内容必须为英文。")
)
;;──────────────────────────────────────────────────────────────────────
;; 运行指令
;;──────────────────────────────────────────────────────────────────────
(运行方法 "请根据参考图分析结果和用户描述，自动生成包含指定数量分镜的JSON代码块。")
)`;

        this.init();
    }

    init() {
        this.bindEvents();
        this.bindStateAutoSave();
    }

    // 页面激活时调用
    async onActivate() {
        console.log('导演模式页面已激活');

        // 恢复保存的状态（仅在首次激活或状态未恢复时）
        if (!this.stateRestored && window.pageStateManager) {
            try {
                const savedState = await window.pageStateManager.loadState('director');
                if (savedState) {
                    this.restoreState(savedState);
                }
            } catch (error) {
                console.error('恢复 DirectorPage 状态失败:', error);
            }
        }

        this.updateLayoutSelection();
        // 初始化模式状态
        this.switchMode(this.currentMode);
        this.updateGenerateButtonState();
        
        // 恢复并显示之前的生成结果
        this.restoreResultsDisplay();
    }
    
    // 恢复结果显示
    restoreResultsDisplay() {
        const grid = document.getElementById('directorResultsGrid');
        const emptyState = document.getElementById('directorEmptyState');
        
        // 如果有之前生成的结果，重新显示
        if (this.generatedResults && this.generatedResults.length > 0) {
            console.log('恢复显示之前生成的结果:', this.generatedResults.length, '张');
            
            // 清空网格并重新添加所有结果
            if (grid) {
                grid.innerHTML = '';
                grid.classList.remove('hidden');
            }
            if (emptyState) {
                emptyState.classList.add('hidden');
            }
            
            // 重新添加所有结果卡片
            this.generatedResults.forEach((result, index) => {
                this.addResultCard(result, index);
            });
            
            // 更新计数和下载按钮
            const successCount = this.generatedResults.filter(r => r.success).length;
            this.updateResultsHeader(successCount, this.generatedResults.length);
        } else {
            // 没有结果，显示空状态
            this.showEmptyState();
        }
    }

    // ==================== 状态持久化方法 ====================

    /**
     * 收集当前页面状态
     * @returns {object} 页面状态对象
     */
    collectState() {
        const sceneInput = document.getElementById('directorSceneInput');
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        const imageCountSlider = document.getElementById('directorImageCount');

        return {
            mode: this.currentMode,
            layout: this.currentLayout,
            ratio: this.currentRatio,
            resolution: this.currentResolution,
            template: this.currentTemplate,
            imageCount: imageCountSlider?.value || '1',
            sceneDescription: sceneInput?.value || '',
            multiScenePrompts: multiSceneInput?.value || '',
            referenceImages: this.referenceImages.map(img => ({
                base64: img.base64,
                fileName: img.fileName,
                fileSize: img.fileSize,
                mimeType: img.mimeType
            }))
        };
    }

    /**
     * 恢复页面状态
     * @param {object} state - 页面状态对象
     */
    restoreState(state) {
        if (!state) return;

        console.log('📥 恢复 DirectorPage 状态:', state);

        // 恢复模式
        if (state.mode) {
            this.currentMode = state.mode;
            this.switchMode(state.mode);
            // 设置 radio 按钮状态
            const modeRadio = document.querySelector(`input[name="directorMode"][value="${state.mode}"]`);
            if (modeRadio) {
                modeRadio.checked = true;
            }
        }

        // 恢复布局
        if (state.layout) {
            this.currentLayout = state.layout;
            this.selectLayout(state.layout);
        }

        // 恢复比例
        if (state.ratio) {
            this.currentRatio = state.ratio;
            const ratioSelect = document.getElementById('directorRatio');
            if (ratioSelect) {
                ratioSelect.value = state.ratio;
            }
        }

        // 恢复分辨率
        if (state.resolution) {
            this.currentResolution = state.resolution;
            const resolutionSelect = document.getElementById('directorResolution');
            if (resolutionSelect) {
                resolutionSelect.value = state.resolution;
            }
        }

        // 恢复模板
        if (state.template) {
            this.selectTemplate(state.template);
        }

        // 恢复出图数量
        const imageCountSlider = document.getElementById('directorImageCount');
        if (imageCountSlider && state.imageCount) {
            imageCountSlider.value = state.imageCount;
            this.imageCount = parseInt(state.imageCount);
            this.updateImageCountDisplay();
        }

        // 恢复单场景描述
        const sceneInput = document.getElementById('directorSceneInput');
        if (sceneInput && state.sceneDescription) {
            sceneInput.value = state.sceneDescription;
        }

        // 恢复多场景提示词
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        if (multiSceneInput && state.multiScenePrompts) {
            multiSceneInput.value = state.multiScenePrompts;
            this.updatePromptCount();
        }

        // 恢复参考图（过滤掉没有 base64 的大图）
        if (state.referenceImages && Array.isArray(state.referenceImages)) {
            this.referenceImages = state.referenceImages.filter(img => img && img.base64);
            this.updateReferenceImagesPreview();
        }

        this.stateRestored = true;
    }

    /**
     * 保存当前状态（带防抖）
     */
    saveCurrentState() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveState('director', state);
        }
    }

    /**
     * 立即保存当前状态
     */
    saveCurrentStateImmediate() {
        if (window.pageStateManager) {
            const state = this.collectState();
            window.pageStateManager.saveStateImmediate('director', state);
        }
    }

    /**
     * 绑定状态自动保存事件
     */
    bindStateAutoSave() {
        // 单场景描述输入变化时保存
        const sceneInput = document.getElementById('directorSceneInput');
        if (sceneInput) {
            sceneInput.addEventListener('input', () => this.saveCurrentState());
        }

        // 多场景提示词输入变化时保存
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        if (multiSceneInput) {
            multiSceneInput.addEventListener('input', () => this.saveCurrentState());
        }

        // 出图数量变化时保存
        const imageCountSlider = document.getElementById('directorImageCount');
        if (imageCountSlider) {
            imageCountSlider.addEventListener('input', () => this.saveCurrentState());
        }

        // 比例变化时保存
        const ratioSelect = document.getElementById('directorRatio');
        if (ratioSelect) {
            ratioSelect.addEventListener('change', () => this.saveCurrentState());
        }

        // 分辨率变化时保存
        const resolutionSelect = document.getElementById('directorResolution');
        if (resolutionSelect) {
            resolutionSelect.addEventListener('change', () => this.saveCurrentState());
        }
    }

    // 页面失活时调用
    onDeactivate() {
        // 保存页面状态
        this.saveCurrentStateImmediate();

        console.log('导演模式页面已失活');
    }

    // 语言切换时调用
    onLanguageChange() {
        this.updateLayoutSelection();
    }

    bindEvents() {
        // 上传区域点击事件
        const uploadArea = document.getElementById('directorUploadArea');
        if (uploadArea) {
            uploadArea.addEventListener('click', () => this.triggerFileSelection());
            uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
            uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            uploadArea.addEventListener('drop', (e) => this.handleDrop(e));
        }

        // 清除参考图按钮
        const clearBtn = document.getElementById('directorClearImage');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearReferenceImage());
        }

        // 模式切换事件
        const modeRadios = document.querySelectorAll('input[name="directorMode"]');
        modeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => this.switchMode(e.target.value));
        });

        // 多提示词输入实时计数
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        if (multiSceneInput) {
            multiSceneInput.addEventListener('input', () => this.updatePromptCount());
        }

        // 布局选择事件
        const layoutContainer = document.getElementById('directorLayoutOptions');
        if (layoutContainer) {
            layoutContainer.addEventListener('click', (e) => {
                const card = e.target.closest('.layout-card');
                if (card && card.dataset.layout) {
                    this.selectLayout(card.dataset.layout);
                }
            });
        }

        // 生成按钮事件
        const generateBtn = document.getElementById('directorGenerateBtn');
        if (generateBtn) {
            generateBtn.addEventListener('click', () => this.startGeneration());
        }

        // 下载按钮事件
        const downloadBtn = document.getElementById('directorDownloadBtn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => this.downloadResult());
        }

        // 重新生成按钮
        const regenerateBtn = document.getElementById('directorRegenerateBtn');
        if (regenerateBtn) {
            regenerateBtn.addEventListener('click', () => this.startGeneration());
        }

        // 出图数量滑块事件
        const imageCountSlider = document.getElementById('directorImageCount');
        if (imageCountSlider) {
            imageCountSlider.addEventListener('input', () => this.updateImageCountDisplay());
        }

        // 下载全部按钮
        const downloadAllBtn = document.getElementById('directorDownloadAllBtn');
        if (downloadAllBtn) {
            downloadAllBtn.addEventListener('click', () => this.downloadAllResults());
        }

        // 风格模板相关事件
        const templateBtn = document.getElementById('directorTemplateBtn');
        if (templateBtn) {
            templateBtn.addEventListener('click', () => this.showTemplateModal());
        }
        
        const closeTemplateModalX = document.getElementById('closeTemplateModalX');
        if (closeTemplateModalX) {
            closeTemplateModalX.addEventListener('click', () => this.hideTemplateModal());
        }
        
        const closeTemplateModal = document.getElementById('closeTemplateModal');
        if (closeTemplateModal) {
            closeTemplateModal.addEventListener('click', () => this.hideTemplateModal());
        }
        
        const clearTemplateBtn = document.getElementById('directorClearTemplate');
        if (clearTemplateBtn) {
            clearTemplateBtn.addEventListener('click', () => this.clearTemplate());
        }
        
        // 模板卡片点击事件
        const templateList = document.getElementById('directorTemplateList');
        if (templateList) {
            templateList.addEventListener('click', (e) => {
                const card = e.target.closest('.template-card');
                if (card && card.dataset.template) {
                    this.selectTemplate(card.dataset.template);
                }
            });
        }

        // 图片尺寸选择
        const ratioSelect = document.getElementById('directorRatio');
        if (ratioSelect) {
            ratioSelect.addEventListener('change', (e) => {
                this.currentRatio = e.target.value;
            });
        }

        // 分辨率选择
        const resolutionSelect = document.getElementById('directorResolution');
        if (resolutionSelect) {
            resolutionSelect.addEventListener('change', (e) => {
                this.currentResolution = e.target.value;
            });
        }

        // 示例图库相关事件
        const galleryBtn = document.getElementById('directorExampleGalleryBtn');
        if (galleryBtn) {
            galleryBtn.addEventListener('click', () => this.showGalleryModal());
        }
        
        const closeGalleryModalX = document.getElementById('closeGalleryModalX');
        if (closeGalleryModalX) {
            closeGalleryModalX.addEventListener('click', () => this.hideGalleryModal());
        }
        
        const closeGalleryModal = document.getElementById('closeGalleryModal');
        if (closeGalleryModal) {
            closeGalleryModal.addEventListener('click', () => this.hideGalleryModal());
        }
        
        const confirmGallerySelection = document.getElementById('confirmGallerySelection');
        if (confirmGallerySelection) {
            confirmGallerySelection.addEventListener('click', () => this.confirmGallerySelection());
        }
    }

    // 显示示例图库模态框
    showGalleryModal() {
        const modal = document.getElementById('directorGalleryModal');
        if (modal) {
            modal.classList.remove('hidden');
            this.loadGalleryImages();
        }
    }

    // 隐藏示例图库模态框
    hideGalleryModal() {
        const modal = document.getElementById('directorGalleryModal');
        if (modal) {
            modal.classList.add('hidden');
        }
        this.gallerySelectedImages = [];
        this.updateGallerySelectedCount();
    }

    // 加载示例图库图片
    loadGalleryImages() {
        const grid = document.getElementById('directorGalleryGrid');
        if (!grid) return;
        
        grid.innerHTML = '';
        this.gallerySelectedImages = [];
        this.updateGallerySelectedCount();
        
        for (let i = 1; i <= this.exampleGalleryCount; i++) {
            const imgNum = String(i).padStart(2, '0');
            const imgPath = `${this.exampleGalleryPath}anime-example-${imgNum}.png`;
            
            const card = document.createElement('div');
            card.className = 'gallery-card relative cursor-pointer rounded-lg overflow-hidden border-2 border-transparent hover:border-cyan-400 transition-all';
            card.dataset.imgPath = imgPath;
            card.dataset.index = i;
            
            card.innerHTML = `
                <img src="${imgPath}" alt="示例图 ${i}" class="w-full h-32 object-cover" loading="lazy">
                <div class="gallery-check hidden absolute top-2 right-2 w-6 h-6 bg-cyan-500 rounded-full flex items-center justify-center">
                    <i class="fas fa-check text-white text-xs"></i>
                </div>
            `;
            
            card.addEventListener('click', () => this.toggleGalleryImage(card, imgPath));
            grid.appendChild(card);
        }
    }

    // 切换图库图片选择状态
    toggleGalleryImage(card, imgPath) {
        const index = this.gallerySelectedImages.indexOf(imgPath);
        const checkIcon = card.querySelector('.gallery-check');
        
        if (index > -1) {
            // 取消选择
            this.gallerySelectedImages.splice(index, 1);
            card.classList.remove('border-cyan-500', 'ring-2', 'ring-cyan-400');
            card.classList.add('border-transparent');
            checkIcon?.classList.add('hidden');
        } else {
            // 检查是否超过限制
            if (this.gallerySelectedImages.length >= this.maxReferenceImages) {
                this.app.showToast(`最多只能选择 ${this.maxReferenceImages} 张图片`, 'warning');
                return;
            }
            // 添加选择
            this.gallerySelectedImages.push(imgPath);
            card.classList.add('border-cyan-500', 'ring-2', 'ring-cyan-400');
            card.classList.remove('border-transparent');
            checkIcon?.classList.remove('hidden');
        }
        
        this.updateGallerySelectedCount();
    }

    // 更新选中数量显示
    updateGallerySelectedCount() {
        const countSpan = document.getElementById('gallerySelectedCount');
        if (countSpan) {
            countSpan.textContent = `已选择 ${this.gallerySelectedImages.length} 张`;
        }
    }

    // 确认图库选择
    async confirmGallerySelection() {
        if (this.gallerySelectedImages.length === 0) {
            this.app.showToast('请至少选择一张图片', 'warning');
            return;
        }
        
        // 先保存选中的图片路径，因为 hideGalleryModal 会清空它
        const selectedImages = [...this.gallerySelectedImages];
        
        this.hideGalleryModal();
        this.app.showToast('正在加载示例图片...', 'info');
        
        let successCount = 0;
        const totalSelected = selectedImages.length;
        
        // 加载选中的图片并添加到参考图
        for (const imgPath of selectedImages) {
            try {
                // 直接使用 fetch 获取图片 blob
                const response = await fetch(imgPath);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const blob = await response.blob();
                
                // 将 blob 转换为 base64
                const base64 = await this.blobToBase64(blob);
                
                if (base64 && this.referenceImages.length < this.maxReferenceImages) {
                    this.referenceImages.push({
                        base64: base64,
                        mimeType: blob.type || 'image/png',
                        name: imgPath.split('/').pop(),
                        size: blob.size
                    });
                    successCount++;
                }
            } catch (error) {
                console.error('加载示例图片失败:', imgPath, error);
            }
        }
        
        // 更新预览
        this.updateReferenceImagesPreview();
        this.updateGenerateButtonState();
        
        if (successCount > 0) {
            this.app.showToast(`已添加 ${successCount} 张示例图片`, 'success');
        } else {
            this.app.showToast(`加载示例图片失败，请重试`, 'error');
        }
        // gallerySelectedImages 已在 hideGalleryModal 中清空
    }

    // 将 Blob 转换为 base64
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // reader.result 格式为 "data:image/png;base64,xxxxx"
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // 显示模板选择模态框
    showTemplateModal() {
        const modal = document.getElementById('directorTemplateModal');
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    // 隐藏模板选择模态框
    hideTemplateModal() {
        const modal = document.getElementById('directorTemplateModal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    // 选择模板
    selectTemplate(templateKey) {
        if (!this.styleTemplates[templateKey]) return;
        
        this.currentTemplate = templateKey;
        const template = this.styleTemplates[templateKey];
        
        // 更新显示
        const nameSpan = document.getElementById('directorTemplateName');
        const clearBtn = document.getElementById('directorClearTemplate');
        
        if (nameSpan) {
            nameSpan.textContent = template.name;
            nameSpan.classList.add('text-pink-400');
        }
        if (clearBtn) {
            clearBtn.classList.remove('hidden');
        }
        
        this.hideTemplateModal();
        this.app.showToast(`已选择「${template.name}」模板`, 'success');

        // 保存状态
        this.saveCurrentState();
    }

    // 清除模板
    clearTemplate() {
        this.currentTemplate = null;
        
        const nameSpan = document.getElementById('directorTemplateName');
        const clearBtn = document.getElementById('directorClearTemplate');
        
        if (nameSpan) {
            nameSpan.textContent = '默认（无模板）';
            nameSpan.classList.remove('text-pink-400');
        }
        if (clearBtn) {
            clearBtn.classList.add('hidden');
        }

        // 保存状态
        this.saveCurrentState();
    }

    // 更新出图数量显示
    updateImageCountDisplay() {
        const slider = document.getElementById('directorImageCount');
        const display = document.getElementById('directorCountDisplay');
        if (slider && display) {
            this.imageCount = parseInt(slider.value);
            display.textContent = `${this.imageCount}张`;
        }
    }

    // 切换模式
    switchMode(mode) {
        this.currentMode = mode;
        
        const singleUI = document.getElementById('directorSingleModeUI');
        const multiUI = document.getElementById('directorMultiModeUI');
        const singleLabel = document.getElementById('directorSingleModeLabel');
        const multiLabel = document.getElementById('directorMultiModeLabel');
        const generateBtn = document.getElementById('directorGenerateBtn');
        
        if (mode === 'single') {
            singleUI?.classList.remove('hidden');
            multiUI?.classList.add('hidden');
            
            // 更新按钮样式
            if (singleLabel) {
                singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg text-white font-medium shadow-md transition-all';
            }
            if (multiLabel) {
                multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all';
            }
            
            // 更新生成按钮文字
            if (generateBtn) {
                const btnSpan = generateBtn.querySelector('span');
                if (btnSpan) btnSpan.textContent = '一键生成漫画分镜';
            }
        } else {
            singleUI?.classList.add('hidden');
            multiUI?.classList.remove('hidden');
            
            // 更新按钮样式
            if (singleLabel) {
                singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all';
            }
            if (multiLabel) {
                multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-orange-500 to-pink-500 rounded-lg text-white font-medium shadow-md transition-all';
            }
            
            // 更新生成按钮文字
            if (generateBtn) {
                const btnSpan = generateBtn.querySelector('span');
                if (btnSpan) btnSpan.textContent = '批量生成漫画分镜';
            }
            
            this.updatePromptCount();
        }
        
        this.updateGenerateButtonState();

        // 保存状态
        this.saveCurrentState();
    }

    // 更新提示词计数
    updatePromptCount() {
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        const countSpan = document.getElementById('directorPromptCount');
        
        if (multiSceneInput && countSpan) {
            const prompts = this.parseMultiPrompts(multiSceneInput.value);
            countSpan.textContent = `${prompts.length} 个场景`;
        }
    }

    // 解析多提示词（空行分隔）
    parseMultiPrompts(text) {
        if (!text || !text.trim()) return [];
        
        return text
            .split(/\n\s*\n/)  // 匹配空行
            .map(p => p.trim())
            .filter(p => p.length > 0);
    }

    // 触发文件选择
    triggerFileSelection() {
        if (this.isGenerating || this.isProcessingFiles) return;
        
        if (this.referenceImages.length >= this.maxReferenceImages) {
            this.app.showToast(`最多上传 ${this.maxReferenceImages} 张参考图`, 'warning');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true; // 支持多选
        input.style.display = 'none';

        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                await this.handleMultipleReferenceImageUpload(files);
            }
            input.remove();
        });

        document.body.appendChild(input);
        input.click();
    }

    // 处理拖拽悬停
    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        const uploadArea = document.getElementById('directorUploadArea');
        if (uploadArea) {
            uploadArea.classList.add('drag-over');
        }
    }

    // 处理拖拽离开
    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        const uploadArea = document.getElementById('directorUploadArea');
        if (uploadArea) {
            uploadArea.classList.remove('drag-over');
        }
    }

    // 处理拖拽放置
    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        const uploadArea = document.getElementById('directorUploadArea');
        if (uploadArea) {
            uploadArea.classList.remove('drag-over');
        }

        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length > 0) {
            this.handleMultipleReferenceImageUpload(files);
        }
    }

    // 处理多张参考图上传
    async handleMultipleReferenceImageUpload(files) {
        if (this.isProcessingFiles) {
            console.log('正在处理文件，跳过重复触发');
            return;
        }

        this.isProcessingFiles = true;
        const startTime = Date.now();
        let successCount = 0;

        try {
            // 过滤有效文件
            const validFiles = [];
            for (const file of files) {
                if (!file.type.startsWith('image/')) continue;
                
                // 检查数量限制
                if (this.referenceImages.length + validFiles.length >= this.maxReferenceImages) {
                    this.app.showToast(`最多上传 ${this.maxReferenceImages} 张参考图`, 'warning');
                    break;
                }
                
                // 检查重复文件
                const isDuplicate = this.referenceImages.some(img => img.fileName === file.name && img.fileSize === file.size);
                if (isDuplicate) {
                    this.app.showToast(`文件 ${file.name} 已存在`, 'warning');
                    continue;
                }
                
                validFiles.push(file);
            }

            if (validFiles.length === 0) {
                return;
            }

            // 处理每个文件
            for (const file of validFiles) {
                try {
                    // 压缩图片
                    const compressedFile = await this.compressImage(file);
                    
                    // 转换为 base64
                    const base64 = await this.fileToBase64(compressedFile);
                    
                    // 添加到列表
                    this.referenceImages.push({
                        base64: base64,
                        fileName: file.name,
                        fileSize: file.size,
                        mimeType: file.type || 'image/jpeg',
                        originalFile: compressedFile
                    });
                    
                    successCount++;
                } catch (error) {
                    console.error(`处理文件 ${file.name} 失败:`, error);
                }
            }

            // 更新预览
            this.updateReferenceImagesPreview();
            this.updateGenerateButtonState();

            // 显示成功提示
            const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
            if (successCount > 0) {
                const message = successCount === 1 
                    ? `上传成功 (${processTime}秒)` 
                    : `已上传 ${successCount} 张图片 (${processTime}秒)`;
                this.app.showToast(message, 'success');
            }
        } catch (error) {
            console.error('上传失败:', error);
            this.app.showToast('上传失败: ' + error.message, 'error');
        } finally {
            this.isProcessingFiles = false;
        }
    }

    // 压缩图片
    async compressImage(file) {
        if (typeof imageCompression === 'undefined') {
            console.warn('图片压缩库未加载，使用原图');
            return file;
        }

        const options = {
            maxSizeMB: 2,
            maxWidthOrHeight: 2048,
            useWebWorker: true
        };

        try {
            return await imageCompression(file, options);
        } catch (error) {
            console.warn('压缩失败，使用原图:', error);
            return file;
        }
    }

    // 文件转 base64
    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // 更新参考图预览显示
    updateReferenceImagesPreview() {
        const uploadArea = document.getElementById('directorUploadArea');
        const preview = document.getElementById('directorImagePreview');
        
        if (!preview) return;

        if (this.referenceImages.length === 0) {
            // 没有图片，显示上传区域
            if (uploadArea) uploadArea.classList.remove('hidden');
            preview.classList.add('hidden');
            preview.innerHTML = '';
            return;
        }

        // 有图片，隐藏上传区域，显示预览
        if (uploadArea) uploadArea.classList.add('hidden');
        preview.classList.remove('hidden');

        // 生成图片网格
        let imagesHtml = this.referenceImages.map((img, index) => `
            <div class="relative group aspect-square">
                <img src="data:${img.mimeType || 'image/png'};base64,${img.base64}" 
                     alt="参考图 ${index + 1}" 
                     class="w-full h-full object-cover rounded-lg">
                <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all rounded-lg"></div>
                <button class="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                        onclick="window.directorPage.removeReferenceImage(${index})">
                    <i class="fas fa-times"></i>
                </button>
                <div class="absolute bottom-1 left-1 bg-black bg-opacity-60 rounded px-1.5 py-0.5">
                    <span class="text-white text-xs">${index + 1}</span>
                </div>
            </div>
        `).join('');

        // 添加"添加更多"按钮（如果还没达到上限）
        if (this.referenceImages.length < this.maxReferenceImages) {
            imagesHtml += `
                <div class="aspect-square border-2 border-dashed border-white border-opacity-30 hover:border-opacity-50 rounded-lg cursor-pointer transition-all flex items-center justify-center"
                     onclick="window.directorPage.triggerFileSelection()">
                    <div class="text-center">
                        <i class="fas fa-plus text-white opacity-50 text-xl mb-1"></i>
                        <p class="text-white opacity-50 text-xs">${this.referenceImages.length}/${this.maxReferenceImages}</p>
                    </div>
                </div>
            `;
        }

        preview.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center justify-between">
                    <span class="text-white text-sm opacity-70">
                        <i class="fas fa-images mr-1"></i>
                        参考图 (${this.referenceImages.length}/${this.maxReferenceImages})
                    </span>
                    <button class="text-red-400 hover:text-red-300 text-xs transition-colors"
                            onclick="window.directorPage.clearAllReferenceImages()">
                        <i class="fas fa-trash-alt mr-1"></i>清空全部
                    </button>
                </div>
                <div class="grid grid-cols-4 gap-2">
                    ${imagesHtml}
                </div>
            </div>
        `;

        // 保存状态
        this.saveCurrentState();
    }

    // 移除单张参考图
    removeReferenceImage(index) {
        if (index >= 0 && index < this.referenceImages.length) {
            this.referenceImages.splice(index, 1);
            this.updateReferenceImagesPreview();
            this.updateGenerateButtonState();
        }
    }

    // 清空所有参考图
    clearAllReferenceImages() {
        this.referenceImages = [];
        this.updateReferenceImagesPreview();
        this.updateGenerateButtonState();
    }

    // 兼容旧方法名
    clearReferenceImage() {
        this.clearAllReferenceImages();
    }

    // 选择布局
    selectLayout(layoutKey) {
        if (!this.layouts[layoutKey]) return;

        this.currentLayout = layoutKey;
        this.updateLayoutSelection();

        // 保存状态
        this.saveCurrentState();
    }

    // 更新布局选择UI
    updateLayoutSelection() {
        const cards = document.querySelectorAll('#directorLayoutOptions .layout-card');
        cards.forEach(card => {
            if (card.dataset.layout === this.currentLayout) {
                card.classList.add('ring-2', 'ring-blue-400', 'bg-blue-500', 'bg-opacity-30');
                card.classList.remove('bg-white', 'bg-opacity-10');
            } else {
                card.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-500', 'bg-opacity-30');
                card.classList.add('bg-white', 'bg-opacity-10');
            }
        });
    }

    // 更新生成按钮状态
    updateGenerateButtonState() {
        const btn = document.getElementById('directorGenerateBtn');
        if (btn) {
            if (this.currentMode === 'single') {
                btn.disabled = this.referenceImages.length === 0 || this.isGenerating;
            } else {
                // 多提示词模式：需要有参考图和至少一个提示词
                const multiSceneInput = document.getElementById('directorMultiSceneInput');
                const prompts = this.parseMultiPrompts(multiSceneInput?.value || '');
                btn.disabled = this.referenceImages.length === 0 || prompts.length === 0 || this.isGenerating;
            }
        }
    }

    // 开始生成
    async startGeneration() {
        if (this.referenceImages.length === 0) {
            this.app.showToast('请先上传参考图', 'warning');
            return;
        }

        if (this.isGenerating) {
            this.app.showToast('正在生成中，请稍候', 'warning');
            return;
        }

        // 检查 API Key
        if (!window.aiImageAPI.apiKey) {
            this.app.showToast('请先设置图片生成 API Key', 'error');
            return;
        }

        // 根据模式选择不同的生成流程
        if (this.currentMode === 'multi') {
            await this.startMultiGeneration();
        } else {
            await this.startSingleGeneration();
        }
    }

    // 单图模式生成（支持多张出图）
    async startSingleGeneration() {
        this.isGenerating = true;
        this.updateGenerateButtonState();
        this.generatedResults = [];
        this.currentResultIndex = 0;
        
        // 清空并显示结果区域
        this.clearResultsGrid();
        
        const imageCount = this.imageCount || 1;
        this.showProgress(`正在分析参考图... (将生成 ${imageCount} 张)`);

        try {
            const layout = this.layouts[this.currentLayout];
            const panelCount = layout.rows * layout.cols;
            const sceneDescription = document.getElementById('directorSceneInput')?.value.trim() || '';
            
            // 总步骤：分析1 + 生成提示词1 + 生成图片N
            const totalSteps = 2 + imageCount;
            let currentStep = 0;

            // Step 1: 分析参考图
            currentStep++;
            this.updateProgress(currentStep, totalSteps, '正在分析参考图...');
            const imageAnalysis = await this.analyzeReferenceImage();
            // 显示分析结果
            this.showAnalysisResult(imageAnalysis);

            // Step 2: 生成分镜提示词
            currentStep++;
            this.updateProgress(currentStep, totalSteps, '正在生成分镜提示词...');
            const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout);
            // 显示生成的提示词
            this.showPromptResult(comicPrompt);

            // Step 3-N: 生成多张漫画页面
            let successCount = 0;
            for (let i = 0; i < imageCount; i++) {
                currentStep++;
                this.updateProgress(currentStep, totalSteps, `正在生成第 ${i + 1}/${imageCount} 张漫画...`);
                
                try {
                    const result = await this.generateComicPage(comicPrompt, layout);
                    successCount++;
                    this.generatedResults.push({
                        success: true,
                        imageData: result,
                        prompt: sceneDescription || '自动分析',
                        index: i
                    });
                    // 渐进式显示结果
                    this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i);
                } catch (error) {
                    console.error(`第 ${i + 1} 张生成失败:`, error);
                    this.generatedResults.push({
                        success: false,
                        error: error.message,
                        prompt: sceneDescription || '自动分析',
                        index: i
                    });
                    // 显示失败卡片
                    this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i);
                }
            }

            // 完成
            this.hideProgress();
            this.updateResultsHeader(successCount, imageCount);

            if (successCount > 0) {
                this.app.showToast(`成功生成 ${successCount}/${imageCount} 张漫画页面！`, 'success');
                
                // 保存到历史记录
                try {
                    const successUrls = this.generatedResults
                        .filter(r => r.success)
                        .map(r => r.imageData);
                    
                    this.app.addToHistory(
                        'director',
                        sceneDescription || '导演模式 - 自动分析',
                        successUrls,
                        this.currentRatio,
                        this.referenceImages
                    );
                    console.log('✅ 导演模式结果已保存到历史记录');
                } catch (historyError) {
                    console.error('保存历史记录失败:', historyError);
                }
            } else {
                this.app.showToast('所有图片生成失败，请重试', 'error');
            }
        } catch (error) {
            console.error('生成失败:', error);
            this.app.showToast('生成失败: ' + error.message, 'error');
            this.hideProgress();
        } finally {
            this.isGenerating = false;
            this.updateGenerateButtonState();
        }
    }
    
    // 清空结果网格
    clearResultsGrid() {
        const emptyState = document.getElementById('directorEmptyState');
        const grid = document.getElementById('directorResultsGrid');
        
        // 隐藏空状态，显示网格
        if (emptyState) emptyState.classList.add('hidden');
        if (grid) {
            grid.classList.remove('hidden');
            grid.innerHTML = '';
        }
    }
    
    // 显示空状态
    showEmptyState() {
        const emptyState = document.getElementById('directorEmptyState');
        const grid = document.getElementById('directorResultsGrid');
        
        if (emptyState) emptyState.classList.remove('hidden');
        if (grid) grid.classList.add('hidden');
    }
    
    // 更新结果标题
    updateResultsHeader(successCount, totalCount) {
        const countSpan = document.getElementById('directorResultCount');
        const downloadAllBtn = document.getElementById('directorDownloadAllBtn');
        
        if (countSpan) {
            countSpan.textContent = `成功 ${successCount}/${totalCount} 张`;
        }
        if (downloadAllBtn) {
            if (successCount > 1) {
                downloadAllBtn.classList.remove('hidden');
            } else {
                downloadAllBtn.classList.add('hidden');
            }
        }
    }
    
    // 添加单个结果卡片（渐进式显示）
    addResultCard(result, index) {
        const grid = document.getElementById('directorResultsGrid');
        if (!grid) {
            console.error('❌ directorResultsGrid 元素不存在');
            return;
        }
        
        // 确保结果区域和网格可见
        const resultArea = document.getElementById('directorResultArea');
        if (resultArea) resultArea.classList.remove('hidden');
        grid.classList.remove('hidden');
        const emptyState = document.getElementById('directorEmptyState');
        if (emptyState) emptyState.classList.add('hidden');
        
        console.log('📷 addResultCard:', {
            index,
            success: result.success,
            hasImageData: !!result.imageData,
            imageDataType: typeof result.imageData,
            imageDataPrefix: result.imageData?.substring?.(0, 50)
        });
        
        const card = document.createElement('div');
        card.className = 'bg-white bg-opacity-5 rounded-lg p-4 animate-fade-in';
        card.dataset.index = index;
        
        if (result.success) {
            const imageSrc = this.getImageSrc(result.imageData);
            card.innerHTML = `
                <div class="relative group">
                    <img src="${imageSrc}" alt="漫画分镜 ${index + 1}" class="w-full h-48 object-cover rounded-lg mb-2" loading="lazy">
                    <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center space-x-2">
                        <button onclick="window.directorPage.downloadSingleResult(${index})" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="下载图片">
                            <i class="fas fa-download"></i>
                        </button>
                        <button onclick="window.directorPage.previewResult(${index})" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="查看大图">
                            <i class="fas fa-expand"></i>
                        </button>
                    </div>
                </div>
                <p class="text-white text-xs truncate">${result.prompt}</p>
                <div class="flex items-center justify-between mt-2">
                    <span class="text-green-400 text-xs">
                        <i class="fas fa-check-circle mr-1"></i>生成成功
                    </span>
                    <span class="text-gray-400 text-xs">#${index + 1}</span>
                </div>
            `;
        } else {
            card.innerHTML = `
                <div class="h-48 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
                    <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
                    <div class="absolute top-1 right-1 text-gray-400 text-xs">#${index + 1}</div>
                </div>
                <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
                <div class="bg-red-600 bg-opacity-20 rounded p-2">
                    <p class="text-red-300 text-xs">${result.error || '生成失败'}</p>
                </div>
            `;
        }
        
        grid.appendChild(card);
    }
    
    // 下载单张结果
    downloadSingleResult(index) {
        const result = this.generatedResults[index];
        if (!result || !result.success) return;
        
        const imageSrc = this.getImageSrc(result.imageData);
        const filename = `comic-panel-${index + 1}-${Date.now()}.png`;
        this.downloadImage(imageSrc, filename);
    }
    
    // 预览单张结果
    previewResult(index) {
        const result = this.generatedResults[index];
        if (!result || !result.success) return;
        
        const imageSrc = this.getImageSrc(result.imageData);
        // 使用 app 的查看图片功能
        if (this.app.viewImage) {
            this.app.viewImage([imageSrc], 0);
        } else {
            window.open(imageSrc, '_blank');
        }
    }
    
    // 下载全部成功结果
    downloadAllResults() {
        const successResults = this.generatedResults.filter(r => r.success);
        if (successResults.length === 0) {
            this.app.showToast('没有可下载的图片', 'warning');
            return;
        }
        
        this.app.showToast(`开始下载 ${successResults.length} 张图片...`, 'info');
        
        successResults.forEach((result, i) => {
            setTimeout(() => {
                const imageSrc = this.getImageSrc(result.imageData);
                const filename = `comic-panel-${result.index + 1}-${Date.now()}.png`;
                this.downloadImage(imageSrc, filename);
            }, i * 500); // 每张间隔500ms
        });
    }

    // 多提示词模式批量生成
    async startMultiGeneration() {
        const multiSceneInput = document.getElementById('directorMultiSceneInput');
        const prompts = this.parseMultiPrompts(multiSceneInput?.value || '');
        
        if (prompts.length === 0) {
            this.app.showToast('请输入至少一个场景描述', 'warning');
            return;
        }

        this.isGenerating = true;
        this.updateGenerateButtonState();
        this.generatedResults = [];
        this.currentResultIndex = 0;
        
        // 清空并显示结果区域
        this.clearResultsGrid();

        const layout = this.layouts[this.currentLayout];
        const panelCount = layout.rows * layout.cols;
        const totalSteps = prompts.length * 2 + 1; // 分析1次 + 每个场景2步（提示词+生成）
        let currentStep = 0;
        let successCount = 0;

        try {
            // Step 1: 分析参考图（只需一次）
            this.showProgress('正在分析参考图...');
            currentStep++;
            this.updateProgress(currentStep, totalSteps, '正在分析参考图...');
            const imageAnalysis = await this.analyzeReferenceImage();
            // 显示分析结果
            this.showAnalysisResult(imageAnalysis);

            // 为每个提示词生成漫画页面
            for (let i = 0; i < prompts.length; i++) {
                const sceneDescription = prompts[i];
                
                // 生成分镜提示词
                currentStep++;
                this.updateProgress(currentStep, totalSteps, `生成第 ${i + 1}/${prompts.length} 张：构建提示词...`);
                const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout);
                // 显示当前场景的提示词（多场景模式下会更新显示）
                this.showPromptResult(comicPrompt);

                // 生成漫画页面
                currentStep++;
                this.updateProgress(currentStep, totalSteps, `生成第 ${i + 1}/${prompts.length} 张：生成图片...`);
                
                try {
                    const result = await this.generateComicPage(comicPrompt, layout);
                    successCount++;
                    const resultItem = {
                        success: true,
                        imageData: result,
                        prompt: sceneDescription,
                        index: i
                    };
                    this.generatedResults.push(resultItem);
                    // 渐进式显示结果
                    this.addResultCard(resultItem, i);
                } catch (error) {
                    console.error(`第 ${i + 1} 张生成失败:`, error);
                    const resultItem = {
                        success: false,
                        error: error.message,
                        prompt: sceneDescription,
                        index: i
                    };
                    this.generatedResults.push(resultItem);
                    // 显示失败卡片
                    this.addResultCard(resultItem, i);
                }
            }

            // 完成
            this.hideProgress();
            this.updateResultsHeader(successCount, prompts.length);

            if (successCount > 0) {
                this.app.showToast(`批量生成完成！成功 ${successCount}/${prompts.length} 张`, 'success');
                
                // 保存到历史记录
                try {
                    const successUrls = this.generatedResults
                        .filter(r => r.success)
                        .map(r => r.imageData);
                    
                    this.app.addToHistory(
                        'director-batch',
                        `导演模式批量 - ${prompts.length} 个场景`,
                        successUrls,
                        this.currentRatio,
                        this.referenceImages
                    );
                    console.log('✅ 导演模式批量结果已保存到历史记录');
                } catch (historyError) {
                    console.error('保存历史记录失败:', historyError);
                }
            } else {
                this.app.showToast('所有图片生成失败，请重试', 'error');
            }
        } catch (error) {
            console.error('批量生成失败:', error);
            this.app.showToast('批量生成失败: ' + error.message, 'error');
            this.hideProgress();
        } finally {
            this.isGenerating = false;
            this.updateGenerateButtonState();
        }
    }

    // 分析参考图
    async analyzeReferenceImage() {
        if (!window.aiImageAPI.visionApiKey) {
            // 如果没有设置图像理解 API Key，使用用户输入的描述或默认描述
            const sceneInput = document.getElementById('directorSceneInput')?.value.trim();
            if (sceneInput) {
                return sceneInput;
            }
            return '请详细描述图片中的场景、人物、环境和氛围。';
        }

        // 准备所有参考图用于分析
        const images = this.referenceImages.map(img => ({
            base64: img.base64,
            mimeType: img.mimeType || 'image/jpeg'
        }));

        const imageCount = images.length;
        const analysisPrompt = imageCount > 1 
            ? `请详细分析这${imageCount}张参考图片，包括：
1. 人物特征（面部特征、发型、衣着、姿态）
2. 场景环境（地点、光线、氛围）
3. 画面构图和视角
4. 色调和风格
5. 各图片之间的关联性和风格一致性

请用简洁的英文描述，以便后续生成分镜使用。`
            : `请详细分析这张图片，包括：
1. 人物特征（面部特征、发型、衣着、姿态）
2. 场景环境（地点、光线、氛围）
3. 画面构图和视角
4. 色调和风格

请用简洁的英文描述，以便后续生成分镜使用。`;

        return new Promise((resolve, reject) => {
            let result = '';
            
            window.aiImageAPI.analyzeImagesStream(
                images,
                analysisPrompt,
                'gemini-2.0-flash',
                null,
                (chunk) => {
                    result += chunk;
                },
                () => {
                    resolve(result);
                },
                (error) => {
                    // 如果分析失败，返回用户输入的描述
                    const sceneInput = document.getElementById('directorSceneInput')?.value.trim();
                    if (sceneInput) {
                        resolve(sceneInput);
                    } else {
                        reject(error);
                    }
                }
            );
        });
    }

    // 生成分镜提示词
    async generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout) {
        const userDescription = sceneDescription || imageAnalysis;
        
        // 根据布局生成视角分配
        const viewAngles = this.generateViewAngles(panelCount);
        
        // 获取当前模板的提示词
        let templatePrefix = '';
        let templateSuffix = '';
        let templateNegative = '';
        
        if (this.currentTemplate && this.styleTemplates[this.currentTemplate]) {
            const template = this.styleTemplates[this.currentTemplate];
            templatePrefix = template.prefix;
            templateSuffix = template.suffix;
            templateNegative = template.negative;
        }
        
        // 构建漫画页面提示词
        let panelPrompts = [];
        for (let i = 0; i < panelCount; i++) {
            panelPrompts.push(`Panel ${i + 1}: ${viewAngles[i]}, ${userDescription}`);
        }

        let comicPrompt = `${templatePrefix}Create a single comic page image with ${panelCount} panels arranged in a ${layout.rows}x${layout.cols} grid layout.

Art Style: Maintain consistent art style throughout all panels. Professional manga/comic quality.

Panel Descriptions:
${panelPrompts.join('\n')}

Important Instructions:
- Each panel should have '分镜${'{'}i+1${'}'}' label in the top-left corner
- No speech bubbles, no dialogue text
- No timecode, no subtitles
- Consistent character appearance across all panels
- Clear panel borders with slight gaps between panels
- Cinematic lighting and composition
- High detail and quality rendering

Reference Image Analysis:
${imageAnalysis}

User Scene Description:
${sceneDescription || 'Based on reference image'}${templateSuffix}`;

        // 如果有负面提示词，添加到提示词末尾
        if (templateNegative) {
            comicPrompt += `\n\nNegative prompt (avoid these): ${templateNegative}`;
        }

        return comicPrompt;
    }

    // 生成视角分配
    generateViewAngles(panelCount) {
        const viewTypes = [
            'Over-the-Shoulder (OTS) shot',
            'Back View shot',
            'Point of View (POV) shot',
            'Extreme Close-up (ECU) on face/eyes',
            'Cowboy Shot (thigh-up)',
            'Full Body Shot',
            'Low Angle (heroic) shot',
            'High Angle (vulnerable) shot',
            'Dutch Angle (tilted) shot',
            'Upper Body Shot (chest-up)'
        ];

        // 确保视角多样性
        const angles = [];
        const requiredAngles = [
            'Over-the-Shoulder (OTS) shot',
            'Back View shot',
            'Point of View (POV) shot'
        ];

        // 先添加必要的视角
        for (let i = 0; i < Math.min(requiredAngles.length, panelCount); i++) {
            angles.push(requiredAngles[i]);
        }

        // 随机填充剩余
        while (angles.length < panelCount) {
            const randomIndex = Math.floor(Math.random() * viewTypes.length);
            angles.push(viewTypes[randomIndex]);
        }

        // 打乱顺序
        for (let i = angles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [angles[i], angles[j]] = [angles[j], angles[i]];
        }

        return angles;
    }

    // 生成漫画页面
    async generateComicPage(prompt, layout) {
        // 准备所有参考图
        const preparedImages = this.referenceImages.map(img => ({
            base64: img.base64,
            mimeType: img.mimeType || 'image/jpeg'
        }));

        // 使用用户选择的尺寸，如果是 auto 则使用布局默认
        const ratio = this.currentRatio === 'auto' ? layout.ratio : this.currentRatio;

        const result = await window.aiImageAPI.generateImageWithReference(
            prompt,
            preparedImages,
            ratio,
            1,  // 生成1张
            this.currentResolution // 使用用户选择的分辨率
        );

        // 调试日志：查看 API 返回结构
        console.log('📷 generateComicPage result:', {
            success: result.success,
            hasUrls: !!result.urls,
            urlsLength: result.urls?.length,
            hasImages: !!result.images,
            imagesLength: result.images?.length,
            error: result.error,
            allKeys: Object.keys(result)
        });

        // API 返回的是 urls 属性，不是 images
        if (result.success && result.urls && result.urls.length > 0) {
            return result.urls[0];
        } else {
            throw new Error(result.error || '生成失败');
        }
    }

    // 显示进度
    showProgress(message) {
        const progressArea = document.getElementById('directorProgressArea');
        const resultArea = document.getElementById('directorResultArea');
        
        // 获取国际化文本
        const i18n = window.i18n;
        const analysisTitle = i18n?.t('director.progress.analysisTitle') || '参考图分析结果';
        const promptTitle = i18n?.t('director.progress.promptTitle') || '生成的提示词';
        const clickToView = i18n?.t('director.assets.clickToView') || '点击查看';
        
        if (progressArea) {
            progressArea.classList.remove('hidden');
            progressArea.innerHTML = `
                <div class="text-center py-8">
                    <div class="relative inline-block mb-4">
                        <i class="fas fa-film text-6xl text-white opacity-30 animate-pulse"></i>
                    </div>
                    <p class="text-white text-lg mb-2" id="directorProgressText">${message}</p>
                    <div class="w-64 h-2 bg-white bg-opacity-20 rounded-full mx-auto overflow-hidden">
                        <div id="directorProgressBar" class="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full transition-all duration-500" style="width: 0%"></div>
                    </div>
                    <p class="text-white opacity-50 text-sm mt-2" id="directorProgressStep">步骤 1/4</p>
                    
                    <!-- 资产面板容器（点击打开弹窗） -->
                    <div class="mt-6 max-w-lg mx-auto space-y-3">
                        <!-- 分析结果面板 -->
                        <div id="directorAnalysisPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                             onclick="window.directorPage.showAssetModal('analysis')">
                            <div class="flex justify-between items-center p-3">
                                <span class="text-white text-sm font-medium flex items-center">
                                    <i class="fas fa-search-plus mr-2 text-blue-400"></i>
                                    ${analysisTitle}
                                </span>
                                <div class="flex items-center space-x-2">
                                    <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                                    <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 提示词面板 -->
                        <div id="directorPromptPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                             onclick="window.directorPage.showAssetModal('prompt')">
                            <div class="flex justify-between items-center p-3">
                                <span class="text-white text-sm font-medium flex items-center">
                                    <i class="fas fa-magic mr-2 text-purple-400"></i>
                                    ${promptTitle}
                                </span>
                                <div class="flex items-center space-x-2">
                                    <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                                    <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        if (resultArea) {
            resultArea.classList.add('hidden');
        }
    }

    // 更新进度
    updateProgress(current, total, message) {
        const progressText = document.getElementById('directorProgressText');
        const progressBar = document.getElementById('directorProgressBar');
        const progressStep = document.getElementById('directorProgressStep');

        if (progressText) progressText.textContent = message;
        if (progressBar) progressBar.style.width = `${(current / total) * 100}%`;
        if (progressStep) progressStep.textContent = `步骤 ${current}/${total}`;
    }

    // 隐藏进度
    hideProgress() {
        const progressArea = document.getElementById('directorProgressArea');
        const resultArea = document.getElementById('directorResultArea');
        
        if (progressArea) {
            progressArea.classList.add('hidden');
        }
        
        // 修复：恢复结果区域的可见性（showProgress 会隐藏它）
        if (resultArea) {
            resultArea.classList.remove('hidden');
        }
        
        // 渲染资产区域（分析结果和提示词卡片）
        this.renderAssetsSection();
    }

    // 渲染资产卡片区（在结果区域显示分析结果和提示词）
    renderAssetsSection() {
        const assetsSection = document.getElementById('directorAssetsSection');
        if (!assetsSection) {
            console.warn('[DirectorPage] 资产区域元素不存在');
            return;
        }
        
        // 如果没有任何资产数据，隐藏区域
        if (!this.lastAnalysisResult && !this.lastComicPrompt) {
            assetsSection.classList.add('hidden');
            return;
        }
        
        const i18n = window.i18n;
        const analysisTitle = i18n?.t('director.assets.analysisCard') || '图像分析';
        const promptTitle = i18n?.t('director.assets.promptCard') || '生成提示词';
        const clickToView = i18n?.t('director.assets.clickToView') || '点击查看';
        
        let html = '';
        
        // 分析结果卡片（点击打开弹窗）
        if (this.lastAnalysisResult) {
            html += `
                <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
                     onclick="window.directorPage.showAssetModal('analysis')">
                    <div class="flex justify-between items-center p-3">
                        <span class="text-white text-sm font-medium flex items-center">
                            <i class="fas fa-search-plus mr-2 text-blue-400"></i>
                            ${analysisTitle}
                        </span>
                        <div class="flex items-center space-x-2">
                            <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                            <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 提示词卡片（点击打开弹窗）
        if (this.lastComicPrompt) {
            html += `
                <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
                     onclick="window.directorPage.showAssetModal('prompt')">
                    <div class="flex justify-between items-center p-3">
                        <span class="text-white text-sm font-medium flex items-center">
                            <i class="fas fa-magic mr-2 text-purple-400"></i>
                            ${promptTitle}
                        </span>
                        <div class="flex items-center space-x-2">
                            <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                            <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                        </div>
                    </div>
                </div>
            `;
        }
        
        assetsSection.innerHTML = html;
        assetsSection.classList.remove('hidden');
        
        console.log('[DirectorPage] 资产区域已渲染:', {
            hasAnalysis: !!this.lastAnalysisResult,
            hasPrompt: !!this.lastComicPrompt
        });
    }

    // 切换资产面板展开/折叠（结果区域的卡片）
    toggleAssetPanel(panelType) {
        const contentId = panelType === 'analysis' ? 'directorAssetAnalysisContent' : 'directorAssetPromptContent';
        const arrowId = panelType === 'analysis' ? 'directorAssetAnalysisArrow' : 'directorAssetPromptArrow';
        
        const content = document.getElementById(contentId);
        const arrow = document.getElementById(arrowId);
        
        if (!content || !arrow) {
            console.warn('[DirectorPage] 资产面板元素不存在:', panelType);
            return;
        }
        
        const isExpanded = content.classList.contains('max-h-64');
        
        if (isExpanded) {
            // 收起
            content.classList.remove('max-h-64');
            content.classList.add('max-h-0');
            arrow.style.transform = 'rotate(0deg)';
        } else {
            // 展开
            content.classList.remove('max-h-0');
            content.classList.add('max-h-64');
            arrow.style.transform = 'rotate(180deg)';
        }
    }

    // HTML 转义（防止 XSS）
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 显示资产弹窗
    showAssetModal(type) {
        const modal = document.getElementById('directorAssetModal');
        const titleIcon = document.getElementById('assetModalIcon');
        const titleText = document.getElementById('assetModalTitleText');
        const content = document.getElementById('assetModalContent');
        
        if (!modal || !content) {
            console.warn('[DirectorPage] 资产弹窗元素不存在');
            return;
        }
        
        const i18n = window.i18n;
        
        // 设置当前显示的资产类型
        this.currentModalType = type;
        
        if (type === 'analysis') {
            titleIcon.className = 'fas fa-search-plus mr-2 text-blue-400';
            titleText.textContent = i18n?.t('director.assets.analysisCard') || '图像分析';
            content.textContent = this.lastAnalysisResult || (i18n?.t('director.progress.noAnalysis') || '未进行图像分析');
        } else if (type === 'prompt') {
            titleIcon.className = 'fas fa-magic mr-2 text-purple-400';
            titleText.textContent = i18n?.t('director.assets.promptCard') || '生成提示词';
            content.textContent = this.lastComicPrompt || '';
        }
        
        // 显示弹窗
        modal.classList.remove('hidden');
        
        // 添加 ESC 键关闭
        this._modalEscHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeAssetModal();
            }
        };
        document.addEventListener('keydown', this._modalEscHandler);
        
        // 点击背景关闭
        modal.onclick = (e) => {
            if (e.target === modal) {
                this.closeAssetModal();
            }
        };
        
        console.log('[DirectorPage] 打开资产弹窗:', type);
    }

    // 关闭资产弹窗
    closeAssetModal() {
        const modal = document.getElementById('directorAssetModal');
        if (modal) {
            modal.classList.add('hidden');
        }
        
        // 移除 ESC 键监听
        if (this._modalEscHandler) {
            document.removeEventListener('keydown', this._modalEscHandler);
            this._modalEscHandler = null;
        }
        
        console.log('[DirectorPage] 关闭资产弹窗');
    }

    // 复制弹窗内容
    async copyModalContent() {
        const content = this.currentModalType === 'analysis' 
            ? this.lastAnalysisResult 
            : this.lastComicPrompt;
        
        if (!content) {
            this.app.showToast('没有可复制的内容', 'warning');
            return;
        }
        
        try {
            await navigator.clipboard.writeText(content);
            const i18n = window.i18n;
            const successMsg = i18n?.t('director.assets.copySuccess') || '已复制到剪贴板';
            this.app.showToast(successMsg, 'success');
            
            // 按钮图标动画反馈
            const copyBtn = document.getElementById('assetModalCopyBtn');
            if (copyBtn) {
                const icon = copyBtn.querySelector('i');
                if (icon) {
                    icon.classList.remove('fa-copy');
                    icon.classList.add('fa-check');
                    setTimeout(() => {
                        icon.classList.remove('fa-check');
                        icon.classList.add('fa-copy');
                    }, 1500);
                }
            }
        } catch (error) {
            console.error('复制失败:', error);
            const i18n = window.i18n;
            const failMsg = i18n?.t('director.assets.copyFailed') || '复制失败';
            this.app.showToast(failMsg, 'error');
        }
    }

    // 显示分析结果
    showAnalysisResult(text) {
        // 存储分析结果到实例属性（作为资产保留）
        this.lastAnalysisResult = text;
        
        const panel = document.getElementById('directorAnalysisPanel');
        
        if (!panel) {
            console.warn('[DirectorPage] 分析结果面板元素不存在');
            return;
        }
        
        panel.classList.remove('hidden');
        
        // 添加淡入动画
        panel.style.opacity = '0';
        requestAnimationFrame(() => {
            panel.style.transition = 'opacity 0.3s ease-out';
            panel.style.opacity = '1';
        });
        
        console.log('[DirectorPage] 显示分析结果面板（点击查看完整内容）');
    }

    // 显示提示词结果
    showPromptResult(text) {
        // 存储提示词到实例属性（作为资产保留）
        this.lastComicPrompt = text;
        
        const panel = document.getElementById('directorPromptPanel');
        
        if (!panel) {
            console.warn('[DirectorPage] 提示词面板元素不存在');
            return;
        }
        
        panel.classList.remove('hidden');
        
        // 添加淡入动画
        panel.style.opacity = '0';
        requestAnimationFrame(() => {
            panel.style.transition = 'opacity 0.3s ease-out';
            panel.style.opacity = '1';
        });
        
        console.log('[DirectorPage] 显示提示词面板（点击查看完整内容）');
    }

    // 切换面板展开/折叠
    togglePanel(panelType) {
        const contentId = panelType === 'analysis' ? 'directorAnalysisContent' : 'directorPromptContent';
        const arrowId = panelType === 'analysis' ? 'directorAnalysisArrow' : 'directorPromptArrow';
        
        const content = document.getElementById(contentId);
        const arrow = document.getElementById(arrowId);
        
        if (!content || !arrow) {
            console.warn('[DirectorPage] 面板元素不存在:', panelType);
            return;
        }
        
        const isExpanded = content.classList.contains('max-h-48');
        
        if (isExpanded) {
            // 收起
            content.classList.remove('max-h-48');
            content.classList.add('max-h-0');
            arrow.style.transform = 'rotate(0deg)';
        } else {
            // 展开
            content.classList.remove('max-h-0');
            content.classList.add('max-h-48');
            arrow.style.transform = 'rotate(180deg)';
        }
        
        console.log('[DirectorPage] 切换面板:', panelType, isExpanded ? '收起' : '展开');
    }

    // 复制分析结果到剪贴板
    async copyAnalysis(buttonEl) {
        if (!this.lastAnalysisResult) {
            this.app.showToast('没有可复制的分析结果', 'warning');
            return;
        }
        
        try {
            await navigator.clipboard.writeText(this.lastAnalysisResult);
            const i18n = window.i18n;
            const successMsg = i18n?.t('director.assets.copySuccess') || '已复制到剪贴板';
            this.app.showToast(successMsg, 'success');
            
            // 按钮图标动画反馈
            if (buttonEl) {
                const icon = buttonEl.querySelector('i');
                if (icon) {
                    icon.classList.remove('fa-copy');
                    icon.classList.add('fa-check');
                    setTimeout(() => {
                        icon.classList.remove('fa-check');
                        icon.classList.add('fa-copy');
                    }, 1500);
                }
            }
        } catch (error) {
            console.error('复制失败:', error);
            const i18n = window.i18n;
            const failMsg = i18n?.t('director.assets.copyFailed') || '复制失败';
            this.app.showToast(failMsg, 'error');
        }
    }

    // 复制提示词到剪贴板
    async copyPrompt(buttonEl) {
        if (!this.lastComicPrompt) {
            this.app.showToast('没有可复制的提示词', 'warning');
            return;
        }
        
        try {
            await navigator.clipboard.writeText(this.lastComicPrompt);
            const i18n = window.i18n;
            const successMsg = i18n?.t('director.assets.copySuccess') || '已复制到剪贴板';
            this.app.showToast(successMsg, 'success');
            
            // 按钮图标动画反馈
            if (buttonEl) {
                const icon = buttonEl.querySelector('i');
                if (icon) {
                    icon.classList.remove('fa-copy');
                    icon.classList.add('fa-check');
                    setTimeout(() => {
                        icon.classList.remove('fa-check');
                        icon.classList.add('fa-copy');
                    }, 1500);
                }
            }
        } catch (error) {
            console.error('复制失败:', error);
            const i18n = window.i18n;
            const failMsg = i18n?.t('director.assets.copyFailed') || '复制失败';
            this.app.showToast(failMsg, 'error');
        }
    }

    // 显示结果（单图模式）
    showResult(imageData) {
        const progressArea = document.getElementById('directorProgressArea');
        const resultArea = document.getElementById('directorResultArea');

        if (progressArea) progressArea.classList.add('hidden');

        if (resultArea) {
            resultArea.classList.remove('hidden');
            
            let imageSrc = this.getImageSrc(imageData);

            resultArea.innerHTML = `
                <div class="space-y-4">
                    <div class="relative group">
                        <img src="${imageSrc}" 
                             alt="生成的漫画页面" 
                             class="w-full rounded-lg shadow-lg cursor-pointer"
                             onclick="window.directorPage.previewImage(this.src)">
                        <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
                            <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
                        </div>
                    </div>
                    <div class="flex justify-center space-x-4">
                        <button id="directorDownloadBtn" 
                                class="px-6 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors">
                            <i class="fas fa-download mr-2"></i>下载图片
                        </button>
                        <button id="directorRegenerateBtn" 
                                class="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors">
                            <i class="fas fa-redo mr-2"></i>重新生成
                        </button>
                    </div>
                </div>
            `;

            // 重新绑定按钮事件
            document.getElementById('directorDownloadBtn')?.addEventListener('click', () => this.downloadResult());
            document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration());
        }
    }

    // 获取图片源
    getImageSrc(imageData) {
        if (!imageData) return '';
        if (imageData.startsWith('data:')) {
            return imageData;
        } else if (imageData.startsWith('http')) {
            return imageData;
        } else {
            return `data:image/png;base64,${imageData}`;
        }
    }

    // 显示多图结果
    showMultiResults() {
        const progressArea = document.getElementById('directorProgressArea');
        const resultArea = document.getElementById('directorResultArea');

        if (progressArea) progressArea.classList.add('hidden');

        if (!resultArea) return;

        const successResults = this.generatedResults.filter(r => r.success);
        const totalCount = this.generatedResults.length;
        const successCount = successResults.length;

        if (successCount === 0) {
            resultArea.classList.add('hidden');
            return;
        }

        resultArea.classList.remove('hidden');
        
        // 找到第一个成功的结果
        while (this.currentResultIndex < this.generatedResults.length && !this.generatedResults[this.currentResultIndex].success) {
            this.currentResultIndex++;
        }
        if (this.currentResultIndex >= this.generatedResults.length) {
            this.currentResultIndex = this.generatedResults.findIndex(r => r.success);
        }

        const currentResult = this.generatedResults[this.currentResultIndex];
        const imageSrc = this.getImageSrc(currentResult?.image);

        // 生成缩略图
        let thumbnailsHtml = '';
        this.generatedResults.forEach((result, index) => {
            if (result.success) {
                const thumbSrc = this.getImageSrc(result.image);
                const isActive = index === this.currentResultIndex;
                thumbnailsHtml += `
                    <div class="cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${isActive ? 'border-blue-400 ring-2 ring-blue-400' : 'border-transparent opacity-60 hover:opacity-100'}"
                         onclick="window.directorPage.switchToResult(${index})">
                        <img src="${thumbSrc}" alt="第${index + 1}张" class="w-16 h-16 object-cover">
                    </div>
                `;
            } else {
                thumbnailsHtml += `
                    <div class="rounded-lg overflow-hidden border-2 border-red-400 opacity-50 cursor-not-allowed">
                        <div class="w-16 h-16 bg-red-500 bg-opacity-20 flex items-center justify-center">
                            <i class="fas fa-times text-red-400"></i>
                        </div>
                    </div>
                `;
            }
        });

        resultArea.innerHTML = `
            <div class="space-y-4">
                <!-- 统计信息 -->
                <div class="flex items-center justify-between text-white">
                    <span class="opacity-70">
                        <i class="fas fa-images mr-2"></i>
                        成功 ${successCount}/${totalCount} 张
                    </span>
                    <span class="text-sm opacity-50">
                        第 ${this.currentResultIndex + 1}/${totalCount} 张
                    </span>
                </div>

                <!-- 主图显示 -->
                <div class="relative group">
                    <img id="directorMainImage" 
                         src="${imageSrc}" 
                         alt="生成的漫画页面" 
                         class="w-full rounded-lg shadow-lg cursor-pointer"
                         onclick="window.directorPage.previewImage(this.src)">
                    <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
                        <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
                    </div>
                    
                    <!-- 左右切换按钮 -->
                    <button class="absolute left-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                            onclick="window.directorPage.navigateResult(-1)">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <button class="absolute right-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                            onclick="window.directorPage.navigateResult(1)">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                </div>

                <!-- 场景描述 -->
                <div class="bg-white bg-opacity-10 rounded-lg p-3">
                    <p class="text-white text-sm opacity-70" id="directorCurrentPrompt">${currentResult?.prompt || ''}</p>
                </div>

                <!-- 缩略图列表 -->
                <div class="flex space-x-2 overflow-x-auto pb-2" id="directorThumbnails">
                    ${thumbnailsHtml}
                </div>

                <!-- 操作按钮 -->
                <div class="flex justify-center space-x-4 flex-wrap gap-2">
                    <button id="directorDownloadCurrentBtn" 
                            class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-download mr-2"></i>下载当前
                    </button>
                    <button id="directorDownloadAllBtn" 
                            class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-file-archive mr-2"></i>下载全部 (${successCount})
                    </button>
                    <button id="directorRegenerateBtn" 
                            class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors text-sm">
                        <i class="fas fa-redo mr-2"></i>重新生成
                    </button>
                </div>
            </div>
        `;

        // 绑定按钮事件
        document.getElementById('directorDownloadCurrentBtn')?.addEventListener('click', () => this.downloadCurrentResult());
        document.getElementById('directorDownloadAllBtn')?.addEventListener('click', () => this.downloadAllResults());
        document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration());
    }

    // 切换到指定结果
    switchToResult(index) {
        if (index >= 0 && index < this.generatedResults.length && this.generatedResults[index].success) {
            this.currentResultIndex = index;
            this.updateCurrentResultDisplay();
        }
    }

    // 导航结果（上一张/下一张）
    navigateResult(direction) {
        let newIndex = this.currentResultIndex + direction;
        
        // 循环查找下一个成功的结果
        const maxAttempts = this.generatedResults.length;
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            if (newIndex < 0) newIndex = this.generatedResults.length - 1;
            if (newIndex >= this.generatedResults.length) newIndex = 0;
            
            if (this.generatedResults[newIndex].success) {
                this.currentResultIndex = newIndex;
                this.updateCurrentResultDisplay();
                return;
            }
            
            newIndex += direction;
            attempts++;
        }
    }

    // 更新当前结果显示
    updateCurrentResultDisplay() {
        const currentResult = this.generatedResults[this.currentResultIndex];
        if (!currentResult || !currentResult.success) return;

        // 更新主图
        const mainImage = document.getElementById('directorMainImage');
        if (mainImage) {
            mainImage.src = this.getImageSrc(currentResult.image);
        }

        // 更新场景描述
        const promptEl = document.getElementById('directorCurrentPrompt');
        if (promptEl) {
            promptEl.textContent = currentResult.prompt || '';
        }

        // 更新缩略图高亮
        const thumbnails = document.querySelectorAll('#directorThumbnails > div');
        thumbnails.forEach((thumb, index) => {
            if (this.generatedResults[index].success) {
                if (index === this.currentResultIndex) {
                    thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-blue-400 ring-2 ring-blue-400';
                } else {
                    thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-transparent opacity-60 hover:opacity-100';
                }
            }
        });

        // 更新计数
        const resultArea = document.getElementById('directorResultArea');
        if (resultArea) {
            const countSpan = resultArea.querySelector('span.text-sm');
            if (countSpan) {
                countSpan.textContent = `第 ${this.currentResultIndex + 1}/${this.generatedResults.length} 张`;
            }
        }
    }

    // 下载当前结果
    downloadCurrentResult() {
        const currentResult = this.generatedResults[this.currentResultIndex];
        if (!currentResult || !currentResult.success) {
            this.app.showToast('当前图片无法下载', 'warning');
            return;
        }

        this.downloadImage(currentResult.image, `comic_page_${this.currentLayout}_${this.currentResultIndex + 1}_${Date.now()}.png`);
    }

    // 下载所有结果
    async downloadAllResults() {
        const successResults = this.generatedResults.filter(r => r.success);
        if (successResults.length === 0) {
            this.app.showToast('没有可下载的图片', 'warning');
            return;
        }

        this.app.showToast(`开始下载 ${successResults.length} 张图片...`, 'info');

        // 逐个下载
        for (let i = 0; i < successResults.length; i++) {
            const result = successResults[i];
            const index = this.generatedResults.indexOf(result);
            await this.downloadImage(result.image, `comic_page_${this.currentLayout}_${index + 1}_${Date.now()}.png`);
            
            // 延迟避免浏览器阻止
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.app.showToast(`已下载 ${successResults.length} 张图片`, 'success');
    }

    // 下载单张图片
    downloadImage(imageData, filename) {
        return new Promise(resolve => {
            let dataUrl = imageData;
            if (!dataUrl.startsWith('data:')) {
                if (dataUrl.startsWith('http')) {
                    const link = document.createElement('a');
                    link.href = dataUrl;
                    link.download = filename;
                    link.click();
                    resolve();
                    return;
                }
                dataUrl = `data:image/png;base64,${imageData}`;
            }

            const link = document.createElement('a');
            link.href = dataUrl;
            link.download = filename;
            link.click();
            resolve();
        });
    }

    // 预览图片
    previewImage(src) {
        // 创建全屏预览
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center p-4';
        overlay.innerHTML = `
            <div class="relative max-w-full max-h-full">
                <img src="${src}" class="max-w-full max-h-[90vh] object-contain">
                <button class="absolute top-4 right-4 text-white text-3xl hover:text-gray-300" onclick="this.parentElement.parentElement.remove()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    // 下载结果（单图模式兼容）
    downloadResult() {
        if (this.currentMode === 'multi' && this.generatedResults.length > 1) {
            this.downloadCurrentResult();
            return;
        }

        if (!this.generatedResult) {
            this.app.showToast('没有可下载的图片', 'warning');
            return;
        }

        this.downloadImage(this.generatedResult, `comic_page_${this.currentLayout}_${Date.now()}.png`);
        this.app.showToast('下载已开始', 'success');
    }
}

// 暴露到全局
window.DirectorPage = DirectorPage;
