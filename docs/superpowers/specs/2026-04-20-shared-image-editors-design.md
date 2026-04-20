# Shared Image Editors — Design Spec

**Date:** 2026-04-20  
**Status:** Draft — awaiting user review  
**Scope:** Phase 1 of 3 (全量功能，分三期接入)

---

## 1. Problem Statement

`ai-website-cloner-template` 包含两个高质量编辑器（多角度 + 打光），内置 Three.js 3D 预览和完整的参数 UI，但它们依赖硬编码 API key，且被绑定在 React Flow 画布节点内。

`temp-ai-image-master-source`（Electron 应用）拥有成熟的生图 workflow（serviceBridge → API → 结果 store），三个页面（batch / generate / director）的结果图缺乏后处理工具。

**目标：** 把两个编辑器作为"辅助工具"植入三个页面，生图走现有 serviceBridge pipeline，不重复造轮子。用户可在设置中开关工具条。

---

## 2. What We Are Building

### 2.1 共享模块（新建目录）

```
src/renderer/src/components/shared/image-editors/
├── MultiAngleEditor.tsx        # 移植自 ai-website-cloner-template（剥掉 "use client" / Next.js 路径）
├── LightEditor.tsx             # 同上
├── ThreeGlobe.tsx              # Three.js 3D 地球仪（lazy import，原样移植）
├── ThreeLightScene.tsx         # Three.js 灯光场景（lazy import，原样移植）
├── prompts.ts                  # buildCameraPrompt / buildLightingPrompt 纯函数（完整移植，无改动）
├── image-edit-service.ts       # 替换硬编码 API → 调 window.serviceBridge
├── ImageEditToolbar.tsx        # 浮动工具条（theme: 'punk' | 'default'）
└── ImageEditorModal.tsx        # 弹窗外壳（theme prop 透传）
```

### 2.2 UI 偏好 Store（新建）

```
src/renderer/src/stores/useUIPrefsStore.ts
```

- Zustand store，**纯 localStorage 持久化**（不走 serviceBridge，轻量）  
- 初始字段：`imageEditorToolbar: { enabled: boolean }`，默认 `true`

### 2.3 现有文件改动

| 文件 | 改动 |
|------|------|
| `useGenerateStore.ts` | 新增 `appendResult(url: string): void` action（push 到 `resultUrls`）|
| `useBatchStore.ts` | 新增 `appendResult(url: string): void` action（push 到结果列表） |
| `generate/ResultGrid.tsx` | 接收 `onEditImage?: (url, index) => void` callback，hover 层加工具条 |
| `batch-punk/PunkResultGrid.tsx` | 同上，punk 主题 |
| `SettingsPage.tsx` | 新增"界面偏好"分区，包含图片编辑工具条开关 toggle |
| `DirectorPage.tsx` | 替换占位 stub → 渲染参考图上传 + 编辑器测试区块（default 主题） |
| `package.json` | 新增 `"three": "^0.183.2"`（如果尚未存在）|

---

## 3. Architecture

### 3.1 数据流

```
图片卡片 hover
  └─► [工具条已开] → ImageEditToolbar 浮现（多角度 / 打光 按钮）
       │
       └─► 用户点击 → ImageEditorModal 打开 (MultiAngleEditor | LightEditor)
                │
                ├── Three.js 3D 实时预览（仅前端，无网络）
                ├── 用户调参（滑杆 / 方向选择 / 预设）
                │
                └── 点击 [生成] → image-edit-service.generate(imageUrl, params)
                      │
                      └─► window.serviceBridge.generateImageWithReference(
                              prompt,          // buildCameraPrompt/buildLightingPrompt 生成
                              [imageUrl],      // 原图 data URL 或 https URL
                              ratio,           // 取宿主页当前 ratio（默认 '1:1'）
                              1,               // 单次 1 张
                              resolution       // 取宿主页当前 resolution（可选）
                            )
                            │
                            └─► 返回 urls[]
                                  │
                                  ├── store.appendResult(urls[0])  ← 辅助进现有 workflow
                                  └── 弹窗内也展示预览（可另存/复制）
```

### 3.2 theme 规格

| 属性 | `punk`（#batch）| `default`（#generate / #director）|
|------|----------------|----------------------------------|
| 工具条背景 | `var(--punk-cream)` + 粗黑描边 | `bg-zinc-800 border border-zinc-600` |
| 工具条按钮 | `p-sticker` 风格 | `rounded-md bg-zinc-700 hover:bg-zinc-600` |
| 弹窗外壳 | `var(--punk-bg)` + `6px` 偏移硬投影 | `bg-zinc-900 rounded-xl shadow-2xl` |
| 内部 Editor panel | 中性浅灰（源项目原配色，两套 theme 共用） | 同左 |
| 动画 | `duration-100 ease-out` | `duration-150 ease-out` |

### 3.3 image-edit-service.ts 接口

```typescript
export interface ImageEditParams {
  type: 'camera' | 'light'
  imageUrl: string
  // camera
  horizontal?: number
  vertical?: number
  zoom?: number
  // light
  direction?: string
  brightness?: number
  color?: string
  rimLight?: boolean
  smartMode?: boolean
  // context
  ratio?: string
  resolution?: string | null
}

export interface ImageEditResult {
  success: boolean
  imageUrl?: string
  prompt: string
  error?: string
}

export async function generateImageEdit(
  params: ImageEditParams,
  signal?: AbortSignal
): Promise<ImageEditResult>
```

