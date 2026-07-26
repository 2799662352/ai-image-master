import { CATIMATION_MCP_HOST, CATIMATION_MCP_TOKEN_HEADER } from '../mcp/config'
import { assertCodexModelContextConfig } from '../../shared/modelSettings'
import { CINEMATOGRAPHY_KB_ENV_SCAFFOLD } from './cinematographyKbMcpLauncher'
import type {
  CodexApprovalPolicy,
  CodexModelContextConfig,
  CodexModelVerbosity,
  CodexPersonality,
  CodexReasoningSummaryMode,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexWebSearchMode,
} from '../../types/agent'

export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

const RESERVED_PROVIDER_TOP_LEVEL_KEYS = new Set([
  'model_context_window',
  'model_auto_compact_token_limit',
])
const CANONICAL_PROVIDER_TOP_LEVEL_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

export const DEFAULT_CODEX_SESSION_CONFIG: CodexSessionConfig = {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  webSearch: 'live',
  // Session tuning defaults mirror the previously hardcoded launch args so
  // fresh installs behave byte-identically until the user opts in.
  personality: 'default',
  reasoningSummary: 'auto',
  showRawReasoning: true,
  modelVerbosity: 'default',
  // Client-side only (turn-completion toast); on by default because there is
  // no prior behavior to preserve — the capability didn't exist before.
  notifyOnTurnComplete: true,
  // Cross-session memory default ON — mirrors the previously hardcoded
  // `features.memories=true` launch pin so fresh installs behave identically.
  memoriesEnabled: true,
  writableRoots: [],
}

/** Selects an explicit compatibility adapter for a provider channel. */
export type ProviderCompatibilityPolicy =
  | 'none'
  | 'responses-namespace-bridge'
  | 'anthropic-messages-bridge'

/**
 * Custom Codex model_provider config. When passed, we wire it through the
 * `app-server`'s `-c` overrides so the spawned Codex talks to a third-party
 * OpenAI-compatible gateway (e.g. API易, Right.Codes) instead of
 * `api.openai.com`.
 *
 * We MUST pin `wire_api="responses"` for custom OpenAI-compatible gateways:
 * after openai/codex#13592 (shipped in 0.128) Codex *prefers* websocket
 * transport (`responses_websocket`) when `wire_api` is unset, and it falls
 * through to the hard-coded `wss://api.openai.com/v1/responses` endpoint —
 * NOT the gateway's `base_url`. With an apiyi/openrouter/etc. key that hits
 * `wss://api.openai.com` it loops on `401 Unauthorized` and surfaces as
 * "Reconnecting...N/5" warnings in the UI.
 *
 * Apiyi documents the plain HTTP `/v1/responses` endpoint
 * (https://docs.apiyi.com/api-capabilities/openai-responses), so `wire_api =
 * "responses"` is the correct value.
 *
 * The legacy `supports_websockets` field was removed by openai/codex#13592 —
 * we never set it.
 *
 * Optional fields (`model`, `reasoningEffort`, `verbosity`, `requiresOpenaiAuth`,
 * `extraTopLevelConfig`) let presets carry their own opinionated config so a
 * provider like Right.Codes — which requires `model="gpt-5.2"`,
 * `model_reasoning_effort="xhigh"`, `disable_response_storage=true`, and
 * `windows_wsl_setup_acknowledged=true` per its docs
 * (https://docs.rightapi.ai/docs/rc_cli_config/codex.html) — works out of the
 * box without forcing the user to hand-edit `~/.codex/config.toml`.
 */
