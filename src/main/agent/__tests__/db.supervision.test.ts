// PGlite worker 监管的**接线**验证:用一个假 worker 驱动 db.ts 里真实的
// spawn → ready → 意外退出 → 重生 → 熔断 → 通知 这条链。
//
// 为什么值得写:pgliteSupervisor.test.ts 只测了纯策略,接线此前只有源码级断言
// (「startEmbeddedPGlite 里出现了 takeRespawnSlot」)。那种断言挡不住「调了但用错
// 了返回值」。这里只把 electron 边界换成假的,监管代码本体全是真的。
//
// 只 mock 三处边界:electron(utilityProcess/app)、fs.existsSync(worker bundle 在
// dist 里,测试时 __dirname 指向源码目录)、ensureSchema(不碰真数据库)。

import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESPAWN_MAX } from '../pgliteSupervisor'
import type { AgentNotice } from '../../../types/agent'

/**
 * 假 worker:收到 `{type:'start'}` 就回 `{type:'ready'}`,与真 worker 的协议一致
 * (见 pgliteWorker.ts)。`kill()` 只记账 —— 由测试自己决定何时 emit 'exit',
 * 这样「死亡时机」是被测行为的输入而不是时序赌注。
 */
class FakeWorker extends EventEmitter {
  killed = false
  /** 已经回过 ready —— 测试要等它变真再制造死亡,否则杀在启动等待期里,
   *  走的是「exited before becoming ready」那条完全不同的分支。 */
  ready = false
  readonly stderr = undefined
  postMessage(msg: { type?: string }): void {
    if (msg?.type === 'start') {
      // 下一个 tick 回 ready,模拟真 worker 的异步启动
      setImmediate(() => {
        this.ready = true
        this.emit('message', { type: 'ready', port: 5433 })
      })
    }
  }
  kill(): void {
    this.killed = true
  }
}

const forked: FakeWorker[] = []
const forkMock = vi.fn(() => {
  const child = new FakeWorker()
  forked.push(child)
  return child
})

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'db-supervision-test') },
  utilityProcess: { fork: (...args: unknown[]) => forkMock(...(args as [])) },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: () => true },
    existsSync: () => true,
  }
})

vi.mock('../ensureSchema', () => ({ ensureSchemaViaConnection: vi.fn(async () => {}) }))

type Db = typeof import('../db')

let db: Db
let notices: AgentNotice[]

beforeEach(async () => {
  forked.length = 0
  forkMock.mockClear()
  notices = []
  // 每个用例要一份干净的模块状态(respawnHistory / pgliteChild 都是模块级的)
  vi.resetModules()
  db = await import('../db')
  db.setDatabaseNoticeSink((n) => notices.push(n))
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 等到第 `count` 个 worker fork 出来**并且已经 ready**。
 *
 * 两个条件都要等:只等 fork 数量的话,测试会在它还处于启动等待期时就把它杀掉,
 * 那走的是「exited before becoming ready」分支(spawnWithPortGrace 会再重试一次,
 * fork 计数多跳一格),与「服务中的 worker 崩了」是两码事。
 * 条件等待而不是 sleep 一个猜的时长 —— 端口缓冲是 300ms,但不该把它写进测试。
 */
async function waitForReadyWorker(count: number): Promise<FakeWorker> {
  await vi.waitFor(
    () => {
      expect(forked.length).toBe(count)
      expect(forked[count - 1].ready).toBe(true)
    },
    { timeout: 5_000, interval: 20 },
  )
  return forked[count - 1]
}

describe('worker 意外退出 → 自动重生', () => {
  it('起来之后死掉会被拉起,并告诉用户已自动恢复', async () => {
    await db.startEmbeddedPGlite()
    expect(forked).toHaveLength(1)

    forked[0].emit('exit', 1)
    await waitForReadyWorker(2)

    const notice = notices.find((n) => n.message.includes('自动恢复'))
    expect(notice?.kind).toBe('pgliteReset')
    expect(notice?.level).toBe('info')
  })

  it('重生出来的那个也在监管之下 —— 连续死亡都能接住', async () => {
    await db.startEmbeddedPGlite()
    forked[0].emit('exit', 1)
    const second = await waitForReadyWorker(2)

    // 第二代同样要被盯着,否则「死一次能救、死两次就废」
    second.emit('exit', 1)
    await waitForReadyWorker(3)
  })

  it('熔断:窗口内超额后停止重生,并如实告知需要重启', async () => {
    await db.startEmbeddedPGlite()

    // 前 RESPAWN_MAX 次死亡都应当被救回来
    for (let i = 0; i < RESPAWN_MAX; i++) {
      forked[i].emit('exit', 1)
      await waitForReadyWorker(i + 2)
    }
    expect(forked).toHaveLength(RESPAWN_MAX + 1)

    // 再死一次:额度用尽
    forked[RESPAWN_MAX].emit('exit', 1)
    await vi.waitFor(
      () => expect(notices.some((n) => n.message.includes('请重启应用'))).toBe(true),
      { timeout: 5_000, interval: 20 },
    )
    const giveUp = notices.find((n) => n.message.includes('请重启应用'))
    expect(giveUp?.level).toBe('warning')

    // 关键:不能再 fork。熔断的全部意义就是别在起不来时打转。
    await new Promise((r) => setTimeout(r, 600))
    expect(forked).toHaveLength(RESPAWN_MAX + 1)
  })

  it('主动关闭数据库时不重生 —— 退出应用不该被当成崩溃', async () => {
    await db.startEmbeddedPGlite()
    const child = forked[0]

    const closing = db.shutdownDatabase()
    child.emit('exit', 0)
    await closing

    await new Promise((r) => setTimeout(r, 600))
    expect(forked).toHaveLength(1)
    expect(notices).toEqual([])
  })
})

describe('通知通道', () => {
  it('没接 sink 时通知退回启动那条一次性通道,不丢', async () => {
    db.setDatabaseNoticeSink(null)
    await db.startEmbeddedPGlite()
    forked[0].emit('exit', 1)
    await waitForReadyWorker(2)

    const pending = db.consumeStartupNotice()
    expect(pending?.message).toContain('自动恢复')
    // 一次性:读完就空
    expect(db.consumeStartupNotice()).toBeNull()
  })
})
