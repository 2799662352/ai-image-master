import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEditItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { FileEditCard } from '../FileEditCard'

function item(overrides: Partial<FileEditItem> = {}): FileEditItem {
  return {
    type: 'fileEdit',
    id: 'edit-1',
    startedAt: 1,
    endedAt: 2,
    changes: [
      {
        path: 'docs/a.md',
        operation: 'create',
        diff: ['--- /dev/null', '+++ b/docs/a.md', '@@ -0,0 +1 @@', '+# Title'].join('\n'),
        added: 1,
        removed: 0,
      },
    ],
    totalAdded: 1,
    totalRemoved: 0,
    ...overrides,
  }
}

// globals: false ⇒ RTL 不会自动 cleanup,DOM 会跨用例累积。
afterEach(cleanup)

describe('FileEditCard', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({
      openAiChange: vi.fn(),
      openTab: vi.fn(),
    } as never)
  })

  it('renders markdown create as a draft card and opens the created file', () => {
    const openTab = vi.fn()
    useFileExplorerStore.setState({ openTab } as never)

    render(<FileEditCard item={item()} />)

    fireEvent.click(screen.getByRole('button', { name: /open docs\/a.md/i }))
    expect(openTab).toHaveBeenCalledWith('docs/a.md', 'workspace')
  })

  it('opens AI change detail for non-markdown edits', () => {
    const openAiChange = vi.fn()
    useFileExplorerStore.setState({ openAiChange } as never)

    const change = {
      path: 'src/a.ts',
      operation: 'edit' as const,
      diff: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      added: 1,
      removed: 1,
    }

    render(<FileEditCard item={item({ changes: [change], totalAdded: 1, totalRemoved: 1 })} />)

    fireEvent.click(screen.getByRole('button', { name: /open diff for src\/a.ts/i }))
    expect(openAiChange).toHaveBeenCalledWith(change)
  })

  it('uses a compact file list for multi-file changes', () => {
    render(
      <FileEditCard
        item={item({
          changes: [
            { path: 'a.ts', operation: 'edit', diff: '-a\n+b', added: 1, removed: 1 },
            { path: 'b.ts', operation: 'edit', diff: '-c\n+d', added: 1, removed: 1 },
          ],
          totalAdded: 2,
          totalRemoved: 2,
        })}
      />,
    )

    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.queryByText('-a')).toBeNull()
  })

  // 改造前:改 1 个文件是一面 3500px 的墙,改 2 个以上反而一条 diff 都看不到,
  // 只能跳去右侧并排视图。两种数量走两套完全不同的 UI,是这张卡最刺眼的地方。
  it('单文件与多文件同构 —— 都是可展开的行,不再是「一面墙 vs 什么都没有」', () => {
    render(
      <FileEditCard
        item={item({
          changes: [
            { path: 'a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1 },
            { path: 'b.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-c\n+d', added: 1, removed: 1 },
          ],
          totalAdded: 2,
          totalRemoved: 2,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /展开 a\.ts/ }))
    expect(screen.getByText('-a')).toBeTruthy()
    // 展开一个不该带出另一个
    expect(screen.queryByText('-c')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /展开 b\.ts/ }))
    expect(screen.getByText('-c')).toBeTruthy()
    expect(screen.getByText('-a')).toBeTruthy()
  })

  it('单文件同样默认收起', () => {
    render(
      <FileEditCard
        item={item({
          changes: [
            { path: 'src/a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-old\n+new', added: 1, removed: 1 },
          ],
          totalAdded: 1,
          totalRemoved: 1,
        })}
      />,
    )
    expect(screen.queryByText('-old')).toBeNull()
  })

  it('每一行都留着「打开并排对比」的入口', () => {
    const openAiChange = vi.fn()
    useFileExplorerStore.setState({ openAiChange } as never)
    const changes = [
      { path: 'a.ts', operation: 'edit' as const, diff: '-a\n+b', added: 1, removed: 1 },
      { path: 'b.ts', operation: 'edit' as const, diff: '-c\n+d', added: 1, removed: 1 },
    ]

    render(<FileEditCard item={item({ changes, totalAdded: 2, totalRemoved: 2 })} />)

    fireEvent.click(screen.getByRole('button', { name: /open diff for b\.ts/i }))
    expect(openAiChange).toHaveBeenCalledWith(changes[1])
  })
})
