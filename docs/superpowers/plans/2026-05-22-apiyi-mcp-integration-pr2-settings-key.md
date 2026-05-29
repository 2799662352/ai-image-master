# PR-2 Plan — apiyi-mcp settings UI + API key (v4.3.16)

> **Branch:** `feature/apiyi-mcp-integration` (continues PR-1; PR-3 lands on
> the same branch — single PR for v4.3.16).
> **Status:** Plan locked 2026-05-22; supersedes the complex spec-PR-2 sketch.
> **Architecture: simplified.** Re-uses the existing `mcp_servers.*` TOML
> machinery instead of building a new env-injection path through
> `CodexLocalBackend.buildCodexSpawnEnv` + `restartCodex`.

## Why this is simpler than the design spec

The design doc proposed a "placeholder + spawn-env injection" model:
```toml
[mcp_servers.apiyi]
env = { APIYI_API_KEY = "${APIYI_API_KEY}" }   # placeholder
```
plus modifying `CodexLocalBackend.buildCodexSpawnEnv()` to read the key from
`CodexProviderStore` and inject it into codex's *parent* process env, plus
calling `restartCodex()` so the new env takes effect.

**That was overengineered.** The codex CLI reads `mcp_servers.<n>.env`
**as the child's spawn env directly** — it does not interpolate against
the parent env (or if it does, that's an unverified assumption). And the
"keep TOML clean of secrets" argument doesn't hold because
`codex-providers.json` also stores the same key as plaintext in
`userData`.

So PR-2 writes the literal API key into the TOML's `env` field, calls
`reloadMcpServers` (cheap — no parent restart, no 1-2s chat freeze), and
codex re-spawns `apiyi-mcp` with the literal env. Same pattern as
`dockerGatewayFix`.

```
+---------------------+        +-----------------------------+
| Settings UI         | -IPC-> | AgentManager                |
| (input video key)   | atomic | setApiyiVideoKey(key)       |
+---------------------+        |  1. providerStore.setApiKey |  → codex-providers.json
                               |     ("apiyi-video", key)    |    (.apiKeys["apiyi-video"])
                               |  2. backend.batchWriteConfig|  → ~/.codex/config.toml
                               |     edits = [{              |    {command, args,
                               |       keyPath: 'mcp_servers |     enabled: !!key,
                               |             .apiyi',        |     env.APIYI_API_KEY = "<key>"}
                               |       value: built-entry,   |
                               |       merge: 'replace'      |
                               |     }], reload = true       |  → codex re-spawns
                               +-----------------------------+    apiyi-mcp child
```

## Task breakdown (3 tasks; each ≤ 200 LOC + tests)

### Task 1 — Evolve `apiyiMcpLauncher` to inject the literal API key

**File:** `src/main/agent/apiyiMcpLauncher.ts` (and its test file)

**Changes:**
1. Extend `ApiyiMcpConfigEntryInput` with `apiKey?: string`.
2. Rewrite `buildApiyiMcpConfigEntry` so the `env` field is:
   - `{}` when `enabled === false` (unchanged seed behaviour).
   - `{ APIYI_API_KEY: input.apiKey }` when `enabled === true && apiKey`.
   - `{}` when `enabled === true && !apiKey` (defensive — caller should
     not enable without a key, but we don't want a leaked placeholder
     literal to ship to disk).
3. **Delete the `'${APIYI_API_KEY}'` placeholder concept** — it was a
   speculative design that the simplified architecture does not need.
4. Update JSDoc on `buildApiyiMcpConfigEntry` to reflect the new
   contract.

**Test updates (`__tests__/apiyiMcpLauncher.test.ts`):**
- Existing disabled-form test ✓ — no change (still `env: {}`).
- Existing "enabled placeholder" test → rewrite as
  *"builds an enabled entry with literal APIYI_API_KEY when apiKey is
  provided"*.
- Existing "disabled does not leak placeholder" test ✓ — keep as-is.
- **New test:** "enabled without apiKey emits empty env (defensive)".
- **New test:** "apiKey value is written verbatim — no transformation".

**Total: 5–6 tests, all unit, no fs / process.**

**Acceptance:** `npx vitest run src/main/agent/__tests__/apiyiMcpLauncher.test.ts` green.

---

### Task 2 — `AgentManager.setApiyiVideoKey` + IPC + preload

**Files:**
- `src/main/agent/AgentManager.ts` — new method
- `src/main/agent/ipc.ts` — new IPC handler
- `src/preload/index.ts` — new bridge method
- `src/main/agent/__tests__/AgentManager.test.ts` — tests

**`AgentManager.setApiyiVideoKey(key: string)` contract:**
```ts
async setApiyiVideoKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = key.trim()
  try {
    // 1. Persist to codex-providers.json (apiKeys["apiyi-video"]).
    await this.providerStore.setApiKey('apiyi-video', trimmed)

    // 2. Resolve entry path the same way apiyiMcpSeed does.
    const entryPath = getApiyiMcpEntryPath({
      appPath: app?.getAppPath() ?? '',
      isPackaged: !!app?.isPackaged,
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
    })

    // 3. Build the TOML entry — enabled iff key is non-empty.
    const entry = buildApiyiMcpConfigEntry({
      entryPath,
      nodeBin: process.execPath,
      enabled: trimmed.length > 0,
      apiKey: trimmed || undefined,
    })

    // 4. One atomic write + reload via existing batchWriteConfig path.
    if (!this.backend.batchWriteConfig) {
      throw new Error('Codex backend missing batchWriteConfig')
    }
    await this.backend.batchWriteConfig(
      [{ keyPath: 'mcp_servers.apiyi', value: entry, mergeStrategy: 'replace' }],
      true /* reload */,
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

**Why atomic in one RPC instead of two from the renderer:**
If the renderer fires `setProviderApiKey` then `batchWriteConfig` as two
calls and crashes in between, the providers.json has the key but the
TOML doesn't reflect it. Atomic on main keeps them in sync.

**Failure semantics:** If `providerStore.setApiKey` succeeds but
`batchWriteConfig` throws, we leave the key in providers.json but the
TOML untouched. The next call to `setApiyiVideoKey` will re-converge.
We do *not* roll back providers.json because partial-rollback is more
fragile than re-converge.

**IPC channel:** `agent:set-apiyi-video-key` (1 arg: `key: string`).

**Preload exposure:** `electronAPI.agent.setApiyiVideoKey(key)`.

**Tests (3):**
1. happy path: empty TOML → file gets written with enabled entry +
   key in env, providerStore got the key.
2. empty key: providerStore gets `''`, TOML gets `enabled: false` entry
   with `env: {}` (disable + clear).
3. batchWriteConfig throws: providers.json has the key, error
   surfaces, no crash.

(Reuses the in-memory FakeCodexBackend pattern already used by
existing AgentManager tests.)

**Acceptance:**
- `npx vitest run src/main/agent/__tests__/AgentManager.test.ts` green.
- Manual smoke: open app, type a key, see `~/.codex/config.toml`
  updated with literal env, MCP child gets re-spawned (visible via
  `agent:mcp-status` going `unknown → connected`).

---

### Task 3 — Settings UI: video API key input

**Files:**
- `src/renderer/src/stores/useSettingsStore.ts` — add field
- `src/renderer/src/pages-react/SettingsPage.tsx` — add `<ApiKeyInput>`

**useSettingsStore changes:**
- Add `videoApiKey: string` field next to `visionApiKey`.
- Add `setVideoApiKey(key: string)` action (pure local set; no
  side-effect — matches existing `setVisionApiKey` pattern).
- On `loadFromService`: load existing key from
  `getProvidersSnapshot().apiKeys["apiyi-video"]` (via
  `agent.getProviders()` which already returns `apiKeys`).
- On `saveAll`: call `agent.setApiyiVideoKey(get().videoApiKey)`.

**SettingsPage changes:**
- Right after the existing "图像理解 API Key" section (around
  `SettingsPage.tsx:233-242`), add a new section:
  ```tsx
  <section className="space-y-3">
    <ApiKeyInput
      value={videoApiKey}
      onChange={setVideoApiKey}
      label="🎥 视频理解 API Key（可选）"
      placeholder="请输入 api.apiyi.com 的视频理解 API Key（可选）"
      showToggle={false}
    />
    <p className="text-xs text-zinc-500">
      用于视频/音频/PDF 理解（apiyi-mcp）。留空则禁用此功能。
    </p>
  </section>
  ```

**Why piggyback on `saveAll` instead of save-on-change:**
Matches the existing UX — user types, hits 保存配置, all keys flushed
in one click. Save-on-change would surprise the user (each character
triggering an MCP reload). 1 second of debounce-then-save would also
add complexity for no real benefit.

**Edge cases:**
- User saves empty: `setApiyiVideoKey("")` disables the MCP cleanly.
- User changes key while MCP is mid-spawn: `reloadMcpServers` is
  idempotent — codex tears down + re-spawns the child. ~200 ms blip.
- User toggles between empty/non-empty: each save calls
  `batchWriteConfig` once. No accumulated drift.

**Tests:**
- Component-level tests for SettingsPage already exist for the
  visionApiKey path. Add 1 mirroring test for videoApiKey: input
  renders → typing fires `setVideoApiKey` → `handleSave` calls the
  new bridge method.

**Acceptance:**
- `npx vitest run src/renderer/src/pages-react/__tests__/SettingsPage.test.tsx` green.
- Manual smoke: open app fresh → Settings page renders new field →
  type a key → 保存 → reopen Settings → key is prefilled.

---

## What we explicitly do NOT touch in PR-2

1. **`CodexLocalBackend.buildCodexSpawnEnv`** — untouched. The
   APIYI_API_KEY lives in the MCP child's env via TOML, not the
   codex parent env.
2. **`restartCodex`** — never called. `reloadMcpServers` is enough.
3. **`CodexProviderStore` schema** — unchanged. The `apiKeys` field is
   already `Record<string, string>`, so `apiKeys["apiyi-video"]` is
   automatic. No version bump, no migration.
4. **`codexProviders.ts` built-in list** — unchanged. `apiyi-video` is
   not a Codex provider (it's a separate MCP feature); it never
   appears in the provider picker.
5. **localStorage masking layer** — no. Key is fetched via existing
   `agent.getProviders()` and held in zustand. Save-then-reopen
   prefills via the same path.

## Verification gates (run before pushing PR-2 commit)

```bash
npx tsc --noEmit                                                    # 0 new errors
npx vitest run src/main/agent/__tests__/apiyiMcpLauncher.test.ts    # 5-6 green
npx vitest run src/main/agent/__tests__/AgentManager.test.ts         # 3 new green
npx vitest run src/renderer/src/pages-react/__tests__/SettingsPage.test.tsx  # 1 new green
npx eslint src/main/agent/apiyiMcpLauncher.ts \
            src/main/agent/AgentManager.ts \
            src/main/agent/ipc.ts \
            src/preload/index.ts \
            src/renderer/src/stores/useSettingsStore.ts \
            src/renderer/src/pages-react/SettingsPage.tsx           # 0 errors
```

Manual smoke (Windows dev):
1. Type a key in 🎥 视频理解 API Key, save.
2. Open `%USERPROFILE%\.codex\config.toml`, confirm
   `mcp_servers.apiyi.enabled = true` and the literal key is in
   `env.APIYI_API_KEY`.
3. Open `%APPDATA%\<app>\codex-providers.json`, confirm
   `apiKeys["apiyi-video"]` matches.
4. Open MCP page in app, confirm `apiyi` shows `connected` (or
   whatever the apiyi-mcp child's idle state is).
5. Clear the key, save again, confirm both files revert to
   `enabled: false` + empty key.

## Commit message draft

```
feat(apiyi-mcp): settings UI + literal API key in TOML (PR-2/3)

- apiyiMcpLauncher.buildApiyiMcpConfigEntry now accepts apiKey and
  writes a literal env.APIYI_API_KEY (drops the speculative
  ${APIYI_API_KEY} placeholder design).
- AgentManager.setApiyiVideoKey atomically writes
  codex-providers.json (.apiKeys["apiyi-video"]) AND
  ~/.codex/config.toml (mcp_servers.apiyi with literal env) and
  triggers reloadMcpServers, so codex re-spawns the apiyi-mcp child
  with the new key without restarting the codex parent.
- New IPC agent:set-apiyi-video-key, preload bridge
  electronAPI.agent.setApiyiVideoKey.
- Settings page: new 🎥 视频理解 API Key input, persisted via the
  existing 保存配置 button.

No spawn-env injection, no codex parent restart, no schema
migration. Re-uses the existing mcp_servers.* TOML machinery.
```
