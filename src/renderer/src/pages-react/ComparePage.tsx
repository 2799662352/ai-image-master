import { useEffect, useMemo } from 'react'
import { useModelStore, useToastStore, useCompareStore } from '../stores'
import { useApi } from '../hooks/useService'
import { ModelPairSelector } from './compare/ModelPairSelector'

export default function ComparePage() {
  const api = useApi()
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const leftModelKey = useCompareStore((s) => s.leftModelKey)
  const rightModelKey = useCompareStore((s) => s.rightModelKey)
  const prompt = useCompareStore((s) => s.prompt)
  const comparing = useCompareStore((s) => s.comparing)
  const leftResult = useCompareStore((s) => s.leftResult)
  const rightResult = useCompareStore((s) => s.rightResult)
  const error = useCompareStore((s) => s.error)

  const { setLeftModel, setRightModel, setPrompt, compare } = useCompareStore.getState()

  const options = useMemo(
    () => Object.entries(models).map(([k, v]) => ({ value: k, label: v.name })),
    [models]
  )

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleCompare = async () => {
    if (!leftModelKey || !rightModelKey) {
      addToast({ message: '请选择两个模型', type: 'warning' })
      return
    }
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    await compare(api)
    addToast({ message: '对比生成完成', type: 'success' })
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🔍 模型对比</h1>

      <ModelPairSelector
        options={options}
        leftValue={leftModelKey}
        rightValue={rightModelKey}
        onLeftChange={setLeftModel}
        onRightChange={setRightModel}
      />

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
            <span className="text-zinc-600">
              {leftModelKey ? options.find((o) => o.value === leftModelKey)?.label ?? '左侧结果' : '左侧结果'}
            </span>
          )}
        </div>
        <div className="bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
          {rightResult ? (
            <img src={rightResult} alt="Right" className="max-w-full max-h-[500px] object-contain" />
          ) : (
            <span className="text-zinc-600">
              {rightModelKey ? options.find((o) => o.value === rightModelKey)?.label ?? '右侧结果' : '右侧结果'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
