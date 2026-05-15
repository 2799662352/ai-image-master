import { useState } from 'react'
import type { BatchItem } from '../../stores/useBatchStore'
import { useBatchStore } from '../../stores/useBatchStore'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
import '../../components/shared/image-editors/image-editors.css'

interface Props {
  items: BatchItem[]
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
}

async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  } catch {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

function buildFilename(index: number, prompt: string): string {
  const slug =
    prompt
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 24)
      .replace(/\s+/g, '_') || 'untitled'
  const ts = Date.now()
  const seq = String(index + 1).padStart(3, '0')
  return `batch-${seq}-${slug}-${ts}.png`
}

const STATUS_BADGE: Record<
  BatchItem['status'],
  { cls: string; label: string }
> = {
  pending:    { cls: 'border-zinc-700 text-zinc-400 bg-zinc-900',                          label: 'WAIT' },
  generating: { cls: 'border-cyberpunk-yellow/50 text-cyberpunk-yellow bg-cyberpunk-yellow/10', label: 'RUN' },
  done:       { cls: 'border-green-700/60 text-green-300 bg-green-950/30',                 label: 'OK' },
  error:      { cls: 'border-red-700/60 text-red-300 bg-red-950/30',                       label: 'ERR' },
}

function ResultCard({
  item,
  index,
  onRemove,
  onPreview,
  onOpenEditor,
}: {
  item: BatchItem
  index: number
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
  onOpenEditor?: (url: string, type: 'angle' | 'light') => void
}) {
  const badge = STATUS_BADGE[item.status]
  const isFail = item.status === 'error'
  const isRun = item.status === 'generating'
  const isDone = item.status === 'done' && item.resultUrl

  return (
    <div
      className={`flex flex-col gap-1.5 p-2 border-2 ${
        isFail ? 'border-red-700/60 bg-red-950/20' : 'border-zinc-700 bg-zinc-900/60'
      }`}
    >
      {/* 顶部 row: 序号 + 状态 + 操作 */}
      <div className="flex items-center justify-between gap-1.5">
        <span className="px-1.5 py-0.5 bg-zinc-950 text-cyberpunk-yellow font-mono text-[10px] font-bold tabular-nums">
          #{String(index + 1).padStart(3, '0')}
        </span>
        <span
          className={`px-1.5 py-0.5 border font-mono text-[10px] font-bold uppercase tracking-wider ${badge.cls}`}
        >
          {badge.label}
        </span>
        <div className="ml-auto flex gap-1">
          {isDone && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                downloadImage(item.resultUrl!, buildFilename(index, item.prompt))
              }}
              aria-label="下载图片"
              title="下载"
              className="w-5 h-5 flex items-center justify-center border border-zinc-700 bg-zinc-900 text-cyberpunk-yellow hover:bg-cyberpunk-yellow hover:text-cyberpunk-black text-sm font-bold leading-none transition-colors"
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label="移除"
            title="移除"
            className="w-5 h-5 flex items-center justify-center border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-red-900/50 hover:text-red-200 hover:border-red-700/60 text-sm font-bold leading-none transition-colors"
          >
            ×
          </button>
        </div>
      </div>

      {/* 缩略图 / 占位 */}
      <div
        className={`group relative aspect-square bg-zinc-950 border-2 border-zinc-800 overflow-hidden ${
          isDone ? 'cursor-zoom-in' : ''
        }`}
        onClick={() => isDone && onPreview?.(item.resultUrl!)}
      >
        {isDone && (
          <ImageEditToolbar
            theme="default"
            imageUrl={item.resultUrl!}
            onOpenEditor={(type) => onOpenEditor?.(item.resultUrl!, type)}
          />
        )}
        {isDone && (
          <img
            src={item.resultUrl}
            alt={item.prompt}
            loading="lazy"
            className="w-full h-full object-cover block"
          />
        )}
        {isRun && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-cyberpunk-yellow text-xs font-mono uppercase tracking-wider">
            <div
              className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full"
              style={{ animation: 'batch-spin 1s linear infinite' }}
            />
            <span>生成中</span>
          </div>
        )}
        {item.status === 'pending' && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-600 font-mono text-xs uppercase tracking-wider">
            等待
          </div>
        )}
        {isFail && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-red-300 text-center">
            <span className="text-3xl font-bold leading-none">✗</span>
            <span className="font-mono text-[10px] leading-tight line-clamp-3 break-words">
              {item.error || 'FAILED'}
            </span>
          </div>
        )}
        {isDone && (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 px-1 py-px bg-green-900/80 text-green-200 font-mono text-[9px] font-bold uppercase tracking-wider"
          >
            done
          </span>
        )}
      </div>

      {/* prompt 文字 */}
      <p className="font-mono text-[11px] text-zinc-300 leading-snug line-clamp-2 min-h-[2.6em] break-words m-0">
        {item.prompt}
      </p>

      {item.error && !isFail && (
        <p className="font-mono text-[10px] text-red-400 break-words m-0">
          ERR: {item.error}
        </p>
      )}
    </div>
  )
}

