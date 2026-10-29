// 视频「效果问题反馈」的主进程接线:两个 IPC 通道,背后是 `client.ts`。
//
// 为什么走主进程而不是渲染层自己 fetch:
//   - 鉴权头要整份来自 `gatewayPlatformHeaders`(Authorization + 计费归属),而 token 只活在主进程,
//     不经 IPC 下发 —— 见 `auth/gatewayToken.ts`。
//   - 取不到平台凭据时,主进程能在请求出门之前说「请先登录 / 选计费池」;渲染层打标记头、
//     交给 `gatewayHeaderInjector` 的话,失败模式是删掉 Authorization 后裸奔出去撞 401
//     (`seedanceGateway/credentials.ts` 里有同一段论证)。
//
// 用的是**主进程当前的计费池**(`getActivePoolToken()`),不是渲染层递来的:池的真源在这边。
// 代价是任务是在别的池里提交的话,网关会回 40002「找不到任务」—— 客户端把这句翻成了
// 「请切换到提交这张卡时的计费池」。

import { app, ipcMain, net } from 'electron'
import { resolveMiauBaseUrl } from '../../../shared/miau'
import type { VideoBadcaseQueryResult, VideoBadcaseReportResult } from '../../../types/videoBadcase'
import { gatewayPlatformHeaders, getActivePoolToken } from '../auth/gatewayToken'
import { createVideoBadcaseClient, type VideoBadcaseClient } from './client'

export const VIDEO_BADCASE_IPC = {
  REPORT: 'video-workbench:badcase-report',
  QUERY: 'video-workbench:badcase-query',
} as const

function createDefaultClient(): VideoBadcaseClient {
  return createVideoBadcaseClient({
    fetchImpl: (url, init) => net.fetch(url, init),
    // 与 `CodexLocalBackend` 同一道闸:打包产物原样用生产地址,开发构建才认 CATIMATION_GATEWAY_ORIGIN。
    baseUrl: resolveMiauBaseUrl(app?.isPackaged ?? true),
    authHeaders: () => {
      const token = getActivePoolToken()
      return token ? gatewayPlatformHeaders(token) : null
    },
  })
}

/**
 * 注册两个通道。`client` 可注入(测试用);缺省每次调用现建 —— 创建很便宜,而 base URL /
 * 计费池都是现读的,缓存一个实例没有收益。
 */
export function registerVideoBadcaseIpc(client?: VideoBadcaseClient): void {
  const get = (): VideoBadcaseClient => client ?? createDefaultClient()

  ipcMain.removeHandler(VIDEO_BADCASE_IPC.REPORT)
  ipcMain.handle(VIDEO_BADCASE_IPC.REPORT, async (_event, payload: unknown): Promise<VideoBadcaseReportResult> => {
    // 入参形状交给 client 校验(它面对的本来就是 unknown)。
    return get().report(payload as Parameters<VideoBadcaseClient['report']>[0])
  })

  ipcMain.removeHandler(VIDEO_BADCASE_IPC.QUERY)
  ipcMain.handle(VIDEO_BADCASE_IPC.QUERY, async (_event, taskId: unknown): Promise<VideoBadcaseQueryResult> => {
    return get().query(taskId as string)
  })
}
