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
import { parseDocumentOrLink } from '../../shared/wan3Document'
import type { Wan3Client } from './wan3/client'
import type { SeedanceClient, SeedanceQueryResult } from './seedance/client'
import type {
  CreateVideoTaskInput,
  SeedanceContentItem,
  SeedanceCreateTaskBody,
  SeedanceTaskMode,
} from './seedance/types'
import { resolveSeedanceModelId } from './seedance/types'
import { capabilitiesFor, type VideoModelAlias } from '../../types/seedance'

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
          // 坏数据当没设置（parse 已经把这条兜住），不让一张卡因此提交不了。
          ...(parseDocumentOrLink(ctx.input.documentOrLink)
            ? { documentOrLink: parseDocumentOrLink(ctx.input.documentOrLink) }
            : {}),
        },
        resolved,
      )
      return client.createTask(body, getApiKey())
    },
    queryTask: (taskId) => client.queryTask(taskId, getApiKey()),
    // 取消接口未经证实,刻意不实现 —— 见文件头。
  }
}

export interface VideoTransportRegistry {
  seedance: VideoTransport
  wan3?: VideoTransport
}

/**
 * 按模型选 transport。**全仓唯一按 provider 分叉的地方。**
 *
 * 万相 transport 没注册时回落到 Seedance：这只会发生在还没接线的调用方（老测试
 * 只注入 seedance），让它按老路走比抛错安全。
 */
export function transportFor(
  registry: VideoTransportRegistry,
  model: VideoModelAlias | undefined,
): VideoTransport {
  const provider = capabilitiesFor(model ?? '2.0').provider
  if (provider === 'miau' && registry.wan3) return registry.wan3
  return registry.seedance
}
