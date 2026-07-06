import { describe, expect, it } from 'vitest';
import {
  accumulateBoneWeights,
  rankBoneIndices,
  type VecAttrLike,
} from '../directorBonePick';

/** 平面替身:rows[i] = 顶点 i 的 [x,y,z,w] 四路值. */
function attr(rows: [number, number, number, number][]): VecAttrLike {
  return {
    getX: (i) => rows[i][0],
    getY: (i) => rows[i][1],
    getZ: (i) => rows[i][2],
    getW: (i) => rows[i][3],
  };
}

describe('accumulateBoneWeights', () => {
  it('单骨全权重:三顶点都 100% 绑骨 5 → 骨 5 总权重 1', () => {
    const idx = attr([
      [5, 0, 0, 0],
      [5, 0, 0, 0],
      [5, 0, 0, 0],
    ]);
    const w = attr([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    const totals = accumulateBoneWeights(idx, w, [0, 1, 2], [0.2, 0.3, 0.5]);
    expect(totals.get(5)).toBeCloseTo(1);
    expect(totals.size).toBe(1);
  });

  it('重心插值:靠近某顶点时其主导骨权重更高', () => {
    // 顶点 0 绑骨 1,顶点 1/2 绑骨 2;点击点几乎贴着顶点 0。
    const idx = attr([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    const w = attr([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    const totals = accumulateBoneWeights(idx, w, [0, 1, 2], [0.9, 0.05, 0.05]);
    expect(totals.get(1)).toBeCloseTo(0.9);
    expect(totals.get(2)).toBeCloseTo(0.1);
    expect(rankBoneIndices(totals)).toEqual([1, 2]);
  });

  it('多路影响:每顶点 4 路权重都参与累加', () => {
    // 每个顶点同时受骨 0(0.7)和骨 3(0.3)影响。
    const idx = attr([
      [0, 3, 0, 0],
      [0, 3, 0, 0],
      [0, 3, 0, 0],
    ]);
    const w = attr([
      [0.7, 0.3, 0, 0],
      [0.7, 0.3, 0, 0],
      [0.7, 0.3, 0, 0],
    ]);
    const totals = accumulateBoneWeights(idx, w, [0, 1, 2], [1 / 3, 1 / 3, 1 / 3]);
    expect(totals.get(0)).toBeCloseTo(0.7);
    expect(totals.get(3)).toBeCloseTo(0.3);
  });

  it('零权重路不产生假条目(骨 0 占位不计入)', () => {
    // skinIndex 未用路常填 0;权重为 0 时不能把骨 0 记进来。
    const idx = attr([
      [7, 0, 0, 0],
      [7, 0, 0, 0],
      [7, 0, 0, 0],
    ]);
    const w = attr([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    const totals = accumulateBoneWeights(idx, w, [0, 1, 2], [0.5, 0.5, 0]);
    expect(totals.has(0)).toBe(false);
    expect(totals.get(7)).toBeCloseTo(1);
  });
});

describe('rankBoneIndices', () => {
  it('按权重降序', () => {
    const m = new Map<number, number>([
      [4, 0.2],
      [9, 0.5],
      [1, 0.3],
    ]);
    expect(rankBoneIndices(m)).toEqual([9, 1, 4]);
  });

  it('空表 → 空数组', () => {
    expect(rankBoneIndices(new Map())).toEqual([]);
  });
});
