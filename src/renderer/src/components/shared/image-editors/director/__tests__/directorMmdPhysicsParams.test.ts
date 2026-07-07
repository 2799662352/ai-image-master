/**
 * PMX 刚体/关节 → MMDPhysics 参数映射的纯函数测试。
 * 校验点:字段改名、骨相对偏移换算、限制范围的左右手系换算(取反+min/max
 * 互换)、katwat 刚体类型修正、非法关节过滤。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMmdPhysicsParams,
  type PmxBoneLike,
  type PmxJointLike,
  type PmxRigidBodyLike,
} from '../directorMmdPhysicsParams';

const bone = (pos: [number, number, number], parent = -1): PmxBoneLike => ({
  position: pos,
  parentBoneIndex: parent,
});

const rb = (over: Partial<PmxRigidBodyLike> = {}): PmxRigidBodyLike => ({
  name: 'body',
  boneIndex: 0,
  collisionGroup: 1,
  collisionMask: 0xfffe,
  shapeType: 2,
  shapeSize: [0.3, 1.2, 0],
  shapePosition: [1, 11, -2],
  shapeRotation: [0.1, -0.2, 0.3],
  mass: 0.5,
  linearDamping: 0.9,
  angularDamping: 0.95,
  repulsion: 0,
  friction: 0.4,
  physicsMode: 1,
  ...over,
});

const joint = (over: Partial<PmxJointLike> = {}): PmxJointLike => ({
  name: 'j',
  rigidbodyIndexA: 0,
  rigidbodyIndexB: 1,
  position: [0, 10, -1],
  rotation: [-0.1, -0.2, 0.3],
  positionMin: [-1, -2, -3],
  positionMax: [4, 5, 6],
  rotationMin: [-0.5, -0.6, -0.7],
  rotationMax: [0.8, 0.9, 1.0],
  springPosition: [10, 20, 30],
  springRotation: [40, 50, 60],
  ...over,
});

describe('buildMmdPhysicsParams', () => {
  it('刚体字段映射到 mmd-parser 命名,位置换算成骨相对偏移', () => {
    const { rigidBodies } = buildMmdPhysicsParams({
      bones: [bone([1, 10, -1])],
      rigidBodies: [rb()],
      joints: [],
    });
    expect(rigidBodies).toHaveLength(1);
    const b = rigidBodies[0];
    expect(b.type).toBe(1);
    expect(b.boneIndex).toBe(0);
    expect(b.groupIndex).toBe(1);
    expect(b.groupTarget).toBe(0xfffe);
    expect(b.shapeType).toBe(2);
    expect([b.width, b.height, b.depth]).toEqual([0.3, 1.2, 0]);
    // shapePosition(模型空间绝对)减骨 rest 位置 → 偏移。
    expect(b.position).toEqual([0, 1, -1]);
    expect(b.rotation).toEqual([0.1, -0.2, 0.3]);
    expect(b.weight).toBe(0.5);
    expect(b.positionDamping).toBe(0.9);
    expect(b.rotationDamping).toBe(0.95);
    expect(b.restitution).toBe(0);
    expect(b.friction).toBe(0.4);
  });

  it('boneIndex<0 的刚体按骨 0 换算偏移', () => {
    const { rigidBodies } = buildMmdPhysicsParams({
      bones: [bone([0, 1, 0])],
      rigidBodies: [rb({ boneIndex: -1, shapePosition: [0, 3, 0] })],
      joints: [],
    });
    expect(rigidBodies[0].position).toEqual([0, 2, 0]);
    expect(rigidBodies[0].boneIndex).toBe(-1);
  });

  it('关节限制范围做左右手系换算:平移 z / 旋转 x、y 取反且 min/max 互换', () => {
    const { constraints } = buildMmdPhysicsParams({
      bones: [bone([0, 0, 0]), bone([0, 1, 0], 0)],
      rigidBodies: [rb(), rb({ boneIndex: 1 })],
      joints: [joint()],
    });
    expect(constraints).toHaveLength(1);
    const c = constraints[0];
    expect(c.rigidBodyIndex1).toBe(0);
    expect(c.rigidBodyIndex2).toBe(1);
    expect(c.position).toEqual([0, 10, -1]);
    expect(c.rotation).toEqual([-0.1, -0.2, 0.3]);
    // 平移:x/y 原样,z 取反并互换 min/max。
    expect(c.translationLimitation1).toEqual([-1, -2, -6]);
    expect(c.translationLimitation2).toEqual([4, 5, 3]);
    // 旋转:x/y 取反并互换,z 原样。
    expect(c.rotationLimitation1).toEqual([-0.8, -0.9, -0.7]);
    expect(c.rotationLimitation2).toEqual([0.5, 0.6, 1.0]);
    expect(c.springPosition).toEqual([10, 20, 30]);
    expect(c.springRotation).toEqual([40, 50, 60]);
  });

  it('katwat 修正:动力学 A 连「物理+骨对齐」B 且 B 骨是 A 骨的子级 → B 降为纯物理', () => {
    const { rigidBodies } = buildMmdPhysicsParams({
      bones: [bone([0, 0, 0]), bone([0, 1, 0], 0)],
      rigidBodies: [
        rb({ boneIndex: 0, physicsMode: 1 }),
        rb({ boneIndex: 1, physicsMode: 2 }),
      ],
      joints: [joint()],
    });
    expect(rigidBodies[1].type).toBe(1);
  });

  it('katwat 修正不影响非父子链或跟骨刚体', () => {
    const { rigidBodies } = buildMmdPhysicsParams({
      bones: [bone([0, 0, 0]), bone([0, 1, 0], -1)],
      rigidBodies: [
        rb({ boneIndex: 0, physicsMode: 0 }),
        rb({ boneIndex: 1, physicsMode: 2 }),
      ],
      joints: [joint()],
    });
    // A 是跟骨(type 0)→ 不触发。
    expect(rigidBodies[1].type).toBe(2);
  });

  it('引用越界刚体的关节被丢弃;无刚体数据返回空表', () => {
    const { constraints } = buildMmdPhysicsParams({
      bones: [bone([0, 0, 0])],
      rigidBodies: [rb()],
      joints: [joint({ rigidbodyIndexB: 5 })],
    });
    expect(constraints).toHaveLength(0);
    const empty = buildMmdPhysicsParams({ bones: [bone([0, 0, 0])] });
    expect(empty.rigidBodies).toHaveLength(0);
    expect(empty.constraints).toHaveLength(0);
  });
});
