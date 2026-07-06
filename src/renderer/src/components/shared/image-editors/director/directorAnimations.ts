/**
 * Director animation catalog loader (高级假人动画 Tab 数据层).
 *
 * Source of truth: `animation-catalog.json` (2032 animations / 19 categories),
 * reverse-engineered from RunningHub's `/canvas/animation/{category,resource}/list`
 * (full dump: docs/director-animation-catalog.json). 动画 FBX 与 X/Y Bot rig 同为
 * Mixamo 骨骼,加载后可直接 mixer.clipAction 播放。
 *
 * URL resolution (与 directorCatalog 同款双轨):
 *  - `DIRECTOR_ASSET_BASE` (env `VITE_DIRECTOR_ASSET_BASE`) 非空 → 自有桶
 *    `<base>/animations/<id>.fbx`;
 *  - 否则拼原始 CDN `<CDN_BASE>/<uid>/<file ?? 'animation'>.fbx`。
 */

import { DIRECTOR_ASSET_BASE } from './directorConstants';

export interface DirectorAnimation {
  id: string;
  /** 分类 code(对应 AnimCategory.code). */
  cat: string;
  name: string;
  nameEn: string;
  /** CDN 路径里的 32 位 hex 目录名. */
  uid: string;
  /** FBX 文件名(不含扩展名);缺省 = 'animation'. */
  file?: string;
}

export interface AnimCategory {
  code: string;
  name: string;
}

export interface AnimCatalog {
  categories: AnimCategory[];
  animations: DirectorAnimation[];
}

const CDN_BASE = 'https://rh-canvas-files.xiaoyaoyou.com/default/animation';

let catalogPromise: Promise<AnimCatalog> | null = null;

/** 动态 import(≈330KB JSON 独立 chunk,首次打开动画 Tab 才加载),缓存单例. */
export function loadAnimCatalog(): Promise<AnimCatalog> {
  catalogPromise ??= import('./animation-catalog.json').then(
    (m) => (m as { default: unknown }).default as AnimCatalog,
  );
  return catalogPromise;
}

/** 双轨解析:自有桶 base 非空 → <base>/animations/<id>.fbx;否则原始 CDN. */
export function animUrl(a: DirectorAnimation, base: string = DIRECTOR_ASSET_BASE): string {
  const b = base.replace(/\/+$/, '');
  if (b) return `${b}/animations/${a.id}.fbx`;
  return `${CDN_BASE}/${a.uid}/${a.file ?? 'animation'}.fbx`;
}

/** 分类 + 关键词(中文子串 / 英文不分大小写)过滤;均可省略. */
export function filterAnimations(
  list: readonly DirectorAnimation[],
  opts: { category?: string; keyword?: string } = {},
): DirectorAnimation[] {
  const cat = opts.category ?? '';
  const kw = (opts.keyword ?? '').trim().toLowerCase();
  return list.filter((a) => {
    if (cat && a.cat !== cat) return false;
    if (!kw) return true;
    return a.name.toLowerCase().includes(kw) || a.nameEn.toLowerCase().includes(kw);
  });
}
