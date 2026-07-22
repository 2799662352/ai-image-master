// 人像库共享上传逻辑 —— 人像库页(PortraitLibraryPage)与视频工作台的
// 「从人像库选择」弹窗(PortraitPickerModal)共用一份实现:
//  - 文件校验(图片 ≤30MB;视频 ≤50MB 且 4-15s;音频 4-15s,上游硬限);
//  - 按当前选中的类型 tab 决定 imageCategory(人像 image_people / 环境
//    image_environment;上游 SeedanceAssetImportInput 只支持这两个图片分类,
//    视频/音频没有 imageCategory,靠 kind 本身区分);文件实际类型与 tab
//    不一致时按实际类型入库并 toast 说明;
//  - data URL 读取 → seedance.importAsset 逐文件导入,独立失败互不影响;
//  - 可选 group:导入成功后对新 assetId 直接调 overlay mutate(moveToGroup)
//    归组 —— 主进程会广播 onOverlayChanged,页面 hook 自动同步,无需回传。
// toast(逐文件失败 / 类型不符说明 / 汇总)统一由本模块发,调用方只管
// 占位 UI、刷新列表与选中态。

import { useToastStore } from '../../stores/useToastStore'
import type {
  PortraitOverlayMutation,
  PortraitOverlayState,
  SeedanceAssetImportInput,
  SeedanceAssetImportResult,
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
} from '../../../../types/seedance'

export type PortraitUploadKind = 'image' | 'video' | 'audio'

/** 上游素材库硬限:图片单张 ≤30MB;视频 ≤50MB 且 4-15s;音频 4-15s。 */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MEDIA_MIN_SECONDS = 4
const MEDIA_MAX_SECONDS = 15

/** 类型 tab → 中文标签(mismatch 提示用)。 */
const TAB_LABELS: Partial<Record<SeedanceAssetKindFilter, string>> = {
  image_people: '人像',
  image_environment: '环境',
  video: '视频',
  audio: '音频',
}

const KIND_LABELS: Record<PortraitUploadKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
}

interface SeedanceUploadApi {
  importAsset?: (input: SeedanceAssetImportInput) => Promise<SeedanceAssetImportResult>
  mutateOverlay?: (mutation: PortraitOverlayMutation) => Promise<PortraitOverlayState>
}

function seedanceApi(): SeedanceUploadApi | undefined {
  return (window as Window & { electronAPI?: { seedance?: SeedanceUploadApi } }).electronAPI?.seedance
}

/** 按 MIME 前缀识别可入库类型;不支持的类型返回 null。 */
export function fileUploadKind(file: File): PortraitUploadKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

export interface UploadPlan {
  kind: PortraitUploadKind
  /** 仅图片有分类;上游只支持 image_people / image_environment 两个值。 */
  imageCategory?: 'image_people' | 'image_environment'
  /** 文件实际类型与当前类型 tab 不一致(按实际类型入库,并 toast 说明)。 */
  mismatch: boolean
}

/**
 * 按当前类型 tab 决定导入参数:
 *  - 环境 tab 上传图片 → image_environment;其余 tab 图片默认 image_people;
 *  - 视频/音频没有 imageCategory;
 *  - tab 与文件实际类型不符(如音频 tab 传图片)→ mismatch=true,按实际类型入库。
 */
export function planUpload(file: File, kindTab: SeedanceAssetKindFilter = 'all'): UploadPlan | null {
  const kind = fileUploadKind(file)
  if (!kind) return null
  if (kind === 'image') {
    return {
      kind,
      imageCategory: kindTab === 'image_environment' ? 'image_environment' : 'image_people',
      mismatch: kindTab === 'video' || kindTab === 'audio',
    }
  }
  const tabExpectsKind = kindTab === 'all' || kindTab === 'text' || kindTab === kind
  return { kind, mismatch: !tabExpectsKind }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 读取视频/音频时长(秒),读取失败返回 null(不阻断上传,交给上游校验)。 */
function probeMediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(el.duration) ? el.duration : null)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    el.src = url
  })
}

/** 按上游限制校验文件;返回 null 表示通过,否则返回错误文案。 */
async function validateUploadFile(file: File, kind: PortraitUploadKind): Promise<string | null> {
  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) return `${file.name} 超过图片 30MB 上限`
    return null
  }
  if (kind === 'video' && file.size > MAX_VIDEO_BYTES) return `${file.name} 超过视频 50MB 上限`
  const duration = await probeMediaDuration(file)
  if (duration != null && (duration < MEDIA_MIN_SECONDS || duration > MEDIA_MAX_SECONDS)) {
    return `${file.name} 时长 ${duration.toFixed(1)}s 不在 4-15s 范围内`
  }
  return null
}

