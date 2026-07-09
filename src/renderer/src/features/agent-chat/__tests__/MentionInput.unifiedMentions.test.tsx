/**
 * `@` popup — unified mentions (MentionsV2 parity, openai/codex#19068 /
 * #27499 which promoted the unified popup to default in June 2026).
 *
 * Upstream behaviour we mirror: typing `@…` searches plugins, skills and
 * files in ONE popup; "selecting a plugin or skill inserts the corresponding
 * `$name`" (skills keep the `$` marker in the text so the existing
 * extractSkillTokens → payload.skills pipeline is reused verbatim — no
 * protocol change). The legacy `$` trigger stays as-is for compatibility.
 *
 * Flat keyboard order: plugins → skills → files.
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
    availableSkills: [
      { name: 'skill-creator', description: 'Create new skills', scope: 'user', path: 'C:/skills/skill-creator/SKILL.md' },
      { name: 'compactor', description: 'Compact things', scope: 'project', path: 'C:/skills/compactor/SKILL.md' },
    ],
    availablePluginMentions: [
      { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ],
  } as never)
})

function typeAt(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value } })
  textarea.selectionStart = textarea.selectionEnd = value.length
  fireEvent.keyUp(textarea, { key: value[value.length - 1] ?? '@' })
}

describe('MentionInput unified @ popup skills group', () => {
  it('lists matching skills in the @ popup with the $name insertion preview', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@skill')

    expect(screen.getByText('$skill-creator')).toBeTruthy()
    expect(screen.getByText('Create new skills')).toBeTruthy()
    // Non-matching skill stays hidden.
    expect(screen.queryByText('$compactor')).toBeNull()
  })

  it('Enter on a highlighted skill inserts `$name ` (official MentionsV2 insertion)', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@compac')

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useAgentChatStore.getState().input).toBe('$compactor ')
    const api = (window as unknown as { electronAPI: { agent: { sendMessage: ReturnType<typeof vi.fn> } } }).electronAPI
    expect(api.agent.sendMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('Compact things')).toBeNull()
  })

  it('mousedown on a skill row commits it the same way', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '@skill')

    fireEvent.mouseDown(screen.getByText('$skill-creator'))

    expect(useAgentChatStore.getState().input).toBe('$skill-creator ')
  })

  it('keyboard order walks plugins → skills: ArrowDown past the plugin row lands on a skill', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // "sam" matches the plugin token AND nothing else… use a query matching
    // both groups: 'c' hits 'sample'? no. Use 'a': plugin 'sample' (contains a)
    // and skills 'skill-creator'/'compactor' (contain a).
    typeAt(textarea, '@a')

    // plugin row first
    expect(screen.getByText('@sample')).toBeTruthy()
    // skills present
    expect(screen.getByText('$skill-creator')).toBeTruthy()

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Highlight started on the plugin (idx 0); one ArrowDown lands on the
    // first skill row (idx 1) — committing must insert the skill marker.
    expect(useAgentChatStore.getState().input).toBe('$skill-creator ')
  })

  it('legacy `$` trigger still opens the skill-only popup', () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    typeAt(textarea, '$compac')

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useAgentChatStore.getState().input).toBe('$compactor ')
  })
})
