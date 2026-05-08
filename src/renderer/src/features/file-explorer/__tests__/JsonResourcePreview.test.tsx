import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { JsonResourcePreview } from '../JsonResourcePreview'

afterEach(cleanup)

describe('JsonResourcePreview', () => {
  it('renders prettified JSON safely for normal payloads', () => {
    const ref: AgentReference = {
      id: 'mcp:test',
      type: 'mcp',
      label: 'mcp:test',
      source: { kind: 'codexItem', itemId: 'mcp_1' },
      status: 'success',
      openBehavior: 'jsonResource',
      preview: { json: { hello: 'world' } },
    }
    render(<JsonResourcePreview reference={ref} />)
    expect(screen.getByText(/"hello": "world"/)).toBeTruthy()
  })

  it('falls back for circular structures without throwing', () => {
    const cyclic: { a?: unknown } = {}
    cyclic.a = cyclic
    const ref: AgentReference = {
      id: 'mcp:cyclic',
      type: 'mcp',
      label: 'mcp:cyclic',
      source: { kind: 'codexItem', itemId: 'cyclic_1' },
      status: 'success',
      openBehavior: 'jsonResource',
      preview: { json: cyclic },
    }
    expect(() => render(<JsonResourcePreview reference={ref} />)).not.toThrow()
    expect(screen.getByText(/Unable to render JSON|object/)).toBeTruthy()
  })
})
