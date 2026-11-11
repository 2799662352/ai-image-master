// 状态机测试用的 Seedance 通道替身。
//
// 生产里 Seedance 一律经 Miau 网关(`createSeedanceGatewayTransport`),它的请求组包与
// 响应解析有自己的测试(`seedanceGateway/__tests__`)。taskManager 的测试关心的是**状态机**
// —— 提交 / 轮询 / 取消 / 落盘 / 重启接管 —— 不关心信封长什么样,所以这里用一个只记录调用的
// 假上游,形状沿用以前的直连客户端(createTask / queryTask / deleteTask),让既有断言原样成立。
//
// ⚠️ 这是**测试替身**,不是生产代码的镜像:它不带 seed / 联网搜索 / generate_audio 这些字段。
// 生产里 seed / 联网搜索走 `metadata.seed` / `metadata.tools`,由
// `seedanceGateway/__tests__/request.test.ts` 与 `videoTransport.gateway.test.ts` 把关,别在这里加回去。

import type { VideoTransport } from '../../../videoTransport'
import type { SeedanceQueryResult } from '../../client'
import { resolveSeedanceModelId } from '../../modelIds'

export interface FakeSeedanceClient {
  createTask: (body: Record<string, unknown>, apiKey: string) => Promise<{ id: string }>
  queryTask: (taskId: string, apiKey: string) => Promise<SeedanceQueryResult>
  deleteTask: (taskId: string, apiKey: string) => Promise<void>
  downloadVideo?: (url: string, destPath: string) => Promise<string>
}

/** 假上游 → `VideoTransport`。`apiKey` 为空串时 `requireApiKey` 抛错,用来测「没配凭据」。 */
export function fakeSeedanceTransport(client: FakeSeedanceClient, apiKey = 'sk-test'): VideoTransport {
  return {
    requireApiKey() {
      if (!apiKey) throw new Error('未配置 Miau 密钥：请先在设置里填写图片生成的 Miau Key。')
    },
    createTask: (ctx) =>
      client.createTask(
        {
          model: resolveSeedanceModelId(ctx.model),
          content: ctx.content,
          ratio: ctx.ratio,
          resolution: ctx.resolution,
          duration: ctx.duration,
          ...(ctx.taskMode ? { taskMode: ctx.taskMode } : {}),
        },
        apiKey,
      ),
    queryTask: (taskId) => client.queryTask(taskId, apiKey),
    deleteTask: (taskId) => client.deleteTask(taskId, apiKey),
  }
}

/**
 * 只注册**自填 Key** 那条 Seedance 通道(默认计费 = own-key 就落在这条上)。
 * 平台那条刻意不注册:需要它的用例自己传 `seedanceGatewayTransport`,
 * 而「没注册就抛、绝不回落」这类断言也才测得出来。
 */
export function fakeOwnKeyDeps(client: FakeSeedanceClient, apiKey = 'sk-test'): {
  seedanceOwnKeyTransport: VideoTransport
} {
  return { seedanceOwnKeyTransport: fakeSeedanceTransport(client, apiKey) }
}
