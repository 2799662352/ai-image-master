/**
 * tldraw license key for the embedded canvas.
 *
 * Why this exists: tldraw ≥ 5.3.2 (#10021) no longer treats a native app served
 * from a custom protocol as a development environment. The packaged renderer
 * loads from `file://` with `NODE_ENV=production`, so `LicenseManager.
 * getIsDevelopment()` compiles to `protocol === "http:" || (https && loopback)
 * || false` → the canvas runs as *unlicensed production*: tldraw logs
 * "No tldraw license key provided!" and `LicenseProvider` **unmounts the editor
 * after 5 s**. Measured in a real Electron 43 BrowserWindow (file:// page,
 * NODE_ENV=production bundle): `licenseState = unlicensed-production`,
 * `editorStillMounted = false` after 6 s. `pnpm dev` (http://localhost) is
 * still development, so this is invisible until the installer is run.
 *
 * The key ships in the bundle via `VITE_TLDRAW_LICENSE_KEY` (Vite statically
 * inlines `import.meta.env.VITE_*`). tldraw keys are verified client-side and
 * are safe to be public (https://tldraw.dev/sdk-features/license-key), so the
 * variable may live in a committed `.env.production` or a CI variable. For an
 * Electron app ask tldraw for a *native* license: its hosts are matched as a
 * regex against `window.location.href` (`file:///…`) instead of a hostname.
 */
export function resolveTldrawLicenseKey(
  raw: string | undefined = import.meta.env.VITE_TLDRAW_LICENSE_KEY,
): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Copy/paste from an email tends to carry zero-width chars and line breaks.
  const key = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r?\n|\r/g, '').trim()
  return key.length > 0 ? key : undefined
}

/** Bit flags tldraw encodes in a key (mirrors `LicenseManager` FLAGS). */
export const TLDRAW_LICENSE_FLAGS = {
  ANNUAL_LICENSE: 1,
  PERPETUAL_LICENSE: 1 << 1,
  INTERNAL_LICENSE: 1 << 2,
  WITH_WATERMARK: 1 << 3,
  EVALUATION_LICENSE: 1 << 4,
  NATIVE_LICENSE: 1 << 5,
  FEAT_COLLABORATION: 1 << 6,
  FEAT_COMMENTING: 1 << 7,
} as const

export interface TldrawLicenseInfo {
  id: string
  hosts: string[]
  flags: number
  /** ISO date (`YYYY-MM-DD`) tldraw stops honouring the key. */
  expiryDate: string
  isEvaluation: boolean
  hasWatermark: boolean
}

/**
 * Decode the public payload of a tldraw key without verifying its signature.
 * Shape: `tldraw-<date>/<base64url JSON [id, hosts, flags, expiryDate]>.<sig>`.
 * Only the info tldraw itself prints to the console is read; this exists so a
 * CI test can turn red *before* the key expires (an evaluation key has no
 * grace period — the packaged canvas would vanish the same day).
 */
export function decodeTldrawLicenseKey(key: string): TldrawLicenseInfo | null {
  const slash = key.indexOf('/')
  if (slash < 0) return null
  const payload = key.slice(slash + 1).split('.')[0]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length < 4) return null
    const [id, hosts, flags, expiryDate] = parsed
    if (typeof id !== 'string' || !Array.isArray(hosts) || typeof flags !== 'number' || typeof expiryDate !== 'string') {
      return null
    }
    return {
      id,
      hosts: hosts.map(String),
      flags,
      expiryDate,
      isEvaluation: (flags & TLDRAW_LICENSE_FLAGS.EVALUATION_LICENSE) !== 0,
      hasWatermark: (flags & TLDRAW_LICENSE_FLAGS.WITH_WATERMARK) !== 0,
    }
  } catch {
    return null
  }
}
