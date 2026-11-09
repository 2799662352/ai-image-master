/**
 * 出图**模型专属参数** —— 声明、默认值与校验的唯一事实来源。
 *
 * ## 为什么需要这一层
 *
 * 现有的出图参数是一组「所有渠道共用的轴」:比例 / 分辨率 / 清晰度 / 数量 / 透明背景 / 反向词。
 * 每加一个轴,就要在 `GenerateImageParams`、`ImageParamControls`、MCP 的 zod schema、
 * `AgentToolExecutor` 里各加一处 —— 对「几乎所有渠道都有」的轴这是合理的。
 *
 * 悠船(Midjourney)的参数是另一种形状:十来个只对它有意义的开关与数值(原生 2K、混沌、
 * 风格化、原始模式、图像权重、风格参考图……),而且**绝大多数时候不该设**,由模型自己决定。
 * 把它们逐个塞进共用轴会让每个渠道的类型都背上一堆无关字段。所以这里改成数据驱动:
 * 渠道声明一张 `ModelParamSpec[]`,界面、MCP schema、请求体装配、校验全部从这张表派生。
 *
 * 主进程(MCP 工具)与渲染层(生成页、`ApiService`)都要读它,而主进程 import 不了渲染层的
 * 模块,所以住在 `shared/`,与 `imageChannels.ts` 同理。
 *
 * ## 「不设置 = 自动」是核心语义
 *
 * 绝大多数 spec 没有 `defaultValue`:用户 / agent 不给就**不发这个字段**,让上游按自己的默认来。
 * 只有明确有产品默认的才写 `defaultValue`(目前只有悠船的 `hd`,原生 2K 默认开)。
 * 这样「全部恢复自动」就是清空用户值,不需要知道每个参数的默认是多少。
 */

/**
 * NovelAI 的「角色提示词」:每个角色一段提示词 + 画面位置。x / y 取 0–1
 * (0 = 左 / 上,1 = 右 / 下,缺省 0.5 居中)。`enabled === false` 是界面上留着没删的草稿,
 * 校验时直接丢弃,归一后的输出不再带 `enabled`。
 */
export interface CharacterParamValue {
  prompt: string
  /** 该角色的负面提示词,空则不出现。 */
  uc?: string
  x: number
  y: number
  enabled?: boolean
}

export type ModelParamValue = boolean | number | string | string[] | CharacterParamValue[]
export type ModelParamValues = Record<string, ModelParamValue>

export interface ModelParamOption {
  key: string
  label: string
}

export interface ModelParamSpec {
  /** 请求体字段名(原样外发),也是 `ModelParamValues` 的键。 */
  key: string
  label: string
  type: 'switch' | 'select' | 'number' | 'text' | 'urls' | 'characters'
  description?: string
  /** 高级参数:界面折叠在「高级参数」里,默认不展开。 */
  advanced?: boolean
  /** 只有产品明确有默认的才写;没写 = 不设置 = 不外发。 */
  defaultValue?: ModelParamValue
  /** 开启后计费倍数(仅用于界面提示,真正的扣费在网关)。 */
  priceMultiplier?: number
  // select
  options?: ModelParamOption[]
  /** select 的外发类型。默认 string;数字档位(如风格版本)写 number。 */
  valueType?: 'string' | 'number'
  // number
  min?: number
  max?: number
  integer?: boolean
  /** 数字输入框的步长(仅界面用);整数默认 1,小数参数(如图像权重)要显式给。 */
  step?: number
  // text
  maxLength?: number
  /** 界面用多行输入框(反向提示词这类长文本);不影响校验与外发。 */
  multiline?: boolean
  /** 拒绝文本里出现 `--`:悠船的 `no` 会被拼进 `--no`,内嵌别的 `--flag` 能绕过版本 / 速度锁。 */
  forbidDashFlags?: boolean
  // urls / characters
  maxItems?: number
}

// ───────────────────────── 悠船(Midjourney) ─────────────────────────

/** 悠船一次任务固定出 4 张,网关忽略 `n`、只计一次费。 */
export const YOUCHUAN_OUTPUT_COUNT = 4

/** 与网关 `relay/channel/youchuan` 的 `hdPriceRatio` 一致。 */
export const YOUCHUAN_HD_PRICE_RATIO = 1.5

/** 网关侧 `images:[{image_url}]` 的上限,且只收 http(s)。 */
export const YOUCHUAN_MAX_REFERENCE_IMAGES = 20

/**
 * 悠船 V8 系列(v8.1 / v8.2 快速 / v8.2 极速)共用的参数表。
 *
 * 键名是**网关读的字段名**,不是 Midjourney 的 `--flag` 名(`iw` 对 `--iw`、`sref`、`sw`、
 * `sv`、`no`、`seed`、`chaos`、`stylize`、`raw` 都是同名;`quality` 在网关里映射到 `--q`)。
 * 版本与速度由**模型名**决定(`youchuan-v8.2` / `youchuan-v8.2-turbo`),不在这里。
 *
 * 对照 sora-ui-backend `imageModelManifest.ts` 的 `YOUCHUAN_V8_PARAMS`,文案与范围一致。
 */
