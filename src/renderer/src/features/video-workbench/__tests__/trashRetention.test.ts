// 本地回收站 30 天保留期:纯规则(计时起点 / 时钟回拨 / 剩余天数)+ store 的 purgeExpiredTrash。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级;每个用例 reset store + db,不碰真实库。
import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_PROJECT_KEY, PINS_KEY } from '../projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import {
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_SINCE_KEY,
  expiredTrashIds,
  readTrashRetentionSince,
  trashDaysLeft,
  trashExpiresAt,
} from '../trashRetention'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const entry = (id: string, deletedAt: number) => ({ id, deletedAt })

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  localStorage.removeItem(PINS_KEY)
  localStorage.removeItem(TRASH_RETENTION_SINCE_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('expiredTrashIds', () => {
  it('删除满 30 天才算到期(差一毫秒都不算)', () => {
    const since = NOW - 100 * DAY // 功能早就在计时了
    const e = entry('a', NOW - TRASH_RETENTION_DAYS * DAY)
    expect(expiredTrashIds([e], NOW, since)).toEqual(['a'])
    expect(expiredTrashIds([e], NOW - 1, since)).toEqual([])
    expect(expiredTrashIds([entry('b', NOW - 29 * DAY)], NOW, since)).toEqual([])
  })

  it('计时起点:功能上线前就躺着的旧条目,从上线那一刻起再给满 30 天', () => {
    const since = NOW // 刚升级,第一次打开
    const old = entry('old', NOW - 200 * DAY)
    expect(expiredTrashIds([old], NOW, since)).toEqual([])
    expect(expiredTrashIds([old], NOW + 29 * DAY, since)).toEqual([])
    expect(expiredTrashIds([old], NOW + 30 * DAY, since)).toEqual(['old'])
    // 上线之后才删的,按自己的删除时刻算
    const fresh = entry('fresh', NOW + 5 * DAY)
    expect(trashExpiresAt(fresh, since)).toBe(NOW + 35 * DAY)
  })

  it('时钟被回拨到计时起点之前:一个都不清,哪怕条目看上去很老', () => {
    const since = NOW
    expect(expiredTrashIds([entry('a', NOW - 500 * DAY)], NOW - 1, since)).toEqual([])
    expect(expiredTrashIds([entry('a', NOW - 500 * DAY)], Number.NaN, since)).toEqual([])
  })

  it('只挑到期的,顺序不变', () => {
    const since = NOW - 100 * DAY
    const list = [entry('x', NOW - 40 * DAY), entry('y', NOW - 1 * DAY), entry('z', NOW - 31 * DAY)]
    expect(expiredTrashIds(list, NOW, since)).toEqual(['x', 'z'])
  })
})

describe('trashDaysLeft', () => {
  it('向上取整,最少显示 1 天;被回拨时按满期显示', () => {
    const since = NOW - 100 * DAY
    expect(trashDaysLeft(entry('a', NOW), NOW, since)).toBe(30)
    expect(trashDaysLeft(entry('a', NOW - 10 * DAY - 1000), NOW, since)).toBe(20)
    expect(trashDaysLeft(entry('a', NOW - 30 * DAY), NOW, since)).toBe(1)
    expect(trashDaysLeft(entry('a', NOW - 90 * DAY), NOW, since)).toBe(1)
    expect(trashDaysLeft(entry('a', NOW - 5 * DAY), NOW, NOW + DAY)).toBe(TRASH_RETENTION_DAYS)
  })
})

describe('readTrashRetentionSince', () => {
  it('第一次读就记下现在,之后读到的是同一个值;不合法的值被换掉', () => {
    expect(localStorage.getItem(TRASH_RETENTION_SINCE_KEY)).toBeNull()
    expect(readTrashRetentionSince(NOW)).toBe(NOW)
    expect(readTrashRetentionSince(NOW + 5 * DAY)).toBe(NOW)
    localStorage.setItem(TRASH_RETENTION_SINCE_KEY, 'garbage')
    expect(readTrashRetentionSince(NOW + DAY)).toBe(NOW + DAY)
    localStorage.setItem(TRASH_RETENTION_SINCE_KEY, '-5')
    expect(readTrashRetentionSince(NOW + 2 * DAY)).toBe(NOW + 2 * DAY)
  })
})

describe('store.purgeExpiredTrash', () => {
  const S = () => useVideoWorkbenchStore.getState()
  const flushDb = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

  function trashOneProject(): string {
    const pid = S().addProject('旧剧')
    S().switchBoard(S().boards.find((b) => b.projectId === pid)!.id)
    S().addCards([{ prompt: 'A1' }])
    expect(S().trashProject(pid)).toEqual({ ok: true })
    return pid
  }

  it('第一次调用只开始计时,什么都不清;满 30 天之后清掉,库里的记录也一并删净', async () => {
    const pid = trashOneProject()
    const t0 = Date.now()
    expect(S().purgeExpiredTrash(t0)).toBe(0)
    expect(S().trash).toHaveLength(1)
    expect(Number(localStorage.getItem(TRASH_RETENTION_SINCE_KEY))).toBe(t0)

    expect(S().purgeExpiredTrash(t0 + 29 * DAY)).toBe(0)
    expect(S().trash).toHaveLength(1)

    expect(S().purgeExpiredTrash(t0 + 31 * DAY)).toBe(1)
    expect(S().trash).toHaveLength(0)
    await flushDb()
    const db = getWorkbenchDb()
    expect((await db.listProjects()).some((p) => p.id === pid)).toBe(false)
  })

  it('已经计时很久、刚删的剧不会被清;删了 31 天的会被清', () => {
    const t0 = Date.now()
    localStorage.setItem(TRASH_RETENTION_SINCE_KEY, String(t0 - 100 * DAY))
    trashOneProject()
    expect(S().purgeExpiredTrash(t0)).toBe(0)
    expect(S().trash).toHaveLength(1)
    expect(S().purgeExpiredTrash(t0 + 31 * DAY)).toBe(1)
  })

  it('时钟被回拨:不清', () => {
    const t0 = Date.now()
    localStorage.setItem(TRASH_RETENTION_SINCE_KEY, String(t0))
    trashOneProject()
    expect(S().purgeExpiredTrash(t0 - DAY)).toBe(0)
    expect(S().trash).toHaveLength(1)
  })
})
