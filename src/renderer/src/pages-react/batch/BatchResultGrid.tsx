import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Grid, type CellComponentProps } from 'react-window'
import type { BatchItem } from '../../stores/useBatchStore'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'

/**
 * (v) 虚拟化布局常量
 *
 * 在 items >= VIRTUALIZE_THRESHOLD 时切换到 react-window 2.x 的 <Grid>,
 * 用"内嵌滚动条"渲染视口内的卡片。小批量(<30)继续走原 CSS Grid,
 * 保留页面整体滚动的 UX, 不破坏小用户场景。
 *
 *  - MIN_CARD_WIDTH      与原 CSS minmax(180px, 1fr) 保持一致
 *  - CARD_GAP            原 gap-3 = 12px, 卡片之间留白
 *  - CARD_TEXT_AREA_PX   卡片图片区下方 (顶部 row + prompt + 容错) 总高度上限
 *                        覆盖 paddings(16) + top row(24) + 2*gap(12) + prompt
 *                        line-clamp-2(33) + 可选 error 行(18) + buffer = 96
 *                        多预留 4px 给字体回退, 共 100 px
 *  - VIRTUALIZE_THRESHOLD  >= 30 启用虚拟化, < 30 走 CSS Grid 保留页面滚动
 *  - VIEWPORT_MAX_PX      内部滚动视口最大高度上限, 同时不超过 70vh
 */
const MIN_CARD_WIDTH = 180
const CARD_GAP = 12
const CARD_TEXT_AREA_PX = 100
const VIRTUALIZE_THRESHOLD = 30
const VIEWPORT_MAX_PX = 720

/**
 * (v) ResizeObserver 包装的尺寸 hook。
 * 同时监听 window resize 以更新内嵌网格高度(viewportH 跟 vh 走)。
 */
function useContainerSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const computeViewportH = () =>
      Math.max(360, Math.min(VIEWPORT_MAX_PX, Math.floor(window.innerHeight * 0.7)))

    const node = ref.current
    if (!node) return

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: Math.floor(entry.contentRect.width), height: computeViewportH() })
    })
    ro.observe(node)

    const onResize = () => {
      setSize((s) => ({ width: s.width, height: computeViewportH() }))
    }
    window.addEventListener('resize', onResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return { ref, width: size.width, height: size.height }
}

interface Props {
  items: BatchItem[]
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
  /**
   * 点击 ↺ 重编辑: 父组件拿到完整的 BatchItem(含 snapshot),
   * 然后复用 useBatchStore.restoreForEdit 把 prompt + ratio +
   * referenceImages 一起灌回批量表单 —— 跟 HistoryPage 的
   * ↺ BATCH 走同一条路径, 行为一致。
   *
   * 老的 onEditPrompt(只塞 prompt) 在用户反馈"图片没载入"后废弃。
   * 不传时按钮自动隐藏。
   */
  onEditItem?: (item: BatchItem) => void
}

async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  } catch {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

function buildFilename(index: number, prompt: string): string {
  const slug =
    prompt
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 24)
      .replace(/\s+/g, '_') || 'untitled'
  const ts = Date.now()
  const seq = String(index + 1).padStart(3, '0')
  return `batch-${seq}-${slug}-${ts}.png`
}

const STATUS_BADGE: Record<
  BatchItem['status'],
  { cls: string; label: string }
> = {
  pending:    { cls: 'border-zinc-700 text-zinc-400 bg-zinc-900',                          label: 'WAIT' },
  generating: { cls: 'border-cyberpunk-yellow/50 text-cyberpunk-yellow bg-cyberpunk-yellow/10', label: 'RUN' },
  done:       { cls: 'border-green-700/60 text-green-300 bg-green-950/30',                 label: 'OK' },
  error:      { cls: 'border-red-700/60 text-red-300 bg-red-950/30',                       label: 'ERR' },
}

/**
 * 渲染时优先用 cosUrl(异步存储后的持久化 URL),
 * 上传未完成或失败时 fallback 到 resultUrl(模型直出, 可能是临时签名链接)。
 */
