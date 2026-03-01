import type { StoryboardResponse } from '../LangChainStoryboardService'

// ==================== 回避层常量 ====================

export const DODGE_LAYERS = {
  MOTION_BLUR: 'motion blur on intimate zone, soft mist overlay',
  SHADOW_VEIL: 'artistic deep shadows obscuring contact, chiaroscuro low-key lighting',
  FABRIC_DISSOLVE: 'sheer fabric dissolve artistically, clothing silhouette implication',
  STEAM_FOG: 'atmospheric steam/fog diffusion covering lower body',
  DEPTH_BLUR: 'extreme shallow DOF f/1.2, bokeh dissolve on sensitive area',
  LIGHT_FLARE: 'volumetric light flare washing out explicit detail, lens bloom'
} as const

// ==================== 危险词→安全替换 (中英文) ====================

interface ReplacementRule {
  pattern: RegExp
  safe: string
}

const RISKY_REPLACEMENTS: ReplacementRule[] = [
  // ---- 中文 ----
  { pattern: /性交|做爱|交合/g, safe: '亲密交融' },
  { pattern: /插入|进入体内/g, safe: '深度连接' },
  { pattern: /抽插|抽送|冲撞/g, safe: '律动起伏' },
  { pattern: /射精|射了|高潮/g, safe: '颤栗释放' },
  { pattern: /阴茎|阳具|肉棒/g, safe: '身体轮廓' },
  { pattern: /阴道|私处|下体/g, safe: '隐秘轮廓' },
  { pattern: /乳房|胸部|奶/g, safe: '曲线' },
  { pattern: /乳头|乳晕/g, safe: '肌肤纹理' },
  { pattern: /裸体|全裸|赤裸/g, safe: '肌肤裸露' },
  { pattern: /口交|舔舐/g, safe: '唇部亲昵' },
  { pattern: /自慰|手淫/g, safe: '自我抚触' },
  { pattern: /呻吟|淫叫/g, safe: '气息急促' },
  { pattern: /湿润|淫液|体液/g, safe: '光泽质感' },
  { pattern: /勃起|肿胀/g, safe: '张力隆起' },
  { pattern: /强奸|强暴/g, safe: '强制压制' },
  { pattern: /\bSM\b|虐待/g, safe: '权力交换' },

  // ---- English ----
  { pattern: /\b(fucking|sex|intercourse|copulat\w*)\b/gi, safe: 'intimacy' },
  { pattern: /\b(thrusting|pounding|banging|hammering)\b/gi, safe: 'rhythmic pulsing' },
  { pattern: /\b(penetrat\w*|insert\w*)\b/gi, safe: 'deep connection' },
  { pattern: /\b(cum|semen|ejaculat\w*|sperm|orgasm|climax)\b/gi, safe: 'shuddering release' },
  { pattern: /\b(cock|dick|penis)\b/gi, safe: 'body contour' },
  { pattern: /\b(vagina|pussy|cunt)\b/gi, safe: 'intimate silhouette' },
  { pattern: /\b(nipples?|tits|boobs|breasts?)\b/gi, safe: 'curves' },
  { pattern: /\b(naked|nude)\b/gi, safe: 'bare skin' },
  { pattern: /\b(sucking|licking|blowjob|oral)\b/gi, safe: 'devotion' },
  { pattern: /\b(masturbat\w*)\b/gi, safe: 'self-caress' },
  { pattern: /\b(moan\w*|groan\w*|scream\w*)\b/gi, safe: 'breathless gasp' },
  { pattern: /\b(erect\w*|swollen)\b/gi, safe: 'tension rising' },
  { pattern: /\b(rape|assault)\b/gi, safe: 'forced restraint' },
]

// ==================== 核心净化函数 ====================

function sanitizeText(text: string): string {
  let result = text
  for (const rule of RISKY_REPLACEMENTS) {
    result = result.replace(rule.pattern, rule.safe)
  }
  return result
}

/**
 * 为镜头描述注入回避层修饰。
 * 当检测到镜头涉及亲密/暴力内容时，附加艺术化回避指令。
 */
function injectDodgeLayer(desc: string): string {
  const intimacySignals = /亲密|交融|律动|压制|裸露|肌肤|bare skin|intimacy|rhythmic|restrain/i
  if (intimacySignals.test(desc)) {
    return `${desc} | ${DODGE_LAYERS.SHADOW_VEIL}, ${DODGE_LAYERS.DEPTH_BLUR}`
  }
  return desc
}

// ==================== 对外接口 ====================

/**
 * 对整个 StoryboardResponse 执行两轮净化：
 * 1. 危险词替换（中英文）
 * 2. 回避层注入（仅 seq.desc）
 */
export function sanitizeStoryboardResponse(response: StoryboardResponse): StoryboardResponse {
  return {
    ...response,
    scene: {
      ...response.scene,
      d: sanitizeText(response.scene.d),
      cap: sanitizeText(response.scene.cap),
    },
    objs: response.objs.map(obj => ({
      ...obj,
      f: sanitizeText(obj.f),
      act: sanitizeText(obj.act),
      motive: sanitizeText(obj.motive),
    })),
    seq: response.seq.map(s => ({
      ...s,
      desc: injectDodgeLayer(sanitizeText(s.desc)),
    })),
    notes: sanitizeText(response.notes),
  }
}

/**
 * 仅对纯文本执行危险词替换（供外部单独调用）。
 */
export { sanitizeText }
