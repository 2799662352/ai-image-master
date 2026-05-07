export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

/**
 * Custom Codex model_provider config. When passed, we wire it through the
 * `app-server`'s `-c` overrides so the spawned Codex talks to a third-party
 * OpenAI-compatible gateway (e.g. API易) instead of `api.openai.com`.
 *
 * We deliberately omit `wire_api` and `supports_websockets`:
 * - `wire_api` defaults to `"responses"` in Codex 0.128 (and that is the only
 *   supported value: `"chat"` was removed). Setting it explicitly is noise.
 * - `supports_websockets` defaults to `false` for custom providers, which is
 *   what we want — most third-party gateways proxy the Responses HTTP API but
 *   NOT the `wss://api.openai.com/v1/responses` WebSocket transport.
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
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  const args: string[] = [
    'app-server',
    '--listen', url,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
    // Codex 0.128 `app-server` registers the native Responses `web_search`
    // tool by default (TUI gates it behind `--search`, app-server does not).
    // Most third-party OpenAI-compatible gateways — including API易/apiyi —
    // proxy the Responses endpoint but only honor `function`/`custom` tool
    // types and reject `tools[i].type="web_search"` with a 400. Disabling it
    // here keeps the tools array compatible across providers; users who run
    // against the real OpenAI Responses endpoint can re-enable per-launch
    // via `-c tools.web_search=true`.
    '-c', 'tools.web_search=false',
  ]

  const provider = options?.provider
  if (provider) {
    const id = provider.id
    args.push(
      '-c', `model_provider="${id}"`,
      '-c', `model_providers.${id}.name="${provider.name}"`,
      '-c', `model_providers.${id}.base_url="${provider.baseUrl}"`,
      '-c', `model_providers.${id}.env_key="${provider.envKey}"`,
    )
  }

  return args
}
