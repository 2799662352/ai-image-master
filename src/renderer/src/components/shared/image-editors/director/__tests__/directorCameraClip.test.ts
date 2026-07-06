/**
 * directorCameraClip 单测:通用镜头格式(JSON 往返 / 层级烘焙采样 / 预设生成)。
 * 全部纯 three.js 数学,无 WebGL/DOM 依赖。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_CLIP_FORMAT,
  CAMERA_PRESETS,
  MMD_UNIT_SCALE,
  buildCameraPreset,
  cameraClipToJson,
  cameraKeysToClip,
  cameraKeysToVmd,
  clipToCameraKeys,
  findClipCamera,
  newCameraKeyId,
  normalizeCameraKeys,
  parseCameraClipJson,
  parseVmdCameraBuffer,
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

describe('MMD .vmd 相机(社区通用格式)', () => {
  /** 手写一个最小相机 VMD:1 个骨骼帧不带,直接 header + 0/0 + 相机帧。 */
  function buildRawVmd(
    frames: Array<{
      frameNum: number;
      distance: number;
      pos: [number, number, number];
      rot: [number, number, number];
      fov: number;
    }>,
  ): ArrayBuffer {
    const buf = new ArrayBuffer(50 + 12 + frames.length * 61);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const magic = 'Vocaloid Motion Data 0002';
    for (let i = 0; i < magic.length; i++) u8[i] = magic.charCodeAt(i);
    dv.setUint32(50, 0, true);
    dv.setUint32(54, 0, true);
    dv.setUint32(58, frames.length, true);
    let off = 62;
    for (const f of frames) {
      dv.setUint32(off, f.frameNum, true);
      dv.setFloat32(off + 4, f.distance, true);
      dv.setFloat32(off + 8, f.pos[0], true);
      dv.setFloat32(off + 12, f.pos[1], true);
      dv.setFloat32(off + 16, f.pos[2], true);
      dv.setFloat32(off + 20, f.rot[0], true);
      dv.setFloat32(off + 24, f.rot[1], true);
      dv.setFloat32(off + 28, f.rot[2], true);
      dv.setUint32(off + 56, f.fov, true);
      off += 61;
    }
    return buf;
  }

  it('零旋转:eye = target + (0,0,-distance)·scale,z 轴取反(LH→RH)', () => {
    const buf = buildRawVmd([
      { frameNum: 0, distance: -45, pos: [0, 10, 5], rot: [0, 0, 0], fov: 30 },
    ]);
    const { keys } = parseVmdCameraBuffer(buf);
    expect(keys.length).toBe(1);
    const s = MMD_UNIT_SCALE;
    // target_three = (0, 10, -5)·s;distance -45 → 相机在 target 后方 +z 45·s
    expect(keys[0].position[0]).toBeCloseTo(0);
    expect(keys[0].position[1]).toBeCloseTo(10 * s);
    expect(keys[0].position[2]).toBeCloseTo((-5 + 45) * s);
    expect(keys[0].fov).toBe(30);
    expect(keys[0].t).toBe(0);
    // 朝向:-Z 指向 target
    const q = new THREE.Quaternion(...keys[0].quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(fwd.z).toBeCloseTo(-1);
  });

  it('90° yaw:相机绕到目标 +x 侧,朝向仍指向目标', () => {
    const buf = buildRawVmd([
      { frameNum: 30, distance: -45, pos: [0, 0, 0], rot: [0, Math.PI / 2, 0], fov: 30 },
    ]);
    const { keys } = parseVmdCameraBuffer(buf);
    const s = MMD_UNIT_SCALE;
    expect(keys[0].t).toBeCloseTo(1); // 30 帧 / 30fps
    expect(keys[0].position[0]).toBeCloseTo(45 * s);
    expect(keys[0].position[2]).toBeCloseTo(0, 4);
    const q = new THREE.Quaternion(...keys[0].quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(fwd.x).toBeCloseTo(-1); // 从 +x 看向原点
  });

  it('导出 → 解析 往返:机位/朝向/FOV/时间一致', () => {
    const src: CameraKeyframe[] = [
      {
        id: newCameraKeyId(),
        t: 0,
        position: [0, 1.6, 4],
        quaternion: [0, 0, 0, 1],
        fov: 40,
      },
      {
        id: newCameraKeyId(),
        t: 2,
        position: [3, 2.5, -1],
        quaternion: new THREE.Quaternion()
          .setFromEuler(new THREE.Euler(-0.2, 0.9, 0.1, 'YXZ'))
          .toArray() as [number, number, number, number],
        fov: 55,
      },
    ];
    const vmd = cameraKeysToVmd(src);
    const { keys } = parseVmdCameraBuffer(vmd);
    expect(keys.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(keys[i].t).toBeCloseTo(src[i].t, 2);
      for (let a = 0; a < 3; a++) {
        expect(keys[i].position[a]).toBeCloseTo(src[i].position[a], 3);
      }
      expect(keys[i].fov).toBe(src[i].fov);
      const qa = new THREE.Quaternion(...src[i].quaternion);
      const qb = new THREE.Quaternion(...keys[i].quaternion);
      expect(Math.abs(qa.dot(qb))).toBeGreaterThan(0.9999);
    }
  });

  it('导出的 VMD 模型名为「カメラ・照明」(Shift-JIS),MMD 以此识别相机动画', () => {
    const vmd = cameraKeysToVmd([
      { id: newCameraKeyId(), t: 0, position: [0, 0, 5], quaternion: [0, 0, 0, 1], fov: 40 },
    ]);
    const u8 = new Uint8Array(vmd, 30, 12);
    expect([...u8]).toEqual([0x83, 0x4a, 0x83, 0x81, 0x83, 0x89, 0x81, 0x45, 0x8f, 0xc6, 0x96, 0xbe]);
  });

  it('非 VMD / 无相机帧的 VMD 报错友好', () => {
    expect(() => parseVmdCameraBuffer(new ArrayBuffer(10))).toThrow('太短');
    expect(() => parseVmdCameraBuffer(new ArrayBuffer(200))).toThrow('magic');
    const noCam = buildRawVmd([]);
    expect(() => parseVmdCameraBuffer(noCam)).toThrow('没有相机帧');
  });

  it('超多帧抽稀到 CAMERA_KEYS_MAX(保首尾)', () => {
    const frames = Array.from({ length: 600 }, (_, i) => ({
      frameNum: i,
      distance: -45,
      pos: [0, 10, 0] as [number, number, number],
      rot: [0, 0, 0] as [number, number, number],
      fov: 30,
    }));
    const { keys } = parseVmdCameraBuffer(buildRawVmd(frames));
    expect(keys.length).toBe(120);
    expect(keys[0].t).toBeCloseTo(0);
    expect(keys[keys.length - 1].t).toBeCloseTo(599 / 30);
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
    // dolly-zoom / zoom-in 是变焦预设,FOV 会动;其余预设 FOV 恒定。
    const fovAnimated = new Set(['dolly-zoom', 'zoom-in']);
    for (const p of CAMERA_PRESETS) {
      const keys = buildCameraPreset(p.id, base);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys[0].t).toBe(0);
      expect(keys[keys.length - 1].t).toBeCloseTo(p.durationSec);
      if (!fovAnimated.has(p.id)) {
        for (const k of keys) expect(k.fov).toBe(45);
      }
    }
  });

  it('共 16 个预设(8 基础 + 8 进阶)', () => {
    expect(CAMERA_PRESETS.length).toBe(16);
  });

  it('dolly-zoom(希区柯克变焦):tan(fov/2)·距离 ≈ 常数(主体框幅不变)', () => {
    const keys = buildCameraPreset('dolly-zoom', base);
    const target = new THREE.Vector3(...base.target);
    const c0 =
      Math.tan(THREE.MathUtils.degToRad(keys[0].fov / 2)) *
      new THREE.Vector3(...keys[0].position).distanceTo(target);
    for (const k of keys) {
      const c =
        Math.tan(THREE.MathUtils.degToRad(k.fov / 2)) *
        new THREE.Vector3(...k.position).distanceTo(target);
      expect(c).toBeCloseTo(c0, 5);
    }
    // 机位后移、FOV 收窄
    const dEnd = new THREE.Vector3(...keys[keys.length - 1].position).distanceTo(target);
    const d0 = new THREE.Vector3(...keys[0].position).distanceTo(target);
    expect(dEnd).toBeGreaterThan(d0);
    expect(keys[keys.length - 1].fov).toBeLessThan(keys[0].fov);
  });

  it('zoom-in / whip-pan / handheld:机位特征正确', () => {
    const zoom = buildCameraPreset('zoom-in', base);
    expect(zoom[0].position).toEqual(zoom[zoom.length - 1].position);
    expect(zoom[zoom.length - 1].fov).toBeCloseTo(45 * 0.45);

    const whip = buildCameraPreset('whip-pan', base);
    for (const k of whip) expect(k.position).toEqual(whip[0].position);

    const hand = buildCameraPreset('handheld', base);
    expect(hand.length).toBe(13);
    const eye = new THREE.Vector3(...base.position);
    for (const k of hand) {
      expect(new THREE.Vector3(...k.position).distanceTo(eye)).toBeLessThan(0.5);
    }
  });

  it('spiral-up:终点更高且更近;arc-left 全程与目标等距', () => {
    const target = new THREE.Vector3(...base.target);
    const spiral = buildCameraPreset('spiral-up', base);
    expect(spiral[spiral.length - 1].position[1]).toBeGreaterThan(spiral[0].position[1]);

    const arc = buildCameraPreset('arc-left', base);
    const d0 = new THREE.Vector3(...arc[0].position).distanceTo(target);
    for (const k of arc) {
      expect(new THREE.Vector3(...k.position).distanceTo(target)).toBeCloseTo(d0, 5);
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
