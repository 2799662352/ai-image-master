// 本地回收站的保留期:删除后 30 天自动彻底删除(云端有备份的剧,云端再留 30 天,最长 60 天)。
//
// 为什么「计时起点」要取 max(删除时刻, 开始计时的时刻):
// 这个功能上线前就躺在回收站里的东西,从上线那一刻起才开始数 30 天 —— 升级后第一次打开
// 工作台不该一口气清掉用户几个月前删的剧(那时没人告诉过他们会自动清)。
//
// 时钟回拨保护:现在的时间早于「开始计时的时刻」= 系统时钟被调回去了,什么都不清
// (宁可多留,不要因为时钟错乱把东西误清掉)。

import type { WorkbenchTrashEntry } from './trash'

export const TRASH_RETENTION_DAYS = 30
const DAY_MS = 86_400_000

/** localStorage 键:保留期功能第一次生效的时刻(毫秒时间戳)。 */
export const TRASH_RETENTION_SINCE_KEY = 'vw-trash-retention-since'

/** 读「开始计时的时刻」;从没记过(或值不合法)就记成现在。localStorage 不可用 = 退化为只看删除时刻。 */
export function readTrashRetentionSince(now: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(TRASH_RETENTION_SINCE_KEY)
    const n = raw === null || raw === undefined ? NaN : Number(raw)
    if (Number.isFinite(n) && n > 0) return n
    globalThis.localStorage?.setItem(TRASH_RETENTION_SINCE_KEY, String(now))
    return now
  } catch {
    return 0
  }
}

/** 这一项到期(自动彻底删除)的时刻。 */
export function trashExpiresAt(entry: Pick<WorkbenchTrashEntry, 'deletedAt'>, since: number): number {
  return Math.max(entry.deletedAt, since) + TRASH_RETENTION_DAYS * DAY_MS
}

/**
 * 到期的条目 id。时钟被回拨到计时起点之前时一个都不清 —— 这不需要单独的判断:到期点
 * 永远 ≥ `since` + 30 天(见 trashExpiresAt),早于 `since` 的 `now` 自然碰不到。
 */
export function expiredTrashIds(
  trash: readonly Pick<WorkbenchTrashEntry, 'id' | 'deletedAt'>[],
  now: number,
  since: number,
): string[] {
  return trash.filter((e) => now >= trashExpiresAt(e, since)).map((e) => e.id)
}

/** 距某个时刻还有几天(向上取整,最少 1 天;已过期也显示 1 天 —— 云端是在读路径上才判过期,不会让用户看到「0 天」)。 */
export function daysUntil(at: number, now: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 1
  return Math.max(1, Math.ceil((at - now) / DAY_MS))
}

/** 还剩几天(向上取整,到期当天算 0 天以内显示 1 天)。时钟被回拨时按满期显示。 */
export function trashDaysLeft(entry: Pick<WorkbenchTrashEntry, 'deletedAt'>, now: number, since: number): number {
  if (now < since) return TRASH_RETENTION_DAYS
  return daysUntil(trashExpiresAt(entry, since), now)
}
