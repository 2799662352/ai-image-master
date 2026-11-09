/**
 * 启动动画「今天要不要播」的判定。
 *
 * 规则(用户拍板,11-10 改):**每次启动都播**,让人把动画完整看一遍(想不看随时可跳过)。
 * 4.9.34 先发的是「每天第一次」,用户明确要的是每次都放,所以默认值改成 `always`。
 * `daily`(每天一次)/ `off`(永不播)仍然保留,但只能在存档里手写,界面上没有入口。
 * **默认值只在存档里没有合法 `mode` 时生效,且 `markPlayed` 永远不会把它冻进存档** ——
 * 所以 4.9.34 用户本地那份只有日期的存档(`{lastPlayedDay}`)升级后直接按新默认走;
 * 以后再改默认也不用迁移存档。存档里显式写了 `mode` 的(手改 / 旧版本写过的)始终优先。
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

/** 默认:每次启动都播(4.9.34 是 daily,用户要求改成每次) */
export const DEFAULT_MODE: StartupMode = 'always'

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

/** 存档里**明确写过**的内容:mode 没写 / 不合法 = null(默认值不属于存档) */
interface StoredPrefs {
  mode: StartupMode | null
  lastPlayedDay: string | null
}

const EMPTY_STORED: StoredPrefs = { mode: null, lastPlayedDay: null }

function readStored(storage: StorageLike | undefined): StoredPrefs {
  if (!storage) return { ...EMPTY_STORED }
  let raw: string | null
  try {
    raw = storage.getItem(STARTUP_STORAGE_KEY)
  } catch {
    return { ...EMPTY_STORED }
  }
  if (!raw) return { ...EMPTY_STORED }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_STORED }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_STORED }

  const rec = parsed as Record<string, unknown>
  const mode = MODES.includes(rec.mode as StartupMode) ? (rec.mode as StartupMode) : null
  const lastPlayedDay = isValidDay(rec.lastPlayedDay) ? rec.lastPlayedDay : null
  return { mode, lastPlayedDay }
}

/**
 * @param defaultMode 存档里没有(合法的)mode 时用它,默认 {@link DEFAULT_MODE}('always')。
 * @param forceMode 给了就**压过存档里的一切**(包括 off / 旧版本写进去的 daily),只用于
 *   调试版「每次启动都过一遍」。它只影响这一次读取,不会写回存档。
 */
export function readPrefs(
  storage: StorageLike | undefined,
  defaultMode: StartupMode = DEFAULT_MODE,
  forceMode?: StartupMode
): StartupPrefs {
  const stored = readStored(storage)
  return { mode: forceMode ?? stored.mode ?? defaultMode, lastPlayedDay: stored.lastPlayedDay }
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
    // 只把存档里明确写过的 mode 带回去:默认值(现在是 always,4.9.34 是 daily)不能被固化进存档,
    // 否则第一次播完就把「默认」变成了「用户选的」,之后再改默认也不生效。
    const stored = readStored(storage)
    const next = stored.mode
      ? { mode: stored.mode, lastPlayedDay: localDay(now) }
      : { lastPlayedDay: localDay(now) }
    storage.setItem(STARTUP_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存不了档就算了:最坏是当天再播一次
  }
}
