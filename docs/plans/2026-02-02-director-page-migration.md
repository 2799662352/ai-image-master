# DirectorPage 完整迁移计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成 DirectorPage.ts 的方法迁移，修复 HTML 中调用的所有缺失方法

**Architecture:** 从原始 director-page.js (2744 行) 迁移缺失的方法到 DirectorPage.ts (1670 行)，确保所有 HTML onclick 事件正常工作

**Tech Stack:** TypeScript, Electron, HTML onclick handlers

---

## 问题分析

### 当前问题

1. **`window.directorPage.addCustomGalleryImage is not a function`** - HTML 调用的方法不存在
2. **"加载模板中..." 一直显示** - 模板渲染方法缺失
3. **示例图库无法展开** - 图库相关方法缺失

### 缺失方法列表 (从 HTML onclick 调用分析)

| 方法名 | 用途 | 优先级 |
|--------|------|--------|
| `addCustomGalleryImage()` | 添加自定义图片到图库 | 高 |
| `deleteSelectedCustomImages()` | 删除选中的自定义图片 | 高 |
| `toggleGalleryEditMode()` | 切换图库编辑模式 | 高 |
| `copyModalContent()` | 复制弹窗内容 | 中 |
| `closeAssetModal()` | 关闭资产弹窗 | 中 |
| `createNewTemplate()` | 创建新模板 | 高 |
| `importTemplates()` | 导入模板 | 中 |
| `exportTemplates()` | 导出模板 | 中 |
| `closeTemplateEditor()` | 关闭模板编辑器 | 高 |
| `deleteCurrentTemplate()` | 删除当前模板 | 中 |
| `resetCurrentTemplate()` | 重置当前模板 | 中 |
| `saveTemplateFromEditor()` | 从编辑器保存模板 | 高 |
| `openTemplateEditor()` | 打开模板编辑器 | 高 |
| `renderTemplateList()` | 渲染模板列表 | 高 |
| `loadBuiltinGallery()` | 加载内置示例图库 | 高 |

---

## Task 1: 添加资产弹窗相关方法

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加缺失的属性声明**

在 DirectorPage 类的属性区域添加：

```typescript
// 资产弹窗相关
private currentModalType: 'analysis' | 'comic' | null = null
private lastAnalysisResult: string = ''
private lastComicPrompt: string = ''
private _modalEscHandler: ((e: KeyboardEvent) => void) | null = null

// 图库编辑模式
private isGalleryEditMode: boolean = false
private selectedCustomImages: Set<string> = new Set()

// 模板编辑
private editingTemplateKey: string | null = null
private editingTemplateIsBuiltin: boolean = false
```

**Step 2: 添加 closeAssetModal 方法**

```typescript
/**
 * 关闭资产弹窗
 */
closeAssetModal(): void {
  const modal = document.getElementById('directorAssetModal')
  if (modal) {
    modal.classList.add('hidden')
  }
  
  if (this._modalEscHandler) {
    document.removeEventListener('keydown', this._modalEscHandler)
    this._modalEscHandler = null
  }
  
  this.currentModalType = null
  console.log('[DirectorPage] 关闭资产弹窗')
}
```

**Step 3: 添加 copyModalContent 方法**

```typescript
/**
 * 复制弹窗内容
 */
async copyModalContent(): Promise<void> {
  const content = this.currentModalType === 'analysis' 
    ? this.lastAnalysisResult 
    : this.lastComicPrompt
  
  if (!content) {
    this.app.showToast?.('没有可复制的内容', 'warning')
    return
  }
  
  try {
    await navigator.clipboard.writeText(content)
    this.app.showToast?.('已复制到剪贴板', 'success')
  } catch (error) {
    console.error('[DirectorPage] 复制失败:', error)
    this.app.showToast?.('复制失败', 'error')
  }
}
```

**Step 4: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 2: 添加图库编辑模式方法

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加 toggleGalleryEditMode 方法**