export const YOUCHUAN_V8_PARAM_SPECS: readonly ModelParamSpec[] = [
  {
    key: 'hd',
    label: '开启原生2K',
    type: 'switch',
    description: `直接输出原生 2K 分辨率，计费 ×${YOUCHUAN_HD_PRICE_RATIO}`,
    defaultValue: true,
    priceMultiplier: YOUCHUAN_HD_PRICE_RATIO,
  },
  {
    key: 'quality',
    label: '图像质量',
    type: 'select',
    valueType: 'string',
    advanced: true,
    description: '对应 --q；数值越高越精细，不选则由悠船决定',
    options: [
      { key: '1', label: '1' },
      { key: '4', label: '4' },
    ],
  },
  {
    key: 'chaos',
    label: '混沌程度',
    type: 'number',
    integer: true,
    min: 0,
    max: 100,
    advanced: true,
    description: '为图像结果增添趣味（0–100）',
  },
  {
    key: 'stylize',
    label: '风格化程度',
    type: 'number',
    integer: true,
    min: 0,
    max: 1000,
    advanced: true,
    description: '控制图像的艺术风格强度（0–1000）',
  },
  {
    key: 'raw',
    label: '原始模式',
    type: 'switch',
    advanced: true,
    description: '获得对图像的更多控制',
  },
  {
    key: 'iw',
    label: '图像权重',
    type: 'number',
    // 网关按小数读(`--iw 1.5`),不是整数。
    step: 0.1,
    min: 0,
    max: 3,
    advanced: true,
    description: '控制参考图（垫图）的影响，0–3',
  },
  {
    key: 'sref',
    label: '风格参考图',
    type: 'urls',
    maxItems: 20,
    advanced: true,
    description: '风格参考图链接（http/https），每行一个，最多 20 个',
  },
  {
    key: 'sw',
    label: '风格权重',
    type: 'number',
    integer: true,
    min: 0,
    max: 1000,
    advanced: true,
    description: '风格参考的影响强度（0–1000）',
  },
  {
    key: 'sv',
    label: '风格版本',
    type: 'select',
    valueType: 'number',
    advanced: true,
    description: '风格参考所用的风格版本',
    options: [{ key: '6', label: '6' }],
  },
  {
    key: 'seed',
    label: '随机种子',
    type: 'number',
    integer: true,
    min: 0,
    max: 4294967295,
    advanced: true,
    description: '固定种子可复现相近的构图（0–4294967295）',
  },
  {
    key: 'no',
    label: '排除内容',
    type: 'text',
    maxLength: 500,
    forbidDashFlags: true,
    advanced: true,
    description: '不希望出现的元素，用逗号分隔（对应 --no）',
  },
]

/** 走悠船渠道的模型 id。与网关 `youchuan-(v|niji)<ver>[-fast|-turbo]` 命名一致。 */
export const YOUCHUAN_MODEL_IDS = ['youchuan-v8.2', 'youchuan-v8.2-turbo'] as const

export function isYouchuanModel(id: unknown): boolean {
  return typeof id === 'string' && (YOUCHUAN_MODEL_IDS as readonly string[]).includes(id)
}

// ───────────────────────── NovelAI(经 TTAPI,网关渠道类型 77) ─────────────────────────

/**
 * NovelAI 四个模型,id 与网关模型名一致(`nai-diffusion-*`)。
 *
 * 网关把 `POST /v1/images/generations` 做成同步门面(提交 TTAPI → 轮询 → 返回 `data[].url`),
 * **按「每张图」固定价计费**,`n`(1–4)按实际返回张数放大价格,1K 与 2K 同价,所以界面开原生数量轴
 * (`nativeBatch`)。键名 / 范围 / 默认值对照 new-api #174 的 `relay/channel/ttapi/request.go`
 * 与网页版 #277,逐项一致 —— 网关对越界值直接 400,桌面端在出网前先拒掉。
 */
export const NOVELAI_MODEL_IDS = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
] as const

export type NovelAiFamily = 'v5' | 'v45'

export function isNovelAiModel(id: unknown): boolean {
  return typeof id === 'string' && (NOVELAI_MODEL_IDS as readonly string[]).includes(id)
}

/** V5 / V4.5 两个系列:V5 支持透明底且角色提示词上限更高。不认识的 id 返回 null。 */
export function novelAiFamilyOfModel(id: unknown): NovelAiFamily | null {
  if (typeof id !== 'string') return null
  if (id.startsWith('nai-diffusion-5-')) return 'v5'
  if (id.startsWith('nai-diffusion-4-5-')) return 'v45'
  return null
}

