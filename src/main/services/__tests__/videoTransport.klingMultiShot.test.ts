// 可灵传输层 × 分镜:任务输入里的 multiShot 必须真的进到网关请求的 metadata 里。
// (与 videoTransport.kling.test.ts 同一套假网关;这里只钉分镜。)

import { describe, expect, it, vi } from 'vitest'
import { createKlingTransport, type VideoSubmitContext } from '../videoTransport'
import { KlingRequestError } from '../kling/request'
import type { SeedanceGatewayClient } from '../seedanceGateway/client'
import type { SeedanceContentItem } from '../seedance/types'
import type { KlingMultiShot } from '../../../types/klingMultiShot'

vi.mock('../auth/gatewayToken', () => ({
  gatewayPlatformHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
}))

const SHOTS: KlingMultiShot = {
  type: 'customize',
  shots: [
    { prompt: '雨夜街头,人物回头', duration: 2 },
    { prompt: '特写:雨滴落在水洼里', duration: 3 },
  ],
}

function ctx(over: Partial<VideoSubmitContext> & { multiShot?: KlingMultiShot } = {}): VideoSubmitContext {
  const { multiShot, ...rest } = over
  const content: SeedanceContentItem[] = [{ type: 'text', text: '雨夜追逐' }]
  return {
    input: { prompt: '雨夜追逐', model: 'kling4', generateAudio: false, ...(multiShot ? { multiShot } : {}) },
    content,
    model: 'kling4',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    ...rest,
  }
}

function gateway() {
  return {
    createTask: vi.fn(async () => ({ id: 'task_k' })),
    queryTask: vi.fn(async () => ({ id: 'task_k', status: 'running' as const })),
  } as unknown as SeedanceGatewayClient & { createTask: ReturnType<typeof vi.fn> }
}

const transport = (client: ReturnType<typeof gateway>) =>
  createKlingTransport(client, () => ({ billing: 'own-key' as const, token: 'k' }))

describe('createKlingTransport × 分镜', () => {
  it('自定义分镜:metadata 带 multi_shot / shot_type / multi_prompt', async () => {
    const client = gateway()
    await transport(client).createTask(ctx({ multiShot: SHOTS }))
    const [body] = client.createTask.mock.calls[0]
    expect(body.metadata).toMatchObject({
      multi_shot: true,
      shot_type: 'customize',
      multi_prompt: [
        { prompt: '雨夜街头,人物回头', duration: 2 },
        { prompt: '特写:雨滴落在水洼里', duration: 3 },
      ],
    })
  })

  it('智能分镜:只有 multi_shot + shot_type,没有 multi_prompt', async () => {
    const client = gateway()
    await transport(client).createTask(ctx({ multiShot: { type: 'intelligence' } }))
    const [body] = client.createTask.mock.calls[0]
    expect(body.metadata).toMatchObject({ multi_shot: true, shot_type: 'intelligence' })
    expect(body.metadata).not.toHaveProperty('multi_prompt')
  })

  it('没有分镜:metadata 里一个分镜字段都没有(单镜头请求与改动前逐字节一致)', async () => {
    const client = gateway()
    await transport(client).createTask(ctx())
    const [body] = client.createTask.mock.calls[0]
    for (const key of ['multi_shot', 'shot_type', 'multi_prompt']) {
      expect(body.metadata).not.toHaveProperty(key)
    }
  })

  it('时长之和对不上:本地拦下,不打上游', async () => {
    const client = gateway()
    await expect(transport(client).createTask(ctx({ multiShot: SHOTS, duration: 8 }))).rejects.toBeInstanceOf(
      KlingRequestError,
    )
    expect(client.createTask).not.toHaveBeenCalled()
  })
})
