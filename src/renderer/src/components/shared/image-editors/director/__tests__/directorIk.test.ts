import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { solveCcd, solveTwoBone } from '../directorIk';

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

/** 肘/膝内角(度):mid 处 (mid→root) 与 (mid→tip) 的夹角. */
function interiorAngleDeg(root: THREE.Bone, mid: THREE.Bone, tip: THREE.Bone): number {
  const pr = root.getWorldPosition(new THREE.Vector3());
  const pm = mid.getWorldPosition(new THREE.Vector3());
  const pt = tip.getWorldPosition(new THREE.Vector3());
  const u = pr.clone().sub(pm);
  const v = pt.clone().sub(pm);
  return THREE.MathUtils.radToDeg(u.angleTo(v));
}

describe('solveTwoBone', () => {
  it('可达目标:末端精确落到目标,内角满足余弦定理', () => {
    const { root, mid, tip } = makeChain();
    const target = new THREE.Vector3(1, 1, 0); // c = √2,a=b=1 → 内角 = 90°
    const dist = solveTwoBone(root, mid, tip, target);
    expect(dist).toBeLessThan(1e-4);
    expect(interiorAngleDeg(root, mid, tip)).toBeCloseTo(90, 0);
  });

  it('防反关节:任意目标下内角始终 ∈ (0°, 180°)', () => {
    const targets = [
      new THREE.Vector3(0.3, 0.1, 0),
      new THREE.Vector3(-1, 1.5, 0.5),
      new THREE.Vector3(0, -1.8, 0.2),
      new THREE.Vector3(5, 5, 5), // 超出臂长
      new THREE.Vector3(0.01, 0.01, 0.01), // 几乎在根部
    ];
    const { root, mid, tip } = makeChain();
    const pole = new THREE.Vector3(0, 1, 2);
    for (const t of targets) {
      solveTwoBone(root, mid, tip, t, pole);
      const deg = interiorAngleDeg(root, mid, tip);
      expect(deg).toBeGreaterThan(0);
      expect(deg).toBeLessThan(180);
      expect(Number.isNaN(root.quaternion.x)).toBe(false);
      expect(Number.isNaN(mid.quaternion.x)).toBe(false);
    }
  });

  it('超出臂长:肢体接近伸直指向目标,但不完全锁直', () => {
    const { root, mid, tip } = makeChain();
    const target = new THREE.Vector3(4, 0, 0);
    const dist = solveTwoBone(root, mid, tip, target);
    expect(dist).toBeCloseTo(2, 1); // 4 - 臂长 2
    const p = tip.getWorldPosition(new THREE.Vector3());
    expect(p.x).toBeGreaterThan(1.9);
    const deg = interiorAngleDeg(root, mid, tip);
    expect(deg).toBeGreaterThan(170); // 接近伸直
    expect(deg).toBeLessThan(180); // 但保留余量,不奇异
  });

  it('pole 对齐:肘/膝落到 pole 所在半平面', () => {
    const { root, mid, tip } = makeChain();
    const target = new THREE.Vector3(0, 1.2, 0); // 拉近迫使弯曲
    const pole = new THREE.Vector3(0, 0.6, 5); // 要求膝盖朝 +z
    solveTwoBone(root, mid, tip, target, pole);
    const pm = mid.getWorldPosition(new THREE.Vector3());
    expect(pm.z).toBeGreaterThan(0.1); // mid 弯向 +z 一侧
    const pt = tip.getWorldPosition(new THREE.Vector3());
    expect(pt.distanceTo(target)).toBeLessThan(1e-4);
    // 换到对侧 pole → mid 翻到 -z 一侧,末端仍在目标上
    solveTwoBone(root, mid, tip, target, new THREE.Vector3(0, 0.6, -5));
    expect(mid.getWorldPosition(new THREE.Vector3()).z).toBeLessThan(-0.1);
    expect(tip.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-4);
  });

  it('不传 pole:保持解算前的弯曲面', () => {
    const { root, mid, tip } = makeChain();
    // 先用 pole 弯到 +z 面,再不带 pole 拖到新目标 → 仍在 +z 面
    solveTwoBone(root, mid, tip, new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(0, 0.6, 5));
    solveTwoBone(root, mid, tip, new THREE.Vector3(0.5, 1.0, 0));
    expect(mid.getWorldPosition(new THREE.Vector3()).z).toBeGreaterThan(0.05);
  });

  it('只旋转 root/mid,不改任何骨骼 position,末端骨局部姿态不变', () => {
    const { root, mid, tip } = makeChain();
    const midPos = mid.position.clone();
    const tipPos = tip.position.clone();
    const tipQ = tip.quaternion.clone();
    solveTwoBone(root, mid, tip, new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 1, 3));
    expect(mid.position.equals(midPos)).toBe(true);
    expect(tip.position.equals(tipPos)).toBe(true);
    expect(tip.quaternion.equals(tipQ)).toBe(true);
  });
});