function pickDisplayUrl(item: BatchItem): string | undefined {
  // P0 OOM 修复(2026-06-23): 优先 cosUrl(http 持久链接)。
  //
  // 旧逻辑优先 resultUrl(模型直出 base64)是为了「避免切源重新解码的卡顿」,
  // 但代价是每张 4K base64(~10MB)+ useDisplaySrc 产出的 blob + 解码位图一整次
  // 会话常驻 → 30 分钟/数百张后渲染进程内存耗尽卡死黑屏。两害相权: 偶发黑屏
  // 远比一次极轻微的解码抖动严重, 且上传是分散完成的(逐张切源, 非同时)。
  //
  // 上传成功后 store 已把 resultUrl 置空(见 useBatchStore cos handler), 这里
  // 再用 cosUrl 优先做防御兜底: 即便将来 store 忘了释放, 也优先走可回收的 http 源。
  return item.cosUrl ?? item.resultUrl
}

/**
 * (p4) 用 React.memo 包住, 让"item.status pending→generating→done"这种
 * **单条 item** 状态变更不再触发整网格里其他 N-1 张卡片重新渲染。
 *
 * 配合要求:
 *  1) 父组件必须给 onRemove / onPreview / onEditItem
 *     传**引用稳定**的回调 —— zustand action / useCallback。否则 memo
 *     的浅比较会因 fn 引用不等永远 miss。已经在 BatchPage + 本文件里
 *     用 useCallback 兜住。
 *  2) `item` 自身必须保持引用相等(未变的 item 维持旧引用)。zustand
 *     的 `items.map(i => i.id === changed ? {...i,...} : i)` 已经做到。
 */
