# DirectorPage 功能对齐升级计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 TypeScript 版本的 DirectorPage 与原始 JavaScript 版本功能完全对齐

**Architecture:** 分阶段补全缺失功能，优先处理核心功能（图片压缩、结果导航），然后处理 UI 交互和 i18n

**Tech Stack:** TypeScript, Electron, Vite, browser-image-compression

---

## 差异总结

### 缺失的核心功能
1. 图片压缩 (`compressImage`)
2. 多图结果缩略图导航 (`showResult`, `showMultiResults`, `switchToResult`, `navigateResult`)
3. 全屏图片预览 (`previewImage`)
4. 资产面板展开/折叠 (`toggleAssetPanel`, `togglePanel`)
5. 复制功能的图标动画反馈 (`copyAnalysis`, `copyPrompt`)
6. 立即保存状态 (`saveCurrentStateImmediate`)
7. 清空所有参考图 (`clearAllReferenceImages`)
8. HTML 转义函数差异 (`escapeHtml` vs `escapeHtmlText`)

### 部分实现的功能
1. `updateReferenceImagesPreview` - 缺少"清空全部"按钮
2. i18n 覆盖不完整

---

## Phase 1: 图片压缩功能

### Task 1.1: 添加 compressImage 方法

**文件:**
- 修改: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加 compressImage 方法**

在 `DirectorPage.ts` 的图片处理区域添加：

```typescript
/**
 * 压缩图片
 * @param file 原始文件
 * @param maxSizeMB 最大尺寸 MB
 * @param maxWidthOrHeight 最大宽高
 */
private async compressImage(
  file: File,
  maxSizeMB: number = 1,
  maxWidthOrHeight: number = 2048
): Promise<File> {
  // 使用 browser-image-compression 库
  const imageCompression = (window as any).imageCompression
  if (!imageCompression) {
    console.warn('[DirectorPage] imageCompression 库未加载，跳过压缩')
    return file
  }

  const options = {
    maxSizeMB,
    maxWidthOrHeight,
    useWebWorker: true,
    fileType: file.type as 'image/jpeg' | 'image/png' | 'image/webp'
  }

  try {
    console.log(`[DirectorPage] 压缩图片: ${file.name}, 原始大小: ${(file.size / 1024 / 1024).toFixed(2)}MB`)
    const compressedFile = await imageCompression(file, options)
    console.log(`[DirectorPage] 压缩完成: ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`)
    return compressedFile
  } catch (error) {
    console.error('[DirectorPage] 图片压缩失败:', error)
    return file
  }
}
```

**Step 2: 更新 handleSingleImageUpload 使用压缩**

```typescript
// 在 handleSingleImageUpload 方法中添加压缩步骤
const compressedFile = await this.compressImage(file, 1, 2048)
const base64 = await this.fileToBase64(compressedFile)
```

**Step 3: 验证构建**

运行: `npm run build:vite`
预期: 构建成功

---

## Phase 2: 多图结果导航功能

### Task 2.1: 添加结果导航属性

**文件:**
- 修改: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加导航相关属性**

```typescript
// 在类属性区域添加
private currentResultIndex: number = 0
```

### Task 2.2: 添加 showResult 方法（单图模式）

**Step 1: 实现 showResult**

```typescript
/**
 * 显示单图模式结果
 */
private showResult(): void {
  if (this.generatedResults.length === 0) return

  const result = this.generatedResults[0]
  const resultArea = this.getElement<HTMLElement>('directorResultArea')
  const grid = this.getElement<HTMLElement>('directorResultsGrid')
  const emptyState = this.getElement<HTMLElement>('directorEmptyState')

  if (resultArea) resultArea.classList.remove('hidden')
  if (emptyState) emptyState.classList.add('hidden')

  if (grid) {
    grid.classList.remove('hidden')
    grid.innerHTML = this.buildSingleResultHtml(result)
    this.bindResultEvents()
  }
}

/**
 * 构建单图结果 HTML
 */
private buildSingleResultHtml(result: DirectorResult): string {
  if (!result.success) {
    return `
      <div class="col-span-full bg-red-500 bg-opacity-20 rounded-lg p-6 text-center">
        <i class="fas fa-exclamation-triangle text-4xl text-red-400 mb-3"></i>
        <p class="text-white">${this.escapeHtmlText(result.error || '生成失败')}</p>
      </div>
    `
  }

  const imageSrc = this.getImageSrc(result.imageData)
  return `
    <div class="col-span-full">
      <div class="relative bg-[#27272A] rounded-lg overflow-hidden">
        <img src="${imageSrc}" alt="生成结果" 
             class="w-full cursor-pointer hover:opacity-90 transition-opacity"
             onclick="window.directorPage?.previewImage('${imageSrc}')">
        <div class="absolute top-3 right-3 flex space-x-2">
          <button onclick="window.directorPage?.downloadResult()" 
                  class="bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all">
            <i class="fas fa-download"></i>
          </button>
        </div>
      </div>
      <p class="text-white text-sm mt-3 opacity-70">${this.escapeHtmlText(result.prompt || '自动分析')}</p>
    </div>
  `
}
```

