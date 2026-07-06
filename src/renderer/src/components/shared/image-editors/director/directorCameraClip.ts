/**
 * 镜头(相机运镜)剪辑 — 通用格式互换 + 预设生成。
 *
 * 纯函数模块(无 React / 无场景状态),供:
 *  - DirectorRecordTimeline 导出 .json / 导入镜头文件 / 应用预设;
 *  - DirectorStageScene.recordImportClipUrl 的采样管线。
 *
 * 通用格式取舍(2026-07 调研:Blender 手册 glTF 2.0 导出、three.js 论坛
 * #2612/#29085、three.js r180 文档):
 *  - 网上流通的镜头动画事实标准是 **glTF/GLB 相机动画**(Blender「导出 glTF
 *    2.0 + Cameras」;C4D/Maya 烘焙相机同样导出为 glb)与 **FBX**;
 *  - glTF 导出的相机几乎总被包在一个动画父容器里(论坛多次踩坑),因此导入
 *    必须用 AnimationMixer 逐时刻采样**世界矩阵**,不能直接读相机自身轨道;
 *  - glTF 核心规范动画只针对节点 TRS,FOV 不可动画化 → fov 从相机定义读常量;
 *  - 本软件原生 .json = THREE.AnimationClip.toJSON() 包裹(director-camera@1),
 *    与 K 动画(director-anim@1)同构,three.js 生态可直接解析。
 */

import * as THREE from 'three';

/** 录制关键帧:某时刻的相机状态(位置/朝向/FOV),导出时插值成运镜. */
export interface CameraKeyframe {
  id: string;
  t: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
}

/** 导出 .json 的包裹格式(可再导入本软件;也兼容裸 AnimationClip JSON)。 */
export const CAMERA_CLIP_FORMAT = 'director-camera@1';

/** 导入采样的关键帧数上限(烘焙相机常是每帧一键,240 帧 10s → 需抽稀)。 */
export const CAMERA_KEYS_MAX = 120;

const DEFAULT_FOV = 40;

