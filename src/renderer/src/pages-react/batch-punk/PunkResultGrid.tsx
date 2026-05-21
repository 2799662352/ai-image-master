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

/**
 * 触发图片下载。优先 fetch->blob 走文件流(强制 download 属性生效);
 * 跨域失败时回落到打开新标签页 (浏览器至少能保存)。
 */
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
  const slug = prompt
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .trim()
    .slice(0, 24)
    .replace(/\s+/g, '_') || 'untitled'
  const ts = Date.now()
  const seq = String(index + 1).padStart(3, '0')
  return `batch-${seq}-${slug}-${ts}.png`
}

const STATUS_BADGE: Record<BatchItem['status'], { cls: string; label: string }> = {
  pending:    { cls: 'p-badge--wait', label: 'WAIT' },
  generating: { cls: 'p-badge--run',  label: 'RUN' },
  done:       { cls: 'p-badge--ok',   label: 'OK' },
  error:      { cls: 'p-badge--err',  label: 'ERR' },
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
  const tilt = index % 4
  const tiltClass = ['p-tilt-l-2', 'p-tilt-r-2', 'p-tilt-l-3', 'p-tilt-r-3'][tilt]
  const badge = STATUS_BADGE[item.status]
  const isFail = item.status === 'error'
  const isRun = item.status === 'generating'
  const displayUrl = item.resultUrl ?? item.cosUrl
  const isDone = item.status === 'done' && !!displayUrl
  const upload = item.uploadStatus

  return (
    <div
      className={`p-sticker ${tiltClass}`}
      style={{
        background: isFail ? 'var(--punk-red)' : 'var(--punk-cream)',
        color: isFail ? 'var(--punk-cream)' : 'var(--punk-black)',
        padding: '0.6rem 0.7rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* 顶部 row: 序号 + 状态 + 删除 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span
          className="p-mono"
          style={{
            fontSize: 10,
            fontWeight: 900,
            background: 'var(--punk-black)',
            color: 'var(--punk-pink)',
            padding: '1px 5px',
          }}
        >
          #{String(index + 1).padStart(3, '0')}
        </span>
        <span className={`p-badge ${badge.cls}`}>{badge.label}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {isDone && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                downloadImage(displayUrl!, buildFilename(index, item.prompt))
              }}
              aria-label="下载图片"
              title="下载"
              className="p-mono"
              style={{
                width: 22,
                height: 22,
                border: '2px solid var(--punk-black)',
                background: 'var(--punk-toxic)',
                color: 'var(--punk-black)',
                fontWeight: 900,
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              }}
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label="移除"
            title="移除"
            style={{
              width: 22,
              height: 22,
              border: '2px solid var(--punk-black)',
              background: 'var(--punk-cream)',
              color: 'var(--punk-black)',
              fontWeight: 900,
              fontSize: 14,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* 缩略图 / 占位 */}
      <div
        className="group relative"
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--punk-black)',
          border: '3px solid var(--punk-black)',
          overflow: 'hidden',
          cursor: isDone ? 'zoom-in' : 'default',
        }}
        onClick={() => isDone && onPreview?.(displayUrl!)}
      >
        {isDone && (
          <ImageEditToolbar
            theme="punk"
            imageUrl={displayUrl!}
            onOpenEditor={(type) => onOpenEditor?.(displayUrl!, type)}
          />
        )}
        {isDone && (
          <img
            src={displayUrl}
            alt={item.prompt}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
        {isRun && (
          <div
            className="p-display"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--punk-cyan)',
              fontSize: 13,
              gap: 6,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                border: '4px solid var(--punk-cyan)',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'punk-spin 1s linear infinite',
              }}
            />
            <span className="p-mono">GENERATING</span>
          </div>
        )}
        {item.status === 'pending' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--punk-cream)',
              fontSize: 36,
              opacity: 0.6,
            }}
            className="p-jp"
          >
            待
          </div>
        )}
        {isFail && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--punk-cream)',
              gap: 4,
              padding: 8,
            }}
          >
            <span style={{ fontSize: 36, fontWeight: 900 }}>✗</span>
            <span
              className="p-mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                textAlign: 'center',
                lineHeight: 1.3,
                opacity: 0.85,
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {item.error || 'FAILED'}
            </span>
          </div>
        )}
        {/* 漫画式角章 */}
        {isDone && (
          <span
            aria-hidden="true"
            className="p-mono p-tilt-r-5"
            style={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              background: 'var(--punk-toxic)',
              color: 'var(--punk-black)',
              padding: '1px 4px',
              fontSize: 9,
              fontWeight: 900,
              border: '1.5px solid var(--punk-black)',
            }}
          >
            DONE
          </span>
        )}
        {/* 异步存储状态角标 — 漫画风 */}
        {isDone && upload === 'uploading' && (
          <span
            className="p-mono"
            title="正在异步上传到腾讯云 COS…"
            style={{
              position: 'absolute',
              bottom: 4,
              left: 4,
              background: 'var(--punk-black)',
              color: 'var(--punk-toxic)',
              padding: '1px 4px',
              fontSize: 9,
              fontWeight: 900,
              border: '1.5px solid var(--punk-toxic)',
            }}
          >
            UP…
          </span>
        )}
        {isDone && upload === 'uploaded' && (
          <span
            className="p-mono"
            title="当前显示的是 COS 持久化 URL"
            style={{
              position: 'absolute',
              bottom: 4,
              left: 4,
              background: 'var(--punk-black)',
              color: 'var(--punk-cyan)',
              padding: '1px 4px',
              fontSize: 9,
              fontWeight: 900,
              border: '1.5px solid var(--punk-cyan)',
            }}
          >
            COS
          </span>
        )}
        {isDone && upload === 'failed' && (
          <span
            className="p-mono"
            title={`COS 转存失败: ${item.uploadError || '未知原因'}\n当前展示模型直出 URL,可能短期内会过期`}
            style={{
              position: 'absolute',
              bottom: 4,
              left: 4,
              background: 'var(--punk-red)',
              color: 'var(--punk-cream)',
              padding: '1px 4px',
              fontSize: 9,
              fontWeight: 900,
              border: '1.5px solid var(--punk-cream)',
            }}
          >
            !COS
          </span>
        )}
      </div>

      {/* prompt 文字 (truncate) */}
      <p
        className="p-mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          margin: 0,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: 1.3,
          minHeight: '2.6em',
        }}
      >
        {item.prompt}
      </p>

      {item.error && !isFail && (
        <p
          className="p-mono"
          style={{
            fontSize: 10,
            color: 'var(--punk-red)',
            fontWeight: 900,
            margin: 0,
            wordBreak: 'break-word',
          }}
        >
          ERR: {item.error}
        </p>
      )}
    </div>
  )
}

