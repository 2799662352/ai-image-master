/**
 * Gemini API 错误处理器
 * 基于 7 步判断流程解析 Gemini generateContent 响应，
 * 区分内容安全拒绝、知识库限制、技术错误等，提供用户友好提示。
 */

// ==================== 类型定义 ====================

export interface GeminiErrorResult {
  success: false
  errorType:
    | 'ZERO_CANDIDATES_TOKEN'
    | 'NO_CANDIDATES'
    | 'FINISH_REASON'
    | 'NO_PARTS'
    | 'TEXT_RESPONSE'
    | 'UNKNOWN'
  userMessage: string
  suggestions: string[]
  devMessage: string
  finishReason?: string
  apiText?: string
  detectedType?: string | null
  rawResponse?: any
}

export interface GeminiSuccessResult {
  success: true
  images: string[]
  texts: string[]
}

export type GeminiResult = GeminiSuccessResult | GeminiErrorResult

export type DetectedContentType =
  | 'nsfw'
  | 'watermark_removal'
  | 'faceswap'
  | 'copyright'
  | 'knowledge_limit'
  | 'financial_modification'
  | 'celebrity'
  | 'minor'
  | 'general_rejection'
  | null

// ==================== 常量映射 ====================

const FINISH_REASON_MAP: Record<string, { userMessage: string; suggestions: string[] }> = {
  PROHIBITED_CONTENT: {
    userMessage: '内容违反安全策略，已被拒绝处理',
    suggestions: ['请使用健康、正面的描述', '避免涉及敏感话题', '重新调整提示词后再试']
  },
  SAFETY: {
    userMessage: '内容触发了安全过滤器',
    suggestions: ['请检查提示词和参考图是否包含敏感内容', '尝试使用更温和的描述']
  },
  IMAGE_SAFETY: {
    userMessage: '生成的图片未通过安全审核',
    suggestions: ['尝试调整描述方式', '避免涉及暴力、色情等不适当内容', '使用更委婉的表达']
  },
  RECITATION: {
    userMessage: '内容可能涉及版权问题',
    suggestions: ['避免使用知名 IP 角色（如迪士尼等）', '使用原创描述替代特定品牌或角色']
  },
  MAX_TOKENS: {
    userMessage: '内容长度超出限制',
    suggestions: ['缩短提示词', '减少图片数量或分辨率']
  },
  BLOCKLIST: {
    userMessage: '内容包含被禁止的关键词',
    suggestions: ['请修改提示词中的敏感词汇', '使用更中性的表达方式']
  },
  SPII: {
    userMessage: '检测到敏感个人信息',
    suggestions: ['请勿在提示词中包含真实姓名、地址等个人信息']
  }
}

const DETECTED_TYPE_MESSAGES: Record<string, { title: string; suggestion: string }> = {
  nsfw: { title: '内容违反安全策略', suggestion: 'NSFW 或色情内容不被允许，请确保内容健康' },
  watermark_removal: { title: '功能不支持', suggestion: '去水印功能违反内容政策，请使用专业图片编辑软件' },
  faceswap: { title: '功能不支持', suggestion: '换脸功能涉及隐私和伦理问题，无法处理' },
  copyright: { title: '版权限制', suggestion: '涉及知名 IP 或品牌，请使用原创描述' },
  knowledge_limit: { title: '内容超出支持范围', suggestion: 'AI 知识库截止 2025 年 1 月，请使用已存在的产品或概念' },
  financial_modification: { title: '功能不支持', suggestion: '修改金融/订单信息违反内容政策' },
  celebrity: { title: '内容限制', suggestion: '涉及知名人物的图片生成/修改受到限制' },
  minor: { title: '内容限制', suggestion: '涉及未成年人的图片内容受到严格限制' },
  general_rejection: { title: '请求被拒绝', suggestion: '请根据提示调整请求内容' }
}

// ==================== 核心函数 ====================

/**
 * 7 步判断流程处理 Gemini API 原始 JSON 响应
 */
