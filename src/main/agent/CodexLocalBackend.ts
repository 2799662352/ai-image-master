import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs, type WriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertCodexModelContextConfig } from '../../shared/modelSettings'
import { buildCodexLaunchArgs, resolveCodexSessionConfig, type CatimationMcpLaunchInfo, type CodexLaunchOptions, type CodexProviderConfig } from './codexLaunch'
import { mergeCodexConfigs } from './codexConfigMerge'
import { appendAuditLog, atomicWriteFile } from './codexConfigStore'
import { CodexProtocolClient, mapServerNotification } from './CodexProtocolClient'
import { createAgentLogStream } from './logger'
import { getCodexResourceRoot, resolveBundledFfmpegDir, resolveCodexBinary } from './paths'
import { runCodexDoctor, type DoctorReport } from './codexDoctor'
import { pickFreePort, withPortInUseRetry } from './ports'
import {
  startProviderCompatibilityProxies,
  type ProviderCompatibilityProxyGroup,
} from './responsesCompatibilityProxy'
import { MIAU_BASE_URL, resolveMiauBaseUrl } from '../../shared/miau'
import { resolveGatewayOrigin } from '../services/auth/gatewayHeaderInjector'
import { gatewayPlatformHeaders, getActivePoolToken } from '../services/auth/gatewayToken'

/**
 * 让 agent 聊天也能花平台余额。
 *
 * codex 自己带的是用户自填的 Miau Key(provider 的 `env_key="MIAU_API_KEY"`)。
 * 而 `qwen3.8-max` 这一路打的就是 Miau 网关,所以平台池的钱同样付得了它 ——
 * 用户登录之后不该还要为聊天单独填一枚 key。
 *
 * ## 两道闸,缺一不可
 *
 * 1. **上游必须是 Miau 网关。** `rightcode-claude` / `grok` / `deepseek` 打的是
 *    别家的本地代理,把平台影子 token 发过去就是**凭据外泄** —— 这与出网注入器
 *    的 host 白名单是同一条纪律,那边的注释写了为什么不能放宽。
 * 2. **必须已 arm 平台池。** 没 arm 时回 null,codex 自带的 Key 原样透传,
 *    行为与这个功能上线之前逐字节相同。
 *
 * 拿到的是 `gatewayPlatformHeaders` 的**整份**(Authorization + 计费归属):
 * 少了归属那几个,钱扣对了但用量明细里查不到,而且一个错都不报。
 */
/**
 * 开发期把 Miau 的生产地址换成 `CATIMATION_GATEWAY_ORIGIN`。
 *
 * **这一步必须在主进程做。** 那批 provider preset 住在 `gatewayModelRouting.ts`,
 * 而那个文件被渲染层直接 import(`agent-chat/ModelPicker.tsx`)—— 在它顶层写
 * `import { app } from 'electron'` 会让渲染进程加载即失败,表现是「应用初始化超时」
 * 加整页空白。所以 preset 里留生产常量,覆盖在这里落。
 *
 * 打包产物原样返回:`resolveMiauBaseUrl` 自己有那道闸,理由见它的注释。
 */
function withDevGatewayOverride(
  providers: readonly CodexProviderConfig[],
): CodexProviderConfig[] {
  const resolved = resolveMiauBaseUrl(app.isPackaged)
  if (resolved === MIAU_BASE_URL) return [...providers]
  return providers.map((provider) =>
    provider.baseUrl === MIAU_BASE_URL ? { ...provider, baseUrl: resolved } : { ...provider },
  )
}

function gatewayPlatformHeadersFor(target: URL): Record<string, string> | null {
  if (target.origin !== resolveGatewayOrigin()) return null
  const token = getActivePoolToken()
  if (!token) return null
  return gatewayPlatformHeaders(token)
}
import type {
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexModelContextConfig,
  CodexSessionConfig,
  CodexSubagentInfo,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexWorkspacePaths,
} from '../../types/agent'
import type { AgentInput, IAgentBackend, ListThreadsParams } from './types'
import type {
  CodexModelListParams,
  CodexModelListResponse,
  CodexThreadConfigOverrides,
  CodexThreadMemoryMode,
  CollaborationModeListResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
} from './codexProtocol'
import type {
  AppsListParams,
  AppsListResponse,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportResponse,
  ExternalAgentConfigMigrationItem,
  MarketplaceAddParams,
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  PluginReadResponse,
} from '../../types/codexPlugins'
import type {
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadGoalGetResponse,
  ThreadGoalClearResponse,
} from '../../types/codexGoals'

export { mapServerNotification }

const KILL_GRACE_MS = 2_000
const STARTUP_LOG_TAIL = 8_000
const DEFAULT_SPAWN_CONNECT_TIMEOUT_MS = 10_000

