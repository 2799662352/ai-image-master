/**
 * 视频生成的「传输层」—— provider 分派的**唯一**一处。
 *
 * ## 为什么要这层
 *
 * `SeedanceTaskManager` 有三个地方要碰上游：提交、轮询、取消。各家 provider 的
 * 请求体毫无共同点（Ark 的 `content[]` vs 万相的 `metadata.input.media[]`），
 * 密钥也各来各的。如果在这三处各写一个 `if (provider === 'miau')`，第三家 provider
 * 进来时就是六个分支，而「万相不走人像库」这类保证会散在各处靠人记
 * —— `assetLibraryPolicy.ts` 里已经为同一个理由抽过一次谓词。
 *
 * 所以：**组包归 transport 所有**。taskManager 只认 `createTask / queryTask /
 * deleteTask` 三个动作，一次 `transportFor(model)` 定下用谁，此后不再关心 provider。
 *
 * ## 为什么万相没有 deleteTask
 *
 * 上游有没有取消接口我们没有证据，`deleteTask` 因此是**可选的**。宁可让 taskManager
 * 如实告诉用户「这个模型不支持取消，仍会计费」，也不要发一个我们没验证过的请求，
 * 然后把它的失败当成「取消失败」——那会让用户以为钱本来能省下来。
 */

import { toWan3ResolvedMedia, resolveVideoMode } from './wan3/fromContent'
import { buildWan3CreateBody } from './wan3/request'
import { asWan3Alias } from './wan3/model'
import { depthUpstreamModelId, pickDepthSourceUrl } from './depth/model'
import { asKlingAlias } from './kling/model'
import { buildKlingCreateBody } from './kling/request'
import { MediaKitApiError } from './mediaKit/client'
import { SeedanceApiError } from './seedance/apiError'
import { coerceDocumentOrLink } from '../../shared/wan3Document'
import {
  buildSeedanceGatewayCreateBody,
  buildSeedanceGatewayFinalFromDraftBody,
} from './seedanceGateway/request'
import { describeMissingGatewayToken } from './seedanceGateway/credentials'
import { gatewayPlatformHeaders } from './auth/gatewayToken'
import type { Wan3Client } from './wan3/client'
import type { MediaKitClient } from './mediaKit/client'
import type { SeedanceGatewayClient } from './seedanceGateway/client'
import type {
  GatewayBillingSource,
  ResolvedGatewayToken,
} from './seedanceGateway/credentials'
import type { SeedanceQueryResult } from './seedance/client'
import type {
  CreateVideoTaskInput,
  SeedanceContentItem,
  SeedanceTaskMode,
} from './seedance/types'
import { resolveSeedanceModelId } from './seedance/modelIds'
import type { VideoModelAlias } from '../../types/seedance'

/** 提交一次生成所需的全部已解析信息。收敛与校验由 taskManager 在上游做完。 */
export interface VideoSubmitContext {
  input: CreateVideoTaskInput
  /** 已解析好的素材（URL 都已就绪）。各家 provider 各自从中取用。 */
  content: SeedanceContentItem[]
  model: VideoModelAlias
  resolution: string
  ratio: string
  duration: number
  taskMode?: SeedanceTaskMode
}

export interface VideoTransport {
  /**
   * 密钥没配好就抛，由各家报**自己**的错。
   *
   * 这条必须归 transport：缺密钥时由各条通道报**自己**那一句人话（去选计费池 / 去填 Miau Key），
   * 不能让用户被一句别的通道的错误指去配一个这条路根本用不到的凭据。
   */
  requireApiKey: () => void
  createTask: (ctx: VideoSubmitContext) => Promise<{ id: string }>
  queryTask: (taskId: string) => Promise<SeedanceQueryResult>
  /** 缺省 = 该 provider 没有可用的取消接口，见文件头。 */
  deleteTask?: (taskId: string) => Promise<void>
}

