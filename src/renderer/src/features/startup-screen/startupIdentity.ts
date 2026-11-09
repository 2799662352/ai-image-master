/**
 * 启动动画里「欢迎 XXX 访问」用的名字。
 *
 * 动画在 React / 登录态水合之前就要开播,所以:
 *  1. 先用上一次登录时缓存在 localStorage 里的名字(第一次启动 / 没登录过 → 兜底名);
 *  2. 登录态水合出来之后,引擎还能用 setIdentity 把名字补上;
 *  3. 有了新名字就写回缓存,下次启动首帧就是对的。
 *
 * 名字会被拼进 DOM 文本,而且来自外部(账号系统 / localStorage),一律清洗:
 * 折成一行、去控制字符、截到 48 字(与引擎 cfg() 的上限一致)。
 */
import type { StorageLike } from './startupGate'

export const IDENTITY_STORAGE_KEY = 'catimation.startup.identity.v1'
export const FALLBACK_IDENTITY = '创作者'

const MAX_LEN = 48

function sanitize(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const cleaned = v
    // 控制字符里的 \t \n \r 先换成空格再折叠,其余直接删掉
    .replace(/[\t\n\r]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN)
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

export interface IdentitySource {
  displayName?: string | null
  username?: string | null
}

export function pickIdentityName(state: IdentitySource | null | undefined): string | null {
  if (!state) return null
  return sanitize(state.displayName) ?? sanitize(state.username)
}

export function readCachedIdentity(storage: StorageLike | undefined): string | null {
  if (!storage) return null
  try {
    return sanitize(storage.getItem(IDENTITY_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeCachedIdentity(storage: StorageLike | undefined, name: string | null | undefined): void {
  if (!storage) return
  const clean = sanitize(name)
  // 空名字不覆盖:登出 / 未登录时别把上次的名字抹掉
  if (!clean) return
  try {
    storage.setItem(IDENTITY_STORAGE_KEY, clean)
  } catch {
    // 存不了就算了
  }
}