export interface CodexLocalBackendOptions {
  /**
   * Override to bypass the spawn step and connect to an existing WebSocket
   * (used by tests against a fake `codex app-server`). When set, no child
   * process is created and `isHealthy` only inspects the WS state.
   */
  wsUrl?: string
  /**
   * Resource directory containing the bundled `codex/<platform>-<arch>/`
   * subtree. When set (and `wsUrl` is NOT set), `start()` skips the Electron
   * `app.getAppPath()` lookup and uses this path directly. Used by the
   * standalone probe script and any future non-Electron contexts (CI smoke
   * tests, etc.) that need to exercise the backend end-to-end without
   * running inside Electron.
   */
  resourceRoot?: string
  /**
   * Resolves the user's OpenAI API key at spawn time. When it returns a
   * non-empty trimmed string, the value is forwarded to the spawned `codex`
   * binary via `OPENAI_API_KEY`. When it returns `undefined`/empty, no
   * `OPENAI_API_KEY` is forwarded — even if it exists in the parent process
   * env — so callers can rely on an explicit key path.
   */
  getApiKey?: () => string | undefined
  /**
   * Announce `capabilities.experimentalApi` at initialize, unlocking
   * `#[experimental]`-gated RPCs (collaborationMode/list,
   * turn/start.collaborationMode). Forwarded to CodexProtocolClient.
   */
  experimentalApi?: boolean
  /**
   * Test seam for the `child_process.spawn` call in the spawn-mode branch.
   * Defaults to Node's `spawn`. Tests inject a stub that records the call
   * (notably the `env` arg) and returns an `EventEmitter`-shaped child.
   */
  spawnFactory?: typeof spawn
  /**
   * Test seam for the production log path. Defaults to createAgentLogStream;
   * context getter validation must complete before this factory is touched.
   */
  createLogStream?: typeof createAgentLogStream
  /**
   * Connect timeout forwarded to `CodexProtocolClient` in the spawn-mode
   * branch. Defaults to 10s in production. Tests can shrink this so an
   * unreachable spawn fails fast without affecting the wsUrl branch.
   */
  connectTimeoutMs?: number
  /**
   * Custom OpenAI-compatible provider config. Forwarded to
   * `buildCodexLaunchArgs` so the spawned `codex app-server` connects to the
   * configured `base_url` (e.g. API易) instead of `api.openai.com`. When
   * omitted, Codex uses its built-in `openai` provider — which requires a
   * direct OpenAI key.
   */
  provider?: CodexProviderConfig
  sessionConfig?: Partial<CodexSessionConfig>
  /**
   * Reads the current context pin immediately before every fresh process
   * spawn. Keeping this as a getter ensures restartCodex consumes settings
   * confirmed after the previous process was launched. `null` means unpinned:
   * the spawn omits the `model_context_window` overrides so Codex resolves
   * per-model windows from its native metadata.
   */
  getModelContextConfig?: () => CodexModelContextConfig | null
  /**
   * Local in-process catimation MCP server coordinates. Forwarded to
   * `buildCodexLaunchArgs` so the spawned Codex subprocess gets an ephemeral
   * `[mcp_servers.catimation]` entry (stdio bridge when `stdio` is present,
   * streamable HTTP otherwise) and can call our in-app `generate_image`
   * tool. Only used on the spawn path.
   */
  catimationMcp?: CatimationMcpLaunchInfo
  /**
   * Freshly-resolved stdio transport for the bundled cinematography-kb-mcp,
   * forwarded verbatim to `buildCodexLaunchArgs`. Same "recompute, never trust
   * the persisted copy" treatment catimation gets — see
   * {@link CodexLaunchOptions.cinematographyKbStdio} for the stale-path
   * incident it fixes.
   */
  cinematographyKbStdio?: CodexLaunchOptions['cinematographyKbStdio']
  /**
   * Resolves the qwen3.7-max-dashscope understanding provider (Path B) at spawn
   * time. When it returns a config + token, the spawned codex registers an
   * EXTRA `[model_providers.qwen]` table (so a subagent can select
   * `modelProvider="qwen"`) and the token is injected as the provider's env var
   * (e.g. `MIAU_API_KEY`). Returns `undefined` when the Miau token is not
   * configured — then no qwen provider is registered and Path B is unavailable.
   */
  getUnderstandProvider?: () => { provider: CodexProviderConfig; token: string } | undefined
  /**
   * Resolves the OTHER Channels of the active Gateway at spawn time (Plan B:
   * per-thread provider routing). Each returned config is registered as an
   * EXTRA `[model_providers.<id>]` table — bridged channels are routed through
   * their own loopback compatibility proxy — so a thread can select any
   * sibling channel via `thread/start.modelProvider` WITHOUT a codex restart.
   * The active provider is excluded automatically (id match); returning
   * `undefined`/empty keeps today's single-provider launch.
   */
  getGatewayChannelProviders?: () => readonly CodexProviderConfig[]
  /**
   * Returns the user's apiyi-mcp key (设置 → API易) at spawn time, or undefined
   * when none is configured. Forwarded to `buildCodexLaunchArgs` as
   * {@link CodexLaunchOptions.apiyiKey} so the secret is injected via `-c`
   * (`mcp_servers.apiyi.env.APIYI_API_KEY`) — never persisted to config.toml.
   * Resolved fresh on every spawn; updates take effect on the next codex
   * (re)start (AgentManager restarts on apiyi-mcp key change).
   */
  getApiyiKey?: () => string | undefined
  /**
   * Returns the user's cinematography-kb-mcp key (设置 → 运镜知识库) at spawn
   * time, or undefined when none is configured. Forwarded to
   * `buildCodexLaunchArgs` as {@link CodexLaunchOptions.cinematographyKbKey} so
   * the secret is injected via `-c`
   * (`mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY`) — never persisted to
   * config.toml. Resolved fresh on every spawn; updates take effect on the next
   * codex (re)start (AgentManager restarts on key change).
   */
  getCinematographyKbKey?: () => string | undefined
  /**
   * Returns the user's DashVector key (设置 → 运镜知识库 → Sakuga 数据集检索) at
   * spawn time, or undefined when none is configured. Forwarded to
   * `buildCodexLaunchArgs` as {@link CodexLaunchOptions.dashVectorKey} so the
   * secret is injected via `-c`
   * (`mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY`) — never persisted
   * to config.toml. Resolved fresh on every spawn; updates take effect on the
   * next codex (re)start (AgentManager restarts on key change).
   */
  getDashVectorKey?: () => string | undefined
  onApprovalRequest?: (request: CodexApprovalRequest) => void
  /** 服务端自行解决/清理了某个待决审批请求（`serverRequest/resolved`）。 */
  onApprovalResolved?: (info: { id: string; threadId?: string }) => void
  onMcpNotification?: (event: AgentStreamEvent) => void
  /** Out-of-band native `/goal` updates (`thread/goal/updated|cleared`). */
  onGoalNotification?: (event: AgentStreamEvent) => void
  /** Confirmed persistent collaboration settings (`thread/settings/updated`). */
  onThreadSettingsNotification?: (
    event: Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>,
  ) => void
  /**
   * An event for a thread this client never started a turn on — in practice a
   * sub-agent spawned by the model (see
   * {@link CodexProtocolClientOptions.onUnroutedEvent}). Forwarded so the
   * manager can attribute the child to its parent conversation instead of the
   * event being dropped on the floor.
   */
  onUnroutedEvent?: (event: AgentStreamEvent, context: { turnId: string }) => void
  /**
   * Pin the `CODEX_HOME` used for EVERY spawn (initial + `restartCodex`).
   * Defaults to {@link resolveStableCodexHome} (`~/.codex`, honoring a
   * `CODEX_HOME` env override). Tests inject an explicit dir so the spawned
   * env is deterministic; production omits it.
   */
  codexHome?: string
}