/** content[] 里的 text 条目就是「最终会发出去的提示词」（原文，只解包了工作台 chip 外壳）。 */
function promptFrom(ctx: VideoSubmitContext): string {
  for (const item of ctx.content) {
    if (item.type === 'text') return item.text
  }
  return ctx.input.prompt
}

/**
 * 万相**同一条 transport 服务两种计费** —— 与 Seedance 那边不同(那边是两条 transport,各自
 * 把 resolver 钉死在 `'platform'` / `'own-key'`,理由见 `createSeedanceGatewayTransport`)。
 *
 * 为什么不能靠改道解决:`transportFor` 里万相那条 `if` 刻意排在计费判断之前,因为
 * 万相和 Seedance 打的是同一个 host、用的是同一类凭据,但请求体形状完全不同
 * (`metadata.input.media[]` vs `metadata.content[]`)—— 把万相劫到网关 transport 上
 * 只会换来一句 400,里面不会有任何一个字提到路由错了。所以**换凭据,不换 transport**。
 *
 * 平台那一支必须用 `gatewayPlatformHeaders` 整份组头,不能只贴 Authorization:
 * 少了里面的三个归属头,钱扣对了但平台用量明细里一条都查不到,而且一个错都不报。
 *
 * 深度捕捉(`depth`)同样「同一条 transport 服务两种计费」,共用这个函数。
 */
function gatewayAuthHeaders(resolved: ResolvedGatewayToken): Record<string, string> {
  return resolved.billing === 'platform'
    ? gatewayPlatformHeaders(resolved.token)
    : { Authorization: `Bearer ${resolved.token}` }
}

export function createWan3Transport(
  client: Wan3Client,
  resolveToken: () => ResolvedGatewayToken,
): VideoTransport {
  return {
    requireApiKey() {
      const { billing, token } = resolveToken()
      // 两种缺席的补救动作完全不同(去选计费池 / 去填 Miau Key),所以让
      // `describeMissingGatewayToken` 按 billing 说话,而不是永远那句「请填 Key」。
      if (!token.trim()) throw new Error(describeMissingGatewayToken(billing))
    },
    createTask(ctx) {
      const resolved = toWan3ResolvedMedia(ctx.content)
      const body = buildWan3CreateBody(
        {
          // 标准档 / Prime 的唯一分叉点。`asWan3Alias` 对非万相直接抛 ——
          // 静默兜底会变成「按标准档扣费、跑标准档模型」,而上游照常 200。
          model: asWan3Alias(ctx.model),
          prompt: promptFrom(ctx),
          // 工作台显式带模式;agent 那条路没有模式概念,按素材形状兜底。
          mode: resolveVideoMode(ctx.input.mode, resolved),
          resolution: ctx.resolution,
          ratio: ctx.ratio,
          duration: ctx.duration,
          ...(ctx.input.generateAudio !== undefined ? { generateAudio: ctx.input.generateAudio } : {}),
          ...(typeof ctx.input.seed === 'number' && Number.isFinite(ctx.input.seed)
            ? { seed: ctx.input.seed }
            : {}),
          // 两种写法都认：UI / 持久化是序列化 JSON，MCP 工具收的是裸 URL。
          // 认不出的当没设置，不让一张卡因此提交不了。
          ...(() => {
            const doc = coerceDocumentOrLink(ctx.input.documentOrLink)
            return doc ? { documentOrLink: doc } : {}
          })(),
        },
        resolved,
      )
      return client.createTask(body, gatewayAuthHeaders(resolveToken()))
    },
    // 现取而不是构造时定死:用户中途切计费模式,下一次轮询就该记到新的归属上,
    // 而 transport 的生命周期跟着整个视频服务走、不跟着一次提交走。
    queryTask: (taskId) => client.queryTask(taskId, gatewayAuthHeaders(resolveToken())),
    // 取消接口未经证实,刻意不实现 —— 见文件头。
  }
}

