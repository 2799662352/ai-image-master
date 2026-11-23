// src/main/services/customGateway.ts
/**
 * 「自定义网关」在主进程这一侧的状态与出网护栏。
 *
 * 设置页「自定义网关」(站点键 `local`)让用户把一个自己的 new-api 地址当成 Miau 用。渲染端
 * 的出图 / 理解 / 音频走 `ApiService`,自己就知道往哪发;但主进程里还有一批**也是打 Miau 网关**
 * 的通道 —— Codex 的 Miau 对话通道、Seedance / cn / 万相 / 可灵 / 深度捕捉视频、智能擦除高清 ——
 * 它们的地址原来都写死成 `resolveGatewayOrigin()`。这里让它们在「自定义网关生效」期间改打用户
 * 的地址,用的钱包 / 凭据只有一种:用户自己填的那把 Key。
 *
 * ## 三条不能破的线
 *
 * 1. **平台钱永远不去自定义地址。** 平台余额的影子 token 与归属头(`X-Platform-User-Id` 等)只属于
 *    `resolveGatewayOrigin()` 那一个域名。所以:生效期间主进程「平台 token 来源」一律当没有
 *    ({@link platformTokenUnlessCustom});出网改写({@link createCustomGatewayFetch})在发现请求带着
 *    平台归属头时直接抛错而不是改写;平台专用的 transport 干脆不挂这层改写。
 * 2. **只改写发往默认 Miau 域名的请求。** 对象存储、下载、其它域名原样放行。
 * 3. **状态在主进程自己落盘一份。** 重启后主进程在渲染端还没来得及推送之前就要拉起视频任务的轮询、
 *    Codex 的通道,若此时还按「未启用」处理,一个在自定义网关上跑着的任务会被打到 Miau 上、
 *    查不到、被当成失败。落盘的只有开关和地址(不含任何密钥)。
 *
 * 本文件**不 import electron**:路径由调用方传入,好在没有 Electron 的单测里跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeGatewayUrl } from '../../shared/customGatewayUrl'
import { writeFileAtomic } from '../utils/writeFileAtomic'

export interface CustomGatewayState {
  /** 当前站点是不是「自定义网关」。关着时 `url` 为空串。 */
  active: boolean
  /** 归一化后的根地址(带协议、不带 `/v1`、不带末尾斜杠;允许带子路径)。 */
  url: string
}

export type ApplyCustomGatewayResult =
  | { ok: true; changed: boolean; state: CustomGatewayState }
  | { ok: false; error: string }

const INACTIVE: CustomGatewayState = Object.freeze({ active: false, url: '' })

export const CUSTOM_GATEWAY_STATE_FILE = 'custom-gateway.json'

/** 平台归属头:出现在发往自定义网关的请求里就是出了岔子,宁可失败也不发。 */
const PLATFORM_ATTRIBUTION_HEADERS = [
  'x-platform-user-id',
  'x-project-id',
  'x-producer-project-id',
  'x-catimation-billing',
] as const

export const PLATFORM_ON_CUSTOM_GATEWAY_ERROR =
  '平台余额只能用于 Miau 官方网关,当前选择的是「自定义网关」,已拦下这次请求。请到设置里切回 Miau API,或改用自己的 API Key。'

let state: CustomGatewayState = INACTIVE
let stateFile: string | null = null
const listeners = new Set<(next: CustomGatewayState) => void>()
let persistChain: Promise<void> = Promise.resolve()

function parseState(raw: unknown): CustomGatewayState {
  if (!raw || typeof raw !== 'object') return INACTIVE
  const { active, url } = raw as { active?: unknown; url?: unknown }
  if (active !== true || typeof url !== 'string') return INACTIVE
  const parsed = normalizeGatewayUrl(url)
  return parsed.ok ? { active: true, url: parsed.url } : INACTIVE
}

/**
 * 启动时读一次落盘的状态。读不到 / 坏了一律按「未启用」处理 —— 这是回到 Miau 官方网关,
 * 是安全的那个方向。
 */
export function initCustomGateway(userDataDir: string): void {
  stateFile = path.join(userDataDir, CUSTOM_GATEWAY_STATE_FILE)
  try {
    state = parseState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  } catch {
    state = INACTIVE
  }
}

export function getCustomGatewayState(): CustomGatewayState {
  return state
}

export function isCustomGatewayActive(): boolean {
  return state.active
}

/** 生效时的根地址(不含 `/v1`),否则 `null`。 */
export function customGatewayRoot(): string | null {
  return state.active ? state.url : null
}

/** 生效时的 OpenAI 兼容根(`<根>/v1`),与 `MIAU_BASE_URL` 同形;否则 `null`。 */
export function customGatewayBaseUrl(): string | null {
  return state.active ? `${state.url}/v1` : null
}

