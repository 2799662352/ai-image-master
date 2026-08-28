/**
 * 视频生成的「传输层」—— provider 分派的**唯一**一处。
 *
 * ## 为什么要这层
 *
 * `SeedanceTaskManager` 有三个地方要碰上游：提交、轮询、取消。两家 provider 的
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
import { coerceDocumentOrLink } from '../../shared/wan3Document'
import { buildSeedanceGatewayCreateBody } from './seedanceGateway/request'
import { describeMissingGatewayToken } from './seedanceGateway/credentials'
import type { Wan3Client } from './wan3/client'
import type { SeedanceGatewayClient } from './seedanceGateway/client'
import type {
  GatewayBillingSource,
  ResolvedGatewayToken,
} from './seedanceGateway/credentials'
import type { SeedanceClient, SeedanceQueryResult } from './seedance/client'
import type {
  CreateVideoTaskInput,
  SeedanceContentItem,
  SeedanceCreateTaskBody,
  SeedanceTaskMode,
} from './seedance/types'
import { resolveSeedanceModelId } from './seedance/types'
import type { VideoModelAlias } from '../../types/seedance'

/** 提交一次生成所需的全部已解析信息。收敛与校验由 taskManager 在上游做完。 */
export interface VideoSubmitContext {
  input: CreateVideoTaskInput
  /** 已解析好的素材（URL 都已就绪）。两家 provider 各自从中取用。 */
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
   * 这条必须归 transport：只配了 Miau 密钥的用户去生成万相，原先会撞上
   * `SEEDANCE_KEY_MISSING` —— 让他去配一个这条路根本用不到的火山密钥。
   */
  requireApiKey: () => void
  createTask: (ctx: VideoSubmitContext) => Promise<{ id: string }>
  queryTask: (taskId: string) => Promise<SeedanceQueryResult>
  /** 缺省 = 该 provider 没有可用的取消接口，见文件头。 */
  deleteTask?: (taskId: string) => Promise<void>
}

/** content[] 里的 text 条目就是「最终会发出去的提示词」（已过引用归一化）。 */
function promptFrom(ctx: VideoSubmitContext): string {
  for (const item of ctx.content) {
    if (item.type === 'text') return item.text
  }
  return ctx.input.prompt
}

export function createSeedanceTransport(
  client: SeedanceClient,
  getApiKey: () => string,
): VideoTransport {
  return {
    requireApiKey() {
      // 保留原样的哨兵字符串:上层已有针对它的翻译与提示。
      if (!getApiKey()) throw new Error('SEEDANCE_KEY_MISSING')
    },
    createTask(ctx) {
      const body: SeedanceCreateTaskBody = {
        model: resolveSeedanceModelId(ctx.model),
        content: ctx.content,
        ratio: ctx.ratio,
        resolution: ctx.resolution,
        duration: ctx.duration,
        generate_audio: ctx.input.generateAudio ?? true,
        // seed / 联网搜索 / taskMode:spread-omit,不传时字段完全不出现(兼容旧上游)。
        ...(typeof ctx.input.seed === 'number' && Number.isFinite(ctx.input.seed)
          ? { seed: Math.round(ctx.input.seed) }
          : {}),
        ...(ctx.input.webSearch ? { tools: [{ type: 'web_search' as const }] } : {}),
        ...(ctx.taskMode ? { taskMode: ctx.taskMode } : {}),
      }
      return client.createTask(body, getApiKey())
    },
    queryTask: (taskId) => client.queryTask(taskId, getApiKey()),
    deleteTask: (taskId) => client.deleteTask(taskId, getApiKey()),
  }
}

