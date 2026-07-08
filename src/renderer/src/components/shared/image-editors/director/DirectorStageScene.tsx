import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  DEFAULT_KEYMAP,
  eventToToken,
  tokenToAction,
  type Keymap,
} from './directorShortcuts';
import { disposeScene } from '../orbitGlobeShared';
import { createLightFx, type LightFx } from '../postfx/createLightFx';
import type { ToneMappingMode } from '../postfx/lightFxConstants';
import {
  ENTRY_DEFAULTS,
  LIGHT_DEFAULTS,
  MULTI_VIEW_ANGLES,
  SCENE,
  computeBitrate,
  computeOutputSize,
  pickRecorderMime,
  type CaptureResolution,
  type DirectorEntry,
  type RecordFps,
  type RecordQualityKey,
  type TransformMode,
} from './directorConstants';
import { CAPTURE_RES_SHORT } from './directorConstants';
import { buildShaderGrid, type ShaderGrid } from './directorGrid';
import { buildCrowdLayout, type CrowdOpts } from './directorMannequin';
import { buildPoseClip, newKeyframeId, parseClipJson, type PoseKeyframe } from './directorPoseClip';
import {
  findClipCamera,
  normalizeCameraKeys,
  parseCameraClipJson,
  parseVmdCameraBuffer,
  retargetCameraKeysToPose,
  sampleObjectClip,
  type CameraKeyframe,
} from './directorCameraClip';
import { accumulateBoneWeights, rankBoneIndices } from './directorBonePick';
import { clampSwingTwist, solveTwoBone } from './directorIk';

/** 一个保存的机位:相机位姿 + 视点 + FOV(逆向自实站 applyCameraState). */
export interface CameraSlot {
  id: string;
  name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  target: [number, number, number];
  fov: number;
  /** 相机射线:画出机位→LookAt 目标的对齐线(实站「相机射线」开关). */
  showRay: boolean;
}

// 录制关键帧类型迁到 directorCameraClip(通用镜头格式模块);这里 re-export
// 保持既有 import 路径不变。
export type { CameraKeyframe } from './directorCameraClip';

/** 机位属性面板可编辑的字段(实站右侧「属性」). */
export interface CameraSlotPatch {
  name?: string;
  position?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  showRay?: boolean;
}

export interface RecordOptions {
  /**
   * 录制时长(秒)。对关键帧导出(recordExport):传 0/负值 = 按关键帧
   * 跨度(首帧→末帧)1:1 实时导出,导出时长与时间轴严格对齐;传正值 =
   * 把运镜整体拉伸/压缩到该时长。对直录(recordVideo)则为实际录制时长。
   */
  durationSec: number;
  resolution: CaptureResolution;
  fps: RecordFps;
  quality: RecordQualityKey;
  /**
   * 输出画幅比例(宽/高),与机位「画幅比例」同一数据源(directorAspect)。
   * null/未传 = 全屏(跟随画布比例,不裁剪);指定时按 renderAspectCrop 同款
   * 居中裁剪导出,和录制页黄色取景框所见严格一致。
   */
  aspect?: number | null;
  /**
   * 选择性导出区间 [入点, 出点](秒,时间轴坐标)。未传 = 关键帧首→末全程。
   * 与 durationSec 组合:durationSec>0 时把该区间拉伸/压缩到指定时长。
   */
  rangeSec?: [number, number] | null;
  onProgress?: (pct: number) => void;
}

export interface RecordResult {
  blob: Blob;
  mime: string;
  ext: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface SelectionInfo {
  uuid: string;
  /** stable catalog id if known */
  modelId?: string;
  name: string;
  position: [number, number, number];
  /** Euler in degrees (XYZ). */
  rotationDeg: [number, number, number];
  scale: [number, number, number];
}

export interface AddModelOpts {
  modelId?: string;
  isFbx?: boolean;
  /** 文件扩展名(pmx/pmd/zip 走 MMD 加载器;objectURL 无后缀,必须显式给)。 */
  ext?: string;
  /** place at this world position; defaults to origin. */
  position?: [number, number, number];
}

export interface BoneInfo {
  uuid: string;
  name: string;
  /** nesting depth under the model root (for indented tree display). */
  depth: number;
}

export interface SceneObjectInfo {
  uuid: string;
  name: string;
  selected: boolean;
}

/** How a placed object was created (stored on `userData.directorMeta`). */
export interface DirectorModelMeta {
  source: 'model' | 'advanced' | 'crowd';
  /** load URL for model/advanced (CDN or, for imports, resolved from modelId). */
  url?: string;
  isFbx?: boolean;
  /** 文件扩展名(MMD 的 pmx/pmd/zip 还原工程时需要走 MMD 加载器)。 */
  ext?: string;
  /** catalog id, `adv-<color>` for advanced, or an IndexedDB asset id for imports. */
  modelId?: string;
  /** crowd layout opts (普通假人/路人) when source==='crowd'. */
  crowd?: CrowdOpts;
}

/** 保存工程时记录的「已应用动画」:目录动画存 URL,导入/K 动画存资产 id. */
export interface SavedAnimState {
  name: string;
  /** 可跨会话加载的 URL(http/https 目录动画);objectURL 不存. */
  url?: string;
  ext?: string;
  /** 「我的动画」IndexedDB 资产 id(打开工程时重新解析成 objectURL). */
  assetId?: string;
  /** 保存时的播放头(秒)与播放/暂停态. */
  time: number;
  playing: boolean;
}

/** Per-object snapshot inside a saved project (transform + meta + pose). */
export interface DirectorModelState extends DirectorModelMeta {
  name: string;
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: [number, number, number];
  /** bone pose for rigged models: { boneName: [qx,qy,qz,qw] }. */
  bonePose?: Record<string, [number, number, number, number]>;
  /** 保存时正在该假人上播放/暂停的动画(运动状态). */
  anim?: SavedAnimState;
}

/**
 * 「保存工程」 payload — the full editable scene (NOT a screenshot): every model
 * with its transform/pose, all camera 机位, the live camera, and lighting.
 * Mirrors the live app's `serialize()` schema (version:1).
 */
export interface DirectorSceneData {
  version: 1;
  models: DirectorModelState[];
  cameraSlots: CameraSlot[];
  camera: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    target: [number, number, number];
    fov: number;
  };
  light: {
    keyIntensity: number;
    keyColor: string;
    keyAzimuthDeg: number;
    keyElevationDeg: number;
    ambientIntensity: number;
    ambientColor: string;
  };
  /** 光感/调色后处理(可选,向后兼容:旧工程无此字段时按中性还原). */
  fx?: DirectorLightFxState;
  /** 录制视频的相机运镜关键帧 = 自由视角全局轨(可选,向后兼容). */
  recordKeyframes?: CameraKeyframe[];
  /** 多机位:各机位独立镜头轨道(key = 机位 id;可选,向后兼容). */
  cameraTracks?: Record<string, CameraKeyframe[]>;
  /** 机位切换点(播放/导出按 1→2→3 依序切活动机位;可选,向后兼容). */
  cameraCuts?: { t: number; slotId: string }[];
}

export interface DirectorStageHandle {
  addModel(url: string, opts?: AddModelOpts): Promise<void>;
  /**
   * Add 普通假人 (crowd / 路人): articulated procedural mannequins built in code
   * (no downloadable asset). Supports single / array / random layouts with
   * per-figure color variants. Matches the live app's crowd system (docs §11).
   */
  addCrowd(opts: CrowdOpts): void;
  removeSelected(): void;
  clearModels(): void;
  setTransformMode(mode: TransformMode): void;
  /** 撤销 / 重做 上一步可编辑操作(移动/旋转/缩放、添加、删除、复制、姿势). */
  undo(): void;
  redo(): void;
  /** 复制当前选中对象(单个或框选多个),并选中副本. */
  duplicateSelected(): void;
  /** 取景:把相机对准并拉到合适距离以框住当前选择(快捷键 F). */
  focusSelected(): void;
  /** 取消所有选择(快捷键 Esc). */
  deselect(): void;
  /** 开关「框选」工具(左键拖拽 = 框选多选;快捷键 B). */
  setBoxSelect(on: boolean): void;
  setLensFov(fov: number): void;
  setDistance(d: number): void;
  setKeyLight(p: {
    intensity?: number;
    azimuthDeg?: number;
    elevationDeg?: number;
    color?: string;
  }): void;
  setAmbient(p: { intensity?: number; color?: string }): void;
  /**
   * 光感/调色后处理(复用全景 createLightFx):曝光 / 辉光 / 对比 / 饱和 /
   * 色温 / 暗角 / 颗粒 / 色调映射模式。全部中性 = 不改变现状。
   */
  setLightFx(p: Partial<DirectorLightFxState>): void;
  /** 读取当前光感/调色参数(给 UI 初值). */
  getLightFx(): DirectorLightFxState;
  /** Apply transform to the currently selected object. */
  setSelectedTransform(t: {
    position?: [number, number, number];
    rotationDeg?: [number, number, number];
    scale?: [number, number, number];
  }): void;
  toggleGrid(visible: boolean): void;
  setPanorama(url: string | null): void;
  mirror(): void;
  reset(): void;
  /** Skeleton posing — only meaningful for rigged models (SkinnedMesh). */
  hasSkeleton(): boolean;
  getBones(): BoneInfo[];
  showSkeleton(visible: boolean): void;
  /** Attach the gizmo to a bone (rotate mode) for posing; pass null to return to the whole model. */
  poseBone(uuid: string | null): void;
  /**
   * 视口骨骼点选模式(姿势 Tab / K 动画时间轴打开时启用):点选中高级假人的
   * 身体 → 皮肤权重反查骨骼并挂 gizmo;「显示骨架」时叠加可点关节手柄。
   */
  setBonePick(on: boolean): void;
  /** Restore all bones of the selected model to their loaded rest pose. */
  resetPose(): void;
  /**
   * Apply a baked pose preset to the selected rigged model.
   * `map` is { mixamorigBoneName: [qx,qy,qz,qw] } (local quaternions). Pass
   * null to return to the rest pose (默认). Bones are matched by normalized name.
   */
  applyPose(map: Record<string, [number, number, number, number]> | null): void;
  /**
   * Set a per-bone rotation delta (degrees, XYZ) relative to the pose base
   * captured at the last applyPose/reset. Used by the 姿势调节 sliders.
   */
  setBoneDelta(boneName: string, deg: [number, number, number]): void;
  /** True if the selected model is one of the rigged X/Y bot mannequins. */
  isAdvancedMannequin(): boolean;
  // ── 动画(高级假人 Mixamo 剪辑预览) ────────────────────────────
  // 动画不入撤销栈;停止时恢复播放前姿势。「保存工程」会记录每个假人的
  // 已应用动画(来源 + 播放头 + 播放/暂停态),打开工程时还原。
  /**
   * Load + loop an animation clip on the selected advanced mannequin.
   * `ext` 指明格式(fbx/glb/gltf/json);省略时按 URL 扩展名推断,默认 fbx。
   * `assetId` = 「我的动画」资产 id(保存工程时以 id 还原,objectURL 跨会话无效)。
   */
  playAnimation(url: string, name?: string, ext?: string, assetId?: string): Promise<void>;
  pauseAnimation(): void;
  resumeAnimation(): void;
  /** Stop and restore the pose captured before playback started. */
  stopAnimation(): void;
  /** Jump to `sec` (clamped to [0, duration]); works both playing and paused. */
  seekAnimation(sec: number): void;
  // ── K 动画(姿势关键帧;数据由 UI 持有,场景只负责取样/编译/播放) ──
  /** 读选中假人当前姿势为一帧数据(真实骨骼四元数+根骨骼位置+根位置);非高级假人 → null. */
  capturePoseKeyframe(): Pick<PoseKeyframe, 'bones' | 'rootPos' | 'bonePos'> | null;
  /** 把一帧姿势应用回选中假人(时间轴 scrub 单帧预览;不入撤销栈). */
  applyPoseKeyframe(k: Pick<PoseKeyframe, 'bones' | 'rootPos' | 'bonePos'>): void;
  /** 把关键帧集合编译为剪辑并在选中假人上循环播放(走与目录动画同一 mixer 通路). */
  playPoseClip(keys: readonly PoseKeyframe[], duration: number, name?: string): Promise<void>;
  /** 把关键帧集合编译为剪辑并连同选中假人导出为 .glb(GLTFExporter 按需加载). */
  exportPoseClipGlb(keys: readonly PoseKeyframe[], duration: number, name?: string): Promise<Blob>;
  /**
   * 把动画剪辑(目录/我的动画)采样成 K 动画姿势关键帧(拖动画到 K 时间轴):
   * 选中高级假人上临时跑 mixer 逐时刻采样骨骼,采完恢复原姿势,不改现场。
   * 采样密度 4Hz,上限 `maxKeys`(默认 600 ≈ 150s;上限过低会把长剪辑的
   * 快动作抹平成慢漂移)。MMD 采 FK 原始值,IK/Grant 由回放时逐帧活算。
   */
  sampleAnimToPoseKeys(url: string, ext?: string, maxKeys?: number): Promise<PoseKeyframe[]>;
  /** Single screenshot → PNG data URL. `height` (px) overrides output resolution. */
  capture(height?: number): string;
  /**
   * Screenshot cropped to an aspect ratio (= width/height), matching the
   * letterbox 取景框 shown in the camera fullscreen page. `ratio=null` → full
   * viewport. `short` = output short-side px (defaults to 1080).
   */
  captureAspect(ratio: number | null, short?: number): string;
  /** Orbit the camera N times around target, capture each → PNG data URLs. */
  captureMultiView(count: 4 | 12, height?: number): string[];
  /** Flat list of placed models (for the 对象与机位 panel). */
  listObjects(): SceneObjectInfo[];
  /** Select a placed model by uuid (from the panel). */
  selectByUuid(uuid: string): void;
  // ── 机位 (camera slots) ───────────────────────────────────────
  /** Snapshot the current camera (pos/quat/target/fov) as a new 机位. */
  addCameraSlot(name?: string): CameraSlot;
  /** Move the live camera to a saved 机位. */
  applyCameraSlot(id: string): void;
  removeCameraSlot(id: string): void;
  /** Duplicate a 机位 (实站「复制」). */
  duplicateCameraSlot(id: string): CameraSlot | null;
  /** Edit a 机位's fields from the 属性 panel (name/pos/target/fov/ray). */
  updateCameraSlot(id: string, patch: CameraSlotPatch): void;
  listCameraSlots(): CameraSlot[];
  /** Current free-view FOV (for the 自由视角 readout). */
  getFov(): number;
  /**
   * Render a live preview of a 机位 (or the free view when id is null) into the
   * given 2D canvas. Used by the 机位 preview window thumbnails. Cheap enough
   * to call on a throttled interval per visible thumbnail.
   */
  renderSlotPreview(id: string | null, canvas: HTMLCanvasElement): void;
  // ── 录制视频:关键帧运镜时间轴 ────────────────────────────────
  /** Enter/exit recording layout (pauses orbit edits while playing). */
  recordEnter(): void;
  recordExit(): void;
  /** Capture the current camera as a keyframe at time `t` (seconds). */
  recordAddKeyframe(t: number): CameraKeyframe;
  /** 把某机位的位姿作为关键帧放入时间轴(机位拖入时间轴),打上 slotId 标。 */
  recordAddKeyframeFromSlot(slotId: string, t: number): CameraKeyframe | null;
  recordListKeyframes(): CameraKeyframe[];
  recordRemoveKeyframe(id: string): void;
  /** 批量删除(多选 Delete / 剪切)。 */
  recordRemoveKeyframes(ids: readonly string[]): void;
  /** 把关键帧的相机位姿更新为当前机位(时间不变)。 */
  recordUpdateKeyframe(id: string): void;
  /**
   * 把一组关键帧整体平移 `deltaT` 秒(打组自由移动)。整组被夹在 [0, maxT]
   * 内(保持组内间距不变);返回实际生效的平移量。
   */
  recordMoveKeyframes(ids: readonly string[], deltaT: number, maxT?: number): number;
  recordClearKeyframes(): void;
  /**
   * 把导入/预设的镜头关键帧装入时间轴并返回装入后的全量列表。
   * `replace` = 覆盖现有关键帧(时间平移到 0);`append` = 接在末帧 1s 之后;
   * `atSec` 指定时 = 平移到该时刻并入现有关键帧(拖入时间轴的落点语义)。
   */
  recordLoadKeyframes(
    keys: readonly CameraKeyframe[],
    mode?: 'replace' | 'append',
    atSec?: number,
    /** 镜头起始位置约束:true = 锚定当前相机;{slotId} = 锚定某机位(镜头放入机位)。 */
    anchorTo?: boolean | { slotId: string },
  ): CameraKeyframe[];
  /** 当前相机位姿基准(位置/注视目标/FOV),给镜头预设参数化(所见即基准). */
  getCameraPose(): {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
  };
  /**
   * 从 URL 导入镜头文件为关键帧(不入时间轴,由 UI 决定 replace/append):
   * - glb/gltf/fbx → 找相机节点(isCamera / 名含 cam),AnimationMixer 逐时刻
   *   烘焙**世界**位姿(Blender 导出的相机常被父容器包裹,直读轨道会错);
   * - json → director-camera@1 包裹或裸 AnimationClip JSON,轨道直接采样。
   */
  importCameraClip(url: string, ext?: string): Promise<{ name: string; keys: CameraKeyframe[] }>;
  // ── 多机位轨道(Blender:每台相机独立 Action + Marker 绑定切机位)────
  /** 切换激活轨道:'free'(自由视角全局轨)或机位 id。之后所有关键帧
   *  操作(增/删/改/装入/列出)都作用于该轨。 */
  recordSetActiveTrack(id: string): void;
  recordGetActiveTrack(): string;
  /** 机位切换点列表(按 t 升序)——1→2→3→4 依序切活动机位。 */
  recordListCuts(): { t: number; slotId: string }[];
  /** 在 t 秒放一个「切到某机位」的切换点(±0.04s 内已有则覆盖)。 */
  recordAddCut(t: number, slotId: string): void;
  recordRemoveCut(t: number): void;
  /** 拖动切换点:把 oldT 处的切换点移到 newT(保持机位不变,重新排序)。 */
  recordMoveCut(oldT: number, newT: number): void;
  /** 按切换点把多机位编排拍扁成单相机关键帧流(导出成片镜头/VMD 用);
   *  切点处相邻帧(1/30s)硬切;无切换点 = 当前轨副本。 */
  recordFlattenedKeyframes(): CameraKeyframe[];
  /** 时间轴总长度:所有轨道末帧与最后切换点的最大值(成片预览/导出范围)。 */
  recordTimelineExtent(): number;
  /** Seek the camera to time `t` by interpolating between keyframes. */
  recordSeek(t: number): void;
  /**
   * Play the camera from `startSec` to `endSec` in real time; returns a stop fn.
   * `loop` = 循环预览(与 K 动画预览同款):到末尾回到起点继续播,
   * 直到调用返回的 stop 函数;此时不触发 `onDone`。
   */
  recordPlay(
    startSec: number,
    endSec: number,
    onTime: (t: number) => void,
    onDone: () => void,
    loop?: boolean,
  ): () => void;
  /** Export the keyframe animation as a video (plays + captures the canvas). */
  recordExport(opts: RecordOptions): Promise<RecordResult>;
  // ── 录制视频 (simple canvas capture, kept for fallback) ───────
  recordVideo(opts: RecordOptions): Promise<RecordResult>;
  isRecording(): boolean;
  // ── 保存/打开工程(非截图:序列化整个可编辑场景) ──────────────
  /** Serialize the whole scene (models/poses/机位/camera/lighting) for 「保存工程」. */
  serializeScene(): DirectorSceneData;
  /**
   * Rebuild the scene from a saved project. `resolveUrl(modelId)` lets the editor
   * turn imported-asset ids back into loadable object URLs (IndexedDB); return
   * null to fall back to the stored URL.
   */
  restoreScene(
    data: DirectorSceneData,
    resolveUrl?: (modelId: string) => Promise<string | null>,
  ): Promise<void>;
}

interface DirectorStageProps {
  entry: DirectorEntry;
  panoramaUrl?: string;
  width: number;
  height: number;
  onSelectionChange?: (sel: SelectionInfo | null) => void;
  /** fired whenever the set of placed models changes (add/remove/clear/select). */
  onObjectsChange?: (objs: SceneObjectInfo[]) => void;
  onReady?: () => void;
  /** fired when the gizmo mode changes via keyboard (W/E/R) so the UI can sync. */
  onModeChange?: (mode: TransformMode) => void;
  /** fired when the undo/redo availability changes (for toolbar button enable). */
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /** fired when the 框选 (box-select) tool is toggled (keyboard B / Esc). */
  onBoxSelectChange?: (on: boolean) => void;
  /** 当前快捷键绑定(可由用户在面板里改键);省略时用默认绑定. */
  keymap?: Keymap;
  /** 动画播放进度回传(播放中 ~10Hz;null = 动画已停止/清理). */
  onAnimTick?: (tick: AnimTick | null) => void;
  /** 视口点选骨骼时回传(null = 退回整体模型),供右栏联动高亮/展开分组. */
  onBonePick?: (pick: { uuid: string; name: string } | null) => void;
  /** gizmo 旋转骨骼时回传相对姿势基准的 XYZ 欧拉增量(度),供滑杆双向同步. */
  onBoneRotate?: (boneName: string, deltaDeg: [number, number, number]) => void;
}

/** 动画播放进度(给 UI 播放条;报「当前选中对象」的动画,选中无动画 = null). */
export interface AnimTick {
  url: string;
  name: string;
  /** 动画所在假人的 uuid. */
  targetUuid: string;
  time: number;
  duration: number;
  playing: boolean;
}

/** 活动动画(挂在某个高级假人上的 mixer + 当前 action;每假人一份,互不影响). */
interface ActiveAnim {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  target: THREE.Object3D;
  /** 播放前姿势快照 — stop 时恢复(动画是瞬态预览). */
  poseSnap: PoseSnap;
  duration: number;
  url: string;
  name: string;
  /** 来源信息(保存工程时还原用):格式扩展名 / 「我的动画」资产 id. */
  ext?: string;
  assetId?: string;
}

/** 一条可拖拽 IK 链:links = [上肢骨, 下肢骨](肩/胯 → 肘/膝),effector = 末端骨. */
interface IkChainRef {
  links: THREE.Bone[];
  effector: THREE.Bone;
  /** pole target 在模型根局部空间的位置(肘/膝朝向;跟随模型变换). */
  poleLocal: THREE.Vector3;
  /** 根骨(肩/胯)骨骼指向轴 = 肘/膝在根骨局部空间的位置方向(单位向量). */
  rootAxis: THREE.Vector3;
  /** 根骨 swing 锥角上限(弧度,相对休息姿势;防手臂穿躯干/大腿反掰). */
  swingMax: number;
  /** 根骨 twist 上限(弧度,绕骨骼自身轴 ±). */
  twistMax: number;
}

/** 关节手柄:真实骨骼(非嵌套孪生)每根一个可点小球,单个 InstancedMesh 承载. */
interface JointHandles {
  mesh: THREE.InstancedMesh;
  bones: THREE.Bone[];
  /** 每关节半径:按骨长(到父骨距离)比例分配,手指小球远小于躯干. */
  radii: number[];
  /** 当前 hover 的实例下标(-1 = 无). */
  hover: number;
  /** 实例下标 → IK 链(手/脚末端小球可拖拽整条肢体). */
  ik: Map<number, IkChainRef>;
  /** pole target 手柄(八面体小球,实例 i ↔ poleChains[i]). */
  poleMesh: THREE.InstancedMesh | null;
  poleChains: IkChainRef[];
  poleHover: number;
  poleRadius: number;
  /** 肘/膝 → pole 的关联虚线. */
  poleLines: THREE.LineSegments | null;
}

