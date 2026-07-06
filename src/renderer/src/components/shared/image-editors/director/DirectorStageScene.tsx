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
import { buildPoseClip, parseClipJson, type PoseKeyframe } from './directorPoseClip';

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

/** 录制关键帧:某时刻的相机状态(位置/朝向/FOV),导出时插值成运镜. */
export interface CameraKeyframe {
  id: string;
  t: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
}

/** 机位属性面板可编辑的字段(实站右侧「属性」). */
export interface CameraSlotPatch {
  name?: string;
  position?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  showRay?: boolean;
}

export interface RecordOptions {
  /** 录制时长(秒). */
  durationSec: number;
  resolution: CaptureResolution;
  fps: RecordFps;
  quality: RecordQualityKey;
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
  /** catalog id, `adv-<color>` for advanced, or an IndexedDB asset id for imports. */
  modelId?: string;
  /** crowd layout opts (普通假人/路人) when source==='crowd'. */
  crowd?: CrowdOpts;
}

/** Per-object snapshot inside a saved project (transform + meta + pose). */
export interface DirectorModelState extends DirectorModelMeta {
  name: string;
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: [number, number, number];
  /** bone pose for rigged models: { boneName: [qx,qy,qz,qw] }. */
  bonePose?: Record<string, [number, number, number, number]>;
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
  // 动画是瞬态预览:不入撤销栈、不进「保存工程」序列化;停止时恢复播放前姿势。
  /**
   * Load + loop an animation clip on the selected advanced mannequin.
   * `ext` 指明格式(fbx/glb/gltf/json);省略时按 URL 扩展名推断,默认 fbx。
   */
  playAnimation(url: string, name?: string, ext?: string): Promise<void>;
  pauseAnimation(): void;
  resumeAnimation(): void;
  /** Stop and restore the pose captured before playback started. */
  stopAnimation(): void;
  /** Jump to `sec` (clamped to [0, duration]); works both playing and paused. */
  seekAnimation(sec: number): void;
  // ── K 动画(姿势关键帧;数据由 UI 持有,场景只负责取样/编译/播放) ──
  /** 读选中假人当前姿势为一帧数据(真实骨骼四元数 + 根位置);非高级假人 → null. */
  capturePoseKeyframe(): Pick<PoseKeyframe, 'bones' | 'rootPos'> | null;
  /** 把一帧姿势应用回选中假人(时间轴 scrub 单帧预览;不入撤销栈). */
  applyPoseKeyframe(k: Pick<PoseKeyframe, 'bones' | 'rootPos'>): void;
  /** 把关键帧集合编译为剪辑并在选中假人上循环播放(走与目录动画同一 mixer 通路). */
  playPoseClip(keys: readonly PoseKeyframe[], duration: number, name?: string): Promise<void>;
  /** 把关键帧集合编译为剪辑并连同选中假人导出为 .glb(GLTFExporter 按需加载). */
  exportPoseClipGlb(keys: readonly PoseKeyframe[], duration: number, name?: string): Promise<Blob>;
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
  recordListKeyframes(): CameraKeyframe[];
  recordRemoveKeyframe(id: string): void;
  recordClearKeyframes(): void;
  /** Seek the camera to time `t` by interpolating between keyframes. */
  recordSeek(t: number): void;
  /** Play 0→duration, optionally looping; returns a stop fn. */
  recordPlay(durationSec: number, onTime: (t: number) => void, onDone: () => void): () => void;
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
  frameId: number;
  keyAz: number;
  keyEl: number;
  keyDist: number;
  cameraSlots: CameraSlot[];
  recording: boolean;
  /** Lines visualizing each slot's camera→target ray (keyed by slot id). */
  rayGroup: THREE.Group;
  rayLines: Map<string, THREE.Line>;
  /** Offscreen render target + camera reused for preview thumbnails. */
  thumbRT: THREE.WebGLRenderTarget | null;
  thumbCam: THREE.PerspectiveCamera;
  /** Recording keyframe state. */
  keyframes: CameraKeyframe[];
  recordPlaying: boolean;
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