export function createWan3Transport(client: Wan3Client, getApiKey: () => string): VideoTransport {
  return {
    requireApiKey() {
      if (!getApiKey().trim()) {
        throw new Error('未配置 Miau 密钥，无法使用万相 3.0。请先在设置里填写图片生成的 Miau Key。')
      }
    },
    createTask(ctx) {
      const resolved = toWan3ResolvedMedia(ctx.content)
      const body = buildWan3CreateBody(
        {
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
      return client.createTask(body, getApiKey())
    },
    queryTask: (taskId) => client.queryTask(taskId, getApiKey()),
    // 取消接口未经证实,刻意不实现 —— 见文件头。
  }
}

/**
 * 平台余额模式下 Seedance 提交给网关时用的模型 id 口径。
 *
 * **不跟 vvdance 的 region 设置走。** 网关目录里没有 `dreamina-*`（那是 vvdance
 * 海外站直连时代的 id），平台模式本身也没有 region 概念——走平台余额的用户不该
 * 关心机房在哪。跟着 global region 走的话，海外站用户一提交就是一句
 * `model_not_found`，而他完全想不到那是「站点设置」造成的。
 *
 * ## ⚠️ 网关目录里到底有哪几个 doubao-seedance-* —— 尚未证实（待烟测）
 *
 * 四个别名（`2.0` / `2.0-fast` / `2.0-mini` / `2.5`）现在都会被路由到网关。
 * 「网关侧没有 `-mini` 的对等物」这个说法**唯一的依据是参考实现只列了三个模型**
 * ——那不等于网关目录里没有第四个。
 *
 * 所以这里刻意**不加排除名单**：一份猜出来的名单会把一个其实可用的档位永久关掉，
 * 而且关得悄无声息；猜错的另一个方向只是提交时拿一句 `model_not_found` ——
 * 响亮、指名道姓、一分钱不花。拿真网关跑一次就能定，定了把结论和日期写在这里。
 * 在那之前不要凭参考实现反推。（同 `seedanceGateway/client.ts` 里轮询路径那条
 * 待办，都归在计划的 Task 6 烟测。）
 */
const GATEWAY_MODEL_REGION = 'cn' as const

/**
 * 经 Miau 网关提交 Seedance —— 与 vvdance 直连**平行**的第三条路。
 *
 * 与 `createSeedanceTransport` 的差异只有信封（`metadata` 包裹 + 一个重复的顶层
 * `prompt`）和凭据；`ctx.content` 原样透传，素材解析那一整套一行都不用动。
 *
 * `resolveToken` 回的是 token 与 billing 一对而不只是字符串：缺席时要报哪一句
 * 人话取决于哪种模式（「去选计费池」还是「去填 Miau Key」），补救动作完全不同。
 */
export function createSeedanceGatewayTransport(
  client: SeedanceGatewayClient,
  resolveToken: () => ResolvedGatewayToken,
): VideoTransport {
  return {
    requireApiKey() {
      const { billing, token } = resolveToken()
      if (!token) throw new Error(describeMissingGatewayToken(billing))
    },
    createTask(ctx) {
      const body = buildSeedanceGatewayCreateBody({
        model: resolveSeedanceModelId(ctx.model, GATEWAY_MODEL_REGION),
        // 直通。三条不变量（role 在顶层 / URL 键名跟 type 走 / 顺序即编号）
        // 靠「不碰它」保住，理由见 seedanceGateway/request.ts。
        content: ctx.content,
        ratio: ctx.ratio,
        resolution: ctx.resolution,
        duration: ctx.duration,
        generateAudio: ctx.input.generateAudio,
        // content 里没有 text 条目时才用得上；正常链路 buildContent 一定放了一条。
        promptFallback: ctx.input.prompt,
      })
      // seed / web_search / taskMode 刻意不带：网关侧 `buildVideoRequest` 里一个
      // 都没有，传了也是被丢掉。要用这几样就得留在 vvdance 直连那条路上。
      return client.createTask(body, resolveToken().token)
    },
    queryTask: (taskId) => client.queryTask(taskId, resolveToken().token),
    // 取消接口未经证实，刻意不实现 —— 见文件头。
  }
}

export interface VideoTransportRegistry {
  seedance: VideoTransport
  wan3?: VideoTransport
  /** 平台余额下的 Seedance。没注册 = 这条路还没接线，一切按老路走。 */
  seedanceGateway?: VideoTransport
}

export interface VideoRouteOptions {
  /**
   * 这一次生成的钱从哪出。缺省 = 自填 Key，与接入网关之前的行为逐字节相同。
   *
   * 由调用方给而不是在这里读全局状态：`billingSource` 是渲染层状态，主进程侧
   * 的镜像（`auth/gatewayToken` 的 activePool）在极端情况下会与它不一致，
   * 见 `seedanceGateway/credentials.ts` 的「已知缺口」。
   */
  billing?: GatewayBillingSource
}

type VideoTransportKey = keyof VideoTransportRegistry

/**
 * 每个别名的**默认**上游。`Record<VideoModelAlias, …>` 的穷尽性就是护栏：
 * 加一个模型别名而忘了在这里决定它走哪条路，编译当场报错，而不是等到运行时
 * 悄悄落进 Seedance 分支。
 *
 * 这里刻意**按别名**而不是按 `capabilities.provider` 分派：`wan3` 与「平台余额
 * 下的 Seedance」都是 `miau`、同一个 host、同一类凭据，provider 这个维度已经
 * 分不开它们了。
 */
const DEFAULT_TRANSPORT_BY_ALIAS: Record<VideoModelAlias, VideoTransportKey> = {
  '2.0': 'seedance',
  '2.0-fast': 'seedance',
  '2.0-mini': 'seedance',
  '2.5': 'seedance',
  wan3: 'wan3',
}

/**
 * 按模型 + 计费模式选 transport。**全仓唯一按上游分叉的地方。**
 *
 * 没注册的 transport 一律回落到 Seedance 直连：这只会发生在还没接线的调用方
 * （老测试只注入 seedance），让它按老路走比抛错安全。
 */
export function transportFor(
  registry: VideoTransportRegistry,
  model: string | undefined,
  options?: VideoRouteOptions,
): VideoTransport {
  // 认不出的别名（持久化里的旧值、手改过的载荷）走**老路** —— 与其抛错让一条
  // 已经在上游跑着的任务失去跟踪，不如按 vvdance 直连问一次。所以这里是
  // `undefined` 而不是 `'seedance'`：它连平台余额那个改道都不参与。
  const key: VideoTransportKey | undefined =
    model && model in DEFAULT_TRANSPORT_BY_ALIAS
      ? DEFAULT_TRANSPORT_BY_ALIAS[model as VideoModelAlias]
      : undefined

  // 🚨 别名先判、计费模式后判。反过来写（「platform → seedanceGateway」）会把
  // 万相一起劫走：它同样是 miau、同样打这个网关，但请求体形状完全不同
  // （`metadata.input.media[]` vs `metadata.content[]`），上游只会回一句 400，
  // 里面不会有任何一个字提到路由错了。
  if (key === 'wan3') return registry.wan3 ?? registry.seedance
  if (key === 'seedance' && options?.billing === 'platform') {
    // 🚨 **这一条不能回落。** 上面万相那条回落是良性的（同一个钱包、只是换个组包器），
    // 这一条不是：回落到 `registry.seedance` 意味着扣的是用户自己的 vvdance key，
    // 而他以为花的是平台余额。`seedanceGateway/credentials.ts` 已经为同一件事立过规矩
    // （「静默回落 = 用户以为在花平台余额、实际在花自己的钱」），分派这一侧要一致。
    //
    // 平台通道没就绪是**配置问题**，不是「换一条计费路继续跑」的理由。
    if (!registry.seedanceGateway) {
      throw new Error('平台余额通道未就绪，无法按平台余额提交。请改用自填 Key，或稍后重试。')
    }
    return registry.seedanceGateway
  }
  return registry.seedance
}
