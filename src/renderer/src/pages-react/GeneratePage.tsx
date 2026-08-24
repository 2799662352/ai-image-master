import { useRef, useMemo, useCallback, useState } from 'react'
import { useModelStore, useToastStore, useGenerateStore } from '../stores'
import { ImageLightbox } from '../components/shared/ImageLightbox'
import { useApi } from '../hooks/useService'
import type { GenerateSnapshot } from '../stores/useGenerateStore'
import type { BatchRefImage } from '../stores/useBatchStore'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { ImageParamControls } from '../react-app/components/ImageParamControls'
import { TemplateInline } from '../react-app/components/TemplateInline'
import BatchRefDrop from './batch/BatchRefDrop'
import BatchPromptHelperBar from './batch/BatchPromptHelperBar'
import { ResultGrid } from './generate/ResultGrid'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../components/shared/media-tokens'
import '../components/shared/media-tokens/media-tokens.css'
import { useRefImageModelSync } from '../hooks/useRefImageModelSync'
import { toUpstreamFetchableImage } from '../components/shared/image-editors/referenceTargets'

export default function GeneratePage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const prompt = useGenerateStore((s) => s.prompt)
  const ratio = useGenerateStore((s) => s.ratio)
  const resolution = useGenerateStore((s) => s.resolution)
  const quality = useGenerateStore((s) => s.quality)
  const count = useGenerateStore((s) => s.count)
  const generating = useGenerateStore((s) => s.generating)
  const inFlightCount = useGenerateStore((s) => s.inFlightCount)
  const resultUrls = useGenerateStore((s) => s.resultUrls)
  const resultMeta = useGenerateStore((s) => s.resultMeta)
  const referenceImages = useGenerateStore((s) => s.referenceImages)
  const splitDraft = useGenerateStore((s) => s.splitDraft)

  const {
    setPrompt,
    setRatio,
    setResolution,
    setQuality,
    setCount,
    addReferenceImage,
    removeReferenceImage,
    clearReferenceImages,
    syncReferenceImagesForModel,
    clearResults,
    generate,
    restoreForEdit,
    enterSplitMode,
    exitSplitMode,
    runSplit,
  } = useGenerateStore.getState()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const currentModel = models[currentModelKey]
  // gemini 原生端点(nano / 大香蕉全系)= base64 内联组:参考图以 inline_data 发送。
  const wantsInlineBase64 = currentModel?.apiType === 'gemini-native'

  // 切模型时双向清洗不兼容的参考图(共用 hook,生成/批量一致,一改全改)。
  useRefImageModelSync({
    currentModelKey,
    wantsInlineBase64,
    syncRefs: syncReferenceImagesForModel,
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

  // ---- 预览 lightbox (结果区 + 参考图共用,支持 ←/→ 左右切换) ----
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null)

  const genMediaRefs = useMemo<MediaRef[]>(
    () => referenceImages.map((url, i) => ({
      index: i + 1,
      type: 'image' as const,
      url,
      label: `图片${i + 1}`,
    })),
    [referenceImages],
  )

  // 适配器:generate store 的 referenceImages 是 string[](沿用既有
  // 生成/COS/历史/快照管线,零改动),而共享组件 BatchRefDrop /
  // BatchPromptHelperBar 期望 BatchRefImage[]。这里用 index 作为稳定 id
  // 做一层薄映射,复用同一套压缩 + 预览 + [多角度][打光] 逻辑。
  const refImageObjs = useMemo<BatchRefImage[]>(
    () => referenceImages.map((url, i) => ({
      id: String(i),
      base64: url,
      fileName: `图片${i + 1}`,
      fileSize: 0,
    })),
    [referenceImages],
  )

  const ac = useTokenAutocomplete({
    mediaRefs: genMediaRefs,
    textareaRef,
    value: prompt,
    onValueChange: setPrompt,
  })
  useAutosizeTextarea(textareaRef, prompt, { minRows: 4, maxRows: 20 })

  // 提示按「这一次点击」来发,不按 error 字符串的变化来发:同一个原因连续
  // 失败两次时,依赖 [error] 的 effect 第二次不会重跑,那一次就悄无声息了。

  const handleGenerate = async () => {
    // 拆图状态下主按钮已改名「拆图」,走的是另一条路:模型钉死 SD5 Pro、不吃比例/张数。
    // prompt 照吃 —— 上游用它指定「要拆出什么」(如「女人抠出来」),空串才是自动全拆,
    // 所以下面那条「请输入提示词」的守卫不适用于这条路。
    // 在这里分流而不是让两套 UI 各自有按钮,是因为「一个主行动按钮」才说得清
    // 当下点下去会发生什么。
    if (splitDraft) {
      addToast({ message: '正在拆分图层…（按张计费，最多 17 张）', type: 'info' })
      const { added, error: failure } = await runSplit(api)
      if (failure) {
        addToast({ message: failure, type: 'error' })
        return
      }
      if (added > 0) addToast({ message: `图层分离完成（${added} 层）`, type: 'success' })
      return
    }
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    if (!currentModelKey) {
      addToast({ message: '请先在顶部选择模型', type: 'warning' })
      return
    }
    // Non-blocking: each click fires a concurrent generation. We do NOT clear
    // results — completed images stream into the grid below. Use the "清空"
    // button next to the grid to reset.
    // 张数取自本次调用的回执,不是全局结果数之差 —— 并发点两次时,
    // 用差值会把另一次的图算进这一次。
    const { added, error: failure } = await generate(api, currentModelKey)
    if (failure) {
      addToast({ message: failure, type: 'error' })
      return
    }
    if (added > 0) {
      addToast({ message: `生成完成 (+${added} 张)`, type: 'success' })
    }
  }

  /**
   * 点「图层分离」:选中待拆的图,主按钮随之改名「拆图」。再点一次取消。
   *
   * 不当场发是因为拆分按张计费(一张复杂图能出 17 张)—— 一次误点就是一次扣费。
   * 状态只有一个 bit,由那个按钮自己的按下态表达,不另起 UI。
   */
  const handleLayerSplit = useCallback(async (imageUrl: string) => {
    if (useGenerateStore.getState().splitDraft) {
      exitSplitMode()
      return
    }
    // base64 直出模型(nano2 4K 等)的结果图是 blob:,只在本渲染进程内有效;
    // 直接发出去会被 normalizeImageSource 当成裸 base64 拼成垃圾 data URL。
    // 在选中时就归一化,而不是等点「拆图」—— 那时再失败就晚了(用户以为已就绪)。
    const source = await toUpstreamFetchableImage(imageUrl)
    enterSplitMode(source)
  }, [enterSplitMode, exitSplitMode])

  /**
   * 点 [重编辑] 按钮: 把对应结果的 snapshot 灌回表单。
   *
   * 用户已经在 generate 页, 不用切 tab。但要:
   * 1) 把 prompt/refs/ratio 写回表单, 并切换 model store
   * 2) 让 textarea 立刻看到新 prompt(setPrompt 已经走 store, autosize 自动跟随)
   * 3) toast 提示一下, 避免静默把表单刷掉用户看不到
   */
  const handleEditFromResult = useCallback((snapshot: GenerateSnapshot) => {
    restoreForEdit({
      prompt: snapshot.prompt,
      ratio: snapshot.ratio,
      referenceImages: snapshot.referenceImages,
    })
    if (snapshot.modelKey && models[snapshot.modelKey]) {
      useModelStore.getState().switchModel(snapshot.modelKey)
    }
    addToast({ type: 'success', message: '参数已恢复, 修改后再点生成 / RESTORED' })
  }, [restoreForEdit, models, addToast])

  // [多角度][打光] 注入:追加到当前 prompt 末尾(对齐 BatchPage.onInject)
  const handleInjectPrompt = useCallback((text: string) => {
    const cur = useGenerateStore.getState()
    const sep = cur.prompt && !cur.prompt.endsWith('\n') ? '\n\n' : ''
    cur.setPrompt(cur.prompt + sep + text)
  }, [])

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🎨 AI 图片生成</h1>
        {currentModel && (
          <span className="text-sm text-zinc-500">
            当前模型: <span className="text-cyberpunk-yellow">{currentModel.name}</span>
          </span>
        )}
      </div>

      <TemplateInline context="generate" />

      {/* 视觉 prompt 辅助:[多角度][打光](复用 Batch 的共享组件,接 useGenerateStore) */}
      <BatchPromptHelperBar
        refImages={refImageObjs}
        onInject={handleInjectPrompt}
        onLayerSplit={handleLayerSplit}
        splitArmed={!!splitDraft}
      />

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={ac.handleChange}
          onKeyDown={ac.handleKeyDown}
          placeholder="描述你想要生成的图片... 输入 @ 引用参考图"
          rows={4}
          className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none transition-[height] duration-100"
        />
        <TokenAutocomplete
          visible={ac.visible}
          suggestions={ac.suggestions}
          selectedIndex={ac.selectedIndex}
          position={ac.position}
          theme="default"
          onSelect={ac.selectToken}
          onClose={ac.handleClose}
          onHover={ac.handleHover}
        />
        <MentionChips value={prompt} mediaRefs={genMediaRefs} theme="default" onValueChange={setPrompt} />
      </div>

      <ImageParamControls
        variant="cyberpunk"
        modelConfig={currentModel}
        ratio={ratio}
        onRatioChange={setRatio}
        resolution={resolution}
        onResolutionChange={setResolution}
        quality={quality}
        onQualityChange={setQuality}
        count={count}
        onCountChange={setCount}
      />

      {/* 参考图:复用 Batch 的拖拽上传 + 自动压缩 + 点击预览 */}
      <BatchRefDrop
        images={refImageObjs}
        onAdd={(img) => addReferenceImage(img.base64)}
        onRemove={(id) => removeReferenceImage(Number(id))}
        onClear={clearReferenceImages}
        onPreview={(url) => setLightbox({ urls: referenceImages, index: Math.max(0, referenceImages.indexOf(url)) })}
        preferBase64={wantsInlineBase64}
      />

      <button
        onClick={handleGenerate}
        // 拆图状态不看 prompt(空 prompt = 自动全拆),也不看当前模型(渠道钉死 SD5 Pro)。
        disabled={splitDraft ? false : !prompt.trim() || !currentModelKey}
        className={`w-full py-3 font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50 ${
          splitDraft
            ? 'bg-amber-400 text-cyberpunk-black'
            : 'bg-cyberpunk-yellow text-cyberpunk-black'
        }`}
      >
        {splitDraft
          ? '拆图 // 图层分离'
          : generating
            ? `加入队列 (运行中 × ${inFlightCount})`
            : '开始生成'}
      </button>

      {resultUrls.length > 0 && (
        <div className="flex items-center justify-between border-t-2 border-zinc-800 pt-3">
          <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
            结果 · {resultUrls.length} 张{generating ? ` · 还有 ${inFlightCount} 个在生成` : ''}
          </span>
          <button
            type="button"
            onClick={clearResults}
            className="px-3 py-1 text-xs uppercase tracking-wider text-zinc-400 border border-zinc-700 hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors"
          >
            清空
          </button>
        </div>
      )}

      <ResultGrid
        urls={resultUrls}
        meta={resultMeta}
        onEditFromResult={handleEditFromResult}
        onPreview={(index) => setLightbox({ urls: resultUrls, index })}
        onLayerSplit={handleLayerSplit}
      />

      {/* ===== 共享预览 lightbox(←/→ 左右切换,结果区/参考图共用) ===== */}
      {lightbox && (
        <ImageLightbox
          urls={lightbox.urls}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}
