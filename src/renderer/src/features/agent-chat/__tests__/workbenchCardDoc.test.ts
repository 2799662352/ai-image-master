// 合成给模型看的那份说明。状态文案是这里唯一的「内容」——模型只能从它判断这张卡
// 为什么还没有产物,所以每个状态都单独钉一条,别让某个分支悄悄退化成裸字段名。

import { describe, it, expect } from 'vitest'
import {
  buildWorkbenchCardDoc,
  buildWorkbenchCardsDoc,
  workbenchCardDocName,
  workbenchCardsDocName,
} from '../workbenchCardDoc'
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

  it('succeeded 但三级地址全无 —— 状态行与产物段都如实写「地址已全部失效」', () => {
    // 这条不是假想:localPath 被 7 天清理扫走、remoteUrl 也没留下的卡就长这样。
    // 写「还没有生成结果」会与用户看到的历史矛盾。
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded' }))
    expect(doc).toContain('状态:成功过,但产物地址已全部失效')
    expect(doc).toContain('当前结果:成功过,但产物地址已全部失效')
  })

  it('succeeded 且有地址 —— 状态写「成功」,绝不能把成功写成失效(describeStatus 要看产物)', () => {
    const doc = buildWorkbenchCardDoc(
      card({ status: 'succeeded', remoteUrl: 'https://cos.example.com/a.mp4' }),
    )
    expect(doc).toContain('状态:成功')
    expect(doc).not.toContain('全部失效')
    expect(doc).not.toContain('还没有产物')
  })

  it('succeeded 且有版本存档 —— 状态带上「当前 vN」(取版本末项的序号)', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'succeeded',
        remoteUrl: 'https://cos.example.com/2.mp4',
        versions: [
          { seq: 1, remoteUrl: 'https://cos.example.com/1.mp4' },
          { seq: 2, remoteUrl: 'https://cos.example.com/2.mp4' },
        ],
      }),
    )
    expect(doc).toContain('状态:成功(当前 v2)')
    expect(doc).toContain('- 当前版本:v2')
  })

  it('失败的卡不写「当前 vN」,但提醒之前出过几版 —— 重新生成会清掉这一轮的地址,上一轮成品在存档里', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'failed',
        error: '上游超时',
        versions: [{ seq: 1, remoteUrl: 'https://cos.example.com/1.mp4' }],
      }),
    )
    expect(doc).toContain('状态:失败(可重试)')
    expect(doc).not.toContain('当前 v')
    expect(doc).toContain('之前出过 1 版')
  })

  it('失败的卡就算还残留着一个旧地址,也不冒充「当前版本 vN」(只有成功才有当前版本)', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'failed',
        remoteUrl: 'https://cos.example.com/stale.mp4',
        versions: [{ seq: 3, remoteUrl: 'https://cos.example.com/3.mp4' }],
      }),
    )
    expect(doc).toContain('状态:失败(可重试)')
    expect(doc).toContain('https://cos.example.com/stale.mp4')
    expect(doc).not.toContain('当前版本')
    expect(doc).not.toContain('当前 v')
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

  it('标题不再写「还没有产物」—— 完成的卡也用这份说明书', () => {
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded', localPath: 'C:/u/a.mp4' }))
    expect(doc.split('\n')[0]).toBe('# 视频工作台卡片')
    expect(doc).not.toContain('还没有产物')
  })

  it('素材段只有展示名 —— 产物段有路径 / URL 不等于素材也有', () => {
    const item = card({ status: 'succeeded', remoteUrl: 'https://cos.example.com/a.mp4' })
    item.spec!.referenceBrief = { images: ['_marshals.png'], videos: [], audios: [] }
    const doc = buildWorkbenchCardDoc(item)
    // 「参考素材」是清单的最后一节(产物、历史版本都在它前面)。
    expect(doc.indexOf('## 产物')).toBeLessThan(doc.indexOf('## 参考素材'))
    const materialSection = doc.slice(doc.indexOf('## 参考素材'))
    expect(materialSection).toContain('_marshals.png')
    expect(materialSection).not.toMatch(/https?:\/\//)
    expect(materialSection).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('产物段', () => {
  it('三级地址各占一行,并提醒本地文件可能已被清理', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'succeeded',
        localPath: 'C:/u/agent/uploads/a.mp4',
        remoteUrl: 'https://cos.example.com/a.mp4',
        videoUrl: 'https://ark.example.com/tmp/a.mp4',
      }),
    )
    expect(doc).toContain('## 产物')
    expect(doc).toContain('- 本地文件:C:/u/agent/uploads/a.mp4')
    expect(doc).toContain('- 云端地址(永久):https://cos.example.com/a.mp4')
    expect(doc).toContain('- 上游临时地址(有效期未知):https://ark.example.com/tmp/a.mp4')
    expect(doc).toContain('7 天清理')
  })

  it('缺的那级写「无」,不留空', () => {
    const doc = buildWorkbenchCardDoc(
      card({ status: 'succeeded', remoteUrl: 'https://cos.example.com/a.mp4' }),
    )
    expect(doc).toContain('- 本地文件:无')
    expect(doc).toContain('- 上游临时地址(有效期未知):无')
  })

  it('一个地址都没有、也不是成功态 —— 写「暂无」并指回状态行', () => {
    const doc = buildWorkbenchCardDoc(card({ status: 'running' }))
    expect(doc).toContain('## 产物')
    expect(doc).toContain('当前结果:暂无')
    expect(doc).not.toContain('全部失效')
  })

  it('每种状态都有产物段(草稿 / 渲染中 / 失败 / 完成)', () => {
    for (const status of ['draft', 'running', 'failed', 'succeeded']) {
      expect(buildWorkbenchCardDoc(card({ status }))).toContain('## 产物')
    }
  })

  it('老载荷(没有 spec)也带产物段 —— 少规格不该连产物地址一起丢', () => {
    const doc = buildWorkbenchCardDoc({
      cardId: 'card-old',
      status: 'succeeded',
      remoteUrl: 'https://cos.example.com/a.mp4',
    })
    expect(doc).toContain('card-old')
    expect(doc).toContain('https://cos.example.com/a.mp4')
  })

  it('远端地址只认 http(s):data: 与含空白的串一律不进说明书(伪造载荷挡板)', () => {
    const huge = `data:video/mp4;base64,${'A'.repeat(5000)}`
    const doc = buildWorkbenchCardDoc(
      card({ status: 'succeeded', remoteUrl: huge, videoUrl: 'https://x.example.com/a b.mp4' }),
    )
    expect(doc).not.toContain('base64')
    expect(doc).not.toContain('a b.mp4')
    expect(doc).toContain('产物地址已全部失效')
  })

  it('超长地址当不可信丢掉而不是截断 —— 截断过的 URL 是错的', () => {
    const long = `https://cos.example.com/${'a'.repeat(4100)}.mp4`
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded', remoteUrl: long }))
    expect(doc).not.toContain('aaaaaaaaaa')
    expect(doc).toContain('产物地址已全部失效')
  })

  it('路径里的换行折成一行,不把一个字段写成多行 Markdown', () => {
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded', localPath: 'C:/u/a\n## 注入\n.mp4' }))
    expect(doc).toContain('- 本地文件:C:/u/a ## 注入 .mp4')
    expect(doc.split('\n').filter((l) => l === '## 注入')).toEqual([])
  })
})

