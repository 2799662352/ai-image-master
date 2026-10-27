// Seedance 2.5 Draft 经网关的两种请求形状(new-api #111 / #113 的线上契约)。

import { describe, expect, it } from 'vitest'
import {
  buildSeedanceGatewayCreateBody,
  buildSeedanceGatewayFinalFromDraftBody,
} from '../request'

const content = [
  { type: 'text' as const, text: '【@图片1】在雨夜奔跑' },
  { type: 'image_url' as const, role: 'reference_image' as const, image_url: { url: 'asset://a1' } },
]

describe('样片请求', () => {
  it('带 draft:true,分辨率强制 480p,其余照常', () => {
    const body = buildSeedanceGatewayCreateBody({
      model: 'doubao-seedance-2-5',
      content,
      resolution: '720p',
      ratio: '9:16',
      duration: 8,
      generateAudio: true,
      draft: true,
    })
    expect(body.metadata).toMatchObject({ draft: true, resolution: '480p', ratio: '9:16', duration: 8 })
    expect(body.metadata.content).toBe(content)
  })

  it('不开样片时不出现 draft 字段', () => {
    const body = buildSeedanceGatewayCreateBody({ model: 'm', content, resolution: '720p' })
    expect('draft' in body.metadata).toBe(false)
    expect(body.metadata.resolution).toBe('720p')
  })
})

describe('由样片生成成片', () => {
  it('metadata 整份只有 draft_task + 1080p —— 不重传素材 / 时长 / 比例 / seed / 音频', () => {
    const body = buildSeedanceGatewayFinalFromDraftBody({
      model: 'doubao-seedance-2-5',
      draftTaskId: 'task_abc',
      prompt: '雨夜奔跑',
    })
    expect(body).toEqual({
      model: 'doubao-seedance-2-5',
      prompt: '雨夜奔跑',
      metadata: {
        content: [{ type: 'draft_task', draft_task: { id: 'task_abc' } }],
        resolution: '1080p',
      },
    })
  })
})