/**
 * PunkResultGrid - 任务卡片网格 + 全局 spin keyframe
 */
export default function PunkResultGrid({ items, onRemove, onPreview }: Props) {
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
      <div
        className="p-sticker p-tilt-l-2"
        style={{
          marginTop: 24,
          padding: '2rem 1.5rem',
          textAlign: 'center',
          background: 'var(--punk-cream)',
        }}
      >
        <div
          className="p-jp"
          style={{ fontSize: 56, color: 'var(--punk-pink-deep)', opacity: 0.5 }}
        >
          無
        </div>
        <div className="p-display" style={{ fontSize: 18, marginTop: 8 }}>
          NO TASKS YET
        </div>
        <div className="p-mono" style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>
          // 在上方输入提示词, 按 GENERATE 启动批量生成
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes punk-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{ marginTop: 22, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div
            className="p-callout p-tilt-l-3"
            style={{ display: 'inline-block', fontSize: 13 }}
          >
            // RESULTS // {items.length} TASKS // OK {doneItems.length} · ERR {failedItems.length} //
          </div>
          <button
            type="button"
            onClick={() => setReversed((v) => !v)}
            className="p-mono"
            style={{
              fontSize: 11,
              fontWeight: 900,
              padding: '3px 10px',
              border: '2px solid var(--punk-black)',
              background: reversed ? 'var(--punk-pink)' : 'var(--punk-cream)',
              color: reversed ? 'var(--punk-cream)' : 'var(--punk-black)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {reversed ? '↑ 新→旧' : '↓ 旧→新'}
          </button>
        </div>

        {failedItems.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 14px',
              background: 'var(--punk-red)',
              border: '4px solid var(--punk-black)',
              boxShadow: '5px 5px 0 var(--punk-cream)',
            }}
          >
            <div className="p-display" style={{ fontSize: 14, color: 'var(--punk-cream)', marginBottom: 4 }}>
              ⚠ {failedItems.length} 项生成失败
            </div>
            <p
              className="p-mono"
              style={{ fontSize: 11, color: 'var(--punk-cream)', opacity: 0.85, margin: 0, lineHeight: 1.4 }}
            >
              {failedItems[0]?.error || '生成请求失败'}
              {failedItems.length > 1 && ` (+${failedItems.length - 1} more)`}
            </p>
            <p
              className="p-mono"
              style={{ fontSize: 10, color: 'var(--punk-cream)', opacity: 0.6, margin: '6px 0 0', lineHeight: 1.3 }}
            >
              建议：检查网络连接，或在顶部切换绘图模型后重新生成
            </p>
          </div>
        )}
        <div
          className="p-scroll"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 16,
          }}
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
          theme="punk"
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}
