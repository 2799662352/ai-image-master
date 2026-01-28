// 版本检测服务模块
class VersionChecker {
    constructor() {
        this.versionFile = 'version.json';
        this.localStorageKey = 'app_version';
        this.checkInterval = null;
    }

    // 获取服务器端的最新版本信息
    async fetchServerVersion() {
        try {
            // 添加时间戳参数避免缓存
            const timestamp = new Date().getTime();
            const response = await fetch(`${this.versionFile}?t=${timestamp}`, {
                cache: 'no-cache',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            });

            if (!response.ok) {
                throw new Error(`获取版本信息失败: ${response.status}`);
            }

            const versionInfo = await response.json();
            return versionInfo;
        } catch (error) {
            console.error('获取服务器版本失败:', error);
            return null;
        }
    }

    // 获取本地存储的版本号
    getLocalVersion() {
        try {
            const localVersion = localStorage.getItem(this.localStorageKey);
            return localVersion ? JSON.parse(localVersion) : null;
        } catch (error) {
            console.error('读取本地版本失败:', error);
            return null;
        }
    }

    // 保存版本号到本地存储
    saveLocalVersion(versionInfo) {
        try {
            localStorage.setItem(this.localStorageKey, JSON.stringify(versionInfo));
            return true;
        } catch (error) {
            console.error('保存本地版本失败:', error);
            return false;
        }
    }

    // 比较版本号
    compareVersions(v1, v2) {
        // 将版本号分割成数组并转换为数字
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);

        // 比较每一位
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const part1 = parts1[i] || 0;
            const part2 = parts2[i] || 0;

            if (part1 > part2) return 1;
            if (part1 < part2) return -1;
        }

        return 0; // 版本相同
    }

    // 检查是否有新版本
    async checkForUpdate() {
        try {
            const serverVersion = await this.fetchServerVersion();
            
            if (!serverVersion || !serverVersion.version) {
                console.log('无法获取服务器版本信息');
                return { hasUpdate: false };
            }

            const localVersion = this.getLocalVersion();

            // 如果本地没有版本信息，保存当前版本并返回
            if (!localVersion) {
                this.saveLocalVersion(serverVersion);
                console.log('首次访问，保存版本信息:', serverVersion.version);
                return { hasUpdate: false };
            }

            // 比较版本号
            const comparison = this.compareVersions(
                serverVersion.version,
                localVersion.version
            );

            if (comparison > 0) {
                console.log(`发现新版本: ${serverVersion.version} (当前: ${localVersion.version})`);
                return {
                    hasUpdate: true,
                    currentVersion: localVersion.version,
                    newVersion: serverVersion.version,
                    buildTime: serverVersion.buildTime,
                    description: serverVersion.description
                };
            }

            console.log(`当前已是最新版本: ${localVersion.version}`);
            return { hasUpdate: false };

        } catch (error) {
            console.error('版本检查失败:', error);
            return { hasUpdate: false };
        }
    }

    // 强制刷新页面（清除缓存）
    forceRefresh() {
        try {
            // 先尝试清除一些缓存
            if ('caches' in window) {
                caches.keys().then(names => {
                    names.forEach(name => {
                        caches.delete(name);
                    });
                });
            }

            // 使用 location.reload(true) 强制从服务器重新加载
            // 注意：某些浏览器可能已不支持 reload(true)，所以我们使用额外的策略
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('_refresh', new Date().getTime());
            window.location.href = currentUrl.href;
        } catch (error) {
            console.error('刷新页面失败:', error);
            // 降级方案：普通刷新
            window.location.reload();
        }
    }

    // 显示更新提示对话框
    showUpdateDialog(updateInfo) {
        const modal = document.getElementById('updateModal');
        if (!modal) {
            console.error('更新提示对话框不存在');
            return;
        }

        // 更新对话框内容
        const versionText = document.getElementById('updateVersionText');
        if (versionText) {
            versionText.textContent = updateInfo.newVersion;
        }

        // 渲染更新内容
        this.renderUpdateNotes(updateInfo.releaseNotes);

        // 显示对话框
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    // 隐藏更新提示对话框
    hideUpdateDialog() {
        const modal = document.getElementById('updateModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    // 渲染更新说明列表
    renderUpdateNotes(releaseNotes) {
        const container = document.getElementById('updateNotesContainer');
        const notesList = document.getElementById('updateNotesList');
        
        if (!container || !notesList) {
            console.warn('更新内容容器不存在');
            return;
        }

        // 清空现有内容
        notesList.innerHTML = '';

        // 如果有更新说明，显示容器并渲染列表
        if (releaseNotes && Array.isArray(releaseNotes) && releaseNotes.length > 0) {
            releaseNotes.forEach(note => {
                const li = document.createElement('li');
                li.className = 'flex items-start';
                li.innerHTML = `
                    <i class="fas fa-check-circle text-purple-500 mr-2 mt-0.5 flex-shrink-0"></i>
                    <span>${note}</span>
                `;
                notesList.appendChild(li);
            });
            container.classList.remove('hidden');
            console.log(`渲染了 ${releaseNotes.length} 条更新说明`);
        } else {
            // 没有更新说明时隐藏容器
            container.classList.add('hidden');
            console.log('没有更新说明，隐藏更新内容区域');
        }
    }

    // 初始化版本检测
    async init() {
        console.log('初始化版本检测系统...');
        
        // 页面加载时检测一次
        const updateInfo = await this.checkForUpdate();
        
        if (updateInfo.hasUpdate) {
            this.showUpdateDialog(updateInfo);
        }

        // 绑定按钮事件
        this.bindEvents();
    }

    // 绑定事件监听器
    bindEvents() {
        // 确定按钮 - 刷新页面
        const confirmBtn = document.getElementById('confirmUpdate');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                // 保存新版本号
                this.fetchServerVersion().then(serverVersion => {
                    if (serverVersion) {
                        this.saveLocalVersion(serverVersion);
                    }
                    this.forceRefresh();
                });
            });
        }

        // 取消按钮 - 关闭对话框并保存版本号（避免重复提示）
        const cancelBtn = document.getElementById('cancelUpdate');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                // 保存版本号，避免用户每次刷新都提示
                this.fetchServerVersion().then(serverVersion => {
                    if (serverVersion) {
                        this.saveLocalVersion(serverVersion);
                    }
                });
                this.hideUpdateDialog();
            });
        }

        // 关闭按钮
        const closeBtn = document.getElementById('closeUpdate');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                // 保存版本号
                this.fetchServerVersion().then(serverVersion => {
                    if (serverVersion) {
                        this.saveLocalVersion(serverVersion);
                    }
                });
                this.hideUpdateDialog();
            });
        }

        // 点击模态框外部关闭
        const modal = document.getElementById('updateModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target.id === 'updateModal') {
                    // 保存版本号
                    this.fetchServerVersion().then(serverVersion => {
                        if (serverVersion) {
                            this.saveLocalVersion(serverVersion);
                        }
                    });
                    this.hideUpdateDialog();
                }
            });
        }
    }
}

// 创建全局实例
window.versionChecker = new VersionChecker();

