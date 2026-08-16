// FileDiffBlock = 折叠 header + DiffBody。
//
// 改造前它是「永远摊开的一面墙」:200 行上限、无限高、Show all 单向不可逆。
// 一个 200 行的 diff 就是约 3500px,把整个聊天气泡顶开。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../../../../../types/agent-timeline'
import { FileDiffBlock } from '../FileDiffBlock'

function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: 'docs/a.md',
    operation: 'edit',
    diff: '@@ -1 +1 @@\n-old\n+new\n context',
    added: 1,
    removed: 1,
    ...overrides,
  }
}

// vitest.config.ts 里 globals: false,RTL 的自动 cleanup 不会注册 ——
// 不手动清,DOM 会跨用例累积,按角色/名字查询就会命中上一个用例的残留。
afterEach(cleanup)

describe('FileDiffBlock 折叠', () => {
  it('默认收起 —— 只出 header,不渲染任何 diff 行', () => {
    render(<FileDiffBlock change={change()} />)

    expect(screen.getByText('docs/a.md')).toBeTruthy()
    expect(screen.queryByText('-old')).toBeNull()
  })

  it('收起状态下 header 就报出改动量,不展开也知道规模', () => {
    render(<FileDiffBlock change={change({ added: 12, removed: 3 })} />)

    expect(screen.getByText('+12')).toBeTruthy()
    expect(screen.getByText('−3')).toBeTruthy()
  })

  it('可以反复收放(旧实现展开后收不回来)', () => {
    render(<FileDiffBlock change={change()} />)

    const toggle = screen.getByRole('button', { name: /展开 docs\/a\.md/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('-old')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /收起 docs\/a\.md/ }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('-old')).toBeNull()
  })

  it('defaultExpanded 让宿主决定初始状态(流式期间要摊开看进度)', () => {
    render(<FileDiffBlock change={change()} defaultExpanded />)
    expect(screen.getByText('-old')).toBeTruthy()
  })

  it('「打开」是独立按钮,不会被折叠切换吞掉', () => {
    // 按钮不能嵌套,所以折叠按钮和「打开并排对比」必须是兄弟节点 ——
    // FileChangeSummary 里已经这么做了,这里保持一致。
    const onOpen = vi.fn()
    render(<FileDiffBlock change={change()} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /open diff for docs\/a\.md/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    // 点「打开」不应该顺带把卡片展开
    expect(screen.queryByText('-old')).toBeNull()
  })

  it('没给 onOpen 时不渲染「打开」按钮', () => {
    render(<FileDiffBlock change={change()} />)
    expect(screen.queryByRole('button', { name: /open diff for/i })).toBeNull()
  })

  it('保留操作徽章 —— 「删掉一个文件」和「改了几行」不能都是一片红', () => {
    render(<FileDiffBlock change={change({ operation: 'delete' })} />)
    expect(screen.getByText('删除')).toBeTruthy()
  })
})
