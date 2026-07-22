// 参考素材「扑克牌堆叠」组件 —— 移植自 soraui JimengStyleEditor 的
// jm-stack 交互:收起时扇形微旋转叠放,hover 横向展开(64px 步进),
// 尾部虚线「+」添加卡淡入平移到队尾。配色换成 zinc/黄黑。

import { useRef, type ReactNode } from 'react'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { MaterialThumb } from './MaterialThumb'

const STEP_PX = 64
const MAX_VISIBLE = 12

interface MaterialStackProps {
  kind: 'image' | 'video' | 'audio'
  label: string
  materials: VideoWorkbenchMaterial[]
  limit: number
  accept: string
  disabled?: boolean
  onAdd: (files: File[]) => void
  onRemove: (index: number) => void
}

/**
 * 素材源 → 可预览缩略内容。本地路径不能直接塞 <img src>(local-file://
 * 协议在渲染端有盘符解析缺陷,见 MaterialThumb 注释),统一交给
 * MaterialThumb 走 useResolvedMediaSrc(IPC → blob:);解析失败/图片加载
 * 失败时兜底显示文件名(图片)或类型图标(视频/音频),不出裂图。
 */
function materialThumb(kind: 'image' | 'video' | 'audio', material: VideoWorkbenchMaterial): ReactNode {
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
  return <MaterialThumb kind={kind} material={material} fallback={fallback} />
}

export function MaterialStack({ kind, label, materials, limit, accept, disabled, onAdd, onRemove }: MaterialStackProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const visible = materials.slice(0, MAX_VISIBLE)
  const expandedWidth = (Math.min(materials.length, MAX_VISIBLE) + 1) * STEP_PX + 8

  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-white/50 text-xs shrink-0 w-14">
        {label}
        <span className="block text-[10px] text-white/30">{materials.length}/{limit}</span>
      </span>
      <div
        className={`vw-stack-container ${materials.length === 0 ? 'vw-empty' : ''}`}
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
              className="vw-stack-item"
              title={m.name}
              style={{
                zIndex: visible.length - idx,
                ['--stack-rotate' as string]: `${rot}deg`,
                ['--stack-tx' as string]: `${tx}px`,
                ['--stack-ty' as string]: `${ty}px`,
                ['--expand-left' as string]: `${idx * STEP_PX}px`,
              }}
            >
              {materialThumb(kind, m)}
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
    </div>
  )
}
