// 人像库页在**平台计费**模式下的主体。自填 Key 模式仍走 vvdance 那条老路
// (`PortraitLibraryPage` 里的 `SeedancePortraitLibrary`),两边的素材互不可见。
//
// ── 为什么是两个组件而不是一个归一过的 ────────────────────────────────────────
//
// 两套数据的**交集里恰好没有** `Status` 与 `Hidden` —— 而本次三条硬约束里有两条
// 就架在这两个字段上。硬凑一个共用类型只有两条出路:要么取交集(把约束依赖的字段
// 丢掉),要么给 vvdance 侧合成一个 `Status: 'Active'` —— 那是**假的**,
// `platformAssets.test.ts:136` 已经为同一件事立过规矩:不凭空合成状态。
//
// 何况两边不同的不只是字段名,是**动作**:vvdance 的分组/改名/隐藏是纯本地叠加层
// (`usePortraitLibraryOverlay`,离线可用、不释放任何东西),平台侧则是服务端的
// hide/patch/purge,还牵着配额。归一了数据也归一不了动作,结果是每个按钮里都要
// 再分一次叉 —— 那比在顶上分一次叉更难读,也更容易把两条语义拌在一起。
//
// 分成两个组件,分叉就只有 `PortraitLibraryPage` 顶上那一处。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortraitScopeRef } from '../../../../types/portraitApi'
// 直接指到 store 文件而不是 `../agent-chat` 那个桶:桶里还挂着 mount / 任务监听器,
// 而这里只要一个 zustand store。
import { useAgentChatStore } from '../agent-chat/store'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { useToastStore } from '../../stores/useToastStore'
import { TextPromptModal } from './TextPromptModal'
import {
  cardStatusBadge,
  isCardSelectable,
  visibleCards,
  type PortraitCard,
  type PortraitCardKind,
} from './platformPortraitCard'
import {
  awaitCardReady,
  deleteForever,
  loadPortraitCards,
  removeFromLibrary,
  renamePortraitAsset,
  restoreFromTrash,
  uploadAndRegister,
  type PortraitOpResult,
} from './platformPortraitSource'

/**
 * 首屏铺多少张。
 *
 * 上游一次回全量(最多 2000 条),整批直接进 DOM 会在首屏卡住 —— 而用户要找的
 * 素材几乎总在最前(列表按 CreateTime 倒序)。与网页版同口径。
 */
const REVEAL_STEP = 60

type KindFilter = 'all' | PortraitCardKind

const KIND_FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '🖼 图片' },
  { value: 'video', label: '🎞 视频' },
  { value: 'audio', label: '🎵 音频' },
]

/** 上传中的乐观占位。这是唯一的乐观 UI —— 删除侧一律等响应回来再动。 */
interface PendingUpload {
  tempId: string
  name: string
  localThumb?: string
}

/** 本地预览图。拿不到就不显示 —— 少一张占位缩略图,不该让整次上传崩在这儿。 */
function localPreview(file: File): string | undefined {
  if (!file.type.startsWith('image/')) return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

/**
 * 缩略图。裂图与「本来就没有缩略图」在网格里必须长一样,否则用户看到的是一格
 * 无法解释的空白。地址可能是永久 COS 链,也可能是历史遗留的签名链(会过期)——
 * **前端不做过期处理**,失败换占位图就够了。
 */
function CardThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="text-3xl">🖼</span>
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-full h-full object-cover"
    />
  )
}

