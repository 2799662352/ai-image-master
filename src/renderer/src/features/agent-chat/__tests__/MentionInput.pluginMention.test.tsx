/**
 * `@` popup — plugin mention group (codex app-server "Invoke a plugin").
 *
 * Installed plugins from `plugin/installed` surface in the same `@` popup as
 * workspace files. Committing a plugin keeps the `@token ` in the text (per
 * the README the token AND the mention item travel together — the send
 * pipeline resolves the token via extractMentionTokens → payload.mentions),
 * unlike files where the token is replaced by a reference chip.
 */
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
    availablePluginMentions: [
      { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
      { token: 'catimation-video', name: 'Catimation Video', path: 'plugin://catimation-video@local' },
    ],
  } as never)
})

function typeAt(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value } })
  textarea.selectionStart = textarea.selectionEnd = value.length
  fireEvent.keyUp(textarea, { key: value[value.length - 1] ?? '@' })
}

describe('MentionInput @ popup plugin group', () => {
  it('lists matching installed plugins when typing @query', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@sam')

    expect(screen.getByText('@sample')).toBeTruthy()
    expect(screen.getByText('Sample Plugin')).toBeTruthy()
    expect(screen.queryByText('@catimation-video')).toBeNull()
  })

  it('Enter commits the highlighted plugin: keeps `@token ` in the text and closes the popup', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@sam')

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useAgentChatStore.getState().input).toBe('@sample ')
    const api = (window as unknown as { electronAPI: { agent: { sendMessage: ReturnType<typeof vi.fn> } } }).electronAPI
    expect(api.agent.sendMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('Sample Plugin')).toBeNull()
  })

  it('mousedown on a plugin row commits it the same way', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@cati')

    fireEvent.mouseDown(screen.getByText('@catimation-video'))

    expect(useAgentChatStore.getState().input).toBe('@catimation-video ')
  })
})
