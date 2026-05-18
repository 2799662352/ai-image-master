import { ipcMain } from 'electron'

import { MarketplaceService } from './marketplaceService'
import type { MarketplaceServiceOptions } from './marketplaceService'

/**
 * Tencent COS marketplace catalog hosted at the image-master bucket. Single
 * source of truth for which Codex-only skills are available to install. See
 * `scripts/upload-skills-to-cos.mjs` for the publish side.
 */
export const DEFAULT_CATALOG_URL =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/skills/catalog.json'

/** Whole-buffer http GET. Used as the marketplace service's `fetcher`. */
async function nodeFetch(url: string): Promise<Buffer> {
  // Node 18+ ships a global `fetch`. We deliberately do NOT use
  // `electron.net.fetch` because that pulls in Chromium's network stack
  // and is overkill for static-asset GETs against a public-read bucket.
  const res = await fetch(url, { redirect: 'follow' })
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

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
