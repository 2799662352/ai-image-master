/**
 * MMD 物理接入:Ammo.js(Bullet wasm)加载 + three.js r171 MMDPhysics 组装。
 *
 * - ammo.wasm.js 是 emscripten 经典脚本(非 ESM),用 <script> 注入拿到全局
 *   工厂函数,resolve 后把模块实例回写 window.Ammo —— vendor/MMDPhysics.js
 *   引用的就是裸全局 `Ammo`(three.js 官方示例同款用法);
 * - wasm 二进制经 Vite `?url` 资产化,用 locateFile 定位(打包后文件名带 hash);
 * - MMDPhysics r171 自带「非单位缩放时临时摘 parent 在模型空间模拟」的处理,
 *   导演台 normalizeModel 对 MMD 模型的整体缩放不会破坏物理;
 * - 整条链路失败只降级为无物理(与接入前行为一致),不阻塞模型使用。
 */

import type * as THREE from 'three';
import ammoJsUrl from 'three/examples/jsm/libs/ammo.wasm.js?url';
import ammoWasmUrl from 'three/examples/jsm/libs/ammo.wasm.wasm?url';
import {
  buildMmdPhysicsParams,
  type PmxBoneLike,
  type PmxJointLike,
  type PmxRigidBodyLike,
} from './directorMmdPhysicsParams';

/** vendor/MMDPhysics.js 的运行时最小接口。 */
export interface MmdPhysicsLike {
  update(delta: number): unknown;
  reset(): unknown;
  warmup(cycles: number): unknown;
}

/** createMmdPhysics 需要的 PMX 数据切面(@moeru/three-mmd 的 PmxObject 子集)。 */
export interface MmdPhysicsPmxData {
  bones: readonly PmxBoneLike[];
  rigidBodies?: readonly PmxRigidBodyLike[];
  joints?: readonly PmxJointLike[];
}

type AmmoFactory = (config?: {
  locateFile?: (file: string) => string;
  wasmBinary?: ArrayBuffer;
}) => Promise<object>;

let ammoPromise: Promise<void> | null = null;

/**
 * 拉取 wasm 二进制。生产环境 renderer 走 file:// —— Chromium 的 fetch 不支持
 * file:// 方案,退回 XHR(Electron 的 file:// 页面允许);拿到字节后经
 * `wasmBinary` 直接喂给 emscripten,完全绕开其内部加载器。
 */
async function fetchWasmBinary(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.response) resolve(xhr.response as ArrayBuffer);
        else reject(new Error('ammo.wasm 读取失败(空响应)'));
      };
      xhr.onerror = () => reject(new Error('ammo.wasm 读取失败(XHR error)'));
      xhr.send();
    });
  }
}

/** 加载并初始化全局 Ammo(幂等;失败后允许下次重试)。 */
function loadAmmo(): Promise<void> {
  if (!ammoPromise) {
    ammoPromise = (async () => {
      const w = window as unknown as { Ammo?: unknown };
      // 已经是初始化完的模块实例(有 btVector3)则直接复用。
      if (
        w.Ammo &&
        typeof (w.Ammo as { btVector3?: unknown }).btVector3 === 'function'
      ) {
        return;
      }
      if (typeof w.Ammo !== 'function') {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = ammoJsUrl;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('ammo.wasm.js 脚本加载失败'));
          document.head.appendChild(s);
        });
      }
      const factory = w.Ammo as AmmoFactory;
      const wasmBinary = await fetchWasmBinary(ammoWasmUrl);
      const lib = await factory({
        wasmBinary,
        locateFile: (file) => (file.endsWith('.wasm') ? ammoWasmUrl : file),
      });
      (window as unknown as { Ammo: object }).Ammo = lib;
    })();
    ammoPromise.catch(() => {
      ammoPromise = null;
    });
  }
  return ammoPromise;
}

/**
 * 为一个已加载的 MMD 模型创建物理世界。没有刚体数据(极简模型/PMD 早期版)
 * 返回 null。构造完成后 reset 一次,把刚体钉到当前骨骼姿势上。
 */
export async function createMmdPhysics(
  mesh: THREE.SkinnedMesh,
  pmx: MmdPhysicsPmxData,
): Promise<MmdPhysicsLike | null> {
  const { rigidBodies, constraints } = buildMmdPhysicsParams(pmx);
  if (rigidBodies.length === 0) return null;
  await loadAmmo();
  const { MMDPhysics } = await import('./vendor/MMDPhysics.js');
  const physics = new MMDPhysics(
    mesh as never,
    rigidBodies as never,
    constraints as never,
  ) as unknown as MmdPhysicsLike;
  physics.reset();
  return physics;
}
