interface ResultGridProps {
  urls: string[]
}

export function ResultGrid({ urls }: ResultGridProps) {
  if (urls.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-4">
      {urls.map((url, i) => (
        <div key={i} className="bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
          <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
        </div>
      ))}
    </div>
  )
}