### Task 2.3: 添加 showMultiResults 方法（多图模式）

**Step 1: 实现 showMultiResults**

```typescript
/**
 * 显示多图结果（主图 + 缩略图导航）
 */
private showMultiResults(): void {
  if (this.generatedResults.length === 0) return

  const resultArea = this.getElement<HTMLElement>('directorResultArea')
  const grid = this.getElement<HTMLElement>('directorResultsGrid')
  const emptyState = this.getElement<HTMLElement>('directorEmptyState')

  if (resultArea) resultArea.classList.remove('hidden')
  if (emptyState) emptyState.classList.add('hidden')

  // 找到第一个成功的结果
  this.currentResultIndex = this.generatedResults.findIndex(r => r.success)
  if (this.currentResultIndex === -1) this.currentResultIndex = 0

  if (grid) {
    grid.classList.remove('hidden')
    grid.innerHTML = this.buildMultiResultsHtml()
    this.bindResultEvents()
    this.updateCurrentResultDisplay()
  }
}

/**
 * 构建多图结果 HTML
 */
private buildMultiResultsHtml(): string {
  const thumbnails = this.generatedResults.map((result, index) => {
    const isSuccess = result.success
    const imageSrc = isSuccess ? this.getImageSrc(result.imageData) : ''
    const activeClass = index === this.currentResultIndex ? 'ring-2 ring-yellow-400' : ''
    
    return `
      <div class="result-thumbnail cursor-pointer ${activeClass} ${isSuccess ? '' : 'opacity-50'}"
           data-index="${index}"
           onclick="window.directorPage?.switchToResult(${index})">
        ${isSuccess 
          ? `<img src="${imageSrc}" class="w-16 h-16 object-cover rounded">`
          : `<div class="w-16 h-16 bg-red-500 bg-opacity-30 rounded flex items-center justify-center">
               <i class="fas fa-times text-red-400"></i>
             </div>`
        }
      </div>
    `
  }).join('')

  return `
    <div class="col-span-full space-y-4">
      <!-- 主图区域 -->
      <div class="relative bg-[#27272A] rounded-lg overflow-hidden">
        <img id="directorMainResultImage" src="" alt="生成结果" 
             class="w-full cursor-pointer hover:opacity-90 transition-opacity"
             onclick="window.directorPage?.previewCurrentResult()">
        <div class="absolute top-3 right-3 flex space-x-2">
          <button onclick="window.directorPage?.downloadCurrentResult()" 
                  class="bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-full transition-all">
            <i class="fas fa-download"></i>
          </button>
        </div>
        <!-- 左右导航 -->
        <button onclick="window.directorPage?.navigateResult(-1)"
                class="absolute left-3 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full">
          <i class="fas fa-chevron-left"></i>
        </button>
        <button onclick="window.directorPage?.navigateResult(1)"
                class="absolute right-3 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-3 rounded-full">
          <i class="fas fa-chevron-right"></i>
        </button>
      </div>
      
      <!-- 描述 -->
      <p id="directorResultDescription" class="text-white text-sm opacity-70"></p>
      
      <!-- 缩略图导航 -->
      <div class="flex space-x-2 overflow-x-auto py-2">
        ${thumbnails}
      </div>
    </div>
  `
}
```

### Task 2.4: 添加结果导航方法

**Step 1: 实现 switchToResult**

```typescript
/**
 * 切换到指定结果
 */
switchToResult(index: number): void {
  if (index < 0 || index >= this.generatedResults.length) return
  this.currentResultIndex = index
  this.updateCurrentResultDisplay()
}
```

**Step 2: 实现 navigateResult**

```typescript
/**
 * 导航结果（上一张/下一张）
 */
navigateResult(direction: number): void {
  let newIndex = this.currentResultIndex
  const totalResults = this.generatedResults.length
  
  // 循环查找下一个成功的结果
  for (let i = 0; i < totalResults; i++) {
    newIndex = (newIndex + direction + totalResults) % totalResults
    if (this.generatedResults[newIndex].success) {
      this.currentResultIndex = newIndex
      this.updateCurrentResultDisplay()
      return
    }
  }
}
```

**Step 3: 实现 updateCurrentResultDisplay**

```typescript
/**
 * 更新当前结果显示
 */
private updateCurrentResultDisplay(): void {
  const result = this.generatedResults[this.currentResultIndex]
  if (!result) return

  // 更新主图
  const mainImage = document.getElementById('directorMainResultImage') as HTMLImageElement
  if (mainImage && result.success) {
    mainImage.src = this.getImageSrc(result.imageData)
  }

  // 更新描述
  const description = document.getElementById('directorResultDescription')
  if (description) {
    description.textContent = result.prompt || '自动分析'
  }

  // 更新缩略图高亮
  const thumbnails = document.querySelectorAll('.result-thumbnail')
  thumbnails.forEach((thumb, index) => {
    if (index === this.currentResultIndex) {
      thumb.classList.add('ring-2', 'ring-yellow-400')
    } else {
      thumb.classList.remove('ring-2', 'ring-yellow-400')
    }
  })
}
```

