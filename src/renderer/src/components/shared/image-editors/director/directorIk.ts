import * as THREE from 'three';

/**
 * 轻量 CCD 逆向解算(IK)。
 *
 * 为什么不用官方 CCDIKSolver:它要求 IK target 必须是同一副 skeleton 里的
 * 骨骼(iks 全部按 skeleton.bones 下标寻址),对 Mixamo 这类带预旋转的骨架
 * 约束还会失效(three.js#29682)。我们的场景全是二连杆短链(肩→肘→手、
 * 胯→膝→脚),plain CCD 数轮即收敛,直接驱动已筛好的主骨即可,不碰骨架结构。
 */
export interface CcdOptions {
  /** 迭代轮数;二连杆短链 8 轮足够收敛. */
  iterations?: number;
  /** 末端与目标的世界距离小于该值即提前停止(米). */
  tolerance?: number;
}

const _bonePos = new THREE.Vector3();
const _effPos = new THREE.Vector3();
const _toEff = new THREE.Vector3();
const _toTgt = new THREE.Vector3();
const _worldQ = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _localQ = new THREE.Quaternion();

/**
 * CCD:旋转 chain 中各骨骼(只改 quaternion,不动 position),使 effector
 * 的世界位置尽量到达 targetWorld。
 *
 * @param chain    从链根到链尾的旋转骨,如 [肩, 肘];调用方保证是主骨(非嵌套孪生)
 * @param effector 末端骨(手/脚),本身不被旋转,只作为目标点探针
 * @param targetWorld 目标世界坐标
 * @returns 解算后末端与目标的剩余距离(不可达时 > 0)
 */
export function solveCcd(
  chain: readonly THREE.Bone[],
  effector: THREE.Object3D,
  targetWorld: THREE.Vector3,
  opts: CcdOptions = {},
): number {
  const iterations = opts.iterations ?? 8;
  const tolerance = opts.tolerance ?? 1e-4;
  if (chain.length === 0) {
    effector.getWorldPosition(_effPos);
    return _effPos.distanceTo(targetWorld);
  }
  chain[0].updateMatrixWorld(true);
  for (let iter = 0; iter < iterations; iter++) {
    // 经典 CCD:每轮从最靠近末端的链骨到链根,把「骨→末端」旋向「骨→目标」。
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      bone.getWorldPosition(_bonePos);
      effector.getWorldPosition(_effPos);
      _toEff.copy(_effPos).sub(_bonePos);
      _toTgt.copy(targetWorld).sub(_bonePos);
      if (_toEff.lengthSq() < 1e-10 || _toTgt.lengthSq() < 1e-10) continue;
      _worldQ.setFromUnitVectors(_toEff.normalize(), _toTgt.normalize());
      // 世界增量 Q 折算到父空间:W' = Q·W = P·L' → L' = (P⁻¹·Q·P)·L
      if (bone.parent) bone.parent.getWorldQuaternion(_parentQ);
      else _parentQ.identity();
      _localQ.copy(_parentQ).invert().multiply(_worldQ).multiply(_parentQ);
      bone.quaternion.premultiply(_localQ);
      bone.updateMatrixWorld(true);
    }
    effector.getWorldPosition(_effPos);
    if (_effPos.distanceTo(targetWorld) < tolerance) break;
  }
  effector.getWorldPosition(_effPos);
  return _effPos.distanceTo(targetWorld);
}
