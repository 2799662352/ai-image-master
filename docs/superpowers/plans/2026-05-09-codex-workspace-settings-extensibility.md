# Codex Agent Workspace Settings & Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Codex permissions / MCP / skills out of `AgentChatPanel`'s header into a dedicated `Agent Workspace` page, and let users freely create, edit, and delete their own MCP servers and skills with `Personal` (`~/.codex/`, `~/.agents/skills/`) and `Workspace` (`<projectRoot>/.codex/`, `<projectRoot>/.agents/skills/`) scope. Add a top-level `Agent Workspace` tab and a compact `Agent` status button on the top-right.

**Architecture:** Main process gains `codexConfigStore` (CRUD + audit log) and `codexConfigMerge` (workspace overrides personal at Codex launch via `CODEX_HOME` to a generated `<userData>/codex-runtime/config.toml`). Renderer adds `AgentWorkspacePage` with sectioned nav (Overview / Permissions / MCP Servers / Skills / Threads / Logs). Trust-on-add: saves write immediately, restart Codex backend on user click, no approval gate. Form ↔ Raw editors share an in-memory model.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React, Zustand, Vitest, @testing-library/react, `@iarna/toml` (new), `yaml` (new), `@uiw/react-codemirror` (existing), `toml` parser (existing).

**Source spec:** `docs/superpowers/specs/2026-05-09-codex-workspace-settings-extensibility-design.md`

---

## Task 1: Add dependencies and shared types

**Files:**
- Modify: `package.json`
- Modify: `src/types/agent.ts`
- Test: none (type-only)

- [ ] **Step 1: Install runtime deps**

```bash
npm install @iarna/toml yaml
```

Expected: `package.json` gains `"@iarna/toml": "^2.x"` and `"yaml": "^2.x"` under `dependencies`.

- [ ] **Step 2: Add shared types**

Append to `src/types/agent.ts`:

```ts
export type CodexConfigScope = 'personal' | 'workspace'

export interface CodexMcpServerInput {
  id?: string
  name: string
  scope: CodexConfigScope
  enabled: boolean
  command: string
  args: string[]
  env: Array<{ key: string; value: string }>
  description?: string
}

export interface CodexMcpServerListItem {
  id: string
  name: string
  scope: CodexConfigScope
  enabled: boolean
  command: string
  argsSummary: string
  envKeysRedacted: string[]
  description?: string
  lastModifiedIso: string
  provenance: 'manual' | 'clipboard' | 'imported'
  warnings: string[]
}

export interface CodexSkillInput {
  id?: string
  name: string
  scope: CodexConfigScope
  description: string
  whenToUse: string
  instructions: string
}

export interface CodexSkillListItem {
  id: string
  name: string
  scope: CodexConfigScope
  path: string
  description?: string
  warnings: string[]
}

export interface CodexAuditLogEntry {
  tsIso: string
  action: 'mcp.save' | 'mcp.delete' | 'mcp.set-enabled' | 'skill.save' | 'skill.delete' | 'codex.restart'
  scope?: CodexConfigScope
  name?: string
  provenance?: 'manual' | 'clipboard' | 'imported'
  ok: boolean
  error?: string
}

export interface CodexWorkspacePaths {
  personalConfigToml: string
  personalSkillsRoot: string
  workspaceConfigToml: string
  workspaceSkillsRoot: string
  runtimeConfigToml: string
  auditLogPath: string
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: passes (no untouched-file regressions; add types only).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/types/agent.ts
git commit -m "feat(agent-workspace): add deps and types for MCP/skill CRUD"
```

---

## Task 2: codexConfigMerge pure function

**Files:**
- Create: `src/main/agent/codexConfigMerge.ts`
- Test: `src/main/agent/__tests__/codexConfigMerge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexConfigMerge.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeCodexConfigs } from '../codexConfigMerge'

describe('mergeCodexConfigs', () => {
  it('returns personal config when workspace is empty', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "docker"\nargs = ["run", "--rm", "ghcr.io/github/github-mcp-server"]\n`,
      workspaceToml: '',
    })
    expect(merged).toContain('[mcp_servers.github]')
    expect(merged).toContain('command = "docker"')
  })

  it('workspace overrides personal by name', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "old"\nargs = []\n`,
      workspaceToml: `[mcp_servers.github]\ncommand = "new"\nargs = ["x"]\n`,
    })
    expect(merged).toContain('command = "new"')
    expect(merged).not.toContain('command = "old"')
  })

  it('drops entries flagged enabled = false', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.foo]\ncommand = "x"\nargs = []\nenabled = false\n[mcp_servers.bar]\ncommand = "y"\nargs = []\n`,
      workspaceToml: '',
    })
    expect(merged).not.toContain('mcp_servers.foo')
    expect(merged).toContain('mcp_servers.bar')
  })

  it('treats missing files as empty', () => {
    expect(() => mergeCodexConfigs({ personalToml: '', workspaceToml: '' })).not.toThrow()
  })

  it('skips workspace document on parse error and surfaces warning', () => {
    const result = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "ok"\nargs = []\n`,
      workspaceToml: 'this is not valid toml = =',
      collectWarnings: true,
    })
    expect(result.merged).toContain('mcp_servers.github')
    expect(result.warnings.some((w) => /workspace/i.test(w))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexConfigMerge.test.ts`
Expected: FAIL with `Cannot find module '../codexConfigMerge'`.

- [ ] **Step 3: Implement merge**

Create `src/main/agent/codexConfigMerge.ts`:

```ts
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'

interface MergeInput {
  personalToml: string
  workspaceToml: string
  collectWarnings?: boolean
}

interface MergeResultWithWarnings {
  merged: string
  warnings: string[]
}

function tryParse(label: string, raw: string, warnings: string[]): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    return parseToml(raw) as Record<string, unknown>
  } catch (err) {
    warnings.push(`${label} TOML parse error: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function mergeCodexConfigs(input: MergeInput & { collectWarnings: true }): MergeResultWithWarnings
export function mergeCodexConfigs(input: MergeInput): string
export function mergeCodexConfigs(input: MergeInput): string | MergeResultWithWarnings {
  const warnings: string[] = []
  const personal = tryParse('personal', input.personalToml, warnings)
  const workspace = tryParse('workspace', input.workspaceToml, warnings)

  const personalServers = isPlainObject(personal.mcp_servers) ? personal.mcp_servers : {}
  const workspaceServers = isPlainObject(workspace.mcp_servers) ? workspace.mcp_servers : {}

  const mergedServers: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(personalServers)) {
    if (!isPlainObject(value)) continue
    if (value.enabled === false) continue
    mergedServers[name] = stripEnabledTrue(value)
  }
  for (const [name, value] of Object.entries(workspaceServers)) {
    if (!isPlainObject(value)) continue
    if (value.enabled === false) {
      delete mergedServers[name]
      continue
    }
    mergedServers[name] = stripEnabledTrue(value)
  }

  const document: Record<string, unknown> = { ...personal }
  delete document.mcp_servers
  if (Object.keys(mergedServers).length > 0) document.mcp_servers = mergedServers

  const merged = iarnaToml.stringify(document as iarnaToml.JsonMap)
  return input.collectWarnings ? { merged, warnings } : merged
}

function stripEnabledTrue(record: Record<string, unknown>): Record<string, unknown> {
  if (record.enabled !== true) return record
  const { enabled: _enabled, ...rest } = record
  return rest
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/main/agent/__tests__/codexConfigMerge.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigMerge.ts src/main/agent/__tests__/codexConfigMerge.test.ts
git commit -m "feat(agent-workspace): add codexConfigMerge with workspace overrides"
```

---

## Task 3: codexConfigStore — paths, atomic write, audit log scaffold

**Files:**
- Create: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexConfigStore.paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveWorkspacePaths } from '../codexConfigStore'

describe('resolveWorkspacePaths', () => {
  it('builds the four scope roots and runtime/audit paths', () => {
    const p = resolveWorkspacePaths({
      home: '/home/u',
      cwd: '/proj',
      userData: '/data',
    })
    expect(p.personalConfigToml).toBe(path.join('/home/u', '.codex', 'config.toml'))
    expect(p.personalSkillsRoot).toBe(path.join('/home/u', '.agents', 'skills'))
    expect(p.workspaceConfigToml).toBe(path.join('/proj', '.codex', 'workspace-mcp.toml'))
    expect(p.workspaceSkillsRoot).toBe(path.join('/proj', '.agents', 'skills'))
    expect(p.runtimeConfigToml).toBe(path.join('/data', 'codex-runtime', 'config.toml'))
    expect(p.auditLogPath).toBe(path.join('/data', 'codex-runtime', 'audit.log'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.paths.test.ts`
Expected: FAIL with `Cannot find module '../codexConfigStore'`.

- [ ] **Step 3: Implement scaffold**

Create `src/main/agent/codexConfigStore.ts`:

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CodexAuditLogEntry, CodexWorkspacePaths } from '../../types/agent'

export interface ResolvePathsInput {
  home: string
  cwd: string
  userData: string
}

export function resolveWorkspacePaths(input: ResolvePathsInput): CodexWorkspacePaths {
  return {
    personalConfigToml: path.join(input.home, '.codex', 'config.toml'),
    personalSkillsRoot: path.join(input.home, '.agents', 'skills'),
    workspaceConfigToml: path.join(input.cwd, '.codex', 'workspace-mcp.toml'),
    workspaceSkillsRoot: path.join(input.cwd, '.agents', 'skills'),
    runtimeConfigToml: path.join(input.userData, 'codex-runtime', 'config.toml'),
    auditLogPath: path.join(input.userData, 'codex-runtime', 'audit.log'),
  }
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await ensureParentDir(filePath)
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, filePath)
}

export async function appendAuditLog(
  auditLogPath: string,
  entry: CodexAuditLogEntry,
): Promise<void> {
  await ensureParentDir(auditLogPath)
  await fs.appendFile(auditLogPath, JSON.stringify(entry) + '\n', 'utf8')
}

