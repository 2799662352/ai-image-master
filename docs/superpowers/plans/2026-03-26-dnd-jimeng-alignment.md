# DnD 即梦对齐改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the drag-and-drop implementation to match Jimeng's @dnd-kit patterns — two-layer DOM, direct transform, Material Design easing, hover/press micro-interactions.

**Architecture:** Split SortableMediaItem into outer dnd-kit wrapper + inner CSS stacking layer. Keep DndContext props for events. Use renderDragOverlay pattern for overlay rendering.

**Tech Stack:** @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities (all already installed), React, CSS

**Spec:** `docs/superpowers/specs/2026-03-26-dnd-jimeng-alignment-design.md`

---

### Task 1: SortableMediaItem — Two-Layer DOM + Transform Direct

**Files:**
- Modify: `src/components/SortableMediaItem.tsx`

- [ ] **Step 1: Add useDndContext import and renderDragOverlay callback**

In `SortableMediaItem.tsx`, add `useDndContext` import and create the `renderOverlay` callback:

```typescript
// Line 1-2: Update imports
import { useSortable } from '@dnd-kit/sortable';
import { useDndContext } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
```

- [ ] **Step 2: Rewrite the component body — two-layer DOM**

Replace the entire component body (lines 28-164) with the two-layer pattern:

```typescript
export const SortableMediaItem: React.FC<SortableMediaItemProps> = ({
  id, disabled, media, onPreview, onRemove, onRoleChange, onReplace, isStackMode, style: customStyle, isOverlay
}) => {
  const { active } = useDndContext();

  const renderOverlay = useCallback(() => (
    <div className="jm-media-item jm-drag-overlay" style={{ width: 72, height: 90, borderRadius: 6, overflow: 'hidden', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {media.type === 'image' && <img src={media.displayUrl || media.url} alt="参考" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      {media.type === 'video' && (
        media.thumbnail
          ? <img src={media.thumbnail} alt="视频封面" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <VideoCameraOutlined style={{ fontSize: 24, color: '#9ca3af' }} />
      )}
      {media.type === 'audio' && <AudioOutlined style={{ fontSize: 24, color: '#9ca3af' }} />}
      {media.duration != null && <span className="jm-media-item-duration">{formatDuration(media.duration)}</span>}
    </div>
  ), [media]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: { draggable: !!disabled, droppable: false },
    data: { type: 'media', media, renderDragOverlay: renderOverlay },
  });

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const touchTimer = useRef<NodeJS.Timeout | null>(null);

  // Outer wrapper: dnd-kit controls transform directly
  const wrapperStyle: React.CSSProperties = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    transition: active?.id ? transition : 'none',
    opacity: isDragging ? 0 : 1,
    position: 'absolute' as const,
    top: 0,
    left: 0,
  };

  // ... keep getRoleLabel, menuItems, handleMenuClick, touch handlers unchanged ...

  const innerContent = (
    <div
      className={`jm-media-item ${isStackMode ? 'jm-stack-layer' : ''}`}
      style={customStyle}
      onClick={(e) => {
        e.stopPropagation();
        if (onPreview) {
          if (media.type === 'image') onPreview(media.url);
          else if (media.type === 'video' && media.thumbnail) onPreview(media.thumbnail);
        }
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
    >
      {media.type === 'image' && <img src={media.displayUrl || media.url} alt="参考" draggable={false} />}
      {media.type === 'video' && (
        media.thumbnail
          ? <img src={media.thumbnail} alt="视频封面" draggable={false} />
          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><VideoCameraOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>
      )}
      {media.type === 'audio' && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><AudioOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>}

      {(media.type !== 'image' || media.role === 'first_frame' || media.role === 'last_frame' || media.url.startsWith('asset://')) && (
        <div className="jm-media-item-label">{getRoleLabel()}</div>
      )}
      {media.duration != null && (
        <span className="jm-media-item-duration">{formatDuration(media.duration)}</span>
      )}

      {onRemove && (
        <button
          className="jm-stack-delete"
          onClick={(e) => { e.stopPropagation(); onRemove(media.type, media.originalIndex); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <CloseOutlined />
        </button>
      )}
    </div>
  );

  // Two-layer: outer dnd wrapper + inner CSS stacking
  const wrapped = (
    <div ref={setNodeRef} style={wrapperStyle} {...attributes} {...listeners}>
      {innerContent}
    </div>
  );

  // Dropdown wraps the outer dnd wrapper for context menu
  return media.type === 'image' ? (
    <Dropdown
      menu={{ items: menuItems, onClick: handleMenuClick }}
      trigger={['contextMenu']}
      open={dropdownOpen}
      onOpenChange={setDropdownOpen}
    >
      {wrapped}
    </Dropdown>
  ) : wrapped;
};
```

