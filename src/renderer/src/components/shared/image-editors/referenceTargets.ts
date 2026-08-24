import { useBatchStore } from '../../../stores/useBatchStore'
import { useGenerateStore } from '../../../stores/useGenerateStore'

/**
 * referenceTargets —— 「把一张结果图加入参考图」的公用函数。
 *
 * 背景:三个页面各自维护参考图状态(签名各异),此前没有任何代码把生成结果
 * 回灌到参考图(全景生成完图片也进不去参考图)。这里抽出统一入口:
 *   - generate 页:useGenerateStore.referenceImages: string[](存 dataURL)
 *   - batch / punk 页:useBatchStore.refImages: BatchRefImage[](16 上限)
 * 调用方只需给目标 + 图片 URL(http/cos 或 dataURL),其余(取数据、转 dataURL、
 * 去重、上限)由本函数处理。
 */

export type ReferenceTarget = 'generate' | 'batch'

function nextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** http/cos URL → dataURL;已是 dataURL 直接返回;取数据失败回落原始 URL。 */
async function toDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result as string)
      fr.onerror = reject
      fr.readAsDataURL(blob)
    })
  } catch {
    // 跨域/离线等取数据失败:回落原始 URL(两个 store 都接受字符串)。
    return url
  }
}

/**
 * 把「界面上正在显示的这张图的地址」变成**上游真能取到**的形式。
 *
 * 三种来源要区别对待，混为一谈会踩两个反方向的坑：
 *  - `http(s):` —— 原样透传。上游自己去 fetch，别在这儿转 base64:一张 2K 图内联
 *    进请求体是几 MB，而 seedream 那条链路明确要求 URL 直传（见
 *    ApiService.seedream50Pro 的「不把 COS/URL 参考图内联成 base64」用例）。
 *  - `data:` —— 已经是自包含的，原样透传。
 *  - `blob:` 及其它本地形态 —— **必须转**。blob: 只在本渲染进程内有效，发出去上游
 *    取不到；更糟的是 ApiService.normalizeImageSource 会把它当成一段裸 base64，
 *    拼成 `data:image/jpeg;base64,blob:http://…` 这种垃圾，请求照发不误、错误也
 *    不会指向真正的原因。base64 直出模型（nano2 4K 等）的结果图全都是 blob:。
 *
 * 取数据失败时回落原始 URL —— 让上游去报一个真实的错，比我们这里静默造一个假的好。
 */
export async function toUpstreamFetchableImage(url: string): Promise<string> {
  if (!url) return url
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  return toDataUrl(url)
}

const BATCH_REF_CAP = 16

/**
 * 把图片加入指定页面的参考图。返回是否成功(达到上限 / 无 URL 返回 false)。
 * 设计成 store getState() 形式 —— 可在组件、事件回调、工具函数中任意复用。
 */
export async function addImageUrlToReferences(
  target: ReferenceTarget,
  url: string,
  meta?: { fileName?: string },
): Promise<boolean> {
  if (!url) return false

  if (target === 'batch') {
    const st = useBatchStore.getState()
    if (st.refImages.length >= BATCH_REF_CAP) return false
    // 已存在同 URL 不重复加(避免重复点击)。
    if (st.refImages.some((r) => r.base64 === url)) return true
    const dataUrl = await toDataUrl(url)
    const after = useBatchStore.getState()
    if (after.refImages.length >= BATCH_REF_CAP) return false
    if (after.refImages.some((r) => r.base64 === dataUrl || r.base64 === url)) return true
    after.addRefImage({
      id: nextId(),
      base64: dataUrl,
      fileName: meta?.fileName ?? `ref-${Date.now()}.png`,
      fileSize: 0,
    })
    return true
  }

  // generate
  const dataUrl = await toDataUrl(url)
  const st = useGenerateStore.getState()
  if (st.referenceImages.includes(dataUrl)) return true
  st.addReferenceImage(dataUrl)
  return true
}
