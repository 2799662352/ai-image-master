import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownDraftCard } from '../MarkdownDraftCard'

describe('MarkdownDraftCard', () => {
  it('renders created markdown and opens the file when clicked', () => {
    const onOpen = vi.fn()
    render(
      <MarkdownDraftCard
        path="docs/a.md"
        content="# Title\n\nBody"
        status="created"
        onOpen={onOpen}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /open docs\/a.md/i }))
    expect(onOpen).toHaveBeenCalledWith('docs/a.md')
  })

  it('does not open failed drafts', () => {
    const onOpen = vi.fn()
    render(
      <MarkdownDraftCard
        path="docs/a.md"
        content="# Title"
        status="failed"
        error="write failed"
        onOpen={onOpen}
      />,
    )

    fireEvent.click(screen.getByText(/write failed/i))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders large markdown immediately', () => {
    const content = `# Title\n\n${'x'.repeat(21 * 1024)}`
    render(<MarkdownDraftCard path="docs/big.md" content={content} status="created" onOpen={vi.fn()} />)

    expect(screen.getByText(/x{20}/)).toBeTruthy()
  })

  it('renders streaming content immediately without throttling', () => {
    const content = 'word '.repeat(2000)
    const { container } = render(
      <MarkdownDraftCard path="docs/stream.md" content={content} status="streaming" onOpen={vi.fn()} />,
    )

    expect(container.textContent ?? '').toContain(content.trim())
  })

  it('does not reset visible content when re-rendered with longer content', () => {
    const { rerender, container } = render(
      <MarkdownDraftCard path="docs/stream.md" content="abc" status="streaming" onOpen={vi.fn()} />,
    )
    expect(container.textContent).toContain('abc')

    rerender(
      <MarkdownDraftCard
        path="docs/stream.md"
        content="abc def ghi"
        status="streaming"
        onOpen={vi.fn()}
      />,
    )

    expect(container.textContent).toContain('abc def ghi')
  })
})
