import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileChange } from '../../../../../../types/agent-timeline'
import { FileDiffBlock } from '../FileDiffBlock'

const change: FileChange = {
  path: 'src/a.ts',
  operation: 'edit',
  diff: '@@ -1 +1 @@\n-old\n+new',
  added: 1,
  removed: 1,
}

afterEach(cleanup)

/**
 * `defaultExpanded` 原本只在挂载时读一次。流式卡靠它做「写的时候展开、写完
 * 收起」,如果它变了组件不跟,那收起那一下就永远不会发生。
 */
describe('FileDiffBlock 跟随 defaultExpanded 变化', () => {
  it('defaultExpanded 由 true 变 false 时收起', () => {
    const { rerender } = render(<FileDiffBlock change={change} defaultExpanded />)
    expect(screen.getByText('-old')).toBeTruthy()

    rerender(<FileDiffBlock change={change} defaultExpanded={false} />)

    expect(screen.queryByText('-old')).toBeNull()
  })

  it('defaultExpanded 没变时不覆盖用户的手动展开', () => {
    const { rerender } = render(<FileDiffBlock change={change} defaultExpanded={false} />)

    fireEvent.click(screen.getByRole('button', { name: /展开 src\/a\.ts/ }))
    expect(screen.getByText('-old')).toBeTruthy()

    // 父组件因为别的原因重渲染 —— 不该把用户点开的东西合上。
    rerender(<FileDiffBlock change={{ ...change }} defaultExpanded={false} />)

    expect(screen.getByText('-old')).toBeTruthy()
  })
})