interface StageState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  transform: TransformControls;
  modelsGroup: THREE.Group;
  keyLight: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  grid: ShaderGrid;
  panoSphere: THREE.Mesh | null;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  selected: THREE.Object3D | null;
  skeletonHelper: THREE.SkeletonHelper | null;
  posingBone: THREE.Bone | null;
  /** 视口骨骼点选模式(姿势 Tab / K 动画时间轴打开时由 UI 开启). */
  bonePick: boolean;
  /** 关节手柄(「显示骨架」时的可点小球;与 skeletonHelper 同生命周期). */
  joints: JointHandles | null;
  frameId: number;
  keyAz: number;
  keyEl: number;
  keyDist: number;
  cameraSlots: CameraSlot[];
  recording: boolean;
  /** Lines visualizing each slot's camera→target ray (keyed by slot id). */
  rayGroup: THREE.Group;
  rayLines: Map<string, THREE.Line>;
  /** 机位摄像机模型(Blender 同款可拖动 3D gizmo),keyed by slot id. */
  camGizmoGroup: THREE.Group;
  camGizmos: Map<string, THREE.Group>;
  /** 当前被 transform gizmo 选中的机位 id(点击摄像机模型时)。 */
  selectedCamSlot: string | null;
  /** TransformControls 的可视 helper(r0.184 getHelper() 加进 scene 的对象),
   *  预览缩略图/导出渲染时需要隐藏 —— 移动/旋转/缩放控制环是编辑辅助物。 */
  transformHelper: THREE.Object3D;
  /** 机位模型缩放拖拽的基准镜头距离(拖拽开始时快照):
   *  等比缩放 = 推拉镜头距离,以基准×手柄倍率计算,避免逐事件复利跳变。 */
  camDragBaseDist: number | null;
  /** Offscreen render target + camera reused for preview thumbnails. */
  thumbRT: THREE.WebGLRenderTarget | null;
  thumbCam: THREE.PerspectiveCamera;
  /** Recording keyframe state —— `keyframes` 永远指向"激活轨道"的数组。 */
  keyframes: CameraKeyframe[];
  /** 每机位独立镜头轨道(Blender:每台相机有自己的 Action):
   *  key = 'free'(自由视角全局轨)或机位 id;激活轨不在 store 里,在 keyframes。 */
  tracksStore: Map<string, CameraKeyframe[]>;
  /** 当前激活轨道:'free' 或机位 id。所有 record* 关键帧操作作用于激活轨。 */
  activeTrack: string;
  /** 机位切换点(Blender Marker+Ctrl-B 绑定相机同款):按 t 升序;
   *  播放/导出时依 1→2→3→4 依序切活动机位,每段内走该机位自己的轨道。 */
  cuts: { t: number; slotId: string }[];
  recordPlaying: boolean;
  /** 录制时间轴当前游标时刻(seek/播放/导出统一回写)。机位缩略图按此
   *  时刻采样机位轨位姿(Blender 相机预览 = 当前帧求值后位姿,同款口径)。 */
  recordT: number;
  /** 光感/调色后处理(曝光/辉光/调色/景深),与全景共用 createLightFx. */
  lightFx: LightFx;
  /** IBL 环境贴图(全景 PMREM)及其生成器 —— 给金属模型真实反射. */
  pmrem: THREE.PMREMGenerator | null;
  envRT: THREE.WebGLRenderTarget | null;
  /** 是否把全景作为环境光照(scene.environment). */
  envEnabled: boolean;
  /** 光感/调色参数镜像(供 serialize / getLightFx). */
  fxState: DirectorLightFxState;
  // ── 多选 / 框选 / 撤销 ─────────────────────────────────────────
  /** 框选(marquee)多选的对象集合;长度 ≤1 时退化为单选(s.selected). */
  multi: THREE.Object3D[];
  /** 多选时承载 gizmo 的支点(空 Object3D,位于选区质心);单选时为 null. */
  pivot: THREE.Object3D | null;
  /** 框选工具是否开启(开启时左键拖拽 = 框选,而非旋转视角). */
  marquee: boolean;
  /** 撤销 / 重做命令栈. */
  undoStack: HistoryCmd[];
  redoStack: HistoryCmd[];
  /** gizmo 拖拽开始时记录的受影响对象 transform 快照(拖拽结束后入栈). */
  dragSnap: TransformSnap[] | null;
  /** 动画预览(高级假人):每个目标对象各自持有 mixer,可多假人同时播. */
  anims: Map<THREE.Object3D, ActiveAnim>;
  /** RAF 循环里驱动 mixer.update 的时钟. */
  clock: THREE.Clock;
}

/** A single undoable operation. `dispose` (optional) frees any detached objects
 *  owned by the command when it is dropped from the history (so 删除后不撤销
 *  也不会泄漏). */
interface HistoryCmd {
  undo(): void;
  redo(): void;
  dispose?(): void;
}

