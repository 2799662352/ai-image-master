// 提示词模板模块
class PromptTemplates {
    constructor(app) {
        this.app = app;
        this.templates = {};
        this.currentCategory = '热门';
        this.modal = null;
        this.targetInput = null; // 当前要填充的输入框
        this.isBatchMode = false; // 是否为批量模式
        this.isTemplatesLoaded = false; // 标记模板数据是否已加载
        
        this.init();
    }

    init() {
        console.log('初始化提示词模板模块');
        this.bindEvents();
        // 改为懒加载：不在初始化时加载模板数据，而是在首次打开弹窗时加载
    }

    // 绑定事件
    bindEvents() {
        // 单图生成模板按钮
        const promptTemplateBtn = document.getElementById('promptTemplateBtn');
        if (promptTemplateBtn) {
            promptTemplateBtn.addEventListener('click', () => {
                this.targetInput = document.getElementById('promptInput');
                this.isBatchMode = false;
                this.showTemplateModal();
            });
        }

        // 批量生成模板按钮
        const batchPromptTemplateBtn = document.getElementById('batchPromptTemplateBtn');
        if (batchPromptTemplateBtn) {
            batchPromptTemplateBtn.addEventListener('click', () => {
                this.targetInput = document.getElementById('batchPrompts');
                this.isBatchMode = true;
                this.showTemplateModal();
            });
        }

        // 模态框事件
        this.modal = document.getElementById('promptTemplateModal');
        if (this.modal) {
            // 关闭按钮
            const closeBtn = document.getElementById('closeTemplateModal');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.hideTemplateModal());
            }

