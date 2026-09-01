// src/renderer/src/services/api/ApiService.ts
/**
 * API 调用模块
 * 处理与 AI 图片生成 API 的所有通信
 */

import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../../types/authApi'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { getAgentApi } from '../../utils/agentBridge'
import { normalizeModelKey } from '../../utils/modelKeyAliases'
import { wantsInlineBase64ForModel } from '../../utils/refImageStrategy'
import { ensureLayerSplitInputFormat } from '../../utils/layerSplitInput'

export interface ApiSite {
  name: string
  baseURL: string
  /**
   * 源站地址(不过 CDN)。只给「加速域名扛不住的请求」用,其余照旧走 baseURL。
   *
   * 缘由(2026-07-28 实测):Miau 的加速域名前面是 EdgeOne,而它**不支持**谷歌原生
   * 端点 `/v1beta/models/...:generateContent` —— 该路径的请求一律以 524 收场。
   * 524 错误页不带 CORS 头,浏览器于是报「No 'Access-Control-Allow-Origin'」,
   * 把真实原因盖住了。见 buildRequestUrl。
   */
  directBaseURL?: string
  description: string
  authType: 'bearer' | 'x-api-key'
  pathPrefix?: string
  defaultApiKey?: string
  isBuiltIn?: boolean
}

export interface ResolutionOption {
  key: string
  label: string
  description?: string
}

/**
 * 入参联合类型 for {@link ApiService.understand}。
 * - video / document: 媒体走 OpenAI 多模态 content part(网关转 DashScope)。
 * - web: 纯文本 + enable_search(联网扒资料)。
 * 注:qwen 上游只认公网 URL,本机文件须先转可达 URL(由调用方处理)。
 */
export type UnderstandInput =
  | { kind: 'video'; mediaUrl: string; question: string; fps?: number }
  /**
   * 图片 / 文档。`mediaUrl` 是单张;要一次看多张(商品对比、多页文档、
   * 分镜连续性)就再给 `mediaUrls` —— 上游把同一条 user message 里并列的多个
   * `image_url` 当成一组来看,这正是「跨图比较」能成立的原因;拆成多次调用
   * 模型就看不到彼此了。
   *
   * 两者可同时给,`mediaUrl` 排在最前(它常是「主图」),之后按 `mediaUrls` 顺序,
   * 去重但**不重排** —— 顺序即身份,提示词里说「第二张」就得是第二张。
   */
  | { kind: 'document'; mediaUrl: string; question: string; mediaUrls?: string[] }
  | { kind: 'web'; query: string }

/**
 * 单次请求的图片张数上限(公网 URL 形态)。来自千问「视觉理解模型」文档:
 * qwen3.8-max / 3.7-plus 均为 URL 2048 张、base64 250 张。我们这条链只传 URL
 * (上游不收本机路径,调用方已先中转成公网 URL),故按 2048 记。
 *
 * 这里只做**兜底截断**而不是报错:上游超限会整条请求失败,而看图是「多看几张少看
 * 几张」的事,砍掉尾部远好过一张都看不成。真到 2048 张的场景本身就该先聚合。
 */
export const QWEN_UNDERSTAND_MAX_IMAGES = 2048

/**
 * 去重但**保序**。顺序即身份 —— 提问里说「第二张」,就必须是数组里的第二张;
 * 用 Set 一转再展开虽然也保序,但这里显式写出来是为了钉住「不许排序」这条约束。
 * 空串/非字符串一并滤掉,免得组出 `image_url: { url: "" }` 让整条请求失败。
 */
/**
 * PDF 走**另一种 content part**。
 *
 * 上游对 PDF 有原生解析(`type: "file"`),而我们此前对所有「文档」一律发
 * `image_url` —— 一个指向 .pdf 的 image_url 上游是读不出内容的,这正是
 * understand_document 的说明里那句「原生文档只有部分支持,先渲成图效果最好」
 * 的由来:不是上游不行,是我们发错了形状。
 *
 * 注意 PDF 理解**只走 Chat Completions**(官方明写「暂不支持 Responses API」),
 * 也就是我们现在这条路,不需要另开通路。
 *
 * 排布上 file part 在图片之前、但整体仍在问题文本之后 —— 官方 PDF 示例是
 * file 在前、文本在后,而我们既有的图片形态是文本在前且一直可用。两种顺序
 * 上游都接受(content 是一组 part,不是有序指令),所以这里保持与图片一致,
 * 避免为 PDF 单开一种排布。
 * 上游限制:单文件 150MB / 单文档 500 页。
 */
