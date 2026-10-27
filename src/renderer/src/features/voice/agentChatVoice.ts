// src/renderer/src/features/voice/agentChatVoice.ts
/** 语音会话接到 agent 聊天 store 上;全应用共用一个会话。 */

import type { Message } from '../../../../types/agent-timeline'
import { useAgentChatStore } from '../agent-chat/store'
import { VoiceSession, type VoiceChatBridge } from './voiceSession'
import { useVoiceStore } from './voiceStore'

/** 最近一条用户消息之后,最后一条 assistant 消息里的最后一段正文。 */
export function latestAssistantReply(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') return null
    if (message.role !== 'assistant') continue
    for (let j = message.items.length - 1; j >= 0; j--) {
      const item = message.items[j]
      if (item.type === 'text' && item.content.trim()) return item.content
    }
  }
  return null
}

export const agentChatVoiceBridge: VoiceChatBridge = {
  getDraft: () => useAgentChatStore.getState().input,
  setDraft: (text) => useAgentChatStore.getState().setInput(text),
  canSubmit: () => {
    const state = useAgentChatStore.getState()
    return (
      !state.isRunning &&
      state.modelSelectionPending === undefined &&
      !state.editingMessageId &&
      !state.editBranchPending
    )
  },
  submit: async (text) => {
    const store = useAgentChatStore.getState()
    store.setInput(text)
    await store.send()
    // send() 真正发出时会清空输入框;被前置条件拦下则原样返回。
    return useAgentChatStore.getState().input !== text
  },
  isRunning: () => useAgentChatStore.getState().isRunning,
  subscribeRunning: (listener) =>
    useAgentChatStore.subscribe((state, previous) => {
      if (state.isRunning !== previous.isRunning) listener(state.isRunning)
    }),
  threadKey: () => useAgentChatStore.getState().threadId,
  latestReply: () => latestAssistantReply(useAgentChatStore.getState().messages),
}

let session: VoiceSession | null = null

export function getVoiceSession(): VoiceSession {
  if (!session) {
    session = new VoiceSession(agentChatVoiceBridge)
    window.electronAPI?.voice?.onAsrModelProgress((progress) => {
      useVoiceStore.getState().setModelProgress(progress)
    })
  }
  return session
}
