// 参考素材「扑克牌堆叠」组件 —— 移植自 soraui JimengStyleEditor 的
// jm-stack 交互:收起时扇形微旋转叠放,hover 横向展开(64px 步进),
// 尾部虚线「+」添加卡淡入平移到队尾。配色换成 zinc/黄黑。
// 素材缩略图支持 HTML5 拖拽换位(onReorder):拖起项半透明,目标位置
// 显示黄色插入指示线,松手写回 store。
// 单击素材弹出预览(图片大图 / 视频播放 / 音频播放,MaterialPreviewModal);
// 拖拽换位后的 click 用 ref 抑制一拍,两种手势不打架。

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { copyToClipboard } from '../../utils/clipboard'
import { useToastStore } from '../../stores/useToastStore'
import { MaterialPreviewModal } from './MaterialPreviewModal'
import { MaterialThumb } from './MaterialThumb'

const STEP_PX = 64
const MAX_VISIBLE = 12

/**
 * 预传状态角标。素材拖进来就开始往云端传,这里是那件事**唯一的界面反馈** ——
 * 在此之前传完没传完只能开 F12 猜(而且猜不到:上传走主进程,不经 Chromium
 * 网络栈,DevTools 的 Network 面板里根本没有)。
 *
 * 没有状态就不画:https / data: / asset:// 这些源本来就没有本地文件要传,
 * 给它们挂个角标只是噪音。
 */
function UploadBadge({ material }: { material: VideoWorkbenchMaterial }): ReactNode {
  const state = material.uploadState
  if (!state) return null
  const label =
    state === 'uploading' ? '正在上传到云端…'
      : state === 'uploaded' ? `已传到云端:${material.uploadedUrl ?? ''}`
        : '云端上传失败,生成时会从本地重传'
  return (
    <span
      className={`vw-stack-upload ${state === 'uploaded' ? 'is-uploaded' : state === 'failed' ? 'is-failed' : ''}`}
      title={label}
      aria-label={label}
      data-testid={`vw-upload-${state}`}
    >
      {state === 'uploading' ? <span className="vw-upload-spin" aria-hidden="true" /> : null}
      {state === 'uploaded' ? '✓' : null}
      {state === 'failed' ? '!' : null}
    </span>
  )
}

/** 缩略图的 hover 提示:文件名 + 传输结论(有地址就把地址也带上)。 */
function tileTitle(m: VideoWorkbenchMaterial): string {
  if (m.uploadState === 'uploading') return `${m.name}\n正在上传到云端…`
  if (m.uploadState === 'failed') return `${m.name}\n云端上传失败,生成时会从本地重传`
  if (m.uploadedUrl) return `${m.name}\n${m.uploadedUrl}`
  return m.name
}

