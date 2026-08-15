import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

import type {
  InstalledPluginRecord,
  PluginCatalog,
  PluginCatalogEntry,
} from '../../types/marketplace'

/**
 * Plugin Marketplace service — main process side.
 *
 * A plugin is a one-click bundle of skills. Installing it downloads the plugin
 * zip (sha256-verified), extracts it to a temp dir, then moves every
 * `<plugin>/skills/<name>/` subdir into `userSkillsDir/<name>/` (the same place
 * individually-installed skills land, so Codex skill discovery picks them up
 * with no further changes). The commands/hooks bundled for external IDE
 * harnesses are intentionally NOT consumed in-app.
 *
 * Uninstalling a plugin removes exactly the skill dirs it recorded, then drops
 * its state entry. State lives in `<userData>/plugin-marketplace-state.json`,
 * separate from the per-skill marketplace ledger.
 *
 * Upgrading diffs against the previous record and removes skills the plugin no
 * longer ships. Without that pass a dropped skill would linger forever: the
 * install loop only walks the NEW zip, and the ledger is replaced wholesale, so
 * nothing would even remember the directory belonged to this plugin — it would
 * be both un-updatable and un-uninstallable.
 *
 * We need this because skills land in one FLAT SHARED namespace. Codex's own
 * marketplaces are git checkouts whose whole tree is replaced on
 * `marketplace/upgrade`, so deletions propagate for free; per-item installers
 * (us, Homebrew) have to reconcile explicitly instead.
 *
 * Dependency-injected fetcher + paths keep this fully unit-testable without
 * Electron or real network — see `__tests__/pluginMarketplaceService.test.ts`.
 */

export type {
  InstalledPluginRecord,
  PluginCatalog,
  PluginCatalogEntry,
} from '../../types/marketplace'

export interface PluginMarketplaceState {
  schemaVersion: number
  installed: Record<string, InstalledPluginRecord>
}

export interface PluginMarketplaceServiceOptions {
  catalogUrl: string
  /** Where bundled skills are extracted (`$HOME/.agents/skills`). */
  userSkillsDir: string
  stateFile: string
  fetcher: (url: string) => Promise<Buffer>
  /**
   * Optional path to the per-skill marketplace ledger
   * (`<userData>/marketplace-state.json`). When provided, uninstall will NOT
   * delete a skill dir that the per-skill marketplace also owns — preventing
   * silent deletion of an independently-installed skill (review finding I2).
   */
  skillStateFile?: string
}

const STATE_SCHEMA_VERSION = 1

export class PluginMarketplaceService {
  private readonly opts: PluginMarketplaceServiceOptions
  private cachedCatalog: PluginCatalog | null = null

  constructor(opts: PluginMarketplaceServiceOptions) {
    this.opts = opts
  }

  async fetchCatalog(force = false): Promise<PluginCatalog> {
    if (this.cachedCatalog && !force) return this.cachedCatalog
    const buf = await this.opts.fetcher(this.opts.catalogUrl)
    const parsed = JSON.parse(buf.toString('utf8')) as PluginCatalog
    this.cachedCatalog = parsed
    return parsed
  }

