---
date: 2026-04-02
topic: sora-ui-dnd-sort-upload
---

# Sora UI 媒体拖拽排序 + 全局拖拽上传设计 (Phase 2)

## What We're Building

在 Phase 1 的基础上（堆叠卡片 hover 展开、删除按钮、Popover 精简、底部 + pill），引入 `@dnd-kit` 实现展开态卡片拖拽排序、全局拖拽上传、右键角色切换。

Phase 1 spec: `docs/superpowers/specs/2026-04-01-sora-ui-media-editor-ux-design.md`
Phase 1 plan: `docs/superpowers/plans/2026-04-01-sora-ui-media-editor-ux.md`

## 基线状态

| 已有 | 状态 |
|------|------|
| `@dnd-kit/core` ^6.3.1, `@dnd-kit/sortable` ^10.0.0, `@dnd-kit/utilities` ^3.2.2 | 已安装 (legacy API: `DndContext` + `SortableContext`) |
| `SortableMediaItem.tsx` | 已创建，使用 `useSortable({attributes, listeners, setNodeRef, transform, transition})`，包含 `data: {type: 'media', media}` 和 `<img draggable={false}>` |
| 底部 `+` pill 按钮 | 已实现 (line 913-925) |
| hover 展开 + 删除 + 倾斜角 + 时长 + 缩略图 | 已实现 (Phase 1) |
| `DndContext` 集成到 `JimengStyleEditor` | **未实现** |
| 展开态拖拽排序 | **未实现** |
| 全局拖拽上传 | **未实现** |
| 右键角色切换 | **未实现** |

> **API 版本说明**：Context7 文档显示 @dnd-kit 有新版 `@dnd-kit/react` + `DragDropProvider` API。本项目使用 legacy API（`@dnd-kit/core` + `@dnd-kit/sortable`），迁移到新 API 不在 Phase 2 范围内。

## 设计决策

### 决策 1: hover 展开 + 拖拽锁定 (方案 C)

保持现有 hover 展开交互不变。拖拽开始时给 `.jm-media-trigger` 加 `.is-dragging` class 锁定展开态，拖拽结束后移除。

- `PointerSensor` 设置 `activationConstraint.distance: 8`，区分点击/拖拽
- `KeyboardSensor` 配合 `sortableKeyboardCoordinates` 作为 `coordinateGetter`，匹配水平排序策略
- 拖拽期间 hover 离开不会触发折叠

Sensors 初始化：
```typescript
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
);
```

**否决方案:**
- A (纯锁定): 概念不如 C 清晰，缺少 distance 门槛
- B (点击展开): 破坏现有 hover 交互，用户需要重新学习

### 决策 2: 全局拖拽上传范围 = `.jm-editor-container` (方案 Y)

整个编辑器卡片（含文本区 + 底部工具栏）作为 drop zone。

- `onDragOver` 加 `.drag-over` 高亮边框 (`border-color: #36b5f0`)
- `onDrop` 自动识别文件类型调用 `handleUnifiedUpload`
- 比全页面 drop zone 更克制，不需要处理与其他组件的冲突

**否决方案:**
- X (仅 `.jm-editor-top`): 目标太小，用户拖文件需要精确瞄准
- Z (全页面): 过度工程化，YAGNI

### 决策 3: 卡片统一用 `SortableMediaItem` (方案 P)

折叠态和展开态都渲染 `SortableMediaItem` 组件，折叠态通过 `disabled: true` 禁用拖拽。

- 消除 `JimengStyleEditor.tsx` 中 ~50 行内联卡片渲染与 `SortableMediaItem` 的重复代码
- 折叠→展开过渡中不会 unmount/remount，CSS transition 天然保持
- `useSortable` 在 `disabled` 时几乎零开销

**否决方案:**
- Q (折叠态内联): 两套渲染逻辑，维护成本高，过渡动画断裂

### 决策 4: 底部 `+` 按钮保持现有实现

已实现且交互正确，不需要改动。

### 决策 5: 仅可见卡片可排序（前 20 张）

`SortableContext` 的 `items` 必须与 DOM 中挂载的 sortable 节点一一对应。当前堆叠区只渲染 `allMedia.slice(0, 20)`，超出部分显示 `+N` badge。因此排序范围限定为前 20 张可见卡片。

