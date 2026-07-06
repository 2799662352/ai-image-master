/**
 * K 动画(姿势关键帧)→ three.js AnimationClip 编译与序列化。
 *
 * 纯函数模块(无 React / 无场景状态),供:
 *  - DirectorStageScene.playPoseClip 预览播放(与 Mixamo FBX 剪辑同构,走同一 mixer 通路);
 *  - DirectorPoseTimeline 导出 .json / 保存到「我的动画」;
 *  - loadAnimClip 的 .json 分支导入(parseClipJson)。
 *
 * 技术依据(three.js r180 官方文档,Context7 核实):
 *  - 每骨骼一条 QuaternionKeyframeTrack(自动 slerp)+ 根位置一条 VectorKeyframeTrack;
 *  - AnimationClip.toJSON() / AnimationClip.parse() 官方序列化往返。
 */

import * as THREE from 'three';

/** 一个姿势关键帧:整姿势打点(全部真实骨骼的局部四元数 + 假人根位置)。 */
export interface PoseKeyframe {
  id: string;
  /** 秒(相对时间轴起点)。 */
  t: number;
  /** 骨骼名 → 局部四元数 [x,y,z,w](只含真实/非嵌套孪生骨骼)。 */
  bones: Record<string, [number, number, number, number]>;
  /** 假人根对象位置 [x,y,z]。 */
  rootPos: [number, number, number];
}

/** 导出 .json 的包裹格式(可再导入本软件;也兼容裸 AnimationClip JSON)。 */
export const POSE_CLIP_FORMAT = 'director-anim@1';

export function newKeyframeId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把关键帧集合编译成 AnimationClip。
 * - 关键帧按 t 排序;每根出现过的骨骼一条 quaternion 轨(只含该骨骼在场的帧);
 * - 根位置一条 `.position` 轨;
 * - 相邻四元数做半球连续化(dot<0 取反),避免 slerp 绕远路;
 * - keys 为空时抛错(调用方先守卫)。
 */
export function buildPoseClip(
  keys: readonly PoseKeyframe[],
  duration: number,
  name = 'K动画',
): THREE.AnimationClip {
  if (keys.length === 0) throw new Error('buildPoseClip: no keyframes');
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const boneNames = new Set<string>();
  for (const k of sorted) for (const b in k.bones) boneNames.add(b);

  const tracks: THREE.KeyframeTrack[] = [];
  for (const bone of boneNames) {
    const times: number[] = [];
    const values: number[] = [];
    let prev: [number, number, number, number] | null = null;
    for (const k of sorted) {
      const q = k.bones[bone];
      if (!q) continue;
      let [x, y, z, w] = q;
      // 半球连续化:与上一帧点积为负则取反(同一旋转,插值走短弧)。
      if (prev && prev[0] * x + prev[1] * y + prev[2] * z + prev[3] * w < 0) {
        x = -x; y = -y; z = -z; w = -w;
      }
      prev = [x, y, z, w];
      times.push(k.t);
      values.push(x, y, z, w);
    }
    if (times.length === 0) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }

  const posTimes = sorted.map((k) => k.t);
  const posValues = sorted.flatMap((k) => k.rootPos);
  tracks.push(new THREE.VectorKeyframeTrack('.position', posTimes, posValues));

  return new THREE.AnimationClip(name, Math.max(duration, sorted[sorted.length - 1].t), tracks);
}

/** 导出为 .json 文本(POSE_CLIP_FORMAT 包裹,含名称/时长元数据)。 */
export function clipToExportJson(clip: THREE.AnimationClip): string {
  return JSON.stringify(
    {
      format: POSE_CLIP_FORMAT,
      name: clip.name,
      duration: clip.duration,
      clip: clip.toJSON(),
    },
    null,
    0,
  );
}

/**
 * 解析动画 .json(接受 POSE_CLIP_FORMAT 包裹或裸 AnimationClip.toJSON() 输出)。
 * 结构不合法时抛错。
 */
export function parseClipJson(text: string): THREE.AnimationClip {
  const data = JSON.parse(text) as Record<string, unknown>;
  const raw = (data && typeof data === 'object' && 'clip' in data ? data.clip : data) as {
    tracks?: unknown[];
  };
  if (!raw || !Array.isArray(raw.tracks)) {
    throw new Error('不是有效的动画 JSON(缺少 tracks)');
  }
  // AnimationClip.parse 的入参就是 toJSON 的输出结构。
  return THREE.AnimationClip.parse(raw as Parameters<typeof THREE.AnimationClip.parse>[0]);
}
