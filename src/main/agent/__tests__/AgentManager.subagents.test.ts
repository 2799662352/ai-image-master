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
  manager: AgentManager
  emitted: AgentStreamEvent[]
  fireUnrouted: (event: AgentStreamEvent) => void
} {
  const emitted: AgentStreamEvent[] = []
  let unrouted: ((event: AgentStreamEvent) => void) | undefined

  const manager = new AgentManager({
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
  return { manager, emitted, fireUnrouted: unrouted }
}

/** The delegation item as the router emits it, from a measured wire payload. */
function spawnCompleted(childThreadId: string): AgentStreamEvent {
  return {
    type: 'item_completed',
    threadId: 'codex-parent',
    itemId: 'call_spawn',
    itemType: 'activity',
    final: {
      kind: 'collabAgentToolCall',
      status: 'success',
      delegation: {
        tool: 'spawnAgent',
        prompt: 'do the thing',
        model: 'gpt-5.5',
        agents: [{ threadId: childThreadId }],
      },
    },
  } as AgentStreamEvent
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

  /**
   * MCP tool attribution. `ToolRouter` asks `resolveDbThreadId` which chat a
   * tool call belongs to, by reverse-scanning the DB↔codex thread map. A
   * sub-agent thread is not in that map, so without this its `generate_image`
   * or `ask_user` card falls back to "whatever chat is open" — the picture
   * lands in the wrong conversation.
   *
   * The parent's own `collabAgentToolCall` names the children
   * (`receiverThreadIds` → `delegation.agents`), so the ownership is knowable
   * from the stream we already consume.
   */
  describe('tool-call attribution for spawned children', () => {
    function registerParent(manager: AgentManager): void {
      ;(manager as unknown as {
        rememberCodexThread(db: string, codex: string): void
      }).rememberCodexThread('db-parent', 'codex-parent')
    }

    it('resolves a child thread to the parent conversation', () => {
      const { manager } = makeManager()
      registerParent(manager)

      expect(manager.resolveDbThreadId('child-1')).toBeUndefined()

      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      expect(manager.resolveDbThreadId('child-1')).toBe('db-parent')
      // The parent still resolves to itself.
      expect(manager.resolveDbThreadId('codex-parent')).toBe('db-parent')
    })

    it('ignores a delegation whose parent thread is not ours', () => {
      // A codex thread we never minted cannot attribute anything; guessing
      // would be worse than leaving the tool call unattributed.
      const { manager } = makeManager()

      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      expect(manager.resolveDbThreadId('child-1')).toBeUndefined()
    })

    it('names the owning conversation in the drop warning', () => {
      // Once ownership is known the diagnostic should say whose child it was;
      // "some thread dropped events" is not actionable.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { manager, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      fireUnrouted(childDelta('child-1'))

      const line = String(warn.mock.calls.at(-1)?.[0])
      expect(line).toContain('child-1')
      expect(line).toContain('db-parent')
    })
  })
})
