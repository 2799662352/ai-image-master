// @vitest-environment jsdom
/**
 * `@plugin` mention pipeline — codex app-server "Invoke a plugin" protocol:
 * the text keeps the `@token` AND a `mention` input item with the exact
 * `plugin://<plugin-name>@<marketplace-name>` path rides along, "so the
 * server uses the exact path rather than guessing by name" (README).
 *
 * Renderer side of that contract:
 *   1. extractMentionTokens: `@token` marker syntax (mirrors extractSkillTokens).
 *   2. loadAvailablePluginMentions: plugin/installed → mention candidates.
 *   3. send()/steer(): resolve tokens against candidates → payload.mentions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractMentionTokens, useAgentChatStore } from '../store'

const sendMessage = vi.fn()
const listInstalledPlugins = vi.fn()

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  listInstalledPlugins.mockReset()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, listInstalledPlugins, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages: [],
    isRunning: false,
    input: '',
    attachments: [],
    pendingReferences: [],
    availableSkills: [],
    availablePluginMentions: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
  } as never)
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('extractMentionTokens — codex @token marker', () => {
  it('returns [] for plain text', () => {
    expect(extractMentionTokens('hello there')).toEqual([])
  })

  it('extracts @token at start of input and after whitespace', () => {
    expect(extractMentionTokens('@sample summarize this')).toEqual(['sample'])
    expect(extractMentionTokens('please run @catimation-video now')).toEqual(['catimation-video'])
  })

  it('does NOT extract emails or mid-word @', () => {
    expect(extractMentionTokens('mail me@example.com please')).toEqual([])
    expect(extractMentionTokens('foo@bar')).toEqual([])
  })

  it('terminates the token at non-[\\w.-] characters', () => {
    expect(extractMentionTokens('@sample, then continue')).toEqual(['sample'])
  })
})

describe('send() forwards resolved plugin mentions', () => {
  it('attaches payload.mentions with the exact plugin:// path for known tokens', async () => {
    useAgentChatStore.setState({
      input: '@sample Summarize the latest updates.',
      availablePluginMentions: [
        { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
      ],
    } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0].mentions).toEqual([
      { name: 'Sample Plugin', path: 'plugin://sample@test' },
    ])
    // The @token stays in the text — codex expects both per the README.
    expect(sendMessage.mock.calls[0][0].content).toContain('@sample')
  })

  it('omits mentions entirely when no token resolves to an installed plugin', async () => {
    useAgentChatStore.setState({
      input: '@unknown-token do things',
      availablePluginMentions: [
        { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
      ],
    } as never)

    await useAgentChatStore.getState().send()

    expect(sendMessage.mock.calls[0][0].mentions).toBeUndefined()
  })
})

describe('loadAvailablePluginMentions — plugin/installed → candidates', () => {
  it('maps installed+enabled plugins across marketplaces to plugin:// paths', async () => {
    listInstalledPlugins.mockResolvedValue({
      ok: true,
      data: {
        marketplaces: [
          {
            name: 'test',
            path: null,
            interface: null,
            plugins: [
              {
                id: 'p1', name: 'sample', installed: true, enabled: true,
                availability: 'AVAILABLE',
                interface: { displayName: 'Sample Plugin' },
              },
              // Not installed — must be excluded.
              { id: 'p2', name: 'ghost', installed: false, enabled: false, availability: 'AVAILABLE', interface: null },
              // Admin-disabled — must be excluded.
              { id: 'p3', name: 'blocked', installed: true, enabled: true, availability: 'DISABLED_BY_ADMIN', interface: null },
            ],
          },
        ],
        marketplaceLoadErrors: [],
      },
    })

    await useAgentChatStore.getState().loadAvailablePluginMentions()

    expect(useAgentChatStore.getState().availablePluginMentions).toEqual([
      { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ])
  })

  it('keeps the previous cache when the IPC is unavailable or fails', async () => {
    useAgentChatStore.setState({
      availablePluginMentions: [
        { token: 'sample', name: 'Sample Plugin', path: 'plugin://sample@test' },
      ],
    } as never)
    listInstalledPlugins.mockRejectedValue(new Error('boom'))

    await useAgentChatStore.getState().loadAvailablePluginMentions()

    expect(useAgentChatStore.getState().availablePluginMentions).toHaveLength(1)
  })
})
