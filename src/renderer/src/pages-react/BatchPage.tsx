import { useCallback, useMemo, useState } from 'react'
import { useModelStore, useToastStore, useBatchStore } from '../stores'
import { ImageLightbox } from '../components/shared/ImageLightbox'
import ImageEditActions, { type ImageEditorType } from '../components/shared/image-editors/ImageEditActions'
import ImageEditorModal from '../components/shared/image-editors/ImageEditorModal'
import { addImageUrlToReferences } from '../components/shared/image-editors/referenceTargets'
import '../components/shared/image-editors/image-editors.css'
import type { BatchItem } from '../stores/useBatchStore'
import { useApi } from '../hooks/useService'
import BatchShell from './batch/BatchShell'
import BatchHeader from './batch/BatchHeader'
import BatchModeSwitcher from './batch/BatchModeSwitcher'
import BatchPromptCard from './batch/BatchPromptCard'
import BatchPromptMulti from './batch/BatchPromptMulti'
import BatchConfigGrid from './batch/BatchConfigGrid'
import type { ImageParamModelConfig } from '../services/api/imageParamControls'
import BatchRefDrop from './batch/BatchRefDrop'
import BatchActionBar from './batch/BatchActionBar'
import BatchResultGrid from './batch/BatchResultGrid'
import BatchPromptHelperBar from './batch/BatchPromptHelperBar'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { BatchBudgetReceipt } from './batch/BatchBudgetReceipt'
import { extractPriceFromModel } from '../utils/model-price'
import { TemplateInline } from '../react-app/components/TemplateInline'
import { useRefImageModelSync } from '../hooks/useRefImageModelSync'

type ModelConfigSnapshot = ImageParamModelConfig & {
  name?: string
  displayName?: string
  price?: number
  /** base64 inline 模型(大香蕉系列):参考图本地直传 base64,不走 COS。 */
  inlineRefImageAsBase64?: boolean
  /** 端点类型;gemini-native = base64 内联组(nano / 大香蕉全系)。 */
  apiType?: string
}

/**
 * BatchPage — 批量生成页(干净赛博朋克版,沿用 GeneratePage zinc + cyberpunk-yellow 风)
 * 全部业务逻辑由 useBatchStore 驱动;早期 P5 朋克拼贴版的 PunkXxx 组件已移交 batch-punk/
 * 目录归档,本页不再引用。
 */