/**
 * BatchResultGrid - 结果网格
 * 替代 PunkResultGrid 的米白 sticker + 倾斜 + 漫画式 P5 装饰。
 */
export default function BatchResultGrid({ items, onRemove, onPreview }: Props) {
  const [editorState, setEditorState] = useState<{ url: string; type: 'angle' | 'light' } | null>(null)
  const [reversed, setReversed] = useState(true)

  const injectPrompt = (p: string) => {
    const { mode, cardPrompt, multiText, setCardPrompt, setMultiText } = useBatchStore.getState()
    if (mode === 'card') setCardPrompt(cardPrompt + '\n' + p)
    else setMultiText(multiText + '\n' + p)
  }

  const failedItems = items.filter((i) => i.status === 'error')
  const doneItems = items.filter((i) => i.status === 'done')
  const displayItems = reversed ? [...items].reverse() : items

  if (items.length === 0) {
    return (
      <div className="border-2 border-dashed border-zinc-800 bg-zinc-950/40 py-10 px-4 text-center">
        <div className="font-orbitron text-base uppercase tracking-wider text-zinc-400">
          暂无任务
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          // 在上方输入提示词,按"开始生成"启动批量
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes batch-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            // RESULTS · {items.length} 任务 · OK {doneItems.length} · ERR {failedItems.length}
          </div>
          <button
            type="button"
            onClick={() => setReversed((v) => !v)}
            className={`px-2 py-1 border-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              reversed
                ? 'border-cyberpunk-yellow bg-cyberpunk-yellow text-cyberpunk-black'
                : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {reversed ? '↑ 新→旧' : '↓ 旧→新'}
          </button>
        </div>

        {failedItems.length > 0 && (
          <div className="px-3 py-2 border-2 border-red-700/60 bg-red-950/30 text-red-300">
            <div className="font-orbitron text-sm uppercase tracking-wider">
              ⚠ {failedItems.length} 项生成失败
            </div>
            <p className="mt-1 font-mono text-[11px] text-red-300/80 leading-snug">
              {failedItems[0]?.error || '生成请求失败'}
              {failedItems.length > 1 && ` (+${failedItems.length - 1} more)`}
            </p>
            <p className="mt-1 font-mono text-[10px] text-red-300/60 leading-snug">
              建议:检查网络连接,或在顶部切换绘图模型后重新生成
            </p>
          </div>
        )}

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
        >
          {displayItems.map((item) => {
            const origIdx = items.indexOf(item)
            return (
              <ResultCard
                key={item.id}
                item={item}
                index={origIdx}
                onRemove={onRemove}
                onPreview={onPreview}
                onOpenEditor={(url, type) => setEditorState({ url, type })}
              />
            )
          })}
        </div>
      </div>
      {editorState && (
        <ImageEditorModal
          key={editorState.type}
          editorType={editorState.type}
          imageUrl={editorState.url}
          theme="default"
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}