内部：
1. 根据 `type` 调 `buildCameraPrompt` 或 `buildLightingPrompt` 得到 prompt
2. 调 `window.serviceBridge.generateImageWithReference(prompt, [imageUrl], ratio, 1, resolution)`
3. 返回统一的 `ImageEditResult`（不再有任何硬编码 key/URL）

---

## 4. Per-Page Integration

### 4.1 #batch — PunkResultGrid

- 每个 `ResultCard` 外层加 `group` 类
- hover 时渲染 `<ImageEditToolbar theme="punk" imageUrl={url} onApply={appendResult} />`
- 工具条定位：`absolute top-1 left-1/2 -translate-x-1/2 z-20`（不遮盖已有的下载/删除按钮）

### 4.2 #generate — ResultGrid

- `ResultGrid` 改为接受 `onEditImage?: (url: string) => void` prop
- `GeneratePage` 传入：`onEditImage={(url) => useGenerateStore.getState().appendResult(url)}`
- 工具条定位同上，`default` 主题

### 4.3 #director — DirectorPage

替换 stub，渲染以下区块（仅本期，不是完整 Director 功能）：

```
┌─────────────────────────────────────────────┐
│  Director 工作台 [beta]                       │
│  ─────────────────────────────────────────  │
│  上传参考图  [点击/拖拽]                        │
│                                             │
│  [已上传图片缩略图，hover 带工具条]              │
│                                             │
│  生成结果                                    │
│  [结果图 grid，hover 带工具条，可继续迭代]       │
└─────────────────────────────────────────────┘
```

- 独立 local state（`useState`），不复用 batch/generate store（独立，避免污染）
- 生成走 `serviceBridge.generateImageWithReference`（同编辑器服务层）
- theme = `default`

---

## 5. Settings Toggle

`SettingsPage` 新增"界面偏好"分区（放在现有内容之后）：

```
界面偏好
──────────
图片编辑工具条    [ON/OFF toggle]
悬停图片时显示"多角度"和"打光"快捷按钮
```

- 读写 `useUIPrefsStore.imageEditorToolbar.enabled`
- localStorage key: `ui-prefs`（Zustand `persist` middleware，`sessionStorage` 不够持久用 `localStorage`）
- 所有三个页面的工具条统一受此开关控制（一刀切，不分页分控）

---

## 6. Three.js 保留策略

- `ThreeGlobe.tsx` 和 `ThreeLightScene.tsx` **原样复制**（无改动）
- 两者均用 `React.lazy` + `<Suspense fallback={<div>加载 3D…</div>}>` 包裹
- 只在 Modal 打开时挂载，关闭时卸载（避免常驻内存）
- 如果 `three` 已在 Electron 项目 `package.json` 中存在则跳过安装，否则 `npm install three@^0.183.2 @types/three`

---

## 7. What We Are NOT Building (YAGNI)

- React Flow 画布 / NodeShell / ImageNode / CustomEdge / LeftSidebar
- 多张批量编辑（一次只编辑一张）
- 编辑历史 / undo-redo
- 完整 Director 页功能（仅测试区块）
- 分页级别的工具条开关（只有全局一个开关）
- SmartMode 对 Director 页的特殊处理（本期等同于普通生成）

---

## 8. Phases

| 期 | 内容 | 交付标准 |
|----|------|----------|
| **Phase 1（本 spec）** | 共享模块 + `#batch` 接入（punk 主题）+ 设置开关 | hover 工具条可见；两个编辑器可开/调参/生图；生成结果 append 到 batch 结果 grid；设置开关可关闭工具条 |
| Phase 2 | `#generate` 接入（default 主题）+ `ResultGrid` 改造 | 同上，但在 generate 页 |
| Phase 3 | `#director` 测试区块（default 主题）| director 页不再是 stub；可上传参考图 + 用编辑器生图 |

**本次实现计划（plan）只涵盖 Phase 1。**

---

## 9. File Checklist (Phase 1)

新建文件：
- [ ] `src/renderer/src/components/shared/image-editors/MultiAngleEditor.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/LightEditor.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ThreeGlobe.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ThreeLightScene.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/prompts.ts`
- [ ] `src/renderer/src/components/shared/image-editors/image-edit-service.ts`
- [ ] `src/renderer/src/components/shared/image-editors/ImageEditToolbar.tsx`
- [ ] `src/renderer/src/components/shared/image-editors/ImageEditorModal.tsx`
- [ ] `src/renderer/src/stores/useUIPrefsStore.ts`

修改文件：
- [ ] `src/renderer/src/stores/useBatchStore.ts` — 新增 `appendResult`
- [ ] `src/renderer/src/pages-react/batch-punk/PunkResultGrid.tsx` — 加工具条
- [ ] `src/renderer/src/pages-react/SettingsPage.tsx` — 加 UI 偏好分区
- [ ] `package.json` — 检查并添加 `three`

---

## 10. Open Questions

없음（all resolved during brainstorming）。
