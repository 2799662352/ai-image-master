/**
 * 主进程替渲染端去抓远程图(缩略图用)之前的地址检查。
 *
 * 为什么要有:渲染端的 CSP(`img-src`)只放行 https 与少数固定地址,`<img src="http://内网/…">`
 * 本来就加载不了;但主进程的 `net.fetch` 不受 CSP 约束 —— 模型输出里一条
 * `![x](https://192.168.1.1/admin)` 交给主进程,就等于让主进程去敲内网设备。
 * 所以交给主进程之前先把明显指向本机 / 内网的地址挡掉,只留公网 https。
 *
 * 局限(别当成完整的 SSRF 防护):只看地址字面量,**不解析 DNS**。一个解析到内网 IP 的域名、
 * DNS 重绑定都挡不住。能到达的只有「返回内容恰好是一张能解码的图」的地址 —— 读不到响应文本,
 * 只会得到一张缩略图;而渲染端的 `<img>` 对同样的 https 地址本来就会发同样的 GET。
 *
 * 地址一律先过 `new URL()`:WHATWG 解析会把 `2130706433`、`0x7f.1`、`127.1` 这些写法
 * 规整成 `127.0.0.1`,所以下面只需要认规整后的形态。
 */

export type RemoteImageUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0 || a === 10 || a === 127) return true // 本网络 / 私网 / 回环
  if (a === 169 && b === 254) return true // 链路本地(含云厂商元数据 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 组播 / 保留 / 广播
  return false
}

function isPrivateIpv6(host: string): boolean {
  // `URL.hostname` 对 IPv6 带方括号。
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::' || h === '::1') return true
  if (h.startsWith('::ffff:')) return true // IPv4 映射地址:统一不认,免得绕过上面的 IPv4 检查
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true // fe80::/10 链路本地
  return false
}

export function checkRemoteImageUrl(input: unknown): RemoteImageUrlCheck {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'empty url' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'invalid url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https is accepted' }
  if (url.username || url.password) return { ok: false, reason: 'credentials in url' }

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'local host' }
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return { ok: false, reason: 'private address' }
  return { ok: true, url }
}
