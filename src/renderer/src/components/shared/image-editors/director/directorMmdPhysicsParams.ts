/**
 * PMX/PMD 刚体·关节 → three.js MMDPhysics 参数映射(纯函数,无 three/ammo 依赖)。
 *
 * 输入是 @moeru/three-mmd(babylon-mmd 解析器)的 PmxObject 字段,其
 * postParseProcessing 已做过一次「左手系→右手系」转换:
 * - shapePosition/joint.position: z 取反(且刚体位置已归一为**模型空间绝对坐标**,
 *   PMD 的骨相对偏移在解析时加回了骨位置);
 * - shapeRotation/joint.rotation: x、y 取反;
 * - **但 joint 的平移/旋转限制范围没转**(mmd-parser 会用
 *   leftToRightVector3Range / leftToRightEulerRange 处理),这里补上:
 *   取反会翻转大小关系,min/max 必须交换 —— 平移 z 分量、旋转 x/y 分量。
 *
 * 输出对齐 three.js r171 MMDPhysics(vendor/MMDPhysics.js)期望的
 * mmd-parser 字段名:type/width/height/depth/position(骨相对偏移)/rotation/
 * weight/positionDamping/rotationDamping/restitution/friction/groupIndex/
 * groupTarget 与 rigidBodyIndex1/2/translationLimitation1/2/rotationLimitation1/2。
 */

export interface PmxBoneLike {
  /** 模型空间绝对 rest 位置(z 已翻转)。 */
  position: readonly number[];
  parentBoneIndex: number;
}

export interface PmxRigidBodyLike {
  name?: string;
  boneIndex: number;
  collisionGroup: number;
  collisionMask: number;
  /** 0 球 / 1 箱 / 2 胶囊。 */
  shapeType: number;
  shapeSize: readonly number[];
  /** 模型空间绝对位置(见模块头注释)。 */
  shapePosition: readonly number[];
  shapeRotation: readonly number[];
  mass: number;
  linearDamping: number;
  angularDamping: number;
  repulsion: number;
  friction: number;
  /** 0 跟骨 / 1 物理 / 2 物理+骨对齐。 */
  physicsMode: number;
}

export interface PmxJointLike {
  name?: string;
  rigidbodyIndexA: number;
  rigidbodyIndexB: number;
  position: readonly number[];
  rotation: readonly number[];
  positionMin: readonly number[];
  positionMax: readonly number[];
  rotationMin: readonly number[];
  rotationMax: readonly number[];
  springPosition: readonly number[];
  springRotation: readonly number[];
}

/** MMDPhysics 的刚体参数(mmd-parser 命名)。 */
export interface MmdRigidBodyParam {
  name?: string;
  type: number;
  boneIndex: number;
  groupIndex: number;
  groupTarget: number;
  shapeType: number;
  width: number;
  height: number;
  depth: number;
  /** 相对所属骨骼 rest 位置的偏移。 */
  position: [number, number, number];
  rotation: [number, number, number];
  weight: number;
  positionDamping: number;
  rotationDamping: number;
  restitution: number;
  friction: number;
}

/** MMDPhysics 的 6DOF 弹簧约束参数(mmd-parser 命名)。 */
export interface MmdConstraintParam {
  name?: string;
  rigidBodyIndex1: number;
  rigidBodyIndex2: number;
  position: [number, number, number];
  rotation: [number, number, number];
  translationLimitation1: [number, number, number];
  translationLimitation2: [number, number, number];
  rotationLimitation1: [number, number, number];
  rotationLimitation2: [number, number, number];
  springPosition: [number, number, number];
  springRotation: [number, number, number];
}

export interface MmdPhysicsParams {
  rigidBodies: MmdRigidBodyParam[];
  constraints: MmdConstraintParam[];
}

const v3 = (a: readonly number[]): [number, number, number] => [a[0], a[1], a[2]];

