/**
 * 灯箱图片工具条(设计稿 D4):标注 / 评论 / 移除背景 / 擦除 / 调整尺寸。
 * 所有工具都收敛为「带标注副本附件 + 附加指令文本」进下一条消息。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { Lightbox } from '../Lightbox'

vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string) => (typeof src === 'string' && src.length > 0 ? src : null),
  }
})

// jsdom has no 2D canvas; the composition step is exercised on a real machine.
// Here it yields a small PNG blob so the attachment plumbing can be asserted.
vi.mock('../lightbox/imageTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lightbox/imageTools')>()
  return {
    ...actual,
    composeAnnotatedImage: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
    composeEraseMask: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71, 1])], { type: 'image/png' })),
  }
})

const IMAGE = {
  id: 'img_1',
  kind: 'image' as const,
  name: 'night_v2.png',
  mime: 'image/png',
  size: 1,
  uri: 'local-file:///D:/r/night_v2.png',
}

function openWith(images: unknown[]): void {
  useAgentChatStore.setState({
    preview: { open: true, index: 0, images },
    input: '',
    attachments: [],
    isOpen: false,
  } as never)
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => cleanup())

describe('Lightbox — image tools (D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the five tools for an image and none for a video', () => {
    openWith([IMAGE])
    render(<Lightbox />)
    for (const label of ['标注', '评论', '移除背景', '擦除', '调整尺寸']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    cleanup()
    openWith([{ ...IMAGE, id: 'v', kind: 'video', name: 'a.mp4', mime: 'video/mp4', uri: 'local-file:///D:/r/a.mp4' }])
    render(<Lightbox />)
    expect(screen.queryByRole('button', { name: '标注' })).toBeNull()
  })

  it('comment mode: clicking the image drops a numbered pin and a draft box; Enter commits it to the list', () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    const img = document.querySelector('img') as HTMLImageElement
    fireEvent.click(img, { clientX: 20, clientY: 20 })

    const draft = screen.getByLabelText('评论内容') as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: '这块霓虹再暗 20%' } })
    fireEvent.keyDown(draft, { key: 'Enter' })

    expect(screen.getByTestId('lightbox-pin-1')).toBeTruthy()
    expect(screen.getByText('这块霓虹再暗 20%')).toBeTruthy()
    // 未退出预览,也未切图
    expect(useAgentChatStore.getState().preview.open).toBe(true)
    expect(useAgentChatStore.getState().preview.index).toBe(0)
  })

  it('发送给 Codex attaches the annotated copy, appends the instruction block, opens the drawer and closes the lightbox', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    fireEvent.click(document.querySelector('img') as HTMLImageElement, { clientX: 20, clientY: 20 })
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '标题字体不动' } })
    fireEvent.keyDown(screen.getByLabelText('评论内容'), { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: /发送给 Codex/ }))
    await flush()

    const s = useAgentChatStore.getState()
    expect(s.attachments).toHaveLength(1)
    expect(s.attachments[0]).toMatchObject({ name: 'night_v2.标注.png', mime: 'image/png' })
    expect(s.input).toContain('[图片反馈 · night_v2.png]')
    expect(s.input).toContain('1. 标题字体不动')
    expect(s.isOpen).toBe(true)
    expect(s.preview.open).toBe(false)
  })

  it('移除背景 is a one-click action: instruction lands in the composer with the transparentBackground hint', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '移除背景' }))
    await flush()
    const s = useAgentChatStore.getState()
    expect(s.input).toContain('移除背景')
    expect(s.input).toContain('transparentBackground')
    expect(s.preview.open).toBe(false)
  })

  it('调整尺寸 offers presets; picking one sends the resize instruction', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '调整尺寸' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /16:9/ }))
    await flush()
    expect(useAgentChatStore.getState().input).toContain('调整尺寸')
    expect(useAgentChatStore.getState().input).toContain('16:9')
  })

  // P3c:擦除笔迹 → 除带标注副本外,再附一张真正的 alpha 遮罩 <name>.mask.png,
  // 指令点名它与 generate_image 的 maskImage 用法。
  it('擦除 strokes attach an alpha mask next to the annotated copy and the instruction names it', async () => {
    openWith([IMAGE])
    render(<Lightbox />)
    fireEvent.click(screen.getByRole('button', { name: '擦除' }))
    const img = document.querySelector('img') as HTMLImageElement
    fireEvent.pointerDown(img, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 30, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(img, { pointerId: 1 })

    fireEvent.click(screen.getByRole('button', { name: /发送给 Codex/ }))
    await flush()

    const s = useAgentChatStore.getState()
    expect(s.attachments.map((a) => a.name).sort()).toEqual(['night_v2.mask.png', 'night_v2.标注.png'])
    expect(s.input).toContain('night_v2.mask.png')
    expect(s.input).toContain('maskImage')
  })

  // 用户反馈:标注要能选颜色。调色板只在标注模式出现;选色只影响之后的笔迹,
  // 已画的保持原色;颜色跟着笔迹进 SVG 预览与指令文字。
  it('标注 mode shows a colour palette; the picked colour applies to the next stroke only', () => {
    openWith([IMAGE])
    render(<Lightbox />)
    expect(screen.queryByRole('radiogroup', { name: '标注颜色' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '标注' }))
    const palette = screen.getByRole('radiogroup', { name: '标注颜色' })
    expect(palette).toBeTruthy()
    // default = cyan
    expect((screen.getByRole('radio', { name: '青' }) as HTMLElement).getAttribute('aria-checked')).toBe('true')

    const img = document.querySelector('img') as HTMLImageElement
    fireEvent.pointerDown(img, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 30, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(img, { pointerId: 1 })

    fireEvent.click(screen.getByRole('radio', { name: '黄' }))
    expect((screen.getByRole('radio', { name: '黄' }) as HTMLElement).getAttribute('aria-checked')).toBe('true')
    fireEvent.pointerDown(img, { clientX: 50, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 70, clientY: 70, pointerId: 1 })
    fireEvent.pointerUp(img, { pointerId: 1 })

    const lines = Array.from(document.querySelectorAll('polyline')).map((p) => p.getAttribute('stroke'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('#22d3ee')
    expect(lines[1]?.toLowerCase()).toBe('#facc15')
    // side panel summary AND the instruction preview both speak in colours
    expect(screen.getAllByText(/青色 1/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/黄色 1/).length).toBeGreaterThanOrEqual(2)
  })

  it('send stays disabled until something is marked', () => {
    openWith([IMAGE])
    render(<Lightbox />)
    expect((screen.getByRole('button', { name: /发送给 Codex/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('image click still pages when no tool is active (existing behaviour)', () => {
    openWith([IMAGE, { ...IMAGE, id: 'img_2', name: 'b.png', uri: 'local-file:///D:/r/b.png' }])
    render(<Lightbox />)
    fireEvent.click(document.querySelector('img') as HTMLImageElement)
    expect(useAgentChatStore.getState().preview.index).toBe(1)
  })
})
