// RFC 8252 §7.3 的回环回调监听。
//
// 四条硬要求,逐条对应下面的实现:
//   §7.3  用 IP 字面量而非 localhost —— 后者可被 hosts 文件改指向(§8.3),
//         回调会被本机攻击者劫走;IP 字面量还能避免误监听到非回环网卡。
//   §7.3  临时端口:向操作系统要(listen(0)),不硬编码。授权服务器 MUST 接受任意端口。
//   §7.3  两个地址族都试,用先绑上的那个 —— 不能假设设备支持某个特定 IP 版本。
//   §8.3  只在授权期间开端口,拿到响应立刻关;只绑回环接口。
//
// 回环上用明文 http 是标准明确认可的(§8.3:请求从不离开本机),不需要自签证书。
//
// 授权码走 **query string** 而非 fragment:fragment 根本不会发给 HTTP 服务器,
// 监听器永远收不到。这是个反复被踩的坑。

import http from 'node:http'
import type { AddressInfo } from 'node:net'

const CALLBACK_PATH = '/cb'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface LoopbackListener {
  host: '127.0.0.1' | '[::1]'
  port: number
  /** 发出去的完整回调 URI。RFC 8252 §8.10 要求收到回调时与它精确比对。 */
  redirectUri: string
  waitForCode(): Promise<string>
  close(): void
}

/** 成功页停留多久再跳走 —— 只为让用户看见「登录成功」这一眼。 */
const REDIRECT_DELAY_MS = 1200

/**
 * 落地页的样式。
 *
 * **一切必须自包含 —— 零外部请求。** 这页只活 1.2 秒,去 CDN 拉字体或 logo 图片
 * 根本来不及回来,用户只会看到一闪而过的无样式文本;离线时更是直接白屏一下。
 * 所以:系统字体栈、内联 SVG、没有 <link>。
 *
 * 配色对齐站点(背景 #0A0A0A、品牌黄 #FCF600),让用户认得出这是同一个产品,
 * 而不是某个来路不明的本机页面。
 */
const PAGE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:#0A0A0A;color:#F2F3F0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px;
}
.w{width:100%;max-width:380px;text-align:center;animation:rise .42s cubic-bezier(.22,.8,.3,1) both}
.i{width:52px;height:52px;border-radius:16px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center}
.i svg{width:26px;height:26px}
.ok{background:rgba(252,246,0,.11);color:#FCF600}
.no{background:rgba(255,92,51,.11);color:#FF5C33}
h1{margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.01em}
p{margin:0;font-size:13.5px;line-height:1.65;color:#8A8A8A}
.f{margin-top:22px;font-size:12px;color:#5E5E5E}
a{color:#FCF600;text-decoration:none;border-bottom:1px solid rgba(252,246,0,.35);padding-bottom:1px}
a:hover{border-bottom-color:#FCF600}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.w{animation:none}}
`

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

const CROSS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_CSS}</style></head>
<body><div class="w">${body}</div></body></html>`
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 回调落地页。
 *
 * **必须用 `location.replace` 而不是 `href`。** 浏览器停在 `/cb?code=...&state=...` 上时,
 * 授权码就明晃晃写在地址栏里,会进浏览器历史、也会被截图带走(实测发现的)。`replace`
 * 把这条记录换掉,用户按后退也回不到带码的 URL。
 *
 * `redirectTo` 来自主进程自己的 `authBaseUrl()`,不是请求里的参数,所以不存在开放重定向。
 * 拿不到时退化成原来的「请手动关闭本页」。
 *
 * ⚠️ 兜底链接必须写成 `<a href="…">` 且**不带任何其他属性** —— 测试用
 * `/<a href="…">/` 精确匹配这个形状,加个 class 就会红。所以链接样式走 CSS 的
 * 元素选择器,不走类名。
 */
function donePage(redirectTo: string | null): string {
  const icon = `<div class="i ok">${CHECK_SVG}</div><h1>登录成功</h1>`
  if (!redirectTo) {
    return shell('登录成功', `${icon}<p>可以关闭本页,回到 CATIMATION 继续。</p>`)
  }
  return shell(
    '登录成功',
    `${icon}<p>已回到 CATIMATION,正在把你送回主页…</p>
<p class="f">没有自动跳转？<a href="${escapeAttr(redirectTo)}">点这里</a></p>
<script>setTimeout(function(){location.replace(${JSON.stringify(redirectTo)})}, ${REDIRECT_DELAY_MS})</script>`,
  )
}

/**
 * 失败落地页。原先这里只回一行裸文本 `authorization failed` —— 用户看到的是
 * 浏览器默认的黑字白底,像页面崩了,而且完全不说明下一步该干什么。
 */
function failPage(): string {
  return shell(
    '授权未完成',
    `<div class="i no">${CROSS_SVG}</div><h1>授权未完成</h1>
<p>这次登录没有生效。请回到 CATIMATION 重新点击「使用浏览器登录」。</p>
<p class="f">可以关闭本页了。</p>`,
  )
}

function bind(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      server.removeListener('listening', onListening)
      reject(e)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

export async function startLoopbackListener(opts: {
  state: string
  timeoutMs?: number
  /**
   * 授权成功后把浏览器送回哪里(通常是站点主页)。由调用方从 `authBaseUrl()` 推导,
   * 不接受来自请求的值 —— 否则就是个开放重定向。缺省则只显示「可以关闭本页」。
   */
  redirectTo?: string
}): Promise<LoopbackListener> {
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (e: Error) => void = () => {}
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  // 没有 waitForCode() 的消费者时也不能让进程因未处理 rejection 崩掉。
  codePromise.catch(() => {})

  let settled = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('not found')
      return
    }
    if (url.searchParams.get('state') !== opts.state) {
      // 陈旧、外来或重放的回调:拒绝,且**不**进入兑换(RFC 8252 §8.9)。
      res.writeHead(400).end('state mismatch')
      return
    }
    const err = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    res.writeHead(err || !code ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(err || !code ? failPage() : donePage(opts.redirectTo ?? null))
    if (settled) return
    settled = true
    if (err) rejectCode(new Error(`authorization failed: ${err}`))
    else if (code) resolveCode(code)
    // 拿到响应立刻关(§8.3)。
    close()
  })

  // 两个地址族都试,用先绑上的那个(§7.3)。
  let host: '127.0.0.1' | '[::1]' = '127.0.0.1'
  let port: number
  try {
    port = await bind(server, '127.0.0.1')
  } catch {
    port = await bind(server, '::1')
    host = '[::1]'
  }

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCode(new Error('loopback callback timed out'))
    close()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  function close(): void {
    clearTimeout(timer)
    server.close()
    // 浏览器(和 Node 自带的 http 客户端)默认 keep-alive,而 server.close() 只停止
    // 接受新连接、不动已建立的连接 —— 光靠它端口不会立刻释放,违背 §8.3 的
    // "拿到响应立刻关"。必须显式踢掉存量连接。
    server.closeAllConnections()
    if (!settled) {
      settled = true
      rejectCode(new Error('loopback listener cancelled'))
    }
  }

  return {
    host,
    port,
    redirectUri: `http://${host}:${port}${CALLBACK_PATH}`,
    waitForCode: () => codePromise,
    close,
  }
}
