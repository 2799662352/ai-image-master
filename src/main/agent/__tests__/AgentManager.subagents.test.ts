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
function makeManager(backendExtras: Record<string, unknown> = {}): {
  manager: AgentManager
  emitted: AgentStreamEvent[]
  fireUnrouted: (event: AgentStreamEvent, context?: { turnId?: string }) => void
  cancel: ReturnType<typeof vi.fn>
  interruptTurn: ReturnType<typeof vi.fn>
} {
  const emitted: AgentStreamEvent[] = []
  let unrouted: ((event: AgentStreamEvent, context?: { turnId?: string }) => void) | undefined
  const cancel = vi.fn().mockResolvedValue(undefined)
  const interruptTurn = vi.fn().mockResolvedValue(undefined)

  const manager = new AgentManager({
    userDataDir: tmpDir,
    eventSink: (event: AgentStreamEvent) => { emitted.push(event) },
    backendFactory: (options) => {
      unrouted = options.onUnroutedEvent
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn(),
        cancel,
        interruptTurn,
        isHealthy: vi.fn().mockReturnValue(true),
        ...backendExtras,
      } as never
    },
  } as never)

  if (!unrouted) throw new Error('AgentManager did not wire onUnroutedEvent')
  return { manager, emitted, fireUnrouted: unrouted, cancel, interruptTurn }
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

    it('folds a child\'s token usage into the delegation card', () => {
      // Sub-agent spend is real money the parent conversation is paying, but it
      // must NOT be merged into the parent's `token_usage_updated`: the store
      // replaces `tokenUsage` wholesale and drives the context-window gauge off
      // it, so a child's absolute counts would misreport how full the parent's
      // context is. The delegation item is the honest place for it.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      fireUnrouted({
        type: 'token_usage_updated',
        threadId: 'child-1',
        usage: { inputTokens: 1200, outputTokens: 340 },
      } as AgentStreamEvent)

      const patch = emitted.find((event) => event.type === 'item_delta')
      expect(patch).toMatchObject({
        type: 'item_delta',
        threadId: 'db-parent',
        itemId: 'call_spawn',
        itemType: 'activity',
        patch: {
          kind: 'mergeFields',
          fields: {
            delegation: {
              agents: [{ threadId: 'child-1', tokens: { input: 1200, output: 340 } }],
            },
          },
        },
      })
    })

    it('keeps the latest usage rather than summing repeated reports', () => {
      // `thread/tokenUsage/updated` is a cumulative snapshot per thread, not a
      // delta — adding successive reports would inflate the number.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      for (const inputTokens of [500, 1200]) {
        fireUnrouted({
          type: 'token_usage_updated',
          threadId: 'child-1',
          usage: { inputTokens, outputTokens: 10 },
        } as AgentStreamEvent)
      }

      const last = emitted.filter((event) => event.type === 'item_delta').at(-1)
      expect(last).toMatchObject({
        patch: { fields: { delegation: { agents: [{ tokens: { input: 1200 } }] } } },
      })
    })

    it('does not warn about a child whose usage it consumed', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { manager, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      fireUnrouted({
        type: 'token_usage_updated',
        threadId: 'child-1',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as AgentStreamEvent)

      expect(warn.mock.calls.filter((args) => /sub-agent/i.test(String(args[0])))).toHaveLength(0)
    })

    it('recovers the child\'s answer from its own stream', () => {
      // Multi-agent V2 leaves `agentsStates` empty — measured with
      // `scripts/smoke-subagents.ts --v2` — so the only place a child's reply
      // exists is the child's own thread, which we otherwise drop. Attribution
      // is what makes recovering it safe: it lands on the delegation card, not
      // spliced into the parent's message.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))

      fireUnrouted({
        type: 'item_completed',
        threadId: 'child-1',
        itemId: 'msg-child',
        itemType: 'text',
        final: { content: 'pong' },
      } as AgentStreamEvent)

      const patch = emitted.find((event) => event.type === 'item_delta')
      expect(patch).toMatchObject({
        threadId: 'db-parent',
        itemId: 'call_spawn',
        patch: {
          fields: { delegation: { agents: [{ threadId: 'child-1', message: 'pong' }] } },
        },
      })
    })

    it('keeps the reply the parent reported over one scraped from the child', () => {
      // V1 reports the child's answer through `agentsStates`, which is the
      // authoritative summary the parent acted on; a later child chunk must not
      // overwrite it with a partial.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      const withState = spawnCompleted('child-1') as unknown as {
        final: { delegation: { agents: Array<Record<string, unknown>> } }
      }
      withState.final.delegation.agents = [
        { threadId: 'child-1', status: 'completed', message: 'authoritative answer' },
      ]
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(withState as unknown as AgentStreamEvent)

      fireUnrouted({
        type: 'item_completed',
        threadId: 'child-1',
        itemId: 'msg-child',
        itemType: 'text',
        final: { content: 'partial' },
      } as AgentStreamEvent)

      const patches = emitted.filter((event) => event.type === 'item_delta')
      const merged = patches.at(-1) as undefined | {
        patch: { fields: { delegation: { agents: Array<{ message?: string }> } } }
      }
      expect(merged?.patch.fields.delegation.agents[0].message).toBe('authoritative answer')
    })

    it('settles a V2 agent row when the child\'s turn ends', () => {
      // V2 announces a spawn through `subAgentActivity`, which carries no
      // status, and its `wait` item reports an empty `agentsStates`. Nothing
      // else ever supplies one — so on the channels where V2 is enabled the row
      // pulsed "working…" for the life of the card no matter what the child
      // did. The child's own `turn/completed` reaches us on the unrouted path
      // and is the only terminal signal available.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents({
        type: 'item_completed',
        threadId: 'codex-parent',
        itemId: 'call_activity',
        itemType: 'activity',
        final: {
          kind: 'subAgentActivity',
          delegation: {
            tool: 'started',
            agents: [{ threadId: 'child-1', name: '/root/scout' }],
          },
        },
      } as AgentStreamEvent)

      fireUnrouted({ type: 'turn_completed', threadId: 'child-1' } as AgentStreamEvent)

      const patch = emitted.filter((event) => event.type === 'item_delta').at(-1)
      expect(patch).toMatchObject({
        itemId: 'call_activity',
        patch: {
          fields: { delegation: { agents: [{ threadId: 'child-1', status: 'completed' }] } },
        },
      })
    })

    it('keeps a child bound to the card that spawned it, not to a follow-up', () => {
      // Every V2 tool call is its own item id, so a `followup_task` to a
      // running child used to rebind ownership: the child's reply and tokens
      // then landed on the follow-up card while the spawn card said "working…"
      // forever. Steering a long job with follow-ups is the normal path.
      const { manager, emitted, fireUnrouted } = makeManager()
      registerParent(manager)
      const activity = (itemId: string, tool: string): AgentStreamEvent => ({
        type: 'item_completed',
        threadId: 'codex-parent',
        itemId,
        itemType: 'activity',
        final: {
          kind: 'subAgentActivity',
          delegation: { tool, agents: [{ threadId: 'child-1' }] },
        },
      }) as AgentStreamEvent
      const note = (event: AgentStreamEvent): void =>
        (manager as unknown as { noteDelegatedAgents(e: AgentStreamEvent): void })
          .noteDelegatedAgents(event)

      note(activity('call_spawn', 'started'))
      note(activity('call_followup', 'interacted'))
      fireUnrouted({
        type: 'item_completed',
        threadId: 'child-1',
        itemId: 'msg',
        itemType: 'text',
        final: { content: 'done the thing' },
      } as AgentStreamEvent)

      const patch = emitted.filter((event) => event.type === 'item_delta').at(-1)
      expect(patch).toMatchObject({ itemId: 'call_spawn' })
    })

    /**
     * V2's spawn event names an agent only by the path of its definition file,
     * so the card read `/root/pong_agent`. Upstream assigns every spawn a human
     * nickname and keeps it on the child's own thread record — the same place
     * the TUI's agent picker reads it from.
     *
     * Measured with `scripts/smoke-subagents.ts --v2 --read-child` on
     * codex-cli 0.145.0: the child's record has `agentNickname` but no model
     * slug and no item holding the task it was assigned, so the nickname is
     * genuinely all there is to add here.
     */
    describe('nickname enrichment for V2 agents', () => {
      const v2Spawn = (itemId = 'call_spawn'): AgentStreamEvent => ({
        type: 'item_completed',
        threadId: 'codex-parent',
        itemId,
        itemType: 'activity',
        final: {
          kind: 'subAgentActivity',
          delegation: {
            tool: 'started',
            agents: [{ threadId: 'child-v2', name: '/root/pong_agent' }],
          },
        },
      }) as AgentStreamEvent

      const note = (manager: AgentManager, event: AgentStreamEvent): void =>
        (manager as unknown as { noteDelegatedAgents(e: AgentStreamEvent): void })
          .noteDelegatedAgents(event)

      it('relabels the agent with the nickname upstream assigned', async () => {
        const readSubagentInfo = vi.fn().mockResolvedValue({ nickname: 'Newton' })
        const { manager, emitted } = makeManager({ readSubagentInfo })
        registerParent(manager)

        note(manager, v2Spawn())
        await vi.waitFor(() => expect(emitted.some((e) => e.type === 'item_delta')).toBe(true))

        expect(readSubagentInfo).toHaveBeenCalledWith('child-v2')
        expect(emitted.filter((e) => e.type === 'item_delta').at(-1)).toMatchObject({
          threadId: 'db-parent',
          itemId: 'call_spawn',
          patch: {
            fields: { delegation: { agents: [{ threadId: 'child-v2', name: 'Newton' }] } },
          },
        })
      })

      it('reads a child once even though the spawn is reported repeatedly', async () => {
        const readSubagentInfo = vi.fn().mockResolvedValue({ nickname: 'Newton' })
        const { manager, emitted } = makeManager({ readSubagentInfo })
        registerParent(manager)

        note(manager, v2Spawn())
        await vi.waitFor(() => expect(emitted.some((e) => e.type === 'item_delta')).toBe(true))
        // `item/started` then `item/completed`, plus a follow-up tool call.
        note(manager, v2Spawn())
        note(manager, v2Spawn('call_followup'))
        await Promise.resolve()

        expect(readSubagentInfo).toHaveBeenCalledTimes(1)
      })

      it('keeps the path label when the read fails', async () => {
        const readSubagentInfo = vi.fn().mockRejectedValue(new Error('thread not found'))
        const { manager, emitted } = makeManager({ readSubagentInfo })
        registerParent(manager)

        note(manager, v2Spawn())
        await vi.waitFor(() => expect(readSubagentInfo).toHaveBeenCalled())
        await Promise.resolve()

        // Nothing to say, so nothing is said: the card keeps rendering the path.
        expect(emitted.filter((e) => e.type === 'item_delta')).toHaveLength(0)
      })
    })

    it('stops the children too when the user stops the conversation', async () => {
      // Upstream does not cascade: `interrupt_agent` acts on one thread, and
      // unlike `close_agent` (whose own tool description says "and any open
      // descendants") it has no descendant walk. So pressing stop ended the
      // parent turn while every spawned child kept generating — paid work the
      // user explicitly cancelled. Measured with
      // `scripts/smoke-subagents.ts --interrupt-child`: the server DOES accept
      // `turn/interrupt` addressed at a child's own (threadId, turnId), so the
      // cascade is ours to do.
      const { manager, fireUnrouted, cancel, interruptTurn } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))
      // A child's turn id only becomes knowable from its own streamed events.
      fireUnrouted(
        { type: 'item_delta', threadId: 'child-1', itemId: 'm', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'x' } } as AgentStreamEvent,
        { turnId: 'child-turn-1' },
      )

      await manager.cancel('db-parent')

      expect(cancel).toHaveBeenCalledWith('codex-parent')
      expect(interruptTurn).toHaveBeenCalledWith('child-1', 'child-turn-1')
    })

    it('does not interrupt a child whose turn already ended', async () => {
      const { manager, fireUnrouted, interruptTurn } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))
      fireUnrouted(
        { type: 'item_delta', threadId: 'child-1', itemId: 'm', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'x' } } as AgentStreamEvent,
        { turnId: 'child-turn-1' },
      )
      fireUnrouted({ type: 'turn_completed', threadId: 'child-1' } as AgentStreamEvent)

      await manager.cancel('db-parent')

      expect(interruptTurn).not.toHaveBeenCalled()
    })

    it('leaves another conversation\'s children alone', async () => {
      const { manager, fireUnrouted, interruptTurn } = makeManager()
      registerParent(manager)
      ;(manager as unknown as {
        noteDelegatedAgents(event: AgentStreamEvent): void
      }).noteDelegatedAgents(spawnCompleted('child-1'))
      fireUnrouted(
        { type: 'item_delta', threadId: 'child-1', itemId: 'm', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'x' } } as AgentStreamEvent,
        { turnId: 'child-turn-1' },
      )

      await manager.cancel('db-other')

      expect(interruptTurn).not.toHaveBeenCalled()
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
