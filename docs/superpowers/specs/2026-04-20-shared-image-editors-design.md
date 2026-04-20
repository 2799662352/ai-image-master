# Shared Image Editors — Design Spec

**Date:** 2026-04-20  
**Status:** Draft v2 — awaiting user review  
**Scope:** Phase 1 of 3 (全量功能，分三期接入)

---

## 1. What These Editors Actually Are

源项目的两个编辑器本质是**可视化 prompt 构造器**，不是图像处理工具：

| 层 | 做了什么 |
|---|---|
| **UI 层** | 滑杆、方向按钮、预设、色温选择 — 高质量交互体验 |
| **Three.js 层** | 纯前端 3D 预览（地球仪贴图/灯光场景），帮用户直观理解参数含义。不参与生图。 |
| **Prompt 层** | `buildCameraPrompt(h, v, z)` → 一句英文描述，如 "Rotate the camera to view this subject from the front, at eye level, at a medium distance." |
| **API 层（源项目）** | 把 prompt + 原图发给 Gemini。**我们不搬这层。** |

**目标：** 把编辑器作为**提示词辅助工具**植入三个页面。用户调好参数 → 编辑器把构造好的英文 prompt **注入到宿主页的 prompt 输入框** → 用户可以继续编辑 → 用现有"生成"按钮走现有 workflow。

---

## 2. Design Decision: Prompt 辅助模式（B 模式）

编辑器**不**直接调 API，**不**自行生成图片。它只输出一段 prompt 字符串。

为什么选 B 而不选 A（即时生成）或 C（A+B）：
- 生图走现有 pipeline = 自动复用 API key、模型选择、频率限制、历史记录
- 用户保持对最终 prompt 的完全控制权（可以编辑/追加/删掉再来）
- 无需 `image-edit-service.ts`、无需 `appendResult`、无需 store 改动 → 大幅简化
- 编辑器是纯 UI 组件，零网络依赖，测试容易

---

## 3. Architecture

### 3.1 共享模块

```
src/renderer/src/components/shared/image-editors/
├── MultiAngleEditor.tsx        # 移植（剥 "use client" / Next.js 路径）
├── LightEditor.tsx             # 同上
├── ThreeGlobe.tsx              # Three.js 3D 地球仪 (lazy)
├── ThreeLightScene.tsx         # Three.js 灯光场景 (lazy)
├── orbitGlobeShared.ts         # Three.js 共享场景构建器（球壳/网格/snap 点）
├── prompts.ts                  # buildCameraPrompt / buildLightingPrompt 纯函数
├── ImageEditToolbar.tsx        # hover 浮动工具条 (theme: 'punk' | 'default')
└── ImageEditorModal.tsx        # 弹窗外壳 (theme prop)
```

**不再需要 `image-edit-service.ts`** — 没有 API 调用层。

> **关键依赖：** `ThreeGlobe.tsx` 和 `ThreeLightScene.tsx` 都 import
> `orbitGlobeShared.ts`（≈200 行，含球壳着色器、网格线、snap 点生成器）。
> 漏搬此文件两个 3D 组件无法编译。

### 3.2 数据流

```
图片卡片 hover
  └─► [工具条已开] → ImageEditToolbar 浮现 [多角度] [打光]
       │
       └─► 点击 → ImageEditorModal 打开 (MultiAngleEditor | LightEditor)
                │
                ├── Three.js 3D 实时预览（纯前端，零网络）
                ├── 用户调参（滑杆/方向选择/预设）
                ├── 实时预览 prompt 文本（编辑器底部显示当前英文 prompt）
                │
                └── 点击 [注入 Prompt]
                      │
                      ├── 调 onInjectPrompt(promptText) 回调
                      │     │
                      │     └─► 宿主页收到 promptText
                      │           │
                      │           ├── #batch: useBatchStore.getState().setPrompt(
                      │           │     currentPrompt + '\n' + promptText
                      │           │   )
                      │           │
                      │           ├── #generate: useGenerateStore.getState().setPrompt(
                      │           │     currentPrompt + '\n' + promptText
                      │           │   )
                      │           │
                      │           └── #director: setLocalPrompt(
                      │                 currentPrompt + '\n' + promptText
                      │               )
                      │
                      └── 关闭 Modal（或保持打开让用户继续调参 → 再次注入）
```

注入策略：**追加到现有 prompt 末尾**（用 `\n` 换行分隔），不覆盖用户已写的内容。

### 3.3 Editor 输出接口

两个编辑器都通过 `onInjectPrompt` 回调输出，签名统一：

```typescript
interface EditorProps {
  imageUrl?: string           // 当前选中图片 URL（给 Three.js 贴图用）
  onInjectPrompt: (prompt: string) => void  // 注入 prompt 到宿主页
  onClose: () => void
}
```