/** 提示词(含角色提示词之外的主提示词)上限,与网关一致。 */
export const NOVELAI_MAX_PROMPT_CHARS = 4000
/** 负面提示词上限,与网关一致。 */
export const NOVELAI_MAX_NEGATIVE_PROMPT_CHARS = 2000
/** 角色提示词条数上限:V5 22 / V4.5 6,与网关一致。 */
export const NOVELAI_V5_MAX_CHARACTERS = 22
export const NOVELAI_V45_MAX_CHARACTERS = 6
/** 单个角色的提示词 / 负面提示词字数上限。 */
export const NOVELAI_CHARACTER_PROMPT_MAX_CHARS = 2000
export const NOVELAI_CHARACTER_UC_MAX_CHARS = 1000
/**
 * 参考图只有「图生图」一种用法,恒为 1 张。氛围迁移(vibe_transfer)与角色精准参考
 * (character_reference)上游 TTAPI 目前一律失败(网关 #174 / 网页版 #277 都已禁用),
 * 桌面端不开口子;上游恢复后在这里加 `reference_mode` 即可。
 */
export const NOVELAI_MAX_REFERENCE_IMAGES = 1

/** 比例 × 清晰度 → 像素尺寸。每条边都是 64 的倍数(NovelAI 的硬约束),源头即 ASCII `x`。 */
export const NOVELAI_RESOLUTION_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1:1': { '1K': '1024x1024', '2K': '1536x1536' },
  '3:2': { '1K': '1216x832', '2K': '1856x1280' },
  '2:3': { '1K': '832x1216', '2K': '1280x1856' },
  '4:3': { '1K': '1152x896', '2K': '1728x1344' },
  '3:4': { '1K': '896x1152', '2K': '1344x1728' },
  '16:9': { '1K': '1344x768', '2K': '1920x1088' },
  '9:16': { '1K': '768x1344', '2K': '1088x1920' },
}

/**
 * NovelAI 参数表。每个系列一份(角色提示词上限不同),其余完全相同。
 *
 * 与悠船不同,这里**有**产品默认值(步数 23 / CFG 5 / 采样器 Euler Ancestral / 噪声调度 karras /
 * 数据集 anime / 图生图强度 0.7),与网页版一致 —— 请求体总会带上它们,界面上的「自动」就是默认值。
 * `img2img_strength` / `img2img_noise` 只在带参考图时外发(装配时翻成网关的 `image` / `strength` / `noise`)。
 */
export function novelAiParamSpecs(family: NovelAiFamily): readonly ModelParamSpec[] {
  const maxCharacters = family === 'v5' ? NOVELAI_V5_MAX_CHARACTERS : NOVELAI_V45_MAX_CHARACTERS
  return [
    {
      key: 'dataset_mode',
      label: '数据集模式',
      type: 'select',
      valueType: 'string',
      description: '兽人模式会在提示词最前面加 `fur dataset,`',
      options: [
        { key: 'anime', label: '动漫' },
        { key: 'furry', label: '兽人' },
      ],
      defaultValue: 'anime',
    },
    {
      key: 'negative_prompt',
      label: '负面提示词',
      type: 'text',
      multiline: true,
      maxLength: NOVELAI_MAX_NEGATIVE_PROMPT_CHARS,
      description: '不希望出现的内容，用逗号分隔',
    },
    {
      key: 'characters',
      label: '角色提示词',
      type: 'characters',
      maxItems: maxCharacters,
      description: `为画面里的每个角色单独写提示词并指定位置（x / y 取 0–1，0 为左 / 上，1 为右 / 下），最多 ${maxCharacters} 个`,
    },
    {
      key: 'steps',
      label: '采样步数',
      type: 'number',
      integer: true,
      min: 1,
      max: 50,
      advanced: true,
      defaultValue: 23,
      description: '步数越多越精细但越慢（1–50）',
    },
    {
      key: 'scale',
      label: '提示词相关性 (CFG)',
      type: 'number',
      step: 0.1,
      min: 0,
      max: 10,
      advanced: true,
      defaultValue: 5,
      description: '数值越高越贴近提示词（0–10）',
    },
    {
      key: 'sampler',
      label: '采样器',
      type: 'select',
      valueType: 'string',
      advanced: true,
      defaultValue: 'Euler Ancestral',
      options: ['Euler Ancestral', 'Euler', 'DPM++ 2S Ancestral', 'DPM++ 2M SDE', 'DPM++ 2M', 'DPM++ SDE'].map(
        (key) => ({ key, label: key }),
      ),
    },
    {
      key: 'noise_schedule',
      label: '噪声调度',
      type: 'select',
      valueType: 'string',
      advanced: true,
      defaultValue: 'karras',
      options: ['karras', 'exponential', 'polyexponential'].map((key) => ({ key, label: key })),
    },
    {
      key: 'seed',
      label: '随机种子',
      type: 'number',
      integer: true,
      min: 0,
      max: 4294967295,
      advanced: true,
      description: '固定种子可复现相近的构图（0–4294967295）',
    },
    {
      key: 'img2img_strength',
      label: '图生图强度',
      type: 'number',
      step: 0.05,
      min: 0.01,
      max: 0.99,
      advanced: true,
      defaultValue: 0.7,
      description: '仅带参考图（图生图）时生效：越大越偏离参考图（0.01–0.99）',
    },
    {
      key: 'img2img_noise',
      label: '图生图噪声',
      type: 'number',
      step: 0.05,
      min: 0,
      max: 0.99,
      advanced: true,
      defaultValue: 0,
      description: '仅带参考图（图生图）时生效：给参考图加的噪声（0–0.99）',
    },
  ]
}

