// 历史记录页面模块
class HistoryPage {
    constructor(app) {
        this.app = app;
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
        console.log('HistoryPage: 语言切换为', lang);
        // 重新加载历史记录面板以更新所有文本
        this.loadPanel();
    }

    bindEvents() {
        // 历史记录事件
        document.getElementById('clearHistory').addEventListener('click', () => this.clearHistory());
    }

    // 加载历史记录面板
    loadPanel() {
        const historyList = document.getElementById('historyList');
        const history = this.app.history;

        // 显示存储状态
        this.updateStorageStatus();

        if (history.length === 0) {
            const emptyText = this.i18n ? this.i18n.t('history.labels.empty') : '暂无历史记录';
            historyList.innerHTML = `
                <div class="text-center text-white opacity-50 py-8">
                    <i class="fas fa-history text-4xl mb-4"></i>
                    <p>${emptyText}</p>
                </div>
            `;
            return;
        }

        historyList.innerHTML = '';
        
        history.forEach(item => {
            const historyCard = document.createElement('div');

            // 检查项目类型
            const isNetworkRestricted = item.type === 'network_restricted';
            const isComparison = item.type === 'compare';

            // 检查存储状态
            const isCloudStored = item.r2Storage === true;
            const isUploading = item.uploading === true;
            const hasPlaceholder = item.urls && item.urls.some(url => url.startsWith('pending:'));

            historyCard.className = `bg-white bg-opacity-5 rounded-lg p-4 flex items-center space-x-4 ${isNetworkRestricted ? 'border border-orange-500 border-opacity-30' : ''} ${isComparison ? 'border border-purple-500 border-opacity-30' : ''}`;

            const typeIcon = {
                generate: 'fa-magic',
                edit: 'fa-edit',
                batch: 'fa-layer-group',
                compare: 'fa-balance-scale',
                network_restricted: 'fa-exclamation-triangle'
            }[item.type] || 'fa-image';

            const date = new Date(item.timestamp).toLocaleString('zh-CN');

            const imageCountText = item.urls.length > 1 ? ` (${item.urls.length}张)` : '';

            // 存储状态标识
            const storageBadge = isUploading || hasPlaceholder ?
                `<span class="inline-flex items-center text-xs bg-yellow-500 bg-opacity-20 text-yellow-200 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
                    <i class="fas fa-cloud-upload-alt fa-spin mr-1"></i>${this.i18n ? this.i18n.t('history.storage.uploading') : '上传中'}
                </span>` :
                isCloudStored ?
                `<span class="inline-flex items-center text-xs bg-green-500 bg-opacity-20 text-green-200 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
                    <i class="fas fa-cloud-check mr-1"></i>${this.i18n ? this.i18n.t('history.storage.cloud') : '云端'}
                </span>` :
                `<span class="inline-flex items-center text-xs bg-gray-500 bg-opacity-20 text-gray-300 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
                    <i class="fas fa-hdd mr-1"></i>${this.i18n ? this.i18n.t('history.storage.local') : '本地'}
                </span>`;

            // 为特殊项目添加标识
            const specialBadge = isNetworkRestricted ?
                `<span class="inline-flex items-center text-xs bg-orange-500 bg-opacity-20 text-orange-200 px-2.5 py-1 rounded-full whitespace-nowrap">
                    <i class="fas fa-wifi mr-1"></i>${this.i18n ? this.i18n.t('history.types.networkRestricted') : '网络受限'}
                </span>` :
                isComparison && item.comparison?.winnerModelName ?
                `<span class="inline-flex items-center text-xs bg-purple-500 bg-opacity-20 text-purple-200 px-2.5 py-1 rounded-full whitespace-nowrap">
                    <i class="fas fa-trophy mr-1"></i>${this.i18n ? this.i18n.t('history.types.winner', { model: item.comparison.winnerModelName }) : `${item.comparison.winnerModelName} 胜出`}
                </span>` :
                isComparison ?
                `<span class="inline-flex items-center text-xs bg-gray-500 bg-opacity-20 text-gray-300 px-2.5 py-1 rounded-full whitespace-nowrap">
                    <i class="fas fa-balance-scale mr-1"></i>${this.i18n ? this.i18n.t('history.types.pending') : '待评价'}
                </span>` : '';
            
            // 构建对比详情（如果是对比类型）
            const comparisonDetails = isComparison && item.comparison ? `
                <div class="text-xs text-white opacity-70 mt-1">
                    <span>${item.comparison.leftModelName} vs ${item.comparison.rightModelName}</span>
                    ${item.referenceImages && item.referenceImages.length > 0 ?
                        ` | ${item.referenceImages.length}张参考图` : ''}
                </div>
            ` : '';

            historyCard.innerHTML = `
                <div class="flex-shrink-0">
                    <i class="fas ${typeIcon} text-2xl ${isNetworkRestricted ? 'text-orange-400' : isComparison ? 'text-purple-400' : 'text-white opacity-70'}"></i>
                </div>
                <div class="flex-1">
                    <div class="flex items-start flex-wrap gap-2">
                        <h4 class="text-white font-medium ${isComparison ? 'mr-auto' : ''}">${item.prompt}${imageCountText}</h4>
                        ${storageBadge}
                        ${specialBadge}
                    </div>
                    <p class="text-white opacity-50 text-sm">${date}</p>
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                        ${item.model ? `<span class="text-white opacity-70">
                            <i class="fas fa-robot mr-1"></i>模型: ${item.model}
                        </span>` : ''}
                        ${item.ratio && item.ratio !== '网络受限' ? `<span class="text-white opacity-70">
                            <i class="fas fa-expand mr-1"></i>尺寸: ${item.ratio}
                        </span>` : ''}
                    </div>
                    ${isNetworkRestricted ? `<p class="text-orange-300 text-xs mt-1">✓ 生成成功，但图片可能需要特殊网络环境访问</p>` : ''}
                    ${comparisonDetails}
                </div>
                <div class="flex space-x-2">
                    ${item.urls.length > 0 && !hasPlaceholder ? `
                        <button onclick="app.viewImage(${JSON.stringify(item.urls).replace(/"/g, '&quot;')}, 0)" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="查看图片">
                            <i class="fas fa-eye"></i>
                        </button>
                        ${isNetworkRestricted ? `
                            <button onclick="app.pages.history.showNetworkRestrictedActions(${JSON.stringify(item.urls).replace(/"/g, '&quot;')}, '${item.prompt}')" class="bg-orange-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="网络受限选项">
                                <i class="fas fa-link"></i>
                            </button>
                        ` : item.urls.length === 1 ? `
                            <button onclick="app.downloadImage('${item.urls[0]}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="下载图片">
                                <i class="fas fa-download"></i>
                            </button>
                        ` : `
                            <button onclick="app.pages.history.downloadMultipleImages(${JSON.stringify(item.urls).replace(/"/g, '&quot;')}, '${item.prompt}')" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="批量下载">
                                <i class="fas fa-file-archive"></i>
                            </button>
                        `}
                    ` : hasPlaceholder ? `
                        <button disabled class="bg-gray-500 bg-opacity-20 text-gray-400 p-2 rounded-lg cursor-not-allowed" title="图片上传中，请稍候">
                            <i class="fas fa-hourglass-half"></i>
                        </button>
                    ` : ''}
                    ${!isCloudStored && !hasPlaceholder && item.urls.some(url => url.startsWith('data:')) ? `
                        <button onclick="app.pages.history.migrateToCloud(${item.id})" class="bg-blue-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="迁移到云端">
                            <i class="fas fa-cloud-upload-alt"></i>
                        </button>
                    ` : ''}
                    <button onclick="app.pages.history.deleteHistoryItem(${item.id})" class="bg-red-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="删除记录">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            
            historyList.appendChild(historyCard);
        });
        
        // 预加载历史记录中的图片，提升下载速度
        const allUrls = history.flatMap(item => item.urls || []);
        if (allUrls.length > 0) {
            window.aiImageAPI.preloadImages(allUrls);
        }
    }

    // 批量下载多张图片
    async downloadMultipleImages(urls, prompt) {
        try {
            // 生成文件名：提示词前20个字符 + 时间戳
            const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipFilename = `${promptPrefix}_${timestamp}.zip`;
            
            this.app.showToast(this.i18n ? this.i18n.t('history.messages.downloadStarting') : '开始批量下载...', 'info');

            const result = await window.aiImageAPI.downloadImagesAsZip(urls, zipFilename, (completed, total) => {
                this.app.showToast(this.i18n ? this.i18n.t('history.messages.downloading', { completed, total }) : `正在下载 ${completed}/${total}`, 'info');
            }, window.aiImageAPI.model);

            this.app.showToast(result.message || (this.i18n ? this.i18n.t('history.messages.downloadComplete') : '批量下载完成'), 'success');
        } catch (error) {
            this.app.showToast(error.message, 'error');
            
            // 如果是完全失败，显示帮助提示
            if (error.message.includes('右键图片选择')) {
                this.showDownloadHelpDialog(urls);
            }
        }
    }

    // 显示下载帮助对话框
    showDownloadHelpDialog(urls) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
                <h3 class="text-xl font-bold mb-4 text-gray-800">
                    <i class="fas fa-question-circle text-blue-500 mr-2"></i>
                    ${this.i18n ? this.i18n.t('history.downloadHelp.title') : '下载帮助'}
                </h3>
                <div class="space-y-3 text-gray-600 text-sm">
                    <p><strong>${this.i18n ? this.i18n.t('history.downloadHelp.message') : '由于浏览器安全限制，无法自动批量下载。'}</strong></p>
                    <p>${this.i18n ? this.i18n.t('history.downloadHelp.stepsTitle') : '请按以下步骤手动下载：'}</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>${this.i18n ? this.i18n.t('history.downloadHelp.step1') : '点击下方"查看图片"按钮'}</li>
                        <li>${this.i18n ? this.i18n.t('history.downloadHelp.step2') : '在图片预览中，右键图片'}</li>
                        <li>${this.i18n ? this.i18n.t('history.downloadHelp.step3') : '选择"图片另存为"'}</li>
                        <li>${this.i18n ? this.i18n.t('history.downloadHelp.step4') : '重复步骤2-3下载所有图片'}</li>
                    </ol>
                </div>
                <div class="flex space-x-3 mt-6">
                    <button onclick="app.viewImage(${JSON.stringify(urls).replace(/"/g, '&quot;')}, 0)" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
                        <i class="fas fa-eye mr-2"></i>${this.i18n ? this.i18n.t('history.downloadHelp.viewImages') : '查看图片'}
                    </button>
                    <button onclick="this.parentElement.parentElement.parentElement.remove()" class="bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
                        ${this.i18n ? this.i18n.t('history.downloadHelp.understood') : '知道了'}
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

    // 显示网络受限项目的操作选项
    showNetworkRestrictedActions(urls, prompt) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-70 z-[50000] flex items-center justify-center p-4';
        
        modal.innerHTML = `
            <div class="bg-white rounded-xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
                <!-- 标题 -->
                <div class="bg-orange-50 border-b border-orange-200 px-6 py-4 rounded-t-xl">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-3">
                            <div class="bg-orange-100 rounded-full p-2">
                                <i class="fas fa-exclamation-triangle text-orange-600 text-xl"></i>
                            </div>
                            <div>
                                <h3 class="text-lg font-bold text-orange-800">${this.i18n ? this.i18n.t('history.networkRestricted.title') : '网络受限的图片'}</h3>
                                <p class="text-sm text-orange-600">${prompt}</p>
                            </div>
                        </div>
                        <button class="network-actions-close-btn text-orange-400 hover:text-orange-600 transition-colors">
                            <i class="fas fa-times text-xl"></i>
                        </button>
                    </div>
                </div>