- [ ] **Step 3: Remove isOverlay-specific code**

The `isOverlay` prop is no longer needed in the main component since overlay is rendered via `renderDragOverlay`. Remove:
- `isOverlay` from the props interface
- All `isOverlay` conditional logic (the old single-layer overlay path)
- The `!isOverlay` guard on the delete button

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit 2>&1 | head -30`
Expected: No new errors in SortableMediaItem.tsx (pre-existing errors in other files are OK)

- [ ] **Step 5: Commit**

```bash
git add src/components/SortableMediaItem.tsx
git commit -m "refactor(SortableMediaItem): two-layer DOM + direct transform (Jimeng pattern)"
```

---

### Task 2: JimengStyleEditor.tsx — Event Handlers + DragOverlay

**Files:**
- Modify: `src/components/JimengStyleEditor.tsx:592-624,809-823`

- [ ] **Step 1: Add activeDragData state**

After `const [activeId, setActiveId] = useState<string | null>(null);` (line 99), add:

```typescript
const [activeDragData, setActiveDragData] = useState<Record<string, any> | null>(null);
```

- [ ] **Step 2: Update handleDragStart to save drag data**

Replace lines 592-595:

```typescript
const handleDragStart = useCallback((event: DragStartEvent) => {
  setActiveId(event.active.id as string);
  setActiveDragData(event.active.data.current ?? null);
  mediaTriggerRef.current?.classList.add('is-dragging');
}, []);
```

- [ ] **Step 3: Update handleDragEnd to clear drag data**

Replace lines 597-598 (just after `setActiveId(null)`):

```typescript
const handleDragEnd = useCallback((event: DragEndEvent) => {
  setActiveId(null);
  setActiveDragData(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');
  // ... rest of arrayMove logic stays exactly the same
```

- [ ] **Step 4: Update handleDragCancel to clear drag data**

Replace lines 621-624:

```typescript
const handleDragCancel = useCallback(() => {
  setActiveId(null);
  setActiveDragData(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');
}, []);
```

- [ ] **Step 5: Replace DragOverlay content with renderDragOverlay pattern**

Replace lines 809-823:

```typescript
<DragOverlay dropAnimation={null}>
  {activeId && activeDragData?.renderDragOverlay
    ? activeDragData.renderDragOverlay()
    : null}
</DragOverlay>
```

- [ ] **Step 6: Remove `isOverlay` and `disabled` props from old DragOverlay SortableMediaItem call**

The old code at lines 813-821 renders `<SortableMediaItem ... isOverlay disabled />`. This is now replaced by the renderDragOverlay pattern above, so this entire block is gone.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd 25/soraui_4.0/sora-ui && npx tsc --noEmit 2>&1 | head -30`
Expected: No new errors

- [ ] **Step 8: Commit**

```bash
git add src/components/JimengStyleEditor.tsx
git commit -m "refactor(JimengStyleEditor): activeDragData + renderDragOverlay + onDragCancel"
```

---

### Task 3: CSS — Remove --dnd-tx/ty, Material Easing, Micro-interactions

**Files:**
- Modify: `src/components/JimengStyleEditor.css:91-131,730-742`

- [ ] **Step 1: Update .jm-stack-layer base transform and transition**

Replace line 105-108:

```css
.jm-stack-layer {
  /* ... keep position, top, left, width, height, border-radius, border, background, overflow, box-shadow, display, align-items, justify-content ... */
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.25s ease,
              opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: bottom center;
  transform: rotate(var(--stack-rotate)) translate(var(--stack-tx), var(--stack-ty));
  will-change: transform;
  contain: layout style paint;
}
```

Key changes:
- Remove `translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px))` from transform
- Change `cubic-bezier(0.34, 1.56, 0.64, 1)` → `cubic-bezier(0.4, 0, 0.2, 1)`
- Add `opacity` transition

- [ ] **Step 2: Update hover/expanded state transform**

Replace lines 120-124:

```css
.jm-media-trigger:hover .jm-stack-layer,
.jm-media-trigger.popover-open .jm-stack-layer {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translate(0, 0);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
```

Remove the `translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px))` prefix.

- [ ] **Step 3: Replace hover box-shadow rule with hover lift + scale**

Replace lines 126-130:

```css
/* Hover: lift + scale up (Jimeng pattern) */
.jm-media-trigger:hover .jm-stack-layer:hover:not(:active),
.jm-media-trigger.popover-open .jm-stack-layer:hover:not(:active) {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translateY(-8px) scale(1.125);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  z-index: 30 !important;
}

/* Press: lift + scale down (Jimeng pattern) */
.jm-media-trigger:hover .jm-stack-layer:active,
.jm-media-trigger.popover-open .jm-stack-layer:active {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translateY(-8px) scale(0.98);
  z-index: 30 !important;
}
```

- [ ] **Step 4: Update .is-dragging state**

Replace lines 730-735:

```css
.jm-media-trigger.is-dragging .jm-stack-layer,
.jm-media-trigger.is-dragging .jm-stack-add-card {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate));
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
```

Remove the `translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px))` prefix.

- [ ] **Step 5: Update .jm-stack-container transition**

Replace line 81:

```css
.jm-stack-container {
  /* ... */
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  /* ... */
}
```

Change from `0.35s cubic-bezier(0.34, 1.56, 0.64, 1)`.

- [ ] **Step 6: Update .jm-stack-add-card transition**

Replace lines 243-244:

```css
.jm-stack-add-card {
  /* ... */
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  /* ... */
}
```

- [ ] **Step 7: Verify no remaining --dnd-tx/ty references**

Run: `grep -n "dnd-tx\|dnd-ty" src/components/JimengStyleEditor.css`
Expected: No matches

- [ ] **Step 8: Commit**

```bash
git add src/components/JimengStyleEditor.css
git commit -m "style: Material Design easing, hover/press micro-interactions, remove --dnd-tx/ty"
```

---

### Task 4: Build + Visual Verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Docker build**

```bash
cd 25/soraui_4.0 && docker compose -f docker-compose.local.yml build
```

- [ ] **Step 2: Start the dev server**

```bash
docker compose -f docker-compose.local.yml up -d
```

- [ ] **Step 3: Open browser and verify**

Navigate to `http://localhost:8081/workspace`. Upload 3+ images to the reference area.

Verify against acceptance criteria:
1. Stacked cards display correctly (rotate, stagger)
2. Hover → cards expand horizontally with smooth Material easing
3. Hover individual card → lifts up (-8px) and scales (1.125)
4. Press card → scales down (0.98)
5. Drag a card → original position fully hidden (opacity: 0)
6. DragOverlay follows mouse, shows card without delete button
7. Drop on different position → smooth magnetic sort animation
8. Escape during drag → clean cancel, cards snap back
9. Delete button shows on hover, works correctly
10. Right-click context menu works for role changes
11. + card at end still works to add new media

- [ ] **Step 4: Commit verification notes**

If all checks pass, done. If issues found, fix and re-verify before proceeding.