export const NOVELAI_V5_PARAM_SPECS: readonly ModelParamSpec[] = novelAiParamSpecs('v5')
export const NOVELAI_V45_PARAM_SPECS: readonly ModelParamSpec[] = novelAiParamSpecs('v45')

/** 某个 NovelAI 模型对应的参数表;不是 NovelAI 返回空数组。 */
export function novelAiParamSpecsForModel(id: unknown): readonly ModelParamSpec[] {
  const family = novelAiFamilyOfModel(id)
  if (family === 'v5') return NOVELAI_V5_PARAM_SPECS
  if (family === 'v45') return NOVELAI_V45_PARAM_SPECS
  return []
}

// ───────────────────────── GPT Image 2.6(apiyi 官转) ─────────────────────────

/**
 * apiyi 官转的 2.6 两条(flare / sunburst)。腾讯的 2.6 两条见 `TENCENT_IMAGE_26_MODEL_IDS`:
 * 同一个上游模型、同一条拼图规则,但 SVG 写手合同不同(`svg.model` 固定 + `reasoning.effort`),
 * GIF 每帧上限也不同(费用随拼图面积走),所以是另一个「家族」,不混进这张表。
 */
export const GPT_IMAGE_26_MODEL_IDS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const

/**
 * 腾讯 TokenHub og-image 上的 2.6 两条(默认渠道 `-s` 就在这里)。
 * 2026-11-09 经 Miau 生产网关实测:GIF / SVG 都能出,结果是带真实后缀(`.gif` / `.svg`)与
 * 正确 Content-Type 的 URL;与 sora-ui #324 / sora-ui-backend #177(画布)同一份合同。
 */
export const TENCENT_IMAGE_26_MODEL_IDS = ['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s'] as const

/** 能出 GIF / SVG 的两个家族:apiyi 官转(`svg_model`)与腾讯(`svg_effort`)。 */
export type GifSvgFamily = 'apiyi' | 'tokenhub'

export function isTencentImage26Model(id: unknown): boolean {
  return typeof id === 'string' && (TENCENT_IMAGE_26_MODEL_IDS as readonly string[]).includes(id)
}

/** 模型属于哪个 GIF / SVG 家族;不能出 GIF / SVG 的模型返回 null。 */
export function gifSvgFamilyOf(id: unknown): GifSvgFamily | null {
  if (isGptImage26Model(id)) return 'apiyi'
  if (isTencentImage26Model(id)) return 'tokenhub'
  return null
}

/**
 * GIF 帧数上限。apiyi 文档写的是 2–64,**2026-11-09 实测上游只认 2–16**:超过 16 时报 400,
 * 或者**静默丢掉整份 GIF 配置**(17 / 32 / 64 帧的请求回来的是默认的 9 帧 / 200 ms,而且照常收费)。
 */
export const GIF_MAX_FRAME_COUNT = 16
/** 不填帧数时上游的默认帧数。 */
const GIF_DEFAULT_FRAME_COUNT = 9
/** 拼图总像素预算 = 3840 × 2160(实测:恰好等于预算放行,多一点就 400)。 */
export const GIF_SHEET_MAX_PIXELS = 3840 * 2160
/**
 * 每帧最长边的上限,按家族:
 * - apiyi 960:拼图最长边 ≤ 3840,4 列 × 960 恰好顶满(实测的最大值);
 * - 腾讯 512:同一条拼图规则(2 帧 960² ✓、16 帧 720² ✓),但**费用随拼图面积走**,默认画质
 *   (high)下 512² 9 帧 ≈ ¥0.51,960 上限要贵 4–5 倍,所以与画布(sora-ui #324)一致取 512。
 */
export const GIF_FRAME_LONG_EDGE: Record<GifSvgFamily, number> = { apiyi: 960, tokenhub: 512 }