```typescript
/**
 * 切换图库编辑模式
 */
toggleGalleryEditMode(): void {
  this.isGalleryEditMode = !this.isGalleryEditMode
  
  const editBtn = document.getElementById('galleryEditModeBtn')
  const editActions = document.getElementById('galleryEditActions')
  const confirmBtn = document.querySelector('#galleryModal button[onclick*="confirmGallerySelection"]')
  const cancelBtn = document.querySelector('#galleryModal button[onclick*="hideGalleryModal"]')
  
  if (this.isGalleryEditMode) {
    editBtn?.classList.add('text-[#FCE300]', 'border-[#FCE300]')
    editActions?.classList.remove('hidden')
    if (confirmBtn) (confirmBtn as HTMLElement).classList.add('hidden')
    if (cancelBtn) (cancelBtn as HTMLElement).textContent = '完成'
    this.selectedCustomImages.clear()
    this.updateDeleteButtonState()
  } else {
    editBtn?.classList.remove('text-[#FCE300]', 'border-[#FCE300]')
    editActions?.classList.add('hidden')
    if (confirmBtn) (confirmBtn as HTMLElement).classList.remove('hidden')
    if (cancelBtn) (cancelBtn as HTMLElement).textContent = '取消'
    this.selectedCustomImages.clear()
  }
  
  // 重新渲染图库以显示/隐藏选择框
  this.loadGalleryImages()
}

/**
 * 更新删除按钮状态
 */
private updateDeleteButtonState(): void {
  const deleteBtn = document.getElementById('deleteSelectedBtn') as HTMLButtonElement
  if (deleteBtn) {
    deleteBtn.disabled = this.selectedCustomImages.size === 0
    const countSpan = deleteBtn.querySelector('span')
    if (countSpan && this.selectedCustomImages.size > 0) {
      countSpan.textContent = `删除 (${this.selectedCustomImages.size})`
    }
  }
}
```

**Step 2: 添加 addCustomGalleryImage 方法**

```typescript
/**
 * 添加自定义图库图片
 */
addCustomGalleryImage(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  
  input.onchange = async (e) => {
    const files = (e.target as HTMLInputElement).files
    if (!files || files.length === 0) return
    
    try {
      const customImages = this.loadCustomImagesFromStorage()
      
      for (const file of Array.from(files)) {
        const base64 = await this.fileToBase64(file)
        const imageData = {
          id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: file.name,
          url: base64,
          createdAt: new Date().toISOString()
        }
        customImages.push(imageData)
      }
      
      this.saveCustomImagesToStorage(customImages)
      this.loadGalleryImages()
      this.app.showToast?.(`已添加 ${files.length} 张图片`, 'success')
    } catch (error) {
      console.error('[DirectorPage] 添加图片失败:', error)
      this.app.showToast?.('添加图片失败', 'error')
    }
  }
  
  input.click()
}

/**
 * 从存储加载自定义图片
 */
private loadCustomImagesFromStorage(): any[] {
  try {
    const data = localStorage.getItem('director_custom_gallery')
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

/**
 * 保存自定义图片到存储
 */
private saveCustomImagesToStorage(images: any[]): void {
  localStorage.setItem('director_custom_gallery', JSON.stringify(images))
}

/**
 * 文件转 Base64
 */
private fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
```

**Step 3: 添加 deleteSelectedCustomImages 方法**

```typescript
/**
 * 删除选中的自定义图片
 */
deleteSelectedCustomImages(): void {
  if (this.selectedCustomImages.size === 0) return
  
  if (!confirm(`确定要删除选中的 ${this.selectedCustomImages.size} 张图片吗？`)) {
    return
  }
  
  try {
    const customImages = this.loadCustomImagesFromStorage()
    const filtered = customImages.filter((img: any) => !this.selectedCustomImages.has(img.id))
    this.saveCustomImagesToStorage(filtered)
    
    this.selectedCustomImages.clear()
    this.updateDeleteButtonState()
    this.loadGalleryImages()
    
    this.app.showToast?.('已删除选中的图片', 'success')
  } catch (error) {
    console.error('[DirectorPage] 删除图片失败:', error)
    this.app.showToast?.('删除图片失败', 'error')
  }
}
```

**Step 4: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 3: 添加模板编辑器方法

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加 openTemplateEditor 方法**

