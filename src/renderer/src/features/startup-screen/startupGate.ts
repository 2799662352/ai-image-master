/**
 * 启动动画「今天要不要播」的判定。
 *
 * 规则(用户拍板):每天第一次启动播完整版,当天其余启动直接进入。
 * - 「一天」按**本地日历日期**算,不是 UTC —— 上游原实现用 `toISOString().slice(0,10)`,
 *   在 UTC+8 的机器上凌晨 0–8 点会算成「前一天」,于是 00:30 播过之后 08:01 又被当成新的一天再播一次。
 * - 存档是不可信输入(用户可手改 localStorage、版本升级可能换结构),读出来一律清洗。
 * - storage 读写都可能抛(隐私模式 / 被禁用 / 配额),全部吞掉:动画是锦上添花,不能因为它存不了档就卡住启动。
 */

export const STARTUP_STORAGE_KEY = 'catimation.startup.v1'

export type StartupMode = 'daily' | 'always' | 'off'

export interface StartupPrefs {
  mode: StartupMode
  /** 上一次播完(含跳过)的本地日期 YYYY-MM-DD,从没播过为 null */
  lastPlayedDay: string | null
}

/** localStorage 的最小子集,方便测试注入内存实现 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DEFAULT_PREFS: StartupPrefs = { mode: 'daily', lastPlayedDay: null }

const MODES: readonly StartupMode[] = ['daily', 'always', 'off']

const pad = (n: number): string => (n < 10 ? '0' + n : String(n))

/** 本地日历日期 YYYY-MM-DD */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 形如 2026-11-09 且是真实存在的日期(挡掉 2026-13-45 这类) */
function isValidDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  const probe = new Date(y, mo - 1, d)
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d
}

export function readPrefs(storage: StorageLike | undefined): StartupPrefs {
  if (!storage) return { ...DEFAULT_PREFS }
  let raw: string | null
  try {
    raw = storage.getItem(STARTUP_STORAGE_KEY)
  } catch {
    return { ...DEFAULT_PREFS }
  }
  if (!raw) return { ...DEFAULT_PREFS }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_PREFS }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_PREFS }

  const rec = parsed as Record<string, unknown>
  const mode = MODES.includes(rec.mode as StartupMode) ? (rec.mode as StartupMode) : DEFAULT_PREFS.mode
  const lastPlayedDay = isValidDay(rec.lastPlayedDay) ? rec.lastPlayedDay : null
  return { mode, lastPlayedDay }
}

export function shouldPlay(prefs: StartupPrefs, now: Date): boolean {
  if (prefs.mode === 'off') return false
  if (prefs.mode === 'always') return true
  // daily:只看「是不是今天」。存档日期在未来(时钟被拨回过)也算「不是今天」,
  // 否则一个未来日期会让动画永远不再出现。
  return prefs.lastPlayedDay !== localDay(now)
}

export function markPlayed(storage: StorageLike | undefined, now: Date): void {
  if (!storage) return
  try {
    const prefs = readPrefs(storage)
    const next: StartupPrefs = { mode: prefs.mode, lastPlayedDay: localDay(now) }
    storage.setItem(STARTUP_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存不了档就算了:最坏是当天再播一次
  }
}