/** Local transform snapshot of one object (for gizmo-move undo). */
interface TransformSnap {
  obj: THREE.Object3D;
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

/** 光感/调色参数(serialize 用). 全部中性 = 不改变现状. */
export interface DirectorLightFxState {
  exposure: number;
  bloom: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
  grain: number;
  toneMapping: ToneMappingMode;
  envEnabled: boolean;
  envIntensity: number;
  dofEnabled: boolean;
  dofFocus: number;
  dofAperture: number;
  dofMaxBlur: number;
}

export const LIGHTFX_DEFAULTS: DirectorLightFxState = {
  exposure: 1,
  bloom: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  vignette: 0,
  grain: 0,
  toneMapping: 'auto',
  envEnabled: false,
  envIntensity: 1,
  dofEnabled: false,
  dofFocus: 10,
  dofAperture: 0.0002,
  dofMaxBlur: 0.006,
};

function selectionInfo(obj: THREE.Object3D): SelectionInfo {
  return {
    uuid: obj.uuid,
    modelId: obj.userData?.modelId,
    name: obj.userData?.name ?? obj.name ?? 'model',
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotationDeg: [
      THREE.MathUtils.radToDeg(obj.rotation.x),
      THREE.MathUtils.radToDeg(obj.rotation.y),
      THREE.MathUtils.radToDeg(obj.rotation.z),
    ],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}

function DirectorStageInner(
  {
    entry,
    panoramaUrl,
    width,
    height,
    onSelectionChange,
    onObjectsChange,
    onReady,
    onModeChange,
    onHistoryChange,
    onBoxSelectChange,
    keymap,
    onAnimTick,
    onBonePick,
    onBoneRotate,
  }: DirectorStageProps,
  ref: React.Ref<DirectorStageHandle>,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<StageState | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onObjRef = useRef(onObjectsChange);
  const onReadyRef = useRef(onReady);
  const onModeRef = useRef(onModeChange);
  const onHistRef = useRef(onHistoryChange);
  const onBoxRef = useRef(onBoxSelectChange);
  const keymapRef = useRef<Keymap>(keymap ?? DEFAULT_KEYMAP);
  const onAnimTickRef = useRef(onAnimTick);
  const onBonePickRef = useRef(onBonePick);
  const onBoneRotateRef = useRef(onBoneRotate);

  useEffect(() => {
    onSelRef.current = onSelectionChange;
  }, [onSelectionChange]);
  useEffect(() => {
    onBonePickRef.current = onBonePick;
  }, [onBonePick]);
  useEffect(() => {
    onBoneRotateRef.current = onBoneRotate;
  }, [onBoneRotate]);
  useEffect(() => {
    onAnimTickRef.current = onAnimTick;
  }, [onAnimTick]);
  useEffect(() => {
    onObjRef.current = onObjectsChange;
  }, [onObjectsChange]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    onModeRef.current = onModeChange;
  }, [onModeChange]);
  useEffect(() => {
    onHistRef.current = onHistoryChange;
  }, [onHistoryChange]);
  useEffect(() => {
    onBoxRef.current = onBoxSelectChange;
  }, [onBoxSelectChange]);
  useEffect(() => {
    keymapRef.current = keymap ?? DEFAULT_KEYMAP;
  }, [keymap]);

  const emitObjects = () => {
    const s = stateRef.current;
    if (!s) return;
    onObjRef.current?.(
      s.modelsGroup.children.map((c) => ({
        uuid: c.uuid,
        name: (c.userData?.name as string) ?? c.name ?? '模型',
        selected: c === s.selected || s.multi.includes(c),
      })),
    );
  };

  // ── 撤销 / 重做 ────────────────────────────────────────────────
  const MAX_HISTORY = 60;
  const emitHistory = () => {
    const s = stateRef.current;
    onHistRef.current?.(!!s && s.undoStack.length > 0, !!s && s.redoStack.length > 0);
  };
  const pushHistory = (cmd: HistoryCmd) => {
    const s = stateRef.current;
    if (!s) return;
    s.undoStack.push(cmd);
    for (const c of s.redoStack) c.dispose?.(); // dropped redo branch
    s.redoStack = [];
    while (s.undoStack.length > MAX_HISTORY) s.undoStack.shift()?.dispose?.();
    emitHistory();
  };
  const doUndo = () => {
    const s = stateRef.current;
    if (!s || s.undoStack.length === 0) return;
    const cmd = s.undoStack.pop()!;
    cmd.undo();
    s.redoStack.push(cmd);
    emitHistory();
  };
  const doRedo = () => {
    const s = stateRef.current;
    if (!s || s.redoStack.length === 0) return;
    const cmd = s.redoStack.pop()!;
    cmd.redo();
    s.undoStack.push(cmd);
    emitHistory();
  };
  /** Drop the whole history (used on clear / project restore). Disposes any
   *  detached objects owned by pending delete/add commands. */
  const clearHistory = (s: StageState) => {
    for (const c of s.undoStack) c.dispose?.();
    for (const c of s.redoStack) c.dispose?.();
    s.undoStack = [];
    s.redoStack = [];
    emitHistory();
  };

  // ── 动画(高级假人 Mixamo 剪辑预览;瞬态,不入撤销/工程) ─────────
  /** 播放条回传的是「当前选中对象」的动画;选中无动画 → null(其余假人照播). */
  const emitAnimTick = () => {
    const s = stateRef.current;
    if (!s) return;
    const a = s.selected ? s.anims.get(s.selected) : undefined;
    if (!a) {
      onAnimTickRef.current?.(null);
      return;
    }
    onAnimTickRef.current?.({
      url: a.url,
      name: a.name,
      targetUuid: a.target.uuid,
      time: a.action.time,
      duration: a.duration,
      playing: !a.action.paused,
    });
  };
  /** Stop one target's playback and restore the pose captured before it started. */
  const stopAnimFor = (target: THREE.Object3D) => {
    const s = stateRef.current;
    const a = s?.anims.get(target);
    if (!s || !a) return;
    a.mixer.stopAllAction();
    restorePose(a.poseSnap);
    s.anims.delete(target);
    emitAnimTick();
  };
  /**
   * 在目标假人上循环播放一条剪辑(playAnimation / playPoseClip 共用尾程)。
   * 加载期间选择可能已变 —— 调用方传入发起时的 target,这里再校验一次仍在场。
   */
  const startClipOnTarget = (
    target: THREE.Object3D,
    clip: THREE.AnimationClip,
    url: string,
    name: string,
    meta?: { ext?: string; assetId?: string },
  ) => {
    const st = stateRef.current;
    if (!st || !target.parent) return; // 场景已卸载 / 目标已被删除
    // 每个假人各自持有 mixer:给 B 播不影响 A(多假人同时播)。
    const prev = st.anims.get(target); // 同目标换剪辑:复用快照与 mixer
    const poseSnap = prev ? prev.poseSnap : capturePose(target);
    // MMD:VMD 剪辑的轨道名是 `.bones[骨名]`,PropertyBinding 只能从带
    // skeleton 的 SkinnedMesh 根解析 → mixer 根用 mmdMesh(骨名轨道同样可解)。
    const mixerRoot = (target.userData?.mmdMesh as THREE.SkinnedMesh | undefined) ?? target;
    const mixer = prev ? prev.mixer : new THREE.AnimationMixer(mixerRoot);
    if (!prev && target.userData?.mmdMesh) {
      // MMD:循环回卷姿势瞬移,物理刚体钉回骨骼防裙摆甩飞(mixer 随
      // anims 表项一起复用,监听器只挂一次)。
      mixer.addEventListener('loop', () => {
        (target.userData?.mmdOnLoop as (() => void) | undefined)?.();
      });
    }
    mixer.stopAllAction();
    const action = mixer.clipAction(retargetClipTracks(clip, target));
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    st.anims.set(target, {
      mixer,
      action,
      target,
      poseSnap,
      duration: clip.duration,
      url,
      name,
      ext: meta?.ext,
      assetId: meta?.assetId,
    });
    emitAnimTick();
  };

  // ── 视口骨骼点选(皮肤权重反查 / 关节手柄)──────────────────────
  /** 视口点选骨骼:与 poseBone 同通路(停动画→gizmo 旋转),另加关节高亮+回传. */
  const selectBoneForPosing = (bone: THREE.Bone) => {
    const s = stateRef.current;
    if (!s || !s.selected) return;
    if (s.anims.has(s.selected)) stopAnimFor(s.selected);
    s.transform.detach();
    s.posingBone = bone;
    s.transform.attach(bone);
    s.transform.setMode('rotate');
    onModeRef.current?.('rotate');
    refreshJointColors(s);
    onBonePickRef.current?.({ uuid: bone.uuid, name: bone.name || '(bone)' });
  };

  /** 退出骨骼会话:gizmo 回整体模型(Esc / 右栏「返回整体移动」). */
  const exitBonePosing = () => {
    const s = stateRef.current;
    if (!s || !s.posingBone) return;
    s.posingBone = null;
    s.transform.detach();
    if (s.selected) s.transform.attach(s.selected);
    s.transform.setMode('translate');
    onModeRef.current?.('translate');
    refreshJointColors(s);
    onBonePickRef.current?.(null);
  };

  // ── 选择(单选 / 框选多选) ─────────────────────────────────────
  const deselectAll = () => {
    const s = stateRef.current;
    if (!s) return;
    dissolveMulti(s);
    s.transform.detach();
    s.selectedCamSlot = null;
    if (s.selected) {
      clearSkeletonHelper(s);
      s.posingBone = null;
    }
    s.selected = null;
    onSelRef.current?.(null);
    emitObjects();
  };
  const selectMany = (objs: THREE.Object3D[]) => {
    const s = stateRef.current;
    if (!s) return;
    // 注意:换选/取消选择不停动画 —— 动画跟随目标对象存续(与 RunningHub 一致),
    // 只在删除目标/清空场景/显式停止/在别的假人上播新动画时停止。
    dissolveMulti(s);
    if (objs.length === 0) {
      deselectAll();
      return;
    }
    if (objs.length === 1) {
      selectObject(s, objs[0]);
      emitObjects();
      return;
    }
    // 多选:把 gizmo 挂到位于选区质心的空支点;拖拽时再临时把对象 attach 到支点。
    clearSkeletonHelper(s);
    s.posingBone = null;
    s.selected = null;
    s.multi = objs.slice();
    const pivot = new THREE.Object3D();
    pivot.name = '__multiPivot';
    s.scene.add(pivot);
    s.pivot = pivot;
    recenterPivot(s);
    s.transform.attach(pivot);
    onSelRef.current?.(null); // 多选时隐藏单对象属性面板
    emitObjects();
  };
  /** After an undo/redo that restored transforms, refresh gizmo + readout. */
  const afterTransformChange = (s: StageState) => {
    if (s.multi.length > 1) recenterPivot(s);
    if (s.selected) onSelRef.current?.(selectionInfo(s.selected));
    emitObjects();
  };

  // ── 删除 / 复制 / 聚焦 / 框选工具 ──────────────────────────────
  const deleteSelectedImpl = () => {
    const s = stateRef.current;
    if (!s) return;
    const objs = s.multi.length > 1 ? s.multi.slice() : s.selected ? [s.selected] : [];
    if (objs.length === 0) return;
    for (const o of objs) if (s.anims.has(o)) stopAnimFor(o);
    dissolveMulti(s);
    s.transform.detach();
    clearSkeletonHelper(s);
    s.posingBone = null;
    for (const o of objs) s.modelsGroup.remove(o); // keep alive for undo
    s.selected = null;
    onSelRef.current?.(null);
    emitObjects();
    pushHistory({
      undo: () => {
        for (const o of objs) s.modelsGroup.add(o);
        selectMany(objs);
      },
      redo: () => {
        dissolveMulti(s);
        s.transform.detach();
        for (const o of objs) s.modelsGroup.remove(o);
        s.selected = null;
        onSelRef.current?.(null);
        emitObjects();
      },
      dispose: () => {
        for (const o of objs) if (!o.parent) disposeObject(o);
      },
    });
  };
  const addClone = (s: StageState, src: THREE.Object3D): THREE.Object3D => {
    const c = cloneSkinned(src) as THREE.Object3D;
    c.userData.name = (src.userData?.name as string) ?? src.name;
    c.userData.modelId = src.userData?.modelId;
    c.userData.directorMeta = src.userData?.directorMeta;
    c.position.copy(src.position);
    c.quaternion.copy(src.quaternion);
    c.scale.copy(src.scale);
    c.position.x += 0.6; // visible offset so the copy doesn't overlap exactly
    c.position.z += 0.6;
    // Re-capture a self-consistent rest baseline (SkeletonUtils JSON-clones
    // userData, which corrupts the THREE.Quaternion rest data on bones).
    storeRestPose(c);
    s.modelsGroup.add(c);
    return c;
  };
  const duplicateSelectedImpl = () => {
    const s = stateRef.current;
    if (!s) return;
    const srcs = s.multi.length > 1 ? s.multi.slice() : s.selected ? [s.selected] : [];
    if (srcs.length === 0) return;
    const clones = srcs.map((src) => addClone(s, src));
    selectMany(clones);
    emitObjects();
    pushHistory({
      undo: () => {
        dissolveMulti(s);
        s.transform.detach();
        for (const c of clones) s.modelsGroup.remove(c);
        s.selected = null;
        onSelRef.current?.(null);
        emitObjects();
      },
      redo: () => {
        for (const c of clones) s.modelsGroup.add(c);
        selectMany(clones);
      },
      dispose: () => {
        for (const c of clones) if (!c.parent) disposeObject(c);
      },
    });
  };
  const focusSelectedImpl = () => {
    const s = stateRef.current;
    if (!s) return;
    const objs = s.multi.length > 1 ? s.multi : s.selected ? [s.selected] : [];
    if (objs.length === 0) return;
    const box = new THREE.Box3();
    for (const o of objs) box.expandByObject(o);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.5;
    const vFov = THREE.MathUtils.degToRad(s.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * s.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.5;
    const dir = new THREE.Vector3().subVectors(s.camera.position, s.orbit.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
    dir.normalize();
    s.orbit.target.copy(center);
    s.camera.position.copy(center).addScaledVector(dir, dist);
    s.orbit.update();
  };
  const setMarqueeImpl = (on: boolean) => {
    const s = stateRef.current;
    if (!s) return;
    s.marquee = on;
    // 开启框选时禁用左键旋转,让左键拖拽用于画框;关闭时恢复。
    s.orbit.mouseButtons.LEFT = on ? null : THREE.MOUSE.ROTATE;
    onBoxRef.current?.(on);
  };
  /** Record a pose change (preset / reset) as an undoable command. */
  const commitPoseHistory = (s: StageState, obj: THREE.Object3D, before: PoseSnap) => {
    const after = capturePose(obj);
    if (
      before.bones.length === after.bones.length &&
      before.pos.equals(after.pos) &&
      before.bones.every((b, i) => b.q.equals(after.bones[i].q))
    ) {
      return; // nothing actually changed
    }
    pushHistory({
      undo: () => {
        restorePose(before);
        if (s.selected === obj) onSelRef.current?.(selectionInfo(obj));
      },
      redo: () => {
        restorePose(after);
        if (s.selected === obj) onSelRef.current?.(selectionInfo(obj));
      },
    });
  };
  /** Record an "add object" command so it can be undone (object kept alive). */
  const recordAdd = (s: StageState, obj: THREE.Object3D) => {
    pushHistory({
      undo: () => {
        dissolveMulti(s);
        if (s.selected === obj) {
          clearSkeletonHelper(s);
          s.posingBone = null;
          s.transform.detach();
          s.selected = null;
          onSelRef.current?.(null);
        }
        s.modelsGroup.remove(obj);
        emitObjects();
      },
      redo: () => {
        s.modelsGroup.add(obj);
        selectObject(s, obj);
        emitObjects();
      },
      dispose: () => {
        if (!obj.parent) disposeObject(obj);
      },
    });
  };

  // ── Imperative API ───────────────────────────────────────────────
  useImperativeHandle(
    ref,
    (): DirectorStageHandle => ({
      async addModel(url, opts) {
        const s = stateRef.current;
        if (!s) return;
        const obj = await loadModel(url, !!opts?.isFbx, opts?.ext);
        if (!stateRef.current) return; // unmounted mid-load
        // Snap rigs to their bind pose first so measuring/grounding and the
        // captured rest baseline are consistent with the skinning bind matrices.
        // MMD 例外:PMX 的绑定姿势由加载器建立,skeleton.pose() 会破坏
        // Grant/IK 初始状态,跳过。
        if (!obj.userData.mmdMesh) resetSkeletonsToBind(obj);
        // Normalize: center on ground, scale to a sensible height.
        normalizeModel(obj);
        // Kill back-face-culled "invisible walls" + grazing-angle texture shimmer.
        // MMD 例外:MMDToon 材质的单双面由 PMX 材质标志决定,强制 DoubleSide
        // 会破坏头发/脸的剔除技巧。
        if (!obj.userData.mmdMesh) hardenImportedMaterials(obj, s.renderer);
        if (opts?.position) obj.position.set(...opts.position);
        obj.userData.modelId = opts?.modelId;
        // Tag how this object was created so 「保存工程」 can recreate it later.
        const advanced = !!opts?.modelId && opts.modelId.startsWith('adv-');
        obj.userData.directorMeta = {
          source: advanced ? 'advanced' : 'model',
          url,
          isFbx: !!opts?.isFbx,
          ext: opts?.ext,
          modelId: opts?.modelId,
        } satisfies DirectorModelMeta;
        storeRestPose(obj);
        s.modelsGroup.add(obj);
        selectObject(s, obj);
        emitObjects();
        recordAdd(s, obj);
      },
      addCrowd(opts) {
        const s = stateRef.current;
        if (!s) return;
        const obj = buildCrowdLayout(opts);
        obj.userData.directorMeta = {
          source: 'crowd',
          crowd: opts,
        } satisfies DirectorModelMeta;
        // Ground the layout (min.y → 0); crowd figures are not auto-scaled.
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        if (Number.isFinite(box.min.y)) obj.position.y += -box.min.y;
        obj.userData.name = obj.name;
        storeRestPose(obj);
        s.modelsGroup.add(obj);
        selectObject(s, obj);
        emitObjects();
        recordAdd(s, obj);
      },
      removeSelected() {
        deleteSelectedImpl();
      },
      clearModels() {
        const s = stateRef.current;
        if (!s) return;
        for (const t of [...s.anims.keys()]) stopAnimFor(t);
        dissolveMulti(s);
        clearSkeletonHelper(s);
        s.posingBone = null;
        s.transform.detach();
        for (const c of [...s.modelsGroup.children]) {
          s.modelsGroup.remove(c);
          disposeObject(c);
        }
        s.selected = null;
        clearHistory(s);
        onSelRef.current?.(null);
        emitObjects();
      },
      listObjects() {
        const s = stateRef.current;
        if (!s) return [];
        return s.modelsGroup.children.map((c) => ({
          uuid: c.uuid,
          name: (c.userData?.name as string) ?? c.name ?? '模型',
          selected: c === s.selected,
        }));
      },
      selectByUuid(uuid) {
        const s = stateRef.current;
        if (!s) return;
        const obj = s.modelsGroup.children.find((c) => c.uuid === uuid);
        if (obj) {
          selectObject(s, obj);
          emitObjects();
        }
      },
      setTransformMode(mode) {
        stateRef.current?.transform.setMode(mode);
      },
      undo() {
        doUndo();
      },
      redo() {
        doRedo();
      },
      duplicateSelected() {
        duplicateSelectedImpl();
      },
      focusSelected() {
        focusSelectedImpl();
      },
      deselect() {
        deselectAll();
      },
      setBoxSelect(on) {
        setMarqueeImpl(on);
      },
      setLensFov(fov) {
        const s = stateRef.current;
        if (!s) return;
        s.camera.fov = fov;
        s.camera.updateProjectionMatrix();
      },
      setDistance(d) {
        const s = stateRef.current;
        if (!s) return;
        const dir = new THREE.Vector3()
          .subVectors(s.camera.position, s.orbit.target)
          .normalize();
        s.camera.position.copy(s.orbit.target).addScaledVector(dir, d);
        s.orbit.update();
      },
      setKeyLight(p) {
        const s = stateRef.current;
        if (!s) return;
        if (p.intensity != null) s.keyLight.intensity = p.intensity;
        if (p.azimuthDeg != null) s.keyAz = p.azimuthDeg;
        if (p.elevationDeg != null) s.keyEl = p.elevationDeg;
        if (p.color) s.keyLight.color.set(p.color);
        positionKeyLight(s);
      },
      setAmbient(p) {
        const s = stateRef.current;
        if (!s) return;
        if (p.intensity != null) s.ambient.intensity = p.intensity;
        if (p.color) {
          s.ambient.color.set(p.color);
          s.ambient.groundColor.set(p.color);
        }
      },
      setLightFx(p) {
        const s = stateRef.current;
        if (!s) return;
        applyLightFx(s, p);
      },
      getLightFx() {
        const s = stateRef.current;
        return s ? { ...s.fxState } : { ...LIGHTFX_DEFAULTS };
      },
      setSelectedTransform(t) {
        const s = stateRef.current;
        if (!s || !s.selected) return;
        const o = s.selected;
        if (t.position) o.position.set(...t.position);
        if (t.rotationDeg)
          o.rotation.set(
            THREE.MathUtils.degToRad(t.rotationDeg[0]),
            THREE.MathUtils.degToRad(t.rotationDeg[1]),
            THREE.MathUtils.degToRad(t.rotationDeg[2]),
          );
        if (t.scale) o.scale.set(...t.scale);
      },
      toggleGrid(visible) {
        const s = stateRef.current;
        if (s) s.grid.mesh.visible = visible;
      },
      setPanorama(url) {
        const s = stateRef.current;
        if (s) applyPanorama(s, url);
      },
      mirror() {
        const s = stateRef.current;
        if (s) s.modelsGroup.scale.x *= -1;
      },
      reset() {
        const s = stateRef.current;
        if (!s) return;
        const d = ENTRY_DEFAULTS[entry];
        s.camera.fov = d.fov;
        s.camera.updateProjectionMatrix();
        placeCameraOrbit(s.camera, s.orbit, d.distance);
      },
      hasSkeleton() {
        const s = stateRef.current;
        return !!(s?.selected && collectBones(s.selected).length > 0);
      },
      getBones() {
        const s = stateRef.current;
        if (!s || !s.selected) return [];
        return collectBones(s.selected).map((b) => ({
          uuid: b.uuid,
          name: b.name || '(bone)',
          depth: boneDepth(b),
        }));
      },
      showSkeleton(visible) {
        const s = stateRef.current;
        if (!s) return;
        clearSkeletonHelper(s);
        if (visible && s.selected) {
          const helper = new THREE.SkeletonHelper(s.selected);
          (helper.material as THREE.LineBasicMaterial).linewidth = 2;
          s.scene.add(helper);
          s.skeletonHelper = helper;
          buildJointHandles(s);
        }
      },
      setBonePick(on) {
        const s = stateRef.current;
        if (!s) return;
        s.bonePick = on;
        if (!on && s.joints) {
          s.joints.hover = -1;
          refreshJointColors(s);
          s.renderer.domElement.title = '';
          s.renderer.domElement.style.cursor = '';
        }
      },
      poseBone(uuid) {
        const s = stateRef.current;
        if (!s || !s.selected) return;
        // 摆骨骼与 mixer 冲突:目标正在播动画则先停(恢复播放前姿势)。
        if (uuid && s.anims.has(s.selected)) stopAnimFor(s.selected);
        s.transform.detach();
        if (!uuid) {
          // back to whole-model translate
          s.posingBone = null;
          s.transform.attach(s.selected);
          s.transform.setMode('translate');
          refreshJointColors(s);
          return;
        }
        let bone = collectBones(s.selected).find((b) => b.uuid === uuid);
        if (!bone) return;
        // Redirect to the real (non-nested) bone so the gizmo never drives a
        // nested duplicate (which would double-rotate the visible mesh).
        while (
          bone.parent &&
          (bone.parent as THREE.Bone).isBone &&
          bone.parent.name === bone.name
        ) {
          bone = bone.parent as THREE.Bone;
        }
        s.posingBone = bone;
        s.transform.attach(bone);
        s.transform.setMode('rotate');
        refreshJointColors(s);
      },
      resetPose() {
        const s = stateRef.current;
        if (!s || !s.selected) return;
        if (s.anims.has(s.selected)) stopAnimFor(s.selected);
        const obj = s.selected;
        const before = capturePose(obj);
        applyPoseToObject(obj, null);
        commitPoseHistory(s, obj, before);
        onSelRef.current?.(selectionInfo(obj));
      },
      applyPose(map) {
        const s = stateRef.current;
        if (!s || !s.selected) return;
        if (s.anims.has(s.selected)) stopAnimFor(s.selected);
        const obj = s.selected;
        const before = capturePose(obj);
        // Reset-to-rest then rotation-only, primary bones only (nested duplicate
        // Joints bones inherit the pose — posing them shatters the rig).
        applyPoseToObject(obj, map);
        commitPoseHistory(s, obj, before);
        onSelRef.current?.(selectionInfo(obj));
      },
      setBoneDelta(boneName, deg) {
        const s = stateRef.current;
        if (!s || !s.selected) return;
        if (s.anims.has(s.selected)) stopAnimFor(s.selected);
        const key = normBone(boneName);
        // Only drive the real (non-nested) bone — the nested duplicate inherits
        // it. Driving the nested twin too would double-rotate it (see
        // applyPoseToObject for the full topology explanation).
        const targets = collectSkeletonBones(s.selected).filter(
          (b) => normBone(b.name) === key && !hasSameNamedBoneAncestor(b),
        );
        if (!targets.length) return;
        const e = new THREE.Euler(
          THREE.MathUtils.degToRad(deg[0]),
          THREE.MathUtils.degToRad(deg[1]),
          THREE.MathUtils.degToRad(deg[2]),
          'XYZ',
        );
        const dq = new THREE.Quaternion().setFromEuler(e);
        for (const bone of targets) {
          const base =
            (bone.userData?._poseBase as THREE.Quaternion | undefined) ??
            (bone.userData?._restQuat as THREE.Quaternion | undefined);
          if (!base) continue;
          bone.quaternion.copy(base).multiply(dq);
        }
        updateSkeletons(s.selected);
      },
      isAdvancedMannequin() {
        const s = stateRef.current;
        return !!s?.selected?.userData?.isFbxBot;
      },
      async playAnimation(url, name = '', ext, assetId) {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) return;
        const clip = await loadClipForTarget(target, url, ext);
        if (stateRef.current?.selected !== target) return; // 加载期间选择已变,丢弃
        startClipOnTarget(target, clip, url, name, { ext, assetId });
      },
      pauseAnimation() {
        const s = stateRef.current;
        const a = s?.selected ? s.anims.get(s.selected) : undefined;
        if (!a) return;
        a.action.paused = true;
        emitAnimTick();
      },
      resumeAnimation() {
        const s = stateRef.current;
        const a = s?.selected ? s.anims.get(s.selected) : undefined;
        if (!a) return;
        a.action.paused = false;
        emitAnimTick();
      },
      stopAnimation() {
        const s = stateRef.current;
        if (s?.selected) stopAnimFor(s.selected);
      },
      seekAnimation(sec) {
        const s = stateRef.current;
        const a = s?.selected ? s.anims.get(s.selected) : undefined;
        if (!a) return;
        a.action.time = THREE.MathUtils.clamp(sec, 0, a.duration);
        a.mixer.update(0);
        emitAnimTick();
      },
      capturePoseKeyframe() {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) return null;
        // 只记真实骨骼(嵌套孪生继承父级;驱动它会双重旋转,见 applyPoseToObject)。
        const bones: Record<string, [number, number, number, number]> = {};
        // 根骨骼(父级不是骨骼,通常 Hips)另记位置:与采样自动画的帧混编时,
        // 位置轨才不会在手工帧处断档(角色移动数据完整保留)。
        const bonePos: Record<string, [number, number, number]> = {};
        for (const b of collectSkeletonBones(target)) {
          if (hasSameNamedBoneAncestor(b)) continue;
          const q = b.quaternion;
          bones[b.name] = [q.x, q.y, q.z, q.w];
          if (!(b.parent as THREE.Bone | null)?.isBone) {
            bonePos[b.name] = [b.position.x, b.position.y, b.position.z];
          }
        }
        return {
          bones,
          ...(Object.keys(bonePos).length > 0 ? { bonePos } : {}),
          rootPos: [target.position.x, target.position.y, target.position.z],
        };
      },
      applyPoseKeyframe(k) {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) return;
        // scrub 单帧预览与 mixer 冲突:目标在播则先停(恢复播放前姿势后再套帧)。
        if (s.anims.has(target)) stopAnimFor(target);
        for (const b of collectSkeletonBones(target)) {
          if (hasSameNamedBoneAncestor(b)) continue;
          const q = k.bones[b.name];
          if (!q) continue;
          b.quaternion.set(q[0], q[1], q[2], q[3]);
          b.userData._poseBase = b.quaternion.clone();
          const p = k.bonePos?.[b.name];
          if (p) b.position.set(p[0], p[1], p[2]);
        }
        updateSkeletons(target);
        target.position.set(k.rootPos[0], k.rootPos[1], k.rootPos[2]);
      },
      async playPoseClip(keys, duration, name = 'K动画') {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot || keys.length === 0) return;
        const clip = buildPoseClip(keys, duration, name);
        // 合成键不进 loadAnimClip 缓存;每次编译都是新剪辑。
        startClipOnTarget(target, clip, `authored:${THREE.MathUtils.generateUUID()}`, name);
      },
      async exportPoseClipGlb(keys, duration, name = 'K动画') {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) {
          throw new Error('请先选中一个高级假人');
        }
        if (keys.length === 0) throw new Error('没有关键帧');
        const clip = buildPoseClip(keys, duration, name);
        // GLTFExporter 按需加载(不进主包);导出原对象(SkinnedMesh 深拷贝骨骼绑定
        // 复杂且无必要),导出期间不改场景。
        const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
        const exporter = new GLTFExporter();
        const buf = (await exporter.parseAsync(target, {
          binary: true,
          animations: [clip],
        })) as ArrayBuffer;
        return new Blob([buf], { type: 'model/gltf-binary' });
      },
      // maxKeys 上限 600(不是 20!):采样率固定 4 帧/秒,长剪辑(MMD 舞蹈动辄
      // 90s+)被压到 20 帧会把所有快动作抹平成慢漂移 —— 用户直观感受是
      // 「拖到时间轴后动画变慢了」。600 帧覆盖 150s@4Hz,再长才开始降密。
      async sampleAnimToPoseKeys(url, ext, maxKeys = 600) {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) {
          throw new Error('请先选中一个高级假人');
        }
        const clip = retargetClipTracks(await loadClipForTarget(target, url, ext), target);
        // 采样不留痕:先停在播动画(其停止逻辑自带姿势恢复),再快照当前姿势,
        // 采完 restorePose 原样放回。
        if (s.anims.has(target)) stopAnimFor(target);
        const snap = capturePose(target);
        const dur = Math.max(0.1, clip.duration);
        const n = Math.min(Math.max(2, maxKeys), Math.max(2, Math.ceil(dur * 4) + 1));
        // 位移数据在 position 轨上(Mixamo 挂 Hips.position;行走/跳跃全靠它)。
        // VMD 轨道名形如 `.bones[センター].position`,剥壳取真实骨名。
        const posTrackBones = new Set<string>();
        for (const tr of clip.tracks) {
          if (tr.name.endsWith('.position')) {
            let node = tr.name.slice(0, -'.position'.length);
            const m = /^\.bones\[(.+)\]$/.exec(node);
            if (m) node = m[1];
            if (node) posTrackBones.add(node);
          }
        }
        const mixerRoot =
          (target.userData?.mmdMesh as THREE.SkinnedMesh | undefined) ?? target;
        const mixer = new THREE.AnimationMixer(mixerRoot);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        const keys: PoseKeyframe[] = [];
        for (let i = 0; i < n; i++) {
          const t = (dur * i) / (n - 1);
          // 末帧收 epsilon:LoopOnce 在 t == duration 处 action 已 finished。
          mixer.setTime(Math.min(t, dur - 1e-4));
          // MMD 刻意**不**在采样时跑 IK/Grant(采 FK 原始值):回放走与直接播
          // VMD 完全相同的通路 —— mixer 写 FK + RAF 每帧活算 IK/Grant。若在
          // 这里烘焙求解结果,回放时求解器会在烘焙值上再算一遍(Grant 叠乘
          // 双倍旋转、IK 二次求解),正是脚踝扭曲/部件穿模的来源。
          const bones: Record<string, [number, number, number, number]> = {};
          const bonePos: Record<string, [number, number, number]> = {};
          for (const b of collectSkeletonBones(target)) {
            if (hasSameNamedBoneAncestor(b)) continue;
            bones[b.name] = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
            if (posTrackBones.has(b.name)) {
              bonePos[b.name] = [b.position.x, b.position.y, b.position.z];
            }
          }
          keys.push({
            id: newKeyframeId(),
            t,
            bones,
            ...(Object.keys(bonePos).length > 0 ? { bonePos } : {}),
            rootPos: [target.position.x, target.position.y, target.position.z],
          });
        }
        mixer.stopAllAction();
        mixer.uncacheRoot(mixerRoot);
        restorePose(snap);
        updateSkeletons(target);
        return keys;
      },
      capture(height) {
        const s = stateRef.current;
        if (!s) return '';
        return renderAtResolution(s, () => undefined, height);
      },
      captureAspect(ratio, short) {
        const s = stateRef.current;
        if (!s) return '';
        if (ratio == null) return renderAtResolution(s, () => undefined, short);
        return renderAspectCrop(s, ratio, short ?? 1080);
      },
      captureMultiView(count, height) {
        const s = stateRef.current;
        if (!s) return [];
        const angles = MULTI_VIEW_ANGLES[count] as readonly number[];
        const target = s.orbit.target.clone();
        const radius = s.camera.position.distanceTo(target);
        const y = s.camera.position.y;
        const saved = s.camera.position.clone();
        const shots: string[] = [];
        for (const deg of angles) {
          const a = THREE.MathUtils.degToRad(deg);
          shots.push(
            renderAtResolution(
              s,
              () => {
                s.camera.position.set(
                  target.x + radius * Math.sin(a),
                  y,
                  target.z + radius * Math.cos(a),
                );
                s.camera.lookAt(target);
              },
              height,
            ),
          );
        }
        s.camera.position.copy(saved);
        s.camera.lookAt(target);
        s.orbit.update();
        return shots;
      },
      addCameraSlot(name) {
        const s = stateRef.current;
        const empty: CameraSlot = { id: '', name: '', position: [0, 0, 0], quaternion: [0, 0, 0, 1], target: [0, 0, 0], fov: 0, showRay: false };
        if (!s) return empty;
        const slot: CameraSlot = {
          id: newSlotId(),
          name: name || `机位${s.cameraSlots.length + 1}`,
          position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
          quaternion: [
            s.camera.quaternion.x,
            s.camera.quaternion.y,
            s.camera.quaternion.z,
            s.camera.quaternion.w,
          ],
          target: [s.orbit.target.x, s.orbit.target.y, s.orbit.target.z],
          fov: s.camera.fov,
          showRay: false,
        };
        s.cameraSlots.push(slot);
        syncSlotRays(s);
        return { ...slot };
      },
      applyCameraSlot(id) {
        const s = stateRef.current;
        if (!s) return;
        const slot = s.cameraSlots.find((x) => x.id === id);
        if (!slot) return;
        s.camera.position.set(...slot.position);
        s.camera.quaternion.set(...slot.quaternion);
        s.orbit.target.set(...slot.target);
        if (Math.abs(slot.fov - s.camera.fov) > 0.001) s.camera.fov = slot.fov;
        s.camera.updateProjectionMatrix();
        s.orbit.update();
      },
      removeCameraSlot(id) {
        const s = stateRef.current;
        if (!s) return;
        const i = s.cameraSlots.findIndex((x) => x.id === id);
        if (i !== -1) s.cameraSlots.splice(i, 1);
        // 该机位的镜头轨道与切换点一并清理;正在编辑它 → 回自由视角轨。
        if (s.activeTrack === id) setActiveTrackState(s, 'free');
        s.tracksStore.delete(id);
        s.cuts = s.cuts.filter((c) => c.slotId !== id);
        syncSlotRays(s);
      },
      duplicateCameraSlot(id) {
        const s = stateRef.current;
        if (!s) return null;
        const src = s.cameraSlots.find((x) => x.id === id);
        if (!src) return null;
        const copy: CameraSlot = {
          ...src,
          id: newSlotId(),
          name: `${src.name} 副本`,
          position: [...src.position],
          quaternion: [...src.quaternion],
          target: [...src.target],
        };
        s.cameraSlots.push(copy);
        syncSlotRays(s);
        return { ...copy };
      },
      updateCameraSlot(id, patch) {
        const s = stateRef.current;
        if (!s) return;
        const slot = s.cameraSlots.find((x) => x.id === id);
        if (!slot) return;
        if (patch.name !== undefined) slot.name = patch.name;
        if (patch.fov !== undefined) slot.fov = patch.fov;
        if (patch.showRay !== undefined) slot.showRay = patch.showRay;
        if (patch.target) slot.target = [...patch.target];
        if (patch.position) {
          slot.position = [...patch.position];
          // Re-aim quaternion at the (possibly new) target so the saved
          // orientation matches what a camera at this position would see.
          recomputeSlotQuat(slot);
        } else if (patch.target) {
          recomputeSlotQuat(slot);
        }
        syncSlotRays(s);
      },
      listCameraSlots() {
        return stateRef.current?.cameraSlots.map((x) => ({ ...x })) ?? [];
      },
      getFov() {
        return stateRef.current?.camera.fov ?? 0;
      },
      renderSlotPreview(id, canvas) {
        const s = stateRef.current;
        if (!s) return;
        const slot = id ? s.cameraSlots.find((x) => x.id === id) ?? null : null;
        renderPreview(s, slot, canvas);
      },
      // ── 录制视频:关键帧运镜 ─────────────────────────────────
      recordEnter() {
        const s = stateRef.current;
        if (s) s.recording = true;
      },
      recordExit() {
        const s = stateRef.current;
        if (!s) return;
        s.recording = false;
        s.recordPlaying = false;
        // 播放/拖游标期间机位模型沿镜头轨飞过(Blender 式);退出录制
        // 模式时全部归位到机位原位。
        syncCamGizmos(s);
      },
      recordAddKeyframe(t) {
        const s = stateRef.current;
        const empty: CameraKeyframe = { id: '', t, position: [0, 0, 0], quaternion: [0, 0, 0, 1], fov: 40 };
        if (!s) return empty;
        const kf: CameraKeyframe = {
          id: newSlotId(),
          t,
          position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
          quaternion: [s.camera.quaternion.x, s.camera.quaternion.y, s.camera.quaternion.z, s.camera.quaternion.w],
          fov: s.camera.fov,
          // 机位轨道上 K 的镜头自动打机位标(时间轴按机位配色展示)。
          ...(s.activeTrack !== 'free' ? { slotId: s.activeTrack } : null),
        };
        // Replace any keyframe at (almost) the same time, else insert sorted.
        const near = s.keyframes.findIndex((k) => Math.abs(k.t - t) < 0.04);
        if (near !== -1) s.keyframes[near] = kf;
        else s.keyframes.push(kf);
        s.keyframes.sort((a, b) => a.t - b.t);
        return { ...kf };
      },
      recordAddKeyframeFromSlot(slotId, t) {
        const s = stateRef.current;
        if (!s) return null;
        const slot = s.cameraSlots.find((x) => x.id === slotId);
        if (!slot) return null;
        const kf: CameraKeyframe = {
          id: newSlotId(),
          t,
          position: [...slot.position],
          quaternion: [...slot.quaternion],
          fov: slot.fov,
          slotId,
        };
        const near = s.keyframes.findIndex((k) => Math.abs(k.t - t) < 0.04);
        if (near !== -1) s.keyframes[near] = kf;
        else s.keyframes.push(kf);
        s.keyframes.sort((a, b) => a.t - b.t);
        return { ...kf };
      },
      recordListKeyframes() {
        return stateRef.current?.keyframes.map((k) => ({ ...k })) ?? [];
      },
      recordRemoveKeyframe(id) {
        const s = stateRef.current;
        if (!s) return;
        const i = s.keyframes.findIndex((k) => k.id === id);
        if (i !== -1) s.keyframes.splice(i, 1);
      },
      recordRemoveKeyframes(ids) {
        const s = stateRef.current;
        if (!s || ids.length === 0) return;
        const drop = new Set(ids);
        s.keyframes = s.keyframes.filter((k) => !drop.has(k.id));
      },
      recordUpdateKeyframe(id) {
        const s = stateRef.current;
        if (!s) return;
        const kf = s.keyframes.find((k) => k.id === id);
        if (!kf) return;
        kf.position = [s.camera.position.x, s.camera.position.y, s.camera.position.z];
        kf.quaternion = [
          s.camera.quaternion.x,
          s.camera.quaternion.y,
          s.camera.quaternion.z,
          s.camera.quaternion.w,
        ];
        kf.fov = s.camera.fov;
      },
      recordMoveKeyframes(ids, deltaT, maxT) {
        const s = stateRef.current;
        if (!s || ids.length === 0 || !Number.isFinite(deltaT)) return 0;
        const move = new Set(ids);
        const picked = s.keyframes.filter((k) => move.has(k.id));
        if (picked.length === 0) return 0;
        // 整组夹取:保持组内间距,不让任何一帧越出 [0, maxT]。
        let lo = Infinity;
        let hi = -Infinity;
        for (const k of picked) {
          lo = Math.min(lo, k.t);
          hi = Math.max(hi, k.t);
        }
        let d = deltaT;
        if (lo + d < 0) d = -lo;
        if (maxT != null && hi + d > maxT) d = maxT - hi;
        if (d === 0) return 0;
        for (const k of picked) k.t = Math.round((k.t + d) * 1000) / 1000;
        s.keyframes.sort((a, b) => a.t - b.t);
        return d;
      },
      recordClearKeyframes() {
        const s = stateRef.current;
        if (s) s.keyframes = [];
      },
      recordLoadKeyframes(keys, mode = 'replace', atSec, anchorTo) {
        const s = stateRef.current;
        if (!s || keys.length === 0) return s?.keyframes.map((k) => ({ ...k })) ?? [];
        const startAt =
          atSec != null
            ? Math.max(0, atSec)
            : mode === 'append' && s.keyframes.length
              ? s.keyframes[s.keyframes.length - 1].t + 1
              : 0;
        // 镜头起始位置约束:把镜头文件首帧刚体对齐到锚点(当前相机 / 某机位),
        // 后续帧保持相对运动(导入的绝对世界坐标 → 从用户摆好的位置开播)。
        const anchorSlot =
          anchorTo && typeof anchorTo === 'object'
            ? s.cameraSlots.find((x) => x.id === anchorTo.slotId) ?? null
            : null;
        let src: readonly CameraKeyframe[] = keys;
        if (anchorSlot) {
          src = retargetCameraKeysToPose(keys, {
            position: [...anchorSlot.position],
            quaternion: [...anchorSlot.quaternion],
          }).map((k) => ({ ...k, slotId: anchorSlot.id })); // 机位轨道打标
        } else if (anchorTo === true) {
          src = retargetCameraKeysToPose(keys, {
            position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
            quaternion: [
              s.camera.quaternion.x,
              s.camera.quaternion.y,
              s.camera.quaternion.z,
              s.camera.quaternion.w,
            ],
          });
        }
        const loaded = normalizeCameraKeys(src, startAt);
        if (mode === 'replace' && atSec == null) {
          s.keyframes = loaded;
        } else {
          // 并入:落点区间内的旧关键帧让位(±0.04s 同 recordAddKeyframe 的容差)。
          const t0 = loaded[0].t;
          const t1 = loaded[loaded.length - 1].t;
          s.keyframes = [
            ...s.keyframes.filter((k) => k.t < t0 - 0.04 || k.t > t1 + 0.04),
            ...loaded,
          ];
        }
        s.keyframes.sort((a, b) => a.t - b.t);
        return s.keyframes.map((k) => ({ ...k }));
      },
      getCameraPose() {
        const s = stateRef.current;
        if (!s) return { position: [0, 2, 6], target: [0, 1, 0], fov: 40 };
        return {
          position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
          target: [s.orbit.target.x, s.orbit.target.y, s.orbit.target.z],
          fov: s.camera.fov,
        };
      },
      async importCameraClip(url, ext) {
        const kind = (ext ?? extFromUrl(url) ?? 'json').toLowerCase();
        if (kind === 'json') {
          const text = await fetch(url).then((r) => r.text());
          return parseCameraClipJson(text);
        }
        if (kind === 'vmd') {
          // MMD / 恋活社区相机文件(BowlRoll 等):二进制直接解析,无需 loader。
          const buf = await fetch(url).then((r) => r.arrayBuffer());
          return parseVmdCameraBuffer(buf);
        }
        // glb/gltf/fbx:加载整个场景图 → 找相机 → 世界位姿烘焙采样。
        let root: THREE.Object3D;
        let clips: THREE.AnimationClip[];
        let gltfCam: THREE.Object3D | null = null;
        if (kind === 'glb' || kind === 'gltf') {
          const gltf = await gltfLoader.loadAsync(url);
          root = gltf.scene;
          clips = gltf.animations ?? [];
          gltfCam = gltf.cameras?.[0] ?? null;
        } else {
          const group = await fbxLoader.loadAsync(url);
          root = group;
          clips = group.animations ?? [];
        }
        const clip = clips[0];
        if (!clip) throw new Error('镜头文件里没有动画剪辑');
        const cam = gltfCam ?? findClipCamera(root);
        if (!cam) throw new Error('镜头文件里没有相机节点');
        const keys = sampleObjectClip(root, clip, cam);
        if (keys.length === 0) throw new Error('镜头动画采样失败(无有效轨道)');
        return { name: clip.name || '导入镜头', keys };
      },
      recordSetActiveTrack(id) {
        const s = stateRef.current;
        if (s) setActiveTrackState(s, id);
      },
      recordGetActiveTrack() {
        return stateRef.current?.activeTrack ?? 'free';
      },
      recordListCuts() {
        return stateRef.current?.cuts.map((c) => ({ ...c })) ?? [];
      },
      recordAddCut(t, slotId) {
        const s = stateRef.current;
        if (!s || !s.cameraSlots.some((x) => x.id === slotId)) return;
        const near = s.cuts.findIndex((c) => Math.abs(c.t - t) < 0.04);
        if (near !== -1) s.cuts[near] = { t, slotId };
        else s.cuts.push({ t, slotId });
        s.cuts.sort((a, b) => a.t - b.t);
      },
      recordRemoveCut(t) {
        const s = stateRef.current;
        if (!s) return;
        const i = s.cuts.findIndex((c) => Math.abs(c.t - t) < 0.04);
        if (i !== -1) s.cuts.splice(i, 1);
      },
      recordMoveCut(oldT, newT) {
        const s = stateRef.current;
        if (!s) return;
        const cut = s.cuts.find((c) => Math.abs(c.t - oldT) < 0.04);
        if (!cut) return;
        cut.t = Math.max(0, newT);
        s.cuts.sort((a, b) => a.t - b.t);
      },
      recordFlattenedKeyframes() {
        const s = stateRef.current;
        return s ? flattenCutsToKeys(s) : [];
      },
      recordTimelineExtent() {
        const s = stateRef.current;
        if (!s) return 0;
        let ext = s.keyframes.length ? s.keyframes[s.keyframes.length - 1].t : 0;
        for (const ks of s.tracksStore.values()) {
          if (ks.length) ext = Math.max(ext, ks[ks.length - 1].t);
        }
        if (s.cuts.length) ext = Math.max(ext, s.cuts[s.cuts.length - 1].t);
        return ext;
      },
      recordSeek(t) {
        const s = stateRef.current;
        if (!s) return;
        // 任一轨有关键帧或有切换点即可 seek(即使激活轨是空的自由轨,
        // 机位缩略图与机位模型也要跟着游标走)。
        const hasAny =
          s.keyframes.length > 0 ||
          s.cuts.length > 0 ||
          [...s.tracksStore.values()].some((ks) => ks.length > 0);
        if (!hasAny) return;
        applyInterpolatedCamera(s, t);
      },
      recordPlay(startSec, endSec, onTime, onDone, loop = false) {
        const s = stateRef.current;
        if (!s || (s.keyframes.length === 0 && s.cuts.length === 0)) {
          onDone();
          return () => {};
        }
        // 只播 [startSec, endSec] 区间(通常 = 首帧→末帧),不再从 0 播到
        // 固定时长 —— 避免预览无关键帧的空白片段。
        // loop=true:到末尾取模回起点循环(K 动画预览同款),由 stop 结束。
        s.recordPlaying = true;
        const start = performance.now();
        const spanSec = Math.max(0.1, endSec - startSec);
        const durMs = spanSec * 1000;
        const step = () => {
          if (!s.recordPlaying) return;
          const elapsed = performance.now() - start;
          const t = loop
            ? startSec + ((elapsed / 1000) % spanSec)
            : startSec + Math.min(spanSec, elapsed / 1000);
          applyInterpolatedCamera(s, t);
          onTime(t);
          if (!loop && elapsed >= durMs) {
            s.recordPlaying = false;
            onDone();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        return () => {
          s.recordPlaying = false;
        };
      },
      recordExport(opts) {
        const s = stateRef.current;
        if (!s) return Promise.reject(new Error('scene not ready'));
        if (s.keyframes.length < 1 && s.cuts.length === 0) {
          return Promise.reject(new Error('请先添加关键帧或机位切换点'));
        }
        return recordKeyframeAnimation(s, opts);
      },
      recordVideo(opts) {
        const s = stateRef.current;
        if (!s) return Promise.reject(new Error('scene not ready'));
        return recordCanvas(s, opts);
      },
      isRecording() {
        return !!stateRef.current?.recording;
      },
      serializeScene() {
        const s = stateRef.current;
        const empty: DirectorSceneData = {
          version: 1,
          models: [],
          cameraSlots: [],
          camera: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], target: [0, 0, 0], fov: 50 },
          light: {
            keyIntensity: LIGHT_DEFAULTS.key.intensity,
            keyColor: LIGHT_DEFAULTS.key.color,
            keyAzimuthDeg: LIGHT_DEFAULTS.key.azimuthDeg,
            keyElevationDeg: LIGHT_DEFAULTS.key.elevationDeg,
            ambientIntensity: LIGHT_DEFAULTS.ambient.intensity,
            ambientColor: LIGHT_DEFAULTS.ambient.color,
          },
        };
        if (!s) return empty;
        const models: DirectorModelState[] = s.modelsGroup.children.map((o) => {
          const meta = (o.userData?.directorMeta ?? { source: 'model' }) as DirectorModelMeta;
          const state: DirectorModelState = {
            ...meta,
            name: (o.userData?.name as string) ?? o.name ?? '模型',
            position: [o.position.x, o.position.y, o.position.z],
            rotationDeg: [
              THREE.MathUtils.radToDeg(o.rotation.x),
              THREE.MathUtils.radToDeg(o.rotation.y),
              THREE.MathUtils.radToDeg(o.rotation.z),
            ],
            scale: [o.scale.x, o.scale.y, o.scale.z],
          };
          const pose = serializeBonePose(o);
          if (pose) state.bonePose = pose;
          // 运动状态:该假人上已应用的动画(时间轴预览的 authored/objectURL 剪辑
          // 只有拿到资产 id 才能跨会话还原,否则跳过)。
          const anim = s.anims.get(o);
          if (anim && (anim.assetId || /^https?:/i.test(anim.url))) {
            state.anim = {
              name: anim.name,
              url: anim.assetId ? undefined : anim.url,
              ext: anim.ext,
              assetId: anim.assetId,
              time: anim.action.time,
              playing: !anim.action.paused,
            };
          }
          return state;
        });
        return {
          version: 1,
          models,
          cameraSlots: s.cameraSlots.map((c) => ({
            ...c,
            position: [...c.position] as [number, number, number],
            quaternion: [...c.quaternion] as [number, number, number, number],
            target: [...c.target] as [number, number, number],
          })),
          camera: {
            position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
            quaternion: [
              s.camera.quaternion.x,
              s.camera.quaternion.y,
              s.camera.quaternion.z,
              s.camera.quaternion.w,
            ],
            target: [s.orbit.target.x, s.orbit.target.y, s.orbit.target.z],
            fov: s.camera.fov,
          },
          light: {
            keyIntensity: s.keyLight.intensity,
            keyColor: `#${s.keyLight.color.getHexString()}`,
            keyAzimuthDeg: s.keyAz,
            keyElevationDeg: s.keyEl,
            ambientIntensity: s.ambient.intensity,
            ambientColor: `#${s.ambient.color.getHexString()}`,
          },
          fx: { ...s.fxState },
          ...serializeCameraTracks(s),
        };
      },
      async restoreScene(data, resolveUrl) {
        const s = stateRef.current;
        if (!s || !data || data.version !== 1) return;
        // 1) clear existing models (旧模型的 mixer 一并停掉,防止残留更新).
        for (const a of s.anims.values()) a.mixer.stopAllAction();
        s.anims.clear();
        dissolveMulti(s);
        clearSkeletonHelper(s);
        s.posingBone = null;
        s.transform.detach();
        for (const c of [...s.modelsGroup.children]) {
          s.modelsGroup.remove(c);
          disposeObject(c);
        }
        s.selected = null;
        clearHistory(s);
        // 2) recreate each model with its saved transform + pose.
        const pendingAnims: { obj: THREE.Object3D; anim: SavedAnimState }[] = [];
        for (const m of data.models || []) {
          try {
            let obj: THREE.Object3D | null = null;
            if (m.source === 'crowd' && m.crowd) {
              obj = buildCrowdLayout(m.crowd);
            } else {
              // model / advanced — resolve an imported asset id to a fresh URL.
              let url = m.url ?? '';
              if (m.modelId && resolveUrl) {
                const resolved = await resolveUrl(m.modelId).catch(() => null);
                if (resolved) url = resolved;
              }
              if (!url) continue;
              obj = await loadModel(url, !!m.isFbx, m.ext);
              if (!stateRef.current) return; // unmounted mid-load
              if (!obj.userData.mmdMesh) resetSkeletonsToBind(obj);
            }
            if (!obj) continue;
            obj.userData.modelId = m.modelId;
            obj.userData.name = m.name;
            obj.userData.directorMeta = {
              source: m.source,
              url: m.url,
              isFbx: m.isFbx,
              ext: m.ext,
              modelId: m.modelId,
              crowd: m.crowd,
            } satisfies DirectorModelMeta;
            storeRestPose(obj);
            // Apply the exact saved transform (skip auto-normalize/ground).
            obj.position.set(...m.position);
            obj.rotation.set(
              THREE.MathUtils.degToRad(m.rotationDeg[0]),
              THREE.MathUtils.degToRad(m.rotationDeg[1]),
              THREE.MathUtils.degToRad(m.rotationDeg[2]),
            );
            obj.scale.set(...m.scale);
            if (m.bonePose) {
              applyPoseToObject(obj, m.bonePose);
              // Pin the exact saved Y (authoritative over the foot-height keep).
              obj.position.y = m.position[1];
            }
            s.modelsGroup.add(obj);
            if (m.anim) pendingAnims.push({ obj, anim: m.anim });
          } catch {
            /* skip a model that fails to load (e.g. stale blob URL) */
          }
        }
        // 2b) 运动状态:还原每个假人保存时已应用的动画(播放头 + 播放/暂停态)。
        for (const { obj, anim } of pendingAnims) {
          try {
            let url = anim.url ?? '';
            if (anim.assetId && resolveUrl) {
              const resolved = await resolveUrl(anim.assetId).catch(() => null);
              if (resolved) url = resolved;
            }
            if (!url) continue;
            const clip = await loadClipForTarget(obj, url, anim.ext);
            if (!stateRef.current) return; // unmounted mid-load
            startClipOnTarget(obj, clip, url, anim.name, {
              ext: anim.ext,
              assetId: anim.assetId,
            });
            const active = s.anims.get(obj);
            if (active) {
              active.action.time = THREE.MathUtils.clamp(anim.time, 0, active.duration);
              active.action.paused = !anim.playing;
              active.mixer.update(0); // 立即套用该帧(暂停态也停在保存时的帧上)
            }
          } catch {
            /* 动画资源失效(如资产被删)→ 保留静态姿势即可 */
          }
        }
        // 3) lighting.
        if (data.light) {
          s.keyLight.intensity = data.light.keyIntensity;
          s.keyLight.color.set(data.light.keyColor);
          s.keyAz = data.light.keyAzimuthDeg;
          s.keyEl = data.light.keyElevationDeg;
          s.ambient.intensity = data.light.ambientIntensity;
          s.ambient.color.set(data.light.ambientColor);
          s.ambient.groundColor.set(data.light.ambientColor);
          positionKeyLight(s);
        }
        // 3b) 光感/调色后处理(旧工程无 fx → 还原为中性默认)。
        applyLightFx(s, { ...LIGHTFX_DEFAULTS, ...(data.fx ?? {}) });
        // 3c) 运镜时间轴:自由轨 + 各机位独立轨 + 切换点(旧工程无 = 清空)。
        s.activeTrack = 'free';
        s.tracksStore = new Map();
        s.keyframes = (data.recordKeyframes ?? []).map((k) => ({ ...k }));
        for (const [id, ks] of Object.entries(data.cameraTracks ?? {})) {
          s.tracksStore.set(id, ks.map((k) => ({ ...k })));
        }
        s.cuts = (data.cameraCuts ?? []).map((c) => ({ ...c })).sort((a, b) => a.t - b.t);
        // 4) camera 机位.
        s.cameraSlots = (data.cameraSlots || []).map((c) => ({
          ...c,
          position: [...c.position] as [number, number, number],
          quaternion: [...c.quaternion] as [number, number, number, number],
          target: [...c.target] as [number, number, number],
        }));
        syncSlotRays(s);
        // 5) live camera.
        if (data.camera) {
          s.camera.position.set(...data.camera.position);
          s.camera.quaternion.set(...data.camera.quaternion);
          s.orbit.target.set(...data.camera.target);
          if (Math.abs(data.camera.fov - s.camera.fov) > 1e-3) s.camera.fov = data.camera.fov;
          s.camera.updateProjectionMatrix();
          s.orbit.update();
        }
        onSelRef.current?.(null);
        emitObjects();
      },
    }),
    [entry],
  );

  // ── Scene setup / teardown ──────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    // 框选浮层用绝对定位贴在容器内,需要容器作为定位上下文。
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // required for toDataURL capture
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(SCENE.background, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SCENE.background);

    const d = ENTRY_DEFAULTS[entry];
    // Far plane 2000 + the 4000² shader grid are what make the space feel huge.
    const camera = new THREE.PerspectiveCamera(
      d.fov,
      width / height,
      SCENE.cameraNear,
      SCENE.cameraFar,
    );

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = SCENE.orbitDamping;
    orbit.minDistance = SCENE.orbitMinDistance;
    orbit.maxDistance = SCENE.orbitMaxDistance;
    // Spherical placement (azimuth 72°, elevation 40°) about (0, targetY, 0),
    // mirroring the live `_setCameraOrbit`.
    placeCameraOrbit(camera, orbit, d.distance);

    // 进入机位 = 锁定视角(Blender「Lock Camera to View」):录制模式下激活
    // 某机位轨道时,用户拖动主视角就是在挪这台机位——机位位姿实时跟随,
    // 模型/视锥同步刷新。只在真实交互(start→end)期间写回,避免 seek/播放
    // 驱动的相机移动污染机位。
    let orbitNavActive = false;
    orbit.addEventListener('start', () => {
      orbitNavActive = true;
    });
    orbit.addEventListener('end', () => {
      orbitNavActive = false;
    });
    orbit.addEventListener('change', () => {
      if (!orbitNavActive) return;
      const st = stateRef.current;
      if (!st || !st.recording || st.recordPlaying) return;
      const slot = st.cameraSlots.find((x) => x.id === st.activeTrack);
      if (!slot) return;
      slot.position = [st.camera.position.x, st.camera.position.y, st.camera.position.z];
      slot.quaternion = [
        st.camera.quaternion.x,
        st.camera.quaternion.y,
        st.camera.quaternion.z,
        st.camera.quaternion.w,
      ];
      slot.target = [st.orbit.target.x, st.orbit.target.y, st.orbit.target.z];
      slot.fov = st.camera.fov;
      syncSlotRays(st);
    });

    // Lights (ground truth §10.2)
    const keyLight = new THREE.DirectionalLight(
      new THREE.Color(LIGHT_DEFAULTS.key.color),
      LIGHT_DEFAULTS.key.intensity,
    );
    scene.add(keyLight);
    scene.add(keyLight.target);
    const ambient = new THREE.HemisphereLight(
      new THREE.Color(LIGHT_DEFAULTS.ambient.color),
      new THREE.Color(LIGHT_DEFAULTS.ambient.color),
      LIGHT_DEFAULTS.ambient.intensity,
    );
    scene.add(ambient);

    const grid = buildShaderGrid();
    grid.mesh.visible = d.background === 'grid';
    scene.add(grid.mesh);

    const modelsGroup = new THREE.Group();
    scene.add(modelsGroup);

    // Group holding per-slot camera→target alignment rays (相机射线).
    const rayGroup = new THREE.Group();
    rayGroup.name = '__cameraRays';
    scene.add(rayGroup);

    // Group holding per-slot camera-model gizmos(机位摄像机模型).
    const camGizmoGroup = new THREE.Group();
    camGizmoGroup.name = '__cameraGizmos';
    scene.add(camGizmoGroup);

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode('translate');
    transform.addEventListener('dragging-changed', (e) => {
      const dragging = e.value as boolean;
      orbit.enabled = !dragging;
      const st = stateRef.current;
      if (!st) return;
      // 机位摄像机模型:拖拽开始时快照镜头距离(缩放 = 推拉距离的基准),
      // 结束时清掉并把模型 scale 复位(模型本身不随手势变大)。
      const attObj = (transform as unknown as { object?: THREE.Object3D }).object;
      const attCamId = attObj?.userData?.cameraSlotId as string | undefined;
      if (attObj && attCamId) {
        if (dragging) {
          const slot = st.cameraSlots.find((x) => x.id === attCamId);
          if (slot) {
            _v0.set(...slot.position);
            _v1.set(...slot.target);
            st.camDragBaseDist = Math.max(_v0.distanceTo(_v1), 0.1);
          }
        } else {
          st.camDragBaseDist = null;
          attObj.scale.set(1, 1, 1);
        }
      }
      if (dragging) {
        // Snapshot affected objects so the move/rotate/scale is undoable.
        const objs =
          st.multi.length > 1 ? st.multi.slice() : st.selected ? [st.selected] : [];
        st.dragSnap = objs.length ? captureTransforms(objs) : null;
        // Multi: parent the objects under the pivot so the gizmo drives them all
        // (Object3D.attach preserves each object's world transform).
        if (st.pivot && st.multi.length > 1) {
          for (const o of st.multi) st.pivot.attach(o);
        }
      } else {
        // Multi: return objects to modelsGroup (keep world transform) + recenter.
        if (st.pivot && st.multi.length > 1) {
          for (const o of st.multi) st.modelsGroup.attach(o);
          recenterPivot(st);
        }
        if (st.dragSnap) {
          const before = st.dragSnap;
          const after = captureTransforms(before.map((t) => t.obj));
          if (!transformsEqual(before, after)) {
            pushHistory({
              undo: () => {
                restoreTransforms(before);
                afterTransformChange(st);
              },
              redo: () => {
                restoreTransforms(after);
                afterTransformChange(st);
              },
            });
          }
          st.dragSnap = null;
        }
        emitObjects();
      }
    });
    // r0.184: add the helper object, not the controls instance itself.
    const gizmo = (transform as unknown as { getHelper?: () => THREE.Object3D }).getHelper
      ? (transform as unknown as { getHelper: () => THREE.Object3D }).getHelper()
      : (transform as unknown as THREE.Object3D);
    scene.add(gizmo);

    // 光感/调色后处理 —— 与全景共用同一条管线。默认中性(零开销):needsComposer()
    // 为假时,renderStage 直接 renderer.render,与现状逐像素一致。
    const lightFx = createLightFx({ renderer, scene, camera, width, height });

    const state: StageState = {
      renderer,
      scene,
      camera,
      orbit,
      transform,
      modelsGroup,
      keyLight,
      ambient,
      grid,
      lightFx,
      pmrem: null,
      envRT: null,
      envEnabled: false,
      fxState: { ...LIGHTFX_DEFAULTS },
      panoSphere: null,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      selected: null,
      skeletonHelper: null,
      posingBone: null,
      bonePick: false,
      joints: null,
      frameId: 0,
      keyAz: LIGHT_DEFAULTS.key.azimuthDeg,
      keyEl: LIGHT_DEFAULTS.key.elevationDeg,
      keyDist: 10,
      cameraSlots: [],
      recording: false,
      rayGroup,
      rayLines: new Map(),
      camGizmoGroup,
      camGizmos: new Map(),
      selectedCamSlot: null,
      transformHelper: gizmo,
      camDragBaseDist: null,
      thumbRT: null,
      thumbCam: new THREE.PerspectiveCamera(40, 16 / 9, SCENE.cameraNear, SCENE.cameraFar),
      keyframes: [],
      tracksStore: new Map(),
      activeTrack: 'free',
      cuts: [],
      recordPlaying: false,
      recordT: 0,
      multi: [],
      pivot: null,
      marquee: false,
      undoStack: [],
      redoStack: [],
      dragSnap: null,
      anims: new Map(),
      clock: new THREE.Clock(),
    };
    stateRef.current = state;
    positionKeyLight(state);

    if (entry === 'panorama' && panoramaUrl) applyPanorama(state, panoramaUrl);

    // Live transform readback → right panel
    const _boneDq = new THREE.Quaternion();
    const _boneEul = new THREE.Euler();
    /** 回传 base⁻¹·current 的欧拉增量给右栏滑杆(gizmo 旋转 / IK 拖拽共用). */
    const emitBoneDelta = (pb: THREE.Bone) => {
      const base = (pb.userData?._poseBase ?? pb.userData?._restQuat) as
        | THREE.Quaternion
        | undefined;
      if (!base) return;
      _boneDq.copy(base).invert().multiply(pb.quaternion);
      _boneEul.setFromQuaternion(_boneDq, 'XYZ');
      const r = (rad: number) => Math.round(THREE.MathUtils.radToDeg(rad) * 10) / 10;
      onBoneRotateRef.current?.(pb.name, [r(_boneEul.x), r(_boneEul.y), r(_boneEul.z)]);
    };
    transform.addEventListener('objectChange', () => {
      if (state.selected) onSelRef.current?.(selectionInfo(state.selected));
      // gizmo 旋转骨骼 → 滑杆双向同步。
      if (state.posingBone) emitBoneDelta(state.posingBone);
      // 拖动机位摄像机模型 → 实时写回机位。移动/旋转写位置与朝向;
      // 缩放 = 推拉镜头距离(基准×手柄倍率,单调平滑,不复利跳变)。
      const att = (transform as unknown as { object?: THREE.Object3D }).object;
      const camId = att?.userData?.cameraSlotId as string | undefined;
      if (att && camId) {
        if (transform.getMode() === 'scale') applyCamGizmoScale(state, camId, att);
        else writeBackCamGizmo(state, camId, att);
      }
    });

    // ── Pointer: click-to-select + 框选(marquee)─────────────────────
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    const isDragging = () => !!(transform as unknown as { dragging?: boolean }).dragging;

    /** Raycast the model under (clientX, clientY) → its modelsGroup root, or null. */
    const pickRoot = (clientX: number, clientY: number): THREE.Object3D | null => {
      const rect = canvas.getBoundingClientRect();
      state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const hits = state.raycaster.intersectObjects(state.modelsGroup.children, true);
      if (hits.length === 0) return null;
      let root = hits[0].object as THREE.Object3D;
      while (root.parent && root.parent !== state.modelsGroup) root = root.parent;
      return root;
    };

    /** Raycast 机位摄像机模型 → 其 gizmo group 根,或 null。优先于普通模型。
     *  只认实体 Mesh:Raycaster 对线框(Line)默认 1 世界单位的命中阈值,
     *  会把摄像机模型周围一大片点击都吸过来,干扰普通模型选择。 */
    const pickCamGizmo = (clientX: number, clientY: number): THREE.Group | null => {
      if (state.camGizmoGroup.children.length === 0) return null;
      const rect = canvas.getBoundingClientRect();
      state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const hits = state.raycaster.intersectObjects(state.camGizmoGroup.children, true);
      const meshHit = hits.find((h) => (h.object as THREE.Mesh).isMesh);
      if (!meshHit) return null;
      let root = meshHit.object as THREE.Object3D;
      while (root.parent && root.parent !== state.camGizmoGroup) root = root.parent;
      return root as THREE.Group;
    };

    /** 选中一个机位摄像机模型:transform gizmo 挂上,可移动/旋转/缩放。
     *  缩放的语义 = 推拉镜头距离(Blender 相机缩放不改成像,我们映射到
     *  target 距离,视锥辅助线随之伸缩)。 */
    const selectCamGizmo = (g: THREE.Group) => {
      deselectAll();
      state.selectedCamSlot = (g.userData.cameraSlotId as string) ?? null;
      state.transform.attach(g);
    };

    // Marquee transient state (effect-local).
    let mqStart: { x: number; y: number } | null = null;
    let mqMoved = false;
    let mqEl: HTMLDivElement | null = null;
    const endMarquee = () => {
      window.removeEventListener('pointermove', onMarqueeMove);
      window.removeEventListener('pointerup', onMarqueeUp);
      if (mqEl && mqEl.parentNode) mqEl.parentNode.removeChild(mqEl);
      mqEl = null;
      mqStart = null;
      mqMoved = false;
    };
    const onMarqueeMove = (e: PointerEvent) => {
      if (!mqStart) return;
      if (isDragging()) {
        endMarquee();
        return;
      }
      const dx = e.clientX - mqStart.x;
      const dy = e.clientY - mqStart.y;
      if (!mqMoved && Math.hypot(dx, dy) < 4) return;
      mqMoved = true;
      const rect = canvas.getBoundingClientRect();
      if (!mqEl) {
        mqEl = document.createElement('div');
        mqEl.style.cssText =
          'position:absolute;border:1px solid #22d3ee;background:rgba(34,211,238,0.12);' +
          'pointer-events:none;z-index:30;border-radius:2px;';
        el.appendChild(mqEl);
      }
      mqEl.style.left = `${Math.min(mqStart.x, e.clientX) - rect.left}px`;
      mqEl.style.top = `${Math.min(mqStart.y, e.clientY) - rect.top}px`;
      mqEl.style.width = `${Math.abs(dx)}px`;
      mqEl.style.height = `${Math.abs(dy)}px`;
    };
    const onMarqueeUp = (e: PointerEvent) => {
      const start = mqStart;
      const moved = mqMoved;
      endMarquee();
      if (!start || isDragging()) return;
      if (!moved) {
        // tiny drag == click: single select, or deselect on empty.
        const root = pickRoot(e.clientX, e.clientY);
        if (root) selectMany([root]);
        else deselectAll();
        return;
      }
      // Box: select every model whose projected bbox-center is inside the rect.
      const rect = canvas.getBoundingClientRect();
      const minX = Math.min(start.x, e.clientX);
      const maxX = Math.max(start.x, e.clientX);
      const minY = Math.min(start.y, e.clientY);
      const maxY = Math.max(start.y, e.clientY);
      const picked: THREE.Object3D[] = [];
      const center = new THREE.Vector3();
      const box = new THREE.Box3();
      for (const o of state.modelsGroup.children) {
        box.setFromObject(o);
        if (box.isEmpty()) continue;
        box.getCenter(center).project(state.camera);
        if (center.z > 1) continue; // behind camera
        const sx = rect.left + (center.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-center.y * 0.5 + 0.5) * rect.height;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) picked.push(o);
      }
      selectMany(picked);
    };

    /** Update state.pointer + raycaster from a client coordinate. */
    const aimRay = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      state.raycaster.setFromCamera(state.pointer, state.camera);
    };

    /**
     * IK 拖拽:按住手/脚末端小球拖动 → 整条肢体解析二连杆解算(余弦定理,
     * 防反关节由构造保证;肘/膝朝向跟随 pole 手柄)。位移 < 4px 视为单击,
     * 落回普通选骨。目标点在「过末端、面向相机」的平面上移动。
     */
    const startIkDrag = (e: PointerEvent, chain: IkChainRef) => {
      const sel = state.selected;
      if (!sel) return;
      if (state.anims.has(sel)) stopAnimFor(sel);
      const before = capturePose(sel);
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const plane = new THREE.Plane();
      const planeN = new THREE.Vector3();
      const target = new THREE.Vector3();
      const pole = new THREE.Vector3();
      chain.effector.getWorldPosition(target);
      state.camera.getWorldDirection(planeN);
      plane.setFromNormalAndCoplanarPoint(planeN, target);
      // orbit 的 pointerdown 已先于本处理器执行;立刻禁用让它忽略后续 move,
      // 避免拖末端时相机跟着转(pointerup 时 orbit 仍会正常清理指针状态)。
      state.orbit.enabled = false;
      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          dragging = true;
        }
        aimRay(ev.clientX, ev.clientY);
        if (!state.raycaster.ray.intersectPlane(plane, target)) return;
        sel.localToWorld(pole.copy(chain.poleLocal));
        solveTwoBone(chain.links[0], chain.links[1], chain.effector, target, pole);
        clampChainRoot(chain); // 肩/胯超限时顶住不走,末端随之停在可达边界
        updateSkeletons(sel);
        for (const link of chain.links) emitBoneDelta(link); // 滑杆实时跟随
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        state.orbit.enabled = true;
        if (!dragging) {
          selectBoneForPosing(chain.effector); // 单击 = 选中末端骨(手/脚)
          return;
        }
        commitPoseHistory(state, sel, before); // 一次拖拽 = 一步撤销
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    /**
     * pole 拖拽:移动肘/膝朝向手柄 → 末端钉在原位,重解整条肢体让肘/膝
     * 转向新 pole(Blender 式 pole target)。pole 位置存模型局部空间并
     * 持久化到 userData,跟随模型移动/旋转。
     */
    const startPoleDrag = (e: PointerEvent, chain: IkChainRef) => {
      const sel = state.selected;
      if (!sel) return;
      if (state.anims.has(sel)) stopAnimFor(sel);
      const before = capturePose(sel);
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const plane = new THREE.Plane();
      const planeN = new THREE.Vector3();
      const pole = new THREE.Vector3();
      const pinned = new THREE.Vector3();
      chain.effector.getWorldPosition(pinned); // 末端钉住
      sel.localToWorld(pole.copy(chain.poleLocal));
      state.camera.getWorldDirection(planeN);
      plane.setFromNormalAndCoplanarPoint(planeN, pole);
      state.orbit.enabled = false;
      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          dragging = true;
        }
        aimRay(ev.clientX, ev.clientY);
        if (!state.raycaster.ray.intersectPlane(plane, pole)) return;
        chain.poleLocal.copy(pole);
        sel.worldToLocal(chain.poleLocal);
        solveTwoBone(chain.links[0], chain.links[1], chain.effector, pinned, pole);
        clampChainRoot(chain);
        updateSkeletons(sel);
        for (const link of chain.links) emitBoneDelta(link);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        state.orbit.enabled = true;
        if (!dragging) return; // pole 单击无语义
        const poles = (sel.userData._ikPoles ??= {}) as Record<
          string,
          [number, number, number]
        >;
        poles[normBone(chain.effector.name)] = [
          chain.poleLocal.x,
          chain.poleLocal.y,
          chain.poleLocal.z,
        ];
        commitPoseHistory(state, sel, before);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    /**
     * 骨骼点选模式:优先点关节手柄(末端小球走 IK 拖拽),其次点选中假人身体
     * 做皮肤权重反查。返回 true 表示事件已消费(不再走整体模型选择)。
     */
    const tryPickBone = (e: PointerEvent): boolean => {
      if (!state.bonePick) return false;
      const sel = state.selected;
      if (!sel || !sel.userData?.isFbxBot) return false;
      aimRay(e.clientX, e.clientY);
      // 1) pole 手柄(悬浮身体外,优先命中)
      if (state.joints?.poleMesh) {
        const pHits = state.raycaster.intersectObject(state.joints.poleMesh);
        const pid = pHits[0]?.instanceId;
        if (pid != null && state.joints.poleChains[pid]) {
          startPoleDrag(e, state.joints.poleChains[pid]);
          return true;
        }
      }
      // 2) 关节手柄(显示骨架时)
      if (state.joints) {
        const jHits = state.raycaster.intersectObject(state.joints.mesh);
        const id = jHits[0]?.instanceId;
        if (id != null && state.joints.bones[id]) {
          const chain = state.joints.ik.get(id);
          if (chain) startIkDrag(e, chain);
          else selectBoneForPosing(state.joints.bones[id]);
          return true;
        }
      }
      // 3) 点身体 → 权重最高骨骼(重复点同部位在权重前列骨骼间轮换)
      const hits = state.raycaster.intersectObjects(state.modelsGroup.children, true);
      if (hits.length === 0) return false;
      let root = hits[0].object as THREE.Object3D;
      while (root.parent && root.parent !== state.modelsGroup) root = root.parent;
      if (root !== sel) return false; // 点了别的模型:走正常换选
      const bone = boneFromSkinHit(state, hits[0]);
      if (bone) selectBoneForPosing(bone);
      // 点中自己身体即消费事件,避免 selectMany 把骨骼会话重置回整体。
      return true;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // left button only (mid/right = pan/zoom orbit)
      if (isDragging()) return; // gizmo owns this drag
      if (state.marquee) {
        mqStart = { x: e.clientX, y: e.clientY };
        mqMoved = false;
        window.addEventListener('pointermove', onMarqueeMove);
        window.addEventListener('pointerup', onMarqueeUp);
        return;
      }
      if (tryPickBone(e)) return;
      // 机位摄像机模型优先命中(小物件,压在普通模型之上)。
      const camG = pickCamGizmo(e.clientX, e.clientY);
      if (camG) {
        selectCamGizmo(camG);
        return;
      }
      // Default mode: click selects; left-drag still rotates the view (orbit).
      const root = pickRoot(e.clientX, e.clientY);
      if (root) {
        selectMany([root]);
        return;
      }
      // 点空白:位移 < 4px 视为单击 → 取消选中;更大位移是 orbit 旋转,不动选区。
      const sx = e.clientX;
      const sy = e.clientY;
      const onEmptyUp = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', onEmptyUp);
        if (isDragging()) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) deselectAll();
      };
      window.addEventListener('pointerup', onEmptyUp);
    };
    canvas.addEventListener('pointerdown', onPointerDown);

    // 关节手柄 hover:变色 + title 显示骨名(仅骨骼点选模式且手柄存在时)。
    const onHoverMove = (e: PointerEvent) => {
      const j = state.joints;
      if (!state.bonePick || !j) return;
      if (isDragging()) return;
      aimRay(e.clientX, e.clientY);
      const hits = state.raycaster.intersectObject(j.mesh);
      const id = hits[0]?.instanceId ?? -1;
      let pid = -1;
      if (j.poleMesh) {
        const pHits = state.raycaster.intersectObject(j.poleMesh);
        pid = pHits[0]?.instanceId ?? -1;
      }
      if (id === j.hover && pid === j.poleHover) return;
      j.hover = id;
      j.poleHover = pid;
      refreshJointColors(state);
      const isIk = id >= 0 && j.ik.has(id);
      canvas.title =
        pid >= 0
          ? `${j.poleChains[pid]?.effector.name ?? ''} pole · 拖拽调肘/膝朝向`
          : id >= 0
            ? `${j.bones[id]?.name ?? ''}${isIk ? ' · 拖拽 = IK' : ''}`
            : '';
      canvas.style.cursor = pid >= 0 || (id >= 0 && isIk) ? 'grab' : id >= 0 ? 'pointer' : '';
    };
    canvas.addEventListener('pointermove', onHoverMove);

    // ── Keyboard shortcuts (3D-editor style) ─────────────────────────
    const isTypingTarget = (t: EventTarget | null): boolean => {
      const node = t as HTMLElement | null;
      return (
        !!node &&
        (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))
      );
    };
    const setModeKb = (m: TransformMode) => {
      transform.setMode(m);
      onModeRef.current?.(m);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if (!st || isTypingTarget(e.target)) return;
      // Esc 固定:退出框选 / 取消选择(不可改键)。
      if (e.key === 'Escape') {
        if (st.marquee) setMarqueeImpl(false);
        else if (st.posingBone) exitBonePosing(); // 先退骨骼会话,再按一次才取消选择
        else deselectAll();
        return;
      }
      // Shift 固定:按住拖拽 gizmo 时吸附(不可改键)。
      if (e.key === 'Shift') {
        transform.setTranslationSnap(0.5);
        transform.setRotationSnap(THREE.MathUtils.degToRad(15));
        transform.setScaleSnap(0.1);
        return;
      }
      // 其余动作按「可改键」绑定表分发。
      const token = eventToToken(e);
      if (!token) return;
      const action = tokenToAction(keymapRef.current, token);
      if (!action) return;
      // 组合键 / 功能键阻止浏览器默认行为(撤销、删除等)。
      if (token.includes('+') || token === 'Delete' || token === 'Backspace') {
        e.preventDefault();
      }
      switch (action) {
        case 'translate':
          setModeKb('translate');
          break;
        case 'rotate':
          setModeKb('rotate');
          break;
        case 'scale':
          setModeKb('scale');
          break;
        case 'focus':
          focusSelectedImpl();
          break;
        case 'toggleSpace':
          transform.setSpace(transform.space === 'local' ? 'world' : 'local');
          break;
        case 'boxSelect':
          setMarqueeImpl(!st.marquee);
          break;
        case 'delete':
          deleteSelectedImpl();
          break;
        case 'duplicate':
          duplicateSelectedImpl();
          break;
        case 'undo':
          doUndo();
          break;
        case 'redo':
          doRedo();
          break;
        default:
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        transform.setTranslationSnap(null);
        transform.setRotationSnap(null);
        transform.setScaleSnap(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    let lastAnimTickAt = 0;
    let lastAnimTickKey = '';
    const animate = () => {
      state.frameId = requestAnimationFrame(animate);
      // During keyframe playback the camera is driven manually; OrbitControls
      // would otherwise re-derive position from its target and override us.
      if (!state.recordPlaying) orbit.update();
      // 机位摄像机模型:实时相机贴得太近时隐藏(刚建机位/切到该机位时
      // 模型正好在眼前,会糊住整个视野);离开后自动恢复。
      for (const g of state.camGizmos.values()) {
        g.visible = state.camera.position.distanceToSquared(g.position) > 0.5;
      }
      const dt = state.clock.getDelta();
      for (const a of state.anims.values()) {
        // MMD:mixer 写 FK 前先恢复上一帧的骨骼快照 —— VMD 没有轨道的骨骼
        // (捩骨/付与目标/物理骨)不恢复会被 IK/Grant/物理逐帧叠加,表现为
        // 脚踝扭曲、部件穿模(帧序详见 directorMmd.attachMmdRuntime)。
        (a.target.userData?.mmdPreAnim as (() => void) | undefined)?.();
        a.mixer.update(dt);
      }
      // MMD 模型:mixer/手工摆姿写完 FK 骨后,快照 + 足ＩＫ链 + Grant(付与)
      // + 物理每帧求解。IK 不在播动画时也跑(MMD 原生摆姿 = 拖 IK 骨,腿脚
      // 跟着走);Grant/物理只在 mixer 播放中跑(详见 attachMmdRuntime)。
      for (const c of state.modelsGroup.children) {
        (c.userData?.mmdUpdate as
          | ((playing?: boolean, delta?: number) => void)
          | undefined)?.(state.anims.has(c), dt);
      }
      // 播放条回传「选中对象」的动画:身份/暂停态变化(含换选)立即发,
      // 播放中进度节流到 ~10Hz;seek 由入口即时回传。
      const sel = state.selected ? state.anims.get(state.selected) : undefined;
      const key = sel ? `${sel.target.uuid}|${sel.url}|${sel.action.paused}` : '';
      const now = performance.now();
      if (
        key !== lastAnimTickKey ||
        (sel && !sel.action.paused && now - lastAnimTickAt > 100)
      ) {
        lastAnimTickKey = key;
        lastAnimTickAt = now;
        emitAnimTick();
      }
      if (state.joints) updateJointHandles(state); // 关节手柄跟随骨骼世界位置
      adaptCameraNear(state); // 深度精度随镜头距离走,防远处共面闪烁
      renderStage(state, camera);
    };
    animate();
    onReadyRef.current?.();

    const onContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(state.frameId);
    };
    const onContextRestored = () => animate();
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    return () => {
      cancelAnimationFrame(state.frameId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onHoverMove);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      endMarquee();
      // 整个场景即将销毁 — 只停 mixer,无需恢复姿势。
      for (const a of state.anims.values()) a.mixer.stopAllAction();
      state.anims.clear();
      dissolveMulti(state);
      clearSkeletonHelper(state);
      transform.detach();
      transform.dispose();
      orbit.dispose();
      if (state.panoSphere) {
        const m = state.panoSphere.material as THREE.MeshBasicMaterial;
        m.map?.dispose();
      }
      state.grid.dispose();
      state.thumbRT?.dispose();
      state.lightFx.dispose();
      state.envRT?.dispose();
      state.pmrem?.dispose();
      disposeSlotRays(state);
      for (const g of state.camGizmos.values()) disposeCamGizmo(g);
      state.camGizmos.clear();
      disposeScene(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode === el) el.removeChild(canvas);
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  // Resize
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    s.renderer.setSize(width, height);
    s.camera.aspect = width / height;
    s.camera.updateProjectionMatrix();
  }, [width, height]);

  // React to panorama url changes
  useEffect(() => {
    const s = stateRef.current;
    if (s && entry === 'panorama') applyPanorama(s, panoramaUrl ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panoramaUrl]);

  return (
    <div
      ref={mountRef}
      style={{ width, height, overflow: 'hidden', background: '#14161c' }}
    />
  );
}

// ── Helpers (module scope; no React state) ────────────────────────

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

/** 动画剪辑缓存(URL → clip promise);加载失败不缓存,可重试. */
const animClipCache = new Map<string, Promise<THREE.AnimationClip>>();

/**
 * 按格式加载动画剪辑并取第一条(cached by URL)。
 * - fbx(默认,目录动画与 Mixamo 导入)→ FBXLoader;
 * - glb/gltf(用户导入)→ GLTFLoader 的 gltf.animations;
 * - json(本软件「K 动画」导出)→ fetch + AnimationClip.parse。
 * objectURL 无扩展名,导入资产由调用方经 `ext` 显式指明格式。
 */
function loadAnimClip(url: string, ext?: string): Promise<THREE.AnimationClip> {
  let p = animClipCache.get(url);
  if (!p) {
    const kind = (ext ?? extFromUrl(url) ?? 'fbx').toLowerCase();
    if (kind === 'glb' || kind === 'gltf') {
      p = gltfLoader.loadAsync(url).then((gltf) => {
        const clip = gltf.animations?.[0];
        if (!clip) throw new Error(`animation glTF has no clips: ${url}`);
        return clip;
      });
    } else if (kind === 'json') {
      p = fetch(url)
        .then((r) => r.text())
        .then((text) => parseClipJson(text));
    } else {
      p = fbxLoader.loadAsync(url).then((group) => {
        const clip = group.animations?.[0];
        if (!clip) throw new Error(`animation FBX has no clips: ${url}`);
        return clip;
      });
    }
    p.catch(() => animClipCache.delete(url));
    animClipCache.set(url, p);
  }
  return p;
}

/**
 * 目标相关的剪辑加载:动作 VMD 必须按目标 MMD 网格的骨骼编译(日文骨名 +
 * `.bones[…]` 轨道),不能走按 URL 缓存的 loadAnimClip;其余格式原路。
 */
async function loadClipForTarget(
  target: THREE.Object3D,
  url: string,
  ext?: string,
): Promise<THREE.AnimationClip> {
  const kind = (ext ?? extFromUrl(url) ?? '').toLowerCase();
  if (kind === 'vmd') {
    const mesh = target.userData?.mmdMesh as THREE.SkinnedMesh | undefined;
    if (!mesh) {
      throw new Error('动作 VMD 只能应用到 MMD 模型(请先导入 PMX/PMD/zip 模型并选中)');
    }
    const m = await import('./directorMmd');
    return m.loadVmdMotionClip(url, mesh);
  }
  return loadAnimClip(url, ext);
}

/** 从 URL 路径末尾提取扩展名(objectURL / 无点路径返回 null)。 */
function extFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  const seg = path.slice(path.lastIndexOf('/') + 1);
  const dot = seg.lastIndexOf('.');
  return dot > 0 ? seg.slice(dot + 1) : null;
}

