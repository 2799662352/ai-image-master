# Sora UI Media Editor UX 升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `JimengStyleEditor` 组件，实现基于 `@dnd-kit/react` 的媒体拖拽排序、无上限堆叠展示、底部统一添加入口以及右键角色切换菜单。

**Architecture:** 
1. 引入 `@dnd-kit/react` 和 `@dnd-kit/helpers`。
2. 将 `JimengStyleEditor` 的媒体堆叠区和 Popover 列表包裹在 `DragDropProvider` 中。
3. 抽离 `SortableMediaItem` 组件，使用 `useSortable` 处理单个媒体的拖拽和排序状态。
4. 使用 `antd` 的 `Dropdown` 组件实现卡片的右键上下文菜单（Context Menu）。
5. 重构 CSS，实现堆叠区无上限平铺展示和 Popover 网格化布局。

**Tech Stack:** React, TypeScript, Ant Design, `@dnd-kit/react`, `@dnd-kit/helpers`, CSS Variables

---

### Task 1: 安装依赖并抽离 `SortableMediaItem` 组件

**Files:**
- Modify: `package.json`
- Create: `d:\tecx\text\25\soraui_4.0\sora-ui\src\components\SortableMediaItem.tsx`

- [ ] **Step 1: 安装 `@dnd-kit` 依赖**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm install @dnd-kit/react @dnd-kit/helpers`

- [ ] **Step 2: 创建 `SortableMediaItem.tsx`**

实现一个纯展示组件，接收 `id`, `index`, `media` 对象，以及各种回调函数。使用 `useSortable` hook 使其可拖拽。

```tsx
import React from 'react';
import { useSortable } from '@dnd-kit/react/sortable';
import { CloseOutlined, VideoCameraOutlined, AudioOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';

interface UnifiedMedia {
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
  index: number;
  media: UnifiedMedia;
  onPreview: (src: string) => void;
  onRemove: (type: string, index: number) => void;
  onRoleChange: (type: string, index: number, newRole: string) => void;
  onReplace?: (type: string, index: number, file: File) => void;
  isStackMode?: boolean; // 是否在堆叠区显示
  style?: React.CSSProperties;
}

export const SortableMediaItem: React.FC<SortableMediaItemProps> = ({
  id, index, media, onPreview, onRemove, onRoleChange, onReplace, isStackMode, style: customStyle
}) => {
  const { ref, isDragging } = useSortable({ id, index, type: 'media' });

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
    onRoleChange(media.type, media.originalIndex, key);
  };

  const content = (
    <div 
      ref={ref}
      className={`jm-media-item ${isStackMode ? 'jm-stack-layer' : ''}`}
      style={{ ...customStyle, opacity: isDragging ? 0.5 : 1, cursor: 'grab' }}
      onClick={(e) => {
        e.stopPropagation();
        if (media.type === 'image') onPreview(media.displayUrl || media.url);
        else if (media.type === 'video' && media.thumbnail) onPreview(media.thumbnail);
      }}
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
      {media.type === 'image' && <img src={media.displayUrl || media.url} alt="参考" />}
      {media.type === 'video' && (
        media.thumbnail 
          ? <img src={media.thumbnail} alt="视频封面" /> 
          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><VideoCameraOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>
      )}
      {media.type === 'audio' && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}><AudioOutlined style={{ fontSize: 24, color: '#9ca3af' }} /></div>}
      
      <div className="jm-media-item-label">{getRoleLabel()}</div>
      
      <button 
        className="jm-media-remove" 
        onClick={(e) => { e.stopPropagation(); onRemove(media.type, media.originalIndex); }}
        onPointerDown={(e) => e.stopPropagation()} // 防止触发拖拽
      >
        <CloseOutlined />
      </button>
    </div>
  );

  return media.type === 'image' ? (
    <Dropdown menu={{ items: menuItems, onClick: handleMenuClick }} trigger={['contextMenu']}>
      {content}
    </Dropdown>
  ) : content;
};
```

- [ ] **Step 3: Commit**

Run: `cd d:\tecx\text && git add 25/soraui_4.0/sora-ui/package.json 25/soraui_4.0/sora-ui/src/components/SortableMediaItem.tsx && git commit -m "feat: add SortableMediaItem component and dnd-kit dependencies"`

### Task 2: 更新 CSS 样式

**Files:**
- Modify: `d:\tecx\text\25\soraui_4.0\sora-ui\src\components\JimengStyleEditor.css`

- [ ] **Step 1: 修改堆叠区和 Popover 样式**

更新 `.jm-stack-container` 以支持无上限平铺，更新 `.jm-media-list` 为网格布局。

```css
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