function buildDocumentParts(urls: readonly string[]): Array<Record<string, unknown>> {
  const isPdf = (u: string) => /\.pdf(?:[?#]|$)/i.test(u)
  const pdfs = urls.filter(isPdf)
  const images = urls.filter((u) => !isPdf(u)).slice(0, QWEN_UNDERSTAND_MAX_IMAGES)
  return [
    ...pdfs.map((file_url) => ({ type: 'file', file: { file_url } })),
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

function dedupePreservingOrder(urls: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (typeof u !== 'string') continue
    const trimmed = u.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 理解能力上游模型(走 antigravity new-api 网关的 DashScope 原生通道)。
 *
 * 默认 `qwen3.7-plus-dashscope`(更便宜,日常足够);`qwen3.7-max-dashscope`
 * 作为「更强 + 兜底」备选。两者能力一致(文本/图像/视频/联网/工具,均不支持
 * 音频),差别是 plus 更便宜、max 更强更贵。
 *
 * 历史:plus 是「多模态专用」模型,其纯文本(如 web_research)必须被网关强制路由到
 * multimodal 端点(`aliMultimodalOnlyModels`),否则上游回 `url error`。该端点强制
 * 一度只在测试网关、prod 未上。2026-06-23 实测 prod(175.178.198.17)上 plus 的
 * web_research + understand_video 均已通过(见 docs 24/25),故 plus 现已稳定可作默认。
 *
 * 切换/兜底:`understand(input, { model })` 可显式指定('max' / 'plus' / 全名);
 * 非法值回落默认 plus。primary 失败(同模型重试耗尽后)且 primary≠max 时,自动用
 * max 兜底重试一次(见 understand)。
 */
export const QWEN_UNDERSTAND_MODEL = 'qwen3.7-plus-dashscope'

/** 更强 + 兜底模型:primary 失败时自动重试一次。也可经 `{ model }` 显式选用。 */
export const QWEN_UNDERSTAND_FALLBACK_MODEL = 'qwen3.7-max-dashscope'

/**
 * 旗舰理解模型 `qwen3.8-max`(2026-08-03 GA)。
 *
 * **不设为默认。** 它与 3.7-plus 的视频规格完全相同(2 小时 / 2GB / 单次 64 段
 * 视频 / 2048 张 URL 图),差别在推理强度、1M 上下文和内置工具 —— 而理解工具的
 * 绝大多数调用是「看一段片子讲了什么」,这些规格上 plus 已经吃满,换旗舰只是更贵。
 * 需要长文档深读或复杂跨模态推理时由调用方显式指定 `model="flagship"`。
 *
 * 注意模型 id **没有** `-dashscope` 后缀 —— 它走的是网关里 `QWEN_MIAU_MODELS`
 * 那条(与对话栏同一枚 Miau key),不是 3.7 那两个 DashScope 原生别名。
 * 规格来源:千问平台「视觉理解模型」文档。
 */
export const QWEN_UNDERSTAND_FLAGSHIP_MODEL = 'qwen3.8-max'

/**
 * 把 apiyi-mcp 的 `APIYI_API_KEY` 推给主进程时使用的 provider-store 槽位 id。
 * 不是 codex 网关 provider——是「只存 key」的通道,镜像 qwen('qwen')存 Miau token
 * 的做法。用专属 id(`apiyi-mcp`,不是真正的网关 `apiyi`)把 MCP 密钥与 codex
 * 自己的 API易 网关 key 解耦。主进程在 spawn 时经 `-c mcp_servers.apiyi.env.
 * APIYI_API_KEY` 注入,运行时生效、绝不落 `config.toml`(catimation 同款)。
 * 必须与 main 端 `APIYI_MCP_PROVIDER_ID`(codexProviders.ts)保持一致。
 */
export const APIYI_MCP_PROVIDER_ID = 'apiyi-mcp'

/**
 * provider-store 槽位 id + localStorage 键,用于把 设置 → 运镜知识库 里填的
 * 阿里云百炼 `DASHSCOPE_API_KEY` 推给主进程。做法完全对齐 apiyi-mcp:key 存本地
 * (`localStorage[dashscope_api_key]`)+ 镜像到 provider store,主进程在 codex
 * spawn 时经 `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` 注入,
 * 运行时生效、绝不落 `config.toml`。必须与 main 端 `CINEMATOGRAPHY_KB_PROVIDER_ID`
 * (codexProviders.ts)保持一致。
 */
export const CINEMATOGRAPHY_KB_MCP_PROVIDER_ID = 'cinematography-kb'
export const DASHSCOPE_API_KEY_STORAGE = 'dashscope_api_key'
/**
 * DashVector key (Sakuga-42M 数据集检索,query_sakuga_dataset 工具)。与主进程
 * `DASHVECTOR_PROVIDER_ID`(codexProviders.ts)保持一致。
 */
export const DASHVECTOR_MCP_PROVIDER_ID = 'dashvector'
export const DASHVECTOR_API_KEY_STORAGE = 'dashvector_api_key'

/** 允许显式选用的理解模型白名单(其余值回落到默认 plus)。 */
export const QWEN_UNDERSTAND_MODELS: readonly string[] = [
  QWEN_UNDERSTAND_MODEL,
  QWEN_UNDERSTAND_FALLBACK_MODEL,
  QWEN_UNDERSTAND_FLAGSHIP_MODEL,
]

/**
 * 把调用方请求的模型归一成白名单内的真实模型名。
 * - `'max'` / `'plus'` 简称 → 对应 -dashscope 全名(与默认无关,按字面映射);
 * - 已是白名单全名 → 原样;
 * - 其余(含幻觉名 / undefined)→ 默认 plus。
 */
export function resolveUnderstandModel(requested?: string): string {
  if (typeof requested !== 'string') return QWEN_UNDERSTAND_MODEL
  const r = requested.trim().toLowerCase()
  if (r === 'max') return 'qwen3.7-max-dashscope'
  if (r === 'plus') return 'qwen3.7-plus-dashscope'
  // 'flagship' 而不是 '3.8':别名要表达「选最强的那档」,写死版本号会在下次换代时
  // 变成需要同步改动的死值(plus/max 就是这么活过好几代的)。
  if (r === 'flagship' || r === '3.8') return QWEN_UNDERSTAND_FLAGSHIP_MODEL
  return QWEN_UNDERSTAND_MODELS.includes(requested) ? requested : QWEN_UNDERSTAND_MODEL
}

export interface QualityOption {
  key: string
  label: string
  description?: string
}

export interface ModelConfig {
  name: string
  displayName: string
  time?: string
  isNew?: boolean
  baseURL?: string
  apiType?: 'gemini-native' | 'openai' | 'flux-kontext' | 'image-generation'
  internalPrompt?: string
  ratios?: RatioOption[]
  capabilities?: ModelCapabilities
  editURL?: string
  sizeStrategy?: string
  defaultParams?: Record<string, unknown>
  responseFormats?: string[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
  resolutionMap?: Record<string, Record<string, string>>
  /** 清晰度档位（官转 gpt-image-2 与 gpt-image-2-vip 均支持 quality；与 resolution/比例 三轴独立） */
  qualities?: QualityOption[]
  defaultQuality?: string
  /**
   * 单张出图实际价格(USD)。优先级高于从 displayName 文本里抠取的旧值。
   * 不填时收据组件会回退到 displayName 中 `$X.XX/张` 的兜底解析。
   */
  price?: number
  /**
   * gemini-native 专用：把参考图强制以 base64 `inline_data` 内联，而不是默认的
   * `file_data.file_uri`(URL 直传)。开启后请求前会把 COS/远端 URL 参考图抓回
   * 成 data URL，与 apiyi 官方 `:generateContent` curl 的 `inline_data` 写法一致。
   * 大图会显著增大请求体，仅在确需 base64 内联的模型上开启(如大香蕉系列)。
   */
  inlineRefImageAsBase64?: boolean
  /**
   * 该模型**只经这一个网关**提供，请求必须钉在这个站点上。
   *
   * 为什么需要显式声明:`buildRequestUrl` 会用**当前选中站点**的 host 覆盖模型
   * 自带的 host —— 这是中转站设计的核心（同一个 `gpt-image-2` 在 apiyi / 云雾 /
   * 柏拉图都能跑，跟着用户选的站点走）。但少数渠道是某一家独有的（如经 Miau
   * 代理的火山 / 腾讯 / 阿里系），host 被覆盖后就打到一个根本没有这个模型的站点，
   * 表现为莫名的 404 / model not found，而用户完全看不出该去切站点。
   *
   * 声明了这个字段后，`generateImage` 在调用方没显式传 `siteKey` 时自动钉住它。
   * 缺失的 API Key 也会因此变成一句准确的「未配置 X 站点的 API Key」。
   */
  requiredSiteKey?: string
}

export interface RatioOption {
  key: string
  label: string
  description?: string
}

export interface ModelCapabilities {
  multipleImages: boolean
  customSize: boolean
  aspectRatioControl?: boolean
  referenceImage?: boolean
  imageEdit?: boolean
  intelligentResize?: boolean
  resolutionControl?: boolean
  /** 是否暴露独立的「清晰度 quality」下拉（官转 gpt-image-2 与 gpt-image-2-vip） */
  qualityControl?: boolean
  maxOutputs?: number
  useExtraBody?: boolean
  /** 出多张时需显式开启组图模式（如万相 wan2.7 的 enable_sequential），且一次返回的系列图前后一致 */
  sequentialGroup?: boolean
  /**
   * 参考图必须走 DashScope 原生 `input.messages`（`{image}` 在前、`{text}` 在后），
   * 而不是顶层 `image` 字段。
   *
   * 这条独立于 {@link sequentialGroup}：两者此前耦合在一起（构造 input.messages 的
   * 分支挂在组图能力上），于是千问这种「有参考图但没有组图」的模型掉进顶层 `image`
   * 分支 —— 而网关的字段映射表里根本没有 `image`，它会被静默丢弃，表现为「传了参考图
   * 但模型完全没看」（2026-08-08 实测）。
   */
  dashscopeNativeInput?: boolean
  /**
   * 参考图张数上限。缺省表示不额外限制（沿用各渠道自己的约束）。
   * 千问 3.0 的图生图官方规定 content 里只能有 1-3 个 `{image}`，超了上游直接拒。
   */
  maxReferenceImages?: number
  /**
   * 上游接受独立的反向提示词字段（DashScope 原生 `parameters.negative_prompt`）。
   * 打开后界面会渲染反向提示词输入框；不支持的渠道不该冒出这个框。
   */
  negativePrompt?: boolean
  /**
   * 支持图层拆分（Ark `layer_decomposition`）：把单张输入图拆成 1 张底图 +
   * 最多 16 张带透明通道的 PNG 图层，每层附 z_index / bounding_box / name / description。
   *
   * 开启后请求形态与普通生图**不同**（size 只收档位、只发单张 image、prompt 可缺席），
   * 详见 {@link ApiService.buildLayerDecompositionPayload}。只有确认过上游支持的渠道
   * 才能打开——普通渠道收到这个开关会当未知字段忽略，用户看到的是「拆分没生效但也没报错」。
   */
  layerDecomposition?: boolean
}

/**
 * 参考图 / 输入图的合法源形态,与 {@link ApiService.normalizeImageSource} 认得的
 * 分支一一对应:裸字符串（http(s) URL / data URL / 纯 base64），或带
 * `dataUrl` / `url` / `base64` 之一的对象（`mimeType` 只在裸 base64 时用于拼
 * data URL 前缀）。
 *
 * 注意**没有** `{ data }` 这一支：归一化不认这个键，传进来的图会被静默丢掉。
 */
export type ReferenceImageSource =
  | string
  | { dataUrl: string; mimeType?: string }
  | { url: string; mimeType?: string }
  | { base64: string; mimeType?: string }

export interface GenerateImageParams {
  prompt: string
  model?: string
  ratio?: string
  resolution?: string
  /** 清晰度档位（官转 gpt-image-2 专属，auto/low/medium/high）；其它模型忽略 */
  quality?: string
  referenceImages?: string[]
  imageBase64?: string  // 编辑模式的图片
  /**
   * 反向提示词。仅 DashScope 原生渠道（千问 / 万相）会把它放进 `parameters`。
   *
   * ⚠️ 经 Miau 网关时**当前到不了上游**：网关的 `AliImageParameters` 里没有
   * `negative_prompt` 这个键，反序列化即丢弃（接入说明 §3.2 / §9）。上游 API 本身
   * 是支持的，所以这里照发不误 —— 网关补上白名单那天就自动生效，不必再发版。
   * 在此之前 UI 不应向用户承诺它有效。
   */
  negativePrompt?: string
  /** 随机种子 [0, 2147483647]。固定种子可让结果相对稳定；在网关白名单内，真能生效。 */
  seed?: number
  count?: number
  signal?: AbortSignal
  /**
   * 按本次请求强制使用的站点 key（覆盖当前选中站点）。用于「只经某网关提供」的
   * 渠道（如腾讯 image2 / 万相 2.7 仅经 Miau API=`antigravity`）：codex 出图无需
   * 用户先手动切站点，调用方直接指定本字段即可。省略时沿用当前选中站点，向后兼容。
   * 该站点必须存在且已配置对应 API Key，否则 generateImage 直接返回清晰错误。
   */
  siteKey?: string
  /**
   * 图层拆分模式（仅 capabilities.layerDecomposition 的模型，如 Seedream 5.0 Pro）。
   *
   * 开启时必须带且仅带一张输入图（referenceImages[0] 或 imageBase64）；`prompt` 可为空
   * 串——空即「自动全拆」，非空则按提示词指定要拆出什么。ratio / count 在此模式下不生效
   * （张数由上游按图内容决定）；`resolution` 被当作**档位**用，见 LAYER_DECOMPOSITION_SIZE_TIERS。
   */
  layerDecomposition?: boolean
}

/**
 * 图层的包围盒。两种坐标系同时可能出现，按上游给什么带什么，不做换算。
 * 两者都是 `[left, top, right, bottom]`（不是 x/y/w/h）。
 */
export interface ImageLayerBoundingBox {
  /** 底图坐标系里的绝对像素位置 `[left, top, right, bottom]`。 */
  absolute?: number[]
  /**
   * 归一化位置 `[left, top, right, bottom]`，**0–1000 整数**（不是 0~1）。
   * 换算到任意画布宽 W:`x = left / 1000 * W`。
   */
  normalized?: number[]
}

/**
 * 图层拆分产物中的一层。`zIndex === 0` 是底图（恒有且唯一），其余是带透明通道的 PNG。
 *
 * **图层不是整幅尺寸，是按 boundingBox 裁切后放大的**（2026-08-24 实测 5.0 Pro：
 * 1024×1024 的底图，bbox 130×124 的星星图层实际是 502×484，约 3.87 倍；bbox 833×171
 * 的文字图层是 1301×268，约 1.56 倍 —— 比例逐层自洽但各不相同，甚至可能比底图还宽）。
 *
 * 所以还原叠放**必须**把每层按 boundingBox 缩放定位回底图坐标系，直接 inset-0 摞起来
 * 会把一个小图标拉成全画幅。用 `normalized`（0–1000 千分比）最省事：不需要知道底图
 * 的像素尺寸，直接换成百分比定位即可。
 *
 * 这些元数据是还原图层栈的唯一依据，丢了就只剩一堆无序、无处安放的碎图。
 */
export interface ImageLayer {
  /** 可直接喂给 <img> 的地址：URL 或 data URL */
  url: string
  mimeType: string
  /** 叠放层级，0 = 底图；{@link ApiService} 按升序返回 */
  zIndex: number
  boundingBox?: ImageLayerBoundingBox
  /** 上游给的图层名（如「前景人物」）；可能缺席 */
  name?: string
  description?: string
}

export interface GenerateResult {
  success: boolean
  images?: string[]
  urls?: string[]  // 兼容旧 API 格式
  error?: string
  rawResponse?: any
  isFluxTemporary?: boolean  // Flux 图片 10 分钟后失效
  /**
   * 图层拆分产物（按 zIndex 升序）。仅 layerDecomposition 请求且上游确实回了
   * z_index 时出现；此时 `images` 是同一批图的 URL，顺序与本数组一致（底图在前）。
   */
  layers?: ImageLayer[]
}

/**
 * 图层拆分场景 `size` 的合法取值。官方在拆分场景**只收档位**，生图那套「宽x高」像素值
 * 整档被删掉，所以这里不复用模型自己的 resolutionMap。
 *
 * 默认 `auto` 不是随手抄的默认值：拆分要求「输出底图与被拆的原图宽高比一致」，而 UI 里
 * 选的比例/像素来自出图面板，与当前这张待拆图的实际宽高比无关——拿 16:9 的档去拆一张
 * 1:1 的图，底图比例就和图层坐标系对不上，bounding_box 全部失准。auto 按输入图自适应，
 * 正好是拆分需要的语义。
 */
export const LAYER_DECOMPOSITION_SIZE_TIERS = ['auto', '1K', '1.5K', '2K'] as const
export type LayerDecompositionSizeTier = (typeof LAYER_DECOMPOSITION_SIZE_TIERS)[number]

/** 把 UI 的分辨率值收敛到拆分场景合法档位；不认识的（含像素串）一律回落 auto。 */
function resolveLayerDecompositionSizeTier(value: string | undefined): LayerDecompositionSizeTier {
  const normalized = String(value ?? '').trim()
  return (LAYER_DECOMPOSITION_SIZE_TIERS as readonly string[]).includes(normalized)
    ? (normalized as LayerDecompositionSizeTier)
    : 'auto'
}

/**
 * Miau API 站点 key。火山 / 腾讯 / 阿里那几条渠道只经这一家网关提供,模型侧用
 * {@link ModelConfig.requiredSiteKey} 声明,请求会被钉在这里而不跟随用户选的站点。
 */
export const MIAU_SITE_KEY = 'antigravity'

// 「本次请求走平台余额」的标记头曾在这里重复声明过一份(理由写的是「渲染层不能
// import 主进程模块」)。那条理由只对**主进程模块**成立,而常量本身可以住在两边共吃的
// `src/types/authApi.ts` 里 —— 现在就在那儿,连同它为什么必须只有一份的说明。

/** 生产网关。开发构建可被 `CATIMATION_GATEWAY_ORIGIN` 覆盖，见下。 */
export const DEFAULT_GATEWAY_BASE_URL = 'https://miauapi.13797248455.xyz'

/**
 * Miau 网关根地址。**只有开发构建能覆盖。**
 *
 * 为什么需要覆盖：整条平台余额链路在生产之外没法验证 —— 认证后端能用
 * `CATIMATION_AUTH_BASE_URL` 指到测试服，而网关地址若写死，测试服换来的 token
 * 会被发到生产网关、必定 401。「攻击者不能改」和「开发时也不能改」是两回事，
 * 只做前者会让这条链路不可验证，而不可验证本身也是风险。
 *
 * 为什么必须只在开发构建：这个值同时决定**请求发给谁**和**要不要打计费标记**
 * （`shouldUsePlatformBilling` 拿请求 URL 与它比 origin），所以改它等于改凭据的
 * 落点。环境变量是攻击者也能设的 —— 同一登录用户下的任何进程、快捷方式属性、
 * 外面套一层批处理都能设。
 *
 * 闸门用 `import.meta.env.DEV` 而不是运行时判断：它是 electron-vite 的**构建期
 * 常量**，生产构建里整个分支连同 `process.env` 读取会被 tree-shake 掉，安装包里
 * 根本不存在这段代码 —— 比任何运行时检查都硬。
 *
 * ⚠️ 主进程侧有对应的一半（`main/services/auth/gatewayHeaderInjector.ts` 的
 * `resolveGatewayOrigin`，闸门是 `!app.isPackaged`）。**两边必须用同一个环境变量、
 * 同时生效**：只改一边的后果是渲染层发到 A、注入器只认 B，凭据一次都注不进去。
 */
function resolveGatewayBaseUrl(): string {
  if (!import.meta.env.DEV) return DEFAULT_GATEWAY_BASE_URL

  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.CATIMATION_GATEWAY_ORIGIN?.trim()
  if (!raw) return DEFAULT_GATEWAY_BASE_URL

  try {
    // 只取 origin：带路径的输入会让下游拼出 `<origin>/<path>/v1/images/...`，
    // 表现成「覆盖了但每个请求 404」。
    return new URL(raw).origin
  } catch {
    console.warn('[ApiService] CATIMATION_GATEWAY_ORIGIN 不是合法 URL，已忽略')
    return DEFAULT_GATEWAY_BASE_URL
  }
}

/**
 * 本次请求实际会打到的 host 源。
 *
 * **`buildRequestUrl` 与平台余额判定共用这一个函数,别各写各的。** 这两件事此前是
 * 一对隐性耦合:前者会把谷歌原生模型的 host 换成 `directBaseURL`(源站直连),后者却
 * 照着 `site.baseURL` 判断 —— 于是「站点是网关」为真、「请求打向网关」为假。症状见
 * {@link evaluatePlatformBillingEligibility}。
 */
export function resolveRequestHostSource(
  modelConfig: Pick<ModelConfig, 'apiType'> | undefined,
  site: Pick<ApiSite, 'baseURL' | 'directBaseURL'>,
): string {
  return modelConfig?.apiType === 'gemini-native' && site.directBaseURL
    ? site.directBaseURL
    : site.baseURL
}

/**
 * 两个地址是否同源(protocol + host)。
 *
 * 按 origin 而不是字符串相等来比,是因为**主进程注入器认的就是 host**
 * (`gatewayHeaderInjector` 的 URL 过滤器)。字符串相等会被一个尾斜杠骗过去,
 * 而那种站点条目的请求其实照样会被注入。
 */
function isSameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.protocol === right.protocol && left.host === right.host
  } catch {
    return false
  }
}

/** 平台余额用不了的原因。`null` 表示能用。 */
export type PlatformBillingBlocker =
  | 'unknown-model'
  | 'no-site'
  /** 站点整个不在平台计费域内(apiyi / 自建 / 本地)。 */
  | 'site-not-gateway'
  /** 站点对,但这个模型的请求绕开了注入器覆盖的 host。 */
  | 'model-bypasses-gateway'

export interface PlatformBillingEligibility {
  eligible: boolean
  blocker: PlatformBillingBlocker | null
}

/**
 * 这个模型在这个站点上能不能用平台余额。
 *
 * 判据只有一条:**请求最终打到的 host 必须落在注入器的过滤器里**。凭据在主进程,
 * 渲染层只打一个标记头,由 `onBeforeSendHeaders` 在出网前换成真 `Authorization` ——
 * 而那个过滤器只挂在网关那一个 host 上。打到别处的请求有两个后果,都不响:
 *   1. 标记换不到凭据、我们又刻意不发用户自填的 Key,于是**必定 401**;
 *   2. 内部协议标记头会原样出网(注入器本该在出网前删掉它)。
 *
 * 谷歌原生模型正是这种情况:加速域名前面的 EdgeOne 不支持 `:generateContent`
 * 那条路径(一律 524),所以 `buildRequestUrl` 把它们改道到 `directBaseURL` ——
 * 一个**明文 HTTP 的源站 IP**。那个地址绝不能加进注入器白名单(等于让一枚永不过期、
 * 无法单独吊销的凭据在网络上裸奔),所以这些模型只能回落到自填 Key。
 *
 * 站点级原因优先于模型级:站点就不对的时候再说「换个模型」是误导。
 */
export function evaluatePlatformBillingEligibility(
  modelConfig: Pick<ModelConfig, 'apiType'> | undefined,
  site: Pick<ApiSite, 'baseURL' | 'directBaseURL'> | undefined,
  gateway: Pick<ApiSite, 'baseURL'> | undefined,
): PlatformBillingEligibility {
  if (!modelConfig) return { eligible: false, blocker: 'unknown-model' }
  if (!site || !gateway) return { eligible: false, blocker: 'no-site' }
  if (!isSameOrigin(site.baseURL, gateway.baseURL)) {
    return { eligible: false, blocker: 'site-not-gateway' }
  }
  if (!isSameOrigin(resolveRequestHostSource(modelConfig, site), gateway.baseURL)) {
    return { eligible: false, blocker: 'model-bypasses-gateway' }
  }
  return { eligible: true, blocker: null }
}

/**
 * seed-audio-1.0(火山豆包音频生成 1.0,经 Miau 网关 OpenAI Audio Speech 兼容端点)。
 * 仅经 Miau API 提供 —— 调用方(AudioPage)固定传 siteKey。
 * 文档:docs/seed-audio-1.0-api-guide.md(计费按输出秒数,约 ¥1/分钟;单次 ~120s 上限)。
 */
export const SEED_AUDIO_MODEL = 'seed-audio-1.0'
/** seed-audio 仅经 Miau API 网关提供,页面调用时固定 pin 该站点。 */
export const SEED_AUDIO_SITE_KEY = MIAU_SITE_KEY

export interface GenerateAudioParams {
  /** 自然语言场景描述(多角色/口音/环境音/配乐),映射上游 text_prompt。 */
  input: string
  model?: string
  /** mp3(默认) / wav / opus。aac/flac 上游回退 mp3,不暴露。 */
  responseFormat?: 'mp3' | 'wav' | 'opus'
  /** OpenAI speed 0.25~4.0(网关线性映射火山 speech_rate 并截断);UI 限 0.5~2.0。 */
  speed?: number
  /**
   * 参考音频(风格融合),最多 2 个:http(s) URL → metadata.references[].audio_url;
   * data:audio/...;base64 → audio_data(裸 base64)。不与 voice 混用(speaker 体系不兼容)。
   */
  referenceAudios?: string[]
  signal?: AbortSignal
  /** 按本次请求强制站点(镜像 GenerateImageParams.siteKey 语义)。 */
  siteKey?: string
}

export interface GenerateAudioResult {
  success: boolean
  /** 裸 base64 音频(无 data: 前缀),来自 JSON 模式响应。 */
  audioBase64?: string
  /** 实际编码格式(mp3 / ogg_opus / wav)。 */
  format?: string
  /** 音频时长(秒)。 */
  duration?: number
  /** 计费依据的输出时长(秒)。 */
  originalDuration?: number
  /** 上游音频 URL(可能为空字符串)。 */
  url?: string
  error?: string
}

export interface VisionParams {
  images: string[]  // 图片 URL 或 base64
  prompt?: string
  role?: string
  model?: string
}

export interface VisionResult {
  success: boolean
  content?: string
  error?: string
  rawResponse?: any
}

// 内置站点配置
const BUILT_IN_SITES: Record<string, ApiSite> = {
  'apiyi': {
    name: 'API易官方',
    baseURL: 'https://api.apiyi.com',
    description: '官方站点，稳定可靠',
    authType: 'bearer',
    isBuiltIn: true
  },
  'b-apiyi': {
    name: 'API易 B站',
    baseURL: 'https://b.apiyi.com',
    description: 'API易 B站端点，推荐使用',
    authType: 'bearer',
    isBuiltIn: true
  },
  'yunwu': {
    name: '云雾 API',
    baseURL: 'https://yunwu.ai',
    description: '云雾 AI 服务',
    authType: 'bearer',
    isBuiltIn: true
  },
  'bolatu': {
    name: '柏拉图 API',
    baseURL: 'https://api.bltcy.ai',
    description: '柏拉图 AI 中转站',
    authType: 'bearer',
    isBuiltIn: true
  },
  'antigravity': {
    name: 'Miau API',
    // 走加速域名而非源站 IP(2026-07-28)。只有 https 可达 —— 明文 http 连不上,
    // 端口也不再需要。同一台 new-api 实例(401 报文形状一致),换域名后 CSP 里
    // 那几条 `http://175.178.198.17:*` 例外也随之取消。
    baseURL: resolveGatewayBaseUrl(),
    // 谷歌原生端点走这里(EdgeOne 不支持那条路径,详见 ApiSite.directBaseURL)。
    directBaseURL: 'http://175.178.198.17:3000',
    description: 'Miau API 服务',
    authType: 'bearer',
    isBuiltIn: true
  },
  'local': {
    name: '本地服务',
    baseURL: `http://127.0.0.1:${localStorage.getItem('ai_image_local_port') || '3000'}`,
    description: '本地部署 API 服务',
    authType: 'bearer',
    isBuiltIn: true
  }
}

/**
 * 走腾讯私有约定的图像模型。
 *
 * ⚠️ **这是两个不同的模型、两条不同的渠道,不是同一个东西的两个入口。**
 * 上游实现与定价都不同(2026-09-01 网关价目表:`custom-model-og-v2` 倍率 5,
 * `custom-imagemodel-gt` 倍率 29.05),谁也替代不了谁 —— 新增一条不等于旧的
 * 那条可以下掉。
 *
 *  - `custom-imagemodel-gt` —— TokenHub gtimage,aiart 官方渠道;
 *  - `custom-model-og-v2`   —— TokenHub OG 新渠道,便宜近 6 倍,且支持多张输出。
 *
 * 收进一个集合只是因为**线上协议**恰好相同:关水印要发腾讯私有的
 * `extra_body.logo_add:0`(官转 / vip 那些 OpenAI 兼容端点不能外发这个),
 * 参考图要包成 `images: [{ image_url }]` 的 JSON 而不是 multipart。
 * 逐处写 `model === '...'` 的话,加第二条时一定会漏掉其中一两处 ——
 * 而漏掉的表现是「水印没关掉」或「参考图没生效」,都不报错。
 *
 * 🚫 **不要收 `hunyuan-gpt-image-2`。** 那是更早的一条渠道,网关侧已经不用了
 * (而且它只开了 generations,打 edits 会回 `does not support relay mode 6`)。
 * 它仍出现在 `/v1/models` 里,所以看起来像个可选项 —— 不是。
 */
const TENCENT_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'custom-imagemodel-gt',
  'custom-model-og-v2',
])

// gpt-image-2 与腾讯 image2(custom-imagemodel-gt) 共用同一套「比例 × 分辨率(1K/2K/4K) × 清晰度」
// 尺寸体系：30 档 size 满足 16 倍数边长 / 最大边 ≤3840 / 比例 ≤3:1 / 总像素 ∈ [655360, 8294400]。
// 抽成共享常量，避免两处重复且保证规格一致。
const GPT_IMAGE_2_RATIOS: RatioOption[] = [
  { key: 'auto', label: '自适应', description: '智能' },
  { key: '1:1', label: '方形 1:1', description: '常用' },
  { key: '16:9', label: '横版 16:9', description: '宽屏' },
  { key: '9:16', label: '竖版 9:16', description: '竖屏' },
  { key: '4:3', label: '横版 4:3', description: '标准' },
  { key: '3:4', label: '竖版 3:4', description: '标准' },
  { key: '3:2', label: '横版 3:2', description: '经典' },
  { key: '2:3', label: '竖版 2:3', description: '经典' },
  { key: '21:9', label: '影院 21:9', description: '超宽屏' },
  { key: '5:4', label: '横版 5:4', description: '传统' },
  { key: '4:5', label: '竖版 4:5', description: '社媒' }
]

const GPT_IMAGE_2_RESOLUTIONS: ResolutionOption[] = [
  { key: '1K', label: '1K 标准', description: '高效' },
  { key: '2K', label: '2K 高清', description: '稍慢速度' },
  { key: '4K', label: '4K 超清', description: '印刷所需' }
]

const GPT_IMAGE_2_QUALITIES: QualityOption[] = [
  { key: 'auto', label: '自动', description: '由模型决定' },
  { key: 'low', label: '低', description: '草图最省 $0.006' },
  { key: 'medium', label: '中', description: '均衡 $0.053' },
  { key: 'high', label: '高', description: '文字/印刷 $0.211' }
]

const GPT_IMAGE_2_RESOLUTION_MAP: Record<string, Record<string, string>> = {
  '1:1':  { '1K': '1280x1280', '2K': '2048x2048', '4K': '2880x2880' },
  '2:3':  { '1K': '848x1280',  '2K': '1360x2048', '4K': '2336x3520' },
  '3:2':  { '1K': '1280x848',  '2K': '2048x1360', '4K': '3520x2336' },
  '3:4':  { '1K': '960x1280',  '2K': '1536x2048', '4K': '2480x3312' },
  '4:3':  { '1K': '1280x960',  '2K': '2048x1536', '4K': '3312x2480' },
  '4:5':  { '1K': '1024x1280', '2K': '1632x2048', '4K': '2560x3216' },
  '5:4':  { '1K': '1280x1024', '2K': '2048x1632', '4K': '3216x2560' },
  '9:16': { '1K': '720x1280',  '2K': '1152x2048', '4K': '2160x3840' },
  '16:9': { '1K': '1280x720',  '2K': '2048x1152', '4K': '3840x2160' },
  '21:9': { '1K': '1280x544',  '2K': '2048x864',  '4K': '3840x1632' },
  'auto': { '1K': '自适应',     '2K': '自适应',     '4K': '自适应' }
}

// 默认模型配置
const DEFAULT_MODELS: Record<string, ModelConfig> = {
  'wan2.7-image-pro': {
    name: '万相 2.7 Pro',
    displayName: '20s出图，阿里万相 wan2.7-image-pro，超清文生图/图像编辑/组图，文生图支持4K、编辑/组图最高2K（经 Miau API 代理，OpenAI 兼容端点）',
    time: '20s',
    isNew: true,
    baseURL: 'https://miauapi.13797248455.xyz/v1/images/generations',
    editURL: 'https://miauapi.13797248455.xyz/v1/images/edits',
    requiredSiteKey: MIAU_SITE_KEY,
    apiType: 'image-generation',
    sizeStrategy: 'seedream',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '快速出图' },
      { key: '2K', label: '2K 高清', description: '标准分辨率' },
      { key: '4K', label: '4K 超清', description: '超高分辨率' }
    ],
    defaultResolution: '2K',
    resolutionMap: {
      '1:1': { '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
      '4:3': { '1K': '1200×896', '2K': '2304×1728', '4K': '4608×3456' },
      '3:4': { '1K': '896×1200', '2K': '1728×2304', '4K': '3456×4608' },
      '16:9': { '1K': '1376×768', '2K': '2560×1440', '4K': '5120×2880' },
      '9:16': { '1K': '768×1376', '2K': '1440×2560', '4K': '2880×5120' },
      '3:2': { '1K': '1264×848', '2K': '2496×1664', '4K': '4992×3328' },
      '2:3': { '1K': '848×1264', '2K': '1664×2496', '4K': '3328×4992' },
      '21:9': { '1K': '1584×672', '2K': '3024×1296', '4K': '6048×2592' },
      '5:4': { '1K': '1120×896', '2K': '2240×1792', '4K': '4480×3584' },
      '4:5': { '1K': '896×1120', '2K': '1792×2240', '4K': '3584×4480' }
    },
    defaultParams: {
      sequential_image_generation: 'disabled',
      response_format: 'url',
      size: '2K',
      stream: false,
      watermark: false
    },
    responseFormats: ['url'],
    capabilities: {
      multipleImages: true,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      // 组图(enable_sequential)模式 n 上限 12（模型决定实际数量，≤n）；非组图文生图 1-4
      maxOutputs: 12,
      resolutionControl: true,
      sequentialGroup: true
    }
  },
  'custom-imagemodel-gt': {
    name: '腾讯 Image 2',
    displayName: '30s出图，tokenhub 新渠道·更快更好，腾讯 image2（custom-imagemodel-gt），文生图/图片编辑，比例×分辨率(1K/2K/4K)×清晰度三参数（经 Miau API 代理，OpenAI 兼容端点）',
    time: '30s',
    isNew: true,
    baseURL: 'https://miauapi.13797248455.xyz/v1/images/generations',
    editURL: 'https://miauapi.13797248455.xyz/v1/images/edits',
    requiredSiteKey: MIAU_SITE_KEY,
    apiType: 'openai',
    sizeStrategy: 'gpt-image-2',
    // 与 gpt-image-2 共用同一套 比例 × 分辨率 × 清晰度 规格
    ratios: GPT_IMAGE_2_RATIOS,
    resolutions: GPT_IMAGE_2_RESOLUTIONS,
    defaultResolution: '2K',
    qualities: GPT_IMAGE_2_QUALITIES,
    defaultQuality: 'auto',
    resolutionMap: GPT_IMAGE_2_RESOLUTION_MAP,
    defaultParams: {
      output_format: 'png'
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true,
      qualityControl: true
    }
  },
  'custom-model-og-v2': {
    name: '腾讯 OG v2',
    displayName: '20s出图，腾讯 OG 新渠道（custom-model-og-v2），文生图/图片编辑，比例×分辨率(1K/2K/4K)×清晰度三参数，支持多张（经 Miau API 代理）',
    time: '20s',
    isNew: true,
    baseURL: 'https://miauapi.13797248455.xyz/v1/images/generations',
    editURL: 'https://miauapi.13797248455.xyz/v1/images/edits',
    requiredSiteKey: MIAU_SITE_KEY,
    apiType: 'openai',
    sizeStrategy: 'gpt-image-2',
    // 30 档 size 实测全收(1024x1024 与 3840x2160 两端都验过),与 gpt-image-2 同规格。
    ratios: GPT_IMAGE_2_RATIOS,
    resolutions: GPT_IMAGE_2_RESOLUTIONS,
    defaultResolution: '2K',
    qualities: GPT_IMAGE_2_QUALITIES,
    defaultQuality: 'auto',
    resolutionMap: GPT_IMAGE_2_RESOLUTION_MAP,
    defaultParams: {
      output_format: 'png'
    },
    capabilities: {
      multipleImages: true,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      // 与另一条腾讯渠道不同:这条实测 `n=2` 真的回 2 张。
      maxOutputs: 4,
      resolutionControl: true,
      qualityControl: true
    }
  },
  'gpt-image-2': {
    name: 'GPT Image 2',
    displayName: '60-360s，OpenAI官方旗舰，按token计费 low$0.006/med$0.053/high$0.211，比例×分辨率(1K/2K/4K)×清晰度三参数，4K+mask重绘🔥',
    price: 0.006,
    time: '60-360s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'openai',
    sizeStrategy: 'gpt-image-2',
    // 比例 / 分辨率 / 清晰度 / size 体系抽到模块级常量，与腾讯 image2 复用同一套规格
    ratios: GPT_IMAGE_2_RATIOS,
    resolutions: GPT_IMAGE_2_RESOLUTIONS,
    defaultResolution: '2K',
    qualities: GPT_IMAGE_2_QUALITIES,
    defaultQuality: 'auto',
    resolutionMap: GPT_IMAGE_2_RESOLUTION_MAP,
    defaultParams: {
      output_format: 'png'
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true,
      qualityControl: true
    }
  },
  'gpt-image-2-all': {
    name: 'GPT Image 2 All',
    displayName: '30s，GPT图像生成，文生图/图片编辑/多图融合，文字还原度高，中文友好，$0.03/张🔥',
    price: 0.03,
    time: '30s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'openai',
    sizeStrategy: 'prompt',
    capabilities: {
      multipleImages: false,
      customSize: false,
      aspectRatioControl: false,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1
    }
  },
  'gpt-image-2-vip': {
    name: 'GPT Image 2 VIP',
    displayName: '90s，gpt-image-2-vip Codex 官逆，支持 size 参数，10 比例 × 1K/2K/4K，$0.03/张🔥 限时特价',
    price: 0.03,
    time: '90s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'openai',
    sizeStrategy: 'gpt-image-2-vip',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '高效' },
      { key: '2K', label: '2K 高清', description: '稍慢速度' },
      { key: '4K', label: '4K 超清', description: '印刷所需' }
    ],
    defaultResolution: '2K',
    // 清晰度轴：2026-06-05 实测 vip 校验并支持 quality（quality=high→200，
    // quality=zzz_invalid→400 "不合法的quality"），与官转同样作为独立第三参数。
    qualities: [
      { key: 'auto', label: '自动', description: '由模型决定' },
      { key: 'low', label: '低', description: '草图最省' },
      { key: 'medium', label: '中', description: '均衡' },
      { key: 'high', label: '高', description: '文字/印刷' }
    ],
    defaultQuality: 'auto',
    // 严格对齐 apiyi gpt-image-2-vip OpenAPI 30 档 size 枚举
    // 文档: https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/text-to-image
    //       https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/image-edit
    // 注意: 必须是 ASCII 小写 x 分隔, 不是 Unicode ×; resolveGptImage2VipSize 已统一转 x
    resolutionMap: {
      // 1K Fast (长边 1280, 21:9 短边 544)
      '1:1':  { '1K': '1280x1280', '2K': '2048x2048', '4K': '2880x2880' },
      '2:3':  { '1K': '848x1280',  '2K': '1360x2048', '4K': '2336x3520' },
      '3:2':  { '1K': '1280x848',  '2K': '2048x1360', '4K': '3520x2336' },
      '3:4':  { '1K': '960x1280',  '2K': '1536x2048', '4K': '2480x3312' },
      '4:3':  { '1K': '1280x960',  '2K': '2048x1536', '4K': '3312x2480' },
      '4:5':  { '1K': '1024x1280', '2K': '1632x2048', '4K': '2560x3216' },
      '5:4':  { '1K': '1280x1024', '2K': '2048x1632', '4K': '3216x2560' },
      '9:16': { '1K': '720x1280',  '2K': '1152x2048', '4K': '2160x3840' },
      '16:9': { '1K': '1280x720',  '2K': '2048x1152', '4K': '3840x2160' },
      '21:9': { '1K': '1280x544',  '2K': '2048x864',  '4K': '3840x1632' },
      'auto': { '1K': '自适应',     '2K': '自适应',     '4K': '自适应' }
    },
    defaultParams: {
      output_format: 'png'
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true,
      qualityControl: true
    }
  },
  'gemini-3.1-flash-image': {
    name: '🍌 Nano Banana 2',
    displayName: '15s，gemini-3.1-flash-image 谷歌原生端点请求，支持超多尺寸4K，$0.03/张🚀 官网低于2折',
    price: 0.06,
    time: '15s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-3.1-flash-image:generateContent',
    apiType: 'gemini-native',
    inlineRefImageAsBase64: true,
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' },
      { key: '4:1', label: '超横版 4:1', description: '横幅' },
      { key: '1:4', label: '超竖版 1:4', description: '长图' },
      { key: '8:1', label: '极横版 8:1', description: '横幅' },
      { key: '1:8', label: '极竖版 1:8', description: '信息图' }
    ],
    resolutions: [
      { key: '0.5K', label: '0.5K 低清', description: '缩略图/预览' },
      { key: '1K', label: '1K 标准', description: '高效' },
      { key: '2K', label: '2K 高清', description: '稍慢速度' },
      { key: '4K', label: '4K 超清', description: '印刷所需' }
    ],
    defaultResolution: '1K',
    resolutionMap: {
      '1:1':  { '0.5K': '512×512',   '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
      '2:3':  { '0.5K': '424×632',   '1K': '848×1264',  '2K': '1696×2528', '4K': '3392×5056' },
      '3:2':  { '0.5K': '632×424',   '1K': '1264×848',  '2K': '2528×1696', '4K': '5056×3392' },
      '3:4':  { '0.5K': '448×600',   '1K': '896×1200',  '2K': '1792×2400', '4K': '3584×4800' },
      '4:3':  { '0.5K': '600×448',   '1K': '1200×896',  '2K': '2400×1792', '4K': '4800×3584' },
      '4:5':  { '0.5K': '464×576',   '1K': '928×1152',  '2K': '1856×2304', '4K': '3712×4608' },
      '5:4':  { '0.5K': '576×464',   '1K': '1152×928',  '2K': '2304×1856', '4K': '4608×3712' },
      '9:16': { '0.5K': '384×688',   '1K': '768×1376',  '2K': '1536×2752', '4K': '3072×5504' },
      '16:9': { '0.5K': '688×384',   '1K': '1376×768',  '2K': '2752×1536', '4K': '5504×3072' },
      '21:9': { '0.5K': '792×336',   '1K': '1584×672',  '2K': '3168×1344', '4K': '6336×2688' },
      '4:1':  { '0.5K': '1024×256',  '1K': '2048×512',  '2K': '4096×1024', '4K': '8192×2048' },
      '1:4':  { '0.5K': '256×1024',  '1K': '512×2048',  '2K': '1024×4096', '4K': '2048×8192' },
      '8:1':  { '0.5K': '1448×182',  '1K': '2896×362',  '2K': '5792×724',  '4K': '11584×1448' },
      '1:8':  { '0.5K': '182×1448',  '1K': '362×2896',  '2K': '724×5792',  '4K': '1448×11584' },
      'auto': { '0.5K': '自适应', '1K': '自适应', '2K': '自适应', '4K': '自适应' }
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true
    }
  },
  'gemini-3-pro-image': {
    name: '🍌 Nano Banana Pro',
    displayName: '60s，gemini-3-pro-image 谷歌原生端点请求，支持多尺寸4K，$0.05/张🔥 官网1/5价格',
    price: 0.09,
    time: '60s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-3-pro-image:generateContent',
    apiType: 'gemini-native',
    inlineRefImageAsBase64: true,
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '高效' },
      { key: '2K', label: '2K 高清', description: '稍慢速度' },
      { key: '4K', label: '4K 超清', description: '印刷所需' }
    ],
    defaultResolution: '1K',
    resolutionMap: {
      '1:1': { '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
      '2:3': { '1K': '848×1264', '2K': '1696×2528', '4K': '3392×5056' },
      '3:2': { '1K': '1264×848', '2K': '2528×1696', '4K': '5056×3392' },
      '3:4': { '1K': '896×1200', '2K': '1792×2400', '4K': '3584×4800' },
      '4:3': { '1K': '1200×896', '2K': '2400×1792', '4K': '4800×3584' },
      '4:5': { '1K': '928×1152', '2K': '1856×2304', '4K': '3712×4608' },
      '5:4': { '1K': '1152×928', '2K': '2304×1856', '4K': '4608×3712' },
      '9:16': { '1K': '768×1376', '2K': '1536×2752', '4K': '3072×5504' },
      '16:9': { '1K': '1376×768', '2K': '2752×1536', '4K': '5504×3072' },
      '21:9': { '1K': '1584×672', '2K': '3168×1344', '4K': '6336×2688' },
      'auto': { '1K': '自适应', '2K': '自适应', '4K': '自适应' }
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true
    }
  },
  'gemini-2.5-flash-image': {
    name: '🍌 Nano Banana',
    displayName: '15s，gemini-2.5-flash-image 谷歌原生端点请求，支持多宽高比，固定1K分辨率，$0.025/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    apiType: 'gemini-native',
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true
    }
  },
  'seedream-4-5-251128': {
    name: 'SeeDream 4.5',
    displayName: '15s出图，即梦海外版seedream-4-5-251128，超清生图编辑，支持2K/4K分辨率，支持URL与Base64输出, $0.045/张',
    time: '15s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    apiType: 'image-generation',
    sizeStrategy: 'seedream',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' }
    ],
    resolutions: [
      { key: '2K', label: '2K 高清', description: '标准分辨率' },
      { key: '4K', label: '4K 超清', description: '超高分辨率' }
    ],
    defaultResolution: '2K',
    resolutionMap: {
      '1:1': { '2K': '2048×2048', '4K': '4096×4096' },
      '4:3': { '2K': '2304×1728', '4K': '4608×3456' },
      '3:4': { '2K': '1728×2304', '4K': '3456×4608' },
      '16:9': { '2K': '2560×1440', '4K': '5120×2880' },
      '9:16': { '2K': '1440×2560', '4K': '2880×5120' },
      '3:2': { '2K': '2496×1664', '4K': '4992×3328' },
      '2:3': { '2K': '1664×2496', '4K': '3328×4992' },
      '21:9': { '2K': '3024×1296', '4K': '6048×2592' }
    },
    defaultParams: {
      sequential_image_generation: 'disabled',
      response_format: 'url',
      size: '2K',
      stream: false,
      watermark: false
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: true,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 2,
      resolutionControl: true
    }
  },
  'doubao-seedream-5-0-pro-260628': {
    name: 'Seedream 5.0 Pro',
    displayName: '20s出图，火山豆包 Seedream 5.0 Pro，文生图/图生图/多图融合(最多10张参考图)，1K/2K分辨率，仅单图（经 Miau API 代理，OpenAI 兼容端点）',
    time: '20s',
    isNew: true,
    baseURL: 'https://miauapi.13797248455.xyz/v1/images/generations',
    requiredSiteKey: MIAU_SITE_KEY,
    apiType: 'image-generation',
    sizeStrategy: 'seedream',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '快速出图' },
      { key: '2K', label: '2K 高清', description: '标准分辨率' }
    ],
    defaultResolution: '2K',
    // 像素映射来自 Miau 网关接入文档 §7(SEEDREAM_50_RESOLUTION_MAP)。5.0 Pro 无 4K 档;
    // getImageSize 优先读本表(通用硬编码表缺 4:5/5:4,且 1K 边长与本表不同)。
    resolutionMap: {
      '1:1':  { '1K': '1024x1024', '2K': '2048x2048' },
      '2:3':  { '1K': '848x1264',  '2K': '1664x2496' },
      '3:2':  { '1K': '1264x848',  '2K': '2496x1664' },
      '3:4':  { '1K': '896x1200',  '2K': '1728x2304' },
      '4:3':  { '1K': '1200x896',  '2K': '2304x1728' },
      '4:5':  { '1K': '928x1152',  '2K': '1792x2240' },
      '5:4':  { '1K': '1152x928',  '2K': '2240x1792' },
      '9:16': { '1K': '768x1376',  '2K': '1440x2560' },
      '16:9': { '1K': '1376x768',  '2K': '2560x1440' },
      '21:9': { '1K': '1584x672',  '2K': '3024x1296' }
    },
    // Pro 版不支持 sequential_image_generation / stream / tools / n(网关自动剔除),
    // 这里从源头就不发;watermark 不传时网关也会自动补 false,显式写上求明确。
    defaultParams: {
      response_format: 'url',
      watermark: false
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: false,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true,
      // 图层拆分:5.0 Pro 独有,同一 images/generations 端点靠 layer_decomposition 开关区分。
      layerDecomposition: true
    }
  },
  'qwen-image-3.0-pro': {
    name: '通义千问 Image 3.0 Pro',
    displayName: '通义千问 Image 3.0 Pro，DashScope 同步多模态出图（经 Miau API 代理，OpenAI 兼容端点）；尺寸以实际返回为准',
    time: '30s',
    isNew: true,
    baseURL: 'https://miauapi.13797248455.xyz/v1/images/generations',
    requiredSiteKey: MIAU_SITE_KEY,
    apiType: 'image-generation',
    sizeStrategy: 'seedream',
    // 官方只用两条规则约束尺寸：像素面积 512*512 ~ 2048*2048，宽高比 1:8 ~ 8:1。
    // 所以 21:9(2.33:1) / 5:4 / 4:5 全都合法 —— 早先只给 7 个比例是照别家抄的子集，
    // 不是模型的限制。
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '快速出图' },
      { key: '2K', label: '2K 高清', description: '标准分辨率' }
    ],
    defaultResolution: '2K',
    // 每档都核过官方那两条约束：面积落在 262144(512²) ~ 4194304(2048²) 之间，
    // 宽高比远在 1:8 ~ 8:1 内（最极端的 21:9 也只有 2.33:1）。
    //
    // ⚠️ 这张表是**请求值**，不是承诺值。上游开着 prompt_extend 时可能改写最终
    // 分辨率（Miau 接入说明 §6 实测请求 1328×1328 拿回约 1792×2400）。对像素有硬
    // 要求时按拿回的图校验，别拿这里的数字当结果。
    resolutionMap: {
      '1:1':  { '1K': '1024x1024', '2K': '1328x1328' },
      '2:3':  { '1K': '848x1264',  '2K': '1104x1664' },
      '3:2':  { '1K': '1264x848',  '2K': '1664x1104' },
      '3:4':  { '1K': '896x1200',  '2K': '1248x1664' },
      '4:3':  { '1K': '1200x896',  '2K': '1664x1248' },
      '9:16': { '1K': '768x1376',  '2K': '928x1664' },
      '16:9': { '1K': '1376x768',  '2K': '1664x928' },
      '21:9': { '1K': '1568x672',  '2K': '2016x864' },
      '5:4':  { '1K': '1152x928',  '2K': '1488x1200' },
      '4:5':  { '1K': '928x1152',  '2K': '1200x1488' }
    },
    // prompt_extend 跟随官方默认（true）。官方 API 文档写明「建议开启…对描述较简单的
    // 提示词效果提升明显」。代价是上游可能改写最终分辨率（Miau 接入说明 §6 实测请求
    // 1328×1328 拿回约 1792×2400）—— 两害相权，画质比尺寸可预期更值钱；对像素有硬
    // 要求的场景应当按返回的图校验，而不是靠关掉改写。
    //
    // 两个**发了也没用**的键，别再往 parameters 里加：
    //   - negative_prompt：上游支持，但网关的 AliImageParameters 没有这个键，
    //     反序列化即丢弃 —— 画质要求得写进正向提示词。
    //   - prompt_extend_mode：同样不在网关转发白名单里。默认的 `direct` 正好是
    //     T2I / I2I 都支持的那档（`agent` 在图生图下会 400），所以不传反而对。
    defaultParams: {
      response_format: 'url',
      watermark: false,
      prompt_extend: true
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      // 官方 API 文档：n 支持 1-6（此前照 Seedream 抄成 1，白砍了能力）。
      multipleImages: true,
      customSize: true,
      referenceImage: true,
      // I2I 走同一个 model，不需要 /images/edits 那条路。
      imageEdit: false,
      maxOutputs: 6,
      resolutionControl: true,
      // 参考图必须走 input.messages —— 顶层 image 字段会被网关丢弃。
      dashscopeNativeInput: true,
      // 官方：I2I 的 content 里只能有 1-3 个 {image}，多了上游直接拒。
      maxReferenceImages: 3,
      // 上游支持独立反向词；经 Miau 时**可能**到不了（网关参数表里没这个键）。
      // 仍然暴露输入框：真到不了也只是这一个字段没生效，而网关补上白名单那天
      // 就自动可用、不用再发版。界面上有一句说明，不向用户承诺它必然生效。
      negativePrompt: true
    }
  },
  'sora_image': {
    name: 'Sora Image',
    displayName: '90s出图，Sora网页版出图，同名 gpt-4o-image，价格最便宜~！$0.01/张【荐】',
    time: '90s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/chat/completions',
    apiType: 'openai',
    capabilities: {
      multipleImages: true,
      customSize: true
    }
  },
  'flux-kontext-pro': {
    name: 'Flux Kontext Pro',
    displayName: '15s出图，flux-kontext-pro，只支持英文提示词，高质量图片生成，$0.035/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'flux-kontext',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '1024×1024' },
      { key: '2:3', label: '竖版 2:3', description: '832×1248' },
      { key: '3:2', label: '横版 3:2', description: '1248×832' },
      { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
      { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
      { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
      { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
    ],
    defaultParams: {
      response_format: 'url',
      safety_tolerance: 6
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: false,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      useExtraBody: true
    }
  },
  'flux-kontext-max': {
    name: 'Flux Kontext Max',
    displayName: '15s出图，flux-kontext-max，提示词支持中文，超高质量图片编辑。$0.07/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'flux-kontext',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '1024×1024' },
      { key: '2:3', label: '竖版 2:3', description: '832×1248' },
      { key: '3:2', label: '横版 3:2', description: '1248×832' },
      { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
      { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
      { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
      { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
    ],
    defaultParams: {
      response_format: 'url',
      safety_tolerance: 6
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: false,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      useExtraBody: true
    }
  }
}

/**
 * 模型选择器的展示顺序(2026-07-20 用户指定):Seedream 5.0 Pro 最上,
 * 其次 腾讯 → Nano2 → 万相 2.7 pro → Image2 官方 → VIP;未列出的模型保持
 * DEFAULT_MODELS 原有相对顺序排在其后。经典页下拉 / 对比页等所有消费
 * `getAllModels()` 的地方都吃对象键序,这里是唯一调序点。
 */
const MODEL_DISPLAY_ORDER: readonly string[] = [
  'doubao-seedream-5-0-pro-260628',
  'custom-imagemodel-gt',
  'custom-model-og-v2',
  'gemini-3.1-flash-image',
  'wan2.7-image-pro',
  'qwen-image-3.0-pro',
  'gpt-image-2',
  'gpt-image-2-vip',
]

function orderModelsForDisplay(models: Record<string, ModelConfig>): Record<string, ModelConfig> {
  const ordered: Record<string, ModelConfig> = {}
  for (const key of MODEL_DISPLAY_ORDER) {
    if (models[key]) ordered[key] = models[key]
  }
  for (const [key, value] of Object.entries(models)) {
    if (!(key in ordered)) ordered[key] = value
  }
  return ordered
}

export class ApiService {
  private apiSites: Record<string, ApiSite>
  private customSites: Record<string, ApiSite>
  private models: Record<string, ModelConfig>
  private currentSite: string
  private currentModel: string
  private apiKey: string | null
  private visionApiKey: string | null

  constructor() {
    this.customSites = this.loadCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    this.models = orderModelsForDisplay({ ...DEFAULT_MODELS })
    this.currentSite = this.getStoredSite() || 'b-apiyi'
    this.currentModel = this.resolveModelKey(this.getStoredModel() || 'gemini-3-pro-image')
    this.apiKey = this.getStoredApiKey(this.currentSite)
    this.visionApiKey = this.getStoredVisionApiKey(this.currentSite)
    // One-time Path B bridge: push any already-configured Miau token to main so
    // a qwen understanding subagent works without re-saving the key. Deferred +
    // guarded so it never blocks construction or runs outside Electron.
    queueMicrotask(() => this.syncMiauTokenToMain())
    // Same idea for apiyi-mcp: mirror the app's already-configured apiyi key
    // into `mcp_servers.apiyi.env` so the bundled understanding MCP works
    // without the user re-pasting the key into the MCP JSON editor.
    queueMicrotask(() => void this.syncApiyiKeyToMcp())
    // Same idea for the cinematography-kb-mcp: mirror the 设置 → 运镜知识库 key
    // (localStorage) into `mcp_servers.cinematography_kb.env` so the bundled KB
    // server gets its `DASHSCOPE_API_KEY` at codex spawn.
    queueMicrotask(() => this.syncCinematographyKbKeyToMcp())
    // And the DashVector key (query_sakuga_dataset in the same bundled server).
    queueMicrotask(() => this.syncDashVectorKeyToMcp())
  }

  /**
   * 生成图片
   */
  async generateImage(params: GenerateImageParams): Promise<GenerateResult> {
    const { prompt, model, ratio, resolution, quality, referenceImages, imageBase64, negativePrompt, seed, count = 1, signal, siteKey, layerDecomposition } = params

    const modelKey = this.resolveModelKey(model || this.currentModel)
    const modelConfig = this.models[modelKey]

    if (!modelConfig) {
      return { success: false, error: `未知模型: ${modelKey}` }
    }

    // 解析「本次请求的有效站点 + 令牌」，优先级：
    //   ① 调用方显式 siteKey（codex 出图等，最高优先级，可覆盖模型声明）
    //   ② 模型声明的 requiredSiteKey —— 只经某一家网关提供的渠道。不钉的话
    //      buildRequestUrl 会把它的 host 换成当前站点的 host，打到一个没有这个
    //      模型的站点上，用户只看到莫名的 404 而不知道要去切站点。
    //   ③ 当前选中站点（普通中转渠道跟着用户选的站点走，这是中转站设计的本意）
    // 绝不临时改 this.apiKey/this.currentSite—— codex 并行 turn 下实例级可变状态
    // 会把一个渠道的 Key 串到另一个渠道。
    const requiredSiteKey =
      modelConfig.requiredSiteKey && this.apiSites[modelConfig.requiredSiteKey]
        ? modelConfig.requiredSiteKey
        : undefined
    const effectiveSiteKey =
      (siteKey && this.apiSites[siteKey] ? siteKey : undefined) ?? requiredSiteKey ?? this.currentSite
    const site = this.apiSites[effectiveSiteKey]
    const apiKey =
      effectiveSiteKey === this.currentSite ? this.apiKey : this.getStoredApiKey(effectiveSiteKey)

    // ⚠️ 平台余额模式下**本来就没有 key**，凭据由主进程在出网时按 host 注入。
    // 少了这个豁免，这道门会在请求头装配之前就把每一次出图拒掉 —— 表现是用户登录了、
    // 开关也开着，却一直被要求「请先设置 API Key」，而整条平台计费链路一次都到不了。
    //
    // 判据用 `willUsePlatformBilling` 而不是直接读 store：站点不对（apiyi / 自建）或
    // 模型绕开网关（gemini-native 走明文源站）时，这次请求实际会回落到自填 Key，
    // 那就仍然需要它 —— 这两种情况下豁免会放行一个注定 401 的请求，反而更难查。
    if (!apiKey && !this.willUsePlatformBilling(modelKey, effectiveSiteKey)) {
      return {
        success: false,
        error:
          effectiveSiteKey !== this.currentSite
            ? `未配置「${site?.name || effectiveSiteKey}」站点的 API Key —— 该渠道经此站点提供，请到设置页为该站点填入 API Key 后重试。`
            : '请先设置 API Key',
      }
    }

    // 走到这里 `apiKey` 可能是 null（平台模式放行的那一支），而下游签名要 `string`。
    // 归一成空串，**不放宽下游签名**：放宽会让每一个下游都得重新判断「null 是什么意思」，
    // 而这里只有一种含义 —— `applyAuthHeaders` 会走平台分支打标记，根本不读它。
    const resolvedApiKey = apiKey ?? ''

    // 图层拆分的前置条件在这里一次问清 —— 这两条不满足时上游的反应都是「静默降级」:
    // 不支持的渠道把 layer_decomposition 当未知字段丢掉、照常出一张普通图;没有输入图
    // 就变成一次普通文生图。两种情况都会成功返回一张图,用户只会疑惑「拆分怎么没生效」。
    if (layerDecomposition) {
      if (!modelConfig.capabilities?.layerDecomposition) {
        return {
          success: false,
          error: `${modelConfig.displayName || modelKey} 不支持图层拆分，请切换到 Seedream 5.0 Pro 后重试。`,
        }
      }
      const hasInputImage = !!imageBase64 || (referenceImages?.length ?? 0) > 0
      if (!hasInputImage) {
        return { success: false, error: '图层拆分需要一张待拆分的输入图，请先上传参考图。' }
      }
    }

    // 上游只吃 png/jpeg,而本 app 存在 COS 的历史图是 **webp** —— 「对一张历史图点拆分」
    // 是必然踩中的主路径,不转的话用户拿到的是一句 image format is not supported。
    // 放在这个收口处而不是各调用方:工具栏 / 批量 worker / MCP agent 全都经过 generateImage。
    let splitInput: string | undefined
    if (layerDecomposition) {
      const source = imageBase64 || referenceImages?.[0] || ''
      const prepared = await ensureLayerSplitInputFormat(source)
      if (!prepared.image) return { success: false, error: prepared.error }
      splitInput = prepared.image
    }

    try {
      const response = await this.withRetry(
        () => this.makeApiRequest({
          prompt,
          model: modelKey,
          ratio,
          resolution,
          quality,
          // 拆分模式下输入图已归一化为 png/jpeg,用它顶掉原始来源(payload 只取一张)。
          referenceImages: splitInput ? [splitInput] : referenceImages,
          imageBase64: splitInput ?? imageBase64,
          negativePrompt,
          seed,
          count,
          modelConfig,
          site,
          apiKey: resolvedApiKey,
          signal,
          layerDecomposition,
        }),
        // 瞬时网关错误(502/503/504/429)现在会从 makeApiRequest 抛出，交给这里重试；
        // 给 2 次重试(共 3 次尝试)+ 指数退避(2s、4s)，覆盖上游高峰期的短暂抖动。
        { maxRetries: 2, retryDelay: 2000 }
      )

      const result = await this.parseResponse(response, modelConfig, layerDecomposition)
      
      // 标记 Flux 图片为临时的
      if (modelConfig.apiType === 'flux-kontext' && result.success) {
        result.isFluxTemporary = true
      }

      return result
    } catch (error) {
      if (signal?.aborted) {
        return { success: false, error: '操作已取消' }
      }
      console.error('生成图片失败:', error)
      return {
        success: false,
        error: this.formatErrorMessage(error as Error)
      }
    }
  }

  /**
   * 生成音频(seed-audio-1.0,POST /v1/audio/speech,OpenAI Audio Speech 兼容)。
   *
   * 固定带 `Accept: application/json` 走 JSON 模式:一次拿到 base64 音频 + 时长
   * (originalDuration=计费秒数,可直接展示)+ 可选上游 URL,比二进制流好持久化。
   * 站点/Key 解析与 generateImage 同款:siteKey 强制 pin(seed-audio 仅经 Miau),
   * 绝不动实例级 currentSite/apiKey。不发 voice(speaker 体系与旧 TTS 不兼容,
   * 官方推荐纯自然语言 input 或参考音频)。
   */
  async generateAudio(params: GenerateAudioParams): Promise<GenerateAudioResult> {
    const { input, model, responseFormat, speed, referenceAudios, signal, siteKey } = params

    const effectiveSiteKey = siteKey && this.apiSites[siteKey] ? siteKey : this.currentSite
    const site = this.apiSites[effectiveSiteKey]
    const apiKey =
      effectiveSiteKey === this.currentSite ? this.apiKey : this.getStoredApiKey(effectiveSiteKey)

    if (!apiKey) {
      return {
        success: false,
        error:
          effectiveSiteKey !== this.currentSite
            ? `未配置「${site?.name || effectiveSiteKey}」站点的 API Key —— 音频生成经此站点提供，请到设置页为该站点填入 API Key 后重试。`
            : '请先设置 API Key',
      }
    }
    if (!input || !input.trim()) {
      return { success: false, error: '请输入音频描述' }
    }

    const body: Record<string, unknown> = {
      model: model || SEED_AUDIO_MODEL,
      input: input.trim(),
      response_format: responseFormat || 'mp3',
    }
    if (typeof speed === 'number' && speed !== 1) {
      body.speed = Math.min(4, Math.max(0.25, speed))
    }
    const references = (referenceAudios || [])
      .map((src): Record<string, string> | null => {
        const s = typeof src === 'string' ? src.trim() : ''
        if (!s) return null
        if (/^https?:\/\//i.test(s)) return { audio_url: s }
        // data:audio/...;base64,xxx → 上游要裸 base64 的 audio_data
        const m = s.match(/^data:audio\/[^;]+;base64,(.+)$/i)
        if (m) return { audio_data: m[1] }
        return null
      })
      .filter((r): r is Record<string, string> => r !== null)
      .slice(0, 2)
    if (references.length > 0) {
      body.metadata = { references }
    }

    try {
      const url = `${site.baseURL}/v1/audio/speech`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // 必须带 Accept 才走 JSON 响应(只改 Content-Type 不行,见接入文档 §7)
        'Accept': 'application/json',
      }
      this.applyAuthHeaders(headers, site, apiKey, url)

      const response = await this.withRetry(
        async () => {
          // 生成耗时随文本长度增长(上限 ~120s 音频),给 10 分钟软天花板
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: this.composeTimeoutSignal(signal, 600_000),
          })
          if ([429, 500, 502, 503, 504].includes(resp.status)) {
            const errText = await resp.clone().text().catch(() => '')
            const err = new Error(
              `音频服务暂时不可用（HTTP ${resp.status}）${errText ? `：${errText.slice(0, 200)}` : ''}`,
            ) as Error & { status?: number }
            err.status = resp.status
            throw err
          }
          return resp
        },
        { maxRetries: 1, retryDelay: 2000 },
      )

      const rawText = await response.text().catch(() => '')
      let data: any = null
      try { data = rawText.trim() ? JSON.parse(rawText) : null } catch { /* 非 JSON,走下方错误分支 */ }

      if (!response.ok) {
        const apiMsg = data?.error?.message || data?.message
        return {
          success: false,
          error: `${apiMsg || '音频生成失败'}（HTTP ${response.status}）`,
        }
      }
      if (!data || typeof data.audio !== 'string' || data.audio.length === 0) {
        return {
          success: false,
          error: `音频服务返回了非预期响应：${rawText.replace(/\s+/g, ' ').slice(0, 200) || '(空)'}`,
        }
      }

      return {
        success: true,
        audioBase64: data.audio,
        format: typeof data.format === 'string' ? data.format : (responseFormat || 'mp3'),
        duration: typeof data.duration === 'number' ? data.duration : undefined,
        originalDuration: typeof data.original_duration === 'number' ? data.original_duration : undefined,
        url: typeof data.url === 'string' && data.url ? data.url : undefined,
      }
    } catch (error) {
      if (signal?.aborted) return { success: false, error: '操作已取消' }
      console.error('[ApiService] generateAudio 失败:', error)
      return { success: false, error: this.formatErrorMessage(error as Error) }
    }
  }

  /**
   * 基于参考图生成图片 (垫图功能) - 兼容旧 API 签名
   * @param prompt 提示词
   * @param referenceImages 参考图片数组
   * @param ratio 比例
   * @param count 生成数量
   * @param resolution 分辨率
   */
  async generateImageWithReference(
    prompt: string,
    referenceImages: ReferenceImageSource[],
    ratio: string = '1:1',
    count: number = 1,
    resolution?: string
  ): Promise<GenerateResult> {
    return this.generateImage({
      prompt,
      referenceImages: this.flattenReferenceSources(referenceImages),
      ratio,
      count,
      resolution
    })
  }

  /**
   * 把旧签名允许的对象形态参考图压成 generateImage 声明的 `string[]`。
   *
   * generateImage 往下每一站（拆分预处理、resolveSourcesToDataUrls、各家 payload
   * 构造）都按「元素是字符串源」写的，只有最末端的 normalizeImageSource 兼容对象。
   * 所以在入口就用同一套规则压平：压出来的字符串与末端自己归一化出的结果一致，
   * 而字符串元素原样透传、不提前改写。
   */
  private flattenReferenceSources(sources: ReferenceImageSource[]): string[] {
    const flattened: string[] = []
    for (const source of sources) {
      if (typeof source === 'string') {
        flattened.push(source)
        continue
      }
      const normalized = this.normalizeImageSource(source)
      if (normalized) {
        flattened.push(normalized)
      } else {
        console.warn('[ApiService] generateImageWithReference: 参考图形态无法识别，已跳过')
      }
    }
    return flattened
  }

  /**
   * 带重试的请求包装
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries?: number; retryDelay?: number } = {}
  ): Promise<T> {
    const { maxRetries = 1, retryDelay = 2000 } = options
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error as Error
        
        // 判断是否可重试
        if (!this.isRetryableError(error) || attempt >= maxRetries) {
          throw error
        }

        console.warn(`请求失败，${retryDelay}ms 后重试 (${attempt + 1}/${maxRetries})`)
        await this.delay(retryDelay * (attempt + 1))  // 指数退避
      }
    }

    throw lastError
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: any): boolean {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return false
    }

    // 网络错误可重试
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true
    }

    // 5xx 错误可重试
    if (error.status && error.status >= 500) {
      return true
    }

    // 429 Too Many Requests 可重试
    if (error.status === 429) {
      return true
    }

    return false
  }

  /**
   * 格式化错误消息
   */
  private formatErrorMessage(error: Error): string {
    const message = error.message || '未知错误'

    // 网络错误
    if (message.includes('fetch') || message.includes('network')) {
      return '网络连接失败，请检查网络设置'
    }

    // 超时（AbortSignal.timeout 抛出 TimeoutError，用户取消抛出 AbortError）
    if (message.includes('timeout') || error.name === 'TimeoutError') {
      return '请求超时，图片生成可能需要较长时间（高画质 / 4K 最长可达 20 分钟），请稍后重试'
    }
    if (error.name === 'AbortError') {
      return '操作已取消'
    }

    // API Key 错误
    if (message.includes('401') || message.includes('Unauthorized')) {
      return 'API Key 无效或已过期'
    }

    // 余额不足
    if (message.includes('402') || message.includes('insufficient')) {
      return '账户余额不足'
    }

    // 频率限制
    if (message.includes('429') || message.includes('rate limit')) {
      return '请求过于频繁，请稍后重试'
    }

    return message
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 图像理解 (Vision API)
   */
  async understandImage(params: VisionParams): Promise<VisionResult> {
    const { images, prompt = '请描述这张图片', role, model = 'gemini-1.5-flash' } = params

    // 站点与 URL 提到守卫之前算 —— 「这次走不走平台余额」的判据是**请求 URL 的
    // host**（见 `shouldUsePlatformBilling`），不先把 URL 拼出来就没法豁免下面那道门。
    const site = this.apiSites[this.currentSite]
    const url = `${site.baseURL}/v1/chat/completions`

    const apiKey = this.visionApiKey || this.apiKey
    // 平台余额模式下**本来就不该有 Key** —— 凭据在主进程，渲染层只打标记头。
    // 少了这道豁免，用户登录了、开关也开着，图像理解却一直被要求「请先设置 API Key」，
    // 而整条平台计费链路一次都到不了。与 `generateImage` 那道门同一个修法。
    if (!apiKey && !this.shouldUsePlatformBilling(url)) {
      return { success: false, error: '请先设置 API Key' }
    }

    if (!images || images.length === 0) {
      return { success: false, error: '请提供至少一张图片' }
    }

    try {

      const content: any[] = []
      
      // 添加提示词
      const systemPrompt = role ? `你是${role}。` : ''
      content.push({ type: 'text', text: systemPrompt + prompt })

      // 添加图片
      for (const img of images) {
        const normalized = this.normalizeImageSource(img)
        if (normalized) {
          content.push({
            type: 'image_url',
            image_url: { url: normalized }
          })
        }
      }

      // 走统一装配:平台模式打标记头(主进程换成影子 token + 计费归属),否则照旧
      // 发自填 Key。手写 Authorization 的后果是这条路**永远**扣自填 Key 的钱,
      // 而用户以为图像理解也在花账号余额。
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      this.applyAuthHeaders(headers, site, apiKey ?? '', url)

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          max_tokens: 4096
        })
      })

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error?.message || `API 错误: ${response.status}`,
          rawResponse: data
        }
      }

      const textContent = data.choices?.[0]?.message?.content || ''
      
      return {
        success: true,
        content: textContent,
        rawResponse: data
      }
    } catch (error) {
      console.error('图像理解失败:', error)
      return {
        success: false,
        error: (error as Error).message || '图像理解失败'
      }
    }
  }

  /**
   * 分析图片（流式输出版本）
   * @param images - 图片数组，每个包含 {base64, mimeType}
   * @param prompt - 用户提示词
   * @param model - 模型名称
   * @param maxTokens - 最大输出 tokens 数量（可选）
   * @param onChunk - 流式回调函数，接收每个文本片段
   * @param onComplete - 完成回调
   * @param onError - 错误回调
   */
  async analyzeImagesStream(
    images: Array<{ base64: string; mimeType?: string }>,
    prompt: string,
    model: string,
    maxTokens: number | null,
    onChunk: (chunk: string) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    // 见 `understandImage`:URL 要先拼出来,那道门才能按「这次是否走平台余额」豁免。
    const site = this.apiSites[this.currentSite]
    const apiUrl = `${site.baseURL}/v1/chat/completions`

    if (!this.visionApiKey && !this.shouldUsePlatformBilling(apiUrl)) {
      const error = new Error('请先设置图像理解 API Key')
      onError?.(error)
      throw error
    }

    if (!images || images.length === 0) {
      const error = new Error('请至少上传一张图片')
      onError?.(error)
      throw error
    }

    const useMaxTokens = typeof maxTokens === 'number' && maxTokens > 0

    console.log('🔍 开始图像理解分析 (流式输出):', {
      model,
      imageCount: images.length,
      promptLength: prompt.length,
      maxTokens: useMaxTokens ? maxTokens : '使用模型默认',
      currentSite: this.currentSite,
      visionApiKeySet: !!this.visionApiKey
    })

    // 构造 OpenAI 兼容格式的请求
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: prompt }
    ]

    // 添加所有图片
    for (const image of images) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`
        }
      })
    }

    const requestBody: Record<string, any> = {
      model: model,
      messages: [
        {
          role: 'user',
          content: content
        }
      ],
      temperature: 0.7,
      stream: true
    }

    if (useMaxTokens) {
      requestBody.max_tokens = maxTokens
    }

    try {
      console.log('🔗 图像理解流式 API 请求 URL:', apiUrl)

      // 见 `understandImage`:统一装配,平台模式打标记头而不是自填 Key。
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      this.applyAuthHeaders(headers, site, this.visionApiKey ?? '', apiUrl)

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const error = new Error(
          (errorData as any).error?.message ||
          `API 请求失败: ${response.status} ${response.statusText}`
        )
        onError?.(error)
        throw error
      }

      // 使用 ReadableStream 读取流式数据
      const reader = response.body?.getReader()
      if (!reader) {
        const error = new Error('无法读取响应流')
        onError?.(error)
        throw error
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          console.log('✅ 流式输出完成')
          onComplete?.()
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmedLine = line.trim()

          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6)

            if (data === '[DONE]') {
              console.log('📌 收到结束标记 [DONE]')
              continue
            }

            try {
              const json = JSON.parse(data)

              // 提取内容片段 - 尝试多种可能的字段路径
              let textContent = json.choices?.[0]?.delta?.content  // OpenAI 标准格式
              if (!textContent) textContent = json.choices?.[0]?.message?.content  // 非流式格式
              if (!textContent) textContent = json.delta?.content  // 简化格式
              if (!textContent) textContent = json.content  // 最简格式

              if (textContent && onChunk) {
                onChunk(textContent)
              }
            } catch (parseError) {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ 图像理解分析失败 (流式):', error)
      onError?.(error as Error)
      throw error
    }
  }

  /**
   * 构建请求 URL：用站点的域名替换模型 URL 中的域名
   */
  private buildRequestUrl(modelConfig: ModelConfig, site: ApiSite, urlType?: 'base' | 'edit'): string {
    const sourceUrl = (urlType === 'edit' && modelConfig.editURL)
      ? modelConfig.editURL
      : modelConfig.baseURL

    if (!sourceUrl) {
      return `${site.baseURL}/v1/chat/completions`
    }

    // 谷歌原生端点绕开 CDN:加速域名前面的 EdgeOne 不支持
    // `/v1beta/models/...:generateContent`,走它必 524(且报成 CORS 错误)。
    // 按 apiType 判定而不是逐个模型打标记 —— 以后新增谷歌模型自动跟随。
    //
    // ⚠️ 改这里之前先看 {@link evaluatePlatformBillingEligibility} 与
    // `shouldUsePlatformBilling`:**改道会同时改掉计费落点**。平台余额的凭据由主进程
    // 按 host 注入,改道到一个注入器看不见的 host 就等于让那些模型静默 401。所以
    // host 的选择只有 `resolveRequestHostSource` 这一个出处,两边共用。
    const hostSource = resolveRequestHostSource(modelConfig, site)

    try {
      const modelUrl = new URL(sourceUrl)
      const siteUrl = new URL(hostSource)
      modelUrl.protocol = siteUrl.protocol
      modelUrl.host = siteUrl.host
      return modelUrl.toString()
    } catch {
      return sourceUrl
    }
  }

  /**
   * 本次请求是否改用平台账号余额出图。
   *
   * 两个条件缺一不可:
   * 1. 用户在「账号」分区把计费来源切到了 `platform`(切的那一刻主进程已按池取好凭据);
   * 2. 请求确实打向 Miau 网关。**平台余额只覆盖这一个计费域** —— 主进程的注入器只在
   *    那个 host 上挂过滤器,别的站点(apiyi / 自建)打了标记也换不到凭据,反而因为
   *    我们不再发 Authorization 而直接 401。
   *
   * 第 2 条按 **实际请求 URL 而不是站点键、也不是 site.baseURL** 判定,两条理由:
   * - 注入器认的就是 host。用户完全可以自建一个指向同一网关的自定义站点条目,那种
   *   请求照样会被注入,所以也该打标记 —— 只认站点键会漏掉它。
   * - **`site.baseURL` 不等于请求真正打向的 host**。`buildRequestUrl` 会把谷歌原生
   *   模型改道到 `directBaseURL`(见那里的注释),站点仍是网关、请求却已经不是了。
   *   照 baseURL 判的那段时间里,那三个 Nano Banana 模型在平台模式下必定 401。
   *   模型维度的同一判据见 {@link evaluatePlatformBillingEligibility}(UI 提示用它)。
   */
  private shouldUsePlatformBilling(requestUrl: string): boolean {
    if (useQuotaStore.getState().billingSource !== 'platform') return false
    const gateway = this.apiSites[MIAU_SITE_KEY]
    return !!gateway && isSameOrigin(requestUrl, gateway.baseURL)
  }

  /**
   * 「这次请求会走平台余额吗」—— 给**出图前的前置门**用，此时请求 URL 还没拼出来。
   *
   * 与 {@link shouldUsePlatformBilling} 是同一个问题的两个时点：那个按已成型的请求
   * URL 判（装配请求头时），这个按 模型 + 站点 提前判（决定要不要放行没有 key 的请求）。
   * 两者必须给出一致的结论，否则会出现「门放行了但头没装上」= 裸奔撞 401，
   * 或者「门拦下了但本该走平台」= 登录了还被要求填 key。
   *
   * 复用 `evaluatePlatformBillingEligibility`，所以 gemini-native 那三个绕开网关的
   * 模型在这里也会被判成不合格 —— 它们确实需要自填 Key，门该照常拦。
   */
  private willUsePlatformBilling(modelKey: string, effectiveSiteKey: string): boolean {
    if (useQuotaStore.getState().billingSource !== 'platform') return false
    return evaluatePlatformBillingEligibility(
      this.models[modelKey],
      this.apiSites[effectiveSiteKey],
      this.apiSites[MIAU_SITE_KEY],
    ).eligible
  }

  /**
   * 「当前设置下这个模型能不能走平台余额」—— 给 UI 用的入口。
   *
   * 站点解析照 `generateImage` 那套优先级(requiredSiteKey → 当前站点),不能让组件
   * 自己抄一份:抄错的症状是提示与实际计费落点不一致,比没有提示更糟。
   */
  getPlatformBillingEligibility(modelKey: string): PlatformBillingEligibility {
    const modelConfig = this.getModelConfig(modelKey)
    const siteKey =
      modelConfig?.requiredSiteKey && this.apiSites[modelConfig.requiredSiteKey]
        ? modelConfig.requiredSiteKey
        : this.currentSite
    return evaluatePlatformBillingEligibility(
      modelConfig,
      this.apiSites[siteKey],
      this.apiSites[MIAU_SITE_KEY],
    )
  }

  /**
   * 给请求头装上认证信息。
   *
   * 平台模式下**只打标记、绝不发 Authorization**:凭据在主进程,由
   * `onBeforeSendHeaders` 在出网前换上。渲染层是 `nodeIntegration: true` 且无
   * contextIsolation 的环境,不放凭据。发用户那把旧 Key 更糟 —— 注入一旦没生效,
   * 请求就会**静默地用用户自己的钱出图成功**,而他以为在花平台余额。
   *
   * 抽成一个方法,是因为请求头装配散在 6 个地方(通用 JSON 出图 / gpt-image-2 JSON /
   * Flux multipart / 腾讯 image2 JSON / gpt-image-2 multipart / TTS)。漏掉任何一处的
   * 症状都是「有的模型走平台余额、有的模型静默用自填 Key」——两条计费链路同时在跑,
   * 而账单要到月底才对得出来。新增出网点请一律走这里,别再手写那三条分支。
   *
   * `requestUrl` 是本次请求**真正要 fetch 的那个地址**,不是站点根地址 —— 平台余额
   * 判定按它的 host 走(理由见 `shouldUsePlatformBilling`)。每个出网点手上本来就有
   * 这个值,传它比传 modelConfig 更难写错:URL 是既成事实,而 modelConfig 在
   * TTS / multipart 那几条路径上压根不在作用域里。
   */
  private applyAuthHeaders(
    headers: Record<string, string>,
    site: ApiSite,
    apiKey: string,
    requestUrl: string,
  ): Record<string, string> {
    if (this.shouldUsePlatformBilling(requestUrl)) {
      headers[BILLING_MARKER_HEADER] = BILLING_MARKER_VALUE
    } else if (site.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }
    return headers
  }

  /**
   * 发起 API 请求
   */
  private async makeApiRequest(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    quality?: string
    referenceImages?: string[]
    imageBase64?: string
    negativePrompt?: string
    seed?: number
    count: number
    modelConfig: ModelConfig
    site: ApiSite
    /** 本次请求使用的 API Key（由 generateImage 按有效站点解析后透传，避免实例级竞态）。 */
    apiKey: string
    signal?: AbortSignal
    layerDecomposition?: boolean
  }): Promise<Response> {
    const { prompt, model, ratio, resolution, quality, referenceImages, imageBase64, negativePrompt, seed, count, modelConfig, site, apiKey, signal, layerDecomposition } = options

    // gpt-image-2 / gpt-image-2-all / gpt-image-2-vip / 腾讯 image2: 专用 Images API 路径
    if (model === 'gpt-image-2-all' || model === 'gpt-image-2' || model === 'gpt-image-2-vip'
        || TENCENT_IMAGE_MODELS.has(model)) {
      const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
      const hasImages = imageSources.length > 0
      // 支持 size + quality 三参数的模型：官转 / vip / 腾讯 image2（同规格，复用 resolutionMap）
      const acceptsSizeQuality = this.isSizeQualityImageModel(model)
      // 用户反馈：宁可等后台真正返回结果或明确报错，也不要"快失败"。
      // 三档统一拉到约 2000s（~33 分钟）当作"基本不设超时"的天花板——完成耗时主要
      // 受上游排队 / 审核触发影响，之前 1200s 偶尔仍在 2K/4K high 下被截断，导致
      // 工具侧误报超时、实际却已生成成功。
      const timeoutMs = 2_000_000

      // size 解析：支持 size 的模型共用 resolutionMap（ratio × resolution → 30 档 size），
      // 官逆 (-all) 不发 size（写进 prompt）。
      const resolvedSize = acceptsSizeQuality
        ? this.resolveImageSizeFromMap(modelConfig, ratio, resolution)
        : undefined
      // quality：官转 / vip / 腾讯 均支持独立的 quality 参数（不借用 resolution）
      const resolvedQuality = acceptsSizeQuality ? this.resolveGptImage2Quality(quality) : undefined

      if (hasImages) {
        const editUrl = this.buildRequestUrl(modelConfig, site, 'edit')
        // 腾讯 image2(custom-imagemodel-gt):edit 端点是官方文档(GPT-Maas)的 JSON
        // `images: [{ image_url }]` 契约(Array of ImageRef)，**不接受标准 multipart/form-data**
        // （这也是这条专用 JSON 路径存在的原因）。因此腾讯渠道一律走 JSON：
        //   - http/https 参考图直接传 URL（省带宽、避开"url too long"/请求体膨胀）；
        //   - base64 / data: / 裸 base64 / 对象形参考图，归一化成 data URI；
        //   两者最终都包成 ImageRef 对象放进 images:[] —— image_url 字段官方明确"传图片的
        //   url 地址或 base64 编码数据"，所以腾讯也能像 gpt-image-2 一样吃 base64 参考图，
        //   而不是回落到网关根本不支持的 multipart 导致失败。
        if (TENCENT_IMAGE_MODELS.has(model)) {
          const jsonSources = imageSources
            .map((s) => this.normalizeImageSource(s))
            .filter((s): s is string => !!s)
          if (jsonSources.length === 0) {
            throw new Error('腾讯 image2 参考图无法解析为 URL 或 base64，请检查输入参考图')
          }
          return this.makeTencentImage2JsonEdit(
            editUrl, model, prompt, jsonSources, site, apiKey, signal, timeoutMs, resolvedSize, resolvedQuality,
          )
        }
        return this.makeGptImage2FormDataRequest(editUrl, model, prompt, imageSources, site, apiKey, signal, timeoutMs, resolvedSize, resolvedQuality)
      } else {
        const genUrl = this.buildRequestUrl(modelConfig, site)
        const body = this.buildGptImage2JsonPayload(model, prompt, resolvedSize, resolvedQuality)
        this.logImageRequest(model, genUrl, body)
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        this.applyAuthHeaders(headers, site, apiKey, genUrl)
        const fetchSignal = this.composeTimeoutSignal(signal, timeoutMs)
        const resp = await fetch(genUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: fetchSignal,
        })
        if (!resp.ok) {
          const errText = await resp.clone().text()
          console.error('[GPT-Image-2] error response:', resp.status, errText)
          if (resp.status >= 500 || resp.status === 429) {
            const err = new Error(errText || `API 请求失败: ${resp.status} ${resp.statusText}`) as Error & { status?: number }
            err.status = resp.status
            throw err
          }
        }
        return resp
      }
    }

    // 构建请求 URL：用站点的域名替换模型 URL 中的域名
    const url = this.buildRequestUrl(modelConfig, site)

    // 内联 base64 的唯一规则：只有 nano / gemini 系列(inlineRefImageAsBase64 === true)
    // 才把参考图抓成 data URL；其余模型一律走 COS / 远端 URL 直传。
    // - 单一真源 = wantsInlineBase64ForModel(同前端 refImageStrategy),改一处全局跟随;
    // - 之前还按 baseURL 命中 `/images/generations` 强转 base64,把 wan2.7(input.messages
    //   原生支持 URL)的 COS 参考图回灌成超大 base64,既浪费带宽又易触发上游
    //   "url is too long" / 请求体膨胀 —— 已移除该判断;
    // - 正常路径下 gemini 参考图在上传时就已是 base64(切到 nano 时前端清空 URL 参考图、
    //   要求重新上传压缩,见 useRefImageModelSync / syncReferenceImagesForModel),
    //   这里只兜底极少数仍带 URL 的情况;
    // - multipart(gpt-image-2 已在上面分支返回；Flux / sora-chat 直接用 URL)不走这里。
    let resolvedRefs = referenceImages
    let resolvedImageBase64 = imageBase64
    const needsBase64Sources = wantsInlineBase64ForModel(modelConfig)
    if (needsBase64Sources) {
      resolvedRefs = await this.resolveSourcesToDataUrls(referenceImages)
      if (imageBase64 && /^https?:\/\//i.test(imageBase64)) {
        const r = await this.resolveSourcesToDataUrls([imageBase64])
        resolvedImageBase64 = r?.[0] ?? imageBase64
      }
    }

    const body = this.buildRequestBody({
      prompt,
      model,
      ratio,
      resolution,
      referenceImages: resolvedRefs,
      imageBase64: resolvedImageBase64,
      negativePrompt,
      seed,
      count,
      modelConfig,
      layerDecomposition
    })

    // 检查是否需要 FormData (Flux with images)
    if (body.__isFluxKontextWithImage) {
      return this.makeFluxFormDataRequest(url, body, site, apiKey, signal)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    this.applyAuthHeaders(headers, site, apiKey, url)

    // 所有模型(nano/gemini、wan、sora、通用 OpenAI-compat)统一打印请求体到 F12，
    // 方便核对发出去的到底是 URL 还是 base64；base64/超长串会被截断，避免刷屏。
    this.logImageRequest(model, url, body)

    // 与 gpt-image-2 系列对齐：所有模型（Gemini-native / Flux / 通用 OpenAI-compat）
    // 都给约 2000s（~33 分钟）的软天花板，避免 Nano Banana Pro 等长耗时模型在上游排队 /
    // 高峰期被过早截断（宁可等真实结果或明确报错）。
    const fetchSignal = this.composeTimeoutSignal(signal, 2_000_000)

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    })

    if (!resp.ok) {
      const errText = await resp.clone().text()
      console.error(`[ApiService] ${model} ${resp.status} @ ${url}:`, errText.slice(0, 4000))

      // 瞬时网关/服务端错误(429/500/502/503/504)抛出带 status 的异常，
      // 交给 withRetry 自动重试(它把 status>=500 / 429 判为可重试)。
      // nginx 502 Bad Gateway 这类上游后端临时无响应属于典型可恢复故障，
      // 不应像非 OK 那样直接落到 parseResponse 一次性失败。
      // 非瞬时错误(400/401/402/404 等)仍返回 resp，由 parseResponse 生成友好提示。
      if ([429, 500, 502, 503, 504].includes(resp.status)) {
        const snippet = errText.replace(/\s+/g, ' ').trim().slice(0, 300)
        const err = new Error(
          `服务器网关暂时不可用（HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}），` +
            `已自动重试仍失败，请稍后再试或更换模型/站点。${snippet ? `详情：${snippet}` : ''}`
        ) as Error & { status?: number }
        err.status = resp.status
        throw err
      }
    }

    return resp
  }

  /**
   * 把上游 abort signal 与 20 分钟超时拼起来；任一触发即取消请求。
   * 抽出来是因为多个 fetch 调用点都要套同样的"用户取消 + 硬超时"组合。
   */
  private composeTimeoutSignal(userSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal
  }

  /**
   * 统一打印图片生成请求体到 F12，方便核对「发的是 URL 还是 base64」。
   * - data:/超长字符串(base64)截断成 `data:image/...;base64,xxxx…[N chars]`，避免控制台被刷爆；
   * - 任何模型(nano/gemini、wan、sora、gpt-image、flux)都走这一个入口，tag 用模型名。
   */
  private logImageRequest(model: string, url: string, body: unknown): void {
    try {
      const json = JSON.stringify(
        body,
        (_k, v) =>
          typeof v === 'string' && v.length > 200
            ? `${v.slice(0, 64)}…[${v.length} chars]`
            : v,
        2,
      )
      console.log(`[ImageReq:${model}] URL:`, url)
      console.log(`[ImageReq:${model}] body:`, json)
    } catch {
      console.log(`[ImageReq:${model}] URL:`, url, '(body 无法序列化)')
    }
  }

  /**
   * Flux Kontext FormData 请求
   */
  private async makeFluxFormDataRequest(
    url: string,
    payload: any,
    site: ApiSite,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const formData = new FormData()

    formData.append('model', payload.model)
    formData.append('prompt', payload.prompt)
    
    if (payload.ratio) {
      formData.append('aspect_ratio', payload.ratio)
    }
    
    formData.append('safety_tolerance', '6')
    formData.append('n', '1')

    // 处理图片
    const imageSources = payload.imageBase64 
      ? [payload.imageBase64] 
      : (payload.referenceImages || [])

    if (imageSources.length > 0) {
      const imageSource = imageSources[0]  // Flux 只支持单张图片
      const blob = await this.convertToBlob(imageSource)
      if (blob) {
        formData.append('image', blob, 'image.jpg')
      }
    }

    const headers: Record<string, string> = {}
    this.applyAuthHeaders(headers, site, apiKey, url)

    const fetchSignal = this.composeTimeoutSignal(signal, 2_000_000)

    return fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal: fetchSignal,
    })
  }

  /**
   * gpt-image-2 系列：文生图 JSON payload（无参考图）
   * - gpt-image-2 (官转)：支持 size/quality 参数
   * - gpt-image-2-vip (Codex 官逆)：支持 size/quality 参数（2026-06-05 实测 quality 被校验且生效）
   * - gpt-image-2-all (官逆)：均不支持，回 b64_json
   */
  private buildGptImage2JsonPayload(model: string, prompt: string, size?: string, quality?: string): object {
    const acceptsSizeQuality = this.isSizeQualityImageModel(model)
    const payload: Record<string, unknown> = { model, prompt }
    if (acceptsSizeQuality) {
      if (size && size !== 'auto') payload.size = size
      if (quality) payload.quality = quality
      const cfg = this.getModelConfig(model)
      if (cfg?.defaultParams?.output_format) {
        payload.output_format = cfg.defaultParams.output_format
      }
      // 注意: vip 默认走 b64_json (apiyi 文档虽支持 "url", 但实测国内访问不了
      // CDN 返回的 URL —— 用户已验证过), 单张几 MB base64 的主线程开销留待
      // 渲染端优化 (Blob URL / Worker 解码), 不在 API 参数上做手脚。
    } else {
      payload.response_format = 'b64_json'
    }
    // 腾讯 image2 去水印：文生图(generations)此前漏发 extra_body，导致右下角带
    // logo 水印（edit 的 JSON 路径已带）。仅腾讯渠道注入——官转/vip 是 apiyi/OpenAI
    // 兼容端点，logo_add 是腾讯网关私有参数，不应外发。
    if (this.isTencentImage2(model)) {
      payload.extra_body = { logo_add: 0 }
    }
    return payload
  }

  /**
   * 共用尺寸解析：通过 modelConfig.resolutionMap[ratio][resolution] 解析像素 size。
   * gpt-image-2（官转）与 gpt-image-2-vip（官逆）共用同一套 30 档 size 体系，
   * 故抽出为统一函数，避免两条通道各写一份。
   * - 内部存储允许 Unicode "×"，发到 API 时统一转成 ASCII "x"（OpenAI size 约定）。
   * - 比例为 'auto' 或落到 '自适应' 时返回 undefined（不发 size，由后端自决）。
   */
  private resolveImageSizeFromMap(
    modelConfig: ModelConfig | undefined,
    ratio?: string,
    resolution?: string,
  ): string | undefined {
    if (!ratio || ratio === 'auto') return undefined
    const map = modelConfig?.resolutionMap
    if (!map || !map[ratio]) return undefined
    const resKey = resolution || modelConfig?.defaultResolution || '1K'
    const cell = map[ratio][resKey]
    if (!cell) return undefined
    if (cell === '自适应' || cell === 'auto') return undefined
    return cell.replace('×', 'x')
  }

  /**
   * @deprecated 向后兼容别名，委托给共用的 resolveImageSizeFromMap。
   * 现有 vip 测试仍按此名调用，保留以免破坏。
   */
  private resolveGptImage2VipSize(
    modelConfig: ModelConfig | undefined,
    ratio?: string,
    resolution?: string,
  ): string | undefined {
    return this.resolveImageSizeFromMap(modelConfig, ratio, resolution)
  }

  /**
   * 是否为「支持 size + quality 三参数」的 Images 模型：
   * gpt-image-2（官转）、gpt-image-2-vip（官逆）、custom-imagemodel-gt（腾讯 image2，同规格复用）。
   * gpt-image-2-all（官逆）不在内 —— 它把尺寸写进 prompt，回 b64_json。
   */
  private isSizeQualityImageModel(model: string): boolean {
    return model === 'gpt-image-2' || model === 'gpt-image-2-vip' || this.isTencentImage2(model)
  }

  /**
   * 是否为腾讯 image2 渠道(custom-imagemodel-gt)。
   * 该网关需要 `extra_body.logo_add:0` 才能关掉右下角水印，且这是腾讯私有参数——
   * 官转 / vip(apiyi/OpenAI 兼容端点)不能外发。统一在此判定，三条请求路径
   * (文生图 generations / JSON edit / FormData edit)共用，避免再漏。
   */
  private isTencentImage2(model: string): boolean {
    return TENCENT_IMAGE_MODELS.has(model)
  }

  /**
   * gpt-image-2 官转：独立的「清晰度 quality」参数（auto/low/medium/high）。
   * auto / 空 / 非法值都返回 undefined（不发 quality，由模型按默认处理）。
   */
  private resolveGptImage2Quality(quality?: string): string | undefined {
    if (!quality || quality === 'auto') return undefined
    if (['low', 'medium', 'high'].includes(quality)) return quality
    return undefined
  }

  /**
   * 腾讯 image2(custom-imagemodel-gt) 图片编辑：JSON `images:[url]` 请求。
   * - 该网关 edit 端点接受公网 URL 数组（无需 base64 multipart）；
   * - logo_add:0 关闭水印，与全局 watermark:false 对齐；
   * - 响应解析复用 extractImagesFromApiResponse（url / b64_json 都吃）。
   */
  private async makeTencentImage2JsonEdit(
    url: string,
    model: string,
    prompt: string,
    imageSources: string[],
    site: ApiSite,
    apiKey: string,
    userSignal?: AbortSignal,
    timeoutMs = 2_000_000,
    size?: string,
    quality?: string,
  ): Promise<Response> {
    // 官方文档(GPT-Maas)：images 类型是 `Array of ImageRef`，线格式为对象数组
    // `[{ image_url: "<url 或 base64 编码数据>" }]`（见官方 curl 示例）。image_url 字段
    // 同时接受 http(s) URL 与 data-URI base64，二者等价。这里统一把每个归一化后的
    // 参考图(URL 或 data URI)包成 ImageRef 对象，URL 与 base64 走同一形态。
    const body: Record<string, unknown> = {
      model,
      prompt,
      images: imageSources.map((image_url) => ({ image_url })),
      n: 1,
    }
    if (size && size !== 'auto') body.size = size
    if (quality) body.quality = quality
    if (this.isTencentImage2(model)) body.extra_body = { logo_add: 0 }

    this.logImageRequest(model, url, body)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    this.applyAuthHeaders(headers, site, apiKey, url)

    const signal = this.composeTimeoutSignal(userSignal, timeoutMs)
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok) {
      let errText = ''
      try {
        errText = await resp.clone().text()
      } catch {
        /* body 不可读时忽略 */
      }
      console.error(
        `[ImageReq:${model}] edits(JSON) ${resp.status} 失败 (size=${size ?? 'auto'}, imgs=${imageSources.length}):`,
        errText.slice(0, 4000),
      )
    }
    return resp
  }

  /**
   * gpt-image-2 系列：图片编辑 FormData 请求（有参考图）
   * - gpt-image-2 (官转)：额外支持 size/quality
   * - gpt-image-2-vip (Codex 官逆)：支持 size/quality（2026-06-05 实测 quality 生效）
   * - gpt-image-2-all (官逆)：均不支持，回 b64_json
   * 三档统一超时约 2000s（~33 分钟，基本不设超时），见上游调用点。
   */
  private async makeGptImage2FormDataRequest(
    url: string,
    model: string,
    prompt: string,
    imageSources: string[],
    site: ApiSite,
    apiKey: string,
    userSignal?: AbortSignal,
    timeoutMs = 2_000_000,
    size?: string,
    quality?: string,
  ): Promise<Response> {
    const acceptsSize = this.isSizeQualityImageModel(model)
    const formData = new FormData()
    formData.append('model', model)
    formData.append('prompt', prompt)
    if (!acceptsSize) formData.append('response_format', 'b64_json')
    // 不给 vip 显式设 response_format —— 走 apiyi 默认的 b64_json。
    // 文档虽支持 url, 但实测返回的 URL 在国内访问不了, 留 b64_json 才能保证图片能展示。
    if (acceptsSize && size && size !== 'auto') formData.append('size', size)
    if (acceptsSize && quality) formData.append('quality', quality)
    // 腾讯 image2 去水印：multipart edit(data: 参考图回落路径)同样要带 extra_body，
    // 否则这条回落路径产出的编辑图右下角仍有 logo。以 JSON 字符串字段下发，与 JSON
    // 路径的嵌套 extra_body 结构对齐。
    if (this.isTencentImage2(model)) {
      formData.append('extra_body', JSON.stringify({ logo_add: 0 }))
    }

    let appendedCount = 0
    for (let i = 0; i < imageSources.length; i++) {
      const blob = await this.convertToBlob(imageSources[i], i)
      if (blob) {
        formData.append('image[]', blob, `image${i}.png`)
        appendedCount++
      }
    }

    if (appendedCount === 0) {
      throw new Error(`参考图转换失败：${imageSources.length} 张图片均无法转为 Blob，请检查图片格式（支持 png/jpg/webp）`)
    }

    const headers: Record<string, string> = {}
    this.applyAuthHeaders(headers, site, apiKey, url)

    // FormData 不是 JSON：打印结构化摘要(含参考图源)到 F12，标注 multipart。
    this.logImageRequest(model, url, {
      model,
      prompt,
      size: size ?? 'auto',
      quality,
      ...(this.isTencentImage2(model) ? { extra_body: { logo_add: 0 } } : {}),
      'image[]': `${appendedCount} blob (multipart/form-data)`,
      sources: imageSources,
    })

    const signal = this.composeTimeoutSignal(userSignal, timeoutMs)

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    })
    // 失败时把服务端响应体打出来 —— 500/400 不带 body 无从诊断。
    // (与上面 generations 分支的错误日志对齐。)
    if (!resp.ok) {
      let errText = ''
      try {
        errText = await resp.clone().text()
      } catch {
        /* body 不可读时忽略 */
      }
      console.error(
        `[GPT-Image-2] edits ${resp.status} 失败 (model=${model}, size=${size ?? 'auto'}, imgs=${appendedCount}):`,
        errText.slice(0, 4000),
      )
    }
    return resp
  }

  /**
   * 将图片源转换为 Blob
   */
  private async convertToBlob(source: string | any, index?: number): Promise<Blob | null> {
    const tag = index !== undefined ? `[图${index + 1}]` : ''
    try {
      const normalized = this.normalizeImageSource(source)
      if (!normalized) {
        console.warn(`convertToBlob${tag}: 无法标准化图片源`)
        return null
      }

      if (normalized.startsWith('data:image/')) {
        const resp = await fetch(normalized)
        return resp.blob()
      }
      
      if (normalized.startsWith('http')) {
        const response = await fetch(normalized, { mode: 'cors' })
        if (!response.ok) {
          console.warn(`convertToBlob${tag}: HTTP ${response.status} — ${normalized.substring(0, 80)}`)
          return null
        }
        return response.blob()
      }

      console.warn(`convertToBlob${tag}: 不支持的源类型 — ${normalized.substring(0, 30)}`)
      return null
    } catch (error) {
      console.error(`convertToBlob${tag}: 转换失败:`, error)
      return null
    }
  }

  /** 从 URL 后缀猜图片 mime;Gemini file_data.mime_type 必填,猜不到兜底 jpeg。 */
  private guessImageMimeFromUrl(url: string, fallback = 'image/jpeg'): string {
    const lower = url.split('?')[0]?.toLowerCase() ?? ''
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.gif')) return 'image/gif'
    if (lower.endsWith('.avif')) return 'image/avif'
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic'
    return fallback
  }

  /** Blob → dataURL(base64),给只吃 base64 的端点用。 */
  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    })
  }

  /**
   * 把参考图里的 http(s) URL 预解析成 data URL(base64)。
   *
   * 为什么需要:本地上传现在原图直传 COS、只存 URL。但 Gemini 原生端点
   * (inline_data)和 OpenAI `/images/generations` 的 `image` 字段都只认
   * base64/data URL,不会自动抓取远端 URL —— 不预解析就会被静默丢弃,
   * 等于"垫了图却没生效"。multipart 路径(gpt-image-2 / Flux)用
   * convertToBlob 自己抓取,不需要走这里。
   *
   * 抓取失败时保留原 URL(对能直接吃 URL 的端点无害;Gemini 会丢弃,
   * 但这已是抓取彻底失败的兜底)。
   */
  private async resolveSourcesToDataUrls(sources?: string[]): Promise<string[] | undefined> {
    if (!sources || sources.length === 0) return sources
    const out: string[] = []
    for (const s of sources) {
      if (typeof s === 'string' && /^https?:\/\//i.test(s)) {
        const blob = await this.convertToBlob(s)
        if (blob) {
          try {
            out.push(await this.blobToDataUrl(blob))
            continue
          } catch (e) {
            console.warn('[resolveSourcesToDataUrls] blob→dataURL 失败,保留原 URL:', e)
          }
        }
        out.push(s)
      } else {
        out.push(s)
      }
    }
    return out
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    negativePrompt?: string
    seed?: number
    count?: number
    modelConfig: ModelConfig
    layerDecomposition?: boolean
  }): any {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, negativePrompt, seed, count, modelConfig, layerDecomposition } = options

    // Gemini Native 格式
    if (modelConfig.apiType === 'gemini-native') {
      return this.buildGeminiNativePayload({
        prompt,
        ratio,
        resolution,
        referenceImages,
        imageBase64,
        modelConfig
      })
    }

    // Flux Kontext 格式
    if (modelConfig.apiType === 'flux-kontext') {
      return this.buildFluxPayload({
        prompt,
        model,
        ratio,
        referenceImages,
        imageBase64,
        modelConfig
      })
    }

    // OpenAI 兼容格式 (万相经 newapi /v1/images/generations、seedream、sora_image 等)
    return this.buildOpenAIPayload({
      prompt,
      model,
      ratio,
      resolution,
      referenceImages,
      imageBase64,
      negativePrompt,
      seed,
      count,
      modelConfig,
      layerDecomposition
    })
  }

  /**
   * 构建 Gemini Native 请求体
   */
  private buildGeminiNativePayload(options: {
    prompt: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, ratio, resolution, referenceImages, imageBase64, modelConfig } = options

    const parts: any[] = [{ text: `${modelConfig.internalPrompt || ''}${prompt}` }]

    // 添加编辑图片或参考图
    const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
    for (const img of imageSources) {
      const normalized = this.normalizeImageSource(img)
      if (!normalized) continue
      if (normalized.startsWith('data:image/')) {
        // base64 内联
        const match = normalized.match(/^data:(image\/[^;]+);base64,(.+)$/)
        if (match) {
          parts.push({
            inline_data: {
              mime_type: match[1],
              data: match[2]
            }
          })
        }
      } else if (/^https?:\/\//i.test(normalized)) {
        // URL 直传:Gemini generateContent 的 file_data.file_uri。
        // 省去渲染端 fetch→base64,直接把 COS/远端图链接交给上游抓取。
        parts.push({
          file_data: {
            mime_type: this.guessImageMimeFromUrl(normalized),
            file_uri: normalized
          }
        })
      }
    }

    const imageConfig: any = {}
    
    // 只有非自适应模式才传递 aspectRatio
    if (ratio && ratio !== 'auto') {
      imageConfig.aspectRatio = ratio
    }

    // 只有支持分辨率控制的模型才传递 imageSize
    if (modelConfig.capabilities?.aspectRatioControl && resolution) {
      imageConfig.imageSize = resolution
    }

    return {
      contents: [{
        role: 'user',
        parts
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig
      }
    }
  }

  /**
   * 构建 Flux Kontext 请求体
   */
  private buildFluxPayload(options: {
    prompt: string
    model: string
    ratio?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, ratio, referenceImages, imageBase64 } = options
    const hasImages = (referenceImages && referenceImages.length > 0) || imageBase64

    // 标记需要 FormData 处理
    if (hasImages) {
      return {
        __isFluxKontextWithImage: true,
        model,
        prompt,
        ratio,
        referenceImages,
        imageBase64
      }
    }

    // 纯文本生成使用 JSON 格式
    return {
      model,
      prompt,
      n: 1,
      aspect_ratio: ratio,
      safety_tolerance: 6,  // 最宽松的内容审核级别
      response_format: 'url'
    }
  }

  /**
   * 万相 size 参数：非 1:1 文生图用像素控制比例；其余用 1K/2K/4K 档位（官方推荐）。
   * 组图/有参考图时 4K 自动降为 2K。
   */
  private resolveDashScopeImageSize(
    modelConfig: ModelConfig,
    ratio: string | undefined,
    resolution: string | undefined,
    isSequentialGroup: boolean,
    hasImageInput: boolean,
  ): string {
    let effectiveResolution = resolution || modelConfig.defaultResolution || '2K'
    if (modelConfig.capabilities?.sequentialGroup && effectiveResolution === '4K' &&
        (isSequentialGroup || hasImageInput)) {
      effectiveResolution = '2K'
    }

    const normalizedRatio = ratio || '1:1'
    if (normalizedRatio !== '1:1' && !hasImageInput) {
      const pixelSize = this.resolveImageSizeFromMap(modelConfig, normalizedRatio, effectiveResolution)
      if (pixelSize) return pixelSize
    }

    return effectiveResolution
  }

  private buildOpenAIPayload(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    negativePrompt?: string
    seed?: number
    count?: number
    modelConfig: ModelConfig
    layerDecomposition?: boolean
  }): any {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, negativePrompt, seed, count, modelConfig, layerDecomposition } = options

    // 检查是否是图片生成 API 格式
    if (modelConfig.baseURL?.includes('/images/generations')) {
      if (layerDecomposition) {
        return this.buildLayerDecompositionPayload({
          prompt,
          model,
          resolution,
          referenceImages,
          imageBase64,
          modelConfig,
        })
      }

      // 出图张数：UI 数量选择器 → n，按模型 maxOutputs 收敛到 [1, maxOutputs]
      const maxOutputs = modelConfig.capabilities?.maxOutputs ?? 1
      const requested = Math.max(1, Math.floor(count ?? 1))
      const rawN = Math.min(requested, Math.max(1, maxOutputs))

      const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
      const isEditOrImageInput = imageSources.length > 0
      const isWanModel = !!modelConfig.capabilities?.sequentialGroup

      // 万相：n>1 必须 enable_sequential（组图，上限 12）；否则 n 最多 4
      const isSequentialGroup = isWanModel && rawN > 1
      const n = isSequentialGroup ? Math.min(rawN, 12) : (isWanModel ? Math.min(rawN, 4) : rawN)

      const payload: any = {
        model,
        prompt,
        n
      }

      const size = isWanModel
        ? this.resolveDashScopeImageSize(modelConfig, ratio, resolution, isSequentialGroup, isEditOrImageInput)
        : (this.getImageSize(modelConfig, ratio, resolution) ?? undefined)
      if (size) {
        payload.size = size
      }

      // DashScope 原生形态（万相与千问共用）。这里**不能**继续用 isWanModel 判定 ——
      // 「参考图走 input.messages」与「支持组图」是两件事，耦合在一起会让千问这种
      // 有参考图但无组图的模型掉进顶层 `image` 分支被网关丢弃（见 dashscopeNativeInput）。
      const usesDashscopeInput = isWanModel || !!modelConfig.capabilities?.dashscopeNativeInput

      if (usesDashscopeInput) {
        payload.response_format = modelConfig.defaultParams?.response_format ?? 'url'
        payload.watermark = modelConfig.defaultParams?.watermark ?? false

        // new-api ali 通道从 Extra["parameters"] / Extra["input"] 透传 DashScope 原生字段。
        // 注意：一旦出现 parameters，顶层 n/size/watermark 就**不再**被网关合并进去
        // （接入说明 §9），所以要用的键必须写在这里面。
        const parameters: Record<string, unknown> = {
          n,
          watermark: modelConfig.defaultParams?.watermark ?? false,
        }
        if (size) {
          parameters.size = size.includes('x') ? size.replace(/x/g, '*') : size
        }
        if (isSequentialGroup) {
          parameters.enable_sequential = true
        } else if (isWanModel && !isEditOrImageInput) {
          // thinking_mode 是万相那条路验过的；千问未验证，不擅自发。
          parameters.thinking_mode = modelConfig.defaultParams?.thinking_mode ?? true
        }
        if (typeof modelConfig.defaultParams?.prompt_extend === 'boolean') {
          parameters.prompt_extend = modelConfig.defaultParams.prompt_extend
        }
        // seed 在网关转发白名单里，真能生效（官方取值 [0, 2147483647]）。
        if (typeof seed === 'number' && Number.isFinite(seed) && seed >= 0) {
          parameters.seed = Math.min(2147483647, Math.floor(seed))
        }
        // negative_prompt 上游支持，但**当前经 Miau 到不了**：网关的
        // AliImageParameters 没有这个键，反序列化即丢弃（接入说明 §3.2）。照发不误 ——
        // 网关补上白名单那天自动生效，不必再发版；在此之前 UI 不该承诺它有效。
        if (typeof negativePrompt === 'string' && negativePrompt.trim()) {
          parameters.negative_prompt = negativePrompt.trim()
        }
        payload.parameters = parameters

        // 官方 wan2.7 / 千问都要求 input.messages；new-api 不会把顶层 image 转成 messages。
        //
        // 超过模型上限**报错，不截断**（千问 I2I 只收 1-3 张，多了上游 400）。这里
        // 曾经是 slice(0, cap) 静默丢弃：请求会成功、图会出来，但用户挑的第 4、5 张
        // 参考图从头到尾没参与，而且没有任何迹象——这正是「传了参考图但模型没看」
        // 那类最难查的问题。参考图的位置就是身份（图 N 绑定角色 N），少一张不是
        // 「少一点参考」，是后面所有绑定整体错位。
        const refCap = modelConfig.capabilities?.maxReferenceImages
        if (typeof refCap === 'number' && imageSources.length > refCap) {
          throw new Error(
            `${modelConfig.displayName || model} 最多支持 ${refCap} 张参考图，当前传了 ` +
            `${imageSources.length} 张。请删到 ${refCap} 张以内，或换用支持更多参考图的渠道` +
            `（如 Seedream 5.0 Pro 支持 10 张）。`,
          )
        }
        const contentParts: Array<{ text?: string; image?: string }> = []
        for (const img of imageSources) {
          contentParts.push({ image: img })
        }
        contentParts.push({ text: prompt })
        payload.input = {
          messages: [{
            role: 'user',
            content: imageSources.length > 0 ? contentParts : [{ text: prompt }],
          }],
        }
      } else if (imageSources.length > 0) {
        payload.image = imageSources[0]
        if (imageSources.length > 1) {
          payload.images = imageSources
        }
      }

      return payload
    }

    // Chat Completions 格式 (sora_image)
    const content: any[] = [{ type: 'text', text: prompt }]
    
    const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
    for (const img of imageSources) {
      content.push({
        type: 'image_url',
        image_url: { url: img }
      })
    }

    return {
      model,
      messages: [{
        role: 'user',
        content: imageSources.length > 0 ? content : prompt
      }]
    }
  }

  /**
   * 构建图层拆分请求体（Ark `layer_decomposition`，当前仅 Seedream 5.0 Pro）。
   *
   * 挂在与普通生图相同的 images/generations 端点上，靠这个开关区分：带开关回
   * 1 张底图 + 最多 16 张透明 PNG 图层（逐项带 z_index / bounding_box / name /
   * description），不带就是普通生图。与普通生图构体的四处差异都是官方硬约束：
   *
   *  - **不发 `n`**：张数由上游按图内容决定，UI 的数量选择器在此模式下无意义；
   *  - **`size` 只收档位**（见 LAYER_DECOMPOSITION_SIZE_TIERS），不能发 `宽x高` 像素串
   *    —— 发了会把拆出来的底图强行改成 UI 里选的比例，与图层坐标系错位；
   *  - **只发单张 `image`**，不发 `images`；
   *  - **`prompt` 可缺席**：空即自动全拆。空串必须整个字段删掉而不是发 `prompt: ''`
   *    —— 上游把空串当成一个有效（但无意义）的提示词。
   *
   * `response_format` 固定 url：一次最多 17 张 2K 图，b64_json 会把它们塞进同一个
   * JSON 响应体，在渲染进程里就是几百 MB 的瞬时峰值。
   */
  private buildLayerDecompositionPayload(options: {
    prompt: string
    model: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, resolution, referenceImages, imageBase64, modelConfig } = options

    const payload: any = {
      model,
      layer_decomposition: true,
      size: resolveLayerDecompositionSizeTier(resolution),
      watermark: modelConfig.defaultParams?.watermark ?? false,
      response_format: 'url',
      output_format: 'png',
    }

    const source = imageBase64 || referenceImages?.[0]
    if (source) {
      payload.image = this.normalizeImageSource(source) ?? source
    }

    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (trimmedPrompt) {
      payload.prompt = trimmedPrompt
    }

    return payload
  }

  /**
   * 获取图片尺寸
   *
   * 优先读模型自己的 resolutionMap(resolveImageSizeFromMap 已做 ×→x 归一化):
   * Seedream 5.0 Pro 等模型的像素档位与下方通用表不同(1K 边长更小)且含 4:5/5:4,
   * 必须按各自文档映射。查不到(模型没配表 / 比例缺档)再回落通用硬编码表,
   * 保持 SeeDream 4.5、万相等既有模型行为不变。
   */
  private getImageSize(modelConfig: ModelConfig, ratio?: string, resolution?: string): string | null {
    const fromModelMap = this.resolveImageSizeFromMap(modelConfig, ratio, resolution)
    if (fromModelMap) return fromModelMap

    // 模型配了自己的映射表、比例有档但请求的分辨率档缺失(如 5.0 Pro 无 4K、
    // SeeDream 4.5 无 1K):收敛到模型 defaultResolution,绝不回落通用表——
    // 通用表会给出模型根本不支持的档位像素,直接把无效 size 发给上游。
    if (ratio && ratio !== 'auto' && modelConfig.resolutionMap?.[ratio]) {
      const clamped = this.resolveImageSizeFromMap(modelConfig, ratio, undefined)
      if (clamped) return clamped
    }

    // 预定义尺寸映射
    const sizeMap: Record<string, Record<string, string>> = {
      '1:1': { '2K': '2048x2048', '4K': '4096x4096', '1K': '1024x1024' },
      '4:3': { '2K': '2304x1728', '4K': '4608x3456', '1K': '1200x896' },
      '3:4': { '2K': '1728x2304', '4K': '3456x4608', '1K': '896x1200' },
      '16:9': { '2K': '2560x1440', '4K': '5120x2880', '1K': '1376x768' },
      '9:16': { '2K': '1440x2560', '4K': '2880x5120', '1K': '768x1376' },
      '3:2': { '2K': '2496x1664', '4K': '4992x3328', '1K': '1264x848' },
      '2:3': { '2K': '1664x2496', '4K': '3328x4992', '1K': '848x1264' },
      '21:9': { '2K': '3024x1296', '4K': '6048x2592', '1K': '1584x672' }
    }

    const normalizedRatio = ratio || '1:1'
    const useResolution = resolution || '2K'

    return sizeMap[normalizedRatio]?.[useResolution] || sizeMap['1:1']?.[useResolution] || null
  }

  /**
   * 标准化图片源
   */
  private normalizeImageSource(source: string | any, fallbackMime = 'image/jpeg'): string | null {
    if (!source) return null

    if (typeof source === 'string') {
      const trimmed = source.trim()
      if (!trimmed) return null
      
      // URL
      if (/^https?:\/\//i.test(trimmed)) return trimmed
      
      // 已经是 data URL
      if (trimmed.toLowerCase().startsWith('data:image/')) return trimmed
      
      // 纯 base64
      return `data:${fallbackMime};base64,${trimmed}`
    }

    // 对象格式
    if (typeof source === 'object') {
      if (source.dataUrl) return this.normalizeImageSource(source.dataUrl, source.mimeType || fallbackMime)
      if (source.url) return this.normalizeImageSource(source.url, source.mimeType || fallbackMime)
      if (source.base64) {
        const base64 = source.base64.trim()
        if (base64.toLowerCase().startsWith('data:image/')) return base64
        return `data:${source.mimeType || fallbackMime};base64,${base64}`
      }
    }

    return null
  }

  /**
   * 解析响应
   */
  private async parseResponse(
    response: Response,
    _modelConfig: ModelConfig,
    layerDecomposition = false,
  ): Promise<GenerateResult> {
    // 先读 text，再自己 JSON.parse —— 不要直接 response.json()。
    // 网关限流 / 5xx / 被劫持时常返回 HTML 错误页或空体，response.json() 会抛
    // "Unexpected token '<'" 这类无意义错误，把真实根因(上游 body)吞掉，
    // 导致「报错显示不完全」。这里把原始 body 完整保留并回传。
    const rawText = await response.text().catch(() => '')
    const bodySnippet = rawText
      ? rawText.replace(/\s+/g, ' ').trim().slice(0, 600)
      : '(空响应体)'

    let data: any = null
    let parseFailed = false
    if (rawText.trim()) {
      try {
        data = JSON.parse(rawText)
      } catch {
        parseFailed = true
      }
    } else {
      parseFailed = true
    }

    if (!response.ok) {
      // OpenAI 形态 data.error.message；DashScope 原生形态顶层 code/message
      const apiMsg = data?.error?.message || (data?.code ? `${data.code}: ${data.message}` : data?.message)
      let friendlyMsg: string
      switch (response.status) {
        case 401: friendlyMsg = 'API Key 无效或已过期'; break
        case 402: friendlyMsg = '账户余额不足，请充值后重试'; break
        case 429: friendlyMsg = (apiMsg?.includes('insufficient') || apiMsg?.includes('额度'))
          ? '账户额度不足，请充值后重试'
          : '请求过于频繁，请稍后重试'; break
        case 500: friendlyMsg = '服务端内部错误，请稍后重试'; break
        default: friendlyMsg = apiMsg || `API 错误: ${response.status}`
      }
      // 把真实细节附在友好提示后面：优先结构化 apiMsg，否则原始 body 片段。
      // 这样用户既看到可读提示，又能看到上游到底回了什么(排障关键)。
      const detail = apiMsg || (parseFailed ? bodySnippet : '')
      const fullError = detail && !friendlyMsg.includes(detail)
        ? `${friendlyMsg}（HTTP ${response.status}：${detail}）`
        : `${friendlyMsg}（HTTP ${response.status}）`
      console.error(`[ApiService] parseResponse 非 OK ${response.status} @ ${response.url}:`, fullError, '\n原始 body:', bodySnippet)
      return { success: false, error: fullError, rawResponse: data ?? rawText }
    }

    // HTTP 200 但 body 不是合法 JSON（网关错误页 / 空体 / 被中间层劫持）
    if (parseFailed) {
      const err = rawText.trim()
        ? `服务器返回了非 JSON 响应（可能是网关错误页或限流），请稍后重试或更换模型。响应片段：${bodySnippet}`
        : '服务器返回了空响应（HTTP 200 但无内容），请稍后重试或更换模型'
      console.error('[ApiService] parseResponse 非 JSON 200 响应:', err)
      return { success: false, error: err, rawResponse: rawText }
    }

    const dashScopeError = getDashScopeErrorMessage(data)
    if (dashScopeError) {
      console.error('[ApiService] API 在 200 body 内返回错误:', dashScopeError)
      return { success: false, error: dashScopeError, rawResponse: data }
    }

    const images = extractImagesFromApiResponse(data)

    if (images.length === 0) {
      const raw = JSON.stringify(data).slice(0, 2000)
      console.error('[ApiService] 响应未含图片，原始 body:', raw)
      return {
        success: false,
        // 把原始 body 片段带上，避免「未能从响应中提取图片」这种无信息提示
        error: `未能从响应中提取图片，响应片段：${raw.slice(0, 600)}`,
        rawResponse: data
      }
    }

    // 图层拆分：把 z_index / bounding_box / name / description 一并带出来。上游偶尔
    // 会在拆不动时退化成一张普通图（没有 z_index），此时 layers 为空——按普通结果返回，
    // 不报错：图是真出来了，只是没有图层栈。
    if (layerDecomposition) {
      const layers = extractLayersFromApiResponse(data)
      if (layers.length > 0) {
        // 用 layers 的顺序覆盖 images：extractImagesFromApiResponse 按 data[] 原序返回，
        // 而叠放顺序只有 z_index 说得准，底图必须在第一位。
        const ordered = layers.map(layer => layer.url)
        return { success: true, images: ordered, urls: ordered, layers }
      }
    }

    // P0 闪退修复(2026-07-09): 成功分支不再回带 rawResponse。base64 直出模型
    // (nano2 4K 等)的 data 里内嵌全部图片 base64(单张 10-40MB), 挂在结果对象
    // 上会随调用方生命周期多活一整份, 是渲染进程瞬时峰值的放大器。全仓只有
    // 错误路径(ErrorHandler 技术详情)消费 rawResponse, 成功路径无人读。
    return {
      success: true,
      images,
      urls: images  // 兼容旧 API 格式
    }
  }

  /**
   * 切换站点
   */
  setSite(siteKey: string): boolean {
    if (!this.apiSites[siteKey]) {
      return false
    }
    this.currentSite = siteKey
    this.saveStoredSite(siteKey)
    this.apiKey = this.getStoredApiKey(siteKey)
    return true
  }

  /**
   * 测试 API 连接
   * @param apiKey - 要测试的 API Key
   * @returns true if the API responds successfully
   */
  async testConnection(apiKey: string): Promise<boolean> {
    const site = this.apiSites[this.currentSite]
    if (!site) return false

    try {
      const response = await fetch(`${site.baseURL}/v1/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * 切换模型
   */
  setModel(modelKey: string): boolean {
    const resolved = this.resolveModelKey(modelKey)
    if (!this.models[resolved]) {
      return false
    }
    // 幂等守卫:已是当前模型就不再持久化/派发。这同时切断
    // useModelStore.switchModel → setModel → model-changed → switchModel
    // 的潜在回环(第二趟进来 resolved === currentModel,直接返回)。
    if (resolved === this.currentModel) {
      return true
    }
    this.currentModel = resolved
    this.saveStoredModel(resolved)
    window.dispatchEvent(new CustomEvent('model-changed', { detail: { modelKey: resolved } }))
    return true
  }

  private resolveModelKey(key: string): string {
    return normalizeModelKey(key)
  }

  /**
   * 获取当前模型 key
   */
  getModelKey(): string {
    return this.resolveModelKey(this.currentModel)
  }

  /**
   * 保存 API Key
   */
  saveApiKey(key: string): boolean {
    try {
      this.apiKey = key
      localStorage.setItem(`api_key_${this.currentSite}`, key)
      if (this.currentSite === 'antigravity') this.syncMiauTokenToMain()
      if (this.currentSite === 'apiyi' || this.currentSite === 'b-apiyi')
        void this.syncApiyiKeyToMcp()
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取当前模型
   */
  getCurrentModel(): ModelConfig | undefined {
    return this.models[this.resolveModelKey(this.currentModel)]
  }

  /**
   * 按 key 获取模型配置（UI 层用于读取 capabilities）
   */
  getModelConfig(key: string): ModelConfig | undefined {
    return this.models[this.resolveModelKey(key)]
  }

  /**
   * 获取所有模型
   */
  getAllModels(): Record<string, ModelConfig> {
    return { ...this.models }
  }

  /**
   * 获取当前站点
   */
  getCurrentSite(): ApiSite | undefined {
    return this.apiSites[this.currentSite]
  }

  /**
   * 获取所有站点
   */
  getAllSites(): Record<string, ApiSite> {
    return { ...this.apiSites }
  }

  getLocalPort(): string {
    return localStorage.getItem('ai_image_local_port') || '3000'
  }

  setLocalPort(port: string): void {
    localStorage.setItem('ai_image_local_port', port)
    this.apiSites['local'].baseURL = `http://127.0.0.1:${port}`
  }

  // 存储相关方法
  private getStoredSite(): string | null {
    return localStorage.getItem('current_site')
  }

  private saveStoredSite(site: string): void {
    localStorage.setItem('current_site', site)
  }

  private getStoredModel(): string | null {
    const stored = localStorage.getItem('current_model')
    return stored ? this.resolveModelKey(stored) : stored
  }

  private saveStoredModel(model: string): void {
    localStorage.setItem('current_model', model)
  }

  /**
   * 获取存储的 API Key（公开方法）
   */
  getStoredApiKey(site?: string): string | null {
    return localStorage.getItem(`api_key_${site || this.currentSite}`)
  }

  /**
   * 获取存储的 Vision API Key（公开方法）
   */
  getStoredVisionApiKey(site?: string): string | null {
    return localStorage.getItem(`vision_api_key_${site || this.currentSite}`)
  }

  /**
   * qwen 多模态理解（视频/文档/联网扒资料）。默认 `qwen3.7-plus-dashscope`(更便宜),
   * `qwen3.7-max-dashscope` 作为更强 + 兜底备选。
   *
   * 复用出图同一条链路:经 new-api(antigravity 站点)网关
   * /v1/chat/completions,Bearer = Miau 令牌。网关已做 OpenAI→DashScope 转换,
   * 客户端只发标准 OpenAI content parts;多模态请求不带 result_format(手册 §2)。
   * 联网用顶层 enable_search:true。
   *
   * 模型选择:`opts.model`('max' / 'plus' / 全名)显式指定,非法值回落默认 plus。
   * 兜底:primary(默认 plus)在同模型重试耗尽后仍失败,且 primary≠max 且未禁用
   * 兜底时,自动用 max 再跑一轮(plus 偶发对个别请求不稳时由更强的 max 救场)。
   *
   * 健壮解析:先 text() 再 try-parse,502/503/504 与非 JSON 返回都映射成
   * 结构化中文错误而非抛异常,避免重蹈 parseResponse「先 json 后判 ok」的坑。
   * 音频:qwen 上游不收 audio,音频走 skill 指导的 ffmpeg→MP4→understand_video。
   */
  async understand(
    input: UnderstandInput,
    opts: { retries?: number; retryDelayMs?: number; model?: string; fallback?: boolean } = {},
  ): Promise<{ success: true; text: string } | { success: false; error: string }> {
    const site = this.apiSites['antigravity']
    const key = this.getStoredApiKey('antigravity') || this.getStoredVisionApiKey('antigravity')
    // 平台余额模式下没有自填 Key 是正常的 —— 凭据在主进程。这道门原先无条件拦,
    // 于是 understand_video / understand_document / web_research 这三个 MCP 工具
    // 在平台模式下一律报「未配置 Miau API 令牌」,而用户明明已经登录并选好了计费池。
    // 判据用请求 URL 的 host(与 `applyAuthHeaders` 内部同一个),不是站点键。
    if (!key && !this.shouldUsePlatformBilling(`${site.baseURL}/v1/chat/completions`)) {
      return { success: false, error: '未配置 Miau API 令牌,请到设置页填入 API Key 后重试。' }
    }
    // 走到这里 `key` 可能是 null(平台模式放行的那一支),而下游签名要 `string`。
    // 归一成空串,**不放宽下游签名** —— 放宽会让每个下游都得重新判断「null 是什么
    // 意思」,而这里只有一种含义:`applyAuthHeaders` 会走平台分支打标记,根本不读它。
    // 与 `generateImage` 里 `resolvedApiKey` 同一个处理。
    const resolvedKey = key ?? ''

    const content: unknown =
      input.kind === 'web'
        ? input.query
        : [
            { type: 'text', text: input.question },
            ...(input.kind === 'video'
              // `fps` 是 video_url 的**同级**字段,不在它里面(官方 curl 示例如此)。
              // 之前它只在类型上存在、组包时被丢掉,等于永远走上游默认 2.0。
              ? [{
                  type: 'video_url',
                  video_url: { url: input.mediaUrl },
                  ...(typeof input.fps === 'number' ? { fps: input.fps } : {}),
                }]
              // 多图并列在同一条 message 里 —— 上游把它们当成一组来看,跨图比较
              // (同一角色在不同镜头里是否一致、多页文档前后呼应)才成立;
              // 拆成多次调用模型就看不到彼此了。
              : buildDocumentParts(
                  dedupePreservingOrder([input.mediaUrl, ...(input.mediaUrls ?? [])]),
                )),
          ]

    const baseBody: Record<string, unknown> = { messages: [{ role: 'user', content }] }
    if (input.kind === 'web') baseBody.enable_search = true

    const primary = resolveUnderstandModel(opts.model)
    const primaryRes = await this.understandWithModel(site, resolvedKey, baseBody, primary, opts)
    if (primaryRes.success) return primaryRes

    // 兜底:primary 不是 max 时(默认 plus / 显式 plus)用更强的 max 再跑一轮。可经
    // `fallback:false` 关闭(如调用方明确只想要 primary 的结果)。
    const allowFallback = opts.fallback !== false
    if (allowFallback && primary !== QWEN_UNDERSTAND_FALLBACK_MODEL) {
      const fb = await this.understandWithModel(
        site,
        resolvedKey,
        baseBody,
        QWEN_UNDERSTAND_FALLBACK_MODEL,
        opts,
      )
      if (fb.success) return fb
    }
    return primaryRes
  }

  /**
   * 对单个模型跑一轮带重试的 understand 请求。网关在较长的多模态/联网请求上偶发
   * 掐连接(实测 `SocketError: other side closed` / 502),这类瞬时传输故障自动
   * 重试即可恢复;4xx/非 JSON 属确定性错误,不重试。默认 2 次重试、退避 600ms*attempt。
   */
  private async understandWithModel(
    site: ApiSite,
    key: string,
    baseBody: Record<string, unknown>,
    model: string,
    opts: { retries?: number; retryDelayMs?: number },
  ): Promise<{ success: true; text: string } | { success: false; error: string }> {
    const body: Record<string, unknown> = { ...baseBody, model }
    const maxAttempts = Math.max(1, (opts.retries ?? 2) + 1)
    const retryDelayMs = opts.retryDelayMs ?? 600
    let lastError = 'qwen 理解请求失败。'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = await this.understandAttempt(site, key, body)
      if (r.kind === 'ok') return { success: true, text: r.text }
      lastError = r.error
      if (!r.retryable || attempt === maxAttempts) {
        return { success: false, error: r.error }
      }
      await new Promise((res) => setTimeout(res, retryDelayMs * attempt))
    }
    return { success: false, error: lastError }
  }

  /** 单次 understand 请求。瞬时错误(网络异常 / 502·503·504)标 retryable。 */
  private async understandAttempt(
    site: ApiSite,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'fail'; retryable: boolean; error: string }> {
    const url = `${site.baseURL}/v1/chat/completions`
    // 收 `site` 而不是裸 baseURL,就是为了能走这一步:平台模式打标记头(主进程换成
    // 影子 token + 计费归属),否则照旧发自填 Key。手写 Authorization 的后果是
    // understand 这一族**永远**扣自填 Key 的钱,而且在平台用量明细里一条都查不到。
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    this.applyAuthHeaders(headers, site, key, url)

    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (e) {
      return { kind: 'fail', retryable: true, error: e instanceof Error ? e.message : String(e) }
    }

    const raw = await resp.text()
    if (!resp.ok) {
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        return {
          kind: 'fail',
          retryable: true,
          error: '上游服务器繁忙或无响应(502/503/504),请稍后重试。',
        }
      }
      return {
        kind: 'fail',
        retryable: false,
        error: `qwen 理解请求失败:${resp.status} ${resp.statusText}`,
      }
    }

    let json: any
    try {
      json = JSON.parse(raw)
    } catch {
      return {
        kind: 'fail',
        retryable: false,
        error: '上游返回了非 JSON 响应(可能是网关错误页),请重试。',
      }
    }
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.length === 0) {
      return { kind: 'fail', retryable: false, error: 'qwen 未返回可用文本。' }
    }
    return { kind: 'ok', text }
  }

  /**
   * Path B bridge: mirror the antigravity (Miau) image-gen token to the main
   * process under the codex provider id 'qwen', so a qwen understanding
   * subagent can reach the same gateway with `MIAU_API_KEY`. Best-effort:
   * silently no-ops outside Electron / when the agent API is unavailable —
   * Path A (the MCP understand_* tools) works without this bridge because
   * understand() runs here in the renderer and reads the token directly.
   */
  syncMiauTokenToMain(): void {
    try {
      const token =
        this.getStoredApiKey('antigravity') || this.getStoredVisionApiKey('antigravity') || ''
      const agent = getAgentApi()
      if (agent?.setProviderApiKey) {
        void agent.setProviderApiKey('qwen', token)
      }
    } catch {
      // best-effort; never block image-gen on the Path B bridge.
    }
  }

  /**
   * Mirror the app's already-configured API易 key to the main process so the
   * bundled apiyi-mcp server gets its `APIYI_API_KEY` injected at codex spawn —
   * the user fills ONE key in 设置 → API易 and never touches the MCP JSON editor.
   *
   * Catimation-style runtime injection (NOT a config write): we push the key to
   * the provider store under the dedicated id `apiyi-mcp` via
   * `setProviderApiKey`. The main process keeps an in-memory copy and, at every
   * codex (re)start, overlays it onto `[mcp_servers.apiyi].env.APIYI_API_KEY`
   * with a `-c` flag. The secret therefore:
   *   - is NEVER written to `~/.codex/config.toml` (the editor stays key-less),
   *   - always reflects the current 设置 value (recomputed each spawn, no stale),
   *   - is decoupled from codex's own API易 gateway provider key.
   * Changing the key in 设置 triggers an immediate codex restart on the main
   * side (the change-guard there makes idempotent re-pushes free), so the new
   * key takes effect without an app reload. `GEMINI_MODEL` is intentionally NOT
   * touched — it lives in the seed (default `gemini-3.5-flash`) so a user can
   * still hand-switch to `gemini-3.1-pro-preview-thinking` in the editor.
   *
   * Source of truth = whichever apiyi-family key the user saved in 设置
   * (`api易官方` → `api_key_apiyi`, `API易 B站` → `api_key_b-apiyi`, with the
   * optional 图像理解 keys as fallback). Both apiyi.com endpoints accept the same
   * `sk-` key. We push ONLY when a key is actually stored; with no apiyi key in
   * 设置 we no-op (a user managing the key by hand in the editor is untouched).
   *
   * Best-effort: silently no-ops outside Electron / when the agent API is
   * unavailable. Re-runs idempotently from the constructor, the save path, and
   * the `useMcpStore` cold-start hook.
   */
  syncApiyiKeyToMcp(): void {
    try {
      const key =
        this.getStoredApiKey('apiyi') ||
        this.getStoredApiKey('b-apiyi') ||
        this.getStoredVisionApiKey('apiyi') ||
        this.getStoredVisionApiKey('b-apiyi') ||
        ''
      if (!key) return
      const agent = getAgentApi()
      if (agent?.setProviderApiKey) {
        void agent.setProviderApiKey(APIYI_MCP_PROVIDER_ID, key)
      }
    } catch {
      // best-effort; never block the app on the apiyi-mcp key bridge.
    }
  }

  /**
   * Mirror the 设置 → 运镜知识库 DASHSCOPE key (stored in
   * `localStorage[dashscope_api_key]`) to the main process under the dedicated
   * `cinematography-kb` provider slot, so the bundled cinematography-kb-mcp
   * server gets `DASHSCOPE_API_KEY` injected at codex spawn. Catimation-style
   * runtime injection (NOT a config write): the secret never touches
   * `~/.codex/config.toml`. Pushes even an empty string so a user CLEARING the
   * key in 设置 propagates (main treats '' as "no key" and stops injecting).
   * Best-effort: silently no-ops outside Electron / when the agent API is
   * unavailable. Re-runs idempotently from the constructor and the settings
   * save path.
   */
  syncCinematographyKbKeyToMcp(): void {
    try {
      const key = (localStorage.getItem(DASHSCOPE_API_KEY_STORAGE) ?? '').trim()
      const agent = getAgentApi()
      if (agent?.setProviderApiKey) {
        void agent.setProviderApiKey(CINEMATOGRAPHY_KB_MCP_PROVIDER_ID, key)
      }
    } catch {
      // best-effort; never block the app on the cinematography-kb key bridge.
    }
  }

  /**
   * Mirror the 设置 → 运镜知识库 DashVector key (stored in
   * `localStorage[dashvector_api_key]`) to the main process under the dedicated
   * `dashvector` provider slot, so the bundled cinematography-kb-mcp server's
   * `query_sakuga_dataset` tool gets `DASHVECTOR_API_KEY` injected at codex
   * spawn. Same catimation-style runtime injection + empty-push clearing +
   * best-effort semantics as {@link syncCinematographyKbKeyToMcp}.
   */
  syncDashVectorKeyToMcp(): void {
    try {
      const key = (localStorage.getItem(DASHVECTOR_API_KEY_STORAGE) ?? '').trim()
      const agent = getAgentApi()
      if (agent?.setProviderApiKey) {
        void agent.setProviderApiKey(DASHVECTOR_MCP_PROVIDER_ID, key)
      }
    } catch {
      // best-effort; never block the app on the dashvector key bridge.
    }
  }

  /**
   * 保存 Vision API Key
   */
  saveVisionApiKey(key: string): boolean {
    try {
      localStorage.setItem(`vision_api_key_${this.currentSite}`, key)
      this.visionApiKey = key
      if (this.currentSite === 'antigravity') this.syncMiauTokenToMain()
      if (this.currentSite === 'apiyi' || this.currentSite === 'b-apiyi')
        void this.syncApiyiKeyToMcp()
      return true
    } catch {
      return false
    }
  }

  /**
   * 保存站点选择（setSite 的别名，兼容 SiteManager）
   */
  saveSite(siteKey: string): boolean {
    return this.setSite(siteKey)
  }

  /**
   * 获取当前站点 key
   */
  get currentSiteKey(): string {
    return this.currentSite
  }

  /**
   * 添加自定义站点
   */
  addCustomSite(key: string, config: Partial<ApiSite>): boolean {
    if (!key || !config.name || !config.baseURL) return false
    if (BUILT_IN_SITES[key]) return false

    const newSite: ApiSite = {
      name: config.name,
      baseURL: config.baseURL,
      description: config.description || '用户自定义站点',
      authType: config.authType || 'bearer',
      pathPrefix: config.pathPrefix,
      defaultApiKey: config.defaultApiKey,
      isBuiltIn: false
    }

    this.customSites[key] = newSite
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    return true
  }

  /**
   * 更新自定义站点
   */
  updateCustomSite(key: string, config: Partial<ApiSite>): boolean {
    if (!this.customSites[key]) return false

    this.customSites[key] = { ...this.customSites[key], ...config }
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    return true
  }

  /**
   * 删除自定义站点
   */
  removeCustomSite(key: string): boolean {
    if (!this.customSites[key]) return false

    delete this.customSites[key]
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }

    // 如果删除的是当前站点，切换到默认
    if (this.currentSite === key) {
      this.setSite('b-apiyi')
    }
    return true
  }

  /**
   * 保存自定义站点到 localStorage
   */
  private saveCustomSites(): void {
    localStorage.setItem('custom_sites', JSON.stringify(this.customSites))
  }

  private loadCustomSites(): Record<string, ApiSite> {
    try {
      const stored = localStorage.getItem('custom_sites')
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  }

  /**
   * 检查是否已配置 API Key
   */
  hasApiKey(): boolean {
    return !!this.apiKey
  }

  /**
   * 获取模型能力
   */
  getModelCapabilities(modelKey?: string): ModelCapabilities | undefined {
    const model = this.models[modelKey || this.currentModel]
    return model?.capabilities
  }

  /**
   * 辅助方法：将数组分块
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }

  /**
   * 批量生成图片
   */
  async batchGenerate(
    prompts: string[],
    ratio = '1:1',
    concurrency = 2,
    n = 1,
    resolution: string | null = null
  ): Promise<any[]> {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('提示词列表不能为空')
    }

    const results: any[] = []
    const batches = this.chunk(prompts, concurrency)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const batchPromises = batch.map(async (prompt, index) => {
        const promptIndex = i * concurrency + index
        try {
          const result = await this.generateImage({
            prompt,
            ratio,
            resolution: resolution || undefined,
            count: n
          })
          // success 由 `...result` 提供（GenerateResult.success 是必填项）。之前在展开
          // 之前还显式写了一遍同值的 success，展开必然盖掉它，纯属死代码。
          const resultData = {
            index: promptIndex,
            prompt,
            ...result
          }

          // 立即触发单个结果显示事件
          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: resultData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return resultData
        } catch (error) {
          const errorData = {
            index: promptIndex,
            prompt,
            success: false,
            error: error,
            errorMessage: (error as Error).message
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: errorData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return errorData
        }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      results.push(...batchResults.map(result =>
        result.status === 'fulfilled' ? result.value : {
          success: false,
          error: result.reason,
          errorMessage: result.reason?.message || '请求失败'
        }
      ))

      // 触发进度更新事件
      window.dispatchEvent(new CustomEvent('batchProgress', {
        detail: {
          completed: results.length,
          total: prompts.length,
          currentBatch: i + 1,
          totalBatches: batches.length
        }
      }))

      // 批次间延迟
      if (i < batches.length - 1) {
        await this.delay(1000)
      }
    }

    return results
  }

  /**
   * 批量生成图片（带参考图）
   */
  async batchGenerateWithReference(
    prompts: string[],
    referenceImages: string[],
    ratio = '1:1',
    concurrency = 2,
    n = 1,
    resolution: string | null = null
  ): Promise<any[]> {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('提示词列表不能为空')
    }

    if (!referenceImages || referenceImages.length === 0) {
      throw new Error('参考图片不能为空')
    }

    const results: any[] = []
    const batches = this.chunk(prompts, concurrency)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const batchPromises = batch.map(async (prompt, index) => {
        const promptIndex = i * concurrency + index
        try {
          const result = await this.generateImage({
            prompt,
            ratio,
            resolution: resolution || undefined,
            referenceImages,
            count: n
          })
          // 同 batchGenerate：success 以 `...result` 为准，显式那一份是被覆盖的死代码。
          const resultData = {
            index: promptIndex,
            prompt,
            ...result
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: resultData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return resultData
        } catch (error) {
          const errorData = {
            index: promptIndex,
            prompt,
            success: false,
            error: error,
            errorMessage: (error as Error).message
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: errorData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return errorData
        }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      results.push(...batchResults.map(result =>
        result.status === 'fulfilled' ? result.value : {
          success: false,
          error: result.reason,
          errorMessage: result.reason?.message || '请求失败'
        }
      ))

      window.dispatchEvent(new CustomEvent('batchProgress', {
        detail: {
          completed: results.length,
          total: prompts.length,
          currentBatch: i + 1,
          totalBatches: batches.length
        }
      }))

      if (i < batches.length - 1) {
        await this.delay(1000)
      }
    }

    return results
  }
}

// 创建单例
let instance: ApiService | null = null

export function getApiService(): ApiService {
  if (!instance) {
    instance = new ApiService()
  }
  return instance
}

export function createApiService(): ApiService {
  return new ApiService()
}

/**
 * 重置单例（仅用于测试）
 */
export function resetApiService(): void {
  instance = null
}

// ========================================
// V16.2 C2 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    api: ApiService
    apiTS: ApiService
    ApiServiceTS: typeof ApiService
  }
}

let apiDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initApiServiceGlobal(): ApiService {
  const service = getApiService()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'api', {
      get() {
        if (!apiDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.api 已废弃。' +
            '请使用 Services.get("api") 或 import { getApiService } from "@/services/api"'
          )
          apiDeprecationWarningShown = true
        }
        return service
      },
      configurable: true
    })
    
    window.apiTS = service
    window.ApiServiceTS = ApiService
  }

  console.log('[V16.3] ApiService TypeScript 版本已加载 (废弃警告已启用)')

  return service
}

