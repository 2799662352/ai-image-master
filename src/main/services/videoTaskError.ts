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

export function translateVideoTaskError(message: string): string {
  return translateWan3Error(translateSeedanceTaskError(message))
}
