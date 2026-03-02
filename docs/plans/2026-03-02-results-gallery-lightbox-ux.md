# ResultsGallery — Lightbox + UI/UX 优化设计文档

**目标：** 修复缩略图点击无法展示大图的问题，同时全面优化结果展示区的 UI/UX。

**架构：** 在 `ResultsGallery.tsx` 单文件内实现，新增 `lightboxIndex` state，复用 `ReferenceImageUpload` 的 lightbox 模式作为参考。

**技术栈：** React + TypeScript + Tailwind CSS，无外部依赖。

---

## 方案 A（采用）— 渐进增强型

### 问题 1：缩略图点击无法展示大图
**根因：** 当前 `onClick={() => setCurrentIndex(idx)}` 只切换主预览图，无全屏 lightbox。
**修复：** 新增 `lightboxIndex` state；点击主图或缩略图均触发 `setLightboxIndex(idx)`。

### 问题 2：UI/UX 待优化点
- 缩略图 `w-14 h-14`（56px）太小 → 升级为 `w-20 h-20`（80px），加序号角标
- 主图无点击提示 → 添加 hover 放大镜蒙版 + `cursor-pointer`
- 无 prompt 展示 → 主图下方显示当前 prompt（可截断）
- 无"下载全部" → header 右侧添加批量下载
- 无序号标识 → 主图左上角显示 "N/Total"

### Lightbox 功能
- 全屏黑底蒙层（`z-[60000]`，与其他 modal 同级）
- 键盘导航：← → Esc
- 底部缩略图条：高亮当前选中项
- 底部信息栏：prompt 截断 + 下载按钮（黄色 `#FCE300`）
- 左上角序号：N / Total

---

## 文件修改

| 文件 | 改动类型 |
|------|---------|
| `src/renderer/src/react-app/components/ResultsGallery.tsx` | 修改（全量替换） |
