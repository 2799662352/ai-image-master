/**
 * 视口骨骼点选 — 皮肤权重反查(纯函数,供 DirectorStageScene 与单测共用)。
 *
 * 做法来自 three.js 官方论坛的标准实现:raycast 命中 SkinnedMesh 后,取命中
 * 三角形三个顶点的 skinIndex/skinWeight 各 4 路影响,按重心坐标插值累加,
 * 总权重最高的骨骼即「点到的部位」。
 */

/** BufferAttribute 的最小读取面(便于单测用平面对象替身). */
export interface VecAttrLike {
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
  getW(i: number): number;
}

/**
 * 累加命中三角形对各骨骼的插值权重。
 * @param skinIndex  geometry.attributes.skinIndex(每顶点 4 路骨骼索引)
 * @param skinWeight geometry.attributes.skinWeight(每顶点 4 路权重)
 * @param face       命中三角形的三个顶点索引 [a, b, c]
 * @param bary       命中点的重心坐标 [wa, wb, wc](和为 1)
 * @returns Map<骨骼索引, 总权重>
 */
export function accumulateBoneWeights(
  skinIndex: VecAttrLike,
  skinWeight: VecAttrLike,
  face: readonly [number, number, number],
  bary: readonly [number, number, number],
): Map<number, number> {
  const totals = new Map<number, number>();
  const reads = [
    (a: VecAttrLike, i: number) => a.getX(i),
    (a: VecAttrLike, i: number) => a.getY(i),
    (a: VecAttrLike, i: number) => a.getZ(i),
    (a: VecAttrLike, i: number) => a.getW(i),
  ] as const;
  for (let v = 0; v < 3; v++) {
    const vi = face[v];
    const bw = bary[v];
    if (bw <= 0) continue;
    for (const read of reads) {
      const w = read(skinWeight, vi) * bw;
      if (w <= 0) continue;
      const bone = read(skinIndex, vi);
      totals.set(bone, (totals.get(bone) ?? 0) + w);
    }
  }
  return totals;
}

/** 骨骼索引按总权重降序(权重相同保持插入序稳定). */
export function rankBoneIndices(weights: Map<number, number>): number[] {
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([idx]) => idx);
}
