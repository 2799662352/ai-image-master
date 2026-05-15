#!/usr/bin/env node
/**
 * Standalone bundler for the PGlite utilityProcess worker.
 *
 * Why this exists: electron-vite's main process build splits shared deps
 * between entries, so adding `pgliteWorker.ts` as a second `rollupOptions.input`
 * makes the resulting `dist/main/pgliteWorker.js` start with
 * `require('./index.js')`. That re-executes the entire main process (electron
 * app init, IPC handlers, etc.) inside the utilityProcess, defeating the
 * whole isolation goal.
 *
 * Solution: compile the worker as a fully independent esbuild bundle, with
 * `electron` and PGlite packages externalised so they resolve at runtime
 * against the same node_modules tree the main process uses.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(root, 'src/main/agent/pgliteWorker.ts')],
  outfile: path.join(root, 'dist/main/pgliteWorker.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: process.env.NODE_ENV === 'production',
  external: [
    'electron',
    '@electric-sql/pglite',
    '@electric-sql/pglite-socket',
  ],
  // The worker uses `process.parentPort` from Electron's utilityProcess —
  // no other Electron imports, so we keep the surface minimal.
  legalComments: 'none',
  logLevel: 'info',
})