/**
 * 轨道骨骼名兜底:动画 FBX 的轨道节点名(如 "mixamorig:Hips")与 rig 骨骼名
 * (如 "mixamorigHips")可能差一个命名约定。目标里找不到同名节点的轨道,按
 * normBone 归一化后匹配到真实(非嵌套重复)骨骼并重命名;全部命中则原样返回。
 * 注:这些 rig 是双骨架(每根骨骼有嵌套同名孪生),只绑真实骨骼 — 嵌套孪生
 * 继承父级即可,直接驱动它会双重旋转(同 applyPoseToObject 的拓扑说明)。
 */
function retargetClipTracks(
  clip: THREE.AnimationClip,
  target: THREE.Object3D,
): THREE.AnimationClip {
  const byNorm = new Map<string, string>();
  for (const b of collectSkeletonBones(target)) {
    if (!hasSameNamedBoneAncestor(b) && !byNorm.has(normBone(b.name))) {
      byNorm.set(normBone(b.name), b.name);
    }
  }
  const names = new Set(byNorm.values());
  let changed = false;
  const tracks = clip.tracks.map((t) => {
    const dot = t.name.lastIndexOf('.');
    if (dot < 0) return t;
    const node = t.name.slice(0, dot);
    if (names.has(node)) return t;
    const mapped = byNorm.get(normBone(node));
    if (!mapped) return t;
    const c = t.clone();
    c.name = `${mapped}${t.name.slice(dot)}`;
    changed = true;
    return c;
  });
  if (!changed) return clip;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Depth-precision guard: near=0.01 with far=2000 packs almost all 24-bit depth
 * precision into the first centimetre, so co-planar faces of mid/far geometry
 * (door panels, walls of large imported models) z-fight and shimmer while
 * orbiting. Scale `near` with the camera→target distance instead — the same
 * `near ≈ size/100` heuristic three-gltf-viewer uses — with a small hysteresis
 * so we don't rebuild the projection matrix every frame. Far stays at 2000
 * (the "huge space" look depends on it; the ratio improvement comes from near).
 */
function adaptCameraNear(s: StageState): void {
  const dist = s.camera.position.distanceTo(s.orbit.target);
  const near = THREE.MathUtils.clamp(dist / 100, SCENE.cameraNear, 2);
  if (Math.abs(near - s.camera.near) > s.camera.near * 0.05) {
    s.camera.near = near;
    s.camera.updateProjectionMatrix();
  }
}

/**
 * 统一的「渲染到屏幕/画布」入口 —— 替换所有原先散落的 renderer.render(scene, camera)。
 * 中性时直出(零 composer 开销,最清晰、与现状一致);辉光/调色/景深任一启用时走
 * composer(特效会进入 toDataURL/captureStream 的像素,即截图与录制也带特效)。
 * 注意:仅用于以 canvas(默认帧缓冲)为目标的渲染;渲染到离屏 RT 请用 renderStageToTarget。
 */
function renderStage(s: StageState, camera: THREE.Camera): void {
  const fx = s.lightFx;
  fx.syncToneMapping();
  if (fx.needsComposer()) fx.renderToScreen();
  else s.renderer.render(s.scene, camera);
}

/**
 * 渲染到离屏 RT(缩略图)——直出路径:曝光经 renderer.toneMapping 生效,辉光/调色
 * 这类需要 composer 的特效在小缩略图里忽略(非交付物,性能优先)。
 */
function renderStageToTarget(
  s: StageState,
  camera: THREE.Camera,
  rt: THREE.WebGLRenderTarget,
): void {
  s.lightFx.syncToneMapping();
  const prev = s.renderer.getRenderTarget();
  s.renderer.setRenderTarget(rt);
  s.renderer.render(s.scene, camera);
  s.renderer.setRenderTarget(prev);
}

/**
 * Place the camera on a sphere of radius `distance` about (0, targetY, 0),
 * using the live app's azimuth(72°)/elevation(40°) — `_setCameraOrbit`.
 * Camera y gets the small +targetY lift so the framing matches the original.
 */
function placeCameraOrbit(
  camera: THREE.PerspectiveCamera,
  orbit: OrbitControls,
  distance: number,
): void {
  const az = THREE.MathUtils.degToRad(SCENE.orbitAzimuthDeg);
  const el = THREE.MathUtils.degToRad(SCENE.orbitElevationDeg);
  const x = distance * Math.sin(az) * Math.sin(el);
  const y = distance * Math.cos(az);
  const z = distance * Math.sin(az) * Math.cos(el);
  camera.position.set(x, y + SCENE.targetY, z);
  orbit.target.set(0, SCENE.targetY, 0);
  camera.lookAt(0, SCENE.targetY, 0);
  orbit.update();
}

/**
 * Record the live canvas to a video Blob, mirroring the live app's exporter
 * (chunk `Sf()`/`captureStream`/`MediaRecorder`):
 *   - pick a supported mime (mp4/h264 → webm fallback),
 *   - temporarily render the drawing buffer at the target resolution,
 *   - capture a real-time stream at `fps` and record for `durationSec`,
 *   - bitrate = bpp × w × h × fps (clamped 1.5–80 Mbps).
 * The CSS size is preserved (updateStyle=false) so the on-screen view is intact.
 */
async function recordCanvas(
  s: StageState,
  opts: RecordOptions,
): Promise<RecordResult> {
  const { durationSec, resolution, fps, quality, onProgress } = opts;
  const codec = pickRecorderMime();
  if (!codec.available) {
    throw new Error('当前浏览器不支持 MediaRecorder,无法导出视频');
  }
  const canvas = s.renderer.domElement;
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('canvas.captureStream 不可用,无法录制视频');
  }
  if (s.recording) throw new Error('正在录制中');

  // Target output size from short edge + current aspect.
  const liveSize = new THREE.Vector2();
  s.renderer.getSize(liveSize);
  const aspect = liveSize.x / liveSize.y || 16 / 9;
  const { width, height } = computeOutputSize(CAPTURE_RES_SHORT[resolution], aspect);
  const bitrate = computeBitrate(quality, width, height, fps);

  // Switch the drawing buffer to the export resolution (keep CSS size).
  const prevPR = s.renderer.getPixelRatio();
  s.recording = true;
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(width, height, false);
  s.camera.aspect = width / height;
  s.camera.updateProjectionMatrix();
  // 摄像机模型 + 移动/旋转/缩放控制环是编辑辅助物,不进导出视频。
  const prevGizVis = s.camGizmoGroup.visible;
  const prevHelperVis = s.transformHelper.visible;
  s.camGizmoGroup.visible = false;
  s.transformHelper.visible = false;

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: codec.mime,
    videoBitsPerSecond: bitrate,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const restore = () => {
    s.camGizmoGroup.visible = prevGizVis;
    s.transformHelper.visible = prevHelperVis;
    s.renderer.setPixelRatio(prevPR);
    s.renderer.setSize(liveSize.x, liveSize.y, false);
    s.camera.aspect = liveSize.x / liveSize.y;
    s.camera.updateProjectionMatrix();
    s.recording = false;
  };

  return new Promise<RecordResult>((resolve, reject) => {
    const durationMs = Math.max(100, durationSec * 1000);
    recorder.onerror = (e) => {
      restore();
      reject((e as unknown as { error?: Error }).error ?? new Error('MediaRecorder error'));
    };
    recorder.onstop = () => {
      restore();
      const blob = new Blob(chunks, { type: codec.mime.split(';')[0] });
      resolve({ blob, mime: codec.mime, ext: codec.ext, width, height, durationMs });
    };

    const start = performance.now();
    recorder.start(200);
    onProgress?.(0);
    const tick = () => {
      if (!s.recording) return; // teardown / cancel
      const elapsed = performance.now() - start;
      const pct = Math.min(100, Math.round((elapsed / durationMs) * 100));
      onProgress?.(pct);
      if (elapsed >= durationMs) {
        try {
          recorder.requestData?.();
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            recorder.stop();
          } catch {
            /* ignore */
          }
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch {
            /* ignore */
          }
        }, 120);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function newSlotId(): string {
  return `slot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Scratch objects reused across slot/keyframe math (avoid per-call allocation).
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Re-aim a slot's stored quaternion to look from its position at its target. */
function recomputeSlotQuat(slot: CameraSlot): void {
  _v0.set(...slot.position);
  _v1.set(...slot.target);
  _m.lookAt(_v0, _v1, UP);
  _q0.setFromRotationMatrix(_m);
  slot.quaternion = [_q0.x, _q0.y, _q0.z, _q0.w];
}

/** Rebuild the camera→target ray lines so only slots with showRay show one. */
function syncSlotRays(s: StageState): void {
  for (const slot of s.cameraSlots) {
    let line = s.rayLines.get(slot.id);
    if (slot.showRay) {
      if (!line) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 });
        line = new THREE.Line(geom, mat);
        line.frustumCulled = false;
        s.rayGroup.add(line);
        s.rayLines.set(slot.id, line);
      }
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, slot.position[0], slot.position[1], slot.position[2]);
      pos.setXYZ(1, slot.target[0], slot.target[1], slot.target[2]);
      pos.needsUpdate = true;
    } else if (line) {
      s.rayGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      s.rayLines.delete(slot.id);
    }
  }
  // Drop rays whose slot no longer exists.
  const ids = new Set(s.cameraSlots.map((x) => x.id));
  for (const [id, line] of [...s.rayLines]) {
    if (!ids.has(id)) {
      s.rayGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      s.rayLines.delete(id);
    }
  }
  // 机位摄像机模型与机位列表同步(Blender 同款 3D gizmo)。
  syncCamGizmos(s);
}

// ── 机位摄像机模型(Blender 风格 3D gizmo)────────────────────────
// 每个机位在场景里有一个可点选/可拖动的小摄像机模型:机身线框盒 +
// 镜头锥(指向 -Z,即 three.js 相机前方)+ 顶部朝向三角。拖动/旋转
// 该模型 = 直接改机位的 position/quaternion(target 保持原距离沿新前方)。

const CAM_GIZMO_COLOR = 0x22d3ee;

/** Build one camera-model gizmo group. userData.cameraSlotId 标记所属机位。 */
function buildCameraGizmo(slotId: string): THREE.Group {
  const g = new THREE.Group();
  g.name = `__camGizmo_${slotId}`;
  g.userData.cameraSlotId = slotId;

  const lineMat = new THREE.LineBasicMaterial({ color: CAM_GIZMO_COLOR, transparent: true, opacity: 0.95 });
  const fillMat = new THREE.MeshBasicMaterial({
    color: CAM_GIZMO_COLOR,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // 机身(box)。相机前方为 -Z。
  const bodyGeo = new THREE.BoxGeometry(0.34, 0.26, 0.5);
  const body = new THREE.Mesh(bodyGeo, fillMat);
  body.userData.cameraSlotId = slotId;
  const bodyEdges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), lineMat);
  g.add(body, bodyEdges);

  // 镜头锥(四棱锥,尖朝机身、口朝 -Z 外张,与 Blender 相机一致)。
  const coneGeo = new THREE.ConeGeometry(0.17, 0.3, 4, 1, true);
  coneGeo.rotateY(Math.PI / 4); // 棱对齐水平/垂直
  coneGeo.rotateX(-Math.PI / 2); // 轴向 → Z
  coneGeo.translate(0, 0, -0.4);
  const cone = new THREE.Mesh(coneGeo, fillMat);
  cone.userData.cameraSlotId = slotId;
  const coneEdges = new THREE.LineSegments(new THREE.EdgesGeometry(coneGeo, 1), lineMat);
  g.add(cone, coneEdges);

  // 顶部朝向三角(Blender 的"这边是上"标记)。
  const triShape = new THREE.Shape();
  triShape.moveTo(-0.1, 0);
  triShape.lineTo(0.1, 0);
  triShape.lineTo(0, 0.14);
  triShape.closePath();
  const triGeo = new THREE.ShapeGeometry(triShape);
  triGeo.translate(0, 0.14, 0); // 顶到机身上沿
  const tri = new THREE.Mesh(triGeo, fillMat);
  tri.userData.cameraSlotId = slotId;
  const triEdges = new THREE.LineSegments(new THREE.EdgesGeometry(triGeo), lineMat);
  g.add(tri, triEdges);

  // 拍摄范围辅助线(Blender 相机视锥同款):原点→远面四角 + 远面矩形,
  // 8 段 16 顶点;远面尺寸由 syncCamGizmos 按机位 FOV × LookAt 距离实时更新。
  const frusGeo = new THREE.BufferGeometry();
  frusGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
  const frusMat = new THREE.LineBasicMaterial({
    color: CAM_GIZMO_COLOR,
    transparent: true,
    opacity: 0.35,
  });
  const frustum = new THREE.LineSegments(frusGeo, frusMat);
  frustum.name = '__camFrustum';
  frustum.frustumCulled = false;
  frustum.raycast = () => {}; // 辅助线不参与点选
  g.add(frustum);
  g.userData.frustum = frustum;

  return g;
}

/** 更新拍摄范围辅助线:视锥远面 = LookAt 距离处的 FOV 取景面(16:9)。 */
function updateCamGizmoFrustum(g: THREE.Group, slot: CameraSlot): void {
  const frustum = g.userData.frustum as THREE.LineSegments | undefined;
  if (!frustum) return;
  _v0.set(...slot.position);
  _v1.set(...slot.target);
  const d = Math.max(_v0.distanceTo(_v1), 0.6);
  const hh = Math.tan(THREE.MathUtils.degToRad(slot.fov / 2)) * d;
  const hw = hh * (16 / 9);
  const pos = frustum.geometry.getAttribute('position') as THREE.BufferAttribute;
  // 四角(gizmo 本地空间,相机前方 -Z)
  const corners: [number, number, number][] = [
    [-hw, -hh, -d],
    [hw, -hh, -d],
    [hw, hh, -d],
    [-hw, hh, -d],
  ];
  let i = 0;
  const seg = (a: [number, number, number], b: [number, number, number]) => {
    pos.setXYZ(i++, a[0], a[1], a[2]);
    pos.setXYZ(i++, b[0], b[1], b[2]);
  };
  const O: [number, number, number] = [0, 0, 0];
  seg(O, corners[0]);
  seg(O, corners[1]);
  seg(O, corners[2]);
  seg(O, corners[3]);
  seg(corners[0], corners[1]);
  seg(corners[1], corners[2]);
  seg(corners[2], corners[3]);
  seg(corners[3], corners[0]);
  pos.needsUpdate = true;
}

function disposeCamGizmo(g: THREE.Group): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as { material?: THREE.Material }).material;
    if (mat) mat.dispose();
  });
}

/** Create/update/remove camera-model gizmos so they mirror s.cameraSlots. */
function syncCamGizmos(s: StageState): void {
  for (const slot of s.cameraSlots) {
    let g = s.camGizmos.get(slot.id);
    if (!g) {
      g = buildCameraGizmo(slot.id);
      s.camGizmoGroup.add(g);
      s.camGizmos.set(slot.id, g);
    }
    g.position.set(...slot.position);
    g.quaternion.set(...slot.quaternion);
    g.scale.set(1, 1, 1); // 缩放对机位无意义,始终复位
    updateCamGizmoFrustum(g, slot);
  }
  const ids = new Set(s.cameraSlots.map((x) => x.id));
  for (const [id, g] of [...s.camGizmos]) {
    if (!ids.has(id)) {
      // 若正被 transform gizmo 挂着,先卸下再删,避免悬空引用。
      if ((s.transform as unknown as { object?: THREE.Object3D }).object === g) {
        s.transform.detach();
        s.selectedCamSlot = null;
      }
      s.camGizmoGroup.remove(g);
      disposeCamGizmo(g);
      s.camGizmos.delete(id);
    }
  }
}

/**
 * 机位模型的「缩放」= 推拉镜头距离(dolly):位置/朝向不动,只把 target
 * 沿前方移到 基准距离×手柄倍率 处(视锥辅助线随之伸缩)。
 * 模型 scale 读完立即复位 —— TransformControls 每次 pointermove 都从
 * 拖拽起点重算 scale(非增量),复位不影响下一次事件,却避免了模型
 * 忽大忽小、被 sync 复位互拽出现的抖动/翻滚。
 */
function applyCamGizmoScale(s: StageState, slotId: string, g: THREE.Object3D): void {
  const slot = s.cameraSlots.find((x) => x.id === slotId);
  const base = s.camDragBaseDist;
  if (!slot || base == null) {
    g.scale.set(1, 1, 1);
    return;
  }
  // 等比口径:三轴均值;负向拖过手柄中心时取绝对值并设下限,不反向翻转。
  const f = Math.max(
    (Math.abs(g.scale.x) + Math.abs(g.scale.y) + Math.abs(g.scale.z)) / 3,
    0.02,
  );
  g.scale.set(1, 1, 1);
  const dist = THREE.MathUtils.clamp(base * f, 0.2, 500);
  _v0.set(0, 0, -1).applyQuaternion(g.quaternion).multiplyScalar(dist);
  slot.target = [g.position.x + _v0.x, g.position.y + _v0.y, g.position.z + _v0.z];
  syncSlotRays(s);
}

/** 拖动摄像机模型后,把新位姿写回机位(target 沿新前方保持原距离)。 */
function writeBackCamGizmo(s: StageState, slotId: string, g: THREE.Object3D): void {
  const slot = s.cameraSlots.find((x) => x.id === slotId);
  if (!slot) return;
  _v0.set(...slot.position);
  _v1.set(...slot.target);
  const dist = Math.max(_v0.distanceTo(_v1), 0.1);
  slot.position = [g.position.x, g.position.y, g.position.z];
  slot.quaternion = [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w];
  _v0.set(0, 0, -1).applyQuaternion(g.quaternion).multiplyScalar(dist);
  slot.target = [g.position.x + _v0.x, g.position.y + _v0.y, g.position.z + _v0.z];
  syncSlotRays(s);
}

function disposeSlotRays(s: StageState): void {
  for (const line of s.rayLines.values()) {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }
  s.rayLines.clear();
}

/**
 * Render a slot's camera (or the free view) into a 2D canvas thumbnail.
 * Uses an offscreen WebGLRenderTarget so the on-screen canvas is untouched
 * (no flicker). Cheap enough to drive a few thumbnails on a throttled timer.
 */
function renderPreview(
  s: StageState,
  slot: CameraSlot | null,
  out: HTMLCanvasElement,
): void {
  const w = Math.max(2, out.width);
  const h = Math.max(2, out.height);
  if (!s.thumbRT || s.thumbRT.width !== w || s.thumbRT.height !== h) {
    s.thumbRT?.dispose();
    s.thumbRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    // r152+ color management: a render target defaults to NoColorSpace (linear),
    // so readRenderTargetPixels would return un-encoded (dark) values. Tag the
    // texture as sRGB so the renderer applies the same linear→sRGB output as the
    // on-screen canvas — keeps thumbnail colors faithful to the live view.
    s.thumbRT.texture.colorSpace = THREE.SRGBColorSpace;
  }
  const cam = s.thumbCam;
  if (slot) {
    // Blender 相机预览口径:取该机位轨在当前游标时刻的**动画求值位姿**
    // (与主相机播放共用 sampleKeysPose,预览与成片逐帧对齐);
    // 该机位轨没有关键帧时才退回机位静态基准位姿。
    const pose = sampleKeysPose(trackOf(s, slot.id), s.recordT);
    if (pose) {
      cam.position.set(...pose.position);
      cam.quaternion.set(...pose.quaternion);
      cam.fov = pose.fov;
    } else {
      cam.position.set(...slot.position);
      cam.quaternion.set(...slot.quaternion);
      cam.fov = slot.fov;
    }
  } else {
    cam.position.copy(s.camera.position);
    cam.quaternion.copy(s.camera.quaternion);
    cam.fov = s.camera.fov;
  }
  cam.aspect = w / h;
  // Keep thumbnail depth precision in step with the live view (adaptCameraNear).
  cam.near = s.camera.near;
  cam.far = s.camera.far;
  cam.updateProjectionMatrix();

  // 摄像机模型 + 移动/旋转/缩放控制环都是编辑辅助物,不进机位缩略图
  // (否则会怼在镜头前 / 满屏控制环)。
  const gizVis = s.camGizmoGroup.visible;
  const helperVis = s.transformHelper.visible;
  s.camGizmoGroup.visible = false;
  s.transformHelper.visible = false;
  renderStageToTarget(s, cam, s.thumbRT);
  s.camGizmoGroup.visible = gizVis;
  s.transformHelper.visible = helperVis;

  const buf = new Uint8Array(w * h * 4);
  s.renderer.readRenderTargetPixels(s.thumbRT, 0, 0, w, h, buf);
  const ctx = out.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  // GL origin is bottom-left → flip rows for the 2D canvas (top-left).
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * rowBytes;
    img.data.set(buf.subarray(src, src + rowBytes), y * rowBytes);
  }
  ctx.putImageData(img, 0, 0);
}

/** 切换激活轨道:存回旧轨、换入新轨('free' 或机位 id)。 */
function setActiveTrackState(s: StageState, id: string): void {
  if (id === s.activeTrack) return;
  s.tracksStore.set(s.activeTrack, s.keyframes);
  s.keyframes = s.tracksStore.get(id) ?? [];
  s.activeTrack = id;
}

/** 取某轨道的关键帧(激活轨在 s.keyframes,其余在 store)。 */
function trackOf(s: StageState, id: string): CameraKeyframe[] {
  return id === s.activeTrack ? s.keyframes : s.tracksStore.get(id) ?? [];
}

/** 按机位切换点把多机位编排「拍扁」成单相机关键帧流(导出成片镜头用):
 *  每段复制该机位轨内的关键帧,段首/段尾补插值位姿;切点处用相邻帧
 *  (1/30s)实现硬切 —— MMD 相机 VMD 的标准做法。无切换点 = 激活轨副本。 */
function flattenCutsToKeys(s: StageState): CameraKeyframe[] {
  const cuts = s.cuts.filter((c) => s.cameraSlots.some((x) => x.id === c.slotId));
  if (cuts.length === 0) return s.keyframes.map((k) => ({ ...k }));
  const CUT_EPS = 1 / 30;
  // 成片末端:参与机位轨的末帧与最后切点的最大值。
  let end = cuts[cuts.length - 1].t;
  for (const c of cuts) {
    const ks = trackOf(s, c.slotId);
    if (ks.length) end = Math.max(end, ks[ks.length - 1].t);
  }
  const poseAt = (slotId: string, t: number) => {
    const pose = sampleKeysPose(trackOf(s, slotId), t);
    if (pose) return pose;
    const slot = s.cameraSlots.find((x) => x.id === slotId)!;
    return {
      position: [...slot.position] as [number, number, number],
      quaternion: [...slot.quaternion] as [number, number, number, number],
      fov: slot.fov,
    };
  };
  const out: CameraKeyframe[] = [];
  const push = (
    t: number,
    pose: ReturnType<typeof poseAt>,
    slotId: string,
  ) => {
    if (out.length && t - out[out.length - 1].t < 1e-4) return; // 防时间重叠
    out.push({ id: newSlotId(), t, ...pose, slotId });
  };
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    const segEnd = i + 1 < cuts.length ? cuts[i + 1].t : end;
    push(c.t, poseAt(c.slotId, c.t), c.slotId);
    for (const k of trackOf(s, c.slotId)) {
      if (k.t > c.t + 1e-4 && k.t < segEnd - 1e-4) {
        push(
          k.t,
          {
            position: [...k.position],
            quaternion: [...k.quaternion],
            fov: k.fov,
          },
          c.slotId,
        );
      }
    }
    // 段尾:切点前 1/30s 停在本段位姿(下一个切点帧紧跟 = 硬切)。
    if (i + 1 < cuts.length) {
      const tHold = Math.max(c.t, segEnd - CUT_EPS);
      push(tHold, poseAt(c.slotId, tHold), c.slotId);
    } else if (end > c.t + 1e-4) {
      push(end, poseAt(c.slotId, end), c.slotId);
    }
  }
  return out;
}

/** 保存工程用:自由轨 → recordKeyframes(向后兼容),机位轨 → cameraTracks,
 *  切换点 → cameraCuts。已删除机位/空轨不入档。 */
function serializeCameraTracks(
  s: StageState,
): Pick<DirectorSceneData, 'recordKeyframes' | 'cameraTracks' | 'cameraCuts'> {
  const slotTracks: Record<string, CameraKeyframe[]> = {};
  const collect = (id: string, ks: CameraKeyframe[]) => {
    if (id === 'free' || ks.length === 0 || !s.cameraSlots.some((c) => c.id === id)) return;
    slotTracks[id] = ks.map((k) => ({ ...k }));
  };
  for (const [id, ks] of s.tracksStore) collect(id, ks);
  collect(s.activeTrack, s.keyframes);
  return {
    recordKeyframes: trackOf(s, 'free').map((k) => ({ ...k })),
    ...(Object.keys(slotTracks).length ? { cameraTracks: slotTracks } : null),
    ...(s.cuts.length ? { cameraCuts: s.cuts.map((c) => ({ ...c })) } : null),
  };
}

/**
 * Blender 式:关键帧 K 在"相机物体"上,所以时间轴移动时相机模型沿轨迹飞。
 * 有镜头轨关键帧的机位 → 模型摆到 t 时刻的插值位姿(纯视觉,不写回机位
 * 「原位」数据);无关键帧 → 停在原位。正被 transform 手柄拖动的机位跳过
 * (避免与用户拖拽互抢)。视锥辅助线随插值 FOV 伸缩。
 */
function syncCamGizmosToTime(s: StageState, t: number): void {
  const dragging = (s.transform as unknown as { dragging?: boolean }).dragging;
  for (const slot of s.cameraSlots) {
    const g = s.camGizmos.get(slot.id);
    if (!g) continue;
    if (dragging && s.selectedCamSlot === slot.id) continue;
    const pose = sampleKeysPose(trackOf(s, slot.id), t);
    if (pose) {
      g.position.set(...pose.position);
      g.quaternion.set(...pose.quaternion);
      updateCamGizmoFrustum(g, { ...slot, fov: pose.fov });
    } else {
      g.position.set(...slot.position);
      g.quaternion.set(...slot.quaternion);
      updateCamGizmoFrustum(g, slot);
    }
  }
}

/**
 * Drive the live camera to the interpolated state at absolute time `t`.
 * 有机位切换点时 = 多机位成片模式(Blender Marker 绑定相机同款):
 * 取 t 时刻的活动机位,走它自己的镜头轨;该轨无关键帧则停在机位静态位姿。
 */
function applyInterpolatedCamera(s: StageState, t: number): void {
  // 机位模型跟着时间轴动(播放 / 拖游标 / 导出采样统一走这里)。
  s.recordT = t;
  syncCamGizmosToTime(s, t);
  const cuts = s.cuts.filter((c) => s.cameraSlots.some((x) => x.id === c.slotId));
  if (cuts.length > 0) {
    let cut = cuts[0];
    for (const c of cuts) {
      if (c.t <= t) cut = c;
      else break;
    }
    const ks = trackOf(s, cut.slotId);
    if (ks.length > 0) {
      applyKeysInterpolated(s, ks, t);
      return;
    }
    const slot = s.cameraSlots.find((x) => x.id === cut.slotId)!;
    s.camera.position.set(...slot.position);
    s.camera.quaternion.set(...slot.quaternion);
    s.camera.fov = slot.fov;
    s.camera.updateProjectionMatrix();
    return;
  }
  applyKeysInterpolated(s, s.keyframes, t);
}

/** 纯采样:一条轨道在 t 时刻的插值位姿(smoothstep 缓入缓出,端点钳制)。 */
function sampleKeysPose(
  ks: readonly CameraKeyframe[],
  t: number,
): { position: [number, number, number]; quaternion: [number, number, number, number]; fov: number } | null {
  if (ks.length === 0) return null;
  const pick = (k: CameraKeyframe) => ({
    position: [...k.position] as [number, number, number],
    quaternion: [...k.quaternion] as [number, number, number, number],
    fov: k.fov,
  });
  if (ks.length === 1 || t <= ks[0].t) return pick(ks[0]);
  const last = ks[ks.length - 1];
  if (t >= last.t) return pick(last);
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].t <= t) i++;
  const a = ks[i];
  const b = ks[i + 1];
  const span = b.t - a.t || 1;
  const u = smoothstep((t - a.t) / span); // ease in/out between frames
  _v0.set(...a.position);
  _v1.set(...b.position);
  _v0.lerp(_v1, u);
  _q0.set(...a.quaternion);
  _q1.set(...b.quaternion);
  _q0.slerp(_q1, u);
  return {
    position: [_v0.x, _v0.y, _v0.z],
    quaternion: [_q0.x, _q0.y, _q0.z, _q0.w],
    fov: a.fov + (b.fov - a.fov) * u,
  };
}

/** Interpolate the live camera along one keyframe track at absolute time `t`. */
function applyKeysInterpolated(s: StageState, ks: readonly CameraKeyframe[], t: number): void {
  const pose = sampleKeysPose(ks, t);
  if (!pose) return;
  s.camera.position.set(...pose.position);
  s.camera.quaternion.set(...pose.quaternion);
  s.camera.fov = pose.fov;
  s.camera.updateProjectionMatrix();
}

function setCameraFromKeyframe(s: StageState, k: CameraKeyframe): void {
  s.camera.position.set(...k.position);
  s.camera.quaternion.set(...k.quaternion);
  s.camera.fov = k.fov;
  s.camera.updateProjectionMatrix();
}

function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/**
 * Export the keyframe camera animation as a video: render at the target
 * resolution, play the camera from the first to the last keyframe time in
 * real time, and capture the canvas stream — same codec/bitrate logic as
 * `recordCanvas`.
 */
async function recordKeyframeAnimation(
  s: StageState,
  opts: RecordOptions,
): Promise<RecordResult> {
  const { resolution, fps, quality, onProgress } = opts;
  const codec = pickRecorderMime();
  if (!codec.available) throw new Error('当前浏览器不支持 MediaRecorder,无法导出视频');
  const canvas = s.renderer.domElement;
  if (typeof canvas.captureStream !== 'function') throw new Error('canvas.captureStream 不可用');

  const ks = s.keyframes;
  // 选择性导出:rangeSec 指定入/出点(时间轴坐标);未指定 = 关键帧全程。
  // 有机位切换点 = 多机位成片:范围覆盖所有轨道末帧与最后切换点。
  let tStart = ks.length ? ks[0].t : 0;
  let tEnd = ks.length ? ks[ks.length - 1].t : 0;
  if (s.cuts.length > 0) {
    tStart = Math.min(tStart, s.cuts[0].t);
    tEnd = Math.max(tEnd, s.cuts[s.cuts.length - 1].t);
    for (const arr of s.tracksStore.values()) {
      if (arr.length) tEnd = Math.max(tEnd, arr[arr.length - 1].t);
    }
  }
  if (opts.rangeSec) {
    const [rIn, rOut] = opts.rangeSec;
    if (Number.isFinite(rIn) && Number.isFinite(rOut) && rOut > rIn) {
      tStart = rIn;
      tEnd = rOut;
    }
  }
  const spanSec = Math.max(opts.durationSec > 0 ? opts.durationSec : tEnd - tStart, 0.2);

  const liveSize = new THREE.Vector2();
  s.renderer.getSize(liveSize);
  const av = liveSize.x / liveSize.y || 16 / 9;
  // 画幅比例与机位共用(directorAspect):null = 全屏,跟随画布比例。
  const ratio = opts.aspect ?? av;
  const { width, height } = computeOutputSize(CAPTURE_RES_SHORT[resolution], ratio);
  const bitrate = computeBitrate(quality, width, height, fps);

  // 渲染缓冲取「恰好罩住输出裁剪框」的尺寸(renderAspectCrop 同款数学):
  // 相机 aspect 保持与实时画面一致 → 取景不变,再居中裁出 width×height,
  // 与录制页黄色取景框所见严格一致。
  let rw: number;
  let rh: number;
  if (ratio <= av) {
    rh = height;
    rw = Math.round(height * av);
  } else {
    rw = width;
    rh = Math.round(width / av);
  }
  rw = Math.max(2, rw - (rw % 2));
  rh = Math.max(2, rh - (rh % 2));

  const prevPR = s.renderer.getPixelRatio();
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(rw, rh, false);
  s.camera.aspect = rw / rh;
  s.camera.updateProjectionMatrix();
  s.recordPlaying = true;
  // 摄像机模型 + 移动/旋转/缩放控制环是编辑辅助物,不进导出视频。
  const prevGizVis = s.camGizmoGroup.visible;
  const prevHelperVis = s.transformHelper.visible;
  s.camGizmoGroup.visible = false;
  s.transformHelper.visible = false;

  // MediaRecorder 录「输出画布」:每帧把 renderer 画布的居中裁剪区 blit 过去
  // (canvas.captureStream 无法直接裁剪)。全屏时 rw==width/rh==height,等价直拷。
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    s.recordPlaying = false;
    s.camGizmoGroup.visible = prevGizVis;
    s.transformHelper.visible = prevHelperVis;
    s.renderer.setPixelRatio(prevPR);
    s.renderer.setSize(liveSize.x, liveSize.y, false);
    s.camera.aspect = liveSize.x / liveSize.y;
    s.camera.updateProjectionMatrix();
    throw new Error('无法创建导出画布');
  }
  const sx = Math.max(0, Math.round((rw - width) / 2));
  const sy = Math.max(0, Math.round((rh - height) / 2));
  const blit = () => ctx.drawImage(canvas, sx, sy, width, height, 0, 0, width, height);

  const stream = out.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: codec.mime, videoBitsPerSecond: bitrate });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const restore = () => {
    s.recordPlaying = false;
    s.camGizmoGroup.visible = prevGizVis;
    s.transformHelper.visible = prevHelperVis;
    s.renderer.setPixelRatio(prevPR);
    s.renderer.setSize(liveSize.x, liveSize.y, false);
    s.camera.aspect = liveSize.x / liveSize.y;
    s.camera.updateProjectionMatrix();
  };

  return new Promise<RecordResult>((resolve, reject) => {
    const durationMs = spanSec * 1000;
    recorder.onerror = (e) => {
      restore();
      reject((e as unknown as { error?: Error }).error ?? new Error('MediaRecorder error'));
    };
    recorder.onstop = () => {
      restore();
      const blob = new Blob(chunks, { type: codec.mime.split(';')[0] });
      resolve({ blob, mime: codec.mime, ext: codec.ext, width, height, durationMs });
    };
    // 先渲一帧并 blit,避免视频开头出现空白帧。
    applyInterpolatedCamera(s, tStart);
    renderStage(s, s.camera);
    blit();
    const start = performance.now();
    recorder.start(200);
    onProgress?.(0);
    const tick = () => {
      const elapsed = performance.now() - start;
      const f = Math.min(1, elapsed / durationMs);
      applyInterpolatedCamera(s, tStart + (tEnd - tStart) * f);
      blit(); // 主循环每帧渲到 renderer 画布,这里同步裁剪到输出画布
      onProgress?.(Math.round(f * 100));
      if (elapsed >= durationMs) {
        try {
          recorder.requestData?.();
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            recorder.stop();
          } catch {
            /* ignore */
          }
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch {
            /* ignore */
          }
        }, 120);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function loadModel(url: string, isFbx: boolean, ext?: string): Promise<THREE.Object3D> {
  const kind = (ext ?? extFromUrl(url) ?? '').toLowerCase();
  if (kind === 'pmx' || kind === 'pmd' || kind === 'zip') {
    // MMD 走独立模块(@moeru/three-mmd + jszip 动态加载,不进主包)。
    return import('./directorMmd').then((m) =>
      m.loadMmdModel(url, kind).then((r) => r.object),
    );
  }
  return new Promise((resolve, reject) => {
    if (isFbx || /\.fbx(\?|$)/i.test(url)) {
      fbxLoader.load(url, (obj) => resolve(obj), undefined, reject);
    } else {
      gltfLoader.load(url, (g) => resolve(g.scene), undefined, reject);
    }
  });
}

/**
 * Snap every SkinnedMesh skeleton to its BIND pose before we measure/ground and
 * capture the rest baseline (mirrors the live app's `Ad`, which calls
 * `skeleton.pose()` then `skeleton.update()`).
 *
 * Why this matters: a mixamo FBX can ship with bone local transforms that are
 * NOT the bind pose (e.g. the blue `y_bot` rig carries a non-bind default frame
 * while its bind matrices encode a clean T-pose). `skeleton.pose()` rebuilds
 * each bone's local transform from `boneInverses`, giving the one pose that is
 * actually consistent with the skinning bind matrices. Capturing rest from any
 * other pose makes absolute-rotation presets tear the mesh apart (上半身漂浮、
 * body shatters) — exactly the blue-mannequin bug.
 */
function resetSkeletonsToBind(obj: THREE.Object3D): void {
  let touched = false;
  obj.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton?.bones?.length) {
      // Clear any non-unit bone scale a la `Ad`, then snap to bind.
      for (const b of sm.skeleton.bones) {
        if (
          b &&
          (Math.abs(b.scale.x - 1) > 1e-3 ||
            Math.abs(b.scale.y - 1) > 1e-3 ||
            Math.abs(b.scale.z - 1) > 1e-3)
        ) {
          b.scale.set(1, 1, 1);
        }
      }
      sm.skeleton.pose();
      sm.skeleton.update?.();
      touched = true;
    }
  });
  if (touched) obj.updateMatrixWorld(true);
}

/**
 * Robustness pass for imported models (user GLB/FBX and catalog assets):
 * - glTF materials default to FrontSide; architecture/interior models viewed
 *   from "outside" a wall get back-face culled and look invisible. DoubleSide
 *   costs a bit of fill rate but never hides geometry (same trade-off most
 *   web viewers make for arbitrary user uploads).
 * - Anisotropic filtering kills the texture shimmer/moiré on grazing-angle
 *   surfaces (floors, slatted doors) that reads as "像素闪动" when orbiting.
 */
function hardenImportedMaterials(
  obj: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
): void {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.side === THREE.FrontSide) m.side = THREE.DoubleSide;
      const std = m as THREE.MeshStandardMaterial;
      for (const tex of [std.map, std.normalMap, std.roughnessMap, std.aoMap]) {
        if (tex && tex.anisotropy < aniso) {
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    }
  });
}

/** Center model on the ground plane and scale tall props down to a workable size.
 *  Exported for unit tests (pure Box3 math, no WebGL needed). */
export function normalizeModel(obj: THREE.Object3D): void {
  // Scale FIRST, then re-measure. Scaling shrinks geometry about the object's
  // own origin (not the bbox centre), so offsets computed from the unscaled box
  // would leave a big model floating above / sunk below the grid and off-centre
  // (visible as a gap under the feet / walls clipped by the camera).
  let box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 6) {
    obj.scale.multiplyScalar(4 / maxDim);
    obj.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(obj);
  }
  const center = box.getCenter(new THREE.Vector3());
  // recentre horizontally, drop to y=0
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;
}

// Reusable temporaries (avoid per-pose allocations).
const _groundBox = new THREE.Box3();
const _meshBox = new THREE.Box3();

/**
 * Lowest world-space Y across all skinned-mesh vertices of `root` in its CURRENT
 * pose, or null if it has no skinned meshes.
 *
 * Per the three.js docs a SkinnedMesh's bounding box is NOT auto-updated and must
 * be recomputed from the current bone transforms via `computeBoundingBox()`
 * (which honors skinning via `getVertexPosition`). We union the per-mesh boxes in
 * world space and return `min.y`. Callers use this to keep the feet at a stable
 * height across pose changes (see `applyPoseToObject`).
 */
function lowestSkinnedY(root: THREE.Object3D): number | null {
  root.updateMatrixWorld(true);
  _groundBox.makeEmpty();
  let found = false;
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) {
      sm.computeBoundingBox();
      if (sm.boundingBox) {
        _meshBox.copy(sm.boundingBox).applyMatrix4(sm.matrixWorld);
        _groundBox.union(_meshBox);
        found = true;
      }
    }
  });
  if (!found || !Number.isFinite(_groundBox.min.y)) return null;
  return _groundBox.min.y;
}

/**
 * Apply a baked pose (absolute local quaternions, keyed by bone name) to a rigged
 * object. Shared by the imperative `applyPose` and project restore so both follow
 * the exact same (primary-bone-only, reset-then-rotate) pipeline. `map=null`
 * returns the rig to its rest pose.
 */
function applyPoseToObject(
  obj: THREE.Object3D,
  map: Record<string, [number, number, number, number]> | null,
): void {
  const bones = collectSkeletonBones(obj);
  // Measure the model's current foot height BEFORE re-posing so we can keep the
  // feet at the same world height afterwards. We intentionally do NOT re-ground
  // to y=0: that would yank a model the user has deliberately moved (e.g. below
  // the floor) back onto the floor every time a pose preset is applied. Holding
  // the pre-pose foot height keeps "feet on floor" for grounded models while
  // fully respecting the user's manual vertical placement.
  const prevLowY = bones.length > 0 ? lowestSkinnedY(obj) : null;
  for (const b of bones) {
    const rest = b.userData?._restQuat as THREE.Quaternion | undefined;
    const restPos = b.userData?._restPos as THREE.Vector3 | undefined;
    if (restPos) b.position.copy(restPos);
    // CRITICAL: these advanced rigs (x_bot / y_bot) are TWO interleaved skeletons
    // — every bone exists twice and one instance is a direct CHILD of its
    // same-named twin (verified via FBX topology dump). The root-level instance
    // is the real anatomical hierarchy; the nested instance is a leaf that just
    // tracks its parent. Posing a NESTED bone applies the rotation a second time
    // on top of the rotation it already inherits from its parent → the bone
    // double-rotates and the mesh distorts ("shatters"). For the red x_bot the
    // doubled bones drive the invisible Joints mesh (so it looked fine); for the
    // blue y_bot they drive the VISIBLE Surface mesh (so blue broke). We
    // therefore pose ONLY the real (non-nested) bones and reset the nested
    // duplicates to rest so they inherit cleanly. Proven equivalent for red and
    // correct for blue by per-vertex diff (scripts/diag-shatter.mjs).
    const nested = hasSameNamedBoneAncestor(b);
    if (!map || nested) {
      if (rest) b.quaternion.copy(rest);
      b.userData._poseBase = (rest ?? b.quaternion).clone();
      continue;
    }
    const key = normBone(b.name);
    const q = map[key] ? map[key] : findByNorm(map, key);
    if (q) {
      b.quaternion.set(q[0], q[1], q[2], q[3]);
      b.userData._poseBase = b.quaternion.clone();
    } else if (rest) {
      b.quaternion.copy(rest);
      b.userData._poseBase = rest.clone();
    }
  }
  updateSkeletons(obj);
  // Preserve the pre-pose foot height (delta-only adjust on Y; X/Z untouched).
  if (bones.length > 0 && prevLowY != null) {
    const newLowY = lowestSkinnedY(obj);
    if (newLowY != null) obj.position.y += prevLowY - newLowY;
  }
}

/**
 * Capture the current pose of a rigged object as { boneName: [qx,qy,qz,qw] },
 * keeping only primary (non-duplicate) bones whose rotation differs from rest.
 * Mirrors the live app's `_serializeBonePose`. Returns null when nothing is posed.
 */
function serializeBonePose(
  obj: THREE.Object3D,
): Record<string, [number, number, number, number]> | null {
  const out: Record<string, [number, number, number, number]> = {};
  for (const b of collectSkeletonBones(obj)) {
    if (hasSameNamedBoneAncestor(b)) continue;
    const rest = b.userData?._restQuat as THREE.Quaternion | undefined;
    const q = b.quaternion;
    if (rest && rest.angleTo(q) < 1e-4) continue; // unchanged → skip
    out[b.name] = [q.x, q.y, q.z, q.w];
  }
  return Object.keys(out).length ? out : null;
}

function selectObject(s: StageState, obj: THREE.Object3D): void {
  // selecting a (possibly different) model exits any bone-posing session.
  if (s.selected !== obj) {
    clearSkeletonHelper(s);
    s.posingBone = null;
  }
  s.selected = obj;
  s.transform.attach(obj);
  s.transform.setMode(s.transform.getMode());
  // notify (read current transform)
  s.transform.dispatchEvent({ type: 'objectChange' } as never);
}

// ── 撤销 / 多选 的纯函数辅助(无 React 闭包) ─────────────────────
/** Capture the LOCAL transform of each object (for gizmo-move undo). */
function captureTransforms(objs: THREE.Object3D[]): TransformSnap[] {
  return objs.map((obj) => ({
    obj,
    p: obj.position.clone(),
    q: obj.quaternion.clone(),
    s: obj.scale.clone(),
  }));
}

/** Restore transforms captured by {@link captureTransforms}. */
function restoreTransforms(snaps: TransformSnap[]): void {
  for (const t of snaps) {
    t.obj.position.copy(t.p);
    t.obj.quaternion.copy(t.q);
    t.obj.scale.copy(t.s);
  }
}

/** True if two snapshot arrays describe the same transforms (skip empty undo). */
function transformsEqual(a: TransformSnap[], b: TransformSnap[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i].p.equals(b[i].p)) return false;
    if (!a[i].q.equals(b[i].q)) return false;
    if (!a[i].s.equals(b[i].s)) return false;
  }
  return true;
}

interface PoseSnap {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  bones: { bone: THREE.Bone; q: THREE.Quaternion; p: THREE.Vector3; base: THREE.Quaternion }[];
}

/** Snapshot a rigged model's full pose (bone quaternions + root Y) for undo. */
function capturePose(obj: THREE.Object3D): PoseSnap {
  const bones = collectSkeletonBones(obj).map((bone) => ({
    bone,
    q: bone.quaternion.clone(),
    // 位置也快照:动画剪辑常带 Hips.position 轨(位移/跳跃),采样/播放会挪骨骼位置。
    p: bone.position.clone(),
    base: ((bone.userData?._poseBase as THREE.Quaternion | undefined) ?? bone.quaternion).clone(),
  }));
  return { obj, pos: obj.position.clone(), bones };
}

/** Restore a pose captured by {@link capturePose}. */
function restorePose(snap: PoseSnap): void {
  for (const b of snap.bones) {
    b.bone.quaternion.copy(b.q);
    b.bone.position.copy(b.p);
    b.bone.userData._poseBase = b.base.clone();
  }
  updateSkeletons(snap.obj);
  snap.obj.position.copy(snap.pos);
}

const _pivotBox = new THREE.Box3();
const _pivotCenter = new THREE.Vector3();
const _pivotAcc = new THREE.Vector3();

/** Move the multi-select pivot to the bounding-box centroid of the selection and
 *  reset its rotation/scale to identity (objects live in modelsGroup at rest). */
function recenterPivot(s: StageState): void {
  if (!s.pivot || s.multi.length === 0) return;
  _pivotAcc.set(0, 0, 0);
  for (const o of s.multi) {
    _pivotBox.setFromObject(o);
    if (_pivotBox.isEmpty()) {
      o.getWorldPosition(_pivotCenter);
    } else {
      _pivotBox.getCenter(_pivotCenter);
    }
    _pivotAcc.add(_pivotCenter);
  }
  _pivotAcc.multiplyScalar(1 / s.multi.length);
  s.pivot.position.copy(_pivotAcc);
  s.pivot.quaternion.identity();
  s.pivot.scale.set(1, 1, 1);
  s.pivot.updateMatrixWorld(true);
}

/** Tear down a multi-selection: objects already live in modelsGroup at rest, so
 *  we just drop the (empty) pivot and clear the set. Safe to call when single. */
function dissolveMulti(s: StageState): void {
  if (s.pivot) {
    s.scene.remove(s.pivot);
    s.pivot = null;
  }
  s.multi = [];
}

/**
 * Normalize a bone name so the various mixamo conventions all collapse to the
 * same key (mirrors the live app's `wd()`):
 *   "mixamorigLeftArm" / "mixamorig:LeftArm" / "LeftArm" → "leftarm"
 */
function normBone(name: string): string {
  const base = String(name || '')
    .replace(/^mixamorig\d*[:_]?/i, '')
    .replace(/^armature[_:]?/i, '')
    .replace(/[.:_\-\s]/g, '')
    .toLowerCase();
  return BONE_ALIASES[base] ?? base;
}

/**
 * Cross-rig bone-name aliases (ported from the live app's `hd` map). Lets poses
 * authored for mixamo skeletons also drive imported rigs that use other naming
 * (e.g. "chest" → "spine2", "lShin" → "leftleg").
 */
const BONE_ALIASES: Record<string, string> = {
  hip: 'hips',
  pelvis: 'hips',
  abdomen: 'spine',
  chest: 'spine2',
  spine01: 'spine',
  spine02: 'spine1',
  spine03: 'spine2',
  neck01: 'neck',
  lcollar: 'leftshoulder',
  lshldr: 'leftarm',
  lforearm: 'leftforearm',
  lhand: 'lefthand',
  lbuttock: 'leftupleg',
  lthigh: 'leftupleg',
  lshin: 'leftleg',
  lfoot: 'leftfoot',
  rcollar: 'rightshoulder',
  rshldr: 'rightarm',
  rforearm: 'rightforearm',
  rhand: 'righthand',
  rbuttock: 'rightupleg',
  rthigh: 'rightupleg',
  rshin: 'rightleg',
  rfoot: 'rightfoot',
};

/** Fallback lookup when the exact mixamorig key is absent: match by normalized name. */
function findByNorm(
  map: Record<string, [number, number, number, number]>,
  normKey: string,
): [number, number, number, number] | undefined {
  for (const k in map) if (normBone(k) === normKey) return map[k];
  return undefined;
}

/** Collect every THREE.Bone under an object (rigged GLTF/FBX SkinnedMesh). */
function collectBones(obj: THREE.Object3D): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  obj.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
  });
  return bones;
}

/**
 * Collect only the bones that actually belong to a SkinnedMesh skeleton,
 * deduped by uuid (mirrors the live app's `bd()`). This is what posing must
 * iterate: traversing *every* `isBone` node also picks up "ghost" bones that
 * are not part of any skin skeleton (the blue `y_bot` rig has 13 of them), and
 * rotating/resetting those corrupts the hierarchy → the body shatters.
 */
function collectSkeletonBones(obj: THREE.Object3D): THREE.Bone[] {
  const seen = new Set<string>();
  const out: THREE.Bone[] = [];
  obj.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton?.bones) {
      for (const b of sm.skeleton.bones) {
        if (b && !seen.has(b.uuid)) {
          seen.add(b.uuid);
          out.push(b);
        }
      }
    }
  });
  // Non-rigged objects have no skinned mesh; fall back to a raw bone scan.
  return out.length ? out : collectBones(obj);
}

/**
 * A "nested duplicate" bone is one that has an ancestor bone of the SAME name.
 *
 * The advanced-mannequin FBX files (x_bot / y_bot) ship with TWO skeletons: the
 * Surface mesh's armature (primary, parented under the root Group) and the
 * Joints mesh's armature, whose 52/64 bones are attached as leaf children
 * directly under their same-named primary bones. Posing a duplicate bone applies
 * the rotation a SECOND time on top of the inherited parent rotation, which
 * tears the Joints mesh apart (the blue rig "shatters"). Posing must therefore
 * skip these — the duplicate bones correctly inherit the pose from their parent.
 * This mirrors the live app's `Bd()`, which only ever resolves the first
 * (primary) bone per name.
 */
function hasSameNamedBoneAncestor(b: THREE.Bone): boolean {
  let p = b.parent as THREE.Bone | null;
  while (p && p.isBone) {
    if (p.name === b.name) return true;
    p = p.parent as THREE.Bone | null;
  }
  return false;
}

/** Refresh skeleton matrices after posing (mirrors the live app's `Nd()`). */
function updateSkeletons(root: THREE.Object3D): void {
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update?.();
  });
  root.updateMatrixWorld?.(true);
}

/** Nesting depth counting only consecutive bone ancestors. */
function boneDepth(b: THREE.Bone): number {
  let depth = 0;
  let p = b.parent;
  while (p && (p as THREE.Bone).isBone) {
    depth++;
    p = p.parent;
  }
  return depth;
}

/** Snapshot each bone's rest quaternion so posing can be undone. */
function storeRestPose(obj: THREE.Object3D): void {
  const bones = collectBones(obj);
  for (const b of bones) {
    b.userData._restQuat = b.quaternion.clone();
    b.userData._restPos = b.position.clone();
    b.userData._poseBase = b.quaternion.clone();
  }
  // a rigged humanoid (X/Y bot) is the "advanced mannequin"
  if (bones.length > 0) obj.userData.isFbxBot = true;
  // rigged meshes can pop out of view when posed; disable culling.
  obj.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
  });
}

function clearSkeletonHelper(s: StageState): void {
  disposeJointHandles(s); // 关节手柄与骨架线同生命周期
  if (!s.skeletonHelper) return;
  s.scene.remove(s.skeletonHelper);
  s.skeletonHelper.geometry.dispose();
  (s.skeletonHelper.material as THREE.Material).dispose();
  s.skeletonHelper = null;
}

// ── 视口骨骼点选:皮肤权重反查 + 关节手柄 ──────────────────────────
const _skinVa = new THREE.Vector3();
const _skinVb = new THREE.Vector3();
const _skinVc = new THREE.Vector3();
const _skinP = new THREE.Vector3();
const _skinBary = new THREE.Vector3();
const _skinTri = new THREE.Triangle();

/**
 * raycast 命中 SkinnedMesh → 权重最高的真实骨骼(嵌套孪生折叠到同名主骨)。
 * 重复点同部位时在权重前 3 的骨骼间轮换(点胸口可在上/下脊柱间切换)。
 */
function boneFromSkinHit(s: StageState, hit: THREE.Intersection): THREE.Bone | null {
  const sm = hit.object as THREE.SkinnedMesh;
  if (!sm.isSkinnedMesh || !hit.face || !sm.skeleton) return null;
  const geo = sm.geometry as THREE.BufferGeometry;
  const skinIndex = geo.getAttribute('skinIndex');
  const skinWeight = geo.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return null;
  const { a, b, c } = hit.face;
  // 蒙皮后的顶点位置(getVertexPosition 计入骨骼形变),局部空间做重心插值。
  sm.getVertexPosition(a, _skinVa);
  sm.getVertexPosition(b, _skinVb);
  sm.getVertexPosition(c, _skinVc);
  sm.worldToLocal(_skinP.copy(hit.point));
  _skinTri.set(_skinVa, _skinVb, _skinVc);
  const bary = _skinTri.getBarycoord(_skinP, _skinBary);
  const [wa, wb, wc] = bary ? [bary.x, bary.y, bary.z] : [1 / 3, 1 / 3, 1 / 3];
  const weights = accumulateBoneWeights(skinIndex, skinWeight, [a, b, c], [wa, wb, wc]);
  const ranked = rankBoneIndices(weights);
  const candidates: THREE.Bone[] = [];
  for (const idx of ranked) {
    let bone = sm.skeleton.bones[idx];
    if (!bone) continue;
    // 折叠嵌套孪生骨(gizmo 驱动它会双重旋转,见 hasSameNamedBoneAncestor)。
    while (
      bone.parent &&
      (bone.parent as THREE.Bone).isBone &&
      bone.parent.name === bone.name
    ) {
      bone = bone.parent as THREE.Bone;
    }
    if (!candidates.some((x) => x.uuid === bone.uuid)) candidates.push(bone);
  }
  if (candidates.length === 0) return null;
  const cycleLen = Math.min(candidates.length, 3);
  const at = s.posingBone ? candidates.findIndex((x) => x.uuid === s.posingBone?.uuid) : -1;
  return at >= 0 && at < cycleLen ? candidates[(at + 1) % cycleLen] : candidates[0];
}

const JOINT_COLOR = new THREE.Color('#eab308');
const JOINT_HOVER = new THREE.Color('#ffffff');
const JOINT_ACTIVE = new THREE.Color('#22d3ee');
const JOINT_IK = new THREE.Color('#fb7185'); // 手/脚末端:可拖拽 IK
const JOINT_POLE = new THREE.Color('#a78bfa'); // pole target:肘/膝朝向

/**
 * 四肢 IK 链(normBone 名):links 被解算旋转,effector 是被拖拽的末端。
 * swing/twist 为根骨(肩/胯)相对休息姿势的限位角(度),对称锥模型:
 * 手臂锥角大(可垂下/前举),大腿更保守;仅 IK/pole 拖拽时钳制,
 * 滑杆/gizmo 手动摆姿不受限。
 */
const IK_CHAINS: { links: string[]; effector: string; swingDeg: number; twistDeg: number }[] = [
  { links: ['leftarm', 'leftforearm'], effector: 'lefthand', swingDeg: 100, twistDeg: 90 },
  { links: ['rightarm', 'rightforearm'], effector: 'righthand', swingDeg: 100, twistDeg: 90 },
  { links: ['leftupleg', 'leftleg'], effector: 'leftfoot', swingDeg: 80, twistDeg: 60 },
  { links: ['rightupleg', 'rightleg'], effector: 'rightfoot', swingDeg: 80, twistDeg: 60 },
];

const _limDelta = new THREE.Quaternion();
const _limRestInv = new THREE.Quaternion();

/** IK 解算后把肩/胯骨相对休息姿势的旋转钳回 swing-twist 锥内(防穿躯干/反掰). */
function clampChainRoot(chain: IkChainRef): void {
  const root = chain.links[0];
  const rest = root.userData?._restQuat as THREE.Quaternion | undefined;
  if (!rest) return;
  _limDelta.copy(_limRestInv.copy(rest).invert()).multiply(root.quaternion);
  if (clampSwingTwist(_limDelta, chain.rootAxis, chain.swingMax, chain.twistMax)) {
    root.quaternion.copy(rest).multiply(_limDelta);
    root.updateMatrixWorld(true);
  }
}
const _jointPos = new THREE.Vector3();
const _jointParentPos = new THREE.Vector3();
const _jointMat = new THREE.Matrix4();
const _jointBox = new THREE.Box3();
const _polePos = new THREE.Vector3();

/** 给选中高级假人的每根真实骨骼建一个可点关节小球(InstancedMesh). */
function buildJointHandles(s: StageState): void {
  disposeJointHandles(s);
  const sel = s.selected;
  if (!sel || !sel.userData?.isFbxBot) return;
  const bones = collectSkeletonBones(sel).filter((b) => !hasSameNamedBoneAncestor(b));
  if (bones.length === 0) return;
  _jointBox.setFromObject(sel);
  const h = _jointBox.isEmpty() ? 1.8 : _jointBox.max.y - _jointBox.min.y;
  // 半径按骨长(到父骨的世界距离)分配:手指骨很短 → 小球;躯干/四肢 → 大球。
  sel.updateMatrixWorld(true);
  const rMin = h * 0.0035;
  const rMax = h * 0.013;
  const radii = bones.map((b) => {
    const p = b.parent as THREE.Bone | null;
    if (!p || !(p as THREE.Bone).isBone) return rMax;
    b.getWorldPosition(_jointPos);
    p.getWorldPosition(_jointParentPos);
    const len = _jointPos.distanceTo(_jointParentPos);
    return THREE.MathUtils.clamp(len * 0.22, rMin, rMax);
  });
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    }),
    bones.length,
  );
  mesh.renderOrder = 999; // 骨架线之上、透视身体
  mesh.frustumCulled = false;
  mesh.name = '__jointHandles';
  s.scene.add(mesh);
  // 手/脚末端小球挂 IK 链(拖拽 = 整条肢体解析二连杆解算)。
  const byNorm = new Map<string, THREE.Bone>();
  for (const b of bones) {
    const k = normBone(b.name);
    if (!byNorm.has(k)) byNorm.set(k, b);
  }
  const ik = new Map<number, IkChainRef>();
  const poleChains: IkChainRef[] = [];
  // pole 位置存模型 userData(普通数组,SkeletonUtils 克隆/骨架开关后仍在)。
  const savedPoles = ((sel.userData._ikPoles ??= {}) as Record<
    string,
    [number, number, number]
  >);
  for (const spec of IK_CHAINS) {
    const effector = byNorm.get(spec.effector);
    const links = spec.links.map((n) => byNorm.get(n));
    if (!effector || links.some((l) => !l)) continue;
    const [upper, lower] = links as THREE.Bone[];
    let poleLocal: THREE.Vector3;
    const saved = savedPoles[spec.effector];
    if (saved) {
      poleLocal = new THREE.Vector3(saved[0], saved[1], saved[2]);
    } else {
      // 默认朝向:膝 → 模型前方(+z),肘 → 模型后方(-z),距肘/膝一臂长。
      const l0 = sel.worldToLocal(upper.getWorldPosition(new THREE.Vector3()));
      const l1 = sel.worldToLocal(lower.getWorldPosition(new THREE.Vector3()));
      const l2 = sel.worldToLocal(effector.getWorldPosition(new THREE.Vector3()));
      const reach = l0.distanceTo(l1) + l1.distanceTo(l2);
      poleLocal = l1.clone();
      poleLocal.z += (spec.effector.includes('foot') ? 1 : -1) * reach;
      savedPoles[spec.effector] = [poleLocal.x, poleLocal.y, poleLocal.z];
    }
    // 根骨指向轴 = 肘/膝的局部位置方向(骨骼空间常量,不随姿势变)。
    const rootAxis = lower.position.clone().normalize();
    if (rootAxis.lengthSq() < 0.5) rootAxis.set(0, 1, 0);
    const chain: IkChainRef = {
      links: links as THREE.Bone[],
      effector,
      poleLocal,
      rootAxis,
      swingMax: THREE.MathUtils.degToRad(spec.swingDeg),
      twistMax: THREE.MathUtils.degToRad(spec.twistDeg),
    };
    ik.set(bones.indexOf(effector), chain);
    poleChains.push(chain);
  }
  // pole 手柄(八面体)+ 肘/膝 → pole 关联虚线。
  let poleMesh: THREE.InstancedMesh | null = null;
  let poleLines: THREE.LineSegments | null = null;
  if (poleChains.length > 0) {
    poleMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      }),
      poleChains.length,
    );
    poleMesh.renderOrder = 999;
    poleMesh.frustumCulled = false;
    poleMesh.name = '__ikPoleHandles';
    s.scene.add(poleMesh);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(poleChains.length * 6), 3),
    );
    poleLines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0xa78bfa,
        transparent: true,
        opacity: 0.35,
        depthTest: false,
      }),
    );
    poleLines.renderOrder = 998;
    poleLines.frustumCulled = false;
    poleLines.name = '__ikPoleLines';
    s.scene.add(poleLines);
  }
  s.joints = {
    mesh,
    bones,
    radii,
    hover: -1,
    ik,
    poleMesh,
    poleChains,
    poleHover: -1,
    poleRadius: rMax * 1.1,
    poleLines,
  };
  refreshJointColors(s);
  updateJointHandles(s);
}

/** 每帧同步关节小球到骨骼世界位置(摆姿/动画播放时跟随). */
function updateJointHandles(s: StageState): void {
  const j = s.joints;
  if (!j) return;
  for (let i = 0; i < j.bones.length; i++) {
    j.bones[i].getWorldPosition(_jointPos);
    const r = j.radii[i];
    _jointMat.makeScale(r, r, r).setPosition(_jointPos);
    j.mesh.setMatrixAt(i, _jointMat);
  }
  j.mesh.instanceMatrix.needsUpdate = true;
  // pole 手柄跟随模型变换;虚线连肘/膝 → pole。
  if (j.poleMesh && s.selected) {
    const linePos = j.poleLines?.geometry.getAttribute('position') as
      | THREE.BufferAttribute
      | undefined;
    for (let i = 0; i < j.poleChains.length; i++) {
      const chain = j.poleChains[i];
      _polePos.copy(chain.poleLocal);
      s.selected.localToWorld(_polePos);
      const r = j.poleRadius;
      _jointMat.makeScale(r, r, r).setPosition(_polePos);
      j.poleMesh.setMatrixAt(i, _jointMat);
      if (linePos) {
        chain.links[1].getWorldPosition(_jointPos); // 肘/膝
        linePos.setXYZ(i * 2, _jointPos.x, _jointPos.y, _jointPos.z);
        linePos.setXYZ(i * 2 + 1, _polePos.x, _polePos.y, _polePos.z);
      }
    }
    j.poleMesh.instanceMatrix.needsUpdate = true;
    if (linePos) linePos.needsUpdate = true;
  }
}

/** 关节配色:选中 = 青,hover = 白,默认 = 琥珀. */
function refreshJointColors(s: StageState): void {
  const j = s.joints;
  if (!j) return;
  for (let i = 0; i < j.bones.length; i++) {
    const active = s.posingBone?.uuid === j.bones[i].uuid;
    const base = j.ik.has(i) ? JOINT_IK : JOINT_COLOR;
    j.mesh.setColorAt(i, active ? JOINT_ACTIVE : i === j.hover ? JOINT_HOVER : base);
  }
  if (j.mesh.instanceColor) j.mesh.instanceColor.needsUpdate = true;
  if (j.poleMesh) {
    for (let i = 0; i < j.poleChains.length; i++) {
      j.poleMesh.setColorAt(i, i === j.poleHover ? JOINT_HOVER : JOINT_POLE);
    }
    if (j.poleMesh.instanceColor) j.poleMesh.instanceColor.needsUpdate = true;
  }
}

function disposeJointHandles(s: StageState): void {
  const j = s.joints;
  if (!j) return;
  s.scene.remove(j.mesh);
  j.mesh.geometry.dispose();
  (j.mesh.material as THREE.Material).dispose();
  j.mesh.dispose();
  if (j.poleMesh) {
    s.scene.remove(j.poleMesh);
    j.poleMesh.geometry.dispose();
    (j.poleMesh.material as THREE.Material).dispose();
    j.poleMesh.dispose();
  }
  if (j.poleLines) {
    s.scene.remove(j.poleLines);
    j.poleLines.geometry.dispose();
    (j.poleLines.material as THREE.Material).dispose();
  }
  s.joints = null;
}

function positionKeyLight(s: StageState): void {
  const az = THREE.MathUtils.degToRad(s.keyAz);
  const el = THREE.MathUtils.degToRad(s.keyEl);
  const r = s.keyDist;
  s.keyLight.position.set(
    r * Math.cos(el) * Math.sin(az),
    r * Math.sin(el),
    r * Math.cos(el) * Math.cos(az),
  );
  s.keyLight.target.position.set(0, 1, 0);
  s.keyLight.target.updateMatrixWorld();
}

function applyPanorama(s: StageState, url: string | null): void {
  if (!url) {
    if (s.panoSphere) {
      s.scene.remove(s.panoSphere);
      (s.panoSphere.material as THREE.MeshBasicMaterial).map?.dispose();
      s.panoSphere.geometry.dispose();
      (s.panoSphere.material as THREE.Material).dispose();
      s.panoSphere = null;
    }
    s.grid.mesh.visible = true;
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(url, (tex) => {
    if (!stateRefAlive(s)) {
      tex.dispose();
      return;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    if (!s.panoSphere) {
      const geo = new THREE.SphereGeometry(60, 60, 40);
      geo.scale(-1, 1, 1); // inside-out
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      s.panoSphere = new THREE.Mesh(geo, mat);
      s.scene.add(s.panoSphere);
    } else {
      const m = s.panoSphere.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.map = tex;
      m.needsUpdate = true;
    }
    s.grid.mesh.visible = false;
    // 全景换图后,若 IBL 开启则用新全景重建环境贴图。
    if (s.envEnabled) {
      s.envRT?.dispose();
      s.envRT = null;
      setSceneEnvironment(s, true, s.fxState.envIntensity);
    }
  });
}

/**
 * IBL:把当前全景经 PMREM 卷积成环境贴图,设为 scene.environment(给金属/PBR
 * 材质真实反射 + 间接光)。无全景时静默置空。
 */
function setSceneEnvironment(s: StageState, enabled: boolean, intensity: number): void {
  s.envEnabled = enabled;
  const sc = s.scene as THREE.Scene & { environmentIntensity?: number };
  if (!enabled) {
    sc.environment = null;
    return;
  }
  const tex = (s.panoSphere?.material as THREE.MeshBasicMaterial | undefined)?.map;
  if (!tex) {
    sc.environment = null;
    return;
  }
  if (!s.pmrem) s.pmrem = new THREE.PMREMGenerator(s.renderer);
  if (!s.envRT) s.envRT = s.pmrem.fromEquirectangular(tex);
  sc.environment = s.envRT.texture;
  sc.environmentIntensity = intensity;
}

/** 把光感/调色参数推到 lightFx + scene.environment,并镜像进 fxState. */
function applyLightFx(s: StageState, p: Partial<DirectorLightFxState>): void {
  const st = s.fxState;
  Object.assign(st, p);
  const fx = s.lightFx;
  fx.setExposure(st.exposure);
  fx.setBloom(st.bloom);
  fx.setContrast(st.contrast);
  fx.setSaturation(st.saturation);
  fx.setTemperature(st.temperature);
  fx.setVignette(st.vignette);
  fx.setGrain(st.grain);
  fx.setToneMapping(st.toneMapping);
  fx.setDof({
    enabled: st.dofEnabled,
    focus: st.dofFocus,
    aperture: st.dofAperture,
    maxBlur: st.dofMaxBlur,
  });
  setSceneEnvironment(s, st.envEnabled, st.envIntensity);
}

function stateRefAlive(s: StageState): boolean {
  return !!s.renderer;
}

/**
 * Render one frame at an optional target output height (px) and return a PNG
 * data URL. Temporarily resizes the drawing buffer (not the CSS size) so the
 * exported image matches the requested resolution, then restores the viewport.
 */
function renderAtResolution(
  s: StageState,
  beforeRender: () => void,
  height?: number,
): string {
  // 摄像机模型 + 移动/旋转/缩放控制环是编辑辅助物,不进截图。
  const prevGizVis = s.camGizmoGroup.visible;
  const prevHelperVis = s.transformHelper.visible;
  s.camGizmoGroup.visible = false;
  s.transformHelper.visible = false;
  const size = new THREE.Vector2();
  s.renderer.getSize(size);
  if (!height || height <= 0) {
    beforeRender();
    renderStage(s, s.camera);
    const dataUrl = s.renderer.domElement.toDataURL('image/png');
    s.camGizmoGroup.visible = prevGizVis;
    s.transformHelper.visible = prevHelperVis;
    return dataUrl;
  }
  const aspect = size.x / size.y;
  const w = Math.round(height * aspect);
  const prevPR = s.renderer.getPixelRatio();
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(w, height, false); // updateStyle=false → keep CSS size
  beforeRender();
  renderStage(s, s.camera);
  const url = s.renderer.domElement.toDataURL('image/png');
  // restore live viewport
  s.camGizmoGroup.visible = prevGizVis;
  s.transformHelper.visible = prevHelperVis;
  s.renderer.setPixelRatio(prevPR);
  s.renderer.setSize(size.x, size.y, false);
  renderStage(s, s.camera);
  return url;
}

/**
 * Render a screenshot cropped to a target aspect ratio, matching the on-screen
 * letterbox 取景框 ("contain" frame). The camera's vertical FOV/framing is kept
 * identical to the live view (camera.aspect stays = viewport aspect), then the
 * centred sub-rectangle of the requested ratio is cropped out via a 2D canvas.
 * Output is exactly `computeOutputSize(short, ratio)` px — so the saved PNG's
 * aspect ratio always matches what the user selected.
 */
function renderAspectCrop(s: StageState, ratio: number, short: number): string {
  const size = new THREE.Vector2();
  s.renderer.getSize(size);
  const av = size.x / size.y || 16 / 9;
  const { width: ow, height: oh } = computeOutputSize(short, ratio);

  // Render buffer sized so the centred crop is exactly ow×oh at 1:1 (no rescale).
  let rw: number, rh: number;
  if (ratio <= av) {
    rh = oh;
    rw = Math.round(oh * av);
  } else {
    rw = ow;
    rh = Math.round(ow / av);
  }
  rw = Math.max(2, rw - (rw % 2));
  rh = Math.max(2, rh - (rh % 2));

  const prevPR = s.renderer.getPixelRatio();
  const prevAspect = s.camera.aspect;
  // 摄像机模型 + 移动/旋转/缩放控制环是编辑辅助物,不进截图。
  const prevGizVis = s.camGizmoGroup.visible;
  const prevHelperVis = s.transformHelper.visible;
  s.camGizmoGroup.visible = false;
  s.transformHelper.visible = false;
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(rw, rh, false);
  s.camera.aspect = rw / rh; // == av → framing unchanged vs live view
  s.camera.updateProjectionMatrix();
  renderStage(s, s.camera);

  const sx = Math.max(0, Math.round((rw - ow) / 2));
  const sy = Math.max(0, Math.round((rh - oh) / 2));
  const out = document.createElement('canvas');
  out.width = ow;
  out.height = oh;
  const ctx = out.getContext('2d');
  let url = '';
  if (ctx) {
    ctx.drawImage(s.renderer.domElement, sx, sy, ow, oh, 0, 0, ow, oh);
    url = out.toDataURL('image/png');
  }

  // restore live viewport + framing
  s.camGizmoGroup.visible = prevGizVis;
  s.transformHelper.visible = prevHelperVis;
  s.renderer.setPixelRatio(prevPR);
  s.renderer.setSize(size.x, size.y, false);
  s.camera.aspect = prevAspect;
  s.camera.updateProjectionMatrix();
  renderStage(s, s.camera);
  return url;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m?.dispose());
    else mat?.dispose();
  });
}

export const DirectorStageScene = memo(forwardRef(DirectorStageInner));
export default DirectorStageScene;
