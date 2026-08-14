// 重启对账的判定逻辑（从 runtime.ts 的 IPC handler 抽出，便于直接测行为）。
//
// 任务表是纯内存的，应用重启后就空了，但上游任务还在跑。工作台卡片（IndexedDB
// 持久化）启动时把进行中的 taskId 送回来重新接管，结果照旧走 persistVideo +
// 广播的正常回流路径（含写历史）。
//
// 接管前先探一次上游，免得卡片靠 pollLoop 的重试熬满 30 分钟才落 failed。但这一
// 探的失败必须分类：
//   - 上游明确说「没有」（404）或密钥无效（401/403）：再接管也不会有结果，
//     如实报 unknown，渲染端据此落 failed；
//   - 暂时查不到（网络抖动 / 5xx / 限流）：**不能据此放弃任务**。这些任务在上游
//     还在跑、钱已经付了，照旧接管让 pollLoop 带退避继续探。渲染端在相邻的 IPC
//     失败分支里写着「别把还在跑的任务错杀」，这里遵循同一条意图。

import { SeedanceApiError } from './client'
import type { AdoptParams } from './taskManager'
import type { SeedanceModelAlias } from './types'
import { SEEDANCE_MODEL_CAPABILITIES } from './types'
import type {
  VideoWorkbenchReconcileItem,
  VideoWorkbenchReconcileResult,
} from '../../../types/videoWorkbench'

export interface ReconcileDeps {
  /** 主进程是否仍在跟踪该任务（没重启过的情况）。 */
  isTracked: (taskId: string) => boolean
  /**
   * 探测上游任务是否还在；抛错交由本模块分类。
   *
   * 带 `model` 是因为要打对上游 —— 万相的任务在 Ark 那边查不到，会被
   * `meansTaskIsGone` 判成「任务没了」，于是一条还在跑、已经付过钱的任务被
   * 错杀成失败卡片。
   */
  probe: (taskId: string, model: SeedanceModelAlias) => Promise<unknown>
  /** 重新登记并恢复轮询。 */
  adopt: (params: AdoptParams) => void
  /** 上游错误原文转成给用户看的中文。 */
  translateError: (message: string) => string
}

/**
 * 探测失败是否说明「上游确实没有这个任务」。只有不可重试的错误才算数 ——
 * 可重试的失败（5xx / 429 / 网络层）说明我们此刻问不到，不说明任务不存在。
 */
function meansTaskIsGone(error: unknown): boolean {
  return error instanceof SeedanceApiError && !error.retryable
}

/**
 * 从能力表取，不手写。
 *
 * 手写的那份漏了 `2.5` 和 `wan3` —— 重启后这两种任务会被静默归一成 `2.0`，
 * 于是卡片显示错模型、按错单价估费、按错能力表校验，而上游那条任务其实好好的。
 * 每加一个模型就要记得改这里，正是这张表存在的理由。
 */
const MODEL_ALIASES: readonly SeedanceModelAlias[] = Object.keys(
  SEEDANCE_MODEL_CAPABILITIES,
) as SeedanceModelAlias[]

function normalizeAdoptParams(item: VideoWorkbenchReconcileItem): AdoptParams {
  const raw = item as unknown as Record<string, unknown>
  const model = MODEL_ALIASES.includes(raw.model as SeedanceModelAlias)
    ? (raw.model as SeedanceModelAlias)
    : '2.0'
  return {
    taskId: item.taskId,
    source: 'workbench',
    ...(typeof raw.clientId === 'string' && raw.clientId ? { clientId: raw.clientId } : {}),
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    model,
    resolution: typeof raw.resolution === 'string' ? raw.resolution : '720p',
    ratio: typeof raw.ratio === 'string' ? raw.ratio : '16:9',
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : 5,
    ...(Number.isFinite(Number(raw.createdAt)) && raw.createdAt !== undefined
      ? { createdAt: Number(raw.createdAt) }
      : {}),
  }
}

export async function reconcileInFlightTasks(
  items: readonly VideoWorkbenchReconcileItem[],
  deps: ReconcileDeps,
): Promise<VideoWorkbenchReconcileResult[]> {
  const results: VideoWorkbenchReconcileResult[] = []
  for (const item of items) {
    const taskId = String(item?.taskId ?? '')
    if (!taskId) continue
    if (deps.isTracked(taskId)) {
      results.push({ taskId, outcome: 'tracked' })
      continue
    }
    // 先归一化：probe 要按 model 选上游，而 model 的容错就在这个函数里。
    const params = normalizeAdoptParams({ ...item, taskId })
    try {
      await deps.probe(taskId, params.model)
    } catch (e) {
      if (meansTaskIsGone(e)) {
        results.push({
          taskId,
          outcome: 'unknown',
          reason: deps.translateError(e instanceof Error ? e.message : String(e)),
        })
        continue
      }
      // 暂时问不到：继续往下接管，交给 pollLoop 带退避重试。
      console.warn(`[seedance] reconcile probe failed for ${taskId}, adopting anyway:`, e)
    }
    deps.adopt(params)
    results.push({ taskId, outcome: 'adopted' })
  }
  return results
}