// ========================================
// 响应解析（万相 / new-api metadata 兼容，可单测）
// ========================================

function normalizeExtractedImageSource(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.toLowerCase().startsWith('data:image/')) return trimmed
  return `data:image/png;base64,${trimmed}`
}

function extractImagesFromDashScopeOutput(output: unknown, sink: string[], seen: Set<string>): void {
  if (!output || typeof output !== 'object') return
  const out = output as Record<string, unknown>

  const results = out.results
  if (Array.isArray(results)) {
    for (const item of results) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.url === 'string' && row.url && !seen.has(row.url)) {
        seen.add(row.url)
        sink.push(row.url)
      }
      if (typeof row.b64_image === 'string' && row.b64_image) {
        const normalized = normalizeExtractedImageSource(row.b64_image)
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized)
          sink.push(normalized)
        }
      }
    }
  }

  const choices = out.choices
  if (!Array.isArray(choices)) return

  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined
    const parts = message?.content
    if (!Array.isArray(parts)) continue

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const image = (part as Record<string, unknown>).image
      if (typeof image !== 'string' || !image) continue
      const normalized = normalizeExtractedImageSource(image)
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized)
        sink.push(normalized)
      }
    }
  }
}

function parseMetadataBody(metadata: unknown): unknown {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata)
    } catch {
      return null
    }
  }
  return metadata
}

