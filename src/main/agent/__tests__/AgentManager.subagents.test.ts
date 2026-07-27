import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'
import type { AgentStreamEvent } from '../types'

/**
 * What the manager does with a sub-agent's events.
 *
 * Multi-agent V2 is on by default at 0.145, so a turn can spawn children whose
 * work streams under their own thread ids. The client hands those to
 * `onUnroutedEvent` rather than buffering them forever; the manager's job here
 * is narrow but load-bearing:
 *
 *   - never forward them to the renderer, whose store keys everything by the
 *     ACTIVE DB thread and would splice a child's text into the parent's
 *     message (see `forwardEvents`, which rewrites every threadId);
 *   - leave exactly one diagnostic per unknown thread, so if this starts
 *     happening in the wild it is visible without flooding a streaming turn.
 */

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-subagents-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

/** Captures the `onUnroutedEvent` the manager wires into its backend. */
function makeManager(): {
  emitted: AgentStreamEvent[]
  fireUnrouted: (event: AgentStreamEvent) => void
} {
  const emitted: AgentStreamEvent[] = []
  let unrouted: ((event: AgentStreamEvent) => void) | undefined

  new AgentManager({
    userDataDir: tmpDir,
    eventSink: (event: AgentStreamEvent) => { emitted.push(event) },
    backendFactory: (options) => {
      unrouted = options.onUnroutedEvent
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(),
        cancel: vi.fn(),
        isHealthy: vi.fn().mockReturnValue(true),
      } as never
    },
  } as never)

  if (!unrouted) throw new Error('AgentManager did not wire onUnroutedEvent')
  return { emitted, fireUnrouted: unrouted }
}

const childDelta = (threadId: string): AgentStreamEvent => ({
  type: 'item_delta',
  threadId,
  itemId: 'msg-child',
  itemType: 'text',
  patch: { kind: 'appendText', field: 'content', text: 'pong' },
}) as AgentStreamEvent

describe('AgentManager sub-agent events', () => {
  it('never forwards a sub-agent event to the renderer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { emitted, fireUnrouted } = makeManager()

    fireUnrouted(childDelta('child-1'))

    // The renderer store would attribute this to whatever thread is open.
    expect(emitted).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })

  it('warns once per thread, not once per event', () => {
    // A child turn emits a dozen events; a per-event warning would bury the
    // streaming log it shares with the live turn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fireUnrouted } = makeManager()

    for (let i = 0; i < 5; i++) fireUnrouted(childDelta('child-1'))
    fireUnrouted(childDelta('child-2'))

    const subagentWarnings = warn.mock.calls.filter(
      (args) => /sub-agent|subagent/i.test(String(args[0])),
    )
    expect(subagentWarnings).toHaveLength(2)
    expect(String(subagentWarnings[0][0])).toContain('child-1')
    expect(String(subagentWarnings[1][0])).toContain('child-2')
  })
})
