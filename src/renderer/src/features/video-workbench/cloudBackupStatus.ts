// 云备份状态行的文案与语气。纯函数:同一组输入永远给同一句话,界面只负责画。
//
// 原则:**别让用户误以为已备份**。没登录 / 服务端没开 / 有剧没传上去,都要明说,
// 而不是只在「成功」时才有一行字、其它情况沉默。

import {
  WORKBENCH_BACKUP_MAX_BYTES,
  WORKBENCH_BACKUP_MAX_DRAMAS,
  type WorkbenchBackupErrorCode,
} from '../../../../types/workbenchBackup'
import type { BackupPassResult } from './cloudBackup'

export type BackupStatusTone = 'ok' | 'info' | 'warn' | 'error'

export interface BackupStatusInput {
  /** 有云备份通道(Electron)。 */
  available: boolean
  authenticated: boolean
  enabled: boolean
  running: boolean
  pending: boolean
  last: BackupPassResult | null
  lastError: string | null
  /** 「n 分钟前」之类,由界面按 lastAt 算好传进来;没跑过传空。 */
  ago: string
}

export interface BackupStatusLine {
  tone: BackupStatusTone
  text: string
}

const MB = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

/** 单次操作(列出 / 取回 / 删除)失败时给用户看的一句话。 */
export function describeBackupError(code: WorkbenchBackupErrorCode | 'CORRUPT', message: string): string {
  switch (code) {
    case 'NOT_AUTHENTICATED':
      return '请先登录平台账号。'
    case 'NOT_CONFIGURED':
      return '服务端暂未开通云备份。'
    case 'NETWORK':
      return '网络不通,请稍后重试。'
    case 'NOT_FOUND':
      return '云端没有这份备份(可能已被删除)。'
    default:
      return message || '操作失败,请稍后重试。'
  }
}

export function describeBackupStatus(i: BackupStatusInput): BackupStatusLine {
  if (!i.available) return { tone: 'warn', text: '当前环境不支持云备份(只有桌面客户端可用)。' }
  if (!i.authenticated) {
    return { tone: 'info', text: '登录平台账号后才能云备份:按账号保存,换电脑登录同一账号就能取回。' }
  }
  if (i.running) return { tone: 'info', text: '正在备份…' }
  if (i.lastError) return { tone: 'error', text: `备份出错:${i.lastError}` }

  const last = i.last
  if (last?.stopped) {
    switch (last.stopped) {
      case 'NOT_AUTHENTICATED':
        return { tone: 'info', text: '登录状态已失效,重新登录后会自动继续备份。' }
      case 'NOT_CONFIGURED':
        return {
          tone: 'warn',
          text: '服务端暂未开通云备份,这次没有备份任何内容。本次不会再自动重试,可点「立即备份」再试。',
        }
      case 'NETWORK':
        return { tone: 'warn', text: '网络不通,没能备份。已在云端的副本不受影响,下次有改动时会自动重试。' }
      default:
        return { tone: 'warn', text: '云备份服务暂时不可用,下次有改动时会自动重试。' }
    }
  }

  if (!i.enabled) return { tone: 'info', text: '自动备份已关闭;点「立即备份」可手动备份一次。' }

  if (last && last.failures.length > 0) {
    const f = last.failures[0]
    const more = last.failures.length > 1 ? `(另有 ${last.failures.length - 1} 部也失败了)` : ''
    switch (f.code) {
      case 'TOO_LARGE':
        return { tone: 'error', text: `「${f.name}」太大(超过 ${MB(WORKBENCH_BACKUP_MAX_BYTES)} MB),没有备份。${more}` }
      case 'TOO_MANY':
        return { tone: 'error', text: `云端剧数已达上限(${WORKBENCH_BACKUP_MAX_DRAMAS} 部),「${f.name}」没有备份。${more}` }
      default:
        return { tone: 'error', text: `「${f.name}」备份失败:${f.message}${more}` }
    }
  }

  if (i.pending) return { tone: 'info', text: '有改动,稍后自动备份。' }

  if (last) {
    const head = last.uploaded > 0 ? `已备份,本次上传 ${last.uploaded} 部` : '已备份,内容没有变化'
    const when = i.ago ? `(${i.ago})` : ''
    const local =
      last.localOnly > 0
        ? `。另有 ${last.localOnly} 个素材 / 成片只在这台电脑上,没有包含在云端副本里 —— 用「导出当前剧」导出时会一并上传。`
        : '。'
    return { tone: 'ok', text: `${head}${when}${local}` }
  }

  return { tone: 'info', text: '还没有备份过:打开工作台后稍等片刻会自动开始,也可以点「立即备份」。' }
}