/**
 * GIF 的「每帧尺寸」:把 App 按 1K / 2K / 4K 档(1280² 起)给的尺寸收进上游的拼图预算。
 *
 * 上游把所有帧拼成一张 sprite sheet 再编码(2026-11-09 实测):≤ 8 帧按 4×2(或 2×4)、
 * 9 帧 3×3、16 帧 4×4;整张拼图要 ≤ 3840 × 2160 像素且最长边 ≤ 3840。所以 2 帧 1280² 就是
 * 400「No supported sheet fits 2 GIF frames…」。实测方图每帧:2 / 4 帧 960 ✓ 1024 ✗;
 * 9 帧 960 ✓ 1024 ✗;16 帧 640 ✓。10–15 帧的网格没逐个验,按 16 格(最保守)算。
 *
 * 规则:比例不变、向下取 16 的倍数、不放大、最长边 ≤ `longEdgeCap`(apiyi 960 / 腾讯 512,
 * 见 `GIF_FRAME_LONG_EDGE`)、拼图像素不超预算。不传上限 = apiyi 的 960。
 * 没有尺寸(比例 auto)/ 认不出时当 1024² 方图 —— 不能留给上游自己挑(它默认的 1024² 也超)。
 */
export function gifSafeSize(
  size: string | undefined,
  frameCount: number | undefined,
  longEdgeCap: number = GIF_FRAME_LONG_EDGE.apiyi,
): string {
  const frames =
    typeof frameCount === 'number' && Number.isFinite(frameCount) && frameCount >= 1
      ? Math.round(frameCount)
      : GIF_DEFAULT_FRAME_COUNT
  const cells = frames <= 8 ? 8 : frames === 9 ? 9 : 16
  const parsed = typeof size === 'string' ? /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim()) : null
  const w0 = parsed ? Number(parsed[1]) : 1024
  const h0 = parsed ? Number(parsed[2]) : 1024
  if (!(w0 > 0 && h0 > 0)) return gifSafeSize(undefined, frameCount, longEdgeCap)
  const scale = Math.min(
    1,
    longEdgeCap / Math.max(w0, h0),
    Math.sqrt(GIF_SHEET_MAX_PIXELS / cells / (w0 * h0)),
  )
  // +1e-6:960 / 2880 这类除出来的浮点误差不能让整除的边多掉一格(959.9999… → 944)。
  const snap = (v: number) => Math.max(16, Math.floor((v * scale + 1e-6) / 16) * 16)
  return `${snap(w0)}x${snap(h0)}`
}

export function isGptImage26Model(id: unknown): boolean {
  return typeof id === 'string' && (GPT_IMAGE_26_MODEL_IDS as readonly string[]).includes(id)
}

/** apiyi:SVG 必须带写手模型(上游文档要求);用户没挑时用实测过的这个(最快 ≈ 18 s,便宜)。 */
export const GPT_IMAGE_26_DEFAULT_SVG_MODEL = 'gpt-4.1-mini'

/**
 * 腾讯:SVG 写手固定 `gpt-5.4-mini`(与画布同口径,实测 low 推理 ≈ ¥0.24、27 s)。
 * **别换成 apiyi 的 `gpt-4.1-mini`**:它在腾讯上也能出图,但同样的 1K / low 实测 ≈ ¥0.80,
 * 是这条的 3.4 倍(费用随写手模型的 token 走)。
 */
export const TENCENT_IMAGE_26_SVG_MODEL = 'gpt-5.4-mini'
/** 腾讯 SVG 推理强度的默认档(上游文档示例也用 low)。 */
export const TENCENT_IMAGE_26_DEFAULT_SVG_EFFORT = 'low'

/**
 * 两家共用的三项(界面 / MCP 引用同一份对象,不会各说各话)。
 * 三条硬规则都来自上游文档 + 实测,**不静默纠正**(按 token 计费,悄悄改成别的格式出一张图
 * 用户还要付钱):
 * - GIF 才有帧数 / 每帧时长(PNG / SVG 上带了上游会报错或悄悄忽略);
 * - SVG 才有写手选项(apiyi 选写手模型,腾讯选推理强度);
 * - GIF / SVG 都只走文生图、一次一张(这部分在 `ApiService` 的请求校验里,需要数量 / 参考图上下文)。
 */
const GIF_SVG_COMMON_SPECS: readonly ModelParamSpec[] = [
  {
    key: 'output_format',
    label: '输出格式',
    type: 'select',
    description: '不设 = PNG;GIF / SVG 仅文生图、单张',
    options: [
      { key: 'png', label: 'PNG(默认)' },
      { key: 'gif', label: 'GIF 动图' },
      { key: 'svg', label: 'SVG 矢量' },
    ],
  },
  {
    key: 'frame_count',
    label: 'GIF 帧数',
    type: 'number',
    description: '仅 GIF:2–16,不填 = 9 帧。画幅自动收小,不随 1K–4K 档',
    advanced: true,
    min: 2,
    max: GIF_MAX_FRAME_COUNT,
    integer: true,
  },
  {
    key: 'frame_duration_ms',
    label: 'GIF 每帧时长(毫秒)',
    type: 'number',
    description: '仅 GIF:20–2000(按 10),不填 = 200',
    advanced: true,
    min: 20,
    max: 2000,
    integer: true,
    step: 10,
  },
]

