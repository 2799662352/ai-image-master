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
import { usePortraitLibraryOverlay } from '../hooks/usePortraitLibraryOverlay'

const PAGE_SIZE = 24
/** 分组过滤的特殊伪分组值（与用户自定义分组名共用一个 string 状态）。 */
const GROUP_ALL = '__all__'
const GROUP_UNGROUPED = '__ungrouped__'
const GROUP_HIDDEN = '__hidden__'
/** 上游素材库限制：图片单张 ≤30MB；视频 ≤50MB 且 4-15s；音频 4-15s。 */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MEDIA_MIN_SECONDS = 4
const MEDIA_MAX_SECONDS = 15

const KIND_FILTERS: Array<{ value: SeedanceAssetKindFilter; label: string }> = [
  { value: 'image_people', label: '👤 人像' },
  { value: 'image_environment', label: '🏞 环境' },
  { value: 'video', label: '🎞 视频' },
  { value: 'audio', label: '🎵 音频' },
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
    kind: 'image' | 'video' | 'audio'
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

/** URL 去掉 query/hash 后以视频扩展名结尾 —— 用来识别"假 poster"(上游把视频
 *  地址塞进 previewUrl 时,拿它当 <img> 会渲染成碎图)。 */
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i

/**
 * 视频首帧缩略图策略 —— 与聊天栏 MediaThumbnail 完全一致。
 *
 * metadata 加载后**命令式** seek 到 ~0.1s,强制 Chromium 解码并*绘制*首帧。
 * 单靠 URL 媒体片段 `#t=0.1` + `preload="metadata"` 在部分源(Range 支持
 * 不全 / 跨域)下只会拉元数据、不触发帧绘制,导致缩略图黑屏(本次 bug)。
 */
function seekVideoToFirstFrame(e: React.SyntheticEvent<HTMLVideoElement>): void {
  const v = e.currentTarget
  try {
    v.currentTime = Math.min(0.1, (v.duration || 1) * 0.1)
  } catch {
    /* seek 失败不致命,退化为黑屏占位 */
  }
}

/** 读取视频/音频时长（秒），读取失败返回 null（不阻断上传，交给上游校验）。 */
function probeMediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(el.duration) ? el.duration : null)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    el.src = url
  })
}

/**
 * 按上游限制校验文件；返回 null 表示通过，否则返回错误文案。
 * 图片 ≤30MB；视频 ≤50MB 且 4-15s；音频 4-15s。
 */
async function validateUploadFile(file: File): Promise<string | null> {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) return `${file.name} 超过图片 30MB 上限`
    return null
  }
  if (file.type.startsWith('video/')) {
    if (file.size > MAX_VIDEO_BYTES) return `${file.name} 超过视频 50MB 上限`
  } else if (!file.type.startsWith('audio/')) {
    return `跳过不支持的文件: ${file.name}（仅支持图片/视频/音频）`
  }
  const duration = await probeMediaDuration(file)
  if (duration != null && (duration < MEDIA_MIN_SECONDS || duration > MEDIA_MAX_SECONDS)) {
    return `${file.name} 时长 ${duration.toFixed(1)}s 不在 4-15s 范围内`
  }
  return null
}

/**
 * 自建文本输入弹窗 —— Electron 渲染进程不实现 window.prompt(始终返回 null),
 * 改名 / 新建分组必须用这个。组件自持输入态,避免父组件每次 render 抢焦点。
 */
