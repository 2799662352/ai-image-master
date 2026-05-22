# PR-1: apiyi-mcp-server Vendor + Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor `apiyi-mcp-server` (https://github.com/2799662352/apiyi-mcp-server) into `resources/apiyi-mcp/`, ship it inside the installer, and write a `mcp_servers.apiyi` entry with `enabled: false` to the user's personal codex config on first launch. **No UI changes in this PR** — old users see nothing different; the entry stays disabled until PR-2 wires the settings field that flips it to `true`.

**Architecture:**
1. A vendor script (`scripts/vendor-apiyi-mcp.mjs`) shallow-clones the upstream repo, runs `npm ci --production`, and copies `dist/` + `package.json` + `node_modules/` into `resources/apiyi-mcp/`. Pinned via `scripts/vendor-apiyi-mcp.lock.json`.
2. A new pure module `src/main/agent/apiyiMcpLauncher.ts` exports `getApiyiMcpEntryPath()` (uses existing `getCodexResourceRoot` from `paths.ts`) and `buildApiyiMcpConfigEntry({ enabled })`.
3. A new helper `seedApiyiMcpEntry()` in a new file `src/main/agent/apiyiMcpSeed.ts` is called once per app boot from `main/index.ts`: read personal `config.toml`, ensure `mcp_servers.apiyi` exists with `enabled: false`, write atomically. Idempotent — never overwrites a user's manual edits.
4. `electron-builder.yml` `extraResources` gains an entry that copies `resources/apiyi-mcp/**` into the packaged app at the same relative path.

**Tech Stack:** Node.js (vendor script), TypeScript (main process), `@iarna/toml` (already a dep, used by `codexConfigMerge.ts`), Vitest, electron-builder.

**Spec:** `docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md` (Task A section).

---

## Pre-flight

- [ ] **Step 0: Confirm branch and commit base**

```bash
git branch --show-current
# Expected: feature/apiyi-mcp-integration

git log --oneline -3
# Expected (most recent first):
#   <new hash> docs(specs,plans): apiyi-mcp-server integration design + PR-1 plan
#   <hash> chore(release): v4.3.15 ...
#   ...
```

If branch is wrong, run:
```bash
git checkout -b feature/apiyi-mcp-integration origin/main
```

- [ ] **Step 0.1: Verify required runtime deps already present**

```bash
node -e "console.log(require('./package.json').dependencies['@iarna/toml'])"
# Expected: a non-empty version string (e.g. "^2.2.5")

node -e "console.log(require('./package.json').dependencies['toml'])"
# Expected: a non-empty version string

ls scripts/ 2>/dev/null && echo "OK"
# Expected: directory exists with existing release scripts
```

---

## Task 1: Vendor script + lockfile

**Files:**
- Create: `scripts/vendor-apiyi-mcp.lock.json`
- Create: `scripts/vendor-apiyi-mcp.mjs`
- Modify: `package.json` (add `vendor:apiyi-mcp` script + wire into `prebuild`)
- Modify: `.gitignore` (ignore vendored output dir but keep scripts tracked)

**Background:** We pin the upstream by commit SHA, not by tag, because upstream may force-push tags. The lockfile is a stable manifest of "what version we vendor". The vendor script is idempotent — second run with same SHA is a no-op (checks `version.json` in output).

- [ ] **Step 1: Create `scripts/vendor-apiyi-mcp.lock.json`**

Create file with exact contents:

```json
{
  "$schema": "./vendor-apiyi-mcp.lock.schema.json",
  "repo": "https://github.com/2799662352/apiyi-mcp-server.git",
  "commit": "REPLACE_WITH_RESOLVED_SHA_AT_VENDOR_TIME",
  "ref": "main",
  "notes": "Resolved at vendor time via `git ls-remote origin main`. Update by re-running `pnpm vendor:apiyi-mcp --update-ref`."
}
```

We deliberately leave `commit` as a placeholder string — the vendor script's first run resolves `ref` to a SHA and writes it back. CI uses the committed SHA after the initial resolve; local dev runs `--update-ref` to refresh.

- [ ] **Step 2: Create `scripts/vendor-apiyi-mcp.mjs`**

Create file:

