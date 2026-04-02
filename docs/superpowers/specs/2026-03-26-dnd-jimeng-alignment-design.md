# DnD 即梦对齐改造设计

> 日期: 2026-03-26
> 状态: Draft
> 涉及文件: `SortableMediaItem.tsx`, `JimengStyleEditor.tsx`, `JimengStyleEditor.css`

## 背景

通过逆向分析即梦（jimeng.jianying.com）的参考内容拖拽实现，发现即梦同样使用 `@dnd-kit`，但在 6 个维度上做得更成熟。本次改造将我们的实现对齐到即梦的模式，提升拖拽的精准度和动画流畅度。

## 即梦核心模式（逆向所得）

### 组件架构

```
DndContext (全局，已有)
  └─ SortContainer (useDndMonitor 集中事件)
       └─ SortableContext (items, strategy)
            └─ SortableItem (useSortable + 直出 transform)
                 └─ ReferenceCard (业务 UI)
```

### 即梦关键实现细节

1. **Transform 直出**: `CSS.Transform.toString(transform)` 直接写入 style，不经过 CSS 变量中转
2. **隐藏策略**: 拖拽时原位 `opacity: 0` 完全隐藏，不是半透明
3. **Transition 控制**: 无活跃拖拽时 `transition: 'none'`，只有拖拽进行中才启用 transition
4. **事件集中**: 使用 `useDndMonitor({ onDragStart, onDragMove, onDragEnd })` 替代 DndContext props
5. **Overlay 渲染**: 从 `data.renderDragOverlay` 读取渲染函数，clone 去掉删除按钮
6. **disabled 对象形式**: `disabled: { draggable: boolean, droppable: boolean }`
7. **缓动曲线**: `cubic-bezier(0.4, 0, 0.2, 1)` (Material Design 标准)
8. **微交互**: hover `translateY(-8px) scale(1.125)`, active `scale(0.98)`

## 改造方案

### 改造 1: SortableMediaItem.tsx — Transform 直出

**去掉** CSS 变量 `--dnd-tx`/`--dnd-ty` 中转，改为即梦模式：

```typescript
// Before
const style = {
  ...customStyle,
  '--dnd-tx': transform ? `${Math.round(transform.x)}px` : '0px',
  '--dnd-ty': transform ? `${Math.round(transform.y)}px` : '0px',
  ...(isOverlay ? { transform: CSS.Transform.toString(transform) } : {}),
  transition: isOverlay ? undefined : transition,
  opacity: isDragging && !isOverlay ? 0.3 : 1,
};

// After (即梦模式)
const style = {
  ...customStyle,
  transform: CSS.Transform.toString(transform),
  transition: activeId ? transition : 'none',
  opacity: isDragging ? 0 : 1,
  width: '100%',
  height: '100%',
};
```

**注意**: 因为我们的堆叠定位使用 CSS `transform`（rotate, translateX 等），而 `@dnd-kit` 的 `CSS.Transform.toString()` 也会设置 `transform`，两者会冲突。

**解决方案**: SortableMediaItem 只包一层 `<div>` 作为 dnd-kit 的定位层，内部的 `.jm-stack-layer` 继续用 CSS transform 控制堆叠/展开。这正是即梦的做法 — 他们的 sortable wrapper 是一层透明 div（`width:100%, height:100%`），实际卡片样式在子元素上。

```
<div ref={setNodeRef} style={dndStyle} {...attributes} {...listeners}>  ← dnd-kit 控制层
  <div className="jm-stack-layer" style={stackStyle}>                    ← CSS 堆叠/展开层
    <img ... />
    <button className="jm-stack-delete" ... />
  </div>
</div>
```

### 改造 2: JimengStyleEditor.tsx — useDndMonitor 集中事件

**去掉** `DndContext` 上的 `onDragStart`/`onDragEnd` props。

**新增** 组件内 `useDndMonitor` hook：

```typescript
useDndMonitor({
  onDragStart({ active }) {
    setActiveId(active.id as string);
    mediaTriggerRef.current?.classList.add('is-dragging');
  },
  onDragMove({ active }) {
    // 可选：拖出容器时 overlay 变半透明
    // const dragRect = active.rect.current.translated;
    // const containerRect = editorRef.current?.getBoundingClientRect();
    // if (dragRect && containerRect && !intersects(dragRect, containerRect)) {
    //   overlayRef.current?.style.opacity = '0.5';
    // }
  },
  onDragEnd({ active, over }) {
    setActiveId(null);
    mediaTriggerRef.current?.classList.remove('is-dragging');
    if (!over || active.id === over.id) return;

    const activeMedia = active.data.current?.media as UnifiedMedia | undefined;
    const overMedia = over.data.current?.media as UnifiedMedia | undefined;
    if (!activeMedia || !overMedia || activeMedia.type !== overMedia.type) return;

    const oldIdx = activeMedia.originalIndex;
    const newIdx = overMedia.originalIndex;
    if (oldIdx === newIdx) return;

    if (activeMedia.type === 'image') setArkImagesWithRoles(prev => arrayMove(prev, oldIdx, newIdx));
    else if (activeMedia.type === 'video') setArkVideosWithRoles(prev => arrayMove(prev, oldIdx, newIdx));
    else if (activeMedia.type === 'audio') setArkAudiosWithRoles(prev => arrayMove(prev, oldIdx, newIdx));
  },
});
```

