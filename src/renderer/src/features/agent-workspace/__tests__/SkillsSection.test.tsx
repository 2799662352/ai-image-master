import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentChatStore } from '../../agent-chat/store'
import { SkillsSection } from '../SkillsSection'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  useAgentChatStore.setState(useAgentChatStore.getInitialState(), true)
  vi.restoreAllMocks()
})

describe('SkillsSection', () => {
  it('lists repo and user skills with insert action', async () => {
    const insertText = vi.fn()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([
            {
              id: 'repo:demo',
              name: 'demo',
              scope: 'repo',
              path: '/p/.agents/skills/demo/SKILL.md',
              description: 'do x',
              warnings: [],
            },
            {
              id: 'user:helper',
              name: 'helper',
              scope: 'user',
              path: '/h/.agents/skills/helper/SKILL.md',
              description: 'helps',
              warnings: [],
            },
          ]),
          deleteSkill: vi.fn(),
        },
      },
    })

    render(<SkillsSection insertIntoChat={insertText} />)

    expect(await screen.findByText('demo')).toBeTruthy()
    expect(screen.getByText('helper')).toBeTruthy()

    fireEvent.click(screen.getAllByText('Insert')[0])

    expect(insertText).toHaveBeenCalledWith('/demo ')
    expect(useAgentChatStore.getState().input).toBe('/demo ')
  })

  it('opens the skills folder from the toolbar', async () => {
    const openSkillsFolder = vi.fn().mockResolvedValue({ success: true, path: 'D:/repo/.agents/skills' })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openSkillsFolder,
        agent: {
          listSkills: vi.fn().mockResolvedValue([]),
          deleteSkill: vi.fn(),
        },
      },
    })

    render(<SkillsSection insertIntoChat={vi.fn()} />)
    expect(await screen.findByText('No skills yet.')).toBeTruthy()
    fireEvent.click(screen.getByText('打开 Skills 文件夹'))

    expect(openSkillsFolder).toHaveBeenCalled()
    expect(await screen.findByText(/D:\/repo\/\.agents\/skills/)).toBeTruthy()
  })

  it('opens the SkillEditor form when "New Skill" is clicked', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([]),
          deleteSkill: vi.fn(),
          saveSkill: vi.fn(),
          getSkillDetail: vi.fn(),
        },
      },
    })

    render(<SkillsSection insertIntoChat={vi.fn()} />)

    expect(await screen.findByText('No skills yet.')).toBeTruthy()
    fireEvent.click(screen.getByText('New Skill'))

    // Editor form fields appear
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Instructions')).toBeTruthy()
  })

  it('opens the SkillEditor for editing an existing skill', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([
            {
              id: 'repo:demo',
              name: 'demo',
              scope: 'repo',
              path: '/p/.agents/skills/demo/SKILL.md',
              description: 'do x',
              warnings: [],
            },
          ]),
          deleteSkill: vi.fn(),
          saveSkill: vi.fn(),
          getSkillDetail: vi.fn().mockResolvedValue({
            name: 'demo',
            scope: 'workspace',
            description: 'do x',
            whenToUse: '',
            instructions: 'body',
          }),
        },
      },
    })

    render(<SkillsSection insertIntoChat={vi.fn()} />)
    fireEvent.click(await screen.findByLabelText('Edit demo'))
    expect(await screen.findByLabelText('Name')).toBeTruthy()
  })
})
