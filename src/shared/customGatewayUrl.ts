// src/shared/customGatewayUrl.ts
/**
 * 「自定义网关」(站点键 `local`)的地址处理。渲染端(设置页 / ApiService)与主进程
 * (出网改写、Codex 通道地址)共用这一份,两边对「什么算一个合法地址」不可能各说各话。
 *
 * 这个站点原来叫「本地服务」,只让填端口、地址写死 `http://127.0.0.1:<端口>`。
 * 现在改成直接填地址:本机的 new-api(`http://127.0.0.1:3000`)、局域网里的机器、
 * 公网部署的 new-api 网关(像 Miau 那样一个域名)都走同一个入口,不用再管端口。
 *
 * 这里全是纯函数(不碰 `localStorage` 的全局对象、不碰 DOM),好单测。
 */

/** localStorage 键:存的是**归一化之后**的完整地址。 */
export const CUSTOM_GATEWAY_URL_STORAGE_KEY = 'ai_image_local_url'

/**
 * 旧版「本地服务」只存端口。读取时当兜底,这样升级后原来填过端口的人
 * 不会被悄悄打回 3000。**只读不写**:旧键留着,回滚到旧版仍然能用。
 */
export const LEGACY_LOCAL_PORT_STORAGE_KEY = 'ai_image_local_port'

/** 什么都没填过时的地址 —— 与旧版缺省(`127.0.0.1:3000`)一致。 */
export const DEFAULT_CUSTOM_GATEWAY_URL = 'http://127.0.0.1:3000'

export type GatewayUrlFailure = 'empty' | 'invalid' | 'scheme' | 'credentials'

export type GatewayUrlResult =
  | {
      ok: true
      /** 归一化后的根地址:带协议、不带末尾斜杠、不带 `/v1`、不带查询串。 */
      url: string
      /**
       * 明文 http 且目标不是本机 / 内网。Bearer 令牌会明文过公网,界面据此提醒;
       * **只提醒不拦** —— 自建网关没配证书的情况很常见。
       */
      insecurePublicHttp: boolean
    }
  | { ok: false; reason: GatewayUrlFailure }

/** 界面上展示的失败原因。 */
export const GATEWAY_URL_FAILURE_MESSAGE: Record<GatewayUrlFailure, string> = {
  empty: '请输入网关地址',
  invalid: '地址格式不正确,请填写如 https://api.example.com 或 192.168.1.5:3000',
  scheme: '只支持 http:// 或 https:// 开头的地址',
  credentials: '地址里不要带用户名和密码,令牌请填在下面的 API Key 里',
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (parts.some((n) => n > 255)) return null
  return parts as [number, number, number, number]
}

/** URL 对象里的 IPv6 主机名带方括号,这里统一去掉再判断。 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * 主机是否「在自己人的网络里」:本机、回环、内网、链路本地、CGNAT(Tailscale 等),
 * 以及没有点号的单段主机名(局域网里常见的 `nas`、`host.docker.internal` 之外的写法)。
 *
 * 用途只有两个:没写协议时默认补 http 还是 https;明文 http 要不要提醒。
 * **不是安全边界** —— 判断错了最多是多一句提醒或少补对一个协议。
 */
export function isLocalOrPrivateHost(rawHost: string): boolean {
  const host = stripBrackets(rawHost.toLowerCase())
  if (!host) return false

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (/\.(local|lan|internal|home\.arpa)$/.test(host)) return true

  const v4 = parseIpv4(host)
  if (v4) {
    const [a, b] = v4
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }

  if (host.includes(':')) {
    // IPv6:::1 回环、fc00::/7 唯一本地、fe80::/10 链路本地。
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }

  // 单段主机名(没有点)只可能是局域网 / hosts 文件里的名字。
  return !host.includes('.')
}

/**
 * 没写协议时补哪个。本机 / 内网 / 裸 IP / 显式端口都按 http,其余域名按 https;
 * 显式写了 `:443` 的按 https(没人会拿 443 跑明文 http)。
 *
 * `port` 必须是**用户原文里写的端口**,不能用 `new URL(...).port` 取:URL 会把
 * 协议默认端口(`http` 的 80)抹成空串,`example.com:80` 就会被误判成「没写端口」
 * 而补上 https。
 */