### 改造 3: DragOverlay — renderDragOverlay 模式

**现在**: `DragOverlay` 内部硬编码渲染 `SortableMediaItem`。

**改为**: 从 `active.data.current.renderDragOverlay` 读取渲染函数：

```typescript
// SortableMediaItem 中设置 data
useSortable({
  id,
  data: {
    type: 'media',
    media,
    renderDragOverlay: () => (
      <div className="jm-media-item jm-drag-overlay">
        {/* 渲染媒体内容，但不渲染删除按钮 */}
      </div>
    ),
  },
});

// JimengStyleEditor 中读取
<DragOverlay>
  {activeId && activeMedia?.data?.current?.renderDragOverlay?.()}
</DragOverlay>
```

### 改造 4: CSS — 去掉 --dnd-tx/ty，新增微交互

#### 4a. 去掉 CSS 变量中转

`.jm-stack-layer` 的 `transform` 不再包含 `translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px))`，因为 dnd-kit 的位移由外层 wrapper div 的 `transform` 直接控制。

```css
/* Before */
.jm-stack-layer {
  transform: translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px)) translateX(0) rotate(var(--stack-rotate)) translate(var(--stack-tx), var(--stack-ty));
}

/* After — 纯 CSS 堆叠定位 */
.jm-stack-layer {
  transform: rotate(var(--stack-rotate)) translate(var(--stack-tx), var(--stack-ty));
}
```

同理更新 hover/expanded 和 `.is-dragging` 状态。

#### 4b. 缓动曲线对齐

```css
/* Before */
.jm-stack-layer {
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* After — Material Design 标准 */
.jm-stack-layer {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

#### 4c. hover 上浮 + press 缩放

```css
/* hover 展开后，单个卡片悬停 — 上浮+放大 */
.jm-media-trigger:hover .jm-stack-layer:hover:not(:active),
.jm-media-trigger.popover-open .jm-stack-layer:hover:not(:active) {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translateY(-8px) scale(1.125);
  z-index: 30 !important;
}

/* press 按下 — 上浮+缩小 */
.jm-media-trigger:hover .jm-stack-layer:active,
.jm-media-trigger.popover-open .jm-stack-layer:active {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translateY(-8px) scale(0.98);
  z-index: 30 !important;
}
```

#### 4d. DragOverlay 样式

```css
.jm-drag-overlay {
  opacity: 0.85;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  border-radius: 10px;
  cursor: grabbing;
  pointer-events: none;
}
```

### 改造 5: SortableMediaItem 结构重组

将 `SortableMediaItem` 拆分为两层：

- **外层**: dnd-kit wrapper（`ref={setNodeRef}`, `style={dndStyle}`，`...attributes`, `...listeners`）
- **内层**: `.jm-stack-layer`（CSS transform 堆叠/展开动画）

这样 dnd-kit 的 `transform: translate3d(x, y, 0)` 和 CSS 的 `transform: rotate() translateX()` 在不同 DOM 层上，不再冲突。

```tsx
export const SortableMediaItem = ({ ... }) => {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ ... });

  const wrapperStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: activeId ? transition : 'none',
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={wrapperStyle} {...attributes} {...listeners}>
      <div
        className={`jm-media-item jm-stack-layer`}
        style={stackStyle}  // --stack-rotate, --expand-left, etc.
      >
        {/* 媒体内容 + 删除按钮 */}
      </div>
    </div>
  );
};
```

## 不变的部分

- 堆叠卡片 CSS 变量定位系统（`--stack-rotate`, `--expand-left`, `--stack-tx`, `--stack-ty`）
- Popover 交互逻辑
- 全局拖拽上传（`onDragOver`/`onDrop` on container）
- 右键菜单角色切换
- 媒体类型检测和上传流程
- `allMedia` useMemo 和 URL-tail-based stable IDs

## 改造验收标准

1. 拖拽排序在展开状态下流畅工作，其他 item 有平滑的磁力位移动画
2. 拖拽时原位完全隐藏（opacity: 0）
3. DragOverlay 跟随鼠标，无删除按钮
4. hover 卡片上浮+放大，press 缩小
5. 堆叠/展开的 CSS 动画使用 Material Design 缓动
6. 无 transform 冲突导致的视觉错位
7. 现有功能（上传、预览、角色切换、文本编辑）不受影响
