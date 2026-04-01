---
date: 2026-04-01
topic: sora-ui-media-editor-ux-v2
---

# Sora UI 媒体参考区 UX 升级设计 (v2)

## What We're Building

重构 `JimengStyleEditor` 组件中"参考内容"区域的交互，参照即梦 (Jimeng) Seedance Agent 的设计语言。

核心改动：
1. **Popover 瘦身** — 点击堆叠区的 `+` 只弹出"上传/素材库/人像库"三个选项，不再展示媒体网格
2. **展开态可管理** — hover 堆叠区域后卡片平铺展开，每张卡片 hover 时左上角显示 `X` 删除按钮
3. **堆叠动画优化** — 卡片旋转角度不均匀（伪随机），展开/折叠带弹性动画
4. **底部加 `+`** — 在 `@` 按钮旁新增一个 `+` pill，点击弹出同样的添加 Popover

不改动的部分：首帧/尾帧模式 (`jm-fl-panel`)、`text2video` 无媒体区、底部其他所有 pill 按钮。

## Why This Approach

当前交互的核心痛点：
- Popover 横向塞满媒体缩略图 + 添加按钮，多了就要横滚，操作不便
- 堆叠展开后只能预览不能操作，管理全靠 Popover
- 只有一个入口（左上角小框）能添加媒体

即梦的做法更优：堆叠区本身就是管理界面（展开→删除），添加入口独立且轻量。我们完全可以复用现有的堆叠 CSS 动画基础，只做逻辑层的调整。

## Design Details

### 1. 堆叠态（折叠）

卡片使用伪随机旋转和偏移，基于 index 产生不均匀的散牌效果：

```
旋转: rotation = ((index * 7 + 3) % 11 - 5) * 1.5
  → index 0: -3°, index 1: 7.5°, index 2: -1.5°, index 3: 4.5°

水平偏移: tx = ((index * 5 + 2) % 7 - 3) * 1.5
  → index 0: 1.5px, index 1: 0px, index 2: -1.5px, index 3: 4.5px

垂直偏移: ty = ((index * 3 + 1) % 5 - 2) * 1.5
  → index 0: 0px, index 1: -1.5px, index 2: 1.5px, index 3: 0px
```

公式确保相同 index 始终渲染一致。折叠态最多渲染前 **20** 张卡片的堆叠层（视觉上只看到最上面几张），超过 20 张显示 `+N` badge。

### 2. 展开态（hover 堆叠区域）

hover `.jm-media-trigger` 时，**所有**卡片平铺为一行（移除原 `slice(0, 6)` 限制）：
- 旋转归零 `rotate(0deg)`
- 水平排列 `left: calc(index * 54px)`
- 容器宽度 `calc(allMedia.length * 54px + 70px)`（含末尾 `+` 卡片）
- `max-width: none`，允许超出触发 `jm-editor-top` 的 flex 布局自适应
- 如果卡片数量过多导致超宽，容器设置 `overflow-x: auto` 允许横滚（但预期日常 <10 张，不会触发）
- 最后追加一个 `+` 卡片（与媒体卡同尺寸 60x80px），虚线边框

每张媒体卡片 hover 时：
- **左上角**出现 `X` 删除按钮（圆形半透明黑底白字）
- `opacity 0→1` + `scale(0.8)→scale(1)` 淡入动画

### 3. `+` 卡片 → 添加 Popover

点击展开态末尾的 `+` 卡片，或点击空状态的虚线框，或点击底部 `+` pill：

```
┌─────────────┐
│ ☁ 上传      │
│ 📂 素材库    │
│ 👤 人像库    │
└─────────────┘
```

Popover 竖排 3 个选项，每个高 40px，总高度固定。无横滚、无媒体缩略图。

### 4. 底部工具栏 `+` pill

在 `@` 按钮右侧、发送按钮左侧，添加一个 `+` pill：
- 样式：与 `@` 按钮一致（32x32px 圆角方形，border）
- 点击：弹出同样的"上传/素材库/人像库" Popover（使用 `placement="topLeft"`）

### 5. 空状态

保持现有虚线框 `jm-empty-box`（70x80px）不变。点击后弹出的 Popover 内容改为只有"上传/素材库/人像库"。