/** 从 HTTP 200 的 DashScope 错误体提取可读信息 */
export function getDashScopeErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const body = data as Record<string, unknown>

  if (body.error && typeof body.error === 'object') {
    const msg = (body.error as Record<string, unknown>).message
    if (typeof msg === 'string' && msg) return msg
  }

  const code = body.code
  const message = body.message
  if (typeof code === 'string' && code && typeof message === 'string' && message) {
    const output = body.output
    const hasImages = output && typeof output === 'object'
      && (
        Array.isArray((output as Record<string, unknown>).choices)
        || Array.isArray((output as Record<string, unknown>).results)
      )
    if (!hasImages) return `${code}: ${message}`
  }

  const meta = parseMetadataBody(body.metadata)
  if (meta && typeof meta === 'object') {
    const metaBody = meta as Record<string, unknown>
    const metaCode = metaBody.code
    const metaMessage = metaBody.message
    if (typeof metaCode === 'string' && metaCode && typeof metaMessage === 'string' && metaMessage) {
      const metaOutput = metaBody.output
      const hasMetaImages = metaOutput && typeof metaOutput === 'object'
        && (
          Array.isArray((metaOutput as Record<string, unknown>).choices)
          || Array.isArray((metaOutput as Record<string, unknown>).results)
        )
      if (!hasMetaImages) return `${metaCode}: ${metaMessage}`
    }
  }

  return null
}

