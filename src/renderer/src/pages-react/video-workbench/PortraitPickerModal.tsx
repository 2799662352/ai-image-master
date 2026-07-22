// 人像库选择器弹窗 —— 移植自 soraui PortraitLibraryModal/PortraitGrid 的
// 精简版:搜索(上游 q)+ 类型过滤 + 多选 + 确认回填 asset:// 素材。
// 数据源走既有 preload 桥 seedance.listAssets;叠加层自定义名/隐藏由
// usePortraitLibraryOverlay 消费,与人像库页一致。
// 追加「官方素材/虚拟人像」来源(文档 5,只读):走 listOfficialMaterials,
// 回填 https 地址(官方素材没有 asset://,原始地址就是推荐引用方式)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
  SeedanceAssetListResult,
  SeedanceOfficialMaterialItem,
  SeedanceOfficialMaterialsResult,
} from '../../../../types/seedance'
import { usePortraitLibraryOverlay } from '../../hooks/usePortraitLibraryOverlay'

const PAGE_SIZE = 60

interface SeedanceListApi {
  listAssets?: (query: {
    page?: number
    pageSize?: number
    q?: string
    kind?: SeedanceAssetKindFilter
  }) => Promise<SeedanceAssetListResult>
  listOfficialMaterials?: (query: {
    library?: 'materials' | 'avatars'
    page?: number
    pageSize?: number
    q?: string
  }) => Promise<SeedanceOfficialMaterialsResult>
}

function listApi(): SeedanceListApi | undefined {
  return (window as unknown as { electronAPI?: { seedance?: SeedanceListApi } }).electronAPI?.seedance
}

/** 素材来源:我的库(可管理) / 官方素材 / 官方虚拟人像(均只读)。 */
type PickerSource = 'mine' | 'official' | 'avatars'

const SOURCE_TABS: Array<{ value: PickerSource; label: string }> = [
  { value: 'mine', label: '◈ 我的素材' },
  { value: 'official', label: '🏛 官方素材' },
  { value: 'avatars', label: '🧑‍🎤 虚拟人像' },
]

const KIND_TABS: Array<{ value: SeedanceAssetKindFilter; label: string }> = [
  { value: 'image_people', label: '🧑 人像' },
  { value: 'image_environment', label: '🏞 场景' },
  { value: 'video', label: '🎞 视频' },
  { value: 'audio', label: '🎵 音频' },
  { value: 'all', label: '全部' },
]

/**
 * 官方素材条目 → 统一的 SeedanceAssetItem 形状(回填/多选/确认走同一条路)。
 * assetUrl 用官方原始地址(https,文档 5.4 推荐直接作为 url 引用)。
 */
function officialToAssetItem(item: SeedanceOfficialMaterialItem): SeedanceAssetItem {
  const url = item.assetUrl || item.sourceUrl || item.previewUrl || ''
  return {
    id: item.id,
    kind: item.kind === 'virtual_portrait' ? 'image' : item.kind,
    name: item.name,
    previewUrl: item.previewUrl || url,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    assetUrl: url,
    assetId: item.assetId || item.id,
  }
}

interface PortraitPickerModalProps {
  open: boolean
  onClose: () => void
  /** 确认选择:逐个回填完整素材项(含 assetUrl/previewUrl)。 */
  onConfirm: (assets: SeedanceAssetItem[]) => void
}