type SpawnedCodexClient = {
  proc: ChildProcess
  client: CodexProtocolClient
  compatibilityProxies: ProviderCompatibilityProxyGroup | null
  /**
   * (round-5) 显式持有 log WriteStream, 让 stop() 能 .end() 它。
   *
   * 早期版本里 log 是 startSpawnedClient 闭包内的局部变量, 没存到 this。
   * proc 退出 + client 释放后, 这条 WriteStream 还握着 OS 文件 fd, 等
   * v8 GC 找上门才会(也许)被 finalizer 关掉 —— 但 fs.WriteStream 的
   * GC 关闭非确定性, 每次 provider 切换 / restartCodex 都泄一个 fd,
   * Windows 上长 session 累计能把句柄表打爆。
   *
   * resourceRootOverride 走 process.stderr 那条路 log 没有可关的 fd,
   * 用 null 标记跳过关闭。
   */
  log: WriteStream | null
}

/**
 * Resolve the single, STABLE `CODEX_HOME` the app pins for every codex spawn.
 *
 * Mirrors codex's own `find_codex_home` (codex-rs/utils/home-dir): honor a
 * non-empty `CODEX_HOME` env override, otherwise default to `~/.codex`.
 *
 * Why this matters: the app used to leave the FIRST spawn's home unset (so codex
 * fell back to `~/.codex`) while `restartCodex` flipped it to
 * `<userData>/codex-runtime`. Session rollouts live at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, so a rollout written after a
 * provider switch (in codex-runtime) became unfindable on the next launch's
 * fresh (`~/.codex`) spawn — `thread/resume` looked in the wrong home and the
 * chat lost its memory. Pinning ONE home for every spawn keeps writes and
 * resumes in the same place across launches and provider switches. `~/.codex` is
 * codex's canonical default (non-gitignored, where the user's `config.toml`/auth
 * and the bulk of prior history already live), which also sidesteps the
 * gitignored-CODEX_HOME resume failures in openai/codex#5247 / #5412.
 */
export function resolveStableCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const fromEnv = env.CODEX_HOME?.trim()
  if (fromEnv) return fromEnv
  return path.join(homeDir, '.codex')
}

/**
 * Build the env passed to the spawned `codex` binary. Pulls every var from
 * `baseEnv` and only sets `OPENAI_API_KEY` when `apiKey` has a non-empty
 * trimmed value; otherwise it strips any pre-existing `OPENAI_API_KEY` so
 * the spawned process cannot accidentally inherit a stale key.
 */
export function buildCodexSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  apiKey: string | undefined,
  codexHome?: string,
  extraEnv?: Record<string, string | undefined>,
  extraPathDirs?: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const trimmed = apiKey?.trim() ?? ''
  if (trimmed) env.OPENAI_API_KEY = trimmed
  else delete env.OPENAI_API_KEY
  if (codexHome) env.CODEX_HOME = codexHome
  // Extra env vars for registered (non-active) providers — e.g. MIAU_API_KEY
  // for the qwen understanding subagent (Path B). Only non-empty trimmed
  // values are set; empty ones are skipped (never clobber with blanks).
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      const v = value?.trim() ?? ''
      if (v) env[key] = v
    }
  }
  // Prepend bundled tool dirs (e.g. the shipped gyan ffmpeg/ffprobe) so Codex's
  // shell resolves OUR binaries first without the user installing anything. The
  // existing PATH key is found case-insensitively because Windows stores it as
  // `Path`, and spreading process.env into a plain object loses the OS-level
  // case folding. Codex runs with sandbox_mode=danger-full-access, so spawning
  // these binaries is not blocked by the Windows sandbox.
  const dirs = (extraPathDirs ?? []).filter((dir) => dir.trim().length > 0)
  if (dirs.length > 0) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const existing = env[pathKey] ?? ''
    const prefix = dirs.join(path.delimiter)
    env[pathKey] = existing ? `${prefix}${path.delimiter}${existing}` : prefix
  }
  return env
}