                <!-- 内容 -->
                <div class="p-6 space-y-4">
                    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded">
                        <div class="flex items-center">
                            <i class="fas fa-info-circle text-blue-500 mr-2"></i>
                            <span class="font-semibold text-blue-800">${this.i18n ? this.i18n.t('history.networkRestricted.explanationTitle') : '说明'}</span>
                        </div>
                        <p class="text-blue-700 text-sm mt-1">
                            ${this.i18n ? this.i18n.t('history.networkRestricted.description') : '这些图片已成功生成，但可能因网络环境限制无法直接访问。'}
                            ${this.i18n ? this.i18n.t('history.networkRestricted.instruction') : '您可以复制图片地址，然后在具有外网访问权限的网络环境中打开。'}
                        </p>
                    </div>

                    <!-- 图片地址列表 -->
                    <div>
                        <h4 class="font-semibold text-gray-800 mb-3">${this.i18n ? this.i18n.t('history.networkRestricted.imageAddresses', { count: urls.length }) : `图片地址 (${urls.length}张)`}</h4>
                        <div class="space-y-3 max-h-64 overflow-y-auto">
                            ${urls.map((url, index) => `
                                <div class="border rounded-lg p-3 bg-gray-50">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-sm font-medium text-gray-800">${this.i18n ? this.i18n.t('history.networkRestricted.imageLabel', { index: index + 1 }) : `图片 ${index + 1}`}</span>
                                        <div class="flex space-x-2">
                                            <button class="copy-single-url-btn text-xs bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded" data-url="${url}">
                                                <i class="fas fa-copy mr-1"></i>${this.i18n ? this.i18n.t('history.networkRestricted.copy') : '复制'}
                                            </button>
                                            <button class="open-single-url-btn text-xs bg-purple-500 hover:bg-purple-600 text-white px-3 py-1 rounded" data-url="${url}">
                                                <i class="fas fa-external-link-alt mr-1"></i>${this.i18n ? this.i18n.t('history.networkRestricted.open') : '打开'}
                                            </button>
                                        </div>
                                    </div>
                                    <div class="text-xs font-mono bg-white p-2 rounded border break-all">
                                        ${url}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- 解决方案 -->
                    <div class="bg-yellow-50 rounded-lg p-4">
                        <h5 class="font-semibold text-yellow-800 mb-2">
                            <i class="fas fa-lightbulb mr-2"></i>${this.i18n ? this.i18n.t('history.networkRestricted.solutionTitle') : '解决方案'}
                        </h5>
                        <ul class="text-yellow-700 text-sm space-y-1">
                            <li>• ${this.i18n ? this.i18n.t('history.networkRestricted.solutionItem1') : '复制图片地址到剪贴板'}</li>
                            <li>• ${this.i18n ? this.i18n.t('history.networkRestricted.solutionItem2') : '在具有外网访问权限的设备上粘贴并打开'}</li>
                            <li>• ${this.i18n ? this.i18n.t('history.networkRestricted.solutionItem3') : '使用VPN或代理服务访问'}</li>
                            <li>• ${this.i18n ? this.i18n.t('history.networkRestricted.solutionItem4') : '联系技术支持获取国内镜像地址'}</li>
                        </ul>
                    </div>

                    <!-- 操作按钮 -->
                    <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
                        <button class="copy-all-network-urls-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-copy mr-2"></i>${this.i18n ? this.i18n.t('history.networkRestricted.copyAll') : '复制所有地址'}
                        </button>
                        <button class="retry-network-access-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-redo mr-2"></i>${this.i18n ? this.i18n.t('history.networkRestricted.retry') : '重试访问'}
                        </button>
                        <button class="network-actions-close-btn bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
                            <i class="fas fa-times mr-2"></i>${this.i18n ? this.i18n.t('history.networkRestricted.close') : '关闭'}
                        </button>
                    </div>
                </div>
            </div>
        `;

        // 绑定事件
        this.bindNetworkActionsModalEvents(modal, urls, prompt);
        
        document.body.appendChild(modal);
    }

    // 绑定网络受限操作模态框事件
    bindNetworkActionsModalEvents(modal, urls, prompt) {
        // 关闭按钮
        const closeButtons = modal.querySelectorAll('.network-actions-close-btn');
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
        modal.querySelectorAll('.copy-single-url-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                navigator.clipboard.writeText(url).then(() => {
                    this.app.showToast('图片地址已复制', 'success');
                }).catch(() => {
                    this.app.showToast('复制失败', 'error');
                });
            });
        });

        // 打开单个URL
        modal.querySelectorAll('.open-single-url-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                window.open(url, '_blank');
            });
        });

        // 复制所有地址
        const copyAllBtn = modal.querySelector('.copy-all-network-urls-btn');
        copyAllBtn.addEventListener('click', () => {
            const urlsText = urls.map((url, index) => `图片${index + 1}: ${url}`).join('\n\n');
            const fullText = `${prompt}\n生成时间: ${new Date().toLocaleString()}\n\n${urlsText}`;
            navigator.clipboard.writeText(fullText).then(() => {
                this.app.showToast('所有图片地址已复制', 'success');
            }).catch(() => {
                this.app.showToast('复制失败', 'error');
            });
        });

        // 重试访问
        const retryBtn = modal.querySelector('.retry-network-access-btn');
        retryBtn.addEventListener('click', async () => {
            this.app.showToast('正在重新检测网络访问...', 'info');
            
            try {
                // 使用API的检查方法重新检测
                const accessibilityPromises = urls.map(url => window.aiImageAPI.checkUrlAccessibility(url));
                const results = await Promise.allSettled(accessibilityPromises);
                
                const accessibleUrls = results
                    .map((result, index) => result.status === 'fulfilled' ? urls[index] : null)
                    .filter(url => url !== null);
                
                const inaccessibleUrls = results
                    .map((result, index) => result.status === 'rejected' ? urls[index] : null)
                    .filter(url => url !== null);
                
                if (accessibleUrls.length > 0) {
                    this.app.showToast(`检测到 ${accessibleUrls.length}/${urls.length} 张图片现在可以访问`, 'success');
                    // 可以选择自动开始下载可访问的图片
                    if (accessibleUrls.length === urls.length) {
                        modal.remove();
                        // 所有图片都可访问，尝试下载
                        this.downloadMultipleImages(accessibleUrls, prompt);
                    }
                } else {
                    this.app.showToast('仍然无法访问这些图片地址', 'warning');
                }
            } catch (error) {
                this.app.showToast('网络检测失败', 'error');
            }
        });
    }

    // 删除历史记录项
    async deleteHistoryItem(id) {
        const itemToDelete = this.app.history.find(item => item.id === id);

        if (itemToDelete) {
            // 如果是云端存储的图片，同步删除云端文件
            if (itemToDelete.r2Storage && window.r2Storage && window.r2Storage.isAvailable()) {
                try {
                    const r2Keys = [];
                    itemToDelete.urls.forEach(url => {
                        if (window.r2Storage.isR2Url(url)) {
                            const key = window.r2Storage.extractR2Key(url);
                            if (key) r2Keys.push(key);
                        }
                    });

                    if (r2Keys.length > 0) {
                        console.log(`删除云端图片: ${r2Keys.length} 个文件`);
                        await window.r2Storage.batchDelete(r2Keys);
                    }
                } catch (error) {
                    console.error('删除云端图片失败:', error);
                }
            }
        }

        // 从历史记录中移除
        this.app.history = this.app.history.filter(item => item.id !== id);
        this.app.saveHistory();
        this.loadPanel();
        this.app.showToast(this.i18n ? this.i18n.t('history.messages.deleted') : '记录已删除', 'success');
    }

    // 手动迁移单个历史记录到云端
    async migrateToCloud(id) {
        const historyItem = this.app.history.find(item => item.id === id);
        if (!historyItem) {
            this.app.showToast(this.i18n ? this.i18n.t('history.messages.notFound') : '历史记录不存在', 'error');
            return;
        }

        if (!window.r2Storage || !window.r2Storage.isAvailable()) {
            this.app.showToast(this.i18n ? this.i18n.t('history.messages.cloudUnavailable') : '云存储服务不可用', 'error');
            return;
        }

        // 显示上传中状态
        this.app.showToast(this.i18n ? this.i18n.t('history.messages.migrating') : '正在迁移到云端...', 'info');

        try {
            // 过滤出 base64 图片
            const base64Urls = historyItem.urls.filter(url => url.startsWith('data:'));
            if (base64Urls.length === 0) {
                this.app.showToast('没有需要迁移的本地图片', 'info');
                return;
            }

            // 批量上传到 R2
            const r2Urls = await window.r2Storage.batchProcess(base64Urls);

            // 更新历史记录中的 URLs
            const updatedUrls = historyItem.urls.map(url => {
                const index = base64Urls.indexOf(url);
                if (index !== -1 && r2Urls[index]) {
                    return r2Urls[index];
                }
                return url;
            });

            // 更新历史记录
            historyItem.urls = updatedUrls;
            historyItem.r2Storage = true;
            historyItem.uploading = false;
            delete historyItem.originalUrls;

            // 保存更新
            this.app.saveHistoryWithoutBase64();

            // 重新加载面板
            this.loadPanel();
            this.app.showToast('已成功迁移到云端', 'success');

        } catch (error) {
            console.error('迁移到云端失败:', error);
            this.app.showToast('迁移失败，请重试', 'error');
        }
    }

    // 批量迁移所有可迁移的历史记录到云端
    async migrateAllToCloud() {
        if (!window.r2Storage || !window.r2Storage.isAvailable()) {
            this.app.showToast('云存储服务不可用', 'error');
            return;
        }

        // 找出所有需要迁移的记录
        const itemsToMigrate = this.app.history.filter(item =>
            !item.r2Storage &&
            !item.uploading &&
            item.urls &&
            item.urls.some(url => url.startsWith('data:'))
        );

        if (itemsToMigrate.length === 0) {
            this.app.showToast('没有需要迁移的历史记录', 'info');
            return;
        }

        this.app.showToast(`开始迁移 ${itemsToMigrate.length} 条记录...`, 'info');

        let successCount = 0;
        let failCount = 0;

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

                successCount++;
            } catch (error) {
                console.error(`迁移记录 ${item.id} 失败:`, error);
                failCount++;
            }
        }

        // 保存更新
        this.app.saveHistoryWithoutBase64();

        // 重新加载面板
        this.loadPanel();

        if (successCount > 0) {
            this.app.showToast(
                `迁移完成：成功 ${successCount} 条${failCount > 0 ? `，失败 ${failCount} 条` : ''}`,
                failCount > 0 ? 'warning' : 'success'
            );
        } else {
            this.app.showToast('迁移失败，请重试', 'error');
        }
    }

    // 更新存储状态显示
    updateStorageStatus() {
        const storageInfo = this.app.getStorageInfo();
        const clearButton = document.getElementById('clearHistory');

        // 创建存储状态指示器
        let statusElement = document.getElementById('storageStatus');
        if (!statusElement) {
            statusElement = document.createElement('div');
            statusElement.id = 'storageStatus';
            statusElement.className = 'text-xs text-white opacity-70 mb-2';
            clearButton.parentElement.insertBefore(statusElement, clearButton);
        }

        // 更新状态内容
        const usagePercent = ((parseFloat(storageInfo.totalSize) / storageInfo.estimatedLimit) * 100).toFixed(1);
        const statusText = storageInfo.r2Enabled ?
            (this.i18n ? this.i18n.t('history.storage.cloudModeTitle') : '安全云端存储') :
            (this.i18n ? this.i18n.t('history.storage.localModeTitle') : '本地浏览器存储');

        // 检查是否有可迁移的记录
        const migrateableCount = this.app.history.filter(item =>
            !item.r2Storage &&
            !item.uploading &&
            item.urls &&
            item.urls.some(url => url.startsWith('data:'))
        ).length;

        statusElement.innerHTML = `
            <!-- 主状态栏 -->
            <div class="bg-gradient-to-r ${storageInfo.r2Enabled ? 'from-blue-600 to-purple-600' : 'from-gray-600 to-gray-700'} bg-opacity-20 rounded-lg p-3 mb-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        <span class="text-lg">${storageInfo.r2Enabled ? '🔐' : '💾'}</span>
                        <div>
                            <span class="text-white font-medium">${statusText}</span>
                            <span class="ml-3 text-xs opacity-70">
                                ${this.i18n ? this.i18n.t('history.labels.recordsCount', { count: storageInfo.historyCount }) : `${storageInfo.historyCount} 条记录`} | ${storageInfo.historySize} KB
                            </span>
                        </div>
                    </div>
                    <div class="text-right">
                        <span class="text-xs ${usagePercent > 80 ? 'text-orange-400' : 'text-gray-300'}">
                            ${this.i18n ? this.i18n.t('history.labels.localUsage', { percent: usagePercent }) : `本地占用: ${usagePercent}%`}
                        </span>
                    </div>
                </div>
            </div>

            <!-- 功能说明卡片 -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                ${storageInfo.r2Enabled ? `
                    <!-- 隐私保护 -->
                    <div class="bg-blue-500 bg-opacity-10 rounded-lg p-2.5 border border-blue-400 border-opacity-20">
                        <div class="flex items-start space-x-2">
                            <i class="fas fa-shield-alt text-blue-400 mt-0.5"></i>
                            <div>
                                <span class="text-blue-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.privacyProtection') : '隐私保护'}</span>
                                <p class="text-blue-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.privacyProtectionDesc') : '图片经加密后匿名存储，仅您可访问'}</p>
                            </div>
                        </div>
                    </div>

                    <!-- 智能存储 -->
                    <div class="bg-green-500 bg-opacity-10 rounded-lg p-2.5 border border-green-400 border-opacity-20">
                        <div class="flex items-start space-x-2">
                            <i class="fas fa-cloud text-green-400 mt-0.5"></i>
                            <div>
                                <span class="text-green-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.smartStorage') : '智能存储'}</span>
                                <p class="text-green-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.smartStorageDesc') : '自动上传云端，节省本地空间 95%+'}</p>
                            </div>
                        </div>
                    </div>

                    <!-- 同步管理 -->
                    <div class="bg-yellow-500 bg-opacity-10 rounded-lg p-2.5 border border-yellow-400 border-opacity-20">
                        <div class="flex items-start space-x-2">
                            <i class="fas fa-sync-alt text-yellow-400 mt-0.5"></i>
                            <div>
                                <span class="text-yellow-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.syncManagement') : '同步管理'}</span>
                                <p class="text-yellow-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.syncManagementDesc') : '删除记录时云端图片同步清理'}</p>
                            </div>
                        </div>
                    </div>

                    <!-- 有效期限 -->
                    <div class="bg-gray-500 bg-opacity-10 rounded-lg p-2.5 border border-gray-400 border-opacity-20">
                        <div class="flex items-start space-x-2">
                            <i class="fas fa-clock text-gray-400 mt-0.5"></i>
                            <div>
                                <span class="text-gray-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.expirationPeriod') : '有效期限'}</span>
                                <p class="text-gray-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.expirationPeriodDesc') : '云端保存 30 天，到期自动清理'}</p>
                            </div>
                        </div>
                    </div>
                ` : `
                    <!-- 本地存储警告 -->
                    <div class="bg-yellow-500 bg-opacity-10 rounded-lg p-2.5 border border-yellow-400 border-opacity-20 col-span-2">
                        <div class="flex items-start space-x-2">
                            <i class="fas fa-exclamation-triangle text-yellow-400 mt-0.5"></i>
                            <div>
                                <span class="text-yellow-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.localStorageMode') : '本地存储模式'}</span>
                                <p class="text-yellow-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.localStorageModeDesc') : '图片保存在浏览器，占用设备存储空间'}</p>
                            </div>
                        </div>
                    </div>
                    ${usagePercent > 50 ? `
                        <div class="bg-orange-500 bg-opacity-10 rounded-lg p-2.5 border border-orange-400 border-opacity-20 col-span-2">
                            <div class="flex items-start space-x-2">
                                <i class="fas fa-info-circle text-orange-400 mt-0.5"></i>
                                <div>
                                    <span class="text-orange-300 font-medium text-xs">${this.i18n ? this.i18n.t('history.labels.configureCloudStorage') : '建议配置云端存储'}</span>
                                    <p class="text-orange-200 text-xs opacity-90 mt-0.5">${this.i18n ? this.i18n.t('history.labels.configureCloudStorageDesc') : '配置 Worker URL 以节省空间并保护隐私'}</p>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                `}
            </div>

            ${migrateableCount > 0 && storageInfo.r2Enabled ? `
                <div class="text-center mb-2">
                    <button onclick="app.pages.history.migrateAllToCloud()"
                            class="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white text-xs px-4 py-2 rounded-lg transition-all shadow-lg transform hover:scale-105">
                        <i class="fas fa-cloud-upload-alt mr-1.5"></i>
                        ${this.i18n ? this.i18n.t('history.labels.migrateAllToCloud', { count: migrateableCount }) : `一键迁移 ${migrateableCount} 条本地记录到云端`}
                    </button>
                </div>
            ` : ''}

            <!-- 清理缓存按钮（仅 Electron 模式显示） -->
            ${window.electronAPI?.isElectron ? `
                <div class="text-center border-t border-gray-600 border-opacity-30 pt-3 mt-2">
                    <button onclick="app.pages.history.clearWebCache()"
                            id="clearWebCacheBtn"
                            class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white text-xs px-4 py-2 rounded-lg transition-all shadow-lg transform hover:scale-105">
                        <i class="fas fa-broom mr-1.5"></i>
                        ${this.i18n ? this.i18n.t('history.labels.clearWebCache') : '清理网页缓存'}
                    </button>
                    <p class="text-gray-400 text-xs mt-1 opacity-70">
                        ${this.i18n ? this.i18n.t('history.labels.clearWebCacheDesc') : '清理 localStorage 和浏览器缓存，释放存储空间'}
                    </p>
                </div>
            ` : ''}
        `;
    }

    // 清空历史记录
    async clearHistory() {
        if (confirm('确定要清空所有历史记录吗？这将同时删除云端保存的图片。')) {
            // 如果启用了 R2，删除所有云端图片
            if (window.r2Storage && window.r2Storage.isAvailable()) {
                try {
                    const allR2Keys = [];
                    this.app.history.forEach(item => {
                        if (item.r2Storage && item.urls) {
                            item.urls.forEach(url => {
                                if (window.r2Storage.isR2Url(url)) {
                                    const key = window.r2Storage.extractR2Key(url);
                                    if (key) allR2Keys.push(key);
                                }
                            });
                        }
                    });

                    if (allR2Keys.length > 0) {
                        this.app.showToast(`正在清理云端图片...`, 'info');
                        console.log(`清理云端图片: ${allR2Keys.length} 个文件`);
                        await window.r2Storage.batchDelete(allR2Keys);
                    }
                } catch (error) {
                    console.error('清理云端图片失败:', error);
                }
            }

            // 清空本地历史记录
            this.app.history = [];
            this.app.saveHistory();
            this.loadPanel();
            this.app.showToast('历史记录已清空，云端图片已同步删除', 'success');
        }
    }

    // 清理网页缓存（Electron 专用）
    async clearWebCache() {
        if (!window.electronAPI?.isElectron) {
            this.app.showToast('此功能仅在桌面应用中可用', 'warning');
            return;
        }

        const confirmMsg = this.i18n 
            ? this.i18n.t('history.messages.confirmClearCache') 
            : '确定要清理网页缓存吗？这将清除 localStorage 和浏览器缓存，可能需要重新登录某些服务。';
        
        if (!confirm(confirmMsg)) {
            return;
        }

        // 更新按钮状态
        const btn = document.getElementById('clearWebCacheBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>清理中...';
        }

        try {
            // 调用 Electron API 清理缓存
            const result = await window.electronAPI.clearWebCache();
            
            if (result.success) {
                this.app.showToast(
                    this.i18n ? this.i18n.t('history.messages.cacheCleared') : '网页缓存已清理，即将刷新页面',
                    'success'
                );
                
                // 延迟刷新页面
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } else {
                throw new Error(result.error || '清理失败');
            }
        } catch (error) {
            console.error('清理网页缓存失败:', error);
            this.app.showToast(
                this.i18n ? this.i18n.t('history.messages.cacheClearFailed') : '清理缓存失败，请重试',
                'error'
            );
            
            // 恢复按钮
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fas fa-broom mr-1.5"></i>${this.i18n ? this.i18n.t('history.labels.clearWebCache') : '清理网页缓存'}`;
            }
        }
    }

    // 页面激活时调用
    onActivate() {
        console.log('历史记录页面已激活');
        // 每次激活时重新加载，确保数据最新
        setTimeout(() => {
            this.loadPanel();
        }, 10);
    }

    // 页面失活时调用
    onDeactivate() {
        console.log('历史记录页面已失活');
    }
}

// 导出模块
window.HistoryPage = HistoryPage;
