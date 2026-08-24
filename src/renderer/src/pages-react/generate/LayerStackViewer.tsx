import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ResultLayerMeta, ResultUploadMeta } from '../../stores/useGenerateStore'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
import { appendCosThumb } from '../../utils/cosThumb'

/**
 * LayerStackViewer —— 图层分离结果的查看器。
 *
 * 交互沿用图形软件四十年不变的三条约定（Photoshop / Figma / Sketch / GIMP / Affinity
 * 全都一样），偏离任何一条都会让用过这些工具的人当场困惑：
 *
 *  1. **列表自上而下 = 从最上层到最下层**（zIndex 降序）。上游和 store 里是**升序**
 *     （底图在前，因为那才是叠加的绘制顺序），到了列表必须翻过来 —— 照数组顺序渲染
 *     会把底图放在列表第一行，正好是所有人预期的反面。
 *  2. **眼睛图标切换可见性**，就地生效于预览。
 *  3. **点行选中**，预览切到单层查看。
 *
 * 预览两种模式：
 *  - 叠加（默认）：底图正常流式铺开撑起容器，其余图层按 `boundingBox.normalized`
 *    （0–1000 千分比）绝对定位缩放上去。**不能 inset-0 直接摞** —— 上游的图层是按
 *    bbox 裁切后放大的（见 ImageLayer 文档的实测数据），摞起来会把一个小图标拉成全画幅。
 *    以底图为坐标系还有个好处：不用知道任何像素尺寸，容器高度由底图自己撑。
 *  - 单层：只看选中那一层的原始裁切图，背景铺棋盘格 —— 透明区域必须看得见，否则
 *    「抠出来的到底是什么形状」这个最关键的信息就丢了。
 */

interface LayerStackViewerProps {
  /** 同一组图层的 meta，顺序不限（本组件自己排）。 */
  metas: ResultUploadMeta[]
  /** 与 metas 同序的展示 url（来自 store 的 resultUrls，已被 COS 热切过）。 */
  urls: string[]
  onClose: () => void
}

/** 一次拆分的产出上限：1 底图 + 最多 16 层。用来在界面上讲清计费口径。 */
const MAX_LAYER_IMAGES = 17

/** 棋盘格背景 —— 透明通道的通用视觉语言。 */
const CHECKER =
  'repeating-conic-gradient(#3f3f46 0% 25%, #27272a 0% 50%) 50% / 16px 16px'

function layerLabel(meta: ResultUploadMeta, indexFromBase: number): string {
  if (meta.layer?.zIndex === 0) return '底图'
  // 模型给的名字（如「Seedream标题文字」）比「图层 N」有信息量，优先用它。
  return meta.layer?.name?.trim() || `图层 ${indexFromBase}`
}

async function downloadLayer(url: string, filename: string): Promise<void> {
  const anchor = (href: string, revoke?: () => void) => {
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (revoke) setTimeout(revoke, 1000)
  }
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const objUrl = URL.createObjectURL(await res.blob())
    anchor(objUrl, () => URL.revokeObjectURL(objUrl))
  } catch {
    // 跨域拿不到 blob 时退回直链下载（浏览器可能改成打开新标签，仍比什么都不做好）。
    anchor(url)
  }
}

/** 一层的缩略图。抽成组件只为能在 map 里安全调 useDisplaySrc（钩子不能在回调里调）。 */
function LayerThumb({ url, alt }: { url: string; alt: string }) {
  const src = useDisplaySrc(appendCosThumb(url, 128))
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      className="h-10 w-10 shrink-0 object-contain"
      style={{ background: CHECKER }}
    />
  )
}

/**
 * 把 `boundingBox` 换算成相对底图的百分比定位。
 *
 * 优先 `normalized`（0–1000 千分比，除以 10 就是百分比），它不依赖底图像素尺寸；
 * 只有 `absolute` 时无从得知底图多大，只能放弃定位。两者都是
 * `[left, top, right, bottom]`。
 *
 * 返回 null = 这一层没法定位（底图本身、或上游没给 bbox），调用方按整幅处理。
 */
export function layerBoxStyle(
  box: ResultLayerMeta['boundingBox'] | undefined,
): { left: string; top: string; width: string; height: string } | null {
  const n = box?.normalized
  if (!Array.isArray(n) || n.length < 4) return null
  const [left, top, right, bottom] = n
  if (![left, top, right, bottom].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null
  }
  const width = right - left
  const height = bottom - top
  // 宽高非正说明 bbox 是坏的（上游偶发/字段顺序不同）。宁可整幅铺，也别渲染成 0 尺寸
  // 让这一层凭空消失 —— 用户会以为拆分漏了一层。
  if (width <= 0 || height <= 0) return null
  return {
    left: `${left / 10}%`,
    top: `${top / 10}%`,
    width: `${width / 10}%`,
    height: `${height / 10}%`,
  }
}

