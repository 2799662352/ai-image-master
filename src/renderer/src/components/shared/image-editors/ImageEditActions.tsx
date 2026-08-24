import { useState } from 'react'
import { buildPanoramaPrompt } from './prompts'

export type ImageEditorType = 'angle' | 'light' | 'panorama' | 'director'

interface Props {
  theme: 'punk' | 'default'
  imageUrl: string
  onOpenEditor: (type: ImageEditorType) => void
  /** 提供后,出现「生成全景」一键(基于当前图 img2img 注入 360 提示词)。 */
  onInjectPrompt?: (prompt: string) => void
  /**
   * 提供后,出现「加为参考图」一键 —— 把当前结果图回灌到参考图。
   * 返回 Promise<boolean>:成功 true / 已满或失败 false。用于按钮反馈。
   */
  onAddReference?: (imageUrl: string) => boolean | Promise<boolean>
  /**
   * 提供后,出现「图层分离」一键 —— 把**这一张**拆成底图 + 透明图层栈。
   *
   * 挂在这里而不是生成表单上:这个动作的对象是「一张已经存在的图」,不是
   * 「一次新生成」。表单那条路要先把图重新传成参考图才能拆,而结果区里点一下
   * 就够了。宿主不接就不显示(同 onInjectPrompt / onAddReference 的约定)。
   */
  onLayerSplit?: (imageUrl: string) => void
}

/**
 * ImageEditActions — 图片编辑动作按钮行(多角度/打光/全景/生成全景/导演台/
 * 加为参考图)。纯按钮,不带定位/悬停逻辑,由宿主决定摆放:
 *  - ImageEditToolbar: 缩略图悬停浮层(Generate / 历史等页)
 *  - ImageLightbox renderActions: 点击放大后的预览层(Batch 页)
 */
export default function ImageEditActions({ theme, imageUrl, onOpenEditor, onInjectPrompt, onAddReference, onLayerSplit }: Props) {
  const [refState, setRefState] = useState<'idle' | 'done' | 'full'>('idle')
  if (!imageUrl) return null

  const isPunk = theme === 'punk'
  const btnClass = isPunk
    ? 'p-sticker'
    : 'rounded-md bg-zinc-700 hover:bg-zinc-600 text-white'
  const baseBtn = `px-2 py-0.5 text-[11px] font-bold cursor-pointer ${btnClass}`

  const handleAddRef = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onAddReference) return
    const ok = await onAddReference(imageUrl)
    setRefState(ok ? 'done' : 'full')
    setTimeout(() => setRefState('idle'), 1400)
  }

  return (
    <>
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
      {onLayerSplit && (
        <button
          type="button"
          className={baseBtn}
          onClick={(e) => { e.stopPropagation(); onLayerSplit(imageUrl) }}
          title="把这张图拆成底图 + 透明图层（Seedream 5.0 Pro，按张计费，最多 17 张）"
        >
          图层分离
        </button>
      )}
    </>
  )
}