/**
 * apiyi 官转 2.6(flare / sunburst)的 GIF / SVG 参数表。
 * 费用提示:SVG 的写手模型费用上游没有回传(响应里看不到 `svg_usage`),网关只按出图 token 收费。
 */
export const GPT_IMAGE_26_PARAM_SPECS: readonly ModelParamSpec[] = [
  ...GIF_SVG_COMMON_SPECS,
  {
    key: 'svg_model',
    label: 'SVG 写手模型',
    type: 'select',
    description: '仅 SVG(apiyi):写手模型',
    advanced: true,
    options: [
      { key: GPT_IMAGE_26_DEFAULT_SVG_MODEL, label: 'gpt-4.1-mini(默认,快)' },
      { key: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
      { key: 'gpt-6-luna', label: 'gpt-6-luna' },
    ],
  },
]

/**
 * 腾讯 2.6(custom-model-og-v2.6-f / -s)的 GIF / SVG 参数表。
 * 不开 JPEG / complexity:前者与透明底互斥、要在编辑路径上再接一遍输出格式;后者上游实测
 * 对 token 与画面都没有可见影响(sora-ui-backend #177 同结论),没有可验证的效果就不开。
 */
export const TENCENT_IMAGE_26_PARAM_SPECS: readonly ModelParamSpec[] = [
  ...GIF_SVG_COMMON_SPECS,
  {
    key: 'svg_effort',
    label: 'SVG 推理强度',
    type: 'select',
    description: '仅 SVG(腾讯):none 最快 / low 默认,更高档不开放',
    advanced: true,
    options: [
      { key: 'none', label: 'none(最快,细节较少)' },
      { key: TENCENT_IMAGE_26_DEFAULT_SVG_EFFORT, label: 'low(默认)' },
    ],
  },
]

/**
 * agent / MCP 显式要 GIF / SVG(或只给了 GIF / SVG 专属参数),但落在了不支持的模型上。
 *
 * `ApiService` 对没声明这些键的模型会静默丢掉 `modelParams` —— 对「生成页里残留的旧值」是对的
 * (用户看不见也清不掉,不该为它们报错),对 agent 是坑:它明确要了动图,却悄悄拿到一张 PNG。
 * 所以只在 agent 入口调用:返回中文原因(含可用的模型 id,方便它自己改正),null = 放行。
 * `output_format: 'png'` / 没设 / 别的模型的别的参数都放行。
 *
 * 写手选项两家不同(apiyi `svg_model` / 腾讯 `svg_effort`):串了键同样会被丢掉,
 * agent 以为选了写手 / 推理强度,其实没生效 —— 所以也在这里拒绝并指向正确的键。
 */
export function gifSvgUnsupportedReason(model: unknown, modelParams: unknown): string | null {
  if (!modelParams || typeof modelParams !== 'object') return null
  const raw = modelParams as Record<string, unknown>
  const isSet = (v: unknown) => v !== undefined && v !== null && v !== ''
  const family = gifSvgFamilyOf(model)

  if (family === 'tokenhub' && isSet(raw.svg_model)) {
    return '腾讯 2.6 的 SVG 写手固定为 gpt-5.4-mini,不认 svg_model:要调推理强度请用 svg_effort(none / low),否则去掉 svg_model。'
  }
  if (family === 'apiyi' && isSet(raw.svg_effort)) {
    return 'apiyi 官转 2.6 的 SVG 用 svg_model 选写手模型,不认 svg_effort:请改用 svg_model,或去掉 svg_effort。'
  }
  if (family) return null

  const wantsMotionOrVector = raw.output_format === 'gif' || raw.output_format === 'svg'
  const hasOnlyKey = ['frame_count', 'frame_duration_ms', 'svg_model', 'svg_effort'].some((k) => isSet(raw[k]))
  if (!wantsMotionOrVector && !hasOnlyKey) return null
  const ids = [...GPT_IMAGE_26_MODEL_IDS, ...TENCENT_IMAGE_26_MODEL_IDS].join(' 或 ')
  return `GIF / SVG 输出目前只有 GPT Image 2.6(apiyi 官转与腾讯渠道)支持：请把 model 设为 ${ids}（当前模型 ${String(model ?? '默认渠道')} 不支持，不改的话只会得到普通 PNG）。`
}

export type GptImage26Output = 'png' | 'gif' | 'svg'

/** 已通过 `resolveModelParams` 的值里,这次请求要的输出格式。没设 = png。 */
export function gptImage26OutputOf(values: ModelParamValues | undefined): GptImage26Output {
  const f = values?.output_format
  return f === 'gif' || f === 'svg' ? f : 'png'
}

/**
 * 平铺的参数值 → 请求体里要**额外**铺的字段(嵌套形状只在这里翻译一次,按家族):
 * - apiyi:`svg: { model }`;
 * - 腾讯:`svg: { model: 'gpt-5.4-mini', reasoning: { effort } }`。
 * 返回 `{error}` 时调用方必须拒绝,不要带病外发。
 */
export function resolveGifSvgFields(
  values: ModelParamValues,
  family: GifSvgFamily,
): { fields: Record<string, unknown> } | { error: string } {
  const format = gptImage26OutputOf(values)
  const has = (key: string) => values[key] !== undefined && values[key] !== null

  if (format !== 'gif' && (has('frame_count') || has('frame_duration_ms'))) {
    return { error: '「GIF 帧数 / 每帧时长」只在输出格式为 GIF 时可用,请把输出格式改成 GIF,或清掉这两项' }
  }
  const svgOnly = family === 'tokenhub' ? { key: 'svg_effort', label: 'SVG 推理强度' } : { key: 'svg_model', label: 'SVG 写手模型' }
  if (format !== 'svg' && has(svgOnly.key)) {
    return { error: `「${svgOnly.label}」只在输出格式为 SVG 时可用,请把输出格式改成 SVG,或清掉这一项` }
  }

  if (format === 'gif') {
    const fields: Record<string, unknown> = { output_format: 'gif' }
    if (has('frame_count')) fields.frame_count = values.frame_count
    if (has('frame_duration_ms')) fields.frame_duration_ms = values.frame_duration_ms
    return { fields }
  }
  if (format === 'svg') {
    if (family === 'tokenhub') {
      const effort = typeof values.svg_effort === 'string' ? values.svg_effort : TENCENT_IMAGE_26_DEFAULT_SVG_EFFORT
      return { fields: { output_format: 'svg', svg: { model: TENCENT_IMAGE_26_SVG_MODEL, reasoning: { effort } } } }
    }
    const model = typeof values.svg_model === 'string' ? values.svg_model : GPT_IMAGE_26_DEFAULT_SVG_MODEL
    return { fields: { output_format: 'svg', svg: { model } } }
  }
  return { fields: {} }
}

/** apiyi 家族的 `resolveGifSvgFields`(保留旧名,已有调用方不变)。 */
export function resolveGptImage26Fields(
  values: ModelParamValues,
): { fields: Record<string, unknown> } | { error: string } {
  return resolveGifSvgFields(values, 'apiyi')
}

// ───────────────────────── 校验 / 默认值 ─────────────────────────

/** 「没填」:undefined / null / 空串 / 空数组 / 全空白。这类值一律当作不设置,不是错误。 */
function isUnset(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** urls 既接受数组也接受「每行一个」的多行文本(界面里的 textarea)。 */
function toUrlList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) return null
    return (value as string[]).map((v) => v.trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return null
}

const HTTP_URL = /^https?:\/\/\S+$/i

function validateOne(spec: ModelParamSpec, raw: unknown): { ok: true; value: ModelParamValue } | { ok: false; error: string } {
  const fail = (reason: string) => ({ ok: false as const, error: `「${spec.label}」${reason}` })

  switch (spec.type) {
    case 'switch':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail('必须是开 / 关')

    case 'select': {
      const options = spec.options ?? []
      const text = String(raw).trim()
      if (!options.some((o) => o.key === text)) {
        return fail(`只能取 ${options.map((o) => o.key).join(' / ')}`)
      }
      if (spec.valueType === 'number') {
        const n = Number(text)
        return Number.isFinite(n) ? { ok: true, value: n } : fail('不是有效数字')
      }
      return { ok: true, value: text }
    }

    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN
      if (!Number.isFinite(n)) return fail('必须是数字')
      if (spec.integer && !Number.isInteger(n)) return fail('必须是整数')
      if (typeof spec.min === 'number' && n < spec.min) return fail(`不能小于 ${spec.min}`)
      if (typeof spec.max === 'number' && n > spec.max) return fail(`不能大于 ${spec.max}`)
      return { ok: true, value: n }
    }

    case 'text': {
      if (typeof raw !== 'string') return fail('必须是文本')
      const text = raw.trim()
      if (typeof spec.maxLength === 'number' && text.length > spec.maxLength) {
        return fail(`不能超过 ${spec.maxLength} 个字符`)
      }
      if (spec.forbidDashFlags && text.includes('--')) {
        return fail('里不能写 -- 开头的参数，版本 / 速度由所选模型决定')
      }
      return { ok: true, value: text }
    }

    case 'urls': {
      const list = toUrlList(raw)
      if (!list) return fail('必须是链接列表')
      if (typeof spec.maxItems === 'number' && list.length > spec.maxItems) {
        return fail(`最多 ${spec.maxItems} 个，当前 ${list.length} 个`)
      }
      const bad = list.find((u) => !HTTP_URL.test(u))
      if (bad) return fail(`只接受 http/https 链接：${bad.slice(0, 80)}`)
      return { ok: true, value: list }
    }

    case 'characters': {
      const checked = coerceCharacters(spec, raw)
      return typeof checked === 'string' ? fail(checked) : { ok: true, value: checked }
    }
  }
}

