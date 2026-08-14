import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent, parseLanguageInfo } from '../MarkdownContent'
import { useFileExplorerStore } from '../../file-explorer/store'

afterEach(cleanup)

describe('parseLanguageInfo', () => {
  it('returns isBlock=false for inline (no language- class)', () => {
    expect(parseLanguageInfo(undefined)).toEqual({ isBlock: false })
    expect(parseLanguageInfo('something-else')).toEqual({ isBlock: false })
  })

  it('extracts language only when no path suffix', () => {
    expect(parseLanguageInfo('language-ts')).toEqual({ isBlock: true, lang: 'ts' })
  })

  it('splits language and path on first colon', () => {
    expect(parseLanguageInfo('language-ts:src/foo.ts')).toEqual({
      isBlock: true,
      lang: 'ts',
      path: 'src/foo.ts',
    })
  })

  it('keeps further colons inside the path', () => {
    expect(parseLanguageInfo('language-ts:src/a:b.ts')).toEqual({
      isBlock: true,
      lang: 'ts',
      path: 'src/a:b.ts',
    })
  })
})

describe('MarkdownContent code blocks', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    })
  })

  it('renders Copy button for any fenced code block', () => {
    render(<MarkdownContent source={'```ts\nconst x = 1\n```'} />)
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
  })

  it('shows Apply button only when info string contains a path', () => {
    render(<MarkdownContent source={'```ts:src/foo.ts\nconst x = 1\n```'} />)
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy()
    expect(screen.getByText('src/foo.ts')).toBeTruthy()
  })

  it('Copy button writes the raw content to clipboard', async () => {
    render(<MarkdownContent source={'```ts\nconst x = 1\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    await Promise.resolve()
    const writeText = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
    expect(writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('Apply button calls requestApplyExternalContent with the right path', async () => {
    const spy = vi
      .spyOn(useFileExplorerStore.getState(), 'requestApplyExternalContent')
      .mockResolvedValue({ ok: true })
    render(<MarkdownContent source={'```ts:src/foo.ts\nconst x = 1\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await Promise.resolve()
    expect(spy).toHaveBeenCalledWith('src/foo.ts', 'const x = 1')
    spy.mockRestore()
  })

  it('renders inline code without copy chrome', () => {
    const { container } = render(<MarkdownContent source={'use `foo` here'} />)
    expect(container.querySelector('code')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })
})

describe('MarkdownContent links', () => {
  it('renders links as non-draggable so the blue text stays selectable/copyable', () => {
    // Regression: anchors are draggable by default in Chromium/Electron, which
    // hijacks drag-to-select (no copy) and swallows clicks-with-movement (no
    // jump). The anchor must opt out of native drag.
    const { container } = render(
      <MarkdownContent source={'[镜头摆设](file:///C:/u/uploads/x.png)'} />,
    )
    const a = container.querySelector('a') as HTMLAnchorElement
    expect(a).toBeTruthy()
    expect(a.getAttribute('draggable')).toBe('false')
  })

  it('clicking a local-file link reveals it in the FILES panel instead of navigating', () => {
    const spy = vi
      .spyOn(useFileExplorerStore.getState(), 'revealPath')
      .mockResolvedValue(undefined)
    const { container } = render(
      <MarkdownContent source={'[镜头摆设](file:///C:/u/uploads/x.png)'} />,
    )
    const a = container.querySelector('a') as HTMLAnchorElement
    fireEvent.click(a)
    expect(spy).toHaveBeenCalledWith('C:/u/uploads/x.png', undefined)
    spy.mockRestore()
  })
})

/**
 * 回归:Codex 的 `file_opener` 默认是 `vscode`,所以模型引用文件时到手的 href
 * 是 `vscode://file/...:42`。react-markdown 的默认清洗器会把这种 scheme 抹成空
 * href —— 链接照样蓝、照样有下划线,点下去什么都不发生(打包版里主进程还会把
 * 它 deny 掉,连报错都没有)。
 */
describe('MarkdownContent · Codex 文件引用', () => {
  const ROOT = 'D:\\proj'

  beforeEach(() => {
    useFileExplorerStore.setState({ workspaceRoot: ROOT })
  })

  function clickFirstLink(source: string) {
    const spy = vi
      .spyOn(useFileExplorerStore.getState(), 'revealPath')
      .mockResolvedValue(undefined)
    const { container } = render(<MarkdownContent source={source} />)
    const a = container.querySelector('a')
    if (a) fireEvent.click(a)
    return { spy, a, container }
  }

  it('vscode://file 引用会揭示文件并跳到被引用的行', () => {
    const { spy, a } = clickFirstLink('见 [src/a.ts:42](vscode://file/D:/proj/src/a.ts:42)')
    expect(a).toBeTruthy()
    expect(spy).toHaveBeenCalledWith('D:/proj/src/a.ts', { line: 42, col: undefined })
    spy.mockRestore()
  })

  it('列号一并带过去', () => {
    const { spy } = clickFirstLink('[a](cursor://file/D:/proj/src/a.ts:42:7)')
    expect(spy).toHaveBeenCalledWith('D:/proj/src/a.ts', { line: 42, col: 7 })
    spy.mockRestore()
  })

  it('工作区相对路径以工作区根解析', () => {
    const { spy } = clickFirstLink('改了 [src/a.ts](src/a.ts)')
    expect(spy).toHaveBeenCalledWith('D:\\proj\\src\\a.ts', undefined)
    spy.mockRestore()
  })

  it('GitHub 式 #L 锚点也算行号', () => {
    const { spy } = clickFirstLink('[a](src/a.ts#L12)')
    expect(spy).toHaveBeenCalledWith('D:\\proj\\src\\a.ts', { line: 12, col: undefined })
    spy.mockRestore()
  })

  it('解析不出来的目标渲染成纯文本,不留一个点不动的蓝链接', () => {
    useFileExplorerStore.setState({ workspaceRoot: null })
    const { container } = render(<MarkdownContent source={'[看这里](src/a.ts)'} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('看这里')
  })

  it('真外链仍然是链接,交给默认行为', () => {
    const { container } = render(<MarkdownContent source={'[PR](https://github.com/o/r/pull/1)'} />)
    const a = container.querySelector('a') as HTMLAnchorElement
    expect(a).toBeTruthy()
    expect(a.getAttribute('href')).toBe('https://github.com/o/r/pull/1')
  })
})
