import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEditItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { FileEditCard } from '../FileEditCard'

function item(overrides: Partial<FileEditItem> = {}): FileEditItem {
  return {
    type: 'fileEdit',
    id: 'edit-1',
    startedAt: 1,
    changes: [
      { path: 'src/a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-old\n+new', added: 1, removed: 1 },
    ],
    totalAdded: 1,
    totalRemoved: 1,
    ...overrides,
  }
}

afterEach(cleanup)

/**
 * 「改动进行中自动摊开、写完自动收起」。
 *
 * 默认收起是给**读历史**的人省地方的;正在写的那一刻恰恰相反 —— 那是唯一
 * 值得盯着看的东西,却要用户手动点开才看得见,等他点开时往往已经写完了。
 */
describe('FileEditCard 流式展开', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ openAiChange: vi.fn(), openTab: vi.fn() } as never)
  })

  it('endedAt 未落地时自动展开', () => {
    render(<FileEditCard item={item()} />)

    expect(screen.getByText('-old')).toBeTruthy()
  })

  it('endedAt 落地后自动收回去', () => {
    const { rerender } = render(<FileEditCard item={item()} />)
    expect(screen.getByText('-old')).toBeTruthy()

    rerender(<FileEditCard item={item({ endedAt: 2 })} />)

    expect(screen.queryByText('-old')).toBeNull()
  })

  it('多文件流式时每一行都摊开', () => {
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

    expect(screen.getByText('-a')).toBeTruthy()
    expect(screen.getByText('-c')).toBeTruthy()
  })
})