describe('历史版本', () => {
  const T = new Date(2026, 10, 2, 12, 5).getTime()

  it('每版一行:序号 · 时间 · 规格 · 一个最耐久的地址 · 提示词首行', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'succeeded',
        versions: [
          {
            seq: 1,
            createdAt: T,
            localPath: 'C:/u/v1.mp4',
            remoteUrl: 'https://cos.example.com/v1.mp4',
            prompt: '雨夜霓虹下的猫',
            model: '2.0-pro',
            resolution: '480p',
            duration: 3,
          },
        ],
      }),
    )
    expect(doc).toContain('## 历史版本(共 1 版)')
    // 云端 > 本地 > 临时:一版只挑一个最耐久的(当前版本的全部地址在「产物」段)
    expect(doc).toContain(
      '- v1 · 2026-11-02 12:05 · seedance-2.0-pro 480p 3s · 云端:https://cos.example.com/v1.mp4 · 提示词:雨夜霓虹下的猫',
    )
    expect(doc).not.toContain('本地:C:/u/v1.mp4')
  })

  it('没有云端地址时退到本地,再退到临时', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        versions: [
          { seq: 1, localPath: 'C:/u/v1.mp4', videoUrl: 'https://ark.example.com/1.mp4' },
          { seq: 2, videoUrl: 'https://ark.example.com/2.mp4' },
        ],
      }),
    )
    expect(doc).toContain('- v1 · 本地:C:/u/v1.mp4')
    expect(doc).toContain('- v2 · 临时:https://ark.example.com/2.mp4')
  })

  it('这一版没有任何地址 → 标「地址已失效」,不是留一行光杆序号', () => {
    const doc = buildWorkbenchCardDoc(
      card({ versions: [{ seq: 2, createdAt: T, prompt: '雨夜霓虹下的猫' }] }),
    )
    expect(doc).toContain('- v2 · 2026-11-02 12:05 · 地址已失效')
  })

  it('历史版本只留提示词首行 —— 多行提示词的后面几行不进清单,指路 video_workbench_export', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        versions: [
          { seq: 1, prompt: '第一行镜头\n第二行不该出现\n第三行也不该', remoteUrl: 'https://c.example.com/1.mp4' },
        ],
      }),
    )
    expect(doc).toContain('提示词:第一行镜头')
    expect(doc).not.toContain('第二行不该出现')
    expect(doc).toContain('video_workbench_export')
    expect(doc).toContain('cardIds')
  })

  it('历史版本的提示词首行最多 120 字,超出截断并加省略号;当前版本全文在「提示词」段', () => {
    const doc = buildWorkbenchCardDoc(
      card({ versions: [{ seq: 1, prompt: '长'.repeat(500), remoteUrl: 'https://c.example.com/1.mp4' }] }),
    )
    expect(doc).toContain(`提示词:${'长'.repeat(120)}…`)
    expect(doc).not.toContain('长'.repeat(121))
  })

  it('十版长提示词也不把清单撑大:当前全文 + 十行摘要', () => {
    const versions = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      prompt: `版本${i + 1}:${'词'.repeat(3000)}`,
      remoteUrl: `https://c.example.com/${i + 1}.mp4`,
    }))
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded', remoteUrl: 'https://c.example.com/10.mp4', versions }))
    expect(doc.length).toBeLessThan(4000)
  })

  it('版本再多也只列最近 20 版,并如实说共多少版', () => {
    const versions = Array.from({ length: 25 }, (_, i) => ({
      seq: i + 1,
      remoteUrl: `https://c.example.com/${i + 1}.mp4`,
    }))
    const doc = buildWorkbenchCardDoc(card({ versions }))
    expect(doc).toContain('## 历史版本(共 25 版,只列最近 20 版)')
    expect(doc).toContain('- v25 ')
    expect(doc).toContain('- v6 ')
    expect(doc).not.toContain('- v5 ')
  })

  it('没有版本就没有「历史版本」小节', () => {
    // 开头的引言会提到「历史版本」这几个字,所以看的是小节标题,不是子串。
    expect(buildWorkbenchCardDoc(card())).not.toMatch(/^#{2,3} 历史版本/m)
  })

  it('伪造的 versions 不让生成抛 —— 不是数组 / 缺 seq / 非对象的项都跳过', () => {
    const forged = card({
      versions: [null, 7, { prompt: 'x' }, { seq: 'one' }, { seq: 3, createdAt: 1e20 }] as never,
    })
    const doc = buildWorkbenchCardDoc(forged)
    expect(doc).toContain('## 历史版本(共 1 版)')
    expect(doc).toContain('- v3 ')
    expect(buildWorkbenchCardDoc(card({ versions: 'nope' as never }))).not.toMatch(/^#{2,3} 历史版本/m)
  })

  it('版本里伪造的 data: 地址 / 带空白地址不进清单(同当前版本的挡板)', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        versions: [
          { seq: 1, remoteUrl: `data:video/mp4;base64,${'A'.repeat(5000)}` },
          { seq: 2, remoteUrl: 'https://x.example.com/a b.mp4' },
        ],
      }),
    )
    expect(doc).not.toContain('base64')
    expect(doc).not.toContain('a b.mp4')
    expect(doc).toContain('- v1 · 地址已失效')
    expect(doc).toContain('- v2 · 地址已失效')
  })
})

