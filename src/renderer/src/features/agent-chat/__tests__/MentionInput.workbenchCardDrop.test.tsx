// 工作台卡片拖进聊天栏。每张卡递两样东西:**清单**(Markdown 附件,任何状态都有)+
// 产物(本地 mp4 / 耐久 URL)。清单先挂、产物后挂;多张卡合成**一份**清单。
//
// 演变:最早未出片只弹一句提示;后来改成未出片才合成说明书,出片的卡只递产物 ——
// 于是完成卡永远没有说明书,提示词 / 规格 / 版本这些「怎么生成的」信息丢了,换机器
// 或本地 mp4 被 7 天清理后就复现不了。再后来每张卡一份清单,但附件上限 20,10 张完成卡
// 各挂「视频 + 清单」正好占满 —— 现在多卡合并成一份、只占 1 个位置。同时:只看 localPath
// 会把「本地 mp4 被 7 天清理扫走、COS 上还在」的卡说成「还没有生成结果」,而播放器那边
// 照样放得出来;localPath 在卡上、文件却已被清理时,也要接着退到云端地址。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'
import type { WorkbenchCardDragItem } from '../../file-explorer/dragHelpers'

const WORKBENCH_CARD_MIME = 'application/x-catimation-workbench-cards'

afterEach(cleanup)

/** jsdom 没有 DataTransfer;只喂卡片那一个 MIME,其余 getData 返回 '' 以短路引文/文件分支。 */
function makeCardTransfer(items: WorkbenchCardDragItem[]): DataTransfer {
  const payload = JSON.stringify(items)
  return {
    types: [WORKBENCH_CARD_MIME],
    files: [] as unknown as FileList,
    getData: (type: string) => (type === WORKBENCH_CARD_MIME ? payload : ''),
    setData: () => {},
  } as unknown as DataTransfer
}

function draftCard(overrides: Partial<WorkbenchCardDragItem> = {}): WorkbenchCardDragItem {
  return {
    cardId: 'card-0123456789',
    status: 'draft',
    spec: {
      prompt: '赛博朋克猫在雨夜霓虹里回头',
      model: '2.0-pro',
      resolution: '1080p',
      ratio: '16:9',
      duration: 5,
      generateAudio: true,
      mode: 'multimodal_ref',
      webSearch: false,
      referenceBrief: { images: ['猫.png', '街景.png'], videos: [], audios: [] },
    },
    ...overrides,
  }
}

async function drop(items: WorkbenchCardDragItem[]): Promise<void> {
  render(<MentionInput />)
  fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: makeCardTransfer(items) })
  // onDrop 是 async(已出片那一级要 await fs.stat);冲一次微任务队列
  await new Promise((r) => setTimeout(r, 0))
}

function decodeOnlyAttachment(): string {
  const attachments = useAgentChatStore.getState().attachments
  expect(attachments).toHaveLength(1)
  const buffer = attachments[0].buffer
  // 刻意不写 toBeInstanceOf(ArrayBuffer):jsdom 里 TextEncoder 来自 Node realm,
  // 跨 realm 的 instanceof 恒假,而运行时(渲染进程)两者同 realm。只验字节。
  expect(buffer?.byteLength ?? 0).toBeGreaterThan(0)
  return new TextDecoder().decode(new Uint8Array(buffer!))
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: { stat: vi.fn(async () => ({ ok: true, size: 1024, mime: 'video/mp4', mtime: 1 })) },
      getFilePath: vi.fn(() => ''),
    },
    configurable: true,
  })
  useAgentChatStore.setState({
    input: '',
    attachments: [],
    pendingReferences: [],
    error: undefined,
  } as never)
})

