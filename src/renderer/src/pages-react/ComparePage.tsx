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

  const leftIsSizeInPrompt = useMemo(() => {
    if (!leftModelKey) return false
    return models[leftModelKey]?.sizeStrategy === 'prompt'
  }, [models, leftModelKey])

  const rightIsSizeInPrompt = useMemo(() => {
    if (!rightModelKey) return false
    return models[rightModelKey]?.sizeStrategy === 'prompt'
  }, [models, rightModelKey])

  const showSizeHint = leftIsSizeInPrompt || rightIsSizeInPrompt

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
    const { leftResult, rightResult } = useCompareStore.getState()
    if (leftResult || rightResult) {
      addToast({ message: '对比生成完成', type: 'success' })
    }
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

      {showSizeHint && (
        <div className="px-4 py-2 bg-zinc-800/60 border-2 border-zinc-700 text-sm text-zinc-400">
          <span className="text-cyberpunk-yellow font-bold">⚡</span>
          <span className="ml-2">
            {leftIsSizeInPrompt && rightIsSizeInPrompt
              ? '两侧模型均为尺寸自适应，如需指定尺寸请在提示词中描述'
              : `${leftIsSizeInPrompt ? '左侧' : '右侧'}模型尺寸自适应，如需指定尺寸请在提示词中描述`}
          </span>
        </div>
      )}

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
