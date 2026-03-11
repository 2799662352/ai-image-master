import { create } from 'zustand'
import type { PassCardData, PipelineProgress } from '../../../services/pipeline/types'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const STORYBOARD_PASS_DEFS = [
  { label: '导演规划',   icon: 'fa-tasks' },
  { label: '场景分析',   icon: 'fa-eye' },
  { label: '身份锚点',   icon: 'fa-user-tag' },
  { label: '空间/运动',  icon: 'fa-arrows-alt' },
  { label: '动作/叙事',  icon: 'fa-theater-masks' },
  { label: '角色合并',   icon: 'fa-object-group' },
  { label: '分镜生成',   icon: 'fa-film' },
  { label: '快速校验',   icon: 'fa-check-double' },
]

export { STORYBOARD_PASS_DEFS }

interface StoryboardAnalysisState {
  analysisStatus: 'idle' | 'running' | 'completed' | 'failed'
  passStatuses: PassStatus[]
  passCards: PassCardData[]
  progressPercentage: number
  formattedText: string | null
  jsonText: string | null
  storyboardResult: unknown | null

  pushProgress: (progress: PipelineProgress) => void
  resetProgress: () => void
  setResult: (formatted: string, json: string, raw: unknown) => void
  setStatus: (status: StoryboardAnalysisState['analysisStatus']) => void
}

export const useStoryboardStore = create<StoryboardAnalysisState>((set) => ({
  analysisStatus: 'idle',
  passStatuses: STORYBOARD_PASS_DEFS.map(() => 'pending' as PassStatus),
  passCards: [],
  progressPercentage: 0,
  formattedText: null,
  jsonText: null,
  storyboardResult: null,

  pushProgress: (progress) => {
    set((state) => {
      const statuses = [...state.passStatuses]
      const cards = [...state.passCards]

      if (progress.status === 'running') {
        if (statuses[progress.pass] !== 'completed') {
          statuses[progress.pass] = 'running'
        }
      } else {
        statuses[progress.pass] = progress.status === 'retrying' ? 'retrying'
          : progress.status === 'failed' ? 'failed' : 'completed'
      }

      if (progress.passData && progress.status !== 'running') {
        const existingIdx = cards.findIndex(c => c.pass === progress.pass)
        if (existingIdx >= 0) cards[existingIdx] = progress.passData
        else cards.push(progress.passData)
      }

      const completed = statuses.filter(s => s === 'completed').length
      const pct = Math.round((completed / STORYBOARD_PASS_DEFS.length) * 100)

      return { passStatuses: statuses, passCards: cards, progressPercentage: pct }
    })
  },

  resetProgress: () => set({
    analysisStatus: 'idle',
    passStatuses: STORYBOARD_PASS_DEFS.map(() => 'pending'),
    passCards: [],
    progressPercentage: 0,
    formattedText: null,
    jsonText: null,
    storyboardResult: null,
  }),

  setResult: (formatted, json, raw) => set({
    analysisStatus: 'completed',
    formattedText: formatted,
    jsonText: json,
    storyboardResult: raw,
    progressPercentage: 100,
  }),

  setStatus: (status) => set({ analysisStatus: status }),
}))
