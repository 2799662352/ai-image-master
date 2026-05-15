import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog } from 'electron'
import { CodexLocalBackend } from './CodexLocalBackend'
import { DEFAULT_CODEX_SESSION_CONFIG } from './codexLaunch'
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
import { discoverCodexSkills, readMcpSummary } from './codexConfigDiscovery'
import { mapReferencesToInputItems } from './codexUserInput'
import { validateSessionConfigPatch } from './sessionConfigValidation'
import type { BrowserWindow } from 'electron'
import type {
  AgentSendMessagePayload,
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
import type { AgentInput, IAgentBackend } from './types'
import { ThreadTitleSummarizer } from './ThreadTitleSummarizer'
import { setFsAllowedRoots } from '../file-explorer/fsIpc'

const CODEX_API_KEY_FILE = 'codex-agent.json'
const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'

/**
 * Default Codex provider config. Points at API易 (apiyi), an
 * OpenAI-compatible Responses API gateway. Hardcoded for MVP — eventually we
 * should expose this via the same settings page that hosts the API key.
 *
 * `gpt-5.5` is the default — it ships full Responses-API tool support
 * including the native `web_search` tool that Codex 0.128 `app-server`
 * registers by default. `gpt-4.1-mini` was the previous default but rejected
 * `tools[i].type='web_search'` with a 400 invalid_value through this
 * gateway. Keep this in sync with the renderer-side `DEFAULT_MODEL_ID`
 * in `src/renderer/src/features/agent-chat/models.ts`.
 */
const DEFAULT_AGENT_MODEL = 'gpt-5.5'
const DEFAULT_PROVIDER = {
  id: 'apiyi',
  name: 'API Yi',
  baseUrl: 'https://api.apiyi.com/v1',
  envKey: 'OPENAI_API_KEY',
} as const

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
}

export class AgentManager {
  private backend: IAgentBackend
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly userDataDir: string
  private readonly codexApiKeyPath: string
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
    this.codexApiKeyPath = path.join(opts.userDataDir, CODEX_API_KEY_FILE)
    this.loadCodexApiKey()
    this.backend = opts.backend ?? new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      provider: DEFAULT_PROVIDER,
      sessionConfig: this.sessionConfig,
      onApprovalRequest: (request) => this.emitApprovalRequest(request),
      onMcpNotification: (event) => this.handleMcpNotification(event),
    })
    if (this.store) {
      this.summarizer = new ThreadTitleSummarizer(this.store, this.backend, DEFAULT_AGENT_MODEL)
    }
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
    return resolveWorkspacePaths({
      home: os.homedir(),
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      userData: this.userDataDir,
      // `app` may be `undefined` in vitest contexts that don't mock electron;
      // we treat that case as "not packaged" so system-scope skill discovery
      // simply skips, matching the dev-mode runtime behaviour.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
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

  async setCodexApiKey(key: string): Promise<void> {
    const trimmed = key.trim()
    const tmpPath = `${this.codexApiKeyPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify({ openaiApiKey: trimmed }), 'utf8')
    await fs.rename(tmpPath, this.codexApiKeyPath)
    this.codexApiKey = trimmed
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
    return discoverCodexSkills({
      cwd: this.sessionConfig.writableRoots[0] ?? process.cwd(),
      home: os.homedir(),
      // Same defensive guard as `workspacePaths()` — see note there.
      resourcesPath: app?.isPackaged ? process.resourcesPath : undefined,
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
    // Build a fresh, isolated backend so we never disturb the long-lived one.
    // Re-uses the production resourceRoot resolution path inside CodexLocalBackend
    // (app.getAppPath / process.resourcesPath) — the only thing we tighten is
    // the connect timeout so a misconfigured key fails fast instead of waiting
    // the full production budget.
    const backend = new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      connectTimeoutMs: 8_000,
      provider: DEFAULT_PROVIDER,
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

  async sendMessage(payload: AgentSendMessagePayload): Promise<{ threadId: string }> {
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
    return { threadId: thread.id }
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
        kind: a.mime.startsWith('image/') ? 'image' : 'file',
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

  async listCodexThreads(): Promise<CodexThreadSummary[]> {
    if (!this.backend.isHealthy() || !this.backend.listThreads) return []
    try {
      return await this.backend.listThreads()
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

  private loadCodexApiKey(): void {
    try {
      const raw = readFileSync(this.codexApiKeyPath, 'utf8')
      const parsed = JSON.parse(raw) as { openaiApiKey?: unknown }
      this.codexApiKey = typeof parsed?.openaiApiKey === 'string' ? parsed.openaiApiKey : ''
    } catch {
      this.codexApiKey = ''
    }
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
