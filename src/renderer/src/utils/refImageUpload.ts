/**
 * refImageUpload - 参考图上传的"原图直传 COS、失败降级压缩"共用逻辑。
 *
 * 各上传入口(BatchRefDrop / DirectorPage / 后续编辑器等)只负责自己的 UI、
 * 状态与 toast,真正的上传策略在这里统一:
 *   1) 读原图 dataURL(不压缩)+ 取宽高;
 *   2) 原图直传 COS,拿到持久 URL → 用 URL 当参考图(零质量损失、省渲染进程内存);
 *   3) COS 不可用(浏览器预览)/ 上传失败 → 降级本地压缩成 base64(可关),保证仍能生成。
 *
 * 设计:不抛异常、不弹 toast、不碰 React 状态 —— 全部用 outcome 对象返回,
 * 进度通过 onStage 回调暴露给调用方驱动各自的占位 UI。
 */

import { compressImage } from './image-compress'
import { uploadImageUrlToCos } from './cosImageUpload'

export type RefUploadStage = 'reading' | 'uploading' | 'compressing'

export interface RefImageReadResult {
  dataUrl: string
  w?: number
  h?: number
}

/** 读 Blob/File 为 dataURL(原图, 不压缩)并附带宽高;宽高拿不到时只返回 dataUrl。 */
export function readImageFileWithDims(file: Blob): Promise<RefImageReadResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.onload = () => {
      const dataUrl = reader.result
      if (typeof dataUrl !== 'string') {
        reject(new Error('FileReader returned non-string'))
        return
      }
      const img = new Image()
      img.onload = () => resolve({ dataUrl, w: img.width, h: img.height })
      img.onerror = () => resolve({ dataUrl })
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}

export interface RefUploadOptions {
  /** 透传给 COS 主进程的元数据(source / fileName 等),便于排查。 */
  metadata?: Record<string, unknown>
  /** COS 失败时是否降级本地压缩(默认 true);false 则降级直接用原图 dataURL。 */
  compressOnFallback?: boolean
  /** 进度回调:'reading' → 'uploading' →(降级时)'compressing'。 */
  onStage?: (stage: RefUploadStage) => void
}

/** COS 成功:用持久 URL 当参考图。 */
interface RefUploadCosOk {
  ok: true
  viaCos: true
  src: string
  fileSize: number
  width?: number
  height?: number
}

/** COS 降级:用本地 base64(可能压缩过)当参考图。 */
interface RefUploadLocalOk {
  ok: true
  viaCos: false
  src: string
  /** 是否在降级路径里真的压小了 */
  compressed: boolean
  originalSize: number
  fileSize: number
  width?: number
  height?: number
  /** COS 失败原因,供调用方按需 console.warn */
  cosError?: string
}

interface RefUploadErr {
  ok: false
  error: string
}

export type RefUploadOutcome = RefUploadCosOk | RefUploadLocalOk | RefUploadErr

/**
 * 把一个本地图片文件按"原图直传 COS、失败降级压缩"策略处理成可用的参考图源。
 *
 * 用法:
 * ```ts
 * const outcome = await uploadRefImageOriginalFirst(file, {
 *   metadata: { source: 'xxx-ref-upload', fileName: file.name },
 *   onStage: (s) => updatePending(id, { stage: s }),
 * })
 * if (outcome.ok) useSrc(outcome.src) // COS URL 或 base64
 * ```
 */
export async function uploadRefImageOriginalFirst(
  file: File,
  options: RefUploadOptions = {},
): Promise<RefUploadOutcome> {
  const { metadata, onStage } = options
  const compressOnFallback = options.compressOnFallback !== false

  // 1) 读原图(不压缩)
  onStage?.('reading')
  let original: RefImageReadResult
  try {
    original = await readImageFileWithDims(file)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'read failed' }
  }

  // 2) 原图直传 COS
  onStage?.('uploading')
  const up = await uploadImageUrlToCos(original.dataUrl, { metadata })
  if (up.ok) {
    return {
      ok: true,
      viaCos: true,
      src: up.url,
      fileSize: file.size,
      width: original.w,
      height: original.h,
    }
  }

  // 3a) 降级:直接用原图 dataURL(调用方明确不想压缩)
  if (!compressOnFallback) {
    return {
      ok: true,
      viaCos: false,
      src: original.dataUrl,
      compressed: false,
      originalSize: file.size,
      fileSize: file.size,
      width: original.w,
      height: original.h,
      cosError: up.error,
    }
  }

  // 3b) 降级:本地压缩成 base64
  onStage?.('compressing')
  let processed: File = file
  let compressed = false
  try {
    processed = await compressImage(file)
    compressed = processed.size < file.size
  } catch {
    // 压缩失败就用原 File,继续读
  }
  let fb: RefImageReadResult
  try {
    fb = await readImageFileWithDims(processed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'read failed' }
  }
  return {
    ok: true,
    viaCos: false,
    src: fb.dataUrl,
    compressed,
    originalSize: file.size,
    fileSize: processed.size,
    width: fb.w ?? original.w,
    height: fb.h ?? original.h,
    cosError: up.error,
  }
}
