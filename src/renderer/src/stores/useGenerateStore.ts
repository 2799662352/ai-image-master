import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'
import { enqueueCosUpload, registerCosUploadHandler } from '../utils/cosUploadDispatcher'

/**
 * 单张生成结果的异步存储状态。
 * - `uploading`: 已拿到模型直出 URL,正在异步往腾讯云 COS 推
 * - `uploaded`:  COS URL 已回来,resultUrls 同位置应该被热切到 cosUrl
 * - `failed`:    COS 出错,resultUrls 仍是模型直出(可能短期内过期)
 */
export type ResultUploadStatus = 'uploading' | 'uploaded' | 'failed'

/**
 * 与 `resultUrls` 一一对应的元数据(按索引对齐)。
 * 抽出来是因为 `resultUrls: string[]` 是历史 UI 直接消费的字段,
 * 我们不破坏它,只在它旁边挂一份 meta:渲染层就能"先看 cosUrl,再回退 modelUrl"。
 *
 * `id` 用于解决并发追加问题:upload 是异步的,等回调时数组可能已经追加了
 * 别人的结果或者被 clearResults 整体清空,直接用旧索引会写错位置。
 * 所以每次 push 时分配一个稳定 id,upload 回调里用 id 找当前索引再 set。
 *
 * `snapshot` 是"产生这张图时的表单参数快照", 给"重新编辑"按钮用 ——
 * 即便用户后续改了 prompt/refs, 这里依然记得该结果是怎么来的。
 * 同 prompt 一批多张图共享同一份 snapshot(浅 clone, 不深拷贝)。
 */
export interface GenerateSnapshot {
  prompt: string
  ratio: string
  referenceImages: string[]
  modelKey: string
}

export interface ResultUploadMeta {
  id: string
  modelUrl: string
  cosUrl?: string
  uploadStatus: ResultUploadStatus
  uploadError?: string
  snapshot?: GenerateSnapshot
}

export interface GenerateState {
  prompt: string
  ratio: string
  /** 分辨率档位(1K/2K/4K); 仅支持 resolutionControl 的模型有效 */
  resolution: string
  /** 清晰度 quality(auto/low/medium/high); 仅 gpt-image-2 等有效 */
  quality: string
  /**
   * True when at least one in-flight generate call exists.
   * Derived from `inFlightCount > 0`. Kept as a discrete field for cheap
   * Zustand subscription + backward compat with existing tests/UI.
   */
  generating: boolean
  /** Number of concurrent in-flight generate() calls (≥ 0). */
  inFlightCount: number
  /**
   * 展示用 URL 列表 —— 上传完成前是 modelUrl, 上传成功后会被热切到 cosUrl。
   * 老消费者(ResultGrid)只需要 url 字符串数组,所以保持这个字段。
   */
  resultUrls: string[]
  /**
   * 与 `resultUrls` 同长度同索引的元数据。新代码看这里就能区分:
   * "这张图已经持久化到 COS 没?有没有失败?"
   */
  resultMeta: ResultUploadMeta[]
  referenceImages: string[]
  /** Latest error message (overwritten on each failure). */
  error: string | null

  setPrompt: (v: string) => void
  setRatio: (v: string) => void
  setResolution: (v: string) => void
  setQuality: (v: string) => void
  addReferenceImage: (dataUrl: string) => void
  removeReferenceImage: (index: number) => void
  clearReferenceImages: () => void
  clearResults: () => void
  generate: (api: ApiActions, modelKey: string) => Promise<void>
  /**
   * 把一组表单参数回灌到当前 store, 用于"重新编辑"。
   * 不会触发生成 —— 只是恢复表单状态, 让用户能继续修改后再点生成。
   *
   * 来源可能是:
   * - 历史记录(HistoryItem 的 prompt/ratio/referenceImages/model)
   * - 当前结果的 snapshot(用户想基于某张图微调再生成)
   *
   * modelKey 用 caller 的 setter 单独切换 model store, 这里不耦合
   * useModelStore — 保持各 store 解耦, 同时让"找不到 model 时怎么处理"
   * 由 UI 决定(toast 提示 / 静默)。
   */
  restoreForEdit: (snapshot: Partial<GenerateSnapshot>) => void
}

