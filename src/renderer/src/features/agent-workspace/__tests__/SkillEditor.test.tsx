import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillEditor } from '../SkillEditor'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('SkillEditor', () => {
  it('saves a workspace skill from the form', async () => {
    const saveSkill = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveSkill, getSkillDetail: vi.fn() } },
    })

    render(<SkillEditor mode="new" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mine' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'desc' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: '## Hello' } })
    fireEvent.click(screen.getByText('Save'))

    expect(saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mine',
        description: 'desc',
        instructions: '## Hello',
        scope: 'workspace',
      }),
    )
  })

  it('round-trips form to raw on the SKILL.md text', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agent: { saveSkill: vi.fn(), getSkillDetail: vi.fn() } },
    })

    render(<SkillEditor mode="new" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rt' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'body' } })
    fireEvent.click(screen.getByText('Raw'))

    const raw = screen.getByTestId('skill-raw-editor') as HTMLTextAreaElement
    expect(raw.value).toContain('name: rt')
    expect(raw.value).toContain('body')
  })
})
