import { useState } from 'react'

interface ApiKeyInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  showToggle?: boolean
}

export function ApiKeyInput({
  value,
  onChange,
  placeholder = '请输入 API Key',
  label,
  showToggle = true,
}: ApiKeyInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-sm font-bold text-white">{label}</label>
      )}
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-3 pr-10 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        {showToggle && (
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-cyberpunk-yellow"
            onClick={() => setVisible(!visible)}
          >
            {visible ? '\u{1F648}' : '\u{1F441}\uFE0F'}
          </button>
        )}
      </div>
    </div>
  )
}
