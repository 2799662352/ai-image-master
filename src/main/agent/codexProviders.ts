import type { CodexProviderConfig } from './codexLaunch'

/**
 * Provider preset shipped with the app. Extends the runtime
 * `CodexProviderConfig` with UI-only metadata (`description`, `isCustom`) so
 * the Settings page can render a single uniform list of presets + custom
 * gateways.
 */
export interface ProviderPreset extends CodexProviderConfig {
  /** Short human-readable description shown under the segmented control. */
  description?: string
  /** True for user-added custom providers. Builtins always omit this flag. */
  isCustom?: boolean
}

const APIYI_PRESET: ProviderPreset = {
  id: 'apiyi',
  name: 'API Yi',
  baseUrl: 'https://api.apiyi.com/v1',
  envKey: 'OPENAI_API_KEY',
  // apiyi accepts whatever model id the gateway proxies; we let users pick
  // via codex's `/model` command at runtime, so we don't pin a model here.
  // gpt-5.5 is still our internal "default agent model" used by the
  // ThreadTitleSummarizer (see AgentManager.DEFAULT_AGENT_MODEL).
  description: 'API易 Responses 网关（默认）',
}

/**
 * Right Code (https://www.right.codes) preset — values pinned to the
 * official docs at https://docs.right.codes/docs/rc_cli_config/codex.html
 * (last verified 2026-05). When their docs change, update this preset and
 * bump the unit test in `codexProviders.test.ts`.
 *
 * Why we pin every flag explicitly:
 *  - `model="gpt-5.2"` + `model_reasoning_effort="xhigh"` are the documented
 *    "qualifying" model for Right Code's Codex route. Without them the
 *    server falls back to weaker routing.
 *  - `disable_response_storage=true` follows the docs' privacy posture and
 *    matches what most OpenAI-compatible gateways expect (no upstream
 *    storage of inputs).
 *  - `windows_wsl_setup_acknowledged=true` quiets the first-run warning
 *    `codex` emits on Windows when WSL is not detected. Harmless on macOS /
 *    Linux (Codex ignores it).
 *  - `requires_openai_auth=true` tells codex this gateway expects the
 *    `Authorization: Bearer <OPENAI_API_KEY>` shape.
 */
const RIGHTCODE_PRESET: ProviderPreset = {
  id: 'rightcode',
  name: 'Right.Codes (日抛plus)',
  // /codex endpoint = "Codex 日抛plus" (0.2x billing). Cheapest tier with full
  // prompt-cache support. Per docs.right.codes/docs/rc_cli_config/codex.html
  // and verified at https://www.right.codes/models, this endpoint **only**
  // accepts /v1/responses — never /v1/chat/completions. Our Codex CLI uses
  // wire_api="responses" so we're safe; do not let users override that field
  // for this preset (the Settings UI doesn't expose wire_api anyway).
  baseUrl: 'https://right.codes/codex/v1',
  envKey: 'OPENAI_API_KEY',
  model: 'gpt-5.2',
  reasoningEffort: 'xhigh',
  verbosity: 'high',
  requiresOpenaiAuth: true,
  extraTopLevelConfig: Object.freeze({
    disable_response_storage: true,
    windows_wsl_setup_acknowledged: true,
  }),
  description: '日抛池 0.2x · cache_read $0.035/M · gpt-5.2 xhigh',
}

/**
 * Right Code "正价" route (`/codex-pro`, 0.4x billing). Recommended fallback
 * when the cheaper `/codex` (rightcode) is rate-limited or showing high error
 * rates — Right Code's own homepage banner currently advises switching to
 * `/codex-pro` "for high-stability requirements". Same caching policy as
 * rightcode (cache_create $0/M, cache_read at 1/10 of input) but at 2x the
 * input price. We keep it as a separate preset so users can swap in one click.
 */
const RIGHTCODE_PRO_PRESET: ProviderPreset = {
  id: 'rightcode-pro',
  name: 'Right.Codes (正价)',
  baseUrl: 'https://right.codes/codex-pro/v1',
  envKey: 'OPENAI_API_KEY',
  model: 'gpt-5.2',
  reasoningEffort: 'xhigh',
  verbosity: 'high',
  requiresOpenaiAuth: true,
  extraTopLevelConfig: Object.freeze({
    disable_response_storage: true,
    windows_wsl_setup_acknowledged: true,
  }),
  description: '正价池 0.4x · 高稳定性兜底 · cache_read $0.07/M',
}

