import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionConfig,
} from '../../types/agent'

export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

export const DEFAULT_CODEX_SESSION_CONFIG: CodexSessionConfig = {
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  webSearch: true,
  writableRoots: [],
}

/**
 * Custom Codex model_provider config. When passed, we wire it through the
 * `app-server`'s `-c` overrides so the spawned Codex talks to a third-party
 * OpenAI-compatible gateway (e.g. API易) instead of `api.openai.com`.
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
 */
export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
}

export interface CodexLaunchOptions {
  listenUrl?: string
  provider?: CodexProviderConfig
  sessionConfig?: Partial<CodexSessionConfig>
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function resolveSessionConfig(input?: Partial<CodexSessionConfig>): CodexSessionConfig {
  return {
    approvalPolicy: (input?.approvalPolicy ?? DEFAULT_CODEX_SESSION_CONFIG.approvalPolicy) as CodexApprovalPolicy,
    sandboxMode: (input?.sandboxMode ?? DEFAULT_CODEX_SESSION_CONFIG.sandboxMode) as CodexSandboxMode,
    webSearch: input?.webSearch ?? DEFAULT_CODEX_SESSION_CONFIG.webSearch,
    writableRoots: input?.writableRoots ?? DEFAULT_CODEX_SESSION_CONFIG.writableRoots,
  }
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
  return args
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  const sessionConfig = resolveSessionConfig(options?.sessionConfig)
  const args: string[] = [
    'app-server',
    '--listen', url,
    '-c', `approval_policy=${quote(sessionConfig.approvalPolicy)}`,
    '-c', `sandbox_mode=${quote(sessionConfig.sandboxMode)}`,
    '-c', `tools.web_search=${sessionConfig.webSearch ? 'true' : 'false'}`,
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
  ]

  for (const root of sessionConfig.writableRoots) {
    args.push('--add-dir', root)
  }

  return appendProviderArgs(args, options?.provider)
}
