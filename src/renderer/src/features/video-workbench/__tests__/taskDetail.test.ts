// 「任务详情」面板的数据层:把一张卡上散落的标识 / 请求参数 / 结果 / 版本
// 收成一份给人看、也能整份复制的文档。核心是**上游任务号**那一行 —— 找供应商
// 对账要的就是它;其余是让排障不必再翻 IndexedDB。

import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { buildTaskDetail, type TaskDetail, type TaskDetailField } from '../taskDetail'

const UPSTREAM = 'cgt-20260903172200-5n7rt'
const T0 = Date.UTC(2026, 8, 3, 9, 22, 0) // 2026-09-03 09:22:00Z

function card(patch: Partial<VideoWorkbenchCard> = {}): VideoWorkbenchCard {
  return {
    ...buildCard({ prompt: '一只赛博猫在雨夜奔跑', model: '2.5', resolution: '480p', duration: 6 }, 3),
    id: 'card0000aa',
    ...patch,
  }
}

function field(detail: TaskDetail, key: string): TaskDetailField {
  for (const section of detail.sections) {
    const hit = section.fields.find((f) => f.key === key)
    if (hit) return hit
  }
  throw new Error(`field ${key} not found; have: ${detail.sections.flatMap((s) => s.fields.map((f) => f.key)).join(',')}`)
}

describe('标识区', () => {
  it('走网关的卡:任务 ID(网关)+ 上游任务 ID(火山 cgt-)都可复制,标出供应商', () => {
    const d = buildTaskDetail(
      card({ status: 'running', taskId: 'task_aSOAy1', upstreamTaskId: UPSTREAM, clientId: 'wb-abc', billing: 'platform' }),
      { index: 3, now: T0 },
    )
    expect(d.title).toBe('#04 · 任务详情')
    expect(field(d, 'taskId')).toMatchObject({ value: 'task_aSOAy1', copy: true })
    expect(field(d, 'taskId').label).toMatch(/网关/)
    expect(field(d, 'upstreamTaskId')).toMatchObject({ value: UPSTREAM, copy: true })
    expect(field(d, 'upstreamTaskId').hint).toMatch(/火山/)
    expect(field(d, 'clientId')).toMatchObject({ value: 'wb-abc', copy: true })
    expect(field(d, 'cardId').value).toBe('card0000aa')
    expect(field(d, 'billing').value).toMatch(/平台/)
  })

  it('万相卡的上游供应商标成阿里云百炼', () => {
    const d = buildTaskDetail(
      card({ model: 'wan3', status: 'running', taskId: 'task_w', upstreamTaskId: '316bb68d-414d', billing: 'platform' }),
      { index: 0 },
    )
    expect(field(d, 'upstreamTaskId').hint).toMatch(/阿里|百炼|DashScope/)
  })

  it('直连(自填 Key)没有另一跳:上游任务 ID 行直接给任务 ID,并说明原因', () => {
    const d = buildTaskDetail(card({ status: 'succeeded', taskId: 'cgt-direct-1', billing: 'own-key' }), { index: 0 })
    expect(field(d, 'taskId').label).toMatch(/直连/)
    expect(field(d, 'upstreamTaskId')).toMatchObject({ value: 'cgt-direct-1', copy: true })
    expect(field(d, 'upstreamTaskId').hint).toMatch(/直连/)
  })

  it('网关还没回传上游号:该行标 missing,不给复制按钮', () => {
    const d = buildTaskDetail(card({ status: 'queued', taskId: 'task_x', billing: 'platform' }), { index: 0 })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ missing: true })
    expect(field(d, 'upstreamTaskId').copy).toBeFalsy()
    expect(field(d, 'upstreamTaskId').value).toMatch(/尚未/)
  })

  it('从没提交到上游(准备阶段就失败):任务 ID 与上游任务 ID 都标 missing', () => {
    const d = buildTaskDetail(card({ status: 'failed', error: '素材上传失败' }), { index: 0 })
    expect(field(d, 'taskId')).toMatchObject({ missing: true })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ missing: true })
  })
})

