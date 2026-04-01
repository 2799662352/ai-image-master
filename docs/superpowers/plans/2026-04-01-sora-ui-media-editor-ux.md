# Sora UI Media Editor UX 升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `JimengStyleEditor` 组件，实现基于 `@dnd-kit` 的媒体拖拽排序、无上限堆叠展示、底部统一添加入口以及右键角色切换菜单。

**Architecture:** 
1. 引入 `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`。
2. 将 `JimengStyleEditor` 的媒体堆叠区和 Popover 列表包裹在 `DndContext` 中，并使用 `SortableContext` 管理可排序列表。
3. 抽离 `SortableMediaItem` 组件，使用 `useSortable` 处理单个媒体的拖拽和排序状态。
4. 使用 `DragOverlay` 渲染拖拽时的跟随元素，确保其 z-index 最高（z-100）。
5. 使用 `antd` 的 `Dropdown` 组件实现卡片的右键上下文菜单（Context Menu）。
6. 重构 CSS，实现堆叠区无上限平铺展示和 Popover 网格化布局，严格管理 z-index。

**Tech Stack:** React, TypeScript, Ant Design, `@dnd-kit`, CSS Variables

---

### Task 1: 安装依赖并抽离 `SortableMediaItem` 组件

**Files:**
- Modify: `25/soraui_4.0/sora-ui/package.json`
- Create: `25/soraui_4.0/sora-ui/src/components/SortableMediaItem.tsx`

- [ ] **Step 1: 安装 `@dnd-kit` 依赖**

Run: `cd 25/soraui_4.0/sora-ui && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`

- [ ] **Step 2: 创建 `SortableMediaItem.tsx`**

实现一个纯展示组件，接收 `id`, `index`, `media` 对象，以及各种回调函数。使用 `useSortable` hook 使其可拖拽。

