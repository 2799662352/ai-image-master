import { MIAU_BASE_URL } from '../../shared/miau'
import type { CodexProviderConfig } from './codexLaunch'
import {
  BUILTIN_CHANNELS,
  BUILTIN_GATEWAYS,
  type GatewayPreset,
  type ProviderChannelPreset,
} from './gatewayModelRouting'

/**
 * Provider preset shipped with the app. Extends the runtime
 * `CodexProviderConfig` with UI-only metadata (`description`, `isCustom`) so
 * the Settings page can render a single uniform list of presets + custom
 * gateways.
 */
export interface ProviderPreset extends CodexProviderConfig {
  /** Short human-readable description shown under the segmented control. */
  description?: string
  /** Credential slot shared by multiple channels from the same gateway. */
  credentialId?: string
  /** Optional exact model slugs exposed by a dedicated gateway channel. */
  allowedModels?: readonly string[]
  /** True for user-added custom providers. Builtins always omit this flag. */
  isCustom?: boolean
}

const APIYI_PRESET: ProviderPreset = {
  id: 'apiyi',
  name: 'API Yi',
  baseUrl: 'https://api.apiyi.com/v1',
  envKey: 'OPENAI_API_KEY',
  description: 'API易 Responses 网关（默认）',
}

const RIGHTCODE_PRESET: ProviderPreset = {
  id: 'rightcode',
  name: 'Right.Codes',
  baseUrl: 'https://rightapi.ai/codex/v1',
  envKey: 'OPENAI_API_KEY',
  model: 'gpt-5.5',
  verbosity: 'high',
  requiresOpenaiAuth: true,
  extraTopLevelConfig: Object.freeze({
    disable_response_storage: true,
    windows_wsl_setup_acknowledged: true,
  }),
  description: 'Pro号池 0.4x · cache_read 1/10 输入价',
}

/**
 * The retired "Right.Codes (正价)" preset id. The `/codex-pro` route 404s
 * since Right.Codes merged it into `/codex` on 2026-06-12, so the preset no
 * longer ships. `CodexProviderStore` remaps persisted state that still
 * references this id onto `'rightcode'` at load time (selected id + saved
 * API key) so upgrading users keep a working provider without re-entering
 * their key.
 */
export const RETIRED_RIGHTCODE_PRO_ID = 'rightcode-pro' as const

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
  // 加速域名(2026-07-28),仅 https 可达。这个常量在每次 spawn 时现读、不落库,
  // 所以改了下次启动即生效,老用户无需迁移。
  // 生产常量。开发期覆盖在主进程侧做(`CodexLocalBackend.withDevGatewayOverride`)——
  // 这类 preset 文件与渲染层共享,顶层不能 import electron。
  baseUrl: MIAU_BASE_URL,
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

/**
 * Dedicated provider-store slot for the bundled cinematography-kb-mcp server's
 * `DASHSCOPE_API_KEY` — the "运镜与结构化描述库" (Alibaba Bailian) retrieval key.
 *
 * Mirrors {@link APIYI_MCP_PROVIDER_ID} exactly: a key-only channel (NOT a codex
 * model_provider). The renderer pushes the 设置 → 运镜知识库 key here via
 * `setProviderApiKey('cinematography-kb', …)`, AgentManager keeps an in-memory
 * copy, and `getCinematographyKbKey` reads it at spawn so `buildCodexLaunchArgs`
 * injects it via `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` —
 * runtime-only, NEVER persisted to `~/.codex/config.toml` (catimation-style).
 * A distinct id keeps this secret decoupled from the codex agent's own gateway
 * key and from the apiyi-mcp key.
 */
export const CINEMATOGRAPHY_KB_PROVIDER_ID = 'cinematography-kb' as const

/**
 * Dedicated provider-store slot for the DashVector API key used by the bundled
 * cinematography-kb-mcp server's `query_sakuga_dataset` tool (Sakuga-42M
 * full-metadata retrieval).
 *
 * Mirrors {@link CINEMATOGRAPHY_KB_PROVIDER_ID} exactly: a key-only channel
 * (NOT a codex model_provider). The renderer pushes the 设置 → 运镜知识库
 * DashVector key here via `setProviderApiKey('dashvector', …)`, AgentManager
 * keeps an in-memory copy, and `getDashVectorKey` reads it at spawn so
 * `buildCodexLaunchArgs` injects it via
 * `-c mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY` — runtime-only,
 * NEVER persisted to `~/.codex/config.toml`. DashVector cluster keys are
 * separate from DashScope keys, hence the distinct slot.
 */
export const DASHVECTOR_PROVIDER_ID = 'dashvector' as const

export { BUILTIN_GATEWAYS, BUILTIN_CHANNELS }
export type { GatewayPreset, ProviderChannelPreset }

/** User-facing builtin gateway cards (Grok channels are internal only). */
export const BUILTIN_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze(APIYI_PRESET),
  Object.freeze(RIGHTCODE_PRESET),
] as const)

/** All four internal channel presets, including Grok routes. */
export const BUILTIN_CHANNEL_PRESETS: readonly ProviderChannelPreset[] = BUILTIN_CHANNELS

/** Alias for gateway presets exported for Task 2+ consumers. */
export const BUILTIN_GATEWAY_PRESETS: readonly GatewayPreset[] = BUILTIN_GATEWAYS

export const DEFAULT_PROVIDER_ID = 'apiyi' as const

/** Legacy channel ids retained for store migration lookups. */
export const LEGACY_GROK_CHANNEL_IDS = Object.freeze([
  'apiyi-grok',
  'rightcode-grok',
] as const)

const BUILTIN_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PROVIDER_PRESETS.map((p) => p.id),
)
const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...BUILTIN_IDS,
  ...BUILTIN_CHANNEL_PRESETS.map((channel) => channel.id),
])

function findInternalChannelProvider(id: string): ProviderPreset | undefined {
  const channel = BUILTIN_CHANNEL_PRESETS.find((preset) => preset.id === id)
  if (!channel) return undefined
  const { gatewayId, ...provider } = channel
  // 通道自己声明了凭据槽就听它的，没声明才回落到所在网关。
  //
  // 曾经无条件写成 `credentialId: gatewayId`，把 qwen 通道显式声明的
  // `credentialId: 'qwen'`（Miau token，与图片生成共用那枚）覆盖掉了 —— 于是选
  // 千问就拿 apiyi/rightcode 的 Key 去打 Miau 端点，必然 401；而设置页还会催用户
  // 去配一枚这条路根本不用的密钥。声明摆在那儿却不生效，比没有声明更难查。
  return { ...provider, credentialId: channel.credentialId || gatewayId }
}

export function isBuiltinProviderId(id: string): boolean {
  if (!id) return false
  return BUILTIN_IDS.has(id)
}

/** Returns true for user-facing Gateway ids and every internal Channel id. */
export function isReservedProviderId(id: string): boolean {
  if (!id) return false
  return RESERVED_PROVIDER_IDS.has(id)
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

/** Returns the persisted credential slot used by a Provider. */
export function credentialIdForProvider(
  id: string,
  customProviders: readonly ProviderPreset[] = [],
): string {
  const provider = findProviderById(id, customProviders)
    ?? findInternalChannelProvider(id)
  return provider?.credentialId || id
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
  return findProviderById(id, customProviders)
    ?? findInternalChannelProvider(id)
    ?? BUILTIN_PROVIDER_PRESETS[0]
}
