// 4K 生成的「用户二次确认」状态。
//
// 为什么单独一个 store:4K 比 1080p 贵得多、提交后不能撤销,所以必须由**用户本人**在界面上点两次。
// store 层(`startCards` / `finalizeDrafts`)默认拒绝 4K,只认弹窗走完两步后带上的 `uhdConfirmed: true`;
// agent 的入口永远不带这个标记。本文件只负责「哪些卡在等确认」,弹窗在 pages-react/video-workbench/UhdConfirmDialog。
//
// 这里**不**导出任何会直接放行 4K 的函数 —— 放行只发生在弹窗第二步的点击处理里。

import { create } from 'zustand'
import { UHD_CONFIRM_REQUIRED, type StartResult } from './store'

/** start = 普通 / 直接 4K 生成;finalize = 样片升 4K 成片。 */
export type UhdConfirmKind = 'start' | 'finalize'

export interface UhdConfirmRequest {
  kind: UhdConfirmKind
  cardIds: string[]
}

interface UhdConfirmState {
  request: UhdConfirmRequest | null
  ask: (request: UhdConfirmRequest) => void
  dismiss: () => void
}

export const useUhdConfirmStore = create<UhdConfirmState>((set) => ({
  request: null,
  ask: (request) => set({ request: { kind: request.kind, cardIds: [...new Set(request.cardIds)] } }),
  dismiss: () => set({ request: null }),
}))

/** 这次提交里被 4K 闸拦下、等用户确认的卡。 */
export function uhdHeldIds(result: Pick<StartResult, 'skipped'>): string[] {
  return result.skipped.filter((s) => s.code === UHD_CONFIRM_REQUIRED).map((s) => s.cardId)
}

/**
 * 提交结果里有被 4K 闸拦下的卡 → 打开二次确认弹窗,返回 true;没有就什么都不做。
 * 其余被跳过的原因(提示词为空 / 额度等)不归这里管,调用方照旧提示。
 */
export function askUhdConfirmIfHeld(kind: UhdConfirmKind, result: Pick<StartResult, 'skipped'>): boolean {
  const ids = uhdHeldIds(result)
  if (ids.length === 0) return false
  useUhdConfirmStore.getState().ask({ kind, cardIds: ids })
  return true
}
