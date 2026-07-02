import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: { stat: vi.fn() },
    },
    configurable: true,
  })
  useAgentChatStore.setState({
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
  } as never)
})

/**
 * Regression: arrow-key navigation in the `/` palette was dead because the
 * textarea's `onKeyUp={refreshTriggerPopups}` fired after every ArrowDown
 * keydown and unconditionally reset the highlight to 0. preventDefault on the
 * keydown stops the caret from moving but does NOT stop the keyup, so each
 * ArrowDown went "set to 1 → keyup resets to 0" and the selection never moved.
 */
describe('MentionInput slash palette keyboard navigation', () => {
  function openSlashPalette(): HTMLTextAreaElement {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // fireEvent.change sets the DOM value to `/` (what refreshTriggerPopups
    // reads) and drives the store via onChange.
    fireEvent.change(textarea, { target: { value: '/' } })
    textarea.selectionStart = textarea.selectionEnd = 1
    // keyUp runs refreshTriggerPopups synchronously → opens the popup.
    fireEvent.keyUp(textarea, { key: '/' })
    return textarea
  }

  function selectedOptionIndex(): number {
    const options = screen.getAllByRole('option')
    return options.findIndex((el) => el.getAttribute('aria-selected') === 'true')
  }

  it('ArrowDown moves the highlight down and a trailing keyup does not reset it', () => {
    const textarea = openSlashPalette()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)
    expect(selectedOptionIndex()).toBe(0)

    // Press ArrowDown (keydown handles nav) then release it (keyup must NOT
    // reset the highlight back to 0).
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyUp(textarea, { key: 'ArrowDown' })

    expect(selectedOptionIndex()).toBe(1)
  })

  it('ArrowDown twice lands on the third item', () => {
    const textarea = openSlashPalette()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(2)

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyUp(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyUp(textarea, { key: 'ArrowDown' })

    expect(selectedOptionIndex()).toBe(2)
  })
})

/**
 * Regression: picking `/goal` from the palette used to immediately "view the
 * goal" and CLEAR the composer, so the user could never type their objective.
 * `/goal` needs an argument, so committing it must PREFILL `/goal ` and keep
 * focus (not execute / send).
 */
describe('MentionInput `/goal` command prefills instead of executing', () => {
  it('committing /goal fills the composer with "/goal " and sends nothing', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // Type `/goal` and open the palette (filtered to the goal command).
    fireEvent.change(textarea, { target: { value: '/goal' } })
    textarea.selectionStart = textarea.selectionEnd = 5
    fireEvent.keyUp(textarea, { key: 'l' })

    // Commit the highlighted item (the goal command) with Enter.
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Composer is prefilled with the goal prefix (trailing space) — ready for
    // the user to type their objective — and no message was dispatched.
    expect(useAgentChatStore.getState().input).toBe('/goal ')
    expect(window.electronAPI.agent.sendMessage).not.toHaveBeenCalled()
  })
})
