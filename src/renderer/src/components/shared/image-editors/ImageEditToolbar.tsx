import { useState } from 'react'
import { useUIPrefsStore } from '../../../stores/useUIPrefsStore'
import { buildPanoramaPrompt } from './prompts'

interface Props {
  theme: 'punk' | 'default'
  imageUrl: string
  onOpenEditor: (type: 'angle' | 'light' | 'panorama' | 'director') => void
  /** 提供后,工具栏出现「生成全景」一键(基于当前图 img2img 注入 360 提示词)。 */
  onInjectPrompt?: (prompt: string) => void
  /**
   * 提供后,工具栏出现「加为参考图」一键 —— 把当前结果图回灌到参考图。
   * 返回 Promise<boolean>:成功 true / 已满或失败 false。用于按钮反馈。
   */
  onAddReference?: (imageUrl: string) => boolean | Promise<boolean>
}

export default function ImageEditToolbar({ theme, imageUrl, onOpenEditor, onInjectPrompt, onAddReference }: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const [refState, setRefState] = useState<'idle' | 'done' | 'full'>('idle')
  if (!enabled || !imageUrl) return null

  const isPunk = theme === 'punk'

  const btnClass = isPunk
    ? 'p-sticker'
    : 'rounded-md bg-zinc-700 hover:bg-zinc-600 text-white'

  const wrapClass = isPunk
    ? 'border-2 border-[var(--punk-black)] bg-[var(--punk-cream)]'
    : 'bg-zinc-800 border border-zinc-600 rounded-lg'

  const baseBtn = `px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`

  const handleAddRef = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onAddReference) return
    const ok = await onAddReference(imageUrl)
    setRefState(ok ? 'done' : 'full')
    setTimeout(() => setRefState('idle'), 1400)
  }

  return (
    <div
      className={`absolute top-1 left-1/2 -translate-x-1/2 z-20 flex flex-wrap justify-center gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity ${wrapClass}`}
      style={{ pointerEvents: 'auto', maxWidth: '94%' }}
    >
      <button
        type="button"
        className={baseBtn}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('angle') }}
      >
        多角度
      </button>
      <button
        type="button"
        className={baseBtn}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('light') }}
      >
        打光
      </button>
      <button
        type="button"
        className={baseBtn}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('panorama') }}
      >
        全景
      </button>
      {onInjectPrompt && (
        <button
          type="button"
          className={baseBtn}
          onClick={(e) => {
            e.stopPropagation()
            // 全景图基于当前图 img2img 生成 —— 这张图本身就是「参考图」的一部分,
            // 所以点「生成全景」的同时把它载入参考图(否则后端拿不到参考,生成会跑偏)。
            if (onAddReference) {
              const r = onAddReference(imageUrl)
              Promise.resolve(r).then((ok) => {
                setRefState(ok ? 'done' : 'full')
                setTimeout(() => setRefState('idle'), 1400)
              })
            }
            onInjectPrompt(buildPanoramaPrompt('img'))
          }}
          title="把当前图载入参考图,并基于它生成 360° 全景"
        >
          生成全景
        </button>
      )}
      <button
        type="button"
        className={baseBtn}
        onClick={(e) => { e.stopPropagation(); onOpenEditor('director') }}
        title="把当前图作为全景背景进入 3D 导演台"
      >
        导演台
      </button>
      {onAddReference && (
        <button
          type="button"
          className={baseBtn}
          onClick={handleAddRef}
          title="把这张图加入参考图"
        >
          {refState === 'done' ? '✓ 已加入' : refState === 'full' ? '参考图已满' : '加为参考图'}
        </button>
      )}
    </div>
  )
}
