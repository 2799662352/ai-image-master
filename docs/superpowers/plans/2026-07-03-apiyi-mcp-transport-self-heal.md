# apiyi-mcp Transport Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every user's `mcp_servers.apiyi` entry converge to the known-good "system node" form (本机基准形态) automatically at boot — repair stale/dead transports and upgrade Electron-as-Node entries to real node when node becomes available.

**Architecture:** Extend `seedApiyiMcpEntry`'s boot convergence with two new repair triggers: (1) *stale transport* — `command` or `args[0]` is an absolute path that no longer exists on disk; (2) *electron→node upgrade* — the entry carries the Electron-as-Node marker (`env.ELECTRON_RUN_AS_NODE === "1"`) while the boot-time resolver now finds a system node. Both rebuild `command`/`args` from the freshly resolved values while preserving every user-set env value (sacred-user-config principle unchanged). No caller changes needed — `src/main/index.ts` already passes freshly resolved `command`/`extraEnv`/`entryPath` on every boot.

**Tech Stack:** TypeScript (Electron main), vitest, `@iarna/toml` / `toml` (already in use by the seed module).

**Background (why users break today):**
- Detection runs ONCE at first boot and is baked into `~/.codex/config.toml` forever (`resolveApiyiCommand` doc comment). A wrong/stale entry never heals.
- v4.3.16–v4.3.20 installers shipped `apiyi-mcp/` without `node_modules/` (see `electron-builder.yml` lines 59–100) — Electron-as-Node spawns crashed on `Cannot find module '@modelcontextprotocol/sdk'`.
- The no-key launch guard (`codexLaunch.ts` outcome C) force-disables apiyi when the user has no key in 设置 AND no key in config.toml — this is by design, but looks identical to "broken" from the user's seat.

---

## Task 0: Triage checklist for the affected user (no code)

Run these on the failing machine BEFORE assuming a code bug. Any hit here explains "不能用" without touching the repo.

- [ ] **Step 1: Confirm app version**

设置 → 关于 (or installer filename). If < 4.3.21, the packaged `apiyi-mcp/node_modules` is missing — upgrading to the current release (4.3.75+) fixes it outright.

- [ ] **Step 2: Confirm the key exists**

设置 → API易 must contain a non-empty key (the config.toml `APIYI_API_KEY: ""` does NOT count — `readApiyiConfigKey` treats empty as "no key" and the launch guard then injects `-c mcp_servers.apiyi.enabled=false`). No key → apiyi is dormant BY DESIGN.

- [ ] **Step 3: Verify packaged files exist**

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\CATIMATION-Cyberpunk Master\resources\apiyi-mcp\dist\index.js"
Test-Path "$env:LOCALAPPDATA\Programs\CATIMATION-Cyberpunk Master\resources\apiyi-mcp\node_modules\@modelcontextprotocol\sdk"
```

Expected: both `True`. `node_modules` missing → old broken installer; reinstall latest.

- [ ] **Step 4: Manual Electron-as-Node smoke test**

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\CATIMATION-Cyberpunk Master\CATIMATION-Cyberpunk Master.exe" `
  "$env:LOCALAPPDATA\Programs\CATIMATION-Cyberpunk Master\resources\apiyi-mcp\dist\index.js"