const ResultCard = memo(function ResultCard({
  item,
  index,
  onRemove,
  onPreview,
  onEditItem,
}: {
  item: BatchItem
  index: number
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
  onEditItem?: (item: BatchItem) => void
}) {
  const badge = STATUS_BADGE[item.status]
  const isFail = item.status === 'error'
  const isRun = item.status === 'generating'
  const displayUrl = pickDisplayUrl(item)
  // imgSrc 是 displayUrl 在 dataURL 时换出来的 blob: URL, 用于 <img src>。
  // displayUrl 自己保持不变 —— onPreview / download 这些消费方仍要拿
  // 原始 dataURL/http 去走 API + IPC, blob: URL 在主进程不可读。
  const imgSrc = useDisplaySrc(displayUrl)
  const isDone = item.status === 'done' && !!displayUrl
  // 同步切到 COS 之后, UI 用一个小角标提示当前展示的是哪种 URL。
  const upload = item.uploadStatus

  return (
    <div
      className={`flex flex-col gap-1.5 p-2 border-2 ${
        isFail ? 'border-red-700/60 bg-red-950/20' : 'border-zinc-700 bg-zinc-900/60'
      }`}
    >
      {/* 顶部 row: 序号 + 状态 + 操作 */}
      <div className="flex items-center justify-between gap-1.5">
        <span className="px-1.5 py-0.5 bg-zinc-950 text-cyberpunk-yellow font-mono text-[10px] font-bold tabular-nums">
          #{String(index + 1).padStart(3, '0')}
        </span>
        <span
          className={`px-1.5 py-0.5 border font-mono text-[10px] font-bold uppercase tracking-wider ${badge.cls}`}
        >
          {badge.label}
        </span>
        <div className="ml-auto flex gap-1">
          {onEditItem && item.prompt && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onEditItem(item)
              }}
              aria-label="重编辑此项 (prompt + 比例 + 参考图)"
              title={
                item.snapshot
                  ? '把此项的 prompt / 比例 / 参考图全部灌回输入框'
                  : '把此 prompt 灌回输入框 (此项无快照, 仅恢复 prompt)'
              }
              className="px-1 h-5 flex items-center justify-center border border-zinc-700 bg-zinc-900 text-cyberpunk-yellow hover:bg-cyberpunk-yellow hover:text-cyberpunk-black text-[10px] font-mono font-bold uppercase tracking-wider leading-none transition-colors"
            >
              ↺ EDIT
            </button>
          )}
          {isDone && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                downloadImage(displayUrl!, buildFilename(index, item.prompt))
              }}
              aria-label="下载图片"
              title="下载"
              className="w-5 h-5 flex items-center justify-center border border-zinc-700 bg-zinc-900 text-cyberpunk-yellow hover:bg-cyberpunk-yellow hover:text-cyberpunk-black text-sm font-bold leading-none transition-colors"
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label="移除"
            title="移除"
            className="w-5 h-5 flex items-center justify-center border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-red-900/50 hover:text-red-200 hover:border-red-700/60 text-sm font-bold leading-none transition-colors"
          >
            ×
          </button>
        </div>
      </div>

      {/*
        缩略图 / 占位。
        编辑动作(多角度/打光/全景/导演台/加为参考图)不再做悬停浮层 ——
        点击放大后的 ImageLightbox 左下角统一提供(见 BatchPage renderActions),
        卡片本身只负责「点击 → 预览」。
      */}
      <div
        className={`group relative aspect-square bg-zinc-950 border-2 border-zinc-800 overflow-hidden ${
          isDone ? 'cursor-zoom-in' : ''
        }`}
        onClick={() => isDone && onPreview?.(displayUrl!)}
      >
        {isDone && (
          <img
            src={imgSrc}
            alt={item.prompt}
            loading="lazy"
            // (p5) decoding=async 让浏览器在后台线程解码大图,
            // 避免大批量结果一次性进入视口时主线程被解码阻塞掉好几帧。
            // 配合 useDisplaySrc 把 dataURL 换成 blob: URL 后, 主线程完全不参与
            // base64 → bitmap 的解析, 200 张卡 进入视口才真正不卡。
            decoding="async"
            className="w-full h-full object-cover block"
          />
        )}
        {isRun && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-cyberpunk-yellow text-xs font-mono uppercase tracking-wider">
            <div
              className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full"
              style={{ animation: 'batch-spin 1s linear infinite' }}
            />
            <span>生成中</span>
          </div>
        )}
        {item.status === 'pending' && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-600 font-mono text-xs uppercase tracking-wider">
            等待
          </div>
        )}
        {isFail && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-red-300 text-center">
            <span className="text-3xl font-bold leading-none">✗</span>
            <span
              className="font-mono text-[10px] leading-tight line-clamp-3 break-words"
              title={item.error || 'FAILED'}
              style={{ cursor: item.error ? 'help' : 'default' }}
            >
              {item.error || 'FAILED'}
            </span>
          </div>
        )}
        {isDone && (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 px-1 py-px bg-green-900/80 text-green-200 font-mono text-[9px] font-bold uppercase tracking-wider"
          >
            done
          </span>
        )}
        {/*
          异步存储状态角标:
          - uploading: 拉黄边框, 表示模型直出 URL 还没转存
          - uploaded:  绿框 cos, 表示当前显示的是 COS 持久化 URL
          - failed:    红框, 提示转存失败 (UI 退回模型直出, 链接到期可能 404)
        */}
        {isDone && upload === 'uploading' && (
          <span
            aria-label="正在转存到 COS"
            title="正在异步上传到腾讯云 COS…"
            className="absolute bottom-1 left-1 px-1 py-px bg-zinc-950/85 border border-cyberpunk-yellow/70 text-cyberpunk-yellow font-mono text-[9px] font-bold uppercase tracking-wider"
          >
            up…
          </span>
        )}
        {isDone && upload === 'uploaded' && (
          <span
            aria-label="已转存到 COS"
            title="当前显示的是 COS 持久化 URL"
            className="absolute bottom-1 left-1 px-1 py-px bg-emerald-950/85 border border-emerald-600/70 text-emerald-300 font-mono text-[9px] font-bold uppercase tracking-wider"
          >
            cos
          </span>
        )}
        {isDone && upload === 'failed' && (
          <span
            aria-label="转存失败,使用模型直出 URL"
            title={`COS 转存失败: ${item.uploadError || '未知原因'}\n当前展示的是模型直出 URL,可能会过期`}
            className="absolute bottom-1 left-1 px-1 py-px bg-red-950/85 border border-red-600/70 text-red-300 font-mono text-[9px] font-bold uppercase tracking-wider"
          >
            !cos
          </span>
        )}
      </div>

      {/* prompt 文字 */}
      <p className="font-mono text-[11px] text-zinc-300 leading-snug line-clamp-2 min-h-[2.6em] break-words m-0">
        {item.prompt}
      </p>

      {item.error && !isFail && (
        <p className="font-mono text-[10px] text-red-400 break-words m-0">
          ERR: {item.error}
        </p>
      )}
    </div>
  )
})

