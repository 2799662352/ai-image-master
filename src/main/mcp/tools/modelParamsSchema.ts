import { z } from 'zod'
import {
  NOVELAI_V5_PARAM_SPECS,
  YOUCHUAN_V8_PARAM_SPECS,
  type ModelParamSpec,
} from '../../../shared/imageModelParams'

/**
 * 把 `shared/imageModelParams` 的参数表转成 MCP 的 zod schema。
 *
 * 为什么不手写:参数表是界面(生成页面板)、请求体装配(`ApiService`)、这里(agent 能传什么)
 * 三处共用的唯一事实来源。手抄一份 zod 的后果是加 / 改一个参数时漏掉一边 —— 界面能设、agent
 * 传不了,或反过来 agent 传得了却被 `ApiService` 拒掉,而且都不报「少了这个字段」。
 * 守卫测试 `imageTools.test.ts` 钉住「schema 的键 = 参数表的键」。
 *
 * 取值范围写在 schema 里,是为了让不合法的值**在 agent 一侧就被拒并带上原因**(MCP 校验失败会
 * 把字段名和范围回给模型),而不是走到渲染层、计费前才被 `ApiService` 退回。两边规则同源,
 * 但 `ApiService` 那道仍保留 —— 它是真正出网前的最后一关,也是界面入口的唯一一关。
 */
function specToZod(spec: ModelParamSpec): z.ZodType {
  const desc = [spec.label, spec.description].filter(Boolean).join(' — ')

  switch (spec.type) {
    case 'switch':
      return z.boolean().describe(desc)

    case 'select': {
      const keys = (spec.options ?? []).map((o) => o.key)
      // 数字档位(如质量 1 / 4)模型常会传成数字:字符串和数字两种写法都收,
      // 由 resolveModelParams 统一规整,免得 agent 因为一个引号被退回。
      const members: z.ZodType[] = [z.enum(keys as [string, ...string[]])]
      for (const k of keys) {
        const n = Number(k)
        if (Number.isFinite(n) && String(n) === k) members.push(z.literal(n))
      }
      const schema = members.length === 1 ? members[0] : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]])
      return schema.describe(desc)
    }

    case 'number': {
      let n = spec.integer ? z.number().int() : z.number()
      if (typeof spec.min === 'number') n = n.min(spec.min)
      if (typeof spec.max === 'number') n = n.max(spec.max)
      const range =
        typeof spec.min === 'number' && typeof spec.max === 'number' && !desc.includes(`${spec.min}–${spec.max}`)
          ? ` (${spec.min}–${spec.max})`
          : ''
      return n.describe(`${desc}${range}`)
    }

    case 'text': {
      let s = z.string()
      if (typeof spec.maxLength === 'number') s = s.max(spec.maxLength)
      return s.describe(desc)
    }

    case 'urls': {
      let a = z.array(z.string())
      if (typeof spec.maxItems === 'number') a = a.max(spec.maxItems)
      return a.describe(/https?/i.test(desc) ? desc : `${desc}. http/https URLs only`)
    }

    case 'characters': {
      // 每个角色:提示词必填(留空的草稿行是界面概念,agent 不该传),位置缺省居中。
      // 键名与网关 `character_prompts` 的 {prompt, uc, center:{x,y}} 对应,装配在 ApiService。
      const character = z.strictObject({
        prompt: z.string().min(1).max(2000),
        uc: z.string().max(1000).optional().describe('Avoid list for THIS character'),
        x: z.number().min(0).max(1).optional().describe('0 = left … 1 = right (default 0.5)'),
        y: z.number().min(0).max(1).optional().describe('0 = top … 1 = bottom (default 0.5)'),
      })
      let a = z.array(character)
      if (typeof spec.maxItems === 'number') a = a.max(spec.maxItems)
      return a.describe(desc)
    }
  }
}

/**
 * 参数表 → `modelParams` 字段的 zod schema。`strictObject`:agent 写错键名(比如把 `stylize`
 * 写成 `stylise`)时直接回「不认识的键」,比静默忽略、白出一张没带这个参数的图强。
 * 每个键都是可选的 —— 不传 = 由模型自动决定。
 */
export function buildModelParamsSchema(
  specs: readonly ModelParamSpec[],
  intro: string,
): z.ZodOptional<z.ZodObject<Record<string, z.ZodOptional<z.ZodType>>>> {
  const shape: Record<string, z.ZodOptional<z.ZodType>> = {}
  for (const spec of specs) shape[spec.key] = specToZod(spec).optional()
  return z.strictObject(shape).optional().describe(intro) as z.ZodOptional<
    z.ZodObject<Record<string, z.ZodOptional<z.ZodType>>>
  >
}

/**
 * agent 的 `modelParams` 说明。悠船的参数绝大多数时候**不该设**:Midjourney 默认值已经调得
 * 很好,乱设混沌 / 风格化只会让用户拿到「与描述不符」的图还照样扣费(一次 4 张的价)。
 * 所以文案把「默认别设、用户明确要求才设」放在最前面。
 */