**Step 4: 实现 downloadCurrentResult**

```typescript
/**
 * 下载当前显示的结果
 */
downloadCurrentResult(): void {
  const result = this.generatedResults[this.currentResultIndex]
  if (!result?.success) return

  const imageSrc = this.getImageSrc(result.imageData)
  const filename = `comic-panel-${this.currentResultIndex + 1}-${Date.now()}.png`
  this.downloadImage(imageSrc, filename)
}
```

---

## Phase 3: 全屏图片预览

### Task 3.1: 添加 previewImage 方法

**文件:**
- 修改: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 实现 previewImage**

```typescript
/**
 * 全屏预览图片
 */
previewImage(imageSrc: string): void {
  // 创建遮罩层
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 bg-black bg-opacity-90 z-[70000] flex items-center justify-center cursor-pointer'
  overlay.onclick = () => overlay.remove()

  // 创建图片
  const img = document.createElement('img')
  img.src = imageSrc
  img.className = 'max-w-[90vw] max-h-[90vh] object-contain'
  img.onclick = (e) => e.stopPropagation()

  // 关闭按钮
  const closeBtn = document.createElement('button')
  closeBtn.className = 'absolute top-4 right-4 text-white text-3xl hover:text-gray-300'
  closeBtn.innerHTML = '<i class="fas fa-times"></i>'
  closeBtn.onclick = () => overlay.remove()

  overlay.appendChild(img)
  overlay.appendChild(closeBtn)
  document.body.appendChild(overlay)

  // ESC 关闭
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', escHandler)
    }
  }
  document.addEventListener('keydown', escHandler)
}

/**
 * 预览当前结果
 */
previewCurrentResult(): void {
  const result = this.generatedResults[this.currentResultIndex]
  if (result?.success) {
    this.previewImage(this.getImageSrc(result.imageData))
  }
}
```

---

## Phase 4: 清空所有参考图

### Task 4.1: 添加 clearAllReferenceImages 方法

**文件:**
- 修改: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 实现 clearAllReferenceImages**

```typescript
/**
 * 清空所有参考图
 */
clearAllReferenceImages(): void {
  this.referenceImages = []
  this.updateReferenceImagesPreview()
  this.updateGenerateButtonState()
  this.saveCurrentState()
  this.showToast('已清空所有参考图', 'info')
}
```

**Step 2: 更新 updateReferenceImagesPreview 添加"清空全部"按钮**

在预览区域添加"清空全部"按钮的渲染逻辑。

---

## Phase 5: 立即保存状态

### Task 5.1: 添加 saveCurrentStateImmediate 方法

```typescript
/**
 * 立即保存状态（无防抖，用于页面失活时）
 */
private saveCurrentStateImmediate(): void {
  const pageStateManager = (window as any).pageStateManager
  if (pageStateManager?.savePageState) {
    pageStateManager.savePageState('director', this.collectState())
  }
}
```

**Step 2: 在 onDeactivate 中调用**

```typescript
onDeactivate(): void {
  console.log('导演模式页面已失活')
  this.saveCurrentStateImmediate()
}
```

---

## Phase 6: i18n 完善

### Task 6.1: 完善所有 i18n 调用

检查并替换所有硬编码的中文字符串为 `this.t()` 调用。

需要检查的方法：
- `showProgress`
- `renderAssetsSection`
- `showAssetModal`
- `copyModalContent`
- `openTemplateEditor`
- `deleteCurrentTemplate`
- `resetCurrentTemplate`
- 各种 `showToast` 调用

---

## 执行优先级

1. **高优先级（用户体验直接相关）**
   - Phase 2: 多图结果导航（核心功能）
   - Phase 3: 全屏图片预览（常用功能）
   - Phase 4: 清空所有参考图（便捷操作）

2. **中优先级（功能完善）**
   - Phase 1: 图片压缩（性能优化）
   - Phase 5: 立即保存状态（数据安全）

3. **低优先级（锦上添花）**
   - Phase 6: i18n 完善（国际化支持）

---

## 验证清单

- [ ] 图片压缩功能正常工作
- [ ] 多图生成后可以通过缩略图导航切换
- [ ] 左右箭头可以导航到上一张/下一张
- [ ] 点击图片可以全屏预览
- [ ] 点击"清空全部"可以清除所有参考图
- [ ] 页面切换时状态正确保存
- [ ] 所有文字支持 i18n

---

**计划完成时间:** `docs/plans/2026-02-02-director-page-alignment.md`

**执行选项:**

1. **Subagent-Driven (本会话)** - 我逐个任务派发子代理执行，任务间进行代码审查

2. **Parallel Session (新会话)** - 打开新会话使用 executing-plans 批量执行

选择哪种方式？
