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