export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
  /** Optional. When set, becomes `-c model="..."`. */
  model?: string
  /**
   * Optional model for background memories side requests
   * (`memories.extract_model` / `memories.consolidation_model`). Falls back
   * to `model` when omitted. Set it when the channel's endpoint serves a
   * smarter model than the chat model (e.g. apiyi-grok chats on grok-4.5 but
   * its full apiyi endpoint also serves gpt-5.5); leave it unset on
   * single-model endpoints where anything but `model` would 400.
   */
  memoriesModel?: string
  /**
   * Optional per-channel kill switch for cross-session memory. When `false`,
   * `features.memories=false` is appended AFTER the session-config value so
   * Codex's last-wins `-c` precedence disables the subsystem for this channel
   * no matter what the user's global toggle says.
   *
   * Needed because the memory pipeline's two phases prompt for a strict
   * artifact shape that only the OpenAI models it was tuned against reliably
   * produce. On a Claude-backed channel the side requests succeed but write
   * malformed entries into `$CODEX_HOME/memories/`, which then get injected
   * into every later session — a silently corrupted store is worse than no
   * store. The usual escape hatch (`memoriesModel` pointing at a GPT model on
   * the same endpoint) does not always exist: `memoriesModel` renames the model
   * without moving the endpoint, so a gateway that sells GPT on a *sibling* host
   * is no help — and a Claude-only pool refuses the slug outright (rightcode's
   * answers `503 Pricing configuration is temporarily unavailable`). Where no
   * GPT slug answers on the channel's own base URL, turning the feature off is
   * the only correct answer.
   *
   * Scope caveat: `features.memories` is a process-wide launch flag, so this
   * only follows the ACTIVE channel. A sibling channel reached per-thread via
   * `thread/start.modelProvider` (see {@link appendExtraProviders}) would
   * otherwise inherit whatever the active channel decided, since there is no
   * per-provider key to set — the common case being a spawn on the gateway's
   * GPT channel that later routes a thread to Claude in-process. That gap is
   * covered one layer up: `AgentManager.threadChannelSupportsMemories` reads
   * this flag off the channel a THREAD is bound to and forces that thread's
   * `thread/memoryMode/set` to `disabled`.
   */
  supportsMemories?: boolean
  /** Optional. When set, becomes `-c model_reasoning_effort="..."`. */
  reasoningEffort?: string
  /** Optional. When set, becomes `-c model_verbosity="..."`. */
  verbosity?: string
  /** Optional. When true, becomes `-c model_providers.<id>.requires_openai_auth=true`. */
  requiresOpenaiAuth?: boolean
  /**
   * Optional wire protocol. Only `"responses"` is valid: Codex **removed**
   * `wire_api = "chat"` support (deprecated in openai/codex#7782, hard error
   * since ~Feb 2026 — a `chat` value makes `codex app-server` exit code 1 at
   * config load, which previously bricked the entire backend). The ACTIVE
   * provider always pins `"responses"`; EXTRA providers must too. A chat-only
   * gateway therefore CANNOT be registered as a Codex model_provider anymore —
   * route it through the MCP/renderer layer (`/v1/chat/completions`) instead.
   */
  wireApi?: 'responses'
  /**
   * Optional. Each entry becomes `-c <key>=<value>`. Use for top-level
   * scalar overrides not modelled above (e.g. `disable_response_storage`,
   * `windows_wsl_setup_acknowledged`). Booleans/numbers serialize bare;
   * strings serialize as `key="value"`.
   */
  extraTopLevelConfig?: Readonly<Record<string, string | boolean | number>>
  /** Optional channel adapter policy; omitted providers use native Responses behavior. */
  compatibilityPolicy?: ProviderCompatibilityPolicy
  /**
   * Optional per-channel opt-out of Anthropic prompt caching. Only consulted on
   * `anthropic-messages-bridge` channels; native Responses upstreams treat
   * Codex's `prompt_cache_key` as their own hint and are unaffected.
   *
   * Defaults to on, because on a gateway that honours caching the saving is
   * large: measured on apiyi, one turn with a ~4k-token stable prefix billed
   * `input_tokens: 3974` with breakpoints off versus `input_tokens: 2` plus
   * `cache_read_input_tokens: 3972` with them on. Reads bill at 0.1x, so that
   * is roughly a tenth of the input cost — and Codex resends a growing
   * conversation every single turn, which is exactly the shape caching pays for.
   *
   * Set `false` only with a measurement in hand — either a pool that charges
   * writes (1.25x) without ever serving reads, or one that inserts breakpoints
   * itself, where ours add nothing and only crowd Anthropic's 4-block cap.
   * rightcode is the second case.
   *
   * Beware when measuring: the library reports cache counters from the Messages
   * `message_start` frame, where this class of gateway sends zeros, and its
   * `message_delta` handler reads only `output_tokens`. Reading cache numbers
   * off the translated usage is what produced the first, wrong verdict on
   * rightcode; measure against the upstream's own usage block. Codex's copy is
   * corrected after the fact by {@link ./anthropicUsageRepair}, which is a
   * reporting fix and not a substitute for measuring at the source.
   */
  promptCacheBreakpoints?: boolean
}

/**
 * Coordinates of the in-app catimation MCP server, with two possible codex
 * transports:
 *
 *  - `stdio` present (preferred): codex spawns the vendored bridge script
 *    (`resources/catimation-bridge/index.js`) as a plain stdio MCP server;
 *    the bridge pipes bytes to the Electron main process over loopback TCP.
 *    This removes codex's rmcp streamable-HTTP client — whose keep-alive /
 *    session-404 failure modes repeatedly wedged long `generate_image`
 *    turns — from the critical path entirely.
 *
 *  - `stdio` absent (fallback): the original streamable-HTTP entry
 *    (`url` + token header) pointing at the in-process Express listener.
 */
export interface CatimationMcpLaunchInfo {
  /** HTTP listener port — fallback transport + external clients. */
  port: number
  /** HTTP listener auth token (x-catimation-token header). */
  token: string
  /** When set, register the stdio bridge instead of the HTTP url. */
  stdio?: {
    command: string
    args: string[]
    env: Record<string, string>
  }
}

