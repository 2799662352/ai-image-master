# 跨页面分镜数据流 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 图像理解页面的分镜分析结果（JSON）可以一键导入导演模式，自动填充场景描述、参考图和模板参数。

**Architecture:** 在 UnderstandPage 分析完成后显示"导入到导演模式"按钮。点击后通过 window.appServices 跨页面通信，将 StoryboardResponse JSON 转换为 DirectorPage 可消费的数据格式，然后自动切换到导演模式 tab。

**Tech Stack:** TypeScript, TabManager (现有), window.appServices (现有)

---

### Task 1: 定义转换函数 StoryboardResponse → DirectorInput

**Files:**
- Create: `src/renderer/src/services/StoryboardToDirectorAdapter.ts`

**Step 1: 创建转换函数**

```typescript
import type { StoryboardResponse } from './LangChainStoryboardService'

export interface DirectorImportData {
  sceneDescription: string
  referenceImageBase64?: string
  referenceImageMimeType?: string
  templateNegative?: string
}

export function convertStoryboardToDirector(
  response: StoryboardResponse,
  sourceImageBase64?: string,
  sourceImageMimeType?: string
): DirectorImportData {
  const sceneLines: string[] = []

  // 叙事弧线
  if (response.scene.d) sceneLines.push(response.scene.d)

  // 角色描述（从 objs 提取）
  for (const obj of response.objs) {
    sceneLines.push(`[${obj.n}] ${obj.f} | 动机: ${obj.motive}`)
  }

  // 镜头序列（从 seq 提取台词和动作）
  for (const shot of response.seq) {
    sceneLines.push(`${shot.id}: ${shot.desc}`)
  }

  return {
    sceneDescription: sceneLines.join('\n'),
    referenceImageBase64: sourceImageBase64,
    referenceImageMimeType: sourceImageMimeType,
    templateNegative: undefined
  }
}
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/src/services/StoryboardToDirectorAdapter.ts
git commit -m "feat: add StoryboardToDirector adapter for cross-page data flow"
```

---

### Task 2: UnderstandPage 添加"导入到导演模式"按钮

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 在 LangChain 分析成功后，保存结果并显示导入按钮**

在 `analyzeImages()` 的 LangChain 成功路径中（`this.showToast('LangChain 结构化分析完成！')` 之后），添加：

```typescript
// 保存结构化结果供导入使用
this._lastStoryboardResult = result
this._lastAnalyzedImages = images
this.showImportToDirectorButton()
```

新增方法：

```typescript
private _lastStoryboardResult: any = null
private _lastAnalyzedImages: Array<{base64: string; mimeType: string}> = []

private showImportToDirectorButton(): void {
  const resultArea = document.getElementById('understandResultArea')
  if (!resultArea) return

  const existingBtn = document.getElementById('importToDirectorBtn')
  if (existingBtn) existingBtn.remove()

  const btn = document.createElement('button')
  btn.id = 'importToDirectorBtn'
  btn.className = 'mt-4 px-6 py-3 bg-[#FCE300] text-black font-bold rounded-lg hover:bg-yellow-400 transition-colors flex items-center gap-2'
  btn.innerHTML = '<i class="fas fa-film"></i> 导入到导演模式'
  btn.onclick = () => this.importToDirector()
  resultArea.appendChild(btn)
}

private async importToDirector(): Promise<void> {
  if (!this._lastStoryboardResult) return

  const { convertStoryboardToDirector } = await import('../services/StoryboardToDirectorAdapter')
  const importData = convertStoryboardToDirector(
    this._lastStoryboardResult,
    this._lastAnalyzedImages[0]?.base64,
    this._lastAnalyzedImages[0]?.mimeType
  )

  // 通过 TabManager 切换到导演模式
  const tabManager = window.appServices?.features?.tabManager
  if (tabManager) {
    // 存储导入数据到 sessionStorage 供 DirectorPage 读取
    sessionStorage.setItem('director_import_data', JSON.stringify(importData))
    tabManager.switchTab('director')
    this.showToast('已导入到导演模式', 'success')
  }
}
```

**Step 2: Build 验证**

**Step 3: Commit**

```bash
git add src/renderer/src/pages/UnderstandPage.ts
git commit -m "feat: add import-to-director button after storyboard analysis"
```

---

### Task 3: DirectorPage 读取导入数据

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 在页面激活时检查 sessionStorage 导入数据**

在 DirectorPage 的 `onActivate()` 或初始化流程中添加：

```typescript
private checkForImportData(): void {
  const importJson = sessionStorage.getItem('director_import_data')
  if (!importJson) return

  sessionStorage.removeItem('director_import_data')

  try {
    const data = JSON.parse(importJson)

    // 填充场景描述
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    if (sceneInput && data.sceneDescription) {
      sceneInput.value = data.sceneDescription
      sceneInput.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // 如果有参考图，自动添加
    if (data.referenceImageBase64) {
      this.addReferenceImageFromBase64(data.referenceImageBase64, data.referenceImageMimeType || 'image/jpeg')
    }

    this.showToast(this.t('director.messages.importSuccess') || '分镜数据已导入', 'success')
    console.log('[DirectorPage] 已从图像理解页面导入分镜数据')
  } catch (e) {
    console.error('[DirectorPage] 导入数据解析失败:', e)
  }
}

private addReferenceImageFromBase64(base64: string, mimeType: string): void {
  if (this.referenceImages.length >= this.maxReferenceImages) return
  this.referenceImages.push({
    base64,
    mimeType,
    fileName: 'imported_from_understand.jpg',
    fileSize: Math.round(base64.length * 0.75),
    compressed: true
  })
  this.updateReferenceImagesPreview()
}
```

**Step 2: 在页面激活回调中调用**

找到 `onActivate` 或 `activate` 方法，添加 `this.checkForImportData()`。

**Step 3: Build 验证**

**Step 4: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "feat: DirectorPage reads import data from UnderstandPage via sessionStorage"
```

---

### Task 4: 构建 + 运行时验证

**Step 1: Build**

Run: `npm run build:vite`

**Step 2: 运行时验证清单**

1. 打开图像理解 → 选 Sora分镜 → 上传图片 + 剧本 → 分析
2. 分析完成后，结果区域下方出现黄色"导入到导演模式"按钮
3. 点击按钮 → 自动切换到导演模式 tab
4. 导演模式的场景描述已填充分镜数据
5. 参考图已自动添加
6. 可以直接生成九宫格

**Step 3: Commit + Build**

```bash
git add -A
git commit -m "feat: cross-page storyboard data flow (understand → director)"
```

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 跨页面通信方式 | sessionStorage | 简单、同步、无需新 IPC，页面切换后立即可读 |
| 数据格式 | DirectorImportData | 最小化接口，只传必要字段 |
| 参考图传递 | base64 直接传 | 图片已在内存中，不需要重新读取文件 |
| 导入按钮位置 | 结果区域底部 | 用户完成分析后自然看到 |
| 清理时机 | DirectorPage 读取后立即 remove | 避免重复导入 |
