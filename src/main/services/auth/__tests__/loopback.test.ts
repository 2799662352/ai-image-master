import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import { startLoopbackListener } from '../loopback'

const open: Array<{ close(): void }> = []
afterEach(() => {
  open.splice(0).forEach((l) => l.close())
})

async function track<T extends { close(): void }>(p: Promise<T>): Promise<T> {
  const l = await p
  open.push(l)
  return l
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}

describe('startLoopbackListener', () => {
  it('binds a loopback IP literal on an OS-assigned port, never localhost', async () => {
    const l = await track(startLoopbackListener({ state: 's' }))
    expect(['127.0.0.1', '[::1]']).toContain(l.host)
    expect(l.port).toBeGreaterThan(0)
    expect(l.redirectUri).toBe(`http://${l.host}:${l.port}/cb`)
    expect(l.redirectUri).not.toContain('localhost')
  })

  it('resolves with the code when state matches', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    const pending = l.waitForCode()
    const res = await get(`${l.redirectUri}?code=abc123&state=st-1`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('</html>')
    // 只断言 </html> 太弱:成功页的中文被静默重编码成乱码时测试照样绿。
    expect(res.body).toContain('登录成功')
    await expect(pending).resolves.toBe('abc123')
  })

  it('rejects a state mismatch with 400 and does not resolve', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    let settled = false
    l.waitForCode().then(
      () => (settled = true),
      () => (settled = true),
    )
    const res = await get(`${l.redirectUri}?code=abc123&state=WRONG`)
    expect(res.status).toBe(400)
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })

  it('rejects a wrong path with 404 and does not resolve', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    let settled = false
    l.waitForCode().then(
      () => (settled = true),
      () => (settled = true),
    )
    const res = await get(`http://${l.host}:${l.port}/not-cb?code=a&state=st-1`)
    expect(res.status).toBe(404)
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })

  it('surfaces an error response from the authorization page', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    const pending = l.waitForCode()
    await get(`${l.redirectUri}?error=access_denied&state=st-1`)
    await expect(pending).rejects.toThrow(/access_denied/)
  })

  // 生产路径:回调是浏览器发来的,默认 keep-alive。server.close() 不动已建立的
  // 连接,光靠它端口不会释放 —— 这条锁住 closeAllConnections()。
  it('releases the port after a callback delivered over a keep-alive connection', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    const { port } = l
    const pending = l.waitForCode()
    await get(`${l.redirectUri}?code=abc123&state=st-1`)
    await expect(pending).resolves.toBe('abc123')
    await new Promise((r) => setTimeout(r, 50))
    await expect(get(`http://127.0.0.1:${port}/cb`)).rejects.toThrow()
  })

  it('times out and releases the port', async () => {
    const l = await track(startLoopbackListener({ state: 's', timeoutMs: 30 }))
    const { port } = l
    await expect(l.waitForCode()).rejects.toThrow(/timed out/i)
    await new Promise((r) => setTimeout(r, 20))
    await expect(get(`http://127.0.0.1:${port}/cb`)).rejects.toThrow()
  })

  it('close() releases the port and rejects a pending wait', async () => {
    const l = await startLoopbackListener({ state: 's' })
    const pending = l.waitForCode()
    const { port } = l
    l.close()
    await expect(pending).rejects.toThrow(/cancell?ed/i)
    await new Promise((r) => setTimeout(r, 20))
    await expect(get(`http://127.0.0.1:${port}/cb`)).rejects.toThrow()
  })
})
