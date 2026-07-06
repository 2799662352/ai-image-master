# 导演台:导入自定义动画 + 应用内 K 动画与导出 — 设计

日期:2026-07-06
状态:已确认(用户 ok)
前置:2026-07-06-director-animation-tab-design.md(动画 Tab,已上线,支持多假人同时播放)

## 背景与实站考察结论

用户需求:① 让用户导入自己的动画;② 让用户在软件里自己 K 动画并导出。

RunningHub 实站(2026-07-06 复查):
- **无「导入自定义动画」**:动画 Tab 没有上传入口,全站 file input 只收 `image/*`。
- **无「K 姿势动画」**:录制时间轴关键帧只记相机(「更新选中关键帧到当前相机」);
  假人动作 = 套动画库剪辑,时间轴以绿色 segment 展示当前动画,多时间轴 = 多条相机轨。
- 可借鉴的是他的时间轴交互语言(F 打点 / 更新选中关键帧 / Delete 删点 / 上一/下一帧 /
  Space 播放 / 时长可调),这套我们在 DirectorRecordTimeline 已复刻,姿势时间轴沿用。

→ 两个功能都没有现成参考,自行设计;技术依据为 three.js r180 官方文档(Context7):
- 程序化剪辑:`QuaternionKeyframeTrack`(骨骼旋转,自动 slerp)+ `VectorKeyframeTrack`
  (根骨骼位移)组装 `new AnimationClip(name, duration, tracks)` — 与 FBX 加载出的
  剪辑同构,直接进现有 anims Map/mixer 通路。
- 序列化:`AnimationClip.toJSON()` / `AnimationClip.parse()` 官方往返。
- 导出 glb:`GLTFExporter`(`animations: [clip]`,`binary: true`)。
- **three.js 无 FBXExporter,FBX 只进不出。**

## 功能 A:导入自定义动画

### 存储
- 复用 `directorAssetStore`(IndexedDB),`AssetKind` 增加 `'animation'`;
  DB schema 不变(kind 只是记录字段值)。
- 新常量 `ANIM_EXTS = ['fbx', 'glb', 'gltf', 'json']`、`ANIM_SIZE_HINT = 40MB`。

### 剪辑加载(场景层)
`loadAnimClip(url)` 目前只走 FBXLoader。扩展为按格式分派:
- `.fbx` → FBXLoader,取 `group.animations[0]`(现状);
- `.glb/.gltf` → GLTFLoader,取 `gltf.animations[0]`;
- `.json` → fetch + `AnimationClip.parse(json)`(本软件导出的剪辑)。
- objectURL 无扩展名 → `playAnimation(url, name, ext?)` 增加可选 `ext` 提示,
  透传给 loader;目录动画不传(默认 fbx)。
- 骨骼名兜底 `retargetClipTracks` 对三种来源统一生效(glTF 轨道是节点名,
  Mixamo 命名约定差异由 normBone 归一化吸收)。

### UI(DirectorEditor 动画 Tab)
- Tab 顶部新增「我的动画」区块:导入按钮(隐藏 file input,accept=ANIM_EXTS)
  + 卡片列表(名称/大小/删除),置于目录区上方,与「我的全景」交互一致。
- 点卡片 → `openAssetUrl(id)` → `playAnimation(url, asset.name, asset.ext)`;
  播放条/多假人并行等行为与目录动画完全一致。
- 导入的 json 若 parse 失败 → toast 报错不入库(导入时轻校验:必须含 tracks 数组)。

## 功能 B:K 动画(姿势关键帧时间轴)+ 导出

### 数据模型(editor 持有,场景层无状态)
```ts
interface PoseKeyframe {
  id: string;
  t: number;                                      // 秒
  bones: Record<string, [number,number,number,number]>; // 骨骼名→局部四元数
  rootPos: [number, number, number];              // 假人根位置
}
```
- 关键帧按 t 排序;同 t 打点 = 覆盖更新。
- 时长可调(默认 8s,1–60s);关键帧超出新时长时夹到末端。

### 场景层新增 handle(DirectorStageScene)
- `capturePoseKeyframe(): { bones, rootPos } | null` — 读选中假人当前姿势
  (真实骨骼,过滤 hasSameNamedBoneAncestor 的嵌套孪生;
  基于现有 collectSkeletonBones / capturePose 逻辑)。
- `playPoseClip(keyframes, duration, name): Promise<void>` — 把关键帧集合编译成
  AnimationClip(见下)喂给现有 playAnimation 同款通路(anims Map;
  url 用合成键 `authored:<uuid>` 防与缓存冲突,不进 animClipCache)。
- `buildPoseClip(keyframes, duration)`(模块级纯函数,可单测):
  - 收集所有关键帧出现过的骨骼名并集;
  - 每骨骼一条 QuaternionKeyframeTrack(times = 各关键帧 t;某帧缺该骨骼时
    用该帧假人 rest 四元数补值 — 简化:捕获时总是全量骨骼,不会缺);
  - 根位置一条 VectorKeyframeTrack(`.position`);
  - InterpolateLinear(四元数自动 slerp)。