/**
 * 文本里的图片地址。
 *
 * 查询串必须一并带走:对象存储回的是预签名 URL,签名就在 `?` 后面,
 * 截断到扩展名等于交出一个必然 403 的链接。终止符里排除 `)`/引号/`]`,
 * 是为了从 markdown 的 `![img](url)` 里取出干净的 url。
 */
const IMAGE_URL_IN_TEXT = /https?:\/\/[^\s)"'\]]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'\]]*)?/gi
const DATA_URL_IN_TEXT = /data:image\/[^\s)"'\]]+/gi

function collectImagesFromText(text: string, images: string[], seen: Set<string>): void {
  for (const pattern of [IMAGE_URL_IN_TEXT, DATA_URL_IN_TEXT]) {
    for (const url of text.match(pattern) ?? []) {
      if (seen.has(url)) continue
      seen.add(url)
      images.push(url)
    }
  }
}

/** bounding_box 的坐标数组：只留有限数字，别把 null / 字符串混进坐标系。 */
function toFiniteNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const nums = value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  return nums.length > 0 ? nums : undefined
}

/**
 * 从图层拆分响应的 `data[]` 里还原图层栈，按 zIndex 升序（底图在前）。
 *
 * 判据是 **`z_index` 存在**而非真值：底图的 z_index 是 0，用 `if (item.z_index)` 会把
 * 底图判成「没有图层元数据」而整条丢掉。普通生图 / 组图没有这个字段，此时返回空数组，
 * 调用方按普通结果处理，行为不变。
 *
 * `url` 优先于 base64（请求里已固定 response_format: 'url'）：一次最多 17 张 2K 图，
 * 把 base64 收进内存就是渲染进程的瞬时峰值。
 */
