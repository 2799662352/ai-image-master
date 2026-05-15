import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { ShellOutputPreview } from '../ShellOutputPreview'

afterEach(cleanup)

const ref: AgentReference = {
  id: 'command:cmd_1',
  type: 'command',
  label: 'npm run test',
  source: { kind: 'codexItem', itemId: 'cmd_1' },
  status: 'success',
  openBehavior: 'shellOutput',
  preview: {
    command: 'npm run test',
    cwd: 'D:/repo',
    stdout: '\u001b[32mok\u001b[0m',
    stderr: '',
    exitCode: 0,
  },
}

describe('ShellOutputPreview', () => {
  it('shows command, cwd, exit, and strips ANSI escape codes from stdout', () => {
    render(<ShellOutputPreview reference={ref} />)
    expect(screen.getByText('npm run test')).toBeTruthy()
    expect(screen.getByText(/cwd:\s*D:\/repo/)).toBeTruthy()
    expect(screen.getByText(/exit:\s*0/)).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
    expect(screen.queryByText(/\u001b\[32m/)).toBeNull()
  })
})
