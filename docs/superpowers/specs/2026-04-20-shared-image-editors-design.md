# Shared Image Editors — Design Spec

**Date:** 2026-04-20  
**Status:** Draft v4 — post library-docs-verified code-review  
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
├── image-editors.css           # angle-slider 自定义滑杆样式（从源项目提取）
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
                      │           ├── #batch: 根据 mode 分支
                      │           │     mode === 'card' → setCardPrompt(cardPrompt + '\n' + promptText)
                      │           │     mode === 'multi' → setMultiText(multiText + '\n' + promptText)
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

Zustand store + `persist` middleware（localStorage，key: `ui-prefs`）。

**参考实现（基于 Zustand 官方文档）：**

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIPrefsState {
  imageEditorToolbar: { enabled: boolean }
  setImageEditorToolbar: (enabled: boolean) => void
}

export const useUIPrefsStore = create<UIPrefsState>()(  // 注意 () 是 TS 中间件必须的柯里化
  persist(
    (set) => ({
      imageEditorToolbar: { enabled: true },
      setImageEditorToolbar: (enabled) =>
        set({ imageEditorToolbar: { enabled } }),
    }),
    {
      name: 'ui-prefs',
      partialize: (state) => ({ imageEditorToolbar: state.imageEditorToolbar }),
      version: 1,
    },
  ),
)
```

关键点：
- **`partialize`** — 只持久化数据字段，不序列化 action 函数，避免 localStorage 膨胀
- **`version: 1`** — 未来增加偏好字段时可用 `migrate` 做 schema 迁移
- **`create<T>()(persist(...))`** — TypeScript 柯里化写法，漏掉 `()` 会报类型错误
- 三个页面的工具条统一受此开关控制
- **注意：** 这是项目中首个使用 persist 的 store。现有 store 均无持久化。

---

## 4. Per-Page Integration

### 4.1 #batch — PunkResultGrid

- 每个结果图卡片外层加 `group` 类
- hover 显示 `<ImageEditToolbar theme="punk" imageUrl={url} onInjectPrompt={injectFn} />`
- `injectFn` = 根据当前 `mode` 分支：
  ```typescript
  (p) => {
    const { mode, cardPrompt, multiText, setCardPrompt, setMultiText } = useBatchStore.getState()
    if (mode === 'card') setCardPrompt(cardPrompt + '\n' + p)
    else setMultiText(multiText + '\n' + p)
  }
  ```
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
- `ThreeLightScene`：只在初始 mount 的 `useEffect` 里加载，**无 `[imageUrl]` 依赖**。

**~~原方案（已废弃）：~~ `key={imageUrl}` 强制 remount**  
经 Three.js 官方文档 + react-three-fiber issue #2655 验证，此方案**不可行**：
- Chromium WebGL 上下文上限 ~8-16 个，`renderer.dispose()` 只是标记丢失，**不保证同步回收**
- Electron renderer process 永不 reload，用户开关编辑器 20+ 次将耗尽上下文
- 每次 remount 创建新 `WebGLRenderer`，旧 context GC 回收不确定

**正确方案：给 `ThreeLightScene` 补 `useEffect([imageUrl])`（与 ThreeGlobe 对齐）**

移植时在 `ThreeLightScene.tsx` 新增一个独立 effect：

```typescript
useEffect(() => {
  const s = sceneRef.current;
  if (!s) return;
  const mat = s.target.material as THREE.MeshBasicMaterial;

  if (imageUrl) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!sceneRef.current) return;
      if (mat.map) mat.map.dispose();
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
      const aspect = img.width / img.height;
      if (aspect > 1) s.target.scale.set(1, 1 / aspect, 1);
      else s.target.scale.set(aspect, 1, 1);
    };
    img.src = imageUrl;
  } else {
    if (mat.map) { mat.map.dispose(); mat.map = null; }
    mat.needsUpdate = true;
  }
}, [imageUrl]);
```

**不再需要 `key={imageUrl}`。** Modal 保持挂载，只通过 prop 传递新 imageUrl → Three.js 内部更新纹理 → 零 WebGL context 创建销毁。

对于 MultiAngle vs Light 编辑器切换：使用 `key={editorType}`（仅 2 个值 "angle" | "light"），这是安全的低频切换。

### 6.2 WebGL 资源清理（基于 Three.js 官方文档）

Three.js **不会**自动清理 GPU 资源。`orbitGlobeShared.ts` 创建了大量 GPU 对象：
- 1 个 SphereGeometry(6.06, 64, 64) + ShaderMaterial（球壳）
- ~12 个 BufferGeometry + LineBasicMaterial（网格线）
- 50+ 个 SphereGeometry(0.1, 12, 12) + ShaderMaterial（snap 点）

加上两个编辑器自身的几何体（Plane/Cone/Cylinder/Torus/Box/Circle/Edges）和材质，
每个编辑器实例涉及 **~130 个几何体 + ~65 个材质**。

**必须新增 `disposeScene()` 工具函数**（放在 `orbitGlobeShared.ts` 或独立 `dispose.ts`）：

```typescript
export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if ('geometry' in object && (object as any).geometry) {
      (object as any).geometry.dispose();
    }
    if ('material' in object) {
      const materials = Array.isArray((object as any).material)
        ? (object as any).material
        : [(object as any).material];
      for (const mat of materials) {
        if (!mat) continue;
        mat.map?.dispose();
        mat.dispose();
      }
    }
  });
}
```

**两个 Three.js 组件的 cleanup return 统一为：**

```typescript
return () => {
  cancelAnimationFrame(state.frameId);
  // ... event listener cleanup ...
  state.subjectMat.map?.dispose();    // ThreeGlobe: 最后一帧纹理
  // 或 (targetMat as MeshBasicMaterial).map?.dispose();  // ThreeLightScene
  disposeScene(state.scene);           // 全量几何体+材质+贴图
  state.renderer.dispose();            // WebGL context
  if (canvas.parentNode === el) el.removeChild(canvas);
  sceneRef.current = null;
};
```

**内存注意：** Batch 结果常为 data: URL (base64, 数 MB)。经 `new Image()` → `THREE.Texture` 路径，
同一张图占 3 份内存（JS 字符串 + 解码 ImageBitmap + GPU 纹理）。上述 cleanup 确保 Modal 关闭时全部释放。

**Error Boundary 建议：** Electron 环境可能关闭硬件加速。在 `React.lazy` + `<Suspense>` 外层再包一层
`<ErrorBoundary>`，WebGL 初始化失败时显示降级 UI 而非白屏。

---

## 7. Editor 移植改动清单

从源项目到 Electron 项目，每个编辑器需要的改动：

### 7.1 两个编辑器共通改动

| 改动点 | 说明 |
|--------|------|
| 删 `"use client"` | Electron + Vite 不需要 |
| `nodrag nopan` class → 删除 | React Flow 画布才需要的防拖拽属性 |
| `onPointerDown stopPropagation` → 删除 | 同上 |
| 导入路径 `@/lib/...` → 相对路径 `./prompts` | Electron + Vite 路径 |
| 导入路径 `./orbitGlobeShared` | 保持同目录相对引用 |
| 删 cost indicator（⚡1 / ⚡14 能量）| B 模式无 API 调用，无能量消耗 |
| 新增底部 prompt 预览区 | 显示当前构造的英文 prompt（只读 textarea） |
| 新增 [注入 Prompt] 按钮 | 替换原来的 [生成] 按钮 |
| 保留 [复制 Prompt] 按钮 | 源项目已有，保留 |
| 保留 Three.js 3D 预览 | `<ThreeGlobe>` / `<ThreeLightScene>` 完整保留 |
| 保留 `orbitGlobeShared.ts` 全部导入 | Three.js 球壳/网格/snap 共享模块 |
| 保留所有滑杆/预设/方向按钮 UI | 参数选择 UI 完整保留 |

### 7.2 MultiAngleEditor 独有改动

| 改动点 | 说明 |
|--------|------|
| 删 `import { generateCameraAngleEdit } from "@/lib/camera-angle-api"` | 不再调 API |
| 删 `handleGenerate` 里的 API 调用 | 整个异步生图逻辑移除 |
| 删 `resultImage` / `generating` / `genError` state | 无需弹窗内生图结果 |
| 删结果预览 JSX 区块（显示 spinner/error/缩略图）| 对应 state 已删 |
| 改 `handleApply` → 调 `onInjectPrompt(buildCameraPrompt(h, v, z))` | `onApply` 替换为 `onInjectPrompt` |

### 7.3 LightEditor 独有改动（注意：比 MultiAngle 改动量更大）

源码中 LightEditor 的 `handleApply` 只传出 raw 参数对象（`{ brightness, color, direction, smartMode, rimLight }`），**从不调用 `buildLightingPrompt`**。移植时需要**新增 prompt 构造逻辑**：

| 改动点 | 说明 |
|--------|------|
| 新增 `import { buildLightingPrompt } from './prompts'` | 源项目中此函数在 `camera-angle-api.ts`，LightEditor 从未引用 |
| 新增 prompt 实时计算 | `const lightPrompt = useMemo(() => buildLightingPrompt(direction, brightness, color, rimLight), [direction, brightness, color, rimLight])` |
| 新增 prompt 预览区 + [注入/复制] 按钮 | MultiAngleEditor 已有此 UI 模式，LightEditor 需补齐 |
| 改 `handleApply` → 调 `onInjectPrompt(lightPrompt)` | 替换原来的 raw 对象回调 |
| 删 `onApply` prop | 改为统一的 `onInjectPrompt: (prompt: string) => void` |
| 删 `smartMode` toggle | B 模式下无 API 可"自动优化"，此开关无意义。列入 YAGNI |
| 删 cost indicator（⚡14 能量）| 同共通改动 |

### 7.3b ThreeLightScene 独有改动

| 改动点 | 说明 |
|--------|------|
| **新增 `useEffect([imageUrl])`** | 与 ThreeGlobe 对齐，支持 prop 级纹理切换（见 Section 6.1 完整代码） |
| 新增 mount cleanup 中 `disposeScene(scene)` | 见 Section 6.2 的 `disposeScene()` 工具函数 |
| 新增 mount cleanup 中 `targetMat.map?.dispose()` | 最后一帧纹理在 disposeScene 前单独释放 |

### 7.4 `buildLightingPrompt` 颜色描述优化

源码中 `buildLightingPrompt` 把 hex 值直接写进英文 prompt（如 "a #ffe4c4 light"），对 LLM 不友好。移植时在 `prompts.ts` 中新增 hex → 英文描述映射：

```typescript
const HEX_TO_NAME: Record<string, string> = {
  '#ffe4c4': 'warm golden',
  '#fff8e7': 'natural daylight',
  '#ffffff': 'neutral white',
  '#d4e4ff': 'cool white',
  '#b4c7ff': 'cool blue',
  '#ffd6e8': 'soft pink',
}