/** 单层预览（原始裁切图，铺满查看区）。独立组件是为了能安全调 useDisplaySrc。 */
function SoloImage({ url, alt }: { url: string; alt: string }) {
  const src = useDisplaySrc(url)
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      className="absolute inset-0 h-full w-full object-contain"
    />
  )
}

/** 叠加预览里的底图 —— 正常流式布局，由它撑起容器高度并定义坐标系。 */
function BaseImage({ url, alt, hidden }: { url: string; alt: string; hidden?: boolean }) {
  const src = useDisplaySrc(url)
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      aria-hidden={hidden ? 'true' : undefined}
      className="block max-h-full w-auto max-w-full"
      style={hidden ? { visibility: 'hidden' } : undefined}
      data-testid="layer-base-image"
    />
  )
}

/** 叠加预览里的一层 —— 按 bbox 百分比贴到底图上；没有 bbox 时退回整幅。 */
function OverlayImage({
  url,
  alt,
  box,
  hidden,
}: {
  url: string
  alt: string
  box: ResultLayerMeta['boundingBox'] | undefined
  hidden?: boolean
}) {
  const src = useDisplaySrc(url)
  const pos = layerBoxStyle(box)
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      aria-hidden={hidden ? 'true' : undefined}
      // 图层已按 bbox 裁切过，填满这个框即可（不是 contain —— contain 会在框内
      // 再留白一次，把图层缩得比它该在的位置小）。
      className="absolute"
      style={{
        ...(pos ?? { left: 0, top: 0, width: '100%', height: '100%' }),
        objectFit: 'fill',
        ...(hidden ? { visibility: 'hidden' as const } : {}),
      }}
      data-testid={pos ? 'layer-overlay-positioned' : 'layer-overlay-fullbleed'}
    />
  )
}

