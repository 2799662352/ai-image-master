// 合成给模型看的那份说明。状态文案是这里唯一的「内容」——模型只能从它判断这张卡
// 为什么还没有产物,所以每个状态都单独钉一条,别让某个分支悄悄退化成裸字段名。

import { describe, it, expect } from 'vitest'
import { buildWorkbenchCardDoc, workbenchCardDocName } from '../workbenchCardDoc'
import type { WorkbenchCardDragItem } from '../../file-explorer/dragHelpers'

function card(overrides: Partial<WorkbenchCardDragItem> = {}): WorkbenchCardDragItem {
  return {
    cardId: 'abcdef0123456789',
    status: 'draft',
    spec: {
      prompt: '雨夜霓虹下的猫',
      model: '2.0-pro',
      resolution: '720p',
      ratio: '9:16',
      duration: 5,
      generateAudio: false,
      mode: 'multimodal_ref',
      webSearch: true,
      referenceBrief: { images: [], videos: ['ref.mp4'], audios: [] },
    },
    ...overrides,
  }
}

describe('状态文案', () => {
  it.each([
    ['draft', '草稿'],
    ['preparing', '准备中'],
    ['queued', '排队中'],
    ['running', '渲染中'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ])('%s → 说人话', (status, expected) => {
    expect(buildWorkbenchCardDoc(card({ status }))).toContain(expected)
  })

  it('状态是 succeeded 却走到这里,说明三级地址全失效 —— 如实写出来', () => {
    // 这条不是假想:localPath 被 7 天清理扫走、remoteUrl 也没留下的卡就长这样。
    // 写「还没有生成结果」会与用户看到的历史矛盾。
    expect(buildWorkbenchCardDoc(card({ status: 'succeeded' }))).toContain('产物地址已全部失效')
  })

  it('状态缺席写「未知」,不留空', () => {
    expect(buildWorkbenchCardDoc(card({ status: undefined }))).toContain('状态:未知')
  })
})

describe('规格与素材', () => {
  it('-1 是智能时长,不是「-1 秒」', () => {
    const item = card()
    item.spec!.duration = -1
    expect(buildWorkbenchCardDoc(item)).toContain('智能时长')
  })

  it('种子缺席写「随机」,给了 0 就写 0(0 是合法种子,别被真值判断吞掉)', () => {
    expect(buildWorkbenchCardDoc(card())).toContain('种子:随机')
    const seeded = card()
    seeded.spec!.seed = 0
    expect(buildWorkbenchCardDoc(seeded)).toContain('种子:0')
  })

  it('素材按类分行,有几个就标几个,没有就写「无」', () => {
    const doc = buildWorkbenchCardDoc(card())
    expect(doc).toContain('- 参考视频(1):ref.mp4')
    expect(doc).toContain('- 参考图:无')
    expect(doc).toContain('- 参考音频:无')
  })

  it('附件名取 id 前 8 位 —— 同一张卡反复拖会被主进程内容寻址去重', () => {
    expect(workbenchCardDocName(card())).toBe('workbench-card-abcdef01.md')
  })
})
