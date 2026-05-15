import { describe, expect, it } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'

describe('AgentToolExecutor', () => {
  it('constructs without side effects', () => {
    expect(new AgentToolExecutor()).toBeInstanceOf(AgentToolExecutor)
  })
})