/** 打开外部链接(与 file-explorer 的 UrlPreview 同一条桥)。 */
function openExternal(url: string): void {
  const bridge = (window as Window & { electronAPI?: { shell?: { openExternal?: (u: string) => Promise<unknown> } } })
    .electronAPI?.shell
  void bridge?.openExternal?.(url)
}

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
  // 「铺开全部」。悬停展开只排得下一行(MAX_VISIBLE),而 Seedance 2.5 一张卡收 30 张图 ——
  // 单行要 1920px,必然溢出卡片。所以超出一行的部分改为**点开钉住**再多行铺开:
  // 悬停是掠过性动作,不该把卡片高度撑起来;点开是明确意图,撑高才不突兀。
  //
  // 这不只是好看:被折叠的那些**既删不掉也拖不动**,而「第 N 张 = reference image N」
  // 现在是写进 skill 的硬规矩,拖不动就等于改不了绑定关系。
  const [expanded, setExpanded] = useState(false)
  // 父层接管解析时,未解析出的项要传 null(而不是 undefined)—— undefined 的语义
  // 是「父层不管,你自己解析」,会把省下的那趟 IPC 又加回来。
  const thumbSrcAt = (index: number): string | null | undefined =>
    thumbSrcs ? (thumbSrcs[index] ?? null) : undefined

  const overflowing = materials.length > MAX_VISIBLE
  const showAll = expanded && overflowing
  // 收起态下,超出首行的那些**仍然渲染**,只是位置钳到最后一格 —— 它们叠在
  // 「+N」角标底下,展开时才各就各位。渲染而不是 slice 掉,是为了让展开/收起
  // 只是位移动画,不是整批 DOM 增删(缩略图会重新解析,闪一下)。
  const posIndex = (idx: number): number => (showAll ? idx : Math.min(idx, MAX_VISIBLE - 1))
  const columns = Math.min(materials.length, MAX_VISIBLE)
  const rows = showAll ? Math.ceil(materials.length / MAX_VISIBLE) : 1
  const expandedWidth = (columns + (showAll ? 0 : 1)) * STEP_PX + 8
  const expandedHeight = showAll ? rows * STEP_PX + 12 : undefined

  // ---- 素材换位拖拽 ----
  const dragMime = materialDragMime(kind)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropPos, setDropPos] = useState<{ index: number; before: boolean } | null>(null)

  // ---- 点击预览(与拖拽换位共存)----
  // 浏览器通常不会在一次真实拖拽后派发 click,但 jsdom / 某些边界会:
  // dragstart 时立起抑制位,dragend 后微任务清除,保证「拖动排序不误开预览」。
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const suppressClickRef = useRef(false)

  // ---- 右键菜单(复制/打开云端地址)----
  // 必须是渲染层菜单,不能指望 Electron 原生那个:原生菜单按右键处的
  // `params.srcURL` 是不是 http(s) 决定要不要给「复制图片地址」,而缩略图渲染的是
  // 本地文件解析出来的 blob:,那道闸永远不过。云端地址挂在素材对象的 uploadedUrl
  // 上,从不进 DOM 的 src,原生菜单看不见它。
  const addToast = useToastStore((s) => s.addToast)
  const [menu, setMenu] = useState<{ x: number; y: number; url: string } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

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
        className={`vw-stack-container ${materials.length === 0 ? 'vw-empty' : ''} ${dragIdx !== null ? 'vw-reordering' : ''} ${showAll ? 'vw-expanded' : ''}`}
        style={{ width: expandedWidth, ...(expandedHeight ? { height: expandedHeight } : {}) }}
        data-testid={`vw-stack-${kind}`}
        // 主进程据此跳过原生右键菜单,免得「图片另存为…」盖在自定义菜单上面。
        // 同款做法见 file-explorer 的 data-file-explorer-root。
        data-vw-material-stack=""
      >
        {materials.map((m, idx) => {
          const rot = (idx % 2 === 0 ? -1 : 1) * (3 + (idx % 3) * 0.8)
          const tx = (idx % 2 === 0 ? -1 : 1) * 2
          const ty = (idx % 2 === 0 ? 1 : -1) * 1.5
          const pos = posIndex(idx)
          return (
            <div
              key={`${m.src.slice(0, 64)}-${idx}`}
              className={[
                'vw-stack-item',
                dragIdx === idx ? 'vw-mat-dragging' : '',
                dropPos?.index === idx ? (dropPos.before ? 'vw-mat-drop-before' : 'vw-mat-drop-after') : '',
              ].join(' ')}
              title={tileTitle(m)}
              draggable={!disabled && !!onReorder}
              data-testid={`vw-stack-item-${kind}-${idx}`}
              style={{
                zIndex: materials.length - idx,
                ['--stack-rotate' as string]: `${rot}deg`,
                ['--stack-tx' as string]: `${tx}px`,
                ['--stack-ty' as string]: `${ty}px`,
                ['--expand-left' as string]: `${(pos % MAX_VISIBLE) * STEP_PX}px`,
                ['--expand-top' as string]: `${Math.floor(pos / MAX_VISIBLE) * STEP_PX}px`,
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
              onContextMenu={(e) => {
                // 没有云端地址就没有可复制/可打开的东西,让原生菜单照常出。
                if (!m.uploadedUrl) return
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, url: m.uploadedUrl })
              }}
            >
              {materialThumb(kind, m, thumbSrcAt(idx))}
              <UploadBadge material={m} />
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
        {overflowing && (
          <button
            type="button"
            className="vw-stack-more"
            aria-expanded={showAll}
            aria-label={showAll ? `收起${label}` : `展开全部 ${materials.length} 个${label}`}
            title={showAll ? '收起' : `还有 ${materials.length - MAX_VISIBLE} 个 —— 点开铺平，可逐个删除和拖拽换位`}
            style={{ left: MAX_VISIBLE * STEP_PX - 12 }}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            {showAll ? '收起' : `+${materials.length - MAX_VISIBLE}`}
          </button>
        )}
        {!disabled && materials.length < limit && (
          <div
            className="vw-stack-add"
            role="button"
            aria-label={`添加${label}`}
            style={{
              ['--expand-left' as string]: `${(columns % MAX_VISIBLE) * STEP_PX}px`,
              ['--expand-top' as string]: `${(showAll ? rows - 1 : 0) * STEP_PX}px`,
            }}
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
      {menu && (
        <div
          className="vw-material-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          data-testid="vw-material-menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const url = menu.url
              setMenu(null)
              void copyToClipboard(url).then((ok) => {
                addToast({ message: ok ? '云端地址已复制' : '复制失败', type: ok ? 'success' : 'error' })
              })
            }}
          >
            复制链接
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openExternal(menu.url)
              setMenu(null)
            }}
          >
            在浏览器中打开
          </button>
        </div>
      )}
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
