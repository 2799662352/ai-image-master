# Implementation Plan: Codex Agent API Key in Settings

**Spec:** `docs/superpowers/specs/2026-05-07-codex-api-key-settings-design.md`
**Branch:** `feature/codex-agent-mvp`
**Approach:** TDD-style, six tasks. Each task ends with a focused `vitest` run + commit. The frozen helpers (`codexProtocol.ts`, `codexLaunch.ts`, `connectWithRetry.ts`, `codexUserInput.ts`) stay frozen.

---

## Task A: Renderer persistence — `useSettingsStore` codexApiKey slot

**Files:**
- `src/renderer/src/stores/useSettingsStore.ts` (modify)
- `src/renderer/src/stores/__tests__/useSettingsStore.test.ts` (modify or create)

**Steps (TDD):**

1. Read `useSettingsStore.test.ts` if it exists. Add a failing test:
   - "loads codexApiKey from localStorage on loadFromService"
   - "setCodexApiKey updates the store"
   - "saveAll writes codexApiKey to localStorage" (use vi-mocked localStorage or jsdom default)
2. Run vitest, confirm failure.
3. Modify `useSettingsStore.ts`:
   - Add field `codexApiKey: string` (default `''`).
   - Add action `setCodexApiKey(key: string): void` → trims and sets.
   - In `loadFromService`, also load `localStorage.getItem('codex_api_key') ?? ''`.
   - In `saveAll`, also write `localStorage.setItem('codex_api_key', get().codexApiKey)`.
   - Do NOT touch the existing `apiKey`, `visionApiKey`, site logic.
4. Run vitest, confirm green.
5. Commit: `feat(settings): persist codexApiKey to localStorage`

**Acceptance:** test count goes up by 3, all green. `git status` clean.

---

## Task B: Main-side env injection in `CodexLocalBackend`

**Files:**
- `src/main/agent/CodexLocalBackend.ts` (modify)
- `src/main/agent/__tests__/CodexLocalBackend.test.ts` (modify)

**Steps (TDD):**

