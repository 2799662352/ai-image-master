/**
 * Director model catalog loader.
 *
 * Source of truth: `model-catalog.json` (99 models / 5 categories), reverse-engineered
 * from RunningHub's `/canvas/director/model/list`. See docs/导演台模式-逆向研究报告.md §9.4.
 *
 * URL resolution:
 *  - If `DIRECTOR_ASSET_BASE` (env `VITE_DIRECTOR_ASSET_BASE`) is set, models/thumbnails
 *    are resolved to YOUR bucket using the layout produced by director-assets/download.ps1:
 *      <base>/models/<id>.gltf   and   <base>/thumbnails/<id>.png
 *  - Otherwise the original CDN URLs from the catalog are used as-is.
 */

import rawCatalog from './model-catalog.json';
import { DIRECTOR_ASSET_BASE } from './directorConstants';

export interface DirectorModel {
  id: string;
  name: string;
  /** Resolved GLTF url (bucket or original CDN). */
  url: string;
  /** Resolved preview thumbnail url. */
  previewImage: string;
}

export interface DirectorCategory {
  key: string;
  label: string;
  description?: string;
  models: DirectorModel[];
}

interface RawModel {
  id: string;
  name: string;
  url: string;
  previewImage?: string;
}
interface RawCategory {
  key: string;
  label: string;
  description?: string;
  models: RawModel[];
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function resolveModelUrl(m: RawModel): string {
  if (DIRECTOR_ASSET_BASE) return `${stripTrailingSlash(DIRECTOR_ASSET_BASE)}/models/${m.id}.gltf`;
  return m.url;
}

function resolveThumbUrl(m: RawModel): string {
  if (DIRECTOR_ASSET_BASE) return `${stripTrailingSlash(DIRECTOR_ASSET_BASE)}/thumbnails/${m.id}.png`;
  return m.previewImage ?? '';
}

let _catalog: DirectorCategory[] | null = null;

/** Full categorized catalog with URLs resolved to the active asset base. */
export function getCatalog(): DirectorCategory[] {
  if (_catalog) return _catalog;
  const raw = rawCatalog as unknown as RawCategory[];
  _catalog = raw.map((c) => ({
    key: c.key,
    label: c.label,
    description: c.description,
    models: (c.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      url: resolveModelUrl(m),
      previewImage: resolveThumbUrl(m),
    })),
  }));
  return _catalog;
}

/** Flat list of every model. */
export function getAllModels(): DirectorModel[] {
  return getCatalog().flatMap((c) => c.models);
}

export function findModel(id: string): DirectorModel | undefined {
  return getAllModels().find((m) => m.id === id);
}

// Note: 普通假人 (路人/crowd) is NOT a catalog model — it is procedurally
// generated in directorMannequin.ts (single/array/random, see docs §11).
// 高级假人 loads the Mixamo X/Y bot FBX rigs (director/rig/{x,y}_bot.fbx).