describe('请求参数', () => {
  it('记规格与素材;素材只记名字与 https/本地地址,data: 字节绝不进文档', () => {
    const d = buildTaskDetail(
      card({
        status: 'running',
        taskId: 't',
        seed: 42,
        webSearch: true,
        referenceImages: [
          { name: '贴图.png', src: 'data:image/png;base64,AAAABBBBCCCCDDDD' },
          { name: '立绘', src: 'https://cos.example/a.png' },
          { name: 'local.png', src: 'D:\\refs\\local.png' },
        ],
      }),
      { index: 0 },
    )
    expect(d.request).toMatchObject({
      prompt: '一只赛博猫在雨夜奔跑',
      model: '2.5',
      mode: 'multimodal_ref',
      resolution: '480p',
      ratio: '16:9',
      duration: 6,
      generateAudio: true,
      webSearch: true,
      seed: 42,
    })
    const images = (d.request as { referenceImages: Array<Record<string, unknown>> }).referenceImages
    expect(images).toEqual([
      { name: '贴图.png', src: '(内嵌 data: 图,已省略)' },
      { name: '立绘', src: 'https://cos.example/a.png' },
      { name: 'local.png', src: 'D:\\refs\\local.png' },
    ])
    expect(d.json).not.toContain('AAAABBBB')
    expect(JSON.parse(d.json)).toMatchObject({ ids: { upstreamTaskId: null }, request: { seed: 42 } })
  })

  it('提交过的卡:素材 src 用实际递给上游的 https 地址,本地路径退到 local;data: 图有了地址就不再是占位', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        referenceImages: [
          { name: '下载 (2).png', src: 'C:\\Users\\me\\Downloads\\下载 (2).png' },
          { name: '贴图.png', src: 'data:image/png;base64,AAAABBBBCCCCDDDD' },
          { name: '立绘', src: 'https://cos.example/a.png' },
        ],
        referenceVideos: [{ name: 'ref.mp4', src: 'D:\\clips\\ref.mp4' }],
        submittedReferences: {
          images: ['https://cos.example/relay/1.png', 'https://cos.example/relay/2.png', 'https://cos.example/a.png'],
          videos: ['https://cos.example/relay/ref.mp4'],
          audios: [],
        },
      }),
      { index: 0 },
    )
    const req = d.request as {
      referenceImages: Array<Record<string, unknown>>
      referenceVideos: Array<Record<string, unknown>>
    }
    expect(req.referenceImages).toEqual([
      { name: '下载 (2).png', src: 'https://cos.example/relay/1.png', local: 'C:\\Users\\me\\Downloads\\下载 (2).png' },
      { name: '贴图.png', src: 'https://cos.example/relay/2.png' },
      { name: '立绘', src: 'https://cos.example/a.png' },
    ])
    expect(req.referenceVideos).toEqual([{ name: 'ref.mp4', src: 'https://cos.example/relay/ref.mp4', local: 'D:\\clips\\ref.mp4' }])
    expect(d.json).not.toContain('AAAABBBB')
  })

  it('递上去的地址条数与卡上素材对不上(老数据 / 被上游折叠):按下标能对上的用地址,其余退回原样', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        referenceImages: [
          { name: 'a.png', src: 'C:\\a.png' },
          { name: 'b.png', src: 'C:\\b.png' },
        ],
        submittedReferences: { images: ['https://cos.example/relay/a.png'], videos: [], audios: [] },
      }),
      { index: 0 },
    )
    const images = (d.request as { referenceImages: Array<Record<string, unknown>> }).referenceImages
    expect(images).toEqual([
      { name: 'a.png', src: 'https://cos.example/relay/a.png', local: 'C:\\a.png' },
      { name: 'b.png', src: 'C:\\b.png' },
    ])
  })
})

