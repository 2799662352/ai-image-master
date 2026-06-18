import { ipcMain } from 'electron'

import { MarketplaceService } from './marketplaceService'
import type { MarketplaceServiceOptions } from './marketplaceService'
import { PluginMarketplaceService } from './pluginMarketplaceService'

/**
 * Tencent COS marketplace catalog hosted at the image-master bucket. Single
 * source of truth for which Codex-only skills are available to install. See
 * `scripts/upload-skills-to-cos.mjs` for the publish side.
 */
export const DEFAULT_CATALOG_URL =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/skills/catalog.json'

/**
 * Plugin catalog (one-click skill bundles). See
 * `scripts/upload-plugins-to-cos.mjs` for the publish side.
 */
export const DEFAULT_PLUGIN_CATALOG_URL =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/plugins/plugins-catalog.json'

/** Whole-buffer http GET. Used as the marketplace service's `fetcher`. */
async function nodeFetch(url: string): Promise<Buffer> {
  // Node 18+ ships a global `fetch`. We deliberately do NOT use
  // `electron.net.fetch` because that pulls in Chromium's network stack
  // and is overkill for static-asset GETs against a public-read bucket.
  //
  // Cache-bust catalog GETs (review finding C1): zips are version-keyed and
  // re-publishing a version yields a NEW sha256, so a CDN/edge-cached stale
  // catalog (old sha) paired with a freshly-overwritten zip (new sha) would
  // hard-fail the sha256 check and block install/update with no recovery.
  // Skill/plugin zips themselves stay cacheable (immutable per version).
  const finalUrl = url.includes('catalog.json')
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  const res = await fetch(finalUrl, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

export interface RegisterMarketplaceIpcOptions {
  userSkillsDir: string
  stateFile: string
  catalogUrl?: string
  /** Override the http fetcher (used by tests / offline mode). */
  fetcher?: MarketplaceServiceOptions['fetcher']
}

export function registerMarketplaceIpc(opts: RegisterMarketplaceIpcOptions): MarketplaceService {
  const service = new MarketplaceService({
    catalogUrl: opts.catalogUrl ?? DEFAULT_CATALOG_URL,
    userSkillsDir: opts.userSkillsDir,
    stateFile: opts.stateFile,
    fetcher: opts.fetcher ?? nodeFetch,
  })

  // Renderer-side asks "what's available?" — returns the parsed catalog or
  // the cached one if we've already fetched in this process.
  ipcMain.handle('marketplace:fetch-catalog', async (_e, force?: boolean) => {
    try {
      const catalog = await service.fetchCatalog(force === true)
      return { ok: true, catalog }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('marketplace:install', async (_e, skillName: string) => {
    try {
      const record = await service.install(skillName)
      return { ok: true, record }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('marketplace:uninstall', async (_e, skillName: string) => {
    try {
      await service.uninstall(skillName)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('marketplace:list-installed', async () => {
    try {
      const list = await service.listInstalled()
      return { ok: true, installed: list }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  // Where installs land on disk — surfaced in the marketplace UI so users can
  // see (and open) the install location. Skills and plugin-bundled skills both
  // extract into this same `$HOME/.agents/skills` dir.
  ipcMain.handle('marketplace:get-paths', async () => {
    try {
      return { ok: true, paths: { userSkillsDir: opts.userSkillsDir } }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  // Fire-and-forget on startup; also exposed as IPC so the UI can re-run it
  // after the user manually drops a directory into `~/.agents/skills/` and
  // wants the marketplace to pick it up.
  ipcMain.handle('marketplace:adopt-existing', async () => {
    try {
      const adopted = await service.adoptExisting()
      return { ok: true, adopted }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  return service
}

export interface RegisterPluginMarketplaceIpcOptions {
  userSkillsDir: string
  stateFile: string
  catalogUrl?: string
  fetcher?: MarketplaceServiceOptions['fetcher']
  /**
   * Path to the per-skill marketplace ledger so plugin uninstall can avoid
   * deleting a skill dir the per-skill marketplace independently owns (I2).
   */
  skillStateFile?: string
}

export function registerPluginMarketplaceIpc(
  opts: RegisterPluginMarketplaceIpcOptions,
): PluginMarketplaceService {
  const service = new PluginMarketplaceService({
    catalogUrl: opts.catalogUrl ?? DEFAULT_PLUGIN_CATALOG_URL,
    userSkillsDir: opts.userSkillsDir,
    stateFile: opts.stateFile,
    fetcher: opts.fetcher ?? nodeFetch,
    skillStateFile: opts.skillStateFile,
  })

  ipcMain.handle('plugin-marketplace:fetch-catalog', async (_e, force?: boolean) => {
    try {
      const catalog = await service.fetchCatalog(force === true)
      return { ok: true, catalog }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('plugin-marketplace:install', async (_e, pluginName: string) => {
    try {
      const record = await service.install(pluginName)
      return { ok: true, record }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('plugin-marketplace:uninstall', async (_e, pluginName: string) => {
    try {
      await service.uninstall(pluginName)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  ipcMain.handle('plugin-marketplace:list-installed', async () => {
    try {
      const list = await service.listInstalled()
      return { ok: true, installed: list }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  })

  return service
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
