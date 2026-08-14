import type {
  AgentGatewayRecord,
  AgentModelFamily,
  AgentModelRoute,
} from '../../types/agent'
import type {
  CodexProviderConfig,
  ProviderCompatibilityPolicy,
} from './codexLaunch'
import type { ProviderPreset } from './codexProviders'
import { MIAU_BASE_URL } from '../../shared/miau'

/** User-facing gateway card with its internal channel ids. */
export interface GatewayPreset extends AgentGatewayRecord {
  channelIds: string[]
}

/** Internal provider channel wired into Codex launch config. */
export interface ProviderChannelPreset extends CodexProviderConfig {
  id: string
  gatewayId: string
  /**
   * Fixed allow-list for single-family / pinned channels. When set, routing
   * rejects any model outside this list (e.g. grok / claude pools).
   */
  allowedModels?: readonly string[]
  /**
   * Additive catalog rows for open channels (no routing whitelist). Use when a
   * gateway sells a slug that Codex `model/list` never returns — e.g. Right.Codes
   * `gpt-5.5-openai-compact` — so the picker still offers it.
   */
  extraCatalogModels?: readonly string[]
  compatibilityPolicy: ProviderCompatibilityPolicy
}

export type AuthorizedGatewayRouteContext =
  | { source: 'builtin'; gatewayId: string }
  | { source: 'model-catalog'; gatewayId: string }

/**
 * Thrown when a model is not in the fixed `allowedModels` list of the
 * builtin Channel its inferred family would route it to (e.g. an
 * unrecognized Grok variant on a single-model Grok Channel). Callers that
 * aggregate many models from an untrusted list (dynamic `model/list` rows)
 * can catch this specific type to skip just the offending row instead of
 * failing the whole catalog.
 */
export class ModelUnavailableInGatewayError extends Error {
  constructor(readonly modelId: string, readonly gatewayId: string) {
    super(`Model "${modelId}" is unavailable in gateway "${gatewayId}"`)
    this.name = 'ModelUnavailableInGatewayError'
  }
}

/**
 * 通义千问在 Miau(new-api)网关上的可选模型。
 *
 * 这三个 slug 之前只作**后台**用途存在:`QWEN_UNDERSTAND_PROVIDER` 是一个不可选的
 * 额外 provider,给子代理(`modelProvider="qwen"`)和 MCP 理解工具用。现在同样的
 * 端点被登记成正式 Channel,于是它们出现在对话栏里、可以直接当主模型驱动。
 *
 * 协议:Miau 提供**完整的 OpenAI 兼容 Responses 转发**(含 reasoning/usage),
 * ⚠️ 下面这段结论**只对文本成立**,工具调用需要 namespace 桥(见 qwenChannel 里的
 * 说明)。保留原文是为了记住教训:「转发完整」这个判断当时只拿对话验过。
 *
 * 原文:所以 `compatibilityPolicy: 'none'` —— 既不需要 grok 那套 namespace 桥,也不需要
 * Claude 那套 Messages 翻译。依据是接入说明 2026-08-06「Responses:兼容模式
 * responses(网关已有完整转发)」与其测试服实测(返回含 reasoning + message +
 * usage,`x_billing_type: "response_api"`)。
 */
const QWEN_MIAU_MODELS = Object.freeze([
  'qwen3.7-plus-dashscope',
  'qwen3.7-max-dashscope',
  'qwen3.8-max',
])

/**
 * Miau 的 base URL 与 Key。
 *
 * `credentialId: 'qwen'` 是关键:Miau 用的**不是**所在网关(apiyi / rightcode)的
 * Key,而是早就存在 `apiKeys['qwen']` 里的那枚 Miau token —— 也就是理解工具和
 * qwen 子代理一直在用的同一枚。所以用户不必为此重新配置任何东西。
 *
 * ⚠️ 给后来维护的人:**同一个 Miau 端点在两个网关下各注册了一次**,这是过渡态。
 * 一个 Channel 只能属于一个 gatewayId(见 `ProviderChannelPreset`),而我们希望
 * 无论用户当前选 apiyi 还是 rightcode,都能在对话栏里看到 qwen —— 所以只能重复
 * 一份。后续把 apiyi / rightcode 都并入 Miau 之后,这两条应当合并成一条。
 */
