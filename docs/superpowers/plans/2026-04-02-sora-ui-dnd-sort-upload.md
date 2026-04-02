# Sora UI 媒体拖拽排序 + 全局拖拽上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add @dnd-kit drag-and-drop sorting to expanded media stack, global file drop upload to editor container, and right-click role switching — Phase 2 of media editor UX upgrade.

**Architecture:** Wrap `.jm-media-trigger` stack area with `DndContext` + `SortableContext`. Replace inline card rendering with `SortableMediaItem` for both collapsed/expanded states. Add HTML5 drag events on `.jm-editor-container` for file upload. Embed duration/thumbnail into row objects to eliminate external index-keyed maps.

**Tech Stack:** React 18, TypeScript, `@dnd-kit/core` ^6.3.1, `@dnd-kit/sortable` ^10.0.0, `@dnd-kit/utilities` ^3.2.2, Ant Design 5

**Spec:** `docs/superpowers/specs/2026-04-02-sora-ui-dnd-sort-upload-design.md`

---

### Task 1: Move `UnifiedMedia` to shared types + extend `VideoWithRole`/`AudioWithRole`

**Files:**
- Modify: `src/types/index.ts:23-45`
- Modify: `src/components/JimengStyleEditor.tsx:64-74`
- Modify: `src/components/SortableMediaItem.tsx:8-16`

- [ ] **Step 1: Add `duration` and `thumbnail` to `VideoWithRole` and `AudioWithRole` in `types/index.ts`**

```typescript
// src/types/index.ts — update VideoWithRole (line 36-39)
export interface VideoWithRole {
  url: string;
  role: VolcengineArkVideoRole;
  duration?: number;
  thumbnail?: string;
}

// src/types/index.ts — update AudioWithRole (line 42-45)
export interface AudioWithRole {
  url: string;
  role: VolcengineArkAudioRole;
  duration?: number;
}
```

- [ ] **Step 2: Export `UnifiedMedia` from `types/index.ts`**

Add after `AudioWithRole`:

```typescript
export type UnifiedMedia = {
  id: string;
  type: 'image' | 'video' | 'audio';
  url: string;
  displayUrl: string;
  role: string;
  originalIndex: number;
  thumbnail?: string;
  duration?: number;
  label?: string;
};
```

- [ ] **Step 3: Remove duplicate `UnifiedMedia` from `JimengStyleEditor.tsx`**

Delete lines 64-74 (the `type UnifiedMedia = { ... }` block). Add import:

```typescript
import type { ..., UnifiedMedia } from '../types';
```

- [ ] **Step 4: Remove duplicate `UnifiedMedia` from `SortableMediaItem.tsx`**

Delete lines 8-16 (the `export interface UnifiedMedia { ... }` block). Replace with import:

```typescript
import type { UnifiedMedia } from '../types';
```

