// UI组件模块
class UIComponents {
    constructor() {
        this.initComponents();
    }

    // 初始化组件
    initComponents() {
        this.enhanceTabSwitching();
        this.addImageOptimization();
        this.initResponsiveFeatures();
    }

    // 增强标签切换动画 - 适配扁平化设计
    enhanceTabSwitching() {
        const tabBtns = document.querySelectorAll('.tab-btn');
        
        tabBtns.forEach(btn => {
            btn.addEventListener('mouseenter', () => {
                if (!btn.classList.contains('active')) {
                    btn.style.transition = 'all 0.3s ease';
                    // 扁平化设计使用CSS的hover效果，无需JavaScript动画
                }
            });

            btn.addEventListener('mouseleave', () => {
                if (!btn.classList.contains('active')) {
                    // 保持平滑过渡
                    btn.style.transition = 'all 0.3s ease';
                }
            });
        });
    }

    // 添加图片优化功能
    addImageOptimization() {
        // 图片懒加载观察器
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        observer.unobserve(img);
                    }
                }
            });
        });

        // 监听动态添加的图片
        this.observeImages = (container) => {
            const images = container.querySelectorAll('img[data-src]');
            images.forEach(img => imageObserver.observe(img));
        };
    }

    // 初始化响应式功能
    initResponsiveFeatures() {
        // 移动端优化
        if (window.innerWidth < 768) {
            this.enableMobileOptimizations();
        }

        // 窗口大小变化监听
        window.addEventListener('resize', () => {
            if (window.innerWidth < 768) {
                this.enableMobileOptimizations();
            } else {
                this.disableMobileOptimizations();
            }
        });
    }

    // 启用移动端优化
    enableMobileOptimizations() {
        // 隐藏部分装饰元素
        const decorativeElements = document.querySelectorAll('.glass-effect');
        decorativeElements.forEach(el => {
            el.style.backdropFilter = 'none';
            el.style.webkitBackdropFilter = 'none';
        });

        // 简化动画
        document.body.classList.add('mobile-optimized');
    }

    // 禁用移动端优化
    disableMobileOptimizations() {
        const decorativeElements = document.querySelectorAll('.glass-effect');
        decorativeElements.forEach(el => {
            el.style.backdropFilter = 'blur(10px)';
            el.style.webkitBackdropFilter = 'blur(10px)';
        });

        document.body.classList.remove('mobile-optimized');
    }

    // 创建加载动画
    createLoadingSpinner(text = '加载中...') {
        const spinner = document.createElement('div');
        spinner.className = 'flex flex-col items-center justify-center py-8';
        spinner.innerHTML = `
            <div class="loading-spinner mb-4"></div>
            <p class="text-white opacity-70">${text}</p>
        `;
        return spinner;
    }

    // 创建错误提示
    createErrorMessage(message) {
        const error = document.createElement('div');
        error.className = 'flex flex-col items-center justify-center py-8 text-center';
        error.innerHTML = `
            <i class="fas fa-exclamation-triangle text-4xl text-red-400 mb-4"></i>
            <p class="text-white opacity-70 mb-4">${message}</p>
            <div class="text-sm text-white opacity-60 bg-white bg-opacity-10 rounded-lg p-3 mt-2">
                <i class="fas fa-info-circle mr-1"></i>
                请检查提示词内容，修改后重新点击生成按钮
            </div>
        `;
        return error;
    }

    // 创建图片卡片
    createImageCard(url, title = '', actions = []) {
        const card = document.createElement('div');
        card.className = 'bg-white bg-opacity-5 rounded-lg overflow-hidden';
        
        const actionsHtml = actions.map(action => `
            <button onclick="${action.onclick}" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="${action.title}">
                <i class="fas fa-${action.icon}"></i>
            </button>
        `).join('');

        card.innerHTML = `
            <div class="relative group">
                <img src="${url}" alt="${title}" class="w-full h-48 object-cover">
                <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
                    ${actionsHtml}
                </div>
            </div>
            ${title ? `<div class="p-3"><p class="text-white text-sm truncate">${title}</p></div>` : ''}
        `;

        return card;
    }

    // 创建进度条
    createProgressBar(percentage = 0, text = '') {
        const progressContainer = document.createElement('div');
        progressContainer.className = 'w-full';
        
        progressContainer.innerHTML = `
            <div class="bg-white bg-opacity-20 rounded-full h-2 mb-2">
                <div class="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-300" style="width: ${percentage}%"></div>
            </div>
            ${text ? `<p class="text-white text-sm text-center">${text}</p>` : ''}
        `;

        return progressContainer;
    }

    // 创建确认对话框
    createConfirmDialog(message, onConfirm, onCancel = null) {
        const dialog = document.createElement('div');
        dialog.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4';
        
        dialog.innerHTML = `
            <div class="bg-white rounded-xl p-6 max-w-sm w-full">
                <h3 class="text-lg font-bold mb-4">确认操作</h3>
                <p class="text-gray-600 mb-6">${message}</p>
                <div class="flex space-x-3">
                    <button class="confirm-btn flex-1 bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded-md transition-colors">
                        确认
                    </button>
                    <button class="cancel-btn flex-1 bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
                        取消
                    </button>
                </div>
            </div>
        `;

        const confirmBtn = dialog.querySelector('.confirm-btn');
        const cancelBtn = dialog.querySelector('.cancel-btn');

        confirmBtn.addEventListener('click', () => {
            dialog.remove();
            if (onConfirm) onConfirm();
        });

        cancelBtn.addEventListener('click', () => {
            dialog.remove();
            if (onCancel) onCancel();
        });

        // 点击外部关闭
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
                if (onCancel) onCancel();
            }
        });

        document.body.appendChild(dialog);
        return dialog;
    }

    // 创建输入对话框
    createInputDialog(title, placeholder, onConfirm, onCancel = null) {
        const dialog = document.createElement('div');
        dialog.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4';
        
        dialog.innerHTML = `
            <div class="bg-white rounded-xl p-6 max-w-sm w-full">
                <h3 class="text-lg font-bold mb-4">${title}</h3>
                <input type="text" class="input-field w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-6" placeholder="${placeholder}">
                <div class="flex space-x-3">
                    <button class="confirm-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
                        确认
                    </button>
                    <button class="cancel-btn flex-1 bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
                        取消
                    </button>
                </div>
            </div>
        `;

        const inputField = dialog.querySelector('.input-field');
        const confirmBtn = dialog.querySelector('.confirm-btn');
        const cancelBtn = dialog.querySelector('.cancel-btn');

        // 自动聚焦
        setTimeout(() => inputField.focus(), 100);

        confirmBtn.addEventListener('click', () => {
            const value = inputField.value.trim();
            if (value) {
                dialog.remove();
                if (onConfirm) onConfirm(value);
            }
        });

        cancelBtn.addEventListener('click', () => {
            dialog.remove();
            if (onCancel) onCancel();
        });

        // 回车确认
        inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            }
        });

        // 点击外部关闭
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
                if (onCancel) onCancel();
            }
        });

        document.body.appendChild(dialog);
        return dialog;
    }

    // 创建图片画廊
    createImageGallery(images) {
        const gallery = document.createElement('div');
        gallery.className = 'fixed inset-0 bg-black bg-opacity-90 z-[50000] flex items-center justify-center p-4';
        
        let currentIndex = 0;
        
        const updateGallery = () => {
            const img = images[currentIndex];
            gallery.innerHTML = `
                <div class="relative max-w-4xl max-h-full">
                    <img src="${img.url}" alt="${img.title || ''}" class="max-w-full max-h-full object-contain rounded-lg">
                    <button class="absolute top-4 right-4 text-white text-2xl hover:text-gray-300" onclick="this.parentElement.parentElement.remove()">
                        <i class="fas fa-times"></i>
                    </button>
                    ${images.length > 1 ? `
                        <button class="prev-btn absolute left-4 top-1/2 transform -translate-y-1/2 text-white text-2xl hover:text-gray-300">
                            <i class="fas fa-chevron-left"></i>
                        </button>
                        <button class="next-btn absolute right-12 top-1/2 transform -translate-y-1/2 text-white text-2xl hover:text-gray-300">
                            <i class="fas fa-chevron-right"></i>
                        </button>
                        <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 text-white">
                            ${currentIndex + 1} / ${images.length}
                        </div>
                    ` : ''}
                    <div class="absolute bottom-4 right-4 flex space-x-2">
                        <button onclick="app.downloadImage('${img.url}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all">
                            <i class="fas fa-download"></i>
                        </button>
                    </div>
                </div>
            `;

            if (images.length > 1) {
                gallery.querySelector('.prev-btn')?.addEventListener('click', () => {
                    currentIndex = (currentIndex - 1 + images.length) % images.length;
                    updateGallery();
                });

                gallery.querySelector('.next-btn')?.addEventListener('click', () => {
                    currentIndex = (currentIndex + 1) % images.length;
                    updateGallery();
                });
            }
        };

        updateGallery();

        // 键盘导航
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                gallery.remove();
                document.removeEventListener('keydown', handleKeydown);
            } else if (e.key === 'ArrowLeft' && images.length > 1) {
                currentIndex = (currentIndex - 1 + images.length) % images.length;
                updateGallery();
            } else if (e.key === 'ArrowRight' && images.length > 1) {
                currentIndex = (currentIndex + 1) % images.length;
                updateGallery();
            }
        };

        document.addEventListener('keydown', handleKeydown);

        // 点击外部关闭
        gallery.addEventListener('click', (e) => {
            if (e.target === gallery) {
                gallery.remove();
                document.removeEventListener('keydown', handleKeydown);
            }
        });

        document.body.appendChild(gallery);
        return gallery;
    }

    // 添加拖拽排序功能
    addDragAndDrop(container, onReorder = null) {
        let draggedElement = null;

        container.addEventListener('dragstart', (e) => {
            draggedElement = e.target.closest('[draggable]');
            e.dataTransfer.effectAllowed = 'move';
        });

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            const afterElement = this.getDragAfterElement(container, e.clientY);
            if (afterElement == null) {
                container.appendChild(draggedElement);
            } else {
                container.insertBefore(draggedElement, afterElement);
            }
        });

        container.addEventListener('dragend', () => {
            if (onReorder) {
                const newOrder = Array.from(container.children).map(child => child.dataset.id);
                onReorder(newOrder);
            }
            draggedElement = null;
        });
    }

    // 获取拖拽后的位置
    getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('[draggable]:not(.dragging)')];

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;

            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // 添加无限滚动
    addInfiniteScroll(container, loadMore) {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    loadMore();
                }
            },
            { threshold: 1.0 }
        );

        // 创建加载触发器
        const trigger = document.createElement('div');
        trigger.className = 'h-4';
        container.appendChild(trigger);
        observer.observe(trigger);

        return () => observer.unobserve(trigger);
    }
}

// 初始化组件
document.addEventListener('DOMContentLoaded', () => {
    window.uiComponents = new UIComponents();
}); 