function qwenChannel(gatewayId: 'apiyi' | 'rightcode'): ProviderChannelPreset {
  return Object.freeze({
    id: `${gatewayId}-qwen`,
    gatewayId,
    name: '通义千问 (Miau)',
    baseUrl: MIAU_BASE_URL,
    envKey: 'MIAU_API_KEY',
    credentialId: 'qwen',
    model: 'qwen3.7-max-dashscope',
    allowedModels: QWEN_MIAU_MODELS,
    // ⚠️ 曾经是 'none',那是**只验了对话没验工具**得出的结论。
    //
    // 文本、reasoning、usage 确实都能完整转发回来 —— 但工具调用是另一回事:
    // codex 把每个 MCP 工具包进 `{"type":"namespace",...}`(Responses API 的
    // OpenAI 私有扩展,见 openai/codex#23186)。标准 OpenAI 兼容后端不认这个
    // 类型,反应分两种:明确报错(LM Studio / OpenRouter),或者**静默丢弃**
    // 后照常返回 200(llama.cpp / Ollama / 我们这条)。
    //
    // 静默那种最难查:没有任何报错,只是模型压根看不见工具。它于是发出一个
    // 认不出的调用,codex 的分发器(core/src/tools/router.rs)落到
    // `unsupported call: ` 丢弃,回合就此结束;模型再说一遍要读文件、再被丢掉
    // —— 实测一次会话刷出 59 条,用户看到的是 agent 反复宣布同一个计划却不动手。
    //
    // 上游那个逃生开关(`namespace_tools`)是坏的:false 分支把 namespace 工具
    // 整个过滤掉而不是展开(openai/codex#32318),关了照样用不了。所以只能自己
    // 垫桥 —— 而这座桥我们给 grok 早就写好了(`flattenNamespaceTools`),它做的
    // 正是社区 codex-ollama-proxy 那套:摊平成标准 function,回程按
    // `namespace__name` 映射回去。
    compatibilityPolicy: 'responses-namespace-bridge',
  })
}

const QWEN_CHANNELS: readonly ProviderChannelPreset[] = Object.freeze([
  qwenChannel('apiyi'),
  qwenChannel('rightcode'),
])

const BUILTIN_GATEWAYS: readonly GatewayPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi',
    name: 'API Yi',
    description: 'API易 Responses 网关',
    credentialId: 'apiyi',
    defaultChannelId: 'apiyi-standard',
    channelIds: ['apiyi-standard', 'apiyi-grok', 'apiyi-claude', 'apiyi-qwen'],
  }),
  Object.freeze({
    id: 'rightcode',
    name: 'Right.Codes',
    description: 'Right.Codes Codex、Grok 与 DeepSeek 网关',
    credentialId: 'rightcode',
    defaultChannelId: 'rightcode-standard',
    channelIds: ['rightcode-standard', 'rightcode-grok', 'rightcode-deepseek', 'rightcode-claude', 'rightcode-qwen'],
  }),
])

