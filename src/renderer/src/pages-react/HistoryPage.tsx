/**
 * HistoryPage (React 版) - 「ドーナドーナ」风 霓虹赛博朋克主题
 * 接 HistoryDataService(真数据源),完整替代 vanilla pages/HistoryPage.ts
 */

import { useMemo, useState, useCallback } from 'react'
import { useHistoryData, type DonorItemView } from '../hooks/useHistoryData'
import DonorShell from '../components/donor/DonorShell'
import DonorHeader from '../components/donor/DonorHeader'
import DonorFilterBar, { type SortMode, type StatusFilter } from '../components/donor/DonorFilterBar'
import DonorCard from '../components/donor/DonorCard'
import DonorEmpty from '../components/donor/DonorEmpty'
import DonorPreview from '../components/donor/DonorPreview'
import DonorStorageModal from '../components/donor/DonorStorageModal'
import { useToastStore } from '../stores'

export default function HistoryPage() {
  const { items, stats, delete: deleteItem, clear } = useHistoryData()
  const addToast = useToastStore((s) => s.addToast)

  const [query, setQuery] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortMode>('newest')

  const [preview, setPreview] = useState<{ item: DonorItemView; index: number } | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)

  /** 唯一模型列表 */
  const models = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) if (it.model) set.add(it.model)
    return Array.from(set).sort()
  }, [items])

  /** 过滤 + 排序 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = items.filter((it) => {
      if (q && !(it.prompt?.toLowerCase().includes(q) || String(it.model || '').toLowerCase().includes(q))) {
        return false
      }
      if (model && it.model !== model) return false
      if (status !== 'all' && it.status !== status) return false
      return true
    })
    list = [...list].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : Number(a.id) || 0
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : Number(b.id) || 0
      return sort === 'newest' ? tb - ta : ta - tb
    })
    return list
  }, [items, query, model, status, sort])

  const handleDelete = useCallback(
    async (id: number | string) => {
      const ok = await deleteItem(id)
      addToast({
        type: ok ? 'success' : 'error',
        message: ok ? '已删除 / DELETED' : '删除失败 / FAILED',
      })
    },
    [deleteItem, addToast]
  )

  const handleClear = useCallback(async () => {
    if (items.length === 0) return
    if (!window.confirm(`确认清空全部 ${items.length} 条记录? / WIPE ALL (${items.length})?`)) return
    const n = await clear()
    addToast({ type: 'success', message: `已清空 ${n} 条 / WIPED ${n}` })
  }, [items.length, clear, addToast])

  const handlePreview = useCallback((item: DonorItemView, index: number) => {
    if (item.displayUrls.length === 0) return
    setPreview({ item, index })
  }, [])

  return (
    <DonorShell>
      {/* 背景装饰大字
       * 注意:必须用 inline style 强制 position:absolute,
       * 否则会被 .donor-theme > *:not(.donor-portal-modal){position:relative} 规则覆盖,
       * 导致 180px 高度变成流式占位,把整个 Header 顶下去 ~180px */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none d-mono font-black leading-none"
        style={{
          position: 'absolute',
          right: '12px',
          top: '-8px',
          fontSize: '180px',
          opacity: 0.08,
          color: 'var(--donor-magenta)',
          zIndex: 1,
        }}
      >
        04
      </div>

      <DonorHeader
        total={stats.total}
        cloud={stats.cloud}
        local={stats.local}
        failed={stats.failed}
        uploading={stats.uploading}
        onOpenStorage={() => setStorageOpen(true)}
        onClear={handleClear}
      />

      <DonorFilterBar
        query={query}
        onQueryChange={setQuery}
        model={model}
        onModelChange={setModel}
        models={models}
        status={status}
        onStatusChange={setStatus}
        sort={sort}
        onSortChange={setSort}
        matchedCount={filtered.length}
        totalCount={stats.total}
      />

      {filtered.length === 0 ? (
        <DonorEmpty hasFilter={stats.total > 0} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((it) => (
            <DonorCard key={it.id} item={it} onDelete={handleDelete} onPreview={handlePreview} />
          ))}
        </div>
      )}

      {/* 底部 HUD 装饰条 */}
      <footer className="mt-6 pt-3 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex items-center justify-between flex-wrap gap-2">
        <span>
          // DONOR_ARCHIVE_v1.0 — buffer_size {stats.total.toString().padStart(4, '0')} / integrity OK
        </span>
        <span className="d-neon-text-c">[ EOF ]</span>
      </footer>

      {preview && <DonorPreview item={preview.item} startIndex={preview.index} onClose={() => setPreview(null)} />}
      {storageOpen && (
        <DonorStorageModal
          onClose={() => setStorageOpen(false)}
          onSaved={() => addToast({ type: 'success', message: '存储配置已保存 / CFG SAVED' })}
        />
      )}
    </DonorShell>
  )
}
