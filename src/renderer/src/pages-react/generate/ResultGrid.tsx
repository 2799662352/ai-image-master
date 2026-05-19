import type { ResultUploadMeta } from '../../stores/useGenerateStore'

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

export function ResultGrid({ urls, meta, onEditFromResult }: ResultGridProps) {
  if (urls.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-4">
      {urls.map((url, i) => {
        const m = meta?.[i]
        const badge = m ? UPLOAD_BADGE[m.uploadStatus] : null
        const snapshot = m?.snapshot
        const canEdit = !!(onEditFromResult && snapshot)
        return (
          <div key={m?.id ?? `${i}-${url}`} className="group relative bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
            <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
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
                onClick={() => onEditFromResult!(snapshot!)}
                title="把这张图的 prompt / 参考图 / 比例回灌到表单"
                className="absolute top-1 right-1 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider bg-zinc-950/85 text-cyberpunk-yellow border border-cyberpunk-yellow/70 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-cyberpunk-yellow hover:text-cyberpunk-black"
              >
                ↺ 重编辑
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