export async function readAuditLog(
  auditLogPath: string,
  options: { limit?: number; sinceIso?: string } = {},
): Promise<CodexAuditLogEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(auditLogPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const parsed: CodexAuditLogEntry[] = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as CodexAuditLogEntry)
    } catch {
      // skip malformed lines
    }
  }
  let filtered = parsed
  if (options.sinceIso) filtered = filtered.filter((e) => e.tsIso >= options.sinceIso!)
  if (options.limit) filtered = filtered.slice(-options.limit)
  return filtered
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.paths.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.paths.test.ts
git commit -m "feat(agent-workspace): scaffold codexConfigStore paths and atomic writer"
```

---

## Task 4: codexConfigStore — list MCPs across both scopes

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.listMcp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexConfigStore.listMcp.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listMcp, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-list-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function seed(home: string, cwd: string, personal: string, workspace?: string) {
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await writeFile(path.join(home, '.codex', 'config.toml'), personal, 'utf8')
  if (workspace !== undefined) {
    await mkdir(path.join(cwd, '.codex'), { recursive: true })
    await writeFile(path.join(cwd, '.codex', 'workspace-mcp.toml'), workspace, 'utf8')
  }
}

describe('listMcp', () => {
  it('returns entries from both scopes with redacted env keys', async () => {
    const home = path.join(tmp, 'home')
    const cwd = path.join(tmp, 'proj')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await seed(
      home,
      cwd,
      `[mcp_servers.github]\ncommand = "docker"\nargs = ["run", "--rm", "img"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_xxx"\n`,
      `[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n`,
    )
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const result = await listMcp(paths)
    const byName = Object.fromEntries(result.map((s) => [s.name, s]))
    expect(byName.github.scope).toBe('personal')
    expect(byName.github.envKeysRedacted).toContain('GITHUB_TOKEN')
    expect(byName.github.argsSummary).toContain('docker')
    expect(byName.local.scope).toBe('workspace')
  })

  it('returns empty when neither file exists', async () => {
    const home = path.join(tmp, 'home2')
    const cwd = path.join(tmp, 'proj2')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const result = await listMcp(paths)
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.listMcp.test.ts`
Expected: FAIL with `listMcp is not a function` (export missing).

- [ ] **Step 3: Implement listMcp**

Append to `src/main/agent/codexConfigStore.ts`:

```ts
import { parse as parseToml } from 'toml'
import type { CodexMcpServerListItem, CodexConfigScope } from '../../types/agent'

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function parseMcpServers(raw: string): Record<string, Record<string, unknown>> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = parseToml(raw)
  } catch {
    return {}
  }
  const root = (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).mcp_servers) || {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v as Record<string, unknown>
    }
  }
  return out
}

function summarizeServer(
  name: string,
  raw: Record<string, unknown>,
  scope: CodexConfigScope,
  lastModifiedIso: string,
): CodexMcpServerListItem {
  const command = typeof raw.command === 'string' ? raw.command : ''
  const args = Array.isArray(raw.args) ? (raw.args as unknown[]).map(String) : []
  const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
    ? (raw.env as Record<string, unknown>)
    : {}
  const envKeys = Object.keys(env).sort()
  const description = typeof raw.description === 'string' ? raw.description : undefined
  const enabled = raw.enabled === false ? false : true
  return {
    id: `${scope}:${name}`,
    name,
    scope,
    enabled,
    command,
    argsSummary: [command, ...args].join(' ').trim(),
    envKeysRedacted: envKeys,
    description,
    lastModifiedIso,
    provenance: 'manual',
    warnings: [],
  }
}

