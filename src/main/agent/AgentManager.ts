import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import { CodexLocalBackend } from './CodexLocalBackend'
import { CodexProviderStore, type NewCustomProvider } from './CodexProviderStore'
import { DEFAULT_CODEX_SESSION_CONFIG } from './codexLaunch'
import {
  BUILTIN_PROVIDER_PRESETS,
  DEFAULT_PROVIDER_ID,
  isBuiltinProviderId,
  resolveActiveProvider,
  type ProviderPreset,
} from './codexProviders'
import { getDockerMcpGatewayService, type CheckInstalledResult, type GatewayStatus } from './dockerMcpGateway'
import {
  GATEWAY_DEFAULT_PORT,
  GATEWAY_PROFILE_NAME,
  GATEWAY_SERVER_NAME,
  buildGatewayConfigEntry,
  selectDockerStdioEntries,
} from './dockerMcpFix'
import {
  deleteSkill,
  getSkillDetail,
  listSkills,
  readAuditLog,
  resolveWorkspacePaths,
  saveSkill,
} from './codexConfigStore'
import { discoverCodexSkills, readMcpSummary, readRawCodexConfig } from './codexConfigDiscovery'
import { mapReferencesToInputItems } from './codexUserInput'
import { validateSessionConfigPatch } from './sessionConfigValidation'
import type { BrowserWindow } from 'electron'
import type {
  AgentSendMessagePayload,
  AgentSendMessageResult,
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexMcpSummary,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexSkillInput,
  CodexSkillsSummary,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
  ItemDeltaPatch,
} from '../../types/agent'
import type { AttachmentRef, TimelineItem } from '../../types/agent-timeline'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
import type { AgentInput, IAgentBackend, ListThreadsParams } from './types'
import type { DoctorReport } from './codexDoctor'
import { ThreadTitleSummarizer } from './ThreadTitleSummarizer'
import { setFsAllowedRoots } from '../file-explorer/fsIpc'

const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'

/**
 * Default Codex agent model used by the ThreadTitleSummarizer (and as the
 * fallback model id when a provider preset doesn't pin its own). `gpt-5.5`
 * ships full Responses-API tool support including the native `web_search`
 * tool that Codex 0.128 `app-server` registers by default. Keep in sync with
 * the renderer-side `DEFAULT_MODEL_ID` in
 * `src/renderer/src/features/agent-chat/models.ts`.
 *
 * Provider-specific defaults (e.g. Right.Codes' `gpt-5.2` + `xhigh`) live in
 * `codexProviders.ts:BUILTIN_PROVIDER_PRESETS` and are wired through
 * `appendProviderArgs` — this constant is the renderer-facing fallback only.
 */
const DEFAULT_AGENT_MODEL = 'gpt-5.5'

/**
 * Subset of `AgentAttachment` (Prisma row) we need to format the prompt
 * preamble. Declared as a structural shape so tests don't have to drag in
 * the full Prisma type — the runtime data has the same field names.
 */
interface PromptAttachment {
  originalName: string
  localPath: string
  mime: string
  size: number
}

/**
 * Prepend a one-shot "[Attached files at these local paths:]" block to the
 * user's prompt when there are attachments. Without this the agent has no
 * idea where the uploaded files live (the renderer file-picker only gives
 * us a buffer; the on-disk path under `userData/agent/uploads/<sha>.<ext>`
 * is invisible to the model unless we say it explicitly).
 *
 * Behaviour:
 *  - Empty attachment list → returns `content` unchanged (no surprise
 *    bytes inflating input tokens for trivial messages).
 *  - With attachments → prepends a compact, machine-readable list with
 *    `localPath`, mime, size, and original name for each, then a blank
 *    line, then the original user content. Order matches the order the
 *    renderer sent the attachments in.
 *
 * Exported for unit tests and so a future `tools/list_attachments` MCP
 * shim can reuse the same formatting if we ever add one.
 */
export function buildPromptWithAttachments(
  content: string,
  attachments: ReadonlyArray<PromptAttachment>,
): string {
  if (attachments.length === 0) return content
  const lines = attachments.map(
    (a) => `- ${a.localPath}  (${a.mime}, ${a.size} bytes, original: ${a.originalName})`,
  )
  return `[Attached files at these local paths:\n${lines.join('\n')}]\n\n${content}`
}

function buildPromptWithReferenceMentions(content: string, mentions: readonly string[]): string {
  if (mentions.length === 0) return content
  return `[Referenced files at these local paths:\n- ${mentions.join('\n- ')}]\n\n${content}`
}

function mapDuplicateAttachmentReferencesToUploadedPaths(
  items: AgentInput['items'],
  attachmentInputs: ReadonlyArray<AgentSendMessagePayload['attachments'][number]>,
  savedAttachments: ReadonlyArray<PromptAttachment>,
): AgentInput['items'] {
  const uploadedPathByOriginalPath = new Map<string, string>()
  attachmentInputs.forEach((attachment, index) => {
    if (!attachment.path) return
    const saved = savedAttachments[index]
    if (!saved || !saved.mime.startsWith('image/')) return
    if (attachment.name !== saved.originalName || attachment.mime !== saved.mime) return
    uploadedPathByOriginalPath.set(path.resolve(attachment.path), saved.localPath)
  })

  if (uploadedPathByOriginalPath.size === 0) return items
  return items.map((item) => {
    if (item.type !== 'localImage') return item
    return {
      ...item,
      path: uploadedPathByOriginalPath.get(path.resolve(item.path)) ?? item.path,
    }
  })
}

export interface AgentManagerOptions {
  /** Directory used to persist the Codex API key JSON. Inject in tests. */
  userDataDir: string
  /** Window used as the default destination for `agent:event` broadcasts. */
  win?: BrowserWindow
  /** Persistence layer for threads/messages. Required for full sendMessage flow. */
  store?: ThreadStore
  /** Attachment ingest pipeline. Required for full sendMessage flow. */
  attachments?: AttachmentService
  /**
   * Test seam for receiving `AgentStreamEvent`s instead of broadcasting to a
   * BrowserWindow. When omitted, events are sent to `win.webContents` (if
   * present and not destroyed).
   */
  eventSink?: (event: AgentStreamEvent) => void
  /**
   * Test seam for injecting a fake backend. When omitted, a real
   * `CodexLocalBackend` is constructed.
   */
  backend?: IAgentBackend
  /**
   * Local catimation MCP server coordinates ({ port, token }) produced by
   * `startCatimationMcpServer`. Forwarded to the default `CodexLocalBackend`
   * so the spawned Codex subprocess can reach our in-app `generate_image`
   * tool. Omitted when the local MCP listener failed to bind.
   */
  mcpRuntime?: { port: number; token: string }
}