```tsx
import React, { useState, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CloseOutlined, VideoCameraOutlined, AudioOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';

export interface UnifiedMedia {
  id: string;
  type: 'image' | 'video' | 'audio';
  url: string;
  displayUrl: string;
  role: string;
  originalIndex: number;
  thumbnail?: string;
}

interface SortableMediaItemProps {
  id: string;
  media: UnifiedMedia;
  onPreview?: (src: string) => void;
  onRemove?: (type: string, index: number) => void;
  onRoleChange?: (type: string, index: number, newRole: string) => void;
  onReplace?: (type: string, index: number, file: File) => void;
  isStackMode?: boolean; // 是否在堆叠区显示
  style?: React.CSSProperties;
  isOverlay?: boolean; // 是否是 DragOverlay 中的渲染
}

export const SortableMediaItem: React.FC<SortableMediaItemProps> = ({
  id, media, onPreview, onRemove, onRoleChange, onReplace, isStackMode, style: customStyle, isOverlay
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ 
    id, 
    data: { type: 'media', media } 
  });

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const touchTimer = useRef<NodeJS.Timeout | null>(null);

  const style: React.CSSProperties = {
    ...customStyle,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging && !isOverlay ? 0.3 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
    zIndex: isOverlay ? 100 : (customStyle?.zIndex || 10),
  };

  const getRoleLabel = () => {
    if (media.type === 'image') {
      if (media.role === 'first_frame') return '首帧';
      if (media.role === 'last_frame') return '尾帧';
      if (media.url.startsWith('asset://')) return '人像';
      return `图${media.originalIndex + 1}`;
    }
    if (media.type === 'video') return `视频${media.originalIndex + 1}`;
    return `音频${media.originalIndex + 1}`;
  };

  const menuItems: MenuProps['items'] = media.type === 'image' ? [
    { key: 'first_frame', label: '设为首帧' },
    { key: 'last_frame', label: '设为尾帧' },
    { key: 'reference_image', label: '设为参考图' },
  ] : [];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (onRoleChange) onRoleChange(media.type, media.originalIndex, key);
    setDropdownOpen(false);
  };

  // 兼容移动端长按唤出菜单
  const handleTouchStart = () => {
    touchTimer.current = setTimeout(() => {
      setDropdownOpen(true);
    }, 500); // 500ms 长按
  };
  const handleTouchEnd = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
  };

  useEffect(() => {
    return () => { if (touchTimer.current) clearTimeout(touchTimer.current); };
  }, []);

  const content = (
    <div 
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`jm-media-item ${isStackMode ? 'jm-stack-layer' : ''} ${isOverlay ? 'jm-drag-overlay' : ''}`}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        if (onPreview) {
          if (media.type === 'image') onPreview(media.displayUrl || media.url);
          else if (media.type === 'video' && media.thumbnail) onPreview(media.thumbnail);
        }
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      onDragOver={(e) => {
        if (media.type === 'image' && onReplace) {
          e.preventDefault();
          e.currentTarget.classList.add('drag-over');
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          e.currentTarget.classList.remove('drag-over');
        }
      }}
      onDrop={(e) => {
        if (media.type === 'image' && onReplace) {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.classList.remove('drag-over');
          const file = e.dataTransfer.files[0];
          if (file && file.type.startsWith('image/')) {
            onReplace(media.type, media.originalIndex, file);
          }
        }
      }}
    >
      {media.type === 'image' && <img src={media.displayUrl || media.url} alt="参考" draggable={false} />}
      {media.type === 'video' && (
        media.thumbnail 
          ? <img src={media.thumbnail} alt="视频封面" draggable={false} /> 
          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><VideoCameraOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>
      )}
      {media.type === 'audio' && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><AudioOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>}
      
      <div className="jm-media-item-label">{getRoleLabel()}</div>
      
      {onRemove && !isOverlay && (
        <button 
          className="jm-media-remove" 
          onClick={(e) => { e.stopPropagation(); onRemove(media.type, media.originalIndex); }}
          onPointerDown={(e) => e.stopPropagation()} // 防止触发拖拽
        >
          <CloseOutlined />
        </button>
      )}
    </div>
  );

  return media.type === 'image' && !isOverlay ? (
    <Dropdown 
      menu={{ items: menuItems, onClick: handleMenuClick }} 
      trigger={['contextMenu']}
      open={dropdownOpen}
      onOpenChange={setDropdownOpen}
    >
      {content}
    </Dropdown>
  ) : content;
};
```

- [ ] **Step 3: Commit**

Run: `cd 25/soraui_4.0/sora-ui && git add package.json src/components/SortableMediaItem.tsx && git commit -m "feat: add SortableMediaItem component and dnd-kit dependencies"`

### Task 2: 更新 CSS 样式

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: 修改堆叠区和 Popover 样式**

更新 `.jm-stack-container` 以支持无上限平铺，更新 `.jm-media-list` 为网格布局。添加 z-index 规范。

```css
/* Z-Index 规范:
   卡片基础: z-10
   Popover: z-50 (由 antd 控制，但内部内容保持层级)
   DragOverlay: z-100
*/

/* 修改 jm-media-trigger 宽度，给平铺留出空间 */
.jm-media-trigger:hover .jm-stack-container {
  width: calc(64px * var(--media-count) + 8px * (var(--media-count) - 1)); /* 64px width + 8px gap */
  max-width: 600px; /* 允许更宽 */
  flex-wrap: wrap; /* 允许换行 */
}

/* 移除旧的 hover 展开逻辑，改为基于 flex 的平铺 */
.jm-media-trigger:hover .jm-stack-layer {
  transform: none !important;
  left: auto !important;
  position: relative !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.jm-media-trigger:hover .jm-stack-container {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 默认折叠状态下的样式保持绝对定位 */
.jm-stack-container:not(:hover) .jm-stack-layer {
  position: absolute;
}

/* Popover 网格布局 */
.jm-media-list {
  display: grid;
  grid-template-columns: repeat(4, 64px);
  gap: 8px;
  padding: 12px;
  max-height: 300px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 移除旧的空状态框 */
.jm-empty-box {
  display: none;
}

/* 全局 Drop Zone 提示 */
.jm-editor-container.drag-over {
  border-color: #36b5f0;
  box-shadow: 0 0 0 3px rgba(54, 181, 240, 0.12);
  background: #f0f9ff;
}

/* DragOverlay 样式 */
.jm-drag-overlay {
  box-shadow: 0 10px 25px rgba(0,0,0,0.2) !important;
  transform: scale(1.05) !important;
  cursor: grabbing !important;
  z-index: 100 !important;
}

/* 底部工具栏新增的 + 按钮菜单 */
.jm-add-menu {
  display: flex;
  flex-direction: column;
  padding: 4px;
  min-width: 120px;
}

.jm-add-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 6px;
  color: #374151;
  transition: background 0.2s;
}

.jm-add-menu-item:hover {
  background: #f3f4f6;
}
```

