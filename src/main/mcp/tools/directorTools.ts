import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

function asResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  }
}

/**
 * 导演台(3D 摆模型/打光/摆姿势/动画/运镜录制)的 MCP 工具面 —— 参考
 * UE5.8 官方 MCP 的「领域工具 + action 参数」形态,把 DirectorStageHandle
 * 的 55+ 方法收敛为 6 个工具。产品拍板「最高权限」:含 director_exec 逃生舱。
 * 全部经 ToolRouter 路由到 renderer 的 directorBridge 执行。
 */
export function registerDirectorTools(server: McpServer, router: ToolRouter): void {
  const READ_ONLY = { readOnlyHint: true, idempotentHint: false, openWorldHint: false } as const
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

  server.registerTool('director_open', {
    description:
      'Open the 3D Director Stage (导演台:摆模型/打光/摆姿势/播动画/运镜录制) and wait until it is ready. Call this FIRST before any other director_* tool. Idempotent — safe to call when already open.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => asResult(await router.call('director_open', {})))

  server.registerTool('director_scene', {
    description: `Operate the Director Stage scene via \`action\` + params. Most pose/animation actions require selecting an advanced mannequin first (\`select\`).

OBJECTS: list_objects | list_model_catalog {keyword?, limit?} | add_model {url, isFbx?, modelId?} | add_mannequin {color: 'blue'|'red'} (rigged advanced mannequin, supports pose+animation) | add_crowd {layout:'single'|'array'|'random', count?, columns?, spacingX?, spacingZ?, radius?} | select {uuid} | deselect | remove_selected | duplicate_selected | clear_models | focus_selected | mirror | undo | redo | set_transform {position?:[x,y,z], rotationDeg?:[x,y,z], scale?:[x,y,z]} | toggle_grid {visible} | set_panorama {url|null}
CAMERA: set_fov {fov} | get_fov | set_distance {distance} | add_camera_slot {name?} | apply_camera_slot {id} | remove_camera_slot {id} | update_camera_slot {id, patch} | list_camera_slots
LIGHT: set_key_light {intensity?, azimuthDeg?, elevationDeg?, color?} | set_ambient {intensity?, color?} | set_light_fx {exposure?, bloom?, contrast?, saturation?, temperature?, vignette?, grain?, ...} | get_light_fx
POSE (select an advanced mannequin first): has_skeleton | get_bones | list_pose_presets | apply_pose {preset?} or {map?: {boneName:[qx,qy,qz,qw]}} (neither = reset) | set_bone_delta {bone, deg:[x,y,z]} | reset_pose
ANIMATION (select an advanced mannequin first): search_animations {keyword?, category?, limit?} (≈2000-clip Mixamo catalog; returns urls) | play_animation {url, name?, ext?} | pause_animation | resume_animation | stop_animation | seek_animation {sec}

Returns { ok, ... } per action; { ok:false, error } on failure (never crashes the stage).`,
    inputSchema: z.object({
      action: z.string().min(1).describe('One of the actions listed in the tool description.'),
      params: z.record(z.string(), z.unknown()).optional().describe('Action parameters (merged into the call).'),
    }),
    annotations: WRITE,
  }, async (p) => {
    const { action, params } = p as { action: string; params?: Record<string, unknown> }
    return asResult(await router.call('director_scene', { action, ...(params ?? {}) }))
  })

  server.registerTool('director_snapshot', {
    description:
      "READ the Director Stage state as structured JSON: placed objects (uuid/name/transform), per-model pose/animation status, live camera + FOV, camera slots (机位), lighting + color-grading fx, record keyframes, current selection skeleton info. mode 'summary' (default, bone quaternions stripped) or 'full' (complete serialized scene incl. bonePose — large). Use this to understand the scene before acting; use director_capture to SEE pixels.",
    inputSchema: z.object({
      mode: z.enum(['summary', 'full']).default('summary'),
    }),
    annotations: READ_ONLY,
  }, async (params) => asResult(await router.call('director_snapshot', params as Record<string, unknown>)))

  server.registerTool('director_capture', {
    description:
      "SEE the Director Stage: render screenshot(s) and save PNG file(s) to disk, returning `imagePaths` you can open/view or feed to generate_image as reference. mode: 'view' (current camera, {height?}) | 'aspect' (letterboxed to {ratio: w/h, short?: short-side px}) | 'multiview' (orbit {count: 4|12, height?} around target — great for checking a pose/staging from all sides). Optional {slotId} applies a saved camera slot first.",
    inputSchema: z.object({
      mode: z.enum(['view', 'aspect', 'multiview']).default('view'),
      height: z.number().optional().describe('Output height px (view/multiview).'),
      ratio: z.number().optional().describe('Aspect w/h for mode=aspect (e.g. 1.7778 for 16:9).'),
      short: z.number().optional().describe('Short-side px for mode=aspect (default 1080).'),
      count: z.number().optional().describe('4 or 12 orbit views for mode=multiview.'),
      slotId: z.string().optional().describe('Apply this camera slot before capturing.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('director_capture', params as Record<string, unknown>)))

  server.registerTool('director_record', {
    description: `Camera-move recording timeline (运镜录制) via \`action\`:
enter | exit — toggle recording layout. add_keyframe {t: seconds} — capture current camera as a keyframe at time t (move the camera between calls: director_exec or apply_camera_slot / set_transform). list | remove {id} | clear | seek {t} — manage/scrub keyframes. export {durationSec?, resolution?: '1080p'|'2k'|'4k', fps?: 24|30|60, quality?: 'low'|'medium'|'high'|'max'} — interpolate keyframes into a camera move, record the canvas and save a video file; returns \`videoPath\`.`,
    inputSchema: z.object({
      action: z.enum(['enter', 'exit', 'add_keyframe', 'list', 'remove', 'clear', 'seek', 'export']),
      t: z.number().optional(),
      id: z.string().optional(),
      durationSec: z.number().optional(),
      resolution: z.enum(['1080p', '2k', '4k']).optional(),
      fps: z.number().optional(),
      quality: z.enum(['low', 'medium', 'high', 'max']).optional(),
    }),
    annotations: WRITE,
  }, async (params) => asResult(await router.call('director_record', params as Record<string, unknown>)))

  server.registerTool('director_exec', {
    description: `HIGHEST-AUTHORITY escape hatch: execute JavaScript directly against the live Director Stage. Scope: \`director\` (the full DirectorStageHandle — every method the UI itself uses: addModel, addCrowd, listObjects, selectByUuid, setSelectedTransform, setKeyLight, setLightFx, applyPose, setBoneDelta, playAnimation, capturePoseKeyframe, applyPoseKeyframe, playPoseClip, exportPoseClipGlb, addCameraSlot, applyCameraSlot, recordAddKeyframe, recordSeek, serializeScene, restoreScene, undo/redo, ...) plus \`THREE\` (the three.js namespace). Async/await supported; use \`return\` to read data back. 30s timeout; a thrown error returns { success:false, error } without crashing the stage.

Examples:
- return director.listObjects()
- await director.addModel('https://…/model.glb'); director.focusSelected()
- director.selectByUuid(uuid); director.setBoneDelta('mixamorigRightArm', [0,0,60])
- const k = director.capturePoseKeyframe(); return k && Object.keys(k.bones).length`,
    inputSchema: z.object({
      code: z.string().min(1).describe('JavaScript to run. Has `director` + `THREE` in scope; use `return` for output.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => asResult(await router.call('director_exec', params as Record<string, unknown>)))
}
