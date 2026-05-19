import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'
import { uploadImageUrlToCos } from '../utils/cosImageUpload'

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
  addReferenceImage: (dataUrl: string) => void
  removeReferenceImage: (index: number) => void
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
  addReferenceImage: (dataUrl) => set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReferenceImage: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),
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
    const { prompt, ratio, referenceImages } = get()
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

      // Fire-and-forget: 每张图独立异步上传到 COS, 回来后用 id 找索引热切。
      //
      // 关键约束:
      // 1) 不 await — 让 generate() 立即结束, UI 立刻拿到 modelUrl 占位。
      // 2) 回调可能跑得很晚, 用 id 找索引(数组可能已被 clearResults 清掉,
      //    或者被别的 generate 追加, 索引早就变了)。
      // 3) clearResults 之后, 当前 store 中已经没有该 id, set 时静默丢弃。
      // 4) 写 history 也在这个回调里 — 这样能拿到 cosUrl(若成功), 失败则
      //    fallback 到 modelUrl。和 useBatchStore 的策略对齐。
      newMetas.forEach((meta) => {
        void uploadImageUrlToCos(meta.modelUrl, {
          metadata: { source: 'generate', prompt: finalPrompt, model: modelKey },
        }).then((res) => {
          set((s) => {
            const idx = s.resultMeta.findIndex((m) => m.id === meta.id)
            if (idx < 0) return s // 已被 clearResults 清掉, 静默
            const nextMeta = s.resultMeta.slice()
            const nextUrls = s.resultUrls.slice()
            if (res.ok) {
              nextMeta[idx] = {
                ...nextMeta[idx],
                cosUrl: res.url,
                uploadStatus: 'uploaded',
                uploadError: undefined,
              }
              // 热切 displayUrl: 把同位置的 resultUrls[i] 改成 cosUrl。
              // 这样老消费者(ResultGrid 之类只看 urls)不用改也能拿到 COS URL。
              nextUrls[idx] = res.url
            } else {
              nextMeta[idx] = {
                ...nextMeta[idx],
                uploadStatus: 'failed',
                uploadError: res.error,
              }
              // 失败保留 modelUrl 在 resultUrls 中 — UI 至少还能看到图。
            }
            return { resultMeta: nextMeta, resultUrls: nextUrls }
          })

          // 写一条 history。
          // - 失败也写 — 让用户能从历史里再点重新编辑, prompt/refs 还在。
          // - 用 window.historyDataServiceTS 是和 useBatchStore.ts 一致的桥,
          //   避免在 store 里硬引用 service 单例(便于测试 mock)。
          const historyService = (window as unknown as {
            historyDataServiceTS?: {
              addToHistory?: (
                type: string,
                prompt: string,
                urls: string[],
                ratio?: string,
                model?: string,
                extras?: { referenceImages?: string[] }
              ) => Promise<unknown>
            }
          }).historyDataServiceTS
          if (historyService?.addToHistory) {
            const persistUrl = res.ok ? res.url : meta.modelUrl
            const historyType =
              refsSnapshot && refsSnapshot.length > 0
                ? 'generate-with-reference'
                : 'generate'
            void historyService
              .addToHistory(historyType, prompt, [persistUrl], ratio, modelKey, {
                referenceImages: refsSnapshot,
              })
              .catch((e: unknown) =>
                console.warn('[Generate] history save failed:', e),
              )
          }
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