describe('现状字段:项目 / 分段 / 任务号 / 种子 / 时间', () => {
  const T1 = new Date(2026, 10, 2, 12, 5).getTime()
  const T2 = new Date(2026, 10, 2, 12, 9).getTime()

  it('项目名、分段名、任务号、上游任务号、创建 / 完成时间都写出来', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        status: 'succeeded',
        remoteUrl: 'https://c.example.com/a.mp4',
        projectName: '赛博猫',
        boardName: '第一幕',
        taskId: 'task_abc123',
        upstreamTaskId: 'cgt-2026-xyz',
        createdAt: T1,
        completedAt: T2,
      }),
    )
    expect(doc).toContain('- 项目:赛博猫')
    expect(doc).toContain('- 分段:第一幕')
    expect(doc).toContain('- 任务号(网关):`task_abc123`')
    expect(doc).toContain('- 上游任务号:`cgt-2026-xyz`')
    expect(doc).toContain('- 创建时间:2026-11-02 12:05')
    expect(doc).toContain('- 完成时间:2026-11-02 12:09')
  })

  it('实际种子与请求种子分开写:请求随机时,实际种子才是复现这一版的钥匙', () => {
    const doc = buildWorkbenchCardDoc(card({ status: 'succeeded', remoteUrl: 'https://c.example.com/a.mp4', actualSeed: 987654 }))
    expect(doc).toContain('- 请求种子:随机')
    expect(doc).toContain('- 实际种子:987654')
    const seeded = card({ actualSeed: 0 })
    seeded.spec!.seed = 12
    const doc2 = buildWorkbenchCardDoc(seeded)
    expect(doc2).toContain('- 请求种子:12')
    expect(doc2).toContain('- 实际种子:0')
  })

  it('没有的字段整行不写,不留「undefined」/「无」占位', () => {
    const doc = buildWorkbenchCardDoc(card())
    // 开头的引言里有「任务号」这几个字,所以按「- 标签:」的行首匹配。
    for (const label of ['- 项目:', '- 分段:', '- 任务号', '- 上游任务号', '- 实际种子', '- 创建时间', '- 完成时间']) {
      expect(doc).not.toContain(label)
    }
    expect(doc).not.toContain('undefined')
  })

  it('伪造载荷:任务号只认安全字符、名字折成一行、时间 / 种子类型不对就跳过 —— 不抛', () => {
    const doc = buildWorkbenchCardDoc(
      card({
        projectName: '甲\n## 注入',
        boardName: 123 as never,
        taskId: 'task`\n# bad',
        upstreamTaskId: { x: 1 } as never,
        actualSeed: 'seed' as never,
        createdAt: 'yesterday' as never,
        completedAt: Number.NaN,
      }),
    )
    expect(doc).toContain('- 项目:甲 ## 注入')
    expect(doc.split('\n')).not.toContain('## 注入')
    expect(doc).not.toContain('- 分段:')
    expect(doc).not.toContain('- 任务号')
    expect(doc).not.toContain('- 上游任务号')
    expect(doc).not.toContain('- 实际种子')
    expect(doc).not.toContain('- 创建时间')
    expect(doc).not.toContain('- 完成时间')
  })
})

