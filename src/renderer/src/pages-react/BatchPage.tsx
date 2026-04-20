import { useMemo, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useModelStore, useToastStore, useBatchStore } from '../stores'
import { useApi } from '../hooks/useService'
import PunkShell from './batch-punk/PunkShell'
import PunkHeader from './batch-punk/PunkHeader'
import PunkModeSwitcher from './batch-punk/PunkModeSwitcher'
import PunkPromptCard from './batch-punk/PunkPromptCard'
import PunkPromptMulti from './batch-punk/PunkPromptMulti'
import PunkConfigGrid, {
  type RatioOption,
  type ResolutionOption,
} from './batch-punk/PunkConfigGrid'
import PunkRefDrop from './batch-punk/PunkRefDrop'
import PunkActionBar from './batch-punk/PunkActionBar'
import PunkResultGrid from './batch-punk/PunkResultGrid'
import PunkPromptHelperBar from './batch-punk/PunkPromptHelperBar'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { PunkBudgetReceipt } from './batch-punk/PunkBudgetReceipt'
import { extractPriceFromModel } from '../utils/model-price'

const FALLBACK_RATIOS: RatioOption[] = [
  { key: 'auto', label: '自适应', description: '智能' },
  { key: '1:1', label: '方形 1:1', description: '常用' },
  { key: '16:9', label: '横版 16:9', description: '宽屏' },
  { key: '9:16', label: '竖版 9:16', description: '竖屏' },
  { key: '4:3', label: '横版 4:3', description: '标准' },
  { key: '3:4', label: '竖版 3:4', description: '标准' },
  { key: '3:2', label: '横版 3:2', description: '经典' },
  { key: '2:3', label: '竖版 2:3', description: '经典' },
]

const FALLBACK_RESOLUTIONS: ResolutionOption[] = [
  { key: '1K', label: '1K 标准', description: '高效' },
  { key: '2K', label: '2K 高清', description: '稍慢' },
]

interface ModelConfigSnapshot {
  name?: string
  displayName?: string
  price?: number
  ratios?: RatioOption[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
  capabilities?: { resolutionControl?: boolean }
}

/**
 * BatchPage (punk) — 批量生成页, P5 拼贴 + 多娜多娜朋克 zine 主题
 * 数据驱动:全部状态在 useBatchStore
 */
export default function BatchPage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const addToast = useToastStore((s) => s.addToast)

  // ---- 配置 ----
  const mode = useBatchStore((s) => s.mode)
  const cardPrompt = useBatchStore((s) => s.cardPrompt)
  const cardCount = useBatchStore((s) => s.cardCount)
  const multiText = useBatchStore((s) => s.multiText)
  const ratio = useBatchStore((s) => s.ratio)
  const resolution = useBatchStore((s) => s.resolution)
  const perPromptCount = useBatchStore((s) => s.perPromptCount)
  const concurrency = useBatchStore((s) => s.concurrency)
  const refImages = useBatchStore((s) => s.refImages)

  // ---- 队列 ----
  const items = useBatchStore((s) => s.items)
  const running = useBatchStore((s) => s.running)

  // ---- actions (引用稳定, getState 一次取出) ----
  const {
    setMode, setCardPrompt, setCardCount, setMultiText,
    setRatio, setResolution, setPerPromptCount, setConcurrency,
    addRefImage, removeRefImage, clearRefImages,
    addItem, removeItem, clearAll, runBatch,
  } = useBatchStore.getState()

  // ---- 派生计数 ----
  const stats = useMemo(() => {
    const done = items.filter((i) => i.status === 'done').length
    const failed = items.filter((i) => i.status === 'error').length
    const runn = items.filter((i) => i.status === 'generating').length
    const pend = items.filter((i) => i.status === 'pending').length
    return { done, failed, running: runn, pending: pend, total: items.length }
  }, [items])

  // ---- 估算这次点 GENERATE 会新增多少任务 ----
  // multi 模式: 整段文本作为 1 条 prompt, 重复 perPromptCount 次, 不再按行拆分
  const willEnqueue = useMemo(() => {
    if (mode === 'card') {
      return cardPrompt.trim() ? cardCount : 0
    }
    return multiText.trim() ? perPromptCount : 0
  }, [mode, cardPrompt, cardCount, multiText, perPromptCount])

