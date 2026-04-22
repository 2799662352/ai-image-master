const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

interface RatioSelectorProps {
  value: string
  onChange: (ratio: string) => void
  hidden?: boolean
}

export function RatioSelector({ value, onChange, hidden }: RatioSelectorProps) {
  if (hidden) {
    return (
      <div className="px-4 py-3 bg-zinc-800/60 border-2 border-zinc-700 text-sm text-zinc-400">
        <span className="text-cyberpunk-yellow font-bold">⚡ 尺寸自适应</span>
        <span className="ml-2">该模型无需选择尺寸。如需指定，请在提示词中描述，例如：</span>
        <span className="text-zinc-300">"横版 16:9 电影画幅"、"竖版 9:16 手机海报"、"1024×1024 方图"</span>
      </div>
    )
  }

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