1. Read the existing `CodexLocalBackend.test.ts` and find the `wsUrl`-based fake server suite. Add two failing tests:
   - "spawn env contains OPENAI_API_KEY when getApiKey returns a value"
   - "spawn env omits OPENAI_API_KEY when getApiKey returns undefined or empty"
   These tests need a way to inspect what `spawn` was called with. Two options:
     - **Option B1**: Inject a `spawnFactory?: (bin, args, opts) => ChildProcess` constructor option (defaulting to Node's `child_process.spawn`). Tests pass a fake that records the env arg and returns a stub `ChildProcess` (an `EventEmitter` with `.stdout`/`.stderr`/`.kill` shims).
     - **Option B2**: Use `vi.mock('node:child_process')`.
   - Pick **Option B1** (cleaner, matches the existing `wsUrl` injection pattern). Pair the spawn factory with a fake that ALSO connects a fake `WebSocketServer` so `start()` can finish initialize.
2. Run vitest, confirm failure (tests reference `getApiKey` / `spawnFactory` options that don't exist yet).
3. Modify `CodexLocalBackend.ts`:
   - Extend `CodexLocalBackendOptions` with `getApiKey?: () => string | undefined` and `spawnFactory?: typeof spawn`.
   - In `start()`, when not in `wsUrl` override mode:
     - Resolve api key via `this.options.getApiKey?.()?.trim() ?? ''`.
     - Build env: `const env = { ...process.env }; if (apiKey) env.OPENAI_API_KEY = apiKey`.
     - Use `(this.options.spawnFactory ?? spawn)(bin, args, { stdio: [...], env })`.
4. Run vitest on `src/main/agent`, confirm 31 + 2 = 33 tests pass.
5. Commit: `feat(agent): inject OPENAI_API_KEY into Codex spawn env`

**Acceptance:** new tests green; existing 31 still green; `isHealthy()` and protocol tests untouched.

---

## Task C: Persisted `codexApiKey` in `AgentManager` + empty-key gate

**Files:**
- `src/main/agent/AgentManager.ts` (modify)
- `src/main/agent/__tests__/AgentManager.test.ts` (create OR extend if exists)

**Steps (TDD):**

1. Locate AgentManager's `sendMessage` (or whatever method handles `agent:send-message`). Read its current body.
2. Write failing tests:
   - "loadCodexApiKey reads `<userData>/codex-agent.json` if present" — use a tmp dir for `userData`.
   - "setCodexApiKey persists to disk and updates cache"
   - "sendMessage with empty codexApiKey emits an error event and does not spawn backend"
   - "sendMessage with non-empty codexApiKey calls backend.start (or whatever the existing flow is)"
3. Run vitest, confirm failure.
4. Modify `AgentManager.ts`:
   - Constructor takes `userDataDir: string` (or read from `app.getPath('userData')` lazily — tests can inject via constructor option).
   - Add private `codexApiKey: string`, loaded from `<userDataDir>/codex-agent.json` synchronously on construction (file may not exist → empty string).
   - `getCodexApiKey(): string`
   - `setCodexApiKey(key: string): Promise<void>` — atomic write (`writeFile` to `.tmp` then `rename`), updates cache.
   - In `sendMessage`: if `getCodexApiKey()` is empty, emit a single `{ type: 'error', threadId, error: '请在设置页填写 Codex Agent API Key' }` event via the existing event channel and return immediately. Do NOT call `backend.start()`.
   - Pass `getApiKey: () => this.getCodexApiKey()` when constructing `CodexLocalBackend`.
5. Run vitest, confirm green.
6. Commit: `feat(agent): persist Codex key + block sendMessage when missing`

**Acceptance:** new AgentManager tests pass, existing tests unaffected, IPC contract preserved.

---

## Task D: IPC channels + preload exposure

**Files:**
- `src/main/index.ts` (modify) — register `agent:set-api-key` + `agent:test-connection`
- `src/preload/index.ts` (modify) — expose `agent.setApiKey(key)` + `agent.testConnection()`
- `src/types/agent.ts` or wherever `ElectronAPI`/`agent` types live (modify) — add signatures
- `src/main/agent/AgentManager.ts` — add `testConnection()` method

**Steps:**

1. Find the existing IPC handler block in `src/main/index.ts`. Confirm pattern (`ipcMain.handle('agent:send-message', ...)` etc.).
2. Add handler for `agent:set-api-key`: `(_, key: string) => agentManager.setCodexApiKey(key).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }))`.
3. Add handler for `agent:test-connection`: calls `agentManager.testConnection()`.
4. Implement `AgentManager.testConnection(): Promise<{ ok: boolean; error?: string }>`:
   - Build a temporary `CodexLocalBackend` with `getApiKey: () => this.getCodexApiKey()`.
   - Race `backend.start()` against a 15 s timeout. If start resolves, immediately call `backend.stop()` and return `{ ok: true }`.
   - Catch all errors → `{ ok: false, error: err.message }`. Always call `backend.stop()` in finally.
5. Find preload script (`src/preload/index.ts` or similar). Add to the `agent` object:
   ```ts
   setApiKey: (key: string) => ipcRenderer.invoke('agent:set-api-key', key),
   testConnection: () => ipcRenderer.invoke('agent:test-connection'),
   ```
6. Update the `ElectronAPI` agent type with the two new signatures.
7. No new tests for IPC plumbing per se (existing `ipc.test.ts` covers the shape) — just confirm typecheck passes on the modified files.
8. Commit: `feat(agent): IPC for setApiKey + testConnection`

**Acceptance:** `npx tsc --noEmit` introduces no new errors in changed files. `npx vitest run src/main/agent --pool=threads` still green.

---

## Task E: Settings UI section + Test Connection button

**Files:**
- `src/renderer/src/pages-react/SettingsPage.tsx` (modify)

**Steps:**

1. Add a new `<section>` between the "图像理解 API Key" section and "界面偏好" section (so it lives just above `</TencentCloudSection>` placement in JSX flow).
2. Section structure:
   ```tsx
   <section className="space-y-3 pt-4 border-t border-zinc-700">
     <div className="flex items-center gap-2">
       <span className="w-6 h-6 bg-cyberpunk-yellow ...">🤖</span>
       <span className="font-bold ...">CODEX AGENT API KEY</span>
     </div>
     <p className="text-xs text-zinc-500">用于 AI Agent (Ctrl+Shift+A)。需要 OpenAI 直连 sk- key</p>
     <ApiKeyInput value={codexApiKey} onChange={setCodexApiKey} placeholder="sk-..." />
     <button
       onClick={handleTestCodex}
       disabled={!codexApiKey.trim() || testingCodex}
       className="..."
     >
       {testingCodex ? '测试中...' : '🔌 测试连接'}
     </button>
   </section>
   ```
3. Add hook state inside component: `const [testingCodex, setTestingCodex] = useState(false)`.
4. Read codexApiKey from `useSettingsStore`.
5. `handleTestCodex`:
   ```ts
   const handleTestCodex = async () => {
     setTestingCodex(true)
     try {
       const result = await (window as any).electronAPI?.agent?.testConnection?.()
       if (result?.ok) addToast({ message: 'Codex 连接成功', type: 'success' })
       else addToast({ message: `Codex 连接失败: ${result?.error ?? '未知错误'}`, type: 'error' })
     } catch (e: any) {
       addToast({ message: `Codex 连接失败: ${e?.message ?? e}`, type: 'error' })
     } finally {
       setTestingCodex(false)
     }
   }
   ```
6. Modify the existing `handleSave` to also call `(window as any).electronAPI?.agent?.setApiKey?.(codexApiKey)` after `saveAll(api)`. Wrap in try-catch — if it fails (e.g. preload not exposing yet), continue (save still succeeds for image-gen keys).
7. No new test (UI is wired, persistence already tested in Task A).
8. Commit: `feat(settings): add Codex Agent API Key section + test connection`

**Acceptance:** `npx tsc --noEmit` clean for changed files. App launches manually (Task F).

---

## Task F: Final verification sweep

**Steps:**

1. Run `npx vitest run src/main/agent src/renderer/src/features/agent-chat src/renderer/src/stores --pool=threads`. Confirm all green.
2. Run `npx tsc --noEmit -p tsconfig.json` — diff baseline noise vs current. Flag any NEW errors in files touched by Tasks A-E.
3. Run `npm run codex:probe` (if user provides API key) — optional manual check.
4. Manual checklist (user runs `npm run dev`):
   - [ ] Settings page shows new "CODEX AGENT API KEY" section.
   - [ ] Empty key + send agent message → red error bubble "请在设置页填写..."
   - [ ] Pasted invalid key + 测试连接 → toast "Codex 连接失败: ..."
   - [ ] Pasted valid key + 测试连接 → toast "Codex 连接成功"
   - [ ] Save key + restart app → key persists in both places.
   - [ ] Saved key + agent send → reply streams correctly.
5. Commit empty: `chore(agent): record Codex key settings verification` only after manual checks pass.

**Acceptance:** all automated tests green; manual checklist green or each red item documented.

---

## Execution Notes

- **Task ordering matters**: A → B → C → D → E → F. Each task builds on the previous.
- **Branch state**: HEAD is `ed6875f` (the spec commit). Each task adds 1 commit.
- **Test pool**: always `--pool=threads` to avoid the worker-fork timeout on Windows.
- **Self-review checks**: after each task, also `ReadLints` on the modified files to catch ESLint issues.
- **Rollback unit**: any single task's commit is independently revertable — they're not coupled.
