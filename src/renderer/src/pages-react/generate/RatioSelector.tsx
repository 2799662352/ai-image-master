const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

interface RatioSelectorProps {
  value: string
  onChange: (ratio: string) => void
}

export function RatioSelector({ value, onChange }: RatioSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {RATIOS.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-3 py-1.5 text-sm border-2 transition-colors ${
            value === r
              ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
              : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}
