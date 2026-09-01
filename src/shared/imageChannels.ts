/**
 * 出图**渠道**清单 —— 聊天选择器与 MCP 工具共用的唯一事实来源。
 *
 * ## 为什么在 shared 而不是 renderer
 *
 * 这份清单有两个消费方,分别住在两个进程里:
 *
 *   - 渲染层 `features/agent-chat/ImageChannelPicker` —— 用户在输入框下面选渠道;
 *   - 主进程 `mcp/tools/imageTools` —— agent 调 `generate_image` 时的参数枚举。
 *
 * 主进程 import 不了渲染层的模块(整个仓库没有这种先例,打包边界也不同),
 * 所以它以前**自己抄了一份 enum**。抄的那份必然漂移:2026-09-01 接
 * TokenHub og-image 时,生成页有了、聊天和 MCP 都没有;而且这种漏不会报错 ——
 * 用户只会觉得「新模型在有的地方看不见」,报障时也说不清是哪儿的问题。
 *
 * 现在 MCP 那边的枚举从这个数组**推导**,加渠道只改这一处。
 *
 * ## 与 `ApiService.DEFAULT_MODELS` 的关系
 *
 * 那边存的是**怎么发请求**(端点、尺寸表、能力位),这边存的是**给谁看、怎么显示**。
 * 两者按 `id` 对应,但不是同一份:`DEFAULT_MODELS` 里的模型多得多(经典生成页全都
 * 提供),而聊天渠道是精选子集。有条守卫钉住「这里的每个 id 在那边都存在」——
 * 否则用户选得到、发出去 404。
 *
 * `miauOnly` 标记那些**只能**经 Miau 网关到达的渠道;解析器会把这些请求钉到
 * Miau 站点,与用户当前选了哪个站点无关。
 */
export interface ImageChannel {
  /** 转发给 `ApiService.generateImage` 的原始模型 id。 */
  id: string
  /** 选择器胶囊上的短标签(如 "VIP")。 */
  label: string
  /** 下拉行里的长标签。 */
  fullLabel: string
  /** 行下方的一句话说明。 */
  description: string
  /** 为 true 时,生成请求固定打 Miau 站点。 */
  miauOnly: boolean
}

/**
 * 顺序按产品要求(2026-07-20):Seedream 5.0 Pro → 腾讯 → Nano2 → 万相 2.7 pro →
 * Image2 官方 → VIP。默认渠道仍是 VIP —— 顺序只影响显示,不改变回落目标。
 */
export const IMAGE_CHANNELS = [
  {
    id: 'doubao-seedream-5-0-pro-260628',
    label: 'SD5',
    fullLabel: 'Seedream 5.0 Pro',
    description: '火山豆包 Seedream 5.0 Pro — 多图融合(≤10 参考图)，1K/2K 单图，经 Miau 代理。',
    miauOnly: true,
  },
  {
    id: 'custom-imagemodel-gt',
    label: '腾讯',
    fullLabel: '腾讯 image2',
    description: '经 Miau 代理 — 快 ~30s，网关去水印。',
    miauOnly: true,
  },
  {
    // TokenHub og-image。与上面那条(TokenHub gtimage / aiart 官方)是**两个不同的
    // 模型、两条不同的渠道**,不是同一个东西的两个入口:网关价目表倍率 5 对 29.05,
    // 而且这条实测能一次出多张。所以两条并列而不是替换。
    id: 'custom-model-og-v2',
    label: 'Fast',
    fullLabel: '腾讯 image2 fast',
    // 后台渠道名(TokenHub og-image)写进描述而不是标题:用户看标题选模型,
    // 而对账时要能和 New API 后台的渠道名对上号。
    description: '经 Miau 代理 — 快 ~20s，比 image2 便宜近 6 倍，可出多张。后台渠道 TokenHub og-image。',
    miauOnly: true,
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Nano2',
    fullLabel: 'Nano Banana 2',
    description: 'Gemini 3.1 flash image（当前站点）— 快，多比例 4K。',
    miauOnly: false,
  },
  {
    id: 'wan2.7-image-pro',
    label: 'Wan2.7',
    fullLabel: '万相 2.7 pro',
    description: '阿里万相 2.7 pro — 超清/组图，经 Miau 代理。',
    miauOnly: true,
  },
  {
    // DashScope 同步多模态出图，经 Miau 的 OpenAI 兼容 /v1/images/generations。
    // 注意两条与别家不同的脾气（接入说明 2026-08-07 §6 / §9）：上游可能忽略或
    // 改写请求尺寸（实测请求 1328×1328 拿回约 1792×2400），所以别把 size 当承诺；
    // `negative_prompt` 不会经网关透传（AliImageParameters 里没有这个键，反序列化
    // 时直接丢弃），要压画质问题得写进正向提示词。
    id: 'qwen-image-3.0-pro',
    label: 'Qwen3',
    fullLabel: '通义千问 Image 3.0 Pro',
    description: '阿里通义千问 Image 3.0 Pro — 同步出图，一次可出 1–6 张、参考图最多 3 张；尺寸以实际返回为准。',
    miauOnly: true,
  },
  {
    id: 'gpt-image-2',
    label: 'Image2',
    fullLabel: 'GPT Image 2 官方',
    description: 'API易 OpenAI 官方旗舰 — 按 token 计费，慢但质量上限最高，4K+mask 重绘。',
    miauOnly: false,
  },
  {
    id: 'gpt-image-2-vip',
    label: 'VIP',
    fullLabel: 'VIP image2',
    description: 'OpenAI 官逆，稳定。默认渠道。',
    miauOnly: false,
  },
  // ⚠️ `as const satisfies` 而不是 `: readonly ImageChannel[]`。
  //
  // 写成类型标注会把每个 `id` **拓宽成 `string`**,于是下面派生出来的
  // `IMAGE_CHANNEL_IDS` 也是 `string[]`,`z.enum()` 拿到它之后
  // `z.infer` 只能得出 `string` —— MCP 那个 `model` 参数就退化成「任意字符串」,
  // 比它替换掉的手写联合还弱。`satisfies` 同样能校验结构,但保留字面量。
] as const satisfies readonly ImageChannel[]