编辑器内部调用 `prompts.ts` 的纯函数构造 prompt：

```typescript
// prompts.ts — 完整移植，零改动
export function buildCameraPrompt(horizontal: number, vertical: number, distance: number): string
export function buildLightingPrompt(direction: string, brightness: number, color: string, rimLight: boolean): string
```

### 3.4 theme 规格

| 属性 | `punk`（#batch）| `default`（#generate / #director）|
|------|----------------|----------------------------------|
| 工具条背景 | `var(--punk-cream)` + 粗黑描边 | `bg-zinc-800 border border-zinc-600` |
| 工具条按钮 | `p-sticker` 风格 | `rounded-md bg-zinc-700 hover:bg-zinc-600` |
| 弹窗外壳 | `var(--punk-bg)` + `6px` 偏移硬投影 | `bg-zinc-900 rounded-xl shadow-2xl` |
| 内部 Editor panel | 中性深灰（源项目原配色，两套 theme 共用） | 同左 |
| [注入 Prompt] 按钮 | `var(--punk-pink)` 底 + 粗描边 | `bg-blue-600 hover:bg-blue-500 rounded-lg` |

### 3.5 UI 偏好 Store

```
src/renderer/src/stores/useUIPrefsStore.ts
```

- Zustand store + `persist` middleware（localStorage，key: `ui-prefs`）
- 字段：`imageEditorToolbar: { enabled: boolean }`，默认 `true`
- 三个页面的工具条统一受此开关控制

---

## 4. Per-Page Integration

### 4.1 #batch — PunkResultGrid

- 每个结果图卡片外层加 `group` 类
- hover 显示 `<ImageEditToolbar theme="punk" imageUrl={url} onInjectPrompt={injectFn} />`
- `injectFn` = `(p) => useBatchStore.getState().setPrompt(current + '\n' + p)`
- 工具条定位：`absolute top-1 left-1/2 -translate-x-1/2 z-20`
- 点击后 Modal 打开，用户调参 → [注入 Prompt] → prompt 自动出现在 batch 页的输入框里
- 用户如常点"生成"跑现有 batch workflow

### 4.2 #generate — ResultGrid

- `ResultGrid` 改为接受 `onInjectPrompt?: (prompt: string) => void` prop
- `GeneratePage` 传入：`(p) => useGenerateStore.getState().setPrompt(current + '\n' + p)`
- 工具条 `default` 主题
- 用户如常点"生成"跑现有 generate workflow

### 4.3 #director — DirectorPage

替换 stub，渲染测试区块：

```
┌─────────────────────────────────────────────┐
│  Director 工作台 [beta]                       │
│  ─────────────────────────────────────────  │
│  参考图  [点击/拖拽上传]                        │
│  [缩略图，hover 带工具条]                       │
│                                             │
│  提示词  [textarea，编辑器注入到这里]            │
│  [生成] 按钮 → serviceBridge                  │
│                                             │
│  生成结果  [grid，hover 也可继续工具条迭代]      │
└─────────────────────────────────────────────┘
```

- 独立 local state（`useState`），prompt 和结果不污染 batch/generate store
- 生成按钮调 `serviceBridge.generateImageWithReference(prompt, [imageUrl])`
- theme = `default`

---

## 5. Settings Toggle

`SettingsPage` 新增"界面偏好"分区：

```
界面偏好
──────────
图片编辑工具条    [ON/OFF toggle]
悬停图片时显示"多角度"和"打光"提示词助手按钮
```

- 读写 `useUIPrefsStore.imageEditorToolbar.enabled`
- 一刀切，不分页分控

---

## 6. Three.js 保留策略

- `ThreeGlobe.tsx`、`ThreeLightScene.tsx`、`orbitGlobeShared.ts` 三文件原样复制
- 两个组件均用 `React.lazy` + `<Suspense>` 包裹
- 依赖：`three ^0.183.2` + `@types/three`

### 6.1 多张图片纹理切换

结果 grid 有多张图片，每张 hover 都有工具条。用户可能连续在不同图片上打开编辑器。

**问题：** 两个 Three.js 组件加载 `imageUrl` 纹理的方式不同：
- `ThreeGlobe`：`useEffect([imageUrl])` — 独立 effect，prop 变更就重新加载。安全。
- `ThreeLightScene`：只在初始 mount 的 `useEffect` 里加载，**无 `[imageUrl]` 依赖**。如果不 unmount 直接换 imageUrl，纹理不会更新。