- [ ] **Step 5: Verify build compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/components/JimengStyleEditor.tsx src/components/SortableMediaItem.tsx
git commit -m "refactor: move UnifiedMedia to shared types, embed duration/thumbnail in row objects"
```

---

### Task 2: Migrate duration/thumbnail to embedded row objects

**Files:**
- Modify: `src/components/JimengStyleEditor.tsx:99-101` (state declarations)
- Modify: `src/components/JimengStyleEditor.tsx:174-187` (mediaReferences useMemo)
- Modify: `src/components/JimengStyleEditor.tsx:189-199` (allMedia useMemo)
- Modify: `src/components/JimengStyleEditor.tsx:201-232` (useEffect hooks)
- Modify: `src/components/JimengStyleEditor.tsx:305-313` (handleAssetSelect)
- Modify: `src/components/JimengStyleEditor.tsx:456-464` (handleVideoUpload)
- Modify: `src/components/JimengStyleEditor.tsx:546-564` (removeMedia)
- Modify: `src/components/JimengStyleEditor.tsx:135-143` (resetMedia)

- [ ] **Step 1: Remove external index-keyed state maps**

Delete these three `useState` declarations (~line 99-101):

```typescript
// DELETE these 3 lines:
const [videoThumbnails, setVideoThumbnails] = useState<Record<number, string>>({});
const [videoDurations, setVideoDurations] = useState<Record<number, number>>({});
const [audioDurations, setAudioDurations] = useState<Record<number, number>>({});
```

- [ ] **Step 2: Update `handleVideoUpload` to embed thumbnail in row (~line 456-464)**

Replace the `setArkVideosWithRoles` + `setVideoThumbnails` block:

```typescript
const thumb = await extractVideoThumbnail(file);
setArkVideosWithRoles(prev => [
  ...prev,
  { url: videoUrl, role: 'reference_video' as const, thumbnail: thumb || undefined }
]);
```

- [ ] **Step 3: Update `handleAssetSelect` VIDEO branch to embed thumbnail (~line 305-313)**

Replace:

```typescript
} else if (asset.type === 'VIDEO') {
  setArkVideosWithRoles((prev: any[]) => {
    const newList = [...prev, { url: asset.url, role: 'reference_video' as const }];
    extractThumbnailFromUrl(asset.url).then(thumb => {
      if (thumb) setArkVideosWithRoles(p => p.map((v, i) =>
        v.url === asset.url && !v.thumbnail ? { ...v, thumbnail: thumb } : v
      ));
    });
    return newList;
  });
  message.success('已从素材库添加参考视频');
```

- [ ] **Step 4: Update `removeMedia` — remove `setVideoThumbnails` re-index block (~line 546-564)**

Replace entire `removeMedia` with:

```typescript
const removeMedia = (type: string, originalIndex: number) => {
  if (type === 'image') {
    setArkImagesWithRoles(p => p.filter((_, i) => i !== originalIndex));
    setFileList(p => p.filter((_, i) => i !== originalIndex));
  } else if (type === 'video') {
    setArkVideosWithRoles(p => p.filter((_, i) => i !== originalIndex));
  } else if (type === 'audio') {
    setArkAudiosWithRoles(p => p.filter((_, i) => i !== originalIndex));
  }
};
```

- [ ] **Step 5: Update `resetMedia` — remove `setVideoThumbnails({})` (~line 142)**

Delete `setVideoThumbnails({});` from `resetMedia` callback.

- [ ] **Step 6: Update video duration `useEffect` to write into `arkVideosWithRoles` (~line 201-216)**

Replace entire `useEffect`:

```typescript
useEffect(() => {
  const elements: HTMLVideoElement[] = [];
  arkVideosWithRoles.forEach((v, i) => {
    if (v.duration !== undefined) return;
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.src = v.url;
    el.addEventListener('loadedmetadata', () => {
      setArkVideosWithRoles(prev => prev.map((item, idx) =>
        idx === i ? { ...item, duration: el.duration } : item
      ));
    });
    elements.push(el);
  });
  return () => { elements.forEach(el => { el.src = ''; el.load(); }); };
}, [arkVideosWithRoles, setArkVideosWithRoles]);
```

- [ ] **Step 7: Update audio duration `useEffect` to write into `arkAudiosWithRoles` (~line 218-232)**

```typescript
useEffect(() => {
  const elements: HTMLAudioElement[] = [];
  arkAudiosWithRoles.forEach((a, i) => {
    if (a.duration !== undefined) return;
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.src = a.url;
    el.addEventListener('loadedmetadata', () => {
      setArkAudiosWithRoles(prev => prev.map((item, idx) =>
        idx === i ? { ...item, duration: el.duration } : item
      ));
    });
    elements.push(el);
  });
  return () => { elements.forEach(el => { el.src = ''; el.load(); }); };
}, [arkAudiosWithRoles, setArkAudiosWithRoles]);
```

- [ ] **Step 8: Update `mediaReferences` useMemo (~line 174-187)**

Change `thumbnail: videoThumbnails[i]` to `thumbnail: vid.thumbnail`, and remove `videoThumbnails` from deps:

```typescript
arkVideosWithRoles.forEach((vid, i) => {
  if (vid.url.trim()) {
    const name = vid.url.split('/').pop() || `视频${i + 1}`;
    refs.push({ index: i + 1, type: 'video', fileName: name, thumbnail: vid.thumbnail });
  }
});
// deps: [arkImagesWithRoles, arkVideosWithRoles, arkAudiosWithRoles]
```

- [ ] **Step 9: Update `allMedia` useMemo to read from embedded fields (~line 189-199)**

```typescript
const allMedia: UnifiedMedia[] = useMemo(() => {
  const media: UnifiedMedia[] = [];
  arkImagesWithRoles.forEach((m, i) => {
    const isAssetUri = m.url.startsWith('asset://');
    const displayUrl = isAssetUri ? ((m as any).previewUrl || '') : (m.thumbnailUrl || m.url);
    const urlTail = m.url.slice(-16);
    media.push({
      id: `img-${urlTail}`,
      type: 'image', url: m.url, displayUrl,
      role: m.role, originalIndex: i,
    });
  });
  arkVideosWithRoles.forEach((v, i) => {
    const urlTail = v.url.slice(-16);
    media.push({
      id: `vid-${urlTail}`,
      type: 'video', url: v.url,
      displayUrl: v.url,
      role: v.role, originalIndex: i,
      thumbnail: v.thumbnail,
      duration: v.duration,
    });
  });
  arkAudiosWithRoles.forEach((a, i) => {
    const urlTail = a.url.slice(-16);
    media.push({
      id: `aud-${urlTail}`,
      type: 'audio', url: a.url,
      displayUrl: a.url,
      role: a.role, originalIndex: i,
      duration: a.duration,
      label: `音频${i + 1}`,
    });
  });
  return media;
}, [arkImagesWithRoles, arkVideosWithRoles, arkAudiosWithRoles]);
```

- [ ] **Step 10: Verify build compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit`

- [ ] **Step 11: Commit**

```bash
git add src/components/JimengStyleEditor.tsx
git commit -m "refactor: embed duration/thumbnail in video/audio row objects, remove external maps"
```

---

### Task 3: Update `SortableMediaItem` with `disabled` + `duration` + `label`

**Files:**
- Modify: `src/components/SortableMediaItem.tsx`

- [ ] **Step 1: Add `disabled` to props and forward to `useSortable`**

```typescript
interface SortableMediaItemProps {
  id: string;
  media: UnifiedMedia;
  disabled?: boolean;  // NEW
  onPreview?: (src: string) => void;
  onRemove?: (type: string, index: number) => void;
  onRoleChange?: (type: string, index: number, newRole: string) => void;
  onReplace?: (type: string, index: number, file: File) => void;
  isStackMode?: boolean;
  style?: React.CSSProperties;
  isOverlay?: boolean;
}
```

Update destructuring to include `disabled`:

```typescript
export const SortableMediaItem: React.FC<SortableMediaItemProps> = ({
  id, media, disabled, onPreview, onRemove, onRoleChange, onReplace, isStackMode, style: customStyle, isOverlay
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ 
    id, 
    disabled,
    data: { type: 'media', media } 
  });
```

- [ ] **Step 2: Add duration display**

After the role label div (line 134), add duration badge:

```typescript
{media.duration != null && (
  <span className="jm-media-item-duration">{formatDuration(media.duration)}</span>
)}
```

Add `formatDuration` at the top of the file:

```typescript
const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};
```

- [ ] **Step 3: Use `media.label` for audio display**

Update `getRoleLabel`:

```typescript
const getRoleLabel = () => {
  if (media.type === 'image') {
    if (media.role === 'first_frame') return '首帧';
    if (media.role === 'last_frame') return '尾帧';
    if (media.url.startsWith('asset://')) return '人像';
    return `图${media.originalIndex + 1}`;
  }
  if (media.type === 'video') return `视频${media.originalIndex + 1}`;
  return media.label || `音频${media.originalIndex + 1}`;
};
```

- [ ] **Step 4: Verify build compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/components/SortableMediaItem.tsx
git commit -m "feat: add disabled/duration/label support to SortableMediaItem"
```

> **Note:** `disabled` prop is available but not currently passed from collapsed state. The `PointerSensor` `distance: 8` constraint prevents accidental drags. If needed later, wire a `useState<boolean>` for `isHoverExpanded` to toggle `disabled`.

---

### Task 4: Integrate `DndContext` + `SortableContext` + replace inline cards

**Files:**
- Modify: `src/components/JimengStyleEditor.tsx`

- [ ] **Step 1: Add imports**

```typescript
import { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensors, useSensor } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { SortableMediaItem } from './SortableMediaItem';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
```

- [ ] **Step 2: Add sensors and activeId state**

After existing state declarations (~line 109):

```typescript
const [activeId, setActiveId] = useState<string | null>(null);

const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
);
```

- [ ] **Step 3: Add drag handlers**

```typescript
const handleDragStart = useCallback((event: DragStartEvent) => {
  setActiveId(String(event.active.id));
  mediaTriggerRef.current?.classList.add('is-dragging');
}, []);

