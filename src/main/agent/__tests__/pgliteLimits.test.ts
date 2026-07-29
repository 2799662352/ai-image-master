// PGlite 连接上限的不变量守卫。
//
// 这一刀修的是 P1017(`Server has closed the connection`)的**根因**:
// pglite-socket 的 server 运行时默认只接 1 条 TCP 连接,超出直接写一句裸文本
// 「Too many connections」并关闭 socket;而 Prisma 用的 node-postgres 池默认 max:10。
// 两条查询一重叠(工作台一批卡回流时必然发生)就撞上去。
//
// 这里既钉住我们自己的两个数字,也钉住**上游那个前提**——因为如果哪天上游把默认值
// 改成 100,这段推理就不成立了,而我们的代码注释会变成误导。第三条用例直接读安装
// 好的 dist 断言 `?? 1` 仍在,升级 pglite-socket 时它会先红。
//
// 为什么不做端到端集成测试:那要真起 utilityProcess + 真的 PGlite + 真的 Electron,
// 与 electronViteConfig.test.ts 里那条「keeps @electric-sql/pglite externalized」
// 同款权衡 —— 配置层断言比 build-and-spawn 便宜且不易抖。

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PGLITE_MAX_CONNECTIONS, PRISMA_POOL_MAX } from '../pgliteLimits'

describe('PGlite 连接上限', () => {
  it('池子上限必须严格小于服务端上限', () => {
    // 相等都不行:建表引导客户端(ensureSchemaViaConnection)与池子那条会短暂并存。
    expect(PRISMA_POOL_MAX).toBeLessThan(PGLITE_MAX_CONNECTIONS)
  })

  it('池子收到 1 —— 不去依赖上游警告过的多路复用并发', () => {
    // 放大它之前先读 pgliteLimits.ts 的模块注释:上游的查询队列在事务开着时只出队
    // 同一个 handler 的查询,多连接池叠事务会让别的连接干等。
    expect(PRISMA_POOL_MAX).toBe(1)
  })

  it('服务端留够余量给建表客户端与重连时的新旧并存', () => {
    expect(PGLITE_MAX_CONNECTIONS).toBeGreaterThanOrEqual(PRISMA_POOL_MAX + 2)
  })

  it('worker 显式传了 maxConnections —— 漏传就退回上游默认的 1', () => {
    const source = readFileSync(path.resolve(__dirname, '../pgliteWorker.ts'), 'utf8')
    expect(source).toContain('maxConnections: PGLITE_MAX_CONNECTIONS')
  })

  it('上游默认仍是 1 —— 这条前提垮了,上面那些理由就得重写', () => {
    // 直接读安装好的实现,不读 .d.ts:它的注释写着 "default: 100",与实现不符。
    const require_ = createRequire(import.meta.url)
    const entry = require_.resolve('@electric-sql/pglite-socket')
    const dir = path.dirname(entry)
    const bundled = readFileSync(entry, 'utf8')
    // 入口只做 re-export,真实现在同目录的 chunk 里
    const chunk = /from"(\.\/chunk-[^"]+)"/.exec(bundled)?.[1]
    const impl = chunk ? readFileSync(path.join(dir, chunk), 'utf8') : bundled
    expect(impl).toMatch(/maxConnections\s*=\s*\w+\.maxConnections\s*\?\?\s*1/)
    // 超限时是掐断而不是排队,所以客户端看到的是「连接被关」而非「超时」
    expect(impl).toContain('Too many connections')
  })
})
