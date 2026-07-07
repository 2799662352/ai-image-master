/**
 * MMD IK 修复的回归测试:
 * 1. convertIkLimitsToRightHanded —— PMX 左手系 IK 限制角换到右手系
 *    (x/y 取反 + min/max 互换,z 不动),对齐官方 r171 MMDLoader;
 * 2. vendor/CCDIKSolver.js(r171)膝盖铰链(limitation=(1,0,0))不产生
 *    负向(反折)旋转 —— r184 addons 版会保留负号导致反向关节抖动。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CCDIKSolver } from '../vendor/CCDIKSolver.js';
import {
  convertIkLimitsToRightHanded,
  disableIkOnPhysicsBones,
} from '../directorMmdIkLimits';

describe('convertIkLimitsToRightHanded', () => {
  it('x/y 分量取反并互换 min/max,z 分量保持不变', () => {
    const iks = [
      {
        links: [
          {
            rotationMin: { x: -1, y: -0.5, z: -0.2 },
            rotationMax: { x: 0.3, y: 0.8, z: 0.6 },
          },
        ],
      },
    ];
    convertIkLimitsToRightHanded(iks);
    const { rotationMin, rotationMax } = iks[0].links[0];
    expect(rotationMin).toEqual({ x: -0.3, y: -0.8, z: -0.2 });
    expect(rotationMax).toEqual({ x: 1, y: 0.5, z: 0.6 });
  });

  it('没有限制的链(膝盖走 limitation 轴)原样跳过', () => {
    const link: { rotationMin?: { x: number; y: number; z: number } } = {};
    expect(() => convertIkLimitsToRightHanded([{ links: [link] }])).not.toThrow();
    expect(link.rotationMin).toBeUndefined();
  });
});

describe('disableIkOnPhysicsBones', () => {
  it('物理接管(type 1/2)骨骼所在 link 被禁用,跟骨(type 0)不受影响', () => {
    const iks = [
      {
        links: [
          { index: 2, enabled: true },
          { index: 5, enabled: true },
          { index: 7, enabled: true },
        ],
      },
    ];
    disableIkOnPhysicsBones(iks, [
      { boneIndex: 2, physicsMode: 0 }, // 跟骨:保留 IK
      { boneIndex: 5, physicsMode: 1 }, // 纯物理:禁用 IK
      { boneIndex: 7, physicsMode: 2 }, // 物理+骨对齐:禁用 IK
      { boneIndex: -1, physicsMode: 1 }, // 无骨刚体:忽略
    ]);
    expect(iks[0].links.map((l) => l.enabled)).toEqual([true, false, false]);
  });

  it('没有物理刚体时不改动任何 link', () => {
    const iks = [{ links: [{ index: 1, enabled: true }] }];
    disableIkOnPhysicsBones(iks, []);
    expect(iks[0].links[0].enabled).toBe(true);
  });
});

describe('vendor CCDIKSolver(r171)膝盖铰链', () => {
  /** 竖直腿:hip(0,1,0) → knee(0,-1,0 相对) → ankle(0,-1,0 相对),外加 IK target 骨。 */
  const makeLeg = () => {
    const root = new THREE.Bone();
    const hip = new THREE.Bone();
    hip.position.set(0, 1, 0);
    const knee = new THREE.Bone();
    knee.position.set(0, -1, 0);
    const ankle = new THREE.Bone();
    ankle.position.set(0, -1, 0);
    const target = new THREE.Bone();
    root.add(hip);
    hip.add(knee);
    knee.add(ankle);
    root.add(target);

    const mesh = new THREE.SkinnedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
    );
    mesh.add(root);
    mesh.bind(new THREE.Skeleton([root, hip, knee, ankle, target]));
    mesh.updateMatrixWorld(true);
    return { mesh, knee, target };
  };

  it('目标在腿后方时膝盖也只朝正向弯(负向解被镜像,不反折/不振荡)', () => {
    const { mesh, knee, target } = makeLeg();
    // +Z 在膝盖正弯(+X 旋转)可达域的反侧:最优解是负向弯,r171 必须镜像回正。
    target.position.set(0, -0.6, 0.5);
    mesh.updateMatrixWorld(true);

    const solver = new CCDIKSolver(mesh, [
      {
        target: 4,
        effector: 3,
        links: [
          { index: 2, limitation: new THREE.Vector3(1, 0, 0) },
          { index: 1 },
        ],
        iteration: 10,
        maxAngle: 1,
      } as never,
    ]);

    // 连续多帧求解,膝盖四元数必须始终是纯 +X 旋转(x>=0,y/z 为 0)。
    for (let frame = 0; frame < 5; frame++) {
      solver.update();
      expect(knee.quaternion.x).toBeGreaterThanOrEqual(0);
      expect(Math.abs(knee.quaternion.y)).toBeLessThan(1e-6);
      expect(Math.abs(knee.quaternion.z)).toBeLessThan(1e-6);
    }
  });

  it('目标在正弯方向时能正常弯膝接近目标', () => {
    const { mesh, knee, target } = makeLeg();
    // -Z 方向 = 膝盖 +X 正弯的可达域。
    target.position.set(0, -0.6, -0.5);
    mesh.updateMatrixWorld(true);

    const solver = new CCDIKSolver(mesh, [
      {
        target: 4,
        effector: 3,
        links: [
          { index: 2, limitation: new THREE.Vector3(1, 0, 0) },
          { index: 1 },
        ],
        iteration: 20,
        maxAngle: 1,
      } as never,
    ]);
    solver.update();
    mesh.updateMatrixWorld(true);

    expect(knee.quaternion.x).toBeGreaterThan(0.01);
    const ankleWorld = new THREE.Vector3().setFromMatrixPosition(
      mesh.skeleton.bones[3].matrixWorld,
    );
    const targetWorld = new THREE.Vector3().setFromMatrixPosition(
      mesh.skeleton.bones[4].matrixWorld,
    );
    expect(ankleWorld.distanceTo(targetWorld)).toBeLessThan(0.15);
  });
});
