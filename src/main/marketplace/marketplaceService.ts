import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

import type { Catalog, CatalogEntry, InstalledRecord, InstalledSource } from '../../types/marketplace'

/**
 * Skill Marketplace service — main process side.
 *
 * Owns the lifecycle of every USER-scope Codex skill the user installs from
 * the catalog hosted on Tencent COS: fetch the catalog, download skill zips
 * with sha256 verification, extract into `$HOME/.agents/skills/<name>/`,
 * record state under `<userData>/marketplace-state.json`, and uninstall on
 * request. The adoption pass tags pre-existing skill directories that match
 * a catalog entry (left behind by the v4.3.4 bundled-mirror) so they show
 * up in the "Installed" list without the user having to reinstall.
 *
 * Dependency-injected fetcher + filesystem paths keep this fully unit-
 * testable without Electron or real network — see
 * `__tests__/marketplaceService.test.ts`.
 */

export type { Catalog, CatalogEntry, InstalledRecord, InstalledSource } from '../../types/marketplace'

export interface MarketplaceState {
  schemaVersion: number
  installed: Record<string, InstalledRecord>
}

export interface MarketplaceServiceOptions {
  catalogUrl: string
  userSkillsDir: string
  stateFile: string
  fetcher: (url: string) => Promise<Buffer>
}

const STATE_SCHEMA_VERSION = 1

export class MarketplaceService {
  private readonly opts: MarketplaceServiceOptions
  private cachedCatalog: Catalog | null = null

  constructor(opts: MarketplaceServiceOptions) {
    this.opts = opts
  }

  async fetchCatalog(force = false): Promise<Catalog> {
    if (this.cachedCatalog && !force) return this.cachedCatalog
    const buf = await this.opts.fetcher(this.opts.catalogUrl)
    const parsed = JSON.parse(buf.toString('utf8')) as Catalog
    this.cachedCatalog = parsed
    return parsed
  }

  async install(skillName: string): Promise<InstalledRecord> {
    const catalog = await this.fetchCatalog()
    const entry = catalog.skills.find((s) => s.name === skillName)
    if (!entry) {
      throw new Error(`Skill not found in catalog: ${skillName}`)
    }

    // 1. Download.
    const zipBuf = await this.opts.fetcher(entry.url)

    // 2. Verify BEFORE touching disk. A mismatch must leave zero side
    //    effects (no half-extracted dir, no state mutation).
    const digest = sha256Hex(zipBuf)
    if (digest !== entry.sha256) {
      throw new Error(
        `sha256 mismatch for ${skillName}@${entry.version}: expected ${entry.sha256}, got ${digest}`,
      )
    }

    // 3. Extract to a temp dir first, then swap. This makes the install
    //    atomic from the user's perspective — either the new skill is fully
    //    on disk or nothing changes.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `mp-install-${skillName}-`))
    try {
      await extractZipBuffer(zipBuf, tempDir)

      const targetDir = path.join(this.opts.userSkillsDir, skillName)
      await fs.mkdir(this.opts.userSkillsDir, { recursive: true })

      // Wipe any previous install (upgrade path) before swapping in.
      await fs.rm(targetDir, { recursive: true, force: true })
      await fs.rename(tempDir, targetDir)
    } catch (err) {
      // Best-effort cleanup if the swap itself failed.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    // 4. Record in state file.
    const record: InstalledRecord = {
      name: skillName,
      version: entry.version,
      installedAt: new Date().toISOString(),
      sha256: digest,
      source: 'marketplace',
    }
    const state = await this.loadState()
    state.installed[skillName] = record
    await this.saveState(state)

    return record
  }

  async uninstall(skillName: string): Promise<void> {
    const targetDir = path.join(this.opts.userSkillsDir, skillName)
    await fs.rm(targetDir, { recursive: true, force: true })

    const state = await this.loadState()
    if (state.installed[skillName]) {
      delete state.installed[skillName]
      await this.saveState(state)
    }
  }

  async listInstalled(): Promise<InstalledRecord[]> {
    const state = await this.loadState()
    return Object.values(state.installed)
  }

  async adoptExisting(): Promise<InstalledRecord[]> {
    const catalog = await this.fetchCatalog()
    const catalogByName = new Map(catalog.skills.map((s) => [s.name, s]))
    const state = await this.loadState()

    let entries: Awaited<ReturnType<typeof fs.readdir>> = []
    try {
      entries = await fs.readdir(this.opts.userSkillsDir, { withFileTypes: true })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return []
      throw err
    }

    const newlyAdopted: InstalledRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillName = entry.name
      // Already tracked? Skip.
      if (state.installed[skillName]) continue
      // Must look like a real skill (has SKILL.md).
      const skillMdPath = path.join(this.opts.userSkillsDir, skillName, 'SKILL.md')
      try {
        await fs.access(skillMdPath)
      } catch {
        continue
      }
      // Must correspond to a catalog entry to be adopted — otherwise it's
      // user-private content and we leave it alone.
      const catalogEntry = catalogByName.get(skillName)
      if (!catalogEntry) continue

      const record: InstalledRecord = {
        name: skillName,
        version: catalogEntry.version,
        installedAt: new Date().toISOString(),
        sha256: catalogEntry.sha256,
        source: 'adopted',
      }
      state.installed[skillName] = record
      newlyAdopted.push(record)
    }

    if (newlyAdopted.length > 0) {
      await this.saveState(state)
    }
    return newlyAdopted
  }

  private async loadState(): Promise<MarketplaceState> {
    try {
      const text = await fs.readFile(this.opts.stateFile, 'utf8')
      const parsed = JSON.parse(text) as MarketplaceState
      if (!parsed.installed) parsed.installed = {}
      if (!parsed.schemaVersion) parsed.schemaVersion = STATE_SCHEMA_VERSION
      return parsed
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return { schemaVersion: STATE_SCHEMA_VERSION, installed: {} }
      }
      throw err
    }
  }

  private async saveState(state: MarketplaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.stateFile), { recursive: true })
    await fs.writeFile(this.opts.stateFile, JSON.stringify(state, null, 2), 'utf8')
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function extractZipBuffer(buf: Buffer, destDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(buf)
  // Two-pass: first create all directories, then write files. Avoids order-
  // sensitive failures where a file appears before its parent in the zip.
  const fileEntries: Array<{ relPath: string; entry: JSZip.JSZipObject }> = []
  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      await fs.mkdir(path.join(destDir, relPath), { recursive: true })
    } else {
      fileEntries.push({ relPath, entry })
    }
  }
  for (const { relPath, entry } of fileEntries) {
    const absPath = path.join(destDir, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const content = await entry.async('nodebuffer')
    await fs.writeFile(absPath, content)
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
