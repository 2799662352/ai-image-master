// 回合级「本轮改了哪些文件」汇总条,以及一条本该早就存在的回归测试:
// fileEdit 到底有没有渲染成卡片。
//
// 之前没有任何测试断言这件事,所以 `isEvidenceItem` 里 fileEdit 被无条件折叠成
// 灰药丸这个漂移可以一直不被发现 —— FileEditCard 和 openAiChange 变成死代码,
// 单元测试却全绿。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange, Message } from '../../../../../types/agent-timeline'
import { FileChangeSummary, collectFileChanges, mergeChangesByPath } from '../FileChangeSummary'
import { MessageBubble } from '../MessageBubble'
import { useFileExplorerStore } from '../../file-explorer/store'

afterEach(cleanup)

function change(path: string, over: Partial<FileChange> = {}): FileChange {
  return {
    path,
    operation: 'edit',
    diff: `@@\n-old\n+new`,
    added: 1,
    removed: 1,
    ...over,
  }
}

function assistantMessage(changes: FileChange[][]): Message {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: 1,
    items: changes.map((group, i) => ({
      type: 'fileEdit' as const,
      id: `edit-${i}`,
      startedAt: 1,
      endedAt: 2,
      changes: group,
      totalAdded: group.reduce((s, c) => s + c.added, 0),
      totalRemoved: group.reduce((s, c) => s + c.removed, 0),
    })),
  } as Message
}

describe('mergeChangesByPath', () => {
  it('同一文件被改多次时合并成一行,行数累加', () => {
    const merged = mergeChangesByPath([
      change('src/a.ts', { added: 3, removed: 1 }),
      change('src/a.ts', { added: 2, removed: 4 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ path: 'src/a.ts', added: 5, removed: 5 })
  })

  it('先建后改仍算新建', () => {
    const merged = mergeChangesByPath([
      change('src/a.ts', { operation: 'create' }),
      change('src/a.ts', { operation: 'edit' }),
    ])
    expect(merged[0].operation).toBe('create')
  })

  it('最后被删掉就是删除', () => {
    const merged = mergeChangesByPath([
      change('src/a.ts', { operation: 'create' }),
      change('src/a.ts', { operation: 'delete' }),
    ])
    expect(merged[0].operation).toBe('delete')
  })

  it('不同文件各占一行,顺序按首次出现', () => {
    const merged = mergeChangesByPath([change('b.ts'), change('a.ts'), change('b.ts')])
    expect(merged.map((c) => c.path)).toEqual(['b.ts', 'a.ts'])
  })
})

describe('collectFileChanges', () => {
  it('把一条消息里所有 fileEdit item 的改动收齐', () => {
    const message = assistantMessage([[change('a.ts')], [change('b.ts'), change('a.ts')]])
    expect(collectFileChanges(message).map((c) => c.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('FileChangeSummary', () => {
  it('只有一个文件时不显示 —— 上面那张卡已经说完了', () => {
    const { container } = render(<FileChangeSummary message={assistantMessage([[change('a.ts')]])} />)
    expect(container.firstChild).toBeNull()
  })

  it('多个文件时列出每一个,带 +N/-M 合计', () => {
    render(
      <FileChangeSummary
        message={assistantMessage([
          [change('src/a.ts', { added: 3, removed: 0 })],
          [change('src/b.ts', { added: 1, removed: 4 })],
        ])}
      />,
    )
    const summary = screen.getByTestId('file-change-summary')
    expect(summary.textContent).toContain('a.ts')
    expect(summary.textContent).toContain('b.ts')
    expect(summary.textContent).toContain('+4')
    expect(summary.textContent).toContain('-4')
  })

  it('文案说的是「agent 编辑了」,不承诺是全部改动', () => {
    // shell 命令改的文件不会产生 fileEdit item,所以这里给不出全集。
    // 写「本轮改动了 N 个文件」就是在承诺一个我们拿不到的数字。
    render(
      <FileChangeSummary message={assistantMessage([[change('a.ts')], [change('b.ts')]])} />,
    )
    expect(screen.getByTestId('file-change-summary').textContent).toContain('agent 编辑了 2 个文件')
  })

  it('点一行打开那个文件的并排 diff', () => {
    const spy = vi.spyOn(useFileExplorerStore.getState(), 'openAiChange').mockResolvedValue(undefined)
    render(
      <FileChangeSummary message={assistantMessage([[change('src/a.ts')], [change('src/b.ts')]])} />,
    )
    fireEvent.click(screen.getByLabelText('打开 src/b.ts 的改动对比'))
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/b.ts' }))
    spy.mockRestore()
  })
})

describe('MessageBubble · fileEdit 渲染契约', () => {
  beforeEach(() => {
    vi.spyOn(useFileExplorerStore.getState(), 'openAiChange').mockResolvedValue(undefined)
  })

  it('带改动的 fileEdit 渲染成卡片,而不是折叠成灰药丸', () => {
    render(<MessageBubble message={assistantMessage([[change('src/a.ts')]])} />)
    // 卡片会把 diff 直接摊开;药丸只会给一个 "Show"。
    expect(screen.getByLabelText('Open diff for src/a.ts')).toBeTruthy()
    expect(screen.queryByText('Show')).toBeNull()
  })

  it('多个 fileEdit item 时气泡末尾出现回合级汇总', () => {
    render(<MessageBubble message={assistantMessage([[change('a.ts')], [change('b.ts')]])} />)
    expect(screen.getByTestId('file-change-summary')).toBeTruthy()
  })
})