  async install(pluginName: string): Promise<InstalledPluginRecord> {
    const catalog = await this.fetchCatalog()
    const entry = catalog.plugins.find((p) => p.name === pluginName)
    if (!entry) {
      throw new Error(`Plugin not found in catalog: ${pluginName}`)
    }

    // 1. Download.
    const zipBuf = await this.opts.fetcher(entry.url)

    // 2. Verify BEFORE touching disk — a mismatch leaves zero side effects.
    const digest = sha256Hex(zipBuf)
    if (digest !== entry.sha256) {
      throw new Error(
        `sha256 mismatch for ${pluginName}@${entry.version}: expected ${entry.sha256}, got ${digest}`,
      )
    }

    // 3. Extract to a temp dir, then atomically swap each bundled skill into
    //    place. "Atomic" here means all-or-nothing across the skill set: we
    //    back up any existing target first, move the new ones in, and on ANY
    //    failure we roll back — restoring the previous install. Without this an
    //    upgrade that fails on skill k would have already deleted skill k's old
    //    version with no ledger entry to recover it (review finding I1).
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `mp-plugin-${pluginName}-`))
    const backups: Array<{ target: string; backup: string }> = []
    const movedTargets: string[] = []
    const installedSkills: string[] = []
    try {
      await extractZipBuffer(zipBuf, tempDir)
      const skillsRoot = await locateSkillsRoot(tempDir, pluginName)
      if (!skillsRoot) {
        throw new Error(`Plugin ${pluginName} contains no skills/ directory`)
      }

      // Collect installable skills first (dirs with a SKILL.md).
      const candidates: Array<{ name: string; src: string }> = []
      for (const d of await fs.readdir(skillsRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const src = path.join(skillsRoot, d.name)
        try {
          await fs.access(path.join(src, 'SKILL.md'))
        } catch {
          continue
        }
        candidates.push({ name: d.name, src })
      }
      if (candidates.length === 0) {
        throw new Error(`Plugin ${pluginName} contained no installable skills`)
      }

      await fs.mkdir(this.opts.userSkillsDir, { recursive: true })
      for (const c of candidates) {
        const target = path.join(this.opts.userSkillsDir, c.name)
        // Back up an existing install (rename within the same dir = same
        // volume = atomic) so we can restore it if a later skill fails.
        if (await pathExists(target)) {
          const backup = `${target}.mp-bak-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
          await fs.rename(target, backup)
          backups.push({ target, backup })
        }
        await moveDir(c.src, target)
        movedTargets.push(target)
        installedSkills.push(c.name)
      }

      // Success — discard backups.
      for (const b of backups) {
        await fs.rm(b.backup, { recursive: true, force: true }).catch(() => {})
      }
    } catch (err) {
      // Roll back: remove anything we moved in, then restore backups.
      for (const t of movedTargets) {
        await fs.rm(t, { recursive: true, force: true }).catch(() => {})
      }
      for (const b of backups) {
        await fs.rm(b.target, { recursive: true, force: true }).catch(() => {})
        await fs.rename(b.backup, b.target).catch(() => {})
      }
      throw err
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }

    const state = await this.loadState()

    // 4. 升级差集:清掉「上一版有、这一版没有」的 skill 目录。
    //
    // 安装只按新包里的目录名逐个覆盖,从不回看上一次装了什么。所以插件删掉一个
    // skill 时,那个目录会留在盘上永不更新;而紧接着台账被整条替换成新列表,
    // 它连卸载都碰不到 —— 既不更新也删不掉的孤儿。
    //
    // 放在移动成功之后:安装失败已经回滚过,这时不该再动用户的盘。
    // 放在写台账之前:清理用的是**旧**记录,写完就查不到了。
    const previous = state.installed[pluginName]
    if (previous) {
      const stillShipped = new Set(installedSkills)
      const ownedByOthers = await this.skillsOwnedByOthers(state, pluginName)
      for (const skillName of previous.skills) {
        if (stillShipped.has(skillName) || ownedByOthers.has(skillName)) continue
        // 尽力而为:安装本身已经成功,清不掉一个孤儿不该让整次升级失败。
        await fs
          .rm(path.join(this.opts.userSkillsDir, skillName), { recursive: true, force: true })
          .catch(() => {})
      }
    }

    // 5. Record state.
    const record: InstalledPluginRecord = {
      name: pluginName,
      version: entry.version,
      installedAt: new Date().toISOString(),
      sha256: digest,
      skills: installedSkills.sort(),
    }
    state.installed[pluginName] = record
    await this.saveState(state)

    return record
  }

  async uninstall(pluginName: string): Promise<void> {
    const state = await this.loadState()
    const record = state.installed[pluginName]
    if (!record) return

    const keep = await this.skillsOwnedByOthers(state, pluginName)
    for (const skillName of record.skills) {
      if (keep.has(skillName)) continue
      const targetDir = path.join(this.opts.userSkillsDir, skillName)
      await fs.rm(targetDir, { recursive: true, force: true })
    }

    delete state.installed[pluginName]
    await this.saveState(state)
  }

  /**
   * 除 `excludePlugin` 外,还有谁占着 skill 目录。
   *
   * skill 装在**共享的平铺命名空间** `<userSkillsDir>/<name>/` 下,同一个目录可能
   * 同时被另一个已装插件、或单技能市场的台账拥有。删之前必须问一遍,否则会静默毁掉
   * 别人管理的 skill(review finding I2)。
   *
   * 卸载与升级差集共用这一份判定 —— 两处各写一份的话,迟早只有一处记得问。
   */
  private async skillsOwnedByOthers(
    state: PluginMarketplaceState,
    excludePlugin: string,
  ): Promise<Set<string>> {
    const owned = new Set<string>()
    for (const [name, rec] of Object.entries(state.installed)) {
      if (name === excludePlugin) continue
      for (const s of rec.skills) owned.add(s)
    }
    for (const s of await this.readSkillLedgerNames()) owned.add(s)
    return owned
  }

  /** Best-effort read of skill names owned by the per-skill marketplace. */
  private async readSkillLedgerNames(): Promise<Set<string>> {
    const names = new Set<string>()
    if (!this.opts.skillStateFile) return names
    try {
      const text = await fs.readFile(this.opts.skillStateFile, 'utf8')
      const parsed = JSON.parse(text) as { installed?: Record<string, unknown> }
      for (const name of Object.keys(parsed.installed ?? {})) names.add(name)
    } catch {
      // No ledger / unreadable → treat as "owns nothing".
    }
    return names
  }

  async listInstalled(): Promise<InstalledPluginRecord[]> {
    const state = await this.loadState()
    return Object.values(state.installed)
  }

  private async loadState(): Promise<PluginMarketplaceState> {
    try {
      const text = await fs.readFile(this.opts.stateFile, 'utf8')
      const parsed = JSON.parse(text) as PluginMarketplaceState
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

  private async saveState(state: PluginMarketplaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.stateFile), { recursive: true })
    await fs.writeFile(this.opts.stateFile, JSON.stringify(state, null, 2), 'utf8')
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Plugin zips are produced with a stable top-level folder equal to the plugin
 * name (`<plugin>/skills/...`), but be defensive: accept `<root>/skills` too.
 */
async function locateSkillsRoot(tempDir: string, pluginName: string): Promise<string | null> {
  const candidate = path.join(tempDir, pluginName, 'skills')
  if (await isDir(candidate)) return candidate

  const flat = path.join(tempDir, 'skills')
  if (await isDir(flat)) return flat

  // Single top-level dir of unknown name → look for skills/ under it.
  const top = await fs.readdir(tempDir, { withFileTypes: true })
  const dirs = top.filter((d) => d.isDirectory())
  if (dirs.length === 1) {
    const nested = path.join(tempDir, dirs[0].name, 'skills')
    if (await isDir(nested)) return nested
  }
  return null
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
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

/** Move a directory; fall back to recursive copy when crossing filesystems. */
async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
  } catch (err) {
    if (isNodeError(err) && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      await fs.cp(src, dest, { recursive: true })
      await fs.rm(src, { recursive: true, force: true })
    } else {
      throw err
    }
  }
}

async function extractZipBuffer(buf: Buffer, destDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(buf)
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
