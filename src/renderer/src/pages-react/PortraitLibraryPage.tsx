// 人像库页面 —— 浏览 / 搜索 / 上传 / 选择 Seedance 素材库（人像分类）图片。
// 数据来自上游 /api/open/v1/local-assets（主进程 IPC 转发，HMAC 签名）。
// 视频生成 (generate_video) 的参考图会自动入库到这里；在本页选中图片后可
// 复制 asset:// 引用或一键发送到 Agent 对话，用于人物一致性的视频生成。

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
  SeedanceAssetListResult,
} from '../../../types/seedance'
import { useToastStore, useTabStore } from '../stores'
import { useAgentChatStore } from '../features/agent-chat'

const PAGE_SIZE = 24
/** data: URL 内联上限（与主进程 generate_video 同口径，base64 膨胀后 ≈4.7MB）。 */
const MAX_UPLOAD_BYTES = Math.floor(3.5 * 1024 * 1024)

const KIND_FILTERS: Array<{ value: SeedanceAssetKindFilter; label: string }> = [
  { value: 'image_people', label: '👤 人像' },
  { value: 'image_environment', label: '🏞 环境' },
  { value: 'all', label: '全部' },
]

interface SeedanceAssetsApi {
  getConfig?: () => Promise<{ hasKey: boolean; hasSecret?: boolean }>
  listAssets?: (query: {
    page?: number
    pageSize?: number
    q?: string
    kind?: SeedanceAssetKindFilter
  }) => Promise<SeedanceAssetListResult>
  importAsset?: (input: {
    kind: 'image'
    url: string
    name?: string
    mimeType?: string
    imageCategory?: 'image_people' | 'image_environment'
  }) => Promise<{ duplicated: boolean; asset: SeedanceAssetItem }>
}

