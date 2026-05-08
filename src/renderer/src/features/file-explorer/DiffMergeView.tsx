import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorView } from '@codemirror/view'

export function DiffMergeView({ disk, mine }: { disk: string; mine: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return undefined
    const view = new MergeView({
      a: { doc: disk, extensions: [EditorView.editable.of(false)] },
      b: { doc: mine, extensions: [EditorView.editable.of(false)] },
      parent: ref.current,
    })
    return () => view.destroy()
  }, [disk, mine])
  return <div ref={ref} className="h-full overflow-auto text-xs" />
}
