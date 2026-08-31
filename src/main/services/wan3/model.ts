/**
 * 万相 3.0 的上游身份 —— 单独一个极小的模块，因为它有两个不相干的消费方。
 *
 * `seedance/region.ts` 的 `Record<VideoModelAlias, string>` 要它来填 wan3 那一行
 * （那张表的穷尽性是我们的护栏，见那边的注释）；本目录的 `request.ts` 要它来填
 * 请求体的 `model` 字段。
 *
 * 放这里而不是留在 `region.ts`：region 是 **vvdance 的站点概念**（海外 / 国内两个
 * Base URL、两套模型 ID 前缀），而万相既不走那两个站点、也不分区域。让它的 id 住在
 * region 表里，下一个读代码的人会以为万相也有区域之分。
 */
export const WAN3_UPSTREAM_MODEL_ID = 'wan3.0-video'

/**
 * 万相 3.0 Prime 的上游 slug。
 *
 * 2026-08-31 从网关 `/v1/models` 实拉确认存在（视频类只有 `wan3.0-video` 与
 * 这一个 `-prime`）；`/api/pricing` 同时给出两者的 `model_price` 为 0.6 / 0.8、
 * `quota_type: 1`（按次），`enable_groups` 都含 `default`。
 */
export const WAN3_PRIME_UPSTREAM_MODEL_ID = 'wan3.0-video-prime'

/**
 * 别名 → 上游 slug。
 *
 * 两个万相档位共用整条链路（同一个组包器、同一个响应解析、同一枚 Key），**唯一的
 * 分叉就是这个 slug**。收在一处而不是在 request.ts 里写 `alias === 'wan3-prime'
 * ? … : …`：那种三元一旦被复制到第二个地方，加第三档时必然漏掉其中一处，而漏掉的
 * 后果是「界面选了 prime、实际扣的是标准档」—— 上游照常 200，没有任何报错。
 */
export type Wan3Alias = 'wan3' | 'wan3-prime'

export function wan3UpstreamModelId(alias: Wan3Alias): string {
  return alias === 'wan3-prime' ? WAN3_PRIME_UPSTREAM_MODEL_ID : WAN3_UPSTREAM_MODEL_ID
}

/**
 * `VideoModelAlias` → 万相档位,不是万相就**抛**。
 *
 * transport 那层已经用 `DEFAULT_TRANSPORT_BY_ALIAS` 保证只有万相会走到这里,但
 * 类型上 `ctx.model` 仍是完整的联合。这里刻意抛而不是 `?? 'wan3'` 兜底:兜底的
 * 后果是**扣着标准档的钱跑着别人的模型**,上游照常 200,没有任何一处会报错;
 * 抛出来则会变成一张带原因的失败卡片。
 */
export function asWan3Alias(model: string | undefined): Wan3Alias {
  if (model === 'wan3' || model === 'wan3-prime') return model
  throw new Error(`万相组包器收到了非万相模型：${String(model)}`)
}
