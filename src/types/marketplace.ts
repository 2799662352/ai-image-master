/**
 * Shared types for the Skill Marketplace (main ↔ preload ↔ renderer).
 *
 * Source of truth lives in `src/main/marketplace/marketplaceService.ts` —
 * this file re-declares the same shapes so the renderer can `import type`
 * without pulling Electron / Node dependencies through to the bundle.
 */

export interface CatalogEntry {
  name: string
  version: string
  description: string
  size: number
  sha256: string
  url: string
}

export interface Catalog {
  schemaVersion: number
  generatedAt: string
  skills: CatalogEntry[]
}

export type InstalledSource = 'marketplace' | 'adopted'

export interface InstalledRecord {
  name: string
  version: string
  installedAt: string
  sha256: string
  source: InstalledSource
}

/* ----------------------------- IPC envelopes ----------------------------- */

export type MarketplaceFetchCatalogResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; error: string }

export type MarketplaceInstallResult =
  | { ok: true; record: InstalledRecord }
  | { ok: false; error: string }

export type MarketplaceUninstallResult = { ok: true } | { ok: false; error: string }

export type MarketplaceListInstalledResult =
  | { ok: true; installed: InstalledRecord[] }
  | { ok: false; error: string }

export type MarketplaceAdoptExistingResult =
  | { ok: true; adopted: InstalledRecord[] }
  | { ok: false; error: string }

/**
 * Where the marketplace installs content on this machine. Skills AND plugin-
 * bundled skills both land in `userSkillsDir` (`$HOME/.agents/skills`); the
 * UI surfaces this so users know where their installs live.
 */
export interface MarketplacePaths {
  userSkillsDir: string
}

export type MarketplaceGetPathsResult =
  | { ok: true; paths: MarketplacePaths }
  | { ok: false; error: string }

/* ------------------------------- Plugins -------------------------------- */
/**
 * A plugin is a one-click bundle of skills (+ commands/hooks for external IDE
 * harnesses). In-app we only consume the bundled skills: installing a plugin
 * extracts every `<plugin>/skills/<name>/` into `$HOME/.agents/skills/<name>/`,
 * exactly where individually-installed skills land. Catalog hosted at
 * `plugins/plugins-catalog.json` on COS (see scripts/upload-plugins-to-cos.mjs).
 */
export interface PluginCatalogEntry {
  name: string
  version: string
  description: string
  /** Number of bundled skills (for display only). */
  skills: number
  /** Number of bundled slash-commands (for display only). */
  commands: number
  size: number
  sha256: string
  url: string
}

export interface PluginBundleEntry {
  name: string
  version: string
  size: number
  sha256: string
  url: string
}

export interface PluginCatalog {
  schemaVersion: number
  generatedAt: string
  marketplace?: { name: string; description: string; owner?: { name: string; url?: string } }
  bundle?: PluginBundleEntry
  plugins: PluginCatalogEntry[]
}

export interface InstalledPluginRecord {
  name: string
  version: string
  installedAt: string
  sha256: string
  /** Skill dir names this plugin dropped into `$HOME/.agents/skills/`. */
  skills: string[]
}

export type PluginFetchCatalogResult =
  | { ok: true; catalog: PluginCatalog }
  | { ok: false; error: string }

export type PluginInstallResult =
  | { ok: true; record: InstalledPluginRecord }
  | { ok: false; error: string }

export type PluginUninstallResult = { ok: true } | { ok: false; error: string }

export type PluginListInstalledResult =
  | { ok: true; installed: InstalledPluginRecord[] }
  | { ok: false; error: string }