export class AgentManager {
  private backend: IAgentBackend
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly userDataDir: string
  private readonly providerStore: CodexProviderStore
  private activeProviderId: string
  private codexApiKey = ''
  private summarizer?: ThreadTitleSummarizer
  private sessionConfig: CodexSessionConfig = { ...DEFAULT_CODEX_SESSION_CONFIG }
  private allowedRoots: string[] = [...DEFAULT_CODEX_SESSION_CONFIG.writableRoots]
  private readonly firstTurnDoneByThread = new Map<string, boolean>()
  /**
   * Maps our DB thread row id (a Prisma CUID like `cm6abc...`) to the
   * Codex-protocol thread id (a UUID like `urn:uuid:...` returned by
   * `thread/start`). Codex's app-server validates wire ids as UUIDs, so we
   * must never leak DB cuids into `turn/start`. Mapping is in-memory only;
   * an app restart resets it (acceptable for MVP, since Codex itself doesn't
   * resume threads across app-server lifetimes).
   */
  private readonly codexThreadIdByDbThreadId = new Map<string, string>()

  /**
   * Latest status emitted per MCP server name. Populated by
   * `mcp_status_updated` notifications from codex. The renderer pulls this
   * snapshot via `getMcpStatusSnapshotRpc` on subscribe, so dots stay correct
   * even when notifications fired before the MCP page mounted (or before the
   * renderer subscribed at all).
   */
  private readonly mcpStatusByName = new Map<string, { status: string; error: string | null }>()

