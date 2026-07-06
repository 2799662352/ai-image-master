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

/** 世界增量旋转 Q 折算到父空间后作用到骨骼:W' = Q·W = P·L' → L' = (P⁻¹·Q·P)·L */
export function rotateBoneWorld(bone: THREE.Bone, qWorld: THREE.Quaternion): void {
  if (bone.parent) bone.parent.getWorldQuaternion(_parentQ);
  else _parentQ.identity();
  _localQ.copy(_parentQ).invert().multiply(qWorld).multiply(_parentQ);
  bone.quaternion.premultiply(_localQ);
  bone.updateMatrixWorld(true);
}

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
      rotateBoneWorld(bone, _worldQ);
    }
    effector.getWorldPosition(_effPos);
    if (_effPos.distanceTo(targetWorld) < tolerance) break;
  }
  effector.getWorldPosition(_effPos);
  return _effPos.distanceTo(targetWorld);
}

export interface TwoBoneOptions {
  /** 可达距离夹取的余量(占臂长比例),防止完全伸直/完全折叠的奇异位形. */
  slack?: number;
}

const _tbRoot = new THREE.Vector3();
const _tbMid = new THREE.Vector3();
const _tbEff = new THREE.Vector3();
const _tbU = new THREE.Vector3();
const _tbV = new THREE.Vector3();
const _tbT = new THREE.Vector3();
const _tbAxis = new THREE.Vector3();
const _tbMPerp = new THREE.Vector3();
const _tbPPerp = new THREE.Vector3();
const _tbTmp = new THREE.Vector3();
const _tbQ = new THREE.Quaternion();

/**
 * 解析二连杆 IK(游戏引擎四肢标准做法,Unreal TwoBoneIK / ozz 同款):
 * 肩-肘-手(或胯-膝-脚)三点用余弦定理一步解出肘/膝内角 —— acos 结果
 * 天然落在 (0, π),**防反关节由数学构造保证**,无需铰链轴标定或事后钳制。
 *
 * 三步:① 旋转 mid 使内角满足三角形;② 旋转 root 把末端 swing 到目标方向;
 * ③ 绕(根→目标)轴扭转 root,把肘/膝转到 pole 所在半平面(末端在轴上不动)。
 * 不传 pole 时跳过 ③,弯曲面保持解算前的姿势。
 *
 * @returns 解算后末端与目标的剩余距离(超出臂长时 > 0)
 */
export function solveTwoBone(
  root: THREE.Bone,
  mid: THREE.Bone,
  effector: THREE.Object3D,
  targetWorld: THREE.Vector3,
  poleWorld?: THREE.Vector3 | null,
  opts: TwoBoneOptions = {},
): number {
  root.updateMatrixWorld(true);
  root.getWorldPosition(_tbRoot);
  mid.getWorldPosition(_tbMid);
  effector.getWorldPosition(_tbEff);
  const a = _tbRoot.distanceTo(_tbMid);
  const b = _tbMid.distanceTo(_tbEff);
  if (a < 1e-8 || b < 1e-8) return _tbEff.distanceTo(targetWorld);
  const eps = (opts.slack ?? 1e-3) * (a + b);
  const c = THREE.MathUtils.clamp(
    _tbRoot.distanceTo(targetWorld),
    Math.abs(a - b) + eps,
    a + b - eps,
  );
  // ① 肘/膝内角:cos = (a²+b²-c²)/2ab,acos ∈ (0,π) → 永不反关节。
  const cosMid = THREE.MathUtils.clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1);
  const desired = Math.acos(cosMid);
  _tbU.copy(_tbRoot).sub(_tbMid);
  _tbV.copy(_tbEff).sub(_tbMid);
  const current = _tbU.angleTo(_tbV);
  // 绕 n̂ = normalize(u×v) 旋转 v,夹角按右手系单调增:δ = desired - current。
  _tbAxis.copy(_tbU).cross(_tbV);
  if (_tbAxis.lengthSq() < 1e-12) {
    // 肢体伸直 → 弯曲面退化:先用 pole 定轴;仍退化则取任意垂直向量。
    // 哪一侧弯并不重要,③ 的 pole 对齐会把弯曲面扭到正确一侧。
    if (poleWorld) _tbAxis.copy(_tbU).cross(_tbTmp.copy(poleWorld).sub(_tbMid));
    if (_tbAxis.lengthSq() < 1e-12) {
      _tbAxis.set(1, 0, 0).cross(_tbU);
      if (_tbAxis.lengthSq() < 1e-12) _tbAxis.copy(_tbU).cross(_tbTmp.set(0, 1, 0));
    }
  }
  _tbQ.setFromAxisAngle(_tbAxis.normalize(), desired - current);
  rotateBoneWorld(mid, _tbQ);
  // ② 根骨 swing:把(根→末端)旋向(根→目标)。
  effector.getWorldPosition(_tbEff);
  _tbU.copy(_tbEff).sub(_tbRoot);
  _tbV.copy(targetWorld).sub(_tbRoot);
  if (_tbU.lengthSq() > 1e-12 && _tbV.lengthSq() > 1e-12) {
    _tbT.copy(_tbV).normalize();
    _tbQ.setFromUnitVectors(_tbU.normalize(), _tbT);
    rotateBoneWorld(root, _tbQ);
    // ③ pole 扭转:mid 在垂直于 t̂ 的平面上的投影转向 pole 的投影。
    if (poleWorld) {
      mid.getWorldPosition(_tbMid);
      _tbMPerp.copy(_tbMid).sub(_tbRoot);
      _tbMPerp.addScaledVector(_tbT, -_tbMPerp.dot(_tbT));
      _tbPPerp.copy(poleWorld).sub(_tbRoot);
      _tbPPerp.addScaledVector(_tbT, -_tbPPerp.dot(_tbT));
      if (_tbMPerp.lengthSq() > 1e-12 && _tbPPerp.lengthSq() > 1e-12) {
        _tbMPerp.normalize();
        _tbPPerp.normalize();
        const phi = Math.atan2(
          _tbTmp.copy(_tbMPerp).cross(_tbPPerp).dot(_tbT),
          _tbMPerp.dot(_tbPPerp),
        );
        _tbQ.setFromAxisAngle(_tbT, phi);
        rotateBoneWorld(root, _tbQ);
      }
    }
  }
  effector.getWorldPosition(_tbEff);
  return _tbEff.distanceTo(targetWorld);
}
