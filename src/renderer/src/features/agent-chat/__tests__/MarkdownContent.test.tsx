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
