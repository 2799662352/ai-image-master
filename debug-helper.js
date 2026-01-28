// 调试助手 - 用于排查线上问题
window.debugHelper = {
    // 检查所有关键DOM元素
    checkDOMElements: function() {
        const requiredElements = [
            'modelSelector',
            'modelDropdown', 
            'modelList',
            'currentModelName',
            'referenceImageArea',
            'addMoreReferenceArea',
            'batchReferenceImageArea',
            'addMoreBatchReferenceArea',
            'referenceImagesPreview',
            'batchReferenceImagesPreview'
        ];
        
        console.log('=== DOM元素检查 ===');
        const results = {};
        
        requiredElements.forEach(id => {
            const element = document.getElementById(id);
            const exists = !!element;
            results[id] = exists;
            
            console.log(`${id}: ${exists ? '✅' : '❌'}`);
            
            if (!exists) {
                console.error(`缺少元素: ${id}`);
            }
        });
        
        return results;
    },
    
    // 检查API状态
    checkAPI: function() {
        console.log('=== API状态检查 ===');
        
        if (window.aiImageAPI) {
            console.log('✅ aiImageAPI 已加载');
            console.log('当前模型:', window.aiImageAPI.model);
            console.log('API Key:', window.aiImageAPI.apiKey ? '已设置' : '未设置');
            console.log('可用模型:', Object.keys(window.aiImageAPI.getAllModels()));
        } else {
            console.error('❌ aiImageAPI 未加载');
        }
    },
    
    // 检查应用状态
    checkApp: function() {
        console.log('=== 应用状态检查 ===');
        
        if (window.app) {
            console.log('✅ app 已初始化');
            console.log('当前标签页:', window.app.currentTab);
            console.log('页面实例:', Object.keys(window.app.pages || {}));
        } else {
            console.error('❌ app 未初始化');
        }
    },
    
    // 完全检查
    fullCheck: function() {
        console.clear();
        console.log('🔍 开始完整检查...\n');
        
        this.checkDOMElements();
        console.log('');
        this.checkAPI();
        console.log('');
        this.checkApp();
        
        console.log('\n✅ 检查完成');
    },
    
    // 强制重新初始化模型选择器
    reinitModelSelector: function() {
        console.log('🔄 强制重新初始化模型选择器...');
        
        if (window.app && window.app.initModelSelector) {
            window.app.initModelSelector();
            console.log('✅ 模型选择器重新初始化完成');
        } else {
            console.error('❌ 无法重新初始化模型选择器');
        }
    },
    
    // 检查模型下拉菜单状态
    checkModelDropdown: function() {
        console.log('=== 模型下拉菜单状态检查 ===');
        
        const dropdown = document.getElementById('modelDropdown');
        const backdrop = document.getElementById('modelDropdownBackdrop');
        const modelList = document.getElementById('modelList');
        
        console.log('下拉菜单:', dropdown ? '✅ 存在' : '❌ 不存在');
        console.log('是否隐藏:', dropdown ? dropdown.classList.contains('hidden') : 'N/A');
        console.log('背景遮罩:', backdrop ? '✅ 存在' : '❌ 不存在');
        console.log('模型列表容器:', modelList ? '✅ 存在' : '❌ 不存在');
        
        if (dropdown) {
            const rect = dropdown.getBoundingClientRect();
            console.log('菜单位置:', rect);
            const styles = window.getComputedStyle(dropdown);
            console.log('z-index:', styles.zIndex);
            console.log('pointer-events:', styles.pointerEvents);
            console.log('visibility:', styles.visibility);
        }
        
        if (modelList) {
            const options = modelList.querySelectorAll('.model-option');
            console.log('模型选项数量:', options.length);
            
            options.forEach((option, index) => {
                const optionStyles = window.getComputedStyle(option);
                console.log(`选项 ${index + 1}:`, {
                    cursor: optionStyles.cursor,
                    pointerEvents: optionStyles.pointerEvents,
                    display: optionStyles.display,
                    model: option.dataset.model
                });
            });
            
            // 测试点击事件绑定
            console.log('测试点击事件绑定...');
            options.forEach((option, index) => {
                const hasListeners = option.onclick || option._hasClickListener;
                console.log(`选项 ${index + 1} 事件绑定:`, hasListeners ? '✅' : '❓ 未确定');
            });
        }
    },
    
    // 显示版本信息
    showVersion: function() {
        console.log('=== 版本信息 ===');
        console.log('User Agent:', navigator.userAgent);
        console.log('当前URL:', window.location.href);
        console.log('DOM状态:', document.readyState);
        console.log('加载时间:', performance.now() + 'ms');
    },
    
    // 手动测试模型切换
    testModelSwitch: function(modelName = 'sora_image') {
        console.log('🧪 手动测试模型切换到:', modelName);
        
        if (window.app && window.app.switchModel) {
            window.app.switchModel(modelName);
            console.log('✅ 切换命令已发送');
        } else {
            console.error('❌ 无法找到切换方法');
        }
    },
    
    // 测试下拉菜单交互
    testDropdownInteraction: function() {
        console.log('🧪 测试下拉菜单交互...');
        
        // 1. 测试打开
        console.log('1. 测试打开下拉菜单');
        if (window.app && window.app.openModelDropdown) {
            window.app.openModelDropdown();
            console.log('✅ 打开命令已发送');
        }
        
        // 2. 等待一秒后检查状态
        setTimeout(() => {
            console.log('2. 检查下拉菜单状态');
            this.checkModelDropdown();
            
            // 3. 再等待一秒后测试关闭
            setTimeout(() => {
                console.log('3. 测试关闭下拉菜单');
                if (window.app && window.app.closeModelDropdown) {
                    window.app.closeModelDropdown();
                    console.log('✅ 关闭命令已发送');
                }
            }, 1000);
        }, 1000);
    }
};