export default function BatchPage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  // ---- 配置 ----
  const mode = useBatchStore((s) => s.mode)
  const cardPrompt = useBatchStore((s) => s.cardPrompt)
  const cardCount = useBatchStore((s) => s.cardCount)
  const multiText = useBatchStore((s) => s.multiText)
  const ratio = useBatchStore((s) => s.ratio)
  const resolution = useBatchStore((s) => s.resolution)
  const quality = useBatchStore((s) => s.quality)
  const perPromptCount = useBatchStore((s) => s.perPromptCount)
  const count = useBatchStore((s) => s.count)
  const concurrency = useBatchStore((s) => s.concurrency)
  const refImages = useBatchStore((s) => s.refImages)

  // ---- 队列 ----
  const items = useBatchStore((s) => s.items)
  const running = useBatchStore((s) => s.running)

  // ---- actions (引用稳定, getState 一次取出) ----
  const {
    setMode, setCardPrompt, setCardCount, setMultiText,
    setRatio, setResolution, setQuality, setPerPromptCount, setCount, setConcurrency,
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

  // ---- 预览 lightbox (结果区 + 参考图共用,支持 ←/→ 左右切换) ----
  // kind 区分来源: 结果图预览带 多角度/打光/全景/导演台/加为参考图 动作行
  // (原缩略图悬停工具栏移到这里); 参考图预览保持纯预览。
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number; kind: 'results' | 'refs' } | null>(null)

  // ---- 预览页里的图片编辑器(多角度/打光/全景/导演台) ----
  const [editorState, setEditorState] = useState<{ url: string; type: ImageEditorType } | null>(null)

  const injectPrompt = useCallback((p: string) => {
    const { mode: m, cardPrompt: cp, multiText: mt, setCardPrompt: scp, setMultiText: smt } = useBatchStore.getState()
    if (m === 'card') scp(cp + '\n' + p)
    else smt(mt + '\n' + p)
  }, [])

  // ImageEditorModal 的 zIndex(9999) 低于 ImageLightbox(70000), 所以打开
  // 编辑器前必须先关掉预览层, 否则编辑器会被压在预览下面看不见。
  const handleOpenEditor = useCallback((url: string, type: ImageEditorType) => {
    setLightbox(null)
    setEditorState({ url, type })
  }, [])

  // ---- 当前 model 的 ratio / resolution 选项 ----
  // 纯从 model store 派生(与 GeneratePage 的 currentModel 同源),切换模型即同步更新。
  // 旧版从异步的 window.aiImageAPI.getCurrentModel()(= ApiService 单例)读,而 React
  // 选择器只更新 store、不回推单例,导致切完模型后 modelConfig 仍是旧值 —— 比例/分辨率/
  // 质量选项、单价、模型名全卡在上一个模型。现在 switchModel 已统一两端,这里直接吃 store。
  const modelConfig = useMemo<ModelConfigSnapshot | null>(
    () => (models[currentModelKey] as unknown as ModelConfigSnapshot | undefined) ?? null,
    [models, currentModelKey],
  )

  // gemini 原生端点 = base64 内联组:参考图以 inline_data 发送。
  // ⚠️ 必须从 model store **同步**派生(而非异步的 modelConfig),否则切换那一刻 flag
  // 是旧值,清洗会错过一拍 —— 这正是之前"批量页切两次才清理 + 卡顿"的根因。
  const wantsInlineBase64 = models[currentModelKey]?.apiType === 'gemini-native'

  // 切模型时双向清洗不兼容的参考图(与 GeneratePage 共用同一 hook,一改全改)。
  useRefImageModelSync({
    currentModelKey,
    wantsInlineBase64,
    syncRefs: useBatchStore.getState().syncRefImagesForModel,
    onRemoved: (removed, inlineBase64) => {
      addToast({
        message: inlineBase64
          ? `当前模型需内联图片,已清空 ${removed} 张云端 URL 参考图,请重新上传(会自动压缩)`
          : `当前模型需云端图片链接,已清空 ${removed} 张本地图片,请重新上传`,
        type: 'warning',
        duration: 3500,
      })
    },
  })

  // 比例/分辨率/清晰度的选项派生与自动归位全部下沉到共享的 ImageParamControls。

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

  // (p4) 预览回调必须引用稳定(空依赖), 否则 ResultCard.memo 全部失效。
  // 点击时用 getState() 即时取集合, 让 ImageLightbox 能在该集合里左右切换。
  const handlePreviewResult = useCallback((url: string) => {
    const its = useBatchStore.getState().items
    const doneUrls = its
      .filter((i) => i.status === 'done')
      .map((i) => i.resultUrl ?? i.cosUrl)
      .filter((u): u is string => !!u)
    setLightbox({ urls: doneUrls, index: Math.max(0, doneUrls.indexOf(url)), kind: 'results' })
  }, [])
  const handlePreviewRef = useCallback((url: string) => {
    const refs = useBatchStore.getState().refImages.map((r) => r.base64)
    setLightbox({ urls: refs, index: Math.max(0, refs.indexOf(url)), kind: 'refs' })
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
    // 入队时锁定当前 refs + ratio + model 到每个 item, 保证用户 mid-run 修改后
    // 追加的新 item 使用的是修改后的值(而非首次 runBatch 闭包里的旧值)。
    // model 尤其关键: 一批在跑时切了顶栏模型再点"加入队列", 新 item 必须用
    // 切换后的 currentModelKey, 否则会被在跑那批的闭包 modelKey 顶替(原 bug:
    // 切到 nano 后加的任务被当 gpt-image 发, 带着 nano 的 base64 refs → 失败)。
    const currentRefs = refImages.map((r) => r.base64)
    const itemOpts = { referenceImages: currentRefs, ratio, model: currentModelKey }
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
            modelConfig={modelConfig}
            ratio={ratio}
            resolution={resolution}
            quality={quality}
            count={count}
            concurrency={concurrency}
            onRatioChange={setRatio}
            onResolutionChange={setResolution}
            onQualityChange={setQuality}
            onCountChange={setCount}
            onConcurrencyChange={setConcurrency}
          />
          <BatchRefDrop
            images={refImages}
            onAdd={addRefImage}
            onRemove={removeRefImage}
            onClear={clearRefImages}
            onPreview={handlePreviewRef}
            preferBase64={wantsInlineBase64}
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
        onPreview={handlePreviewResult}
        onEditItem={handleEditItem}
      />

      {/* ===== 共享预览 lightbox(←/→ 左右切换,结果区/参考图共用) ===== */}
      {lightbox && (
        <ImageLightbox
          urls={lightbox.urls}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          renderActions={
            lightbox.kind === 'results'
              ? (currentUrl) => (
                  <ImageEditActions
                    theme="default"
                    imageUrl={currentUrl}
                    onOpenEditor={(type) => handleOpenEditor(currentUrl, type)}
                    onInjectPrompt={injectPrompt}
                    onAddReference={(url) => addImageUrlToReferences('batch', url)}
                  />
                )
              : undefined
          }
        />
      )}

      {/* ===== 预览页动作打开的图片编辑器(多角度/打光/全景/导演台) ===== */}
      {editorState && (
        <ImageEditorModal
          key={editorState.type}
          editorType={editorState.type}
          imageUrl={editorState.url}
          theme="default"
          directorEntry={editorState.type === 'director' ? 'panorama' : 'native'}
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
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
