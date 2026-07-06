/**
 * directorCameraClip 单测:通用镜头格式(JSON 往返 / 层级烘焙采样 / 预设生成)。
 * 全部纯 three.js 数学,无 WebGL/DOM 依赖。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_CLIP_FORMAT,
  CAMERA_PRESETS,
  buildCameraPreset,
  cameraClipToJson,
  cameraKeysToClip,
  clipToCameraKeys,
  findClipCamera,
  newCameraKeyId,
  normalizeCameraKeys,
  parseCameraClipJson,
  sampleObjectClip,
  type CameraKeyframe,
} from '../directorCameraClip';

function mkKey(t: number, x: number, fov = 40): CameraKeyframe {
  return {
    id: newCameraKeyId(),
    t,
    position: [x, 1, 5],
    quaternion: [0, 0, 0, 1],
    fov,
  };
}

describe('cameraKeysToClip / JSON 往返', () => {
  it('编译出 position/quaternion/fov 三条标准轨,时长=末帧时间', () => {
    const clip = cameraKeysToClip([mkKey(0, 0), mkKey(2, 4)], 'test');
    expect(clip.duration).toBe(2);
    const names = clip.tracks.map((t) => t.name).sort();
    expect(names).toEqual(['.fov', '.position', '.quaternion']);
  });

  it('空关键帧抛错', () => {
    expect(() => cameraKeysToClip([])).toThrow();
  });

  it('JSON 导出→解析 往返:位置/时间/FOV 一致', () => {
    const keys = [mkKey(0, 0, 30), mkKey(1, 2, 30), mkKey(3, 6, 55)];
    const text = cameraClipToJson(keys, '我的运镜');
    const data = JSON.parse(text);
    expect(data.format).toBe(CAMERA_CLIP_FORMAT);
    expect(data.name).toBe('我的运镜');

    const parsed = parseCameraClipJson(text);
    expect(parsed.name).toBe('我的运镜');
    expect(parsed.keys.length).toBe(3);
    expect(parsed.keys[0].t).toBeCloseTo(0);
    expect(parsed.keys[2].t).toBeCloseTo(3);
    expect(parsed.keys[1].position[0]).toBeCloseTo(2);
    expect(parsed.keys[0].fov).toBeCloseTo(30);
    expect(parsed.keys[2].fov).toBeCloseTo(55);
  });

  it('兼容裸 AnimationClip JSON(无包裹、带节点前缀轨道名、无 fov 轨)', () => {
    const clip = new THREE.AnimationClip('Camera01', 2, [
      new THREE.VectorKeyframeTrack('CameraRig.position', [0, 2], [0, 0, 10, 5, 0, 10]),
      new THREE.QuaternionKeyframeTrack('CameraRig.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const parsed = parseCameraClipJson(JSON.stringify(clip.toJSON()));
    expect(parsed.keys.length).toBe(2);
    expect(parsed.keys[1].position[0]).toBeCloseTo(5);
    expect(parsed.keys[0].fov).toBe(40); // 无 fov 轨 → 默认
  });

  it('非法 JSON(缺 tracks)抛错', () => {
    expect(() => parseCameraClipJson('{"foo":1}')).toThrow();
  });
});

describe('sampleObjectClip(层级烘焙:Blender 相机被父容器包裹的通病)', () => {
  it('动画作用在父容器上,相机世界位姿被正确采样', () => {
    const root = new THREE.Group();
    const container = new THREE.Group();
    container.name = 'CameraRig';
    const cam = new THREE.PerspectiveCamera(35);
    cam.name = 'Camera';
    container.add(cam);
    root.add(container);

    // 容器 0s 在 x=0,2s 移到 x=8;相机自身在容器内偏移 (0,1,0)。
    cam.position.set(0, 1, 0);
    const clip = new THREE.AnimationClip('move', 2, [
      new THREE.VectorKeyframeTrack('CameraRig.position', [0, 2], [0, 0, 0, 8, 0, 0]),
    ]);

    const keys = sampleObjectClip(root, clip, cam);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const first = keys[0];
    const last = keys[keys.length - 1];
    expect(first.position[0]).toBeCloseTo(0);
    expect(first.position[1]).toBeCloseTo(1); // 相机自身偏移叠加
    expect(last.position[0]).toBeCloseTo(8);
    expect(last.fov).toBe(35); // fov 从相机定义读常量
  });

  it('烘焙相机每帧一键 → 抽稀到 maxKeys(保首尾)', () => {
    const root = new THREE.Group();
    const cam = new THREE.PerspectiveCamera(50);
    cam.name = 'cam';
    root.add(cam);
    const n = 240;
    const times = Array.from({ length: n }, (_, i) => i / 24);
    const values = times.flatMap((t) => [t, 0, 0]);
    const clip = new THREE.AnimationClip('baked', times[n - 1], [
      new THREE.VectorKeyframeTrack('cam.position', times, values),
    ]);
    const keys = sampleObjectClip(root, clip, cam, 50);
    expect(keys.length).toBe(50);
    expect(keys[0].t).toBeCloseTo(0);
    expect(keys[keys.length - 1].t).toBeCloseTo(times[n - 1]);
  });
});

describe('findClipCamera', () => {
  it('优先 isCamera 节点;否则回退名字含 cam 的节点', () => {
    const root = new THREE.Group();
    const rig = new THREE.Group();
    rig.name = 'CamRig';
    root.add(rig);
    expect(findClipCamera(root)).toBe(rig);

    const cam = new THREE.PerspectiveCamera();
    root.add(cam);
    expect(findClipCamera(root)).toBe(cam);
  });

  it('找不到返回 null', () => {
    expect(findClipCamera(new THREE.Group())).toBeNull();
  });
});

describe('normalizeCameraKeys', () => {
  it('平移到 startAt、按时间排序、重新分配 id', () => {
    const keys = [mkKey(5, 1), mkKey(3, 0)];
    const out = normalizeCameraKeys(keys, 2);
    expect(out[0].t).toBeCloseTo(2);
    expect(out[1].t).toBeCloseTo(4);
    expect(out[0].id).not.toBe(keys[1].id);
  });
});

describe('buildCameraPreset', () => {
  const base = {
    position: [0, 2, 6] as [number, number, number],
    target: [0, 1, 0] as [number, number, number],
    fov: 45,
  };

  it('每个预设都能生成 ≥2 个关键帧,t 从 0 到 durationSec', () => {
    for (const p of CAMERA_PRESETS) {
      const keys = buildCameraPreset(p.id, base);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys[0].t).toBe(0);
      expect(keys[keys.length - 1].t).toBeCloseTo(p.durationSec);
      for (const k of keys) expect(k.fov).toBe(45);
    }
  });

  it('orbit-360 首尾机位重合(闭环),且始终与目标等距', () => {
    const keys = buildCameraPreset('orbit-360', base);
    const first = new THREE.Vector3(...keys[0].position);
    const last = new THREE.Vector3(...keys[keys.length - 1].position);
    expect(first.distanceTo(last)).toBeLessThan(1e-6);
    const target = new THREE.Vector3(...base.target);
    const d0 = first.distanceTo(target);
    for (const k of keys) {
      expect(new THREE.Vector3(...k.position).distanceTo(target)).toBeCloseTo(d0);
    }
  });

  it('dolly-in 终点距目标 = 起点的 40%', () => {
    const keys = buildCameraPreset('dolly-in', base);
    const target = new THREE.Vector3(...base.target);
    const d0 = new THREE.Vector3(...keys[0].position).distanceTo(target);
    const d1 = new THREE.Vector3(...keys[keys.length - 1].position).distanceTo(target);
    expect(d1 / d0).toBeCloseTo(0.4);
  });

  it('预设关键帧朝向注视目标(相机 -Z 指向目标)', () => {
    const keys = buildCameraPreset('dolly-out', base);
    const k = keys[0];
    const q = new THREE.Quaternion(...k.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const toTarget = new THREE.Vector3(...base.target)
      .sub(new THREE.Vector3(...k.position))
      .normalize();
    expect(fwd.dot(toTarget)).toBeGreaterThan(0.999);
  });

  it('时长可覆盖', () => {
    const keys = buildCameraPreset('pan-lr', base, 10);
    expect(keys[keys.length - 1].t).toBeCloseTo(10);
  });
});