describe('合并清单 buildWorkbenchCardsDoc', () => {
  it('一张卡一个「## 卡片 <id>」段,小节降到 ###,总标题带张数', () => {
    const doc = buildWorkbenchCardsDoc([
      card({ cardId: 'aaa', status: 'succeeded', remoteUrl: 'https://c.example.com/a.mp4' }),
      card({ cardId: 'bbb', status: 'failed', error: '审核未通过' }),
      card({ cardId: 'ccc' }),
    ])
    expect(doc.split('\n')[0]).toBe('# 视频工作台卡片(共 3 张)')
    expect(doc).toContain('## 卡片 aaa')
    expect(doc).toContain('## 卡片 bbb')
    expect(doc).toContain('## 卡片 ccc')
    expect(doc.match(/^### 提示词$/gm)).toHaveLength(3)
    expect(doc.match(/^### 产物$/gm)).toHaveLength(3)
    // 单卡版的 ## 级小节不能漏进合并版,否则小节会脱离卡片段
    expect(doc).not.toMatch(/^## (提示词|产物|参考素材|历史版本)/m)
  })

  it('每张卡各写各的状态与产物,不串味(完成 / 失败 / 草稿)', () => {
    const doc = buildWorkbenchCardsDoc([
      card({ cardId: 'aaa', status: 'succeeded', remoteUrl: 'https://c.example.com/a.mp4' }),
      card({ cardId: 'bbb', status: 'failed', error: '审核未通过' }),
    ])
    const b = doc.indexOf('## 卡片 bbb')
    const first = doc.slice(0, b)
    const second = doc.slice(b)
    expect(first).toContain('状态:成功')
    expect(first).toContain('https://c.example.com/a.mp4')
    expect(first).not.toContain('审核未通过')
    expect(second).toContain('状态:失败(可重试)')
    expect(second).toContain('审核未通过')
    expect(second).not.toContain('https://c.example.com/a.mp4')
  })

  it('每张卡的历史版本也挂在自己的段下', () => {
    const doc = buildWorkbenchCardsDoc([
      card({ cardId: 'aaa', versions: [{ seq: 1, remoteUrl: 'https://c.example.com/a1.mp4' }] }),
      card({ cardId: 'bbb', versions: [{ seq: 1, remoteUrl: 'https://c.example.com/b1.mp4' }] }),
    ])
    const b = doc.indexOf('## 卡片 bbb')
    expect(doc.slice(0, b)).toContain('a1.mp4')
    expect(doc.slice(0, b)).not.toContain('b1.mp4')
    expect(doc.slice(b)).toContain('b1.mp4')
    expect(doc.match(/^### 历史版本/gm)).toHaveLength(2)
  })

  it('伪造的 cardId(换行 / 反引号 / 非字符串)进不了标题,不把一行写成多行', () => {
    const doc = buildWorkbenchCardsDoc([
      card({ cardId: 'x\n## 注入\n`' }),
      { cardId: 7 } as never,
    ])
    expect(doc.split('\n').filter((line) => line === '## 注入')).toEqual([])
    expect(doc).toContain('## 卡片 x_## 注入_')
    expect(doc).toContain('## 卡片 未知')
  })

  it('合并清单的附件名带张数', () => {
    expect(workbenchCardsDocName(10)).toBe('workbench-cards-10.md')
  })
})