function defaultSchemeFor(hostname: string, port: string): 'http' | 'https' {
  if (port === '443') return 'https'
  if (port) return 'http'
  if (isLocalOrPrivateHost(hostname)) return 'http'
  if (parseIpv4(hostname) || stripBrackets(hostname).includes(':')) return 'http'
  return 'https'
}

/**
 * 把用户填的原文变成网关根地址。
 *
 * 接受的写法(都会被收成同一种形状):
 *  - `https://api.example.com`、`http://192.168.1.5:3000`
 *  - `api.example.com`(补 https)、`192.168.1.5:3000` / `localhost:3000`(补 http)
 *  - `3000` / `:3000`(只给端口 = 本机该端口,沿用旧版的填法)
 *  - 把接口地址整段贴进来也行:`https://x.com/v1`、`https://x.com/v1/chat/completions`
 *    会被截回 `https://x.com`(调用方自己会拼 `/v1/...`,不截会拼成 `/v1/v1/...`)
 *
 * 保留路径前缀:`https://host/newapi` 这种挂在反代子路径下的网关照样可用。
 * 丢掉查询串和 `#` 片段。账号密码一律拒绝(`fetch` 本来就不收带凭据的 URL)。
 */
export function normalizeGatewayUrl(raw: string): GatewayUrlResult {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (/\s/.test(text)) return { ok: false, reason: 'invalid' }

  // 只给端口:沿用旧版「本地服务」的填法。
  const portOnly = /^:?(\d{1,5})$/.exec(text)
  if (portOnly) {
    const port = Number(portOnly[1])
    if (port < 1 || port > 65535) return { ok: false, reason: 'invalid' }
    return { ok: true, url: `http://127.0.0.1:${port}`, insecurePublicHttp: false }
  }

  let candidate = text
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // 写了协议:只认 http / https。
    if (!/^https?:\/\//i.test(text)) return { ok: false, reason: 'scheme' }
  } else {
    // 没写协议:先按 http 试着解析出主机名和端口,再决定补哪个。
    let probe: URL
    try {
      probe = new URL(`http://${text}`)
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    // 端口取原文里 `主机部分` 末尾的 `:数字`(`[::1]:3000` 也适用;不带端口的 IPv6 以 `]` 结尾)。
    const writtenPort = /:(\d+)$/.exec(text.split(/[/?#]/)[0])?.[1] ?? ''
    candidate = `${defaultSchemeFor(probe.hostname, writtenPort)}://${text}`
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!parsed.hostname) return { ok: false, reason: 'invalid' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' }

  // 路径:去掉从 `/v1` 起的所有内容(整段接口地址也能贴),再去掉末尾斜杠。
  const path = parsed.pathname.replace(/\/v1(\/.*)?$/i, '').replace(/\/+$/, '')
  const url = `${parsed.protocol}//${parsed.host}${path}`

  return {
    ok: true,
    url,
    insecurePublicHttp: parsed.protocol === 'http:' && !isLocalOrPrivateHost(parsed.hostname),
  }
}

/** `getItem` 够用就行,方便测试时塞一个假的。 */
export interface StorageReader {
  getItem(key: string): string | null
}

/**
 * 读出当前生效的自定义网关地址:新键 → 旧版端口键 → 缺省。
 * 新键里存的若不是合法地址(被手改坏了),当没存,继续往下兜。
 */
export function readStoredCustomGatewayUrl(storage: StorageReader): string {
  const stored = storage.getItem(CUSTOM_GATEWAY_URL_STORAGE_KEY)
  if (stored) {
    const result = normalizeGatewayUrl(stored)
    if (result.ok) return result.url
  }

  const legacyPort = storage.getItem(LEGACY_LOCAL_PORT_STORAGE_KEY)
  if (legacyPort && /^\d{1,5}$/.test(legacyPort.trim())) {
    const result = normalizeGatewayUrl(legacyPort)
    if (result.ok) return result.url
  }

  return DEFAULT_CUSTOM_GATEWAY_URL
}