export const YOUCHUAN_MODEL_PARAMS_INTRO =
  'Model-specific options for the 悠船 (Midjourney) channels ONLY — model="youchuan-v8.2" (快速) or ' +
  '"youchuan-v8.2-turbo" (极速); IGNORED by every other channel. LEAVE THIS OUT in normal use: every key ' +
  'is optional and an unset key is decided by the model itself (Midjourney\'s defaults are already ' +
  'tuned). Set a key ONLY when the user explicitly asks for that effect — e.g. 更疯狂/更有创意 → chaos, ' +
  '更艺术/更强风格 → stylize, 更克制/更贴近描述 → low stylize, 原始/少加工 → raw:true, 按这张图的画风 → ' +
  'sref (+ sw), 不要某元素 → no. Each generate call returns 4 images and is billed ONCE. ' +
  '`hd` (native 2K, default ON, billed ×1.5) is the only key with a default — pass hd:false only when the ' +
  'user asks for a cheaper / draft render. Out-of-range values are REJECTED (never clamped) with the ' +
  'reason, so fix the value instead of retrying unchanged. Version and speed come from `model`, never ' +
  'from the prompt: do NOT write --v / --turbo / --fast inside the prompt or `no`. Resolution tiers ' +
  '(`resolution`) and `count` do not apply — use `hd` instead.'

/** generate_image / generate_images 共用的悠船 `modelParams` schema。 */
export function buildYouchuanModelParamsSchema() {
  return buildModelParamsSchema(YOUCHUAN_V8_PARAM_SPECS, YOUCHUAN_MODEL_PARAMS_INTRO)
}

/**
 * NovelAI 的 `modelParams` 说明。与悠船相反,这里的默认值**已经是产品默认**(23 步 / CFG 5 /
 * Euler Ancestral / karras / anime),不设就是它们 —— 所以同样「用户明确要求才设」,
 * 但不必担心「默认缺失」。
 */
export const NOVELAI_MODEL_PARAMS_INTRO =
  'Options for the NovelAI channels ONLY — model="nai-diffusion-5-full" | "nai-diffusion-5-curated" | ' +
  '"nai-diffusion-4-5-full" | "nai-diffusion-4-5-curated". Every key is optional and already has a sensible ' +
  'default — set a key ONLY when the user asks for that effect: 兽人/furry → dataset_mode:"furry"; 不要某元素 → ' +
  'negative_prompt; 画面里有 N 个角色、要各自描述并放在指定位置 → `characters` (at most 22 on V5, 6 on ' +
  'V4.5; keep the shared scene description in `prompt`); 图生图 → exactly ONE http(s) image in ' +
  '`referenceImages` plus `img2img_strength` / `img2img_noise` (both ignored without a reference). Size ' +
  'comes from `ratio` (1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 16:9 / 9:16; "auto" = 1:1) and `resolution` ("1K" / ' +
  '"2K", same price); `count` 1–4 is billed PER IMAGE. Out-of-range values are REJECTED (never clamped).'

/**
 * 合并多份参数表(同键取第一份)。悠船与 NovelAI 只有 `seed` 重名,且定义一致;若将来出现
 * 同名不同义的键,`imageTools.test.ts` 的「合并后键 = 两份参数表的并集」守卫不会拦它,
 * 所以重名只许是同义 —— 新增重名键前先改成带前缀的键。
 */
function mergeParamSpecs(...tables: ReadonlyArray<readonly ModelParamSpec[]>): ModelParamSpec[] {
  const seen = new Set<string>()
  const merged: ModelParamSpec[] = []
  for (const table of tables) {
    for (const spec of table) {
      if (seen.has(spec.key)) continue
      seen.add(spec.key)
      merged.push(spec)
    }
  }
  return merged
}

/** 全部「渠道专属参数」键的并集:悠船 + NovelAI(V5 表,角色上限取较大的 22,V4.5 的 6 由 ApiService 校验)。 */
export const ALL_CHANNEL_PARAM_SPECS: readonly ModelParamSpec[] = mergeParamSpecs(
  YOUCHUAN_V8_PARAM_SPECS,
  NOVELAI_V5_PARAM_SPECS,
)

export const ALL_CHANNEL_MODEL_PARAMS_INTRO =
  'Options for TWO channel families — pass only the keys of the channel you are rendering on; each part ' +
  'below is IGNORED by every other channel. ' +
  `\n\n[悠船 / Midjourney] ${YOUCHUAN_MODEL_PARAMS_INTRO}` +
  `\n\n[NovelAI] ${NOVELAI_MODEL_PARAMS_INTRO}`

/** generate_image / generate_images 共用的 `modelParams` schema(悠船 + NovelAI)。 */
export function buildChannelModelParamsSchema() {
  return buildModelParamsSchema(ALL_CHANNEL_PARAM_SPECS, ALL_CHANNEL_MODEL_PARAMS_INTRO)
}
