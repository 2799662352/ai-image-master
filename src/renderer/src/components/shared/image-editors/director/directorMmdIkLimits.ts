/**
 * MMD IK 链角度限制的「左手系 → 右手系」转换(纯函数,无 three 依赖)。
 *
 * @moeru/three-mmd 的 buildIK 把 PMX ik link 的 rotationMin/Max 原样透传
 * (左手系欧拉角);three.js 官方 MMDLoader(r171)在这里显式做了转换
 * (源码注释:"Convert Left to Right coordinate by myself because MMDParser
 * doesn't convert. It's a MMDParser's bug"):x、y 分量取反 —— 取反会翻转
 * 大小关系,所以这两个分量的 min/max 要互换;z 分量不动。
 *
 * 就地修改传入的 iks(CCDIKSolver 直接消费同一份数组)。膝盖链走
 * limitation 轴(buildIK 不给膝盖发 rotationMin/Max),不受影响。
 */

interface XyzLike {
  x: number;
  y: number;
  z: number;
}

interface IkLinkLike {
  index?: number;
  enabled?: boolean;
  rotationMin?: XyzLike;
  rotationMax?: XyzLike;
}

export interface IkChainLike {
  links: IkLinkLike[];
}

export function convertIkLimitsToRightHanded(iks: readonly IkChainLike[]): void {
  for (const ik of iks) {
    for (const link of ik.links) {
      const min = link.rotationMin;
      const max = link.rotationMax;
      if (!min || !max) continue;
      const newMinX = -max.x;
      const newMinY = -max.y;
      max.x = -min.x;
      max.y = -min.y;
      min.x = newMinX;
      min.y = newMinY;
    }
  }
}

/**
 * 官方 MMDAnimationHelper._optimizeIK 同款:物理接管的骨骼(刚体 type 1/2
 * 会逐帧回写骨骼旋转)从 IK 链里禁用 —— 否则 IK 和物理每帧互拽同一根骨,
 * 表现为腿部/裙摆附近高频颤动。
 *
 * @param iks         buildIK 产出的 IK 链(就地改 link.enabled)
 * @param rigidBodies PMX 刚体数组(boneIndex + physicsMode/type)
 */
export function disableIkOnPhysicsBones(
  iks: readonly IkChainLike[],
  rigidBodies: readonly { boneIndex: number; physicsMode: number }[],
): void {
  const physicsBones = new Set<number>();
  for (const rb of rigidBodies) {
    if (rb.physicsMode > 0 && rb.boneIndex >= 0) physicsBones.add(rb.boneIndex);
  }
  if (physicsBones.size === 0) return;
  for (const ik of iks) {
    for (const link of ik.links) {
      if (link.index !== undefined && physicsBones.has(link.index)) {
        link.enabled = false;
      }
    }
  }
}
