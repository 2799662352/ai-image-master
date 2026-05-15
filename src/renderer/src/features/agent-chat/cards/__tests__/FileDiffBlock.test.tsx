import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FileChange } from '../../../../../../types/agent-timeline'
import { FileDiffBlock } from '../FileDiffBlock'

function change(diff: string): FileChange {
  return {
    path: 'docs/a.md',
    operation: 'edit',
    diff,
    added: 1,
    removed: 1,
  }
}

describe('FileDiffBlock', () => {
  it('styles added and deleted lines distinctly', () => {
    render(<FileDiffBlock change={change('@@ -1 +1 @@\n-old\n+new\n context')} />)

    expect(screen.getByText('-old').className).toContain('red')
    expect(screen.getByText('+new').className).toContain('emerald')
    expect(screen.getByText('@@ -1 +1 @@').className).toContain('cyan')
  })

  it('truncates large diffs in chat', () => {
    const diff = Array.from({ length: 220 }, (_, i) => `+line ${i}`).join('\n')
    render(<FileDiffBlock change={change(diff)} />)

    expect(screen.getByText(/Show all 220 lines/)).toBeTruthy()
  })
})
