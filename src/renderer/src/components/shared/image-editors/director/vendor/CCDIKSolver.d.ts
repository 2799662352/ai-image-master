/**
 * vendor/CCDIKSolver.js(three.js r171)的类型声明。
 * IK 配置结构与当前 three addons 版一致,直接复用官方类型。
 */
import type { Object3D, SkinnedMesh } from 'three';
import type { IK } from 'three/examples/jsm/animation/CCDIKSolver.js';

export class CCDIKSolver {
  constructor(mesh: SkinnedMesh, iks?: IK[]);
  mesh: SkinnedMesh;
  iks: IK[];
  update(): this;
  updateOne(ik: IK): this;
  createHelper(sphereSize?: number): Object3D;
}

export class CCDIKHelper extends Object3D {
  constructor(mesh: SkinnedMesh, iks?: IK[], sphereSize?: number);
  dispose(): void;
}
