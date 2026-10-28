// 可灵在工作台「周边」数据层的落点:工程文件导入、任务详情。
// (规格 / 提交闸 / 换模型收敛见 cardSpec.kling.test.ts;估价见 pricing.kling.test.ts。)

import { describe, expect, it } from 'vitest'
import { buildCard } from '../cardSpec'
import { planImport } from '../projectFile'
import { buildTaskDetail } from '../taskDetail'

describe('工程文件导入 · 可灵的 2k / 4k 与 21:9 不被悄悄丢掉', () => {
  const file = (resolution: string, ratio: string) =>
    ({
      boards: [
        {
          name: 'b',
          cards: [
            {
              prompt: 'p',
              model: 'kling4',
              resolution,
              ratio,
              duration: 5,
              generateAudio: true,
              webSearch: false,
              referenceImages: [],
              referenceVideos: [],
              referenceAudios: [],
            },
          ],
        },
      ],
    }) as never

  it('保留可灵独有的档位与画幅', () => {
    const input = planImport(file('2k', '21:9')).boards[0].cards[0].input
    expect(input.resolution).toBe('2k')
    expect(input.ratio).toBe('21:9')
    expect(planImport(file('4k', '1:1')).boards[0].cards[0].input.resolution).toBe('4k')
  })

  it('任何模型都没有的值照旧被省略(交给 normalizeSpec 补默认)', () => {
    const input = planImport(file('8k', '5:4')).boards[0].cards[0].input
    expect(input.resolution).toBeUndefined()
    expect(input.ratio).toBeUndefined()
  })
})

describe('任务详情 · 可灵的上游供应商', () => {
  it('上游任务号标成腾讯云 VOD,而不是火山', () => {
    const detail = buildTaskDetail(
      {
        ...buildCard({ prompt: 'x', model: 'kling4' }, 0),
        status: 'running',
        taskId: 'task_k',
        upstreamTaskId: '1234567890-vod-abc',
        billing: 'platform',
      },
      { index: 0 },
    )
    const hint = detail.sections.flatMap((s) => s.fields).find((f) => f.key === 'upstreamTaskId')?.hint ?? ''
    expect(hint).toMatch(/腾讯云|VOD|可灵/)
    expect(hint).not.toMatch(/火山/)
  })
})
