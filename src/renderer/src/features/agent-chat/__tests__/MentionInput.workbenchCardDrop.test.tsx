// 工作台卡片拖进聊天栏。这条分支此前一条测试都没有 —— 既没钉住「已出片能成」,
// 也没钉住「未出片只弹提示」,所以两处行为改动都无处落脚。
//
// 这次改的是后者:未出片不再只弹一句提示,而是把这张卡的规格说明合成一份 Markdown
// 附件递过去;同时修掉一个误判 —— 只看 localPath 会把「本地 mp4 被 7 天清理扫走、
// COS 上还在」的卡说成「还没有生成结果」,而播放器那边照样放得出来。

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

describe('已出片的卡:本地 mp4 仍然走附件 + 引用(回归守卫)', () => {
  it('按路径附件,并留下一条引用', async () => {
    await drop([draftCard({ status: 'succeeded', localPath: 'C:/u/agent/uploads/a.mp4' })])

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ name: 'a.mp4', mime: 'video/mp4', path: 'C:/u/agent/uploads/a.mp4' })
    expect(attachments[0].buffer).toBeUndefined()
    // 卡片产物躺在 uploads 里,主进程 mapReferencesToInputItems 的白名单认这个目录,
    // 所以这一路可以放心双写(外部 OS 拖放刻意不写引用,原因见 externalDrop 那份测试)。
    expect(useAgentChatStore.getState().pendingReferences).toHaveLength(1)
  })
})

describe('本地被 7 天清理扫掉、云端还在:不再误报「还没有生成结果」', () => {
  it('remoteUrl 进输入框,不合成规格说明', async () => {
    const url = 'https://bucket.cos.ap-guangzhou.myqcloud.com/videos/a.mp4'
    await drop([draftCard({ status: 'succeeded', remoteUrl: url })])

    expect(useAgentChatStore.getState().input).toContain(url)
    // 这张卡是有产物的,合成一份「还没有产物」的说明就是在撒谎。
    expect(useAgentChatStore.getState().attachments).toEqual([])
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

    expect(useAgentChatStore.getState().attachments[0].path).toBe('C:/u/agent/uploads/a.mp4')
    expect(useAgentChatStore.getState().input).toBe('')
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

describe('混着拖', () => {
  it('出片的走 mp4、没出片的走说明,一张都不落下', async () => {
    await drop([
      draftCard({ cardId: 'done', status: 'succeeded', localPath: 'C:/u/agent/uploads/a.mp4' }),
      draftCard({ cardId: 'draft-1' }),
    ])

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments.map((a) => a.name)).toEqual(['a.mp4', 'workbench-card-draft-1.md'])
    expect(useAgentChatStore.getState().error).toBeUndefined()
  })
})
