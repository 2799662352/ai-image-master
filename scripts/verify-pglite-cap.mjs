/**
 * 真 PGlite + 真 PGLiteSocketServer + 真 node-postgres 连接池的端到端验证。
 *
 *   node scripts/verify-pglite-cap.mjs
 *
 * 验的是「P1017 的根因是连接数被拒」这个论断本身:
 *
 *   场景 1  服务端 maxConnections=1(上游运行时默认)+ 池子开第二条连接
 *           → 复现线上那个 `Server has closed the connection`
 *   场景 2  服务端 10 / 池子 1(我们的配置)+ 12 条并发查询 → 一条都不失败
 *   场景 3  并发连接数正好顶到服务端上限 → 仍然不失败,证明拒绝确实来自那个上限
 *
 * ## 为什么是脚本而不是 vitest 用例
 *
 * vitest 走 vite 解析,会把 `@electric-sql/pglite` 解析到它的 **TypeScript 源码**
 * (`pglite/src/pglite.ts`),那条路靠打包器加载 WASM 数据文件,在 vitest 里直接
 * `TypeError: r.arrayBuffer is not a function`。而生产代码里 PGlite 跑在
 * utilityProcess(普通 Node)里,`scripts/build-pglite-worker.mjs` 就是为此把它
 * 单独 esbuild 打包并保持 external 的。所以验证也用普通 Node —— 与生产同一条加载路径。
 *
 * 不进 CI:initdb 要跑十几秒,而这条结论一旦钉住就不会自己变。需要重新确认时手动跑。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import pg from 'pg'

/**
 * 直接从 pgliteLimits.ts 读那两个数字,不在这里抄一份 —— 抄了就会漂,而漂了之后
 * 这个脚本会「验证一套没人在用的配置」,比不验证更糟。
 */
function readLimit(source, name) {
  const m = new RegExp(`export const ${name} = ([0-9_]+)`).exec(source)
  if (!m) throw new Error(`pgliteLimits.ts 里找不到 ${name} —— 常量改名了?先同步这个脚本。`)
  return Number(m[1].replace(/_/g, ''))
}

const limitsSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/agent/pgliteLimits.ts'),
  'utf8',
)
const PGLITE_MAX_CONNECTIONS = readLimit(limitsSource, 'PGLITE_MAX_CONNECTIONS')
const PRISMA_POOL_MAX = readLimit(limitsSource, 'PRISMA_POOL_MAX')
console.log(`从 pgliteLimits.ts 读到:服务端上限 ${PGLITE_MAX_CONNECTIONS},池上限 ${PRISMA_POOL_MAX}`)

/** 与 src/main/agent/pgliteSupervisor.ts 的 isConnectionLostError 同款判定。 */
function isConnectionLost(err) {
  const msg = `${err?.message ?? err}\n${err?.code ?? ''}`
  return (
    /\bP1017\b/.test(msg) ||
    /Server has closed the connection/i.test(msg) ||
    /Too many connections/i.test(msg) ||
    /\bECONNREFUSED\b/.test(msg) ||
    /\bECONNRESET\b/.test(msg) ||
    /socket hang up/i.test(msg) ||
    /Connection terminated/i.test(msg)
  )
}

async function startServer(maxConnections) {
  const db = await PGlite.create() // 内存库,不落盘
  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: 0, // 让 OS 挑空闲端口,不与本机 5433 抢
    maxConnections,
  })
  await server.start()
  const port = Number(server.getServerConn().split(':').pop())
  return { db, server, port }
}

function makePool(port, max) {
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    max,
  })
  pool.on('error', () => {}) // 空闲连接出错不该炸进程
  return pool
}

async function withHarness(maxConnections, poolMax, fn) {
  const h = await startServer(maxConnections)
  const pool = makePool(h.port, poolMax)
  try {
    return await fn(pool)
  } finally {
    await pool.end().catch(() => {})
    await h.server.stop().catch(() => {})
    await h.db.close().catch(() => {})
  }
}

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

async function scenario1Reproduce() {
  console.log('\n[场景 1] 服务端 maxConnections=1,池子开 2 条连接 → 应当复现连接被掐断')
  await withHarness(1, 2, async (pool) => {
    const results = await Promise.allSettled([
      pool.query('select 1 as a'),
      pool.query('select 2 as a'),
    ])
    const rejected = results.filter((r) => r.status === 'rejected')
    check('有查询失败(复现成功)', rejected.length > 0, `${rejected.length}/2 失败`)
    const reasons = rejected.map((r) => r.reason)
    for (const r of reasons) console.log(`      实际错误: ${r?.message ?? r}`)
    check(
      '失败原因被判定为「连接没了」(与线上 P1017 同类)',
      reasons.some((e) => isConnectionLost(e)),
    )
  })
}

async function scenario2Fixed() {
  console.log(`\n[场景 2] 我们的配置(服务端 ${PGLITE_MAX_CONNECTIONS} / 池 ${PRISMA_POOL_MAX}),12 条并发 → 应当全部成功`)
  await withHarness(PGLITE_MAX_CONNECTIONS, PRISMA_POOL_MAX, async (pool) => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => pool.query('select $1::int as a', [i])),
    )
    const rejected = results.filter((r) => r.status === 'rejected')
    for (const r of rejected) console.log(`      意外失败: ${r.reason?.message ?? r.reason}`)
    check('12 条并发查询全部成功', rejected.length === 0, `${results.length - rejected.length}/12 成功`)
    const values = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value.rows[0].a)
      .sort((a, b) => a - b)
    check('返回值完整无错乱', JSON.stringify(values) === JSON.stringify([...Array(12).keys()]))
  })
}

async function scenario3AtCap() {
  console.log(`\n[场景 3] 并发连接顶到服务端上限(${PGLITE_MAX_CONNECTIONS})→ 仍应全部成功`)
  await withHarness(PGLITE_MAX_CONNECTIONS, PGLITE_MAX_CONNECTIONS, async (pool) => {
    const results = await Promise.allSettled(
      Array.from({ length: PGLITE_MAX_CONNECTIONS }, () => pool.query('select 1 as a')),
    )
    const rejected = results.filter((r) => r.status === 'rejected')
    for (const r of rejected) console.log(`      意外失败: ${r.reason?.message ?? r.reason}`)
    check(`${PGLITE_MAX_CONNECTIONS} 条并发连接全部成功`, rejected.length === 0)
  })
}

await scenario1Reproduce()
await scenario2Fixed()
await scenario3AtCap()

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败: ${failures.join('; ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
