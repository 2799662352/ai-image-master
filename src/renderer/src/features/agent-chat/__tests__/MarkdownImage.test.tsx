/**
 * 助手正文里的 `![alt](src)`:点击放大(进灯箱)、悬停复制 / 下载、本地盘符路径能显示。
 *
 * 回归:MarkdownContent 原先没有覆写 `img`,react-markdown 吐裸 `<img>` ——
 * 点击什么都不发生;`Q:\…` 被编码成 `Q:%5C…` 当相对 URL 加载成裂图;`data:` 被清洗器抹成空。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from '../MarkdownContent'
import { markdownImageUri } from '../MarkdownImage'
import { useAgentChatStore } from '../store'

// 受控的「读盘结果」:identity = 原样返回(模拟 https / 已解析),'blob' = 本地图换成 blob:,null = 还没读到。
const resolver = vi.hoisted(() => ({
  mode: 'blob' as 'identity' | 'blob' | 'null',
  lastOpts: undefined as unknown,
  /** 每次渲染传给读盘 hook 的 src(空串 = 没开始读)。 */
  seen: [] as string[],
}))
vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string, _hint?: unknown, opts?: unknown) => {
      resolver.lastOpts = opts
      resolver.seen.push(src)
      if (typeof src !== 'string' || src.length === 0) return null
      if (resolver.mode === 'null') return null
      if (resolver.mode === 'identity' || !src.startsWith('local-file://')) return src
      return `blob:resolved/${encodeURIComponent(src)}`
    },
  }
})

const copyImage = vi.fn(async (_uri: string) => ({ success: true }) as { success: boolean; error?: string })
const saveAs = vi.fn(async (_uri: string, _name: string) => ({ success: true }) as { success: boolean; canceled?: boolean; error?: string })
const openPreview = vi.fn()