/** 用户没选(或存的值已失效)时的默认渠道。 */
export const DEFAULT_IMAGE_CHANNEL_ID = 'gpt-image-2-vip'

/**
 * 渠道 id 的字面量联合 —— 供 MCP 的参数类型使用。
 *
 * ## 为什么是**封闭**枚举,不留 `| (string & {})` 的开口
 *
 * Vercel AI SDK 给自定义 provider 的 model id 是开放的
 * (`'a' | 'b' | (string & {})`,见其 custom-providers 文档):上游模型目录变得比
 * SDK 发版快,放行未知 id、只保留自动补全,是对它那个场景更合适的取舍。
 *
 * 这里反过来:出图渠道不只是个字符串,每条都要在 `ApiService` 里配端点、尺寸表、
 * 能力位。放行一个没配过的 id,结果不是「用了个新模型」而是每轮 404,而错误里
 * 不会有一个字提到是模型名的问题(网关的报错只说 model 不存在)。这种情况下
 * 在边界上拒掉、让 agent 立刻拿到「不是合法值」,比放进去再失败有用得多。
 */
export type ImageChannelId = (typeof IMAGE_CHANNELS)[number]['id']

/**
 * 编译期自证:`ImageChannelId` 必须是**字面量联合**,不能退化成 `string`。
 *
 * Zod 官方文档写明了这个陷阱:传给 `z.enum()` 的数组若没保住字面量,
 * `z.infer` 只能得出 `string`(https://zod.dev — "Pass string array variables
 * to z.enum")。后果是 MCP 的 `model` 参数变成「任意字符串」,而**类型检查照样
 * 通过**,没有任何信号 —— 2026-09-01 就这么丢过一次。
 *
 * 下面这行是纯类型层面的:`string extends ImageChannelId` 只有在它被拓宽成
 * `string` 时才成立,那时右边求值成 `never`,把 `true` 赋给 `never` 立刻编译失败。
 * 放在 `tsc` 里拦,而不是靠某个测试文件去正则匹配源码 —— 后者只在跑到那个文件
 * 时才有效,而这条不变量任何一次编译都该守住。
 */
type AssertLiteralChannelIds = string extends ImageChannelId ? never : true
const _assertChannelIdsAreLiterals: AssertLiteralChannelIds = true
void _assertChannelIdsAreLiterals

/**
 * 供 MCP 的 `z.enum()` 使用 —— zod 的签名要 `readonly [string, ...string[]]`
 * (非空元组),而 `.map()` 给的是普通数组,所以要窄化一次。
 *
 * 从上面的数组推导,所以加渠道时 MCP 那边**自动跟上**,不需要记得同步。
 * 断言只改「非空」这一点,元素类型仍是 `ImageChannelId`(由上面那行保证是字面量)。
 */
export const IMAGE_CHANNEL_IDS = IMAGE_CHANNELS.map((c) => c.id) as [
  ImageChannelId,
  ...ImageChannelId[],
]

export function findImageChannel(id: string): ImageChannel | undefined {
  return IMAGE_CHANNELS.find((c) => c.id === id)
}

export function isSelectableImageChannel(id: unknown): id is string {
  return typeof id === 'string' && IMAGE_CHANNELS.some((c) => c.id === id)
}

export function isMiauOnlyChannel(id: string): boolean {
  return findImageChannel(id)?.miauOnly === true
}

/**
 * 把任意候选值(用户选择、过期的本地存储、agent 传来的值)解析成一个合法渠道 id,
 * 认不出就回落到默认(VIP),这样出图永远不会因为这个而失败。
 */
export function resolveImageChannel(candidate: unknown): string {
  return isSelectableImageChannel(candidate) ? candidate : DEFAULT_IMAGE_CHANNEL_ID
}