export function processGeminiResponse(data: any): GeminiResult {
  // Step 1: 检查 candidatesTokenCount
  if (data.usageMetadata?.candidatesTokenCount === 0) {
    return {
      success: false,
      errorType: 'ZERO_CANDIDATES_TOKEN',
      userMessage: '您的请求在内容审核阶段被拒绝，请修改后重试',
      suggestions: [
        '请检查提示词，确保不包含敏感内容',
        '如使用参考图，请确保图片内容健康',
        '避免描述暴力、色情等不适当内容'
      ],
      devMessage: `candidatesTokenCount: 0, promptTokenCount: ${data.usageMetadata?.promptTokenCount ?? '?'}`,
      rawResponse: data
    }
  }

  // Step 2: 检查 candidates 是否存在
  if (!data.candidates || !data.candidates.length) {
    return {
      success: false,
      errorType: 'NO_CANDIDATES',
      userMessage: '系统未返回有效结果，请稍后重试',
      suggestions: ['稍等片刻后重试', '如果问题持续，请尝试更换提示词'],
      devMessage: 'candidates 为 null 或空数组',
      rawResponse: data
    }
  }

  const candidate = data.candidates[0]

  // Step 3: 检查 finishReason
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    const mapped = FINISH_REASON_MAP[candidate.finishReason]
    const finishMessage = candidate.finishMessage as string | undefined
    return {
      success: false,
      errorType: 'FINISH_REASON',
      finishReason: candidate.finishReason,
      userMessage: mapped?.userMessage ?? `请求被拒绝: ${candidate.finishReason}`,
      suggestions: mapped?.suggestions ?? ['请修改提示词后重试'],
      devMessage: `finishReason: ${candidate.finishReason}${finishMessage ? `, msg: ${finishMessage.substring(0, 120)}` : ''}`,
      rawResponse: data
    }
  }

  // Step 4: 检查 content.parts
  if (!candidate.content?.parts || candidate.content.parts.length === 0) {
    return {
      success: false,
      errorType: 'NO_PARTS',
      userMessage: '生成失败，请重试',
      suggestions: ['重新调整提示词后再试'],
      devMessage: 'candidate.content.parts 为空',
      finishReason: candidate.finishReason,
      rawResponse: data
    }
  }

  // Step 5: 提取图片和文本
  const images: string[] = []
  const texts: string[] = []

  for (const part of candidate.content.parts) {
    if (part.text && typeof part.text === 'string' && !part.text.startsWith('data:image/')) {
      texts.push(part.text)
    }
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType || 'image/png'
      images.push(`data:${mime};base64,${part.inlineData.data}`)
    }
  }

  // Step 6: 有图片 → 成功
  if (images.length > 0) {
    return { success: true, images, texts }
  }

  // Step 7: 无图片，检查文本响应
  if (texts.length > 0) {
    const textContent = texts.join('\n')
    const detectedType = detectContentType(textContent)
    const typeInfo = detectedType ? DETECTED_TYPE_MESSAGES[detectedType] : null

    return {
      success: false,
      errorType: 'TEXT_RESPONSE',
      userMessage: typeInfo
        ? `${typeInfo.title}: ${textContent}`
        : textContent,
      suggestions: typeInfo
        ? [typeInfo.suggestion, '请根据提示调整您的请求内容']
        : ['请根据提示调整您的请求', '确保内容符合使用政策'],
      devMessage: `API 返回文本响应 (${textContent.length} chars), detectedType: ${detectedType ?? 'unknown'}`,
      apiText: textContent,
      detectedType,
      rawResponse: data
    }
  }

  // Fallback
  return {
    success: false,
    errorType: 'UNKNOWN',
    userMessage: '生成失败，请检查提示词后重试',
    suggestions: ['请检查提示词后重试', '如问题持续，尝试更换模型'],
    devMessage: '未找到图片数据或文本响应',
    rawResponse: data
  }
}

/**
 * 智能识别文本内容类型
 */