describe('还没有产物的卡:递一份规格说明,而不是只弹提示', () => {
  it('合成 Markdown 附件而不是空手而归', async () => {
    await drop([draftCard()])

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ name: 'workbench-card-card-012.md', mime: 'text/markdown' })
    expect(attachments[0].size).toBeGreaterThan(0)
    // 磁盘上没有这张卡的任何文件,所以只能走 buffer;path 必须缺席,否则主进程会去读一个不存在的文件。
    expect(attachments[0].path).toBeUndefined()
    // 旧行为是这一句;它现在不该再出现。
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('说明里带上 cardId、状态、提示词与素材名 —— 模型据此能直接调工作台工具', async () => {
    await drop([draftCard()])
    const doc = decodeOnlyAttachment()

    expect(doc).toContain('card-0123456789')
    expect(doc).toContain('草稿')
    expect(doc).toContain('赛博朋克猫在雨夜霓虹里回头')
    expect(doc).toContain('seedance-2.0-pro · 1080p · 16:9 · 5s')
    expect(doc).toContain('猫.png、街景.png')
    expect(doc).toContain('参考视频:无')
  })

  it('失败的卡把错误原文带过去,-1 时长写成「智能时长」', async () => {
    const card = draftCard({ status: 'failed', error: '上游拒绝:内容审核未通过' })
    card.spec!.duration = -1
    await drop([card])
    const doc = decodeOnlyAttachment()

    expect(doc).toContain('失败')
    expect(doc).toContain('上游拒绝:内容审核未通过')
    expect(doc).toContain('智能时长')
  })

  it('老载荷(没有 spec)退化成只给 id,不是崩掉也不是静默落空', async () => {
    await drop([{ cardId: 'card-old' }])
    const doc = decodeOnlyAttachment()

    expect(doc).toContain('card-old')
    expect(doc).toContain('video_workbench')
  })

  it('形状不对的载荷照样出一份说明,不让整个 drop 静默失败', async () => {
    // 聊天栏接受来自任何地方的拖放,外部页面在 dragstart 里照样能写我们这个 MIME;
    // parseWorkbenchCardDrop 只校验到 cardId 是字符串就放行。所以字段得当外来数据读:
    // 早先 spec.prompt.trim() 会在这种载荷上抛,onDrop 是 async → 变成一次静默失败。
    await drop([
      {
        cardId: 'card-bad',
        status: 42,
        spec: { prompt: {}, duration: 'five', referenceBrief: { images: 'nope' } },
      } as unknown as WorkbenchCardDragItem,
    ])
    const doc = decodeOnlyAttachment()

    expect(doc).toContain('card-bad')
    expect(doc).toContain('(空)')
    expect(doc).toContain('未知时长')
    expect(doc).toContain('参考图:无')
  })

  it('不 push reference —— 这份文档要等主进程落盘才有路径', async () => {
    await drop([draftCard()])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })
})

