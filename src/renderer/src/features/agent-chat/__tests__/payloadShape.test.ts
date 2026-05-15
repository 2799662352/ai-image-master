import { describe, expectTypeOf, it } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../../types/agent'
import type { AgentReference } from '../../../../../types/agent-reference'

describe('AgentSendMessagePayload reference fields', () => {
  it('allows structured references but not renderer-only pendingReferences', () => {
    expectTypeOf<AgentSendMessagePayload>().toHaveProperty('references').toEqualTypeOf<AgentReference[] | undefined>()
    expectTypeOf<AgentSendMessagePayload>().not.toHaveProperty('pendingReferences')
  })
})
