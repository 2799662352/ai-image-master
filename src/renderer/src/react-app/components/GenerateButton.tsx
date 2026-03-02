import { useDirectorStore } from '../stores/useDirectorStore'

interface GenerateButtonProps {
  onGenerate: () => void
}

export function GenerateButton({ onGenerate }: GenerateButtonProps) {
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const hasImages = useDirectorStore((s) => s.referenceImages.length > 0)
  const disabled = isGenerating || !hasImages

  return (
    <button
      onClick={onGenerate}
      disabled={disabled}
      className="w-full py-3 rounded-none bg-[#FCE300] text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
    >
      {isGenerating ? (
        <>
          <i className="fas fa-spinner fa-spin" />
          生成中…
        </>
      ) : (
        <>
          <i className="fas fa-magic" />
          一键生成漫画分镜
        </>
      )}
    </button>
  )
}