export const initialState = {
  prompt: '',
  ratio: '1:1',
  resolution: '2K',
  quality: 'auto',
  generating: false,
  inFlightCount: 0,
  resultUrls: [] as string[],
  resultMeta: [] as ResultUploadMeta[],
  referenceImages: [] as string[],
  error: null as string | null,
}

/** 生成稳定 id —— 优先 crypto.randomUUID, 兼容老浏览器和测试环境。 */
function nextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 单次会话保留的最大结果数。长时间生图(几百张)若不限上限,
 * resultUrls + resultMeta 会无界增长占内存。超过上限后从最老的开始 FIFO 丢弃。
 *
 * 配置入口:env 优先, 否则取默认。改为 const 而非 store 字段是因为它属于
 * "应用配置"而非 UI 状态, 让它在测试里也保持稳定可预期。
 */
const MAX_RESULT_HISTORY = 200

export const useGenerateStore = create<GenerateState>((set, get) => ({
  ...initialState,

  setPrompt: (v) => set({ prompt: v }),
  setRatio: (v) => set({ ratio: v }),
  setResolution: (v) => set({ resolution: v }),
  setQuality: (v) => set({ quality: v }),
  addReferenceImage: (dataUrl) => set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReferenceImage: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),
  clearReferenceImages: () => set({ referenceImages: [] }),
  clearResults: () => set({ resultUrls: [], resultMeta: [], error: null }),

  restoreForEdit: (snapshot) => {
    // Partial: 缺哪个字段就不动哪个, 保留当前 store 现状。
    // 这样从历史里恢复一条没存 refs 的老记录, 不会把现存 refs 误清掉。
    set((s) => ({
      prompt: snapshot.prompt !== undefined ? snapshot.prompt : s.prompt,
      ratio: snapshot.ratio !== undefined ? snapshot.ratio : s.ratio,
      referenceImages:
        snapshot.referenceImages !== undefined
          ? [...snapshot.referenceImages]
          : s.referenceImages,
      error: null,
    }))
  },

  generate: async (api, modelKey) => {
    // Snapshot form values at submit time so the user can keep typing the
    // next prompt while this one is in flight (matches BatchPage live-queue
    // semantics — no blocking guard, results stream back).
    const { prompt, ratio, resolution, quality, referenceImages } = get()
    const templateKey = useTemplateStore.getState().getSelection('generate')
    const finalPrompt = composePromptWithTemplate(templateKey, prompt)
    const refsSnapshot = referenceImages.length > 0 ? [...referenceImages] : undefined

    // 用户实际看到 + 输入的原始 prompt(不含模板套词), 用来回灌表单 ——
    // 否则"重新编辑"会把模板套词回灌进 textarea, 用户改一次又被套一次。
    const editSnapshot: GenerateSnapshot = {
      prompt,
      ratio,
      referenceImages: refsSnapshot ?? [],
      modelKey,
    }

    set((s) => ({
      inFlightCount: s.inFlightCount + 1,
      generating: true,
      error: null,
    }))

    try {
      const result = await api.generateImage({
        prompt: finalPrompt,
        ratio,
        resolution,
        quality,
        model: modelKey,
        referenceImages: refsSnapshot,
      })
      const urls = result.urls ?? result.images ?? []

      // 为每张图分配 id + meta, 同步推入 resultUrls / resultMeta 两个数组。
      // snapshot 同一批 N 张图共享 — 浅引用即可, restoreForEdit 在写入时
      // 会拷一份, 这里不防御性深拷。
      const newMetas: ResultUploadMeta[] = urls.map((u: string) => ({
        id: nextId(),
        modelUrl: u,
        uploadStatus: 'uploading' as const,
        snapshot: editSnapshot,
      }))

      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        // 软上限 FIFO: append 完后若超 MAX_RESULT_HISTORY 就从头部 slice 掉,
        // 保证两个数组依然同长同索引 — 后续 upload 回调还要靠 id 找索引,
        // 所以"超出上限的旧 meta 直接丢"是可接受的语义损失。
        const combinedUrls = [...s.resultUrls, ...urls]
        const combinedMeta = [...s.resultMeta, ...newMetas]
        const overflow = Math.max(0, combinedUrls.length - MAX_RESULT_HISTORY)
        return {
          resultUrls: overflow > 0 ? combinedUrls.slice(overflow) : combinedUrls,
          resultMeta: overflow > 0 ? combinedMeta.slice(overflow) : combinedMeta,
          inFlightCount: nextCount,
          generating: nextCount > 0,
        }
      })

      // 真 fire-and-forget: 同步入队 N 张, 每张 0 个 pending promise / 0 个
      // .then 微任务。主进程后台 fetch → 上传 COS, 完成后通过事件回推, 由
      // generateUploadResultHandler(模块底部一次性注册)统一处理 set + 写
      // history。这样 N 张图同时返回时, generate() 不会被任何 await/.then
      // 链堵塞, 也不会引发 N 次连环 React 重渲染。
      //
      // pendingHistoryContext 保存写 history 所需的上下文(prompt/ratio/refs
      // 这些每次 generate 的不同变量), 事件回调按 id 查表。和上面 forEach
      // 闭包捕获等价, 只是通过 Map 解耦了上传链。
      newMetas.forEach((meta) => {
        pendingHistoryContext.set(meta.id, {
          modelUrl: meta.modelUrl,
          prompt,
          ratio,
          modelKey,
          refsSnapshot,
        })
        enqueueCosUpload(meta.id, meta.modelUrl, {
          source: 'generate',
          prompt: finalPrompt,
          model: modelKey,
        })
      })
    } catch (err) {
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        return {
          error: err instanceof Error ? err.message : String(err),
          inFlightCount: nextCount,
          generating: nextCount > 0,
        }
      })
    }
  },
}))

