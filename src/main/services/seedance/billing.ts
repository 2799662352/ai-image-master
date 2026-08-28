/**
 * 把「这一次的钱从哪出」从**不可信载荷**里收敛出来。
 *
 * 两个来源都不可信:渲染端经 IPC 递过来的提交载荷,和 IndexedDB 里躺了不知道
 * 多久的工作台卡片(schema 变过、用户手改过、跨版本迁移过)。
 *
 * ## 认不出时为什么一律当「没带」而不是猜一个
 *
 * 两个方向的代价不对称:
 *
 * - 猜成 `own-key`(= 没带)最多退回接入网关之前的老行为 —— vvdance 直连,
 *   缺凭据时报一句「请先填写火山密钥」,是用户自己能解决的错。
 * - 猜成 `platform` 会让一条本该走自填 Key 的任务拿影子 token 提交,钱记到
 *   组织头上。这种错**不报任何错**,而且事后从桌面端根本查不出来。
 *
 * 所以收敛只放行两个精确字面量,大小写变体、空串、非字符串统统当没带。
 */

import type { VideoBillingSource } from '../../../types/seedance'

export function coerceVideoBillingSource(raw: unknown): VideoBillingSource | undefined {
  return raw === 'platform' || raw === 'own-key' ? raw : undefined
}