/** MediaKit 客户端抛的是它自己的 HTTP 错误类型;pollLoop / 提交重试认的是 `SeedanceApiError`。 */
function asSeedanceApiError(e: unknown): unknown {
  return e instanceof MediaKitApiError ? new SeedanceApiError(e.message, e.status) : e
}

/**
 * 深度捕捉 —— `generate_video` 的 `depth` 变体(见 `depth/model.ts` 的契约说明)。
 *
 * 它不是生成,所以请求体里没有提示词 / 画幅 / 时长 / seed:只有「哪个模型 + 哪一段源视频」。
 * 底层复用 MediaKit 客户端(同一套 `metadata.content` 任务协议),这里只做三件事:
 *   - 分辨率 → 模型 id(分辨率只由模型名决定);
 *   - 从最终 content[] 里取那一段**公网**源视频(提示词那条 text 直接忽略);
 *   - 把 HTTP 错误换成 `SeedanceApiError`,让任务管理器按状态码区分「重试能自愈」与否。
 *
 * 与万相一样**同一条 transport 服务两种计费**,凭据每次现取;平台那一支用整份组头
 * (少了归属头,钱扣对了但用量明细查不到)。取消接口未经证实,刻意不实现 —— 见文件头。
 */
export function createDepthTransport(
  client: MediaKitClient,
  resolveToken: () => ResolvedGatewayToken,
): VideoTransport {
  return {
    requireApiKey() {
      const { billing, token } = resolveToken()
      if (!token.trim()) throw new Error(describeMissingGatewayToken(billing))
    },
    async createTask(ctx) {
      // 先校验再取凭据:源视频不对 / 分辨率不认识都不该走到打上游那一步。
      const sourceUrl = pickDepthSourceUrl(ctx.content)
      const model = depthUpstreamModelId(ctx.resolution)
      try {
        return await client.submit(model, sourceUrl, {}, gatewayAuthHeaders(resolveToken()))
      } catch (e) {
        throw asSeedanceApiError(e)
      }
    },
    async queryTask(taskId) {
      try {
        const r = await client.query(taskId, gatewayAuthHeaders(resolveToken()))
        return {
          // 上游没回 id 就用手里的:状态对象丢了身份,后面的广播就对不上卡片了。
          id: r.id || taskId,
          status: r.status,
          ...(r.videoUrl ? { content: { video_url: r.videoUrl } } : {}),
          ...(r.error ? { error: r.error } : {}),
        }
      } catch (e) {
        throw asSeedanceApiError(e)
      }
    },
  }
}