describe('已出片的卡:清单在前,本地 mp4 走附件 + 引用', () => {
  it('清单先挂、mp4 后挂,并留下一条引用', async () => {
    await drop([draftCard({ status: 'succeeded', localPath: 'C:/u/agent/uploads/a.mp4' })])

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments.map((a) => a.name)).toEqual(['workbench-card-card-012.md', 'a.mp4'])
    expect(attachments[1]).toMatchObject({ name: 'a.mp4', mime: 'video/mp4', path: 'C:/u/agent/uploads/a.mp4' })
    expect(attachments[1].buffer).toBeUndefined()
    // 卡片产物躺在 uploads 里,主进程 mapReferencesToInputItems 的白名单认这个目录,
    // 所以这一路可以放心双写(外部 OS 拖放刻意不写引用,原因见 externalDrop 那份测试)。
    // 说明书不写引用(它要等主进程落盘才有路径),所以引用仍然只有 mp4 那一条。
    expect(useAgentChatStore.getState().pendingReferences).toHaveLength(1)
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('完成卡的清单说清「怎么生成的」+ 现状(任务号 / 种子)+ 产物在哪 + 有哪几版', async () => {
    // 这是这次改动要解决的原问题:完成卡以前只有 mp4,永远没有清单,
    // 提示词 / 规格 / 版本这些「怎么生成的」信息丢了。
    await drop([
      draftCard({
        status: 'succeeded',
        localPath: 'C:/u/agent/uploads/a.mp4',
        remoteUrl: 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4',
        taskId: 'task_abc123',
        upstreamTaskId: 'cgt-2026-xyz',
        actualSeed: 4242,
        projectName: '赛博猫',
        boardName: '分段 1',
        versions: [
          { seq: 1, remoteUrl: 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/v1.mp4', prompt: '旧提示词' },
          { seq: 2, localPath: 'C:/u/agent/uploads/a.mp4', prompt: '赛博朋克猫在雨夜霓虹里回头' },
        ],
      }),
    ])

    const attachments = useAgentChatStore.getState().attachments
    const doc = new TextDecoder().decode(new Uint8Array(attachments[0].buffer!))
    expect(doc).toContain('状态:成功(当前 v2)')
    expect(doc).toContain('赛博朋克猫在雨夜霓虹里回头')
    expect(doc).toContain('seedance-2.0-pro · 1080p · 16:9 · 5s')
    expect(doc).toContain('- 项目:赛博猫')
    expect(doc).toContain('- 分段:分段 1')
    expect(doc).toContain('- 请求种子:随机')
    expect(doc).toContain('- 实际种子:4242')
    expect(doc).toContain('- 任务号(网关):`task_abc123`')
    expect(doc).toContain('- 上游任务号:`cgt-2026-xyz`')
    expect(doc).toContain('- 本地文件:C:/u/agent/uploads/a.mp4')
    expect(doc).toContain('- 云端地址(永久):https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4')
    expect(doc).toContain('## 历史版本(共 2 版)')
    expect(doc).toContain('提示词:旧提示词')
  })

  it('本地 mp4 读不出时清单照样出 —— 媒体失败不牵连清单(旧版 continue 会连清单一起丢)', async () => {
    const stat = (window as unknown as { electronAPI: { fs: { stat: ReturnType<typeof vi.fn> } } }).electronAPI.fs.stat
    stat.mockResolvedValueOnce({ ok: false })

    await drop([draftCard({ status: 'succeeded', localPath: 'C:/u/agent/uploads/gone.mp4' })])

    const names = useAgentChatStore.getState().attachments.map((a) => a.name)
    expect(names).toEqual(['workbench-card-card-012.md'])
    expect(useAgentChatStore.getState().error).toContain('gone.mp4')
  })
})

describe('本地被 7 天清理扫掉、云端还在:不再误报「还没有生成结果」', () => {
  it('remoteUrl 进输入框,说明书照样配', async () => {
    const url = 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4'
    await drop([draftCard({ status: 'succeeded', remoteUrl: url })])

    expect(useAgentChatStore.getState().input).toContain(url)
    // 产物走 URL(进输入框),说明书照样作为附件递过去,且不再自称「还没有产物」。
    const attachments = useAgentChatStore.getState().attachments
    expect(attachments.map((a) => a.name)).toEqual(['workbench-card-card-012.md'])
    const doc = new TextDecoder().decode(new Uint8Array(attachments[0].buffer!))
    expect(doc).toContain(url)
    expect(doc).not.toContain('还没有产物')
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('localPath 优先于 remoteUrl —— 本地还在就别让模型去拉网络', async () => {
    await drop([
      draftCard({
        status: 'succeeded',
        localPath: 'C:/u/agent/uploads/a.mp4',
        remoteUrl: 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4',
      }),
    ])

    expect(useAgentChatStore.getState().attachments[1].path).toBe('C:/u/agent/uploads/a.mp4')
    expect(useAgentChatStore.getState().input).toBe('')
  })

  it('localPath 在载荷里但文件已被清理:接着退到云端地址,不是直接放弃', async () => {
    // 卡片对 7 天清理是隐形的:localPath 还写在卡上,磁盘上已经没了。
    // 旧行为是读不出就 skip + continue,云端明明还在却什么产物都没递。
    const url = 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4'
    const stat = (window as unknown as { electronAPI: { fs: { stat: ReturnType<typeof vi.fn> } } }).electronAPI.fs.stat
    stat.mockResolvedValueOnce({ ok: false })

    await drop([draftCard({ status: 'succeeded', localPath: 'C:/u/agent/uploads/gone.mp4', remoteUrl: url })])

    expect(useAgentChatStore.getState().input).toContain(url)
    expect(useAgentChatStore.getState().attachments.map((a) => a.name)).toEqual(['workbench-card-card-012.md'])
    // 有云端兜底就不吓用户:没有「已跳过」。
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('本地读不出、也没有任何耐久地址:如实报「已跳过」,说明书仍然递过去', async () => {
    const stat = (window as unknown as { electronAPI: { fs: { stat: ReturnType<typeof vi.fn> } } }).electronAPI.fs.stat
    stat.mockResolvedValueOnce({ ok: false })

    await drop([draftCard({ status: 'succeeded', localPath: 'C:/u/agent/uploads/gone.mp4' })])

    expect(useAgentChatStore.getState().error).toContain('gone.mp4')
    expect(useAgentChatStore.getState().attachments.map((a) => a.name)).toEqual(['workbench-card-card-012.md'])
  })

  it('只剩上游临时地址时也认(最后一级兜底)', async () => {
    await drop([draftCard({ status: 'succeeded', videoUrl: 'https://ark.example.com/tmp/a.mp4' })])
    expect(useAgentChatStore.getState().input).toContain('https://ark.example.com/tmp/a.mp4')
  })

  it('多张卡的 URL 一条都不丢 —— 逐张 appendInput 会各自基于过期快照,只剩最后一条', async () => {
    await drop([
      draftCard({ cardId: 'c1', status: 'succeeded', remoteUrl: 'https://cos.example.com/1.mp4' }),
      draftCard({ cardId: 'c2', status: 'succeeded', remoteUrl: 'https://cos.example.com/2.mp4' }),
    ])

    const input = useAgentChatStore.getState().input
    expect(input).toContain('https://cos.example.com/1.mp4')
    expect(input).toContain('https://cos.example.com/2.mp4')
  })
})

function names(): string[] {
  return useAgentChatStore.getState().attachments.map((a) => a.name)
}

function decodeAttachment(index: number): string {
  const buffer = useAgentChatStore.getState().attachments[index].buffer
  return new TextDecoder().decode(new Uint8Array(buffer!))
}

/** n 张已完成卡,各带本地 mp4(以及可选的云端地址)。 */
function doneCards(n: number, withRemote: boolean): WorkbenchCardDragItem[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `card-${String(i).padStart(2, '0')}-abcdef`
    return draftCard({
      cardId: id,
      status: 'succeeded',
      localPath: `C:/u/agent/uploads/${i}.mp4`,
      ...(withRemote ? { remoteUrl: `https://cos.example.com/${i}.mp4` } : {}),
    })
  })
}

describe('混着拖:多张卡合成一份清单', () => {
  it('出片的 = 清单 + mp4、没出片的 = 只在清单里;清单只有 1 份,一张都不落下', async () => {
    await drop([
      draftCard({ cardId: 'done', status: 'succeeded', localPath: 'C:/u/agent/uploads/a.mp4' }),
      draftCard({ cardId: 'draft-1' }),
    ])

    // 不再是每张卡一份(workbench-card-done.md + workbench-card-draft-1.md):
    // 一份合并清单,md 在前、媒体在后。
    expect(names()).toEqual(['workbench-cards-2.md', 'a.mp4'])
    const doc = decodeAttachment(0)
    expect(doc).toContain('# 视频工作台卡片(共 2 张)')
    expect(doc).toContain('## 卡片 done')
    expect(doc).toContain('## 卡片 draft-1')
    expect(doc).toContain('状态:草稿')
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('单卡拖拽仍然是单卡清单(不叫 workbench-cards-1)', async () => {
    await drop([draftCard()])
    expect(names()).toEqual(['workbench-card-card-012.md'])
    expect(decodeAttachment(0)).not.toContain('## 卡片 ')
  })

  it('合并清单里每张卡的小节挂在「## 卡片 <id>」之下(### 级),互不串味', async () => {
    const a = draftCard({ cardId: 'aaa', status: 'failed', error: '审核未通过' })
    a.spec!.prompt = '提示词甲'
    const b = draftCard({ cardId: 'bbb' })
    b.spec!.prompt = '提示词乙'
    await drop([a, b])

    const doc = decodeAttachment(0)
    const ia = doc.indexOf('## 卡片 aaa')
    const ib = doc.indexOf('## 卡片 bbb')
    expect(ia).toBeGreaterThan(-1)
    expect(ib).toBeGreaterThan(ia)
    expect(doc.slice(ia, ib)).toContain('提示词甲')
    expect(doc.slice(ia, ib)).toContain('审核未通过')
    expect(doc.slice(ia, ib)).not.toContain('提示词乙')
    expect(doc.slice(ib)).toContain('提示词乙')
    expect(doc).toContain('### 提示词')
    expect(doc).not.toMatch(/^## 提示词$/m)
  })
})

describe('附件名额(MAX_ATTACHMENTS = 20):清单永远占得到位置', () => {
  it('9 张完成卡:1 份合并清单 + 9 个 mp4 = 10,不报跳过', async () => {
    await drop(doneCards(9, false))
    expect(useAgentChatStore.getState().attachments).toHaveLength(10)
    expect(names()[0]).toBe('workbench-cards-9.md')
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('10 张完成卡各带视频:旧版每卡一份清单会正好占满 20,现在 11 个就够', async () => {
    await drop(doneCards(10, false))
    expect(useAgentChatStore.getState().attachments).toHaveLength(11)
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('25 张卡且都有云端地址:清单 + 19 个 mp4 占满,余下 6 张退成输入框里的 URL,不丢', async () => {
    await drop(doneCards(25, true))

    const list = names()
    expect(list).toHaveLength(20)
    expect(list[0]).toBe('workbench-cards-25.md')
    const input = useAgentChatStore.getState().input
    // 第 19..24 张(下标)没挂上视频,退成云端 URL
    for (let i = 19; i < 25; i += 1) expect(input).toContain(`https://cos.example.com/${i}.mp4`)
    for (let i = 0; i < 19; i += 1) expect(input).not.toContain(`https://cos.example.com/${i}.mp4`)
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })

  it('25 张卡只有本地 mp4:清单仍在,放不下的 6 个如实报在「已跳过」里', async () => {
    await drop(doneCards(25, false))

    expect(names()[0]).toBe('workbench-cards-25.md')
    expect(useAgentChatStore.getState().attachments).toHaveLength(20)
    expect(useAgentChatStore.getState().error).toContain('已跳过 6 个')
    expect(useAgentChatStore.getState().error).toContain('24.mp4')
  })

  it('附件栏本来就满了:清单挂不上也如实报,产物照常走 URL 兜底', async () => {
    useAgentChatStore.setState({
      attachments: Array.from({ length: 20 }, (_, i) => ({
        name: `old-${i}.txt`,
        mime: 'text/plain',
        size: 1,
        buffer: new ArrayBuffer(1),
      })),
    } as never)

    await drop([draftCard({ status: 'succeeded', remoteUrl: 'https://cos.example.com/a.mp4' })])

    expect(useAgentChatStore.getState().attachments).toHaveLength(20)
    expect(useAgentChatStore.getState().error).toContain('workbench-card-card-012.md')
    expect(useAgentChatStore.getState().input).toContain('https://cos.example.com/a.mp4')
  })
})