export function LayerStackViewer({ metas, urls, onClose }: LayerStackViewerProps) {
  // 升序（底图在前）= 叠加的绘制顺序。列表要用的降序在下面单独派生。
  const ascending = useMemo(
    () =>
      metas
        .map((meta, i) => ({ meta, url: urls[i] }))
        .filter((entry) => !!entry.url)
        .sort((a, b) => (a.meta.layer?.zIndex ?? 0) - (b.meta.layer?.zIndex ?? 0)),
    [metas, urls],
  )

  // 默认全部可见 —— 打开就该看到还原后的完整画面，而不是一片空白让用户自己勾。
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [soloId, setSoloId] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 单层查看态下 Esc 先退回叠加，再按才关窗 —— 逐级退出，别一脚踩到底。
        if (soloId) setSoloId(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, soloId])

  if (ascending.length === 0) return null

  const descending = [...ascending].reverse()
  const soloEntry = soloId ? ascending.find((e) => e.meta.id === soloId) : undefined
  const visibleCount = ascending.filter((e) => !hiddenIds.has(e.meta.id)).length

  const toggle = (id: string) =>
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70000] flex items-center justify-center bg-black/92 p-6 backdrop-blur"
      data-testid="layer-stack-viewer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="图层分离结果"
        className="flex max-h-[88vh] w-full max-w-[1100px] flex-col border-2 border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b-2 border-zinc-800 px-4 py-2.5">
          <div className="min-w-0">
            <div className="font-orbitron text-sm uppercase tracking-wider text-cyberpunk-yellow">
              图层分离
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
              {`共 ${ascending.length} 张（1 底图 + ${ascending.length - 1} 图层，上限 ${MAX_LAYER_IMAGES}）`}
              <span className="ml-2 text-zinc-600">按张计费</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭图层查看器"
            className="flex h-9 w-9 items-center justify-center border-2 border-zinc-700 bg-zinc-900 text-lg font-bold text-white transition-colors hover:border-red-700/60 hover:bg-red-900/50"
          >
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* 预览区 */}
          <div className="flex min-h-[280px] flex-1 flex-col border-b-2 border-zinc-800 md:border-b-0 md:border-r-2">
            <div className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-zinc-400">
              <span data-testid="layer-preview-mode">
                {soloEntry
                  ? `单层：${layerLabel(soloEntry.meta, ascending.indexOf(soloEntry))}`
                  : `叠加预览（${visibleCount}/${ascending.length} 层可见）`}
              </span>
              {soloEntry && (
                <button
                  type="button"
                  onClick={() => setSoloId(null)}
                  className="ml-auto border border-zinc-700 px-2 py-0.5 uppercase tracking-wider text-zinc-300 transition-colors hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow"
                >
                  返回叠加
                </button>
              )}
            </div>
            <div className="m-3 mt-0 flex flex-1 items-center justify-center overflow-hidden">
              {soloEntry ? (
                <div
                  className="relative h-full w-full"
                  style={{ background: CHECKER }}
                  data-testid="layer-preview-canvas"
                >
                  <SoloImage
                    url={soloEntry.url}
                    alt={layerLabel(soloEntry.meta, ascending.indexOf(soloEntry))}
                  />
                </div>
              ) : (
                // 底图走正常流式布局撑起这个盒子，其余图层绝对定位贴上去 —— 盒子的
                // 尺寸即底图的渲染尺寸，于是 bbox 的百分比天然对齐，不用知道像素数。
                <div
                  className="relative"
                  style={{ background: CHECKER }}
                  data-testid="layer-preview-canvas"
                >
                  {ascending.map((entry, i) => {
                    const alt = layerLabel(entry.meta, i)
                    const hidden = hiddenIds.has(entry.meta.id)
                    // 升序渲染 = 后面的 DOM 节点覆盖前面的，天然等于 zIndex 叠放顺序。
                    // 隐藏用 visibility 而不是卸载:切回来不用重新解码/重新走 blob 解析。
                    return i === 0 ? (
                      <BaseImage key={entry.meta.id} url={entry.url} alt={alt} hidden={hidden} />
                    ) : (
                      <OverlayImage
                        key={entry.meta.id}
                        url={entry.url}
                        alt={alt}
                        box={entry.meta.layer?.boundingBox}
                        hidden={hidden}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 图层列表 —— 降序，最上层在最上面 */}
          <div className="flex w-full shrink-0 flex-col md:w-[320px]">
            <div className="flex items-center justify-between px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
              <span>图层（上 → 下）</span>
              <button
                type="button"
                onClick={() => setHiddenIds(new Set())}
                disabled={hiddenIds.size === 0}
                className="border border-zinc-700 px-2 py-0.5 text-zinc-300 transition-colors enabled:hover:border-cyberpunk-yellow enabled:hover:text-cyberpunk-yellow disabled:opacity-40"
              >
                全部显示
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="layer-list">
              {descending.map((entry) => {
                const label = layerLabel(entry.meta, ascending.indexOf(entry))
                const isHidden = hiddenIds.has(entry.meta.id)
                const isBase = entry.meta.layer?.zIndex === 0
                const isSolo = soloId === entry.meta.id
                return (
                  <li key={entry.meta.id}>
                    <div
                      className={`mb-1 flex items-center gap-2 border-2 px-2 py-1.5 transition-colors ${
                        isSolo
                          ? 'border-cyberpunk-yellow bg-zinc-900'
                          : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-600'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(entry.meta.id)}
                        aria-label={`${isHidden ? '显示' : '隐藏'}${label}`}
                        aria-pressed={!isHidden}
                        title={isHidden ? '显示这一层' : '隐藏这一层'}
                        className={`w-5 shrink-0 text-center text-sm leading-none transition-colors ${
                          isHidden ? 'text-zinc-600' : 'text-cyberpunk-yellow'
                        }`}
                      >
                        {isHidden ? '◌' : '◉'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSoloId(isSolo ? null : entry.meta.id)}
                        title={entry.meta.layer?.description || '单独查看这一层'}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <LayerThumb url={entry.url} alt={label} />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate font-mono text-xs ${
                              isHidden ? 'text-zinc-600 line-through' : 'text-zinc-200'
                            }`}
                          >
                            {label}
                          </span>
                          <span className="block font-mono text-[10px] text-zinc-500">
                            {isBase ? 'z0 · 背景' : `z${entry.meta.layer?.zIndex ?? '?'}`}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void downloadLayer(entry.url, `${label}.png`)}
                        aria-label={`下载${label}`}
                        title="下载这一层（PNG，含透明通道）"
                        className="shrink-0 px-1 font-mono text-xs text-zinc-400 transition-colors hover:text-cyberpunk-yellow"
                      >
                        ↓
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="border-t-2 border-zinc-800 p-2">
              <button
                type="button"
                onClick={() => {
                  // 逐张触发下载。不打包成 zip:那要把 17 张 2K PNG 全读进内存
                  // 再压一遍,渲染进程的瞬时峰值不值得省这几次点击。
                  ascending.forEach((entry, i) => {
                    void downloadLayer(entry.url, `${layerLabel(entry.meta, i)}.png`)
                  })
                }}
                className="w-full border-2 border-cyberpunk-yellow bg-cyberpunk-yellow px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-cyberpunk-black transition-colors hover:bg-cyberpunk-accent"
              >
                ↓ 下载全部 {ascending.length} 层
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