export function PortraitPickerModal({ open, onClose, onConfirm }: PortraitPickerModalProps) {
  const [items, setItems] = useState<SeedanceAssetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<PickerSource>('mine')
  const [kind, setKind] = useState<SeedanceAssetKindFilter>('image_people')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Record<string, SeedanceAssetItem>>({})
  const overlay = usePortraitLibraryOverlay()
  const loadSeq = useRef(0)

  const displayName = useCallback(
    (a: SeedanceAssetItem): string => overlay.entries[a.assetId]?.name || a.name,
    [overlay.entries],
  )

  const load = useCallback(async (src: PickerSource, k: SeedanceAssetKindFilter, q: string) => {
    const api = listApi()
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      let next: SeedanceAssetItem[]
      if (src === 'mine') {
        if (!api?.listAssets) throw new Error('人像库未就绪(preload 桥缺失)')
        const result = await api.listAssets({ page: 1, pageSize: PAGE_SIZE, kind: k, ...(q ? { q } : {}) })
        next = result.items ?? []
      } else {
        if (!api?.listOfficialMaterials) throw new Error('官方素材库未就绪(preload 桥缺失)')
        const result = await api.listOfficialMaterials({
          library: src === 'avatars' ? 'avatars' : 'materials',
          page: 1,
          pageSize: PAGE_SIZE,
          ...(q ? { q } : {}),
        })
        next = (result.items ?? []).map(officialToAssetItem)
      }
      if (seq !== loadSeq.current) return
      setItems(next)
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? e.message : String(e))
      setItems([])
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  // 打开时拉取;搜索词 300ms 防抖
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void load(source, kind, query.trim()), query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [open, source, kind, query, load])

  // 关闭时重置选择
  useEffect(() => {
    if (!open) {
      setSelected({})
      setQuery('')
    }
  }, [open])

  // 叠加层隐藏(软删除)只作用于「我的素材」;官方素材原样展示。
  const visible = useMemo(
    () => (source === 'mine' ? items.filter((a) => !overlay.entries[a.assetId]?.hidden) : items),
    [source, items, overlay.entries],
  )

  const selectedList = Object.values(selected)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6"
      data-testid="vw-portrait-picker"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-[#111113] border border-[#3F3F46] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部:标题 + 搜索 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#27272A]">
          <h3 className="text-white font-bold text-sm shrink-0">
            <span className="text-[#FCE300]">◈</span> 从人像库选择
          </h3>
          <input
            value={query}
            placeholder="搜索素材名…"
            className="flex-1 min-w-0 bg-[#18181B] border border-[#3F3F46] text-white/90 text-xs px-2 py-1.5 focus:outline-none focus:border-[#FCE300]"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" aria-label="关闭" className="text-white/40 hover:text-white px-1" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 来源 tab(我的素材 / 官方素材 / 虚拟人像) + 类型 tab(仅我的素材) */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[#27272A] flex-wrap">
          {SOURCE_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`text-xs px-2 py-1 border ${
                source === t.value
                  ? 'border-[#FCE300] text-[#FCE300] bg-[#FCE300]/10'
                  : 'border-[#3F3F46] text-white/50 hover:text-white/80'
              }`}
              onClick={() => setSource(t.value)}
            >
              {t.label}
            </button>
          ))}
          {source === 'mine' && <span className="w-px h-4 bg-[#3F3F46] mx-1" />}
          {source === 'mine' &&
            KIND_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`text-xs px-2 py-1 border ${
                  kind === t.value
                    ? 'border-[#FCE300] text-[#FCE300]'
                    : 'border-[#3F3F46] text-white/50 hover:text-white/80'
                }`}
                onClick={() => setKind(t.value)}
              >
                {t.label}
              </button>
            ))}
        </div>

        {/* 素材网格 */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <p className="text-red-400 text-xs py-8 text-center">{error}</p>
          ) : visible.length === 0 ? (
            <p className="text-white/30 text-xs py-8 text-center">
              {source === 'mine' ? '没有匹配的素材;可先在「人像库」页上传' : '没有匹配的官方素材'}
            </p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
              {visible.map((asset) => {
                const isSelected = !!selected[asset.assetId]
                return (
                  <button
                    key={asset.assetId}
                    type="button"
                    className={`relative aspect-square border overflow-hidden group ${
                      isSelected ? 'border-[#FCE300]' : 'border-[#3F3F46] hover:border-white/40'
                    }`}
                    title={displayName(asset)}
                    onClick={() =>
                      setSelected((prev) => {
                        const next = { ...prev }
                        if (next[asset.assetId]) delete next[asset.assetId]
                        else next[asset.assetId] = asset
                        return next
                      })
                    }
                  >
                    {asset.previewUrl ? (
                      <img src={asset.previewUrl} alt={displayName(asset)} className="w-full h-full object-cover" draggable={false} />
                    ) : (
                      <span className="flex items-center justify-center w-full h-full text-2xl bg-[#18181B]">
                        {String(asset.kind) === 'video' ? '🎬' : String(asset.kind) === 'audio' ? '🎵' : '🖼'}
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 text-white/80 text-[9px] px-1 py-0.5 truncate text-left">
                      {displayName(asset)}
                    </span>
                    {isSelected && (
                      <span className="absolute top-1 right-1 bg-[#FCE300] text-black text-[10px] font-bold px-1">✓</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部:确认 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[#27272A]">
          <span className="text-white/40 text-xs">{selectedList.length > 0 ? `已选 ${selectedList.length} 个` : '点击素材多选'}</span>
          <button
            type="button"
            className="ml-auto text-xs border border-[#3F3F46] text-white/60 px-3 py-1.5 hover:text-white"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="text-xs bg-[#FCE300] text-black font-bold px-3 py-1.5 disabled:opacity-40"
            disabled={selectedList.length === 0}
            onClick={() => {
              onConfirm(selectedList)
              onClose()
            }}
          >
            使用选中素材{selectedList.length > 0 ? `(${selectedList.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
