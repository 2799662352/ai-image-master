import type { TimelineItem } from '../../../../types/agent-timeline'
import { AttachmentCard } from './cards/AttachmentCard'
import { ArtifactCard } from './cards/ArtifactCard'
import { FileEditCard } from './cards/FileEditCard'
import { ReasoningCard } from './cards/ReasoningCard'
import { ShellCard } from './cards/ShellCard'
import { TextCard } from './cards/TextCard'

export function TimelineItemRenderer({
  item,
  onImageDoubleClick,
}: {
  item: TimelineItem
  onImageDoubleClick?: (attachmentId: string) => void
}) {
  switch (item.type) {
    case 'text':
      return <TextCard item={item} />
    case 'reasoning':
      return <ReasoningCard item={item} />
    case 'shell':
      return <ShellCard item={item} />
    case 'fileEdit':
      return <FileEditCard item={item} />
    case 'attachment':
      return <AttachmentCard item={item} onImageDoubleClick={onImageDoubleClick} />
    case 'artifact':
      return <ArtifactCard item={item} onImageDoubleClick={onImageDoubleClick} />
    default: {
      const _exhaustive: never = item
      void _exhaustive
      return null
    }
  }
}
