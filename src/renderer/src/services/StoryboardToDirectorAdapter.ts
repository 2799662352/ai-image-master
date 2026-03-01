import type { StoryboardResponse } from './LangChainStoryboardService'

export interface DirectorImportData {
  sceneDescription: string
  structuredData?: StoryboardResponse
  referenceImageBase64?: string
  referenceImageMimeType?: string
  templateNegative?: string
}

export function formatStoryboardText(response: StoryboardResponse): string {
  const lines: string[] = []

  lines.push(response.scene.d)
  if (response.scene.cap) lines.push(response.scene.cap)
  lines.push('')

  if (response.scene.env) lines.push(`环境: ${response.scene.env}`)
  if (response.scene.bgm) lines.push(`音乐: ${response.scene.bgm}`)

  if (response.scene.timeline?.length) {
    const tl = response.scene.timeline
      .map(t => `${t.id}(${t.dur},${t.tempo},${t.trans})`)
      .join(' → ')
    lines.push(`时间轴: ${tl}`)
  }
  lines.push('')

  lines.push('角色:')
  for (const obj of response.objs) {
    lines.push(`[${obj.n}] ${obj.f} | 位置: ${obj.s} | 物理: ${obj.p} | 锚点: ${obj.t} | 运动: ${obj.m}`)
    lines.push(`  动机: ${obj.motive}`)
    if (obj.tc) lines.push(`  衔接: ${obj.tc}`)
  }
  lines.push('')

  lines.push('分镜:')
  for (const shot of response.seq) {
    lines.push(`${shot.id}: ${shot.desc}`)
    if (shot.act) lines.push(`  演出: ${shot.act}`)
    if (shot.fx) lines.push(`  特效: ${shot.fx}`)
    if (shot.motive) lines.push(`  动机: ${shot.motive}`)
  }
  lines.push('')

  if (response.cont) lines.push(`连续性: ${response.cont}`)
  if (response.notes) lines.push(`校验: ${response.notes}`)

  return lines.join('\n')
}

export function convertStoryboardToDirector(
  response: StoryboardResponse,
  sourceImageBase64?: string,
  sourceImageMimeType?: string
): DirectorImportData {
  return {
    sceneDescription: formatStoryboardText(response),
    structuredData: response,
    referenceImageBase64: sourceImageBase64,
    referenceImageMimeType: sourceImageMimeType,
    templateNegative: undefined
  }
}
