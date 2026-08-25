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

const DONE_HTML = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>登录成功</title><body style="font-family:system-ui;text-align:center;padding:4rem">
<h1>登录成功</h1><p>可以关闭本页,回到 CATIMATION 继续。</p></body></html>`

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
    res.end(err || !code ? 'authorization failed' : DONE_HTML)
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