- [ ] **Step 2: Commit**

Run: `cd 25/soraui_4.0/sora-ui && git add src/components/JimengStyleEditor.css && git commit -m "style: update media stack and popover layouts with z-index management"`

### Task 3: 重构 `JimengStyleEditor.tsx` 逻辑与结构

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx`

- [ ] **Step 1: 引入依赖和组件**

在文件顶部引入 `@dnd-kit` 相关组件。

```tsx
import { 
  DndContext, 
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay
} from '@dnd-kit/core';
import { 
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy
} from '@dnd-kit/sortable';
import { SortableMediaItem } from './SortableMediaItem';
import type { UnifiedMedia } from './SortableMediaItem';
```

- [ ] **Step 2: 设置 Sensors 和 Active State**

在组件顶层定义 sensors 和 activeId 状态。

```tsx
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 拖动 5px 才触发，防止与点击/长按冲突
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
```

- [ ] **Step 3: 实现 `handleDragEnd` 排序逻辑**

实现健壮的排序逻辑，基于 `id` 查找并更新对应的状态数组。

```tsx
  const handleDragStart = (event: any) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = useCallback((event: any) => {
    setActiveId(null);
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = allMedia.findIndex(m => m.id === active.id);
      const newIndex = allMedia.findIndex(m => m.id === over.id);
      
      if (oldIndex !== -1 && newIndex !== -1) {
        const newAllMedia = arrayMove(allMedia, oldIndex, newIndex);
        
        // 重新分离并更新三个状态数组，保持其内部相对顺序
        const newImages = newAllMedia.filter(m => m.type === 'image').map(m => arkImagesWithRoles[m.originalIndex]);
        const newVideos = newAllMedia.filter(m => m.type === 'video').map(m => arkVideosWithRoles[m.originalIndex]);
        const newAudios = newAllMedia.filter(m => m.type === 'audio').map(m => arkAudiosWithRoles[m.originalIndex]);

        setArkImagesWithRoles(newImages);
        setArkVideosWithRoles(newVideos);
        setArkAudiosWithRoles(newAudios);
        
        // 注意：fileList 和 videoThumbnails 也需要同步更新，这里假设它们与 arkImages/Videos 长度一致并按顺序对应
        // 实际应用中可能需要更精细的同步逻辑
      }
    }
  }, [allMedia, arkImagesWithRoles, arkVideosWithRoles, arkAudiosWithRoles, setArkImagesWithRoles, setArkVideosWithRoles, setArkAudiosWithRoles]);
```

- [ ] **Step 4: 实现 `handleRoleChange` 逻辑**

```tsx
  const handleRoleChange = useCallback((type: string, originalIndex: number, newRole: string) => {
    if (type === 'image') {
      setArkImagesWithRoles(prev => {
        const newArr = [...prev];
        // 如果是设为首尾帧，需要检查是否已存在，并可能需要覆盖
        if (newRole === 'first_frame' || newRole === 'last_frame') {
           const existingIndex = newArr.findIndex(img => img.role === newRole);
           if (existingIndex !== -1) {
             newArr[existingIndex].role = 'reference_image'; // 原来的降级为参考图
           }
        }
        newArr[originalIndex].role = newRole as any;
        return newArr;
      });
      message.success(`已更新角色`);
    }
  }, [setArkImagesWithRoles]);
