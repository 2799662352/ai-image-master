// 人像库选择器弹窗 —— 移植自 soraui PortraitLibraryModal/PortraitGrid 的
// 精简版:搜索 + 类型过滤 + 分页 + 多选 + 确认回填 asset:// 素材。
// 分页与人像库页同形(上一页 / 页码 / 下一页);换类型/搜索词都回第 1 页。
// 多选跨页保留 —— 选中存的是完整素材项。
//
// **数据源只有平台人像库**(`window.electronAPI.portraitLibrary`,按计费池分组)。
// 自填 Miau Key 模式下没有人像库(以前这里还有 vvdance 素材库与「官方素材 / 虚拟人像」
// 两个来源,随 vvdance 直连一起删除),弹窗只给一句提示,不发任何请求。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  OWN_KEY_NO_PORTRAIT_LIBRARY_HINT,
  type PortraitAssetItem,
} from '../../features/portrait-library/portraitLibraryShared'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { useToastStore } from '../../stores/useToastStore'
import {
  cardStatusBadge,
  isCardSelectable,
  visibleCards,
  type PortraitCard,
  type PortraitCardKind,
} from '../../features/portrait-library/platformPortraitCard'
import {
  loadPortraitCards,
  uploadAndRegister,
} from '../../features/portrait-library/platformPortraitSource'
import { MaterialThumb } from './MaterialThumb'

const PAGE_SIZE = 60

type PickerKind = 'all' | PortraitCardKind

/**
 * 类型 tab。上游只有 `Image` / `Video` / `Audio` —— 没有「人像 / 场景」那个区分,
 * 所以只有「图片」一档,不摆两个都指向图片的 tab。
 */
const KIND_TABS: Array<{ value: PickerKind; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '🖼 图片' },
  { value: 'video', label: '🎞 视频' },
  { value: 'audio', label: '🎵 音频' },
]

/**
 * 平台人像库的卡片 → 调用方要的 `PortraitAssetItem`。
 *
 * **只在「确认」这一个出口转换,不在加载时转。** 平台侧的 `status` / `hidden` 在
 * `PortraitAssetItem` 里没有对应字段,加载时就转等于把它们丢掉 —— 而灰掉非 Active、
 * 过滤已移出素材库这两件事全靠它们。转换发生在这里时,那两条判断都已经做过了。
 *
 * `assetUrl` 是 `asset://<Id>`:网关那条路正是靠它把平台素材递给上游
 * (`seedanceGateway/request.ts` 顶部写明这是它存在的理由)。
 */
function platformCardToAssetItem(card: PortraitCard): PortraitAssetItem {
  const preview = card.thumbUrl || card.mediaUrl
  return {
    id: card.assetId,
    kind: card.kind,
    name: card.name,
    assetUrl: card.assetUrl,
    assetId: card.assetId,
    ...(preview ? { previewUrl: preview } : {}),
    ...(card.mediaUrl ? { sourceUrl: card.mediaUrl } : {}),
  }
}

interface PortraitPickerModalProps {
  open: boolean
  onClose: () => void
  /** 确认选择:逐个回填完整素材项(含 assetUrl/previewUrl)。 */
  onConfirm: (assets: PortraitAssetItem[]) => void
}

export function PortraitPickerModal({ open, onClose, onConfirm }: PortraitPickerModalProps) {
  // 平台人像库按计费池分组,一个池下登记的素材在另一个池下读不出来。
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

  const [platformCards, setPlatformCards] = useState<PortraitCard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 平台侧没有「人像 / 场景」这个区分(上游只有 Image / Video / Audio),默认落「全部」。
  const [kind, setKind] = useState<PickerKind>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Record<string, PortraitAssetItem>>({})
  const [uploading, setUploading] = useState(false)
  const loadSeq = useRef(0)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

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
   * 弹窗内上传:两步走 `upload → register`。
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

  /**
   * 展示层过滤。
   *
   * 🚨 `visibleCards` 之外**不许**再按 status 滤:非 Active 的素材从选择器里消失
   * 会让用户以为没传上去,于是重复上传 —— 每重复一次都真实占配额。它们要留在
   * 网格里、灰掉、说清原因(见下面的 `disabled` 与角标)。
   */
  const platformVisible = useMemo(() => {
    if (!platform) return []
    const q = query.trim().toLowerCase()
    return visibleCards(platformCards, { trash: false })
      .filter((c) => kind === 'all' || c.kind === kind)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.assetId.toLowerCase().includes(q))
  }, [platform, platformCards, kind, query])

  // 上游一次回全量,翻页在本地切 —— 没有翻页控件等于「库里其余素材根本够不着」。
  const totalPages = Math.max(1, Math.ceil(platformVisible.length / PAGE_SIZE))
  const platformPage = platformVisible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const total = platformVisible.length
  const gridEmpty = platformVisible.length === 0

  const selectedList = Object.values(selected)

  if (!open) return null

  // 必须 portal 到 body:这个弹窗是从卡片内部挂起来的(WorkbenchCard),而
  // `position: fixed` 只在没有祖先建立包含块时才相对视口定位。卡片上任何
  // `transform` / `filter` / `contain` / `will-change` 都会把它裁进卡片框 ——
  // 而这几个属性正是做滚动性能时最先会加到列表项上的东西。同目录的
  // MaterialPreviewModal 已经是这个形状。
  if (!platform) {
    // 自填 Miau Key:没有人像库,只给提示 + 关闭,不发任何请求。
    return createPortal(
      <div
        className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6"
        data-testid="vw-portrait-picker"
        onClick={onClose}
      >
        <div
          className="w-full max-w-md bg-[#111113] border border-[#3F3F46] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[#27272A]">
            <h3 className="text-white font-bold text-sm flex-1">
              <span className="text-[#FCE300]">◈</span> 从人像库选择
            </h3>
            <button type="button" aria-label="关闭" className="text-white/40 hover:text-white px-1" onClick={onClose}>
              ✕
            </button>
          </div>
          <p data-testid="vw-portrait-picker-own-key-hint" className="text-white/60 text-xs leading-relaxed px-4 py-8 text-center">
            {OWN_KEY_NO_PORTRAIT_LIBRARY_HINT}
          </p>
          <div className="flex items-center px-4 py-3 border-t border-[#27272A]">
            <button
              type="button"
              className="ml-auto text-xs border border-[#3F3F46] text-white/60 px-3 py-1.5 hover:text-white"
              onClick={onClose}
            >
              知道了
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

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

        {/* 类型 tab */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[#27272A] flex-wrap">
          {KIND_TABS.map((t) => (
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
          {!scope ? (
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
            <p className="text-white/30 text-xs py-8 text-center">没有匹配的素材;可先在「人像库」页上传</p>
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
              {platformPage.map((card) => {
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
            </div>
          )}
        </div>

        {/* 分页。跨页多选是安全的:selected 存的是完整素材项,不从当前页的数据里
            派生 —— 翻走那一页的勾选照样留在「已选 N 个」里。
            上游一次回全量,这里切的是本地切片。 */}
        {totalPages > 1 && (
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
              {page} / {totalPages}
              {total > 0 ? ` · 共 ${total} 个` : ''}
            </span>
            <button
              type="button"
              className="border border-[#3F3F46] text-white/60 px-2 py-1 hover:text-white disabled:opacity-40"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </button>
          </div>
        )}

        {/* 底部:上传 + 确认 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[#27272A]">
          <input
            ref={uploadInputRef}
            data-testid="vw-picker-upload-input"
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={(e) => void handlePlatformUpload(e.target.files)}
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