beforeEach(() => {
  resolver.mode = 'blob'
  resolver.seen = []
  copyImage.mockClear()
  saveAs.mockClear()
  openPreview.mockClear()
  Object.defineProperty(window, 'electronAPI', { value: { shell: { copyImage, saveAs } }, configurable: true })
  useAgentChatStore.setState({ openPreview } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const LOCAL = '![分类总览缩略图](Q:\\10自制\\总览\\sheet.jpg)'
const LOCAL_URI = 'local-file:///Q:/10自制/总览/sheet.jpg'

describe('markdownImageUri', () => {
  it.each([
    ['https 原样', 'https://cdn.example.com/a/sheet.jpg', null, 'https://cdn.example.com/a/sheet.jpg'],
    ['data 原样', 'data:image/png;base64,AAAA', null, 'data:image/png;base64,AAAA'],
    ['盘符反斜杠(react-markdown 已编码成 %5C)', 'Q:%5C10%E8%87%AA%E5%88%B6%5Csheet.jpg', null, 'local-file:///Q:/10自制/sheet.jpg'],
    ['盘符正斜杠', 'Q:/10%E8%87%AA%E5%88%B6/sheet.jpg', null, 'local-file:///Q:/10自制/sheet.jpg'],
    ['file:///', 'file:///Q:/10%E8%87%AA%E5%88%B6/sheet.jpg', null, 'local-file:///Q:/10自制/sheet.jpg'],
    ['相对路径按工作区解析', 'out/sheet.jpg', 'D:/proj', 'local-file:///D:/proj/out/sheet.jpg'],
  ])('%s', (_name, src, root, expected) => {
    expect(markdownImageUri(src, root)).toBe(expected)
  })

  it('空地址 → 空串', () => {
    expect(markdownImageUri('', null)).toBe('')
  })
})

describe('MarkdownContent · 正文图片', () => {
  it('https 图:点击进灯箱,带上原始地址 / 文件名 / mime', () => {
    render(<MarkdownContent source={'![总览](https://cdn.example.com/a/sheet.jpg)'} />)
    fireEvent.click(screen.getByRole('button', { name: '放大 sheet.jpg' }))
    expect(openPreview).toHaveBeenCalledTimes(1)
    const [refs, index] = openPreview.mock.calls[0] as [Array<Record<string, unknown>>, number]
    expect(index).toBe(0)
    expect(refs[0]).toMatchObject({
      kind: 'image',
      name: 'sheet.jpg',
      mime: 'image/jpeg',
      uri: 'https://cdn.example.com/a/sheet.jpg',
    })
  })

  it('地址里被百分号编码的中文文件名,按钮和另存为默认名用解码后的', async () => {
    render(<MarkdownContent source={'![x](https://cdn.example.com/a/%E6%80%BB%E8%A7%88.jpg)'} />)
    expect(screen.getByRole('button', { name: '放大 总览.jpg' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下载 总览.jpg' }))
    await waitFor(() => expect(saveAs).toHaveBeenCalledWith('https://cdn.example.com/a/%E6%80%BB%E8%A7%88.jpg', '总览.jpg'))
  })

  it('本地盘符路径(含中文、反斜杠):显示的是解析后的 blob:,灯箱拿到的是原始 local-file 地址', () => {
    render(<MarkdownContent source={LOCAL} />)
    const img = screen.getByRole('img', { name: '分类总览缩略图' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe(`blob:resolved/${encodeURIComponent(LOCAL_URI)}`)

    fireEvent.click(screen.getByRole('button', { name: '放大 sheet.jpg' }))
    expect((openPreview.mock.calls[0][0] as Array<{ uri: string }>)[0].uri).toBe(LOCAL_URI)
  })

  it('行内按原图显示(fullFidelity),不是 256px 缩略小图;且与灯箱共用同一份缓存', () => {
    render(<MarkdownContent source={LOCAL} />)
    expect(resolver.lastOpts).toMatchObject({ fullFidelity: true })
  })

  it('data:image 内联图能显示(默认清洗器会把 data: 抹空)', () => {
    resolver.mode = 'identity'
    render(<MarkdownContent source={'![点](data:image/png;base64,iVBORw0KGgo=)'} />)
    const img = screen.getByRole('img', { name: '点' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('svg 的 data: 仍然不放行', () => {
    render(<MarkdownContent source={'![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)'} />)
    expect(screen.queryByRole('button', { name: /放大/ })).toBeNull()
    expect(screen.getByText('(图片无法加载)')).toBeTruthy()
  })

  it('还没读到字节时是占位,不是裂图;超时后换成明确的「无法加载」', () => {
    vi.useFakeTimers()
    resolver.mode = 'null'
    render(<MarkdownContent source={LOCAL} />)
    expect(screen.getByRole('img', { name: '分类总览缩略图(加载中)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /放大/ })).toBeNull()

    act(() => {
      vi.advanceTimersByTime(8001)
    })
    expect(screen.getByText('(图片无法加载)')).toBeTruthy()
  })

  it('<img> 加载失败 → 「无法加载」占位', () => {
    render(<MarkdownContent source={'![坏图](https://cdn.example.com/404.png)'} />)
    fireEvent.error(screen.getByRole('img', { name: '坏图' }))
    expect(screen.getByText('(图片无法加载)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /放大/ })).toBeNull()
  })

  it('复制:传的是原始地址(不是显示用的 blob:),不触发放大', async () => {
    render(<MarkdownContent source={LOCAL} />)
    fireEvent.click(screen.getByRole('button', { name: '复制 sheet.jpg' }))
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith(LOCAL_URI))
    await waitFor(() => expect(screen.getByRole('button', { name: '复制 sheet.jpg' }).getAttribute('title')).toBe('已复制'))
    expect(openPreview).not.toHaveBeenCalled()
  })

  it('复制失败:按钮上能看到原因(不是静默)', async () => {
    copyImage.mockResolvedValueOnce({ success: false, error: 'unable to load image' })
    render(<MarkdownContent source={LOCAL} />)
    fireEvent.click(screen.getByRole('button', { name: '复制 sheet.jpg' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '复制 sheet.jpg' }).getAttribute('title')).toBe('复制失败:unable to load image'),
    )
  })

  it('下载:原始地址 + 文件名交给 shell.saveAs;用户取消不算失败', async () => {
    saveAs.mockResolvedValueOnce({ success: true, canceled: true })
    render(<MarkdownContent source={LOCAL} />)
    fireEvent.click(screen.getByRole('button', { name: '下载 sheet.jpg' }))
    await waitFor(() => expect(saveAs).toHaveBeenCalledWith(LOCAL_URI, 'sheet.jpg'))
    expect(screen.getByRole('button', { name: '下载 sheet.jpg' }).getAttribute('title')).toBe('另存为…')
    expect(openPreview).not.toHaveBeenCalled()
  })

  it('没有 IPC(纯网页环境)时复制也给出原因而不是抛错', async () => {
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
    render(<MarkdownContent source={LOCAL} />)
    fireEvent.click(screen.getByRole('button', { name: '复制 sheet.jpg' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '复制 sheet.jpg' }).getAttribute('title')).toBe('复制失败:当前环境不支持复制图片'),
    )
  })
})

/**
 * 靠近可视区才读盘。
 * 一次对话里可能有几十张 1 MB 多的正文大图;挂载就全读,第一张出来的时间会随张数线性变慢
 * (真窗口量测 40 张 ≈ 1.5–2.4 s,120 张 ≈ 8.2 s)。
 */
describe('MarkdownContent · 正文图片只在靠近可视区时读盘', () => {
  class FakeIO {
    static instances: FakeIO[] = []
    targets: Element[] = []
    disconnected = false
    constructor(
      readonly cb: IntersectionObserverCallback,
      readonly opts: IntersectionObserverInit | undefined,
    ) {
      FakeIO.instances.push(this)
    }
    observe(el: Element): void {
      this.targets.push(el)
    }
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
    disconnect(): void {
      this.disconnected = true
    }
    fire(isIntersecting: boolean): void {
      act(() => {
        this.cb([{ isIntersecting, target: this.targets[0] } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      })
    }
  }

  beforeEach(() => {
    FakeIO.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIO)
  })

  const readStarted = (): boolean => resolver.seen.some((s) => s !== '')

  it('还在可视区之外:不读盘,只有骨架,没有可点的缩略图', () => {
    render(<MarkdownContent source={LOCAL} />)
    expect(readStarted()).toBe(false)
    expect(screen.getByRole('img', { name: '分类总览缩略图(加载中)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /放大/ })).toBeNull()
  })

  it('进入范围后才开始读盘,出图后可点击放大;观察器随即释放', () => {
    render(<MarkdownContent source={LOCAL} />)
    expect(FakeIO.instances).toHaveLength(1)
    FakeIO.instances[0].fire(true)
    expect(resolver.seen).toContain(LOCAL_URI)
    expect(screen.getByRole('button', { name: '放大 sheet.jpg' })).toBeTruthy()
    expect(FakeIO.instances[0].disconnected).toBe(true)
  })

  it('「不相交」的通知不触发读盘', () => {
    render(<MarkdownContent source={LOCAL} />)
    FakeIO.instances[0].fire(false)
    expect(readStarted()).toBe(false)
    expect(FakeIO.instances[0].disconnected).toBe(false)
  })

  it('没开始读之前不计 8 秒超时(滚动前的图不能被误报成「无法加载」);开始读后才计', () => {
    vi.useFakeTimers()
    resolver.mode = 'null'
    render(<MarkdownContent source={LOCAL} />)
    act(() => {
      vi.advanceTimersByTime(30000)
    })
    expect(screen.queryByText('(图片无法加载)')).toBeNull()

    FakeIO.instances[0].fire(true)
    act(() => {
      vi.advanceTimersByTime(8001)
    })
    expect(screen.getByText('(图片无法加载)')).toBeTruthy()
  })

  it('观察的是最近的滚动容器,并提前一段距离开始读(root=null 时 rootMargin 对嵌套滚动区无效)', () => {
    render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <MarkdownContent source={LOCAL} />
      </div>,
    )
    const io = FakeIO.instances[0]
    expect(io.opts?.root).toBe(screen.getByTestId('scroller'))
    expect(io.opts?.rootMargin).toBe('800px 0px')
  })

  it('远程图也一样不抢跑(https 也走同一个门)', () => {
    render(<MarkdownContent source={'![总览](https://cdn.example.com/a/sheet.jpg)'} />)
    expect(readStarted()).toBe(false)
    FakeIO.instances[0].fire(true)
    expect(resolver.seen).toContain('https://cdn.example.com/a/sheet.jpg')
  })
})
