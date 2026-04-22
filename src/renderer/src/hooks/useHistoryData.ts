/**
 * useHistoryData - React hook 桥接到 HistoryDataService (真数据源)
 * 不同于 useHistory.ts (独立 localStorage),此 hook 订阅 HistoryManager.onChange
 * 返回响应式 history items + 操作方法
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
import { getHistoryDataService } from '../features/history/HistoryDataService'

/**
 * 本文件显式声明 HistoryItem 字段结构,避免依赖 HistoryManager 中受 alias 解析问题影响的类型推断
 */
export interface RawHistoryItem {
  id: number | string
  prompt?: string
  model?: string
  timestamp?: string | number
  urls?: string[]
  originalUrls?: string[]
  uploading?: boolean
  r2Storage?: boolean
  ratio?: string
  type?: string
  resolution?: string
  metadata?: Record<string, any>
  [key: string]: any
}

export type DonorItemStatus = 'ok-cloud' | 'ok-local' | 'uploading' | 'failed'

export interface DonorItemView extends RawHistoryItem {
  status: DonorItemStatus
  displayUrls: string[]
  /** 是否为占位/损坏/失败项 (用于渲染失败卡片) */
  isBroken: boolean
}

/**
 * 推断单条记录的状态标签
 */
function inferStatus(item: RawHistoryItem): DonorItemStatus {
  if (item.uploading) return 'uploading'
  const urls = item.urls || []
  // 任一 url 带 pending: 前缀 → 上传中/失败
  const hasPending = urls.some((u) => typeof u === 'string' && u.startsWith('pending:'))
  if (hasPending) return 'uploading'
  if (urls.length === 0) return 'failed'
  // 有 r2Storage 标记 = 已上云;否则本地
  return item.r2Storage ? 'ok-cloud' : 'ok-local'
}

function toView(item: RawHistoryItem): DonorItemView {
  const status = inferStatus(item)
  const urls = item.urls || []
  // 替换 pending: 前缀为 originalUrls 中对应的 base64 (若有) 以便预览
  const displayUrls = urls.map((u, i) => {
    if (typeof u === 'string' && u.startsWith('pending:')) {
      return item.originalUrls?.[i] || ''
    }
    return u
  }).filter(Boolean)
  const isBroken = status === 'failed' || displayUrls.length === 0
  return { ...item, status, displayUrls, isBroken }
}

export interface UseHistoryData {
  items: DonorItemView[]
  loading: boolean
  delete: (id: number | string) => Promise<boolean>
  clear: () => Promise<number>
  refresh: () => void
  stats: { total: number; cloud: number; local: number; failed: number; uploading: number }
}

export function useHistoryData(): UseHistoryData {
  const service = useMemo(() => getHistoryDataService(), [])
  const [rawItems, setRawItems] = useState<RawHistoryItem[]>(() => service.getAll() as unknown as RawHistoryItem[])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setRawItems(service.getAll() as unknown as RawHistoryItem[])
    const unsubscribe = service.onChange((history) => {
      setRawItems([...(history as unknown as RawHistoryItem[])])
    })
    return unsubscribe
  }, [service])

  const deleteItem = useCallback(async (id: number | string) => {
    setLoading(true)
    try {
      return await service.delete(id)
    } finally {
      setLoading(false)
    }
  }, [service])

  const clear = useCallback(async () => {
    setLoading(true)
    try {
      // keepCount=0 -> 全部清空
      return await service.clearOldHistory(0)
    } finally {
      setLoading(false)
    }
  }, [service])

  const refresh = useCallback(() => {
    setRawItems([...(service.getAll() as unknown as RawHistoryItem[])])
  }, [service])

  const items = useMemo(() => rawItems.map(toView), [rawItems])

  const stats = useMemo(() => {
    const s = { total: items.length, cloud: 0, local: 0, failed: 0, uploading: 0 }
    for (const it of items) {
      if (it.status === 'ok-cloud') s.cloud++
      else if (it.status === 'ok-local') s.local++
      else if (it.status === 'failed') s.failed++
      else if (it.status === 'uploading') s.uploading++
    }
    return s
  }, [items])

  return { items, loading, delete: deleteItem, clear, refresh, stats }
}
