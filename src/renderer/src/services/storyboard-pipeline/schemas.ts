import { z } from 'zod'

// ==================== Pass 1: 场景分析 ====================

export const SceneAnalysisSchema = z.object({
  d: z.string().describe('叙事弧线: A(初始状态)→B(触发事件)→C(终态)'),
  cap: z.string().describe('结构化标题: 主体-动作-环境'),
  env: z.string().describe('环境: [mm]f/[stop]|光源+阴影%+对比|主色hex+点缀色hex|风格'),
  bgm: z.string().describe('4层声画对位: pad|env|sfx|melody'),
  timeline: z.array(z.object({
    id: z.string().describe('镜头编号 e.g. S1'),
    t: z.string().describe('时间范围 e.g. 0-3s'),
    dur: z.string().describe('持续时长 e.g. 3s'),
    tempo: z.string().describe('节奏: slow/accelerating/urgent/sudden-stop'),
    trans: z.string().describe('转场: cut/match-cut/whip-pan/smash-cut')
  }))
})

export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>

// ==================== Pass 2: 角色提取 ====================

export const CharacterAnchorSchema = z.object({
  n: z.string().describe('角色/物体名'),
  f: z.string().describe('外观特征→心理动机映射(生理描述,禁用情绪标签)'),
  s: z.string().describe('空间位置: fg/mg/bg|位置(L1/3,R2/3)|Z遮挡序'),
  p: z.string().describe('物理类型: rigid/artic/fluid/cloth + 运动约束'),
  t: z.string().describe('跨镜头一致性锚点(发色/伤疤/服装纹理/道具)'),
  tc: z.string().describe('镜头衔接延续: S?→S?: 姿态/运动向量/视线方向'),
  m: z.string().describe('运动强度: head:pan-R25°|M, torso:lean10°|L, ...')
})

export const CharacterAnchorsSchema = z.object({
  characters: z.array(CharacterAnchorSchema)
})

export type CharacterAnchor = z.infer<typeof CharacterAnchorSchema>

// ==================== Pass 3: 分镜生成 ====================

export const ShotSchema = z.object({
  id: z.string().describe('镜头编号 e.g. S1'),
  desc: z.string().describe('5段式: 景别|动作|台词精华|心理→外化|运镜'),
  act: z.string().describe('演出动作(纯动作,不含特效)'),
  fx: z.nullable(z.string()).describe('特效: 风/烟/光/粒子. Null if none'),
  motive: z.string().describe('动机: 这个动作外化了什么心理')
})

export const ShotSequenceSchema = z.object({
  shots: z.array(ShotSchema)
})

export type ShotData = z.infer<typeof ShotSchema>

// ==================== Pass 4: 一致性校验 ====================

export const ConsistencyIssueSchema = z.object({
  shotId: z.string().describe('有问题的镜头编号'),
  field: z.string().describe('有问题的字段名'),
  problem: z.string().describe('具体问题描述'),
  suggestion: z.string().describe('修正建议')
})

export const ConsistencyReportSchema = z.object({
  cont: z.string().describe('跨镜头连续性锚点: S1-S2:锚点; S2-S3:锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线'),
  score: z.number().min(1).max(10).describe('一致性评分 1-10'),
  issues: z.nullable(z.array(ConsistencyIssueSchema)).describe('发现的不一致问题. Null if none')
})

export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>
