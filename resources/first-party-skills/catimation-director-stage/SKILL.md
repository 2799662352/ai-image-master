---
name: catimation-director-stage
description: >-
  Drive the 3D Director Stage (导演台) in the CATIMATION desktop app: place
  models/mannequins, pose characters, play the ≈2000-clip animation library,
  author custom pose-keyframe animations (K 动画), set lights/color grading,
  manage camera slots, and record camera-move videos. Trigger on 导演台 / 3D 摆
  场景 / 摆个姿势 / 假人 / K 动画 / 运镜 / 打光 / 机位 / 3D 预演 / staging /
  blocking. Uses the director_* MCP tools (director_open/scene/snapshot/capture/
  record/exec).
---

# CATIMATION Director Stage — agent-driven 3D staging (导演台)

The Director Stage is a three.js scene editor (advanced mannequins, model
catalog, lighting, camera slots, camera-move recording). You control everything
through 6 tools. Modeled on the Unreal Engine 5.8 MCP discipline.

## Hard rules (UE-grade discipline)

1. **SERIAL calls only.** Never issue two director_* calls concurrently — all
   actions mutate one live 3D scene on the render thread. Wait for each result.
2. **director_open FIRST.** Every session starts with `director_open`
   (idempotent). Other tools error with "导演台未打开" until the stage is ready.
3. **Read → act → verify.** Before acting, call `director_snapshot` (summary)
   to learn what exists (uuids, camera, lights, keyframes). After meaningful
   changes, call `director_capture` and LOOK at the returned image(s) — check
   pose naturalness, framing, lighting — then iterate. Never claim a scene looks
   right without capturing it.
4. **Select before pose/animation.** Pose, bone, animation, and K-动画 actions
   operate on the CURRENT SELECTION and require an advanced mannequin:
   `add_mannequin {color}` → `list_objects` → `select {uuid}` →
   `has_skeleton` to confirm.
5. **director_exec is the LAST resort.** Prefer named actions (they validate
   input and never crash the stage). Use exec only for things no action covers,
   keep scripts short, and never call `director.dispose`-like internals.
6. **Exports need an active chat thread.** capture/record/export_pose_clip_glb
   save into the thread's attachments and return real file paths — you can feed
   `imagePaths` straight into `generate_image` referenceImages or
   `open_image_viewer`.

## Typical flows

**Stage a scene (摆场景)**: director_open → snapshot → `add_mannequin`/
`add_model` (find urls via `list_model_catalog`) → `select` + `set_transform`
(position/rotationDeg/scale) → `set_key_light`/`set_light_fx` → `set_fov`
→ capture (mode 'view' or 'multiview' to check from all sides) → iterate.

**Pose a character (摆姿势)**: select mannequin → `list_pose_presets` →
`apply_pose {preset}` for a base → `set_bone_delta {bone, deg}` to refine
(get names via `get_bones`) → capture to verify → `mirror` if needed.

**Play library animation (播动画)**: select mannequin →
`search_animations {keyword}` (≈2000 Mixamo clips) → `play_animation {url}`
→ optionally `director_record action=capture_video` to hand the user a video.

**Import the user's own files (导入本地模型/动画)**: `add_model` and
`play_animation` both accept a LOCAL file path (model: glb/gltf/fbx/pmx/pmd/
zip; anim: fbx/glb/json/vmd) — e.g. a model the user downloaded, or the .glb
you just exported via `export_pose_clip_glb`. Pass the OS path directly as
`url`; the bridge reads the bytes and loads them. No manual upload step, and
NEVER spin up a local HTTP server to feed files.
MMD 专项:pmx/pmd 模型请连同贴图打成 zip 传 `add_model`;.vmd 动作只能播
在 MMD 模型上(先 add_model 导入 PMX 并 `select`,再 `play_animation` 传
.vmd 路径);MMD 镜头 .vmd 走 `director_record action=import_camera_clip`。

**Author a custom animation (K 动画)**: select mannequin → pose frame 1 →
`capture_pose_keyframe` (returns {bones, rootPos}) → store it with t=0 →
re-pose → capture again with t=1.5 … → `play_pose_clip {keyframes, duration}`
→ capture/capture_video to verify motion → `export_pose_clip_glb` to save a
reusable .glb. Space keyframes ≥0.3s apart; end with a frame matching the first
for clean loops.

**Camera move (运镜)**: `director_record action=enter` → position camera
(orbit via set_transform on nothing = use `apply_camera_slot` or
`director_exec` camera math) → `add_keyframe {t:0}` → move camera →
`add_keyframe {t:4}` … → `play` to preview → `export {durationSec,
resolution, fps}` → returns videoPath. To load a ready-made camera file
(local or https json/vmd/glb/gltf/fbx, e.g. an MMD camera .vmd) use
`import_camera_clip {url, mode?}` instead of re-keyframing by hand.

**Save / restore**: `director_snapshot mode=full` returns the complete scene
doc — keep it to restore later via `director_scene action=restore_scene
{scene}`. `undo`/`redo` cover single-step mistakes; `reset` re-centers the
camera; `clear_models` empties the stage (destructive — confirm with the user).

## Camera slots (机位)

`add_camera_slot` saves the CURRENT view; `apply_camera_slot` jumps back.
Build a slot per shot (全景/中景/特写), then `director_capture {slotId}` each
slot to deliver a shot list. `duplicate_camera_slot` + `update_camera_slot`
for variants.

## 衔接出图链路(单锚点纪律 × 四项质检)

导演台截图在出图链路里的身份是 **姿势/构图/机位/光位锚,不是角色 ID 锚**:

1. **分工**:角色"长什么样"仍由单锚点纪律负责(默认大头照+全身照,三视图/
   四视图仅作可选补充);导演台截图负责"站哪、什么姿势、哪个机位、光从哪来"。
   出图时把两者一起传 `generate_image` 的 `referenceImages`(角色锚点 +
   `director_capture` 的 imagePaths),并在提示词里明说:灰色假人图仅供
   pose / composition / camera / lighting 参考,**不要把假人外观画进成品**。
2. **顺序纪律**:先在导演台摆好并 capture 自检通过(姿势自然、构图成立、
   光位对),**再**出图 —— 不要出完图再反过来改 staging 空耗重生成迭代。
3. **质检衔接**:成品图照过 catimation-image 的四项验收清单;其中
   ③风格一致 除对照角色锚点/圣经外,还要**对照导演台 staging**——构图、
   姿势、机位、光向是否与 capture 截图一致。不一致 → 把导演台截图作为
   referenceImages 带上,改提示词重生成。
4. **多镜制片**:每镜一个 camera slot → `director_capture {slotId}` 出一张
   staging 参考 → 逐镜出图,天然满足 film-studio 资产门的"全用素材"要求;
   连续性(服装/道具/光)靠同一场景不动、只切机位来保证。

## What NOT to do

- Do not spam captures every micro-step (each one writes a PNG) — batch checks.
- Do not guess bone names — read `get_bones`.
- Do not run long `director_exec` loops/animations (30s timeout kills them);
  use play_animation / play_pose_clip instead.
- Do not call director_record export without ≥2 keyframes (it will be static).