const CHARACTER_DEFAULT_MAX_ITEMS = 22
const CHARACTER_DEFAULT_POSITION = 0.5

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 角色提示词列表归一。**返回字符串 = 错误原因**(由 `validateOne` 加上「角色提示词」前缀)。
 *
 * 错误里的序号 N 是**原始数组**的 1-based 下标(含被丢弃的草稿),这样用户在界面上数到第几个
 * 角色,报错就指向第几个;条数上限则按丢弃草稿之后的数量算。
 * 位置必须是真数字:字符串 "0.3" 在画面坐标里没有合理来源,宁可拒绝也不猜。
 */
function coerceCharacters(spec: ModelParamSpec, raw: unknown): CharacterParamValue[] | string {
  if (!Array.isArray(raw)) return '必须是列表'
  const out: CharacterParamValue[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw[index]
    const no = index + 1
    if (!isPlainObject(item)) return `里的角色 ${no} 格式不正确`
    if (item.enabled === false) continue

    if (item.prompt !== undefined && item.prompt !== null && typeof item.prompt !== 'string') {
      return `里角色 ${no} 的提示词必须是文本`
    }
    if (item.uc !== undefined && item.uc !== null && typeof item.uc !== 'string') {
      return `里角色 ${no} 的负面提示词必须是文本`
    }
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    const uc = typeof item.uc === 'string' ? item.uc.trim() : ''
    // 提示词和负面都没写:界面上新增后没填的空行,不算用户的输入。
    if (!prompt && !uc) continue
    // 只写了负面没写提示词:上游没法定位这是个什么角色,必须报错而不是悄悄丢掉。
    if (!prompt) return `里角色 ${no} 的提示词不能为空`
    if (Array.from(prompt).length > NOVELAI_CHARACTER_PROMPT_MAX_CHARS) {
      return `里角色 ${no} 的提示词最长 ${NOVELAI_CHARACTER_PROMPT_MAX_CHARS} 个字符`
    }
    if (Array.from(uc).length > NOVELAI_CHARACTER_UC_MAX_CHARS) {
      return `里角色 ${no} 的负面提示词最长 ${NOVELAI_CHARACTER_UC_MAX_CHARS} 个字符`
    }

    const position = (axis: 'x' | 'y'): number | null => {
      const v = item[axis]
      if (v === undefined || v === null) return CHARACTER_DEFAULT_POSITION
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
    }
    const x = position('x')
    const y = position('y')
    if (x === null) return `里角色 ${no} 的位置 x 必须是 0–1 之间的数字`
    if (y === null) return `里角色 ${no} 的位置 y 必须是 0–1 之间的数字`

    out.push({ prompt, ...(uc ? { uc } : {}), x, y })
  }

  const max = spec.maxItems ?? CHARACTER_DEFAULT_MAX_ITEMS
  if (out.length > max) return `最多 ${max} 个，当前 ${out.length} 个`
  return out
}

