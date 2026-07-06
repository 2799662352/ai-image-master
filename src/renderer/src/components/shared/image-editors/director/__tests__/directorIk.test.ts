import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { solveCcd } from '../directorIk';

/** 竖直二连杆:root(原点)→ mid(+1y)→ tip(+1y),总臂长 2. */
function makeChain(): { root: THREE.Bone; mid: THREE.Bone; tip: THREE.Bone } {
  const root = new THREE.Bone();
  const mid = new THREE.Bone();
  const tip = new THREE.Bone();
  mid.position.set(0, 1, 0);
  tip.position.set(0, 1, 0);
  root.add(mid);
  mid.add(tip);
  root.updateMatrixWorld(true);
  return { root, mid, tip };
}

describe('solveCcd', () => {
  it('可达目标:末端收敛到目标点附近', () => {
    const { root, mid, tip } = makeChain();
    const target = new THREE.Vector3(1, 1, 0); // 距根 √2 < 臂长 2,可达
    const dist = solveCcd([root, mid], tip, target, { iterations: 16 });
    expect(dist).toBeLessThan(1e-3);
    const p = tip.getWorldPosition(new THREE.Vector3());
    expect(p.distanceTo(target)).toBeLessThan(1e-3);
  });

  it('不可达目标:整链伸直指向目标,剩余距离 ≈ 目标距离 - 臂长', () => {
    const { root, mid, tip } = makeChain();
    const target = new THREE.Vector3(3, 0, 0); // 距根 3 > 臂长 2
    const dist = solveCcd([root, mid], tip, target, { iterations: 16 });
    expect(dist).toBeCloseTo(1, 1);
    const p = tip.getWorldPosition(new THREE.Vector3());
    expect(p.x).toBeGreaterThan(1.9); // 基本伸直到 (2,0,0)
    expect(Math.abs(p.y)).toBeLessThan(0.1);
  });

  it('只旋转链骨,不改任何骨骼的 position', () => {
    const { root, mid, tip } = makeChain();
    const midPos = mid.position.clone();
    const tipPos = tip.position.clone();
    solveCcd([root, mid], tip, new THREE.Vector3(1, 1, 0));
    expect(mid.position.equals(midPos)).toBe(true);
    expect(tip.position.equals(tipPos)).toBe(true);
    expect(root.position.lengthSq()).toBe(0);
  });

  it('末端骨本身不被旋转(局部姿态保持不变)', () => {
    const { root, mid, tip } = makeChain();
    const tipQ = tip.quaternion.clone();
    solveCcd([root, mid], tip, new THREE.Vector3(1, 1, 0));
    expect(tip.quaternion.equals(tipQ)).toBe(true);
  });

  it('空链:不动任何东西,返回当前距离', () => {
    const { tip } = makeChain();
    const dist = solveCcd([], tip, new THREE.Vector3(0, 5, 0));
    expect(dist).toBeCloseTo(3, 5); // tip 在 (0,2,0),目标 (0,5,0)
  });

  it('目标就在末端当前位置:立即收敛且不产生 NaN', () => {
    const { root, mid, tip } = makeChain();
    const target = tip.getWorldPosition(new THREE.Vector3());
    const dist = solveCcd([root, mid], tip, target);
    expect(dist).toBeLessThan(1e-6);
    expect(Number.isNaN(root.quaternion.x)).toBe(false);
    expect(Number.isNaN(mid.quaternion.x)).toBe(false);
  });
});