- 停止/暂停/seek/进度回传全部复用现有 pause/resume/stop/seekAnimation + AnimTick。

### UI:「K 动画」时间轴面板(新组件 DirectorPoseTimeline)
- 入口:动画 Tab 内「K 动画」按钮(选中高级假人时可用)→ 底部滑出时间轴面板
  (与录制时间轴同视觉语言,但独立组件、可与右栏姿势工具同时使用)。
- 工具行(交互对齐 RH 录制时间轴):
  - ◆ 在游标处记录当前姿势 (F) — capturePoseKeyframe + upsert;
  - 「更新选中关键帧到当前姿势」(选中关键帧后可用);
  - 删除选中关键帧 (Delete);双击帧 pill 也可删;
  - 跳起点/末端、上一/下一关键帧、▷ 预览 (Space,循环播放)、时长输入;
  - 「保存到我的动画」/「导出 .json」/「导出 .glb」;× 关闭。
- 摆姿方式 = 现有姿势系统(右栏姿态预设 + 骨骼滑杆 + gizmo 摆骨骼);
  时间轴打开时点选关键帧 pill = seek 并把该帧姿势应用到假人(scrub 即预览,
  暂停态编译 clip + seekAnimation 实现插值取样)。
- 预览播放中禁改姿势(与现有「动画播放中切姿势先停动画」的既有守卫一致)。

### 导出
- `.json`:`buildPoseClip(...).toJSON()` + 元数据包裹
  `{ format:'director-anim@1', name, duration, clip }` → Blob 下载
  (复用 downloadDataUrl 模式)。功能 A 的 json 导入解 `.clip` 或裸 clip 均可。
- `.glb`:GLTFExporter 动态 import(`three/examples/jsm/exporters/GLTFExporter.js`,
  按需加载不进主包);input = 选中假人(SkinnedMesh 场景子树 clone 不可行 —
  SkinnedMesh 深拷贝骨骼绑定复杂,直接导出原对象,onlyVisible 默认即可),
  `animations: [clip]`、`binary: true` → Blob 下载。
  轨道只含真实骨骼名(buildPoseClip 捕获时已过滤嵌套孪生,双骨架风险由此规避)。
- 「保存到我的动画」:json Blob 直接 `putAsset({kind:'animation', ext:'json'})`,
  列表即时刷新,点播即放。
- 视频导出:不新做 — K 好的动画播放中用现有「录制视频」运镜导出即可(文档提示)。

### 不做(第一版边界)
- 曲线编辑器 / 贝塞尔手柄 / 缓动函数选择(Linear 即 RH 动画同级观感);
- 逐骨骼独立轨道 UI(整姿势打点);
- K 动画入撤销栈 / 入「保存工程」序列化(与现有动画预览同为瞬态;
  用户资产通过「保存到我的动画」持久化);
- FBX 导出(three.js 无 exporter)。

## 测试
- `buildPoseClip` 纯函数单测:轨道数/时长/times/values 形状、根位移轨、
  toJSON→parse 往返。
- `directorAssetStore` 的 animation kind 走既有 CRUD(已有测试模式,补 kind 用例)。
- 导入格式分派(ext→loader 选择)单测。

## 追加:工程持久化运动状态 + 录制关键帧 + 退出提醒(同日,用户反馈)

用户实测发现「保存工程」丢三样:①假人已应用的动画(运动状态);②录制视频
的运镜关键帧;③点 × 退出无未保存提醒。推翻上面「动画不进工程序列化」的
第一版边界,方案:

- **运动状态入工程**:`DirectorModelState.anim?: SavedAnimState`
  (`{name, url?, ext?, assetId?, time, playing}`)。来源区分:目录动画存
  http(s) URL;「我的动画」(导入 + 已保存的 K 动画)存 IndexedDB 资产 id
  (objectURL 跨会话无效),`playAnimation` 加第 4 参 `assetId` 随播放进
  `ActiveAnim`。时间轴上未保存的 authored 预览剪辑无法还原 → 跳过。
  restore 在模型重建后重放:`loadAnimClip` → `startClipOnTarget` → 恢复
  播放头 + 播放/暂停态(`mixer.update(0)` 暂停也停在保存帧)。顺手修了
  restoreScene 清模型时不清 `s.anims` 的残留 mixer 泄漏。
- **录制关键帧入工程**:`DirectorSceneData.recordKeyframes?: CameraKeyframe[]`
  (可选字段,旧工程向后兼容 = 清空);restore 直接回填 `s.keyframes`,
  再进「录制视频」时间轴原样可见。
- **退出未保存提醒**:编辑器持有内容指纹 `projectHash` =
  serializeScene 剔除易变噪声(自由相机;动画播放头/播放中逐帧骨骼姿势 —
  只看「应用了哪条动画」,否则播着动画永远判脏)+ 全景来源。基线在
  onReady / 保存工程 / 打开工程时刷新;× 关闭走 `requestClose`
  (脏 → window.confirm);`beforeunload` 兜底窗口关闭/刷新。

