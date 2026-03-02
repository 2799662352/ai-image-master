import type { PipelineSkill } from './types'

export const sharedSkills: PipelineSkill[] = [
  {
    id: 'user-intent',
    rules: (context: Record<string, unknown>) => {
      const desc = (context.sceneDescription as string) || ''
      if (!desc) return ''
      return `用户创作意图（最高优先级）:
"${desc}"

你必须确保所有分镜面板围绕用户描述的剧情展开。
用户描述中的动作、情感和关系必须在面板中明确体现。
不可忽略用户描述的任何关键元素。`
    },
    appliesTo: ['analyzeScene', 'designAndAssemble'],
    priority: 0,
  },
]
