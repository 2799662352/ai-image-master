import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'
import {
  enqueueCosUpload,
  enqueueCosUploadBlob,
  registerCosUploadHandler,
} from '../utils/cosUploadDispatcher'
import { materializeImageUrls, revokeLater, isPersistableUrl } from '../utils/imageResources'
import { LAYER_SPLIT_DEFAULT_RESOLUTION } from '../services/api/imageParamControls'
import { toRenderableUri } from '../features/file-explorer/uri'

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

/**
 * 图层拆分产物的元数据。**只存元数据，不存 url** —— url 一律从同索引的
 * `resultUrls[i]` 取。
 *
 * 这不是洁癖:上传完成后 store 会把 `resultUrls[i]` 热切成 cosUrl(模型直出链
 * 24h 过期)。图层要是自带一份 url，热切之后图层面板里就还是那条过期链接，
 * 表现为「关掉重开图层就全裂了」。
 */
export interface ResultLayerMeta {
  /** 叠放层级，0 = 底图。同组内唯一，升序即从下到上的绘制顺序。 */
  zIndex: number
  /** 上游给的图层名（如「前景人物」）；可能缺席，UI 兜底成「图层 N」。 */
  name?: string
  description?: string
  boundingBox?: { absolute?: number[]; normalized?: number[] }
}

export interface ResultUploadMeta {
  id: string
  modelUrl: string
  cosUrl?: string
  /**
   * 本地磁盘副本绝对路径 (2026-07-09, 参照 codex 页 MCP 出图):
   * 主进程上传前先落 userData/generated-images。COS 失败时 history
   * 写 local-file:// 形式的这份副本, 跨重启仍可显示。
   */
  localPath?: string
  uploadStatus: ResultUploadStatus
  uploadError?: string
  snapshot?: GenerateSnapshot
  /**
   * 同一次图层拆分产出的所有图共享这个 id。ResultGrid 据此把它们收成**一张**卡片
   * —— 平铺成 N 张会让「一个带内部结构的产物」看起来像 N 个互不相干的结果。
   */
  layerGroupId?: string
  /** 本张图在图层栈里的位置与命名。与 layerGroupId 同时出现。 */
  layer?: ResultLayerMeta
}

/** 一次 generate() 的结局:新增了几张,以及失败时的原因。 */
export interface GenerateOutcome {
  added: number
  error?: string
}

/** 待执行的一次图层分离。字段就这两个 —— 拆分不吃 prompt/比例/张数。 */
export interface SplitDraft {
  /** 待拆的那张图,已归一化成上游可取的形态(http(s) 或 data:)。 */
  imageUrl: string
  /**
   * 分辨率**档位**(auto/1K/1.5K/2K),不是像素尺寸,也不复用出图表单那一套。
   * 默认 auto = 跟随原图:拆的就是眼前这张,底图该保持它的尺寸与宽高比。
   */
  resolution: string
}

export interface GenerateState {
  prompt: string
  ratio: string
  /** 分辨率档位(1K/2K/4K); 仅支持 resolutionControl 的模型有效 */
  resolution: string
  /** 清晰度 quality(auto/low/medium/high); 仅 gpt-image-2 等有效 */
  quality: string
  /** 出图张数(组图); 仅 multipleImages 模型有效, 万相 wan2.7 多张走 enable_sequential 系列一致 */
  count: number
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
  /**
   * 拆图状态。非 null = 页面处于「图层分离」待执行状态:主按钮从「生成」改名
   * 「拆图」,点它跑的是拆分而不是出图;状态里还能改档位、换待拆的图。
   *
   * 为什么是**独立状态**而不是出图表单的一个字段:
   * - 表单字段(prompt/ratio/count/resolution/refs)描述「下一次出图长什么样」。
   *   拆分不出新图,它只吃一张图 + 一个档位,与那些字段一个都不共用。
   *   混进去的后果上一版试过了:比例/数量得灰掉、切模型得自动关、分辨率得换一套
   *   档位再换回来 —— 全是为了让拆分假装成一次出图而付的税。
   * - 独立状态下,退出 = 置 null,出图表单原封不动(用户正写的 prompt 还在)。
   *
   * 与「点一下直接发」的区别:拆分按张计费,一张复杂图能出 17 张。给个能反悔、
   * 能调档位的中间态,比点错了直接扣钱好。
   */
  splitDraft: SplitDraft | null

