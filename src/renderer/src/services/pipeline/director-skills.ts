import type { PipelineSkill } from './types'

// Conditional shared skills that require runtime evaluation.
// Static director skills → skills/director-{name}/SKILL.md (loaded via prompt-loader at build time)
export const sharedSkills: PipelineSkill[] = [
  {
    id: 'dodge',
    rules: (context: Record<string, unknown>) => {
      const style = (context.styleInstructions as string) || ''
      if (style.toLowerCase().includes('dark') || style.toLowerCase().includes('noir')) {
        return `暗调风格强化：
- 增强阴影对比度
- 使用低调光照
- 强调轮廓光`
      }
      return ''
    },
    appliesTo: ['designAndAssemble'],
    priority: 10,
    condition: (ctx) => {
      const style = (ctx.styleInstructions as string) || ''
      return style.toLowerCase().includes('dark') || style.toLowerCase().includes('noir')
    },
  },
  {
    id: 'shadow-veil',
    rules: `阴影覆盖效果：
- 为神秘感场景添加阴影覆盖
- 使用渐变阴影增加深度`,
    appliesTo: ['designAndAssemble'],
    priority: 10,
    condition: (ctx) => {
      const style = (ctx.styleInstructions as string) || ''
      return style.toLowerCase().includes('mystery') || style.toLowerCase().includes('horror')
    },
  },
]
