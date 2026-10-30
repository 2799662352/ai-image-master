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