/**
 * Provider id + config for the qwen UNDERSTANDING capability (Path B). This is
 * NOT a selectable active agent provider — it is registered as an EXTRA
 * `[model_providers.qwen]` table so a subagent can run on it via
 * `modelProvider="qwen"` for video/document/web understanding. It rides the
 * same new-api gateway + Miau token as image generation:
 *  - base_url: the antigravity new-api gateway's OpenAI-compatible /v1 root;
 *  - env_key:  MIAU_API_KEY (injected at spawn from the persisted Miau token,
 *              stored under apiKeys['qwen']);
 *  - wire_api: "responses" — MANDATORY. Codex **removed** `wire_api = "chat"`
 *    (openai/codex#7782; hard error since ~Feb 2026). A "chat" value here made
 *    `codex app-server` exit code 1 at config load, which bricked the ENTIRE
 *    backend (every method threw "called before start"). The gateway must
 *    expose `/v1/responses` for a qwen *subagent* to work. NOTE: the primary
 *    understanding path does NOT depend on this provider at all — the
 *    `understand_video/document/web_research/canvas_video` MCP tools call the
 *    gateway's `/v1/chat/completions` directly via the renderer
 *    (ApiService.understand), so understanding keeps working regardless.
 *
 * Model defaults to `qwen3.7-plus-dashscope` (cheaper). A subagent may override
 * per-spawn with `model="qwen3.7-max-dashscope"` for the stronger model (the
 * launch config sets the provider's default; the spawn can pin model).
 */
export const QWEN_UNDERSTAND_PROVIDER_ID = 'qwen' as const

export const QWEN_UNDERSTAND_PROVIDER: CodexProviderConfig = {
  id: QWEN_UNDERSTAND_PROVIDER_ID,
  name: 'Qwen Understanding (DashScope via new-api)',
  baseUrl: 'http://175.178.198.17:3000/v1',
  envKey: 'MIAU_API_KEY',
  model: 'qwen3.7-plus-dashscope',
  wireApi: 'responses',
}

/**
 * Dedicated provider-store slot for the bundled apiyi-mcp server's `APIYI_API_KEY`.
 *
 * This is NOT a codex model_provider — it is a key-only channel, mirroring how
 * {@link QWEN_UNDERSTAND_PROVIDER_ID} ('qwen') stashes the Miau token. We use a
 * distinct id (`'apiyi-mcp'`, never the real `'apiyi'` gateway provider) so the
 * MCP secret stays decoupled from the codex agent's own API易 gateway key: the
 * renderer pushes the 设置 → API易 key here via `setProviderApiKey('apiyi-mcp', …)`,
 * AgentManager keeps an in-memory copy, and `getApiyiKey` reads it at spawn so
 * `buildCodexLaunchArgs` injects it via `-c mcp_servers.apiyi.env.APIYI_API_KEY`
 * — runtime-only, never persisted to `~/.codex/config.toml` (catimation-style).
 */
export const APIYI_MCP_PROVIDER_ID = 'apiyi-mcp' as const

export const BUILTIN_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze(APIYI_PRESET),
  Object.freeze(RIGHTCODE_PRESET),
  Object.freeze(RIGHTCODE_PRO_PRESET),
] as const)

export const DEFAULT_PROVIDER_ID = 'apiyi' as const

const BUILTIN_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PROVIDER_PRESETS.map((p) => p.id),
)

export function isBuiltinProviderId(id: string): boolean {
  if (!id) return false
  return BUILTIN_IDS.has(id)
}

export function findProviderById(
  id: string,
  customProviders: readonly ProviderPreset[] = [],
): ProviderPreset | undefined {
  return (
    BUILTIN_PROVIDER_PRESETS.find((p) => p.id === id) ??
    customProviders.find((p) => p.id === id)
  )
}

/**
 * Resolve the provider config to forward to `buildCodexLaunchArgs`. Falls
 * back to the apiyi preset when `id` does not match anything in the builtin
 * + custom set — this preserves pre-v4.3 behaviour where we hard-coded apiyi
 * and avoids spawning Codex with no provider config (which would route
 * traffic to api.openai.com and break gateway-only API keys).
 */
export function resolveActiveProvider(
  id: string,
  customProviders: readonly ProviderPreset[] = [],
): ProviderPreset {
  return findProviderById(id, customProviders) ?? BUILTIN_PROVIDER_PRESETS[0]
}
