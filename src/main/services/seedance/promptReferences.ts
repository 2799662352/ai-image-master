const BRACKETED_REFERENCE_RE =
  /【\s*@?(图片|视频|音频|image|video|audio)\s*(\d+)\s*】/gi
const ANGLE_REFERENCE_RE = /<\s*(图片|视频|音频)\s*(\d+)\s*>/g
const AT_REFERENCE_RE = /@(图片|视频|音频|image|video|audio)\s*(\d+)/gi

const CANONICAL_KIND: Record<string, '图片' | '视频' | '音频'> = {
  图片: '图片',
  视频: '视频',
  音频: '音频',
  image: '图片',
  video: '视频',
  audio: '音频',
}

function canonicalReference(kind: string, index: string): string {
  return `${CANONICAL_KIND[kind.toLowerCase()] ?? kind}${index}`
}

/**
 * The in-app Ark/VVDance tool contract addresses uploaded content by the
 * Chinese ordinals `图片1 / 视频1 / 音频1`. Prompt authors commonly paste Fal
 * examples (`@Image1`), Chinese @ aliases, editor markers (`【@图片1】`), or old
 * angle-bracket aliases. Normalize those forms at the tool boundary so the
 * upstream endpoint receives one unambiguous syntax.
 */
export function normalizeSeedancePromptReferences(prompt: string): string {
  return prompt
    .replace(BRACKETED_REFERENCE_RE, (_match, kind: string, index: string) =>
      canonicalReference(kind, index),
    )
    .replace(ANGLE_REFERENCE_RE, (_match, kind: string, index: string) =>
      canonicalReference(kind, index),
    )
    .replace(AT_REFERENCE_RE, (_match, kind: string, index: string) =>
      canonicalReference(kind, index),
    )
}