```

- [ ] **Step 5: 修改渲染结构 (Bottom Bar)**

在 `jm-editor-bottom` 的最左侧添加 `+` 按钮。

```tsx
          {/* Add Button */}
          <Popover
            trigger="click"
            placement="topLeft"
            arrow={false}
            overlayInnerStyle={{ padding: 0, borderRadius: 8 }}
            content={
              <div className="jm-add-menu">
                <Upload accept={['multimodal_ref', 'edit_video'].includes(volcengineArkMode) ? 'image/*,video/mp4,video/quicktime,.mp4,.mov,audio/wav,audio/mpeg,audio/mp3,.wav,.mp3' : 'image/*'} showUploadList={false} beforeUpload={handleUnifiedUpload} multiple>
                  <div className="jm-add-menu-item"><CloudUploadOutlined /> 上传本地文件</div>
                </Upload>
                <div className="jm-add-menu-item" onClick={() => setAssetLibraryOpen(true)}><FolderOpenOutlined /> 从素材库选择</div>
                <div className="jm-add-menu-item" onClick={() => setPortraitLibraryOpen(true)}><UserOutlined /> 从人像库选择</div>
              </div>
            }
          >
            <div className="jm-pill jm-pill-blue" style={{ paddingLeft: 8, paddingRight: 8 }}>
              <PlusOutlined />
            </div>
          </Popover>
```

- [ ] **Step 6: 修改渲染结构 (Top Bar & Popover)**

包裹 `DndContext` 和 `SortableContext`，使用 `SortableMediaItem`，并添加 `DragOverlay`。

```tsx
      <div 
        className="jm-editor-top"
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('drag-over'); }}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('drag-over');
          const file = e.dataTransfer.files[0];
          if (file) handleUnifiedUpload(file);
        }}
      >
        <DndContext 
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {/* ... jm-fl-panel 逻辑 ... */}
          
          {allMedia.length > 0 && (
            <Popover
              content={
                <div className="jm-media-list">
                  <SortableContext items={allMedia.map(m => m.id)} strategy={rectSortingStrategy}>
                    {allMedia.map((m) => (
                      <SortableMediaItem 
                        key={m.id} id={m.id} media={m} 
                        onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }}
                        onRemove={removeMedia} onRoleChange={handleRoleChange} onReplace={replaceMedia}
                      />
                    ))}
                  </SortableContext>
                </div>
              }
              // ... props
            >
              <div className="jm-media-trigger has-media">
                <div className="jm-stack-container" style={{ '--media-count': Math.min(allMedia.length, 20) } as any}>
                  <SortableContext items={allMedia.map(m => m.id)} strategy={rectSortingStrategy}>
                    {allMedia.slice(0, 20).map((m, idx) => (
                      <SortableMediaItem 
                        key={`stack-${m.id}`} id={m.id} media={m} 
                        isStackMode={true}
                        style={{
                          zIndex: allMedia.length - idx,
                          '--stack-rotate': `${Math.min(idx, 3) * 5}deg`,
                          '--stack-tx': `${Math.min(idx, 3) * 2}px`,
                          '--stack-ty': `${Math.min(idx, 3) * -2}px`,
                        } as any}
                        onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }}
                        onRemove={removeMedia} onRoleChange={handleRoleChange} onReplace={replaceMedia}
                      />
                    ))}
                  </SortableContext>
                  {allMedia.length > 20 && <div className="jm-stack-badge">+{allMedia.length - 20}</div>}
                </div>
              </div>
            </Popover>
          )}
          
          <DragOverlay zIndex={100}>
            {activeId ? (
              <SortableMediaItem 
                id={activeId} 
                media={allMedia.find(m => m.id === activeId)!} 
                isOverlay={true}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
        {/* ... textarea ... */}
```

- [ ] **Step 7: Commit**

Run: `cd 25/soraui_4.0/sora-ui && git add src/components/JimengStyleEditor.tsx && git commit -m "feat: implement dnd-kit sorting, context menu, and new layout"`

---