export function extractLayersFromApiResponse(data: unknown): ImageLayer[] {
  if (!data || typeof data !== 'object') return []
  const body = data as Record<string, unknown>
  if (!Array.isArray(body.data)) return []

  const fallbackMime = typeof body.mime_type === 'string' && body.mime_type
    ? body.mime_type
    : 'image/png'
  const layers: ImageLayer[] = []

  for (const item of body.data) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>

    const zIndex = row.z_index
    if (typeof zIndex !== 'number' || !Number.isFinite(zIndex)) continue

    let url: string | null = null
    if (typeof row.url === 'string' && row.url.trim()) {
      url = row.url.trim()
    } else {
      const base64 = typeof row.b64_json === 'string' && row.b64_json
        ? row.b64_json
        : (typeof row.image_data === 'string' ? row.image_data : '')
      if (base64) url = normalizeExtractedImageSource(base64)
    }
    if (!url) continue

    // 拆分场景 output_format 只描述底图，图层恒为 png，所以逐项读而非用顶层 mime_type。
    const mimeType = typeof row.output_format === 'string' && row.output_format.trim()
      ? `image/${row.output_format.trim().toLowerCase()}`
      : fallbackMime

    const layer: ImageLayer = { url, mimeType, zIndex }

    const box = row.bounding_box
    if (box && typeof box === 'object') {
      const absolute = toFiniteNumbers((box as Record<string, unknown>).absolute)
      const normalized = toFiniteNumbers((box as Record<string, unknown>).normalized)
      if (absolute || normalized) {
        layer.boundingBox = {
          ...(absolute ? { absolute } : {}),
          ...(normalized ? { normalized } : {}),
        }
      }
    }

    if (typeof row.name === 'string' && row.name.trim()) layer.name = row.name.trim()
    if (typeof row.description === 'string' && row.description.trim()) {
      layer.description = row.description.trim()
    }

    layers.push(layer)
  }

  return layers.sort((a, b) => a.zIndex - b.zIndex)
}

