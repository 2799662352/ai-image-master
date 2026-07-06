# 3D 导演台「动画」Tab — 设计

**日期**: 2026-07-06
**状态**: 已批准（用户确认方案 A，范围仅动画 Tab，不含录制时间轴增强）
**参考**: RunningHub 导演台 2026-07 更新实测（高级假人新增动画系统）

## 背景

RunningHub 导演台为高级假人（Mixamo X/Y Bot rig）新增了「动画」Tab：19 个分类、2032 条
Mixamo 动作 FBX，点选即在假人上播放，底部出现 播放/暂停/停止 + 帧进度条。
完整目录已抓取落盘：`docs/director-animation-catalog.json`
（`POST /canvas/animation/{category,resource}/list`，每条 `{id, categoryCode, name, nameEn, cosUrl}`，
cosUrl 形如 `https://rh-canvas-files.xiaoyaoyou.com/default/animation/<uuid>/animation.fbx`）。

本项目 3D 导演台（`src/renderer/src/components/shared/image-editors/director/`）已有：
FBXLoader（加载 X/Y Bot rig）、常驻 RAF 渲染循环、姿势系统（`_poseBase` 静息基线 +
`capturePose`/`restorePose`）、右栏 属性/姿势 双 Tab。缺动画能力。

## 方案（已选 A）

`AnimationMixer` 挂在选中的高级假人上播放动画剪辑。Mixamo 动画 FBX 与 Mixamo rig
骨骼名天然一致，`fbxLoader` 加载动画 FBX 取 `group.animations[0]` 直接
`mixer.clipAction(clip)` 即可，无需 retarget。`AnimationClip` 按 URL 做模块级缓存。

否决项：B（逐帧手动采样写骨骼，重造 three.js 采样器）；A'（不做分类/搜索，2032 条不可用）。

## 组件设计

### 1. 数据层 — `director/directorAnimations.ts` + `director/animation-catalog.json`

- `animation-catalog.json`：由 `docs/director-animation-catalog.json` 转换的紧凑目录
  （`{categories:[{code,name}], animations:[{id, cat, name, nameEn, uid}]}`，
  uid = cosUrl 中的 32 位 uuid；categoryCode 清除零宽字符）。
- `directorAnimations.ts`：
  - `loadAnimCatalog(): Promise<AnimCatalog>` — **动态 import** JSON（≈300KB 不进主 chunk），缓存单例。
  - `filterAnimations(list, {category, keyword})` — 纯函数；category='' 为全部；keyword
    对 `name`（中）与 `nameEn`（英，忽略大小写）子串匹配。
  - `animUrl(anim, base = DIRECTOR_ASSET_BASE)` — 双轨解析：base 非空走
    `<base>/animations/<id>.fbx`（自有桶镜像），否则拼原始 CDN
    `https://rh-canvas-files.xiaoyaoyou.com/default/animation/<uid>/animation.fbx`。

### 2. 场景层 — `DirectorStageScene.tsx`

- `StageState` 增 `anim: ActiveAnim | null` 与 `clock: THREE.Clock`；
  `ActiveAnim = { mixer, action, target, poseSnap, duration, url }`。
- RAF 循环：`const dt = clock.getDelta(); if (anim) { anim.mixer.update(dt); emitAnimTick(); }`
  （暂停由 `action.paused` 控制，mixer.update 照跑但无效果，tick 照发）。
- Props 增 `onAnimTick?: (t: AnimTick | null) => void`；
  `AnimTick = { url, time, duration, playing }`。停止/清理时发 `null`。
- Handle 新增：
  - `playAnimation(url): Promise<void>` — 仅 `selected.userData.isFbxBot`；首次在该对象上
    播放前 `capturePose` 存 `poseSnap`；切换剪辑复用同一 snapshot；`stopAllAction` 后播新剪辑
    （LoopRepeat）。剪辑缓存：模块级 `Map<string, AnimationClip>`。
  - `pauseAnimation()` / `resumeAnimation()` — `action.paused = true/false`。
  - `stopAnimation()` — `mixer.stopAllAction()` + `restorePose(poseSnap)` + 清 `anim` + tick(null)。
  - `seekAnimation(sec)` — `action.time = sec; mixer.update(0)`。
- 生命周期：动画为**瞬态预览** — 不进撤销栈、不进「保存工程」序列化（与 RH 一致）。
  选中切到其他对象、删除目标对象、clearModels、组件卸载 → 自动 `stopAnimation()`。

### 3. UI 层 — `DirectorEditor.tsx`

- Tab 联合类型扩为 `'props' | 'pose' | 'anim'`；「动画」Tab 按钮与 属性/姿势 并排。
- Tab 内容（仅选中高级假人时可用，否则与姿势 Tab 相同的提示语）：
  分类下拉（全部 + 19 类）→ 搜索框（中英文）→ 动画按钮网格（`title` 显示英文名），
  前端分页每页 30，「加载更多」追加。目录动态加载，加载中/失败态内联提示。
- 播放条：有活动动画时显示浮动条（动画名 + 进度滑杆 `0..duration` 可拖 seek +
  时间读数 + 播放/暂停/停止）。数据来自 `onAnimTick`。停止后收起。
- 动画 FBX 加载失败 → 现有 toast 通路提示。

## 错误处理

- 动画 FBX 加载失败：`playAnimation` reject → UI toast「动画加载失败」，状态不变。
- 动画 FBX 无 `animations[0]`：视为加载失败。
- 非高级假人调用 `playAnimation`：静默 no-op（UI 层已挡）。

## 测试

- 单测 `tests/features/DirectorAnimations.test.ts`：`filterAnimations`（分类过滤/中文关键词/
  英文大小写不敏感/组合过滤）+ `animUrl`（CDN 直链拼接 / 自有桶 base 解析 / 尾斜杠容错）。
- 场景层/UI：手动验证 + 构建门（`npx tsc --noEmit` 零新增错误、改动文件零 lint、`npm run build:vite` 通过）。

## 不做（YAGNI）

- 录制时间轴增强（更新关键帧到相机/捕捉回流画布/导出档位）— 下一次迭代。
- 动画状态持久化到工程 JSON、动画进撤销栈。
- crossfade 过渡、多对象同时播放、动画混合。
- 资产下载脚本（仓库现无 director-assets 脚本，镜像需求出现时再加）。
