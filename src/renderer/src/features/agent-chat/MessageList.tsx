import { forwardRef, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react'
import 'overlayscrollbars/overlayscrollbars.css'
import { AttachmentChips } from './AttachmentChips'
import { CodexApprovalPrompt } from './CodexApprovalPrompt'
import { MentionInput } from './MentionInput'
import { MessageBubble } from './MessageBubble'
import { NoticesBanner } from './NoticesBanner'
import type { Message } from '../../../../types/agent-timeline'
import type { CodexApprovalRequest } from '../../../../../types/agent'

type ApprovalResponse = {
  id: string
  approved: boolean
  message?: string
}

type MessageListProps = {
  threadId: string | undefined
  messages: Message[]
  editingMessageId: string | undefined
  pendingApprovals: CodexApprovalRequest[]
  error: string | undefined
  onRespondApproval: (response: ApprovalResponse) => void
}

// Wraps OverlayScrollbarsComponent so it can plug into Virtuoso's
// `Scroller` slot. Virtuoso forwards `style` + scroll-related props to
// the scroller element; we relay them to the OS host element so the
// virtualizer keeps owning measurement while OS owns the chrome.
const OverlayScrollbarsScroller = forwardRef<
  HTMLDivElement,
  ComponentProps<'div'> & { children?: ReactNode }
>(function OverlayScrollbarsScroller({ children, style, ...rest }, ref) {
  return (
    <OverlayScrollbarsComponent
      element="div"
      style={style}
      options={{
        scrollbars: {
          theme: 'os-theme-dark',
          autoHide: 'leave',
          autoHideDelay: 800,
          clickScroll: true,
        },
      }}
      defer
    >
      <div ref={ref} {...rest} style={{ height: '100%' }}>
        {children}
      </div>
    </OverlayScrollbarsComponent>
  )
})

function ChatListHeader({
  pendingApprovals,
  onRespond,
}: {
  pendingApprovals: CodexApprovalRequest[]
  onRespond: (response: ApprovalResponse) => void
}) {
  return (
    <div className="px-4 pt-4">
      <NoticesBanner />
      {pendingApprovals.length > 0 ? (
        <div className="mb-3 space-y-3">
          {pendingApprovals.map((request) => (
            <CodexApprovalPrompt
              key={request.id}
              request={request}
              onRespond={onRespond}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ChatEmptyPlaceholder() {
  return (
    <div className="px-4 py-4">
      <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4 text-sm text-zinc-300">
        Tell the agent what to create or inspect. It can call CATIMATION tools and use local Codex
        capabilities.
      </div>
    </div>
  )
}

function ChatErrorFooter({ error }: { error: string | undefined }) {
  if (!error) return null
  return (
    <div className="mx-4 mb-4 mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
      {error}
    </div>
  )
}

function InlineEditCard({ message }: { message: Message }) {
  return (
    <div
      key={message.id}
      className="my-3 rounded-lg border border-cyan-400/30 bg-zinc-950/60 p-3 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]"
    >
      <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-300/80">
        <span>Editing message</span>
        <span className="text-zinc-500 normal-case tracking-normal">
          Esc to cancel · ⌘/Ctrl+Enter to submit
        </span>
      </div>
      <AttachmentChips />
      <MentionInput />
    </div>
  )
}

export function MessageList(props: MessageListProps) {
  const { threadId, messages, editingMessageId, pendingApprovals, error, onRespondApproval } = props
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  return (
    <div
      key={threadId ?? '__no_thread__'}
      className="relative flex-1 min-h-0"
    >
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        computeItemKey={(_index, m) => (m as Message).id}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput="smooth"
        atBottomThreshold={48}
        atBottomStateChange={setAtBottom}
        components={{
          Scroller: OverlayScrollbarsScroller,
          Header: () => (
            <ChatListHeader pendingApprovals={pendingApprovals} onRespond={onRespondApproval} />
          ),
          Footer: () => <ChatErrorFooter error={error} />,
          EmptyPlaceholder: () => <ChatEmptyPlaceholder />,
        }}
        itemContent={(_index, message) => (
          <div className="px-4">
            {(message as Message).id === editingMessageId ? (
              <InlineEditCard message={message as Message} />
            ) : (
              <MessageBubble message={message as Message} />
            )}
          </div>
        )}
      />
      {!atBottom ? (
        <button
          type="button"
          aria-label="Scroll to latest message"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: 'LAST',
              align: 'end',
              behavior: 'smooth',
            })
          }
          className="absolute bottom-4 right-4 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-cyan-400/30 bg-zinc-950/85 text-cyan-200 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/10 hover:text-cyan-100"
        >
          ↓
        </button>
      ) : null}
    </div>
  )
}
