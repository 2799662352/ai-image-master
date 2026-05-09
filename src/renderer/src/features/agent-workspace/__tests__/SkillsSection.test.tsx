import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillsSection } from '../SkillsSection'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('SkillsSection', () => {
  it('lists workspace and personal skills with insert action', async () => {
    const insertText = vi.fn()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([
            {
              id: 'workspace:demo',
              name: 'demo',
              scope: 'workspace',
              path: '/p/.agents/skills/demo/SKILL.md',
              description: 'do x',
              warnings: [],
            },
            {
              id: 'personal:helper',
              name: 'helper',
              scope: 'personal',
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

    expect(insertText).toHaveBeenCalledWith(expect.stringContaining('demo'))
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
              id: 'workspace:demo',
              name: 'demo',
              scope: 'workspace',
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
