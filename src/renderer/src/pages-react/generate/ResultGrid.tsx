import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'

interface ResultGridProps {
  urls: string[]
  onOpenEditor?: (url: string, type: 'angle' | 'light') => void
}

export function ResultGrid({ urls, onOpenEditor }: ResultGridProps) {
  if (urls.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-4">
      {urls.map((url, i) => (
        <div key={i} className="group relative bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
          <ImageEditToolbar
            theme="default"
            imageUrl={url}
            onOpenEditor={(type) => onOpenEditor?.(url, type)}
          />
          <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
        </div>
      ))}
    </div>
  )
}
