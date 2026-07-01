/**
 * Pure, unit-testable helpers for the one-command marketplace publisher
 * (`scripts/publish-marketplace.mjs`).
 *
 * Design: `marketplace.json` is the SINGLE source of truth for plugin versions.
 * The three per-plugin manifests (`.claude-plugin` / `.cursor-plugin` /
 * `.codex-plugin`) are ALWAYS auto-aligned to it, so 4-place version drift is
 * structurally impossible. A committed publish-state file records each plugin's
 * version-independent content signature + last published version, so the
 * publisher can AUTO patch-bump a plugin whose content changed without the
 * author remembering to bump anything.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const MANIFEST_DIRS = ['.claude-plugin', '.cursor-plugin', '.codex-plugin']

const MANIFEST_RE = /(^|\/)\.(claude|cursor|codex)-plugin\/plugin\.json$/

/** Increment the patch component of a semver-ish string. */
export function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''))
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** Drop the `version` field so signatures are version-independent. */
export function stripVersion(jsonText) {
  try {
    const o = JSON.parse(jsonText)
    delete o.version
    return JSON.stringify(o)
  } catch {
    return jsonText
  }
}

async function walkFiles(rootDir) {
  const out = []
  async function recurse(cur, rel) {
    const entries = await fs.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === '.git') continue
      const abs = path.join(cur, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await recurse(abs, r)
      else if (e.isFile()) out.push({ abs, rel: r })
    }
  }
  await recurse(rootDir, '')
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/**
 * Content signature of a plugin directory, EXCLUDING the `version` field of the
 * three plugin manifests. Bumping/aligning a version therefore never perturbs
 * the signature — only real content edits do.
 */
export async function pluginContentSignature(pluginDir) {
  const files = await walkFiles(pluginDir)
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f.rel)
    h.update('\0')
    if (MANIFEST_RE.test(f.rel)) {
      h.update(stripVersion(await fs.readFile(f.abs, 'utf8')))
    } else {
      h.update(await fs.readFile(f.abs))
    }
    h.update('\0')
  }
  return h.digest('hex')
}

/**
 * Decide the published version for one plugin.
 *
 * @param {{name:string,version:string}} plugin  entry from marketplace.json
 * @param {string} sig                           current content signature
 * @param {{sig:string,version:string}|undefined} prevEntry  last published state
 * @returns {{name:string,action:'seed'|'unchanged'|'manual'|'auto-bump',version:string,sig:string,from:string}}
 */
export function decideVersion(plugin, sig, prevEntry) {
  const cur = plugin.version
  const base = { name: plugin.name, sig, from: cur }
  // No baseline recorded yet → trust the author's current version, just seed.
  if (!prevEntry) return { ...base, action: 'seed', version: cur }
  // Content unchanged → keep whatever version is declared.
  if (prevEntry.sig === sig) return { ...base, action: 'unchanged', version: cur }
  // Content changed AND author already bumped manually → respect it (no double bump).
  if (prevEntry.version !== cur) return { ...base, action: 'manual', version: cur }
  // Content changed and author forgot to bump → auto patch-bump.
  return { ...base, action: 'auto-bump', version: bumpPatch(cur) }
}

/** Build the new publish-state map from the per-plugin decisions. */
export function nextStateFromDecisions(decisions) {
  const state = {}
  for (const d of decisions) state[d.name] = { sig: d.sig, version: d.version }
  return state
}