export interface CodexLaunchOptions {
  listenUrl?: string
  provider?: CodexProviderConfig
  /**
   * Additional provider tables to REGISTER (but not activate). Each becomes a
   * `[model_providers.<id>]` entry so a subagent can select it via
   * `modelProvider="<id>"` (Path B: a qwen3.7-max-dashscope understanding
   * subagent alongside the main agent's active provider). Unlike
   * {@link provider}, these never set the top-level `model_provider`/`model`,
   * so the main agent's provider is untouched.
   */
  extraProviders?: readonly CodexProviderConfig[]
  sessionConfig?: Partial<CodexSessionConfig>
  /**
   * Optional launch-time context pin. `null`/`undefined` means "unpinned":
   * neither `model_context_window` nor `model_auto_compact_token_limit` is
   * emitted, and Codex resolves both from its bundled per-model metadata
   * (models.json). Only pass a config when the user explicitly selected a
   * non-native window (see `resolveModelContextPin`), because the override
   * applies globally to every model in the process and changing it requires
   * a full restart.
   */
  modelContextConfig?: CodexModelContextConfig | null
  /**
   * Local in-process catimation MCP server coordinates. When present we
   * inject an ephemeral `[mcp_servers.catimation]` entry via `-c` so the
   * Codex subprocess can actually reach our `generate_image` /
   * `query_history` / UI tools. Injecting via `-c` (instead of writing the
   * user's `~/.codex/config.toml`) keeps the entry in lockstep with the
   * current session's dynamic port/token and never leaves stale config behind.
   */
  catimationMcp?: CatimationMcpLaunchInfo
  /**
   * The user's apiyi-mcp API key (the single key saved in 设置 → API易). When
   * present we overlay it onto the seeded `[mcp_servers.apiyi].env` table via
   * `-c mcp_servers.apiyi.env.APIYI_API_KEY=...` at spawn — the SAME
   * runtime-injection model as {@link catimationMcp}: the secret stays in
   * lockstep with 设置, is NEVER written to `~/.codex/config.toml`, and so the
   * MCP JSON editor never shows it or asks the user to re-paste it.
   *
   * The boot seed (`seedApiyiMcpEntry`) force-writes the canonical entry
   * (command/args/base_url/model/timeouts, `enabled = true`) on every boot;
   * this `-c` only overlays the leaf secret (dotted `-c` merges, so the
   * seeded siblings survive).
   *
   * This is the ONLY supported key source. A key hand-typed into the MCP JSON
   * editor does not survive the next boot (the force-seed wipes it), so the
   * launch policy no longer consults config.toml for a key.
   */
  apiyiKey?: string
  /**
   * The user's cinematography-kb-mcp key (设置 → 运镜知识库 → the Alibaba Bailian
   * `DASHSCOPE_API_KEY`). When present we overlay it onto the seeded
   * `[mcp_servers.cinematography_kb].env` table via
   * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY=...` at spawn — the
   * SAME runtime-injection model as {@link apiyiKey}: the secret stays in
   * lockstep with 设置, is NEVER written to `~/.codex/config.toml`, and so the
   * MCP JSON editor never shows it or asks the user to re-paste it.
   *
   * The boot seed (`seedCinematographyKbMcpEntry`) supplies command/args for the
   * entry; this `-c` only overlays the leaf secret (dotted `-c` merges over the
   * seeded — possibly empty — env, so any siblings survive). Tools always list
   * regardless (the server's `tools/list` is static); only the tool CALL needs
   * the key, so a keyless launch stays enabled and simply reports the missing
   * key on first use.
   */
  cinematographyKbKey?: string
  /**
   * The user's DashVector API key (设置 → 运镜知识库 → Sakuga 数据集检索). The
   * bundled cinematography-kb-mcp server also hosts `query_sakuga_dataset`,
   * which searches the Sakuga-42M full-metadata DashVector collection; that
   * call needs its own key (DashVector keys are separate from DashScope keys).
   * Overlaid onto the same seeded `[mcp_servers.cinematography_kb].env` table
   * via `-c mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY=...` at spawn
   * — identical runtime-injection model as {@link cinematographyKbKey}: never
   * persisted to config.toml, keyless launches stay enabled and the tool CALL
   * reports the missing key.
   */
  dashVectorKey?: string
}

function quote(value: string): string {
  return JSON.stringify(value)
}

export function resolveCodexSessionConfig(input?: Partial<CodexSessionConfig>): CodexSessionConfig {
  return {
    approvalPolicy: (input?.approvalPolicy ?? DEFAULT_CODEX_SESSION_CONFIG.approvalPolicy) as CodexApprovalPolicy,
    sandboxMode: (input?.sandboxMode ?? DEFAULT_CODEX_SESSION_CONFIG.sandboxMode) as CodexSandboxMode,
    webSearch: (input?.webSearch ?? DEFAULT_CODEX_SESSION_CONFIG.webSearch) as CodexWebSearchMode,
    personality: (input?.personality ?? DEFAULT_CODEX_SESSION_CONFIG.personality) as CodexPersonality,
    reasoningSummary: (input?.reasoningSummary ?? DEFAULT_CODEX_SESSION_CONFIG.reasoningSummary) as CodexReasoningSummaryMode,
    showRawReasoning: input?.showRawReasoning ?? DEFAULT_CODEX_SESSION_CONFIG.showRawReasoning,
    modelVerbosity: (input?.modelVerbosity ?? DEFAULT_CODEX_SESSION_CONFIG.modelVerbosity) as CodexModelVerbosity,
    notifyOnTurnComplete: input?.notifyOnTurnComplete ?? DEFAULT_CODEX_SESSION_CONFIG.notifyOnTurnComplete,
    memoriesEnabled: input?.memoriesEnabled ?? DEFAULT_CODEX_SESSION_CONFIG.memoriesEnabled,
    writableRoots: [...(input?.writableRoots ?? DEFAULT_CODEX_SESSION_CONFIG.writableRoots)],
  }
}

