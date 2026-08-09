import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolRouter } from '../ToolRouter'
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
