/**
 * 可灵 4.0 / 4.0 Omni 的上游身份 —— 与 `wan3/model.ts` 同一个理由单独成一个极小的模块:
 * `seedance/region.ts` 的 `Record<VideoModelAlias, string>` 要它填那两行(那张表的穷尽性
 * 是护栏),`kling/request.ts` 要它填请求体的 `model`。
 *
 * 上游是腾讯云 VOD AIGC 的可灵,经 Miau 网关(渠道类型 76,new-api #183)。两个 slug
 * 2026-10-28 从生产 `/api/pricing` 实拉确认存在,`quota_type: 1`(按次)、`model_price` 都是
 * 1.2 —— 与网关默认价表「4.0 无参考视频 720P」一行对应。
 */
export const KLING_4_UPSTREAM_MODEL_ID = 'kling-v4-vod'
export const KLING_4_OMNI_UPSTREAM_MODEL_ID = 'kling-v4-omni-vod'

export type KlingAlias = 'kling4' | 'kling4-omni'

/**
 * 别名 → 上游 slug。两档共用整条链路,**唯一的分叉就是这个 slug**(它同时决定了网关放不放
 * 参考图 / 参考视频)。收在一处而不是在组包器里写三元:那种三元被复制到第二个地方,加第三档
 * 时必然漏掉其中一处,后果是「界面选了 Omni、实际发给了 4.0」,网关回一句看不出原因的 400。
 */
export function klingUpstreamModelId(alias: KlingAlias): string {
  return alias === 'kling4-omni' ? KLING_4_OMNI_UPSTREAM_MODEL_ID : KLING_4_UPSTREAM_MODEL_ID
}

export function isKlingAlias(model: string | undefined): model is KlingAlias {
  return model === 'kling4' || model === 'kling4-omni'
}

/**
 * `VideoModelAlias` → 可灵档位,不是可灵就**抛**。
 *
 * transport 那层已经用 `DEFAULT_TRANSPORT_BY_ALIAS` 保证只有可灵会走到这里,但类型上
 * `ctx.model` 仍是完整联合。刻意抛而不是兜底成 `kling4`:兜底的后果是**跑着别人的模型却按
 * 可灵的价扣费**,上游照常 200,没有任何一处会报错;抛出来则是一张带原因的失败卡片。
 */
export function asKlingAlias(model: string | undefined): KlingAlias {
  if (isKlingAlias(model)) return model
  throw new Error(`可灵组包器收到了非可灵模型：${String(model)}`)
}