function colorName(hex: string): string {
  const known = HEX_TO_NAME[hex.toLowerCase()];
  if (known) return known;
  // 自定义颜色：基于 HSL 色相转英文描述
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const l = (max + min) / 510;
  if (max === min) return l > 0.85 ? 'bright white' : 'neutral gray';
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 30) return 'warm red';
  if (h < 60) return 'warm orange';
  if (h < 90) return 'warm yellow';
  if (h < 150) return 'green';
  if (h < 210) return 'cyan';
  if (h < 270) return 'blue';
  if (h < 330) return 'purple';
  return 'warm red';
}
```

覆盖源项目 `COLOR_PRESETS` 全部 6 种预设 + 自定义颜色选择器的 fallback（HSL 色相映射）。
在 `buildLightingPrompt` 中用 `colorName(color)` 替换原始 hex。

---

## 8. What We Are NOT Building (YAGNI)

- React Flow 画布 / NodeShell / ImageNode
- 编辑器内直接调 API 生图（B 模式，仅 prompt 注入）
- `image-edit-service.ts`（不需要了）
- `appendResult` store action（不需要了 — prompt 注入后用户自己点生成）
- 多张批量编辑
- 编辑历史 / undo-redo
- 分页级别的工具条开关
- `smartMode` toggle（LightEditor 的"智能模式"在 B 模式下无 API 可优化，删除）
- Prompt 国际化（输出始终为英文，不做中文/多语言切换）
- 编辑器内键盘快捷键

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
- [ ] `src/renderer/src/components/shared/image-editors/image-editors.css` — angle-slider 滑杆样式（从源项目 globals.css 提取）
- [ ] `src/renderer/src/stores/useUIPrefsStore.ts`

修改文件：
- [ ] `src/renderer/src/pages-react/batch-punk/PunkResultGrid.tsx` — 加工具条 hover 层
- [ ] `src/renderer/src/pages-react/BatchPage.tsx` — 传 `onInjectPrompt` 到 PunkResultGrid
- [ ] `src/renderer/src/pages-react/SettingsPage.tsx` — 加"界面偏好"分区
- [ ] `src/renderer/src/stores/index.ts` — re-export `useUIPrefsStore`
- [ ] `package.json` — 添加 `three` (dependencies) + `@types/three` (devDependencies)