function serializeScalar(value: string | boolean | number): string {
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

function assertNoReservedProviderConfig(provider: CodexProviderConfig): void {
  if (!provider.extraTopLevelConfig) return
  for (const key of Object.keys(provider.extraTopLevelConfig)) {
    const trimmedKey = key.trim()
    const quote = trimmedKey.at(0)
    const semanticKey = (
      (quote === '"' || quote === "'")
      && trimmedKey.at(-1) === quote
    )
      ? trimmedKey.slice(1, -1).trim()
      : trimmedKey
    if (RESERVED_PROVIDER_TOP_LEVEL_KEYS.has(semanticKey)) {
      throw new Error(`Reserved provider extraTopLevelConfig key "${semanticKey}" is owned by runtime settings`)
    }
    if (key !== trimmedKey || semanticKey !== trimmedKey || !CANONICAL_PROVIDER_TOP_LEVEL_KEY.test(key)) {
      throw new Error(`Invalid provider extraTopLevelConfig key syntax: "${key}"`)
    }
  }
}

export function appendProviderArgs(
  args: string[],
  provider?: CodexProviderConfig,
): string[] {
  if (!provider) return args
  assertNoReservedProviderConfig(provider)
  const id = provider.id
  args.push(
    '-c', `model_provider="${id}"`,
    '-c', `model_providers.${id}.name="${provider.name}"`,
    '-c', `model_providers.${id}.base_url="${provider.baseUrl}"`,
    '-c', `model_providers.${id}.env_key="${provider.envKey}"`,
    // See `CodexProviderConfig` above for why this is mandatory.
    '-c', `model_providers.${id}.wire_api="responses"`,
  )
  if (provider.requiresOpenaiAuth) {
    args.push('-c', `model_providers.${id}.requires_openai_auth=true`)
  }
  if (provider.model) {
    args.push('-c', `model="${provider.model}"`)
  }
  // Memories side requests (extraction "Phase 1" + consolidation "Phase 2")
  // default to codex's own memory models (gpt-5.4 in the bundled build) and
  // are POSTed to the ACTIVE provider's endpoint. On single-model gateways
  // like rightapi.ai/grok that 400s ("端点未配置模型gpt-5.4") on every thread
  // start — non-fatal but wasteful. Pin both documented override keys
  // (developers.openai.com/codex/memories; string table verified in the
  // bundled binary) to `memoriesModel` (the smartest model the endpoint
  // serves) or, failing that, the channel's own chat model — either way the
  // side request always targets a model the endpoint actually has.
  // Channels whose endpoint cannot produce well-formed memory artifacts opt
  // out entirely (see `supportsMemories`); pinning a side-request model would
  // only make the corruption more reliable.
  if (provider.supportsMemories === false) {
    args.push('-c', 'features.memories=false')
  } else {
    const memoriesModel = provider.memoriesModel ?? provider.model
    if (memoriesModel) {
      args.push(
        '-c', `memories.extract_model="${memoriesModel}"`,
        '-c', `memories.consolidation_model="${memoriesModel}"`,
      )
    }
  }
  if (provider.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${provider.reasoningEffort}"`)
  }
  if (provider.verbosity) {
    args.push('-c', `model_verbosity="${provider.verbosity}"`)
  }
  if (provider.extraTopLevelConfig) {
    for (const [key, value] of Object.entries(provider.extraTopLevelConfig)) {
      args.push('-c', `${key}=${serializeScalar(value)}`)
    }
  }
  return args
}

/**
 * Register EXTRA provider tables for per-subagent selection (Path B). Unlike
 * {@link appendProviderArgs}, this NEVER emits the top-level `model_provider`
 * or `model` — it only defines `[model_providers.<id>]` so a subagent started
 * with `modelProvider="<id>"` resolves to this gateway/model. wire_api always
 * resolves to `"responses"` — Codex removed `"chat"` (openai/codex#7782), and
 * emitting it makes the whole `app-server` exit code 1 at config load.
 */
export function appendExtraProviders(
  args: string[],
  extras?: readonly CodexProviderConfig[],
): string[] {
  if (!extras || extras.length === 0) return args
  for (const p of extras) {
    assertNoReservedProviderConfig(p)
    const id = p.id
    args.push(
      '-c', `model_providers.${id}.name="${p.name}"`,
      '-c', `model_providers.${id}.base_url="${p.baseUrl}"`,
      '-c', `model_providers.${id}.env_key="${p.envKey}"`,
      '-c', `model_providers.${id}.wire_api="${p.wireApi ?? 'responses'}"`,
    )
    if (p.requiresOpenaiAuth) {
      args.push('-c', `model_providers.${id}.requires_openai_auth=true`)
    }
  }
  return args
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const modelContextConfig = options?.modelContextConfig ?? null
  if (modelContextConfig !== null) {
    assertCodexModelContextConfig(modelContextConfig)
  }
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  const sessionConfig = resolveCodexSessionConfig(options?.sessionConfig)
  const args: string[] = [
    'app-server',
    '--listen', url,
    '-c', `approval_policy=${quote(sessionConfig.approvalPolicy)}`,
    '-c', `sandbox_mode=${quote(sessionConfig.sandboxMode)}`,
    '-c', `web_search=${quote(sessionConfig.webSearch)}`,
    // Surface chain-of-thought to the chat panel. Codex 0.128's defaults
    // are tuned for `codex exec` / CI logs (raw reasoning hidden, summaries
    // optional), which leaves our "Thought" card permanently empty even
    // when `tokenUsage.reasoningOutputTokens > 0`. Both flags are documented
    // at https://developers.openai.com/codex/config-advanced — we accept the
    // tradeoff that raw reasoning may include sensitive scratchpad content
    // since this is a local dev/agent surface. Since 2026-07 both are user
    // settings (session tuning) whose DEFAULTS reproduce the old hardcoded
    // values (`true` / `"auto"`).
    '-c', `show_raw_agent_reasoning=${sessionConfig.showRawReasoning}`,
    '-c', `model_reasoning_summary=${quote(sessionConfig.reasoningSummary)}`,
    // Official per-tool-call output budget. codex-rs/models-manager/
    // models.json pins truncation at 10_000 tokens for gpt-5.6/5.5/5.4
    // (10_000 bytes for 5.2 and unknown slugs). Without this pin a
    // user-level ~/.codex/config.toml (observed in the wild with
    // `tool_output_token_limit = 64_000`) multiplies every large file read
    // by 6.4x the official budget, ballooning replayed history straight
    // into the gateway byte cap. `-c` outranks config.toml.
    '-c', 'tool_output_token_limit=10000',
    // NOTE (0.143.0): `experimental_use_rmcp_client` was REMOVED from codex —
    // zero hits across the repo at rust-v0.143.0 and gone from
    // config-schema.json. The rmcp client is now the unconditional MCP
    // transport, so URL-based servers (streamable-HTTP + OAuth) start without
    // any flag. We used to pin `-c experimental_use_rmcp_client=true` here
    // (openai/codex#4707, needed since 0.128); keeping it would only emit an
    // "unknown config key" configWarning notice in the chat panel.
    // Subagents (parallel delegation). Codex can spawn specialized worker
    // agents that explore/analyze/tackle work concurrently — but it only does
    // so when explicitly asked, and the concurrency ceiling lives under the
    // `[agents]` table (`agents.max_threads`, default 6). We bump it to 8 so a
    // "spawn one agent per point" / `spawn_agents_on_csv` fan-out isn't
    // bottlenecked, and pin `max_depth=1` (the default — a direct child may
    // spawn, but no deeper recursion, which keeps token/latency cost
    // predictable). Pairs with the shipped `catimation-subagents` skill that
    // teaches the agent WHEN to delegate. Docs: https://developers.openai.com/codex/subagents
    '-c', 'agents.max_threads=8',
    '-c', 'agents.max_depth=1',
    // Expose MCP tools to the model under their BARE names (`ask_user`,
    // `generate_image`, `canvas_snapshot`) instead of the legacy
    // `mcp__catimation__<tool>` prefix (openai/codex feature
    // `non_prefixed_mcp_tool_names`, PR #21576). Codex still maps the bare
    // model-visible name back to the raw server/tool via McpConnectionManager,
    // so OUR handlers receive the identical raw name. This also makes each
    // tool's canonical namespace the bare server name `catimation` (no `mcp__`
    // prefix), which the deferral escape-hatch below keys off.
    '-c', 'features.non_prefixed_mcp_tool_names=true',
    // Keep first-party MCP tools directly visible instead of deferring them behind tool_search.
    '-c', 'features.code_mode.enabled=false',
    '-c', 'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi", "cinematography_kb", "mcp__cinematography_kb"]',
    // ─────────────────────────────────────────────────────────────────────────
    // Native AGENTS.md (project-doc) alignment. The engine already loads
    // AGENTS.md by walking from the `.git` project root down to the thread cwd
    // and concatenating every file found (codex-rs/core/src/agents_md.rs); the
    // thread cwd is `sessionConfig.writableRoots[0]` (the picked workspace
    // folder), so dropping an AGENTS.md / AGENTS.override.md there Just Works.
    // These three knobs make the app's project-doc behavior explicit and richer
    // than the stock defaults:
    //
    //   • project_doc_max_bytes — stock default is ~32 KiB, which silently
    //     truncates larger project constitutions. Pin 64 KiB so a sizable
    //     AGENTS.md is included in full (0 would DISABLE loading entirely).
    //   • project_root_markers — pin the native default (`.git`) explicitly so a
    //     stray `~/.codex/config.toml` can't move the root-detection goalposts;
    //     when no marker is found the engine considers only the cwd.
    //   • project_doc_fallback_filenames — ALSO treat CLAUDE.md / GEMINI.md as
    //     project docs (candidate order: AGENTS.override.md → AGENTS.md →
    //     fallbacks), so cross-tool repos with a Claude/Gemini constitution but
    //     no AGENTS.md still feed their instructions to Codex.
    '-c', 'project_doc_max_bytes=65536',
    '-c', 'project_root_markers=[".git"]',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]',
    // ─────────────────────────────────────────────────────────────────────────
    // Native cross-session MEMORY. Codex ships a first-party memory subsystem
    // (codex-rs/memories/) gated behind the `memories` feature flag —
    // originally verified against the shipped 0.142.2 binary and RE-verified
    // on 0.145.0 via scripts/smoke-codex-memories.ts (`experimentalFeature/
    // list` → name=`memories`, stage=stable since PR #31804,
    // default_enabled=false; NOT the docs-implied `memory`). Enabling it makes
    // the engine, on every NON-ephemeral root session start, run a background
    // two-phase pipeline that distills prior rollouts into
    // `$CODEX_HOME/memories/` — `MEMORY.md` (searchable registry),
    // `memory_summary.md` (injected into context at session start), and
    // `rollout_summaries/` (per-session recaps + evidence). So the agent
    // "remembers" the user's preferences/decisions across chats without us
    // hand-rolling any persistence.
    //
    // Safe to pin here: `-c` lands on the config.toml layer (below `--enable`
    // and cloud gates, above code-default per the documented precedence), and
    // `$CODEX_HOME/memories` is already inside Codex's writable roots — doubly
    // so for us since we run `sandbox_mode="danger-full-access"`, so memory
    // maintenance never triggers an approval.
    //
    // User-facing toggle (设置 → 跨会话记忆): ALWAYS emitted explicitly —
    // `true` or `false`, never omitted — so a future upstream default flip
    // can't silently override the user's OFF choice. Takes effect on the next
    // codex restart. The companion experimental RPCs `thread/memoryMode/set`
    // (per-thread eligibility) and `memory/reset` (wipe the store) are wired
    // through CodexProtocolClient.setThreadMemoryMode / resetMemory
    // (smoke-verified on the 0.145.0 binary).
    '-c', `features.memories=${sessionConfig.memoriesEnabled}`,
  ]

  // Assistant personality (session tuning). 'default' means "let codex
  // resolve its built-in default" — the key is intentionally NOT sent so the
  // wire shape stays identical to pre-setting builds until the user opts in.
  if (sessionConfig.personality !== 'default') {
    args.push('-c', `personality=${quote(sessionConfig.personality)}`)
  }

  // GPT-5 output verbosity (session tuning, batch 2). Same omit-on-'default'
  // posture as personality: codex resolves its own default until the user
  // opts in. Smoke-verified in scripts/smoke-batch2-overlay.ts.
  if (sessionConfig.modelVerbosity !== 'default') {
    args.push('-c', `model_verbosity=${quote(sessionConfig.modelVerbosity)}`)
  }

  // Register the local in-process catimation MCP server so the Codex
  // subprocess can call our `generate_image` (vip channel) and other renderer
  // tools. Without this, Codex has no image tool and confabulates with its own
  // internal `image_gen` — which never produces a real image in the app.
  //
  // The transport enum in codex (`McpServerTransportConfig`) is
  // `#[serde(deny_unknown_fields)]`, so we must NOT emit a `transport` key.
  // Streamable-HTTP is selected purely by the presence of `url`. The custom
  // auth header goes through `http_headers` (a TOML inline table). `-c` values
  // are parsed as TOML, so the quoted string and inline table below are valid.
  if (options?.catimationMcp) {
    const { port, token, stdio } = options.catimationMcp
    if (stdio) {
      // Preferred transport: stdio bridge subprocess. Codex selects stdio
      // purely by the presence of `command` (its transport enum is
      // deny_unknown_fields — never emit a `transport` key). `quote()` is
      // JSON.stringify, whose escaping (`\\` for Windows paths) is valid
      // TOML basic-string escaping, so absolute paths survive `-c` parsing.
      args.push(
        '-c', `mcp_servers.catimation.command=${quote(stdio.command)}`,
        '-c', `mcp_servers.catimation.args=[${stdio.args.map(quote).join(', ')}]`,
      )
      const envEntries = Object.entries(stdio.env)
      if (envEntries.length > 0) {
        args.push(
          '-c',
          `mcp_servers.catimation.env={ ${envEntries.map(([k, v]) => `${quote(k)} = ${quote(v)}`).join(', ')} }`,
        )
      }
    } else {
      args.push(
        '-c', `mcp_servers.catimation.url="http://${CATIMATION_MCP_HOST}:${port}/mcp"`,
        '-c', `mcp_servers.catimation.http_headers={ "${CATIMATION_MCP_TOKEN_HEADER}" = "${token}" }`,
      )
    }
    args.push(
      // LAST-RESORT ceiling only. Codex 0.141's default per-tool timeout is
      // 300s (openai/codex#28234); real calls need much more: a 2K/4K vip
      // image render runs for minutes, and `ask_user` blocks on a HUMAN who
      // may be away for hours (its option card stays valid for 6h — see
      // ASK_USER_TOOL_TIMEOUT_MS in ToolRouter.ts). Every catimation tool is
      // guarded by our own in-process ToolRouter budget (~33min for compute
      // tools, 6h for ask_user), which always returns an explicit result or
      // error, so codex's ceiling only matters if the main process itself
      // wedges. 25000s (~6.9h) keeps it strictly ABOVE the 6h ask window so a
      // late-but-valid click reaches codex instead of codex inventing its own
      // timeout first (which killed the turn while the card still looked
      // clickable — the "过一段时间再点就卡住" bug). Plain seconds
      // (deserialized via `option_duration_secs`).
      '-c', 'mcp_servers.catimation.tool_timeout_sec=25000',
      // Let the agent fire several `generate_image` calls in ONE turn without the
      // turn blocking on each render serially. Codex gates MCP parallelism per
      // server: `ToolRouter::tool_supports_parallel` only returns true when the
      // server name is in `parallel_mcp_server_names`, which is populated from
      // each server's `supports_parallel_tool_calls` config flag (see
      // codex-rs/core/src/tools/router.rs + config/src/mcp_types.rs). With this
      // on, concurrent `generate_image` calls each take a read-lock (instead of
      // the exclusive write-lock), so "一次生成多张图" runs concurrently and each
      // call returns its own saved `paths` / `file://` resource_links the moment
      // that image finishes — no per-call wait stalls the others.
      '-c', 'mcp_servers.catimation.supports_parallel_tool_calls=true',
    )
    // Make our `generate_image` the FIRST (and only) image path. Codex 0.137
    // ships a built-in `imagegen` system skill (installed to
    // `$CODEX_HOME/skills/.system/imagegen`) whose great description out-competes
    // our MCP tool: the agent reads that SKILL.md, looks for the built-in
    // `image_gen` tool — which is NOT exposed over app-server — wastes a turn,
    // and only then falls back to `generate_image`. Disabling it by name removes
    // it from the advertised skills so the agent reaches for `generate_image`
    // straight away (it renders in chat + saves to history; the built-in cannot).
    //
    // `-c` lands on the SessionFlags config layer, which `skill_config_rules_from_stack`
    // honors; the name selector matches the skill's `name: "imagegen"` frontmatter.
    // We only disable it when our tool is actually wired, so a failed MCP bind
    // still leaves the built-in as a fallback ("use whatever works").
    args.push('-c', 'skills.config=[{ name = "imagegen", enabled = false }]')
  }

  // apiyi-mcp launch policy — FORCE mode. The 设置 → API易 key is the ONLY
  // key source (the boot force-seed wipes any hand-typed config.toml key),
  // giving two mutually-exclusive outcomes:
  //
  //   A) key in 设置 → API易 (localStorage → `apiyiKey`): overlay the secret at
  //      runtime via a dotted `-c` (mirrors the catimation pattern) — never
  //      touches config.toml. ALSO force `enabled=true` so a stale
  //      `enabled = false` on disk (old seeds wrote that; users toggled cards
  //      off while debugging) can never keep a keyed apiyi dead. + the
  //      reliability timeouts below.
  //   C) NO key: keep apiyi DORMANT at launch (`enabled=false`). A keyless
  //      apiyi-mcp registers its tool handlers then dies at
  //      `initializeGenAI()`, and codex's `run_turn` awaits `list_all_tools()`
  //      where ONE stalled server gates the whole map until startup_timeout —
  //      so a keyless+enabled apiyi would hang the agent's FIRST TURN for the
  //      full 60s window (openai/codex#19556, #21318; #29321 "skip not-ready
  //      optional servers" is still only a proposal). The boot seed keeps
  //      enabled:true so the card shows apiyi ready-to-go; this `-c` override
  //      keeps it from actually spawning until a key exists. The moment the
  //      user adds a key in 设置 + restarts, (A) enables it.
  //
  // The force-seed (`seedApiyiMcpEntry`) guarantees the entry's canonical
  // transport (`command`/`args`) at boot, so every `-c` below only sets a leaf
  // onto an existing entry — we never synthesize a command-less
  // `[mcp_servers.apiyi]` that codex would reject as "invalid transport".
  const apiyiKey = options?.apiyiKey?.trim()
  if (apiyiKey) {
    // (A) Overlay the leaf secret; dotted `-c` merges over the boot-seeded env
    // (base_url / model / other timeouts survive). Force-enable regardless of
    // what the on-disk entry says — key present means apiyi MUST run.
    args.push(
      '-c', `mcp_servers.apiyi.env.APIYI_API_KEY=${quote(apiyiKey)}`,
      '-c', 'mcp_servers.apiyi.enabled=true',
    )
    // (A) Reliability timeouts — the OTHER half of "why catimation always
    // returns tools and apiyi sometimes doesn't". apiyi-mcp is a real external
    // `node index.js` process (not catimation's in-process bridge), so:
    //   • startup_timeout_sec=60 — a cold node boot + MCP `initialize`
    //     handshake can intermittently blow codex's default startup window
    //     (DEFAULT_STARTUP_TIMEOUT, ~10s), leaving the server in the "异"
    //     (errored) state with ZERO tools listed. 60s of slack makes the
    //     listing reliable. This deliberately does NOT shrink to fit the
    //     tool-list RPC budget — a single slow server must never dictate
    //     apiyi's startup window. Instead the LIST side is made resilient:
    //     `CodexProtocolClient.listMcpServers` runs on its own 90s budget
    //     (> this 60s, see MCP_LIST_TIMEOUT_MS) and a list timeout degrades
    //     SILENTLY (status keeps arriving via `mcp_status_updated`
    //     notifications), so one slow server can't blank the whole panel.
    //   • tool_timeout_sec=2000 — per tool CALL (not startup); understanding
    //     jobs (video/音频/PDF via Gemini) routinely run minutes; apiyi-mcp's
    //     own GEMINI_TIMEOUT is 1800000ms (30min), so codex must wait at least
    //     that long or it aborts mid-flight. 2000s > 1800s, matching
    //     catimation. (Safe — does not affect the startup/list path above.)
    args.push(
      '-c', 'mcp_servers.apiyi.startup_timeout_sec=60',
      '-c', 'mcp_servers.apiyi.tool_timeout_sec=2000',
    )
  } else {
    // (C) No key in 设置 → dormant, see rationale above.
    args.push('-c', 'mcp_servers.apiyi.enabled=false')
  }

  // cinematography-kb-mcp key overlay (设置 → 运镜知识库). Dotted `-c` merges the
  // leaf secret over the boot-seeded (possibly empty) env. Unlike apiyi we do
  // NOT gate the server on the key: `tools/list` is static so the tool always
  // appears; a keyless CALL just returns a "DASHSCOPE_API_KEY is not set"
  // message. So we only overlay when a key exists and never disable otherwise.
  const cinematographyKbKey = options?.cinematographyKbKey?.trim()
  if (cinematographyKbKey) {
    args.push(
      '-c',
      `mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY=${quote(cinematographyKbKey)}`,
    )
  }

  // DashVector key overlay for query_sakuga_dataset (same server, own secret —
  // DashVector clusters use their own API keys, distinct from DashScope). Same
  // non-gating policy: only overlay when present, never disable.
  const dashVectorKey = options?.dashVectorKey?.trim()
  if (dashVectorKey) {
    args.push(
      '-c',
      `mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY=${quote(dashVectorKey)}`,
    )
  }

  // Non-secret cluster host for query_sakuga_dataset — always overlay so app
  // agents hit the paid 1.1M collection even when config.toml predates the bake.
  const dashVectorEndpoint = CINEMATOGRAPHY_KB_ENV_SCAFFOLD.DASHVECTOR_ENDPOINT?.trim()
  if (dashVectorEndpoint) {
    args.push(
      '-c',
      `mcp_servers.cinematography_kb.env.DASHVECTOR_ENDPOINT=${quote(dashVectorEndpoint)}`,
    )
  }

  // Workspace roots ride on the `sandbox_workspace_write.writable_roots`
  // config key. Do NOT use `--add-dir`: that flag only exists on the `codex`
  // TUI / `codex exec` entrypoints (openai/codex PR #5335) — `codex app-server`
  // rejects it with exit code 2, which used to kill every provider-switch
  // restart once a workspace folder had been selected. Upstream confirms the
  // config-key form is the supported equivalent (openai/codex issue #18448).
  if (sessionConfig.writableRoots.length > 0) {
    args.push(
      '-c',
      `sandbox_workspace_write.writable_roots=[${sessionConfig.writableRoots.map(quote).join(', ')}]`,
    )
  }

  const withActive = appendProviderArgs(args, options?.provider)
  const withProviders = appendExtraProviders(withActive, options?.extraProviders)
  // Runtime settings are authoritative. When pinned, append both reserved keys
  // after every provider override so Codex's last-wins `-c` precedence cannot
  // be hijacked by a provider preset. When unpinned, omit them entirely so
  // Codex resolves the window + auto-compaction budget per model from its own
  // metadata (presets carrying these keys are rejected upfront by
  // `assertNoReservedProviderConfig`).
  if (modelContextConfig !== null) {
    withProviders.push(
      '-c', `model_context_window=${modelContextConfig.modelContextWindow}`,
      '-c', `model_auto_compact_token_limit=${modelContextConfig.modelAutoCompactTokenLimit}`,
    )
  }
  return withProviders
}