```

Expected: process stays alive silently waiting on stdio (MCP server booted). Instant exit with `Cannot find module ...` → packaging problem; GUI window opens → ELECTRON_RUN_AS_NODE not honored (report back, that would be a fuse-level issue — `electron-builder.yml` does not flip fuses today, so this is not expected).

- [ ] **Step 5: Compare their config.toml against the working shape**

`%USERPROFILE%\.codex\config.toml` → `[mcp_servers.apiyi]`. `command`/`args[0]` must point at files that exist. Stale paths → Task 1's self-heal fixes this class permanently.

---

## Task 1: Stale-transport repair (command/args path no longer exists)

**Files:**
- Modify: `src/main/agent/apiyiMcpSeed.ts`
- Test: `src/main/agent/__tests__/apiyiMcpSeed.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('seedApiyiMcpEntry', ...)` file (reuse `configPath`, `FAKE_ENTRY = '/Resources/apiyi-mcp/dist/index.js'`, `FAKE_NODE = '/usr/local/bin/node'` from the top of the file):

```ts
describe('seedApiyiMcpEntry — stale transport self-heal', () => {
  it('repairs an entry whose command path no longer exists on disk, preserving user env', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/old/uninstalled/electron"',
        'args = ["/old/uninstalled/resources/apiyi-mcp/dist/index.js"]',
        'enabled = true',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "sk-user-keep"',
        'ELECTRON_RUN_AS_NODE = "1"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
      // Simulate: old install gone, everything else present.
      fileExists: (p) => !p.startsWith('/old/uninstalled'),
    })
    expect(action).toBe('repaired')
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string; args: string[]; enabled: boolean; env: Record<string, string>
    }
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
    expect(apiyi.enabled).toBe(true)                     // user field untouched
    expect(apiyi.env.APIYI_API_KEY).toBe('sk-user-keep') // user env preserved
    // Repaired to the system-node form → the electron marker is dropped.
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    // Scaffold gaps get backfilled in the same pass.
    expect(apiyi.env.APIYI_BASE_URL).toBe('https://api.apiyi.com')
  })

  it('repairs when args[0] entry path is stale even if command still exists', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        `command = "${FAKE_NODE}"`,
        'args = ["/moved/away/dist/index.js"]',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
      fileExists: (p) => p !== '/moved/away/dist/index.js',
    })
    expect(action).toBe('repaired')
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as { args: string[] }
    expect(apiyi.args).toEqual([FAKE_ENTRY])
  })

  it('does NOT touch a healthy custom command that differs from the resolved one', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/my/custom/node"',
        `args = ["${FAKE_ENTRY}"]`,
        '[mcp_servers.apiyi.env]',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
      fileExists: () => true, // custom command exists → sacred, keep it
    })
    expect(action).toBe('skipped')
  })

  it('does NOT probe non-absolute commands like bare "node" (PATH-resolved, existsSync cannot judge)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "node"',
        `args = ["${FAKE_ENTRY}"]`,
        '[mcp_servers.apiyi.env]',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
      // Entry path exists; bare "node" must never be probed (not absolute).
      // If the implementation wrongly probed "node", fileExists would return
      // false for it — but since only absolute paths are probed and the only
      // absolute path here (args[0]) exists, the entry must stay untouched.
      fileExists: (p) => p === FAKE_ENTRY,
    })
    expect(action).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts`
Expected: the 4 new tests FAIL (`fileExists` is not an accepted input yet; actions come back `'skipped'`/`'backfilled'` instead of `'repaired'`).

- [ ] **Step 3: Implement stale-transport detection + repair in `apiyiMcpSeed.ts`**

Add imports at the top of the module (imports stay at top per repo rule):

```ts
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
```

(Replace the existing `import { promises as fs } from 'node:fs'` line.)

Extend `SeedApiyiMcpInput`:

```ts
  /**
   * Injectable filesystem probe used by the stale-transport check. Defaults to
   * `fs.existsSync`; tests override it to simulate uninstalled/moved paths.
   */
  fileExists?: (p: string) => boolean
```

Add the detector next to `isBrokenApiyiEntryMissingTransport`:

```ts
/**
 * Stale stdio transport: the entry HAS a string `command`, but the command
 * and/or the first arg are absolute paths that no longer exist on disk
 * (uninstalled Node, app moved to a new install dir, old dev checkout path).
 * codex would fail the spawn every time; the entry can never heal on its own
 * because seeding is one-shot. Only absolute paths are probed — a bare
 * `node` resolves via PATH and existsSync cannot judge it, and `url` entries
 * are a different transport we must not touch.
 */