export function detectContentType(text: string): DetectedContentType {
  const lower = text.toLowerCase()

  const isRejection =
    lower.includes("i can't generate") ||
    lower.includes("i cannot generate") ||
    lower.includes("i can't create") ||
    lower.includes("i cannot create") ||
    lower.includes("i'm not able to") ||
    lower.includes("i'm just a language model") ||
    lower.includes('unable to') ||
    lower.includes('我不能') ||
    lower.includes('无法生成') ||
    lower.includes('无法完成') ||
    lower.includes('无法处理') ||
    lower.includes('违反') ||
    lower.includes('不被允许')

  if (!isRejection) return null

  if (lower.includes('watermark') || lower.includes('水印')) {
    return 'watermark_removal'
  }
  if (lower.includes('faceswap') || lower.includes('face swap') || lower.includes('换脸')) {
    return 'faceswap'
  }
  if (
    lower.includes('sexually') ||
    lower.includes('explicit') ||
    lower.includes('nudity') ||
    lower.includes('nsfw') ||
    lower.includes('色情') ||
    lower.includes('不雅') ||
    lower.includes('裸') ||
    lower.includes('性')
  ) {
    return 'nsfw'
  }
  if (
    lower.includes('copyright') ||
    lower.includes('trademark') ||
    lower.includes('disney') ||
    lower.includes('版权') ||
    lower.includes('知名角色') ||
    lower.includes('知名 ip')
  ) {
    return 'copyright'
  }
  if (lower.includes('minor') || lower.includes('child') || lower.includes('未成年')) {
    return 'minor'
  }
  if (
    lower.includes('celebrity') ||
    lower.includes('public figure') ||
    lower.includes('知名人物') ||
    lower.includes('名人')
  ) {
    return 'celebrity'
  }
  if (
    lower.includes('financial') ||
    lower.includes('invoice') ||
    lower.includes('receipt') ||
    lower.includes('金融') ||
    lower.includes('订单') ||
    lower.includes('票据')
  ) {
    return 'financial_modification'
  }
  if (lower.includes('2026') || lower.includes('2027') || lower.includes('未来')) {
    return 'knowledge_limit'
  }

  return 'general_rejection'
}

/**
 * 从 LangChain / SDK 抛出的 exception 中提取 Gemini 错误信息
 */
export function parseGeminiException(error: unknown): GeminiErrorResult {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (lower.includes('safety') || lower.includes('blocked') || lower.includes('prohibited')) {
    return {
      success: false,
      errorType: 'FINISH_REASON',
      finishReason: 'SAFETY',
      userMessage: '内容触发了安全过滤器',
      suggestions: ['请检查提示词和参考图是否包含敏感内容', '尝试使用更温和的描述'],
      devMessage: `Exception: ${msg.substring(0, 200)}`,
      rawResponse: { exceptionMessage: msg }
    }
  }

  if (lower.includes('recitation') || lower.includes('copyright')) {
    return {
      success: false,
      errorType: 'FINISH_REASON',
      finishReason: 'RECITATION',
      userMessage: '内容可能涉及版权问题',
      suggestions: ['避免使用知名 IP 角色', '使用原创描述'],
      devMessage: `Exception: ${msg.substring(0, 200)}`,
      rawResponse: { exceptionMessage: msg }
    }
  }

  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('429')) {
    return {
      success: false,
      errorType: 'UNKNOWN',
      userMessage: '请求过于频繁，请稍后重试',
      suggestions: ['等待几秒后重试', '如持续出现，可能是 API 额度不足'],
      devMessage: `Rate limit: ${msg.substring(0, 200)}`,
      rawResponse: { exceptionMessage: msg }
    }
  }

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
    return {
      success: false,
      errorType: 'UNKNOWN',
      userMessage: 'API Key 无效或已过期',
      suggestions: ['请在设置中检查 API Key 配置', '确认 API Key 未被禁用'],
      devMessage: `Auth error: ${msg.substring(0, 200)}`,
      rawResponse: { exceptionMessage: msg }
    }
  }

  const detectedType = detectContentType(msg)
  if (detectedType) {
    const typeInfo = DETECTED_TYPE_MESSAGES[detectedType]
    return {
      success: false,
      errorType: 'TEXT_RESPONSE',
      userMessage: typeInfo ? typeInfo.title : msg,
      suggestions: typeInfo ? [typeInfo.suggestion] : ['请修改提示词后重试'],
      devMessage: `Exception (detected: ${detectedType}): ${msg.substring(0, 200)}`,
      detectedType,
      apiText: msg,
      rawResponse: { exceptionMessage: msg }
    }
  }

  return {
    success: false,
    errorType: 'UNKNOWN',
    userMessage: msg || '生成失败，请查看详细信息',
    suggestions: ['请检查提示词后重试', '如问题持续，尝试更换模型'],
    devMessage: `Unclassified exception: ${msg.substring(0, 200)}`,
    rawResponse: { exceptionMessage: msg }
  }
}