export async function rebuildRuntimeConfig(paths: CodexWorkspacePaths): Promise<void> {
  const [personal, workspace] = await Promise.all([
    fs.readFile(paths.personalConfigToml, 'utf8').catch(() => ''),
    fs.readFile(paths.workspaceConfigToml, 'utf8').catch(() => ''),
  ])
  const merged = mergeCodexConfigs({ personalToml: personal, workspaceToml: workspace })
  await atomicWriteFile(paths.runtimeConfigToml, merged)
}

export class CodexLocalBackend implements IAgentBackend {
  private proc: ChildProcess | null = null
  private client: CodexProtocolClient | null = null
  /**
   * (round-5) spawn 出来的 codex 子进程 stdout/stderr 重定向到磁盘的 log
   * 文件流。stop() 必须 .end() 它, 否则每次 provider 切换都泄一个 fd。
   */
  private log: WriteStream | null = null
  private compatibilityProxies: ProviderCompatibilityProxyGroup | null = null
  /** Provider tables registered on the live spawn (Plan B routing targets). */
  private registeredProviderChannelIds = new Set<string>()
  private readonly options: CodexLocalBackendOptions
  private readonly wsUrlOverride: string | undefined
  private readonly resourceRootOverride: string | undefined
  private sessionConfig: CodexSessionConfig
  private currentProvider: CodexProviderConfig | undefined
  private configDirty = false
  /**
   * Pinned `CODEX_HOME` for every spawn (initial + `restartCodex`). Set once in
   * the constructor and never reassigned, so session rollouts always land in —
   * and resume from — the same place across launches. See
   * {@link resolveStableCodexHome}.
   */
  private readonly codexHome: string
  /**
   * Generation counter bumped once per successful spawn/connect (see
   * `startSpawnedClient` / `startWsClient`). Every codex respawn — crash
   * self-heal via `start()` or a provider/config `restartCodex()` — mints a
   * brand-new app-server process whose in-memory threads start empty, so any
   * thread id from a prior generation is no longer resumable on `turn/start`.
   * `AgentManager` reads this via `currentEpoch()` to drop stale thread ids
   * instead of wedging the conversation on a dead id.
   */
  private epoch = 0

  constructor(options: CodexLocalBackendOptions = {}) {
    this.options = options
    this.wsUrlOverride = options.wsUrl
    this.resourceRootOverride = options.resourceRoot
    this.sessionConfig = resolveCodexSessionConfig(options.sessionConfig)
    this.currentProvider = options.provider
    this.codexHome = options.codexHome ?? resolveStableCodexHome()
  }

  setProvider(provider: CodexProviderConfig | undefined): void {
    this.currentProvider = provider
    // Mark config dirty so callers driving config-change-then-restart see the
    // pending change reflected in `isConfigDirty()`. The new provider takes
    // effect on the next `restartCodex()` / `start()` cycle — we deliberately
    // do not kill the running process here so a UI flicker doesn't turn into
    // a hard restart on every keystroke.
    this.configDirty = true
  }

  async start(): Promise<void> {
    if (this.wsUrlOverride) {
      this.client = await this.startWsClient(this.wsUrlOverride)
      return
    }

    const started = await this.spawnClientRetryingPortClashes()
    this.proc = started.proc
    this.client = started.client
    this.log = started.log
    this.compatibilityProxies = started.compatibilityProxies
  }

  private async startWsClient(url: string): Promise<CodexProtocolClient> {
    const client = new CodexProtocolClient({
      url,
      clientInfo: { name: 'catimation', version: '0.0.0' },
      sessionConfig: this.sessionConfig,
      connectTimeoutMs: 5_000,
      experimentalApi: this.options.experimentalApi,
      onApprovalRequest: this.options.onApprovalRequest,
      onApprovalResolved: this.options.onApprovalResolved,
      onMcpNotification: this.options.onMcpNotification,
      onUnroutedEvent: this.options.onUnroutedEvent,
      onGoalNotification: this.options.onGoalNotification,
      onThreadSettingsNotification: this.options.onThreadSettingsNotification,
    })
    await client.start()
    this.epoch += 1
    return client
  }