/**
 * 经 Miau 网关提交 Seedance —— 现在也是 Seedance **唯一**的一条路。
 *
 * 以前它与 vvdance 直连并列,只服务平台余额。vvdance 直连删除之后,自填 Miau Key 的用户也得有地方
 * 出 Seedance,所以同一个函数现在造**两条**实例(见 `seedance/runtime.ts`):一条钉死平台余额
 * (客户端带整份归属头 `gatewayPlatformHeaders`、解析器写死 `'platform'`),一条钉死自填 Miau Key
 * (客户端只带 `Authorization`、解析器写死 `'own-key'`)。
 *
 * **为什么不像可灵 / 万相那样「一条 transport 现取两种钱包」**:那种写法让轮询跟着**当下**的计费模式走。
 * 万相 / 可灵接受这个取舍,但 Seedance 以前的两条路都是按**任务**钉死的(平台任务永远用影子 token
 * 去查,直连任务永远用直连 Key 去查)。用户提交后切计费模式,「现取」会拿另一把钥匙去查同一个 taskId,
 * 上游只回一句「任务不存在」—— 卡片报生成失败,而片子其实在跑、钱也已经花了。所以这里保持按任务钉死,
 * 由 `transportFor` 按任务提交时落锤的 `billing` 选哪一条。
 *
 * 信封只有两处与别家不同(`metadata` 包裹 + 一个重复的顶层 `prompt`);`ctx.content` 原样透传,
 * 素材解析那一整套一行都不用动。
 *
 * `resolveToken` 回的是 token 与 billing 一对而不只是字符串：缺席时要报哪一句
 * 人话取决于哪种模式（「去选计费池」还是「去填 Miau Key」），补救动作完全不同。
 *
 * ## ⚠️ 自填 Miau Key 能不能在网关提交 Seedance —— 尚未对着真网关证实
 *
 * 平台余额那一支是跑通的;自填 Key 这一支在代码上与可灵(已跑通)走同一个客户端、同一对端点,
 * 但**网关侧对个人 Key 的分组 / 渠道权限没有实测过**。猜错的结果是提交时拿到一句
 * `model_not_found` 之类的网关错误 —— 响亮、指名道姓、一分钱不花。验证过后把结论和日期写在这里。
 *
 * ## ⚠️ 网关目录里到底有哪几个 doubao-seedance-* —— 尚未证实（待烟测）
 *
 * 四个别名（`2.0` / `2.0-fast` / `2.0-mini` / `2.5`）现在都会被路由到网关。
 * 「网关侧没有 `-mini` 的对等物」这个说法**唯一的依据是参考实现只列了三个模型**
 * ——那不等于网关目录里没有第四个。所以这里刻意**不加排除名单**：一份猜出来的名单会把
 * 一个其实可用的档位永久关掉，而且关得悄无声息；猜错的另一个方向只是提交时拿一句
 * `model_not_found`。
 *
 * seed / 联网搜索走 `metadata.seed` / `metadata.tools`(网关的方舟适配器把 metadata 整份解进上游
 * 请求体,`doubao/adaptor.go` 的 `requestPayload`)。由样片出成片那一支**不带**:方舟沿用样片的
 * seed,再传会被拒。`taskMode` 是 vvdance 私有字段,网关没有对等物,仍然不带。
 */
export function createSeedanceGatewayTransport(
  client: SeedanceGatewayClient,
  resolveToken: () => ResolvedGatewayToken,
): VideoTransport {
  return {
    requireApiKey() {
      const { billing, token } = resolveToken()
      if (!token.trim()) throw new Error(describeMissingGatewayToken(billing))
    },
    createTask(ctx) {
      const model = resolveSeedanceModelId(ctx.model)
      if (ctx.input.fromDraftTaskId) {
        // 由样片出成片:整份 metadata 只有 draft_task + 成片分辨率(1080p / 4k),其余一律沿用样片。
        return client.createTask(
          buildSeedanceGatewayFinalFromDraftBody({
            model,
            draftTaskId: ctx.input.fromDraftTaskId,
            prompt: ctx.input.prompt,
            resolution: ctx.input.finalResolution,
          }),
          resolveToken().token,
        )
      }
      const body = buildSeedanceGatewayCreateBody({
        model,
        // 直通。三条不变量（role 在顶层 / URL 键名跟 type 走 / 顺序即编号）
        // 靠「不碰它」保住，理由见 seedanceGateway/request.ts。
        content: ctx.content,
        ratio: ctx.ratio,
        resolution: ctx.resolution,
        duration: ctx.duration,
        generateAudio: ctx.input.generateAudio,
        // content 里没有 text 条目时才用得上；正常链路 buildContent 一定放了一条。
        promptFallback: ctx.input.prompt,
        ...(ctx.input.draft ? { draft: true } : {}),
        // seed / 联网搜索:放进 metadata,网关的方舟适配器会解进上游请求体。
        ...(typeof ctx.input.seed === 'number' ? { seed: ctx.input.seed } : {}),
        ...(ctx.input.webSearch ? { webSearch: true } : {}),
      })
      return client.createTask(body, resolveToken().token)
    },
    queryTask: (taskId) => client.queryTask(taskId, resolveToken().token),
    // 取消接口未经证实，刻意不实现 —— 见文件头。
  }
}

