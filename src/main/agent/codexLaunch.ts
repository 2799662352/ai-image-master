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
  ]

  for (const root of sessionConfig.writableRoots) {
    args.push('--add-dir', root)
  }

  return appendProviderArgs(args, options?.provider)
}