  private resolveResourceRoot(): string {
    return this.resourceRootOverride ?? getCodexResourceRoot({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
  }

  /**
   * pickFreePort 挑好端口到 codex 真正 bind 之间隔着一次进程 spawn,这个窗口关不掉:
   * 端口必须留给子进程自己去 bind。另一个实例(开发版与安装版同跑、e2e 与本机安装版
   * 并发)恰好在这期间抢走它,codex 就死在 `os error 10048`,而且 startSpawnedClient
   * 不会重试 —— 表现为 agent 起不来、聊天发不出去,错误在 index.ts 里只进 console。
   * 换个端口重来一次即可,所以在这里兜。
   */
  private async spawnClientRetryingPortClashes(): Promise<SpawnedCodexClient> {
    return withPortInUseRetry(() => this.startSpawnedClient(), {
      onRetry: (error, attemptsLeft) => {
        console.warn(
          `[codex] app-server 端口被抢占,换端口重试(剩余 ${attemptsLeft} 次):`,
          error instanceof Error ? error.message : String(error),
        )
      },
    })
  }

  private async startSpawnedClient(): Promise<SpawnedCodexClient> {
    const rawModelContext = this.options.getModelContextConfig?.()
    if (this.options.getModelContextConfig && rawModelContext !== null) {
      // Strict boundary: a wired getter may return a valid pin or the explicit
      // unpinned `null`, never undefined/garbage.
      assertCodexModelContextConfig(rawModelContext)
    }
    const modelContextConfig = rawModelContext ?? null
    const port = await pickFreePort(4222)
    const listenUrl = `ws://127.0.0.1:${port}`
    const resourceRoot = this.resolveResourceRoot()
    const bin = resolveCodexBinary(resourceRoot)
    // resourceRootOverride 分支走 process.stderr (测试 / 调试时), 没有 fd
    // 可关; 走真实 file 那条会把 WriteStream 存到 ownedLog, 在 stop() 里 .end() 它。
    const ownedLog: WriteStream | null = this.resourceRootOverride
      ? null
      : (this.options.createLogStream ?? createAgentLogStream)('codex')
    const log: NodeJS.WritableStream = ownedLog ?? process.stderr
    const recentOutput = new RingBuffer(STARTUP_LOG_TAIL)
    const captureOutput = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      recentOutput.push(text)
    }

    let compatibilityProxies: ProviderCompatibilityProxyGroup | null = null
    let proc: ChildProcess | null = null
    try {
      const apiKey = this.options.getApiKey?.()
      const understand = this.options.getUnderstandProvider?.()
      // Plan B (per-thread provider routing): register the active Gateway's
      // sibling Channels alongside the active one, each behind its own
      // compatibility proxy when bridged, so `thread/start.modelProvider`
      // can route a thread to any of them without a codex restart.
      const gatewayChannels = (this.options.getGatewayChannelProviders?.() ?? [])
        .filter((channel) => channel.id !== this.currentProvider?.id)
      // 开发期把 Miau 生产地址换成 `CATIMATION_GATEWAY_ORIGIN`。preset 里留的是
      // 生产常量,因为那批 preset 的文件被渲染层 import,不能碰 electron。
      const providerConfigs = withDevGatewayOverride([
        ...(this.currentProvider ? [this.currentProvider] : []),
        ...(understand ? [understand.provider] : []),
        ...gatewayChannels,
      ])
      // Records what THIS spawn can serve: only ids in this set are valid
      // in-process `thread/start.modelProvider` targets (Plan B).
      this.registeredProviderChannelIds = new Set(
        providerConfigs.map((provider) => provider.id),
      )
      compatibilityProxies = providerConfigs.length > 0
        ? await startProviderCompatibilityProxies(providerConfigs, {
          platformHeaders: gatewayPlatformHeadersFor,
        })
        : null
      let providerIndex = 0
      const activeProvider = this.currentProvider
        ? compatibilityProxies?.providers[providerIndex++]
        : undefined
      const understandProvider = understand
        ? compatibilityProxies?.providers[providerIndex++]
        : undefined
      const gatewayChannelProviders = compatibilityProxies?.providers.slice(providerIndex) ?? []
      const extraEnv = understand?.token
        ? { [understand.provider.envKey]: understand.token }
        : undefined
      const ffmpegDir = resolveBundledFfmpegDir(resourceRoot)
      const env = buildCodexSpawnEnv(
        process.env,
        apiKey,
        this.codexHome,
        extraEnv,
        ffmpegDir ? [ffmpegDir] : undefined,
      )
      const launchArgs = buildCodexLaunchArgs({
        listenUrl,
        provider: activeProvider,
        sessionConfig: this.sessionConfig,
        modelContextConfig,
        catimationMcp: this.options.catimationMcp,
        cinematographyKbStdio: this.options.cinematographyKbStdio,
        extraProviders: [
          ...(understandProvider ? [understandProvider] : []),
          ...gatewayChannelProviders,
        ],
        apiyiKey: this.options.getApiyiKey?.(),
        cinematographyKbKey: this.options.getCinematographyKbKey?.(),
        dashVectorKey: this.options.getDashVectorKey?.(),
      })
      const spawnLine = `[CodexLaunch] spawn ${bin} ${launchArgs.join(' ')}`
      log.write(spawnLine + '\n')
      console.log(spawnLine)
      proc = (this.options.spawnFactory ?? spawn)(
        bin,
        launchArgs,
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      )
    } catch (error) {
      await this.killProcessInstance(proc)
      await compatibilityProxies?.close().catch(() => undefined)
      if (ownedLog) ownedLog.end()
      throw error
    }

    proc.stdout?.on('data', captureOutput)
    proc.stderr?.on('data', captureOutput)
    proc.stdout?.pipe(log, { end: false })
    proc.stderr?.pipe(log, { end: false })

    let startupPhase = true
    const earlyExit = new Promise<never>((_, reject) => {
      proc.once('error', (error) => {
        log.write(`[codex process error] ${error.message}\n`)
        if (startupPhase) reject(new Error(`Codex spawn failed: ${error.message}`))
      })
      proc.once('exit', (code, signal) => {
        log.write(`[codex exited] code=${code} signal=${signal ?? ''}\n`)
        if (startupPhase) {
          const tail = recentOutput.read().slice(-STARTUP_LOG_TAIL)
          reject(new Error(
            `Codex exited before initialize completed (code=${code} signal=${signal ?? 'none'})` +
              (tail ? `\n--- recent output ---\n${tail}` : ''),
          ))
        } else {
          client.stop().catch(() => { /* ignore */ })
        }
      })
    })
    earlyExit.catch(() => { /* swallow when startupPhase=false */ })

    const client = new CodexProtocolClient({
      url: listenUrl,
      clientInfo: { name: 'catimation', version: '0.0.0' },
      sessionConfig: this.sessionConfig,
      connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_SPAWN_CONNECT_TIMEOUT_MS,
      experimentalApi: this.options.experimentalApi,
      onLog: (line) => log.write(line + '\n'),
      onApprovalRequest: this.options.onApprovalRequest,
      onApprovalResolved: this.options.onApprovalResolved,
      onMcpNotification: this.options.onMcpNotification,
      onUnroutedEvent: this.options.onUnroutedEvent,
      onGoalNotification: this.options.onGoalNotification,
      onThreadSettingsNotification: this.options.onThreadSettingsNotification,
    })

    try {
      await Promise.race([client.start(), earlyExit])
    } catch (error) {
      startupPhase = false
      await client.stop().catch(() => { /* ignore */ })
      await this.killProcessInstance(proc)
      await compatibilityProxies?.close().catch(() => undefined)
      // 启动失败也要把刚开的 log fd 关掉, 否则失败重试场景下泄一个 fd。
      if (ownedLog) ownedLog.end()
      throw error
    } finally {
      startupPhase = false
    }
    // One bump per successful spawn — invalidates any thread id minted by a
    // previous codex generation (see `epoch` field jsdoc).
    this.epoch += 1
    return { proc, client, log: ownedLog, compatibilityProxies }
  }

  async stop(): Promise<void> {
    const client = this.client
    const proc = this.proc
    const log = this.log
    const compatibilityProxies = this.compatibilityProxies
    this.client = null
    this.proc = null
    this.log = null
    this.compatibilityProxies = null
    if (client) {
      await client.stop().catch(() => { /* ignore */ })
    }
    await this.killProcessInstance(proc)
    await compatibilityProxies?.close().catch(() => undefined)
    // 关 log fd: 用 .end() 而不是 .destroy(), 因为 proc.exit 之后 pipe
    // 可能还有未 flush 的最后几行 buffered data, .end() 会 flush 完再关。
    // 包 try 是因为 stream 内部状态可能已经 destroyed (双重关闭无害但报警)。
    if (log) {
      try { log.end() } catch { /* already closed */ }
    }
  }

  async applyConfigChange(paths: CodexWorkspacePaths): Promise<void> {
    await rebuildRuntimeConfig(paths)
    this.configDirty = true
  }

  isConfigDirty(): boolean {
    return this.configDirty
  }

  async restartCodex(paths: CodexWorkspacePaths): Promise<void> {
    await rebuildRuntimeConfig(paths)
    // NOTE: `CODEX_HOME` is intentionally NOT reassigned here. It is pinned once
    // in the constructor (see `this.codexHome` / `resolveStableCodexHome`). The
    // old code flipped it to `<userData>/codex-runtime` on every provider switch,
    // which drifted session rollouts away from the `~/.codex` the next launch's
    // first spawn used — so `thread/resume` missed and the chat lost its memory.
    // The new provider still takes effect: it is re-applied via the `-c
    // model_provider*` launch args on the respawn below.
    this.configDirty = true

    if (this.client?.hasInFlightWork()) {
      throw new Error('Current turn is running; retry the Provider change after it completes')
    }

    if (this.wsUrlOverride) {
      await this.stop()
      await this.start()
      this.configDirty = false
      await this.auditRestart(paths)
      return
    }

    const oldClient = this.client
    const oldProc = this.proc
    const oldLog = this.log
    const oldCompatibilityProxies = this.compatibilityProxies
    const replacement = await this.spawnClientRetryingPortClashes()
    this.proc = replacement.proc
    this.client = replacement.client
    this.log = replacement.log
    this.compatibilityProxies = replacement.compatibilityProxies

    if (oldClient) {
      await oldClient.stop().catch(() => { /* ignore */ })
    }
    await this.killProcessInstance(oldProc)
    await oldCompatibilityProxies?.close().catch(() => undefined)
    // 跟 stop() 同款关 log: provider/config 切换走的就是这条热重启路径,
    // 高频用户最容易在这里累积 fd 泄漏。
    if (oldLog) {
      try { oldLog.end() } catch { /* already closed */ }
    }
    this.configDirty = false

    await this.auditRestart(paths)
  }

  private async auditRestart(paths: CodexWorkspacePaths): Promise<void> {
    try {
      await appendAuditLog(paths.auditLogPath, {
        tsIso: new Date().toISOString(),
        action: 'codex.restart',
        ok: true,
      })
    } catch {
      // Audit logging is best-effort and must not block a local restart.
    }
  }

  send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    if (!this.client) {
      throw new Error('CodexLocalBackend.send called before start')
    }
    return this.client.send(threadId, input)
  }