export interface PortraitUploadOptions {
  /** 当前选中的类型 tab,决定图片的 imageCategory 与 mismatch 提示;缺省 'all'。 */
  kindTab?: SeedanceAssetKindFilter
  /** 目标分组(真实分组名);导入成功后对新 assetId 统一 moveToGroup 归组。 */
  group?: string
}

export interface PortraitUploadCallbacks {
  /** 单个文件导入成功(含内容去重命中)。index 对应传入 files 的下标。 */
  onFileDone?: (index: number, result: SeedanceAssetImportResult) => void
  /** 单个文件校验不过或导入失败(调用方应移除对应占位)。 */
  onFileFailed?: (index: number) => void
}

export interface PortraitUploadResult {
  imported: number
  duplicated: number
  failed: number
  /** 本次成功入库的素材(含去重命中的既有素材)。 */
  assets: SeedanceAssetItem[]
}

/**
 * 批量上传本地文件到人像库。逐文件独立失败(toast 提示),互不影响;
 * 全部处理完后发汇总 toast;指定 group 时把成功入库的素材统一归组。
 */
export async function uploadFilesToPortraitLibrary(
  files: File[],
  opts: PortraitUploadOptions = {},
  callbacks: PortraitUploadCallbacks = {},
): Promise<PortraitUploadResult> {
  const addToast = useToastStore.getState().addToast
  const result: PortraitUploadResult = { imported: 0, duplicated: 0, failed: 0, assets: [] }
  if (files.length === 0) return result
  const api = seedanceApi()
  if (!api?.importAsset) {
    addToast({ message: '人像库接口不可用(preload 未加载)', type: 'error' })
    result.failed = files.length
    files.forEach((_, i) => callbacks.onFileFailed?.(i))
    return result
  }
  const kindTab = opts.kindTab ?? 'all'

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const plan = planUpload(file, kindTab)
    if (!plan) {
      addToast({ message: `跳过不支持的文件: ${file.name}(仅支持图片/视频/音频)`, type: 'error' })
      result.failed += 1
      callbacks.onFileFailed?.(i)
      continue
    }
    const problem = await validateUploadFile(file, plan.kind)
    if (problem) {
      addToast({ message: problem, type: 'error' })
      result.failed += 1
      callbacks.onFileFailed?.(i)
      continue
    }
    if (plan.mismatch) {
      const tabLabel = TAB_LABELS[kindTab] ?? kindTab
      addToast({
        message: `「${file.name}」与当前「${tabLabel}」分类不符,已按实际类型(${KIND_LABELS[plan.kind]})入库`,
        type: 'warning',
      })
    }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const res = await api.importAsset({
        kind: plan.kind,
        ...(plan.imageCategory ? { imageCategory: plan.imageCategory } : {}),
        url: dataUrl,
        name: file.name,
        mimeType: file.type,
      })
      if (res.duplicated) result.duplicated += 1
      else result.imported += 1
      if (res.asset) result.assets.push(res.asset)
      callbacks.onFileDone?.(i, res)
    } catch (e) {
      result.failed += 1
      addToast({ message: `${file.name} 上传失败: ${e instanceof Error ? e.message : String(e)}`, type: 'error' })
      callbacks.onFileFailed?.(i)
    }
  }

  // 归组:对本次成功入库(含去重命中)的素材统一 moveToGroup。
  const group = opts.group?.trim()
  const assetIds = result.assets.map((a) => a.assetId).filter(Boolean)
  let grouped = false
  if (group && assetIds.length > 0 && api.mutateOverlay) {
    try {
      await api.mutateOverlay({ op: 'moveToGroup', assetIds, group })
      grouped = true
    } catch (e) {
      addToast({
        message: `素材已入库,但归入分组「${group}」失败: ${e instanceof Error ? e.message : String(e)}`,
        type: 'warning',
      })
    }
  }

  const parts = [
    result.imported > 0 ? `新增 ${result.imported} 个` : '',
    result.duplicated > 0 ? `${result.duplicated} 个已存在(按内容去重)` : '',
    result.failed > 0 ? `${result.failed} 个失败` : '',
  ].filter(Boolean)
  if (parts.length > 0) {
    addToast({
      message: `人像库上传完成:${parts.join(',')}${grouped ? `,已归入分组「${group}」` : ''}`,
      type: result.failed > 0 && result.imported + result.duplicated === 0 ? 'error' : 'success',
    })
  }
  return result
}
