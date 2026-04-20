import { useUIPrefsStore } from '../../../stores/useUIPrefsStore'

interface Props {
  theme: 'punk' | 'default'
  imageUrl: string
  onOpenEditor: (type: 'angle' | 'light') => void
}

export default function ImageEditToolbar({ theme, imageUrl, onOpenEditor }: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  if (!enabled || !imageUrl) return null

  const isPunk = theme === 'punk'

  const btnClass = isPunk
    ? 'p-sticker'
    : 'rounded-md bg-zinc-700 hover:bg-zinc-600 text-white'

  const wrapClass = isPunk
    ? 'border-2 border-[var(--punk-black)] bg-[var(--punk-cream)]'
    : 'bg-zinc-800 border border-zinc-600 rounded-lg'

  return (
    <div
      className={`absolute top-1 left-1/2 -translate-x-1/2 z-20 flex gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity ${wrapClass}`}
      style={{ pointerEvents: 'auto' }}
    >
      <button
        type="button"
        className={`px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('angle') }}
      >
        多角度
      </button>
      <button
        type="button"
        className={`px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('light') }}
      >
        打光
      </button>
    </div>
  )
}
