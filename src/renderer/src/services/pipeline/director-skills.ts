import type { PipelineSkill } from './types'

export const sharedSkills: PipelineSkill[] = [
  {
    id: 'narrative-coherence',
    rules: `叙事连贯性规则：
- 分镜必须讲述一个连贯的故事，每个面板之间有明确的叙事递进
- 如果用户提供了场景描述，所有面板必须围绕用户描述的剧情展开
- 角色在不同面板中的外观必须保持一致（服装、发型、体型）
- 使用多样化的镜头语言：远景建立场景、中景展示互动、特写表达情感`,
    appliesTo: ['designAndAssemble'],
    priority: 5,
  },
  {
    id: 'prompt-quality',
    rules: `提示词质量规则：
- 每个 prompt 必须是独立完整的英文描述，不依赖其他面板的上下文
- 包含具体的动作描述（action verbs），不要用模糊的"站着""看着"
- 包含光影和氛围描述（lighting, mood, atmosphere）
- 包含镜头信息（camera angle, shot type, composition）
- 角色描述必须使用锚点中的完整外观描述，确保一致性`,
    appliesTo: ['designAndAssemble'],
    priority: 10,
  },
  {
    id: 'user-intent-priority',
    rules: `用户意图优先规则：
- 用户的场景描述（sceneDescription）是最高优先级的创作指令
- 即使 AI 分析出的场景与用户描述不同，也必须以用户描述为准
- 如果用户描述包含动作（如"打架"、"拥抱"、"追逐"），必须在面板中明确体现
- 用户未描述的部分可以自由发挥，但已描述的部分不可忽略`,
    appliesTo: ['designAndAssemble', 'analyzeScene'],
    priority: 1,
  },
]