第 21+ 张卡片不参与排序，不影响用户操作（日常用量 <10 张）。

### 决策 6: 同类型内排序（不支持跨类型交叉排序）

当前 `allMedia` 的 `useMemo` 固定按 `[images, videos, audios]` 顺序拼接。跨类型排序后，下次渲染会重建原始顺序，导致排序结果丢失。

解决方案：**限制排序为同类型内**。`handleDragEnd` 检查 `active` 和 `over` 是否同类型，不同类型时 no-op。这保持了三个状态数组的独立性，同时满足用户最常见的需求（调整多张参考图的顺序）。

跨类型排序（如"把视频移到图片前面"）需要引入全局有序数组，列为 Phase 3。

### 决策 7: 使用稳定 ID（基于 URL hash）

当前 `id: img-${i}` 是位置索引，排序后会变化，导致 @dnd-kit 动画闪烁。改为基于内容的稳定 ID：

```
id = `${type}-${url的最后16字符}`
```

同一 URL 不会出现两次（上传去重），16 字符足够区分。这确保排序后 ID 不变，@dnd-kit 能正确追踪元素位置。

## 功能规格

### 1. `DndContext` 集成

```
<DndContext sensors={sensors} collisionDetection={closestCenter}
            onDragStart={handleDragStart} onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}>
  <SortableContext items={visibleMedia.map(m => m.id)} strategy={horizontalListSortingStrategy}>
    {/* 堆叠区卡片（前 20 张） */}
  </SortableContext>
  <DragOverlay zIndex={100}>
    {activeId && <SortableMediaItem id={activeId} media={...} isOverlay />}
  </DragOverlay>
</DndContext>
```

- `DndContext` 包裹 `.jm-media-trigger` 区域
- `SortableContext` 使用 `horizontalListSortingStrategy`（展开态是水平一行排列）
- `visibleMedia = allMedia.slice(0, 20)`，只包含已挂载的卡片
- `DragOverlay` 渲染半透明跟随元素，z-index 100
- **0 项时**：`DndContext` 不渲染，空状态走现有 Popover 分支
- **1 项时**：`DndContext` 正常渲染，排序 no-op（无目标位置）

### 2. 拖拽排序逻辑 (`handleDragEnd`)

```typescript
// Legacy API: onDragEnd 接收 { active, over } 参数
handleDragEnd({ active, over }):
  1. 清除 activeId + 移除 .is-dragging（无论如何都执行）
  2. if (!over || active.id === over.id) → return（拖回原位 / 取消）
  3. 通过 active.data.current.media 和 over.data.current.media 获取媒体元素
  4. if (activeMedia.type !== overMedia.type) → return（跨类型不排序）
  5. 在对应的类型数组中用 originalIndex 定位，执行 arrayMove：
     - 图片: setArkImagesWithRoles(prev => arrayMove(prev, oldIdx, newIdx))
     - 视频: setArkVideosWithRoles(prev => arrayMove(prev, oldIdx, newIdx))
     - 音频: setArkAudiosWithRoles(prev => arrayMove(prev, oldIdx, newIdx))

handleDragCancel():
  清除 activeId + 移除 .is-dragging（与 dragEnd 失败路径相同）
```

由于排序限定在同类型内，直接对单个类型数组 `arrayMove`，无需拆分/合并。`videoDurations`、`audioDurations` 等索引映射也跟随数组一起移动（因为它们用的是同一个 index）。

**实现要点**：将 `duration`、`thumbnail` 等数据嵌入到 `VideoWithRole`/`AudioWithRole` 对象本身（而非外部 index-keyed map），排序时数据自然跟随。这同时消除了现有 `videoDurations`/`audioDurations` 的 stale closure 问题。

### 3. 拖拽锁定展开态

```
onDragStart → setActiveId(id) + 加 .is-dragging class
onDragEnd   → setActiveId(null) + 移除 .is-dragging class
onDragCancel → setActiveId(null) + 移除 .is-dragging class
```

CSS:
```css
.jm-media-trigger.is-dragging .jm-stack-layer,
.jm-media-trigger.is-dragging .jm-stack-add-card {
  /* 与 hover 展开态相同的 transform */
  transform: translateX(var(--expand-left)) rotate(var(--stack-rotate)) translate(0, 0);
}
```

