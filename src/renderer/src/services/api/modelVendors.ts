/**
 * 模型厂商元数据 —— 驱动模型选择器的「按厂商聚合」分组。
 *
 * 为什么单独一个文件:选择器(React)和模型表(ApiService)都要认这张表,而 ApiService
 * 是个 4000+ 行的大文件,把纯数据 + 纯函数抽出来才能给选择器写轻量测试。
 *
 * 厂商名照 apiyi 生图页(imagen.apiyi.com)的写法用英文品牌名(Google / OpenAI /
 * Seedream / Flux),国产两家用中文(腾讯 / 阿里)—— 用户认的是这几个字,不走 i18n。
 * `order` 跟随 `MODEL_DISPLAY_ORDER` 的精神:Seedream 最上,其次腾讯、Google、阿里、
 * OpenAI、Flux;没标厂商的模型落到「其他」组最后。
 */

export type ModelVendor = 'bytedance' | 'tencent' | 'google' | 'alibaba' | 'openai' | 'bfl'

export interface ModelVendorMeta {
  name: string
  order: number
}

const OTHER_VENDOR_KEY = 'other'

export const MODEL_VENDORS: Record<ModelVendor | typeof OTHER_VENDOR_KEY, ModelVendorMeta> = {
  bytedance: { name: 'Seedream', order: 1 },
  tencent: { name: '腾讯', order: 2 },
  google: { name: 'Google', order: 3 },
  alibaba: { name: '阿里', order: 4 },
  openai: { name: 'OpenAI', order: 5 },
  bfl: { name: 'Flux', order: 6 },
  other: { name: '其他', order: 99 },
}

export interface VendorGroup<T> {
  vendorKey: ModelVendor | typeof OTHER_VENDOR_KEY
  meta: ModelVendorMeta
  models: Array<{ key: string; model: T }>
}

/**
 * 把模型表按厂商分组。组序按 `MODEL_VENDORS[*].order`,组内保持传入对象的键序
 * (即 `getAllModels()` 已经排好的展示顺序);空组不返回;`vendor` 缺失或不认识
 * 的模型落到「其他」。
 */
/**
 * 约束放宽到 `object`:消费端既有严格的 ModelConfig(带 vendor 字段),也有 useModelStore
 * 的 ModelInfo(只有索引签名、没有显式 vendor)。写成 `{ vendor?: unknown }` 会让后者撞上
 * TS 的弱类型检测(「没有共同属性」)——vendor 在这里按 unknown 读取再判断,不依赖类型声明。
 */
export function groupModelsByVendor<T extends object>(
  models: Record<string, T>,
): VendorGroup<T>[] {
  const groups = new Map<ModelVendor | typeof OTHER_VENDOR_KEY, Array<{ key: string; model: T }>>()
  for (const [key, model] of Object.entries(models)) {
    const raw = (model as { vendor?: unknown }).vendor
    const vendorKey: ModelVendor | typeof OTHER_VENDOR_KEY =
      typeof raw === 'string' && raw in MODEL_VENDORS && raw !== OTHER_VENDOR_KEY
        ? (raw as ModelVendor)
        : OTHER_VENDOR_KEY
    const bucket = groups.get(vendorKey)
    if (bucket) bucket.push({ key, model })
    else groups.set(vendorKey, [{ key, model }])
  }
  return [...groups.entries()]
    .map(([vendorKey, list]) => ({ vendorKey, meta: MODEL_VENDORS[vendorKey], models: list }))
    .sort((a, b) => a.meta.order - b.meta.order)
}