// 自动运行检查（仅在开发环境）
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            console.log('🔧 开发环境自动检查');
            window.debugHelper.fullCheck();
        }, 1000);
    });
}

// Z-index层级调试工具
function debugZIndex() {
    console.log('=== Z-Index 层级调试信息 ===');
    
    // 检查模型选择器
    const modelDropdown = document.getElementById('modelDropdown');
    const modelDropdownMobile = document.getElementById('modelDropdownMobile');
    const nav = document.querySelector('nav.glass-effect');
    const imageResult = document.getElementById('imageResult');
    const mainContent = document.getElementById('main-content');
    
    const elements = [
        { name: '导航栏', element: nav },
        { name: '模型下拉菜单(桌面)', element: modelDropdown },
        { name: '模型下拉菜单(移动)', element: modelDropdownMobile },
        { name: '图片结果容器', element: imageResult },
        { name: '主要内容区域', element: mainContent }
    ];
    
    elements.forEach(({ name, element }) => {
        if (element) {
            const styles = window.getComputedStyle(element);
            console.log(`${name}:`, {
                element: element,
                zIndex: styles.zIndex,
                position: styles.position,
                transform: styles.transform,
                isolation: styles.isolation,
                display: styles.display,
                visibility: styles.visibility
            });
        } else {
            console.log(`${name}: 元素未找到`);
        }
    });
    
    // 检查图片容器
    const imageContainers = document.querySelectorAll('#imageResult .relative');
    console.log(`图片容器数量: ${imageContainers.length}`);
    imageContainers.forEach((container, index) => {
        const styles = window.getComputedStyle(container);
        console.log(`图片容器 ${index + 1}:`, {
            zIndex: styles.zIndex,
            position: styles.position,
            transform: styles.transform
        });
    });
}

// 使用说明
console.log(`
🔧 调试助手已加载！
使用方法：
- debugHelper.fullCheck() - 完整检查
- debugHelper.checkDOMElements() - 检查DOM元素
- debugHelper.checkAPI() - 检查API状态  
- debugHelper.checkApp() - 检查应用状态
- debugHelper.reinitModelSelector() - 重新初始化模型选择器
- debugHelper.checkModelDropdown() - 检查模型下拉菜单状态
- debugHelper.testModelSwitch('model_name') - 手动测试模型切换
- debugHelper.testDropdownInteraction() - 测试下拉菜单交互
- debugHelper.showVersion() - 显示版本信息
- debugZIndex() - 调试Z-index层级问题
`); 