```typescript
/**
 * 打开模板编辑器
 */
openTemplateEditor(template: any, isBuiltin: boolean): void {
  const editor = document.getElementById('templateEditorModal')
  if (!editor) return
  
  this.editingTemplateKey = template?.key || null
  this.editingTemplateIsBuiltin = isBuiltin
  
  // 填充表单
  const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
  const contentInput = document.getElementById('templateEditorContent') as HTMLTextAreaElement
  const titleEl = document.getElementById('templateEditorTitle')
  const deleteBtn = document.getElementById('templateEditorDeleteBtn')
  const resetBtn = document.getElementById('templateEditorResetBtn')
  
  if (template) {
    if (nameInput) nameInput.value = template.name || ''
    if (contentInput) contentInput.value = template.prompt || ''
    if (titleEl) titleEl.textContent = '编辑模板'
    
    // 内置模板显示重置按钮，自定义模板显示删除按钮
    if (isBuiltin) {
      deleteBtn?.classList.add('hidden')
      resetBtn?.classList.remove('hidden')
    } else {
      deleteBtn?.classList.remove('hidden')
      resetBtn?.classList.add('hidden')
    }
  } else {
    if (nameInput) nameInput.value = ''
    if (contentInput) contentInput.value = ''
    if (titleEl) titleEl.textContent = '新建模板'
    deleteBtn?.classList.add('hidden')
    resetBtn?.classList.add('hidden')
  }
  
  editor.classList.remove('hidden')
}

/**
 * 关闭模板编辑器
 */
closeTemplateEditor(): void {
  const editor = document.getElementById('templateEditorModal')
  if (editor) {
    editor.classList.add('hidden')
  }
  this.editingTemplateKey = null
  this.editingTemplateIsBuiltin = false
}
```

**Step 2: 添加模板 CRUD 方法**

```typescript
/**
 * 创建新模板
 */
createNewTemplate(): void {
  this.editingTemplateKey = null
  this.editingTemplateIsBuiltin = false
  this.openTemplateEditor(null, false)
}

/**
 * 保存模板
 */
async saveTemplateFromEditor(): Promise<void> {
  const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
  const contentInput = document.getElementById('templateEditorContent') as HTMLTextAreaElement
  
  const name = nameInput?.value?.trim()
  const content = contentInput?.value?.trim()
  
  if (!name || !content) {
    this.app.showToast?.('请填写模板名称和内容', 'warning')
    return
  }
  
  try {
    const userTemplates = this.loadUserTemplatesFromStorage()
    
    if (this.editingTemplateKey) {
      // 编辑现有模板
      const index = userTemplates.findIndex((t: any) => t.key === this.editingTemplateKey)
      if (index >= 0) {
        userTemplates[index].name = name
        userTemplates[index].prompt = content
        userTemplates[index].updatedAt = new Date().toISOString()
      }
    } else {
      // 新建模板
      const newTemplate = {
        key: `user_${Date.now()}`,
        name,
        prompt: content,
        isBuiltin: false,
        createdAt: new Date().toISOString()
      }
      userTemplates.push(newTemplate)
    }
    
    this.saveUserTemplatesToStorage(userTemplates)
    this.closeTemplateEditor()
    await this.loadUserTemplates()
    this.renderTemplateList()
    
    this.app.showToast?.('模板已保存', 'success')
  } catch (error) {
    console.error('[DirectorPage] 保存模板失败:', error)
    this.app.showToast?.('保存模板失败', 'error')
  }
}

/**
 * 删除当前模板
 */
deleteCurrentTemplate(): void {
  if (!this.editingTemplateKey || this.editingTemplateIsBuiltin) return
  
  if (!confirm('确定要删除这个模板吗？')) return
  
  try {
    const userTemplates = this.loadUserTemplatesFromStorage()
    const filtered = userTemplates.filter((t: any) => t.key !== this.editingTemplateKey)
    this.saveUserTemplatesToStorage(filtered)
    
    this.closeTemplateEditor()
    this.loadUserTemplates()
    this.renderTemplateList()
    
    this.app.showToast?.('模板已删除', 'success')
  } catch (error) {
    console.error('[DirectorPage] 删除模板失败:', error)
    this.app.showToast?.('删除模板失败', 'error')
  }
}

/**
 * 重置当前模板（恢复内置模板默认值）
 */
async resetCurrentTemplate(): Promise<void> {
  if (!this.editingTemplateKey || !this.editingTemplateIsBuiltin) return
  
  if (!confirm('确定要恢复此模板的默认值吗？')) return
  
  try {
    // 从内置模板中获取原始值
    const builtinTemplates = await this.loadBuiltinTemplates()
    const original = builtinTemplates.find((t: any) => t.key === this.editingTemplateKey)
    
    if (original) {
      const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
      const contentInput = document.getElementById('templateEditorContent') as HTMLTextAreaElement
      
      if (nameInput) nameInput.value = original.name
      if (contentInput) contentInput.value = original.prompt
      
      this.app.showToast?.('已恢复默认值', 'success')
    }
  } catch (error) {
    console.error('[DirectorPage] 重置模板失败:', error)
    this.app.showToast?.('重置失败', 'error')
  }
}

/**
 * 加载内置模板
 */
private async loadBuiltinTemplates(): Promise<any[]> {
  try {
    const response = await fetch('data/director-templates.json')
    if (response.ok) {
      return await response.json()
    }
  } catch (error) {
    console.error('[DirectorPage] 加载内置模板失败:', error)
  }
  return []
}

/**
 * 从存储加载用户模板
 */
private loadUserTemplatesFromStorage(): any[] {
  try {
    const data = localStorage.getItem('director_user_templates')
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

/**
 * 保存用户模板到存储
 */
private saveUserTemplatesToStorage(templates: any[]): void {
  localStorage.setItem('director_user_templates', JSON.stringify(templates))
}
```

