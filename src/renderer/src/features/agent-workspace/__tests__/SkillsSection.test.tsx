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
    // Empty-state copy lives in a friendlier card now: title + helper text.
    expect(await screen.findByText('No skills yet')).toBeTruthy()
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

    expect(await screen.findByText('No skills yet')).toBeTruthy()
    // The empty-state copy mentions "New Skill" inline, so target the
    // toolbar button by role to disambiguate.
    fireEvent.click(screen.getByRole('button', { name: 'New Skill' }))

    // Editor form fields appear
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Instructions')).toBeTruthy()
  })

  // Each SkillGroup header (REPO / USER / SYSTEM) gets its own "open folder"
  // button so the user can jump to the right on-disk root directly, instead
  // of always opening the legacy app-data folder via the toolbar action.
  it('opens each scope root via the group-level open button', async () => {
    const openSkillsRoot = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, path: 'D:/p/.agents/skills' })
      .mockResolvedValueOnce({ ok: true, path: 'C:/Users/me/.agents/skills' })

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          listSkills: vi.fn().mockResolvedValue([
            {
              id: 'repo:demo',
              name: 'demo',
              scope: 'repo',
              path: 'D:/p/.agents/skills/demo/SKILL.md',
              description: 'do x',
              warnings: [],
            },
            {
              id: 'user:helper',
              name: 'helper',
              scope: 'user',
              path: 'C:/Users/me/.agents/skills/helper/SKILL.md',
              description: 'helps',
              warnings: [],
            },
          ]),
          deleteSkill: vi.fn(),
          openSkillsRoot,
        },
      },
    })

    render(<SkillsSection insertIntoChat={vi.fn()} />)
    await screen.findByText('demo')

    fireEvent.click(screen.getByLabelText('Open REPO skills folder'))
    expect(openSkillsRoot).toHaveBeenNthCalledWith(1, 'repo')

    fireEvent.click(screen.getByLabelText('Open USER skills folder'))
    expect(openSkillsRoot).toHaveBeenNthCalledWith(2, 'user')
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