```js
#!/usr/bin/env node
/**
 * Vendor apiyi-mcp-server into resources/apiyi-mcp/.
 *
 * Idempotent: if resources/apiyi-mcp/version.json shows the locked commit
 * already vendored AND --update-ref is NOT passed, exits with code 0 silently.
 *
 * Usage:
 *   node scripts/vendor-apiyi-mcp.mjs           # vendor at locked commit
 *   node scripts/vendor-apiyi-mcp.mjs --update-ref  # resolve ref to new SHA and update lock
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const LOCK_PATH = path.join(__dirname, 'vendor-apiyi-mcp.lock.json')
const VENDOR_DIR = path.join(REPO_ROOT, 'resources', 'apiyi-mcp')
const VERSION_FILE = path.join(VENDOR_DIR, 'version.json')

const UPDATE_REF = process.argv.includes('--update-ref')

function readLock() {
  if (!existsSync(LOCK_PATH)) {
    throw new Error(`Lockfile missing: ${LOCK_PATH}`)
  }
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
}

function writeLock(lock) {
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

function resolveRefToSha(repo, ref) {
  const res = spawnSync('git', ['ls-remote', repo, ref], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ls-remote failed: ${res.stderr}`)
  }
  const line = res.stdout.trim().split('\n')[0]
  if (!line) throw new Error(`ref ${ref} not found in ${repo}`)
  const sha = line.split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`bad SHA: ${sha}`)
  return sha
}

function alreadyVendoredAt(sha) {
  if (!existsSync(VERSION_FILE)) return false
  try {
    const v = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    return v.commit === sha
  } catch {
    return false
  }
}

function hashDir(dir) {
  // Best-effort tamper detection: hash the manifest file
  const pkg = path.join(dir, 'package.json')
  if (!existsSync(pkg)) return null
  return createHash('sha256').update(readFileSync(pkg)).digest('hex').slice(0, 16)
}

