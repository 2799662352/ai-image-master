// 人像库选择器弹窗 —— 移植自 soraui PortraitLibraryModal/PortraitGrid 的
// 精简版:搜索(上游 q)+ 类型过滤 + 多选 + 确认回填 asset:// 素材。
// 数据源走既有 preload 桥 seedance.listAssets;叠加层自定义名/隐藏由
// usePortraitLibraryOverlay 消费,与人像库页一致。
// 追加「官方素材/虚拟人像」来源(文档 5,只读):走 listOfficialMaterials,
// 回填 https 地址(官方素材没有 asset://,原始地址就是推荐引用方式)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
  SeedanceAssetListResult,
  SeedanceOfficialMaterialItem,
  SeedanceOfficialMaterialsResult,
} from '../../../../types/seedance'
import { usePortraitLibraryOverlay } from '../../hooks/usePortraitLibraryOverlay'
import { uploadFilesToPortraitLibrary } from '../../features/portrait-library/portraitUpload'
import { MaterialThumb } from './MaterialThumb'

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

/**
 * 渲染层稳定键:上游偶发 assetId 为 null(主进程 list 已归一,这里再兜一层),
 * 撞 null key 会让 React 网格重复/漏渲染,多选字典所有 null 条目共享一个槽位。
 */
export function assetStableKey(a: SeedanceAssetItem): string {
  return a.assetId || a.id || a.assetUrl || a.name
}

/** 按稳定键去重(防上游返回重复行):同键只保留第一条。 */
export function dedupeAssets(items: SeedanceAssetItem[]): SeedanceAssetItem[] {
  const seen = new Set<string>()
  const out: SeedanceAssetItem[] = []
  for (const it of items) {
    const key = assetStableKey(it)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/**
 * 上传完成后的「落定」延迟:上游导入后立刻 list 可能短暂返回
 * 「临时 preview- 行 + 正式行」两条,稍等再静默重拉一次让列表落定为一条。
 */
export const UPLOAD_SETTLE_DELAY_MS = 500

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
  const [uploading, setUploading] = useState(false)
  const overlay = usePortraitLibraryOverlay()
  const loadSeq = useRef(0)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const displayName = useCallback(
    (a: SeedanceAssetItem): string => overlay.entries[a.assetId]?.name || a.name,
    [overlay.entries],
  )

  const load = useCallback(async (src: PickerSource, k: SeedanceAssetKindFilter, q: string, opts?: { silent?: boolean }) => {
    const api = listApi()
    const seq = ++loadSeq.current
    if (!opts?.silent) setLoading(true)
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
      // 按稳定键去重:上游偶发重复行/临时行,同 assetId(或内部 id)只留一条
      setItems(dedupeAssets(next))
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

  /**
   * 弹窗内直接上传:走共享上传逻辑(校验 / 按当前类型 tab 定 imageCategory /
   * 失败 toast 均由模块处理),成功后刷新列表并自动选中新入库素材,
   * 用户可直接点「使用选中素材」。
   * 上游导入后立刻 list 可能短暂返回「临时 preview- 行 + 正式行」两条,
   * 所以首次刷新后再延迟静默重拉一次让列表落定 —— 期间网格保留
   * 「上传中…」占位卡,用户无需手动刷新。
   */
  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploading(true)
      try {
        const result = await uploadFilesToPortraitLibrary(Array.from(files), { kindTab: kind })
        if (result.assets.length > 0) {
          await load('mine', kind, query.trim())
          setSelected((prev) => {
            const next = { ...prev }
            for (const asset of result.assets) {
              next[assetStableKey(asset)] = asset
            }
            return next
          })
          // 延迟静默重拉:替换掉上游尚未落定的临时行,不闪整格 spinner
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_SETTLE_DELAY_MS))
          await load('mine', kind, query.trim(), { silent: true })
        }
      } finally {
        setUploading(false)
        if (uploadInputRef.current) uploadInputRef.current.value = ''
      }
    },
    [kind, query, load],
  )

  // 叠加层隐藏(软删除)只作用于「我的素材」;官方素材原样展示。
  const visible = useMemo(
    () => (source === 'mine' ? items.filter((a) => !overlay.entries[a.assetId]?.hidden) : items),
    [source, items, overlay.entries],
  )

  const selectedList = Object.values(selected)

  if (!open) return null

  // 必须 portal 到 body:这个弹窗是从卡片内部挂起来的(WorkbenchCard),而
  // `position: fixed` 只在没有祖先建立包含块时才相对视口定位。卡片上任何
  // `transform` / `filter` / `contain` / `will-change` 都会把它裁进卡片框 ——
  // 而这几个属性正是做滚动性能时最先会加到列表项上的东西。同目录的
  // MaterialPreviewModal 已经是这个形状。
  return createPortal(
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
          ) : visible.length === 0 && !uploading ? (
            <p className="text-white/30 text-xs py-8 text-center">
              {source === 'mine' ? '没有匹配的素材;可先在「人像库」页上传' : '没有匹配的官方素材'}
            </p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
              {uploading && (
                <div
                  data-testid="vw-picker-uploading-tile"
                  className="relative aspect-square border border-[#FCE300]/50 bg-[#18181B] flex flex-col items-center justify-center gap-2"
                >
                  <span className="w-5 h-5 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
                  <span className="text-[#FCE300] text-[10px]">上传中…</span>
                </div>
              )}
              {visible.map((asset) => {
                const key = assetStableKey(asset)
                const isSelected = !!selected[key]
                return (
                  <button
                    key={key}
                    type="button"
                    className={`relative aspect-square border overflow-hidden group ${
                      isSelected ? 'border-[#FCE300]' : 'border-[#3F3F46] hover:border-white/40'
                    }`}
                    title={displayName(asset)}
                    onClick={() =>
                      setSelected((prev) => {
                        const next = { ...prev }
                        if (next[key]) delete next[key]
                        else next[key] = asset
                        return next
                      })
                    }
                  >
                    {/* previewUrl 为 https 直通;加载失败时 MaterialThumb 兜底显示类型图标而非裂图 */}
                    <MaterialThumb
                      kind={String(asset.kind) === 'video' ? 'video' : String(asset.kind) === 'audio' ? 'audio' : 'image'}
                      material={{
                        name: displayName(asset),
                        src: '',
                        ...(asset.previewUrl ? { previewUrl: asset.previewUrl } : {}),
                      }}
                      imgClassName="w-full h-full object-cover"
                      fallback={
                        <span className="flex items-center justify-center w-full h-full text-2xl bg-[#18181B]">
                          {String(asset.kind) === 'video' ? '🎬' : String(asset.kind) === 'audio' ? '🎵' : '🖼'}
                        </span>
                      }
                    />
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

        {/* 底部:上传(仅我的素材) + 确认 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[#27272A]">
          {source === 'mine' && (
            <>
              <input
                ref={uploadInputRef}
                data-testid="vw-picker-upload-input"
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                className="hidden"
                onChange={(e) => void handleUpload(e.target.files)}
              />
              <button
                type="button"
                disabled={uploading}
                className="text-xs border border-[#FCE300]/60 text-[#FCE300] px-3 py-1.5 hover:bg-[#FCE300]/10 disabled:opacity-40 inline-flex items-center gap-1.5"
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading && (
                  <span className="w-3 h-3 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
                )}
                {uploading ? '上传中…' : '⬆ 上传素材'}
              </button>
            </>
          )}
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
    </div>,
    document.body,
  )
}
