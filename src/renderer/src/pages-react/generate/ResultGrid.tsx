import { useState } from 'react'
import type { ResultUploadMeta } from '../../stores/useGenerateStore'
import { useGenerateStore } from '../../stores/useGenerateStore'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
import { addImageUrlToReferences } from '../../components/shared/image-editors/referenceTargets'

/**
 * 单格图片 —— 把 `<img>` 抽成独立组件,只为了能在循环里安全调 useDisplaySrc:
 * 钩子不能在 .map() 回调里直接调。每个 cell 自己持有它那一张的 blob URL 生命周期,
 * 切换/卸载时自动 revoke,互不干扰。
 */
function ResultCell({ url, alt }: { url: string; alt: string }) {
  const imgSrc = useDisplaySrc(url)
  return <img src={imgSrc} alt={alt} className="w-full object-contain" />
}

interface ResultGridProps {
  /**
   * 展示用 URL 列表。已经经过 store 层的热切:
   * - 异步上传完成后,这里的元素会被替换成 cosUrl(持久化)
   * - 上传中/失败时,这里仍是 modelUrl(临时签名)
   *
   * UI 不用关心这个细节,直接渲染即可。
   */
  urls: string[]
  /**
   * 与 `urls` 一一对齐(同索引)的元数据。用于角标提示上传状态 + 重编辑快照。
   * 不传也能用 —— 兼容老调用方。
   */
  meta?: ResultUploadMeta[]
  /**
   * 点击 [重编辑] 按钮时被调用, 接收该结果对应的 snapshot。
   * 父组件负责把 snapshot 灌回 useGenerateStore + 把 tab 切到 generate。
   * 若不传或 meta[i].snapshot 不存在, 按钮自动隐藏(保持向后兼容)。
   */
  onEditFromResult?: (snapshot: NonNullable<ResultUploadMeta['snapshot']>) => void
  /**
   * 点击缩略图放大预览。父组件用同一份 urls + 该图索引打开共享 ImageLightbox,
   * 支持在结果集里左右切换。不传时缩略图不可点。
   */
  onPreview?: (index: number) => void
}

const UPLOAD_BADGE: Record<ResultUploadMeta['uploadStatus'], { cls: string; label: string; title: string }> = {
  uploading: {
    cls: 'bg-zinc-950/85 border border-cyberpunk-yellow/70 text-cyberpunk-yellow',
    label: 'up…',
    title: '正在异步上传到腾讯云 COS…',
  },
  uploaded: {
    cls: 'bg-emerald-950/85 border border-emerald-600/70 text-emerald-300',
    label: 'cos',
    title: '当前显示的是 COS 持久化 URL',
  },
  failed: {
    cls: 'bg-red-950/85 border border-red-600/70 text-red-300',
    label: '!cos',
    title: 'COS 转存失败,当前展示的是模型直出 URL(可能短期内会过期)',
  },
}

type EditorType = 'angle' | 'light' | 'panorama' | 'director'

export function ResultGrid({ urls, meta, onEditFromResult, onPreview }: ResultGridProps) {
  const [editorState, setEditorState] = useState<{ url: string; type: EditorType } | null>(null)

  // 注入 360 提示词 / 全景反推:追加到生成框 prompt 尾部。
  const injectPrompt = (p: string) => {
    const { prompt, setPrompt } = useGenerateStore.getState()
    setPrompt(prompt ? `${prompt}\n${p}` : p)
  }

  if (urls.length === 0) {
    return (
      <div className="border-2 border-dashed border-zinc-800 bg-zinc-950/40 py-16 px-4 text-center">
        <div className="font-orbitron text-base uppercase tracking-wider text-zinc-400">
          生成的图片将在这里显示
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          // 输入提示词,点"开始生成"后结果会在此处展示,点缩略图可放大预览
        </div>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-4">
      {urls.map((url, i) => {
        const m = meta?.[i]
        const badge = m ? UPLOAD_BADGE[m.uploadStatus] : null
        const snapshot = m?.snapshot
        const canEdit = !!(onEditFromResult && snapshot)
        return (
          <div
            key={m?.id ?? `${i}-${url}`}
            onClick={() => onPreview?.(i)}
            role={onPreview ? 'button' : undefined}
            tabIndex={onPreview ? 0 : undefined}
            onKeyDown={(e) => {
              if (onPreview && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                onPreview(i)
              }
            }}
            title={onPreview ? '点击放大预览' : undefined}
            className={`group relative bg-zinc-900 border-2 border-zinc-700 overflow-hidden ${
              onPreview ? 'cursor-zoom-in hover:border-cyberpunk-yellow transition-colors' : ''
            }`}
          >
            <ResultCell url={url} alt={`Result ${i + 1}`} />
            <ImageEditToolbar
              theme="default"
              imageUrl={url}
              onOpenEditor={(type) => setEditorState({ url, type })}
              onInjectPrompt={injectPrompt}
              onAddReference={(u) => addImageUrlToReferences('generate', u)}
            />
            {badge && (
              <span
                aria-label={badge.title}
                title={m?.uploadError ? `${badge.title}: ${m.uploadError}` : badge.title}
                className={`absolute bottom-1 left-1 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${badge.cls}`}
              >
                {badge.label}
              </span>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onEditFromResult!(snapshot!)
                }}
                title="把这张图的 prompt / 参考图 / 比例回灌到表单"
                className="absolute top-1 right-1 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider bg-zinc-950/85 text-cyberpunk-yellow border border-cyberpunk-yellow/70 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-cyberpunk-yellow hover:text-cyberpunk-black"
              >
                ↺ 重编辑
              </button>
            )}
          </div>
        )
      })}
      {editorState && (
        <ImageEditorModal
          key={editorState.type}
          editorType={editorState.type}
          imageUrl={editorState.url}
          theme="default"
          directorEntry={editorState.type === 'director' ? 'panorama' : 'native'}
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
    </div>
  )
}