  constructor(opts: AgentManagerOptions) {
    this.win = opts.win
    this.store = opts.store
    this.attachments = opts.attachments
    this.eventSink = opts.eventSink
    this.userDataDir = opts.userDataDir
    this.providerStore = new CodexProviderStore({ userDataDir: opts.userDataDir })
    const persisted = this.providerStore.loadSync()
    this.activeProviderId = persisted.selectedProviderId
    this.codexApiKey = persisted.apiKeys[this.activeProviderId] ?? ''
    const activeProvider = resolveActiveProvider(this.activeProviderId, persisted.customProviders)
    this.backend = opts.backend ?? new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      provider: activeProvider,
      sessionConfig: this.sessionConfig,
      catimationMcp: opts.mcpRuntime,
      onApprovalRequest: (request) => this.emitApprovalRequest(request),
      onMcpNotification: (event) => this.handleMcpNotification(event),
    })
    if (this.store) {
      this.summarizer = new ThreadTitleSummarizer(this.store, this.backend, DEFAULT_AGENT_MODEL)
    }
    // Kick off async legacy migration in the background — the sync load above
    // already covered the v4.3 file; this finishes the codex-agent.json →
    // codex-providers.json one-way migration the first time the manager
    // boots after upgrade. Failures are best-effort: the worst case is the
    // user re-types their key once.
    void this.providerStore.load().catch(() => {})
  }

  /**
   * Test seam: when callers inject a custom backend via `opts.backend` they
   * miss the `onMcpNotification` plumbing the default factory wires. Calling
   * this method lets a test re-attach the same handler to the injected
   * backend's `onMcpNotification` registration hook.
   */
  attachMcpNotificationHandler(): void {
    const b = this.backend as { onMcpNotification?: (handler: (e: AgentStreamEvent) => void) => void }
    if (typeof b.onMcpNotification === 'function') {
      b.onMcpNotification((event) => this.handleMcpNotification(event))
    }
  }

  private handleMcpNotification(event: AgentStreamEvent): void {
    if (event && (event as any).type === 'mcp_status_updated') {
      const e = event as any
      if (typeof e.name === 'string') {
        this.mcpStatusByName.set(e.name, {
          status: String(e.status ?? 'unknown'),
          error: e.error ?? null,
        })
      }
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:mcp-status', event)
  }

  getMcpStatusSnapshotRpc(): {
    ok: true
    snapshot: Record<string, { status: string; error: string | null }>
  } {
    const snapshot: Record<string, { status: string; error: string | null }> = {}
    for (const [name, value] of this.mcpStatusByName) {
      snapshot[name] = { status: value.status, error: value.error }
    }
    return { ok: true, snapshot }
  }

  private workspacePaths(): CodexWorkspacePaths {
    const home = os.homedir()
    return resolveWorkspacePaths({
      home,
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      userData: this.userDataDir,
      // `app` may be `undefined` in vitest contexts that don't mock electron;
      // we treat that case as "not packaged" so system-scope skill discovery
      // simply skips, matching the dev-mode runtime behaviour.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
      // Surface legacy USER-scope skill locations so `listSkills` finds:
      //   - skills written by this app's legacy `save-skill` IPC and
      //     "打开 Skills 文件夹" button (<userData>/skills) — this is where
      //     AI-created skills currently land.
      //   - the Codex CLI legacy USER path (~/.codex/skills), still loaded
      //     by the official CLI per openai/codex#14337.
      legacyUserSkillsRoots: [
        path.join(this.userDataDir, 'skills'),
        path.join(home, '.codex', 'skills'),
      ],
    })
  }

  private async applyMcpConfigChange(paths: CodexWorkspacePaths): Promise<void> {
    if (!this.backend.applyConfigChange) {
      throw new Error('Codex config refresh API is unavailable')
    }
    await this.backend.applyConfigChange(paths)
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  getCodexApiKey(): string {
    return this.codexApiKey
  }

  /**
   * Sets the API key for the *currently active* provider. Preserved as the
   * IPC `agent:set-api-key` entry-point to keep the v4.2 settings UI
   * working — new code paths should prefer `setProviderApiKey(id, key)`.
   */
  async setCodexApiKey(key: string): Promise<void> {
    await this.setProviderApiKey(this.activeProviderId, key)
  }

  // ---------------------------------------------------------------------
  // Codex provider management (v4.3+)
  // ---------------------------------------------------------------------

  /**
   * Returns the snapshot used by the Settings page: builtin presets, custom
   * providers, the active id, and the per-provider api keys (so the UI can
   * prefill input fields without a second roundtrip). Keys are returned
   * verbatim — callers that render them in the DOM should mask them via
   * the existing `<ApiKeyInput showToggle>` component.
   */
  async getProvidersSnapshot(): Promise<{
    builtins: ProviderPreset[]
    custom: ProviderPreset[]
    activeId: string
    apiKeys: Record<string, string>
  }> {
    const persisted = await this.providerStore.load()
    return {
      builtins: BUILTIN_PROVIDER_PRESETS.map((p) => ({ ...p })),
      custom: persisted.customProviders.map((p) => ({ ...p })),
      activeId: persisted.selectedProviderId,
      apiKeys: { ...persisted.apiKeys },
    }
  }

  async setActiveProvider(id: string): Promise<{ ok: true; activeId: string }> {
    const persisted = await this.providerStore.load()
    const provider = resolveActiveProvider(id, persisted.customProviders)
    // resolveActiveProvider falls back to the apiyi preset when the id is
    // unknown — surface that as an explicit error so UI bugs don't silently
    // pin the user to an unintended provider.
    if (provider.id !== id) {
      throw new Error(`Unknown Codex provider id "${id}"`)
    }
    await this.providerStore.setSelectedId(id)
    this.activeProviderId = id
    this.codexApiKey = persisted.apiKeys[id] ?? ''
    this.backend.setProvider?.(provider)
    // Restart codex so the new base_url + model take effect immediately
    // instead of waiting for the next user message. We swallow restart
    // errors here — the renderer has already updated its state and a
    // failed restart will surface as the next message timing out, which is
    // less confusing than the settings save throwing.
    if (this.backend.restartCodex) {
      try {
        await this.backend.restartCodex(this.workspacePaths())
      } catch (err) {
        console.warn('[AgentManager] restartCodex after setActiveProvider failed:', err)
      }
    }
    return { ok: true, activeId: id }
  }

  async setProviderApiKey(id: string, key: string): Promise<{ ok: true }> {
    await this.providerStore.setApiKey(id, key)
    if (id === this.activeProviderId) {
      this.codexApiKey = (key ?? '').trim()
    }
    return { ok: true }
  }

  async addCustomProvider(input: NewCustomProvider): Promise<ProviderPreset> {
    const trimmedName = input.name?.trim() ?? ''
    if (!trimmedName) throw new Error('Provider name is required')
    try {
      new URL(input.baseUrl)
    } catch {
      throw new Error('Provider baseUrl must be a valid URL')
    }
    return this.providerStore.addCustomProvider({ ...input, name: trimmedName })
  }

  async updateCustomProvider(
    id: string,
    patch: Partial<Omit<ProviderPreset, 'id' | 'isCustom'>>,
  ): Promise<{ ok: true }> {
    if (isBuiltinProviderId(id)) throw new Error('Cannot update builtin provider')
    if (patch.baseUrl !== undefined) {
      try {
        new URL(patch.baseUrl)
      } catch {
        throw new Error('Provider baseUrl must be a valid URL')
      }
    }
    await this.providerStore.updateCustomProvider(id, patch)
    if (id === this.activeProviderId) {
      // Re-resolve the active provider with the patched data and restart so
      // the new model / baseUrl reaches Codex without an app reload.
      const persisted = await this.providerStore.load()
      const refreshed = resolveActiveProvider(id, persisted.customProviders)
      this.backend.setProvider?.(refreshed)
      if (this.backend.restartCodex) {
        try {
          await this.backend.restartCodex(this.workspacePaths())
        } catch (err) {
          console.warn('[AgentManager] restartCodex after updateCustomProvider failed:', err)
        }
      }
    }
    return { ok: true }
  }

  async removeCustomProvider(id: string): Promise<{ ok: true; activeId: string }> {
    if (isBuiltinProviderId(id)) throw new Error('Cannot remove builtin provider')
    await this.providerStore.removeCustomProvider(id)
    const persisted = await this.providerStore.load()
    // If the removed provider was active, the store has already reverted to
    // DEFAULT_PROVIDER_ID. Mirror that into the in-memory state and respawn
    // codex so traffic doesn't keep flowing to a now-unknown gateway.
    if (this.activeProviderId === id) {
      this.activeProviderId = persisted.selectedProviderId
      this.codexApiKey = persisted.apiKeys[this.activeProviderId] ?? ''
      const provider = resolveActiveProvider(this.activeProviderId, persisted.customProviders)
      this.backend.setProvider?.(provider)
      if (this.backend.restartCodex) {
        try {
          await this.backend.restartCodex(this.workspacePaths())
        } catch (err) {
          console.warn('[AgentManager] restartCodex after removeCustomProvider failed:', err)
        }
      }
    }
    return { ok: true, activeId: this.activeProviderId }
  }

  async setAllowedRoots(roots: unknown): Promise<string[]> {
    if (!Array.isArray(roots)) return [...this.sessionConfig.writableRoots]

    const validated: string[] = []
    for (const candidate of roots) {
      if (typeof candidate !== 'string') continue
      const resolved = path.resolve(candidate)
      if (!path.isAbsolute(resolved)) continue
      try {
        const stat = await fs.stat(resolved)
        if (stat.isDirectory()) validated.push(resolved)
      } catch {
        // Ignore stale workspace roots.
      }
    }

    this.allowedRoots = [...validated]
    this.sessionConfig = { ...this.sessionConfig, writableRoots: [...validated] }
    this.backend.setSessionConfig?.({ writableRoots: [...validated] })
    setFsAllowedRoots(validated)
    return [...validated]
  }

  async setSessionConfigPatch(input: unknown): Promise<CodexSessionStatus> {
    const patch = validateSessionConfigPatch(input, this.allowedRoots)
    await this.confirmUnsafeSessionConfigChange(patch)
    this.sessionConfig = {
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    }
    this.backend.setSessionConfig?.(patch)
    return this.getSessionStatus()
  }

  getSessionStatus(model: string = DEFAULT_AGENT_MODEL): CodexSessionStatus {
    return {
      model,
      sandboxMode: this.sessionConfig.sandboxMode,
      approvalPolicy: this.sessionConfig.approvalPolicy,
      webSearch: this.sessionConfig.webSearch,
      writableRoots: [...this.sessionConfig.writableRoots],
    }
  }

  async getMcpSummary(): Promise<CodexMcpSummary> {
    return readMcpSummary(path.join(os.homedir(), '.codex', 'config.toml'))
  }

  async getSkillsSummary(): Promise<CodexSkillsSummary> {
    const home = os.homedir()
    return discoverCodexSkills({
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      home,
      // Same defensive guard as `workspacePaths()` — see note there.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
      // Mirror `workspacePaths().legacyUserSkillsRoots` so the `/` palette
      // and `$skill` popup see the same USER-scope inventory the
      // SkillsSection panel does. Without this, AI-created skills under
      // `<userData>/skills` (e.g. catimation-cyberpunk-master) and Codex
      // CLI legacy `$HOME/.codex/skills` entries surface in the side panel
      // but stay invisible in the chat command palette.
      legacyUserSkillsRoots: [
        path.join(this.userDataDir, 'skills'),
        path.join(home, '.codex', 'skills'),
      ],
    })
  }

  async listSkills() {
    return listSkills(this.workspacePaths())
  }

  async getSkillDetail(id: string) {
    return getSkillDetail(this.workspacePaths(), id)
  }

  async saveSkill(input: CodexSkillInput) {
    return saveSkill(this.workspacePaths(), input)
  }

  async deleteSkill(id: string) {
    return deleteSkill(this.workspacePaths(), id)
  }

  /**
   * Reveals a scope-specific skills root in the OS file browser. Unlike the
   * legacy `open-skills-folder` IPC (which always opens `<userData>/skills`),
   * this routes by scope so the side panel can give each group header its
   * own "open" button:
   *   - `repo`   → workspace `.agents/skills`
   *   - `user`   → `$HOME/.agents/skills` (the official Codex USER path)
   *   - `system` → packaged installer skills (read-only)
   *
   * Ensures the directory exists before opening so first-time users don't
   * hit a "folder not found" toast on a fresh checkout.
   */
  async openSkillsRoot(
    scope: 'repo' | 'user' | 'system',
  ): Promise<{ ok: true; path: string } | { ok: false; error: string; path?: string }> {
    const paths = this.workspacePaths()
    let target: string | undefined
    switch (scope) {
      case 'repo':
        target = paths.workspaceSkillsRoot
        break
      case 'user':
        target = paths.personalSkillsRoot
        break
      case 'system':
        target = paths.systemSkillsRoot
        break
      default: {
        const _exhaustive: never = scope
        return { ok: false, error: `Unknown scope: ${String(_exhaustive)}` }
      }
    }
    if (!target) return { ok: false, error: `No path resolved for scope ${scope}` }

    try {
      // Read-only SYSTEM skills are bundled with the installer; skipping
      // `mkdir` avoids EPERM noise on packaged builds.
      if (scope !== 'system') {
        await fs.mkdir(target, { recursive: true })
      }
      const errorMessage = await shell.openPath(target)
      if (errorMessage) return { ok: false, error: errorMessage, path: target }
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), path: target }
    }
  }

  async getWorkspaceLogs(opts?: { limit?: number; sinceIso?: string }) {
    return readAuditLog(this.workspacePaths().auditLogPath, opts ?? {})
  }

  async restartCodex() {
    if (!this.backend.restartCodex) throw new Error('Codex restart API is unavailable')
    return this.backend.restartCodex(this.workspacePaths())
  }

  async listMcpServersRpc(params?: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      if (!this.backend.listMcpServers) throw new Error('MCP list API unavailable')
      const result = await this.backend.listMcpServers(params)
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async batchWriteConfigRpc(edits: unknown[], reload?: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.batchWriteConfig) throw new Error('MCP batch write API unavailable')
      await this.backend.batchWriteConfig(edits, reload)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async writeConfigValueRpc(keyPath: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.writeConfigValue) throw new Error('MCP write value API unavailable')
      await this.backend.writeConfigValue(keyPath, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readConfigRpc(): Promise<{ ok: boolean; error?: string; config?: unknown }> {
    try {
      if (!this.backend.readConfig) throw new Error('MCP read config API unavailable')
      const result = await this.backend.readConfig()
      return { ok: true, config: result?.config }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Read `~/.codex/config.toml` directly (bypasses codex's strict schema).
   *
   * Why this exists separately from `readConfigRpc`:
   *   The Rust `config/read` RPC rejects the entire request if any
   *   `[mcp_servers.X]` block fails validation (e.g. unknown `transport`
   *   value). The renderer must still be able to enumerate and EDIT the
   *   broken section to fix it — without this RPC the MCP page is a dead
   *   end whenever codex's parser tightens. We deliberately surface
   *   whatever TOML the user has on disk, even when codex would reject it.
   */
  async readRawConfigRpc(): Promise<{
    ok: boolean
    error?: string
    config?: Record<string, unknown> | null
    raw?: string | null
    parseError?: string
  }> {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml')
      const result = await readRawCodexConfig(configPath)
      return {
        ok: true,
        config: result.config,
        raw: result.raw,
        parseError: result.parseError,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async reloadMcpServersRpc(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.backend.reloadMcpServers) throw new Error('MCP reload API unavailable')
      await this.backend.reloadMcpServers()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async mcpOAuthLoginRpc(name: string): Promise<{ ok: boolean; error?: string; authorization_url?: string }> {
    try {
      if (!this.backend.mcpOAuthLogin) throw new Error('MCP OAuth API unavailable')
      const result = await this.backend.mcpOAuthLogin(name)
      return { ok: true, authorization_url: result?.authorization_url }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---- Docker MCP Gateway workaround for Codex bug #19425 ----
  // See ./dockerMcpGateway.ts for the full rationale. Renderer calls
  // `dockerGatewayCheck` to gate the "Fix" button, then `dockerGatewayFix`
  // to actually convert + start. Status/stop are exposed for diagnostics.

  async dockerGatewayCheckRpc(): Promise<CheckInstalledResult> {
    return getDockerMcpGatewayService().checkInstalled()
  }

  async dockerGatewayStatusRpc(): Promise<GatewayStatus> {
    return getDockerMcpGatewayService().getStatus()
  }

  async dockerGatewayStopRpc(): Promise<{ ok: boolean; error?: string }> {
    try {
      await getDockerMcpGatewayService().stop()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * One-shot orchestration for the renderer's "一键修复" button. Choreography:
   *   1. Verify `docker mcp` is installed.
   *   2. Read current Codex config; pick out docker-run-based MCP entries.
   *   3. Build a fresh gateway profile containing those images.
   *   4. Spawn the gateway in HTTP/SSE mode on `port` (or default 8811).
   *   5. Replace the docker entries in `mcp_servers` with a single
   *      `[mcp_servers.docker_gw] url = "http://127.0.0.1:<port>/sse"` entry,
   *      then ask Codex to reload its MCP layer.
   *
   * Idempotent — running it again rebuilds the profile from the current set
   * and restarts the gateway. Failures partway through leave config alone:
   * we only mutate `mcp_servers` once we have a healthy gateway.
   */
  async dockerGatewayFixRpc(opts?: { port?: number }): Promise<{
    ok: boolean
    error?: string
    converted?: string[]
    gatewayPort?: number
  }> {
    const port = opts?.port ?? GATEWAY_DEFAULT_PORT
    const svc = getDockerMcpGatewayService()
    try {
      const check = await svc.checkInstalled()
      if (!check.installed) {
        return {
          ok: false,
          error: check.error ?? 'docker mcp 未安装。请先安装 Docker Desktop 4.59+ 或手动安装 docker-mcp CLI plugin。',
        }
      }

      if (!this.backend.readConfig) throw new Error('MCP read config API unavailable')
      if (!this.backend.batchWriteConfig) throw new Error('MCP batch write API unavailable')
      const cfg = await this.backend.readConfig()
      const mcpServers = (cfg?.config as any)?.mcp_servers ?? {}
      const dockerEntries = selectDockerStdioEntries(mcpServers)
      if (dockerEntries.length === 0) {
        return { ok: false, error: '没有找到需要修复的 docker MCP 服务器。' }
      }

      // Build a fresh profile from the current docker entries. We always
      // rebuild rather than diff -- profile lifetime is owned by us, so
      // rebuilding is cheap and avoids stale entries from previous runs.
      const images = Array.from(new Set(dockerEntries.map((e) => e.image)))
      await svc.addServersToProfile(GATEWAY_PROFILE_NAME, images).catch((err) => {
        // Profile may already exist from a previous run -- we don't have
        // a non-destructive update path in `docker mcp` yet, so surface
        // the error so the user can manually clean up. (Future: probe
        // first via `docker mcp profile show` and `profile remove`.)
        if (/already exists/i.test(err?.message ?? '')) {
          throw new Error(
            `Docker MCP profile "${GATEWAY_PROFILE_NAME}" 已存在。请先在终端运行 ` +
            `\`docker mcp profile remove ${GATEWAY_PROFILE_NAME}\` 后重试。`,
          )
        }
        throw err
      })

      // Spawn (or restart) the gateway. `start` stops the previous
      // instance first so this is safe to call repeatedly.
      const status = await svc.start({ port, profile: GATEWAY_PROFILE_NAME })

      // Now mutate config: remove every docker-run server we converted,
      // and add the single URL entry. We use `mergeStrategy: 'replace'`
      // for both so we don't leave half-merged entries behind.
      const edits = dockerEntries.map((e) => ({
        keyPath: `mcp_servers.${e.name}`,
        value: null,
        mergeStrategy: 'replace' as const,
      }))
      edits.push({
        keyPath: `mcp_servers.${GATEWAY_SERVER_NAME}`,
        value: buildGatewayConfigEntry(port) as any,
        mergeStrategy: 'replace' as const,
      })
      await this.backend.batchWriteConfig(edits, true)

      return {
        ok: true,
        converted: dockerEntries.map((e) => e.name),
        gatewayPort: status.port ?? port,
      }
    } catch (err) {
      // Best-effort: if we already started the gateway but the config
      // write blew up, leave the gateway running -- the user can still
      // wire it up manually, and `dockerGatewayStop` is exposed.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async start(): Promise<void> {
    await this.backend.start()
  }

  async stop(): Promise<void> {
    await this.backend.stop()
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.codexApiKey) {
      return { ok: false, error: '请先填写 API Key' }
    }
    // Resolve the *currently selected* provider (apiyi / rightcode / custom) so
    // the probe backend talks to the same gateway the main agent does. v4.2.x
    // used to hard-code apiyi here — see DEFAULT_PROVIDER reference removed in
    // v4.3.0 — but with multi-provider that would silently mis-route the test
    // and report success against the wrong host.
    const persisted = await this.providerStore.load()
    const activeProvider = resolveActiveProvider(
      this.activeProviderId,
      persisted.customProviders,
    )
    // Build a fresh, isolated backend so we never disturb the long-lived one.
    // Re-uses the production resourceRoot resolution path inside CodexLocalBackend
    // (app.getAppPath / process.resourcesPath) — the only thing we tighten is
    // the connect timeout so a misconfigured key fails fast instead of waiting
    // the full production budget.
    const backend = new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      connectTimeoutMs: 8_000,
      provider: activeProvider,
      sessionConfig: this.sessionConfig,
    })
    const TEST_TIMEOUT_MS = 15_000

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        backend.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Test connection timeout')), TEST_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      await backend.stop().catch(() => { /* ignore */ })
    }
  }

  async sendMessage(payload: AgentSendMessagePayload): Promise<AgentSendMessageResult> {
    if (!this.codexApiKey) {
      const threadId = payload.threadId ?? 'pending'
      this.emitEvent({ type: 'error', threadId, error: EMPTY_KEY_ERROR })
      return { threadId }
    }

    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.sendMessage called without store/attachments')
    }

    const referenceMapping = await mapReferencesToInputItems(payload.references, this.allowedRoots)
    const model = payload.model?.trim() || DEFAULT_AGENT_MODEL
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({
          title: payload.content.slice(0, 40) || 'New Agent Thread',
          model,
        })
    const attachmentInputs = payload.attachments ?? []
    // Per-attachment failures are non-fatal: AttachmentService emits an
    // 'attachment-error' event for each skipped file, we relay it to the
    // renderer as a notice, and the rest of the turn proceeds with whichever
    // files *did* succeed. This matches the recovery direction Codex itself
    // is shipping for openai/codex#13508 — "remove failed attachment, keep
    // the turn alive".
    const onAttachmentError = (e: { name: string; error: string }): void => {
      this.emitEvent({ type: 'attachment_error', threadId: thread.id, name: e.name, error: e.error })
    }
    // The injected attachments service is typed as `AttachmentService`-like
    // in tests (just `{ ingest }`), so guard the EventEmitter wiring.
    const emitterLike = this.attachments as Partial<{
      on(event: string, fn: (e: { name: string; error: string }) => void): void
      off(event: string, fn: (e: { name: string; error: string }) => void): void
    }>
    const hasEmitter = typeof emitterLike.on === 'function' && typeof emitterLike.off === 'function'
    if (hasEmitter) emitterLike.on!('attachment-error', onAttachmentError)
    let savedAttachments: Awaited<ReturnType<typeof this.attachments.ingest>>
    try {
      savedAttachments = await this.attachments.ingest(thread.id, attachmentInputs)
    } finally {
      if (hasEmitter) emitterLike.off!('attachment-error', onAttachmentError)
    }
    // Anchor every attachment's on-disk localPath into the agent's text
    // prompt. The renderer file-picker only gives us a buffer — without
    // this preamble the model can't `cat`/`read_file`/etc. the attachment
    // because it has no path to anchor to. Image bytes ALSO travel via
    // `localImage` for vision models, but listing the path here is what
    // lets the agent's filesystem tools touch the same file. See
    // AgentManager.test.ts > "injects the localPath of every attachment".
    const promptText = buildPromptWithReferenceMentions(
      buildPromptWithAttachments(payload.content, savedAttachments),
      referenceMapping.textMentions,
    )
    const referenceItems = mapDuplicateAttachmentReferencesToUploadedPaths(
      referenceMapping.items,
      attachmentInputs,
      savedAttachments,
    )
    const localImagePaths = new Set(
      referenceItems
        .filter((item): item is Extract<typeof item, { type: 'localImage' }> => item.type === 'localImage')
        .map((item) => path.resolve(item.path)),
    )
    const skillItems: AgentInput['items'] = (payload.skills ?? [])
      // Defensive dedupe — if the renderer detected `$foo $foo` we still want
      // a single `skill` input item, otherwise codex injects the SKILL.md
      // instructions twice and burns tokens.
      .filter((skill, idx, arr) => arr.findIndex((s) => s.name === skill.name) === idx)
      .map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path }))
    const items: AgentInput['items'] = [
      { type: 'text', text: promptText },
      ...skillItems,
      ...referenceItems,
      ...savedAttachments
        .filter((item) => item.mime.startsWith('image/'))
        .filter((item) => {
          const resolved = path.resolve(item.localPath)
          if (localImagePaths.has(resolved)) return false
          localImagePaths.add(resolved)
          return true
        })
        .map((item) => ({ type: 'localImage' as const, path: item.localPath })),
    ]

    // Persist the user turn before kicking off the backend so that:
    //   1) After an app restart `switchThread` actually has chat history to load
    //      (regression: AgentMessage rows were never written before this change).
    //   2) `ThreadTitleSummarizer.maybeSummarize` can read both a user and an
    //      assistant message later — its gate `messages.length < 2` was the
    //      reason auto-titles never appeared in the thread switcher.
    const userTimelineItems = this.buildUserTimelineItems(payload.content, savedAttachments)
    if (userTimelineItems.length > 0) {
      // Same JSON round-trip as the assistant path: TimelineItem is a tagged
      // union and Prisma's InputJsonValue rejects it at compile time even
      // though the runtime shape is pure JSON.
      const userJsonItems = JSON.parse(JSON.stringify(userTimelineItems)) as Parameters<
        ThreadStore['addMessage']
      >[0]['items']
      await this.store.addMessage({ threadId: thread.id, role: 'user', items: userJsonItems })
      // best-effort: failing to bump lastMessageAt should not block the turn
      await this.store.updateLastMessageAt(thread.id).catch(() => undefined)
    }

    const input: AgentInput = {
      ...payload,
      model,
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      items,
    }

    void this.forwardEvents(thread.id, input).catch((error: unknown) => {
      this.emitEvent({
        type: 'error',
        threadId: thread.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    // `userMessageItems` lets the renderer patch its OPTIMISTIC user message
    // (which carries the raw OS path the file was picked from, outside the
    // fs IPC allowed-roots gate) in place with these CANONICAL items
    // (uploads-cache paths, which are inside allowed-roots and click through
    // to the file viewer immediately). See `AgentSendMessageResult` jsdoc.
    // JSON round-trip drops `undefined` keys and ensures the payload is
    // structured-cloneable over IPC, matching the shape the renderer would
    // get if it re-fetched the thread via `agent:load-thread`.
    const cloneableItems = userTimelineItems.length > 0
      ? (JSON.parse(JSON.stringify(userTimelineItems)) as typeof userTimelineItems)
      : undefined
    return { threadId: thread.id, userMessageItems: cloneableItems }
  }

  private buildUserTimelineItems(
    content: string,
    savedAttachments: ReadonlyArray<{
      id: string
      originalName: string
      localPath: string
      mime: string
      size: number
    }>,
  ): TimelineItem[] {
    const now = Date.now()
    const out: TimelineItem[] = []
    const text = content.trim()
    if (text.length > 0) {
      out.push({ type: 'text', id: createTimelineId(), startedAt: now, content: text })
    }
    if (savedAttachments.length > 0) {
      const refs: AttachmentRef[] = savedAttachments.map((a) => ({
        id: a.id ?? createTimelineId(),
        kind: a.mime.startsWith('image/')
          ? 'image'
          : a.mime.startsWith('video/')
            ? 'video'
            : 'file',
        name: a.originalName,
        mime: a.mime,
        size: a.size,
        uri: 'local-file:///' + a.localPath.replace(/\\/g, '/'),
      }))
      out.push({ type: 'attachment', id: createTimelineId(), startedAt: now, attachments: refs })
    }
    return out
  }

  async cancel(threadId: string): Promise<void> {
    const codexThreadId = this.codexThreadIdByDbThreadId.get(threadId)
    await this.backend.cancel(codexThreadId ?? threadId)
  }

  async respondToApprovalResponse(response: CodexApprovalResponse): Promise<{ ok: boolean; error?: string }> {
    if (!this.backend.respondToApprovalResponse) {
      return { ok: false, error: 'Codex approval response API is unavailable' }
    }
    try {
      await this.backend.respondToApprovalResponse(response)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async listThreads() {
    if (!this.store) throw new Error('AgentManager.listThreads called without store')
    return this.store.listThreads()
  }

  async listCodexThreads(params?: ListThreadsParams): Promise<CodexThreadSummary[]> {
    if (!this.backend.isHealthy() || !this.backend.listThreads) return []
    try {
      return await this.backend.listThreads(params)
    } catch (err) {
      console.warn('[AgentManager] failed to list Codex threads:', err)
      return []
    }
  }

  async readCodexThread(threadId: string): Promise<CodexThreadDetail> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.readThread) throw new Error('Codex thread read API is unavailable')
    return this.backend.readThread(id)
  }

  async forkCodexThread(threadId: string): Promise<CodexThreadSummary> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.forkThread) throw new Error('Codex thread fork API is unavailable')
    return this.backend.forkThread(id)
  }

  async archiveCodexThread(threadId: string): Promise<void> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.archiveThread) throw new Error('Codex thread archive API is unavailable')
    return this.backend.archiveThread(id)
  }

  async unarchiveCodexThread(threadId: string): Promise<CodexThreadSummary> {
    const id = validateCodexThreadId(threadId)
    if (!this.backend.isHealthy()) throw new Error('Codex backend is not healthy')
    if (!this.backend.unarchiveThread) throw new Error('Codex thread unarchive API is unavailable')
    return this.backend.unarchiveThread(id)
  }

  /**
   * Run `codex doctor --json` (install diagnostics). Unlike the thread RPCs this
   * does NOT gate on `isHealthy()` — doctor's whole point is to explain *why* the
   * backend may be unhealthy, so it must run even when the app-server is down.
   */
  async runDoctor(): Promise<DoctorReport> {
    if (!this.backend.runDoctor) throw new Error('Codex doctor API is unavailable')
    return this.backend.runDoctor()
  }

  async loadThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.loadThread called without store')
    return this.store.loadThread(threadId)
  }

  async openThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.openThread called without store')
    return this.store.openThread(threadId)
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.renameThread called without store')
    return this.store.renameThread(threadId, title)
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.deleteThread called without store')
    return this.store.deleteThread(threadId)
  }

  private async confirmUnsafeSessionConfigChange(patch: Partial<CodexSessionConfig>): Promise<void> {
    const unsafeChanges: string[] = []
    if (
      patch.sandboxMode === 'danger-full-access' &&
      this.sessionConfig.sandboxMode !== 'danger-full-access'
    ) {
      unsafeChanges.push('danger-full-access sandbox')
    }
    if (
      patch.approvalPolicy === 'never' &&
      this.sessionConfig.approvalPolicy !== 'never'
    ) {
      unsafeChanges.push('never approval policy')
    }
    if (patch.webSearch === 'live' && this.sessionConfig.webSearch !== 'live') {
      unsafeChanges.push('live web search')
    }
    if (unsafeChanges.length === 0) return

    const win = this.win && !this.win.isDestroyed() ? this.win : undefined
    const options = {
      type: 'warning' as const,
      buttons: ['Apply', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm Codex permissions',
      message: 'Apply unsafe Codex session permissions?',
      detail: `This change enables: ${unsafeChanges.join(', ')}.`,
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 0) {
      throw new Error('session config change cancelled')
    }
  }

  private emitEvent(event: AgentStreamEvent): void {
    if (this.eventSink) {
      this.eventSink(event)
      return
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:event', event)
  }

  private emitApprovalRequest(request: CodexApprovalRequest): void {
    const win = this.win
    if (!win || win.isDestroyed()) return

    const dbThreadId = request.threadId
      ? findDbThreadId(this.codexThreadIdByDbThreadId, request.threadId)
      : undefined
    win.webContents.send('agent:approval-request', {
      ...request,
      ...(dbThreadId ? { threadId: dbThreadId } : {}),
    })
  }

  private async forwardEvents(dbThreadId: string, input: AgentInput): Promise<void> {
    let canRetryEncryptedThread = true

    while (true) {
      const codexThreadId = this.codexThreadIdByDbThreadId.get(dbThreadId)
      // Accumulate the assistant turn's timeline items in main-process memory so
      // we can write a single AgentMessage row at turn_completed time. Mirrors
      // (a tiny subset of) the renderer's `applyEvent` reducer; kept inline to
      // avoid a circular renderer→main import.
      let assistantItems: TimelineItem[] = []
      try {
        for await (const event of this.backend.send(codexThreadId, input)) {
          if (event.type === 'thread_created' && event.threadId) {
            this.codexThreadIdByDbThreadId.set(dbThreadId, event.threadId)
          }
          if (event.type === 'error' && canRetryEncryptedThread && isInvalidEncryptedContentError(event.error)) {
            canRetryEncryptedThread = false
            this.codexThreadIdByDbThreadId.delete(dbThreadId)
            break
          }
          if (!this.eventSink && this.win?.isDestroyed()) return
          // Renderer's chat store filters events by its DB threadId. Always rewrite
          // so codex-side UUIDs never leak into the UI layer.
          this.emitEvent({ ...event, threadId: dbThreadId })

          assistantItems = applyAssistantEvent(assistantItems, event)

          if (event.type === 'turn_completed') {
            if (this.store && assistantItems.length > 0) {
              try {
                // TimelineItem is a discriminated union; Prisma's InputJsonValue
                // doesn't accept tagged unions directly even though the runtime
                // payload is plain JSON. A round-trip through JSON.parse forces
                // the structural shape Prisma expects without losing information.
                const jsonItems = JSON.parse(JSON.stringify(assistantItems)) as Parameters<
                  ThreadStore['addMessage']
                >[0]['items']
                await this.store.addMessage({
                  threadId: dbThreadId,
                  role: 'assistant',
                  items: jsonItems,
                })
                await this.store.updateLastMessageAt(dbThreadId).catch(() => undefined)
              } catch (err) {
                console.warn('[AgentManager] failed to persist assistant message:', err)
              }
            }
            // Reset accumulator for any subsequent turns on this same generator.
            // (Practically the iterator ends after turn_completed, but keep this
            // defensive in case backend yields multi-turn streams later.)
            assistantItems = []

            if (dbThreadId && !this.firstTurnDoneByThread.get(dbThreadId)) {
              this.firstTurnDoneByThread.set(dbThreadId, true)
              this.summarizer?.maybeSummarize(dbThreadId).catch((err: unknown) => {
                console.warn('[AgentManager] thread title summarization failed:', err)
              })
            }
          }
        }
        if (!canRetryEncryptedThread && !this.codexThreadIdByDbThreadId.has(dbThreadId)) {
          continue
        }
        return
      } catch (error) {
        if (codexThreadId && canRetryEncryptedThread && isInvalidEncryptedContentError(error)) {
          canRetryEncryptedThread = false
          this.codexThreadIdByDbThreadId.delete(dbThreadId)
          continue
        }
        throw error
      }
    }
  }
}

function createTimelineId(): string {
  return crypto.randomUUID()
}

function findDbThreadId(map: Map<string, string>, codexThreadId: string): string | undefined {
  for (const [dbThreadId, value] of map) {
    if (value === codexThreadId) return dbThreadId
  }
  return undefined
}

function validateCodexThreadId(threadId: string): string {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('Codex thread id must be a non-empty string')
  }
  return threadId
}

function isInvalidEncryptedContentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('invalid_encrypted_content') || message.includes('Encrypted content could not be decrypted')
}

/**
 * Reducer mirroring the renderer's `store.applyEvent` for assistant items.
 * Used by `forwardEvents` to accumulate the streamed turn into a single
 * `AgentMessage` row written on `turn_completed`.
 *
 * Only handles the assistant-side item events (item_started / item_delta /
 * item_completed). Returns the original array for unrelated event types so
 * the caller can stay in a simple reassignment pattern.
 */
function applyAssistantEvent(
  items: TimelineItem[],
  event: AgentStreamEvent,
): TimelineItem[] {
  if (event.type !== 'item_started' && event.type !== 'item_delta' && event.type !== 'item_completed') {
    return items
  }
  const idx = items.findIndex((i) => i.id === event.itemId)
  switch (event.type) {
    case 'item_started': {
      if (idx >= 0) return items
      const created = createItemFromStarted(event.itemType, event.itemId, event.payload)
      return [...items, created]
    }
    case 'item_delta': {
      if (idx < 0) {
        const seeded = createItemFromStarted(event.itemType, event.itemId, {})
        return [...items, applyItemPatch(seeded, event.patch)]
      }
      const next = items.slice()
      next[idx] = applyItemPatch(next[idx], event.patch)
      return next
    }
    case 'item_completed': {
      if (idx < 0) {
        const seeded = createItemFromStarted(event.itemType, event.itemId, {})
        const merged = { ...seeded, ...event.final, type: seeded.type, endedAt: Date.now() } as TimelineItem
        return [...items, merged]
      }
      const next = items.slice()
      const cur = next[idx]
      next[idx] = { ...cur, ...event.final, type: cur.type, endedAt: Date.now() } as TimelineItem
      return next
    }
  }
}

function createItemFromStarted(
  itemType: TimelineItem['type'],
  itemId: string,
  payload: Record<string, unknown>,
): TimelineItem {
  const now = Date.now()
  switch (itemType) {
    case 'text':
      return { type: 'text', id: itemId, startedAt: now, content: '' }
    case 'reasoning':
      return { type: 'reasoning', id: itemId, startedAt: now, content: '' }
    case 'shell':
      return {
        type: 'shell',
        id: itemId,
        startedAt: now,
        command: typeof payload.command === 'string' ? payload.command : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        stdout: '',
        stderr: '',
      }
    case 'fileEdit':
      return { type: 'fileEdit', id: itemId, startedAt: now, changes: [], totalAdded: 0, totalRemoved: 0 }
    case 'attachment':
      return { type: 'attachment', id: itemId, startedAt: now, attachments: [] }
    case 'artifact':
      return { type: 'artifact', id: itemId, startedAt: now, artifacts: [] }
    case 'activity': {
      const status = payload.status
      const safeStatus =
        status === 'running' || status === 'success' || status === 'error' || status === 'cancelled'
          ? status
          : 'running'
      return {
        type: 'activity',
        id: itemId,
        startedAt: now,
        kind: typeof payload.kind === 'string' ? payload.kind : 'activity',
        ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
        status: safeStatus,
      }
    }
  }
}

function applyItemPatch(item: TimelineItem, patch: ItemDeltaPatch): TimelineItem {
  if (patch.kind === 'appendText') {
    if (patch.field === 'content' && (item.type === 'text' || item.type === 'reasoning')) {
      return { ...item, content: item.content + patch.text }
    }
    if (item.type === 'shell' && (patch.field === 'stdout' || patch.field === 'stderr')) {
      return { ...item, [patch.field]: item[patch.field] + patch.text }
    }
    return item
  }
  return { ...item, ...patch.fields, type: item.type } as TimelineItem
}
