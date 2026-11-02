import type { ChoiceAnswer } from '../../../../types/agent-timeline'

/**
 * How long an `ask_user` card waits with NO user interaction before it
 * resolves itself.
 *
 * The tool blocks the agent's turn on a human. A user who walks away would
 * otherwise leave the whole pipeline parked on one card until the 6-hour
 * transport ceiling. Claude Code's `askUserQuestionTimeout` makes the same
 * trade (default off there; 60 s / 5 min / 10 min presets).
 */
export const ASK_USER_AUTO_ADVANCE_MS = 5 * 60 * 1000

/** The countdown switches from minutes to seconds inside this final window. */
export const ASK_USER_COUNTDOWN_WINDOW_MS = 60 * 1000

/**
 * At most one store write per this interval when the user merely moves the
 * mouse / types over the card. The deadline can therefore lag a real touch by
 * up to this long — negligible against a 5-minute window.
 */
export const ASK_USER_TOUCH_THROTTLE_MS = 5 * 1000

/**
 * The answer a timed-out card hands the model.
 *
 * `skipped: true` keeps it compatible with everything that already handles a
 * skip, but `timedOut` + `note` make the difference explicit: the user did not
 * decide to defer — they were not there. Without that the model would read
 * silence as "你来定" consent to e.g. a paid generation.
 */
export function buildTimedOutChoiceAnswer(): ChoiceAnswer {
  return {
    answered: false,
    skipped: true,
    selected: [],
    timedOut: true,
    note:
      '用户 5 分钟内没有回答这个问题(可能不在电脑前),系统已自动跳过。' +
      '请按你自己的最佳判断继续;如果这个决定确实重要、选错代价高(例如会扣费),' +
      '先做不花钱的部分,或在回合结束时说明你做了什么假设,不要擅自做高成本操作。',
  }
}

/** Remaining time → the card's hint text. Rounds UP so it never under-promises. */
export function formatAutoAdvanceHint(remainingMs: number): { text: string; urgent: boolean } {
  const remaining = Math.max(0, remainingMs)
  if (remaining <= ASK_USER_COUNTDOWN_WINDOW_MS) {
    const seconds = Math.ceil(remaining / 1000)
    return {
      text: `${seconds} 秒后自动按「你来定」继续 · 任意操作可重新计时`,
      urgent: true,
    }
  }
  const minutes = Math.ceil(remaining / 60_000)
  return { text: `${minutes} 分钟内无操作将自动按「你来定」继续`, urgent: false }
}