## 追加:UI 自由布局 + 顶栏导演台入口(同日,用户反馈)

用户要求:①编辑器整体可放大拉宽;②「对象与机位」面板可自由移动;
③录制模式左上 Preview 面板可自由移动;④顶栏 AGENT 右侧加导演台 3D 入口。

- **编辑器可缩放**:shell 加 CSS `resize: both`(右下角原生手柄),
  min 720×480 / max 98vw×96vh;右侧 属性/姿势/动画 面板加左缘 8px
  拖宽 gutter(200–640px,`usePersistentState('director.sidePanelWidth')`
  持久化);`poseGrid` 改 `auto-fill minmax(62px,1fr)`,拉宽自动多列。
- **面板自由拖动**:新 `useDragPanel` hook(4px 阈值 + pointer capture +
  视口限幅留 48px 抓握;指针落在 button/select/input 上不启动)。
  「对象与机位」标题栏由 `<button>` 改 `<div role="button">`:拖动移动
  整个左堆叠(含灯光面板),`didDrag()` 为真时忽略这次 click,折叠
  开关不受影响;录制 Preview 面板标题栏同款拖动。
- **顶栏入口**:`src/renderer/index.html` AGENT 按钮右侧加
  `#directorEntryBtn`(`data-action="open-director"`,粉底 fa-cube);
  EventManager 注册 `open-director` → 动态 import
  `features/director-launcher`(独立 React root 挂 body,DirectorEditor
  仍是 lazy chunk,three.js 不进主包;关闭时 `setTimeout` 推迟
  unmount 避免 React 同步卸载告警)。与生成页 VisualPromptBar 的
  「导演台 // 3D」入口(需经生成页)互不影响,native 空网格进入。

## 追加:AI(Codex)全权控制导演台 —— director_* MCP 工具(同日,用户拍板「最高权限,别担心越权」)

参考 UE5.8 官方 MCP「领域工具 + action 参数」形态,把 `DirectorStageHandle`
的 55+ 方法收敛为 **6 个 MCP 工具**,复用现有 catimation MCP 通路
(main `McpServer` → `ToolRouter` → IPC → renderer `AgentToolExecutor`):

- **`director_open`** — 打开导演台(未开 → 动态 import launcher 挂独立浮层)
  并等 handle 就绪(30s 超时),幂等。
- **`director_scene`** — `action` 分发全量场景操作:对象
  (list_objects / list_model_catalog / add_model / add_mannequin /
  add_crowd / select / remove / duplicate / clear / focus / mirror /
  undo / redo / set_transform / toggle_grid / set_panorama)、相机与机位
  (set_fov / set_distance / add·apply·remove·update·list_camera_slot)、
  灯光调色(set_key_light / set_ambient / set_light_fx / get_light_fx)、
  姿势(get_bones / list_pose_presets / apply_pose / set_bone_delta /
  reset_pose)、动画(search_animations 走 2032 条目录 chunk /
  play·pause·resume·stop·seek_animation)。
- **`director_snapshot`** — agent「读」场景:summary(剔除逐骨骼四元数,
  保留对象/变换/动画状态/机位/灯光/fx/录制关键帧)或 full(完整
  serializeScene)。
- **`director_capture`** — agent「看」画面:view / aspect(letterbox 取景)
  / multiview(环绕 4|12 视角,查姿势穿模神器);PNG 经 attachments IPC
  落盘为线程附件,回 `imagePaths`。
- **`director_record`** — 运镜:enter/exit/add_keyframe/list/remove/clear/
  seek/export;export 走 `recordExport` 插值运镜录 webm → base64 →
  attachments 落盘回 `videoPath`。
- **`director_exec`** — **最高权限逃生舱**(产品明示要):AsyncFunction
  跑模型 JS,作用域 `director`(整个 handle)+ `THREE`;30s 超时,
  抛错回 `{success:false,error}`,与 canvas_exec 同款不设沙箱。

架构落点:renderer 新增 `director/directorBridge.ts`(仿 canvasBridge:
setHandle/waitForHandle 单例 + 统一 `handle()` 分发,**所有工具错误收敛为
`{ok:false,error}`,绝不抛出去炸 3D 场景**);`DirectorEditor` 在
`onReady` 注册 handle、卸载时清除,任一入口(顶栏/生成页)打开都接上;
`AgentToolExecutor` 加 `director_*` 分支(capture/record 注入活跃
threadId 供附件落盘 FK);main 新增 `mcp/tools/directorTools.ts` 注册
6 工具(zod schema + 注解:exec/load 标 destructive)。打包纪律:
directorBridge 被主 chunk 静态引入,故只 type-import 导演台重模块,
catalog/poses/launcher/three 全部 action 内动态 import(build 实测
three 仍只在 vendor/DirectorEditor chunk)。测试:
`__tests__/directorBridge.test.ts` 11 用例(fake handle 验 action 映射 /
缺参收敛 / snapshot 剔骨骼 / exec 成功与抛错)全绿;既有 4 个失败套件
经 git stash 基线复现为预存,与本次无关。