function isStaleStdioTransport(
  entry: Record<string, unknown>,
  fileExists: (p: string) => boolean,
): boolean {
  if (typeof entry.command !== 'string' || entry.command === '') return false
  if ('url' in entry) return false
  const commandStale = path.isAbsolute(entry.command) && !fileExists(entry.command)
  const arg0 =
    Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : null
  const argStale = arg0 !== null && path.isAbsolute(arg0) && !fileExists(arg0)
  return commandStale || argStale
}
```

In `seedApiyiMcpEntry`, inside the `if (existingApiyi) { ... }` branch, AFTER the existing `isBrokenApiyiEntryMissingTransport` block and BEFORE the backfill block, add:

```ts
    const fileExists = input.fileExists ?? existsSync
    if (isStaleStdioTransport(existingApiyi, fileExists)) {
      const mergedEnv =
        mergeEnvWithScaffold(existingApiyi.env) ??
        (isPlainObject(existingApiyi.env)
          ? ({ ...existingApiyi.env } as Record<string, string>)
          : {})
      const envOut: Record<string, string> = { ...mergedEnv }
      // Converge to the freshly resolved form: on the node path the electron
      // marker is meaningless (and misleading), so drop it; on the electron
      // path extraEnv re-adds it below.
      delete envOut.ELECTRON_RUN_AS_NODE
      for (const [k, v] of Object.entries(input.extraEnv ?? {})) {
        if (!(k in envOut)) envOut[k] = v
      }
      const repairedApiyi: Record<string, unknown> = {
        ...existingApiyi,
        command: input.command,
        args: [input.entryPath],
        env: envOut,
      }
      const nextServers = { ...existingServers, apiyi: repairedApiyi }
      const nextDoc = { ...rawDoc, mcp_servers: nextServers }
      await atomicWriteFile(
        input.personalConfigToml,
        iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
      )
      return 'repaired'
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts`
Expected: ALL tests pass (new 4 + every pre-existing seed/backfill/repair test — the sacred-user-config tests must stay green untouched).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/apiyiMcpSeed.ts src/main/agent/__tests__/apiyiMcpSeed.test.ts
git commit -m "fix(apiyi-mcp): self-heal stale command/args transports at boot"
```

---

## Task 2: Electron→node upgrade (converge to the 本机基准形态 when node appears)

**Files:**
- Modify: `src/main/agent/apiyiMcpSeed.ts`
- Test: `src/main/agent/__tests__/apiyiMcpSeed.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('seedApiyiMcpEntry — electron→node upgrade', () => {
  it('upgrades an Electron-as-Node entry to system node once node is available', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/app/CATIMATION.exe"',
        `args = ["${FAKE_ENTRY}"]`,
        'enabled = true',
        '[mcp_servers.apiyi.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
        'APIYI_API_KEY = "sk-user-keep"',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE, // resolver found system node → extraEnv omitted
      fileExists: () => true, // old electron.exe still exists — upgrade anyway
    })
    expect(action).toBe('repaired')
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string; args: string[]; env: Record<string, string>
    }
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined() // marker dropped
    expect(apiyi.env.APIYI_API_KEY).toBe('sk-user-keep')   // user env preserved
  })

  it('leaves a healthy Electron-as-Node entry alone when node is still absent', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/app/CATIMATION.exe"',
        `args = ["${FAKE_ENTRY}"]`,
        '[mcp_servers.apiyi.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/app/CATIMATION.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, // resolver still on the fallback
      fileExists: () => true,
    })
    expect(action).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `npx vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts`
Expected: `upgrades an Electron-as-Node entry...` FAILS with action `'skipped'`; the `leaves...alone` test may already pass (that is fine — it pins the guard).

- [ ] **Step 3: Extend the repair trigger**

In `seedApiyiMcpEntry`, change the condition added in Task 1 to also fire on the upgrade case (same repair body, no duplication):

```ts
    const fileExists = input.fileExists ?? existsSync
    // Upgrade trigger: the entry is in the Electron-as-Node fallback form
    // (marker env present) but THIS boot resolved a real system node
    // (extraEnv carries no marker). Converge to the canonical node form —
    // same shape as a fresh dev-machine seed. resolveApiyiCommand's doc
    // ("delete the entry and restart to re-seed") becomes automatic.
    const resolvedIsSystemNode = !(input.extraEnv && 'ELECTRON_RUN_AS_NODE' in input.extraEnv)
    const entryIsElectronFallback =
      isPlainObject(existingApiyi.env) &&
      (existingApiyi.env as Record<string, unknown>).ELECTRON_RUN_AS_NODE === '1'
    const wantsUpgrade = resolvedIsSystemNode && entryIsElectronFallback

    if (isStaleStdioTransport(existingApiyi, fileExists) || wantsUpgrade) {
      // ... Task 1 repair body unchanged ...
    }
```

- [ ] **Step 4: Run the full seed suite**

Run: `npx vitest run src/main/agent/__tests__/apiyiMcpSeed.test.ts src/main/agent/__tests__/apiyiMcpLauncher.test.ts`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/apiyiMcpSeed.ts src/main/agent/__tests__/apiyiMcpSeed.test.ts
git commit -m "feat(apiyi-mcp): auto-upgrade Electron-as-Node entries to system node at boot"
```

---

## Task 3: Full regression + docs note

**Files:**
- Modify: `src/main/agent/apiyiMcpLauncher.ts` (doc comment only)

- [ ] **Step 1: Update the stale doc comment**

In `resolveApiyiCommand`'s JSDoc, replace the last paragraph:

```
 * Detection happens once at boot; the resolved command is baked into the
 * seeded `config.toml` entry and is NOT re-resolved on every spawn. If a user
 * later installs Node, they can re-seed (delete the apiyi entry and restart)
 * to pick up the cleaner `command = node` path.
```

with:

```
 * Detection happens at every boot. `seedApiyiMcpEntry` converges the on-disk
 * entry to the resolved form automatically: stale absolute paths (moved /
 * uninstalled binaries) are repaired, and an Electron-as-Node entry is
 * upgraded to `command = node` as soon as a system node appears on PATH.
 * User-set env values are always preserved.
```

- [ ] **Step 2: Run the agent test suite for regressions**

Run: `npx vitest run src/main/agent`
Expected: no new failures vs the pre-change baseline (note: `AgentManager.sessionConfig.test` has 4 known-stale failures unrelated to this work — see project memory).

- [ ] **Step 3: Typecheck + lint the touched files**

Run: `npm run typecheck`
Expected: zero NEW errors (the 3 pre-existing `routeNotification` errors in `CodexProtocolClient.ts` are baseline).

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/apiyiMcpLauncher.ts
git commit -m "docs(apiyi-mcp): document boot-time transport convergence"
```

---

## Explicitly out of scope (follow-ups, do NOT do here)

- Applying the same self-heal to `cinematography_kb` (`cinematographyKbMcpSeed.ts`) and the catimation stdio bridge — same pattern, separate plan.
- Bundling a standalone Node runtime in `extraResources` so packaged users never need the Electron fallback (~30–80 MB installer growth; only worth it if the Electron-as-Node path proves unreliable in Task 0 triage).
- Any change to the no-key dormant guard (outcome C in `codexLaunch.ts`) — it is correct behavior; the fix for "no key" is the user setting a key, not code.

## Self-Review

- Spec coverage: stale-path heal (Task 1), node-upgrade convergence to the 本机 form (Task 2), doc truthfulness (Task 3), and the non-code triage for the actual affected user (Task 0). ✔
- Sacred-user-config preserved: repairs only rewrite `command`/`args` and the `ELECTRON_RUN_AS_NODE` marker; all other env keys and fields carried over; custom healthy commands and bare `node` never touched (pinned by tests). ✔
- Type consistency: `fileExists?: (p: string) => boolean` used identically in input, detector, and tests; `SeedAction` reuses existing `'repaired'`. ✔