Run: `cd d:\tecx\text && git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css && git commit -m "style: update media stack and popover layouts"`

### Task 3: 重构 `JimengStyleEditor.tsx` 逻辑与结构

**Files:**
- Modify: `d:\tecx\text\25\soraui_4.0\sora-ui\src\components\JimengStyleEditor.tsx`

- [ ] **Step 1: 引入依赖和组件**

在文件顶部引入 `DragDropProvider`, `isSortable` 和 `SortableMediaItem`。

```tsx
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable } from '@dnd-kit/react/sortable';
import { SortableMediaItem } from './SortableMediaItem';
```

- [ ] **Step 2: 实现 `onDragEnd` 排序逻辑**

在组件内添加 `handleDragEnd` 函数。

```tsx
  const handleDragEnd = useCallback((event: any) => {
    if (event.canceled) return;
    const { source } = event.operation;

    if (isSortable(source)) {
      const { initialIndex, index } = source;
      if (initialIndex !== index) {
        // 这是一个简化的排序逻辑，实际需要根据 allMedia 映射回具体的 state (images, videos, audios)
        // 为了安全和简单，我们先实现一个基于 allMedia 的重新排序函数
        const newAllMedia = [...allMedia];
        const [removed] = newAllMedia.splice(initialIndex, 1);
        newAllMedia.splice(index, 0, removed);
        
        // 分别更新三个状态数组
        const newImages = newAllMedia.filter(m => m.type === 'image').map(m => arkImagesWithRoles[m.originalIndex]);
        const newVideos = newAllMedia.filter(m => m.type === 'video').map(m => arkVideosWithRoles[m.originalIndex]);
        const newAudios = newAllMedia.filter(m => m.type === 'audio').map(m => arkAudiosWithRoles[m.originalIndex]);

        setArkImagesWithRoles(newImages);
        setArkVideosWithRoles(newVideos);
        setArkAudiosWithRoles(newAudios);
        
        // 同样需要更新 fileList 和 videoThumbnails 以保持索引同步 (这里逻辑较复杂，建议在实际实现中细化)
      }
    }
  }, [allMedia, arkImagesWithRoles, arkVideosWithRoles, arkAudiosWithRoles, setArkImagesWithRoles, setArkVideosWithRoles, setArkAudiosWithRoles]);
```

- [ ] **Step 3: 实现 `handleRoleChange` 逻辑**

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

- [ ] **Step 4: 修改渲染结构 (Bottom Bar)**

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
            <div className="jm-pill jm-pill-blue">
              <PlusOutlined />
            </div>
          </Popover>
```

- [ ] **Step 5: 修改渲染结构 (Top Bar & Popover)**

包裹 `DragDropProvider`，使用 `SortableMediaItem` 替换原来的渲染逻辑，并实现全局 Drop Zone。

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
        <DragDropProvider onDragEnd={handleDragEnd}>
          {/* ... jm-fl-panel 逻辑 ... */}
          
          {allMedia.length > 0 && (
            <Popover
              content={
                <div className="jm-media-list">
                  {allMedia.map((m, idx) => (
                    <SortableMediaItem 
                      key={m.id} id={m.id} index={idx} media={m} 
                      onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }}
                      onRemove={removeMedia} onRoleChange={handleRoleChange} onReplace={replaceMedia}
                    />
                  ))}
                </div>
              }
              // ... props
            >
              <div className="jm-media-trigger has-media">
                <div className="jm-stack-container" style={{ '--media-count': Math.min(allMedia.length, 20) } as any}>
                  {allMedia.slice(0, 20).map((m, idx) => (
                    <SortableMediaItem 
                      key={`stack-${m.id}`} id={`stack-${m.id}`} index={idx} media={m} 
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
                  {allMedia.length > 20 && <div className="jm-stack-badge">+{allMedia.length - 20}</div>}
                </div>
              </div>
            </Popover>
          )}
        </DragDropProvider>
        {/* ... textarea ... */}
```

- [ ] **Step 6: Commit**

Run: `cd d:\tecx\text && git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx && git commit -m "feat: implement dnd-kit sorting, context menu, and new layout"`

---