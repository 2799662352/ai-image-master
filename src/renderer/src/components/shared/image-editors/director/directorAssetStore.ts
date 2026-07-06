/**
 * Director 本地导入资产的持久化仓库(「我的模型 / 预设模型」+ 全景图)。
 *
 * 用户从本地导入的模型/全景图通常是几 MB ~ 数十 MB 的二进制,localStorage
 * 上限只有 ~5MB,放不下,因此用 IndexedDB 存 Blob,刷新/重开后仍在 → 可持久化。
 *
 * 用法:
 *   await putAsset({ kind:'model', name, blob, ext, isFbx })  // 写入
 *   await listAssets('model')                                 // 列出
 *   const url = await openAssetUrl(id)                         // 取 objectURL 加载
 *   await deleteAsset(id)                                      // 删除
 */

export type AssetKind = 'model' | 'panorama' | 'animation' | 'camera';

export interface DirectorAsset {
  id: string;
  kind: AssetKind;
  name: string;
  /** 文件扩展名(小写,不含点):glb / gltf / fbx / png / jpg / hdr … */
  ext: string;
  /** 模型是否为 FBX(含骨骼的高级模型走 FBXLoader)。 */
  isFbx?: boolean;
  /** 原始二进制。 */
  blob: Blob;
  /** 缩略图 dataURL(全景图为图片本身的缩略;模型暂用占位)。 */
  thumb?: string;
  /** 文件字节数(用于 UI 展示)。 */
  size: number;
  createdAt: number;
}

const DB_NAME = 'director-assets';
const DB_VERSION = 1;
const STORE = 'assets';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB,无法持久化导入的资产'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('kind', 'kind', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  return _dbPromise;
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function newId(): string {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface PutAssetInput {
  kind: AssetKind;
  name: string;
  ext: string;
  isFbx?: boolean;
  blob: Blob;
  thumb?: string;
}

/** 写入一条资产,返回完整记录(含生成的 id)。 */
export async function putAsset(input: PutAssetInput): Promise<DirectorAsset> {
  const rec: DirectorAsset = {
    id: newId(),
    kind: input.kind,
    name: input.name,
    ext: input.ext.toLowerCase(),
    isFbx: input.isFbx,
    blob: input.blob,
    thumb: input.thumb,
    size: input.blob.size,
    createdAt: Date.now(),
  };
  const store = await tx('readwrite');
  await reqToPromise(store.put(rec));
  return rec;
}

/** 列出某类资产(按导入时间倒序)。 */
export async function listAssets(kind: AssetKind): Promise<DirectorAsset[]> {
  const store = await tx('readonly');
  const all = await reqToPromise<DirectorAsset[]>(store.getAll() as IDBRequest<DirectorAsset[]>);
  return all.filter((a) => a.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAsset(id: string): Promise<DirectorAsset | undefined> {
  const store = await tx('readonly');
  return reqToPromise<DirectorAsset | undefined>(
    store.get(id) as IDBRequest<DirectorAsset | undefined>,
  );
}

/** 取资产的可加载 objectURL(调用方负责在不再需要时 revoke)。 */
export async function openAssetUrl(id: string): Promise<{ url: string; asset: DirectorAsset } | null> {
  const asset = await getAsset(id);
  if (!asset) return null;
  return { url: URL.createObjectURL(asset.blob), asset };
}

export async function deleteAsset(id: string): Promise<void> {
  const store = await tx('readwrite');
  await reqToPromise(store.delete(id));
}

// ── 拖拽 ────────────────────────────────────────────────────────

/**
 * 动画卡片 → K 动画时间轴的 dataTransfer 类型。payload JSON:
 * `{ url?, ext?, name?, assetId? }`(目录动画带 url;「我的动画」带 assetId)。
 */
export const ANIM_DND_MIME = 'application/x-director-anim';

// ── 文件辅助 ─────────────────────────────────────────────────────

export const MODEL_EXTS = ['glb', 'gltf', 'fbx'] as const;
export const PANORAMA_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif'] as const;
/** 动画剪辑:fbx(Mixamo 等)/ glb/gltf(取 animations[0])/ json(本软件 K 动画导出)。 */
export const ANIM_EXTS = ['fbx', 'glb', 'gltf', 'json'] as const;
/** 镜头剪辑:json(director-camera@1 / 裸 AnimationClip)/ glb/gltf/fbx(相机动画烘焙采样)。 */
export const CAMERA_EXTS = ['json', 'glb', 'gltf', 'fbx'] as const;
/** 建议体积上限(字节)。超过仍可导入,只是给出提醒。 */
export const MODEL_SIZE_HINT = 80 * 1024 * 1024; // 80MB
export const PANORAMA_SIZE_HINT = 40 * 1024 * 1024; // 40MB
export const ANIM_SIZE_HINT = 40 * 1024 * 1024; // 40MB

export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

export function isModelExt(ext: string): boolean {
  return (MODEL_EXTS as readonly string[]).includes(ext.toLowerCase());
}

export function isPanoramaExt(ext: string): boolean {
  return (PANORAMA_EXTS as readonly string[]).includes(ext.toLowerCase());
}

export function isAnimExt(ext: string): boolean {
  return (ANIM_EXTS as readonly string[]).includes(ext.toLowerCase());
}

export function isCameraExt(ext: string): boolean {
  return (CAMERA_EXTS as readonly string[]).includes(ext.toLowerCase());
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 为图片文件生成一张小缩略(dataURL),失败则返回 undefined。 */
export function makeImageThumb(blob: Blob, max = 160): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx) {
          resolve(undefined);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(undefined);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    img.src = url;
  });
}