### 4. 全局拖拽上传

`.jm-editor-container` 添加**基于计数器**的 drag 状态管理，避免 `relatedTarget` 不可靠问题：

```
dragCounter = useRef(0)

onDragEnter: dragCounter++ → 加 .drag-over class
onDragOver:  e.preventDefault()（必须，否则 drop 无效）
onDragLeave: dragCounter-- → if (0) 移除 .drag-over class
onDrop:      dragCounter = 0 → 移除 .drag-over → 处理文件
```

文件处理：
- 单文件：`files[0]` 传给 `handleUnifiedUpload`
- 多文件：**忽略**，只处理第一个文件（与现有上传行为一致）

视觉反馈: `.drag-over` 时 `border-color: #36b5f0`, `box-shadow: 0 0 0 3px rgba(54,181,240,0.12)`, `background: #f0f9ff`

**Popover portal 兼容**：Ant Design Popover 使用 portal 渲染到 `document.body`，不在 `.jm-editor-container` 内。文件拖到 Popover 上方时不会触发容器的 drop。这是正确行为——Popover 用于选择"上传/素材库/人像库"，不需要接受文件拖入。

### 5. 右键角色切换

图片卡片右键弹出 `antd Dropdown`:
- "设为首帧" (`first_frame`)
- "设为尾帧" (`last_frame`)
- "设为参考图" (`reference_image`)

设为首帧/尾帧时自动将原有同角色图片降级为 `reference_image`。

### 6. `SortableMediaItem` 组件更新

现有组件使用 legacy API（`useSortable` 返回 `{attributes, listeners, setNodeRef, transform, transition, isDragging}`），基本完整。需要以下更新：

| 改动 | 说明 |
|------|------|
| 新增 `disabled` prop，转发给 `useSortable({ id, disabled, data })` | 当前 `useSortable` 调用未接受 `disabled` 参数 |
| `UnifiedMedia` 扩展 `duration?` 和 `label?` 字段 | 支持视频/音频时长和标签显示 |
| 显示 `duration` badge（`mm:ss` 格式） | 视频/音频卡片右下角 |
| 使用 `media.displayUrl`（COS 缩略图）优先渲染 | 已实现（line 126），无需改动 |
| 使用 `media.url`（高清）作为预览源 | 已实现（line 96），无需改动 |

`UnifiedMedia` 类型移至 `types/index.ts` 共享，`SortableMediaItem` 和 `JimengStyleEditor` 共同导入。

**已就位的功能（无需改动）**：
- `<img draggable={false}>` 防止浏览器原生拖拽 (line 126, 129)
- 删除按钮 `onPointerDown` 阻断拖拽 (line 140)
- `data: { type: 'media', media }` 附加到 `useSortable` (line 35)
- 右键角色切换 Dropdown (line 148-157)
- 触摸端长按菜单 (line 73-84)

### 7. 数据模型微调

将 `duration` 和 `thumbnail` 嵌入到行对象，消除外部 index-keyed map：

```typescript
// 之前: videoDurations: Record<number, number>（外部 map）
// 之后: VideoWithRole.duration?: number（内嵌）

// 之前: audioDurations: Record<number, number>（外部 map）
// 之后: AudioWithRole.duration?: number（内嵌）

// 之前: videoThumbnails: Record<number, string>（外部 map）
// 之后: VideoWithRole.thumbnail?: string（内嵌）
```

`loadedmetadata` 回调改为更新对应行对象的 `duration` 字段，而非写入外部 map。排序后数据自动跟随，无需重新映射索引。

## Interaction Matrix

