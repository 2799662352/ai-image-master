// 锁住「父层已解析就不再自己走一趟 IPC」这条:工作台卡片必须在卡片层解析一遍
// (提示词 chip 是 HTML 字符串渲染,跑不了 hook),缩略图再解析一遍就是每张图
// 两趟 IPC、两个 blob —— 200 张满素材的看板峰值 3600 个。
//
// 这里直接数 IPC 调用次数,而不是数渲染 —— 省下来的是 IPC 和 blob,断言就该盯它。

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { MaterialStack } from '../MaterialStack'
import { MaterialThumb } from '../MaterialThumb'

/** 本地路径素材才会走 IPC(data:/https 直通)。 */
const LOCAL: VideoWorkbenchMaterial[] = [
  { name: 'a.png', src: 'local-file:///D:/shots/a.png' },
  { name: 'b.png', src: 'local-file:///D:/shots/b.png' },
]

let readThumb: ReturnType<typeof vi.fn>

beforeEach(() => {
  readThumb = vi.fn(async () => ({ ok: true as const, base64: 'AAA', mime: 'image/png' }))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readThumb, readMediaThumb: readThumb },
  }
  // jsdom 没有 createObjectURL
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:stub') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('MaterialThumb 的父层解析入口', () => {
  it('不给 resolvedSrc 时自己解析(独立使用的默认行为)', async () => {
    render(<MaterialThumb kind="image" material={LOCAL[0]} fallback={<span>占位</span>} />)
    await waitFor(() => expect(readThumb).toHaveBeenCalled())
  })

  it('给了 resolvedSrc 就直接用,一次 IPC 都不发', async () => {
    render(
      <MaterialThumb
        kind="image"
        material={LOCAL[0]}
        fallback={<span>占位</span>}
        resolvedSrc="blob:from-parent"
      />,
    )
    expect(screen.getByRole('img')).toHaveProperty('src', 'blob:from-parent')
    // 给 effect 一轮机会,证明它真的没在后台补发
    await Promise.resolve()
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('resolvedSrc 为 null = 父层负责但还没好 → 出 fallback,也不自己解析', async () => {
    render(
      <MaterialThumb kind="image" material={LOCAL[0]} fallback={<span>占位</span>} resolvedSrc={null} />,
    )
    expect(screen.getByText('占位')).toBeTruthy()
    await Promise.resolve()
    expect(readThumb).not.toHaveBeenCalled()
  })
})

describe('MaterialStack 透传', () => {
  it('给了 thumbSrcs 则整堆都不解析', async () => {
    render(
      <MaterialStack
        kind="image"
        label="参考图"
        accept="image/*"
        materials={LOCAL}
        thumbSrcs={['blob:a', 'blob:b']}
        limit={9}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await Promise.resolve()
    expect(readThumb).not.toHaveBeenCalled()
    expect(screen.getAllByRole('img').map((el) => (el as HTMLImageElement).src)).toEqual([
      'blob:a',
      'blob:b',
    ])
  })

  it('thumbSrcs 里缺项按 null 传下去,不退回自己解析', async () => {
    render(
      <MaterialStack
        kind="image"
        label="参考图"
        accept="image/*"
        materials={LOCAL}
        thumbSrcs={['blob:a', undefined]}
        limit={9}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await Promise.resolve()
    expect(readThumb).not.toHaveBeenCalled()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('不给 thumbSrcs 时每张素材各自解析(其他调用方的既有行为)', async () => {
    render(
      <MaterialStack
        kind="image"
        label="参考图"
        accept="image/*"
        materials={LOCAL}
        limit={9}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await waitFor(() => expect(readThumb).toHaveBeenCalledTimes(2))
  })
})
