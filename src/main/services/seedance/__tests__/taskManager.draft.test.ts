// Seedance 2.5 样片 / 成片在 taskManager 里的规则。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient } from '../client'
import type { SeedanceContentItem, SeedanceTaskUpdate } from '../types'
import type { VideoSubmitContext, VideoTransport } from '../../videoTransport'
import { setSeedanceRegionMemory } from '../region'
import { translateVideoTaskError } from '../../videoTaskError'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const TEXT: SeedanceContentItem[] = [{ type: 'text', text: '雨夜奔跑' }]

function makeClient(): SeedanceClient {
  return {
    createTask: vi.fn(async () => ({ id: 'direct-1' })),
    queryTask: vi.fn(async () => ({ id: 'direct-1', status: 'running' as const })),
    downloadVideo: vi.fn(async (_u: string, p: string) => p),
    deleteTask: vi.fn(async () => {}),
  }
}

function makeGateway() {
  return {
    requireApiKey: vi.fn(() => {}),
    createTask: vi.fn(async (_ctx: VideoSubmitContext) => ({ id: 'task_gw' })),
    queryTask: vi.fn(async () => ({ id: 'task_gw', status: 'running' as const })),
  } satisfies VideoTransport
}

describe('taskManager × 样片 / 成片', () => {
  let broadcasts: SeedanceTaskUpdate[]

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    setSeedanceRegionMemory('global')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function manager(gateway: VideoTransport, client = makeClient()) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo: vi.fn(async () => ({ localPath: 'D:/v.mp4' })),
      broadcast: (u) => broadcasts.push(u),
      seedanceGatewayTransport: gateway,
    })
  }

  it('样片:分辨率强制 480p,状态带 draft', async () => {
    const gw = makeGateway()
    const state = await manager(gw).submit({
      input: { prompt: '雨夜奔跑', model: '2.5', resolution: '720p', draft: true },
      content: TEXT,
      billing: 'platform',
    })
    expect(gw.createTask.mock.calls[0][0].resolution).toBe('480p')
    expect(state).toMatchObject({ draft: true, resolution: '480p' })
  })

  it('成片:1080p 不过 2.5 的能力表(那一档只有成片才有),带来源样片号', async () => {
    const gw = makeGateway()
    const state = await manager(gw).submit({
      input: { prompt: '由样片生成成片', model: '2.5', fromDraftTaskId: 'task_draft' },
      content: TEXT,
      billing: 'platform',
    })
    expect(gw.createTask.mock.calls[0][0].resolution).toBe('1080p')
    expect(state).toMatchObject({ fromDraftTaskId: 'task_draft', resolution: '1080p' })
    expect(state.draft).toBeUndefined()
  })

  it('自填 Key 下拒绝样片 / 成片,上游一次都不碰', async () => {
    const client = makeClient()
    const gw = makeGateway()
    await expect(
      manager(gw, client).submit({ input: { prompt: 'x', model: '2.5', draft: true }, content: TEXT, billing: 'own-key' }),
    ).rejects.toThrow('平台余额')
    expect(client.createTask).not.toHaveBeenCalled()
    expect(gw.createTask).not.toHaveBeenCalled()
  })

  it('非 2.5 拒绝;成片不能再带素材', async () => {
    const gw = makeGateway()
    await expect(
      manager(gw).submit({ input: { prompt: 'x', model: '2.0', draft: true }, content: TEXT, billing: 'platform' }),
    ).rejects.toThrow('2.5')
    await expect(
      manager(gw).submit({
        input: { prompt: 'x', model: '2.5', fromDraftTaskId: 'task_draft' },
        content: [...TEXT, { type: 'image_url', role: 'reference_image', image_url: { url: 'https://cos/a.png' } }],
        billing: 'platform',
      }),
    ).rejects.toThrow('不能再带参考素材')
    expect(gw.createTask).not.toHaveBeenCalled()
  })
})

describe('网关的样片错误翻成中文', () => {
  it('task_origin_not_exist → 样片不在当前账号 / 计费池,不被当成「任务过期」', () => {
    const out = translateVideoTaskError('网关视频 API 400: task_not_exist: task_origin_not_exist')
    expect(out).toContain('计费池')
    expect(out).not.toContain('过期或已被清理')
  })

  it('invalid_draft_task:没成功 / 不是样片各有说法', () => {
    expect(translateVideoTaskError('400 invalid_draft_task: draft task has not succeeded')).toContain('还没有成功')
    expect(translateVideoTaskError('400 invalid_draft_task: draft task is not a Seedance video task')).toContain('不是')
  })
})
