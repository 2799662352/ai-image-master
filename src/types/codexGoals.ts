/**
 * Codex native `/goal` — shared DTOs (single source of truth for main, preload
 * and renderer). Mirrors the app-server v2 `thread/goal/*` surface documented in
 * `codex-rs/app-server/README.md`. The `goals` feature ships stable + default-on
 * in the bundled 0.142.2 binary (verified via `experimentalFeature/list`), so no
 * flag is needed — we only add the client-side RPC/UX bridge.
 *
 * A goal is a persisted, per-thread objective the agent works toward across many
 * turns (hours), with token + wall-clock accounting. The system auto-pauses on
 * interrupt and auto-reactivates on thread resume; the model can only mark a goal
 * complete (it cannot pause/resume — those are system-controlled).
 */

/**
 * Goal lifecycle status.
 * - `active`        — running toward the objective.
 * - `blocked`       — waiting on outside intervention.
 * - `budgetLimited` — token budget crossed (set by client or system accounting).
 * - `usageLimited`  — hard usage-limit stopped further work.
 * - `paused`        — system-managed (auto on interrupt). Whether it is a valid
 *                     *settable* value via `thread/goal/set` is probe-verified.
 * - `complete`      — objective reached (model-set via `update_goal`).
 * String-typed on the wire; the union documents the known set without breaking
 * on an unknown future value.
 */
export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budgetLimited'
  | 'usageLimited'
  | 'complete'
  | (string & {})

export interface ThreadGoal {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  /** Optional token cap; `null`/absent means no budget. */
  tokenBudget?: number | null
  tokensUsed: number
  timeUsedSeconds: number
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. */
  updatedAt: number
}

/** `thread/goal/set` — create/replace/update a goal or change its status. */
export interface ThreadGoalSetParams {
  threadId: string
  objective?: string
  tokenBudget?: number
  status?: ThreadGoalStatus
}
export interface ThreadGoalSetResponse {
  goal: ThreadGoal
}

/** `thread/goal/get` — read current goal without changing it. */
export interface ThreadGoalGetParams {
  threadId: string
}
export interface ThreadGoalGetResponse {
  goal: ThreadGoal | null
}

/** `thread/goal/clear` — delete the current goal. */
export interface ThreadGoalClearParams {
  threadId: string
}
export interface ThreadGoalClearResponse {
  cleared: boolean
}

/** Notification: `thread/goal/updated`. */
export interface ThreadGoalUpdatedNotification {
  threadId: string
  goal: ThreadGoal
}

/** Notification: `thread/goal/cleared`. */
export interface ThreadGoalClearedNotification {
  threadId: string
}

/** Standard IPC envelope for goal RPCs crossing the preload boundary. */
export interface GoalRpcResult<T> {
  ok: boolean
  error?: string
  data?: T
}