export interface ResolvedModelParams {
  /** 可直接铺进请求体顶层的键值(默认值 + 用户值,已校验 / 已规整类型)。 */
  values: ModelParamValues
  /** 校验失败的原因,逐条中文。非空时调用方应当拒绝这次请求,而不是带病外发。 */
  errors: string[]
}

/**
 * 默认值 + 用户值 → 外发值。
 *
 * - spec 里没声明的键直接丢弃(切模型后残留的旧值、agent 手滑多给的字段,都不该外发);
 * - 「没填」的值当作不设置:既不报错也不覆盖默认(`hd: undefined` 仍是默认开);
 * - **用户显式给的 `false` 要赢过 `defaultValue: true`**,所以判断用 `isUnset` 而不是 truthy;
 * - 声明了但值不合法 → 记进 `errors`。不静默纠正:悠船按次计费,把 `chaos: 500` 悄悄改成 100
 *   出一张图,用户拿到的是与自己设置不符的结果还要付钱。
 */
export function resolveModelParams(
  specs: readonly ModelParamSpec[] | undefined,
  input: Record<string, unknown> | undefined,
): ResolvedModelParams {
  const values: ModelParamValues = {}
  const errors: string[] = []
  if (!specs || specs.length === 0) return { values, errors }

  for (const spec of specs) {
    if (spec.defaultValue !== undefined) values[spec.key] = spec.defaultValue
    const raw = input?.[spec.key]
    if (isUnset(raw)) continue
    const checked = validateOne(spec, raw)
    if (checked.ok) values[spec.key] = checked.value
    else errors.push(checked.error)
  }
  return { values, errors }
}

/** 某个值是否等于该 spec 的默认(含「没有默认且未设置」)。界面用它决定要不要亮「已修改」。 */
export function isModelParamDefault(spec: ModelParamSpec, value: unknown): boolean {
  if (isUnset(value)) return true
  if (spec.defaultValue === undefined) return false
  return JSON.stringify(value) === JSON.stringify(spec.defaultValue)
}
