import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolRouter, type ToolThreadResolver } from '../ToolRouter'
import { runWithToolCaller } from '../toolCaller'
import { setToolTelemetrySink, type ToolCallRecord } from '../toolTelemetry'

/**
 * 埋点收口在 `ToolRouter.call`,因为主处理器与渲染端委派两条路都必经此处 ——
 * 挂在别的地方就会漏掉一半调用。
 *
 * 这里同时钉住一条纪律:埋点不能改变调用本身的行为。返回值要原样透出,异常要
 * 原样抛出,sink 炸了也不能连累模型拿结果。
 */

function router(): ToolRouter {
  // 只有 callRenderer 那条路会碰 win；这些用例全走主处理器。
  return new ToolRouter({} as never)
}

afterEach(() => {
  setToolTelemetrySink(null)
})

describe('ToolRouter 埋点', () => {
  it('成功调用记一条，并原样透出返回值', async () => {
    const records: ToolCallRecord[] = []
    setToolTelemetrySink((r) => records.push(r))

    const r = router()
    r.registerMain('generate_image', async () => ({ paths: ['a.png'] }))
    await expect(r.call('generate_image', {})).resolves.toEqual({ paths: ['a.png'] })

    expect(records).toHaveLength(1)
    expect(records[0]['gen_ai.tool.name']).toBe('generate_image')
    expect(records[0]['error.type']).toBeUndefined()
    expect(records[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('失败调用也记一条，异常仍然原样抛出', async () => {
    const records: ToolCallRecord[] = []
    setToolTelemetrySink((r) => records.push(r))

    const r = router()
    r.registerMain('generate_image', async () => {
      throw new Error('generate_image: upstream 429')
    })
    await expect(r.call('generate_image', {})).rejects.toThrow('upstream 429')

    expect(records).toHaveLength(1)
    expect(records[0]['error.type']).toBe('Error')
    expect(records[0]['error.reason']).toBe('upstream 429')
  })

  // 记账炸了不能连累记的那件事。
  it('sink 抛错时调用照常成功', async () => {
    setToolTelemetrySink(() => {
      throw new Error('disk full')
    })
    const r = router()
    r.registerMain('ping', async () => 'pong')
    await expect(r.call('ping', {})).resolves.toBe('pong')
  })

  it('异步处理器的耗时算的是完成时刻，不是派发时刻', async () => {
    const records: ToolCallRecord[] = []
    setToolTelemetrySink((rec) => records.push(rec))
    vi.useFakeTimers()

    const r = router()
    r.registerMain('slow', () => new Promise((resolve) => setTimeout(() => resolve('done'), 5_000)))
    const pending = r.call('slow', {})
    await vi.advanceTimersByTimeAsync(5_000)
    await pending

    vi.useRealTimers()
    expect(records[0].duration_ms).toBeGreaterThanOrEqual(5_000)
  })
})

/**
 * 归属埋点。起因:一位用户的日志里 1,512 次出图有 718 次没有 `thread.id`,而那份日志
 * 分不清「调用方没报线程」和「报了但认不出」,更查不到认不出的是哪条 codex 线程 ——
 * 根因只能靠猜。这里钉住:下一份日志必须能直接回答这两个问题。
 */
describe('ToolRouter 埋点:这次调用归谁', () => {
  function collect(): ToolCallRecord[] {
    const records: ToolCallRecord[] = []
    setToolTelemetrySink((r) => records.push(r))
    return records
  }

  function mainRouter(resolver?: ToolThreadResolver): ToolRouter {
    const r = router()
    r.registerMain('generate_video', async () => 'ok')
    if (resolver) r.setThreadResolver(resolver)
    return r
  }

  it('最普通的情况(调用方就是对话当前的线程):记录和以前一个字段都不差', async () => {
    const records = collect()
    const r = mainRouter(() => ({ threadId: 'db-1', via: 'live' }))

    await r.call('generate_video', {}, 'codex-1')

    expect(Object.keys(records[0]).sort()).toEqual(
      [
        'duration_ms',
        'event.timestamp',
        'gen_ai.operation.name',
        'gen_ai.tool.name',
        'gen_ai.tool.type',
        'thread.id',
      ].sort(),
    )
    expect(records[0]['thread.id']).toBe('db-1')
  })

  it('认不出:写明 unresolved,并留下调用方和祖先的 codex 线程 id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records = collect()
      const r = mainRouter(() => undefined)

      await runWithToolCaller({ threadId: 'child', ancestorThreadIds: ['parent', 'root'] }, () =>
        r.call('generate_video', {}),
      )

      expect(records[0]['thread.id']).toBeUndefined()
      expect(records[0]['thread.attribution']).toBe('unresolved')
      expect(records[0]['codex.thread.id']).toBe('child')
      expect(records[0]['codex.thread.ancestors']).toEqual(['parent', 'root'])
    } finally {
      warn.mockRestore()
    }
  })

  it('没人报线程(主进程内部调用 / 非 codex 客户端):写明 anonymous,不带 codex id', async () => {
    const records = collect()
    const r = mainRouter(() => ({ threadId: 'never-asked', via: 'live' }))

    await r.call('generate_video', {})

    expect(records[0]['thread.id']).toBeUndefined()
    expect(records[0]['thread.attribution']).toBe('anonymous')
    expect(records[0]['codex.thread.id']).toBeUndefined()
  })

  it.each(['subagent', 'retired', 'ancestor', 'persisted'] as const)(
    '不是按最普通的路认出来的(%s):记下走的是哪条路和调用方的 codex 线程',
    async (via) => {
      const records = collect()
      const r = mainRouter(() => ({ threadId: 'db-1', via }))

      await r.call('generate_video', {}, 'codex-odd')

      expect(records[0]['thread.id']).toBe('db-1')
      expect(records[0]['thread.via']).toBe(via)
      expect(records[0]['codex.thread.id']).toBe('codex-odd')
      expect(records[0]['thread.attribution']).toBeUndefined()
    },
  )

  it('失败的调用同样带归属', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records = collect()
      const r = router()
      r.registerMain('generate_video', async () => {
        throw new Error('boom')
      })
      r.setThreadResolver(() => undefined)

      await expect(r.call('generate_video', {}, 'codex-lost')).rejects.toThrow('boom')

      expect(records[0]['error.type']).toBe('Error')
      expect(records[0]['thread.attribution']).toBe('unresolved')
      expect(records[0]['codex.thread.id']).toBe('codex-lost')
    } finally {
      warn.mockRestore()
    }
  })

  // 语义约定把参数 / 结果标成 Opt-In,我们的参数就是用户的提示词。归属字段只能是 id。
  it('归属字段里只有 id,不带任何参数内容', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records = collect()
      const r = mainRouter(() => undefined)

      await r.call('generate_video', { prompt: '机密提示词 SECRET-PROMPT' }, 'codex-lost')

      expect(JSON.stringify(records[0])).not.toContain('SECRET-PROMPT')
    } finally {
      warn.mockRestore()
    }
  })
})
