import { useDirectorStore } from '../stores/useDirectorStore'

interface GenerateButtonProps {
  onGenerate: () => void
  onCancel: () => void
  onPause: () => void
  onResume: () => void
}

export function GenerateButton({ onGenerate, onCancel, onPause, onResume }: GenerateButtonProps) {
  const generationStatus = useDirectorStore((s) => s.generationStatus)
  const hasImages = useDirectorStore((s) => s.referenceImages.length > 0)

  if (generationStatus === 'running') {
    return (
      <div className="w-full flex gap-1">
        <button
          onClick={onPause}
          className="flex-1 py-3 rounded-none bg-amber-500 text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-amber-400 active:scale-95"
        >
          <i className="fas fa-pause" />
          暂停
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-none bg-red-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-red-500 active:scale-95"
        >
          <i className="fas fa-times" />
          取消
        </button>
      </div>
    )
  }

  if (generationStatus === 'paused') {
    return (
      <div className="w-full flex gap-1">
        <button
          onClick={onResume}
          className="flex-1 py-3 rounded-none bg-green-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-green-500 active:scale-95"
        >
          <i className="fas fa-play" />
          继续
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-none bg-red-600 text-white font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 hover:bg-red-500 active:scale-95"
        >
          <i className="fas fa-times" />
          取消
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={onGenerate}
      disabled={!hasImages}
      className="w-full py-3 rounded-none bg-[#FCE300] text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
    >
      <i className="fas fa-magic" />
      一键生成漫画分镜
    </button>
  )
}
