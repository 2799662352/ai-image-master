# Shared Image Editors (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port two visual prompt-builder editors (MultiAngleEditor, LightEditor) with Three.js 3D preview into the Electron app's #batch page as prompt-injection tools.

**Architecture:** A shared module at `components/shared/image-editors/` contains the two editors, their Three.js previews, a floating toolbar, and a modal wrapper. The editors output prompt strings via `onInjectPrompt` callbacks. A Zustand persist store controls toolbar visibility. Phase 1 integrates with #batch only (punk theme).

**Tech Stack:** React 18, TypeScript, Zustand (with persist middleware), Three.js, Electron-Vite, CSS

**Spec:** `docs/superpowers/specs/2026-04-20-shared-image-editors-design.md` (v4)

---

### Task 1: Install three.js and add useUIPrefsStore

**Files:**
- Modify: `package.json`
- Create: `src/renderer/src/stores/useUIPrefsStore.ts`
- Modify: `src/renderer/src/stores/index.ts`

- [ ] **Step 1: Install three.js**

```bash
cd d:\tecx\text\temp-ai-image-master-source
npm install three
npm install -D @types/three
```

- [ ] **Step 2: Create `useUIPrefsStore.ts`**

Create `src/renderer/src/stores/useUIPrefsStore.ts`:

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIPrefsState {
  imageEditorToolbar: { enabled: boolean }
  setImageEditorToolbar: (enabled: boolean) => void
}

export const useUIPrefsStore = create<UIPrefsState>()(
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

- [ ] **Step 3: Add barrel export**

Add to `src/renderer/src/stores/index.ts` at the end:

```typescript
export { useUIPrefsStore } from './useUIPrefsStore'
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/renderer/src/stores/useUIPrefsStore.ts src/renderer/src/stores/index.ts
git commit -m "feat: add three.js dep and useUIPrefsStore with persist"
```

---

### Task 2: Port `prompts.ts` (pure functions, zero deps)

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/prompts.ts`

- [ ] **Step 1: Create `prompts.ts`**

Create `src/renderer/src/components/shared/image-editors/prompts.ts`. This is extracted from the source project's `camera-angle-api.ts` — only the pure prompt-building functions, no API calls, no secrets:

```typescript
const AZIMUTH_MAP: Record<number, string> = {
  0: 'from the front',
  45: 'from the front-right at a 45-degree angle',
  90: 'from the right side',
  135: 'from the back-right at a 135-degree angle',
  180: 'from the back',
  225: 'from the back-left at a 225-degree angle',
  270: 'from the left side',
  315: 'from the front-left at a 315-degree angle',
}

const ELEVATION_MAP: Record<string, string> = {
  '-30': 'looking up from a low angle',
  '0': 'at eye level',
  '30': 'from a slightly elevated angle looking down',
  '60': 'from a high overhead angle looking down',
}

const DISTANCE_MAP: Record<string, string> = {
  '0.6': 'as a close-up shot',
  '1': 'at a medium distance',
  '1.4': 'as a wide shot from further away',
}

function snapToNearest(value: number, options: number[]): number {
  return options.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
  )
}

export function buildCameraPrompt(
  horizontal: number,
  vertical: number,
  distance: number,
): string {
  const azSnap = snapToNearest(horizontal, Object.keys(AZIMUTH_MAP).map(Number))
  const elSnap = snapToNearest(vertical, [-30, 0, 30, 60])
  const distSnap = snapToNearest(distance, [0.6, 1.0, 1.4])

  const azName = AZIMUTH_MAP[azSnap]
  const elName = ELEVATION_MAP[String(elSnap)]
  const distKey = distSnap === 1 ? '1' : distSnap.toFixed(1)
  const distName = DISTANCE_MAP[distKey]

  return `Rotate the camera to view this subject ${azName}, ${elName}, ${distName}. Keep the same subject, style, lighting, and background. Only change the camera angle and distance.`
}