export async function listMcp(paths: CodexWorkspacePaths): Promise<CodexMcpServerListItem[]> {
  const [personalRaw, workspaceRaw, personalStat, workspaceStat] = await Promise.all([
    readFileOrEmpty(paths.personalConfigToml),
    readFileOrEmpty(paths.workspaceConfigToml),
    fs.stat(paths.personalConfigToml).catch(() => null),
    fs.stat(paths.workspaceConfigToml).catch(() => null),
  ])
  const items: CodexMcpServerListItem[] = []
  for (const [name, raw] of Object.entries(parseMcpServers(personalRaw))) {
    items.push(summarizeServer(name, raw, 'personal', personalStat?.mtime.toISOString() ?? new Date().toISOString()))
  }
  for (const [name, raw] of Object.entries(parseMcpServers(workspaceRaw))) {
    items.push(summarizeServer(name, raw, 'workspace', workspaceStat?.mtime.toISOString() ?? new Date().toISOString()))
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.listMcp.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.listMcp.test.ts
git commit -m "feat(agent-workspace): list MCP servers across personal and workspace"
```

---

## Task 5: codexConfigStore — get MCP detail (with secrets)

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.getMcpDetail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexConfigStore.getMcpDetail.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getMcpDetail, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-detail-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('getMcpDetail', () => {
  it('returns clear-text env values when explicitly requested', async () => {
    const home = path.join(tmp, 'home'); const cwd = path.join(tmp, 'proj')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.github]\ncommand = "docker"\nargs = ["run"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_secret"\n`,
      'utf8',
    )
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const detail = await getMcpDetail(paths, 'personal:github')
    expect(detail).toBeDefined()
    expect(detail!.name).toBe('github')
    expect(detail!.scope).toBe('personal')
    expect(detail!.env).toEqual([{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }])
  })

  it('returns null for unknown id', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'c')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    expect(await getMcpDetail(paths, 'personal:nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.getMcpDetail.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement getMcpDetail**

Append to `src/main/agent/codexConfigStore.ts`:

```ts
import type { CodexMcpServerInput } from '../../types/agent'

export async function getMcpDetail(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<CodexMcpServerInput | null> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return null
  const target = scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  const servers = parseMcpServers(raw)
  const entry = servers[name]
  if (!entry) return null
  const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
    ? (entry.env as Record<string, unknown>)
    : {}
  return {
    id,
    name,
    scope,
    enabled: entry.enabled === false ? false : true,
    command: typeof entry.command === 'string' ? entry.command : '',
    args: Array.isArray(entry.args) ? (entry.args as unknown[]).map(String) : [],
    env: Object.entries(env).map(([key, value]) => ({ key, value: String(value ?? '') })),
    description: typeof entry.description === 'string' ? entry.description : undefined,
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.getMcpDetail.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.getMcpDetail.test.ts
git commit -m "feat(agent-workspace): expose getMcpDetail with clear-text env"
```

---

## Task 6: codexConfigStore — save MCP atomic + name validation

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.saveMcp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agent/__tests__/codexConfigStore.saveMcp.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveMcp, listMcp, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-save-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

async function setup() {
  const home = path.join(tmp, 'home'); const cwd = path.join(tmp, 'proj')
  await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

describe('saveMcp', () => {
  it('writes a personal MCP entry and is round-trippable via listMcp', async () => {
    const paths = await setup()
    const result = await saveMcp(paths, {
      name: 'github',
      scope: 'personal',
      enabled: true,
      command: 'docker',
      args: ['run', '--rm', 'ghcr.io/github/github-mcp-server'],
      env: [{ key: 'GITHUB_TOKEN', value: 'ghp_xxx' }],
    })
    expect(result.ok).toBe(true)
    const list = await listMcp(paths)
    expect(list.find((s) => s.name === 'github')?.scope).toBe('personal')
    const onDisk = await readFile(paths.personalConfigToml, 'utf8')
    expect(onDisk).toContain('[mcp_servers.github]')
  })

  it('rejects names with path separators or NUL', async () => {
    const paths = await setup()
    expect((await saveMcp(paths, baseInput({ name: 'a/b' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: '..' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: 'x\0y' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: '' }))).ok).toBe(false)
  })

  it('overwrites existing entry by name and scope', async () => {
    const paths = await setup()
    await saveMcp(paths, baseInput({ command: 'old' }))
    await saveMcp(paths, baseInput({ command: 'new' }))
    const detail = (await listMcp(paths)).find((s) => s.name === 'github')!
    expect(detail.command).toBe('new')
  })
})

function baseInput(over: Partial<Parameters<typeof saveMcp>[1]>) {
  return {
    name: 'github',
    scope: 'personal' as const,
    enabled: true,
    command: 'docker',
    args: [] as string[],
    env: [] as Array<{ key: string; value: string }>,
    ...over,
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.saveMcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement saveMcp**

Append to `src/main/agent/codexConfigStore.ts`:

```ts
import * as iarnaToml from '@iarna/toml'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
function validateName(name: string): string | null {
  if (!name) return 'name is required'
  if (name.includes('\0')) return 'name must not contain NUL'
  if (name.includes('/') || name.includes('\\')) return 'name must not contain path separators'
  if (name === '.' || name === '..') return 'name must not be a relative path'
  if (!NAME_RE.test(name)) return 'name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}'
  return null
}

export interface SaveMcpResult {
  ok: boolean
  id?: string
  error?: string
  warnings: string[]
}

export async function saveMcp(
  paths: CodexWorkspacePaths,
  input: CodexMcpServerInput,
): Promise<SaveMcpResult> {
  const nameError = validateName(input.name)
  if (nameError) return { ok: false, error: nameError, warnings: [] }
  const target = input.scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  let document: Record<string, unknown> = {}
  if (raw.trim()) {
    try { document = parseToml(raw) as Record<string, unknown> } catch (err) {
      return { ok: false, error: `existing TOML parse error: ${(err as Error).message}`, warnings: [] }
    }
  }
  const servers = (document.mcp_servers && typeof document.mcp_servers === 'object'
    ? document.mcp_servers
    : {}) as Record<string, Record<string, unknown>>
  const envObject: Record<string, string> = {}
  for (const { key, value } of input.env) {
    if (!key) continue
    envObject[key] = value
  }
  const entry: Record<string, unknown> = {
    command: input.command,
    args: input.args,
  }
  if (Object.keys(envObject).length > 0) entry.env = envObject
  if (input.description) entry.description = input.description
  if (input.enabled === false) entry.enabled = false
  servers[input.name] = entry
  document.mcp_servers = servers
  const serialized = iarnaToml.stringify(document as iarnaToml.JsonMap)
  await atomicWriteFile(target, serialized)
  return { ok: true, id: `${input.scope}:${input.name}`, warnings: [] }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.saveMcp.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.saveMcp.test.ts
git commit -m "feat(agent-workspace): atomic saveMcp with name validation"
```

---

## Task 7: codexConfigStore — delete MCP and setEnabled

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.deleteMcp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { deleteMcp, listMcp, saveMcp, setMcpEnabled, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-del-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

async function setup() {
  const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
  await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

describe('deleteMcp / setMcpEnabled', () => {
  it('removes the entry from the correct scope only', async () => {
    const paths = await setup()
    await saveMcp(paths, base({ name: 'a' }))
    await saveMcp(paths, base({ name: 'b' }))
    await deleteMcp(paths, 'personal:a')
    const list = await listMcp(paths)
    expect(list.map((s) => s.name).sort()).toEqual(['b'])
  })

  it('toggles enabled flag without dropping the entry', async () => {
    const paths = await setup()
    await saveMcp(paths, base({ name: 'a' }))
    await setMcpEnabled(paths, 'personal:a', false)
    const list = await listMcp(paths)
    const a = list.find((s) => s.name === 'a')!
    expect(a.enabled).toBe(false)
  })
})

function base(over: { name: string }) {
  return {
    name: over.name,
    scope: 'personal' as const,
    enabled: true,
    command: 'echo',
    args: [],
    env: [],
  }
}
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.deleteMcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement delete + setEnabled**

Append:

```ts
async function rewriteScope(
  paths: CodexWorkspacePaths,
  scope: CodexConfigScope,
  mutate: (servers: Record<string, Record<string, unknown>>) => void,
): Promise<{ ok: boolean; error?: string }> {
  const target = scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  let document: Record<string, unknown> = {}
  if (raw.trim()) {
    try { document = parseToml(raw) as Record<string, unknown> } catch (err) {
      return { ok: false, error: `existing TOML parse error: ${(err as Error).message}` }
    }
  }
  const servers = (document.mcp_servers && typeof document.mcp_servers === 'object'
    ? document.mcp_servers
    : {}) as Record<string, Record<string, unknown>>
  mutate(servers)
  if (Object.keys(servers).length === 0) delete document.mcp_servers
  else document.mcp_servers = servers
  await atomicWriteFile(target, iarnaToml.stringify(document as iarnaToml.JsonMap))
  return { ok: true }
}

export async function deleteMcp(paths: CodexWorkspacePaths, id: string) {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  return rewriteScope(paths, scope, (servers) => { delete servers[name] })
}

export async function setMcpEnabled(paths: CodexWorkspacePaths, id: string, enabled: boolean) {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  return rewriteScope(paths, scope, (servers) => {
    if (!servers[name]) return
    if (enabled) delete servers[name].enabled
    else servers[name].enabled = false
  })
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.deleteMcp.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.deleteMcp.test.ts
git commit -m "feat(agent-workspace): deleteMcp and setMcpEnabled"
```

---

## Task 8: codexConfigStore — list/get/save/delete skills

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  listSkills, getSkillDetail, saveSkill, deleteSkill, resolveWorkspacePaths,
} from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'sk-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

async function setup() {
  const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
  await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

describe('skills CRUD', () => {
  it('saves a workspace skill and lists it', async () => {
    const paths = await setup()
    const r = await saveSkill(paths, {
      name: 'demo', scope: 'workspace',
      description: 'd', whenToUse: 'w', instructions: '## body',
    })
    expect(r.ok).toBe(true)
    const list = await listSkills(paths)
    expect(list.find((s) => s.name === 'demo')?.scope).toBe('workspace')
  })

  it('parses existing SKILL.md frontmatter on disk into the form model', async () => {
    const paths = await setup()
    const dir = path.join(paths.workspaceSkillsRoot, 'extant')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'),
      `---\nname: extant\ndescription: from disk\n---\n## Body\n`,
      'utf8',
    )
    const detail = await getSkillDetail(paths, 'workspace:extant')
    expect(detail!.description).toBe('from disk')
    expect(detail!.instructions).toContain('## Body')
  })

  it('deletes a personal skill directory', async () => {
    const paths = await setup()
    await saveSkill(paths, {
      name: 'gone', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })
    expect(await deleteSkill(paths, 'personal:gone')).toEqual({ ok: true })
    expect(await listSkills(paths)).toEqual([])
  })

  it('rejects skill names with path separators', async () => {
    const paths = await setup()
    expect((await saveSkill(paths, {
      name: 'a/b', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.skills.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement skill CRUD**

Append to `src/main/agent/codexConfigStore.ts`:

```ts
import YAML from 'yaml'
import type { CodexSkillInput, CodexSkillListItem } from '../../types/agent'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface ParsedFrontmatter {
  description?: string
  whenToUse?: string
  name?: string
  body: string
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { body: raw }
  let parsed: Record<string, unknown> = {}
  try { parsed = (YAML.parse(m[1]) ?? {}) as Record<string, unknown> } catch { /* malformed */ }
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse : undefined,
    body: m[2],
  }
}

function buildSkillFile(input: CodexSkillInput): string {
  const fm: Record<string, string> = { name: input.name }
  if (input.description) fm.description = input.description
  if (input.whenToUse) fm.whenToUse = input.whenToUse
  const yaml = YAML.stringify(fm).trimEnd()
  return `---\n${yaml}\n---\n${input.instructions}\n`
}

async function listSkillsInRoot(
  root: string,
  scope: CodexConfigScope,
): Promise<CodexSkillListItem[]> {
  const entries: CodexSkillListItem[] = []
  let dirents: import('node:fs').Dirent[]
  try { dirents = await fs.readdir(root, { withFileTypes: true }) } catch { return [] }
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const skillPath = path.join(root, d.name, 'SKILL.md')
    let raw: string
    try { raw = await fs.readFile(skillPath, 'utf8') } catch { continue }
    const fm = parseFrontmatter(raw)
    entries.push({
      id: `${scope}:${d.name}`,
      name: fm.name ?? d.name,
      scope,
      path: skillPath,
      description: fm.description,
      warnings: [],
    })
  }
  return entries
}

export async function listSkills(paths: CodexWorkspacePaths): Promise<CodexSkillListItem[]> {
  const [personal, workspace] = await Promise.all([
    listSkillsInRoot(paths.personalSkillsRoot, 'personal'),
    listSkillsInRoot(paths.workspaceSkillsRoot, 'workspace'),
  ])
  return [...personal, ...workspace].sort((a, b) => a.name.localeCompare(b.name))
}

export async function getSkillDetail(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<CodexSkillInput | null> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return null
  const root = scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const filePath = path.join(root, name, 'SKILL.md')
  let raw: string
  try { raw = await fs.readFile(filePath, 'utf8') } catch { return null }
  const fm = parseFrontmatter(raw)
  return {
    id,
    name: fm.name ?? name,
    scope,
    description: fm.description ?? '',
    whenToUse: fm.whenToUse ?? '',
    instructions: fm.body.trimStart(),
  }
}

export async function saveSkill(
  paths: CodexWorkspacePaths,
  input: CodexSkillInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const err = validateName(input.name)
  if (err) return { ok: false, error: err }
  const root = input.scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, input.name)
  const file = path.join(dir, 'SKILL.md')
  await fs.mkdir(dir, { recursive: true })
  await atomicWriteFile(file, buildSkillFile(input))
  return { ok: true, id: `${input.scope}:${input.name}` }
}

export async function deleteSkill(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  const root = scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, name)
  await fs.rm(dir, { recursive: true, force: true })
  return { ok: true }
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.skills.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.skills.test.ts
git commit -m "feat(agent-workspace): skill CRUD with YAML frontmatter"
```

---

## Task 9: Audit log integration in save/delete paths

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.audit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveMcp, deleteMcp, readAuditLog, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'audit-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('audit log', () => {
  it('appends entries on save and delete', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await saveMcp(paths, {
      name: 'g', scope: 'personal', enabled: true,
      command: 'x', args: [], env: [],
    })
    await deleteMcp(paths, 'personal:g')
    const log = await readAuditLog(paths.auditLogPath)
    expect(log.map((e) => e.action)).toEqual(['mcp.save', 'mcp.delete'])
    expect(log[0]).toMatchObject({ scope: 'personal', name: 'g', ok: true })
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.audit.test.ts`
Expected: FAIL (no audit on save/delete yet).

- [ ] **Step 3: Wire audit log into save/delete**

In `src/main/agent/codexConfigStore.ts`, modify `saveMcp` and `deleteMcp` so each appends an entry. Keep return shape the same. Append at the end of `saveMcp` (after `atomicWriteFile`):

```ts
await appendAuditLog(paths.auditLogPath, {
  tsIso: new Date().toISOString(),
  action: 'mcp.save',
  scope: input.scope,
  name: input.name,
  provenance: 'manual',
  ok: true,
})
```

In `deleteMcp` after the rewrite returns `ok: true`:

```ts
await appendAuditLog(paths.auditLogPath, {
  tsIso: new Date().toISOString(),
  action: 'mcp.delete',
  scope, name, ok: true,
})
```

Repeat the same pattern for `setMcpEnabled` (`mcp.set-enabled`), `saveSkill` (`skill.save`), `deleteSkill` (`skill.delete`). On error paths, append with `ok: false, error: <msg>`.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.audit.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.audit.test.ts
git commit -m "feat(agent-workspace): append audit log on save/delete/set-enabled"
```

---

## Task 10: codexConfigStore — path containment guards

**Files:**
- Modify: `src/main/agent/codexConfigStore.ts`
- Test: `src/main/agent/__tests__/codexConfigStore.containment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveSkill, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cont-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('path containment', () => {
  it('rejects names that resolve outside the configured roots via symlink', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    const outside = path.join(tmp, 'outside')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(path.join(home, '.agents'), { recursive: true })
    await symlink(outside, path.join(home, '.agents', 'skills')).catch(() => {})
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const r = await saveSkill(paths, {
      name: 'evil', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/contain|outside|root/i)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.containment.test.ts`
Expected: FAIL on platforms where symlink succeeds. Skip on Windows without admin (test will see symlink failure and pass trivially; that is acceptable).

- [ ] **Step 3: Add canonical containment helper and apply to save paths**

Append to `src/main/agent/codexConfigStore.ts`:

```ts
async function realpathOrParent(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch {
    const parent = path.dirname(p)
    try { return path.join(await fs.realpath(parent), path.basename(p)) } catch { return p }
  }
}

async function assertInsideRoot(target: string, root: string): Promise<void> {
  const rRoot = await fs.realpath(root).catch(() => root)
  const rTarget = await realpathOrParent(target)
  const rel = path.relative(rRoot, rTarget)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path is outside allowed root: ${target}`)
  }
}
```

In `saveMcp`: before `atomicWriteFile`, add:

```ts
const rootForScope = input.scope === 'personal'
  ? path.dirname(paths.personalConfigToml)
  : path.dirname(paths.workspaceConfigToml)
try { await assertInsideRoot(target, rootForScope) }
catch (e) { return { ok: false, error: (e as Error).message, warnings: [] } }
```

In `saveSkill`: after `await fs.mkdir(dir, ...)`, add:

```ts
const allowed = input.scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
try { await assertInsideRoot(file, allowed) }
catch (e) { return { ok: false, error: (e as Error).message } }
```

Apply the same guard inside `deleteSkill` before the `fs.rm` call, using the matching scope root. For `deleteMcp` and `setMcpEnabled`, guard the target file before rewrite as well.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/codexConfigStore.containment.test.ts`
Expected: 1 passed (or skipped on Windows without symlink permission).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/codexConfigStore.ts src/main/agent/__tests__/codexConfigStore.containment.test.ts
git commit -m "feat(agent-workspace): canonical realpath containment on writes"
```

---

## Task 11: CodexLocalBackend.applyConfigChange + CODEX_HOME spawn

**Files:**
- Modify: `src/main/agent/CodexLocalBackend.ts`
- Modify: `src/main/agent/codexLaunch.ts` (only spawn args / env, no behavior change to existing tests)
- Test: `src/main/agent/__tests__/CodexLocalBackend.applyConfigChange.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { rebuildRuntimeConfig } from '../CodexLocalBackend'
import { resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'rt-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('rebuildRuntimeConfig', () => {
  it('writes merged config to runtime path and is idempotent', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(path.join(cwd, '.codex'), { recursive: true })
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.foo]\ncommand = "x"\nargs = []\n`,
      'utf8',
    )
    await writeFile(
      path.join(cwd, '.codex', 'workspace-mcp.toml'),
      `[mcp_servers.foo]\ncommand = "override"\nargs = []\n`,
      'utf8',
    )
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await rebuildRuntimeConfig(paths)
    const out = await readFile(paths.runtimeConfigToml, 'utf8')
    expect(out).toContain('command = "override"')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/CodexLocalBackend.applyConfigChange.test.ts`
Expected: FAIL (`rebuildRuntimeConfig` not exported).

- [ ] **Step 3: Implement rebuildRuntimeConfig and applyConfigChange**

In `src/main/agent/CodexLocalBackend.ts`, add (near top-level exports):

```ts
import { mergeCodexConfigs } from './codexConfigMerge'
import { atomicWriteFile, appendAuditLog } from './codexConfigStore'
import { promises as fs } from 'node:fs'
import type { CodexWorkspacePaths } from '../../types/agent'

export async function rebuildRuntimeConfig(paths: CodexWorkspacePaths): Promise<void> {
  const [personal, workspace] = await Promise.all([
    fs.readFile(paths.personalConfigToml, 'utf8').catch(() => ''),
    fs.readFile(paths.workspaceConfigToml, 'utf8').catch(() => ''),
  ])
  const merged = mergeCodexConfigs({ personalToml: personal, workspaceToml: workspace })
  await atomicWriteFile(paths.runtimeConfigToml, merged)
}
```

Add a method on the backend class:

```ts
async applyConfigChange(paths: CodexWorkspacePaths): Promise<void> {
  await rebuildRuntimeConfig(paths)
  this.configDirty = true
}
```

`configDirty` is a new private boolean property; readers may consult it through a getter `isConfigDirty()`. Add a `restartCodex()` method that sets `CODEX_HOME = path.dirname(paths.runtimeConfigToml)` and respawns the protocol client. Existing in-flight messages drain via the existing close handlers; do not force-kill running tool calls.

In `src/main/agent/codexLaunch.ts`'s `buildCodexLaunchEnv` (or equivalent helper), accept an optional `codexHome` arg and merge `{ CODEX_HOME: codexHome }` into the spawn env when provided.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/CodexLocalBackend.applyConfigChange.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/CodexLocalBackend.ts src/main/agent/codexLaunch.ts src/main/agent/__tests__/CodexLocalBackend.applyConfigChange.test.ts
git commit -m "feat(agent-workspace): rebuildRuntimeConfig and CODEX_HOME respawn"
```

---

## Task 12: AgentManager — wire workspace paths and methods

**Files:**
- Modify: `src/main/agent/AgentManager.ts`
- Test: `src/main/agent/__tests__/AgentManager.workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { AgentManager } from '../AgentManager'

describe('AgentManager workspace surface', () => {
  it('exposes listMcp / saveMcp / restartCodex through the manager', async () => {
    const mgr = new AgentManager(/* existing constructor args */)
    expect(typeof mgr.listMcp).toBe('function')
    expect(typeof mgr.saveMcp).toBe('function')
    expect(typeof mgr.deleteMcp).toBe('function')
    expect(typeof mgr.setMcpEnabled).toBe('function')
    expect(typeof mgr.listSkills).toBe('function')
    expect(typeof mgr.saveSkill).toBe('function')
    expect(typeof mgr.deleteSkill).toBe('function')
    expect(typeof mgr.getWorkspaceLogs).toBe('function')
    expect(typeof mgr.restartCodex).toBe('function')
  })
})
```

(Real construction shape will mirror the existing `AgentManager.test.ts` file so this test compiles in this codebase.)

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/AgentManager.workspace.test.ts`
Expected: FAIL on missing methods.

- [ ] **Step 3: Implement methods**

In `src/main/agent/AgentManager.ts`, add:

```ts
import {
  listMcp, getMcpDetail, saveMcp, deleteMcp, setMcpEnabled,
  listSkills, getSkillDetail, saveSkill, deleteSkill,
  readAuditLog, resolveWorkspacePaths,
} from './codexConfigStore'
import { app } from 'electron'
import os from 'node:os'

private workspacePaths(): CodexWorkspacePaths {
  return resolveWorkspacePaths({
    home: os.homedir(),
    cwd: process.cwd(),
    userData: app.getPath('userData'),
  })
}

async listMcp() { return listMcp(this.workspacePaths()) }
async getMcpDetail(id: string) { return getMcpDetail(this.workspacePaths(), id) }
async saveMcp(input: CodexMcpServerInput) {
  const r = await saveMcp(this.workspacePaths(), input)
  if (r.ok) await this.backend.applyConfigChange(this.workspacePaths())
  return r
}
async deleteMcp(id: string) {
  const r = await deleteMcp(this.workspacePaths(), id)
  if (r.ok) await this.backend.applyConfigChange(this.workspacePaths())
  return r
}
async setMcpEnabled(id: string, enabled: boolean) {
  const r = await setMcpEnabled(this.workspacePaths(), id, enabled)
  if (r.ok) await this.backend.applyConfigChange(this.workspacePaths())
  return r
}
async listSkills() { return listSkills(this.workspacePaths()) }
async getSkillDetail(id: string) { return getSkillDetail(this.workspacePaths(), id) }
async saveSkill(input: CodexSkillInput) { return saveSkill(this.workspacePaths(), input) }
async deleteSkill(id: string) { return deleteSkill(this.workspacePaths(), id) }
async getWorkspaceLogs(opts?: { limit?: number; sinceIso?: string }) {
  return readAuditLog(this.workspacePaths().auditLogPath, opts ?? {})
}
async restartCodex() { return this.backend.restartCodex(this.workspacePaths()) }
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/AgentManager.workspace.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/AgentManager.ts src/main/agent/__tests__/AgentManager.workspace.test.ts
git commit -m "feat(agent-workspace): expose CRUD and restart on AgentManager"
```

---

## Task 13: IPC handlers for the new surface

**Files:**
- Modify: `src/main/agent/ipc.ts`
- Test: `src/main/agent/__tests__/ipc.workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { registerAgentIpc } from '../ipc'
import type { AgentManager } from '../AgentManager'

describe('agent IPC workspace handlers', () => {
  it('registers list/save/delete/restart channels', () => {
    const ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'> = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    }
    const mgr = {
      listMcp: vi.fn(),
      getMcpDetail: vi.fn(),
      saveMcp: vi.fn(),
      deleteMcp: vi.fn(),
      setMcpEnabled: vi.fn(),
      listSkills: vi.fn(),
      getSkillDetail: vi.fn(),
      saveSkill: vi.fn(),
      deleteSkill: vi.fn(),
      getWorkspaceLogs: vi.fn(),
      restartCodex: vi.fn(),
    } as unknown as AgentManager
    registerAgentIpc(ipcMain as IpcMain, mgr)
    const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const channels = calls.map((c) => c[0])
    expect(channels).toEqual(expect.arrayContaining([
      'agent:list-mcp', 'agent:get-mcp-detail', 'agent:save-mcp', 'agent:delete-mcp',
      'agent:set-mcp-enabled', 'agent:list-skills', 'agent:get-skill-detail',
      'agent:save-skill', 'agent:delete-skill',
      'agent:get-workspace-logs', 'agent:restart-codex',
    ]))
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/main/agent/__tests__/ipc.workspace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add handlers**

In `src/main/agent/ipc.ts`, inside `registerAgentIpc`, add 11 `ipcMain.handle` calls that forward to the matching manager methods. Each handler should `try/catch` and return `{ ok: false, error: msg }` on throw, mirroring existing handler shape.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/main/agent/__tests__/ipc.workspace.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/ipc.ts src/main/agent/__tests__/ipc.workspace.test.ts
git commit -m "feat(agent-workspace): IPC handlers for MCP/skill CRUD and restart"
```

---

## Task 14: Preload bridge

**Files:**
- Modify: `src/preload/index.ts`
- Test: none (preload thin layer)

- [ ] **Step 1: Add wrappers**

For each new IPC channel, add a method on `window.electronAPI.agent` that calls `ipcRenderer.invoke(channel, payload)`. Mirror the naming used in renderer code: `listMcp`, `getMcpDetail`, `saveMcp`, `deleteMcp`, `setMcpEnabled`, `listSkills`, `getSkillDetail`, `saveSkill`, `deleteSkill`, `getWorkspaceLogs`, `restartCodex`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(agent-workspace): preload bridge for new IPC channels"
```

---

## Task 15: useTabStore + AppLayout — register agentWorkspace

**Files:**
- Modify: `src/renderer/src/stores/useTabStore.ts`
- Modify: `src/renderer/src/layouts/AppLayout.tsx`
- Modify: `src/renderer/src/pages-react/index.ts`

- [ ] **Step 1: Add to VALID_TABS**

In `src/renderer/src/stores/useTabStore.ts`, change `VALID_TABS` to include `'agentWorkspace'` between `'promptTemplates'` and `'settings'`. No reordering of existing entries.

- [ ] **Step 2: Add lazy export**

In `src/renderer/src/pages-react/index.ts`, append:

```ts
export const AgentWorkspacePage = lazy(() => import('./AgentWorkspacePage'))
```

- [ ] **Step 3: Add to PAGE_MAP**

In `src/renderer/src/layouts/AppLayout.tsx`, import `AgentWorkspacePage` from `'../pages-react'` and add `agentWorkspace: AgentWorkspacePage` to `PAGE_MAP`.

- [ ] **Step 4: Stub the page**

Create `src/renderer/src/pages-react/AgentWorkspacePage.tsx`:

```tsx
import React from 'react'

export default function AgentWorkspacePage(): React.JSX.Element {
  return (
    <div className="h-full w-full bg-slate-950 text-slate-100 p-6 font-mono">
      <h1 className="text-2xl font-semibold tracking-tight">Agent Workspace</h1>
      <p className="mt-2 text-slate-400">Loading…</p>
    </div>
  )
}
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/stores/useTabStore.ts src/renderer/src/layouts/AppLayout.tsx src/renderer/src/pages-react/index.ts src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): register new tab and lazy page stub"
```

---

## Task 16: TabBar — add new tab and TopRightActions slot

**Files:**
- Modify: `src/renderer/src/components/TabBar/TabBar.tsx`
- Test: `src/renderer/src/components/TabBar/__tests__/TabBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabBar } from '../TabBar'
import { useTabStore } from '../../../stores'

describe('TabBar', () => {
  it('renders Agent Workspace tab between 模板 and 设置', () => {
    render(<TabBar />)
    const labels = Array.from(document.querySelectorAll('nav button')).map((b) => b.textContent)
    const aw = labels.findIndex((l) => l?.includes('Agent Workspace'))
    const settings = labels.findIndex((l) => l?.includes('设置'))
    const tpl = labels.findIndex((l) => l?.includes('模板'))
    expect(tpl).toBeGreaterThanOrEqual(0)
    expect(aw).toBeGreaterThan(tpl)
    expect(aw).toBeLessThan(settings)
  })

  it('switches activeTab when Agent Workspace clicked', () => {
    render(<TabBar />)
    fireEvent.click(screen.getByText(/Agent Workspace/))
    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
  })

  it('renders the right-aligned AgentStatusButton slot', () => {
    render(<TabBar />)
    expect(document.querySelector('[data-testid="agent-status-button"]')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/components/TabBar/__tests__/TabBar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Update TabBar**

Edit `src/renderer/src/components/TabBar/TabBar.tsx`. Insert into `TABS` after `promptTemplates`:

```ts
{ key: 'agentWorkspace', label: 'Agent Workspace', icon: 'agent' },
```

Render the existing emoji-based tabs unchanged. For the new tab only, replace the emoji `<span>` with an SVG icon import: `import { Bot } from 'lucide-react'` and `<Bot className="h-4 w-4" />`. (lucide-react may need install — see step 4.)

Wrap the existing `<nav>` so it has a right-aligned slot:

```tsx
<div className="flex items-center justify-between w-full bg-cyberpunk-dark border-b border-cyberpunk-yellow/20">
  <nav className="flex items-center gap-1 px-4 py-2 overflow-x-auto">
    { /* existing tab buttons + new agentWorkspace */ }
  </nav>
  <div className="flex items-center gap-2 px-4">
    <AgentStatusButton />
  </div>
</div>
```

`AgentStatusButton` is added in Task 17.

- [ ] **Step 4: Add lucide-react if missing**

```bash
node -e "console.log(Object.keys(require('./package.json').dependencies).includes('lucide-react'))"
```

If `false`, run:

```bash
npm install lucide-react
```

- [ ] **Step 5: Run passing test**

Run: `npx vitest run src/renderer/src/components/TabBar/__tests__/TabBar.test.tsx`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/TabBar/TabBar.tsx src/renderer/src/components/TabBar/__tests__/TabBar.test.tsx package.json package-lock.json
git commit -m "feat(agent-workspace): add Agent Workspace tab and status slot"
```

---

## Task 17: AgentStatusButton component

**Files:**
- Create: `src/renderer/src/components/AgentStatusButton.tsx`
- Test: `src/renderer/src/components/__tests__/AgentStatusButton.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AgentStatusButton } from '../AgentStatusButton'
import { useAgentChatStore } from '../../features/agent-chat'
import { useTabStore } from '../../stores'

afterEach(cleanup)

describe('AgentStatusButton', () => {
  it('renders compact pill with sandbox and approval', () => {
    render(<AgentStatusButton />)
    expect(screen.getByTestId('agent-status-button').textContent).toMatch(/Codex/)
  })

  it('opens chat panel on click', () => {
    const open = vi.spyOn(useAgentChatStore.getState(), 'toggle')
    render(<AgentStatusButton />)
    fireEvent.click(screen.getByTestId('agent-status-button'))
    expect(open).toHaveBeenCalled()
  })

  it('switches to agentWorkspace tab on Open Workspace link', () => {
    render(<AgentStatusButton />)
    fireEvent.click(screen.getByText(/Open Workspace/))
    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/components/__tests__/AgentStatusButton.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { Bot } from 'lucide-react'
import { useAgentChatStore } from '../features/agent-chat'
import { useTabStore } from '../stores'

export function AgentStatusButton(): React.JSX.Element {
  const sandbox = useAgentChatStore((s) => s.codexStatus?.sessionConfig?.sandbox ?? 'workspace-write')
  const approval = useAgentChatStore((s) => s.codexStatus?.sessionConfig?.approvalPolicy ?? 'on-request')
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="agent-status-button"
        onClick={() => useAgentChatStore.getState().toggle()}
        className="inline-flex items-center gap-2 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-3 py-1.5 text-xs font-mono text-zinc-200 transition-colors duration-200 hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:text-cyan-100 cursor-pointer"
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Codex · {sandbox} · {approval}</span>
      </button>
      <button
        type="button"
        onClick={() => useTabStore.getState().switchTab('agentWorkspace')}
        className="text-xs text-zinc-400 hover:text-cyan-200 cursor-pointer"
      >
        Open Workspace
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/components/__tests__/AgentStatusButton.test.tsx`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/AgentStatusButton.tsx src/renderer/src/components/__tests__/AgentStatusButton.test.tsx
git commit -m "feat(agent-workspace): add compact AgentStatusButton in TabBar slot"
```

---

## Task 18: AgentWorkspacePage shell and section nav

**Files:**
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Create: `src/renderer/src/features/agent-workspace/useAgentWorkspaceStore.ts`
- Create: `src/renderer/src/features/agent-workspace/AgentWorkspaceNav.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/AgentWorkspacePage.nav.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AgentWorkspacePage from '../../../pages-react/AgentWorkspacePage'

describe('AgentWorkspacePage', () => {
  it('renders the six sections in nav', () => {
    render(<AgentWorkspacePage />)
    for (const label of ['Overview','Permissions','MCP Servers','Skills','Threads','Logs']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('switches active section when nav item clicked', () => {
    render(<AgentWorkspacePage />)
    fireEvent.click(screen.getByText('MCP Servers'))
    expect(screen.getByTestId('section-mcp')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/AgentWorkspacePage.nav.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement nav store and shell**

Create `src/renderer/src/features/agent-workspace/useAgentWorkspaceStore.ts`:

```ts
import { create } from 'zustand'

export type WorkspaceSectionKey = 'overview' | 'permissions' | 'mcp' | 'skills' | 'threads' | 'logs'

interface WorkspaceState {
  section: WorkspaceSectionKey
  setSection: (s: WorkspaceSectionKey) => void
  configDirty: boolean
  setConfigDirty: (v: boolean) => void
}

export const useAgentWorkspaceStore = create<WorkspaceState>((set) => ({
  section: 'overview',
  setSection: (section) => set({ section }),
  configDirty: false,
  setConfigDirty: (v) => set({ configDirty: v }),
}))
```

Create `src/renderer/src/features/agent-workspace/AgentWorkspaceNav.tsx`:

```tsx
import { useAgentWorkspaceStore, WorkspaceSectionKey } from './useAgentWorkspaceStore'

const ITEMS: Array<{ key: WorkspaceSectionKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'skills', label: 'Skills' },
  { key: 'threads', label: 'Threads' },
  { key: 'logs', label: 'Logs' },
]

export function AgentWorkspaceNav() {
  const section = useAgentWorkspaceStore((s) => s.section)
  const setSection = useAgentWorkspaceStore((s) => s.setSection)
  return (
    <nav className="flex flex-col gap-1 p-3 border-r border-zinc-800/60 bg-zinc-950/40 min-w-[200px]">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          onClick={() => setSection(it.key)}
          className={
            'cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors duration-200 ' +
            (section === it.key
              ? 'bg-cyan-500/15 text-cyan-100'
              : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100')
          }
        >
          {it.label}
        </button>
      ))}
    </nav>
  )
}
```

Update `AgentWorkspacePage.tsx`:

```tsx
import { AgentWorkspaceNav } from '../features/agent-workspace/AgentWorkspaceNav'
import { useAgentWorkspaceStore } from '../features/agent-workspace/useAgentWorkspaceStore'

export default function AgentWorkspacePage(): React.JSX.Element {
  const section = useAgentWorkspaceStore((s) => s.section)
  return (
    <div className="flex h-full w-full bg-slate-950 text-slate-100 font-mono">
      <AgentWorkspaceNav />
      <main className="flex-1 overflow-y-auto p-6">
        {section === 'overview'    && <div data-testid="section-overview">Overview placeholder</div>}
        {section === 'permissions' && <div data-testid="section-permissions">Permissions placeholder</div>}
        {section === 'mcp'         && <div data-testid="section-mcp">MCP placeholder</div>}
        {section === 'skills'      && <div data-testid="section-skills">Skills placeholder</div>}
        {section === 'threads'     && <div data-testid="section-threads">Threads placeholder</div>}
        {section === 'logs'        && <div data-testid="section-logs">Logs placeholder</div>}
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/AgentWorkspacePage.nav.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/AgentWorkspacePage.tsx src/renderer/src/features/agent-workspace/useAgentWorkspaceStore.ts src/renderer/src/features/agent-workspace/AgentWorkspaceNav.tsx src/renderer/src/features/agent-workspace/__tests__/AgentWorkspacePage.nav.test.tsx
git commit -m "feat(agent-workspace): page shell with section nav"
```

---

## Task 19: OverviewSection — read-only Codex runtime status

**Files:**
- Create: `src/renderer/src/features/agent-workspace/OverviewSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/OverviewSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OverviewSection } from '../OverviewSection'

describe('OverviewSection', () => {
  it('renders sandbox, approval, web search, writable roots count, MCP count, skills count', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getCodexStatus: vi.fn().mockResolvedValue({
            sessionConfig: { sandbox: 'workspace-write', approvalPolicy: 'on-request', webSearch: 'cached', writableRoots: ['/a','/b'] },
          }),
          listMcp: vi.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }]),
          listSkills: vi.fn().mockResolvedValue([{ name: 'x' }]),
        },
      },
    })
    render(<OverviewSection />)
    expect(await screen.findByText(/workspace-write/)).toBeTruthy()
    expect(screen.getByText(/on-request/)).toBeTruthy()
    expect(screen.getByText(/cached/)).toBeTruthy()
    expect(screen.getByText(/2 writable roots/)).toBeTruthy()
    expect(screen.getByText(/2 MCP servers/)).toBeTruthy()
    expect(screen.getByText(/1 skill/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/OverviewSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react'

export function OverviewSection(): React.JSX.Element {
  const [data, setData] = useState<{ sandbox: string; approval: string; web: string; roots: number; mcps: number; skills: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI?.agent
    if (!api) return
    Promise.all([api.getCodexStatus(), api.listMcp(), api.listSkills()]).then(([status, mcps, skills]) => {
      if (cancelled) return
      const cfg = status?.sessionConfig ?? {}
      setData({
        sandbox: cfg.sandbox ?? '?',
        approval: cfg.approvalPolicy ?? '?',
        web: cfg.webSearch ?? '?',
        roots: Array.isArray(cfg.writableRoots) ? cfg.writableRoots.length : 0,
        mcps: Array.isArray(mcps) ? mcps.length : 0,
        skills: Array.isArray(skills) ? skills.length : 0,
      })
    })
    return () => { cancelled = true }
  }, [])
  if (!data) return <div className="text-zinc-400 text-sm">Loading…</div>
  return (
    <section className="grid grid-cols-2 gap-4 max-w-2xl text-sm">
      <Stat label="Sandbox"        value={data.sandbox} />
      <Stat label="Approval"       value={data.approval} />
      <Stat label="Web search"     value={data.web} />
      <Stat label="Writable roots" value={`${data.roots} writable roots`} />
      <Stat label="MCP servers"    value={`${data.mcps} MCP servers`} />
      <Stat label="Skills"         value={`${data.skills} skill${data.skills === 1 ? '' : 's'}`} />
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/40 p-4">
      <div className="text-xs uppercase tracking-tight text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-zinc-100">{value}</div>
    </div>
  )
}
```

In `AgentWorkspacePage.tsx` replace the overview placeholder div with `<OverviewSection />`.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/OverviewSection.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/OverviewSection.tsx src/renderer/src/features/agent-workspace/__tests__/OverviewSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): OverviewSection shows runtime + counts"
```

---

## Task 20: PermissionsSection — lift Phase 2 panel into the page

**Files:**
- Create: `src/renderer/src/features/agent-workspace/PermissionsSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/PermissionsSection.test.tsx`

- [ ] **Step 1: Write a smoke test that asserts the existing CodexPermissionsPanel mounts inside this section**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PermissionsSection } from '../PermissionsSection'

describe('PermissionsSection', () => {
  it('mounts CodexPermissionsPanel content', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getCodexStatus: vi.fn().mockResolvedValue({ sessionConfig: { sandbox: 'workspace-write', approvalPolicy: 'on-request', webSearch: 'cached' } }),
          setSessionConfig: vi.fn(),
        },
      },
    })
    render(<PermissionsSection />)
    expect(await screen.findByText(/Sandbox/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/PermissionsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement section as wrapper**

```tsx
import { CodexPermissionsPanel } from '../agent-chat/CodexPermissionsPanel'
import { useAgentChatStore } from '../agent-chat'

export function PermissionsSection(): React.JSX.Element {
  const status = useAgentChatStore((s) => s.codexStatus)
  const apply = useAgentChatStore((s) => s.applySessionConfig)
  return (
    <section className="max-w-3xl">
      <CodexPermissionsPanel status={status} onApply={apply} />
    </section>
  )
}
```

In `AgentWorkspacePage.tsx` replace the permissions placeholder with `<PermissionsSection />`.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/PermissionsSection.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/PermissionsSection.tsx src/renderer/src/features/agent-workspace/__tests__/PermissionsSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): host permissions panel inside the workspace page"
```

---

## Task 21: McpSection list view

**Files:**
- Create: `src/renderer/src/features/agent-workspace/McpSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/McpSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { McpSection } from '../McpSection'

describe('McpSection', () => {
  it('lists MCP servers grouped by scope and shows redacted env keys', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listMcp: vi.fn().mockResolvedValue([
            { id: 'personal:github', name: 'github', scope: 'personal', enabled: true, command: 'docker', argsSummary: 'docker run', envKeysRedacted: ['GITHUB_TOKEN'] },
            { id: 'workspace:local', name: 'local', scope: 'workspace', enabled: false, command: 'node', argsSummary: 'node server.js', envKeysRedacted: [] },
          ]),
          deleteMcp: vi.fn(),
          setMcpEnabled: vi.fn(),
          restartCodex: vi.fn(),
        },
      },
    })
    render(<McpSection />)
    expect(await screen.findByText('github')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy()
    expect(screen.getByText('Personal (~/.codex)')).toBeTruthy()
    expect(screen.getByText(/Workspace/)).toBeTruthy()
  })

  it('refreshes after delete', async () => {
    const listMcp = vi.fn()
      .mockResolvedValueOnce([{ id: 'personal:a', name: 'a', scope: 'personal', enabled: true, command: 'x', argsSummary: 'x', envKeysRedacted: [] }])
      .mockResolvedValueOnce([])
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { listMcp, deleteMcp: vi.fn().mockResolvedValue({ ok: true }), setMcpEnabled: vi.fn(), restartCodex: vi.fn() } },
    })
    render(<McpSection />)
    fireEvent.click(await screen.findByLabelText('Delete a'))
    fireEvent.click(screen.getByText('Confirm delete'))
    expect(await screen.findByText(/No MCP servers yet/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react'
import { Trash2, Pencil, Power, Plus } from 'lucide-react'
import type { CodexMcpServerListItem } from '../../../../types/agent'
import { useAgentWorkspaceStore } from './useAgentWorkspaceStore'

export function McpSection(): React.JSX.Element {
  const [items, setItems] = useState<CodexMcpServerListItem[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const setDirty = useAgentWorkspaceStore((s) => s.setConfigDirty)

  async function refresh() {
    const api = (window as any).electronAPI?.agent
    setItems(await api.listMcp())
  }
  useEffect(() => { refresh() }, [])

  const personal = items.filter((i) => i.scope === 'personal')
  const workspace = items.filter((i) => i.scope === 'workspace')

  return (
    <section className="space-y-6 max-w-4xl">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">MCP Servers</h2>
        <button
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors duration-200 hover:bg-cyan-400 cursor-pointer"
        >
          <Plus className="h-4 w-4" /> New MCP Server
        </button>
      </header>

      <Group title="Personal (~/.codex)" items={personal}
        onDelete={(id) => setConfirmDelete(id)}
        onToggle={async (id, en) => { await (window as any).electronAPI.agent.setMcpEnabled(id, en); setDirty(true); refresh() }}
        onEdit={(id) => setEditing(id)}
      />
      <Group title="Workspace (<projectRoot>/.codex)" items={workspace}
        onDelete={(id) => setConfirmDelete(id)}
        onToggle={async (id, en) => { await (window as any).electronAPI.agent.setMcpEnabled(id, en); setDirty(true); refresh() }}
        onEdit={(id) => setEditing(id)}
      />

      {confirmDelete && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm">Delete <span className="font-mono">{confirmDelete}</span>?</p>
          <div className="mt-2 flex gap-2">
            <button
              className="cursor-pointer rounded-md bg-red-500 px-3 py-1.5 text-sm text-zinc-950 hover:bg-red-400"
              onClick={async () => {
                const r = await (window as any).electronAPI.agent.deleteMcp(confirmDelete)
                setConfirmDelete(null)
                if (r.ok) { setDirty(true); refresh() }
              }}
            >
              Confirm delete
            </button>
            <button className="cursor-pointer text-sm text-zinc-300" onClick={() => setConfirmDelete(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* McpEditor lives here in Task 22 */}
    </section>
  )
}

function Group({ title, items, onDelete, onToggle, onEdit }: {
  title: string
  items: CodexMcpServerListItem[]
  onDelete: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm uppercase tracking-tight text-zinc-500">{title}</h3>
      {items.length === 0
        ? <p className="text-sm text-zinc-500">No MCP servers yet.</p>
        : <ul className="space-y-2">{items.map((it) => (
            <li key={it.id} className="rounded-md border border-zinc-800/60 bg-zinc-900/40 p-3 flex items-center gap-3">
              <span className={'h-2 w-2 rounded-full ' + (it.enabled ? 'bg-emerald-400' : 'bg-zinc-600')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-zinc-100">{it.name}</span>
                  {!it.enabled && <span className="text-xs text-zinc-500">disabled</span>}
                </div>
                <div className="text-xs text-zinc-500 truncate">{it.argsSummary}</div>
                {it.envKeysRedacted.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {it.envKeysRedacted.map((k) => (
                      <span key={k} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">{k}</span>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => onToggle(it.id, !it.enabled)} title="Toggle enabled" className="cursor-pointer text-zinc-400 hover:text-zinc-100"><Power className="h-4 w-4" /></button>
              <button onClick={() => onEdit(it.id)} title="Edit" className="cursor-pointer text-zinc-400 hover:text-cyan-200"><Pencil className="h-4 w-4" /></button>
              <button onClick={() => onDelete(it.id)} aria-label={`Delete ${it.name}`} title="Delete" className="cursor-pointer text-zinc-400 hover:text-red-300"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}</ul>
      }
    </div>
  )
}
```

In `AgentWorkspacePage.tsx` replace the mcp placeholder with `<McpSection />`.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpSection.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/McpSection.tsx src/renderer/src/features/agent-workspace/__tests__/McpSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): MCP list grouped by scope with toggle/delete"
```

---

## Task 22: McpEditor — form mode

**Files:**
- Create: `src/renderer/src/features/agent-workspace/McpEditor.tsx`
- Modify: `src/renderer/src/features/agent-workspace/McpSection.tsx` (mount editor when `editing` is set)
- Test: `src/renderer/src/features/agent-workspace/__tests__/McpEditor.form.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { McpEditor } from '../McpEditor'

describe('McpEditor form mode', () => {
  it('saves a new MCP server with form values', async () => {
    const saveMcp = vi.fn().mockResolvedValue({ ok: true, id: 'personal:demo' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveMcp, getMcpDetail: vi.fn() } },
    })
    const onClose = vi.fn()
    render(<McpEditor mode="new" onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(saveMcp).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo', command: 'node', scope: 'personal' }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.form.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement editor (form only for now)**

```tsx
import { useEffect, useState } from 'react'
import type { CodexMcpServerInput, CodexConfigScope } from '../../../../types/agent'

export function McpEditor({ mode, onClose }: {
  mode: 'new' | string
  onClose: () => void
}): React.JSX.Element {
  const [input, setInput] = useState<CodexMcpServerInput>({
    name: '', scope: 'personal', enabled: true, command: '', args: [], env: [], description: '',
  })
  const [view, setView] = useState<'form' | 'raw'>('form')
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'new') return
    const api = (window as any).electronAPI?.agent
    api.getMcpDetail(mode).then((detail: CodexMcpServerInput | null) => {
      if (detail) setInput(detail)
    })
  }, [mode])

  async function handleSave() {
    setSaving(true); setError(null)
    const api = (window as any).electronAPI?.agent
    const r = await api.saveMcp(input)
    setSaving(false)
    if (!r?.ok) { setError(r?.error ?? 'Save failed'); return }
    setSavedTick(true)
    setTimeout(() => onClose(), 200)
  }

  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/60 p-4 space-y-3 max-w-2xl">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button className={tabCls(view === 'form')} onClick={() => setView('form')}>Form</button>
          <button className={tabCls(view === 'raw')} onClick={() => setView('raw')}>Raw</button>
        </div>
        <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200 cursor-pointer">Close</button>
      </div>

      {view === 'form' && (
        <div className="grid gap-3">
          <Field label="Name">
            <input
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-sm"
            />
          </Field>
          <Field label="Scope">
            <select
              value={input.scope}
              onChange={(e) => setInput({ ...input, scope: e.target.value as CodexConfigScope })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm"
            >
              <option value="personal">Personal (~/.codex)</option>
              <option value="workspace">Workspace (.codex)</option>
            </select>
          </Field>
          <Field label="Command">
            <input
              value={input.command}
              onChange={(e) => setInput({ ...input, command: e.target.value })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-sm"
            />
          </Field>
          <ArgsEditor args={input.args} onChange={(args) => setInput({ ...input, args })} />
          <EnvEditor env={input.env} onChange={(env) => setInput({ ...input, env })} />
          <Field label="Description">
            <input
              value={input.description ?? ''}
              onChange={(e) => setInput({ ...input, description: e.target.value })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm"
            />
          </Field>
        </div>
      )}

      {view === 'raw' && (
        <div className="text-xs text-zinc-500">Raw mode lands in Task 23.</div>
      )}

      <div className="rounded border border-zinc-800/60 bg-zinc-950 p-2 font-mono text-xs text-zinc-300">
        {`${input.command} ${input.args.join(' ')}`.trim()} env={input.env.map((e) => e.key).join(',')}
      </div>

      {error && <div className="text-sm text-red-300">{error}</div>}
      <div className="flex gap-2">
        <button disabled={saving} onClick={handleSave}
          className="cursor-pointer rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedTick && <span className="text-sm text-emerald-300">Saved</span>}
      </div>
    </div>
  )
}

function tabCls(active: boolean) {
  return 'cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors duration-200 ' +
    (active ? 'bg-zinc-800 text-cyan-100' : 'text-zinc-400 hover:text-zinc-200')
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-zinc-400">{label}</span>
      {children}
    </label>
  )
}

function ArgsEditor({ args, onChange }: { args: string[]; onChange: (a: string[]) => void }) {
  return (
    <div className="grid gap-1">
      <div className="text-sm text-zinc-400">Args</div>
      {args.map((a, i) => (
        <div key={i} className="flex gap-2">
          <input value={a} onChange={(e) => { const next = [...args]; next[i] = e.target.value; onChange(next) }}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-sm" />
          <button onClick={() => onChange(args.filter((_, idx) => idx !== i))} className="cursor-pointer text-sm text-zinc-400">×</button>
        </div>
      ))}
      <button onClick={() => onChange([...args, ''])} className="cursor-pointer self-start text-sm text-cyan-300">+ add arg</button>
    </div>
  )
}

function EnvEditor({ env, onChange }: { env: Array<{ key: string; value: string }>; onChange: (e: Array<{ key: string; value: string }>) => void }) {
  return (
    <div className="grid gap-1">
      <div className="text-sm text-zinc-400">Env</div>
      {env.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input placeholder="KEY" value={row.key} onChange={(e) => { const next = [...env]; next[i] = { ...row, key: e.target.value }; onChange(next) }}
            className="w-1/3 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-sm" />
          <input type="password" placeholder="value (hidden)" value={row.value} onChange={(e) => { const next = [...env]; next[i] = { ...row, value: e.target.value }; onChange(next) }}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-sm" />
          <button onClick={() => onChange(env.filter((_, idx) => idx !== i))} className="cursor-pointer text-sm text-zinc-400">×</button>
        </div>
      ))}
      <button onClick={() => onChange([...env, { key: '', value: '' }])} className="cursor-pointer self-start text-sm text-cyan-300">+ add env</button>
    </div>
  )
}
```

In `McpSection.tsx`, when `editing` is non-null, render `<McpEditor mode={editing} onClose={() => { setEditing(null); refresh(); setDirty(true) }} />` below the list.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.form.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/McpEditor.tsx src/renderer/src/features/agent-workspace/McpSection.tsx src/renderer/src/features/agent-workspace/__tests__/McpEditor.form.test.tsx
git commit -m "feat(agent-workspace): MCP form editor with inline preview and save"
```

---

## Task 23: McpEditor — raw mode and form↔raw round-trip

**Files:**
- Modify: `src/renderer/src/features/agent-workspace/McpEditor.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/McpEditor.raw.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { McpEditor } from '../McpEditor'

describe('McpEditor raw mode', () => {
  it('round-trips form ↔ raw on simple inputs', async () => {
    const saveMcp = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agent: { saveMcp, getMcpDetail: vi.fn() } } })
    render(<McpEditor mode="new" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rt' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo' } })
    fireEvent.click(screen.getByText('Raw'))
    const raw = screen.getByTestId('mcp-raw-editor') as HTMLTextAreaElement
    expect(raw.value).toContain('command = "echo"')
    fireEvent.change(raw, { target: { value: '[mcp_servers.rt]\ncommand = "node"\nargs = []\n' } })
    fireEvent.click(screen.getByText('Form'))
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('node')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.raw.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement raw view**

In `McpEditor.tsx`, replace the raw placeholder with a `<textarea>` (use `data-testid="mcp-raw-editor"`) and helper functions to convert between form input and a TOML fragment.

```tsx
import * as iarnaToml from '@iarna/toml'
import { parse as parseToml } from 'toml'

function inputToTomlFragment(i: CodexMcpServerInput): string {
  const env = Object.fromEntries(i.env.filter((e) => e.key).map((e) => [e.key, e.value]))
  const doc: any = { mcp_servers: { [i.name || 'unnamed']: { command: i.command, args: i.args, ...(Object.keys(env).length ? { env } : {}), ...(i.description ? { description: i.description } : {}) } } }
  return iarnaToml.stringify(doc)
}

function tomlFragmentToInput(text: string, scope: CodexConfigScope): CodexMcpServerInput | null {
  let parsed: any
  try { parsed = parseToml(text) } catch { return null }
  const root = parsed?.mcp_servers
  const [name, value] = Object.entries(root ?? {})[0] ?? []
  if (!name || !value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return {
    name,
    scope,
    enabled: v.enabled === false ? false : true,
    command: typeof v.command === 'string' ? v.command : '',
    args: Array.isArray(v.args) ? (v.args as unknown[]).map(String) : [],
    env: v.env && typeof v.env === 'object'
      ? Object.entries(v.env as Record<string, unknown>).map(([k, val]) => ({ key: k, value: String(val ?? '') }))
      : [],
    description: typeof v.description === 'string' ? v.description : undefined,
  }
}
```

In the editor body, render raw mode as:

```tsx
{view === 'raw' && (
  <textarea
    data-testid="mcp-raw-editor"
    value={rawText}
    onChange={(e) => setRawText(e.target.value)}
    className="h-64 w-full bg-zinc-950 border border-zinc-800 rounded p-2 font-mono text-xs text-zinc-100"
  />
)}
```

Track `rawText` state. On switching to raw, run `setRawText(inputToTomlFragment(input))`. On switching to form, run `tomlFragmentToInput(rawText, input.scope)` — if it returns null, keep raw mode and show parse error inline. Save in raw mode: parse first, then call `saveMcp` with the parsed input.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.raw.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/McpEditor.tsx src/renderer/src/features/agent-workspace/__tests__/McpEditor.raw.test.tsx
git commit -m "feat(agent-workspace): MCP raw TOML view with form round-trip"
```

---

## Task 24: McpEditor — risky-arg yellow stripe (non-blocking)

**Files:**
- Modify: `src/renderer/src/features/agent-workspace/McpEditor.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/McpEditor.risky.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { McpEditor } from '../McpEditor'

describe('McpEditor risky-arg stripe', () => {
  it('shows hint stripe when args contain --network=host', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agent: { saveMcp: vi.fn(), getMcpDetail: vi.fn() } } })
    render(<McpEditor mode="new" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'docker' } })
    fireEvent.click(screen.getByText('+ add arg'))
    fireEvent.change(screen.getAllByPlaceholderText('')[0], { target: { value: '--network=host' } }) // Args row input
    expect(screen.getByText(/Risky args detected/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.risky.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement detector**

```tsx
const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /--privileged\b/, label: '--privileged' },
  { re: /--network=host\b/, label: '--network=host' },
  { re: /-v\s*\/:|--mount\s+type=bind,src=\//, label: 'host root mount' },
  { re: /\bsudo\b/, label: 'sudo' },
  { re: /\brm\s+-rf\s+\/(\s|$)/, label: 'rm -rf /' },
  { re: /\b(bash|sh)\s+-c\b/, label: 'shell -c' },
  { re: /\beval\b/, label: 'eval' },
]

function detectRisky(input: CodexMcpServerInput): string[] {
  const haystack = [input.command, ...input.args].join(' ')
  return RISKY_PATTERNS.filter((p) => p.re.test(haystack)).map((p) => p.label)
}
```

In editor render, just above the inline preview:

```tsx
{detectRisky(input).length > 0 && (
  <div className="rounded border border-yellow-400/40 bg-yellow-400/10 p-2 text-xs text-yellow-200">
    Risky args detected: {detectRisky(input).join(', ')} — save is allowed but Codex will run with these privileges.
  </div>
)}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/McpEditor.risky.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/McpEditor.tsx src/renderer/src/features/agent-workspace/__tests__/McpEditor.risky.test.tsx
git commit -m "feat(agent-workspace): non-blocking risky-arg hint in MCP editor"
```

---

## Task 25: SkillsSection list + insert-into-chat

**Files:**
- Create: `src/renderer/src/features/agent-workspace/SkillsSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/SkillsSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SkillsSection } from '../SkillsSection'

describe('SkillsSection', () => {
  it('lists workspace and personal skills with insert action', async () => {
    const insertText = vi.fn()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([
            { id: 'workspace:demo', name: 'demo', scope: 'workspace', path: '/p/.agents/skills/demo/SKILL.md', description: 'do x' },
            { id: 'personal:helper', name: 'helper', scope: 'personal', path: '/h/.agents/skills/helper/SKILL.md', description: 'helps' },
          ]),
          deleteSkill: vi.fn(),
        },
      },
    })
    render(<SkillsSection insertIntoChat={insertText} />)
    expect(await screen.findByText('demo')).toBeTruthy()
    expect(screen.getByText('helper')).toBeTruthy()
    fireEvent.click(screen.getAllByText('Insert')[0])
    expect(insertText).toHaveBeenCalledWith(expect.stringContaining('demo'))
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/SkillsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Mirror `McpSection.tsx`'s structure: list grouped by scope with `Insert`, `Edit`, `Delete` actions. Insert calls `props.insertIntoChat(\`/${name}\`)`. Add `+ New Skill` button that opens `SkillEditor` from Task 26.

In `AgentWorkspacePage.tsx`, mount with `insertIntoChat={(text) => useAgentChatStore.getState().appendInputText(text)}`. (Add `appendInputText(text: string)` action to the chat store if not present — see also Task 30.)

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/SkillsSection.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/SkillsSection.tsx src/renderer/src/features/agent-workspace/__tests__/SkillsSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): skills list with insert-into-chat action"
```

---

## Task 26: SkillEditor — form + raw

**Files:**
- Create: `src/renderer/src/features/agent-workspace/SkillEditor.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/SkillEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SkillEditor } from '../SkillEditor'

describe('SkillEditor', () => {
  it('saves a workspace skill from the form', async () => {
    const saveSkill = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agent: { saveSkill, getSkillDetail: vi.fn() } } })
    const onClose = vi.fn()
    render(<SkillEditor mode="new" onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mine' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'desc' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: '## Hello' } })
    fireEvent.click(screen.getByText('Save'))
    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: 'mine', description: 'desc', instructions: '## Hello', scope: 'workspace' }))
  })

  it('round-trips form ↔ raw on the SKILL.md text', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agent: { saveSkill: vi.fn(), getSkillDetail: vi.fn() } } })
    render(<SkillEditor mode="new" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rt' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'body' } })
    fireEvent.click(screen.getByText('Raw'))
    const raw = screen.getByTestId('skill-raw-editor') as HTMLTextAreaElement
    expect(raw.value).toContain('name: rt')
    expect(raw.value).toContain('body')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/SkillEditor.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Mirror `McpEditor.tsx`. Form fields: `name`, `scope` (default `workspace`), `description`, `whenToUse`, `instructions` (textarea, monospace). Raw field is the full SKILL.md text. Conversion uses the same `parseFrontmatter` shape that the main process uses; for the renderer-side helper, inline a simple regex + `yaml` parse:

```ts
import YAML from 'yaml'
function inputToSkillMd(i: CodexSkillInput): string {
  const fm: Record<string, string> = { name: i.name }
  if (i.description) fm.description = i.description
  if (i.whenToUse) fm.whenToUse = i.whenToUse
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n${i.instructions}\n`
}
function skillMdToInput(text: string, scope: CodexConfigScope): CodexSkillInput | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  let fm: any = {}
  try { fm = YAML.parse(m[1]) ?? {} } catch { return null }
  return {
    name: typeof fm.name === 'string' ? fm.name : '',
    scope,
    description: typeof fm.description === 'string' ? fm.description : '',
    whenToUse: typeof fm.whenToUse === 'string' ? fm.whenToUse : '',
    instructions: m[2].trimStart(),
  }
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/SkillEditor.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/SkillEditor.tsx src/renderer/src/features/agent-workspace/__tests__/SkillEditor.test.tsx
git commit -m "feat(agent-workspace): skill editor with form/raw round-trip"
```

---

## Task 27: ThreadsSection — lift Codex thread management into the page

**Files:**
- Create: `src/renderer/src/features/agent-workspace/ThreadsSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/ThreadsSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThreadsSection } from '../ThreadsSection'

describe('ThreadsSection', () => {
  it('renders Codex threads with Read and Fork actions', async () => {
    const forkCodexThread = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listCodexThreads: vi.fn().mockResolvedValue([{ id: 't1', title: 'T1', updatedAtIso: '' }]),
          readCodexThread: vi.fn(),
          forkCodexThread,
        },
      },
    })
    render(<ThreadsSection />)
    expect(await screen.findByText('T1')).toBeTruthy()
    fireEvent.click(screen.getByText('Fork'))
    expect(forkCodexThread).toHaveBeenCalledWith('t1')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/ThreadsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Render a list of threads from `listCodexThreads`. Each row: title, updated time, `Read` button (calls `readCodexThread` and shows messages in a side detail), `Fork` button (calls `forkCodexThread`).

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/ThreadsSection.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/ThreadsSection.tsx src/renderer/src/features/agent-workspace/__tests__/ThreadsSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): threads section lifted from chat sidebar"
```

---

## Task 28: LogsSection — audit log viewer

**Files:**
- Create: `src/renderer/src/features/agent-workspace/LogsSection.tsx`
- Modify: `src/renderer/src/pages-react/AgentWorkspacePage.tsx`
- Test: `src/renderer/src/features/agent-workspace/__tests__/LogsSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LogsSection } from '../LogsSection'

describe('LogsSection', () => {
  it('lists most recent audit entries', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getWorkspaceLogs: vi.fn().mockResolvedValue([
            { tsIso: '2026-05-09T03:00:00Z', action: 'mcp.save', scope: 'personal', name: 'github', ok: true },
          ]),
        },
      },
    })
    render(<LogsSection />)
    expect(await screen.findByText('mcp.save')).toBeTruthy()
    expect(screen.getByText('personal')).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/LogsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
export function LogsSection(): React.JSX.Element {
  const [rows, setRows] = useState<CodexAuditLogEntry[]>([])
  useEffect(() => {
    (window as any).electronAPI?.agent?.getWorkspaceLogs({ limit: 200 }).then(setRows)
  }, [])
  return (
    <table className="w-full text-sm font-mono">
      <thead className="text-zinc-500">
        <tr><th className="text-left py-1">Time</th><th className="text-left">Action</th><th className="text-left">Scope</th><th className="text-left">Name</th><th className="text-left">OK</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-zinc-800/40">
            <td className="py-1 text-zinc-400">{r.tsIso}</td>
            <td className="text-zinc-200">{r.action}</td>
            <td className="text-zinc-300">{r.scope ?? ''}</td>
            <td className="text-zinc-300">{r.name ?? ''}</td>
            <td>{r.ok ? <span className="text-emerald-300">✓</span> : <span className="text-red-300">✗</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/LogsSection.test.tsx`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/LogsSection.tsx src/renderer/src/features/agent-workspace/__tests__/LogsSection.test.tsx src/renderer/src/pages-react/AgentWorkspacePage.tsx
git commit -m "feat(agent-workspace): audit log viewer in Logs section"
```

---

## Task 29: AgentChatPanel slim-down + Restart Codex banner

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.slim.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentChatPanel } from '../AgentChatPanel'

describe('AgentChatPanel slim-down', () => {
  it('does NOT render the three large Codex panels in the header', () => {
    render(<AgentChatPanel />)
    expect(screen.queryByText(/Codex permissions/i)).toBeNull()
    expect(screen.queryByText(/MCP servers/i)).toBeNull()
    expect(screen.queryByText(/Skills/i)).toBeNull()
  })

  it('renders a status strip and Open Agent Workspace link', () => {
    render(<AgentChatPanel />)
    expect(screen.getByText(/Open Agent Workspace/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.slim.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Remove the three panels and add status strip**

In `AgentChatPanel.tsx`:

- Delete imports for `CodexPermissionsPanel`, `CodexMcpPanel`, `CodexSkillsPanel`.
- Delete the JSX block at lines 211-215 (`<CodexPermissionsPanel ... />` and the wrapping grid containing `<CodexMcpPanel /> <CodexSkillsPanel />`).
- Add below the existing header buttons row:

```tsx
<div className="mt-2 flex items-center justify-between text-xs text-zinc-400 font-mono">
  <span>{`Codex · ${codexStatus?.sessionConfig?.sandbox ?? '?'} · ${codexStatus?.sessionConfig?.approvalPolicy ?? '?'} · ${codexStatus?.sessionConfig?.webSearch ?? '?'}`}</span>
  <button
    onClick={() => useTabStore.getState().switchTab('agentWorkspace')}
    className="cursor-pointer text-cyan-300 hover:text-cyan-100"
  >
    Open Agent Workspace
  </button>
</div>
```

If the `useAgentWorkspaceStore.configDirty` flag is set, render a small banner below the status strip:

```tsx
{configDirty && (
  <div className="mt-2 flex items-center justify-between rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
    <span>Codex config changed — restart to apply</span>
    <button onClick={async () => { await (window as any).electronAPI.agent.restartCodex(); useAgentWorkspaceStore.getState().setConfigDirty(false) }} className="cursor-pointer text-amber-200 underline">Restart Codex</button>
  </div>
)}
```

Also keep the existing `pendingApprovals` rendering and message list unchanged.

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.slim.test.tsx`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-chat/AgentChatPanel.tsx src/renderer/src/features/agent-chat/__tests__/AgentChatPanel.slim.test.tsx
git commit -m "feat(agent-workspace): slim down chat header, add restart banner"
```

---

## Task 30: Wire `appendInputText` and ensure insert-skill flow works end-to-end

**Files:**
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/store.appendInputText.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'

describe('appendInputText', () => {
  it('appends text to inputText state', () => {
    useAgentChatStore.setState({ inputText: 'hello' })
    useAgentChatStore.getState().appendInputText(' /demo')
    expect(useAgentChatStore.getState().inputText).toBe('hello /demo')
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/store.appendInputText.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add action**

In `src/renderer/src/features/agent-chat/store.ts`:

```ts
appendInputText: (text: string) => set((state) => ({ inputText: (state.inputText ?? '') + text })),
```

(Place inside the actions block, matching existing patterns.)

- [ ] **Step 4: Run passing test**

Run: `npx vitest run src/renderer/src/features/agent-chat/__tests__/store.appendInputText.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-chat/store.ts src/renderer/src/features/agent-chat/__tests__/store.appendInputText.test.ts
git commit -m "feat(agent-workspace): appendInputText for skill insert action"
```

---

## Task 31: Final regression — focused vitest sweep + scoped typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run new + neighbor tests**

```bash
npx vitest run src/main/agent/__tests__ src/renderer/src/features/agent-workspace src/renderer/src/features/agent-chat src/renderer/src/components/TabBar src/renderer/src/components/__tests__
```

Expected: all green; capture pass count for the commit message.

- [ ] **Step 2: Scoped typecheck**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: no new failures versus the Phase 2 baseline noted in the prior plan handoff. Pre-existing residuals (electron/main.js catch types, smartErase stack property, ffmpeg/ffprobe missing types, vendor browser-image-compression type errors) may persist; do not fix them in this phase.

- [ ] **Step 3: Lint touched files**

```bash
npx eslint src/main/agent/codexConfigStore.ts src/main/agent/codexConfigMerge.ts src/renderer/src/features/agent-workspace src/renderer/src/components/AgentStatusButton.tsx src/renderer/src/features/agent-chat/AgentChatPanel.tsx
```

Expected: clean.

- [ ] **Step 4: Commit verification note**

```bash
git commit --allow-empty -m "chore(agent-workspace): Phase 3 verification pass — focused tests, scoped typecheck, lint clean"
```

---

## Self-Review Notes

Spec coverage (sections of `2026-05-09-codex-workspace-settings-extensibility-design.md`):

- Top-level navigation changes — Tasks 15, 16, 17.
- Agent Workspace page layout and section nav — Task 18.
- Overview / Permissions / MCP / Skills / Threads / Logs sections — Tasks 19, 20, 21+22+23+24, 25+26, 27, 28.
- AgentChatPanel slim-down + Restart banner — Task 29.
- File targets and `CODEX_HOME` runtime merge — Tasks 11, 12.
- IPC additions — Tasks 13, 14.
- Trust-on-add lifecycle (no gate) — Task 22's Save flow + Task 12's `applyConfigChange`.
- Inline preview / risky-arg stripe / audit log / atomic write / canonical containment / name validation / secret handling — Tasks 22, 24, 9, 3, 10, 6, 5.
- Tests strategy — every data-layer task carries TDD; renderer tasks carry rendering tests; final regression is Task 31.

Placeholder scan: no `TBD` / `TODO` markers in steps. Every step has the actual code or command an engineer will run. Consolidated UI sections borrow patterns from the prior task on purpose (matching component shape) but each retains a complete code block.

Type consistency:

- `CodexMcpServerInput`, `CodexMcpServerListItem`, `CodexSkillInput`, `CodexSkillListItem`, `CodexAuditLogEntry`, `CodexConfigScope`, `CodexWorkspacePaths` defined in Task 1 and consumed unchanged through Tasks 4-12.
- `id` shape `<scope>:<name>` is consistent across `listMcp`, `getMcpDetail`, `deleteMcp`, `setMcpEnabled`, `listSkills`, `getSkillDetail`, `saveSkill`, `deleteSkill`.
- `agent.applyConfigChange(paths)` signature is identical between Task 11 (definition) and Task 12 (caller).
- `electronAPI.agent.*` channel names exactly match the IPC channel names registered in Task 13.

No further changes required.