describe('时间与结果', () => {
  it('进行中:耗时按 now 算;终态:按 updatedAt 算', () => {
    const running = buildTaskDetail(
      card({ status: 'running', taskId: 't', startedAt: T0, updatedAt: T0 + 5_000 }),
      { index: 0, now: T0 + 95_000 },
    )
    expect(field(running, 'elapsed').value).toBe('1 分 35 秒')
    const done = buildTaskDetail(
      card({ status: 'succeeded', taskId: 't', startedAt: T0, updatedAt: T0 + 61_000 }),
      { index: 0, now: T0 + 999_000 },
    )
    expect(field(done, 'elapsed').value).toBe('1 分 01 秒')
  })

  it('结果区:本地成片带 path(给「在文件夹中显示」),云端与临时地址可复制,计费口径按模型', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        localPath: 'D:\\out\\v.mp4',
        remoteUrl: 'https://cos.example/v.mp4',
        videoUrl: 'https://tos.example/tmp.mp4',
        persistence: 'done',
        actualSeed: 7,
        completionTokens: 81234,
      }),
      { index: 0 },
    )
    expect(field(d, 'localPath')).toMatchObject({ value: 'D:\\out\\v.mp4', path: 'D:\\out\\v.mp4', copy: true })
    expect(field(d, 'remoteUrl')).toMatchObject({ value: 'https://cos.example/v.mp4', copy: true })
    expect(field(d, 'videoUrl')).toMatchObject({ value: 'https://tos.example/tmp.mp4', copy: true })
    expect(field(d, 'actualSeed').value).toBe('7')
    expect(field(d, 'billed').value).toMatch(/81,?234/)
    expect(field(d, 'billed').label).toMatch(/token/i)
  })

  it('失败卡:错误原文进结果区;按秒计费的万相显示秒数', () => {
    const failed = buildTaskDetail(card({ status: 'failed', taskId: 't', error: 'ContentFilter: 触发审核' }), { index: 0 })
    expect(field(failed, 'error').value).toBe('ContentFilter: 触发审核')
    const wan = buildTaskDetail(card({ model: 'wan3', status: 'succeeded', taskId: 't', billedSeconds: 5 }), { index: 0 })
    expect(field(wan, 'billed').value).toBe('5 秒')
  })
})

describe('历史版本', () => {
  it('每版一行:序号 / 时间 / 任务号 / 上游任务号', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't2',
        upstreamTaskId: 'cgt-2',
        versions: [
          { id: 'v1', seq: 1, createdAt: T0, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4', spec: specOf() },
          { id: 'v2', seq: 2, createdAt: T0 + 60_000, taskId: 't2', upstreamTaskId: 'cgt-2', spec: specOf() },
        ],
      }),
      { index: 0 },
    )
    const versions = d.sections.find((s) => s.key === 'versions')!
    expect(versions.fields.map((f) => f.label)).toEqual(['v1', 'v2'])
    expect(versions.fields[0].value).toMatch(/t1/)
    expect(versions.fields[0].value).toMatch(/cgt-1/)
    const parsed = JSON.parse(d.json) as { versions: Array<Record<string, unknown>> }
    expect(parsed.versions).toEqual([
      expect.objectContaining({ seq: 1, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4' }),
      expect.objectContaining({ seq: 2, taskId: 't2', upstreamTaskId: 'cgt-2' }),
    ])
  })

  it('没有版本就没有这一区', () => {
    const d = buildTaskDetail(card({ status: 'running', taskId: 't' }), { index: 0 })
    expect(d.sections.find((s) => s.key === 'versions')).toBeUndefined()
  })
})

function specOf() {
  return {
    prompt: 'p',
    model: '2.5' as const,
    resolution: '480p' as const,
    ratio: '16:9' as const,
    duration: 6,
    generateAudio: true,
    mode: 'multimodal_ref' as const,
    webSearch: false,
    referenceBrief: { images: [], videos: [], audios: [] },
  }
}