export function onCustomGatewayChange(listener: (next: CustomGatewayState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function persist(next: CustomGatewayState): void {
  const file = stateFile
  if (!file) return
  const body = Buffer.from(JSON.stringify(next))
  persistChain = persistChain
    .then(() => writeFileAtomic(file, body))
    .catch((e) => {
      // 落盘失败不影响本次运行:内存里的状态照样生效,只是重启后会回到「未启用」。
      console.warn('[customGateway] persist failed:', e)
    })
}

/** 测试用:等落盘队列清空。 */
export function flushCustomGatewayPersist(): Promise<void> {
  return persistChain
}

/**
 * 渲染端推来的状态。**不信任**:地址在这里重新校验一遍,不合法的整体拒收、保持原状态。
 * `changed` 为真时调用方才需要重启依赖地址的东西(Codex)。
 */
export function applyCustomGatewayState(raw: unknown): ApplyCustomGatewayResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '参数不正确' }
  const { active, url } = raw as { active?: unknown; url?: unknown }
  if (typeof active !== 'boolean') return { ok: false, error: '参数不正确' }

  let next: CustomGatewayState
  if (!active) {
    next = INACTIVE
  } else {
    const parsed = normalizeGatewayUrl(typeof url === 'string' ? url : '')
    if (!parsed.ok) return { ok: false, error: '网关地址不合法' }
    next = { active: true, url: parsed.url }
  }

  const changed = next.active !== state.active || next.url !== state.url
  if (!changed) return { ok: true, changed: false, state }

  state = next
  persist(next)
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch (e) {
      console.warn('[customGateway] listener failed:', e)
    }
  }
  return { ok: true, changed: true, state }
}

/** 测试用:回到未启用、忘掉落盘路径。 */
export function __resetCustomGatewayForTests(): void {
  state = INACTIVE
  stateFile = null
  listeners.clear()
  persistChain = Promise.resolve()
}

/**
 * 平台 token 的读取包一层:自定义网关生效期间一律当「没有平台 token」。
 *
 * 用在所有「这一次花谁的钱」的判定上。读不到平台 token 时,既有逻辑会落到自填 Key 那一支,
 * 与「没登录」的表现完全一致 —— 不新增任何失败模式。
 */
export function platformTokenUnlessCustom(read: () => string | null): () => string | null {
  return () => (state.active ? null : read())
}

/**
 * 「这次花谁的钱」的判定包一层:自定义网关生效期间一律是自填 Key(`own`),不问底层怎么判。
 *
 * 只靠 {@link platformTokenUnlessCustom} 把平台 token 读成空,底层判定在「没有平台 token」时仍可能
 * 因为调用方显式点名平台(任务里存的意向)而抛一句与当下无关的错;这里直接钉死更清楚。
 */
export function withCustomGatewayBilling<B extends string>(
  resolve: (prefer?: B) => B,
  own: B,
): (prefer?: B) => B {
  return (prefer) => (state.active ? own : resolve(prefer))
}

function hasPlatformAttribution(headers: HeadersInit | undefined): boolean {
  if (!headers) return false
  const names: string[] = []
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((_value, name) => names.push(name))
  } else if (Array.isArray(headers)) {
    for (const pair of headers) if (pair && typeof pair[0] === 'string') names.push(pair[0])
  } else {
    names.push(...Object.keys(headers as Record<string, string>))
  }
  return names.some((name) =>
    (PLATFORM_ATTRIBUTION_HEADERS as readonly string[]).includes(name.toLowerCase()),
  )
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * 给「也会被用户自己的 Key 用到」的网关客户端包一层出网改写。
 *
 * 自定义网关生效时,发往 `defaultOrigin()` 的请求改发到用户的根地址(路径与查询串原样保留,
 * 所以客户端里 `…/v1/video/generations` 之类的拼法一个字都不用改);不生效、或目标不是默认
 * Miau 域名时原样放行。
 *
 * 带平台归属头的请求在生效期间**抛错**而不是改写:那说明有一条平台专用的链路被错接到这里,
 * 发出去的是别人的计费归属。
 */
export function createCustomGatewayFetch(inner: FetchLike, defaultOrigin: () => string): FetchLike {
  return async (url, init) => {
    const root = customGatewayRoot()
    if (!root) return inner(url, init)
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return inner(url, init)
    }
    if (target.origin !== defaultOrigin()) return inner(url, init)
    if (hasPlatformAttribution(init?.headers)) throw new Error(PLATFORM_ON_CUSTOM_GATEWAY_ERROR)
    return inner(`${root}${target.pathname}${target.search}`, init)
  }
}
