# i18n 完整对齐升级计划

> **状态:** ✅ 已完成 (2026-02-02)

**Goal:** 彻底解决项目中所有 i18n 翻译缺失问题，确保代码中使用的翻译键在 zh-CN.json 和 en.json 中都存在

**Architecture:** 分析代码中所有 `this.t()` 调用，对比现有翻译文件，补全所有缺失的键

**Tech Stack:** TypeScript, JSON (i18n), Vite

---

## 执行记录

### 2026-02-02 完成的修复

| 修复项 | 状态 |
|--------|------|
| Phase 1: director.templates.styles.* 翻译键 | ✅ 完成 |
| Phase 2: director.templates.* 其他缺失键 | ✅ 完成 |
| Phase 2: director.gallery.* 翻译键 | ✅ 完成 |
| Phase 2: director.labels.* 翻译键 | ✅ 完成 |
| Phase 2: director.layouts.*.name/description 翻译键 | ✅ 完成 |
| Phase 2: director.messages.* 翻译键 (50+) | ✅ 完成 |
| Phase 2: director.progress.* 翻译键 | ✅ 完成 |
| Phase 2: director.prompts.* 翻译键 | ✅ 完成 |
| Phase 3: history.messages.* 缺失键 | ✅ 完成 |
| Phase 4: common.* 翻译键 | ✅ 完成 |
| Phase 5: en.json 同步 | ✅ 完成 |

---

## 问题分析

### 根本原因

1. **翻译键结构不匹配**: 代码使用 `director.templates.styles.anime`，但 JSON 结构是 `director.templates.anime.name`
2. **缺失翻译键**: 大量新功能的翻译键未添加到翻译文件
3. **代码与翻译不同步**: TypeScript 迁移时添加了新的翻译键，但未同步更新翻译文件

### 影响范围

- DirectorPage: 约 100+ 个翻译键需要检查
- HistoryPage: 约 30+ 个翻译键需要检查
- 其他页面: 少量翻译键

---

## Phase 1: 修复 DirectorPage 模板名称显示问题 (高优先级)

### Task 1.1: 添加 director.templates.styles.* 翻译键

**文件:**
- 修改: `src/renderer/public/i18n/zh-CN.json`
- 修改: `src/renderer/public/i18n/en.json`

**缺失的键 (代码使用 vs 现有结构):**

| 代码使用的键 | 现有结构 | 需要添加 |
|-------------|----------|---------|
| `director.templates.styles.anime` | `director.templates.anime.name` | ✅ |
| `director.templates.styles.manga` | `director.templates.manga.name` | ✅ |
| `director.templates.styles.movie` | `director.templates.movie.name` | ✅ |
| `director.templates.styles.webtoon` | `director.templates.webtoon.name` | ✅ |
| `director.templates.styles.comic` | `director.templates.comic.name` | ✅ |
| `director.templates.styles.illustration` | `director.templates.illustration.name` | ✅ |

**Step 1: 在 zh-CN.json 的 director.templates 中添加 styles 对象**

在 `director.templates` 对象中添加：

```json
"styles": {
  "anime": "动画截图风格",
  "manga": "漫画分镜风格",
  "movie": "电影分镜风格",
  "webtoon": "韩漫/条漫风格",
  "comic": "美漫风格",
  "illustration": "插画风格"
}
```

**Step 2: 在 en.json 的 director.templates 中添加 styles 对象**

```json
"styles": {
  "anime": "Anime Screenshot Style",
  "manga": "Manga Panel Style",
  "movie": "Movie Storyboard Style",
  "webtoon": "Webtoon/Scroll Style",
  "comic": "American Comic Style",
  "illustration": "Illustration Style"
}
```

---

## Phase 2: 添加 DirectorPage 缺失的翻译键

### Task 2.1: 添加 director.templates.* 其他缺失键

**需要添加的键:**

```json
{
  "director.templates.noTemplates": "暂无模板",
  "director.templates.modified": "已修改",
  "director.templates.builtin": "内置",
  "director.templates.custom": "自定义",
  "director.templates.default": "默认（无模板）",
  "director.templates.editTemplate": "编辑模板",
  "director.templates.newTemplate": "新建模板"
}
```

### Task 2.2: 添加 director.gallery.* 翻译键

```json
{
  "director.gallery.clickToAddImages": "点击上方按钮添加您的图片",
  "director.gallery.exampleImage": "示例图片 {index}"
}
```

### Task 2.3: 添加 director.labels.* 翻译键

```json
{
  "director.labels.referenceImages": "参考图",
  "director.labels.autoAnalysis": "自动分析",
  "director.labels.directorModeAutoAnalysis": "导演模式 - 自动分析",
  "director.labels.sceneCount": "{count} 个场景",
  "director.labels.imageCountDisplay": "{count}张",
  "director.labels.comicPanel": "漫画分镜 {index}",
  "director.labels.generateSuccess": "生成成功",
  "director.labels.generateFailed": "生成失败",
  "director.labels.successCount": "成功 {success}/{total} 张",
  "director.labels.currentImage": "第 {current}/{total} 张",
  "director.labels.generatedComicPage": "生成的漫画页面",
  "director.labels.imageNumber": "第{index}张"
}
```

