/**
 * 从预签名地址里读出真实过期时间。
 *
 * 上游返回的结果视频地址是火山 TOS 的预签名 URL（SigV4 同族），签发时间和有效期
 * 就明明白白写在 query 里 —— 所以「是不是过期了」根本不用猜。
 *
 * 之前的错误文案写的是「网络问题或链接已过期」,而实测那条加载失败的地址签发才
 * 13 分钟、还有 23 小时有效。这种含糊其辞有实际代价:用户会以为片子没了,转头去
 * 花钱重新生成一条其实还能下载的视频。
 *
 * 同时兼容 AWS S3 的 `X-Amz-*`：两者 query 参数同构，很多 S3 兼容存储直接沿用。
 */

const PREFIXES = ['x-tos-', 'x-amz-'] as const

/** 预签名参数里的 `YYYYMMDDTHHMMSSZ`（ISO 8601 basic format，无分隔符）。 */
const BASIC_ISO = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

export function parseBasicIsoDate(raw: string): number | null {
  const m = BASIC_ISO.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const at = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  return Number.isFinite(at) ? at : null
}

export interface SignedUrlExpiry {
  /** 过期时刻（epoch ms）。 */
  expiresAt: number
  /** 相对 `now` 还剩多少毫秒；已过期为负。 */
  remainingMs: number
  expired: boolean
}

/**
 * 解析不出来就返回 null —— 这是**未知**，不是「没过期」。
 * 调用方必须把 null 当成「说不准」，不能拿它当有效性证明。
 */
export function parseSignedUrlExpiry(
  url: string | undefined | null,
  now: number = Date.now(),
): SignedUrlExpiry | null {
  if (!url) return null
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return null
  }

  // query 参数名大小写在各家实现里并不统一，统一小写后再查。
  const lower = new Map<string, string>()
  for (const [k, v] of params) lower.set(k.toLowerCase(), v)

  for (const p of PREFIXES) {
    const date = lower.get(`${p}date`)
    const expires = lower.get(`${p}expires`)
    if (!date || !expires) continue

    const signedAt = parseBasicIsoDate(date)
    const ttlSec = Number(expires)
    if (signedAt === null || !Number.isFinite(ttlSec) || ttlSec <= 0) continue

    const expiresAt = signedAt + ttlSec * 1000
    return { expiresAt, remainingMs: expiresAt - now, expired: expiresAt <= now }
  }
  return null
}

/** 「还有 3 小时 20 分」这类人话；已过期给「已过期 2 小时」。 */
export function describeRemaining(remainingMs: number): string {
  const abs = Math.abs(remainingMs)
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const span = h > 0 ? `${h} 小时${m > 0 ? ` ${m} 分` : ''}` : `${Math.max(1, m)} 分钟`
  return remainingMs <= 0 ? `已过期 ${span}` : `还有 ${span}`
}

/**
 * 播放/下载失败时该怎么跟用户说。
 *
 * 把「链接还活着吗」和「网络通不通」分开讲 —— 这两者的下一步完全不同:前者只能
 * 重新生成（花钱），后者等一会儿再点一次「重新保存」就行。含糊成一句会把人推向
 * 更贵的那条路。
 */
export function describeUrlHealth(url: string | undefined | null, now: number = Date.now()): string {
  const exp = parseSignedUrlExpiry(url, now)
  if (!exp) return '（链接有效期未知）'
  if (exp.expired) return `（链接${describeRemaining(exp.remainingMs)}，只能重新生成）`
  return `（链接未过期，${describeRemaining(exp.remainingMs)}，多半是网络不通）`
}