/**
 * 组装 MMDPhysics 参数。刚体位置从「模型空间绝对」换算成 MMDPhysics 期望的
 * 「骨相对偏移」;boneIndex<0 时按骨 0 处理(与解析器 _NormalizeRigidBodyPositions
 * 的逆运算一致,骨 0/全ての親 基本都在原点)。
 */
export function buildMmdPhysicsParams(pmx: {
  bones: readonly PmxBoneLike[];
  rigidBodies?: readonly PmxRigidBodyLike[];
  joints?: readonly PmxJointLike[];
}): MmdPhysicsParams {
  const bones = pmx.bones;
  const rigidBodies: MmdRigidBodyParam[] = (pmx.rigidBodies ?? []).map((rb) => {
    const bonePos = bones[rb.boneIndex < 0 ? 0 : rb.boneIndex]?.position ?? [0, 0, 0];
    return {
      ...(rb.name !== undefined ? { name: rb.name } : {}),
      type: rb.physicsMode,
      boneIndex: rb.boneIndex,
      groupIndex: rb.collisionGroup,
      groupTarget: rb.collisionMask,
      shapeType: rb.shapeType,
      width: rb.shapeSize[0],
      height: rb.shapeSize[1],
      depth: rb.shapeSize[2],
      position: [
        rb.shapePosition[0] - bonePos[0],
        rb.shapePosition[1] - bonePos[1],
        rb.shapePosition[2] - bonePos[2],
      ],
      rotation: v3(rb.shapeRotation),
      weight: rb.mass,
      positionDamping: rb.linearDamping,
      rotationDamping: rb.angularDamping,
      restitution: rb.repulsion,
      friction: rb.friction,
    };
  });

  const constraints: MmdConstraintParam[] = [];
  for (const j of pmx.joints ?? []) {
    // 引用非法刚体的关节直接丢弃(MMDPhysics 会崩在 undefined body 上)。
    if (
      j.rigidbodyIndexA < 0 ||
      j.rigidbodyIndexA >= rigidBodies.length ||
      j.rigidbodyIndexB < 0 ||
      j.rigidbodyIndexB >= rigidBodies.length
    ) {
      continue;
    }
    constraints.push({
      ...(j.name !== undefined ? { name: j.name } : {}),
      rigidBodyIndex1: j.rigidbodyIndexA,
      rigidBodyIndex2: j.rigidbodyIndexB,
      position: v3(j.position),
      rotation: v3(j.rotation),
      // 左手系→右手系的限制范围换算(z 平移 / x、y 旋转:取反+min/max 互换)。
      translationLimitation1: [j.positionMin[0], j.positionMin[1], -j.positionMax[2]],
      translationLimitation2: [j.positionMax[0], j.positionMax[1], -j.positionMin[2]],
      rotationLimitation1: [-j.rotationMax[0], -j.rotationMax[1], j.rotationMin[2]],
      rotationLimitation2: [-j.rotationMin[0], -j.rotationMin[1], j.rotationMax[2]],
      springPosition: v3(j.springPosition),
      springRotation: v3(j.springRotation),
    });
  }

  // katwat 修正(three.js MMDLoader 同款,http://www20.atpages.jp/katwat/wp/?p=4135):
  // 动力学刚体 A 与「物理+骨对齐」刚体 B 相连,且 B 的骨是 A 的骨的子级时,
  // B 改成纯物理 —— 否则骨对齐会把物理结果往回拽,关节处抖动/穿模。
  for (const c of constraints) {
    const bodyA = rigidBodies[c.rigidBodyIndex1];
    const bodyB = rigidBodies[c.rigidBodyIndex2];
    if (
      bodyA.type !== 0 &&
      bodyB.type === 2 &&
      bodyA.boneIndex !== -1 &&
      bodyB.boneIndex !== -1 &&
      bones[bodyB.boneIndex]?.parentBoneIndex === bodyA.boneIndex
    ) {
      bodyB.type = 1;
    }
  }

  return { rigidBodies, constraints };
}