### Task 2.4: 添加 director.layouts.*.name 和 .description 翻译键

```json
{
  "director.layouts.6grid.name": "6格标准",
  "director.layouts.6grid.description": "2行×3列，适合完整故事",
  "director.layouts.4grid.name": "4格方正",
  "director.layouts.4grid.description": "2行×2列，适合转折场景",
  "director.layouts.2closeup.name": "2格特写",
  "director.layouts.2closeup.description": "1行×2列，适合表情特写",
  "director.layouts.9grid.name": "9格全景",
  "director.layouts.9grid.description": "3行×3列，适合动作场景"
}
```

### Task 2.5: 添加 director.messages.* 翻译键

```json
{
  "director.messages.maxSelectImages": "最多选择 {max} 张图片",
  "director.messages.selectAtLeastOne": "请选择至少一张图片",
  "director.messages.loadingImages": "正在加载 {count} 张图片...",
  "director.messages.addedReferenceImages": "已添加 {count} 张参考图",
  "director.messages.maxUploadImages": "最多上传 {max} 张参考图",
  "director.messages.uploadedImages": "已上传 {count} 张图片",
  "director.messages.clearedAllReferenceImages": "已清空所有参考图",
  "director.messages.templateSelected": "已选择「{name}」模板",
  "director.messages.uploadReferenceFirst": "请先上传参考图",
  "director.messages.configureApiKey": "请先在设置中配置 API Key",
  "director.messages.generateSuccess": "成功生成 {success}/{total} 张漫画页面！",
  "director.messages.allGenerationFailed": "所有图片生成失败，请重试",
  "director.messages.generateFailed": "生成失败: ",
  "director.messages.generateFailedShort": "生成失败",
  "director.messages.enterAtLeastOneScene": "请输入至少一个场景描述",
  "director.messages.batchGenerateSuccess": "批量生成完成！成功 {success}/{total} 张",
  "director.messages.batchGenerateFailed": "批量生成失败: ",
  "director.messages.noDownloadableImages": "没有可下载的图片",
  "director.messages.startDownloading": "开始下载 {count} 张图片...",
  "director.messages.cannotDownloadCurrent": "当前图片无法下载",
  "director.messages.noCopyContent": "没有可复制的内容",
  "director.messages.addedImages": "已添加 {count} 张图片",
  "director.messages.addImagesFailed": "添加图片失败",
  "director.messages.confirmDeleteImages": "确定要删除选中的 {count} 张图片吗？",
  "director.messages.deletedSelectedImages": "已删除选中的图片",
  "director.messages.deleteImagesFailed": "删除图片失败",
  "director.messages.enterTemplateName": "请填写模板名称",
  "director.messages.templateSaved": "模板已保存",
  "director.messages.templateSaveFailed": "保存模板失败",
  "director.messages.confirmDeleteTemplate": "确定要删除这个模板吗？",
  "director.messages.templateDeleted": "模板已删除",
  "director.messages.templateDeleteFailed": "删除模板失败",
  "director.messages.confirmResetTemplate": "确定要恢复此模板的默认值吗？",
  "director.messages.restoredDefaults": "已恢复默认值",
  "director.messages.resetFailed": "重置失败",
  "director.messages.templatesImported": "已导入模板",
  "director.messages.importFailed": "导入失败: ",
  "director.messages.importedTemplatesCount": "已导入 {count} 个模板",
  "director.messages.importFailedInvalidFormat": "导入失败: 无效的文件格式",
  "director.messages.noTemplatesToExport": "没有可导出的自定义模板",
  "director.messages.templatesExportedTo": "模板已导出到: ",
  "director.messages.exportFailed": "导出失败: ",
  "director.messages.templatesExported": "模板已导出"
}
```

### Task 2.6: 添加 director.progress.* 翻译键

```json
{
  "director.progress.analyzingWithCount": "正在分析参考图... (将生成 {count} 张)",
  "director.progress.analyzingReference": "正在分析参考图...",
  "director.progress.generatingPrompt": "正在生成分镜提示词...",
  "director.progress.generatingComic": "正在生成第 {current}/{total} 张漫画...",
  "director.progress.buildingPrompt": "生成第 {current}/{total} 张：构建提示词...",
  "director.progress.generatingImage": "生成第 {current}/{total} 张：生成图片...",
  "director.progress.analysisTitle": "参考图分析结果",
  "director.progress.promptTitle": "生成的提示词",
  "director.progress.noAnalysis": "未进行图像分析",
  "director.progress.step": "步骤 {current}/{total}"
}
```

### Task 2.7: 添加 director.assets.* 翻译键

```json
{
  "director.assets.analysisCard": "图像分析",
  "director.assets.promptCard": "生成提示词",
  "director.assets.clickToView": "点击查看"
}
```