  async cancel(threadId: string): Promise<void> {
    if (!this.client) return
    await this.client.cancel(threadId)
  }

  async steer(threadId: string, input: AgentInput): Promise<string> {
    if (!this.client) throw new Error('CodexLocalBackend.steer called before start')
    return this.client.steer(threadId, input)
  }

  async listThreads(params?: ListThreadsParams): Promise<CodexThreadSummary[]> {
    if (!this.client) throw new Error('CodexLocalBackend.listThreads called before start')
    return this.client.listThreads(params)
  }

  async readThread(threadId: string): Promise<CodexThreadDetail> {
    if (!this.client) throw new Error('CodexLocalBackend.readThread called before start')
    return this.client.readThread(threadId)
  }

  async readSubagentInfo(threadId: string): Promise<CodexSubagentInfo | null> {
    if (!this.client) throw new Error('CodexLocalBackend.readSubagentInfo called before start')
    return this.client.readSubagentInfo(threadId)
  }

  async forkThread(
    threadId: string,
    overrides?: CodexThreadConfigOverrides,
    lastTurnId?: string,
  ): Promise<CodexThreadSummary> {
    if (!this.client) throw new Error('CodexLocalBackend.forkThread called before start')
    return this.client.forkThread(threadId, overrides ?? this.threadConfigOverrides(), lastTurnId)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.interruptTurn called before start')
    return this.client.interruptTurn(threadId, turnId)
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.unsubscribeThread called before start')
    return this.client.unsubscribeThread(threadId)
  }