/**
 * 可灵 4.0 / 4.0 Omni —— 经 Miau 网关的腾讯云 VOD 可灵渠道(new-api #183)。
 *
 * 客户端**复用** Seedance 网关那一个(`POST /video/generations` 提交、`GET /videos/{id}` 轮询):
 * 网关对可灵收的信封与「平台余额下的 Seedance」同形(`metadata.content[]` + 重复的顶层
 * `prompt`),结果地址也走同一个 `metadata.url`,响应解析一行都不用改。差别只有两处,
 * 都收在这条 transport 里:
 *
 * - **组包**走 `kling/request`(本地先拦网关必拒的组合,理由见那边的文件头);
 * - **凭据**不钉死 platform —— 与万相 / 深度捕捉一样**同一条 transport 服务两种钱包**
 *   (自填 Miau Key 也能用),每次调用现取,头部整份交给客户端(`auth` 参数)。
 *   用 `seedanceGateway` 那条 transport 做不到:它的解析器写死 `'platform'`。
 *
 * 取消接口未经证实,刻意不实现 —— 见文件头。
 */
export function createKlingTransport(
  client: SeedanceGatewayClient,
  resolveToken: () => ResolvedGatewayToken,
): VideoTransport {
  return {
    requireApiKey() {
      const { billing, token } = resolveToken()
      if (!token.trim()) throw new Error(describeMissingGatewayToken(billing))
    },
    async createTask(ctx) {
      // 先组包再取凭据:素材不对 / 时长不合法都不该走到打上游那一步。
      // `async` 是为了让组包期的拒绝统一表现为 rejected promise,而不是同步抛出。
      const body = buildKlingCreateBody({
        // `asKlingAlias` 对非可灵直接抛 —— 静默兜底会变成「按可灵价扣费、跑别人的模型」。
        model: asKlingAlias(ctx.model),
        content: ctx.content,
        ratio: ctx.ratio,
        resolution: ctx.resolution,
        duration: ctx.duration,
        generateAudio: ctx.input.generateAudio,
        promptFallback: ctx.input.prompt,
        // 分镜:缺省 = 单镜头。组包层负责校验(镜头数 / 时长之和)与把它写进 metadata。
        multiShot: ctx.input.multiShot ?? null,
      })
      const resolved = resolveToken()
      return client.createTask(body, resolved.token, gatewayAuthHeaders(resolved))
    },
    // 现取而不是构造时定死:用户中途切计费,下一次轮询就该记到新的归属上。
    queryTask: (taskId) => {
      const resolved = resolveToken()
      return client.queryTask(taskId, resolved.token, gatewayAuthHeaders(resolved))
    },
  }
}

export interface VideoTransportRegistry {
  /**
   * Seedance·平台余额(经 Miau 网关,影子 token + 整份归属头)。没注册 = 抛错,**不回落**。
   */
  seedanceGateway?: VideoTransport
  /**
   * Seedance·自填 Miau Key(经 Miau 网关,只带 `Authorization`)。没注册 = 抛错,**不回落**。
   */
  seedanceOwnKey?: VideoTransport
  /** 万相 3.0。没注册 = 抛错,**不回落**(见 `transportFor`)。 */
  wan3?: VideoTransport
  /** 深度捕捉。没注册 = 抛错,**不回落**(见 `transportFor`)。 */
  depth?: VideoTransport
  /** 可灵 4.0 / Omni。没注册 = 抛错,**不回落**(见 `transportFor`)。 */
  kling?: VideoTransport
}

export interface VideoRouteOptions {
  /**
   * 这一次生成的钱从哪出。缺省 = 自填 Miau Key。
   *
   * 由调用方给而不是在这里读全局状态：`billingSource` 是渲染层状态，主进程侧
   * 的镜像（`auth/gatewayToken` 的 activePool）在极端情况下会与它不一致，
   * 见 `seedanceGateway/credentials.ts` 的「已知缺口」。
   *
   * 只对 Seedance 有分叉作用(平台 / 自填 Key 两条 transport);万相 / 可灵 / 深度捕捉
   * 的 transport 自己按调用现取凭据。
   */
  billing?: GatewayBillingSource
}