const BUILTIN_CHANNELS: readonly ProviderChannelPreset[] = Object.freeze([
  Object.freeze({
    id: 'apiyi-standard',
    gatewayId: 'apiyi',
    name: 'API Yi',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    // Full apiyi endpoint serves gpt-5.5 — run background memory
    // extraction/consolidation on it instead of codex's gpt-5.4 default.
    memoriesModel: 'gpt-5.5',
    compatibilityPolicy: 'none',
    // Measured: `scripts/smoke-subagents.ts --v2` against this endpoint spawns
    // a child that receives its task, replies, and is reported back by the
    // parent — so the encrypted-payload failure of upstream #34833 does not
    // reach here. V2 buys named agents (`/root/pong_agent`) over V1's bare ids.
    multiAgentV2: true,
  }),
  Object.freeze({
    id: 'apiyi-grok',
    gatewayId: 'apiyi',
    name: 'API Yi Grok',
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    allowedModels: Object.freeze(['grok-4.5']),
    // Same full apiyi endpoint as apiyi-standard (only the chat model is
    // pinned to grok) — memories can use the smarter gpt-5.5.
    memoriesModel: 'gpt-5.5',
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-standard',
    gatewayId: 'rightcode',
    name: 'Right.Codes',
    baseUrl: 'https://rightapi.ai/codex/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
    // Sold on /codex/v1 but absent from Codex's bundled model/list — without
    // this additive row the picker never offers it on a live catalog.
    extraCatalogModels: Object.freeze(['gpt-5.5-openai-compact']),
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'none',
    // Same live check as apiyi-standard: a spawned child replied and the parent
    // relayed it. Both GPT pools verified; the Claude and Grok channels are
    // deliberately left on V1 until they get the same treatment behind their
    // compatibility bridges.
    multiAgentV2: true,
  }),
  Object.freeze({
    id: 'rightcode-grok',
    gatewayId: 'rightcode',
    name: 'Right.Codes Grok',
    baseUrl: 'https://rightapi.ai/grok/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'grok-4.5',
    // 4.6 is sold on this same `/grok` endpoint at 4.5's price. Listing it here
    // is what makes it routable AND visible: the catalog builder seeds its rows
    // from `allowedModels`, and anything outside the list is rejected by
    // `ModelUnavailableInGatewayError` even when the endpoint would serve it.
    //
    // The channel default stays 4.5 — flipping it would silently move every
    // user who never picked a model explicitly. API Yi is deliberately NOT
    // given 4.6: we have only confirmed the slug on Right.Codes, and offering
    // it on a gateway that does not sell it produces a 404 per turn.
    allowedModels: Object.freeze(['grok-4.6', 'grok-4.5']),
    requiresOpenaiAuth: true,
    // xAI-backed channel: needs the proxy's input-null sanitize (codex replays
    // reasoning history with `content: null`, which xAI's ModelInput rejects
    // with 422 on every second turn) plus namespace flatten/restore so
    // subagent tools stay callable instead of being stripped upstream.
    compatibilityPolicy: 'responses-namespace-bridge',
  }),
  Object.freeze({
    id: 'rightcode-deepseek',
    gatewayId: 'rightcode',
    name: 'Right.Codes DeepSeek',
    // Official OpenAI-format pool at `/deepseek` (Right.Codes model list,
    // 官方正价渠道, 官方同价). DeepSeek V4 natively speaks the Responses API
    // (`POST /responses`, https://api-docs.deepseek.com/api/create-response)
    // — slugs `deepseek-v4-flash` / `deepseek-v4-pro` only.
    //
    // Two sibling pools on the same vendor are deliberately unused:
    // `/deepseek/anthropic` speaks Messages, which would need the Claude
    // bridge for no gain (Codex already speaks Responses); `/cn-sale` lists
    // the same slugs at 0.3x from a self-hosted box the vendor itself tags
    // as 稳定性差. Official-price `/deepseek` is the one we can stand behind.
    //
    // Native Responses is not the same as "codex can talk to it unbridged":
    // Codex wraps MCP tools as `{"type":"namespace"}` (openai/codex#23186),
    // and DeepSeek's docs say unknown tool types are ignored. That is the
    // silent-drop failure the qwen channel already hit — flatten/restore
    // here for the same reason, not because the wire protocol is foreign.
    baseUrl: 'https://rightapi.ai/deepseek/v1',
    envKey: 'OPENAI_API_KEY',
    // Official default chat is Flash (the cheap/fast size). Flipping this
    // to Pro would silently move every user who never picked a model.
    model: 'deepseek-v4-flash',
    allowedModels: Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']),
    requiresOpenaiAuth: true,
    compatibilityPolicy: 'responses-namespace-bridge',
    // This host lists only the two V4 slugs. A GPT memoriesModel would
    // 400 the same way it does on rightcode-grok; leave unset so side
    // requests ride the channel's own chat model.
  }),
  Object.freeze({
    id: 'rightcode-claude',
    gatewayId: 'rightcode',
    name: 'Right.Codes Claude',
    // Same host as the codex/grok channels, different path: this is the
    // vendor's Anthropic-native pool (Messages API, `x-api-key`), the only one
    // of the three that does NOT speak Responses. The `/claude` sibling
    // endpoint is unusable for us — it fingerprints clients and 400s anything
    // that isn't Claude Code.
    //
    // The pool used to live on `right.codes`, which the vendor has since
    // announced as blocked on mainland networks (path and behaviour unchanged
    // on the new host). Blocked here does not mean refused: connections hang
    // until they time out, so a user on a mainland network saw Claude turns sit
    // there with no error at all.
    //
    // Two quirks of this pool worth knowing before reading token numbers:
    // it prepends its own ~1140-token hidden system prompt (our instructions
    // land after it, and it shows up as cache-read input on every request),
    // and `claude-fable-5` is silently swapped for `claude-opus-4-8` under a
    // content-refusal policy, announced only through a non-standard
    // `{"type":"fallback"}` content block that no SDK — ours included — will
    // surface. Fable is therefore deliberately absent from `allowedModels`:
    // offering a model that never actually runs is worse than not offering it.
    // Date-suffixed slugs 404 here, so they stay out too.
    baseUrl: 'https://rightapi.ai/claude-sale/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'claude-opus-5',
    allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5']),
    requiresOpenaiAuth: true,
    // Anthropic-native upstream: the bridge translates Responses ⇆ Messages
    // in-process because Codex has no Anthropic wire protocol.
    compatibilityPolicy: 'anthropic-messages-bridge',
    // Off because this pool inserts its own breakpoints, so ours are redundant
    // weight against Anthropic's 4-block cap. Measured directly on the
    // upstream's usage block (not the translated one, which under-reported
    // cache counters until `anthropicUsageRepair` landed): a never-before-sent
    // prefix carrying NO `cache_control` billed `cache_creation: 8762` and then
    // read all 8762 back on the repeat. Caching demonstrably works here — the
    // earlier "writes but never reads" reading was the usage bug, not the pool.
    promptCacheBreakpoints: false,
    // See `CodexProviderConfig.supportsMemories`: the memory pipeline's two
    // phases write malformed artifacts on Claude, and the usual escape hatch
    // (`memoriesModel` → a GPT slug) does not reach here. The gateway does sell
    // gpt-5.5, but on its `/codex/v1` sibling host, and `memoriesModel` renames
    // the model without moving the endpoint. On this host `/models` lists 8
    // slugs and none is a GPT, and gpt-5.5 is refused `503 Pricing
    // configuration is temporarily unavailable` on both `/messages` and
    // `/responses` across repeated attempts — while the same key gets 200 for
    // gpt-5.5 on `/codex/v1` and for claude-opus-5 here.
    supportsMemories: false,
  }),
  Object.freeze({
    id: 'apiyi-claude',
    gatewayId: 'apiyi',
    name: 'API Yi Claude',
    // Same host as the other apiyi channels, reached over the Anthropic-native
    // Messages path rather than Responses. `/v1/responses` does answer here for
    // Claude slugs, and choosing it would drop the bridge entirely — but it was
    // measured returning `cached_tokens: 0, cache_write_tokens: 0` on a repeated
    // prefix, matching the vendor's own warning that cache billing engages only
    // on the native format. Bridging costs a translation layer and buys back an
    // order of magnitude on input tokens, so the bridge wins.
    baseUrl: 'https://api.apiyi.com/v1',
    envKey: 'OPENAI_API_KEY',
    model: 'claude-opus-5',
    // All three slugs are genuinely routed, not aliased. The vendor's public
    // docs list only the 4-x line, so a 200 alone proves nothing — but
    // `/v1/models` advertises 26 Claude slugs including these three, each
    // answers echoing its own name, and a control slug that cannot exist
    // (`claude-opus-9`) is refused with 503 "no available channels for model
    // claude-opus-9". Per-slug routing is therefore real, which is why fable is
    // listed here while it stays out of `rightcode-claude`, where it is
    // silently swapped for opus-4-8.
    allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']),
    compatibilityPolicy: 'anthropic-messages-bridge',
    // Left on: a repeated prefix billed `input_tokens: 2` +
    // `cache_read_input_tokens: 3972` here, against 3974 uncached.
    promptCacheBreakpoints: true,
    // Unlike the Claude-only rightcode pool, this endpoint also serves gpt-5.5,
    // so the memory pipeline keeps a model that produces well-formed artifacts
    // and the feature stays on. Worth stating because the side request is not
    // exempt from the bridge: it leaves as Responses, gets translated to
    // Messages like everything else on this channel, and lands on `/v1/messages`
    // carrying a GPT slug. That combination was verified to answer 200 here,
    // echoing `model: gpt-5.5-2026-04-23`.
    memoriesModel: 'gpt-5.5',
  }),
  ...QWEN_CHANNELS,
])

