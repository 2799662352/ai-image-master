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

import { resolveSeedanceGatewayToken } from '../seedanceGateway/credentials'
import type { SeedanceGatewayTokenSources } from '../seedanceGateway/credentials'
import type { VideoBillingSource } from '../../../types/seedance'

export function coerceVideoBillingSource(raw: unknown): VideoBillingSource | undefined {
  return raw === 'platform' || raw === 'own-key' ? raw : undefined
}

/**
 * 「这一次走平台余额还是自填 Key」—— 分派侧的答案。
 *
 * ## 为什么不自己写这两行三元表达式
 *
 * 这条链路上有两个地方要回答同一个问题:**走哪条 transport**(本函数)和
 * **用哪枚 token**(`createSeedanceGatewayTokenResolver`)。各判各的话就会出现
 * 「按平台余额路由、拿自填 Key 提交」这种组合 —— 请求照样成功,钱从错的钱包出,
 * 而两边各自的日志看起来都对。
 *
 * 所以这里直接取 `resolveSeedanceGatewayToken` 的 `billing` 结论,判据只有一份。
 *
 * ## 两条分支的语义
 *
 * - `prefer` 有值 → 原样返回。UI 那条路的意向**不会被兜底吃掉**,哪怕主进程
 *   手上正握着一枚影子 token(那正是 credentials.ts「已知缺口」描述的窗口:
 *   渲染层已切 own-key,而 `clearBillingPool()` 失败被吞掉)。
 * - `prefer` 缺省 → 看主进程手上有没有影子 token。这是给**没有渲染层**的 MCP
 *   `generate_video` 留的,它拿不到用户的意向。
 *
 * 注意 `prefer === 'platform'` 而影子 token 取不到时它**仍然返回 platform**:
 * 让路由落到网关、由 `requireApiKey` 抛一句「请先选择计费池」,而不是悄悄退回
 * vvdance 直连去扣用户自己的火山密钥。
 */
export function createVideoBillingResolver(
  sources: SeedanceGatewayTokenSources,
): (prefer?: VideoBillingSource) => VideoBillingSource {
  return (prefer) => resolveSeedanceGatewayToken(sources, prefer).billing
}