**Step 3: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 4: 添加模板导入导出方法

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加 importTemplates 方法**

```typescript
/**
 * 导入模板
 */
async importTemplates(): Promise<void> {
  try {
    const electronAPI = (window as any).electronAPI
    
    if (electronAPI?.isElectron) {
      const result = await electronAPI.importTemplates?.()
      if (result?.canceled) return
      
      if (result?.success) {
        await this.loadUserTemplates()
        this.renderTemplateList()
        this.app.showToast?.(`已导入 ${result.count || 0} 个模板`, 'success')
      } else {
        this.app.showToast?.('导入失败: ' + (result?.error || '未知错误'), 'error')
      }
    } else {
      // 浏览器环境：使用文件选择
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'
      
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return
        
        try {
          const text = await file.text()
          const imported = JSON.parse(text)
          
          if (!Array.isArray(imported)) {
            throw new Error('无效的模板格式')
          }
          
          const userTemplates = this.loadUserTemplatesFromStorage()
          
          for (const template of imported) {
            if (template.name && template.prompt) {
              userTemplates.push({
                key: `imported_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: template.name,
                prompt: template.prompt,
                isBuiltin: false,
                createdAt: new Date().toISOString()
              })
            }
          }
          
          this.saveUserTemplatesToStorage(userTemplates)
          await this.loadUserTemplates()
          this.renderTemplateList()
          
          this.app.showToast?.(`已导入 ${imported.length} 个模板`, 'success')
        } catch (error) {
          console.error('[DirectorPage] 导入失败:', error)
          this.app.showToast?.('导入失败: 无效的文件格式', 'error')
        }
      }
      
      input.click()
    }
  } catch (error) {
    console.error('[DirectorPage] 导入模板失败:', error)
    this.app.showToast?.('导入失败', 'error')
  }
}
```

**Step 2: 添加 exportTemplates 方法**

```typescript
/**
 * 导出模板
 */