export function newCameraKeyId(): string {
  return `ck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 相邻四元数半球连续化(dot<0 取反),插值走短弧(与 K 动画同款)。 */
function hemisphereContinuity(keys: CameraKeyframe[]): void {
  let prev: [number, number, number, number] | null = null;
  for (const k of keys) {
    let [x, y, z, w] = k.quaternion;
    if (prev && prev[0] * x + prev[1] * y + prev[2] * z + prev[3] * w < 0) {
      x = -x;
      y = -y;
      z = -z;
      w = -w;
      k.quaternion = [x, y, z, w];
    }
    prev = [x, y, z, w];
  }
}

/**
 * 把镜头关键帧编译成 AnimationClip(标准轨道名,three.js 生态可直接用):
 *  - `.position` VectorKeyframeTrack
 *  - `.quaternion` QuaternionKeyframeTrack(半球连续化)
 *  - `.fov` NumberKeyframeTrack(非标准但 three 支持任意属性轨)
 */
export function cameraKeysToClip(
  keys: readonly CameraKeyframe[],
  name = '镜头',
): THREE.AnimationClip {
  if (keys.length === 0) throw new Error('cameraKeysToClip: no keyframes');
  const sorted = [...keys].sort((a, b) => a.t - b.t).map((k) => ({ ...k }));
  hemisphereContinuity(sorted);
  const times = sorted.map((k) => k.t);
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack('.position', times, sorted.flatMap((k) => k.position)),
    new THREE.QuaternionKeyframeTrack('.quaternion', times, sorted.flatMap((k) => k.quaternion)),
    new THREE.NumberKeyframeTrack('.fov', times, sorted.map((k) => k.fov)),
  ];
  return new THREE.AnimationClip(name, times[times.length - 1], tracks);
}

/** 导出为 .json 文本(CAMERA_CLIP_FORMAT 包裹,含名称/时长元数据)。 */
export function cameraClipToJson(keys: readonly CameraKeyframe[], name = '镜头'): string {
  const clip = cameraKeysToClip(keys, name);
  return JSON.stringify(
    { format: CAMERA_CLIP_FORMAT, name: clip.name, duration: clip.duration, clip: clip.toJSON() },
    null,
    0,
  );
}

export interface ParsedCameraClip {
  name: string;
  keys: CameraKeyframe[];
}

/**
 * 解析镜头 .json:接受 CAMERA_CLIP_FORMAT / director-anim@1 包裹或裸
 * AnimationClip.toJSON() 输出;只要含 `.position` / `.quaternion` 结尾的轨道
 * 即可(节点前缀任意 → 兼容网上导出的相机 clip JSON)。结构不合法时抛错。
 */
export function parseCameraClipJson(text: string): ParsedCameraClip {
  const data = JSON.parse(text) as Record<string, unknown>;
  const raw = (data && typeof data === 'object' && 'clip' in data ? data.clip : data) as {
    tracks?: unknown[];
    name?: string;
  };
  if (!raw || !Array.isArray(raw.tracks)) {
    throw new Error('不是有效的镜头 JSON(缺少 tracks)');
  }
  const clip = THREE.AnimationClip.parse(raw as Parameters<typeof THREE.AnimationClip.parse>[0]);
  const keys = clipToCameraKeys(clip);
  if (keys.length === 0) throw new Error('镜头 JSON 里没有 position/quaternion 轨道');
  const name =
    (typeof data.name === 'string' && data.name) || clip.name || '导入镜头';
  return { name, keys };
}

/** 在轨道集合里挑「最像相机」的节点轨:优先节点名含 camera/cam,否则第一条。 */
function pickTrack(
  tracks: THREE.KeyframeTrack[],
  suffix: string,
): THREE.KeyframeTrack | null {
  const ends = tracks.filter((t) => t.name.endsWith(suffix));
  if (ends.length === 0) return null;
  const cam = ends.find((t) => /cam/i.test(t.name.slice(0, -suffix.length)));
  return cam ?? ends[0];
}

/** three 类型定义未导出 createInterpolant(运行时存在);收窄成可调用形状。 */
interface TrackInterpolant {
  evaluate(t: number): ArrayLike<number>;
}

function trackInterpolant(track: THREE.KeyframeTrack): TrackInterpolant {
  return (
    track as THREE.KeyframeTrack & { createInterpolant(): TrackInterpolant }
  ).createInterpolant();
}

/** 均匀抽稀到 max 个采样时刻(保首尾)。 */
function capTimes(times: number[], max: number): number[] {
  if (times.length <= max) return times;
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(t0 + ((t1 - t0) * i) / (max - 1));
  return out;
}

/**
 * 纯轨道采样:从 AnimationClip 的 `.position`/`.quaternion`(/`.fov`)轨直接
 * 插值出镜头关键帧(用于 JSON 导入 —— 无节点层级,轨道值即相机位姿)。
 * 采样时刻 = 两轨时间并集(抽稀到 CAMERA_KEYS_MAX)。
 */
export function clipToCameraKeys(
  clip: THREE.AnimationClip,
  maxKeys = CAMERA_KEYS_MAX,
): CameraKeyframe[] {
  const pos = pickTrack(clip.tracks, '.position');
  const quat = pickTrack(clip.tracks, '.quaternion');
  if (!pos || !quat) return [];
  const fov = pickTrack(clip.tracks, '.fov');

  const timeSet = new Set<number>();
  for (const t of pos.times) timeSet.add(t);
  for (const t of quat.times) timeSet.add(t);
  const times = capTimes([...timeSet].sort((a, b) => a - b), maxKeys);

  const posIt = trackInterpolant(pos);
  const quatIt = trackInterpolant(quat);
  const fovIt = fov ? trackInterpolant(fov) : null;

  const keys: CameraKeyframe[] = times.map((t) => {
    const p = posIt.evaluate(t);
    const q = quatIt.evaluate(t);
    const f = fovIt ? fovIt.evaluate(t)[0] : DEFAULT_FOV;
    return {
      id: newCameraKeyId(),
      t,
      position: [p[0], p[1], p[2]],
      quaternion: [q[0], q[1], q[2], q[3]],
      fov: f,
    };
  });
  hemisphereContinuity(keys);
  return keys;
}

/** 在导入的场景图里找相机节点:isCamera 优先,否则名字含 cam 的节点。 */
export function findClipCamera(root: THREE.Object3D): THREE.Object3D | null {
  let cam: THREE.Object3D | null = null;
  let named: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!cam && (o as THREE.Camera).isCamera) cam = o;
    if (!named && /cam/i.test(o.name)) named = o;
  });
  return cam ?? named;
}

/**
 * 层级烘焙采样(glTF/FBX 导入的核心):在 root 上跑 AnimationMixer,逐采样
 * 时刻 setTime → 更新世界矩阵 → 取 cameraObj 的**世界**位置/朝向。
 * 解决「Blender 导出的相机被包在动画父容器里」的通病 —— 无论动画作用在
 * 相机自身还是任意祖先,世界矩阵采样都正确。
 * 采样时刻 = 全部轨道时间并集(抽稀到 maxKeys;不足 2 个时用 [0, duration])。
 */
export function sampleObjectClip(
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
  cameraObj: THREE.Object3D,
  maxKeys = CAMERA_KEYS_MAX,
): CameraKeyframe[] {
  const timeSet = new Set<number>();
  for (const track of clip.tracks) for (const t of track.times) timeSet.add(t);
  let times = [...timeSet].sort((a, b) => a - b);
  if (times.length < 2) times = [0, Math.max(0.1, clip.duration)];
  times = capTimes(times, maxKeys);

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  // LoopOnce + clamp:默认 LoopRepeat 在 t == duration 会取模回 0,导致末帧
  // 采样成首帧;采样还额外收 1e-4 的 epsilon 双保险。
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const tMax = Math.max(0, clip.duration - 1e-4);

  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const fov = (cameraObj as THREE.PerspectiveCamera).isPerspectiveCamera
    ? (cameraObj as THREE.PerspectiveCamera).fov
    : DEFAULT_FOV;

  const keys: CameraKeyframe[] = times.map((t) => {
    mixer.setTime(Math.min(t, tMax));
    root.updateMatrixWorld(true);
    cameraObj.getWorldPosition(wp);
    cameraObj.getWorldQuaternion(wq);
    return {
      id: newCameraKeyId(),
      t,
      position: [wp.x, wp.y, wp.z],
      quaternion: [wq.x, wq.y, wq.z, wq.w],
      fov,
    };
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  hemisphereContinuity(keys);
  return keys;
}

/** 排序 + 时间平移到 startAt + 重新分配 id(导入/预设装入时间轴前的归一)。 */
export function normalizeCameraKeys(
  keys: readonly CameraKeyframe[],
  startAt = 0,
): CameraKeyframe[] {
  if (keys.length === 0) return [];
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  return sorted.map((k) => ({
    ...k,
    id: newCameraKeyId(),
    t: startAt + (k.t - t0),
  }));
}

// ── 镜头预设(以当前相机位姿 + 目标点为基准的参数化运镜) ────────────

export type CameraPresetId =
  | 'orbit-360'
  | 'orbit-180'
  | 'dolly-in'
  | 'dolly-out'
  | 'crane-up'
  | 'crane-down'
  | 'pan-lr'
  | 'pull-reveal';

export interface CameraPresetInfo {
  id: CameraPresetId;
  name: string;
  desc: string;
  /** 默认时长(秒),UI 可覆盖。 */
  durationSec: number;
}

export const CAMERA_PRESETS: readonly CameraPresetInfo[] = [
  { id: 'orbit-360', name: '环绕 360°', desc: '绕目标一整圈(等距等高)', durationSec: 8 },
  { id: 'orbit-180', name: '环绕 180°', desc: '绕目标半圈', durationSec: 5 },
  { id: 'dolly-in', name: '推近 Dolly In', desc: '沿视线推近到 40% 距离', durationSec: 4 },
  { id: 'dolly-out', name: '拉远 Dolly Out', desc: '沿视线拉远到 200% 距离', durationSec: 4 },
  { id: 'crane-up', name: '升镜 Crane Up', desc: '垂直升起并俯视目标', durationSec: 5 },
  { id: 'crane-down', name: '降镜 Crane Down', desc: '垂直降落并仰视目标', durationSec: 5 },
  { id: 'pan-lr', name: '横摇 Pan', desc: '机位不动,镜头左→右扫过', durationSec: 4 },
  { id: 'pull-reveal', name: '后拉揭示', desc: '拉远 + 升高的组合揭示', durationSec: 6 },
];

/** 预设的基准:当前相机位置 / 注视目标 / FOV(从 stage getCameraPose 取)。 */
export interface CameraPresetBase {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** 相机看向 target 的四元数(three 相机 -Z 朝前:Matrix4.lookAt(eye,target,up))。 */
function lookAtQuat(eye: THREE.Vector3, target: THREE.Vector3): [number, number, number, number] {
  _m.lookAt(eye, target, UP);
  const q = new THREE.Quaternion().setFromRotationMatrix(_m);
  return [q.x, q.y, q.z, q.w];
}

function key(
  t: number,
  eye: THREE.Vector3,
  target: THREE.Vector3,
  fov: number,
): CameraKeyframe {
  return {
    id: newCameraKeyId(),
    t,
    position: [eye.x, eye.y, eye.z],
    quaternion: lookAtQuat(eye, target),
    fov,
  };
}

/**
 * 生成预设镜头关键帧(t 从 0 开始,时长 durationSec)。
 * 全部以「当前相机 → 目标点」为基准参数化,应用即所见。
 */
export function buildCameraPreset(
  id: CameraPresetId,
  base: CameraPresetBase,
  durationSec?: number,
): CameraKeyframe[] {
  const info = CAMERA_PRESETS.find((p) => p.id === id);
  const dur = Math.max(0.5, durationSec ?? info?.durationSec ?? 5);
  const eye = new THREE.Vector3(...base.position);
  const target = new THREE.Vector3(...base.target);
  const fov = base.fov || DEFAULT_FOV;
  const offset = eye.clone().sub(target);
  const keys: CameraKeyframe[] = [];

  switch (id) {
    case 'orbit-360':
    case 'orbit-180': {
      // 8 段 45°(360°)/ 4 段 45°(180°):等高等距绕 target 的 Y 轴。
      const sweep = id === 'orbit-360' ? Math.PI * 2 : Math.PI;
      const steps = id === 'orbit-360' ? 8 : 4;
      for (let i = 0; i <= steps; i++) {
        const a = (sweep * i) / steps;
        const p = offset.clone().applyAxisAngle(UP, a).add(target);
        keys.push(key((dur * i) / steps, p, target, fov));
      }
      break;
    }
    case 'dolly-in':
    case 'dolly-out': {
      const endScale = id === 'dolly-in' ? 0.4 : 2.0;
      const end = target.clone().add(offset.clone().multiplyScalar(endScale));
      keys.push(key(0, eye, target, fov));
      keys.push(key(dur, end, target, fov));
      break;
    }
    case 'crane-up':
    case 'crane-down': {
      const dist = offset.length();
      const dy = (id === 'crane-up' ? 1 : -1) * Math.max(0.5, dist * 0.8);
      const mid = eye.clone().add(new THREE.Vector3(0, dy * 0.5, 0));
      const end = eye.clone().add(new THREE.Vector3(0, dy, 0));
      keys.push(key(0, eye, target, fov));
      keys.push(key(dur * 0.5, mid, target, fov));
      keys.push(key(dur, end, target, fov));
      break;
    }
    case 'pan-lr': {
      // 机位固定,注视点绕机位水平 ±25° 扫过(左 → 中 → 右)。
      const swing = THREE.MathUtils.degToRad(25);
      const toT = target.clone().sub(eye);
      const left = eye.clone().add(toT.clone().applyAxisAngle(UP, swing));
      const right = eye.clone().add(toT.clone().applyAxisAngle(UP, -swing));
      keys.push(key(0, eye, left, fov));
      keys.push(key(dur * 0.5, eye, target, fov));
      keys.push(key(dur, eye, right, fov));
      break;
    }
    case 'pull-reveal': {
      const dist = offset.length();
      const end = target
        .clone()
        .add(offset.clone().multiplyScalar(2.2))
        .add(new THREE.Vector3(0, Math.max(0.5, dist * 0.6), 0));
      const mid = eye.clone().lerp(end, 0.45);
      keys.push(key(0, eye, target, fov));
      keys.push(key(dur * 0.5, mid, target, fov));
      keys.push(key(dur, end, target, fov));
      break;
    }
    default: {
      const never: never = id;
      throw new Error(`unknown camera preset: ${String(never)}`);
    }
  }
  hemisphereContinuity(keys);
  return keys;
}
