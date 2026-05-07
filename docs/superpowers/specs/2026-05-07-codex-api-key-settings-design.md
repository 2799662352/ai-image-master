# Codex Agent API Key in Settings — Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-05-07
**Author:** Claude (Cursor agent) at user request

## Goal

Let the user configure the OpenAI API key for the Codex agent backend through the existing visual settings panel — without ever touching `$env:OPENAI_API_KEY` or `~/.codex/auth.json` manually. The key must reach the spawned `codex app-server` child process, and the agent panel must give a clear error (not silently hang) when the key is missing.

## Non-Goals

- ChatGPT login flow (browser-based OAuth → `~/.codex/auth.json`). Out of scope; only direct OpenAI key for now.
- Per-thread/per-session key override. One global key is enough for MVP.
- Key encryption at rest. localStorage and the JSON file under `userData/` are stored unencrypted, matching how the existing image-generation API keys are stored.
- Key rotation reminders, expiry checks, usage quota display.

## User Story

1. User opens the app, opens the Settings page (existing route).
2. Sees a new "🤖 CODEX AGENT API KEY" section between "图像理解 API Key" and "界面偏好".
3. Pastes their OpenAI key (`sk-...`) into the password-masked `ApiKeyInput`.
4. Clicks "🔌 测试连接" — toast says "连接成功" or "连接失败: <reason>".
5. Clicks "💾 保存配置" (existing global save button) — key is persisted.
6. Presses `Ctrl+Shift+A` to open the agent panel, types a prompt, sends it. The Codex backend spawns, the key flows through, the assistant streams a reply.
7. If the user forgot to save the key (or cleared it), the chat panel shows a red error bubble: "请在设置页填写 Codex Agent API Key" — instead of hanging or showing a cryptic auth error.

## Architecture

### Persistence — two stores, kept in sync

The renderer and main process need different storage paths because they don't share a process:

| Layer | Storage | Why |
|---|---|---|
| Renderer | `localStorage['codex_api_key']` | Same pattern as existing `api_key_<site>`. Persists across tab reloads, available immediately when settings page mounts. |
| Main | `<userData>/codex-agent.json` (`{ openaiApiKey: string }`) | Available before renderer connects, available even when renderer is closed (e.g. if Codex is invoked from CLI tooling later). Survives reinstall when only renderer cache is wiped. |

**Sync direction:** renderer → main is push-on-save. Main never pushes back to renderer; the renderer's localStorage is the editable source of truth, and it's the renderer's job to broadcast updates.

**Sync trigger:** the existing "💾 保存配置" button (`SettingsPage.handleSave`) calls the new IPC `electronAPI.agent.setApiKey(key)` after writing localStorage. The IPC handler in main writes the JSON file synchronously before returning, so the renderer can rely on the next `agent:start-thread` seeing the updated key.

### Settings UI

New section in `SettingsPage.tsx`:

```
[Existing 图像理解 API Key section]

———————————————————

🤖 CODEX AGENT API KEY
<ApiKeyInput value={codexApiKey} onChange={setCodexApiKey} placeholder="sk-..." />
[🔌 测试连接]    [说明文字: 用于 AI Agent (Ctrl+Shift+A)。需要 OpenAI 直连 sk- key]

[Existing 界面偏好 section]
```

The "测试连接" button is disabled when `codexApiKey` is empty or while testing. On click it calls `electronAPI.agent.testConnection()` → toast.

### IPC surface

New IPC channels (registered in `src/main/index.ts`, exposed in `src/preload/index.ts`):

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `agent:set-api-key` | renderer → main | `string` | `{ ok: boolean }` |
| `agent:test-connection` | renderer → main | none | `{ ok: boolean; error?: string }` |

Existing channels (`agent:send-message`, `agent:cancel`, `agent:event`) are unchanged.

### Main-side flow

