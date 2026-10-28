// 可灵分镜在 taskManager 里的规则:传到传输层、校验在上游之前、任务状态里的提示词不是空白。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient } from '../client'
import type { SeedanceContentItem, SeedanceTaskUpdate } from '../types'
import type { VideoSubmitContext, VideoTransport } from '../../videoTransport'
import { setSeedanceRegionMemory } from '../region'
import { joinKlingShotPrompts } from '../../../../types/klingMultiShot'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const TEXT: SeedanceContentItem[] = [{ type: 'text', text: '雨夜奔跑' }]
const SHOTS = [
  { prompt: '雨夜街头,人物回头', duration: 2 },
  { prompt: '特写:雨滴落在水洼里', duration: 3 },
]

function makeClient(): SeedanceClient {
  return {
    createTask: vi.fn(async () => ({ id: 'direct-1' })),
    queryTask: vi.fn(async () => ({ id: 'direct-1', status: 'running' as const })),
    downloadVideo: vi.fn(async (_u: string, p: string) => p),
    deleteTask: vi.fn(async () => {}),
  }
}

function makeKling() {
  return {
    requireApiKey: vi.fn(() => {}),
    createTask: vi.fn(async (_ctx: VideoSubmitContext) => ({ id: 'task_kling' })),
    queryTask: vi.fn(async () => ({ id: 'task_kling', status: 'running' as const })),
  } satisfies VideoTransport
}

describe('taskManager × 可灵分镜', () => {
  let broadcasts: SeedanceTaskUpdate[]

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    setSeedanceRegionMemory('global')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function manager(kling: VideoTransport, client = makeClient()) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo: vi.fn(async () => ({ localPath: 'D:/v.mp4' })),
      broadcast: (u) => broadcasts.push(u),
      klingTransport: kling,
    })
  }

  it('自定义分镜原样交给传输层', async () => {
    const kling = makeKling()
    await manager(kling).submit({
      input: { prompt: '雨夜奔跑', model: 'kling4', duration: 5, multiShot: { type: 'customize', shots: SHOTS } },
      content: TEXT,
      billing: 'platform',
    })
    expect(kling.createTask.mock.calls[0][0].input.multiShot).toEqual({ type: 'customize', shots: SHOTS })
  })

  it('镜头时长之和对不上总时长:上游一次都不碰', async () => {
    const kling = makeKling()
    const client = makeClient()
    await expect(
      manager(kling, client).submit({
        input: { prompt: 'x', model: 'kling4', duration: 8, multiShot: { type: 'customize', shots: SHOTS } },
        content: TEXT,
        billing: 'platform',
      }),
    ).rejects.toThrow(/各镜头时长之和需等于视频总时长/)
    expect(kling.createTask).not.toHaveBeenCalled()
    expect(client.createTask).not.toHaveBeenCalled()
  })

  it('智能分镜没有提示词:拒绝', async () => {
    const kling = makeKling()
    await expect(
      manager(kling).submit({
        input: { prompt: '  ', model: 'kling4', duration: 5, multiShot: { type: 'intelligence' } },
        content: [{ type: 'text', text: ' ' }],
        billing: 'platform',
      }),
    ).rejects.toThrow(/智能分镜需要填写提示词/)
    expect(kling.createTask).not.toHaveBeenCalled()
  })

  it('自定义分镜允许总提示词留空:任务状态里记各镜头拼出的那份,不是空白', async () => {
    const kling = makeKling()
    const state = await manager(kling).submit({
      input: { prompt: '', model: 'kling4', duration: 5, multiShot: { type: 'customize', shots: SHOTS } },
      content: [],
      billing: 'platform',
    })
    expect(state.prompt).toBe(joinKlingShotPrompts(SHOTS))
    expect(state.prompt).not.toBe('')
  })

  it('不收分镜的模型明说「不支持」,而不是静默丢掉', async () => {
    // 自填 Key 的 Seedance 直连:这条路上没有平台通道的就绪检查,校验第一个拦。
    const kling = makeKling()
    const client = makeClient()
    await expect(
      manager(kling, client).submit({
        input: { prompt: 'x', model: '2.0', duration: 5, multiShot: { type: 'customize', shots: SHOTS } },
        content: TEXT,
        billing: 'own-key',
      }),
    ).rejects.toThrow(/不支持分镜/)
    expect(kling.createTask).not.toHaveBeenCalled()
    expect(client.createTask).not.toHaveBeenCalled()
  })

  it('没有分镜的可灵请求不受影响(上游收到的 input 里没有这个字段)', async () => {
    const kling = makeKling()
    await manager(kling).submit({
      input: { prompt: '雨夜奔跑', model: 'kling4', duration: 5 },
      content: TEXT,
      billing: 'platform',
    })
    expect(kling.createTask.mock.calls[0][0].input).not.toHaveProperty('multiShot')
  })
})