const LIGHT_DIR_MAP: Record<string, string> = {
  left: 'from the left side',
  top: 'from above',
  right: 'from the right side',
  front: 'from the front',
  bottom: 'from below',
  back: 'from behind',
}

const HEX_TO_NAME: Record<string, string> = {
  '#ffe4c4': 'warm golden',
  '#fff8e7': 'natural daylight',
  '#ffffff': 'neutral white',
  '#d4e4ff': 'cool white',
  '#b4c7ff': 'cool blue',
  '#ffd6e8': 'soft pink',
}

function colorName(hex: string): string {
  const known = HEX_TO_NAME[hex.toLowerCase()]
  if (known) return known
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 510
  if (max === min) return l > 0.85 ? 'bright white' : 'neutral gray'
  let h = 0
  const d = max - min
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  if (h < 30) return 'warm red'
  if (h < 60) return 'warm orange'
  if (h < 90) return 'warm yellow'
  if (h < 150) return 'green'
  if (h < 210) return 'cyan'
  if (h < 270) return 'blue'
  if (h < 330) return 'purple'
  return 'warm red'
}

export function buildLightingPrompt(
  direction: string,
  brightness: number,
  color: string,
  rimLight: boolean,
): string {
  const dirDesc = LIGHT_DIR_MAP[direction] || `from the ${direction}`
  const intensityPct = Math.round(brightness * 25)
  const parts = [
    `Relight this image with a ${colorName(color)} light source ${dirDesc} at ${intensityPct}% intensity.`,
  ]
  if (rimLight) parts.push('Add a subtle rim light to separate the subject from the background.')
  parts.push('Keep the same subject, composition, and background. Only change the lighting.')
  return parts.join(' ')
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/prompts.ts
git commit -m "feat: add prompt builder pure functions (camera + lighting)"
```

---

### Task 3: Port Three.js shared module (`orbitGlobeShared.ts` + `disposeScene`)

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/orbitGlobeShared.ts`

- [ ] **Step 1: Copy `orbitGlobeShared.ts` from source**

Copy `d:\tecx\text\ai-website-cloner-template\src\components\canvas\orbitGlobeShared.ts` to `d:\tecx\text\temp-ai-image-master-source\src\renderer\src\components\shared\image-editors\orbitGlobeShared.ts`.

No modifications needed — file has zero Next.js dependencies.

- [ ] **Step 2: Append `disposeScene()` utility at the end of the file**

Add to the bottom of `orbitGlobeShared.ts`:

```typescript
/**
 * Traverse the scene and dispose ALL GPU resources (geometries, materials, textures).
 * Three.js does NOT auto-clean GPU resources — this must be called on unmount.
 */
export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if ('geometry' in object && (object as any).geometry) {
      (object as any).geometry.dispose()
    }
    if ('material' in object) {
      const materials = Array.isArray((object as any).material)
        ? (object as any).material
        : [(object as any).material]
      for (const mat of materials) {
        if (!mat) continue
        mat.map?.dispose()
        mat.dispose()
      }
    }
  })
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/orbitGlobeShared.ts
git commit -m "feat: port orbitGlobeShared.ts with disposeScene utility"
```

---

### Task 4: Port `ThreeGlobe.tsx` and `ThreeLightScene.tsx`

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/ThreeGlobe.tsx`
- Create: `src/renderer/src/components/shared/image-editors/ThreeLightScene.tsx`

- [ ] **Step 1: Copy ThreeGlobe.tsx from source**

Copy `d:\tecx\text\ai-website-cloner-template\src\components\canvas\ThreeGlobe.tsx` to `d:\tecx\text\temp-ai-image-master-source\src\renderer\src\components\shared\image-editors\ThreeGlobe.tsx`.

Modifications:
1. Delete line 1: `"use client";`
2. In the mount-level cleanup `return () => { ... }`, add **before** `renderer.dispose()`:

```typescript
state.subjectMat.map?.dispose();
disposeScene(state.scene);
```

And add the import at the top:

```typescript
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";
```

(Replace the existing import that only imports `ORBIT_RADIUS` and `addOrbitGlobe`.)

- [ ] **Step 2: Copy ThreeLightScene.tsx from source**

Copy `d:\tecx\text\ai-website-cloner-template\src\components\canvas\ThreeLightScene.tsx` to `d:\tecx\text\temp-ai-image-master-source\src\renderer\src\components\shared\image-editors\ThreeLightScene.tsx`.

Modifications:
1. Delete line 1: `"use client";`
2. Update the import to include `disposeScene`:

```typescript
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";
```

3. Add `target` to the `sceneRef` type so the new `useEffect([imageUrl])` can access it. In the `sceneRef` type definition, add `target: THREE.Mesh;` field.

4. After the scene ref stores `target`, save it: `state.target = target;` (where `target` is the mesh created for the subject plane).

5. Add a NEW `useEffect` for `[imageUrl]` texture switching (place it after the mount effect):

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

6. In the mount-level cleanup `return () => { ... }`, add **before** `renderer.dispose()`:

```typescript
(sceneRef.current?.target.material as any)?.map?.dispose();
disposeScene(state.scene);
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/ThreeGlobe.tsx src/renderer/src/components/shared/image-editors/ThreeLightScene.tsx
git commit -m "feat: port ThreeGlobe + ThreeLightScene with full GPU cleanup"
```

---

### Task 5: Port `MultiAngleEditor.tsx`

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/MultiAngleEditor.tsx`

- [ ] **Step 1: Copy and modify MultiAngleEditor.tsx**

Copy `d:\tecx\text\ai-website-cloner-template\src\components\canvas\MultiAngleEditor.tsx` to `d:\tecx\text\temp-ai-image-master-source\src\renderer\src\components\shared\image-editors\MultiAngleEditor.tsx`.

Apply ALL modifications from spec Section 7.1 + 7.2:

1. Delete `"use client";`
2. Delete `import { generateCameraAngleEdit } from "@/lib/camera-angle-api";` → replace with `import { buildCameraPrompt } from './prompts';`
3. Delete `resultImage`, `generating`, `genError` state declarations
4. Delete `handleGenerate` function and all API call logic
5. Delete the JSX block that shows generation spinner / error / result thumbnail
6. Delete cost indicator (`⚡1` energy)
7. Delete all `nodrag nopan` CSS classes
8. Delete `onPointerDown={e => e.stopPropagation()}` handlers
9. Change props: replace `onApply` with `onInjectPrompt: (prompt: string) => void` and `onClose: () => void`
10. Add `useMemo` for live prompt text: `const cameraPromptText = useMemo(() => buildCameraPrompt(horizontal, vertical, zoom), [horizontal, vertical, zoom])`
11. Replace the old "Apply" button with:
    - A readonly `<textarea>` showing `cameraPromptText`
    - A `[注入 Prompt]` button calling `onInjectPrompt(cameraPromptText)` then `onClose()`
    - Keep the existing `[复制 Prompt]` button

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/MultiAngleEditor.tsx
git commit -m "feat: port MultiAngleEditor as prompt-only editor"
```

---

### Task 6: Port `LightEditor.tsx`

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/LightEditor.tsx`

- [ ] **Step 1: Copy and modify LightEditor.tsx**

Copy `d:\tecx\text\ai-website-cloner-template\src\components\canvas\LightEditor.tsx` to `d:\tecx\text\temp-ai-image-master-source\src\renderer\src\components\shared\image-editors\LightEditor.tsx`.

Apply ALL modifications from spec Section 7.1 + 7.3:

1. Delete `"use client";`
2. Add `import { buildLightingPrompt } from './prompts';`
3. Delete `smartMode` state and its toggle UI
4. Delete `onApply` prop → replace with `onInjectPrompt: (prompt: string) => void` and `onClose: () => void`
5. Delete `handleApply` that passes raw params → replace with:
   ```typescript
   const lightPrompt = useMemo(
     () => buildLightingPrompt(direction, brightness, color, rimLight),
     [direction, brightness, color, rimLight],
   )
   ```
6. Delete cost indicator (`⚡14` energy)
7. Delete all `nodrag nopan` CSS classes
8. Delete `onPointerDown={e => e.stopPropagation()}` handlers
9. Add a prompt preview section at the bottom:
   - A readonly `<textarea>` showing `lightPrompt`
   - A `[注入 Prompt]` button calling `onInjectPrompt(lightPrompt)` then `onClose()`
   - A `[复制 Prompt]` button using `navigator.clipboard.writeText(lightPrompt)`

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/LightEditor.tsx
git commit -m "feat: port LightEditor as prompt-only editor with buildLightingPrompt"
```

---

### Task 7: Create `image-editors.css`, `ImageEditToolbar.tsx`, `ImageEditorModal.tsx`

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/image-editors.css`
- Create: `src/renderer/src/components/shared/image-editors/ImageEditToolbar.tsx`
- Create: `src/renderer/src/components/shared/image-editors/ImageEditorModal.tsx`

- [ ] **Step 1: Create `image-editors.css`**

Extract angle-slider styles from source `globals.css` lines 159-199:

```css
.angle-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  cursor: pointer;
  border: 2px solid #36b5f0;
  box-shadow:
    0 0 0 2px rgba(54, 181, 240, 0.15),
    0 1px 4px rgba(0, 0, 0, 0.4);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.angle-slider:hover::-webkit-slider-thumb,
.angle-slider:focus-visible::-webkit-slider-thumb {
  box-shadow:
    0 0 0 4px rgba(54, 181, 240, 0.22),
    0 1px 6px rgba(0, 0, 0, 0.5);
  transform: scale(1.05);
}
.angle-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  cursor: pointer;
  border: 2px solid #36b5f0;
  box-shadow:
    0 0 0 2px rgba(54, 181, 240, 0.15),
    0 1px 4px rgba(0, 0, 0, 0.4);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.angle-slider:hover::-moz-range-thumb,
.angle-slider:focus-visible::-moz-range-thumb {
  box-shadow:
    0 0 0 4px rgba(54, 181, 240, 0.22),
    0 1px 6px rgba(0, 0, 0, 0.5);
  transform: scale(1.05);
}
```

- [ ] **Step 2: Create `ImageEditToolbar.tsx`**

```tsx
import { useState } from 'react'
import { useUIPrefsStore } from '../../../stores/useUIPrefsStore'

interface Props {
  theme: 'punk' | 'default'
  imageUrl: string
  onOpenEditor: (type: 'angle' | 'light') => void
}

export default function ImageEditToolbar({ theme, imageUrl, onOpenEditor }: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  if (!enabled || !imageUrl) return null

  const isPunk = theme === 'punk'

  const btnClass = isPunk
    ? 'p-sticker'
    : 'rounded-md bg-zinc-700 hover:bg-zinc-600 text-white'

  const wrapClass = isPunk
    ? 'border-2 border-[var(--punk-black)] bg-[var(--punk-cream)]'
    : 'bg-zinc-800 border border-zinc-600 rounded-lg'

  return (
    <div
      className={`absolute top-1 left-1/2 -translate-x-1/2 z-20 flex gap-1 px-2 py-1 ${wrapClass}`}
      style={{ pointerEvents: 'auto' }}
    >
      <button
        type="button"
        className={`px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`}
        onClick={() => onOpenEditor('angle')}
      >
        多角度
      </button>
      <button
        type="button"
        className={`px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`}
        onClick={() => onOpenEditor('light')}
      >
        打光
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Create `ImageEditorModal.tsx`**

```tsx
import { lazy, Suspense, Component, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const MultiAngleEditor = lazy(() => import('./MultiAngleEditor'))
const LightEditor = lazy(() => import('./LightEditor'))

class WebGLErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

interface Props {
  editorType: 'angle' | 'light'
  imageUrl: string
  theme: 'punk' | 'default'
  onInjectPrompt: (prompt: string) => void
  onClose: () => void
}

export default function ImageEditorModal({
  editorType,
  imageUrl,
  theme,
  onInjectPrompt,
  onClose,
}: Props) {
  const isPunk = theme === 'punk'

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
  }

  const panelClass = isPunk
    ? 'border-3 border-[var(--punk-black)] bg-[var(--punk-bg)]'
    : 'bg-zinc-900 rounded-xl shadow-2xl border border-zinc-700'

  const panelStyle: React.CSSProperties = isPunk
    ? { boxShadow: '6px 6px 0px var(--punk-black)' }
    : {}

  const fallbackUI = (
    <div className="p-8 text-center text-zinc-400">
      3D 预览加载失败（可能硬件加速未开启）
    </div>
  )

  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div
        className={`relative max-w-[90vw] max-h-[90vh] overflow-auto p-4 ${panelClass}`}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2 right-2 text-zinc-400 hover:text-white text-xl cursor-pointer z-10"
        >
          ✕
        </button>
        <WebGLErrorBoundary fallback={fallbackUI}>
          <Suspense fallback={<div className="p-8 text-center text-zinc-500">加载中...</div>}>
            {editorType === 'angle' ? (
              <MultiAngleEditor
                imageUrl={imageUrl}
                onInjectPrompt={onInjectPrompt}
                onClose={onClose}
              />
            ) : (
              <LightEditor
                imageUrl={imageUrl}
                onInjectPrompt={onInjectPrompt}
                onClose={onClose}
              />
            )}
          </Suspense>
        </WebGLErrorBoundary>
      </div>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/shared/image-editors/image-editors.css src/renderer/src/components/shared/image-editors/ImageEditToolbar.tsx src/renderer/src/components/shared/image-editors/ImageEditorModal.tsx
git commit -m "feat: add ImageEditToolbar, ImageEditorModal, and slider CSS"
```

---

### Task 8: Integrate into PunkResultGrid (#batch page)

**Files:**
- Modify: `src/renderer/src/pages-react/batch-punk/PunkResultGrid.tsx`

- [ ] **Step 1: Add toolbar + modal to PunkResultGrid**

At the top of `PunkResultGrid.tsx`, add imports:

```typescript
import { useState } from 'react'
import { useBatchStore } from '../../stores/useBatchStore'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
```

In the `ResultCard` component, wrap the image `<div>` container (the one with `aspectRatio: '1 / 1'`) in a `<div className="group relative">` and add the toolbar inside it:

```tsx
<div className="group relative" style={{ aspectRatio: '1 / 1', /* ... existing styles */ }}>
  {isDone && (
    <ImageEditToolbar
      theme="punk"
      imageUrl={item.resultUrl!}
      onOpenEditor={(type) => onOpenEditor?.(item.resultUrl!, type)}
    />
  )}
  {/* ... existing img / spinner / placeholder content ... */}
</div>
```

The toolbar is hidden by default, shown on group hover via Tailwind: add to ImageEditToolbar wrapper: `opacity-0 group-hover:opacity-100 transition-opacity`.

Add `onOpenEditor` to the `ResultCard` props and the `Props` interface for `PunkResultGrid`.

In the `PunkResultGrid` component, add state and the inject function:

```typescript
const [editorState, setEditorState] = useState<{ url: string; type: 'angle' | 'light' } | null>(null)

const injectPrompt = (p: string) => {
  const { mode, cardPrompt, multiText, setCardPrompt, setMultiText } = useBatchStore.getState()
  if (mode === 'card') setCardPrompt(cardPrompt + '\n' + p)
  else setMultiText(multiText + '\n' + p)
}
```

At the end of the `PunkResultGrid` return, render the modal:

```tsx
{editorState && (
  <ImageEditorModal
    key={editorState.type}
    editorType={editorState.type}
    imageUrl={editorState.url}
    theme="punk"
    onInjectPrompt={injectPrompt}
    onClose={() => setEditorState(null)}
  />
)}
```

Pass the opener to ResultCard:

```tsx
<ResultCard
  key={item.id}
  item={item}
  index={idx}
  onRemove={onRemove}
  onPreview={onPreview}
  onOpenEditor={(url, type) => setEditorState({ url, type })}
/>
```

- [ ] **Step 2: Import the CSS**

Add at the top of `PunkResultGrid.tsx`:

```typescript
import '../../components/shared/image-editors/image-editors.css'
```

- [ ] **Step 3: Verify build + manual test**

```bash
npm run build && npm run dev
```

Open `http://localhost:5173/#batch`. Generate some images. Hover a completed card → toolbar should appear. Click "多角度" → modal with 3D globe. Adjust sliders → see prompt preview. Click [注入 Prompt] → prompt should appear in the input field.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/batch-punk/PunkResultGrid.tsx
git commit -m "feat: integrate image editor toolbar into PunkResultGrid"
```

---

### Task 9: Add Settings toggle

**Files:**
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`

- [ ] **Step 1: Add UI Prefs section to SettingsPage**

Add import at top of `SettingsPage.tsx`:

```typescript
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
```

Inside the component, add:

```typescript
const toolbarEnabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
const setToolbarEnabled = useUIPrefsStore((s) => s.setImageEditorToolbar)
```

Before the closing `</div>` of the return, add:

```tsx
<section className="space-y-3 pt-4 border-t border-zinc-700">
  <div className="flex items-center gap-2">
    <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
      ⚙
    </span>
    <span className="font-bold text-white uppercase tracking-tight">界面偏好</span>
  </div>
  <label className="flex items-center justify-between gap-4 cursor-pointer">
    <div>
      <div className="text-sm text-white font-medium">图片编辑工具条</div>
      <div className="text-xs text-zinc-500">悬停图片时显示"多角度"和"打光"提示词助手按钮</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={toolbarEnabled}
      onClick={() => setToolbarEnabled(!toolbarEnabled)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        toolbarEnabled ? 'bg-cyberpunk-yellow' : 'bg-zinc-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          toolbarEnabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  </label>
</section>
```

- [ ] **Step 2: Verify build + manual test**

```bash
npm run build && npm run dev
```

Open Settings → toggle "图片编辑工具条" off → go to #batch → hover images → toolbar should NOT appear. Toggle back on → toolbar appears.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/SettingsPage.tsx
git commit -m "feat: add image editor toolbar toggle in settings"
```

---

### Task 10: Final integration test + cleanup

- [ ] **Step 1: Full flow smoke test**

1. Open #batch page
2. Enter a prompt and generate 2+ images
3. Hover a completed image → toolbar appears with [多角度] [打光]
4. Click [多角度] → MultiAngleEditor modal opens with 3D globe
5. Drag the globe / use presets → prompt preview updates in real-time
6. Click [注入 Prompt] → verify prompt appended to batch input field
7. Click [打光] on another image → LightEditor opens
8. Adjust brightness/direction/color → prompt preview updates
9. Click [注入 Prompt] → verify prompt appended
10. Open Settings → toggle toolbar off → verify toolbar hidden on hover
11. Toggle back on → toolbar reappears
12. Refresh app → verify settings persisted (localStorage)

- [ ] **Step 2: Verify no console errors**

Open DevTools → check for:
- No WebGL context errors
- No "Maximum call stack" errors
- No unhandled promise rejections
- Clean Three.js initialization logs

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: Phase 1 complete — shared image editors in #batch with 3D preview"
```
