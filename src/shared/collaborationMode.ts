import {
  MODEL_REASONING_EFFORTS,
  type ConcreteModelReasoningEffort,
  type ModelReasoningEffort,
} from './modelSettings'

export type CollaborationModeKind = 'default' | 'plan'

export const PLAN_EFFORTS = MODEL_REASONING_EFFORTS

export type ConcretePlanReasoningEffort = ConcreteModelReasoningEffort

export type PlanReasoningEffort = ModelReasoningEffort

const PLAN_EFFORT_SET: ReadonlySet<string> = new Set(PLAN_EFFORTS)

export function isPlanReasoningEffort(value: unknown): value is PlanReasoningEffort {
  return value === 'auto' || (typeof value === 'string' && PLAN_EFFORT_SET.has(value))
}

export function resolvePlanReasoningEffort(
  preference: PlanReasoningEffort,
  presetEffort: unknown,
): ConcretePlanReasoningEffort {
  if (preference !== 'auto') {
    return preference
  }

  return isPlanReasoningEffort(presetEffort) && presetEffort !== 'auto'
    ? presetEffort
    : 'medium'
}

export function normaliseSupportedPlanEfforts(
  values: readonly string[],
): ConcretePlanReasoningEffort[] {
  const supportedEfforts = new Set(values)
  return PLAN_EFFORTS.filter((effort) => supportedEfforts.has(effort))
}
