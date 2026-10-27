import { createHash } from 'node:crypto'
import { promises as fs, type Dirent } from 'node:fs'
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

    // 4. Record in state file, migrating any previous name in the same write.
    const record: InstalledRecord = {
      name: skillName,
      version: entry.version,
      installedAt: new Date().toISOString(),
      sha256: digest,
      source: 'marketplace',
    }
    const state = await this.loadState()
    await this.migrateRenamedFrom(entry, catalog, state)
    state.installed[skillName] = record
    await this.saveState(state)

    return record
  }

  /**
   * 清掉这个 skill 曾用名留下的目录与台账条目。
   *
   * skill 装在**共享的平铺命名空间**里，改名之后新名字装进来，旧目录既不会被覆盖
   * （不在新包里）也不会被删除（没人记得它属于谁），变成既不更新也删不掉的孤儿 ——
   * 而它的正文引用的还是老名字，新旧两套会同时被 agent 看见。客户端无法自己看出
   * 两个名字是同一个东西，所以改名由 catalog 的 `renamedFrom` 显式声明（做法同
   * Homebrew 的 `formula_renames.json`；链已在发布时折叠，这里不做传递解析）。
   *
   * 放在安装成功之后：安装失败已经回滚过，那时不该动用户盘上的旧版本 —— 否则
   * 一次失败的升级会同时毁掉他手上能用的那份。
   */
  private async migrateRenamedFrom(
    entry: CatalogEntry,
    catalog: Catalog,
    state: MarketplaceState,
  ): Promise<void> {
    if (!entry.renamedFrom?.length) return
    // 仍在售的名字不是曾用名。防的是改名表手滑把一个还在提供的 skill 写成别人的
    // 旧名 —— 那会静默卸载用户正在用的东西。
    const listed = new Set(catalog.skills.map((s) => s.name))

    for (const oldName of entry.renamedFrom) {
      if (oldName === entry.name || listed.has(oldName)) continue
      // 尽力而为:skill 已经装好了,清不掉一个旧目录不该让整次安装失败。
      await fs
        .rm(path.join(this.opts.userSkillsDir, oldName), { recursive: true, force: true })
        .catch(() => {})
      delete state.installed[oldName]
    }
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

    // 写死 `Dirent[]`,不要用 `Awaited<ReturnType<typeof fs.readdir>>`:readdir 是
    // 重载函数,`ReturnType` 只取**最后一个**重载,而那个是 `encoding:'buffer'` +
    // `withFileTypes:true` 的变体(@types/node 20.19 fs/promises.d.ts:734),于是
    // 声明成了 `Dirent<NonSharedBuffer>[]` —— 和下面这次不带 encoding 的调用
    // (名字是 string)对不上,还会把 Buffer 传染给每个 entry.name 的使用点。
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(this.opts.userSkillsDir, { withFileTypes: true })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return []
      throw err
    }

    // 曾用名 → 现名。改名迁移在这里也做一次:`install` 那条只在用户**主动装
    // 新名字**时触发,而装了旧名字之后什么都不做的用户占大多数 —— 他们会永远
    // 留着那个孤儿。本方法每次启动都跑(src/main/index.ts),正是补这一刀的地方。
    const currentNameByOldName = new Map<string, string>()
    for (const s of catalog.skills) {
      for (const oldName of s.renamedFrom ?? []) {
        if (!catalogByName.has(oldName)) currentNameByOldName.set(oldName, s.name)
      }
    }
    let migrated = false

    const newlyAdopted: InstalledRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillName = entry.name

      // 曾用名的目录该被清掉,而不是被认领 —— 认领等于把一个已改名的东西登记成
      // 「已安装」,用户会在列表里看到一个装不了也更新不了的幽灵。
      if (currentNameByOldName.has(skillName)) {
        await fs
          .rm(path.join(this.opts.userSkillsDir, skillName), { recursive: true, force: true })
          .catch(() => {})
        if (state.installed[skillName]) delete state.installed[skillName]
        migrated = true
        continue
      }

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

    // 迁移也要落盘 —— 只按 newlyAdopted 判会让「只清理、没认领」的那次白跑,
    // 下次启动重新清一遍(目录已经没了,但台账里的幽灵条目会一直留着)。
    if (newlyAdopted.length > 0 || migrated) {
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

/** Reject any zip entry whose resolved path escapes destDir (Zip Slip). */
function safeJoin(destDir: string, relPath: string): string {
  const abs = path.resolve(destDir, relPath)
  const root = path.resolve(destDir)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Unsafe zip entry path escapes archive root: ${relPath}`)
  }
  return abs
}

async function extractZipBuffer(buf: Buffer, destDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(buf)
  // Two-pass: first create all directories, then write files. Avoids order-
  // sensitive failures where a file appears before its parent in the zip.
  const fileEntries: Array<{ relPath: string; entry: JSZip.JSZipObject }> = []
  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      await fs.mkdir(safeJoin(destDir, relPath), { recursive: true })
    } else {
      fileEntries.push({ relPath, entry })
    }
  }
  for (const { relPath, entry } of fileEntries) {
    const absPath = safeJoin(destDir, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const content = await entry.async('nodebuffer')
    await fs.writeFile(absPath, content)
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