/**
 * (v) react-window 2.x <Grid> 的 cellComponent。
 *
 * 关键约束 (来自官方文档 https://github.com/bvaughn/react-window):
 *  1. **cellProps 对象引用稳定** 时, react-window 才能跳过未变 cell 的渲染
 *     —— 这里在父组件用 useMemo 兜住。
 *  2. **必须把 style spread 到根元素**, 否则 react-window 的绝对定位失效。
 *  3. cellProps 的字段会平铺到函数参数, 跟 columnIndex/rowIndex/style 同级。
 *
 * 这里再加一层 padding-right/padding-bottom = CARD_GAP, 模拟原 CSS gap-3。
 * 注意 react-window 自己不支持 grid-gap, columnWidth/rowHeight 必须把
 * gap 算进去, 然后用 padding/margin 把视觉间隙撑出来。
 */
type VirtualCellProps = {
  items: BatchItem[]
  columnCount: number
  indexById: Map<string, number>
  onRemove: (id: string) => void
  onPreview?: (url: string) => void
  onEditItem?: (item: BatchItem) => void
}

function VirtualCell({
  columnIndex,
  rowIndex,
  style,
  items,
  columnCount,
  indexById,
  onRemove,
  onPreview,
  onEditItem,
}: CellComponentProps<VirtualCellProps>) {
  const idx = rowIndex * columnCount + columnIndex
  const item = items[idx]
  // 最后一行尾部空 cell —— item 为 undefined 时返回空 div(保持 style 占位)。
  if (!item) {
    return <div style={style} />
  }
  const origIdx = indexById.get(item.id) ?? 0
  return (
    <div
      style={{
        ...style,
        paddingRight: CARD_GAP,
        paddingBottom: CARD_GAP,
        boxSizing: 'border-box',
      }}
    >
      <ResultCard
        item={item}
        index={origIdx}
        onRemove={onRemove}
        onPreview={onPreview}
        onEditItem={onEditItem}
      />
    </div>
  )
}

/**
 * BatchResultGrid - 结果网格
 *
 * 两种渲染模式:
 *  - items < VIRTUALIZE_THRESHOLD (30): 走原 CSS Grid, 卡片随页面整体滚动
 *  - items >= VIRTUALIZE_THRESHOLD:    切到 react-window <Grid>, 内嵌滚动条,
 *                                       只渲染视口可见的 cell。200 items
 *                                       场景下 DOM 节点数从 200 张 → ~10-20 张。
 */