function TextPromptModal({
  title,
  placeholder,
  initial,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  placeholder?: string
  initial: string
  confirmLabel: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(initial)
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6" onClick={onCancel}>
      <div
        className="w-full max-w-sm bg-zinc-900 border border-cyberpunk-yellow/40 rounded-lg p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-bold text-white">{title}</h3>
        <input
          autoFocus
          value={val}
          placeholder={placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(val)
            else if (e.key === 'Escape') onCancel()
          }}
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded w-full"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(val)}
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm rounded hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PortraitLibraryPage() {
  const addToast = useToastStore((s) => s.addToast)
  const switchTab = useTabStore((s) => s.switchTab)

  // 经典壳（index.html）里设置是模态框（SiteManager），React 壳里是 settings tab。
  const openSettings = () => {
    const siteManager = (window as unknown as { siteManagerTS?: { openSettingsModal?: () => void } }).siteManagerTS
    if (siteManager?.openSettingsModal) siteManager.openSettingsModal()
    else switchTab('settings')
  }

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [items, setItems] = useState<SeedanceAssetItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState<SeedanceAssetKindFilter>('image_people')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  /** 上传中的乐观占位（在网格里先显示带 spinner 的灰块，导入成功后由真实列表替换）。 */
  const [pendingUploads, setPendingUploads] = useState<
    Array<{ tempId: string; name: string; kind: 'image' | 'video' | 'audio'; thumb?: string; done?: boolean }>
  >([])
  // 默认多选:selectedIds 按 assetId(上游稳定标识)存,跨翻页/分类保持一致。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [zoomAsset, setZoomAsset] = useState<SeedanceAssetItem | null>(null)
  // 分组过滤:'__all__' | '__ungrouped__' | '__hidden__' | <用户自定义分组名>
  const [groupFilter, setGroupFilter] = useState<string>(GROUP_ALL)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [textPrompt, setTextPrompt] = useState<{
    title: string
    placeholder?: string
    initial: string
    confirmLabel: string
    onConfirm: (value: string) => void
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 本地叠加层:自定义名 / 分组 / 软删除(隐藏)。纯本地、离线可用。
  const overlay = usePortraitLibraryOverlay()
  /**
   * 列表结果缓存,key = `${kind}|${page}|${query}`。
   * 切换分类/翻页时优先命中缓存 → 同步铺数据,不打网络、不闪 spinner、不"全量遗忘"。
   * 在被代理频繁断连的网络下,这是消除卡顿的关键(每次切换原本都要重新签名 + net.fetch)。
   * 上传 / 手动刷新时清空缓存强制回源。
   */
  const cacheRef = useRef<Map<string, SeedanceAssetListResult>>(new Map())

  /** 自定义显示名(覆盖上游 name)。 */
  const displayName = useCallback(
    (a: SeedanceAssetItem): string => overlay.entries[a.assetId]?.name || a.name,
    [overlay.entries],
  )

  // 应用叠加层过滤:已隐藏视图只看 hidden;其余视图排除 hidden,再按分组筛。
  const isHiddenView = groupFilter === GROUP_HIDDEN
  const displayItems = items.filter((a) => {
    const ov = overlay.entries[a.assetId]
    const hidden = !!ov?.hidden
    if (isHiddenView) return hidden
    if (hidden) return false
    if (groupFilter === GROUP_ALL) return true
    if (groupFilter === GROUP_UNGROUPED) return !ov?.group
    return ov?.group === groupFilter
  })
  const selectedAssets = items.filter((a) => selectedIds.has(a.assetId))
  const selectedIdList = Array.from(selectedIds)

  const toggleSelect = useCallback((assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  // 配置探测:必须区分「主进程 handler / preload 尚未就绪(Promise reject)」与
  // 「确实没配置(resolve 出 hasKey/hasSecret=false)」。前者在启动早期属正常竞态
  // (主进程注册 seedance IPC 与渲染端挂载抢跑),应退避重试而非一次失败就钉死;
  // 后者才显示「未就绪」。否则配合 AppLayout 的 <Activity>(标签页常驻不重挂),
  // 一次 reject 会把人像库永久卡在未就绪,只能整页刷新——正是本次要修的 bug。
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 20 // 20 × 300ms ≈ 6s,足够覆盖冷启动 IPC 注册窗口
    const RETRY_MS = 300
    const probe = (): void => {
      if (cancelled) return
      const api = seedanceApi()
      if (!api?.getConfig) {
        // preload 尚未注入 electronAPI.seedance —— 稍后重试。
        if (attempts++ < MAX_ATTEMPTS) setTimeout(probe, RETRY_MS)
        return
      }
      api
        .getConfig()
        .then((state) => {
          if (!cancelled) setConfigured(!!state?.hasKey && !!state?.hasSecret)
        })
        .catch(() => {
          // handler 还没注册好(竞态)或瞬时错误 —— 退避重试,不要 latch 到 false。
          if (!cancelled && attempts++ < MAX_ATTEMPTS) setTimeout(probe, RETRY_MS)
          else if (!cancelled) setConfigured(false)
        })
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  const applyResult = useCallback((result: SeedanceAssetListResult) => {
    setItems(result.items)
    setTotal(result.total)
    setTotalPages(Math.max(1, result.totalPages))
  }, [])

  const load = useCallback(
    async (opts?: { force?: boolean }) => {
      const api = seedanceApi()
      if (!api?.listAssets) {
        setError('Seedance 接口不可用（preload 未加载）')
        return
      }
      const cacheKey = `${kind}|${page}|${query}`
      if (!opts?.force) {
        const cached = cacheRef.current.get(cacheKey)
        if (cached) {
          // 命中缓存:同步铺数据,零网络、零闪烁。
          applyResult(cached)
          setError(null)
          return
        }
      }
      setLoading(true)
      setError(null)
      try {
        const result = await api.listAssets({ page, pageSize: PAGE_SIZE, kind, ...(query ? { q: query } : {}) })
        cacheRef.current.set(cacheKey, result)
        applyResult(result)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [page, kind, query, applyResult],
  )

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
    const fileList = Array.from(files)
    setUploading(true)

    // 先为每个文件铺一个乐观占位（图片带本地缩略图），让网格立即有反馈。
    const placeholders = fileList.map((file, i) => {
      const kind = file.type.startsWith('video/')
        ? ('video' as const)
        : file.type.startsWith('audio/')
          ? ('audio' as const)
          : ('image' as const)
      return {
        tempId: `pending-${Date.now()}-${i}`,
        name: file.name,
        kind,
        thumb: kind === 'image' ? URL.createObjectURL(file) : undefined,
      }
    })
    setPendingUploads(placeholders)

    let imported = 0
    let duplicated = 0
    let failed = 0
    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i]
        const ph = placeholders[i]
        const problem = await validateUploadFile(file)
        if (problem) {
          addToast({ message: problem, type: 'error' })
          failed += 1
          setPendingUploads((prev) => prev.filter((p) => p.tempId !== ph.tempId))
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const result = await api.importAsset({
            kind: ph.kind,
            ...(ph.kind === 'image' ? { imageCategory: 'image_people' as const } : {}),
            url: dataUrl,
            name: file.name,
            mimeType: file.type,
          })
          if (result.duplicated) duplicated += 1
          else imported += 1
          setPendingUploads((prev) => prev.map((p) => (p.tempId === ph.tempId ? { ...p, done: true } : p)))
        } catch (e) {
          failed += 1
          addToast({ message: `${file.name} 上传失败: ${e instanceof Error ? e.message : String(e)}`, type: 'error' })
          setPendingUploads((prev) => prev.filter((p) => p.tempId !== ph.tempId))
        }
      }
      const parts = [
        imported > 0 ? `新增 ${imported} 个` : '',
        duplicated > 0 ? `${duplicated} 个已存在（按内容去重）` : '',
        failed > 0 ? `${failed} 个失败` : '',
      ].filter(Boolean)
      if (parts.length > 0) {
        addToast({ message: `人像库上传完成：${parts.join('，')}`, type: failed > 0 && imported + duplicated === 0 ? 'error' : 'success' })
      }
      // 上传改变了列表,缓存全部失效 → 清空后强制回源。
      cacheRef.current.clear()
      setPage(1)
      await load({ force: true })
    } finally {
      setUploading(false)
      // 释放本地缩略图 objectURL，并清空占位。
      placeholders.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb))
      setPendingUploads([])
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

  const sendAssetsToAgent = (assets: SeedanceAssetItem[]) => {
    if (assets.length === 0) return
    const chat = useAgentChatStore.getState()
    const refs = assets.map((a) => `「${displayName(a)}」(${a.assetUrl})`).join('、')
    chat.appendInputText(
      `${chat.input && !chat.input.endsWith(' ') ? ' ' : ''}用人像库素材 ${refs} 作为参考生成视频：`,
    )
    if (!chat.isOpen) chat.toggle()
    addToast({ message: `已插入 ${assets.length} 个素材到 Agent 对话`, type: 'success' })
  }

  // ===== 批量操作(本地叠加层)=====
  const handleRename = (asset: SeedanceAssetItem) => {
    setTextPrompt({
      title: '重命名素材',
      placeholder: '留空则恢复原名',
      initial: displayName(asset),
      confirmLabel: '保存',
      onConfirm: (value) => {
        overlay.rename(asset.assetId, value)
        setTextPrompt(null)
        addToast({ message: '已重命名', type: 'success' })
      },
    })
  }

  const handleHide = (ids: string[], hidden: boolean) => {
    if (ids.length === 0) return
    overlay.setHidden(ids, hidden)
    clearSelection()
    addToast({ message: hidden ? `已隐藏 ${ids.length} 个素材(可在「已隐藏」恢复)` : `已恢复 ${ids.length} 个素材`, type: 'success' })
  }

  const handleMoveToGroup = (group: string | undefined) => {
    setMoveMenuOpen(false)
    if (selectedIdList.length === 0) return
    overlay.moveToGroup(selectedIdList, group)
    addToast({ message: group ? `已移动 ${selectedIdList.length} 个到「${group}」` : `已移出分组`, type: 'success' })
    clearSelection()
  }

  const handleNewGroupForSelection = () => {
    setMoveMenuOpen(false)
    setTextPrompt({
      title: '新建分组并移入所选素材',
      placeholder: '分组名',
      initial: '',
      confirmLabel: '创建',
      onConfirm: (value) => {
        const name = value.trim()
        if (!name) return
        overlay.moveToGroup(selectedIdList, name)
        setTextPrompt(null)
        addToast({ message: `已创建分组「${name}」并移入 ${selectedIdList.length} 个素材`, type: 'success' })
        clearSelection()
      },
    })
  }

  const handleCreateEmptyGroup = () => {
    setTextPrompt({
      title: '新建分组',
      placeholder: '分组名',
      initial: '',
      confirmLabel: '创建',
      onConfirm: (value) => {
        const name = value.trim()
        if (!name) return
        overlay.addGroup(name)
        setTextPrompt(null)
        addToast({ message: `已创建分组「${name}」`, type: 'success' })
      },
    })
  }

  const handleDeleteGroup = (name: string) => {
    overlay.removeGroup(name)
    if (groupFilter === name) setGroupFilter(GROUP_ALL)
    addToast({ message: `已删除分组「${name}」(素材已移出分组,未删除)`, type: 'success' })
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
          onClick={openSettings}
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
          <span className="text-xs text-zinc-500">{total} 个素材 · 配额无限</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm rounded hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? '上传中…' : '⬆ 上传素材'}
          </button>
          <button
            onClick={() => {
              cacheRef.current.clear()
              void load({ force: true })
            }}
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

      {/* 分组栏(本地自定义分组) */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-zinc-500">分组:</span>
        {[
          { value: GROUP_ALL, label: '全部' },
          { value: GROUP_UNGROUPED, label: '未分组' },
        ].map((g) => (
          <button
            key={g.value}
            onClick={() => {
              setGroupFilter(g.value)
              clearSelection()
            }}
            className={`px-2.5 py-1 rounded-full ${
              groupFilter === g.value
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-bold'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            {g.label}
          </button>
        ))}
        {overlay.groups.map((name) => (
          <span
            key={name}
            className={`group/chip inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full ${
              groupFilter === name
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-bold'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            <button
              onClick={() => {
                setGroupFilter(name)
                clearSelection()
              }}
            >
              🏷 {name}
            </button>
            <button
              title="删除分组(不删素材)"
              onClick={() => handleDeleteGroup(name)}
              className="opacity-50 hover:opacity-100 hover:text-red-400 px-0.5"
            >
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={handleCreateEmptyGroup}
          className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 hover:text-white border border-dashed border-zinc-600"
        >
          ＋ 新建分组
        </button>
        <button
          onClick={() => {
            setGroupFilter(GROUP_HIDDEN)
            clearSelection()
          }}
          className={`px-2.5 py-1 rounded-full ml-auto ${
            groupFilter === GROUP_HIDDEN
              ? 'bg-red-500 text-white font-bold'
              : 'bg-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          🗑 已隐藏
        </button>
      </div>

      {/* 批量操作条 */}
      {selectedIds.size > 0 && (
        <div className="relative flex items-center gap-2 flex-wrap bg-zinc-900 border border-cyberpunk-yellow/40 rounded px-3 py-2">
          <span className="text-sm text-white font-bold">已选 {selectedIds.size} 个</span>
          {selectedAssets.length === 1 && (
            <code className="text-xs text-zinc-500 truncate max-w-[220px]" title={selectedAssets[0].assetUrl}>
              {selectedAssets[0].assetUrl}
            </code>
          )}
          <div className="flex items-center gap-2 ml-auto">
            {selectedAssets.length >= 1 && (
              <button
                onClick={() => sendAssetsToAgent(selectedAssets)}
                className="px-3 py-1 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-xs rounded hover:opacity-90"
              >
                🎬 发送到 Agent
              </button>
            )}
            {!isHiddenView && (
              <div className="relative">
                <button
                  onClick={() => setMoveMenuOpen((v) => !v)}
                  className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
                >
                  📁 移动到分组 ▾
                </button>
                {moveMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMoveMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] max-h-64 overflow-auto bg-zinc-900 border border-zinc-600 rounded shadow-xl py-1">
                      {overlay.groups.length === 0 && (
                        <div className="px-3 py-1.5 text-xs text-zinc-500">暂无分组</div>
                      )}
                      {overlay.groups.map((name) => (
                        <button
                          key={name}
                          onClick={() => handleMoveToGroup(name)}
                          className="block w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                        >
                          🏷 {name}
                        </button>
                      ))}
                      <button
                        onClick={() => handleMoveToGroup(undefined)}
                        className="block w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 border-t border-zinc-700"
                      >
                        移出分组
                      </button>
                      <button
                        onClick={handleNewGroupForSelection}
                        className="block w-full text-left px-3 py-1.5 text-xs text-cyberpunk-yellow hover:bg-zinc-700"
                      >
                        ＋ 新建分组…
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {selectedAssets.length === 1 && (
              <button
                onClick={() => handleRename(selectedAssets[0])}
                className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
              >
                ✏️ 重命名
              </button>
            )}
            {selectedAssets.length === 1 && (
              <button
                onClick={() => void copyText(selectedAssets[0].assetUrl, 'asset:// 引用')}
                className="px-3 py-1 bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs rounded hover:bg-zinc-700"
              >
                📋 复制引用
              </button>
            )}
            {isHiddenView ? (
              <button
                onClick={() => handleHide(selectedIdList, false)}
                className="px-3 py-1 bg-zinc-800 border border-cyberpunk-yellow/50 text-cyberpunk-yellow text-xs rounded hover:bg-zinc-700"
              >
                ♻ 恢复
              </button>
            ) : (
              <button
                onClick={() => handleHide(selectedIdList, true)}
                className="px-3 py-1 bg-zinc-800 border border-red-500/50 text-red-400 text-xs rounded hover:bg-zinc-700"
              >
                🗑 删除(隐藏)
              </button>
            )}
            <button onClick={clearSelection} className="px-2 py-1 text-zinc-500 text-xs hover:text-white">
              ✕ 清除
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
              onClick={() => void load({ force: true })}
              className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
            >
              重试
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
          </div>
        ) : displayItems.length === 0 && pendingUploads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center text-zinc-500">
            <div className="text-4xl">🗂</div>
            {isHiddenView ? (
              <p className="text-sm">没有已隐藏的素材</p>
            ) : groupFilter !== GROUP_ALL && items.length > 0 ? (
              <p className="text-sm">
                {groupFilter === GROUP_UNGROUPED ? '没有未分组的素材' : `分组「${groupFilter}」暂无素材`}
              </p>
            ) : (
              <>
                <p className="text-sm">人像库还是空的</p>
                <p className="text-xs">
                  点击「上传素材」导入图片（≤30MB）/ 视频（≤50MB，4-15s）/ 音频（4-15s），
                  或在 Agent 对话里用图片生成视频（参考图会自动入库）
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {pendingUploads.map((ph) => (
              <div
                key={ph.tempId}
                className="relative bg-zinc-900 rounded overflow-hidden border border-cyberpunk-yellow/40"
              >
                <div className="aspect-square bg-zinc-800 flex items-center justify-center overflow-hidden">
                  {ph.thumb ? (
                    <img src={ph.thumb} alt={ph.name} className="w-full h-full object-cover opacity-50" />
                  ) : (
                    <span className="text-3xl opacity-50">{ph.kind === 'video' ? '🎞' : ph.kind === 'audio' ? '🎵' : '🖼'}</span>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    {ph.done ? (
                      <span className="text-cyberpunk-yellow text-2xl">✓</span>
                    ) : (
                      <div className="w-6 h-6 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
                    )}
                  </div>
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-xs text-white truncate">{ph.name}</p>
                  <p className="text-[10px] text-cyberpunk-yellow">{ph.done ? '已上传' : '上传中…'}</p>
                </div>
              </div>
            ))}
            {displayItems.map((asset) => {
              const isSelected = selectedIds.has(asset.assetId)
              const assetGroup = overlay.entries[asset.assetId]?.group
              const isVideo = asset.kind === 'video'
              const isAudio = asset.kind === 'audio'
              // 图片缩略图仅用于 image 类型(优先后台预览图,无则原图)。
              const imageThumb = !isVideo && !isAudio ? asset.previewUrl || asset.sourceUrl : undefined
              // 视频统一用 <video> 取首帧:previewUrl 仅当确实是图片 poster 时才用,
              // 否则(上游常把 mp4 地址塞进 previewUrl)会被 <img> 渲染成碎图。
              const videoSrc = isVideo ? asset.sourceUrl : undefined
              const videoPoster =
                isVideo && asset.previewUrl && !VIDEO_URL_RE.test(asset.previewUrl)
                  ? asset.previewUrl
                  : undefined
              return (
                <button
                  key={asset.id}
                  onClick={() => toggleSelect(asset.assetId)}
                  onDoubleClick={() => setZoomAsset(asset)}
                  title={`${displayName(asset)}\n${asset.assetUrl}`}
                  className={`group relative bg-zinc-900 rounded overflow-hidden border text-left transition-all ${
                    isSelected
                      ? 'border-cyberpunk-yellow ring-2 ring-cyberpunk-yellow/50'
                      : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  <div className="relative aspect-square bg-zinc-800 flex items-center justify-center overflow-hidden">
                    {isVideo ? (
                      videoSrc ? (
                        <video
                          src={videoSrc}
                          poster={videoPoster}
                          muted
                          playsInline
                          preload="metadata"
                          controls={false}
                          onLoadedMetadata={seekVideoToFirstFrame}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-3xl">🎞</span>
                      )
                    ) : isAudio ? (
                      <span className="text-3xl">🎵</span>
                    ) : imageThumb ? (
                      <img src={imageThumb} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-3xl">🖼</span>
                    )}
                    {(isVideo || isAudio) && (
                      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 text-[10px] text-white rounded">
                        {isVideo ? '▶ 视频' : '🎵 音频'}
                      </span>
                    )}
                  </div>
                  {isSelected && (
                    <span className="absolute top-1.5 right-1.5 w-5 h-5 bg-cyberpunk-yellow text-cyberpunk-black text-xs font-bold rounded-full flex items-center justify-center">
                      ✓
                    </span>
                  )}
                  {assetGroup ? (
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-cyberpunk-yellow/80 text-[10px] text-cyberpunk-black font-bold rounded truncate max-w-[80%]">
                      🏷 {assetGroup}
                    </span>
                  ) : (
                    asset.imageCategory === 'image_people' && (
                      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/60 text-[10px] text-cyberpunk-yellow rounded">
                        人像
                      </span>
                    )
                  )}
                  <div className="px-2 py-1.5">
                    <p className="text-xs text-white truncate">{displayName(asset)}</p>
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
            {zoomAsset.kind === 'video' ? (
              <video
                src={zoomAsset.sourceUrl || zoomAsset.previewUrl}
                controls
                autoPlay
                className="max-w-full max-h-[80vh] object-contain rounded"
              />
            ) : zoomAsset.kind === 'audio' ? (
              <div className="flex flex-col items-center gap-4 p-8">
                <span className="text-6xl">🎵</span>
                <audio src={zoomAsset.sourceUrl || zoomAsset.previewUrl} controls autoPlay className="w-80" />
              </div>
            ) : (
              <img
                src={zoomAsset.previewUrl || zoomAsset.sourceUrl}
                alt={zoomAsset.name}
                className="max-w-full max-h-[80vh] object-contain rounded"
              />
            )}
            <div className="flex items-center gap-3 text-sm text-zinc-300">
              <span className="truncate max-w-[240px]">{displayName(zoomAsset)}</span>
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

      {/* 文本输入弹窗(改名 / 新建分组) */}
      {textPrompt && (
        <TextPromptModal
          title={textPrompt.title}
          placeholder={textPrompt.placeholder}
          initial={textPrompt.initial}
          confirmLabel={textPrompt.confirmLabel}
          onConfirm={textPrompt.onConfirm}
          onCancel={() => setTextPrompt(null)}
        />
      )}
    </div>
  )
}
