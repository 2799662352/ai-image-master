import { useState } from 'react'
import type { ResultUploadMeta } from '../../stores/useGenerateStore'
import { useGenerateStore } from '../../stores/useGenerateStore'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
import { useImageLoadRetry } from '../../hooks/useImageLoadRetry'
import { appendCosThumb } from '../../utils/cosThumb'
import ImageEditToolbar from '../../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../../components/shared/image-editors/ImageEditorModal'
import { addImageUrlToReferences } from '../../components/shared/image-editors/referenceTargets'
import { LayerStackViewer } from './LayerStackViewer'

/**
 * 把平行数组按 `layerGroupId` 收成「渲染单元」。
 *
 * 一次图层拆分产出 1 底图 + N 层,它们是**一个带内部结构的产物**,不是 N 个互不相干
 * 的结果 —— 平铺进网格会让用户以为自己一次生成了 17 张图。所以同组收成一张卡片,
 * 点开进 LayerStackViewer。
 *
 * 保留原索引:放大预览 / 重编辑都按父组件那份 urls 的下标回调,收组不能打乱它。
 */
interface GridItem {
  /** 卡片代表的图在原数组里的索引（图层组取底图那张）。 */
  index: number
  /** 图层组的全部成员（含底图），按原索引升序；非图层组为空。 */
  group?: Array<{ index: number; url: string; meta: ResultUploadMeta }>
}

export function groupResultItems(urls: string[], meta?: ResultUploadMeta[]): GridItem[] {
  const items: GridItem[] = []
  const groupPos = new Map<string, number>()

  urls.forEach((url, index) => {
    const m = meta?.[index]
    const gid = m?.layerGroupId
    if (!gid || !m) {
      items.push({ index })
      return
    }
    const member = { index, url, meta: m }
    const at = groupPos.get(gid)
    if (at === undefined) {
      groupPos.set(gid, items.length)
      // 卡片先认第一张为代表；下面遇到 zIndex 更小的（底图）再让位。
      items.push({ index, group: [member] })
      return
    }
    const item = items[at]
    item.group!.push(member)
    // 卡片封面用底图（zIndex 最小）—— 拿一张透明图层当封面等于一张空白卡。
    const coverZ = meta?.[item.index]?.layer?.zIndex ?? 0
    if ((m.layer?.zIndex ?? 0) < coverZ) item.index = index
  })

  return items
}

/**
 * 单格图片 —— 把 `<img>` 抽成独立组件,只为了能在循环里安全调 useDisplaySrc:
 * 钩子不能在 .map() 回调里直接调。每个 cell 自己持有它那一张的 blob URL 生命周期,
 * 切换/卸载时自动 revoke,互不干扰。
 */
function ResultCell({ url, alt }: { url: string; alt: string }) {
  // 网格缩略图: COS 源经数据万象实时缩成 1024px WebP(2 列布局卡片较宽,
  // 1024 保证 retina 清晰)。blob:/临时 http 原样透传。点击放大的 lightbox
  // 由父组件用原始 resultUrls 打开, 永远是无损原图。
  const imgSrc = useDisplaySrc(appendCosThumb(url, 1024))
  const { reloadKey, onError, failed } = useImageLoadRetry(imgSrc)

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${alt}（加载失败）`}
        className="flex aspect-square w-full items-center justify-center bg-zinc-900 text-[11px] text-zinc-500"
      >
        图片加载失败
      </div>
    )
  }

  return (
    <img
      key={reloadKey}
      src={imgSrc}
      alt={alt}
      onError={onError}
      decoding="async"
      className="w-full object-contain"
    />
  )
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
  const [layerGroup, setLayerGroup] = useState<GridItem['group'] | null>(null)
  const items = groupResultItems(urls, meta)

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
      {items.map(({ index: i, group }) => {
        const url = urls[i]
        const m = meta?.[i]
        const badge = m ? UPLOAD_BADGE[m.uploadStatus] : null
        const snapshot = m?.snapshot
        const canEdit = !!(onEditFromResult && snapshot)
        // 图层组:整张卡片改成「进图层查看器」,而不是放大单张。放大一张透明图层
        // 对用户毫无意义,他要的是图层栈。
        const openGroup = group ? () => setLayerGroup(group) : undefined
        const activate = openGroup ?? (onPreview ? () => onPreview(i) : undefined)
        return (
          <div
            key={m?.id ?? `${i}-${url}`}
            onClick={activate}
            role={activate ? 'button' : undefined}
            tabIndex={activate ? 0 : undefined}
            onKeyDown={(e) => {
              if (activate && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                activate()
              }
            }}
            title={openGroup ? '点击查看图层' : activate ? '点击放大预览' : undefined}
            className={`group relative bg-zinc-900 border-2 border-zinc-700 overflow-hidden ${
              activate ? 'cursor-zoom-in hover:border-cyberpunk-yellow transition-colors' : ''
            }`}
          >
            <ResultCell url={url} alt={group ? '图层分离底图' : `Result ${i + 1}`} />
            {group ? (
              <span
                className="absolute top-1 left-1 border border-cyberpunk-yellow/70 bg-zinc-950/85 px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider text-cyberpunk-yellow"
                data-testid="layer-group-badge"
              >
                {`▤ ${group.length} 层`}
              </span>
            ) : (
              <ImageEditToolbar
                theme="default"
                imageUrl={url}
                onOpenEditor={(type) => setEditorState({ url, type })}
                onInjectPrompt={injectPrompt}
                onAddReference={(u) => addImageUrlToReferences('generate', u)}
              />
            )}
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
      {layerGroup && (
        <LayerStackViewer
          metas={layerGroup.map((g) => g.meta)}
          urls={layerGroup.map((g) => g.url)}
          onClose={() => setLayerGroup(null)}
        />
      )}
    </div>
  )
}
