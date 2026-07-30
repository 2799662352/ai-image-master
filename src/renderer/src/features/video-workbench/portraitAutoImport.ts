// 「默认上传人像库」—— 工作台本地上传素材顺带导入人像库(素材库)。
//
// 开关(store.autoImportPortrait,localStorage 持久化)开启时,卡片上本地
// 上传的文件在加入卡片素材区的同时,后台调 seedance.importAsset 导入人像库;
// 导入失败只弹 toast 提示,绝不阻断卡片素材流程。图片按 image_people 分类
// (与人像库页上传口径一致)。

import { useToastStore } from '../../stores/useToastStore'

interface SeedanceImportApi {
  importAsset?: (input: {
    kind: 'image' | 'video' | 'audio'
    url: string
    name?: string
    mimeType?: string
    imageCategory?: 'image_people' | 'image_environment'
  }) => Promise<unknown>
}

function seedanceApi(): SeedanceImportApi | undefined {
  return (window as Window & { electronAPI?: { seedance?: SeedanceImportApi } }).electronAPI?.seedance
}

export function fileImportKind(file: File): 'image' | 'video' | 'audio' | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

/**
 * 系统拖拽 / 文件选择器给的 File 带真实磁盘路径,直接传路径:主进程分片流式
 * 上传,整个文件不进任何 Buffer。拿不到路径(剪贴板粘贴、网页拖拽的合成 File)
 * 才退回 data URL —— 那种本来就已经在内存里。
 *
 * 与人像库页上传(portraitUpload.ts)口径保持一致:同一份文件不该因为从哪个
 * 入口进来而走不同的通道。
 */
function getFilePathSafe(file: File): string {
  try {
    const api = (window as unknown as { electronAPI?: { getFilePath?: (f: File) => string } })
      .electronAPI
    return api?.getFilePath?.(file) ?? ''
  } catch {
    return ''
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 把本地上传文件后台导入人像库。逐文件独立失败(toast 提示),互不影响,
 * 也不影响调用方(卡片素材区)的流程;preload 桥缺失时静默跳过。
 *
 * 不做体积预判 —— 导入本身已经是「失败也无所谓」的副作用,与其我们按一个猜的
 * 数字提前劝退,不如让上游给出确切上限,那句错误照旧只出 toast。
 * @returns 成功导入数(便于测试断言)
 */
export async function autoImportFilesToPortraitLibrary(files: File[]): Promise<number> {
  const api = seedanceApi()
  if (!api?.importAsset) return 0
  const addToast = useToastStore.getState().addToast
  let imported = 0
  for (const file of files) {
    const kind = fileImportKind(file)
    if (!kind) continue
    try {
      const source = getFilePathSafe(file) || (await readAsDataUrl(file))
      await api.importAsset({
        kind,
        ...(kind === 'image' ? { imageCategory: 'image_people' as const } : {}),
        url: source,
        name: file.name,
        mimeType: file.type,
      })
      imported += 1
    } catch (e) {
      addToast({
        message: `「${file.name}」导入人像库失败:${e instanceof Error ? e.message : String(e)}(卡片素材不受影响)`,
        type: 'error',
      })
    }
  }
  return imported
}
