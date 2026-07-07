/**
 * MMD(MikuMikuDance)模型与动作接入 —— PMX/PMD 模型 + 动作 VMD。
 *
 * 本模块被 DirectorStageScene 动态 import(`await import('./directorMmd')`),
 * @moeru/three-mmd 与 jszip 都不进主包,只有用户真的导入 MMD 资产时才加载。
 *
 * 关键事实(与 @moeru/three-mmd@0.1.0-beta.3 源码逐一核对):
 * - `MMDLoader` 从 buffer 签名自动识别 PMX/PMD,blob URL 无扩展名也能加载;
 * - 贴图请求 = `resourcePath + PMX 里写的相对路径`(常见 `tex\body.png` 反斜杠),
 *   zip 导入用 LoadingManager.setURLModifier 把它们改写到解压出的内存 blob;
 * - `MMD.update(delta)` 只更新 physics(未接物理 = no-op),IK/Grant 必须
 *   自己用 CCDIKSolver + GrantSolver 逐帧驱动 —— 见 `attachMmdRuntime`;
 * - `buildAnimation(vmd, mesh)` 产出的轨道名是 `.bones[骨名].quaternion`,
 *   AnimationMixer 的根必须是那个 SkinnedMesh(容器 Object3D 解析不了)。
 */

import * as THREE from 'three';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import {
  GrantSolver,
  MMDLoader,
  VmdObject,
  buildAnimation,
  type MMD,
} from '@moeru/three-mmd';
import JSZip from 'jszip';

/** MMD 模型格式:pmx / pmd 裸文件,或「pmx+贴图」打包的 zip。 */
export const MMD_MODEL_EXTS = ['pmx', 'pmd', 'zip'] as const;