  // ---- 预览 modal ----
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!previewUrl) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewUrl(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewUrl])

  // ---- 当前 model 的 ratio / resolution 选项 (随 currentModelKey 实时变化) ----
  const [modelConfig, setModelConfig] = useState<ModelConfigSnapshot | null>(null)
  useEffect(() => {
    const aiApi = (window as any).aiImageAPI
    const cfg = aiApi?.getCurrentModel?.() as ModelConfigSnapshot | undefined
    setModelConfig(cfg || null)
  }, [currentModelKey])

  const ratioOptions = useMemo<RatioOption[]>(() => {
    return Array.isArray(modelConfig?.ratios) && modelConfig!.ratios!.length
      ? modelConfig!.ratios!
      : FALLBACK_RATIOS
  }, [modelConfig])

  const supportsResolution = useMemo(() => {
    return Boolean(
      modelConfig?.capabilities?.resolutionControl &&
      modelConfig?.resolutions?.length,
    )
  }, [modelConfig])

  const resolutionOptions = useMemo<ResolutionOption[]>(() => {
    if (supportsResolution && modelConfig?.resolutions) return modelConfig.resolutions
    return FALLBACK_RESOLUTIONS
  }, [modelConfig, supportsResolution])

  // ---- 预算收据需要的派生量 ----
  const unitPrice = useMemo(() => extractPriceFromModel(modelConfig), [modelConfig])
  const receiptCount = mode === 'card' ? cardCount : perPromptCount
  const modelDisplayName = modelConfig?.name || currentModelKey || '未知模型'

  const batchMediaRefs = useMemo<MediaRef[]>(
    () => refImages.map((r, i) => ({
      index: i + 1,
      type: 'image' as const,
      url: r.base64,
      label: r.fileName || `图片${i + 1}`,
    })),
    [refImages],
  )

  // 模型切换后, 如果当前 ratio/resolution 不在选项里, 自动归位
  useEffect(() => {
    if (ratioOptions.some((o) => o.key === ratio)) return
    const fallback = ratioOptions.find((o) => o.key === 'auto') || ratioOptions[0]
    if (fallback) setRatio(fallback.key)
  }, [ratio, ratioOptions, setRatio])

  useEffect(() => {
    if (!supportsResolution) return
    if (resolutionOptions.some((o) => o.key === resolution)) return
    const preferKey = modelConfig?.defaultResolution || '1K'
    const fallback = resolutionOptions.find((o) => o.key === preferKey) || resolutionOptions[0]
    if (fallback) setResolution(fallback.key)
  }, [resolution, resolutionOptions, supportsResolution, modelConfig, setResolution])

  // ---- handlers ----
  const handleClearResults = () => {
    // 仅清掉 done/error, 保留 pending/generating
    const keep = items.filter((i) => i.status === 'pending' || i.status === 'generating')
    useBatchStore.setState({ items: keep })
    addToast({ message: '已清除已完成结果', type: 'info' })
  }

  const handleClearAll = () => {
    if (running) {
      addToast({ message: '生成中, 请稍后再清空', type: 'warning' })
      return
    }
    clearAll()
    addToast({ message: '队列已清空', type: 'info' })
  }

  const handleGenerate = async () => {
    if (!currentModelKey) {
      addToast({ message: '请先在顶部选择模型', type: 'warning' })
      return
    }
    if (running) return

    // 1) 入队
    if (mode === 'card') {
      const p = cardPrompt.trim()
      if (!p && stats.pending === 0) {
        addToast({ message: '请输入提示词', type: 'warning' })
        return
      }
      if (p) {
        for (let i = 0; i < cardCount; i++) addItem(p)
      }
    } else {
      // multi 模式: 整段文本作为单条 prompt 入队, 重复 perPromptCount 次
      const p = multiText.trim()
      if (!p && stats.pending === 0) {
        addToast({ message: '请输入提示词', type: 'warning' })
        return
      }
      if (p) {
        for (let i = 0; i < perPromptCount; i++) addItem(p)
      }
    }

    // 2) 跑队列
    try {
      await runBatch(api, currentModelKey, {
        ratio, resolution, concurrency,
        referenceImages: refImages.map((r) => r.base64),
      })
      const finalState = useBatchStore.getState()
      const ok = finalState.items.filter((i) => i.status === 'done').length
      const err = finalState.items.filter((i) => i.status === 'error').length
      addToast({
        message: `批量完成: 成功 ${ok} / 失败 ${err}`,
        type: err > 0 ? 'warning' : 'success',
      })
    } catch (e) {
      addToast({
        message: `批量执行异常: ${e instanceof Error ? e.message : String(e)}`,
        type: 'error',
      })
    }
  }

  return (
    <PunkShell>
      <PunkHeader
        total={stats.total}
        done={stats.done}
        failed={stats.failed}
        running={stats.running}
        pending={stats.pending}
        onClearAll={handleClearAll}
        onClearResults={handleClearResults}
      />

      {/* 双栏:左 = 输入, 右 = 配置 + 参考图 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 22,
          alignItems: 'start',
        }}
        className="punk-batch-grid"
      >
        {/* ===== 左栏:模式 + 视觉辅助 + 提示词输入 ===== */}
        <section>
          <PunkModeSwitcher mode={mode} onChange={setMode} />
          <PunkPromptHelperBar
            refImages={refImages}
            onInject={(text) => {
              const cur = useBatchStore.getState()
              const sep = (s: string) => (s && !s.endsWith('\n') ? '\n\n' : '')
              if (cur.mode === 'card') {
                cur.setCardPrompt(cur.cardPrompt + sep(cur.cardPrompt) + text)
              } else {
                cur.setMultiText(cur.multiText + sep(cur.multiText) + text)
              }
            }}
          />
          {mode === 'card' ? (
            <PunkPromptCard
              prompt={cardPrompt}
              count={cardCount}
              onPromptChange={setCardPrompt}
              onCountChange={setCardCount}
              mediaRefs={batchMediaRefs}
            />
          ) : (
            <PunkPromptMulti
              text={multiText}
              onChange={setMultiText}
              perPromptCount={perPromptCount}
              onPerPromptCountChange={setPerPromptCount}
              mediaRefs={batchMediaRefs}
            />
          )}
        </section>

        {/* ===== 右栏:配置 + 参考图 ===== */}
        <section>
          <PunkConfigGrid
            ratio={ratio}
            resolution={resolution}
            concurrency={concurrency}
            ratioOptions={ratioOptions}
            resolutionOptions={resolutionOptions}
            supportsResolution={supportsResolution}
            onRatioChange={setRatio}
            onResolutionChange={setResolution}
            onConcurrencyChange={setConcurrency}
          />
          <PunkRefDrop
            images={refImages}
            onAdd={addRefImage}
            onRemove={removeRefImage}
            onClear={clearRefImages}
            onPreview={(url) => setPreviewUrl(url)}
          />
        </section>
      </div>

      {/* ===== 全宽 ActionBar ===== */}
      <PunkActionBar
        total={stats.total}
        done={stats.done}
        failed={stats.failed}
        running={running}
        pendingCount={stats.pending}
        willEnqueue={willEnqueue}
        onGenerate={handleGenerate}
        leftSlot={
          <PunkBudgetReceipt
            modelName={modelDisplayName}
            unitPrice={unitPrice}
            count={receiptCount}
            mode={mode}
          />
        }
      />

      {/* ===== 全宽结果网格 ===== */}
      <PunkResultGrid
        items={items}
        onRemove={removeItem}
        onPreview={(url) => setPreviewUrl(url)}
      />

      {/* ===== 极简预览 modal (portal 出去, 避开 stacking 干扰) ===== */}
      {previewUrl && createPortal(
        <div
          onClick={() => setPreviewUrl(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 70000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.92)',
            backdropFilter: 'blur(6px)',
            padding: 24,
          }}
        >
          <div
            className="donor-punk"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '92vw',
              maxHeight: '92vh',
              border: '5px solid var(--punk-pink)',
              boxShadow: '8px 8px 0 var(--punk-cream)',
              background: 'var(--punk-black)',
              overflow: 'visible',
            }}
          >
            <img
              src={previewUrl}
              alt="preview"
              style={{ display: 'block', maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain' }}
            />
            <button
              type="button"
              onClick={() => setPreviewUrl(null)}
              aria-label="关闭预览"
              className="p-mono"
              style={{
                position: 'absolute', top: 8, right: 8,
                width: 36, height: 36,
                background: 'var(--punk-pink)',
                color: 'var(--punk-black)',
                border: '3px solid var(--punk-black)',
                fontWeight: 900, fontSize: 18,
                cursor: 'pointer', boxShadow: '3px 3px 0 var(--punk-cream)',
                zIndex: 2,
              }}
            >
              ×
            </button>
            <div
              style={{
                position: 'absolute', bottom: 8, right: 8,
                display: 'flex', gap: 8, alignItems: 'center',
              }}
            >
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation()
                  const fname = `preview-${Date.now()}.png`
                  try {
                    const res = await fetch(previewUrl, { mode: 'cors' })
                    if (!res.ok) throw new Error(String(res.status))
                    const blob = await res.blob()
                    const obj = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = obj; a.download = fname
                    document.body.appendChild(a); a.click(); a.remove()
                    setTimeout(() => URL.revokeObjectURL(obj), 1000)
                  } catch {
                    const a = document.createElement('a')
                    a.href = previewUrl; a.download = fname
                    a.target = '_blank'; a.rel = 'noreferrer'
                    document.body.appendChild(a); a.click(); a.remove()
                  }
                }}
                className="p-mono"
                aria-label="下载图片"
                style={{
                  background: 'var(--punk-toxic)',
                  color: 'var(--punk-black)',
                  border: '3px solid var(--punk-black)',
                  padding: '4px 10px',
                  fontWeight: 900, fontSize: 11,
                  cursor: 'pointer',
                  boxShadow: '3px 3px 0 var(--punk-pink)',
                }}
              >
                [ ↓ DOWNLOAD ]
              </button>
              {!previewUrl.startsWith('data:') && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="p-mono"
                  style={{
                    background: 'var(--punk-cream)',
                    color: 'var(--punk-black)',
                    border: '3px solid var(--punk-black)',
                    padding: '4px 10px',
                    fontWeight: 900, fontSize: 11,
                    textDecoration: 'none',
                    boxShadow: '3px 3px 0 var(--punk-pink)',
                  }}
                >
                  [ OPEN.URL ]
                </a>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 响应式: 窄屏单栏 */}
      <style>{`
        @media (max-width: 880px) {
          .punk-batch-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
    </PunkShell>
  )
}
