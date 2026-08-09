import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

/**
 * 发版链路上每个 HTTP 请求都必须有超时。
 *
 * 2026-08-09 的 4.5.3 发版:「COS 只读预检」在 `cos-release.mjs status` 上挂了
 * 18 分钟直到 job 被取消,后面所有阶段跳过,日志里只有一句
 * "The operation was canceled" —— 没有 URL、没有阶段、没有任何可查的东西。
 *
 * 病根是**有重试但没有超时**。那些地方都写了 4 次重试 + 1 秒退避,可重试只挡得住
 * 「快速失败」:socket 级挂起既不返回也不抛错,`await fetch` 就一直等下去,重试一次
 * 都不会触发。所以这条测试钉的不是「超时能用」,而是「挂起会变成一条点名了 URL 的
 * 错误」—— 那才是让重试和排查都能工作的前提。
 */

/** 起一个只接不答的服务器,复现 socket 级挂起。 */
async function hangingServer() {
  const sockets = new Set()
  const server = createServer(() => {
    // 刻意不响应。
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/latest.yml`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('挂起的请求会超时，而不是永远等下去', async () => {
  process.env.COS_HTTP_TIMEOUT_MS = '300'
  process.env.COS_BUCKET ??= 'test-bucket'
  process.env.COS_REGION ??= 'ap-guangzhou'
  const { fetchWithTimeout } = await import('./cos-release.mjs')

  const server = await hangingServer()
  try {
    const startedAt = Date.now()
    await assert.rejects(
      () => fetchWithTimeout(server.url),
      (error) => {
        // 错误必须点名 URL 和时限：上层重试循环只把 lastError 原样带出来，
        // 信息不具体的话，发版失败时依旧无从下手。
        assert.match(error.message, /timed out after 300ms/)
        assert.ok(error.message.includes(server.url), `错误里要带上 URL: ${error.message}`)
        return true
      },
    )
    // 真的是被超时切断的，不是等到别的什么天然结束。
    assert.ok(Date.now() - startedAt < 5_000, '应当在时限附近返回')
  } finally {
    await server.close()
  }
})

test('正常响应照常返回，超时不改变成功路径', async () => {
  process.env.COS_HTTP_TIMEOUT_MS = '5000'
  const { fetchWithTimeout } = await import('./cos-release.mjs')

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('version: 4.5.3')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/latest.yml`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'version: 4.5.3')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
