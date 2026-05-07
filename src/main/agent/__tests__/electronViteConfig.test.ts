// Regression guard for the bug where rolldown inlined `@electric-sql/pglite`
// into the main bundle, which made PGlite look up its sibling
// `pglite.data` / `pglite.wasm` files inside `dist/main/` (where they were
// never copied), throwing ENOENT and crashing `AgentRuntime.init()`. The
// crash was silent because init's catch-all logged the error but the
// promise was unawaited — the only user-visible symptom was the renderer
// reporting "No handler registered for 'agent:send-message'".
//
// We keep the fix as a config-layer assertion rather than a build-and-run
// integration test because the latter would need a full electron-vite build
// + electron spawn, which is expensive and brittle in CI.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONFIG_PATH = resolve(__dirname, '../../../../electron.vite.config.ts')

describe('electron.vite.config.ts main external list', () => {
  const source = readFileSync(CONFIG_PATH, 'utf8')

  it('keeps @electric-sql/pglite externalized so binary siblings resolve', () => {
    expect(source).toMatch(/['"]@electric-sql\/pglite['"]/)
  })

  it('keeps @electric-sql/pglite-socket externalized for the same reason', () => {
    expect(source).toMatch(/['"]@electric-sql\/pglite-socket['"]/)
  })
})
