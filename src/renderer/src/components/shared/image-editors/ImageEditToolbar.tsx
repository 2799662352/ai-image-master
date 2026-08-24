import { useUIPrefsStore } from '../../../stores/useUIPrefsStore'
import ImageEditActions, { type ImageEditorType } from './ImageEditActions'

interface Props {
  theme: 'punk' | 'default'
  imageUrl: string
  onOpenEditor: (type: ImageEditorType) => void
  /** 提供后,工具栏出现「生成全景」一键(基于当前图 img2img 注入 360 提示词)。 */
  onInjectPrompt?: (prompt: string) => void
  /**
   * 提供后,工具栏出现「加为参考图」一键 —— 把当前结果图回灌到参考图。
   * 返回 Promise<boolean>:成功 true / 已满或失败 false。用于按钮反馈。
   */
  onAddReference?: (imageUrl: string) => boolean | Promise<boolean>
  /** 提供后,工具栏出现「图层分离」一键(把这一张拆成底图 + 透明图层栈)。 */
  onLayerSplit?: (imageUrl: string) => void
}

/**
 * ImageEditToolbar — 缩略图悬停浮层版的编辑动作工具栏。
 * 按钮本体在共享的 ImageEditActions 里;本组件只负责
 * 「hover 才显示 + 顶部居中定位 + UI 偏好开关」这层壳。
 */
export default function ImageEditToolbar({ theme, imageUrl, onOpenEditor, onInjectPrompt, onAddReference, onLayerSplit }: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  if (!enabled || !imageUrl) return null

  const isPunk = theme === 'punk'
  const wrapClass = isPunk
    ? 'border-2 border-[var(--punk-black)] bg-[var(--punk-cream)]'
    : 'bg-zinc-800 border border-zinc-600 rounded-lg'

  return (
    <div
      className={`absolute top-1 left-1/2 -translate-x-1/2 z-20 flex flex-wrap justify-center gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity ${wrapClass}`}
      style={{ pointerEvents: 'auto', maxWidth: '94%' }}
    >
      <ImageEditActions
        theme={theme}
        imageUrl={imageUrl}
        onOpenEditor={onOpenEditor}
        onInjectPrompt={onInjectPrompt}
        onAddReference={onAddReference}
        onLayerSplit={onLayerSplit}
      />
    </div>
  )
}
