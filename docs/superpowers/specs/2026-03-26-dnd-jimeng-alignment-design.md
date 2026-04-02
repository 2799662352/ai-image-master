# DnD 即梦对齐改造设计

> 日期: 2026-03-26
> 状态: Reviewed
> 涉及文件: `SortableMediaItem.tsx`, `JimengStyleEditor.tsx`, `JimengStyleEditor.css`

## 背景

通过逆向分析即梦（jimeng.jianying.com）的参考内容拖拽实现，发现即梦同样使用 `@dnd-kit`，但在 6 个维度上做得更成熟。本次改造将我们的实现对齐到即梦的模式，提升拖拽的精准度和动画流畅度。

## 即梦核心模式（逆向所得）

### 组件架构

```
DndContext (全局，已有，保留 onDragStart/End/Cancel props)
  └─ SortableContext (items, strategy=horizontalListSortingStrategy)
       └─ SortableItem wrapper div (useSortable + 直出 transform)  ← dnd-kit 定位层
            └─ .jm-stack-layer (CSS transform 堆叠/展开)          ← 业务 UI 层
  └─ DragOverlay (从 activeDragData.renderDragOverlay 渲染)
```

### 即梦关键实现细节

1. **Transform 直出**: `CSS.Transform.toString(transform)` 直接写入 style，不经过 CSS 变量中转
2. **隐藏策略**: 拖拽时原位 `opacity: 0` 完全隐藏，不是半透明
3. **Transition 控制**: 无活跃拖拽时 `transition: 'none'`，只有拖拽进行中才启用 transition
4. **事件集中**: 即梦使用 `useDndMonitor` 集中事件（其 DndContext 在全局渲染）。**本项目**因 `DndContext` 是条件渲染的，改为保留 `DndContext` props 方式
5. **Overlay 渲染**: 从 `data.renderDragOverlay` 读取渲染函数，clone 去掉删除按钮
6. **disabled 对象形式**: `disabled: { draggable: boolean, droppable: boolean }`
7. **缓动曲线**: `cubic-bezier(0.4, 0, 0.2, 1)` (Material Design 标准)
8. **微交互**: hover `translateY(-8px) scale(1.125)`, active `scale(0.98)`

## 改造方案

### 改造 1: SortableMediaItem.tsx — 两层 DOM + Transform 直出

**问题**: 当前单层 DOM 上同时承载 dnd-kit 的 `transform: translate3d(x,y,0)` 和 CSS 的 `transform: rotate() translateX()` 堆叠定位，两者冲突。

**解决方案**: 拆为两层 DOM（即梦做法）：

```
<div ref={setNodeRef} style={wrapperStyle} {...attributes} {...listeners}>  ← dnd-kit 定位层
  <div className="jm-media-item jm-stack-layer" style={stackStyle}>         ← CSS 堆叠/展开层
    <img ... />
    <button className="jm-stack-delete" ... />
  </div>
</div>
```

**外层 wrapper 样式**（dnd-kit 控制）：

```typescript
const { active } = useDndContext();  // 获取当前拖拽状态，解决 activeId 来源问题

const wrapperStyle: React.CSSProperties = {
  transform: transform ? CSS.Transform.toString(transform) : undefined,  // null guard
  transition: active?.id ? transition : 'none',  // 无拖拽时关闭 transition
  opacity: isDragging ? 0 : 1,                    // 拖拽时完全隐藏
  // 外层不设 width/height — 由 position:absolute + 内层 .jm-stack-layer 的 72x90px 撑开
  position: 'absolute',
  top: 0,
  left: 0,
};
```

**关键细节**:
- `activeId` 来源: 通过 `useDndContext()` 获取 `active`，而非新增 prop。`useDndContext()` 在 `DndContext` 子树内有效。
- null guard: `transform ? CSS.Transform.toString(transform) : undefined` 防止空值。
- 外层 wrapper 需要 `position: absolute; top: 0; left: 0` 保持和现有 `.jm-stack-layer` 相同的定位上下文（`.jm-stack-container` 是 `position: relative`）。

### 改造 2: JimengStyleEditor.tsx — 事件处理改造

**方案选择**: 保留 `DndContext` 的 `onDragStart`/`onDragEnd`/`onDragCancel` props（不迁移到 `useDndMonitor`）。

**原因**: `useDndMonitor` 必须在 `DndContext` provider 子树内调用。当前 `DndContext` 只在 `allMedia.length > 0` 时才渲染，且只包裹堆叠区子树，不是整个编辑器。将 monitor 放在 `JimengStyleEditor` 顶层会违反 context 约束。保留 DndContext props 是最简方案。

**改动**:

```typescript
<DndContext
  sensors={sensors}
  collisionDetection={closestCenter}
  onDragStart={handleDragStart}
  onDragEnd={handleDragEnd}
  onDragCancel={handleDragCancel}  // ← 新增：处理 Escape / 指针取消
>

// handleDragStart — 不变
const handleDragStart = useCallback((event: DragStartEvent) => {
  setActiveId(event.active.id as string);
  setActiveDragData(event.active.data.current);  // ← 新增：保存 data 供 DragOverlay 使用
  mediaTriggerRef.current?.classList.add('is-dragging');
}, []);

// handleDragEnd — 逻辑不变，已使用 originalIndex
const handleDragEnd = useCallback((event: DragEndEvent) => {
  setActiveId(null);
  setActiveDragData(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');
  // ... arrayMove 逻辑不变
}, [setArkImagesWithRoles, setArkVideosWithRoles, setArkAudiosWithRoles]);

// handleDragCancel — 新增
const handleDragCancel = useCallback(() => {
  setActiveId(null);
  setActiveDragData(null);
  mediaTriggerRef.current?.classList.remove('is-dragging');
}, []);
```

