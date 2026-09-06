/**
 * Worktree-scoped graphify git hooks: `pnpm graph:hooks [--uninstall|--status]`.
 *
 * Plain `graphify hook install` is the wrong tool for this repo, for two reasons:
 *
 *   1. Our checkouts are usually *linked worktrees* (17 of them share
 *      temp-ai-image-master-source/.git). git hooks default to the shared
 *      `.git/hooks`, so a hook installed from here fires on every commit in every
 *      worktree — and graphify's own hook script contains a guard that `exit 0`s
 *      inside linked worktrees (upstream #1806/#1809), so it would never run
 *      *here*, only in the primary checkout, which has no graph at all.
 *   2. It appends `graphify-out/graph.json merge=graphify` to the tracked
 *      `.gitattributes`. graph.json is git-ignored in this repo (see .gitignore),
 *      so the merge driver is dead weight and the diff is noise.
 *
 * What this does instead — everything stays local to this worktree, no tracked
 * file changes:
 *
 *   - `git config extensions.worktreeConfig true` (once; enables per-worktree
 *     config) and `git config --worktree core.hooksPath <git-dir>/hooks`, which
 *     points THIS worktree at its private hooks directory
 *     (`.git/worktrees/<name>/hooks`, or plain `.git/hooks` on the primary).
 *   - runs `graphify hook install` so we keep upstream's hardened script:
 *     detached rebuild (no blocking commit), pinned interpreter path (works from
 *     GUI git clients without PATH), rebase/merge skip, GRAPHIFY_SKIP_HOOK=1
 *     opt-out, sequential workers on Windows.
 *   - patches the two hooks: strips the linked-worktree guard (the whole point
 *     is to run inside a worktree) and adds `graphify-out/ must exist`, so a
 *     `git clean` never triggers a cold full build from a hook.
 *   - restores `.gitattributes` and drops the merge-driver config keys.
 *
 * Re-run after `uv tool upgrade graphifyy` to refresh the pinned interpreter.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_NAMES = ['post-commit', 'post-checkout']
const MERGE_DRIVER_KEYS = ['merge.graphify.name', 'merge.graphify.driver']

// Exact block graphify emits (hooks.py `_WORKTREE_GUARD`), matched loosely on
// whitespace so a reformat upstream still hits. If it ever disappears we warn
// instead of failing: a hook without the guard is what we want anyway.
const WORKTREE_GUARD = new RegExp(
  String.raw`_GFY_GITDIR=\$\(cd "\$\(git rev-parse --git-dir[^\n]*\n` +
    String.raw`_GFY_COMMONDIR=\$\(cd "\$\(git rev-parse --git-common-dir[^\n]*\n` +
    String.raw`if \[ -n "\$_GFY_COMMONDIR" \] && \[ "\$_GFY_GITDIR" != "\$_GFY_COMMONDIR" \]; then\n` +
    String.raw`\s*exit 0\n` +
    String.raw`fi\n`,
)

const GUARD_REPLACEMENT = [
  '# Linked-worktree guard removed by scripts/graphify-hooks.mjs: these hooks are',
  '# worktree-scoped via core.hooksPath, so running inside a worktree is the point.',
  '# Only rebuild when a graph exists (never cold-build from a hook after `git clean`).',
  '[ -d "graphify-out" ] || exit 0',
  '',
].join('\n')

function run(cmd, args, { allowFail = false, cwd = repoRoot } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(res.error.message) }
    throw new Error(`${cmd} ${args.join(' ')}: ${res.error.message}`)
  }
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${res.stderr}`)
  }
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

function git(args, opts) {
  return run('git', args, opts)
}

function posix(p) {
  return p.replaceAll('\\', '/')
}

function requireGraphify() {
  const probe = run('graphify', ['--version'], { allowFail: true })
  if (!probe.ok) {
    throw new Error(
      'graphify CLI not found on PATH. Install once per machine:\n' +
        '  uv tool install --python 3.13 "graphifyy[sql]"\n' +
        '(pinned to 3.13: networkx breaks on CPython 3.14.1). See AGENTS.md → Knowledge graph bootstrap.',
    )
  }
  return probe.stdout
}

function worktreeHooksDir() {
  const gitDir = git(['rev-parse', '--absolute-git-dir']).stdout
  return posix(path.join(gitDir, 'hooks'))
}

function enableWorktreeHooksPath() {
  const coreWorktree = git(['config', '--get', 'core.worktree'], { allowFail: true })
  if (coreWorktree.ok && coreWorktree.stdout) {
    throw new Error(
      `core.worktree is set (${coreWorktree.stdout}); enabling extensions.worktreeConfig would ` +
        'require moving it to config.worktree first. Refusing to change repository config.',
    )
  }
  git(['config', 'extensions.worktreeConfig', 'true'])
  const hooksDir = worktreeHooksDir()
  git(['config', '--worktree', 'core.hooksPath', hooksDir])
  return hooksDir
}

function patchHook(hooksDir, name) {
  const file = path.join(hooksDir, name)
  if (!existsSync(file)) return `${name}: not found in ${hooksDir}`
  const original = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  if (original.includes(GUARD_REPLACEMENT.split('\n')[0])) return `${name}: already patched`
  if (!WORKTREE_GUARD.test(original)) {
    return `${name}: worktree guard not found (graphify changed its script?) — left as installed`
  }
  writeFileSync(file, original.replace(WORKTREE_GUARD, GUARD_REPLACEMENT), 'utf8')
  return `${name}: worktree guard stripped, graphify-out/ guard added`
}

function withGitattributesPreserved(fn) {
  const attrs = path.join(repoRoot, '.gitattributes')
  const before = existsSync(attrs) ? readFileSync(attrs) : null
  try {
    return fn()
  } finally {
    const after = existsSync(attrs) ? readFileSync(attrs) : null
    const changed = before === null ? after !== null : after === null || !before.equals(after)
    if (changed) {
      if (before === null) rmSync(attrs, { force: true })
      else writeFileSync(attrs, before)
      console.log('.gitattributes: restored (merge driver line not wanted — graph.json is git-ignored)')
    }
  }
}

function dropMergeDriverConfig() {
  for (const key of MERGE_DRIVER_KEYS) git(['config', '--unset-all', key], { allowFail: true })
}

function install() {
  console.log(`graphify ${requireGraphify()}`)
  const hooksDir = enableWorktreeHooksPath()
  console.log(`core.hooksPath (worktree) = ${hooksDir}`)

  const result = withGitattributesPreserved(() => run('graphify', ['hook', 'install']))
  console.log(result.stdout)
  dropMergeDriverConfig()

  for (const name of HOOK_NAMES) console.log(patchHook(hooksDir, name))
  console.log('\nDone. Commits and branch switches in THIS worktree now refresh graphify-out/ in the background')
  console.log('(log: ~/.cache/graphify-rebuild.log). Skip once with GRAPHIFY_SKIP_HOOK=1.')
}

function uninstall() {
  const hooksPath = git(['config', '--worktree', '--get', 'core.hooksPath'], { allowFail: true })
  if (hooksPath.ok && hooksPath.stdout) {
    const result = withGitattributesPreserved(() => run('graphify', ['hook', 'uninstall'], { allowFail: true }))
    console.log(result.stdout || result.stderr)
    git(['config', '--worktree', '--unset', 'core.hooksPath'], { allowFail: true })
    console.log('core.hooksPath (worktree): unset')
  } else {
    console.log('no worktree-scoped core.hooksPath set — nothing to uninstall')
  }
  dropMergeDriverConfig()
}

function status() {
  const hooksPath = git(['config', '--worktree', '--get', 'core.hooksPath'], { allowFail: true })
  console.log(`core.hooksPath (worktree) = ${hooksPath.stdout || '(not set)'}`)
  const result = run('graphify', ['hook', 'status'], { allowFail: true })
  console.log(result.stdout || result.stderr)
  if (hooksPath.stdout) {
    for (const name of HOOK_NAMES) {
      const file = path.join(hooksPath.stdout, name)
      const patched = existsSync(file) && readFileSync(file, 'utf8').includes('Linked-worktree guard removed')
      console.log(`${name}: ${existsSync(file) ? (patched ? 'patched for worktree' : 'UNPATCHED (run pnpm graph:hooks)') : 'missing'}`)
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    if (process.argv.includes('--uninstall')) uninstall()
    else if (process.argv.includes('--status')) status()
    else install()
  } catch (err) {
    console.error(`[graphify-hooks] ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