  setPrompt: (v: string) => void
  setRatio: (v: string) => void
  setResolution: (v: string) => void
  setQuality: (v: string) => void
  setCount: (v: number) => void
  addReferenceImage: (dataUrl: string) => void
  removeReferenceImage: (index: number) => void
  clearReferenceImages: () => void
  /**
   * 按新模型的参考图制式**双向**清洗参考图,返回删除数量。
   * - wantsInlineBase64=true(切到 nano/gemini 原生):删掉 http(s) URL,保留本地 base64。
   * - wantsInlineBase64=false(切到万相等 URL 模型):删掉本地 data: base64,保留 URL。
   * 两类端点参考图格式互不兼容,与其发送时偷偷转码(易卡/跨域失败),不如切换时清掉
   * 让用户重新上传(重新上传走正确的 skipCos 策略,见 BatchRefDrop / refImageUpload)。
   */
  syncReferenceImagesForModel: (wantsInlineBase64: boolean) => number
  clearResults: () => void
  /**
   * 发起一次生成。
   *
   * 结果直接回给调用方而不是只写进 store:这个页面允许并发点,靠"全局结果
   * 张数差"反推本次成没成,会把并发那一次的图算到自己头上。
   *
   * `overrides` 用于**不经表单的一次性生成** —— 目前只有图层分离。给了就用它替换
   * 对应的表单快照值,**表单本身一个字都不动**(用户正在写的下一条 prompt 不该被洗掉)。
   *
   * 这是图层分离与正常出图的分界线,刻意如此:它曾经是参数区的一个开关,勾了之后
   * 「生成」按钮的语义就变了,还得连带把比例/数量灰掉、切模型时自动关 —— 两件事
   * 焊死在一起。现在拆分自带入参(见 `splitDraft`),出图表单不知道有这回事。
   *
   * 产出照常进结果区,复用同一条物化 / FIFO / COS 上传流水线 —— 复用管线不等于耦合
   * 语义,那条管线只关心「有 N 张图要落盘」。
   */
  generate: (
    api: ApiActions,
    modelKey: string,
    overrides?: {
      prompt?: string
      referenceImages?: string[]
      layerDecomposition?: boolean
      resolution?: string
    },
  ) => Promise<GenerateOutcome>
  /** 进入拆图状态。已在状态中则换掉待拆的图,档位保留(用户刚调过的不该被重置)。 */
  enterSplitMode: (imageUrl: string) => void
  /** 状态中调参(目前只有档位)。不在状态中是 no-op。 */
  updateSplitDraft: (patch: Partial<SplitDraft>) => void
  /** 退出拆图状态。出图表单不受影响。 */
  exitSplitMode: () => void
  /**
   * 执行当前拆图状态。不在状态中返回 `added: 0`。
   *
   * 用出图框里那句当 prompt —— 上游拿它指定「要拆出什么」(如「只把人抠出来」),
   * 空串才是自动全拆。模型钉死 SD5 Pro,不看用户当前选的是什么:拆分只有它能做,
   * 按选中模型跑只会拿到一句能力守卫的报错,而用户并不知道该先去切模型。
   *
   * **跑完不退出状态** —— 同一张图常要换几种说法试,退出由用户显式点按钮完成。
   */
  runSplit: (api: ApiActions) => Promise<GenerateOutcome>
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
  count: 1,
  generating: false,
  inFlightCount: 0,
  resultUrls: [] as string[],
  resultMeta: [] as ResultUploadMeta[],
  referenceImages: [] as string[],
  error: null as string | null,
  splitDraft: null as SplitDraft | null,
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

/**
 * 图层分离唯一支持的渠道。对某张已有图点「图层分离」时强制走它,不看用户当前
 * 选的模型 —— 换个渠道这个动作根本做不了,让它按选中模型跑只会拿到一个能力守卫
 * 的报错,而用户并不知道自己该先去切模型。
 */
export const LAYER_SPLIT_MODEL = 'doubao-seedream-5-0-pro-260628'

/** 拆图状态的默认档位 = 跟随原图。见 LAYER_SPLIT_DEFAULT_RESOLUTION 的说明。 */
const SPLIT_DEFAULT_RESOLUTION = LAYER_SPLIT_DEFAULT_RESOLUTION

export const useGenerateStore = create<GenerateState>((set, get) => ({
  ...initialState,

  setPrompt: (v) => set({ prompt: v }),
  setRatio: (v) => set({ ratio: v }),
  setResolution: (v) => set({ resolution: v }),
  setQuality: (v) => set({ quality: v }),
  setCount: (v) => set({ count: v }),
  addReferenceImage: (dataUrl) => set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReferenceImage: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),
  clearReferenceImages: () => set({ referenceImages: [] }),
  syncReferenceImagesForModel: (wantsInlineBase64) => {
    const before = get().referenceImages
    const kept = before.filter((s) =>
      wantsInlineBase64
        ? !/^https?:\/\//i.test(s) // base64 模型:删远端 URL
        : !/^data:/i.test(s),       // URL 模型:删本地 base64
    )
    const removed = before.length - kept.length
    if (removed > 0) set({ referenceImages: kept })
    return removed
  },
  clearResults: () => {
    // blob: 结果延迟 revoke 释放堆外 Blob(http/cos URL no-op)。
    for (const u of get().resultUrls) revokeLater(u)
    set({ resultUrls: [], resultMeta: [], error: null })
  },

  enterSplitMode: (imageUrl) =>
    set((s) => ({
      // 已在状态里换图时保留档位:用户刚把它调到 1K,换张图不该把这个选择洗回 auto。
      splitDraft: { imageUrl, resolution: s.splitDraft?.resolution ?? SPLIT_DEFAULT_RESOLUTION },
    })),

  updateSplitDraft: (patch) =>
    set((s) => (s.splitDraft ? { splitDraft: { ...s.splitDraft, ...patch } } : {})),

  exitSplitMode: () => set({ splitDraft: null }),

  runSplit: async (api) => {
    const { splitDraft: draft, prompt } = get()
    if (!draft) return { added: 0 }
    // **状态跑完不掉**:拆同一张图常常要试几种说法(「只要人」「去掉背景」「拆出文字」),
    // 每次都得重新选图就没法比。退出由用户点工具栏那个按钮显式完成。
    return get().generate(api, LAYER_SPLIT_MODEL, {
      // prompt 就是出图框里那句 —— 上游用它指定「要拆出什么」;空串才是自动全拆。
      // 不套出图模板(见 generate 里的 layerDecomposition 分支)。
      prompt,
      referenceImages: [draft.imageUrl],
      layerDecomposition: true,
      resolution: draft.resolution,
    })
  },

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

  generate: async (api, modelKey, overrides) => {
    // Snapshot form values at submit time so the user can keep typing the
    // next prompt while this one is in flight (matches BatchPage live-queue
    // semantics — no blocking guard, results stream back).
    const form = get()
    const { ratio, quality, count } = form
    const resolution = overrides?.resolution ?? form.resolution
    const prompt = overrides?.prompt ?? form.prompt
    const referenceImages = overrides?.referenceImages ?? form.referenceImages
    const layerDecomposition = overrides?.layerDecomposition ?? false
    const templateKey = useTemplateStore.getState().getSelection('generate')
    // 拆分模式下 prompt 的语义是「要拆出什么」,空串=自动全拆。套上出图模板会把
    // 「自动全拆」变成一句风格描述,直接改掉这次请求的含义 —— 所以不套。
    const finalPrompt = layerDecomposition ? prompt : composePromptWithTemplate(templateKey, prompt)
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
        count,
        model: modelKey,
        referenceImages: refsSnapshot,
        ...(layerDecomposition ? { layerDecomposition: true } : {}),
      })
      const rawUrls = result.urls ?? result.images ?? []

      // generateImage 从不抛异常:网络断连、上游 4xx/5xx、重试耗尽、超时,
      // 全都折成 { success: false, error }。不在这里拦下来,失败就会静静地
      // 变成"追加了零张图" —— 界面上什么都不会说。
      if (!result.success || rawUrls.length === 0) {
        const message = result.error
          ?? (result.success ? '上游返回成功但没有图片' : '生成失败')
        set((s) => {
          const nextCount = Math.max(0, s.inFlightCount - 1)
          return { error: message, inFlightCount: nextCount, generating: nextCount > 0 }
        })
        return { added: 0, error: message }
      }

      // P0 闪退修复(2026-07-09): 模型直出的 data: base64(nano2 4K 一张
      // ≈ 10-40MB 字符串)在进 store 前就地物化成 blob: URL, 底层字节进
      // 堆外 Blob 存储。http(s) URL 原样透传, 零开销。
      const materialized = await materializeImageUrls(rawUrls)
      const urls = materialized.map((m) => m.displayUrl)

      // 图层拆分:ApiService 已把 layers 按 zIndex 升序排好，且用它覆盖过 images
      // 的顺序，所以 layers[i] 恒对应 urls[i]。长度不等就整批不认(宁可退化成普通
      // 平铺，也不要把图层名错配到别的图上)。
      const layers =
        result.layers && result.layers.length === urls.length ? result.layers : undefined
      const layerGroupId = layers ? nextId() : undefined

      // 为每张图分配 id + meta, 同步推入 resultUrls / resultMeta 两个数组。
      // snapshot 同一批 N 张图共享 — 浅引用即可, restoreForEdit 在写入时
      // 会拷一份, 这里不防御性深拷。
      const newMetas: ResultUploadMeta[] = urls.map((u: string, i: number) => ({
        id: nextId(),
        modelUrl: u,
        uploadStatus: 'uploading' as const,
        snapshot: editSnapshot,
        ...(layers && layerGroupId
          ? {
              layerGroupId,
              layer: {
                zIndex: layers[i].zIndex,
                ...(layers[i].name ? { name: layers[i].name } : {}),
                ...(layers[i].description ? { description: layers[i].description } : {}),
                ...(layers[i].boundingBox ? { boundingBox: layers[i].boundingBox } : {}),
              },
            }
          : {}),
      }))

      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        // 软上限 FIFO: append 完后若超 MAX_RESULT_HISTORY 就从头部 slice 掉,
        // 保证两个数组依然同长同索引 — 后续 upload 回调还要靠 id 找索引,
        // 所以"超出上限的旧 meta 直接丢"是可接受的语义损失。
        const combinedUrls = [...s.resultUrls, ...urls]
        const combinedMeta = [...s.resultMeta, ...newMetas]
        const overflow = Math.max(0, combinedUrls.length - MAX_RESULT_HISTORY)
        // FIFO 丢弃的旧结果若还持有 blob: URL, 延迟 revoke 释放底层 Blob。
        for (let i = 0; i < overflow; i++) revokeLater(combinedUrls[i])
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
      newMetas.forEach((meta, i) => {
        pendingHistoryContext.set(meta.id, {
          modelUrl: meta.modelUrl,
          prompt,
          ratio,
          modelKey,
          refsSnapshot,
        })
        // 物化出 Blob 的(base64 模型)走字节版 IPC(ArrayBuffer 结构化克隆,
        // 不让 base64 字符串跨进程); http URL 走 from-url 让主进程自己 fetch。
        const uploadMeta = { source: 'generate', prompt: finalPrompt, model: modelKey }
        const image = materialized[i]
        if (image?.blob) enqueueCosUploadBlob(meta.id, image.blob, uploadMeta)
        else enqueueCosUpload(meta.id, meta.modelUrl, uploadMeta)
      })

      return { added: urls.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        return { error: message, inFlightCount: nextCount, generating: nextCount > 0 }
      })
      return { added: 0, error: message }
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

