import { useAgentChatStore } from './store'
import type { AgentAttachmentInput } from '../../../../types/agent'

const legacyAttachmentKeys = new WeakMap<AgentAttachmentInput, string>()
let nextLegacyAttachmentKey = 0

function attachmentKey(attachment: AgentAttachmentInput): string {
  if (attachment.composerId) return attachment.composerId
  const existing = legacyAttachmentKeys.get(attachment)
  if (existing) return existing
  nextLegacyAttachmentKey += 1
  const generated = `legacy-composer-attachment:${nextLegacyAttachmentKey}`
  legacyAttachmentKeys.set(attachment, generated)
  return generated
}

export function AttachmentChips() {
  const attachments = useAgentChatStore((state) => state.attachments)
  const removeAttachment = useAgentChatStore((state) => state.removeAttachment)
  if (attachments.length === 0) return null

  return (
    <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
      {attachments.map((item) => (
        <button
          key={attachmentKey(item)}
          className="shrink-0 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-400/20"
          onClick={() => removeAttachment(item)}
          type="button"
        >
          {item.name} x
        </button>
      ))}
    </div>
  )
}