// ============== 异步 COS 上传结果路由 ==============
//
// generate() 把每张图入队后立刻 return, 不持有 promise。主进程上传完成
// 后通过 'cos:upload-result' 事件把结果推回, 这里按 'generate:' 前缀路由
// 接收, 执行: ① 把 cosUrl 回填到 resultMeta(供持久化层用); ② 写一条
// history(失败也写, 但 url 用 modelUrl fallback)。
//
// pendingHistoryContext 是 id → {prompt, ratio, modelKey, refsSnapshot,
// modelUrl} 的暂存表 —— 等价于原 forEach 闭包捕获的局部变量, 用 Map 解耦
// 后允许 await IPC 链整段消失。事件回调消费后立刻 delete 防泄漏。

interface PendingGenerateHistoryCtx {
  modelUrl: string
  prompt: string
  ratio: string
  modelKey: string
  refsSnapshot: string[] | undefined
}

const pendingHistoryContext = new Map<string, PendingGenerateHistoryCtx>()

interface HistoryServiceBridge {
  addToHistory?: (
    type: string,
    prompt: string,
    urls: string[],
    ratio?: string,
    model?: string,
    extras?: { referenceImages?: string[] },
  ) => Promise<unknown>
}

registerCosUploadHandler('generate:', (result) => {
  const id = result.requestId.slice('generate:'.length)
  const ctx = pendingHistoryContext.get(id)
  if (!ctx) return
  pendingHistoryContext.delete(id)

  useGenerateStore.setState((s) => {
    const idx = s.resultMeta.findIndex((m) => m.id === id)
    if (idx < 0) return s
    const nextMeta = s.resultMeta.slice()
    if (result.success) {
      nextMeta[idx] = {
        ...nextMeta[idx],
        cosUrl: result.url,
        uploadStatus: 'uploaded',
        uploadError: undefined,
      }
    } else {
      nextMeta[idx] = {
        ...nextMeta[idx],
        uploadStatus: 'failed',
        uploadError: result.error,
      }
    }
    return { resultMeta: nextMeta }
  })

  const historyService = (window as unknown as {
    historyDataServiceTS?: HistoryServiceBridge
  }).historyDataServiceTS
  if (historyService?.addToHistory) {
    const persistUrl = result.success ? result.url : ctx.modelUrl
    const historyType =
      ctx.refsSnapshot && ctx.refsSnapshot.length > 0
        ? 'generate-with-reference'
        : 'generate'
    void historyService
      .addToHistory(historyType, ctx.prompt, [persistUrl], ctx.ratio, ctx.modelKey, {
        referenceImages: ctx.refsSnapshot,
      })
      .catch((e: unknown) => console.warn('[Generate] history save failed:', e))
  }
})
