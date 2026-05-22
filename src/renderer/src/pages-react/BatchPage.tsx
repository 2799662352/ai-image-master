import { useCallback, useMemo, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useModelStore, useToastStore, useBatchStore } from '../stores'
import type { BatchItem } from '../stores/useBatchStore'
import { useApi } from '../hooks/useService'
import BatchShell from './batch/BatchShell'
import BatchHeader from './batch/BatchHeader'
import BatchModeSwitcher from './batch/BatchModeSwitcher'
import BatchPromptCard from './batch/BatchPromptCard'
import BatchPromptMulti from './batch/BatchPromptMulti'
import BatchConfigGrid, {
  type RatioOption,
  type ResolutionOption,
} from './batch/BatchConfigGrid'
import BatchRefDrop from './batch/BatchRefDrop'
import BatchActionBar from './batch/BatchActionBar'
import BatchResultGrid from './batch/BatchResultGrid'
import BatchPromptHelperBar from './batch/BatchPromptHelperBar'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { BatchBudgetReceipt } from './batch/BatchBudgetReceipt'
import { extractPriceFromModel } from '../utils/model-price'
import { TemplateInline } from '../react-app/components/TemplateInline'

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
  sizeStrategy?: string
}

/**
 * BatchPage — 批量生成页(干净赛博朋克版,沿用 GeneratePage zinc + cyberpunk-yellow 风)
 * 全部业务逻辑由 useBatchStore 驱动;早期 P5 朋克拼贴版的 PunkXxx 组件已移交 batch-punk/
 * 目录归档,本页不再引用。
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
    addItem, removeItem, clearAll, runBatch, cancelBatch,
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

  // ---- 当前 model 的 ratio / resolution 选项 ----
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

  const sizeHidden = useMemo(() => {
    return modelConfig?.sizeStrategy === 'prompt'
  }, [modelConfig])

  const resolutionOptions = useMemo<ResolutionOption[]>(() => {
    if (supportsResolution && modelConfig?.resolutions) return modelConfig.resolutions
    return FALLBACK_RESOLUTIONS
  }, [modelConfig, supportsResolution])

  // ---- 预算收据派生 ----
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

  /**
   * 点击批量结果卡上的 ↺ EDIT: 用跟历史页 ↺ BATCH 完全一样的路径,
   * 把那条 item 生成时的 prompt + 比例 + 参考图 + 模型 全部回灌。
   *
   * 早期版本只灌 prompt, 用户反馈"图片没载入"。现在直接复用
   * useBatchStore.restoreForEdit + useModelStore.switchModel 这套
   * 历史页跑通的逻辑, 行为对齐。
   *
   * snapshot 在 worker 把 item flip 成 generating 时写入 (见
   * useBatchStore.runBatch → claimNextPending), pending 阶段为 undefined。
   * 没 snapshot 时退化为仅塞 prompt + 保留当前 ratio/refs。
   */
  // (p4) useCallback: BatchResultGrid → ResultCard 走 React.memo, 父侧
  // 回调必须引用稳定, 否则 200 张卡片 memo 全部 miss, 状态变化时整网格
  // 重新渲染。依赖 currentModelKey + addToast 即可。
  const handleEditItem = useCallback((item: BatchItem) => {
    const snap = item.snapshot
    useBatchStore.getState().restoreForEdit(
      snap
        ? {
            prompt: snap.prompt,
            ratio: snap.ratio,
            referenceImages: snap.referenceImages,
            mode: 'card',
          }
        : {
            prompt: item.prompt,
            mode: 'card',
          },
    )

    // model 校验跟 HistoryPage.handleEdit 保持一致: 不在 models 字典里
    // 就只 toast 不切, 避免点 GENERATE 时打到不存在的模型。
    if (snap?.modelKey && snap.modelKey !== currentModelKey) {
      const modelStore = useModelStore.getState()
      if (modelStore.models[snap.modelKey]) {
        modelStore.switchModel(snap.modelKey)
      } else {
        addToast({ type: 'warning', message: `模型 ${snap.modelKey} 不可用, 请手动选择` })
      }
    }

    addToast({
      message: snap
        ? '已回灌 prompt / 比例 / 参考图 / RESTORED'
        : 'Prompt 已加载 (无快照, 仅恢复文本) / RESTORED',
      type: 'success',
    })
  }, [currentModelKey, addToast])

  // (p4) 同上, 预览回调要稳定, 否则 ResultCard.memo 失效。
  const handlePreview = useCallback((url: string) => {
    setPreviewUrl(url)
  }, [])

  const handleClearAll = () => {
    if (running) {
      addToast({ message: '生成中, 请稍后再清空', type: 'warning' })
      return
    }
    clearAll()
    addToast({ message: '队列已清空', type: 'info' })
  }

  const handleCancel = () => {
    cancelBatch()
    addToast({ message: '批量生成已取消', type: 'warning' })
  }

  const handleGenerate = async () => {
    if (!currentModelKey) {
      addToast({ message: '请先在顶部选择模型', type: 'warning' })
      return
    }

    // 1) 入队 — 即便 running=true 也允许追加，因为 useBatchStore 改造后的
    //    workers 走的是 live-claim 模型 (claimNextPending)，新入队的 item
    //    会被空闲 / 下一轮 worker 直接捡走，不再需要等本轮 batch 整体跑完。
    let enqueuedThisClick = 0
    // 入队时锁定当前 refs + ratio 到每个 item, 保证用户 mid-run 修改后
    // 追加的新 item 使用的是修改后的值(而非首次 runBatch 闭包里的旧值)。
    const currentRefs = refImages.map((r) => r.base64)
    const itemOpts = { referenceImages: currentRefs, ratio }
    if (mode === 'card') {
      const p = cardPrompt.trim()
      if (!p && stats.pending === 0 && !running) {
        addToast({ message: '请输入提示词', type: 'warning' })
        return
      }
      if (p) {
        for (let i = 0; i < cardCount; i++) {
          addItem(p, itemOpts)
          enqueuedThisClick += 1
        }
      }
    } else {
      const p = multiText.trim()
      if (!p && stats.pending === 0 && !running) {
        addToast({ message: '请输入提示词', type: 'warning' })
        return
      }
      if (p) {
        for (let i = 0; i < perPromptCount; i++) {
          addItem(p, itemOpts)
          enqueuedThisClick += 1
        }
      }
    }

    // 2) 已经在跑 -> 工人会自动接管新加入的 items，本次调用只做加入通知
    //    然后返回，不要 await（也不要再发完成 toast，那一次会由最初点
    //    "开始生成" 的那次调用负责）。
    if (running) {
      if (enqueuedThisClick > 0) {
        addToast({
          message: `已加入运行队列 (+${enqueuedThisClick})`,
          type: 'info',
          duration: 2000,
        })
      }
      return
    }

    // 3) 没在跑 -> 启动 workers
    try {
      await runBatch(api, currentModelKey, {
        ratio, resolution, concurrency,
        referenceImages: refImages.map((r) => r.base64),
      })
      const finalState = useBatchStore.getState()
      const ok = finalState.items.filter((i) => i.status === 'done').length
      const errItems = finalState.items.filter((i) => i.status === 'error')
      if (errItems.length === 0) {
        addToast({ message: `批量完成: 全部 ${ok} 张成功`, type: 'success' })
      } else {
        const firstErr = errItems[0]?.error || '生成失败'
        addToast({
          message: `批量完成: 成功 ${ok} / 失败 ${errItems.length} — ${firstErr}`,
          type: errItems.length > 0 && ok === 0 ? 'error' : 'warning',
          duration: 6000,
        })
      }
    } catch (e) {
      addToast({
        message: `批量执行异常: ${e instanceof Error ? e.message : String(e)}`,
        type: 'error',
      })
    }
  }

  return (
    <BatchShell>
      <BatchHeader
        total={stats.total}
        done={stats.done}
        failed={stats.failed}
        running={stats.running}
        pending={stats.pending}
        onClearAll={handleClearAll}
        onClearResults={handleClearResults}
      />

      {/* 双栏:左 = 输入, 右 = 配置 + 参考图 */}
      <div className="batch-page-grid grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' }}>
        {/* ===== 左栏:模式 + 风格模板 + 视觉辅助 + 提示词输入 ===== */}
        <section className="space-y-3">
          <BatchModeSwitcher mode={mode} onChange={setMode} />
          <div>
            <TemplateInline context="batch" />
          </div>
          <BatchPromptHelperBar
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
            <BatchPromptCard
              prompt={cardPrompt}
              count={cardCount}
              onPromptChange={setCardPrompt}
              onCountChange={setCardCount}
              mediaRefs={batchMediaRefs}
            />
          ) : (
            <BatchPromptMulti
              text={multiText}
              onChange={setMultiText}
              perPromptCount={perPromptCount}
              onPerPromptCountChange={setPerPromptCount}
              mediaRefs={batchMediaRefs}
            />
          )}
        </section>

        {/* ===== 右栏:配置 + 参考图 ===== */}
        <section className="space-y-3">
          <BatchConfigGrid
            ratio={ratio}
            resolution={resolution}
            concurrency={concurrency}
            ratioOptions={ratioOptions}
            resolutionOptions={resolutionOptions}
            supportsResolution={supportsResolution}
            onRatioChange={setRatio}
            onResolutionChange={setResolution}
            onConcurrencyChange={setConcurrency}
            sizeHidden={sizeHidden}
          />
          <BatchRefDrop
            images={refImages}
            onAdd={addRefImage}
            onRemove={removeRefImage}
            onClear={clearRefImages}
            onPreview={handlePreview}
          />
        </section>
      </div>

      {/* ===== 全宽 ActionBar ===== */}
      <BatchActionBar
        total={stats.total}
        done={stats.done}
        failed={stats.failed}
        running={running}
        pendingCount={stats.pending}
        willEnqueue={willEnqueue}
        onGenerate={handleGenerate}
        onCancel={handleCancel}
        leftSlot={
          <BatchBudgetReceipt
            modelName={modelDisplayName}
            unitPrice={unitPrice}
            count={receiptCount}
            mode={mode}
          />
        }
      />

      {/* ===== 全宽结果网格 ===== */}
      <BatchResultGrid
        items={items}
        onRemove={removeItem}
        onPreview={handlePreview}
        onEditItem={handleEditItem}
      />

      {/* ===== 预览 modal ===== */}
      {previewUrl && createPortal(
        <div
          onClick={() => setPreviewUrl(null)}
          className="fixed inset-0 z-[70000] flex items-center justify-center bg-black/92 backdrop-blur p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-[92vw] max-h-[92vh] border-2 border-zinc-700 bg-zinc-950 shadow-2xl"
          >
            <img
              src={previewUrl}
              alt="preview"
              className="block max-w-[92vw] max-h-[92vh] object-contain"
            />
            <button
              type="button"
              onClick={() => setPreviewUrl(null)}
              aria-label="关闭预览"
              className="absolute top-2 right-2 w-9 h-9 flex items-center justify-center bg-zinc-900 border-2 border-zinc-700 text-white hover:bg-red-900/50 hover:border-red-700/60 text-lg font-bold transition-colors"
            >
              ×
            </button>
            <div className="absolute bottom-2 right-2 flex gap-2">
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
                aria-label="下载图片"
                className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black border-2 border-cyberpunk-yellow font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyberpunk-accent transition-colors"
              >
                ↓ 下载
              </button>
              {!previewUrl.startsWith('data:') && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 bg-zinc-900 text-zinc-200 border-2 border-zinc-700 font-mono text-xs font-bold uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors no-underline"
                >
                  打开 URL
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
          .batch-page-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
    </BatchShell>
  )
}