function sh(cmd, opts) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function main() {
  let lock = readLock()

  if (UPDATE_REF) {
    const sha = resolveRefToSha(lock.repo, lock.ref)
    if (sha !== lock.commit) {
      lock = { ...lock, commit: sha }
      writeLock(lock)
      console.log(`[vendor-apiyi-mcp] updated lock to commit ${sha}`)
    } else {
      console.log(`[vendor-apiyi-mcp] lock already at ${sha}`)
    }
  }

  if (lock.commit === 'REPLACE_WITH_RESOLVED_SHA_AT_VENDOR_TIME') {
    const sha = resolveRefToSha(lock.repo, lock.ref)
    lock = { ...lock, commit: sha }
    writeLock(lock)
    console.log(`[vendor-apiyi-mcp] initial resolve to ${sha}`)
  }

  if (alreadyVendoredAt(lock.commit)) {
    console.log(`[vendor-apiyi-mcp] already vendored at ${lock.commit} (no-op)`)
    return
  }

  const tmpDir = path.join(REPO_ROOT, 'node_modules', '.apiyi-mcp-vendor-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  console.log(`[vendor-apiyi-mcp] cloning ${lock.repo} @ ${lock.commit} ...`)
  sh(`git clone --depth=1 "${lock.repo}" "${tmpDir}"`)
  sh(`git -C "${tmpDir}" fetch --depth=1 origin ${lock.commit}`)
  sh(`git -C "${tmpDir}" checkout ${lock.commit}`)

  console.log(`[vendor-apiyi-mcp] installing production deps ...`)
  sh(`npm ci --omit=dev --no-audit --no-fund --ignore-scripts`, { cwd: tmpDir })

  // Build if upstream requires it. The upstream README says ts → dist via
  // `npm run build`. Run it; if no build script exists, ignore.
  const upstreamPkg = JSON.parse(readFileSync(path.join(tmpDir, 'package.json'), 'utf8'))
  if (upstreamPkg.scripts && upstreamPkg.scripts.build) {
    sh(`npm run build`, { cwd: tmpDir })
  }

  // Copy artifacts.
  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  for (const entry of ['dist', 'node_modules', 'package.json', 'README.md', 'LICENSE']) {
    const src = path.join(tmpDir, entry)
    const dst = path.join(VENDOR_DIR, entry)
    if (!existsSync(src)) {
      if (entry === 'dist') {
        throw new Error(`upstream missing dist/ after build — abort`)
      }
      continue
    }
    sh(`${process.platform === 'win32' ? 'xcopy /E /I /Y' : 'cp -R'} "${src}" "${dst}"`)
  }

  const manifest = {
    commit: lock.commit,
    repo: lock.repo,
    vendoredAt: new Date().toISOString(),
    nodeVersion: process.version,
    pkgHash: hashDir(VENDOR_DIR),
  }
  writeFileSync(VERSION_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  rmSync(tmpDir, { recursive: true, force: true })
  console.log(`[vendor-apiyi-mcp] vendored at ${VENDOR_DIR}`)
}

try {
  main()
} catch (err) {
  console.error(`[vendor-apiyi-mcp] FAILED: ${err.message}`)
  process.exit(1)
}
```

- [ ] **Step 3: Add `package.json` scripts + wire into prebuild**

Open `package.json`. Locate the `"scripts"` section. Add **two** new entries (keep all existing scripts intact). After locating `"build": "..."`:

```json
"scripts": {
  "vendor:apiyi-mcp": "node scripts/vendor-apiyi-mcp.mjs",
  "vendor:apiyi-mcp:update": "node scripts/vendor-apiyi-mcp.mjs --update-ref",
  ...existing scripts unchanged...
}
```

Then locate the existing `build` script (it typically looks like `"build": "npm run typecheck && electron-vite build"` or similar — preserve the existing command exactly). Prepend `npm run vendor:apiyi-mcp && ` to it. For example, if current `build` is:

```json
"build": "npm run typecheck && electron-vite build"
```

Change to:

```json
"build": "npm run vendor:apiyi-mcp && npm run typecheck && electron-vite build"
```

The release scripts (`release:cn`, etc.) typically call `build` internally, so they pick this up transitively. Do NOT add it to `dev` (would be slow + unnecessary in dev — `getCodexResourceRoot` falls back to `resources/` in unpackaged mode).

- [ ] **Step 4: Update `.gitignore`**

Open `.gitignore`. Add at the bottom (in a clearly labeled section):

```gitignore
# Vendored apiyi-mcp-server artifacts — produced by scripts/vendor-apiyi-mcp.mjs.
# The lockfile (scripts/vendor-apiyi-mcp.lock.json) IS tracked; the build
# output is not.
/resources/apiyi-mcp/
```

- [ ] **Step 5: Smoke-run the vendor script locally**

```bash
node scripts/vendor-apiyi-mcp.mjs
```

Expected outcome (first run):
- Resolves `ref:main` → some 40-char SHA, writes it back into `scripts/vendor-apiyi-mcp.lock.json` (you should see the file changed in `git status`).
- Clones into `node_modules/.apiyi-mcp-vendor-tmp/`, runs `npm ci`, runs `npm run build` (if present).
- Copies into `resources/apiyi-mcp/dist/`, `resources/apiyi-mcp/node_modules/`, `resources/apiyi-mcp/package.json`, plus `version.json`.
- Final line: `[vendor-apiyi-mcp] vendored at <path>/resources/apiyi-mcp`.

Verify:
```bash
ls resources/apiyi-mcp/
# Expected: dist  node_modules  package.json  README.md (or LICENSE)  version.json

cat resources/apiyi-mcp/version.json
# Expected: { commit: "...", repo: "...", vendoredAt: "...", ... }

node -e "require('./resources/apiyi-mcp/dist/index.js')"
# Expected: either prints help/usage OR errors with 'APIYI_API_KEY required' — both are signs the entry resolves
```

Second run (idempotency check):
```bash
node scripts/vendor-apiyi-mcp.mjs
# Expected: "[vendor-apiyi-mcp] already vendored at <sha> (no-op)" — completes in < 1 sec
```

- [ ] **Step 6: Commit**

```bash
git add scripts/vendor-apiyi-mcp.lock.json scripts/vendor-apiyi-mcp.mjs package.json .gitignore
git commit -m "build(apiyi-mcp): vendor script + lockfile

- scripts/vendor-apiyi-mcp.mjs clones upstream at pinned SHA, runs npm ci --omit=dev,
  copies dist + node_modules + package.json into resources/apiyi-mcp/.
- Idempotent via version.json check.
- scripts/vendor-apiyi-mcp.lock.json pins the upstream commit; refresh via
  \`pnpm vendor:apiyi-mcp:update\`.
- package.json: 'build' now depends on 'vendor:apiyi-mcp' so release flow auto-vendors.
- .gitignore: /resources/apiyi-mcp/ (lockfile tracked, artifacts not).

Spec: docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md (Task A)"
```

---

## Task 2: electron-builder `extraResources`

**Files:**
- Modify: `electron-builder.yml` (add one block to `extraResources`)

**Background:** The existing `extraResources` block already ships `resources/codex/${platform}-${arch}/codex.exe` into the installer at `<resourcesPath>/codex/...`. We piggyback on the same mechanism for apiyi-mcp. Difference: apiyi-mcp is pure JS, so no per-platform subdir — single tree copied to `apiyi-mcp/`.

- [ ] **Step 1: Add `extraResources` entry**

Open `electron-builder.yml`. Locate the `extraResources:` section (around line 34). Find the existing entries for `resources/codex/...` and `resources/docker-mcp/...`. **Immediately after the `docker-mcp` entry** (around line 46), add:

```yaml
  # Vendored apiyi-mcp-server (resolves to <resourcesPath>/apiyi-mcp/dist/index.js
  # at runtime via src/main/agent/apiyiMcpLauncher.ts). Pure Node, no per-platform
  # subdir. Vendored by scripts/vendor-apiyi-mcp.mjs as part of `npm run build`.
  - from: resources/apiyi-mcp
    to: apiyi-mcp
    filter:
      - "dist/**/*"
      - "node_modules/**/*"
      - "package.json"
      - "version.json"
      - "README.md"
      - "LICENSE"
```

Do not touch any other line in the file.

- [ ] **Step 2: Verify the YAML is still valid**

```bash
node -e "console.log(require('js-yaml').load(require('fs').readFileSync('electron-builder.yml','utf8')).extraResources.length)"
# Expected: a number ≥ 5 (was 4 before — system skills, codex, docker-mcp, resources/skills, .agents/skills; now +1)
```

(If `js-yaml` is not in node_modules, run `pnpm i -D js-yaml` first, then revert that install after — or skip and rely on the next step to catch errors.)

- [ ] **Step 3: Smoke-test that electron-builder still parses the file**

```bash
npx electron-builder --help > /dev/null
# Expected: prints electron-builder help (exit 0). If it complains about
# YAML, fix the indent — extraResources entries are 2-space indented.
```

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml
git commit -m "build(apiyi-mcp): ship vendored server in installer extraResources

Adds resources/apiyi-mcp/ → <resourcesPath>/apiyi-mcp/ in the packaged app,
filtered to dist/, node_modules/, package.json, version.json. Resolved at
runtime by getApiyiMcpEntryPath() (next commit).

Spec: docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md (Task A)"
```

---

## Task 3: `apiyiMcpLauncher` module + tests

**Files:**
- Create: `src/main/agent/apiyiMcpLauncher.ts`
- Create: `src/main/agent/__tests__/apiyiMcpLauncher.test.ts`

**Background — what `paths.ts` already gives us:**

```ts
// from src/main/agent/paths.ts (read-only reference, do not edit)
export function getCodexResourceRoot(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}): string {
  return options.isPackaged && options.resourcesPath
    ? options.resourcesPath
    : path.join(options.appPath, 'resources')
}
```

So in packaged mode this returns `<resourcesPath>`, in dev it returns `<appPath>/resources`. Either way, `resources/apiyi-mcp/dist/index.js` joins onto that root.

- [ ] **Step 1: Write failing tests for `getApiyiMcpEntryPath`**

Create `src/main/agent/__tests__/apiyiMcpLauncher.test.ts`:

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildApiyiMcpConfigEntry,
  getApiyiMcpEntryPath,
} from '../apiyiMcpLauncher'

describe('getApiyiMcpEntryPath', () => {
  it('returns <resourcesPath>/apiyi-mcp/dist/index.js when packaged', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/ignored/when/packaged',
      isPackaged: true,
      resourcesPath: '/Applications/CATIMATION.app/Contents/Resources',
    })
    expect(p).toBe(
      path.join(
        '/Applications/CATIMATION.app/Contents/Resources',
        'apiyi-mcp',
        'dist',
        'index.js',
      ),
    )
  })

  it('returns <appPath>/resources/apiyi-mcp/dist/index.js when unpackaged (dev)', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/repo/temp-ai-image-master-source',
      isPackaged: false,
    })
    expect(p).toBe(
      path.join(
        '/repo/temp-ai-image-master-source',
        'resources',
        'apiyi-mcp',
        'dist',
        'index.js',
      ),
    )
  })

  it('ignores resourcesPath when not packaged', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/dev/root',
      isPackaged: false,
      resourcesPath: '/should/be/ignored',
    })
    expect(p).toBe(
      path.join('/dev/root', 'resources', 'apiyi-mcp', 'dist', 'index.js'),
    )
  })
})

describe('buildApiyiMcpConfigEntry', () => {
  it('builds a disabled entry with command + args + empty env', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: false,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: false,
      env: {},
    })
  })

  it('builds an enabled entry with APIYI_API_KEY placeholder when enabled', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: true,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: true,
      env: { APIYI_API_KEY: '${APIYI_API_KEY}' },
    })
  })

  it('does not emit env.APIYI_API_KEY for the disabled form (avoid leaking placeholder)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: false,
    })
    expect(entry.env).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm exec vitest run src/main/agent/__tests__/apiyiMcpLauncher.test.ts --reporter=verbose
# Expected: Test file fails to load — "Cannot find module '../apiyiMcpLauncher'"
```

- [ ] **Step 3: Implement `apiyiMcpLauncher.ts`**

Create `src/main/agent/apiyiMcpLauncher.ts`:

```ts
import path from 'node:path'
import { getCodexResourceRoot } from './paths'

export interface ApiyiMcpPathOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}

/**
 * Resolve the absolute filesystem path to the vendored apiyi-mcp-server entry
 * (dist/index.js). Mirrors the layout produced by scripts/vendor-apiyi-mcp.mjs
 * and shipped via electron-builder.yml `extraResources`.
 *
 * Packaged: <resourcesPath>/apiyi-mcp/dist/index.js
 * Dev:      <appPath>/resources/apiyi-mcp/dist/index.js
 */
export function getApiyiMcpEntryPath(options: ApiyiMcpPathOptions): string {
  const root = getCodexResourceRoot(options)
  return path.join(root, 'apiyi-mcp', 'dist', 'index.js')
}

export interface ApiyiMcpConfigEntryInput {
  entryPath: string
  nodeBin: string
  enabled: boolean
}

/**
 * The TOML-serializable shape we write into `mcp_servers.apiyi`.
 *
 * `command` is the absolute path to a Node.js binary (we use Electron's own
 * `process.execPath` at runtime — Electron is built on Node so it can execute
 * a stdio MCP server fine, and we avoid forcing the user to install Node).
 *
 * `args[0]` is the absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; the settings IPC in PR-2 flips
 * it to `true` and re-writes the file. The codex CLI honors the `enabled`
 * field per `codexConfigMerge.ts:stripEnabledTrue`.
 *
 * `env.APIYI_API_KEY` is a *string placeholder* (`'${APIYI_API_KEY}'`) when
 * enabled — the real key is injected by the AgentManager at child-process spawn
 * time, NOT persisted into the TOML. This keeps the on-disk config clean of
 * secrets even though codex-providers.json stores the actual key.
 */
export interface ApiyiMcpConfigEntry {
  command: string
  args: string[]
  enabled: boolean
  env: Record<string, string>
}

export function buildApiyiMcpConfigEntry(
  input: ApiyiMcpConfigEntryInput,
): ApiyiMcpConfigEntry {
  return {
    command: input.nodeBin,
    args: [input.entryPath],
    enabled: input.enabled,
    env: input.enabled ? { APIYI_API_KEY: '${APIYI_API_KEY}' } : {},
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm exec vitest run src/main/agent/__tests__/apiyiMcpLauncher.test.ts --reporter=verbose
# Expected: 6 tests passed (3 path tests + 3 entry tests)
```

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/apiyiMcpLauncher.ts src/main/agent/__tests__/apiyiMcpLauncher.test.ts
git commit -m "feat(agent): apiyiMcpLauncher path resolver + config entry builder

Pure module exporting getApiyiMcpEntryPath() (mirrors paths.ts:getCodexResourceRoot
layout) and buildApiyiMcpConfigEntry({entryPath, nodeBin, enabled}) producing
the mcp_servers.apiyi TOML shape. No I/O; testable in isolation.

env.APIYI_API_KEY is emitted as the literal string placeholder \${APIYI_API_KEY}
when enabled — the real value is injected at spawn time, never written to disk
in mcp_servers config.

Spec: docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md (Task A)"
```

---

## Task 4: First-boot seeding via `apiyiMcpSeed`

**Files:**
- Create: `src/main/agent/apiyiMcpSeed.ts`
- Create: `src/main/agent/__tests__/apiyiMcpSeed.test.ts`
- Modify: `src/main/index.ts` (call seedApiyiMcpEntry once on app ready)

**Background:** `mcp_servers` lives in `~/.codex/config.toml` (personal scope, resolved by `resolveWorkspacePaths().personalConfigToml`). We need to:
1. Read existing TOML (may not exist → treat as empty).
2. Parse via `toml` (loose parser, already a dep used by `codexConfigMerge.ts`).
3. Ensure `mcp_servers.apiyi` exists with `enabled: false`. If already present (any value), do nothing — respect manual edits.
4. Re-serialize via `@iarna/toml` (strict writer, already used by `codexConfigMerge.ts`) and write atomically via `atomicWriteFile` (existing helper in `codexConfigStore.ts`).

- [ ] **Step 1: Write failing tests**

Create `src/main/agent/__tests__/apiyiMcpSeed.test.ts`:

```ts
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { seedApiyiMcpEntry } from '../apiyiMcpSeed'

let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apiyi-seed-'))
  configPath = path.join(tmpDir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const FAKE_ENTRY = '/Resources/apiyi-mcp/dist/index.js'
const FAKE_NODE = '/usr/local/bin/node'

describe('seedApiyiMcpEntry', () => {
  it('creates config.toml with disabled apiyi entry when file does not exist', async () => {
    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })

    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = parseToml(raw) as Record<string, unknown>
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers).toBeDefined()
    expect(servers.apiyi).toEqual({
      command: FAKE_NODE,
      args: [FAKE_ENTRY],
      enabled: false,
      env: {},
    })
  })

  it('preserves existing mcp_servers and other top-level keys', async () => {
    await fs.writeFile(
      configPath,
      [
        'some_top_level = "value"',
        '',
        '[mcp_servers.existing]',
        'command = "/bin/foo"',
        'args = ["x"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    )

    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(parsed.some_top_level).toBe('value')
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers.existing).toEqual({
      command: '/bin/foo',
      args: ['x'],
      enabled: true,
    })
    expect((servers.apiyi as { enabled: boolean }).enabled).toBe(false)
  })

  it('does NOT overwrite an existing mcp_servers.apiyi entry (idempotent)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/custom/node"',
        'args = ["/custom/path.js"]',
        'enabled = true',
        '',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "${APIYI_API_KEY}"',
        '',
      ].join('\n'),
      'utf8',
    )

    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string
      enabled: boolean
    }
    expect(apiyi.command).toBe('/custom/node')
    expect(apiyi.enabled).toBe(true)
  })

  it('returns the action taken: "seeded" | "skipped"', async () => {
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(first).toBe('seeded')

    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(second).toBe('skipped')
  })

  it('survives malformed existing TOML by treating it as empty (logs warning)', async () => {
    await fs.writeFile(configPath, 'this is not = valid [[toml', 'utf8')

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('seeded')
    // The post-seed file MUST parse — we recovered, not wiped silently.
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(
      (parsed.mcp_servers as Record<string, unknown>).apiyi,
    ).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm exec vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts --reporter=verbose
# Expected: "Cannot find module '../apiyiMcpSeed'"
```

- [ ] **Step 3: Implement `apiyiMcpSeed.ts`**

Create `src/main/agent/apiyiMcpSeed.ts`:

```ts
import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'
import { buildApiyiMcpConfigEntry } from './apiyiMcpLauncher'

export interface SeedApiyiMcpInput {
  personalConfigToml: string
  entryPath: string
  nodeBin: string
}

export type SeedAction = 'seeded' | 'skipped'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * First-boot seed: ensure `mcp_servers.apiyi` exists in the personal
 * codex config.toml with `enabled: false`. Never overwrites an existing
 * `mcp_servers.apiyi` entry — respects manual user edits.
 *
 * Returns 'seeded' when we wrote, 'skipped' when the entry already existed.
 *
 * Safe to call on every app boot; idempotent. Malformed existing TOML is
 * treated as empty (a console.warn is emitted, the disk file is overwritten
 * with a clean seeded version — this is preferable to silently failing).
 */
export async function seedApiyiMcpEntry(input: SeedApiyiMcpInput): Promise<SeedAction> {
  let rawDoc: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(input.personalConfigToml, 'utf8')
    if (raw.trim()) {
      try {
        rawDoc = parseToml(raw) as Record<string, unknown>
      } catch (err) {
        console.warn(
          `[apiyi-mcp-seed] existing TOML at ${input.personalConfigToml} is malformed; rewriting as seed-only.`,
          err,
        )
        rawDoc = {}
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // File doesn't exist yet — fine, we'll create it.
  }

  const existingServers = isPlainObject(rawDoc.mcp_servers) ? rawDoc.mcp_servers : {}
  if (isPlainObject(existingServers.apiyi)) {
    return 'skipped'
  }

  const seededEntry = buildApiyiMcpConfigEntry({
    entryPath: input.entryPath,
    nodeBin: input.nodeBin,
    enabled: false,
  })

  const nextServers = { ...existingServers, apiyi: seededEntry }
  const nextDoc = { ...rawDoc, mcp_servers: nextServers }

  const serialized = iarnaToml.stringify(nextDoc as iarnaToml.JsonMap)
  await atomicWriteFile(input.personalConfigToml, serialized)

  return 'seeded'
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm exec vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts --reporter=verbose
# Expected: 5 tests passed
```

- [ ] **Step 5: Wire into `src/main/index.ts`**

Open `src/main/index.ts`. Find the `app.whenReady().then(...)` block (or the equivalent boot sequence). After Codex paths are resolved but BEFORE `AgentManager` starts (so the first agent load already sees the entry), add the call.

If `src/main/index.ts` already imports things like `resolveWorkspacePaths` and `app`, the addition is small. Find a spot near other Codex bootstrap calls (e.g. existing `seedXxx`, or `resolveWorkspacePaths` usage), and insert:

```ts
// Above existing imports — add:
import { getApiyiMcpEntryPath } from './agent/apiyiMcpLauncher'
import { seedApiyiMcpEntry } from './agent/apiyiMcpSeed'
import { resolveWorkspacePaths } from './agent/codexConfigStore'
// (if resolveWorkspacePaths is already imported, do not duplicate)

// Inside app.whenReady().then(async () => { ... }) — near other agent setup:
try {
  const paths = resolveWorkspacePaths({
    home: app.getPath('home'),
    cwd: process.cwd(),
    userData: app.getPath('userData'),
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  })
  const entryPath = getApiyiMcpEntryPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  })
  const action = await seedApiyiMcpEntry({
    personalConfigToml: paths.personalConfigToml,
    entryPath,
    nodeBin: process.execPath,
  })
  console.log(`[apiyi-mcp] first-boot seed: ${action}`)
} catch (err) {
  // Seeding is best-effort — if it fails (e.g. home dir not writable),
  // log + continue. The MCP will simply not be available until the user
  // configures it manually or the next boot retries.
  console.warn('[apiyi-mcp] seed failed:', err)
}
```

**Important:** if `src/main/index.ts` already has a similar bootstrap section for other agent setup (e.g. docker-mcp-gateway), put this block right next to it for locality. Do NOT delete or modify any existing logic — additive only.

- [ ] **Step 6: Build + sanity check**

```bash
pnpm exec tsc --noEmit
# Expected: clean, no type errors

pnpm exec vitest run src/main/agent --reporter=verbose
# Expected: existing tests still pass + new tests pass
```

- [ ] **Step 7: Manual dev smoke test**

This is the only step that actually exercises the full path in this PR.

```bash
# (Make sure resources/apiyi-mcp/ is vendored from Task 1 Step 5.)
pnpm dev
```

Then:
1. Wait for the Electron window to appear.
2. In a separate terminal:
   ```bash
   cat ~/.codex/config.toml | grep -A 4 'mcp_servers.apiyi'
   ```
   Expected:
   ```toml
   [mcp_servers.apiyi]
   command = "/path/to/electron"
   args = ["/abs/path/to/resources/apiyi-mcp/dist/index.js"]
   enabled = false
   ```
   (`env` may be absent because `@iarna/toml` omits empty inline tables.)
3. Close the app, re-run `pnpm dev`. Check `~/.codex/config.toml` did NOT grow — `seedApiyiMcpEntry` returns `'skipped'` the second time. The main process console should print `[apiyi-mcp] first-boot seed: skipped`.

- [ ] **Step 8: Commit**

```bash
git add src/main/agent/apiyiMcpSeed.ts src/main/agent/__tests__/apiyiMcpSeed.test.ts src/main/index.ts
git commit -m "feat(agent): seed disabled apiyi mcp_servers entry on first boot

- seedApiyiMcpEntry reads ~/.codex/config.toml, ensures mcp_servers.apiyi
  exists with enabled:false, preserves all other keys; idempotent (returns
  'seeded' | 'skipped').
- Wired into src/main/index.ts after app.whenReady, best-effort (failure
  logs + continues, does not block boot).
- Malformed existing TOML is treated as empty with a warning — the file is
  then rewritten clean.

Spec: docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md (Task A)"
```

---

## Task 5: Wrap-up & PR

- [ ] **Step 1: Full repo verify**

```bash
pnpm exec tsc --noEmit
# Expected: no errors

pnpm exec vitest run --reporter=dot
# Expected: all tests pass; new ones included

pnpm exec eslint src/main/agent/apiyiMcpLauncher.ts src/main/agent/apiyiMcpSeed.ts src/main/agent/__tests__/apiyiMcp*.test.ts
# Expected: clean
```

- [ ] **Step 2: Inspect final diff**

```bash
git log origin/main..HEAD --oneline
# Expected, in order:
#   <hash> feat(agent): seed disabled apiyi mcp_servers entry on first boot
#   <hash> feat(agent): apiyiMcpLauncher path resolver + config entry builder
#   <hash> build(apiyi-mcp): ship vendored server in installer extraResources
#   <hash> build(apiyi-mcp): vendor script + lockfile

git diff origin/main --stat
# Expected: ~6-8 files changed:
#   .gitignore                                                 |  +3
#   electron-builder.yml                                       |  +12
#   package.json                                               |  +3
#   scripts/vendor-apiyi-mcp.lock.json                         |  +6
#   scripts/vendor-apiyi-mcp.mjs                               |  +160
#   src/main/agent/apiyiMcpLauncher.ts                         |  +60
#   src/main/agent/apiyiMcpSeed.ts                             |  +60
#   src/main/agent/__tests__/apiyiMcpLauncher.test.ts          |  +80
#   src/main/agent/__tests__/apiyiMcpSeed.test.ts              |  +130
#   src/main/index.ts                                          |  +25
```

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feature/apiyi-mcp-integration

gh pr create --base main --head feature/apiyi-mcp-integration \
  --title "feat(agent): vendor + seed apiyi-mcp-server (PR-1 of 3)" \
  --body "$(cat <<'EOF'
First of 3 PRs integrating https://github.com/2799662352/apiyi-mcp-server into Codex page.

## What this PR does
- **Vendor**: `scripts/vendor-apiyi-mcp.mjs` clones upstream at a pinned SHA, runs `npm ci --omit=dev`, copies `dist/` + `node_modules/` + `package.json` into `resources/apiyi-mcp/`. Idempotent. Wired into `npm run build` so release flow auto-vendors.
- **Ship**: `electron-builder.yml extraResources` copies `resources/apiyi-mcp/**` into the installer at `<resourcesPath>/apiyi-mcp/`.
- **Launcher module**: `src/main/agent/apiyiMcpLauncher.ts` resolves the entry path and builds the TOML config entry shape (pure, testable, no I/O).
- **First-boot seed**: `src/main/agent/apiyiMcpSeed.ts` writes `mcp_servers.apiyi = { enabled: false, ... }` to `~/.codex/config.toml` on app ready. Idempotent — respects manual user edits.

## What this PR does NOT do
- No UI changes. The entry stays `enabled: false`. Existing users see nothing.
- No actual spawn of the child process. PR-2 wires the settings field that flips `enabled` to `true` and the AgentManager reloads MCP config.

## Test plan
- [x] Unit: \`apiyiMcpLauncher.test.ts\` — path resolution (packaged/dev), config entry shape (enabled/disabled).
- [x] Unit: \`apiyiMcpSeed.test.ts\` — fresh seed, preserve existing keys, idempotency, malformed TOML recovery.
- [x] Manual: \`pnpm dev\` → check \`~/.codex/config.toml\` shows the seeded entry; relaunch → confirms 'skipped'.
- [ ] (Post-merge) Build + install on a clean Windows VM, confirm \`resources/apiyi-mcp/dist/index.js\` exists in the installed package.

## Spec
\`docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md\` (Task A).

## Followups (out of this PR)
- PR-2: settings IPC \`agent:save-apiyi-key\`, new ApiKeyInput, flip enabled→true on save, AgentManager.reloadMcpConfig.
- PR-3: VideoModelPicker + add \`gemini-3-5-flash\` to vision-models.json + \`supportsVideo\` field.
EOF
)"
```

- [ ] **Step 4: Self-merge after green CI** (per project convention)

```bash
gh pr checks --watch
# Wait for green, then:

gh pr merge --squash --auto
```

---

## Self-Review Checklist (read before declaring done)

**Spec coverage** (Task A in spec):

| Spec requirement | Task in this plan |
|---|---|
| Vendor script + lockfile | Task 1 |
| `prebuild` hook | Task 1 Step 3 |
| `electron-builder` `extraResources` | Task 2 |
| `getApiyiMcpEntryPath` using `getCodexResourceRoot` | Task 3 |
| `buildApiyiMcpConfigEntry({ enabled })` | Task 3 |
| First-boot seed `enabled: false`, preserve user edits | Task 4 |

All accounted for. ✓

**Out of scope for PR-1** (deferred to PR-2/3):
- IPC `agent:save-apiyi-key`
- Keychain / `codex-providers.json` storage
- `AgentManager.reloadMcpConfig` invocation
- UI (settings field + chat picker)
- `gemini-3-5-flash` model catalog entry
- `supportsVideo` field

**Type / name consistency** (verified):
- `getApiyiMcpEntryPath` name identical in Task 3 (`apiyiMcpLauncher.ts`) and Task 4 (`apiyiMcpSeed.ts` call site).
- `buildApiyiMcpConfigEntry({ entryPath, nodeBin, enabled })` signature identical across Task 3 implementation, Task 4 caller, and Task 4 tests.
- `seedApiyiMcpEntry({ personalConfigToml, entryPath, nodeBin })` signature identical across Task 4 tests, Task 4 implementation, and Task 4 Step 5 (`src/main/index.ts`) call site.
- TOML key path `mcp_servers.apiyi` used uniformly.
- Vendor output dir `resources/apiyi-mcp/` (no trailing slash variants) used uniformly across vendor script, electron-builder filter, and `getApiyiMcpEntryPath`.

**Placeholder scan**: searched the plan for "TODO", "TBD", "implement later", "appropriate error handling" — none found. The vendor script's `REPLACE_WITH_RESOLVED_SHA_AT_VENDOR_TIME` is intentional and self-resolves at first run (documented in Step 1 and Step 5).