const handleDragEnd = useCallback((event: DragEndEvent) => {
  setActiveId(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');

  const { active, over } = event;
  if (!over || active.id === over.id) return;

  const activeMedia = active.data.current?.media as UnifiedMedia | undefined;
  const overMedia = over.data.current?.media as UnifiedMedia | undefined;
  if (!activeMedia || !overMedia || activeMedia.type !== overMedia.type) return;

  if (activeMedia.type === 'image') {
    setArkImagesWithRoles(prev => {
      const oldIdx = prev.findIndex((_, i) => i === activeMedia.originalIndex);
      const newIdx = prev.findIndex((_, i) => i === overMedia.originalIndex);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return arrayMove(prev, oldIdx, newIdx);
    });
  } else if (activeMedia.type === 'video') {
    setArkVideosWithRoles(prev => {
      const oldIdx = activeMedia.originalIndex;
      const newIdx = overMedia.originalIndex;
      return arrayMove(prev, oldIdx, newIdx);
    });
  } else {
    setArkAudiosWithRoles(prev => {
      const oldIdx = activeMedia.originalIndex;
      const newIdx = overMedia.originalIndex;
      return arrayMove(prev, oldIdx, newIdx);
    });
  }
}, [setArkImagesWithRoles, setArkVideosWithRoles, setArkAudiosWithRoles]);

const handleDragCancel = useCallback(() => {
  setActiveId(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');
}, []);
```

- [ ] **Step 4: Wrap stack area with DndContext + SortableContext**

Replace the current `.jm-stack-container` block (~lines 677-741) with:

```tsx
<DndContext
  sensors={sensors}
  collisionDetection={closestCenter}
  onDragStart={handleDragStart}
  onDragEnd={handleDragEnd}
  onDragCancel={handleDragCancel}
>
  <SortableContext
    items={allMedia.slice(0, 20).map(m => m.id)}
    strategy={horizontalListSortingStrategy}
  >
    <div className="jm-stack-container" style={{ '--media-count': Math.min(allMedia.length, 20) } as React.CSSProperties}>
      {allMedia.slice(0, 20).map((m, idx) => {
        const rot = (idx % 2 === 0 ? -1 : 1) * (3 + (idx % 3) * 0.8);
        const tx = (idx % 2 === 0 ? -1 : 1) * 2;
        const ty = (idx % 2 === 0 ? 1 : -1) * 1.5;
        return (
          <SortableMediaItem
            key={m.id}
            id={m.id}
            media={m}
            isStackMode
            onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }}
            onRemove={(type, origIdx) => removeMedia(type, origIdx)}
            onRoleChange={(type, origIdx, role) => handleRoleChange(type, origIdx, role)}
            style={{
              zIndex: allMedia.length - idx,
              '--stack-rotate': `${rot}deg`,
              '--stack-tx': `${tx}px`,
              '--stack-ty': `${ty}px`,
              '--expand-left': `${idx * 88}px`,
            } as React.CSSProperties}
          />
        );
      })}
      {allMedia.length > 20 && (
        <div className="jm-stack-badge">+{allMedia.length - 20}</div>
      )}
      <Popover
        content={renderAddMenu()}
        trigger="click"
        placement="bottomLeft"
        open={mediaPopoverOpen}
        onOpenChange={handlePopoverOpenChange}
        arrow={false}
        destroyTooltipOnHide
        overlayInnerStyle={{ padding: 0, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
      >
        <div
          className="jm-stack-add-card"
          style={{ '--expand-left': `${Math.min(allMedia.length, 20) * 88}px` } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <PlusOutlined style={{ fontSize: 20, color: '#9ca3af' }} />
        </div>
      </Popover>
      <div className="jm-stack-plus" onClick={(e) => { e.stopPropagation(); setMediaPopoverOpen(true); }}>
        <PlusOutlined />
      </div>
    </div>
  </SortableContext>
  <DragOverlay zIndex={100}>
    {activeId ? (() => {
      const m = allMedia.find(item => item.id === activeId);
      return m ? <SortableMediaItem id={m.id} media={m} isOverlay isStackMode /> : null;
    })() : null}
  </DragOverlay>
</DndContext>
```

- [ ] **Step 5: Add `handleRoleChange` callback**

```typescript
const handleRoleChange = useCallback((type: string, originalIndex: number, newRole: string) => {
  if (type !== 'image') return;
  setArkImagesWithRoles(prev => prev.map((img, i) => {
    if (i === originalIndex) return { ...img, role: newRole as any };
    if (img.role === newRole && (newRole === 'first_frame' || newRole === 'last_frame')) {
      return { ...img, role: 'reference_image' as any };
    }
    return img;
  }));
}, [setArkImagesWithRoles]);
```

- [ ] **Step 6: Verify build compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/components/JimengStyleEditor.tsx
git commit -m "feat: integrate DndContext + SortableContext for drag-and-drop sorting"
```

---

### Task 5: Add `.is-dragging` lock CSS + `DragOverlay` styles

**Files:**
- Modify: `src/components/JimengStyleEditor.css`

- [ ] **Step 1: Add `.is-dragging` lock rule**

```css
.jm-media-trigger.is-dragging .jm-stack-layer,
.jm-media-trigger.is-dragging .jm-stack-add-card {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translate(0, 0);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
```

- [ ] **Step 2: Add DragOverlay styles**

```css
.jm-drag-overlay {
  opacity: 0.85;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  border-radius: 10px;
  cursor: grabbing;
}

.jm-media-item-duration {
  position: absolute;
  bottom: 2px;
  right: 4px;
  font-size: 10px;
  color: #fff;
  background: rgba(0,0,0,0.6);
  padding: 1px 4px;
  border-radius: 3px;
  line-height: 1.2;
}
```

- [ ] **Step 3: Verify no CSS typos**

Open the CSS file and verify class names match the JSX.

- [ ] **Step 4: Commit**

```bash
git add src/components/JimengStyleEditor.css
git commit -m "feat: add is-dragging lock and DragOverlay CSS"
```

---

### Task 6: Global drag-and-drop file upload on `.jm-editor-container`

**Files:**
- Modify: `src/components/JimengStyleEditor.tsx:617-618`
- Modify: `src/components/JimengStyleEditor.css`

- [ ] **Step 1: Add drag counter ref and handlers**

After existing refs (~line 108):

```typescript
const dragCounterRef = useRef(0);

const handleContainerDragEnter = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  dragCounterRef.current++;
  if (dragCounterRef.current === 1) {
    e.currentTarget.classList.add('drag-over');
  }
}, []);

const handleContainerDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
}, []);

const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
  dragCounterRef.current--;
  if (dragCounterRef.current === 0) {
    e.currentTarget.classList.remove('drag-over');
  }
}, []);

const handleContainerDrop = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  dragCounterRef.current = 0;
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
    handleUnifiedUpload(file);
  }
}, [handleUnifiedUpload]);
```

- [ ] **Step 2: Attach events to `.jm-editor-container`**

Update the container div (~line 618):

```tsx
<div
  className="jm-editor-container"
  onDragEnter={handleContainerDragEnter}
  onDragOver={handleContainerDragOver}
  onDragLeave={handleContainerDragLeave}
  onDrop={handleContainerDrop}
>
```

- [ ] **Step 3: Stabilize `handleUnifiedUpload` reference**

`handleUnifiedUpload` is currently a plain `async` function (not memoized). Store in a ref to avoid re-creating `handleContainerDrop` every render:

```typescript
const handleUnifiedUploadRef = useRef(handleUnifiedUpload);
handleUnifiedUploadRef.current = handleUnifiedUpload;

// Then in handleContainerDrop, use:
const file = e.dataTransfer.files[0];
if (file) {
  handleUnifiedUploadRef.current(file);
}
// deps: [] (no dependency on handleUnifiedUpload)
```

- [ ] **Step 4: Add `.drag-over` CSS**

```css
.jm-editor-container.drag-over {
  border-color: #36b5f0;
  box-shadow: 0 0 0 3px rgba(54,181,240,0.12);
  background: #f0f9ff;
}
```

- [ ] **Step 5: Verify build compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/components/JimengStyleEditor.tsx src/components/JimengStyleEditor.css
git commit -m "feat: add global drag-and-drop file upload on editor container"
```

---

### Task 7: Build and visual verification

**Files:** None (verification only)

- [ ] **Step 1: Build Docker image**

```bash
cd d:\tecx\text
docker compose -f docker-compose.local.yml build --build-arg CACHEBUST=$(Get-Date -UFormat %s) sora-ui
```

- [ ] **Step 2: Start services**

```bash
docker compose -f docker-compose.local.yml up -d sora-ui
```

- [ ] **Step 3: Verify in browser at `http://localhost:8081/workspace`**

Test checklist:
- [ ] Hover expand shows cards with tilt
- [ ] Drag a card >8px starts sorting, DragOverlay follows
- [ ] Release on same-type card reorders
- [ ] Release on different-type card is no-op
- [ ] Esc cancels drag, restores original position
- [ ] Click (<8px) opens preview
- [ ] Right-click image shows role menu
- [ ] Drag external file onto editor highlights border
- [ ] Drop file triggers upload
- [ ] Bottom + pill still opens Popover
- [ ] Popover still works during hover expand

- [ ] **Step 4: Commit verification notes**

```bash
git commit --allow-empty -m "verify: Phase 2 dnd-sort-upload visual check passed"
```
