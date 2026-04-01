---
date: 2026-04-01
topic: sora-ui-media-editor-ux
---

# Sora UI Media Editor UX 升级设计

## What We're Building
我们正在重构 `JimengStyleEditor` 组件中关于"参考内容"（媒体上传与管理）的交互体验。
核心目标是减少用户的点击层级，提升操作的直觉性，并支持更高级的媒体管理功能（拖拽排序、角色切换）。

新版交互将：
1. 在底部工具栏新增全局的 `+` 按钮，作为统一的添加入口（上传/素材库/人像库）。
2. 移除空状态的虚线框，无媒体时不占用左侧空间。
3. 升级已有的"卡片堆叠"区域：
   - 取消最多显示 6 张的限制，展示所有已添加媒体。
   - 支持将外部文件直接拖拽到堆叠区域进行上传。
   - Hover 展开堆叠卡片后，用户可以直接对卡片进行 **拖拽排序**（基于 `@dnd-kit/react`）。
   - Hover 展开的卡片支持右键/长按唤出上下文菜单，进行**角色切换**（如设为首帧、尾帧、参考图）。
4. 优化 Popover 管理面板：改为 4 列自适应网格布局，消除横向滚动条，并移除内部多余的添加按钮，使其纯粹作为媒体管理面板。

## Why This Approach
当前交互存在几个痛点：触发区太小（70x80px）、层级过深（需先点小框再点上传）、空状态缺乏引导、拖拽不直观、且 Popover 列表过长时体验糟糕。

我们评估了三种技术方案来实现"拖拽排序"：
1. **@dnd-kit/react (推荐并采用)**：提供现代的 Hooks API，支持水平/垂直/网格排序，自定义 Drop Zone 非常灵活（便于实现"拖出删除"或"拖入角色区"），且体积小巧（~15KB）。
2. **@hello-pangea/dnd**：基于旧版 react-beautiful-dnd，API 较重（Render Props），体积较大（~30KB），且自定义 Drop Zone 不够灵活。
3. **原生 HTML5 Drag & Drop**：无依赖但体验粗糙，缺乏动画和触屏支持。

最终选择 **混合即梦风格 + @dnd-kit** 的方案，既保留了现有堆叠卡片的视觉美感，又通过底部工具栏 `+` 按钮解决了添加入口过深的问题，同时引入 `@dnd-kit` 赋予了堆叠卡片直接交互（排序、角色切换）的能力。

## Key Decisions
- **使用 `@dnd-kit/react` 和 `@dnd-kit/helpers`**：作为拖拽排序的基础库，因其 Hooks API 与现有组件契合度高，且支持复杂的 Stacking Context（层叠上下文）下的拖拽。
- **拆分 `SortableMediaItem` 组件**：将单个可拖拽的媒体卡片抽离为独立组件，保持 `JimengStyleEditor` 的代码清晰，遵循单一职责原则。
- **底部工具栏统一入口**：将"上传/素材库/人像库"的入口统一移至底部工具栏最左侧的 `+` 按钮，无论当前是否有媒体，均可一键呼出添加菜单。
- **全局拖拽响应（解决空状态拖拽问题）**：当左侧堆叠区为空时，整个 `JimengStyleEditor` 容器（或输入框区域）作为 Drop Zone，用户拖入文件时高亮提示，松手即上传。
- **无上限的堆叠展示与性能保护**：移除 `slice(0, 6)` 限制，但在视觉上最多只展开前 20 张卡片（防止 DOM 过多导致动画卡顿），超出的在 Popover 中管理。
- **右键上下文菜单（Context Menu）切换角色**：将"设为首帧/尾帧"等角色切换操作放入卡片的右键菜单中。切换为首/尾帧后，该媒体会自动移入对应的专属槽位（`jm-fl-panel`），从参考堆叠中消失，状态一目了然。
- **Popover 网格化与删除**：将 `jm-media-list` 改为 `display: grid; grid-template-columns: repeat(4, 64px);`。Popover 内的每张卡片右上角保留原有的 `X` 删除按钮，纯粹作为媒体管理面板。

## UI/UX Pro Max 设计规范 (Applied)
- **交互反馈**：所有可点击元素必须包含 `cursor-pointer`。Hover 状态采用平滑过渡（`transition: all 0.2s ease`）。
- **层叠上下文 (Z-Index Management)**：由于涉及堆叠卡片（Stacking）、Popover 和 DragOverlay，需严格管理 z-index 阶梯（如卡片 z-10，Popover z-50，DragOverlay z-100），避免使用随意的 `z-[9999]` 导致层级冲突。
- **图标规范**：统一使用 Ant Design 的 SVG 图标，不使用 Emoji 作为功能图标。
- **空状态与拖拽提示**：拖拽文件进入堆叠区域时，需有明显的视觉反馈（如边框高亮、背景色变化）。

## Open Questions
- **手机端/触屏兼容性**：`@dnd-kit` 默认支持触屏，但"右键菜单"在触屏上通常映射为长按（Long Press），需要确保长按事件与拖拽事件（Touch Sensor）不冲突。
- **首尾帧逻辑联动**：如果用户通过右键菜单将某张"参考图"设为"首帧"，但当前模式不支持首帧，或首帧已存在，需处理好替换或错误提示逻辑。

## Next Steps
→ `/workflows:plan` for implementation details (进入实现规划阶段，拆分具体的代码修改步骤)。