/** Maps a model slug to its provider family for channel routing. */
export function inferModelFamily(modelId: string): AgentModelFamily {
  const normalized = modelId.trim().toLowerCase()
  if (normalized.startsWith('grok')) return 'xai'
  if (normalized.startsWith('claude')) return 'anthropic'
  if (normalized.startsWith('gpt-') || /^o\d/.test(normalized)) return 'openai'
  // qwen / deepseek 必须早于 `other` 兜底：`other` 落 standard 渠道
  // （网关自家的端点），而这两族各有独立 host。
  if (normalized.startsWith('qwen')) return 'qwen'
  if (normalized.startsWith('deepseek')) return 'deepseek'
  return 'other'
}

/**
 * Channel id suffix each family is served from within a builtin gateway.
 *
 * `other` (unrecognized slugs) deliberately falls back to the standard
 * channel: it is the OpenAI-compatible Responses endpoint, which is the only
 * safe guess for a model we cannot classify.
 */
const FAMILY_CHANNEL_SUFFIX: Readonly<Record<AgentModelFamily, string>> =
  Object.freeze({
    openai: 'standard',
    other: 'standard',
    xai: 'grok',
    anthropic: 'claude',
    qwen: 'qwen',
    deepseek: 'deepseek',
  })

function customGatewayModelRoute(
  gatewayId: string,
  modelId: string,
): AgentModelRoute {
  const normalizedModel = modelId.trim()
  return {
    gatewayId,
    channelId: `custom:${gatewayId}`,
    modelId: normalizedModel,
    family: inferModelFamily(normalizedModel),
  }
}

