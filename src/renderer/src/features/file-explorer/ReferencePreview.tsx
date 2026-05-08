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
    case 'pdf':
      return (
        <div className="flex h-full flex-col gap-2 p-4 text-xs text-amber-200">
          <p>This reference points at a file but reached the synthetic-preview dispatcher.</p>
          <p className="opacity-70">Local-path file references should be delegated to the existing viewer.</p>
        </div>
      )
  }
}