  async resumeThread(
    threadId: string,
    overrides?: CodexThreadConfigOverrides,
  ): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.resumeThread called before start')
    return this.client.resumeThread(threadId, overrides ?? this.threadConfigOverrides())
  }

  /**
   * Explicit resume/fork config overrides pinning the thread to the CURRENT
   * launch selection — the DEFAULT when the caller does not supply per-thread
   * overrides (Plan B routing passes the thread's own channel/model instead).
   * Without any overrides, codex restores the thread's persisted
   * `model_provider` from metadata (openai/codex#19287) — and after a
   * cross-channel model switch (grok↔gpt) that old provider table is no longer
   * defined in the running config, so `thread/resume` dies with
   * "failed to load configuration: Model provider `<old>` not found".
   * `currentProvider.id` is exactly the id written into the launch args
   * (compat-proxy rewrites only touch baseUrl); with no custom provider the
   * active provider is codex's built-in `openai`, which always exists.
   */
  private threadConfigOverrides(): CodexThreadConfigOverrides {
    const provider = this.currentProvider
    if (!provider) return { modelProvider: 'openai' }
    return {
      modelProvider: provider.id,
      ...(provider.model ? { model: provider.model } : {}),
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.archiveThread called before start')
    return this.client.archiveThread(threadId)
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    if (!this.client) throw new Error('CodexLocalBackend.unarchiveThread called before start')
    return this.client.unarchiveThread(threadId)
  }

  /**
   * Run `codex doctor --json` against the bundled binary. This diagnoses the
   * local install (auth, config, MCP, git, app-server) and does NOT require our
   * WS app-server to be running — so it works even when the backend failed to
   * start, which is exactly when the user needs diagnostics most.
   */
  async runDoctor(): Promise<DoctorReport> {
    const bin = resolveCodexBinary(this.resolveResourceRoot())
    return runCodexDoctor({ binaryPath: bin, env: buildCodexSpawnEnv(process.env, this.options.getApiKey?.(), this.codexHome) })
  }

  respondToApprovalResponse(response: CodexApprovalResponse): void {
    if (!this.client) throw new Error('CodexLocalBackend.respondToApprovalResponse called before start')
    this.client.respondToServerRequest(response)
  }

  isHealthy(): boolean {
    if (!this.client?.isOpen()) return false
    if (this.wsUrlOverride) return true
    return this.proc !== null && this.proc.exitCode === null
  }

  hasInFlightWork(): boolean {
    return this.client?.hasInFlightWork() ?? false
  }

  /** Reports active Codex turns without conflating pending send setup. */
  hasActiveTurns(): boolean {
    return this.client?.hasActiveTurns() ?? false
  }

  /**
   * Thread-scoped busy probe (Plan B): true only when the given CODEX thread
   * has an active turn, so in-process provider switches ignore other threads.
   */
  hasInFlightWorkForThread(codexThreadId: string): boolean {
    return this.client?.hasActiveTurnOnThread(codexThreadId) ?? false
  }

  /**
   * True when the LIVE spawn registered `[model_providers.<channelId>]`
   * (active channel or extra sibling table) — the precondition for serving a
   * switch via in-process `thread/start.modelProvider` routing (Plan B).
   */
  hasRegisteredProviderChannel(channelId: string): boolean {
    if (this.registeredProviderChannelIds.has(channelId)) return true
    return this.currentProvider?.id === channelId
  }

  currentEpoch(): number {
    return this.epoch
  }

  setSessionConfig(patch: Partial<CodexSessionConfig>): void {
    this.sessionConfig = resolveCodexSessionConfig({
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    })
    this.client?.setSessionConfig(patch)
  }

  async listMcpServers(params?: unknown): Promise<unknown> {
    if (!this.client) throw new Error('CodexLocalBackend.listMcpServers called before start')
    return this.client.listMcpServers(params as any)
  }

  async listCollaborationModes(): Promise<CollaborationModeListResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.listCollaborationModes called before start')
    return this.client.listCollaborationModes()
  }

  async updateThreadSettings(
    params: ThreadSettingsUpdateParams,
  ): Promise<ThreadSettingsUpdateResponse> {
    if (!this.client) {
      throw new Error('CodexLocalBackend.updateThreadSettings called before start')
    }
    return this.client.updateThreadSettings(params)
  }

  async batchWriteConfig(edits: unknown[], reloadUserConfig?: boolean): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.batchWriteConfig called before start')
    await this.client.batchWriteConfig(edits as any[], reloadUserConfig)
  }

  async writeConfigValue(keyPath: string, value: unknown): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.writeConfigValue called before start')
    await this.client.writeConfigValue(keyPath, value)
  }

  async readConfig(): Promise<{ config: Record<string, unknown> }> {
    if (!this.client) throw new Error('CodexLocalBackend.readConfig called before start')
    return this.client.readConfig()
  }

  async listModels(params?: CodexModelListParams): Promise<CodexModelListResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.listModels called before start')
    return this.client.listModels(params)
  }

  // Response shape re-pinned against v2/experimental_feature.rs @
  // rust-v0.145.0 (`{ data: [{ name, stage, enabled, defaultEnabled, … }] }`).
  async experimentalFeatureList(params?: {
    threadId?: string
    cursor?: string
    limit?: number
  }): Promise<Awaited<ReturnType<CodexProtocolClient['experimentalFeatureList']>>> {
    if (!this.client) throw new Error('CodexLocalBackend.experimentalFeatureList called before start')
    return this.client.experimentalFeatureList(params)
  }

  async reloadMcpServers(): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.reloadMcpServers called before start')
    await this.client.reloadMcpServers()
  }

  async mcpOAuthLogin(name: string): Promise<{ authorization_url: string }> {
    if (!this.client) throw new Error('CodexLocalBackend.mcpOAuthLogin called before start')
    return this.client.mcpOAuthLogin(name)
  }

  // ─── Native plugin / marketplace / apps / external-agent-import (≥0.140) ───
  // Thin passthroughs to the protocol client (P0). Each throws if start()
  // hasn't run, mirroring the MCP passthroughs above.

  async setThreadGoal(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.setThreadGoal called before start')
    return this.client.setThreadGoal(params)
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoalGetResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.getThreadGoal called before start')
    return this.client.getThreadGoal(threadId)
  }

  async clearThreadGoal(threadId: string): Promise<ThreadGoalClearResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.clearThreadGoal called before start')
    return this.client.clearThreadGoal(threadId)
  }

  async compactThread(threadId: string): Promise<Record<string, never>> {
    if (!this.client) throw new Error('CodexLocalBackend.compactThread called before start')
    return this.client.compactThread(threadId)
  }

  async setThreadMemoryMode(threadId: string, mode: CodexThreadMemoryMode): Promise<Record<string, never>> {
    if (!this.client) throw new Error('CodexLocalBackend.setThreadMemoryMode called before start')
    return this.client.setThreadMemoryMode({ threadId, mode })
  }

  async resetMemory(): Promise<Record<string, never>> {
    if (!this.client) throw new Error('CodexLocalBackend.resetMemory called before start')
    return this.client.resetMemory()
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.deleteThread called before start')
    return this.client.deleteThread(threadId)
  }

  async listPlugins(params?: PluginListParams): Promise<PluginListResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.listPlugins called before start')
    return this.client.listPlugins(params)
  }

  async listInstalledPlugins(params?: PluginInstalledParams): Promise<PluginInstalledResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.listInstalledPlugins called before start')
    return this.client.listInstalledPlugins(params)
  }

  async readPlugin(params: PluginReadParams): Promise<PluginReadResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.readPlugin called before start')
    return this.client.readPlugin(params)
  }

  async installPlugin(params: PluginInstallParams): Promise<PluginInstallResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.installPlugin called before start')
    return this.client.installPlugin(params)
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.uninstallPlugin called before start')
    await this.client.uninstallPlugin(pluginId)
  }

  async addMarketplace(params: MarketplaceAddParams): Promise<MarketplaceAddResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.addMarketplace called before start')
    return this.client.addMarketplace(params)
  }

  async removeMarketplace(marketplaceName: string): Promise<MarketplaceRemoveResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.removeMarketplace called before start')
    return this.client.removeMarketplace(marketplaceName)
  }

  async upgradeMarketplaces(marketplaceName?: string): Promise<MarketplaceUpgradeResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.upgradeMarketplaces called before start')
    return this.client.upgradeMarketplaces(marketplaceName)
  }

  async listApps(params?: AppsListParams): Promise<AppsListResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.listApps called before start')
    return this.client.listApps(params)
  }

  async detectExternalAgentConfig(
    params?: ExternalAgentConfigDetectParams,
  ): Promise<ExternalAgentConfigDetectResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.detectExternalAgentConfig called before start')
    return this.client.detectExternalAgentConfig(params)
  }

  async importExternalAgentConfig(
    migrationItems: ExternalAgentConfigMigrationItem[],
  ): Promise<ExternalAgentConfigImportResponse> {
    if (!this.client) throw new Error('CodexLocalBackend.importExternalAgentConfig called before start')
    return this.client.importExternalAgentConfig(migrationItems)
  }

  private async killProcessInstance(proc: ChildProcess | null): Promise<void> {
    if (!proc) return
    if (proc.exitCode !== null) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      proc.once('exit', finish)

      try { proc.kill('SIGTERM') } catch { /* already dead */ }

      const killTimer = setTimeout(() => {
        if (proc.exitCode !== null) return
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    })
  }
}

class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly maxSize: number) {}

  push(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    while (this.size > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
  }

  read(): string {
    return this.chunks.join('')
  }
}
