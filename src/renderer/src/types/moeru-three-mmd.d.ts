/**
 * 本地类型 shim:@moeru/three-mmd@0.1.0-beta.3 的 package.json `types` 指向
 * dist/index.d.ts,但实际产物是带 hash 的 dist/index-*.d.ts,TS 解析不到。
 * 这里只声明导演台用到的最小 API 面(与实际 d.ts 逐字核对过)。
 * 若升级该包后官方修复了 types 出口,删除本文件即可。
 */
declare module '@moeru/three-mmd' {
  import type {
    AnimationClip,
    Bone,
    LoadingManager,
    Quaternion,
    SkinnedMesh,
  } from 'three';
  import type { IK } from 'three/examples/jsm/animation/CCDIKSolver.js';

  export interface Grant {
    index: number;
    parentIndex: number;
    ratio: number;
    isLocal: boolean;
    affectRotation: boolean;
    affectPosition: boolean;
    transformationClass: number;
  }

  /** PMX 解析结果(只用到 header 里的名字,其余按 unknown 处理)。 */
  export interface PmxObjectLike {
    header: { modelName: string; englishModelName: string };
    [key: string]: unknown;
  }

  export class MMD {
    grants: Grant[];
    iks: IK[];
    mesh: SkinnedMesh;
    pmx: PmxObjectLike;
    scale: number;
    setScalar(scale: number): void;
    /** 仅更新 physics(未接物理时为 no-op);IK/Grant 需自行用求解器逐帧更新。 */
    update(delta: number): void;
  }

  export class MMDLoader {
    constructor(plugins?: unknown[], manager?: LoadingManager);
    load(
      url: string,
      onLoad: (mmd: MMD) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: unknown) => void,
    ): void;
    loadAsync(url: string, onProgress?: (event: ProgressEvent) => void): Promise<MMD>;
    setResourcePath(path: string): this;
    setPath(path: string): this;
  }

  export class VmdObject {
    static ParseFromBuffer(buffer: ArrayBufferLike): VmdObject;
    get boneKeyFrames(): { length: number };
    get morphKeyFrames(): { length: number };
    get cameraKeyFrames(): { length: number };
  }

  export class VMDLoader {
    constructor(manager?: LoadingManager);
    loadAsync(url: string, onProgress?: (event: ProgressEvent) => void): Promise<VmdObject>;
  }

  export class GrantSolver {
    constructor(mesh: SkinnedMesh, grants?: Grant[]);
    addGrantRotation(bone: Bone, q: Quaternion, ratio: number): this;
    update(): this;
  }

  /** 把动作 VMD 编译为绑定到 mesh 骨骼/morph 的 AnimationClip(日文骨名匹配)。 */
  export const buildAnimation: (vmd: VmdObject, mesh: SkinnedMesh) => AnimationClip;
  /** 把相机 VMD 编译为相机 AnimationClip。 */
  export const buildCameraAnimation: (vmd: VmdObject) => AnimationClip;
}
