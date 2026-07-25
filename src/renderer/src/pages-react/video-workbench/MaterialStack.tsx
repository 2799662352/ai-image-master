// 参考素材「扑克牌堆叠」组件 —— 移植自 soraui JimengStyleEditor 的
// jm-stack 交互:收起时扇形微旋转叠放,hover 横向展开(64px 步进),
// 尾部虚线「+」添加卡淡入平移到队尾。配色换成 zinc/黄黑。
// 素材缩略图支持 HTML5 拖拽换位(onReorder):拖起项半透明,目标位置
// 显示黄色插入指示线,松手写回 store。
// 单击素材弹出预览(图片大图 / 视频播放 / 音频播放,MaterialPreviewModal);
// 拖拽换位后的 click 用 ref 抑制一拍,两种手势不打架。

import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { MaterialPreviewModal } from './MaterialPreviewModal'
import { MaterialThumb } from './MaterialThumb'

const STEP_PX = 64
const MAX_VISIBLE = 12

/** 素材换位拖拽 mime(带 kind,跨堆叠不生效)。 */
export function materialDragMime(kind: 'image' | 'video' | 'audio'): string {
  return `application/x-vw-material-${kind}`
}

interface MaterialStackProps {
  kind: 'image' | 'video' | 'audio'
  label: string
  materials: VideoWorkbenchMaterial[]
  limit: number
  accept: string
  disabled?: boolean
  onAdd: (files: File[]) => void
  onRemove: (index: number) => void
  /** 拖拽换位:把 fromIndex 的素材挪到 toIndex(0 起)。 */
  onReorder?: (fromIndex: number, toIndex: number) => void
  /**
   * 与 materials 等长的已解析缩略图地址。给了就由父层独占解析,缩略图不再自己
   * 走一趟 IPC(见 MaterialThumb.resolvedSrc)。不给则各缩略图自己解析。
   */
  thumbSrcs?: Array<string | undefined>
}

/**
 * 素材源 → 可预览缩略内容。本地路径不能直接塞 <img src>(local-file://
 * 协议在渲染端有盘符解析缺陷,见 MaterialThumb 注释),统一交给
 * MaterialThumb 走 useResolvedMediaSrc(IPC → blob:);解析失败/图片加载
 * 失败时兜底显示文件名(图片)或类型图标(视频/音频),不出裂图。
 */
function materialThumb(
  kind: 'image' | 'video' | 'audio',
  material: VideoWorkbenchMaterial,
  resolvedSrc?: string | null,
): ReactNode {
  const icon = kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '🖼'
  const fallback =
    kind === 'image' && !material.previewUrl ? (
      <span className="text-[10px] text-white/60 px-1 break-all leading-tight">{material.name}</span>
    ) : (
      <span className="flex flex-col items-center justify-center w-full h-full gap-0.5">
        <span className="text-base leading-none">{icon}</span>
        <span className="text-[9px] text-white/60 px-0.5 truncate max-w-full">{material.name}</span>
      </span>
    )
  return (
    <MaterialThumb
      kind={kind}
      material={material}
      fallback={fallback}
      {...(resolvedSrc !== undefined ? { resolvedSrc } : {})}
    />
  )
}