async exportTemplates(): Promise<void> {
  try {
    const userTemplates = this.loadUserTemplatesFromStorage()
    
    if (userTemplates.length === 0) {
      this.app.showToast?.('没有可导出的自定义模板', 'warning')
      return
    }
    
    const electronAPI = (window as any).electronAPI
    
    if (electronAPI?.isElectron) {
      const result = await electronAPI.exportTemplates?.()
      if (result?.canceled) return
      
      if (result?.success) {
        this.app.showToast?.('模板已导出到: ' + result.path, 'success')
      } else {
        this.app.showToast?.('导出失败: ' + (result?.error || '未知错误'), 'error')
      }
    } else {
      // 浏览器环境：下载 JSON 文件
      const dataStr = JSON.stringify(userTemplates, null, 2)
      const blob = new Blob([dataStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      
      const a = document.createElement('a')
      a.href = url
      a.download = `director-templates-${new Date().toISOString().split('T')[0]}.json`
      a.click()
      
      URL.revokeObjectURL(url)
      this.app.showToast?.('模板已导出', 'success')
    }
  } catch (error) {
    console.error('[DirectorPage] 导出模板失败:', error)
    this.app.showToast?.('导出失败', 'error')
  }
}
```

**Step 3: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 5: 添加模板列表渲染方法

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加 renderTemplateList 方法**

```typescript
/**
 * 渲染模板列表
 */
renderTemplateList(): void {
  const loading = document.getElementById('templateListLoading')
  const container = document.getElementById('directorTemplateList')
  
  if (!container) return
  
  // 隐藏加载状态
  if (loading) loading.classList.add('hidden')
  
  // 清空容器
  container.innerHTML = ''
  
  // 合并内置和用户模板
  const allTemplates = [
    ...this.builtinTemplates.map((t: any) => ({ ...t, isBuiltin: true })),
    ...this.userTemplates.map((t: any) => ({ ...t, isBuiltin: false }))
  ]
  
  if (allTemplates.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 text-center py-8 text-[#A1A1AA]">
        <i class="fas fa-folder-open text-4xl mb-4"></i>
        <p>暂无模板</p>
      </div>
    `
    return
  }
  
  for (const template of allTemplates) {
    const card = document.createElement('div')
    card.className = 'bg-[#18181B] border-2 border-[#3F3F46] hover:border-[#FCE300] p-4 cursor-pointer transition-all group'
    card.onclick = () => this.openTemplateEditor(template, template.isBuiltin)
    
    card.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <h4 class="text-[#FAFAFA] font-bold uppercase tracking-tighter group-hover:text-[#FCE300] transition-colors">
          ${this.escapeHtml(template.name)}
        </h4>
        <span class="text-xs px-2 py-0.5 ${template.isBuiltin ? 'bg-[#27272A] text-[#A1A1AA]' : 'bg-[#FCE300] text-black'} rounded-none uppercase">
          ${template.isBuiltin ? '内置' : '自定义'}
        </span>
      </div>
      <p class="text-[#A1A1AA] text-sm line-clamp-3">
        ${this.escapeHtml(template.prompt?.substring(0, 100) || '')}${(template.prompt?.length || 0) > 100 ? '...' : ''}
      </p>
    `
    
    container.appendChild(card)
  }
}

/**
 * HTML 转义
 */
private escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
```

**Step 2: 添加缺失的属性**

在类属性区域添加：

```typescript
private builtinTemplates: any[] = []
private userTemplates: any[] = []
```

**Step 3: 修改 showTemplateModal 方法**

确保打开模板弹窗时渲染列表：

```typescript
showTemplateModal(): void {
  const modal = document.getElementById('directorTemplateModal')
  if (modal) {
    modal.classList.remove('hidden')
    this.loadBuiltinTemplatesAndRender()
  }
}

private async loadBuiltinTemplatesAndRender(): Promise<void> {
  try {
    this.builtinTemplates = await this.loadBuiltinTemplates()
    this.userTemplates = this.loadUserTemplatesFromStorage()
    this.renderTemplateList()
  } catch (error) {
    console.error('[DirectorPage] 加载模板失败:', error)
    this.renderTemplateList() // 显示空状态
  }
}
```

**Step 4: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 6: 添加内置示例图库加载

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 添加内置图库数据和渲染**

更新 `loadGalleryImages` 方法以支持内置示例：

```typescript
/**
 * 加载图库图片（包含自定义和内置示例）
 */
loadGalleryImages(): void {
  // 加载自定义图片
  this.loadCustomGalleryImages()
  
  // 加载内置示例
  this.loadBuiltinGalleryImages()
}

/**
 * 加载内置示例图库
 */
private async loadBuiltinGalleryImages(): Promise<void> {
  const container = document.getElementById('builtinGalleryGrid')
  const countEl = document.getElementById('builtinImageCount')
  
  if (!container) return
  
  try {
    // 尝试加载示例图库数据
    const response = await fetch('data/gallery-examples.json')
    let examples: any[] = []
    
    if (response.ok) {
      examples = await response.json()
    } else {
      // 使用默认示例
      examples = this.getDefaultGalleryExamples()
    }
    
    if (countEl) {
      countEl.textContent = `(${examples.length})`
    }
    
    container.innerHTML = ''
    
    for (const example of examples) {
      const item = document.createElement('div')
      item.className = 'gallery-item relative cursor-pointer group'
      item.onclick = () => this.toggleGalleryImageSelection(example.url, example.name)
      
      item.innerHTML = `
        <img src="${example.url}" alt="${this.escapeHtml(example.name)}" 
             class="w-full h-24 object-cover rounded border-2 border-transparent group-hover:border-[#FCE300] transition-all"
             loading="lazy">
        <div class="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs p-1 truncate">
          ${this.escapeHtml(example.name)}
        </div>
      `
      
      container.appendChild(item)
    }
  } catch (error) {
    console.error('[DirectorPage] 加载内置示例失败:', error)
    container.innerHTML = '<p class="text-[#A1A1AA] text-sm">加载示例失败</p>'
  }
}

/**
 * 获取默认示例图库
 */
private getDefaultGalleryExamples(): any[] {
  // 返回一些默认的示例图片占位符
  return [
    { name: '示例 1', url: 'data:image/svg+xml,...' },
    // 可以添加更多默认示例
  ]
}
```

**Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

---

## Task 7: 创建缺失的数据文件

**Files:**
- Create: `src/renderer/public/data/director-templates.json`
- Create: `src/renderer/public/data/gallery-examples.json`

**Step 1: 从原始项目复制模板数据**

检查原始项目是否有这些数据文件，如果有则复制，如果没有则创建默认数据。

**Step 2: 验证文件可访问**

启动应用并检查开发者工具 Network 面板，确认数据文件可以正常加载。

---

## Task 8: 最终测试和验证

**Step 1: 构建应用**

Run: `npm run build:vite`
Expected: 构建成功，无错误

**Step 2: 启动应用**

Run: `npm run dev`
Expected: 应用正常启动

**Step 3: 功能测试清单**

- [ ] 导演模式页面可以正常打开
- [ ] 模板弹窗可以打开，显示模板列表
- [ ] "加载模板中..." 不再一直显示
- [ ] 可以创建新模板
- [ ] 可以编辑现有模板
- [ ] 可以导入/导出模板
- [ ] 示例图库可以展开并显示图片
- [ ] 可以添加自定义图片到图库
- [ ] 可以删除自定义图片
- [ ] 资产弹窗可以正常关闭
- [ ] 复制功能正常工作

**Step 4: 提交代码**

```bash
git add .
git commit -m "feat: complete DirectorPage method migration from JS to TypeScript

- Add asset modal methods (closeAssetModal, copyModalContent)
- Add gallery edit mode methods (toggleGalleryEditMode, addCustomGalleryImage, deleteSelectedCustomImages)
- Add template editor methods (openTemplateEditor, closeTemplateEditor, createNewTemplate, saveTemplateFromEditor, deleteCurrentTemplate, resetCurrentTemplate)
- Add template import/export methods
- Add template list rendering
- Add builtin gallery loading
- Fix all HTML onclick handler errors"
```

---

## 执行时间估计

| Task | 估计时间 |
|------|---------|
| Task 1: 资产弹窗方法 | 10 分钟 |
| Task 2: 图库编辑模式 | 15 分钟 |
| Task 3: 模板编辑器 | 20 分钟 |
| Task 4: 导入导出 | 15 分钟 |
| Task 5: 模板列表渲染 | 15 分钟 |
| Task 6: 内置示例图库 | 10 分钟 |
| Task 7: 数据文件 | 5 分钟 |
| Task 8: 测试验证 | 10 分钟 |
| **总计** | **~100 分钟** |
