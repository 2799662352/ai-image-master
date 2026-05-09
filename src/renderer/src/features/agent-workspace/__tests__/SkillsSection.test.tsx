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
})
