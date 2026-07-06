import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildPoseClip,
  clipToExportJson,
  newKeyframeId,
  parseClipJson,
  POSE_CLIP_FORMAT,
  type PoseKeyframe,
} from '../directorPoseClip';

const Q_ID: [number, number, number, number] = [0, 0, 0, 1];
/** 绕 X 轴 180°(与单位四元数点积为 0,非负,不触发取反). */
const Q_X180: [number, number, number, number] = [1, 0, 0, 0];

function kf(t: number, bones: PoseKeyframe['bones'], rootPos: [number, number, number] = [0, 0, 0]): PoseKeyframe {
  return { id: newKeyframeId(), t, bones, rootPos };
}

describe('buildPoseClip', () => {
  it('每骨骼一条 quaternion 轨 + 一条根位置轨,时长与 times 正确', () => {
    const clip = buildPoseClip(
      [
        kf(0, { Hips: Q_ID, Spine: Q_ID }, [0, 0, 0]),
        kf(2, { Hips: Q_X180, Spine: Q_ID }, [1, 0, -1]),
      ],
      8,
      '测试',
    );
    expect(clip.name).toBe('测试');
    expect(clip.duration).toBe(8);
    // Hips + Spine 两条旋转轨 + .position 一条
    expect(clip.tracks).toHaveLength(3);
    const hips = clip.tracks.find((t) => t.name === 'Hips.quaternion')!;
    expect(hips).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
    expect(Array.from(hips.times)).toEqual([0, 2]);
    expect(Array.from(hips.values)).toEqual([...Q_ID, ...Q_X180]);
    const pos = clip.tracks.find((t) => t.name === '.position')!;
    expect(pos).toBeInstanceOf(THREE.VectorKeyframeTrack);
    expect(Array.from(pos.values)).toEqual([0, 0, 0, 1, 0, -1]);
  });

  it('关键帧乱序输入按 t 排序;时长不小于最后一帧', () => {
    const clip = buildPoseClip([kf(5, { Hips: Q_ID }), kf(1, { Hips: Q_X180 })], 3);
    const hips = clip.tracks.find((t) => t.name === 'Hips.quaternion')!;
    expect(Array.from(hips.times)).toEqual([1, 5]);
    expect(clip.duration).toBe(5); // max(duration=3, lastT=5)
  });

  it('相邻四元数点积为负时取反(slerp 走短弧)', () => {
    const q: [number, number, number, number] = [0, 0, 0, 1];
    const qNeg: [number, number, number, number] = [0, 0, 0, -1]; // 同一旋转的负表示
    const clip = buildPoseClip([kf(0, { Hips: q }), kf(1, { Hips: qNeg })], 1);
    const hips = clip.tracks.find((t) => t.name === 'Hips.quaternion')!;
    // 第二帧应被取反回 [0,0,0,1](+0 归一化,-0 视同 0)
    expect(Array.from(hips.values).map((v) => v + 0)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('某骨骼只在部分帧出现时,其轨道只含在场帧', () => {
    const clip = buildPoseClip(
      [kf(0, { Hips: Q_ID, Neck: Q_ID }), kf(1, { Hips: Q_X180 })],
      1,
    );
    const neck = clip.tracks.find((t) => t.name === 'Neck.quaternion')!;
    expect(Array.from(neck.times)).toEqual([0]);
  });

  it('无关键帧抛错', () => {
    expect(() => buildPoseClip([], 8)).toThrow();
  });
});

describe('clipToExportJson / parseClipJson', () => {
  it('导出→解析往返,轨道与时长保持', () => {
    const clip = buildPoseClip(
      [kf(0, { Hips: Q_ID }, [0, 1, 0]), kf(2, { Hips: Q_X180 }, [0, 2, 0])],
      4,
      '往返',
    );
    const json = clipToExportJson(clip);
    const data = JSON.parse(json) as { format: string; name: string; duration: number };
    expect(data.format).toBe(POSE_CLIP_FORMAT);
    expect(data.name).toBe('往返');
    expect(data.duration).toBe(4);

    const parsed = parseClipJson(json);
    expect(parsed.duration).toBe(4);
    expect(parsed.tracks).toHaveLength(2);
    const hips = parsed.tracks.find((t) => t.name === 'Hips.quaternion')!;
    expect(Array.from(hips.times)).toEqual([0, 2]);
  });

  it('接受裸 AnimationClip.toJSON 结构(无包裹)', () => {
    const clip = buildPoseClip([kf(0, { Hips: Q_ID }), kf(1, { Hips: Q_X180 })], 1);
    const bare = JSON.stringify(clip.toJSON());
    const parsed = parseClipJson(bare);
    expect(parsed.tracks).toHaveLength(2); // Hips + .position
  });

  it('非剪辑 JSON 抛错', () => {
    expect(() => parseClipJson('{"hello":1}')).toThrow();
    expect(() => parseClipJson('[]')).toThrow();
  });
});