**解法：`ImageEditorModal` 必须用 `key={imageUrl}` 或在关闭时卸载子树。**
推荐用 `key`：`<ImageEditorModal key={activeImageUrl} ... />`。imageUrl 变 → React 销毁旧实例 → 创建新实例 → 两个 Three.js 组件重新 mount → 正确加载新纹理。

### 6.2 WebGL 上下文与内存

- 浏览器 WebGL 上下文上限约 8-16 个。频繁开关 Modal 必须确保 renderer 正确 dispose。
- 源组件在 useEffect cleanup 中已有 `renderer.dispose()`。移植时验证此逻辑完整。
- Batch 结果常为 data: URL (base64, 数 MB)。Three.js `new Image()` + `Texture` 会在 GPU 额外占一份。
- **Modal 关闭/key 变更时必须：** `texture.dispose()` → `renderer.dispose()` → DOM 中移除 canvas。
- 源组件已有此 cleanup，移植时保留并验证不丢步骤。

---

## 7. Editor 移植改动清单

从源项目到 Electron 项目，每个编辑器需要的改动：

| 改动点 | 说明 |
|--------|------|
| 删 `"use client"` | Electron + Vite 不需要 |
| 删 `import { generateCameraAngleEdit } from "@/lib/camera-angle-api"` | 不再调 API |
| 删 `handleGenerate` 里的 API 调用 | 整个异步生图逻辑移除 |
| 删 `resultImage` / `generating` / `genError` state | 无需弹窗内生图结果 |
| 改 `handleApply` → 调 `onInjectPrompt(promptText)` | 核心变化 |
| 保留 `buildCameraPrompt` / `buildLightingPrompt` 调用 | 构造 prompt 的核心逻辑 |
| 保留 Three.js `<ThreeGlobe>` / `<ThreeLightScene>` | 3D 预览完整保留 |
| 保留 `orbitGlobeShared.ts` 全部导入 | Three.js 球壳/网格/snap 共享模块 |
| 保留所有滑杆/预设/方向按钮 UI | 参数选择 UI 完整保留 |
| 新增底部 prompt 预览区 | 显示当前构造的英文 prompt（只读 textarea） |
| 新增 [注入 Prompt] 按钮 | 替换原来的 [生成] 按钮 |
| 保留 [复制 Prompt] 按钮 | 源项目已有，保留 |
| `nodrag nopan` class → 删除 | React Flow 画布才需要的防拖拽属性 |
| `onPointerDown stopPropagation` → 删除 | 同上 |
| 导入路径 `@/lib/...` → 相对路径 `./prompts` | Electron + Vite 路径 |
| 导入路径 `./orbitGlobeShared` | 保持同目录相对引用 |

---

## 8. What We Are NOT Building (YAGNI)

- React Flow 画布 / NodeShell / ImageNode
- 编辑器内直接调 API 生图（B 模式，仅 prompt 注入）
- `image-edit-service.ts`（不需要了）
- `appendResult` store action（不需要了 — prompt 注入后用户自己点生成）
- 多张批量编辑
- 编辑历史 / undo-redo
- 分页级别的工具条开关

---

## 9. Phases

| 期 | 内容 | 交付标准 |
|----|------|----------|
| **Phase 1（本 spec）** | 共享模块 + `#batch` 接入（punk 主题）+ 设置开关 | hover 工具条可见；两个编辑器可开/调参/3D 预览；[注入 Prompt] 把 prompt 写入 batch 输入框；设置开关可关闭工具条 |
| Phase 2 | `#generate` 接入（default 主题）+ `ResultGrid` 改造 | 同上，但在 generate 页 |
| Phase 3 | `#director` 测试区块（default 主题）| director 页不再是 stub；可上传参考图 + 编辑器注入 prompt + 生成 |

**本次实现计划（plan）只涵盖 Phase 1。**

---

## 10. File Checklist (Phase 1)

新建文件：
- [ ] `src/renderer/src/components/shared/image-editors/MultiAngleEditor.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/LightEditor.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ThreeGlobe.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ThreeLightScene.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/orbitGlobeShared.ts`
- [ ] `src/renderer/src/components/shared/image-editors/prompts.ts`
- [ ] `src/renderer/src/components/shared/image-editors/ImageEditToolbar.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ImageEditorModal.tsx`
- [ ] `src/renderer/src/stores/useUIPrefsStore.ts`

修改文件：
- [ ] `src/renderer/src/pages-react/batch-punk/PunkResultGrid.tsx` — 加工具条 hover 层
- [ ] `src/renderer/src/pages-react/BatchPage.tsx` — 传 `onInjectPrompt` 到 PunkResultGrid
- [ ] `src/renderer/src/pages-react/SettingsPage.tsx` — 加"界面偏好"分区
- [ ] `package.json` — 检查并添加 `three`
