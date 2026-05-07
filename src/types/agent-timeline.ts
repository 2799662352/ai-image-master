export interface BaseItem {
  id: string
  startedAt: number
  endedAt?: number
}

export interface TextItem extends BaseItem {
  type: 'text'
  content: string
}

export interface ReasoningItem extends BaseItem {
  type: 'reasoning'
  content: string
}

export interface ShellItem extends BaseItem {
  type: 'shell'
  command: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode?: number
}

export interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string
  added: number
  removed: number
}

export interface FileEditItem extends BaseItem {
  type: 'fileEdit'
  changes: FileChange[]
  totalAdded: number
  totalRemoved: number
}

export interface AttachmentRef {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  uri: string
  thumbnailUri?: string
}

export interface AttachmentItem extends BaseItem {
  type: 'attachment'
  attachments: AttachmentRef[]
}

export interface ArtifactItem extends BaseItem {
  type: 'artifact'
  artifacts: AttachmentRef[]
}

export type TimelineItem =
  | TextItem
  | ReasoningItem
  | ShellItem
  | FileEditItem
  | AttachmentItem
  | ArtifactItem

export interface Message {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  items: TimelineItem[]
}

export function getMessageText(msg: Message): string {
  return msg.items
    .filter((i): i is TextItem => i.type === 'text')
    .map((i) => i.content)
    .join('\n')
}

export function upsertItemInLastMessage<T extends TimelineItem>(
  messages: Message[],
  itemId: string,
  factory: () => T,
  patch: (item: T) => T,
): Message[] {
  if (messages.length === 0) return messages

  const lastIdx = messages.length - 1
  const lastMsg = messages[lastIdx]
  if (lastMsg.role !== 'assistant') return messages

  const itemIdx = lastMsg.items.findIndex((i) => i.id === itemId)
  let newItems: TimelineItem[]

  if (itemIdx >= 0) {
    newItems = [...lastMsg.items]
    newItems[itemIdx] = patch(newItems[itemIdx] as T)
  } else {
    newItems = [...lastMsg.items, factory()]
  }

  const updated = [...messages]
  updated[lastIdx] = { ...lastMsg, items: newItems }
  return updated
}