  // 上传成功即将热切到 cosUrl —— 旧的 blob: URL 延迟 revoke 释放堆外
  // Blob(http URL 输入时 no-op)。要在 setState 前用旧值捕获。
  if (result.success) {
    const st = useGenerateStore.getState()
    const idx = st.resultMeta.findIndex((m) => m.id === id)
    if (idx >= 0) revokeLater(st.resultUrls[idx])
  }

  // 先做状态热切 —— 不依赖 history ctx。即使 ctx 已被清理(并发追加 /
  // clearResults / FIFO 溢出丢弃), 也必须保证内存能释放, 否则 P0 黑屏复发。
  useGenerateStore.setState((s) => {
    const idx = s.resultMeta.findIndex((m) => m.id === id)
    if (idx < 0) return s
    const nextMeta = s.resultMeta.slice()
    if (result.success) {
      nextMeta[idx] = {
        ...nextMeta[idx],
        cosUrl: result.url,
        localPath: result.localPath,
        uploadStatus: 'uploaded',
        uploadError: undefined,
      }
      // P0 OOM 修复(2026-06-23): 把 resultUrls 同位置热切到轻量 cosUrl。
      // 2026-07-09 起这里换下来的是 blob: URL(base64 已在生成时物化),
      // 配合上面的 revokeLater 把底层 Blob 一并归还。
      const nextUrls = s.resultUrls.slice()
      nextUrls[idx] = result.url
      return { resultMeta: nextMeta, resultUrls: nextUrls }
    }
    // 失败: 保留 modelUrl(blob:/http)兜底, cosUrl 不存在时它是唯一可显示的源。
    // localPath 照记 —— history 兜底与后续"打开本地文件"入口都用得上。
    nextMeta[idx] = {
      ...nextMeta[idx],
      localPath: result.localPath,
      uploadStatus: 'failed',
      uploadError: result.error,
    }
    return { resultMeta: nextMeta }
  })

  const ctx = pendingHistoryContext.get(id)
  if (!ctx) return
  pendingHistoryContext.delete(id)

  const historyService = (window as unknown as {
    historyDataServiceTS?: HistoryServiceBridge
  }).historyDataServiceTS
  if (historyService?.addToHistory) {
    // P0 闪退修复(2026-07-09): 失败兜底按持久性排序 ——
    //   ① 本地磁盘副本(local-file://, 主进程上传前已落盘, 永不过期)
    //   ② http 模型直出 URL(临时签名, 几小时过期)
    // blob:/data: 跨重启即失效, 绝不写入 history。
    const localUri = result.localPath ? toRenderableUri(result.localPath) : null
    const persistUrl = result.success
      ? result.url
      : localUri ?? (isPersistableUrl(ctx.modelUrl) ? ctx.modelUrl : null)
    if (!persistUrl) {
      console.warn('[Generate] COS 上传失败且无本地副本/可持久化直出源, 跳过 history 写入:', id)
      return
    }
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