function seedanceApi(): SeedanceAssetsApi | undefined {
  return (window as unknown as { electronAPI?: { seedance?: SeedanceAssetsApi } }).electronAPI?.seedance
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export default function PortraitLibraryPage() {
  const addToast = useToastStore((s) => s.addToast)
  const switchTab = useTabStore((s) => s.switchTab)

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [items, setItems] = useState<SeedanceAssetItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [summary, setSummary] = useState<{ used: number; limit: number; remaining: number } | null>(null)
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState<SeedanceAssetKindFilter>('image_people')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoomAsset, setZoomAsset] = useState<SeedanceAssetItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selected = items.find((it) => it.id === selectedId) ?? null

  useEffect(() => {
    seedanceApi()
      ?.getConfig?.()
      .then((state) => setConfigured(!!state?.hasKey && !!state?.hasSecret))
      .catch(() => setConfigured(false))
  }, [])

  const load = useCallback(async () => {
    const api = seedanceApi()
    if (!api?.listAssets) {
      setError('Seedance 接口不可用（preload 未加载）')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.listAssets({ page, pageSize: PAGE_SIZE, kind, ...(query ? { q: query } : {}) })
      setItems(result.items)
      setTotal(result.total)
      setTotalPages(Math.max(1, result.totalPages))
      setSummary(result.summary ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [page, kind, query])

  useEffect(() => {
    if (configured) void load()
  }, [configured, load])

  const handleSearch = () => {
    setPage(1)
    setQuery(searchInput.trim())
  }

  const handleUpload = async (files: FileList | null) => {
    const api = seedanceApi()
    if (!files || files.length === 0 || !api?.importAsset) return
    setUploading(true)
    let imported = 0
    let duplicated = 0
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) {
          addToast({ message: `跳过非图片文件: ${file.name}`, type: 'error' })
          continue
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          addToast({ message: `${file.name} 超过 3.5MB 上限，请先压缩`, type: 'error' })
          continue
        }
        const dataUrl = await readFileAsDataUrl(file)
        const result = await api.importAsset({
          kind: 'image',
          imageCategory: 'image_people',
          url: dataUrl,
          name: file.name,
          mimeType: file.type,
        })
        if (result.duplicated) duplicated += 1
        else imported += 1
      }
      const parts = [
        imported > 0 ? `新增 ${imported} 张` : '',
        duplicated > 0 ? `${duplicated} 张已存在（按内容去重）` : '',
      ].filter(Boolean)
      if (parts.length > 0) addToast({ message: `人像库上传完成：${parts.join('，')}`, type: 'success' })
      setPage(1)
      await load()
    } catch (e) {
      addToast({ message: `上传失败: ${e instanceof Error ? e.message : String(e)}`, type: 'error' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      addToast({ message: `${label} 已复制`, type: 'success' })
    } catch {
      addToast({ message: '复制失败', type: 'error' })
    }
  }

  const sendToAgent = (asset: SeedanceAssetItem) => {
    const chat = useAgentChatStore.getState()
    chat.appendInputText(
      `${chat.input && !chat.input.endsWith(' ') ? ' ' : ''}用人像库图片「${asset.name}」(${asset.assetUrl}) 作为参考生成视频：`,
    )
    if (!chat.isOpen) chat.toggle()
    addToast({ message: '已插入 Agent 对话输入框', type: 'success' })
  }

  if (configured === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
        <div className="text-5xl">👤</div>
        <h2 className="text-xl font-bold text-white">人像库未就绪</h2>
        <p className="text-sm text-zinc-400 max-w-md">
          人像库依赖 Seedance 素材接口，需要在设置页配置 Seedance API Key 和 API Secret
          （素材接口使用 HMAC 签名）。配置完成后，视频生成的参考图会自动入库到这里。
        </p>
        <button
          onClick={() => switchTab('settings')}
          className="px-4 py-2 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm uppercase rounded hover:opacity-90"
        >
          前往设置
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4 max-w-7xl mx-auto w-full">
      {/* 顶栏：标题 + 配额 + 上传 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <span>👤</span> 人像库
          </h1>
          <span className="text-xs text-zinc-500">
            {total} 个素材{summary ? ` · 配额 ${summary.used}/${summary.limit}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm rounded hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? '上传中…' : '⬆ 上传人像'}
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700 disabled:opacity-50"
          >
            🔄 刷新
          </button>
        </div>
      </div>

      {/* 过滤 + 搜索 */}
      <div className="flex items-center gap-2 flex-wrap">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => {
              setKind(f.value)
              setPage(1)
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
        <div className="flex items-center gap-1 ml-auto">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="按名称 / assetId 搜索"
            className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-1.5 rounded w-56"
          />
          <button
            onClick={handleSearch}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
          >
            🔍
          </button>
        </div>
      </div>

      {/* 选中操作条 */}
      {selected && (
        <div className="flex items-center gap-2 flex-wrap bg-zinc-900 border border-cyberpunk-yellow/40 rounded px-3 py-2">
          <span className="text-sm text-white truncate max-w-[200px]" title={selected.name}>
            ✅ {selected.name}
          </span>
          <code className="text-xs text-zinc-500 truncate max-w-[220px]" title={selected.assetUrl}>
            {selected.assetUrl}
          </code>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => sendToAgent(selected)}
              className="px-3 py-1 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-xs rounded hover:opacity-90"
            >
              🎬 发送到 Agent 生成视频
            </button>
            <button
              onClick={() => void copyText(selected.assetUrl, 'asset:// 引用')}
              className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
            >
              📋 复制引用
            </button>
            <button
              onClick={() => setZoomAsset(selected)}
              className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
            >
              🔍 查看大图
            </button>
            <button
              onClick={() => setSelectedId(null)}
              className="px-2 py-1 text-zinc-500 text-xs hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <p className="text-sm text-red-400 max-w-md break-all">{error}</p>
            <button
              onClick={() => void load()}
              className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
            >
              重试
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center text-zinc-500">
            <div className="text-4xl">🗂</div>
            <p className="text-sm">人像库还是空的</p>
            <p className="text-xs">点击「上传人像」导入图片，或在 Agent 对话里用图片生成视频（参考图会自动入库）</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {items.map((asset) => {
              const isSelected = asset.id === selectedId
              const thumb = asset.previewUrl || asset.sourceUrl
              return (
                <button
                  key={asset.id}
                  onClick={() => setSelectedId(isSelected ? null : asset.id)}
                  onDoubleClick={() => setZoomAsset(asset)}
                  title={`${asset.name}\n${asset.assetUrl}`}
                  className={`group relative bg-zinc-900 rounded overflow-hidden border text-left transition-all ${
                    isSelected
                      ? 'border-cyberpunk-yellow ring-2 ring-cyberpunk-yellow/50'
                      : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  <div className="aspect-square bg-zinc-800 flex items-center justify-center overflow-hidden">
                    {thumb ? (
                      <img src={thumb} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-3xl">{asset.kind === 'video' ? '🎞' : asset.kind === 'audio' ? '🎵' : '🖼'}</span>
                    )}
                  </div>
                  {isSelected && (
                    <span className="absolute top-1.5 right-1.5 w-5 h-5 bg-cyberpunk-yellow text-cyberpunk-black text-xs font-bold rounded-full flex items-center justify-center">
                      ✓
                    </span>
                  )}
                  {asset.imageCategory === 'image_people' && (
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/60 text-[10px] text-cyberpunk-yellow rounded">
                      人像
                    </span>
                  )}
                  <div className="px-2 py-1.5">
                    <p className="text-xs text-white truncate">{asset.name}</p>
                    <p className="text-[10px] text-zinc-500">{formatBytes(asset.sizeBytes)}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 rounded disabled:opacity-40 hover:bg-zinc-700"
          >
            上一页
          </button>
          <span className="text-zinc-400">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 rounded disabled:opacity-40 hover:bg-zinc-700"
          >
            下一页
          </button>
        </div>
      )}

      {/* 大图预览 */}
      {zoomAsset && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setZoomAsset(null)}
        >
          <div className="max-w-4xl max-h-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <img
              src={zoomAsset.previewUrl || zoomAsset.sourceUrl}
              alt={zoomAsset.name}
              className="max-w-full max-h-[80vh] object-contain rounded"
            />
            <div className="flex items-center gap-3 text-sm text-zinc-300">
              <span className="truncate max-w-[240px]">{zoomAsset.name}</span>
              <button
                onClick={() => void copyText(zoomAsset.assetUrl, 'asset:// 引用')}
                className="px-3 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs hover:bg-zinc-700"
              >
                📋 复制引用
              </button>
              <button
                onClick={() => setZoomAsset(null)}
                className="px-3 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs hover:bg-zinc-700"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
