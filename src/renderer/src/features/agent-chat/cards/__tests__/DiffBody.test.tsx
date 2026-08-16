// DiffBody = diff 的「内容」层,不含 header、不含折叠。
//
// 拆出它是因为宿主分两类:FileChangeSummary / EvidenceDetails 自带 header 和
// 折叠,再套一层就是折叠套娃;而聊天里的 FileEditCard 需要 header。让内容层保持
// 无主张,两边都能用。

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffBody } from '../DiffBody'

/**
 * 按行文本精确定位一行。不用 getByText:它默认会把首尾空白规范化掉,而
 * diff 的上下文行恰恰以空格开头(' ctx'),那是有意义的首字符。
 */
function rowOf(text: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-row]'))
  const el = rows.find((row) => row.querySelector('span:last-child')?.textContent === text)
  if (!el) throw new Error(`no diff row for ${JSON.stringify(text)}`)
  return el
}

describe('DiffBody 行号栏', () => {
  const diff = ['@@ -10,3 +10,4 @@', ' ctx', '-gone', '+added', '+added2', ' tail'].join('\n')

  it('按 hunk 头起算,新增行只推进新行号、删除行只推进旧行号', () => {
    render(<DiffBody diff={diff} />)

    expect(rowOf(' ctx').dataset.oldLine).toBe('10')
    expect(rowOf(' ctx').dataset.newLine).toBe('10')

    // 删除行在「新文件」里不存在 —— 新行号必须留空,否则读的人会以为新文件里
    // 还有这一行。
    expect(rowOf('-gone').dataset.oldLine).toBe('11')
    expect(rowOf('-gone').dataset.newLine).toBe('')

    expect(rowOf('+added').dataset.oldLine).toBe('')
    expect(rowOf('+added').dataset.newLine).toBe('11')
    expect(rowOf('+added2').dataset.newLine).toBe('12')

    // 删掉 1 行、加了 2 行之后,上下文行的两侧行号会错开 —— 这正是行号栏的价值。
    expect(rowOf(' tail').dataset.oldLine).toBe('12')
    expect(rowOf(' tail').dataset.newLine).toBe('13')
  })

  it('多个 hunk 各自从自己的头重新起算', () => {
    render(
      <DiffBody
        diff={['@@ -1,1 +1,1 @@', ' a', '@@ -80,1 +90,1 @@', ' b'].join('\n')}
      />,
    )
    expect(rowOf(' a').dataset.oldLine).toBe('1')
    expect(rowOf(' b').dataset.oldLine).toBe('80')
    expect(rowOf(' b').dataset.newLine).toBe('90')
  })

  it('没有 hunk 头时不编造行号(主进程 snapshotDiff 会发无头 diff)', () => {
    // snapshotDiff.ts 刻意不带 ---/+++ 头。这种情况下起始行号无从得知,
    // 标一个假的比不标更坏。
    render(<DiffBody diff={['-old', '+new'].join('\n')} />)
    expect(rowOf('-old').dataset.oldLine).toBe('')
    expect(rowOf('+new').dataset.newLine).toBe('')
  })

  it('保留按首字符区分的三种色系', () => {
    render(<DiffBody diff={['@@ -1 +1 @@', '-old', '+new'].join('\n')} />)
    expect(rowOf('-old').className).toContain('red')
    expect(rowOf('+new').className).toContain('emerald')
    expect(rowOf('@@ -1 +1 @@').className).toContain('cyan')
  })
})

describe('DiffBody 高度约束', () => {
  it('内容区限高并可纵向滚动 —— 长 diff 不再把气泡撑成几千像素', () => {
    const { container } = render(<DiffBody diff={'+x\n'.repeat(50)} />)
    const scroller = container.querySelector('[data-diff-scroll]') as HTMLElement
    expect(scroller).toBeTruthy()
    expect(scroller.className).toMatch(/max-h-\[\d+px\]/)
    expect(scroller.className).toContain('overflow-y-auto')
  })

  it('超长 diff 仍先截断,且「显示全部」可以再收回去', () => {
    // 限高解决了视觉高度,但 5000 个 <div> 依然是真实的渲染成本 —— 截断要留。
    // 与旧实现的区别是:旧的 setShowAll(true) 没有反向操作,展开了就收不回。
    render(<DiffBody diff={Array.from({ length: 220 }, (_, i) => `+line ${i}`).join('\n')} />)

    expect(screen.queryByText('+line 219')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /全部 220 行/ }))
    expect(screen.getByText('+line 219')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /收起/ }))
    expect(screen.queryByText('+line 219')).toBeNull()
  })
})
