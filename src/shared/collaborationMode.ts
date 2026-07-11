export type CollaborationModeKind = 'default' | 'plan'

export const PLAN_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export type ConcretePlanReasoningEffort = (typeof PLAN_EFFORTS)[number]

export type PlanReasoningEffort = 'auto' | ConcretePlanReasoningEffort

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