export default function BatchResultGrid({ items, onRemove, onPreview, onEditItem }: Props) {
  const [reversed, setReversed] = useState(true)

  // (p3) failedItems / doneItems / displayItems 均放进 useMemo, 避免每
  // 次渲染都 O(N) 重扫整个 items, 在 200 张满载时这 3 个 filter/reverse
  // 累加起来非常显眼。依赖只有 items / reversed, 引用就稳定了。
  const failedItems = useMemo(() => items.filter((i) => i.status === 'error'), [items])
  const doneItems = useMemo(() => items.filter((i) => i.status === 'done'), [items])
  const displayItems = useMemo(
    () => (reversed ? [...items].reverse() : items),
    [items, reversed],
  )

  // (p3) 把 items.indexOf(item) 的 O(N²) 干掉。BatchItem.id 是稳定唯一
  // 主键, 直接 id → originalIdx 一张 Map, 渲染时 O(1) 查表。
  // 200 张 item 时:从 200 × 200 = 4 万次 indexOf 降到 200 + 200 次 Map 操作。
  const indexById = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < items.length; i++) map.set(items[i].id, i)
    return map
  }, [items])

  // (v) ResizeObserver 跟踪容器宽度。第一次挂载 width=0 时退化到 CSS Grid,
  // 等 RO fire 一次拿到真实宽度后, 大批量场景才会切到虚拟化分支。
  const { ref: containerRef, width: containerWidth, height: viewportH } = useContainerSize()

  /**
   * (v) 虚拟化网格几何计算 ——
   *  - columnCount    = floor(W / MIN_CARD_WIDTH), 至少 1 列
   *  - columnWidth    = floor(W / columnCount), 单元 stride 含 gap
   *  - 卡片视觉宽度   = columnWidth - CARD_GAP (cell 内 right-padding 撑开)
   *  - rowHeight      = (卡片视觉宽度 = aspect-square 图区高) + 文案区高 + CARD_GAP
   *
   * 关键: 卡片图区是 aspect-square, 视觉宽 == 图区高。所以 rowHeight
   * 必须随 columnWidth 动态算, 不能写死。
   */
  const gridLayout = useMemo(() => {
    if (containerWidth <= 0) {
      return null
    }
    const columnCount = Math.max(1, Math.floor(containerWidth / MIN_CARD_WIDTH))
    const columnWidth = Math.floor(containerWidth / columnCount)
    const cardVisualWidth = Math.max(0, columnWidth - CARD_GAP)
    const rowHeight = cardVisualWidth + CARD_TEXT_AREA_PX + CARD_GAP
    const rowCount = Math.ceil(displayItems.length / columnCount)
    return { columnCount, columnWidth, rowHeight, rowCount }
  }, [containerWidth, displayItems.length])

  /**
   * (v) cellProps 必须用 useMemo, 否则每次 BatchResultGrid 渲染都返回
   * 新对象 → react-window 检测到 prop 变化 → 整网格全部 cell 重渲, 虚拟化
   * 失效。依赖只放 cells 真正会读到的字段。
   */
  const cellProps: VirtualCellProps | null = useMemo(() => {
    if (!gridLayout) return null
    return {
      items: displayItems,
      columnCount: gridLayout.columnCount,
      indexById,
      onRemove,
      onPreview,
      onEditItem,
    }
  }, [displayItems, gridLayout, indexById, onRemove, onPreview, onEditItem])

  // (v) 只有真的"item 多 + 容器测好宽度"才上虚拟化。否则继续用原 CSS Grid。
  const shouldVirtualize =
    items.length >= VIRTUALIZE_THRESHOLD && gridLayout !== null && cellProps !== null

  if (items.length === 0) {
    return (
      <div className="border-2 border-dashed border-zinc-800 bg-zinc-950/40 py-10 px-4 text-center">
        <div className="font-orbitron text-base uppercase tracking-wider text-zinc-400">
          暂无任务
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          // 在上方输入提示词,按"开始生成"启动批量
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes batch-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            // RESULTS · {items.length} 任务 · OK {doneItems.length} · ERR {failedItems.length}
          </div>
          <button
            type="button"
            onClick={() => setReversed((v) => !v)}
            className={`px-2 py-1 border-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              reversed
                ? 'border-cyberpunk-yellow bg-cyberpunk-yellow text-cyberpunk-black'
                : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {reversed ? '↑ 新→旧' : '↓ 旧→新'}
          </button>
        </div>

        {failedItems.length > 0 && (
          <div className="px-3 py-2 border-2 border-red-700/60 bg-red-950/30 text-red-300">
            <div className="font-orbitron text-sm uppercase tracking-wider">
              ⚠ {failedItems.length} 项生成失败
            </div>
            <p className="mt-1 font-mono text-[11px] text-red-300/80 leading-snug">
              {failedItems[0]?.error || '生成请求失败'}
              {failedItems.length > 1 && ` (+${failedItems.length - 1} more)`}
            </p>
            <p className="mt-1 font-mono text-[10px] text-red-300/60 leading-snug">
              建议:检查网络连接,或在顶部切换绘图模型后重新生成
            </p>
          </div>
        )}

        {/*
          (v) 测量容器宽度的锚点。无论走哪一支, 都把 ref 挂在外层 div,
          这样 N 跨过 VIRTUALIZE_THRESHOLD 的瞬间, width 已经被 RO 量过。
        */}
        <div ref={containerRef} className="w-full">
          {shouldVirtualize && gridLayout && cellProps ? (
            <Grid
              cellComponent={VirtualCell}
              cellProps={cellProps}
              columnCount={gridLayout.columnCount}
              columnWidth={gridLayout.columnWidth}
              rowCount={gridLayout.rowCount}
              rowHeight={gridLayout.rowHeight}
              // overscan=2 行: 视口上下各多渲染 2 行, 滚动时基本看不到 cell mount 闪烁
              overscanCount={2}
              style={{ height: viewportH, width: '100%' }}
            />
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
            >
              {displayItems.map((item) => {
                const origIdx = indexById.get(item.id) ?? 0
                return (
                  <ResultCard
                    key={item.id}
                    item={item}
                    index={origIdx}
                    onRemove={onRemove}
                    onPreview={onPreview}
                    onEditItem={onEditItem}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