### Task 2.8: 添加 director.prompts.* 翻译键

```json
{
  "director.prompts.defaultSceneDescription": "请详细描述图片中的场景、人物、环境和氛围。",
  "director.prompts.analyzeMultipleImages": "请分析这 {count} 张参考图片，描述其中的人物特征、场景环境、艺术风格等关键元素。",
  "director.prompts.analyzeSingleImage": "请详细分析这张参考图片，描述其中的人物特征、场景环境、艺术风格等关键元素。"
}
```

---

## Phase 3: 添加 HistoryPage 缺失的翻译键

### Task 3.1: 添加 history.networkRestricted.* 翻译键

```json
{
  "history.networkRestricted.title": "网络受限",
  "history.networkRestricted.description": "由于网络环境限制，图片无法直接显示",
  "history.networkRestricted.explanationTitle": "为什么会出现这个问题？",
  "history.networkRestricted.solutionTitle": "解决方案",
  "history.networkRestricted.solutionItem1": "使用代理或VPN访问",
  "history.networkRestricted.solutionItem2": "手动复制链接到浏览器打开",
  "history.networkRestricted.solutionItem3": "使用其他网络环境",
  "history.networkRestricted.solutionItem4": "等待网络恢复",
  "history.networkRestricted.imageAddresses": "图片地址",
  "history.networkRestricted.imageLabel": "图片 {index}",
  "history.networkRestricted.instruction": "复制以下地址到浏览器打开：",
  "history.networkRestricted.copy": "复制",
  "history.networkRestricted.copyAll": "复制全部",
  "history.networkRestricted.open": "打开",
  "history.networkRestricted.retry": "重试加载",
  "history.networkRestricted.close": "关闭"
}
```

### Task 3.2: 添加 history.downloadHelp.* 翻译键

```json
{
  "history.downloadHelp.title": "如何下载图片",
  "history.downloadHelp.message": "由于浏览器安全限制，无法直接下载跨域图片",
  "history.downloadHelp.stepsTitle": "请按以下步骤操作：",
  "history.downloadHelp.step1": "点击「查看图片」按钮打开图片",
  "history.downloadHelp.step2": "在新标签页中右键点击图片",
  "history.downloadHelp.step3": "选择「图片另存为...」",
  "history.downloadHelp.step4": "选择保存位置并保存",
  "history.downloadHelp.viewImages": "查看图片",
  "history.downloadHelp.understood": "我知道了"
}
```

### Task 3.3: 添加 history.storage.* 翻译键

```json
{
  "history.storage.cloud": "云端",
  "history.storage.local": "本地",
  "history.storage.cloudModeTitle": "安全云端存储",
  "history.storage.localModeTitle": "本地浏览器存储",
  "history.storage.uploading": "上传中..."
}
```

### Task 3.4: 添加 history.types.* 翻译键

```json
{
  "history.types.networkRestricted": "网络受限",
  "history.types.pending": "待处理",
  "history.types.winner": "最佳"
}
```

### Task 3.5: 添加 history.messages.* 缺失键

```json
{
  "history.messages.migrating": "正在迁移到云端...",
  "history.messages.downloadStarting": "开始下载...",
  "history.messages.downloading": "下载中...",
  "history.messages.downloadComplete": "下载完成",
  "history.messages.notFound": "未找到记录",
  "history.messages.deleted": "已删除",
  "history.messages.cloudUnavailable": "云端存储不可用",
  "history.messages.confirmClearCache": "确定要清理缓存吗？这将删除所有本地缓存数据。",
  "history.messages.cacheCleared": "缓存已清理",
  "history.messages.cacheClearFailed": "清理缓存失败"
}
```

---

## Phase 4: 添加通用翻译键

### Task 4.1: 添加 common.* 翻译键

```json
{
  "common.copySuccess": "已复制到剪贴板",
  "common.copyFailed": "复制失败",
  "common.unknownError": "未知错误"
}
```

---

## Phase 5: 同步英文翻译

### Task 5.1: 为所有新增的中文翻译键添加对应的英文翻译

将 Phase 1-4 中所有新增的键同步添加到 en.json，使用对应的英文翻译。

---

## 验证清单

- [ ] director.templates.styles.* 显示正确的模板名称
- [ ] 所有 director.* 键不再显示为大写原始键名
- [ ] 所有 history.* 键翻译正确
- [ ] 切换中英文时所有文本正确显示
- [ ] 运行 `npm run build:vite` 构建成功

---

## 执行步骤

1. 执行 Phase 1 修复模板名称显示问题
2. 执行 Phase 2-4 添加所有缺失的翻译键
3. 执行 Phase 5 同步英文翻译
4. 运行构建并验证

---

**计划完成时间:** `docs/plans/2026-02-02-i18n-complete-alignment.md`

**执行选项:**

1. **立即执行** - 我现在直接修复所有缺失的翻译键
2. **分阶段执行** - 按 Phase 逐步执行，每个阶段后验证

选择哪种方式？
