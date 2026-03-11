interface ProgressBarProps {
  percentage: number
  variant?: 'default' | 'fast'
}

export function ProgressBar({ percentage, variant = 'default' }: ProgressBarProps) {
  const gradient = variant === 'fast'
    ? 'linear-gradient(90deg, #F59E0B, #EF4444)'
    : 'linear-gradient(90deg, #3B82F6, #8B5CF6)'

  return (
    <div className="h-2 bg-white bg-opacity-20 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{ width: `${percentage}%`, background: gradient }}
      />
    </div>
  )
}