export function MaterialStack({
  kind,
  label,
  materials,
  limit,
  accept,
  disabled,
  onAdd,
  onRemove,
  onReorder,
  thumbSrcs,
}: MaterialStackProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const visible = materials.slice(0, MAX_VISIBLE)
  // 父层接管解析时,未解析出的项要传 null(而不是 undefined)—— undefined 的语义
  // 是「父层不管,你自己解析」,会把省下的那趟 IPC 又加回来。
  const thumbSrcAt = (index: number): string | null | undefined =>
    thumbSrcs ? (thumbSrcs[index] ?? null) : undefined
  const expandedWidth = (Math.min(materials.length, MAX_VISIBLE) + 1) * STEP_PX + 8

  // ---- 素材换位拖拽 ----
  const dragMime = materialDragMime(kind)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropPos, setDropPos] = useState<{ index: number; before: boolean } | null>(null)

  // ---- 点击预览(与拖拽换位共存)----
  // 浏览器通常不会在一次真实拖拽后派发 click,但 jsdom / 某些边界会:
  // dragstart 时立起抑制位,dragend 后微任务清除,保证「拖动排序不误开预览」。
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const suppressClickRef = useRef(false)

  const clearDragState = () => {
    setDragIdx(null)
    setDropPos(null)
    setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }

  const handleItemDragOver = (e: DragEvent, idx: number) => {
    if (!onReorder || !e.dataTransfer.types.includes(dragMime)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropPos({ index: idx, before: e.clientX < rect.left + rect.width / 2 })
  }

  const handleItemDrop = (e: DragEvent, idx: number) => {
    if (!onReorder || !e.dataTransfer.types.includes(dragMime)) return
    e.preventDefault()
    e.stopPropagation()
    const from = parseInt(e.dataTransfer.getData(dragMime), 10)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientX < rect.left + rect.width / 2
    clearDragState()
    if (!Number.isInteger(from) || from < 0 || from >= materials.length) return
    let target = before ? idx : idx + 1
    if (from < target) target -= 1
    if (from !== target) onReorder(from, target)
  }

  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-white/50 text-xs shrink-0 w-14">
        {label}
        <span className="block text-[10px] text-white/30">{materials.length}/{limit}</span>
      </span>
      <div
        className={`vw-stack-container ${materials.length === 0 ? 'vw-empty' : ''} ${dragIdx !== null ? 'vw-reordering' : ''}`}
        style={{ width: expandedWidth }}
        data-testid={`vw-stack-${kind}`}
      >
        {visible.map((m, idx) => {
          const rot = (idx % 2 === 0 ? -1 : 1) * (3 + (idx % 3) * 0.8)
          const tx = (idx % 2 === 0 ? -1 : 1) * 2
          const ty = (idx % 2 === 0 ? 1 : -1) * 1.5
          return (
            <div
              key={`${m.src.slice(0, 64)}-${idx}`}
              className={[
                'vw-stack-item',
                dragIdx === idx ? 'vw-mat-dragging' : '',
                dropPos?.index === idx ? (dropPos.before ? 'vw-mat-drop-before' : 'vw-mat-drop-after') : '',
              ].join(' ')}
              title={m.name}
              draggable={!disabled && !!onReorder}
              data-testid={`vw-stack-item-${kind}-${idx}`}
              style={{
                zIndex: visible.length - idx,
                ['--stack-rotate' as string]: `${rot}deg`,
                ['--stack-tx' as string]: `${tx}px`,
                ['--stack-ty' as string]: `${ty}px`,
                ['--expand-left' as string]: `${idx * STEP_PX}px`,
              }}
              role="button"
              aria-label={`预览 ${m.name}`}
              onClick={() => {
                if (suppressClickRef.current) return
                setPreviewIdx(idx)
              }}
              onDragStart={(e) => {
                if (disabled || !onReorder) return
                e.dataTransfer.setData(dragMime, String(idx))
                e.dataTransfer.effectAllowed = 'move'
                suppressClickRef.current = true
                setDragIdx(idx)
              }}
              onDragEnd={clearDragState}
              onDragOver={(e) => handleItemDragOver(e, idx)}
              onDragLeave={() => setDropPos((p) => (p?.index === idx ? null : p))}
              onDrop={(e) => handleItemDrop(e, idx)}
            >
              {materialThumb(kind, m, thumbSrcAt(idx))}
              {!disabled && (
                <span
                  className="vw-stack-remove"
                  role="button"
                  aria-label={`移除 ${m.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(idx)
                  }}
                >
                  ✕
                </span>
              )}
            </div>
          )
        })}
        {materials.length > MAX_VISIBLE && (
          <span
            className="absolute text-[10px] text-black bg-[#FCE300] px-1 z-[100]"
            style={{ left: MAX_VISIBLE * STEP_PX - 12, top: 0 }}
          >
            +{materials.length - MAX_VISIBLE}
          </span>
        )}
        {!disabled && materials.length < limit && (
          <div
            className="vw-stack-add"
            role="button"
            aria-label={`添加${label}`}
            style={{ ['--expand-left' as string]: `${Math.min(materials.length, MAX_VISIBLE) * STEP_PX}px` }}
            onClick={() => inputRef.current?.click()}
          >
            ＋
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          aria-label={`选择${label}文件`}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            if (files.length) onAdd(files)
            e.target.value = ''
          }}
        />
      </div>
      {previewIdx !== null && materials[previewIdx] && (
        <MaterialPreviewModal
          kind={kind}
          material={materials[previewIdx]}
          onClose={() => setPreviewIdx(null)}
        />
      )}
    </div>
  )
}
