import { useState, useCallback } from 'react'
import Select, { type SingleValue, type StylesConfig } from 'react-select'
import { useModelStore, useToastStore } from '../stores'

interface ModelOption {
  value: string
  label: string
}

const selectStyles: StylesConfig<ModelOption, false> = {
  control: (base) => ({ ...base, backgroundColor: '#27272A', borderColor: '#3F3F46', minHeight: 36 }),
  singleValue: (base) => ({ ...base, color: '#FCE300' }),
  menu: (base) => ({ ...base, backgroundColor: '#27272A', border: '1px solid #3F3F46' }),
  option: (base, s) => ({
    ...base,
    backgroundColor: s.isFocused ? 'rgba(252,227,0,0.1)' : 'transparent',
    color: s.isSelected ? '#FCE300' : '#e5e7eb',
  }),
  input: (base) => ({ ...base, color: '#e5e7eb' }),
}

export default function ComparePage() {
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const options: ModelOption[] = Object.entries(models).map(([k, v]) => ({ value: k, label: v.name }))

  const [leftModel, setLeftModel] = useState<ModelOption | null>(null)
  const [rightModel, setRightModel] = useState<ModelOption | null>(null)
  const [prompt, setPrompt] = useState('')
  const [comparing, setComparing] = useState(false)
  const [leftResult, setLeftResult] = useState<string | null>(null)
  const [rightResult, setRightResult] = useState<string | null>(null)

  const handleCompare = useCallback(async () => {
    if (!leftModel || !rightModel) {
      addToast({ message: '请选择两个模型', type: 'warning' })
      return
    }
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    setComparing(true)
    setLeftResult(null)
    setRightResult(null)
    try {
      const api = (window as any).aiImageAPI
      const [left, right] = await Promise.allSettled([
        api?.generateWithModel?.(leftModel.value, prompt),
        api?.generateWithModel?.(rightModel.value, prompt),
      ])
      if (left.status === 'fulfilled' && left.value?.urls?.[0]) setLeftResult(left.value.urls[0])
      if (right.status === 'fulfilled' && right.value?.urls?.[0]) setRightResult(right.value.urls[0])
      addToast({ message: '对比生成完成', type: 'success' })
    } catch {
      addToast({ message: '对比生成失败', type: 'error' })
    } finally {
      setComparing(false)
    }
  }, [leftModel, rightModel, prompt, addToast])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🔍 模型对比</h1>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-gray-400 mb-1 block">左侧模型</label>
          <Select<ModelOption>
            value={leftModel}
            onChange={(v: SingleValue<ModelOption>) => setLeftModel(v)}
            options={options}
            styles={selectStyles}
            placeholder="选择模型..."
          />
        </div>
        <div>
          <label className="text-sm text-gray-400 mb-1 block">右侧模型</label>
          <Select<ModelOption>
            value={rightModel}
            onChange={(v: SingleValue<ModelOption>) => setRightModel(v)}
            options={options}
            styles={selectStyles}
            placeholder="选择模型..."
          />
        </div>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="输入提示词..."
        rows={3}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      <button
        onClick={handleCompare}
        disabled={comparing}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {comparing ? '生成对比中...' : '开始对比'}
      </button>

      <div className="grid grid-cols-2 gap-4 min-h-[300px]">
        <div className="bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
          {leftResult ? (
            <img src={leftResult} alt="Left" className="max-w-full max-h-[500px] object-contain" />
          ) : (
            <span className="text-zinc-600">{leftModel?.label ?? '左侧结果'}</span>
          )}
        </div>
        <div className="bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
          {rightResult ? (
            <img src={rightResult} alt="Right" className="max-w-full max-h-[500px] object-contain" />
          ) : (
            <span className="text-zinc-600">{rightModel?.label ?? '右侧结果'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
