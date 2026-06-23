/**
 * eventCoalescer — 把高频流事件在「消费端」按帧合批,降低 React 重渲染频率。
 *
 * 背景 / 根因(见 codex 卡顿排查):主进程 `emitEvent` 对**每个**流事件都
 * `webContents.send('agent:event')`,渲染端 `onEvent(applyEvent)` 每个事件都
 * 触发一次 zustand `set()` → React 重渲染。codex 的 transcript delta 是按
 * 「模型输出速度」到达(openai/codex#15759:不是突发速度),但叠加我方未 memo
 * 的整条对话重渲染 + 每 delta 全量 markdown 重解析,长回复就明显卡顿。
 *
 * 策略(无损、保序):
 *  - 只合批高频的 `item_delta`(默认 `shouldCoalesce`):缓冲到下一帧一次性 apply,
 *    一帧最多一次重渲染(配合 React 18 同 tick 内自动批处理)。
 *  - 其它结构/终止事件(item_started / item_completed / turn_completed / error …)
 *    **立即**处理:先把已缓冲的 delta 按序排空,再处理该事件 —— 顺序绝不打乱,
 *    最终文本(item_completed 权威)永不被延迟。
 *  - Electron IPC 是有序队列且不丢包,所以合批不丢任何 delta。
 *
 * 纯函数式 + 可注入 `schedule/cancel`,便于单测用「手动帧」确定性驱动。
 */
export interface Coalescer<E> {
  /** 入队一个事件(delta 缓冲到帧;其它立即排空+处理)。 */
  push(event: E): void
  /** 立即排空当前缓冲(取消待处理帧)。 */
  flush(): void
  /** 排空残留后停止;dispose 之后的 push 一律忽略。 */
  dispose(): void
}

export interface CoalescerOptions<E> {
  /** 返回 true 的事件才合批;默认只合批 `item_delta`。 */
  shouldCoalesce?: (event: E) => boolean
  /** 安排一次帧回调,返回句柄。默认 requestAnimationFrame,降级 setTimeout(0)。 */
  schedule?: (cb: () => void) => number
  /** 取消帧回调。默认 cancelAnimationFrame,降级 clearTimeout。 */
  cancel?: (handle: number) => void
}

function defaultSchedule(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb)
  return setTimeout(cb, 0) as unknown as number
}

function defaultCancel(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
}

export function createEventCoalescer<E extends { type: string }>(
  apply: (event: E) => void,
  options: CoalescerOptions<E> = {},
): Coalescer<E> {
  const shouldCoalesce = options.shouldCoalesce ?? ((e: E) => e.type === 'item_delta')
  const schedule = options.schedule ?? defaultSchedule
  const cancel = options.cancel ?? defaultCancel

  let queue: E[] = []
  let handle: number | null = null
  let disposed = false

  const cancelPending = (): void => {
    if (handle != null) {
      cancel(handle)
      handle = null
    }
  }

  const drain = (): void => {
    handle = null
    if (queue.length === 0) return
    const batch = queue
    queue = []
    for (const event of batch) apply(event)
  }

  return {
    push(event: E): void {
      if (disposed) return
      queue.push(event)
      // 非合批事件:取消待处理帧,立即排空(含刚入队的它),保序、零延迟。
      if (!shouldCoalesce(event)) {
        cancelPending()
        drain()
        return
      }
      // 合批事件:一整个 burst 只安排一帧。
      if (handle == null) handle = schedule(drain)
    },
    flush(): void {
      cancelPending()
      drain()
    },
    dispose(): void {
      cancelPending()
      drain()
      disposed = true
      queue = []
    },
  }
}