export function PlatformPortraitLibrary() {
  const addToast = useToastStore((s) => s.addToast)
  const selectedPool = useQuotaStore((s) => s.selectedPool)

  const [cards, setCards] = useState<PortraitCard[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [trash, setTrash] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<KindFilter>('all')
  const [search, setSearch] = useState('')
  const [revealed, setRevealed] = useState(REVEAL_STEP)
  const [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [purgeTarget, setPurgeTarget] = useState<PortraitCard | null>(null)
  const [renameTarget, setRenameTarget] = useState<PortraitCard | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 拉取序号:切视图 / 连点刷新时,只让最后一趟的结果落地。 */
  const loadSeq = useRef(0)

  const scope: PortraitScopeRef | null = useMemo(
    () =>
      selectedPool
        ? { projectId: selectedPool.projectId, producerProjectId: selectedPool.producerProjectId }
        : null,
    [selectedPool],
  )

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const load = useCallback(
    async (target: { trash: boolean }) => {
      if (!scope) return
      const seq = ++loadSeq.current
      setLoading(true)
      const r = await loadPortraitCards(scope, target)
      if (seq !== loadSeq.current) return
      setLoading(false)
      if (!r.ok) {
        setError(r.message)
        return
      }
      setError(null)
      setCards(r.data.cards)
      setTotalCount(r.data.totalCount)
      setHiddenCount(r.data.hiddenCount)
      setTruncated(r.data.truncated)
    },
    [scope],
  )

  useEffect(() => {
    void load({ trash })
  }, [load, trash])

  // 展示层过滤。🚨 `visibleCards` 之外**不许**再加状态过滤:非 Active 的素材
  // 从网格里消失会让用户以为没传上去,于是重复上传 —— 而每重复一次都真实占配额。
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return visibleCards(cards, { trash })
      .filter((c) => kind === 'all' || c.kind === kind)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.assetId.toLowerCase().includes(q))
  }, [cards, trash, kind, search])

  const activeCount = useMemo(
    () => visibleCards(cards, { trash: false }).filter(isCardSelectable).length,
    [cards],
  )
  const selectedCards = useMemo(
    () => shown.filter((c) => selectedIds.has(c.assetId)),
    [shown, selectedIds],
  )

  const toggleSelect = useCallback((card: PortraitCard) => {
    if (!isCardSelectable(card)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(card.assetId)) next.delete(card.assetId)
      else next.add(card.assetId)
      return next
    })
  }, [])

  /**
   * 三个删除动作与重命名共用的收尾。
   *
   * **成功了才重拉、才清选中** —— 失败时一切原地不动。这不是省事:软删失败会返 500,
   * 而乐观移除会让用户以为删掉了、刷新后素材又复活。
   */
  const settle = useCallback(
    async (r: PortraitOpResult<unknown>, okMessage: string) => {
      if (!r.ok) {
        addToast({ message: r.message, type: 'error' })
        return
      }
      addToast({ message: okMessage, type: 'success' })
      clearSelection()
      await load({ trash })
    },
    [addToast, clearSelection, load, trash],
  )

  const handleRemove = useCallback(async () => {
    if (!scope) return
    for (const card of selectedCards) {
      // 逐条串行:批量接口不存在,而并发发十几条 DELETE 只会把上游打出限流。
      const r = await removeFromLibrary(scope, card.assetId)
      if (!r.ok) {
        addToast({ message: `「${card.name}」${r.message}`, type: 'error' })
        return
      }
    }
    await settle({ ok: true, data: null }, `已移出 ${selectedCards.length} 个素材(可在回收站恢复)`)
  }, [scope, selectedCards, addToast, settle])

  const handleRestore = useCallback(async () => {
    if (!scope) return
    for (const card of selectedCards) {
      const r = await restoreFromTrash(scope, card.assetId)
      if (!r.ok) {
        addToast({ message: `「${card.name}」${r.message}`, type: 'error' })
        return
      }
    }
    // 恢复只回一个 `{ Id }`,本地那张卡的其余字段不保证还对 —— 必须重拉。
    await settle({ ok: true, data: null }, `已恢复 ${selectedCards.length} 个素材`)
  }, [scope, selectedCards, addToast, settle])

  const handlePurgeConfirmed = useCallback(async () => {
    if (!scope || !purgeTarget) return
    const target = purgeTarget
    setPurgeTarget(null)
    await settle(await deleteForever(scope, target.assetId), `已彻底删除「${target.name}」`)
  }, [scope, purgeTarget, settle])

  const handleRename = useCallback(
    async (value: string) => {
      if (!scope || !renameTarget) return
      const name = value.trim()
      const target = renameTarget
      setRenameTarget(null)
      if (!name || name === target.name) return
      await settle(await renamePortraitAsset(scope, target.assetId, name), '已重命名')
    },
    [scope, renameTarget, settle],
  )

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!scope || !files || files.length === 0) return
      const list = Array.from(files)
      const placeholders: PendingUpload[] = list.map((f, i) => {
        const localThumb = localPreview(f)
        return {
          tempId: `pending-${Date.now()}-${i}`,
          name: f.name,
          ...(localThumb ? { localThumb } : {}),
        }
      })
      setUploading(true)
      setPending(placeholders)
      const fresh: PortraitCard[] = []
      try {
        for (let i = 0; i < list.length; i++) {
          const r = await uploadAndRegister(scope, list[i]!)
          setPending((prev) => prev.filter((p) => p.tempId !== placeholders[i]!.tempId))
          if (!r.ok) {
            addToast({ message: `「${list[i]!.name}」${r.message}`, type: 'error' })
            continue
          }
          fresh.push(r.data)
          // 登记回包已带永久 COS 链,所以先把卡片铺上去 —— 不必等 poll 就有缩略图。
          setCards((prev) => [r.data, ...prev])
        }
      } finally {
        setUploading(false)
        placeholders.forEach((p) => p.localThumb && URL.revokeObjectURL(p.localThumb))
        setPending([])
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
      if (fresh.length > 0) {
        addToast({ message: `已入库 ${fresh.length} 个素材,正在等待上游处理`, type: 'success' })
      }
      // 服务端长轮询(一次请求最长 90s),外面不再包 setInterval;已是终态时后端短路。
      // 结果只用来把那张卡就地换掉,不重拉整个列表。
      await Promise.all(
        fresh.map(async (card) => {
          const ready = await awaitCardReady(scope, card.assetId)
          if (!ready.ok) return
          setCards((prev) => prev.map((c) => (c.assetId === card.assetId ? ready.data : c)))
        }),
      )
    },
    [scope, addToast],
  )

  const copyReference = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        addToast({ message: 'asset:// 引用已复制', type: 'success' })
      } catch {
        addToast({ message: '复制失败', type: 'error' })
      }
    },
    [addToast],
  )

  const sendToAgent = useCallback(() => {
    if (selectedCards.length === 0) return
    const chat = useAgentChatStore.getState()
    const refs = selectedCards.map((c) => `「${c.name}」(${c.assetUrl})`).join('、')
    chat.appendInputText(
      `${chat.input && !chat.input.endsWith(' ') ? ' ' : ''}用人像库素材 ${refs} 作为参考生成视频：`,
    )
    if (!chat.isOpen) chat.toggle()
    addToast({ message: `已插入 ${selectedCards.length} 个素材到 Agent 对话`, type: 'success' })
  }, [selectedCards, addToast])

  if (!scope) {
    return (
      <div
        data-testid="platform-portrait-library"
        className="flex flex-col items-center justify-center h-full gap-4 text-center px-6"
      >
        <div className="text-5xl">👤</div>
        <h2 className="text-xl font-bold text-white">还没选计费池</h2>
        <p className="text-sm text-zinc-400 max-w-md">
          平台人像库按计费池分组存放素材,一个池下登记的素材在另一个池下读不出来。
          请先在账号设置里选一个计费池。
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="platform-portrait-library"
      className="flex flex-col h-full p-4 gap-4 max-w-7xl mx-auto w-full"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <span>👤</span> 人像库
            <span className="text-[10px] font-normal text-cyberpunk-yellow border border-cyberpunk-yellow/50 rounded px-1.5 py-0.5">
              平台余额
            </span>
          </h1>
          {/* `TotalCount` 不等于 `Items.length`,「N 可用」只能自己数 Active。 */}
          <span data-testid="platform-portrait-summary" className="text-xs text-zinc-500">
            {totalCount} 个素材 · {activeCount} 可用
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            data-testid="platform-portrait-upload-input"
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || trash}
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm rounded hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? '上传中…' : '⬆ 上传素材'}
          </button>
          <button
            onClick={() => void load({ trash })}
            disabled={loading}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700 disabled:opacity-50"
          >
            🔄 刷新
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => {
              setKind(f.value)
              setRevealed(REVEAL_STEP)
              clearSelection()
            }}
            className={`px-3 py-1 rounded-full text-xs ${
              kind === f.value
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-bold'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => {
            setTrash((v) => !v)
            setRevealed(REVEAL_STEP)
            clearSelection()
          }}
          className={`px-3 py-1 rounded-full text-xs ${
            trash ? 'bg-red-500 text-white font-bold' : 'bg-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          🗑 回收站{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
        </button>
        <div className="flex items-center gap-1 ml-auto">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setRevealed(REVEAL_STEP)
            }}
            placeholder="按名称 / assetId 搜索"
            className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-1.5 rounded w-56"
          />
        </div>
      </div>

      {truncated && (
        <p className="text-xs text-amber-400">
          素材过多,上游分页被截断,下面这份列表并不完整。清理回收站(彻底删除)能腾出分页预算。
        </p>
      )}

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap bg-zinc-900 border border-cyberpunk-yellow/40 rounded px-3 py-2">
          <span className="text-sm text-white font-bold">已选 {selectedIds.size} 个</span>
          <div className="flex items-center gap-2 ml-auto">
            {!trash && (
              <button
                onClick={sendToAgent}
                className="px-3 py-1 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-xs rounded hover:opacity-90"
              >
                🎬 发送到 Agent
              </button>
            )}
            {selectedCards.length === 1 && (
              <>
                <button
                  onClick={() => setRenameTarget(selectedCards[0]!)}
                  className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
                >
                  ✏️ 重命名
                </button>
                <button
                  onClick={() => void copyReference(selectedCards[0]!.assetUrl)}
                  className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
                >
                  📋 复制引用
                </button>
              </>
            )}
            {trash ? (
              <>
                <button
                  onClick={() => void handleRestore()}
                  className="px-3 py-1 bg-zinc-800 border border-cyberpunk-yellow/50 text-cyberpunk-yellow text-xs rounded hover:bg-zinc-700"
                >
                  ♻ 恢复
                </button>
                {selectedCards.length === 1 && (
                  <button
                    onClick={() => setPurgeTarget(selectedCards[0]!)}
                    className="px-3 py-1 bg-red-600 text-white font-bold text-xs rounded hover:opacity-90"
                  >
                    ⨯ 彻底删除
                  </button>
                )}
              </>
            ) : (
              // 「移出素材库」而不是「删除」:软删不释放配额,叫删除会让用户困惑
              // 为什么删了还提示素材过多。
              <button
                onClick={() => void handleRemove()}
                className="px-3 py-1 bg-zinc-800 border border-red-500/50 text-red-400 text-xs rounded hover:bg-zinc-700"
              >
                🗑 移出素材库
              </button>
            )}
            <button onClick={clearSelection} className="px-2 py-1 text-zinc-500 text-xs hover:text-white">
              ✕ 清除
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <p className="text-sm text-red-400 max-w-md break-all">{error}</p>
            <button
              onClick={() => void load({ trash })}
              className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
            >
              重试
            </button>
          </div>
        ) : loading && cards.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
          </div>
        ) : shown.length === 0 && pending.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center text-zinc-500">
            <div className="text-4xl">🗂</div>
            <p className="text-sm">{trash ? '回收站是空的' : '人像库还是空的'}</p>
            {!trash && <p className="text-xs">点击「上传素材」导入图片 / 视频 / 音频</p>}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {pending.map((p) => (
                <div
                  key={p.tempId}
                  className="relative bg-zinc-900 rounded overflow-hidden border border-cyberpunk-yellow/40"
                >
                  <div className="aspect-square bg-zinc-800 flex items-center justify-center overflow-hidden">
                    {p.localThumb ? (
                      <img src={p.localThumb} alt={p.name} className="w-full h-full object-cover opacity-50" />
                    ) : (
                      <span className="text-3xl opacity-50">🖼</span>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <div className="w-6 h-6 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
                    </div>
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="text-xs text-white truncate">{p.name}</p>
                    <p className="text-[10px] text-cyberpunk-yellow">上传中…</p>
                  </div>
                </div>
              ))}
              {shown.slice(0, revealed).map((card) => {
                const badge = cardStatusBadge(card)
                const selectable = isCardSelectable(card)
                const isSelected = selectedIds.has(card.assetId)
                return (
                  <button
                    key={card.key}
                    data-testid={`platform-card-${card.assetId}`}
                    disabled={!selectable}
                    onClick={() => toggleSelect(card)}
                    title={`${card.name}\n${card.assetUrl}${badge ? `\n${badge.reason}` : ''}`}
                    className={`group relative bg-zinc-900 rounded overflow-hidden border text-left transition-all ${
                      isSelected
                        ? 'border-cyberpunk-yellow ring-2 ring-cyberpunk-yellow/50'
                        : 'border-zinc-700 hover:border-zinc-500'
                    } ${selectable ? '' : 'opacity-45 cursor-not-allowed'}`}
                  >
                    <div className="relative aspect-square bg-zinc-800 flex items-center justify-center overflow-hidden">
                      {card.kind === 'video' ? (
                        <span className="text-3xl">🎞</span>
                      ) : card.kind === 'audio' ? (
                        <span className="text-3xl">🎵</span>
                      ) : card.thumbUrl ? (
                        <CardThumb key={card.thumbUrl} src={card.thumbUrl} alt={card.name} />
                      ) : (
                        <span className="text-3xl">🖼</span>
                      )}
                      {badge && (
                        <span
                          data-testid={`platform-status-${card.assetId}`}
                          className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[10px] rounded font-bold ${
                            badge.tone === 'failed' ? 'bg-red-600 text-white' : 'bg-black/70 text-amber-300'
                          }`}
                        >
                          {badge.text}
                        </span>
                      )}
                    </div>
                    {isSelected && (
                      <span className="absolute top-1.5 right-1.5 w-5 h-5 bg-cyberpunk-yellow text-cyberpunk-black text-xs font-bold rounded-full flex items-center justify-center">
                        ✓
                      </span>
                    )}
                    <div className="px-2 py-1.5">
                      <p className="text-xs text-white truncate">{card.name}</p>
                    </div>
                  </button>
                )
              })}
            </div>
            {shown.length > revealed && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => setRevealed((n) => n + REVEAL_STEP)}
                  className="px-4 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
                >
                  加载更多({shown.length - revealed})
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {purgeTarget && (
        <div
          className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6"
          onClick={() => setPurgeTarget(null)}
        >
          <div
            data-testid="platform-purge-confirm"
            className="w-full max-w-md bg-zinc-900 border border-red-500/50 rounded-lg p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold text-white">彻底删除「{purgeTarget.name}」?</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              这一步会真删上游素材,<span className="text-red-400 font-bold">不可撤销</span>。
              画布上引用它的节点将无法再用于生成。
            </p>
            <p className="text-xs text-zinc-500">
              这也是唯一能回收配额与列表分页预算的操作 —— 只「移出素材库」不会腾出空间。
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPurgeTarget(null)}
                className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                onClick={() => void handlePurgeConfirmed()}
                className="px-3 py-1.5 bg-red-600 text-white font-bold text-sm rounded hover:opacity-90"
              >
                确认彻底删除
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <TextPromptModal
          title="重命名素材"
          placeholder="最多 64 字"
          initial={renameTarget.name}
          confirmLabel="保存"
          onConfirm={(v) => void handleRename(v)}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </div>
  )
}
