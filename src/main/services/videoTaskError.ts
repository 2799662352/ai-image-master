/**
 * 视频任务错误 → 人话，两家 provider 的翻译表在这里汇合。
 *
 * 单独成文件而不是塞进任一家：`assets.ts` 的那条是 Seedance 素材库专属
 * （`LOCAL_ASSET_NOT_FOUND`，站点隔离导致），`wan3/errors.ts` 那张表是
 * DashScope 的错误码。调用方（提交入口、轮询失败）不该关心一条错误来自谁，
 * 更不该按 provider 各调各的 —— 那又是一处会漂移的分叉。
 *
 * 两个翻译器都遵守同一条约定：**认不出就原样返回**。所以顺序串联是安全的，
 * 且永远不会把上游原文丢掉。
 */

import { translateSeedanceTaskError } from './seedance/assets'
import { translateWan3Error } from './wan3/errors'
import { VIDEO_CREATE_TIMEOUT_MS, videoRequestTimeoutMessage } from './videoRequestTimeouts'

/**
 * Node / Electron `fetch` 被 `AbortController` 掐断时的原话。四个视频客户端都已经
 * 在源头把它翻成人话,这条是兜底 —— 万一有哪条新路径又把裸的 `AbortError` 抛上来,
 * 用户至少看到的是「提交超时、可能已计费」而不是一句英文。
 */
const RAW_ABORT_PATTERN = /^(this operation was aborted|the operation was aborted|aborterror)\.?$/i

export function translateVideoTaskError(message: string): string {
  if (RAW_ABORT_PATTERN.test(message.trim())) {
    return videoRequestTimeoutMessage('create', VIDEO_CREATE_TIMEOUT_MS)
  }
  return translateWan3Error(translateSeedanceTaskError(message))
}
