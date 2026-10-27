// 人像库选择器弹窗 —— 移植自 soraui PortraitLibraryModal/PortraitGrid 的
// 精简版:搜索(上游 q)+ 类型过滤 + 分页 + 多选 + 确认回填 asset:// 素材。
// 分页与人像库页同形(上一页 / 页码 / 下一页,页码由上游 totalPages 定);
// 换来源/类型/搜索词都回第 1 页。多选跨页保留 —— 选中存的是完整素材项。
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
import { useQuotaStore } from '../../stores/useQuotaStore'
import { useToastStore } from '../../stores/useToastStore'
import {
  cardStatusBadge,
  isCardSelectable,
  visibleCards,
  type PortraitCard,
} from '../../features/portrait-library/platformPortraitCard'
import {
  loadPortraitCards,
  uploadAndRegister,
} from '../../features/portrait-library/platformPortraitSource'
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
 * 平台侧的类型 tab。上游只有 `Image` / `Video` / `Audio` —— 没有「人像 / 场景」
 * 那个区分,摆两个都指向「图片」的 tab 是在骗人。`image_people` 在这里只是
 * 「图片」这一档的取值,不代表分类。
 */
const PLATFORM_KIND_TABS: Array<{ value: SeedanceAssetKindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image_people', label: '🖼 图片' },
  { value: 'video', label: '🎞 视频' },
  { value: 'audio', label: '🎵 音频' },
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

/**
 * 平台人像库的卡片 → 调用方要的 `SeedanceAssetItem`。
 *
 * **只在「确认」这一个出口转换,不在加载时转。** 平台侧的 `status` / `hidden` 在
 * `SeedanceAssetItem` 里没有对应字段,加载时就转等于把它们丢掉 —— 而灰掉非 Active、
 * 过滤已移出素材库这两件事全靠它们。转换发生在这里时,那两条判断都已经做过了。
 *
 * `assetUrl` 是 `asset://<Id>`:网关那条路正是靠它把平台素材递给上游
 * (`seedanceGateway/request.ts` 顶部写明这是它存在的理由)。
 */
function platformCardToAssetItem(card: PortraitCard): SeedanceAssetItem {
  const preview = card.thumbUrl || card.mediaUrl
  return {
    id: card.assetId,
    kind: card.kind,
    name: card.name,
    assetUrl: card.assetUrl,
    assetId: card.assetId,
    ...(preview ? { previewUrl: preview } : {}),
    ...(card.mediaUrl ? { sourceUrl: card.mediaUrl } : {}),
  } as SeedanceAssetItem
}

interface PortraitPickerModalProps {
  open: boolean
  onClose: () => void
  /** 确认选择:逐个回填完整素材项(含 assetUrl/previewUrl)。 */
  onConfirm: (assets: SeedanceAssetItem[]) => void
}

export function PortraitPickerModal({ open, onClose, onConfirm }: PortraitPickerModalProps) {
  // ── 平台计费分支 ───────────────────────────────────────────────────────────
  //
  // 只有「我的素材」这一路会分叉;弹窗外壳(头部 / tab 条 / 翻页 / 底部)两边共用。
  // 官方素材与虚拟人像走的是 vvdance 的另一个接口(要 seedance 的 HMAC 凭据),
  // 平台模式下不给入口 —— 点进去只会拿到一条看不懂的错误。
  const addToast = useToastStore((s) => s.addToast)
  const billingSource = useQuotaStore((s) => s.billingSource)
  const selectedPool = useQuotaStore((s) => s.selectedPool)
  const platform = billingSource === 'platform'
  const scope = useMemo(
    () =>
      selectedPool
        ? { projectId: selectedPool.projectId, producerProjectId: selectedPool.producerProjectId }
        : null,
    [selectedPool],
  )

  const [items, setItems] = useState<SeedanceAssetItem[]>([])
  const [platformCards, setPlatformCards] = useState<PortraitCard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<PickerSource>('mine')
  // 平台侧没有「人像 / 场景」这个区分(上游只有 Image / Video / Audio),默认落
  // 「全部」而不是一个语义对不上的分类。
  const [kind, setKind] = useState<SeedanceAssetKindFilter>(platform ? 'all' : 'image_people')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Record<string, SeedanceAssetItem>>({})
  const [uploading, setUploading] = useState(false)
  const overlay = usePortraitLibraryOverlay()
  const loadSeq = useRef(0)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const displayName = useCallback(
    (a: SeedanceAssetItem): string => overlay.entries[a.assetId]?.name || a.name,
    [overlay.entries],
  )

  const load = useCallback(async (
    src: PickerSource,
    k: SeedanceAssetKindFilter,
    q: string,
    p: number,
    opts?: { silent?: boolean },
  ) => {
    const api = listApi()
    const seq = ++loadSeq.current
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      let next: SeedanceAssetItem[]
      let resultTotal: number
      let resultTotalPages: number
      if (src === 'mine') {
        if (!api?.listAssets) throw new Error('人像库未就绪(preload 桥缺失)')
        const result = await api.listAssets({ page: p, pageSize: PAGE_SIZE, kind: k, ...(q ? { q } : {}) })
        next = result.items ?? []
        resultTotal = result.total ?? next.length
        resultTotalPages = result.totalPages ?? 1
      } else {
        if (!api?.listOfficialMaterials) throw new Error('官方素材库未就绪(preload 桥缺失)')
        const result = await api.listOfficialMaterials({
          library: src === 'avatars' ? 'avatars' : 'materials',
          page: p,
          pageSize: PAGE_SIZE,
          ...(q ? { q } : {}),
        })
        next = (result.items ?? []).map(officialToAssetItem)
        resultTotal = result.total ?? next.length
        resultTotalPages = result.totalPages ?? 1
      }
      if (seq !== loadSeq.current) return
      // 按稳定键去重:上游偶发重复行/临时行,同 assetId(或内部 id)只留一条
      setItems(dedupeAssets(next))
      setTotal(resultTotal)
      setTotalPages(Math.max(1, resultTotalPages))
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? e.message : String(e))
      setItems([])
      setTotal(0)
      setTotalPages(1)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  // 打开时拉取;搜索词 300ms 防抖。翻页也走这条 —— page 是依赖之一。
  useEffect(() => {
    if (!open || platform) return
    const timer = setTimeout(() => void load(source, kind, query.trim(), page), query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [open, platform, source, kind, query, page, load])

  /**
   * 平台侧**一次拿全量**(上游不做服务端分页),所以过滤、搜索、翻页全在本地做 ——
   * 这条 effect 只依赖 `open` 与池键,不跟着 tab / 搜索词 / 页码重发。
   */
  const reloadPlatform = useCallback(async () => {
    if (!scope) return
    const seq = ++loadSeq.current
    setLoading(true)
    const r = await loadPortraitCards(scope, { trash: false })
    if (seq !== loadSeq.current) return
    setLoading(false)
    if (!r.ok) {
      setError(r.message)
      setPlatformCards([])
      return
    }
    setError(null)
    setPlatformCards(r.data.cards)
  }, [scope])

  useEffect(() => {
    if (!open || !platform) return
    void reloadPlatform()
  }, [open, platform, reloadPlatform])

  // 翻页后把网格滚回顶部 —— 否则停在上一页的滚动位置,新一页像是「只有下半截」。
  // 直接写 scrollTop 而不是 scrollTo():后者在 jsdom 里根本没实现,一调就炸。
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0
  }, [page])

  // 关闭时重置选择与翻页位置
  useEffect(() => {
    if (!open) {
      setSelected({})
      setQuery('')
      setPage(1)
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
  /**
   * 平台侧的弹窗内上传:两步走 `upload → register`。
   *
   * 刚登记的素材**刻意不自动选中** —— 它还没就绪(register 的回包里根本没有
   * `Status`),自动选中等于把一条注定撞 `ASSET_NOT_READY` 的引用塞进卡片。
   * 它会带着「处理中」角标出现在网格里,就绪后用户自己点。
   */
  const handlePlatformUpload = useCallback(
    async (files: FileList | null) => {
      if (!scope || !files || files.length === 0) return
      setUploading(true)
      try {
        for (const file of Array.from(files)) {
          const r = await uploadAndRegister(scope, file)
          if (!r.ok) {
            addToast({ message: `「${file.name}」${r.message}`, type: 'error' })
            continue
          }
          // 登记回包已是永久 COS 链,先铺上去 —— 不必等 poll 就有缩略图。
          setPlatformCards((prev) => [r.data, ...prev])
          setPage(1)
        }
      } finally {
        setUploading(false)
        if (uploadInputRef.current) uploadInputRef.current.value = ''
      }
    },
    [scope, addToast],
  )

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploading(true)
      try {
        const result = await uploadFilesToPortraitLibrary(Array.from(files), { kindTab: kind })
        if (result.assets.length > 0) {
          // 回第 1 页:列表按时间倒序,刚传的就在首页,停在第 3 页会看不见它。
          // 当时若不在首页,setPage 会额外触发一次同页拉取 —— loadSeq 兜得住,
          // 不值得为这一次多余请求再引一套 reload token。
          setPage(1)
          await load('mine', kind, query.trim(), 1)
          setSelected((prev) => {
            const next = { ...prev }
            for (const asset of result.assets) {
              next[assetStableKey(asset)] = asset
            }
            return next
          })
          // 延迟静默重拉:替换掉上游尚未落定的临时行,不闪整格 spinner
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_SETTLE_DELAY_MS))
          await load('mine', kind, query.trim(), 1, { silent: true })
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

  /**
   * 平台侧的展示层过滤。
   *
   * 🚨 `visibleCards` 之外**不许**再按 status 滤:非 Active 的素材从选择器里消失
   * 会让用户以为没传上去,于是重复上传 —— 每重复一次都真实占配额。它们要留在
   * 网格里、灰掉、说清原因(见下面的 `disabled` 与角标)。
   */
  const platformVisible = useMemo(() => {
    if (!platform) return []
    const q = query.trim().toLowerCase()
    return visibleCards(platformCards, { trash: false })
      .filter((c) => {
        if (kind === 'all') return true
        // 平台侧没有「人像 / 场景」之分,两个 tab 值都只代表「图片」。
        if (kind === 'image_people' || kind === 'image_environment') return c.kind === 'image'
        return c.kind === kind
      })
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.assetId.toLowerCase().includes(q))
  }, [platform, platformCards, kind, query])

  // 上游一次回全量,翻页在本地切 —— 没有翻页控件等于「库里其余素材根本够不着」。
  const platformTotalPages = Math.max(1, Math.ceil(platformVisible.length / PAGE_SIZE))
  const platformPage = platformVisible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const shownTotalPages = platform ? platformTotalPages : totalPages
  const shownTotal = platform ? platformVisible.length : total
  const sourceTabs = platform ? SOURCE_TABS.filter((t) => t.value === 'mine') : SOURCE_TABS
  const gridEmpty = platform ? platformVisible.length === 0 : visible.length === 0

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
            onChange={(e) => {
              // 换了筛选条件就回第 1 页 —— 新结果只有 2 页时停在第 5 页会是空的
              setPage(1)
              setQuery(e.target.value)
            }}
          />
          <button type="button" aria-label="关闭" className="text-white/40 hover:text-white px-1" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 来源 tab(我的素材 / 官方素材 / 虚拟人像) + 类型 tab(仅我的素材) */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[#27272A] flex-wrap">
          {sourceTabs.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`text-xs px-2 py-1 border ${
                source === t.value
                  ? 'border-[#FCE300] text-[#FCE300] bg-[#FCE300]/10'
                  : 'border-[#3F3F46] text-white/50 hover:text-white/80'
              }`}
              onClick={() => {
                setPage(1)
                setSource(t.value)
              }}
            >
              {t.label}
            </button>
          ))}
          {source === 'mine' && <span className="w-px h-4 bg-[#3F3F46] mx-1" />}
          {source === 'mine' &&
            (platform ? PLATFORM_KIND_TABS : KIND_TABS).map((t) => (
              <button
                key={t.value}
                type="button"
                className={`text-xs px-2 py-1 border ${
                  kind === t.value
                    ? 'border-[#FCE300] text-[#FCE300]'
                    : 'border-[#3F3F46] text-white/50 hover:text-white/80'
                }`}
                onClick={() => {
                  setPage(1)
                  setKind(t.value)
                }}
              >
                {t.label}
              </button>
            ))}
        </div>

        {/* 素材网格 */}
        <div ref={gridRef} className="flex-1 overflow-y-auto p-4">
          {platform && !scope ? (
            // 平台人像库按计费池分组,一个池下登记的素材在另一个池下读不出来 ——
            // 没选池时连请求都不该发,那一定是 INVALID_POOL。
            <p className="text-white/40 text-xs py-8 text-center">
              请先在账号设置里选择一个计费池,再从平台人像库选素材
            </p>
          ) : loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <p className="text-red-400 text-xs py-8 text-center">{error}</p>
          ) : gridEmpty && !uploading ? (
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
              {platform &&
                platformPage.map((card) => {
                  const badge = cardStatusBadge(card)
                  const selectable = isCardSelectable(card)
                  const isSelected = !!selected[card.assetId]
                  return (
                    <button
                      key={card.key}
                      type="button"
                      // 非 Active 灰掉 + 禁点,而不是从列表里拿走:消失的素材会被
                      // 用户当成「没传上去」再传一遍,而每重复一次都真实占配额。
                      disabled={!selectable}
                      className={`relative aspect-square border overflow-hidden group ${
                        isSelected ? 'border-[#FCE300]' : 'border-[#3F3F46] hover:border-white/40'
                      } ${selectable ? '' : 'opacity-45 cursor-not-allowed'}`}
                      title={`${card.name}${badge ? `\n${badge.reason}` : ''}`}
                      onClick={() =>
                        setSelected((prev) => {
                          const next = { ...prev }
                          if (next[card.assetId]) delete next[card.assetId]
                          else next[card.assetId] = platformCardToAssetItem(card)
                          return next
                        })
                      }
                    >
                      <MaterialThumb
                        kind={card.kind}
                        material={{
                          name: card.name,
                          src: '',
                          ...(card.thumbUrl ? { previewUrl: card.thumbUrl } : {}),
                        }}
                        imgClassName="w-full h-full object-cover"
                        fallback={
                          <span className="flex items-center justify-center w-full h-full text-2xl bg-[#18181B]">
                            {card.kind === 'video' ? '🎬' : card.kind === 'audio' ? '🎵' : '🖼'}
                          </span>
                        }
                      />
                      {badge && (
                        <span
                          className={`absolute top-1 left-1 text-[9px] font-bold px-1 ${
                            badge.tone === 'failed' ? 'bg-red-600 text-white' : 'bg-black/70 text-amber-300'
                          }`}
                        >
                          {badge.text}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 bg-black/70 text-white/80 text-[9px] px-1 py-0.5 truncate text-left">
                        {card.name}
                      </span>
                      {isSelected && (
                        <span className="absolute top-1 right-1 bg-[#FCE300] text-black text-[10px] font-bold px-1">✓</span>
                      )}
                    </button>
                  )
                })}
              {!platform &&
                visible.map((asset) => {
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

        {/* 分页。跨页多选是安全的:selected 存的是完整素材项,不从当前页的 items
            里派生 —— 翻走那一页的勾选照样留在「已选 N 个」里。
            平台侧上游一次回全量,这里切的是本地切片,控件形状不变。 */}
        {shownTotalPages > 1 && (
          <div
            data-testid="vw-picker-pager"
            className="flex items-center justify-center gap-3 px-4 py-2 border-t border-[#27272A] text-xs"
          >
            <button
              type="button"
              className="border border-[#3F3F46] text-white/60 px-2 py-1 hover:text-white disabled:opacity-40"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span className="text-white/40">
              {page} / {shownTotalPages}
              {shownTotal > 0 ? ` · 共 ${shownTotal} 个` : ''}
            </span>
            <button
              type="button"
              className="border border-[#3F3F46] text-white/60 px-2 py-1 hover:text-white disabled:opacity-40"
              disabled={page >= shownTotalPages || loading}
              onClick={() => setPage((p) => Math.min(shownTotalPages, p + 1))}
            >
              下一页
            </button>
          </div>
        )}

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
                onChange={(e) => void (platform ? handlePlatformUpload : handleUpload)(e.target.files)}
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