            // 点击背景关闭
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) {
                    this.hideTemplateModal();
                }
            });

            // ESC键关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) {
                    this.hideTemplateModal();
                }
            });

            // 分类切换按钮
            const categoryBtns = this.modal.querySelectorAll('.template-category-btn');
            categoryBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    const category = btn.dataset.category;
                    this.switchCategory(category);
                });
            });
        }
    }

    // 加载模板数据
    async loadTemplates() {
        try {
            console.log('开始加载提示词模板数据');
            const response = await fetch('data/prompt-templates.json');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            this.templates = await response.json();
            console.log('提示词模板数据加载成功:', this.templates);
        } catch (error) {
            console.error('加载提示词模板数据失败:', error);
            // 使用默认模板数据
            this.templates = this.getDefaultTemplates();
        }
    }

    // 获取默认模板数据（备用）
    getDefaultTemplates() {
        return {
            "热门": [
                {
                    id: 1,
                    title: "古装美女",
                    prompt: "一位身穿古装的美丽女子，古典气质，细腻五官，柔和光线，传统服饰，高清摄影，细节丰富",
                    preview: "images/templates/ancient_beauty.jpg",
                    tags: ["人物", "古装", "美女", "传统"]
                },
                {
                    id: 2,
                    title: "科幻城市",
                    prompt: "未来科幻城市，高楼大厦，霓虹灯光，赛博朋克风格，夜景，超高清，细节丰富",
                    preview: "images/templates/cyberpunk_city.jpg",
                    tags: ["科幻", "城市", "赛博朋克", "夜景"]
                }
            ],
            "电商": [
                {
                    id: 101,
                    title: "女装模特",
                    prompt: "年轻女性模特，身穿时尚服装，白色背景，专业摄影，高清，电商产品展示",
                    preview: "images/templates/female_model.jpg",
                    tags: ["模特", "女装", "电商", "产品"]
                }
            ]
        };
    }

    // 显示模板弹窗
    async showTemplateModal() {
        if (!this.modal) return;
        
        console.log('显示提示词模板弹窗');
        this.modal.classList.remove('hidden');
        
        // 懒加载：首次打开时才加载模板数据
        if (!this.isTemplatesLoaded) {
            console.log('首次打开模板弹窗，开始加载模板数据');
            await this.loadTemplates();
            this.isTemplatesLoaded = true;
        }
        
        // 重置到默认分类
        this.currentCategory = '热门';
        this.updateCategoryButtons();
        this.renderTemplates();
        
        // 防止页面滚动
        document.body.style.overflow = 'hidden';
    }

    // 隐藏模板弹窗
    hideTemplateModal() {
        if (!this.modal) return;
        
        console.log('隐藏提示词模板弹窗');
        this.modal.classList.add('hidden');
        
        // 恢复页面滚动
        document.body.style.overflow = '';
    }

    // 切换分类
    switchCategory(category) {
        console.log('切换模板分类:', category);
        this.currentCategory = category;
        this.updateCategoryButtons();
        this.renderTemplates();
    }

    // 更新分类按钮状态
    updateCategoryButtons() {
        const categoryBtns = this.modal.querySelectorAll('.template-category-btn');
        categoryBtns.forEach(btn => {
            const category = btn.dataset.category;
            if (category === this.currentCategory) {
                btn.classList.add('active');
                btn.classList.remove('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
                btn.classList.add('bg-blue-500', 'text-white');
            } else {
                btn.classList.remove('active');
                btn.classList.remove('bg-blue-500', 'text-white');
                btn.classList.add('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
            }
        });
    }

    // 渲染模板
    renderTemplates() {
        const templateGrid = document.getElementById('templateGrid');
        const loadingDiv = document.getElementById('templateLoading');
        const emptyDiv = document.getElementById('templateEmpty');
        
        if (!templateGrid) return;

        // 显示加载状态
        loadingDiv.classList.remove('hidden');
        emptyDiv.classList.add('hidden');
        templateGrid.innerHTML = '';

        // 模拟加载延迟
        setTimeout(() => {
            const categoryTemplates = this.templates[this.currentCategory] || [];
            
            loadingDiv.classList.add('hidden');
            
            if (categoryTemplates.length === 0) {
                emptyDiv.classList.remove('hidden');
                return;
            }

            // 渲染模板卡片
            categoryTemplates.forEach(template => {
                const templateCard = this.createTemplateCard(template);
                templateGrid.appendChild(templateCard);
            });
            
            console.log(`渲染了 ${categoryTemplates.length} 个模板`);
        }, 300);
    }

    // 创建模板卡片
    createTemplateCard(template) {
        const card = document.createElement('div');
        card.className = 'bg-gray-50 rounded-lg overflow-hidden hover:shadow-lg transition-all cursor-pointer group border border-gray-200';
        
        card.innerHTML = `
            <div class="aspect-square bg-gray-200 relative overflow-hidden">
                <img src="${template.preview}" 
                     alt="${template.title}"
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                     onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgdmlld0JveD0iMCAwIDIwMCAyMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik05MCA5MEw5MCA1NEwxMTAgMTAwTDkwIDkwWiIgZmlsbD0iIzlCOUJBMCIvPgo8cGF0aCBkPSJNMTA1IDkwTDEyNSA5MEwxMjUgMTEwTDEwNSAxMTBMMTA1IDkwWiIgZmlsbD0iIzlCOUJBMCIvPgo8Y2lyY2xlIGN4PSI5OCIgY3k9IjEwMCIgcj0iMyIgZmlsbD0iIzlCOUJBMCIvPgo8dGV4dCB4PSIxMDAiIHk9IjE0MCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOUI5QkEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7lm77niYfpooTop4g8L3RleHQ+Cjwvc3ZnPgo='">
                <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-20 transition-all flex items-center justify-center">
                    <div class="bg-white bg-opacity-90 px-3 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform translate-y-2 group-hover:translate-y-0">
                        <span class="text-sm font-medium text-gray-800">点击使用</span>
                    </div>
                </div>
            </div>
            <div class="p-3">
                <h3 class="font-medium text-gray-800 mb-2">${template.title}</h3>
                <p class="text-sm text-gray-600 mb-2 line-clamp-2">${template.prompt}</p>
                <div class="flex flex-wrap gap-1">
                    ${template.tags.map(tag => `<span class="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">${tag}</span>`).join('')}
                </div>
            </div>
        `;

        // 绑定点击事件
        card.addEventListener('click', () => {
            this.applyTemplate(template);
        });

        return card;
    }

    // 应用模板
    applyTemplate(template) {
        if (!this.targetInput) {
            console.error('未找到目标输入框');
            return;
        }

        console.log('应用模板:', template.title);
        
        if (this.isBatchMode) {
            // 批量模式：在新行添加提示词
            const currentValue = this.targetInput.value.trim();
            const newValue = currentValue ? `${currentValue}\n${template.prompt}` : template.prompt;
            this.targetInput.value = newValue;
        } else {
            // 单图模式：替换内容
            this.targetInput.value = template.prompt;
        }

        // 触发输入事件（如果需要）
        this.targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        
        // 关闭弹窗
        this.hideTemplateModal();
        
        // 显示成功提示
        if (this.app && this.app.showToast) {
            this.app.showToast(`已应用模板"${template.title}"`, 'success');
        }
    }

    // 添加自定义样式（如果需要）
    addCustomStyles() {
        const styleId = 'prompt-templates-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .line-clamp-2 {
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
        `;
        document.head.appendChild(style);
    }
}

// 如果在浏览器环境中，添加到全局
if (typeof window !== 'undefined') {
    window.PromptTemplates = PromptTemplates;
}
