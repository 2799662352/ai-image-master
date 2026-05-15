import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSkillsPanel } from '../CodexSkillsPanel'
import { useAgentChatStore } from '../store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'electronAPI')
  useAgentChatStore.setState({ input: '' })
})

describe('CodexSkillsPanel', () => {
  it('shows discovered skills and appends a skill mention to chat input', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getSkillsSummary: vi.fn().mockResolvedValue({
            skills: [
              {
                name: 'workspace-skill',
                scope: 'repo',
                description: 'Use from workspace.',
                path: 'D:/repo/.agents/skills/workspace-skill/SKILL.md',
              },
            ],
            warnings: [],
          }),
        },
      },
    })
    useAgentChatStore.setState({ input: 'hello' })

    render(<CodexSkillsPanel />)

    expect(await screen.findByText('workspace-skill')).toBeTruthy()
    expect(screen.getByText('repo')).toBeTruthy()
    expect(screen.getByText('Use from workspace.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Insert \$workspace-skill/i }))

    expect(useAgentChatStore.getState().input).toBe('hello $workspace-skill')
  })

  it('renders warnings, empty state, and load errors', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getSkillsSummary: vi.fn().mockResolvedValue({
            skills: [],
            warnings: ['Invalid frontmatter in bad-skill'],
          }),
        },
      },
    })
    const { rerender } = render(<CodexSkillsPanel />)

    expect(await screen.findByText(/No Codex skills found/i)).toBeTruthy()
    expect(screen.getByText(/Invalid frontmatter in bad-skill/i)).toBeTruthy()

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { getSkillsSummary: vi.fn().mockRejectedValue(new Error('failed skills')) } },
    })
    rerender(<CodexSkillsPanel key="error" />)

    expect(await screen.findByText(/failed skills/i)).toBeTruthy()
  })
})
