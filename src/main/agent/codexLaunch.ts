import { CATIMATION_MCP_HOST, CATIMATION_MCP_TOKEN_HEADER } from '../mcp/config'
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexWebSearchMode,
} from '../../types/agent'

export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

export const DEFAULT_CODEX_SESSION_CONFIG: CodexSessionConfig = {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  webSearch: 'live',
  writableRoots: [],
}

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
 * (https://docs.right.codes/docs/rc_cli_config/codex.html) — works out of the
 * box without forcing the user to hand-edit `~/.codex/config.toml`.
 */
export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
  /** Optional. When set, becomes `-c model="..."`. */
  model?: string
  /** Optional. When set, becomes `-c model_reasoning_effort="..."`. */
  reasoningEffort?: string
  /** Optional. When set, becomes `-c model_verbosity="..."`. */
  verbosity?: string
  /** Optional. When true, becomes `-c model_providers.<id>.requires_openai_auth=true`. */
  requiresOpenaiAuth?: boolean
  /**
   * Optional. Each entry becomes `-c <key>=<value>`. Use for top-level
   * scalar overrides not modelled above (e.g. `disable_response_storage`,
   * `windows_wsl_setup_acknowledged`). Booleans/numbers serialize bare;
   * strings serialize as `key="value"`.
   */
  extraTopLevelConfig?: Readonly<Record<string, string | boolean | number>>
}

export interface CodexLaunchOptions {
  listenUrl?: string
  provider?: CodexProviderConfig
  sessionConfig?: Partial<CodexSessionConfig>
  /**
   * Local in-process catimation MCP server (port + per-session token). When
   * present we inject an ephemeral `[mcp_servers.catimation]` entry via `-c`
   * so the Codex subprocess can actually reach our `generate_image` /
   * `query_history` / UI tools. Injecting via `-c` (instead of writing the
   * user's `~/.codex/config.toml`) keeps the entry in lockstep with the
   * current session's dynamic port/token and never leaves stale config behind.
   */
  catimationMcp?: { port: number; token: string }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

export function resolveCodexSessionConfig(input?: Partial<CodexSessionConfig>): CodexSessionConfig {
  return {
    approvalPolicy: (input?.approvalPolicy ?? DEFAULT_CODEX_SESSION_CONFIG.approvalPolicy) as CodexApprovalPolicy,
    sandboxMode: (input?.sandboxMode ?? DEFAULT_CODEX_SESSION_CONFIG.sandboxMode) as CodexSandboxMode,
    webSearch: (input?.webSearch ?? DEFAULT_CODEX_SESSION_CONFIG.webSearch) as CodexWebSearchMode,
    writableRoots: [...(input?.writableRoots ?? DEFAULT_CODEX_SESSION_CONFIG.writableRoots)],
  }
}

function serializeScalar(value: string | boolean | number): string {
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

export function appendProviderArgs(
  args: string[],
  provider?: CodexProviderConfig,
): string[] {
  if (!provider) return args
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

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
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
    // since this is a local dev/agent surface.
    '-c', 'show_raw_agent_reasoning=true',
    '-c', 'model_reasoning_summary="auto"',
    // Tell Codex the model's hard context limit so its tokenUsage
    // notifications carry `contextWindow`, and so it auto-compacts before
    // running into a wall. 200K matches GPT-5.5 / GPT-5.4 on apiyi; the
    // auto_compact threshold is 90% of that, the documented Codex default
    // ratio. See https://developers.openai.com/codex/config-advanced.
    '-c', 'model_context_window=200000',
    '-c', 'model_auto_compact_token_limit=180000',
    // Enable rmcp transport so URL-based MCP servers (e.g.
    // `[mcp_servers.context7] url = "https://mcp.context7.com/mcp"`) are
    // actually started. With Codex 0.128, omitting this flag silently skips
    // streamable-HTTP servers without surfacing an error. See
    // openai/codex#4707 — every workaround in that thread sets it at the top
    // of `config.toml`. We pin it via `-c` instead so users don't have to
    // edit any file by hand. OAuth login and tool-call surfaces both require
    // this client on the server side.
    '-c', 'experimental_use_rmcp_client=true',
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
  ]

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
    const { port, token } = options.catimationMcp
    args.push(
      '-c', `mcp_servers.catimation.url="http://${CATIMATION_MCP_HOST}:${port}/mcp"`,
      '-c', `mcp_servers.catimation.http_headers={ "${CATIMATION_MCP_TOKEN_HEADER}" = "${token}" }`,
      // Give `generate_image` room to finish. Codex's default per-tool timeout
      // (`mcp_servers.<name>.tool_timeout_sec`) is short relative to a real
      // image render on the vip channel — at 2K/4K high quality a single call
      // can run for minutes. When Codex aborts first, the agent narrates a
      // "tool timed out" and retries, even though the renderer kept going and
      // the image actually completed + saved. ~2000s makes Codex wait for the
      // real result (or an explicit error) instead of inventing a timeout. The
      // value is plain seconds (codex deserializes it via `option_duration_secs`).
      '-c', 'mcp_servers.catimation.tool_timeout_sec=2000',
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

  for (const root of sessionConfig.writableRoots) {
    args.push('--add-dir', root)
  }

  return appendProviderArgs(args, options?.provider)
}
