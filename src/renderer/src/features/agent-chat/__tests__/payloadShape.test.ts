import { describe, expectTypeOf, it } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../../types/agent'

describe('AgentSendMessagePayload (Phase 1 invariant)', () => {
  it('does NOT contain reference fields', () => {
    expectTypeOf<AgentSendMessagePayload>().not.toHaveProperty('references')
    expectTypeOf<AgentSendMessagePayload>().not.toHaveProperty('pendingReferences')
  })
})