### 改造 3: DragOverlay — 从 onDragStart 保存的 data 渲染

**现在**: `DragOverlay` 内部硬编码渲染 `SortableMediaItem` with `isOverlay={true}`。

**改为**: 在 `onDragStart` 时保存 `active.data.current`，在 `DragOverlay` 中用 `activeDragData` 渲染。

```typescript
// 新增 state
const [activeDragData, setActiveDragData] = useState<Record<string, any> | null>(null);

// onDragStart 时保存
setActiveDragData(event.active.data.current);

// DragOverlay 中读取 renderDragOverlay
<DragOverlay dropAnimation={null}>
  {activeId && activeDragData?.renderDragOverlay
    ? activeDragData.renderDragOverlay()
    : null}
</DragOverlay>
```

**SortableMediaItem 中设置 renderDragOverlay**:

```typescript
// 使用 useCallback 保持稳定引用
const renderOverlay = useCallback(() => (
  <div className="jm-media-item jm-drag-overlay" style={{ width: 72, height: 90 }}>
    {/* 渲染媒体内容，不渲染删除按钮 */}
    {media.type === 'image' && <img src={media.displayUrl || media.url} alt="参考" draggable={false} />}
    {media.type === 'video' && (media.thumbnail ? <img src={media.thumbnail} ... /> : <VideoCameraOutlined />)}
    {media.type === 'audio' && <AudioOutlined />}
    {media.duration != null && <span className="jm-media-item-duration">{formatDuration(media.duration)}</span>}
  </div>
), [media]);

useSortable({
  id,
  disabled: { draggable: !!disabled, droppable: false },
  data: { type: 'media', media, renderDragOverlay: renderOverlay },
});
```

**注意**: `renderDragOverlay` 用 `useCallback` 包裹，避免每次渲染重建。Overlay 渲染时不包含删除按钮和 Dropdown（和即梦一致）。

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

### 改造 5: SortableMediaItem + Ant Design Dropdown 集成

拆分为两层后，Dropdown 的挂载需要调整：

```tsx
export const SortableMediaItem = ({ ... }) => {
  const { active } = useDndContext();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled: { draggable: !!disabled, droppable: false },
    data: { type: 'media', media, renderDragOverlay: renderOverlay },
  });

  const wrapperStyle: React.CSSProperties = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    transition: active?.id ? transition : 'none',
    opacity: isDragging ? 0 : 1,
    position: 'absolute',
    top: 0,
    left: 0,
  };

  const innerContent = (
    <div
      className={`jm-media-item ${isStackMode ? 'jm-stack-layer' : ''}`}
      style={customStyle}  // --stack-rotate, --expand-left, etc.
    >
      {/* 媒体内容 + 删除按钮 */}
    </div>
  );

  // Dropdown 包在外层 wrapper 外面，这样右键菜单不被 dnd listeners 干扰
  const wrapped = (
    <div ref={setNodeRef} style={wrapperStyle} {...attributes} {...listeners}>
      {innerContent}
    </div>
  );

  return media.type === 'image' ? (
    <Dropdown menu={...} trigger={['contextMenu']}>
      {wrapped}
    </Dropdown>
  ) : wrapped;
};
```

**注意**: Dropdown 包在 dnd wrapper 外面。`onPointerDown` stopPropagation 在删除按钮上仍然需要，防止点删除时触发拖拽。

### 改造 6: CSS `.is-dragging` 状态清理

去掉 `--dnd-tx/ty` 后，`.is-dragging` 状态下的 `.jm-stack-layer` transform 规则也要更新：

```css
/* Before */
.jm-media-trigger.is-dragging .jm-stack-layer {
  transform: translate(var(--dnd-tx, 0px), var(--dnd-ty, 0px)) translateX(var(--expand-left)) rotate(var(--stack-rotate)) translate(0, 0);
}

/* After — 外层 wrapper 已经处理 dnd 位移 */
.jm-media-trigger.is-dragging .jm-stack-layer {
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate));
}
```

确保所有引用 `--dnd-tx`/`--dnd-ty` 的选择器都清理干净。

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
3. DragOverlay 跟随鼠标，无删除按钮，dropAnimation 设为 null
4. hover 卡片上浮+放大，press 缩小
5. 堆叠/展开的 CSS 动画使用 Material Design 缓动 `cubic-bezier(0.4, 0, 0.2, 1)`
6. 无 transform 冲突导致的视觉错位（两层 DOM 隔离）
7. Escape 键 / 指针取消能正确清理状态（`onDragCancel`）
8. 右键菜单（Dropdown）在拖拽 wrapper 外层，不受 dnd listeners 干扰
9. 现有功能（上传、预览、角色切换、文本编辑）不受影响
