/**
 * directorMmd 单测:动作 VMD → AnimationClip 编译 + zip 校验 + 扩展名判定。
 * VMD 二进制按官方布局手工构造(与 directorCameraClip.test.ts 同套路):
 * header 30B 签名 + 20B 模型名,骨骼帧 = 15B 骨名(shift-jis) + 4B 帧号 +
 * 12B 位置 + 16B 四元数 + 64B 插值,截止到 morph 计数即为合法文件
 * (babylon-mmd 的 CheckedCreate 允许 camera/light 段缺省)。
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  attachMmdRuntime,
  isMmdModelExt,
  loadVmdMotionClip,
  zipContainsMmd,
} from '../directorMmd';

interface RawBoneFrame {
  boneName: string; // ASCII(shift-jis 单字节兼容),测试用英文名即可
  frameNum: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
}

function buildMotionVmd(frames: RawBoneFrame[]): ArrayBuffer {
  const BONE_FRAME_BYTES = 111;
  const buf = new ArrayBuffer(50 + 4 + frames.length * BONE_FRAME_BYTES + 4);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const magic = 'Vocaloid Motion Data 0002';
  for (let i = 0; i < magic.length; i++) u8[i] = magic.charCodeAt(i);
  dv.setUint32(50, frames.length, true);
  let off = 54;
  for (const f of frames) {
    for (let i = 0; i < Math.min(15, f.boneName.length); i++) {
      u8[off + i] = f.boneName.charCodeAt(i);
    }
    dv.setUint32(off + 15, f.frameNum, true);
    dv.setFloat32(off + 19, f.pos[0], true);
    dv.setFloat32(off + 23, f.pos[1], true);
    dv.setFloat32(off + 27, f.pos[2], true);
    dv.setFloat32(off + 31, f.quat[0], true);
    dv.setFloat32(off + 35, f.quat[1], true);
    dv.setFloat32(off + 39, f.quat[2], true);
    dv.setFloat32(off + 43, f.quat[3], true);
    off += BONE_FRAME_BYTES;
  }
  dv.setUint32(off, 0, true); // morph keyframe count = 0(文件到此结束,合法)
  return buf;
}

/** 造一个带命名骨骼的最小 SkinnedMesh(buildAnimation 只看 skeleton + morph 字典)。 */
function makeSkinnedMesh(boneNames: string[]): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const bones = boneNames.map((n) => {
    const b = new THREE.Bone();
    b.name = n;
    return b;
  });
  for (const b of bones) mesh.add(b);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.morphTargetDictionary = {};
  return mesh;
}

function stubFetchWith(buf: ArrayBuffer): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => buf }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMmdModelExt', () => {
  it('pmx/pmd/zip(含大写)是 MMD 模型格式,其余不是', () => {
    expect(isMmdModelExt('pmx')).toBe(true);
    expect(isMmdModelExt('PMD')).toBe(true);
    expect(isMmdModelExt('zip')).toBe(true);
    expect(isMmdModelExt('glb')).toBe(false);
    expect(isMmdModelExt('')).toBe(false);
    expect(isMmdModelExt(undefined)).toBe(false);
  });
});

describe('zipContainsMmd', () => {
  it('内含 .pmx 的 zip → true;无模型的 zip → false;非 zip → false', async () => {
    const withPmx = new JSZip();
    withPmx.file('model/miku.pmx', new Uint8Array([1, 2, 3]));
    withPmx.file('model/tex/body.png', new Uint8Array([4]));
    const okBlob = new Blob([await withPmx.generateAsync({ type: 'arraybuffer' })]);
    await expect(zipContainsMmd(okBlob)).resolves.toBe(true);

    const noModel = new JSZip();
    noModel.file('readme.txt', 'hello');
    const badBlob = new Blob([await noModel.generateAsync({ type: 'arraybuffer' })]);
    await expect(zipContainsMmd(badBlob)).resolves.toBe(false);

    await expect(zipContainsMmd(new Blob([new Uint8Array([0, 1, 2])]))).resolves.toBe(false);
  });
});

describe('attachMmdRuntime — Grant 求解门控', () => {
  it('Grant 叠乘非幂等:playing=false 不跑(防静止时累积),playing=true 才叠加', () => {
    const mesh = makeSkinnedMesh(['source', 'granted']);
    const bones = mesh.skeleton.bones;
    // 源骨拧 90°:若 Grant 在静止时也跑,受付与骨会每帧累积这份旋转。
    bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const fakeMmd = {
      mesh,
      iks: [],
      grants: [{ index: 1, parentIndex: 0, ratio: 1, affectRotation: true, isLocal: false }],
    } as unknown as Parameters<typeof attachMmdRuntime>[1];
    const group = new THREE.Group();
    attachMmdRuntime(group, fakeMmd);
    const update = group.userData.mmdUpdate as (playing?: boolean) => void;

    const before = bones[1].quaternion.clone();
    update(false);
    update(); // 默认也是 false
    expect(bones[1].quaternion.angleTo(before)).toBeCloseTo(0);

    update(true);
    expect(bones[1].quaternion.angleTo(before)).toBeCloseTo(Math.PI / 2);
  });
});

describe('loadVmdMotionClip', () => {
  it('骨名匹配 → 产出 .bones[名].position/.quaternion 轨道,30fps 换算时长', async () => {
    stubFetchWith(
      buildMotionVmd([
        { boneName: 'center', frameNum: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] },
        { boneName: 'center', frameNum: 60, pos: [1, 2, 3], quat: [0, 0, 0, 1] },
      ]),
    );
    const mesh = makeSkinnedMesh(['center', 'head']);
    const clip = await loadVmdMotionClip('blob:test-motion', mesh);
    const names = clip.tracks.map((t) => t.name).sort();
    expect(names).toEqual(['.bones[center].position', '.bones[center].quaternion']);
    // 60 帧 / 30fps = 2s
    expect(clip.duration).toBeCloseTo(2);
    // MMD→three 坐标转换:position z 取反(基骨位置为 0 → 直接看增量)
    const posTrack = clip.tracks.find((t) => t.name.endsWith('.position'))!;
    const last = posTrack.values.slice(-3);
    expect(last[0]).toBeCloseTo(1);
    expect(last[1]).toBeCloseTo(2);
    expect(last[2]).toBeCloseTo(-3);
  });

  it('骨名完全不匹配(非 MMD 模型)→ 抛错提示', async () => {
    stubFetchWith(
      buildMotionVmd([{ boneName: 'center', frameNum: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] }]),
    );
    const mesh = makeSkinnedMesh(['mixamorigHips']);
    await expect(loadVmdMotionClip('blob:test-mismatch', mesh)).rejects.toThrow(/骨骼名|MMD/);
  });

  it('同 URL 二次加载复用缓存 buffer(fetch 只发一次)', async () => {
    stubFetchWith(
      buildMotionVmd([{ boneName: 'center', frameNum: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] }]),
    );
    const mesh = makeSkinnedMesh(['center']);
    await loadVmdMotionClip('blob:test-cache', mesh);
    await loadVmdMotionClip('blob:test-cache', mesh);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