### 6. 动画优化

| 元素 | 动画 | 时间函数 |
|------|------|----------|
| 折叠→展开 | transform 旋转归零 + 位移 | `cubic-bezier(0.34, 1.56, 0.64, 1)` 弹性 |
| 展开→折叠 | transform 恢复旋转 + 位移 | `cubic-bezier(0.4, 0, 0.2, 1)` 标准 |
| 删除按钮出现 | opacity + scale | `0.15s ease` |
| hover 卡片 | box-shadow 加深 | `0.2s ease` |

## Interaction Matrix

| 触发元素 | 动作 | 结果 |
|----------|------|------|
| 空状态虚线框 (`jm-empty-box`) | click | 打开添加 Popover（上传/素材库/人像库） |
| 折叠态右下角小 `+` (`jm-stack-plus`) | click + `stopPropagation` | 打开添加 Popover |
| 堆叠区域 (`jm-media-trigger`) | hover | 卡片展开平铺 |
| 展开态单张卡片 | click | 预览该媒体（图片大图、视频封面） |
| 展开态单张卡片 | hover | 左上角显示 `X` 删除按钮 |
| 展开态 `X` 按钮 | click + `stopPropagation` | 删除该媒体，调用 `removeMedia()` |
| 展开态末尾 `+` 卡片 | click + `stopPropagation` | 打开添加 Popover |
| 底部 `+` pill | click | 打开添加 Popover（`placement="topLeft"`） |
| 添加 Popover 内选项 | click 上传/素材库/人像库 | 执行对应操作，**成功后自动关闭 Popover** |

**`text2video` 模式**：顶部无媒体区，底部 `+` pill 隐藏（`text2video` 不需要媒体参考）。

**`first_frame` / `first_last_frame` 模式**：使用现有 `jm-fl-panel`，不受本次改动影响。底部 `+` pill 也隐藏。

底部 `+` pill 仅在以下模式显示：`reference_images`、`multimodal_ref`、`edit_video`、`extend_video`。

## Key Decisions

- **不引入 @dnd-kit** — 本次只做"展开+删除+添加"的体验优化，拖拽排序作为 Phase 2 单独设计。YAGNI 原则，避免过度工程化。
- **Popover 只做添加** — 所有管理操作（删除、预览）在展开态完成。Popover 回归轻量，成功添加后自动关闭。
- **`+` 卡片内联在展开态** — 不需要额外的浮动按钮，`+` 就是最后一张卡片，点击触发 Popover。
- **折叠态小 `+` 保留** — 折叠态右下角的小 `+` 圆按钮保留，与展开态末尾的 `+` 卡片是同一个 Popover 的不同触发点。
- **伪随机旋转而非真随机** — 使用确定性公式（基于 index），保证每次渲染视觉一致。
- **X 在左上角** — 参照即梦设计，左上角比右上角更不容易误触（因为卡片展开方向是向右）。
- **图片替换 (drag-replace) 移至 Phase 2** — 当前 Popover 内的拖拽替换功能随网格移除而消失，在 Phase 2 的拖拽排序中一并实现。

## Scope

| 范围内 | 范围外 (Phase 2) |
|--------|--------|
| Popover 内容精简为纯添加 | 拖拽排序 (@dnd-kit) |
| 展开态删除按钮（左上角 X） | 右键角色切换（首帧/尾帧） |
| 伪随机旋转角度 + 偏移 | 外部文件拖入上传 |
| 底部 + pill 按钮 | 触屏长按支持 |
| 展开/折叠弹性动画 | 图片拖拽替换 (drag-replace) |
| 展开态显示全部卡片（无6张限制） | 首帧/尾帧模式改动 |

## Files to Modify

| 文件 | 改动 |
|------|------|
| `JimengStyleEditor.tsx` | Popover 内容精简；展开态卡片加删除按钮；底部加 + pill；+ 卡片 |
| `JimengStyleEditor.css` | 伪随机旋转角；删除按钮样式；+ 卡片样式；弹性动画；底部 + pill 样式 |

无新文件、无新依赖。

## Next Steps

→ `writing-plans` 出实施计划，拆分具体代码改动步骤。
