import type { AgentReference } from '../../../../types/agent-reference'
import { JsonResourcePreview } from './JsonResourcePreview'
import { ShellOutputPreview } from './ShellOutputPreview'
import { UrlPreview } from './UrlPreview'

export function ReferencePreview({ reference }: { reference: AgentReference }) {
  switch (reference.openBehavior) {
    case 'url':
      return <UrlPreview reference={reference} />
    case 'shellOutput':
      return <ShellOutputPreview reference={reference} />
    case 'jsonResource':
    case 'diff':
      return <JsonResourcePreview reference={reference} />
    case 'code':
    case 'markdown':
    case 'image':
    case 'video':
    case 'pdf':
      // 走到这条分支意味着 openTab() 自己失败了 (文件被删 / 权限 / 路径不在 workspace
      // 也不在 attachments tree),需要给用户一个明确的兜底提示而不是白屏。
      return (
        <div className="flex h-full flex-col gap-2 p-4 text-xs text-amber-200">
          <p>This reference points at a file but reached the synthetic-preview dispatcher.</p>
          <p className="opacity-70">Local-path file references should be delegated to the existing viewer.</p>
        </div>
      )
    default:
      // 显式兜底:openBehavior 未来再扩(比如 'audio')时此处至少不会白屏,
      // 并在 dev console 留一条可定位的线索。
      // eslint-disable-next-line no-console
      if (typeof console !== 'undefined') console.warn('[ReferencePreview] unhandled openBehavior:', reference.openBehavior)
      return (
        <div className="flex h-full items-center justify-center p-4 text-xs text-zinc-400">
          Unsupported reference type.
        </div>
      )
  }
}
