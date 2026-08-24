import { useState } from 'react'
import type { BatchItem } from '../../stores/useBatchStore'
import { useBatchStore } from '../../stores/useBatchStore'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
import {
  addImageUrlToReferences,
  toUpstreamFetchableImage,
} from '../../components/shared/image-editors/referenceTargets'
import { LayerStackViewer } from '../generate/LayerStackViewer'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
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

/**
 * 把同一次图层分离产出的卡片收成一张。
 *
 * 一次拆分最多 17 张,平铺开会让用户以为自己一次生成了 17 张图;而图层是按 bbox
 * 裁切放大的,平铺看就是一堆尺寸奇怪的碎片(502×484 的图标、1301×268 的文字条)。
 * 所以整组只出一张卡,封面用底图(zIndex 最小),点开进图层查看器。
 *
 * 未分组的普通项原样保留、顺序不变 —— 批量页的卡片顺序是用户的心智锚点。
 */
export interface BatchGridEntry {
  item: BatchItem
  /** 图层组的全部成员(含底图),按入队序;非图层组为 undefined。 */
  group?: BatchItem[]
}

export function groupBatchItems(items: BatchItem[]): BatchGridEntry[] {
  const out: BatchGridEntry[] = []
  const at = new Map<string, number>()

  for (const item of items) {
    const gid = item.layerGroupId
    if (!gid) {
      out.push({ item })
      continue
    }
    const idx = at.get(gid)
    if (idx === undefined) {
      at.set(gid, out.length)
      out.push({ item, group: [item] })
      continue
    }
    const entry = out[idx]
    entry.group!.push(item)
    // 封面让位给底图 —— 拿一张透明图层当封面等于一张空白卡。
    if ((item.layer?.zIndex ?? 0) < (entry.item.layer?.zIndex ?? 0)) entry.item = item
  }

  return out
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
  onInjectPrompt,
  onLayerSplit,
  group,
  onOpenLayers,
}: {
  item: BatchItem
  index: number
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
  onOpenEditor?: (url: string, type: 'angle' | 'light' | 'panorama' | 'director') => void
  onInjectPrompt?: (prompt: string) => void
  /** 把这一张拆成图层(排进队列)。 */
  onLayerSplit?: (imageUrl: string) => void
  /** 本卡代表一整组图层时给全组;点卡片改为打开图层查看器。 */
  group?: BatchItem[]
  onOpenLayers?: (group: BatchItem[]) => void
}) {
  const tilt = index % 4
  const tiltClass = ['p-tilt-l-2', 'p-tilt-r-2', 'p-tilt-l-3', 'p-tilt-r-3'][tilt]
  const badge = STATUS_BADGE[item.status]
  const isFail = item.status === 'error'
  const isRun = item.status === 'generating'
  // P0 OOM 修复(2026-06-23): cosUrl(http 持久链接)优先。上传成功后 store 会
  // 释放 resultUrl(模型直出 base64 ~10MB/张), 优先 cosUrl 让浏览器用可回收的
  // http 解码缓存, 避免 base64 + blob + 位图常驻 → 渲染进程内存耗尽黑屏。
  const displayUrl = item.cosUrl ?? item.resultUrl
  // imgSrc 是 displayUrl 走 useDisplaySrc 换出来的 blob: URL, 仅用于 <img src>。
  // displayUrl 原值留给 toolbar/modal/preview/download —— 那些需要原始 dataURL
  // 或 http 链接送回服务端 / 主进程, blob: URL 在跨进程是无效的。
  const imgSrc = useDisplaySrc(displayUrl)
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
        onClick={() => {
          if (!isDone) return
          // 图层组:点卡片进查看器而不是放大单张 —— 放大一张透明图层没有意义,
          // 用户要的是整个图层栈。
          if (group && onOpenLayers) onOpenLayers(group)
          else onPreview?.(displayUrl!)
        }}
      >
        {isDone && !group && (
          <ImageEditToolbar
            theme="punk"
            imageUrl={displayUrl!}
            onOpenEditor={(type) => onOpenEditor?.(displayUrl!, type)}
            onInjectPrompt={onInjectPrompt}
            onAddReference={(url) => addImageUrlToReferences('batch', url)}
            onLayerSplit={onLayerSplit}
          />
        )}
        {isDone && group && (
          <span
            className="p-mono"
            data-testid="batch-layer-group-badge"
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              zIndex: 20,
              fontSize: 10,
              fontWeight: 900,
              padding: '1px 5px',
              border: '2px solid var(--punk-black)',
              background: 'var(--punk-pink)',
              color: 'var(--punk-cream)',
            }}
          >
            ▤ {group.length} 层
          </span>
        )}
        {isDone && (
          <img
            src={imgSrc}
            alt={item.prompt}
            loading="lazy"
            decoding="async"
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
              title={item.error || 'FAILED'}
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
                cursor: item.error ? 'help' : 'default',
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
        {/* 拆分项的 prompt 是空串(那才是「自动全拆」的正确形态),卡上不能空着。 */}
        {item.prompt || (item.layerDecomposition ? '图层分离' : '')}
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
  const [editorState, setEditorState] = useState<{ url: string; type: 'angle' | 'light' | 'panorama' | 'director' } | null>(null)
  const [reversed, setReversed] = useState(true)
  const [layerGroup, setLayerGroup] = useState<BatchItem[] | null>(null)

  const injectPrompt = (p: string) => {
    const { mode, cardPrompt, multiText, setCardPrompt, setMultiText } = useBatchStore.getState()
    if (mode === 'card') setCardPrompt(cardPrompt + '\n' + p)
    else setMultiText(multiText + '\n' + p)
  }

  const failedItems = items.filter((i) => i.status === 'error')
  const doneItems = items.filter((i) => i.status === 'done')
  // 先归组再反序:反序是显示顺序,归组是「哪些卡本来就是一张」,顺序不该拆散组。
  const entries = groupBatchItems(items)
  const displayEntries = reversed ? [...entries].reverse() : entries

  const handleLayerSplit = async (imageUrl: string) => {
    // base64 直出模型的结果图是 blob:,只在本渲染进程有效 —— 直接发出去会被
    // normalizeImageSource 当成裸 base64 拼成垃圾 data URL。
    const source = await toUpstreamFetchableImage(imageUrl)
    useBatchStore.getState().addLayerSplitItem(source)
  }

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
          {displayEntries.map(({ item, group }) => {
            const origIdx = items.indexOf(item)
            return (
              <ResultCard
                key={item.id}
                item={item}
                index={origIdx}
                onRemove={onRemove}
                onPreview={onPreview}
                onOpenEditor={(url, type) => setEditorState({ url, type })}
                onInjectPrompt={injectPrompt}
                onLayerSplit={handleLayerSplit}
                group={group}
                onOpenLayers={setLayerGroup}
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
          directorEntry={editorState.type === 'director' ? 'panorama' : 'native'}
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
      {layerGroup && (
        <LayerStackViewer
          layers={layerGroup.map((m) => ({
            id: m.id,
            // cosUrl 优先:上传完成后 resultUrl 会被置空并 revoke,拿它等于拿一条
            // 已经失效的 blob。
            url: (m.cosUrl ?? m.resultUrl) as string,
            zIndex: m.layer?.zIndex ?? 0,
            ...(m.layer?.name ? { name: m.layer.name } : {}),
            ...(m.layer?.description ? { description: m.layer.description } : {}),
            ...(m.layer?.boundingBox ? { boundingBox: m.layer.boundingBox } : {}),
          }))}
          onClose={() => setLayerGroup(null)}
        />
      )}
    </>
  )
}