  useEffect(() => {
    onSelRef.current = onSelectionChange;
  }, [onSelectionChange]);
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
  ) => {
    const st = stateRef.current;
    if (!st || !target.parent) return; // 场景已卸载 / 目标已被删除
    // 每个假人各自持有 mixer:给 B 播不影响 A(多假人同时播)。
    const prev = st.anims.get(target); // 同目标换剪辑:复用快照与 mixer
    const poseSnap = prev ? prev.poseSnap : capturePose(target);
    const mixer = prev ? prev.mixer : new THREE.AnimationMixer(target);
    mixer.stopAllAction();
    const action = mixer.clipAction(retargetClipTracks(clip, target));
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    st.anims.set(target, { mixer, action, target, poseSnap, duration: clip.duration, url, name });
    emitAnimTick();
  };

  // ── 选择(单选 / 框选多选) ─────────────────────────────────────
  const deselectAll = () => {
    const s = stateRef.current;
    if (!s) return;
    dissolveMulti(s);
    s.transform.detach();
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
        const obj = await loadModel(url, !!opts?.isFbx);
        if (!stateRef.current) return; // unmounted mid-load
        // Snap rigs to their bind pose first so measuring/grounding and the
        // captured rest baseline are consistent with the skinning bind matrices.
        resetSkeletonsToBind(obj);
        // Normalize: center on ground, scale to a sensible height.
        normalizeModel(obj);
        if (opts?.position) obj.position.set(...opts.position);
        obj.userData.modelId = opts?.modelId;
        // Tag how this object was created so 「保存工程」 can recreate it later.
        const advanced = !!opts?.modelId && opts.modelId.startsWith('adv-');
        obj.userData.directorMeta = {
          source: advanced ? 'advanced' : 'model',
          url,
          isFbx: !!opts?.isFbx,
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
      async playAnimation(url, name = '', ext) {
        const s = stateRef.current;
        const target = s?.selected;
        if (!s || !target || !target.userData?.isFbxBot) return;
        const clip = await loadAnimClip(url, ext);
        if (stateRef.current?.selected !== target) return; // 加载期间选择已变,丢弃
        startClipOnTarget(target, clip, url, name);
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
        for (const b of collectSkeletonBones(target)) {
          if (hasSameNamedBoneAncestor(b)) continue;
          const q = b.quaternion;
          bones[b.name] = [q.x, q.y, q.z, q.w];
        }
        return {
          bones,
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
        };
        // Replace any keyframe at (almost) the same time, else insert sorted.
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
      recordClearKeyframes() {
        const s = stateRef.current;
        if (s) s.keyframes = [];
      },
      recordSeek(t) {
        const s = stateRef.current;
        if (!s || s.keyframes.length === 0) return;
        applyInterpolatedCamera(s, t);
      },
      recordPlay(durationSec, onTime, onDone) {
        const s = stateRef.current;
        if (!s || s.keyframes.length === 0) {
          onDone();
          return () => {};
        }
        s.recordPlaying = true;
        const start = performance.now();
        const durMs = Math.max(100, durationSec * 1000);
        const step = () => {
          if (!s.recordPlaying) return;
          const elapsed = performance.now() - start;
          const t = Math.min(durationSec, elapsed / 1000);
          applyInterpolatedCamera(s, t);
          onTime(t);
          if (elapsed >= durMs) {
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
        if (s.keyframes.length < 1) return Promise.reject(new Error('请先添加关键帧'));
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
        };
      },
      async restoreScene(data, resolveUrl) {
        const s = stateRef.current;
        if (!s || !data || data.version !== 1) return;
        // 1) clear existing models.
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
              obj = await loadModel(url, !!m.isFbx);
              if (!stateRef.current) return; // unmounted mid-load
              resetSkeletonsToBind(obj);
            }
            if (!obj) continue;
            obj.userData.modelId = m.modelId;
            obj.userData.name = m.name;
            obj.userData.directorMeta = {
              source: m.source,
              url: m.url,
              isFbx: m.isFbx,
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
          } catch {
            /* skip a model that fails to load (e.g. stale blob URL) */
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

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode('translate');
    transform.addEventListener('dragging-changed', (e) => {
      const dragging = e.value as boolean;
      orbit.enabled = !dragging;
      const st = stateRef.current;
      if (!st) return;
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
      frameId: 0,
      keyAz: LIGHT_DEFAULTS.key.azimuthDeg,
      keyEl: LIGHT_DEFAULTS.key.elevationDeg,
      keyDist: 10,
      cameraSlots: [],
      recording: false,
      rayGroup,
      rayLines: new Map(),
      thumbRT: null,
      thumbCam: new THREE.PerspectiveCamera(40, 16 / 9, SCENE.cameraNear, SCENE.cameraFar),
      keyframes: [],
      recordPlaying: false,
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
    transform.addEventListener('objectChange', () => {
      if (state.selected) onSelRef.current?.(selectionInfo(state.selected));
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
      // Default mode: click selects; left-drag still rotates the view (orbit).
      const root = pickRoot(e.clientX, e.clientY);
      if (root) selectMany([root]);
    };
    canvas.addEventListener('pointerdown', onPointerDown);

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
      const dt = state.clock.getDelta();
      for (const a of state.anims.values()) a.mixer.update(dt);
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
    cam.position.set(...slot.position);
    cam.quaternion.set(...slot.quaternion);
    cam.fov = slot.fov;
  } else {
    cam.position.copy(s.camera.position);
    cam.quaternion.copy(s.camera.quaternion);
    cam.fov = s.camera.fov;
  }
  cam.aspect = w / h;
  cam.updateProjectionMatrix();

  renderStageToTarget(s, cam, s.thumbRT);

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

/** Drive the live camera to the interpolated state at absolute time `t`. */
function applyInterpolatedCamera(s: StageState, t: number): void {
  const ks = s.keyframes;
  if (ks.length === 0) return;
  if (ks.length === 1 || t <= ks[0].t) {
    setCameraFromKeyframe(s, ks[0]);
    return;
  }
  const last = ks[ks.length - 1];
  if (t >= last.t) {
    setCameraFromKeyframe(s, last);
    return;
  }
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
  s.camera.position.copy(_v0);
  s.camera.quaternion.copy(_q0);
  s.camera.fov = a.fov + (b.fov - a.fov) * u;
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
  const tStart = ks[0].t;
  const tEnd = ks[ks.length - 1].t;
  const spanSec = Math.max(opts.durationSec > 0 ? opts.durationSec : tEnd - tStart, 0.2);

  const liveSize = new THREE.Vector2();
  s.renderer.getSize(liveSize);
  const aspect = liveSize.x / liveSize.y || 16 / 9;
  const { width, height } = computeOutputSize(CAPTURE_RES_SHORT[resolution], aspect);
  const bitrate = computeBitrate(quality, width, height, fps);

  const prevPR = s.renderer.getPixelRatio();
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(width, height, false);
  s.camera.aspect = width / height;
  s.camera.updateProjectionMatrix();
  s.recordPlaying = true;

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: codec.mime, videoBitsPerSecond: bitrate });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const restore = () => {
    s.recordPlaying = false;
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
    const start = performance.now();
    recorder.start(200);
    onProgress?.(0);
    const tick = () => {
      const elapsed = performance.now() - start;
      const f = Math.min(1, elapsed / durationMs);
      applyInterpolatedCamera(s, tStart + (tEnd - tStart) * f);
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

function loadModel(url: string, isFbx: boolean): Promise<THREE.Object3D> {
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

/** Center model on the ground plane and scale tall props down to a workable size. */
function normalizeModel(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // recentre horizontally, drop to y=0
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 6) {
    const k = 4 / maxDim;
    obj.scale.multiplyScalar(k);
  }
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
  bones: { bone: THREE.Bone; q: THREE.Quaternion; base: THREE.Quaternion }[];
}

/** Snapshot a rigged model's full pose (bone quaternions + root Y) for undo. */
function capturePose(obj: THREE.Object3D): PoseSnap {
  const bones = collectSkeletonBones(obj).map((bone) => ({
    bone,
    q: bone.quaternion.clone(),
    base: ((bone.userData?._poseBase as THREE.Quaternion | undefined) ?? bone.quaternion).clone(),
  }));
  return { obj, pos: obj.position.clone(), bones };
}

/** Restore a pose captured by {@link capturePose}. */
function restorePose(snap: PoseSnap): void {
  for (const b of snap.bones) {
    b.bone.quaternion.copy(b.q);
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
  if (!s.skeletonHelper) return;
  s.scene.remove(s.skeletonHelper);
  s.skeletonHelper.geometry.dispose();
  (s.skeletonHelper.material as THREE.Material).dispose();
  s.skeletonHelper = null;
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
  const size = new THREE.Vector2();
  s.renderer.getSize(size);
  if (!height || height <= 0) {
    beforeRender();
    renderStage(s, s.camera);
    return s.renderer.domElement.toDataURL('image/png');
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
