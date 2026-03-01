/**
 * PromptSkill Template
 *
 * Copy and modify to create a custom prompt skill.
 * Pass to StoryboardPipelineService constructor:
 *
 *   import { BUILTIN_SKILLS } from './prompt-skills'
 *   const service = new StoryboardPipelineService(config, [...BUILTIN_SKILLS, mySkill])
 */

import type { PromptSkill, PipelineStateSlice, PassType } from './prompt-skills'

export const myStaticSkill: PromptSkill = {
  id: 'my-static-skill',
  rules: `My Custom Rules:
- Rule 1: description
- Rule 2: description`,
  appliesTo: ['scene', 'shot'] satisfies PassType[],
  priority: 15,
}

export const myDynamicSkill: PromptSkill = {
  id: 'my-dynamic-skill',
  rules: (state: PipelineStateSlice) => {
    if (!state.characters) return ''
    const names = state.characters.map(c => c.n).join(', ')
    return `Character-aware rules for: ${names}`
  },
  appliesTo: ['shot'],
  priority: 25,
}