`AgentManager`:
- New private `codexApiKey: string = ''` cache.
- New private `codexApiKeyPath: string = path.join(app.getPath('userData'), 'codex-agent.json')`.
- On construction, load `codexApiKey` from disk synchronously (small file, blocking is fine at startup).
- `setCodexApiKey(key)`: write to disk + update cache. Atomic-ish (write to temp + rename).
- `getCodexApiKey()`: return cached value.
- `testConnection()`: spin up a temporary `CodexLocalBackend` instance with `getApiKey: () => this.getCodexApiKey()`, await `start()`, await one `initialize` round-trip (already part of `start()`'s contract), then `stop()`. Return `{ ok: true }` on success; `{ ok: false, error: e.message }` on any thrown error. Hard 15 s timeout.
- **Empty-key gate** in `sendMessage()` (or wherever IPC routes the `agent:send-message` channel): if `getCodexApiKey()` returns empty, immediately emit `{ type: 'error', threadId, error: '请在设置页填写 Codex Agent API Key' }` to the renderer via the existing event stream, **without spawning the backend**. The chat panel already renders error events as red bubbles, so this is enough.

`CodexLocalBackend`:
- Constructor option `getApiKey?: () => string | undefined`.
- In `start()`, when building the spawn options:
  ```ts
  const apiKey = this.options.getApiKey?.()
  const env = { ...process.env, ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}) }
  const proc = spawn(bin, buildCodexLaunchArgs({ listenUrl }), { stdio: [...], env })
  ```
- The frozen helpers (`codexProtocol.ts`, `codexLaunch.ts`, `connectWithRetry.ts`, `codexUserInput.ts`) stay frozen.

### Block-with-toast contract

The chat panel store already handles incoming `error` events. The error message string is rendered verbatim in a red bubble. So the empty-key path is:

1. User clicks send with empty key.
2. `useAgentChatStore.sendMessage()` calls `electronAPI.agent.sendMessage(payload)`.
3. Main's `agent:send-message` handler calls `agentManager.sendMessage(payload)`.
4. `AgentManager` checks `getCodexApiKey()`. Empty → emits error event → returns immediately (does not call `backend.start()`).
5. Renderer receives the error event via the existing `agent:event` subscription, displays the red bubble.
6. `isRunning` flips to false. Send button re-enables.

This is one branch in `sendMessage` — about 8 lines.

## Tests

### Main

`src/main/agent/__tests__/CodexLocalBackend.test.ts` — extend:
- New test: when `getApiKey` returns `'sk-test'`, the spawned child's env contains `OPENAI_API_KEY=sk-test`. Implementation: inject a spawn factory via constructor (alongside the existing `wsUrl` test override) and assert the env arg.
- New test: when `getApiKey` returns `undefined` or `''`, the env does **not** contain `OPENAI_API_KEY` (i.e. we don't accidentally clobber it with empty string).

`src/main/agent/__tests__/AgentManager.test.ts` — extend (or create if absent):
- Empty-key gate test: with `codexApiKey = ''`, calling `agentManager.sendMessage(...)` emits exactly one `error` event with the expected message and never invokes `backend.start()`.
- Persistence test: `setCodexApiKey('sk-foo')` writes the JSON file; subsequent `new AgentManager()` reads it back.

### Renderer

`src/renderer/src/stores/__tests__/useSettingsStore.test.ts` — extend:
- `codexApiKey` is loaded from `localStorage` on `loadFromService`.
- `setCodexApiKey(value)` updates the store; `saveAll` calls `electronAPI.agent.setApiKey(value)`.

(No UI snapshot tests — keeping scope tight.)

## Touched files (final list)

| File | Change |
|---|---|
| `src/main/agent/AgentManager.ts` | + `getCodexApiKey`, `setCodexApiKey`, `testConnection`, empty-key gate, JSON persistence |
| `src/main/agent/CodexLocalBackend.ts` | + `getApiKey` constructor option, spawn factory injection (for tests), env merging |
| `src/main/agent/__tests__/CodexLocalBackend.test.ts` | + 2 spawn-env tests |
| `src/main/agent/__tests__/AgentManager.test.ts` | + (or create) empty-key gate + persistence tests |
| `src/main/index.ts` | + IPC handlers for `agent:set-api-key` + `agent:test-connection` |
| `src/preload/index.ts` | + `agent.setApiKey`, `agent.testConnection` |
| `src/types/agent.ts` (or wherever `ElectronAPI` lives) | + signatures |
| `src/renderer/src/stores/useSettingsStore.ts` | + `codexApiKey`, `setCodexApiKey` |
| `src/renderer/src/stores/__tests__/useSettingsStore.test.ts` | + 2 tests |
| `src/renderer/src/pages-react/SettingsPage.tsx` | + new section + test connection button |

Estimated diff: ~250 LOC across 10 files. No new third-party deps.

## Risks & Mitigations

- **Risk**: User pastes a key with whitespace/newlines from clipboard. **Mitigation**: `setCodexApiKey` and the IPC handler both `.trim()` before storing.
- **Risk**: `testConnection` spawns a real `codex app-server` and could hang on auth, leaving an orphaned child. **Mitigation**: hard 15 s timeout that calls `backend.stop()` (which already does SIGTERM → SIGKILL).
- **Risk**: Two settings pages open in different windows desync. **Mitigation**: out of scope — only one window in this app today.
- **Risk**: Reading the JSON file synchronously at AgentManager construction blocks startup. **Mitigation**: file is < 200 bytes, sync I/O is acceptable. If profiling later flags it, move to lazy-on-first-use.
- **Risk**: Key leaked in error messages or logs. **Mitigation**: never log the key. `testConnection` errors only log the underlying message (e.g. "401 Unauthorized") not the key.

## Out of Scope (Followups)

- ChatGPT login flow.
- Per-site Codex key (currently OpenAI is fixed).
- Encrypted-at-rest storage (use OS keychain via `keytar`-style integration).
- Showing the masked tail of the saved key in settings (e.g. `sk-...abc1`) for confirmation.

## Verification Checklist

- [ ] Save a key → restart app → key still loaded (renderer + main both read their stores).
- [ ] Click 测试连接 with valid key → toast "连接成功" within ~3 s.
- [ ] Click 测试连接 with empty key → toast "请先输入 API Key" without spawn.
- [ ] Click 测试连接 with bad key → toast "连接失败: 401 ..." within ~5 s, no orphaned process.
- [ ] Open chat panel with empty key → send prompt → red error bubble immediately, no spawn.
- [ ] Open chat panel with saved key → send prompt → reply streams.
- [ ] All existing tests still pass (`npx vitest run src/main/agent src/renderer/src/features/agent-chat src/renderer/src/stores --pool=threads`).
