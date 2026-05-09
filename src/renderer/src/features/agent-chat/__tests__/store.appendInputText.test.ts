import { afterEach, describe, expect, it } from 'vitest'

import { useAgentChatStore } from '../store'

afterEach(() => {
  useAgentChatStore.setState({ input: '' })
})

describe('appendInputText', () => {
  it('appends text to the current input', () => {
    useAgentChatStore.setState({ input: 'hello' })

    useAgentChatStore.getState().appendInputText(' /demo')

    expect(useAgentChatStore.getState().input).toBe('hello /demo')
  })
})