/** 从 OpenAI / DashScope / new-api(metadata) 响应中提取全部图片 URL 或 data URL */
export function extractImagesFromApiResponse(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []

  const images: string[] = []
  const seen = new Set<string>()
  const body = data as Record<string, unknown>

  // new-api 会把原始 DashScope body 放在 metadata（组图时比 data[] 更完整）
  const metadata = parseMetadataBody(body.metadata)
  if (metadata && typeof metadata === 'object') {
    extractImagesFromDashScopeOutput((metadata as Record<string, unknown>).output, images, seen)
  }

  // DashScope 原生顶层 output
  extractImagesFromDashScopeOutput(body.output, images, seen)

  // OpenAI Images: data[].url / data[].b64_json
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.url === 'string' && row.url && !seen.has(row.url)) {
        seen.add(row.url)
        images.push(row.url)
      }
      if (typeof row.b64_json === 'string' && row.b64_json) {
        const normalized = normalizeExtractedImageSource(row.b64_json)
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized)
          images.push(normalized)
        }
      }
    }
  }

  if (images.length > 0) return images

  // Gemini 格式
  if (Array.isArray(body.candidates)) {
    for (const candidate of body.candidates) {
      if (!candidate || typeof candidate !== 'object') continue
      const parts = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined
      const partList = parts?.parts
      if (!Array.isArray(partList)) continue
      for (const part of partList) {
        if (!part || typeof part !== 'object') continue
        const inlineData = (part as Record<string, unknown>).inlineData as Record<string, unknown> | undefined
        if (typeof inlineData?.data === 'string' && inlineData.data) {
          const mime = typeof inlineData.mimeType === 'string' ? inlineData.mimeType : 'image/png'
          const dataUrl = `data:${mime};base64,${inlineData.data}`
          if (!seen.has(dataUrl)) {
            seen.add(dataUrl)
            images.push(dataUrl)
          }
        }
        // 网关把产物传到对象存储后,整条响应里没有 base64,只有 text 里的一条
        // 预签名 URL —— 图是生成成功的,只认 inlineData 会把它报成生成失败。
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text) collectImagesFromText(text, images, seen)
      }
    }
  }

  // Chat Completions markdown 内嵌 URL
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== 'object') continue
      const content = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined
      const text = content?.content
      if (typeof text !== 'string') continue
      collectImagesFromText(text, images, seen)
    }
  }

  return images
}
