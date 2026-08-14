// 重启对账：哪些卡片该重新接管、哪些该判定「上游已经没有」。
//
// 原实现在 adopt 前先探一次上游，但把**所有**探测失败都当成「任务查不到」，
// 渲染端收到 unknown 会把卡片直接 writeFailed。于是重启时一次网络抖动或上游
// 5xx，就会把还在跑、钱已经付了的任务全部错杀 —— 而渲染端在相邻的 IPC 失败
// 分支里恰恰写着「别把还在跑的任务错杀」，这一层违反了同一条意图。

import { describe, it, expect, vi } from 'vitest'
import { reconcileInFlightTasks } from '../adoption'
import { SeedanceApiError } from '../client'
import type { AdoptParams } from '../taskManager'
import type { VideoWorkbenchReconcileItem } from '../../../../types/videoWorkbench'

const ITEM: VideoWorkbenchReconcileItem = {
  taskId: 'task-1',
  prompt: '一只猫在雨里跳舞',
  model: '2.0',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
}

function makeDeps(overrides: Partial<Parameters<typeof reconcileInFlightTasks>[1]> = {}) {
  const adopted: AdoptParams[] = []
  const deps = {
    isTracked: vi.fn(() => false),
    probe: vi.fn(async () => {}),
    adopt: vi.fn((p: AdoptParams) => { adopted.push(p) }),
    translateError: (msg: string) => `译:${msg}`,
    ...overrides,
  }
  return { deps, adopted }
}

describe('reconcileInFlightTasks', () => {
  it('主进程仍在跟踪的任务标记 tracked，不重复接管', async () => {
    const { deps } = makeDeps({ isTracked: vi.fn(() => true) })
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results).toEqual([{ taskId: 'task-1', outcome: 'tracked' }])
    expect(deps.probe).not.toHaveBeenCalled()
    expect(deps.adopt).not.toHaveBeenCalled()
  })

  it('探测成功则重新接管并恢复轮询', async () => {
    const { deps, adopted } = makeDeps()
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results).toEqual([{ taskId: 'task-1', outcome: 'adopted' }])
    expect(adopted[0]).toMatchObject({ taskId: 'task-1', source: 'workbench', prompt: ITEM.prompt })
  })

  it('探测带上 model —— 万相的任务在 Ark 那边查不到', async () => {
    // 这条路此前写死了 Seedance 客户端。后果是应用重启后,一条还在跑、已经付过
    // 钱的万相任务会被问到 Ark 去,拿回一个「任务不存在」,再被 meansTaskIsGone
    // 判成 unknown —— 错杀成失败卡片,而视频照样生成、照样扣费。
    const { deps } = makeDeps()
    await reconcileInFlightTasks([{ ...ITEM, model: 'wan3' }], deps)

    expect(deps.probe).toHaveBeenCalledWith('task-1', 'wan3')
  })

  it('2.5 / wan3 都认得,不再被静默归一成 2.0', async () => {
    // 白名单曾是手写的 ['2.0','2.0-fast','2.0-mini'],漏了这两个 —— 重启后卡片
    // 显示错模型、按错单价估费、按错能力表校验,而上游那条任务其实好好的。
    for (const model of ['2.5', 'wan3'] as const) {
      const { deps, adopted } = makeDeps()
      await reconcileInFlightTasks([{ ...ITEM, model }], deps)
      expect(adopted[0]).toMatchObject({ model })
    }
  })

  it('model 认不出时探测按 2.0 走,与接管参数同一套容错', async () => {
    const { deps, adopted } = makeDeps()
    await reconcileInFlightTasks([{ ...ITEM, model: 'bogus' as never }], deps)

    expect(deps.probe).toHaveBeenCalledWith('task-1', '2.0')
    expect(adopted[0]).toMatchObject({ model: '2.0' })
  })

  it('404：上游明确说没有这个任务 → unknown，卡片可以落 failed', async () => {
    const { deps } = makeDeps({
      probe: vi.fn(async () => { throw new SeedanceApiError('Seedance API 404: task not found', 404) }),
    })
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results[0]?.outcome).toBe('unknown')
    expect(results[0]?.reason).toContain('404')
    expect(deps.adopt).not.toHaveBeenCalled()
  })

  it('401：密钥失效 → unknown（再接管也查不出结果）', async () => {
    const { deps } = makeDeps({
      probe: vi.fn(async () => { throw new SeedanceApiError('Seedance API 401: invalid api key', 401) }),
    })
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results[0]?.outcome).toBe('unknown')
    expect(deps.adopt).not.toHaveBeenCalled()
  })

  it('503：上游暂时故障不代表任务没了 → 照旧接管，别错杀已付费的任务', async () => {
    const { deps, adopted } = makeDeps({
      probe: vi.fn(async () => { throw new SeedanceApiError('Seedance API 503: upstream busy', 503) }),
    })
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results[0]?.outcome).toBe('adopted')
    expect(adopted).toHaveLength(1)
  })

  it('网络抖动（无状态码）同样照旧接管', async () => {
    const { deps, adopted } = makeDeps({
      probe: vi.fn(async () => { throw new Error('ETIMEDOUT') }),
    })
    const results = await reconcileInFlightTasks([ITEM], deps)

    expect(results[0]?.outcome).toBe('adopted')
    expect(adopted).toHaveLength(1)
  })

  it('429 限流同样照旧接管', async () => {
    const { deps } = makeDeps({
      probe: vi.fn(async () => { throw new SeedanceApiError('Seedance API 429: rate limited', 429) }),
    })
    const results = await reconcileInFlightTasks([ITEM], deps)
    expect(results[0]?.outcome).toBe('adopted')
  })

  it('缺 taskId 的项直接跳过，不进结果也不接管', async () => {
    const { deps } = makeDeps()
    const results = await reconcileInFlightTasks(
      [{ ...ITEM, taskId: '' }, ITEM],
      deps,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.taskId).toBe('task-1')
  })

  it('字段缺失/非法时回落到安全默认值', async () => {
    const { deps, adopted } = makeDeps()
    await reconcileInFlightTasks(
      [{ taskId: 'task-2', model: 'bogus', duration: 'x', prompt: 42 } as unknown as VideoWorkbenchReconcileItem],
      deps,
    )

    expect(adopted[0]).toMatchObject({
      taskId: 'task-2',
      prompt: '',
      model: '2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
    })
    expect(adopted[0]?.createdAt).toBeUndefined()
  })

  it('保留合法的 2.0-fast / 2.0-mini 与 createdAt', async () => {
    const { deps, adopted } = makeDeps()
    await reconcileInFlightTasks(
      [{ ...ITEM, model: '2.0-fast', createdAt: 1700000000000 }],
      deps,
    )

    expect(adopted[0]).toMatchObject({ model: '2.0-fast', createdAt: 1700000000000 })
  })

  it('多张卡各自独立判定，一张失败不影响其他', async () => {
    const { deps } = makeDeps({
      probe: vi.fn(async (taskId: string) => {
        if (taskId === 'gone') throw new SeedanceApiError('Seedance API 404: not found', 404)
        if (taskId === 'flaky') throw new Error('ECONNRESET')
      }),
    })
    const results = await reconcileInFlightTasks(
      [
        { ...ITEM, taskId: 'gone' },
        { ...ITEM, taskId: 'flaky' },
        { ...ITEM, taskId: 'ok' },
      ],
      deps,
    )

    expect(results.map((r) => [r.taskId, r.outcome])).toEqual([
      ['gone', 'unknown'],
      ['flaky', 'adopted'],
      ['ok', 'adopted'],
    ])
  })
})