| 触发 | 动作 | 结果 |
|------|------|------|
| 展开态卡片 | 拖拽 (>8px) | 开始排序，锁定展开态，DragOverlay 跟随 |
| 展开态卡片 | 释放到同类型卡片位置 | `arrayMove` 重排对应类型数组 |
| 展开态卡片 | 释放到不同类型卡片位置 | no-op（跨类型不排序） |
| 展开态卡片 | 释放到空白区域 / 按 Esc | `onDragCancel` → 清除 activeId，恢复原位 |
| 展开态卡片 | 拖拽中鼠标离开 `.jm-media-trigger` | 不折叠（`.is-dragging` 锁定） |
| 展开态卡片 | 点击 (<8px) | 预览（现有行为不变） |
| 图片卡片 | 右键 | 角色切换菜单 |
| `.jm-editor-container` | 外部文件拖入 | 高亮边框 + drop 处理第一个文件 |
| `.jm-editor-container` | 外部多文件拖入 | 只处理 `files[0]`，其余忽略 |
| 折叠态卡片 | 拖拽 | 无效（`disabled: true`） |
| 0 项 | 任何操作 | `DndContext` 不渲染，走空状态 Popover |
| 1 项 | 拖拽 | 可开始但无放置目标，释放后恢复 |

## Edge Cases

| 场景 | 行为 |
|------|------|
| 快速连续拖拽 | `PointerSensor` 的 `distance: 8` 自然去抖；`activeId` 是单值，不支持多拖 |
| 拖拽中删除卡片 | 不会发生——展开态 hover 出删除按钮，但拖拽期间 `onPointerDown` 被 dnd-kit 拦截 |
| 20+ 张卡片排序 | 只有前 20 张可排序。第 21+ 张需要先删除前面的才能进入可视区 |
| 拖拽中 Popover 打开 | 不会发生——拖拽需要 >8px，Popover 由 click 触发，两者互斥 |
| 文件拖入时正在 dnd-kit 排序 | HTML5 drag 和 dnd-kit `PointerSensor` 使用不同事件流，不冲突。但两者同时进行不太可能（用户只有一个指针） |

## 与现有功能的兼容性

| 现有功能 | 影响 |
|----------|------|
| hover 展开/折叠 | 保持不变，`.is-dragging` 新增锁定路径 |
| Popover (添加菜单) | 保持不变，`mediaPopoverOpen` + `uploadingRef` 逻辑不变 |
| `pretext` 文字环绕 | 保持不变，`.jm-media-trigger` float 布局不变，`--expand-left` 仍基于 `min(count, 20)` |
| 缩略图 (`thumbnailUrl`) | 保持不变，`SortableMediaItem` 使用 `displayUrl` |
| 预览弹窗 | 保持不变，预览使用 `m.url`（高清） |
| `ResizeObserver` 性能优化 | 保持不变 |
| 浏览器原生图片拖拽 | 所有 `<img>` 标签设置 `draggable={false}`，防止与 dnd-kit `PointerSensor` 冲突 |

## Scope

| 范围内 | 范围外 |
|--------|--------|
| `DndContext` + `SortableContext` 集成 | 触屏长按拖拽 |
| 同类型内展开态拖拽排序 | 跨类型排序（Phase 3） |
| `.is-dragging` 锁定展开态 | 跨组件拖拽（从素材库拖到编辑器） |
| `.jm-editor-container` 全局 drop zone | 全页面 drop zone |
| 右键角色切换菜单 | 拖拽到特定区域触发角色变更 |
| `SortableMediaItem` 统一渲染（前 20 张） | 虚拟化长列表 |
| `DragOverlay` 跟随元素 | 自定义拖拽预览样式 |
| 稳定 ID（URL hash） | 拖拽动画物理引擎 |
| `duration`/`thumbnail` 嵌入行对象 | 多文件同时拖拽上传 |

## Files to Modify

| 文件 | 改动 |
|------|------|
| `JimengStyleEditor.tsx` | 引入 DndContext/SortableContext; 替换内联卡片为 SortableMediaItem; handleDragStart/End; 全局 drop zone; handleRoleChange |
| `JimengStyleEditor.css` | `.is-dragging` 锁定样式; `.drag-over` 高亮; `.jm-drag-overlay` 样式; `.jm-media-item` 基础样式 |
| `SortableMediaItem.tsx` | 添加 `disabled` / `duration` / `label` / `thumbnailUrl` 支持; 统一 `UnifiedMedia` 导入源 |
| `types/index.ts` | 导出 `UnifiedMedia` 类型（从 JimengStyleEditor 移到共享位置） |

## Next Steps

→ `writing-plans` 出实施计划，拆分具体 Task 和 Step。
