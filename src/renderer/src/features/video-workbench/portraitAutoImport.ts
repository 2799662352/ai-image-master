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
      const dataUrl = await readAsDataUrl(file)
      await api.importAsset({
        kind,
        ...(kind === 'image' ? { imageCategory: 'image_people' as const } : {}),
        url: dataUrl,
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