type VideoTransportKey = 'seedance' | 'wan3' | 'depth' | 'kling'

/**
 * 每个别名的**默认**上游。`Record<VideoModelAlias, …>` 的穷尽性就是护栏：
 * 加一个模型别名而忘了在这里决定它走哪条路，编译当场报错，而不是等到运行时
 * 悄悄落进 Seedance 分支。
 *
 * 这里刻意**按别名**而不是按 `capabilities.provider` 分派：`wan3` 与 Seedance
 * 都打同一个 Miau 网关、用同一类凭据，provider 这个维度已经分不开它们了。
 */
const DEFAULT_TRANSPORT_BY_ALIAS: Record<VideoModelAlias, VideoTransportKey> = {
  '2.0': 'seedance',
  '2.0-fast': 'seedance',
  '2.0-mini': 'seedance',
  '2.5': 'seedance',
  wan3: 'wan3',
  // Prime 与标准档共用整条万相链路,只有上游 slug 与单价不同。
  'wan3-prime': 'wan3',
  depth: 'depth',
  // 可灵两档共用整条链路,只有上游 slug 不同(`kling/model.klingUpstreamModelId`)。
  kling4: 'kling',
  'kling4-omni': 'kling',
}

/**
 * 按模型 + 计费模式选 transport。**全仓唯一按上游分叉的地方。**
 *
 * 认不出的别名（持久化里的旧值、手改过的载荷）按 Seedance 处理:与其抛错让一条已经在上游
 * 跑着的任务失去跟踪,不如按它提交时的计费模式问一次。
 *
 * 🚨 **所有通道都不回落。** 它们打的是同一个网关,但请求体形状各不相同
 * (万相 `metadata.input.media[]`、Seedance / 可灵 `metadata.content[]`),回落只会换来一句
 * 看不出原因的网关 400。Seedance 的两条更险:平台与自填 Key 回落到对方,意味着扣的是另一个钱包 ——
 * 用户以为花的是平台余额、实际花的是自己的 Key(或反过来),而且不报任何错。
 * 通道没注册是配置问题,要响亮。
 */
export function transportFor(
  registry: VideoTransportRegistry,
  model: string | undefined,
  options?: VideoRouteOptions,
): VideoTransport {
  const key: VideoTransportKey =
    model && model in DEFAULT_TRANSPORT_BY_ALIAS
      ? DEFAULT_TRANSPORT_BY_ALIAS[model as VideoModelAlias]
      : 'seedance'

  if (key === 'wan3') {
    if (!registry.wan3) {
      throw new Error('万相通道未就绪，无法提交。请重启应用后重试；若仍失败请反馈给开发者。')
    }
    return registry.wan3
  }
  if (key === 'depth') {
    if (!registry.depth) {
      throw new Error('深度捕捉通道未就绪，无法提交。请重启应用后重试；若仍失败请反馈给开发者。')
    }
    return registry.depth
  }
  if (key === 'kling') {
    if (!registry.kling) {
      throw new Error('可灵通道未就绪，无法提交。请重启应用后重试；若仍失败请反馈给开发者。')
    }
    return registry.kling
  }
  if (options?.billing === 'platform') {
    // `seedanceGateway/credentials.ts` 已经为同一件事立过规矩
    // （「静默回落 = 用户以为在花平台余额、实际在花自己的钱」），分派这一侧要一致。
    if (!registry.seedanceGateway) {
      throw new Error('平台余额通道未就绪，无法按平台余额提交。请改用自填 Key，或稍后重试。')
    }
    return registry.seedanceGateway
  }
  if (!registry.seedanceOwnKey) {
    throw new Error('自填 Key 通道未就绪，无法提交。请重启应用后重试；若仍失败请反馈给开发者。')
  }
  return registry.seedanceOwnKey
}
