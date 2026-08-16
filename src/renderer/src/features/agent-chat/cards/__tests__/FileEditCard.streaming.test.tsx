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

  /**
   * 上游 PR #18289 的 P2 评审意见:`PatchApplyUpdated` 的 changes 用的是**未经
   * cwd 解析的原始 hunk 路径**,而 begin/end(item/completed)用的是解析后的
   * 路径 —— 同一个文件在生命周期中途会从相对变绝对。
   *
   * 按 path 做 key 的话 React 会把它当成另一个文件:整行卸载重建,用户手动展
   * 开的状态和滚动位置全丢。流式之前不会踩到,因为卡片只在 completed 时渲染
   * 一次、路径不会变。
   */
  /**
   * item/started 的 changes 按 README 说法是「diff chunk **summaries**」——
   * 有可能只有 path 和 kind、没有 diff 正文。这时自动展开会给每个文件摊开一个
   * 空的 DiffBody,上面写着 +0 −0,整个编辑过程都挂在那儿,比改造前的收起态
   * 还难看。没内容就别展开。
   */
  it('改动还没有 diff 正文时不自动展开,不摊开一个空框', () => {
    render(
      <FileEditCard
        item={item({
          changes: [{ path: 'src/a.ts', operation: 'edit', diff: '', added: 0, removed: 0 }],
        })}
      />,
    )

    expect(document.querySelector('[data-diff-scroll]')).toBeNull()
    // 折叠头本身还在,用户仍然看得到「正在改哪个文件」。
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('路径从相对变绝对时不重建行,用户手动收起的状态保留', () => {
    const { rerender } = render(
      <FileEditCard
        item={item({
          changes: [{ path: 'src/a.ts', operation: 'edit', diff: '-old\n+new', added: 1, removed: 1 }],
        })}
      />,
    )

    // 流式中默认摊开,用户嫌吵手动收起了这一行。
    fireEvent.click(screen.getByRole('button', { name: /收起 .*a\.ts/ }))
    expect(screen.queryByText('-old')).toBeNull()

    // 下一段增量把路径解析成了绝对路径。行被重建的话内部 expanded 会重置回
    // defaultExpanded(流式中=true),这一行会违背用户意愿自己弹开。
    rerender(
      <FileEditCard
        item={item({
          changes: [
            { path: 'D:/repo/src/a.ts', operation: 'edit', diff: '-old\n+new', added: 1, removed: 1 },
          ],
        })}
      />,
    )

    expect(screen.queryByText('-old')).toBeNull()
  })
})
