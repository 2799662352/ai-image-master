import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const readOnlyExtensions = [EditorView.editable.of(false), EditorState.readOnly.of(true)]

export function DiffMergeView({ disk, mine }: { disk: string; mine: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return undefined
    const view = new MergeView({
      a: { doc: disk, extensions: readOnlyExtensions },
      b: { doc: mine, extensions: readOnlyExtensions },
      parent: ref.current,
    })
    return () => view.destroy()
  }, [disk, mine])
  return <div ref={ref} className="h-full overflow-auto text-xs" />
}
