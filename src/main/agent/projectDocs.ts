import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Multi-repo AGENTS.md support (native path A: `developer_instructions`).
 *
 * Codex's engine only auto-loads project docs (`AGENTS.md` and configured
 * fallbacks) by walking from the `.git` project root DOWN to the single thread
 * `cwd` (codex-rs/core/src/agents_md.rs). When the user picks several INDEPENDENT
 * workspace folders, only the primary (`cwd`) repo's `AGENTS.md` is loaded; the
 * other repos' constitutions are invisible.
 *
 * The clean, non-experimental native channel to feed those EXTRA repos' docs is
 * the `developer_instructions` config field (codex-rs/config/src/config_toml.rs
 * → "Developer instructions inserted as a `developer` role message"). We read
 * each extra root's project-doc here and aggregate them into one developer
 * message, passed per-thread via `thread/start`'s `config` override so switching
 * the selected folders at runtime takes effect on the next turn.
 *
 * We deliberately do NOT touch the sandbox/permission model — the experimental
 * multi-`environments` protocol (native path B) remains a future opt-in.
 */

/**
 * Per-file byte budget for an extra root's project-doc, mirroring the launch
 * `project_doc_max_bytes=65536` we pin for the primary cwd so a large extra
 * constitution isn't silently truncated to the stock ~32 KiB.
 */
export const EXTRA_ROOT_DOC_MAX_BYTES = 65_536

/**
 * Candidate project-doc filenames per extra root, in priority order — the FIRST
 * that exists wins (mirrors the engine: `AGENTS.override.md` beats `AGENTS.md`,
 * then the cross-tool `CLAUDE.md` / `GEMINI.md` fallbacks we also register via
 * `project_doc_fallback_filenames`).
 */
export const PROJECT_DOC_CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
] as const

function normalizeDir(p: string): string {
  // Resolve + strip trailing separators so prefix checks are reliable
  // cross-platform (Windows paths are compared case-insensitively).
  return path.resolve(p)
}

/**
 * True when `candidate` is the same directory as, or an ancestor of, `child`.
 * Used to skip extra roots the engine already covers via its root→cwd walk
 * (ancestors of cwd within the same project), preventing duplicate injection.
 */
function isSameOrAncestor(candidate: string, child: string): boolean {
  const a = normalizeDir(candidate)
  const c = normalizeDir(child)
  const aCmp = process.platform === 'win32' ? a.toLowerCase() : a
  const cCmp = process.platform === 'win32' ? c.toLowerCase() : c
  if (aCmp === cCmp) return true
  const withSep = aCmp.endsWith(path.sep) ? aCmp : aCmp + path.sep
  return cCmp.startsWith(withSep)
}

function readDocFromRoot(root: string): { file: string; content: string } | undefined {
  let dir: string
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return undefined
    dir = normalizeDir(root)
  } catch {
    return undefined
  }
  for (const name of PROJECT_DOC_CANDIDATES) {
    const file = path.join(dir, name)
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue
      let content = readFileSync(file, 'utf8')
      if (Buffer.byteLength(content, 'utf8') > EXTRA_ROOT_DOC_MAX_BYTES) {
        // Truncate on a UTF-8 boundary to the budget, then flag it.
        content =
          Buffer.from(content, 'utf8').subarray(0, EXTRA_ROOT_DOC_MAX_BYTES).toString('utf8') +
          '\n\n[…truncated to project_doc_max_bytes…]'
      }
      const trimmed = content.trim()
      if (!trimmed) continue
      return { file: name, content: trimmed }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Build the aggregated `developer_instructions` string for every EXTRA workspace
 * root (all `writableRoots` except the primary `cwd` and any ancestor of it the
 * engine already loads). Returns `undefined` when there is nothing extra to
 * inject, so callers can omit the field entirely.
 *
 * @param cwd            The primary thread cwd (its own AGENTS.md is auto-loaded).
 * @param writableRoots  All selected workspace roots (writableRoots[0] is cwd).
 */
export function buildExtraRootsDeveloperInstructions(
  cwd: string | undefined,
  writableRoots: readonly string[] | undefined,
): string | undefined {
  if (!writableRoots || writableRoots.length === 0) return undefined

  const primary = cwd ? normalizeDir(cwd) : undefined
  const seen = new Set<string>()
  const sections: string[] = []

  for (const root of writableRoots) {
    if (!root) continue
    const norm = normalizeDir(root)
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm
    if (seen.has(key)) continue
    seen.add(key)
    // Skip the primary cwd and any ancestor of it — already loaded by the engine.
    if (primary && isSameOrAncestor(norm, primary)) continue

    const doc = readDocFromRoot(norm)
    if (!doc) continue
    sections.push(`## Repository: ${norm} (${doc.file})\n\n${doc.content}`)
  }

  if (sections.length === 0) return undefined

  return [
    'Additional workspace repositories are in scope for this session. Treat each',
    "block below as that repository's AGENTS.md — follow its instructions whenever",
    'you read, edit, or run anything under that repository path. The primary',
    "workspace's own AGENTS.md is already loaded separately.",
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n')
}