export function isMmdModelExt(ext: string | undefined | null): boolean {
  return !!ext && (MMD_MODEL_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/** 归一化 zip 内路径/贴图请求路径:反斜杠→斜杠、去 "./"、decode、小写。 */
function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法转义序列按原样比较 */
  }
  return s.replace(/^\.\//, '').toLowerCase();
}

/** zip 是否包含 PMX/PMD(导入前校验,拒绝无关 zip)。 */
export async function zipContainsMmd(blob: Blob): Promise<boolean> {
  try {
    // JSZip 直接吃 Blob(内部走 FileReader),不依赖 Blob.arrayBuffer。
    const zip = await JSZip.loadAsync(blob);
    return Object.keys(zip.files).some((n) => /\.(pmx|pmd)$/i.test(n));
  } catch {
    return false;
  }
}

export interface MmdModelHandle {
  /** 场景容器(内含 SkinnedMesh);userData 已挂好 mmd 运行时标记。 */
  object: THREE.Group;
}

/**
 * 加载 MMD 模型。zip 时在内存解压,贴图改写到 blob URL;裸 pmx/pmd 直接加载
 * (分离的贴图文件取不到,会以无贴图材质渲染 —— UI 建议用户导 zip)。
 *
 * 加载完成后容器 userData 上有:
 * - `mmdMesh`: SkinnedMesh(动作 VMD 的 mixer 根);
 * - `mmdUpdate`: () => void(IK+Grant 逐帧求解,由 RAF 循环调用)。
 */
export async function loadMmdModel(url: string, ext: string): Promise<MmdModelHandle> {
  const kind = ext.toLowerCase();
  let mmd: MMD;
  if (kind === 'zip') {
    mmd = await loadFromZip(url);
  } else {
    mmd = await new MMDLoader().loadAsync(url);
  }
  const mesh = mmd.mesh;
  mesh.name = mmd.pmx?.header?.modelName || 'MMD Model';
  const group = new THREE.Group();
  group.name = mesh.name;
  group.add(mesh);
  group.userData.mmdMesh = mesh;
  attachMmdRuntime(group, mmd);
  return { object: group };
}

async function loadFromZip(url: string): Promise<MMD> {
  const buf = await (await fetch(url)).arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const modelEntry =
    entries.find((f) => /\.pmx$/i.test(f.name)) ??
    entries.find((f) => /\.pmd$/i.test(f.name));
  if (!modelEntry) throw new Error('zip 里没有找到 .pmx / .pmd 模型文件');

  // 全部文件解成 blob URL(贴图请求是同步改写,必须预先备好)。
  const urlByPath = new Map<string, string>(); // normalized zip path → blob URL
  const blobUrls: string[] = [];
  await Promise.all(
    entries.map(async (f) => {
      const blob = await f.async('blob');
      const u = URL.createObjectURL(blob);
      urlByPath.set(normPath(f.name), u);
      blobUrls.push(u);
    }),
  );

  const modelDir = normPath(modelEntry.name).split('/').slice(0, -1).join('/');
  const resolveTexture = (raw: string): string | null => {
    const want = normPath(raw);
    // ① 相对模型目录;② zip 根;③ 兜底按文件名匹配(有些 PMX 写了错误目录)。
    const dirHit = urlByPath.get(modelDir ? `${modelDir}/${want}` : want);
    if (dirHit) return dirHit;
    const rootHit = urlByPath.get(want);
    if (rootHit) return rootHit;
    const base = want.split('/').pop() ?? want;
    for (const [p, u] of urlByPath) {
      if (p.endsWith(`/${base}`) || p === base) return u;
    }
    return null;
  };

  const manager = new THREE.LoadingManager();
  const RESOURCE_PREFIX = 'mmd-zip://';
  manager.setURLModifier((requested) => {
    if (!requested.startsWith(RESOURCE_PREFIX)) return requested;
    return resolveTexture(requested.slice(RESOURCE_PREFIX.length)) ?? requested;
  });
  // blob URL 回收不能用 manager.onLoad:贴图请求发生在「模型二进制 itemEnd →
  // PmxReader.ParseAsync(异步)→ buildMaterials」之后,onLoad 会在只加载完模型
  // 文件那一刻先火一次 —— 那时回收会把还没发出的贴图请求全部打死(整模白模/
  // 半透明,实测踩过)。改为自己计数 in-flight 项:模型装配完成且无 pending
  // 时才回收(pending>0 说明贴图仍在飞,由最后一个 itemEnd 收尾)。
  let pending = 0;
  let modelReady = false;
  const revoke = () => {
    for (const u of blobUrls) URL.revokeObjectURL(u);
    blobUrls.length = 0;
  };
  const origItemStart = manager.itemStart.bind(manager);
  manager.itemStart = (u) => {
    pending += 1;
    origItemStart(u);
  };
  const origItemEnd = manager.itemEnd.bind(manager);
  manager.itemEnd = (u) => {
    pending -= 1;
    origItemEnd(u);
    if (modelReady && pending <= 0) revoke();
  };

  const loader = new MMDLoader(undefined, manager);
  loader.setResourcePath(RESOURCE_PREFIX);
  const modelUrl = urlByPath.get(normPath(modelEntry.name));
  if (!modelUrl) throw new Error('zip 模型条目解压失败');
  const mmd = await loader.loadAsync(modelUrl);
  // loadAsync 落定时贴图请求已全部发出(assembleMMD 内同步发起);此刻没有
  // pending 说明模型无外部贴图,直接回收。
  modelReady = true;
  if (pending <= 0) revoke();
  return mmd;
}

/**
 * 把 IK/Grant 逐帧求解挂到容器 userData 上。RAF 循环里在所有 mixer.update
 * 之后调用 `userData.mmdUpdate(playing)`:mixer 写入骨骼四元数 → CCD IK 按
 * PMX 链约束解算(足ＩＫ等)→ Grant(付与)把源骨旋转按比例乘到关联骨。
 *
 * - IK 每帧都跑(收敛型,幂等):MMD 摆姿势本来就是「拖 IK 骨,腿脚跟着走」;
 * - Grant **只在 mixer 播放中跑**:`GrantSolver.addGrantRotation` 是
 *   `bone.quaternion.multiply(...)` 叠乘,只有 mixer 每帧重写 FK 后叠加才
 *   正确;静止/单帧 scrub 时没有人重置四元数,源骨非 identity 会让受付与骨
 *   每帧累积旋转 —— 表现为脚踝/捩骨越转越歪、部件穿模(three.js 官方
 *   MMDAnimationHelper 同样只在 animation 循环里跑 GrantSolver)。
 */
export function attachMmdRuntime(group: THREE.Group, mmd: MMD): void {
  const ikSolver = mmd.iks.length > 0 ? new CCDIKSolver(mmd.mesh, mmd.iks) : null;
  const grantSolver = mmd.grants.length > 0 ? new GrantSolver(mmd.mesh, mmd.grants) : null;
  group.userData.mmdUpdate = (playing = false) => {
    ikSolver?.update();
    if (playing) grantSolver?.update();
  };
}

// ── 动作 VMD → AnimationClip ────────────────────────────────────

/** 动作 VMD 的二进制缓存(clip 与具体 mesh 绑定,不能缓存;buffer 可以)。 */
const vmdBufferCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * 加载动作 VMD 并编译成绑定到 `mesh` 的 AnimationClip。
 * VMD 用日文骨名(センター/左腕…)匹配,骨名对不上的轨道会被丢弃;
 * 一条都对不上通常说明拿非 MMD 模型来播,直接报错提示。
 */
export async function loadVmdMotionClip(
  url: string,
  mesh: THREE.SkinnedMesh,
): Promise<THREE.AnimationClip> {
  let p = vmdBufferCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`VMD 下载失败:HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => vmdBufferCache.delete(url));
    vmdBufferCache.set(url, p);
  }
  const vmd = VmdObject.ParseFromBuffer(await p);
  const clip = buildAnimation(vmd, mesh);
  if (clip.tracks.length === 0) {
    throw new Error('这条 VMD 与模型骨骼名完全不匹配(动作 VMD 需要 MMD/PMX 模型)');
  }
  clip.name = 'VMD Motion';
  return clip;
}