/** Returns the shipped builtin gateway presets. */
export function builtinGateways(): readonly GatewayPreset[] {
  return BUILTIN_GATEWAYS
}

/** Lists internal channels registered for a gateway id. */
export function channelsForGateway(
  gatewayId: string,
): readonly ProviderChannelPreset[] {
  return BUILTIN_CHANNELS.filter((channel) => channel.gatewayId === gatewayId)
}

/** Resolves a channel id to its launch preset, including custom providers. */
export function resolveProviderChannel(
  channelId: string,
  customProviders: readonly ProviderPreset[] = [],
): ProviderChannelPreset {
  const builtin = BUILTIN_CHANNELS.find((channel) => channel.id === channelId)
  if (builtin) return builtin

  const customId = channelId.startsWith('custom:')
    ? channelId.slice('custom:'.length)
    : channelId
  const custom = customProviders.find((provider) => provider.id === customId)
  if (!custom) throw new Error(`Unknown provider channel "${channelId}"`)

  return {
    ...custom,
    id: `custom:${custom.id}`,
    gatewayId: custom.id,
    compatibilityPolicy: 'none',
  }
}

/** Routes a gateway + model pair to the correct internal channel. */
export function resolveGatewayModelRoute(
  gatewayId: string,
  modelId: string,
  customProviders: readonly ProviderPreset[] = [],
): AgentModelRoute {
  const normalizedModel = modelId.trim()
  const family = inferModelFamily(normalizedModel)
  const builtin = BUILTIN_GATEWAYS.find((gateway) => gateway.id === gatewayId)

  if (!builtin) {
    const custom = customProviders.find((provider) => provider.id === gatewayId)
    if (!custom) throw new Error(`Unknown Codex gateway "${gatewayId}"`)
    return customGatewayModelRoute(gatewayId, normalizedModel)
  }

  const channelId = `${gatewayId}-${FAMILY_CHANNEL_SUFFIX[family]}`
  // Not every gateway serves every family (only rightcode has a Claude pool),
  // and the family→channel mapping is ours, not the caller's. A missing
  // channel is therefore "this gateway can't run this model", the same
  // skippable condition as an `allowedModels` miss — not the malformed-input
  // error `resolveProviderChannel` would raise.
  const channel = BUILTIN_CHANNELS.find((entry) => entry.id === channelId)
  if (
    !channel
    || (channel.allowedModels && !channel.allowedModels.includes(normalizedModel))
  ) {
    throw new ModelUnavailableInGatewayError(normalizedModel, gatewayId)
  }

  return { gatewayId, channelId, modelId: normalizedModel, family }
}

/**
 * Resolves builtin routes normally and permits unknown gateway ids only when
 * their authority comes from a main-produced model catalog.
 */
export function resolveAuthorizedGatewayModelRoute(
  context: AuthorizedGatewayRouteContext,
  modelId: string,
): AgentModelRoute {
  switch (context.source) {
    case 'builtin':
      return resolveGatewayModelRoute(context.gatewayId, modelId)
    case 'model-catalog':
      if (BUILTIN_GATEWAYS.some((gateway) => gateway.id === context.gatewayId)) {
        return resolveGatewayModelRoute(context.gatewayId, modelId)
      }
      if (!context.gatewayId) {
        throw new Error('Catalog-authorized gateway id must be non-empty')
      }
      return customGatewayModelRoute(context.gatewayId, modelId)
    default: {
      const exhaustive: never = context
      throw new Error(`Unknown gateway route authority: ${String(exhaustive)}`)
    }
  }
}

export { BUILTIN_GATEWAYS, BUILTIN_CHANNELS }
