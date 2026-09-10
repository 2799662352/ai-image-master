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
